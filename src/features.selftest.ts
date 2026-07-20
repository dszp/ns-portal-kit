/** Offline test for the feature-gating level vocabulary + gate resolution. pnpm test:features */
import { isAllowed, toPrincipal, can, type Principal } from '@dszp/netsapiens-lib';
import { resolveGate, FeaturesConfigError, resolveFeaturePolicies, featuresConfigError, FEATURE_REGISTRY } from './features.js';

const P = (scope: string, id = 'u@d.example', maskChain?: string): Principal =>
  toPrincipal({ user: 'u', domain: 'd.example', sub: id, scope, ...(maskChain ? { maskChain } : {}) } as any);

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };
const grants = (gate: any, p: Principal, supers: string[] = []) => isAllowed(p, resolveGate(gate, supers));

// off = kill-switch: nobody, not even a superadmin.
ok(!grants('off', P('Reseller'), ['boss@0000.svc']), 'off denies a reseller');
ok(!grants('off', P('Reseller', 'boss@0000.svc'), ['boss@0000.svc']), 'off denies even a superadmin account');

// admin ladder nests; each includes Super User.
ok(grants('office_manager', P('Office Manager')), 'office_manager admits OM');
ok(grants('office_manager', P('Reseller')), 'office_manager admits Reseller (above)');
ok(grants('office_manager', P('Super User')), 'office_manager admits Super User');
ok(!grants('office_manager', P('Site Manager')), 'office_manager does NOT admit Site Manager (below)');
ok(grants('site_manager', P('Site Manager')), 'site_manager admits Site Manager');
ok(grants('site_manager', P('Office Manager')), 'site_manager admits OM (broader)');
ok(grants('reseller', P('Reseller')) && !grants('reseller', P('Office Manager')), 'reseller = reseller/SU only');
ok(grants('reseller', P('Super User')), 'reseller includes Super User (apex is in every admin set)');

// super_user = the apex scope, EXACTLY (does not admit Reseller, which is below). Distinct from superadmin.
ok(grants('super_user', P('Super User')), 'super_user admits Super User');
ok(!grants('super_user', P('Reseller')), 'super_user does NOT admit a Reseller (exact apex)');

// basic_user extends the ladder down: Basic User + Advanced + all admins above; EXCLUDES Simple User.
ok(grants('basic_user', P('Basic User')), 'basic_user admits Basic User');
ok(grants('basic_user', P('Advanced User')), 'basic_user admits Advanced User (above Basic)');
ok(grants('basic_user', P('Office Manager')) && grants('basic_user', P('Reseller')), 'basic_user admits admins above');
ok(!grants('basic_user', P('Simple User')), 'basic_user does NOT admit Simple User (below Basic)');

// advanced_user: Advanced User + admins above; EXCLUDES Basic User (below Advanced).
ok(grants('advanced_user', P('Advanced User')), 'advanced_user admits Advanced User');
ok(grants('advanced_user', P('Office Manager')), 'advanced_user admits admins above');
ok(!grants('advanced_user', P('Basic User')), 'advanced_user does NOT admit Basic User (below Advanced)');

// all = any authenticated (any scope, any domain) — the way to include Simple User.
ok(grants('all', P('Basic User')) && grants('all', P('Call Center Agent')), 'all admits any signed-in user');
ok(grants('all', P('Simple User')), 'all admits a Simple User (the reach-Simple path)');

// CC exact + orthogonal; does NOT admit admins; not cascaded.
ok(grants('call_center_agent', P('Call Center Agent')), 'call_center_agent admits CC Agent');
ok(!grants('call_center_agent', P('Call Center Supervisor')), 'call_center_agent does NOT admit CC Supervisor');
ok(!grants('call_center_agent', P('Office Manager')), 'call_center_agent does NOT admit OM');

// superadmin union: added to non-off, non-CC-only gates; NOT to CC-only.
ok(grants('office_manager', P('Basic User', 'boss@0000.svc'), ['boss@0000.svc']), 'superadmin sees an office_manager feature');
ok(!grants('call_center_agent', P('Basic User', 'boss@0000.svc'), ['boss@0000.svc']), 'superadmin does NOT auto-get a CC-only feature');
ok(grants(['call_center_agent', 'reseller'], P('Basic User', 'boss@0000.svc'), ['boss@0000.svc']), 'CC + reseller mix → superadmin union applies');

// list (union) and object {levels,users}.
ok(grants(['office_manager', 'call_center_agent'], P('Call Center Agent')), 'list union: CC agent via added CC level');
ok(grants({ users: ['x@d.example'] }, P('Basic User', 'x@d.example')), 'users-only gate admits the listed account');
ok(grants({ users: ['x@d.example'] }, P('Basic User', 'boss@0000.svc'), ['boss@0000.svc']), 'users-only gate still includes superadmins');
ok(!grants({ users: ['x@d.example'] }, P('Reseller', 'other@d.example')), 'users-only gate denies a non-listed reseller');

// forced users win over role gating.
ok(grants({ levels: ['reseller'], users: ['om@d.example'] }, P('Office Manager', 'om@d.example')), 'forced user with no qualifying role still granted');

// superadmin as a targetable level.
ok(grants('superadmin', P('Reseller', 'boss@0000.svc'), ['boss@0000.svc']) && !grants('superadmin', P('Reseller', 'other@d.example'), ['boss@0000.svc']), 'superadmin level = only the configured accounts');

