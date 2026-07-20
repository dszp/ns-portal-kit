/**
 * Offline portal-mode auth test (no workerd): stubs `caches` + `fetch`, crafts ns_t payloads for each
 * identity scenario, and drives worker.fetch. Self-contained — a tiny inline domain snapshot serves NS
 * reads for ANY domain path, so cross-domain reseller reads resolve to 200. No fixture file needed.
 *   pnpm test:portal
 */
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// The issuer these fixture tokens claim. It must equal the env's NS_PORTAL_ISS below: the lib's
// assertClaims() mandates aud:'ns' and an EXPLICIT issuer — there is deliberately no default, since a
// default issuer would accept another portal's tokens. A mismatch (or an unset NS_PORTAL_ISS) fails
// closed regardless of PORTAL_MODE / the policy gate.
const ISS = 'manage.example.com';
// aud/iss are baked in here (not per-call) so every mkTok() call site below stays as the brief specifies.
const mkTok = (claims: Record<string, unknown>) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ aud: 'ns', iss: ISS, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;

// A minimal domain served for EVERY domain path (echoes the path's domain). One user "100".
class MemoryCache {
  store = new Map<string, Response>();
  async match(req: Request) { const r = this.store.get(req.url); return r ? r.clone() : undefined; }
  async put(req: Request, res: Response) { this.store.set(req.url, res.clone()); }
}
(globalThis as any).caches = { default: new MemoryCache() };

let jwtCalls = 0;
let rtOrgs: any[] = [];
let rtBranches: any[] = [];
const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
(globalThis as any).fetch = async (input: string, init?: any) => {
  const u = new URL(String(input));
  if (u.hostname === 'shell.ringotel.co') {
    const { method, params } = JSON.parse(String(init?.body ?? '{}'));
    // getBranches(orgid) is per-org on the real API — filter like the real API so buildOrgBranchIndex's
    // per-org fan-out doesn't cross-assign another org's branches (which would spuriously read as ambiguous).
    const result = method === 'getOrganizations' ? rtOrgs : method === 'getBranches' ? rtBranches.filter((b) => b.orgid === params?.orgid) : [];
    return new Response(JSON.stringify({ result }), { status: 200 });
  }
  const path = u.pathname.replace(/^\/ns-api\/v2/, '');
  if (path === '/jwt') { jwtCalls++; return new Response('{}', { status: 200 }); }
  if (path === '/domains') return j([{ domain: 'anything' }]);
  const m = path.match(/^\/domains\/([^/]+)(\/.*)?$/);
  if (m) {
    const d = m[1]!;
    // A domain the caller's ns_t is NOT scoped to: NS 401s every read (drives the Ringotel NS-scope test).
    if (d === 'forbidden.example') return new Response(JSON.stringify({ error: 'out of scope' }), { status: 401 });
    const sub = m[2] ?? '';
    if (sub === '' ) return j({ domain: d });
    if (sub === '/timeframes') return j([]);
    if (sub === '/users') return j([{ user: '100', 'name-first-name': 'Test', domain: d }]);
    if (sub === '/callqueues' || sub === '/phonenumbers' || sub === '/autoattendants') return j([]);
    if (/\/users\/[^/]+\/answerrules$/.test(sub)) return j([]);
    return j([]);
  }
  return new Response('[]', { status: 404 });
};

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

// Identities
const reseller = mkTok({ sub: 'admin@0000.12345.service', user_scope: 'Reseller', domain: '0000.12345.service' });
const randomUser    = mkTok({ sub: '100@acme.example',        user_scope: 'Basic User', domain: 'acme.example' });
const otherReseller = mkTok({ sub: 'boss@bigco.example',      user_scope: 'Reseller',   domain: 'bigco.example' });
const maskedReseller   = mkTok({ sub: '100@acme.example', user_scope: 'Office Manager', domain: 'acme.example', mask_chain: 'admin@0000.12345.service' });
const realOM        = mkTok({ sub: '105@acme.example', user_scope: 'Office Manager', domain: 'acme.example' });

