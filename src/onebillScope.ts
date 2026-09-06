/**
 * The account graph over a link report, account resolution, and item→account attribution scoped to
 * one account.
 *
 * ## Why a separate module
 *
 * `onebillAccount.ts` compares ONE domain against ONE account's subscriptions — the whole-domain
 * case. This module is the account-scoped generalisation: an account may hold several domains and
 * several sites, and a domain may be split across several accounts by site. Nothing here reads
 * NetSapiens or OneBill; it is a pure join over a `LinkReport` (already fetched) and the per-domain
 * inventory/attribution reads a caller supplies via {@link DomainRead}.
 *
 * ## Domain-qualified keys, and only here
 *
 * An item compared within one domain is keyed by its bare `InventoryItem.key` (`ext:100`). Once an
 * account can span domains, that key alone is ambiguous — two domains can both have an `ext:100` —
 * so every item inside a {@link ScopedInventory} is re-keyed `<domain>/<bare key>` by {@link scopedKey}.
 * `splitScopedKey` is the only place that reverses it. An `Assignment` (from `onebillAssignment.ts`)
 * stays keyed by domain + BARE key, because it is a fact about one domain's item, not about the
 * account-scoped view built here.
 *
 * ## No NetSapiens record passes through
 *
 * `scopeInventory` only re-keys and re-buckets the allowlisted item objects `listDomainInventory`
 * already produced (see `@dszp/netsapiens-lib`'s `inventory.ts`); it never touches a raw record.
 *
 * ## System users are placed, never compared, and never Unassigned
 *
 * `systemUsers` — auto attendants, queues, time-of-day routers — are informational: `itemsFor` has no
 * list for them, so no rulebook can key on one. They are still SCOPED, because an account panel showing
 * none of them on a domain that has three reads as a fact about the domain rather than as a hole in the
 * scoping. Their site comes from the RECORD's own `site` and not from the domain attribution — nothing
 * walks routing for an object nobody bills — and from there they follow the same rule as an extension:
 * their site's holder, else the whole-domain holder, else dropped from the scoped view entirely. Dropped,
 * not Unassigned: the Unassigned list exists to prompt a billing decision, and there is no bill to make.
 * A manual assignment naming one is honoured exactly as it is for any other item.
 *
 * ## An ADDRESS can be on several accounts; nothing else can
 *
 * Every other item is a fact about one thing — a user, a number, a route — and belongs to one account.
 * An address is a fact about a PLACE. Users on four sites can reference one address, and two of those
 * sites' accounts can each legitimately bill an E911 bundle for it, so an address is placed on EVERY
 * account holding one of its referencing sites (each counting it once) and on the whole-domain holder
 * as well when a referencing site is unheld or the referencing users have no site. A manual assignment
 * on an address is therefore ADDITIVE — it adds an account, with a per-account remove — where on every
 * other kind it still replaces. `ScopedItemMeta.sharedWith` names the other holders on a placed item.
 *
 * ## `automatic` names a disagreement, not a fact about the item
 *
 * `ScopedItemMeta.automatic` answers "what would the automatic rule — site link, else whole-domain
 * link — have chosen instead?", as an account number plus the site only when a site link is what
 * would have chosen it. It is present on a `manual` item only when that answer differs from where the
 * manual assignment actually put it. An Unassigned item has no such field at all: unassigned only
 * happens when the automatic rule chose nothing, so there is nothing to disagree with — the reason
 * text already names the orphaned site.
 */
import { countInventoryDetail, itemLabel, type DomainAttribution, type DomainInventory, type DomainInventoryDetail, type ExtensionItem, type InventoryItem } from '@dszp/netsapiens-lib';
import { OnebillRequestError, type LinkReport } from './onebill.js';
import type { Assignment } from './onebillAssignment.js';

export interface Scope { domain: string; site?: string }
export interface ResolvedAccountScope { accountNumber: string; accountName?: string; scopes: Scope[]; domains: string[] }
export interface DomainHolders { whole?: { accountNumber: string; accountName?: string }; bySite: Record<string, { accountNumber: string; accountName?: string }> }

