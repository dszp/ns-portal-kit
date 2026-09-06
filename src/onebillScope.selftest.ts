/** Offline test for account scoping. pnpm test:onebillscope */
import { resolveAccountScope, domainHolders, accountHolders, scopeInventory, scopedKey, splitScopedKey } from './onebillScope.js';
import { OnebillRequestError, type LinkReport } from './onebill.js';
import { listDomainInventory, attributeDomainInventory } from '@dszp/netsapiens-lib';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };
const acct = (n: string, name: string, links: { domain: string; site?: string }[]) => ({ accountNumber: n, accountName: name, status: 'Active', links, restricted: false });
const A1 = acct('CLI00001', 'Acme', [{ domain: 'acme.example' }]);
const A2 = acct('CLI00002', 'Branch North', [{ domain: 'branch.example', site: 'North' }, { domain: 'other.example' }]);
const A3 = acct('CLI00003', 'Branch South', [{ domain: 'branch.example', site: 'South' }]);
const REPORT = (): LinkReport => ({
  generatedAt: 'x', mode: 'quick', verifiedAt: null, usageStale: false, foreign: [], usage: [], usageOffers: [], decommission: [], accounts: [], failures: [], siteReadFailures: [], hiddenLinkCount: 0, requestCount: 0, retried: 0,
  rows: [
    { domain: 'acme.example', state: 'linked', accounts: [A1], sites: [], notes: [] },
    { domain: 'branch.example', state: 'split', accounts: [], sites: ['North', 'South', 'Annex'], linkedSites: ['North', 'South'], notes: [],
      siteAccounts: [{ site: 'North', account: A2, usageHolder: false }, { site: 'South', account: A3, usageHolder: false }] },
    { domain: 'branch.example', site: 'North', state: 'linked', accounts: [A2], sites: ['North', 'South', 'Annex'], siteCount: 2, notes: [] },
    { domain: 'branch.example', site: 'South', state: 'linked', accounts: [A3], sites: ['North', 'South', 'Annex'], siteCount: 2, notes: [] },
    { domain: 'other.example', state: 'linked', accounts: [A2], sites: [], notes: [] },
    { domain: 'dup.example', state: 'conflict', accounts: [acct('CLI00008', 'A', [{ domain: 'dup.example' }]), acct('CLI00009', 'B', [{ domain: 'dup.example' }])], sites: [], notes: [] },
  ],
} as unknown as LinkReport);
const thrown = (fn: () => unknown): OnebillRequestError => { try { fn(); } catch (e) { return e as OnebillRequestError; } throw new Error('did not throw'); };

