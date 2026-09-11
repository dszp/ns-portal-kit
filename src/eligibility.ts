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
// The `*[,!domain…]` rail grammar and the NS domain-name check both live in nsEvents.ts, which is already
// where the prepop cron reads its grammar check from (see `runDirectoryReconcile` in worker.ts). One
// implementation of the rule, not a second copy that drifts.
import { parseDomainRail } from './nsEvents.js';

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
  /** Domains the directory reconcile runs for on its own (event tier, cron, refresh control).
   *  `'*'` = every domain the write rail permits; `null` = unset ⇒ off. Always intersected with
   *  `writeDomains` by `prepopArmed` — this rail can only narrow, never widen, what may be written. */
  prepopAuto: string[] | '*' | null;
  /** Domains carved OUT of a `'*'` prepop rail (`RINGOTEL_PREPOP_AUTO: '*,!lab.example'`). Empty unless
   *  the operator wrote exclusions, and only ever populated alongside `prepopAuto === '*'`. Applied by
   *  `prepopArmed`, which every consumer of this rail already routes through. */
  prepopAutoExcept: string[];
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
  RINGOTEL_UNLISTED_USERS?: string;
  RINGOTEL_RESELLER_OVERRIDE?: string;
  RINGOTEL_WRITE_DOMAINS?: string;
  /** `*` (optionally with `!domain` carve-outs, e.g. `*,!lab.example`), or a CSV of domains. */
  RINGOTEL_PREPOP_AUTO?: string;
}

const csv = (s?: string): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const truthy = (s?: string): boolean => /^(1|true|yes|on)$/i.test((s ?? '').trim());
/**
 * Every soft category, as a RUNTIME list — the library exports the union as a type only, and `all` has to
 * expand to something. Written as a keyed object pinned with `satisfies Record<SoftCategory, true>` rather
 * than a plain array so the exhaustiveness is CHECKED: a category added to the library's union is a
 * compile error here until it is listed, instead of silently narrowing what `all` means for every
 * deployment that already set it.
 */
const SOFT_CATS = Object.keys(
  { names: true, exts: true, no_devices: true, unlisted: true } satisfies Record<SoftCategory, true>,
) as readonly SoftCategory[];

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

  // How a NetSapiens user with *List in Directory* off is graded. Unset means `soft` — the library's own
  // default, restated here so the resolved config always carries an explicit value rather than relying on
  // two codebases agreeing about an omission. Only the two documented words are accepted: `off`/`0` would
  // read as "ignore" to a person and throw away a real exclusion silently, so an unknown value is loud.
  const rawUnlisted = (env.RINGOTEL_UNLISTED_USERS ?? '').trim().toLowerCase();
  if (rawUnlisted && rawUnlisted !== 'soft' && rawUnlisted !== 'ignore') {
    throw new RingotelConfigError(`RINGOTEL_UNLISTED_USERS must be "soft" or "ignore", got: ${env.RINGOTEL_UNLISTED_USERS}`);
  }
  const unlistedUsers: RingotelConfig['unlistedUsers'] = rawUnlisted === 'ignore' ? 'ignore' : 'soft';

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
  //
  // ⚠️ This rail does NOT take the `*,!domain` exclusions the two rails above it do, and the refusal has
  // to be explicit: a `!name` token would otherwise survive into the list as a literal entry that no real
  // domain can ever equal, so every write would be refused while `status.ts`'s "is the rail configured?"
  // check (a non-empty list) reported it satisfied. Silently refusing every write on a rail the console
  // calls healthy is the worst available outcome; it is a config error instead.
  //
  // Exclusions are deliberately not SUPPORTED here rather than merely unimplemented. This rail is the
  // outer bound every other rail is intersected with, and "everything except X" as an outer bound is a
  // fail-OPEN default wearing a deny-list's clothes — a domain added to the fleet tomorrow lands inside
  // it. The narrowing rails are where a carve-out belongs.
  const rawWd = (env.RINGOTEL_WRITE_DOMAINS ?? '').trim();
  if (rawWd !== '*' && csv(rawWd).some((x) => x.trim().startsWith('!'))) {
    throw new RingotelConfigError('RINGOTEL_WRITE_DOMAINS does not support "!domain" exclusions — it is the outer bound every other rail narrows, so list the domains it permits');
  }
  const writeDomains: string[] | '*' = rawWd === '*' ? '*' : csv(env.RINGOTEL_WRITE_DOMAINS).map((x) => x.toLowerCase());

  // Auto-reconcile arming rail: '*' = every write-rail domain (minus any `!domain` carve-outs); a CSV list
  // = only those; unset/blank = off.
  const rawAuto = (env.RINGOTEL_PREPOP_AUTO ?? '').trim();
  let prepopAuto: RingotelConfig['prepopAuto'] = null;
  let prepopAutoExcept: string[] = [];
  if (rawAuto) {
    const rail = parseDomainRail(rawAuto, 'RINGOTEL_PREPOP_AUTO');
    if (!rail.ok) throw new RingotelConfigError(rail.message);
    if (rail.rail.wildcard) {
      prepopAuto = '*';
      prepopAutoExcept = rail.rail.except;
    } else {
      prepopAuto = rail.rail.domains;
    }
  }

  return { suffix, excludeNames, excludeExts, excludeExtsByDomain, excludeNoDevices, unlistedUsers, resellerOverride, writeDomains, prepopAuto, prepopAutoExcept };
}

/**
 * Is the automatic directory reconcile armed for this domain? Both rails must say yes, and a `!domain`
 * carve-out on the prepop rail vetoes regardless.
 *
 * `prepopAutoExcept` is a REQUIRED member of the accepted shape rather than an optional one: every caller
 * passes a resolved `RingotelConfig`, and an optional field would let a hand-built config silently skip
 * the carve-out — the exclusion would look applied while doing nothing.
 */
export function prepopArmed(domain: string, cfg: Pick<RingotelConfig, 'prepopAuto' | 'prepopAutoExcept' | 'writeDomains'>): boolean {
  const d = domain.trim().toLowerCase();
  if (cfg.prepopAuto === null) return false;
  if (cfg.prepopAutoExcept.includes(d)) return false;
  const inAuto = cfg.prepopAuto === '*' || cfg.prepopAuto.includes(d);
  const inRail = cfg.writeDomains === '*' || cfg.writeDomains.map((x) => x.toLowerCase()).includes(d);
  return inAuto && inRail;
}

/** Null when the config is valid; a loud, actionable message otherwise (for the worker's config-time gate). */
export function ringotelConfigError(env: RingotelEnv): string | null {
  try { resolveRingotelConfig(env); return null; }
  catch (e) { if (e instanceof RingotelConfigError) return `Ringotel config misconfigured: ${e.message}`; throw e; }
}
