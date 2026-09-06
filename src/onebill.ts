/**
 * OneBill integration — config, clients, and the NS↔OneBill link report.
 * Spec: docs/superpowers/specs/2026-09-02-onebill-links-page-design.md
 */
import {
  OneBillReadClient,
  OneBillWriteClient,
  attributesToLinks,
  gatherUsageRows,
  parseExternalId,
  SUBSCRIBER_STATUSES,
  reconcileUsageSubscriptions,
  proposeMappings,
  bySeverity,
  targetKey,
  type CachedToken,
  type TokenCache,
  type GroupLinkSpec,
  type LinkMapping,
  type GatherResult, type UsageReconciliation, type UsageReconcileRow,
  type Link,
  type Subscriber,
  type Subscription,
  type UsageReadSource,
  type RecurringRule,
} from '@dszp/onebill-lib';
import { type DeviceSuffixLegend } from '@dszp/netsapiens-lib';
import { scopeOf, type RingotelEnv } from './ringotel.js';

// The Ringotel fields are here because the ACCOUNT REPORT reads them: an enabled Ringotel integration
// contributes its device suffix and its label to the legend the inventory is counted with (see
// `inventoryOpts` in onebillAccount.ts). Picked rather than extended so this stays the smallest set of
// Ringotel knowledge the OneBill side actually needs.
export interface OnebillEnv extends Pick<RingotelEnv, 'CACHE_SCOPE' | 'RINGOTEL_API_KEY' | 'RINGOTEL_ACTIVATION_SUFFIX' | 'RINGOTEL_LABEL' | 'RINGOTEL_LABEL_SHORT'> {
  /** Tenant identifier from Config > Settings > Business Profile. Doubles as the OAuth client id. A var, not a secret. */
  ONEBILL_TENANT_ID?: string;
  ONEBILL_CLIENT_SECRET?: string;
  ONEBILL_USERNAME?: string;
  ONEBILL_PASSWORD?: string;
  /** Non-default API base (https only). */
  ONEBILL_BASE_URL?: string;
  /** The OneBill web UI base for this tenant (https only; custom domains exist). Trailing slash stripped. */
  /** JSON GroupLinkSpec. Default: {"group":"PBX","ns":"NS","valueField":"Domain","qualifierField":"Site"} */
  ONEBILL_LINK_GROUP?: string;
  /** CSV of subscription offer names whose identifier carries the NS domain, e.g. "Domain Usage". */
  ONEBILL_USAGE_OFFERS?: string;
  /** CSV of case-insensitive substrings marking a retired subscription identifier. Default "_OLD". */
  ONEBILL_USAGE_IGNORE?: string;
  /**
   * JSON array of `RecurringRule` — which OneBill offer counts toward which NetSapiens inventory
   * dimension. Absent means every recurring offer lands in `unmapped` and the account panel still
   * renders the inventory, so the feature degrades to a fact sheet rather than disappearing.
   *
   * A rule matches a subscription line by ONE of three keys, in this precedence when several rules
   * could claim the same line: **`planCode`**, then **`offer`** (the plan name, which is all a
   * subscription line itself carries), then **`productCode`** — "any plan under this product I have
   * not named". The two code keys resolve through the product catalogue, so a rulebook using them
   * makes the panel read it; a name-keyed rulebook never does.
   *
   * - **`counts`** — one dotted inventory path, or an array of them. Observed is their sum, and where
   *   the paths have item lists the row's items are their UNION, deduplicated by key (so `observed`
   *   is the union size, not the sum, on a row whose lists overlap). Optional only on an `ignore` rule.
   * - **`ignore: true`** — a known offer deliberately not compared. It stays out of `unmapped`, lands
   *   in `ignored`, and creates no row. Give it a `why`: the offer name alone never says whether it is
   *   unbilled, counted elsewhere, or not a line at all.
   * - **`why`** — a free-text note, ≤ 120 characters, for whoever reads the rulebook next. The engine
   *   ignores it. This setting is a JSON string inside a JSONC file, so a `//` comment cannot reach
   *   inside it and the note has to be a field.
   * - **`group`** — rules sharing a group name are summed into one row. Defaults to whichever key the
   *   rule carries. A rule with NO key at all is a keyless comparison row: a group whose billed comes
   *   entirely from other rules' `alsoCounts` credits.
   * - **`perUnit`** — quantity multiplier, 10 for a pack of ten. Defaults to 1.
   * - **`alsoCounts`** — `{ dotted path or group name: per-unit contribution }`. Each unit of this
   *   line also PAYS FOR n of that, so it raises the target's billed count and fewer live than billed
   *   is a shortfall. A credit lands in every group whose `counts` include that path, or whose name
   *   equals the key; a key naming neither gets a comparison-only row of its own.
   * - **`entitles`** — the same key vocabulary and the same scaling, but each unit ENTITLES the
   *   customer to n of that at no charge. It raises `entitled`, which is headroom above `billed`
   *   rather than a second thing to pay for: not using an entitlement is never a finding.
   *
   * ```json
   * [
   *   { "offer": "Seat Tier One", "counts": "extensions.total", "group": "seats" },
   *   { "planCode": "SEAT-CC", "counts": "extensions.total", "group": "seats", "alsoCounts": { "callcenter": 1 } },
   *   { "productCode": "DID", "counts": ["dids.local", "dids.tollFree"], "group": "numbers", "perUnit": 10 },
   *   { "group": "callcenter", "counts": "extensions.byScope.Call Center Agent" },
   *   { "offer": "Legacy Add-on", "ignore": true, "why": "retired 2025; no inventory answers to it" }
   * ]
   * ```
   */
  ONEBILL_RECURRING_RULES?: string;
  /**
   * CSV of fax server hosts — an IP or a hostname, as it appears in a number's dial rule. A phone number
   * handed to one of these is a FAX LINE: it leaves `dids.total`/`local`/`tollFree` and lands in
   * `dids.fax`, so a rulebook can bill it as the fax line it is instead of as a DID.
   *
   * Unset means no number is a fax line. That is netsapiens-lib's rule, not a fallback: the host belongs
   * to a deployment, and a library that guessed one would be wrong on every other operator's system.
   * Analog vs digital is not knowable from NetSapiens at all — no fax endpoint, and the ATA is not a
   * device on the user — so the two Native Fax offers both count `dids.fax` and the billed-as tag on an
   * acceptance is what records which one an operator sold.
   */
  NS_FAX_SERVER_HOSTS?: string;
  /**
   * JSON object naming what a device-name SUFFIX means on this deployment —
   * `{"<suffix>": {"label": "<what it is>", "teams": true?}}`. A device's suffix is what its name carries
   * after the extension number (`1001wp` on ext `1001` → `wp`).
   *
   * Unset means netsapiens-lib's default legend, the three suffixes NetSapiens itself ships: `wp`
   * SNAPmobile Web, `m` SNAPmobile, `t` Teams. Set, it REPLACES that default wholesale rather than
   * merging with it — which is the only way a deployment without TeamMate can say so, by omitting `t` and
   * turning Teams detection off. Whatever the value, the Ringotel activation suffix is added on top when
   * that integration is enabled; see `inventoryOpts` in onebillAccount.ts.
   */
  NS_DEVICE_SUFFIXES?: string;
}

export const ONEBILL_SECRET_NAMES = ['ONEBILL_CLIENT_SECRET', 'ONEBILL_USERNAME', 'ONEBILL_PASSWORD'] as const;
export const ONEBILL_SETTING_NAMES = ['ONEBILL_TENANT_ID', ...ONEBILL_SECRET_NAMES, 'ONEBILL_BASE_URL', 'ONEBILL_LINK_GROUP', 'ONEBILL_USAGE_OFFERS', 'ONEBILL_USAGE_IGNORE', 'ONEBILL_RECURRING_RULES'] as const;

const DEFAULT_GROUP: GroupLinkSpec = { group: 'PBX', ns: 'NS', valueField: 'Domain', qualifierField: 'Site' };
// The library's own namespace rule (onebill-lib src/link.ts NS_PATTERN, not exported) — kept identical so a
// bad ONEBILL_LINK_GROUP fails at config time with the setting named, not on the first write.
const NS_RE = /^[A-Z][A-Z0-9]{0,7}$/;

const has = (v: string | undefined): boolean => !!(v && v.trim());

/** All four credentials present ⇒ the integration is on. Same rule as RINGOTEL_API_KEY. */
export function onebillEnabled(env: OnebillEnv): boolean {
  return has(env.ONEBILL_TENANT_ID) && has(env.ONEBILL_CLIENT_SECRET) && has(env.ONEBILL_USERNAME) && has(env.ONEBILL_PASSWORD);
}

export interface OnebillConfig {
  mapping: LinkMapping;
  ns: string;
  offerNames: string[];
  /**
   * Substrings that mark a subscription identifier as RETIRED, matched case-insensitively anywhere in
   * the identifier. Never empty: an empty marker is a substring of every string, so it would silence
   * the whole usage section — which is why a blank setting reads as unset rather than as "ignore
   * nothing". See {@link DEFAULT_USAGE_IGNORE}.
   */
  usageIgnore: string[];
  baseUrl?: string;
  /** Parsed ONEBILL_RECURRING_RULES. Empty when unset. */
  recurringRules: KitRecurringRule[];
}

/**
 * The default retirement marker. OneBill has no "archived" flag on a subscription identifier, so the
 * convention operators actually use is to rename the old one — and a renamed leftover reconciles as a
 * second active match, which reads as `ambiguous` on an account that is perfectly healthy.
 */
const DEFAULT_USAGE_IGNORE = ['_OLD'];

function parseGroup(raw: string | undefined): GroupLinkSpec {
  if (!has(raw)) return DEFAULT_GROUP;
  let v: unknown;
  try { v = JSON.parse(raw!); } catch { throw new Error('ONEBILL_LINK_GROUP is not valid JSON.'); }
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  for (const k of ['group', 'ns', 'valueField'] as const) {
    if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw new Error(`ONEBILL_LINK_GROUP needs a non-empty "${k}".`);
  }
  if (!NS_RE.test(o.ns as string)) throw new Error('ONEBILL_LINK_GROUP "ns" must match [A-Z][A-Z0-9]{0,7}.');
  if (o.qualifierField !== undefined && (typeof o.qualifierField !== 'string' || !o.qualifierField.trim())) throw new Error('ONEBILL_LINK_GROUP "qualifierField" must be a non-empty string when present.');
  return { group: o.group as string, ns: o.ns as string, valueField: o.valueField as string, ...(o.qualifierField ? { qualifierField: o.qualifierField as string } : {}) };
}

/**
 * A rulebook rule, plus the one field this Worker adds: `why`.
 *
 * `RecurringRule` is onebill-lib's, and `why` is not in it — deliberately, because the engine has no use
 * for it. It is a NOTE for whoever reads the rulebook next, and an `ignore: true` rule badly needs one:
 * "MFAX" tells a reader nothing about whether it is unbilled, counted elsewhere, or hardware. The
 * setting is a JSON string inside a JSONC file, so a `//` comment cannot reach inside it; the note has
 * to be a field. The engine reads only the fields it names, so an extra one passes through untouched.
 */
export type KitRecurringRule = RecurringRule & {
  /** Free text, ≤ 120 characters. Read by people, ignored by the comparison. */
  why?: string;
};
/** {@link KitRecurringRule.why} — long enough for a reason, short enough to stay a note. */
const WHY_MAX = 120;

/**
 * A `counts` path: dot-separated segments into an opaque inventory tree. The first segment is a plain
 * identifier (so a typo'd space at the START still reads as a typo, not a path); segments after a dot
 * may hold anything but a dot, including a trailing empty one (`extensions.byServiceCode.`, for a
 * dynamic key filled in elsewhere) and spaces in a human label (`extensions.byScope.Call Center
 * Agent`) — a service catalogue names things with spaces and this path has to be able to say so.
 */
const COUNTS_RE = /^[A-Za-z][A-Za-z0-9]*(\.[^.]*)*$/;

/** A `group`/`alsoCounts` label: short, human, and never confusable with a dotted path. */
const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9 _.()&/+-]{0,63}$/;

