/**
 * A stateful in-memory stand-in for the `ONEBILL_DB` binding, for the offline selftests.
 *
 * `onebillBaseline.selftest.ts` has a *stateless* fake: it answers a fixed row set and records the
 * statements, which is exactly right for asserting "this write is one batch of these bindings". It
 * cannot answer the question this one exists for — **write, then read back what you wrote** — which
 * is the whole of `applyBaselineAction`'s behaviour and of the route tests over it.
 *
 * ## It understands SQL only as far as `onebillBaseline.ts` speaks it
 *
 * This is not a SQL engine and must not grow into one. Statements are routed by table name and verb,
 * and the bound arguments are read positionally in the order that module binds them. A new statement
 * shape there needs a case here; a wrong guess shows up as a selftest that disagrees with D1, which
 * is the failure mode to prefer over a fake that quietly accepts anything.
 *
 * Table routing is by plain substring, and ORDER MATTERS: `billing_baseline_item_history` contains
 * both `billing_baseline_item` and `billing_baseline`, so the history tables are matched first. A
 * `\b` word boundary would not separate them — there is none between `baseline` and `_item`.
 *
 * ## History is recorded and never read
 *
 * `readBaselines` reads only the two current-state tables, so the history rows are kept as an
 * append-only list a test can assert over rather than being indexed. That mirrors the real schema,
 * where history exists to be audited and never to be queried by the report.
 */

/** One row of `billing_baseline` — column names, so a test seeds what D1 would hold. */
export interface FakeGroupRow {
  account_number: string;
  group_key: string;
  billed: number;
  observed: number;
  accepted: number;
  /** Migration 0004. NULL is "not recorded", which is not the same fact as a recorded 0. */
  entitled: number | null;
  note: string | null;
  decided_by: string;
  decided_at: string;
}

/** One row of `billing_baseline_item`. */
export interface FakeItemRow {
  account_number: string;
  group_key: string;
  item_key: string;
  label: string;
  /** Migration 0004. NULL is untagged, which every pre-0004 acceptance is. */
  offer: string | null;
  note: string | null;
  decided_by: string;
  decided_at: string;
}

/** One row of `billing_item_assignment` (migrations 0003, 0005). */
export interface FakeAssignmentRow {
  domain: string;
  item_key: string;
  account_number: string;
  label: string;
  note: string | null;
  decided_by: string;
  decided_at: string;
}

/** One append-only history row, kept as the raw bindings under the table it was written to. */
export interface FakeHistoryRow {
  table: 'billing_baseline_history' | 'billing_baseline_item_history' | 'billing_item_assignment_history';
  args: unknown[];
}

/** A statement as it was executed: the SQL text and the values bound to it. */
export interface FakeStatement { sql: string; args: unknown[] }

export interface FakeD1 {
  /** Pass this where a `D1Database` is wanted. */
  db: D1Database;
  /** Current group rows, keyed by {@link groupRowKey}. */
  groups: Map<string, FakeGroupRow>;
  /** Current item rows, keyed by {@link itemRowKey}. */
  items: Map<string, FakeItemRow>;
  /** Current assignment rows, keyed by {@link assignmentRowKey}. */
  assignments: Map<string, FakeAssignmentRow>;
  history: FakeHistoryRow[];
  /** Every statement executed, in order — reads and writes alike. */
  statements: FakeStatement[];
  /** One entry per `db.batch()` call, holding the statements it carried. `batches.length` is the call count. */
  batches: FakeStatement[][];
}

/** Joins the key columns with NUL, which no account number, group name or item key contains. */
const SEP = '\u0000';

/** The composite key {@link FakeD1.groups} is keyed by. */
export const groupRowKey = (accountNumber: string, group: string): string => `${accountNumber}${SEP}${group}`;
/** The composite key {@link FakeD1.items} is keyed by. */
export const itemRowKey = (accountNumber: string, group: string, itemKey: string): string => `${accountNumber}${SEP}${group}${SEP}${itemKey}`;
/** The composite key {@link FakeD1.assignments} is keyed by — the PK migration 0005 widened, account
 *  included, because an address holds one row per holding account. */
