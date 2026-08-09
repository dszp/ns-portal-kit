/**
 * The setting descriptor table — one row per `interface Env` key in `worker.ts`, rewritten for an
 * OPERATOR (someone who deployed this kit and needs to know what to set), not for a developer reading
 * source. `src/statusModel.selftest.ts` is the drift guard: it parses `interface Env` as text and
 * asserts set-equality against this table, so a key added to Env without a row here fails the tests.
 *
 * Pure data + types only — no I/O, no env reads. `src/status.ts` (a later task) composes this table
 * with the actual `env` to build a `StatusDoc`; this module never sees a live deployment.
 */

export type SettingKind = 'secret' | 'config';
export type SettingGroup =
  | 'core' | 'branding' | 'domains' | 'ringotel' | 'eligibility'
  | 'appaccess' | 'menus' | 'injection' | 'events' | 'identity' | 'bindings';

/** How consequential this setting is. Absent ⇒ `normal`. It orders rows within a group and drives visual
 *  weight: a flat list of 64 equals implies `NS_SERVER` and `RINGOTEL_LABEL_SHORT` matter the same amount,
 *  and they do not. */
export type SettingImportance = 'critical' | 'important' | 'normal' | 'minor';


export interface SettingDef {
  name: string;            // the env key, verbatim
  group: SettingGroup;
  kind: SettingKind;
  /** A REAL default value, when absence means "this value is used instead". Distinct from `whenUnset`,
   *  which describes the CONSEQUENCE of absence — `NS_SERVER` has no default, it has a consequence
   *  ("nothing works"), and labelling that "Default" would be false. Only one of the two is a value. */
  defaultValue?: string;
  importance?: SettingImportance;
  /** The setting that must be configured before this one does anything. Names the relationship on the
   *  row itself, so a reader never has to infer why a whole block is inert — and so the twelve
   *  `NS_EVENTS_*` settings finally say out loud that they exist to keep the app directory in sync. */
  gatedBy?: string;
  /** A literal example value — the thing to actually type. Prose describing a syntax is not a syntax. */
  example?: string;
  what: string;            // operator-facing one-liner: what this controls
  whenUnset: string;       // what happens with no value
  affects: string[];       // feature keys / subsystem ids this setting governs
}

/** Render order for the Config tab, most consequential first. Declaration order in `SETTINGS` mirrors
 *  `interface Env` (so a reviewer can read the two side by side) — which is the right order for auditing
 *  the table and the wrong one for reading the page. */
export const GROUP_ORDER: SettingGroup[] = [
  'core', 'domains', 'injection', 'menus', 'ringotel', 'eligibility',
  'appaccess', 'events', 'identity', 'branding', 'bindings',
];

export const GROUP_LABEL: Record<SettingGroup, string> = {
  core: 'Core', domains: 'Domain limits', injection: 'Portal injection',
  menus: 'Portal menus', ringotel: 'App integration', eligibility: 'Activation rules',
  appaccess: 'Self-service app access', events: 'Change events', identity: 'Background service identity',
  branding: 'Branding', bindings: 'Worker bindings',
};

export const GROUP_BLURB: Record<SettingGroup, string> = {
  core: 'What this deployment is and how it authenticates.',
  domains: 'App-layer limits on which NetSapiens domains this deployment will touch.',
  injection: 'What gets served to the Manager Portal, and who may receive it.',
  menus: 'Adding and hiding entries in the portal\'s stock menus. Two settings can hide an Apps entry; setting both merges them.',
  ringotel: 'The softphone app integration. Everything below it is inert without an API key.',
  eligibility: 'Which extensions are treated as real people when the app is activated.',
  appaccess: 'What a signed-in user is told about their own app access.',
  events: 'Keeping the app directory in sync with changes made directly in NetSapiens.',
  identity: 'The credential used for writes that have no caller — event handling only.',
  branding: 'Cosmetic name and accent colour.',
  bindings: 'Structural Worker bindings, not `vars` strings.',
};

export const SECRET_WHY_NOT =
  'Set as a secret (`wrangler secret put <NAME>`). A Worker cannot read a secret back or write its own ' +
  'environment, so this console reports only whether it is present.';
export const CONFIG_WHY_NOT =
  'Set in `wrangler.jsonc` `vars` for this environment (vars are NOT inherited between environments). ' +
  'A Worker cannot write its own environment; editing from here would need a config store (KV or D1), ' +
  'which does not exist yet.';
/** A `group: 'bindings'` row is a structural Worker binding, NOT a `vars` string — telling an operator to
 *  add `ASSETS` or `JWT_RATE_LIMITER` to `vars` (which CONFIG_WHY_NOT did) sends them to add a string that
 *  creates no binding, and the loud "no ASSETS R2 binding is bound" 500 does not go away. Selected on
 *  `group`, not on a third `SettingKind`: `kind` is the secret/not-secret axis and `statusModel.selftest.ts`
 *  asserts set-equality on it. */
export const BINDING_WHY_NOT =
  'Declared as a binding in `wrangler.jsonc` for this environment — an `r2_buckets` / `ratelimits` entry, ' +
  'not a `vars` string, so adding a var named <NAME> would not create it (bindings are not inherited ' +
  'between environments either). A Worker cannot change its own bindings: add it and redeploy.';

export const settingNames = (): string[] => SETTINGS.map((s) => s.name);

export type FeatureState = 'on' | 'off' | 'inert' | 'misconfigured' | 'not-integrated';
export interface MissingRequirement { setting: string; why: string; how: string }

/** Whether a setting can do anything in THIS deployment's mode, and why not when it cannot. Not the same
 *  question as `set` — an applicable-but-unset setting and an inapplicable-but-set one are different
 *  situations, and only one of them is worth an operator's attention. */
export interface Applicability { applicable: boolean; why: string | null }

/** The gate a setting sits behind, resolved against this deployment. `satisfied: false` ⇒ the setting is
 *  configured but doing nothing, which is the state item 10 of the UX spec exists to make visible. */
export interface SettingGate { setting: string; satisfied: boolean }

/** A copy-ready rendering of one JSON-ish value, in the two forms an operator needs: readable, and
 *  paste-ready. See `wranglerLine` for why both exist. */
export interface CopyForms {
  /** Pretty-printed, for reading and editing. Null when the value is not JSON. */
  pretty: string | null;
  /** The exact `wrangler.jsonc` line, with the value escaped as the JSON string a var must be. */
  wrangler: string;
}

export interface SettingView {
  name: string; group: SettingGroup; kind: SettingKind;
  what: string; whenUnset: string; affects: string[];
  set: boolean;
  /** The value, or null when unset OR when kind === 'secret'. NEVER a secret's value. */
  value: string | null;
  source: 'default' | 'env';
  editable: false;
  whyNot: string;
  /** The literal thing to type to set this, mechanism-correct per kind/group (a `vars` entry, a
   *  `wrangler secret put`, or a binding). Prose telling a reader where a value goes is not the same as
   *  showing them the line. */
  howToSet: string;
  defaultValue: string | null;
  importance: SettingImportance;
  example: string | null;
  gate: SettingGate | null;
  applicability: Applicability;
  /**
   * The CURRENT value in both forms — readable, and ready to paste into `wrangler.jsonc`.
   *
   * A var's value is a JSON *string*, so an object-valued setting has to be embedded with every quote
   * backslashed. The console was showing the pretty form (good for reading) and a generic escaped EXAMPLE
   * (good for nothing, once you have a real value), which left an operator hand-escaping their own edit —
   * the single most annoying thing about changing one of these. Null for a secret, and for anything unset.
   */
  copy: CopyForms | null;
}

/**
 * Who a feature is FOR. `admin` features act on other people's accounts, so "can you use this" is a useful
 * thing to tell the reader. `self` features act on the reader's own account and are consumed by that
 * operator's END USERS — a superadmin passing `me.devices` says nothing about whether a Basic User sees
 * their own device list, which is the only question an operator has about it.
 */
export type FeatureAudience = 'admin' | 'self';

export interface FeatureCard {
  key: string; name: string; description: string;
  audience: FeatureAudience;
  /** WHY this exists and how to use it — see `FeatureDef.detail`. Empty when the one-liner suffices. */
  detail: string[];
  state: FeatureState;
  gate: { source: 'default' | 'PORTAL_FEATURES'; inWords: string; rules: unknown[] };
  /** Whether the VIEWER passes. Rendered only when false — see `PermissionsView` for why: a superadmin
   *  passes every non-`off` gate by construction, so "you pass" is true on ~16 of 18 cards on every
   *  deployment forever, and a row that cannot vary carries no information. "You do NOT pass" can. */
  viewerPasses: boolean;
  missing: MissingRequirement[];
  settings: string[];      // names into SettingView[]
  notes: string[];
}

/**
 * Which tab a subsystem belongs on. The previous split was "is it in FEATURE_REGISTRY" — a fact about our
 * code that an operator has no reason to know, and it put nine things that are not integrations on a tab
 * called Integrations.
 *
 *  - `integration` — an external system this deployment talks to.
 *  - `deployment`  — how this Worker itself runs.
 */
export type SubsystemTab = 'integration' | 'deployment';