(async () => {
  const { default: worker } = await import('./worker.js');
  const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
  // Portal mode env: NO NS_API_TOKEN wired for auth, but PROVE tokenless→401 even if one is present.
  const env = { NS_SERVER: 'mock.local', PORTAL_MODE: '1', NS_PORTAL_ISS: ISS, NS_API_TOKEN: 'should-be-ignored', ALLOWED_ORIGINS: 'https://manage.example.com' };
  const call = (path: string, tok?: string) =>
    worker.fetch(new Request(`https://svc.dev${path}`, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {}), env as any, ctx);

  const envRt = { ...env, RINGOTEL_API_KEY: 'rt' };
  const callRt = (path: string, tk?: string) =>
    worker.fetch(new Request(`https://svc.dev${path}`, tk ? { headers: { Authorization: `Bearer ${tk}` } } : {}), envRt as any, ctx);

  // ── entry gate (scope-based: ALL resellers + OMs pass; Basic Users blocked) ──
  ok((await call('/flow?kind=user&ref=100', reseller)).status === 200, '[gate] reseller /flow → 200');
  ok((await call('/flow?kind=user&ref=100', otherReseller)).status === 200, '[gate] ANY reseller /flow → 200 (ungated to all resellers)');
  ok((await call('/flow?kind=user&ref=100', randomUser)).status === 403, '[gate] Basic User → 403 (portal.access denies)');
  ok((await call('/flow?kind=user&ref=100')).status === 401, '[gate] tokenless → 401 (no service fallback)');

  // ── feature split: OMs get the column, NOT Call Flow or the banner ──
  ok((await call('/flow?kind=user&ref=100', realOM)).status === 403, '[feat] OM /flow → 403 (callflow.view = reseller only)');
  ok((await callRt('/ringotel/org?domain=acme.example', realOM)).status === 403, '[feat] OM /ringotel/org (banner) → 403 (reseller only)');
  ok((await callRt('/ringotel/users?domain=acme.example', realOM)).status === 200, '[feat] real OM /ringotel/users (column) → 200');
  ok((await callRt('/ringotel/users?domain=acme.example', maskedReseller)).status === 200, '[feat] masked-as-OM /ringotel/users → 200 (effective scope OM)');
  ok((await callRt('/ringotel/users?domain=acme.example', randomUser)).status === 403, '[feat] Basic User /ringotel/users → 403');

  // ── domain scope ──
  ok((await call('/flow?domain=other.example&kind=user&ref=100', reseller)).status === 200, '[scope] reseller cross-domain /flow → 200 (cross-domain unlock)');
  ok((await call('/flow?kind=user&ref=100', reseller)).status === 200, '[scope] reseller no ?domain → own domain 200');
  ok((await callRt('/ringotel/users?domain=other.example', realOM)).status === 403, '[scope] OM cross-domain /ringotel/users → 403 (domain-locked)');
  ok((await callRt('/ringotel/users?domain=acme.example', realOM)).status === 200, '[scope] OM own-domain /ringotel/users → 200');

  // ── Ringotel routes enforce NS scope on the requested domain (finding 1 / plan §1) ──
  // Unlike /flow, the Ringotel routes read from the fleet-wide key; a reseller reading a domain their
  // ns_t is NOT scoped to must be refused, not served from the fleet key.
  ok((await callRt('/ringotel/users?domain=forbidden.example', reseller)).status === 403, '[rt-scope] reseller /ringotel/users on NS-forbidden domain → 403 (NS scope enforced)');
  ok((await callRt('/ringotel/org?domain=forbidden.example', reseller)).status === 403, '[rt-scope] reseller /ringotel/org on NS-forbidden domain → 403');
  ok((await callRt('/ringotel/users?domain=acme.example', reseller)).status === 200, '[rt-scope] reseller /ringotel/users on in-scope cross-domain → 200 (probe passes)');

  // ── portal env does NOT serve the internal viewer SPA (finding 4 / plan §3) ──
  ok((await call('/')).status === 404, '[spa] portal mode GET / → 404 (internal SPA withheld on delegated env)');
  ok((await call('/app')).status === 404, '[spa] portal mode GET /app → 404');

  // ── gate-off 404 (ringotelEnabled=false) + reseller happy path ──
  ok((await call('/ringotel/org?domain=0000.12345.service', reseller)).status === 404, '[rt-gate] no RINGOTEL_API_KEY → /ringotel/org 404 (gate before policy)');
  ok((await call('/ringotel/users?domain=0000.12345.service', reseller)).status === 404, '[rt-gate] no RINGOTEL_API_KEY → /ringotel/users 404');
  ok((await callRt('/ringotel/org?domain=0000.12345.service', reseller)).status === 200, '[rt-gate] reseller /ringotel/org → 200');

  // ── force-fresh elevation (cross-domain = sensitive) ──
  // Warm the verdict cache with an own-domain read, then measure.
  await call('/flow?kind=user&ref=100', reseller);
  let n = jwtCalls;
  await call('/flow?kind=user&ref=100', reseller);          // own domain → cached, no /jwt
  ok(jwtCalls === n, '[fresh] own-domain reseller read → verdict cached (no extra /jwt)');
  n = jwtCalls;
  await call('/flow?domain=other.example&kind=user&ref=100', reseller); // cross-domain → force-fresh
  ok(jwtCalls > n, '[fresh] cross-domain reseller read → force-fresh /jwt (revocation caught)');

  // ── GET /ringotel/orgs: reseller enabled-map, scoped to listDomains (finding-1 boundary) ──
  // Directory has an org for 'anything' (the reseller's listDomains) AND 'secret.example' (NOT theirs).
  rtOrgs = [{ id: 'O1', domain: 'appdom' }, { id: 'O2', domain: 'appdom2' }];
  rtBranches = [{ id: 'B1', orgid: 'O1', address: 'anything' }, { id: 'B2', orgid: 'O2', address: 'secret.example' }];
  const orgsRes = await callRt('/ringotel/orgs?refresh=ringotel', reseller);
  const orgsBody = await orgsRes.json();
  ok(orgsRes.status === 200 && orgsBody.enabled && orgsBody.enabled['anything'] && orgsBody.enabled['anything'].orgId === 'O1', '[rt-orgs] reseller → enabled map for own domain');
  ok(!('secret.example' in orgsBody.enabled), '[rt-orgs] a directory-enabled domain NOT in listDomains is never returned (scoping)');
  ok((await callRt('/ringotel/orgs', randomUser)).status === 403, '[rt-orgs] Basic User → 403 (ringotel.orgList reseller-only)');
  ok((await callRt('/ringotel/orgs', realOM)).status === 403, '[rt-orgs] OM → 403');
  ok((await call('/ringotel/orgs', reseller)).status === 404, '[rt-orgs] no RINGOTEL_API_KEY → 404 (gate)');

  // ── feature-config override reaches the routes (Task 3) ──────────────────────────────────────────
  // Turn callflow.view off ⇒ even a reseller's /flow now 403s (defaults would 200).
  const envOff = { ...env, PORTAL_FEATURES: JSON.stringify({ 'callflow.view': 'off' }) };
  const callOff = (path: string, tok?: string) => worker.fetch(new Request(`https://svc.dev${path}`, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {}), envOff as any, ctx);
  ok((await callOff('/flow?kind=user&ref=100', reseller)).status === 403, '[cfg] PORTAL_FEATURES callflow.view=off ⇒ reseller /flow 403');
  // A bad PORTAL_FEATURES ⇒ 500 (loud), even on /flow.
  const envBad = { ...env, PORTAL_FEATURES: '{bad' };
  ok((await worker.fetch(new Request('https://svc.dev/flow?kind=user&ref=100', { headers: { Authorization: `Bearer ${reseller}` } }), envBad as any, ctx)).status === 500, '[cfg] bad PORTAL_FEATURES ⇒ 500');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
