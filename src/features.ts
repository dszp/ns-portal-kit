/**
 * Feature-gating vocabulary + gate resolution (host config; mirror-bound — scope strings + level names
 * only, no deployment literal). Levels are explicit NS-scope allow-sets; the admin ladder nests, call
 * center is exact/orthogonal. `resolveGate` turns a config gate value into a policy-engine `Policy`,
 * applying the superadmin union (except off / CC-only) and the `off` kill-switch. Registry + env parsing
 * are in the same file (below, Task 2). Fail closed: an unknown level/shape throws FeaturesConfigError.
 */
import { isResellerScope, type Policy, type PolicyRule, type Principal } from '@dszp/netsapiens-lib';

/** A configured gate: a level, a union of levels, levels+forced-users, or raw policy rules. */
export type Gate = string | string[] | { levels?: string[]; users?: string[] } | PolicyRule[];

/** Loud, distinct error for a bad gate/level/config value (⇒ a 500 upstream). */
export class FeaturesConfigError extends Error {}

/** NS-scope allow-set per named level (case-insensitive match in the engine). ORDER within a set is
 *  irrelevant. `all`/`off`/`superadmin` are specials handled in resolveGate, not here.
 *  Word-forms CONFIRMED live (2026-07-17, decoded ns_t user_scope): Reseller, Office Manager,
 *  Site Manager, Basic User, Call Center Agent, Call Center Supervisor (and the end-user scope Simple
 *  User — a rare tier BELOW Basic; deliberately NOT its own level, reach it via `all`).
 *  `Advanced User` is the STANDARD NS word-form but is NOT present on every NetSapiens deployment (so unverified there) —
 *  included for portability so other deployments can use it; it sits above Basic, below the admin tiers.
 *  `super_user` (scope "Super User") is the apex rung — standard NS form (the engine also canonicalizes
 *  superuser/super-user), included so it can be targeted exactly; it is DISTINCT from the account-based
 *  `superadmin` tier (PORTAL_SUPERADMINS). The admin/user ladder nests (lower rung = broader set = "this
 *  scope and everyone above"); call center is orthogonal. */
export const LEVEL_SCOPES: Record<string, string[]> = {
  super_user: ['Super User'],
  reseller: ['Reseller', 'Super User'],
  office_manager: ['Office Manager', 'Reseller', 'Super User'],
  site_manager: ['Site Manager', 'Office Manager', 'Reseller', 'Super User'],
  advanced_user: ['Advanced User', 'Site Manager', 'Office Manager', 'Reseller', 'Super User'],
  basic_user: ['Basic User', 'Advanced User', 'Site Manager', 'Office Manager', 'Reseller', 'Super User'],
  call_center_agent: ['Call Center Agent'],
  call_center_supervisor: ['Call Center Supervisor'],
};
export const CC_LEVELS = new Set(['call_center_agent', 'call_center_supervisor']);

/** Every NS scope this deployment knows by name — the union of the sets above plus `Simple User`, which
 *  has no level of its own (reach it via `all`). Levels NEST; this list does not. It exists so a config
 *  axis that targets ONE scope exactly (`src/menus.ts` → `scopes`) can reject a typo instead of writing a
 *  rule that silently never matches. Keep it in sync with LEVEL_SCOPES — `features.selftest.ts` asserts
 *  every level's scopes appear here, so adding a level without adding its scope fails the tests. */
export const KNOWN_SCOPES: string[] = [
  'Super User', 'Reseller', 'Office Manager', 'Site Manager',
  'Advanced User', 'Basic User', 'Simple User',
  'Call Center Agent', 'Call Center Supervisor',
];

/** Push the rule(s) for one named level onto `rules`. Throws on `off` (only valid as the whole gate) or an
 *  unknown level. Whether the gate is call-center-only is NOT decided here — see `ccOnlyLevels`, the one
 *  derivation of that rule, which `gateLevels` records on every `GateShape`. */
function pushLevel(rules: PolicyRule[], level: string, superadmins: string[]): void {
  if (level === 'off') throw new FeaturesConfigError('"off" is only valid as the entire gate, not inside a list');
  if (level === 'all') { rules.push({ domains: ['*'] }); return; } // any principal (every principal has a domain)
  if (level === 'superadmin') { if (superadmins.length) rules.push({ users: superadmins }); return; }
  const scopes = LEVEL_SCOPES[level];
  if (!scopes) throw new FeaturesConfigError(`unknown level: ${level}`);
  rules.push({ scopes });
}

