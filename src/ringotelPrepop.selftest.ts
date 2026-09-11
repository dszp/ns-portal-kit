/**
 * Selftests for directory pre-population: the pure plan, and the create it produces. Fully offline.
 *
 * Run: pnpm test:prepop
 */
import { applyDirectoryPrepop, planDirectoryReconcile, applyDirectoryReconcile, planOrphanDevices, applyOrphanDeletes, planExtensionReconcile, type PrepopInput, type PrepopCandidate, type DeviceRec } from './ringotelPrepop.js';
import type { EligibilityConfig } from '@dszp/netsapiens-lib';
import { resolveCanonicalUser, type User } from '@dszp/ringotel-lib';

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
// The create/skip half of the ONE planner, isolated: `maxRemove: 0` caps removals away, so a fixture built
// to exercise creation cannot have its answer coloured by a removal it never set up. A cap, not a second
// planner — the same fold runs either way.
const NOREM = { ...OPTS, maxRemove: 0 };

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
  const p = planDirectoryReconcile([nsUser('100', 'Jane Doe', 'jane@example.com')], [], NOREM);
  ok(exts(p) === '100' && p.create[0]!.tier === 'ok', 'an eligible user with no Ringotel record is created');
  ok(p.considered === 1 && p.present === 0, 'the plan reports what it considered');
}
{
  // The whole point of option 2: no email blocks ACTIVATION, not a directory entry.
  const p = planDirectoryReconcile([nsUser('101', 'No Email', '')], [], NOREM);
  ok(exts(p) === '101' && p.create[0]!.tier === 'precondition', 'a user with no email IS created, as `precondition`');
  ok(p.create[0]!.email === '', "and the known-empty address is carried through, not dropped");
}
{
  const p = planDirectoryReconcile([nsUser('102', 'Unknown Email', undefined)], [], NOREM);
  ok(exts(p) === '102' && !('email' in p.create[0]!), 'an UNKNOWN email is omitted entirely rather than sent as blank');
}
{
  const p = planDirectoryReconcile([nsUser('103', 'Svc User', 'x@example.com', { srvCode: '11' })], [], NOREM);
  ok(p.create.length === 0 && skipReason(p, '103') === 'hard', 'a hard-gated user (service code) is NEVER created');
}
{
  const p = planDirectoryReconcile([nsUser('abc', 'Weird Ext', 'x@example.com')], [], NOREM);
  ok(p.create.length === 0 && skipReason(p, 'abc') === 'hard', 'a non-numeric extension is hard-gated');
}

// ── soft gating, and the flag that overrides it ───────────────────────────────
{
  const users = [nsUser('104', 'SHARED VOICEMAIL', 'x@example.com'), nsUser('900', 'Blocked Pattern', 'x@example.com')];
  const off = planDirectoryReconcile(users, [], NOREM);
  ok(off.create.length === 0, 'soft-gated users are skipped by default');
  ok(skipReason(off, '104') === 'soft' && skipReason(off, '900') === 'soft', 'both a name match and an ext pattern are soft');
  ok((off.skipped.find((s) => s.ext === '104')?.detail ?? '').length > 0, 'the skip carries the reason, so a preview can explain itself');
  const on = planDirectoryReconcile(users, [], { ...NOREM, includeSoft: true });
  ok(on.create.length === 2 && on.create.every((c) => c.tier === 'soft'), 'includeSoft admits them, tagged as soft');
}

