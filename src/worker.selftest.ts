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
import { domainHash, entryKey } from './onebill.js';
import { authorisesDeactivation, emailForWrite, nsEventLimitDecision, nsEventsMissingRingotelKey, readNsUser, processNsEventUsers, ROUTES } from './worker.js';
import { resolveFeaturePolicies } from './features.js';
import { fakeD1 } from './testkit/fakeD1.js';
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
let domainsCalls = 0;
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
// OneBill stub call counts — the links report must actually reach the API, not answer from nowhere.
// `writes` counts anything that is not a GET: a refusal that still wrote is not a refusal.
const onebillCalls = { token: 0, subscribers: 0, records: 0, subscriptions: 0, writes: 0 };
/** The tenant the OneBill stub serves. Replaced by the hidden-domain block, restored after it. */
/** What `/subscribers/<n>/subscriptions` answers. Empty unless a case sets it — see the mock below. */
let obRecurring: any[] = [];
let obSubs: any[] = [{ accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active', accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: '' }, { key: 'Site', value: '' }] }] }];
/** When set, the NS domain list carries a second domain — the one the hidden-domain block blocks. */
let nsExtraDomain = false;
/** When set, the NS domain list carries an ordinary SECOND domain, blocked by nothing. The edit block
 *  needs one account holding two visible links, and one domain cannot supply two of them. */
let nsEditDomain = false;
/** When set, every NS read UNDER a domain fails 500 — the account route's upstream-failure case.
 *  Scoped to `/domains/<d>/…` on purpose: `/domains` itself must keep answering, or the request never
 *  reaches the snapshot read the test is about. */
let nsSnapFail = false;
/**
 * Every domain a NetSapiens read went UNDER — `/domains/<d>/…`, which is the site list and every part
 * of a snapshot. The account route's visibility refusals must land before any of these: a 403 that
 * still read the domain is not a refusal, it is a leak with a status code on it.
 */
const nsUnderDomain = new Set<string>();
/** When non-zero, the stub /jwt answers with this status — a token that no longer re-validates. */
let jwtFail = 0;
/** `NS:value[/site]|…` from a stub subscriber's PBX groups — the link codec's own format. */
const obExternalId = (x: any): string => ((x.accountAttribute ?? []) as any[])
  .filter((g) => g?.key === 'PBX')
  .map((g) => {
    const f = (k: string): string => String((g.childAttribute ?? []).find((c: any) => c?.key === k)?.value ?? '');
    const v = f('Domain'), q = f('Site');
    return v ? `NS:${v}${q ? `/${q}` : ''}` : '';
  })
  .filter(Boolean).join('|');
const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const nf = () => new Response('[]', { status: 404 });
(globalThis as any).fetch = async (input: string, init?: any) => {
  const uobj = new URL(String(input));
  // OneBill: the OAuth grant and the subscriber search. The default fixture's one account carries a
  // DECLARED-but-blank PBX group (the shape OneBill materialises on every record once the group is
  // configured — see onebill.ts groupSetup), so the report is "every domain unlinked", never "the
  // group is not set up" — the unlinked-join itself is covered exhaustively in onebill.selftest.ts.
  if (uobj.hostname === 'app.onebillsoftware.com') {
    if (uobj.pathname === '/oauth/token') {
      onebillCalls.token++;
      return j({ access_token: 'ob-token', expires_in: 3600 });
    }
    if (uobj.pathname === '/rest/SubscriberService/v1/subscribers') {
      onebillCalls.subscribers++;
      // Only the Active page carries rows; the walk queries each status in turn and merges.
      const status = uobj.searchParams.get('status');
      // The search row carries the DERIVED index, which is how the quick sweep sees links at all —
      // OneBill derives it from the same custom-field group, so the stub does too. A fixture may set
      // its own `externalId` to make the two disagree, which is the drift case worth testing.
      const rows = obSubs.filter((x) => (x.accountStatus ?? 'Active') === status).map((x) => ({ ...x, externalId: x.externalId ?? obExternalId(x) }));
      return j({ subscriber: rows, resultSize: rows.length, totalCount: rows.length });
    }
    const putMatch = uobj.pathname.match(/\/subscribers\/([^/]+)$/);
    if (String(init?.method ?? 'GET') !== 'GET') {
      onebillCalls.writes++;
      // PERSIST the write. `OneBillWriteClient` verifies by reading the record back, so a stub that
      // accepts a PUT and forgets it makes every write fail verification — and the post-apply patch
      // path, which only runs for an account that actually changed, would never be reached at all.
      if (putMatch && String(init?.method) === 'PUT') {
        const n = decodeURIComponent(putMatch[1]!);
        const body = JSON.parse(String(init?.body ?? '{}'));
        obSubs = obSubs.map((x) => (x.accountNumber === n
          ? { ...x, accountAttribute: body.accountAttribute ?? x.accountAttribute, externalId: body.externalId ?? undefined }
          : x));
        return j({ status: 'Success' });
      }
    }
    // Empty by default, because almost every OneBill case here is about LINKS rather than about what
    // an account is billed for. A case that needs recurring lines sets this and restores it.
    if (/\/subscribers\/[^/]+\/subscriptions$/.test(uobj.pathname)) { onebillCalls.subscriptions++; return j({ subscriptions: obRecurring }); }
    const sm = uobj.pathname.match(/\/subscribers\/([^/]+)$/);
    if (sm) { onebillCalls.records++; return j(obSubs.find((x) => x.accountNumber === decodeURIComponent(sm[1]!)) ?? {}); }
    return j({});
  }
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
    if (jwtFail) return new Response('{"code":"invalid"}', { status: jwtFail });
    return new Response('{}', { status: 200 });
  }
  const under = path.match(/^\/domains\/([^/]+)\//);
  if (under) nsUnderDomain.add(decodeURIComponent(under[1]!));
  if (nsSnapFail && /^\/domains\/[^/]+\//.test(path)) return new Response('{"code":"internal","message":"secret upstream trace 0xNSSNAPFAIL"}', { status: 500 });
  if (path === '/domains') {
    domainsCalls += 1;
    if (nsFail500) return new Response('{"code":"internal","message":"secret upstream trace 0xDEADBEEF"}', { status: 500 });
    return j([
      { domain, description: 'Test Domain' },
      ...(nsExtraDomain ? [{ domain: 'blocked.example', description: 'Blocked Domain' }] : []),
      ...(nsEditDomain ? [{ domain: 'second.example', description: 'Second Domain' }] : []),
    ]);
  }
  // A second NS-readable domain with NO Ringotel branch: lets us test 'readable but no org' apart from
  // 'not readable at all', which the NS-scope probe now rejects earlier and for a different reason.
  // The site list behind each domain on the OneBill report. The field is `site`.
  if (/^\/domains\/[^/]+\/sites$/.test(path)) return j([{ site: 'HQ' }]);
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

  // ⚠️ THIS BRANCH NEEDS ITS OWN ENTITY, and used to borrow the one the rest of the suite tests. A ###r
  // token only ever appears where a device is NAMED — a sim-ring parameter — and a queue diagram lists its
  // agents without expanding anyone's ring set, so on a queue-bearing snapshot the token was never there.
  // The whole enrichment branch then skipped, reporting `ok(true, 'skipped')`: a green tick over dead code,
  // which is worse than a red one because nothing ever asks why. So find the entity that can show it.
  const rtProbe = (() => {
    const rules = (raw as any).answerrulesByUser as Record<string, any[]> | undefined;
    for (const [user, list] of Object.entries(rules ?? {})) {
      for (const r of list ?? []) {
        const ps = r?.['simultaneous-ring']?.parameters;
        if (!Array.isArray(ps)) continue;
        const devs = ps.map((p: unknown) => String(p)).filter((p: string) => /^\d+r$/i.test(p));
        if (devs.length) return { user: String(user), exts: [...new Set(devs.map((p) => p.slice(0, -1)))] };
      }
    }
    return null;
  })();
  // A LOUD SKIP, not a silent pass. The committed fixture carries a device-suffixed sim-ring precisely so
  // this runs; an external snapshot passed on the command line may not, and that is a real gap in what
  // that run covered rather than something to nod through.
  ok(!!rtProbe || snapPath !== DEFAULT_SNAP,
    '[ringotel] the fixture names a ###r device in a sim-ring — the only shape that exercises enrichment');
  if (rtProbe) {
    const rtExts = rtProbe.exts;
    // Stub a Ringotel org whose branch.address == this domain, with a user per ###r device.
    clearOrgParams(); rtOrgs = [{ id: 'RTORG', domain, name: 'RT Org' }];
    rtBranches = [{ id: 'RTBR', orgid: 'RTORG', address: domain, provision: { proxy: { paddr: 'sbc.example.net' } } }];
    rtUsers = rtExts.map((e) => ({ id: `u${e}`, extension: e, branchid: 'RTBR', name: `RT ${e}`, devs: [{ id: `d${e}`, st: 0 }] }));

    const rEnv = { ...sEnv, RINGOTEL_API_KEY: 'rt-key' };
    const flow = `https://w.dev/flow?domain=${domain}&kind=user&ref=${rtProbe.user}`;
    // AUTHENTICATED, like every other call in this suite. The old form sent no Authorization header and
    // nobody noticed, because the branch it sat in never ran — a 401 would have read as "no enrichment".
    const rflow = (u: string) => new Request(u, { headers: { Authorization: `Bearer ${resellerTok}` } });
    const rr = await worker.fetch(rflow(flow), rEnv as any, ctx);
    const rg = await rr.json();
    const mmd = String(rg.__mermaid ?? '');
    // Default label "Ringotel"; inline suffix inserted right after an (###r) token.
    ok(rr.status === 200 && /\(\d+r\) \(Ringotel, \d+ device/.test(mmd), `[ringotel] enabled → ###r devices enriched inline (${rtExts.length} ext)`);
    ok(ringotelCalls > 0, '[ringotel] enabled → Ringotel API called (directory + users)');
    // Disable per-request even when configured.
    rtUsers = [];
    const rr0 = await worker.fetch(rflow(`${flow}&enrich=0`), rEnv as any, ctx);
    const before = ringotelCalls;
    const rg0 = await rr0.json();
    ok(ringotelCalls === before, '[ringotel] ?enrich=0 → no Ringotel calls even when configured');
    // ...and the output is the un-enriched diagram, which is what the flag says it is. Asserting only the
    // call count would pass on a cached enriched response served for the opt-out request.
    ok(!/\(Ringotel, /.test(String(rg0.__mermaid ?? '')),
      '[ringotel] ?enrich=0 → and the diagram comes back without the suffix, not from an enriched cache');
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

    // ── CAPTURE WHILE MASQUERADING: a second way to be handed this bundle, and a strictly smaller one ──
    //
    // While masking, `sub` is the MASKED user, so a superadmin stops passing every `users:`-shaped gate —
    // including the console's own. That is correct and must stay: the console reports other customers'
    // domains. But it also means the one capability that only makes sense DURING a masquerade had no way
    // to be expressed, which is what `masked_by_superadmin` is for: masking on, operator a superadmin.
    {
      const masked = mkTok({
        user_scope: 'Office Manager', sub: 'user@cust.local', user: 'user', domain: 'cust.local',
        mask_chain: 'boss@mock.local',
      });
      const rCap = await kcall('/kit/spk.js', masked);
      ok(rCap.status === 200, '[capture] a superadmin masked into another account IS handed the bundle');
      const body = await rCap.text();
      // The tier it gets is the capture flag ALONE. Shipping the console flag to a masked session would
      // hand the console to whoever the operator happens to be masked into.
      ok(/capture:true/.test(body) && !/status:true/.test(body),
        '[capture] carrying the capture flag and NOT the console flag');
      ok(body.includes('_svxStock'), '[capture] and the store it writes to');

      // The console document itself stays refused for that same session — the bundle is not a key to it.
      ok((await kcall('/kit/status', masked)).status === 403,
        '[capture] while the console document stays refused for that same masked session');

      // ⚠️ THE GATE IS THE OPERATOR, NOT THE MASQUERADE. A reseller who is not a superadmin masking into
      // someone gets nothing — otherwise "capture" would be available to anyone who can masquerade at
      // all, which on this platform is a much larger set than the console's audience.
      const maskedByReseller = mkTok({
        user_scope: 'Office Manager', sub: 'user@cust.local', user: 'user', domain: 'cust.local',
        mask_chain: 'someone@else.local',
      });
      ok((await kcall('/kit/spk.js', maskedByReseller)).status === 204,
        '[capture] but a non-superadmin operator masking in gets nothing');
    }

    // ── /kit/menus/resolve — the editor's preview, resolved SERVER-side ──────────────────────────────
    // The route exists so the console never re-implements precedence. These cases pin the two properties
    // that make it worth having: it selects the same rung the runtime would, and it merges the LIVE
    // PORTAL_APPS_HIDE into the apps hide list even though the candidate config knows nothing about it.
    {
      // A candidate shaped like a real config: an app-targeted hide, a scope-targeted add with a default.
      const cand = JSON.stringify({
        apps: { hide: { app: { ringotel: ['SNAPmobile Web'], none: [] } } },
        account: { add: { scopes: { Reseller: [] }, '*': [{ label: 'Email Support', url: 'mailto:s@example.com' }] } },
      });
      const q = (extra: string) => `/kit/menus/resolve?c=${encodeURIComponent(cand)}&${extra}`;
      const legacyEnv = { ...kEnv, PORTAL_APPS_HIDE: 'SNAPbuilder' };

      const rr = await jbody(await kcall(q('domain=acme.example&app=ringotel&scope=Reseller'), bossTok, legacyEnv));
      ok(rr.ok === true, '[resolve] a valid candidate resolves');
      ok(rr.plan.apps.hide.includes('SNAPmobile Web'),
        '[resolve] the app axis selects the rung matching the asked-for app state');
      // The whole reason the route reads PORTAL_APPS_HIDE off the LIVE env rather than the candidate: a
      // preview that omitted this would draw an apps menu this deployment does not have.
      ok(rr.plan.apps.hide.includes('SNAPbuilder'),
        '[resolve] and the live PORTAL_APPS_HIDE is merged in, though the candidate never mentions it');
      ok(rr.appsHide.legacy.join() === 'SNAPbuilder' && rr.appsHide.menus.includes('SNAPmobile Web'),
        '[resolve] with the provenance split the editor needs to attribute each entry');

      // Select-one-rung, not merge: a Reseller gets the empty exemption, NOT the default's entry.
      const res = await jbody(await kcall(q('domain=acme.example&app=ringotel&scope=Reseller'), bossTok, legacyEnv));
      ok(res.plan.account.add.length === 0,
        '[resolve] an empty scope rung is an exemption — the default is not merged into it');
      const om = await jbody(await kcall(q('domain=acme.example&app=ringotel&scope=Office%20Manager'), bossTok, legacyEnv));
      ok(om.plan.account.add.length === 1 && om.plan.account.add[0].label === 'Email Support',
        '[resolve] while an audience no rung names falls through to the default');

      // Switching the asked-for app state changes the answer — the persona picker's whole premise.
      const noneApp = await jbody(await kcall(q('domain=acme.example&app=none&scope=Reseller'), bossTok, legacyEnv));
      ok(!noneApp.plan.apps.hide.includes('SNAPmobile Web'),
        '[resolve] and the other app state selects the other rung');

      // A candidate that does not parse is the normal case while typing one: a verdict, not a 500.
      const bad = await jbody(await kcall('/kit/menus/resolve?c=%7Bnope', bossTok, legacyEnv));
      ok(bad.ok === false && typeof bad.error === 'string',
        '[resolve] an unparseable candidate answers with a verdict rather than failing the request');

      // WHICH RUNG ANSWERED, per half. Without this the console re-derives precedence to draw a chip,
      // which is the thing this endpoint exists to prevent.
      ok(rr.matched.apps.hide[0].axis === 'app' && rr.matched.apps.hide[0].key === 'ringotel',
        '[resolve] the response names the rung that answered, with the key as written');
      ok(res.matched.account.add[0].axis === 'scopes' && res.plan.account.add.length === 0,
        '[resolve] an empty list WITH a source is the exemption idiom, distinguishable from nothing matching');
      ok(om.matched.account.add[0].axis === '*',
        '[resolve] and an audience no rung names is attributed to the default, not left unexplained');
      const bare = await jbody(await kcall(q('domain=acme.example&app=ringotel&scope=Reseller').replace(/&scope=Reseller/, ''), bossTok, legacyEnv));
      ok(Array.isArray(bare.matched.management.add) && bare.matched.management.add.length === 0,
        '[resolve] a half with no config at all reports an empty source list, not a null');
      // ARRAY-shaped from day one. A second integration makes "ringotel active" and "documo active"
      // independent conditions that can both hold, so a half legitimately answers from two app rungs —
      // and widening a scalar then would break a shape the editor already consumes.
      ok(Array.isArray(rr.matched.apps.hide), '[resolve] provenance is a list, sized for the app-axis union that is coming');

      // `app` is a SET on the wire, and a multi-app preview is a legal question now that the axis unions
      // across them. Both spellings — repeated params and a comma-separated one — reach the same set.
      {
        const cand2 = JSON.stringify({ apps: { hide: { app: { ringotel: ['A'], documo: ['B'], none: [] } } } });
        const q2 = (extra: string) => `/kit/menus/resolve?c=${encodeURIComponent(cand2)}&${extra}`;
        const both = await jbody(await kcall(q2('domain=acme.example&app=ringotel&app=documo'), bossTok, kEnv));
        ok(both.plan.apps.hide.includes('A') && both.plan.apps.hide.includes('B'),
          '[resolve] two active apps UNION — neither integration silently loses its entries');
        ok(both.matched.apps.hide.length === 2,
          '[resolve] and both rungs are reported, which is why provenance had to be a list');
        const csv = await jbody(await kcall(q2('domain=acme.example&app=ringotel,documo'), bossTok, kEnv));
        ok(JSON.stringify(csv.plan) === JSON.stringify(both.plan),
          '[resolve] the comma-separated spelling reaches the same set');
        const empty = await jbody(await kcall(q2('domain=acme.example'), bossTok, kEnv));
        ok(empty.plan.apps.hide.length === 0 && empty.matched.apps.hide[0].key === 'none',
          '[resolve] and an empty active set matches `none`, not a default');
      }

      // Same cap as the check route, and for the same reason.
      const big = await kcall(`/kit/menus/resolve?c=${'x'.repeat(9000)}`, bossTok, legacyEnv);
      ok(big.status === 413, '[resolve] an oversized candidate is refused, not parsed');

      // It is console-gated like everything else on this surface.
      ok((await kcall('/kit/menus/resolve?c=%7B%7D', resTok)).status === 403,
        '[resolve] and a caller who cannot open the console cannot call it either');
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

  // ================= /kit/onebill — the links page, its report, and the apply route =================
  // Three routes, one gate chain: 404 when the integration is off, `onebill.view`, then requireFleetRead
  // (the report names every domain in the fleet, so a domain-locked account admitted by a `users:` grant
  // is still refused). Apply adds `onebill.write` + a fresh token on top.
  {
    const obEnv = {
      NS_SERVER: 'mock.local', PORTAL_MODE: '1', NS_PORTAL_ISS: ISS,
      ALLOWED_ORIGINS: 'https://portal.example.com',
      PORTAL_SUPERADMINS: 'boss@mock.local', PORTAL_HANDOFF_URL: '',
      CACHE_SCOPE: 'obtest',
      ONEBILL_TENANT_ID: 'tenant-0000', ONEBILL_CLIENT_SECRET: 'shh',
      ONEBILL_USERNAME: 'api@example.com', ONEBILL_PASSWORD: 'pw',
    };
    // The same deployment with the integration simply not configured — the 404 case.
    const { ONEBILL_TENANT_ID: _t, ONEBILL_CLIENT_SECRET: _s, ONEBILL_USERNAME: _u, ONEBILL_PASSWORD: _p, ...obOff } = obEnv;

    const obBoss = mkTok({ user_scope: 'Super User', sub: 'boss@mock.local', user: 'boss', domain: 'mock.local' });
    const obRes = mkTok({ user_scope: 'Reseller' });
    const obCall = (p: string, tok: string, e: any = obEnv, init: RequestInit = {}) =>
      worker.fetch(new Request(`https://w.dev${p}`, { ...init, headers: { Authorization: `Bearer ${tok}`, Origin: 'https://portal.example.com', ...(init.headers as any) } }), e as any, ctx);

    // ── the page WITHOUT ?domain= answers before any NetSapiens read (Task 14 review) ────────────────
    {
      const before = domainsCalls;
      const r = await obCall('/kit/onebill', obBoss);
      ok(r.status === 200, `[onebill] plain page load answers 200 (${r.status})`);
      ok(domainsCalls === before, '[onebill] and makes no /domains read — only a ?domain= prefilter, the report or an apply pay for it');
      const before2 = domainsCalls;
      const r2 = await obCall('/kit/onebill?domain=' + encodeURIComponent(domain), obBoss);
      ok(r2.status === 200 && domainsCalls === before2 + 1, '[onebill] a ?domain= prefilter reads /domains once to validate it');
    }

    // ── the report ────────────────────────────────────────────────────────────────────────────────
    {
      onebillCalls.token = 0; onebillCalls.subscribers = 0;
      const r = await obCall('/kit/onebill/links', obRes);
      ok(r.status === 200, '[onebill] a reseller GET /kit/onebill/links → 200');
      const body = await jbody(r);
      ok(body.canWrite === false, '[onebill] and canWrite is false — reading a link is reseller work, changing it is not');
      ok(Array.isArray(body.rows) && Array.isArray(body.foreign) && Array.isArray(body.accounts), '[onebill] the report carries rows, foreign links and the account list');
      ok(Array.isArray(body.siteReadFailures), '[onebill] plus any domain whose NS site list would not load');
      ok(Array.isArray(body.failures), '[onebill] and the per-account read failures survive the JSON — a report covering fewer accounts than it claims must say so');
      ok((r.headers.get('Cache-Control') || '') === 'no-store', '[onebill] the report is never stored');
      ok((r.headers.get('Vary') || '').includes('Authorization'), '[onebill] and Vary carries Authorization — it varies by principal');
      ok((body.rows ?? []).some((x: any) => x.domain === domain), '[onebill] the caller\'s own NS-visible domain is listed');
      ok(onebillCalls.token > 0 && onebillCalls.subscribers > 0, '[onebill] and it really read OneBill');

      const rb = await obCall('/kit/onebill/links', obBoss);
      ok((await jbody(rb)).canWrite === true, '[onebill] a named superadmin gets canWrite');

      const rp = await obCall('/kit/onebill', obRes);
      ok(rp.status === 200 && (rp.headers.get('content-type') || '').includes('text/html'), '[onebill] GET /kit/onebill serves the page');
      ok((rp.headers.get('Cache-Control') || '') === 'private, no-store', '[onebill] which is never cached');

      // ── ?domain= prefilter (task 14) ────────────────────────────────────────────────────────────
      // Accepted only when it names a domain THIS caller's own visible set actually contains (compared
      // case-insensitively via normDomain), and rendered back with THAT set's own spelling — never the
      // query string's — so a caller cannot use the reflection to inject an arbitrary attribute value.
      const rNone = await (await obCall('/kit/onebill', obRes)).text();
      ok(!/<body[^>]*\bdata-prefilter=/.test(rNone), '[onebill] no ?domain= at all → no data-prefilter attribute');

      const rKnown = await (await obCall(`/kit/onebill?domain=${encodeURIComponent(domain)}`, obRes)).text();
      ok(rKnown.includes(`data-prefilter="${domain}"`), '[onebill] ?domain= naming the caller\'s own visible domain → rendered into data-prefilter');

      const rCase = await (await obCall(`/kit/onebill?domain=${encodeURIComponent(domain.toUpperCase())}`, obRes)).text();
      ok(rCase.includes(`data-prefilter="${domain}"`), '[onebill] a case difference still matches, and the ORIGINAL (lowercase) spelling is what renders, not the query string\'s');

      const rUnknown = await (await obCall('/kit/onebill?domain=nope.example', obRes)).text();
      ok(!/<body[^>]*\bdata-prefilter=/.test(rUnknown), '[onebill] ?domain= naming a domain outside the caller\'s visible set → dropped, no prefilter rendered');
    }

    // ── off ⇒ the routes do not exist ─────────────────────────────────────────────────────────────
    for (const p of ['/kit/onebill', '/kit/onebill/links', '/kit/onebill/apply']) {
      ok((await obCall(p, obBoss, obOff)).status === 404, `[onebill] ${p} → 404 when the integration is unconfigured`);
    }

    // ── the feature gate, and the fleet-read backstop behind it ───────────────────────────────────
    {
      const offFeature = { ...obEnv, PORTAL_FEATURES: JSON.stringify({ 'onebill.view': 'off' }) };
      ok((await obCall('/kit/onebill/links', obRes, offFeature)).status === 403, '[onebill] onebill.view off → 403 for the reseller');

      // A `users:` grant names an account at ANY scope, so the floor alone cannot keep a domain-locked
      // one out. The report names every domain in the fleet; requireFleetRead is what refuses them.
      const omEnv = { ...obEnv, PORTAL_FEATURES: JSON.stringify({ 'onebill.view': { users: ['om@cust.local'] } }) };
      const omTok = mkTok({ user_scope: 'Office Manager', sub: 'om@cust.local', user: 'om', domain: 'cust.local' });
      const rOm = await obCall('/kit/onebill/links', omTok, omEnv);
      ok(rOm.status === 403, '[onebill] an Office Manager admitted by name is still refused');
      const omErr = (await jbody(rOm)).error || '';
      ok(/reseller scope or a listed superadmin/.test(omErr), '[onebill] with the fleet-read wording, not the feature-gate one');
      ok(/The OneBill Integration page/.test(omErr), '[onebill] and the refusal names THIS page, not "the configuration console"');
    }

    // ── the bundle: a third way to be handed it, and it does not disturb the other two ────────────
    {
      ok((await obCall('/kit/spk.js', obRes)).status === 200,
        '[onebill] a reseller who can see the OneBill page IS handed the console bundle');
      ok((await obCall('/kit/spk.js', obRes, obOff)).status === 204,
        '[onebill] and with OneBill unconfigured that same reseller gets the quiet 204 it always got');
    }

    // ── apply ─────────────────────────────────────────────────────────────────────────────────────
    {
      const post = (tok: string, body: unknown, e: any = obEnv) =>
        obCall('/kit/onebill/apply', tok, e, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

      ok((await obCall('/kit/onebill/apply', obBoss)).status === 405, '[onebill] GET /kit/onebill/apply → 405');
      ok((await obCall('/kit/onebill', obBoss, obEnv, { method: 'POST', body: '{}' })).status === 405, '[onebill] and POST to the page → 405');

      const rRes = await post(obRes, { ops: [] });
      ok(rRes.status === 403 && /onebill\.write/.test((await jbody(rRes)).error || ''),
        '[onebill] a reseller may read the report and may not write it');

      // THE GUARD: the allowed target set is derived from the report this request loads, never from the
      // body — so a client-supplied domain that is not in NS can never reach a write.
      const rBad = await post(obBoss, { ops: [{ accountNumber: 'CLI00001', links: [{ domain: 'nope.example' }] }] });
      ok(rBad.status === 400, '[onebill] an op naming a domain outside the caller\'s own NS domains → 400');

      ok((await post(obBoss, { nope: 1 })).status === 400, '[onebill] a body without ops → 400');
      ok((await post(obBoss, { ops: Array.from({ length: 51 }, () => ({ accountNumber: 'CLI00001', links: [] })) })).status === 400,
        '[onebill] more than 50 ops → 400');

      // ⚠️ The op with NOTHING in it is the destructive one: no links means no target to check, and
      // `removeUnlisted` then clears every link on the account named — which is why the account set is
      // bounded by the report too, not just the targets.
      const rGhost = await post(obBoss, { ops: [{ accountNumber: 'CLI09999', links: [], removeUnlisted: true }] });
      ok(rGhost.status === 400, '[onebill] an op naming an account the report does not list → 400, links or no links');
      ok(/CLI09999/.test((await jbody(rGhost)).error || ''), '[onebill] and the refusal names the account it refused');

      // The route's own headers, on the write response too.
      const rOk = await post(obBoss, { ops: [] });
      ok(rOk.status === 200 && (rOk.headers.get('Cache-Control') || '') === 'no-store' && (rOk.headers.get('Vary') || '').includes('Authorization'),
        '[onebill] an empty op list is a no-op 200, never stored and varying by principal');
    }

    // ── quick by default, the audit on demand, and the per-account patch after a write (task 15) ──
    // The default load reads the derived externalId index that rides the subscriber list: one walk, no
    // subscriptions at all. `?mode=full` is the sweep that verifies usage, and it is a different cache
    // entry, so asking for one never answers with the other.
    {
      const mEnv = { ...obEnv, CACHE_SCOPE: 'obmodes' };
      onebillCalls.subscriptions = 0; onebillCalls.subscribers = 0;
      const q = await jbody(await obCall('/kit/onebill/links', obBoss, mEnv));
      ok(q.mode === 'quick', '[onebill] the report a page load gets is the quick one');
      ok(onebillCalls.subscriptions === 0, '[onebill] which reads no subscriptions at all');
      ok(onebillCalls.subscribers > 0, '[onebill] having really walked the subscriber list');
      ok(q.usageStale === true && q.verifiedAt === null && (q.usage ?? []).length === 0,
        '[onebill] with usage empty and honestly labelled unverified until something verifies it');

      const walked = onebillCalls.subscribers;
      await obCall('/kit/onebill/links', obBoss, mEnv);
      ok(onebillCalls.subscribers === walked, '[onebill] a second load inside the window is a cache hit');

      const f = await jbody(await obCall('/kit/onebill/links?mode=full', obBoss, mEnv));
      ok(f.mode === 'full', '[onebill] ?mode=full asks for the audit pass');
      ok(onebillCalls.subscriptions > 0, '[onebill] which is the one that reads subscriptions');
      ok(f.usageStale === false && f.verifiedAt === f.generatedAt, '[onebill] and verifies its own usage');

      const q2 = await jbody(await obCall('/kit/onebill/links', obBoss, mEnv));
      ok(q2.mode === 'quick' && q2.generatedAt === q.generatedAt,
        '[onebill] the quick entry is still its own, and still cached — a full pass does not answer for it, nor evict it');
      // `?refresh=1` inside REFRESH_COOLDOWN_S of the entry it would replace is served from that entry,
      // so the quick entry is aged first: without this the line below asserts the cooldown rather than
      // the overlay borrow it is here for.
      const qKey = [...memCache.store.keys()].find((u) => u.includes('/obmodes/quick/'))!;
      const qEntry = await memCache.store.get(qKey)!.clone().json() as { report: { generatedAt: string } };
      qEntry.report.generatedAt = new Date(Date.parse(qEntry.report.generatedAt) - 120_000).toISOString();
      memCache.store.set(qKey, new Response(JSON.stringify(qEntry), { headers: { 'content-type': 'application/json' } }));
      const q3 = await jbody(await obCall('/kit/onebill/links?refresh=1', obBoss, mEnv));
      ok(q3.verifiedAt === f.generatedAt,
        `[onebill] while the NEXT quick read borrows the full pass's usage, stamped with when that ran (${q3.verifiedAt})`);

      ok((await jbody(await obCall('/kit/onebill/links?mode=sideways', obBoss, mEnv))).mode === 'quick',
        '[onebill] an unrecognised mode reads as quick — the cheap answer is the safe default');
    }

    // A write re-reads ONLY the account it wrote and patches the cached reports with it, so the page's
    // reload right afterwards is a cache hit rather than a second sweep.
    {
      const pEnv = { ...obEnv, CACHE_SCOPE: 'obpatch' };
      await obCall('/kit/onebill/links', obBoss, pEnv);
      const walked = onebillCalls.subscribers;
      onebillCalls.records = 0; onebillCalls.subscriptions = 0;
      const r = await obCall('/kit/onebill/apply', obBoss, pEnv, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [{ accountNumber: 'CLI00001', links: [{ domain }] }] }),
      });
      const rb2 = await jbody(r);
      ok(r.status === 200 && rb2.results?.[0]?.ok === true, `[onebill] the write goes through (${r.status} ${JSON.stringify(rb2).slice(0, 300)})`);
      ok(onebillCalls.subscribers === walked, '[onebill] and the apply answers from the cached report, walking nothing again');
      ok(onebillCalls.subscriptions === 1, '[onebill] the re-read after it reads that ONE account\'s subscriptions');
      await obCall('/kit/onebill/links', obBoss, pEnv);
      ok(onebillCalls.subscribers === walked, '[onebill] and the page\'s reload afterwards is still a cache hit — no sweep to sit through');
    }

    // ── editing a link that already exists: change site, add a site, unlink ────────────────────────
    // Each is ONE op on ONE account carrying that account's OTHER links, so the two removeUnlisted
    // shapes match the record to a list that still holds everything the edit did not touch. What is
    // asserted here is the BOUNDS: an edit on an Active account holding two visible links is allowed,
    // and the same edit on an account carrying a hidden one is refused before any write.
    {
      const edEnv = { ...obEnv, CACHE_SCOPE: 'obedit' };
      const restEnv = { ...obEnv, CACHE_SCOPE: 'obeditrestricted', BLOCKED_DOMAINS: 'second.example' };
      const pbxq = (...pairs: [string, string?][]) => pairs.map(([v, q], i) => ({
        key: 'PBX', aggregator: i + 1,
        childAttribute: [{ key: 'Domain', value: v }, ...(q ? [{ key: 'Site', value: q }] : [])],
      }));
      nsEditDomain = true;
      obSubs = [
        { accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active', accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: '' }, { key: 'Site', value: '' }] }] },
        { accountNumber: 'CLI00030', accountName: 'Two Link Co', accountStatus: 'Active', accountAttribute: pbxq([domain, 'HQ'], ['second.example']) },
      ];
      try {
        const epost = (b: unknown, e: any = edEnv) =>
          obCall('/kit/onebill/apply', obBoss, e, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

        const rep = await jbody(await obCall('/kit/onebill/links', obBoss, edEnv));
        const hqRow = (rep.rows ?? []).find((r: any) => r.domain === domain && r.site === 'HQ');
        const rowAcct = hqRow?.accounts?.[0];
        ok(rowAcct?.accountNumber === 'CLI00030', '[onebill] the site row names the account holding two links');
        ok(JSON.stringify(rowAcct?.links) === JSON.stringify([{ domain, site: 'HQ' }, { domain: 'second.example' }]),
          `[onebill] and that row account carries BOTH of them, which is what an edit sends back (${JSON.stringify(rowAcct?.links)})`);
        ok(rowAcct?.restricted === false, '[onebill] and is not restricted, so the editor is offered');

        onebillCalls.writes = 0;
        const moved = await epost({ ops: [{ accountNumber: 'CLI00030', links: [{ domain: 'second.example' }, { domain }], removeUnlisted: true }] });
        ok(moved.status === 200, '[onebill] change-site → 200: the other link rides along and the write matches');
        const added = await epost({ ops: [{ accountNumber: 'CLI00030', links: [{ domain, site: 'HQ' }, { domain: 'second.example' }, { domain: 'second.example', site: 'HQ' }] }] });
        ok(added.status === 200, '[onebill] add-a-site → 200: the whole list plus one, and nothing removed');
        const unlinked = await epost({ ops: [{ accountNumber: 'CLI00030', links: [{ domain: 'second.example' }], removeUnlisted: true }] });
        ok(unlinked.status === 200, '[onebill] unlink → 200: the other links alone, matched');
        ok(onebillCalls.writes > 0, '[onebill] and the edits really reached OneBill');

        // The same account, seen through a deployment that hides one of its links: every edit is (or
        // rides in) a matching write, and the list the page would send is missing what it cannot see.
        onebillCalls.writes = 0;
        // The three edits above really landed on the stub's record, so put the two links back before
        // asking what a deployment that hides one of them does with the same account.
        obSubs = obSubs.map((x) => (x.accountNumber === 'CLI00030'
          ? { ...x, accountAttribute: pbxq([domain, 'HQ'], ['second.example']), externalId: undefined }
          : x));
        const refused = await epost({ ops: [{ accountNumber: 'CLI00030', links: [{ domain }], removeUnlisted: true }] }, restEnv);
        ok(refused.status === 400, '[onebill] change-site on a RESTRICTED account → 400');
        const refusedErr = (await jbody(refused)).error || '';
        ok(/removeUnlisted is refused/.test(refusedErr), '[onebill] naming the rule');
        ok(!/second\.example/.test(refusedErr), '[onebill] and not the domain it is protecting');
        ok(onebillCalls.writes === 0, '[onebill] with nothing written before the refusal');
      } finally {
        nsEditDomain = false;
        obSubs = [{ accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active', accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: '' }, { key: 'Site', value: '' }] }] }];
      }
    }

    // ── a domain this deployment HIDES: counted in the report, and bounded out of the writes ───────
    // The NS domain list is filtered by ALLOWED/BLOCKED before it reaches OneBill, but the OneBill
    // sweep is tenant-wide — so an account in this tenant can hold a link to a domain the caller is
    // not allowed to be told about. It must be counted and never named, and the write that would
    // silently delete it must be refused.
    {
      const hidEnv = { ...obEnv, CACHE_SCOPE: 'obhidden', BLOCKED_DOMAINS: 'blocked.example' };
      const pbx = (...values: string[]) => values.map((v, i) => ({ key: 'PBX', aggregator: i + 1, childAttribute: [{ key: 'Domain', value: v }] }));
      nsExtraDomain = true;
      obSubs = [
        { accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active', accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: '' }, { key: 'Site', value: '' }] }] },
        { accountNumber: 'CLI00020', accountName: 'Hidden Only Co', accountStatus: 'Active', accountAttribute: pbx('blocked.example') },
        { accountNumber: 'CLI00021', accountName: 'Mixed Co', accountStatus: 'Active', accountAttribute: pbx('blocked.example', domain) },
      ];
      try {
        const r = await obCall('/kit/onebill/links', obBoss, hidEnv);
        const body = await jbody(r);
        const text = JSON.stringify(body);
        ok(body.hiddenLinkCount === 2, `[onebill] the two links to the blocked domain are counted (${body.hiddenLinkCount})`);
        ok(!text.includes('blocked.example'), '[onebill] and the blocked domain is named nowhere in the report');
        for (const f of body.foreign ?? []) ok(f.value !== 'blocked.example', `[onebill] no foreign row names it (row for ${f.account?.accountNumber})`);
        ok(!(body.accounts ?? []).some((a: any) => a.accountNumber === 'CLI00020'),
          '[onebill] an account whose ONLY link is hidden is not offered in the picker');
        ok((body.accounts ?? []).some((a: any) => a.accountNumber === 'CLI00021'),
          '[onebill] while one that also holds a visible link still is');

        const hpost = (body2: unknown) =>
          obCall('/kit/onebill/apply', obBoss, hidEnv, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body2) });

        onebillCalls.writes = 0;
        const rGhost = await hpost({ ops: [{ accountNumber: 'CLI00020', links: [], removeUnlisted: true }] });
        ok(rGhost.status === 400, '[onebill] clearing the account the page cannot name → 400');
        ok(/not an account this page lists/.test((await jbody(rGhost)).error || ''), '[onebill] and the refusal says why');
        ok(onebillCalls.writes === 0, '[onebill] with nothing written');

        const rRestricted = await hpost({ ops: [{ accountNumber: 'CLI00021', links: [{ domain }], removeUnlisted: true }] });
        ok(rRestricted.status === 400, '[onebill] and removeUnlisted on an account carrying a hidden link → 400');
        const restrictedErr = (await jbody(rRestricted)).error || '';
        ok(/removeUnlisted is refused/.test(restrictedErr), '[onebill] naming the rule, not the domain');
        ok(!/blocked\.example/.test(restrictedErr), '[onebill] the refusal still names no hidden domain');
        ok(onebillCalls.writes === 0, '[onebill] and still nothing written');

        const rOkWrite = await hpost({ ops: [{ accountNumber: 'CLI00021', links: [{ domain }] }] });
        ok(rOkWrite.status === 200 && onebillCalls.writes > 0,
          '[onebill] while the same account can still be linked to a domain the caller CAN see');
      } finally {
        nsExtraDomain = false;
        obSubs = [{ accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active', accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: '' }, { key: 'Site', value: '' }] }] }];
      }
    }

    // A BLOCKED domain is hidden even when the caller's own NS token cannot list it (a shared tenant:
    // another reseller's domain, enumerated in BLOCKED_DOMAINS). Without this the link would land in
    // `foreign` as an ordinary stale row and name it.
    {
      const hidEnv = { ...obEnv, CACHE_SCOPE: 'obhidden2', BLOCKED_DOMAINS: 'blocked.example' };
      const pbx = (...values: string[]) => values.map((v, i) => ({ key: 'PBX', aggregator: i + 1, childAttribute: [{ key: 'Domain', value: v }] }));
      nsExtraDomain = false;
      obSubs = [
        { accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active', accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: '' }, { key: 'Site', value: '' }] }] },
        { accountNumber: 'CLI00030', accountName: 'Elsewhere Co', accountStatus: 'Active', accountAttribute: pbx('blocked.example') },
      ];
      try {
        const r = await obCall('/kit/onebill/links', obBoss, hidEnv);
        const body = await jbody(r);
        ok(r.status === 200, `[onebill] report loads with a blocked domain outside the caller's NS scope (${r.status})`);
        ok(body.hiddenLinkCount === 1, `[onebill] the link to it is counted (${body.hiddenLinkCount})`);
        ok(!JSON.stringify(body).includes('blocked.example'), '[onebill] and it is named nowhere, even though this token never listed it');
      } finally {
        obSubs = [{ accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active', accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: '' }, { key: 'Site', value: '' }] }] }];
      }
    }

    // ── the bundle again: an onebill.view-only caller who fails the fleet gate gets the quiet 204 ──
    // /kit/spk.js is fetched speculatively on every page load, so a steady-state refusal must not be a
    // permanent 403 rate. The three /kit/onebill* routes keep the loud one — they are only ever asked
    // for by someone who clicked the menu item.
    {
      const omEnv = { ...obEnv, PORTAL_FEATURES: JSON.stringify({ 'onebill.view': { users: ['om@cust.local'] } }) };
      const omTok = mkTok({ user_scope: 'Office Manager', sub: 'om@cust.local', user: 'om', domain: 'cust.local' });
      ok((await obCall('/kit/spk.js', omTok, omEnv)).status === 204,
        '[onebill] a domain-locked caller admitted only to onebill.view is refused the bundle quietly');
      ok((await obCall('/kit/onebill/links', omTok, omEnv)).status === 403,
        '[onebill] and loudly on the page route itself');
    }

    // -- GET /kit/onebill/account ------------------------------------------------------------------
    {
      const r404 = await obCall('/kit/onebill/account?domain=' + encodeURIComponent(domain), obBoss, obOff);
      ok(r404.status === 404, '[onebill] the account route does not exist when the integration is off');

      // EXACTLY ONE selector. Neither is a request with no subject; both is two subjects that can
      // disagree, and ranking them would make which one wins a thing to remember rather than to read.
      const rNoDom = await obCall('/kit/onebill/account', obBoss);
      ok(rNoDom.status === 400, '[onebill] the account route needs a ?domain= or an ?account=');
      const rBoth = await obCall(`/kit/onebill/account?domain=${encodeURIComponent(domain)}&account=CLI00001`, obBoss);
      ok(rBoth.status === 400, '[onebill] and refuses both at once rather than picking one');
      const rBadAcct = await obCall('/kit/onebill/account?account=' + encodeURIComponent('CLI 0001; drop'), obBoss);
      ok(rBadAcct.status === 400, '[onebill] an account number outside the allowed character set never reaches the report');

      const rHidden = await obCall('/kit/onebill/account?domain=' + encodeURIComponent('not-mine.example'), obBoss);
      ok(rHidden.status === 403, '[onebill] a domain outside the visible set is 403, not 409 - "you may not ask" comes before "there is nothing to say"');

      const rUnlinked = await obCall('/kit/onebill/account?domain=' + encodeURIComponent(domain), obBoss);
      ok(rUnlinked.status === 409, '[onebill] an unlinked domain is 409 (the fake tenant links nothing)');

      const rMethod = await obCall('/kit/onebill/account?domain=' + encodeURIComponent(domain), obBoss, obEnv, { method: 'POST' });
      ok(rMethod.status === 405, '[onebill] the account route is GET-only');

      const rBad = await obCall('/kit/onebill/account?domain=' + encodeURIComponent(domain), obBoss, { ...obEnv, ONEBILL_RECURRING_RULES: '[{"offer":"x"}]' });
      ok(rBad.status === 503, '[onebill] a malformed rulebook is a 503');
      ok(/ONEBILL_RECURRING_RULES/.test(JSON.stringify(await jbody(rBad))), '[onebill] and the reason names the setting');

      const rDenied = await obCall('/kit/onebill/account?domain=' + encodeURIComponent(domain), obRes, { ...obEnv, PORTAL_FEATURES: '{"onebill.view":"off"}' });
      ok(rDenied.status === 403, '[onebill] onebill.view gates the account route, same as the links route');

      // ── ?account=: the same panel, opened by the account rather than by one of its domains ──────
      // This is the ONLY way to open a site row's account (a domain selector looks for the bare row),
      // and it is the selector the assign route's `viewing` uses, so its bound is the one that matters.
      {
        const acEnv = { ...obEnv, CACHE_SCOPE: 'obacctsel' };
        const savedSubs2 = obSubs;
        // CLI00077 is the case the anti-oracle claim is actually about: a REAL account in this tenant,
        // linked to a real domain, none of which this caller can see. It must be indistinguishable from
        // CLI09999, which exists nowhere at all.
        obSubs = [
          {
            accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active',
            accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: domain }, { key: 'Site', value: '' }] }],
          },
          {
            accountNumber: 'CLI00077', accountName: 'Another Reseller Co', accountStatus: 'Active',
            accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: 'elsewhere.example' }, { key: 'Site', value: '' }] }],
          },
        ];
        try {
          const rAcc = await obCall('/kit/onebill/account?account=CLI00001', obBoss, acEnv);
          ok(rAcc.status === 200, `[onebill] ?account= opens the panel for an account holding a visible domain (${rAcc.status})`);
          const ab = await jbody(rAcc);
          ok(Array.isArray(ab.scopes) && ab.scopes.length === 1 && ab.scopes[0].domain === domain,
            '[onebill] and answers with the account\'s whole scope, not just one domain');
          ok(ab.accountNumber === 'CLI00001', '[onebill] under the account number that was asked for');
          // Trimmed before the pattern, like the baseline body's `account` and the assign route's
          // `?viewing=`: the same value reaches the worker by three routes, and a stray space should not
          // make one of them a 400 while the other two are fine.
          const rPad = await obCall('/kit/onebill/account?account=' + encodeURIComponent('  CLI00001  '), obBoss, acEnv);
          ok(rPad.status === 200, `[onebill] and a padded ?account= is trimmed rather than refused (${rPad.status})`);
          ok((await jbody(rPad)).accountNumber === 'CLI00001', '[onebill] resolving to the same account');

          // ── THE ANTI-ORACLE BOUND, at the boundary that makes it true ─────────────────────────────
          // The report is warm now, so anything either call below reads is read BY that call. Both
          // answers are then compared with the account number substituted out: a difference of one
          // word between "exists, not yours" and "does not exist" is the whole oracle.
          nsUnderDomain.clear();
          const obBefore = { ...onebillCalls };
          const rGhost = await obCall('/kit/onebill/account?account=CLI09999', obBoss, acEnv);
          const rTheirs = await obCall('/kit/onebill/account?account=CLI00077', obBoss, acEnv);
          ok(rGhost.status === 409, '[onebill] an account number that exists nowhere is 409');
          ok(rTheirs.status === 409, `[onebill] and so is a real account whose every domain is invisible to this caller (${rTheirs.status})`);
          const ghostRaw = await rGhost.text();
          // Without this the comparison below could pass on two bodies that name nothing at all.
          ok(ghostRaw.includes('CLI09999'), '[onebill] (the refusal does name the number that was asked for, so the comparison below has something to normalise)');
          const ghostText = ghostRaw.replaceAll('CLI09999', '<acct>');
          const theirsText = (await rTheirs.text()).replaceAll('CLI00077', '<acct>');
          ok(ghostText === theirsText,
            `[onebill] and the two bodies are the same to the byte once the number is taken out - nothing distinguishes "not yours" from "not there" (${ghostText} / ${theirsText})`);
          ok(!theirsText.includes('elsewhere.example') && !theirsText.includes('Another Reseller'),
            '[onebill] neither the domain nor the account name leaks into the refusal');
          ok(nsUnderDomain.size === 0, `[onebill] and neither answer read anything under a domain (${[...nsUnderDomain].join(',')})`);
          ok(onebillCalls.subscriptions === obBefore.subscriptions && onebillCalls.records === obBefore.records,
            '[onebill] nor any OneBill subscription or record - the refusal is decided off the report already in hand');
        } finally {
          obSubs = savedSubs2;
        }
      }

      // ── THE ACCOUNT'S OWN VISIBILITY BOUND ───────────────────────────────────────────────────────
      // Every domain the account touches must be visible, or opening it by account number would render
      // another reseller's domain to anyone who knew the number.
      //
      // ⚠️ THIS TEST INJECTS A STATE PRODUCTION CANNOT REACH, deliberately, and says so rather than
      // pretending otherwise. `scope` comes from `report.rows`, `rows` is built from the domain list
      // handed to `loadLinkReport`, and that list is `doms` - and the cache cannot smuggle a wider
      // report in either, because the entry key is `domainHash(domains)`. So the only way to exercise
      // the check is to file a two-domain report under the one-domain key by hand. What is being tested
      // is the check's ORDERING and its silence, so that the day an edit makes it reachable - a wider
      // list passed to loadLinkReport, or a scope derived from RowAccount.links or report.foreign -
      // the refusal already lands before any per-domain read and already names no domain.
      {
        const visScope = 'obacctvis';
        const visEnv = { ...obEnv, CACHE_SCOPE: visScope };
        const savedSubs3 = obSubs;
        nsEditDomain = true;
        obSubs = [{
          accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active',
          accountAttribute: [
            { key: 'PBX', aggregator: 1, childAttribute: [{ key: 'Domain', value: domain }] },
            { key: 'PBX', aggregator: 2, childAttribute: [{ key: 'Domain', value: 'second.example' }] },
          ],
        }];
        try {
          // Build the WIDE report (both domains visible) and file it under the key the NARROW caller
          // below will compute. No snapshot read happens here - the links route reads site lists only.
          await obCall('/kit/onebill/links', obBoss, visEnv);
          const wide = memCache.store.get(entryKey(visScope, 'quick', await domainHash([domain, 'second.example'])).url);
          ok(!!wide, '[onebill] (fixture) the two-domain report really was cached');
          memCache.store.set(entryKey(visScope, 'quick', await domainHash([domain])).url, wide!.clone());

          nsUnderDomain.clear();
          const blockEnv = { ...visEnv, BLOCKED_DOMAINS: 'second.example' };
          const rVis = await obCall('/kit/onebill/account?account=CLI00001', obBoss, blockEnv);
          ok(rVis.status === 403, `[onebill] an account holding a domain outside the visible set is 403 (${rVis.status})`);
          const vb = JSON.stringify(await jbody(rVis));
          ok(!vb.includes('second.example'), '[onebill] and the refusal does not say WHICH domain - it would name one the caller may not know exists');
          ok(nsUnderDomain.size === 0, `[onebill] and nothing was read under any domain on the way to it (${[...nsUnderDomain].join(',')})`);
        } finally {
          nsEditDomain = false;
          obSubs = savedSubs3;
        }
      }

      // An upstream that fails is a 502 that NAMES WHICH SYSTEM failed — the operator's first question is
      // "is this us or them", and a bare 500 makes them go read logs to answer it. The domain must be
      // LINKED to get past the domain->account resolution and reach the reads at all, so the fixture is swapped
      // for one that links it, under its own cache scope so no earlier report answers from cache.
      const savedSubs = obSubs;
      obSubs = [{
        accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active',
        accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: domain }, { key: 'Site', value: '' }] }],
      }];
      nsSnapFail = true;
      try {
        const r502 = await obCall('/kit/onebill/account?domain=' + encodeURIComponent(domain), obBoss, { ...obEnv, CACHE_SCOPE: 'obacct502' });
        ok(r502.status === 502, `[onebill] an NS read that fails under the account route is a 502, not a 500 (${r502.status})`);
        const t502 = await r502.text();
        const b502 = JSON.parse(t502);
        ok(b502.system === 'netsapiens', '[onebill] and the body names the system that failed');
        ok(b502.error === 'NetSapiens read failed', '[onebill] and error is the sentence an operator reads, not the word "upstream"');
        ok(!t502.includes('0xNSSNAPFAIL'), '[onebill] but NOT what the upstream said — the path and its body are logged, never returned');
      } finally {
        nsSnapFail = false;
        obSubs = savedSubs;
      }
    }

    // -- POST /kit/onebill/baseline ----------------------------------------------------------------
    // The body names EXACTLY ONE SUBJECT — a domain or an account — and either way the account is
    // RESOLVED from the link report this request loads and bounded against the caller's own visible
    // set, so `onebill.write` alone cannot record a decision against someone else's account. Naming an
    // account is a lookup key, never a grant: see the account-selector block after this one.
    {
      // The stateful fake, not a recorder: the route's happy path reads the row back after writing it
      // (applyBaselineAction loads the report again to answer), so a stub that forgets what it stored
      // would answer with the row as it was BEFORE the accept and every assertion below would be a lie.
      const { db, history, items } = fakeD1();
      // A rulebook is what makes `seats` a group at all — the comparison has one row per rule, and with
      // no ONEBILL_RECURRING_RULES the account has no groups to accept anything on.
      const rules = '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]';
      const body = { domain, group: 'seats', action: 'accept', all: true };
      const post = (tok: string, e: any = obEnv, b: unknown = body) =>
        obCall('/kit/onebill/baseline', tok, e, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });

      // The gates, none of which reach a domain at all.
      ok((await post(obBoss, obOff)).status === 404, '[onebill] the baseline route does not exist when the integration is off');
      // The three cheap gates below run AHEAD of the fleet-wide /domains read, so a deployment
      // without the feature and a caller whose token no longer re-validates are both refused without
      // costing an upstream call. `domainsCalls` is what proves it.
      const noDb = domainsCalls;
      ok((await post(obBoss)).status === 404, '[onebill] and answers 404 when ONEBILL_DB is unbound - the feature is absent, not broken');
      ok(domainsCalls === noDb, '[onebill] and pays no fleet-wide /domains read to say so');
      // Deliberately a BOUND env: with no database the route is 404 for everyone, so the unbound case
      // could never prove that onebill.write is what refuses a reseller.
      const gateEnv = { ...obEnv, ONEBILL_DB: db, ONEBILL_RECURRING_RULES: rules };
      ok((await post(obRes, gateEnv)).status === 403, '[onebill] a reseller without onebill.write cannot accept a baseline');
      ok((await obCall('/kit/onebill/baseline', obBoss, gateEnv)).status === 405, '[onebill] the baseline route is POST-only');

      // Body shape, checked before any upstream read. WHICH items exist is not decided here — that is
      // applyBaselineAction's job, against the row the report just produced — so these are the shape
      // rules only: a domain, a bounded group, a known action, and exactly one of the three forms.
      ok((await post(obBoss, gateEnv, { group: 'seats', action: 'accept', all: true })).status === 400, '[onebill] a body naming neither a domain nor an account is refused');
      // Both is two subjects that can disagree, and ranking them would make which one wins a thing to
      // remember rather than to read. Same rule the GET already follows.
      ok((await post(obBoss, gateEnv, { ...body, account: 'CLI00001' })).status === 400, '[onebill] and so is one naming both');
      ok((await post(obBoss, gateEnv, { group: 'seats', action: 'accept', all: true, account: 'CLI 1; drop' })).status === 400,
        '[onebill] an account outside the allowed character set is refused, like the assign route\'s');
      ok((await post(obBoss, gateEnv, { ...body, action: 'maybe' })).status === 400, '[onebill] action must be accept or clear');
      ok((await post(obBoss, gateEnv, { domain, group: 'seats', action: 'accept' })).status === 400, '[onebill] one of items, all or shortfall is required');
      ok((await post(obBoss, gateEnv, { ...body, items: [{ key: 'ext:100' }] })).status === 400, '[onebill] and only one of them');
      ok((await post(obBoss, gateEnv, { domain, group: 'seats', action: 'accept', items: [] })).status === 400, '[onebill] an empty items list is refused');
      ok((await post(obBoss, gateEnv, { domain, group: 'seats', action: 'accept', items: [{ key: 'x'.repeat(200) }] })).status === 400, '[onebill] an over-long item key is refused');
      ok((await post(obBoss, gateEnv, { ...body, group: 'g'.repeat(65) })).status === 400, '[onebill] an over-long group label is refused, same as an over-long note is trimmed');

      // THE BOUND: a superadmin naming a domain outside their own visible set is refused before the
      // report is even loaded - so the route cannot be used to discover another reseller's accounts.
      ok((await post(obBoss, gateEnv, { ...body, domain: 'not-mine.example' })).status === 403,
        '[onebill] a domain outside the visible set is 403, and an accountNumber in the body cannot get around it');
      // The account selector is bounded too — by 409 for a number this caller's report holds no link
      // for, which is what an account belonging to somebody else looks like from here. Indistinguishable
      // from one that exists nowhere, for the reason the GET's anti-oracle block spells out.
      {
        // The report is warmed FIRST, so that what the refusal itself reads is measurable: a cold link
        // report reads /domains/<d>/sites for every domain, which is the report being built rather than
        // this account being looked into.
        const ghostEnv = { ...gateEnv, CACHE_SCOPE: 'obbaseacct409' };
        await obCall('/kit/onebill/links', obBoss, ghostEnv);
        const beforeOb = { ...onebillCalls };
        nsUnderDomain.clear();
        const theirs = await post(obBoss, ghostEnv, { group: 'seats', action: 'accept', all: true, account: 'CLI09999' });
        ok(theirs.status === 409, `[onebill] an account this caller's report holds no link for is refused (${theirs.status})`);
        ok(nsUnderDomain.size === 0, `[onebill] having read nothing under any domain on the way to it (${[...nsUnderDomain].join(',')})`);
        ok(onebillCalls.subscriptions === beforeOb.subscriptions && onebillCalls.records === beforeOb.records,
          '[onebill] nor bought a single OneBill subscription or record - the refusal comes off the report already in hand');
        ok(history.length === 0 && items.size === 0, '[onebill] with nothing written');
      }
      // And with the default (unlinked) tenant fixture, a visible domain still has no one account.
      ok((await post(obBoss, { ...gateEnv, CACHE_SCOPE: 'obbase409' }, body)).status === 409,
        '[onebill] an unlinked domain is 409 - there is no account to record the decision against');
      ok(history.length === 0, '[onebill] and no history row was written on the way to that refusal');
      ok(items.size === 0, '[onebill] nor any item acceptance');

      // The happy path needs the domain LINKED, so the fixture is swapped for one that links it, under
      // its own cache scope so no earlier report answers from cache.
      const savedSubs = obSubs;
      obSubs = [{
        accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active',
        accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: domain }, { key: 'Site', value: '' }] }],
      }];
      const dbEnv = { ...obEnv, ONEBILL_DB: db, ONEBILL_RECURRING_RULES: rules, CACHE_SCOPE: 'obbaseok' };
      try {
        const good = await post(obBoss, dbEnv);
        ok(good.status === 200, `[onebill] a superadmin with a bound database can accept BY DOMAIN, which still works (${good.status})`);
        const gb = await jbody(good);
        ok(gb.row && gb.row.group === 'seats', '[onebill] and gets the comparison row back, as it now reads');
        ok(typeof gb.row.verdict === 'string', '[onebill] with the verdict recomputed over what was just written');
        ok(items.size > 0, `[onebill] the accepted items were stored (${items.size})`);
        ok([...items.values()].every((r) => r.account_number === 'CLI00001' && r.decided_by === 'boss@mock.local'),
          '[onebill] each bound to the RESOLVED account and the caller from the ns_t');
        const accepts = history.filter((h) => h.table === 'billing_baseline_item_history' && h.args.includes('accept'));
        ok(accepts.length === items.size, `[onebill] and each one left an 'accept' history row behind it (${accepts.length})`);

        // applyBaselineAction's verdicts are the ROUTE's verdicts: a 409 raised inside it must arrive
        // as a 409, not as the generic 500 an unmapped throw would become. The two it can raise.
        const badGroup = await post(obBoss, dbEnv, { ...body, group: 'nope' });
        ok(badGroup.status === 409, `[onebill] a group that is not on this account is a 409, not a 500 (${badGroup.status})`);
        const badItem = await post(obBoss, dbEnv, { domain, group: 'seats', action: 'accept', items: [{ key: 'ext:999999' }] });
        ok(badItem.status === 409, `[onebill] and so is an item key the row does not carry (${badItem.status})`);
        ok(/ext:999999/.test(JSON.stringify(await jbody(badItem))), '[onebill] refused by name, so the operator knows which one moved');

        // The two body fields that would be an escalation if they were trusted.
        history.length = 0;
        const spoof = await post(obBoss, dbEnv, { ...body, action: 'clear', accountNumber: 'CLI09999', decidedBy: 'someone.else@example.com' });
        ok(spoof.status === 200, '[onebill] an accountNumber and a decidedBy in the body are accepted as a request');
        ok(history.length > 0, '[onebill] - and something was actually written, so the checks below have a subject');
        ok(history.every((h) => h.args.includes('boss@mock.local')),
          '[onebill] - but every stored row carries the caller from the ns_t, not the decidedBy in the body');
        ok(history.every((h) => h.args.includes('CLI00001')),
          '[onebill] - and the account the route resolved for itself');
        ok(history.every((h) => !h.args.includes('CLI09999')),
          '[onebill] - never the accountNumber the body asked for');

        // The same revocation gap the apply route closes: a server-side logout must not leave a cached
        // verdict good enough to record a billing decision. Its OWN token string, so the failed verdict
        // this test caches cannot reach any other case.
        const staleTok = mkTok({ user_scope: 'Super User', sub: 'boss@mock.local', user: 'boss', domain: 'mock.local', nonce: 'stale-baseline' });
        jwtFail = 401;
        try {
          const beforeStale = domainsCalls;
          const r = await post(staleTok, dbEnv);
          ok(r.status === 401, `[onebill] a superadmin whose /jwt re-validation fails cannot accept a baseline (${r.status})`);
          ok(domainsCalls === beforeStale, '[onebill] and is refused BEFORE any NetSapiens read - a stale token drives no upstream call');
        } finally {
          jwtFail = 0;
        }
      } finally {
        obSubs = savedSubs;
      }
    }

    // -- POST /kit/onebill/baseline, BY ACCOUNT ----------------------------------------------------
    // THE BUG THIS SELECTOR EXISTS FOR. A panel open on an account that bills one SITE of a domain has
    // no domain that resolves back to it: the domain's BARE row belongs to the whole-domain holder, so a
    // write sent by domain lands on that other account (or 409s where the split has several). The page
    // names the account instead — which is safe because the number is resolved through this caller's own
    // link report and bounded against their visible set, exactly as `?account=` on the GET is.
    {
      const { db, history, items } = fakeD1();
      const rules = '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]';
      const selEnv = { ...obEnv, ONEBILL_DB: db, ONEBILL_RECURRING_RULES: rules, CACHE_SCOPE: 'obbasesel' };
      const post = (b: unknown) =>
        obCall('/kit/onebill/baseline', obBoss, selEnv, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
      const move = (b: unknown, viewing: string) =>
        obCall(`/kit/onebill/assign?viewing=${viewing}`, obBoss, selEnv, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });

      const savedSubs = obSubs;
      // B holds the domain whole; A holds its HQ site (the stub's /sites answers with exactly that one).
      // This is the shape that made the old payload wrong: A's own `domains[0]` IS this domain, and its
      // bare row names B.
      const B = 'CLI00001', A = 'CLI00002';
      obSubs = [
        { accountNumber: B, accountName: 'Acme Co', accountStatus: 'Active',
          accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: domain }, { key: 'Site', value: '' }] }] },
        { accountNumber: A, accountName: 'Acme Branch', accountStatus: 'Active',
          accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: domain }, { key: 'Site', value: 'HQ' }] }] },
      ];
      try {
        const panelA = await jbody(await obCall(`/kit/onebill/account?account=${A}`, obBoss, selEnv));
        ok(panelA.accountNumber === A, `[onebill] (fixture) the site-linked account opens by number (${panelA.accountNumber})`);
        ok(panelA.domain === domain, '[onebill] (fixture) and its only domain is the one B holds whole - which is the trap');

        // Seed A with one item, so it has something to accept: no fixture extension carries a site, so
        // the automatic rule gives the site holder nothing. Through the assign route, because that is
        // how an operator would have got here too.
        const panelB = await jbody(await obCall(`/kit/onebill/account?account=${B}`, obBoss, selEnv));
        const scoped = String(panelB.detail?.extensions?.[0]?.key ?? '');
        const key = scoped.slice(scoped.indexOf('/') + 1);
        ok(/^ext:/.test(key), `[onebill] (fixture) B's panel has an extension to move (${scoped})`);
        ok((await move({ domain, key, accountNumber: A }, B)).status === 200, '[onebill] (fixture) which is moved onto A');

        // THE TEST. Accept on A by account number. Before the fix the page sent A's `domain`, whose bare
        // row is B's — so this write would have landed on B, silently, under a panel headed A.
        history.length = 0;
        const onA = await post({ account: A, group: 'seats', action: 'accept', all: true });
        ok(onA.status === 200, `[onebill] a site-linked account accepts by account number (${onA.status})`);
        const storedA = [...items.values()];
        ok(storedA.length > 0, `[onebill] and something was stored (${storedA.length})`);
        ok(storedA.every((r) => r.account_number === A),
          `[onebill] every row under A, the account the panel was showing (${[...new Set(storedA.map((r) => r.account_number))].join(',')})`);
        ok(!storedA.some((r) => r.account_number === B), '[onebill] and none under B, whose bare row the domain would have resolved to');
        // An every() over an empty list is vacuously true, and this block cleared `history` two lines
        // above — so without this the two assertions below would pass on a write that recorded nothing.
        ok(history.length > 0, `[onebill] and the history was written to (${history.length} rows)`);
        ok(history.every((h) => h.args.includes(A)), '[onebill] the history says A too');
        ok(history.every((h) => !h.args.includes(B)), '[onebill] and never B');

        // The other account, from the same fixture, in the same database: the selector picks between
        // them rather than one of them being what the route always does.
        const beforeB = items.size;
        const onB = await post({ account: B, group: 'seats', action: 'accept', all: true });
        ok(onB.status === 200, `[onebill] and the whole-domain holder accepts by ITS number (${onB.status})`);
        ok(items.size > beforeB, '[onebill] writing rows of its own');
        ok([...items.values()].filter((r) => r.account_number === A).length === storedA.length,
          "[onebill] while A's rows are untouched - two accounts on one domain keep two baselines");
        ok([...items.values()].some((r) => r.account_number === B), '[onebill] and B now has some');

        // The same 409s the domain selector gets, reached through the account one.
        ok((await post({ account: A, group: 'nope', action: 'accept', all: true })).status === 409,
          '[onebill] a group that is not on the named account is still a 409');
      } finally {
        obSubs = savedSubs;
      }
    }

    // -- POST /kit/onebill/baseline: billed as, and the entitlement a group row is judged against ---
    // `offer` says WHICH of the row's plans these items are billed as. It is bounded here like `group`
    // and `note`, and validated against the row's OWN offer list by `applyBaselineAction` — the only
    // place that knows what this account is billed under. `entitled` is not a request field at all: the
    // engine computes it and the group-row write records it, so an entitlement that later goes away
    // invalidates the decision rather than silently keeping it.
    {
      const { db, history, items, groups } = fakeD1();
      // Two rules: one names the seats row, the other bills numbers AND entitles two seats — which is
      // what puts a non-zero `entitled` on the seats row for the group-row write to record.
      const rules = '[{"offer":"Seat","counts":"extensions.total","group":"seats"},'
        + '{"offer":"Bundle","counts":"dids.total","group":"numbers","entitles":{"seats":2}}]';
      const offEnv = { ...obEnv, ONEBILL_DB: db, ONEBILL_RECURRING_RULES: rules, CACHE_SCOPE: 'obbaseoffer' };
      const post = (b: unknown) =>
        obCall('/kit/onebill/baseline', obBoss, offEnv, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });

      const savedSubs = obSubs, savedRec = obRecurring;
      obSubs = [{
        accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active',
        accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: domain }, { key: 'Site', value: '' }] }],
      }];
      const rec = (name: string) => ({ name, quantity: '1', subscriptionCharge: [{ type: 'REC' }] });
      obRecurring = [{ subscriptionId: 'SUB1', subscriptionOffer: [rec('Seat'), rec('Bundle')] }];
      try {
        // A plan this row is not billed under is a 409 that names what it IS billed under — the reader
        // has to be able to see what they could have meant.
        const wrong = await post({ account: 'CLI00001', group: 'seats', action: 'accept', all: true, offer: 'Nope' });
        ok(wrong.status === 409, `[onebill] an offer the row does not carry is a 409 (${wrong.status})`);
        const wrongText = JSON.stringify(await jbody(wrong));
        ok(/Nope/.test(wrongText), '[onebill] naming what was asked for');
        ok(/Seat/.test(wrongText), '[onebill] and the offers the row actually carries');
        ok(items.size === 0 && history.length === 0, '[onebill] with nothing written on the way to it');

        // The bound, proved through that same refusal: the message can only echo what the route kept.
        const longOffer = 'X'.repeat(200);
        const tooLong = await post({ account: 'CLI00001', group: 'seats', action: 'accept', all: true, offer: longOffer });
        ok(tooLong.status === 409, '[onebill] an over-long offer is refused as an unknown offer, not accepted');
        const longText = JSON.stringify(await jbody(tooLong));
        ok(longText.includes('X'.repeat(128)) && !longText.includes('X'.repeat(129)),
          '[onebill] and the route kept only the first 128 characters of it');

        // An offer is what an acceptance is RECORDED as, so it means nothing on a clear (nothing is being
        // recorded) and nothing on a shortfall (a count has no plan). Both are 400s off the body shape,
        // before any read — refused rather than dropped, so a page that sent one is told.
        const beforeShape = { ...onebillCalls };
        ok((await post({ account: 'CLI00001', group: 'seats', action: 'clear', all: true, offer: 'Seat' })).status === 400,
          '[onebill] an offer on a clear is refused');
        ok((await post({ account: 'CLI00001', group: 'seats', action: 'accept', shortfall: true, offer: 'Seat' })).status === 400,
          '[onebill] and an offer on a shortfall, which is a decision about a count');
        ok(onebillCalls.subscriptions === beforeShape.subscriptions,
          '[onebill] neither of them paying for a subscription read on the way to being refused');

        // The happy path. Case-insensitive, and the ROW's spelling is what gets stored: two spellings of
        // one plan in the history would read as two plans to anybody grouping by it later.
        history.length = 0;
        const good = await post({ account: 'CLI00001', group: 'seats', action: 'accept', all: true, offer: '  seat ' });
        ok(good.status === 200, `[onebill] accepting a row's items as one of its offers is recorded (${good.status})`);
        const row = (await jbody(good)).row;
        ok(items.size > 0, `[onebill] and the items were stored (${items.size})`);
        ok([...items.values()].every((r) => r.offer === 'Seat'),
          `[onebill] each tagged with the ROW's spelling, not the caller's (${[...new Set([...items.values()].map((r) => String(r.offer)))].join(',')})`);
        const tagged = history.filter((h) => h.table === 'billing_baseline_item_history');
        ok(tagged.length > 0 && tagged.every((h) => h.args[8] === 'Seat'), '[onebill] and the history row carries it too');

        // The group row the completion write derives: `entitled` on it is the engine's number for this
        // row, not anything the caller sent.
        ok(row.entitled === 2, `[onebill] the row comes back carrying its entitlement (${row.entitled})`);
        const g = groups.get('CLI00001\u0000seats');
        ok(g !== undefined, '[onebill] the completed group was recorded as a group row');
        ok(g?.entitled === 2, `[onebill] whose entitled is the one the row was judged against (${g?.entitled})`);
        ok(history.some((h) => h.table === 'billing_baseline_history' && h.args[8] === 2),
          '[onebill] and the group history says the same');
      } finally {
        obSubs = savedSubs;
        obRecurring = savedRec;
      }
    }

    // -- POST /kit/onebill/assign ------------------------------------------------------------------
    // Moving one item to another account. The body names the ITEM (a domain and a key) and the account
    // it should bill to; `?viewing=` names the panel that is open, which is what the reply is a report
    // about. Both are bounded against the caller's own visible set BEFORE anything is read or written.
    {
      const { db, history } = fakeD1();
      const rules = '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]';
      const asgEnv = { ...obEnv, ONEBILL_DB: db, ONEBILL_RECURRING_RULES: rules, CACHE_SCOPE: 'obassign' };
      const put = (tok: string, e: any, b: unknown, qs = '?viewing=CLI00001') =>
        obCall('/kit/onebill/assign' + qs, tok, e, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
      const body = { domain, key: 'ext:0000', accountNumber: 'CLI00001' };

      ok(ROUTES['/kit/onebill/assign'].sensitivity === 'write', '[onebill] the assign route is classified write');
      ok((await put(obBoss, obOff, body)).status === 404, '[onebill] the assign route does not exist when the integration is off');
      // The cheap gates run ahead of the fleet-wide /domains read, same as the baseline route's.
      const noDb = domainsCalls;
      ok((await put(obBoss, obEnv, body)).status === 404, '[onebill] and answers 404 when ONEBILL_DB is unbound');
      ok(domainsCalls === noDb, '[onebill] paying no fleet-wide /domains read to say so');
      ok((await put(obRes, asgEnv, body)).status === 403, '[onebill] a reseller without onebill.write cannot move an item');
      ok((await obCall('/kit/onebill/assign?viewing=CLI00001', obBoss, asgEnv)).status === 405, '[onebill] the assign route is POST-only');

      // Shape, all of it before any upstream read.
      ok((await put(obBoss, asgEnv, body, '')).status === 400, '[onebill] a missing ?viewing= is refused - the reply has no account to be a report about');
      ok((await put(obBoss, asgEnv, body, '?viewing=' + encodeURIComponent('CLI 1; drop'))).status === 400, '[onebill] and a ?viewing= outside the allowed character set');
      ok((await put(obBoss, asgEnv, { key: 'ext:100', accountNumber: null })).status === 400, '[onebill] a body with no domain is refused');
      ok((await put(obBoss, asgEnv, { domain, accountNumber: null })).status === 400, '[onebill] a body with no key is refused');
      ok((await put(obBoss, asgEnv, { domain, key: 'x'.repeat(129), accountNumber: null })).status === 400, '[onebill] an over-long key is refused');
      ok((await put(obBoss, asgEnv, { domain, key: 'ext:100' })).status === 400, '[onebill] an absent accountNumber is refused - null means "clear", and the two must not be the same request');
      ok((await put(obBoss, asgEnv, { domain, key: 'ext:100', accountNumber: 'CLI 1; drop' })).status === 400, '[onebill] an accountNumber outside the allowed character set is refused');

      // THE BOUND on the item's domain, checked before the report is loaded.
      const beforeDoms = domainsCalls;
      const beforeOb = { ...onebillCalls };
      nsUnderDomain.clear();
      ok((await put(obBoss, asgEnv, { ...body, domain: 'not-mine.example' })).status === 403,
        '[onebill] an item on a domain outside the visible set is 403, whoever the caller says they are viewing');
      ok(history.length === 0, '[onebill] and nothing was written on the way to any of those refusals');
      // What that refusal cost: ONE /domains, because the visible set is what decides it. Nothing else -
      // no link report, no OneBill call, and nothing read under any domain.
      ok(domainsCalls === beforeDoms + 1, `[onebill] it pays exactly one /domains read - the set it is judged against (${domainsCalls - beforeDoms})`);
      ok(onebillCalls.token === beforeOb.token && onebillCalls.subscribers === beforeOb.subscribers
        && onebillCalls.records === beforeOb.records && onebillCalls.subscriptions === beforeOb.subscriptions,
        '[onebill] and reaches OneBill not at all - the link report is never loaded to answer it');
      ok(nsUnderDomain.size === 0, `[onebill] nor anything under a domain (${[...nsUnderDomain].join(',')})`);
      // A padded ?viewing= is trimmed before the pattern is applied, the same as the body's
      // accountNumber - the two are one kind of value arriving by two routes. 403 rather than 400 is
      // what proves it got past the shape gate; the domain is the thing being refused here.
      ok((await put(obBoss, asgEnv, { ...body, domain: 'not-mine.example' }, '?viewing=%20CLI00001%20')).status === 403,
        '[onebill] and a ?viewing= with surrounding whitespace is trimmed, not refused as malformed');

      const savedSubs2 = obSubs;
      // TWO holders on one domain, which is what makes a move a move: CLI00001 bills the domain as a
      // whole, CLI00002 bills the HQ site (the stub's /sites answers with exactly that one). No fixture
      // extension carries a site, so every item lands on CLI00001 automatically and moving one to
      // CLI00002 really takes it OUT of the panel the operator is looking at.
      obSubs = [
        {
          accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active',
          accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: domain }, { key: 'Site', value: '' }] }],
        },
        {
          accountNumber: 'CLI00002', accountName: 'Acme Branch', accountStatus: 'Active',
          accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: domain }, { key: 'Site', value: 'HQ' }] }],
        },
      ];
      try {
        // The key comes off the panel the operator would have been looking at, not from a literal here:
        // a fixture whose extensions change must not turn this into a test of the 409 path by accident.
        const panel = await jbody(await obCall(`/kit/onebill/account?domain=${encodeURIComponent(domain)}`, obBoss, asgEnv));
        // The panel's keys are DOMAIN-QUALIFIED (`<domain>/ext:1000`) because one account's report spans
        // several domains; the assign body names the item's BARE identity on one domain, which is how
        // the assignment store is keyed. Stripping the prefix here is what the page will do too.
        const scoped = String(panel.detail?.extensions?.[0]?.key ?? '');
        const key = scoped.slice(scoped.indexOf('/') + 1);
        ok(scoped.startsWith(`${domain}/`) && /^ext:/.test(key), `[onebill] (fixture) the panel has an extension to move (${scoped})`);

        ok((panel.detail?.extensions ?? []).some((x: any) => x.key === scoped),
          '[onebill] (fixture) which is on CLI00001\'s panel to begin with - the site holder gets nothing automatically');

        // VIEWING one account, moving the item to the OTHER. The reply must be the VIEWED account's
        // report, and the item must be gone from it: answering with the destination's report would
        // redraw the panel as somebody else's, and answering with a stale copy of the source's would
        // show the operator an item they just moved away.
        const good = await put(obBoss, asgEnv, { domain, key, accountNumber: 'CLI00002', note: 'billed here' });
        ok(good.status === 200, `[onebill] a superadmin can move an item to another account that holds part of the domain (${good.status})`);
        const gb = await jbody(good);
        ok(gb.report && gb.report.accountNumber === 'CLI00001',
          '[onebill] and gets back the report for the account the panel is VIEWING, not the one the item moved to');
        ok(!(gb.report?.detail?.extensions ?? []).some((x: any) => x.key === scoped),
          '[onebill] with the moved item no longer in it - the reply is the panel as it now reads, not as it was');
        ok(history.some((h) => h.args.includes(key) && h.args.includes('CLI00002')), '[onebill] and the assignment was recorded against the account it moved to');
        ok(history.every((h) => !h.args.includes('someone.else@example.com')), '[onebill] (no decidedBy has been sent yet)');

        const notHolder = await put(obBoss, asgEnv, { domain, key, accountNumber: 'CLI09999' });
        ok(notHolder.status === 409, `[onebill] an account that holds no part of the domain is a 409, not a 500 (${notHolder.status})`);
        ok(/CLI09999/.test(JSON.stringify(await jbody(notHolder))), '[onebill] refused by name');

        // decidedBy is the ns_t's, whatever the body says - the same rule the baseline route has.
        history.length = 0;
        const spoof = await put(obBoss, asgEnv, { domain, key, accountNumber: 'CLI00002', decidedBy: 'someone.else@example.com' });
        ok(spoof.status === 200, '[onebill] a decidedBy in the body is accepted as a request');
        ok(history.length > 0 && history.every((h) => h.args.includes('boss@mock.local')),
          '[onebill] - and every stored row carries the caller from the ns_t');
        ok(history.every((h) => !h.args.includes('someone.else@example.com')), '[onebill] - never the one the body asked for');
      } finally {
        obSubs = savedSubs2;
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
