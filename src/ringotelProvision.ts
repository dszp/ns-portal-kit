/**
 * Ringotel provisioning — the pure half. Config, the domain rail, the org label rule, the connector diff,
 * the per-domain checklist planner and the fleet row state. No I/O: everything here takes already-read
 * values and returns verdicts, so the worker route and the tests drive the same functions.
 *
 * Spec: docs/superpowers/specs/2026-09-14-ringotel-integration-page-design.md
 */
import { parseDomainRail, type DomainRail } from './nsEvents.js';

export interface ProvisionEnv {
  RINGOTEL_API_KEY?: string;
  RINGOTEL_PROVISION_DOMAINS?: string;
  RINGOTEL_CONNECTION_TEMPLATE?: string;
  RINGOTEL_SSO_SERVICE_ID?: string;
  RINGOTEL_DEFAULT_PACKAGE?: string;
  RINGOTEL_REGION?: string;
  RINGOTEL_LABEL?: string;
}
export class ProvisionConfigError extends Error { constructor(m: string) { super(m); this.name = 'ProvisionConfigError'; } }
export interface ProvisionConfig {
  rail: DomainRail | null;          // null ⇒ write surface inert
  templateName: string;             // required when the page is enabled
  ssoServiceId: string | null;      // null ⇒ operator does no Ringotel SSO
  defaultPackage: string;           // package NAME
  region: string;                   // region NAME
  connectionName: string;           // RINGOTEL_LABEL or 'Ringotel' — the NAME a created connection gets
  /** The same string, under the name the PROSE uses it by. One value, two jobs: `connectionName` is
   *  written into Ringotel as a connection's name, `appLabel` is the operator's word for the app in
   *  every sentence this module produces. They are assigned from one expression in
   *  `resolveProvisionConfig`, so they cannot desync; they are two names because a deployment that one
   *  day wants its connections named something other than its app would change one and not the other. */
  appLabel: string;
}

export function provisionEnabled(env: ProvisionEnv): boolean {
  return !!(env.RINGOTEL_API_KEY && (env.RINGOTEL_CONNECTION_TEMPLATE ?? '').trim());
}

/** What this operator calls the app: `RINGOTEL_LABEL`, or "Ringotel" when they have not said.
 *
 *  Exported because the route needs it BEFORE `resolveProvisionConfig` has run — every refusal in that
 *  gate chain is produced first, and one of them IS the refusal that the config would not resolve. One
 *  reading of the setting, used there and to fill `appLabel` below, so a deployment's name for the app
 *  and the name its errors speak cannot disagree. */
export function provisionLabel(env: ProvisionEnv): string {
  return (env.RINGOTEL_LABEL ?? '').trim() || 'Ringotel';
}

const need = (v: string | undefined, name: string): string => {
  const t = (v ?? '').trim();
  if (!t) throw new ProvisionConfigError(`${name} is required`);
  return t;
};

export function resolveProvisionConfig(env: ProvisionEnv): ProvisionConfig {
  const rawRail = (env.RINGOTEL_PROVISION_DOMAINS ?? '').trim();
  let rail: DomainRail | null = null;
  if (rawRail) {
    const r = parseDomainRail(rawRail, 'RINGOTEL_PROVISION_DOMAINS');
    if (!r.ok) throw new ProvisionConfigError(r.message);
    rail = r.rail;
  }
  const sso = (env.RINGOTEL_SSO_SERVICE_ID ?? '').trim();
  const appLabel = provisionLabel(env);
  return {
    rail,
    templateName: need(env.RINGOTEL_CONNECTION_TEMPLATE, 'RINGOTEL_CONNECTION_TEMPLATE'),
    ssoServiceId: sso || null,
    defaultPackage: need(env.RINGOTEL_DEFAULT_PACKAGE, 'RINGOTEL_DEFAULT_PACKAGE'),
    region: need(env.RINGOTEL_REGION, 'RINGOTEL_REGION'),
    connectionName: appLabel,
    appLabel,
  };
}

export function railAdmits(rail: DomainRail | null, domain: string): boolean {
  if (!rail) return false;
  const d = domain.trim().toLowerCase();
  if (rail.wildcard) return !rail.except.includes(d);
  return rail.domains.includes(d);
}

/** The Ringotel org label: the NS domain with its `.<territory>.service` suffix removed, lowercased.
 *  A bare domain (no territory suffix) is its own label, dots and all — NS domains can be bare and can
 *  never be renamed, so the rule never guesses at a shorter form. */