/** THE cc-only rule, in one place: a gate is call-center-only when it names at least one level and every
 *  level it names is a call-center level. Such a gate does NOT get the superadmin union — call center is
 *  orthogonal to the admin ladder, so a superadmin is not implicitly an agent. It used to be computed
 *  inline in three of `resolveGate`'s branches and nowhere else, which is why `gateInWords` could not see
 *  it and under-reported who passes every non-CC gate. */
const ccOnlyLevels = (levels: string[]): boolean => levels.length > 0 && levels.every((l) => CC_LEVELS.has(l));

/** Resolve a gate value into an effective `Policy`. `off` ⇒ [] (deny all). Otherwise: the levels' rules
 *  + a forced-`users` rule, plus the superadmin union UNLESS every named level is call-center.
 *
 *  Shape recognition and the cc-only decision are `gateLevels`' — ONE walk, shared with `gateInWords` and
 *  `grantedByFor`, so the prose on the status page cannot describe a different gate than the one enforced
 *  here. This function still does its own per-branch work: turning each level into rules. */
export function resolveGate(gate: Gate, superadmins: string[]): Policy {
  if (gate === 'off') return []; // kill-switch — no rules, no superadmin

  const shape = gateLevels(gate); // throws FeaturesConfigError on an unrecognized shape — fail closed
  const rules: PolicyRule[] = [];

  if (shape.hasRawRules) {
    // gateLevels already proved every element is a non-null, non-array object.
    for (const r of gate as PolicyRule[]) rules.push(r);
  } else {
    for (const l of shape.levels) pushLevel(rules, l, superadmins);
    if (shape.users.length) rules.push({ users: shape.users });
  }

  if (!shape.ccOnly && superadmins.length) rules.push({ users: superadmins });
  return rules;
}

import type { FeaturePolicies } from '@dszp/netsapiens-lib';

/** The subset of env this module reads. */
export interface FeaturesEnv {
  PORTAL_FEATURES?: string;
  PORTAL_SUPERADMINS?: string;
}

/**
 * The three injected bundles, named by the gate that admits each. One feature rides exactly one of them.
 *   - `access`  → `/kit/portal.js`, refused without `portal.access`
 *   - `self`    → `/kit/self.js`, refused without `portal.self`
 *   - `console` → `/kit/spk.js`, which `resolveAuth` admits for EITHER an admin or a self principal
 */
export type Delivery = 'access' | 'self' | 'console';

/**
 * Delivery path → the feature gates a caller must ALSO pass to receive that bundle at all. `some`, not
 * `every`: `console` lists two because either one gets you the bundle.
 *
 * Lives here beside `resolveGate` rather than in the status renderer so the console's Permissions matrix
 * and the Worker's own refusals cannot describe different delivery rules. Getting `console` wrong would
 * misreport WHY a caller is refused — a self principal reaches the console's own gates and is turned away
 * by the fleet-read rule, so reporting a delivery block would send an operator to widen `portal.access`,
 * which would not help.
 */
export const DELIVERY_CARRIERS: Record<Delivery, string[]> = {
  access: ['portal.access'],
  self: ['portal.self'],
  console: ['portal.access', 'portal.self'],
};

