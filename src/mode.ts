/**
 * Truthiness for env-var flags.
 *
 * This module used to own `portalMode()` too — the runtime flag that selected between the portal
 * backend and the standalone viewer. The viewer moved to its own repo on 2026-08-09, so there is no
 * mode to select any more and the flag is gone rather than kept as an accepted no-op: a setting that
 * parses and does nothing is the shape the split existed to remove.
 *
 * `truthy` stays because it is the shared parser for every other boolean setting. One parser, so a
 * setting that means "on" cannot mean it differently in two places.
 */
export const truthy = (v?: string): boolean =>
  ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