export const assignmentRowKey = (domain: string, itemKey: string, accountNumber: string): string => `${domain}${SEP}${itemKey}${SEP}${accountNumber}`;

type Table = 'group' | 'item' | 'groupHistory' | 'itemHistory' | 'assignment' | 'assignHistory';

function tableOf(sql: string): Table {
  // Checked first: unrelated to the `billing_baseline*` family, but the same "history first" rule
  // that separates `billing_baseline_item_history` from `billing_baseline_item` applies here too —
  // `billing_item_assignment_history` contains `billing_item_assignment`.
  if (sql.includes('billing_item_assignment_history')) return 'assignHistory';
  if (sql.includes('billing_item_assignment')) return 'assignment';
  if (sql.includes('billing_baseline_item_history')) return 'itemHistory';
  if (sql.includes('billing_baseline_history')) return 'groupHistory';
  if (sql.includes('billing_baseline_item')) return 'item';
  return 'group';
}

const s = (v: unknown): string => String(v ?? '');
const int = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? Math.trunc(x) : 0; };
const nullable = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * A fake D1 that remembers what it was told.
 *
 * Seed with the rows an account already has; omit both for an empty database.
 */
export function fakeD1(seed: { groups?: readonly FakeGroupRow[]; items?: readonly FakeItemRow[]; assignments?: readonly FakeAssignmentRow[] } = {}): FakeD1 {
  const groups = new Map<string, FakeGroupRow>();
  const items = new Map<string, FakeItemRow>();
  const assignments = new Map<string, FakeAssignmentRow>();
  const history: FakeHistoryRow[] = [];
  const statements: FakeStatement[] = [];
  const batches: FakeStatement[][] = [];
  for (const g of seed.groups ?? []) groups.set(groupRowKey(g.account_number, g.group_key), { ...g });
  for (const i of seed.items ?? []) items.set(itemRowKey(i.account_number, i.group_key, i.item_key), { ...i });
  for (const a of seed.assignments ?? []) assignments.set(assignmentRowKey(a.domain, a.item_key, a.account_number), { ...a });

  /** Execute one bound statement and return the rows it selected (empty for a write). */
  function exec(stmt: FakeStatement): Record<string, unknown>[] {
    statements.push({ sql: stmt.sql, args: [...stmt.args] });
    const { sql, args } = stmt;
    const table = tableOf(sql);

    if (table === 'itemHistory' || table === 'groupHistory' || table === 'assignHistory') {
      const historyTable = table === 'itemHistory' ? 'billing_baseline_item_history' : table === 'groupHistory' ? 'billing_baseline_history' : 'billing_item_assignment_history';
      history.push({ table: historyTable, args: [...args] });
      return [];
    }

    if (/^\s*SELECT\b/i.test(sql)) {
      if (table === 'assignment') {
        const domain = s(args[0]);
        return [...assignments.values()].filter((r) => r.domain === domain)
          .sort((a, b) => a.item_key.localeCompare(b.item_key) || a.account_number.localeCompare(b.account_number))
          .map((r) => ({ item_key: r.item_key, account_number: r.account_number, label: r.label, note: r.note, decided_by: r.decided_by, decided_at: r.decided_at }));
      }
      const account = s(args[0]);
      if (table === 'item') {
        return [...items.values()].filter((r) => r.account_number === account)
          .sort((a, b) => a.group_key.localeCompare(b.group_key) || a.item_key.localeCompare(b.item_key))
          .map((r) => ({ ...r }));
      }
      return [...groups.values()].filter((r) => r.account_number === account)
        .sort((a, b) => a.group_key.localeCompare(b.group_key))
        .map((r) => ({ ...r }));
    }

    if (/^\s*DELETE\b/i.test(sql)) {
      if (table === 'assignment') {
        // TWO shapes since migration 0005, told apart by the operator in the SQL — `= ?` deletes the one
        // named account's row, `<> ?` deletes every OTHER account's on the same item, which is how a
        // non-address assign holds itself to one row without a key that says so. Reading the bindings
        // alone could not distinguish them, and guessing would make the fake agree with itself.
        const [domain, itemKey, account] = [s(args[0]), s(args[1]), s(args[2])];
        const others = /account_number\s*<>/.test(sql);
        for (const [k, r] of assignments) {
          if (r.domain !== domain || r.item_key !== itemKey) continue;
          if (others ? r.account_number === account : r.account_number !== account) continue;
          assignments.delete(k);
        }
        return [];
      }
      const account = s(args[0]);
      if (table === 'item') {
        // THREE shapes share this table, told apart by the SQL and not by the binding count — two of
        // them bind two values. `group_key` in the WHERE means the bindings are (account, group) and
        // optionally an item; WITHOUT it they are (account, item_key) and the delete crosses every
        // group, which is how a reassignment clears an acceptance it never read.
        const byGroup = sql.includes('group_key');
        const group = byGroup ? s(args[1]) : undefined;
        const itemKey = byGroup ? (args[2] === undefined ? undefined : s(args[2])) : s(args[1]);
        for (const [k, r] of items) {
          if (r.account_number !== account) continue;
          if (group !== undefined && r.group_key !== group) continue;
          if (itemKey !== undefined && r.item_key !== itemKey) continue;
          items.delete(k);
        }
      } else {
        groups.delete(groupRowKey(account, s(args[1])));
      }
      return [];
    }

    // INSERT ... ON CONFLICT DO UPDATE: an upsert keyed by the table's key columns, which is what the
    // Map is keyed by — so `set` IS the conflict resolution.
    if (table === 'assignment') {
      const row: FakeAssignmentRow = {
        domain: s(args[0]), item_key: s(args[1]), account_number: s(args[2]), label: s(args[3]),
        note: nullable(args[4]), decided_by: s(args[5]), decided_at: s(args[6]),
      };
      assignments.set(assignmentRowKey(row.domain, row.item_key, row.account_number), row);
    } else if (table === 'item') {
      const row: FakeItemRow = {
        account_number: s(args[0]), group_key: s(args[1]), item_key: s(args[2]), label: s(args[3]),
        note: nullable(args[4]), decided_by: s(args[5]), decided_at: s(args[6]), offer: nullable(args[7]),
      };
      items.set(itemRowKey(row.account_number, row.group_key, row.item_key), row);
    } else {
      const row: FakeGroupRow = {
        account_number: s(args[0]), group_key: s(args[1]), billed: int(args[2]), observed: int(args[3]), accepted: int(args[4]),
        note: nullable(args[5]), decided_by: s(args[6]), decided_at: s(args[7]), entitled: args[8] == null ? null : int(args[8]),
      };
      groups.set(groupRowKey(row.account_number, row.group_key), row);
    }
    return [];
  }

  const db = {
    prepare(sql: string) {
      // `bind` returns the same object so a statement handed to `batch()` still carries its own sql
      // and args — the same reason onebillBaseline.selftest.ts's fake does it this way.
      const stmt = {
        sql, args: [] as unknown[],
        bind(...a: unknown[]) { stmt.args = a; return stmt; },
        all: async () => ({ results: exec(stmt), success: true, meta: {} }),
        run: async () => ({ results: exec(stmt), success: true, meta: {} }),
        first: async () => exec(stmt)[0] ?? null,
      };
      return stmt;
    },
    batch: async (list: readonly unknown[]) => {
      const stmts = list as FakeStatement[];
      batches.push(stmts.map((st) => ({ sql: st.sql, args: [...st.args] })));
      return stmts.map((st) => ({ results: exec(st), success: true, meta: {} }));
    },
  } as unknown as D1Database;

  return { db, groups, items, assignments, history, statements, batches };
}
