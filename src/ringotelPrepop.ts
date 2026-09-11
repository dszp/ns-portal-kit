/**
 * Directory pre-population — create **inactive** Ringotel entries for NetSapiens users who have none.
 *
 * Distinct from activation. An activated user is a working softphone: a `<ext><suffix>` device, SIP
 * credentials, and a Ringotel record with `status: 1`. A pre-populated user is a *directory entry only* —
 * name, extension, and email at `status: 0`. It exists so the app directory reflects the NetSapiens
 * organization before anyone is activated, and so a later activation updates a record rather than
 * inventing one.
 *
 * Three properties are load-bearing:
 *
 * 1. **A placeholder must NOT take the SIP identity.** A record whose `username`/`authname` is
 *    `<ext><suffix>` owns that identity, which is exactly what makes a leftover record collide when an
 *    extension is later reassigned. Placeholders are created with no `username`, `authname`, or
 *    `password`; activation fills those in. `resolveCanonicalUser` resolves this correctly on its own —
 *    with no record carrying the SIP identity it falls back to status-then-recency, so activation updates
 *    the placeholder instead of creating a duplicate beside it.
 * 2. **Inactive entries are not billable, and Ringotel sends nothing until activation.** So creating one
 *    is not a cost event and not a user-visible event — which is what makes a whole-domain sweep
 *    reasonable at all. (Both were confirmed with the vendor; if either ever changes, this module is the
 *    thing to re-examine.)
 * 3. **Planning is pure and separate from applying.** The planner decides and explains; nothing is written
 *    until an apply runs. That is what lets a Reseller preview a domain-wide change before committing to
 *    it, and what makes the decision surface unit-testable.
 *
 * **There is ONE planner, and creating is one third of what it does.** `planExtensionReconcile` is the
 * whole rule for a single extension — create, update, remove, or leave alone — `planDirectoryReconcile`
 * folds it over a domain behind the abort guards, and `applyDirectoryReconcile` writes the result. Every
 * door (the preview route, the apply route, the cron, the refresh kick, the event tier) reaches a person
 * through that one rule, so no two of them can disagree about what should happen to them. A caller that
 * wants creates and updates without removals passes `maxRemove: 0`; that is a cap, not a second planner.
 */
import { evaluateEligibility, type EligUser, type EligibilityConfig } from '@dszp/netsapiens-lib';
import { resolveCanonicalUser, type User } from '@dszp/ringotel-lib';
import { isPlaceholder, rtNameOf, emailDiffers } from './ringotelActivation.js';

/** A NetSapiens user considered for a directory entry. `email` is three-state, as everywhere else. */
export interface PrepopInput {
  ext: string;
  /** Display name from NetSapiens. */
  name: string;
  /** `undefined` = unknown/read failed (send nothing); `''` = genuinely none; a string = the address. */
  email?: string;
  /** The eligibility projection of the same user. */
  elig: EligUser;
}

export interface PrepopCandidate {
  ext: string;
  name: string;
  email?: string;
  /** The eligibility tier that admitted it — `ok`, or `precondition` (no email), or `soft` when allowed. */
  tier: string;
}

export interface PrepopSkip {
  ext: string;
  /**
   * `already-present` (a placeholder that is present and in sync) | `hard` | `soft` | `no-extension` |
   * `no-name` | `active` | `tombstone` | `ambiguous`.
   */
  reason: string;
  detail?: string;
}

export interface PrepopOptions {
  domain: string;
  branchid: string;
  suffix: string;
  isReseller: boolean;
  config: EligibilityConfig;
  /**
   * Include soft-gated users (name matches like SHARED / VOICEMAIL / CONFERENCE, excluded extension
   * patterns). Off by default: soft gates exist because those extensions are not people, and a directory
   * full of entries nobody should ever activate is noise. Behind its own flag because some deployments
   * do want a literally complete directory.
   */
  includeSoft?: boolean;
}

export type ExtensionVerdict =
  | { action: 'create'; candidate: PrepopCandidate }
  | { action: 'update'; id: string; ext: string; changes: { name?: string; email?: string } }
  | { action: 'remove'; id: string; ext: string; reason: 'ns-gone' | 'ineligible' }
  | { action: 'none'; ext: string; reason: 'active' | 'tombstone' | 'hard' | 'soft' | 'no-name' | 'no-extension' | 'in-sync' | 'absent' | 'ambiguous'; detail?: string };

