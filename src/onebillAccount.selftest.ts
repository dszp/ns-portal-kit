/** Offline test for the OneBill account report. pnpm test:onebillaccount */
import { resolveAccountForDomain, resolveAccountScope, loadAccountReport, applyBaselineAction, applyAssignment, domainEntryKey, AccountReadError } from './onebillAccount.js';
import { OnebillRequestError, REFRESH_COOLDOWN_S } from './onebill.js';
import type { LinkReport } from './onebill.js';
import type { ResolvedAccountScope } from './onebillScope.js';
import type { CatalogSource } from './onebillCatalog.js';
import { fakeD1, itemRowKey } from './testkit/fakeD1.js';
import { readBaselines } from './onebillBaseline.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

const acct = (n: string, name: string, links: { domain: string; site?: string }[]) =>
  ({ accountNumber: n, accountName: name, status: 'Active', links, restricted: false });
/** North of a split domain, and a whole domain of its own — the multi-domain account these tests scope. */
const A2 = acct('CLI00002', 'Branch North', [{ domain: 'branch.example', site: 'North' }, { domain: 'other.example' }]);
const A3 = acct('CLI00003', 'Branch South', [{ domain: 'branch.example', site: 'South' }]);

const REPORT = (): LinkReport => ({
  generatedAt: '2026-09-03T12:00:00.000Z', mode: 'quick', verifiedAt: null, usageStale: false,
  rows: [
    { domain: 'acme.example', state: 'linked', sites: [], notes: [],
      accounts: [{ accountNumber: 'CLI00001', accountName: 'Acme', status: 'Active', links: [{ domain: 'acme.example' }], restricted: false }] },
    { domain: 'initech.example', state: 'unlinked', accounts: [], sites: [], notes: [] },
    { domain: 'stark.example', state: 'split', accounts: [], sites: ['HQ', 'Lab'], linkedSites: ['HQ'], notes: [] },
    // A site row with no parent row of its own. Reaching it BY DOMAIN is still a 409 — a domain selector
    // looks for the bare row — but the ACCOUNT now resolves to the one site scope it holds.
    { domain: 'wayne.example', site: 'North', state: 'linked', sites: ['North'], notes: [],
      accounts: [{ accountNumber: 'CLI00004', accountName: 'Wayne North', status: 'Active', links: [{ domain: 'wayne.example', site: 'North' }], restricted: false }] },
    { domain: 'globex.example', state: 'conflict', sites: [], notes: [],
      accounts: [{ accountNumber: 'CLI00007', status: 'Active', links: [{ domain: 'globex.example' }], restricted: false },
                 { accountNumber: 'CLI00008', status: 'Active', links: [{ domain: 'globex.example' }], restricted: false }] },
    // A domain split by site between two accounts, plus a whole domain the North account also holds.
    { domain: 'branch.example', state: 'split', accounts: [], sites: ['North', 'South'], linkedSites: ['North', 'South'], notes: [],
      siteAccounts: [{ site: 'North', account: A2, usageHolder: false }, { site: 'South', account: A3, usageHolder: false }] },
    { domain: 'branch.example', site: 'North', state: 'linked', accounts: [A2], sites: ['North', 'South'], siteCount: 2, notes: [] },
    { domain: 'branch.example', site: 'South', state: 'linked', accounts: [A3], sites: ['North', 'South'], siteCount: 2, notes: [] },
    { domain: 'other.example', state: 'linked', accounts: [A2], sites: [], notes: [] },
  ],
  foreign: [], usage: [], decommission: [], accounts: [], failures: [], siteReadFailures: [],
  setup: { ok: true, group: 'PBX', valueField: 'Domain', missing: [] },
} as unknown as LinkReport);

/** Two seats with names and sites, so the labels an operator accepts are the strings they saw. */
const USERS = () => [
  { user: '100', 'name-first-name': 'Ann', 'name-last-name': 'Lee', site: 'North', 'service-code': '', 'user-scope': 'Basic User' },
  { user: '101', 'name-first-name': 'Bo', 'name-last-name': 'Ray', site: 'South', 'service-code': '', 'user-scope': 'Basic User' },
];

/** `failOn` rejects any path it matches, standing in for a read that fails with something not a 404. */
function fakeNs(failOn?: RegExp) {
  let calls = 0;
  const ns = { get: async (p: string) => {
    calls++;
    if (failOn?.test(p)) throw Object.assign(new Error('500 Internal Server Error'), { status: 500 });
    if (/\/users$/.test(p)) return USERS();
    if (/\/phonenumbers$/.test(p)) return [{ phonenumber: '13175550100' }];
    return [];
  } } as never;
  return { ns, calls: () => calls };
}

function fakeCache() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (r: Request) => { const hit = store.get(r.url); return hit ? hit.clone() : undefined; },
    put: async (r: Request, res: Response) => { store.set(r.url, res.clone()); },
    delete: async (r: Request) => store.delete(r.url),
  } as unknown as Cache;
  return { store, cache };
}

/** Bills `quantity` of one offer named "Seat" — the rulebooks below count it against extensions. */
function fakeSubs(quantity: string) {
  let calls = 0;
  const readSource = { getSubscriptions: async () => { calls++; return [
    { subscriptionId: 'SUB1', subscriptionOffer: [{ name: 'Seat', quantity, subscriptionCharge: [{ type: 'REC' }] }] },
  ]; } };
  return { readSource, calls: () => calls };
}

/** The one-domain account nearly every block below reports on. */
const ACME = (): ResolvedAccountScope => resolveAccountScope(REPORT(), { domain: 'acme.example' });

// -- resolution ----------------------------------------------------------------------------------
{
  const r = resolveAccountForDomain(REPORT(), 'acme.example');
  ok(r.accountNumber === 'CLI00001', 'a linked domain resolves to its account');
  ok(r.accountName === 'Acme', 'and carries the account name');
  ok(JSON.stringify(r.scopes) === JSON.stringify([{ domain: 'acme.example' }]), 'with every scope it holds');

  const thrown = (d: string): OnebillRequestError => { try { resolveAccountForDomain(REPORT(), d); } catch (e) { return e as OnebillRequestError; } throw new Error('did not throw'); };
  ok(thrown('initech.example').status === 409, 'an unlinked domain is a 409');
  ok(/not linked/i.test(thrown('initech.example').message), 'and says so in words');
  ok(thrown('stark.example').status === 409, 'a split domain with no site accounts is a 409 - there is no one account to report on');
  ok(thrown('globex.example').status === 409, 'and so is a conflict');
  ok(/more than one account/.test(thrown('globex.example').message), 'and the conflict says why, rather than only refusing');
  ok(thrown('nowhere.example').status === 409, 'a domain absent from the report is a 409, not a 500');

  // A site row is no longer a dead end: the report is scoped to what the account holds, so the account
  // opens on its own site. It is still unreachable BY DOMAIN — there is no bare row to select.
  ok(thrown('wayne.example').status === 409, 'a site row is not reachable by domain - the domain itself is linked to nothing');
  const w = resolveAccountScope(REPORT(), { account: 'CLI00004' });
  ok(w.scopes.length === 1 && w.scopes[0]!.site === 'North', 'a site-linked account resolves by account number to its one site scope');
}