export interface FeatureDef {
  /** Policy key (matches the data-route/`_AF` key). */
  key: string;
  /** Human name (docs). */
  name: string;
  /** One-line description (docs; keep neutral). */
  description: string;
  /** Built-in default gate (reproduces today's behavior). */
  default: Gate;
  /**
   * WHY this exists, and how to use it — several paragraphs, rendered on the feature card above its
   * settings. `description` stays the one-line skim/index text. Optional: absent means the one-liner is
   * genuinely enough, and most features are in that category.
   *
   * Supports one piece of markup, `[label](https://…)`, rendered safely by `statusPage.richPara`.
   */
  detail?: string[];
  /**
   * Override the audience derived from the key namespace (`me.*` and `portal.self` ⇒ self-service).
   *
   * Exists because that derivation, which is right for five of the six `me.*` features, is WRONG for
   * `me.menuConfig`: the prefix records which BUNDLE delivers a feature, not whose account it is about.
   * Menu customization is operator configuration applied to every user — nothing about it concerns the
   * reader's own account — so filing it as self-service tells an operator to look for a per-user setting
   * that does not exist. One explicit exception beats loosening the rule for the other five.
   */
  audience?: 'admin' | 'self';
  /**
   * WHICH BUNDLE carries this feature to a browser — and therefore which delivery gate must also pass.
   * Absent ⇒ derived from the key namespace, which is what every feature relied on until now: `me.*`
   * rides the self bundle, everything else rides the admin bundle.
   *
   * Declared rather than derived because the namespace and the delivery path are two different facts, and
   * the second feature that needed them separated is what proved it. `me.menuConfig` is operator config
   * applied to everyone, so it needs the self bundle's reach but is not about the reader's own account —
   * patched with an {@link FeatureDef.audience} override while delivery stayed derived from the prefix. A
   * footer version line has the same shape and no `me.` in its name, so deriving delivery from the prefix
   * would have forced it to be called `me.footerVersion` — filing a third thing under a prefix that does
   * not describe it. Now a feature says where it rides, and `me.` means only what it says.
   */
  deliveredBy?: Delivery;
  /**
   * When present, the ONLY levels a config gate for this key may name. A floor, not a default:
   * `default` says what happens with no config, this says how far config may widen it.
   * Exists for features whose page or payload necessarily discloses more than one domain — see
   * `kit.status`. A key with no `allowedLevels` is unconstrained, as before.
   */
  allowedLevels?: string[];
}

