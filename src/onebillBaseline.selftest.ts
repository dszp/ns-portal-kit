/** Offline test for the OneBill baseline store (item-level acceptance). pnpm test:onebillbaseline */
import { acceptItems, clearGroup, clearItemKeyStatement, clearItems, readBaselines, writeGroupRow } from './onebillBaseline.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

interface Stmt { sql: string; args: unknown[] }

/**
 * `all()` now has to answer two different queries (group rows vs. item rows) rather than one fixed
 * row set, so route by SQL text: `billing_baseline_item` appears only in the item queries. A `\b`
 * word-boundary check after `billing_baseline` would NOT tell them apart - there is no boundary
 * between `baseline` and the `_item` suffix (both sides are word characters) - so this is a plain
 * substring test, not a regex trick.
 */
function fakeDb(groupRows: Record<string, unknown>[], itemRows: Record<string, unknown>[]) {
  const stmts: Stmt[] = [];
  let batchStmts: Stmt[] = [];
  const db = {
    prepare(sql: string) {
      // `bind` returns the statement object itself (not a separate wrapper) so that the array passed
      // to `batch()` carries the same `.sql`/`.args` a per-call assertion needs - a wrapper here would
      // make `batchStmts()` return opaque proxies instead of inspectable statements.
      const s = {
        sql, args: [] as unknown[],
        bind(...args: unknown[]) { s.args = args; stmts.push(s); return s; },
        all: async () => ({ results: sql.includes('billing_baseline_item') ? itemRows : groupRows }),
      };
      return s;
    },
    batch: async (list: unknown[]) => { batchStmts = list as Stmt[]; return list.map(() => ({ success: true })); },
  } as unknown as D1Database;
  return { db, stmts, batchStmts: () => batchStmts, batchSize: () => batchStmts.length };
}

// -- readBaselines -----------------------------------------------------------------------------------
{
  const groupRows = [
    { group_key: 'seats', billed: 10, observed: 12, accepted: 12, entitled: 2, note: 'two spares', decided_by: 'ops@example.com', decided_at: '2026-01-01T00:00:00.000Z' },
  ];
  const itemRows = [
    { group_key: 'numbers', item_key: 'n1', label: 'DID 555-0100', offer: null, note: null, decided_by: 'ops@example.com', decided_at: '2026-01-02T00:00:00.000Z' },
    { group_key: 'seats', item_key: 'a1', label: 'Alice', offer: 'Seat Tier One', note: 'confirmed', decided_by: 'ops@example.com', decided_at: '2026-01-01T00:00:00.000Z' },
    { group_key: 'seats', item_key: 'b2', label: 'Bob', offer: null, note: null, decided_by: 'ops@example.com', decided_at: '2026-01-01T00:00:00.000Z' },
  ];
  const { db, stmts } = fakeDb(groupRows, itemRows);
  const out = await readBaselines(db, 'CLI00001');
  ok(out.length === 2, 'two groups come back');
  ok(out[0]!.group === 'numbers' && out[1]!.group === 'seats', 'ordered by group key ("numbers" < "seats")');
  ok(out[0]!.items.length === 1 && out[0]!.groupRow === undefined, 'the group with no group row has none - not a fabricated one');
  ok(out[1]!.items.length === 2 && out[1]!.groupRow !== undefined, 'the other group has both its items and its group row');
  ok(out[1]!.items[0]!.key === 'a1' && out[1]!.items[1]!.key === 'b2', 'items ordered by item key, item_key maps to key');
  ok(out[1]!.items[0]!.note === 'confirmed', 'a note survives');
  ok(out[1]!.items[1]!.note === undefined, 'a NULL item note is absent, not the string "null"');
  ok(out[1]!.groupRow!.accepted === 12, 'group row fields survive');
  ok(out[1]!.items[0]!.offer === 'Seat Tier One', 'a tagged acceptance comes back with the offer it was billed as');
  ok(out[1]!.items[1]!.offer === undefined, 'and a NULL offer is absent, not the string "null"');
  ok(out[1]!.groupRow!.entitled === 2, 'the group row carries the entitlement it was judged against');
  ok(out[0]!.groupRow === undefined, 'a group with no group row has no entitlement to carry');
  ok(stmts[0]!.args[0] === 'CLI00001' && stmts[1]!.args[0] === 'CLI00001', 'the account number is bound on both queries, never interpolated');
  ok(!/CLI00001/.test(stmts[0]!.sql) && !/CLI00001/.test(stmts[1]!.sql), 'and neither SQL text carries the caller value');
}