// -- assembly ------------------------------------------------------------------------------------
{
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };

  const { store, cache } = fakeCache();
  const { ns, calls: nsCalls } = fakeNs();
  // One seat billed against two observed: the over-observed path, where the extras are nameable items.
  const { readSource, calls: subCalls } = fakeSubs('1');

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource });

  ok(rep.accountNumber === 'CLI00001', 'the report names the account');
  ok(rep.domain === 'acme.example', 'and the domain it leads with');
  ok(JSON.stringify(rep.scopes) === JSON.stringify([{ domain: 'acme.example' }]), 'the report names its scopes');
  ok(rep.domains.join() === 'acme.example', 'and the unique domains behind them');
  ok(JSON.stringify(rep.holders) === JSON.stringify({ 'acme.example': [{ accountNumber: 'CLI00001', accountName: 'Acme' }] }),
    'and who holds each of them, by number and name - this account, and nobody else');
  ok(rep.unassigned.length === 0, 'a whole-domain account has nothing unassigned');
  ok(rep.partial === false, 'and is not partial');
  ok(rep.inventory.extensions.total === 2, 'the inventory is counted from the snapshot');
  ok(Array.isArray(rep.detail.extensions) && rep.detail.extensions[0]!.name === 'Ann Lee', 'the report carries the item lists');
  ok(rep.detail.extensions[0]!.key === 'acme.example/ext:100', 'with every key domain-qualified');
  ok(Array.isArray(rep.readFailures) && rep.readFailures.length === 0, 'and an empty read-failure list when every device read answered');
  ok(rep.comparison.rows.length === 1, 'one rule group produces one row');
  ok(rep.comparison.rows[0]!.billed === 1, 'billed comes from the subscription quantity');
  ok(rep.comparison.rows[0]!.observed === 2, 'observed comes from the item list');
  ok(rep.comparison.rows[0]!.items!.length === 2, 'the seats row lists its extensions');
  ok(rep.comparison.rows[0]!.unreviewed === 2, 'and counts them all unreviewed');
  // Per item, labelled: an every() over both fields at once cannot say WHICH item disagreed, nor which
  // of the two facts about it was wrong.
  for (const i of rep.comparison.rows[0]!.items!) {
    ok(i.domain === 'acme.example', `${i.key} says which domain it is on`);
    ok(i.attribution === 'domain', `${i.key} says how it was attributed`);
  }
  ok(rep.domainTotals['acme.example']!.extensions.total === 2, 'domain totals ride along');
  ok(rep.comparison.rows[0]!.verdict === 'unbaselined', 'and with no database bound the gap is unbaselined');
  ok(rep.catalog === undefined, 'no catalogue read when no rule needs one');
  ok(rep.baselinesEnabled === false, 'baselines are off when no D1 is bound');
  ok(rep.canWrite === true, 'canWrite is passed through');
  ok(typeof rep.loadedAt === 'string' && rep.loadedAt.endsWith('Z'), 'loadedAt is an ISO instant');

  const ns1 = nsCalls(), sub1 = subCalls();
  const again = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource });
  ok(nsCalls() === ns1, 'a second load reads NetSapiens not at all');
  ok(subCalls() === sub1, 'and OneBill not at all');
  ok(store.size === 2, 'one domain entry and one subscriptions entry');
  ok(again.detail.extensions.length === 2, 'and the cached entry carries the item lists, not just the counts');
  // `?refresh=1` is the one parameter an authenticated caller can spend this deployment's upstream
  // credentials with, and nothing else on the route bounds how often they may ask — so a refresh
  // landing inside REFRESH_COOLDOWN_S of the entry it would replace is served from the entry. Asserted
  // per system: a cooldown honoured for NetSapiens and skipped for OneBill would still be a fan-out.
  await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource, refresh: true });
  ok(nsCalls() === ns1, 'a refresh inside the cooldown reads NetSapiens not at all');
  ok(subCalls() === sub1, 'and OneBill not at all');
  const past = new Date(Date.now() + (REFRESH_COOLDOWN_S + 1) * 1000);
  await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource, refresh: true, now: past });
  ok(nsCalls() > ns1, 'while a refresh past it does re-read NetSapiens');
  ok(subCalls() > sub1, 'and OneBill');

  // An entry written before one of these fields existed is a MISS: serving it would render a page with
  // no items, no attribution or no read-failure warning, and an operator cannot tell any of those from
  // a domain that genuinely has none.
  for (const field of ['detail', 'attribution', 'deviceFailures', 'smsFailures'] as const) {
    const key = [...store.keys()].find((k) => k.includes('/domain/'))!;
    const stored = await store.get(key)!.clone().json() as Record<string, unknown>;
    delete stored[field];
    store.set(key, new Response(JSON.stringify(stored), { headers: { 'content-type': 'application/json' } }));
    const ns2 = nsCalls();
    const revived = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource });
    ok(nsCalls() > ns2, `a domain cache entry with no ${field} is a MISS, not an error`);
    ok(revived.detail.extensions.length === 2 && Array.isArray(revived.readFailures), `and the re-read fills ${field} in`);
  }

  // -- item acceptance, against a database that remembers ------------------------------------------
  const f = fakeD1();
  const { db, history } = f;
  const withDb = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource, db });
  ok(withDb.baselinesEnabled === true, 'baselines are on when D1 is bound');
  ok(withDb.comparison.rows[0]!.verdict === 'unbaselined', 'and an empty database leaves the gap unbaselined');

  const nsBefore = nsCalls(), subBefore = subCalls();
  const act = (req: Record<string, unknown>) =>
    applyBaselineAction(env as never, cache, ns, REPORT(), ACME(), db, 'ops@example.com', req as never, { readSource });

  const row1 = await act({ action: 'accept', group: 'seats', items: [{ key: 'acme.example/ext:100' }], note: 'spare' });
  ok(row1.unreviewed === 1 && row1.verdict === 'unbaselined', 'one accepted, one still unreviewed - the group stays unbaselined');
  ok(row1.items!.find((i) => i.key === 'acme.example/ext:100')!.acceptance!.label === '100 — Ann Lee, North', 'the acceptance stored the label the operator saw');
  ok(row1.groupRow === undefined, 'and a partial acceptance writes no group row');
  ok(nsCalls() === nsBefore && subCalls() === subBefore, 'an action costs D1 reads only - inventory and subscriptions come from the cache');

  const row2 = await act({ action: 'accept', group: 'seats', all: true, note: 'the rest' });
  ok(row2.unreviewed === 0 && row2.verdict === 'accepted' && row2.groupRow!.billed === 1, 'accept all completes the group and records the billed count');
  ok(row2.groupRow!.accepted === 2, 'and records what was accepted, which is what was observed');
  ok(row2.items!.find((i) => i.key === 'acme.example/ext:101')!.acceptance!.note === 'the rest', "the operator's note lands on the item they wrote it about");
  ok(row2.groupRow!.note === undefined, 'and NOT on the group row, which they never wrote a sentence about');

  // Every clear writes exactly one history row per thing it removed - counted, not merely present,
  // because an audit trail that is one row short is indistinguishable from one that is complete.
  const itemClears = () => history.filter((h) => h.table === 'billing_baseline_item_history' && h.args[4] === 'clear').length;
  // args[9], not args[8]: migration 0004 put `entitled` between `decided_at` and `action`.
  const groupClears = () => history.filter((h) => h.table === 'billing_baseline_history' && h.args[9] === 'clear').length;

  const clearsBefore3 = itemClears();
  const row3 = await act({ action: 'clear', group: 'seats', items: [{ key: 'acme.example/ext:101' }] });
  ok(row3.verdict === 'drift' && row3.unreviewed === 1, 'clearing one item after a full acceptance reads as drift');
  ok(itemClears() === clearsBefore3 + 1, 'clearing one item writes exactly one item clear history row');

  const clearsBefore4 = itemClears(), groupsBefore4 = groupClears();
  const row4 = await act({ action: 'clear', group: 'seats', all: true });
  ok(row4.verdict === 'unbaselined' && row4.groupRow === undefined && row4.items!.every((i) => i.status === 'unreviewed'), 'clear all removes items and the group row');
  ok(itemClears() === clearsBefore4 + 1, 'and writes one item clear row per acceptance it removed - one was left');
  ok(groupClears() === groupsBefore4 + 1, 'plus one for the group row itself');

  // refusals
  const bad = async (req: Record<string, unknown>): Promise<OnebillRequestError | null> => {
    try { await act(req); } catch (e) { return e as OnebillRequestError; }
    return null;
  };
  // A group row recorded before migration 0004 has NO entitlement on it, which is not the same fact as
  // an entitlement of 0 — onebill-lib keeps such a decision on the pre-entitlement rule rather than
  // drifting every old row at once, and the completion write must not rewrite one just to add the
  // number. The rewrite would restamp `decided_at` on a decision nobody revisited.
  {
    const groupWrites = () => f.history.filter((h) => h.table === 'billing_baseline_history').length;
    await act({ action: 'accept', group: 'seats', all: true });
    const legacy = f.groups.get('CLI00001\u0000seats')!;
    ok(legacy !== undefined, '(fixture) the group is completed and its group row recorded');
    // Back-date it to the pre-0004 shape: the acceptance is intact, the entitlement column is NULL.
    f.groups.set('CLI00001\u0000seats', { ...legacy, entitled: null });
    const before = groupWrites();
    const again = await act({ action: 'accept', group: 'seats', all: true });
    ok(again.groupRow?.entitled === undefined, 'a pre-0004 group row comes back with no entitlement, as it was stored');
    ok(groupWrites() === before, 'and the completion write leaves it alone rather than rewriting it to add one');
    await act({ action: 'clear', group: 'seats', all: true });
  }

  ok((await bad({ action: 'accept', group: 'nope', all: true }))?.status === 409, 'an unknown group is 409');
  const missing = await bad({ action: 'accept', group: 'seats', items: [{ key: 'acme.example/ext:999' }] });
  ok(/ext:999/.test(missing?.message ?? ''), 'an item not present on the row is refused by name');
  ok(missing?.status === 409, 'and refused with a 409, not a 500');
}

// -- an account across a split domain with a shared address -----------------------------------------
{
  // CLI00002 holds branch.example/North and the whole of other.example. Its report is the union of the
  // two, scoped: South's extension is not its, and the address both sites reference is nobody's.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-split',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  const BRANCH_USERS = () => [
    { user: '100', 'name-first-name': 'Ann', 'name-last-name': 'Lee', site: 'North', 'service-code': '', 'emergency-address-id': 'a-1' },
    { user: '200', 'name-first-name': 'Sam', 'name-last-name': 'Roe', site: 'South', 'service-code': '', 'emergency-address-id': 'a-1' },
  ];
  // `other.example` is in scope too and answers empty, so the union is provably branch's alone.
  const ns = { get: async (p: string) => {
    const branch = p.includes('/domains/branch.example/');
    if (/\/users$/.test(p)) return branch ? BRANCH_USERS() : [];
    if (/\/addresses$/.test(p)) return branch ? [{ 'emergency-address-id': 'a-1', 'address-name': 'Shared' }] : [];
    return [];
  } } as never;
  const { readSource } = fakeSubs('1');
  const north = resolveAccountScope(REPORT(), { account: 'CLI00002' });
  ok(north.domains.join() === 'branch.example,other.example', 'the North account spans two domains');

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), north, { canWrite: true, readSource });
  ok(rep.detail.extensions.map((x) => x.key).join() === 'branch.example/ext:100', 'only the extension on the site it holds');
  ok(rep.inventory.extensions.total === 1, 'and the scoped count says one');
  ok(rep.domainTotals['branch.example']!.extensions.total === 2, "while the domain total says two - the other seat is South's");
  // The address both sites reference is on BOTH accounts, not Unassigned: each of them bills an E911
  // bundle for the same place, and picking one left the other's E911 row short.
  ok(!rep.unassigned.some((u) => u.key === 'addr:a-1'), 'the address both sites reference is not Unassigned');
  ok(rep.detail.e911Addresses.map((x) => x.key).join() === 'branch.example/addr:a-1', 'it is on this account');
  ok(rep.inventory.e911Addresses === 1, 'once - the account bills one bundle for the place, not one per user');
  // The same two holders, as the Move control reads them off the report — sorted, and per domain.
  ok(JSON.stringify(rep.holders['branch.example']) === JSON.stringify([{ accountNumber: 'CLI00002', accountName: 'Branch North' }, { accountNumber: 'CLI00003', accountName: 'Branch South' }]),
    'the split domain names both of its holders, sorted');
  ok(JSON.stringify(rep.holders['other.example']) === JSON.stringify([{ accountNumber: 'CLI00002', accountName: 'Branch North' }]),
    'while a domain this account holds whole names only itself, so its items offer no Move');
  ok(typeof rep.loadedAt === 'string' && rep.loadedAt.endsWith('Z'), 'loadedAt is an ISO instant across several domain reads');
  ok(rep.partial === false, 'nothing failed, so nothing is partial');
}

