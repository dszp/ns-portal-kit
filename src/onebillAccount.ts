/**
 * One OneBill account's report: what the customer is billed for, beside what they actually have.
 *
 * The route's whole job in this area is auth and bounds; the reads, the cache and the assembly are here.
 *
 * ## The unit is an ACCOUNT, not a domain
 *
 * It was a domain until 2026-09-05, and that was wrong in both directions: an account holding two
 * domains was compared against one of them, and a domain split by site between two accounts could not
 * be opened at all. The unit is now the account's SCOPE — every domain and site it holds, resolved by
 * `onebillScope.ts` — and the inventory is the union of those domains, filtered to the items the
 * account actually holds. Everything a caller needs to name an item across that union is why item keys
 * inside this report are domain-qualified (`acme.example/ext:100`); see `onebillScope.ts`.
 *
 * ## The link is resolved from the LINK REPORT, not from OneBill
 *
 * `resolveAccountForDomain` (and `resolveAccountScope` behind it) read the same cached report the
 * links table is drawn from, so the account this panel opens is the account that table just named.
 * Re-resolving from OneBill would be a second lookup path that can disagree with the first, and the
 * operator would have no way to tell which one the page was showing them. The report is threaded
 * through every entry point here for the same reason — including `applyBaselineAction`, which
 * re-derives the scope on each of its loads rather than trusting a scope the client sent.
 *
 * ## Two cache kinds, because neither half belongs to the pair
 *
 * A `domain` entry holds one domain's inventory read; a `subs` entry holds one account's
 * subscriptions. Keying either by "account + domain" would re-read a shared domain once per account
 * and re-read an account's subscriptions once per domain it holds. Baselines and assignments are read
 * FRESH every load and merged after the cache — an accept is a decision the operator just made, and
 * their own click has to be visible on the page they land on.
 *
 * ## A whole domain can fail without taking the report with it
 *
 * With several domains in scope, one failing snapshot must not blank the panel. The report is then
 * `partial: true`, names the domain in `readFailures`, and hides the Accept controls: a decision made
 * against a half-read inventory would be recorded as though it had been made against all of it. Every
 * domain failing is the old single-domain case and still throws.
 *
 * ## Names reach this page now; credentials still never do
 *
 * The 2026-09-03 design kept this route to counts. That reversed on 2026-09-04, because a count you
 * cannot inspect is a count you cannot act on: an operator asked to accept "two extra seats" needs to
 * know WHICH two, and the acceptance has to record which two so a later swap is visible. So the report
 * carries `detail` — extension numbers and names, sites, phone numbers and E911 address labels — into
 * the response and into the ten-minute cache entry.
 *
 * What still never leaves: a device MAC, a SIP credential, a password, or a NetSapiens user's email
 * address. `detail` comes from `listDomainInventory` and the site attribution from
 * `attributeDomainInventory`, both of which copy a fixed allowlist of fields; no NetSapiens record is
 * passed through, and nothing that would carry one should be added here. (An operator's own identity
 * DOES leave, as `decidedBy` on an acceptance — that is the audit trail, and it comes from the
 * caller's `ns_t`, not from the domain being reported on.)
 */
import { DEFAULT_DEVICE_SUFFIXES, attributeDomainInventory, countInventoryDetail, fetchDomainSnapshot, itemLabel, itemsFor, listDomainInventory, type DeviceSuffixLegend, type DomainAttribution, type DomainInventory, type DomainInventoryDetail, type InventoryItem, type InventoryOptions, type NsClient } from '@dszp/netsapiens-lib';
import { compareRecurring, type ComparisonItem, type ComparisonRow, type GroupBaseline, type RecurringComparison, type Subscription } from '@dszp/onebill-lib';
import { OnebillRequestError, SUFFIX_LABEL_MAX, domainHash, entryKey, makeReadClient, parseDeviceSuffixes, resolveOnebillConfig, rulesUseCatalog, withinRefreshCooldown, type LinkReport, type OnebillEnv } from './onebill.js';
import { ringotelSuffixEntry, scopeOf } from './ringotel.js';
import { acceptItems, clearGroup, clearItemKeyStatement, clearItemStatements, clearItems, readBaselines, writeGroupRow } from './onebillBaseline.js';
import { loadCatalogIndex, type CatalogSource } from './onebillCatalog.js';
import { assignStatements, assignmentHistoryStatement, clearAssignmentStatements, clearOtherAssignmentsStatement, readAssignments, type Assignment } from './onebillAssignment.js';
import { domainHolders, holdersOf, resolveAccountScope, scopeInventory, scopedKey, splitScopedKey, type AccountRef, type Attribution, type DomainHolders, type DomainRead, type ResolvedAccountScope, type Scope, type ScopedItemMeta, type UnassignedItem } from './onebillScope.js';

// Re-exported so a consumer of the report imports the scope vocabulary from the same place as the
// report itself, rather than having to know that `onebillScope.ts` is where the join lives.
export { resolveAccountScope };
export type { AccountRef, Attribution, ResolvedAccountScope, Scope, ScopedItemMeta, UnassignedItem };

/** Ten minutes, matching the link report — the two are read together and should age together. */
const ACCOUNT_TTL_S = 600;

/**
 * What an inventory read needs and nothing more. Attendant menus are ROUTING, not inventory, and they
 * cost a dialplan read per attendant; the four opt-ins below are what the counter and the site
 * attribution actually consume — `includeUserSmsNumbers` in particular is what lets an SMS number be
 * attributed to a site through the user who holds it, rather than sitting Unassigned on every domain.
 *
 * ## What one domain costs
 *
 * Roughly **`2 × extensions + 6` subrequests**: the domain record and its top-level lists, then per
 * REAL extension one `/devices` and one `/smsnumbers` (plus an `/answerrules` per user). A Workers
 * request has a hard cap on subrequests, so a large domain can trip it — which is exactly why
 * {@link loadAccountReport} reads the domains ONE AT A TIME and catches each on its own: a domain
 * that hits the cap fails alone and lands in `readFailures` with `partial: true`, rather than taking
 * every other domain the account holds down with it.
 *
 * Change these options and bump the `entryKey` version segment (`v3` today), or a ten-minute-old entry
 * built with the old options is served as current. The same rule covers the INVENTORY options passed to
 * `listDomainInventory` — `NS_FAX_SERVER_HOSTS` changes which numbers are fax lines, and a cached entry
 * built before it was set counts every fax line as a DID while looking exactly like a current one. That
 * is what took the segment from `v1` to `v2`; the device-suffix legend, which adds `suffix` and `kind`
 * to every cached device and decides which of them is a Teams connector, took it from `v2` to `v3`.
 */
const DOMAIN_SNAPSHOT_OPTS = {
  includeAttendantMenus: false,
  includeAddresses: true,
  includeSmsNumbers: true,
  includeDevices: true,
  includeUserSmsNumbers: true,
} as const;

/**
 * One item on a comparison row, decorated with where it came from.
 *
 * `compareRecurring` knows keys and nothing else; the page needs to say which domain an item is on,
 * which site it sits at, and whether it got here automatically or because somebody assigned it. The
 * decoration is applied in {@link loadAccountReport} after the comparison, so onebill-lib stays free
 * of anything NetSapiens- or scope-shaped.
 *
 * `attribution` widens `ScopedItemMeta`'s by one value: a `stale` item — an acceptance whose
 * inventory item is gone — was never scoped, so nothing knows how it would have got here. Saying
 * `'unknown'` is the truth; saying `'domain'` would invent an attribution for an item that is not
 * there, and the page would show it beside real ones.
 */
export type ScopedComparisonItem = ComparisonItem & Omit<ScopedItemMeta, 'attribution'> & { attribution: Attribution | 'unknown' };

