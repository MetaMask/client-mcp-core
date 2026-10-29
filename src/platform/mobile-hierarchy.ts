import type { UIElement } from '@metamask/device-mcp';

import {
  MOBILE_BUSY_TYPE,
  MOBILE_TAP_TARGET_MIN_SIZE,
} from '../tools/utils/constants.js';

/** Options of `filterAppHierarchy`. */
export type AppHierarchyFilterOptions = {
  /** Device platform of the snapshot. */
  platform: 'ios' | 'android';
  /**
   * Drop the Expo DevLauncher overlay of development builds (the floating
   * "Tools" button). Default true.
   */
  excludeDevOverlay?: boolean;
};

/** Device viewport, in the units of the snapshot frames. */
export type Viewport = { width: number; height: number };

/**
 * Android resource-id with a package: `<package>:id/<name>`. React Native
 * testIDs have no package (`wallet-screen`).
 */
const RESOURCE_ID_PACKAGE = /^([A-Za-z][\w.]*):id\//u;

/** Android package of System UI (status bar, navigation bar, and more). */
const ANDROID_SYSTEM_UI_PACKAGE = 'com.android.systemui';

/**
 * Status bar and navigation bar containers, for a flat hierarchy (no window
 * structure, e.g. Appium) where the bar-window rule cannot apply.
 */
const ANDROID_BAR_IDENTIFIER =
  /^com\.android\.systemui:id\/(?:status_bar|navigation_bar|nav_bar)/u;

/**
 * A bar window is at most this fraction of its length thick (on a 1080 px
 * wide screen: status bar 63 px, navigation bar up to about 130 px, limit
 * 162 px; a biometric prompt is several hundred px high).
 */
const ANDROID_BAR_MAX_THICKNESS = 0.15;

/**
 * iOS: Expo DevLauncher floating button. idb reports an `Image` with
 * identifier `gearshape.fill` (label "Gear Shape, Filled") followed by a
 * `StaticText` "Tools", in a window of their own (`Application` >
 * `UITransitionView` > `UIDropShadowView` > `_UIHostingView` >
 * `SwiftUI.AccessibilityNode`).
 */
const IOS_DEV_OVERLAY_IDENTIFIER = 'gearshape.fill';
const IOS_STATIC_TEXT = 'StaticText';
const DEV_OVERLAY_LABEL = 'Tools';

/**
 * Android: Expo DevLauncher floating button, an `ImageView` labelled "Tools"
 * in a Jetpack Compose view (React Native does not render Compose views).
 */
const ANDROID_COMPOSE_VIEW = 'androidx.compose.ui.platform.ComposeView';
const ANDROID_IMAGE_VIEW = 'android.widget.ImageView';

/**
 * @param identifier - An element identifier.
 * @returns The Android package of a `<package>:id/<name>` resource-id, or
 * undefined when the identifier has no package.
 */
export function resourceIdPackage(identifier: string): string | undefined {
  return RESOURCE_ID_PACKAGE.exec(identifier)?.[1];
}

/**
 * Removes elements that are not part of the app from a device snapshot. Use
 * the result for the accessibility tree, the refs and the test IDs, so they
 * agree:
 *
 * - Android: the status bar and navigation bar windows. A top-level element
 * (a window) is removed when every identifier in it is
 * `com.android.systemui:id/*` and its frame is a bar: the full screen width
 * (or height, for a side navigation bar in landscape) and at most 15% of
 * that length thick. Other System
 * UI windows stay: the biometric prompt, screen capture consent, the
 * notification shade. Flat hierarchy (no top-level element has children):
 * only elements whose identifier starts with
 * `com.android.systemui:id/status_bar`, `navigation_bar` or `nav_bar`.
 * - `excludeDevOverlay` (default true): the Expo DevLauncher "Tools" button
 * of development builds. iOS: the `gearshape.fill` image and the "Tools"
 * text right after it. Android: a "Tools" `ImageView` inside a Compose view.
 *
 * A container that held only removed elements, and has no identifier, label
 * or value, is removed too. The input is not modified.
 *
 * @param hierarchy - The snapshot hierarchy.
 * @param options - Platform and filters.
 * @returns The filtered hierarchy.
 */