// raw rules pass through.
ok(grants([{ scopes: ['Office Manager'], domains: ['acme'] }], P('Office Manager', 'u@acme'), []) === false, 'raw rule ANDs scope+domain (wrong domain denies)');

// unknown level ⇒ throw (fail closed at config time).
let threw = false; try { resolveGate('wizard', []); } catch (e) { threw = e instanceof FeaturesConfigError; }
ok(threw, 'unknown level throws FeaturesConfigError');
// off inside a list is not allowed.
let threw2 = false; try { resolveGate(['off', 'reseller'], []); } catch (e) { threw2 = e instanceof FeaturesConfigError; }
ok(threw2, 'off is only valid as the whole gate, not in a list');

// Registry present + typed.
ok(FEATURE_REGISTRY.some((f) => f.key === 'callflow.view') && FEATURE_REGISTRY.every((f) => f.name && f.description), 'registry has keys + names + descriptions');

// Defaults reproduce today's matrix (no PORTAL_FEATURES set).
const def = resolveFeaturePolicies({});
ok(can(P('Reseller'), 'callflow.view', def) && !can(P('Office Manager'), 'callflow.view', def), 'default callflow.view = reseller-only');
ok(can(P('Office Manager'), 'ringotel.userStatus', def) && !can(P('Basic User'), 'ringotel.userStatus', def), 'default userStatus = office_manager (incl. OM)');
ok(can(P('Office Manager'), 'portal.access', def), 'default portal.access admits OM');
ok(can(P('Office Manager'), 'ringotel.activate', def) && !can(P('Basic User'), 'ringotel.activate', def), 'default ringotel.activate = office_manager (write)');
ok(can(P('Office Manager'), 'ringotel.profileStatus', def) && can(P('Reseller'), 'ringotel.profileStatus', def), 'default ringotel.profileStatus = office_manager (incl. above)');
ok(can(P('Office Manager'), 'ringotel.resetPassword', def) && !can(P('Basic User'), 'ringotel.resetPassword', def), 'default ringotel.resetPassword = office_manager (write)');

// Override: hide + re-level, and a superadmin sees a re-leveled feature.
const env = { PORTAL_FEATURES: JSON.stringify({ 'callflow.view': 'off', 'ringotel.userStatus': 'reseller' }), PORTAL_SUPERADMINS: 'boss@0000.svc' };
const pol = resolveFeaturePolicies(env);
ok(!can(P('Reseller'), 'callflow.view', pol), 'override off hides callflow even for a reseller');
ok(!can(P('Office Manager'), 'ringotel.userStatus', pol) && can(P('Reseller'), 'ringotel.userStatus', pol), 'override tightens userStatus to reseller');
ok(can(P('Basic User', 'boss@0000.svc'), 'ringotel.userStatus', pol), 'superadmin sees the re-leveled feature');

// Validation: bad JSON, unknown key, unknown level ⇒ featuresConfigError message; good ⇒ null.
ok(featuresConfigError({}) === null, 'no config ⇒ no error');
ok(featuresConfigError({ PORTAL_FEATURES: '{bad json' }) !== null, 'bad PORTAL_FEATURES JSON ⇒ error');
ok(featuresConfigError({ PORTAL_FEATURES: JSON.stringify({ 'no.such.key': 'reseller' }) }) !== null, 'unknown feature key ⇒ error');
ok(featuresConfigError({ PORTAL_FEATURES: JSON.stringify({ 'callflow.view': 'wizard' }) }) !== null, 'unknown level ⇒ error');
ok(featuresConfigError({ PORTAL_SUPERADMINS: 'not-an-email' }) !== null, 'malformed superadmin ⇒ error');

// ── Self-service tier keys (2026-07-18) ──────────────────────────────────────────
{
  const basic = P('Basic User', '100@acme.example');
  const simple = P('Simple User', '99@acme.example');
  const om = P('Office Manager', '105@acme.example');
  // portal.self + me.appStatus default `all` → every tier in (own account)
  ok(can(basic, 'portal.self', def), 'portal.self admits a Basic User (default all)');
  ok(can(simple, 'portal.self', def), 'portal.self admits a Simple User (default all)');
  ok(can(om, 'portal.self', def), 'portal.self admits an Office Manager too');
  ok(can(basic, 'me.appStatus', def), 'me.appStatus admits a Basic User (own status)');
  ok(can(om, 'me.appStatus', def), 'me.appStatus admits an admin (own status)');
  // me.devices + me.resetPassword default OFF → nobody, not even a reseller
  ok(!can(P('Reseller'), 'me.devices', def), 'me.devices default off → denied');
  ok(!can(P('Reseller'), 'me.resetPassword', def), 'me.resetPassword default off → denied');
  // portal.access unchanged: Basic User still excluded
  ok(!can(basic, 'portal.access', def), 'portal.access still excludes a Basic User (unchanged)');
  // registry carries the four new keys
  const keys = FEATURE_REGISTRY.map((f) => f.key);
  ok(['portal.self', 'me.appStatus', 'me.devices', 'me.resetPassword'].every((k) => keys.includes(k)), 'registry has the self-tier keys');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