// ── existing records are never touched ────────────────────────────────────────
{
  const rt = [rtUser({ id: 'U1', extension: '100', status: 1, username: '100r', authname: '100r' })];
  const p = planDirectoryReconcile([nsUser('100', 'Jane Doe', 'jane@example.com')], rt, NOREM);
  // The skip reason is as specific as the per-extension fold can make it: an active record says `active`,
  // and only a placeholder that is present and in sync reports `already-present`. Nothing to create either
  // way — that is what the create half of the plan promises.
  ok(p.create.length === 0 && skipReason(p, '100') === 'active', 'an ACTIVE record means nothing to create, and says so');
  ok(p.present === 1, 'and it counts toward present');
}
{
  const rt = [rtUser({ id: 'U1', extension: '100', status: 0 })];
  const p = planDirectoryReconcile([nsUser('100', 'Jane Doe', 'jane@example.com')], rt, NOREM);
  ok(p.create.length === 0, 'an INACTIVE record also counts as present — pre-population is idempotent');
}
{
  const rt = [rtUser({ id: 'U1', extension: '100', status: 1, username: '100r', authname: '100r' }), rtUser({ id: 'U2', extension: '100', status: 1, username: '100r', authname: '100r' })];
  const p = planDirectoryReconcile([nsUser('100', 'Jane Doe', 'j@example.com')], rt, NOREM);
  ok(p.create.length === 0 && skipReason(p, '100') === 'ambiguous', 'an AMBIGUOUS pair is left alone, never added to — and named as ambiguous');
}
{
  // A record in a different branch is a different tenant's user and must not count as present.
  const rt = [{ id: 'U1', extension: '100', branchid: 'OTHER', status: 1 } as unknown as User];
  const p = planDirectoryReconcile([nsUser('100', 'Jane Doe', 'j@example.com')], rt, NOREM);
  ok(exts(p) === '100', "another branch's record does not satisfy this branch");
}