/** Single source of truth for gate-able features. Defaults = today's per-scope matrix. */
export const FEATURE_REGISTRY: FeatureDef[] = [
  { key: 'portal.access', name: 'Portal entry', description: 'Receive the injected bundle at all.', default: 'office_manager' },
  { key: 'callflow.view', name: 'Call Flow Diagram', description: 'The call-flow diagram button + viewer.', default: 'reseller' },
  { key: 'ringotel.orgStatus', name: 'App status banner', description: 'Toolbar banner showing the app is active/not.', default: 'reseller' },
  { key: 'ringotel.userStatus', name: 'App-status user column', description: 'Per-user app-activation column on the Users page.', default: 'office_manager' },
  { key: 'ringotel.orgList', name: 'App-status domains column', description: 'Per-domain app column on the Domains page.', default: 'reseller' },
  { key: 'ringotel.refresh', name: 'Fleet directory refresh', description: 'Force a fleet-wide Ringotel directory rebuild.', default: 'reseller' },
  { key: 'ringotel.profileStatus', name: 'App status on profile', description: 'The app active/inactive indicator on the user-profile page.', default: 'office_manager' },
  {
    key: 'ringotel.prepop',
    name: 'Directory pre-population',
    description:
      'Preview and create inactive Ringotel directory entries for NetSapiens users who have none (write). ' +
      'Inactive entries are not billable and send no mail, but this is a whole-domain operation.',
    default: 'reseller',
  },
  { key: 'ringotel.activate', name: 'App activate/deactivate', description: 'Activate or deactivate the app for a user from the profile page (write).', default: 'office_manager' },
  { key: 'ringotel.resetPassword', name: 'App password reset', description: 'Reset the app password for a user from the profile page (write).', default: 'office_manager' },
  { key: 'ringotel.profileAppAccess', name: 'App sign-in details on profile', description: 'The user-visible app sign-in message (domain/username/password + downloads) on the user-profile page.', default: 'office_manager' },
  // Self-service tier (own-account features; orthogonal to the admin ladder). See
  // docs/superpowers/specs/2026-07-18-self-service-tier-home-status-design.md.
  { key: 'portal.self', name: 'Self-service entry', description: 'Receive the self-service bundle (own-account features).', default: 'all' },
  { key: 'me.appStatus', name: 'My app status (home)', description: "App active/inactive indicator on the user's own home page.", default: 'all' },
  { key: 'me.devices', name: 'My devices', description: "The user's own device list/registration/online status. Off by default.", default: 'off' },
  { key: 'me.resetPassword', name: 'Reset my app password', description: "Reset the user's own app password (own account; write). Off by default.", default: 'off' },
  { key: 'me.appAccess', name: 'My app sign-in details', description: "The app's domain/username sign-in details and download links on the user's own surfaces.", default: 'all' },
  {
    key: 'me.menuConfig',
    name: 'Portal menu customization',
    description: 'Add and hide entries in the portal\'s stock menus, optionally only where your app is active.',
    default: 'all',
    // NOT self-service, despite the `me.` prefix — see FeatureDef.audience. The prefix says the self bundle
    // delivers it; the feature is operator configuration applied to everyone.
    audience: 'admin',
    detail: [
      'Adding your own entries to the portal\'s menus, and hiding stock ones you do not offer. It needs no other integration — with no app configured at all, static add and hide still work on any deployment.',
      '### Which menus',
      'Three can be targeted, and they are referenced by name rather than by CSS selector: the Apps dropdown, the signed-in user\'s own name dropdown, and the top-nav Management dropdown that the portal shows only to administrative scopes. Naming them is deliberate — a selector would break silently on a portal update, and it would turn an environment variable into a DOM-injection surface. An unknown name is a startup error rather than an entry that quietly never appears.',
      '### Conditional entries',
      'Any entry can be conditioned on three independent axes: which domain the user is in, which NetSapiens scope they hold, and whether your app is active for them. That last one is what makes this more than a static link list — you can show an app-specific entry only to the users who actually have the app, instead of showing everyone a link half of them cannot use.',
      '### The shape',
      'A JSON object keyed by menu name, each with `add` (a list of `{label, url, title}`) and/or `hide` (a list of stock entry labels), where either may instead be an object keyed by the axis you are targeting. The Config tab\'s `PORTAL_MENUS` row carries a worked example, and `url` supports placeholders so one entry can carry the current user\'s extension and domain into a link.',
      '### Two ways to hide, and they merge',
      'There are two ways to hide an Apps-menu entry — this key\'s `apps.hide`, and the older `PORTAL_APPS_HIDE` — and setting both is fine: the two lists merge, duplicates collapse, and neither silently wins. The Config tab shows the effective list with each entry attributed to the setting it came from, so there is still one place to look for the answer. `apps.hide` here is a strict superset: it does everything the older one does, plus scope and app-state targeting. The older one is a comma-separated convenience for the plain case, not deprecated and not a separate capability. If you are already writing this JSON, put the hide list in it.',
      '### Hides run before adds',
      'The order is part of the contract, not an accident: a hide names a stock entry, so it is applied to the menu as the portal shipped it, before any of your own entries are added. That keeps the two lists independent — a hide can never remove something you added, and neither list\'s meaning depends on the other.',
      '### What it is not',
      'Hiding a menu entry is cosmetic. It removes a link, not access to whatever the link pointed at. Never use it to lock a feature — that is what the gates on the Permissions tab are for.',
    ],
  },
  {
    key: 'portal.statusBanner',
    name: 'Status banner',
    description: 'A message across the top of the portal, supplied by an endpoint you host — maintenance notices, outages, anything time-bound.',
    default: 'all',
    // Rides the self bundle for the same reason the version line does: it must reach every signed-in user,
    // and it is not about the reader's own account.
    deliveredBy: 'self',
    audience: 'admin',
    detail: [
      'A banner across the top of the portal whose text comes from an endpoint you run. The kit does not store the message and does not decide who sees it — it asks your endpoint on each page load and shows whatever comes back, or nothing.',
      '### Why an endpoint rather than a setting',
      'A notice is time-bound and often per-customer, so a config value would mean a redeploy to post one and another to take it down. Pointing at something you host keeps the kit stateless — no database, no binding to provision — while letting the message change as often as you like. It is the same shape as the vendor hand-off: name a URL you control.',
      '### What is sent, and the one thing to be careful about',
      'The request carries the signed-in user\'s own `ns_t`, plus their path, scope and domain, so your endpoint can decide whether this person should see anything. That token is a live credential for your NetSapiens portal. **Point this only at an endpoint you control** — anything you name here receives a working token from every user who loads the portal.',
      '### The call, exactly',
      'A `POST` on every portal page load, `Content-Type: application/json`, to the https endpoint you name. The body is `{validate, path, domain, scope_mode, sub_scope, user}` — `validate` is the caller\'s own `ns_t`, and the rest is where they are and who the portal thinks they are, so your side can decide what this person should see.',
      'Reply with **plain text**, or JSON carrying any of `message`, `banner_message`, `text` or `banner`. An empty body, an empty string, or a non-2xx status all mean **show nothing** — that is how a notice is taken down, and how a failing endpoint stays invisible rather than breaking the portal. Nothing is cached: the endpoint is asked again on the next page load, so a message appears and disappears as fast as your side changes it.',
      '### What is rendered',
      'Simple HTML, rebuilt rather than inserted. A welcome or support notice usually needs a link, bold, italics or a `<br>`, so those are supported — but the reply never reaches the page as markup. It is parsed in an inert document and copied across tag by tag from an allow-list, so `<script>`, event handlers and any `href` that is not `https:` or `mailto:` are dropped whatever your endpoint returns. An unknown tag is unwrapped rather than deleted, so a message never silently loses half a sentence. Nothing script-bearing is ever copied, which makes that structural rather than a rule someone has to remember — but it is a backstop against a mistake, not a substitute for trusting your own endpoint. This renders into every signed-in user\'s portal: return only messages you trust.',
      '### When it is off',
      'Unset the endpoint and the feature is inert — nothing is requested and nothing is drawn. There is no half-configured state to get wrong.',
    ],
  },
  {
    key: 'portal.versionLine',
    name: 'Version line in the portal footer',
    description: 'Adds this kit\'s name and version to the portal footer, linked to that version\'s release notes for reseller scope and above.',
    default: 'all',
    // Rides the self bundle because it must reach every signed-in user, but it is not self-service in any
    // sense — it describes the deployment, not the reader's account. This pair of declarations is why
    // `deliveredBy` exists; see its doc comment.
    deliveredBy: 'self',
    audience: 'admin',
    detail: [
      'The portal footer already carries a version for the platform and, where it is installed, for the vendor\'s own add-on. This adds a third entry in the same pattern, so an operator looking at a portal can tell which version of this kit is behind it without opening a console or a config file.',
      '### Who gets a link',
      'Reseller scope and above get the version linked to that version\'s release notes. Everyone else gets the same name and version as plain text, with no link in the page at all rather than a disabled one — release notes are operator information, and a link to a changelog for software the reader cannot configure is noise. The two audiences see the same words, which is deliberate: a support call about "what version are you on" gets the same answer from anyone.',
      '### Where the link points',
      'Set by `PORTAL_RELEASE_NOTES_URL`, shared with the console\'s own header so there is one answer to that question. Absent points at the public release list anchored at the running version; a value of your own is substituted with `{version}`; and present-but-empty turns the link off everywhere while keeping the version text.',
      '### If the footer is not found',
      'Nothing is inserted and nothing is logged. A portal theme that has no footer, or renames it, loses the line and keeps everything else — this is the least consequential thing the kit adds, so it fails quietly by design.',
    ],
  },
  // The operator console (2026-08-07). Floored on purpose: it names other domains (ALLOWED_DOMAINS,
  // NS_EVENTS_DOMAINS, RINGOTEL_WRITE_DOMAINS, PORTAL_MENUS targeting), and every scope below Reseller
  // is domain-locked by resolveAuth. `superadmin` + an unset PORTAL_SUPERADMINS resolves to deny-all,
  // so an operator who has named nobody gets no console.
  { key: 'kit.status', name: 'Super Portal Kit', description: 'Read-only status and configuration console for this deployment.', default: 'superadmin', deliveredBy: 'console', allowedLevels: ['off', 'superadmin', 'super_user', 'reseller'] },
];

