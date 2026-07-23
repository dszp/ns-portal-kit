/**
 * Ringotel activation orchestration — the write counterpart to `ringotel.ts`'s read enrichment.
 * Sequences the NetSapiens device side (via a NsWriteClient-shaped `DeviceWriter`) and the Ringotel
 * user side (via a RingotelWriteClient-shaped `RingotelUserWriter`) into three operations:
 *
 *   activate      — ensure the NS softphone device `<ext><suffix>` exists (create if missing), read its
 *                   generated SIP password, then create the Ringotel user (new) or updateUser status:1
 *                   with refreshed SIP creds (existing). Either way the Ringotel identity (name + email)
 *                   is synced from the NS user first, so a reactivated directory entry matches current NS.
 *                   Ringotel emails the credentials (noemail:false).
 *   deactivate    — sync the NS identity (name + email) into the user, then deactivate it (it REMAINS as
 *                   an inactive directory entry, so its name should still match NS) and delete the NS
 *                   device. Full Ringotel deleteUser happens only on NS-user deletion (webhook, later).
 *   resetPassword — Ringotel resetUserPassword (emails a new app password) + re-sync the SIP creds from
 *                   the current NS device.
 *
 * These take injected, structurally-typed clients + the FRESH Ringotel org users (the worker force-reads
 * them past the cache before calling — see the cache-fencing note in the plan), so the logic is pure I/O
 * sequencing and unit-testable with mocks. The worker owns policy: the write-domain rail (`isDomainWritable`),
 * eligibility, auth, and cache invalidation.
 */
import type { User } from '@dszp/ringotel-lib';

/** The NS device field carrying the auto-generated SIP registration password (v2). */
export const SIP_PW_FIELD = 'device-sip-registration-password';

type Rec = Record<string, unknown>;

/**
 * A resolve/precondition failure a write handler should surface with a SPECIFIC HTTP status instead of a
 * generic 500 — a genuinely ambiguous extension (409), or a reset requested on an absent (404) / non-active
 * (409) user. The worker maps `.status` straight through.
 */
export class RingotelWriteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RingotelWriteError';
  }
}

/** Subset of NsWriteClient the orchestration needs. */
export interface DeviceWriter {
  getDevices(domain: string, user: string): Promise<Rec[]>;
  getDevice(domain: string, user: string, device: string): Promise<Rec>;
  createDevice(domain: string, user: string, device: string, extra?: Rec): Promise<Rec>;
  deleteDevice(domain: string, user: string, device: string): Promise<Rec>;
}

/** Subset of RingotelWriteClient the orchestration needs (return types loose at the mock seam). */
export interface RingotelUserWriter {
  createUser(input: { orgid: string; branchid: string; name: string; extension: string } & Rec): Promise<any>;
  updateUser(userid: string, orgid: string, changes: Rec): Promise<any>;
  deactivateUser(userid: string, orgid: string): Promise<any>;
  deleteUser(userid: string, orgid: string): Promise<any>;
  resetUserPassword(userid: string, orgid: string): Promise<any>;
}

/** Inputs shared by every operation. `users` is the FRESH org user list (worker force-reads it). */
export interface ActivationOpts {
  nsWrite: DeviceWriter;
  rtWrite: RingotelUserWriter;
  users: User[];
  orgid: string;
  branchid: string;
  domain: string;
  ext: string;
  /** NS device-name suffix (config; default 'r'). */
  suffix: string;
  name?: string;
  /**
   * The NetSapiens email address, and the DISTINCTION MATTERS:
   *  - `undefined` — the NS user read FAILED or was not attempted. We know nothing; touch nothing.
   *  - `''`        — the read SUCCEEDED and the user genuinely has no address. Propagate the removal.
   *  - a string    — the current address. Propagate it.
   *
   * NetSapiens is the source of truth for identity, so a real removal must reach the app directory
   * (a stale address there can receive an app password for an extension that has since been
   * reassigned). But a failed read must never look like a removal — hence the three-state contract
   * rather than a bare `if (email)`, which cannot tell them apart. Callers: pass `undefined` on a
   * read failure, never `''`.
   */
  email?: string;
}

export interface ActivationResult {
  action: 'created' | 'updated' | 'deactivated' | 'reset';
  rtUserId?: string;
}

/** The write safety rail: may writes mutate this domain? '*' = all; a list = only those; [] = none. */
export function isDomainWritable(domain: string, writeDomains: string[] | '*'): boolean {
  if (writeDomains === '*') return true;
  return writeDomains.includes(domain.toLowerCase());
}

/**
 * Ensure the NS softphone device exists and return its SIP password. If present, read it (the list may
 * omit the password, so a per-device GET fetches it); if missing, create it (synchronous:'yes' returns
 * the generated password inline).
 */
export async function ensureDevice(
  nsWrite: DeviceWriter,
  domain: string,
  ext: string,
  deviceName: string,
): Promise<{ password: string; created: boolean }> {
  const devices = await nsWrite.getDevices(domain, ext);
  const existing = devices.find((d) => String(d.device ?? '') === deviceName);
  if (existing) {
    const dev = await nsWrite.getDevice(domain, ext, deviceName);
    return { password: String(dev[SIP_PW_FIELD] ?? existing[SIP_PW_FIELD] ?? ''), created: false };
  }
  const created = await nsWrite.createDevice(domain, ext, deviceName);
  return { password: String(created[SIP_PW_FIELD] ?? ''), created: true };
}