/**
 * Who bills this domain, read straight off `LinkRow.accounts` — the bare row for the whole-domain
 * holder (only when `linked`), the site rows for per-site holders. A `conflict` anywhere touched
 * throws rather than picking one of the claimants; the caller has to fix the link first.
 */
export function domainHolders(report: LinkReport, domain: string): DomainHolders {
  const holders: DomainHolders = { bySite: {} };
  const bare = report.rows.find((r) => r.domain === domain && !r.site);
  if (bare) {
    if (bare.state === 'conflict') {
      throw new OnebillRequestError(`${domain} has more than one account claiming it; fix the link first.`, 409);
    }
    if (bare.state === 'linked') {
      const a = bare.accounts[0]!;
      holders.whole = { accountNumber: a.accountNumber, ...(a.accountName === undefined ? {} : { accountName: a.accountName }) };
    }
  }
  for (const r of report.rows) {
    if (r.domain !== domain || r.site === undefined) continue;
    if (r.state === 'conflict') {
      throw new OnebillRequestError(`${domain} site ${r.site} has more than one account claiming it; fix the link first.`, 409);
    }
    if (r.state === 'linked') {
      const a = r.accounts[0]!;
      holders.bySite[r.site] = { accountNumber: a.accountNumber, ...(a.accountName === undefined ? {} : { accountName: a.accountName }) };
    }
  }
  return holders;
}

/** One account as a picker offers it: the number it is keyed by, and the name a human recognises. */
export interface AccountRef { accountNumber: string; accountName?: string }

/**
 * The accounts behind one domain's holders, unique and in account order.
 *
 * The ONE place this list is derived, because three callers need it and each one of them decides
 * something: the Move picker offers it, `scopeInventory` hands it out as an Unassigned item's
 * candidates, and `applyAssignment` bounds the account a move may name. Three copies of "the whole
 * holder, then each site holder, deduplicated" is three copies that can disagree about who holds what.
 */
export function holdersOf(holders: DomainHolders): AccountRef[] {
  const byNumber = new Map<string, AccountRef>();
  if (holders.whole) byNumber.set(holders.whole.accountNumber, holders.whole);
  for (const h of Object.values(holders.bySite)) if (!byNumber.has(h.accountNumber)) byNumber.set(h.accountNumber, h);
  return [...byNumber.values()].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
}

/** Every account that holds a piece of this domain, unique, sorted by account number — for the picker. */
export function accountHolders(report: LinkReport, domain: string): AccountRef[] {
  return holdersOf(domainHolders(report, domain));
}

/** Every scope (bare or site, `linked` only) a given account holds, across the whole report. */
function resolveByAccount(report: LinkReport, accountNumber: string): ResolvedAccountScope {
  const scopes: Scope[] = [];
  let accountName: string | undefined;
  for (const r of report.rows) {
    const match = r.accounts.find((a) => a.accountNumber === accountNumber);
    if (!match) continue;
    if (accountName === undefined) accountName = match.accountName;
    if (r.state === 'conflict') {
      const others = r.accounts.filter((a) => a.accountNumber !== accountNumber).map((a) => a.accountNumber).join(', ');
      throw new OnebillRequestError(`${accountNumber} claims ${r.domain} together with ${others}; fix the link first.`, 409);
    }
    if (r.state === 'linked') {
      scopes.push(r.site === undefined ? { domain: r.domain } : { domain: r.domain, site: r.site });
    }
  }
  if (scopes.length === 0) throw new OnebillRequestError(`${accountNumber} holds no link this report can see`, 409);
  scopes.sort((a, b) => (a.domain === b.domain ? (a.site ?? '').localeCompare(b.site ?? '') : a.domain.localeCompare(b.domain)));
  const domains = [...new Set(scopes.map((s) => s.domain))].sort();
  return { accountNumber, ...(accountName === undefined ? {} : { accountName }), scopes, domains };
}

/**
 * Which single account a `{ domain }` selector resolves to — see `resolveAccountScope`'s doc for the
 * per-state rules. The domain is matched EXACTLY, with no normalisation, so a caller must pass the
 * report's own spelling of it; the worker resolves whatever spelling the request carried against the
 * set of domains it can see before it gets here, and an unmatched one is a 409 rather than a guess.
 */