/** The registry's policy keys, in order (drives `_AF` + the default policy set). */
export const featurePolicyKeys = (): string[] => FEATURE_REGISTRY.map((f) => f.key);

/** Which bundle carries a feature: its own declaration, else the historical namespace rule. */
export function deliveryOf(def: FeatureDef): Delivery {
  if (def.deliveredBy) return def.deliveredBy;
  return def.key.startsWith('me.') ? 'self' : 'access';
}

/** The delivery gates a caller must pass (any one of them) to receive the bundle carrying `key`. An
 *  unknown key falls back to the admin bundle — the narrower answer, so a typo cannot read as reachable. */
export function carriersFor(key: string): string[] {
  const def = FEATURE_REGISTRY.find((f) => f.key === key);
  return DELIVERY_CARRIERS[def ? deliveryOf(def) : 'access'];
}

/** The registry keys a given bundle carries, in registry order. Excludes the two delivery gates
 *  themselves (`portal.access`/`portal.self`) — they admit a bundle rather than riding one. */
export function keysDeliveredBy(via: Delivery): string[] {
  return FEATURE_REGISTRY
    .filter((f) => f.key !== 'portal.access' && f.key !== 'portal.self' && deliveryOf(f) === via)
    .map((f) => f.key);
}

/** What an account id looks like, in one place. Exported because `menus.ts`'s `users` targeting axis has to
 *  agree with `PORTAL_SUPERADMINS` and `PORTAL_FEATURES`' `users:` about what a valid account is — three
 *  settings that all name accounts should not disagree about which strings are accounts. */
