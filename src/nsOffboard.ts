/**
 * The orphan-sweep planner: which extensions in a Ringotel branch no longer have a NetSapiens user, and
 * should therefore have their app record deactivated.
 *
 * **Pure by design.** The I/O — reading the NS user list, resolving the org, performing the writes —
 * lives in the Worker. What lives here is the decision, because the decision contains the single riskiest
 * rule in the offboarding feature and it deserves to be testable without a network.
 *
 * **Why the sweep exists at all**, given the event tier already deactivates on a confirmed 404: an event
 * is at-least-once but not guaranteed, so a missed delete would be permanent drift; and no event can ever
 * clean up an orphan created *before* the feature was switched on. The sweep converges, the event is
 * merely fast.
 */

/** One extension to deactivate, with every Ringotel record id found at it. */
export interface SweepOrphan {
  ext: string;
  rtUserIds: string[];
}

export type SweepPlan =
  | { status: 'abort'; reason: 'ns-list-unavailable' | 'ns-list-empty' }
  | { status: 'ok'; orphans: SweepOrphan[]; truncated: boolean; scanned: number };

export interface SweepInput {
  /** Extensions that exist in NetSapiens for this domain. **`null` means the read failed.** */
  nsExtensions: string[] | null;
  /** The Ringotel org's users. Org-wide, so it spans branches — hence the branchid filter below. */
  rtUsers: { id?: unknown; extension?: unknown; branchid?: unknown; status?: unknown; userid?: unknown }[];
  /** The branch bound to this NS domain. */
  branchid: string;
  /** Max extensions to deactivate in one run. */
  max: number;
}

/**
 * Decide which extensions are orphaned.
 *
 * ⚠️ **The two aborts are the load-bearing part.** A failed NS read and an empty NS user list are both
 * refused, because "could not read" and "nobody exists" are indistinguishable from the result alone — and
 * the difference between them is deactivating an entire domain's app users in a single pass. The same
 * reasoning already aborts the subscription reconcile on a failed listing. An NS domain with genuinely
 * zero users also has nothing to sync, so refusing it costs nothing real.
 */
export function planOrphanSweep(input: SweepInput): SweepPlan {
  if (input.nsExtensions === null) return { status: 'abort', reason: 'ns-list-unavailable' };
  if (input.nsExtensions.length === 0) return { status: 'abort', reason: 'ns-list-empty' };

  // Case-insensitive on purpose (fix-wave F2, 2026-07-31): an NS user "100a" and an operator-entered
  // Ringotel record "100A" are the same user by a spelling difference, not an orphan. Treating a
  // case-variant as known only ever SUPPRESSES a deactivation, which is the safe direction — it can never
  // cause one. This membership test only: `usersForExt` (shared with `resolveCanonical`/`dedupSiblings`)
  // is deliberately left case-sensitive, so this can never widen what a write actually matches.
  const known = new Set(input.nsExtensions.map((e) => String(e).trim().toLowerCase()).filter(Boolean));

  // Group by extension: deactivateAppOnly acts per extension and handles every record at it, so two
  // orphaned siblings are one unit of work, not two.
  const byExt = new Map<string, string[]>();
  let scanned = 0;
  for (const u of input.rtUsers) {
    if (String(u.branchid ?? '') !== input.branchid) continue;
    scanned++;
    // An ATTACHED SECONDARY (`userid` set) shares one app login with a primary on another connection.
    // Its seat is the primary's, so it is never independently orphaned — and deactivating it would
    // break a live user whose NS extension exists perfectly well. `status: 2` happens to fail the
    // `!== 1` test below too, but relying on that is relying on an accident: this guard states the
    // intent, so widening the status predicate later cannot silently start sweeping secondaries.
    if (u.userid != null) continue;
    if (Number(u.status) !== 1) continue; // already inactive — no seat to free
    if (u.id == null) continue; // nothing to address
    const ext = String(u.extension ?? '').trim();
    // Emit the ORIGINAL trimmed casing, not lowercased — deactivateAppOnly matches via `usersForExt`,
    // which is untouched by this fix and stays case-sensitive.
    if (!ext || known.has(ext.toLowerCase())) continue;
    byExt.set(ext, [...(byExt.get(ext) ?? []), String(u.id)]);
  }

  const all = [...byExt.entries()].map(([ext, rtUserIds]) => ({ ext, rtUserIds })).sort((a, z) => a.ext.localeCompare(z.ext));
  const orphans = all.slice(0, Math.max(0, input.max));
  return { status: 'ok', orphans, truncated: all.length > orphans.length, scanned };
}

/** One connection's slice of a domain sweep. */
export interface ConnectionSweep {
  branchid: string;
  plan: SweepPlan;
}

export interface DomainSweepInput {
  /** Domain-wide NS extensions. **`null` means the read failed** — every connection then aborts, because
   *  the list is the domain's, not the connection's. */
  nsExtensions: string[] | null;
  /** The org's users, org-wide (spans connections). */
  rtUsers: SweepInput['rtUsers'];
  /** Every connection bound to this domain. */
  branchids: string[];
  /** Max extensions to deactivate in one run, **shared across the whole domain**. */
  max: number;
}

/**
 * Plan a sweep for every connection bound to one domain.
 *
 * Two properties this exists to guarantee:
 *
 * 1. **The cap is per DOMAIN.** Handing each connection its own `max` would let a three-connection
 *    domain deactivate three times the intended blast radius from one unchanged configuration value.
 *    The budget is spent in order and the connection that exhausts it reports `truncated`.
 * 2. **A failed NS read aborts everything.** The extension list is domain-wide, so "could not read" is
 *    not a fact about one connection — sweeping the others on a list we could not fetch would be the
 *    same mistake the single-connection abort guard already refuses.
 *
 * An extension present in NetSapiens is not an orphan on ANY connection, so passing the same domain-wide
 * list to each connection is correct: a user sitting on the "wrong" connection is a misplacement, which
 * this must leave alone, not an orphan.
 */
export function planDomainSweep(input: DomainSweepInput): ConnectionSweep[] {
  let budget = Math.max(0, input.max);
  const out: ConnectionSweep[] = [];
  for (const branchid of input.branchids) {
    const plan = planOrphanSweep({ nsExtensions: input.nsExtensions, rtUsers: input.rtUsers, branchid, max: budget });
    out.push({ branchid, plan });
    if (plan.status === 'ok') budget -= plan.orphans.length;
  }
  return out;
}
