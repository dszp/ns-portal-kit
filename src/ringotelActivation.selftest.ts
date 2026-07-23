/** Offline test for the Ringotel activation orchestration (device-ensure + create/update/deactivate/
 *  reset) with recording mock clients, plus the write-domain safety rail. pnpm test:ringotelwrite */
import { activate, deactivate, resetPassword, ensureDevice, isDomainWritable, SIP_PW_FIELD, RingotelWriteError, type DeviceWriter, type RingotelUserWriter } from './ringotelActivation.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

/** Mock NS device writer backed by an in-memory store; records every call. */
function mockDevices(seed: Record<string, string> = {}) {
  const store = new Map<string, Record<string, unknown>>();
  for (const [name, pw] of Object.entries(seed)) store.set(name, { device: name, [SIP_PW_FIELD]: pw });
  const calls: string[] = [];
  let pwSeq = 0;
  const dw: DeviceWriter = {
    async getDevices() { calls.push('getDevices'); return [...store.values()]; },
    async getDevice(_d, _u, device) { calls.push(`getDevice:${device}`); return store.get(device) ?? {}; },
    async createDevice(_d, _u, device) { calls.push(`createDevice:${device}`); const rec = { device, [SIP_PW_FIELD]: `GEN${++pwSeq}` }; store.set(device, rec); return rec; },
    async deleteDevice(_d, _u, device) { calls.push(`deleteDevice:${device}`); store.delete(device); return {}; },
  };
  return { dw, calls, store };
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