/** One comparison row whose items carry that decoration. */
export type ScopedComparisonRow = Omit<ComparisonRow, 'items'> & { items?: ScopedComparisonItem[] };

export interface AccountReport {
  accountNumber: string;
  accountName?: string;
  /** Every domain-or-site the account holds, in `onebillScope`'s sorted order. */
  scopes: Scope[];
  /** The unique domains behind {@link scopes}, sorted. Always the FULL list, even when one failed to read. */
  domains: string[];
  /**
   * The domain the caller opened by, when they did — kept so the page's confirmations can name the
   * row the operator actually clicked rather than whichever domain sorts first. Falls back to
   * `domains[0]` when the account was opened by account number instead.
   */
  domain: string;
  /**
   * When the oldest of the reads behind this report was taken — the subscriptions entry or one of the
   * per-domain entries, whichever is stalest. The oldest, not the newest, because it is the age an
   * operator has to distrust. Baselines are always fresher: see the header.
   */
  loadedAt: string;
  /** Counts over {@link detail} — the account's slice, not the domains' totals. */
  inventory: DomainInventory;
  /** The items behind the counts, keys domain-qualified. What an operator accepts one at a time. */
  detail: DomainInventoryDetail;
  /** Each in-scope domain's UNSCOPED totals, so the page can say "3 of the domain's 11". Absent for a domain that failed to read. */
  domainTotals: Record<string, DomainInventory>;
  /**
   * Human lines, one per thing the read could not answer for:
   * `"<domain>: could not be read (<message>)"`, `"<domain>: devices for 100, 101"`, `"<domain>: SMS for 102"`.
   *
   * The per-extension ones matter because the snapshot SWALLOWS those failures so one broken user
   * cannot abort the whole inventory: the resulting zero is not a fact, and only this list stands
   * between it and an operator accepting a gap that was never real.
   */
  readFailures: string[];
  /** A whole domain's snapshot failed. The Accept controls are hidden and `applyBaselineAction` refuses. */
  partial: boolean;
  /** Items on an in-scope domain that no account holds, with the reason and the candidates. */
  unassigned: UnassignedItem[];
  /**
   * Every account holding a piece of each in-scope domain, sorted, keyed by domain — what the panel's
   * Move control offers on an item line that is already placed. Numbers AND names: a picker of bare
   * numbers asks the operator to recognise one, which is the question naming the client answers. The
   * names come off the same holder graph the placement used, so this is not a second copy of the link
   * report to keep true. A domain whose snapshot failed has no entry, like {@link domainTotals}.
   */
  holders: Record<string, AccountRef[]>;
  /**
   * The recurring comparison, with every row's items decorated — see {@link ScopedComparisonItem}.
   * Typed rather than left as `RecurringComparison` with a note, because a consumer reading the
   * lib's type would have to cast to see fields this module guarantees are there.
   */
  comparison: Omit<RecurringComparison, 'rows'> & { rows: ScopedComparisonRow[] };
  /** Present only when the rulebook keys by plan or product code. Absent is not an error. */
  catalog?: { loadedAt: string; plans: number; missingProducts: string[] };
  /**
   * For every item this account SHARES with another (only an address can be — see `onebillScope.ts`),
   * what the co-holder's own bill says about the same group.
   *
   * **Nested GROUP then scoped key**, because the answer is per (item, group) and not per item: one key
   * can sit on two comparison rows when a rulebook counts one dimension under two groups, and those two
   * rows have different `billed` numbers. A flat map keyed by the item alone gave the second row the
   * first row's figures. Joining the two into one string key would work only while no key and no group
   * name contains the separator, and a group name is operator-supplied prose — so they are nested
   * instead, where nothing can collide. One entry per other holder, in `sharedWith` order.
   *
   * Without this the page can say "also on CLI00003" and nothing more, and the reader's next question —
   * is the other account billing for this address too, or is one of them short? — needs a second panel.
   *
   * `billed`/`entitled` are that account's numbers on the SAME comparison group, run over its own
   * subscriptions with an EMPTY inventory: this is a reading of their BILL, not of their inventory,
   * which this report has no business scoping. `billed: -1` is "their subscriptions could not be read"
   * — a fact, and not the zero it would otherwise be indistinguishable from.
   */
  coBilled: Record<string, Record<string, Array<{ accountNumber: string; accountName?: string; group: string; billed: number; entitled: number }>>>;
  /** ONEBILL_DB is bound. False means the page renders no accepted column and no Accept control. */
  baselinesEnabled: boolean;
  canWrite: boolean;
}

export interface LoadAccountOptions {
  canWrite: boolean;
  refresh?: boolean;
  db?: D1Database;
  now?: Date;
  /**
   * The domain the caller selected, when they selected one — it becomes {@link AccountReport.domain}.
   * The resolved scope cannot answer this: `resolveAccountScope` returns the account's whole scope
   * whichever selector reached it, so by the time the account arrives here the caller's own choice is
   * gone unless they say so. Omitted means "opened by account number".
   */
  openedBy?: string;
  /** Injected in tests; production passes nothing and gets the configured read client. */
  readSource?: { getSubscriptions(accountNumber: string): Promise<Subscription[]> };
  /** Injected in tests; production passes nothing and the catalogue loader builds its own read client. */
  catalogSource?: CatalogSource;
}

/**
 * Which OneBill account this domain's panel is about — the account's FULL scope, not just this domain.
 *
 * A thin wrapper over `resolveAccountScope(report, { domain })`, kept as the one place the
 * domain→account rules are documented for a reader who starts here. The worker no longer calls it —
 * its `boundScope` takes either selector, so it routes the union through `resolveAccountScope` and a
 * domain-only wrapper could not carry an `{ account }`. The
 * per-state refusals (unlinked, conflict, a split billed to more than one account) live in
 * `onebillScope.ts`; what matters at this layer is that resolving BY DOMAIN still returns everything
 * the account holds, because the report compares the account's whole bill.
 *
 * A SITE row is no longer a refusal — reconciliation IS scoped now — but it is still not reachable
 * this way: a domain selector looks for the bare row, and a domain whose only rows are site rows is
 * linked to nothing as a whole. Such an account is opened by account number instead.
 */
export function resolveAccountForDomain(report: LinkReport, domain: string): ResolvedAccountScope {
  return resolveAccountScope(report, { domain });
}

/**
 * OneBill answers "no subscriptions" as an in-band error at HTTP 200. The account is known to exist
 * here — it came out of the link report — so that code means an empty list, and ONLY here. Mapping it
 * anywhere the account might not exist would turn a wrong account number into a clean empty report.
 *
 * Both shapes are matched: the library's own error carries the validation block on `body`, while a
 * caller-supplied source may carry only the code or the message.
 */
function isNoSubscriptions(err: unknown): boolean {
  const body = (err as { body?: { validationResponse?: { validationErrorInfo?: unknown } } } | null)?.body;
  const info = body?.validationResponse?.validationErrorInfo;
  if (Array.isArray(info) && info.some((x) => (x as { code?: unknown })?.code === '10WS0001')) return true;
  if (/10WS0001/.test(String((err as { code?: unknown } | null)?.code ?? ''))) return true;
  return /10WS0001/.test(err instanceof Error ? err.message : String(err));
}

/**
 * Which system failed, on an error out of {@link loadAccountReport}'s parallel read.
 *
 * A bare re-throw leaves the route saying "could not load the account" with no idea which one it was —
 * an expired NetSapiens token would read to the operator as a OneBill outage, and they would go and
 * check the wrong system.
 */
