import Foundation
import ApplicationServices
import Cocoa

struct AXNode: Codable {
    struct Frame: Codable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    let role: String?
    let subrole: String?
    let label: String?
    let value: String?
    let identifier: String?
    let frame: Frame?
    let children: [AXNode]
}

struct AXSnapshotError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

let simulatorBundleId = "com.apple.iphonesimulator"
let defaultMaxDepth = 40
// Simulator.app window title format is "<DeviceName> – iOS <version>".
// The separator is an EN DASH (U+2013), not an ASCII hyphen.
let deviceNameWindowSeparator = " \u{2013} "

func hasAccessibilityPermission() -> Bool {
    AXIsProcessTrusted()
}

func parseUdidArgument(_ args: [String]) -> String? {
    var index = 1
    while index < args.count {
        let arg = args[index]
        if arg == "--udid" {
            let valueIndex = index + 1
            if valueIndex < args.count {
                return args[valueIndex]
            }
            return nil
        }
        if arg.hasPrefix("--udid=") {
            return String(arg.dropFirst("--udid=".count))
        }
        index += 1
    }
    return nil
}

func resolveDeviceName(udid: String) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    process.arguments = ["simctl", "list", "devices", "--json"]
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    do {
        try process.run()
    } catch {
        throw AXSnapshotError(
            message: "MM_IOS_AX_DEVICE_NOT_FOUND: failed to spawn xcrun simctl: \(error)"
        )
    }
    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrText = String(data: stderrData, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        throw AXSnapshotError(
            message: "MM_IOS_AX_DEVICE_NOT_FOUND: xcrun simctl exited with status \(process.terminationStatus): \(stderrText)"
        )
    }

    let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
    let parsed: Any
    do {
        parsed = try JSONSerialization.jsonObject(with: data)
    } catch {
        throw AXSnapshotError(
            message: "MM_IOS_AX_DEVICE_NOT_FOUND: could not parse simctl JSON: \(error)"
        )
    }

    guard let root = parsed as? [String: Any],
          let devicesByRuntime = root["devices"] as? [String: Any] else {
        throw AXSnapshotError(
            message: "MM_IOS_AX_DEVICE_NOT_FOUND: unexpected simctl JSON shape"
        )
    }

    let target = udid.uppercased()
    for (_, value) in devicesByRuntime {
        guard let runtimeDevices = value as? [[String: Any]] else { continue }
        for device in runtimeDevices {
            guard let deviceUdid = device["udid"] as? String else { continue }
            if deviceUdid.uppercased() == target {
                guard let name = device["name"] as? String, !name.isEmpty else {
                    throw AXSnapshotError(
                        message: "MM_IOS_AX_DEVICE_NOT_FOUND: device \(udid) has no name in simctl output"
                    )
                }
                return name
            }
        }
    }
    throw AXSnapshotError(
        message: "MM_IOS_AX_DEVICE_NOT_FOUND: UDID \(udid) is not present in `xcrun simctl list devices`"
    )
}

func findSimulatorApp(udid: String?) throws -> NSRunningApplication {
    let candidates = NSWorkspace.shared.runningApplications.filter {
        $0.bundleIdentifier == simulatorBundleId
    }
    if candidates.isEmpty {
        throw AXSnapshotError(message: "iOS Simulator is not running.")
    }

    guard let udid = udid else {
        // Backward-compat single-simulator path. Only safe when exactly one
        // Simulator.app process is running; multi-sim without a UDID is
        // ambiguous and must fail closed.
        if candidates.count == 1 {
            return candidates[0]
        }
        throw AXSnapshotError(
            message: "MM_IOS_AX_DEVICE_NOT_FOUND: \(candidates.count) iOS Simulator processes are running. Pass --udid <UDID> to disambiguate."
        )
    }

    let deviceName = try resolveDeviceName(udid: udid)
    let titlePrefix = "\(deviceName)\(deviceNameWindowSeparator)"

    var observedTitles: [String] = []
    for app in candidates {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var windowsRef: AnyObject?
        let status = AXUIElementCopyAttributeValue(
            axApp,
            kAXWindowsAttribute as CFString,
            &windowsRef
        )
        guard status == .success, let windows = windowsRef as? [AXUIElement] else {
            continue
        }
        for window in windows {
            var titleRef: AnyObject?
            AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleRef)
            guard let title = titleRef as? String, !title.isEmpty else {
                continue
            }
            if title.hasPrefix(titlePrefix) {
                return app
            }
            observedTitles.append(title)
        }
    }

    let observed = observedTitles.isEmpty
        ? "<no Simulator windows found>"
        : observedTitles.joined(separator: ", ")
    throw AXSnapshotError(
        message: "MM_IOS_AX_DEVICE_NOT_FOUND: no Simulator window matched UDID \(udid) (expected prefix: \"\(titlePrefix)\"; observed: \(observed))"
    )
}