export const looksLikeAccount = (s: string): boolean => /^[^@\s]+@[^@\s]+$/.test(s);

/** PORTAL_SUPERADMINS → lowercased `user@domain` list ([] if unset). Throws on a malformed entry. */
export function parseSuperadmins(env: FeaturesEnv): string[] {
  const raw = (env.PORTAL_SUPERADMINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of raw) if (!looksLikeAccount(s)) throw new FeaturesConfigError(`PORTAL_SUPERADMINS entry is not a user@domain: ${s}`);
  return raw.map((s) => s.toLowerCase());
}

/** What a gate NAMES, without resolving it — so a floor can be checked before any rule is built (and so
 *  a caller who only needs to know WHO a gate names — status.ts's viewer/gate-prose code — has one walk
 *  to read instead of writing a second). Fails CLOSED: an unrecognized shape throws rather than
 *  reporting "no levels", which would pass every floor. This is the ONLY walk of the `Gate` shape:
 *  `resolveGate` reads the `GateShape` this returns and then does its own per-branch work (turning each
 *  level into rules), so a fifth `Gate` shape needs teaching HERE and nowhere else —
 *  `features.selftest.ts` will tell you if you miss it.
 *
 *  Being the only walk makes this the only validation boundary too: every element of `levels`/`users`, and
 *  of every string-list field of a raw rule, is checked to BE a string here (see `requireStringList`),
 *  because past this point the values go straight into the policy engine.
 *
 *  `users` is every `user@domain` the gate names directly — from the object shape's `users` list, or
 *  (for raw rules) the union of every rule's `users` field. `hasUsers` stays a plain boolean for a
 *  caller that only needs "does this gate name anyone specifically", without building the list. */
/** `ccOnly` is the cc-only decision (see `ccOnlyLevels`) recorded ONCE, so `resolveGate` (which acts on it)
 *  and `gateInWords` (which must describe it) read the same answer instead of deriving it twice. */
export interface GateShape { levels: string[]; users: string[]; hasUsers: boolean; hasRawRules: boolean; ccOnly: boolean }

/** The type name for an error message. Never the VALUE: the type is what the operator got wrong, and a
 *  gate's `users` list holds account names, which this module has no business echoing. */
