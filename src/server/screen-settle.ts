import type { A11yNodeTrimmed } from '../tools/types/discovery.js';

/**
 * React Native adds ", busy" to the accessibility label of an element with
 * `accessibilityState={{ busy: true }}`. Seen on Android as the login
 * button `"Unlock, busy"` while the wallet unlocks.
 */
const BUSY_LABEL = /,\s*busy$/iu;

/**
 * Roles of progress indicators, matched as a suffix of the node role (the
 * mobile driver uses the backend element type as the role, see
 * `normalizeSnapshot`):
 *
 * - Android (adb/Appium `class`): `android.widget.ProgressBar` and
 * subclasses whose class name ends in `ProgressBar`.
 * - iOS via Appium XCUITest: `XCUIElementTypeActivityIndicator` and
 * `XCUIElementTypeProgressIndicator`, reported without the
 * `XCUIElementType` prefix (`ActivityIndicator`, `ProgressIndicator`).
 * - iOS via idb `describe-all`: the element `type`, either the AX role
 * without `AX` (`ProgressIndicator`) or the UIKit class name
 * (`UIActivityIndicatorView`, used by React Native `ActivityIndicator`).
 */
const BUSY_ROLE =
  /(?:ProgressBar|ActivityIndicator(?:View)?|ProgressIndicator)$/u;

/**
 * Builds a ref-independent signature of a screen, used to tell whether the
 * screen changed.
 *
 * @param nodes - The accessibility nodes.
 * @returns The signature.
 */
export function screenSignature(nodes: A11yNodeTrimmed[]): string {
  return JSON.stringify(nodes.map(({ ref: _ref, ...rest }) => rest));
}

/**
 * Checks whether a node shows that work is in progress: its label ends in
 * ", busy" (React Native busy state), or it is a progress indicator (see
 * `BUSY_ROLE`).
 *
 * @param node - The accessibility node.
 * @returns True when the node is busy.
 */
export function isBusyNode(node: A11yNodeTrimmed): boolean {
  return BUSY_LABEL.test(node.name) || BUSY_ROLE.test(node.role);
}

/**
 * @param nodes - The accessibility nodes of a screen.
 * @returns True when any node is busy (see `isBusyNode`).
 */
export function isScreenBusy(nodes: A11yNodeTrimmed[]): boolean {
  return nodes.some(isBusyNode);
}