// -- an item is reassigned across a split domain, and its acceptance goes with it --------------------
{
  // branch.example is North's (CLI00002) and South's (CLI00003) by site. Moving North's seat to South
  // is the one write that spans both stores: the assignment row says where it bills now, and North's
  // acceptance of it has to go in the SAME batch — an acceptance standing against an account that no
  // longer holds the item is a decision nobody made.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-assign',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  const BRANCH_USERS = () => [
    { user: '100', 'name-first-name': 'Ann', 'name-last-name': 'Lee', site: 'North', 'service-code': '' },
    { user: '200', 'name-first-name': 'Sam', 'name-last-name': 'Roe', site: 'South', 'service-code': '' },
  ];
  const ns = { get: async (p: string) => (/\/users$/.test(p) && p.includes('/domains/branch.example/') ? BRANCH_USERS() : []) } as never;
  const { readSource } = fakeSubs('1');
  const f = fakeD1();
  const north = resolveAccountScope(REPORT(), { account: 'CLI00002' });
  const south = resolveAccountScope(REPORT(), { account: 'CLI00003' });

  const accepted = await applyBaselineAction(env as never, cache, ns, REPORT(), north, f.db, 'ops@example.com',
    { action: 'accept', group: 'seats', items: [{ key: 'branch.example/ext:100' }] }, { readSource });
  ok(accepted.items!.find((i) => i.key === 'branch.example/ext:100')!.status === 'accepted', 'North accepts the seat its site holds');
  const NORTHS_ROW = itemRowKey('CLI00002', 'seats', 'branch.example/ext:100');
  ok(f.items.has(NORTHS_ROW), 'and the acceptance is on the books, under the account, group and scoped key together');

  // The history has to say what was cleared AS IT WAS RECORDED. Rename the seat in the store after the
  // acceptance — a rename in NetSapiens between the review and the reassignment is the real case — and
  // the clear must still echo the label the operator signed off on rather than today's.
  f.items.set(NORTHS_ROW, { ...f.items.get(NORTHS_ROW)!, label: '100 — Anna Lee, North' });

  const itemClears = () => f.history.filter((h) => h.table === 'billing_baseline_item_history' && h.args[4] === 'clear').length;
  const assigns = () => f.history.filter((h) => h.table === 'billing_item_assignment_history' && h.args[4] === 'assign').length;
  const clearsBefore = itemClears(), assignsBefore = assigns(), batchesBefore = f.batches.length;

  const rep = await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com',
    { domain: 'branch.example', key: 'ext:100', accountNumber: 'CLI00003' }, south, { readSource });
  ok(rep.accountNumber === 'CLI00003', 'the report that comes back is the account the operator is looking at');
  const moved = rep.comparison.rows[0]!.items!.find((i) => i.key === 'branch.example/ext:100');
  ok(moved?.attribution === 'manual', 'the seat is on South now, and says it got there by hand');
  ok(moved?.automatic?.accountNumber === 'CLI00002' && moved?.automatic?.site === 'North', 'while naming the account and site the automatic rule would have chosen');
  ok(!f.items.has(NORTHS_ROW), "North's acceptance went with the item");
  ok(moved?.label === '100 — Ann Lee, North', "today's inventory label is the one the panel shows");
  const clearRow = f.history.filter((h) => h.table === 'billing_baseline_item_history' && h.args[4] === 'clear').pop()!;
  ok(clearRow.args[3] === '100 — Anna Lee, North', 'while the clear records the label the acceptance was made under, not the one it reads today');
  ok(itemClears() === clearsBefore + 1, 'recorded as exactly one acceptance clear');
  ok(assigns() === assignsBefore + 1, 'and exactly one assignment');
  ok(f.batches.length === batchesBefore + 1, 'in ONE batch - the two stores cannot be left disagreeing');
  ok(f.batches[f.batches.length - 1]!.length === 6, 'carrying the acceptance delete and its history row, the unconditional delete of every acceptance of that key, the one-row-per-item delete, the assignment upsert and its own');

  const back = await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com',
    { domain: 'branch.example', key: 'ext:100', accountNumber: null }, north, { readSource });
  ok(back.accountNumber === 'CLI00002', 'clearing the assignment answers with the account that asked');
  const home = back.comparison.rows[0]!.items!.find((i) => i.key === 'branch.example/ext:100');
  ok(home?.attribution === 'site', 'and the seat is back on North, by the site rule that always said so');
  ok(home?.automatic === undefined, 'with nothing left to disagree with');
  ok(f.assignments.size === 0, 'the assignment row is gone');

  // An explicit assignment where the site rule already agreed, and then its clear: neither moves the
  // item, so neither may take South's review of it with them. This is the case a rule keyed on the
  // REQUEST rather than on who owns the item before and after gets wrong.
  await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com',
    { domain: 'branch.example', key: 'ext:200', accountNumber: 'CLI00003' }, south, { readSource });
  await applyBaselineAction(env as never, cache, ns, REPORT(), south, f.db, 'ops@example.com',
    { action: 'accept', group: 'seats', items: [{ key: 'branch.example/ext:200' }] }, { readSource });
  const SOUTHS_ROW = itemRowKey('CLI00003', 'seats', 'branch.example/ext:200');
  ok(f.items.has(SOUTHS_ROW), 'South accepts the seat it was explicitly assigned and already held by site');

  const noopBatches = f.batches.length;
  await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com',
    { domain: 'branch.example', key: 'ext:200', accountNumber: null, note: 'the site rule had it right' }, south, { readSource });
  ok(f.items.has(SOUTHS_ROW), 'clearing an assignment whose automatic owner is the same account keeps the acceptance');
  ok(f.batches.length === noopBatches + 1 && f.batches[f.batches.length - 1]!.length === 2, 'and the batch is the delete and its history row, nothing else');
  ok(f.history[f.history.length - 1]!.args[5] === 'the site rule had it right', "and carries the operator's reason for handing it back");

  const bad = async (req: Record<string, unknown>): Promise<OnebillRequestError | null> => {
    try { await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com', req as never, south, { readSource }); }
    catch (e) { return e as OnebillRequestError; }
    return null;
  };
  const batchesQuiet = f.batches.length;
  const notHolder = await bad({ domain: 'branch.example', key: 'ext:100', accountNumber: 'CLI00001' });
  ok(notHolder?.status === 409, 'assigning to an account that holds no part of the domain is a 409');
  ok(/CLI00001/.test(notHolder?.message ?? '') && /branch\.example/.test(notHolder?.message ?? ''), 'naming both the account and the domain');

  // Both of those refusals are answerable from the link report alone, and a domain read is a whole PBX
  // snapshot on a cache miss. Asked against a COLD cache, neither may buy one.
  let reads = 0;
  const { cache: cold } = fakeCache();
  const countingNs = { get: async () => { reads++; return []; } } as never;
  const coldBad = async (req: Record<string, unknown>): Promise<OnebillRequestError | null> => {
    try { await applyAssignment(env as never, cold, countingNs, REPORT(), f.db, 'ops@example.com', req as never, south, { readSource }); }
    catch (e) { return e as OnebillRequestError; }
    return null;
  };
  const unknownDomain = await coldBad({ domain: 'nowhere.example', key: 'ext:100', accountNumber: 'CLI00003' });
  ok(unknownDomain?.status === 409 && /not in this report/.test(unknownDomain?.message ?? ''), 'a domain this report has never heard of is a 409 that says to reload');
  await coldBad({ domain: 'branch.example', key: 'ext:100', accountNumber: 'CLI00001' });
  ok(reads === 0, 'and neither refusal read NetSapiens at all - the free checks come first');
  const noItem = await bad({ domain: 'branch.example', key: 'ext:999', accountNumber: 'CLI00003' });
  ok(noItem?.status === 409 && /ext:999/.test(noItem?.message ?? ''), 'an item that is not on the domain right now is a 409 naming it');
  const nothingToClear = await bad({ domain: 'branch.example', key: 'ext:200', accountNumber: null });
  ok(nothingToClear?.status === 409 && /no manual assignment/.test(nothingToClear?.message ?? ''), 'and clearing an assignment that was never made says so');
  ok(f.batches.length === batchesQuiet, 'a refusal writes nothing at all');

  // ── ONE ROW PER NON-ADDRESS ITEM, and the account is not what identifies the row ───────────────
  // The rule the schema stopped carrying at migration 0005. It was briefly enforced by filtering the
  // rows a read returned on the ACCOUNT alone, across every key on the domain — so an account holding a
  // SECOND item on the same domain kept its first item's row, and a clear deleted the acceptance while
  // the assignment survived. These are that bug, from both directions.
  {
    const rows = (k: string) => [...f.assignments.values()].filter((a) => a.item_key === k).map((a) => a.account_number).sort();
    const clearsFor = (k: string) => f.history.filter((h) => h.table === 'billing_item_assignment_history' && h.args[1] === k && h.args[4] === 'clear');
    // Two extensions on ONE account, then one of them moves.
    await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com', { domain: 'branch.example', key: 'ext:100', accountNumber: 'CLI00002' }, north, { readSource });
    await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com', { domain: 'branch.example', key: 'ext:200', accountNumber: 'CLI00002' }, north, { readSource });
    ok(rows('ext:100').join() === 'CLI00002' && rows('ext:200').join() === 'CLI00002', 'two items assigned to one account');
    const clears100 = clearsFor('ext:100').length, clears200 = clearsFor('ext:200').length;
    await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com', { domain: 'branch.example', key: 'ext:100', accountNumber: 'CLI00003' }, south, { readSource });
    ok(rows('ext:100').join() === 'CLI00003', 'reassigning one leaves EXACTLY one row on it - the account it left does not keep a second');
    ok(rows('ext:200').join() === 'CLI00002', 'and the account\'s OTHER item is untouched');
    ok(clearsFor('ext:100').length === clears100 + 1, 'one clear recorded, naming the account that left this key');
    ok(clearsFor('ext:200').length === clears200, 'and none against the key that did not move');

    // The same shape on a CLEAR: the account still holds ext:200, which used to make this a no-op that
    // deleted the acceptance anyway.
    await applyBaselineAction(env as never, cache, ns, REPORT(), south, f.db, 'ops@example.com',
      { action: 'accept', group: 'seats', items: [{ key: 'branch.example/ext:100' }] }, { readSource });
    const ACC = itemRowKey('CLI00003', 'seats', 'branch.example/ext:100');
    ok(f.items.has(ACC), 'South accepts the seat it was just given');
    const before = clearsFor('ext:100').length;
    await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com', { domain: 'branch.example', key: 'ext:100', accountNumber: null }, north, { readSource });
    ok(rows('ext:100').length === 0, 'a clear removes the row even though that account holds another item on the domain');
    ok(clearsFor('ext:100').length === before + 1, 'and writes the history for it');
    ok(!f.items.has(ACC), 'the acceptance goes with it, which it did before - the row is what used to survive');

    // A table already holding TWO rows on one non-address key, from before this was fixed. Seeded
    // straight into the store, because no route can produce it any more. An assign HEALS it: the delete
    // is `account_number <> ?`, so it is true of what is in the table rather than of what a read saw.
    const { assignmentRowKey } = await import('./testkit/fakeD1.js');
    for (const acct of ['CLI00002', 'CLI00003']) {
      f.assignments.set(assignmentRowKey('branch.example', 'ext:200', acct),
        { domain: 'branch.example', item_key: 'ext:200', account_number: acct, label: '200', note: null, decided_by: 'legacy', decided_at: '2026-01-01T00:00:00.000Z' });
    }
    ok(rows('ext:200').join() === 'CLI00002,CLI00003', 'a broken two-row state is seeded');
    await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com', { domain: 'branch.example', key: 'ext:200', accountNumber: 'CLI00003' }, south, { readSource });
    ok(rows('ext:200').join() === 'CLI00003', 'and an assign heals it to one row rather than adding a third');
  }

}