export interface SubsystemCard {
  id: string; name: string; description: string; group: SettingGroup;
  /** WHY this exists, and why it has several options — see `SUBSYSTEM_DETAIL`. Paragraphs, rendered above
   *  the disclosure: `description` is the skim line, this is the explanation, and the settings list behind
   *  the disclosure is reference. Empty array when a card genuinely has nothing to add. */
  detail: string[];
  tab: SubsystemTab;
  /**
   * The `id` of the subsystem this one is PART OF, when it is not a peer. Activation rules, the write
   * rail, SSO, change events and offboarding are not siblings of the app integration — they are aspects
   * of it, and every one is inert without its API key. Rendering them as nine unrelated cards is what
   * made "why is this whole block off" a question the page could not answer.
   */
  parent: string | null;
  state: FeatureState;
  missing: MissingRequirement[];
  settings: string[];
  notes: string[];
}

// ── permissions ───────────────────────────────────────────────────────────────────────────────────────

/**
 * One cell of the permissions matrix: what a person of a given NS scope would actually get.
 *
 * Five verdicts, because "allowed" and "works" are different answers and a matrix that conflated them
 * would confidently tell a domain-locked Office Manager they can open this console:
 *
 *  - `yes`      — passes the feature's own gate, receives the bundle that carries it, and its
 *                 prerequisites are met.
 *  - `no`       — the feature's gate does not admit this scope.
 *  - `blocked`  — passes its own gate, but a SECOND gate refuses: the delivery bundle
 *                 (`portal.access` / `portal.self`), or the console's structural fleet-read rule.
 *  - `inert`    — passes every gate, but the feature cannot run as configured (a missing setting).
 *  - `broken`   — the deployment has a config error that makes this feature's own path unverifiable.
 */
export type CellVerdict = 'yes' | 'no' | 'blocked' | 'inert' | 'broken';

/**
 * How a cell's verdict compares to what the BUILT-IN default gate would have given.
 *
 * The row-level "overridden" badge says *this feature was configured*; this says *what the configuration
 * actually did*, per cell, in both directions — which the badge cannot express at all. `revoked` matters as
 * much as `granted`: an override that takes access away is the easier one to write by accident.
 */
export type CellDelta = 'granted' | 'revoked' | null;

export interface PermissionCell { scope: string; verdict: CellVerdict; why: string; delta: CellDelta }

export interface PermissionRow {
  key: string; name: string;
  audience: FeatureAudience;
  state: FeatureState;
  gateInWords: string;
  source: 'default' | 'PORTAL_FEATURES';
  /** `FeatureDef.allowedLevels` — how far config may widen this gate, in LEVEL names. */
  floor: string[] | null;
  /** The NS SCOPES that `floor` puts out of reach — i.e. columns config could never grant, however the
   *  operator writes it. Resolved here rather than in the renderer because it is gating semantics (a level
   *  admits its own scope and everything above it), not presentation: someone who tries to grant past the
   *  floor gets a 500 at deploy time, and learning that rule from a crash is learning it the hard way. */
  floorBlocks: string[];
  cells: PermissionCell[];
  /** The named-superadmin column: `PORTAL_SUPERADMINS` grants at ANY scope, so it is an axis of its own
   *  rather than a rung on the ladder. */
  superadmin: PermissionCell;
  /**
   * The per-feature named-account column: an account this gate's own `users:` list grants, evaluated the
   * same way as the superadmin axis (at the lowest scope, so it isolates what a NAME alone buys). Null
   * when the gate names nobody.
   *
   * It exists because a name is not a bypass, and the scope columns cannot show that: they evaluate a
   * GENERIC account of each scope, so a `users:` grant to a domain-locked Office Manager reads `no` there
   * for the wrong reason — the gate does admit them; a second gate refuses. Without this column the
   * matrix would be silent on exactly the hole `fleetReadAllowed` exists to close.
   */
  named: PermissionCell | null;
  /** The accounts that gate names directly, for the column above. */
  namedAccounts: string[];
  /** Sort/group key for the matrix: administrative rows first, then self-service, with a divider between.
   *  Driven by `audience` rather than left to `FEATURE_REGISTRY` declaration order — the two blocks are
   *  currently adjacent only by coincidence, and a future registry insertion would interleave them. */
  audienceRank: 0 | 1;
}

export interface PermissionsView {
  /** The NS scope ladder, in descending order of privilege — the matrix columns. */
  columns: string[];
  rows: PermissionRow[];
  superadmins: string[];
  /** What the evaluation assumed, stated rather than implied. A matrix is a claim about people who are
   *  not in the room; the reader has to be able to check what was held constant. */
  assumptions: string[];
  /** `PORTAL_FEATURES` as configured today, pretty-printed — round-trips, and stays subject to registry
   *  defaults. Empty string when nothing is overridden. */
  jsonOverrides: string;
  /** Every registry key with its effective gate. Unambiguous, but it PINS every feature: a later release
   *  that changes a default will not reach a deployment using this. Labelled with that consequence. */
  jsonExplicit: string;
  /**
   * Whether ANY gate names an account directly. The Named column renders only when this is true — an
   * always-dash column is the same dead-row defect item 18b removed from the feature cards, and it was
   * reintroduced here one commit later. `users:` grants are the escape hatch, not the norm, so on most
   * deployments this is false and the column should simply not exist.
   */
  anyNamed: boolean;
  /**
   * Worked examples of every gate shape, so the tab teaches what is POSSIBLE and not only what this
   * deployment already does. Every one is run through `parseFeatures` by the selftest, so the console's own
   * documentation cannot drift from its own validator.
   */
  examples: { title: string; what: string; json: string }[];
  /** Non-null when the emitted JSON would be REFUSED by this deployment's own validator — which would
   *  mean the console had handed out a config that bricks the Worker at boot. */
  jsonError: string | null;
}
export interface ProbeResult {
  id: string; name: string;
  state: 'pass' | 'fail' | 'skip';
  detail: string;
  cost: string;
}

/** One live check, as declared BEFORE it runs. `what` is the standing description (what this check does
 *  and with which credential); `cost` is what running it spends. A `ProbeResult`'s `detail` is the OUTCOME
 *  of one run — a different fact, which is why both fields exist. */
export interface ProbeCatalogEntry { id: string; name: string; what: string; cost: string }

/** Every catalogued check applies here: there is one deployment shape, so nothing is filtered out.
 *  Kept as a function because both the runner and the not-run renderer call it, and a future
 *  per-deployment filter (a check that needs a binding, say) belongs behind this name. */
export function probeCatalogFor(): ProbeCatalogEntry[] {
  return PROBE_CATALOG;
}

/**
 * THE ONE list of live checks. `runProbes` (`statusProbes.ts`) produces exactly one result per row, in
 * this order, and the Checks tab renders the not-run state from these same rows.
 *
 * It lives here, in the pure-data module, for two reasons. The renderer must be able to describe the
 * checks WITHOUT importing the I/O module — and, before this table was shared, `statusPage.ts` carried its
 * own hand-written list of three checks that disagreed with the six that actually run: it promised a live
 * `/jwt` verification probe that does not exist, claimed the NetSapiens read uses the background service
 * credential (it uses the caller's own delegated `ns_t`), and omitted the two probes that mint a token and
 * list every subscription on the account. Since that list was the DEFAULT render, it was the first thing
 * every operator saw. Keep `what` honest about WHICH credential each check uses and what it costs: the
 * whole purpose of this panel is informed consent before touching production.
 */
export const PROBE_CATALOG: ProbeCatalogEntry[] = [
  {
    id: 'ns-read', name: 'NetSapiens delegated read',
    what: 'Reads the domain of the current session from the NetSapiens API using YOUR OWN delegated ns_t — not the background service credential. Skipped when the session carries no token or no domain.',
    cost: 'One GET to the NetSapiens API using the current session.',
  },
  {
    id: 'ns-identity', name: 'NetSapiens service identity',
    what: 'Attempts to obtain the background service credential used for writes that have no caller (event handling): an OAuth grant for NS_ADMIN_USER/NS_ADMIN_PASS, or a presence check for NS_API_KEY. Skipped when neither is configured.',
    cost: 'Attempts to mint the background service credential — an OAuth grant for admin credentials, nothing over the network for an API key.',
  },
  {
    id: 'ringotel', name: 'Ringotel AdminAPI',
    what: 'Calls the Ringotel AdminAPI with RINGOTEL_API_KEY (one getOrganizations read — never a fleet-wide directory dig). Skipped when Ringotel is not configured.',
    cost: 'One getOrganizations call to the Ringotel AdminAPI.',
  },
  {
    id: 'ns-events', name: 'Event subscriptions',
    what: 'Obtains the service credential, then lists EVERY event subscription on the NetSapiens account and partitions it by the callback prefix this deployment owns — the same read the reconcile itself makes. Skipped unless event subscriptions are armed and the service-identity check passed.',
    cost: 'One OAuth grant (if needed) plus one flat subscription-list read — the same call the reconcile itself makes.',
  },
  {
    id: 'status-banner', name: 'Status banner endpoint',
    what: 'Calls STATUS_BANNER_WEBHOOK exactly as the injected code does — the same POST, carrying YOUR OWN ns_t — and reports whether the reply is one this kit can render. Skipped when the setting is unset. The failure this exists for is silent: an endpoint that answers 200 with a body carrying none of the keys the parser accepts draws no banner and reports no error, which from inside the portal is indistinguishable from the feature being off.',
    cost: 'One POST to the endpoint YOU configured, carrying the current session\'s ns_t — the same request every portal page load already makes.',
  },

  {
    id: 'onebill-documo', name: 'OneBill / Documo',
    what: 'Nothing to check — neither integration is wired into this Worker.',
    cost: 'No network call — not integrated.',
  },
];
/**
 * A concrete URL this deployment serves or calls, with what it is for.
 *
 * The console reported which settings were set and never what they add up to — an operator had to assemble
 * `https://` + hostname + `PRIMARY_BASENAME` + `.js` in their head to get the one string they actually need
 * to paste into a portal. `verifiable: false` marks the ones this Worker cannot confirm from inside a
 * request, which matters most for the primary: serving it says nothing about whether any portal is loading it.
 */
