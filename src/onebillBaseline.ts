/**
 * The baseline store: which billing-vs-inventory gaps an operator has looked at and declared normal.
 *
 * One of two modules in this Worker that touch `env.ONEBILL_DB` — the other is `onebillAssignment.ts`;
 * everything else takes the rows as data, which is what keeps the binding genuinely optional — an
 * unbound database is one `if` in the route, not a condition threaded through the report assembly.
 *
 * Keyed by OneBill account, never by domain: see the comment in migrations/0001_billing_baseline.sql.
 *
 * Two tables carry the decision (migration 0002): `billing_baseline_item` holds one row per accepted
 * item — a seat, a DID, a device — and `billing_baseline` narrows to the GROUP ROW: written when a
 * group is fully accepted as a whole, or to accept a shortfall or an item-less dimension where there is
 * nothing to enumerate. An accepted COUNT against unknown items is not the same fact as naming which
 * items were reviewed, so 0002 deletes the old count-model rows outright rather than migrating them —
 * dev-only data at the time of that migration. Every write, item or group, is one `db.batch()` covering
 * the current-state change and its history row together; history is append-only, and a `clear` is
 * recorded there too (`action = 'clear'`), never a silent delete with no trace.
 */
import type { GroupAcceptance, GroupBaseline, ItemAcceptance } from '@dszp/onebill-lib';

/** What the caller asks to accept or clear for one group's items. `decidedAt` is NOT here — the server stamps it. */
export interface ItemWrite {
  accountNumber: string;
  group: string;
  items: Array<{ key: string; label: string }>;
  note?: string;
  /**
   * Which of the row's offers the operator billed these items as. Validated against
   * `row.offers[].name` by `applyBaselineAction` before it reaches here — the store records the
   * decision, it does not adjudicate it. Absent is untagged, which every pre-0004 acceptance is.
   */
  offer?: string;
  /** The principal from the caller's ns_t. Never a client-supplied string. */
  decidedBy: string;
}

/** What the caller asks to accept for one group's whole-group row (a shortfall, or a dimension with no items). */
export interface GroupRowWrite {
  accountNumber: string;
  group: string;
  billed: number;
  observed: number;
  accepted: number;
  /**
   * The row's entitlement when the decision was made — the other half of `billed`. An entitlement
   * that later goes away invalidates the decision, and onebill-lib reads a recorded one for exactly
   * that. Absent means "not recorded", which keeps a pre-0004 row on the pre-entitlement behaviour.
   */
  entitled?: number;
  note?: string;
  decidedBy: string;
}

