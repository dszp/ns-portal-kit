/**
 * End-to-end Worker test (offline, no workerd): stubs `caches` + global `fetch` (JWT check + NS
 * reads served from a fixture), crafts a valid ns_t, and drives worker.fetch through the full path
 * — auth → fetchDomainSnapshot → resolveFlow → JSON/HTML. Also checks auth failures + CORS.
 *   tsx src/worker.selftest.ts <snapshot.json> [attendantsDir]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveFlow, type Snapshot } from '@dszp/netsapiens-lib';

const snapPath = process.argv[2];
if (!snapPath) {
  console.error('usage: tsx src/worker.selftest.ts <snapshot.json> [attendantsDir]');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;
const domain = String(raw.meta?.domain ?? raw.domain?.domain ?? '');

const attendantsDir = process.argv[3] ?? join(resolve(snapPath, '..'), 'attendants');
const aaByExt: Record<string, unknown> = {};
try {
  for (const f of readdirSync(attendantsDir).filter((f) => f.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(attendantsDir, f), 'utf8'));
    aaByExt[String(d.user ?? f.replace(/\.json$/, ''))] = d;
  }
} catch {
  /* none */
}

// --- stub Cache API (per-colo cache) with an in-memory map ---
class MemoryCache {
  store = new Map<string, Response>();
  async match(req: Request): Promise<Response | undefined> {
    const r = this.store.get(req.url);
    return r ? r.clone() : undefined;
  }
  async put(req: Request, res: Response): Promise<void> {
    this.store.set(req.url, res.clone());
  }
}
(globalThis as any).caches = { default: new MemoryCache() };

