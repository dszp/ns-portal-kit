/**
 * The status document: a pure function of `env` + the viewing `Principal`. Everything here COMPOSES an
 * existing resolver — every subsystem already exports a pure "parse env → validated shape, or a typed
 * config error" function, and this file's whole job is to call those and assemble the result. It adds
 * NO parsing of its own: a fact this module needs that no resolver exposes belongs exported from the
 * module that owns it, not re-derived here (a second derivation of the same fact is exactly the drift
 * this feature exists to eliminate).
 *
 * `subsystems: []` and `settings: []` are stubbed — Task 4 fills those in.
 */

import { can, type Principal, type FeaturePolicies, type Policy } from '@dszp/netsapiens-lib';

import {
  SETTINGS, SECRET_WHY_NOT, CONFIG_WHY_NOT, BINDING_WHY_NOT, SUBSYSTEM_DETAIL,
  type StatusDoc, type FeatureCard, type FeatureState, type MissingRequirement,
  type SettingView, type SettingDef, type SettingGroup, type SubsystemCard, type ProbeResult,
  type Applicability, type SettingGate, type FeatureAudience, type SubsystemTab,
  type PermissionsView, type PermissionRow, type PermissionCell, type CellVerdict, type CellDelta,
  type MenusView, type MenuView,
} from './statusModel.js';

import {
  FEATURE_REGISTRY, resolveFeaturePolicies, featuresConfigError, parseFeatures, parseSuperadmins,
  gateLevels, fleetReadAllowed, resolveGate, KNOWN_SCOPES, LEVEL_SCOPES, FeaturesConfigError, carriersFor,
  type FeatureDef, type Gate, type FeaturesEnv,
} from './features.js';

import { productName, releaseNotesUrl, VERSION, type BrandEnv } from './brand.js';
import { needsSetup, setupIssues, nsServerConfigured, type SetupEnv } from './setup.js';
import { isLocalRequest } from './localRequest.js';
import { kitConfigError, primaryBasename, type KitEnv } from './kit.js';
import { menuConfigError, resolveMenus, appsHideSources, bothAppsHideSet, MENU_NAMES, type MenuEnv } from './menus.js';
import { appAccessConfigError, type AppAccessEnv } from './appAccess.js';
import { nsEventsConfigError, parseNsEventsConfig, resolveWriteIdentity, type NsWriteIdentity, type NsEventsEnv } from './nsEvents.js';
import { nsDeviceDetailsEnabled, type NsDeviceEnv } from './nsDevices.js';
import { identityUsable, type NsIdentityEnv } from './nsIdentity.js';

// ⚠️ Two modules export an interface named `RingotelEnv` — one is enrichment/data config, the other is
// activation config. Aliased so both fit in one intersection without colliding.
import { scopeOf, ringotelEnabled, type RingotelEnv as RingotelDataEnv } from './ringotel.js';
import { resolveRingotelConfig, ringotelConfigError, RingotelConfigError, type RingotelEnv as EligibilityEnv } from './eligibility.js';

export type StatusEnv = FeaturesEnv & KitEnv & SetupEnv & MenuEnv
  & AppAccessEnv & RingotelDataEnv & EligibilityEnv & NsEventsEnv & NsDeviceEnv
  & BrandEnv & NsIdentityEnv;

export interface BuildStatusOpts {
  principal: Principal | null;
  hostname: string;
  probes?: ProbeResult[] | null;
}

/**
 * The ONE generic env lookup. `interface Env` (worker.ts) has no index signature, and should not — so
 * reading a key named by a string (the descriptor table, for a future settings view) needs exactly one
 * cast. Keep it here so there is never a second one scattered elsewhere.
 */
export function readKey(env: StatusEnv, name: string): unknown {
  return (env as unknown as Record<string, unknown>)[name];
}

/**
 * The environment badge: the page must never leave you guessing which deployment you are reading.
 * `LOCAL` when the request is local (wrangler dev); `DEV` when either signal says dev; `PROD` when the
 * cache scope is a real, non-default value. Scope wins over hostname for PROD — it is the deliberate
 * per-environment marker (`CACHE_SCOPE`), whereas the hostname is whatever happens to be routed here.
 */
export function envBadge(hostname: string, cacheScope: string): string {
  if (isLocalRequest(hostname)) return 'LOCAL';
  const scope = cacheScope.trim().toLowerCase();
  const label = (hostname.split('.')[0] ?? '').trim().toLowerCase();
  if (scope.includes('dev') || label.includes('dev')) return 'DEV';
  if (scope && scope !== 'default') return 'PROD';
  return 'UNKNOWN';
}

/** Plain-English name for each config-gate level (see LEVEL_SCOPES in features.ts). `superadmin` is
 *  handled separately below (its wording depends on whether any are actually configured). */
const LEVEL_WORDS: Record<string, string> = {
  all: 'anyone with a valid session',
  super_user: 'super users',
  reseller: 'resellers and above',
  office_manager: 'office managers and above',
  site_manager: 'site managers and above',
  advanced_user: 'advanced users and above',
  basic_user: 'basic users and above',
  call_center_agent: 'call center agents',
  call_center_supervisor: 'call center supervisors',
};

/**
 * Gate prose: the page says WHO, in words, not in rules. Built on `gateLevels` (Task 2) — which throws
 * on a shape it does not recognize, so this stays inside a try/catch rather than letting a bad config
 * value turn into an unhandled 500 from an unexpected place.
 *
 * It must describe the SAME rule set `resolveGate` builds, including the superadmin union that gate applies
 * to every non-call-center gate (`GateShape.ccOnly`). Omitting that union is how this function came to
 * print "resellers and above" on a card that, three lines below, also said "You: you pass this gate" to a
 * Basic User — and it did so on 17 of 18 cards in the only configuration where the console is reachable at
 * all (a working console implies a non-empty PORTAL_SUPERADMINS).
 */
export function gateInWords(gate: Gate, superadmins: string[]): string {
  if (gate === 'off') return 'Nobody — this feature is turned off, with no exception for superadmins.';

  let shape: ReturnType<typeof gateLevels>;
  try {
    shape = gateLevels(gate);
  } catch (e) {
    if (!(e instanceof FeaturesConfigError)) throw e;
    return 'An unrecognized gate configuration (see the config error above).';
  }

  const namedSupers = (): string =>
    `the named superadmin${superadmins.length > 1 ? 's' : ''} (${superadmins.join(', ')})`;

  const parts: string[] = [];
  for (const level of shape.levels) {
    if (level === 'superadmin') {
      parts.push(
        superadmins.length
          ? namedSupers()
          : 'superadmins — but PORTAL_SUPERADMINS is empty, so this grants nobody',
      );
      continue;
    }
    parts.push(LEVEL_WORDS[level] ?? level);
  }
  if (shape.hasUsers) parts.push('specific named users');
  if (shape.hasRawRules) parts.push('a custom set of policy rules');
  if (!parts.length) parts.push('nobody — no levels or users are configured');

  // The union resolveGate applies to every non-CC gate. `superadmin` as a named level already printed the
  // same list above, so don't say it twice.
  if (!shape.ccOnly && superadmins.length && !shape.levels.includes('superadmin')) {
    parts.push(`plus ${namedSupers()}, at any scope`);
  }

  return `${parts.join(', ')}.`;
}

/** The configured (override, else default) gate for one feature key. */
function effectiveGate(key: string, overrides: Record<string, Gate>): Gate {
  const def = FEATURE_REGISTRY.find((f) => f.key === key)!;
  return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : def.default;
}

/**
 * WHY the viewer can see this page: a listed superadmin first, then a gate that names them personally,
 * then "your level passes on its own". "Named personally" reads `gateLevels(gate).users` (Task 2) — ONE
 * walk of the `Gate` shape, shared with `resolveGate` and `gateInWords`, rather than a third independent
 * one. `gateLevels` throws on a shape it does not recognize, so the call is wrapped: a malformed gate
 * must not take the whole page down. (In practice `kit.status`'s `allowedLevels` floor means
 * `parseFeatures` already rejects a malformed override before it can reach here — see
 * `status.selftest.ts` for a direct test that bypasses that floor to exercise the wrap itself.)
 */
export function grantedByFor(
  principal: Principal,
  superadmins: string[],
  overrides: Record<string, Gate>,
): StatusDoc['viewer']['grantedBy'] {
  if (superadmins.includes(principal.id)) return 'superadmin';
  const gate = effectiveGate('kit.status', overrides);
  try {
    if (gateLevels(gate).users.some((u) => u.trim().toLowerCase() === principal.id)) return 'named-user';
  } catch (e) {
    if (!(e instanceof FeaturesConfigError)) throw e;
    return 'unknown';
  }
  return 'level';
}

// ── Prerequisites: settings a feature needs BEYOND its own gate passing. One declared table, built from
// the four rules in the brief, so the whole mapping is auditable in one place rather than scattered
// across per-feature `if`s. ──────────────────────────────────────────────────────────────────────────
const RINGOTEL_KEYS = FEATURE_REGISTRY.filter((f) => f.key.startsWith('ringotel.')).map((f) => f.key);
const ME_KEYS = FEATURE_REGISTRY.filter((f) => f.key.startsWith('me.')).map((f) => f.key);
const PREREQS: Record<string, string[]> = {};
const need = (key: string, setting: string): void => {
  (PREREQS[key] ??= []).push(setting);
};
// Every ringotel.* feature, plus the two self-service surfaces that read app-access data, need the app
// to exist at all.
for (const k of RINGOTEL_KEYS) need(k, 'RINGOTEL_API_KEY');
need('me.appStatus', 'RINGOTEL_API_KEY');
need('me.appAccess', 'RINGOTEL_API_KEY');
need('me.resetPassword', 'RINGOTEL_API_KEY');
// The write rail, layered on top of the four write features (each already needs RINGOTEL_API_KEY above,
// except me.resetPassword, which was just given it on the line above).
for (const k of ['ringotel.activate', 'ringotel.resetPassword', 'ringotel.prepop', 'me.resetPassword']) need(k, 'RINGOTEL_WRITE_DOMAINS');
// The admin entry point, the self entry point, and every me.* need portal-backend mode. `me.*` is
// derived from the registry (like RINGOTEL_KEYS above) so a new `me.*` feature cannot silently miss
// this — a hardcoded list would need remembering to update.
// callflow.view needs a real NS_SERVER (set, and not the shipped placeholder).
need('callflow.view', 'NS_SERVER');