// -- one E911 rule counting BOTH models, end to end through the real load path ----------------------
{
  // The shape the production rulebook now has: `counts: ["e911Endpoints","e911Legacy"]`, so one retail
  // line pays for a domain on either model — and, on a half-migrated one, for both without paying twice.
  // branch.example carries an endpoint (100 and 200 reference it) and one number that is NOT provisioned
  // as an endpoint (300 carries it by hand, with no emergency address, which is the legacy shape).
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-e911-both',
    ONEBILL_RECURRING_RULES: '[{"offer":"E911","counts":["e911Endpoints","e911Legacy"],"group":"E911 and Number","alsoCounts":{"dids.total":1}}]' };
  const { cache } = fakeCache();
  const ns = { get: async (p: string) => {
    const branch = p.includes('/domains/branch.example/');
    if (!branch) return [];
    if (/\/users$/.test(p)) return [
      { user: '100', site: 'North', 'service-code': '', 'emergency-address-id': 'a-1', 'caller-id-number-emergency': '13175550100' },
      { user: '200', site: 'South', 'service-code': '', 'emergency-address-id': 'a-1', 'caller-id-number-emergency': '3175550100' },
      { user: '300', site: 'North', 'service-code': '', 'caller-id-number-emergency': '3175550900' },
    ];
    if (/\/addresses$/.test(p)) return [{ 'emergency-address-id': 'a-1', 'address-name': 'Shared dock' }];
    if (/\/addresses\/endpoints$/.test(p)) return [{ 'emergency-address-id': '3175550100', 'address-name': 'Shared dock', 'caller-name': 'Branch', 'address-line-1': '1 Main St', 'address-city': 'Springfield', 'count-users-configured': 2 }];
    return [];
  } } as never;
  const readSource = { getSubscriptions: async () => [] as never };
  const f = fakeD1();
  const north = resolveAccountScope(REPORT(), { account: 'CLI00002' });
  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), north, { canWrite: true, readSource, db: f.db });
  const row = rep.comparison.rows.find((r) => r.group === 'E911 and Number')!;
  ok(row !== undefined && row.observed === 2, '[e911 rule] one rule counting both dimensions observes the endpoint AND the legacy number');
  ok(!row.observedMissing, '[e911 rule] and both paths are dimensions the counter knows - a typo here reads as zero live');
  ok(row.items!.map((i) => i.key).sort().join() === 'branch.example/e911:3175550100,branch.example/e911legacy:3175550900',
    '[e911 rule] the two item lists are unioned onto the one row');
  ok(rep.inventory.e911Endpoints === 1 && rep.inventory.e911Legacy === 1 && rep.inventory.e911Addresses === 1,
    '[e911 rule] and the three E911 dimensions are counted apart - the endpoint callback is never also a legacy number');
  ok(row.items!.every((i) => i.sharedWith === undefined || i.sharedWith.length > 0), '[e911 rule] sharedWith is present or absent, never an empty list');
}

// -- an ADDRESS is assigned additively, removed per account, and shows the co-holder's bill ----------
{
  // branch.example is split North (CLI00002) / South (CLI00003), and one address is referenced from
  // both sites. Both accounts hold it automatically, and both legitimately bill an E911 bundle for it.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-shared-addr',
    ONEBILL_RECURRING_RULES: '[{"offer":"E911","counts":"e911Addresses","group":"e911"}]' };
  const { cache } = fakeCache();
  const BRANCH_USERS = () => [
    { user: '100', 'name-first-name': 'Ann', 'name-last-name': 'Lee', site: 'North', 'service-code': '', 'emergency-address-id': 'a-1' },
    { user: '200', 'name-first-name': 'Sam', 'name-last-name': 'Roe', site: 'South', 'service-code': '', 'emergency-address-id': 'a-1' },
  ];
  const ns = { get: async (p: string) => {
    const branch = p.includes('/domains/branch.example/');
    if (/\/users$/.test(p)) return branch ? BRANCH_USERS() : [];
    if (/\/addresses$/.test(p)) return branch ? [{ 'emergency-address-id': 'a-1', 'address-name': 'Shared dock' }] : [];
    return [];
  } } as never;
  /** Each account's own bill. CLI00003 buys its own E911 bundle; CLI00009 is not asked for one. */
  const BILLS: Record<string, unknown[]> = {
    CLI00002: [{ subscriptionId: 'S2', subscriptionOffer: [{ name: 'E911', quantity: '1', subscriptionCharge: [{ type: 'REC' }] }] }],
    CLI00003: [{ subscriptionId: 'S3', subscriptionOffer: [{ name: 'E911', quantity: '1', subscriptionCharge: [{ type: 'REC' }] }] }],
  };
  let subReads = 0;
  const readSource = { getSubscriptions: async (a: string) => { subReads++; return (BILLS[a] ?? []) as never; } };
  const f = fakeD1();
  const north = resolveAccountScope(REPORT(), { account: 'CLI00002' });
  const south = resolveAccountScope(REPORT(), { account: 'CLI00003' });

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), north, { canWrite: true, readSource, db: f.db });
  const SK = 'branch.example/addr:a-1';
  const e911 = rep.comparison.rows.find((r) => r.group === 'e911')!;
  const line = e911.items!.find((i) => i.key === SK);
  ok(line !== undefined, 'the shared address is on North, not in Unassigned');
  ok(JSON.stringify(line!.sharedWith) === JSON.stringify([{ accountNumber: 'CLI00003', accountName: 'Branch South' }]), 'and the item line names the other holder');
  ok(JSON.stringify(rep.coBilled['e911']![SK]) === JSON.stringify([{ accountNumber: 'CLI00003', accountName: 'Branch South', group: 'e911', billed: 1, entitled: 0 }]),
    "coBilled says what the co-holder's OWN bill carries on the same group");
  ok(rep.partial === false, "and reading somebody else's bill does not make this report partial");

  // Cached per account, so the second panel over the same co-holder costs nothing.
  const readsAfterFirst = subReads;
  await loadAccountReport(env as never, cache, ns, REPORT(), north, { canWrite: true, readSource, db: f.db });
  ok(subReads === readsAfterFirst, "the co-holder's subscriptions come out of the same ten-minute cache as anyone else's");

  // A co-holder whose subscriptions will NOT read. `billed: -1` is a fact; 0 would be a lie the page
  // could not tell apart from an account that really buys nothing.
  {
    const { cache: c2 } = fakeCache();
    const failing = { getSubscriptions: async (a: string) => {
      if (a === 'CLI00003') throw new Error('503 Service Unavailable');
      return (BILLS[a] ?? []) as never;
    } };
    const r2 = await loadAccountReport(env as never, c2, ns, REPORT(), north, { canWrite: true, readSource: failing, db: f.db });
    ok(r2.coBilled['e911']![SK]![0]!.billed === -1, "a co-holder whose subscriptions will not read records -1, not 0");
    ok(r2.partial === false, 'and still does not make this account\'s own report partial');
  }
  // A co-holder billing nothing on the group is a real 0 — the same rulebook ran, so the row is there.
  {
    const { cache: c3 } = fakeCache();
    const none = { getSubscriptions: async (a: string) => (a === 'CLI00003' ? [] : (BILLS[a] ?? [])) as never };
    const r3 = await loadAccountReport(env as never, c3, ns, REPORT(), north, { canWrite: true, readSource: none, db: f.db });
    ok(r3.coBilled['e911']![SK]![0]!.billed === 0 && r3.coBilled['e911']![SK]![0]!.entitled === 0, 'a co-holder with no line on the group reads 0/0');
  }

  // ONE dimension counted under TWO groups: the same address key sits on two comparison rows, and the
  // two rows are billed differently. Keyed by the item alone, the second row reported the first's
  // numbers — a wrong number on a billing page, and the reason coBilled is nested group-then-key.
  {
    const twoGroups = { ...env, CACHE_SCOPE: 'test-shared-addr-2g',
      ONEBILL_RECURRING_RULES: '[{"offer":"E911","counts":"e911Addresses","group":"e911"},{"offer":"E911 Plus","counts":"e911Addresses","group":"e911plus"}]' };
    const { cache: c4 } = fakeCache();
    const two = { getSubscriptions: async (a: string) => (a === 'CLI00003' ? [
      { subscriptionId: 'S3', subscriptionOffer: [{ name: 'E911', quantity: '1', subscriptionCharge: [{ type: 'REC' }] }] },
      { subscriptionId: 'S4', subscriptionOffer: [{ name: 'E911 Plus', quantity: '4', subscriptionCharge: [{ type: 'REC' }] }] },
    ] : []) as never };
    const r4 = await loadAccountReport(twoGroups as never, c4, ns, REPORT(), north, { canWrite: true, readSource: two, db: f.db });
    ok(r4.coBilled['e911']![SK]![0]!.billed === 1 && r4.coBilled['e911plus']![SK]![0]!.billed === 4,
      'each group carries the co-holder number for THAT group, not the first one found for the item');
    ok(Object.keys(r4.coBilled).sort().join() === 'e911,e911plus', 'and the map is nested by group, so the two cannot collide');
  }

  // ── the write surface ─────────────────────────────────────────────────────────────────────────
  // A THIRD account is added by hand. Additive: the two automatic holders keep it.
  const acme = resolveAccountScope(REPORT(), { account: 'CLI00001' });
  const noSuch = await (async () => { try { await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com', { domain: 'branch.example', key: 'addr:a-1', accountNumber: 'CLI00001' }, acme, { readSource }); } catch (e) { return e as OnebillRequestError; } return null; })();
  ok(noSuch?.status === 409, 'an account holding no part of the domain still cannot be added to an address');

  // North accepts the address, then removes ITSELF from the set: its acceptance goes in the same batch.
  await applyBaselineAction(env as never, cache, ns, REPORT(), north, f.db, 'ops@example.com',
    { action: 'accept', group: 'e911', items: [{ key: SK }] }, { readSource });
  const NORTHS = itemRowKey('CLI00002', 'e911', SK);
  ok(f.items.has(NORTHS), 'North accepts the address it holds');

  // First it has to BE in the manual set — an automatic placement is not something a remove can take
  // away, since the site link would put it straight back.
  await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com',
    { domain: 'branch.example', key: 'addr:a-1', accountNumber: 'CLI00003' }, south, { readSource });
  const stillBoth = await loadAccountReport(env as never, cache, ns, REPORT(), north, { canWrite: true, readSource, db: f.db });
  ok(stillBoth.comparison.rows.find((r) => r.group === 'e911')!.items!.some((i) => i.key === SK),
    'assigning the address to South does NOT take it off North - an address assignment adds, it never moves');
  ok(f.items.has(NORTHS), "so North's acceptance of it stands");
  ok([...f.assignments.values()].filter((a) => a.item_key === 'addr:a-1').length === 1, 'and one manual row exists');

  const bad = async (req: Record<string, unknown>): Promise<OnebillRequestError | null> => {
    try { await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com', req as never, north, { readSource }); }
    catch (e) { return e as OnebillRequestError; }
    return null;
  };
  const wholeClear = await bad({ domain: 'branch.example', key: 'addr:a-1', accountNumber: null });
  ok(wholeClear?.status === 409 && /remove one instead/.test(wholeClear?.message ?? ''),
    'clearing an address outright is refused - it has per-account assignments, and the operator has to say which');
  const removeExt = await bad({ domain: 'branch.example', key: 'ext:100', accountNumber: 'CLI00002', remove: true });
  ok(removeExt?.status === 409 && /only an E911 address, endpoint or legacy number/.test(removeExt?.message ?? ''),
    'and `remove` on anything but a shared E911 kind is refused rather than doing the clear it resembles');
  const removeNothing = await bad({ domain: 'branch.example', key: 'addr:a-1', accountNumber: 'CLI00002', remove: true });
  ok(removeNothing?.status === 409 && /not manually assigned/.test(removeNothing?.message ?? ''), 'removing an account that has no row on the address says so');

  // Now the real removal: South leaves the manual set it was just put in. Its automatic site placement
  // is still there, so it does NOT lose the item and no acceptance of its own is cleared.
  const beforeRemove = f.batches.length;
  const afterRemove = await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com',
    { domain: 'branch.example', key: 'addr:a-1', accountNumber: 'CLI00003', remove: true, note: 'billed centrally after all' }, south, { readSource });
  ok([...f.assignments.values()].filter((a) => a.item_key === 'addr:a-1').length === 0, 'the removal deletes exactly that account\'s row');
  ok(afterRemove.comparison.rows.find((r) => r.group === 'e911')!.items!.some((i) => i.key === SK), 'South keeps the address by its site link, which the removal never touched');
  ok(f.batches.length === beforeRemove + 1 && f.batches[f.batches.length - 1]!.length === 2, 'in one batch of the delete and its history row');
  const last = f.history[f.history.length - 1]!;
  ok(last.args[4] === 'clear' && last.args[2] === 'CLI00003', 'recorded as a clear NAMING the account that left, which a set of placements needs');
  ok(last.args[5] === 'billed centrally after all', "and carrying the operator's reason");

  // ── a STALE assignment is removable ───────────────────────────────────────────────────────────
  // An assignment naming an account that no longer holds any of the domain is ignored for placement and
  // surfaced as `staleAssignment` so somebody clears it. Bounding the REMOVE on the account still being
  // a holder made exactly that impossible — the badge asked for a fix the route refused. A remove is
  // bounded by the row's own existence instead; only the ADD path needs the account to hold something.
  {
    const { assignmentRowKey } = await import('./testkit/fakeD1.js');
    f.assignments.set(assignmentRowKey('branch.example', 'addr:a-1', 'CLI00099'),
      { domain: 'branch.example', item_key: 'addr:a-1', account_number: 'CLI00099', label: 'Shared dock', note: null, decided_by: 'someone', decided_at: '2026-01-01T00:00:00.000Z' });
    const stale = await loadAccountReport(env as never, cache, ns, REPORT(), north, { canWrite: true, readSource, db: f.db });
    ok(!stale.comparison.rows.find((r) => r.group === 'e911')!.items!.find((i) => i.key === SK)!.sharedWith!.some((w) => w.accountNumber === 'CLI00099'),
      'a non-holder is not a co-holder - the placement rule ignores the row');
    const gone = await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com',
      { domain: 'branch.example', key: 'addr:a-1', accountNumber: 'CLI00099', remove: true }, north, { readSource });
    ok([...f.assignments.values()].every((a) => a.account_number !== 'CLI00099'), 'removing it succeeds even though that account holds no part of the domain');
    const h = f.history[f.history.length - 1]!;
    ok(h.table === 'billing_item_assignment_history' && h.args[4] === 'clear' && h.args[2] === 'CLI00099', 'and the history names it');
    ok(gone.comparison.rows.find((r) => r.group === 'e911')!.items!.some((i) => i.key === SK), 'while the two real holders keep the address');
    // ADDING one is still refused - a row that does nothing is not a decision worth recording.
    const stillNo = await bad({ domain: 'branch.example', key: 'addr:a-1', accountNumber: 'CLI00099' });
    ok(stillNo?.status === 409 && /holds no part of/.test(stillNo?.message ?? ''), 'adding an account that holds no part of the domain is still refused');
  }
}

