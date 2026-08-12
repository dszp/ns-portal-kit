/**
 * Offline test for the Worker-served injection routes (no workerd): stubs `caches` + `fetch`, mocks the
 * ASSETS (R2) binding, and drives worker.fetch. Mirrors portal.selftest.ts.
 *   pnpm test:kit
 */
import { Script, runInNewContext } from 'node:vm';
import { buildKitBundle, buildSelfBundle, buildSpkBundle, featurePolicyKeys, selfFeaturePolicyKeys, primaryJs, SELF_FEATURE_KEYS, SPK_FEATURE_KEYS, FEATURE_KEYS } from './kit.js';
import { keysDeliveredBy, FEATURE_REGISTRY } from './features.js';
import { parseManifest, kitGateAllows, kitConfigError } from './kit.js';
import { VERSION } from './brand.js';
import { SPK_BRIDGE } from './spkBridge.js';
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ISS = 'portal.example.com'; // NOT 'manage.example.com' — that's setup.ts's placeholder (would trip /health)
const ORIGIN = 'https://manage.example.com';
const mkTok = (claims: Record<string, unknown>) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ aud: 'ns', iss: ISS, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;

class MemoryCache {
  store = new Map<string, Response>();
  async match(req: Request) { const r = this.store.get(req.url); return r ? r.clone() : undefined; }
  async put(req: Request, res: Response) { this.store.set(req.url, res.clone()); }
}
(globalThis as any).caches = { default: new MemoryCache() };

(globalThis as any).fetch = async (input: string) => {
  const u = new URL(String(input));
  const path = u.pathname.replace(/^\/ns-api\/v2/, '');
  if (path === '/jwt') return new Response('{}', { status: 200 }); // live-check: any valid-local token is "valid"
  return new Response('[]', { status: 404 });
};

// A minimal R2-like ASSETS binding: get(key) → { text() } for known keys, else null.
const ASSET_KEYS = new Set(['pub', 'authed', 'adm', 'sadm']);
const makeAssets = () => ({
  async get(key: string) {
    return ASSET_KEYS.has(key) ? { text: async () => `/*asset:${key}*/` } : null;
  },
});

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

const MANIFEST = JSON.stringify([
  { name: 'pub', from: 'r2:pub', auth: 'public' },
  { name: 'authed', from: 'r2:authed', auth: 'all' },
  { name: 'adm', from: 'r2:adm', auth: 'office_manager' },
  { name: 'sadm', from: 'r2:sadm', auth: 'reseller' },
  { name: 'ext', from: 'url:https://cdn.example.com/x.js', auth: 'public' },
]);

// Identities
const reseller = mkTok({ sub: 'admin@0000.12345.service', user_scope: 'Reseller', domain: '0000.12345.service' });
const reseller2 = mkTok({ sub: 'other@0000.12345.service', user_scope: 'Reseller', domain: '0000.12345.service' });
const realOM = mkTok({ sub: '105@acme.example', user_scope: 'Office Manager', domain: 'acme.example' });
const basic = mkTok({ sub: '100@acme.example', user_scope: 'Basic User', domain: 'acme.example' });