/** Eligibility folded to the three answers this feature cares about. */
function qualifies(ns: PrepopInput, opts: PrepopOptions): { ok: true; tier: string } | { ok: false; reason: 'hard' | 'soft'; detail: string } {
  const e = evaluateEligibility(ns.elig, { domain: opts.domain, isReseller: opts.isReseller, emailNotRequired: false }, opts.config);
  if (e.tier === 'hard') return { ok: false, reason: 'hard', detail: e.reasons.join('; ') };
  if (e.tier === 'soft' && !opts.includeSoft) return { ok: false, reason: 'soft', detail: e.reasons.join('; ') };
  return { ok: true, tier: e.tier };
}

/**
 * THE rule. One extension, one verdict, no I/O. The event tier calls this for the user an event named;
 * the domain planner folds it over the whole NS list. Keeping them on one function is what stops the
 * fast path and the converging path from ever disagreeing about a person.
 *
 * `ns === null` means "NetSapiens confirmed this extension does not exist" (a 404 on the re-read, or
 * absence from a successfully read list). A FAILED read must never be passed as null — that is the
 * caller's abort guard, not this function's.
 */
export function planExtensionReconcile(ns: PrepopInput | null, ext: string, rtUsers: User[], opts: PrepopOptions): ExtensionVerdict {
  const e = (ext ?? '').trim();
  if (!e) return { action: 'none', ext: '', reason: 'no-extension' };

  // An ATTACHED SECONDARY (`userid` set) is one app login viewed from another connection, and it sits at
  // its primary's extension — so by extension alone it is indistinguishable from a duplicate. Dropping it
  // BEFORE the ambiguity check as well as from `here` is the point: `resolveCanonicalUser` filters only on
  // branch and extension, so handing it the raw list made every extension carrying a secondary resolve as
  // `ambiguous` — permanently unreconcilable, silently. Same filter as `resolveCanonical` in
  // `ringotelActivation.ts`, and for the same reason.
  const mine = rtUsers.filter((u) => u.userid == null);
  const here = mine.filter((u) => String(u.branchid ?? '') === opts.branchid && String(u.extension ?? '').trim() === e);
  const resolution = resolveCanonicalUser(mine, { ext: e, branchid: opts.branchid, suffix: opts.suffix });
  if (resolution.verdict === 'ambiguous') return { action: 'none', ext: e, reason: 'ambiguous' };
  if (here.some((u) => Number(u.status) === 1)) return { action: 'none', ext: e, reason: 'active' };
  const placeholders = here.filter(isPlaceholder);
  if (here.length && !placeholders.length) return { action: 'none', ext: e, reason: 'tombstone' };
  if (placeholders.length > 1) return { action: 'none', ext: e, reason: 'ambiguous' };
  const ph = placeholders[0];
  // A record we cannot address is unactionable, and that must never be reported as `in-sync` or `absent`:
  // both of those say "nothing to do", which would leave a drifted (or departed) entry looking settled
  // forever. One guard here rather than a `ph.id` test on each branch below — the answer is the same
  // whatever NetSapiens says about the extension.
  if (ph && ph.id == null) return { action: 'none', ext: e, reason: 'ambiguous', detail: 'record has no id' };
  // ...and an extension whose only record here is an attached secondary is not a gap either. Its primary
  // lives on another connection, so someone's app login already answers at this extension: creating a
  // placeholder beside it would put two records at one ext in one branch — the state this planner reports
  // as `already-present`. Filtering the secondary out of the DECISION is right (it is never the
  // record to update or delete); treating the extension as empty is not. Reported as `active`, which is
  // what it is from this connection's point of view.
  if (!ph && rtUsers.some((u) => u.userid != null && String(u.branchid ?? '') === opts.branchid && String(u.extension ?? '').trim() === e)) {
    return { action: 'none', ext: e, reason: 'active' };
  }

  if (ns === null) {
    if (!ph) return { action: 'none', ext: e, reason: 'absent' };
    return { action: 'remove', id: String(ph.id), ext: e, reason: 'ns-gone' };
  }

  const q = qualifies(ns, opts);
  if (!q.ok) {
    // A `soft` verdict may DELETE a record only when it did not rest on a device count nobody counted.
    // `excludeNoDevices` makes every name exclusion bite when the count is 0, and `evaluateEligibility`
    // reads an ABSENT count as 0 — so a caller that cannot count devices per user (a whole-domain list
    // read: one extra API call per user, and a wrong count is worse than an absent one) turns every
    // SHARED/VOICEMAIL-named placeholder into a removal on an inference. Refusing to CREATE on that same
    // inference costs a directory entry and is left as it was; removal is the expensive direction, and
    // `ineligible` is the one removal `applyDirectoryReconcile` never confirms against NetSapiens.
    //
    // Deliberately conservative: it refuses the removal for ANY soft verdict while the count is unknown,
    // not only a name-derived one, because telling them apart means reading the reason strings the
    // library composes — a coupling worth less than the one placeholder an ext-pattern soft would delete
    // a run later, once a real count arrives.
    if (ph && q.reason === 'soft' && opts.config.excludeNoDevices && ns.elig.deviceCount === undefined) {
      return { action: 'none', ext: e, reason: 'soft', detail: 'device count unknown — removal refused' };
    }
    if (ph) return { action: 'remove', id: String(ph.id), ext: e, reason: 'ineligible' };
    return { action: 'none', ext: e, reason: q.reason, detail: q.detail };
  }

  // A NetSapiens record with no display name is not evidence to sync FROM, in either direction. It has
  // always blocked creation (a directory entry IS a name); it now blocks the update beside it too,
  // because the one field such a record can still write is `email`, and the shape that produces it is a
  // "Reset User" — name, email, password and devices stripped, the record left behind. Clearing a
  // placeholder's stored address from that row is a write onto an account nothing should be writing to.
  // Removal is unaffected and stays where it is (above): an INELIGIBLE user is removed whatever their
  // name, and a reset account is never ineligible — it is recycled for the next hire, and the
  // placeholder is what that hire activates.
  const name = (ns.name ?? '').trim();
  if (!name) return { action: 'none', ext: e, reason: 'no-name' };
  if (!ph) {
    return { action: 'create', candidate: { ext: e, name, tier: q.tier, ...(ns.email !== undefined ? { email: ns.email } : {}) } };
  }
  const changes: { name?: string; email?: string } = {};
  if (name && name !== rtNameOf(ph)) changes.name = name;
  if (ns.email !== undefined && emailDiffers(ph, ns.email)) changes.email = ns.email;
  if (!Object.keys(changes).length) return { action: 'none', ext: e, reason: 'in-sync' };
  return { action: 'update', id: String(ph.id), ext: e, changes };
}