function parseRecurringRules(raw: string | undefined): KitRecurringRule[] {
  if (!has(raw)) return [];
  let v: unknown;
  try { v = JSON.parse(raw!); } catch { throw new Error('ONEBILL_RECURRING_RULES is not valid JSON.'); }
  if (!Array.isArray(v)) throw new Error('ONEBILL_RECURRING_RULES must be a JSON array of rules.');
  return v.map((entry, i) => {
    const o = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const at = `ONEBILL_RECURRING_RULES[${i}]`;
    const keyOf = (k: 'offer' | 'planCode' | 'productCode'): string | undefined => {
      if (o[k] === undefined) return undefined;
      if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw new Error(`${at} "${k}" must be a non-empty string when present.`);
      return (o[k] as string).trim();
    };
    const offer = keyOf('offer'), planCode = keyOf('planCode'), productCode = keyOf('productCode');
    const keys = [offer, planCode, productCode].filter((k) => k !== undefined).length;
    if (keys > 1) throw new Error(`${at} must carry exactly one of "offer", "planCode" or "productCode".`);
    const ignore = o.ignore === true;
    if (ignore && o.counts !== undefined) throw new Error(`${at} may carry "counts" or "ignore", not both.`);
    if (ignore && keys === 0) throw new Error(`${at} "ignore" needs an offer, planCode or productCode to ignore.`);
    let counts: string | string[] | undefined;
    if (!ignore) {
      const list = Array.isArray(o.counts) ? o.counts : [o.counts];
      if (o.counts === undefined || !list.length || !list.every((p) => typeof p === 'string' && COUNTS_RE.test(p))) throw new Error(`${at} needs "counts": a dotted path such as "dids.total", or an array of them.`);
      counts = Array.isArray(o.counts) ? (list as string[]) : (o.counts as string);
    }
    if (o.group !== undefined && (typeof o.group !== 'string' || !GROUP_RE.test(o.group.trim()))) throw new Error(`${at} "group" must be a short label (letters, digits, space, _ . ( ) & / + -).`);
    if (keys === 0 && !ignore && !o.group) throw new Error(`${at} has no offer, planCode or productCode, so it needs a "group" to be the row it defines.`);
    if (o.perUnit !== undefined && (typeof o.perUnit !== 'number' || !Number.isFinite(o.perUnit) || o.perUnit <= 0)) throw new Error(`${at} "perUnit" must be a positive number.`);
    if (o.why !== undefined && (typeof o.why !== 'string' || !o.why.trim() || o.why.trim().length > WHY_MAX)) throw new Error(`${at} "why" must be a note of 1-${WHY_MAX} characters.`);
    // The two credit maps take the SAME key vocabulary and the same value rule, so they are validated
    // by one loop: a divergence between them would be a rulebook that parses one way and reads another.
    for (const which of ['alsoCounts', 'entitles'] as const) {
      const m = o[which];
      if (m === undefined) continue;
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`${at} "${which}" must be an object of path-or-group to number.`);
      for (const [k, n] of Object.entries(m as Record<string, unknown>)) {
        if (!COUNTS_RE.test(k) && !GROUP_RE.test(k)) throw new Error(`${at} "${which}" key "${k}" is neither a dotted path nor a group label.`);
        if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${at} "${which}.${k}" must be a number.`);
      }
    }
    return {
      ...(offer ? { offer } : {}), ...(planCode ? { planCode } : {}), ...(productCode ? { productCode } : {}),
      ...(ignore ? { ignore: true as const } : { counts: counts! }),
      ...(o.group ? { group: (o.group as string).trim() } : {}),
      ...(o.perUnit !== undefined ? { perUnit: o.perUnit as number } : {}),
      ...(o.alsoCounts ? { alsoCounts: o.alsoCounts as Record<string, number> } : {}),
      ...(o.entitles ? { entitles: o.entitles as Record<string, number> } : {}),
      ...(o.why ? { why: (o.why as string).trim() } : {}),
    };
  });
}

/** A device-name suffix: short, alphanumeric, and case-insensitive on both sides of the comparison. */
const SUFFIX_RE = /^[A-Za-z0-9]{1,8}$/;
/** A suffix label is a chip on a narrow panel, not a sentence. Long enough for "SNAPmobile Web".
 *  Exported because the Ringotel label is held to the same ceiling — see `inventoryOpts`. */
export const SUFFIX_LABEL_MAX = 40;

/**
 * Parse `NS_DEVICE_SUFFIXES` — `{"<suffix>": {"label": "…", "teams": true?}}`.
 *
 * `undefined` when unset, which is what tells {@link inventoryOpts} to start from netsapiens-lib's
 * default legend rather than from an empty one. An EMPTY object is not the same thing and is honoured as
 * written: a deployment saying "no suffix means anything here" is a legitimate thing to say.
 *
 * Validated here rather than at the read so a bad value surfaces on the status page with the setting
 * named, not as a silently unlabelled device chip on someone's account panel.
 */
export function parseDeviceSuffixes(raw: string | undefined): DeviceSuffixLegend | undefined {
  if (!has(raw)) return undefined;
  let v: unknown;
  try { v = JSON.parse(raw!); } catch { throw new Error('NS_DEVICE_SUFFIXES is not valid JSON.'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('NS_DEVICE_SUFFIXES must be a JSON object of suffix to {label, teams?}.');
  const out: DeviceSuffixLegend = {};
  for (const [k, entry] of Object.entries(v as Record<string, unknown>)) {
    const at = `NS_DEVICE_SUFFIXES["${k}"]`;
    if (!SUFFIX_RE.test(k)) throw new Error(`${at}: a suffix is 1-8 letters or digits.`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} must be an object with a "label".`);
    const o = entry as Record<string, unknown>;
    if (typeof o.label !== 'string' || !o.label.trim()) throw new Error(`${at} needs a non-empty "label".`);
    if (o.label.trim().length > SUFFIX_LABEL_MAX) throw new Error(`${at} "label" must be ${SUFFIX_LABEL_MAX} characters or fewer.`);
    if (o.teams !== undefined && typeof o.teams !== 'boolean') throw new Error(`${at} "teams" must be true or false.`);
    // Lower-cased on the way in: the library compares case-insensitively, and two keys differing only in
    // case would otherwise look like two suffixes here and collapse to one there.
    out[k.toLowerCase()] = { label: o.label.trim(), ...(o.teams === true ? { teams: true } : {}) };
  }
  return out;
}

/** Does any rule resolve through the catalogue (a `planCode` or `productCode` key)? If not, {@link loadCatalogIndex} need never run. */
export const rulesUseCatalog = (rules: readonly RecurringRule[]): boolean => rules.some((r) => Boolean(r.planCode || r.productCode));

/** Throws on malformed config — callers that must not crash use onebillConfigError. */
export function resolveOnebillConfig(env: OnebillEnv): OnebillConfig {
  const spec = parseGroup(env.ONEBILL_LINK_GROUP);
  const baseUrl = has(env.ONEBILL_BASE_URL) ? env.ONEBILL_BASE_URL!.trim() : undefined;
  if (baseUrl && !/^https:\/\//i.test(baseUrl)) throw new Error('ONEBILL_BASE_URL must start with https://.');
  const offerNames = (env.ONEBILL_USAGE_OFFERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const markers = (env.ONEBILL_USAGE_IGNORE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const usageIgnore = markers.length ? markers : DEFAULT_USAGE_IGNORE;
  const recurringRules = parseRecurringRules(env.ONEBILL_RECURRING_RULES);
  // Parsed for its throw, not its value: the legend is read where the NetSapiens inventory is counted
  // (onebillAccount.ts), but `onebillConfigError` is the one place a malformed setting gets NAMED to an
  // operator, and a legend that only fails at read time would show up as an unlabelled chip instead.
  parseDeviceSuffixes(env.NS_DEVICE_SUFFIXES);
  return { mapping: [spec], ns: spec.ns, offerNames, usageIgnore, recurringRules, ...(baseUrl ? { baseUrl } : {}) };
}

/** null when fine OR when the integration is off (nothing to validate then). */
export function onebillConfigError(env: OnebillEnv): string | null {
  if (!onebillEnabled(env)) return null;
  try { resolveOnebillConfig(env); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/**
 * OAuth token cache on the Cache API, namespaced by deployment. Without it every isolate mints its own
 * token on first use; with it one grant serves a colo until it expires.
 */
export class CacheTokenCache implements TokenCache {
  constructor(private readonly cache: Cache, private readonly scope: string) {}
  #key(k: string): Request { return new Request(`https://onebill.internal/${this.scope}/token/${encodeURIComponent(k)}`); }
  async get(k: string): Promise<CachedToken | undefined> {
    const hit = await this.cache.match(this.#key(k));
    return hit ? ((await hit.json()) as CachedToken) : undefined;
  }
  async set(k: string, v: CachedToken): Promise<void> {
    await this.cache.put(this.#key(k), new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' } }));
  }
  async delete(k: string): Promise<void> { await this.cache.delete(this.#key(k)); }
}

function httpCfg(env: OnebillEnv, cache: Cache) {
  const cfg = resolveOnebillConfig(env);
  return { tenantId: env.ONEBILL_TENANT_ID!, clientSecret: env.ONEBILL_CLIENT_SECRET!, username: env.ONEBILL_USERNAME!, password: env.ONEBILL_PASSWORD!,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}), tokenCache: new CacheTokenCache(cache, scopeOf(env)) };
}
export function makeReadClient(env: OnebillEnv, cache: Cache): OneBillReadClient { return new OneBillReadClient(httpCfg(env, cache)); }
export function makeWriteClient(env: OnebillEnv, cache: Cache): OneBillWriteClient { return new OneBillWriteClient(httpCfg(env, cache)); }

// ─────────────────────────────────────────────────────────────────────────────
// The link report — a pure join of NS domains against the OneBill link group + usage subscriptions.
//
// Domain values are EXACT and OPAQUE here: never lowercased, never split on a territory suffix, never
// parsed. NS↔OneBill matching is always the library's own `targetKey(value, qualifier)`. The one place
// spelling gets normalized is inside `proposeMappings`, whose `canonicalized` candidates carry the NS
// spelling back — this module never re-implements that normalization itself.
// ─────────────────────────────────────────────────────────────────────────────

export interface NsTarget { domain: string; site?: string }
export interface NsDomainInfo { domain: string; sites: string[] }
export interface AccountRef { accountNumber: string; accountName?: string; status: string }

/**
 * An account as a ROW names it. Two fields beyond {@link AccountRef}, and both exist for the same
 * reason: an edit to a link that already exists is a `removeUnlisted` write, and such a write is "make
 * this account's links match this list".
 *
 * - `links` is every link this account holds in this namespace that the caller may SEE — this row's
 *   included. It is what the editor carries along so a change to one link does not delete the others.
 *   Hidden links are absent, exactly as they are from {@link ForeignRow.links}, because this list is
 *   rendered into the page and a hidden domain riding along here would be named on screen.
 * - `restricted` is the same fact {@link ForeignRow.restricted} and {@link ApplyBounds.restricted}
 *   carry: this account ALSO holds a link the caller was not shown. The apply route refuses a matching
 *   write on it, so the page shows a note rather than an editor whose every button ends in a 400.
 *
 * Only `LinkRow.accounts` carries this. `LinkReport.accounts` (the picker) and `LinkRow.candidate` stay
 * plain `AccountRef`s: nothing edits a link through them, so the extra fields would be weight with no
 * consumer — and one more place for the two derivations of `restricted` to disagree.
 */
export interface RowAccount extends AccountRef { links: NsTarget[]; restricted: boolean }

// ─────────────────────────────────────────────────────────────────────────────
// The setup preflight — is the custom-field group this deployment maps links onto actually declared
// in OneBill at all? Per onebill-lib ARCHITECTURE.md ~L358, OneBill materialises a BLANK instance of
// every DECLARED custom-field group onto every subscriber record — so a single full record answers
// this, independent of whether any account has values in it yet. `groupSetup` is pure: it never
// decides which record to read, that is `loadLinkReport`'s job.
// ─────────────────────────────────────────────────────────────────────────────

export type SetupMissing = 'group' | 'valueField' | 'qualifierField';

export interface SetupCheck {
  ok: boolean;
  missing: SetupMissing[];
  group: string;
  valueField: string;
  qualifierField?: string;
}

/**
 * Does `record` show the group + fields `spec` maps onto as DECLARED (present, whether or not
 * populated)? Absence of the group instance itself means "missing: ['group']" only — whether its
 * fields would have been declared is unknowable without an instance to look inside.
 */
export function groupSetup(record: Subscriber, spec: GroupLinkSpec): SetupCheck {
  const base = { group: spec.group, valueField: spec.valueField, ...(spec.qualifierField ? { qualifierField: spec.qualifierField } : {}) };
  const instances = (record?.accountAttribute as { key?: unknown; childAttribute?: unknown }[] | undefined) ?? [];
  const instance = instances.find((i) => i?.key === spec.group);
  if (!instance) return { ok: false, missing: ['group'], ...base };
  const children = (instance.childAttribute as { key?: unknown }[] | undefined) ?? [];
  const keys = new Set(children.map((c) => c?.key).filter((k): k is string => typeof k === 'string'));
  const missing: SetupMissing[] = [];
  if (!keys.has(spec.valueField)) missing.push('valueField');
  if (spec.qualifierField && !keys.has(spec.qualifierField)) missing.push('qualifierField');
  return missing.length ? { ok: false, missing, ...base } : { ok: true, missing: [], ...base };
}

export const ONEBILL_SETUP_TITLE = 'OneBill needs a custom-field group before links can be stored';

const setupMissingLabel = (m: SetupMissing, setup: SetupCheck): string => {
  if (m === 'group') return `the group itself (key "${setup.group}")`;
  if (m === 'valueField') return `the "${setup.valueField}" field`;
  return `the "${setup.qualifierField ?? ''}" field`;
};

/**
 * The remediation text, in the ONE place it is composed — `applyLinks`' refusal and the page's setup
 * card both use these exact words, so they cannot drift apart. See {@link ONEBILL_SETUP_TITLE} for
 * the accompanying title.
 */
export function setupChecklist(setup: SetupCheck): string {
  const q = setup.qualifierField ? ` and an optional text field "${setup.qualifierField}"` : '';
  const steps = `In OneBill, create an account-level custom-field group with the key "${setup.group}" and add a text field "${setup.valueField}"${q}. Then Refresh and fully verify.`;
  const missing = setup.missing.map((m) => setupMissingLabel(m, setup)).join(' and ');
  return missing ? `${steps} Missing: ${missing}.` : steps;
}

export interface LinkRow {
  domain: string;
  site?: string;
  /**
   * `split` is a BARE-domain row with no bare claim but at least one sited one: nobody bills the domain
   * as a whole because the sites are billed one by one. It is deliberately not `unlinked` — nothing is
   * missing there, and the action on it is "add the next site", not "claim the domain".
   */
  state: 'linked' | 'unlinked' | 'split' | 'conflict';
  accounts: RowAccount[]; // linked ⇒ 1, conflict ⇒ ≥2, unlinked/split ⇒ 0
  candidate?: AccountRef & { confidence: 'exact' | 'canonicalized' };
  sites: string[]; // the domain's NS sites (for the split picker)
  /**
   * On a `split` parent only: which of those sites OneBill already claims. The picker defaults to the
   * first site NOT in here, which is the whole reason the field exists — the parent row is the only
   * place that offers a site, and it cannot see its own children.
   */
  linkedSites?: string[];
  /**
   * On a `split` parent only: one entry per sited claim on this domain, in site order (the order the
   * site rows sit beneath it — a site with more than one claimant emits one entry per claimant).
   * `usageHolder` is true when that account holds an ACTIVE usage subscription whose identifier is this
   * domain, derived from the same `reconcileUsageSubscriptions` pass this function already runs. Hidden
   * values cannot occur here — every account named is one of these visible NS targets already.
   */
  siteAccounts?: { site: string; account: AccountRef; usageHolder: boolean }[];
  /**
   * On a SITE row only (`site` is set): how many sites on this domain carry a claim at all — the count
   * of sibling site rows under the same parent, one of which this row is. The page reads it to say "one
   * of N sites on this domain" or "the only site on this domain" beside the account, so a reader does
   * not have to scroll up to the parent to know whether this is the whole picture.
   */
  siteCount?: number;
  notes: string[];
}

export interface ForeignRow {
  account: AccountRef;
  value: string;
  qualifier?: string;
  /**
   * `closed` is CLASSIFIED but never SHIPPED: `buildLinkReport` drops those rows before returning, since
   * nothing on a non-Active account is writable from this page and a row offering no action is noise.
   * Such an account reaches the reader through `decommission` instead — and only when it still names a
   * live domain, which is the part that actually needs doing something about.
   */
  state: 'stale' | 'closed';
  /** Every link this account holds in this namespace — not just this one — so Remove can target any of them. */
  links: NsTarget[];
  /**
   * Does this account ALSO hold a link this deployment hides from the caller? A boolean, and nothing
   * more — it names nothing. The page needs it because the apply route refuses a matching write on such
   * an account (the list the page would send is missing exactly those links), so a Remove control here
   * would be a click that always ends in a 400. Same fact as {@link ApplyBounds.restricted}.
   */
  restricted: boolean;
  /** e.g. the domain exists in NS but not under this qualifier — remediation is "fix the site", not "remove the link". */
  notes: string[];
}

export interface UsageRow {
  account: AccountRef;
  verdict: string;
  findings: string[];
  /**
   * Every value this verdict rests on — its account's link values and the subscription identifiers it
   * was reconciled against, in the library's own normalised spelling.
   *
   * ⚠️ IT EXISTS SO A CACHED VERDICT CAN BE RE-FILTERED LATER. A quick view shows the last full pass's
   * usage rows, and that pass may be up to a day old — older than a change to `BLOCKED_DOMAINS` or
   * `ALLOWED_DOMAINS`. Without the values, a row could only ever be filtered by the predicate that was
   * in force when it was MEASURED, and a newly-hidden domain would keep being named for a day.
   *
   * Naming these on a row that ships is safe by construction: a row whose values include a hidden one
   * is dropped whole (the library's `findings` interpolate them verbatim, so there is no redacting it),
   * so every value present here is one the caller was already shown.
   */
  values: string[];
}

/**
 * One account that OneBill has closed while NetSapiens still has its domain — the thing nobody notices
 * until the invoice stops and the service does not. A CALLOUT, never a control: there is no write here,
 * because the remedy is a decommission in NetSapiens, not an edit in OneBill.
 */
export interface DecommissionRow {
  account: AccountRef;
  /** Only domains NetSapiens has AND this caller may see. Never a hidden one, never a site. */
  domains: string[];
}

/**
 * Which sweep produced the LINKS in a report.
 *
 * - `quick` reads the derived `externalId` index that rides the subscriber list — one paged walk for
 *   the whole tenant, no per-account reads except for the few accounts whose index names more than one
 *   NS link (those are read in full and the GROUP is used, because a split-domain account is exactly
 *   where index drift would bite). No subscriptions are read at all, so usage verdicts come from the
 *   last full pass or not at all.
 * - `full` is the audit: the custom-field group per account plus its subscriptions, which is the only
 *   pass that can notice the index disagreeing with the group.
 *
 * ⚠️ THE INDEX NEVER RESOLVES A WRITE TARGET. `applyLinks` re-reads each account it is about to touch
 * and builds that account's bounds from the group, so a quick report decides what is OFFERED, never
 * what is ALLOWED. See the 2026-08-03 spec, §"What this is NOT".
 */
export type ReportMode = 'quick' | 'full';

export interface LinkReport {
  generatedAt: string;
  /** Which sweep produced the links here. See {@link ReportMode}. */
  mode: ReportMode;
  /**
   * Is the custom-field group this deployment maps links onto actually declared in OneBill? See
   * {@link groupSetup}. Optional because `buildLinkReport` is a pure join with no record to check this
   * against — `loadLinkReport` always fills it in. When `ok` is false the page hides the table and
   * every write control and shows a remediation card instead; `applyLinks` refuses the whole batch.
   */
  setup?: SetupCheck;
  /**
   * `generatedAt` of the full pass `usage` (and the subscription half of `decommission`) came from —
   * null when no full pass is cached, which is also when `usage` is empty for want of one.
   */
  verifiedAt: string | null;
  /** Is `usage` older than this report, or missing? Always true in `quick` mode, never in `full`. */
  usageStale: boolean;
  /**
   * Ordered alphabetically by domain, case-insensitive, with each domain's site rows directly beneath
   * it in site order (also case-insensitive) — state does not affect this order. A SITE row sorts with
   * its parent rather than on its own state, so a split domain and the sites under it read as one group
   * instead of three rows scattered across the table. (The page can re-sort by state instead — see
   * `obSortGroups` in `onebillPage.ts` — but the report itself always arrives in this fixed order.)
   */
  rows: LinkRow[];
  foreign: ForeignRow[];
  usage: UsageRow[]; // bySeverity, 'ok'/'none' omitted
  /** The offer names the usage verdicts were judged against, so the page can say them in words. */
  usageOffers: string[];
  decommission: DecommissionRow[]; // by account number
  accounts: AccountRef[]; // every Active account, for the manual picker
  failures: { accountNumber: string; message: string }[];
  /**
   * Domains whose NS site list could not be read. Never hidden: a site that failed to load looks
   * exactly like a site that does not exist, and that difference decides whether a link is a typo to
   * fix or a link to remove. `buildLinkReport` is pure and does no reads, so it always reports none —
   * `loadLinkReport` fills this in.
   */
  siteReadFailures: string[];
  /**
   * How many links in this namespace point at a domain this deployment refuses to SHOW this caller —
   * blocked, or outside a set ALLOWED_DOMAINS. Counted, never named: the count says the report is not
   * the whole tenant, and naming the domains would be the disclosure the two lists exist to prevent.
   */
  hiddenLinkCount: number;
  requestCount: number;
  /**
   * Per-account reads the sweep retried once after a transport-level failure — see
   * `GatherResult.retried` in onebill-lib. Already counted inside `requestCount`; this is only so the
   * header can say a pass hit trouble along the way. `gather.retried ?? 0`, so a report built from an
   * older lib version (before the field existed) reads as zero rather than throwing.
   */
  retried: number;
}

const key = (d: string, s?: string): string => targetKey(d, s);

// `linkedSites` is what makes a claimless row `split` rather than `unlinked`; it is empty for every site
// row and for a domain nobody bills per site. A split row can never carry a candidate — the guard below
// is `state === 'unlinked'`, so that falls out rather than being a second rule to keep in step.
function mk(domain: string, site: string | undefined, accounts: RowAccount[], candidate: LinkRow['candidate'], sites: string[], notes: string[], linkedSites: string[] = [], siteAccounts?: LinkRow['siteAccounts'], siteCount?: number): LinkRow {
  const state: LinkRow['state'] = accounts.length > 1 ? 'conflict' : accounts.length === 1 ? 'linked' : linkedSites.length ? 'split' : 'unlinked';
  return { domain, ...(site ? { site } : {}), state, accounts, ...(state === 'unlinked' && candidate ? { candidate } : {}), sites,
    ...(state === 'split' ? { linkedSites, ...(siteAccounts ? { siteAccounts } : {}) } : {}),
    ...(site && siteCount !== undefined ? { siteCount } : {}), notes };
}

export interface BuildLinkReportOptions {
  now?: Date;
  /**
   * Is this link value a NetSapiens domain this deployment refuses to show the caller? Built in
   * worker.ts from ALLOWED_DOMAINS/BLOCKED_DOMAINS and passed in — this module never reads those keys,
   * because "which domains exist and which are shown" is the route's decision, not the join's.
   *
   * A value this returns true for is DROPPED from `foreign[]` and counted in `hiddenLinkCount`. A value
   * that is neither visible nor hidden — a deleted domain, one no NS token here can see — is untouched
   * and stays the honest `stale`/`closed` case, which is the whole reason that section exists.
   *
   * Default: nothing is hidden.
   */
  hidden?: (value: string) => boolean;
  /**
   * Which sweep produced `gather`. Defaults to `full` — the join itself is the same either way, and a
   * caller who says nothing is describing the audit pass this function was written for.
   */
  mode?: ReportMode;
  /** In `quick` mode only: the `generatedAt` of the full pass whose usage data the caller will overlay. */
  verifiedAt?: string | null;
  /**
   * Extra values each account NAMES, beyond the links in `gather` — per account number.
   *
   * In `quick` mode the rows carry no subscriptions, so the decommission callout would lose the half of
   * itself that comes from subscription identifiers. The last full pass's identifiers are carried here
   * instead. Read ONLY by the decommission scan, and filtered by exactly the same rules as anything
   * else there: a value NetSapiens does not have, or one this deployment hides, is never named.
   */
  extraValues?: Record<string, string[]>;
}

/**
 * Join the NS domain list against the OneBill link group and usage-subscription candidates.
 *
 * Pure: no I/O. `gather` is `GatherResult` from `../onebill-lib`'s `gatherUsageRows` (or a hand-built
 * equivalent); `accounts` supplies the account status `GatherResult`/`UsageReconcileRow` don't carry.
 */
export function buildLinkReport(
  domains: NsDomainInfo[],
  gather: GatherResult,
  // `usageIgnore` is optional HERE and defaulted in `resolveOnebillConfig`, not here: this function is
  // the pure join and owns no configuration defaults. Absent ⇒ nothing is treated as retired.
  cfg: Pick<OnebillConfig, 'ns' | 'offerNames'> & Partial<Pick<OnebillConfig, 'usageIgnore'>>,
  accounts: AccountRef[],
  opts: BuildLinkReportOptions = {},
): LinkReport {
  const now = opts.now ?? new Date();
  const isHidden = opts.hidden ?? ((): boolean => false);
  const acct = new Map(accounts.map((a) => [a.accountNumber, a]));
  const ref = (n: string): AccountRef => acct.get(n) ?? { accountNumber: n, status: 'Unknown' };

  const nsKeys = new Map<string, NsTarget>();
  for (const d of domains) {
    nsKeys.set(key(d.domain), { domain: d.domain });
    for (const s of d.sites) nsKeys.set(key(d.domain, s), { domain: d.domain, site: s });
  }

  // Links per target, and foreign links (this namespace's links that don't resolve to any NS domain).
  const claims = new Map<string, RowAccount[]>();
  const foreign: ForeignRow[] = [];
  let hiddenLinkCount = 0;
  // Every value each account names, in the spelling OneBill returned it. The decommission callout reads
  // this rather than a reconciliation's `linkValues`/`subscriptionValues`, which are normalized (trim +
  // lowercase) for COMPARISON — matching a lowercased value against the NS domain list would quietly
  // fail on a domain NetSapiens spells with capitals, and `hidden` is asked about real values.
  const namedValues = new Map<string, string[]>();
  // Accounts whose links in this namespace are ALL hidden. They are dropped from the picker below: a
  // row naming an account the caller can be told nothing else about is an invitation to write blind.
  const allHidden = new Set<string>();
  // A RETIRED identifier is not a usage match at all. Applied to the rows BEFORE reconciliation rather
  // than to the verdicts after it, so every verdict is computed as if the retired subscription did not
  // exist — filtering afterwards would leave an 'ambiguous' that no longer has two things to be
  // ambiguous between. Case-insensitive substring, because the marker is a rename convention, not a
  // field: OneBill has nowhere to record "this identifier is history".
  const markers = (cfg.usageIgnore ?? []).map((m) => m.trim().toUpperCase()).filter(Boolean);
  const retired = (identifier: string): boolean => {
    const u = identifier.toUpperCase();
    return markers.some((m) => u.includes(m));
  };
  const rows0 = markers.length
    ? gather.rows.map((r) => ({ ...r, subscriptions: r.subscriptions.filter((sub) => !retired(String(sub.subscriptionIdentifier ?? ''))) }))
    : gather.rows;

  for (const row of rows0) {
    const all: Link[] = row.links.filter((l) => l.ns === cfg.ns);
    namedValues.set(row.accountNumber, [
      ...all.map((l) => l.value),
      ...row.subscriptions.map((sub) => String(sub.subscriptionIdentifier ?? '')),
    ].filter(Boolean));
    const mine: Link[] = all.filter((l) => !isHidden(l.value));
    hiddenLinkCount += all.length - mine.length;
    if (all.length && !mine.length) allHidden.add(row.accountNumber);
    // Per account, from this same join: it holds a hidden link. `bounds.restricted` derives the identical
    // fact by diffing this report against the unfiltered one — two paths to one truth, and the selftest
    // asserts they agree row by row.
    const restricted = all.length > mine.length;
    // Hidden links are absent from this list too. It is rendered into the page (it is what a removal
    // has to send back), so a hidden domain riding along here would be named on screen — and a removal
    // built from a list missing them would silently delete them, which is why `ApplyBounds.restricted`
    // refuses `removeUnlisted` on exactly these accounts.
    const accountLinks: NsTarget[] = mine.map((l) => ({ domain: l.value, ...(l.qualifier ? { site: l.qualifier } : {}) }));
    // The row's own view of this account: the same visible link list and the same `restricted` fact the
    // foreign rows carry, so an edit on a row can send back what the account holds without the page
    // having to look it up anywhere else.
    const rowAcct: RowAccount = { ...ref(row.accountNumber), links: accountLinks, restricted };
    for (const l of mine) {
      const k = key(l.value, l.qualifier);
      const a = ref(row.accountNumber);
      if (!nsKeys.has(k)) {
        // The domain itself may be a real NS domain even though this exact (value, qualifier) isn't —
        // that's a site typo/removal, not a link to nowhere, and calling it "stale" would tell the
        // operator to remove it when the fix is to correct the site instead.
        const notes = l.qualifier && nsKeys.has(key(l.value)) ? [`Domain "${l.value}" exists in NetSapiens but has no site "${l.qualifier}".`] : [];
        foreign.push({ account: a, value: l.value, ...(l.qualifier ? { qualifier: l.qualifier } : {}), state: a.status === 'Active' ? 'stale' : 'closed', links: accountLinks, restricted, notes });
        continue;
      }
      // A given account claiming the same target twice (a duplicated link within one account) must not
      // read as a conflict between two DIFFERENT accounts.
      const existing = claims.get(k) ?? [];
      if (!existing.some((x) => x.accountNumber === a.accountNumber)) claims.set(k, [...existing, rowAcct]);
    }
  }

  // Candidates from the usage subscriptions, checked against the real NS domain list.
  // No `ns` here: the rows' links were filtered to this namespace upstream by `gatherUsageRows`, and
  // `ReconcileUsageOptions` has no such option — passing one was an extra property the compiler rejects.
  const recs = reconcileUsageSubscriptions(rows0, { spec: { offerNames: cfg.offerNames }, now });
  const proposal = proposeMappings(recs, { ns: cfg.ns, knownTargets: domains.map((d) => d.domain) });
  // Blocked per ACCOUNT, not per target: an account in any conflict gets none of its candidates
  // proposed anywhere, not just the contested one. Deliberately wide — a suppressed candidate just
  // means "link it by hand", not a wrong write, so erring toward more manual review costs nothing.
  const conflicted = new Set(proposal.conflicts.flatMap((c) => c.accountNumbers));
  const candidate = new Map<string, LinkRow['candidate']>();
  for (const c of proposal.candidates) {
    if (c.confidence !== 'exact' && c.confidence !== 'canonicalized') continue;
    if (conflicted.has(c.accountNumber)) continue;
    candidate.set(key(c.value), { ...ref(c.accountNumber), confidence: c.confidence });
  }

  // Per-account active usage matches, for `siteAccounts.usageHolder` below. Same normalisation the
  // library used to produce them (`v.trim().toLowerCase()`), so comparing against a domain needs the
  // same treatment and nothing more.
  const subsByAccount = new Map(recs.map((r) => [r.accountNumber, r.subscriptionValues]));
  const normalize = (v: string): string => v.trim().toLowerCase();

  const rows: LinkRow[] = [];
  for (const d of domains) {
    const sitedClaims = d.sites.filter((s) => claims.has(key(d.domain, s)));
    const bare = claims.get(key(d.domain)) ?? [];
    // No note naming the sited claimants here: the Account column lists each one by itself (see
    // `siteAccounts` below), and a note repeating "Split by site in OneBill: HQ, Lab." says the same
    // thing again in words. `linkedSites` still carries the fact structurally, for the site picker's
    // default. Dropped 2026-09-03 (task 11 item 6) — was `notes.push` here.
    const notes: string[] = [];
    // Only a row that will actually come out `split` (no bare claim) carries this — a contested bare
    // domain that also has a site claimed is a `conflict`, and the field is `split`-only by contract.
    const siteAccounts: LinkRow['siteAccounts'] = bare.length === 0 && sitedClaims.length
      ? [...sitedClaims].sort((a, b) => a.localeCompare(b)).flatMap((s) =>
        (claims.get(key(d.domain, s)) ?? []).map((a) => ({
          site: s,
          account: ref(a.accountNumber),
          usageHolder: (subsByAccount.get(a.accountNumber) ?? []).includes(normalize(d.domain)),
        })))
      : undefined;
    rows.push(mk(d.domain, undefined, bare, candidate.get(key(d.domain)), d.sites, notes, sitedClaims, siteAccounts));
    for (const s of sitedClaims) rows.push(mk(d.domain, s, claims.get(key(d.domain, s))!, undefined, d.sites, [], undefined, undefined, sitedClaims.length));
  }
  // Alphabetical by domain, case-insensitive, with each domain's site rows directly beneath it in site
  // order (also case-insensitive) — the state-rank ordering this used to carry is gone: state chips and
  // the filter box carry that now, and a fixed alphabetical order is one a reader can actually predict.
  // The bare row's `site` is undefined, and `''` sorts before every real site name, so it always leads
  // its own group without a separate comparator term for it.
  rows.sort((a, b) =>
    a.domain.localeCompare(b.domain, undefined, { sensitivity: 'base' })
    || (a.site ?? '').localeCompare(b.site ?? '', undefined, { sensitivity: 'base' }));

  // The library's `findings` interpolate link values AND subscription identifiers verbatim, so a usage row
  // is dropped whole when either side names a hidden domain — there is no way to redact it without lying
  // about what the verdict rests on. The cost is one missing row; the alternative is naming the domain.
  //
  // An account that is not Active is dropped too, whatever its verdict: the usage list is a work queue,
  // and the work on a closed account is not "fix the billing". (`ref` reports 'Unknown' for an account
  // the sweep did not return, which counts as not-Active here — it cannot, since `accounts` and
  // `gather.rows` come from one subscriber walk, but treating unknown as writable-and-live is the wrong
  // way round to be wrong.)
  // A shared domain has ONE usage subscription (OneBill forbids duplicate identifiers), held by one of the
  // accounts billed on it. The others are linked by site and can never hold one, so `missing` on them is
  // the design, not a fault: drop a `missing` row whose every link value is covered by an ACTIVE usage
  // match on some other account. `subscriptionValues` holds active matches only (usage.ts).
  const coveredElsewhere = new Map<string, Set<string>>();
  for (const r of recs) for (const v of r.subscriptionValues) coveredElsewhere.set(v, (coveredElsewhere.get(v) ?? new Set()).add(r.accountNumber));
  const coveredByAnother = (r: UsageReconciliation): boolean =>
    r.linkValues.length > 0 && r.linkValues.every((v) => [...(coveredElsewhere.get(v) ?? [])].some((a) => a !== r.accountNumber));
  const usage: UsageRow[] = recs
    .filter((r) => r.verdict !== 'ok' && r.verdict !== 'none')
    .filter((r) => !(r.verdict === 'missing' && coveredByAnother(r)))
    .filter((r) => ref(r.accountNumber).status === 'Active')
    .filter((r) => ![...r.linkValues, ...r.subscriptionValues].some((v) => isHidden(v)))
    .sort(bySeverity)
    .map((r) => ({ account: ref(r.accountNumber), verdict: r.verdict, findings: r.findings, values: [...r.linkValues, ...r.subscriptionValues] }));

  // Closed in OneBill, still live in NetSapiens. Derived from the ACCOUNT and the values it names, not
  // from a usage verdict: a closed account whose billing agreed perfectly with its link has verdict 'ok'
  // and never was a usage row, and it is exactly the case this section exists for.
  const decommission: DecommissionRow[] = [];
  for (const row of rows0) {
    const a = ref(row.accountNumber);
    if (a.status === 'Active') continue;
    const seen = new Set<string>();
    const domains: string[] = [];
    for (const v of [...(namedValues.get(row.accountNumber) ?? []), ...(opts.extraValues?.[row.accountNumber] ?? [])]) {
      // The BARE domain key, not the sited one: whether a link's site is right has nothing to do with
      // whether NetSapiens still has the domain, and what this section names is domains.
      if (!nsKeys.has(key(v))) continue;
      if (isHidden(v) || seen.has(v)) continue; // hidden values are never named, here as anywhere
      seen.add(v);
      domains.push(v);
    }
    if (domains.length) decommission.push({ account: a, domains });
  }
  decommission.sort((x, y) => x.account.accountNumber.localeCompare(y.account.accountNumber));

  // A full pass verified its own usage data the moment it ran; a quick one carries whatever the last
  // full pass left behind, and says so. `usageStale` is not derived from comparing timestamps — a quick
  // pass whose overlay is seconds old is still showing usage nobody re-read.
  const mode: ReportMode = opts.mode ?? 'full';
  return {
    generatedAt: now.toISOString(),
    mode,
    verifiedAt: mode === 'full' ? now.toISOString() : (opts.verifiedAt ?? null),
    usageStale: mode !== 'full',
    usageOffers: [...cfg.offerNames],
    siteReadFailures: [],
    hiddenLinkCount,
    rows,
    // Closed rows are classified above and dropped here: nothing on a non-Active account is written from
    // this page, so a row that can only be read is noise in a list whose whole purpose is remediation.
    // The account is not lost — if it still names a live domain it is in `decommission` instead.
    foreign: foreign.filter((f) => f.state !== 'closed'),
    usage,
    decommission,
    accounts: accounts.filter((a) => a.status === 'Active' && !allHidden.has(a.accountNumber)),
    failures: gather.failures.map((f) => ({ accountNumber: f.accountNumber, message: f.error instanceof Error ? f.error.message : String(f.error) })),
    requestCount: gather.requestCount,
    retried: gather.retried ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The I/O half: loading the report (NS sites + a OneBill sweep, cached) and applying link writes.
// ─────────────────────────────────────────────────────────────────────────────

/** A request this Worker refuses before touching OneBill. Carries the status the route answers with. */
export class OnebillRequestError extends Error {
  /**
   * 400 unless the caller says otherwise. `onebillAccount.ts` raises 409 for a domain whose link state
   * is not a single account: the request is well-formed and the caller can do nothing to fix it here,
   * which is a conflict with the current state, not a malformed request.
   */
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The only NetSapiens read this module performs. `NsClient` satisfies it, and cannot write. */
export interface NsSiteSource {
  get<T = unknown>(path: string): Promise<T>;
}

/** What a link write reports back. The subset of the library's `SetLinksResult` this module reads. */
export interface LinkWriteResult {
  created: readonly unknown[];
  updated: readonly unknown[];
  unchanged: readonly unknown[];
  removed: readonly unknown[];
  /** Links the record already held that this call did NOT ask for, left in place (no `removeUnlisted`). */
  notRemoved: readonly unknown[];
  /** Requested links whose namespace this mapping does not cover — nothing was written for them. */
  unmapped: readonly unknown[];
  externalId: string;
  collateral: readonly string[];
}

/** The only OneBill write this module performs. `OneBillWriteClient` satisfies it. */
export interface OnebillLinkWriter {
  setSubscriberLinks(accountNumber: string, links: readonly Link[], mapping: LinkMapping, opts?: { removeUnlisted?: boolean }): Promise<LinkWriteResult>;
}

/** How long a report stays cached. Even a quick pass is a full paged subscriber walk. */
const REPORT_TTL_S = 600;
/**
 * How long the usage half of a FULL pass stays cached, for a quick view to show.
 *
 * A day, not ten minutes: this is the answer to "when was this last actually verified", and an
 * overlay that expired with the report it came from would mean a quick view says "not yet verified"
 * within minutes of a verify — which is both untrue and useless. It is always stamped with the pass
 * that produced it (`verifiedAt`) and always labelled stale, so age is visible rather than assumed.
 */
const USAGE_TTL_S = 86_400;

/** A `refresh` landing this soon after the entry it would replace serves the entry instead: an authenticated reseller must not be able to drive repeated fleet sweeps or per-extension fan-outs with a held key. */
export const REFRESH_COOLDOWN_S = 30;

/**
 * Is `stamp` young enough that a `refresh` over it should be served from the entry?
 *
 * The cooldown is the only rate limit these read paths have. Every other bound on them is an authz
 * bound, and `refresh=1` is precisely the parameter that spends the caller's NetSapiens and OneBill
 * credentials without one — a held key can otherwise drive the sweep as fast as it can ask.
 *
 * A stamp in the FUTURE is not "young": the age must be a real, non-negative interval, or an entry
 * written by a skewed colo would pin itself fresh and refuse every refresh until its TTL ran out.
 *
 * Exported so the account report applies one rule to its own two entry kinds — see the note on
 * `domainHash` for why that module shares this one's cache vocabulary instead of restating it.
 */
export function withinRefreshCooldown(stamp: string | undefined, now: Date): boolean {
  if (!stamp) return false;
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  return age >= 0 && age < REFRESH_COOLDOWN_S * 1000;
}

// A domain or site deleted in NetSapiens within the TTL still appears here, and the apply route's
// bounds are built from this report — so for up to ten minutes a target can be written that NS no
// longer has. That is a data-quality blemish, not an authz gap: the domain was the caller's own when
// the report was built, and the next report shows the link in the `foreign` section, which is exactly
// where a link to a target NS does not have belongs.
// Exported so onebillAccount.ts shares one key scheme — two key builders would be two namespaces
// that silently never collide, and a refresh in one would not clear the other.
export async function domainHash(domains: string[]): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([...domains].sort().join('\n')));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Every cache entry this feature writes, one key shape.
 *
 * `quick` and `full` hold `{report, bounds, inputs}` for their own mode; `usage` holds the overlay a
 * quick view borrows from the last full pass; `catalog` is the tenant-wide plan index. The account
 * report is TWO kinds, not one: `domain` holds one domain's inventory read (keyed by the domain) and
 * `subs` one account's subscriptions (keyed by the account number) — because an account can span
 * several domains and a domain can be billed to several accounts, so neither half is a fact about the
 * pair. Every kind shares ONE SHAPE segment — `v3` today, raised from `v1` when fax lines split out of
 * the DID counts and from `v2` when the device-suffix legend joined the inventory options — so a shape
 * change orphans the old entries rather than trusting the TTL to have flushed every colo. It is deliberately not per-kind: one segment cannot be forgotten on the kind that
 * needed it, and orphaning a few still-valid entries costs one re-read. What an older-shaped entry does
 * if it IS read differs by kind: the link report throws, while `domain`, `subs` and `catalog` treat it
 * as a MISS and re-read — the newer behaviour, and the better one.
 */
// Exported so onebillAccount.ts shares one key scheme — see the note on domainHash above.
export function entryKey(scope: string, kind: 'quick' | 'full' | 'usage' | 'domain' | 'subs' | 'catalog', hex: string): Request {
  return new Request(`https://onebill.internal/${scope}/${kind}/v4/${hex}`);
}

export interface LoadLinkReportOptions {
  /** Bypass the cached report of the chosen mode and re-read. */
  refresh?: boolean;
  /**
   * Which sweep to run. Defaults to `quick` — the page's first load and its Refresh button, where the
   * cost of the audit pass buys nothing a click cannot ask for. See {@link ReportMode}.
   */
  mode?: ReportMode;
  /** Injected for tests; production passes `makeReadClient(env, cache)`. */
  readSource?: UsageReadSource;
  now?: Date;
  /** See {@link BuildLinkReportOptions.hidden}. Built by the route from its env, never read here. */
  hidden?: (value: string) => boolean;
}

/**
 * What a load produces: the report the caller may SEE, and the bounds a write is held to.
 *
 * Two values rather than one because they answer to different audiences. The report is shipped to the
 * page and must name nothing hidden; the bounds stay in the Worker and must know about everything,
 * including the links the page was not shown. Cached together — a cache hit that restored only the
 * report would leave `restricted` empty exactly when something is being hidden.
 */
export interface LoadedLinkReport {
  report: LinkReport;
  bounds: ApplyBounds;
}

/**
 * The usage half of a full pass, kept apart from the report so a quick view can borrow it.
 *
 * `decommissionFromSubs` is the subscription identifiers each account named, NOT a decommission list:
 * the quick pass re-derives which of them NetSapiens still has and which this caller may see, so an
 * account re-opened since the full pass, or a domain deleted since, is judged now rather than then.
 */
export interface UsageOverlay {
  usage: UsageRow[];
  decommissionFromSubs: [string, string[]][];
  verifiedAt: string;
}

/**
 * Everything a report is rebuilt FROM, cached beside it.
 *
 * ⚠️ Why the inputs and not just the report: after a write, only the written accounts are re-read, and
 * putting their fresh rows back means re-running the join — the whole join, since a link moving between
 * accounts changes another account's row, another domain's state, and the bounds. Patching the finished
 * report structurally would be a second, partial implementation of `buildLinkReport`, which is exactly
 * the kind of duplicate that drifts. See {@link patchReportAccounts}.
 */
export interface CachedInputs {
  mode: ReportMode;
  infos: NsDomainInfo[];
  accounts: AccountRef[];
  rows: UsageReconcileRow[];
  failures: { accountNumber: string; message: string }[];
  requestCount: number;
  retried: number;
  siteReadFailures: string[];
  /** `quick` only: what the last full pass verified, if one is still cached. */
  overlay?: UsageOverlay;
  /** See {@link LinkReport.setup}. Always computed by `loadLinkReport`, cached as part of the entry. */
  setup: SetupCheck;
}

/** The cache entry's on-the-wire shape: Sets and Maps do not survive JSON on their own. */
export interface CachedEntry {
  report: LinkReport;
  bounds: { targets: string[]; accounts: string[]; restricted: string[]; existing: [string, string[]][] };
  inputs: CachedInputs;
}

const encodeBounds = (b: ApplyBounds): CachedEntry['bounds'] => ({
  targets: [...b.targets], accounts: [...b.accounts], restricted: [...b.restricted],
  existing: [...b.existing].map(([k, v]) => [k, [...v]]),
});
const decodeBounds = (b: CachedEntry['bounds']): ApplyBounds => ({
  targets: new Set(b.targets ?? []), accounts: new Set(b.accounts ?? []), restricted: new Set(b.restricted ?? []),
  existing: new Map((b.existing ?? []).map(([k, v]) => [k, new Set(v)])),
});

/**
 * Run `worker` over `items` with at most `limit` in flight. Mirrors the library's own pool, and for
 * the same reason: a per-account read loop that is sequential over a tenant is the whole cost of a
 * pass. Order of results is not meaningful here — every worker writes into a map by account number.
 */
async function pooled<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!);
    }
  }));
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The QUICK sweep: links from the derived `externalId` index that already rode the subscriber list.
 *
 * Two reads and no more: the paged subscriber walk, and one full record for each account whose index
 * names MORE THAN ONE link in this namespace. Those are the split-domain accounts — the ones whose
 * `externalId` is most likely to have been truncated or hand-edited out of step with the group — so
 * for them the GROUP wins, decoded by the library's own `attributesToLinks`. Never `getSubscriptions`:
 * that read is what makes the audit pass cost 2N, and nothing here judges usage.
 */
async function quickRows(
  source: UsageReadSource,
  subs: Subscriber[],
  cfg: OnebillConfig,
): Promise<Pick<CachedInputs, 'rows' | 'failures' | 'requestCount' | 'retried'>> {
  const failures: CachedInputs['failures'] = [];
  // The walk is several calls; counted as one step, exactly as `gatherUsageRows` counts its own.
  let requestCount = 1;

  const fromIndex = new Map<string, Link[]>();
  const needsGroup: Subscriber[] = [];
  for (const s of subs) {
    const parsed = parseExternalId(s.externalId);
    const links = parsed.links.filter((l) => l.ns === cfg.ns);
    // Read the record when the index names more than one link — the split-domain accounts, where drift
    // is likeliest — and ALSO when the field admits it is not the whole story: a `+N` continuation
    // marker says N links live outside it, and an unparsed token is something this codec did not
    // understand. Either way the index is known-incomplete, which is exactly when joining from it would
    // report an account as holding less than it does.
    if (links.length > 1 || parsed.continuation !== undefined || parsed.unknown.length > 0) needsGroup.push(s);
    else fromIndex.set(s.accountNumber, links);
  }

  const fromGroup = new Map<string, Link[]>();
  await pooled(needsGroup, 8, async (s) => {
    requestCount++;
    try {
      const full = await source.getSubscriber(s.accountNumber);
      fromGroup.set(s.accountNumber, attributesToLinks(full, cfg.mapping).filter((l) => l.ns === cfg.ns));
    } catch (e) {
      // Visible, never silent: an account whose record would not read covers fewer links than the row
      // claims, and the report says so rather than showing it as an account holding nothing.
      failures.push({ accountNumber: s.accountNumber, message: errText(e) });
    }
  });

  const rows: UsageReconcileRow[] = [];
  for (const s of subs) {
    const links = fromGroup.get(s.accountNumber) ?? fromIndex.get(s.accountNumber);
    if (!links) continue; // its record read failed — it is in `failures`
    rows.push({
      accountNumber: s.accountNumber,
      ...(s.accountName === undefined ? {} : { accountName: s.accountName }),
      links,
      subscriptions: [],
    });
  }
  // No retry here: a quick pass is cheap enough to repeat whole, and the one read it does per account
  // is not the multi-minute sweep `gatherUsageRows` retries inside.
  return { rows, failures, requestCount, retried: 0 };
}

/**
 * The pure half of a load: inputs → the report the caller may see, and the bounds a write is held to.
 *
 * Shared by `loadLinkReport` and `patchReportAccounts` so a rebuilt entry is assembled by exactly the
 * same code as a freshly loaded one — a second assembler would be free to disagree with the first.
 */
function assembleReport(inputs: CachedInputs, cfg: OnebillConfig, opts: { hidden?: (v: string) => boolean; now?: Date } = {}): LoadedLinkReport {
  const gather: GatherResult = {
    rows: inputs.rows,
    failures: inputs.failures.map((f) => ({ accountNumber: f.accountNumber, error: f.message })),
    requestCount: inputs.requestCount,
    retried: inputs.retried,
  };
  const common: BuildLinkReportOptions = {
    now: opts.now,
    mode: inputs.mode,
    verifiedAt: inputs.overlay?.verifiedAt ?? null,
    ...(inputs.overlay ? { extraValues: Object.fromEntries(inputs.overlay.decommissionFromSubs) } : {}),
  };
  // TWO JOINS OF ONE SWEEP when this deployment hides anything: the report the caller sees, and the
  // Worker's own unfiltered view of the same rows. The second never leaves this function — it exists
  // so the bounds can be built from what is really on each record. Both are pure, and the second is
  // skipped entirely when nothing is hidden.
  const base = buildLinkReport(inputs.infos, gather, cfg, inputs.accounts, { ...common, hidden: opts.hidden });
  const report: LinkReport = {
    ...base,
    setup: inputs.setup,
    siteReadFailures: inputs.siteReadFailures,
    // A quick pass read no subscriptions, so its own `usage` is empty by construction — the last full
    // pass's verdicts stand in, stamped `usageStale` with the `verifiedAt` they were measured at.
    //
    // RE-FILTERED HERE, with the predicate this request was built with. The overlay lives for a day and
    // was filtered by whatever `ALLOWED_DOMAINS`/`BLOCKED_DOMAINS` said when it was written; honouring
    // only that would keep naming a newly-blocked domain until the entry aged out. A row from an older
    // overlay that carries no `values` at all is dropped rather than trusted — the same fail-closed
    // reading a malformed cache entry gets.
    ...(inputs.mode === 'quick'
      ? { usage: (inputs.overlay?.usage ?? []).filter((u) => Array.isArray(u.values) && !u.values.some((v) => (opts.hidden ?? (() => false))(v))) }
      : {}),
  };
  const full: LinkReport = opts.hidden
    ? { ...buildLinkReport(inputs.infos, gather, cfg, inputs.accounts, common), setup: inputs.setup, siteReadFailures: inputs.siteReadFailures }
    : report;
  return { report, bounds: applyBounds(report, full) };
}

/** Store `entry` under `k`. One place, so the TTL and the content type cannot drift between callers. */
async function putEntry(cache: Cache, k: Request, body: unknown, ttl: number): Promise<void> {
  await cache.put(k, new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` } }));
}

/** A malformed or older-shaped entry is a MISS, never a 500. */
async function readEntry(cache: Cache, k: Request): Promise<CachedEntry | null> {
  const hit = await cache.match(k);
  if (!hit) return null;
  const entry = (await hit.json().catch(() => null)) as Partial<CachedEntry> | null;
  // `!entry.inputs.setup` is deliberately here rather than a key-version bump: an entry from before
  // this field existed reads as a miss and is rebuilt (this cache's TTL is ten minutes at most, so the
  // cost is one extra sweep, not a stale page pretending the group is fine).
  if (!entry || !entry.report || !entry.bounds || !entry.inputs || !Array.isArray(entry.inputs.rows) || !entry.inputs.setup) return null;
  return entry as CachedEntry;
}

/**
 * Load the link report for `domains`: their NS sites, plus a OneBill sweep of the chosen mode, joined
 * by `buildLinkReport` and cached for ten minutes under this deployment's scope.
 *
 * `domains` is the caller's own NS-visible set, already filtered by the route — this function never
 * decides who may see a domain.
 */
export async function loadLinkReport(
  env: OnebillEnv,
  cache: Cache,
  ns: NsSiteSource,
  domains: string[],
  opts: LoadLinkReportOptions = {},
): Promise<LoadedLinkReport> {
  const cfg = resolveOnebillConfig(env);
  const mode: ReportMode = opts.mode === 'full' ? 'full' : 'quick';
  const scope = scopeOf(env);
  const hex = await domainHash(domains);
  const k = entryKey(scope, mode, hex);
  // The entry is read even on a refresh, and costs one cache lookup to do it: a refresh inside
  // REFRESH_COOLDOWN_S of the entry it would replace is served from the entry instead. This sweep is a
  // paged subscriber walk plus one `/sites` read per domain, and nothing else on the route bounds how
  // often an authenticated caller may ask for a fresh one.
  const entry = await readEntry(cache, k);
  if (entry && (!opts.refresh || withinRefreshCooldown(entry.report.generatedAt, opts.now ?? new Date()))) {
    return { report: entry.report, bounds: decodeBounds(entry.bounds) };
  }

  // Sites, per domain. A failed read is NOT silently "no sites": the domain still lists (its bare
  // target is the common case anyway), and the failure is named in the report, because a site that
  // did not load reads exactly like a site that does not exist — and that difference decides whether
  // a foreign link is a typo to fix or a link to remove.
  const infos: NsDomainInfo[] = [];
  const siteReadFailures: string[] = [];
  for (const domain of domains) {
    let sites: string[] = [];
    try {
      const raw = await ns.get(`/domains/${encodeURIComponent(domain)}/sites`);
      sites = (Array.isArray(raw) ? raw : []).map((s: any) => String(s?.site ?? '').trim()).filter(Boolean);
    } catch {
      siteReadFailures.push(domain);
    }
    infos.push({ domain, sites });
  }

  const source = opts.readSource ?? makeReadClient(env, cache);
  // Every status, not the search endpoint's active-only default: a closed account still holds links,
  // and one that vanished from the report would read as an unlinked domain waiting to be claimed.
  const subs = await source.listAllSubscribers({ statuses: SUBSCRIBER_STATUSES });
  const accounts: AccountRef[] = subs.map((s) => ({
    accountNumber: s.accountNumber,
    ...(s.accountName ? { accountName: s.accountName } : {}),
    status: s.accountStatus ?? 'Unknown',
  }));

  // Preflight: is the group this deployment maps links onto actually declared in OneBill? See
  // groupSetup — any Active account's full record answers this, whether or not it has values in it
  // yet. Judged against the FIRST Active account in list order, so the answer is deterministic
  // regardless of pooled/concurrent reads underneath.
  const firstActive = accounts.find((a) => a.status === 'Active');
  let firstActiveRecord: Subscriber | undefined;

  let inputs: CachedInputs;
  const spec = cfg.mapping[0]!;
  const unknownSetup: SetupCheck = { ok: true, missing: [], group: spec.group, valueField: spec.valueField, ...(spec.qualifierField ? { qualifierField: spec.qualifierField } : {}) };
  if (mode === 'full') {
    // ONE subscriber walk per report, not two. `gatherUsageRows` lists the subscribers itself, and that
    // walk is several paged requests per status — so the list above is handed to it rather than repeated.
    // The wrapper answers `listAllSubscribers` from that same result whatever it is asked for, which is
    // safe only because the statuses passed below are the ones it was read with; keep them in step.
    const shared: UsageReadSource = {
      listAllSubscribers: async () => subs,
      // linkSource 'group' (the default below) reads every account's full record anyway — capturing the
      // first Active one here is free: no extra request, just remembering what already went by.
      getSubscriber: async (n) => {
        const rec = await source.getSubscriber(n);
        if (firstActive && n === firstActive.accountNumber && !firstActiveRecord) firstActiveRecord = rec;
        return rec;
      },
      getSubscriptions: (n) => source.getSubscriptions(n),
    };
    // linkSource defaults to 'group' — the custom-field group is the truth here, and reading the derived
    // externalId instead could not detect that the index disagrees with it. That is the whole point of
    // this mode; the quick one reads the index deliberately and says so on the page.
    const gather = await gatherUsageRows(shared, { ns: cfg.ns, mapping: cfg.mapping, statuses: SUBSCRIBER_STATUSES, concurrency: 8 });
    inputs = {
      mode, infos, accounts, siteReadFailures,
      rows: gather.rows,
      failures: gather.failures.map((f) => ({ accountNumber: f.accountNumber, message: errText(f.error) })),
      requestCount: gather.requestCount,
      retried: gather.retried ?? 0,
      setup: unknownSetup,
    };
  } else {
    inputs = {
      mode, infos, accounts, siteReadFailures,
      ...(await quickRows(source, subs, cfg)),
      ...(await readOverlay(cache, scope, hex) ?? {}),
      setup: unknownSetup,
    };
    // The quick sweep reads a full record only for split-domain accounts (see quickRows), so the setup
    // check pays for one extra `getSubscriber` here — cheap next to the paged subscriber walk above.
    if (firstActive) {
      try {
        firstActiveRecord = await source.getSubscriber(firstActive.accountNumber);
        inputs.requestCount++;
      } catch {
        // Left undefined: a transient read failure here should not paint a working deployment as
        // unconfigured, so it falls through to `unknownSetup` (ok:true) below, same as "no Active
        // account to check at all".
      }
    }
  }
  inputs.setup = firstActiveRecord ? groupSetup(firstActiveRecord, spec) : unknownSetup;

  const loaded = assembleReport(inputs, cfg, { hidden: opts.hidden, now: opts.now });
  await putEntry(cache, k, { report: loaded.report, bounds: encodeBounds(loaded.bounds), inputs } satisfies CachedEntry, REPORT_TTL_S);
  // A full pass is the only thing that ever verifies usage, so it is the only thing that writes the
  // overlay a quick view reads. Written from the report the CALLER sees, so nothing hidden is stored
  // for a later pass to render.
  if (mode === 'full') {
    const overlay: UsageOverlay = {
      usage: loaded.report.usage,
      decommissionFromSubs: inputs.rows.map((r) => [r.accountNumber, r.subscriptions.map((s) => String(s.subscriptionIdentifier ?? '')).filter(Boolean)] as [string, string[]]),
      verifiedAt: loaded.report.generatedAt,
    };
    await putEntry(cache, entryKey(scope, 'usage', hex), overlay, USAGE_TTL_S);
  }
  return loaded;
}

/** The last full pass's usage verdicts, if one is still cached. A malformed entry is simply absent. */
async function readOverlay(cache: Cache, scope: string, hex: string): Promise<{ overlay: UsageOverlay } | null> {
  const hit = await cache.match(entryKey(scope, 'usage', hex));
  if (!hit) return null;
  const v = (await hit.json().catch(() => null)) as Partial<UsageOverlay> | null;
  if (!v || !Array.isArray(v.usage) || !Array.isArray(v.decommissionFromSubs) || typeof v.verifiedAt !== 'string') return null;
  return { overlay: { usage: v.usage, decommissionFromSubs: v.decommissionFromSubs, verifiedAt: v.verifiedAt } };
}

export interface ApplyOp {
  accountNumber: string;
  links: { domain: string; site?: string }[];
  /** Make the account's links MATCH `links` — deleting the ones not listed. Off ⇒ add and update only. */
  removeUnlisted?: boolean;
}

export interface ApplyOutcome {
  accountNumber: string;
  ok: boolean;
  created?: number;
  updated?: number;
  unchanged?: number;
  removed?: number;
  /**
   * Links left on the record that this op did not ask for. Non-zero means the account does NOT match
   * what was sent — the library documents this as the thing to check before believing it does.
   */
  notRemoved?: number;
  /** Requested links this deployment's mapping does not cover. Non-zero means part of the op did nothing. */
  unmapped?: number;
  externalId?: string;
  /** Unrelated fields the server moved. A note — the write succeeded. */
  collateral?: string[];
  error?: string;
}

/** The op cap. A page action is a handful of accounts; anything near this is a bulk job, not a click. */
const MAX_OPS = 50;

export interface ApplyLinksOptions {
  /** Injected for tests; production builds one from `env`. */
  writer?: OnebillLinkWriter;
  /**
   * Reads each account's FULL record before validating, so the bounds a write is held to are the
   * record's own group and not a report's derived view of it. Injected for tests; production passes
   * the read client.
   */
  reader?: Pick<UsageReadSource, 'getSubscriber'>;
  /**
   * See {@link BuildLinkReportOptions.hidden}. Without it a hidden link on a freshly-read record is
   * indistinguishable from an ordinary one, and `restricted` falls back to what the report said.
   */
  hidden?: (value: string) => boolean;
  /**
   * See {@link LinkReport.setup}. Absent ⇒ the check is skipped (older callers, and tests that do not
   * exercise it); a caller loading a report first — which is every production route — always has one
   * to pass.
   */
  setup?: SetupCheck;
}

/** What an op looks like once validated: normalised, and safe to write from without re-parsing. */
interface CheckedOp {
  accountNumber: string;
  links: Link[];
  removeUnlisted: boolean;
}

/**
 * The bounds an apply request is held to, both derived server-side from the report the SAME request
 * loaded. Passed as one object rather than two positional `Set<string>`s, which would be silently
 * swappable at the call site.
 */
export interface ApplyBounds {
  /** `targetKey(domain, site)` for every NS target the caller can see. */
  targets: Set<string>;
  /** Account numbers the caller's report can NAME: its Active picker list, plus every foreign row's. */
  accounts: Set<string>;
  /**
   * Accounts carrying at least one link this deployment hides from the caller (see
   * {@link BuildLinkReportOptions.hidden}).
   *
   * `removeUnlisted` is refused on these. Removal is "make the record match this list", the list is
   * built from what the PAGE shows, and the page is not shown the hidden links — so an otherwise
   * ordinary Remove would delete a link to a domain the caller was never allowed to see, silently.
   */
  restricted: Set<string>;
  /**
   * Per account, the targets ALREADY on its record as the caller's report shows them.
   *
   * ⚠️ WITHOUT THIS, REMOVING A FOREIGN LINK IS IMPOSSIBLE. Removal is expressed as "make the record
   * match this list", so removing one of an account's two foreign links means SENDING the other one —
   * and the other one is foreign by definition, so a targets-only check refuses the whole batch. The
   * page then offers a Remove button that can never work.
   *
   * It is not a hole in `targets`: this admits a link the caller can already SEE on that account in
   * that report, to that account only, and grants nothing about a target the caller cannot see
   * otherwise. Built server-side from the report, never from the body — the body's claim about what is
   * already on a record is exactly the thing that must not be trusted.
   */
  existing: Map<string, Set<string>>;
}

/**
 * Apply link writes, one account at a time.
 *
 * `bounds` comes from the caller's OWN report, never from the request body, and both halves matter:
 *
 * - **`targets`** stops a domain the caller cannot see from being written. A typo'd or invented
 *   domain is refused rather than laundered into OneBill through this page.
 * - **`accounts`** stops an account the caller's report cannot NAME from being TOUCHED. Without it, an
 *   op with an empty `links` array and `removeUnlisted` passes every target check vacuously — there
 *   are no targets to check — and clears every link on any account number the caller cares to name.
 *   The destructive op is the one with nothing in it, which is exactly the shape a target-only guard
 *   cannot see.
 * - **`restricted`** stops that same matching write on an account whose record holds links this
 *   deployment hides from the caller: the list they would match it to is missing those links, so the
 *   write would delete them without either side ever naming them.
 *
 * A failed op does not stop the ones after it, and its error carries OneBill's own message verbatim:
 * this API reports failures in-band at HTTP 200 and has produced two distinct ones already (a payInfo
 * echo, a contact echo), each identifiable only by what the server said.
 */
export async function applyLinks(
  env: OnebillEnv,
  cache: Cache,
  ops: ApplyOp[],
  bounds: ApplyBounds,
  opts: ApplyLinksOptions = {},
): Promise<ApplyOutcome[]> {
  const cfg = resolveOnebillConfig(env);
  // Refuse the WHOLE batch before any read or write — a page rendering the setup card offers no
  // controls to click, but a stale tab or a hand-built request could still reach this route.
  if (opts.setup && !opts.setup.ok) {
    throw new OnebillRequestError(`${ONEBILL_SETUP_TITLE}: ${setupChecklist(opts.setup)}`);
  }
  if (!Array.isArray(ops)) throw new OnebillRequestError('Body must be { ops: [...] }');
  if (ops.length > MAX_OPS) throw new OnebillRequestError(`At most ${MAX_OPS} accounts per request; got ${ops.length}.`);

  // ── PASS ONE: which accounts may be touched at all ──────────────────────────────────────────────
  // Before any read, because reading an account number the caller cannot name is itself something this
  // route should not do on request — and because the destructive op is the one with nothing in it.
  const batch: string[] = [];
  for (const op of ops) {
    const accountNumber = String(op?.accountNumber ?? '').trim();
    if (!accountNumber) throw new OnebillRequestError('Every op needs an accountNumber.');
    if (!bounds.accounts.has(accountNumber)) {
      throw new OnebillRequestError(`"${accountNumber}" is not an account this page lists; refusing to touch it.`);
    }
    if (!batch.includes(accountNumber)) batch.push(accountNumber);
  }

  // ── PASS TWO: the bounds that decide what may be WRITTEN come from the record, now ───────────────
  // One `getSubscriber` per distinct account, and the GROUP it returns — never the report's links and
  // never the derived index. The report may be a quick view built from `externalId`, which is a derived
  // copy that can be stale or hand-edited; a matching write measured against it would delete whatever
  // the index forgot. `existing` is REPLACED per account (it is a fact about that record), `restricted`
  // is a UNION with what the report already said (a fail-safe never gets weaker from a fresher read).
  const reader = opts.reader ?? makeReadClient(env, cache);
  const isHidden = opts.hidden ?? ((): boolean => false);
  const existing = new Map(bounds.existing);
  const restricted = new Set(bounds.restricted);
  for (const accountNumber of batch) {
    let record: Subscriber;
    try {
      record = await reader.getSubscriber(accountNumber);
    } catch (e) {
      // Fail closed and fail WHOLE: without the record there are no bounds for this account, and a
      // half-written batch is worse than a refused one.
      throw new OnebillRequestError(`Could not read OneBill account ${accountNumber} before writing, so nothing was written: ${errText(e)}`);
    }
    const links = attributesToLinks(record, cfg.mapping).filter((l) => l.ns === cfg.ns);
    // ⚠️ AN ACCOUNT WHOSE EVERY LINK IS HIDDEN IS NOT THIS CALLER'S TO TOUCH — the record's rule, not
    // the report's. `buildLinkReport` drops such an account from the picker (`allHidden`), so a FULL
    // report never names it and `bounds.accounts` refuses it. A quick report is built from the derived
    // index, which for that same account can be empty or stale — and an account with no links reads as
    // an ordinary unlinked one, so it stays in the picker and passes pass one. The fresh record is the
    // only thing that can tell, so it says so here, in the same words the report-derived refusal uses:
    // naming the rule differently would tell the caller which of the two checks they tripped.
    if (links.length && links.every((l) => isHidden(l.value))) {
      throw new OnebillRequestError(`"${accountNumber}" is not an account this page lists; refusing to touch it.`);
    }
    existing.set(accountNumber, new Set(links.map((l) => targetKey(l.value, l.qualifier))));
    if (links.some((l) => isHidden(l.value))) restricted.add(accountNumber);
  }
  bounds = { targets: bounds.targets, accounts: bounds.accounts, existing, restricted };

  // Validate EVERY op first, and keep what validation produced. A batch that is half-refused after
  // writing its first half is worse than one refused whole: the operator cannot tell from the page
  // which half landed. Normalising here and writing from the result is also the only way the value
  // that was CHECKED is guaranteed to be the value that is WRITTEN — re-deriving `site` in the write
  // loop let a `0` or a `false` validate as one target and write another.
  const checked: CheckedOp[] = [];
  for (const op of ops) {
    const accountNumber = String(op?.accountNumber ?? '').trim();
    if (!accountNumber) throw new OnebillRequestError('Every op needs an accountNumber.');
    if (!bounds.accounts.has(accountNumber)) {
      throw new OnebillRequestError(`"${accountNumber}" is not an account this page lists; refusing to touch it.`);
    }
    // Before the link loop, because the destructive op is the one with nothing in it: an empty `links`
    // plus `removeUnlisted` has no target to check and would clear the hidden links along with the rest.
    if (op?.removeUnlisted === true && bounds.restricted.has(accountNumber)) {
      throw new OnebillRequestError(`removeUnlisted is refused on an account that carries links outside this deployment's visible domains; remove them in OneBill. (${accountNumber})`);
    }
    if (!Array.isArray(op.links)) throw new OnebillRequestError(`Op for ${accountNumber} needs a links array.`);
    const links: Link[] = [];
    for (const l of op.links) {
      const value = String(l?.domain ?? '').trim();
      if (!value) throw new OnebillRequestError(`Op for ${accountNumber} has a link with no domain.`);
      // Only undefined and the empty string mean "no site". Anything else is stringified and trimmed
      // ONCE, here, so the validated key and the written qualifier cannot disagree.
      const raw = l?.site === undefined ? '' : String(l.site).trim();
      const qualifier = raw === '' ? undefined : raw;
      const k = targetKey(value, qualifier);
      // Visible to the caller, OR already on THIS account's record in the report they just loaded. The
      // second clause is per account: it never lets one account's record vouch for another's.
      if (!bounds.targets.has(k) && !bounds.existing.get(accountNumber)?.has(k)) {
        throw new OnebillRequestError(`"${k}" is not a NetSapiens target you can see, and is not already on ${accountNumber}; refusing to write it.`);
      }
      links.push({ ns: cfg.ns, value, ...(qualifier ? { qualifier } : {}) });
    }
    checked.push({ accountNumber, links, removeUnlisted: op.removeUnlisted === true });
  }

  const writer = opts.writer ?? makeWriteClient(env, cache);
  const results: ApplyOutcome[] = [];
  for (const op of checked) {
    try {
      const r = await writer.setSubscriberLinks(op.accountNumber, op.links, cfg.mapping, { removeUnlisted: op.removeUnlisted });
      results.push({
        accountNumber: op.accountNumber, ok: true,
        created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length, removed: r.removed.length,
        // Both are "the record does not match what you sent" signals, and both are silent unless said:
        // links left behind because nothing asked to remove them, and links no mapping covers.
        notRemoved: r.notRemoved.length, unmapped: r.unmapped.length,
        externalId: r.externalId,
        // Server-side reordering of an address or contact array, not data loss — a note, never a failure.
        ...(r.collateral.length ? { collateral: [...r.collateral] } : {}),
      });
    } catch (e) {
      // VERBATIM, and do not shorten it. `OneBillApiError.message` already carries the method, the path
      // and the server's own detail — including the in-band `status: <code>: <messages>` this API
      // reports failures with at HTTP 200. Two such traps have shipped already (a payInfo echo, a
      // contact echo); assume a third, and that this string is the only thing that will name it.
      results.push({ accountNumber: op.accountNumber, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // The caches are NOT dropped here. Throwing away a report that is right about 150 accounts because
  // one of them changed makes the next page load pay for a whole sweep — which is the eight to twelve
  // seconds this design exists to remove. The route re-reads the written accounts instead and patches
  // the cached entries; see `refreshAppliedAccounts`.
  return results;
}

/**
 * Every target the caller may write, derived from the report THEY just loaded: each domain, plus each
 * of its NS sites. The apply route builds its allowed set from this and never from the request body —
 * a domain the caller cannot see is a domain they cannot write.
 */
export function allowedTargets(report: LinkReport): Set<string> {
  const out = new Set<string>();
  for (const r of report.rows) {
    out.add(targetKey(r.domain));
    for (const s of r.sites) out.add(targetKey(r.domain, s));
  }
  return out;
}

/**
 * Every account the caller may touch: the ACTIVE ones their report can name — its picker list, plus the
 * account on any foreign row, which is how a stale link gets removed at all. An account the page cannot
 * name is one the caller has no way to have meant, so an op naming it is refused before any write, and
 * that (not the target list) is what stops an empty `removeUnlisted` op from clearing an arbitrary
 * account. A CLOSED account is excluded even when a foreign row names it: the page never draws Remove
 * on a closed row, so nothing legitimate is lost, and refusing here — before a write client is built —
 * beats relying on the library's in-band `allowNonActive` refusal after the request is on the wire.
 */
export function allowedAccounts(report: LinkReport): Set<string> {
  return new Set([
    ...report.accounts.map((a) => a.accountNumber),
    ...report.foreign.filter((f) => f.account.status === 'Active').map((f) => f.account.accountNumber),
  ]);
}

/**
 * What each account already holds, per {@link ApplyBounds.existing}. Both halves of the report
 * contribute, because a link can appear in either: `foreign[]` carries the account's whole link list
 * (which is what a removal has to send back), and a `rows[]` entry is itself a link between that target
 * and each account claiming it.
 */
export function existingLinks(report: LinkReport): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (account: string, k: string): void => {
    const set = out.get(account) ?? new Set<string>();
    set.add(k);
    out.set(account, set);
  };
  for (const f of report.foreign) for (const l of f.links) add(f.account.accountNumber, targetKey(l.domain, l.site));
  for (const r of report.rows) for (const a of r.accounts) add(a.accountNumber, targetKey(r.domain, r.site));
  return out;
}

/**
 * The whole bound set for one report, in one call. The route builds it from the report IT loaded; a
 * caller assembling the four pieces by hand is a caller who can forget one, and the one most easily
 * forgotten is the one that decides whether a removal is possible at all.
 *
 * `full` is the SAME join computed with nothing hidden — the Worker's own view. Passing it is what
 * lets the bounds know about links the page was not shown: `existing` comes from it (so a write is
 * measured against the record as it really is), and `restricted` is exactly the accounts the two
 * disagree about. Omit it and there is nothing hidden to compare, so nothing is restricted.
 */
export function applyBounds(report: LinkReport, full: LinkReport = report): ApplyBounds {
  const shown = existingLinks(report);
  const existing = existingLinks(full);
  const restricted = new Set<string>();
  for (const [account, keys] of existing) {
    const visible = shown.get(account);
    for (const k of keys) {
      if (!visible?.has(k)) { restricted.add(account); break; }
    }
  }
  return { targets: allowedTargets(report), accounts: allowedAccounts(report), existing, restricted };
}

// ─────────────────────────────────────────────────────────────────────────────
// After a write: re-read only what changed, and patch the cached reports in place.
// ─────────────────────────────────────────────────────────────────────────────

/** What the caller re-read about one account. Exactly a gather row: the same thing a sweep produces. */
export type FreshAccountRow = UsageReconcileRow;

export interface PatchReportOptions {
  /** See {@link BuildLinkReportOptions.hidden}. The same predicate the entry was built with. */
  hidden?: (value: string) => boolean;
  /** Requests the re-read cost, added to the entry's own count so the header stays honest. */
  reads?: number;
  /** Per-account reads the re-read retried, added to the entry's own count. */
  retried?: number;
  /**
   * Replace the entry's usage overlay with this one — used when a FULL entry has just been patched in
   * the same breath and a fresher overlay has been derived from it. Without it a quick entry is
   * rebuilt from the overlay it was cached with, so the page's post-apply reload (a cache HIT of that
   * quick entry) would show the very verdict the write just resolved, for the rest of the TTL.
   */
  overlay?: UsageOverlay;
}

/**
 * Replace `accountNumbers`' rows in a cached entry with freshly-read ones and rebuild the report.
 *
 * PURE — no I/O, no clock: `generatedAt` is preserved from the entry being patched, because the sweep
 * still ran then and only these accounts are newer than that. Every other account's rows are carried
 * over in their original ORDER as well as their original content, so a patched report differs from the
 * one it replaces in exactly the accounts that were written and nowhere else.
 *
 * An account with no fresh row (a read that came back with nothing) is DROPPED rather than left
 * standing: its links are the one thing the write just changed, so keeping the old ones would render
 * the state the operator was trying to leave.
 */
export function patchReportAccounts(
  entry: { report: LinkReport; inputs: CachedInputs },
  accountNumbers: string[],
  freshRows: FreshAccountRow[],
  cfg: OnebillConfig,
  opts: PatchReportOptions = {},
): CachedEntry {
  const target = new Set(accountNumbers);
  const fresh = new Map(freshRows.map((r) => [r.accountNumber, r]));
  const quick = entry.inputs.mode === 'quick';
  // A quick entry's rows carry no subscriptions BY CONSTRUCTION — its usage comes from the overlay, and
  // a row that suddenly had subscriptions would make one account's verdicts computed differently from
  // every other account in the same report.
  const shape = (r: FreshAccountRow): UsageReconcileRow => (quick ? { ...r, subscriptions: [] } : r);

  const rows: UsageReconcileRow[] = [];
  for (const r of entry.inputs.rows) {
    if (!target.has(r.accountNumber)) { rows.push(r); continue; }
    const f = fresh.get(r.accountNumber);
    if (f) rows.push(shape(f));
  }
  for (const n of accountNumbers) {
    if (entry.inputs.rows.some((r) => r.accountNumber === n)) continue;
    const f = fresh.get(n);
    if (f) rows.push(shape(f));
  }

  // The subscription half of the decommission callout, for a quick entry, lives in the overlay — so a
  // re-read that saw this account's subscriptions updates it there rather than in the row.
  let overlay = opts.overlay ?? entry.inputs.overlay;
  if (quick && overlay) {
    const m = new Map(overlay.decommissionFromSubs);
    for (const n of accountNumbers) {
      const f = fresh.get(n);
      if (f) m.set(n, f.subscriptions.map((s) => String(s.subscriptionIdentifier ?? '')).filter(Boolean));
    }
    overlay = { ...overlay, decommissionFromSubs: [...m] };
  }

  const inputs: CachedInputs = {
    ...entry.inputs,
    rows,
    // A read that just succeeded resolves the failure the last pass recorded for that account.
    failures: entry.inputs.failures.filter((f) => !target.has(f.accountNumber)),
    requestCount: entry.inputs.requestCount + (opts.reads ?? 0),
    retried: entry.inputs.retried + (opts.retried ?? 0),
    ...(overlay ? { overlay } : {}),
  };
  const loaded = assembleReport(inputs, cfg, { hidden: opts.hidden, now: new Date(entry.report.generatedAt) });
  return { report: loaded.report, bounds: encodeBounds(loaded.bounds), inputs };
}

export interface RefreshAppliedOptions {
  /** Injected for tests; production passes `makeReadClient(env, cache)`. */
  readSource?: Pick<UsageReadSource, 'getSubscriber' | 'getSubscriptions'>;
  /** See {@link BuildLinkReportOptions.hidden}. The same predicate the route loaded the report with. */
  hidden?: (value: string) => boolean;
}

/**
 * OneBill's answer for an account holding no subscriptions is an in-band failure at HTTP 200 carrying
 * validation code `10WS0001`, not an empty list — the same trap `gatherUsageRows` maps internally. The
 * predicate is not exported by the library, so this is the one place it is repeated; it is safe here
 * for the same reason it is safe there, namely that the account came from a write we just made and so
 * certainly exists. Anything else that failed is a real failure and abandons the patch.
 */
function isNoSubscriptions(e: unknown): boolean {
  const body = (e as { body?: { validationResponse?: { validationErrorInfo?: unknown } } } | null)?.body;
  const info = body?.validationResponse?.validationErrorInfo;
  return Array.isArray(info) && info.some((x) => (x as { code?: unknown })?.code === '10WS0001');
}

/**
 * Re-read the accounts a write just changed and patch the cached quick and full reports with them.
 *
 * Two reads per account, against a report that cost a whole sweep — which is the point: after an apply
 * the page reloads from the cache and sees what it just did, instead of paying for the sweep again.
 * Whichever of the two entries exist are patched; neither existing is fine and means nothing to fix.
 *
 * If ANY read fails the entries are DELETED rather than left half-right: a cached report that does not
 * know about a write that happened is the one thing worse than a slow one.
 */
export async function refreshAppliedAccounts(
  env: OnebillEnv,
  cache: Cache,
  domains: string[],
  accountNumbers: string[],
  opts: RefreshAppliedOptions = {},
): Promise<void> {
  if (!accountNumbers.length) return;
  const cfg = resolveOnebillConfig(env);
  const scope = scopeOf(env);
  const hex = await domainHash(domains);
  const keys = [entryKey(scope, 'quick', hex), entryKey(scope, 'full', hex)];

  const source = opts.readSource ?? makeReadClient(env, cache);
  const fresh: FreshAccountRow[] = [];
  let reads = 0;
  try {
    for (const accountNumber of accountNumbers) {
      reads++;
      const record = await source.getSubscriber(accountNumber);
      reads++;
      let subscriptions: Subscription[] = [];
      try {
        subscriptions = await source.getSubscriptions(accountNumber);
      } catch (e) {
        if (!isNoSubscriptions(e)) throw e;
      }
      fresh.push({
        accountNumber,
        ...(record.accountName === undefined ? {} : { accountName: record.accountName }),
        links: attributesToLinks(record, cfg.mapping).filter((l) => l.ns === cfg.ns),
        subscriptions,
      });
    }
  } catch {
    // Guarded exactly like the patch phase below, and for the same reason: this runs AFTER a write that
    // already happened, so a `caches.default` that refuses a delete must not turn a completed apply
    // into a 500 the page reports as "the apply did not run".
    for (const k of keys) { try { await cache.delete(k); } catch { /* nothing left to do about it */ } }
    return;
  }

  try {
    // ⚠️ THE FULL ENTRY IS PATCHED FIRST, and the order is load-bearing. The overlay a quick view shows
    // is derived from the full entry, and the quick entry is REBUILT from that overlay — so patching
    // quick first bakes the pre-write verdicts into the very entry the page is about to read back. The
    // page's post-apply reload is a cache hit by design, and it would spend the rest of the TTL showing
    // the usage problem the write just fixed.
    let overlay: UsageOverlay | undefined;
    const fullEntry = await readEntry(cache, entryKey(scope, 'full', hex));
    if (fullEntry) {
      const patched = patchReportAccounts(fullEntry, accountNumbers, fresh, cfg, { hidden: opts.hidden, reads });
      await putEntry(cache, entryKey(scope, 'full', hex), patched, REPORT_TTL_S);
      // `verifiedAt` does NOT move: one account was re-read, nothing was re-verified, and advancing it
      // would age-launder the whole overlay.
      const prior = fullEntry.inputs.overlay?.verifiedAt ?? patched.report.verifiedAt;
      if (prior) {
        overlay = {
          usage: patched.report.usage,
          decommissionFromSubs: patched.inputs.rows.map((r) => [r.accountNumber, r.subscriptions.map((x) => String(x.subscriptionIdentifier ?? '')).filter(Boolean)] as [string, string[]]),
          verifiedAt: prior,
        };
        await putEntry(cache, entryKey(scope, 'usage', hex), overlay, USAGE_TTL_S);
      }
    }

    const quickEntry = await readEntry(cache, entryKey(scope, 'quick', hex));
    if (quickEntry) {
      const patched = patchReportAccounts(quickEntry, accountNumbers, fresh, cfg, { hidden: opts.hidden, reads, ...(overlay ? { overlay } : {}) });
      await putEntry(cache, entryKey(scope, 'quick', hex), patched, REPORT_TTL_S);
    }
  } catch {
    // A PATCH THAT FAILS MUST NOT FAIL THE WRITE. The write already happened; the caller's job now is
    // to report it, and a throw here would surface as "the apply did not run" over a write that did.
    // Drop the entries so the next load re-reads, and swallow even that — a cache we cannot delete is
    // still only stale for the TTL, while a thrown error here is a lie about what changed upstream.
    for (const k of keys) { try { await cache.delete(k); } catch { /* nothing left to do about it */ } }
  }
}