// -- a key accepted under TWO groups loses both acceptances, in the one batch ------------------------
{
  // A rulebook can count one dimension under more than one group, and then the same item sits on two
  // comparison rows and can be accepted on both. A reassignment that cleared only the first would leave
  // the second standing against an account that no longer holds the item, which is the same lie.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-assign-groups',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"},{"offer":"Line","counts":"extensions.total","group":"lines"}]' };
  const { cache } = fakeCache();
  const BRANCH_USERS = () => [
    { user: '100', 'name-first-name': 'Ann', 'name-last-name': 'Lee', site: 'North', 'service-code': '' },
    { user: '200', 'name-first-name': 'Sam', 'name-last-name': 'Roe', site: 'South', 'service-code': '' },
  ];
  const ns = { get: async (p: string) => (/\/users$/.test(p) && p.includes('/domains/branch.example/') ? BRANCH_USERS() : []) } as never;
  const readSource = { getSubscriptions: async () => [
    { subscriptionId: 'SUB1', subscriptionOffer: [
      { name: 'Seat', quantity: '1', subscriptionCharge: [{ type: 'REC' }] },
      { name: 'Line', quantity: '1', subscriptionCharge: [{ type: 'REC' }] },
    ] },
  ] } as never;
  const f = fakeD1();
  const north = resolveAccountScope(REPORT(), { account: 'CLI00002' });
  const south = resolveAccountScope(REPORT(), { account: 'CLI00003' });

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), north, { canWrite: true, readSource, db: f.db });
  ok(rep.comparison.rows.map((r) => r.group).sort().join() === 'lines,seats', 'two rules over one dimension make two rows');
  ok(rep.comparison.rows.every((r) => r.items!.some((i) => i.key === 'branch.example/ext:100')), 'and the seat is on both of them');

  for (const group of ['seats', 'lines']) {
    await applyBaselineAction(env as never, cache, ns, REPORT(), north, f.db, 'ops@example.com',
      { action: 'accept', group, items: [{ key: 'branch.example/ext:100' }] }, { readSource });
  }
  const SEATS = itemRowKey('CLI00002', 'seats', 'branch.example/ext:100'), LINES = itemRowKey('CLI00002', 'lines', 'branch.example/ext:100');
  ok(f.items.has(SEATS) && f.items.has(LINES), 'the one seat is accepted under both groups');

  const batchesBefore = f.batches.length;
  await applyAssignment(env as never, cache, ns, REPORT(), f.db, 'ops@example.com',
    { domain: 'branch.example', key: 'ext:100', accountNumber: 'CLI00003' }, south, { readSource });
  ok(f.batches.length === batchesBefore + 1, 'the reassignment is still ONE batch');
  ok(f.batches[f.batches.length - 1]!.length === 8, 'now carrying both acceptance deletes with their history rows, the ONE unconditional delete that covers every group at once, the one-row-per-item delete, the assignment and its own');
  ok(!f.items.has(SEATS) && !f.items.has(LINES), 'and neither acceptance is left behind');
}

// -- one domain of two fails ------------------------------------------------------------------------
{
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-partial',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  const { ns } = fakeNs(/other\.example\/users$/);
  const { readSource } = fakeSubs('1');
  const north = resolveAccountScope(REPORT(), { account: 'CLI00002' });

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), north, { canWrite: true, readSource });
  ok(rep.partial === true, 'a whole-domain snapshot failure makes the report partial');
  ok(rep.readFailures.includes('other.example: could not be read'), 'and names the domain that could not be read');
  // The domain is the caller's own; the upstream message is not theirs to see. An NsApiError's message
  // is `GET <path> → <status>: <a slice of the response body>`, and this report is returned at 200 and
  // printed on the page — the same rule the route's 502 handler states, on the path that bypassed it.
  ok(rep.readFailures.every((f) => !/500|Internal Server Error|\(/.test(f)), 'and carries no part of what NetSapiens actually said');
  ok(rep.detail.extensions.some((x) => x.key === 'branch.example/ext:100'), 'the domain that DID read is still reported');
  ok(rep.domains.join() === 'branch.example,other.example', 'and the report still names every domain the account holds');
  ok(rep.domainTotals['other.example'] === undefined, 'while the failed domain contributes no totals');

  // Accepting anything here would record a decision made against half the inventory.
  const { db } = fakeD1();
  let refused: OnebillRequestError | null = null;
  try {
    await applyBaselineAction(env as never, cache, ns, REPORT(), north, db, 'ops@example.com',
      { action: 'accept', group: 'seats', all: true } as never, { readSource });
  } catch (e) { refused = e as OnebillRequestError; }
  ok(refused?.status === 409, 'accepting against a partial report is refused');
  ok(/refresh/i.test(refused?.message ?? ''), 'and the refusal says what to do about it');

  // Both domains failing is the old single-domain failure: nothing to render at all.
  const { cache: cache2 } = fakeCache();
  const { ns: allBad } = fakeNs(/\/users$/);
  let caught: AccountReadError | null = null;
  try { await loadAccountReport(env as never, cache2, allBad, REPORT(), north, { canWrite: true, readSource }); }
  catch (e) { caught = e as AccountReadError; }
  ok(caught instanceof AccountReadError, 'every domain failing throws rather than rendering an empty account');
  ok(caught?.system === 'netsapiens', 'naming NetSapiens, the system that failed');
}

// -- the report names the domain the caller actually opened -----------------------------------------
{
  // `resolveAccountScope` returns the account's WHOLE scope whichever selector reached it, so the
  // caller's own choice is gone by the time the account arrives here unless they say so. The page's
  // confirmations name this domain, and naming whichever one sorts first would name the wrong row.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-openedby',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  const { ns } = fakeNs();
  const { readSource } = fakeSubs('1');
  const byOther = resolveAccountScope(REPORT(), { domain: 'other.example' });
  ok(byOther.accountNumber === 'CLI00002' && byOther.domains.join() === 'branch.example,other.example', 'opening the second domain still resolves the whole account');

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), byOther, { canWrite: true, readSource, openedBy: 'other.example' });
  ok(rep.domain === 'other.example', 'the report names the domain the caller opened by');
  ok(rep.domains.join() === 'branch.example,other.example', 'while still listing every domain the account holds');

  const byNumber = await loadAccountReport(env as never, cache, ns, REPORT(), byOther, { canWrite: true, readSource });
  ok(byNumber.domain === 'branch.example', 'and falls back to the first domain when the account was opened by number');
}

// -- loadedAt is the OLDEST read behind the report ---------------------------------------------------
{
  // Two cache entries age independently, and the one an operator has to distrust is the stalest.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-oldest',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { store, cache } = fakeCache();
  const { ns } = fakeNs();
  const { readSource } = fakeSubs('1');

  const fresh = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource });
  ok(fresh.loadedAt > '2026-01-01T00:00:00.000Z', 'both halves start fresh');

  // Age the DOMAIN entry only, addressed through the module's own key derivation rather than a second
  // copy of it here - a key the test computed its own way could agree with itself and prove nothing.
  const key = (await domainEntryKey(env as never, 'acme.example')).url;
  const aged = await store.get(key)!.clone().json() as Record<string, unknown>;
  aged.loadedAt = '2026-01-01T00:00:00.000Z';
  store.set(key, new Response(JSON.stringify(aged), { headers: { 'content-type': 'application/json' } }));

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource });
  ok(rep.loadedAt === '2026-01-01T00:00:00.000Z', 'loadedAt is the oldest entry behind the report, not the newest');
}

