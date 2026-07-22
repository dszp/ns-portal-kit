/**
 * Offline test for the Worker-served injection routes (no workerd): stubs `caches` + `fetch`, mocks the
 * ASSETS (R2) binding, and drives worker.fetch. Mirrors portal.selftest.ts.
 *   pnpm test:kit
 */
import { Script } from 'node:vm';
import { buildKitBundle, buildSelfBundle, featurePolicyKeys, selfFeaturePolicyKeys, primaryJs } from './kit.js';
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
  // portal-mode-only: a non-portal (dia-like) env must not expose the primary.
  ok((await call('/p.js', undefined, { NS_SERVER: 'mock.local', NS_PORTAL_ISS: ISS, ALLOWED_ORIGINS: '', NS_API_TOKEN: 't', ALLOW_UNGATED_SERVICE_TOKEN: '1' })).status !== 200, '[primary] non-portal env: /p.js not served');

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
  // portal-mode-only: a non-portal (dia/local) env must NOT serve the gated bundle (or its label), even
  // to a valid reseller ns_t — it stays a 404, byte-identical to before this feature existed.
  {
    const npEnv = { NS_SERVER: 'mock.local', NS_PORTAL_ISS: ISS, ALLOWED_ORIGINS: '', NS_API_TOKEN: 't', ALLOW_UNGATED_SERVICE_TOKEN: '1', RINGOTEL_LABEL: 'App' };
    const r = await call('/kit/portal.js', reseller, npEnv);
    ok(r.status !== 200, '[bundle] non-portal env: /kit/portal.js NOT served (portal-mode-only)');
  }

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
    // Non-portal env: no delegated self surface.
    const npEnv2 = { NS_SERVER: 'mock.local', NS_PORTAL_ISS: ISS, ALLOWED_ORIGINS: '', NS_API_TOKEN: 't', ALLOW_UNGATED_SERVICE_TOKEN: '1' };
    ok((await call('/kit/self.js', basic, npEnv2)).status !== 200, '[self-route] non-portal env: /kit/self.js not served');
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
    ok(b.includes("ls[i].id!=='app-menu-list'"), '[menus] ...and never matches the Apps menu by mistake');
    ok(b.includes('svxacct'), '[menus] the account menu has its own idempotency guard');
    ok(b.includes('divider'), '[menus] added account entries go above the divider + Log Out, not after them');
    // One add/hide implementation shared by both menus — a second copy is how two menus drift apart.
    ok((b.match(/function menuApply\(/g) || []).length === 1 && (b.match(/_svxadd/g) || []).length === 1,
      '[menus] add/hide is implemented once and reused, not duplicated per menu');
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