func axElement(for app: NSRunningApplication) -> AXUIElement {
    AXUIElementCreateApplication(app.processIdentifier)
}

func getAttribute<T>(_ element: AXUIElement, _ attribute: CFString) -> T? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute, &value)
    guard result == .success else { return nil }
    return value as? T
}

func getChildren(_ element: AXUIElement) -> [AXUIElement] {
    if let children: [AXUIElement] = getAttribute(element, kAXChildrenAttribute as CFString),
       !children.isEmpty {
        return children
    }
    if let children: [AXUIElement] = getAttribute(element, kAXVisibleChildrenAttribute as CFString),
       !children.isEmpty {
        return children
    }
    if let children: [AXUIElement] = getAttribute(element, kAXContentsAttribute as CFString),
       !children.isEmpty {
        return children
    }
    return []
}

func getLabel(_ element: AXUIElement) -> String? {
    if let label: String = getAttribute(element, "AXLabel" as CFString) {
        return label
    }
    if let desc: String = getAttribute(element, kAXDescriptionAttribute as CFString) {
        return desc
    }
    return nil
}

func getDescription(_ element: AXUIElement) -> String? {
    getAttribute(element, kAXDescriptionAttribute as CFString)
}

func getValue(_ element: AXUIElement) -> String? {
    if let value: String = getAttribute(element, kAXValueAttribute as CFString) {
        return value
    }
    if let number: NSNumber = getAttribute(element, kAXValueAttribute as CFString) {
        return number.stringValue
    }
    return nil
}

func getIdentifier(_ element: AXUIElement) -> String? {
    getAttribute(element, kAXIdentifierAttribute as CFString)
}

func getFrame(_ element: AXUIElement) -> AXNode.Frame? {
    var positionRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef)
    AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef)
    guard let posValue = positionRef, let sizeValue = sizeRef else {
        return nil
    }
    if CFGetTypeID(posValue) != AXValueGetTypeID() || CFGetTypeID(sizeValue) != AXValueGetTypeID() {
        return nil
    }
    let posAx = posValue as! AXValue
    let sizeAx = sizeValue as! AXValue
    var point = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(posAx, .cgPoint, &point)
    AXValueGetValue(sizeAx, .cgSize, &size)
    return AXNode.Frame(
        x: Double(point.x),
        y: Double(point.y),
        width: Double(size.width),
        height: Double(size.height)
    )
}

func buildTree(_ element: AXUIElement, depth: Int = 0, maxDepth: Int = defaultMaxDepth) -> AXNode {
    let children = depth < maxDepth
        ? getChildren(element).map { buildTree($0, depth: depth + 1, maxDepth: maxDepth) }
        : []
    return AXNode(
        role: getAttribute(element, kAXRoleAttribute as CFString),
        subrole: getAttribute(element, kAXSubroleAttribute as CFString),
        label: getLabel(element),
        value: getValue(element),
        identifier: getIdentifier(element),
        frame: getFrame(element),
        children: children
    )
}

func findIOSAppSnapshot(in simulator: NSRunningApplication) -> (AXUIElement, AXNode.Frame?, AXUIElement, [AXUIElement], [AXUIElement])? {
    let appElement = axElement(for: simulator)
    let windows = getChildren(appElement).filter {
        (getAttribute($0, kAXRoleAttribute as CFString) as String?) == (kAXWindowRole as String)
    }
    if windows.isEmpty { return nil }

    if let focused: AXUIElement = getAttribute(appElement, kAXFocusedWindowAttribute as CFString),
       let root = chooseRoot(in: focused) {
        let extras = dedupeElements(findToolbarExtras(in: focused, root: root) + findTabBarExtras(in: focused, root: root))
        let modalRoots = findAdditionalWindowRoots(windows: windows, excluding: focused, windowFrame: getFrame(focused))
        return (root, getFrame(focused), focused, extras, modalRoots)
    }

    let sorted = windows.sorted { lhs, rhs in
        let l = getFrame(lhs)
        let r = getFrame(rhs)
        let la = (l?.width ?? 0) * (l?.height ?? 0)
        let ra = (r?.width ?? 0) * (r?.height ?? 0)
        return la > ra
    }
    for window in sorted {
        if let root = chooseRoot(in: window) {
            let extras = dedupeElements(findToolbarExtras(in: window, root: root) + findTabBarExtras(in: window, root: root))
            let modalRoots = findAdditionalWindowRoots(windows: windows, excluding: window, windowFrame: getFrame(window))
            return (root, getFrame(window), window, extras, modalRoots)
        }
    }
    return nil
}

