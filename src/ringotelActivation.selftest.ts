/** Offline test for the Ringotel activation orchestration (device-ensure + create/update/deactivate/
 *  reset) with recording mock clients, plus the write-domain safety rail. pnpm test:ringotelwrite */
import { activate, deactivate, resetPassword, ensureDevice, isDomainWritable, SIP_PW_FIELD, RingotelWriteError, type DeviceWriter, type RingotelUserWriter, syncIdentity, generateSipPassword, deactivateAppOnly, repairDeviceForEvent, resolveCanonical } from './ringotelActivation.js';
import type { User } from '@dszp/ringotel-lib';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

/** Mock NS device writer backed by an in-memory store; records every call. */
function mockDevices(seed: Record<string, string> = {}) {
  const store = new Map<string, Record<string, unknown>>();
  for (const [name, pw] of Object.entries(seed)) store.set(name, { device: name, [SIP_PW_FIELD]: pw });
  const calls: string[] = [];
  let pwSeq = 0;
  let failUpdate = false;
  const dw: DeviceWriter = {
    async getDevices() { calls.push('getDevices'); return [...store.values()]; },
    async getDevice(_d, _u, device) { calls.push(`getDevice:${device}`); return store.get(device) ?? {}; },
    async createDevice(_d, _u, device) { calls.push(`createDevice:${device}`); const rec = { device, [SIP_PW_FIELD]: `GEN${++pwSeq}` }; store.set(device, rec); return rec; },
    async deleteDevice(_d, _u, device) { calls.push(`deleteDevice:${device}`); store.delete(device); return {}; },
    async updateDevice(_d, _u, device, changes) {
      calls.push(`updateDevice:${device}`);
      if (failUpdate) throw new Error('device PUT unsupported on this release');
      const rec = { ...(store.get(device) ?? { device }), ...changes };
      store.set(device, rec);
      return rec;
    },
  };
  return { dw, calls, store, failUpdate: (v: boolean) => { failUpdate = v; } };
}

/** Mock Ringotel user writer; records the exact params of each mutation. */
function mockRt() {
  const calls: Array<{ m: string; args: any }> = [];
  const rw: RingotelUserWriter = {
    async createUser(input: any) { calls.push({ m: 'createUser', args: input }); return { id: 'NEWID', ...input }; },
    async updateUser(userid: string, orgid: string, changes: any) { calls.push({ m: 'updateUser', args: { userid, orgid, ...changes } }); return { id: userid } as any; },
    async deactivateUser(userid: string, orgid: string) { calls.push({ m: 'deactivateUser', args: { userid, orgid } }); return {}; },
    async deleteUser(userid: string, orgid: string) { calls.push({ m: 'deleteUser', args: { userid, orgid } }); return {}; },
    async resetUserPassword(userid: string, orgid: string) { calls.push({ m: 'resetUserPassword', args: { userid, orgid } }); return {}; },
  };
  return { rw, calls };
}

const rtUser = (o: any) => ({ id: o.id, extension: o.ext, branchid: 'B1', status: o.status ?? 0, ...o });
const base = () => ({ orgid: 'ORG1', branchid: 'B1', domain: 'acme.example', ext: '100', suffix: 'r', name: 'Jane Doe', email: 'jane@acme.example' });