const SELECT_GROUPS = `SELECT group_key, billed, observed, accepted, entitled, note, decided_by, decided_at FROM billing_baseline WHERE account_number = ? ORDER BY group_key`;
const SELECT_ITEMS = `SELECT group_key, item_key, label, offer, note, decided_by, decided_at FROM billing_baseline_item WHERE account_number = ? ORDER BY group_key, item_key`;
const UPSERT_GROUP = `INSERT INTO billing_baseline (account_number, group_key, billed, observed, accepted, note, decided_by, decided_at, entitled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (account_number, group_key) DO UPDATE SET billed = excluded.billed, observed = excluded.observed, accepted = excluded.accepted, note = excluded.note, decided_by = excluded.decided_by, decided_at = excluded.decided_at, entitled = excluded.entitled`;
const HISTORY_GROUP = `INSERT INTO billing_baseline_history (account_number, group_key, billed, observed, accepted, note, decided_by, decided_at, entitled, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE_GROUP = `DELETE FROM billing_baseline WHERE account_number = ? AND group_key = ?`;
const UPSERT_ITEM = `INSERT INTO billing_baseline_item (account_number, group_key, item_key, label, note, decided_by, decided_at, offer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (account_number, group_key, item_key) DO UPDATE SET label = excluded.label, note = excluded.note, decided_by = excluded.decided_by, decided_at = excluded.decided_at, offer = excluded.offer`;
const HISTORY_ITEM = `INSERT INTO billing_baseline_item_history (account_number, group_key, item_key, label, action, note, decided_by, decided_at, offer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE_ITEM = `DELETE FROM billing_baseline_item WHERE account_number = ? AND group_key = ? AND item_key = ?`;
const DELETE_ITEMS_IN_GROUP = `DELETE FROM billing_baseline_item WHERE account_number = ? AND group_key = ?`;
const DELETE_ITEM_KEY = `DELETE FROM billing_baseline_item WHERE account_number = ? AND item_key = ?`;

const int = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
// A NULL note must not become the string "null": the page renders any present note, and "null" in an
// operator's face reads as data corruption.
const noteOf = (v: unknown): { note?: string } => (typeof v === 'string' && v.trim() !== '' ? { note: v } : {});
/** Same rule as {@link noteOf} for the offer an acceptance was tagged with. NULL and '' are untagged. */
const offerOf = (v: unknown): { offer?: string } => (typeof v === 'string' && v.trim() !== '' ? { offer: v } : {});
/** A recorded entitlement, or nothing. 0 IS a recorded entitlement — only NULL means "not recorded". */
const entitledOf = (v: unknown): { entitled?: number } => (v == null ? {} : { entitled: int(v) });
const trimmedOrNull = (n: string | undefined): string | null => (n !== undefined && n.trim() !== '' ? n.trim() : null);

/** Every accepted baseline for one account — group rows and their items, merged. An account with none answers an empty array. */
export async function readBaselines(db: D1Database, accountNumber: string): Promise<GroupBaseline[]> {
  const [g, i] = await Promise.all([
    db.prepare(SELECT_GROUPS).bind(accountNumber).all<Record<string, unknown>>(),
    db.prepare(SELECT_ITEMS).bind(accountNumber).all<Record<string, unknown>>(),
  ]);
  const out = new Map<string, GroupBaseline>();
  const at = (group: string): GroupBaseline => { let b = out.get(group); if (!b) { b = { group, items: [] }; out.set(group, b); } return b; };
  for (const r of g.results ?? []) {
    at(text(r.group_key)).groupRow = { billed: int(r.billed), observed: int(r.observed), accepted: int(r.accepted), ...entitledOf(r.entitled), ...noteOf(r.note), decidedBy: text(r.decided_by), decidedAt: text(r.decided_at) };
  }
  for (const r of i.results ?? []) {
    at(text(r.group_key)).items.push({ key: text(r.item_key), label: text(r.label), ...offerOf(r.offer), ...noteOf(r.note), decidedBy: text(r.decided_by), decidedAt: text(r.decided_at) });
  }
  return [...out.values()].sort((a, b) => a.group.localeCompare(b.group));
}

/**
 * Accept a set of items for one group and append their history rows **in one batch**.
 *
 * Separate calls could leave a current row with no history behind it, or history describing a decision
 * the current row does not reflect — and both read as a lie to whoever opens the record later.
 */
export async function acceptItems(db: D1Database, w: ItemWrite, now: Date = new Date()): Promise<ItemAcceptance[]> {
  const decidedAt = now.toISOString(), note = trimmedOrNull(w.note), offer = trimmedOrNull(w.offer);
  const stmts = w.items.flatMap((it) => [
    db.prepare(UPSERT_ITEM).bind(w.accountNumber, w.group, it.key, it.label, note, w.decidedBy, decidedAt, offer),
    db.prepare(HISTORY_ITEM).bind(w.accountNumber, w.group, it.key, it.label, 'accept', note, w.decidedBy, decidedAt, offer),
  ]);
  if (stmts.length) await db.batch(stmts);
  return w.items.map((it) => ({ key: it.key, label: it.label, ...(offer === null ? {} : { offer }), ...(note === null ? {} : { note }), decidedBy: w.decidedBy, decidedAt }));
}

/** The statements `clearItems` batches, exposed so a reassignment can run them inside ITS batch. */
export function clearItemStatements(db: D1Database, w: Omit<ItemWrite, 'note'>, now: Date): D1PreparedStatement[] {
  const decidedAt = now.toISOString();
  return w.items.flatMap((it) => [
    db.prepare(DELETE_ITEM).bind(w.accountNumber, w.group, it.key),
    db.prepare(HISTORY_ITEM).bind(w.accountNumber, w.group, it.key, it.label, 'clear', null, w.decidedBy, decidedAt, null),
  ]);
}
/**
 * Every acceptance of ONE item key on one account, in every group, in one statement.
 *
 * Exposed as a statement for the same reason `clearItemStatements` is — a reassignment runs it inside
 * its own batch — but it is a different KIND of claim, and the difference is the point. The others say
 * "delete the rows a read just told me about"; this one says "whatever is in the table for this key on
 * this account, it is not accepted here any more", which is true of the table as the batch finds it
 * rather than as a read a moment earlier believed. That is what closes the window in which an accept
 * lands on an account between the read and the write and outlives the item leaving it.
 *
 * It writes NO history: it cannot say what it removed. History stays derived from the read, and the
 * two are deliberately not the same claim — see the call site in `onebillAccount.ts`.
 */
export function clearItemKeyStatement(db: D1Database, accountNumber: string, itemKey: string): D1PreparedStatement {
  return db.prepare(DELETE_ITEM_KEY).bind(accountNumber, itemKey);
}

/** Remove a set of items and record a `clear` history row for each — the record of what stopped being accepted, not just its absence. */
export async function clearItems(db: D1Database, w: Omit<ItemWrite, 'note'>, now: Date = new Date()): Promise<number> {
  const stmts = clearItemStatements(db, w, now);
  if (stmts.length) await db.batch(stmts);
  return w.items.length;
}

/** Accept the whole-group row (a shortfall, or a dimension with no items to enumerate) — upsert plus history, one batch. */
export async function writeGroupRow(db: D1Database, w: GroupRowWrite, now: Date = new Date()): Promise<GroupAcceptance> {
  const decidedAt = now.toISOString(), note = trimmedOrNull(w.note);
  // NULL, not 0, when the caller records none: 0 entitled is a real judgement ("nothing entitles this
  // row"), and writing it for a caller that simply did not say would invalidate the decision the first
  // time an entitlement appeared.
  const entitled = w.entitled === undefined ? null : Math.trunc(w.entitled);
  const args = [w.accountNumber, w.group, Math.trunc(w.billed), Math.trunc(w.observed), Math.trunc(w.accepted), note, w.decidedBy, decidedAt, entitled];
  await db.batch([db.prepare(UPSERT_GROUP).bind(...args), db.prepare(HISTORY_GROUP).bind(...args, 'accept')]);
  return { billed: Math.trunc(w.billed), observed: Math.trunc(w.observed), accepted: Math.trunc(w.accepted), ...(entitled === null ? {} : { entitled }), ...(note === null ? {} : { note }), decidedBy: w.decidedBy, decidedAt };
}

/** Everything recorded for one group, gone in one batch, with a `clear` history row for each thing removed. */
export async function clearGroup(db: D1Database, accountNumber: string, group: string, decidedBy: string, now: Date = new Date()): Promise<{ items: number; groupRow: boolean }> {
  const decidedAt = now.toISOString();
  const current = (await readBaselines(db, accountNumber)).find((b) => b.group === group);
  const items = current?.items ?? [];
  const G = current?.groupRow;
  const stmts = [
    db.prepare(DELETE_ITEMS_IN_GROUP).bind(accountNumber, group),
    db.prepare(DELETE_GROUP).bind(accountNumber, group),
    ...items.map((it) => db.prepare(HISTORY_ITEM).bind(accountNumber, group, it.key, it.label, 'clear', null, decidedBy, decidedAt, null)),
    ...(G ? [db.prepare(HISTORY_GROUP).bind(accountNumber, group, G.billed, G.observed, G.accepted, null, decidedBy, decidedAt, G.entitled ?? null, 'clear')] : []),
  ];
  await db.batch(stmts);
  return { items: items.length, groupRow: Boolean(G) };
}