const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Every element of a config-supplied string list must BE a string.
 *
 * The policy engine lowercases each entry the moment a rule is evaluated (`lc()` → `s.trim()` in
 * netsapiens-lib's `policy.ts`), for `scopes`, `domains`, `users` and `operators` alike. So one non-string
 * element reaching `can()` throws a raw `TypeError` — a 1101 with no reason instead of the designed
 * 500-with-reason — and, because the integration console evaluates every gate to build its cards, it takes down
 * the very page whose job is to name the bad key. Validating HERE, at the config boundary that has a
 * message to give, turns a typo (`["a@b.example", 42]`) into a `FeaturesConfigError`.
 */
function requireStringList(list: unknown[], where: string): string[] {
  for (const v of list) {
    if (typeof v !== 'string') throw new FeaturesConfigError(`${where} must contain only strings, got ${typeName(v)}`);
  }
  return list as string[];
}

/** The `PolicyRule` fields the engine treats as string lists (see `ruleMatches`). `masking` is a boolean
 *  and `description` is inert, so neither can crash an evaluation — a wrong type there simply never
 *  matches, which is fail-closed. */
const RULE_STRING_FIELDS = ['scopes', 'domains', 'users', 'operators'] as const;

export function gateLevels(gate: Gate): GateShape {
  if (typeof gate === 'string') return { levels: [gate], users: [], hasUsers: false, hasRawRules: false, ccOnly: ccOnlyLevels([gate]) };
  if (Array.isArray(gate)) {
    if (gate.every((g) => typeof g === 'string')) {
      const levels = gate as string[];
      return { levels, users: [], hasUsers: false, hasRawRules: false, ccOnly: ccOnlyLevels(levels) };
    }
    if (gate.every((g) => !!g && typeof g === 'object' && !Array.isArray(g))) {
      // Validate every string-list field of every rule, not just the `users` this function reads: these
      // rules go through `resolveGate` verbatim into the policy engine, so a non-string ANYWHERE in one
      // of them is the same raw TypeError. A non-ARRAY field was previously ignored outright here, which
      // let `{"users":"a@b.example"}` reach `inList()` and crash on `.some`.
      const users: string[] = [];
      for (const r of gate as Record<string, unknown>[]) {
        for (const field of RULE_STRING_FIELDS) {
          const v = r[field];
          if (v === undefined) continue;
          const where = `a raw policy rule's "${field}"`;
          if (!Array.isArray(v)) throw new FeaturesConfigError(`${where} must be an array of strings, got ${typeName(v)}`);
          const strings = requireStringList(v, where);
          if (field === 'users') users.push(...strings);
        }
      }
      // Raw rules name scopes directly, not levels, so "every level is call-center" is not decidable —
      // and the superadmin union has always applied to them. false, deliberately, not unknown.
      return { levels: [], users, hasUsers: users.length > 0, hasRawRules: true, ccOnly: false };
    }
    throw new FeaturesConfigError('a gate array must be all level names or all rule objects, not a mix');
  }
  if (gate && typeof gate === 'object') {
    const g = gate as { levels?: unknown; users?: unknown };
    if (g.levels !== undefined && !Array.isArray(g.levels)) {
      throw new FeaturesConfigError(`a gate object's "levels" must be an array of level names, got ${typeName(g.levels)}`);
    }
    if (g.users !== undefined && !Array.isArray(g.users)) {
      throw new FeaturesConfigError(`a gate object's "users" must be an array of user@domain accounts, got ${typeName(g.users)}`);
    }
    const levels = requireStringList(g.levels ?? [], `a gate object's "levels"`);
    const users = requireStringList(g.users ?? [], `a gate object's "users"`);
    const hasUsers = users.length > 0;
    if (!levels.length && !hasUsers) throw new FeaturesConfigError('a gate object needs levels or users');
    return { levels, users, hasUsers, hasRawRules: false, ccOnly: ccOnlyLevels(levels) };
  }
  throw new FeaturesConfigError(`unrecognized gate shape: ${JSON.stringify(gate)}`);
}

/** PORTAL_FEATURES → { key: gate } ({} if unset). Throws on bad JSON or an unknown feature key. */
export function parseFeatures(env: FeaturesEnv): Record<string, Gate> {
  const raw = (env.PORTAL_FEATURES ?? '').trim();
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new FeaturesConfigError('PORTAL_FEATURES is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new FeaturesConfigError('PORTAL_FEATURES must be a JSON object');
  const known = new Set(featurePolicyKeys());
  const out: Record<string, Gate> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, Gate>)) {
    if (!known.has(k)) throw new FeaturesConfigError(`PORTAL_FEATURES has an unknown feature key: ${k}`);
    // The floor (see FeatureDef.allowedLevels). Checked HERE, at the config-ingestion boundary, because
    // this is the only place a key and its gate are both in hand — resolveGate never learns which key
    // it is resolving.
    const def = FEATURE_REGISTRY.find((f) => f.key === k);
    if (def?.allowedLevels) {
      const shape = gateLevels(v);   // throws on an unknown shape — do not soften this
      if (shape.hasRawRules) {
        throw new FeaturesConfigError(`PORTAL_FEATURES["${k}"] may not use raw policy rules: a raw rule can name any scope, which would bypass this feature's allowed levels (${def.allowedLevels.join(', ')})`);
      }
      const bad = shape.levels.filter((l) => !def.allowedLevels!.includes(l));
      if (bad.length) {
        throw new FeaturesConfigError(`PORTAL_FEATURES["${k}"] may only name these levels: ${def.allowedLevels.join(', ')} — refusing ${bad.join(', ')}. This feature discloses configuration covering more than one domain, and every scope below reseller is domain-locked.`);
      }
    }
    out[k] = v;
  }
  return out;
}