// -- acceptItems -------------------------------------------------------------------------------------
{
  const { db, batchStmts, batchSize } = fakeDb([], []);
  const w = { accountNumber: 'CLI00001', group: 'seats', items: [{ key: 'a1', label: 'Alice' }, { key: 'b2', label: 'Bob' }], note: 'confirmed', offer: 'Seat Tier One', decidedBy: 'ops@example.com' };
  const out = await acceptItems(db, w, new Date('2026-09-03T12:00:00.000Z'));
  ok(batchSize() === 4, 'two items means two upserts plus two history rows, one batch');
  const [s0, s1, s2, s3] = batchStmts();
  ok(/INSERT INTO billing_baseline_item\b/.test(s0!.sql) && /ON CONFLICT/.test(s0!.sql), 'first statement upserts the current item row');
  ok(/INSERT INTO billing_baseline_item_history\b/.test(s1!.sql) && s1!.args.includes('accept'), 'second statement is history, action accept');
  ok(/INSERT INTO billing_baseline_item\b/.test(s2!.sql) && /INSERT INTO billing_baseline_item_history\b/.test(s3!.sql), 'and the second item follows the same pair');
  ok(s3!.args.includes('accept'), "the second item's history also carries accept");
  ok(out.length === 2 && out.every((a) => a.decidedAt === '2026-09-03T12:00:00.000Z'), 'returned acceptances carry the injected clock, not a caller claim');
  ok(out[0]!.note === 'confirmed', 'a note survives on the returned acceptance');
  ok(s0!.args[7] === 'Seat Tier One', 'the offer is the eighth binding on the item upsert');
  ok(s1!.args[8] === 'Seat Tier One', 'and the ninth on its history row');
  ok(out.every((a) => a.offer === 'Seat Tier One'), 'and rides back on every returned acceptance');
}
{
  // Untagged is the pre-0004 shape and stays writable: NULL in both tables, absent on the answer.
  const { db, batchStmts } = fakeDb([], []);
  const out = await acceptItems(db, { accountNumber: 'CLI00003', group: 'seats', items: [{ key: 'a1', label: 'Alice' }], decidedBy: 'ops@example.com' });
  ok(batchStmts()[0]!.args[7] === null, 'an untagged acceptance binds NULL for the offer');
  ok(out[0]!.offer === undefined, 'and carries no offer on the answer');
}
{
  const { db, batchStmts } = fakeDb([], []);
  await acceptItems(db, { accountNumber: 'CLI00002', group: 'numbers', items: [{ key: 'n9', label: 'DID' }], note: '   ', decidedBy: 'ops@example.com' });
  ok(batchStmts()[0]!.args.includes(null), 'a blank note is bound as NULL, not an empty string');
}

// -- clearItems --------------------------------------------------------------------------------------
{
  const { db, batchStmts, batchSize } = fakeDb([], []);
  const count = await clearItems(db, { accountNumber: 'CLI00001', group: 'seats', items: [{ key: 'a1', label: 'Alice' }, { key: 'b2', label: 'Bob' }], decidedBy: 'ops@example.com' }, new Date('2026-09-03T12:00:00.000Z'));
  ok(count === 2, 'clearItems returns the count cleared');
  ok(batchSize() === 4, 'two deletes plus two clear-history rows, one batch');
  const [s0, s1, s2, s3] = batchStmts();
  ok(/DELETE FROM billing_baseline_item\b/.test(s0!.sql) && /item_key = \?/.test(s0!.sql), 'first statement deletes the one item row (bound by item_key too)');
  ok(s1!.args[8] === null, 'a clear history row records no offer - the column is about what was accepted');
  ok(/INSERT INTO billing_baseline_item_history\b/.test(s1!.sql) && s1!.args.includes('clear'), 'history row for the first item is action clear');
  ok(/DELETE FROM billing_baseline_item\b/.test(s2!.sql) && /INSERT INTO billing_baseline_item_history\b/.test(s3!.sql) && s3!.args.includes('clear'), 'and the second item follows the same pair, also clear');
}

// -- writeGroupRow -----------------------------------------------------------------------------------
{
  const { db, batchStmts, batchSize } = fakeDb([], []);
  const gw = { accountNumber: 'CLI00001', group: 'seats', billed: 10, observed: 12, accepted: 12, entitled: 2, note: 'two spares', decidedBy: 'ops@example.com' };
  const row = await writeGroupRow(db, gw, new Date('2026-09-03T12:00:00.000Z'));
  ok(batchSize() === 2, 'the group upsert and its history go in one batch');
  const [s0, s1] = batchStmts();
  ok(/INSERT INTO billing_baseline\b/.test(s0!.sql) && !/billing_baseline_item/.test(s0!.sql) && /ON CONFLICT/.test(s0!.sql), 'first statement upserts the group row');
  ok(/INSERT INTO billing_baseline_history\b/.test(s1!.sql) && /\baction\b/.test(s1!.sql) && s1!.args.includes('accept'), 'history statement includes the action column, bound to accept');
  ok(row.accepted === 12 && row.decidedAt === '2026-09-03T12:00:00.000Z', 'the returned group acceptance carries the injected clock');
  ok(s0!.args[8] === 2, 'the entitlement is the ninth binding on the group upsert');
  ok(s1!.args[8] === 2 && s1!.args[9] === 'accept', 'and sits before the action on the history row');
  ok(row.entitled === 2, 'and rides back on the returned acceptance');
}
{
  // Not recorded is NOT zero: 0 entitled is a judgement, and writing it for a caller that said nothing
  // would invalidate the decision the first time an entitlement appeared on the row.
  const { db, batchStmts } = fakeDb([], []);
  const row = await writeGroupRow(db, { accountNumber: 'CLI00004', group: 'seats', billed: 10, observed: 10, accepted: 10, decidedBy: 'ops@example.com' });
  ok(batchStmts()[0]!.args[8] === null, 'an unrecorded entitlement binds NULL, not 0');
  ok(row.entitled === undefined, 'and is absent on the answer');
}

