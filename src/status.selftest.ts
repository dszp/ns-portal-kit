/** Offline test for the status document builder. pnpm test:statusdoc */
import { toPrincipal, type Principal } from '@dszp/netsapiens-lib';
import { buildStatus, envBadge, gateInWords, grantedByFor } from './status.js';
import { SETTINGS } from './statusModel.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };
const P = (scope: string, id = 'u@d.example'): Principal =>
  toPrincipal({ user: 'u', domain: 'd.example', sub: id, scope } as any);

/**
 * A minimally-working portal deployment. Fictional values only — this repo publishes a mirror — but
 * NOT the two literal strings setup.ts treats as "never configured": NS_SERVER 'api.example.com' and
 * NS_PORTAL_ISS 'manage.example.com' are the shipped placeholders (see PLACEHOLDER_SERVER/PLACEHOLDER_ISS
 * in src/setup.ts), so a "complete" env must avoid them — kit.selftest.ts and portal.selftest.ts already
 * do the same for the same reason.
 */
const OK_ENV = {
  NS_SERVER: 'ns.example.com',
  NS_PORTAL_ISS: 'portal.example.com',
  PORTAL_MODE: '1',
  PORTAL_HANDOFF_URL: '',
  PORTAL_SUPERADMINS: 'boss@example.com',
  CACHE_SCOPE: 'portal',
};

