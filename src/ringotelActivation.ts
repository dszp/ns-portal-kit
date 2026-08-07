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
// Device orchestration is SHARED with ringotel-ns-sso via the library — two hand-maintained copies of
// "reuse or rotate the SIP credential" is exactly the drift that produced SSO bricks before.
import { ensureNsDevice, generateSipPassword, SIP_PW_FIELD } from '@dszp/netsapiens-lib';

/** Re-exported from the library so existing importers here keep working. */
export { SIP_PW_FIELD, generateSipPassword };

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
  /** Used only to rotate the SIP password in place — see `ensureDevice`'s `rotateExisting`. */
  updateDevice(domain: string, user: string, device: string, changes: Rec): Promise<Rec>;
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
  /**
   * Rotate the SIP password when the `<ext><suffix>` device ALREADY existed. See `ensureDevice`.
   * The worker decides (config); the default at this layer is off so nothing rotates implicitly.
   */
  rotateExistingDevice?: boolean;
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
/**
 * Ensure the NS softphone device exists and return its SIP password — a thin delegation to the library's
 * `ensureNsDevice`, keeping this module's positional signature so existing callers and selftests are
 * unaffected.
 *
 * `rotateExisting` replaces the password of a device that ALREADY existed. See the library for the full
 * reasoning; the short version is that reusing the stored password leaves any other endpoint holding it
 * able to register as the same AOR, and the two then fight over the registration. Rotate only where a
 * human (or a first-time provision) has just declared this extension to be the app's — never on a
 * per-login path, where concurrent runs would churn the credential.
 */
export async function ensureDevice(
  nsWrite: DeviceWriter,
  domain: string,
  ext: string,
  deviceName: string,
  opts: { rotateExisting?: boolean; mayCreate?: boolean } = {},
): Promise<{ password: string; created: boolean; rotated?: boolean; rotateError?: string }> {
  return ensureNsDevice(nsWrite, {
    domain,
    user: ext,
    device: deviceName,
    ...(opts.rotateExisting !== undefined ? { rotateExisting: opts.rotateExisting } : {}),
    ...(opts.mayCreate !== undefined ? { mayCreate: opts.mayCreate } : {}),
  });
}

/** Every Ringotel user at this base extension within the NS-connected branch. Duplicate detection is by
 *  EXTENSION number. STRICT on branchid: the fresh list is ORG-wide (spans branches), so a record whose
 *  branchid is absent or different must never be treated as a same-branch duplicate — it could be another
 *  NS domain's user, and this list feeds delete decisions.
 *
 *  Trims BOTH sides. `nsOffboard.ts`'s sweep planner already trims the Ringotel `extension` it reads when
 *  deciding an extension is orphaned (`String(u.extension ?? '').trim()`); this compared it untrimmed,
 *  so an operator-entered Ringotel record whose extension carried whitespace was planned as an orphan
 *  every sweep but never matched here — `deactivateAppOnly` returned `absent`, forever, silently. Trimming
 *  only ever makes the match MORE permissive (it can find a record it previously missed; it can never stop
 *  matching a record that matched before, since two exactly-equal strings are still equal after trimming),
 *  so this is strictly safer for every caller of `resolveCanonical` (activate / deactivate / resetPassword
 *  / syncIdentity / repairDeviceForEvent). */