(async () => {
  const { default: worker } = await import('./worker.js');
  const ctx = { waitUntil() {}, passThroughOnException() {} } as any;

  const baseEnv = {
    NS_SERVER: 'mock.local', PORTAL_MODE: '1', NS_PORTAL_ISS: ISS, ALLOWED_ORIGINS: 'https://manage.example.com',
    PORTAL_HANDOFF_URL: 'https://vendor.example.com/router.js', PORTAL_SECONDARIES: MANIFEST,
    RINGOTEL_LABEL: 'App', RINGOTEL_APP_BASE_URL: 'https://app.example.com',
  };
  const env = { ...baseEnv, ASSETS: makeAssets() };
  const call = (path: string, tok?: string, e: any = env) => {
    const headers: Record<string, string> = { Origin: ORIGIN };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    return worker.fetch(new Request(`https://svc.dev${path}`, { headers }), e, ctx);
  };

  // ── Public primary ───────────────────────────────────────────────────────────────
  {
    const r = await call('/p.js'); // default basename, no auth
    ok(r.status === 200, '[primary] default /p.js → 200 no-auth');
    ok((r.headers.get('content-type') || '').includes('text/javascript'), '[primary] served as text/javascript');
    ok((r.headers.get('cache-control') || '').includes('public'), '[primary] public cache');
    const body = await r.text();
    ok(body.includes('/kit/portal.js') && body.includes('currentScript'), '[primary] bootstrap fetches gated bundle, derives base from currentScript');
    ok(!body.includes('"App"'), '[primary] public primary carries NO white-label label');
    let pOk = true; try { new Script(body); } catch (e) { pOk = false; }
    ok(pOk, '[primary] emitted primary compiles');
    ok(body.includes('__kitCfg.loaded'), '[primary] once-guard present (idempotent — no double handoff on reload/Load-now)');
  }
  // Handoff nag: reseller-only, fires only when PORTAL_HANDOFF_URL is ABSENT (not "").
  {
    const missing = primaryJs({});                          // no PORTAL_HANDOFF_URL → absent
    const silent = primaryJs({ PORTAL_HANDOFF_URL: '' });   // present-empty → intentional none
    ok(missing.includes('HANDOFF_MISSING=true') && silent.includes('HANDOFF_MISSING=false'), '[nag] absent handoff → HANDOFF_MISSING=true; "" → false (silent)');
    ok(missing.includes('function kitNag') && missing.includes('if(!_isReseller(_scope()))return'), '[nag] reseller gate present (no TEMP bypass shipped)');
    ok(!missing.includes('TEMP-VISUAL-TEST'), '[nag] no TEMP-VISUAL-TEST scaffolding in the served primary');
    let nOk = true; try { new Script(missing); } catch (e) { nOk = false; }
    ok(nOk, '[nag] primary with the nag compiles');
  }
  ok((await call('/custom.js', undefined, { ...env, PRIMARY_BASENAME: 'custom' })).status === 200, '[primary] overridden basename /custom.js → 200');
  ok((await call('/p.js', undefined, { ...env, PRIMARY_BASENAME: 'custom' })).status !== 200, '[primary] non-configured basename /p.js not served when basename=custom (falls through)');

  // ── Gated bundle /kit/portal.js ────────────────────────────────────────────────────
  ok((await call('/kit/portal.js')).status === 401, '[bundle] no bearer → 401');
  ok((await call('/kit/portal.js', basic)).status === 403, '[bundle] Basic User (no portal.access) → 403');
  {
    const r = await call('/kit/portal.js', reseller);
    ok(r.status === 200, '[bundle] reseller → 200');
    ok((r.headers.get('cache-control') || '').includes('private') && (r.headers.get('vary') || '').includes('Authorization'), '[bundle] private,max-age + Vary: Authorization');
    ok((r.headers.get('access-control-allow-origin') || '') === 'https://manage.example.com', '[bundle] CORS spread by hand');
    const body = await r.text();
    ok(body.includes('callflow:true') && body.includes('orgStatus:true') && body.includes('userStatus:true') && body.includes('orgList:true'), '[bundle] reseller _AF: all features on');
    ok(body.includes('profileStatus:true') && body.includes('activate:true') && body.includes('resetPassword:true'), '[bundle] reseller _AF: profile activation features on');
    // Compile-only (never run): validates the emitted bundle parses, proving String.raw preserved the
    // regex backslashes (a collapsed `/^\/portal/` → `/^/portal/` would be a SyntaxError here).
    let syntaxOk = true; try { new Script(body); } catch (e) { syntaxOk = false; }
    ok(syntaxOk, '[bundle] emitted JS compiles (String.raw kept the regex backslashes intact)');
    ok(body.includes('user-toolbar') && body.includes('/rapp/org') && body.includes('svx-appcol') && body.includes('Call Flow Diagram'), '[bundle] folded features present (banner + columns + call-flow)');
    ok(body.includes('/rapp/activate') && body.includes('/rapp/resetPassword') && body.includes('profile-panel-main') && body.includes('jpost'), '[bundle] profile activation feature folded (activate + reset + jpost)');
    ok(body.includes('force:true') && body.includes('Force-activate') && body.includes('_isRes'), '[bundle] reseller runtime force-activate override present');
    ok(body.includes('"label":"App"'), '[bundle] gated bundle carries the deployment label from RINGOTEL_LABEL');
    ok(body.includes('"appBase":"https://app.example.com"'), '[bundle] https app-base carried into _KC');
  }
  {
    const r = await call('/kit/portal.js', realOM);
    ok(r.status === 200, '[bundle] OM → 200');
    const body = await r.text();
    ok(body.includes('callflow:false') && body.includes('orgStatus:false') && body.includes('userStatus:true') && body.includes('orgList:false'), '[bundle] OM _AF: only userStatus on (per the feature registry defaults)');
    ok(body.includes('profileStatus:true') && body.includes('activate:true') && body.includes('resetPassword:true'), '[bundle] OM _AF: profile activation features on (office_manager default)');
  }
  {
    const a = await (await call('/kit/portal.js', reseller)).text();
    const b = await (await call('/kit/portal.js', reseller2)).text();
    ok(a === b, '[bundle] same-tier byte-identity (two distinct resellers → identical bytes)');
  }
  // Source neutrality (unit-level, bypassing the per-tier cache which keys on host+tier+VERSION, not
  // labels): buildKitBundle with NO white-label env defaults to 'Ringotel' and carries no SV specifics —
  // proves the mirror-bound KIT_FEATURE_BODY has no deployment literals.
  {
    // Tests the INVARIANT rather than a list of historical brand words: a white-label value reaches the
    // bundle only via env, so a bundle built with no env must not contain it. That can't go stale when a
    // new brand term appears, and it keeps deployment-specific strings out of this (mirror-bound) file.
    const BRAND_PROBE = 'ZZ-BRAND-PROBE-9137';
    const branded = buildKitBundle(featurePolicyKeys(), { RINGOTEL_LABEL: BRAND_PROBE });
    ok(branded.includes(BRAND_PROBE), '[neutral] a white-label value DOES reach the bundle when set in env');
    const neutral = buildKitBundle(featurePolicyKeys(), {});
    ok(neutral.includes('"label":"Ringotel"'), '[neutral] no RINGOTEL_LABEL → label defaults to "Ringotel"');
    ok(!neutral.includes(BRAND_PROBE), '[neutral] and no white-label value is baked into the source (mirror-safe)');
    let ok2 = true; try { new Script(neutral); } catch (e) { ok2 = false; }
    ok(ok2, '[neutral] neutral bundle also compiles');
  }
  // ⚠️ TWO ASSERTION-FREE BLOCKS WERE DELETED HERE (2026-08-11, found by review). They built an env and
  // called a route and then asserted NOTHING — the response was never read, and the second one did not
  // even make the call. They dated from before the 0.3.0 split, when a non-portal mode existed: the
  // property they described ("a non-portal env must not serve the gated bundle") went away with
  // PORTAL_MODE and ALLOW_UNGATED_SERVICE_TOKEN, and the husks stayed behind reading as coverage for a
  // security property that no longer has a mode to be violated in.
  //
  // Deleted rather than given assertions, deliberately: writing a test for a mode this Worker no longer
  // has would be inventing coverage twice over. What replaces them is nothing, and that is the honest
  // state — the delivery gates that DO exist are covered by the [self-route] and [fence] blocks below.

  // ── Self bundle builder + primary fetch (Task 2, 2026-07-18) ──────────────────────
  {
    const prim = primaryJs(baseEnv);
    ok(prim.includes('/kit/self.js') && prim.includes('/kit/portal.js'), '[primary] fetches both self and admin bundles');
    ok(!prim.includes('"App"'), '[primary] still carries NO label after adding the self fetch');
    const allSelf = buildSelfBundle(selfFeaturePolicyKeys(), baseEnv);
    ok(allSelf.includes('appStatus:true') && allSelf.includes('devices:true') && allSelf.includes('resetPassword:true'), '[self] all me.* _AF on when allowed');
    ok(allSelf.includes('phones-panel-home') && allSelf.includes('/me/status') && allSelf.includes('softphone-panel-home'), '[self] home widget present (panel + /me/status + card class)');
    ok(allSelf.includes('"label":"App"'), '[self] self bundle carries the deployment label from RINGOTEL_LABEL (post-auth)');
    ok(allSelf.includes('"appBase":""'), '[self] appBase STRIPPED from the self bundle (KIT_SELF_BODY never uses it; not disclosed to every ns_t)');
    let sOk = true; try { new Script(allSelf); } catch { sOk = false; }
    ok(sOk, '[self] emitted self bundle compiles (String.raw kept regex backslashes)');
    const minSelf = buildSelfBundle(['me.appStatus'], baseEnv);
    ok(minSelf.includes('appStatus:true') && minSelf.includes('devices:false') && minSelf.includes('resetPassword:false'), '[self] appStatus-only tier: devices/reset off');
    const SELF_BRAND_PROBE = 'ZZ-SELF-BRAND-PROBE-4482';
    const brandedSelf = buildSelfBundle(selfFeaturePolicyKeys(), { RINGOTEL_LABEL: SELF_BRAND_PROBE });
    const neutralSelf = buildSelfBundle(selfFeaturePolicyKeys(), {});
    ok(brandedSelf.includes(SELF_BRAND_PROBE), '[self] a white-label value reaches the self bundle from env');
    ok(neutralSelf.includes('"label":"Ringotel"') && !neutralSelf.includes(SELF_BRAND_PROBE), '[self] neutral source (mirror-safe)');
    const adm = buildKitBundle(featurePolicyKeys(), baseEnv);
    ok(adm.includes('callflow:true') && adm.includes('resetPassword:true') && adm.includes('profileAppAccess:true') && !adm.includes('appStatus:'), '[admin] admin bundle carries the 8 admin flags incl. profileAppAccess, no me.* flag');
  }

  // ── Self entry + fence + /kit/self.js route (Task 3, 2026-07-18) ──────────────────
  {
    ok((await call('/kit/self.js')).status === 401, '[self-route] no bearer → 401');
    {
      const r = await call('/kit/self.js', basic); // Basic User: passes portal.self (all), fails portal.access
      ok(r.status === 200, '[self-route] Basic User → 200 (self tier admits them)');
      const body = await r.text();
      ok(body.includes('appStatus:true') && body.includes('devices:false') && body.includes('resetPassword:false'), '[self-route] Basic tier: appStatus on, off-defaults off');
      ok((r.headers.get('cache-control') || '').includes('private'), '[self-route] private cache');
    }
    ok((await call('/kit/self.js', reseller)).status === 200, '[self-route] reseller also gets the self bundle (own home widget)');
    // Fence: a self principal (Basic) is refused on every admin surface.
    ok((await call('/kit/portal.js', basic)).status === 403, '[fence] Basic → admin bundle 403 (unchanged)');
    ok((await call('/domains', basic)).status === 403, '[fence] Basic → /domains 403 (fenced)');
    ok((await call('/flow?domain=acme.example&kind=user&ref=100', basic)).status === 403, '[fence] Basic → /flow 403');
  }

  // ── Secondary manifest /kit/asset/<name>.js ─────────────────────────────────────────
  {
    const r = await call('/kit/asset/pub.js'); // public, no auth
    ok(r.status === 200, '[asset] public served no-auth → 200');
    ok((r.headers.get('cache-control') || '').includes('public'), '[asset] public → public cache');
  }
  ok((await call('/kit/asset/authed.js')).status === 401, '[asset] all level, no ns_t → 401');
  {
    const r = await call('/kit/asset/authed.js', basic); // any valid ns_t
    ok(r.status === 200, '[asset] all level, any valid ns_t → 200');
    ok((r.headers.get('cache-control') || '').includes('private') && (r.headers.get('vary') || '').includes('Authorization'), '[asset] gated → private + Vary');
  }
  ok((await call('/kit/asset/adm.js', basic)).status === 403, '[asset] office_manager level, Basic User → 403');
  ok((await call('/kit/asset/adm.js', realOM)).status === 200, '[asset] office_manager level, OM → 200');
  ok((await call('/kit/asset/sadm.js', realOM)).status === 403, '[asset] reseller level, OM (not reseller) → 403');
  ok((await call('/kit/asset/sadm.js', reseller)).status === 200, '[asset] reseller level, reseller → 200');
  ok((await call('/kit/asset/nope.js', reseller)).status === 404, '[asset] unknown name → 404');
  ok((await call('/kit/asset/ext.js', reseller)).status === 404, '[asset] url: entry not Worker-served → 404');

  // r2: entry but ASSETS binding absent → loud 500
  ok((await call('/kit/asset/pub.js', undefined, { ...baseEnv })).status === 500, '[asset] r2: entry with no ASSETS binding → 500 loud');

  // ── kitConfigError: loud 500 on bad static config ───────────────────────────────────
  ok((await call('/kit/portal.js', reseller, { ...env, PRIMARY_BASENAME: 'Bad Name!' })).status === 500, '[cfg] bad PRIMARY_BASENAME → 500');
  ok((await call('/kit/portal.js', reseller, { ...env, PORTAL_SECONDARIES: '{not json' })).status === 500, '[cfg] bad PORTAL_SECONDARIES → 500');
  // A secondary with an unknown/legacy auth level fails LOUD at config time (uniform pre-auth 500), not
  // per-request. `admin` was a dropped preset; it's now an unknown level.
  ok((await call('/kit/portal.js', reseller, { ...env, PORTAL_SECONDARIES: JSON.stringify([{ name: 'x', from: 'r2:x', auth: 'admin' }]) })).status === 500, '[cfg] secondary unknown/legacy auth level → 500');
  ok((await call('/kit/portal.js', undefined, { ...env, PORTAL_SECONDARIES: JSON.stringify([{ name: 'x', from: 'r2:x', auth: 'wizard' }]) })).status === 500, '[cfg] secondary unknown auth level → 500 pre-auth (no bearer)');
  ok((await call('/kit/portal.js', reseller, { ...env, PORTAL_HANDOFF_URL: 'http://insecure.example' })).status === 500, '[cfg] non-https PORTAL_HANDOFF_URL → 500');
  ok((await call('/kit/portal.js', reseller, { ...env, RINGOTEL_APP_BASE_URL: 'javascript:alert(1)' })).status === 500, '[cfg] non-https RINGOTEL_APP_BASE_URL → 500');
  ok(buildKitBundle(featurePolicyKeys(), { RINGOTEL_APP_BASE_URL: 'javascript:alert(1)' }).includes('"appBase":""'), '[neutral] buildKitBundle defensively drops a non-https appBase (no javascript: href)');

  // ── /health still works + reflects PORTAL_HANDOFF_URL signal under portal mode ──────
  {
    const configured = async (e: any) => (await (await call('/health', undefined, e)).json() as any).configured;
    ok((await configured(env)) === true, '[health] handoff set → configured:true');
    const { PORTAL_HANDOFF_URL: _drop, ...noHandoff } = env as any;
    ok((await configured(noHandoff)) === false, '[health] portal mode + handoff ABSENT → configured:false');
  }

  // ── health markers in the users column (Task 4, 2026-07-19) ────────────────────────
  {
    const src = buildKitBundle(featurePolicyKeys(), {});
    ok(src.indexOf('health') !== -1, '[kit] colFill reads the health field');
    ok(src.indexOf('broken') !== -1, '[kit] colFill distinguishes broken severity');
    ok(/var\s+_h\s*=/.test(src), '[kit] health marker uses a var (ES5 style, matches bundle)');
    new Script(src); // throws SyntaxError if the hand-written browser JS is malformed
    ok(true, '[kit] bundle with health markers still parses');
  }

  // ── the connection name / conflict warning reach the Users-column tooltip (Task 12 fix round) ──
  {
    const src = buildKitBundle(featurePolicyKeys(), {});
    ok(src.indexOf('s.connection') !== -1, '[kit] colFill reads the connection field');
    ok(src.indexOf('s.warning') !== -1, '[kit] colFill reads the warning field');
    // Pin the EXACT construct, not just substring presence: a conflict must be checked in the SAME
    // if/else-if as the connection name, warning branch FIRST — otherwise a later edit could show both,
    // or show the name and silently drop the warning. Also pins that a conflict is marked 'broken', the
    // same red the pre-existing health.severity==='broken' path already uses (one visual language for
    // "something is wrong here"), and that it does NOT reuse the health tooltip's ' · ' join blindly
    // without also being reachable when s.activated is false (no leading `&&s.activated` gate).
    const WARN_THEN_NAME = "if(s&&s.warning){ti=(ti?ti+' · ':'')+'connection conflict';st=st?st+' broken':'broken'}else if(s&&s.connection){ti=(ti?ti+' · ':'')+s.connection}";
    ok(src.includes(WARN_THEN_NAME), '[kit] colFill checks warning BEFORE connection, in one if/else-if (conflict outranks the name)');
    new Script(src);
    ok(true, '[kit] bundle with connection/warning markers still parses');
  }

  // ── Apps-menu rendering in the self bundle (Task 6, 2026-07-21) ─────────────────────
  {
    const b = buildSelfBundle(['me.appAccess', 'portal.self'], {} as any);
    ok(b.includes('app-menu-list'), '[kit] self bundle targets the Apps menu');
    // Whole-bundle substring checks on 'app-menu-list'/'stopPropagation' alone would stay green even
    // if the guard were moved BACK into the per-row builders (row()/link()) — the exact regression
    // this design guards against (a click's target is the nearest common ancestor of mousedown and
    // mouseup, so drag-selecting text and releasing outside a row resolves to the <ul>, above any
    // per-row listener — verified live on the production portal). Pin two properties instead:
    // 1) the exact <ul>-level guard string is present (including its anchor exception), and
    // 2) stopPropagation appears EXACTLY ONCE in this bundle. Moving it into row()/link() either
    // removes this exact string or raises the count, so either mutation fails.
    const UL_GUARD = "ul.addEventListener('click',function(e){if(!e.target.closest('a[href]'))e.stopPropagation()});";
    ok(b.includes(UL_GUARD), '[kit] click guard is on the <ul>, not per row');
    const stopPropCount = (b.match(/stopPropagation/g) || []).length;
    ok(stopPropCount === 1, '[kit] click guard is on the <ul>, not per row');
    // Assert the ABSENCE of branding without naming a brand — this file is published, so spelling the
    // white-label name here would be the very leak the assertion exists to prevent. With no
    // RINGOTEL_LABEL configured the bundle must carry the neutral vendor default and nothing else.
    ok(b.includes('"label":"Ringotel"'), '[kit] unbranded env ⇒ neutral default label, no white-label literal');
    let aaOk = true; try { new Function(b); } catch (e) { aaOk = false; }
    ok(aaOk, '[kit] self bundle with app-access still parses');
    // aaFetch must memoise the IN-FLIGHT PROMISE, not the resolved value — the old pattern
    // (`if(_aa){cb(_aa);return}` gated on a value only set inside the .then) let two callers arriving
    // before the first response each fire their own request. Pin both directions: the new dispatch
    // is present, and the old resolve-only-memo dispatch string is gone (a revert reintroduces it).
    ok(b.includes('_aaP'), '[kit] aaFetch memoises the in-flight promise (not just the resolved value)');
    ok(!b.includes('if(_aa){cb(_aa);return}'), '[kit] aaFetch memoises the in-flight promise (not just the resolved value)');
  }

  // ── Home-card sign-in details (Task 7, 2026-07-21) ──────────────────────────────
  {
    const b = buildSelfBundle(['me.appAccess', 'me.appStatus', 'portal.self'], {} as any);
    ok(b.includes('_svx_home'), '[kit] home card still built');
    // The sign-in verbiage now lives in ONE place — aaModel — so the menu, home card, and admin block
    // share it and cannot fork. The domain helper text (and each per-mode string) therefore appears
    // EXACTLY ONCE in the bundle. A revert that re-inlines the strings into a surface raises the count
    // and fails this; a surface that stops sourcing aaModel drops the aaModel reference below.
    ok((b.match(/The same for everyone in your organization\./g) || []).length === 1, '[kit] domain helper text lives once (aaModel), not forked per surface');
    ok((b.match(/Your portal password/g) || []).length === 1, '[kit] password verbiage lives once (aaModel)');
    // The password's location is a per-org setting; when the server could read it we say the true thing,
    // and when it could not we keep the hedge rather than assert either case.
    ok(b.includes('function pwHint(r)') && b.includes('r.hPIE===false') && b.includes('r.hPIE===true'),
      '[kit] the password hint branches on the org\'s reported setting');
    ok(b.includes('In the email itself, or behind the one-time link in it.'),
      '[kit] ...and still hedges when the setting is unknown');
    ok(b.includes('function aaModel(') && b.includes('function copyBtn(') && b.includes('function aaDownloads('), '[kit] shared sign-in helpers present');
    ok((b.match(/aaModel\(/g) || []).length >= 3, '[kit] both self surfaces (menu + home) source the shared aaModel (call + 2 uses)');
    ok(b.includes("b.title='Click to copy'"), '[kit] copy button carries a Click to copy tooltip');
    ok(b.includes('_KC.dl'), '[kit] downloads render from _KC.dl via aaDownloads');
    // Absence of branding, asserted without naming a brand — see the note above.
    ok(b.includes('"label":"Ringotel"'), '[kit] home card: unbranded env ⇒ neutral default label');
    let hcOk = true; try { new Function(b); } catch (e) { hcOk = false; }
    ok(hcOk, '[kit] self bundle with home-card sign-in details still parses');
  }

  // ── Menu config: static add/hide, independent of the sign-in surface (2026-07-22) ──
  {
    const b = buildSelfBundle(['me.menuConfig', 'portal.self'], {} as any);
    ok(b.includes('menuConfig:true') && b.includes('appAccess:false'), '[menus] menuConfig-only tier: menu flag on, sign-in flag off');
    ok(b.includes('!_AF.appAccess&&!_AF.menuConfig'), '[menus] the Apps menu runs when EITHER surface is enabled');
    // The internal guard is unreachable unless the DISPATCHER also admits menuConfig — asserting only the
    // guard string let a menus-only deployment silently do nothing while every test still passed.
    ok(b.includes('return !!_AF.appAccess||!!_AF.menuConfig'), '[menus] the dispatcher gate admits a menuConfig-only tier (not just the inner guard)');
    ok(b.includes('r.menus&&r.menus.apps'), '[menus] the client consumes the server-resolved per-menu plan');
    ok(b.includes('_svxadd'), '[menus] added entries carry a marker class (idempotency + identifiable)');
    ok(b.includes("a.rel='noopener noreferrer'") && b.includes('a.textContent=fillRaw('), '[menus] added anchors are noopener+noreferrer and set text via textContent (never innerHTML)');
    // {page} is the one variable the server cannot fill; the client substitutes the PATH only — never the
    // query, which can carry identifiers and this link may leave for a third party.
    ok(b.includes("split('{page}').join(pg)") && b.includes('encodeURIComponent(location.pathname)'),
      '[menus] {page} is filled client-side from the path only, percent-encoded');
    ok(!b.includes('location.search'), '[menus] the portal query string is never interpolated into an added link');
    // A label/title is read by a human; only the URL needs encoding.
    ok(b.includes('function fillRaw(') && b.includes('a.textContent=fillRaw('), '[menus] {page} renders as a plain path in label/title, encoded only in the href');
    // The Referer on an outbound click carries the full portal URL incl. its query — the very thing
    // {page} deliberately excludes. noreferrer closes that back door.
    ok(!/rel='noopener'/.test(b), '[menus] outbound links are noreferrer too, not just noopener');
    ok(b.includes('if(!_AF.appAccess||!r.present)return'), '[menus] the sign-in section stays gated on its own flag after menu work is applied');
    // The account dropdown has no id and shares a generic class, so it is found by CONTENT — Log Out is
    // the only entry present in every variant (My Account / Profile / Messages / vendor-injected items).
    ok(b.includes('function acctUl(') && b.includes('function accountMenu('), '[menus] the account dropdown is a supported target');
    ok(b.includes("u.id==='app-menu-list'"), '[menus] ...and never matches the Apps menu by mistake');
    ok(b.includes('svxacct'), '[menus] the account menu has its own idempotency guard');
    // A <ul>'s textContent concatenates children with NO separator, so a JS-injected neighbour ("Partner
    // Central") butts against the next item and any word-boundary test silently matches nothing. The
    // sign-out probe must therefore run PER ITEM, never against the <ul>'s own text.
    ok(b.includes('function hasSignOut(ul)') && b.includes('ul.children'), '[menus] sign-out is detected per item');
    // Either signal alone can appear on some other dropdown; together they identify the account menu.
    ok(b.includes('soOnly') && b.includes('a[href*="/portal/users/edit/profile/"]'),
      '[menus] a menu with BOTH sign-out and the profile link wins over sign-out alone');
    ok(!/log..s\*out..b\/i\.test\(ls\[i\]\.textContent/.test(b), '[menus] ...never against the concatenated <ul> text');
    ok(b.includes('divider'), '[menus] added account entries go above the divider + Log Out, not after them');
    // One add/hide implementation shared by both menus — a second copy is how two menus drift apart.
    // Counts the marker being ASSIGNED, not mentioned: menuReset reads it too, and a second reader is not
    // a second implementation. Pinning every occurrence made the guard fire on the reset being added.
    ok((b.match(/function menuApply\(/g) || []).length === 1
      && (b.match(/className='_svxadd'/g) || []).length === 1,
      '[menus] add/hide is implemented once and reused, not duplicated per menu');
    // And the reset is the only thing that undoes it, for the same reason.
    ok((b.match(/function menuReset\(/g) || []).length === 1,
      '[menus] and undone in exactly one place');
    // The Management dropdown is reseller-level nav with no id and a toggle carrying no href — the only
    // anchor is the toggle's own LABEL, read from the toggle itself (never a container, for the same
    // reason sign-out is tested per item).
    ok(b.includes('function mgmtUl(') && b.includes('function managementMenu('), '[menus] the Management dropdown is a supported target');
    ok(/a\.dropdown-toggle\[data-toggle="dropdown"\]/.test(b), '[menus] ...found via the dropdown toggle, not a positional selector');
    ok(b.includes('t.nextElementSibling') && b.includes("li.querySelector('ul.dropdown-menu')"),
      '[menus] ...accepting both Bootstrap shapes (menu after the toggle, or beside it in the same <li>)');
    ok(b.includes('svxmgmt'), '[menus] the Management menu has its own idempotency guard');
    // Appended, not inserted: this menu has no trailing sign-out to sit above.
    ok(/menuApply\(u,plan,null\)/.test(b), '[menus] Management entries are appended at the end');
    // Every menu surface is dispatched; a target the dispatcher never calls is a feature that silently
    // does nothing (exactly the H1 from the menus review).
    ok(/m:managementMenu,a:function\(\)\{return !!_AF\.menuConfig\}/.test(b), '[menus] managementMenu is actually dispatched, not just defined');
    let mOk = true; try { new Function(b); } catch (e) { mOk = false; }
    ok(mOk, '[menus] self bundle with menu config parses');
  }

  // ── Admin profile-page sign-in block (2026-07-21) ───────────────────────────────
  {
    const b = buildKitBundle(['ringotel.profileStatus', 'ringotel.profileAppAccess'], { RINGOTEL_LABEL: 'App' });
    ok(b.includes('_AF.profileAppAccess'), '[admin] sign-in block is gated on _AF.profileAppAccess');
    ok(b.includes("'User-visible '+AL"), '[admin] framing header interpolates the app label (never a literal)');
    ok(!b.includes('User-visible App sign-in'), '[admin] the label is NOT baked as a literal into the header (mirror-safe)');
    ok(b.includes('r.appAccess') && (b.match(/aaModel\(/g) || []).length >= 2, '[admin] block consumes r.appAccess via the shared aaModel');
    ok(b.includes('amdl.advisory'), '[admin] advisory modes render (admin sees why a user can\'t sign in)');
    let abOk = true; try { new Function(b); } catch (e) { abOk = false; }
    ok(abOk, '[admin] bundle with the sign-in block parses');
  }

  // ── connection name / conflict on the profile App Status panel (Task 12 fix round) ─────────────
  {
    const b = buildKitBundle(['ringotel.profileStatus', 'ringotel.profileAppAccess'], { RINGOTEL_LABEL: 'App' });
    ok(b.includes('r.status.connection') && b.includes('r.status.warning'), '[admin] App Status panel reads r.status.connection/warning (already on r.status via /rapp/user, no new fetch)');
    ok(b.includes('Connection conflict'), '[admin] a conflict gets its own explanatory line, not just the bare word');
    ok(b.includes("'Connection: '+r.status.connection"), '[admin] a clean single connection is named plainly');
    ok(/r\.status\.warning\?[^:]*:'Connection: '\+r\.status\.connection/.test(b), '[admin] the conflict line wins the ternary — never both a name and a warning shown at once');
    let pnOk = true; try { new Function(b); } catch (e) { pnOk = false; }
    ok(pnOk, '[admin] bundle with the profile connection line parses');
  }

  // ── Ringotel cache freshness (2026-07-27) ───────────────────────────────────────
  {
    const b = buildKitBundle(featurePolicyKeys(), { RINGOTEL_LABEL: 'App' });

    // The profile view reads FRESH on load. A change made anywhere else -- in the Ringotel admin, or by
    // the SSO worker provisioning a user on first login -- otherwise showed the pre-change state here
    // until the ~10-minute org-users cache expired, because our own writes are the only thing that
    // invalidates it.
    ok(/rapp\/user\?domain='\+encodeURIComponent\(d\)\+'&ext='\+encodeURIComponent\(ext\)\+'&fresh=1'\)\.then\(function\(r\)\{_actSched=false/.test(b),
      '[fresh] the profile section requests fresh=1 ON LOAD, not only after a write it made');
    // ...and does NOT say poll=1, which is what preserves the eligibility + app-access reads that render
    // the Force button and the sign-in panel. Collapsing these two into one flag is the trap.
    ok(!/&fresh=1&poll=1'\)\.then\(function\(r\)\{_actSched=false/.test(b),
      '[fresh] the profile LOAD is not marked as a poll (so it keeps eligibility + appAccess)');
    ok(b.includes("'&fresh=1&poll=1'"), '[fresh] the post-write repeat poll IS marked poll=1, so it stays cheap');

    // The bulk users list stays cached on purpose: always-fresh would put a getUsers on every page view
    // of a large domain. It shows its age instead.
    ok(/jget\('\/rapp\/users\?domain='\+encodeURIComponent\(d\)\+\(force\?'&refresh=1':''\)\)/.test(b),
      '[fresh] the users-list route is NOT fetched fresh by default — only when the operator forces it');
    // These bytes reach a browser. The refresh capability is spelled NEUTRALLY on the wire for the same
    // reason the routes are /rapp/* and the org flag is hPIE — a white-labeled deployment's admins read
    // this in devtools, and the served bundle carried no vendor name at all before this feature.
    ok(!/ringotel/i.test(b), '[fresh] the served bundle still contains NO vendor name anywhere');
    ok(b.includes('function ageTxt(') && b.includes('function uAgeNow('), '[fresh] the users column renders a human age for its cached data');
    ok(b.includes('if(!_AF.refresh)'), '[fresh] the refresh control is gated on the same key the route enforces');
    ok(b.includes('colFresh(th)'), '[fresh] the age/refresh affordance is applied on every column render, not just on creation');

    // A bundle for a caller WITHOUT ringotel.refresh still contains the code (the body is one shared
    // asset) but flags it off -- the server is the gate, the flag only decides whether to draw it.
    const noRefresh = buildKitBundle(featurePolicyKeys().filter((k) => k !== 'ringotel.refresh'), {});
    ok(noRefresh.includes('refresh:false'), '[fresh] a caller without ringotel.refresh gets _AF.refresh=false');
    ok(b.includes('refresh:true'), '[fresh] a caller with ringotel.refresh gets _AF.refresh=true');

    // The portal's own table-reload button doubles as our refresh. This is the ONLY refresh path that
    // reaches a domain with no org yet, because the column-header control is drawn inside a column that
    // such a domain does not have.
    ok(b.includes("closest('#pageRefresh')"), '[pgrefresh] the portal’s own table-reload button is hooked');
    ok(/document\.addEventListener\('click',function\(e\)\{[\s\S]{0,200}?closest\('#pageRefresh'\)/.test(b) && /\},true\);/.test(b),
      '[pgrefresh] hooked by delegation in the CAPTURE phase, so the button being re-created cannot orphan it');
    ok(/jget\('\/rapp\/orgs'\+\(force\?'\?refresh=1':''\)\)/.test(b),
      '[pgrefresh] a forced domains-list read asks the server to re-dig the directory');
    ok(b.includes('uFetch(_uDom,true)'),
      '[pgrefresh] the users page reuses the column control’s own forced fetch — one intent, one code path');
    ok(b.includes('function rtClear('), '[pgrefresh] a forced read drops the stale cells, so new data actually repaints');
    ok(/\.catch\(function\(\)\{if\(!_rtMap\)_rtMap=\{\}\}\)/.test(b),
      '[pgrefresh] a failed FORCED read keeps the last good map instead of blanking every domain to –');

    let fOk = true; try { new Function(b); } catch (e) { fOk = false; }
    ok(fOk, '[fresh] bundle with the freshness control parses');
  }

  // ── the SPK bundle (2026-08-07) ──────────────────────────────────────────────────
  {
    const env = { RINGOTEL_LABEL: 'App', PORTAL_MODE: '1' };
    const js = buildSpkBundle(['kit.status'], env as any);
    ok(js.includes('Super Portal Kit'), '[spk] the bundle carries the menu label');
    // PREPEND, not append. Position must not depend on which bundle's fetch resolves first —
    // managementMenu() (self bundle, PORTAL_MENUS additions) appends to the same <ul>, and appending
    // here made the entry move between reloads. Observed live 2026-08-08.
    // Scoped to spkMenu's own body: KIT_COMMON's menuApply legitimately appends, so asserting over the
    // whole bundle matches the wrong function — which is exactly how a green assertion proves nothing.
    const spkMenuBody = /function spkMenu\(\)\{[\s\S]*?\n\}/.exec(js)?.[0] ?? '';
    ok(spkMenuBody.length > 0, '[spk] spkMenu is present in the bundle');
    ok(/ul\.insertBefore\(li,\s*ul\.firstChild\)/.test(spkMenuBody), '[spk] the menu entry is PREPENDED, so its position is deterministic');
    ok(!/ul\.appendChild\(li\)/.test(spkMenuBody), '[spk] and never appended — appending raced managementMenu for position');
    ok(/fontWeight\s*=\s*'600'/.test(spkMenuBody), '[spk] the entry is bold — an operator tool among per-customer entries');
    ok(js.includes('function mgmtUl('), '[spk] it carries the SHARED Management-menu anchor, not a copy');
    ok((js.match(/function mgmtUl\(/g) || []).length === 1, '[spk] exactly one definition of the anchor');
    ok(js.includes('/kit/status'), '[spk] it fetches the console document');
    ok(js.includes(`${SPK_BRIDGE.tag}:'${SPK_BRIDGE.response}'`), '[spk] it posts results under the shared bridge protocol');
    ok(js.includes(`${SPK_BRIDGE.dataKey}:(r&&r.probes)||[]`), '[spk] carrying the probe list under the protocol\'s data key');
    ok(js.includes(`${SPK_BRIDGE.errorKey}:1`), '[spk] and signals a failed run explicitly rather than posting an empty list');
    ok(js.includes('box('), '[spk] it opens the shared modal');
    ok(!js.includes('profileActivation'), '[spk] it does NOT carry admin feature code');
    ok(!js.includes('homeStatus'), '[spk] it does NOT carry self feature code');

    let sOk = true; try { new Function(js); } catch (e) { sOk = false; }
    ok(sOk, '[spk] bundle parses');

    // Denied ⇒ inert bytes. The route should 403 before this, but the body must not act on its own.
    const denied = buildSpkBundle([], env as any);
    ok(/status:false/.test(denied), '[spk] with the key denied the flag is false');

    // F4: the console bundle must be buildable while PORTAL_APP_DOWNLOADS is malformed. wrapBundle calls
    // parseDownloads, which THROWS — and /kit/spk.js is served ahead of the validator that would have caught
    // it, so a throw here costs the operator the menu entry to the page that names the broken setting. The
    // SPK body never reads _KC.dl, so the value is stripped in the same spread that strips the app base URL.
    {
      const brokenDl = { ...env, PORTAL_APP_DOWNLOADS: '{not json' };
      let threw: unknown;
      let out = '';
      try { out = buildSpkBundle(['kit.status'], brokenDl as any); } catch (e) { threw = e; }
      ok(!threw, `[spk] a malformed PORTAL_APP_DOWNLOADS does not break the console bundle${threw ? ` (threw: ${(threw as Error).message})` : ''}`);
      ok(out.includes('"dl":[]'), '[spk] the download list is simply absent from _KC, not half-parsed');
      ok(!out.includes('not json'), '[spk] and the broken value never reaches the served bytes');
      // The ADMIN and SELF bundles DO use _KC.dl, and both are served behind the validator — so they must
      // still fail loudly rather than quietly shipping an empty list.
      let adminThrew = false;
      try { buildKitBundle(['callflow.view'], brokenDl as any); } catch { adminThrew = true; }
      ok(adminThrew, '[spk] while the admin bundle (which DOES use the download list) still fails loudly');
    }

    // The admin bundle must still work after box() moved to KIT_COMMON. Note: mgmtUl() moved from
    // KIT_SELF_BODY, NOT KIT_ADMIN_BODY as an earlier draft of this brief assumed (verified against
    // the actual source: managementMenu/mgmtUl live only in KIT_SELF_BODY — buildKitBundle's own
    // gated features never touch the Management menu) — so the admin bundle carries mgmtUl's
    // definition (from the now-shared KIT_COMMON) but never calls it, and the "still resolves"
    // half of that check belongs on the self bundle below, where the caller actually lives.
    const admin = buildKitBundle(['callflow.view'], env as any);
    ok(admin.includes('box('), '[spk] the admin bundle still has box()');
    ok((admin.match(/function box\(/g) || []).length === 1, '[spk] and exactly one definition of it');
    ok((admin.match(/function mgmtUl\(/g) || []).length === 1, '[spk] and exactly one definition of mgmtUl (unused here, defined once via KIT_COMMON)');

    // The self bundle is where managementMenu() actually lives and calls mgmtUl() — confirm it still
    // resolves now that mgmtUl() is defined in the shared KIT_COMMON rather than inline in KIT_SELF_BODY.
    const self = buildSelfBundle(selfFeaturePolicyKeys(), env as any);
    ok((self.match(/function mgmtUl\(/g) || []).length === 1, '[spk] the self bundle also carries exactly one mgmtUl');
    ok(self.includes('managementMenu'), '[spk] managementMenu stayed in the self body and still resolves the shared mgmtUl');
  }

  // ── the modal's iframe has an accessible name ──────────────────────────────────
  // It had none, so assistive tech announced every one of these as just "frame". `box()` already takes the
  // title as its first argument, so this is one property — and it fixes every modal the kit opens (the
  // call-flow diagrams included), not only the integration console.
  {
    const b = buildKitBundle(['callflow.view'], { PORTAL_HANDOFF_URL: '' } as any);
    ok(/f\.sandbox=/.test(b), '[a11y] the modal iframe is still sandboxed');
    ok(/f\.title=t;/.test(b), '[a11y] and carries the modal title as its accessible name');
    // Both must be set BEFORE srcdoc: assigning srcdoc first starts the load, and a frame that begins
    // loading unsandboxed is a security bug rather than an accessibility one.
    const i = b.indexOf('f.srcdoc=');
    ok(i > -1 && b.indexOf('f.title=t;') < i && b.indexOf('f.sandbox=') < i,
      '[a11y] both are set before srcdoc, so the document never begins loading unnamed or unsandboxed');
  }

  // ── delivery is DECLARED, and the bundle's flag list has to agree with it ────────────────────────────
  // The contract the `deliveredBy` refactor buys: a feature declares which bundle carries it, and the
  // hand-written flag↔key list for that bundle must be exactly the keys that declare it. Membership is
  // checkable; the short `flag` names are not derivable (`resetPassword` means two different keys in the
  // two bundles), which is why the list stays written down and this assertion exists instead.
  {
    const selfKeys = SELF_FEATURE_KEYS.map((f) => f.key).sort();
    const declaredSelf = keysDeliveredBy('self').sort();
    ok(JSON.stringify(selfKeys) === JSON.stringify(declaredSelf),
      `[delivery] the self bundle's flag list is exactly the keys declaring deliveredBy self (list: ${selfKeys.join(',')} | registry: ${declaredSelf.join(',')})`);

    const spkKeys = SPK_FEATURE_KEYS.map((f) => f.key).sort();
    ok(JSON.stringify(spkKeys) === JSON.stringify(keysDeliveredBy('console').sort()),
      '[delivery] and the console bundle\'s list is exactly the keys declaring console');

    // The admin bundle is a SUBSET, not an equality: `ringotel.prepop` is gated by the registry and enforced
    // on its route, but has no `_AF` flag because nothing in the bundle self-hides on it. Asserting equality
    // here would be asserting a fact that is false, so assert the one that is true — no flag may name a key
    // the admin bundle does not carry.
    const strays = FEATURE_KEYS.map((f) => f.key).filter((k) => !keysDeliveredBy('access').includes(k));
    ok(strays.length === 0, `[delivery] no admin flag names a key delivered by another bundle${strays.length ? ` (${strays.join(', ')})` : ''}`);
  }

  // ── the footer version line (portal.versionLine) ─────────────────────────────────────────────────────
  {
    const env = { BRAND_NAME: 'Acme Voice', PORTAL_HANDOFF_URL: '' } as any;
    const on = buildSelfBundle(selfFeaturePolicyKeys(), env);
    ok(/versionLine:true/.test(on), '[verline] the flag is on when the key is allowed');
    ok(/"vl":\{/.test(on), '[verline] and the version config rides the bundle');
    ok(on.includes('Acme Voice Portal Kit'), '[verline] carrying the branded product name');
    ok(on.includes(`"ver":"${VERSION}"`), '[verline] and the running version');
    ok(/getElementById\('footer'\)/.test(on), '[verline] rendered into the portal footer');
    // Joined onto the VERSION ROW — identified by carrying a version pair, not by being last. "Last
    // paragraph" produced a duplicate in production: a vendor add-on appends its version row async, so that
    // rule resolved to the Powered-by line or the version row depending purely on load order.
    ok(/host\.appendChild\(sp\)/.test(on) && /\\d\+\\\.\\d\+/.test(on),
      '[verline] joined onto the row that carries a version, not merely the last paragraph');
    ok(!/ps\[ps\.length-1\]/.test(on), '[verline] and no longer keys off position at all');
    // One entry on the page, whatever produced a stray. Self-healing beats a guard that can only ever
    // decline to add a second — that guard was present when the duplicate appeared.
    ok(/querySelectorAll\('\._svxver'\)/.test(on) && /removeChild\(old\[k\]\)/.test(on),
      '[verline] removing any stray copy rather than only declining to add one');
    // No version row yet means WAIT. Landing in the Powered-by line is what stranded it there.
    ok(/if\(!host\)return;/.test(on), '[verline] and waits for the row rather than settling for another');
    // Asserted as the ESCAPE, not the character: a literal in the served bytes decodes correctly only if
    // the charset says so, and a mock server without one rendered it as mojibake. An escape cannot be
    // garbled by a response header, a proxy, or the host page's own encoding.
    ok(on.includes("createTextNode('\\u00a0|\\u00a0')"),
      '[verline] with the platform\'s own separator byte for byte — NBSP, pipe, NBSP');
    // This assertion used to read `includes('\u2502')`, and it kept passing after the separator changed:
    // the box-drawing escape still appears in the fossil-cleaner's regex, which matches BOTH separators on
    // purpose. A presence check that any other line can satisfy is not a check. Anchor it to the call.
    ok(!/createTextNode\('\\u2502'\)|createTextNode\(' \\u2502 '\)/.test(on),
      '[verline] and no longer emits the box-drawing bar as the separator');
    // The reported "duplicate" was one live entry plus a FOSSIL: the vendor rebuilds the row from its
    // textContent, which inlines our words into its own anchor and destroys our span, leaving text with no
    // class for the dedupe to find. Cleaning runs BEFORE the host election, because a fossil carries a
    // version pair and would otherwise let a row that only looks like a version row win.
    ok(/function vlFossil\(/.test(on) && on.indexOf('vlFossil(f,') < on.indexOf('getElementsByTagName(\'p\')'),
      '[verline] clears a fossil of its own entry, before choosing which row to write to');
    ok(/_svxver/.test(on) && /own=true/.test(on),
      '[verline] and never strips the live entry while doing it');
    // The separator is styled FROM THE PAGE, not from pinned values. Ours sits inside the version row and
    // inherited its 10px grey while the portal's own separator is a sibling at 13px near-black -- two pipes
    // a few characters apart, visibly different. Copying the operator's own values is the only version that
    // does not bake one deployment's theme into a kit that ships to others.
    ok(/if\(cs\)\{bar\.style\.color=cs\.color;bar\.style\.fontSize=cs\.fontSize\}/.test(on),
      '[verline] separator takes its colour and size from the portal\'s own separator');
    // No pinned COLOUR anywhere: that is the value that goes wrong on a portal themed unlike the stock one.
    ok(!/#[0-9a-f]{3,6}|rgb\(/i.test(on.slice(on.indexOf('function verLine'), on.indexOf('var F=['))),
      '[verline] and pins no colour of its own, on any path');
    // NO VENDOR ADD-ON, STILL WORKS. Without it the footer is the platform's own version paragraph and
    // there is no separator span to copy from: the loop simply finds nothing, the entry still appends with
    // inherited styling, and there is no second pipe for it to clash with anyway. The append must therefore
    // sit OUTSIDE the search -- a style lookup that could skip the entry would trade a cosmetic mismatch
    // for a missing version line on every portal without the add-on.
    ok(/sp\.appendChild\(bar\);sp\.appendChild\(inner\);host\.appendChild\(sp\)/.test(on),
      '[verline] appends unconditionally, so a portal with no vendor add-on still gets the line');
    ok(/var par=host\.parentNode,kids=par\?par\.children:null,ref=null;/.test(on),
      '[verline] and tolerates a version row with no parent at all');
    // With no separator on the page there is nothing to copy, and inheriting the row rendered a 10px pipe
    // beside our own 13px link. The fallback is the observed stock appearance instead. Pinned values are a
    // LAST resort by construction -- a separator found on the page always wins.
    // RELATIVE, not pixels: the stock separator is 1.3x its row, and a ratio tracks whatever base size the
    // operator's footer uses. Pinned pixels would assume ours.
    ok(/var BAR_SCALE='130%';/.test(on) && /else\{bar\.style\.fontSize=BAR_SCALE\}/.test(on),
      '[verline] with none to copy, scales the pipe relatively rather than pinning a pixel size');
    ok(!/BAR_SCALE/.test(on.slice(on.indexOf('if(cs)'), on.indexOf('if(cs)')+40)),
      '[verline] and a separator that IS on the page still wins over the fallback');
    // Located structurally. Keying off the vendor container's id would couple this to one add-on.
    ok(/tagName==='SPAN'/.test(on) && !/release-notes/.test(on),
      '[verline] finding that separator by shape rather than by the vendor container name');
    // The footer outlives the 8s observer. Only verLine re-runs: it is idempotent, the menus are not.
    ok(/if\(_AF\.versionLine\)verLine\(\)/.test(on),
      '[verline] re-checked on late passes that outlive the mutation observer');
    // The old fallback (make our own paragraph when none matched) is GONE on purpose: it is what put the
    // entry in the wrong place and left it there. Absent beats misplaced for a version string.
    ok(!/f\.appendChild\(np\)/.test(on), '[verline] with no fallback that strands it in the wrong paragraph');
    ok(/_isRes\(\)/.test(on), '[verline] and the link is gated on the reader\'s own scope');

    // NOT in the bytes at all for a tier that does not carry the feature. Same rule as appBase: a bundle
    // should not ship config it will never read, and the product name carries BRAND_NAME.
    const off = buildSelfBundle(selfFeaturePolicyKeys().filter((k) => k !== 'portal.versionLine'), env);
    ok(/versionLine:false/.test(off), '[verline] the flag is off when the key is not allowed');
    ok(!/"vl":/.test(off), '[verline] and the version config is absent from those bytes entirely');
    ok(!off.includes('Acme Voice'), '[verline] so BRAND_NAME does not ride a bundle that cannot use it');

    // Present-but-empty PORTAL_RELEASE_NOTES_URL ⇒ no URL to link to, at any scope. The body reads '' as
    // "text only", so the anchor is never constructed rather than being built and hidden.
    const noLink = buildSelfBundle(selfFeaturePolicyKeys(), { ...env, PORTAL_RELEASE_NOTES_URL: '' });
    ok(/"url":""/.test(noLink), '[verline] an empty release-notes setting ships an empty url');
    ok(/"vl":\{/.test(noLink), '[verline] while the name and version still ship');

    // The admin bundle has no version line, so it must not carry its config either.
    ok(!/"vl":/.test(buildKitBundle(featurePolicyKeys(), env)), '[verline] the admin bundle carries none of this');
  }

  // ── hides run BEFORE adds, and that order is the contract ───────────────────────────────────────────
  // A hide names a STOCK entry. Applying hides to the menu as the portal shipped it — before any of this
  // config's own entries exist — is what keeps the two lists independent: a hide can never remove one of
  // your own additions, and neither list's meaning depends on the other. Today it holds because of the
  // order of two statements in one function, which is exactly the kind of property a tidy-up silently
  // inverts, so assert it rather than trust it.
  {
    const b = buildSelfBundle(selfFeaturePolicyKeys(), { PORTAL_HANDOFF_URL: '' } as any);
    const body = b.slice(b.indexOf('function menuApply'));
    const hideAt = body.indexOf('menuHide(ul,plan)');
    const addAt = body.indexOf('var add=(plan&&plan.add)');
    ok(hideAt > -1 && addAt > -1 && hideAt < addAt,
      `[order] menuApply hides before it adds (hide@${hideAt}, add@${addAt})`);
    // ── item 37: hides re-run, adds do not ────────────────────────────────────────────────────────────
    // The bug this replaced was one guard covering both halves, so an entry appended by anything after our
    // single pass was never hidden. The tests here can only read the emitted SOURCE — DOM behaviour is not
    // observable from them — so they assert the two structural facts the fix rests on: the hide pass is
    // registered like any other repeating feature, and it survives the observer disconnect.
    ok(/\{p:\/\^\\\/\/,m:menuHides,/.test(b), '[item37] the hide pass is in the feature registry, so it runs on every pass');
    ok(/menuHides\(\)/.test(b.slice(b.indexOf('var VLT='))), '[item37] and on the late timers, past the 8s observer disconnect');
    // The adds keep their one-shot guards — the whole point of splitting them.
    for (const flag of ['svxacct', 'svxmgmt']) {
      ok(b.includes(`dataset.${flag}='1'`), `[item37] the ${flag} add pass is still one-shot`);
    }
    // And the hide pass never reaches a menu the add pass could not: same gate, per menu.
    const hides = b.slice(b.indexOf('function menuHides'), b.indexOf('function accountMenu'));
    ok(/if\(_AF\.menuConfig\)\{var a=acctUl\(\)/.test(hides) && /_AF\.appAccess\|\|_AF\.menuConfig\)\{var p=appsUl\(\)/.test(hides),
      '[item37] gated per menu exactly as the add pass is');

    // The claim the whole fix rests on is BEHAVIOURAL — "running a hide twice is running it once, and a
    // late entry gets hidden by the next pass" — and a source grep cannot see it. Both prior menu
    // regressions passed every test in this file for exactly that reason. So run the real emitted
    // menuHide against a menu stub small enough to be obviously honest: children with a queryable <a> and
    // a style object, which is the entire surface the function touches.
    const menuHideSrc = b.slice(b.indexOf('function labelText('), b.indexOf('function menuApply('));
    const menuHide = runInNewContext(`${menuHideSrc}; menuHide`, {}) as (ul: unknown, plan: unknown) => void;
    // `anchor` is what the row's <a> says; `text` is the row's own, which can differ ("Messages" inside a
    // row reading "Messages 0") or be all there is (a vendor row with no anchor at all).
    const entry = (label: string, className = '', anchor: string | null = label) => {
      // Attributes are real here because menuHide now RECORDS what it hid — the marker menuReset reads
      // to tell a row this config hid from one the portal had hidden all along. A stub that answered
      // hasAttribute() with a constant would make the reset test meaningless.
      const attrs: Record<string, string> = {};
      return {
        className,
        style: { display: '' },
        textContent: label,
        parentNode: null as unknown,
        setAttribute: (k: string, v: string) => { attrs[k] = String(v); },
        getAttribute: (k: string) => (k in attrs ? attrs[k]! : null),
        hasAttribute: (k: string) => k in attrs,
        removeAttribute: (k: string) => { delete attrs[k]; },
        querySelector: (sel: string) => (sel === 'a' && anchor !== null ? { textContent: anchor } : null),
      };
    };
    const stock = entry('Voicemail'), keep = entry('Call History'), late = entry(' voicemail ');
    const ul = { children: [stock, keep] as ReturnType<typeof entry>[] };
    const plan = { hide: ['Voicemail'], add: [] };

    menuHide(ul, plan);
    ok(stock.style.display === 'none' && keep.style.display === '', '[item37] a hide matches by label and leaves the rest alone');
    menuHide(ul, plan);
    ok(stock.style.display === 'none' && keep.style.display === '', '[item37] and running it a second time changes nothing');

    // The bug, reproduced: an entry appended after the first pass. Under the old one-shot guard nothing
    // ran again and this stayed visible until reload.
    ul.children.push(late);
    ok(late.style.display === '', '[item37] a late-arriving entry starts visible');
    menuHide(ul, plan);
    ok(late.style.display === 'none', '[item37] and the next pass hides it — case-insensitively, trimmed');

    // The regression the re-run creates if nothing guards it: hiding the portal's "Voicemail" and adding
    // your own entry with that label is a legitimate config. The old single pass hid before it added, so
    // ours did not exist yet; a repeating pass would find it and hide the operator's own entry on the
    // second run. This is that case, and it must survive every pass.
    const ours = entry('Voicemail', '_svxadd');
    ul.children.push(ours);
    menuHide(ul, plan);
    menuHide(ul, plan);
    ok(ours.style.display === '', '[item37] and it never hides an entry the kit itself added');

    // ── anchorless rows (David's live capture, 2026-08-09) ────────────────────────────────────────────
    // A vendor Management menu renders rows as plain list items with no <a> inside. Both the reader and
    // the hider keyed on the anchor, so those entries were invisible to the builder AND unhidable by
    // config — the operator could not even find out why. Now the row's own text is the fallback.
    const anchorless = entry('Add-on Report', 'admin-menu-list-item', null);
    ul.children.push(anchorless);
    menuHide(ul, { hide: ['Add-on Report'], add: [] });
    ok(anchorless.style.display === 'none', '[anchorless] a row with no <a> can be hidden by its own text');

    // ...without breaking the case existing configs were written against: where a row carries MORE text
    // than its link does, the anchor's text is what a hide names, and it must keep matching.
    const badged = entry('Messages 0', '', 'Messages');
    ul.children.push(badged);
    menuHide(ul, { hide: ['Messages'], add: [] });
    ok(badged.style.display === 'none', '[anchorless] and the anchor text still matches where there is one');

    // ── an unread counter INSIDE the anchor (this portal does exactly that) ───────────────────────────
    // The row's text is "Messages 0", so that is what the console offered to hide — and a config naming
    // it stops matching at one message. An identity that carries live data is not an identity.
    const badgeAttrs: Record<string, string> = {};
    const withBadge = {
      className: '',
      style: { display: '' },
      textContent: 'Messages 0',
      setAttribute: (k: string, v: string) => { badgeAttrs[k] = String(v); },
      getAttribute: (k: string) => (k in badgeAttrs ? badgeAttrs[k]! : null),
      hasAttribute: (k: string) => k in badgeAttrs,
      removeAttribute: (k: string) => { delete badgeAttrs[k]; },
      cloneNode: () => ({
        textContent: 'Messages 0',
        querySelectorAll: () => [{ parentNode: { removeChild: () => {} } }],
      }),
      querySelector: (sel: string) => (sel === 'a' ? {
        textContent: 'Messages 0',
        // The clone the reader takes: badge removed, so the text settles to "Messages".
        cloneNode: () => ({ textContent: 'Messages', querySelectorAll: () => [] }),
      } : null),
    };
    ul.children.push(withBadge as never);
    menuHide(ul, { hide: ['Messages'], add: [] });
    ok(withBadge.style.display === 'none',
      '[badge] a counter inside the anchor is stripped, so the stable name is what matches');

    // ── menuReset: undo OUR effect, and only ours ─────────────────────────────────────────────────────
    // The preview needs it, and the preview is why it has to be exact: applying a draft plan on top of
    // the live one does not produce the draft. menuApply de-duplicates within one call only, so shared
    // entries would draw twice; menuHide never un-hides, so a removal would be invisible. Reset, then
    // apply. What makes running this on a live page safe is that it can tell its own work apart from the
    // portal's — so that is what these assert.
    const menuResetSrc = b.slice(b.indexOf('function menuReset('), b.indexOf('function menuApply('));
    if (!menuResetSrc || menuResetSrc.length > 1200) throw new Error('could not slice menuReset — the guard is broken, not the code');
    const menuReset = runInNewContext(`${menuResetSrc}; menuReset`, {}) as (ul: unknown) => void;
    {
      const ours = entry('Voicemail');
      const theirs = entry('Billing');
      const already = entry('Hidden By Portal');
      already.style.display = 'none';                 // inline-hidden before we ever ran
      const inline = entry('Odd');
      inline.style.display = 'inline-block';          // a row with its own inline display
      const added = entry('Our Entry', '_svxadd');
      const menu = { children: [ours, theirs, already, inline, added] as ReturnType<typeof entry>[] };
      (added as { parentNode: unknown }).parentNode = {
        removeChild: (c: unknown) => { menu.children = menu.children.filter((x) => x !== c); },
      };

      menuHide(menu, { hide: ['Voicemail', 'Hidden By Portal', 'Odd'], add: [] });
      ok(ours.style.display === 'none' && already.style.display === 'none' && inline.style.display === 'none',
        '[reset] all three are hidden by the plan');
      ok(already.getAttribute('data-svxh') === null,
        '[reset] but a row ALREADY inline-hidden is not marked — we did not hide it, so it is not ours to reveal');
      ok(inline.getAttribute('data-svxh') === 'inline-block',
        '[reset] and the marker records the PRIOR display, so the restore is exact rather than a guess at the default');

      menuReset(menu);
      ok(ours.style.display === '' && inline.style.display === 'inline-block',
        '[reset] our hides come back, each to what it was');
      ok(already.style.display === 'none',
        '[reset] and the portal\'s own hidden row stays hidden — the property that makes this safe on a live page');
      ok(theirs.style.display === '' && menu.children.indexOf(theirs) >= 0,
        '[reset] a row nobody touched is untouched');
      ok(menu.children.indexOf(added) < 0, '[reset] and rows we added are removed');
      ok(ours.getAttribute('data-svxh') === null, '[reset] the marker is cleared, so a second reset is a no-op');

      // IDEMPOTENT, because a preview redraw will run it again. A second pass must not reveal the
      // portal's own hidden row, which is the one way this could damage a live page.
      menuReset(menu);
      ok(already.style.display === 'none' && ours.style.display === '',
        '[reset] running it twice changes nothing further');

      // And re-hiding after a reset still works: the marker having been cleared must not make the row
      // unhideable, or one preview would permanently disarm the live config on that page.
      menuHide(menu, { hide: ['Voicemail'], add: [] });
      ok(ours.style.display === 'none' && ours.getAttribute('data-svxh') === '',
        '[reset] and a row can be hidden again afterwards, marker and all');
    }

    // A menu whose plan has not arrived yet must be a no-op, not a throw: menuHides runs on every mutation
    // from the first one, which is long before /me/app-access answers.
    let nullOk = true;
    try { menuHide(ul, null); } catch { nullOk = false; }
    ok(nullOk, '[item37] and a pass before the plan arrives does nothing rather than throwing');
  }

  // ── the capture BUTTON sits where the operator already is, and only when armed ───────────────────────
// David: "Masq, capture, exit masq is not much harder than wait-exit and is under operator control."
// The bar region exists only while masquerading, so a control there cannot appear where it would be
// nonsense — and the account-menu entry stops being a Management-with-fallback pretence and becomes the
// genuine fallback for a portal whose bar we cannot find.
{
  const cap = buildSpkBundle(['kit.captureMenus'], { PORTAL_HANDOFF_URL: '' } as any);

  ok(/function masqBar\(\)/.test(cap) && cap.includes("querySelector('.mask-bar')")
    && cap.includes('endMasquerade'),
    '[capbtn] the bar is found by the handles masq() already knew, not by a third invention');
  ok(!/mask-bar[^\n]*\.style/.test(cap),
    '[capbtn] and the button is OUR element, never a restyle of theirs');
  // ⚠️ IT BORROWS THEIR SHAPE. Styled from scratch it sat beside theirs at a different height with a
  // different baseline (David's second screenshot) and read as broken rather than as ours. Same tag as
  // the neighbour — an <a> styled as a button will not take a <button>'s CSS — plus their classes, then
  // colour on top. Agreeing to look like their control is the opposite of repainting it.
  ok(/end&&end\.tagName==='A'/.test(cap) && /b\.className='_svxcap'\+\(\(end&&end\.className\)/.test(cap),
    '[capbtn] taking the neighbour\'s tag and classes so the box geometry is theirs');
  // Scoped to capBtn: `b` is a common local name in this bundle (the copy button, the modal box) and an
  // unscoped search for it found theirs, not ours — a guard that tests the wrong function.
  const capBtnFn = cap.slice(cap.indexOf('function capBtn()'), cap.indexOf('function capDo('));
  ok(capBtnFn.length > 200 && capBtnFn.length < 2000, '[capbtn] (sliced the right function)');
  // ⚠️ NO STYLING OF OUR OWN BEYOND SPACING. Three attempts: from scratch it sat at a different height;
  // with their classes but repainted purple it read worse, because their class carries padding, weight,
  // radius and often a gradient, and a flat override lands on top of all of it. The bar is already
  // unmistakable and the label names the role — that is the distinction, and it does not need a second.
  ok(!/style\.cssText=/.test(capBtnFn) && !/style\.background=/.test(capBtnFn)
    && !/style\.color=/.test(capBtnFn) && !/style\.borderColor=/.test(capBtnFn),
    '[capbtn] and no colour, padding, height or font of our own to disagree with their stylesheet');
  ok(/b\.style\.marginRight=/.test(capBtnFn),
    '[capbtn] only the spacing that keeps it off the control beside it');
  // ⚠️ BESIDE the End Masquerade control, not appended to the bar. Appending put it on a second line
  // under the bar (David's screenshot): the bar is a block whose contents are one inline row, so an
  // appended child starts a new one. Being next to that control is also the point of the placement.
  ok(/function masqEnd\(\)/.test(cap) && /bar\.insertBefore\(b,end\)/.test(cap),
    '[capbtn] and it is inserted before End Masquerade, in that control\'s own row');
  ok(/end&&end\.parentNode===bar/.test(cap) && /else bar\.appendChild\(b\)/.test(cap),
    '[capbtn] falling back to the bar itself only when that control is not where we expect');
  // Found by href OR by its own words, because it carries no id — the same two-handle discipline
  // mgmtUl() and acctUl() already use for menus that cannot be selected directly.
  ok(/end\\s\+masquerad/i.test(cap) || /end\\s\+masquerad/.test(cap),
    '[capbtn] and by its label where the href does not name it');

  // ARMED, or nothing is offered at all. The mode's only job is that decision — which is precisely why
  // it needs no expiry: a mode whose worst failure is an unused button cannot go stale.
  ok(/if\(!\(!_AF\.status&&_AF\.capture\)\|\|!capOn\(\)\)return;/.test(cap),
    '[capbtn] the button appears only for a masked operator with capture armed');
  ok(/if\(CAP&&!capOn\(\)\)return;/.test(cap),
    '[capbtn] and the menu fallback obeys the same arming, so one switch governs both');
  // ⚠️ THE FALLBACK ASKS WHETHER THE BAR EXISTS, not whether the button is in it yet. The first version
  // asked the latter — a question about ORDER — and the menu pass runs first, so it added its own copy
  // and the bar then added the button: both on screen at once (David's screenshot). Both passes re-run
  // on every mutation, so their interleaving is not ours to control and the predicate cannot depend on
  // it. The ordering is fixed too, but the predicate is what makes it correct rather than lucky.
  // Scoped to spkMenu: capBtn has its own ._svxcap check and that one is legitimate — it is how the bar
  // pass stays idempotent across mutations. An unscoped search found it and tested the wrong function.
  const spkMenuFn = cap.slice(cap.indexOf('function spkMenu()'), cap.indexOf('var _spkF='));
  ok(spkMenuFn.length > 400 && spkMenuFn.length < 4000, '[capbtn] (sliced the right function)');
  ok(/if\(CAP&&masqEnd\(\)\)return;/.test(spkMenuFn) && !/_svxcap/.test(spkMenuFn),
    '[capbtn] the menu fallback stands down when a bar EXISTS, not when the button has already landed');
  ok(cap.indexOf('m:capBtn') < cap.indexOf('m:spkMenu'),
    '[capbtn] and the bar runs first, so the fallback is the pass that happens last');
  ok(!/setTimeout\([^)]*capSet/.test(cap) && !/expire/i.test(cap.slice(cap.indexOf('var MODEK'), cap.indexOf('var MODEK') + 400)),
    '[capbtn] with no expiry, deliberately — see the comment on MODEK for why an automatic mode needed one');

  // The COUNT is what makes a capture taken mid-load visible rather than authoritative.
  // ⚠️ THE CONFIRMATION IS ON THE BUTTON, NOT IN A MODAL. It is a control pressed several times in a
  // row while walking through roles, and an alert() makes the operator click twice to learn something
  // they could have read in place. The COUNT is the load-bearing part — two entries where you expected
  // nine is how you notice you clicked mid-load — so it goes in the label; the remedy rides the tooltip.
  const capDoFn = cap.slice(cap.indexOf('function capDo(el,transient)'), cap.indexOf('function spkMenu()'));
  ok(capDoFn.length > 200 && capDoFn.length < 2400, '[capbtn] (sliced the right function)');
  ok(/r\.n\+' entries'/.test(capDoFn) && /el\.textContent=/.test(capDoFn),
    '[capbtn] success reports how many entries it stored, on the control that was clicked');
  // ⚠️ FEEDBACK MUST OUTLIVE THE SURFACE IT IS ON, which cuts both ways. On the BAR the button stays
  // put, so the label is the confirmation and a modal would only cost a second click. In the account-
  // menu fallback the dropdown closes on the click that triggered it, taking the label with it — so the
  // capture succeeded and looked like nothing happened (David, on that entry). Same principle, opposite
  // conclusion, and the call site says which case it is.
  ok(/if\(transient\)\{alert\(/.test(capDoFn),
    '[capbtn] a control that is about to vanish gets a modal, because nothing else would survive');
  ok(/capDo\(b\)/.test(cap) && /capDo\(a,true\)/.test(cap),
    '[capbtn] and the bar does not — its button is still there to carry the answer');
  ok(!/confirm\(/.test(capDoFn),
    '[capbtn] and neither path asks a question it already has the answer to');
  ok(/looks wrong/.test(capDoFn) && /el\.title=/.test(capDoFn),
    '[capbtn] with what to do about a wrong-looking count kept, on the tooltip');
  ok(cap.indexOf('function capDo') > 0 && (cap.match(/capDo\(/g) || []).length >= 3,
    '[capbtn] and one function says it, so the bar and the menu cannot report a capture differently');

  // FORGETTING keeps the arming. The captures are data the operator gathered by walking around the
  // portal; the toggle is a preference about how the tool behaves, and clearing one is not a request to
  // undo the other. Rewritten rather than removeItem'd for exactly that reason.
  const con2 = buildSpkBundle(['kit.status'], { PORTAL_HANDOFF_URL: '' } as any);
  ok(/q\.clear===true/.test(con2) && /var keep=stockAll\(\)\[MODEK\]/.test(con2)
    && /if\(keep\)fresh\[MODEK\]=keep/.test(con2),
    '[capbtn] forgetting the captures keeps the arming, which is a preference and not part of what was gathered');
  ok(!/removeItem\(SK\)/.test(con2),
    '[capbtn] and rewrites the store rather than dropping the key, so the preference has somewhere to survive');
}

// ── TWO DEPLOYMENTS ON ONE PORTAL PAGE ───────────────────────────────────────────────────────────────
// A staging bundle loaded beside the live one is a real configuration — it is how the harness works — and
// the primary used to handle it almost right: the second one bailed out, but only AFTER assigning
// __kitCfg.base. Bundles read that base when they execute, which is after their fetch resolves, so the
// loser's origin was already sitting there. The deployment whose code was running then called the OTHER
// deployment's Worker: its config, its menu plan, its app rows, and non-deterministic between reloads
// because it turned on which primary parsed first. Run the real emitted primary twice and check.
{
  const primary = primaryJs({ PORTAL_HANDOFF_URL: "" } as any);
  const run = (src: string, ctx: Record<string, unknown>): void => {
    ctx.document = { currentScript: { src }, getElementsByTagName: () => [], createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {} }, documentElement: { appendChild() {} }, addEventListener() {}, readyState: 'complete' };
    try { runInNewContext(primary, ctx); } catch { /* the fetches and DOM work are not the subject */ }
  };
  const win: Record<string, unknown> = {};
  const ctx: Record<string, unknown> = {
    window: win, console, localStorage: { getItem: () => null, setItem() {} },
    fetch: () => ({ then: () => ({ then: () => ({ catch() {} }) }) }),
    URL: globalThis.URL, Blob: function () {}, location: { pathname: '/' },
    MutationObserver: function () { return { observe() {} }; }, requestAnimationFrame: () => 0,
    setTimeout: () => 0, setInterval: () => 0,
  };
  (ctx as { window: Record<string, unknown> }).window = win;
  run('https://dev.example.com/kit/spk.js', { ...ctx, window: win });
  const afterFirst = (win.__kitCfg as { base?: string } | undefined)?.base;
  run('https://prod.example.com/kit/spk.js', { ...ctx, window: win });
  const afterSecond = (win.__kitCfg as { base?: string; seen?: string[] } | undefined);

  ok(afterFirst === 'https://dev.example.com', `[twobases] the first primary claims the page (${afterFirst})`);
  ok(afterSecond?.base === 'https://dev.example.com',
    `[twobases] and a second deployment's primary changes nothing — not even on its way out (${afterSecond?.base})`);
  ok((afterSecond?.seen ?? []).length === 2,
    `[twobases] but both are RECORDED, so the page can say it happened instead of leaving it unanswerable (${(afterSecond?.seen ?? []).join(', ')})`);
}

// ── the capture entry: one menu item, and only for a masked operator ─────────────────────────────────
// The two gates are mutually exclusive in practice — masked in, the console's own gate refuses you
// because it matches on the effective identity, which is now the masked user. So the same menu slot
// carries whichever one this bundle was built for, and the label names the role, which is the only
// confirmation the operator gets that the masquerade is actually in effect before they store anything.
{
  const cap = buildSpkBundle(['kit.captureMenus'], { PORTAL_HANDOFF_URL: '' } as any);
  const con = buildSpkBundle(['kit.status'], { PORTAL_HANDOFF_URL: '' } as any);

  ok(/capture:true/.test(cap) && !/status:true/.test(cap), '[capture] the capture tier carries only its own flag');
  ok(/status:true/.test(con) && !/capture:true/.test(con), '[capture] and the console tier only its own');

  // Both bundles carry the code (they are one body, tiered by flags) — what differs is which branch can
  // run. Assert the BRANCH, not the presence of the string, or this passes on a bundle that can never
  // take it.
  ok(/var CAP=!_AF\.status&&_AF\.capture;/.test(cap),
    '[capture] the menu entry chooses its role from the flags rather than from a second gate');
  ok(cap.includes('Remember this role'), '[capture] and names what it does');

  // It writes to the PORTAL PAGE's storage. The console frame is a sandboxed srcdoc with an opaque
  // origin where localStorage throws — the same fact that made Copy silently do nothing for months — so
  // a capture written there would vanish and a capture read there would never be found.
  ok(/localStorage\.setItem\(SK,/.test(cap), '[capture] storing in the page that has storage');
  ok(!/fetch\(/.test(cap.slice(cap.indexOf('function stockSave'), cap.indexOf('function stockSave') + 500)),
    '[capture] and sending nothing anywhere — the capability is "write down what is already on this screen"');

  // The scope decoded out of the token is a LABEL. Nothing is authorized by it, and the comment says so;
  // this asserts the code matches the claim by pinning that no gate consults it.
  ok(/function myScope\(\)/.test(cap) && !/if\(myScope\(\)/.test(cap),
    '[capture] the locally-decoded scope labels a capture and gates nothing');
}

// ── the status banner (portal.statusBanner) ──────────────────────────────────────────────────────────
  {
    const URL_ = 'https://automation.example.com/hook';
    const on = buildSelfBundle(selfFeaturePolicyKeys(), { STATUS_BANNER_WEBHOOK: URL_, PORTAL_HANDOFF_URL: '' } as any);
    ok(/statusBanner:true/.test(on) && on.includes(URL_), '[banner] the endpoint rides a tier that carries the feature');

    // TEXT, never markup. The content is remote and shows to every signed-in user, so innerHTML here would
    // be an injection vector owned by whoever controls that endpoint. This repo already bans innerHTML in
    // injected code; the banner must not be the exception.
    // HTML IS supported — a support message wants links and emphasis, and David's own prior code sanitized
    // rather than refusing markup. What is NOT supported is handing markup to innerHTML: the message is
    // parsed in an inert document and copied across tag by tag, so script cannot execute because nothing
    // script-bearing is ever copied. Structural, not a rule someone has to remember.
    ok(/function bannerHtml/.test(on) && /DOMParser/.test(on), '[banner] markup is parsed inertly, then rebuilt');
    ok(/BAN_TAGS=\{A:1/.test(on), '[banner] from an allow-list of tags a message actually needs');
    ok(/https:\\\/\\\/\|mailto:/.test(on) || on.includes('https:\\/\\/|mailto:'),
      '[banner] with link hrefs held to the same scheme rule menu entries use');
    // ASSIGNMENT, not the word: the bundle legitimately mentions innerHTML in a trailing comment explaining
    // why a copy button uses textContent. A test matching the word failed on the comment, which is a test
    // measuring the wrong thing rather than a finding.
    ok(!/\.innerHTML\s*=/.test(on), '[banner] and nothing in the self bundle assigns innerHTML');

    // https only: this request carries a live ns_t.
    const plain = buildSelfBundle(selfFeaturePolicyKeys(), { STATUS_BANNER_WEBHOOK: 'http://insecure.example.com/h' } as any);
    ok(!plain.includes('insecure.example.com'), '[banner] a non-https endpoint is refused, not shipped');

    // Inert when unset — no request, nothing drawn, and no endpoint in the bytes.
    const off = buildSelfBundle(selfFeaturePolicyKeys(), { PORTAL_HANDOFF_URL: '' } as any);
    ok(!/"bw":/.test(off), '[banner] unset ⇒ no endpoint in the bundle');
    // And absent for a tier that does not carry the feature, even when configured.
    const notMine = buildSelfBundle(selfFeaturePolicyKeys().filter((k) => k !== 'portal.statusBanner'),
      { STATUS_BANNER_WEBHOOK: URL_ } as any);
    ok(!notMine.includes(URL_), '[banner] and absent from a tier that is not granted it');

    // One request per page: the element check cannot cover the in-flight window, so a re-entrant observer
    // pass would multiply a network call on every portal page.
    ok(/__svxBannerAsked/.test(on), '[banner] asked at most once per page load');
    // A plain-text reply is the simplest endpoint someone can write; refusing it would make the easy case
    // the unsupported one.
    // banner_message is named explicitly: a real endpoint returns that key, and a version of this test
    // that only listed the obvious names passed while a working webhook rendered nothing.
    ok(/j\.message\|\|j\.banner_message\|\|j\.text\|\|j\.banner/.test(on),
      '[banner] accepts JSON (message / banner_message / text / banner) or bare text');
    // Mounted in the portal's own header band when there is one — at the top of <body> it pushed the page
    // down and read as browser chrome.
    // Anchored BEFORE the navigation: appending to #header landed it below the page-title bar, because that
    // element wraps more than the top row. Ordered fallbacks, most specific first.
    ok(/getElementById\('header'\)/.test(on), '[banner] anchored to the portal header');
    // OVERLAID, not inserted. Normal flow was tried first and adds height, so every page shifts down by the
    // banner — worse than the arithmetic it avoided, and the reason the portal's own banner is positioned.
    ok(/position:absolute/.test(on) && /head\.style\.position='relative'/.test(on),
      '[banner] overlays the header instead of adding height to the page');
    // Bounded by the logo and user menu, because the slot IS the gap between them — full width lets a
    // narrow window run the text under both.
    // Positioned BELOW the logo, not centred in the header: the header box IS the logo/nav row, so
    // centring in it puts the text level with them. Two attempts got this wrong before the screenshots.
    // TWO bounds at once. Each attempt that used only one landed wrong: left-only ran the text under the
    // logo, top-only put it level with the menus. The safe strip is right-of-logo AND below-nav-row.
    ok(/header-logo/.test(on) && /header-user/.test(on), '[banner] bounded on both axes');
    // TWO placements chosen by measurement. Measured on the real portal: at ~1135px+ there is a 30px strip
    // between the user menu and the navigation; at ~687px the user menu wraps to its own row and the strip
    // is ZERO. Overlay-always therefore has nowhere to go when narrow, and flow-always shifts the page when
    // there was room. Neither is right on its own, which is why three fixed attempts all collided.
    ok(/strip<need\+2/.test(on), '[banner] overlays only when the message actually fits the strip');
    // The decision must not depend on the element it decides about. Using d.offsetHeight fed back into
    // itself — the flowed element is a different size from the overlaid one — so a resize stuttered between
    // modes and settled wherever the drag stopped. A constant plus hysteresis makes the choice stable.
    ok(/var need=20;/.test(on), '[banner] decided from a constant, not the element\'s own height');
    ok(/flowed\?strip<30:strip<need\+2/.test(on),
      '[banner] with separate enter and leave thresholds, so a boundary width settles instead of oscillating');
    // SYMMETRIC insets. Left-from-the-logo and right-from-the-page-edge centres the text in a lopsided box,
    // which reads as off-centre because it IS. Mirroring the inset centres it on the page, keeps it clear of
    // the logo, and makes a narrowing window wrap the message rather than shift or collide with it.
    ok(/d\.style\.left=left\+'px';d\.style\.right=left\+'px'/.test(on),
      '[banner] centred by mirroring the logo inset on both sides');
    // Lifted into the menu row's unused lower edge: the strip is ~30px and two lines need ~34, so anchoring
    // at the strip's top clipped the buttons. Borrowing 8px of slack fits both cases.
    ok(/Math\.max\(0,top-8\)/.test(on), '[banner] lifted 8px so a two-line message clears the buttons');
    ok(/btns\.parentNode\.insertBefore\(d,btns\)/.test(on), '[banner] and falls into the flow when it does not');
    // No clear:both in the flowed style — this header is float-based, and clearing pushed the banner past
    // every float, inflating the header. The flowed path goes INSIDE the navigation block instead, where
    // it stacks above the buttons without touching the floats.
    ok(!/clear:both/.test(on), '[banner] without clearing floats, which inflated the header');
    // Smaller text on the flowed path only. It is reached exactly at the widths where the button row is
    // already clipped, so shrinking the message is cheaper than any of the alternatives — and it uses the
    // full width, because at that vertical position the logo is a row above and reserving space beside it
    // would waste the room that keeps the text on one line.
    ok(/font-size:12\.5px/.test(on), '[banner] shrinks a step when it has to take its own row');
    // Pulled up into whitespace that already exists, so wrapping to a second line grows into unused space
    // instead of pushing the button row further down.
    ok(/margin-top:-12px/.test(on), '[banner] and grows upward into existing whitespace rather than downward');
    // No clamp on this path: at these widths wrapping beats truncating.
    ok(!/margin-top:-12px[^']*-webkit-line-clamp/.test(on), '[banner] with wrapping allowed rather than clipped');
    ok(/if\(!flowed\)\{flowed=true/.test(on) && /if\(flowed\)\{flowed=false/.test(on),
      '[banner] switching both ways, so a resize past the threshold recovers');
    ok(/window\.addEventListener\('resize',place\)/.test(on),
      '[banner] re-measured on resize, because the strip appears and disappears with the wrap');
    // The `font:` SHORTHAND with `inherit` as the family is invalid and the browser drops the whole
    // declaration — the banner rendered 400-weight at 16px and looked close enough to pass a glance.
    // Separate properties, always.
    ok(/font-weight:700;font-size:14px/.test(on), '[banner] weight and size set as separate properties');
    ok(!/font:\s*\d+\s+\d+px\/[\d.]+\s+inherit/.test(on), '[banner] and never via a font shorthand ending in inherit');
    // No header at all ⇒ a normal-flow bar at the top. Shifting a page we do not recognise beats overlaying
    // something unknown, so the fallback deliberately does NOT try to position.
    ok(/b\.insertBefore\(d,b\.firstChild\)/.test(on), '[banner] with a top-of-page fallback for a portal shaped differently');
    // NOT clamped. A clamp truncates at two lines, which would fire before the shrink loop could act, and
    // truncating a status notice mid-sentence is the one outcome it must not have. It shrinks instead.
    ok(!/-webkit-line-clamp/.test(on), '[banner] not clamped, so a third line is not silently cut off');
    ok(/for\(var fs=14;fs>10&&d\.offsetHeight>room;fs--\)/.test(on),
      '[banner] shrinking to fit the available room instead, down to a floor');
    ok(/d\.style\.fontSize='14px';/.test(on),
      '[banner] resetting the size each pass, so widening the window recovers rather than ratcheting down');
    // <br> is in the allow-list, so a message can force its own break.
    ok(/BR:1/.test(on), '[banner] and a message may force a line break with <br>');
  }

  // ── the primary records what it already worked out about the hand-off ───────────────────────────────
  // It has always walked the page's scripts to avoid double-loading; it just threw the answer away. The
  // console reads it back over the bridge, which is why "chain loading is unverifiable" was never true.
  {
    const withHandoff = primaryJs({ PORTAL_HANDOFF_URL: 'https://vendor.example.com/router.js' });
    ok(/window\.__kitCfg\.ho=HO/.test(withHandoff), '[observed] the primary publishes its hand-off facts');
    ok(/HO\.pre=true/.test(withHandoff), '[observed] recording that the script was already on the page');
    ok(/HO\.add=true/.test(withHandoff), '[observed] and, separately, that this kit is what added it');
    // Recorded in all three config states — a block that only publishes when configured would leave the
    // console unable to distinguish "declared none" from "no answer yet".
    ok(/window\.__kitCfg\.ho=HO/.test(primaryJs({ PORTAL_HANDOFF_URL: '' })), '[observed] published when declared as none');
    ok(/window\.__kitCfg\.ho=HO/.test(primaryJs({})), '[observed] and when not configured at all');
    for (const [name, js] of [['configured', withHandoff], ['none', primaryJs({ PORTAL_HANDOFF_URL: '' })], ['absent', primaryJs({})]] as const) {
      let okc = true; try { new Script(js); } catch { okc = false; }
      ok(okc, `[observed] the primary still compiles (${name})`);
    }
  }

  // ── the console's entry point must survive a portal with no Management menu ──────────────────────────
  // mgmtUl() finds that menu by its toggle's LABEL, so it misses on a portal that renames it, one that does
  // not have it, and any scope the portal hides it from. Before the fallback that left the console with no
  // way in at all: bundle served, routes answering, nothing to click. Our portal has the menu, which is why
  // it never showed up — the shape of bug a single-deployment test cannot find.
  {
    const b = buildSpkBundle(['kit.status'], { PORTAL_HANDOFF_URL: '' } as any);
    ok(/mgmtUl\(\),fallback=false/.test(b), '[entry] the console anchors on Management first');
    ok(/if\(!ul\)\{ul=acctUl\(\);fallback=!!ul\}/.test(b),
      '[entry] and falls back to the account menu when there is none');
    // The fallback must key on something NAME-independent, or it inherits the failure it exists to cover.
    ok(b.includes('hasSignOut') || /function acctUl/.test(b),
      '[entry] using the finder that keys on sign-out + profile rather than on a menu name');
    ok(/if\(fallback\)a\.title=/.test(b), '[entry] and says why it is there when it lands in the account menu');
  }

  // ── a secondary can be gated to named ACCOUNTS, like a feature ───────────────────────────────────────
  // resolveGate has always accepted {levels, users}; parseManifest insisted on a string, so a secondary
  // could be gated to a level but never to named accounts while a feature could. An accident of the parse,
  // not a decision — and the asymmetry mattered as soon as a niche per-customer script needed one.
  {
    const withUsers = JSON.stringify([
      { name: 'pub', from: 'r2:pub', auth: 'public' },
      { name: 'named', from: 'r2:named', auth: { users: ['boss@acme.example'] } },
      { name: 'mixed', from: 'r2:mixed', auth: { levels: ['reseller'], users: ['boss@acme.example'] } },
    ]);
    // ASSETS present: r2: entries require the binding, and this test is about the GATE, not the binding.
    const secEnv = { PORTAL_MODE: '1', PORTAL_SECONDARIES: withUsers, PORTAL_HANDOFF_URL: '', ASSETS: makeAssets() };
    ok(kitConfigError(secEnv as any) === null, '[secgate] a secondary may be gated to named accounts');
    const entries = parseManifest({ PORTAL_SECONDARIES: withUsers } as any);
    const named = entries.find((e) => e.name === 'named')!;
    ok(kitGateAllows(named.auth, { id: 'boss@acme.example', scope: 'Basic User', domain: 'acme.example' } as any, []),
      '[secgate] and the named account passes regardless of scope');
    ok(!kitGateAllows(named.auth, { id: 'other@acme.example', scope: 'Reseller', domain: 'acme.example' } as any, []),
      '[secgate] while an unnamed reseller does not');
    // Still loud on nonsense, and still requires a value.
    ok(kitConfigError({ ...secEnv, PORTAL_SECONDARIES: JSON.stringify([{ name: 'x', from: 'r2:x', auth: { levels: ['nope'] } }]) } as any) !== null,
      '[secgate] an unknown level inside the object is still a config error');
    ok(kitConfigError({ ...secEnv, PORTAL_SECONDARIES: JSON.stringify([{ name: 'x', from: 'r2:x' }]) } as any) !== null,
      '[secgate] and auth is still required');

    // THE LEAK THIS WOULD HAVE OPENED. The primary is public and unauthenticated; it used to carry each
    // entry's auth VALUE, which was merely needless for a level and would publish an account list now.
    // The client's only question is "token or not", so it gets one boolean.
    const pj = primaryJs({ PORTAL_SECONDARIES: withUsers, PORTAL_HANDOFF_URL: '' } as any);
    ok(!pj.includes('boss@acme.example'), '[secgate] the public primary carries no account from a gate');
    // Precisely: no `auth` FIELD at all. (A bare /reseller/ search matches the `_isReseller` helper the nag
    // uses — a false positive that would have made this assertion look meaningful while testing nothing.)
    ok(!/"auth"/.test(pj), '[secgate] nor an auth field of any kind');
    ok(!/"levels"/.test(pj) && !/"users"/.test(pj), '[secgate] nor the shape of a gate');
    ok(/"pub":true/.test(pj) && /"pub":false/.test(pj), '[secgate] only whether each entry needs a token');
    let compiles = true; try { new Script(pj); } catch { compiles = false; }
    ok(compiles, '[secgate] and the primary still compiles');
  }

  // ── the two operator URLs that had no loud validation (Fable review, 2026-08-09) ─────────────────────
  // Both end up in an href or receive a live credential, and both failed SILENTLY: wrapBundle drops a
  // non-https banner endpoint, so the feature read as configured and drew nothing; the release-notes URL
  // was not checked at all, and escaping does not neutralise a javascript: value in an href position.
  {
    const err = (env: Record<string, unknown>) => kitConfigError({ PORTAL_MODE: '1', ...env } as any);
    ok(/STATUS_BANNER_WEBHOOK must be an https URL/.test(err({ STATUS_BANNER_WEBHOOK: 'http://x.example/h' }) || ''),
      '[cfg] a non-https banner endpoint is a loud config error, not a silently inert feature');
    ok(err({ STATUS_BANNER_WEBHOOK: 'https://x.example/h' }) === null, '[cfg] https is accepted');
    ok(err({ STATUS_BANNER_WEBHOOK: '' }) === null, '[cfg] and empty stays the off switch');

    ok(/PORTAL_RELEASE_NOTES_URL must be an https URL/.test(err({ PORTAL_RELEASE_NOTES_URL: 'javascript:alert(1)' }) || ''),
      '[cfg] a javascript: release-notes URL is refused — it would land in an href');
    ok(/PORTAL_RELEASE_NOTES_URL must be an https URL/.test(err({ PORTAL_RELEASE_NOTES_URL: 'notaurl' }) || ''),
      '[cfg] as is a typo, rather than shipping a broken link');
    ok(err({ PORTAL_RELEASE_NOTES_URL: '' }) === null,
      '[cfg] but "" is the deliberate never-link state and must stay valid');
    ok(err({ PORTAL_RELEASE_NOTES_URL: 'https://example.com/releases#v{version}' }) === null,
      '[cfg] and a real value with the {version} placeholder passes');
  }

  // The banner feature card must not contradict the code. It described the SUPERSEDED text-only renderer
  // while the Config row and the shipped bannerHtml allow-list simple HTML — two answers on one console,
  // and the wrong one overstated a safety property.
  {
    const card = FEATURE_REGISTRY.find((f) => f.key === 'portal.statusBanner');
    const detail = (card?.detail ?? []).join(' ');
    ok(!/Text, not markup/.test(detail), '[banner] the feature card no longer claims the reply is rendered as text');
    ok(/allow-list/i.test(detail) && /unwrapped/i.test(detail),
      '[banner] and describes the allow-list rebuild the code actually performs');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