export class AccountReadError extends Error {
  readonly system: 'onebill' | 'netsapiens';
  constructor(system: 'onebill' | 'netsapiens', cause: unknown) {
    // `cause` carries the original whole, so a route that knows about NsApiError or OneBillApiError can
    // still read its status off it; this wrapper only answers "which system".
    super(`${system === 'onebill' ? 'OneBill' : 'NetSapiens'}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'AccountReadError';
    this.system = system;
  }
}

/** One domain's cached inventory read. Not scoped to any account — that is what makes it shareable. */
interface CachedDomain { loadedAt: string; detail: DomainInventoryDetail; attribution: DomainAttribution; deviceFailures: string[]; smsFailures: string[] }
/** One account's cached subscriptions. Not tied to a domain — an account's bill is not per-domain. */
interface CachedSubs { loadedAt: string; subscriptions: Subscription[] }

function cacheBody(entry: unknown): Response {
  return new Response(JSON.stringify(entry), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ACCOUNT_TTL_S}` } });
}

/**
 * Where one domain's cached inventory read lives.
 *
 * Exported because it is a contract, not an implementation detail: a test that seeds or ages an entry
 * must address the same key {@link readDomain} does, and deriving it a second time in the test would
 * make the test agree with itself instead of with the module.
 */
export async function domainEntryKey(env: OnebillEnv, domain: string): Promise<Request> {
  return entryKey(scopeOf(env), 'domain', await domainHash([domain]));
}

/**
 * What the counter cannot work out for itself, off this deployment's env.
 *
 * `faxServerHosts`: NetSapiens has no fax endpoint, so the fax server's HOST is the only thing that says
 * a number is a fax line, and that host belongs to the deployment — which is exactly why
 * `netsapiens-lib` refuses to guess one. Unset means no number is a fax line, and every DID count is
 * what it was before the setting existed.
 *
 * `deviceSuffixes`: what a device-name suffix means here. `NS_DEVICE_SUFFIXES` when the operator set one,
 * otherwise the library's own default — spelled out rather than left absent, because the Ringotel entry
 * below has to be added to SOMETHING, and adding it to `{}` would silently drop SNAPmobile and Teams.
 *
 * Then, when Ringotel is on, its device suffix is added with its short label — the integration knows a
 * device type this deployment really has, and making the operator restate it in `NS_DEVICE_SUFFIXES`
 * would be asking them to keep two settings in step. It never OVERRIDES a key the operator set: an
 * explicit legend entry is a decision, and a derived one must not quietly win over it.
 *
 * Read here rather than in `resolveOnebillConfig` because these configure the NETSAPIENS read, not the
 * OneBill client — a deployment with no OneBill credentials at all would still want them if anything
 * else counted inventory.
 */
