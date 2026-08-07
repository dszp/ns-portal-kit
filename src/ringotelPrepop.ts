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
 * 3. **Planning is pure and separate from applying.** `planDirectoryPrepop` decides and explains; nothing
 *    is written until `applyDirectoryPrepop` runs. That is what lets a Reseller preview a domain-wide
 *    change before committing to it, and what makes the decision surface unit-testable.
 */
import { evaluateEligibility, type EligUser, type EligibilityConfig } from '@dszp/netsapiens-lib';
import { resolveCanonicalUser, type User } from '@dszp/ringotel-lib';

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
  /** `already-present` | `hard` | `soft` | `no-extension` | `no-name` */
  reason: string;
  detail?: string;
}

export interface PrepopPlan {
  /** Entries that would be created. */
  create: PrepopCandidate[];
  /** Everything not created, with the reason — a preview is only useful if it explains omissions. */
  skipped: PrepopSkip[];
  /** NetSapiens users that already have a Ringotel record in this branch. */
  present: number;
  /** Total NetSapiens users considered. */
  considered: number;
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

/**
 * Decide which NetSapiens users need a Ringotel directory entry. Pure — no I/O, no clock.
 *
 * Tier policy: `hard` is never created (a service code or a non-numeric extension is not a person).
 * `soft` only with {@link PrepopOptions.includeSoft}. `ok` and `precondition` are both created —
 * `precondition` means "no email address", which blocks *activation* but not a directory entry, and such
 * a user can still be SSO-activated later once they have credentials.
 */
export function planDirectoryPrepop(users: PrepopInput[], rtUsers: User[], opts: PrepopOptions): PrepopPlan {
  const create: PrepopCandidate[] = [];
  const skipped: PrepopSkip[] = [];
  let present = 0;

  for (const u of users) {
    const ext = (u.ext ?? '').trim();
    if (!ext) {
      skipped.push({ ext: '', reason: 'no-extension' });
      continue;
    }

    // Already in the directory? Any verdict other than 'none' means a record exists for this extension —
    // including an inactive one or an ambiguous pair, neither of which should be added to.
    const resolution = resolveCanonicalUser(rtUsers, { ext, branchid: opts.branchid, suffix: opts.suffix });
    if (resolution.verdict !== 'none') {
      present++;
      skipped.push({ ext, reason: 'already-present', detail: resolution.verdict });
      continue;
    }

    // `emailNotRequired: false` on purpose: we WANT a blank address to surface as `precondition` so the
    // policy below can admit it deliberately, rather than being silently waived into `ok`.
    const e = evaluateEligibility(u.elig, { domain: opts.domain, isReseller: opts.isReseller, emailNotRequired: false }, opts.config);

    if (e.tier === 'hard') {
      skipped.push({ ext, reason: 'hard', detail: e.reasons.join('; ') });
      continue;
    }
    if (e.tier === 'soft' && !opts.includeSoft) {
      skipped.push({ ext, reason: 'soft', detail: e.reasons.join('; ') });
      continue;
    }
    const name = (u.name ?? '').trim();
    if (!name) {
      // Ringotel requires a name on create, and a blank one would produce an unreadable directory entry.
      skipped.push({ ext, reason: 'no-name' });
      continue;
    }

    create.push({ ext, name, tier: e.tier, ...(u.email !== undefined ? { email: u.email } : {}) });
  }

  return { create, skipped, present, considered: users.length };
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