// -- clearGroup --------------------------------------------------------------------------------------
{
  const groupRows = [
    { group_key: 'seats', billed: 10, observed: 12, accepted: 12, entitled: 2, note: 'two spares', decided_by: 'ops@example.com', decided_at: '2026-01-01T00:00:00.000Z' },
  ];
  const itemRows = [
    { group_key: 'seats', item_key: 'a1', label: 'Alice', offer: null, note: null, decided_by: 'ops@example.com', decided_at: '2026-01-01T00:00:00.000Z' },
    { group_key: 'seats', item_key: 'b2', label: 'Bob', offer: null, note: 'confirmed', decided_by: 'ops@example.com', decided_at: '2026-01-01T00:00:00.000Z' },
  ];
  const { db, batchStmts, batchSize } = fakeDb(groupRows, itemRows);
  const result = await clearGroup(db, 'CLI00001', 'seats', 'ops@example.com', new Date('2026-09-03T12:00:00.000Z'));
  ok(result.items === 2 && result.groupRow === true, 'reports two items cleared and that a group row existed');
  ok(batchSize() === 5, 'one batch: delete-items, delete-group, one history row per item, one group history row');
  const stmts = batchStmts();
  ok(/DELETE FROM billing_baseline_item\b/.test(stmts[0]!.sql) && stmts[0]!.args.length === 2, 'first statement deletes every item in the group (account + group only, no item_key)');
  ok(/DELETE FROM billing_baseline\b/.test(stmts[1]!.sql) && !/billing_baseline_item/.test(stmts[1]!.sql), 'second statement deletes the group row');
  ok(/INSERT INTO billing_baseline_item_history\b/.test(stmts[2]!.sql) && stmts[2]!.args.includes('clear'), 'a clear-history row for the first current item');
  ok(/INSERT INTO billing_baseline_item_history\b/.test(stmts[3]!.sql) && stmts[3]!.args.includes('clear'), 'and for the second current item');
  ok(/INSERT INTO billing_baseline_history\b/.test(stmts[4]!.sql) && stmts[4]!.args.includes('clear'), 'and one clear-history row for the group row that existed');
  ok(stmts[4]!.args[8] === 2, 'which records the entitlement the cleared decision was judged against');
}
{
  // No group row on record: clearGroup still clears the items and reports groupRow: false.
  const itemRows = [
    { group_key: 'numbers', item_key: 'n1', label: 'DID', offer: null, note: null, decided_by: 'ops@example.com', decided_at: '2026-01-02T00:00:00.000Z' },
  ];
  const { db, batchSize } = fakeDb([], itemRows);
  const result = await clearGroup(db, 'CLI00002', 'numbers', 'ops@example.com', new Date('2026-09-03T12:00:00.000Z'));
  ok(result.items === 1 && result.groupRow === false, 'no group row existed, so groupRow is false');
  ok(batchSize() === 3, 'delete-items, delete-group, one item history row - no group history row');
}

// -- clearItemKeyStatement ---------------------------------------------------------------------------
{
  // The one statement in this module that is NOT derived from a read: it names an account and an item
  // key and no group, so it is true of whatever the table holds when the batch runs. That is the whole
  // point — a reassignment cannot leave an acceptance behind that arrived after its read.
  const { db, stmts } = fakeDb([], []);
  const st = clearItemKeyStatement(db, 'CLI00001', 'acme.example/ext:100') as unknown as Stmt;
  ok(/^DELETE FROM billing_baseline_item\b/.test(st.sql), 'it deletes from the item table');
  ok(st.sql.includes('account_number = ?') && st.sql.includes('item_key = ?'), 'bounded to one account and one item key');
  ok(!st.sql.includes('group_key'), 'and to NO group - every group at once is the point');
  ok(JSON.stringify(st.args) === JSON.stringify(['CLI00001', 'acme.example/ext:100']), 'with both values bound, never interpolated');
  ok(stmts.length === 1, 'and it is one statement, for a caller to put in its own batch');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
