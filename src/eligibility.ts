/**
 * Ringotel activation eligibility — pure, deployment-neutral. Decides whether a NetSapiens user may be
 * ACTIVATED for Ringotel (the status indicator shows regardless of this). Two tiers plus a precondition:
 *   HARD  — system/service users + structurally-invalid extensions. Never activatable, not even a reseller.
 *   SOFT  — name matchers, no-device heuristic, custom ext/name lists. Default-excluded but reseller-
 *           overridable per configured category.
 *   email — a precondition: activation emails credentials, so it can't proceed without an address.
 * Precedence: HARD → SOFT → precondition → ok. See the feature-gating plan for the full model.
 */

/** Which soft-exclusion categories a reseller may override. */
export type SoftCategory = 'names' | 'exts' | 'no_devices';

/** Fully-resolved config (produced by resolveRingotelConfig; consumed here and by the worker). */
export interface RingotelConfig {
  /** NS device-name suffix, e.g. 'r' → device '100r'. */
  suffix: string;
  /** Lowercased name-contains matchers (checked against first/last/display). */
  excludeNames: string[];
  /** Global extension exclusions. */
  excludeExts: string[];
  /** Per-domain override of the extension list (add/remove relative to global). */
  excludeExtsByDomain: Record<string, { add?: string[]; remove?: string[] }>;
  /** No-device heuristic (contributes; never decides alone). */
  excludeNoDevices: boolean;
  /** Soft categories a reseller is permitted to override. */
  resellerOverride: Set<SoftCategory>;
  /** Write safety rail: domains where writes may mutate ('*' = all scope-permitted; [] = none). */
  writeDomains: string[] | '*';
}

/** Normalized user facts the engine needs (the worker adapts a raw NS user into this). */
export interface EligUser {
  /** NS extension (the 'user' field). */
  ext: string;
  /** NS 'srv_code' — non-blank marks a system/service user. */
  srvCode?: string;
  /** NS email — required to activate. */
  email?: string;
  /** Name parts (first/last/display) for the soft name matchers. */
  names?: string[];
  /** Number of NS devices on the user (for the no-device heuristic). */
  deviceCount?: number;
}

/** Caller context relevant to override decisions. */
export interface EligContext {
  /** Target NS domain (per-domain overrides). */
  domain: string;
  /** Principal is reseller-scope (or superadmin) ⇒ may override permitted soft categories. */
  isReseller: boolean;
  /** Reseller RUNTIME force (an explicit per-request override): bypass ALL soft categories — never HARD
   *  and never the email precondition. Only honored for a reseller. */
  force?: boolean;
}

export type EligTier = 'ok' | 'hard' | 'soft' | 'precondition';
export interface EligResult {
  activatable: boolean;
  tier: EligTier;
  reasons: string[];
}

const blank = (s?: string): boolean => !s || s.trim() === '';

/** Effective excluded-extension patterns for a domain: global ⊕ per-domain add, minus per-domain remove. */
function excludedExtsFor(config: RingotelConfig, domain: string): string[] {
  const dom = config.excludeExtsByDomain[domain] ?? {};
  const set = new Set(config.excludeExts);
  for (const a of dom.add ?? []) set.add(a);
  for (const r of dom.remove ?? []) set.delete(r);
  return [...set];
}

/** Match an extension against patterns: exact, or a trailing-`*` prefix (e.g. `8*` → 8xx). */
function extMatch(ext: string, patterns: string[]): string | undefined {
  return patterns.find((p) => (p.endsWith('*') ? ext.startsWith(p.slice(0, -1)) : ext === p));
}

/** Decide activation eligibility. Precedence: HARD → SOFT (names, exts) → precondition → ok. */
export function evaluateEligibility(user: EligUser, ctx: EligContext, config: RingotelConfig): EligResult {
  // HARD — structural/system. Never activatable, not even by a reseller override.
  if (!blank(user.srvCode)) {
    return { activatable: false, tier: 'hard', reasons: [`system/service user (srv_code="${user.srvCode!.trim()}")`] };
  }
  if (!/^\d{3,4}$/.test(user.ext)) {
    return { activatable: false, tier: 'hard', reasons: [`extension "${user.ext}" is not a 3-4 digit user extension`] };
  }

  // SOFT — default-excluded. A reseller may override a category either via config (resellerOverride) or
  // via an explicit per-request `force` (bypasses ALL soft; still never HARD/precondition, checked around it).
  const canOverride = (cat: SoftCategory): boolean => ctx.isReseller && (config.resellerOverride.has(cat) || !!ctx.force);

  // Name heuristic. The no-device flag TIGHTENS it (never decides alone): when on, a name match only
  // excludes a user that ALSO has zero devices — a SHARED-named box carrying BLF/voicemail devices is a
  // real endpoint we keep. A 0-device user with a normal name is never excluded by this alone.
  const names = (user.names ?? []).map((n) => (n || '').toLowerCase());
  const nameMatch = config.excludeNames.find((m) => names.some((n) => n.includes(m)));
  const nameHit = nameMatch && (!config.excludeNoDevices || (user.deviceCount ?? 0) === 0);
  if (nameHit && !canOverride('names')) {
    return { activatable: false, tier: 'soft', reasons: [`name matches excluded pattern "${nameMatch}"`] };
  }

  // Extension exclusions (global ⊕ per-domain).
  const extHit = extMatch(user.ext, excludedExtsFor(config, ctx.domain));
  if (extHit && !canOverride('exts')) {
    return { activatable: false, tier: 'soft', reasons: [`extension "${user.ext}" matches excluded pattern "${extHit}"`] };
  }

  // Precondition — activation emails credentials, so an address is required.
  if (blank(user.email)) {
    return { activatable: false, tier: 'precondition', reasons: ['an email address is required to activate'] };
  }

  return { activatable: true, tier: 'ok', reasons: [] };
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
