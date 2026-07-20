/**
 * Pure unit tests for the Ringotel enrichment module (no network, no Worker).
 *   tsx src/ringotel.selftest.ts
 */
import { enrichGraph, ringotelEnabled, resolveDomainToOrg, matchOrgsForDomain, buildExtIndex, parseOverrides, enrichFlowGraph, classifyOrgMatch, usersStatusMap, enabledOrgsForDomains } from './ringotel.js';
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

// ── usersStatusMap (per-ext presence from the user-level `state`) ─────────────────
const suUsers: User[] = [
  { id: 'u1', extension: '105', branchid: 'B2', status: 1, state: 1, stime: 1784056572780, devs: [{ id: 'd1', st: 1 }, { id: 'd2', st: 2 }] }, // Online, 2 devices
  { id: 'u2', extension: '100', branchid: 'B2', status: 1, state: 2, devs: [{ id: 'd3', st: 2 }] }, // Available
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