export interface Endpoint {
  label: string;
  url: string | null;
  /** What to show when there is no URL. Absent ⇒ "not set". Exists because `PORTAL_HANDOFF_URL=""` is a
   *  DECLARATION ("there is no vendor to hand off to"), not an omission, and rendering both "not set" and
   *  "declared as none" on one card states two different things about the same value. */
  emptyLabel?: string;
  what: string;
  direction: 'serves' | 'calls';
  verifiable: boolean;
}

/** One supported menu, as this deployment's config resolves it. */
export interface MenuView {
  /** The config key: `apps` | `account` | `management`. */
  name: string;
  /** What an operator calls it. */
  label: string;
  /** Where it is in the portal, in one line — so a reader can tell which dropdown this is without guessing. */
  what: string;
  /** Stock entries hidden at the untargeted rung. */
  hide: string[];
  /** Entries added at the untargeted rung. */
  add: { label: string; url: string; title?: string }[];
  /** Whether this menu's config varies by domain, scope or app state. A flat list resolves the same for
   *  everyone; a targeted one does NOT, and a page that showed one rung as "the config" would be lying to
   *  every user the other rungs apply to. */
  targeted: boolean;
}

/**
 * The Menus tab's model: what the menu config currently does, plus what the builder needs to start from.
 *
 * Resolved at a deliberately UNTARGETED probe rung (a domain no config names, no app active), not for the
 * reader. This tab describes the deployment's configuration; a view that resolved for whoever opened it
 * would show a different "current state" to each operator and there would be no way to tell which was the
 * real one. `targeted` marks the menus where that distinction bites.
 */
export interface MenusView {
  menus: MenuView[];
  /** Whether either menu setting carries anything at all. */
  configured: boolean;
  /** `PORTAL_MENUS` pretty-printed, or '' when unset — the builder's starting point. */
  raw: string;
  /** `menuConfigError`'s verdict on the LIVE config, so the tab can lead with it. */
  error: string | null;
  /** Set only when both apps-menu hide settings are in play, so the tab can attribute each label. */
  appsHide: { legacy: string[]; menus: string[] } | null;
}

export interface StatusDoc {
  deployment: {
    productName: string; version: string; hostname: string; cacheScope: string;
    mode: 'portal-backend' | 'standalone'; nsServer: string;
    envBadge: string; configured: boolean;
    /** Where the version number links, or null when this deployment declared it should not link. */
    releaseNotesUrl: string | null;
    endpoints: Endpoint[];
  };
  viewer: {
    id: string; scope: string; domain: string;
    masquerading: boolean; operator: string | null;
    grantedBy: 'superadmin' | 'level' | 'named-user' | 'unknown';
  };
  issues: { level: 'blocker' | 'warning'; title: string; detail: string; fix: string }[];
  configErrors: { subsystem: string; reason: string }[];
  features: FeatureCard[];
  subsystems: SubsystemCard[];
  settings: SettingView[];
  permissions: PermissionsView;
  menus: MenusView;
  probes: ProbeResult[] | null;
}

/**
 * WHY each subsystem exists, and why it has the shape it has.
 *
 * `description` on a card answers *what is this* in one line. This answers the two questions a one-liner
 * cannot: **why does this exist at all**, and — the one nothing in the console addressed before — **why are
 * there several options**. A reader looking at three independent exclusion mechanisms, or two ways to supply
 * one credential, cannot tell from a name whether they are alternatives, layers, or historical accident; and
 * two of those three readings lead to configuring it wrong.
 *
 * Written for an operator who deployed this and is deciding what to set, not for a developer reading source.
 * Neutral: no customer, no deployment literal, no brand — this ships to a public mirror.
 *
 * `statusModel.selftest.ts` asserts every subsystem id has an entry, so a card cannot acquire a state and no
 * explanation. Features and the Deployment tab get the same treatment in their own pass; this table is keyed
 * by id so adding them is additive.
 */
