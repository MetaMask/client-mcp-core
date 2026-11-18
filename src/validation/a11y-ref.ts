/**
 * An accessibility ref from a snapshot: `e3` for an element of the page,
 * `f1e3` for an element inside the first iframe. Kept free of zod so the
 * CLI can use it without loading the schemas.
 */
export const A11Y_REF_PATTERN = /^(?:f[0-9]+)?e[0-9]+$/u;
