// No zod import here: the CLI validates launch flags before it discovers the
// daemon, and loading zod costs about 25 ms. `schemas.ts` builds the zod
// enums from these lists.

/** Environment contexts accepted by `--context` and `launch.context`. */
export const LAUNCH_CONTEXTS = ['e2e', 'prod'] as const;

/** Environment context for a launch. */
export type LaunchContext = (typeof LAUNCH_CONTEXTS)[number];

/** Wallet state modes accepted by `--state` and `launch.stateMode`. */
export const LAUNCH_STATE_MODES = ['default', 'onboarding', 'custom'] as const;

/** Wallet state mode for a launch. */
export type LaunchStateMode = (typeof LAUNCH_STATE_MODES)[number];

/** Platforms accepted by `--platform` and `launch.platform`. */
export const LAUNCH_PLATFORMS = ['browser', 'ios', 'android'] as const;

/** Target platform for a launch. */
export type LaunchPlatform = (typeof LAUNCH_PLATFORMS)[number];
