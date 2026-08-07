/**
 * Pure unit tests for the Ringotel enrichment module (no network, no Worker).
 *   tsx src/ringotel.selftest.ts
 */
import { enrichGraph, ringotelEnabled, resolveDomainToOrg, matchOrgsForDomain, buildExtIndex, parseOverrides, enrichFlowGraph, classifyOrgMatch, connectionsOf, usersStatusMap, enabledOrgsForDomains, orgStatusForDomain, scopeOf, getDirectory, getOrgUsers, getOrgParams, invalidateOrgUsers, indexRefreshLockKey, orgParamsKey, withTimeout, singleOrgAddresses, type BranchRef } from './ringotel.js';
import type { FlowGraph } from '@dszp/netsapiens-lib';
import type { User, OrgBranchEntry } from '@dszp/ringotel-lib';

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${m}`);
};

// ── the gate ──────────────────────────────────────────────────────────────────
ok(ringotelEnabled({}) === false, 'gate: no key → disabled');
ok(ringotelEnabled({ RINGOTEL_API_KEY: '' }) === false, 'gate: empty key → disabled');
ok(ringotelEnabled({ RINGOTEL_API_KEY: '  ' }) === false, 'gate: whitespace key → disabled');
ok(ringotelEnabled({ RINGOTEL_API_KEY: 'k' }) === true, 'gate: key present → enabled');

// ── overrides ─────────────────────────────────────────────────────────────────
ok(JSON.stringify(parseOverrides({})) === '{}', 'overrides: none → {}');
ok(parseOverrides({ RINGOTEL_OVERRIDES: '{"a":"b"}' }).a === 'b', 'overrides: parsed');
let threw = false;
try {
  parseOverrides({ RINGOTEL_OVERRIDES: 'not json' });
} catch {
  threw = true;
}
ok(threw, 'overrides: malformed JSON → throws (caller notes it)');

// ── resolveDomainToOrg (findByAddress + remap) ─────────────────────────────────
const index: OrgBranchEntry[] = [
  { orgid: 'O1', orgDomain: 'demo', branchid: 'B1', address: 'demo', host: 'sbc.example.net' },
  { orgid: 'O2', orgDomain: 'acmevoice', branchid: 'B2', address: 'acme42', host: 'sbc-iad.example.net' },
];
ok(resolveDomainToOrg(index, 'acme42')?.orgid === 'O2', 'resolve: branch.address == NS domain');
ok(resolveDomainToOrg(index, 'nope') === undefined, 'resolve: no match → undefined (normal, common)');
ok(resolveDomainToOrg(index, 'weird.ns', { 'weird.ns': 'acme42' })?.orgid === 'O2', 'resolve: override remaps the address');

// ── buildExtIndex ──────────────────────────────────────────────────────────────
const users: User[] = [
  { id: 'U1', extension: '102', branchid: 'B2', name: 'Agent A', state: 1, devs: [{ id: 'd1', st: 1 }] },
  { id: 'U2', extension: '103', branchid: 'B2', name: 'Agent B', state: 0, devs: [] },
  { id: 'U3', extension: '900', branchid: 'OTHER', name: 'Other branch', state: 1, devs: [] },
];
const byExt = buildExtIndex(users, 'B2');
ok(byExt.size === 2 && byExt.has('102') && byExt.has('103') && !byExt.has('900'), 'buildExtIndex: filters to branch, keys by extension');

// ── enrichGraph (pure post-processor, INLINE) ──────────────────────────────────
const graph: FlowGraph = {
  entity: { kind: 'queue', ref: '9100', label: 'Q' },
  domain: 'acme42',
  rootId: 'q',
  notes: [],
  edges: [],
  nodes: [
    { id: 'q', kind: 'queue', label: 'Queue 9100' },
    {
      id: 'agents_9100',
      kind: 'agents',
      label: '👥 agents',
      // desk phone (102, no r) must stay untouched; 102r has a trailing "· manual"; 103r plain.
      lines: ['📞 Agent A (102)', '📱 Agent A (102r) · manual', '📱 Agent B (103r)'],
    },
    { id: 'dev_200', kind: 'devices', label: '🔔 Ring X', lines: ['📱 Someone (200r)'] }, // 200 not in byExt
    { id: 'u102', kind: 'user', label: '👤 Agent A', sub: 'ext 102' },
  ],
};
const added = enrichGraph(graph, byExt, 'Ringotel');
const agents = graph.nodes.find((n) => n.id === 'agents_9100')!;
ok(agents.lines!.includes('📞 Agent A (102)'), 'enrich: desk phone (102, no r) untouched');
ok(
  agents.lines!.some((l) => l === '📱 Agent A (102r) (Ringotel, 1 device) · manual'),
  'enrich: 102r → suffix inserted after token, before "· manual"',
);
ok(agents.lines!.some((l) => l === '📱 Agent B (103r) (Ringotel, 0 devices)'), 'enrich: 103r → "(Ringotel, 0 devices)"');
ok(graph.nodes.find((n) => n.id === 'dev_200')!.lines!.length === 1 && graph.nodes.find((n) => n.id === 'dev_200')!.lines![0] === '📱 Someone (200r)', 'enrich: unmatched ext (200r) → unchanged');
ok(graph.nodes.find((n) => n.id === 'u102')!.sub === 'ext 102 · Ringotel, 1 device', 'enrich: user node sub → "ext 102 · Ringotel, 1 device"');
ok(added === 3, 'enrich: 3 annotations (102r + 103r + user), desk phone & unmatched skipped');

// ── enrichGraph with no matches → zero change (the "enabled but nothing matches" path) ──
const fresh: FlowGraph = {
  entity: { kind: 'user', ref: '1', label: 'U' },
  domain: 'd',
  rootId: 'a',
  notes: [],
  edges: [],
  nodes: [{ id: 'a', kind: 'agents', label: 'x', lines: ['📱 Z (999r)'] }],
};
ok(enrichGraph(fresh, new Map(), 'Ringotel') === 0, 'enrich: no matching users → 0 added');
ok(JSON.stringify(fresh.nodes[0]!.lines) === JSON.stringify(['📱 Z (999r)']), 'enrich: node lines untouched when no match');

// ── custom label is honored (no hard-coded internal name in source) ─────────────
const mkAgents = (): FlowGraph => ({ entity: { kind: 'queue', ref: 'x', label: 'x' }, domain: 'd', rootId: 'a', notes: [], edges: [], nodes: [{ id: 'a', kind: 'agents', label: 'x', lines: ['📱 A (102r)'] }] });
const g3 = mkAgents();
enrichGraph(g3, byExt, 'TestApp');
ok(g3.nodes[0]!.lines!.some((l) => l.includes('(102r) (TestApp, 1 device)')), 'enrich: label is config-driven (swapped from default at the call site)');

// ── presence flag: 🟢/🔴 circle only when enabled ───────────────────────────────
const gOn = mkAgents();
enrichGraph(gOn, byExt, 'Ringotel', true); // 102 → 1 device with st:0 → online
ok(gOn.nodes[0]!.lines!.some((l) => l === '📱 A 🟢 (102r) (Ringotel, 1 device)'), 'enrich: presence on → 🟢 before the ext token (no parens)');
const gOff = mkAgents();
enrichGraph(gOff, byExt, 'Ringotel', false);
ok(gOff.nodes[0]!.lines!.some((l) => l === '📱 A (102r) (Ringotel, 1 device)'), 'enrich: presence off (default) → no circle');
const gOffline: FlowGraph = { entity: { kind: 'queue', ref: 'x', label: 'x' }, domain: 'd', rootId: 'a', notes: [], edges: [], nodes: [{ id: 'a', kind: 'agents', label: 'x', lines: ['📱 B (103r)'] }] };
enrichGraph(gOffline, byExt, 'Ringotel', true); // 103 → 0 devices → offline
ok(gOffline.nodes[0]!.lines!.some((l) => l === '📱 B 🔴 (103r) (Ringotel, 0 devices)'), 'enrich: presence on + no registered device → 🔴 before the ext token (no parens)');

// ── exactly-one domain→org binding (matchOrgsForDomain / resolveDomainToOrg) ───
const idx: OrgBranchEntry[] = [
  { orgid: 'A', branchid: 'ba', name: 'Org A', address: 'domd', host: 'sbc.example.net' },
  { orgid: 'E', branchid: 'be', name: 'Org E', address: 'dome', host: 'sbc.example.net' },
];
ok(matchOrgsForDomain(idx, 'domd').length === 1, '[bind] exact single match for domd');
ok(matchOrgsForDomain(idx, 'DOMD').length === 1, '[bind] match is case-insensitive');
ok(matchOrgsForDomain(idx, 'nope').length === 0, '[bind] no match → 0 (silent, common)');
ok(resolveDomainToOrg(idx, 'domd')?.orgid === 'A', '[bind] resolveDomainToOrg picks A for domd');

// Ambiguity: two orgs claim the SAME address → must NOT pick one.
const dupe: OrgBranchEntry[] = [
  { orgid: 'A', branchid: 'ba', name: 'A', address: 'shared' },
  { orgid: 'B', branchid: 'bb', name: 'B', address: 'shared' },
];
ok(matchOrgsForDomain(dupe, 'shared').length === 2, '[bind] duplicate address → 2 matches detected');
ok(resolveDomainToOrg(dupe, 'shared') === undefined, '[bind] ambiguous → resolveDomainToOrg returns undefined (never guesses)');

// Override remap still works (single audited exception).
ok(matchOrgsForDomain(idx, 'weird', { weird: 'domd' })[0]?.orgid === 'A', '[bind] override remaps weird→domd');

// ── classifyOrgMatch (0 / 1 / ≥2) ───────────────────────────────────────────────
const cidx: OrgBranchEntry[] = [
  { orgid: 'A', branchid: 'ba', address: 'domd' },
  { orgid: 'E', branchid: 'be', address: 'dome' },
];
const cAct = classifyOrgMatch(cidx, 'domd');
ok(cAct.status === 'active' && cAct.entry.orgid === 'A', 'classify: single match → active + entry');
ok(classifyOrgMatch(cidx, 'nope').status === 'none', 'classify: 0 matches → none');
const cDupe: OrgBranchEntry[] = [
  { orgid: 'A', branchid: 'ba', address: 'shared' },
  { orgid: 'B', branchid: 'bb', address: 'shared' },
];
const cAmb = classifyOrgMatch(cDupe, 'shared');
ok(cAmb.status === 'ambiguous' && cAmb.orgs.length === 2 && cAmb.orgs.includes('A') && cAmb.orgs.includes('B'), 'classify: ≥2 → ambiguous + orgids');
ok(classifyOrgMatch(cidx, 'weird', { weird: 'domd' }).status === 'active', 'classify: override remaps address');

// ── multi-connection resolution (one org, several connections) ─────────────────
{
  const multi: OrgBranchEntry[] = [
    { orgid: 'A', branchid: 'ba', branchName: 'Main', address: 'shared' },
    { orgid: 'A', branchid: 'bb', branchName: 'Warehouse', address: 'shared' },
  ];
  const r = classifyOrgMatch(multi, 'shared');
  ok(r.status === 'multi', 'classify: 2 connections in ONE org → multi, not ambiguous');
  ok(r.status === 'multi' && r.orgid === 'A', 'classify: multi carries the single orgid');
  ok(r.status === 'multi' && r.branches.map((b) => b.branchid).join(',') === 'ba,bb', 'classify: multi carries EVERY bound connection');

  // The critical negative: two ORGS must still refuse.
  const twoOrgs: OrgBranchEntry[] = [
    { orgid: 'A', branchid: 'ba', address: 'shared' },
    { orgid: 'B', branchid: 'bb', address: 'shared' },
  ];
  const amb = classifyOrgMatch(twoOrgs, 'shared');
  ok(amb.status === 'ambiguous', 'classify: 2 ORGS still → ambiguous (no single source of truth)');
  ok(amb.status === 'ambiguous' && amb.orgs.length === 2, 'classify: ambiguous still names both orgids');

  // Three connections, one org, one of them a different org → still ambiguous.
  const mixed: OrgBranchEntry[] = [
    { orgid: 'A', branchid: 'b1', address: 'shared' },
    { orgid: 'A', branchid: 'b2', address: 'shared' },
    { orgid: 'B', branchid: 'b3', address: 'shared' },
  ];
  ok(classifyOrgMatch(mixed, 'shared').status === 'ambiguous', 'classify: one foreign org among several poisons the whole match');

  // A single connection is unchanged — the overwhelmingly common case must not regress.
  const single: OrgBranchEntry[] = [{ orgid: 'A', branchid: 'ba', address: 'solo' }];
  const one = classifyOrgMatch(single, 'solo');
  ok(one.status === 'active' && one.entry.branchid === 'ba', 'classify: ONE connection is still plain active');
}

// ── connectionsOf ─────────────────────────────────────────────────────────────
{
  const e: OrgBranchEntry = { orgid: 'A', branchid: 'ba', address: 'solo' };
  ok(connectionsOf({ status: 'active', entry: e }).length === 1, 'connectionsOf: active → the one entry');
  ok(connectionsOf({ status: 'multi', orgid: 'A', branches: [e, e] }).length === 2, 'connectionsOf: multi → every branch');
  ok(connectionsOf({ status: 'none' }).length === 0, 'connectionsOf: none → empty');
  ok(connectionsOf({ status: 'ambiguous', orgs: ['A', 'B'] }).length === 0, 'connectionsOf: ambiguous → empty (never act on a refused binding)');
}

// ── usersStatusMap (per-ext presence from the user-level `state`) ─────────────────
const suUsers: User[] = [
  { id: 'u1', extension: '105', branchid: 'B2', status: 1, state: 1, stime: 1784056572780, devs: [{ id: 'd1', st: 1 }, { id: 'd2', st: 2 }] }, // Online, 2 devices
  { id: 'u2', extension: '100', branchid: 'B2', status: 1, state: 2, username: '100r', devs: [{ id: 'd3', st: 2 }] }, // Available
  { id: 'u3', extension: '106', branchid: 'B2', status: 1, state: 5, devs: [] },                    // Available on PBX
  { id: 'u4', extension: '104', branchid: 'B2', status: 1, state: 0, devs: [] },                    // Offline
  { id: 'u5', extension: '107', branchid: 'B2', status: 1, state: 4, devs: [{ id: 'd7', st: 1 }] }, // unknown non-zero (Busy/DND/At-the-Desk) → active
  { id: 'u6', extension: '109', branchid: 'B2', status: 0, state: 0, devs: [] },                    // provisioned but not activated (status 0)
  { id: 'u7', extension: '900', branchid: 'OTHER', status: 1, state: 1, devs: [] },                 // other branch → dropped
];
const sMap = usersStatusMap(suUsers, 'B2');
ok(Object.keys(sMap).length === 6 && !sMap['900'], 'usersStatusMap: filters to branch B2 (drops 900)');
ok(sMap['105']!.presence === 'active' && sMap['105']!.label === 'Online' && sMap['105']!.state === 1 && sMap['105']!.devices === 2 && sMap['105']!.lastSeen === 1784056572780, 'usersStatusMap: 105 Online (state 1) → active, 2 devices, lastSeen');
ok(sMap['100']!.presence === 'active' && sMap['100']!.label === 'Available', 'usersStatusMap: 100 Available (state 2) → active (green)');
ok(sMap['106']!.presence === 'pbx' && sMap['106']!.label === 'Available on PBX' && sMap['106']!.devices === 0, 'usersStatusMap: 106 Available on PBX (state 5) → pbx (orange)');
ok(sMap['104']!.presence === 'offline' && sMap['104']!.label === 'Offline', 'usersStatusMap: 104 Offline (state 0) → offline (gray)');
ok(sMap['107']!.presence === 'active' && sMap['107']!.label === 'Status 4', 'usersStatusMap: unknown non-zero state → active + "Status 4"');
ok(sMap['109']!.activated === false, 'usersStatusMap: 109 status 0 → not activated (empty)');
ok(sMap['100']!.username === '100r', 'usersStatusMap: projects the Ringotel SIP username (app-access password mode needs it)');
ok(sMap['105']!.username === undefined, 'usersStatusMap: no username on the record → field absent, not a guessed value');

// ── enabledOrgsForDomains (bulk enabled map for the /portal/domains app-status column) ──
const idxCol: OrgBranchEntry[] = [
  { orgid: 'O1', orgDomain: 'appdom', branchid: 'B1', address: 'acme.svc', host: 'sbc.example.net' },
  { orgid: 'O2', orgDomain: 'appdom2', branchid: 'B2', address: 'bravo.svc', host: 'sbc.example.net' },
  { orgid: 'O3', orgDomain: 'dupA', branchid: 'B3', address: 'clash.svc', host: 'h' },
  { orgid: 'O4', orgDomain: 'dupB', branchid: 'B4', address: 'clash.svc', host: 'h' },
];
const em = enabledOrgsForDomains(idxCol, ['acme.svc', 'bravo.svc', 'nope.svc', 'clash.svc']);
ok(em['acme.svc']?.orgId === 'O1' && em['acme.svc']?.appDomain === 'appdom', 'enabledOrgs: single match → {orgId, appDomain}');
ok(em['bravo.svc']?.orgId === 'O2', 'enabledOrgs: second single match resolved');
ok(!('nope.svc' in em), 'enabledOrgs: no match → omitted (grey on client)');
ok(!('clash.svc' in em), 'enabledOrgs: ambiguous (≥2 orgs) → omitted (domain-binding invariant)');
ok(Object.keys(em).length === 2, 'enabledOrgs: only the two singly-matched domains present');

// ── multi-connection domains are ENABLED, not grey ────────────────────────────
{
  const idx: OrgBranchEntry[] = [
    { orgid: 'A', branchid: 'b1', orgDomain: 'acmeapp', address: 'twoconn', branchName: 'Main' },
    { orgid: 'A', branchid: 'b2', orgDomain: 'acmeapp', address: 'twoconn', branchName: 'Warehouse' },
    { orgid: 'A', branchid: 'b3', orgDomain: 'acmeapp', address: 'solo' },
    { orgid: 'A', branchid: 'b4', address: 'contested' },
    { orgid: 'B', branchid: 'b5', address: 'contested' },
  ];
  const enabled = enabledOrgsForDomains(idx, ['twoconn', 'solo', 'contested', 'missing']);
  ok(!!enabled['twoconn'], 'orgs: a 2-connection domain is ENABLED, not rendered grey');
  ok(enabled['twoconn']?.orgId === 'A', 'orgs: a 2-connection domain reports its single orgid');
  ok(!!enabled['solo'], 'orgs: a single-connection domain is unchanged');
  ok(enabled['contested'] === undefined, 'orgs: a 2-ORG domain is still omitted');
  ok(enabled['missing'] === undefined, 'orgs: an unbound domain is still omitted');
}

// ── health flags on the users map ─────────────────────────────────────────────
{
  const mk = (p: Partial<User>): User =>
    ({ id: 'i', branchid: 'BR1', extension: '100', created: 1000, stime: 5000, ...p }) as User;
  // Exact full-set matching (order-independent) — pins the REAL flag set, not just "contains X", so a
  // future rule change that adds/drops a co-occurring flag is caught here instead of silently passing.
  const sameFlags = (flags: string[], expected: string[]) => JSON.stringify([...flags].sort()) === JSON.stringify([...expected].sort());

  const healthy = usersStatusMap([mk({ status: 1, authname: '100r', trunkid: 'T1', trunkstate: 1 })], 'BR1');
  ok(healthy['100']!.health.severity === 'ok', 'health: healthy user → ok');
  ok(sameFlags(healthy['100']!.health.flags, []), 'health: healthy user → exactly no flags');

  // No authname (→ brick) + trunkstate unset. This fixture ALSO has trunkid set and stime(5000) >
  // created(1000), which correctly co-produces 'stale-registration' too (a bricked record still has a
  // trunk and may have registered before it broke) — that co-occurrence is CORRECT and must stay, so pin
  // the exact set rather than a subset that would hide a future change to either flag.
  const bricked = usersStatusMap([mk({ status: 1, trunkid: 'T1' })], 'BR1');
  ok(sameFlags(bricked['100']!.health.flags, ['brick', 'stale-registration']), 'health: missing authname + unset trunkstate (trunk present, previously seen) → exactly [brick, stale-registration]');
  ok(bricked['100']!.health.severity === 'broken', 'health: brick → broken');

  const dupes = usersStatusMap(
    [
      mk({ id: 'a', status: 1, authname: '100r', trunkid: 'T1', trunkstate: 1 }),
      mk({ id: 'b', status: 1, authname: '100r', trunkid: 'T1', trunkstate: 1 }),
    ],
    'BR1',
  );
  ok(sameFlags(dupes['100']!.health.flags, ['duplicate']), 'health: two records at one ext, otherwise healthy → exactly [duplicate]');

  const otherBranch = usersStatusMap(
    [
      mk({ id: 'a', status: 1, authname: '100r', trunkid: 'T1', trunkstate: 1 }),
      mk({ id: 'b', branchid: 'BR2', status: 1, authname: '100r', trunkid: 'T1', trunkstate: 1 }),
    ],
    'BR1',
  );
  ok(sameFlags(otherBranch['100']!.health.flags, []), 'health: sibling in another branch is not a duplicate → exactly no flags');

  const suffixed = usersStatusMap([mk({ status: 1, authname: '100x', trunkid: 'T1', trunkstate: 1 })], 'BR1', 'x');
  ok(sameFlags(suffixed['100']!.health.flags, []), 'health: suffix parameter is honored (authname matches ext+suffix) → exactly no flags');
}


// ── cache SCOPING + the volatile org-params overlay ───────────────────────────
// The two fixes for the 2026-07-27 stale-data reports. Both are about cache KEYS and cache CONTENT, and
// the in-memory Cache API stub below has NO TTL expiry — so every assertion here drives the `refresh`
// flag or inspects the stored keys directly. Nothing waits on a clock, because nothing here could.
{
  class MemCache {
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
    keys(sub: string): string[] {
      return [...this.store.keys()].filter((k) => k.includes(sub)).sort();
    }
  }
  const cache = () => new MemCache() as unknown as Cache & { store: Map<string, Response>; keys(s: string): string[] };

  // ---- scopeOf -------------------------------------------------------------
  ok(scopeOf({}) === 'default', 'scopeOf: unset → "default" (a single-deployment operator needs no config)');
  ok(scopeOf({ CACHE_SCOPE: '' }) === 'default', 'scopeOf: empty → "default"');
  ok(scopeOf({ CACHE_SCOPE: '   ' }) === 'default', 'scopeOf: whitespace → "default"');
  ok(scopeOf({ CACHE_SCOPE: '  portal ' }) === 'portal', 'scopeOf: trimmed');
  // A bad value must stay DISTINCT rather than collapse to "default" — collapsing would merge two
  // deployments' caches, which is precisely the failure this function exists to prevent.
  ok(scopeOf({ CACHE_SCOPE: 'a/b?c' }) === 'a-b-c', 'scopeOf: path/query characters folded to "-", NOT collapsed to default');
  ok(scopeOf({ CACHE_SCOPE: 'portal' }) !== scopeOf({ CACHE_SCOPE: 'dev' }), 'scopeOf: distinct config values stay distinct');

  // ---- a stub Ringotel read client, per scenario ---------------------------
  type Stub = { orgs: any[]; branches: any[]; users?: any[]; failOrgRead?: boolean; orgReads?: number };
  const stubClient = (s: Stub) =>
    ({
      getOrganizations: async () => s.orgs,
      getBranches: async (orgid: string) => s.branches.filter((b) => b.orgid === orgid),
      getUsers: async () => s.users ?? [],
      getOrganization: async (id: string) => {
        s.orgReads = (s.orgReads ?? 0) + 1;
        if (s.failOrgRead) throw new Error('ringotel unavailable');
        return s.orgs.find((o) => String(o.id) === String(id));
      },
    }) as any;

  const ORG_A: Stub = { orgs: [{ id: 'O1', domain: 'acmevoice' }], branches: [{ id: 'B1', orgid: 'O1', address: 'acme42' }] };
  const ORG_B: Stub = { orgs: [{ id: 'O9', domain: 'othervoice' }], branches: [{ id: 'B9', orgid: 'O9', address: 'acme42' }] };

  // ---- every key carries the scope, and two scopes never share one ---------
  {
    const c = cache();
    await getDirectory(stubClient(ORG_A), c, 'portal');
    await getDirectory(stubClient(ORG_A), c, 'dev');
    await getOrgUsers(stubClient(ORG_A), c, 'portal', 'O1');
    await getOrgUsers(stubClient(ORG_A), c, 'dev', 'O1');
    await getOrgParams(stubClient(ORG_A), c, 'portal', 'O1');
    await getOrgParams(stubClient(ORG_A), c, 'dev', 'O1');
    const idx = c.keys('/index-v');
    const usr = c.keys('/users');
    const prm = c.keys('/params');
    ok(idx.length === 2 && idx[0]!.includes('/dev/') && idx[1]!.includes('/portal/'), 'scoped keys: index — one entry PER SCOPE, never one shared entry');
    ok(usr.length === 2 && usr.some((k) => k.includes('/dev/org/O1/')) && usr.some((k) => k.includes('/portal/org/O1/')), 'scoped keys: org users — one entry per scope');
    ok(prm.length === 2 && prm.some((k) => k.includes('/dev/org/O1/')) && prm.some((k) => k.includes('/portal/org/O1/')), 'scoped keys: org params — one entry per scope');
    ok(indexRefreshLockKey('portal') !== indexRefreshLockKey('dev'), 'scoped keys: the refresh lock too — a dev refresh must not suppress a prod one');
    ok(orgParamsKey('portal', 'O1') !== orgParamsKey('dev', 'O1'), 'scoped keys: orgParamsKey differs by scope');
  }

  // ---- the actual reported bug: one scope's read repopulating another's key --
  {
    const c = cache();
    const portal = await getDirectory(stubClient(ORG_A), c, 'portal');
    // Same domain, DIFFERENT upstream answer, read by another deployment. Unscoped, this write landed on
    // the key prod was about to read, and prod served it for the rest of the TTL.
    const dev = await getDirectory(stubClient(ORG_B), c, 'dev');
    const portalAgain = await getDirectory(stubClient(ORG_B), c, 'portal');
    ok(portal[0]!.orgid === 'O1' && dev[0]!.orgid === 'O9', 'scope isolation: each deployment digs its own directory');
    ok(portalAgain[0]!.orgid === 'O1', "scope isolation: another deployment's read does NOT repopulate this one's cached index");
  }

  // ---- invalidateOrgUsers deletes THIS scope's key, and only this one -------
  {
    const c = cache();
    await getOrgUsers(stubClient(ORG_A), c, 'portal', 'O1');
    await getOrgUsers(stubClient(ORG_A), c, 'dev', 'O1');
    await invalidateOrgUsers(c, 'portal', 'O1');
    const left = c.keys('/users');
    ok(left.length === 1 && left[0]!.includes('/dev/'), 'invalidateOrgUsers: deletes the SCOPED key and leaves another scope’s entry alone');
  }

  // ---- the refresh lock is per scope ---------------------------------------
  {
    const c = cache();
    await getDirectory(stubClient(ORG_A), c, 'portal', true); // takes portal's lock
    const devStub = ORG_B;
    const dev = await getDirectory(stubClient(devStub), c, 'dev', true); // must NOT be blocked by it
    ok(dev[0]!.orgid === 'O9', 'refresh lock: scoped — one deployment holding the lock cannot suppress another’s refresh');
    const relocked = await getDirectory(stubClient(ORG_B), c, 'portal', true);
    ok(relocked[0]!.orgid === 'O1', 'refresh lock: still coalesces WITHIN a scope (second forced refresh reads the cache)');
  }

  // ---- getOrgParams ---------------------------------------------------------
  {
    const c = cache();
    const s: Stub = { orgs: [{ id: 'O1', params: { sso: '9/netsapiens_sso', hidePassInEmail: true } }], branches: [] };
    const first = await getOrgParams(stubClient(s), c, 'portal', 'O1');
    ok(first?.value.ssoService === '9/netsapiens_sso' && first.value.hidePassInEmail === true, 'getOrgParams: derives both volatile settings from one getOrganization call');
    ok(first?.age === 0, 'getOrgParams: a freshly fetched answer reports age 0');
    const second = await getOrgParams(stubClient(s), c, 'portal', 'O1');
    ok(second?.value.ssoService === '9/netsapiens_sso' && typeof second?.age === 'number', 'getOrgParams: served from cache on the second call, with an age');

    const bad: Stub = { orgs: [], branches: [], failOrgRead: true };
    let threw = false;
    let res: unknown;
    try {
      res = await getOrgParams(stubClient(bad), cache(), 'portal', 'O1');
    } catch {
      threw = true;
    }
    ok(!threw && res === undefined, 'getOrgParams: a failed read returns undefined and NEVER throws (the caller keeps the index value)');

    // The transport throws on an HTTP error and on an in-band {error}, but a 200 carrying NO `result`
    // resolves to undefined quietly. `orgSettings` is null-tolerant, so deriving from it would yield {} —
    // and because the overlay replaces both fields wholesale, {} reads as "SSO is not bound" and would be
    // cached as the truth for a minute. Same wrong answer this whole change exists to remove, reached
    // from the other side.
    const empty = { getOrganization: async () => undefined } as any;
    const emptyCache = cache();
    const er = await getOrgParams(empty, emptyCache, 'portal', 'O1');
    ok(er === undefined, 'getOrgParams: a 200 with NO organization record is a FAILED read, not an org with no settings');
    ok([...emptyCache.store.keys()].length === 0, 'getOrgParams: an empty response is NOT cached (a bad answer must not persist for the TTL)');
    const nullish = { getOrganization: async () => null } as any;
    ok((await getOrgParams(nullish, cache(), 'portal', 'O1')) === undefined, 'getOrgParams: an explicit null record is a failed read too');
    const scalar = { getOrganization: async () => 'not an object' } as any;
    ok((await getOrgParams(scalar, cache(), 'portal', 'O1')) === undefined, 'getOrgParams: a non-object record is a failed read too');

    // The overlay sits on request paths that made ZERO upstream calls before it existed, and the Ringotel
    // transport carries no timeout of its own — so a HUNG endpoint (as opposed to a failing one) would
    // stall the org banner and the profile extras. A catch only helps when the promise settles.
    let timedOut = false;
    try {
      await withTimeout(new Promise(() => {}), 20, 'probe');
    } catch (e) {
      timedOut = /timed out/.test((e as Error).message);
    }
    ok(timedOut, 'withTimeout: a promise that never settles rejects, so a hung upstream degrades instead of stalling the request');
    ok((await withTimeout(Promise.resolve('v'), 1000, 'probe')) === 'v', 'withTimeout: a prompt answer passes straight through');
    const hung = { getOrganization: () => new Promise(() => {}) } as any;
    ok((await getOrgParams(hung, cache(), 'portal', 'O1', false)) !== null, 'getOrgParams: wired to withTimeout (a hung read cannot return a settings object)');
  }
}


// ── the overlay actually reaches orgStatusForDomain (the reported symptom) ────
// orgStatusForDomain builds its own client from env, so this drives the real JSON-RPC transport through
// a stubbed global fetch. That is deliberate: the whole point of the change is that a SECOND upstream
// call now happens, and a test that injected a client would not prove it is wired to the route body.
{
  class MemCache {
    store = new Map<string, Response>();
    async match(req: Request) { const r = this.store.get(req.url); return r ? r.clone() : undefined; }
    async put(req: Request, res: Response) { this.store.set(req.url, res.clone()); }
    async delete(req: Request) { return this.store.delete(req.url); }
  }

  const realFetch = globalThis.fetch;
  // `dirOrg` is what the DIRECTORY dig sees; `liveOrg` is what a single-org read sees. Letting them
  // disagree is the entire mechanism under test — in production the disagreement is time (an index up to
  // an hour old vs an org edited a minute ago), and there is no way to reproduce time in this stub.
  let dirOrg: any = {};
  let liveOrg: any = {};
  let failOrgRead = false;
  let emptyOrgRead = false; // a 200 whose body carries no `result` — the transport does NOT throw on this
  let orgReads = 0;
  let multiBranches = false; // when true, O1 has TWO connections bound to the same domain
  globalThis.fetch = (async (_input: any, init: any) => {
    const { method, params } = JSON.parse(String(init?.body ?? '{}'));
    if (method === 'getOrganization') {
      orgReads++;
      if (failOrgRead) return new Response('nope', { status: 500 });
      if (emptyOrgRead) return new Response(JSON.stringify({}), { status: 200 }); // 200, no `result`
      return new Response(JSON.stringify({ result: { id: 'O1', ...liveOrg } }), { status: 200 });
    }
    const result =
      method === 'getOrganizations' ? [{ id: 'O1', domain: 'acmevoice', ...dirOrg }]
      : method === 'getBranches' ? (String(params?.orgid) === 'O1' ? (multiBranches ? [{ id: 'B1', orgid: 'O1', address: 'acme42', name: 'Main' }, { id: 'B2', orgid: 'O1', address: 'acme42', name: 'Warehouse' }] : [{ id: 'B1', orgid: 'O1', address: 'acme42' }]) : [])
      : method === 'getUsers' ? []
      : [];
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;

  const env = { RINGOTEL_API_KEY: 'k', CACHE_SCOPE: 'portal' };
  const fresh = () => new MemCache() as unknown as Cache;

  // THE REGRESSION TEST for report 3: the hour-old index entry has no ssoService, the org's params say
  // NS SSO is bound. Before this change the answer was "no SSO" for up to an hour, and every user in
  // that domain was confidently told to sign in with a password from a welcome email.
  dirOrg = {}; liveOrg = { params: { sso: '9/netsapiens_sso', hidePassInEmail: true } };
  let r = await orgStatusForDomain('acme42', env, fresh());
  ok(r.active === true && r.ssoService === '9/netsapiens_sso', 'overlay: index says NO sso, live params say SSO bound ⇒ the response reports SSO enabled');
  ok(r.hPIE === true, 'overlay: hidePassInEmail comes from the fresh read too');
  ok(typeof r.age === 'number', 'overlay: the response carries the age of the volatile data');
  ok(!('connections' in r), 'banner: a single-connection domain carries NO `connections` key — byte-identical to before multi-connection support');

  // The mirror image, and the reason the overlay replaces both fields WHOLESALE rather than merging:
  // an operator UNBINDING SSO must become visible just as fast. A merge would leave the stale value in
  // place, so "unbind" would be invisible for an hour while "bind" was instant.
  dirOrg = { params: { sso: '9/netsapiens_sso' } }; liveOrg = { params: {} };
  r = await orgStatusForDomain('acme42', env, fresh());
  ok(r.active === true && r.ssoService === undefined, 'overlay: index HAS sso, live params do not ⇒ SSO reported as gone (an unbind is visible, not just a bind)');

  // A freshness optimization must never turn a working request into a failed one.
  dirOrg = { params: { sso: '9/netsapiens_sso', hidePassInEmail: false } }; liveOrg = {}; failOrgRead = true;
  r = await orgStatusForDomain('acme42', env, fresh());
  ok(r.active === true && r.ssoService === '9/netsapiens_sso', 'overlay: a FAILED org read falls back to the index value rather than clearing it');
  ok(r.hPIE === false, 'overlay: the fallback carries hidePassInEmail:false — a value, not absence');
  ok(r.age === undefined, 'overlay: no age is reported when the fresh read failed (never claim "0 seconds old")');
  failOrgRead = false;

  // The same hole at the route level: upstream answers 200 with no organization record while the index
  // says SSO is bound. Before the guard this reported SSO OFF for a minute — every user in the domain
  // told to sign in with a password from a welcome email that SSO means they never received.
  dirOrg = { params: { sso: '9/netsapiens_sso' } }; liveOrg = {}; emptyOrgRead = true;
  r = await orgStatusForDomain('acme42', env, fresh());
  ok(r.active === true && r.ssoService === '9/netsapiens_sso', 'overlay: a 200 with no organization record falls back to the index rather than reporting SSO off');
  emptyOrgRead = false;

  // One extra upstream call per view, not one per view per field, and cached for ORG_PARAMS_TTL.
  dirOrg = {}; liveOrg = { params: { sso: '9/netsapiens_sso' } };
  const shared = fresh();
  orgReads = 0;
  await orgStatusForDomain('acme42', env, shared);
  await orgStatusForDomain('acme42', env, shared);
  ok(orgReads === 1, 'overlay: the per-org read is cached — two views cost ONE getOrganization, not two');

  // A domain with no Ringotel org must not pay for an org read it has no org for.
  orgReads = 0;
  await orgStatusForDomain('not-a-domain', env, fresh());
  ok(orgReads === 0, 'overlay: an unbound domain triggers NO per-org read');

  // ── the banner reports a multi-connection domain too, sharing the org's settings ────
  dirOrg = {}; liveOrg = { params: { sso: '9/netsapiens_sso' } }; multiBranches = true;
  r = await orgStatusForDomain('acme42', env, fresh());
  ok(r.active === true && r.orgId === 'O1', 'banner: a 2-connection domain is active, reporting its single org');
  ok(r.ssoService === '9/netsapiens_sso', 'banner: org-level settings still come from the ONE org read, shared by both connections');
  multiBranches = false;

  globalThis.fetch = realFetch;
}

// ── sweep scope: which addresses have a single OWNING ORG ──────────────────────
{
  const idx: OrgBranchEntry[] = [
    { orgid: 'A', branchid: 'b1', address: 'solo' },
    { orgid: 'A', branchid: 'b2', address: 'twoconn' },
    { orgid: 'A', branchid: 'b3', address: 'twoconn' },   // same org, second connection
    { orgid: 'A', branchid: 'b4', address: 'contested' },
    { orgid: 'B', branchid: 'b5', address: 'contested' }, // different org — must be dropped
    { orgid: 'B', branchid: 'b6' },                        // no address at all
  ];
  const got = singleOrgAddresses(idx);
  ok(got.join(',') === 'solo,twoconn', 'sweep scope: a domain with 2 connections in ONE org IS in scope');
  ok(!got.includes('contested'), 'sweep scope: a domain claimed by 2 ORGS is dropped, never guessed');
  ok(got.length === 2, 'sweep scope: an entry with no address contributes nothing');
}

// ── status reads span every bound connection ──────────────────────────────────
{
  const branches: BranchRef[] = [
    { branchid: 'B1', branchName: 'Main' },
    { branchid: 'B2', branchName: 'Warehouse' },
  ];
  const users: User[] = [
    { id: 'u1', extension: '100', branchid: 'B1', status: 1, state: 1, devs: [{ id: 'd1', st: 1 }] },
    { id: 'u2', extension: '200', branchid: 'B2', status: 1, state: 0, devs: [] },
    { id: 'u3', extension: '900', branchid: 'BOTHER', status: 1, state: 1, devs: [] }, // unbound connection
  ] as unknown as User[];

  const m = usersStatusMap(users, branches, 'r');
  ok(!!m['100'] && !!m['200'], 'status: users on BOTH bound connections appear');
  ok(m['900'] === undefined, 'status: a user on an UNBOUND connection is still excluded');
  ok(m['100']?.connection === 'Main' && m['200']?.connection === 'Warehouse', 'status: each user reports its connection NAME');
  ok(m['100']?.connectionConflict !== true, 'status: a user on one connection is not a conflict');

  // Single-connection callers must be untouched — no connection noise in the common case.
  const solo = usersStatusMap(users, 'B1', 'r');
  ok(!!solo['100'] && solo['200'] === undefined, 'status: a bare branchid still filters to that one connection');
  ok(solo['100']?.connection === undefined, 'status: with a single connection the name is omitted as noise');

  // The conflict case: one extension with a record on two connections.
  const dup: User[] = [
    { id: 'a', extension: '100', branchid: 'B1', status: 1, state: 1, devs: [] },
    { id: 'b', extension: '100', branchid: 'B2', status: 1, state: 1, devs: [] },
  ] as unknown as User[];
  const c = usersStatusMap(dup, branches, 'r');
  ok(c['100']?.connectionConflict === true, 'status: an extension present on TWO connections is flagged as a conflict');
}

// ── buildExtIndex across connections ──────────────────────────────────────────
{
  const users: User[] = [
    { id: 'a', extension: '100', branchid: 'B1' },
    { id: 'b', extension: '200', branchid: 'B2' },
    { id: 'c', extension: '300', branchid: 'B9' },
  ] as unknown as User[];
  const idx = buildExtIndex(users, [{ branchid: 'B1' }, { branchid: 'B2' }]);
  ok(idx.get('100')?.id === 'a' && idx.get('200')?.id === 'b', 'buildExtIndex: spans every bound connection');
  ok(idx.get('300') === undefined, 'buildExtIndex: still excludes unbound connections');
  ok(buildExtIndex(users, 'B1').get('200') === undefined, 'buildExtIndex: a bare branchid keeps its single-connection contract');
}

{
  const branches: BranchRef[] = [{ branchid: 'B1', branchName: 'Main' }, { branchid: 'B2', branchName: 'Warehouse' }];
  const users: User[] = [
    { id: 'a', extension: '102', branchid: 'B1', status: 1, state: 1, devs: [{ id: 'd', st: 1 }] },
    { id: 'b', extension: '103', branchid: 'B2', status: 1, state: 1, devs: [{ id: 'e', st: 1 }] },
  ] as unknown as User[];
  const idx = buildExtIndex(users, branches);
  ok(!!idx.get('102') && !!idx.get('103'), 'enrichment: agents on BOTH connections are indexed for the diagram');
}

// ── duplicate-vs-conflict: two records on ONE connection is NOT a connection conflict ─────────
{
  const branches: BranchRef[] = [{ branchid: 'B1', branchName: 'Main' }, { branchid: 'B2', branchName: 'Warehouse' }];
  // TWO records at one extension, both on the SAME connection, on a multi-connection domain.
  const sameConn: User[] = [
    { id: 'a', extension: '100', branchid: 'B1', status: 1, state: 1, devs: [] },
    { id: 'b', extension: '100', branchid: 'B1', status: 1, state: 1, devs: [] },
  ] as unknown as User[];
  const m = usersStatusMap(sameConn, branches, 'r');
  ok(m['100']?.connectionConflict !== true, 'status: two records on ONE connection are a duplicate, NOT a connection conflict');
  ok(m['100']?.health.flags.includes('duplicate'), 'status: ...and the pre-existing duplicate flag still reports them');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
