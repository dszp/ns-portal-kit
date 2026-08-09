/**
 * Deployment mode — the ONE parse of `PORTAL_MODE`.
 *
 * It lives in its own module rather than in `setup.ts` (its original home, which re-exports it) because
 * `access.ts` has to know the mode too, and `setup.ts` already imports `access.ts`. Anything mode-aware
 * that sits BELOW setup in the import graph reads it from here.
 *
 * No other module may re-derive this. `PORTAL_MODE` decides which of two mutually exclusive security
 * models is in force, and a second reading of it that disagreed with this one would mean two halves of
 * the Worker enforcing different models at once.
 */

export interface ModeEnv {
  PORTAL_MODE?: string;
}

export const truthy = (v?: string): boolean => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());

/** Portal backend mode: delegated-only + policy-gated. Off ⇒ the standalone dual-mode Worker (dia/local). */
export function portalMode(env: ModeEnv): boolean {
  return truthy(env.PORTAL_MODE);
}
