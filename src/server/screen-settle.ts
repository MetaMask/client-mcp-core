import type { A11yNodeTrimmed } from '../tools/types/discovery.js';
import { MOBILE_BUSY_TYPE } from '../tools/utils/constants.js';

/**
 * React Native adds ", busy" to the accessibility label of an element with
 * `accessibilityState={{ busy: true }}`. Seen on Android as the login
 * button `"Unlock, busy"` while the wallet unlocks.
 */
const BUSY_LABEL = /,\s*busy$/iu;

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
 * `MOBILE_BUSY_TYPE`).
 *
 * @param node - The accessibility node.
 * @returns True when the node is busy.
 */
export function isBusyNode(node: A11yNodeTrimmed): boolean {
  return BUSY_LABEL.test(node.name) || MOBILE_BUSY_TYPE.test(node.role);
}

/**
 * @param nodes - The accessibility nodes of a screen.
 * @returns True when any node is busy (see `isBusyNode`).
 */
export function isScreenBusy(nodes: A11yNodeTrimmed[]): boolean {
  return nodes.some(isBusyNode);
}

/**
 * A screen that lost more than this share of its accessibility nodes compared
 * with the last screen has probably started to tear down (navigation in
 * progress), not shrunk for real.
 */
const TRANSITION_SHRINK_RATIO = 0.7;

/**
 * Small screens are ignored: a 30% drop on a 24-node screen is noise (a
 * hidden row), not a teardown. The screen has to lose at least this many
 * nodes.
 */
const TRANSITION_MIN_NODE_DROP = 10;

/**
 * Share of the new tree's test IDs that must already exist in the last screen.
 * A torn-down screen keeps its test IDs; a screen that opened over the last
 * one (a modal, a drawer, a menu) brings new ones.
 */
const TRANSITION_MIN_TESTID_OVERLAP = 0.5;

/**
 * @param nodes - The accessibility nodes of a screen.
 * @returns The test IDs of the nodes that have one.
 */
function testIdsOf(nodes: A11yNodeTrimmed[]): string[] {
  return nodes.flatMap((node) => (node.testId ? [node.testId] : []));
}

/**
 * Checks whether a snapshot looks like a screen in transition: the app
 * replaced the last screen but the accessibility tree still carries most of
 * its test IDs while dropping a large part of its nodes.
 *
 * A navigating tap on Android can be observed this way (P1-32: home 242
 * nodes → 64 nodes with `wallet-screen` still present, Explore complete
 * ~440 ms later). Such a tree is not the new screen and not the screen the
 * agent had: the settle retries it.
 *
 * @param previous - The last screen the agent received.
 * @param next - The new snapshot.
 * @returns True when the snapshot is probably a screen tearing down.
 */
export function isScreenInTransition(
  previous: A11yNodeTrimmed[],
  next: A11yNodeTrimmed[],
): boolean {
  const dropped = previous.length - next.length;
  if (
    dropped < TRANSITION_MIN_NODE_DROP ||
    next.length > previous.length * TRANSITION_SHRINK_RATIO
  ) {
    return false;
  }
  const previousIds = new Set(testIdsOf(previous));
  const nextIds = testIdsOf(next);
  if (nextIds.length === 0) {
    // No test IDs to compare: the tree lost most of its nodes, which only
    // happens while a screen is being replaced.
    return true;
  }
  const shared = nextIds.filter((testId) => previousIds.has(testId)).length;
  return shared / nextIds.length >= TRANSITION_MIN_TESTID_OVERLAP;
}
