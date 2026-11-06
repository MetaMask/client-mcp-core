// No zod import here: the CLI reads these levels on every call, and loading
// zod costs about 25 ms. `schemas.ts` builds the zod enum from this list.

/** Observation levels accepted by `--observe` and the `observe` tool field. */
export const OBSERVE_LEVELS = ['none', 'diff', 'full'] as const;

/** Observation to return after a call. */
export type ObserveLevel = (typeof OBSERVE_LEVELS)[number];