/** Every Ringotel user at this base extension within the NS-connected branch. Duplicate detection is by
 *  EXTENSION number. STRICT on branchid: the fresh list is ORG-wide (spans branches), so a record whose
 *  branchid is absent or different must never be treated as a same-branch duplicate — it could be another
 *  NS domain's user, and this list feeds delete decisions. */
function usersForExt(users: User[], branchid: string, ext: string): User[] {
  return users.filter((u) => String(u.branchid ?? '') === branchid && String(u.extension ?? '') === ext);
}

/**
 * Resolve the single canonical Ringotel user for an extension — PURE: no deletes, no writes. A
 * correctly-managed extension has ≤1 user, but leftover records collide at the SAME extension — and
 * because Ringotel's SSO login maps by EXTENSION, a collision makes a login resolve to the wrong account
 * (the live demo `1043` case).
 *
 * CANONICAL = the real provisioned user: the record whose SIP `username`/`authname` is `<ext><suffix>`
 * (e.g. "1043r"). This holds even when NO record is active — a deactivated real user beside a tombstone,
 * exactly the live shape that a status-based rule wrongly refused. If none carries the SIP identity, fall
 * back to the record with `status === 1` (an ACTIVE record beats a merely-newer one — picking an inactive
 * record over a working active one would make a heal/dedup delete the live user), with most-recently-
 * created as the final tiebreak among equals (incl. when all are equally inactive/active). Only a true
 * tie — ≥2 records sharing the `<ext><suffix>` SIP identity — is refused, never guessed. Runs inside the
 * write handlers, so it is already write-domain-rail / auth / eligibility gated.
 *
 * Deliberately does NOT delete siblings — see `dedupSiblings`. Callers must resolve, do their write
 * (device ensure / activate / deactivate / reset), and only THEN dedup, so the extension is never left
 * with zero active records between a delete and a (re)activation (the brick window an SSO login could
 * land in).
 */
function resolveCanonical(opts: ActivationOpts): User | undefined {
  const matches = usersForExt(opts.users, opts.branchid, opts.ext);
  if (matches.length <= 1) return matches[0];
  const wantSip = opts.ext + opts.suffix; // the SIP AOR the real provisioned user carries, e.g. "1043r"
  const sip = matches.filter((u) => String(u.username ?? '') === wantSip || String(u.authname ?? '') === wantSip);
  if (sip.length > 1) {
    throw new RingotelWriteError(`ambiguous Ringotel users for extension ${opts.ext}: ${sip.length} records share SIP identity ${wantSip} — refusing to auto-resolve`, 409);
  }
  if (sip.length === 1) return sip[0];
  // No record carries the SIP identity → prefer an ACTIVE record; most-recently-created is only the
  // final tiebreak among status-equal records.
  return [...matches].sort((a, z) => {
    const aActive = Number(a.status) === 1 ? 1 : 0;
    const zActive = Number(z.status) === 1 ? 1 : 0;
    if (aActive !== zActive) return zActive - aActive; // active first
    return Number(z.created ?? 0) - Number(a.created ?? 0); // then newest first
  })[0];
}

/**
 * BEST-EFFORT delete every non-canonical Ringotel record at `canonical`'s extension — a delete that
 * errors or silently no-ops (Ringotel tombstones/phantoms cannot be removed: `deleteUser` returns
 * success but leaves them, or `updateUser` 500s "Invalid User ID") must NOT block the caller. Call this
 * AFTER the canonical's activation/deactivation/reset write, never before — deleting siblings first would
 * open a window where the extension has zero active records (see `resolveCanonical`'s doc).
 */
async function dedupSiblings(opts: ActivationOpts, canonical: User | undefined): Promise<void> {
  const matches = usersForExt(opts.users, opts.branchid, opts.ext);
  for (const other of matches) {
    if (other === canonical || other.id == null) continue;
    try {
      await opts.rtWrite.deleteUser(String(other.id), opts.orgid);
    } catch {
      /* best-effort: an un-deletable tombstone/phantom, or an already-gone record, must not block the write */
    }
  }
}

/** Activate: ensure device + SIP creds, then create/update the Ringotel user (status 1), THEN best-effort
 *  dedup any sibling records — never before, so the extension is never left with zero active records
 *  between a sibling delete and this (re)activation (the SSO-brick window). */