export const SUBSYSTEM_DETAIL: Record<string, string[]> = {
  ringotel: [
    '[Ringotel](https://www.ringotel.com) is a third-party app that can be connected to NetSapiens extensions, with optional white labeling available. This integration helps link and maintain the connection between the two systems, to make the experience more seamless for users. This is an unofficial integration.',
    '### What it gives you',
    'The connection to the softphone app platform. On its own it does one thing: it lets this deployment read the app directory, so the portal can tell you whether a given extension has an app account and whether that account is active. That is what turns an app column on the Users page, the banner in the toolbar, and the indicator on a user profile from guesses into facts.',
    '### Why its parts are nested, not beside it',
    'Everything nested below is part of this integration rather than a peer of it, and every one of them is inert until an API key is present. That is why they are drawn underneath: they are not separate systems you could enable independently, they are what this integration is allowed to do once it can see the directory.',
    '### Reading and writing are separate',
    'Reading tells you the state; writing changes it. Reading tells you the state; writing changes it, and writing needs both a feature gate (who may) and a write rail (where they may) before anything happens.',
  ],
  eligibility: [
    'Not every extension in a NetSapiens domain is a person. Shared lines, voicemail-only boxes, fax extensions, conference rooms and routing-only extensions all look like users to the API. Activating one costs a seat, and — depending on how the app platform is configured — can send a welcome mail to whatever address is on the record. These rules exist so a whole-domain operation does not do that.',
    '### Why three mechanisms',
    'None of them is reliable alone. A name matcher catches "SHARED VOICEMAIL" and "CONF RM", but naming is a convention rather than a structure, and it varies per customer. An extension pattern catches a numbering block set aside for non-people, but the block differs in every domain. The device heuristic catches an extension with no phones registered, which is a hint rather than a fact — a new hire who has not been given a handset yet looks identical to a routing extension.',
    '### Layers, not alternatives',
    'Each one is narrow and each one has false positives; together they are conservative enough to be safe as a default and loose enough not to block real people. Every exclusion here is soft: it stops a device being created for the first time, and it never blocks a user who is already active from signing in.',
    '### One trap',
    'Providing your own name list replaces the built-in one rather than adding to it. If you want the defaults plus one of your own, list the defaults too — the Config tab shows them.',
  ],
  writes: [
    'This is the answer to a different question than the feature gates ask. A feature gate decides who may perform an action. This decides where the action may happen. Both must agree before anything is written.',
    '### Why it is separate from the feature gate',
    'They fail differently. A gate misconfiguration hands a capability to the wrong people, which you notice. A missing rail lets a correct person run a whole-domain operation against a domain nobody meant to touch, which you may not notice until a customer asks why their users got mail. Naming the domains is a cheap, explicit boundary that does not depend on getting every gate right.',
    '### Fail-closed on empty',
    'Unset means every write is refused, not that every write is allowed: unset means every write is refused, not that every write is allowed. That is deliberate and it is the opposite of how the allow-lists elsewhere behave, because the cost of the two mistakes is not symmetrical — a refused write is an error message, and an unintended one has already happened.',
  ],
  appaccess: [
    'A user who cannot sign in to the app raises a ticket. This is the surface that tries to prevent that: it tells a signed-in user what their app sign-in actually is — which server or domain, which username, whether single sign-on is available to them, and where to download the client — using their own record rather than a generic help page.',
    '### Why it is its own thing',
    'Its audience is different. Everything else here is read or written by an administrator about somebody else. This is read by the end user about themselves, which is why it is gated separately and why it is careful never to claim a capability it has not verified.',
    'The download links are configuration rather than something derivable, because which client an operator wants their users to install is a decision, not a fact about the platform.',
  ],
  sso: [
    '### This setting does not make single sign-on work',
    'It tells this portal that SSO exists for your users, so it can show the right indicators, expose the right settings, and manage user lifecycle around it. Turning it on without the pieces below means the portal confidently tells your users about a sign-in method that will not work for them.',
    'Three separate things have to be true before SSO functions at all, and this kit is only responsible for the third:',
    '1. A separate Worker. The SSO handler itself is [ringotel-ns-sso](https://github.com/dszp/ringotel-ns-sso), its own deployment — it receives the app platform\'s authenticate webhook, validates the user against NetSapiens, and answers. It is not part of this kit and this kit cannot see whether it is running. Deploy and configure it independently.',
    '2. Enablement on the app platform side. Single sign-on has to be turned on for your organisations by the platform\'s own support, pointed at that Worker, and it may be a licensed capability on their side. Nothing you set here reaches them, and nothing here can verify they have done it.',
    '3. This kit: the portal-side surface. The visual indicators that tell a user SSO is their sign-in method, the settings around it, and the user lifecycle handling that keeps an app account consistent when a user is created, changed or removed. That is what this setting switches on.',
    '### Why it fails closed',
    'It has to be configured explicitly, and unset means never claim SSO rather than "detect it". An app organisation can have a single-sign-on service bound to a completely different identity provider than the one you run, so inferring from the presence of a binding would send a user to somebody else\'s login. Naming the service this deployment answers for is the only way to be sure the claim is about you, and absence fails closed.',
  ],
  events: [
    'Activation and deactivation from the portal keep the app directory correct for changes made through the portal. Nothing keeps it correct for changes made directly in NetSapiens — and those happen constantly: a name is corrected, an email is fixed, a user is deleted during offboarding. Without this, the app directory quietly drifts from NetSapiens until someone notices a stale name in a company directory or an app account belonging to somebody who left.',
    '### How it works',
    'It subscribes to change events on the NetSapiens side and reconciles the app directory when one arrives. It is the difference between a directory that is right because someone remembered and one that is right because nothing had to be remembered.',
    '### Why it has so many settings',
    'One reason: it is the only feature that keeps state on someone else\'s system. A subscription is a durable object with an owner, a lifetime and a callback URL, so the settings cover creating it, renewing it before it lapses, proving an inbound delivery is genuine, bounding how much work one delivery can trigger, and cleaning up when you turn the feature off. Most of them have working defaults; the four that do not are the four that cannot be guessed — which domains, this deployment\'s own public origin, the secret the callback path is derived from, and the credential to act with.',
    'It is part of the app integration, not a general NetSapiens feature, because syncing the app directory is the only thing it currently does with what it hears.',
  ],
  offboarding: [
    'When NetSapiens reports a user deleted, their app account is deactivated. That closes the gap where somebody who has left the company still appears in a company directory and can still sign in to the app.',
    '### Deactivate, deliberately not delete',
    'Deactivating Deactivating is reversible, is not billable, and is verifiable — the deletion is confirmed by re-reading the record rather than trusted from an event payload, because an event that arrives out of order or in error must never be able to destroy an account. Full deletion needs a trustworthy answer to "how long has this been orphaned", which does not exist yet; until it does, offering it would be offering an irreversible action on evidence that is sometimes wrong.',
    'It is off by default because it acts on somebody\'s account without a person in the loop, and an operator should turn that on knowingly.',
  ],
  identity: [
    'Every other write in this kit happens because somebody clicked something, so it can be performed as that person, bounded by their own scope. Background work has no such person: NetSapiens posted an event, or the hourly job woke up, and nobody is signed in. There is no session to borrow, so nothing else can grant the permission these operations need.',
    '### What runs on it',
    'Four things, none of which can run without it: creating subscriptions, renewing them before they lapse, removing them when the feature is turned off, and the NetSapiens writes the event handler makes — adding and removing a user\'s softphone device on their extension, and deactivating an app record when a user is deleted. Every one of those happens with no caller, which is the whole reason a stored credential exists here at all.',
    'That is also why it is worth scoping tightly. NetSapiens can restrict a key by model, domain, IP and read-only; a credential that only ever needs subscriptions and device writes on your own domains should not be able to do more than that. It removes one of the two bounds every other write in this kit has — the caller\'s own scope — so the key itself has to be the bound.',
    '### It is not `NS_API_TOKEN`',
    'Despite the names being one word apart. `NS_API_TOKEN` is the standalone read token for the internal tooling mode — a different credential, for a different purpose, and not read at all by a portal deployment, which is why it has no entry of its own on the Config tab here. There is deliberately no fallback between them: silently borrowing a read token for background writes is the kind of privilege drift nobody notices later. Naming the difference here rather than assuming it is obvious, because these two get conflated (it happened while this card was being written).',
    'The practical consequence: subscriptions do not work without a credential set on this card. Setting `NS_API_TOKEN` will not do it, and the change-event card above will stay inert with nothing on it that looks wrong.',
    '### Two ways to supply it',
    'NetSapiens deployments differ in what they will issue. Some provide a long-lived API key; others only issue administrator credentials that must be exchanged for a token, which additionally needs an OAuth client id and secret. They are alternatives, not layers — configure whichever your provider gives you. If both are present the administrator credentials win, which matters only if you set both by accident.',
    'This is the one place where a partially-configured credential is worth watching: administrator credentials without the OAuth pair look configured and cannot actually mint a token, so the console reports that state specifically rather than reporting "on".',
  ],
  auth: [
    'How this Worker proves to NetSapiens that a read or write is allowed. There are two answers, and a deployment uses exactly one of them.',
    '### Portal-backend mode',
    'Every request must carry the caller\'s own `ns_t` from the Manager Portal, and there is no stored credential to fall back on — a request with no bearer is refused outright. That is the property the whole gating model rests on: an action is performed as the person who asked for it, bounded by their own NetSapiens scope, so a mistake in this kit cannot exceed what that person could already do by hand.',
    '### There is no ungated path',
    'A valid bearer token always yields a policy-gated principal. There is no "authenticated but ungated" route through this Worker: a request either carries a token that resolves to a principal the policy engine can judge, or it is refused.',
  ],
  branding: [
    'Cosmetic only: an accent colour and a company name for the pages and modals this kit renders. Nothing here affects behaviour, gating or what any user can reach.',
    '### Set the name as a secret, not a var',
    'A white-label brand name is often something you do not want in a repository — and `wrangler.jsonc` is a committed file. It is read the same way either way, so there is no cost to putting it in a secret.',
    '### Why the colours are layered on rather than baked in',
    'The shared theme registry is deliberately vendor-neutral, and branding is applied per request from these values onto a copy. Module scope is shared across requests in a Worker, so a theme mutated in place would leak one deployment\'s branding into another request\'s response.',
  ],
  domains: [
    'An app-layer limit on which NetSapiens domains this deployment will touch, applied on top of whatever the credential in use could reach. It does not widen anything — it only narrows.',
    '### Why there are two lists, not one',
    'They answer different questions. An allowlist means "only these", and everything else is refused even when the token could read it — it is the tighter control, and the right one when a deployment serves a known set of customers. A blocklist means "these are hidden", and is for excluding something specific from an otherwise unrestricted scope: the classic case is a DID-holding domain with no users and nothing to diagram, which is noise in every listing.',
    '### Worth setting even when the credential is already narrow',
    'A token\'s scope can be widened later by someone who is not thinking about this Worker. These lists are a second, local bound that does not move when the credential does.',
  ],
  cache: [
    'A key prefix for everything this deployment writes to Cloudflare\'s cache. It exists because that cache is shared across the whole zone, not per Worker.',
    '### What goes wrong without a distinct value',
    'Two deployments on one zone left at the default share cache entries. In practice that means one deployment\'s refresh is undone by another\'s stale write, and a value you just corrected reappears wrong a moment later — the kind of fault that looks like an upstream bug and is not. Give every environment its own value; they are not inherited between them, so each must be set explicitly.',
  ],
  menus: [
    'The configuration behind the portal menu customization feature — see that card on the Features tab for what it does, which menus can be targeted and how entries are conditioned.',
    'It appears here as well because the settings are deployment configuration rather than a per-user capability: what you put here changes what every matching user sees, and it takes effect on redeploy.',
  ],
  injection: [
    'What this Worker actually serves to the Manager Portal. One public script, and a set of gated ones it fetches.',
    '### Why the first script is public and neutral',
    'The portal loads it with a plain script tag, which can carry no credential — so it must be safe for anyone to read. It contains no customer data and no domain-scoped logic; its only job is to work out who the viewer is and fetch what they are entitled to. Everything role-dependent is decided by this Worker per request, not by branching in code the browser already has.',
    '### Why the rest are gated per role',
    'A per-role bundle is served only to a caller whose token passes that role\'s gate, and it is cached per tier rather than per user. That is what lets a feature\'s bytes be withheld rather than merely hidden — a hidden menu entry is cosmetic, a bundle that was never sent is not.',
    '### The hand-off',
    'If a vendor add-on is already injected into your portal, the primary chain-loads it so both keep working. Leaving that unset is treated as a misconfiguration rather than as "none", because silently breaking an existing add-on is worse than refusing to guess; declare "none" explicitly if that is what you mean.',
  ],
  nsdevices: [
    'Annotates device lines with the phone model and whether it is currently registered, instead of showing an extension number alone.',
    'Off by default because it costs extra NetSapiens reads on every render, and because registration is a point-in-time fact while the rest of a diagram is static configuration — worth having when you are diagnosing, noise when you are not.',
  ],
  ratelimit: [
    'Throttles how often this Worker will ask NetSapiens to verify a token.',
    '### What it protects',
    'Token verification is the one operation an unauthenticated caller can trigger: a flood of forged tokens would otherwise become a flood of verification calls against your NetSapiens core. Valid tokens are cached, so normal use never approaches the limit — this bounds abuse, not usage.',
    '### The binding is optional and worth having',
    'Without it an in-isolate limiter still applies, but only per isolate, so a distributed flood is bounded once per edge location rather than once overall. A fork with no binding is safe, just less effective — which is why it is not a startup requirement.',
  ],
  onebill: [
    'Coming soon — not wired into this Worker yet. Intended to provide a link between [OneBill](https://www.onebillsoftware.com/) customers and portal domains, sites, and extensions for billing and reconciliation purposes. This is an unofficial integration.',
    'There is nothing to configure yet.',
    'The problem it addresses is the one that arrives the moment activation and deactivation are automated: who is billable stops matching who actually has an account. A seat that is never deactivated keeps costing money, and a seat activated outside the portal never starts — and neither is visible from either system alone.',
  ],
  documo: [
    'Coming soon — not wired into this Worker yet. Intended to provide an integration link between the [Documo](https://www.documo.com/) fax service and the portal, to display fax numbers alongside other numbers and to provide portal links and other useful information, more closely integrating Documo into the Manager Portal. This is an unofficial integration.',
    'There is nothing to configure yet.',
    'Like the app integration, it would be a second per-user service whose account state can drift from NetSapiens independently — which is why the change-event machinery above was built around keeping a directory in sync rather than around one specific platform.',
  ],
};