export function deriveOrgLabel(nsDomain: string): string {
  return nsDomain.trim().toLowerCase().replace(/\.\d+\.service$/, '');
}

const LABEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
export function labelProblem(label: string, existingOrgDomains: string[], appLabel = 'Ringotel'): string | null {
  const l = label.trim().toLowerCase();
  if (!LABEL_RE.test(l)) return `The ${appLabel} domain name may only use letters, digits, dots and hyphens (1–64 characters).`;
  if (existingOrgDomains.some((d) => d.trim().toLowerCase() === l)) return `That ${appLabel} domain name is already taken by another organization.`;
  return null;
}

/** One compared field: JSON-rendered values on each side; null = absent; masked ⇒ '••••'. */
export interface DiffField { key: string; template: string | null; branch: string | null }
export interface DiffGroup { section: string; fields: DiffField[] }
export interface ConnectorDiff { matches: boolean; groups: DiffGroup[]; compared: number }

/** Fields the connector diff never compares — the template's own domain identity, not connector config. */
export const DIFF_EXCLUDED_KEYS = ['address', 'domain', 'name'] as const;
/**
 * Whether a field's value renders as '••••' on both sides — matched on the LAST path segment.
 *
 * ⚠️ A DENYLIST OF THREE KEYS WAS THE WRONG SHAPE. `provision.proxy.ppass`, `provision.proxy.pauth` and
 * `provision.authpass` were the secrets this connector blob was known to carry on the day the diff was
 * written, and the blob belongs to a vendor who is free to add a fourth. Anything they add whose name
 * says "secret" would then render its value into this page in full, beside the template's copy of it.
 * A pattern fails the other way: an unknown key that merely LOOKS like a secret is masked, the row still
 * counts as a difference, and the operator loses two values rather than leaking one.
 *
 * On the LEAF, never the whole path: a secret is named by its own key (`ppass`), and testing the dotted
 * path would mask every field under a section that happened to be called `auth`.
 */
export const DIFF_MASK_RE = /pass|pwd|secret|token|auth|key/i;
/**
 * Leaf keys that match {@link DIFF_MASK_RE} and are NOT secrets, so they keep their values.
 *
 * One line each, because every entry is a decision that a value may be shown:
 *   - `authname` — the SIP auth USERNAME, not its password. It is an identity this kit already reads and
 *     renders on every user record, and hiding it would blank the one connector field that shows a
 *     mis-provisioned SIP identity.
 *   - `nochangepass` — a BOOLEAN flag (whether app users may change their own password), not a secret
 *     value at all. The value-type rule below (`diffConnector` masks only a non-empty STRING) already
 *     keeps a boolean from rendering as `••••` — this entry documents the flag as reviewed rather than
 *     relying on that as the only reason it's safe.
 *   - `passanumber` — same: a documented flag, not a secret, listed for the same reason.
 *
 * Nothing else is listed. A key nobody here has seen is masked until somebody has confirmed what it holds.
 */
export const DIFF_MASK_ALLOW = ['authname', 'nochangepass', 'passanumber'] as const;

/** Does this dotted key's LEAF match the secret pattern? Key only — whether a given VALUE at this key
 *  actually renders masked also depends on the value's type; see the note on `diffConnector`. */
export function maskedKey(key: string): boolean {
  const leaf = key.slice(key.lastIndexOf('.') + 1).trim().toLowerCase();
  return !DIFF_MASK_ALLOW.some((a) => a === leaf) && DIFF_MASK_RE.test(leaf);
}

/** Only a non-empty STRING is ever masked. `provision.nochangepass` — a BOOLEAN flag for whether app
 *  users may change their own password — matching {@link DIFF_MASK_RE} on its name and then rendering
 *  as `••••` was the live false positive that motivated this: a key that LOOKS like a secret is not one
 *  unless the value it holds could actually BE one. Booleans, numbers, arrays, null and '' never mask,
 *  regardless of the key. */
function isMaskableValue(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function flatten(o: unknown, prefix = '', out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) { if (prefix) out.set(prefix, o); return out; }
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out); else out.set(key, v);
  }
  return out;
}

/** Group a dotted key: the segment after `provision.` when present and at least that deep, else 'general'. */
const sectionOf = (key: string): string => {
  const parts = key.split('.');
  if (parts[0] === 'provision' && parts.length >= 3) return parts[1]!;
  return 'general';
};

