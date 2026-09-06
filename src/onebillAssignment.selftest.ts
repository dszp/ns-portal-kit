/** Offline test for the assignment store. pnpm test:onebillassignment */
import { readAssignments, assignStatements, clearAssignmentStatements } from './onebillAssignment.js';
import { fakeD1 } from './testkit/fakeD1.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };
const NOW = new Date('2026-09-05T10:00:00.000Z');

{
  const f = fakeD1();
  await f.db.batch(assignStatements(f.db, { domain: 'acme.example', key: 'ext:100', accountNumber: 'CLI00002', label: '100 — Ann Lee, North', note: 'billed to the branch', decidedBy: 'boss@acme.example' }, NOW));
  const rows = await readAssignments(f.db, 'acme.example');
  ok(rows.length === 1 && rows[0]!.key === 'ext:100' && rows[0]!.accountNumber === 'CLI00002', 'an assignment reads back under its domain');
  ok(rows[0]!.note === 'billed to the branch' && rows[0]!.decidedBy === 'boss@acme.example' && rows[0]!.decidedAt === NOW.toISOString(), 'with note, principal and the server stamp');
  ok(f.history.filter((h) => h.table === 'billing_item_assignment_history').length === 1, 'one history row per assign');
  ok(f.batches.length === 1 && f.batches[0]!.length === 2, 'upsert and history travel in one batch');
  ok((await readAssignments(f.db, 'other.example')).length === 0, 'another domain sees nothing');

  // The SAME account again: the upsert is on the triple, so this replaces one row rather than adding one.
  await f.db.batch(assignStatements(f.db, { domain: 'acme.example', key: 'ext:100', accountNumber: 'CLI00002', label: '100 — Ann Lee, North', decidedBy: 'boss@acme.example' }, NOW));
  const re = await readAssignments(f.db, 'acme.example');
  ok(re.length === 1 && re[0]!.accountNumber === 'CLI00002' && re[0]!.note === undefined, 'a second assign to the same account upserts and drops the old note');

  // ── an ADDRESS holds one row per holding account (migration 0005) ────────────────────────────
  // The store does not know an address from an extension: it writes what it is told, and the ROUTE is
  // what keeps a non-address at one row. What the widened key buys is that a second account CAN be
  // added, and that removing one names which.
  await f.db.batch(assignStatements(f.db, { domain: 'acme.example', key: 'addr:a-1', accountNumber: 'CLI00002', label: 'Shared dock', decidedBy: 'boss@acme.example' }, NOW));
  await f.db.batch(assignStatements(f.db, { domain: 'acme.example', key: 'addr:a-1', accountNumber: 'CLI00003', label: 'Shared dock', decidedBy: 'boss@acme.example' }, NOW));
  const both = (await readAssignments(f.db, 'acme.example')).filter((a) => a.key === 'addr:a-1');
  ok(both.length === 2 && both.map((a) => a.accountNumber).join() === 'CLI00002,CLI00003', 'two accounts hold one address, read back in account order');
  await f.db.batch(clearAssignmentStatements(f.db, { domain: 'acme.example', key: 'addr:a-1', accountNumber: 'CLI00002', label: 'Shared dock', decidedBy: 'boss@acme.example' }, NOW));
  const left = (await readAssignments(f.db, 'acme.example')).filter((a) => a.key === 'addr:a-1');
  ok(left.length === 1 && left[0]!.accountNumber === 'CLI00003', 'a clear removes ONE account\'s row and leaves the other standing');
  await f.db.batch(clearAssignmentStatements(f.db, { domain: 'acme.example', key: 'addr:a-1', accountNumber: 'CLI00003', label: 'Shared dock', decidedBy: 'boss@acme.example' }, NOW));

  await f.db.batch(clearAssignmentStatements(f.db, { domain: 'acme.example', key: 'ext:100', accountNumber: 'CLI00002', label: '100 — Ann Lee, North', note: 'moved back, the branch never billed it', decidedBy: 'boss@acme.example' }, NOW));
  ok((await readAssignments(f.db, 'acme.example')).length === 0, 'a clear removes the row');
  const last = f.history[f.history.length - 1]!;
  // The account the item LEFT, not NULL. With a set of placements, "cleared" that names nobody cannot
  // say which of them was undone — and that is the whole question a reader brings to this table.
  ok(last.table === 'billing_item_assignment_history' && last.args.includes('clear') && last.args[2] === 'CLI00002', 'and records a clear naming the account it left');
  // Handing an item back to the automatic rule is a decision, and the note is the only place the
  // reason survives: the current row is gone, so history is the whole trail.
  ok(last.args[5] === 'moved back, the branch never billed it', "and keeps the operator's reason for taking the assignment away");
  await f.db.batch(clearAssignmentStatements(f.db, { domain: 'acme.example', key: 'ext:101', accountNumber: 'CLI00002', label: '101', decidedBy: 'boss@acme.example' }, NOW));
  ok(f.history[f.history.length - 1]!.args[5] === null, 'a clear with no note stores NULL, never the string "null"');
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