export function filterAppHierarchy(
  hierarchy: UIElement[],
  options: AppHierarchyFilterOptions,
): UIElement[] {
  const { platform } = options;
  const excludeDevOverlay = options.excludeDevOverlay ?? true;
  const roots =
    platform === 'android' ? removeAndroidBars(hierarchy) : hierarchy;
  if (!excludeDevOverlay) {
    return roots;
  }

  const isDevOverlay = (
    el: UIElement,
    previous: UIElement | undefined,
    inComposeView: boolean,
  ): boolean => {
    if (platform === 'ios') {
      return (
        el.identifier === IOS_DEV_OVERLAY_IDENTIFIER ||
        (el.type === IOS_STATIC_TEXT &&
          el.label === DEV_OVERLAY_LABEL &&
          previous?.identifier === IOS_DEV_OVERLAY_IDENTIFIER)
      );
    }
    return (
      inComposeView &&
      el.type === ANDROID_IMAGE_VIEW &&
      el.label === DEV_OVERLAY_LABEL
    );
  };

  const walk = (elements: UIElement[], inComposeView: boolean): UIElement[] => {
    const kept: UIElement[] = [];
    elements.forEach((el, index) => {
      if (isDevOverlay(el, elements[index - 1], inComposeView)) {
        return;
      }
      const originalChildren = el.children;
      if (!originalChildren?.length) {
        kept.push(el);
        return;
      }
      const children = walk(
        originalChildren,
        inComposeView || el.type === ANDROID_COMPOSE_VIEW,
      );
      if (children.length === 0 && !el.identifier && !el.label && !el.value) {
        // It held only removed elements.
        return;
      }
      const unchanged =
        children.length === originalChildren.length &&
        children.every((child, at) => child === originalChildren[at]);
      kept.push(unchanged ? el : { ...el, children });
    });
    return kept;
  };

  return walk(roots, false);
}

/**
 * iOS element types (idb `describe-all` AX types, also used by Appium
 * XCUITest) of controls a user can tap or type into. Matched exactly: the
 * nested idb format reports UIKit class names
 * (`UIKit._UITabBarItemPlatterView`, `RNSTabsHostComponentView`) for the
 * views that are not accessibility elements, and a substring match would
 * keep those. Assumes the backend strips the `XCUIElementType` prefix (the
 * device-mcp Appium backend does): `XCUIElementTypeButton` is not matched.
 */
const IOS_ACTIONABLE_TYPES = new Set([
  'Button',
  'Cell',
  'CheckBox',
  'ComboBox',
  'DatePicker',
  'Incrementor',
  'Key',
  'Link',
  'MenuItem',
  'Picker',
  'PickerWheel',
  'PopUpButton',
  'RadioButton',
  'SearchField',
  'SecureTextField',
  'SegmentedControl',
  'Slider',
  'Stepper',
  'Switch',
  'Tab',
  'TextArea',
  'TextField',
  'TextView',
  'Toggle',
]);

/**
 * Android widget classes of controls a user can tap or type into, matched as
 * a suffix of the class name so subclasses match too (`Button` also matches
 * `ImageButton`, `RadioButton`, `ToggleButton`, `MaterialButton`;
 * `EditText` matches `AppCompatEditText`). The device snapshot has no
 * `clickable` attribute, so a tappable `ViewGroup` (React Native
 * `Pressable`) is kept only through its testId or label.
 */
const ANDROID_ACTIONABLE_CLASS =
  /(?:Button|EditText|AutoCompleteTextView|CheckBox|CheckedTextView|Switch|SwitchCompat|SwitchMaterial|SeekBar|Spinner|RatingBar)$/u;

/**
 * Plain React Native view classes: `View` and `Pressable` render as these.
 * An unlabelled one with no children is often a tap target (an icon button
 * whose label is on a sibling, or an image), so it is kept when large enough
 * (see `isUnlabelledTapTarget`).
 */