/** Compare a domain's live Ringotel connector against the operator's connection template.
 *  Only `country` + `provision` are compared — connector identity fields (address/domain/name) never enter
 *  the flattened set, so DIFF_EXCLUDED_KEYS guards against a future field addition rather than doing the
 *  work here today. Only the fields the TEMPLATE DEFINES are compared: a key the branch carries and the
 *  template does not is never a difference, because the template has no opinion about it and Ringotel
 *  fills a new connector with server-side defaults nobody chose. A key the template defines and the branch
 *  lacks still is one. A field masks only when its key matches {@link DIFF_MASK_RE} (leaf, not allowlisted)
 *  AND the value on that side is a non-empty string ({@link isMaskableValue}) — decided independently per
 *  side, so a template string next to a branch boolean (or an absent branch value) masks only the string
 *  side. A masked side always renders '••••'; a masked field still counts as a difference (not a match)
 *  when the underlying values disagree. */
export function diffConnector(templateParams: Record<string, unknown>, branch: { address?: string; country?: string; name?: string; provision?: Record<string, unknown> }): ConnectorDiff {
  const t = flatten({ ...(templateParams.country !== undefined ? { country: templateParams.country } : {}), provision: templateParams.provision ?? {} });
  const b = flatten({ ...(branch.country !== undefined ? { country: branch.country } : {}), provision: branch.provision ?? {} });
  const excluded = new Set<string>(DIFF_EXCLUDED_KEYS);
  const bySection = new Map<string, DiffField[]>();
  let compared = 0;
  // ⚠️ THE TEMPLATE'S KEYS, AND ONLY THOSE. A template has an opinion about the fields it defines and no
  // opinion at all about the rest — Ringotel fills a created connector with server-side defaults the
  // template never carried (`provision.maxregs: 3` is the one that surfaced), and reporting those as
  // drift told an operator their brand-new connection already differed from the template it was made
  // from. This replaces a list of values that LOOKED like defaults ('', false, 0, [], null), which was
  // guessing at the same rule from the wrong end: a real default is whatever the server wrote, and the
  // honest test for "did the template ask for this" is whether the key is there.
  for (const key of t.keys()) {
    if (excluded.has(key)) continue;
    compared++;
    const inB = b.has(key);
    const rawT = t.get(key), rawB = inB ? b.get(key) : undefined;
    const tv = JSON.stringify(rawT) ?? null, bv = inB ? (JSON.stringify(rawB) ?? null) : null;
    if (tv === bv) continue;
    const keyMasks = maskedKey(key);
    // Each side decided independently: a boolean/number/array/null/'' value never masks even when the
    // key matches (a boolean is never a secret) — see `isMaskableValue`.
    const maskT = keyMasks && isMaskableValue(rawT);
    const maskB = keyMasks && inB && isMaskableValue(rawB);
    // A key the template defines and the branch lacks is still a difference: the template asked for it.
    const f: DiffField = { key, template: maskT ? '••••' : tv, branch: maskB ? '••••' : (inB ? bv : null) };
    const s = sectionOf(key);
    (bySection.get(s) ?? bySection.set(s, []).get(s)!).push(f);
  }
  const groups = [...bySection.entries()]
    .sort(([a], [c]) => a.localeCompare(c))
    .map(([section, fields]) => ({ section, fields: fields.sort((x, y) => x.key.localeCompare(y.key)) }));
  return { matches: groups.length === 0, groups, compared };
}

// ── The checklist ──────────────────────────────────────────────────────────────────────────────────
// One row per step, in the order Enable-all applies them. Every verdict is derived from values the
// caller already read, so the page, the POST handler and the tests reach the same conclusion from the
// same inputs — a planner that disagreed with `applyStep` would offer a button that does nothing.

export type Verdict = 'ok' | 'fix' | 'info' | 'blocked';
export type StepId = 'rail' | 'org' | 'label' | 'package' | 'signin' | 'connector' | 'index' | 'reconcile' | 'rails';
/** `fixable` means "the page may offer this fix right now" — not "this row is a fix". `diff` is present
 *  only on a drifting connector row, and its values are already masked by `diffConnector`. */
export interface ChecklistRow { step: StepId; verdict: Verdict; title: string; detail: string; fixable: boolean; diff?: ConnectorDiff }
/** RAW org fields as `getOrganizations` returns them — `params` carries Ringotel's own keys (`sso`,
 *  `hidePassInEmail`), never the lib's projected `OrgSettings`. The projection drops what these rules need. */