(async () => {
  // ── ensureDevice: creates when missing, returns the generated SIP password ──
  {
    const { dw, calls } = mockDevices();
    const r = await ensureDevice(dw, 'acme.example', '100', '100r');
    ok(r.created === true && r.password === 'GEN1', 'ensureDevice creates a missing device and returns its generated SIP password');
    ok(calls.includes('createDevice:100r'), 'ensureDevice POSTs createDevice for a missing device');
  }
  // ── ensureDevice: reads the existing device's password (no create) ──
  {
    const { dw, calls } = mockDevices({ '100r': 'EXISTINGPW' });
    const r = await ensureDevice(dw, 'acme.example', '100', '100r');
    ok(r.created === false && r.password === 'EXISTINGPW', 'ensureDevice reads an existing device password without creating');
    ok(!calls.some((c) => c.startsWith('createDevice')), 'ensureDevice does NOT create when the device already exists');
  }

  // ── activate: NEW Ringotel user (none exists for the ext) ──
  {
    const { dw } = mockDevices();
    const { rw, calls } = mockRt();
    const res = await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: [] });
    const c = calls.find((x) => x.m === 'createUser')!;
    ok(res.action === 'created', 'activate with no existing RT user → createUser');
    ok(c && c.args.extension === '100' && c.args.username === '100r' && c.args.authname === '100r', 'createUser sends extension 100 + username/authname 100r');
    ok(c.args.password === 'GEN1' && c.args.status === 1 && c.args.noemail === false, 'createUser copies the generated SIP password, status 1, noemail false (Ringotel emails)');
    ok(c.args.orgid === 'ORG1' && c.args.branchid === 'B1' && c.args.email === 'jane@acme.example', 'createUser carries orgid/branchid/email');
    ok(c.args.name === 'Jane Doe', 'createUser sets the Ringotel display name from the NS identity');
  }

  // ── activate: EXISTING (deactivated) Ringotel user → updateUser status 1 + refreshed creds ──
  {
    const { dw } = mockDevices({ '100r': 'OLDPW' });
    const { rw, calls } = mockRt();
    const res = await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 0 })] });
    const u = calls.find((x) => x.m === 'updateUser')!;
    ok(res.action === 'updated' && res.rtUserId === 'U100', 'activate with an existing RT user → updateUser on that id');
    ok(u.args.status === 1 && u.args.username === '100r' && u.args.password === 'OLDPW', 'updateUser sets status 1 + re-syncs username/password from the device');
    ok(u.args.name === 'Jane Doe' && u.args.email === 'jane@acme.example', 'updateUser syncs the NS name + email into Ringotel BEFORE reactivation');
    ok(!calls.some((x) => x.m === 'createUser'), 'activate does NOT createUser when one already exists');
  }

  // ── activate: no name provided → updateUser omits `name` (never blanks the RT display name) ──
  {
    const { dw } = mockDevices({ '100r': 'OLDPW' });
    const { rw, calls } = mockRt();
    const { name: _drop, ...noName } = base();
    await activate({ ...noName, nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 0 })] });
    const u = calls.find((x) => x.m === 'updateUser')!;
    ok(!('name' in u.args), 'updateUser omits name when none is supplied (avoids blanking the Ringotel name)');
  }

  // ── email is THREE-STATE: '' propagates a real removal, undefined (failed read) touches nothing ──
  // The distinction is the whole point: a stale directory address can receive the app password for an
  // extension that has since been reassigned, so a genuine removal MUST propagate — but a failed NS read
  // must never look like one. `if (email)` could not tell them apart; `email !== undefined` can.
  {
    const { dw } = mockDevices({ '100r': 'OLDPW' });
    const { rw, calls } = mockRt();
    await activate({ ...base(), email: '', nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 0 })] });
    const u = calls.find((x) => x.m === 'updateUser')!;
    ok('email' in u.args && u.args.email === '', 'activate PROPAGATES a blank email (NS is the source of truth for identity)');
  }
  {
    const { dw } = mockDevices({ '100r': 'OLDPW' });
    const { rw, calls } = mockRt();
    const { email: _drop, ...noEmail } = base();
    await activate({ ...noEmail, nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 0 })] });
    const u = calls.find((x) => x.m === 'updateUser')!;
    ok(!('email' in u.args), 'activate OMITS email when undefined (a failed NS read must not blank a good address)');
  }
  {
    const { dw } = mockDevices({ '100r': 'PW2' });
    const { rw, calls } = mockRt();
    await resetPassword({ ...base(), email: '', nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 1 })] });
    const u = calls.find((x) => x.m === 'updateUser')!;
    ok('email' in u.args && u.args.email === '', 'reset PROPAGATES a blank email, so the new password cannot be mailed to a stale address');
  }
  {
    const { dw } = mockDevices({ '100r': 'PW2' });
    const { rw, calls } = mockRt();
    const { email: _drop, ...noEmail } = base();
    await resetPassword({ ...noEmail, nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 1 })] });
    const u = calls.find((x) => x.m === 'updateUser')!;
    ok(!('email' in u.args), 'reset OMITS email when undefined (failed read leaves the stored address alone)');
  }
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    await deactivate({ ...base(), email: '', nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 1 })] });
    const u = calls.find((x) => x.m === 'updateUser')!;
    ok('email' in u.args && u.args.email === '', 'deactivate PROPAGATES a blank email');
  }

  // ── deactivate: best-effort identity sync, then deactivateUser (NON-BILLABLE) + delete device ──
  {
    const { dw, calls: dcalls } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    const res = await deactivate({ ...base(), nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 1 })] });
    ok(calls.some((x) => x.m === 'deactivateUser' && x.args.userid === 'U100'), 'deactivate calls deactivateUser (non-billable) — NOT setUserStatus, which only blocks and stays billed');
    ok(!calls.some((x) => x.m === 'createUser'), 'deactivate never creates an RT user');
    const u = calls.find((x) => x.m === 'updateUser');
    ok(!!u && u.args.name === 'Jane Doe' && u.args.email === 'jane@acme.example', 'deactivate best-effort syncs the NS name + email first');
    ok(!!u && !('status' in u.args), 'deactivate identity-sync updateUser does NOT touch status (deactivateUser owns that)');
    const ui = calls.findIndex((x) => x.m === 'updateUser'), di = calls.findIndex((x) => x.m === 'deactivateUser');
    ok(ui >= 0 && di > ui, 'identity sync runs BEFORE deactivateUser (the authoritative last call)');
    ok(dcalls.includes('deleteDevice:100r'), 'deactivate deletes the NS device 100r');
    ok(res.action === 'deactivated', 'deactivate reports the action');
  }
  // ── deactivate: no NS identity (e.g. the NS user was deleted) → skip the sync, still deactivate ──
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    const { name: _n, email: _e, ...bare } = base();
    const res = await deactivate({ ...bare, nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 1 })] });
    ok(!calls.some((x) => x.m === 'updateUser'), 'deactivate skips the identity sync when no name/email is supplied');
    ok(calls.some((x) => x.m === 'deactivateUser'), 'deactivate still deactivates without an identity to sync');
    ok(res.action === 'deactivated', 'deactivate (no identity) reports the action');
  }

  // ── resetPassword: sync creds+email (no status change) THEN resetUserPassword ──
  {
    const { dw } = mockDevices({ '100r': 'PW2' });
    const { rw, calls } = mockRt();
    const res = await resetPassword({ ...base(), nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 1 })] });
    ok(calls.some((x) => x.m === 'resetUserPassword' && x.args.userid === 'U100'), 'resetPassword calls Ringotel resetUserPassword');
    const u = calls.find((x) => x.m === 'updateUser');
    ok(u?.args.password === 'PW2' && u?.args.email === 'jane@acme.example' && !('status' in u.args), 'reset re-syncs SIP creds + email WITHOUT changing activation status');
    const ui = calls.findIndex((x) => x.m === 'updateUser'), ri = calls.findIndex((x) => x.m === 'resetUserPassword');
    ok(ui >= 0 && ri > ui, 'reset syncs identity/email BEFORE emailing the new password (so it reaches the current address)');
    ok(res.action === 'reset', 'resetPassword reports the action');
  }
  // resetPassword refuses when no RT user exists
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw } = mockRt();
    let threw = false;
    try { await resetPassword({ ...base(), nsWrite: dw, rtWrite: rw, users: [] }); } catch { threw = true; }
    ok(threw, 'resetPassword throws when there is no Ringotel user to reset');
  }
  // resetPassword refuses a NON-active user → never reactivates / recreates the device / emails a password
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    let err: unknown;
    try { await resetPassword({ ...base(), nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: -1 })] }); } catch (e) { err = e; }
    ok(err instanceof RingotelWriteError && err.status === 409, 'resetPassword refuses a non-active user with a typed 409 (no silent reactivation)');
    ok(!calls.some((x) => x.m === 'resetUserPassword'), 'a refused reset never emails a new password');
  }

  // ── duplicate self-heal (SIP-identity canonical) — redesigned after a live duplicate-record case ──
  // Ringotel's SSO login maps by EXTENSION, so a leftover record at the same extension can hijack a login.
  // CANONICAL = the real provisioned user: the one whose SIP username/authname == <ext><suffix> ("100r").
  // We operate on it and BEST-EFFORT delete the rest — a delete that errors or no-ops (un-deletable
  // Ringotel tombstones/phantoms) must never block the op. Refuse only when ≥2 share the SIP identity.
  const dupUsers = () => [
    rtUser({ id: 'STALE', ext: '100', status: -1, name: 'Deleted' }),                                       // no SIP identity
    rtUser({ id: 'REAL', ext: '100', status: 1, name: 'Demo User3', username: '100r', authname: '100r' }),  // the real provisioned user
  ];
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    const res = await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: dupUsers() });
    ok(calls.some((x) => x.m === 'deleteUser' && x.args.userid === 'STALE'), 'activate best-effort deletes the non-canonical record');
    ok(!calls.some((x) => x.m === 'deleteUser' && x.args.userid === 'REAL'), 'activate never deletes the canonical (SIP-identity) record');
    ok(!calls.some((x) => x.m === 'createUser'), 'activate reuses the canonical record (no createUser)');
    const u = calls.find((x) => x.m === 'updateUser');
    ok(res.action === 'updated' && res.rtUserId === 'REAL' && u?.args.status === 1 && u?.args.name === 'Jane Doe', 'activate updates the canonical (status 1 + synced name/email)');
  }
  // THE live 1043 shape: NO record is active, but one carries the SIP identity beside a tombstone → the
  // SIP one is canonical and gets activated; the tombstone is best-effort deleted. (The old status-based
  // rule refused this exact case, which is why the portal checkbox did nothing.)
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    const users = [
      rtUser({ id: 'TOMB', ext: '100', status: -1, name: 'Deleted' }),                                        // tombstone, no SIP id
      rtUser({ id: 'REAL', ext: '100', status: -1, name: 'Demo User3', username: '100r', authname: '100r' }), // inactive but the real user
    ];
    const res = await activate({ ...base(), nsWrite: dw, rtWrite: rw, users });
    ok(res.action === 'updated' && res.rtUserId === 'REAL', 'activate resolves to the SIP-identity record even when NONE is active (live 1043 shape)');
    ok(calls.some((x) => x.m === 'deleteUser' && x.args.userid === 'TOMB'), 'activate best-effort deletes the tombstone');
  }
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    const res = await deactivate({ ...base(), nsWrite: dw, rtWrite: rw, users: dupUsers() });
    ok(calls.some((x) => x.m === 'deleteUser' && x.args.userid === 'STALE'), 'deactivate best-effort deletes the non-canonical record');
    ok(calls.some((x) => x.m === 'deactivateUser' && x.args.userid === 'REAL'), 'deactivate deactivates the canonical record');
    const u = calls.find((x) => x.m === 'updateUser');
    ok(u?.args.name === 'Jane Doe' && !('status' in u.args), 'deactivate syncs name/email on the canonical before deactivateUser');
    ok(res.rtUserId === 'REAL', 'deactivate reports the canonical id');
  }
  {
    const { dw } = mockDevices({ '100r': 'PW2' });
    const { rw, calls } = mockRt();
    const res = await resetPassword({ ...base(), nsWrite: dw, rtWrite: rw, users: dupUsers() });
    ok(calls.some((x) => x.m === 'deleteUser' && x.args.userid === 'STALE'), 'reset best-effort deletes the non-canonical record');
    ok(calls.some((x) => x.m === 'resetUserPassword' && x.args.userid === 'REAL'), 'reset targets the canonical record');
    ok(res.rtUserId === 'REAL', 'reset reports the canonical id');
  }
  // Best-effort: a deleteUser that ERRORS (an un-deletable Ringotel phantom → "Invalid User ID") must NOT
  // block the op — the canonical is still activated. This is exactly the live 1043 phantom's behavior.
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    rw.deleteUser = async (userid: string) => { calls.push({ m: 'deleteUser', args: { userid } }); throw new Error('Invalid User ID'); };
    const res = await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: [
      rtUser({ id: 'PHANTOM', ext: '100', status: -1, name: 'Deleted' }),
      rtUser({ id: 'REAL', ext: '100', status: 1, username: '100r', authname: '100r' }),
    ] });
    ok(calls.some((x) => x.m === 'deleteUser' && x.args.userid === 'PHANTOM'), 'activate attempts to delete the non-canonical record');
    ok(res.action === 'updated' && res.rtUserId === 'REAL', 'a rejected delete does NOT block activation (best-effort — tolerates un-deletable phantoms)');
  }
  // F1 (brick-window fix): the canonical's activation WRITE (updateUser/createUser) must be recorded
  // BEFORE any sibling deleteUser — asserted on the recorded call ORDER, not just that both happened.
  // Wrong ordering is exactly the SSO-brick window: an SSO login binding onto a just-deleted sibling
  // between the deletes and the (re)activation would permanently brick the account.
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: dupUsers() });
    const writeIdx = calls.findIndex((x) => x.m === 'updateUser' || x.m === 'createUser');
    const deleteIdx = calls.findIndex((x) => x.m === 'deleteUser');
    ok(writeIdx >= 0 && deleteIdx > writeIdx, 'F1: activate records the canonical activation write BEFORE any sibling deleteUser');
  }
  // F1: a sibling deleteUser that REJECTS still lets activate() succeed — the write already happened by
  // the time the (best-effort, tolerant) dedup runs, so a delete failure can no longer matter to the caller.
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    rw.deleteUser = async (userid: string) => { calls.push({ m: 'deleteUser', args: { userid } }); throw new Error('boom'); };
    let threw = false;
    let res: Awaited<ReturnType<typeof activate>> | undefined;
    try { res = await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: dupUsers() }); } catch { threw = true; }
    ok(!threw && res?.action === 'updated' && res?.rtUserId === 'REAL', 'F1: activate() succeeds even when a sibling deleteUser rejects');
    const writeIdx = calls.findIndex((x) => x.m === 'updateUser');
    const deleteIdx = calls.findIndex((x) => x.m === 'deleteUser');
    ok(writeIdx >= 0 && deleteIdx > writeIdx, 'F1: the rejected sibling delete is still attempted, and still AFTER the canonical write');
  }
  // F1: the ambiguity 409 (a true SIP-identity tie) still throws BEFORE any device is created AND before
  // any sibling delete is attempted — an ambiguity refusal must never orphan a device or delete a record.
  {
    const { dw, calls: dcalls } = mockDevices(); // no device seeded → a create would be observable
    const { rw, calls } = mockRt();
    let err: unknown;
    try { await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: [
      rtUser({ id: 'S1', ext: '100', status: 1, username: '100r', authname: '100r' }),
      rtUser({ id: 'S2', ext: '100', status: -1, username: '100r', authname: '100r' }),
    ] }); } catch (e) { err = e; }
    ok(err instanceof RingotelWriteError && err.status === 409, 'F1: SIP-tie ambiguity 409 still thrown');
    ok(!dcalls.some((c) => c.startsWith('createDevice')), 'F1: refused BEFORE any NS device is created (no createDevice call)');
    ok(!calls.some((x) => x.m === 'deleteUser'), 'F1: refused BEFORE any sibling delete is attempted');
  }
  // Branch isolation (strict branchid): a record with absent/other branchid is NOT a same-branch duplicate.
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    const users = [
      rtUser({ id: 'NULLBR', ext: '100', status: -1, name: 'Deleted', branchid: undefined }),   // API omitted branchid
      rtUser({ id: 'REAL', ext: '100', status: 1, username: '100r', authname: '100r' }),          // branchid B1
    ];
    const res = await activate({ ...base(), nsWrite: dw, rtWrite: rw, users });
    ok(!calls.some((x) => x.m === 'deleteUser'), 'a record with absent branchid is NOT a same-branch duplicate (fail closed — never deleted)');
    ok(res.action === 'updated' && res.rtUserId === 'REAL', 'resolves to the in-branch record only');
  }
  // Refuse ONLY a true tie: ≥2 records share the <ext>r SIP identity — and refuse BEFORE creating a device.
  {
    const { dw, calls: dcalls } = mockDevices(); // no device seeded → a create would be observable
    const { rw, calls } = mockRt();
    let err: unknown;
    try { await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: [
      rtUser({ id: 'S1', ext: '100', status: 1, username: '100r', authname: '100r' }),
      rtUser({ id: 'S2', ext: '100', status: -1, username: '100r', authname: '100r' }),
    ] }); } catch (e) { err = e; }
    ok(err instanceof RingotelWriteError && err.status === 409, 'activate refuses a SIP tie with a typed 409 (not a generic 500)');
    ok(!calls.some((x) => x.m === 'deleteUser'), 'a SIP-tie refusal never deletes anything');
    ok(!dcalls.some((c) => c.startsWith('createDevice')), 'refused BEFORE creating an NS device (no orphan)');
  }
  // No SIP-identity record among duplicates, both equally inactive → fall back to the most-recently-
  // created; delete the rest.
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    const res = await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: [
      rtUser({ id: 'OLD', ext: '100', status: -1, created: 100 }),
      rtUser({ id: 'NEW', ext: '100', status: -1, created: 200 }),
    ] });
    ok(res.rtUserId === 'NEW', 'no SIP record, status-equal → canonical is the most-recently-created');
    ok(calls.some((x) => x.m === 'deleteUser' && x.args.userid === 'OLD'), 'the older non-canonical record is best-effort deleted');
  }
  // F2: no SIP-identity record among duplicates → the ACTIVE record wins over a merely-newer inactive one.
  // Without this, a heal/dedup would delete the live, working record in favor of a dead newer one.
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    const res = await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: [
      rtUser({ id: 'ACTIVE_OLDER', ext: '100', status: 1, created: 100 }),
      rtUser({ id: 'INACTIVE_NEWER', ext: '100', status: -1, created: 200 }),
    ] });
    ok(res.rtUserId === 'ACTIVE_OLDER', 'no SIP record → an ACTIVE record is canonical even though a newer INACTIVE record exists');
    ok(calls.some((x) => x.m === 'deleteUser' && x.args.userid === 'INACTIVE_NEWER'), 'the newer-but-inactive record is best-effort deleted, not the active one');
  }
  // Single record (no duplicate) → never deletes.
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    await activate({ ...base(), nsWrite: dw, rtWrite: rw, users: [rtUser({ id: 'U100', ext: '100', status: 0 })] });
    ok(!calls.some((x) => x.m === 'deleteUser'), 'no duplicate → no deleteUser (normal path unaffected)');
  }

  // ── write-domain safety rail ──
  ok(isDomainWritable('acme.example', '*') === true, 'rail: "*" permits any domain');
  ok(isDomainWritable('acme.example', []) === false, 'rail: empty allowlist refuses all writes (fail-closed)');
  ok(isDomainWritable('demo.example', ['demo.example']) === true, 'rail: allowlisted domain is writable');
  ok(isDomainWritable('acme.example', ['demo.example']) === false, 'rail: a non-allowlisted domain is refused');
  ok(isDomainWritable('DEMO.example', ['demo.example']) === true, 'rail: domain match is case-insensitive');


  // ── syncIdentity: the background, event-driven identity push ──────────────────
  {
    const rt = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r', name: 'Old Name', info: { email: 'old@acme.example' } })];
    const r = await syncIdentity({ ...base(), nsWrite: mockDevices({ '100r': 'pw' }).dw as any, rtWrite: rt.rw as any, users: users as any });
    ok(r.action === 'synced' && r.rtUserId === 'U1', 'syncIdentity updates the canonical user');
    ok(r.changed.sort().join(',') === 'email,name', 'both name and email were written');
    ok(rt.calls.length === 1 && rt.calls[0].m === 'updateUser', 'exactly ONE call, and it is updateUser');
    ok(rt.calls[0].args.name === 'Jane Doe' && rt.calls[0].args.email === 'jane@acme.example', 'the NS values are pushed');
  }
  {
    // Replay safety: identical state ⇒ zero writes. Requires reading info.email, not user.email.
    const rt = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r', name: 'Jane Doe', info: { email: 'jane@acme.example' } })];
    const o = { ...base(), nsWrite: mockDevices().dw as any, rtWrite: rt.rw as any, users: users as any };
    const r1 = await syncIdentity(o);
    const r2 = await syncIdentity(o);
    ok(r1.action === 'no-change' && r2.action === 'no-change', 'matching state is a no-change');
    ok(rt.calls.length === 0, 'a replayed event produces ZERO Ringotel writes (the amplification guard)');
  }
  {
    // The ROADMAP trap: email at info.email. If read from the top level it is always undefined ⇒ always writes.
    const rt = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r', name: 'Jane Doe', info: { email: 'jane@acme.example' } })];
    const r = await syncIdentity({ ...base(), email: 'jane@acme.example', nsWrite: mockDevices().dw as any, rtWrite: rt.rw as any, users: users as any });
    ok(r.action === 'no-change', 'the Ringotel email is compared at info.email, not the (absent) top level');
  }
  {
    // A genuinely-removed address must propagate; a FAILED read must not.
    const rt = mockRt();
    const users = () => [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r', name: 'Jane Doe', info: { email: 'jane@acme.example' } })];
    const cleared = await syncIdentity({ ...base(), email: '', nsWrite: mockDevices().dw as any, rtWrite: rt.rw as any, users: users() as any });
    ok(cleared.action === 'synced' && cleared.changed.join() === 'email' && rt.calls[0].args.email === '', "a genuinely-empty NS email propagates as '' (a real removal)");
    const rt2 = mockRt();
    const unknown = await syncIdentity({ ...base(), email: undefined, nsWrite: mockDevices().dw as any, rtWrite: rt2.rw as any, users: users() as any });
    ok(unknown.action === 'no-change' && rt2.calls.length === 0, 'email:undefined (a failed NS read) touches nothing');
  }
  {
    // Both sides absent ⇒ no write. Without normalizing undefined→'' this writes on every single event.
    const rt = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r', name: 'Jane Doe' })];
    const r = await syncIdentity({ ...base(), email: '', nsWrite: mockDevices().dw as any, rtWrite: rt.rw as any, users: users as any });
    ok(r.action === 'no-change' && rt.calls.length === 0, 'no address on either side is a no-op, not a perpetual write');
  }
  {
    const rt = mockRt();
    const r = await syncIdentity({ ...base(), nsWrite: mockDevices().dw as any, rtWrite: rt.rw as any, users: [] as any });
    ok(r.action === 'absent' && rt.calls.length === 0, 'no Ringotel user ⇒ absent; a background sync NEVER provisions a billable seat');
  }
  {
    // THE INVARIANT (Fable I4): only updateUser, ever. dedup/activate/deactivate here could brick an
    // extension by racing the SSO worker's heal, which has no shared lock with this Worker.
    const rt = mockRt();
    const { dw, calls: dcalls } = mockDevices();
    const users = [
      rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r', name: 'Old', info: { email: 'a@x.example' } }),
      rtUser({ id: 'U2', ext: '100', status: 0, name: 'Dup', info: { email: 'b@x.example' } }),
    ];
    const r = await syncIdentity({ ...base(), nsWrite: dw as any, rtWrite: rt.rw as any, users: users as any });
    ok(r.action === 'synced' && r.rtUserId === 'U1', 'with a duplicate present it still targets the canonical');
    const methods = rt.calls.map((c: any) => c.m);
    ok(methods.every((m: string) => m === 'updateUser'), `INVARIANT: only updateUser was called (saw ${methods.join(',') || 'none'})`);
    ok(!methods.includes('deleteUser'), 'INVARIANT: siblings are NEVER deduped by the background sync');
    ok(!methods.includes('deactivateUser') && !methods.includes('createUser') && !methods.includes('resetUserPassword'), 'INVARIANT: no activation-state change and no creation');
    ok(dcalls.length === 0, 'INVARIANT: syncIdentity touches NO NS device — not even a read');
  }
  {
    // An inactive canonical still gets its identity synced — the directory entry should match NS.
    const rt = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 0, username: '100r', authname: '100r', name: 'Stale', info: { email: 'stale@x.example' } })];
    const r = await syncIdentity({ ...base(), nsWrite: mockDevices().dw as any, rtWrite: rt.rw as any, users: users as any });
    ok(r.action === 'synced', 'an inactive user is still identity-synced (and stays inactive)');
    ok(rt.calls.every((c: any) => c.m === 'updateUser'), 'and it is not reactivated');
  }
  {
    // A genuine tie must refuse rather than guess — same rule as the interactive paths.
    const users = [
      rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r' }),
      rtUser({ id: 'U2', ext: '100', status: 1, username: '100r', authname: '100r' }),
    ];
    let status = 0;
    try {
      await syncIdentity({ ...base(), nsWrite: mockDevices().dw as any, rtWrite: mockRt().rw as any, users: users as any });
    } catch (e: any) {
      status = e.status;
    }
    ok(status === 409, 'a genuine SIP-identity tie throws 409 instead of guessing');
  }
  {
    // Only the differing field is written.
    const rt = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r', name: 'Jane Doe', info: { email: 'stale@x.example' } })];
    const r = await syncIdentity({ ...base(), nsWrite: mockDevices().dw as any, rtWrite: rt.rw as any, users: users as any });
    ok(r.changed.join() === 'email', 'a matching name is not rewritten — only the changed field is sent');
    ok(!('name' in rt.calls[0].args), 'and the unchanged field is absent from the update body');
  }


  // ── SIP password rotation on activation ───────────────────────────────────────
  // The failure this prevents: reusing a stored password leaves any OTHER endpoint holding it able to
  // register as the same AOR. Two clients then fight over the registration — intermittent and very hard
  // to diagnose. Rotating at activation invalidates the stranger.
  {
    const pw = generateSipPassword();
    ok(pw.length === 20, 'generateSipPassword defaults to 20 chars');
    ok(/^[A-Za-z0-9]+$/.test(pw), 'the password is alphanumeric only — no punctuation to mis-escape downstream');
    ok(generateSipPassword() !== generateSipPassword(), 'consecutive passwords differ');
    ok(generateSipPassword(40).length === 40, 'the length is configurable');
    ok(new Set(Array.from({ length: 50 }, () => generateSipPassword())).size === 50, '50 generated passwords are all distinct');
  }
  {
    // Existing device + rotation ON ⇒ PUT a new password, and Ringotel gets the NEW one.
    const devs = mockDevices({ '100r': 'STALEPASSWORD' });
    const rt = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 0, username: '100r', authname: '100r' })];
    await activate({ ...base(), nsWrite: devs.dw as any, rtWrite: rt.rw as any, users: users as any, rotateExistingDevice: true });
    ok(devs.calls.includes('updateDevice:100r'), 'an EXISTING device has its password rotated via updateDevice');
    ok(!devs.calls.some((c) => c.startsWith('deleteDevice')), 'rotation is a PUT — the device is never deleted and recreated');
    const pushed = rt.calls.find((c: any) => c.m === 'updateUser')?.args?.password;
    ok(typeof pushed === 'string' && pushed !== 'STALEPASSWORD', 'the NEW password is what gets pushed to Ringotel');
    ok(/^[A-Za-z0-9]{20}$/.test(String(pushed)), 'and it is a freshly generated one');
  }
  {
    // No existing device ⇒ nothing to rotate; the created device is already exclusive.
    const devs = mockDevices();
    const rt = mockRt();
    await activate({ ...base(), nsWrite: devs.dw as any, rtWrite: rt.rw as any, users: [] as any, rotateExistingDevice: true });
    ok(devs.calls.includes('createDevice:100r'), 'a missing device is created');
    ok(!devs.calls.includes('updateDevice:100r'), 'a NEWLY created device is not rotated — it already has an exclusive password');
  }
  {
    // Default (flag absent) must behave exactly as before — this is an opt-in behaviour change.
    const devs = mockDevices({ '100r': 'STALEPASSWORD' });
    const rt = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 0, username: '100r', authname: '100r' })];
    await activate({ ...base(), nsWrite: devs.dw as any, rtWrite: rt.rw as any, users: users as any });
    ok(!devs.calls.includes('updateDevice:100r'), 'with the flag unset nothing rotates (backwards compatible)');
    ok(rt.calls.find((c: any) => c.m === 'updateUser')?.args?.password === 'STALEPASSWORD', 'and the existing password is reused as before');
  }
  {
    // Rotation is best-effort: a release without the device PUT must not block activation.
    const devs = mockDevices({ '100r': 'STALEPASSWORD' });
    devs.failUpdate(true);
    const rt = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 0, username: '100r', authname: '100r' })];
    const res = await activate({ ...base(), nsWrite: devs.dw as any, rtWrite: rt.rw as any, users: users as any, rotateExistingDevice: true });
    ok(res.action === 'updated', 'a failed rotation does NOT fail the activation');
    ok(rt.calls.find((c: any) => c.m === 'updateUser')?.args?.password === 'STALEPASSWORD', 'it falls back to the existing password so the app still works');
  }
  {
    const devs = mockDevices({ '100r': 'STALEPASSWORD' });
    const r = await ensureDevice(devs.dw, 'acme.example', '100', '100r', { rotateExisting: true });
    ok(r.rotated === true && r.password !== 'STALEPASSWORD' && r.created === false, 'ensureDevice reports rotated:true with the new password');
    const devs2 = mockDevices({ '100r': 'STALEPASSWORD' });
    devs2.failUpdate(true);
    const r2 = await ensureDevice(devs2.dw, 'acme.example', '100', '100r', { rotateExisting: true });
    ok(r2.rotated === false && r2.password === 'STALEPASSWORD' && (r2.rotateError ?? '').includes('unsupported'), 'a rotation failure is reported, not thrown');
  }
  {
    // resetPassword must NOT rotate the SIP credential — it resets the APP password. Rotating there too
    // would be defensible, but it is a different decision and is deliberately not taken here.
    const devs = mockDevices({ '100r': 'STALEPASSWORD' });
    const rt = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r' })];
    await resetPassword({ ...base(), nsWrite: devs.dw as any, rtWrite: rt.rw as any, users: users as any, rotateExistingDevice: true });
    ok(!devs.calls.includes('updateDevice:100r'), 'resetPassword does not rotate the SIP password even when the flag is set');
  }

  // ── deactivateAppOnly: the narrow offboarding action ──────────────────────────
  {
    const { rw, calls } = mockRt();
    const { dw, calls: dcalls } = mockDevices();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1 })];
    const r = await deactivateAppOnly({ ...base(), nsWrite: dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'deactivated' && r.rtUserIds.length === 1 && r.rtUserIds[0] === 'U1', 'deactivateAppOnly deactivates the active record');
    ok(calls.length === 1 && calls[0]!.m === 'deactivateUser', 'INVARIANT: deactivateAppOnly calls ONLY deactivateUser on the Ringotel side — no dedup, no identity write');
    ok(dcalls.length === 0, 'INVARIANT: deactivateAppOnly touches NO NS device — not even a read, let alone a delete');
  }
  {
    // The whole point of the orphan path: a billed sibling left active defeats it.
    const { rw, calls } = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1 }), rtUser({ id: 'U2', ext: '100', status: 1 })];
    const r = await deactivateAppOnly({ ...base(), nsWrite: mockDevices().dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'deactivated' && r.rtUserIds.length === 2, 'deactivateAppOnly deactivates EVERY active record at the extension, not just the canonical');
    ok(calls.every((c) => c.m === 'deactivateUser'), 'deactivating siblings still only ever calls deactivateUser');
  }
  {
    // Two records sharing the SIP identity make resolveCanonical throw 409. This path must not care:
    // it is not choosing a record, so there is no tie to refuse.
    const { rw } = mockRt();
    const users = [
      rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r' }),
      rtUser({ id: 'U2', ext: '100', status: 1, username: '100r', authname: '100r' }),
    ];
    const r = await deactivateAppOnly({ ...base(), nsWrite: mockDevices().dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'deactivated' && r.rtUserIds.length === 2, 'deactivateAppOnly does NOT refuse an ambiguous SIP-identity tie — it deactivates all of them');
  }
  {
    const { rw, calls } = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 0 })];
    const r = await deactivateAppOnly({ ...base(), nsWrite: mockDevices().dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'no-change' && calls.length === 0, 'deactivateAppOnly is a no-op when nothing at the extension is active (replay-safe)');
  }
  {
    const { rw, calls } = mockRt();
    const r = await deactivateAppOnly({ ...base(), nsWrite: mockDevices().dw as any, rtWrite: rw as any, users: [] as any });
    ok(r.action === 'absent' && calls.length === 0, 'deactivateAppOnly reports absent when the extension has no Ringotel record');
  }
  {
    // STRICT on branchid, same reason usersForExt is: an org-wide list spans branches, and another NS
    // domain's user at the same extension must never be deactivated by this domain's sweep.
    const { rw, calls } = mockRt();
    const users = [{ id: 'U9', extension: '100', branchid: 'OTHER', status: 1 }];
    const r = await deactivateAppOnly({ ...base(), nsWrite: mockDevices().dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'absent' && calls.length === 0, 'deactivateAppOnly ignores a same-extension record in a DIFFERENT branch');
  }
  {
    // Also-fix #4: trim asymmetry. nsOffboard's sweep planner already trims the Ringotel `extension`
    // it reads (`String(u.extension ?? '').trim()`) before deciding an extension is orphaned. If
    // `usersForExt` compared untrimmed, a record whose stored extension carries whitespace would be
    // planned as an orphan every sweep but never matched here — deactivateAppOnly would return `absent`
    // forever, silently, with no indication why. `usersForExt` now trims both sides.
    const { rw, calls } = mockRt();
    const users = [rtUser({ id: 'U1', ext: ' 100 ', status: 1 })]; // whitespace-carrying stored extension
    const r = await deactivateAppOnly({ ...base(), ext: '100', nsWrite: mockDevices().dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'deactivated' && r.rtUserIds.length === 1 && r.rtUserIds[0] === 'U1', 'deactivateAppOnly matches a Ringotel record whose extension carries whitespace against a clean target extension');
    ok(calls.some((c) => c.m === 'deactivateUser' && c.args.userid === 'U1'), 'the whitespace-carrying record is the one actually deactivated');
  }
  {
    // Same trim, the other direction: a caller-supplied ext with incidental whitespace still matches a
    // cleanly-stored Ringotel extension (defensive; the sweep planner and event payload both already
    // supply clean values, but the comparison itself should not silently depend on that).
    const { rw } = mockRt();
    const users = [rtUser({ id: 'U2', ext: '100', status: 1 })];
    const r = await deactivateAppOnly({ ...base(), ext: ' 100 ', nsWrite: mockDevices().dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'deactivated' && r.rtUserIds[0] === 'U2', 'deactivateAppOnly also trims a whitespace-carrying caller-supplied ext');
  }

  // ── repairDeviceForEvent: device self-heal on a user-change event ─────────────
  {
    const { dw, calls: dcalls } = mockDevices();           // device 100r MISSING
    const { rw, calls } = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r' })];
    const r = await repairDeviceForEvent({ ...base(), mode: 'heal', nsWrite: dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'repaired' && r.changed.includes('device-created'), 'heal creates a missing NS device for an ACTIVE app user');
    ok(dcalls.includes('createDevice:100r'), 'the device is actually created');
    const up = calls.find((c) => c.m === 'updateUser');
    ok(!!up && up.args.password === 'GEN1' && up.args.username === '100r', 'the new SIP password is pushed to Ringotel');
    ok(!dcalls.some((c) => c.startsWith('updateDevice')), 'INVARIANT: repair NEVER rotates — no updateDevice on an event path');
  }
  {
    const { dw, calls: dcalls } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r' })];
    const r = await repairDeviceForEvent({ ...base(), mode: 'heal', nsWrite: dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'ok' && r.changed.length === 0, 'a correct device + matching SIP identity is a no-op');
    ok(calls.length === 0, 'no Ringotel write when nothing is wrong (an event must not cost a write)');
    ok(!dcalls.some((c) => c.startsWith('updateDevice')), 'still no rotation on the happy path');
  }
  {
    const { dw } = mockDevices({ '100r': 'PW' });
    const { rw, calls } = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: 'WRONG', authname: 'WRONG' })];
    const r = await repairDeviceForEvent({ ...base(), mode: 'heal', nsWrite: dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'repaired' && r.changed.includes('sip-identity'), 'a mismatched Ringotel username/authname is corrected');
    const up = calls.find((c) => c.m === 'updateUser')!;
    ok(up.args.username === '100r' && up.args.authname === '100r', 'the corrected values are the device AOR');
    ok(up.args.password === undefined, 'an existing device password is NOT pushed speculatively — it cannot be compared, so that would be a write on every event');
  }
  {
    const { dw, calls: dcalls } = mockDevices();           // device MISSING
    const { rw, calls } = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r' })];
    const r = await repairDeviceForEvent({ ...base(), mode: 'report', nsWrite: dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'would-repair' && r.changed.includes('device-missing'), 'report mode names the drift');
    ok(!dcalls.some((c) => c.startsWith('createDevice')), 'report mode NEVER creates a device');
    ok(calls.length === 0, 'report mode performs no Ringotel write at all');
  }
  {
    // Also-fix #3: an EXISTING device whose stored SIP password reads back blank must not be logged as
    // "device is missing" in HEAL mode, where mayCreate:true proves the device already existed — a
    // genuinely missing one would have been created. It gets a distinct, honest tag.
    const { dw, calls: dcalls } = mockDevices({ '100r': '' }); // device EXISTS, stored password reads blank
    const { rw, calls } = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r' })];
    const r = await repairDeviceForEvent({ ...base(), mode: 'heal', nsWrite: dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'repaired' && r.changed.includes('device-password-blank') && !r.changed.includes('device-missing'), 'heal mode tags a present-but-blank-password device distinctly from a genuinely missing one');
    ok(!dcalls.some((c) => c.startsWith('createDevice')), 'the device is NOT re-created — it already existed');
    const up = calls.find((c) => c.m === 'updateUser');
    ok(!up || up.args.password === undefined, 'no password is pushed for a device that was not freshly created (the blank-push guard holds)');
  }
  {
    // Same scenario in REPORT mode: `ensureNsDevice`'s shape is genuinely ambiguous there (mayCreate is
    // always false, so "created:false" can't distinguish absent from present-but-blank) — stays tagged
    // 'device-missing', which is now documented as ambiguous rather than claimed as certain.
    const { dw } = mockDevices({ '100r': '' });
    const { rw, calls } = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 1, username: '100r', authname: '100r' })];
    const r = await repairDeviceForEvent({ ...base(), mode: 'report', nsWrite: dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'would-repair' && r.changed.includes('device-missing') && !r.changed.includes('device-password-blank'), 'report mode keeps the ambiguous case tagged device-missing');
    ok(calls.length === 0, 'report mode performs no Ringotel write at all');
  }
  {
    const { dw, calls: dcalls } = mockDevices();
    const { rw, calls } = mockRt();
    const users = [rtUser({ id: 'U1', ext: '100', status: 0, username: '100r', authname: '100r' })];
    const r = await repairDeviceForEvent({ ...base(), mode: 'heal', nsWrite: dw as any, rtWrite: rw as any, users: users as any });
    ok(r.action === 'inactive' && calls.length === 0 && dcalls.length === 0, 'an INACTIVE Ringotel user is never a provisioning trigger — no device work at all');
  }
  {
    const { dw, calls: dcalls } = mockDevices();
    const { rw, calls } = mockRt();
    const r = await repairDeviceForEvent({ ...base(), mode: 'heal', nsWrite: dw as any, rtWrite: rw as any, users: [] as any });
    ok(r.action === 'absent' && calls.length === 0 && dcalls.length === 0, 'no Ringotel record ⇒ absent, and no NS device is provisioned');
  }

  // ── attached secondaries are never canonical ──────────────────────────────────
  {
    // A secondary carries `userid` pointing at its primary and sits at the SAME extension, so without
    // the guard it reads as an ordinary duplicate — and being newer, it wins the newest-first tiebreak.
    //
    // ⚠️ The fixture is built so the guard is the ONLY thing that decides. Neither record carries the
    // `<ext><suffix>` SIP identity, so the SIP tiebreak finds nothing; and neither is `status === 1`, so
    // the active-first tiebreak is a draw. That leaves newest-first, where the secondary WOULD win.
    // Giving the primary a SIP identity or an active status makes this assertion pass with the guard
    // deleted — proving nothing about the guard, which is exactly what the first draft of this test did.
    const primary = { id: 'P1', extension: '100', branchid: 'B1', status: 0, created: 1000 } as unknown as User;
    const secondary = { id: 'S1', extension: '100', branchid: 'B1', status: 2, userid: 'P1', created: 9000 } as unknown as User;

    const chosen = resolveCanonical({ users: [secondary, primary], branchid: 'B1', ext: '100', suffix: 'r' });
    ok(chosen?.id === 'P1', 'resolveCanonical: an attached secondary is never canonical, even when newer');

    // The production-shaped case: a real primary carrying the SIP identity, beside a secondary. This one
    // is belt-and-braces — the SIP tiebreak alone would pick the primary — but it documents the intent
    // for the shape that actually occurs in the wild.
    const realPrimary = { id: 'P2', extension: '101', branchid: 'B1', status: 1, username: '101r', authname: '101r', created: 1000 } as unknown as User;
    const realSecondary = { id: 'S2', extension: '101', branchid: 'B1', status: 2, userid: 'P2', created: 9000 } as unknown as User;
    ok(resolveCanonical({ users: [realSecondary, realPrimary], branchid: 'B1', ext: '101', suffix: 'r' })?.id === 'P2',
       'resolveCanonical: the real provisioned user wins beside a secondary (belt-and-braces — SIP identity also decides this one)');

    // And with NO primary present, a lone secondary must not be adopted as one. This is the path where
    // the guard is indispensable: `matches.length <= 1` returns BEFORE any tiebreak runs, so nothing
    // else in the function would stop a lone secondary being provisioned over.
    const none = resolveCanonical({ users: [secondary], branchid: 'B1', ext: '100', suffix: 'r' });
    ok(none === undefined, 'resolveCanonical: a lone attached secondary resolves to nothing, not to itself');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