const RN_VIEW_TYPES: Record<'ios' | 'android', ReadonlySet<string>> = {
  ios: new Set(['RCTViewComponentView']),
  android: new Set(['android.view.ViewGroup']),
};

/**
 * @param el - A snapshot element.
 * @param platform - Device platform of the snapshot.
 * @returns True when the element type is a control a user can tap or type
 * into (see `IOS_ACTIONABLE_TYPES`, `ANDROID_ACTIONABLE_CLASS`).
 */
export function isActionableElement(
  el: UIElement,
  platform: 'ios' | 'android',
): boolean {
  return platform === 'ios'
    ? IOS_ACTIONABLE_TYPES.has(el.type)
    : ANDROID_ACTIONABLE_CLASS.test(el.type);
}

/**
 * @param el - A snapshot element.
 * @param platform - Device platform of the snapshot.
 * @returns True when the element only lays out other elements: it has no
 * name (label or value), no identifier (testId), is not actionable and is
 * not a progress indicator.
 */
export function isLayoutOnly(
  el: UIElement,
  platform: 'ios' | 'android',
): boolean {
  return (
    !el.label &&
    !el.value &&
    !el.identifier &&
    !isActionableElement(el, platform) &&
    !MOBILE_BUSY_TYPE.test(el.type)
  );
}

/**
 * @param el - A layout-only element (see `isLayoutOnly`) whose kept
 * children were checked.
 * @param platform - Device platform of the snapshot.
 * @returns True when the element is a plain React Native view
 * (`RCTViewComponentView`, `android.view.ViewGroup`) at least
 * `MOBILE_TAP_TARGET_MIN_SIZE` wide and high. Call it only for an element
 * with no kept children (a leaf after pruning). Such views are often
 * unlabelled buttons (the wallet home action buttons on iOS), usable with
 * `tap-coordinates`.
 */
export function isUnlabelledTapTarget(
  el: UIElement,
  platform: 'ios' | 'android',
): boolean {
  return (
    RN_VIEW_TYPES[platform].has(el.type) &&
    el.frame.width >= MOBILE_TAP_TARGET_MIN_SIZE &&
    el.frame.height >= MOBILE_TAP_TARGET_MIN_SIZE
  );
}

/**
 * Removes the layout-only elements (see `isLayoutOnly`) from a snapshot
 * hierarchy, for the accessibility tree. A removed element is replaced by
 * its kept descendants, in order, so the pre-order of the kept elements does
 * not change. Containers with a testId, named elements (text included),
 * actionable controls and progress indicators stay. A layout-only element
 * that is left with no kept children also stays when it is an unlabelled tap
 * target (see `isUnlabelledTapTarget`), without its children. The input is
 * not modified; unchanged subtrees are returned by reference.
 *
 * On real MetaMask snapshots (after `filterAppHierarchy`) this keeps 15 of
 * 47 elements on the Android login screen and 67 of 177 on iOS wallet home
 * (idb nested format).
 *
 * @param hierarchy - The snapshot hierarchy (after `filterAppHierarchy`).
 * @param platform - Device platform of the snapshot.
 * @returns The hierarchy without layout-only elements.
 */
export function pruneLayoutOnly(
  hierarchy: UIElement[],
  platform: 'ios' | 'android',
): UIElement[] {
  const kept: UIElement[] = [];
  for (const el of hierarchy) {
    const children = el.children?.length
      ? pruneLayoutOnly(el.children, platform)
      : undefined;
    if (isLayoutOnly(el, platform)) {
      if (children?.length) {
        kept.push(...children);
      } else if (isUnlabelledTapTarget(el, platform)) {
        kept.push(withoutChildren(el));
      }
      continue;
    }
    const unchanged =
      children === undefined ||
      (children.length === el.children?.length &&
        children.every((child, at) => child === el.children?.[at]));
    if (unchanged) {
      kept.push(el);
    } else if (children.length) {
      kept.push({ ...el, children });
    } else {
      kept.push(withoutChildren(el));
    }
  }
  return kept;
}

/**
 * @param el - A snapshot element.
 * @returns The element itself when it has no `children` key, else a copy
 * without it.
 */