export interface OrgView { id: string; domain: string; packageid?: number; params?: Record<string, unknown> }
export interface BranchView { id: string; address?: string; country?: string; name?: string; provision?: Record<string, unknown> }
export interface ChecklistInput {
  domain: string;                      // NS domain
  cfg: ProvisionConfig;
  org: OrgView | null;                 // the org whose branch address is `domain` (fresh or cached — caller says)
  branches: BranchView[];              // that org's branches at this address
  template: { params: Record<string, unknown> } | null;
  packages: { id: number; name: string }[];
  inIndex: boolean;                    // cached index resolves the domain
  /**
   * `RINGOTEL_OVERRIDES` names a REPLACEMENT branch address for this domain.
   *
   * REQUIRED, not optional, and for the reason `prepopArmed`'s `prepopAutoExcept` is: an optional field
   * lets a hand-built input skip the guard silently — the block would look applied while doing nothing.
   *
   * ⚠️ WHY IT BLOCKS. Every create this page makes writes `address: <the NS domain>`, while matching goes
   * through the override — so a connection created here would never be the one the override points at,
   * and the checklist would go on offering the same create forever, one duplicate connection per press.
   * And the organization it points at may be serving other domains, which makes a `params` rewrite or a
   * directory reconcile driven from this domain a CROSS-DOMAIN write. Provisioning an overridden domain
   * is not supported; it is refused rather than half-done.
   */
  addressOverride: boolean;
  reconciled: boolean | null;          // null = unknown
  eventsCovered: boolean; prepopCovered: boolean; writeCovered: boolean;
  choice?: { pkg?: string; signin?: 'sso' | 'credentials'; label?: string };
}

export const STEP_ORDER = ['rail', 'org', 'label', 'package', 'signin', 'connector', 'index', 'reconcile', 'rails'] as const;

/** Steps that write to the Ringotel tenant or the NS directory. Off the rail a `fix` on one of these
 *  becomes `blocked`; the observation-only steps (label, package, index, rails) still report, because an
 *  operator looking at a domain the rail excludes is exactly the person who needs to see its findings.
 *  Refreshing the index is a cache invalidation of ours, not a write, so it stays offerable. */
const WRITING_STEPS: readonly StepId[] = ['org', 'signin', 'connector', 'reconcile'];

const row = (step: StepId, verdict: Verdict, title: string, detail: string, fixable = false): ChecklistRow => ({ step, verdict, title, detail, fixable });

/** Rendered in place of a writing step's own detail on an overridden domain — one sentence saying what is
 *  true of the deployment, not of the reader, exactly as `railDetail` does for the rail. */
const overrideDetail = (cfg: ProvisionConfig): string =>
  `RINGOTEL_OVERRIDES points this domain at a different ${cfg.appLabel} address, so this page cannot set it up. `
  + `Set it up in the ${cfg.appLabel} panel, or remove the override.`;

/** Written for the operator reading the page, not for the person who wrote the setting: the sentence
 *  opens with the state ("Integration is off") and ends with the one action that changes it. The two
 *  variants differ in what the reader can do — an unset rail is a deployment-wide fact, an excluding one
 *  is a list this domain can be added to. */
const railDetail = (cfg: ProvisionConfig): string =>
  cfg.rail === null
    ? 'Integration is off: RINGOTEL_PROVISION_DOMAINS is not set.'
    : 'Integration is off for this domain. Add it to RINGOTEL_PROVISION_DOMAINS to enable it.';

/** The label a create would use: the operator's edit when they made one, else the derivation. */
const chosenLabel = (i: ChecklistInput): string => (i.choice?.label ?? '').trim() || deriveOrgLabel(i.domain);

/** Collisions are checked at create time against a fresh `getOrganizations`, not here: the checklist input
 *  carries no roster of existing org domains, and a cached one would be exactly the wrong thing to refuse on. */
const labelIssue = (i: ChecklistInput): string | null => labelProblem(chosenLabel(i), [], i.cfg.appLabel);

const packageIdOf = (packages: { id: number; name: string }[], name: string): number | null =>
  packages.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())?.id ?? null;

/** Ringotel's `params.sso` absent and `''` are the same thing — no SSO — and the lib's `orgSettings`
 *  projection reads them the same way. Anything that is not a non-empty string is "no SSO". */
const ssoOf = (params: Record<string, unknown> | undefined): string | null => {
  const v = params?.sso;
  return typeof v === 'string' && v !== '' ? v : null;
};

/** The label comparison behind the `label` checklist row, the fleet's `label-mismatch` state and (Task 5)
 *  the create path's own check: case-insensitive, whitespace-tolerant, against the derived label. One
 *  reading, for the same reason `signinMatches` has one — a second copy drifts the first time either is
 *  edited, and a label this page calls matching must be a label it does not try to change. */