// --- stub global fetch: /jwt → 200 valid; NS v2 reads → fixture ---
let jwtCalls = 0;
let ringotelCalls = 0;
let nsFail500 = false; // when set, the /domains list read returns a 500 (drives the error-leak test)
// Ringotel stub data — populated only by the enabled-enrichment test below; empty otherwise.
let rtOrgs: any[] = [];
let rtBranches: any[] = [];
let rtUsers: any[] = [];
const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const nf = () => new Response('[]', { status: 404 });
(globalThis as any).fetch = async (input: string, init?: any) => {
  const uobj = new URL(String(input));
  // Ringotel AdminAPI (JSON-RPC, POST /api). Only serves the enabled test; NS path is untouched.
  if (uobj.hostname === 'shell.ringotel.co') {
    ringotelCalls++;
    const { method, params } = JSON.parse(String(init?.body ?? '{}'));
    // getBranches(orgid) is per-org on the real API — filter to match, so buildOrgBranchIndex's per-org
    // fan-out doesn't cross-assign another org's branches (matches the portal.selftest stub).
    const result = method === 'getOrganizations' ? rtOrgs : method === 'getBranches' ? rtBranches.filter((b: any) => b.orgid === params?.orgid) : method === 'getUsers' ? rtUsers : [];
    return new Response(JSON.stringify({ result }), { status: 200 });
  }
  const path = uobj.pathname.replace(/^\/ns-api\/v2/, '');
  if (path === '/jwt') {
    jwtCalls++;
    return new Response('{}', { status: 200 });
  }
  if (path === '/domains') {
    if (nsFail500) return new Response('{"code":"internal","message":"secret upstream trace 0xDEADBEEF"}', { status: 500 });
    return j([{ domain, description: 'Test Domain' }]);
  }
  const b = `/domains/${domain}`;
  if (path === b) return j(raw.domain ?? { domain });
  if (path === `${b}/timeframes`) return j(raw.timeframes ?? []);
  if (path === `${b}/users`) return j(raw.users ?? []);
  if (path === `${b}/callqueues`) return j(raw.callqueues ?? []);
  if (path === `${b}/phonenumbers`) return j(raw.phonenumbers ?? []);
  if (path === `${b}/autoattendants`) return j(raw.autoattendants ?? []);
  let m = path.match(new RegExp(`^${b}/users/([^/]+)/answerrules$`));
  if (m) return j(raw.answerrulesByUser?.[decodeURIComponent(m[1]!)] ?? []);
  m = path.match(new RegExp(`^${b}/callqueues/([^/]+)/agents$`));
  if (m) return j(raw.agentsByQueue?.[decodeURIComponent(m[1]!)] ?? []);
  m = path.match(new RegExp(`^${b}/users/([^/]+)/autoattendants/([^/]+)$`));
  if (m) {
    const d = aaByExt[decodeURIComponent(m[1]!)];
    return d ? j(d) : nf();
  }
  if (path === `${b}/dialplans/${domain}/dialrules`) return j(raw.dialrulesByPlan?.[domain] ?? []);
  return nf();
};

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ISS = 'manage.example.com';
const tok = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ domain, sub: `9000@${domain}`, aud: 'ns', iss: ISS, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${m}`);
};

(async () => {
  const { default: worker } = await import('./worker.js');
  const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
  const kind = raw.callqueues?.length ? 'queue' : 'user';
  const ref = raw.callqueues?.length ? String(raw.callqueues[0]!.callqueue) : String(raw.users?.[0]?.user ?? '');
  const expected = JSON.parse(JSON.stringify(resolveFlow({ ...raw, attendantDetails: aaByExt as any }, { kind, ref } as any)));
  const stripMmd = (g: any) => {
    const { __mermaid, ...rest } = g;
    return rest;
  };

  // ================= DELEGATED mode (portal ns_t) =================
  const dEnv = { NS_SERVER: 'mock.local', NS_PORTAL_ISS: ISS, ALLOWED_ORIGINS: 'https://portal.example.com' };
  const dcall = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    worker.fetch(new Request(`https://w.dev${path}`, { method, headers }), dEnv as any, ctx);

  const r1 = await dcall(`/flow?kind=${kind}&ref=${ref}`, { Authorization: `Bearer ${tok}`, Origin: 'https://portal.example.com' });
  ok(r1.status === 200, `[delegated] GET /flow → 200 (${kind} ${ref})`);
  ok(r1.headers.get('Access-Control-Allow-Origin') === 'https://portal.example.com', '[delegated] CORS origin echoed');
  const g1 = await r1.json();
  ok(JSON.stringify(stripMmd(g1)) === JSON.stringify(expected), '[delegated] graph matches direct resolveFlow');
  ok(typeof g1.__mermaid === 'string' && g1.__mermaid.includes('flowchart'), '[delegated] JSON carries __mermaid for the SPA');

  const before = jwtCalls;
  await dcall(`/flow?kind=${kind}&ref=${ref}`, { Authorization: `Bearer ${tok}` });
  ok(jwtCalls === before, `[delegated] JWT verdict cached (jwtCalls stayed ${before})`);

  ok((await dcall(`/domains`, { Authorization: `Bearer ${tok}` })).status === 200, '[delegated] /domains → just the token domain');
  ok((await dcall(`/flow?domain=other.com&kind=${kind}&ref=${ref}`, { Authorization: `Bearer ${tok}` })).status === 403, '[delegated] cross-domain read → 403');
  ok((await dcall(`/flow?kind=${kind}&ref=${ref}`)).status === 401, '[delegated] missing token → 401');
  ok((await dcall(`/flow?kind=bogus&ref=1`, { Authorization: `Bearer ${tok}` })).status === 400, '[delegated] bad entity → 400');

  // ================= SERVICE mode (internal viewer) =================
  // ALLOW_UNGATED_SERVICE_TOKEN: these cases test SERVICE-MODE BEHAVIOUR, not deployment posture. The
  // Worker otherwise refuses to use a stored token on a non-local host with no Access in front (the
  // gate in src/exposure.ts) -- correctly, and these requests come from https://w.dev. Opting out here
  // keeps the gate's own coverage in one place (see the [gate] cases below) instead of smeared across
  // every service-mode assertion.
  const sEnv = { NS_SERVER: 'mock.local', NS_API_TOKEN: 'service-token', ALLOWED_ORIGINS: '', ALLOW_UNGATED_SERVICE_TOKEN: '1' };
  const scall = (path: string, method = 'GET') => worker.fetch(new Request(`https://w.dev${path}`, { method }), sEnv as any, ctx);

  const rd = await scall('/domains');
  const doms = await rd.json();
  ok(rd.status === 200 && Array.isArray(doms) && doms[0]?.domain === domain, '[service] /domains lists scoped domains');

  const re = await scall(`/entities?domain=${domain}`);
  const ents = await re.json();
  const total = ['dids', 'users', 'queues', 'attendants'].reduce((n, k) => n + (ents[k]?.length ?? 0), 0);
  ok(re.status === 200 && total > 0, `[service] /entities?domain → ${total} entities`);

  const rf = await scall(`/flow?domain=${domain}&kind=${kind}&ref=${ref}`);
  ok(rf.status === 200 && JSON.stringify(stripMmd(await rf.json())) === JSON.stringify(expected), '[service] /flow?domain → graph matches');
  ok((await scall(`/entities`)).status === 400, '[service] /entities without ?domain → 400');

  // /flow?format=html (the gallery the injected modal iframe loads) must pin Mermaid with SRI, so a
  // compromised CDN can't substitute code (finding 2 §2b). Regression guard on the pinned tag.
  const rhtml = await scall(`/flow?domain=${domain}&kind=${kind}&ref=${ref}&format=html`);
  const htmlBody = await rhtml.text();
  ok(
    rhtml.status === 200 &&
      htmlBody.includes('cdn.jsdelivr.net/npm/mermaid@11.16.0/') &&
      /integrity="sha384-[A-Za-z0-9+/=]+"/.test(htmlBody) &&
      htmlBody.includes('crossorigin="anonymous"'),
    '[service] /flow?format=html → Mermaid pinned (11.16.0) + SRI + crossorigin',
  );

  // ================= Ringotel enrichment (optional, gated) =================
  // Gate invariant: no env so far set RINGOTEL_API_KEY, so enrichment never ran — the NS-only
  // baseline is byte-identical (asserted above) and ZERO Ringotel calls were made.
  ok(ringotelCalls === 0, '[ringotel] disabled (no key) → zero Ringotel calls; NS baseline unchanged');

  // Enabled: stub a Ringotel org whose branch.address == this domain, with a user per ###r device.
  const rtExts = [...new Set([...JSON.stringify(expected).matchAll(/\((\d+)r\)/g)].map((m) => m[1]!))];
  if (rtExts.length) {
    rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
    rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } }];
    rtUsers = rtExts.map((e) => ({ id: `u${e}`, extension: e, branchid: 'RTBR', name: `RT ${e}`, devs: [{ id: `d${e}`, st: 0 }] }));
  // ── the ungated-service-token gate (src/exposure.ts) ──
  // A stored token is ambient authority: it answers whatever reaches the Worker. Refuse to use it
  // until something verifiable is in front, so a public URL can't borrow the token's NS scope.
  {
    const bare = { NS_SERVER: 'mock.local', NS_API_TOKEN: 'service-token', ALLOWED_ORIGINS: '' };
    const call = (env: any, host = 'w.dev') => worker.fetch(new Request(`https://${host}/domains`), env as any, ctx);
    ok((await call(bare)).status === 403, '[gate] stored token + no Access on a public host -> 403 (not used)');
    // With ACCESS_AUD set this is STILL 403 -- but from the Access check (no Cf-Access-Jwt-Assertion on
    // this request), not the exposure gate. Assert the REASON changed hands, not the status.
    const gated = await call({ ...bare, ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' });
    ok(!/not protected/i.test(await gated.text()), '[gate] ACCESS_AUD set -> exposure gate opens; Access check takes over');
    ok((await call({ ...bare, ALLOW_UNGATED_SERVICE_TOKEN: '1' })).status === 200, '[gate] explicit opt-out -> allowed');
    ok((await call(bare, 'localhost')).status === 200, '[gate] local wrangler dev -> allowed');
    const root = await worker.fetch(new Request('https://w.dev/'), bare as any, ctx);
    const body = await root.text();
    ok(root.status === 403 && /Cloudflare Access/.test(body), '[gate] / teaches Access setup instead of serving the app');
    ok(!body.includes('service-token'), '[gate] the instructions never echo the token');
  }

    const rEnv = { ...sEnv, RINGOTEL_API_KEY: 'rt-key' };
    const rr = await worker.fetch(new Request(`https://w.dev/flow?domain=${domain}&kind=${kind}&ref=${ref}`), rEnv as any, ctx);
    const rg = await rr.json();
    const mmd = String(rg.__mermaid ?? '');
    // Default label "Ringotel"; inline suffix inserted right after an (###r) token.
    ok(rr.status === 200 && /\(\d+r\) \(Ringotel, \d+ device/.test(mmd), `[ringotel] enabled → ###r devices enriched inline (${rtExts.length} ext)`);
    ok(ringotelCalls > 0, '[ringotel] enabled → Ringotel API called (directory + users)');
    // Disable per-request even when configured.
    rtUsers = [];
    const rr0 = await worker.fetch(new Request(`https://w.dev/flow?domain=${domain}&kind=${kind}&ref=${ref}&enrich=0`), rEnv as any, ctx);
    const before = ringotelCalls;
    await rr0.json();
    ok(ringotelCalls === before, '[ringotel] ?enrich=0 → no Ringotel calls even when configured');
  } else {
    ok(true, '[ringotel] enabled enrichment skipped — no ###r devices in this fixture');
  }

  // ================= /ringotel/org route (service mode; ?refresh bypasses cross-test cache) =================
  rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
  rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } }];
  rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1, state: 1, devs: [{ id: 'd', st: 1 }] }];
  const rEnvS = { ...sEnv, RINGOTEL_API_KEY: 'rt-key' };
  const roCall = (p: string, env2: any = rEnvS) => worker.fetch(new Request(`https://w.dev${p}`), env2 as any, ctx);

  const ro = await roCall(`/ringotel/org?domain=${domain}&refresh=ringotel`);
  const rob = await ro.json();
  ok(ro.status === 200 && rob.active === true && rob.orgId === 'RTORG' && rob.appDomain === domain && rob.eligible === true, '[ringotel/org] active → {active,orgId,appDomain,eligible}');
  const roNone = await roCall(`/ringotel/org?domain=no.match.example&refresh=ringotel`);
  const roNoneB = await roNone.json();
  ok(roNone.status === 200 && roNoneB.active === false && roNoneB.eligible === true, '[ringotel/org] no org → {active:false,eligible:true}');
  ok((await roCall(`/ringotel/org?domain=${domain}`, sEnv)).status === 404, '[ringotel/org] no RINGOTEL_API_KEY → 404 (gate)');

  const ru = await roCall(`/ringotel/users?domain=${domain}&refresh=ringotel`);
  const rub = await ru.json();
  ok(ru.status === 200 && rub.active === true && rub.users['100'] && rub.users['100'].activated === true && rub.users['100'].presence === 'active' && rub.users['100'].label === 'Online', '[ringotel/users] active → per-ext status map (presence from state)');
  const ruNone = await roCall(`/ringotel/users?domain=no.match.example&refresh=ringotel`);
  const ruNoneB = await ruNone.json();
  ok(ruNone.status === 200 && ruNoneB.active === false && !ruNoneB.users, '[ringotel/users] no org → {active:false}');
  ok((await roCall(`/ringotel/users?domain=${domain}`, sEnv)).status === 404, '[ringotel/users] no RINGOTEL_API_KEY → 404 (gate)');

  // ================= domain allowlist =================
  const acall = (env2: any, path: string) => worker.fetch(new Request(`https://w.dev${path}`), env2, ctx);
  const allowOk = { ...sEnv, ALLOWED_DOMAINS: `${domain},other.example.com` };
  ok((await acall(allowOk, `/entities?domain=${domain}`)).status === 200, '[allowlist] allowed domain → 200');
  const block = { ...sEnv, ALLOWED_DOMAINS: 'nope.example.com' };
  ok((await acall(block, `/entities?domain=${domain}`)).status === 403, '[allowlist] domain not in allowlist → 403');
  ok((await acall(block, `/flow?domain=${domain}&kind=${kind}&ref=${ref}`)).status === 403, '[allowlist] /flow blocked outside allowlist → 403');
  const rdb = await acall(block, '/domains');
  ok(rdb.status === 200 && (await rdb.json()).length === 0, '[allowlist] /domains filtered to allowlist');

  // ================= error responses don't leak upstream NS detail =================
  // A non-401/403 NS failure maps to 502; the client body must be generic — the upstream path and
  // response body are logged server-side only, never returned. Regression guard for the info-leak fix.
  nsFail500 = true;
  const errRes = await scall('/domains');
  const errBody = await errRes.json();
  nsFail500 = false;
  ok(
    errRes.status === 502 && errBody.error === 'Request failed' && !('detail' in errBody),
    '[error] upstream NS failure → generic body, no internal detail leaked',
  );

  // ================= public routes =================
  const app = await scall('/');
  ok(app.status === 200 && (app.headers.get('content-type') ?? '').includes('text/html'), 'GET / → viewer SPA');
  ok((await scall('/health')).status === 200, 'GET /health → 200');
  const opt = await dcall('/flow', { Origin: 'https://portal.example.com' }, 'OPTIONS');
  ok(opt.status === 204 && !!opt.headers.get('Access-Control-Allow-Methods'), 'OPTIONS preflight → 204 + CORS');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