private func findAdditionalWindowRoots(
    windows: [AXUIElement],
    excluding mainWindow: AXUIElement,
    windowFrame: AXNode.Frame?
) -> [AXUIElement] {
    var roots: [AXUIElement] = []
    for window in windows {
        if CFEqual(window, mainWindow) { continue }
        let frame = getFrame(window)
        if let windowFrame = windowFrame, !frameIntersects(frame, windowFrame) {
            continue
        }
        if let root = chooseRoot(in: window) {
            roots.append(root)
        }
    }
    return dedupeElements(roots)
}

private func dedupeElements(_ elements: [AXUIElement]) -> [AXUIElement] {
    var seen: Set<AXWrapper> = []
    var result: [AXUIElement] = []
    for element in elements {
        let wrapper = AXWrapper(element)
        if seen.contains(wrapper) { continue }
        seen.insert(wrapper)
        result.append(element)
    }
    return result
}

func chooseRoot(in window: AXUIElement) -> AXUIElement? {
    let windowFrame = getFrame(window)
    let candidates = findGroupCandidates(in: window, windowFrame: windowFrame)
    if let best = candidates.first?.element { return best }
    return findLargestChildCandidate(in: window, windowFrame: windowFrame)
}

private func findLargestChildCandidate(in window: AXUIElement, windowFrame: AXNode.Frame?) -> AXUIElement? {
    var best: (element: AXUIElement, area: Double)? = nil
    for child in getChildren(window) {
        let children = getChildren(child)
        if children.isEmpty { continue }
        let area = frameArea(getFrame(child), windowFrame: windowFrame)
        if area <= 0 { continue }
        if best == nil || area > best!.area {
            best = (child, area)
        }
    }
    return best?.element
}

private func frameIntersects(_ frame: AXNode.Frame?, _ target: AXNode.Frame?) -> Bool {
    guard let frame = frame, let target = target else { return false }
    let fx1 = frame.x
    let fy1 = frame.y
    let fx2 = frame.x + frame.width
    let fy2 = frame.y + frame.height
    let tx1 = target.x
    let ty1 = target.y
    let tx2 = target.x + target.width
    let ty2 = target.y + target.height
    return fx1 < tx2 && fx2 > tx1 && fy1 < ty2 && fy2 > ty1
}

private func isToolbarLike(_ element: AXUIElement) -> Bool {
    let role = (getAttribute(element, kAXRoleAttribute as CFString) as String?) ?? ""
    let subrole = (getAttribute(element, kAXSubroleAttribute as CFString) as String?) ?? ""
    if role == (kAXToolbarRole as String) ||
        role == (kAXTabGroupRole as String) ||
        role == "AXTabBar" {
        return true
    }
    if subrole == "AXTabBar" {
        return true
    }
    return false
}

private func isTabBarLike(_ element: AXUIElement) -> Bool {
    let role = (getAttribute(element, kAXRoleAttribute as CFString) as String?) ?? ""
    let subrole = (getAttribute(element, kAXSubroleAttribute as CFString) as String?) ?? ""
    if role == (kAXTabGroupRole as String) || role == "AXTabBar" { return true }
    if subrole == "AXTabBar" { return true }
    let desc = (getDescription(element) ?? "").lowercased()
    if desc.contains("tab bar") { return true }
    let label = (getLabel(element) ?? "").lowercased()
    if label.contains("tab bar") { return true }
    return false
}

private func findToolbarExtras(in window: AXUIElement, root: AXUIElement) -> [AXUIElement] {
    let rootFrame = getFrame(root)
    let rootIds = collectDescendantWrappers(from: root)
    var extras: [AXUIElement] = []
    var stack = getChildren(window)
    while !stack.isEmpty {
        let current = stack.removeLast()
        if isToolbarLike(current) && !rootIds.contains(AXWrapper(current)) {
            let frame = getFrame(current)
            if frameIntersects(frame, rootFrame) {
                extras.append(current)
            }
        }
        stack.append(contentsOf: getChildren(current))
    }
    return extras
}

private func findTabBarExtras(in window: AXUIElement, root: AXUIElement) -> [AXUIElement] {
    let rootFrame = getFrame(root)
    let rootIds = collectDescendantWrappers(from: root)
    var extras: [AXUIElement] = []
    var stack = getChildren(window)
    while !stack.isEmpty {
        let current = stack.removeLast()
        if isTabBarLike(current) && !rootIds.contains(AXWrapper(current)) {
            let frame = getFrame(current)
            if frameIntersects(frame, rootFrame) {
                extras.append(current)
            }
        }
        stack.append(contentsOf: getChildren(current))
    }
    return extras
}

private struct GroupCandidate {
    let element: AXUIElement
    let area: Double
    let childCount: Int
}