export function labelMatches(orgDomain: string | null | undefined, expected: string): boolean {
  return (orgDomain ?? '').trim().toLowerCase() === expected.trim().toLowerCase();
}

/** The one predicate behind the `signin` checklist row, the fleet's `signin-differs` state and
 *  `applyStep('signin')`'s noop check. Exported for exactly that reason: whatever the planner calls `ok`,
 *  apply must decline to rewrite, and three readings of one rule would drift.
 *
 *  ⚠️ IT JUDGES THE SSO SERVICE AND NOTHING ELSE. `hidePassInEmail` is a setting about WELCOME EMAILS, not
 *  about how anybody signs in, and folding it in here made a domain whose SSO was perfectly bound report
 *  "SSO mismatch" — a finding naming the wrong thing, offering a fix for something that was not broken.
 *  The two facts are reported separately now: this decides sign-in, and the row's detail says what the
 *  welcome-email setting is where that is relevant (see `stepSignin`). */
export function signinMatches(cfg: ProvisionConfig, params: Record<string, unknown> | undefined, mode: 'sso' | 'credentials'): boolean {
  if (cfg.ssoServiceId === null) return true;              // the operator does no Ringotel SSO: nothing to match
  return mode === 'sso' ? ssoOf(params) === cfg.ssoServiceId : ssoOf(params) === null;
}

/** WHICH of the facts `signinMatches` reads disagrees — no SSO service set, or a different one set.
 *
 *  Beside the predicate and reading the same value, deliberately: "the sign-in settings do not match"
 *  tells an operator nothing they can act on, and a sentence that named a cause the predicate did not
 *  actually object to would be worse than the vague one — which is exactly what the welcome-email clause
 *  used to do here. */
function signinProblems(cfg: ProvisionConfig, params: Record<string, unknown> | undefined, mode: 'sso' | 'credentials'): string[] {
  const out: string[] = [];
  const sso = ssoOf(params);
  if (mode === 'sso') {
    if (sso === null) out.push('no SSO service is set on the organization');
    else if (sso !== cfg.ssoServiceId) out.push('a different SSO service is set on the organization');
  } else if (sso !== null) out.push(`an SSO service is set, but this domain is set for ${cfg.appLabel} credentials`);
  return out;
}

/**
 * What this organization's welcome emails do with a new account's password — INFORMATIONAL, never a fix.
 *
 * `hidePassInEmail` only matters where a welcome email is actually sent, which is credentials sign-in (and
 * a deployment that manages no SSO at all, where we cannot know which it is). Under SSO the app never
 * emails a password, so saying anything about it there is noise dressed as a finding.
 *
 * With no organization yet, the create sets it true — so the sentence describes what WILL be true rather
 * than reporting a value read from nothing.
 */
const welcomeEmailNote = (org: OrgView | null): string =>
  (org ? org.params?.hidePassInEmail === true : true)
    ? 'Welcome emails for new activations hide the password behind a link.'
    : 'Welcome emails for new activations include the password.';