function resolveDomainToAccount(report: LinkReport, domain: string): string {
  const row = report.rows.find((r) => r.domain === domain && !r.site);
  if (!row) throw new OnebillRequestError(`${domain} is not in this report - reload the links page.`, 409);
  if (row.state === 'conflict') {
    throw new OnebillRequestError(`${domain} has more than one account claiming it; fix the link first.`, 409);
  }
  if (row.state === 'linked') return row.accounts[0]!.accountNumber;
  if (row.state === 'unlinked') {
    throw new OnebillRequestError(`${domain} is not linked to exactly one OneBill account (${row.state}).`, 409);
  }
  // split
  const siteAccounts = row.siteAccounts ?? [];
  const unique = [...new Map(siteAccounts.map((sa) => [sa.account.accountNumber, sa.account] as const)).values()];
  // A split row whose site links have all gone is the `unlinked` fact wearing another state's name, and it
  // gets that sentence: "billed per site to 0 accounts ()" named a list that does not exist.
  if (!unique.length) throw new OnebillRequestError(`${domain} is not linked to exactly one OneBill account (${row.state}).`, 409);
  if (unique.length === 1) return unique[0]!.accountNumber;
  const list = unique.map((a) => a.accountNumber).join(', ');
  throw new OnebillRequestError(`${domain} is billed per site to ${unique.length} accounts (${list}); open a site row`, 409);
}

/**
 * Resolve a `{ domain }` or `{ account }` selector to the account's FULL scope — every domain and
 * site it holds, not just the one the caller named. See the module doc block above `domainHolders`
 * for the per-state rules a `{ domain }` selector follows before it delegates to the account walk.
 */
export function resolveAccountScope(report: LinkReport, sel: { domain: string } | { account: string }): ResolvedAccountScope {
  const accountNumber = 'account' in sel ? sel.account : resolveDomainToAccount(report, sel.domain);
  return resolveByAccount(report, accountNumber);
}

export const scopedKey = (domain: string, key: string): string => `${domain}/${key}`;
export function splitScopedKey(k: string): { domain: string; key: string } {
  const i = k.indexOf('/');
  if (i === -1) throw new Error(`splitScopedKey: not a scoped key (missing '/'): ${k}`);
  return { domain: k.slice(0, i), key: k.slice(i + 1) };
}

export type Attribution = 'manual' | 'site' | 'domain';
/**
 * `automatic` names what the AUTOMATIC rule (site link, else whole-domain link) would have chosen
 * for this item — the account, and the site only when a site link is what would have chosen it. It
 * appears only on a `manual` item whose automatic owner differs from this account. `UnassignedItem`
 * has no such field: an item is Unassigned only when the automatic rule chose nothing at all (see
 * `scopeInventory`), and the reason text already names the orphaned site.
 */
export interface ScopedItemMeta {
  domain: string;
  site?: string;
  attribution: Attribution;
  automatic?: { accountNumber: string; site?: string };
  /**
   * The OTHER accounts holding this same item, sorted by account number — present only when there is
   * more than one, which only an ADDRESS can be (see {@link scopeInventory}). The page names them
   * under the item so an operator can see that the count they are reconciling is deliberately
   * duplicated across accounts rather than double-billed by mistake.
   */
  sharedWith?: AccountRef[];
}
export interface UnassignedItem {
  domain: string;
  key: string;
  label: string;
  reason: string;
  /**
   * The record behind {@link key}, so the panel can say what the thing IS — where a number routes,
   * what an extension has plugged in — beside the reason nothing claimed it. Carried on the row rather
   * than looked up in the report's `detail`, because `detail` is the ACCOUNT's slice and an unassigned
   * item is by definition not in it. Nothing here is a wider class of data than `detail` already
   * carries for an item the account does hold.
   */
  item: InventoryItem;
  /** The accounts that could take it — numbers AND names, because a picker of bare numbers asks the
   *  operator to recognise one. */
  candidates: AccountRef[];
  staleAssignment?: string;
}
export interface ScopedInventory {
  detail: DomainInventoryDetail;           // scoped, every item's key domain-qualified
  inventory: DomainInventory;              // countInventoryDetail(detail)
  meta: Record<string, ScopedItemMeta>;    // by scoped key
  unassigned: UnassignedItem[];            // across every domain the account touches
  domainTotals: Record<string, DomainInventory>;   // per domain, unscoped, for the "of the domain" line
}
export interface DomainRead { domain: string; detail: DomainInventoryDetail; attribution: DomainAttribution; assignments: Assignment[] }

