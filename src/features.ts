/**
 * Feature-gating vocabulary + gate resolution (host config; mirror-bound — scope strings + level names
 * only, no deployment literal). Levels are explicit NS-scope allow-sets; the admin ladder nests, call
 * center is exact/orthogonal. `resolveGate` turns a config gate value into a policy-engine `Policy`,
 * applying the superadmin union (except off / CC-only) and the `off` kill-switch. Registry + env parsing
 * are in the same file (below, Task 2). Fail closed: an unknown level/shape throws FeaturesConfigError.
 */
import { isResellerScope, type Policy, type PolicyRule, type Principal } from '@dszp/netsapiens-lib';

/**
 * The account axis of a gate object. A plain list is the ALLOW list — the original, unchanged form.
 * The object form names a direction, and both directions may be given at once.
 *
 * `allow` rather than `allowOnly`: the list still unions with `levels`, so "only" would be false
 * whenever `levels` is present. The only-ness comes from omitting `levels`, exactly as it always has.
 *
 * `deny` is the reason this shape exists. Without it, "every reseller except these two" can only be
 * written as its complement — every reseller who KEEPS the capability — which is wrong the moment an
 * account is created, and wrong silently. The direction lives under the axis rather than in a sibling
 * `denyUsers` key so that the pairing is structural: a second axis needing a deny then costs a shape
 * the parser already knows. (`menus.ts` set the list-or-object precedent.)
 */
export type GateUsers = string[] | { allow?: string[]; deny?: string[] };