/** Is this ONE named prerequisite satisfied? Composes the resolver that already owns the answer — never
 *  re-derives it (e.g. NS_SERVER's placeholder check lives in setup.ts; RINGOTEL_WRITE_DOMAINS' shape
 *  lives in eligibility.ts). */
function prereqSatisfied(name: string, env: StatusEnv): boolean {
  switch (name) {
    case 'RINGOTEL_API_KEY':
      return ringotelEnabled(env);
    case 'RINGOTEL_WRITE_DOMAINS':
      try {
        const { writeDomains } = resolveRingotelConfig(env);
        return writeDomains === '*' || writeDomains.length > 0;
      } catch (e) {
        if (!(e instanceof RingotelConfigError)) throw e;
        return false; // ringotelConfigError (a configError, not "missing") already reports this loudly
      }
    case 'NS_SERVER':
      return nsServerConfigured(env);
    default:
      return false;
  }
}

/** HOW to set one setting — the console's fix-it instruction, so it must name the right mechanism. Three
 *  cases, selected on the axis that actually decides it: a structural BINDING (`group === 'bindings'`) is
 *  not a `vars` string and must not be described as one; a `kind === 'secret'` needs `wrangler secret put`;
 *  everything else is a var. One derivation, read by both the settings table (`settingView`) and every
 *  `missing[]` entry (`missingRequirement`), so the two can never give different instructions. */
function whyNotText(def: SettingDef): string {
  const base = def.group === 'bindings' ? BINDING_WHY_NOT : def.kind === 'secret' ? SECRET_WHY_NOT : CONFIG_WHY_NOT;
  return base.replace('<NAME>', def.name);
}

/**
 * The literal line to type. `whyNotText` above says WHERE a value goes in prose; this shows the syntax,
 * because a reader who does not already know what a `vars` block looks like cannot act on the prose.
 *
 * `<environment>` stays a visible placeholder rather than this deployment's own wrangler environment name:
 * the Worker does not know it (there is no binding that carries it — `CACHE_SCOPE` is a cache namespace an
 * operator chose, not the env name), and printing a guess would be a confident invention of exactly the
 * kind this console exists to eliminate.
 */
function howToSetText(def: SettingDef): string {
  if (def.group === 'bindings') {
    return `// wrangler.jsonc → env.<environment>  (a binding, NOT a vars string)\n${def.example ?? `"${def.name}": …`}`;
  }
  if (def.kind === 'secret') {
    return `# secrets never go in wrangler.jsonc\nwrangler secret put ${def.name} --env <environment>`;
  }
  const value = def.example ?? def.defaultValue ?? '…';
  return `// wrangler.jsonc → env.<environment>.vars\n${JSON.stringify(def.name)}: ${JSON.stringify(value)}`;
}

/**
 * Every setting this Worker declares is applicable to it: there is one product here, so there is no
 * "set but ignored in this mode" state left to explain. Kept as a function rather than inlined so the
 * shape of `SettingView` does not have to change with it.
 */
function applicabilityOf(_def: SettingDef, _env: StatusEnv): Applicability {
  return { applicable: true, why: null };
}

/**
 * Is a setting's own gate satisfied — i.e. does this setting currently do anything?
 *
 * Composes the resolver that already owns each answer rather than re-testing raw env: `RINGOTEL_API_KEY`
 * is `ringotelEnabled` (the same predicate every Ringotel card uses), `NS_EVENTS` is "actually armed"
 * (which is more than "not off" — it needs a usable identity, a callback origin and a path secret). A
 * second derivation here would let the Config tab grey out a block the Integrations tab reports as ON.
 */
function gateOf(def: SettingDef, env: StatusEnv, eventsArmed: boolean): SettingGate | null {
  if (!def.gatedBy) return null;
  const setting = def.gatedBy;
  if (setting === 'NS_EVENTS') return { setting, satisfied: eventsArmed };
  return { setting, satisfied: prereqSatisfied(setting, env) };
}

/** A missing prerequisite, worded from the SAME descriptor row a settings view will render (Task 1) —
 *  `why` is its `whenUnset` prose, `how` is the standard secret/config/binding fix-it text, so this page
 *  and a future settings table can never describe the same setting two different ways. */
function missingRequirement(name: string): MissingRequirement {
  const def = SETTINGS.find((s) => s.name === name);
  const why = def?.whenUnset ?? `${name} is required for this feature.`;
  const how = def ? whyNotText(def) : CONFIG_WHY_NOT;
  return { setting: name, why, how };
}

/** An unmet requirement whose setting IS present — worded as the truth, not as "missing". Its `why` prose
 *  is the descriptor's `whenUnset`, which describes ABSENCE and would be simply wrong here, so this says
 *  what is actually the case and carries the same fix-it mechanism. The value is included under exactly the
 *  rule the Config tab already applies (`settingView`: never a secret, never a binding), because "set to
 *  what?" is the whole question, and truncated so one long JSON var cannot flood a card. */
function presentButUnmet(name: string, env: StatusEnv): string {
  const def = SETTINGS.find((s) => s.name === name);
  const value = def ? settingView(def, env).value : null;
  const shown = value === null ? '' : ` (current value: ${value.length > 60 ? `${value.slice(0, 60)}…` : value})`;
  const how = def ? whyNotText(def) : CONFIG_WHY_NOT;
  return `${name} is already set, so it is not missing — but it does not satisfy this requirement as configured${shown}. ${how}`;
}

/**
 * THE one construction of a card's requirement lists — every `missing[]` in this document comes from here.
 *
 * Three facts, deliberately separate, because conflating two of them is what made the page lie:
 *   - `unmet` — which requirements are not satisfied. THIS, and only this, decides `inert`. Deriving the
 *     state from `missing.length` instead would flip a genuinely-broken card to `on` the moment its
 *     requirement was present-but-wrong.
 *   - `missing` — the subset that is also ABSENT. A `missing[]` entry can therefore never name a setting
 *     the operator has already set, which is the invariant `status.selftest.ts` asserts across a spread of
 *     envs: no card's `missing[]` may name a setting whose `SettingView.set` is true.
 *   - `notes` — everything else, including each present-but-unmet requirement.
 *
 * The bug this closes was in four hardcoded lists and reachable in nine ways (verified 2026-08-07): the
 * exposure card told a portal-mode deployment to set `PORTAL_MODE`, which it had; `identity`/`events`
 * demanded both OAuth keys when only the secret was absent; `offboarding` named `NS_EVENTS` while it was
 * literally `on`; `cache` named `CACHE_SCOPE` when it was explicitly `default`; `auth` named `NS_SERVER`
 * holding the shipped placeholder, and `NS_API_TOKEN` when a perfectly good token was being refused by the
 * exposure gate. "Missing" means "absent — set it". Fixing it per card leaves the next card free to
 * reintroduce it; funnelling every list through one helper does not.
 */
interface Requirements { unmet: string[]; missing: MissingRequirement[]; notes: string[] }

function requirements(env: StatusEnv, unmet: string[], notes: string[] = []): Requirements {
  const out: Requirements = { unmet, missing: [], notes: [...notes] };
  for (const name of unmet) {
    if (isSet(readKey(env, name))) out.notes.push(presentButUnmet(name, env));
    else out.missing.push(missingRequirement(name));
  }
  return out;
}

/** The `inert` card every "something is required and is not satisfied" branch returns. Never returns an
 *  unexplained card: each unmet name lands in `missing` or in `notes`, so an `inert` state always says why
 *  (asserted generally in `status.selftest.ts`). */
function inertOn(env: StatusEnv, unmet: string[], notes: string[] = []): CardResult {
  const r = requirements(env, unmet, notes);
  return { state: 'inert', missing: r.missing, notes: r.notes };
}

function requirementsFor(key: string, env: StatusEnv): Requirements {
  return requirements(env, (PREREQS[key] ?? []).filter((name) => !prereqSatisfied(name, env)));
}

/** PORTAL_FEATURES and PORTAL_SUPERADMINS decide every feature's effective gate (resolveFeaturePolicies)
 *  — so both belong on every card — unioned with whatever `SETTINGS[].affects` names this feature
 *  specifically, unioned with this card's own PREREQS (so a `missing[]` entry always points at a
 *  setting the card's own `settings` list also names — a `missing` entry the reader can't find in the
 *  card's detail list would be a dead reference). */
const GATING_SETTINGS = ['PORTAL_FEATURES', 'PORTAL_SUPERADMINS'];
function settingsFor(key: string): string[] {
  const specific = SETTINGS.filter((s) => s.affects.includes(key)).map((s) => s.name);
  return [...new Set([...GATING_SETTINGS, ...specific, ...(PREREQS[key] ?? [])])];
}

// ── setting views: one row of SETTINGS → what THIS deployment reports for it ─────────────────────────

/** A string reports set when non-blank; anything else (a binding — ASSETS, JWT_RATE_LIMITER) reports set
 *  when merely non-null/undefined. Shared by settingView below and every subsystem card that reads a raw
 *  env value directly, so "is this configured" can't drift between the two. */
function isSet(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null;
}

/** One `SettingDef` + the live `env` → what the page shows. A secret NEVER carries its value — `value` is
 *  null whenever `kind === 'secret'`, unset, or not a string (a binding is never stringified into the
 *  page).
 *
 *  `set` and `source` answer DIFFERENT questions, and conflating them made the page contradict itself.
 *  `set` is "is there a usable value" (`isSet`: a blank string is not). `source` is "did this deployment
 *  declare it at all", which is `raw === undefined` — nothing else. Deriving `source` from `set` reported
 *  `PORTAL_HANDOFF_URL: ''` — a deliberate "there is no vendor to hand off to" — as UNSET with
 *  `source: "default"`, which is flatly false, and then printed that row's `whenUnset` prose warning about
 *  the OTHER state ("absent is treated as a misconfiguration") while the Integrations tab reported injection
 *  ON. The renderer turns the third state into its own pill. */
/**
 * The exact `wrangler.jsonc` line for a value — the whole value escaped as the JSON string a var must be.
 *
 * `JSON.stringify` of the raw text does precisely this and is the only correct way to do it: hand-escaping
 * is what an operator is currently forced into, and it is where a stray quote silently breaks a deploy.
 */
export function wranglerLine(name: string, value: string): string {
  return `${JSON.stringify(name)}: ${JSON.stringify(value)}`;
}

/** Pretty-print JSON, or null when the text is not JSON. Presentation of one fact, not a second fact. */
function prettyOf(value: string): string | null {
  const t = value.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    const out = JSON.stringify(JSON.parse(t), null, 2);
    return out === t ? null : out;
  } catch {
    return null; // malformed: the raw value still renders, unchanged, which is when you most need to see it
  }
}