/** "a", "a and b", "a, b and c" — and the empty string for nothing, so a caller can append it safely. */
const listOf = (xs: string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]!}`;

/** The cause clause a sign-in finding carries: ": <causes>", or nothing at all when there are none. */
const signinWhy = (cfg: ProvisionConfig, params: Record<string, unknown> | undefined, mode: 'sso' | 'credentials'): string => {
  const p = signinProblems(cfg, params, mode);
  return p.length ? `: ${listOf(p)}` : '';
};

function stepRail(i: ChecklistInput): ChecklistRow {
  return railAdmits(i.cfg.rail, i.domain)
    ? row('rail', 'ok', 'Integration enabled for this domain', 'RINGOTEL_PROVISION_DOMAINS includes this domain, so the steps below can run.')
    : row('rail', 'blocked', 'Integration enabled for this domain', railDetail(i.cfg));
}

function stepOrg(i: ChecklistInput): ChecklistRow {
  if (i.org) return row('org', 'ok', 'Organization exists', `A ${i.cfg.appLabel} organization matches this domain.`);
  const problem = labelIssue(i);
  const why = i.template === null
    ? ` RINGOTEL_CONNECTION_TEMPLATE does not name exactly one connection template in ${i.cfg.appLabel}, so nothing can be created yet.`
    : problem ? ` The ${i.cfg.appLabel} domain name cannot be used: ${problem}` : '';
  const fixable = railAdmits(i.cfg.rail, i.domain) && i.template !== null && problem === null;
  return row('org', 'fix', 'Create the organization', `No ${i.cfg.appLabel} organization matches this domain yet.${why}`, fixable);
}

function stepLabel(i: ChecklistInput): ChecklistRow {
  const expected = deriveOrgLabel(i.domain);
  if (i.org) {
    const actual = i.org.domain.trim();
    return labelMatches(actual, expected)
      ? row('label', 'ok', `${i.cfg.appLabel} domain name`, `The ${i.cfg.appLabel} domain name matches the NetSapiens short domain: "${expected}".`)
      : row('label', 'info', `${i.cfg.appLabel} domain name`, `The ${i.cfg.appLabel} domain name "${actual}" is not the NetSapiens short domain "${expected}". ${i.cfg.appLabel} does not allow editing it yet, so this is a finding, not a fix.`);
  }
  const label = chosenLabel(i);
  const problem = labelIssue(i);
  return row('label', 'info', `${i.cfg.appLabel} domain name`, problem
    ? `The organization would be created with the ${i.cfg.appLabel} domain name "${label}", which cannot be used: ${problem}`
    : `The organization will be created with the ${i.cfg.appLabel} domain name "${label}".`);
}

function stepPackage(i: ChecklistInput): ChecklistRow {
  const chosen = (i.choice?.pkg ?? '').trim();
  const want = chosen || i.cfg.defaultPackage;
  const id = packageIdOf(i.packages, want);
  if (id === null) return row('package', 'blocked', 'Licensing package', chosen
    ? `"${want}" is not a licensing package this ${i.cfg.appLabel} account offers.`
    : `RINGOTEL_DEFAULT_PACKAGE names "${want}", which is not a licensing package this ${i.cfg.appLabel} account offers. Change that setting, or add the package in ${i.cfg.appLabel}.`);
  if (!i.org) return row('package', 'info', 'Licensing package', `The organization will be created on the "${want}" licensing package.`);
  return i.org.packageid === id
    ? row('package', 'ok', 'Licensing package', `The organization is on the "${want}" licensing package.`)
    // A live org's package is never rewritten from this page — Pro on a customer who bought Pro is a
    // deliberate choice, and an explicit `choice.pkg` does not make it a fix. It is set once, on create.
    : row('package', 'info', 'Licensing package', `The organization is on a licensing package other than "${want}". Licensing is set when the organization is created and is never changed from here — change it in the ${i.cfg.appLabel} panel.`);
}

function stepSignin(i: ChecklistInput): ChecklistRow {
  if (i.cfg.ssoServiceId === null) return row('signin', 'info', 'Sign-in mode', `RINGOTEL_SSO_SERVICE_ID is not set, so this deployment does not manage ${i.cfg.appLabel} sign-in. Users sign in however the organization is already set up. ${welcomeEmailNote(i.org)}`);
  const mode = i.choice?.signin ?? 'sso';
  const words = mode === 'sso' ? 'single sign-on' : `${i.cfg.appLabel} credentials`;
  // Appended in credentials mode only: under SSO the app never emails a password, so the welcome-email
  // setting says nothing about this domain and naming it would read as a finding about one.
  const email = mode === 'sso' ? '' : ` ${welcomeEmailNote(i.org)}`;
  if (!i.org) return row('signin', 'info', 'Sign-in mode', `The organization will be created for ${words}.${email}`);
  return signinMatches(i.cfg, i.org.params, mode)
    ? row('signin', 'ok', 'Sign-in mode', `The organization is set for ${words}.${email}`)
    : row('signin', 'fix', 'Set the sign-in mode', `The organization is not set for ${words}${signinWhy(i.cfg, i.org.params, mode)}. Fixing this sets the SSO service and leaves the organization's other options alone.`, railAdmits(i.cfg.rail, i.domain));
}

function stepConnector(i: ChecklistInput): ChecklistRow {
  if (!i.template) return row('connector', 'blocked', 'Connection matches the template', `RINGOTEL_CONNECTION_TEMPLATE does not name exactly one connection template in ${i.cfg.appLabel}, so the connection cannot be compared or created. Check that setting against the template names in ${i.cfg.appLabel}.`);
  if (!i.org) return row('connector', 'fix', 'Create the connection', 'The organization must exist before its connection can be created.');
  if (i.branches.length === 0) return row('connector', 'fix', 'Create the connection', 'This organization has no connection at this domain.', railAdmits(i.cfg.rail, i.domain));
  if (i.branches.length > 1) return row('connector', 'info', 'Connection matches the template', `This organization has ${i.branches.length} connections at this domain, so this page does not change them.`);
  const diff = diffConnector(i.template.params, i.branches[0]!);
  if (diff.matches) return row('connector', 'ok', 'Connection matches the template', 'The connection settings match the template.');
  const sections = diff.groups.map((g) => g.section).join(', ');
  return { ...row('connector', 'info', 'Connection matches the template', `The connection settings differ from the template under: ${sections}. Changing a connection is not offered here yet — edit it in the ${i.cfg.appLabel} panel.`), diff };
}