// ── The table ──────────────────────────────────────────────────────────────────────────────────────
// Grouped and ordered to mirror `interface Env` in worker.ts, section by section, so a reviewer can
// read the two side by side. A few keys sit under a section header that does not describe them (their
// own doc comment says so explicitly, e.g. RINGOTEL_ROTATE_SIP_ON_ACTIVATE under the NS-events header)
// — those are grouped by what they actually govern, not by physical position.
export const SETTINGS: SettingDef[] = [
  // ── core: identity of this deployment, and the standalone auth baseline ──────────────────────────
  { name: 'NS_SERVER', group: 'core', kind: 'config',
    importance: 'critical', example: 'api.example.com',
    what: 'The NetSapiens API host every read and write goes to, e.g. api.example.com (host only, no scheme).',
    whenUnset: 'Nothing works. A fresh deployment ships the placeholder api.example.com, which is reported as a setup blocker.',
    affects: ['auth', 'callflow.view', 'ringotel.orgStatus'] },


  { name: 'ALLOWED_ORIGINS', group: 'core', kind: 'config',
    importance: 'important', example: 'https://manage.example.com',
    what: 'Comma-separated, exact-match allowlist of browser origins allowed cross-origin access to this Worker\'s API (e.g. the Manager Portal host that embeds it). Same-origin requests are unaffected either way.',
    whenUnset: 'Empty allowlist ⇒ deny all cross-origin browser requests. Correct for a same-origin deployment; a deployment embedded from another origin needs this set.',
    affects: ['exposure'] },

  { name: 'CACHE_SCOPE', group: 'core', kind: 'config',
    defaultValue: 'default', importance: 'important', example: 'portal-prod',
    what: 'Cache-key namespace for this deployment. Must be a distinct value in every environment block (wrangler vars are not inherited) — the Cache API is shared zone-wide, so without a distinct scope this deployment\'s Ringotel cache reads and writes collide with every other deployment on the same zone.',
    whenUnset: 'Falls back to the literal namespace "default", which risks cross-deployment cache collisions (one deployment\'s refresh undone by another\'s stale read).',
    affects: ['ringotel.orgStatus', 'ringotel.userStatus', 'ringotel.orgList'] },

  { name: 'NS_PORTAL_ISS', group: 'core', kind: 'config',
    importance: 'critical', example: 'manage.example.com',
    what: 'The Manager Portal host that issues ns_t, e.g. manage.example.com. Required for delegated auth — token verification has no built-in issuer default.',
    whenUnset: 'Delegated auth fails closed: every ns_t is rejected, since there is no issuer to match it against.',
    affects: ['auth'] },


  // ── domains: allow/block lists that bound what a token can reach, on top of its own NS scope ─────
  { name: 'ALLOWED_DOMAINS', group: 'domains', kind: 'config',
    importance: 'important', example: 'acme.example,demo.12345.service',
    what: 'Comma-separated allowlist. When set, domain listings are filtered to it and any other domain is refused, even one the token could otherwise read.',
    whenUnset: 'Unrestricted — bounded only by the NetSapiens scope of the token in use.',
    affects: ['domains'] },

  { name: 'BLOCKED_DOMAINS', group: 'domains', kind: 'config',
    importance: 'important', example: '0000.12345.service',
    what: 'Comma-separated domains hidden from listings and refused (403) on every domain-scoped read, regardless of what the token\'s scope would otherwise allow — e.g. a DID-only holding domain with nothing to diagram. Applies in both auth modes.',
    whenUnset: 'No domain is blocked beyond the token\'s own scope.',
    affects: ['domains'] },

  // ── branding: cosmetic only — the shared theme library ships vendor-neutral colors ────────────────
  { name: 'BRAND_ACCENT', group: 'branding', kind: 'config',
    example: '#1a6bb0',
    what: 'Brand accent color (hex, e.g. #b3282d) used in the flow modal and the viewer\'s brand theme.',
    whenUnset: 'Unbranded — the neutral "ns-portal" theme is used.',
    affects: ['branding'] },

  { name: 'BRAND_NAME', group: 'branding', kind: 'config',
    example: 'Acme Voice',
    what: 'Company name, e.g. "Acme Voice" — drives the product name shown ("<name> Portal Kit v<version>") and the default theme label. A white-label name should be set as a secret, never a plain var.',
    whenUnset: 'Unbranded — the generic product name and theme label are used.',
    affects: ['branding'] },

  { name: 'BRAND_LABEL', group: 'branding', kind: 'config',
    importance: 'minor', example: 'Acme Portal',
    what: 'Override for the theme label shown in the viewer\'s theme picker.',
    whenUnset: 'Defaults to "<BRAND_NAME> portal" when BRAND_NAME is set, else "Brand".',
    affects: ['branding'] },

  // ── ringotel: enrichment — fully gated on RINGOTEL_API_KEY's presence ─────────────────────────────
  { name: 'RINGOTEL_API_KEY', group: 'ringotel', kind: 'secret',
    importance: 'critical',
    what: 'Ringotel AdminAPI key. Its presence is what turns the whole Ringotel integration on.',
    whenUnset: 'Ringotel integration fully off: no Ringotel calls, no enrichment, and every Ringotel-dependent route is inert. The NS-only baseline is unaffected.',
    affects: ['ringotel.orgStatus', 'ringotel.userStatus', 'ringotel.orgList', 'ringotel.activate', 'ringotel.resetPassword'] },

  { name: 'RINGOTEL_BASE_URL', group: 'ringotel', kind: 'config',
    importance: 'minor', gatedBy: 'RINGOTEL_API_KEY', example: 'https://shell.ringotel.co',
    what: 'Non-default Ringotel AdminAPI shell base URL, for a non-standard Ringotel deployment.',
    whenUnset: 'Uses the standard Ringotel AdminAPI base URL.',
    affects: ['ringotel.orgStatus'] },

  { name: 'RINGOTEL_LABEL', group: 'ringotel', kind: 'config',
    defaultValue: 'Ringotel', importance: 'minor', gatedBy: 'RINGOTEL_API_KEY', example: 'Acme App',
    what: 'Long display label for enriched app-status lines (e.g. a white-label name for Ringotel).',
    whenUnset: 'Defaults to "Ringotel".',
    affects: ['ringotel.orgStatus', 'ringotel.userStatus'] },

  { name: 'RINGOTEL_LABEL_SHORT', group: 'ringotel', kind: 'config',
    importance: 'minor', gatedBy: 'RINGOTEL_API_KEY', example: 'Acme',
    what: 'Short display label for tight surfaces, e.g. a column header.',
    whenUnset: 'Defaults to RINGOTEL_LABEL, then "Ringotel".',
    affects: ['ringotel.orgList', 'ringotel.userStatus'] },

  { name: 'RINGOTEL_PRESENCE', group: 'ringotel', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: '1',
    what: 'Show live presence (active / on a PBX call / offline) in the app-status columns.',
    whenUnset: 'Off — status shows activation only, with no presence detail.',
    affects: ['ringotel.userStatus', 'ringotel.orgList'] },

  { name: 'RINGOTEL_OVERRIDES', group: 'ringotel', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: '{"weird.example": "actual-branch-address"}',
    what: 'JSON `{ "<nsDomain>": "<branchAddressToMatch>" }` for the rare case a Ringotel org\'s branch address does not match the NS domain automatically.',
    whenUnset: 'No overrides — the NS domain is matched to the Ringotel branch address automatically.',
    affects: ['ringotel.orgStatus'] },

  // ── eligibility: who gets an app device on activation, and the write safety rail ──────────────────
  { name: 'RINGOTEL_ACTIVATION_SUFFIX', group: 'eligibility', kind: 'config',
    defaultValue: 'r', gatedBy: 'RINGOTEL_API_KEY', example: 'r',
    what: 'The suffix appended to an extension to name its softphone device, e.g. suffix "r" on extension 100 creates device "100r".',
    whenUnset: 'Defaults to "r". An explicitly-set blank value is a configuration error, not "no suffix".',
    affects: ['ringotel.activate'] },

  { name: 'RINGOTEL_EXCLUDE_NAMES', group: 'eligibility', kind: 'config',
    defaultValue: 'SHARED, SHARED VOICEMAIL, VOICEMAIL, FAX, GENERAL VOICEMAIL, GENERAL MAILBOX, CONFERENCE, CONF RM, CONF ROOM, ROUTING', gatedBy: 'RINGOTEL_API_KEY', example: 'SHARED,FAX',
    what: 'Comma-separated, case-insensitive substring matchers on the user\'s name that soft-exclude it from activation (shared lines, voicemail boxes, fax, conference rooms, etc). Applies only when a device is first created — an already-activated user is never blocked from signing in.',
    whenUnset: 'A built-in default list applies (SHARED, SHARED VOICEMAIL, VOICEMAIL, FAX, GENERAL VOICEMAIL, GENERAL MAILBOX, CONFERENCE, CONF RM, CONF ROOM, ROUTING). Setting this replaces that list entirely — it does not add to it.',
    affects: ['ringotel.activate'] },

  { name: 'RINGOTEL_EXCLUDE_EXTS', group: 'eligibility', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: '900,8*',
    what: 'Comma-separated extension patterns to soft-exclude from activation (a trailing * is a prefix wildcard).',
    whenUnset: 'Empty — no extension is excluded by pattern.',
    affects: ['ringotel.activate'] },

  { name: 'RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN', group: 'eligibility', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: '{"acme.example": {"remove": ["900"]}}',
    what: 'JSON `{ "<domain>": { add?: [...], remove?: [...] } }` letting one domain add to or remove from the extension-exclusion list without changing it fleet-wide.',
    whenUnset: 'No per-domain override — every domain uses the same RINGOTEL_EXCLUDE_EXTS list.',
    affects: ['ringotel.activate'] },

  { name: 'RINGOTEL_EXCLUDE_NO_DEVICES', group: 'eligibility', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: '1',
    what: 'Truthy ⇒ tighten the "no devices" heuristic used to guess which extensions are real people vs. system extensions, making activation more conservative.',
    whenUnset: 'Off — the looser default heuristic applies.',
    affects: ['ringotel.activate'] },

  { name: 'RINGOTEL_RESELLER_OVERRIDE', group: 'eligibility', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: 'names,exts',
    what: 'Comma-separated soft-exclusion categories (names, exts, no_devices, or all) a reseller is allowed to override per activation, on top of the deployment defaults.',
    whenUnset: 'Empty — resellers cannot override any soft-exclusion category.',
    affects: ['ringotel.activate'] },

  { name: 'RINGOTEL_WRITE_DOMAINS', group: 'eligibility', kind: 'config',
    importance: 'critical', gatedBy: 'RINGOTEL_API_KEY', example: 'acme.12345.service',
    what: 'The write rail: the only domains in which activate / deactivate / password-reset may run. `*` means every domain the token permits.',
    whenUnset: 'Every write is refused — empty is fail-closed, not unrestricted.',
    affects: ['ringotel.activate', 'ringotel.resetPassword', 'ringotel.prepop', 'me.resetPassword', 'events'] },

  { name: 'RINGOTEL_PREPOP_INCLUDE_SOFT', group: 'eligibility', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: '1',
    what: 'Truthy ⇒ when pre-populating the app directory, also create entries for users that would otherwise be soft-excluded from activation (shared lines, voicemail boxes, etc).',
    whenUnset: 'Off — directory pre-population skips soft-excluded users, the same as activation does.',
    affects: ['ringotel.prepop'] },

  // ── appaccess: the self-service surface a signed-in user sees about their own app access ─────────
  { name: 'RINGOTEL_SSO_SERVICE', group: 'appaccess', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: 'netsapiens_sso',
    what: 'The app SSO service name this deployment answers for (the part after the "/" in the organisation\'s params.sso), used to tell a user whether SSO sign-in is available to them. Important: setting this does not enable single sign-on. It only turns on the portal-side surface around it — the indicators, the settings and the user lifecycle handling. SSO additionally requires its own separate Worker deployment, and enablement by the app platform\'s support pointed at that Worker, neither of which this deployment can see or verify. See the SSO card on the Integrations tab for the full chain.',
    whenUnset: 'Never claims SSO for any org, even one with an SSO service bound — fail closed. An org can have an SSO service bound to a completely different identity provider than the one you run, so inferring it from a binding would send a user to somebody else\'s login.',
    affects: ['me.appAccess'] },

  { name: 'SSO_AUTO_ACTIVATE', group: 'appaccess', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: 'acme.example,demo.example',
    what: 'Whether an SSO sign-in is allowed to create the app account on demand — CSV of domains, `*` for all, unset for none. This is a setting on the separate SSO Worker\'s behaviour, declared here so the portal describes it correctly; like RINGOTEL_SSO_SERVICE it does not itself make SSO work. Independent of whether SSO is bound at all.',
    whenUnset: 'Off — no domain auto-activates on SSO sign-in.',
    affects: ['me.appAccess'] },

  // Grouped with the OTHER menu setting, not with app access. It lives in the appaccess section of `Env`
  // because that is where it originated, and `resolveMenus` reads it too (menus.ts) — but what it DOES is hide
  // menu entries, and the pairing matters: setting it and PORTAL_MENUS' apps hide list together is a
  // configuration error, which a reader can only notice if the two are next to each other.
  { name: 'PORTAL_APPS_HIDE', group: 'menus', kind: 'config',
    example: 'SNAPmobile Web,Meeting',
    what: 'Hide specific stock app-menu entries: comma-separated for a fleet-wide list, or JSON `{"<domain>":[...], "*":[...]}` to vary by domain. The older and terser of the two ways to hide an entry, and its one real advantage is the comma-separated form: a bare list needs no escaping in `wrangler.jsonc`, where a JSON value must be embedded as an escaped string. Use it for exactly that — a plain fleet-wide list. Its JSON form has no advantage at all over `PORTAL_MENUS`\'s `apps.hide`: identical escaping, fewer targeting axes (no scope, no app state). If you are reaching for the JSON here, reach for `PORTAL_MENUS` instead. Setting both is allowed and the two hide lists merge — neither silently wins, and duplicates collapse. The console shows the effective list with each entry attributed to the setting it came from, which is what makes two settings safe to have. It used to be a fatal error instead, which meant two cosmetic settings returned 500 on every route including the injected primary; a hide list should not be able to do that.',
    whenUnset: 'No entries hidden.',
    affects: ['me.appAccess', 'me.menuConfig'] },

  // Positioned here for proximity to PORTAL_APPS_HIDE (the two interact — their apps-menu hide lists
  // merge), but its own group is 'menus', not 'appaccess'.
  { name: 'PORTAL_MENUS', group: 'menus', kind: 'config',
    example: '{"apps": {"hide": {"app": {"ringotel": ["SNAPmobile Web"], "none": []}}, "add": [{"label": "Support", "url": "https://support.example.com"}]}}',
    what: 'JSON adding or hiding entries in the Apps, account and Management menus. A hide or add is either a plain array (applies to everyone) or an object that targets it on one of three axes, and the example on this row shows the one that is hardest to guess. `app` keys on whether your app is active for the user\'s domain, and its keys are a fixed set: an app name (`ringotel`), `none` for a domain where no app is active, and `*` for any state — anything else is a startup error rather than a rule that silently never matches. `domains` keys on the NetSapiens domain and `scopes` on the NetSapiens scope, both by exact name, and `users` keys on a `user@domain` account. Precedence, most specific first: account, then domain, then scope, then app, then `*` — so naming an account carves an exception out of a domain-wide rule, which is the only reason to name one. A `*` inside an axis is a default and never beats a rule that names you. The Menus tab builds all of this for you against your portal\'s real entries, and is the easier route.',
    whenUnset: 'No customization from this setting — but `PORTAL_APPS_HIDE`, if set, still hides Apps-menu entries independently of this key. That one is older and terser, and not deprecated — but this key\'s `apps.hide` is a strict superset of it, so there is nothing it can do that this cannot. Setting both is allowed: the two apps-menu hide lists merge, duplicates collapse, and the console attributes each entry to the setting it came from.',
    affects: ['me.menuConfig'] },

  { name: 'PORTAL_APP_DOWNLOADS', group: 'appaccess', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: '[{"label": "Get the App", "url": "https://example.com/app", "showUrl": false}]',
    what: 'JSON array of `{label, url, title?}` download links shown on the self-service app-access surface (e.g. softphone app-store links).',
    whenUnset: 'No download links shown.',
    affects: ['me.appAccess'] },

  // ── core (continued): a standalone NS integration not specific to any other group ────────────────
  { name: 'NS_DEVICE_DETAILS', group: 'core', kind: 'config',
    example: '1',
    what: 'Truthy ⇒ show desk-phone model and live registration presence (online/offline) on numeric (###/####) device lines.',
    whenUnset: 'Off — device lines show no model or presence detail.',
    affects: ['nsDevices'] },

  // ── access: the optional Cloudflare Access gate for standalone-mode deployments ────────────────────


  // ── core (continued): overall auth/deployment mode ─────────────────────────────────────────────────

  // ── injection: the Worker-served Manager-Portal injection surface (portal-mode only) ──────────────
  { name: 'PRIMARY_BASENAME', group: 'injection', kind: 'config',
    defaultValue: 'p', importance: 'important', example: 'p',
    what: 'The basename the injected primary script is served at: `/<basename>.js`. Must match `^[a-z0-9_-]+$`.',
    whenUnset: 'Defaults to "p".',
    affects: ['injection'] },

  { name: 'PORTAL_HANDOFF_URL', group: 'injection', kind: 'config',
    importance: 'important', example: 'https://vendor.example.com/bundleRouter.bundle.js',
    what: 'The vendor bundle-router the injected primary chain-loads, so an existing portal add-on keeps working alongside this kit. Set it here and this Worker loads it for you; the primary checks the page first and skips the injection if a script with that exact URL is already present, so it will not double-load one a static loader already added. The match is on the exact URL string — a different-looking URL for the same file would load twice.',
    whenUnset: 'Absent and empty mean different things, and neither means "nothing loads the vendor router". Absent is treated as a misconfiguration: any vendor add-on you already run would break, so a warning banner is shown to resellers. Empty ("") is a deliberate declaration that this Worker chain-loads nothing — it says nothing about the rest of the page, and the router may still be loaded by a static loader or by other code that is not this kit, which is a normal arrangement. It should be loaded in exactly one place: if an add-on is present and working while this is empty, something else is loading it, and that is where to go look.',
    affects: ['injection'] },

  { name: 'PORTAL_SECONDARIES', group: 'injection', kind: 'config',
    importance: 'important', example: '[{"name": "my-feature", "from": "url:https://cdn.example.com/my-feature.js", "auth": "public"}]',
    what: 'JSON array of secondary-injection manifest entries (`{name, from: "r2:<key>" | "url:<https>", auth}`) — the gated feature scripts served alongside the primary.',
    whenUnset: 'No secondaries — the primary loads with nothing gated to inject.',
    affects: ['injection'] },

  { name: 'PORTAL_FEATURES', group: 'injection', kind: 'config',
    importance: 'important', example: '{"callflow.view": "office_manager", "ringotel.orgList": "off"}',
    what: 'JSON `{ "<feature.key>": <gate> }` overriding the built-in default gate for one or more features (who can use call-flow view, Ringotel activation, etc).',
    whenUnset: 'Every feature uses its built-in default gate.',
    affects: ['injection'] },

  { name: 'PORTAL_SUPERADMINS', group: 'injection', kind: 'config',
    importance: 'critical', example: 'you@example.com,ops@example.com',
    what: 'Comma-separated `user@domain` accounts that see every feature (except call-center-only ones) and pass the superadmin gate, regardless of their NetSapiens scope.',
    whenUnset: 'No superadmins — every feature is gated purely by NetSapiens scope/level.',
    affects: ['injection'] },

  { name: 'PORTAL_RELEASE_NOTES_URL', group: 'injection', kind: 'config',
    importance: 'minor', example: 'https://github.com/dszp/ns-portal-kit/releases#release-v{version}',
    what: 'Where a version number links to, with `{version}` substituted for the running version. Two surfaces share it: this console\'s own header, and the version line in the portal footer. Three states, the same shape PORTAL_HANDOFF_URL uses: absent means the public release list anchored at this version; a value is yours, for a fork or your own notes; and present-but-empty means never link at all, which is the way to switch the link off without removing the version.',
    whenUnset: 'Links to the public release list, anchored at the version this deployment is running. The list is used rather than the single-release page on purpose — it also carries a version sidebar and a compare control, so it answers "am I behind" as well as "what is in mine", and if the anchor ever stops matching, the reader still lands somewhere that states which version it is showing.',
    affects: ['injection', 'portal.versionLine'] },

  { name: 'STATUS_BANNER_WEBHOOK', group: 'injection', kind: 'config',
    importance: 'minor', example: 'https://automation.example.com/webhook/portal-banner',
    what: 'An endpoint you host that returns the status-banner message for the caller, or nothing. Asked once per portal page load, on every portal page — so the endpoint sees every visit and decides, rather than the kit guessing which pages deserve a notice. That is one call per page view; if that matters for your backend, the payload includes `path` so it can answer empty cheaply. The kit stores no messages and decides nobody\'s eligibility — your endpoint does both, so a notice can be posted and pulled without a redeploy. ⚠️ The request carries the signed-in user\'s live `ns_t`, so name only an endpoint you control: whatever is here receives a working portal credential from every user. Must be https for the same reason. The reply may be plain text or JSON with a `message`, `text` or `banner` field, and may contain simple HTML — links, bold, italics — which is what a welcome or support notice usually needs. ⚠️ Return only messages you trust: this renders into every user\'s portal. The markup is rebuilt from an allow-list rather than inserted as-is, so `<script>`, event handlers and non-https links are dropped whatever the endpoint returns; that is a backstop against a mistake, not a substitute for controlling what the endpoint says.',
    whenUnset: 'The status banner is inert — nothing is requested and nothing is drawn.',
    affects: ['injection', 'portal.statusBanner'] },

  { name: 'RINGOTEL_APP_BASE_URL', group: 'injection', kind: 'config',
    importance: 'minor', gatedBy: 'RINGOTEL_API_KEY', example: 'https://app.example.com',
    what: 'Optional base URL for an app-dashboard deep link shown on gated feature surfaces.',
    whenUnset: 'No link — a plain text label is shown instead.',
    affects: ['injection'] },

  // ── bindings: structural Worker bindings, not string env values ────────────────────────────────────
  { name: 'ASSETS', group: 'bindings', kind: 'config',
    importance: 'important',
    example: '"r2_buckets": [{ "binding": "ASSETS", "bucket_name": "your-bucket" }]',
    what: 'Optional private R2 bucket binding that serves any r2: entry in the injection manifest.',
    whenUnset: 'Not bound. Harmless unless PORTAL_SECONDARIES lists an r2: entry, in which case every request fails with a loud config error.',
    affects: ['injection'] },

  { name: 'JWT_RATE_LIMITER', group: 'bindings', kind: 'config',
    importance: 'important',
    example: '"ratelimits": [{ "name": "JWT_RATE_LIMITER", "namespace_id": "1000", "simple": { "limit": 100, "period": 60 } }]',
    what: 'Optional Cloudflare Rate Limiting binding that throttles live ns_t verification calls (defense against a forged-token flood hitting the NetSapiens core). Declared as a `ratelimits` binding in wrangler.jsonc.',
    whenUnset: 'Not bound. The in-isolate limiter still applies as a fallback, just per-isolate instead of fleet-wide — a fork with no binding is safe, just less effective.',
    affects: ['auth'] },

  // ── ringotel (continued): sits textually under the NS-events header below, but is unrelated to it ──
  { name: 'RINGOTEL_ROTATE_SIP_ON_ACTIVATE', group: 'ringotel', kind: 'config',
    defaultValue: 'on', gatedBy: 'RINGOTEL_API_KEY', example: '0',
    what: 'Rotate the SIP password when activating a user whose device already existed.',
    whenUnset: 'ON. This is the only switch here that defaults on — set 0/false/no/off to reuse the stored password instead.',
    affects: ['ringotel.activate'] },

  // ── events: NetSapiens change-event subscriptions that keep the app directory in sync ─────────────
  { name: 'NS_EVENTS', group: 'events', kind: 'config',
    defaultValue: 'auto', importance: 'important', gatedBy: 'RINGOTEL_API_KEY', example: 'auto',
    what: 'Controls the NetSapiens event-subscription feature that keeps the app directory in sync when a user is edited directly in NetSapiens, not just through activate/deactivate/reset actions. `auto` (default) turns it on once Ringotel and the settings below are fully configured; `on` forces it and fails loudly if config is incomplete; `off` disables it outright.',
    whenUnset: 'Same as `auto` — on automatically once Ringotel and the rest of the event settings are configured; inert (no error) until then.',
    affects: ['events'] },

  { name: 'NS_EVENTS_DOMAINS', group: 'events', kind: 'config',
    importance: 'important', gatedBy: 'RINGOTEL_API_KEY', example: 'acme.example',
    what: 'Which domains get an event subscription. `*` = every domain the Ringotel write rail (`RINGOTEL_WRITE_DOMAINS`) permits, discovered at reconcile time; otherwise a comma-separated list, further narrowed to the write rail.',
    whenUnset: 'Inert — no domain gets a subscription even if NS_EVENTS is on. `*` must be chosen deliberately, it is never a default.',
    affects: ['events'] },

  { name: 'NS_EVENTS_BASE_URL', group: 'events', kind: 'config',
    importance: 'important', gatedBy: 'RINGOTEL_API_KEY', example: 'https://portal.example.com',
    what: 'This Worker\'s own public https origin, e.g. https://portal.example.com — the base NetSapiens posts change events back to. Must be distinct per deployment, or two deployments fight over the same subscriptions.',
    whenUnset: 'Event subscriptions cannot be created — treated as missing config (inert, or a startup error if NS_EVENTS=on).',
    affects: ['events'] },

  { name: 'NS_EVENTS_PATH_SECRET', group: 'events', kind: 'secret',
    importance: 'critical', gatedBy: 'RINGOTEL_API_KEY',
    what: 'Master key the per-domain event callback path token is derived from. Anyone who can forge that token could post fake change events.',
    whenUnset: 'Event subscriptions cannot be created — treated as missing config. Rotating this secret invalidates every existing subscription\'s callback URL, so it must be re-PUT for every domain.',
    affects: ['events'] },

  { name: 'NS_EVENTS_MODELS', group: 'events', kind: 'config',
    defaultValue: 'subscriber', gatedBy: 'RINGOTEL_API_KEY', example: 'subscriber',
    what: 'Comma-separated list of NetSapiens record types to subscribe to.',
    whenUnset: 'Defaults to subscriber only.',
    affects: ['events'] },

  { name: 'NS_EVENTS_RENEW_HORIZON', group: 'events', kind: 'config',
    defaultValue: '604800', gatedBy: 'RINGOTEL_API_KEY', example: '604800',
    what: 'How many seconds of remaining subscription lifetime trigger a renewal.',
    whenUnset: 'Defaults to 7 days (604800 seconds).',
    affects: ['events'] },

  { name: 'NS_EVENTS_TARGET_LIFETIME', group: 'events', kind: 'config',
    defaultValue: '31536000', gatedBy: 'RINGOTEL_API_KEY', example: '31536000',
    what: 'The subscription lifetime, in seconds, requested on create or renew. Must exceed NS_EVENTS_RENEW_HORIZON, or every reconcile run would renew immediately.',
    whenUnset: 'Defaults to 365 days (31536000 seconds).',
    affects: ['events'] },

  { name: 'NS_EVENTS_ALLOW_IPS', group: 'events', kind: 'config',
    gatedBy: 'RINGOTEL_API_KEY', example: '203.0.113.10,203.0.113.11',
    what: 'Optional comma-separated source-IP allowlist for the inbound event receiver, on top of the per-domain path token.',
    whenUnset: 'Off — no IP restriction; the path token is the only defense.',
    affects: ['events'] },

  { name: 'NS_EVENTS_GEO_SUPPORT', group: 'events', kind: 'config',
    defaultValue: 'yes', gatedBy: 'RINGOTEL_API_KEY', example: 'yes',
    what: '`yes` or `no` — whether the created NetSapiens subscription requests geo-redundant delivery.',
    whenUnset: '`yes`.',
    affects: ['events'] },

  { name: 'NS_EVENTS_PREFERRED_SERVER', group: 'events', kind: 'config',
    importance: 'minor', gatedBy: 'RINGOTEL_API_KEY',
    what: 'Optional preferred NetSapiens node to deliver events from.',
    whenUnset: 'No preference — NetSapiens\' own default routing applies.',
    affects: ['events'] },

  { name: 'NS_EVENTS_MAX_EVENTS', group: 'events', kind: 'config',
    defaultValue: '40', gatedBy: 'RINGOTEL_API_KEY', example: '40',
    what: 'Ceiling on how many queued events are processed in one invocation.',
    whenUnset: 'Defaults to 40.',
    affects: ['events'] },

  { name: 'NS_EVENTS_DIAG_RAW', group: 'events', kind: 'config',
    importance: 'minor', gatedBy: 'RINGOTEL_API_KEY', example: '1',
    what: 'Truthy ⇒ log the shape (keys and sizes, never values) of event payloads this deployment has not seen before — a debugging aid for a payload change on the NetSapiens side.',
    whenUnset: 'Off — no diagnostic logging.',
    affects: ['events'] },

  { name: 'NS_EVENTS_OFFBOARD', group: 'events', kind: 'config',
    defaultValue: 'off', importance: 'important', gatedBy: 'RINGOTEL_API_KEY', example: 'deactivate',
    what: '`off` (default) or `deactivate` — whether an NS-deleted user\'s app record is deactivated, applied by both the live event handler and the cron sweep. Full deletion is deliberately not offered here; it needs a verified "how long orphaned" clock that does not exist yet.',
    whenUnset: 'Off — an NS deletion is never reflected in the app directory automatically.',
    affects: ['events'] },

  { name: 'NS_EVENTS_DEVICE_REPAIR', group: 'events', kind: 'config',
    defaultValue: 'off', gatedBy: 'RINGOTEL_API_KEY', example: 'heal',
    what: '`off` (default), `report`, or `heal` — whether a user-change event also triggers desk-phone/softphone device self-heal.',
    whenUnset: 'Off — device self-heal never runs from an event.',
    affects: ['events'] },

  { name: 'NS_EVENTS_SWEEP_MAX', group: 'events', kind: 'config',
    defaultValue: '200', gatedBy: 'RINGOTEL_API_KEY', example: '200',
    what: 'Ceiling on how many extensions the cron sweep (the offboarding safety net, independent of live events) deactivates in one run. Overflow is logged, never silently dropped.',
    whenUnset: 'Defaults to 200.',
    affects: ['events'] },

  // ── identity: the background service identity used for writes with no caller (event handling) ────
  { name: 'NS_API_KEY', group: 'identity', kind: 'secret',
    importance: 'important', gatedBy: 'NS_EVENTS',
    what: 'The background service identity: a NetSapiens bearer token used when work runs with no signed-in caller — creating and renewing event subscriptions, adding and removing a user\'s softphone device, deactivating an app record on deletion. It is sent as-is; nothing is exchanged. Not interchangeable with `NS_API_TOKEN`, which is the standalone deployment\'s read credential — mechanically the same kind of value (both are bearer tokens sent as-is), deliberately with no fallback between them, so this one can be scoped to exactly what background work needs and rotated on its own. You will not find `NS_API_TOKEN` listed on this tab: it is never read in portal-backend mode, so this deployment does not show it. It is named here only because the two get confused, and setting it will not help you. NetSapiens can restrict a key by model, domain, IP and read-only — narrow this as far as your deployment allows, because it is a stored credential and the caller-scope bound that limits every other write here does not apply to it.',
    whenUnset: 'No API-key identity. NS_ADMIN_USER + NS_ADMIN_PASS are the alternative (exchanged for a token via OAuth, so they additionally need NS_OAUTH_CLIENT_ID and NS_OAUTH_CLIENT_SECRET); if neither is configured, subscriptions cannot be created or renewed and the event handler cannot write. Setting `NS_API_TOKEN` does not satisfy this.',
    affects: ['events'] },

  { name: 'NS_ADMIN_USER', group: 'identity', kind: 'secret',
    importance: 'important', gatedBy: 'NS_EVENTS',
    what: 'Admin username, paired with NS_ADMIN_PASS: the alternative way to supply the background service identity, for a NetSapiens deployment that issues administrator credentials rather than a standalone API key. Unlike NS_API_KEY these are not sent directly — they are exchanged for an access token via an OAuth password grant, which is why this path additionally needs NS_OAUTH_CLIENT_ID and NS_OAUTH_CLIENT_SECRET. Configure whichever your provider gives you, not both; admin wins if both are set.',
    whenUnset: 'No admin-credential identity — falls back to NS_API_KEY if set.',
    affects: ['events'] },

  { name: 'NS_ADMIN_PASS', group: 'identity', kind: 'secret',
    importance: 'important', gatedBy: 'NS_EVENTS',
    what: 'Admin password paired with NS_ADMIN_USER for the background service identity.',
    whenUnset: 'No admin-credential identity — falls back to NS_API_KEY if set.',
    affects: ['events'] },

  { name: 'NS_OAUTH_SERVER', group: 'identity', kind: 'config',
    importance: 'minor', gatedBy: 'NS_EVENTS', example: 'api.example.com',
    what: 'OAuth host for the admin-credential grant, when it differs from NS_SERVER.',
    whenUnset: 'Falls back to NS_SERVER.',
    affects: ['events'] },

  { name: 'NS_OAUTH_CLIENT_ID', group: 'identity', kind: 'secret',
    importance: 'important', gatedBy: 'NS_EVENTS',
    what: 'OAuth client ID required alongside NS_ADMIN_USER/NS_ADMIN_PASS to mint the service-identity access token.',
    whenUnset: 'The admin-credential path cannot mint a token — required whenever NS_ADMIN_USER/NS_ADMIN_PASS are set.',
    affects: ['events'] },

  { name: 'NS_OAUTH_CLIENT_SECRET', group: 'identity', kind: 'secret',
    importance: 'important', gatedBy: 'NS_EVENTS',
    what: 'OAuth client secret paired with NS_OAUTH_CLIENT_ID for the admin-credential grant.',
    whenUnset: 'The admin-credential path cannot mint a token — required whenever NS_ADMIN_USER/NS_ADMIN_PASS are set.',
    affects: ['events'] },
];