/** A configured gate: a level, a union of levels, levels+users (allow and/or deny), or raw policy rules. */
export type Gate = string | string[] | { levels?: string[]; users?: GateUsers } | PolicyRule[];

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
  // ⚠️ THE ONLY LEVEL THAT IS ABOUT THE OPERATOR RATHER THAN THE READER.
  //
  // While masquerading, `sub` is the MASKED user, so `toPrincipal` makes the effective identity theirs —
  // which is right, and is why a superadmin who masks in stops passing every `users:`-shaped gate,
  // including the console's own. That is the correct default and must not be loosened.
  //
  // But it also means a capability that only makes sense DURING a masquerade cannot be expressed by any
  // existing level. This one is: masking is on AND the operator behind the mask is a superadmin. Both
  // conditions already exist in the policy engine and neither had a use until now.
  if (level === 'masked_by_superadmin') {
    if (superadmins.length) rules.push({ masking: true, operators: superadmins });
    return;
  }
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

  // THE DENY, distributed onto EVERY rule — because the engine ORs rules and ANDs within one, so a
  // single rule left bare re-admits the denied account through it. `netsapiens-lib`'s policy selftest
  // pins that property ("notUsers is per-rule"), and this is the code it exists to protect.
  //
  // ⚠️ Including the superadmin union, deliberately. Everywhere else the union is purely additive, so
  // this changes its character: a deny now beats it. Accepted because `off` already denies superadmins
  // (the union was never absolute), and because a deny that names an account and then quietly does not
  // apply to it is the worse of the two surprises. An existing `notUsers` on a raw rule is preserved
  // and added to, never replaced.
  if (shape.denyUsers.length) {
    return rules.map((r) => ({ ...r, notUsers: [...(r.notUsers ?? []), ...shape.denyUsers] }));
  }
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
  /**
   * Names the RUNTIME gate that still refuses a domain-locked account admitted by name — and its
   * presence is what permits a `users:` grant past {@link allowedLevels} at all.
   *
   * ⚠️ The floor checked LEVELS only, so `{"users":["100@customer"]}` sailed through a declaration that
   * says "only these levels". On `kit.status` that was survivable because `requireFleetRead` refuses the
   * caller a second time at the route; on a feature with no such gate it was the floor not enforcing
   * what it claims. Rather than banning `users:` everywhere (a legitimate way to admit one account, and
   * this kit ships to operators whose configs we cannot see), the exemption has to be DECLARED, next to
   * the level list it is an exemption from.
   */
  usersBackstop?: string;
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
   // ── The portal's OWN domain-record controls (2026-08-11) ────────────────────────────────────────
  //
  // ⚠️ THE FIRST KEYS IN THIS REGISTRY WITH NO SERVER ROUTE OF OURS BEHIND THEM. Every other feature's
  // `_AF` flag mirrors a route this Worker also gates, which is what makes "the flag is cosmetic"
  // (kit.ts, FEATURE_KEYS) a safe thing to say: the server refuses a caller the flag would have hidden
  // it from. These three hide controls belonging to the NetSapiens portal, whose forms post straight
  // from the browser to the NetSapiens core. We are not in that path and cannot be. Denying one of
  // these removes the way in, not the ability — say so wherever it is documented, and never let a
  // reader inherit the usual guarantee by association.
  //
  // Three keys rather than one because grouping cannot be undone cheaply (a later `portal.domainDelete`
  // beside a `portal.domainAdmin` leaves two keys claiming one control), and because one split IS worth
  // expressing: may adjust a customer's limits, may never delete the customer.
  //
  // `reseller` throughout is a true no-op — no scope below it is offered these controls by the portal,
  // so shipping these keys changes nothing anywhere until an operator configures one.
  {
    key: 'portal.domainCreate',
    name: 'Domain creation',
    description: "The portal's own Add Domain control on the domains list.",
    default: 'reseller',
    detail: [
      'Whether this account is offered the portal\'s own control for creating a domain. It is the one domain-record capability with no target to name — you are making the domain, so there is nothing yet to be specific about.',
      '### What denying it does, and does not do',
      'It removes the control. It does not remove the capability: the form behind it belongs to your NetSapiens portal and posts directly to it, with this kit nowhere in the path. Someone who knows the URL is unaffected. Treat this as a guardrail against the wrong click by someone who should not be making that click, not as a permission — the platform\'s own scopes are the only thing that can refuse the write.',
    ],
  },
  {
    key: 'portal.domainEdit',
    name: 'Domain editing',
    description: "The portal's own Edit controls for a domain's configuration record.",
    default: 'reseller',
    detail: [
      'Whether this account is offered the portal\'s own controls for editing a domain\'s configuration — its limits especially. It covers every way in that we can see: the edit control on each row of the domains list, and the Edit Domain button shown while viewing a domain.',
      '### It is about the domain record, not its contents',
      'Users, call queues, auto attendants, time frames and inventory inside a domain are untouched by this. Someone denied domain editing can still administer everything within a domain they can open — which is usually the point, since the two are different jobs, but it is worth being explicit about because "cannot edit the domain" invites the wider reading.',
      '### What denying it does, and does not do',
      'It removes the controls. It does not remove the capability. The edit form belongs to your NetSapiens portal and posts directly to it; this kit is not in that path and cannot refuse the write. A missed control therefore fails open — you get the button back, never a false sense that something was blocked. Use the platform\'s own scopes for anything that must actually be prevented.',
      '### The usual shape',
      'The reason to reach for this is almost always "everyone who has it today, except these people", which is what a deny-only gate means: `{"users":{"deny":["100@example.com"]}}`. That stays correct as staff are added, because it names the exception rather than its complement.',
    ],
  },
  {
    key: 'portal.domainDelete',
    name: 'Domain deletion',
    description: "The portal's own delete control for a domain, on the domains list.",
    default: 'reseller',
    detail: [
      'Whether this account is offered the portal\'s own control for deleting a domain. Separate from editing on purpose: "may adjust a customer\'s limits, may never delete the customer" is an ordinary thing to want of junior staff, and one key covering both could not express it.',
      '### What denying it does, and does not do',
      'It removes the control, not the capability — the same caveat as the other two, and it matters most here, because this is the irreversible one. Nothing in a browser can stop a determined request; only the platform\'s own scopes can.',
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
  { key: 'kit.status', name: 'Super Portal Kit', description: 'Read-only status and configuration console for this deployment.', default: 'superadmin', deliveredBy: 'console', allowedLevels: ['off', 'superadmin', 'super_user', 'reseller'], usersBackstop: 'requireFleetRead (worker.ts) — a domain-locked account admitted by name is still refused at the route' },
  {
    key: 'kit.captureMenus',
    name: 'Remember a role\u2019s menus',
    description: 'While masquerading, lets the operator store that role\u2019s stock menu entries in their own browser, so the menu editor can draw them.',
    default: 'masked_by_superadmin',
    deliveredBy: 'console',
    allowedLevels: ['off', 'masked_by_superadmin'],
    detail: [
      'The menu editor draws each menu the way the audience you pick would see it. It gets the rules right — your deployment resolves them — but the stock entries it starts from are whatever was on the page you opened the console from, read as you. Preview another role and those entries are an approximation, and nothing in a browser can fix that on its own: you can only be one identity at a time, so there is no way to load another role\u2019s page beside your own.',
      'What there is: you already masquerade. This adds one menu entry while you are masqueraded that stores that role\u2019s menu entries in your own browser. Un-masquerade, open the console, pick that role, and the picture is drawn from what you captured rather than from your own menus — with the capture date on screen, because a snapshot that does not say when it was taken is the next wrong answer.',
      'It reads only the labels already rendered on the page in front of you, and writes only to your own browser. Nothing is sent anywhere, no configuration changes, and the capability is gated on the masquerade itself: the rule requires masking to be on and the operator behind the mask to be a superadmin, so it cannot be reached by anyone signing in normally.',
    ],
  },
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
/** `denyUsers` is the gate's `users.deny` list — the accounts every rule this gate emits must exclude.
 *  It is NOT counted by `users`/`hasUsers`, which mean "who does this gate name as ADMITTED" and feed
 *  `grantedByFor`'s "you are named personally" prose. A denied account is named, and not admitted. */
export interface GateShape { levels: string[]; users: string[]; hasUsers: boolean; hasRawRules: boolean; ccOnly: boolean; denyUsers: string[] }

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
const RULE_STRING_FIELDS = ['scopes', 'domains', 'users', 'operators', 'notUsers'] as const;

/**
 * Read a gate object's `users` in either written form: a plain list (the allow list, unchanged) or an
 * object naming `allow` and/or `deny`.
 *
 * `wroteAllow` records whether an allow side was WRITTEN, which is not the same as its being non-empty
 * — `parseFeatures` needs to tell "no allow side at all" (expand to the feature's default) from "an
 * allow side naming nobody" (an error), and those two differ only by whether the key is present.
 *
 * An unknown key inside the object is refused rather than ignored. `{"users":{"denies":[…]}}` would
 * otherwise parse as an empty deny and silently restrict nobody — the failure mode a deny must never
 * have.
 */
function gateUsers(raw: unknown): { users: string[]; denyUsers: string[]; wroteAllow: boolean } {
  if (raw === undefined) return { users: [], denyUsers: [], wroteAllow: false };
  if (Array.isArray(raw)) return { users: requireStringList(raw, `a gate object's "users"`), denyUsers: [], wroteAllow: true };
  if (!raw || typeof raw !== 'object') {
    throw new FeaturesConfigError(`a gate object's "users" must be an array of user@domain accounts, or an object with "allow"/"deny", got ${typeName(raw)}`);
  }
  const u = raw as { allow?: unknown; deny?: unknown };
  for (const [k, v] of Object.entries(u)) {
    if (k !== 'allow' && k !== 'deny') {
      throw new FeaturesConfigError(`a gate object's "users" accepts only "allow" and "deny", got "${k}"`);
    }
    if (!Array.isArray(v)) {
      throw new FeaturesConfigError(`a gate object's "users.${k}" must be an array of user@domain accounts, got ${typeName(v)}`);
    }
  }
  const users = requireStringList((u.allow as unknown[]) ?? [], `a gate object's "users.allow"`);
  const denyUsers = requireStringList((u.deny as unknown[]) ?? [], `a gate object's "users.deny"`);
  // ⚠️ A deny naming something that is not an account can never deny anyone, and fails OPEN while doing
  // it. That is the opposite of a typo in an allow list, which merely admits nobody extra and is
  // therefore safe to leave unchecked (as it always has been). The asymmetry in the failure direction
  // is the whole reason this one list is shape-checked — same rule, and same message, as
  // PORTAL_SUPERADMINS, which names accounts for the same kind of reason.
  for (const s of denyUsers) {
    if (!looksLikeAccount(s)) throw new FeaturesConfigError(`a gate object's "users.deny" entry is not a user@domain: ${s}`);
  }
  return { users, denyUsers, wroteAllow: u.allow !== undefined };
}

export function gateLevels(gate: Gate): GateShape {
  if (typeof gate === 'string') return { levels: [gate], users: [], hasUsers: false, hasRawRules: false, ccOnly: ccOnlyLevels([gate]), denyUsers: [] };
  if (Array.isArray(gate)) {
    if (gate.every((g) => typeof g === 'string')) {
      const levels = gate as string[];
      return { levels, users: [], hasUsers: false, hasRawRules: false, ccOnly: ccOnlyLevels(levels), denyUsers: [] };
    }
    if (gate.every((g) => !!g && typeof g === 'object' && !Array.isArray(g))) {
      // Validate every string-list field of every rule, not just the `users` this function reads: these
      // rules go through `resolveGate` verbatim into the policy engine, so a non-string ANYWHERE in one
      // of them is the same raw TypeError. A non-ARRAY field was previously ignored outright here, which
      // let `{"users":"a@b.example"}` reach `inList()` and crash on `.some`.
      const users: string[] = [];
      const perRuleDenies: string[][] = [];
      for (const r of gate as Record<string, unknown>[]) {
        const denies: string[] = [];
        for (const field of RULE_STRING_FIELDS) {
          const v = r[field];
          if (v === undefined) continue;
          const where = `a raw policy rule's "${field}"`;
          if (!Array.isArray(v)) throw new FeaturesConfigError(`${where} must be an array of strings, got ${typeName(v)}`);
          const strings = requireStringList(v, where);
          if (field === 'users') users.push(...strings);
          if (field === 'notUsers') denies.push(...strings);
        }
        // ⚠️ The SAME shape check the object form's `users.deny` gets, for the same reason and with the
        // same failure direction: a denial naming something that cannot be an account denies nobody, and
        // does it silently. Checking one spelling of the mechanism and not the other left the loud half
        // guarding the quiet half's mistakes.
        for (const s of denies) {
          if (!looksLikeAccount(s)) throw new FeaturesConfigError(`a raw policy rule's "notUsers" entry is not a user@domain: ${s}`);
        }
        // A rule that only denies never matches (the engine's `hasCondition` refuses it), which is
        // fail-closed but silent — it reads as a working denial and is dead config. Say so.
        const admits = ['scopes', 'domains', 'users', 'operators', 'masking'].some((f) => r[f] !== undefined);
        if (denies.length && !admits) {
          throw new FeaturesConfigError('a raw policy rule naming only "notUsers" can never match: a rule must say who it admits (scopes, domains, users, operators or masking) before a denial can narrow it');
        }
        perRuleDenies.push(denies);
      }
      // Raw rules name scopes directly, not levels, so "every level is call-center" is not decidable —
      // and the superadmin union has always applied to them. false, deliberately, not unknown.
      //
      // `denyUsers` is the INTERSECTION of every rule's denials, and it exists for one rule the operator
      // cannot reach: the `{users: superadmins}` union `resolveGate` appends behind their back. They put
      // a denial on every branch they wrote and a superadmin still sailed through the branch they did
      // not know about — the same denial, written two ways, giving opposite answers. An account denied
      // in EVERY branch they wrote is denied as far as their config can say; one denied in only some
      // branches was deliberately left a path, and closing it would be us overruling them.
      const denyUsers = perRuleDenies.length
        ? perRuleDenies.reduce((acc, d) => acc.filter((x) => d.some((y) => y.trim().toLowerCase() === x.trim().toLowerCase())))
        : [];
      return { levels: [], users, hasUsers: users.length > 0, hasRawRules: true, ccOnly: false, denyUsers };
    }
    throw new FeaturesConfigError('a gate array must be all level names or all rule objects, not a mix');
  }
  if (gate && typeof gate === 'object') {
    const g = gate as { levels?: unknown; users?: unknown };
    if (g.levels !== undefined && !Array.isArray(g.levels)) {
      throw new FeaturesConfigError(`a gate object's "levels" must be an array of level names, got ${typeName(g.levels)}`);
    }
    // ⚠️ UNKNOWN KEYS ARE REFUSED, NOT IGNORED — and the deny-only expansion is what made this
    // load-bearing. An ignored `"level"` (singular) used to leave a gate that was either loudly invalid
    // or narrower than intended; now it leaves a gate naming no allow side, which `parseFeatures` reads
    // as "this feature's default, minus these" — and that default can be WIDER than the levels the
    // operator typed. `{"level":["reseller"],"users":{"deny":[…]}}` on a key defaulting to
    // office_manager would silently grant office managers. A typo must never widen a gate.
    for (const k of Object.keys(g)) {
      if (k !== 'levels' && k !== 'users') {
        throw new FeaturesConfigError(`a gate object accepts only "levels" and "users", got "${k}"`);
      }
    }
    const wroteLevels = g.levels !== undefined;
    const levels = requireStringList(g.levels ?? [], `a gate object's "levels"`);
    const { users, denyUsers, wroteAllow } = gateUsers(g.users);
    const hasUsers = users.length > 0;
    if (!levels.length && !hasUsers) {
      if (!denyUsers.length) throw new FeaturesConfigError('a gate object needs levels or users');
      // An allow side WRITTEN but empty is the operator saying "nobody", on either axis. It must not
      // fall through to `parseFeatures`' deny-only expansion, whose meaning — "this feature's default,
      // minus these" — is the widest possible misreading of what was typed. `"levels": []` and
      // `"allow": []` are the same statement on two axes and get the same answer.
      if (wroteLevels || wroteAllow) {
        throw new FeaturesConfigError('a gate object needs levels or users: an empty "levels" or "allow" list names nobody. Omit them entirely to mean "this feature\'s default, minus the deny", or name who keeps it.');
      }
    }
    return { levels, users, hasUsers, hasRawRules: false, ccOnly: ccOnlyLevels(levels), denyUsers };
  }
  throw new FeaturesConfigError(`unrecognized gate shape: ${JSON.stringify(gate)}`);
}

/**
 * Fold a deny into a base gate, preserving whatever the base already said.
 *
 * Only ever called with a REGISTRY DEFAULT as the base (see {@link expandDenyOnly}), which today is
 * always a level name — the other branches are there so a future default of another shape does not
 * silently lose its deny. Raw rules cannot be expressed as a gate object, so the deny goes onto each
 * rule instead, which is the same distribution `resolveGate` performs.
 */
function applyDeny(base: Gate, deny: string[]): Gate {
  if (base === 'off') return 'off'; // nothing to subtract from; still admits nobody
  if (typeof base === 'string') return { levels: [base], users: { deny } };
  if (Array.isArray(base)) {
    if (base.every((b) => typeof b === 'string')) return { levels: base as string[], users: { deny } };
    return (base as PolicyRule[]).map((r) => ({ ...r, notUsers: [...(r.notUsers ?? []), ...deny] }));
  }
  const b = base as { levels?: string[]; users?: GateUsers };
  const allow = Array.isArray(b.users) ? b.users : b.users?.allow ?? [];
  const baseDeny = Array.isArray(b.users) ? [] : b.users?.deny ?? [];
  return {
    levels: b.levels ?? [],
    users: { ...(allow.length ? { allow } : {}), deny: [...baseDeny, ...deny] },
  };
}

/**
 * A gate that ONLY denies means "this feature's default, minus these accounts".
 *
 * Without this, `{"users":{"deny":["…"]}}` would resolve to no allow rules at all and lock everyone
 * out — because `parseFeatures` takes the override OR the default and never merges them. That is the
 * exact opposite of what the operator wrote, and it is the config an operator is most likely to write,
 * since "everyone who has this today, except one person" is the whole reason the deny form exists.
 *
 * It lives HERE rather than in `resolveGate` because this is the one place holding both the key and its
 * registry default (the `allowedLevels` floor already needs both). `resolveGate` stays self-contained
 * and never learns which key it is resolving.
 *
 * ⚠️ It is therefore the single place a gate is not self-describing, which is why `gateInWords` must
 * render what came OUT of here and never the config as written — an exception with no base named is a
 * console describing a gate nobody configured.
 */
function expandDenyOnly(gate: Gate, def: FeatureDef): Gate {
  if (gate === 'off') return gate;
  const shape = gateLevels(gate); // throws on an unrecognized shape — fail closed, before anything else
  const namesAnAllowSide = shape.levels.length > 0 || shape.hasUsers || shape.hasRawRules;
  if (namesAnAllowSide || !shape.denyUsers.length) return gate;
  return applyDeny(def.default, shape.denyUsers);
}

/** PORTAL_FEATURES → { key: gate } ({} if unset). Throws on bad JSON or an unknown feature key.
 *
 *  Returns the EFFECTIVE gates — deny-only overrides already expanded against their feature's default,
 *  which is what every enforcement and every piece of prose must read. When you need the config as the
 *  operator typed it, use {@link parseFeaturesDetailed}; the difference matters in exactly one place and
 *  it is documented there. */
export function parseFeatures(env: FeaturesEnv): Record<string, Gate> {
  return parseFeaturesDetailed(env).effective;
}

/**
 * Both views of `PORTAL_FEATURES`, from ONE walk: `effective` (deny-only expanded) and `written` (what
 * the operator actually typed).
 *
 * ⚠️ The distinction exists for the console's copyable JSON, and it is not cosmetic. A deny-only gate
 * means "this feature's default, minus these accounts" — it TRACKS the default. Expanded, it pins today's
 * default as a literal. An operator who copies "your current overrides" out of the console and pastes it
 * into their config would therefore freeze the base against any future change to the registry default:
 * the exact slow, silent rot that the deny form was added to eliminate, reintroduced through the button
 * offering to help. So the console shows prose from `effective` (it must describe what is enforced) and
 * JSON from `written` (it must be safe to paste back).
 */
export function parseFeaturesDetailed(env: FeaturesEnv): { effective: Record<string, Gate>; written: Record<string, Gate> } {
  const raw = (env.PORTAL_FEATURES ?? '').trim();
  if (!raw) return { effective: {}, written: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new FeaturesConfigError('PORTAL_FEATURES is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new FeaturesConfigError('PORTAL_FEATURES must be a JSON object');
  const known = new Set(featurePolicyKeys());
  const out: Record<string, Gate> = {};
  const written: Record<string, Gate> = {};
  for (const [k, rawGate] of Object.entries(parsed as Record<string, Gate>)) {
    if (!known.has(k)) throw new FeaturesConfigError(`PORTAL_FEATURES has an unknown feature key: ${k}`);
    // The floor (see FeatureDef.allowedLevels). Checked HERE, at the config-ingestion boundary, because
    // this is the only place a key and its gate are both in hand — resolveGate never learns which key
    // it is resolving.
    const def = FEATURE_REGISTRY.find((f) => f.key === k);
    // Expand a deny-only gate BEFORE the floor is checked, so the floor sees the levels that will
    // actually be resolved. Those come from the feature's own default, so they are within the floor by
    // construction — and a deny can only ever narrow, so this direction cannot breach one.
    const v = def ? expandDenyOnly(rawGate, def) : rawGate;
    if (def?.allowedLevels) {
      const shape = gateLevels(v);   // throws on an unknown shape — do not soften this
      if (shape.hasRawRules) {
        throw new FeaturesConfigError(`PORTAL_FEATURES["${k}"] may not use raw policy rules: a raw rule can name any scope, which would bypass this feature's allowed levels (${def.allowedLevels.join(', ')})`);
      }
      if (shape.users.length && !def.usersBackstop) {
        throw new FeaturesConfigError(`PORTAL_FEATURES["${k}"] may not name users directly: this feature is bounded to the levels ${def.allowedLevels.join(', ')}, and naming an account bypasses that with nothing behind it to refuse the caller a second time.`);
      }
      const bad = shape.levels.filter((l) => !def.allowedLevels!.includes(l));
      if (bad.length) {
        throw new FeaturesConfigError(`PORTAL_FEATURES["${k}"] may only name these levels: ${def.allowedLevels.join(', ')} — refusing ${bad.join(', ')}. This feature discloses configuration covering more than one domain, and every scope below reseller is domain-locked.`);
      }
    }
    out[k] = v;
    written[k] = rawGate;
  }
  return { effective: out, written };
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