export interface ReconcileOptions extends PrepopOptions {
  /** Cap on removals per run — the sweep's `NS_EVENTS_SWEEP_MAX`. Creates and updates are uncapped. */
  maxRemove: number;
}

export interface ReconcilePlan {
  status: 'ok' | 'abort';
  /** `locked` is the one reason that is not about the NetSapiens read: another reconcile of this domain
   *  was already in flight, so this run planned nothing rather than race it. See `takePrepopLock`. */
  reason?: 'ns-list-unavailable' | 'ns-list-empty' | 'ns-list-unusable' | 'locked';
  create: PrepopCandidate[];
  update: { id: string; ext: string; changes: { name?: string; email?: string } }[];
  remove: { id: string; ext: string; reason: 'ns-gone' | 'ineligible' }[];
  /** Everything not acted on, with the reason — a preview is only useful if it explains its omissions. */
  skipped: PrepopSkip[];
  /** NetSapiens users whose Ringotel record already exists and this plan keeps. */
  present: number;
  /** Total NetSapiens users considered. */
  considered: number;
  /** The removal list hit {@link ReconcileOptions.maxRemove} and was cut short. */
  truncated: boolean;
}

/** A plan with nothing in it. Exported so a caller that aborts BEFORE planning — the reconcile lock —
 *  reports the same shape as one that aborts inside it, rather than inventing a second empty. */
export const emptyPlan = (status: ReconcilePlan['status'], reason?: ReconcilePlan['reason']): ReconcilePlan =>
  ({ status, ...(reason ? { reason } : {}), create: [], update: [], remove: [], skipped: [], present: 0, considered: 0, truncated: false });

/**
 * `none` reasons that can only arise from a record this connection already holds. Every one of them is
 * reached after a record was found at the extension, so they are what `present` counts — alongside
 * `update`, which needs a record by definition. `remove` is deliberately NOT here: that record is on its
 * way out and is already reported in `remove`, and counting it twice would overstate the directory.
 */
