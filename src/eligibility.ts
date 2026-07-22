/**
 * Ringotel activation config — the deployment's `RINGOTEL_*` env, resolved into the shape the SHARED
 * eligibility engine consumes.
 *
 * **The decision itself is not here.** `evaluateEligibility` lives in `@dszp/netsapiens-lib` so this
 * Worker and the SSO worker (`ringotel-ns-sso`) run ONE implementation and cannot drift — that
 * divergence is exactly what this module used to be. Import the engine from the library; import the
 * config from here. Env parsing stays per-consumer by the library's charter (it ships no defaults that
 * would bind it to one deployment), which is why the seeded name matchers below live in this repo.
 */

import type { EligibilityConfig, SoftCategory } from '@dszp/netsapiens-lib';

export type { SoftCategory };

/**
 * Fully-resolved config (produced by resolveRingotelConfig). It IS the library's `EligibilityConfig`,
 * plus the two Ringotel-deployment fields the engine has no business knowing: the NS device-name suffix
 * and the write safety rail.
 */
export interface RingotelConfig extends EligibilityConfig {
  /** NS device-name suffix, e.g. 'r' → device '100r'. */
  suffix: string;
  /** Write safety rail: domains where writes may mutate ('*' = all scope-permitted; [] = none). */
  writeDomains: string[] | '*';
}

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution — the single seam a future admin panel replaces. Parses the RINGOTEL_* env into a
// resolved RingotelConfig, fail-closed (throws RingotelConfigError → a loud 500 upstream). Generic
// defaults; deployment-specific overrides (domains/resellers) arrive as env/secrets, never committed vars.
// ─────────────────────────────────────────────────────────────────────────────

/** Loud, distinct error for a bad Ringotel config value (⇒ a 500 upstream). */
export class RingotelConfigError extends Error {}

/** The subset of env this module reads. */
export interface RingotelEnv {
  RINGOTEL_ACTIVATION_SUFFIX?: string;
  RINGOTEL_EXCLUDE_NAMES?: string;
  RINGOTEL_EXCLUDE_EXTS?: string;
  RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN?: string;
  RINGOTEL_EXCLUDE_NO_DEVICES?: string;
  RINGOTEL_RESELLER_OVERRIDE?: string;
  RINGOTEL_WRITE_DOMAINS?: string;
}

const csv = (s?: string): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const truthy = (s?: string): boolean => /^(1|true|yes|on)$/i.test((s ?? '').trim());
const SOFT_CATS: readonly SoftCategory[] = ['names', 'exts', 'no_devices'];

/** Resolve RINGOTEL_* env into a validated config. Throws RingotelConfigError on any bad value. */
export function resolveRingotelConfig(env: RingotelEnv): RingotelConfig {
  // NS device suffix — default 'r'; explicit-but-blank is a loud error.
  let suffix = 'r';
  if (env.RINGOTEL_ACTIVATION_SUFFIX !== undefined) {
    suffix = env.RINGOTEL_ACTIVATION_SUFFIX.trim();
    if (!suffix) throw new RingotelConfigError('RINGOTEL_ACTIVATION_SUFFIX must not be blank');
  }

  // Name matchers — seeded (lowercased) unless explicitly set.
  // Seeded soft-exclusion name matchers. SUBSTRING, case-insensitive — so 'GENERAL' already covers
  // bare 'VOICEMAIL' subsumes both 'SHARED VOICEMAIL' and 'GENERAL VOICEMAIL' — the longer forms are
  // kept to show that more specific matchers can be listed. Bare 'GENERAL' and bare 'CONF' are
  // deliberately NOT used: they would also match real staffed extensions ('General Manager') and
  // surnames. 'CONFERENCE' is spelled out deliberately — bare 'CONF' would also match
  // surnames — with 'CONF RM'/'CONF ROOM' added for the abbreviated forms it therefore misses.
  // Soft means
  // reseller-overridable and creation-only: an existing user is never blocked from signing in.
  const rawNames = env.RINGOTEL_EXCLUDE_NAMES !== undefined ? csv(env.RINGOTEL_EXCLUDE_NAMES) : ['SHARED', 'SHARED VOICEMAIL', 'VOICEMAIL', 'FAX', 'GENERAL VOICEMAIL', 'GENERAL MAILBOX', 'CONFERENCE', 'CONF RM', 'CONF ROOM', 'ROUTING'];
  const excludeNames = rawNames.map((n) => n.toLowerCase());

  const excludeExts = csv(env.RINGOTEL_EXCLUDE_EXTS);

  // Per-domain exts override (JSON object of { add?, remove? } keyed by domain).
  let excludeExtsByDomain: RingotelConfig['excludeExtsByDomain'] = {};
  const rawPd = (env.RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN ?? '').trim();
  if (rawPd) {
    let parsed: unknown;
    try { parsed = JSON.parse(rawPd); } catch { throw new RingotelConfigError('RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN is not valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new RingotelConfigError('RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN must be a JSON object');
    }
    excludeExtsByDomain = parsed as RingotelConfig['excludeExtsByDomain'];
  }

  const excludeNoDevices = truthy(env.RINGOTEL_EXCLUDE_NO_DEVICES);

  // Reseller-overridable soft categories; `all` expands to every category.
  const resellerOverride = new Set<SoftCategory>();
  for (const c of csv(env.RINGOTEL_RESELLER_OVERRIDE)) {
    const v = c.toLowerCase();
    if (v === 'all') { SOFT_CATS.forEach((x) => resellerOverride.add(x)); continue; }
    if (!(SOFT_CATS as readonly string[]).includes(v)) {
      throw new RingotelConfigError(`RINGOTEL_RESELLER_OVERRIDE has an unknown category: ${c}`);
    }
    resellerOverride.add(v as SoftCategory);
  }

  // Write safety rail: '*' = all scope-permitted; a CSV list = only those; empty = writes refused.
  const rawWd = (env.RINGOTEL_WRITE_DOMAINS ?? '').trim();
  const writeDomains: string[] | '*' = rawWd === '*' ? '*' : csv(env.RINGOTEL_WRITE_DOMAINS).map((x) => x.toLowerCase());

  return { suffix, excludeNames, excludeExts, excludeExtsByDomain, excludeNoDevices, resellerOverride, writeDomains };
}

/** Null when the config is valid; a loud, actionable message otherwise (for the worker's config-time gate). */
export function ringotelConfigError(env: RingotelEnv): string | null {
  try { resolveRingotelConfig(env); return null; }
  catch (e) { if (e instanceof RingotelConfigError) return `Ringotel config misconfigured: ${e.message}`; throw e; }
}