function inventoryOpts(env: OnebillEnv): InventoryOptions {
  const hosts = (env.NS_FAX_SERVER_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const configured = parseDeviceSuffixes(env.NS_DEVICE_SUFFIXES);
  const deviceSuffixes: DeviceSuffixLegend = { ...(configured ?? DEFAULT_DEVICE_SUFFIXES) };
  const rt = ringotelSuffixEntry(env);
  // `Object.hasOwn`, not `in`: the key is a device-name suffix, so `constructor` and `toString` are
  // reachable, and `in` answers true for every one of them — which would silently drop the Ringotel
  // entry on a deployment whose activation suffix happened to be one. Truncated to the same ceiling an
  // operator's own label is held to: RINGOTEL_LABEL_SHORT is validated for a column header, not for a
  // device chip, and a 200-character label would blow the chip out rather than be refused.
  if (rt && !Object.hasOwn(deviceSuffixes, rt.suffix)) deviceSuffixes[rt.suffix] = { label: rt.label.slice(0, SUFFIX_LABEL_MAX) };
  return { ...(hosts.length ? { faxServerHosts: hosts } : {}), deviceSuffixes };
}

/**
 * One domain's inventory and site attribution, from the cache when it is there.
 *
 * Every field the assembly relies on is validated: a malformed or older-shaped entry is a MISS and is
 * re-read, never a 500. `attribution` and the two failure lists are part of that test for the same
 * reason `detail` is — an entry written before one of them existed would render a page with items on
 * the wrong account, or with a device gap that was really a read error, and an operator cannot tell
 * either of those from the genuine article.
 */
async function readDomain(env: OnebillEnv, cache: Cache, ns: NsClient, domain: string, refresh: boolean, now: Date): Promise<CachedDomain> {
  const key = await domainEntryKey(env, domain);
  // Looked up even on a REFRESH, because a refresh inside `REFRESH_COOLDOWN_S` of the entry it would
  // replace is served from the entry: this read is `2 × extensions + 6` NetSapiens subrequests, and
  // `?refresh=1` is otherwise unbounded for anyone holding a valid token.
  {
    const hit = await cache.match(key);
    const body = hit ? ((await hit.json().catch(() => null)) as Partial<CachedDomain> | null) : null;
    // `sites` is part of the shape test, not a nicety: an entry written before netsapiens-lib 0.6.0
    // carries `unattributed:shared-across:` and no `sites`, and scoping it would put a shared address
    // in Unassigned on a page whose whole point is that it is not. One item is enough to tell — the
    // attribution is written in one pass, so the field is on all of them or on none.
    const items = (body?.attribution as Partial<DomainAttribution> | undefined)?.items;
    const one = items ? Object.values(items)[0] : undefined;
    if (body && body.detail && items && (one === undefined || Array.isArray(one.sites))
      && Array.isArray(body.deviceFailures) && Array.isArray(body.smsFailures) && body.loadedAt
      && (!refresh || withinRefreshCooldown(body.loadedAt, now))) {
      return body as CachedDomain;
    }
  }
  const snapshot = await fetchDomainSnapshot(ns, domain, DOMAIN_SNAPSHOT_OPTS);
  const entry: CachedDomain = {
    loadedAt: now.toISOString(),
    detail: listDomainInventory(snapshot, inventoryOpts(env)),
    attribution: attributeDomainInventory(snapshot),
    deviceFailures: snapshot.deviceReadFailures ?? [],
    smsFailures: snapshot.smsReadFailures ?? [],
  };
  await cache.put(key, cacheBody(entry));
  return entry;
}

/** One account's subscriptions, from the cache when they are there. Same MISS-not-500 rule as above. */
async function readSubs(
  env: OnebillEnv,
  cache: Cache,
  source: NonNullable<LoadAccountOptions['readSource']>,
  accountNumber: string,
  refresh: boolean,
  now: Date,
): Promise<CachedSubs> {
  const key = entryKey(scopeOf(env), 'subs', await domainHash([accountNumber]));
  // Read on a refresh too, for the reason `readDomain` states: the cooldown is the only bound on how
  // often one caller may spend this deployment's OneBill credentials.
  {
    const hit = await cache.match(key);
    const body = hit ? ((await hit.json().catch(() => null)) as Partial<CachedSubs> | null) : null;
    if (body && Array.isArray(body.subscriptions) && body.loadedAt
      && (!refresh || withinRefreshCooldown(body.loadedAt, now))) return body as CachedSubs;
  }
  const subscriptions = await source.getSubscriptions(accountNumber).catch((e: unknown) => {
    if (isNoSubscriptions(e)) return [] as Subscription[];
    throw e;
  });
  const entry: CachedSubs = { loadedAt: now.toISOString(), subscriptions };
  await cache.put(key, cacheBody(entry));
  return entry;
}

/** A domain read that answered, or the error it answered with. Kept whole so the failure can be named. */
type DomainResult =
  | { domain: string; ok: true; entry: CachedDomain }
  | { domain: string; ok: false; error: unknown };

/**
 * What each CO-HOLDER of a shared item is billed for the same group.
 *
 * ## Why the other account's bill and not its inventory
 *
 * An address on two accounts is two E911 bundles, legitimately — and the question the operator has in
 * front of the duplicated line is whether the other account is billing one too, or whether one of them
 * is short. That is a reading of their SUBSCRIPTIONS, which this report may read, and not of their
 * inventory, which it has no business scoping: their slice depends on links, assignments and
 * acceptances this panel is not showing and cannot show honestly in one line.
 *
 * So the comparison is run with an EMPTY inventory and no item list. `observed` and every verdict that
 * follows from it are then meaningless and are not read; `billed` and `entitled` come off the
 * subscriptions alone and mean exactly what they say.
 *
 * ## Sequential, and cached per account
 *
 * One read per co-holder on a cache miss, in series and after this account's own — the same reason the
 * domain reads are serial (a Workers subrequest cap should cost one line on the page, not the page).
 * `readSubs` caches by account for ten minutes, so a second panel sharing the same co-holder pays
 * nothing. A failure records `billed: -1` and is NOT `partial`: this account's own counts are unaffected
 * by somebody else's outage, and hiding its Accept controls over one would be the wrong refusal.
 */
async function readCoBilled(
  env: OnebillEnv,
  cache: Cache,
  source: NonNullable<LoadAccountOptions['readSource']>,
  rules: Parameters<typeof compareRecurring>[0]['rules'],
  rows: ScopedComparisonRow[],
  refresh: boolean,
  now: Date,
  catalog: Awaited<ReturnType<typeof loadCatalogIndex>> | undefined,
): Promise<AccountReport['coBilled']> {
  const out: AccountReport['coBilled'] = {};
  // Who to read, and which group each shared item wants off them. Gathered first so one co-holder
  // holding three shared addresses is read once.
  const wanted: Array<{ key: string; group: string; others: AccountRef[] }> = [];
  for (const row of rows) {
    for (const it of row.items ?? []) {
      if (it.sharedWith?.length) wanted.push({ key: it.key, group: row.group, others: it.sharedWith });
    }
  }
  if (!wanted.length) return out;

  const empty = countInventoryDetail({ extensions: [], systemUsers: [], dids: [], e911Addresses: [], smsNumbers: [] });
  /** One co-holder's bill, by group. `null` is "their subscriptions would not read". */
  const bills = new Map<string, Map<string, { billed: number; entitled: number }> | null>();
  for (const { others } of wanted) {
    for (const a of others) {
      if (bills.has(a.accountNumber)) continue;
      try {
        const theirs = await readSubs(env, cache, source, a.accountNumber, refresh, now);
        const cmp = compareRecurring({ subscriptions: theirs.subscriptions, inventory: empty, rules, ...(catalog ? { catalog } : {}), now });
        bills.set(a.accountNumber, new Map(cmp.rows.map((r) => [r.group, { billed: r.billed, entitled: r.entitled }])));
      } catch { bills.set(a.accountNumber, null); }
    }
  }

  for (const { key, group, others } of wanted) {
    // Nested, so the same key on two comparison rows gets each row's own numbers rather than the first
    // row's twice. `Object.hasOwn`: `group` is operator-supplied prose out of the rulebook.
    const byKey = Object.hasOwn(out, group) ? out[group]! : (out[group] = {});
    byKey[key] = others.map((a) => {
      const bill = bills.get(a.accountNumber);
      // A group their rulebook produced no row for is a real 0/0 — the rulebook is the same one, so the
      // row exists unless nothing maps to it. Their read FAILING is -1, which the page says in words.
      const hit = bill ? bill.get(group) ?? { billed: 0, entitled: 0 } : { billed: -1, entitled: 0 };
      return { accountNumber: a.accountNumber, ...(a.accountName === undefined ? {} : { accountName: a.accountName }), group, ...hit };
    });
  }
  return out;
}

export async function loadAccountReport(
  env: OnebillEnv,
  cache: Cache,
  ns: NsClient,
  report: LinkReport,
  account: ResolvedAccountScope,
  opts: LoadAccountOptions,
): Promise<AccountReport> {
  const cfg = resolveOnebillConfig(env);
  // `resolveAccountScope` never produces one; a hand-built scope could, and every failure below would
  // then be reported as a NetSapiens outage rather than as the empty scope it actually is.
  if (account.domains.length === 0) throw new OnebillRequestError(`${account.accountNumber} has no domain in scope to report on.`, 409);
  const now = opts.now ?? new Date();
  const source = opts.readSource ?? makeReadClient(env, cache);

  // Started before the loop so OneBill and the first domain are read concurrently, and awaited after
  // it. The domains themselves go ONE AT A TIME: each is separately cached and separately caught, and
  // each costs roughly `2 × extensions + 6` subrequests (see DOMAIN_SNAPSHOT_OPTS). Firing them all at
  // once would make a Workers subrequest cap a whole-account failure instead of a per-domain one.
  const subsP = readSubs(env, cache, source, account.accountNumber, !!opts.refresh, now)
    .catch((e: unknown) => { throw new AccountReadError('onebill', e); });
  // Between here and `await subsP` the domain reads run; without this the rejection would be
  // unhandled for that whole window, which Node treats as fatal.
  subsP.catch(() => {});

  const domainResults: DomainResult[] = [];
  for (const d of account.domains) {
    try { domainResults.push({ domain: d, ok: true, entry: await readDomain(env, cache, ns, d, !!opts.refresh, now) }); }
    catch (error) { domainResults.push({ domain: d, ok: false, error }); }
  }
  const subs = await subsP;

  const loaded = domainResults.filter((r): r is Extract<DomainResult, { ok: true }> => r.ok);
  const failed = domainResults.filter((r): r is Extract<DomainResult, { ok: false }> => !r.ok);
  // Every domain failing is the old single-domain failure: there is nothing to render, and a report
  // showing an empty inventory against a real bill would read as "they have nothing", not as an outage.
  if (loaded.length === 0) throw new AccountReadError('netsapiens', failed[0]!.error);

  const readFailures: string[] = [];
  for (const r of domainResults) {
    if (!r.ok) {
      // The DOMAIN is safe to name — it is one of this caller's own, and it is the whole of what they
      // can act on. The MESSAGE is not: an `NsApiError` carries the upstream path and a slice of its
      // response body, and this report is returned at 200 and printed on the page. Same rule, and the
      // same log line, as the route's `AccountReadError` handler — which is where the all-domains-
      // failed case already goes; this is the multi-domain path that used to bypass it.
      console.error(JSON.stringify({ msg: 'onebill domain read failed', domain: r.domain, error: String(r.error instanceof Error ? r.error.message : r.error).slice(0, 200) }));
      readFailures.push(`${r.domain}: could not be read`);
      continue;
    }
    if (r.entry.deviceFailures.length) readFailures.push(`${r.domain}: devices for ${r.entry.deviceFailures.join(', ')}`);
    if (r.entry.smsFailures.length) readFailures.push(`${r.domain}: SMS for ${r.entry.smsFailures.join(', ')}`);
  }

  // Holders first, and before the assignment reads: `domainHolders` is what sweeps the report for a
  // conflict on each domain, a conflict is a refusal rather than something to scope around, and there
  // is no point paying for D1 reads on the way to one.
  const holdersByDomain: Record<string, DomainHolders> = {};
  for (const r of loaded) holdersByDomain[r.domain] = domainHolders(report, r.domain);
  // Assignments are read fresh, like baselines, and in parallel: one round trip per domain in series
  // is a latency an account holding several domains pays for nothing.
  const reads: DomainRead[] = await Promise.all(loaded.map(async (r): Promise<DomainRead> => ({
    domain: r.domain,
    detail: r.entry.detail,
    attribution: r.entry.attribution,
    assignments: opts.db ? await readAssignments(opts.db, r.domain) : [],
  })));
  // `scopeInventory` refuses a `reads` list that does not cover every domain the account holds — a
  // caller mistake there would render a plausible but silently incomplete panel. A domain that FAILED
  // is not a mistake, so the account it is given is narrowed to what loaded; the report below still
  // carries the full scope list and says `partial`.
  const partial = failed.length > 0;
  const loadedDomains = loaded.map((r) => r.domain);
  const scopedAccount: ResolvedAccountScope = partial
    ? { ...account, domains: loadedDomains, scopes: account.scopes.filter((s) => loadedDomains.includes(s.domain)) }
    : account;
  const scoped = scopeInventory(scopedAccount, reads, holdersByDomain);
  // The same holders the scoping used, flattened to the numbers the panel's Move picker offers. Derived
  // from that one read rather than re-walked off the report, so the control and the placement it will
  // trigger cannot disagree about who holds what.
  const holders: Record<string, AccountRef[]> = {};
  for (const [d, h] of Object.entries(holdersByDomain)) holders[d] = holdersOf(h);

  // READ FRESH, EVERY TIME, AND MERGED AFTER THE CACHE. An accept is a decision the operator just made;
  // if it were inside the cached entry, their own click would not be visible on the page for ten
  // minutes — and the obvious fix (invalidate the entry) would throw away an inventory read they did
  // not ask to repeat.
  let baselines: GroupBaseline[] = [];
  if (opts.db) baselines = await readBaselines(opts.db, account.accountNumber);

  // Only a rulebook keyed by plan or product code needs the catalogue, and it is a two-stage read of
  // the whole product list. A name-keyed rulebook must not pay for it — hence the question, not a
  // load-and-ignore. Wrapped like the reads above, because it IS one of them: a raw throw here would
  // reach the route as "could not load the account" with no system named, which is the exact confusion
  // AccountReadError exists to prevent.
  const catalog = rulesUseCatalog(cfg.recurringRules)
    ? await loadCatalogIndex(env, cache, {
      now,
      ...(opts.catalogSource ? { source: opts.catalogSource } : {}),
      ...(opts.refresh ? { refresh: true } : {}),
    }).catch((e) => { throw new AccountReadError('onebill', e); })
    : undefined;

  const detail = scoped.detail;
  const raw = compareRecurring({
    subscriptions: subs.subscriptions,
    inventory: scoped.inventory,
    rules: cfg.recurringRules,
    baselines,
    // The item list is INJECTED: onebill-lib knows a dimension may have keys behind it and nothing
    // about what an extension or a phone number is. This is the only place the two vocabularies meet.
    itemsFor: (path) => itemsFor(detail, path),
    itemLabel: (item) => itemLabel(item as InventoryItem),
    ...(catalog ? { catalog } : {}),
    now,
  });

  // The comparison knows keys; the page needs the domain, the site and how each item got here. Built
  // as new rows rather than assigned back onto the lib's, so the decorated shape is the one the type
  // above promises instead of a widening the caller has to take on trust.
  const comparison = {
    ...raw,
    rows: raw.rows.map((row): ScopedComparisonRow => {
      // Destructured rather than spread-and-overwrite so a row with NO item list keeps having no
      // `items` key at all — an explicit `items: undefined` reads as "an empty list" to anything
      // testing with `in`, and "no list" and "an empty list" are the distinction this row turns on.
      const { items, ...rest } = row;
      return items ? { ...rest, items: items.map((i) => decorate(i, scoped.meta, account)) } : rest;
    }),
  };

  // What each account this report SHARES an item with is billed for the same thing. Only an address can
  // be shared, so on a domain nobody splits this loop finds nothing and costs nothing.
  const coBilled = await readCoBilled(env, cache, source, cfg.recurringRules, comparison.rows, !!opts.refresh, now, catalog);

  // The OLDEST of the entries behind this report — ISO strings sort lexically, so `sort()[0]` is it.
  // The co-holder subscription reads are deliberately NOT in it: their age is a fact about somebody
  // else's bill, and folding it in would age this account's own panel for a read it does not depend on.
  const loadedAt = [subs.loadedAt, ...loaded.map((r) => r.entry.loadedAt)].sort()[0]!;

  return {
    accountNumber: account.accountNumber,
    ...(account.accountName === undefined ? {} : { accountName: account.accountName }),
    scopes: account.scopes,
    domains: account.domains,
    domain: opts.openedBy ?? account.domains[0]!,
    loadedAt,
    inventory: scoped.inventory,
    detail,
    domainTotals: scoped.domainTotals,
    readFailures,
    partial,
    unassigned: scoped.unassigned,
    holders,
    comparison,
    ...(catalog ? { catalog: { loadedAt: catalog.loadedAt, plans: catalog.plans, missingProducts: catalog.missingProducts } } : {}),
    coBilled,
    baselinesEnabled: opts.db !== undefined,
    canWrite: opts.canWrite,
  };
}

/**
 * Where one comparison item came from.
 *
 * A `stale` item — an acceptance whose inventory item is gone — has no scope meta, because scoping
 * only ever saw items that still exist. Its own key names its domain, which is the honest answer;
 * its attribution is `'unknown'`, because nothing here can know how an item that is not there would
 * have arrived. An acceptance written before migration 0003 carries a BARE key with no domain in it;
 * the migration deleted those, but a cached row can still show one, so the account's first domain
 * stands in rather than letting `splitScopedKey` throw and take the whole page with it.
 */
function decorate(item: ComparisonItem, meta: Record<string, ScopedItemMeta>, account: ResolvedAccountScope): ScopedComparisonItem {
  // `Object.hasOwn`, not bracket-truthiness: a bare pre-0003 key is caller data and could read
  // `constructor`, which would otherwise resolve up the prototype chain to a function.
  const m = Object.hasOwn(meta, item.key) ? meta[item.key] : undefined;
  if (m) return { ...item, ...m };
  let domain = account.domains[0]!;   // non-empty: loadAccountReport refuses an empty scope up front
  try { domain = splitScopedKey(item.key).domain; } catch { /* pre-0003 bare key — the account's own domain is the best answer */ }
  return { ...item, domain, attribution: 'unknown' };
}

/**
 * What the route asks this module to record. Three shapes, because there are three different things an
 * operator can decide, and collapsing them would make the request ambiguous about which one they meant:
 *
 * - `items` — these specific things are fine.
 * - `all` — every present item on this row is fine. `accept`+`all` is refused on a row with no item
 *   list AND on one whose list is empty: neither has anything to name, and accepting nothing must not
 *   become a count acceptance by the back door.
 * - `shortfall` — the group row itself: billed exceeds observed, and that is expected.
 *
 * `offer` rides on the two ITEM forms only: it says which of the row's plans these items are billed as,
 * and a shortfall is a decision about a count rather than about any item. It is validated against the
 * row's own `offers[].name` below, so a stale page cannot tag an acceptance with a plan the account no
 * longer carries.
 *
 * `decidedBy` is NOT in here. It is a separate parameter the route fills from the caller's `ns_t`, so a
 * client-supplied principal has no field to arrive in.
 */
export type BaselineAction =
  | { action: 'accept' | 'clear'; group: string; items: Array<{ key: string }>; note?: string; offer?: string }
  | { action: 'accept' | 'clear'; group: string; all: true; note?: string; offer?: string }
  | { action: 'accept' | 'clear'; group: string; shortfall: true; note?: string };

/**
 * Record one acceptance decision and answer with the row as it now reads.
 *
 * Every key the caller names is validated against the row the report just produced, so a stale page
 * cannot accept an extension that has since been deleted — with one deliberate exception: a `clear` may
 * name a `stale` key, because clearing a dead acceptance is exactly the housekeeping the stale list
 * exists to prompt.
 *
 * The report is loaded three times at worst, and that is affordable rather than free: each load hits
 * the ten-minute cache for the inventory and the subscriptions and reads baselines and assignments
 * fresh, then re-runs the whole comparison. The cost is D1 reads plus that CPU — what it is NOT is
 * another NetSapiens snapshot or another OneBill subscription read, which is the expensive half and
 * the reason a read-decide-reread shape is affordable here at all.
 */
export async function applyBaselineAction(
  env: OnebillEnv,
  cache: Cache,
  ns: NsClient,
  report: LinkReport,
  account: ResolvedAccountScope,
  db: D1Database,
  decidedBy: string,
  req: BaselineAction,
  opts: { now?: Date; readSource?: LoadAccountOptions['readSource']; catalogSource?: CatalogSource } = {},
): Promise<ScopedComparisonRow> {
  const load = () => loadAccountReport(env, cache, ns, report, account, {
    canWrite: true,
    db,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.readSource ? { readSource: opts.readSource } : {}),
    ...(opts.catalogSource ? { catalogSource: opts.catalogSource } : {}),
  });

  const before = await load();
  // Checked before anything else about the request: an acceptance against a partial report records a
  // decision as though it had been made against the whole account, and the operator was shown half.
  // A `clear` is safe — removing a decision cannot depend on inventory nobody could read.
  if (before.partial && req.action === 'accept') {
    throw new OnebillRequestError("One of this account's domains could not be read; refresh before accepting anything.", 409);
  }
  const row = before.comparison.rows.find((r) => r.group === req.group);
  if (!row) throw new OnebillRequestError(`${req.group} is not a comparison group on this account.`, 409);

  // The offer an acceptance is tagged with must be one this row is actually billed under — matched the
  // way onebill-lib matches offer names everywhere else, case-insensitively after trim, and answered
  // with the row's own list so the operator can see what they could have meant. A tag on a `clear` is
  // meaningless (nothing is being recorded), so it is refused rather than silently dropped.
  const asked = 'offer' in req && req.offer !== undefined ? req.offer.trim() : undefined;
  // The ROW's own spelling, never the caller's: two spellings of one plan in the history would read as
  // two plans to anybody grouping by it later.
  let tag: string | undefined;
  if (asked !== undefined) {
    if (req.action !== 'accept') throw new OnebillRequestError('An offer can only be recorded with an accept.', 409);
    const names = row.offers.map((o) => o.name);
    tag = names.find((n) => n.trim().toLowerCase() === asked.toLowerCase());
    if (tag === undefined) {
      throw new OnebillRequestError(`${asked} is not an offer on the ${req.group} row of this account. It is billed as: ${names.length ? names.join(', ') : 'nothing'}.`, 409);
    }
  }

  const present = new Map((row.items ?? []).filter((i) => i.status !== 'stale').map((i) => [i.key, i]));
  const stale = new Map((row.items ?? []).filter((i) => i.status === 'stale').map((i) => [i.key, i]));
  const acct = account.accountNumber;

  if ('shortfall' in req) {
    if (req.action === 'accept') {
      await writeGroupRow(db, { accountNumber: acct, group: req.group, billed: row.billed, observed: row.observed, accepted: row.observed, entitled: row.entitled, ...(req.note ? { note: req.note } : {}), decidedBy }, opts.now);
    } else {
      // `clearGroup` is the only store call that removes a group row, and it takes the group's item
      // acceptances with it. Where there are none that is exactly right; where there are some, this
      // request would silently discard decisions it does not mention, so refuse and make the caller
      // say which of the two things they meant.
      if ((row.items ?? []).some((i) => i.status === 'accepted')) {
        throw new OnebillRequestError(`${req.group} has accepted items; clear those first, or use Clear all to remove them and the group row together.`, 409);
      }
      await clearGroup(db, acct, req.group, decidedBy, opts.now);
    }
  } else if ('all' in req) {
    if (req.action === 'accept') {
      // No list, or an empty one, means there is nothing to enumerate, so "all" cannot mean anything
      // here. An empty list is the sharper case: the derived completion write below would see
      // `unreviewed === 0` on a row where nothing was reviewed and record a whole-group acceptance
      // the operator never made. Saying so is better than quietly writing it.
      if (!row.items || row.items.length === 0) throw new OnebillRequestError(`${req.group} has no item list; accept it as a shortfall instead.`, 409);
      // Every item stale is the same hole one step along: `present` is empty, `acceptItems` batches
      // nothing, and the completion write below would then record a group row for a row on which
      // nothing was accepted. A stale item is a dead acceptance, so "accept them all" cannot mean
      // anything here — clearing them is the housekeeping the stale list exists to prompt.
      if (present.size === 0) throw new OnebillRequestError('every item on this row is stale; clear them instead', 409);
      await acceptItems(db, { accountNumber: acct, group: req.group, items: [...present.values()].map((i) => ({ key: i.key, label: i.label })), ...(req.note ? { note: req.note } : {}), ...(tag ? { offer: tag } : {}), decidedBy }, opts.now);
    } else {
      await clearGroup(db, acct, req.group, decidedBy, opts.now);
    }
  } else {
    const wanted = req.items.map((i) => i.key);
    const missing = wanted.find((k) => !present.has(k) && !(req.action === 'clear' && stale.has(k)));
    if (missing !== undefined) throw new OnebillRequestError(`${missing} is not on the ${req.group} row of this account right now - reload and look again.`, 409);
    // The label is taken from the row, never from the request: it is what the operator was looking at
    // when they decided, and it is what the history has to be able to show later.
    const items = wanted.map((k) => { const i = present.get(k) ?? stale.get(k)!; return { key: i.key, label: i.label }; });
    if (req.action === 'accept') await acceptItems(db, { accountNumber: acct, group: req.group, items, ...(req.note ? { note: req.note } : {}), ...(tag ? { offer: tag } : {}), decidedBy }, opts.now);
    else await clearItems(db, { accountNumber: acct, group: req.group, items, decidedBy }, opts.now);
  }

  // Completing a group records the group row with today's numbers, so a later billing change is drift.
  //
  // For any NON-SHORTFALL row with items actually on it — over-observed or exactly matched. An
  // exactly-matched, fully accepted row records its billed count for the same reason the over-observed
  // one does: without that baseline, a later billing change reads as an unbaselined row rather than as
  // drift from what the operator signed off on, and the one thing the panel exists to show is missed.
  // `unreviewed === 0` alone is not enough to write on: it is true of a row with no items at all, and
  // of a SHORTFALL row whose few items are all accepted — writing there records `accepted: observed`
  // against a `billed` that exceeds it, which is a shortfall acceptance the operator was never asked
  // for. A shortfall is accepted deliberately, through `shortfall: true`, or not at all.
  let after = (await load()).comparison.rows.find((r) => r.group === req.group)!;
  if (req.action === 'accept' && !('shortfall' in req)
    && after.items && after.items.length > 0 && after.unreviewed === 0 && after.observed >= after.billed
    // An all-stale row satisfies `unreviewed === 0` while nothing on it is live. Writing there records
    // a whole-group acceptance out of acceptances that no longer name anything the account holds.
    && after.items.some((i) => i.status !== 'stale')
    // `entitled` counts as moved only where the row RECORDED one. A pre-0004 decision has none, and
    // onebill-lib keeps those on the pre-entitlement rule rather than drifting every old row at once —
    // rewriting them here to add the number would restamp a decision nobody revisited.
    && (!after.groupRow || after.groupRow.billed !== after.billed || after.groupRow.accepted !== after.observed
      || (after.groupRow.entitled !== undefined && after.groupRow.entitled !== after.entitled))) {
    // No note. This row is DERIVED — the operator wrote their note about the item they just accepted,
    // and copying it onto a whole-group record would attribute a sentence to a decision they never made.
    await writeGroupRow(db, { accountNumber: acct, group: req.group, billed: after.billed, observed: after.observed, accepted: after.observed, entitled: after.entitled, decidedBy }, opts.now);
    after = (await load()).comparison.rows.find((r) => r.group === req.group)!;
  }
  return after;
}