private func findGroupCandidates(in root: AXUIElement, windowFrame: AXNode.Frame?) -> [GroupCandidate] {
    var candidates: [GroupCandidate] = []
    var visited: Set<AXWrapper> = []
    func walk(_ element: AXUIElement) {
        let wrapper = AXWrapper(element)
        if visited.contains(wrapper) { return }
        visited.insert(wrapper)
        let children = getChildren(element)
        let role = (getAttribute(element, kAXRoleAttribute as CFString) as String?) ?? ""
        let isContainer = role == (kAXGroupRole as String) ||
            role == (kAXScrollAreaRole as String) ||
            role == (kAXUnknownRole as String)
        if isContainer {
            let hasNonToolbarChild = children.contains {
                ((getAttribute($0, kAXRoleAttribute as CFString) as String?) ?? "") != (kAXToolbarRole as String)
            }
            if hasNonToolbarChild {
                let frame = getFrame(element)
                let area = frameArea(frame, windowFrame: windowFrame)
                if area > 0 {
                    let childCount = children.count
                    candidates.append(
                        GroupCandidate(
                            element: element,
                            area: area,
                            childCount: childCount
                        )
                    )
                }
            }
        }
        for child in children {
            walk(child)
        }
    }
    walk(root)
    candidates.sort { lhs, rhs in
        if lhs.area == rhs.area { return lhs.childCount > rhs.childCount }
        return lhs.area > rhs.area
    }
    return candidates
}

private func frameArea(_ frame: AXNode.Frame?, windowFrame: AXNode.Frame?) -> Double {
    guard let frame = frame else { return 0 }
    if let windowFrame = windowFrame {
        let windowArea = max(1.0, windowFrame.width * windowFrame.height)
        let area = frame.width * frame.height
        if area > windowArea { return 0 }
        return area
    }
    return frame.width * frame.height
}

private final class AXWrapper: Hashable {
    let element: AXUIElement
    init(_ element: AXUIElement) { self.element = element }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
    static func == (lhs: AXWrapper, rhs: AXWrapper) -> Bool {
        return CFEqual(lhs.element, rhs.element)
    }
}

private func collectDescendantWrappers(from root: AXUIElement) -> Set<AXWrapper> {
    var seen: Set<AXWrapper> = []
    var stack = [root]
    while !stack.isEmpty {
        let current = stack.removeLast()
        let wrapper = AXWrapper(current)
        if seen.contains(wrapper) { continue }
        seen.insert(wrapper)
        stack.append(contentsOf: getChildren(current))
    }
    return seen
}


private struct SnapshotPayload: Codable {
    let windowFrame: AXNode.Frame?
    let root: AXNode
}

func main() throws {
    guard hasAccessibilityPermission() else {
        throw AXSnapshotError(message: "Accessibility permission not granted. Enable it in System Settings > Privacy & Security > Accessibility.")
    }
    let udid = parseUdidArgument(CommandLine.arguments)
    let simulator = try findSimulatorApp(udid: udid)
    let maxAttempts = 5
    var snapshot: (AXUIElement, AXNode.Frame?, AXUIElement, [AXUIElement], [AXUIElement])? = nil
    for attempt in 0..<maxAttempts {
        if let candidate = findIOSAppSnapshot(in: simulator) {
            let (root, _, _, _, modalRoots) = candidate
            if !getChildren(root).isEmpty || !modalRoots.isEmpty {
                snapshot = candidate
                break
            }
        }
        if attempt < maxAttempts - 1 {
            usleep(300_000)
        }
    }
    guard let (root, windowFrame, _, extras, modalRoots) = snapshot else {
        throw AXSnapshotError(message: "Could not find iOS app content in Simulator.")
    }
    var tree = buildTree(root)
    if !extras.isEmpty {
        let extraNodes = extras.map { buildTree($0) }
        tree = AXNode(
            role: tree.role,
            subrole: tree.subrole,
            label: tree.label,
            value: tree.value,
            identifier: tree.identifier,
            frame: tree.frame,
            children: tree.children + extraNodes
        )
    }
    if !modalRoots.isEmpty {
        let modalNodes = modalRoots.map { buildTree($0) }
        tree = AXNode(
            role: tree.role,
            subrole: tree.subrole,
            label: tree.label,
            value: tree.value,
            identifier: tree.identifier,
            frame: tree.frame,
            children: tree.children + modalNodes
        )
    }
    let payload = SnapshotPayload(windowFrame: windowFrame, root: tree)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(payload)
    if let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        throw AXSnapshotError(message: "Failed to encode AX snapshot JSON.")
    }
}

do {
    try main()
} catch {
    fputs("axsnapshot error: \(error)\n", stderr)
    exit(1)
}