const RECORD_EXISTS: ReadonlySet<string> = new Set(['active', 'tombstone', 'in-sync', 'ambiguous']);

/**
 * The domain plan: {@link planExtensionReconcile} folded over every extension on either side, behind the
 * abort guards the orphan sweep uses. `nsUsers === null` is a failed read; `[]` is an empty domain; both
 * plan nothing, because the difference between them is deleting a whole directory.
 *
 * The third guard is the same rule one layer in: a list that arrives with rows but no usable extension in
 * any of them is a read that went wrong in a shape `length > 0` cannot see — a changed field name, a
 * projection that dropped `user`. Every placeholder would resolve `ns-gone` and the run would read as
 * "the whole domain left". It aborts as `ns-list-unusable` and keeps the per-row `no-extension` skips, so
 * the plan still says why.
 *
 * Extensions are visited in sorted order so the removal cap takes a stable, explainable slice rather than
 * whatever order the two lists happened to arrive in — a capped run must make the same progress twice.
 */
export function planDirectoryReconcile(nsUsers: PrepopInput[] | null, rtUsers: User[], opts: ReconcileOptions): ReconcilePlan {
  if (nsUsers === null) return emptyPlan('abort', 'ns-list-unavailable');
  if (nsUsers.length === 0) return emptyPlan('abort', 'ns-list-empty');

  const plan = emptyPlan('ok');
  plan.considered = nsUsers.length;
  const byExt = new Map<string, PrepopInput>();
  for (const u of nsUsers) {
    const ext = (u.ext ?? '').trim();
    if (!ext) { plan.skipped.push({ ext: '', reason: 'no-extension' }); continue; }
    byExt.set(ext, u);
  }
  if (byExt.size === 0) return { ...emptyPlan('abort', 'ns-list-unusable'), skipped: plan.skipped, considered: plan.considered };
  // Attached secondaries (`userid` set) are excluded from the union for the same reason
  // `planExtensionReconcile` filters them out of its decision: they belong to another connection and are
  // never the record to create, update or delete. One sitting alone at an extension NetSapiens does not
  // know about is nothing to do, so it needs no row.
  const rtExts = new Set(
    rtUsers
      .filter((u) => String(u.branchid ?? '') === opts.branchid && u.userid == null)
      .map((u) => String(u.extension ?? '').trim())
      .filter(Boolean),
  );

  const all = [...new Set([...byExt.keys(), ...rtExts])].sort((a, z) => a.localeCompare(z));
  const removals: ReconcilePlan['remove'] = [];
  for (const ext of all) {
    const ns = byExt.get(ext) ?? null;
    const v = planExtensionReconcile(ns, ext, rtUsers, opts);
    switch (v.action) {
      case 'create': plan.create.push(v.candidate); break;
      case 'update': plan.update.push({ id: v.id, ext: v.ext, changes: v.changes }); plan.present++; break;
      case 'remove': removals.push({ id: v.id, ext: v.ext, reason: v.reason }); break;
      case 'none':
        if (ns && RECORD_EXISTS.has(v.reason)) plan.present++;
        if (v.reason === 'absent') break; // nothing on either side — not worth a row
        plan.skipped.push({ ext: v.ext, reason: v.reason === 'in-sync' ? 'already-present' : v.reason, ...(v.detail ? { detail: v.detail } : {}) });
        break;
    }
  }
  plan.remove = removals.slice(0, Math.max(0, opts.maxRemove));
  plan.truncated = removals.length > plan.remove.length;
  return plan;
}

/** The Ringotel write surface this module needs. Structural, so selftests inject a mock. */
export interface PrepopWriter {
  createUser(input: { orgid: string; branchid: string; name: string; extension: string } & Record<string, unknown>): Promise<unknown>;
}

export interface PrepopResult {
  created: number;
  failed: { ext: string; error: string }[];
}

/**
 * Create the planned directory entries.
 *
 * Deliberately creates the minimum: extension, name, status 0, and the email when known. **No
 * `username`, `authname`, or `password`** — see this module's header for why taking the SIP identity
 * early is harmful. One failure never stops the rest; a partial run is safe to re-run because the next
 * plan simply won't include whatever succeeded.
 */