/**
 * Where one item bills, as the operator has decided it — or `accountNumber: null` to take the decision
 * back and let the automatic rule have it again.
 *
 * `domain` + `key` is the item's BARE identity on one domain, which is how the assignment store is keyed
 * (see `onebillAssignment.ts`): an assignment is a fact about the item, not about either account, so it
 * outlives the panel that was open when it was made. `decidedBy` is NOT in here — the route fills it from
 * the caller's `ns_t`, so a client-supplied principal has no field to arrive in.
 */
export interface AssignRequest {
  domain: string;
  key: string;
  accountNumber: string | null;
  /**
   * Take `accountNumber` OUT of this item's manual set. Only an address has a set to take an account
   * out of, so `remove` on any other kind is refused rather than treated as the `accountNumber: null`
   * clear it resembles — the two are different decisions and a page that meant one must not get the
   * other. Requires a non-null `accountNumber`; the route bounds that.
   */
  remove?: true;
  note?: string;
}

/**
 * The item behind a bare key, across EVERY list the domain read produced — system users included.
 *
 * They are informational and never compared, but `onebillScope.ts` places them like any other item and
 * honours an assignment naming one, so refusing to find one here would 409 with "not on this domain"
 * about an item that plainly is.
 */
function findItem(detail: DomainInventoryDetail, key: string): InventoryItem | undefined {
  const lists: InventoryItem[][] = [detail.extensions, detail.systemUsers, detail.dids, detail.e911Addresses, detail.smsNumbers];
  for (const list of lists) {
    const hit = list.find((i) => i.key === key);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Which accounts hold one item on one domain right now — EVERY one of them, in holder order, and empty
 * when none does.
 *
 * A list rather than one answer because an address is placed on a set (see `onebillScope.ts`). For
 * every other kind it is at most one, which is the same fact this returned before.
 *
 * Asked of `scopeInventory` once per holder rather than re-deriving the placement rule here, because a
 * second copy of "manual, else site, else whole domain" is a second copy that can drift from the one the
 * panel renders — and this answer decides whose acceptance gets cleared.
 *
 * Each holder's scope is built STRAIGHT FROM `holders`, not from `resolveAccountScope`: that walks the
 * whole report and refuses an account caught in a conflict on some unrelated domain, which would turn an
 * unrelated broken link into a refusal to reassign this item. The question here is only "who holds this
 * domain's items", and `holders` — which has already refused a conflict on THIS domain — is the whole
 * answer to it.
 */
function ownersOfItem(domain: string, read: DomainRead, holders: DomainHolders, bareKey: string): string[] {
  const sk = scopedKey(domain, bareKey);
  const out: string[] = [];
  for (const h of holdersOf(holders)) {
    const scopes: Scope[] = [
      ...(holders.whole?.accountNumber === h.accountNumber ? [{ domain }] : []),
      ...Object.entries(holders.bySite).filter(([, v]) => v.accountNumber === h.accountNumber).map(([site]) => ({ domain, site })),
    ];
    const account: ResolvedAccountScope = { accountNumber: h.accountNumber, ...(h.accountName === undefined ? {} : { accountName: h.accountName }), scopes, domains: [domain] };
    if (Object.hasOwn(scopeInventory(account, [read], { [domain]: holders }).meta, sk)) out.push(h.accountNumber);
  }
  return out;
}

/**
 * Move one item to another account — or hand it back to the automatic rule — and answer with the report
 * the operator is looking at, as it now reads.
 *
 * ## One batch, because the two halves are one fact
 *
 * A reassignment writes to both D1 stores: the assignment row that says where the item bills now, and the
 * removal of the acceptance the account it LEAVES had recorded against it. Split across two batches, a
 * failure between them leaves either an item billing to an account that never reviewed it or an acceptance
 * standing for an account that no longer holds it — and both read to the next person as a decision somebody
 * made. Hence the statement builders in `onebillBaseline.ts` and `onebillAssignment.ts`: neither module
 * knows about the other, and this is the one place they are composed.
 *
 * ## The acceptance follows the item, and only when the item actually moves
 *
 * Whose acceptance to clear is decided by asking `scopeInventory` who owns the item BEFORE and AFTER the
 * change, rather than by trusting the request: re-stating an assignment the item already has (turning an
 * automatic placement into an explicit one) moves nothing and must not throw away a review, and clearing an
 * assignment whose automatic owner is the same account is the same no-op wearing different clothes.
 *
 * ## What is checked, in the order the checks cost money
 *
 * Everything the LINK REPORT can answer runs first, because the report is already in hand: the domain has
 * to appear in it, its link must not be conflicted, and a named target account must currently hold some
 * part of it — an assignment naming an account that holds none would be ignored by the placement rule
 * anyway (`onebillScope.ts` shows those as `staleAssignment`), so taking the write would record a decision
 * that does nothing. Only then is the domain read, because on a cache miss that is a whole PBX snapshot,
 * and no refusal that needed only the report should ever pay for one.
 *
 * ## The item is checked against the CACHED read, deliberately
 *
 * `readDomain` is called with `refresh: false`, so this is the same entry the panel was rendered from and
 * the same one the load at the end will serve. That is the point: the operator decided about the item they
 * were shown, and re-reading NetSapiens here would validate their click against an inventory they never
 * saw — an item added in the last ten minutes would become assignable from a page that does not list it,
 * and one deleted in that window would refuse a decision the page still invites. The staleness bound is
 * the entry's ten minutes, and `refresh` on the panel is how an operator shortens it.
 *
 * `viewing` need not hold the domain at all. An operator can reach the Unassigned list from any panel that
 * shows it, and the account they are looking at is a fact about the page, not a claim about the item.
 */
export async function applyAssignment(
  env: OnebillEnv,
  cache: Cache,
  ns: NsClient,
  report: LinkReport,
  db: D1Database,
  decidedBy: string,
  req: AssignRequest,
  viewing: ResolvedAccountScope,
  opts: { now?: Date; readSource?: LoadAccountOptions['readSource']; catalogSource?: CatalogSource; openedBy?: string } = {},
): Promise<AccountReport> {
  const now = opts.now ?? new Date();

  // FREE CHECKS FIRST. `readDomain` below is a whole PBX snapshot on a cache miss; a request naming a
  // domain this report has never heard of, or an account that holds none of it, must not buy one.
  if (!report.rows.some((r) => r.domain === req.domain)) {
    throw new OnebillRequestError(`${req.domain} is not in this report - reload the links page.`, 409);
  }
  // `domainHolders` is also what refuses a conflicted link, and a conflict is a refusal rather than
  // something to assign around. Its answer is the holder list too — sweeping the report again for one
  // would be a second derivation of a graph already in hand.
  const holders = domainHolders(report, req.domain);
  // ONLY ON THE ADD PATH. Recording an assignment to an account that holds no part of the domain would
  // record a decision that does nothing — `onebillScope.ts` ignores such a row for placement and shows
  // it as `staleAssignment`. REMOVING one is the opposite: the row is exactly what wants deleting, and
  // gating that on the account still being a holder made a stale assignment permanent, which is the
  // state the Unassigned list's `staleAssignment` badge exists to prompt somebody to fix. A remove is
  // bounded by the row's own existence instead, below.
  if (req.accountNumber !== null && !req.remove && !holdersOf(holders).some((a) => a.accountNumber === req.accountNumber)) {
    throw new OnebillRequestError(`${req.accountNumber} holds no part of ${req.domain}; link it there first, or pick an account that does.`, 409);
  }

  const entry = await readDomain(env, cache, ns, req.domain, false, now)
    .catch((e: unknown) => { throw new AccountReadError('netsapiens', e); });
  const item = findItem(entry.detail, req.key);
  if (!item) throw new OnebillRequestError(`${req.key} is not on ${req.domain} right now - reload and look again.`, 409);
  // From the item, never from the request: the label is what the operator was looking at when they decided,
  // and it is what the history has to be able to show later.
  const label = itemLabel(item);

  // ADDRESSES HAVE A SET, EVERYTHING ELSE HAS AT MOST ONE. The two shapes are refused against each
  // other rather than coerced: a page that sent `remove` for an extension, or a whole-item clear for an
  // address, meant something this route cannot do, and doing the neighbouring thing instead would
  // record a decision nobody made.
  const address = req.key.startsWith('addr:');
  if (req.remove && !address) {
    throw new OnebillRequestError(`only an address has per-account assignments; ${req.key} has one assignment, so clear it instead.`, 409);
  }
  if (address && req.accountNumber === null) {
    throw new OnebillRequestError(`an address has per-account assignments; remove one instead.`, 409);
  }

  const assignments = await readAssignments(db, req.domain);
  const mine = (a: Assignment): boolean => a.key === req.key;
  if (req.accountNumber === null && !assignments.some(mine)) {
    throw new OnebillRequestError(`${req.key} on ${req.domain} has no manual assignment to clear.`, 409);
  }
  if (req.remove && !assignments.some((a) => mine(a) && a.accountNumber === req.accountNumber)) {
    throw new OnebillRequestError(`${req.key} on ${req.domain} is not manually assigned to ${req.accountNumber}.`, 409);
  }

  // The row this write PUTS THERE, if any. A remove names an account and still writes none — which is
  // exactly why `remove` is its own field rather than a null account: the two shapes differ in what
  // they take away, not in what they name.
  const row = req.accountNumber === null || req.remove ? undefined
    : { domain: req.domain, key: req.key, accountNumber: req.accountNumber, label, decidedBy, decidedAt: now.toISOString() };
  // What the assignment table would hold after this write. An ADD on an address leaves every other
  // account's row standing — that is the whole of "additive"; every other shape replaces the item's one
  // row, which is the rule the schema stopped enforcing at migration 0005 and this line now carries.
  const next: Assignment[] = req.remove
    ? assignments.filter((a) => !(mine(a) && a.accountNumber === req.accountNumber))
    : address
      ? [...assignments.filter((a) => !(mine(a) && a.accountNumber === req.accountNumber)), ...(row ? [row] : [])]
      : [...assignments.filter((a) => !mine(a)), ...(row ? [row] : [])];

  const read: DomainRead = { domain: req.domain, detail: entry.detail, attribution: entry.attribution, assignments };
  const before = ownersOfItem(req.domain, read, holders, req.key);
  const after = ownersOfItem(req.domain, { ...read, assignments: next }, holders, req.key);

  // Every group each LEAVING account had accepted this item under — plural in both directions, because a
  // key can appear on more than one comparison row and (for an address) more than one account can be
  // leaving at once. An acceptance left behind on any of them is the same lie. The label comes off the
  // baseline row, not off today's inventory: the history says what was cleared, as it was recorded.
  const clears: D1PreparedStatement[] = [];
  const sk = scopedKey(req.domain, req.key);
  for (const gone of before.filter((b) => !after.includes(b))) {
    for (const g of await readBaselines(db, gone)) {
      const held = g.items.find((i) => i.key === sk);
      if (held) clears.push(...clearItemStatements(db, { accountNumber: gone, group: g.group, items: [{ key: held.key, label: held.label }], decidedBy }, now));
    }
    // AND, unconditionally, every acceptance of this key on this account in every group — the same
    // move the assignment half made when it stopped deriving its deletes from a read (see the SQL note
    // below). The read above happened before the batch, so an accept landing on the leaving account in
    // between would otherwise survive on an item that account no longer holds. The history rows stay
    // derived from the read on purpose: the delete is what happened, the history is what the operator
    // was told they were undoing, and an unconditional delete cannot say what it removed.
    clears.push(clearItemKeyStatement(db, gone, sk));
  }

  // ── what the ASSIGNMENT table itself is told, stated as SQL rather than derived from the read ──
  //
  // The rule the schema stopped carrying at migration 0005 — one row per non-address item — is now this
  // module's, and a write is the only place it can be enforced. Deriving the deletes from the rows the
  // read returned is what got this wrong once: a filter that matched on the ACCOUNT across every key on
  // the domain left a second row standing on this key whenever the same account also held some OTHER
  // item, and a clear then deleted the acceptance while the assignment survived. So the non-address
  // assign says `account_number <> ?` outright, which is true of whatever is in the table when it runs,
  // rather than of whatever a read a moment earlier believed. That also HEALS a table already holding
  // two rows on one key, from before this was fixed.
  //
  // History is per account and comes off the READ, because the unconditional delete cannot say what it
  // removed. The two are not the same claim and are not written as though they were: the delete is what
  // happened, the history is what the operator was told they were undoing.
  const note = req.note ? { note: req.note } : {};
  const writes: D1PreparedStatement[] = [];
  if (req.remove) {
    // Bounded by the row's existence above, so exactly this row goes. The other holders keep theirs.
    writes.push(...clearAssignmentStatements(db, { domain: req.domain, key: req.key, accountNumber: req.accountNumber!, label, ...note, decidedBy }, now));
  } else if (req.accountNumber === null) {
    // A non-address clear. One row in a healthy table; every row for the key if it is not, so a clear
    // cannot leave one of a pair behind.
    for (const a of assignments.filter(mine)) {
      writes.push(...clearAssignmentStatements(db, { domain: req.domain, key: req.key, accountNumber: a.accountNumber, label, ...note, decidedBy }, now));
    }
  } else if (address) {
    // ADDITIVE: nothing else is touched. The upsert alone, on the (domain, key, account) triple.
    writes.push(...assignStatements(db, { domain: req.domain, key: req.key, accountNumber: req.accountNumber, label, ...note, decidedBy }, now));
  } else {
    // A non-address assign: this account's row, and NO other account's. The note rides the assign — one
    // decision, recorded once — so the displaced accounts' history rows carry none.
    for (const a of assignments.filter((x) => mine(x) && x.accountNumber !== req.accountNumber)) {
      writes.push(assignmentHistoryStatement(db, { domain: req.domain, key: req.key, accountNumber: a.accountNumber, label, action: 'clear', decidedBy }, now));
    }
    writes.push(clearOtherAssignmentsStatement(db, { domain: req.domain, key: req.key, accountNumber: req.accountNumber }));
    writes.push(...assignStatements(db, { domain: req.domain, key: req.key, accountNumber: req.accountNumber, label, ...note, decidedBy }, now));
  }

  const batch = [...clears, ...writes];
  // A write route that writes nothing has answered 200 to a request that did not happen, and the
  // operator reads the unchanged panel as the change they asked for. D1 also refuses an empty batch.
  if (!batch.length) throw new OnebillRequestError(`${req.key} on ${req.domain} is already as asked - nothing to change.`, 409);
  await db.batch(batch);

  // `now` is passed on deliberately: the read above, the write and the report that answers it are one
  // operation, and stamping them from one clock is what makes the entry ages comparable afterwards.
  return loadAccountReport(env, cache, ns, report, viewing, {
    canWrite: true,
    db,
    now,
    ...(opts.readSource ? { readSource: opts.readSource } : {}),
    ...(opts.catalogSource ? { catalogSource: opts.catalogSource } : {}),
    ...(opts.openedBy ? { openedBy: opts.openedBy } : {}),
  });
}
