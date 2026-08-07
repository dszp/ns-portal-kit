/**
 * Selftests for directory pre-population: the pure plan, and the create it produces. Fully offline.
 *
 * Run: pnpm test:prepop
 */
import { planDirectoryPrepop, applyDirectoryPrepop, planOrphanDevices, applyOrphanDeletes, type PrepopInput, type PrepopCandidate, type DeviceRec } from './ringotelPrepop.js';
import type { EligibilityConfig } from '@dszp/netsapiens-lib';
import type { User } from '@dszp/ringotel-lib';

let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${m}`);
};

const CONFIG: EligibilityConfig = {
  excludeNames: ['shared', 'voicemail', 'conference'],
  excludeExts: ['9*'],
  excludeExtsByDomain: {},
  excludeNoDevices: false,
  resellerOverride: new Set(),
};
const OPTS = { domain: 'acme.example.com', branchid: 'B1', suffix: 'r', isReseller: false, config: CONFIG };

const nsUser = (ext: string, name: string, email: string | undefined, extra: Record<string, unknown> = {}): PrepopInput => ({
  ext,
  name,
  ...(email !== undefined ? { email } : {}),
  elig: { ext, names: name ? name.split(' ') : [], ...(email !== undefined ? { email } : {}), ...extra },
});
const rtUser = (o: Record<string, unknown>): User => ({ branchid: 'B1', ...o }) as User;
const exts = (p: { create: PrepopCandidate[] }) => p.create.map((c) => c.ext).join(',');
const skipReason = (p: { skipped: { ext: string; reason: string }[] }, ext: string) => p.skipped.find((s) => s.ext === ext)?.reason;

// ── the basic decision ────────────────────────────────────────────────────────
{
  const p = planDirectoryPrepop([nsUser('100', 'Jane Doe', 'jane@example.com')], [], OPTS);
  ok(exts(p) === '100' && p.create[0]!.tier === 'ok', 'an eligible user with no Ringotel record is created');
  ok(p.considered === 1 && p.present === 0, 'the plan reports what it considered');
}
{
  // The whole point of option 2: no email blocks ACTIVATION, not a directory entry.
  const p = planDirectoryPrepop([nsUser('101', 'No Email', '')], [], OPTS);
  ok(exts(p) === '101' && p.create[0]!.tier === 'precondition', 'a user with no email IS created, as `precondition`');
  ok(p.create[0]!.email === '', "and the known-empty address is carried through, not dropped");
}
{
  const p = planDirectoryPrepop([nsUser('102', 'Unknown Email', undefined)], [], OPTS);
  ok(exts(p) === '102' && !('email' in p.create[0]!), 'an UNKNOWN email is omitted entirely rather than sent as blank');
}
{
  const p = planDirectoryPrepop([nsUser('103', 'Svc User', 'x@example.com', { srvCode: '11' })], [], OPTS);
  ok(p.create.length === 0 && skipReason(p, '103') === 'hard', 'a hard-gated user (service code) is NEVER created');
}
{
  const p = planDirectoryPrepop([nsUser('abc', 'Weird Ext', 'x@example.com')], [], OPTS);
  ok(p.create.length === 0 && skipReason(p, 'abc') === 'hard', 'a non-numeric extension is hard-gated');
}

// ── soft gating, and the flag that overrides it ───────────────────────────────
{
  const users = [nsUser('104', 'SHARED VOICEMAIL', 'x@example.com'), nsUser('900', 'Blocked Pattern', 'x@example.com')];
  const off = planDirectoryPrepop(users, [], OPTS);
  ok(off.create.length === 0, 'soft-gated users are skipped by default');
  ok(skipReason(off, '104') === 'soft' && skipReason(off, '900') === 'soft', 'both a name match and an ext pattern are soft');
  ok((off.skipped.find((s) => s.ext === '104')?.detail ?? '').length > 0, 'the skip carries the reason, so a preview can explain itself');
  const on = planDirectoryPrepop(users, [], { ...OPTS, includeSoft: true });
  ok(on.create.length === 2 && on.create.every((c) => c.tier === 'soft'), 'includeSoft admits them, tagged as soft');
}

// ── existing records are never touched ────────────────────────────────────────
{
  const rt = [rtUser({ id: 'U1', extension: '100', status: 1, username: '100r', authname: '100r' })];
  const p = planDirectoryPrepop([nsUser('100', 'Jane Doe', 'jane@example.com')], rt, OPTS);
  ok(p.create.length === 0 && skipReason(p, '100') === 'already-present', 'an ACTIVE record means nothing to create');
  ok(p.present === 1, 'and it counts toward present');
}
{
  const rt = [rtUser({ id: 'U1', extension: '100', status: 0 })];
  const p = planDirectoryPrepop([nsUser('100', 'Jane Doe', 'jane@example.com')], rt, OPTS);
  ok(p.create.length === 0, 'an INACTIVE record also counts as present — pre-population is idempotent');
}
{
  const rt = [rtUser({ id: 'U1', extension: '100', status: 1, username: '100r', authname: '100r' }), rtUser({ id: 'U2', extension: '100', status: 1, username: '100r', authname: '100r' })];
  const p = planDirectoryPrepop([nsUser('100', 'Jane Doe', 'j@example.com')], rt, OPTS);
  ok(p.create.length === 0 && skipReason(p, '100') === 'already-present', 'an AMBIGUOUS pair is left alone, never added to');
}
{
  // A record in a different branch is a different tenant's user and must not count as present.
  const rt = [{ id: 'U1', extension: '100', branchid: 'OTHER', status: 1 } as unknown as User];
  const p = planDirectoryPrepop([nsUser('100', 'Jane Doe', 'j@example.com')], rt, OPTS);
  ok(exts(p) === '100', "another branch's record does not satisfy this branch");
}

// ── input hygiene ─────────────────────────────────────────────────────────────
{
  const p = planDirectoryPrepop([nsUser('', 'No Ext', 'x@example.com')], [], OPTS);
  ok(p.create.length === 0 && skipReason(p, '') === 'no-extension', 'a user with no extension is skipped');
}
{
  const p = planDirectoryPrepop([nsUser('105', '   ', 'x@example.com')], [], OPTS);
  ok(p.create.length === 0 && skipReason(p, '105') === 'no-name', 'a blank display name is skipped — Ringotel needs a readable name');
}
{
  ok(planDirectoryPrepop([], [], OPTS).create.length === 0, 'an empty domain plans nothing');
}
{
  const many = ['200', '201', '202'].map((e) => nsUser(e, `User ${e}`, `${e}@example.com`));
  const p = planDirectoryPrepop(many, [rtUser({ id: 'U', extension: '201', status: 0 })], OPTS);
  ok(exts(p) === '200,202' && p.present === 1, 'a mixed domain plans only the gaps');
}

// ── apply: what actually gets written ─────────────────────────────────────────
{
  const calls: Record<string, unknown>[] = [];
  const w = { createUser: async (i: Record<string, unknown>) => { calls.push(i); return { id: 'NEW' }; } };
  const res = await applyDirectoryPrepop(w, 'ORG1', 'B1', [
    { ext: '100', name: 'Jane Doe', email: 'jane@example.com', tier: 'ok' },
    { ext: '101', name: 'No Email', email: '', tier: 'precondition' },
  ]);
  ok(res.created === 2 && res.failed.length === 0, 'both entries are created');
  const first = calls[0]!;
  ok(first['status'] === 0, 'entries are created INACTIVE (status 0)');
  ok(first['orgid'] === 'ORG1' && first['branchid'] === 'B1' && first['extension'] === '100' && first['name'] === 'Jane Doe', 'identity fields are sent');
  // The load-bearing assertion: a placeholder must not own the SIP identity.
  ok(!('username' in first) && !('authname' in first) && !('password' in first), 'NO username/authname/password — the placeholder must not squat the SIP identity');
  ok(first['email'] === 'jane@example.com' && calls[1]!['email'] === '', 'a known address is sent, including a genuinely blank one');
}
{
  const w = { createUser: async (i: Record<string, unknown>) => { if (i['extension'] === '101') throw new Error('rt exploded'); return {}; } };
  const res = await applyDirectoryPrepop(w, 'ORG1', 'B1', [
    { ext: '100', name: 'A', tier: 'ok' },
    { ext: '101', name: 'B', tier: 'ok' },
    { ext: '102', name: 'C', tier: 'ok' },
  ]);
  ok(res.created === 2 && res.failed.length === 1, 'one failure does not stop the batch');
  ok(res.failed[0]!.ext === '101' && res.failed[0]!.error.includes('rt exploded'), 'the failure names the extension and the cause');
}
{
  const calls: Record<string, unknown>[] = [];
  const w = { createUser: async (i: Record<string, unknown>) => { calls.push(i); return {}; } };
  await applyDirectoryPrepop(w, 'ORG1', 'B1', [{ ext: '100', name: 'A', tier: 'ok' }]);
  ok(!('email' in calls[0]!), 'an unknown email is omitted from the create body entirely');
}
{
  const w = { createUser: async () => ({}) };
  const res = await applyDirectoryPrepop(w, 'ORG1', 'B1', []);
  ok(res.created === 0 && res.failed.length === 0, 'applying an empty plan is a no-op');
}


// ── orphan <ext>r devices ─────────────────────────────────────────────────────
const dev = (user: string, device: string, state?: string): DeviceRec => ({
  user, device, ...(state ? { 'device-sip-registration-state': state } : {}),
});
const OO = { branchid: 'B1', suffix: 'r' };
const delExts = (p: { delete: { ext: string }[] }) => p.delete.map((d) => d.ext).join(',');
const keepReason = (p: { keep: { ext: string; reason: string }[] }, ext: string) => p.keep.find((k) => k.ext === ext)?.reason;

{
  // The whole point: a leftover softphone on an extension with nothing else is a paid-for seat doing nothing.
  const p = planOrphanDevices([dev('100', '100r')], [], OO);
  ok(delExts(p) === '100' && p.delete[0]!.device === '100r', 'a sole, unregistered <ext>r with no Ringotel user is deletable');
  ok(p.found === 1, 'and it is counted as found');
}
{
  const rt = [rtUser({ id: 'U1', extension: '100', status: 1, username: '100r', authname: '100r' })];
  const p = planOrphanDevices([dev('100', '100r')], rt, OO);
  ok(p.delete.length === 0 && p.found === 0, 'an ACTIVE Ringotel user means the device is in service — not an orphan at all');
}
{
  const rt = [rtUser({ id: 'U1', extension: '100', status: 0 })];
  const p = planOrphanDevices([dev('100', '100r')], rt, OO);
  ok(delExts(p) === '100', 'an INACTIVE Ringotel record still leaves the device orphaned');
}
{
  // Condition 2: billing is per-extension-with-devices, so deleting saves nothing here.
  const p = planOrphanDevices([dev('100', '100r'), dev('100', 'deskphone')], [], OO);
  ok(p.delete.length === 0 && keepReason(p, '100') === 'other-devices', 'another device present ⇒ kept: the user stays billable, so deleting only costs credentials');
}
{
  // Condition 3: something is actually running.
  const p = planOrphanDevices([dev('100', '100r', 'registered')], [], OO);
  ok(p.delete.length === 0 && keepReason(p, '100') === 'registered', 'a REGISTERED device is never deleted');
  const un = planOrphanDevices([dev('101', '101r', 'unregistered')], [], OO);
  ok(delExts(un) === '101', 'an explicitly unregistered one is deletable');
}
{
  const rt = [
    rtUser({ id: 'U1', extension: '100', status: 1, username: '100r', authname: '100r' }),
    rtUser({ id: 'U2', extension: '100', status: 1, username: '100r', authname: '100r' }),
  ];
  const p = planOrphanDevices([dev('100', '100r')], rt, OO);
  ok(p.delete.length === 0 && keepReason(p, '100') === 'ambiguous', 'an ambiguous Ringotel state is never acted on — deletion is the wrong place to guess');
}
{
  const p = planOrphanDevices([dev('100', '100'), dev('101', '101x')], [], OO);
  ok(p.delete.length === 0 && p.found === 0, 'devices that are not <ext><suffix> are ignored entirely');
}
{
  const p = planOrphanDevices([dev('100', '100r'), dev('101', '101r'), dev('102', '102r', 'registered')], [], OO);
  ok(delExts(p) === '100,101', 'a mixed domain deletes only the safe ones');
}
{
  const p = planOrphanDevices([{ device: '100r' } as DeviceRec, dev('', '100r')], [], OO);
  ok(p.delete.length === 0, 'device records with no user are skipped rather than crashing');
}
{
  ok(planOrphanDevices([], [], OO).delete.length === 0, 'no devices ⇒ nothing to do');
}
{
  // A different suffix must be honoured.
  const p = planOrphanDevices([dev('100', '100s')], [], { branchid: 'B1', suffix: 's' });
  ok(delExts(p) === '100', 'a non-default suffix is respected');
  ok(planOrphanDevices([dev('100', '100s')], [], OO).delete.length === 0, "and a device that doesn't match the configured suffix is left alone");
}
{
  const calls: string[] = [];
  const w = { deleteDevice: async (_d: string, u: string, dv: string) => { calls.push(`${u}/${dv}`); return {}; } };
  const res = await applyOrphanDeletes(w, 'acme.example.com', [{ ext: '100', device: '100r' }, { ext: '101', device: '101r' }]);
  ok(res.deleted === 2 && calls.join(',') === '100/100r,101/101r', 'apply deletes each planned device');
}
{
  const w = { deleteDevice: async (_d: string, u: string) => { if (u === '101') throw new Error('nope'); return {}; } };
  const res = await applyOrphanDeletes(w, 'acme.example.com', [{ ext: '100', device: '100r' }, { ext: '101', device: '101r' }, { ext: '102', device: '102r' }]);
  ok(res.deleted === 2 && res.failed.length === 1 && res.failed[0]!.ext === '101', 'one failure does not stop the batch');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
