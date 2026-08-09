/**
 * End-to-end Worker test (offline, no workerd): stubs `caches` + global `fetch` (JWT check + NS
 * reads served from a fixture), crafts a valid ns_t, and drives worker.fetch through the full path
 * — auth → fetchDomainSnapshot → resolveFlow → JSON/HTML. Also checks auth failures + CORS.
 *   tsx src/worker.selftest.ts <snapshot.json> [attendantsDir]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFlow, fetchDomainSnapshot, NsClient, NsApiError, can, toPrincipal, type Snapshot } from '@dszp/netsapiens-lib';
import { indexRefreshLockKey, orgParamsKey, scopeOf } from './ringotel.js';
import { authorisesDeactivation, emailForWrite, nsEventLimitDecision, nsEventsMissingRingotelKey, readNsUser, processNsEventUsers, ROUTES } from './worker.js';
import { resolveFeaturePolicies } from './features.js';
import type { Principal } from '@dszp/netsapiens-lib';
import type { NsEventsConfig } from './nsEvents.js';

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
// The key is scoped per deployment now; none of the envs below set CACHE_SCOPE, so `scopeOf({})` is
// exactly the scope the Worker computes here — and stays right if the default ever changes.
const clearRefreshLock = () => memCache.store.delete(indexRefreshLockKey(scopeOf({})));
// Likewise for the per-org settings overlay (ORG_PARAMS_TTL = 60s in production, never in this stub): a
// scenario that CHANGES an org's params must evict it, or it keeps serving the PREVIOUS scenario's SSO
// state. Called from every rtOrgs reassignment below, so no scenario can inherit another's org settings.
const clearOrgParams = (orgid = 'RTORG') => memCache.store.delete(orgParamsKey(scopeOf({}), orgid));

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
      // The per-org volatile-settings read behind the ssoService/hPIE overlay. Served from the SAME
      // rtOrgs the directory is built from, so the stub can't manufacture an overlay that disagrees with
      // the index by accident -- a disagreement in a test below is then deliberate, and is the bug this
      // whole mechanism exists to fix.
      : method === 'getOrganization' ? rtOrgs.find((o: any) => String(o.id) === String(params?.id))
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
  // Expected graph = the SAME assembly the Worker performs, resolved directly. Hold the input constant and
  // vary only the delivery path, because that is what this assertion is for: it proves the HTTP route does
  // not alter the graph, not that two different snapshot assemblies agree.
  //
  // It used to resolve the raw fixture object instead, and that compared two things at once. The graph
  // builder is TRAVERSAL-ORDER DEPENDENT by design -- `Builder.edge()` collapses an edge whose target is
  // an ancestor on the DFS path into a `↩` reference leaf -- so an input assembled in a different order
  // yields a different, equally valid edge set. The raw fixture and `fetchDomainSnapshot`'s reassembly
  // (embedded attendantDetailsByUser + each AA's own {domain}_{ext} dialplan, in the API's order) differ
  // exactly that way, which produced a two-edge mismatch that read as a route bug and was recorded for
  // months as "fixture drift" against a library commit that had nothing to do with it.
  //
  // ⚠️ THE COST, AND IT IS DELIBERATE: this no longer cross-checks the assembly, so it no longer surfaces
  // that ordering property at all. The property is real and undecided -- see
  // `tools/roadmaps/netsapiens-lib.md` → "the flow graph depends on how the snapshot ARRIVED". The
  // assembly's own coverage belongs in the library, against a known fixture, not here where it fails
  // looking like a Worker fault.
  const expectedSnap = await fetchDomainSnapshot(
    new NsClient({ server: 'mock.local', token: mkTok({ user_scope: 'Reseller' }) }),
    domain,
    { includeDialrules: true },
  );
  const expected = JSON.parse(JSON.stringify(resolveFlow(expectedSnap as any, { kind, ref } as any)));
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
  // Was a SERVICE-mode harness (a stored NS_API_TOKEN, no caller). The standalone product left this repo
  // on 2026-08-09, so the same read surface is exercised by a delegated reseller instead. The assertions
  // below are unchanged on purpose: they cover the READ path — allowlists, Ringotel reads, error shaping —
  // which is portal behaviour and always was. Only the way the caller authenticates changed.
  const sEnv = { NS_SERVER: 'mock.local', NS_PORTAL_ISS: ISS, ALLOWED_ORIGINS: '' };
  const scall = (path: string, method = 'GET') =>
    worker.fetch(new Request(`https://w.dev${path}`, { method, headers: { Authorization: `Bearer ${resellerTok}` } }), sEnv as any, ctx);

  const rd = await scall('/domains');
  const doms = await rd.json();
  ok(rd.status === 200 && Array.isArray(doms) && doms[0]?.domain === domain, '[service] /domains lists scoped domains');

  const re = await scall(`/entities?domain=${domain}`);
  const ents = await re.json();
  const total = ['dids', 'users', 'queues', 'attendants'].reduce((n, k) => n + (ents[k]?.length ?? 0), 0);
  ok(re.status === 200 && total > 0, `[service] /entities?domain → ${total} entities`);

  const rf = await scall(`/flow?domain=${domain}&kind=${kind}&ref=${ref}`);
  ok(rf.status === 200 && JSON.stringify(stripMmd(await rf.json())) === JSON.stringify(expected), '[service] /flow?domain → graph matches');

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
    clearOrgParams(); rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
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

  // ================= /rapp/org route (standalone mode; ?refresh bypasses cross-test cache) =================
  clearOrgParams(); rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
  rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } }];
  rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1, state: 1, devs: [{ id: 'd', st: 1 }] }];
  const rEnvS = { ...sEnv, RINGOTEL_API_KEY: 'rt-key' };
  const roCall = (p: string, env2: any = rEnvS) =>
    worker.fetch(new Request(`https://w.dev${p}`, { headers: { Authorization: `Bearer ${resellerTok}` } }), env2 as any, ctx);

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
  {
    // hPIE is a per-user sign-in detail; this org-level route never resolves a user, so it must not
    // ship it. /me/app-access emits it exactly where it is actionable.
    const orgBody = await (await roCall(`/rapp/org?domain=${domain}`)).json();
    ok(!('hPIE' in orgBody), '[ringotel/org] hPIE is NOT disclosed on the org route');
  }
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
  clearOrgParams(); rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
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
  clearOrgParams(); rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
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
    // portal.self off is a TOTAL kill-switch — even an admin (skips the fence) is denied /me/* directly.
    ok((await meCall('/me/status', { ...pEnv, PORTAL_FEATURES: JSON.stringify({ 'portal.self': 'off' }) }, mkTok({ user_scope: 'Reseller' }))).status === 403, '[me/status] portal.self off → 403 even for an admin (total kill-switch)');
    // Regression: /rapp/user (admin) still works after the computeUserStatus refactor.
    const ru2 = await meCall(`/rapp/user?domain=${domain}&ext=100`, pEnv, mkTok({ user_scope: 'Reseller' }));
    const ru2b = await ru2.json();
    ok(ru2.status === 200 && ru2b.active === true && ru2b.ext === '100', '[ringotel/user] admin route intact (active=org-present) post-refactor');
    // ── fresh vs poll: two flags that used to be one ────────────────────────────────
    // `?fresh=1` had come to mean BOTH "read the Ringotel user list live" AND "skip the NS-side
    // eligibility + app-access reads". That was harmless while only the post-write poll asked for fresh
    // data, but the profile page now asks for it ON LOAD -- and on load those extras are exactly what
    // renders the Force button and the sign-in panel. `?poll=1` now carries the "and give me less"
    // half on its own.
    const admTok = mkTok({ user_scope: 'Reseller' });
    const rFresh = await (await meCall(`/rapp/user?domain=${domain}&ext=100&fresh=1`, pEnv, admTok)).json();
    ok(rFresh.eligibility !== null && rFresh.eligibility !== undefined,
      '[ringotel/user] ?fresh=1 alone STILL computes eligibility — a fresh read must not silently cost the profile its extras');
    const rPoll = await (await meCall(`/rapp/user?domain=${domain}&ext=100&fresh=1&poll=1`, pEnv, admTok)).json();
    ok(rPoll.eligibility === null && rPoll.appAccess === undefined,
      '[ringotel/user] ?poll=1 skips eligibility + appAccess, so the repeat poll stays cheap');
    ok(rPoll.active === true && rPoll.ext === '100',
      '[ringotel/user] the poll still returns the status it exists to fetch');
    // An older cached client that only knows `fresh=1` therefore pays for reads it discards, rather than
    // losing controls it needs. That is the right way round to be wrong during a rollout.
    ok(rFresh.age === 0, '[ringotel/user] a fresh read reports age 0 (the data is current, and says so)');
    const rCached = await (await meCall(`/rapp/user?domain=${domain}&ext=100`, pEnv, admTok)).json();
    ok(typeof rCached.age === 'number', '[ringotel/user] a cached read reports how old its data is');
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
    clearOrgParams(); rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
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
    clearOrgParams(); rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org', params: { sso: '9/netsapiens_sso' } }];
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
    clearOrgParams(); rtOrgs = [];
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
    clearOrgParams(); rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
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
  clearOrgParams(); rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
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
  // Deactivate an extension with NO app record at all, single-connection: today's behaviour is a 200
  // no-op (RT has nothing to touch; the best-effort NS device delete swallows its own 404) — NOT a 404.
  // Pinned deliberately: `resolveWriteConnection` is called with `mayCreate: true` unconditionally for
  // BOTH activate and deactivate, specifically so this stays unchanged. Threading the activate/deactivate
  // flag through would make the single-connection path require an existing record too, silently turning
  // this into a 404 on every live domain — a real behaviour change that needs the owner's sign-off, not
  // a refactor's side effect.
  {
    rtUsers = [];
    const r = await wcall('/rapp/activate', { domain, ext: '999999', activate: false });
    ok(r.status === 200 && (await r.json()).action === 'deactivated',
       '[single] deactivate on an extension with NO app record still 200s { action:deactivated } (mayCreate stays true)');
  }
  // Reset requires an existing RT user.
  {
    rtUsers = [];
    ok((await wcall('/rapp/resetPassword', { domain, ext: '100' })).status === 404, '[write] reset with no RT user → 404');
    rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1 }];
    const r = await wcall('/rapp/resetPassword', { domain, ext: '100' });
    ok(r.status === 200 && (await r.json()).action === 'reset', '[write] reset (existing RT user) → 200 { action:reset }');
  }

  {
    // Single connection, resetting an extension with NO app record: status AND message must be exactly
    // what they were before this feature. A body change is observable to any client parsing it.
    const r = await wcall('/rapp/resetPassword', { domain, ext: '404404' });
    ok(r.status === 404, '[single] reset on an unknown extension still 404s');
    ok((await r.json() as { error?: string }).error === 'No app user to reset for this extension',
       '[single] ...with the pre-existing message, unchanged by multi-connection support');
  }

  // ── write paths on a multi-connection domain ──────────────────────────────────
  {
    // Earlier scenarios above already forced directory refreshes, arming the coalescing lock — without
    // clearing it here resolveForWrite would silently serve the stale single-branch directory instead
    // of the two-connection one this scenario sets up.
    clearRefreshLock();
    const savedBranches = rtBranches, savedUsers = rtUsers;
    // ONE org, TWO connections bound to the same domain. `name` becomes `branchName` in the index.
    rtBranches = [
      { id: 'RTBR', orgid: 'RTORG', name: 'Main', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } },
      { id: 'RTBR2', orgid: 'RTORG', name: 'Warehouse', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } },
    ];
    // The only app record sits on the SECOND connection.
    rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR2', status: 1, state: 1, username: '100r', authname: '100r', devs: [{ id: 'd', st: 1 }] }];

    // Reset targets an EXISTING record → must find it on the second connection and succeed.
    const reset = await wcall('/rapp/resetPassword', { domain, ext: '100' });
    ok(reset.status === 200, '[multi] resetPassword finds an existing record on the second connection');

    // Activating an extension with NO record would CREATE one → no basis to choose → refuse.
    const create = await wcall('/rapp/activate', { domain, ext: '777' });
    ok(create.status === 409, '[multi] activating a NEW user on a multi-connection domain refuses (Half B decides where)');
    ok(/connection/i.test(await create.text()), '[multi] the refusal names connections, not a broken binding');

    // Activating an EXISTING record is fine — its connection is knowable.
    const reactivate = await wcall('/rapp/activate', { domain, ext: '100' });
    ok(reactivate.status === 200, '[multi] re-activating an existing record works on a multi-connection domain');

    // An extension present on BOTH connections is a conflict, refused rather than guessed.
    rtUsers = [
      { id: 'ua', extension: '100', branchid: 'RTBR', status: 1, state: 1, username: '100r', authname: '100r', devs: [] },
      { id: 'ub', extension: '100', branchid: 'RTBR2', status: 1, state: 1, username: '100r', authname: '100r', devs: [] },
    ];
    const clash = await wcall('/rapp/resetPassword', { domain, ext: '100' });
    ok(clash.status === 409, '[multi] an extension on TWO connections refuses the write rather than picking one');

    // Bulk pre-population creates many records at once — on a multi-connection domain there is no basis
    // to choose one for any of them, so buildPrepopPlan refuses before it ever reads NS users. Nothing
    // else in the suite pins this route's status/message; a regression here (e.g. the refusal silently
    // becoming a 403, or losing its "default connection" wording) would pass every other check.
    const prepop = await wcall('/rapp/prepop/apply', { domain });
    ok(prepop.status === 409, '[multi] bulk prepop refuses on a multi-connection domain (409)');
    ok(
      (await prepop.json() as { error?: string }).error === 'This domain has more than one app connection — bulk pre-population needs a default connection',
      '[multi] ...with the message about a missing default connection',
    );

    rtBranches = savedBranches; rtUsers = savedUsers;
  }

  // Indicator (read) GET /rapp/user → single-user status.
  {
    rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR', status: 1, state: 1, devs: [{ id: 'd', st: 1 }] }];
    const r = await wcall('/rapp/user?ext=100', null, wEnv, resellerTok, 'GET');
    const b = await r.json();
    ok(r.status === 200 && b.active === true && b.status && b.status.activated === true, '[write] GET /rapp/user → single-user status indicator');
  }

  // ── the connection name survives to the client, delegated mode (Task 12) ──────────
  // `/rapp/status` in the brief is this route (`/rapp/users`) under its current name. `dcall`'s fixed
  // env carries no RINGOTEL_API_KEY, so it can't reach this route — reuse `wcall` instead, which is the
  // existing delegated (bearer-token) helper that already exercises Ringotel reads/writes just above,
  // with `domain` and `resellerTok` from the same enclosing scope.
  {
    clearRefreshLock();
    const savedBranches = rtBranches, savedUsers = rtUsers;
    rtBranches = [
      { id: 'RTBR', orgid: 'RTORG', name: 'Main', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } },
      { id: 'RTBR2', orgid: 'RTORG', name: 'Warehouse', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } },
    ];
    rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR2', status: 1, state: 1, devs: [] }];

    const r = await wcall(`/rapp/users?domain=${domain}&refresh=ringotel`, null, wEnv, resellerTok, 'GET');
    const b = await r.json() as { users?: Record<string, { connection?: string }> };
    ok(r.status === 200 && b.users?.['100']?.connection === 'Warehouse', '[multi] the connection name survives to the client');

    rtBranches = savedBranches; rtUsers = savedUsers;
  }

  // ── on a conflict, the row carries `warning`, end-to-end through the live route (Task 12 fix round) ──
  // The Worker merges appStatusView onto every /rapp/users row (withConnectionView). This proves that
  // merge actually runs on the live HTTP path — not just in the appAccess/ringotel unit tests — and that
  // a conflicting extension's row is NOT indistinguishable from a clean one that merely happens to sit on
  // "Main": the client must see `warning`, the operator-actionable signal, not a bare connection name it
  // would otherwise render as if it were trustworthy.
  {
    clearRefreshLock();
    const savedBranches = rtBranches, savedUsers = rtUsers;
    rtBranches = [
      { id: 'RTBR', orgid: 'RTORG', name: 'Main', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } },
      { id: 'RTBR2', orgid: 'RTORG', name: 'Warehouse', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } },
    ];
    // Extension '100' has a record on BOTH connections — the conflict case.
    rtUsers = [
      { id: 'ua', extension: '100', branchid: 'RTBR', status: 1, state: 1, devs: [] },
      { id: 'ub', extension: '100', branchid: 'RTBR2', status: 1, state: 1, devs: [] },
    ];

    const r = await wcall(`/rapp/users?domain=${domain}&refresh=ringotel`, null, wEnv, resellerTok, 'GET');
    const b = await r.json() as { users?: Record<string, { connection?: string; warning?: string }> };
    ok(r.status === 200 && b.users?.['100']?.warning === 'connection-conflict', '[multi] a conflicting extension carries `warning` on the live route');

    rtBranches = savedBranches; rtUsers = savedUsers;
  }

  // ── withConnectionView on /rapp/user, BOTH branches (Task 12 fix-wave, whole-branch review) ──────
  // `/rapp/user` is the route behind the ADMIN profile App Status panel — kit.selftest.ts pins the
  // CLIENT reading status.connection/status.warning off this route's body, but nothing before this
  // pinned the SERVER actually emitting them here. Two independent call sites merge the view onto the
  // record: computeUserStatus (the default/cached path) and the `?fresh=1` branch — cover both, since
  // either could silently drop the merge without the other suites noticing.
  {
    clearRefreshLock();
    const savedBranches = rtBranches, savedUsers = rtUsers;
    rtBranches = [
      { id: 'RTBR', orgid: 'RTORG', name: 'Main', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } },
      { id: 'RTBR2', orgid: 'RTORG', name: 'Warehouse', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } },
    ];
    // Extension '100' sits ONLY on the second connection.
    rtUsers = [{ id: 'ux', extension: '100', branchid: 'RTBR2', status: 1, state: 1, devs: [] }];
    // Prime the directory + org-users cache with this scenario: computeUserStatus's cached path
    // hardcodes `refresh: false`, so it can only ever see what a prior refreshed read already cached.
    await wcall(`/rapp/users?domain=${domain}&refresh=ringotel`, null, wEnv, resellerTok, 'GET');

    const cached = await wcall(`/rapp/user?domain=${domain}&ext=100`, null, wEnv, resellerTok, 'GET');
    const cb = await cached.json() as { status?: { connection?: string } };
    ok(cached.status === 200 && cb.status?.connection === 'Warehouse',
       '[multi] /rapp/user (cached path) carries status.connection for a record on the second connection');

    const fresh = await wcall(`/rapp/user?domain=${domain}&ext=100&fresh=1`, null, wEnv, resellerTok, 'GET');
    const fb = await fresh.json() as { status?: { connection?: string } };
    ok(fresh.status === 200 && fb.status?.connection === 'Warehouse',
       '[multi] /rapp/user?fresh=1 (the separately-wired fresh path) also carries status.connection');

    // Extension '100' now sits on BOTH connections — the conflict case.
    rtUsers = [
      { id: 'ua', extension: '100', branchid: 'RTBR', status: 1, state: 1, devs: [] },
      { id: 'ub', extension: '100', branchid: 'RTBR2', status: 1, state: 1, devs: [] },
    ];
    await wcall(`/rapp/users?domain=${domain}&refresh=ringotel`, null, wEnv, resellerTok, 'GET');

    const cachedConflict = await wcall(`/rapp/user?domain=${domain}&ext=100`, null, wEnv, resellerTok, 'GET');
    const ccb = await cachedConflict.json() as { status?: { warning?: string } };
    ok(cachedConflict.status === 200 && ccb.status?.warning === 'connection-conflict',
       '[multi] /rapp/user (cached path) carries status.warning for a conflicting extension');

    const freshConflict = await wcall(`/rapp/user?domain=${domain}&ext=100&fresh=1`, null, wEnv, resellerTok, 'GET');
    const fcb = await freshConflict.json() as { status?: { warning?: string } };
    ok(freshConflict.status === 200 && fcb.status?.warning === 'connection-conflict',
       '[multi] /rapp/user?fresh=1 also carries status.warning for a conflicting extension');

    rtBranches = savedBranches; rtUsers = savedUsers;
  }

  // ================= domain allowlist =================
  const acall = (env2: any, path: string) =>
    worker.fetch(new Request(`https://w.dev${path}`, { headers: { Authorization: `Bearer ${resellerTok}` } }), env2, ctx);
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
  ok((await scall('/health')).status === 200, 'GET /health → 200');
  const opt = await dcall('/flow', { Origin: 'https://portal.example.com' }, 'OPTIONS');
  ok(opt.status === 204 && (opt.headers.get('Access-Control-Allow-Methods') || '').includes('POST'), 'OPTIONS preflight → 204 + CORS allows POST (write routes)');

  // ── /rapp/user: no-ns-device flag ─────────────────────────────────────────
  // The org-users cache (keyed by orgid, warm from earlier tests) doesn't know this ext yet, and
  // computeUserStatus always reads with refresh:false — so prime it with a real refresh=ringotel read
  // first (same pattern as the suffix-threading guard above), THEN hit /rapp/user un-refreshed so
  // it exercises the exact cached path the profile endpoint uses in production.
  const ringotelUserCall = async ({ ext, devices }: { ext: string; devices: unknown }) => {
    clearOrgParams(); rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
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

  // ── processNsEventUsers: each of the three handlers acts on the connection the record sits on ──
  // Task 10 regression guard. locateConnection is unit-tested in isolation (nsEvents.selftest.ts), but
  // nothing proved the three call sites here actually USE its result rather than, say, a reused variable
  // or the domain's first bound connection — exactly the bug class that would slip through on a path that
  // deactivates a real seat. Called DIRECTLY rather than through worker.fetch: handleNsEvent hands this
  // batch to ctx.waitUntil, which is fire-and-forget in production and a no-op stub in this harness, so
  // going through the HTTP path would give no deterministic way to await it.
  {
    clearOrgParams();
    // The directory-refresh lock coalesces forced refreshes within a short window (see its doc comment
    // in ringotel.ts) — many earlier scenarios above already forced one, so without clearing it here
    // resolveForWrite would silently serve a STALE single-branch directory instead of the two-connection
    // one this test sets up next.
    clearRefreshLock();
    // A domain with TWO bound connections — the topology this task exists for. B1 first, B2 second: if a
    // call site fell back to "the first connection" the record on B2 would never be found.
    rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
    rtBranches = [
      { id: 'B1', orgid: 'RTORG', address: domain },
      { id: 'B2', orgid: 'RTORG', address: domain },
    ];
    const ext = '777';
    // The record lives on B2 ONLY. No username/authname set, so repairDeviceForEvent's SIP-identity check
    // has something to report even in 'report' mode (no NS device write required).
    rtUsers = [{ id: 'RTU777', extension: ext, branchid: 'B2', status: 1, name: 'Stale Name' }];
    nsDevicesFail = false;
    nsDevices = [];
    const baseCfg: Omit<NsEventsConfig, 'offboard' | 'deviceRepair'> = {
      intent: 'on', armed: true, domains: [domain], writeRail: [domain],
      baseUrl: 'https://w.dev', pathSecret: 'x', models: ['subscriber'],
      renewHorizonSeconds: 100, targetLifetimeSeconds: 200, allowIps: [], geoSupport: 'yes',
      maxEvents: 40, diagRaw: false, sweepMax: 200, identity: { kind: 'api', token: 'evt-token' },
    };
    const evtEnv = { NS_SERVER: 'mock.local', RINGOTEL_API_KEY: 'rt-key' };

    // 1) Offboarding: a confirmed 404 on the re-read must deactivate the B2 record, not the first
    // bound connection.
    nsUserRec = null;
    rtRpc = [];
    await processNsEventUsers(evtEnv as any, { ...baseCfg, offboard: 'deactivate', deviceRepair: 'off' }, [{ domain, ext }]);
    const deact = rtRpc.find((c) => c.method === 'deactivateUser');
    ok(deact?.params.id === 'RTU777', '[ns-event] offboarding deactivates the record on the connection it actually sits on (B2), not the first bound connection');

    // 2) Identity sync + 3) device repair: the re-read succeeds with a name differing from the Ringotel
    // record's stored name (forces syncIdentity to write) — both must act on the same B2 record.
    nsUserRec = { user: ext, email: `u@${domain}`, 'first-name': 'New', 'last-name': 'Name' };
    rtRpc = [];
    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => {
      lines.push(String(a[0]));
      origLog(...a);
    };
    try {
      await processNsEventUsers(evtEnv as any, { ...baseCfg, offboard: 'deactivate', deviceRepair: 'report' }, [{ domain, ext }]);
    } finally {
      console.log = origLog;
    }
    const upd = rtRpc.find((c) => c.method === 'updateUser');
    ok(
      upd?.params.id === 'RTU777' && upd?.params.name === 'New Name',
      '[ns-event] identity sync updates the record on the connection it actually sits on (B2), not the first bound connection',
    );
    const deviceLine = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((l) => l && l.msg === 'ns-event device' && l.ext === ext);
    ok(
      Array.isArray(deviceLine?.changed) && deviceLine.changed.includes('sip-identity'),
      '[ns-event] device repair finds and reports on the record on the connection it actually sits on (B2), not the first bound connection',
    );
  }

  // ── emailForWrite: the three-state email contract, incl. the masquerade fail-closed rule ──
  // A blank is a REMOVAL to be propagated only when we actually know it is one. Two ways not to know:
  // the read failed, or the session is masked (email is auth-adjacent and may be redacted, not absent).
  {
    const plain = { scope: 'Office Manager' } as unknown as Principal;
    const masked = { scope: 'Basic User', operator: { id: 'op@example.com' } } as unknown as Principal;
    const withEmail = { email: 'user@example.com' };
    ok(emailForWrite(null, '100', plain) === undefined, '[emailForWrite] failed read → undefined (never a removal)');
    // NetSapiens returns the key with an empty value for a user with no address (verified live), so THAT
    // is what "read ok + no address" looks like — not a record with the field missing.
    ok(emailForWrite({ email: '' }, '100', plain) === '', '[emailForWrite] read ok + blank address → \'\' (propagate the removal)');
    ok(emailForWrite({ 'email-address': '' }, '100', plain) === '', '[emailForWrite] a blank ALTERNATE spelling also propagates');
    ok(emailForWrite(withEmail, '100', plain) === 'user@example.com', '[emailForWrite] read ok + address → the address');
    ok(emailForWrite({ email: '' }, '100', masked) === undefined, '[emailForWrite] MASKED + blank → undefined (a redacted field is not a removal)');
    ok(emailForWrite(withEmail, '100', masked) === 'user@example.com', '[emailForWrite] MASKED + address → still trusted (it can only have come from the record)');
    ok(emailForWrite(null, '100', undefined) === undefined, '[emailForWrite] no principal + failed read → undefined');
    ok(emailForWrite({ email: '' }, '100', undefined) === '', '[emailForWrite] no principal (service mode) + blank → \'\'');
    // The unattended-path hole: a projected/permission-limited read can succeed with the field ABSENT.
    // That must read as "unknown", or every event would push a blank address to every user it covered.
    ok(emailForWrite({}, '100', plain) === undefined, '[emailForWrite] no email FIELD at all → undefined (a narrowed read is not a removal)');
    ok(emailForWrite({}, '100', undefined) === undefined, '[emailForWrite] no email FIELD, no principal (the event path) → undefined');
    ok(emailForWrite({ 'name-first-name': 'A' }, '100', undefined) === undefined, '[emailForWrite] a record with other fields but no email field is still unknown');
  }

  // ── readNsUser: 404 vs transient failure ─────────────────────────────────────
  // The rule the entire offboarding feature rests on. A 404 authorises deactivating a user's app
  // access; a 500, a timeout, or a redirect must NEVER be mistaken for one.
  {
    const stub = { get: async () => ({ 'name-first-name': 'Jane' }) };
    const r = await readNsUser(stub as any, 'acme.example', '100');
    ok(r.kind === 'ok' && (r as any).rec['name-first-name'] === 'Jane', '[readNsUser] a 200 with a record is ok, and carries it');
  }
  {
    // A real NsApiError, not a duck-typed plain Error — readNsUser now checks `instanceof NsApiError`
    // (Also-fix #5) rather than casting `.status` off whatever was thrown, so the mock must be the real
    // shape or this test would silently stop discriminating.
    const err = new NsApiError('GET → 404', 404, '/domains/acme.example/users/100', undefined);
    const stub = { get: async () => { throw err; } };
    const r = await readNsUser(stub as any, 'acme.example', '100');
    ok(r.kind === 'gone', '[readNsUser] a 404 is `gone` — the ONLY outcome that may authorise a deactivation');
  }
  {
    const err = new NsApiError('GET → 500', 500, '/domains/acme.example/users/100', undefined);
    const stub = { get: async () => { throw err; } };
    const r = await readNsUser(stub as any, 'acme.example', '100');
    ok(r.kind === 'failed' && (r as any).status === 500, '[readNsUser] a 500 is `failed`, NOT gone — a transient error must never offboard a live user');
  }
  {
    const stub = { get: async () => { throw new Error('network timeout'); } };
    const r = await readNsUser(stub as any, 'acme.example', '100');
    ok(r.kind === 'failed' && (r as any).status === undefined, '[readNsUser] a throw with no status is `failed` with no status');
  }
  {
    const err = new NsApiError('GET → 403', 403, '/domains/acme.example/users/100', undefined);
    const stub = { get: async () => { throw err; } };
    const r = await readNsUser(stub as any, 'acme.example', '100');
    ok(r.kind === 'failed', '[readNsUser] a 403 (scope lost) is `failed` — a narrowed credential must not read as a fleet of deletions');
  }
  {
    // A plain object shaped like an NsApiError (has `.status`) but is NOT one — e.g. a bug elsewhere
    // throwing a bare object, or a differently-typed error that happens to carry a `status` field for
    // an unrelated reason — must NOT be trusted to authorise anything. This is the exact discrimination
    // `instanceof NsApiError` buys over the old untyped cast.
    const fake = Object.assign(new Error('duck-typed 404'), { status: 404 });
    const stub = { get: async () => { throw fake; } };
    const r = await readNsUser(stub as any, 'acme.example', '100');
    ok(r.kind === 'failed' && (r as any).status === undefined, '[readNsUser] a non-NsApiError with a duck-typed .status is `failed` with NO status — it must never be trusted as a 404');
  }
  {
    const stub = { get: async () => null };
    const r = await readNsUser(stub as any, 'acme.example', '100');
    ok(r.kind === 'failed', '[readNsUser] a 200 carrying nothing is `failed` — NS answered, so this is a shape surprise, not evidence of deletion');
  }
  {
    const stub = { get: async () => 'not-an-object' };
    const r = await readNsUser(stub as any, 'acme.example', '100');
    ok(r.kind === 'failed', '[readNsUser] a 200 carrying a non-object is `failed`');
  }
  {
    let seen = '';
    const stub = { get: async (p: string) => { seen = p; return {}; } };
    await readNsUser(stub as any, 'acme example', '10/0');
    ok(seen === '/domains/acme%20example/users/10%2F0', '[readNsUser] domain and extension are percent-encoded into the path');
  }

  // ── authorisesDeactivation: the rule the sweep now shares with the event tier (fix-wave F1) ──────
  {
    ok(authorisesDeactivation({ kind: 'gone' }) === true, '[authorisesDeactivation] gone (confirmed 404) → true, the ONLY case that authorises a deactivation');
    ok(authorisesDeactivation({ kind: 'ok', rec: { x: 1 } }) === false, '[authorisesDeactivation] ok (the candidate still exists) → false — the list that produced it was wrong');
    ok(authorisesDeactivation({ kind: 'failed' }) === false, '[authorisesDeactivation] failed, no status → false — an unresolved read must never be mistaken for a deletion');
    ok(authorisesDeactivation({ kind: 'failed', status: 500 }) === false, '[authorisesDeactivation] failed, with status → still false');
  }

  // ── nsEventLimitDecision: the receiver's rate-limit / verification decision (fix-wave F4) ────────
  {
    ok(nsEventLimitDecision(true, false) === 'proceed', '[nsEventLimitDecision] verified, under budget → proceed');
    ok(nsEventLimitDecision(true, true) === 'accept-drop', '[nsEventLimitDecision] verified (genuine NS delivery), over budget → accept-drop (200), never a delivery error');
    ok(nsEventLimitDecision(false, true) === 'reject-429', '[nsEventLimitDecision] unverified AND over budget → reject-429 (attacker-controlled traffic, safe to throttle loudly)');
    ok(nsEventLimitDecision(false, false) === 'reject-404', '[nsEventLimitDecision] unverified, under budget → reject-404, byte-identical to the not-armed 404');
  }

  // ── nsEventsMissingRingotelKey: the F3-revert diagnosability fix (2026-07-31) ─────────────────────
  // `NS_EVENTS=on` legally arms with no Ringotel key (a design decision, restored — see nsEvents.ts), but
  // every handler wired in today writes through Ringotel, so an armed batch with no key is about to fail
  // on every user. This predicate gates BOTH the once-per-invocation loud log and the per-event failure
  // line's `cause` field in processNsEventUsers; a wrong answer here means either flooding the log with
  // a false alarm or leaving the operator back with no actionable cause — the exact symptom this replaces.
  {
    ok(nsEventsMissingRingotelKey({ RINGOTEL_API_KEY: undefined }, 3) === true, '[nsEventsMissingRingotelKey] armed batch, no key at all → true');
    ok(nsEventsMissingRingotelKey({ RINGOTEL_API_KEY: '' }, 3) === true, '[nsEventsMissingRingotelKey] armed batch, empty-string key → true');
    ok(nsEventsMissingRingotelKey({ RINGOTEL_API_KEY: '   ' }, 3) === true, '[nsEventsMissingRingotelKey] armed batch, whitespace-only key → true (matches the trim() the config parser itself uses)');
    ok(nsEventsMissingRingotelKey({ RINGOTEL_API_KEY: 'rt_live_abc' }, 3) === false, '[nsEventsMissingRingotelKey] armed batch, real key present → false');
    ok(nsEventsMissingRingotelKey({ RINGOTEL_API_KEY: undefined }, 0) === false, '[nsEventsMissingRingotelKey] no key, but an EMPTY batch → false, nothing is about to fail so nothing to warn about');
  }

  // ================= /kit/status — the operator console document =================
  // The gate is `superadmin` by default, so a RESELLER must be refused: that is the whole security
  // property. `boss@…` is a superadmin here; the reseller token's sub is not.
  //
  // Read a body as JSON WITHOUT killing the run when the response is not JSON. `await r.json()` right
  // after a status assertion is a trap: when that assertion fails, the body is the HTML success page,
  // `json()` throws SyntaxError, the process dies on an unhandled rejection, and ~50 later assertions
  // never run and no summary prints — the report is truncated exactly when someone is reading it to find
  // out what broke. Observed on the requireFleetRead and requireAccess mutations.
  const jbody = async (r: Response): Promise<any> => {
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { __notJson: t.slice(0, 120) }; }
  };
  {
    const kEnv = {
      NS_SERVER: 'mock.local', PORTAL_MODE: '1', NS_PORTAL_ISS: ISS,
      ALLOWED_ORIGINS: 'https://portal.example.com',
      PORTAL_SUPERADMINS: 'boss@mock.local', PORTAL_HANDOFF_URL: '',
    };
    const bossTok = mkTok({ user_scope: 'Super User', sub: 'boss@mock.local', user: 'boss', domain: 'mock.local' });
    const resTok = mkTok({ user_scope: 'Reseller' });
    const kcall = (p: string, tok: string, e: any = kEnv) =>
      worker.fetch(new Request(`https://w.dev${p}`, { headers: { Authorization: `Bearer ${tok}`, Origin: 'https://portal.example.com' } }), e as any, ctx);

    const rh = await kcall('/kit/status', bossTok);
    ok(rh.status === 200, '[spk] superadmin GET /kit/status → 200');
    ok((rh.headers.get('content-type') || '').includes('text/html'), '[spk] default format is HTML for the iframe');
    ok((rh.headers.get('Cache-Control') || '') === 'no-store', '[spk] the config document is never cached');
    ok((rh.headers.get('Vary') || '').includes('Authorization'), '[spk] Vary carries Authorization');
    const html = await rh.text();
    // Pin the console's own control, not the product name: the first disjunct was DEAD (productName({}) is
    // "NS Portal Kit") and the second held from <title> alone, so this passed on any page with that title.
    ok(html.includes('id="spkRunChecks"') && html.includes('id="spkpanel-config"'),
      '[spk] the page renders — its own Checks button and Config panel are present, not just a title');

    const rj = await kcall('/kit/status?format=json', bossTok);
    ok(rj.status === 200, '[spk] format=json → 200');
    const doc = await jbody(rj);
    ok(!!doc.deployment && Array.isArray(doc.features) && Array.isArray(doc.settings),
      '[spk] the JSON document carries deployment + features + settings');
    ok(doc.probes === null, '[spk] no probes unless asked');
    ok(doc.features.some((f: any) => f.key === 'kit.status'), '[spk] the console describes itself');

    // /kit/status stays 403 no matter what — it is only ever requested by someone who already got the
    // bundle and clicked the menu item, so a denial there is genuinely actionable and must stay loud.
    // This also proves the 204 below does NOT leak across routes: same principal, same kEnv (someone —
    // boss@mock.local — IS admitted), yet /kit/status still refuses loudly.
    ok((await kcall('/kit/status', resTok)).status === 403,
      '[spk] a RESELLER is refused under the default superadmin gate');
    // /kit/spk.js, by contrast, is fetched speculatively on EVERY page load for EVERY authenticated
    // user — a non-superadmin being refused here is the steady state, not an incident. kEnv names a
    // superadmin (boss@mock.local), this reseller just isn't them (kitStatusLockedReason(env) is null,
    // the policy admits someone), so the routine case: 204, no body, not the loud 403 /kit/status kept
    // one line up.
    {
      const rBundle = await kcall('/kit/spk.js', resTok);
      ok(rBundle.status === 204, '[spk] the bundle route answers a routine not-entitled refusal with a quiet 204, not 403');
      ok((await rBundle.text()) === '', '[spk] and the 204 body is empty');
    }

    // kEnv DOES name a superadmin (boss@mock.local) — this reseller just isn't them. Someone IS
    // admitted, so the 403 must stay terse: appending a reason here would tell an unauthorized caller
    // who else passes, which is exactly the leak kitStatusLockedReason is designed to avoid.
    {
      const resBody = await jbody(await kcall('/kit/status', resTok));
      ok(resBody.error === 'Not authorized: kit.status',
        `[spk] admits-someone refusal stays terse, no reason appended (got: ${resBody.error})`);
      ok(!/PORTAL_SUPERADMINS/.test(resBody.error || ''),
        '[spk] and in particular does not name PORTAL_SUPERADMINS — that would leak who is on the list');
    }

    // No superadmin configured AT ALL ⇒ the default gate admits nobody, not just "not this caller". The
    // refusal must say so and name PORTAL_SUPERADMINS as the setting to fix — the actionable case this
    // whole helper exists for (found live: an operator deployed to dev with the var unset and got a bare
    // 403 with no idea why). Actionable ⇒ kitStatusLockedReason(env) is non-null ⇒ BOTH routes stay a
    // loud 403 — this is the one case where /kit/spk.js does NOT get the quiet-204 treatment above.
    {
      const noSupersEnv = { ...kEnv, PORTAL_SUPERADMINS: '' };
      const r = await kcall('/kit/status', resTok, noSupersEnv);
      ok(r.status === 403, '[spk] no superadmin configured → still 403');
      const body = await jbody(r);
      ok(/PORTAL_SUPERADMINS/.test(body.error || ''),
        `[spk] and the refusal now names PORTAL_SUPERADMINS as the setting to fix (got: ${body.error})`);
      const rBundle = await kcall('/kit/spk.js', resTok, noSupersEnv);
      ok(rBundle.status === 403, '[spk] the bundle route shares the same actionable refusal — no superadmin');
      const bundleBody = await jbody(rBundle);
      ok(/PORTAL_SUPERADMINS/.test(bundleBody.error || ''),
        '[spk] /kit/spk.js names PORTAL_SUPERADMINS too — both routes share the one check');
    }

    // The SECOND gate: a `users:` grant names an account at any scope, so the floor alone cannot keep a
    // domain-locked principal out. requireFleetRead must refuse them even though the policy admits them.
    // This is Fable's 2026-08-07 MEDIUM finding — without it, one customer sees the whole fleet's domains.
    {
      const omTok = mkTok({ user_scope: 'Office Manager', sub: 'om@customer.example', user: 'om', domain: 'customer.example' });
      const grantEnv = { ...kEnv, PORTAL_FEATURES: JSON.stringify({ 'kit.status': { users: ['om@customer.example'] } }) };
      const pol = resolveFeaturePolicies(grantEnv);
      ok(can(toPrincipal({ user: 'om', domain: 'customer.example', sub: 'om@customer.example', user_scope: 'Office Manager' } as any), 'kit.status', pol),
        '[spk] the users: grant DOES admit the named account at the policy layer (so the 403 below is the second gate, not the first)');
      const r = await kcall('/kit/status', omTok, grantEnv);
      ok(r.status === 403, '[spk] a domain-locked account named in users: is STILL refused (requireFleetRead)');
      // Refusals are always JSON (the catch-block shape), regardless of ?format. Anchor on "own domain"
      // specifically, not "reseller"/"superadmin" too — the SUCCESS page legitimately contains both
      // words (kit.status's own feature card renders its gate as "resellers and above" / names
      // superadmins), so an OR across all three would pass against either outcome and prove nothing.
      const body = await jbody(r);
      ok(/own domain/i.test(body.error || ''), '[spk] and the refusal says what is required (requireFleetRead\'s own message, not a phrase the success page also uses)');
      ok((await kcall('/kit/spk.js', omTok, grantEnv)).status === 403,
        '[spk] the bundle is refused on the same gate — bytes never ship to a domain-locked account');
    }

    // A reseller named in a users: grant DOES get in — the escape hatch still works for its real purpose.
    {
      const grantEnv = { ...kEnv, PORTAL_FEATURES: JSON.stringify({ 'kit.status': { users: ['r@mock.local'] } }) };
      const rTok = mkTok({ user_scope: 'Reseller', sub: 'r@mock.local', user: 'r', domain: 'mock.local' });
      ok((await kcall('/kit/status', rTok, grantEnv)).status === 200,
        '[spk] a RESELLER named in users: is admitted (fleet-read scope satisfies the second gate)');
    }

    // Not portal mode ⇒ not served at all, so dia/standalone gains no console.
    const sEnv2 = { NS_SERVER: 'mock.local', NS_PORTAL_ISS: ISS, PORTAL_SUPERADMINS: 'boss@mock.local' };

    // Cloudflare Access and portal-backend mode are mutually exclusive, in opposite directions, and this
    // block asserts BOTH halves — because getting either wrong is a live failure and they are one line
    // apart in `accessConfig`.
    //
    // PORTAL MODE: Access must be IGNORED. Honouring it there is not defence in depth, it is an outage:
    // the Manager Portal loads the injected primary with a plain `<script src>`, which cannot complete an
    // Access login, so the injection dies at step one and every gated route below it is unreachable —
    // while there is nothing for Access to protect, since portal mode never reads a stored NS_API_TOKEN.
    // A previous version of this test asserted the opposite (403), which is how the belief that Access
    // "applies in portal mode" survived: the code path DOES run, so the test passed; the resulting
    // deployment simply could not function.
    {
      const accessEnv = { ...kEnv, ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' };
      const rNoAccess = await kcall('/kit/status', bossTok, accessEnv);
      ok(rNoAccess.status === 200,
        '[spk] portal mode + Access vars set + NO Cf-Access-Jwt-Assertion → still 200: Access is ignored here, not honoured');
      // Not merely a 200 from somewhere: the real page. A blank or error body with a 200 would pass a bare
      // status check while the console was in fact broken.
      ok((await rNoAccess.text()).includes('id="spkRunChecks"'),
        '[spk] and it is the real console, not an empty 200');
      // The injection path itself — the thing an Access gate would actually kill.
      ok((await kcall(`/${'p'}.js`, bossTok, accessEnv)).status === 200,
        '[spk] and the public primary still serves with Access vars set — the <script src> that could never pass Access');

      // Same request shape with Access simply unconfigured, so the 200 above is not just "everything 200s".
      ok((await kcall('/kit/status', bossTok, kEnv)).status === 200,
        '[spk] Access unconfigured (the common case) → console 200s, as before');

    }

    // Classification is a compile-time contract, but assert it: `read` would reintroduce the revocation gap.
    ok(ROUTES['/kit/status'].sensitivity === 'sensitive', '[spk] /kit/status is classified sensitive');

    // A deployment broken in one of the five reportable ways must STILL serve the console, and the console
    // must say what is wrong. This is the whole point of the reordering.
    {
      const brokenEnv = { ...kEnv, PORTAL_MENUS: '{not json' };
      const r = await kcall('/kit/status?format=json', bossTok, brokenEnv);
      ok(r.status === 200, '[spk] a broken PORTAL_MENUS still serves the console');
      const doc = await jbody(r);
      ok(doc.configErrors.length > 0, '[spk] and the console reports the config error');
      ok(doc.configErrors.some((e: any) => /menu/i.test(e.subsystem)), '[spk] naming the right subsystem');
      ok(doc.features.some((f: any) => f.state === 'misconfigured'), '[spk] misconfigured is now a REACHABLE state');
      // Every other route still refuses — the console is a diagnostic surface, not a licence to run broken.
      ok((await kcall('/domains', bossTok, brokenEnv)).status === 500, '[spk] other routes still 500 on it');
    }
    // A malformed PORTAL_APP_DOWNLOADS must not make the console UNREACHABLE (fix-wave F4). /kit/spk.js is
    // served ahead of Group 2, so appAccessConfigError has not run; wrapBundle used to call parseDownloads,
    // which THROWS on bad JSON — a non-HttpError, so the console route's catch answered a bare
    // {"error":"Request failed"}, the injected primary silently dropped the non-200, and the operator lost
    // the menu entry leading to the one page that names the broken setting. Both halves must survive.
    {
      const dlEnv = { ...kEnv, PORTAL_APP_DOWNLOADS: '{not json' };
      const rb = await kcall('/kit/spk.js', bossTok, dlEnv);
      ok(rb.status === 200, '[spk] a malformed PORTAL_APP_DOWNLOADS still serves the console BUNDLE — the menu entry survives');
      ok(!(await rb.text()).includes('not json'), '[spk] and the broken value is not echoed into the served bytes');
      const rd = await kcall('/kit/status?format=json', bossTok, dlEnv);
      ok(rd.status === 200, '[spk] and the document still renders');
      const dlDoc = await jbody(rd);
      ok((dlDoc.configErrors || []).some((e: any) => /app access/i.test(e.subsystem)),
        '[spk] naming the app-access config error, which is the whole point of reaching the page');
      // Every OTHER Group-2-gated route still refuses on it — the console is a diagnostic surface, not a
      // licence to run broken.
      ok((await kcall('/me/status', bossTok, dlEnv)).status === 500, '[spk] while an app-access route still 500s on it');
    }
    // But a broken PORTAL_FEATURES must still refuse: authorization itself is unavailable.
    {
      const noAuthzEnv = { ...kEnv, PORTAL_FEATURES: '{not json' };
      const r = await kcall('/kit/status', bossTok, noAuthzEnv);
      ok(r.status === 500, '[spk] a broken PORTAL_FEATURES refuses the console — we cannot authorize anyone');
      const body = await jbody(r);
      ok(/misconfigured/i.test(body.error || ''), '[spk] with the actionable reason, not a bare failure');
    }
    {
      const badSupersEnv = { ...kEnv, PORTAL_SUPERADMINS: 'not-an-email' };
      ok((await kcall('/kit/status', bossTok, badSupersEnv)).status === 500,
        '[spk] a malformed PORTAL_SUPERADMINS likewise refuses — requireFleetRead cannot evaluate');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