// -- NS_FAX_SERVER_HOSTS reaches the counter, and the cache key moved with it ----------------------
// NetSapiens has no fax endpoint: a fax line is an ordinary number whose dial rule hands it to the fax
// server, so the HOST is the whole test and it belongs to the deployment. This is the wire between the
// env var and netsapiens-lib's `listDomainInventory`, which is the only place the two meet.
{
  const NUMBERS = [
    { phonenumber: '13175550100', 'dial-rule-translation-destination-user': '100' },
    { phonenumber: '13175550199', 'dial-rule-application': 'to-connection',
      'dial-rule-translation-destination-host': '203.0.113.7',
      'dial-rule-description': 'Portal Created: Phonenumber -> FaxServer' },
  ];
  const faxNs = () => ({ get: async (p: string) => {
    if (/\/users$/.test(p)) return USERS();
    if (/\/phonenumbers$/.test(p)) return NUMBERS;
    return [];
  } } as never);
  const RULES = '[{"offer":"Seat","counts":"dids.total","group":"numbers"},{"group":"Fax Lines","counts":"dids.fax"}]';
  const base = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    ONEBILL_RECURRING_RULES: RULES };
  const rowOf = (rep: Awaited<ReturnType<typeof loadAccountReport>>, g: string) => rep.comparison.rows.find((r) => r.group === g)!;

  {
    const env = { ...base, CACHE_SCOPE: 'test-fax', NS_FAX_SERVER_HOSTS: ' 203.0.113.7 ' };
    const { cache } = fakeCache();
    const rep = await loadAccountReport(env as never, cache, faxNs(), REPORT(), ACME(), { canWrite: true, readSource: fakeSubs('1').readSource });
    ok(rowOf(rep, 'Fax Lines').observed === 1, 'the configured host reaches the counter: one fax line');
    ok(rowOf(rep, 'numbers').observed === 1, 'and it is NOT also counted as a DID - two numbers, one of each');
    const fx = rep.detail.dids.find((n) => n.number === '13175550199')!;
    ok(fx.fax === true, 'the item behind it is flagged, so the page can chip it apart from a number');
    ok(fx.destination === 'to fax server', 'and reads "to fax server" rather than handing a reader the host');
    ok(!JSON.stringify(rep).includes('203.0.113.7'), 'the fax server address is nowhere in the report at all');
  }

  // The SAME domain with the setting absent. netsapiens-lib guesses no host, so the fax line is the
  // local DID it otherwise looks like — which is exactly the pre-0.7.0 behaviour, and exactly why a
  // cached entry built either way must not be served for the other.
  {
    const env = { ...base, CACHE_SCOPE: 'test-nofax' };
    const { cache } = fakeCache();
    const rep = await loadAccountReport(env as never, cache, faxNs(), REPORT(), ACME(), { canWrite: true, readSource: fakeSubs('1').readSource });
    ok(rowOf(rep, 'Fax Lines').observed === 0, 'with no host configured nothing is a fax line');
    ok(rowOf(rep, 'numbers').observed === 2, 'and both numbers count as DIDs');
    ok(rep.detail.dids.every((n) => n.fax === false), 'no item is flagged');
  }

  // Fax lines changed what a `domain` entry MEANS, so its shape segment had to move: a ten-minute-old v1
  // entry read as current would count every fax line as a DID while looking exactly like a fresh read.
  const key = (await domainEntryKey({ ...base, CACHE_SCOPE: 'test-fax' } as never, 'acme.example')).url;
  ok(key.includes('/domain/v4/'), 'the domain cache key carries the current shape segment');
  ok(!key.includes('/domain/v1/'), 'and no longer the v1 one, so every entry built before this is orphaned rather than trusted');
}

// -- NS_DEVICE_SUFFIXES reaches the counter, and Ringotel adds its own entry -----------------------
// The legend that says what a device-name suffix means here. Same wire as NS_FAX_SERVER_HOSTS: this is
// the only place the env and netsapiens-lib's `listDomainInventory` meet, and the only place the
// Ringotel integration's own suffix is folded in.
{
  const DEVICES: Record<string, unknown[]> = {
    '100': [
      { device: 'sip:100@acme.example', 'device-models-model': 'Yealink T54W' },
      { device: 'sip:100wp@acme.example' },
      { device: 'sip:100t@acme.example' },
      { device: 'sip:100r@acme.example' },
      // A suffix that is also an inherited Object key. It must read as unknown, and must not make the
      // Ringotel entry "already present" when it is the activation suffix.
      { device: 'sip:100constructor@acme.example' },
    ],
    '101': [{ device: 'sip:101@acme.example', 'device-models-model': 'Yealink T31P' }],
  };
  const devNs = () => ({ get: async (p: string) => {
    if (/\/users$/.test(p)) return USERS();
    const m = /\/users\/(\d+)\/devices$/.exec(p);
    if (m) return DEVICES[m[1]!] ?? [];
    return [];
  } } as never);
  const base = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const run = async (env: Record<string, unknown>) => {
    const { cache } = fakeCache();
    const rep = await loadAccountReport(env as never, cache, devNs(), REPORT(), ACME(), { canWrite: true, readSource: fakeSubs('1').readSource });
    const x = rep.detail.extensions.find((e) => e.ext === '100')!;
    return { rep, kindOf: (name: string) => x.devices.find((d) => d.name === name)!.kind, x };
  };

  // No setting, no Ringotel: netsapiens-lib's default legend, spelled out by `inventoryOpts` rather than
  // left absent — the Ringotel entry has to be added to something, and adding it to {} would drop these.
  {
    const { kindOf, x } = await run({ ...base, CACHE_SCOPE: 'test-suf-default' });
    ok(kindOf('100wp') === 'SNAPmobile Web' && kindOf('100t') === 'Teams', 'the default legend reaches the counter');
    ok(kindOf('100r') === '', 'and a suffix nobody has explained has no kind');
    ok(x.teams === true && x.deviceCount === 4, 'the Teams connector is detected and kept out of the count');
    ok(kindOf('100constructor') === '', 'a suffix that is an inherited Object key reads as unknown, not as something borrowed from the prototype');
  }

  // Ringotel on: its activation suffix joins the legend, labelled with the SHORT label — the tightest
  // surface on the page is a device chip, which is exactly what this labels.
  {
    const { kindOf, x } = await run({ ...base, CACHE_SCOPE: 'test-suf-rt', RINGOTEL_API_KEY: 'k', RINGOTEL_LABEL: 'Acme Voice App', RINGOTEL_LABEL_SHORT: 'Acme App' });
    ok(kindOf('100r') === 'Acme App', 'an enabled Ringotel adds its suffix, labelled with RINGOTEL_LABEL_SHORT');
    ok(kindOf('100wp') === 'SNAPmobile Web', 'and it is ADDED to the default legend, not put in place of it');
    ok(x.teams === true, 'Teams detection is untouched by it');
  }
  {
    const { kindOf } = await run({ ...base, CACHE_SCOPE: 'test-suf-rt-long', RINGOTEL_API_KEY: 'k', RINGOTEL_LABEL: 'Acme Voice App' });
    ok(kindOf('100r') === 'Acme Voice App', 'with no short label it falls back to RINGOTEL_LABEL');
  }
  {
    const { kindOf } = await run({ ...base, CACHE_SCOPE: 'test-suf-rt-sfx', RINGOTEL_API_KEY: 'k', RINGOTEL_ACTIVATION_SUFFIX: 'wp', RINGOTEL_LABEL_SHORT: 'Acme App' });
    ok(kindOf('100wp') === 'SNAPmobile Web', 'the Ringotel entry never OVERWRITES a suffix the legend already carries');
  }

  // The operator's own legend REPLACES the default wholesale. Here that turns Teams detection off, and
  // the device that was a connector becomes a handset counted like any other.
  {
    const { kindOf, x } = await run({ ...base, CACHE_SCOPE: 'test-suf-set',
      NS_DEVICE_SUFFIXES: '{"wp":{"label":"Acme Web"},"r":{"label":"Acme App"}}' });
    ok(kindOf('100wp') === 'Acme Web', 'a configured suffix is labelled from the configured legend');
    ok(kindOf('100t') === '', 'and one the operator left out is unknown, because the legend replaced the default');
    ok(x.teams === false && x.deviceCount === 5, 'so Teams detection is off and every device is a handset');
  }
  // An operator entry wins over the derived Ringotel one: an explicit legend entry is a decision.
  {
    const { kindOf } = await run({ ...base, CACHE_SCOPE: 'test-suf-both', RINGOTEL_API_KEY: 'k', RINGOTEL_LABEL_SHORT: 'Acme App',
      NS_DEVICE_SUFFIXES: '{"r":{"label":"Named By Hand"}}' });
    ok(kindOf('100r') === 'Named By Hand', 'the operator’s own entry for the Ringotel suffix is not overridden');
  }

  // `in` would answer true for every inherited Object name, so an activation suffix of `constructor`
  // would read as already in the legend and the Ringotel entry would be silently dropped.
  {
    const { kindOf } = await run({ ...base, CACHE_SCOPE: 'test-suf-proto', RINGOTEL_API_KEY: 'k',
      RINGOTEL_ACTIVATION_SUFFIX: 'constructor', RINGOTEL_LABEL_SHORT: 'Acme App' });
    ok(kindOf('100constructor') === 'Acme App', 'the Ringotel entry lands even on a suffix that is an inherited Object key');
  }
  // RINGOTEL_LABEL_SHORT is validated for a column header, not for a device chip, so it is held to the
  // same ceiling an operator's own label is — truncated rather than refused, since refusing would turn
  // a cosmetic setting into a broken account panel.
  {
    const { kindOf } = await run({ ...base, CACHE_SCOPE: 'test-suf-long', RINGOTEL_API_KEY: 'k',
      RINGOTEL_LABEL_SHORT: 'A'.repeat(60) });
    ok(kindOf('100r').length === 40, 'a Ringotel label longer than a suffix label may be is truncated to 40, not carried whole');
  }

  // The legend is baked into the cached inventory, so its arrival moved the shape segment with it.
  const key = (await domainEntryKey({ ...base, CACHE_SCOPE: 'test-suf-default' } as never, 'acme.example')).url;
  ok(key.includes('/domain/v4/'), 'the device-suffix legend moved the domain cache key, and the E911 endpoints moved it again');
  ok(!key.includes('/domain/v2/') && !key.includes('/domain/v3/'),
    'so every entry built before either, with no suffix on a device and no endpoint list at all, is orphaned rather than trusted');
}

// -- a stale acceptance can be cleared, never re-accepted ------------------------------------------
{
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-stale',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  const { ns } = fakeNs();
  const { readSource } = fakeSubs('1');
  // Two acceptances whose extensions are gone: one scoped, one in the pre-0003 BARE-key shape a cached
  // row can still show. Neither has scope meta, and the bare one has no domain in its key to fall back on.
  const { db, items } = fakeD1({ items: [
    { account_number: 'CLI00001', group_key: 'seats', item_key: 'acme.example/ext:900', label: '900 — Gone Away', offer: null, note: null, decided_by: 'ops@example.com', decided_at: '2026-01-01T00:00:00.000Z' },
    { account_number: 'CLI00001', group_key: 'seats', item_key: 'ext:901', label: '901 — Older Still', offer: null, note: null, decided_by: 'ops@example.com', decided_at: '2026-01-01T00:00:00.000Z' },
  ] });

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource, db });
  ok(rep.comparison.rows[0]!.stale === 2, 'an acceptance whose extension is gone reads as stale');
  const bare = rep.comparison.rows[0]!.items!.find((i) => i.key === 'ext:901');
  ok(bare !== undefined && bare.domain === 'acme.example', 'a pre-0003 unscoped key is decorated from the account rather than throwing');
  ok(bare?.attribution === 'unknown', "and its attribution is 'unknown' - an item that is gone never got here any way at all");
  ok(rep.comparison.rows[0]!.items!.find((i) => i.key === 'acme.example/ext:900')?.attribution === 'unknown', 'a scoped stale key names its own domain but is equally unknown');

  const act = (req: Record<string, unknown>) =>
    applyBaselineAction(env as never, cache, ns, REPORT(), ACME(), db, 'ops@example.com', req as never, { readSource });
  let refused: OnebillRequestError | null = null;
  try { await act({ action: 'accept', group: 'seats', items: [{ key: 'acme.example/ext:900' }] }); } catch (e) { refused = e as OnebillRequestError; }
  ok(refused?.status === 409, 'accepting a stale key is refused - there is nothing there to look at');

  const after = await act({ action: 'clear', group: 'seats', items: [{ key: 'acme.example/ext:900' }, { key: 'ext:901' }] });
  ok(after.stale === 0 && items.size === 0, 'but clearing one is exactly how the housekeeping gets done');
}