// ── deployment identity ──────────────────────────────────────────────────────────
{
  const d = buildStatus(OK_ENV, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' }).deployment;
  ok(d.mode === 'portal-backend', 'PORTAL_MODE=1 ⇒ portal-backend mode');
  ok(d.nsServer === 'ns.example.com', 'reports NS_SERVER');
  ok(d.cacheScope === 'portal', 'reports the cache scope');
  ok(d.configured === true, 'a complete portal env reports configured');
  ok(typeof d.version === 'string' && d.version.length > 0, 'reports a version');
}

// ── the environment badge: the page must never leave you guessing which deployment you are reading ──
ok(envBadge('localhost', 'default') === 'LOCAL', 'localhost ⇒ LOCAL');
ok(envBadge('svc-dev.example.com', 'dev') === 'DEV', 'a dev hostname ⇒ DEV');
ok(envBadge('svc.example.com', 'portal') === 'PROD', 'the portal hostname ⇒ PROD');
ok(envBadge('svc.example.com', 'dev') === 'DEV', 'CACHE_SCOPE=dev wins over a prod-looking hostname');

// ── viewer: WHY you can see this page ────────────────────────────────────────────
{
  const v = buildStatus(OK_ENV, { principal: P('Basic User', 'boss@example.com'), hostname: 'svc.example.com' }).viewer;
  ok(v.grantedBy === 'superadmin', 'a listed superadmin is told that is why');
  ok(v.masquerading === false, 'not masquerading');
}
{
  const env = { ...OK_ENV, PORTAL_FEATURES: JSON.stringify({ 'kit.status': 'reseller' }) };
  const v = buildStatus(env, { principal: P('Reseller', 'r@example.com'), hostname: 'svc.example.com' }).viewer;
  ok(v.grantedBy === 'level', 'a reseller admitted by the widened gate is told it was their level');
}
{
  // A gate object naming `users` (no levels) passes kit.status's allowedLevels floor — the floor only
  // restricts which LEVELS may be granted, so a personally-named user is a real, reachable config.
  const env = { ...OK_ENV, PORTAL_FEATURES: JSON.stringify({ 'kit.status': { users: ['operator@example.com'] } }) };
  const v = buildStatus(env, { principal: P('Basic User', 'operator@example.com'), hostname: 'svc.example.com' }).viewer;
  ok(v.grantedBy === 'named-user', 'a user named directly in the gate is told they were named personally');
}
{
  const v = buildStatus(OK_ENV, { principal: null, hostname: 'svc.example.com' }).viewer;
  ok(v.grantedBy === 'unknown', 'no principal ⇒ unknown, not a guess');
}
{
  // grantedByFor's own gateLevels() call is wrapped (gateLevels throws on a shape it doesn't recognize).
  // Unreachable through buildStatus's public env pipeline today — kit.status's allowedLevels floor means
  // parseFeatures already rejects a malformed override before it can reach here — so this calls the
  // (exported, pure) helper directly with a hand-built `overrides` map to exercise the wrap itself.
  const gb = grantedByFor(P('Super User', 'x@example.com'), [], { 'kit.status': 42 as any });
  ok(gb === 'unknown', 'a malformed gate reports unknown rather than throwing');
}

// ── issues: setupIssues must be REACHABLE here, which is the whole point ─────────
{
  const doc = buildStatus({ NS_SERVER: 'ns.example.com', PORTAL_MODE: '1' }, { principal: P('Super User'), hostname: 'svc.example.com' });
  ok(doc.issues.some((i) => i.level === 'blocker' && /NS_PORTAL_ISS/.test(i.title)),
    'a portal deployment with no NS_PORTAL_ISS reports it as a blocker');
  ok(doc.issues.every((i) => i.fix.trim().length > 0), 'every issue carries a fix');
}

// ── feature cards ────────────────────────────────────────────────────────────────
{
  const doc = buildStatus(OK_ENV, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  const byKey = (k: string) => doc.features.find((f) => f.key === k)!;

  // EXACT, not a floor. `>= 18` against a registry of exactly 24 passes by coincidence and loosens
  // silently — deleting a registry entry left it green. Same reason EXPECTED_SUBSYSTEM_IDS below is a set
  // and not a count: adding a feature should be a deliberate edit here.
  ok(doc.features.length === 24, `every registry feature gets a card, and there are exactly 24 (got ${doc.features.length})`);
  ok(doc.features.every((f) => f.name && f.description), 'cards carry a name and description');

  ok(byKey('me.devices').state === 'off', 'a feature gated `off` reports off');
  ok(byKey('me.devices').gate.source === 'default', 'an unconfigured gate reports source=default');
  ok(byKey('callflow.view').state === 'on', 'callflow.view is on by default');

  // Ringotel features cannot work without the API key: that is INERT, not off, and the difference is
  // the entire point of the page.
  ok(byKey('ringotel.orgStatus').state === 'inert', 'a Ringotel feature with no API key is inert, not off');
  ok(byKey('ringotel.orgStatus').missing.some((m) => m.setting === 'RINGOTEL_API_KEY'),
    'and it names RINGOTEL_API_KEY as what is missing');
  ok(byKey('ringotel.orgStatus').missing.every((m) => m.why && m.how), 'each missing requirement says why and how');

  const withKey = buildStatus({ ...OK_ENV, RINGOTEL_API_KEY: 'x' }, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  ok(withKey.features.find((f) => f.key === 'ringotel.orgStatus')!.state === 'on',
    'with the key present the same feature reports on');

  // A write feature with no write rail is inert even when its gate passes.
  ok(withKey.features.find((f) => f.key === 'ringotel.activate')!.state === 'inert',
    'a write feature with an empty RINGOTEL_WRITE_DOMAINS is inert');
  ok(withKey.features.find((f) => f.key === 'ringotel.activate')!.missing.some((m) => m.setting === 'RINGOTEL_WRITE_DOMAINS'),
    'and it names the write rail');

  ok(byKey('kit.status').viewerPasses === true, 'the viewer reading the page passes kit.status');
  ok(byKey('me.devices').viewerPasses === false, 'an off feature does not pass');

  // `settings` links via TWO independent sources — SETTINGS[].affects (behavior, not a fixed list) and
  // this card's own PREREQS (so a `missing` entry always points at something `settings` also names).
  // Testing only the universal PORTAL_FEATURES/PORTAL_SUPERADMINS pair (as the previous version of this
  // test did) would pass even if both of those derivations were deleted — pin real per-feature linkage.
  ok(byKey('kit.status').settings.includes('PORTAL_SUPERADMINS'), 'cards link the universal gating settings');
  ok(byKey('callflow.view').settings.includes('NS_SERVER'), 'and settings named via SETTINGS[].affects for that specific feature');
  ok(byKey('me.appAccess').settings.includes('RINGOTEL_API_KEY'), 'and settings named only via this card\'s own PREREQS (not in RINGOTEL_API_KEY\'s affects list)');

  // portal.self's own default gate ('all') passes on its own — force it off via PORTAL_FEATURES to prove
  // the me.* note fires when the self bundle's entry point is actually denied.
  const selfOff = buildStatus({ ...OK_ENV, RINGOTEL_API_KEY: 'x', PORTAL_FEATURES: JSON.stringify({ 'portal.self': 'off' }) },
    { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  const meAppAccess = selfOff.features.find((f) => f.key === 'me.appAccess')!;
  ok(meAppAccess.notes.some((n) => /portal\.self/.test(n)), 'a me.* card notes that portal.self being off makes it unreachable');
  ok(!selfOff.features.find((f) => f.key === 'ringotel.orgStatus')!.notes.some((n) => /portal\.self/.test(n)),
    'a non-me.* card carries no such note — portal.self does not gate it');
}

// ── a misconfigured subsystem is red, and does not masquerade as merely off ──────
{
  const doc = buildStatus({ ...OK_ENV, PORTAL_MENUS: '{not json' }, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  ok(doc.configErrors.some((e) => /menu/i.test(e.subsystem)), 'a bad PORTAL_MENUS is reported as a config error');
  ok(doc.configErrors.every((e) => e.reason.trim().length > 0), 'each config error carries the reason');
  ok(doc.features.find((f) => f.key === 'me.menuConfig')!.state === 'misconfigured',
    'the feature whose runtime path actually reads the broken config reports misconfigured, not off/on');
  ok(doc.features.find((f) => f.key === 'callflow.view')!.state === 'on',
    'an unrelated feature is unaffected by a menu config error');
}

// ── FEATURE_OWNER audit (2026-08-07 review): ringotel.profileAppAccess and me.appAccess share the SAME
// computeAppAccessProjection() runtime path (worker.ts), which calls parseDownloads/parseHideList — the
// exact surface appAccessConfigError validates. A malformed PORTAL_APP_DOWNLOADS must mark BOTH
// misconfigured, not just me.appAccess (which is all the table covered before this review). ──────────
{
  const doc = buildStatus({ ...OK_ENV, RINGOTEL_API_KEY: 'x', PORTAL_APP_DOWNLOADS: '{not json' },
    { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  ok(doc.configErrors.some((e) => /app access/i.test(e.subsystem)), 'a bad PORTAL_APP_DOWNLOADS is reported as a config error');
  ok(doc.features.find((f) => f.key === 'ringotel.profileAppAccess')!.state === 'misconfigured',
    'ringotel.profileAppAccess reports misconfigured, not on — it shares the broken runtime path with me.appAccess');
  ok(doc.features.find((f) => f.key === 'me.appAccess')!.state === 'misconfigured', 'me.appAccess also reports misconfigured');
  ok(doc.features.find((f) => f.key === 'ringotel.orgStatus')!.state === 'on',
    'a feature whose runtime path never reads PORTAL_APP_DOWNLOADS is unaffected — still fully on, not merely "not misconfigured"');
}

// ── gate prose: the page says who, in words, not in rules ────────────────────────
ok(/reseller/i.test(gateInWords('reseller', [])), 'gateInWords names the level');
ok(/superadmin|named/i.test(gateInWords('superadmin', ['boss@example.com'])), 'gateInWords describes superadmin');
ok(/nobody|no one|denied/i.test(gateInWords('off', ['boss@example.com'])), 'gateInWords says off means nobody');

// The superadmin UNION (resolveGate: every non-call-center gate also admits every PORTAL_SUPERADMINS
// account, at any scope). The prose omitted it, so a card read "resellers and above" directly above "You:
// you pass this gate" for a Basic-User superadmin — on 17 of 18 cards, in the only configuration where the
// console is reachable at all. The old test passed an EMPTY superadmin list, which cannot see this, and its
// one non-empty case used the `superadmin` gate itself — the single gate where the code was already right.
{
  const supers = ['boss@example.com'];
  const prose = gateInWords('reseller', supers);
  ok(/reseller/i.test(prose), 'a non-superadmin gate still names its level');
  ok(prose.includes('boss@example.com'), `and names the superadmin union too (got: ${prose})`);
  ok(/any scope/i.test(prose), 'and says the union ignores NS scope, which is the part an auditor needs');

  // Said once, not twice, when the gate names superadmin itself.
  const supProse = gateInWords('superadmin', supers);
  ok((supProse.match(/boss@example\.com/g) || []).length === 1, 'the `superadmin` gate does not list them twice');

  // Call-center-only gates get NO union (resolveGate's ccOnly branch), so the prose must not claim one.
  const cc = gateInWords('call_center_agent', supers);
  ok(!cc.includes('boss@example.com'), `a call-center-only gate is not given a superadmin union (got: ${cc})`);
  ok(gateInWords(['call_center_agent', 'call_center_supervisor'], supers).includes('boss@example.com') === false,
    'nor a union of call-center levels');
  // A mixed gate is NOT cc-only, so it DOES get the union.
  ok(gateInWords(['call_center_agent', 'reseller'], supers).includes('boss@example.com'),
    'but a gate mixing call-center with an admin level does get it');

  // `off` is the kill switch: no rules at all, no exception for superadmins.
  ok(!gateInWords('off', supers).includes('boss@example.com'), 'and `off` names nobody, superadmins included');

  // The whole-document version of the same fact: with PORTAL_SUPERADMINS set, no card may say "you pass"
  // while its gate prose fails to explain how. This is the shape of the original contradiction.
  const doc = buildStatus({ ...OK_ENV, RINGOTEL_API_KEY: 'x' },
    { principal: P('Basic User', 'boss@example.com'), hostname: 'svc.example.com' });
  const silent = doc.features
    .filter((f) => f.viewerPasses && !/boss@example\.com/.test(f.gate.inWords))
    .map((f) => f.key);
  ok(silent.length === 0,
    `no card tells a superadmin "you pass" without its gate prose explaining why${silent.length ? ` (${silent.join(', ')})` : ''}`);
}

// ── setting views: presence for secrets, values for config, never a secret's value ──
{
  const env = { ...OK_ENV, RINGOTEL_API_KEY: 'super-secret-value', ALLOWED_DOMAINS: 'acme.example,beta.example' };
  const doc = buildStatus(env, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  const s = (n: string) => doc.settings.find((x) => x.name === n)!;

  // EXACT: `>= 60` against a table of 64 was a floor that passed by coincidence — deleting a SETTINGS row
  // did not trip it. Both numbers are asserted so a shrunk table cannot hide behind a shrunk expectation.
  // 61 after the standalone viewer left this repo (2026-08-09) and took NS_API_TOKEN,
  // ALLOW_UNGATED_SERVICE_TOKEN, ACCESS_AUD, ACCESS_TEAM_DOMAIN and PORTAL_MODE with it; 60 in 0.3.1,
  // when BRAND_LABEL followed them — its only reader was the viewer's theme picker; 61 again with
  // DOCUMO_DOMAINS, the stand-in driving the second app's menu targeting. Pinned as an EXACT
  // number on purpose — `>= 60` was a floor that passed by coincidence, so deleting a row did not trip
  // it. Bump this deliberately when adding one; the drift guard in statusModel.selftest.ts is what
  // proves the table matches `interface Env`.
  ok(SETTINGS.length === 61, `sanity: the descriptor table has exactly 61 rows (got ${SETTINGS.length})`);
  // Every row is rendered now: there is one deployment shape, so no setting is inapplicable to it.
  ok(doc.settings.length === SETTINGS.length,
    `every row is rendered (${doc.settings.length} of ${SETTINGS.length})`);
  ok(doc.settings.every((v) => v.applicability.applicable), 'and every one of them is applicable');
  ok(s('RINGOTEL_API_KEY').set === true, 'a set secret reports set');
  ok(s('RINGOTEL_API_KEY').value === null, 'a secret NEVER carries its value');
  ok(s('ALLOWED_DOMAINS').value === 'acme.example,beta.example', 'a config value is shown');
  ok(s('ALLOWED_DOMAINS').source === 'env', 'a set value reports source=env');
  ok(s('BRAND_ACCENT').source === 'default', 'an unset value reports source=default');
  ok(doc.settings.every((x) => x.editable === false), 'nothing is editable in v1');
  ok(doc.settings.every((x) => x.whyNot.trim().length > 0), 'every view explains why it is not editable');
  ok(/secret/i.test(s('RINGOTEL_API_KEY').whyNot), 'a secret explains itself as a secret');

  // Bindings are not strings — they must report presence, not stringify into junk.
  ok(s('ASSETS').set === false && s('ASSETS').value === null, 'an unbound binding reports not set with no value');
  const bound = buildStatus({ ...env, ASSETS: { get: async () => null } } as any,
    { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  const a = bound.settings.find((x) => x.name === 'ASSETS')!;
  ok(a.set === true && a.value === null, 'a bound binding reports set, with no value');

  // F6: `whyNot` is the console's fix-it instruction (it is also the disabled Edit button's title=). A
  // BINDING is not a `vars` string, and telling an operator to add one to `vars` sends them to do something
  // that creates no binding and does not clear the loud 500 they are chasing.
  for (const name of ['ASSETS', 'JWT_RATE_LIMITER']) {
    const w = s(name).whyNot;
    ok(/BINDING/i.test(w) && /r2_buckets|ratelimits/.test(w), `${name} is explained as a binding, not a var`);
    ok(!/`vars` for this environment/.test(w), `and ${name} is NOT told to be set in vars`);
    ok(w.includes(name), `and the instruction names ${name} itself`);
  }
  // Exactly the bindings group gets that text — no var or secret is misdescribed as a binding.
  const bindingRows = doc.settings.filter((x) => /BINDING/i.test(x.whyNot)).map((x) => x.name).sort();
  ok(JSON.stringify(bindingRows) === JSON.stringify(['ASSETS', 'JWT_RATE_LIMITER']),
    `only the two bindings carry the binding instruction (got: ${bindingRows.join(', ')})`);
  ok(doc.settings.filter((x) => x.group === 'bindings').length === 2, 'and the bindings group is those same two rows');
  const rl = buildStatus({ ...OK_ENV }, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  ok(rl.subsystems.find((x) => x.id === 'ratelimit')!.state === 'on', 'sanity: the rate-limit card reports on either way');

  // The OTHER place an operator reads a fix-it is a card's `missing[]`, and `missingRequirement` builds its
  // `how` from this same `whyNotText` — so the two can never give different instructions for one setting.
  // The comment here used to assert that in prose while the line above only checked a card's state; this
  // checks it. Note the BINDING text is NOT reachable this way: no card names ASSETS or JWT_RATE_LIMITER as
  // a requirement, so it is a Config-tab-only string, which is exactly why the claim needed pinning down
  // rather than assuming.
  const broken = buildStatus({ PORTAL_MODE: '1', PORTAL_SUPERADMINS: 'boss@example.com' } as any,
    { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  const whyNotOf = new Map(broken.settings.map((x) => [x.name, x.whyNot]));
  const allMissing = [...broken.features.flatMap((f) => f.missing), ...broken.subsystems.flatMap((x) => x.missing)];
  ok(allMissing.length > 0, `sanity: this env actually produces missing entries to check (${allMissing.length})`);
  const drifted = allMissing.filter((m) => whyNotOf.has(m.setting) && m.how !== whyNotOf.get(m.setting));
  ok(drifted.length === 0,
    `every missing entry's fix-it is the same text the Config tab gives for that setting${drifted.length ? ` (drifted: ${drifted.map((m) => m.setting).join(', ')})` : ''}`);
  ok(allMissing.some((m) => /wrangler secret put/.test(m.how)), 'and the secret instruction is reached that way');
  ok(allMissing.some((m) => /wrangler\.jsonc/.test(m.how)), 'and the var instruction too');
  ok(!allMissing.some((m) => m.setting === 'ASSETS' || m.setting === 'JWT_RATE_LIMITER'),
    'while neither binding is ever named as a requirement — the binding instruction is Config-tab-only');
}

// ── F5: absent, present-empty and present are THREE states, and `source` is about declaration ─────────
// `isSet('')` is false, and deriving `source` from `set` made the Config tab report a deliberate
// PORTAL_HANDOFF_URL="" as UNSET with source "default" — a claim about this deployment that is simply
// untrue — then print that row's own prose warning about the OTHER state, while the Integrations tab
// reported injection ON two clicks away.
{
  const principal = P('Super User', 'boss@example.com');
  const hostname = 'svc.example.com';
  const row = (env: Record<string, unknown>) =>
    buildStatus(env as any, { principal, hostname }).settings.find((x) => x.name === 'PORTAL_HANDOFF_URL')!;

  const empty = row({ ...OK_ENV, PORTAL_HANDOFF_URL: '' });
  ok(empty.set === false, 'an empty string is still not a usable value');
  ok(empty.source === 'env', 'but it IS declared in env — source must say so, not claim "default"');

  const absent = row({ ...OK_ENV, PORTAL_HANDOFF_URL: undefined });
  ok(absent.set === false && absent.source === 'default', 'an absent setting reports default');

  const present = row({ ...OK_ENV, PORTAL_HANDOFF_URL: 'https://vendor.example.com/r.js' });
  ok(present.set === true && present.source === 'env', 'a real value reports set + env');

  // The contradiction itself: the injection card and the settings row must agree that "" is deliberate.
  const doc = buildStatus({ ...OK_ENV, PORTAL_HANDOFF_URL: '' }, { principal, hostname });
  ok(doc.subsystems.find((x) => x.id === 'injection')!.state === 'on', 'the injection card reads on for a deliberate ""');
  ok(doc.settings.find((x) => x.name === 'PORTAL_HANDOFF_URL')!.source === 'env',
    'and the Config row does not contradict it by claiming the value came from a default');
  // A binding reports env-vs-default on the same rule (present ⇒ env), so the two axes stay independent.
  const bound2 = buildStatus({ ...OK_ENV, ASSETS: { get: async () => null } } as any, { principal, hostname });
  ok(bound2.settings.find((x) => x.name === 'ASSETS')!.source === 'env', 'a bound binding reports source=env');
}

// ── subsystem cards ─────────────────────────────────────────────────────────────
{
  const doc = buildStatus(OK_ENV, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  const sub = (id: string) => doc.subsystems.find((x) => x.id === id)!;

  // Exact id set, not a floor — a floor lets three cards go missing and the suite stays green. Mirrors
  // statusModel.selftest.ts's own drift guard: diff both directions.
  const ALL_SUBSYSTEM_IDS = [
    'auth', 'branding', 'domains', 'cache', 'ringotel', 'eligibility', 'writes',
    'appaccess', 'sso', 'menus', 'injection', 'nsdevices', 'events', 'offboarding', 'identity',
    'ratelimit', 'onebill', 'documo',
  ];
  // A subsystem that cannot act in this mode is not rendered at all, so the expected set is per-mode. Both
  // exclusion lists are asserted explicitly and in BOTH directions — "some cards are omitted" must not be
  // able to grow quietly into "most cards are missing", which is what a floor-style check would allow.
  // The Access and exposure cards left with the standalone viewer (2026-08-09), so every catalogued
  // subsystem is expected on every deployment now. Kept as an explicit list rather than a count, so a
  // card disappearing still has to be a deliberate edit here.
  const EXPECTED_SUBSYSTEM_IDS = ALL_SUBSYSTEM_IDS;
  const gotIds = doc.subsystems.map((x) => x.id);
  const missingIds = EXPECTED_SUBSYSTEM_IDS.filter((id) => !gotIds.includes(id));
  const extraIds = gotIds.filter((id) => !EXPECTED_SUBSYSTEM_IDS.includes(id));
  ok(missingIds.length === 0, `every required subsystem id is present${missingIds.length ? ` (missing: ${missingIds.join(', ')})` : ''}`);
  ok(extraIds.length === 0, `no unexpected subsystem id sneaks in${extraIds.length ? ` (extra: ${extraIds.join(', ')})` : ''}`);
  ok(gotIds.length === EXPECTED_SUBSYSTEM_IDS.length, `exactly ${EXPECTED_SUBSYSTEM_IDS.length} subsystem cards, no duplicates`);
  ok(doc.subsystems.every((x) => x.name && x.description), 'subsystem cards carry a name and description');

  ok(sub('ringotel').state === 'inert', 'Ringotel with no API key is inert');
  ok(sub('ringotel').missing.some((m) => m.setting === 'RINGOTEL_API_KEY'), 'and names the key');
  // Access is not on a portal console at all now, so its states are asserted on a STANDALONE doc — where the
  // card exists and where the gate is the only thing in front of a stored token. The dedicated [access] block
  // further down covers the rest of its states.
  // `off`, not `inert`: NS_EVENTS defaults to `auto`, but a deployment that never touched ANY of the three
  // events settings has not asked for this, so there is nothing to fix. (The message used to say
  // "inert-but-deliberate" while asserting 'off' — the assertion is the correct one.)
  ok(sub('events').state === 'off', 'NS events with nothing touched reads off — the same footing as an explicit off');

  // OneBill and Documo: libraries exist in the workspace, nothing is wired into this Worker. Saying so
  // is the point — omitting them would be lying by absence.
  ok(sub('onebill').state === 'not-integrated', 'OneBill reports not-integrated');
  ok(sub('documo').state === 'not-integrated', 'Documo reports not-integrated');
  ok(sub('onebill').settings.length === 0, 'a not-integrated subsystem has no settings to show');

  // An armed events config reports on.
  const armed = buildStatus({
    ...OK_ENV, RINGOTEL_API_KEY: 'x', RINGOTEL_WRITE_DOMAINS: '*',
    NS_EVENTS: 'on', NS_EVENTS_DOMAINS: '*', NS_EVENTS_BASE_URL: 'https://svc.example.com',
    NS_EVENTS_PATH_SECRET: 'x', NS_API_KEY: 'x',
  }, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  ok(armed.subsystems.find((x) => x.id === 'events')!.state === 'on', 'a fully configured events subsystem is on');

  // Every settings name a card references must exist in the settings list, or the page renders a dead link.
  const names = new Set(doc.settings.map((x) => x.name));
  const dangling = [...doc.subsystems.flatMap((x) => x.settings), ...doc.features.flatMap((f) => f.settings)]
    .filter((n) => !names.has(n));
  ok(dangling.length === 0, `no card references an unknown setting${dangling.length ? ` (${[...new Set(dangling)].join(', ')})` : ''}`);
}

// ── buildStatus must NEVER throw — /kit/status is served ahead of five of the seven config validators
// precisely so a broken deployment can still explain itself. Each of these breaks a DIFFERENT throwing
// resolver (resolveMenus, parseDownloads, parseNsEventsConfig, resolveRingotelConfig); every one must
// still produce a full document, with the owning card reading misconfigured and carrying a reason. ────
{
  const base = { ...OK_ENV, RINGOTEL_API_KEY: 'x' };
  const principal = P('Super User', 'boss@example.com');
  const hostname = 'svc.example.com';

  const menusBroken = buildStatus({ ...base, PORTAL_MENUS: '{bad' }, { principal, hostname });
  ok(menusBroken.subsystems.find((x) => x.id === 'menus')!.state === 'misconfigured',
    'a broken PORTAL_MENUS leaves the menus card misconfigured, not a thrown exception');
  ok(menusBroken.subsystems.find((x) => x.id === 'menus')!.notes.some((n) => n.trim().length > 0),
    'and it carries a reason');

  const downloadsBroken = buildStatus({ ...base, PORTAL_APP_DOWNLOADS: '{bad' }, { principal, hostname });
  ok(downloadsBroken.subsystems.find((x) => x.id === 'appaccess')!.state === 'misconfigured',
    'a broken PORTAL_APP_DOWNLOADS leaves the appaccess card misconfigured, not a thrown exception');

  const eventsOnBroken = buildStatus({ ...OK_ENV, NS_EVENTS: 'on' }, { principal, hostname });
  ok(eventsOnBroken.subsystems.find((x) => x.id === 'events')!.state === 'misconfigured',
    'NS_EVENTS=on with nothing else set leaves the events card misconfigured, not a thrown exception');

  const ringotelBroken = buildStatus({ ...base, RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN: '{bad' }, { principal, hostname });
  ok(ringotelBroken.subsystems.find((x) => x.id === 'eligibility')!.state === 'misconfigured',
    'a broken RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN leaves the eligibility card misconfigured, not a thrown exception');
  ok(ringotelBroken.subsystems.find((x) => x.id === 'ringotel')!.state === 'misconfigured',
    'and the ringotel base card too — the same broken resolveRingotelConfig underlies both');
  ok(ringotelBroken.subsystems.find((x) => x.id === 'writes')!.state === 'misconfigured',
    'and the writes card too — all three share resolveRingotelConfig');
}

// ── review round 2: a card must never report a state that is not true — the exact failure this console
// exists to prevent. Each block below regression-tests one finding from that review. ────────────────
{
  const principal = P('Super User', 'boss@example.com');
  const hostname = 'svc.example.com';

  // 1. `writes` must agree with `ringotel.activate` about one fact: RINGOTEL_WRITE_DOMAINS=',' parses to
  // an EMPTY domain list (every write refused, via resolveRingotelConfig's csv()+filter(Boolean)), not
  // "configured". Both cards now derive from the same prereqSatisfied predicate.
  const commaRail = buildStatus({ ...OK_ENV, RINGOTEL_API_KEY: 'x', RINGOTEL_WRITE_DOMAINS: ',' }, { principal, hostname });
  ok(commaRail.subsystems.find((x) => x.id === 'writes')!.state === 'inert',
    'RINGOTEL_WRITE_DOMAINS="," (parses to an empty rail) leaves writes inert, not on');
  ok(commaRail.features.find((f) => f.key === 'ringotel.activate')!.state === 'inert',
    'and the feature card agrees with the subsystem card about the same fact');

  // 2. `identity` (and `events`) must require the OAuth pair when the admin-credential path is the one
  // configured — getServiceToken (nsIdentity.ts) throws without it.
  const adminNoOauth = { ...OK_ENV, NS_ADMIN_USER: 'svc', NS_ADMIN_PASS: 'x' };
  const noOauth = buildStatus(adminNoOauth, { principal, hostname });
  ok(noOauth.subsystems.find((x) => x.id === 'identity')!.state === 'inert',
    'admin credentials with no OAuth client pair leave identity inert, not on — getServiceToken cannot mint a token');
  ok(noOauth.subsystems.find((x) => x.id === 'identity')!.missing.some((m) => m.setting === 'NS_OAUTH_CLIENT_ID'),
    'and names the missing OAuth client id');

  const withOauth = buildStatus({ ...adminNoOauth, NS_OAUTH_CLIENT_ID: 'cid', NS_OAUTH_CLIENT_SECRET: 'secret' }, { principal, hostname });
  ok(withOauth.subsystems.find((x) => x.id === 'identity')!.state === 'on',
    'admin credentials WITH the OAuth pair report identity on');

  const eventsAdminNoOauth = buildStatus({
    ...OK_ENV, RINGOTEL_API_KEY: 'x', RINGOTEL_WRITE_DOMAINS: '*',
    NS_EVENTS: 'on', NS_EVENTS_DOMAINS: '*', NS_EVENTS_BASE_URL: 'https://svc.example.com',
    NS_EVENTS_PATH_SECRET: 'x', NS_ADMIN_USER: 'svc', NS_ADMIN_PASS: 'x',
  }, { principal, hostname });
  ok(eventsAdminNoOauth.subsystems.find((x) => x.id === 'events')!.state === 'inert',
    'events with a fully-specified admin identity but no OAuth pair is inert, not on — it cannot actually authenticate');

  // 3. `menus` must read misconfigured before off: PORTAL_APPS_HIDE alone (PORTAL_MENUS unset) still
  // breaks resolveMenus's legacy-hide probe.
  const badLegacyHide = buildStatus({ ...OK_ENV, PORTAL_APPS_HIDE: '{bad' }, { principal, hostname });
  ok(badLegacyHide.subsystems.find((x) => x.id === 'menus')!.state === 'misconfigured',
    'a broken PORTAL_APPS_HIDE with PORTAL_MENUS unset still reads menus as misconfigured, not off');

  // 4. Merely having Ringotel configured must not read as "events was touched".
  const ringotelOnlyEvents = buildStatus({ ...OK_ENV, RINGOTEL_API_KEY: 'x' }, { principal, hostname });
  ok(ringotelOnlyEvents.subsystems.find((x) => x.id === 'events')!.state === 'off',
    'a Ringotel deployment with no NS_EVENTS* setting touched reads events off, not inert — nothing was asked for');
}

// ── the offboarding dead pointer (2026-08-07): NS_EVENTS_OFFBOARD=deactivate with NS_EVENTS absent and
// nothing else touched leaves `eventsCard` reading plain `off` with an EMPTY missing[]/notes — there is
// nothing to forward. Before this fix `offboardingCard` only forwarded events' own (empty) lists, so "see
// the events card" pointed at a card that said nothing at all — the events card doesn't even explain why
// it's off, since "off" is its normal, un-asked-for state. `NS_EVENTS` is genuinely ABSENT here, so naming
// it under `missing[]` is correct guidance, not the M2 bug (which fired when NS_EVENTS was literally `on`).
{
  const principal = P('Super User', 'boss@example.com');
  const hostname = 'svc.example.com';

  const doc = buildStatus({ ...OK_ENV, NS_EVENTS_OFFBOARD: 'deactivate' }, { principal, hostname });
  const events = doc.subsystems.find((x) => x.id === 'events')!;
  const offboarding = doc.subsystems.find((x) => x.id === 'offboarding')!;

  ok(events.state === 'off' && events.missing.length === 0 && events.notes.length === 0,
    'sanity: with nothing else touched, the events card really is a dead end on its own (off, nothing to say)');
  ok(offboarding.state === 'inert', 'offboarding requested with events unarmed is inert');
  ok(offboarding.missing.some((m) => m.setting === 'NS_EVENTS'),
    'and now names NS_EVENTS as missing — useful guidance restored, since NS_EVENTS is genuinely absent here');
  ok(!doc.settings.find((s) => s.name === 'NS_EVENTS')!.set, 'sanity: NS_EVENTS really is unset in this env');

  // The other half: if NS_EVENTS is PRESENT (e.g. explicitly "off") while offboarding is still requested,
  // naming it under missing[] would violate the invariant below — it must be demoted to a note instead.
  const docSet = buildStatus({ ...OK_ENV, NS_EVENTS: 'off', NS_EVENTS_OFFBOARD: 'deactivate' }, { principal, hostname });
  const offboardingSet = docSet.subsystems.find((x) => x.id === 'offboarding')!;
  ok(!offboardingSet.missing.some((m) => m.setting === 'NS_EVENTS'),
    'but when NS_EVENTS IS set, it is never named under missing[] — the invariant holds even for this new guidance');
  ok(offboardingSet.notes.some((n) => /NS_EVENTS/.test(n) && /already set/.test(n)),
    'it is explained as a note instead, the same present-but-unmet treatment every other card uses');
}

// ── buildStatus must NEVER throw — table-driven, one entry per throwing resolver, PLUS all twelve
// broken simultaneously (the pathological case a reviewer ran by hand across 24 envs). This is the
// permanent version of that proof: the console is served ahead of five config validators specifically
// so it can explain a broken deployment, so "never throws" is a guarantee, not a nicety. ─────────────
{
  const BROKEN: Record<string, string> = {
    PORTAL_MENUS: '{bad',
    PORTAL_APPS_HIDE: '{bad',
    PORTAL_APP_DOWNLOADS: '{bad',
    RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN: '{bad',
    RINGOTEL_RESELLER_OVERRIDE: 'not-a-real-category',
    RINGOTEL_ACTIVATION_SUFFIX: '',
    NS_EVENTS: 'on',
    NS_EVENTS_MODELS: 'not-a-real-model',
    NS_EVENTS_GEO_SUPPORT: 'sideways',
    NS_EVENTS_OFFBOARD: 'delete-everything',
    NS_EVENTS_DEVICE_REPAIR: 'nuke',
    NS_EVENTS_BASE_URL: 'not-a-url',
  };
  const base = { ...OK_ENV, RINGOTEL_API_KEY: 'x' };
  const principal = P('Super User', 'boss@example.com');
  const hostname = 'svc.example.com';

  for (const [name, value] of Object.entries(BROKEN)) {
    let doc: ReturnType<typeof buildStatus> | undefined;
    let threw: unknown;
    try {
      doc = buildStatus({ ...base, [name]: value }, { principal, hostname });
    } catch (e) {
      threw = e;
    }
    ok(!threw, `buildStatus never throws with a broken ${name}${threw ? ` (threw: ${threw instanceof Error ? threw.message : String(threw)})` : ''}`);
    // 18 in portal mode: the Access and exposure cards are not rendered there at all. Asserted as a fixed
    // number rather than "at least some", so a broken value that silently emptied the document still fails.
    ok(!!doc && doc.subsystems.length === 18, `and still produces a full 18-card document (${name}, got ${doc?.subsystems.length})`);
  }

  // All twelve broken simultaneously.
  let allDoc: ReturnType<typeof buildStatus> | undefined;
  let allThrew: unknown;
  try {
    allDoc = buildStatus({ ...base, ...BROKEN }, { principal, hostname });
  } catch (e) {
    allThrew = e;
  }
  ok(!allThrew, `buildStatus never throws with all twelve broken simultaneously${allThrew ? ` (threw: ${allThrew instanceof Error ? allThrew.message : String(allThrew)})` : ''}`);
  ok(!!allDoc && allDoc.subsystems.length === 18, 'and still produces a full 20-card document');
  ok(!!allDoc && allDoc.configErrors.length > 0, 'and reports the breakage in configErrors, not silently');
}

// ── document-level sentinel scan — the JSON path (?format=json, Task 6) is not covered by Task 5's
// rendered-HTML sentinel test, so it needs its own: every credential key set to a distinctive sentinel,
// then assert the sentinel (and a legible prefix of it) appears NOWHERE in JSON.stringify(doc) — not
// just settings[].value, but configErrors[].reason, card notes[], and missing why/how too. ───────────
{
  const secretNames = SETTINGS.filter((s) => s.kind === 'secret').map((s) => s.name);
  ok(secretNames.length === 7, `sanity: exactly 7 secret settings (got ${secretNames.length})`);

  // Every sentinel gets its OWN random body, and no key name in it. The previous shape gave all eight the
  // same 33-char prefix and suffixed the setting's name, which meant `slice(0,10)` and `slice(0,14)` were
  // the same string eight times over — 24 assertions carrying one distinct fact, and the shared prefix was
  // the blind spot: mutating the renderer to emit `raw.slice(-8)` (the classic "last four" fingerprint
  // leak) passed all 24. So the three checks below are three DIFFERENT facts about each distinct value:
  // the whole thing, a legible head (a truncation), and the tail (a fingerprint). Fixed literals, not
  // Math.random, so a failure is reproducible.
  const BODIES = [
    'q7Ld2Xn4Mb9Rz', 'Ht6Vc1Ws8Pj3K', 'Fy5Gk9Zt2Nq7B', 'Jr4Bm7Xv1Ld6C',
    'Wp8Nh3Qs5Tz2M', 'Cv9Rk2Fj6Yb4L', 'Zx1Ty7Dn5Gm8P',
  ];
  ok(new Set(BODIES).size === secretNames.length, 'sanity: one distinct sentinel body per secret');
  const sentinelEnv: Record<string, string> = { ...OK_ENV, RINGOTEL_API_KEY: 'x', RINGOTEL_WRITE_DOMAINS: '*' };
  const sentinels: string[] = [];
  secretNames.forEach((name, i) => {
    const sentinel = `${BODIES[i]}${BODIES[i]!.split('').reverse().join('')}`; // 26 chars, unique, no key name
    sentinelEnv[name] = sentinel;
    sentinels.push(sentinel);
  });

  const doc = buildStatus(sentinelEnv, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  const blob = JSON.stringify(doc);

  for (const sentinel of sentinels) {
    ok(!blob.includes(sentinel), `the full sentinel value never appears in the serialized document (${sentinel})`);
    ok(!blob.includes(sentinel.slice(0, 10)), `nor a 10-char head of it — a truncated render is still a disclosure (${sentinel})`);
    ok(!blob.includes(sentinel.slice(-8)), `nor an 8-char TAIL of it — the "last four" fingerprint habit is still a disclosure (${sentinel})`);
  }
  ok(doc.settings.filter((s) => s.kind === 'secret').every((s) => s.value === null),
    'every secret SettingView still carries value:null with the sentinels in place');
}

// ── THE INVARIANT (M2, 2026-08-07 pre-deploy review): a `missing[]` entry may NEVER name a setting that
// is set. Four cards carried hardcoded lists that were never filtered against the live env, so the page
// told operators to set things they had already set — the exposure card named PORTAL_MODE in the one mode
// the console is served in, and offered ALLOW_UNGATED_SERVICE_TOKEN=1 as the alternative.
//
// Asserted as the GENERAL rule over a spread of envs, not as three specific cases: the specific cases were
// symptoms of one mechanism (see `requirements()` in status.ts), and three targeted assertions would leave
// the twenty-second card free to reintroduce it. `SettingView.set` is the authority for "is it present" —
// the same predicate the Config tab renders — so the two can never disagree about one setting.
{
  const principal = P('Super User', 'boss@example.com');
  const hostname = 'svc.example.com';

  // Each env is chosen to make some requirement UNMET while its setting is PRESENT — the shape that used to
  // produce the lie. The last few are ordinary broken deployments, to keep the sweep honest about the
  // normal absent case too.
  const ENVS: Array<[string, Record<string, unknown>]> = [
    ['portal mode with a leftover service token', { ...OK_ENV, NS_API_TOKEN: 'leftover' }],
    ['standalone with an ungated service token', { NS_SERVER: 'ns.example.com', NS_PORTAL_ISS: 'portal.example.com', NS_API_TOKEN: 'leftover', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'portal' }],
    ['NS_SERVER left at the shipped placeholder', { ...OK_ENV, NS_SERVER: 'api.example.com' }],
    ['PORTAL_MODE explicitly turned off', { ...OK_ENV, PORTAL_MODE: '0', NS_API_TOKEN: 't', ALLOW_UNGATED_SERVICE_TOKEN: '1', RINGOTEL_API_KEY: 'k' }],
    ['CACHE_SCOPE explicitly "default"', { ...OK_ENV, CACHE_SCOPE: 'default' }],
    ['a write rail that parses to nothing', { ...OK_ENV, RINGOTEL_API_KEY: 'k', RINGOTEL_WRITE_DOMAINS: ',' }],
    ['admin credentials with only the OAuth client id', { ...OK_ENV, NS_ADMIN_USER: 'svc', NS_ADMIN_PASS: 'x', NS_OAUTH_CLIENT_ID: 'cid' }],
    ['admin credentials with only the OAuth secret', { ...OK_ENV, NS_ADMIN_USER: 'svc', NS_ADMIN_PASS: 'x', NS_OAUTH_CLIENT_SECRET: 'sec' }],
    ['events armed and offboarding requested', { ...OK_ENV, NS_EVENTS: 'on', NS_EVENTS_BASE_URL: 'https://events.example.com', NS_EVENTS_PATH_SECRET: 'p', NS_EVENTS_DOMAINS: '*', NS_ADMIN_USER: 'svc', NS_ADMIN_PASS: 'x', NS_EVENTS_OFFBOARD: 'deactivate', RINGOTEL_API_KEY: 'k' }],
    ['an events domain list that parses to nothing', { ...OK_ENV, NS_EVENTS_DOMAINS: ',', NS_API_KEY: 'k' }],
    ['nothing configured at all', {}],
    ['a bare standalone deployment', { NS_SERVER: 'ns.example.com', NS_API_TOKEN: 't', ALLOW_UNGATED_SERVICE_TOKEN: '1' }],
  ];

  let violations = 0;
  let unexplained = 0;
  let sawPresentButUnmet = 0;
  for (const [label, env] of ENVS) {
    const doc = buildStatus(env as any, { principal, hostname });
    const setNames = new Set(doc.settings.filter((s) => s.set).map((s) => s.name));
    const cards = [
      ...doc.features.map((f) => ({ id: f.key, state: f.state, missing: f.missing, notes: f.notes })),
      ...doc.subsystems.map((s) => ({ id: s.id, state: s.state, missing: s.missing, notes: s.notes })),
    ];
    for (const c of cards) {
      for (const m of c.missing) {
        if (setNames.has(m.setting)) {
          violations++;
          console.log(`   ↳ ${label}: card ${c.id} lists SET setting ${m.setting} under Missing`);
        }
      }
      // The other half of the fix: filtering must not leave a card `inert` with nothing to act on. An unmet
      // requirement whose setting IS present becomes a note instead, so every inert card still explains
      // itself — if this ever fires, that card's own state logic is wrong, not its missing list.
      if (c.state === 'inert' && c.missing.length === 0 && c.notes.length === 0) {
        unexplained++;
        console.log(`   ↳ ${label}: card ${c.id} is inert but names nothing at all`);
      }
      if (c.notes.some((n) => /is already set, so it is not missing/.test(n))) sawPresentButUnmet++;
    }
  }
  ok(violations === 0, `no card's missing[] names a setting whose SettingView.set is true, across ${ENVS.length} envs`);
  ok(unexplained === 0, 'and no card is inert without either a missing entry or a note explaining why');
  // Guard against a vacuous sweep: if the filter silently dropped everything, or none of these envs
  // reproduced the shape any more, the two assertions above would pass while testing nothing.
  ok(sawPresentButUnmet > 0, `and the present-but-unmet case IS reached by this sweep (${sawPresentButUnmet} cards)`);
}

// ── M1's other victim: buildStatus itself. A non-string element in a gate's `users` crashed `can()`, which
// featureCard calls for every registry entry — so the console 500'd on exactly the misconfiguration it
// exists to name, and the fix belongs at the config boundary (features.ts `gateLevels`), not in a try/catch
// here. `features.selftest.ts` covers the boundary; this covers the consequence. ─────────────────────────
{
  const env = { ...OK_ENV, PORTAL_FEATURES: JSON.stringify({ 'callflow.view': { users: ['a@b.example', 42] } }) };
  let threw: unknown = null;
  let doc: ReturnType<typeof buildStatus> | null = null;
  try { doc = buildStatus(env as any, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' }); }
  catch (e) { threw = e; }
  ok(!threw, `buildStatus survives a non-string users element${threw ? ` (threw: ${threw instanceof Error ? threw.message : String(threw)})` : ''}`);
  ok(!!doc && doc.configErrors.some((e) => /Feature gating/.test(e.subsystem) && /strings/.test(e.reason)),
    'and names it as a feature-gating config error with a reason');
}


// ── gatedBy: a configured setting that is doing nothing says so, naming the gate ──────────────────────
// UX-spec item 10. It also resolves item 10's sharper half: nothing used to say the NS_EVENTS_* block was
// app-directory related at all, so a reader could not tell why twelve settings existed.
{
  const doc = (env: any) => buildStatus(env, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  const noKey = doc(OK_ENV).settings;
  const withKey = doc({ ...OK_ENV, RINGOTEL_API_KEY: 'k' }).settings;
  const g = (rows: typeof noKey, n: string) => rows.find((s) => s.name === n)!.gate;

  ok(g(noKey, 'RINGOTEL_API_KEY') === null, '[gatedBy] the gate setting itself has no gate — it IS the gate');
  ok(g(noKey, 'RINGOTEL_PRESENCE')?.setting === 'RINGOTEL_API_KEY', '[gatedBy] a Ringotel setting names its gate');
  ok(g(noKey, 'RINGOTEL_PRESENCE')?.satisfied === false, '[gatedBy] and reports it unsatisfied with no key');
  ok(g(withKey, 'RINGOTEL_PRESENCE')?.satisfied === true, '[gatedBy] and satisfied once the key is set');
  // The twelve events settings are declared app-gated, which is the fact the page was silent about.
  const evGates = noKey.filter((s) => s.group === 'events');
  ok(evGates.length >= 12 && evGates.every((s) => s.gate?.setting === 'RINGOTEL_API_KEY'),
    `[gatedBy] every change-events setting names the app integration as its gate (${evGates.length} rows)`);
  // The identity block is gated on events being ARMED — a stronger condition than "NS_EVENTS is not off",
  // and it must read the same armed fact the Integrations tab reports, not a second derivation of it.
  const idGates = noKey.filter((s) => s.group === 'identity');
  ok(idGates.length > 0 && idGates.every((s) => s.gate?.setting === 'NS_EVENTS' && s.gate?.satisfied === false),
    '[gatedBy] the service-identity block is gated on change events actually being armed');
  const armedDoc = doc({ ...OK_ENV, RINGOTEL_API_KEY: 'k', RINGOTEL_WRITE_DOMAINS: '*', NS_EVENTS: 'on',
    NS_EVENTS_DOMAINS: '*', NS_EVENTS_BASE_URL: 'https://svc.example.com', NS_EVENTS_PATH_SECRET: 's',
    NS_API_KEY: 'apikey' });
  const armedIdentity = armedDoc.settings.filter((s) => s.group === 'identity');
  const eventsCardOn = armedDoc.subsystems.find((s) => s.id === 'events')!.state === 'on';
  ok(eventsCardOn && armedIdentity.every((s) => s.gate?.satisfied === true),
    '[gatedBy] and once events ARE armed both the events card and the identity gate agree — one evaluation, not two');
}

// ── defaults are a different fact from consequences-of-absence ────────────────────────────────────────
// UX-spec item 5. `NS_SERVER` has no default, it has a consequence; labelling that "Default" is false.
{
  const rows = buildStatus(OK_ENV, { principal: P('Super User', 'boss@example.com'), hostname: 'x' }).settings;
  const d = (n: string) => rows.find((s) => s.name === n)!;
  ok(d('CACHE_SCOPE').defaultValue === 'default', 'a setting with a real default reports the value');
  ok(d('NS_EVENTS_MAX_EVENTS').defaultValue === '40', 'a numeric default reports as its literal');
  ok(d('NS_SERVER').defaultValue === null, 'NS_SERVER has NO default — absence is a consequence, not a value');
  ok(d('PORTAL_SUPERADMINS').defaultValue === null, 'nor does PORTAL_SUPERADMINS');
  // Every row can say how to set it, and the mechanism must match the KIND — telling an operator to add a
  // binding to `vars` sends them to add a string that creates no binding while the loud 500 remains.
  ok(rows.every((s) => s.howToSet.length > 0), 'every setting carries the literal line to type');
  ok(rows.filter((s) => s.kind === 'secret').every((s) => /wrangler secret put/.test(s.howToSet)),
    'a secret is set with `wrangler secret put`, never a vars entry');
  ok(rows.filter((s) => s.kind === 'secret').every((s) => !/vars/.test(s.howToSet)),
    'and its instruction never mentions vars');
  ok(rows.filter((s) => s.group === 'bindings').every((s) => /a binding, NOT a vars string/.test(s.howToSet)),
    'a binding says outright that it is not a vars string');
  ok(rows.filter((s) => s.kind === 'config' && s.group !== 'bindings').every((s) => /vars/.test(s.howToSet)),
    'and a plain setting names the vars block');
  // Secrets carry no example value at all: there is nothing value-shaped that belongs on a secret row.
  ok(rows.filter((s) => s.kind === 'secret').every((s) => s.example === null),
    'no secret row carries an example value');
}

// ── the permissions matrix: three layers, and it must never over-claim ───────────────────────────────
// UX-spec items 19 + 20. The trap the naive version would fall into is modelling only the policy layer,
// which would confidently tell a domain-locked Office Manager they can open this console.
{
  const doc = buildStatus(OK_ENV, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
  const p = doc.permissions;
  const row = (k: string) => p.rows.find((r) => r.key === k)!;
  const cell = (k: string, scope: string) => row(k).cells.find((c) => c.scope === scope)!;

  ok(p.rows.length === doc.features.length, 'one row per feature');
  ok(p.rows.every((r) => r.cells.length === p.columns.length), 'and one cell per scope column');
  // Built FROM the feature cards, so the two tabs cannot describe different gates.
  ok(p.rows.every((r) => r.gateInWords === doc.features.find((f) => f.key === r.key)!.gate.inWords),
    'every row quotes the SAME gate prose its feature card does — one derivation, two readers');

  // On the DEFAULT gate the console is superadmin-only, so no scope column passes on its own. Stated
  // first, because the two assertions below are only meaningful against it.
  ok(p.columns.every((c) => cell('kit.status', c).verdict !== 'yes'),
    '[matrix] on the default gate no scope opens the console on its own — it is superadmin-only');
  ok(row('kit.status').superadmin.verdict === 'yes',
    '[matrix] and the named superadmin does — so the row is not uniformly refused');

  // Widened to reseller, the Reseller column passes. This is the control for the next assertion: without
  // it, "an Office Manager cannot" would hold trivially because nobody can.
  {
    const env = { ...OK_ENV, PORTAL_FEATURES: JSON.stringify({ 'kit.status': 'reseller' }) };
    const dW = buildStatus(env, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
    const rw = dW.permissions.rows.find((r) => r.key === 'kit.status')!;
    ok(rw.cells.find((c) => c.scope === 'Reseller')!.verdict === 'yes',
      '[matrix] widened to reseller, the Reseller column reads available');
    ok(rw.cells.find((c) => c.scope === 'Basic User')!.verdict !== 'yes', '[matrix] a Basic User still cannot');
  }

  // The NAMED axis, and the finding it exists for. A scope column evaluates a GENERIC account of that
  // scope, so a `users:` grant is invisible there — it would read `no` for the wrong reason (the gate does
  // admit them; a second gate refuses). The named column isolates what a NAME alone buys.
  ok(p.rows.every((r) => (r.namedAccounts.length === 0) === (r.named === null)),
    '[matrix] the named column is present exactly when the gate names someone');
  ok(p.rows.every((r) => r.namedAccounts.length === 0),
    '[matrix] with no overrides, no registry default names an account directly');
  {
    const env = { ...OK_ENV, PORTAL_FEATURES: JSON.stringify({ 'kit.status': { users: ['om@customer.example'] } }) };
    const d2 = buildStatus(env, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
    const r2 = d2.permissions.rows.find((r) => r.key === 'kit.status')!;
    ok(r2.namedAccounts.includes('om@customer.example'), '[matrix] the row names the account its gate grants');
    ok(r2.named !== null && r2.named.verdict === 'blocked',
      `[matrix] and a name alone does NOT open the console — the fleet-read rule still refuses (got: ${r2.named?.verdict})`);
    ok(/other domains|own domain/i.test(r2.named!.why),
      '[matrix] with a reason that names why, not merely that it failed');
  }
  // The positive control, so "blocked" above is not just "the named axis always blocks": a name IS enough
  // once the account also passes the bundle gate that would carry the feature. This is itself a useful
  // finding — naming someone in one feature's gate does nothing unless they can receive the bundle.
  {
    const env = { ...OK_ENV, PORTAL_FEATURES: JSON.stringify({
      'portal.access': { levels: ['office_manager'], users: ['guest@other.example'] },
      'callflow.view': { levels: ['reseller'], users: ['guest@other.example'] },
    }) };
    const d3 = buildStatus(env, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
    const cf = d3.permissions.rows.find((r) => r.key === 'callflow.view')!;
    ok(cf.named !== null && cf.named.verdict === 'yes',
      `[matrix] a name granted on BOTH the feature and the bundle reads available (got: ${cf.named?.verdict})`);
    // And without the bundle grant, the same name is blocked rather than available — the delivery layer.
    const env2 = { ...OK_ENV, PORTAL_FEATURES: JSON.stringify({ 'callflow.view': { levels: ['reseller'], users: ['guest@other.example'] } }) };
    const d4 = buildStatus(env2, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
    const cf2 = d4.permissions.rows.find((r) => r.key === 'callflow.view')!;
    ok(cf2.named !== null && cf2.named.verdict === 'blocked' && /portal\.access/.test(cf2.named.why),
      `[matrix] and naming them on the feature alone is blocked at delivery, naming portal.access (got: ${cf2.named?.verdict})`);
  }

  // The floor is visible as UNAVAILABLE, not merely un-granted: someone who tries to grant past it gets a
  // 500 at deploy time.
  ok(row('kit.status').floorBlocks.includes('Basic User') && row('kit.status').floorBlocks.includes('Office Manager'),
    '[matrix] kit.status marks the scopes its floor puts out of reach');
  ok(!row('kit.status').floorBlocks.includes('Reseller') && !row('kit.status').floorBlocks.includes('Super User'),
    '[matrix] and does NOT mark the two it permits');
  ok(row('callflow.view').floorBlocks.length === 0, '[matrix] a feature with no floor blocks nothing');

  // Layer 2a — delivery. An `off` portal.self makes every me.* unreachable regardless of its own gate.
  {
    const env = { ...OK_ENV, PORTAL_FEATURES: JSON.stringify({ 'portal.self': 'off' }) };
    const d3 = buildStatus(env, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
    const meRows = d3.permissions.rows.filter((r) => r.key.startsWith('me.'));
    ok(meRows.length > 0 && meRows.every((r) => r.cells.every((c) => c.verdict !== 'yes')),
      '[matrix] with portal.self off, no me.* feature reads as available to anyone');
  }

  // Layer 3 — prerequisites. Ringotel features are allowed but cannot run without an API key.
  ok(cell('ringotel.activate', 'Reseller').verdict === 'inert',
    `[matrix] allowed-but-not-configured reads as inert, not available (got: ${cell('ringotel.activate', 'Reseller').verdict})`);

  // The synthesized account must not accidentally BE a granted account, or every cell over-claims.
  {
    const env = { ...OK_ENV, PORTAL_SUPERADMINS: 'someone@d.example,boss@example.com' };
    const d4 = buildStatus(env, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
    const bu = d4.permissions.rows.find((r) => r.key === 'callflow.view')!.cells.find((c) => c.scope === 'Basic User')!;
    ok(bu.verdict !== 'yes',
      '[matrix] a superadmin list that happens to contain the obvious synthetic id does not make every cell available');
  }

  // Every cell explains itself — a glyph with no reason is a colour, not information.
  ok(p.rows.every((r) => [...r.cells, r.superadmin].every((c) => c.why.length > 10)),
    '[matrix] every cell carries a reason');
  // The superadmin axis is evaluated at the lowest scope, so it proves the "at any scope" claim.
  ok(row('callflow.view').superadmin.verdict === 'yes',
    '[matrix] a named superadmin passes a reseller-gated feature despite the lowest scope');
  ok(row('me.devices').superadmin.verdict !== 'yes', '[matrix] but not an `off` feature — off has no superadmin exception');

  // The emitted config must survive this deployment's own validator, or the console would hand out a blob
  // that bricks the Worker at boot.
  ok(p.jsonError === null, `[matrix] the emitted JSON validates${p.jsonError ? ` (got: ${p.jsonError})` : ''}`);
  ok(p.jsonExplicit.includes('"kit.status"') && p.jsonExplicit.includes('"callflow.view"'),
    '[matrix] the explicit form names every feature');
  ok(p.jsonOverrides === '', '[matrix] with nothing overridden, the overrides form is empty rather than a misleading {}');
  {
    const env = { ...OK_ENV, PORTAL_FEATURES: JSON.stringify({ 'callflow.view': 'office_manager' }) };
    const d5 = buildStatus(env, { principal: P('Super User', 'boss@example.com'), hostname: 'x' });
    ok(/\n/.test(d5.permissions.jsonOverrides) === false || d5.permissions.jsonOverrides.includes('  '),
      '[matrix] the overrides form is pretty-printed, not one unreadable line');
    ok(d5.permissions.jsonOverrides.includes('callflow.view') && !d5.permissions.jsonOverrides.includes('kit.status'),
      '[matrix] and contains ONLY the overridden keys — the form that stays subject to future defaults');
  }
  // Assumptions are stated, not implied: a matrix is a claim about people who are not in the room.
  ok(p.assumptions.length >= 3 && p.assumptions.some((a) => a.includes('d.example')),
    '[matrix] the evaluation names the domain it assumed');
}

// ── the merged apps-menu hide list is REPORTED, which is what makes two settings safe ────────────────
{
  const both = {
    NS_SERVER: 'core.example.com', PORTAL_MODE: '1',
    PORTAL_APPS_HIDE: 'Meeting', PORTAL_MENUS: JSON.stringify({ apps: { hide: ['Voicemail'] } }),
  };
  const d = buildStatus(both as any, { principal: null, hostname: 'svc.example.com' });
  const card = d.subsystems.find((s) => s.id === 'menus');
  const note = (card?.notes ?? []).join(' ');
  ok(/both are set/i.test(note), '[merge] the menus card says both hide settings are set');
  ok(note.includes('Voicemail') && note.includes('Meeting'),
    `[merge] naming what EACH contributes, so neither reads as ignored (${note.slice(0, 80)}…)`);
  ok(card?.state !== 'misconfigured', '[merge] and the card is not misconfigured — this is legal now');
  // The whole deployment must still be routable: the old fatal error 500'd every route including the
  // injected primary over two cosmetic settings.
  ok(!d.configErrors.some((e) => /menu/i.test(e.subsystem)), '[merge] with no config error raised');

  // Only when BOTH are set. A note that appeared for a single setting would be noise on most deployments.
  const one = { ...both, PORTAL_APPS_HIDE: '' };
  const oneNote = (buildStatus(one as any, { principal: null, hostname: 'svc.example.com' })
    .subsystems.find((s) => s.id === 'menus')?.notes ?? []).join(' ');
  ok(!/both are set/i.test(oneNote), '[merge] and says nothing when only one is set');

  // PORTAL_APPS_HIDE alone is still menu customization, so the card must not read `off` — that was true
  // when PORTAL_MENUS was the only thing the card looked at.
  const legacyOnly = { NS_SERVER: 'core.example.com', PORTAL_MODE: '1', PORTAL_APPS_HIDE: 'Meeting' };
  ok(buildStatus(legacyOnly as any, { principal: null, hostname: 'svc.example.com' })
    .subsystems.find((s) => s.id === 'menus')?.state === 'on',
    '[merge] and PORTAL_APPS_HIDE alone still counts as menu customization being on');
}

// ── audience: derived from the key namespace, not a second hand-kept list ─────────────────────────────
{
  const doc = buildStatus(OK_ENV, { principal: P('Super User', 'boss@example.com'), hostname: 'x' });
  const self = doc.features.filter((f) => f.audience === 'self').map((f) => f.key);
  ok(self.includes('portal.self'), '[audience] the self bundle entry point is self-service');
  // The namespace rule, with its ONE documented exception. `me.menuConfig` is operator configuration applied
  // to every user — nothing about it concerns the reader's own account — so the prefix, which records which
  // BUNDLE delivers it, is the wrong signal for audience there.
  const meAudiences = doc.features.filter((f) => f.key.startsWith('me.')).map((f) => `${f.key}:${f.audience}`);
  ok(meAudiences.filter((x) => x.endsWith(':admin')).length === 1 && meAudiences.includes('me.menuConfig:admin'),
    `[audience] exactly one me.* feature overrides to admin, and it is menuConfig (${meAudiences.join(' ')})`);
  ok(doc.features.filter((f) => f.key.startsWith('me.') && f.key !== 'me.menuConfig').every((f) => f.audience === 'self'),
    '[audience] every other me.* is still self-service');

  // AUDIENCE AND DELIVERY ARE DIFFERENT FACTS, and conflating them was a live bug: labelling menuConfig as
  // admin instantly made the matrix report it reachable with portal.self off, which is false — the SELF
  // bundle delivers every me.* key regardless of who the feature is for.
  {
    const off = buildStatus({ ...OK_ENV, PORTAL_FEATURES: JSON.stringify({ 'portal.self': 'off' }) },
      { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
    const mc = off.permissions.rows.find((r) => r.key === 'me.menuConfig')!;
    ok(mc.audience === 'admin', '[audience] menuConfig is still labelled admin');
    ok(mc.cells.every((c) => c.verdict !== 'yes'),
      '[audience] and is STILL unreachable with portal.self off — delivery follows the key, not the label');
    ok(mc.cells.some((c) => /portal\.self/.test(c.why)),
      '[audience] naming portal.self as the blocker, so the reader is sent to the right gate');
  }
  ok(doc.features.every((f) => f.audience === 'admin' || f.audience === 'self'),
    '[audience] every feature has one — a third value would silently vanish from both sections of the tab');
}

// ── the taxonomy: every subsystem is placed, and every child names a real parent ──────────────────────
// UX-spec item 12. The old split was "is it in FEATURE_REGISTRY", a fact about our code.
{
  const doc = buildStatus(OK_ENV, { principal: P('Super User', 'boss@example.com'), hostname: 'x' });
  const subs = doc.subsystems;
  ok(subs.every((s) => s.tab === 'integration' || s.tab === 'deployment'),
    '[taxonomy] every subsystem is on one of the two tabs');
  const ids = new Set(subs.map((s) => s.id));
  const orphans = subs.filter((s) => s.parent !== null && !ids.has(s.parent));
  ok(orphans.length === 0, `[taxonomy] no child names a parent that does not exist${orphans.length ? ` (${orphans.map((s) => s.id).join(', ')})` : ''}`);
  // A child must be on the same tab as its parent, or it renders nowhere.
  const strayTab = subs.filter((s) => s.parent && subs.find((p) => p.id === s.parent)!.tab !== s.tab);
  ok(strayTab.length === 0, `[taxonomy] a child is always on its parent's tab${strayTab.length ? ` (${strayTab.map((s) => s.id).join(', ')})` : ''}`);
  // One level only: a grandchild would render nowhere, since the renderer nests exactly one deep.
  const grandkids = subs.filter((s) => s.parent && subs.find((p) => p.id === s.parent)!.parent !== null);
  ok(grandkids.length === 0, `[taxonomy] nesting is one level deep${grandkids.length ? ` (${grandkids.map((s) => s.id).join(', ')})` : ''}`);
  // The things that ARE integrations are the external systems, and the app integration owns its aspects.
  const roots = subs.filter((s) => s.tab === 'integration' && s.parent === null).map((s) => s.id);
  ok(roots.length === 3 && roots.includes('ringotel') && roots.includes('onebill') && roots.includes('documo'),
    `[taxonomy] exactly three external systems are top-level integrations (got: ${roots.join(', ')})`);
  ok(subs.filter((s) => s.parent === 'ringotel').length >= 6,
    'and the app integration owns its own sub-aspects rather than standing beside them');
}

// ── the version links to its own release notes, in three states ───────────────────
// The same absent / empty / value shape PORTAL_HANDOFF_URL uses, so a reader who has met one has met both —
// and `{version}` substitution rather than a fixed suffix, so a fork can point anywhere including at its own
// documentation. Built here rather than in the footer feature (ROADMAP §20) because both consumers need one
// resolver, and the footer would otherwise invent a second.
{
  const doc = (env: any) => buildStatus({ ...OK_ENV, ...env },
    { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' }).deployment;

  const dflt = doc({});
  ok(!!dflt.releaseNotesUrl, 'absent ⇒ a default link');
  ok(dflt.releaseNotesUrl!.includes(dflt.version),
    `[notes] the default carries THIS deployment's version, not a literal placeholder (${dflt.releaseNotesUrl})`);
  ok(!dflt.releaseNotesUrl!.includes('{version}'), '[notes] and no unsubstituted placeholder survives');
  ok(dflt.releaseNotesUrl!.startsWith('https://'), '[notes] and it is https');

  // Present-but-empty is a DECLARATION, not an omission — the one way to switch the link off while keeping
  // the version visible.
  ok(doc({ PORTAL_RELEASE_NOTES_URL: '' }).releaseNotesUrl === null, '[notes] empty ⇒ no link at all');
  ok(doc({ PORTAL_RELEASE_NOTES_URL: '   ' }).releaseNotesUrl === null, '[notes] whitespace-only counts as empty');

  // A fork's own template, substituted anywhere it appears.
  const own = doc({ PORTAL_RELEASE_NOTES_URL: 'https://example.com/notes/{version}/#v{version}' }).releaseNotesUrl!;
  ok(own === `https://example.com/notes/${dflt.version}/#v${dflt.version}`,
    `[notes] a custom template substitutes EVERY occurrence (${own})`);
  // A template with no placeholder is legal — someone may want one page for everything.
  ok(doc({ PORTAL_RELEASE_NOTES_URL: 'https://example.com/notes' }).releaseNotesUrl === 'https://example.com/notes',
    '[notes] a template with no placeholder is passed through unchanged');
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