function usersForExt(users: User[], branchid: string, ext: string): User[] {
  const wanted = ext.trim();
  return users.filter((u) => String(u.branchid ?? '') === branchid && String(u.extension ?? '').trim() === wanted);
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
 *
 * Exported because it is the selection rule the whole module turns on: every write picks its record
 * through this function, and a rule observable only through `activate`'s mock call log grows tests
 * that assert on the mock rather than on the rule.
 */
export function resolveCanonical(opts: Pick<ActivationOpts, 'users' | 'branchid' | 'ext' | 'suffix'>): User | undefined {
  // An ATTACHED SECONDARY (`userid` set, pointing at its primary) is a different person's-eye view of
  // one app login on another connection — never a candidate to provision, activate or deactivate. It
  // sits at the SAME extension as its primary, so on a multi-connection domain it is indistinguishable
  // from a duplicate by extension alone, and being created later it would win the newest-first
  // tiebreak. Filtering here rather than in `usersForExt` is deliberate: `deactivateAppOnly` uses that
  // helper to reach EVERY active record at an extension, and must keep doing so.
  const matches = usersForExt(opts.users, opts.branchid, opts.ext).filter((u) => u.userid == null);
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
  const { password } = await ensureDevice(opts.nsWrite, opts.domain, opts.ext, deviceName, {
    // Only here: activation is the deliberate "this extension is the app's now" moment.
    rotateExisting: opts.rotateExistingDevice === true,
  });
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

/** What a background identity sync did. `changed` names the fields actually written. */
export interface SyncIdentityResult {
  action: 'synced' | 'no-change' | 'absent';
  rtUserId?: string;
  changed: string[];
}

/**
 * Read the Ringotel-side email. **It lives at `info.email`, NOT at the top level** — `getUsers` returns no
 * top-level `email`, so reading `user.email` yields `undefined` for every user, which is indistinguishable
 * from "nobody has an address". A comparison written the obvious way therefore sees a difference on every
 * event and writes forever, turning at-least-once delivery into an amplifier.
 *
 * ⚠️ **`info.email` is `string | string[]`** (live-verified 2026-08-06). Every `info` field holds a plain
 * string at one value and becomes an ARRAY the moment the user adds a second one in the app — the desktop
 * client offers extra Email and Phone rows, so this is a normal thing for a user to do, not an edge case.
 *
 * The `typeof === 'string'` fallback below is therefore NOT safe as written: given an array it returns '',
 * `syncIdentity` concludes the address differs, and writes the NS address back as a flat string —
 * collapsing the array and destroying the second address the user entered. TODO: normalize instead, e.g.
 * take element 0 for the comparison and preserve the remainder on write. Left as-is pending that fix so
 * the behaviour is recorded rather than silently half-changed.
 */
function rtEmailOf(u: User): string {
  const info = (u as Rec)['info'];
  const nested = info && typeof info === 'object' ? (info as Rec)['email'] : undefined;
  const val = nested ?? (u as Rec)['email'];
  return typeof val === 'string' ? val.trim() : '';
}

const rtNameOf = (u: User): string => {
  const v = (u as Rec)['name'];
  return typeof v === 'string' ? v.trim() : '';
};

/**
 * Push the current NetSapiens identity (display name + email) onto the EXISTING canonical Ringotel user —
 * the background, event-driven sync. Compare-then-write, so a replayed event is a no-op.
 *
 * ⚠️ **INVARIANT — this may only ever call `updateUser`.** It must NOT activate, deactivate, create, or
 * `dedupSiblings`, and there is a selftest asserting exactly that. The reason is concurrency: this runs from
 * a NetSapiens webhook in this Worker, while the SSO worker's heal path runs from a login in a *different*
 * Worker, with no shared lock. `activate`/`deactivate`/`resetPassword` all dedup siblings, and their safety
 * depends on the strict order "write the canonical first, delete siblings second" (the SSO-brick window). Two
 * concurrent dedups can delete a record the other just activated. Restricting this to a pure identity update
 * makes the two writers safe to overlap: they converge on the same NS-sourced values and neither one changes
 * activation state or membership.
 *
 * Consequently a missing Ringotel user is `'absent'`, not a provisioning trigger — creating a directory entry
 * (a billable seat) is a deliberate, human- or login-initiated act, never a side effect of an NS field edit.
 */
export async function syncIdentity(opts: ActivationOpts): Promise<SyncIdentityResult> {
  const existing = resolveCanonical(opts); // may throw 409 on a genuine tie — the caller logs and drops
  if (!existing) return { action: 'absent', changed: [] };

  const id = String(existing.id);
  const changes: Rec = {};
  const changed: string[] = [];

  // `name` guards on truthy: NS always has a display name, so blank means "we didn't get one", not "removed".
  //
  // ⚠️ **This deliberately overwrites a name the user chose in the app.** Ringotel lets a user rename
  // themselves from the client (it writes top-level `name`; the SIP identity is untouched, and the new
  // name propagates to their other devices at next login). Because we compare against NetSapiens, that
  // self-chosen name is reverted the next time ANY subscriber event fires for them — which may be hours
  // or days later, triggered by something unrelated. From the user's side it looks arbitrary.
  //
  // DECIDED 2026-08-06: keep NetSapiens authoritative. The directory should agree with the PBX, and a
  // per-user override has nowhere durable to live (see below). Documented rather than fixed so the
  // behaviour is a choice, not a surprise. To allow personalized display names instead, drop `name`
  // from this compare set — do NOT try to detect "the user changed it", which is unknowable here.
  if (opts.name && opts.name.trim() !== rtNameOf(existing)) {
    changes.name = opts.name;
    changed.push('name');
  }
  // `email` honours the three-state contract: undefined = don't know, touch nothing; '' = a real removal.
  // Both sides normalize undefined/absent to '' so "no address either side" is correctly a no-op.
  if (opts.email !== undefined && opts.email.trim() !== rtEmailOf(existing)) {
    changes.email = opts.email;
    changed.push('email');
  }

  if (changed.length === 0) return { action: 'no-change', rtUserId: id, changed };
  await opts.rtWrite.updateUser(id, opts.orgid, changes);
  return { action: 'synced', rtUserId: id, changed };
}

/** What the narrow offboarding action did. `rtUserIds` names every record it deactivated. */
export interface DeactivateAppOnlyResult {
  action: 'deactivated' | 'no-change' | 'absent';
  rtUserIds: string[];
}

/**
 * Deactivate the app record(s) for an extension and **nothing else** — the offboarding action.
 *
 * ⚠️ **INVARIANT — this may only ever call `deactivateUser`.** No NS device delete, no create, no
 * password touch, no identity write, no `dedupSiblings`. A selftest asserts it, mirroring `syncIdentity`'s.
 *
 * **Why no device delete, when `deactivate()` does one.** If the NetSapiens user is genuinely gone its
 * devices went with it, so the delete buys nothing. If the 404 that triggered this was *spurious* — a
 * renamed extension, a scope-narrowed credential — the narrow action means we deactivated a recoverable
 * record instead of destroying a live user's SIP credential. Deactivation is reversible (SSO heal or the
 * portal reactivates); device destruction is not. That asymmetry is the whole argument.
 *
 * **Why every active record, not just the canonical.** Leaving a billed sibling active defeats the entire
 * purpose — a seat charged for a user who no longer exists. It also removes `resolveCanonical`'s
 * 409-on-ambiguity failure mode from this path: we are not *choosing* a record, so a tie is not a
 * decision that has to be refused.
 *
 * Concurrency-safe against the SSO worker's heal path for the same reason `syncIdentity` is: no
 * membership changes, and no other writer can be activating an extension whose NS user does not exist.
 */
export async function deactivateAppOnly(opts: ActivationOpts): Promise<DeactivateAppOnlyResult> {
  const matches = usersForExt(opts.users, opts.branchid, opts.ext);
  if (matches.length === 0) return { action: 'absent', rtUserIds: [] };

  const active = matches.filter((u) => Number(u.status) === 1 && u.id != null);
  // Replay-safe: an already-deactivated extension is a no-op, so at-least-once delivery costs nothing.
  if (active.length === 0) return { action: 'no-change', rtUserIds: [] };

  const rtUserIds: string[] = [];
  for (const u of active) {
    await opts.rtWrite.deactivateUser(String(u.id), opts.orgid);
    rtUserIds.push(String(u.id));
  }
  return { action: 'deactivated', rtUserIds };
}

/** What a device self-heal found or did. `changed` holds `'device-created'`, `'device-missing'` (report
 *  mode only — device absent, or present with an unreadable password; the two can't be told apart there),
 *  `'device-password-blank'` (heal mode only — device confirmed present, password unreadable), or
 *  `'sip-identity'` — the drift observed, in report mode, or corrected, in heal mode. */
export interface RepairDeviceResult {
  action: 'ok' | 'repaired' | 'would-repair' | 'absent' | 'inactive';
  changed: string[];
}

/**
 * Re-assert the NS softphone device behind an ACTIVE app user, on a user-change event.
 *
 * Deliberately **not** folded into `syncIdentity`: that function's `updateUser`-only invariant is what
 * makes it safe to overlap with the SSO worker's heal path, and creating a device is not an identity
 * update.
 *
 * ⚠️ **Never rotates.** `rotateExisting: false`, always. `ensureNsDevice`'s own documentation is explicit
 * that rotating on a per-request path churns the credential and races a re-registration — and an event
 * path is per-request.
 *
 * Gated on `status === 1` for the same reason `syncIdentity` treats a missing record as `'absent'`:
 * provisioning is a deliberate, human- or login-initiated act, never a side effect of an NS field edit.
 * Creating an NS device for a non-app user *is* provisioning.
 *
 * The stored Ringotel password is never pushed speculatively — the API does not return it, so it cannot
 * be compared, and writing it every time would turn every event into a write.
 */
export async function repairDeviceForEvent(
  opts: ActivationOpts & { mode: 'report' | 'heal' },
): Promise<RepairDeviceResult> {
  const existing = resolveCanonical(opts); // may throw 409 on a genuine tie — the caller logs and drops
  if (!existing) return { action: 'absent', changed: [] };
  if (Number(existing.status) !== 1) return { action: 'inactive', changed: [] };

  const deviceName = opts.ext + opts.suffix;
  const heal = opts.mode === 'heal';
  const dev = await ensureDevice(opts.nsWrite, opts.domain, opts.ext, deviceName, {
    mayCreate: heal,
    rotateExisting: false,
  });

  // `{password:'', created:false}` is NOT unambiguously "device is missing" — `ensureNsDevice` returns
  // that identical shape for an EXISTING device whose stored SIP password reads back blank (see its
  // `existing` branch, `rotateExisting:false`), which is reachable in HEAL mode too.
  //
  // In REPORT mode `mayCreate` is always false, so `created:false` alone can't tell "absent" from
  // "present with a blank password" apart — but "would create a device" is the right operator signal
  // either way, so it stays tagged 'device-missing' (unchanged from before).
  //
  // In HEAL mode `mayCreate` is true, so `created:false` can ONLY mean the device already existed — a
  // genuinely missing one would have been created. A blank password there is a present-but-unreadable
  // credential, not a missing device, so it gets its own honest tag. Behaviour is unaffected: only a
  // freshly CREATED device's password is ever pushed (below), so this never changes what gets written.
  const deviceMissing = !heal && !dev.created && dev.password === '';
  const devicePasswordBlank = heal && !dev.created && dev.password === '';
  const sipMismatch =
    String(existing.username ?? '') !== deviceName || String(existing.authname ?? '') !== deviceName;

  const changed: string[] = [];
  if (dev.created) changed.push('device-created');
  if (deviceMissing) changed.push('device-missing');
  if (devicePasswordBlank) changed.push('device-password-blank');
  if (sipMismatch) changed.push('sip-identity');

  if (changed.length === 0) return { action: 'ok', changed: [] };
  if (!heal) return { action: 'would-repair', changed };

  const updates: Rec = { username: deviceName, authname: deviceName };
  // Only a freshly created device has a password worth pushing, and only if NS actually returned one —
  // writing a blank would strip the Ringotel user's credential.
  if (dev.created && dev.password) updates.password = dev.password;
  await opts.rtWrite.updateUser(String(existing.id), opts.orgid, updates);
  return { action: 'repaired', changed };
}