// -- a shortfall is judged by the group row, not by items -------------------------------------------
{
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-shortfall',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  const { ns } = fakeNs();
  const { readSource } = fakeSubs('5');
  const { db } = fakeD1();

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource, db });
  ok(rep.comparison.rows[0]!.billed === 5 && rep.comparison.rows[0]!.observed === 2, 'five billed against two observed is a shortfall');
  ok(rep.comparison.rows[0]!.verdict === 'unbaselined', 'and starts unbaselined');

  const act = (req: Record<string, unknown>) =>
    applyBaselineAction(env as never, cache, ns, REPORT(), ACME(), db, 'ops@example.com', req as never, { readSource });
  const accepted = await act({ action: 'accept', group: 'seats', shortfall: true, note: 'ordered, not built yet' });
  ok(accepted.verdict === 'accepted' && accepted.groupRow!.accepted === 2, 'accepting the shortfall records what was observed');
  ok(accepted.groupRow!.billed === 5, 'and what was billed, so a later billing change reads as drift');
  ok(accepted.unreviewed === 2, 'the items stay unreviewed - a shortfall says nothing about the seats that DO exist');
  ok(accepted.groupRow!.note === 'ordered, not built yet', 'and the note the operator wrote about the shortfall is on the shortfall');

  // Clearing the shortfall is `clearGroup`, which takes the item acceptances with it. With one standing,
  // the request would discard a decision it does not mention, so it is refused rather than obeyed.
  await act({ action: 'accept', group: 'seats', items: [{ key: 'acme.example/ext:100' }] });
  let refused: OnebillRequestError | null = null;
  try { await act({ action: 'clear', group: 'seats', shortfall: true }); } catch (e) { refused = e as OnebillRequestError; }
  ok(refused?.status === 409, 'clearing a shortfall while an item is accepted is refused');
  ok(/Clear all/.test(refused?.message ?? ''), 'and the refusal names the two ways forward');
  ok((await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource, db })).comparison.rows[0]!.groupRow !== undefined, 'and it changed nothing');

  await act({ action: 'clear', group: 'seats', items: [{ key: 'acme.example/ext:100' }] });
  const cleared = await act({ action: 'clear', group: 'seats', shortfall: true });
  ok(cleared.verdict === 'unbaselined' && cleared.groupRow === undefined, 'with no accepted item in the way it takes the group row away');
}

// -- accepting every item on a SHORTFALL row does not accept the shortfall --------------------------
{
  // Two seats exist, three are billed. Saying "these two seats are fine" is not the same statement as
  // "and the one we bill for that does not exist is fine too" — the derived completion write used to
  // conflate them the moment `unreviewed` hit zero.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-shortfall-all',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  const { ns } = fakeNs();
  const { readSource } = fakeSubs('3');
  const { db, groups } = fakeD1();

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource, db });
  ok(rep.comparison.rows[0]!.billed === 3, 'three billed');
  ok(rep.comparison.rows[0]!.observed === 2, 'against two observed - a shortfall with items on it');
  ok(rep.comparison.rows[0]!.unreviewed === 2, 'both seats start unreviewed');

  const after = await applyBaselineAction(env as never, cache, ns, REPORT(), ACME(), db, 'ops@example.com',
    { action: 'accept', group: 'seats', all: true }, { readSource });
  ok(after.unreviewed === 0, 'accept all accepts both present items');
  ok(after.items!.every((i) => i.status === 'accepted'), 'and every one of them reads accepted');
  ok(after.groupRow === undefined, 'but writes NO group row - the shortfall was never accepted');
  ok(groups.size === 0, 'and nothing reached the group table');
  ok(after.verdict === 'unbaselined', 'so the shortfall still reads unbaselined, which is the truth');
}

// -- an exactly-matched row records its baseline too, so a later billing change is drift -------------
{
  // Twelve seats exist and twelve are billed. Accepting them all is a statement about a count the
  // operator checked, and it has to be recorded: without the group row, a bill that moves to thirteen
  // reads as "nobody has looked at this yet" rather than "this changed after it was signed off".
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-match-baseline',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  const twelve = Array.from({ length: 12 }, (_, i) => ({
    user: String(200 + i), 'name-first-name': 'Seat', 'name-last-name': String(i + 1), site: 'North',
    'service-code': '', 'user-scope': 'Basic User',
  }));
  const ns = { get: async (p: string) => (/\/users$/.test(p) ? twelve : []) } as never;
  const { db } = fakeD1();

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(),
    { canWrite: true, readSource: fakeSubs('12').readSource, db });
  ok(rep.comparison.rows[0]!.billed === 12 && rep.comparison.rows[0]!.observed === 12, 'twelve billed against twelve observed');
  ok(rep.comparison.rows[0]!.verdict === 'match', 'which reads as a match before anyone accepts anything');

  const after = await applyBaselineAction(env as never, cache, ns, REPORT(), ACME(), db, 'ops@example.com',
    { action: 'accept', group: 'seats', all: true }, { readSource: fakeSubs('12').readSource });
  ok(after.unreviewed === 0, 'accept all accepts all twelve');
  ok(after.verdict === 'match', 'and the row still reads match - accepting a match does not change what is true');
  ok(after.groupRow !== undefined, 'but a group row IS written, which is the point');
  ok(after.groupRow!.billed === 12, 'recording the billed count at the moment of the decision');
  ok(after.groupRow!.accepted === 12, 'and what was accepted');

  // Same account, same cache scope, same acceptances - only the bill moved.
  const moved = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(),
    // Past the refresh cooldown, or the refresh is served from the entry the acceptance was made against.
    { canWrite: true, readSource: fakeSubs('13').readSource, db, refresh: true, now: new Date(Date.now() + (REFRESH_COOLDOWN_S + 1) * 1000) });
  const row = moved.comparison.rows[0]!;
  ok(row.billed === 13 && row.observed === 12, 'the bill moves to thirteen against the same twelve seats');
  ok(row.groupRow!.billed === 12, 'the baseline still says twelve were billed when it was signed off');
  ok(row.verdict === 'drift', 'so the change reads as drift rather than as a row nobody has looked at');
}

// -- accepting "all" of an EMPTY item list is refused ------------------------------------------------
{
  // `smsNumbers` has a list, and on this domain the list is empty. `unreviewed === 0` is vacuously
  // true of it; accepting "all" of nothing must not become a count acceptance of the billed one.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-emptylist',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"smsNumbers","group":"sms"}]' };
  const { cache } = fakeCache();
  const { ns } = fakeNs();
  const { readSource } = fakeSubs('1');
  const { db, groups } = fakeD1();

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource, db });
  ok(Array.isArray(rep.comparison.rows[0]!.items), 'the dimension has a list');
  ok(rep.comparison.rows[0]!.items!.length === 0, 'and on this domain the list is empty');

  let refused: OnebillRequestError | null = null;
  try {
    await applyBaselineAction(env as never, cache, ns, REPORT(), ACME(), db, 'ops@example.com', { action: 'accept', group: 'sms', all: true }, { readSource });
  } catch (e) { refused = e as OnebillRequestError; }
  ok(refused?.status === 409, 'accepting "all" of an empty list is a 409');
  ok(/shortfall/.test(refused?.message ?? ''), 'and the refusal names the action that WOULD work');
  ok(groups.size === 0, 'and no group row was written on the way out');
}

// -- a row with no item list cannot be accepted "all" -----------------------------------------------
{
  // `devices.total` is a real inventory number with no list behind it: itemsFor answers undefined, so
  // the row carries the count-model judgement and there is nothing for "all" to enumerate.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-nolist',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"devices.total","group":"handsets"}]' };
  const { cache } = fakeCache();
  const { ns } = fakeNs();
  const { readSource } = fakeSubs('4');
  const { db, groups } = fakeD1();

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: true, readSource, db });
  ok(rep.comparison.rows[0]!.items === undefined, 'a dimension with no list produces a row with no items');

  let refused: OnebillRequestError | null = null;
  try {
    await applyBaselineAction(env as never, cache, ns, REPORT(), ACME(), db, 'ops@example.com', { action: 'accept', group: 'handsets', all: true }, { readSource });
  } catch (e) { refused = e as OnebillRequestError; }
  ok(refused?.status === 409, 'accepting "all" of a row with nothing to enumerate is a 409');
  ok(/shortfall/.test(refused?.message ?? ''), 'and the refusal names the action that WOULD work');
  ok(groups.size === 0, 'and writes nothing - the refusal is not a quiet group-row acceptance');
}

// -- a swallowed per-extension read is named, not hidden --------------------------------------------
{
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-devfail',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  // 101's device read fails with a 500. The snapshot swallows it so one broken user cannot abort the
  // whole inventory; the report has to say which one, or a zero device count reads as a fact.
  const { ns } = fakeNs(/\/users\/101\/devices$/);
  const { readSource } = fakeSubs('1');

  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: false, readSource });
  ok(JSON.stringify(rep.readFailures) === JSON.stringify(['acme.example: devices for 101']), 'the extension whose device read failed is named, under its domain');
  ok(rep.partial === false, 'one extension is not a whole domain - the report is not partial');
  const ext101 = rep.detail.extensions.find((x) => x.ext === '101');
  ok(ext101 !== undefined, 'and the extension is still in the report - the failure was the devices, not the seat');
  ok(ext101!.deviceCount === 0, 'with a device count of zero that only readFailures stops an operator reading as a fact');
  ok(rep.comparison.rows[0]!.items!.length === 2, 'and the seats row still lists both extensions');

  const cachedAgain = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: false, readSource });
  ok(JSON.stringify(cachedAgain.readFailures) === JSON.stringify(['acme.example: devices for 101']), 'and the warning survives the cache, like detail does');

  // The per-user SMS read has the same contract and gets its own line, so the two are never confused.
  const { cache: smsCache } = fakeCache();
  const { ns: smsNs } = fakeNs(/\/users\/101\/smsnumbers$/);
  const smsRep = await loadAccountReport(env as never, smsCache, smsNs, REPORT(), ACME(), { canWrite: false, readSource });
  ok(JSON.stringify(smsRep.readFailures) === JSON.stringify(['acme.example: SMS for 101']), 'a failed per-user SMS read is named on its own line');
}