function settingView(def: SettingDef, env: StatusEnv, eventsArmed = false): SettingView {
  const raw = readKey(env, def.name);
  const set = isSet(raw);
  const value = set && def.kind !== 'secret' && typeof raw === 'string' ? raw : null;
  return {
    name: def.name, group: def.group, kind: def.kind,
    what: def.what, whenUnset: def.whenUnset, affects: def.affects,
    set, value, source: raw === undefined ? 'default' : 'env', editable: false, whyNot: whyNotText(def),
    howToSet: howToSetText(def),
    defaultValue: def.defaultValue ?? null,
    importance: def.importance ?? 'normal',
    example: def.example ?? null,
    gate: gateOf(def, env, eventsArmed),
    applicability: applicabilityOf(def, env),
    // Null for a secret by construction: `value` is already null there, so no branch can leak one.
    copy: value === null ? null : { pretty: prettyOf(value), wrangler: wranglerLine(def.name, value) },
  };
}

// ── subsystem cards: everything NOT in FEATURE_REGISTRY, but still config the page must explain ─────
//
// `/kit/status` is served AHEAD of five of the seven pre-routing config validators (see worker.ts route
// ordering), deliberately, so a misconfigured deployment can still explain itself. Those validators
// RETURN a string — but the raw resolvers behind these cards (`parseNsEventsConfig`, `resolveMenus`,
// `parseDownloads`, `parseHideList`, `resolveRingotelConfig`) THROW. `probeState` is the one place that
// boundary is crossed, so a throw becomes a `misconfigured` card instead of a 500 on the very page meant
// to explain the 500. Every call to a resolver that can throw goes through it — no exceptions.
function probeState<T>(fn: () => T): { ok: true; value: T } | { ok: false; reason: string } {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

type CardResult = { state: FeatureState; missing?: MissingRequirement[]; notes?: string[] };

function authCard(env: StatusEnv): CardResult {
  // The only thing that can make delegated auth inert is having nowhere to send it. Every caller brings
  // their own ns_t, so there is no stored credential to be present, absent, or refused.
  if (!nsServerConfigured(env)) return inertOn(env, ['NS_SERVER']);
  return { state: 'on' };
}


const brandingCard = (env: StatusEnv): CardResult => ({ state: isSet(env.BRAND_NAME) || isSet(env.BRAND_ACCENT) ? 'on' : 'off' });
// ALLOWED_DOMAINS/BLOCKED_DOMAINS are worker.ts-only (no dedicated *Env interface) — read via readKey,
// the one sanctioned generic lookup, same as every SettingView.
const domainsCard = (env: StatusEnv): CardResult =>
  ({ state: isSet(readKey(env, 'ALLOWED_DOMAINS')) || isSet(readKey(env, 'BLOCKED_DOMAINS')) ? 'on' : 'off' });

function cacheCard(env: StatusEnv): CardResult {
  if (scopeOf(env) !== 'default') return { state: 'on' };
  // `CACHE_SCOPE=default` (or a value `scopeOf` sanitizes down to nothing) is SET and still not a namespace,
  // so this goes through the funnel rather than naming it missing.
  return inertOn(env, ['CACHE_SCOPE'], ['caches.default is zone-shared, so every deployment left at "default" on this zone collides.']);
}

/** Shared gate for `ringotel` (the base integration) AND `eligibility` (its activation rules) — the
 *  latter has nothing to govern until the former is configured, so both read the same predicate, each
 *  against its own settings list. `ringErr` (resolveRingotelConfig, already safely wrapped by
 *  ringotelConfigError above) overrides both to misconfigured rather than reporting a stale on/inert. */
function ringotelGateCard(env: StatusEnv, ringErr: string | null): CardResult {
  if (ringErr) return { state: 'misconfigured', notes: [ringErr] };
  return ringotelEnabled(env) ? { state: 'on' } : inertOn(env, ['RINGOTEL_API_KEY']);
}

/** Same predicate `ringotel.activate`'s feature card uses (`prereqSatisfied`) — a raw
 *  `isSet(RINGOTEL_WRITE_DOMAINS)` reads `on` for `','` (parses to an empty domain list; every write is
 *  refused), which is exactly the state `ringotel.activate` reports as `inert`. Two cards deriving "is
 *  the write rail armed" two different ways is how they end up disagreeing about one fact. */
function writesCard(env: StatusEnv, ringErr: string | null): CardResult {
  if (ringErr) return { state: 'misconfigured', notes: [ringErr] };
  const hasKey = prereqSatisfied('RINGOTEL_API_KEY', env);
  const hasRail = prereqSatisfied('RINGOTEL_WRITE_DOMAINS', env);
  if (hasKey && hasRail) return { state: 'on' };
  const unmet: string[] = [];
  if (!hasKey) unmet.push('RINGOTEL_API_KEY');
  if (!hasRail) unmet.push('RINGOTEL_WRITE_DOMAINS');
  return inertOn(env, unmet);
}

function appAccessCard(env: StatusEnv, aaErr: string | null): CardResult {
  if (aaErr) return { state: 'misconfigured', notes: [aaErr] };
  const key = ringotelEnabled(env);
  if (key) return { state: 'on' };
  const unmet: string[] = [];
  if (!key) unmet.push('RINGOTEL_API_KEY');
  return inertOn(env, unmet);
}

const ssoCard = (env: StatusEnv): CardResult => ({ state: isSet(env.RINGOTEL_SSO_SERVICE) ? 'on' : 'off' });

// misconfigured outranks off: PORTAL_APPS_HIDE alone (no PORTAL_MENUS) can still break resolveMenus
// (menuConfigError's probe sweep hits the legacy-hide path even with PORTAL_MENUS unset), so the error
// check must run BEFORE the presence test — a broken deployment must never present as merely unused.
function menusCard(env: StatusEnv, menuErr: string | null): CardResult {
  if (menuErr) return { state: 'misconfigured', notes: [menuErr] };

  // Two settings can hide an Apps-menu entry and they merge. Setting both is legal, but reading either one
  // alone then tells you less than the whole story — so when both are set, say what the merged list is and
  // where each label came from. That visibility is the entire reason a union is safe here rather than the
  // fatal error this used to be; without it, two settings really would be two places to look.
  const notes: string[] = [];
  if (bothAppsHideSet(env)) {
    // A fictional probe context: this note is about the CONFIG, not about the reader, and a note whose
    // content depended on who opened the console would report a different deployment to each viewer.
    // Domain- or app-targeted rungs therefore report only what applies with neither matched.
    const src = appsHideSources(env, { domain: 'probe.example', app: 'none' });
    const from = (list: string[]): string => (list.length ? list.join(', ') : 'nothing at this rung');
    notes.push(
      `Two settings hide Apps-menu entries and both are set. They merge — neither is ignored. ` +
      `PORTAL_MENUS["apps"].hide contributes: ${from(src.menus)}. PORTAL_APPS_HIDE contributes: ${from(src.legacy)}. ` +
      `Any label named by both is hidden once. Targeted rungs are shown as they resolve for an untargeted domain, ` +
      `so a per-domain or per-app rung may add more for the users it names.`,
    );
  }
  if (!isSet(env.PORTAL_MENUS)) return { state: isSet(env.PORTAL_APPS_HIDE) ? 'on' : 'off', notes };
  return { state: 'on', notes };
}

function injectionCard(env: StatusEnv, kitErr: string | null): CardResult {
  if (kitErr) return { state: 'misconfigured', notes: [kitErr] };
  if (env.PORTAL_HANDOFF_URL === undefined) {
    return inertOn(env, ['PORTAL_HANDOFF_URL'], ['Set PORTAL_HANDOFF_URL to "" to declare deliberately that there is no vendor to hand off to.']);
  }
  return { state: 'on' };
}

const nsDevicesCard = (env: StatusEnv): CardResult => ({ state: nsDeviceDetailsEnabled(env) ? 'on' : 'off' });

// Only the three settings genuinely specific to THIS feature — domains/baseUrl/pathSecret. Deliberately
// NOT NS_API_KEY/NS_ADMIN_USER/NS_ADMIN_PASS (identity is its own subsystem card) and NOT ringotelEnabled
// (a Ringotel deployment that never touched any of these three has not "attempted" events — see the
// off/inert split in eventsCard below; folding ringotelEnabled in here used to make every Ringotel
// deployment read `inert` for a feature nobody had asked for).
const EVENTS_TOUCH_KEYS = ['NS_EVENTS_DOMAINS', 'NS_EVENTS_BASE_URL', 'NS_EVENTS_PATH_SECRET'];

/** What `getServiceToken` needs on top of admin credentials. `identityUsable` is exactly "both of these are
 *  set", so whichever halves are absent ARE the unmet requirement — and only those. Naming both
 *  unconditionally (as `eventsCard` and `identityCard` each did) had an operator re-putting a client id that
 *  was already set while the secret stayed absent. One derivation, read by both cards. */
const OAUTH_PAIR = ['NS_OAUTH_CLIENT_ID', 'NS_OAUTH_CLIENT_SECRET'];
const oauthUnmet = (env: StatusEnv): string[] => OAUTH_PAIR.filter((k) => !isSet(readKey(env, k)));

/** `parseNsEventsConfig` throws under an explicit `NS_EVENTS=on` it cannot satisfy — probed, never called
 *  bare. `armed` ⇒ `on`, UNLESS the resolved identity cannot actually mint a token: `parseNsEventsConfig`
 *  only checks identity PRESENCE (`resolveWriteIdentity`'s job), not whether it can be USED —
 *  `getServiceToken` (`nsIdentity.ts`) additionally needs `NS_OAUTH_CLIENT_ID`/`NS_OAUTH_CLIENT_SECRET`
 *  for an `admin` identity, so trusting `cfg.armed` alone here would over-claim (this card used to).
 *  An explicit `off` ⇒ `off`. `auto`-and-not-armed is split in two: if NONE of `EVENTS_TOUCH_KEYS` was
 *  ever touched, there is nothing to fix, so it reads as `off` — the same as an explicit `off`, and
 *  consistent with `NS_EVENTS`'s own descriptor ("Same as auto — … inert (no error) until then"
 *  describes the SETTING; a deployment that never attempted this belongs on the same footing as one
 *  that turned it off). Once one of the three IS touched, it's a genuine partial attempt — `inert`, with
 *  what's still missing named. */
function eventsCard(env: StatusEnv): CardResult & { armed: boolean } {
  const probe = probeState(() => parseNsEventsConfig(env));
  if (!probe.ok) return { state: 'misconfigured', notes: [probe.reason], armed: false };
  const cfg = probe.value;

  if (cfg.armed && cfg.identity && !identityUsable(cfg.identity, env)) {
    return { ...inertOn(env, oauthUnmet(env)), armed: false };
  }
  if (cfg.armed) return { state: 'on', armed: true };
  if (cfg.intent === 'off') return { state: 'off', armed: false };

  const touched = EVENTS_TOUCH_KEYS.some((k) => isSet(readKey(env, k)));
  if (!touched) return { state: 'off', armed: false };

  const unmet: string[] = [];
  if (!cfg.baseUrl) unmet.push('NS_EVENTS_BASE_URL');
  if (!cfg.pathSecret) unmet.push('NS_EVENTS_PATH_SECRET');
  if (!cfg.identity) unmet.push('NS_API_KEY');
  else if (!identityUsable(cfg.identity, env)) unmet.push(...oauthUnmet(env));
  if (cfg.domains !== '*' && cfg.domains.length === 0) unmet.push('NS_EVENTS_DOMAINS');
  if (!ringotelEnabled(env)) unmet.push('RINGOTEL_API_KEY');
  return { ...inertOn(env, unmet), armed: false };
}

const IDENTITY_NOTE = 'NS_API_KEY is the only stored NetSapiens credential this Worker has, and it is used solely for work that arrives with no caller.';

/** Takes the ALREADY-RESOLVED identity (`resolveWriteIdentity`, the same call `parseNsEventsConfig` makes
 *  internally) rather than re-deriving "which credential wins" from raw env — admin wins over API only
 *  when BOTH `NS_ADMIN_USER` and `NS_ADMIN_PASS` are set, and a second copy of that precedence check is
 *  exactly the kind of drift this file exists to avoid. */
function identityCard(identity: NsWriteIdentity | undefined, env: StatusEnv, eventsArmed: boolean): CardResult {
  if (!identity) {
    return eventsArmed
      ? inertOn(env, ['NS_API_KEY'], [IDENTITY_NOTE])
      : { state: 'off', notes: [IDENTITY_NOTE] };
  }
  if (identityUsable(identity, env)) return { state: 'on', notes: [IDENTITY_NOTE] };
  // An admin-credential identity was configured (NS_ADMIN_USER + NS_ADMIN_PASS both set — admin wins over
  // NS_API_KEY, per resolveWriteIdentity's precedence), but getServiceToken (nsIdentity.ts) cannot mint a
  // token without NS_OAUTH_CLIENT_ID/NS_OAUTH_CLIENT_SECRET too. A genuine partial attempt — `inert`
  // regardless of whether events happens to be armed, the same off/inert rule applied everywhere else in
  // this file: something was touched, so there is something to fix.
  return inertOn(env, oauthUnmet(env), [IDENTITY_NOTE]);
}

/** Takes the events card's OWN result, not a boolean. Offboarding has no requirement of its own beyond
 *  `NS_EVENTS_OFFBOARD` — which is by definition set when this branch runs — so the gap is whatever is
 *  keeping events from arming, and the events card already computed exactly that. Naming `NS_EVENTS` here
 *  used to be a second, wrong derivation of it: `NS_EVENTS=on` with an unusable identity reported
 *  "Missing: NS_EVENTS" about a setting literally set to `on`. Forward events' own missing[]/notes, don't
 *  re-derive them.
 *
 *  But forwarding alone left a dead pointer: when NOTHING toward events has been touched, `eventsCard`
 *  reads plain `off` with an EMPTY missing[]/notes — nothing to forward — so "see the events card" sent the
 *  operator to a card that says nothing at all. Route `NS_EVENTS` itself through the same `requirements()`
 *  funnel every other card uses: genuinely absent ⇒ a real `missing[]` entry (useful guidance restored,
 *  exactly the M2 fix's own invariant — `missing[]` never names a setting `SettingView.set` reports true);
 *  present (e.g. explicitly "off", or "on" but blocked elsewhere) ⇒ demoted to a note by
 *  `presentButUnmet`, same as everywhere else. One derivation, so this can't reintroduce the bug the
 *  forwarding fix closed. */
function offboardingCard(env: StatusEnv, events: CardResult & { armed: boolean }): CardResult {
  const requested = (env.NS_EVENTS_OFFBOARD ?? '').trim().toLowerCase() === 'deactivate';
  if (!requested) return { state: 'off' };
  if (events.armed) return { state: 'on' };
  const r = requirements(env, ['NS_EVENTS'], [
    'NS_EVENTS_OFFBOARD=deactivate has no effect until NetSapiens event subscriptions are armed — see the "NetSapiens event subscriptions" card for what is still needed.',
    ...(events.notes ?? []),
  ]);
  return {
    state: 'inert',
    missing: [...(events.missing ?? []), ...r.missing],
    notes: r.notes,
  };
}

function ratelimitCard(env: StatusEnv): CardResult {
  const bound = readKey(env, 'JWT_RATE_LIMITER') != null;
  return {
    state: 'on',
    notes: [bound
      ? 'JWT_RATE_LIMITER is bound — ns_t verification throttling is fleet-wide.'
      : 'JWT_RATE_LIMITER is not bound — the in-isolate limiter still applies, just per-isolate rather than fleet-wide.'],
  };
}

// The two unwired integrations carry NO notes. They used to say "not wired into this Worker — there is
// nothing here to configure", which was the right content when it was the only content: their one-line
// description said the same thing, and now their `detail` prose (statusModel.ts) says it again with the
// intent attached. Three copies of one sentence on one card, and the note was the least informative of the
// three. Dropping it also makes the card genuinely bare, so the renderer's "show no empty block" branch is
// reachable rather than theoretical.
// (Standing rule for whatever replaces this: no private repo/package name, no mention of "the workspace" —
// this file ships to a public mirror. What the OPERATOR needs is what it does and what to set.)

/**
 * Every subsystem NOT covered by FEATURE_REGISTRY, but still config an operator needs explained. One
 * table, so the whole non-feature surface is auditable in one place — mirrors FEATURE_REGISTRY's role for
 * features. `group` picks the closest existing `SettingGroup` for a subsystem with no group of its own
 * (`auth`/`exposure`/`cache`/`nsdevices` → `core`; `writes`/`sso`/`offboarding`/`ratelimit` → the group
 * their primary setting already carries; `onebill`/`documo` → `core`, having no setting to inherit from).
 */
/**
 * Which subsystems cannot act in this deployment's mode, and why. Declared here beside the row table rather
 * than as a flag on each row, because the reason is per-MODE prose that two subsystems share.
 *
 * Kept deliberately short: only where inapplicability is STRUCTURAL, not merely "currently unused". A wrong
 * entry dims a live subsystem, which is worse than saying nothing.
 */
const PORTAL_INAPPLICABLE: Record<string, string> = {
  access: 'Ignored in portal-backend mode. A Cloudflare Access gate would refuse the plain <script src> that loads the injected primary, so the whole injection would die before any ns_t existed — and there is nothing here for it to protect, since every caller supplies their own ns_t and that verification IS the gate. Set it only on a standalone deployment.',
};
function applicabilityOfSubsystem(id: string, _env: StatusEnv): Applicability {
  const why = PORTAL_INAPPLICABLE[id];
  return why ? { applicable: false, why } : { applicable: true, why: null };
}

function buildSubsystems(
  env: StatusEnv,
  hostname: string,
  errs: { kitErr: string | null; menuErr: string | null; aaErr: string | null; ringErr: string | null },
  events: CardResult & { armed: boolean },
): SubsystemCard[] {
  const identity = resolveWriteIdentity(env);

  const rows: Array<{ id: string; name: string; description: string; group: SettingGroup; tab: SubsystemTab; parent: string | null; settings: string[]; result: CardResult }> = [
    { id: 'auth', name: 'Authentication', group: 'core', tab: 'deployment', parent: null,
      description: 'How this Worker authenticates to NetSapiens: every caller supplies their own ns_t, which is forwarded verbatim. No credential is stored for user traffic.',
      settings: ['NS_SERVER', 'NS_PORTAL_ISS', 'JWT_RATE_LIMITER'],
      result: authCard(env) },
    { id: 'branding', name: 'Branding', group: 'branding', tab: 'deployment', parent: null,
      description: 'Cosmetic accent color and product name shown in the viewer and page titles.',
      settings: ['BRAND_NAME', 'BRAND_ACCENT', 'BRAND_LABEL'],
      result: brandingCard(env) },
    { id: 'domains', name: 'Domain allow/block lists', group: 'domains', tab: 'deployment', parent: null,
      description: 'App-layer restriction on which NetSapiens domains this deployment will read, on top of the token\'s own scope.',
      settings: ['ALLOWED_DOMAINS', 'BLOCKED_DOMAINS'],
      result: domainsCard(env) },
    { id: 'cache', name: 'Cache namespace', group: 'core', tab: 'deployment', parent: null,
      description: 'Per-deployment key prefix for the shared, zone-wide Cache API.',
      settings: ['CACHE_SCOPE'],
      result: cacheCard(env) },
    { id: 'ringotel', name: 'Ringotel integration', group: 'ringotel', tab: 'integration', parent: null,
      description: 'The base Ringotel AdminAPI integration — everything else Ringotel-related is gated on this being configured.',
      settings: ['RINGOTEL_API_KEY', 'RINGOTEL_BASE_URL', 'RINGOTEL_LABEL', 'RINGOTEL_LABEL_SHORT', 'RINGOTEL_PRESENCE', 'RINGOTEL_OVERRIDES', 'RINGOTEL_ROTATE_SIP_ON_ACTIVATE'],
      result: ringotelGateCard(env, errs.ringErr) },
    { id: 'eligibility', name: 'Activation eligibility rules', group: 'eligibility', tab: 'integration', parent: 'ringotel',
      description: 'Which extensions are excluded from Ringotel activation, by name, extension pattern, or device heuristic.',
      settings: ['RINGOTEL_API_KEY', 'RINGOTEL_ACTIVATION_SUFFIX', 'RINGOTEL_EXCLUDE_NAMES', 'RINGOTEL_EXCLUDE_EXTS', 'RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN', 'RINGOTEL_EXCLUDE_NO_DEVICES', 'RINGOTEL_RESELLER_OVERRIDE', 'RINGOTEL_PREPOP_INCLUDE_SOFT'],
      result: ringotelGateCard(env, errs.ringErr) },
    { id: 'writes', name: 'Ringotel write rail', group: 'eligibility', tab: 'integration', parent: 'ringotel',
      description: 'The domains in which activate / deactivate / password-reset writes are permitted to run.',
      settings: ['RINGOTEL_API_KEY', 'RINGOTEL_WRITE_DOMAINS'],
      result: writesCard(env, errs.ringErr) },
    { id: 'appaccess', name: 'Self-service app access', group: 'appaccess', tab: 'integration', parent: 'ringotel',
      description: 'The signed-in user\'s own "how do I sign into the app" surface — SSO detection, hide list, download links.',
      settings: ['RINGOTEL_API_KEY', 'RINGOTEL_SSO_SERVICE', 'SSO_AUTO_ACTIVATE', 'PORTAL_APPS_HIDE', 'PORTAL_APP_DOWNLOADS'],
      result: appAccessCard(env, errs.aaErr) },
    { id: 'sso', name: 'Ringotel SSO', group: 'appaccess', tab: 'integration', parent: 'ringotel',
      description: 'Whether this deployment claims Ringotel single sign-on for its users.',
      settings: ['RINGOTEL_SSO_SERVICE'],
      result: ssoCard(env) },
    { id: 'menus', name: 'Portal menu customization', group: 'menus', tab: 'deployment', parent: null,
      description: 'Adding or hiding entries in the Apps, account, and Management menus.',
      settings: ['PORTAL_MENUS', 'PORTAL_APPS_HIDE'],
      result: menusCard(env, errs.menuErr) },
    { id: 'injection', name: 'Manager-Portal injection', group: 'injection', tab: 'deployment', parent: null,
      description: 'The primary + gated secondary scripts served to the Manager Portal in portal-backend mode.',
      settings: ['PRIMARY_BASENAME', 'PORTAL_HANDOFF_URL', 'PORTAL_SECONDARIES', 'PORTAL_FEATURES', 'PORTAL_SUPERADMINS', 'RINGOTEL_APP_BASE_URL', 'ASSETS'],
      result: injectionCard(env, errs.kitErr) },
    { id: 'nsdevices', name: 'NS device enrichment', group: 'core', tab: 'deployment', parent: null,
      description: 'Desk-phone model and live registration presence annotated onto device lines.',
      settings: ['NS_DEVICE_DETAILS'],
      result: nsDevicesCard(env) },
    { id: 'events', name: 'NetSapiens event subscriptions', group: 'events', tab: 'integration', parent: 'ringotel',
      description: 'Keeps the app directory in sync when a user is edited directly in NetSapiens, not just through an explicit action.',
      settings: ['NS_EVENTS', 'NS_EVENTS_DOMAINS', 'NS_EVENTS_BASE_URL', 'NS_EVENTS_PATH_SECRET', 'NS_EVENTS_MODELS', 'NS_EVENTS_RENEW_HORIZON', 'NS_EVENTS_TARGET_LIFETIME', 'NS_EVENTS_ALLOW_IPS', 'NS_EVENTS_GEO_SUPPORT', 'NS_EVENTS_PREFERRED_SERVER', 'NS_EVENTS_MAX_EVENTS', 'NS_EVENTS_DIAG_RAW', 'NS_EVENTS_DEVICE_REPAIR', 'NS_EVENTS_SWEEP_MAX', 'RINGOTEL_WRITE_DOMAINS', 'RINGOTEL_API_KEY'],
      result: events },
    { id: 'offboarding', name: 'Offboarding on NS deletion', group: 'events', tab: 'integration', parent: 'ringotel',
      description: 'Deactivating a user\'s app record when NetSapiens reports them deleted.',
      settings: ['NS_EVENTS_OFFBOARD', 'NS_EVENTS'],
      result: offboardingCard(env, events) },
    { id: 'identity', name: 'Background service identity', group: 'identity', tab: 'integration', parent: 'ringotel',
      description: 'The credential used to authenticate NetSapiens writes that have no caller (event handling).',
      settings: ['NS_API_KEY', 'NS_ADMIN_USER', 'NS_ADMIN_PASS', 'NS_OAUTH_SERVER', 'NS_OAUTH_CLIENT_ID', 'NS_OAUTH_CLIENT_SECRET'],
      result: identityCard(identity, env, events.armed) },
    { id: 'ratelimit', name: 'ns_t verification rate limiting', group: 'bindings', tab: 'deployment', parent: null,
      description: 'Throttles live ns_t verification calls against the NetSapiens core.',
      settings: ['JWT_RATE_LIMITER'],
      result: ratelimitCard(env) },
    { id: 'onebill', name: 'OneBill billing integration', group: 'core', tab: 'integration', parent: null,
      description: 'Not wired into this Worker.',
      settings: [],
      result: { state: 'not-integrated' } },
    { id: 'documo', name: 'Documo fax integration', group: 'core', tab: 'integration', parent: null,
      description: 'Not wired into this Worker.',
      settings: [],
      result: { state: 'not-integrated' } },
  ];

  // A subsystem that cannot act in this mode is DROPPED when it has nothing configured, and kept-but-dimmed
  // when it does.
  //
  // David asked for the Access and exposure cards to be removed from the console on a portal deployment, and
  // they are indeed irrelevant there. Worth recording that the mode branch is belt-and-braces rather than
  // load-bearing: THIS CONSOLE IS PORTAL-MODE-ONLY — `/kit/status` is not routed at all in standalone
  // (worker.ts) — so there is no standalone reader to protect, and the standalone branch below is unreachable
  // today. It is kept because `applicabilityOfSubsystem` is the general mechanism the Config rows use too, and
  // because after the standalone/portal split these subsystems will not exist in a portal build at all.
  //
  // NOT "unless something is set". I argued for keeping a set-but-ignored value visible, on the grounds that a
  // stored NS_API_TOKEN doing nothing is a credential worth knowing about; David overruled it — "it shouldn't
  // be mentioned anywhere there, it's irrelevant/inert to the Portal deployment" — and he is right that a
  // console which keeps surfacing something inert is training its reader to ignore it. Gone means gone.
  const kept = rows.filter((r) => applicabilityOfSubsystem(r.id, env).applicable);
  const ordered = [...kept].sort((a, b) =>
    Number(!applicabilityOfSubsystem(a.id, env).applicable) - Number(!applicabilityOfSubsystem(b.id, env).applicable));
  return ordered.map((r) => ({
    id: r.id, name: r.name, description: r.description, group: r.group, tab: r.tab, parent: r.parent,
    applicability: applicabilityOfSubsystem(r.id, env),
    // Prose lives in statusModel.ts, attached here. `?? []` rather than a throw: a card with no explanation
    // yet must still render — the drift guard in statusModel.selftest.ts is what makes the gap loud, and it
    // belongs in the tests rather than in a 500 on the page that exists to explain the deployment.
    detail: SUBSYSTEM_DETAIL[r.id] ?? [],
    state: r.result.state, missing: r.result.missing ?? [], settings: r.settings, notes: r.result.notes ?? [],
  }));
}

/**
 * Which of the seven config-error checks "owns" a feature — a failure there makes the feature's OWN
 * runtime path unverifiable, not merely broken elsewhere in the deployment. A key with no entry here has
 * no single owning subsystem (e.g. `callflow.view` has a prerequisite, NS_SERVER, but its read path
 * touches no config that any of the seven validators guards). Declared as one table for the same reason
 * PREREQS is — audited 2026-08-07 against what each feature's `worker.ts` handler ACTUALLY reads, not
 * guessed from its name:
 *
 *   - `portal.access` / `portal.self` → `kitErr`: both are delivered by the injected bundle
 *     (`buildKitBundle`/`buildSelfBundle`), which `kitConfigError` validates (basename, manifest,
 *     handoff URL, the app-dashboard link, the ASSETS binding).
 *   - `ringotel.activate` / `.resetPassword` / `.prepop`, and `me.resetPassword` → `ringErr`: all four
 *     routes call `resolveRingotelConfig(env)` directly (worker.ts's `/rapp/activate`,
 *     `/rapp/resetPassword`, `/rapp/prepop/apply`, `/me/resetPassword` handlers), which is exactly what
 *     `ringotelConfigError` validates.
 *   - `me.appAccess` AND `ringotel.profileAppAccess` → `aaErr`: both routes call the SAME
 *     `computeAppAccessProjection` (worker.ts), which calls `parseDownloads`/`parseHideList` —
 *     `appAccessConfigError`'s exact surface. (`ringotel.profileAppAccess` was missing from this table
 *     before the 2026-08-07 review — a malformed `PORTAL_APP_DOWNLOADS` made that card report `on` for
 *     a feature whose admin sign-in block would 500.)
 *   - `me.menuConfig` → `menuErr`: its route calls `resolveMenus(env, ...)`, `menuConfigError`'s surface.
 *   - `me.appStatus` → NO owner (removed 2026-08-07): its route (`/me/status`) calls only
 *     `computeUserStatus`, which reads Ringotel *enrichment* config (label/presence/overrides — no
 *     dedicated validator among the seven), never `parseDownloads`/`parseHideList`. It was wrongly
 *     mapped to `aaErr` (copied from its appAccess-menu neighbors) even though its own path never
 *     touches that config.
 *   - `ringotel.orgStatus` / `.userStatus` / `.orgList` / `.refresh` / `.profileStatus`, `me.devices`,
 *     `kit.status` → NO owner: their routes read Ringotel enrichment config or nothing config-error-
 *     guarded at all (`me.devices` is a pure NS device read).
 */
type OwnerErrs = { featuresErr: string | null; kitErr: string | null; ringErr: string | null; aaErr: string | null; menuErr: string | null };
const FEATURE_OWNER: Partial<Record<string, keyof Omit<OwnerErrs, 'featuresErr'>>> = {
  'portal.access': 'kitErr',
  'portal.self': 'kitErr',
  'ringotel.activate': 'ringErr',
  'ringotel.resetPassword': 'ringErr',
  'ringotel.prepop': 'ringErr',
  'me.resetPassword': 'ringErr',
  'ringotel.profileAppAccess': 'aaErr',
  'me.appAccess': 'aaErr',
  'me.menuConfig': 'menuErr',
};

/**
 * Who a feature is FOR, derived from the key namespace that already encodes it rather than a second
 * hand-kept list: `me.*` acts on the reader's own account, and `portal.self` is the bundle that delivers
 * them. Derived, so a new `me.*` feature cannot silently be filed as an admin capability and then be
 * described with a "can you use this" row that answers nobody's question.
 */
/**
 * Delivery — which bundle carries a feature, and therefore which gate must pass for it to reach a browser
 * at all — is `features.ts`'s `carriersFor`, imported above. It is NOT `audience`. Those are two different
 * facts and conflating them was a live bug for about ten minutes: re-labelling `me.menuConfig` as an admin
 * feature (correct — it is operator config applied to everyone) instantly made the matrix report it
 * reachable with `portal.self` switched off, which is false. The bundle that delivers a feature does not
 * care who the feature is for, so `worker.ts` refuses on the delivery gate no matter what this console
 * calls the feature.
 */

export function audienceOf(def: FeatureDef): FeatureAudience {
  // An explicit declaration wins. The namespace rule is right for five of the six `me.*` features and wrong
  // for `me.menuConfig`, where the prefix records which BUNDLE delivers the feature rather than whose account
  // it concerns — so the registry gets to say so rather than the rule being loosened for the other five.
  if (def.audience) return def.audience;
  return def.key === 'portal.self' || def.key.startsWith('me.') ? 'self' : 'admin';
}

function featureCard(
  f: FeatureDef,
  env: StatusEnv,
  principal: Principal | null,
  superadmins: string[],
  overrides: Record<string, Gate>,
  policies: FeaturePolicies,
  errs: OwnerErrs,
): FeatureCard {
  const source: FeatureCard['gate']['source'] = Object.prototype.hasOwnProperty.call(overrides, f.key) ? 'PORTAL_FEATURES' : 'default';
  const gate = source === 'PORTAL_FEATURES' ? overrides[f.key] : f.default;
  const policy: Policy = policies[f.key] ?? [];
  const viewerPasses = principal ? can(principal, f.key, policies) : false;
  const req = requirementsFor(f.key, env);

  const ownerKey = FEATURE_OWNER[f.key];
  const ownerErr = errs.featuresErr ?? (ownerKey ? errs[ownerKey] : null);

  // `unmet`, not `missing.length`: a requirement whose setting is present but wrong (NS_SERVER still the
  // shipped placeholder, PORTAL_MODE=0, RINGOTEL_WRITE_DOMAINS=",") is not "missing" and never appears in
  // that list — keying the state off the list would report such a feature `on`.
  let state: FeatureState;
  if (ownerErr) state = 'misconfigured';
  else if (policy.length === 0) state = 'off';
  else if (req.unmet.length > 0) state = 'inert';
  else state = 'on';

  // Every me.* feature is delivered by the SELF bundle, which is never served unless portal.self
  // passes (worker.ts refuses /kit/self.js and every /me/* route otherwise). A me.* card's OWN gate can
  // read `on` while the surface that would carry it to a browser never loads — same confidently-wrong
  // family as `inert`, so say it rather than let the card imply the feature actually reaches a user.
  // Expressed as a note (not a PREREQS entry): PREREQS/`missing` names ENV SETTINGS a reader can look
  // up in `settings`/SETTINGS, and portal.self is a feature gate, not a setting.
  const notes: string[] = [...req.notes];
  if (f.allowedLevels) notes.push(`Widening this gate from PORTAL_FEATURES is floored at: ${f.allowedLevels.join(', ')}.`);
  if (f.key.startsWith('me.') && (policies['portal.self'] ?? []).length === 0) {
    notes.push('Requires portal.self, which is currently off — this feature is unreachable regardless of its own gate.');
  }

  return {
    key: f.key,
    name: f.name,
    description: f.description,
    audience: audienceOf(f),
    detail: f.detail ?? [],
    state,
    gate: { source, inWords: gateInWords(gate, superadmins), rules: policy },
    viewerPasses,
    missing: req.missing,
    settings: settingsFor(f.key),
    notes,
  };
}

// ── permissions: the matrix, and the honest version of the write seam ────────────────────────────────
//
// The console was built by someone whose mental model is the code's — `can(principal, key, policies)`, a
// per-principal boolean — and that shape leaked into the UI as a per-principal row on every card ("You:
// you pass this gate"). An operator's model is a MATRIX: which of my users get what. Two facts make the
// per-principal row nearly vacuous here, which is why this tab exists rather than a reworded row:
//
//   1. A superadmin passes every gate. `resolveGate` unions the superadmin rule into every gate except
//      `off` and the call-center-only ones — so of 18 cards, a superadmin reads "you pass" on ~16, on
//      every deployment, forever.
//   2. `kit.status` is floored at reseller, so nobody below that can ever open this console and look for
//      themselves. The populations the answer would be informative about can never be the reader.

/**
 * An account id guaranteed NOT to be named by any configured gate or superadmin list.
 *
 * The matrix answers "what would a person of scope X get", and that question is only well-posed for
 * someone who is not ALSO granted by name. A synthesized id that happened to collide with a real entry
 * would silently report every cell as reachable — the console over-claiming about authorization, which is
 * the exact failure mode this whole feature exists to prevent. So collect every named account first and
 * pick around them.
 */
function unnamedAccountId(domain: string, superadmins: string[], overrides: Record<string, Gate>): string {
  const taken = new Set(superadmins.map((s) => s.toLowerCase()));
  for (const f of FEATURE_REGISTRY) {
    const gate = effectiveGate(f.key, overrides);
    if (gate === 'off') continue;
    try {
      for (const u of gateLevels(gate).users) taken.add(u.trim().toLowerCase());
    } catch (e) {
      if (!(e instanceof FeaturesConfigError)) throw e; // a malformed gate names nobody we can read
    }
  }
  let local = 'someone';
  while (taken.has(`${local}@${domain}`.toLowerCase())) local += 'x';
  return `${local}@${domain}`;
}

/**
 * Which NS scopes a feature's `allowedLevels` floor puts permanently out of reach.
 *
 * A level admits its own scope and everything above it (`LEVEL_SCOPES`), so the reachable set is the union
 * over the allowed levels — and every other known scope is unreachable no matter how the operator writes
 * the override. `off` and `superadmin` are specials that name no scope, so they contribute nothing here;
 * that is correct, since neither widens the gate to a scope.
 */
function floorBlockedScopes(allowed: string[] | undefined): string[] {
  if (!allowed) return [];
  const reachable = new Set<string>();
  for (const level of allowed) {
    for (const scope of LEVEL_SCOPES[level] ?? []) reachable.add(scope.toLowerCase());
  }
  return KNOWN_SCOPES.filter((s) => !reachable.has(s.toLowerCase()));
}

const synthPrincipal = (id: string, scope: string, domain: string): Principal =>
  ({ id: id.toLowerCase(), user: id.split('@')[0], domain, scope, masking: false, operator: null });

/**
 * The scope the two NAMED axes (superadmin, per-feature `users:`) are evaluated at.
 *
 * The lowest scope this deployment knows, deliberately: the claim being tested is what a NAME buys on its
 * own, and evaluating at reseller scope would prove nothing the Reseller column does not already show.
 * `Simple User` is the bottom of `KNOWN_SCOPES` and has no level of its own, so no gate can admit it by
 * level — anything that passes here passed because of the name.
 */
const LOWEST_SCOPE = 'Simple User';

/** A named account, in ITS OWN domain — a `users:` grant usually names someone in another domain, and
 *  that is precisely the case the fleet-read rule exists for. */
const namedPrincipal = (account: string): Principal =>
  synthPrincipal(account, LOWEST_SCOPE, account.split('@')[1] ?? 'example.com');

/**
 * ONE cell. Three layers, in the order the Worker actually applies them — a checker that modelled only the
 * first would confidently tell a domain-locked Office Manager they can open this console, which is exactly
 * the hole `requireFleetRead` exists to close.
 *
 *   1. **Policy** — `can(principal, key, policies)`. The same call the Worker makes, never a
 *      reimplementation: a permissions view that disagreed with the enforcement it describes is worse than
 *      no view at all.
 *   2. **Delivery and second gates** — `portal.access` / `portal.self` decide whether this person receives
 *      the bundle that carries the feature at all, and `kit.status` additionally requires reseller scope or
 *      a listed superadmin (`fleetReadAllowed`) regardless of what the policy says.
 *   3. **Prerequisites** — a feature can pass every gate and still not run, because a setting it needs is
 *      absent. "Allowed" and "works" are different answers.
 */
function permissionCell(
  card: FeatureCard,
  principal: Principal,
  policies: FeaturePolicies,
  env: StatusEnv,
): PermissionCell {
  const scope = principal.scope;
  const mk = (verdict: CellVerdict, why: string): PermissionCell => ({ scope, verdict, why, delta: null });

  if (card.state === 'misconfigured') return mk('broken', 'This deployment has a configuration error that makes this feature\'s own path unverifiable — see Overview.');
  if (card.state === 'not-integrated') return mk('no', 'Not wired into this Worker.');

  if (!can(principal, card.key, policies)) return mk('no', `${card.name} does not admit this scope.`);

  // Layer 2a — delivery, modelled on what `resolveAuth` (worker.ts) actually admits, not on a tidier
  // approximation of it:
  //
  //   - `portal.access` / `portal.self` ARE the delivery gates, so they have none of their own.
  //   - Every other feature declares which bundle carries it (`FeatureDef.deliveredBy`, defaulting to the
  //     namespace rule) and `carriersFor` turns that into the gates that admit it. One of them passing is
  //     enough — see DELIVERY_CARRIERS, which also records why `kit.status` legitimately lists two.
  const carriers = carriersFor(card.key);
  if (card.key !== 'portal.access' && card.key !== 'portal.self') {
    if (!carriers.some((c) => can(principal, c, policies))) {
      const which = carriers.join(' or ');
      return mk('blocked', `Admitted by its own gate, but this scope does not pass ${which}, so it never receives the bundle that carries this feature.`);
    }
  }

  // Layer 2b — the console's structural second gate. Wrapped: a malformed PORTAL_SUPERADMINS makes the
  // predicate throw, and that must read as "cannot be evaluated", never as a pass.
  if (card.key === 'kit.status') {
    let allowed: boolean;
    try {
      allowed = fleetReadAllowed(principal, env);
    } catch (e) {
      if (!(e instanceof FeaturesConfigError)) throw e;
      return mk('broken', 'PORTAL_SUPERADMINS cannot be parsed, so this cannot be evaluated — see Overview.');
    }
    if (!allowed) {
      return mk('blocked', 'Admitted by its own gate, but refused: this console reports settings that name other domains, and every scope below Reseller is limited to its own domain. Only reseller scope or a listed superadmin account can open it.');
    }
  }

  if (card.state === 'inert') return mk('inert', 'Allowed, but the feature cannot run as configured — see its card for what is missing.');
  if (card.state === 'off') return mk('no', 'Turned off.');
  return mk('yes', 'Available to this scope.');
}

/**
 * Mark what the CONFIGURATION changed, per cell.
 *
 * Evaluates the same cell twice — once against the effective policies, once against the registry defaults —
 * and records the direction when the two disagree. The row-level "overridden" badge says a feature was
 * configured; this says what the configuration did, and `revoked` is the direction worth catching, since an
 * override that takes access away is the easier one to write by accident.
 *
 * Only the `yes` boundary is treated as a change: a cell that moves from `inert` to `no` is a gating change
 * with no practical effect (the feature could not run either way), and marking it would put visual weight on
 * a distinction the reader cannot act on.
 */
function withDelta(effective: PermissionCell, byDefault: PermissionCell): PermissionCell {
  const now = effective.verdict === 'yes';
  const before = byDefault.verdict === 'yes';
  if (now === before) return effective;
  return { ...effective, delta: now ? 'granted' : 'revoked' };
}

/** Pretty-print a gate map, or '' for an empty one. Two-space indent, stable key order (registry order for
 *  the explicit form, insertion order for the overrides). */
const gateJson = (m: Record<string, Gate>): string =>
  (Object.keys(m).length ? JSON.stringify(m, null, 2) : '');

/**
 * Would this deployment's OWN validator accept the JSON we are about to offer? Anything the console emits
 * goes through `parseFeatures` first — including the `allowedLevels` floor — so it cannot hand out a blob
 * the Worker would reject at boot. Generating config the validator refuses would be the console failing at
 * its own thesis.
 */
function validateEmitted(json: string): string | null {
  if (!json) return null;
  try {
    parseFeatures({ PORTAL_FEATURES: json });
    return null;
  } catch (e) {
    if (!(e instanceof FeaturesConfigError)) throw e;
    return e.message;
  }
}

/**
 * Worked examples of every gate shape — what is POSSIBLE, not only what this deployment already does.
 *
 * Both emitted JSON forms are derived from the live config, so a deployment using only single-level
 * overrides can only ever be shown single-level overrides: three of the four shapes stay invisible, and the
 * one nobody discovers by accident (`levels` + `users`) is exactly the one the Named column exists to
 * describe. Keys are real registry keys and every example is run through `parseFeatures` — see
 * `examplesError` in `buildPermissions` — so a shipped example that stopped being valid surfaces as a loud
 * error rather than teaching an adopter something false.
 *
 * Fictional accounts only: this file ships to a public mirror.
 */
export const GATE_EXAMPLES: { title: string; what: string; json: string }[] = [
  {
    title: 'One level',
    what: 'The common case. Admits that level and every level above it — the admin ladder nests.',
    json: JSON.stringify({ 'ringotel.orgStatus': 'reseller' }, null, 2),
  },
  {
    title: 'A union of levels',
    what: 'Two or more levels, unioned. Use it to reach a call-center level, which sits outside the admin ladder rather than below it.',
    json: JSON.stringify({ 'ringotel.userStatus': ['office_manager', 'call_center_supervisor'] }, null, 2),
  },
  {
    title: 'A level plus named accounts',
    what: 'The escape hatch: a level for the general rule, plus specific accounts regardless of their scope. These are the accounts the Named column reports on — and note a name alone is not a bypass, they still have to receive the bundle that carries the feature.',
    json: JSON.stringify({ 'callflow.view': { levels: ['reseller'], users: ['auditor@example.com'] } }, null, 2),
  },
  {
    title: 'Named accounts only',
    what: 'No level at all — nobody but these accounts. Note that a listed PORTAL_SUPERADMINS account still passes, because the superadmin union applies to every gate that is not switched off.',
    json: JSON.stringify({ 'ringotel.prepop': { users: ['ops@example.com'] } }, null, 2),
  },
  {
    title: 'Off',
    what: 'The kill switch, and the only value with no superadmin exception: nobody at all, including you.',
    json: JSON.stringify({ 'ringotel.refresh': 'off' }, null, 2),
  },
  {
    title: 'Several at once',
    what: 'One object carries every override. Anything you do not name keeps its built-in default, including in future releases.',
    json: JSON.stringify({
      'callflow.view': 'office_manager',
      'me.devices': 'basic_user',
      'ringotel.refresh': 'off',
    }, null, 2),
  },
];

function buildPermissions(
  env: StatusEnv,
  features: FeatureCard[],
  policies: FeaturePolicies,
  superadmins: string[],
  overrides: Record<string, Gate>,
  viewerDomain: string,
): PermissionsView {
  // A real domain when we have one: raw-rule gates can key on `domains`, and evaluating against a
  // placeholder would answer a question nobody asked. Which domain was used is stated in `assumptions`
  // rather than left for the reader to guess.
  const domain = viewerDomain || 'example.com';
  const id = unnamedAccountId(domain, superadmins, overrides);

  /** The accounts one feature's own gate names directly — `gateLevels(...).users`, the same walk
   *  `resolveGate` uses. Wrapped: a malformed gate names nobody this can read, and must not throw here. */
  const namedFor = (key: string): string[] => {
    const gate = effectiveGate(key, overrides);
    if (gate === 'off') return [];
    try {
      return gateLevels(gate).users.map((u) => u.trim().toLowerCase()).filter(Boolean);
    } catch (e) {
      if (!(e instanceof FeaturesConfigError)) throw e;
      return [];
    }
  };

  // The policy set this deployment WOULD have with no PORTAL_FEATURES at all — the baseline every cell is
  // compared against for item 23's per-cell override marks. Built through the same `resolveGate` the real
  // one uses (including the superadmin union), so the comparison is like-for-like and not a second model of
  // gating. Superadmins stay in: they are not an override, and removing them would mark every superadmin
  // cell as "granted by config", which is false.
  const defaultPolicies: FeaturePolicies = {};
  for (const f of FEATURE_REGISTRY) {
    try {
      defaultPolicies[f.key] = resolveGate(f.default, superadmins);
    } catch (e) {
      if (!(e instanceof FeaturesConfigError)) throw e;
      defaultPolicies[f.key] = [];
    }
  }

  const rows: PermissionRow[] = features.map((card) => {
    const def = FEATURE_REGISTRY.find((f) => f.key === card.key)!;
    // A card whose state comes from the EFFECTIVE config, reused for the default-policy evaluation: the
    // comparison is about gating, not about prerequisites, so holding state constant is what isolates it.
    const cell = (p: Principal): PermissionCell =>
      withDelta(
        permissionCell(card, p, policies, env),
        permissionCell(card, p, defaultPolicies, env),
      );
    return {
      key: card.key,
      name: card.name,
      audience: card.audience,
      state: card.state,
      gateInWords: card.gate.inWords,
      source: card.gate.source,
      floor: def.allowedLevels ?? null,
      floorBlocks: floorBlockedScopes(def.allowedLevels),
      cells: KNOWN_SCOPES.map((scope) => cell(synthPrincipal(id, scope, domain))),
      // The superadmin axis is deliberately evaluated at the LOWEST scope this deployment knows: the claim
      // being tested is that a listed account passes "at any scope", and testing it at reseller scope
      // would prove nothing that the Reseller column does not already show.
      superadmin: superadmins.length
        ? cell(synthPrincipal(superadmins[0], LOWEST_SCOPE, domain))
        : { scope: 'superadmin', verdict: 'no', why: 'PORTAL_SUPERADMINS is empty, so the superadmin tier grants nobody.', delta: null },
      // Evaluated at the same lowest scope as the superadmin axis, and for the same reason: it isolates
      // what being NAMED buys, independent of what the account's scope would buy anyway. The domain comes
      // from the account itself, not `domain` — a users: grant typically names someone in another domain,
      // which is the case that matters.
      named: namedFor(card.key).length
        ? cell(namedPrincipal(namedFor(card.key)[0]))
        : null,
      namedAccounts: namedFor(card.key),
      audienceRank: card.audience === 'admin' ? 0 : 1,
    };
  });
  // Sorted by audience, so the matrix's admin/self split is a fact rather than a coincidence of registry
  // declaration order — which is all that currently keeps the two blocks adjacent. Stable within each block.
  rows.sort((a, b) => a.audienceRank - b.audienceRank);

  const explicit: Record<string, Gate> = {};
  for (const f of FEATURE_REGISTRY) explicit[f.key] = effectiveGate(f.key, overrides);

  const jsonOverrides = gateJson(overrides);
  const jsonExplicit = gateJson(explicit);
  const jsonError = validateEmitted(jsonOverrides) ?? validateEmitted(jsonExplicit);
  const examplesError = GATE_EXAMPLES.map((e) => validateEmitted(e.json)).find((x) => x !== null) ?? null;

  return {
    columns: [...KNOWN_SCOPES],
    rows,
    superadmins,
    assumptions: [
      `Each scope column is evaluated for an account in ${domain} that is NOT listed in PORTAL_SUPERADMINS and NOT named directly in any gate's users list. Being named by either grants more than the scope alone — that is what the superadmin column shows.`,
      'This is a pure evaluation of your configuration, not impersonation: it synthesizes a scope and asks the same policy engine the Worker asks. It reads nothing from NetSapiens, grants nothing, and can affect no session.',
      'It answers three questions at once — does the gate admit them, do they receive the bundle that carries the feature, and can the feature actually run as configured. A yes means all three.',
      `The two rightmost columns are the NAMED axes, evaluated at the lowest scope (${LOWEST_SCOPE}) so they isolate what being named buys on its own. A named account that also holds a higher scope gets whatever that scope's column shows as well.`,
    ],
    anyNamed: rows.some((r) => r.namedAccounts.length > 0),
    examples: GATE_EXAMPLES,
    jsonOverrides,
    jsonExplicit,
    jsonError: jsonError ?? examplesError,
  };
}

/** Build the status document — a pure function of `env` + the viewing principal. */
export function buildStatus(env: StatusEnv, opts: BuildStatusOpts): StatusDoc {
  const { principal, hostname } = opts;
  const probes = opts.probes ?? null;

  // Guarded: a malformed PORTAL_SUPERADMINS / PORTAL_FEATURES must not crash the very console that
  // exists to diagnose it. `featuresErr` below already reports the problem loudly (in configErrors).
  let superadmins: string[] = [];
  try {
    superadmins = parseSuperadmins(env);
  } catch (e) {
    if (!(e instanceof FeaturesConfigError)) throw e;
  }
  let overrides: Record<string, Gate> = {};
  try {
    overrides = parseFeatures(env);
  } catch (e) {
    if (!(e instanceof FeaturesConfigError)) throw e;
  }

  const featuresErr = featuresConfigError(env);
  let policies: FeaturePolicies = {};
  if (!featuresErr) {
    try {
      policies = resolveFeaturePolicies(env);
    } catch (e) {
      if (!(e instanceof FeaturesConfigError)) throw e; // unreachable in practice: featuresErr would be set
    }
  }

  // ── endpoints: what the settings ADD UP TO ───────────────────────────────────────────────────────
  // The console reported which settings were set and never the strings they compose into — an operator had to
  // assemble scheme + hostname + basename + ".js" in their head to get the one value they actually paste into
  // a portal. `verifiable: false` is load-bearing on the primary: serving it says nothing whatever about
  // whether any portal is loading it, and a console that implied otherwise would be over-claiming again.
  const endpoints = (): StatusDoc['deployment']['endpoints'] => {
    const base = `https://${hostname}`;
    const handoff = env.PORTAL_HANDOFF_URL;
    return [
      {
        label: 'Injected primary', url: `${base}/${primaryBasename(env)}.js`, direction: 'serves',
        what: 'The string to load from the Manager Portal — this deployment serves it, unauthenticated and neutral, and everything else is fetched by it. Whether a portal is actually pointed here cannot be seen from inside this Worker: serving it is not the same as being loaded.',
        verifiable: false,
      },
      {
        label: 'Vendor hand-off',
        url: handoff === undefined || handoff === '' ? null : handoff,
        // Three states, not two: absent is a misconfiguration, empty is a deliberate declaration, and a value
        // is a chain-load target. "not set" is only true of the first.
        emptyLabel: handoff === '' ? 'declared as none' : 'not set — see below',
        direction: 'calls',
        what: handoff === undefined
          ? 'Not set — and absent means "misconfigured" here rather than "none": if a vendor add-on is present it will break. Set it to "" to declare deliberately that there is no vendor to hand off to.'
          : handoff === ''
            // Was "this deployment is the only script in the chain. Nothing is chain-loaded." — which
            // contradicted this card's own "unverifiable from here" badge by asserting a fact about the whole
            // page. All this Worker knows is that IT chain-loads nothing; the vendor router can perfectly well
            // be loaded by a static loader or by other injected code that is not this kit, which is a normal
            // setup rather than an edge case.
            ? 'Declared as none, deliberately: this deployment chain-loads nothing. That is a statement about this Worker only — the vendor router may still be loaded by a static loader or by other code that is not this kit, and it should usually be loaded in exactly one place. If a vendor add-on is present and working, something else is loading it.'
            : 'The vendor bundle-router the injected primary chain-loads, so an existing portal add-on keeps working alongside this one.',
        verifiable: false,
      },
      {
        label: 'Gated bundles', url: `${base}/kit/`, direction: 'serves',
        what: 'Where the primary fetches the per-role feature bundles and this console from — portal.js, self.js, spk.js, status. Each is gated on its own; none is reachable without a valid ns_t.',
        verifiable: true,
      },
      {
        label: 'Change-event callback',
        url: (env.NS_EVENTS_BASE_URL ?? '').trim() || null,
        direction: 'serves',
        what: (env.NS_EVENTS_BASE_URL ?? '').trim()
          ? 'The public origin NetSapiens posts change events back to. Subscription ownership is decided by URL prefix, so this must be distinct per deployment or two of them fight over one subscription set.'
          : 'Not set, so no subscription can be created. This is this deployment\'s own public origin, and it must differ from every other deployment\'s.',
        verifiable: false,
      },
    ];
  };

  // ── deployment ──────────────────────────────────────────────────────────────────────────────────
  const cacheScope = scopeOf(env);
  const deployment: StatusDoc['deployment'] = {
    productName: productName(env),
    version: VERSION,
    hostname,
    cacheScope,
    mode: 'portal-backend',
    // `?? ''` at the ENV BOUNDARY, not in the renderer: `NS_SERVER` is typed `string` but can be absent at
    // runtime, and `esc(undefined)` threw — so the HTML console 500'd for exactly the operator whose
    // NS_SERVER row reads "Nothing works", i.e. the one who most needs the page. `esc` stays strictly typed.
    nsServer: env.NS_SERVER ?? '',
    envBadge: envBadge(hostname, cacheScope),
    configured: !needsSetup(env),
    releaseNotesUrl: releaseNotesUrl(env),
    endpoints: endpoints(),
  };

  // ── viewer: WHY you can see this page ──────────────────────────────────────────────────────────
  const viewer: StatusDoc['viewer'] = principal
    ? {
        id: principal.id,
        scope: principal.scope,
        domain: principal.domain,
        masquerading: principal.masking,
        operator: principal.operator?.id ?? null,
        grantedBy: grantedByFor(principal, superadmins, overrides),
      }
    : { id: '', scope: '', domain: '', masquerading: false, operator: null, grantedBy: 'unknown' };

  // ── issues (verbatim — setupIssues IS the setup checklist) ──────────────────────────────────────
  const issues = setupIssues(env);

  // ── config errors: the seven validators, each already owned by its subsystem ────────────────────
  const kitErr = kitConfigError(env);
  const aaErr = appAccessConfigError(env);
  const menuErr = menuConfigError(env);
  const ringErr = ringotelConfigError(env);
  const evErr = nsEventsConfigError(env);

  const configErrors: StatusDoc['configErrors'] = [];
  const addErr = (subsystem: string, reason: string | null): void => {
    if (reason) configErrors.push({ subsystem, reason });
  };
  addErr('Injection', kitErr);
  addErr('Feature gating', featuresErr);
  addErr('App access', aaErr);
  addErr('Portal menus', menuErr);
  addErr('Ringotel activation', ringErr);
  addErr('NetSapiens events', evErr);

  // ── feature cards: one per registry entry ────────────────────────────────────────────────────────
  const ownerErrs: OwnerErrs = { featuresErr, kitErr, ringErr, aaErr, menuErr };
  const features = FEATURE_REGISTRY.map((f) => featureCard(f, env, principal, superadmins, overrides, policies, ownerErrs));

  // ── subsystem cards: everything NOT in FEATURE_REGISTRY, still config an operator needs explained ──
  // `eventsCard` is evaluated ONCE, here: both the subsystem tables and the Config tab's "is this whole
  // block doing anything" gate read the same answer. Two evaluations of "are events armed" is how the
  // Config tab would come to grey out a block the Integrations tab reports as ON.
  const events = eventsCard(env);
  const subsystems = buildSubsystems(env, hostname, { kitErr, menuErr, aaErr, ringErr }, events);

  // ── setting views: one per SETTINGS row, secrets by presence only ───────────────────────────────
  // Same rule as the cards: a setting that cannot act in this mode is not shown at all, whether or not it has
  // a value. See the note above buildSubsystems' filter for why "set but ignored" is not an exception.
  const settings = SETTINGS
    .map((def) => settingView(def, env, events.armed))
    .filter((v) => v.applicability.applicable);

  // A card must not name a setting the Config tab no longer renders: the name is a LINK, and a link to a row
  // that was filtered out is navigation to nothing — the exact dead-reference defect this console keeps
  // eliminating, reintroduced by the filter two blocks up. Pruned here, where both lists are in hand, rather
  // than in the renderer, so `status.selftest.ts`'s existing dangling-reference check covers it.
  const shown = new Set(settings.map((v) => v.name));
  const prune = <T extends { settings: string[] }>(c: T): T => ({ ...c, settings: c.settings.filter((n) => shown.has(n)) });
  const prunedFeatures = features.map(prune);
  const prunedSubsystems = subsystems.map(prune);

// ── menus: what the menu config currently does, and the builder's starting point ─────────────────────
//
// Resolved at an UNTARGETED probe rung — a domain no config names, no app active, no scope. This tab is
// about the DEPLOYMENT's configuration, so resolving it for whoever opened the console would show a
// different "current state" to each operator with no way to tell which was the real one. `targeted` marks
// the menus where that distinction actually bites, so the reader is told rather than misled by omission.
const MENU_LABEL: Record<string, { label: string; what: string }> = {
  apps: { label: 'Apps', what: 'The Apps dropdown in the top navigation — the one most deployments customise first.' },
  account: { label: 'Account', what: 'The signed-in user\'s own name dropdown, carrying their profile and sign-out.' },
  management: { label: 'Management', what: 'The top-nav Management dropdown, which the portal shows only to administrative scopes.' },
};

/** Does this menu's config vary by domain, scope or app state? A bare array does not; any object rung does. */
function isTargetedCfg(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function buildMenus(env: StatusEnv, menuErr: string | null): MenusView {
  const configured = isSet(env.PORTAL_MENUS) || isSet(env.PORTAL_APPS_HIDE);
  const rawSrc = (env.PORTAL_MENUS ?? '').trim();
  const raw = prettyOf(rawSrc) ?? rawSrc;

  // A broken config still has to render this tab — it is where the operator comes to fix it. So the
  // resolution is guarded and an unresolvable menu reports empty rather than taking the page down.
  let resolved: Record<string, { hide: string[]; add: { label: string; url: string; title?: string }[] }> = {};
  try {
    resolved = resolveMenus(env, { domain: 'probe.example', app: 'none' }) as never;
  } catch { /* menuErr already carries the reason, and the tab leads with it */ }

  let rawCfg: Record<string, { hide?: unknown; add?: unknown }> = {};
  try { rawCfg = JSON.parse((env.PORTAL_MENUS ?? '').trim() || '{}'); } catch { rawCfg = {}; }

  const menus: MenuView[] = MENU_NAMES.map((name) => {
    const cfg = (rawCfg as Record<string, { hide?: unknown; add?: unknown }>)[name] ?? {};
    const r = resolved[name] ?? { hide: [], add: [] };
    return {
      name,
      label: MENU_LABEL[name]?.label ?? name,
      what: MENU_LABEL[name]?.what ?? '',
      hide: r.hide,
      add: r.add,
      targeted: isTargetedCfg(cfg.hide) || isTargetedCfg(cfg.add),
    };
  });

  let appsHide: MenusView['appsHide'] = null;
  if (bothAppsHideSet(env)) {
    try {
      const src = appsHideSources(env, { domain: 'probe.example', app: 'none' });
      appsHide = { legacy: src.legacy, menus: src.menus };
    } catch { /* same reasoning as above */ }
  }

  return { menus, configured, raw, error: menuErr, appsHide };
}

  // ── permissions: built FROM the feature cards, not beside them, so the matrix and the cards cannot
  // describe different gates. ──────────────────────────────────────────────────────────────────────
  const permissions = buildPermissions(env, prunedFeatures, policies, superadmins, overrides, viewer.domain);

  return {
    deployment,
    viewer,
    issues,
    configErrors,
    features: prunedFeatures,
    subsystems: prunedSubsystems,
    settings,
    permissions,
    menus: buildMenus(env, menuErr),
    probes,
  };
}