export async function activate(opts: ActivationOpts): Promise<ActivationResult> {
  // Resolve (no deletes) BEFORE creating the device, so an ambiguity refusal never orphans a device.
  const existing = resolveCanonical(opts);
  const deviceName = opts.ext + opts.suffix;
  const { password } = await ensureDevice(opts.nsWrite, opts.domain, opts.ext, deviceName);
  const username = deviceName; // Ringotel SIP username/authname == the NS device AOR, e.g. "100r"
  const email = opts.email ?? '';
  let result: ActivationResult;
  if (existing) {
    const id = String(existing.id);
    // Sync the NS identity (name + email) into the Ringotel user BEFORE (re)activation, so a user that
    // existed-but-was-deactivated gets its current NS first/last-name + email — not whatever stale value
    // the directory carried. `email` is sent FAITHFULLY, blank included (see ActivationOpts.email) —
    // only a failed read (`undefined`) leaves the directory value alone. `name` still guards on truthy:
    // NS always has a display name, so blank there means "we didn't get one", not "it was removed".
    const changes: Rec = { status: 1, username, authname: username, password };
    if (opts.name) changes.name = opts.name;
    if (opts.email !== undefined) changes.email = opts.email;
    await opts.rtWrite.updateUser(id, opts.orgid, changes);
    result = { action: 'updated', rtUserId: id };
  } else {
    const created = await opts.rtWrite.createUser({
      orgid: opts.orgid,
      branchid: opts.branchid,
      extension: opts.ext,
      name: opts.name || opts.ext,
      email,
      username,
      authname: username,
      password,
      status: 1,
      domain: opts.domain,
      noemail: false, // Ringotel sends the credentials email
    });
    result = { action: 'created', ...(created && created.id != null ? { rtUserId: String(created.id) } : {}) };
  }
  // Only now — after the canonical is (re)activated — best-effort clean up any siblings.
  await dedupSiblings(opts, existing);
  return result;
}

/** Deactivate: deactivate the Ringotel user (kept as an inactive directory entry) + delete the NS device. */
export async function deactivate(opts: ActivationOpts): Promise<ActivationResult> {
  const deviceName = opts.ext + opts.suffix;
  const existing = resolveCanonical(opts);
  const rtUserId = existing ? String(existing.id) : undefined;
  if (existing) {
    // Deactivate so the seat is NON-BILLABLE. ⚠ Use deactivateUser, NOT setUserStatus(0): per the Ringotel
    // AdminAPI, setUserStatus only BLOCKS a user (can't log in) while they stay ACTIVATED — i.e. still
    // BILLED. deactivateUser is the true, non-billable deactivation. Its cost: Ringotel moves the user into
    // a "Deleted" (recoverable) state, so its directory name shows "Deleted" and it drops out of the active
    // directory — the accepted tradeoff for freeing the seat (a named-but-billed "block" mode could be a
    // future config option). Best-effort identity sync (email helps recoverDeletedUser matching) runs first,
    // though deactivateUser overwrites the visible name.
    const changes: Rec = {};
    if (opts.name) changes.name = opts.name;
    if (opts.email !== undefined) changes.email = opts.email;
    if (Object.keys(changes).length) await opts.rtWrite.updateUser(rtUserId!, opts.orgid, changes);
    await opts.rtWrite.deactivateUser(rtUserId!, opts.orgid);
    // Only now — after the canonical is deactivated — best-effort clean up any siblings.
    await dedupSiblings(opts, existing);
  }
  try {
    await opts.nsWrite.deleteDevice(opts.domain, opts.ext, deviceName);
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e; // already gone is fine
  }
  return { action: 'deactivated', ...(rtUserId ? { rtUserId } : {}) };
}

/**
 * Reset: re-sync SIP creds + identity from the NS device (WITHOUT touching activation status), then
 * Ringotel resetUserPassword (emails a new app-login password). Two deliberate properties:
 *  - Refuses a non-active user, so a reset can never (re)activate a deactivated account or recreate its NS
 *    device — closing the "reset silently reverses a deactivation" hole (incl. any self-service reset).
 *  - Syncs email FIRST, so the new-password email Ringotel sends goes to the CURRENT NS address, not a
 *    stale one — INCLUDING when NetSapiens no longer has one, which is the case that matters: the
 *    directory's leftover address may belong to whoever held this extension before. A blank there means
 *    the reset mail goes nowhere, which is the intended outcome (it must not go to the wrong person);
 *    the operator's fix is to put an address on the NetSapiens user. Only a FAILED read (`undefined`)
 *    leaves the stored value alone.
 */
export async function resetPassword(opts: ActivationOpts): Promise<ActivationResult> {
  const existing = resolveCanonical(opts);
  if (!existing) throw new RingotelWriteError(`no Ringotel user to reset for extension ${opts.ext}`, 404);
  if (Number(existing.status) !== 1) {
    throw new RingotelWriteError(`Ringotel user for extension ${opts.ext} is not active — activate it before resetting the app password`, 409);
  }
  const id = String(existing.id);
  const deviceName = opts.ext + opts.suffix;
  const { password } = await ensureDevice(opts.nsWrite, opts.domain, opts.ext, deviceName);
  const changes: Rec = { username: deviceName, authname: deviceName, password };
  if (opts.name) changes.name = opts.name;
  if (opts.email !== undefined) changes.email = opts.email;
  await opts.rtWrite.updateUser(id, opts.orgid, changes);
  await opts.rtWrite.resetUserPassword(id, opts.orgid);
  // Only now — after the canonical's password is reset — best-effort clean up any siblings.
  await dedupSiblings(opts, existing);
  return { action: 'reset', rtUserId: id };
}
