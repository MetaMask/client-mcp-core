export const ACTIONABLE_ROLES = [
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'textbox',
  'combobox',
  'menuitem',
] as const;

export const STRUCTURAL_ROLES = [
  'menu',
  'listbox',
  'option',
  'tab',
  'tabpanel',
  'list',
  'listitem',
] as const;

export const IMPORTANT_ROLES = [
  'dialog',
  'alert',
  'status',
  'heading',
] as const;

export const INCLUDED_ROLES = [
  ...ACTIONABLE_ROLES,
  ...STRUCTURAL_ROLES,
  ...IMPORTANT_ROLES,
] as const;

export type ActionableRole = (typeof ACTIONABLE_ROLES)[number];
export type StructuralRole = (typeof STRUCTURAL_ROLES)[number];
export type ImportantRole = (typeof IMPORTANT_ROLES)[number];
export type IncludedRole = (typeof INCLUDED_ROLES)[number];

export type TestIdItem = {
  testId: string;
  tag: string;
  text?: string;
  /**
   * Whether the element is expected to be on-screen. On mobile this is
   * derived from the element frame vs the device viewport intersection and
   * does not account for occlusion by other content; elements with unknown
   * geometry are assumed visible.
   */
  visible: boolean;
};

export type A11yNodeTrimmed = {
  ref: string;
  role: string;
  name: string;
  disabled?: boolean;
  checked?: boolean;
  expanded?: boolean;
  path: string[];
  testId?: string;
  textContent?: string;
  ambiguous?: boolean;
  /**
   * Element frame in logical points relative to the device viewport, when the
   * platform reports geometry (mobile only).
   */
  bounds?: { x: number; y: number; width: number; height: number };
};

export type RawA11yNode = {
  role: string;
  name?: string;
  disabled?: boolean;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  backendDOMNodeId?: number;
  ignored?: boolean;
  children?: RawA11yNode[];
};