// -- graph --------------------------------------------------------------------------------------
{
  const h = domainHolders(REPORT(), 'branch.example');
  ok(h.whole === undefined && h.bySite.North!.accountNumber === 'CLI00002' && h.bySite.South!.accountNumber === 'CLI00003', 'a split domain has site holders and no whole-domain holder');
  ok(domainHolders(REPORT(), 'acme.example').whole!.accountNumber === 'CLI00001', 'a linked domain has a whole-domain holder');
  ok(accountHolders(REPORT(), 'branch.example').map((a) => a.accountNumber).join() === 'CLI00002,CLI00003', 'accountHolders lists each holder once, in account order');
  ok(thrown(() => domainHolders(REPORT(), 'dup.example')).status === 409, 'a conflict domain is a 409');
}
// -- resolution ---------------------------------------------------------------------------------
{
  const r = resolveAccountScope(REPORT(), { account: 'CLI00002' });
  ok(r.accountNumber === 'CLI00002' && r.accountName === 'Branch North', 'an account resolves by number');
  ok(JSON.stringify(r.scopes) === JSON.stringify([{ domain: 'branch.example', site: 'North' }, { domain: 'other.example' }]), 'with every scope it holds, site and whole');
  ok(JSON.stringify(r.domains) === JSON.stringify(['branch.example', 'other.example']), 'and the sorted unique domain list');
  ok(resolveAccountScope(REPORT(), { domain: 'acme.example' }).accountNumber === 'CLI00001', 'a linked domain resolves to its account');
  ok(resolveAccountScope(REPORT(), { domain: 'other.example' }).scopes.length === 2, 'resolving by domain still returns ALL the account\'s scopes');
  ok(thrown(() => resolveAccountScope(REPORT(), { domain: 'branch.example' })).status === 409, 'a split parent billed to two accounts is a 409');
  ok(/two|2/.test(thrown(() => resolveAccountScope(REPORT(), { domain: 'branch.example' })).message), 'and says how many');
  const oneAcct = REPORT(); (oneAcct.rows[1] as { siteAccounts: unknown[] }).siteAccounts = [{ site: 'North', account: A2, usageHolder: false }];
  ok(resolveAccountScope(oneAcct, { domain: 'branch.example' }).accountNumber === 'CLI00002', 'a split parent whose sites all bill to one account resolves to it');
  // A split row whose site links have ALL gone. The count-and-list sentence would have said "billed per
  // site to 0 accounts ()", naming a list that does not exist; it is the unlinked fact, so it says that.
  const noAcct = REPORT(); (noAcct.rows[1] as { siteAccounts: unknown[] }).siteAccounts = [];
  const gone = thrown(() => resolveAccountScope(noAcct, { domain: 'branch.example' }));
  ok(gone.status === 409, 'a split parent with no site links left is a 409');
  ok(/is not linked to exactly one OneBill account \(split\)/.test(gone.message), 'and says it is not linked, not that it is billed to nobody');
  ok(!/0 accounts/.test(gone.message), 'never counting a list it does not have');
  ok(thrown(() => resolveAccountScope(REPORT(), { domain: 'dup.example' })).status === 409, 'a conflict domain is a 409');
  ok(thrown(() => resolveAccountScope(REPORT(), { account: 'CLI00008' })).status === 409, 'and so is an account inside one');
  ok(thrown(() => resolveAccountScope(REPORT(), { account: 'CLI09999' })).status === 409, 'an unknown account is a 409');
}
// -- keys ---------------------------------------------------------------------------------------
ok(scopedKey('acme.example', 'ext:100') === 'acme.example/ext:100', 'scoped key form');
ok(JSON.stringify(splitScopedKey('acme.example/addr:~1a2b3c4d')) === JSON.stringify({ domain: 'acme.example', key: 'addr:~1a2b3c4d' }), 'split on the first slash only');
ok(thrown(() => splitScopedKey('ext:100')) instanceof Error, 'a key with no slash throws rather than fabricating a domain');
// -- scoping ------------------------------------------------------------------------------------
{
  const snap = { meta: { domain: 'branch.example' }, users: [
    { user: '100', site: 'North', 'service-code': '', 'emergency-address-id': 'a-1', 'name-first-name': 'Ann', 'name-last-name': 'Lee' },
    { user: '200', site: 'South', 'service-code': '', 'emergency-address-id': 'a-1' },
    { user: '300', site: 'Annex', 'service-code': '' },
    { user: '400', site: '', 'service-code': '' },
    { user: '701', site: 'North', 'service-code': 'system-queue' },
  ], phonenumbers: [
    { phonenumber: '13175550100', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '100' },
    { phonenumber: '13175550101', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '701' },
  ], addresses: [{ 'emergency-address-id': 'a-1', 'address-name': 'Shared' }], smsnumbers: [] };
  const detail = listDomainInventory(snap), attribution = attributeDomainInventory(snap);
  const holders = { 'branch.example': domainHolders(REPORT(), 'branch.example') };
  const north = resolveAccountScope(REPORT(), { account: 'CLI00002' });
  const scopedNorth = { ...north, scopes: [north.scopes[0]!], domains: ['branch.example'] };   // just the branch domain for this test

  const s = scopeInventory(scopedNorth, [{ domain: 'branch.example', detail, attribution, assignments: [] }], holders);
  ok(s.detail.extensions.map((x) => x.key).join() === 'branch.example/ext:100', 'North gets its own extension, key domain-qualified');
  // BOTH numbers, since netsapiens-lib 0.5.0: one routes to North's own extension, and one routes to a
  // QUEUE that sits on North — a number serving a site's queue is that site's number, and treating it as
  // unattributed put a real billable DID in the Unassigned list on every domain with a queue.
  ok(s.detail.dids.map((n) => n.key).join() === 'branch.example/did:13175550100,branch.example/did:13175550101',
    'and both numbers routed to it, the queue one included');
  ok(s.inventory.extensions.total === 1 && s.inventory.dids.total === 2, 'counts follow the scoped lists');
  ok(s.meta['branch.example/ext:100']!.attribution === 'site' && s.meta['branch.example/ext:100']!.site === 'North', 'meta says how it got there');
  const un = s.unassigned.map((u) => `${u.key}:${u.reason}`).sort();
  ok(JSON.stringify(un) === JSON.stringify(['ext:300:site Annex is not linked', 'ext:400:no site set']), 'everything nobody holds is Unassigned, with a reason each');

  // ── an address is a fact about a PLACE, so it lands on EVERY account holding one of its sites ──
  // a-1 is referenced from North (CLI00002) and South (CLI00003). Both bill an E911 bundle for it, and
  // placing it on one of them left the other's E911 row short — which is the whole reason for the rule.
  ok(s.detail.e911Addresses.map((x) => x.key).join() === 'branch.example/addr:a-1', 'North holds the address its own users reference');
  ok(!s.unassigned.some((u) => u.key === 'addr:a-1'), 'and it is no longer Unassigned for being shared');
  const aMetaN = s.meta['branch.example/addr:a-1']!;
  ok(aMetaN.attribution === 'site' && aMetaN.site === undefined, 'placed by SITE, with no single site to name');
  ok(JSON.stringify(aMetaN.sharedWith) === JSON.stringify([{ accountNumber: 'CLI00003', accountName: 'Branch South' }]), 'and sharedWith names the OTHER holder, by number and name');
  const southAuto = scopeInventory(resolveAccountScope(REPORT(), { account: 'CLI00003' }), [{ domain: 'branch.example', detail, attribution, assignments: [] }], holders);
  ok(southAuto.detail.e911Addresses.length === 1, 'South holds the very same address');
  ok(JSON.stringify(southAuto.meta['branch.example/addr:a-1']!.sharedWith) === JSON.stringify([{ accountNumber: 'CLI00002', accountName: 'Branch North' }]), 'and its sharedWith names North');
  // An extension is NOT a place: the one-account rule is unchanged for every other kind.
  ok(s.meta['branch.example/ext:100']!.sharedWith === undefined, 'an extension never carries sharedWith - only an address can be in two accounts');
  ok(s.unassigned.every((u) => u.candidates.map((c) => c.accountNumber).join() === 'CLI00002,CLI00003'), 'every Unassigned item offers the domain\'s holders');
  // Numbers AND names: the panel's picker is a list an operator has to recognise one entry in.
  ok(s.unassigned.every((u) => u.candidates.map((c) => c.accountName).join() === 'Branch North,Branch South'), 'by name as well as by number');
  // The record behind the key, so the panel can say what the thing IS beside the reason nothing claimed
  // it. `detail` is the ACCOUNT's slice and an unassigned item is by definition not in it.
  ok(s.unassigned.every((u) => u.item !== undefined && u.item.key === u.key), 'and carries the record behind its own key');
  ok((s.unassigned.find((u) => u.key === 'ext:300')!.item as { name?: string }).name !== undefined, 'which for an extension is the extension record');
  ok(s.domainTotals['branch.example']!.extensions.total === 4, 'domain totals are unscoped');
  // System users are informational and never compared, but they must not VANISH: a panel showing zero
  // of them on a domain that has one reads as a fact, and a rule keyed on `systemUsers` would see a
  // shortfall that is really a scoping hole.
  ok(s.detail.systemUsers.map((x) => x.key).join() === 'branch.example/ext:701', 'a system user is scoped to the account holding its own site');
  ok(s.inventory.systemUsers.total === 1, 'and counted, so the scoped panel does not read zero');
  ok(s.meta['branch.example/ext:701']!.attribution === 'site' && s.meta['branch.example/ext:701']!.site === 'North', 'with meta like any other item');
  ok(!s.unassigned.some((u) => u.key === 'ext:701'), 'and never Unassigned - nothing bills it, so there is no decision to prompt for');

  // Manual assignment: the shared address to North; ext 200 (South by site) overridden to North.
  const asg = [
    { domain: 'branch.example', key: 'addr:a-1', accountNumber: 'CLI00002', label: 'Shared', decidedBy: 'x', decidedAt: 'y' },
    { domain: 'branch.example', key: 'ext:200', accountNumber: 'CLI00002', label: '200', decidedBy: 'x', decidedAt: 'y' },
    { domain: 'branch.example', key: 'ext:300', accountNumber: 'CLI00007', label: '300', decidedBy: 'x', decidedAt: 'y' },  // not a holder any more
  ];
  const m = scopeInventory(scopedNorth, [{ domain: 'branch.example', detail, attribution, assignments: asg }], holders);
  ok(m.detail.e911Addresses.length === 1 && m.meta['branch.example/addr:a-1']!.attribution === 'manual', 'an assigned address lands on the account as manual');
  ok(m.detail.extensions.some((x) => x.key === 'branch.example/ext:200') && m.meta['branch.example/ext:200']!.automatic?.site === 'South' && m.meta['branch.example/ext:200']!.automatic?.accountNumber === 'CLI00003', 'an override carries the account and site the automatic rule would have chosen');
  ok(!m.unassigned.some((u) => u.key === 'addr:a-1'), 'and leaves the Unassigned list');
  const stale = m.unassigned.find((u) => u.key === 'ext:300');
  ok(stale !== undefined && stale.staleAssignment === 'CLI00007', 'an assignment to a non-holder is ignored and shown as stale');
  const south = resolveAccountScope(REPORT(), { account: 'CLI00003' });
  const ms = scopeInventory(south, [{ domain: 'branch.example', detail, attribution, assignments: asg }], holders);
  ok(!ms.detail.extensions.some((x) => x.key === 'branch.example/ext:200'), 'the account the override left no longer has the item');
  ok(ms.detail.systemUsers.length === 0 && ms.inventory.systemUsers.total === 0, "and the other site's account sees none of North's system users");

  // Remainder rule: a whole-domain holder plus one site holder — the whole-domain account gets everything else.
  const mixed = { 'branch.example': { whole: { accountNumber: 'CLI00001' }, bySite: { North: { accountNumber: 'CLI00002' } } } };
  const whole = { accountNumber: 'CLI00001', scopes: [{ domain: 'branch.example' }], domains: ['branch.example'] };
  const w = scopeInventory(whole, [{ domain: 'branch.example', detail, attribution, assignments: [] }], mixed);
  ok(w.detail.extensions.map((x) => splitScopedKey(x.key).key).sort().join() === 'ext:200,ext:300,ext:400', 'the whole-domain account gets every extension not on a linked site');
  // North is held by CLI00002, South is held by NOBODY — so the address is on the site holder AND on the
  // remainder account, which is what covers the users the site links do not.
  ok(w.detail.e911Addresses.length === 1, 'an address with an unheld referencing site reaches the whole-domain account');
  ok(w.meta['branch.example/addr:a-1']!.attribution === 'domain', 'as the remainder, not as a site placement');
  ok(JSON.stringify(w.meta['branch.example/addr:a-1']!.sharedWith) === JSON.stringify([{ accountNumber: 'CLI00002' }]), 'sharing it with the site holder that does hold one of its sites');
  {
    // EVERY referencing site held: the remainder account has nobody left to cover, so it does not get it.
    const both = { 'branch.example': { whole: { accountNumber: 'CLI00001' }, bySite: { North: { accountNumber: 'CLI00002' }, South: { accountNumber: 'CLI00003' } } } };
    const wb = scopeInventory(whole, [{ domain: 'branch.example', detail, attribution, assignments: [] }], both);
    ok(wb.detail.e911Addresses.length === 0, 'an address whose every referencing site is held does NOT also fall to the whole-domain account');
  }
  // NEITHER number, since netsapiens-lib 0.5.0: one routes to North's extension and the other to a
  // queue that sits on North, so both are the site holder's and none falls to the remainder. The
  // remainder rule is unchanged — what moved is which items have a site at all.
  ok(w.detail.dids.length === 0, 'and no number, both of them being North\'s now');
  ok(w.unassigned.length === 0, 'and nothing is Unassigned');
  ok(w.meta['branch.example/ext:300']!.attribution === 'domain', 'attributed as domain');

  // An address referenced ONLY from a site nobody holds, on a domain with no whole-domain holder: there
  // is no account to put it on, so it is Unassigned and the reason names the site that would have.
  {
    const snapA = { meta: { domain: 'branch.example' }, users: [
      { user: '301', site: 'Annex', 'service-code': '', 'emergency-address-id': 'a-9' },
    ], phonenumbers: [], addresses: [{ 'emergency-address-id': 'a-9', 'address-name': 'Annex dock' }], smsnumbers: [] };
    const dA = listDomainInventory(snapA), atA = attributeDomainInventory(snapA);
    const a = scopeInventory(scopedNorth, [{ domain: 'branch.example', detail: dA, attribution: atA, assignments: [] }], holders);
    const row = a.unassigned.find((u) => u.key === 'addr:a-9');
    ok(row !== undefined && row.reason === 'site Annex is not linked', 'an address referenced only from an unheld site is Unassigned, naming the site');
    // TWO unheld sites: the reason names both rather than picking one and hiding the other.
    const snapB = { ...snapA, users: [...snapA.users, { user: '302', site: 'Barn', 'service-code': '', 'emergency-address-id': 'a-9' }] };
    const b = scopeInventory(scopedNorth, [{ domain: 'branch.example', detail: listDomainInventory(snapB), attribution: attributeDomainInventory(snapB), assignments: [] }], holders);
    ok(b.unassigned.find((u) => u.key === 'addr:a-9')!.reason === 'sites Annex and Barn are not linked', 'and two unheld sites name both');
  }

  // Manual assignment on an address ADDS an account; it never takes the automatic ones away.
  {
    const add = [{ domain: 'branch.example', key: 'addr:a-1', accountNumber: 'CLI00003', label: 'Shared', decidedBy: 'x', decidedAt: 'y' }];
    const n = scopeInventory(scopedNorth, [{ domain: 'branch.example', detail, attribution, assignments: add }], holders);
    ok(n.detail.e911Addresses.length === 1 && n.meta['branch.example/addr:a-1']!.attribution === 'site',
      'an assignment naming ANOTHER account leaves this one holding the address automatically');
    const t = scopeInventory(resolveAccountScope(REPORT(), { account: 'CLI00003' }), [{ domain: 'branch.example', detail, attribution, assignments: add }], holders);
    ok(t.meta['branch.example/addr:a-1']!.attribution === 'manual', 'and the named account holds it as manual');
    // An assignment naming an account no SITE gives it: the account joins the set, and the automatic
    // holders stay in it. This is the case the one-account rule could not express at all.
    const outsider = [{ domain: 'branch.example', key: 'addr:a-1', accountNumber: 'CLI00002', label: 'Shared', decidedBy: 'x', decidedAt: 'y' }];
    const o = scopeInventory(resolveAccountScope(REPORT(), { account: 'CLI00003' }), [{ domain: 'branch.example', detail, attribution, assignments: outsider }], holders);
    ok(o.detail.e911Addresses.length === 1 && o.meta['branch.example/addr:a-1']!.attribution === 'site', 'South keeps its automatic placement while North holds a manual one');
    // No `automatic` on an address, ever: it names a displacement, and an address assignment displaces
    // nothing. The account it would have named is still holding it, which `sharedWith` says outright.
    ok(t.meta['branch.example/addr:a-1']!.automatic === undefined, 'a manual address names no automatic counterfactual - nothing was displaced');
    ok(JSON.stringify(t.meta['branch.example/addr:a-1']!.sharedWith) === JSON.stringify([{ accountNumber: 'CLI00002', accountName: 'Branch North' }]), 'sharedWith names the other holder in the present tense instead');
  }

  // A site literally named `constructor` must not resolve through the object prototype.
  {
    const snapC = { meta: { domain: 'branch.example' }, users: [{ user: '999', site: 'constructor', 'service-code': '' }], phonenumbers: [], addresses: [], smsnumbers: [] };
    const detailC = listDomainInventory(snapC), attributionC = attributeDomainInventory(snapC);
    const c = scopeInventory(scopedNorth, [{ domain: 'branch.example', detail: detailC, attribution: attributionC, assignments: [] }], holders);
    ok(c.unassigned.some((u) => u.key === 'ext:999' && u.reason === 'site constructor is not linked'), 'a site named "constructor" does not fall through the prototype chain');
  }

  // Two domains at once: items stay under their own domain prefix and counts/totals are the union.
  {
    const snapOther = { meta: { domain: 'other.example' }, users: [{ user: '500', site: 'HQ', 'service-code': '' }], phonenumbers: [], addresses: [], smsnumbers: [] };
    const detailOther = listDomainInventory(snapOther), attributionOther = attributeDomainInventory(snapOther);
    const holdersUnion = { 'branch.example': domainHolders(REPORT(), 'branch.example'), 'other.example': domainHolders(REPORT(), 'other.example') };
    const u = scopeInventory(north, [
      { domain: 'branch.example', detail, attribution, assignments: [] },
      { domain: 'other.example', detail: detailOther, attribution: attributionOther, assignments: [] },
    ], holdersUnion);
    ok(u.detail.extensions.some((x) => x.key === 'branch.example/ext:100') && u.detail.extensions.some((x) => x.key === 'other.example/ext:500'), 'each domain\'s items keep their own domain prefix');
    ok(u.inventory.extensions.total === 2, 'and the counts are the union across domains');
    ok(Object.keys(u.domainTotals).sort().join() === 'branch.example,other.example', 'domain totals cover every domain the account touches');
  }

  // scopeInventory refuses to render a plausible-but-incomplete panel on a caller mistake.
  ok(thrown(() => scopeInventory(scopedNorth, [{ domain: 'branch.example', detail, attribution, assignments: [] }], {})) instanceof Error, 'a domain with no holdersByDomain entry throws rather than defaulting to no holders');
  ok(thrown(() => scopeInventory(scopedNorth, [
    { domain: 'branch.example', detail, attribution, assignments: [] },
    { domain: 'branch.example', detail, attribution, assignments: [] },
  ], holders)) instanceof Error, 'the same domain twice in reads throws');
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