function withoutChildren(el: UIElement): UIElement {
  if (!('children' in el)) {
    return el;
  }
  const { children: _children, ...leaf } = el;
  return leaf;
}

/**
 * Android: removes the status bar and navigation bar (see
 * `filterAppHierarchy`).
 *
 * @param hierarchy - The snapshot hierarchy.
 * @returns The hierarchy without the bars.
 */
function removeAndroidBars(hierarchy: UIElement[]): UIElement[] {
  const flat = hierarchy.every((el) => !el.children?.length);
  if (flat) {
    return hierarchy.filter(
      (el) => !el.identifier || !ANDROID_BAR_IDENTIFIER.test(el.identifier),
    );
  }
  const screen = viewportFromHierarchy(hierarchy, 'android');
  if (!screen) {
    return hierarchy;
  }
  return hierarchy.filter(
    (el) => !(isBarFrame(el.frame, screen) && isSystemUiOnly(el)),
  );
}

/**
 * @param frame - A window frame.
 * @param screen - The screen size.
 * @returns True when the frame spans the full screen width and is at most
 * `ANDROID_BAR_MAX_THICKNESS` of that width high (status bar, navigation
 * bar), or spans the full screen height and is at most that fraction of it
 * wide (side navigation bar in landscape). The thickness is measured against
 * the bar's own length, so a snapshot that holds only the status bar (its
 * extent is the bar) still finds it.
 */
function isBarFrame(frame: UIElement['frame'], screen: Viewport): boolean {
  if (frame.width <= 0 || frame.height <= 0) {
    return false;
  }
  const horizontal =
    frame.width >= screen.width &&
    frame.height <= frame.width * ANDROID_BAR_MAX_THICKNESS;
  const vertical =
    frame.height >= screen.height &&
    frame.width <= frame.height * ANDROID_BAR_MAX_THICKNESS;
  return horizontal || vertical;
}

/**
 * @param root - A top-level element.
 * @returns True when the element tree has at least one identifier and every
 * identifier is a `com.android.systemui` resource-id.
 */
function isSystemUiOnly(root: UIElement): boolean {
  let found = false;
  const allSystemUi = (el: UIElement): boolean => {
    if (el.identifier) {
      if (resourceIdPackage(el.identifier) !== ANDROID_SYSTEM_UI_PACKAGE) {
        return false;
      }
      found = true;
    }
    return (el.children ?? []).every(allSystemUi);
  };
  return allSystemUi(root) && found;
}

/**
 * Reads the device viewport from a snapshot, with no device call, in the
 * units of its frames (iOS points, Android pixels).
 *
 * - iOS (`idb describe-all`): the frame of the first element, the app, when
 * it is at the origin (later top-level elements of a flat list can be scroll
 * content).
 * - Android: the top-level elements are windows (status bar, app, dialogs).
 * The extent of their frames, `max(x + width)` by `max(y + height)`, when
 * the leftmost and topmost of them are at 0. A snapshot that holds only a
 * dialog window does not show the screen origin, so it gives no viewport.
 *
 * Pass the unfiltered hierarchy.
 *
 * @param hierarchy - The snapshot hierarchy.
 * @param platform - Device platform of the snapshot.
 * @returns The viewport, or undefined when the top-level frames do not give
 * one.
 */
export function viewportFromHierarchy(
  hierarchy: UIElement[],
  platform: 'ios' | 'android',
): Viewport | undefined {
  const frames = (platform === 'ios' ? hierarchy.slice(0, 1) : hierarchy)
    .map((el) => el.frame)
    .filter((frame) => frame.width > 0 && frame.height > 0);
  if (frames.length === 0) {
    return undefined;
  }
  const minX = Math.min(...frames.map((frame) => frame.x));
  const minY = Math.min(...frames.map((frame) => frame.y));
  if (minX !== 0 || minY !== 0) {
    return undefined;
  }
  return {
    width: Math.max(...frames.map((frame) => frame.x + frame.width)),
    height: Math.max(...frames.map((frame) => frame.y + frame.height)),
  };
}