export async function applyDirectoryPrepop(
  rtWrite: PrepopWriter,
  orgid: string,
  branchid: string,
  candidates: PrepopCandidate[],
): Promise<PrepopResult> {
  const failed: PrepopResult['failed'] = [];
  let created = 0;
  for (const c of candidates) {
    try {
      await rtWrite.createUser({
        orgid,
        branchid,
        extension: c.ext,
        name: c.name,
        status: 0,
        ...(c.email !== undefined ? { email: c.email } : {}),
      });
      created++;
    } catch (e) {
      failed.push({ ext: c.ext, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return { created, failed };
}

export interface ReconcileWriter extends PrepopWriter {
  updateUser(userid: string, orgid: string, changes: Record<string, unknown>): Promise<unknown>;
  deleteUser(userid: string, orgid: string): Promise<unknown>;
  /**
   * Ask NetSapiens directly whether this extension is really gone — `true` only for a definite "does not
   * exist". A failed or ambiguous read is `false`, because "I could not tell" must never authorise a
   * delete.
   *
   * REQUIRED, not optional, and that is the point. `ns-gone` is an inference from a LIST read, and a list
   * that was truncated, filtered or paginated short says the same thing as a departure. The orphan sweep
   * already re-reads each candidate and acts only on a 404; putting the same confirmation in the writer's
   * TYPE means no future caller can wire this up and forget it.
   */
  confirmGone(ext: string): Promise<boolean>;
}

export interface ReconcileResult {
  created: number;
  updated: number;
  removed: number;
  /**
   * Which extensions were actually deleted, and why — not merely how many.
   *
   * A count is enough for a create or an update, because the record is still there to inspect
   * afterwards. A delete leaves nothing behind, so `removed: 1` on a domain is an unanswerable question
   * six hours later. This is reported by the applier rather than derived by the caller (plan.remove minus
   * the failures) because THIS loop is the only thing that knows which deletes actually went through;
   * reconstructing it by subtraction would agree with itself while being wrong the first time a removal
   * path gains an outcome that is neither a clean success nor an entry in `failed`.
   */
  removedExts: { ext: string; reason: 'ns-gone' | 'ineligible' }[];
  failed: { ext: string; op: 'create' | 'update' | 'remove'; error: string }[];
}

/**
 * Write a {@link ReconcilePlan}: create → update → delete, in that order.
 *
 * The order is the safe one. Creating first means a run cut short by an error still leaves the directory
 * more complete than it found it; deleting last means the records that go away are the ones the plan was
 * surest about. One failure never stops the rest — a partial run is safe to re-run, because the next plan
 * simply won't include whatever succeeded — and an aborted plan writes NOTHING, whatever its lists say:
 * the guard belongs on the last thing that touches Ringotel, not only on the planner. Each `ns-gone`
 * removal is confirmed against NetSapiens immediately before the delete (see
 * {@link ReconcileWriter.confirmGone}), so a short `/users` page cannot manufacture a deletion.
 */
export async function applyDirectoryReconcile(w: ReconcileWriter, orgid: string, branchid: string, plan: ReconcilePlan): Promise<ReconcileResult> {
  const res: ReconcileResult = { created: 0, updated: 0, removed: 0, removedExts: [], failed: [] };
  if (plan.status !== 'ok') return res;
  const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);
  const c = await applyDirectoryPrepop(w, orgid, branchid, plan.create);
  res.created = c.created;
  for (const f of c.failed) res.failed.push({ ext: f.ext, op: 'create', error: f.error });
  for (const u of plan.update) {
    try { await w.updateUser(u.id, orgid, { ...u.changes }); res.updated++; } catch (e) { res.failed.push({ ext: u.ext, op: 'update', error: msg(e) }); }
  }
  for (const r of plan.remove) {
    try {
      // `ineligible` needs no second look: reaching that verdict meant reading the NetSapiens record and
      // finding a person we may not provision. `ns-gone` is the inference, so it is the one confirmed.
      if (r.reason === 'ns-gone' && !(await w.confirmGone(r.ext))) {
        res.failed.push({ ext: r.ext, op: 'remove', error: 'not confirmed gone' });
        continue;
      }
      await w.deleteUser(r.id, orgid);
      res.removed++;
      res.removedExts.push({ ext: r.ext, reason: r.reason });
    } catch (e) { res.failed.push({ ext: r.ext, op: 'remove', error: msg(e) }); }
  }
  return res;
}

// ── orphan `<ext><suffix>` devices ────────────────────────────────────────────────────────────────────

/** A NetSapiens device record, as returned by a device listing. Only the fields we reason about. */
export interface DeviceRec {
  device?: unknown;
  user?: unknown;
  'device-sip-registration-state'?: unknown;
  [k: string]: unknown;
}

export interface OrphanDelete {
  ext: string;
  device: string;
}

export interface OrphanKeep {
  ext: string;
  device: string;
  /** `ringotel-active` | `ambiguous` | `other-devices` | `registered` */
  reason: string;
}

export interface OrphanPlan {
  /** Safe to delete: deleting these reduces the NetSapiens seat count and breaks nothing. */
  delete: OrphanDelete[];
  /** Orphans deliberately left alone, with why — a preview must explain its omissions. */
  keep: OrphanKeep[];
  /** Every `<ext><suffix>` device found whose Ringotel side is not active. */
  found: number;
}

/**
 * Find `<ext><suffix>` devices that exist while the Ringotel side is NOT activated.
 *
 * Why this matters: an extension carrying one or more devices is a billable NetSapiens user, so a
 * softphone device left behind by a deactivation (or by legacy tooling) is a seat being paid for with
 * nothing using it. The normal `deactivate` path already deletes the device — this catches drift.
 *
 * **Deletion requires all three conditions**, and each one is doing real work:
 *  - *Ringotel is not active.* Deleting the device of an active user rotates them out of service.
 *  - *It is the user's ONLY device.* Billing is per-extension-with-devices, so if a desk phone remains the
 *    user stays billable and deleting `<ext><suffix>` costs the SIP credentials for no saving at all.
 *  - *It is not currently registered.* A registered device is something actually running right now.
 *
 * An ambiguous Ringotel resolution is left alone: acting on a state we refuse to interpret elsewhere would
 * be inconsistent, and the blast radius here is a deletion.
 *
 * Pure. The caller supplies the device list, which is deliberate — the domain-wide device listing is not
 * available on every NetSapiens release, and the caller must decide what to do when it cannot be read
 * (the correct answer being: nothing).
 */
export function planOrphanDevices(
  devices: DeviceRec[],
  rtUsers: User[],
  opts: { branchid: string; suffix: string },
): OrphanPlan {
  const byUser = new Map<string, DeviceRec[]>();
  for (const d of devices) {
    const user = String(d.user ?? '').trim();
    if (!user) continue;
    const list = byUser.get(user);
    if (list) list.push(d);
    else byUser.set(user, [d]);
  }

  const del: OrphanDelete[] = [];
  const keep: OrphanKeep[] = [];
  let found = 0;

  for (const [ext, list] of byUser) {
    const wanted = ext + opts.suffix;
    const softphone = list.find((d) => String(d.device ?? '') === wanted);
    if (!softphone) continue;

    const resolution = resolveCanonicalUser(rtUsers, { ext, branchid: opts.branchid, suffix: opts.suffix });
    if (resolution.verdict === 'active') continue; // in service — not an orphan at all
    found++;

    if (resolution.verdict === 'ambiguous') {
      keep.push({ ext, device: wanted, reason: 'ambiguous' });
      continue;
    }
    if (list.length > 1) {
      keep.push({ ext, device: wanted, reason: 'other-devices' });
      continue;
    }
    if (String(softphone['device-sip-registration-state'] ?? '') === 'registered') {
      keep.push({ ext, device: wanted, reason: 'registered' });
      continue;
    }
    del.push({ ext, device: wanted });
  }

  return { delete: del, keep, found };
}

/** The device-delete surface. Structural, so selftests inject a mock. */
export interface OrphanDeviceWriter {
  deleteDevice(domain: string, user: string, device: string): Promise<unknown>;
}

/** Delete the planned orphan devices. One failure never stops the rest; re-running is safe. */
export async function applyOrphanDeletes(
  nsWrite: OrphanDeviceWriter,
  domain: string,
  candidates: OrphanDelete[],
): Promise<{ deleted: number; failed: { ext: string; error: string }[] }> {
  const failed: { ext: string; error: string }[] = [];
  let deleted = 0;
  for (const c of candidates) {
    try {
      await nsWrite.deleteDevice(domain, c.ext, c.device);
      deleted++;
    } catch (e) {
      failed.push({ ext: c.ext, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return { deleted, failed };
}