// -- the catalogue is read only when a rule needs one -----------------------------------------------
{
  let catalogCalls = 0;
  const catalogSource: CatalogSource = {
    listProducts: async () => { catalogCalls++; return [{ code: 'PBX', name: 'Hosted PBX' }]; },
    getProduct: async () => { catalogCalls++; return { code: 'PBX', name: 'Hosted PBX', pricePlanInfos: [{ code: 'PBXSEAT', name: 'Seat' }] } as never; },
  };
  const base = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p' };

  {
    const env = { ...base, CACHE_SCOPE: 'test-nocat', ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
    const { cache } = fakeCache();
    const { ns } = fakeNs();
    const { readSource } = fakeSubs('1');
    const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: false, readSource, catalogSource });
    ok(catalogCalls === 0, 'a rulebook keyed by offer name never touches the catalogue');
    ok(rep.catalog === undefined, 'and the report says so by carrying none');
  }

  {
    const env = { ...base, CACHE_SCOPE: 'test-cat', ONEBILL_RECURRING_RULES: '[{"productCode":"PBX","counts":"extensions.total","group":"seats"}]' };
    const { cache } = fakeCache();
    const { ns } = fakeNs();
    const { readSource } = fakeSubs('1');
    const rep = await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: false, readSource, catalogSource });
    ok(catalogCalls > 0, 'a productCode rule reads the catalogue');
    ok(rep.catalog!.plans > 0, 'and the report carries how many plans it knows');
    ok(rep.catalog!.missingProducts.length === 0, 'with nothing missing here');
    ok(rep.comparison.rows[0]!.billed === 1, 'the "Seat" line matched through its product code');
    ok(rep.comparison.unmapped.length === 0, 'so nothing is unmapped');
  }

  // The catalogue is a OneBill read like any other, so its failure has to name OneBill. A raw throw
  // here would reach the route as "could not load the account" and send the operator to check
  // NetSapiens, which is the exact confusion AccountReadError exists to prevent.
  {
    const env = { ...base, CACHE_SCOPE: 'test-catfail', ONEBILL_RECURRING_RULES: '[{"productCode":"PBX","counts":"extensions.total","group":"seats"}]' };
    const { cache } = fakeCache();
    const { ns } = fakeNs();
    const { readSource } = fakeSubs('1');
    const broken: CatalogSource = {
      listProducts: async () => { throw new Error('503 Service Unavailable'); },
      getProduct: async () => { throw new Error('unreachable'); },
    };
    let caught: AccountReadError | null = null;
    try { await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: false, readSource, catalogSource: broken }); }
    catch (e) { caught = e as AccountReadError; }
    ok(caught instanceof AccountReadError, 'a failing catalogue read comes out as an AccountReadError');
    ok(caught?.system === 'onebill', 'naming OneBill, the system that actually failed');
    ok((caught?.cause as Error)?.message === '503 Service Unavailable', 'and keeping the original as cause');
  }
}

// -- the in-band "no subscriptions" error is an empty list here ----------------------------------
{
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p', CACHE_SCOPE: 'test2' };
  const cache = { match: async () => undefined, put: async () => {}, delete: async () => true } as unknown as Cache;
  const ns = { get: async () => [] } as never;
  const readSource = { getSubscriptions: async () => { throw Object.assign(new Error('10WS0001: No subscriptions found'), { code: '10WS0001' }); } };
  // An account this report does not know: it holds no link, so it holds no items either — which is
  // fine here, because the domain answers empty and there is nothing to attribute.
  const scope: ResolvedAccountScope = { accountNumber: 'CLI00009', scopes: [{ domain: 'empty.example' }], domains: ['empty.example'] };
  const rep = await loadAccountReport(env as never, cache, ns, REPORT(), scope, { canWrite: false, readSource });
  ok(rep.comparison.examined === 0, 'an account with no subscriptions reports zero examined, not a 500');
  ok(rep.comparison.unmapped.length === 0, 'and nothing unmapped');
}

// -- a failing read names WHICH system failed --------------------------------------------------
{
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p', CACHE_SCOPE: 'test3' };
  const cache = { match: async () => undefined, put: async () => {}, delete: async () => true } as unknown as Cache;
  const caught = async (ns: never, readSource: never): Promise<AccountReadError> => {
    try { await loadAccountReport(env as never, cache, ns, REPORT(), ACME(), { canWrite: false, readSource }); }
    catch (e) { return e as AccountReadError; }
    throw new Error('did not throw');
  };

  const okNs = { get: async () => [] } as never;
  const badNs = { get: async () => { throw Object.assign(new Error('401 Unauthorized'), { status: 401 }); } } as never;
  const okSubs = { getSubscriptions: async () => [] } as never;
  const badSubs = { getSubscriptions: async () => { throw new Error('502 Bad Gateway'); } } as never;

  const ob = await caught(okNs, badSubs);
  ok(ob.system === 'onebill', 'a OneBill failure names OneBill');
  ok(/^OneBill: /.test(ob.message), 'and prefixes the message with it');
  ok((ob.cause as Error)?.message === '502 Bad Gateway', 'and keeps the original as cause');

  const nsErr = await caught(badNs, okSubs);
  ok(nsErr.system === 'netsapiens', 'a NetSapiens failure names NetSapiens, not OneBill');
  ok(/^NetSapiens: /.test(nsErr.message), 'and prefixes the message with it');
  ok((nsErr.cause as { status?: number })?.status === 401, 'and keeps the status on the cause');
}

// -- a row on which every item is stale cannot be accepted "all" ------------------------------------
{
  // `present` is empty, so `acceptItems` would batch nothing and the route would answer 200 to a
  // request that did nothing — and the derived completion write below it would then record a group row
  // for a row on which nothing was accepted. A stale acceptance names an item the account no longer
  // holds; the only honest thing to do with one is clear it.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-all-stale',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  const empty = { get: async () => [] } as never;
  const { readSource } = fakeSubs('1');
  const { db, groups, items } = fakeD1({ items: [{
    account_number: 'CLI00001', group_key: 'seats', item_key: 'acme.example/ext:999', label: '999 — Gone',
    offer: null, note: null, decided_by: 'ops@example.com', decided_at: '2026-09-01T00:00:00.000Z',
  }] });

  const rep = await loadAccountReport(env as never, cache, empty, REPORT(), ACME(), { canWrite: true, readSource, db });
  const row = rep.comparison.rows[0]!;
  ok((row.items ?? []).length === 1, 'the row has an item list — the acceptance whose seat is gone');
  ok(row.items!.every((i) => i.status === 'stale'), 'and every item on it is stale');

  let refused: OnebillRequestError | null = null;
  try {
    await applyBaselineAction(env as never, cache, empty, REPORT(), ACME(), db, 'ops@example.com',
      { action: 'accept', group: 'seats', all: true }, { readSource });
  } catch (e) { refused = e as OnebillRequestError; }
  ok(refused?.status === 409, 'accepting all of them is refused rather than answered 200');
  ok(/every item on this row is stale/.test(refused?.message ?? ''), 'saying what is wrong');
  ok(/clear them instead/.test(refused?.message ?? ''), 'and what to do about it');
  ok(groups.size === 0, 'and no group row was recorded on the way');
  ok(items.size === 1, 'while the stale acceptance is still there for the operator to clear');
}

// -- the derived completion write refuses an all-stale row too --------------------------------------
{
  // The 409 above is the reachable case; this is the write itself. An all-stale row satisfies
  // `unreviewed === 0` while nothing on it is live, so a group row written there would record a
  // whole-group acceptance out of acceptances that name nothing the account holds. Reached by letting
  // the inventory EMPTY between the accept and the re-read that follows it — a cache that stores
  // nothing plus a NetSapiens that answers once, which is the shape of a seat deleted mid-decision.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-vanishing',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  // Nothing is ever stored, so every load re-reads and sees the world as it is by then.
  const cache = { match: async () => undefined, put: async () => {}, delete: async () => true } as unknown as Cache;
  let served = 0;
  const vanishing = { get: async (path: string) => {
    if (!/\/users$/.test(path)) return [];
    return served++ === 0 ? USERS().slice(0, 1) : [];
  } } as never;
  // Billed nothing, so `observed >= billed` holds and only the stale guard stands between this and a
  // group row.
  const readSource = { getSubscriptions: async () => [] };
  const { db, groups } = fakeD1();

  const after = await applyBaselineAction(env as never, cache, vanishing, REPORT(), ACME(), db, 'ops@example.com',
    { action: 'accept', group: 'seats', items: [{ key: 'acme.example/ext:100' }] }, { readSource: readSource as never });
  ok((after.items ?? []).length === 1 && after.items!.every((i) => i.status === 'stale'), 'the seat accepted a moment ago is stale by the re-read');
  ok(after.unreviewed === 0, 'which leaves nothing unreviewed — the condition the completion write used to fire on');
  ok(groups.size === 0, 'and no group row was written for a row with nothing live on it');
}

// -- a reassignment clears acceptances the read never saw -------------------------------------------
{
  // F4: the acceptance clears were DERIVED from `readBaselines` taken before the batch, so an accept
  // landing on the leaving account in between survived on an item that account no longer holds. The
  // window is modelled by hiding one seeded acceptance from the item SELECT only — every write still
  // goes to the same store — so the read cannot name it and only an unconditional delete removes it.
  const env = { ONEBILL_TENANT_ID: 't', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p',
    CACHE_SCOPE: 'test-late-accept',
    ONEBILL_RECURRING_RULES: '[{"offer":"Seat","counts":"extensions.total","group":"seats"}]' };
  const { cache } = fakeCache();
  const { ns } = fakeNs();
  const { readSource } = fakeSubs('1');
  const LATE = 'seats';
  const f = fakeD1({ items: [{
    account_number: 'CLI00002', group_key: LATE, item_key: 'branch.example/ext:100', label: '100 — Ann Lee, North',
    offer: null, note: null, decided_by: 'ops@example.com', decided_at: '2026-09-03T12:00:00.000Z',
  }] });
  const db = {
    prepare: (sql: string) => {
      const st = f.db.prepare(sql) as unknown as { bind: (...a: unknown[]) => unknown; all: () => Promise<{ results: Record<string, unknown>[] }> };
      if (!/^\s*SELECT\b/i.test(sql) || !sql.includes('billing_baseline_item')) return st;
      const hidden = { bind: (...a: unknown[]) => { st.bind(...a); return hidden; }, all: async () => ({ results: [] as Record<string, unknown>[], success: true, meta: {} }) };
      return hidden;
    },
    batch: (list: readonly unknown[]) => (f.db as unknown as { batch: (l: readonly unknown[]) => unknown }).batch(list),
  } as unknown as D1Database;

  const ROW = itemRowKey('CLI00002', LATE, 'branch.example/ext:100');
  ok(f.items.has(ROW), 'the acceptance is in the store');
  ok((await readBaselines(db, 'CLI00002')).length === 0, 'and invisible to the read the clears are derived from');

  const south = resolveAccountScope(REPORT(), { account: 'CLI00003' });
  await applyAssignment(env as never, cache, ns, REPORT(), db, 'ops@example.com',
    { domain: 'branch.example', key: 'ext:100', accountNumber: 'CLI00003' }, south, { readSource });
  ok(!f.items.has(ROW), 'and the reassignment deletes it anyway — the delete is the truth, not the read');
  ok(f.history.filter((h) => h.table === 'billing_baseline_item_history').length === 0,
    'while the history stays derived from the read: an unconditional delete cannot say what it removed');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