// ── input hygiene ─────────────────────────────────────────────────────────────
{
  const p = planDirectoryReconcile([nsUser('', 'No Ext', 'x@example.com')], [], NOREM);
  ok(p.create.length === 0 && skipReason(p, '') === 'no-extension', 'a user with no extension is skipped');
}
{
  const p = planDirectoryReconcile([nsUser('105', '   ', 'x@example.com')], [], NOREM);
  ok(p.create.length === 0 && skipReason(p, '105') === 'no-name', 'a blank display name is skipped — Ringotel needs a readable name');
}
{
  // "Nobody exists" and "the read failed" are indistinguishable, so an empty NS list is an ABORT rather
  // than a plan that happens to be empty — the create-only surface used to project that away.
  const p = planDirectoryReconcile([], [], NOREM);
  ok(p.create.length === 0 && p.skipped.length === 0, 'an empty domain plans nothing');
  ok(p.status === 'abort' && p.reason === 'ns-list-empty', '...and says it refused rather than reporting an empty answer');
}
{
  const many = ['200', '201', '202'].map((e) => nsUser(e, `User ${e}`, `${e}@example.com`));
  const p = planDirectoryReconcile(many, [rtUser({ id: 'U', extension: '201', status: 0 })], NOREM);
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

// ── planExtensionReconcile: one rule for the event tier and the cron ─────────────────────────────
const placeholder = (ext: string, name: string, extra: Record<string, unknown> = {}) =>
  rtUser({ id: `P${ext}`, extension: ext, status: -1, username: ext, name, ...extra });
const tombstone = (ext: string) => rtUser({ id: `T${ext}`, extension: ext, status: -1, authname: `${ext}r`, name: 'Old Person' });
const active = (ext: string) => rtUser({ id: `A${ext}`, extension: ext, status: 1, username: `${ext}r`, authname: `${ext}r`, name: 'Live Person' });
{
  const v = planExtensionReconcile(nsUser('200', 'Jane Doe', 'jane@example.com'), '200', [], OPTS);
  ok(v.action === 'create' && v.candidate.ext === '200' && v.candidate.email === 'jane@example.com', 'qualifying user, no record ⇒ create');
}
{
  const v = planExtensionReconcile(nsUser('201', 'Svc', 'x@example.com', { srvCode: '11' }), '201', [], OPTS);
  ok(v.action === 'none' && v.reason === 'hard', 'hard-gated user with no record ⇒ nothing (never created)');
}
{
  const v = planExtensionReconcile(nsUser('202', 'Jane Doe', 'jane@example.com'), '202', [placeholder('202', 'Jane Doe', { email: 'jane@example.com' })], OPTS);
  ok(v.action === 'none' && v.reason === 'in-sync', 'placeholder already matching ⇒ in-sync');
}
{
  const v = planExtensionReconcile(nsUser('203', 'Jane Smith', 'jane@example.com'), '203', [placeholder('203', 'Jane Doe', { email: 'jane@example.com' })], OPTS);
  ok(v.action === 'update' && v.id === 'P203' && v.changes.name === 'Jane Smith' && !('email' in v.changes), 'name drift ⇒ update with ONLY the name');
}
{
  const v = planExtensionReconcile(nsUser('204', 'Jane Doe', ''), '204', [placeholder('204', 'Jane Doe', { email: 'old@example.com' })], OPTS);
  ok(v.action === 'update' && v.changes.email === '', 'address removed in NS (known blank) ⇒ blank is written faithfully');
}
{
  const v = planExtensionReconcile(nsUser('205', 'Jane Doe', undefined), '205', [placeholder('205', 'Jane Doe', { email: 'old@example.com' })], OPTS);
  ok(v.action === 'none' && v.reason === 'in-sync', 'UNKNOWN email never produces a write');
}
{
  const v = planExtensionReconcile(nsUser('206', 'Jane Doe', 'j@example.com', { srvCode: '11' }), '206', [placeholder('206', 'Jane Doe')], OPTS);
  ok(v.action === 'remove' && v.reason === 'ineligible' && v.id === 'P206', 'placeholder whose user is now hard-gated ⇒ remove (ineligible)');
}
{
  const soft = nsUser('207', 'SHARED VOICEMAIL', 'v@example.com');
  // The placeholder already carries the NS address, so "kept" shows up as `in-sync` rather than as an
  // (equally correct, but less specific) email update — the flag under test is removal, not drift.
  const rec = () => placeholder('207', 'SHARED VOICEMAIL', { email: 'v@example.com' });
  const off = planExtensionReconcile(soft, '207', [rec()], OPTS);
  const on = planExtensionReconcile(soft, '207', [rec()], { ...OPTS, includeSoft: true });
  ok(off.action === 'remove' && off.reason === 'ineligible', 'soft-gated placeholder ⇒ removed when the soft flag is off');
  ok(on.action === 'none' && on.reason === 'in-sync', 'and kept when the soft flag is on');
}
{
  // `excludeNoDevices` makes a name exclusion bite only for a user with NO devices — and a caller that
  // cannot count devices per user sends nothing, which `evaluateEligibility` reads as zero. Refusing to
  // CREATE on that inference costs a directory entry; DELETING on it costs a record, and an `ineligible`
  // removal is the one kind never confirmed against NetSapiens. So a soft verdict may only remove when
  // the count it might have rested on is actually known.
  const NODEV = { ...OPTS, config: { ...CONFIG, excludeNoDevices: true } };
  const rec = () => placeholder('221', 'SHARED LINE', { email: 'v@example.com' });
  const unknown = planExtensionReconcile(nsUser('221', 'SHARED LINE', 'v@example.com'), '221', [rec()], NODEV);
  ok(unknown.action === 'none' && unknown.reason === 'soft' && unknown.detail === 'device count unknown — removal refused',
     'excludeNoDevices + an UNKNOWN device count ⇒ the soft placeholder is kept, and says why');
  const counted = planExtensionReconcile(nsUser('221', 'SHARED LINE', 'v@example.com', { deviceCount: 0 }), '221', [rec()], NODEV);
  ok(counted.action === 'remove' && counted.reason === 'ineligible', '...a COUNTED zero still removes it — that verdict rests on evidence');
  const noFlag = planExtensionReconcile(nsUser('221', 'SHARED LINE', 'v@example.com'), '221', [rec()], OPTS);
  ok(noFlag.action === 'remove' && noFlag.reason === 'ineligible', '...and with the flag off the verdict never depended on the count, so the removal stands');
  const hasDevice = planExtensionReconcile(nsUser('221', 'SHARED LINE', 'v@example.com', { deviceCount: 1 }), '221', [rec()], NODEV);
  ok(hasDevice.action === 'none' && hasDevice.reason === 'in-sync', '...and a counted device makes the name exclusion miss entirely (not soft at all)');
  // Creation is unchanged: an unknown count still refuses to CREATE, which is the cheap direction.
  const create = planExtensionReconcile(nsUser('222', 'SHARED LINE', 'v@example.com'), '222', [], NODEV);
  ok(create.action === 'none' && create.reason === 'soft', 'an unknown count still refuses to CREATE a soft-named entry');
}
{
  const v = planExtensionReconcile(null, '208', [placeholder('208', 'Gone Person')], OPTS);
  ok(v.action === 'remove' && v.reason === 'ns-gone' && v.id === 'P208', 'extension gone from NS ⇒ placeholder removed');
}
{
  const v = planExtensionReconcile(null, '209', [tombstone('209')], OPTS);
  ok(v.action === 'none' && v.reason === 'tombstone', 'a tombstone (has authname) is NEVER touched, even when NS is gone');
}
{
  const v = planExtensionReconcile(null, '210', [active('210')], OPTS);
  ok(v.action === 'none' && v.reason === 'active', 'an active record is never this feature\'s business (offboarding owns it)');
}
{
  const v = planExtensionReconcile(nsUser('211', 'Jane Doe', 'j@example.com'), '211', [active('211')], OPTS);
  ok(v.action === 'none' && v.reason === 'active', '...nor is it when NS still has the user');
}
{
  const v = planExtensionReconcile(null, '212', [], OPTS);
  ok(v.action === 'none' && v.reason === 'absent', 'nothing on either side ⇒ absent');
}
{
  const v = planExtensionReconcile(nsUser('213', '', 'j@example.com'), '213', [], OPTS);
  ok(v.action === 'none' && v.reason === 'no-name', 'a nameless user gets no placeholder (a directory entry IS a name)');
}
{
  // A NetSapiens "Reset User" leaves this shape behind: the name and the email are stripped, the record
  // itself stays. With a placeholder already there, the nameless row must not be SYNCED onto it — the
  // blank name cannot be written (only a non-empty name ever is), but the blank EMAIL could, and that is
  // a write onto an account nothing should be writing to. It must not be REMOVED either: a reset account
  // is routinely recycled for the next hire, and the placeholder is what that hire activates.
  const v = planExtensionReconcile(nsUser('215', '', ''), '215', [placeholder('215', 'Jane Doe', { email: 'jane@example.com' })], OPTS);
  ok(v.action === 'none' && v.reason === 'no-name', 'a nameless (reset-shaped) NS row with an existing placeholder ⇒ none/no-name');
  ok(v.action !== 'update' && v.action !== 'remove', '...never an update (it would clear the stored email) and never a removal (a reset account gets recycled)');
}
{
  const v = planExtensionReconcile(nsUser('214', 'Jane Doe', 'j@example.com'), '214', [placeholder('214', 'Jane Doe', { branchid: 'B9' })], OPTS);
  ok(v.action === 'create', 'a placeholder on ANOTHER connection is invisible here — the planner is per connection');
}
{
  // Hand-made in the vendor UI with Activate off: username = ext, no authname — ours to manage.
  const v = planExtensionReconcile(null, '215', [rtUser({ id: 'H215', extension: '215', status: -1, username: '215', name: 'Hand Made' })], OPTS);
  ok(v.action === 'remove' && v.id === 'H215', 'a placeholder made by hand in the vendor UI is treated as ours');
}
{
  // The plain pair: `resolveCanonicalUser` sees both and calls it ambiguous itself, so this exercises the
  // LIBRARY's gate and never reaches the duplicate check below it.
  const rt = [placeholder('216', 'A'), placeholder('216', 'B')];
  ok(resolveCanonicalUser(rt, { ext: '216', branchid: 'B1', suffix: 'r' }).verdict === 'ambiguous', 'two identical placeholders are ambiguous to the library itself');
  const v = planExtensionReconcile(null, '216', rt, OPTS);
  ok(v.action === 'none' && v.reason === 'ambiguous', 'two placeholders at one extension ⇒ refuse rather than guess (the library gate)');
}
{
  // …and the pair the library MISSES. Its extension match is an untrimmed string compare, so a record
  // stored as ' 216' is invisible to it and the pair resolves as one ordinary inactive record. This
  // planner trims before building `here`, so it sees both — and `placeholders.length > 1` is the gate that
  // stops it deleting one of a pair on a NetSapiens 404. Losing that gate would not fail any other test.
  const rt = [placeholder(' 216', 'Padded'), placeholder('216', 'Plain')];
  ok(resolveCanonicalUser(rt, { ext: '216', branchid: 'B1', suffix: 'r' }).verdict !== 'ambiguous', 'the library does NOT catch a padded duplicate — its extension compare is untrimmed');
  const v = planExtensionReconcile(null, '216', rt, OPTS);
  ok(v.action === 'none' && v.reason === 'ambiguous', 'a padded duplicate is still ambiguous here — the planner trims, and refuses rather than delete one of a pair');
}
{
  // An ATTACHED SECONDARY (`userid` set) sits at its primary's extension and is one app login on another
  // connection — never a candidate. It must not make the extension look like a duplicate pair.
  const secondary = rtUser({ id: 'S217', extension: '217', status: 1, username: '217r', authname: '217r', name: 'Primary Elsewhere', userid: 'X' });
  const v = planExtensionReconcile(null, '217', [placeholder('217', 'Gone Person'), secondary], OPTS);
  ok(v.action === 'remove' && v.id === 'P217', 'an attached secondary beside a placeholder is invisible, not ambiguous');
}
{
  // Ringotel types `id` as required, so this is a malformed record — but "cannot act" must never be
  // reported as "nothing to do", or a drifted entry looks settled forever.
  const noId = rtUser({ extension: '218', status: -1, username: '218', name: 'Old Name' });
  const v = planExtensionReconcile(nsUser('218', 'New Name', 'j@example.com'), '218', [noId], OPTS);
  ok(v.action === 'none' && v.reason === 'ambiguous' && v.detail === 'record has no id', 'a placeholder with no id is unactionable, not in-sync');
}
{
  // Someone's app login already lives at this extension on this connection (their primary is on another).
  // Filtering the secondary out of the DECISION is right; treating the extension as empty is not.
  const secondary = rtUser({ id: 'S219', extension: '219', status: 1, username: '219r', authname: '219r', name: 'Primary Elsewhere', userid: 'X' });
  const there = planExtensionReconcile(nsUser('219', 'Jane Doe', 'j@example.com'), '219', [secondary], OPTS);
  const gone = planExtensionReconcile(null, '219', [secondary], OPTS);
  ok(there.action === 'none' && there.reason === 'active', 'a lone attached secondary is not a directory gap — never create beside it');
  ok(gone.action === 'none' && gone.reason === 'active', 'and it is never removed when NetSapiens drops the extension');
}
{
  // `username` carries the SIP identity too. A record holding `<ext><suffix>` there is a once-provisioned
  // user however its `authname` reads — deleting it is exactly the harm the placeholder test exists to stop.
  const sip = rtUser({ id: 'X220', extension: '220', status: -1, username: '220r', name: 'Once Provisioned' });
  const v = planExtensionReconcile(null, '220', [sip], OPTS);
  ok(v.action === 'none' && v.reason === 'tombstone', 'a record carrying the SIP identity in `username` is not a placeholder');
}

// ── planDirectoryReconcile: the fold, the guards, the cap ────────────────────────────────────────
const ROPTS = { ...OPTS, maxRemove: 200 };
{
  const p = planDirectoryReconcile(null, [placeholder('300', 'X')], ROPTS);
  ok(p.status === 'abort' && p.reason === 'ns-list-unavailable' && p.remove.length === 0 && p.create.length === 0, 'a FAILED NS read plans nothing');
  const q = planDirectoryReconcile([], [placeholder('300', 'X')], ROPTS);
  ok(q.status === 'abort' && q.reason === 'ns-list-empty' && q.remove.length === 0, 'an EMPTY NS list plans nothing — "nobody exists" is indistinguishable from "could not read"');
}
{
  const ns = [nsUser('301', 'New Person', 'n@example.com'), nsUser('302', 'Renamed Person', 'r@example.com'), nsUser('303', 'Svc', 's@example.com', { srvCode: '11' }), nsUser('304', 'Live Person', 'l@example.com')];
  // The secondary at 307 is the case where the test's own union and the planner's `userid == null` filter
  // legitimately disagree: it is in the test's set and not in the planner's, and the fold still matches,
  // because the extension it sits at yields no action either way.
  const secondary = rtUser({ id: 'S307', extension: '307', status: 1, username: '307r', authname: '307r', name: 'Primary Elsewhere', userid: 'X' });
  const rt = [placeholder('302', 'Old Name', { email: 'r@example.com' }), placeholder('303', 'Svc'), placeholder('305', 'Gone'), tombstone('306'), active('304'), secondary];
  const p = planDirectoryReconcile(ns, rt, ROPTS);
  ok(p.status === 'ok' && p.create.map((c) => c.ext).join() === '301', 'create: the new user');
  ok(p.update.length === 1 && p.update[0]!.ext === '302' && p.update[0]!.changes.name === 'Renamed Person', 'update: the renamed placeholder');
  ok(p.remove.map((r) => `${r.ext}:${r.reason}`).sort().join() === '303:ineligible,305:ns-gone', 'remove: now-ineligible and NS-gone placeholders, nothing else');
  ok(skipReason(p, '304') === 'active' && skipReason(p, '306') === 'tombstone', 'active and tombstone records are reported as skipped, with the reason');
  ok(p.considered === 4 && p.present === 2, 'counts: NS users considered; NS users with a record (302, 304)');
  // The contract that keeps the two doors honest: the domain plan IS the fold of per-extension verdicts.
  const exts = new Set([...ns.map((u) => u.ext), ...rt.filter((u) => u.branchid === 'B1').map((u) => String(u.extension))]);
  const folded = [...exts].map((ext) => planExtensionReconcile(ns.find((u) => u.ext === ext) ?? null, ext, rt, ROPTS));
  // Per action and by extension, not by count: two lists of the same length can name different people.
  const foldedExts = (action: string) => folded.filter((v) => v.action === action).map((v) => (v.action === 'create' ? v.candidate.ext : v.ext)).sort().join(',');
  const planned = (rows: { ext: string }[]) => rows.map((r) => r.ext).sort().join(',');
  ok(foldedExts('create') === planned(p.create), 'domain plan == fold of per-extension verdicts: the same extensions are created');
  ok(foldedExts('update') === planned(p.update), '...the same extensions are updated');
  ok(foldedExts('remove') === planned(p.remove), '...and the same extensions are removed');
}
{
  const rt = ['310', '311', '312'].map((e) => placeholder(e, 'Gone'));
  const p = planDirectoryReconcile([nsUser('399', 'Keeps List Non-Empty', 'k@example.com')], rt, { ...ROPTS, maxRemove: 2 });
  ok(p.remove.length === 2 && p.truncated === true && p.remove.map((r) => r.ext).join() === '310,311', 'remove is capped per run, lowest extensions first, and says so');
  const many = Array.from({ length: 250 }, (_, i) => nsUser(String(1000 + i), `P ${i}`, ''));
  const q = planDirectoryReconcile(many, [], { ...ROPTS, maxRemove: 2 });
  ok(q.create.length === 250 && q.truncated === false, 'create is NOT capped — a half-built directory for hours is the worse outcome');
}
{
  // A list that came back with rows but no usable extension in any of them is a read that went wrong in a
  // shape `length > 0` cannot see. Left to the fold it reads as "the whole domain left".
  const p = planDirectoryReconcile([nsUser('', 'No Ext', 'x@example.com')], [placeholder('340', 'Gone')], ROPTS);
  ok(p.status === 'abort' && p.reason === 'ns-list-unusable' && p.remove.length === 0 && p.create.length === 0, 'an NS list with rows but no extensions plans nothing');
  ok(skipReason(p, '') === 'no-extension', 'and the aborted plan still says what it saw');
}
{
  const p = planDirectoryReconcile([nsUser('330', 'Jane Doe', 'j@example.com')], [placeholder('331', 'Other Tenant', { branchid: 'B9' })], ROPTS);
  ok(p.remove.length === 0, "a placeholder on ANOTHER connection is never removed — the planner is per connection");
  ok(p.create.map((c) => c.ext).join() === '330', "and this connection's own gap is still planned");
}
{
  // `maxRemove` is a CAP on the removal list, not a different plan: capping it to zero must leave the
  // creates, the skips and the counts byte-for-byte identical, or the create-only callers are quietly
  // running a second planner. Ext 321 is a placeholder whose NS user is now hard-gated — a removal at
  // `maxRemove: 200`, and the row that would move if the cap did more than slice.
  const ns = [nsUser('320', 'Jane', 'j@example.com'), nsUser('321', 'Svc', 's@example.com', { srvCode: '11' })];
  const capped = planDirectoryReconcile(ns, [placeholder('321', 'Svc')], NOREM);
  const full = planDirectoryReconcile(ns, [placeholder('321', 'Svc')], ROPTS);
  ok(exts(capped) === exts(full), 'maxRemove: 0 changes nothing but the removals — the same creates');
  ok(capped.considered === full.considered, '...the same `considered` count');
  ok(capped.present === full.present, '...the same `present` count');
  ok(JSON.stringify(capped.skipped) === JSON.stringify(full.skipped), '...every skip and its reason, unchanged');
  ok(full.remove.map((r) => r.ext).join() === '321', 'uncapped, ext 321 IS a removal — so there is a row for the cap to cut');
  ok(capped.remove.length === 0, '...capped, the removal list is empty');
  ok(capped.truncated === true, '...and the cut is REPORTED as truncated, never silently dropped');
}
// ── applyDirectoryReconcile: order, resilience, counts ───────────────────────────────────────────
{
  const calls: string[] = [];
  const w = {
    createUser: async (i: Record<string, unknown>) => { calls.push(`create:${i['extension']}`); if (i['extension'] === '402') throw new Error('boom'); return { id: 'N' }; },
    updateUser: async (id: string, _o: string, c: Record<string, unknown>) => { calls.push(`update:${id}:${Object.keys(c).sort().join('+')}`); return {}; },
    deleteUser: async (id: string) => { calls.push(`delete:${id}`); return {}; },
    confirmGone: async () => true,
  };
  const plan = { status: 'ok' as const, create: [{ ext: '401', name: 'A', tier: 'ok' }, { ext: '402', name: 'B', tier: 'ok' }], update: [{ id: 'P1', ext: '403', changes: { name: 'C', email: '' } }], remove: [{ id: 'P2', ext: '404', reason: 'ns-gone' as const }], skipped: [], present: 0, considered: 0, truncated: false };
  const res = await applyDirectoryReconcile(w, 'ORG', 'B1', plan);
  ok(calls.join(' ') === 'create:401 create:402 update:P1:email+name delete:P2', 'create → update → delete, in that order');
  ok(res.created === 1 && res.updated === 1 && res.removed === 1 && res.failed.length === 1 && res.failed[0]!.op === 'create' && res.failed[0]!.ext === '402', 'one failure does not stop the rest, and is named with its op');
}
{
  const w = { createUser: async () => { throw new Error('must not run'); }, updateUser: async () => ({}), deleteUser: async () => { throw new Error('must not run'); }, confirmGone: async () => { throw new Error('must not run'); } };
  const res = await applyDirectoryReconcile(w, 'ORG', 'B1', { status: 'abort', reason: 'ns-list-empty', create: [{ ext: '1', name: 'x', tier: 'ok' }], update: [], remove: [{ id: 'P', ext: '2', reason: 'ns-gone' }], skipped: [], present: 0, considered: 0, truncated: false });
  ok(res.created === 0 && res.removed === 0 && res.failed.length === 0, 'an aborted plan applies NOTHING, whatever its lists say');
}

{
  // `ns-gone` is an inference from a LIST read, and a truncated page says the same thing as a departure.
  // The delete is confirmed against the record itself, immediately before it happens.
  const calls: string[] = [];
  const w = {
    createUser: async () => ({}),
    updateUser: async () => ({}),
    deleteUser: async (id: string) => { calls.push(`delete:${id}`); return {}; },
    confirmGone: async (ext: string) => { calls.push(`confirm:${ext}`); return ext === '501'; },
  };
  const plan = { status: 'ok' as const, create: [], update: [], remove: [{ id: 'G1', ext: '501', reason: 'ns-gone' as const }, { id: 'G2', ext: '502', reason: 'ns-gone' as const }], skipped: [], present: 0, considered: 0, truncated: false };
  const res = await applyDirectoryReconcile(w, 'ORG', 'B1', plan);
  ok(calls.join(' ') === 'confirm:501 delete:G1 confirm:502', 'every ns-gone removal is confirmed with NetSapiens before the delete');
  ok(res.removed === 1 && res.failed.length === 1 && res.failed[0]!.ext === '502' && res.failed[0]!.error === 'not confirmed gone', 'an unconfirmed removal is a reported failure, never a delete');
}
{
  const calls: string[] = [];
  const w = {
    createUser: async () => ({}),
    updateUser: async () => ({}),
    deleteUser: async (id: string) => { calls.push(`delete:${id}`); return {}; },
    confirmGone: async (ext: string) => { calls.push(`confirm:${ext}`); return true; },
  };
  const res = await applyDirectoryReconcile(w, 'ORG', 'B1', { status: 'ok', create: [], update: [], remove: [{ id: 'I1', ext: '503', reason: 'ineligible' }], skipped: [], present: 0, considered: 0, truncated: false });
  ok(calls.join(' ') === 'delete:I1' && res.removed === 1, 'an `ineligible` removal needs no confirmation — its NS record was read to reach that verdict');
}
{
  const w = {
    createUser: async () => ({}),
    updateUser: async () => ({}),
    deleteUser: async () => { throw new Error('must not run'); },
    confirmGone: async () => { throw new Error('ns unreachable'); },
  };
  const res = await applyDirectoryReconcile(w, 'ORG', 'B1', { status: 'ok', create: [], update: [], remove: [{ id: 'G3', ext: '504', reason: 'ns-gone' }], skipped: [], present: 0, considered: 0, truncated: false });
  ok(res.removed === 0 && res.failed.length === 1 && res.failed[0]!.error.includes('ns unreachable'), 'a confirmation that FAILS is not a confirmation — nothing is deleted');
}
{
  // `removed` is a count, and a delete leaves nothing behind to look at afterwards — so the applier
  // names the extensions it actually deleted, and only those. The refused one is the point: derived by
  // the caller as "plan.remove minus the failures" this would still look right, and it would stop
  // looking right the first time a removal ends in neither a clean success nor a `failed` entry.
  const w = {
    createUser: async () => ({}),
    updateUser: async () => ({}),
    deleteUser: async (id: string) => { if (id === 'BOOM') throw new Error('vendor 500'); return {}; },
    confirmGone: async (ext: string) => ext !== '606',
  };
  const res = await applyDirectoryReconcile(w, 'ORG', 'B1', {
    status: 'ok', create: [], update: [],
    remove: [
      { id: 'G5', ext: '605', reason: 'ns-gone' },
      { id: 'G6', ext: '606', reason: 'ns-gone' },      // refused: not confirmed gone
      { id: 'I7', ext: '607', reason: 'ineligible' },
      { id: 'BOOM', ext: '608', reason: 'ineligible' }, // the delete itself throws
    ],
    skipped: [], present: 0, considered: 0, truncated: false,
  });
  ok(res.removed === 2, 'two of the four removals went through');
  ok(res.removedExts.length === 2, 'and removedExts carries exactly those two, not the whole plan');
  ok(res.removedExts[0]?.ext === '605' && res.removedExts[0]?.reason === 'ns-gone', 'a confirmed ns-gone removal is named with its verdict');
  ok(res.removedExts[1]?.ext === '607' && res.removedExts[1]?.reason === 'ineligible', 'an ineligible removal is named with its verdict');
  ok(!res.removedExts.some((r) => r.ext === '606'), 'an unconfirmed removal is NOT reported as removed');
  ok(!res.removedExts.some((r) => r.ext === '608'), 'a removal whose delete threw is NOT reported as removed');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