function stepIndex(i: ChecklistInput): ChecklistRow {
  if (i.inIndex) return row('index', 'ok', 'Organization list', 'The organization list this deployment caches already knows this domain.');
  if (i.org) return row('index', 'fix', 'Refresh the organization list', 'The organization exists, but the organization list this deployment caches has not seen it yet. Refreshing re-reads that list now.', true);
  return row('index', 'info', 'Organization list', 'The organization list this deployment caches will pick this domain up once the organization exists.');
}

function stepReconcile(i: ChecklistInput): ChecklistRow {
  if (!i.org) return row('reconcile', 'info', 'Directory sync', 'There is nothing to sync until the organization exists.');
  if (i.reconciled === true) return row('reconcile', 'ok', 'Directory sync', 'The directory sync has run for this domain.');
  if (i.reconciled === false) return row('reconcile', 'fix', 'Run the first directory sync', `This domain’s users are not in the ${i.cfg.appLabel} directory yet. The sync adds them as inactive placeholders and activates nobody.`, railAdmits(i.cfg.rail, i.domain));
  return row('reconcile', 'info', 'Directory sync', 'Whether the directory sync has run for this domain is not known until it runs.');
}

function stepRails(i: ChecklistInput): ChecklistRow {
  const missing = [
    i.eventsCovered ? null : 'NS_EVENTS_DOMAINS',
    i.prepopCovered ? null : 'RINGOTEL_PREPOP_AUTO',
    i.writeCovered ? null : 'RINGOTEL_WRITE_DOMAINS',
  ].filter((s): s is string => s !== null);
  if (missing.length === 0) return row('rails', 'ok', 'Sync and offboarding settings', 'NS_EVENTS_DOMAINS, RINGOTEL_PREPOP_AUTO and RINGOTEL_WRITE_DOMAINS all include this domain.');
  const list = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]!}`;
  return row('rails', 'info', 'Sync and offboarding settings', `${list} ${missing.length === 1 ? 'does' : 'do'} not include this domain. Enabling the domain here does not add it to ${missing.length === 1 ? 'that setting' : 'those settings'}.`);
}

const STEPS: Record<StepId, (i: ChecklistInput) => ChecklistRow> = {
  rail: stepRail, org: stepOrg, label: stepLabel, package: stepPackage, signin: stepSignin,
  connector: stepConnector, index: stepIndex, reconcile: stepReconcile, rails: stepRails,
};

/** The nine checklist rows for one domain, in the order Enable-all applies them. */
export function planChecklist(input: ChecklistInput): ChecklistRow[] {
  const admits = railAdmits(input.cfg.rail, input.domain);
  // TWO BOUNDS, ONE SHAPE, and both belong here rather than inside the individual steps: a step decides
  // what is TRUE of the domain, and these decide whether this page may act on it at all. Applied to every
  // writing step, not just the ones that would build something — an override points this domain at an
  // organization that may be serving OTHER domains too, so a `signin` fix would rewrite a shared
  // organization's `params` on one domain's behalf and the reconcile would populate its directory from
  // one domain's users. The override is checked FIRST because it is the stronger statement: a rail can be
  // widened by editing a setting, an overridden domain cannot be provisioned from this page at all.
  return STEP_ORDER.map((id) => {
    const r = STEPS[id](input);
    if (r.verdict !== 'fix' || !WRITING_STEPS.includes(id)) return r;
    if (input.addressOverride) return { ...r, verdict: 'blocked' as Verdict, detail: overrideDetail(input.cfg), fixable: false };
    if (!admits) return { ...r, verdict: 'blocked' as Verdict, detail: railDetail(input.cfg), fixable: false };
    return r;
  });
}

// ── The fleet row ──────────────────────────────────────────────────────────────────────────────────

export type FleetStateId = 'multiple' | 'no-org' | 'label-mismatch' | 'signin-differs' | 'package-differs' | 'drift' | 'not-in-index' | 'enabled';
/** `enableable` is about THIS PAGE, never about the app: a domain this page may not change can be
 *  perfectly well set up, and calling that a state of the integration said the opposite. So the audit
 *  state is computed for every domain regardless, and whether the page may act on it rides alongside. */
export interface FleetRow { domain: string; state: FleetStateId; orgLabel: string | null; expectedLabel: string; detail: string; enableable: boolean; drift?: string[] /* section names */ }

/** Why this page may not change a domain — the sentence appended to the row's own audit detail. The
 *  override case is NOT the rail case: one is a list the operator can add to, the other is a domain
 *  pointed somewhere this page does not derive, and telling them to edit the rail would be wrong. */
const readOnlyWhy = (cfg: ProvisionConfig, addressOverride: boolean): string =>
  addressOverride
    ? ` ${overrideDetail(cfg)}`
    : ' This page is read-only for this domain. Add it to RINGOTEL_PROVISION_DOMAINS to allow changes.';

/** One fleet row: the first state in precedence order that the domain is in. A domain with two orgs is
 *  `multiple` before anything else is even asked — this page never acts on one, so no later finding about
 *  it would be actionable. Sign-in and drift reuse the checklist's own predicates, so a row and its
 *  drilldown cannot disagree. */
export function fleetState(input: Omit<ChecklistInput, 'choice' | 'reconciled'> & { orgCount: number; orgCountBy: 'address' | 'name' }): FleetRow {
  const { domain, cfg, org, branches, template, packages, inIndex, orgCount, orgCountBy } = input;
  const expectedLabel = deriveOrgLabel(domain);
  const orgLabel = org ? org.domain : null;
  // Both bounds, because both are true of the page and not of the domain — a reader who is told "read-only"
  // and then finds every fix blocked for a reason the row never mentioned has been told half the truth.
  const enableable = railAdmits(cfg.rail, domain) && !input.addressOverride;
  const at = (state: FleetStateId, detail: string, drift?: string[]): FleetRow => {
    const d = enableable ? detail : detail + readOnlyWhy(cfg, input.addressOverride);
    return drift
      ? { domain, state, orgLabel, expectedLabel, detail: d, enableable, drift }
      : { domain, state, orgLabel, expectedLabel, detail: d, enableable };
  };

  // Two different tenants to go and fix, so two sentences. `orgCountBy: 'name'` means NOTHING answers to
  // this domain's address — the count is connection-less organizations holding a name it could claim, and
  // sending the reader to look for connections none of them has would be sending them nowhere.
  if (orgCount > 1) return at('multiple', orgCountBy === 'name'
    ? `${orgCount} ${cfg.appLabel} organizations without a connection hold this domain's name, so this page cannot tell which one it would be finishing. Resolve that in the ${cfg.appLabel} panel.`
    : `${orgCount} ${cfg.appLabel} organizations match this domain, so this page does not change it. Resolve that in the ${cfg.appLabel} panel.`);
  if (branches.length > 1) return at('multiple', `The organization has ${branches.length} connections at this domain, so this page does not change it.`);
  if (!org) return at('no-org', 'No organization matches this domain yet. Open it to set one up.');
  if (!labelMatches(orgLabel, expectedLabel)) return at('label-mismatch', `The ${cfg.appLabel} domain name "${orgLabel}" is not the NetSapiens short domain "${expectedLabel}". ${cfg.appLabel} does not allow editing it yet.`);
  if (!signinMatches(cfg, org.params, 'sso')) return at('signin-differs', `The organization is not set for single sign-on${signinWhy(cfg, org.params, 'sso')}.`);
  const wantPkg = packageIdOf(packages, cfg.defaultPackage);
  // An unresolvable default package is a config finding the drilldown reports; it is not this row's job to
  // call every org in the fleet wrong because one setting cannot be resolved.
  if (wantPkg !== null && org.packageid !== wantPkg) return at('package-differs', 'The organization is on a licensing package other than the one RINGOTEL_DEFAULT_PACKAGE names.');
  if (template && branches.length === 1) {
    const d = diffConnector(template.params, branches[0]!);
    if (!d.matches) {
      const sections = d.groups.map((g) => g.section);
      return at('drift', `The connection settings differ from the template under: ${sections.join(', ')}.`, sections);
    }
  }
  if (!inIndex) return at('not-in-index', 'The organization exists, but the organization list this deployment caches has not seen it yet.');
  return at('enabled', 'The organization, its connection and the cached organization list all match.');
}
