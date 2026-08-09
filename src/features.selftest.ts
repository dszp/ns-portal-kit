/** Offline test for the feature-gating level vocabulary + gate resolution. pnpm test:features */
import { isAllowed, toPrincipal, can, type Principal } from '@dszp/netsapiens-lib';
import { resolveGate, FeaturesConfigError, resolveFeaturePolicies, featuresConfigError, FEATURE_REGISTRY, LEVEL_SCOPES, KNOWN_SCOPES, gateLevels, parseFeatures, kitStatusLockedReason, fleetReadAllowed } from './features.js';

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

// ── me.appAccess (Task 4) ─────────────────────────────────────────────────────
const selfPolicies = resolveFeaturePolicies({});
ok(FEATURE_REGISTRY.some((f) => f.key === 'me.appAccess'), 'registry has me.appAccess');
ok(can(P('Basic User'), 'me.appAccess', selfPolicies), 'me.appAccess default admits a Basic User');
ok(can(P('Reseller'), 'me.appAccess', selfPolicies), 'me.appAccess default admits a Reseller');

// ── KNOWN_SCOPES is the scope vocabulary the menu `scopes` axis validates against ─────────────
// A level whose scope is missing here would make a legitimate menu rule read as a typo, so the two lists
// have to move together.
{
  const canon = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const known = new Set(KNOWN_SCOPES.map(canon));
  const missing = Object.values(LEVEL_SCOPES).flat().filter((s) => !known.has(canon(s)));
  ok(missing.length === 0, `every LEVEL_SCOPES scope appears in KNOWN_SCOPES${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  ok(known.has(canon('Simple User')), 'KNOWN_SCOPES also carries Simple User, which has no level of its own');
}

// ── kit.status + the allowedLevels floor (2026-08-07) ─────────────────────────────
{
  const def = FEATURE_REGISTRY.find((f) => f.key === 'kit.status');
  ok(!!def, 'registry has kit.status');
  ok(def?.default === 'superadmin', 'kit.status defaults to superadmin');
  ok(!!def?.allowedLevels?.length, 'kit.status declares an allowedLevels floor');

  // Fail-closed default: superadmin with nobody named grants nobody.
  const bare = resolveFeaturePolicies({});
  ok(!can(P('Super User', 'anyone@d.example'), 'kit.status', bare),
    'kit.status with no PORTAL_SUPERADMINS grants nobody (deny-all, fail closed)');
  const withBoss = resolveFeaturePolicies({ PORTAL_SUPERADMINS: 'boss@0000.svc' });
  ok(can(P('Basic User', 'boss@0000.svc'), 'kit.status', withBoss), 'a named superadmin gets the console');
  ok(!can(P('Reseller', 'other@d.example'), 'kit.status', withBoss),
    'a reseller does NOT get the console by default');

  // Widening to reseller is allowed; below reseller is refused.
  const wide = { PORTAL_FEATURES: JSON.stringify({ 'kit.status': 'reseller' }) };
  ok(featuresConfigError(wide) === null, 'kit.status may be widened to reseller');
  ok(can(P('Reseller'), 'kit.status', resolveFeaturePolicies(wide)), 'the widened gate admits a reseller');

  const floorViolations: any[] = [
    'office_manager',
    'basic_user',
    'all',
    ['reseller', 'office_manager'],
    { levels: ['basic_user'] },
    [{ scopes: ['Basic User'] }],            // a raw rule must NOT route around the floor
  ];
  floorViolations.forEach((g) => {
    ok(featuresConfigError({ PORTAL_FEATURES: JSON.stringify({ 'kit.status': g }) }) !== null,
      `floor refuses kit.status gate ${JSON.stringify(g)}`);
  });

  // A bare users list is still allowed — a named account is a deliberate grant, not a typo.
  const named = { PORTAL_FEATURES: JSON.stringify({ 'kit.status': { users: ['om@d.example'] } }) };
  ok(featuresConfigError(named) === null, 'floor allows a bare users list');
  ok(can(P('Office Manager', 'om@d.example'), 'kit.status', resolveFeaturePolicies(named)),
    'the named account gets the console regardless of scope');

  // `off` remains available — a floor must not prevent turning something OFF.
  ok(featuresConfigError({ PORTAL_FEATURES: JSON.stringify({ 'kit.status': 'off' }) }) === null,
    'floor allows off');

  // The floor only applies to keys that declare one.
  ok(featuresConfigError({ PORTAL_FEATURES: JSON.stringify({ 'callflow.view': 'basic_user' }) }) === null,
    'an unfloored key is unaffected by the floor');

  // Every registry default must satisfy its own floor — a self-violating default must never ship.
  const selfViolating = FEATURE_REGISTRY.filter((f) => {
    if (!f.allowedLevels) return false;
    try { return gateLevels(f.default).levels.some((l) => !f.allowedLevels!.includes(l)); }
    catch { return true; }
  }).map((f) => f.key);
  ok(selfViolating.length === 0,
    `every registry default satisfies its own allowedLevels${selfViolating.length ? ` (violating: ${selfViolating.join(', ')})` : ''}`);
}

// ── gateLevels must FAIL CLOSED on a shape it does not know ──────────────────────
// An empty level list reads as "names no levels" and passes any floor trivially, so an unrecognized
// shape MUST throw. If a fifth Gate shape is ever added, this is the test that forces you to teach
// gateLevels about it instead of silently gaining a floor bypass.
{
  ok(gateLevels('reseller').levels.join() === 'reseller', 'gateLevels reads a bare level');
  ok(gateLevels(['reseller', 'super_user']).levels.length === 2, 'gateLevels reads a level array');
  ok(gateLevels({ levels: ['reseller'], users: ['a@b.example'] }).hasUsers === true, 'gateLevels reports users');
  ok(gateLevels({ users: ['a@b.example'] }).levels.length === 0, 'a users-only gate names no levels');
  ok(gateLevels([{ scopes: ['Reseller'] }]).hasRawRules === true, 'gateLevels flags raw rules');
  [42, null, true, undefined, {}].forEach((bad) => {
    let threw = false;
    try { gateLevels(bad as any); } catch (e) { threw = e instanceof FeaturesConfigError; }
    ok(threw, `gateLevels throws on an unrecognized shape: ${JSON.stringify(bad)}`);
  });
}

// ── gateLevels must reject a non-array levels/users, not coerce it (2026-08-07 review) ───────────
// A scalar `levels` was silently coerced to [] by Array.isArray(...) ? ... : [], so a gate like
// {levels:'basic_user', users:[...]} read as "names no levels" and passed the kit.status floor. Fails
// closed today only by accident (resolveGate's .every() on a string throws a raw TypeError deeper in,
// which featuresConfigError doesn't catch — a 1101, not the designed 500-with-reason). gateLevels must
// throw FeaturesConfigError itself, at the boundary that has the message to give.
{
  const bad: any[] = [
    { levels: 'basic_user', users: ['x@d.example'] },   // the reported bypass
    { levels: 'reseller' },                              // scalar levels, no users
    { levels: ['reseller'], users: 'x@d.example' },       // scalar users
  ];
  bad.forEach((g) => {
    let threw = false;
    try { gateLevels(g); } catch (e) { threw = e instanceof FeaturesConfigError; }
    ok(threw, `gateLevels throws FeaturesConfigError on ${JSON.stringify(g)}`);
  });
  // And the floor must refuse it as a CONFIG error, not blow up as a TypeError deeper in.
  ok(featuresConfigError({ PORTAL_FEATURES: JSON.stringify({ 'kit.status': { levels: 'basic_user', users: ['x@d.example'] } }) }) !== null,
    'a scalar levels on a floored key is a config error with a reason, not a raw throw');
}

// ── every element of a gate's string lists must BE a string (M1, 2026-08-07 pre-deploy review) ────
// `gateLevels` checked that `users` IS an array but not what was IN it, so `{"users":["a@b.example",42]}`
// passed featuresConfigError — the deployment booted "valid" — and then threw a raw
// `TypeError: s.trim is not a function` inside the policy engine's `lc()`. That is a 1101 instead of the
// designed 500-with-reason on every request evaluating the gate, AND it crashed `buildStatus` (which calls
// `can()` for every registry entry), so the integration console answered a bare 500 for exactly the
// misconfiguration it exists to name. Same mechanism for `scopes`/`domains`/`operators` in a raw rule: the
// engine lowercases all four.
{
  const bad: any[] = [
    { users: ['a@b.example', 42] },                   // the reported typo
    { users: [['a@b.example']] },                      // a nested array
    { users: [null] },
    { levels: ['reseller', 42] },
    [{ users: ['a@b.example', 42] }],                  // raw rule: same field
    [{ scopes: ['Reseller', 7] }],                     // raw rule: scopes reach lc() too
    [{ domains: [{}] }],
    [{ operators: [false] }],
    [{ users: 'a@b.example' }],                        // a non-ARRAY field was silently IGNORED before
  ];
  bad.forEach((g) => {
    let threw = false;
    try { gateLevels(g); } catch (e) { threw = e instanceof FeaturesConfigError; }
    ok(threw, `gateLevels throws FeaturesConfigError on ${JSON.stringify(g)}`);
  });

  // The message must name the offending value's TYPE — that is what the operator got wrong — and must NOT
  // echo the value: a `users` list holds account names.
  let msg = '';
  try { gateLevels({ users: ['a@b.example', 42] } as any); } catch (e) { msg = (e as Error).message; }
  ok(/users/.test(msg) && /number/.test(msg), `and names the field and the offending type (got: ${msg})`);
  ok(!/a@b\.example/.test(msg), 'and does not echo the account names');

  // End to end: it is now a Group-1 config error with a reason, not a raw throw...
  const env = { PORTAL_FEATURES: JSON.stringify({ 'callflow.view': { users: ['a@b.example', 42] } }) };
  const err = featuresConfigError(env);
  ok(err !== null && /must contain only strings/.test(err), `featuresConfigError reports it (got: ${JSON.stringify(err)})`);
  // ...and the gate no longer reaches the engine at all, so nothing downstream can throw a TypeError.
  let policiesThrew: unknown = null;
  try { resolveFeaturePolicies(env); } catch (e) { policiesThrew = e; }
  ok(policiesThrew instanceof FeaturesConfigError, 'and resolveFeaturePolicies fails closed with the typed error, not a TypeError');
}

// ── FEATURE_REGISTRY must have no duplicate keys (2026-08-07 review) ─────────────────────────────
// FEATURE_REGISTRY.find() returns the first match, so a second 'kit.status' entry inserted ABOVE the
// floored one — with no allowedLevels — would make the floor vanish with every other test still green.
{
  const keys = FEATURE_REGISTRY.map((f) => f.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  ok(dupes.length === 0, `no duplicate FEATURE_REGISTRY keys${dupes.length ? ` (${[...new Set(dupes)].join(', ')})` : ''}`);
}

// ── kitStatusLockedReason (2026-08-08): the actionable "admits nobody" 403 reason ────────────────
// The console's 403 was undifferentiated: "not authorized" reads the same whether the feature is off,
// nobody is named superadmin, or the caller just isn't on a list that does admit others. Only the first
// two are the operator's fault to fix, and only they should say what to set.
{
  const noSupers = kitStatusLockedReason({});
  ok(noSupers !== null && /PORTAL_SUPERADMINS/.test(noSupers),
    `default gate (superadmin) + no PORTAL_SUPERADMINS names the setting to fix (got: ${noSupers})`);

  const off = kitStatusLockedReason({ PORTAL_FEATURES: JSON.stringify({ 'kit.status': 'off' }) });
  ok(off !== null && /PORTAL_FEATURES/.test(off),
    `an "off" override names PORTAL_FEATURES as the setting to fix (got: ${off})`);

  // A gate that HAS rules — someone is admitted, this caller just isn't them — must stay null so the
  // existing terse "Not authorized: kit.status" message is not appended to (that would leak who passes).
  const widened = kitStatusLockedReason({ PORTAL_FEATURES: JSON.stringify({ 'kit.status': 'reseller' }) });
  ok(widened === null, 'widened to reseller (rules present) ⇒ null — the terse message stands');

  const withSuper = kitStatusLockedReason({ PORTAL_SUPERADMINS: 'boss@0000.svc' });
  ok(withSuper === null, 'default gate with a non-empty PORTAL_SUPERADMINS ⇒ null — rules exist');
}

// ── fleetReadAllowed: the console's SECOND gate, now shared with the status page's permissions matrix ──
// It moved out of worker.ts so the matrix could not reimplement it. A permissions view that disagreed with
// the enforcement it describes would be worse than none at all.
{
  const supers = { PORTAL_SUPERADMINS: 'boss@example.com' };
  const pr = (scope: string, id: string) => ({ id, scope });
  ok(fleetReadAllowed(pr('Reseller', 'r@x.example'), {}) === true, '[fleetRead] reseller scope passes structurally, with no list at all');
  ok(fleetReadAllowed(pr('Super User', 'su@x.example'), {}) === true, '[fleetRead] super user likewise');
  ok(fleetReadAllowed(pr('Office Manager', 'om@x.example'), {}) === false, '[fleetRead] an office manager is domain-locked — refused');
  ok(fleetReadAllowed(pr('Basic User', 'b@x.example'), {}) === false, '[fleetRead] a basic user is refused');
  ok(fleetReadAllowed(pr('Basic User', 'boss@example.com'), supers) === true, '[fleetRead] a LISTED superadmin passes at any scope');
  ok(fleetReadAllowed(pr('Basic User', 'BOSS@EXAMPLE.COM'), supers) === true, '[fleetRead] the account match is case-insensitive');
  ok(fleetReadAllowed(pr('Office Manager', 'other@example.com'), supers) === false, '[fleetRead] and an unlisted account is still refused');
  // Fails CLOSED and LOUD on a list it cannot parse: a console cannot be authorized against a
  // superadmin list that does not parse, and returning false silently would hide the misconfiguration.
  let threw = false;
  try { fleetReadAllowed(pr('Office Manager', 'om@x.example'), { PORTAL_SUPERADMINS: 'not-an-account' }); } catch { threw = true; }
  ok(threw, '[fleetRead] a malformed PORTAL_SUPERADMINS throws rather than quietly refusing or admitting');
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
