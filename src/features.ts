/**
 * Feature-gating vocabulary + gate resolution (host config; mirror-bound — scope strings + level names
 * only, no deployment literal). Levels are explicit NS-scope allow-sets; the admin ladder nests, call
 * center is exact/orthogonal. `resolveGate` turns a config gate value into a policy-engine `Policy`,
 * applying the superadmin union (except off / CC-only) and the `off` kill-switch. Registry + env parsing
 * are in the same file (below, Task 2). Fail closed: an unknown level/shape throws FeaturesConfigError.
 */
import type { Policy, PolicyRule } from '@dszp/netsapiens-lib';

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

/** Push the rule(s) for one named level onto `rules`; returns true iff it's a call-center level.
 *  Throws on `off` (only valid as the whole gate) or an unknown level. */
function pushLevel(rules: PolicyRule[], level: string, superadmins: string[]): boolean {
  if (level === 'off') throw new FeaturesConfigError('"off" is only valid as the entire gate, not inside a list');
  if (level === 'all') { rules.push({ domains: ['*'] }); return false; } // any principal (every principal has a domain)
  if (level === 'superadmin') { if (superadmins.length) rules.push({ users: superadmins }); return false; }
  const scopes = LEVEL_SCOPES[level];
  if (!scopes) throw new FeaturesConfigError(`unknown level: ${level}`);
  rules.push({ scopes });
  return CC_LEVELS.has(level);
}

/** Resolve a gate value into an effective `Policy`. `off` ⇒ [] (deny all). Otherwise: the levels' rules
 *  + a forced-`users` rule, plus the superadmin union UNLESS every named level is call-center. */
export function resolveGate(gate: Gate, superadmins: string[]): Policy {
  const rules: PolicyRule[] = [];
  let ccOnly = false;

  if (gate === 'off') return []; // kill-switch — no rules, no superadmin

  if (typeof gate === 'string') {
    ccOnly = pushLevel(rules, gate, superadmins);
  } else if (Array.isArray(gate) && gate.every((g) => typeof g === 'string')) {
    const levels = gate as string[];
    ccOnly = levels.length > 0 && levels.every((l) => CC_LEVELS.has(l));
    for (const l of levels) pushLevel(rules, l, superadmins);
  } else if (Array.isArray(gate)) {
    for (const r of gate as PolicyRule[]) {
      if (!r || typeof r !== 'object') throw new FeaturesConfigError('a raw rule must be an object');
      rules.push(r);
    }
  } else if (gate && typeof gate === 'object') {
    const g = gate as { levels?: string[]; users?: string[] };
    const levels = g.levels ?? [];
    ccOnly = levels.length > 0 && levels.every((l) => CC_LEVELS.has(l));
    for (const l of levels) pushLevel(rules, l, superadmins);
    if (Array.isArray(g.users) && g.users.length) rules.push({ users: g.users });
    if (!levels.length && !(Array.isArray(g.users) && g.users.length)) throw new FeaturesConfigError('a gate object needs levels or users');
  } else {
    throw new FeaturesConfigError('unrecognized gate value');
  }

  if (!ccOnly && superadmins.length) rules.push({ users: superadmins });
  return rules;
}

import type { FeaturePolicies } from '@dszp/netsapiens-lib';

/** The subset of env this module reads. */
export interface FeaturesEnv {
  PORTAL_FEATURES?: string;
  PORTAL_SUPERADMINS?: string;
}

export interface FeatureDef {
  /** Policy key (matches the data-route/`_AF` key). */
  key: string;
  /** Human name (docs). */
  name: string;
  /** One-line description (docs; keep neutral). */
  description: string;
  /** Built-in default gate (reproduces today's behavior). */
  default: Gate;
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
  { key: 'me.menuConfig', name: 'Portal menu customization', description: 'Static add/hide of portal menu entries, optionally conditional on which app is active.', default: 'all' },
];

/** The registry's policy keys, in order (drives `_AF` + the default policy set). */
export const featurePolicyKeys = (): string[] => FEATURE_REGISTRY.map((f) => f.key);

const looksLikeAccount = (s: string): boolean => /^[^@\s]+@[^@\s]+$/.test(s);

/** PORTAL_SUPERADMINS → lowercased `user@domain` list ([] if unset). Throws on a malformed entry. */
export function parseSuperadmins(env: FeaturesEnv): string[] {
  const raw = (env.PORTAL_SUPERADMINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of raw) if (!looksLikeAccount(s)) throw new FeaturesConfigError(`PORTAL_SUPERADMINS entry is not a user@domain: ${s}`);
  return raw.map((s) => s.toLowerCase());
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
