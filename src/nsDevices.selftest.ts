/**
 * Pure unit tests for NS device enrichment (no network, no Worker).
 *   tsx src/nsDevices.selftest.ts
 */
import { nsDeviceDetailsEnabled, phoneFromRecord, annotateDevices, type Phone } from './nsDevices.js';
import type { FlowGraph } from '@dszp/netsapiens-lib';

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${m}`);
};

// ── gate ──────────────────────────────────────────────────────────────────────
ok(nsDeviceDetailsEnabled({}) === false, 'gate: unset → disabled');
ok(nsDeviceDetailsEnabled({ NS_DEVICE_DETAILS: '' }) === false, 'gate: empty → disabled');
ok(nsDeviceDetailsEnabled({ NS_DEVICE_DETAILS: '1' }) === true, 'gate: "1" → enabled');

// ── phoneFromRecord: safe projection of a /phones record (primary-line AOR from sip-uri-1) ──────
const rec = {
  'device-provisioning-mac-address': '249ad867f2a6',
  'device-provisioning-sip-uri-1': 'sip:101@acme.12345.service',
  'device-models-brand-and-model': 'Yealink SIP-T54W',
  'device-sip-registration-state': 'registered',
  'device-provisioning-password': 'SUPER-SECRET', // must never survive projection
  'user-presence-status': 'enabled',
};
const p = phoneFromRecord(rec)!;
ok(p.aor === '101', 'record: ext parsed from sip-uri-1 (primary-line AOR)');
ok(p.model === 'Yealink T54W', 'record: model cleaned ("SIP-" stripped)');
ok(p.registered === true, 'record: registered → true');
ok(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['aor', 'model', 'registered']), 'record: ONLY safe keys projected');
ok(!JSON.stringify(p).includes('SECRET') && !('device-provisioning-password' in (p as object)), 'SECURITY: no password field survives projection');
ok(phoneFromRecord({ 'device-provisioning-sip-uri-1': 'sip:1@d' }) === null, 'record: no MAC → null (softphone skipped)');
ok(phoneFromRecord({ 'device-provisioning-mac-address': 'aa' }) === null, 'record: no sip-uri → null');
ok(phoneFromRecord({ 'device-provisioning-mac-address': 'aa', 'device-provisioning-sip-uri-1': 'sip:200@d', 'device-sip-registration-state': 'unregistered' })!.registered === false, 'record: unregistered → false');

// ── annotateDevices (pure) ──────────────────────────────────────────────────────
const graph: FlowGraph = {
  entity: { kind: 'queue', ref: '9100', label: 'Q' },
  domain: 'acme.12345.service',
  rootId: 'q',
  notes: [],
  edges: [],
  nodes: [
    { id: 'q', kind: 'queue', label: 'Queue' },
    { id: 'agents_9100', kind: 'agents', label: '👥 agents', lines: ['📞 Debbi Smith (100)', '📱 Someone (102r)'] },
    { id: 'dev', kind: 'devices', label: '🔔 Ring', lines: ['📞 Person (103)'] },
  ],
};
const byAor = new Map<string, Phone>([
  ['100', { aor: '100', model: 'Yealink T54W', registered: true }],
  ['103', { aor: '103', model: 'Poly VVX450', registered: false }],
  // 102r is a softphone → NOT in the map (phoneFromRecord filtered it) → must stay untouched
]);
const n = annotateDevices(graph, byAor);
const agents = graph.nodes.find((x) => x.id === 'agents_9100')!;
ok(agents.lines!.some((l) => l === '📞 Debbi Smith 🟢 (100) (Yealink T54W)'), 'annotate: registered phone → 🟢 + model (no parens)');
ok(agents.lines!.some((l) => l === '📱 Someone (102r)'), 'annotate: softphone (102r, not in map) untouched');
ok(graph.nodes.find((x) => x.id === 'dev')!.lines!.some((l) => l === '📞 Person 🔴 (103) (Poly VVX450)'), 'annotate: unregistered phone → 🔴 + model');
ok(n === 2, 'annotate: 2 physical phones annotated (softphone skipped)');

// model-less phone → circle only
const g2: FlowGraph = { entity: { kind: 'queue', ref: 'x', label: 'x' }, domain: 'd', rootId: 'a', notes: [], edges: [], nodes: [{ id: 'a', kind: 'agents', label: 'x', lines: ['📞 Y (200)'] }] };
annotateDevices(g2, new Map([['200', { aor: '200', model: '', registered: true }]]));
ok(g2.nodes[0]!.lines!.some((l) => l === '📞 Y 🟢 (200)'), 'annotate: phone with no model → presence circle only');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