/** Assemble the effective FeaturePolicies: registry defaults ⊕ PORTAL_FEATURES overrides, each gate
 *  resolved through the levels + the superadmin union. THE single seam a future admin panel replaces. */
export function resolveFeaturePolicies(env: FeaturesEnv): FeaturePolicies {
  const supers = parseSuperadmins(env);
  const overrides = parseFeatures(env);
  const policies: FeaturePolicies = {};
  for (const f of FEATURE_REGISTRY) {
    const gate = Object.prototype.hasOwnProperty.call(overrides, f.key) ? overrides[f.key] : f.default;
    policies[f.key] = resolveGate(gate, supers);
  }
  return policies;
}

/** Null when the feature config is valid (or absent); a loud, actionable message otherwise. */
export function featuresConfigError(env: FeaturesEnv): string | null {
  try {
    resolveFeaturePolicies(env);
    return null;
  } catch (e) {
    if (e instanceof FeaturesConfigError) return `Feature gating misconfigured: ${e.message}`;
    throw e;
  }
}

/**
 * The console's SECOND gate: passing `kit.status`'s policy is not enough to read the console.
 *
 * It reports settings that name other customers' domains, and every NS scope below Reseller is
 * domain-locked by `resolveAuth` — so a `users:` grant to a domain-locked account passes the policy and
 * must still be refused. `worker.ts`'s `requireFleetRead` is the enforcement (it throws a 403 with the
 * operator-facing wording); this is the predicate underneath it.
 *
 * It lives HERE, not in `worker.ts`, because a second consumer now needs the same answer: the status
 * console's Permissions matrix must show what each scope can actually reach, and a permissions view that
 * disagreed with the enforcement it describes would be worse than none at all. One predicate, two callers.
 *
 * Throws `FeaturesConfigError` on a malformed `PORTAL_SUPERADMINS` — deliberately, and unchanged from
 * `requireFleetRead`'s previous inline behaviour: the console cannot be authorized against a list that
 * cannot be parsed, and failing loudly is the only fail-closed answer.
 */
export function fleetReadAllowed(principal: Pick<Principal, 'id' | 'scope'>, env: FeaturesEnv): boolean {
  if (isResellerScope(principal.scope)) return true;
  return parseSuperadmins(env).includes(principal.id.toLowerCase());
}

/**
 * Why `kit.status` admits NOBODY, if that is the case — else null.
 *
 * The console's 403 could otherwise mean three different things, and an operator cannot tell them apart:
 * the feature is off, no superadmin is named, or they personally are not on a list that does admit
 * others. Only the first two are actionable, and only they belong in a refusal message.
 *
 * Names SETTINGS, never values — the same rule setup.ts and exposure.ts already hold to, so this is safe
 * to return to any authenticated caller.
 */
export function kitStatusLockedReason(env: FeaturesEnv): string | null {
  // Derive "admits nobody" from the RESOLVED policy — resolveFeaturePolicies already runs the gate
  // through resolveGate (levels, the superadmin union, the `off` kill-switch); re-deriving that here
  // would be a second copy of the exact logic this feature exists to keep in one place.
  const policy = resolveFeaturePolicies(env)['kit.status'] ?? [];
  if (policy.length > 0) return null; // admits someone — the caller just isn't one of them

  // Only distinguishing WHICH empty-policy reason applies is left to do, and that only needs the raw
  // configured gate, not a re-resolution of it.
  const def = FEATURE_REGISTRY.find((f) => f.key === 'kit.status')!;
  const overrides = parseFeatures(env);
  const gate = Object.prototype.hasOwnProperty.call(overrides, 'kit.status') ? overrides['kit.status'] : def.default;

  if (gate === 'off') {
    return 'kit.status is switched off in PORTAL_FEATURES. Remove that override to restore the default (superadmin-only).';
  }
  // The only other way a non-"off" gate resolves to an empty policy is that PORTAL_SUPERADMINS is
  // unset/empty — every named level pushes at least one rule (see LEVEL_SCOPES), so an empty result
  // always traces back to the superadmin union having nobody to union in.
  return 'No superadmin is configured. Set PORTAL_SUPERADMINS to a comma-separated list of user@domain accounts, or widen kit.status in PORTAL_FEATURES (no further than reseller).';
}