/**
 * The human text behind a `how`/sites pair that ended up Unassigned. See `attribution.ts`'s `how`
 * vocabulary.
 *
 * `sites` rather than one site, because an ADDRESS can name several and every one of them is a site
 * nobody linked — naming the first and hiding the rest would send the operator to link one site and
 * find the address still here.
 */
export function reasonText(how: string, sites: string[]): string {
  if (sites.length === 1) return `site ${sites[0]} is not linked`;
  if (sites.length > 1) return `sites ${sites.slice(0, -1).join(', ')} and ${sites[sites.length - 1]} are not linked`;
  const r = how.replace(/^unattributed:/, '');
  if (r === 'no-site') return 'no site set';
  if (r.startsWith('routed-to:')) return `routed to ${r.slice('routed-to:'.length)}`;
  if (r === 'unreferenced') return 'no user references this address';
  if (r === 'sms-user-unknown') return "SMS number's user is unknown";
  return r;
}

/**
 * Scope one account's slice of inventory out of the per-domain reads it touches.
 *
 * Per item, per domain: a manual assignment naming a current holder wins outright; failing that, the
 * item's site attribution wins if that site is held; failing that, the domain's whole-account holder
 * (if any) takes the remainder; failing all three, the item is Unassigned with a reason and the
 * domain's current holders as candidates. AN ADDRESS IS THE EXCEPTION — see the module doc: its owners
 * are a set, and a manual assignment joins that set rather than replacing it. An assignment naming an account that no longer holds
 * anything in this domain is ignored for placement and only resurfaces (as `staleAssignment`) if the
 * item ends up Unassigned regardless. So on a PLACED item such an assignment is invisible — nothing on
 * the panel says it exists — and it stays that way until that account holds the domain again, at which
 * point the assignment starts winning outright.
 */
/** Where an item sits, as the placement rules read it: every site it belongs to, and why. */
interface At { sites: string[]; how: string }
/** One account that holds an item, and how it got there. `site` is set only on a `site` placement. */
interface Owner { account: string; attribution: Attribution; site?: string }

/** Only an ADDRESS gets the set rule. The prefix is `listDomainInventory`'s, and the one place it is read. */
const isAddress = (bareKey: string): boolean => bareKey.startsWith('addr:');

/** The holder record behind an account number, so `sharedWith` carries the NAME an operator recognises. */
function refOf(accountNumber: string, holders: DomainHolders): AccountRef {
  const hit = holdersOf(holders).find((a) => a.accountNumber === accountNumber);
  return hit ?? { accountNumber };
}

/**
 * What the AUTOMATIC rule chooses — site link, else whole-domain link — with no assignment in it.
 *
 * One account for every kind but an address, where it is a SET: an address is a fact about a place,
 * four sites can reference one, each of their accounts can legitimately bill an E911 bundle for it,
 * and a rule that picks one leaves the others short. Each holding account counts it ONCE however many
 * of its sites reference it — the bundle is per place, not per user.
 *
 * The whole-domain holder is in the address set when the address has no site at all, or when ANY
 * referencing site is unheld: those users are the remainder, which is exactly what a whole-domain link
 * covers. For every other kind the whole-domain holder is the fallback it has always been.
 */
