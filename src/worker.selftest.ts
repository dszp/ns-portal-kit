/**
 * End-to-end Worker test (offline, no workerd): stubs `caches` + global `fetch` (JWT check + NS
 * reads served from a fixture), crafts a valid ns_t, and drives worker.fetch through the full path
 * — auth → fetchDomainSnapshot → resolveFlow → JSON/HTML. Also checks auth failures + CORS.
 *   tsx src/worker.selftest.ts <snapshot.json> [attendantsDir]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFlow, type Snapshot } from '@dszp/netsapiens-lib';
import { INDEX_REFRESH_LOCK_KEY } from './ringotel.js';

// With no argument, run against the committed, fully-genericized fixture so `pnpm test:worker` just
// works (and can sit in the CI `test` aggregate). Pass a path to point it at any other snapshot's JSON
// (e.g. a live domain backup). Resolved from this file's own location so the cwd doesn't matter.
const DEFAULT_SNAP = resolve(fileURLToPath(import.meta.url), '../../test/snapshots/demo.12345.service-snapshot.json');
const snapPath = process.argv[2] ?? DEFAULT_SNAP;
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
  async delete(req: Request): Promise<boolean> {
    return this.store.delete(req.url);
  }
}
const memCache = new MemoryCache();
(globalThis as any).caches = { default: memCache };
// The one artifact that actually needs resetting between "force a fresh directory dig" scenarios: the
// directory-refresh coalescing lock (60s TTL in production; this stub's `match` has no expiry check, so
// it never self-clears here). Delete just that key rather than the whole cache — a blanket clear would
// also nuke the JWT-verdict cache and any org/user-status entries other assertions still rely on.
const clearRefreshLock = () => memCache.store.delete(INDEX_REFRESH_LOCK_KEY);

// --- stub global fetch: /jwt → 200 valid; NS v2 reads → fixture ---
let jwtCalls = 0;
let ringotelCalls = 0;
let nsFail500 = false; // when set, the /domains list read returns a 500 (drives the error-leak test)
// Ringotel stub data — populated only by the enabled-enrichment test below; empty otherwise.
let rtOrgs: any[] = [];
let rtBranches: any[] = [];
let rtUsers: any[] = [];
let rtRpc: Array<{ method: string; params: any }> = []; // captured Ringotel RPC bodies (write-route asserts)
let nsDevices: any[] = []; // NS user devices (write-route tests)
let nsDevicesFail = false; // when set, the devices GET returns non-2xx (no-ns-device: read-failure case)
let nsUserRec: any = null; // NS single-user record (eligibility; write-route tests)
// Fix 2 (transient-upstream-failure) test knobs: fail JUST the `~` self-read, or JUST the specific-ext
// eligibility read, independently — both otherwise share nsUserRec/the same regex, so without these two
// flags there's no way to fail one without failing the other.
let nsSelfReadFail = false;
let nsEligReadFail = false;
const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const nf = () => new Response('[]', { status: 404 });
(globalThis as any).fetch = async (input: string, init?: any) => {
  const uobj = new URL(String(input));
  // Ringotel AdminAPI (JSON-RPC, POST /api). Only serves the enabled test; NS path is untouched.
  if (uobj.hostname === 'shell.ringotel.co') {
    ringotelCalls++;
    const { method, params } = JSON.parse(String(init?.body ?? '{}'));
    rtRpc.push({ method, params });
    // getBranches(orgid) is per-org on the real API — filter to match, so buildOrgBranchIndex's per-org
    // fan-out doesn't cross-assign another org's branches (matches the portal.selftest stub).
    const result =
      method === 'getOrganizations' ? rtOrgs
      : method === 'getBranches' ? rtBranches.filter((b: any) => b.orgid === params?.orgid)
      : method === 'getUsers' ? rtUsers
      : method === 'createUser' ? { id: 'NEWRT', ...params }
      : ['updateUser', 'deactivateUser', 'deleteUser', 'resetUserPassword', 'setUserStatus'].includes(method) ? { ok: true }
      : [];
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
  // A second NS-readable domain with NO Ringotel branch: lets us test 'readable but no org' apart from
  // 'not readable at all', which the NS-scope probe now rejects earlier and for a different reason.
  if (path === '/domains/readable.example') return j({ domain: 'readable.example' });
  // NS answers 401/403 for a domain outside the token's scope -- NOT 404. Model that, or the probe's
  // real behaviour (401/403 -> 403; anything else rethrown as 502) never gets exercised.
  if (path === '/domains/forbidden.example') return new Response(JSON.stringify({ error: 'out of scope' }), { status: 401 });
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
    const ext = decodeURIComponent(m[1]!);
    // AA keypress detail. Newer backups embed it as attendantDetailsByUser[ext] (an array, as the API
    // returns and fetchDomainSnapshot expects); older fixtures supply a single object via a sibling
    // attendants/ dir (aaByExt). Serve either, always as an array.
    const d = raw.attendantDetailsByUser?.[ext] ?? (aaByExt[ext] ? [aaByExt[ext]] : undefined);
    return d ? j(d) : nf();
  }
  // Any dialplan's dialrules — the bare {domain} plan AND each AA's own {domain}_{ext} plan (the
  // authoritative menu / no-key / star routing). fetchDomainSnapshot fetches both; serve whatever the
  // snapshot captured, keyed by the plan name in the path.
  m = path.match(new RegExp(`^${b}/dialplans/([^/]+)/dialrules$`));
  if (m) return j(raw.dialrulesByPlan?.[decodeURIComponent(m[1]!)] ?? []);
  // Write-route stubs: device collection (list/create), one device (get/delete), single-user read.
  m = path.match(/^\/domains\/([^/]+)\/users\/([^/]+)\/devices$/);
  if (m) {
    if (init?.method === 'POST') { const d = JSON.parse(String(init.body ?? '{}')); return j({ device: d.device, 'device-sip-registration-password': 'GENPW1234567890' }); }
    if (nsDevicesFail) return new Response('{"error":"upstream"}', { status: 500 });
    return j(nsDevices);
  }
  m = path.match(/^\/domains\/([^/]+)\/users\/([^/]+)\/devices\/([^/]+)$/);
  if (m) {
    if (init?.method === 'DELETE') return j({});
    return j(nsDevices.find((x: any) => x.device === decodeURIComponent(m![3]!)) ?? {});
  }
  m = path.match(/^\/domains\/([^/]+)\/users\/([^/]+)$/);
  if (m) {
    const isSelf = m[1] === '~' && m[2] === '~';
    if (isSelf && nsSelfReadFail) return new Response('{"error":"upstream"}', { status: 500 });
    if (!isSelf && nsEligReadFail) return new Response('{"error":"upstream"}', { status: 500 });
    return nsUserRec ? j(nsUserRec) : nf();
  }
  return nf();
};

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ISS = 'manage.example.com';
// Craft a delegated ns_t for the fixture domain. `user_scope` is what the portal authz policy keys on
// (see the feature registry in src/features.ts + the full scope matrix in portal.selftest.ts) — a token with no scope is
// a Basic User and is refused at the portal.access gate, so every delegated call must set one.
const mkTok = (claims: Record<string, unknown> = {}) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ domain, sub: `9000@${domain}`, aud: 'ns', iss: ISS, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;

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
  // Expected graph = resolve the snapshot as-is (embedded attendantDetailsByUser + per-AA dialplans are
  // what the Worker's fetchDomainSnapshot reconstructs). Only inject the sidecar attendants/ dir when a
  // fixture actually ships one (legacy shape); modern backups embed it.
  const expected = JSON.parse(
    JSON.stringify(resolveFlow(Object.keys(aaByExt).length ? ({ ...raw, attendantDetails: aaByExt } as any) : (raw as any), { kind, ref } as any)),
  );
  const stripMmd = (g: any) => {
    const { __mermaid, ...rest } = g;
    return rest;
  };

  // ================= DELEGATED mode (portal ns_t) =================
  // A valid ns_t always resolves to a policy-gated principal (there is no delegated-but-unpoliced path).
  // This block proves the delegated path runs END-TO-END against the REAL snapshot — a reseller reaches
  // /flow and the graph is byte-identical to a direct resolveFlow — and that the portal.access gate is
  // wired here (a Basic User is refused). The full scope/domain matrix (reseller cross-domain unlock, OM
  // domain-lock, NS-scope boundary) lives in portal.selftest.ts, which has a proper multi-domain stub.
  const dEnv = { NS_SERVER: 'mock.local', NS_PORTAL_ISS: ISS, ALLOWED_ORIGINS: 'https://portal.example.com' };
  const dcall = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    worker.fetch(new Request(`https://w.dev${path}`, { method, headers }), dEnv as any, ctx);
  const resellerTok = mkTok({ user_scope: 'Reseller' }); // callflow.view is reseller-level
  const basicTok = mkTok({ user_scope: 'Basic User' }); // below portal.access

  const r1 = await dcall(`/flow?kind=${kind}&ref=${ref}`, { Authorization: `Bearer ${resellerTok}`, Origin: 'https://portal.example.com' });
  ok(r1.status === 200, `[delegated] reseller GET /flow → 200 (${kind} ${ref})`);
  ok(r1.headers.get('Access-Control-Allow-Origin') === 'https://portal.example.com', '[delegated] CORS origin echoed');
  const g1 = await r1.json();
  ok(JSON.stringify(stripMmd(g1)) === JSON.stringify(expected), '[delegated] graph matches direct resolveFlow');
  ok(typeof g1.__mermaid === 'string' && g1.__mermaid.includes('flowchart'), '[delegated] JSON carries __mermaid for the SPA');

  const before = jwtCalls;
  await dcall(`/flow?kind=${kind}&ref=${ref}`, { Authorization: `Bearer ${resellerTok}` });
  ok(jwtCalls === before, `[delegated] JWT verdict cached (jwtCalls stayed ${before})`);

  ok((await dcall(`/domains`, { Authorization: `Bearer ${resellerTok}` })).status === 200, '[delegated] reseller /domains → 200');
  ok((await dcall(`/flow?kind=${kind}&ref=${ref}`)).status === 401, '[delegated] missing token → 401');
  ok((await dcall(`/flow?kind=bogus&ref=1`, { Authorization: `Bearer ${resellerTok}` })).status === 400, '[delegated] bad entity → 400');
  ok((await dcall(`/flow?kind=${kind}&ref=${ref}`, { Authorization: `Bearer ${basicTok}` })).status === 403, '[delegated] Basic User → 403 (portal.access gate)');

  // ================= STANDALONE mode (internal viewer) =================
  // ALLOW_UNGATED_SERVICE_TOKEN: these cases test STANDALONE-MODE BEHAVIOUR, not deployment posture. The
  // Worker otherwise refuses to use a stored token on a non-local host with no Access in front (the
  // gate in src/exposure.ts) -- correctly, and these requests come from https://w.dev. Opting out here
  // keeps the gate's own coverage in one place (see the [gate] cases below) instead of smeared across
  // every standalone-mode assertion.
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

  // ── the ungated-service-token gate (src/exposure.ts) — INDEPENDENT of Ringotel, so it runs always ──
  // A stored token is ambient authority: it answers whatever reaches the Worker. Refuse to use it until
  // something verifiable is in front, so a public URL can't borrow the token's NS scope. (Previously this
  // block was nested inside `if (rtExts.length)` and silently skipped on fixtures with no ###r devices.)
  {
    const bare = { NS_SERVER: 'mock.local', NS_API_TOKEN: 'service-token', ALLOWED_ORIGINS: '' };
    const call = (env: any, host = 'w.dev') => worker.fetch(new Request(`https://${host}/domains`), env as any, ctx);
    ok((await call(bare)).status === 403, '[gate] stored token + no Access on a public host -> 403 (not used)');
    // ACCESS_AUD *and* ACCESS_TEAM_DOMAIN both set: the exposure gate opens and the Access check takes
    // over — still 403 (no Cf-Access-Jwt-Assertion here), but for a different reason. Assert the reason changed.
    const gated = await call({ ...bare, ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' });
    ok(!/not protected/i.test(await gated.text()), '[gate] ACCESS_AUD + team domain -> exposure gate opens; Access check takes over');
    // REGRESSION (fail-open, now fixed): ACCESS_AUD set but ACCESS_TEAM_DOMAIN missing => accessConfig() is
    // null, so the Access check can't run. The gate MUST stay closed and refuse the token — opening on
    // ACCESS_AUD alone served a half-configured deployment's whole fleet unauthenticated.
    const half = await call({ ...bare, ACCESS_AUD: 'aud' });
    ok(half.status === 403 && /not protected/i.test(await half.text()),
      '[gate] ACCESS_AUD WITHOUT team domain -> gate stays closed (no fail-open)');
    ok((await call({ ...bare, ALLOW_UNGATED_SERVICE_TOKEN: '1' })).status === 200, '[gate] explicit opt-out -> allowed');
    ok((await call(bare, 'localhost')).status === 200, '[gate] local wrangler dev -> allowed');
    const root = await worker.fetch(new Request('https://w.dev/'), bare as any, ctx);
    const body = await root.text();
    ok(root.status === 403 && /Cloudflare Access/.test(body), '[gate] / teaches Access setup instead of serving the app');
    ok(!body.includes('service-token'), '[gate] the instructions never echo the token');
    // The half-config is ALSO surfaced on the SPA route as a setup blocker (setup.ts) that names the
    // missing var — so the operator learns *why*, not just that reads are refused.
    const halfRoot = await worker.fetch(new Request('https://w.dev/'), { ...bare, ACCESS_AUD: 'aud' } as any, ctx);
    const halfRootBody = await halfRoot.text();
    ok(halfRoot.status === 503 && /ACCESS_TEAM_DOMAIN/.test(halfRootBody), '[gate] ACCESS_AUD without team domain -> setup checklist names the missing var');
  }

  // ================= /rapp/org route (standalone mode; ?refresh bypasses cross-test cache) =================
  rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
  rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } }];
  rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1, state: 1, devs: [{ id: 'd', st: 1 }] }];
  const rEnvS = { ...sEnv, RINGOTEL_API_KEY: 'rt-key' };
  const roCall = (p: string, env2: any = rEnvS) => worker.fetch(new Request(`https://w.dev${p}`), env2 as any, ctx);

  const ro = await roCall(`/rapp/org?domain=${domain}&refresh=ringotel`);
  const rob = await ro.json();
  ok(ro.status === 200 && rob.active === true && rob.orgId === 'RTORG' && rob.appDomain === domain && rob.eligible === true, '[ringotel/org] active → {active,orgId,appDomain,eligible}');
  const roNone = await roCall(`/rapp/org?domain=readable.example&refresh=ringotel`);
  const roNoneB = await roNone.json();
  ok(roNone.status === 200 && roNoneB.active === false && roNoneB.eligible === true, '[ringotel/org] NS-readable but no Ringotel org → {active:false,eligible:true}');
  // The fleet-wide Ringotel key must not answer for a domain this token cannot read in NS.
  ok((await roCall(`/rapp/org?domain=forbidden.example&refresh=ringotel`)).status === 403,
    '[ringotel/org] domain NOT readable in NS → 403 (standalone mode is bounded by NS scope too)');
  ok((await roCall(`/rapp/org?domain=${domain}`, sEnv)).status === 404, '[ringotel/org] no RINGOTEL_API_KEY → 404 (gate)');

  const ru = await roCall(`/rapp/users?domain=${domain}&refresh=ringotel`);
  const rub = await ru.json();
  ok(ru.status === 200 && rub.active === true && rub.users['100'] && rub.users['100'].activated === true && rub.users['100'].presence === 'active' && rub.users['100'].label === 'Online', '[ringotel/users] active → per-ext status map (presence from state)');
  const ruNone = await roCall(`/rapp/users?domain=readable.example&refresh=ringotel`);
  const ruNoneB = await ruNone.json();
  ok(ruNone.status === 200 && ruNoneB.active === false && !ruNoneB.users, '[ringotel/users] NS-readable but no Ringotel org → {active:false}');
  ok((await roCall(`/rapp/users?domain=forbidden.example&refresh=ringotel`)).status === 403,
    '[ringotel/users] domain NOT readable in NS → 403');
  ok((await roCall(`/rapp/users?domain=${domain}`, sEnv)).status === 404, '[ringotel/users] no RINGOTEL_API_KEY → 404 (gate)');

  // ── suffix threading regression guard ──────────────────────────────────────────
  // usersStatusForDomain/usersStatusForDomainFresh must pass resolveRingotelConfig(env).suffix through as
  // usersStatusMap's third argument. If either wrapper regresses to usersStatusMap(users, branchid) —
  // dropping that argument — the suffix silently falls back to the default 'r', and every user in a
  // deployment configured with a DIFFERENT suffix gets falsely flagged 'authname-drift'. Prove this against
  // the LIVE /rapp/users route (not usersStatusMap directly, which only proves the parameter itself
  // works, not that the wrapper threads it) with a non-default suffix and an authname that matches it.
  rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
  rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain }];
  rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1, state: 1, authname: '100x', trunkid: 'T1', trunkstate: 1, created: 1000, stime: 5000, devs: [{ id: 'd', st: 1 }] }];

  // Sanity first: under the DEFAULT suffix ('r', no env override) this exact authname genuinely IS a
  // mismatch — establishes the fixture is discriminating before trusting the override case below.
  const ruDefaultSuffix = await roCall(`/rapp/users?domain=${domain}&refresh=ringotel`, rEnvS);
  const ruDefaultSuffixB = await ruDefaultSuffix.json();
  ok(
    ruDefaultSuffix.status === 200 && (ruDefaultSuffixB.users?.['100']?.health?.flags ?? []).includes('authname-drift'),
    '[ringotel/users] sanity: authname "100x" under default suffix "r" → authname-drift (fixture is discriminating)',
  );

  const suffixEnv = { ...rEnvS, RINGOTEL_ACTIVATION_SUFFIX: 'x' };
  const ruSuffix = await roCall(`/rapp/users?domain=${domain}&refresh=ringotel`, suffixEnv);
  const ruSuffixB = await ruSuffix.json();
  const flags100 = ruSuffixB.users?.['100']?.health?.flags ?? [];
  ok(
    ruSuffix.status === 200 && ruSuffixB.active === true && Array.isArray(flags100) && !flags100.includes('authname-drift'),
    '[ringotel/users] RINGOTEL_ACTIVATION_SUFFIX=x threaded through usersStatusForDomain → authname "100x" NOT flagged authname-drift',
  );

  // ================= /me/status (self-service tier, 2026-07-18) =================
  // Org present + '100' activated (reuse the read-test stub, cache warm from the refresh above); nsUserRec
  // drives the `~` self-resolution (GET /domains/~/users/~ → this record → ext '100').
  rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
  rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain }];
  rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1, state: 1, devs: [{ id: 'd', st: 1 }] }];
  nsUserRec = { user: '100', domain, email: `u@${domain}` };
  const pEnv = { NS_SERVER: 'mock.local', PORTAL_MODE: '1', NS_PORTAL_ISS: ISS, ALLOWED_ORIGINS: 'https://portal.example.com', RINGOTEL_API_KEY: 'rt-key' };
  const basicSelfTok = mkTok({ user_scope: 'Basic User' }); // self principal: fails portal.access, passes portal.self
  const meCall = (p: string, e: any = pEnv, tok: string = basicSelfTok) =>
    worker.fetch(new Request(`https://w.dev${p}`, { headers: { Origin: 'https://portal.example.com', Authorization: `Bearer ${tok}` } }), e as any, ctx);
  {
    const r = await meCall('/me/status');
    ok(r.status === 200, '[me/status] self principal (Basic User) → 200');
    const j = await r.json();
    ok(j.active === true && j.present === true, '[me/status] { active:true, present:true } for an activated own account (ext via ~)');
    // IDOR: a query ext/domain is ignored — identity comes from the `~` wildcard only.
    const r2 = await meCall('/me/status?ext=999&domain=readable.example');
    const j2 = await r2.json();
    ok(r2.status === 200 && JSON.stringify(j) === JSON.stringify(j2), '[me/status] ignores client ext/domain (self-scoped, identical body)');
    // Feature gate: me.appStatus off ⇒ 403 (still admitted as self, but the feature is denied).
    ok((await meCall('/me/status', { ...pEnv, PORTAL_FEATURES: JSON.stringify({ 'me.appStatus': 'off' }) })).status === 403, '[me/status] me.appStatus off → 403');
    // Non-portal env ⇒ fenced (no delegated self surface off-portal).
    ok((await meCall('/me/status', { ...pEnv, PORTAL_MODE: '' })).status !== 200, '[me/status] non-portal env → not served');
    // portal.self off is a TOTAL kill-switch — even an admin (skips the fence) is denied /me/* directly.
    ok((await meCall('/me/status', { ...pEnv, PORTAL_FEATURES: JSON.stringify({ 'portal.self': 'off' }) }, mkTok({ user_scope: 'Reseller' }))).status === 403, '[me/status] portal.self off → 403 even for an admin (total kill-switch)');
    // Regression: /rapp/user (admin) still works after the computeUserStatus refactor.
    const ru2 = await meCall(`/rapp/user?domain=${domain}&ext=100`, pEnv, mkTok({ user_scope: 'Reseller' }));
    const ru2b = await ru2.json();
    ok(ru2.status === 200 && ru2b.active === true && ru2b.ext === '100', '[ringotel/user] admin route intact (active=org-present) post-refactor');
  }

  // ================= /me/app-access (Task 5, self-service sign-in details) =================
  {
    // No bearer ⇒ 401 (portal mode is delegated-only; resolveAuth refuses before any route logic runs).
    const noAuth = await worker.fetch(new Request(`https://w.dev/me/app-access`, { headers: { Origin: 'https://portal.example.com' } }), pEnv as any, ctx);
    ok(noAuth.status === 401, '[me/app-access] no bearer ⇒ 401');

    // POST ⇒ 405 (read-only route; never added to WRITE_PATHS).
    const postRes = await worker.fetch(new Request(`https://w.dev/me/app-access`, { method: 'POST', headers: { Origin: 'https://portal.example.com' } }), pEnv as any, ctx);
    ok(postRes.status === 405, '[me/app-access] rejects POST (not in WRITE_PATHS)');

    // Password mode: no SSO configured, org active, own ext '100' activated with a SIP username.
    rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
    rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain }];
    rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1, state: 1, username: '100r', devs: [{ id: 'd', st: 1 }] }];
    nsUserRec = { user: '100', domain, email: `u@${domain}`, 'account-status': 'standard', 'user-scope': 'Basic User', 'login-username': `100@${domain}` };
    await roCall(`/rapp/users?domain=${domain}&refresh=ringotel`); // warms BOTH the directory + org-users caches

    const r1 = await meCall('/me/app-access');
    ok(r1.status === 200, '[me/app-access] valid self ns_t ⇒ 200');
    const b1 = await r1.json();
    ok(typeof b1.mode === 'string', '[me/app-access] response carries a mode');
    ok(!('password' in b1) && !('qr' in b1), '[me/app-access] response never carries a password or QR');
    ok(b1.present === true && b1.mode === 'password' && b1.username === '100r', '[me/app-access] no SSO configured ⇒ password mode, SIP username from computeUserStatus');
    ok(Array.isArray(b1.downloads) && Array.isArray(b1.hide) && typeof b1.label === 'string', '[me/app-access] carries downloads/hide/label');

    // IDOR: a query domain/ext is ignored — identity comes from the `~` self-wildcard only.
    const r2 = await meCall('/me/app-access?ext=999&domain=readable.example');
    const b2 = await r2.json();
    ok(r2.status === 200 && JSON.stringify(b1) === JSON.stringify(b2), '[me/app-access] ignores client ext/domain (self-scoped, identical body)');

    // SSO mode: bind the org's SSO service to ours and give the caller a usable NS login.
    // The directory refresh is coalesced fleet-wide for ~60s (INDEX_REFRESH_MIN_INTERVAL) so a naive
    // second `refresh=ringotel` call in the same run would silently serve the stale directory cached by
    // an earlier test; evict just the refresh lock so this scenario's org data actually lands.
    clearRefreshLock();
    rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org', params: { sso: '9/netsapiens_sso' } }];
    await roCall(`/rapp/users?domain=${domain}&refresh=ringotel`);
    const ssoEnv = { ...pEnv, RINGOTEL_SSO_SERVICE: 'netsapiens_sso' };
    const r3 = await meCall('/me/app-access', ssoEnv);
    const b3 = await r3.json();
    ok(r3.status === 200 && b3.mode === 'sso' && b3.username === `100@${domain}`, '[me/app-access] SSO bound + usable login ⇒ sso mode, login-username VERBATIM (never assembled as user@domain)');

    // ---- Fix 2: a transient upstream failure must degrade to "we cannot answer", never to a confident
    // WRONG advisory. Both scenarios are SSO-bound (reusing the org from the SSO-mode test just above),
    // where a null self-record or a null eligibility read would otherwise be silently coerced into an
    // affirmative-sounding mode (needs-portal-setup / not-set-up) by the old code.

    // The `~` self-read fails (a momentary NS blip). Even though nsUserRec below describes a perfectly
    // usable SSO login, the Worker must never see it — resolveSelfNsUser swallows the failure and returns
    // record: null, and the handler must not paper over that with `{}`.
    nsUserRec = { user: '100', domain, email: `u@${domain}`, 'account-status': 'standard', 'user-scope': 'Basic User', 'login-username': `100@${domain}` };
    nsSelfReadFail = true;
    const r3d = await meCall('/me/app-access', ssoEnv);
    const b3d = await r3d.json();
    ok(r3d.status === 200 && b3d.present === true && b3d.mode === 'unavailable',
      '[me/app-access] SSO-bound + failed self read (record: null) ⇒ unavailable, not needs-portal-setup');
    ok(!('username' in b3d) && !('appDomain' in b3d),
      '[me/app-access] unavailable-on-self-read-failure carries neither username nor appDomain');
    nsSelfReadFail = false;

    // The self read succeeds (SSO-usable), but the per-ext eligibility read (evaluateEligibilityForExt's
    // own NS-user GET) fails. `eligible` must not be treated as a genuine ineligibility verdict.
    nsEligReadFail = true;
    const r3e = await meCall('/me/app-access', ssoEnv);
    const b3e = await r3e.json();
    ok(r3e.status === 200 && b3e.present === true && b3e.mode === 'unavailable',
      '[me/app-access] SSO-bound + failed eligibility read ⇒ unavailable, not not-set-up');
    ok(!('username' in b3e) && !('appDomain' in b3e),
      '[me/app-access] unavailable-on-eligibility-failure carries neither username nor appDomain');
    nsEligReadFail = false;

    // ---- Advisory modes: route-level coverage (Fix 1's org.appDomain leak lived exactly here — a green
    // suite that only checked `mode` on these two paths is how it shipped). Each asserts absence of
    // BOTH username and appDomain, not merely the right mode, since that's the property Fix 1 restores.

    // needs-portal-setup: still SSO-bound (org from the scenario above), but the NS self-record cannot
    // complete an SSO login at all (no portal access) — fires before eligibility/activation are even
    // considered. The org is ACTIVE and has an appDomain (org.appDomain === domain, set above), so this is
    // exactly the case where the unconditional spread used to leak it.
    nsUserRec = { ...nsUserRec, 'user-scope': 'No Portal' };
    const r3b = await meCall('/me/app-access', ssoEnv);
    const b3b = await r3b.json();
    ok(r3b.status === 200 && b3b.present === true && b3b.mode === 'needs-portal-setup',
      '[me/app-access] SSO bound + user-scope "No Portal" ⇒ needs-portal-setup');
    ok(!('username' in b3b) && !('appDomain' in b3b),
      '[me/app-access] needs-portal-setup carries NEITHER username NOR appDomain');

    // not-set-up: non-SSO path, org active (and its appDomain is set, same as above), but no activated
    // Ringotel user exists for this ext — `resolveAppAccess`'s `!input.activated ⇒ not-set-up` branch.
    nsUserRec = { user: '100', domain, email: `u@${domain}`, 'account-status': 'standard', 'user-scope': 'Basic User' };
    rtUsers = []; // no user record for ext '100' ⇒ computeUserStatus reports not activated
    await roCall(`/rapp/users?domain=${domain}&refresh=ringotel`);
    const r3c = await meCall('/me/app-access'); // pEnv: no RINGOTEL_SSO_SERVICE ⇒ non-SSO path
    const b3c = await r3c.json();
    ok(r3c.status === 200 && b3c.present === true && b3c.mode === 'not-set-up',
      '[me/app-access] non-SSO + not activated ⇒ not-set-up');
    ok(!('username' in b3c) && !('appDomain' in b3c),
      '[me/app-access] not-set-up carries NEITHER username NOR appDomain');

    // Admin third-party projection: /rapp/user returns the SAME app-access projection /me/app-access
    // computes (shared helper ⇒ no drift), gated on ringotel.profileAppAccess (default office_manager, so
    // a reseller has it). Same fixture state (non-SSO, ext 100 not activated ⇒ not-set-up).
    const resTokAA = mkTok({ user_scope: 'Reseller' });
    const ruAA = await meCall(`/rapp/user?domain=${domain}&ext=100`, pEnv, resTokAA);
    const ruAAb = await ruAA.json();
    ok(ruAA.status === 200 && ruAAb.appAccess && ruAAb.appAccess.mode === b3c.mode,
      '[ringotel/user] includes appAccess projection matching /me/app-access for the same user (no drift)');
    ok(!('username' in ruAAb.appAccess) && !('appDomain' in ruAAb.appAccess),
      '[ringotel/user] appAccess advisory mode carries NEITHER username NOR appDomain');
    const ruOff = await meCall(`/rapp/user?domain=${domain}&ext=100`, { ...pEnv, PORTAL_FEATURES: JSON.stringify({ 'ringotel.profileAppAccess': 'off' }) }, resTokAA);
    const ruOffb = await ruOff.json();
    ok(ruOff.status === 200 && !('appAccess' in ruOffb), '[ringotel/user] ringotel.profileAppAccess off ⇒ no appAccess key (status route still serves)');

    // Org inactive (no Ringotel org bound for this domain) ⇒ unavailable; the hide list still resolves
    // (a domain may run another white-label app and still want stock entries hidden).
    clearRefreshLock();
    rtOrgs = [];
    rtBranches = [];
    await roCall(`/rapp/users?domain=${domain}&refresh=ringotel`);
    const r4 = await meCall('/me/app-access', { ...pEnv, PORTAL_APPS_HIDE: 'SNAPmobile Web' });
    const b4 = await r4.json();
    ok(r4.status === 200 && b4.present === false && b4.mode === 'unavailable' && b4.hide[0] === 'SNAPmobile Web', '[me/app-access] no Ringotel org ⇒ unavailable, hide list still resolved');

    // Feature gates: the route carries TWO independent surfaces (sign-in details = me.appAccess, menu
    // customization = me.menuConfig). Either one alone still serves; neither ⇒ 403. With only menus
    // permitted the sign-in fields must be ABSENT, not merely unused by the client.
    {
      const menusOnly = await meCall('/me/app-access', { ...pEnv, PORTAL_FEATURES: JSON.stringify({ 'me.appAccess': 'off' }) });
      const mb = await menusOnly.json();
      ok(menusOnly.status === 200, '[me/app-access] me.appAccess off but me.menuConfig on → still served (menus surface)');
      ok(!('mode' in mb) && !('username' in mb) && !('appDomain' in mb),
        '[me/app-access] menus-only response carries NO sign-in fields');
      ok(mb.menus && mb.menus.apps && Array.isArray(mb.menus.apps.hide) && Array.isArray(mb.menus.apps.add),
        '[me/app-access] menus-only response carries the resolved menu plan');

      const accessOnly = await meCall('/me/app-access', { ...pEnv, PORTAL_FEATURES: JSON.stringify({ 'me.menuConfig': 'off' }) });
      const ab = await accessOnly.json();
      ok(accessOnly.status === 200 && !('menus' in ab) && 'mode' in ab,
        '[me/app-access] me.menuConfig off → sign-in details served, no menu plan');

      ok((await meCall('/me/app-access', { ...pEnv, PORTAL_FEATURES: JSON.stringify({ 'me.appAccess': 'off', 'me.menuConfig': 'off' }) })).status === 403,
        '[me/app-access] BOTH surfaces off → 403');
    }

    // Non-portal env ⇒ fenced (no delegated self surface off-portal).
    ok((await meCall('/me/app-access', { ...pEnv, PORTAL_MODE: '' })).status !== 200, '[me/app-access] non-portal env → not served');

    // Config guard: a malformed PORTAL_APP_DOWNLOADS fails the WHOLE Worker loudly (like featuresConfigError).
    ok((await meCall('/me/app-access', { ...pEnv, PORTAL_APP_DOWNLOADS: 'not json' })).status === 500, '[me/app-access] malformed PORTAL_APP_DOWNLOADS → 500 (fail closed, loud)');

    // No RINGOTEL_API_KEY at all ⇒ 404 (ringotelEnabled gate), matching every other Ringotel route.
    // No app integration configured: the SIGN-IN surface needs it and is gone (404 when that is all the
    // caller was allowed), but MENU customization does not — static add/hide must work for a deployment
    // that runs no app at all, so it still serves with the app state resolved as 'none'.
    ok((await meCall('/me/app-access', { ...pEnv, RINGOTEL_API_KEY: '', PORTAL_FEATURES: JSON.stringify({ 'me.menuConfig': 'off' }) })).status === 404,
      '[me/app-access] no RINGOTEL_API_KEY and no menu surface → 404');
    {
      const noKey = await meCall('/me/app-access', { ...pEnv, RINGOTEL_API_KEY: '' });
      const nb = await noKey.json();
      ok(noKey.status === 200 && nb.menus && nb.menus.apps, '[me/app-access] no RINGOTEL_API_KEY → menu config still served');
      ok(!('mode' in nb) && !('username' in nb), '[me/app-access] ...and it carries no sign-in fields');
    }
    {
      // The app axis resolves to 'none' with no integration, so an app-conditional rule targeting 'none'
      // applies — the case a mirror adopter with no app integration actually configures.
      const menusNoApp = await meCall('/me/app-access', {
        ...pEnv, RINGOTEL_API_KEY: '',
        PORTAL_MENUS: JSON.stringify({ apps: { hide: { app: { ringotel: ['X'], none: ['Y'] } } } }),
      });
      const mb = await menusNoApp.json();
      ok(menusNoApp.status === 200 && mb.menus.apps.hide[0] === 'Y', '[me/app-access] with no integration the app state is "none"');
    }

    // Restore the shared fixture state that later blocks (/me/devices, write routes) depend on. Evict
    // the refresh lock too — the "no org" scenario just cached an empty directory, and a later forced
    // refresh would otherwise coalesce onto that stale (org-less) entry.
    clearRefreshLock();
    rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
    rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain }];
    rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1, state: 1, devs: [{ id: 'd', st: 1 }] }];
    nsUserRec = { user: '100', domain, email: `u@${domain}` };
    await roCall(`/rapp/users?domain=${domain}&refresh=ringotel`);
  }

  // ================= /me/devices + /me/resetPassword: built but default OFF (2026-07-18) =================
  {
    ok((await meCall('/me/devices')).status === 403, '[me/devices] default off → 403');
    const rd = await meCall('/me/devices', { ...pEnv, PORTAL_FEATURES: JSON.stringify({ 'me.devices': 'all' }) });
    ok(rd.status === 200, '[me/devices] enabled via PORTAL_FEATURES → 200 (own devices via ~)');
    ok(Array.isArray((await rd.json()).devices), '[me/devices] returns { devices: [] }');
    const mePost = (p: string, e: any) => worker.fetch(new Request(`https://w.dev${p}`, { method: 'POST', headers: { Origin: 'https://portal.example.com', Authorization: `Bearer ${basicSelfTok}`, 'Content-Type': 'application/json' }, body: '{}' }), e as any, ctx);
    ok((await mePost('/me/resetPassword', pEnv)).status === 403, '[me/resetPassword] default off → 403 (gated, not 405 — WRITE_PATHS wired)');
    // enabled + writable domain: resets the caller's OWN app user ('100' exists in the org).
    const rr = await mePost('/me/resetPassword', { ...pEnv, PORTAL_FEATURES: JSON.stringify({ 'me.resetPassword': 'all' }), RINGOTEL_WRITE_DOMAINS: domain });
    ok(rr.status === 200 && (await rr.json()).ok === true, '[me/resetPassword] enabled + writable → 200 ok (own account, ~-scoped)');
  }

  // ================= write routes: activate / deactivate / reset (delegated) =================
  // Live-mutation is delegated-only + rail-gated. Reseller token (has ringotel.activate via the
  // office_manager default). The stub org binds this domain; nsUserRec drives eligibility.
  rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
  rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain }];
  nsUserRec = { user: '100', srv_code: '', email: `u@${domain}`, 'first-name': 'Test', 'last-name': 'User' };
  nsDevices = [];
  const wEnv = { NS_SERVER: 'mock.local', NS_PORTAL_ISS: ISS, ALLOWED_ORIGINS: '', RINGOTEL_API_KEY: 'rt-key', RINGOTEL_WRITE_DOMAINS: domain };
  const wcall = (path: string, body: any, env2: any = wEnv, tok: string = resellerTok, method = 'POST') =>
    worker.fetch(new Request(`https://w.dev${path}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env2 as any, ctx);

  // Method gate: POST to a GET-only route → 405.
  ok((await dcall('/flow', { Authorization: `Bearer ${resellerTok}` }, 'POST')).status === 405, '[write] POST to a GET-only route → 405');
  // Gate: no RINGOTEL_API_KEY → 404.
  ok((await wcall('/rapp/activate', { domain, ext: '100' }, { NS_SERVER: 'mock.local', NS_PORTAL_ISS: ISS, ALLOWED_ORIGINS: '' })).status === 404, '[write] activate with no RINGOTEL_API_KEY → 404');
  // Write-domain safety rail: empty allowlist refuses all writes (fail-closed).
  ok((await wcall('/rapp/activate', { domain, ext: '100' }, { ...wEnv, RINGOTEL_WRITE_DOMAINS: '' })).status === 403, '[write] activate refused when RINGOTEL_WRITE_DOMAINS empty (fail-closed rail)');
  ok((await wcall('/rapp/activate', { domain, ext: '100' }, { ...wEnv, RINGOTEL_WRITE_DOMAINS: 'other.example' })).status === 403, '[write] activate refused when domain not on the write allowlist');
  // No principal (service mode) → 403 fail-closed.
  {
    const sWrite = { NS_SERVER: 'mock.local', NS_API_TOKEN: 'service-token', ALLOWED_ORIGINS: '', ALLOW_UNGATED_SERVICE_TOKEN: '1', RINGOTEL_API_KEY: 'rt-key', RINGOTEL_WRITE_DOMAINS: domain };
    const r = await worker.fetch(new Request('https://w.dev/rapp/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain, ext: '100' }) }), sWrite as any, ctx);
    ok(r.status === 403, '[write] activate in service mode (no principal) → 403 fail-closed');
  }
  // forceFresh: a write drives a fresh /jwt (revocation-gap close).
  {
    rtUsers = [];
    const before = jwtCalls;
    await wcall('/rapp/activate', { domain, ext: '100' });
    ok(jwtCalls > before, '[write] a write forces a fresh /jwt (jwtCalls incremented — revocation gap)');
  }
  // Happy path: activate a new user → 200 { ok, action:'created' }. nsUserRec carries first/last 'Test'/'User'.
  {
    rtUsers = [];
    rtRpc = [];
    const r = await wcall('/rapp/activate', { domain, ext: '100' });
    const b = await r.json();
    ok(r.status === 200 && b.ok === true && b.action === 'created', '[write] activate (new) → 200 { ok, action:created }');
    const cu = rtRpc.find((c) => c.method === 'createUser');
    ok(cu?.params.name === 'Test User', '[write] createUser gets the composed "First Last" NS name (not the duplicated join)');
  }
  // Reactivation: an EXISTING (deactivated) RT user → updateUser syncs the current NS name + email first.
  {
    rtUsers = [{ id: 'u100', extension: '100', branchid: 'RTBR', name: 'Stale Name', status: 0 }];
    rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain }];
    rtRpc = [];
    const r = await wcall('/rapp/activate', { domain, ext: '100' });
    const b = await r.json();
    ok(r.status === 200 && b.action === 'updated', '[write] activate (existing/deactivated) → 200 { action:updated }');
    const uu = rtRpc.find((c) => c.method === 'updateUser');
    ok(uu?.params.name === 'Test User' && uu?.params.email === `u@${domain}`, '[write] reactivation updateUser syncs NS name + email (overwrites the stale directory name)');
    rtUsers = [];
  }
  // Duplicate self-heal (the live demo 1043 case): same extension has a stale inactive record beside the
  // active one → the write deletes the stale via the REAL RingotelWriteClient.deleteUser and keeps the active.
  {
    rtUsers = [
      { id: 'stale100', extension: '100', branchid: 'RTBR', name: 'Deleted', status: -1 },
      { id: 'live100', extension: '100', branchid: 'RTBR', name: 'Demo', username: '100r', authname: '100r', status: 1 },
    ];
    rtRpc = [];
    const r = await wcall('/rapp/activate', { domain, ext: '100' });
    const b = await r.json();
    const del = rtRpc.find((c) => c.method === 'deleteUser');
    ok(r.status === 200 && b.action === 'updated' && b.rtUserId === 'live100', '[write] duplicate ext → keeps the active record (action updated)');
    ok(del?.params.id === 'stale100', '[write] duplicate ext → deletes the stale inactive record via deleteUser (real write client)');
    rtUsers = [];
  }
  // SIP-identity tie (two records both claim <ext>r) → typed 409 (RingotelWriteError), not a generic 500.
  {
    rtUsers = [
      { id: 'tie1', extension: '100', branchid: 'RTBR', username: '100r', authname: '100r', status: 1 },
      { id: 'tie2', extension: '100', branchid: 'RTBR', username: '100r', authname: '100r', status: -1 },
    ];
    const r = await wcall('/rapp/activate', { domain, ext: '100' });
    ok(r.status === 409, '[write] SIP-identity tie → 409 (typed RingotelWriteError), not 500');
    rtUsers = [];
  }
  // Ineligible: a system user (srv_code non-blank) → 403 with reasons (HARD, non-overridable).
  {
    nsUserRec = { user: '100', srv_code: '99', email: `u@${domain}` };
    const r = await wcall('/rapp/activate', { domain, ext: '100' });
    const b = await r.json();
    ok(r.status === 403 && b.tier === 'hard' && Array.isArray(b.reasons), '[write] activate a system user (srv_code) → 403 ineligible (hard)');
    nsUserRec = { user: '100', srv_code: '', email: `u@${domain}`, 'first-name': 'Test' };
  }
  // Reseller RUNTIME force override: a soft-excluded (SHARED name) user is refused normally but activatable
  // with force:true — and force NEVER bypasses HARD (a system user stays refused).
  {
    rtUsers = [];
    nsUserRec = { user: '100', srv_code: '', email: `u@${domain}`, 'first-name': 'SHARED', 'last-name': 'Line' };
    const blocked = await wcall('/rapp/activate', { domain, ext: '100' });
    ok(blocked.status === 403 && (await blocked.json()).tier === 'soft', '[write] soft-excluded (SHARED name) user → 403 without force');
    rtUsers = [];
    const forced = await wcall('/rapp/activate', { domain, ext: '100', force: true });
    ok(forced.status === 200 && (await forced.json()).action === 'created', '[write] reseller force:true overrides the soft exclusion → 200');
    nsUserRec = { user: '100', srv_code: '9', email: `u@${domain}` };
    ok((await wcall('/rapp/activate', { domain, ext: '100', force: true })).status === 403, '[write] force does NOT override a system user (HARD) → 403');
    nsUserRec = { user: '100', srv_code: '', email: `u@${domain}`, 'first-name': 'Test' };
  }

  // Deactivate (activate:false) → 200 { action:'deactivated' } (RT user stays; NS device deleted).
  // Also syncs the current NS name+email into the remaining directory entry (nsUserRec: first-name 'Test').
  {
    rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1, name: 'Stale Name' }];
    rtRpc = [];
    const r = await wcall('/rapp/activate', { domain, ext: '100', activate: false });
    ok(r.status === 200 && (await r.json()).action === 'deactivated', '[write] deactivate → 200 { action:deactivated }');
    const uu = rtRpc.find((c) => c.method === 'updateUser');
    ok(uu?.params.name === 'Test' && uu?.params.email === `u@${domain}`, '[write] deactivate also syncs NS name + email into the directory entry');
  }
  // Reset requires an existing RT user.
  {
    rtUsers = [];
    ok((await wcall('/rapp/resetPassword', { domain, ext: '100' })).status === 404, '[write] reset with no RT user → 404');
    rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1 }];
    const r = await wcall('/rapp/resetPassword', { domain, ext: '100' });
    ok(r.status === 200 && (await r.json()).action === 'reset', '[write] reset (existing RT user) → 200 { action:reset }');
  }
  // Indicator (read) GET /rapp/user → single-user status.
  {
    rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1, state: 1, devs: [{ id: 'd', st: 1 }] }];
    const r = await wcall('/rapp/user?ext=100', null, wEnv, resellerTok, 'GET');
    const b = await r.json();
    ok(r.status === 200 && b.active === true && b.status && b.status.activated === true, '[write] GET /rapp/user → single-user status indicator');
  }

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
  ok(opt.status === 204 && (opt.headers.get('Access-Control-Allow-Methods') || '').includes('POST'), 'OPTIONS preflight → 204 + CORS allows POST (write routes)');

  // ── /rapp/user: no-ns-device flag ─────────────────────────────────────────
  // The org-users cache (keyed by orgid, warm from earlier tests) doesn't know this ext yet, and
  // computeUserStatus always reads with refresh:false — so prime it with a real refresh=ringotel read
  // first (same pattern as the suffix-threading guard above), THEN hit /rapp/user un-refreshed so
  // it exercises the exact cached path the profile endpoint uses in production.
  const ringotelUserCall = async ({ ext, devices }: { ext: string; devices: unknown }) => {
    rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
    rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain }];
    rtUsers = [{ id: `u${ext}`, extension: ext, branchid: 'RTBR', status: 1, state: 1, authname: `${ext}r`, trunkid: 'T1', trunkstate: 1, created: 1000, stime: 5000, devs: [{ id: 'd', st: 1 }] }];
    nsUserRec = { user: ext, domain, email: `u@${domain}` };
    if (devices === null) {
      nsDevicesFail = true;
      nsDevices = [];
    } else {
      nsDevicesFail = false;
      nsDevices = devices as any[];
    }
    await roCall(`/rapp/users?domain=${domain}&refresh=ringotel`);
    return roCall(`/rapp/user?domain=${domain}&ext=${ext}`);
  };
  const call = async (devices: unknown) => {
    const res = await ringotelUserCall({ ext: '1045', devices });
    return (await res.json()) as { status?: { health?: { flags?: string[]; severity?: string } } };
  };

  const missing = await call([{ device: '1045' }]);
  ok(
    missing.status?.health?.flags?.includes('no-ns-device') === true,
    '[ringotel/user] activated user without <ext>r device → no-ns-device',
  );
  ok(missing.status?.health?.severity === 'broken', '[ringotel/user] no-ns-device → severity broken');

  const present = await call([{ device: '1045r' }]);
  ok(
    present.status?.health?.flags?.includes('no-ns-device') !== true,
    '[ringotel/user] <ext>r device present → no flag',
  );

  const failed = await call(null);
  ok(
    failed.status?.health?.flags?.includes('no-ns-device') !== true,
    '[ringotel/user] device read failure → no flag (absence of evidence is not evidence)',
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
