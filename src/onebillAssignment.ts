/**
 * The manual item→account assignment store (migrations 0003, 0005).
 *
 * The second and last module that touches `env.ONEBILL_DB`. Keyed by DOMAIN, BARE ITEM KEY and
 * ACCOUNT: an assignment says that this item bills to that account.
 *
 * ## Why the account is in the key
 *
 * An E911 address is a fact about a PLACE, and a place can be billed by more than one account (see
 * `onebillScope.ts`), so its manual half is a SET and a per-account remove has to name one row. Every
 * other kind still holds at most one row per item — that is the ROUTE's rule now, not the schema's:
 * an assign on a non-address key clears the existing row in the same batch, exactly as the old upsert
 * did. This module writes what it is told and enforces neither rule.
 *
 * Only STATEMENT BUILDERS write, because the one write that matters — a reassignment — has to remove
 * the item's acceptance on the account it leaves in the SAME batch, and that acceptance lives in
 * `onebillBaseline.ts`. The caller (`onebillAccount.applyAssignment`) composes the two modules'
 * statements into one `db.batch()`; neither module knows about the other.
 */
export interface Assignment { domain: string; key: string; accountNumber: string; label: string; note?: string; decidedBy: string; decidedAt: string }

const SELECT = `SELECT item_key, account_number, label, note, decided_by, decided_at FROM billing_item_assignment WHERE domain = ? ORDER BY item_key, account_number`;
const UPSERT = `INSERT INTO billing_item_assignment (domain, item_key, account_number, label, note, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (domain, item_key, account_number) DO UPDATE SET label = excluded.label, note = excluded.note, decided_by = excluded.decided_by, decided_at = excluded.decided_at`;
const HISTORY = `INSERT INTO billing_item_assignment_history (domain, item_key, account_number, label, action, note, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE = `DELETE FROM billing_item_assignment WHERE domain = ? AND item_key = ? AND account_number = ?`;
const DELETE_OTHERS = `DELETE FROM billing_item_assignment WHERE domain = ? AND item_key = ? AND account_number <> ?`;

const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const noteOf = (v: unknown): { note?: string } => (typeof v === 'string' && v.trim() !== '' ? { note: v } : {});
const cleanNote = (n: string | undefined): string | null => (n !== undefined && n.trim() !== '' ? n.trim() : null);

/**
 * Every assignment on this domain. An ADDRESS may have several rows (one per holding account); every
 * other kind has at most one, which the route rather than the schema is what keeps true.
 */
export async function readAssignments(db: D1Database, domain: string): Promise<Assignment[]> {
  const r = await db.prepare(SELECT).bind(domain).all<Record<string, unknown>>();
  return (r.results ?? []).map((row) => ({ domain, key: text(row.item_key), accountNumber: text(row.account_number), label: text(row.label), ...noteOf(row.note), decidedBy: text(row.decided_by), decidedAt: text(row.decided_at) }));
}

export function assignStatements(db: D1Database, w: { domain: string; key: string; accountNumber: string; label: string; note?: string; decidedBy: string }, now: Date): D1PreparedStatement[] {
  const at = now.toISOString(), note = cleanNote(w.note);
  return [
    db.prepare(UPSERT).bind(w.domain, w.key, w.accountNumber, w.label, note, w.decidedBy, at),
    db.prepare(HISTORY).bind(w.domain, w.key, w.accountNumber, w.label, 'assign', note, w.decidedBy, at),
  ];
}

/**
 * Every OTHER account's row on this item, gone — the one-row rule for a non-address, enforced by the
 * write instead of by a key the schema no longer has.
 *
 * UNCONDITIONAL, and that is the point. Deriving the delete from the rows a read just returned means a
 * row written between the read and the batch survives, and so does one the read's own filter missed;
 * this statement is true of whatever is actually in the table when it runs. It carries no history of
 * its own for the same reason — it does not know what it deleted. The caller writes a history row per
 * account it READ, which is the honest record of what it believed it was undoing.
 */
export function clearOtherAssignmentsStatement(db: D1Database, w: { domain: string; key: string; accountNumber: string }): D1PreparedStatement {
  return db.prepare(DELETE_OTHERS).bind(w.domain, w.key, w.accountNumber);
}

/**
 * One history row on its own, for a delete that happened without one.
 *
 * Paired with {@link clearOtherAssignmentsStatement}: the delete is unconditional and anonymous, the
 * history is per account and named, and together they say "these are the accounts I meant to remove"
 * without pretending the statement was conditional on them.
 */
export function assignmentHistoryStatement(db: D1Database, w: { domain: string; key: string; accountNumber: string | null; label: string; action: 'assign' | 'clear'; note?: string; decidedBy: string }, now: Date): D1PreparedStatement {
  return db.prepare(HISTORY).bind(w.domain, w.key, w.accountNumber, w.label, w.action, cleanNote(w.note), w.decidedBy, now.toISOString());
}

/**
 * Take ONE account's assignment away, and say why in the same breath.
 *
 * `accountNumber` names the row to delete, because an address can carry several and taking them all
 * away is a different decision from removing one holder. The history row records that account too —
 * a `clear` that named nobody could not say which of three placements had just been undone.
 *
 * The history row keeps the caller's `note` for the same reason an assign's does: handing an item back
 * to the automatic rule is a decision, and "why did this move back?" is the question the record has to
 * answer later. The current row is deleted outright — the history IS the trail.
 */
export function clearAssignmentStatements(db: D1Database, w: { domain: string; key: string; accountNumber: string; label: string; note?: string; decidedBy: string }, now: Date): D1PreparedStatement[] {
  const at = now.toISOString(), note = cleanNote(w.note);
  return [
    db.prepare(DELETE).bind(w.domain, w.key, w.accountNumber),
    db.prepare(HISTORY).bind(w.domain, w.key, w.accountNumber, w.label, 'clear', note, w.decidedBy, at),
  ];
}