function autoOwners(at: At, holders: DomainHolders, address: boolean): Owner[] {
  // A site name is caller-supplied NetSapiens data — Object.hasOwn (not bracket-truthiness) keeps a site
  // literally named `constructor` or `toString` from resolving through the prototype chain to a function
  // and reading as "held".
  const held = (site: string): boolean => Object.hasOwn(holders.bySite, site);
  if (!address) {
    const site = at.sites.find(held);
    if (site) return [{ account: holders.bySite[site]!.accountNumber, attribution: 'site', site }];
    return holders.whole ? [{ account: holders.whole.accountNumber, attribution: 'domain' }] : [];
  }
  const byAccount = new Map<string, Owner>();
  let unheld = false;
  for (const site of at.sites) {
    if (!held(site)) { unheld = true; continue; }
    const account = holders.bySite[site]!.accountNumber;
    if (!byAccount.has(account)) byAccount.set(account, { account, attribution: 'site', site });
  }
  if (holders.whole && (at.sites.length === 0 || unheld) && !byAccount.has(holders.whole.accountNumber)) {
    byAccount.set(holders.whole.accountNumber, { account: holders.whole.accountNumber, attribution: 'domain' });
  }
  return [...byAccount.values()];
}

/**
 * The automatic owners and the manual ones, resolved into who actually holds the item.
 *
 * For an address the two are UNIONED — a manual assignment ADDS an account, because the automatic
 * placements it sits beside are each a real E911 bundle somebody bills. For every other kind a manual
 * assignment REPLACES the automatic one, which is the one-account rule unchanged. An account in both
 * reads as `manual`: the operator's decision is the more specific fact about that account.
 */
function ownersOf(auto: Owner[], manual: Assignment[], address: boolean): Owner[] {
  if (!address) return manual.length ? [{ account: manual[0]!.accountNumber, attribution: 'manual' }] : auto;
  const byAccount = new Map(auto.map((o) => [o.account, o] as const));
  for (const a of manual) byAccount.set(a.accountNumber, { account: a.accountNumber, attribution: 'manual' });
  return [...byAccount.values()].sort((x, y) => x.account.localeCompare(y.account));
}

export function scopeInventory(account: ResolvedAccountScope, reads: DomainRead[], holdersByDomain: Record<string, DomainHolders>): ScopedInventory {
  // A caller mistake here — a missing/duplicated/short read — would otherwise render a plausible
  // but silently incomplete panel, which is worse than a thrown error naming the gap.
  const domainsSeen = new Set<string>();
  for (const r of reads) {
    if (domainsSeen.has(r.domain)) throw new Error(`scopeInventory: domain ${r.domain} appears more than once in reads`);
    domainsSeen.add(r.domain);
    if (!Object.hasOwn(holdersByDomain, r.domain)) throw new Error(`scopeInventory: no holders given for domain ${r.domain}`);
  }
  for (const d of account.domains) {
    if (!domainsSeen.has(d)) throw new Error(`scopeInventory: reads is missing ${d}, which ${account.accountNumber} holds`);
  }

  const detail: DomainInventoryDetail = { extensions: [], systemUsers: [], dids: [], e911Addresses: [], smsNumbers: [] };
  const meta: Record<string, ScopedItemMeta> = {};
  const unassigned: UnassignedItem[] = [];
  const domainTotals: Record<string, DomainInventory> = {};
  const me = account.accountNumber;
  for (const r of reads) {
    const holders = holdersByDomain[r.domain]!;
    const candidates = holdersOf(holders);
    const holderSet = new Set(candidates.map((a) => a.accountNumber));
    // MANY assignments can share one key now: an address is placed on a set of accounts, so its manual
    // half is a set too. Every other kind still has at most one — the ROUTE is what enforces that.
    const byKey = new Map<string, Assignment[]>();
    for (const a of r.assignments) { const l = byKey.get(a.key) ?? []; l.push(a); byKey.set(a.key, l); }
    domainTotals[r.domain] = countInventoryDetail(r.detail);
    /**
     * Put one list's items on this account, or not.
     *
     * `siteOf` is where an item's site comes from: the domain's ATTRIBUTION for the four billable lists,
     * which walks routing to answer "which site does this number serve?", and the record's own `site`
     * for system users, which are not attributed because nothing compares them. `orphan` is what becomes
     * of an item no holder claims — `unassigned` surfaces it so somebody decides, `drop` leaves it out of
     * the scoped view, which is right only where there is no billing decision to prompt for. `how` is
     * read only on the `unassigned` path, to write the reason.
     */
    const place = <T extends InventoryItem>(
      list: T[],
      into: T[],
      siteOf: (item: T) => At,
      orphan: 'unassigned' | 'drop',
    ): void => {
      for (const item of list) {
        const at = siteOf(item);
        const asgs = byKey.get(item.key) ?? [];
        // Manual assignments naming an account that no longer holds any of this domain are ignored for
        // PLACEMENT and only resurface as `staleAssignment` on an item that ends up Unassigned anyway.
        const manual = asgs.filter((a) => holderSet.has(a.accountNumber));
        // ADDRESSES ARE A SET, everything else is one account. An address is a fact about a place: four
        // sites can reference one, each of their accounts can legitimately bill an E911 bundle for it,
        // and a rule that picks one leaves the others short. A user, a number and an SMS number are each
        // a fact about ONE thing, so the one-account rule is right for them and unchanged.
        const address = isAddress(item.key);
        const auto = autoOwners(at, holders, address);
        const owners = ownersOf(auto, manual, address);
        const mine = owners.find((o) => o.account === me);
        const sk = scopedKey(r.domain, item.key);
        if (mine) {
          into.push({ ...item, key: sk });
          // Who else holds the very same item. Only ever populated for an address, because only an
          // address can have more than one owner — the page uses it to say "also on <acct>" beside the
          // line rather than leaving the duplicate count reading as a double-bill.
          const others = owners.filter((o) => o.account !== me).map((o) => refOf(o.account, holders));
          // What the automatic rule would have chosen INSTEAD — a counterfactual, and only a non-address
          // has one. An address assignment ADDS an account rather than replacing one, so there is no
          // "instead" to name even when the automatic set holds exactly one other account: that account
          // still holds the address, right now, and `sharedWith` says so in the present tense. Naming it
          // here as what "would have" happened would describe a displacement that did not occur.
          const only = !address && auto.length === 1 && auto[0]!.account !== me ? auto[0]! : undefined;
          const automatic = mine.attribution === 'manual' && only
            ? { accountNumber: only.account, ...(only.site ? { site: only.site } : {}) }
            : undefined;
          meta[sk] = {
            domain: r.domain,
            attribution: mine.attribution,
            // The single site, when the item has exactly one. A multi-site address has no one site to
            // badge the row with, and `sharedWith` is what says where it actually is.
            ...(at.sites.length === 1 ? { site: at.sites[0]! } : {}),
            ...(automatic ? { automatic } : {}),
            ...(others.length ? { sharedWith: others } : {}),
          };
        } else if (!owners.length && orphan === 'unassigned') {
          // `owners` is empty here only when BOTH the manual and the automatic rules chose nothing, so
          // there is no `automatic` to report (see the doc comment on the type).
          unassigned.push({
            domain: r.domain,
            key: item.key,
            label: itemLabel(item),
            reason: reasonText(at.how, at.sites),
            item,
            candidates,
            ...(asgs.length && !manual.length ? { staleAssignment: asgs[0]!.accountNumber } : {}),
          });
        }
      }
    };
    // A caller-supplied attribution (a test, or an entry cached before `sites` existed — `readDomain`
    // treats one of those as a MISS, but the type does not promise it) is normalised here rather than
    // at every read: `sites` is the field every rule below is written against.
    const attributed = (item: InventoryItem): At => {
      const a = r.attribution.items[item.key];
      if (!a) return { sites: [], how: 'unattributed:no-site' };
      return { sites: a.sites ?? (a.site ? [a.site] : []), how: a.how };
    };
    // `how` is never read for a system user: it exists to explain an Unassigned item, and one of these
    // is dropped instead. `own-site` names where the site DID come from, for anyone reading a trace.
    const ownSite = (item: ExtensionItem): At => ({ sites: item.site ? [item.site] : [], how: 'own-site' });
    place(r.detail.extensions, detail.extensions, attributed, 'unassigned');
    place(r.detail.systemUsers, detail.systemUsers, ownSite, 'drop');
    place(r.detail.dids, detail.dids, attributed, 'unassigned');
    place(r.detail.e911Addresses, detail.e911Addresses, attributed, 'unassigned');
    place(r.detail.smsNumbers, detail.smsNumbers, attributed, 'unassigned');
  }
  return { detail, inventory: countInventoryDetail(detail), meta, unassigned, domainTotals };
}
