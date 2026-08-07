/**
 * Ringotel enrichment — an OPTIONAL, fully-gated integration for the call-flow Worker.
 *
 * THE INTEGRATION-GATE CONVENTION (reused by future plug-ins, e.g. billing OneBill|Datagate):
 *   - This whole integration lives in its own module and is governed by one predicate,
 *     `ringotelEnabled(env)` (= a Ringotel API key is configured).
 *   - When the predicate is false, NOTHING here runs: no network calls, no enrichment, and any
 *     Ringotel-only routes are absent (the caller returns 404). With no integration configured, the
 *     Worker is behaviorally identical to the NS-only baseline. This is a tested invariant.
 *   - `@dszp/ringotel-lib` is publishable and carries no customer data, so a sanitized shared repo may
 *     depend on it while it stays dormant without a key.
 *
 * WHAT IT DOES (when enabled): after `resolveFlow`, it annotates the diagram's `###r` app-device /
 * agent lines (and the matching user node) with the actual Ringotel user — name, presence, device
 * count — joined by base extension. NetSapiens stays untouched (`netsapiens-lib` is unchanged); we
 * only append to `FlowNode.lines[]`, which every renderer emits verbatim and safely-escaped.
 *
 * CACHE: the fleet org/branch directory and per-org user lists are cached in the Workers Cache API
 * (no new binding), mirroring the JWT-verdict cache. `branch.address` on a NetSapiens-connected
 * Ringotel branch IS the NS domain, so `matchOrgsForDomain(index, nsDomain)` resolves org+branch
 * locally. It's EXACTLY-ONE by design: resellers can view any domain's diagram cross-domain, so a
 * duplicate/typo'd `branch.address` on another org must never bleed into domain D's data — 0 or ≥2
 * matches both refuse (never guess) rather than picking one silently.
 */

import {
  RingotelReadClient,
  RingotelWriteClient,
  buildOrgBranchIndex,
  assessUserHealth,
  orgSettings,
  findAllByAddress,
  type OrgBranchEntry,
  type OrgSettings,
  type User,
  type HealthFlag,
  type HealthSeverity,
} from '@dszp/ringotel-lib';
import type { FlowGraph } from '@dszp/netsapiens-lib';
import { resolveRingotelConfig } from './eligibility.js';

/** Env subset this module reads. Kept structural so the Worker's own Env satisfies it. */
export interface RingotelEnv {
  /** Ringotel AdminAPI key (secret). Presence of this = the integration is enabled. */
  RINGOTEL_API_KEY?: string;
  /** Optional non-default Ringotel shell base URL. */
  RINGOTEL_BASE_URL?: string;
  /** Display label for enriched lines. Default "Ringotel" — set to an internal name via env only. */
  RINGOTEL_LABEL?: string;
  /** Short display label for tight surfaces (a column header, a badge), e.g. "Acme App". Defaults to
   *  RINGOTEL_LABEL, then "Ringotel". Set via env only — a white-label name is never source. */
  RINGOTEL_LABEL_SHORT?: string;
  /**
   * Opt-in: prefix each enriched line with a 🟢/🔴 online circle. OFF by default — presence is a
   * point-in-time snapshot (cached ≤10m here, not real-time) and the rest of the diagram is static
   * config, so we don't embed live status unless explicitly asked. Truthy: "1"/"true"/"yes"/"on".
   */
  RINGOTEL_PRESENCE?: string;
  /** Optional JSON `{ "<nsDomain>": "<branchAddressToMatch>" }` for the rare domain whose Ringotel
   *  branch.address differs from the NS domain. Normally unnecessary (address == NS domain). */
  RINGOTEL_OVERRIDES?: string;
  /** NS device-name suffix, e.g. 'r' → device '100r'. Default 'r'. Used for health classification. */
  RINGOTEL_ACTIVATION_SUFFIX?: string;
  /**
   * Cache-key namespace for THIS deployment — `"portal"` / `"dev"` / `"dia"`. See `scopeOf`.
   *
   * `caches.default` is **zone-shared**: every Worker on `example.com` reads and writes one
   * cache, so an unscoped key is one entry shared by all three deployments. That is not a theoretical
   * concern — it was actively corrupting testing (a harness pointed at dev while evaluating prod, same
   * org): prod writes and invalidates, dev then repopulates the shared key from ITS read, and prod
   * serves dev's value for the rest of the TTL. `invalidateOrgUsers` is scoped to one deployment; the
   * entry it deletes belongs to three.
   *
   * MUST be an explicit per-env var, NOT derived from `url.hostname`: `scheduled()` has no request, so
   * a hostname-derived scope would give the cron a different key than the fetch path and the two would
   * never share a cache. Set it in EVERY env block in wrangler.jsonc — `vars` are not inherited.
   */
  CACHE_SCOPE?: string;
}

/**
 * The cache-key namespace for this deployment. Unset ⇒ `"default"`, which is correct for a single-
 * deployment operator and merely means "one namespace".
 *
 * Characters outside `[A-Za-z0-9._-]` are folded to `-` rather than rejected, so a typo'd value stays a
 * usable key instead of producing a malformed URL — and, importantly, stays DISTINCT: silently falling
 * back to `default` on a bad value would merge two deployments' caches, which is the exact failure this
 * function exists to prevent.
 */
export function scopeOf(env: RingotelEnv): string {
  const raw = (env.CACHE_SCOPE ?? '').trim();
  if (!raw) return 'default';
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-') || 'default';
}

/** Vendor name. Both labels default to it, so an unconfigured deploy says "Ringotel" — the truth —
 *  rather than anyone's white-label branding. White-label names arrive via env, never source. */
const DEFAULT_LABEL = 'Ringotel';
// The cached value is a PROJECTION of the Ringotel AdminAPI (buildOrgBranchIndex's OrgBranchEntry[]),
// not raw API data — so a stale entry doesn't just go out of date, it can be missing a field the
// CURRENT Worker code depends on. Deploying a new projected field with no key change means the newly
// deployed Worker reads entries written by the PREVIOUSLY deployed Worker (up to INDEX_TTL old, per
// colo) that lack it, and a falsy/absent read of that field is silently indistinguishable from "this
// org genuinely doesn't have it" — e.g. `ssoService` added for this branch: without a version bump, a
// pre-deploy entry has no `ssoService` ⇒ `ssoEnabled()` reads false ⇒ every user in an SSO-bound domain
// is confidently told to use the app password from a welcome email, for up to an hour per colo, with no
// error anywhere.
// RULE: whenever a field is ADDED TO or REMOVED FROM the projected `OrgBranchEntry`, bump this version.
// It is cheap insurance — the only cost is one extra fleet-wide re-dig — against a class of bug that is
// otherwise silent and only shows up as "SSO users can't sign in right after a deploy".
const INDEX_SHAPE_VERSION = 3; // v2: added ssoService · v3: added hidePassInEmail to the projected entry
const CACHE_ORIGIN = 'https://ringotel-cache.internal';
/** Every key below is namespaced by `scopeOf(env)` — see `RingotelEnv.CACHE_SCOPE` for why. */
const indexKey = (scope: string) => `${CACHE_ORIGIN}/${scope}/index-v${INDEX_SHAPE_VERSION}`;
const INDEX_TTL = 3600; // 1h
const USERS_TTL = 600; //  10m
/**
 * The volatile org settings (`params.sso`, `params.hidePassInEmail`) get their OWN short TTL, separate
 * from the hour-long index they are also projected into.
 *
 * The split is the point of this design. Which org serves a domain is *structural* — it changes
 * approximately never and costs a fleet-wide `getOrganizations` + a `getBranches` per org to discover,
 * so it stays at an hour. These two settings are *volatile* — an operator flips SSO for an org in the
 * Ringotel admin, a change that passes through none of our write paths, so no invalidation hook could
 * ever exist for it — and re-reading them costs exactly one `getOrganization(orgid)`. Shortening
 * INDEX_TTL to make them fresh would multiply the expensive fan-out to fix the cheap read.
 */
const ORG_PARAMS_TTL = 60; // s
/** Ceiling on the overlay's upstream read — see `getOrgParams` for why it needs one of its own. */
const ORG_PARAMS_TIMEOUT_MS = 3000;

/**
 * Reject after `ms` if `p` has not settled. Note this does not CANCEL the underlying request — it stops
 * us waiting on it, which is the whole requirement: the caller degrades to the cached index value rather
 * than holding the response open on an optional freshness read.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
// A forced directory refresh re-digs the WHOLE fleet (~1 getOrganizations + 1 getBranches/org) against
// the shared key. This lock coalesces refreshes fleet-wide: once one runs, further ?refresh within the
// window fall through to the cached directory instead of re-digging. So even a caller authorized to
// refresh (reseller) can't loop it into unbounded amplification. Paired with the per-caller policy gate
// in the Worker (refreshRequested → ringotel.refresh).
// Exported so worker.selftest.ts's in-memory Cache API stub — whose `match` has no TTL/expiry check, so
// this lock never self-clears the way the real Cache API entry does after INDEX_REFRESH_MIN_INTERVAL —
// can evict just this one entry between scenarios instead of clearing the whole stub cache.
// NOT given a shape-version component like indexKey above: the stored value is always the same inert
// marker (`{ t: 1 }`), whose fields are never read — only its PRESENCE is checked (`if (locked)`). There
// is no projected shape here to drift, so an older Worker's lock entry and a newer Worker's lock entry
// mean exactly the same thing to both. Versioning it would be cargo-culting the indexKey fix onto a key
// that has no analogous failure mode.
// It IS scoped, though, and for a reason the shape-version does not cover: unscoped, a dev refresh takes
// the lock and suppresses a PROD refresh for the next minute.
export const indexRefreshLockKey = (scope: string) => `${CACHE_ORIGIN}/${scope}/index-refresh-lock`;
const INDEX_REFRESH_MIN_INTERVAL = 60; // s — an actual re-dig happens at most once per minute, per scope
const orgUsersKey = (scope: string, orgid: string) => `${CACHE_ORIGIN}/${scope}/org/${orgid}/users`;
// Exported for the same reason indexRefreshLockKey is: the selftests' in-memory Cache API stub has no
// TTL expiry, so a scenario that CHANGES an org's params has to evict this entry by hand where production
// would simply let ORG_PARAMS_TTL lapse.
export const orgParamsKey = (scope: string, orgid: string) => `${CACHE_ORIGIN}/${scope}/org/${orgid}/params`;

/** THE GATE. Everything Ringotel is governed by this. */
export function ringotelEnabled(env: RingotelEnv): boolean {
  return typeof env.RINGOTEL_API_KEY === 'string' && env.RINGOTEL_API_KEY.trim().length > 0;
}

/** Long-form label for prose/banners, e.g. "Acme App". Default "Ringotel". */
function labelOf(env: RingotelEnv): string {
  const l = (env.RINGOTEL_LABEL ?? '').trim();
  return l || DEFAULT_LABEL;
}

/**
 * Short-form label for tight surfaces — a table column header, a badge — e.g. "Acme App" where the long
 * form would wrap. Falls back to the long label, then the vendor name, so a deploy that sets only
 * RINGOTEL_LABEL still reads coherently and one that sets neither says "Ringotel".
 */
export function shortLabelOf(env: RingotelEnv): string {
  const s = (env.RINGOTEL_LABEL_SHORT ?? '').trim();
  return s || labelOf(env);
}

function presenceEnabled(env: RingotelEnv): boolean {
  const v = (env.RINGOTEL_PRESENCE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Parse the optional overrides map. Throws on malformed JSON so the caller treats it as a real failure. */
export function parseOverrides(env: RingotelEnv): Record<string, string> {
  const raw = (env.RINGOTEL_OVERRIDES ?? '').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw); // may throw → caught by the orchestrator → noted, never crashes /flow
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('RINGOTEL_OVERRIDES must be a JSON object');
  return parsed as Record<string, string>;
}

// ── Cache API helpers (no new binding) ───────────────────────────────────────
/**
 * Our own write timestamp, so a read can report HOW OLD its answer is.
 *
 * Not `Date`/`Age`: the real Cache API synthesizes those, but the offline selftests stub it with a Map
 * that stores the Response verbatim — so age would be untestable exactly where the TTL behaviour is
 * already untestable (the stub has no expiry). An explicit header is one value, written and read by
 * this module, and survives both.
 */
const STAMP_HEADER = 'x-sv-cached-at';

/** A cached value plus its age in whole seconds. `age` is absent for an entry written before this
 *  header existed — the caller then says "unknown", never "0 seconds old". */
export interface Aged<T> {
  value: T;
  age?: number;
}

async function cacheGetAged<T>(cache: Cache, key: string): Promise<Aged<T> | undefined> {
  const hit = await cache.match(new Request(key));
  if (!hit) return undefined;
  const stamp = Number(hit.headers.get(STAMP_HEADER));
  let value: T;
  try {
    value = (await hit.json()) as T;
  } catch {
    return undefined;
  }
  if (!Number.isFinite(stamp) || stamp <= 0) return { value };
  return { value, age: Math.max(0, Math.floor((Date.now() - stamp) / 1000)) };
}

async function cacheGet<T>(cache: Cache, key: string): Promise<T | undefined> {
  return (await cacheGetAged<T>(cache, key))?.value;
}

async function cachePut(cache: Cache, key: string, value: unknown, ttl: number): Promise<void> {
  await cache.put(
    new Request(key),
    new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}`, [STAMP_HEADER]: String(Date.now()) },
    }),
  );
}

/** Fleet org/branch directory, Cache-API-cached. Miss (or refresh) → the expensive gather. A forced
 *  refresh is coalesced fleet-wide (INDEX_REFRESH_LOCK): if a re-dig already ran within the window,
 *  the forced refresh is downgraded to a normal cached read, so looped refreshes can't amplify. */
export async function getDirectory(client: RingotelReadClient, cache: Cache, scope: string, refresh = false): Promise<OrgBranchEntry[]> {
  if (refresh) {
    // Coalesce: only the first forced refresh per window actually re-digs; the lock (short TTL) makes
    // the rest fall through to the cached directory below.
    const lockKey = indexRefreshLockKey(scope);
    const locked = await cacheGet<{ t: number }>(cache, lockKey);
    if (locked) {
      refresh = false;
    } else {
      await cachePut(cache, lockKey, { t: 1 }, INDEX_REFRESH_MIN_INTERVAL);
    }
  }
  const key = indexKey(scope);
  if (!refresh) {
    const hit = await cacheGet<OrgBranchEntry[]>(cache, key);
    if (hit) return hit;
  }
  const index = await buildOrgBranchIndex(client);
  await cachePut(cache, key, index, INDEX_TTL);
  return index;
}

/** Per-org Ringotel users, Cache-API-cached — with the age of the answer (see `Aged`). */
export async function getOrgUsersAged(client: RingotelReadClient, cache: Cache, scope: string, orgid: string, refresh = false): Promise<Aged<User[]>> {
  const key = orgUsersKey(scope, orgid);
  if (!refresh) {
    const hit = await cacheGetAged<User[]>(cache, key);
    if (hit) return hit;
  }
  const users = await client.getUsers(orgid);
  await cachePut(cache, key, users, USERS_TTL);
  return { value: users, age: 0 };
}

/** Per-org Ringotel users, Cache-API-cached. */
export async function getOrgUsers(client: RingotelReadClient, cache: Cache, scope: string, orgid: string, refresh = false): Promise<User[]> {
  return (await getOrgUsersAged(client, cache, scope, orgid, refresh)).value;
}

/**
 * The VOLATILE org settings only — `params.sso` → `ssoService`, `params.hidePassInEmail` — on their own
 * short TTL, from one `getOrganization(orgid)` call. The fresh overlay that `orgStatusForDomain` puts
 * over the hour-old index entry, so an operator flipping SSO in the Ringotel admin shows up in ~a minute
 * instead of ~an hour. That change reaches none of our write paths, so there is nothing to invalidate —
 * a short TTL is the only mechanism available.
 *
 * Derivation is `orgSettings` from `@dszp/ringotel-lib` — THE SAME function `buildOrgBranchIndex` uses
 * for the index projection. Re-deriving it here by hand is the one way this overlay could go wrong: it
 * would silently contradict the entry it sits on top of, and the contradiction would surface only as
 * "some users are told the wrong way to sign in".
 *
 * Returns `undefined` on a read failure — never throws. The caller then keeps the index's own values,
 * which are stale-but-plausible; failing the whole request because a freshness optimization failed would
 * trade a rare wrong answer for a common no answer.
 *
 * ⚠️ "Failure" here has to include the case where nothing threw. `RingotelHttp.call()` throws on an HTTP
 * error and on an in-band `{error}`, but a **200 carrying no `result`** — an empty body, a proxy
 * anomaly, `{"result": null}` for an org deleted between the index dig and now — returns `undefined`
 * quietly. `orgSettings` is deliberately null-tolerant, so that would derive `{}`, and because the
 * overlay replaces both fields WHOLESALE, `{}` reads as "SSO is not bound" and gets cached as the truth
 * for ORG_PARAMS_TTL. That is exactly the "user told the wrong way to sign in" failure this function
 * exists to eliminate, arrived at from the other direction. So a non-object response is a FAILED read,
 * not an org with no settings.
 */
export async function getOrgParams(client: RingotelReadClient, cache: Cache, scope: string, orgid: string, refresh = false): Promise<Aged<OrgSettings> | undefined> {
  const key = orgParamsKey(scope, orgid);
  if (!refresh) {
    const hit = await cacheGetAged<OrgSettings>(cache, key);
    if (hit) return hit;
  }
  try {
    // Bounded: this call sits on request paths (`/rapp/org`, the profile's app-access projection) that
    // made ZERO upstream calls before the overlay existed, and the transport has no timeout of its own.
    // A catch only helps when the promise settles — a Ringotel endpoint that HANGS would stall the
    // banner and the profile extras until the platform kills the request. Degrade to the index instead.
    const org = await withTimeout(client.getOrganization(orgid), ORG_PARAMS_TIMEOUT_MS, 'getOrganization');
    if (!org || typeof org !== 'object') throw new Error('getOrganization returned no organization record');
    const settings = orgSettings(org);
    await cachePut(cache, key, settings, ORG_PARAMS_TTL);
    return { value: settings, age: 0 };
  } catch (err) {
    console.error(JSON.stringify({ msg: 'ringotel org params read failed', orgid, error: (err as Error).message }));
    return undefined;
  }
}

/**
 * ALL org/branch entries whose `branch.address` equals the (optionally remapped) NS domain.
 *
 * Normalisation — trailing `:port`, case — belongs to the library's `findAllByAddress`, which is the
 * single definition of what "the same address" means. This used to keep a local copy annotated "match
 * ringotel-lib's normAddress exactly", which is a promise no compiler checks: the day the library
 * changed, the two would silently disagree about which domain a user's app connection is.
 *
 * What stays here is the one thing the library must not know: the deployment's `RINGOTEL_OVERRIDES`
 * remap, an audited exception for domains whose branch address does not match their NS domain.
 */
export function matchOrgsForDomain(index: OrgBranchEntry[], nsDomain: string, overrides: Record<string, string> = {}): OrgBranchEntry[] {
  return findAllByAddress(index, overrides[nsDomain] ?? nsDomain);
}

/** NS domain → the SINGLE bound org+branch. 0 or ≥2 matches ⇒ undefined (never guess). */
export function resolveDomainToOrg(index: OrgBranchEntry[], nsDomain: string, overrides: Record<string, string> = {}): OrgBranchEntry | undefined {
  const matches = matchOrgsForDomain(index, nsDomain, overrides);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Result of resolving an NS domain to its Ringotel org. */
export type OrgResolution =
  /** Exactly ONE connection is bound to this domain — the common case. */
  | { status: 'active'; entry: OrgBranchEntry }
  /** SEVERAL connections in ONE organization are bound to this domain. A supported topology (per site,
   *  per white-label app, pilot beside production), not a misconfiguration. Callers that can act on a
   *  specific record should locate it across `branches`; callers that must CREATE one have no basis to
   *  choose and must refuse until a default connection is configured. */
  | { status: 'multi'; orgid: string; branches: OrgBranchEntry[] }
  | { status: 'none' }
  /** Two or more DIFFERENT organizations claim this domain. Unlike `multi` this is a misconfiguration:
   *  there is no single source of truth, so every path refuses. */
  | { status: 'ambiguous'; orgs: string[] };

/**
 * PURE classifier over a prebuilt index.
 *
 * The split that matters: **ambiguity is about ORGANIZATIONS, not connections.** Several connections
 * under one org serving one domain is a topology we support; two orgs claiming one domain is a
 * configuration error we refuse, because nothing can tell us whose users those are.
 */
export function classifyOrgMatch(index: OrgBranchEntry[], nsDomain: string, overrides: Record<string, string> = {}): OrgResolution {
  const matches = matchOrgsForDomain(index, nsDomain, overrides);
  if (matches.length === 0) return { status: 'none' };
  if (matches.length === 1) return { status: 'active', entry: matches[0]! };
  const orgs = [...new Set(matches.map((m) => m.orgid))];
  if (orgs.length > 1) return { status: 'ambiguous', orgs };
  return { status: 'multi', orgid: orgs[0]!, branches: matches };
}

/**
 * Every connection a resolution authorises acting on. `active` → its one entry; `multi` → all of them;
 * `none`/`ambiguous` → none, because a refused binding must never be acted on. Callers iterate this
 * instead of reaching for `entry`, which only exists on `active`.
 */
export function connectionsOf(res: OrgResolution): OrgBranchEntry[] {
  if (res.status === 'active') return [res.entry];
  if (res.status === 'multi') return res.branches;
  return [];
}

/**
 * The organisation id a resolution names, or `undefined` for `none`/`ambiguous` (nothing to name).
 * Narrows by `status` alone — no cast. `multi`'s branches all share one org by construction
 * (`classifyOrgMatch` groups by `orgid` before returning `multi`), so `res.orgid` is always the right
 * answer there, not a guess at "the first one". Callers that reach this after their own
 * `connectionsOf(...).length` or `status` guard already know the result can't be undefined and may
 * assert that with `!`, same as elsewhere in this file (e.g. `matches[0]!`) — this function itself adds
 * no new throw and makes no such assumption.
 */
export function orgidOf(res: OrgResolution): string | undefined {
  if (res.status === 'active') return res.entry.orgid;
  if (res.status === 'multi') return res.orgid;
  return undefined;
}

/** Async wrapper: fetch/cache the fleet directory, then classify this domain. */
export async function resolveOrgForDomain(client: RingotelReadClient, cache: Cache, scope: string, domain: string, overrides: Record<string, string> = {}, refresh = false): Promise<OrgResolution> {
  const index = await getDirectory(client, cache, scope, refresh);
  return classifyOrgMatch(index, domain, overrides);
}

/** Construct the Ringotel read client from env (shared by enrichment + the status endpoints). */
function makeClient(env: RingotelEnv): RingotelReadClient {
  return new RingotelReadClient({ token: env.RINGOTEL_API_KEY!, ...(env.RINGOTEL_BASE_URL ? { baseUrl: env.RINGOTEL_BASE_URL } : {}) });
}

/** Construct the Ringotel WRITE client from env (the activation orchestration's mutation surface). */
export function makeWriteClient(env: RingotelEnv): RingotelWriteClient {
  return new RingotelWriteClient({ token: env.RINGOTEL_API_KEY!, ...(env.RINGOTEL_BASE_URL ? { baseUrl: env.RINGOTEL_BASE_URL } : {}) });
}

/** Evict an org's cached user list so the next read reflects a just-completed write (the "after" fence).
 *  Deletes THIS deployment's key only — which, before the keys were scoped, was the whole bug: the entry
 *  being deleted was shared with dev and dia, either of which could immediately repopulate it. */
export async function invalidateOrgUsers(cache: Cache, scope: string, orgid: string): Promise<void> {
  await cache.delete(new Request(orgUsersKey(scope, orgid)));
}

/**
 * Force-fresh resolve an NS domain to its Ringotel org AND fetch that org's users, bypassing BOTH caches
 * (directory + users) — the "before" fence for a write, so create-vs-update and the target user id are
 * decided from current state, never a stale entry. Returns the resolution (none/ambiguous refuse) plus,
 * when active, the fresh users.
 */
export async function resolveForWrite(env: RingotelEnv, cache: Cache, domain: string): Promise<OrgResolution & { users?: User[] }> {
  const client = makeClient(env);
  const scope = scopeOf(env);
  const res = await resolveOrgForDomain(client, cache, scope, domain, parseOverrides(env), true);
  // `multi` needs the org's users just as much as `active` does — callers locate a record ACROSS the
  // bound connections. Returning early here would hand them `undefined`, which reads as "no records"
  // and would silently make every multi-connection sweep and event a no-op.
  const orgid = orgidOf(res);
  if (!orgid) return res;
  const users = await getOrgUsers(client, cache, scope, orgid, true);
  return { ...res, users };
}

/**
 * PURE: every branch address owned by exactly ONE organization, sorted.
 *
 * Counting distinct **orgs** rather than rows is the whole point. A domain served by two connections
 * of one organization is a supported topology and belongs in scope — dropping it would leave exactly
 * the domains this feature adds unswept, which is where orphaned billed seats accumulate. A domain
 * claimed by two organizations is a misconfiguration and stays dropped, matching `classifyOrgMatch`.
 */
export function singleOrgAddresses(index: OrgBranchEntry[]): string[] {
  const orgsByAddress = new Map<string, Set<string>>();
  for (const e of index) {
    const a = String((e as { address?: unknown }).address ?? '').trim().toLowerCase().replace(/\.+$/, '');
    if (!a) continue;
    const set = orgsByAddress.get(a) ?? new Set<string>();
    set.add(e.orgid);
    orgsByAddress.set(a, set);
  }
  return [...orgsByAddress.entries()].filter(([, orgs]) => orgs.size === 1).map(([a]) => a).sort();
}

/**
 * Every NS domain that maps to **exactly one** Ringotel org — the natural scope for an event config set
 * to `*`, since a domain with no org (or one claimed by several) has nothing unambiguous to sync to.
 */
export async function ringotelDomains(env: RingotelEnv, cache: Cache, refresh = false): Promise<string[]> {
  const index = await getDirectory(makeClient(env), cache, scopeOf(env), refresh);
  return singleOrgAddresses(index);
}

/** Banner endpoint body. `eligible` is a stubbed future signal (OneBill paid flag / client-type block). */
export interface OrgStatusResponse {
  active: boolean;
  orgId?: string;
  appDomain?: string;
  eligible: boolean;
  /** Raw `params.sso` for the org, when bound. Interpreting it is appAccess.ts's job. */
  ssoService?: string;
  /** Does this org's credentials email hide the password behind a one-time link? Absent when the org
   *  doesn't report it — the consumer then hedges rather than asserting either case.
   *  DELIBERATELY TERSE: this object is serialized to the browser, and a field spelled with the upstream
   *  vendor's own parameter name announces what is underneath to anyone reading the network tab — the
   *  same reason the routes are `/rapp/*`. The descriptive name stays in the library, which is not
   *  client-visible. */
  hPIE?: boolean;
  /** Age in whole seconds of the VOLATILE data behind this answer — the per-org settings overlay, not
   *  the hour-long structural index, which is long-lived on purpose. Absent when unknown. Surfaced so a
   *  stale read can LOOK stale: a silent wrong answer is worse than a visibly old one, and until now the
   *  only way to clear one was to know that `?refresh=ringotel` exists. */
  age?: number;
}

/** Is domain D's Ringotel org active? Thin projection over the cached directory, with the two volatile
 *  org settings overlaid from a much shorter-lived per-org read (see `getOrgParams`). */
export async function orgStatusForDomain(domain: string, env: RingotelEnv, cache: Cache, opts: { refresh?: boolean } = {}): Promise<OrgStatusResponse> {
  const eligible = true; // TODO(eligible): compute from a future signal (OneBill paid-access flag / client-type block); false ⇒ client suppresses amber.
  const client = makeClient(env);
  const scope = scopeOf(env);
  const res = await resolveOrgForDomain(client, cache, scope, domain, parseOverrides(env), opts.refresh);
  const branches = connectionsOf(res);
  if (branches.length) {
    const first = branches[0]!;
    // The overlay REPLACES both fields wholesale when the read succeeds — including by their absence.
    // That is the fix, and it has to cut both ways: an index entry with no `ssoService` and a fresh read
    // that has one must report SSO enabled (the reported symptom), and equally an index entry that HAS
    // one must report SSO gone once the operator unbinds it. Merging the two would make "unbind" invisible
    // for an hour. On a failed read the entry's own values stand.
    //
    // Org-level settings come from the ORG, so several connections of one org share them — reading the
    // first entry is not a choice between connections, it is the only org there is.
    const overlay = await getOrgParams(client, cache, scope, first.orgid, opts.refresh);
    const settings: OrgSettings = overlay ? overlay.value : { ...(first.ssoService ? { ssoService: first.ssoService } : {}), ...(typeof first.hidePassInEmail === 'boolean' ? { hidePassInEmail: first.hidePassInEmail } : {}) };
    return {
      active: true,
      orgId: first.orgid,
      appDomain: first.orgDomain ?? first.host,
      eligible,
      ...(settings.ssoService ? { ssoService: settings.ssoService } : {}),
      ...(typeof settings.hidePassInEmail === 'boolean' ? { hPIE: settings.hidePassInEmail } : {}),
      ...(overlay && typeof overlay.age === 'number' ? { age: overlay.age } : {}),
    };
  }
  return { active: false, eligible };
}

/** Users-column endpoint body. `users` present only when the domain has exactly one org. */
export interface UsersStatusResponse {
  active: boolean;
  users?: Record<string, UserAppStatus>;
  /** Age in whole seconds of the cached org-user list this answer came from (0 = just fetched). Absent
   *  when unknown or when there is no org. Lets the users list SHOW that it is up to 10 minutes old
   *  rather than presenting a stale activation state as current. */
  age?: number;
}

/** Per-user app status for domain D (bulk, one org-users call). Empty unless exactly one org. */
export async function usersStatusForDomain(domain: string, env: RingotelEnv, cache: Cache, opts: { refresh?: boolean } = {}): Promise<UsersStatusResponse> {
  const client = makeClient(env);
  const scope = scopeOf(env);
  const res = await resolveOrgForDomain(client, cache, scope, domain, parseOverrides(env), opts.refresh);
  const branches = connectionsOf(res);
  if (!branches.length) return { active: false };
  const orgid = orgidOf(res)!; // guarded above: branches.length > 0 ⇒ status is active/multi
  const users = await getOrgUsersAged(client, cache, scope, orgid, opts.refresh);
  return {
    active: true,
    users: usersStatusMap(users.value, branches, resolveRingotelConfig(env).suffix),
    ...(typeof users.age === 'number' ? { age: users.age } : {}),
  };
}

/**
 * Per-user status with FRESH org-user data (cached directory + force-fresh users). The profile-page
 * indicator uses this so a just-completed activation shows immediately, matching the n8n status check —
 * the cached path (usersStatusForDomain) can otherwise lag a write until its cache-invalidate settles.
 * Only the users are re-fetched (the org/branch directory is stable and stays cached).
 */
export async function usersStatusForDomainFresh(domain: string, env: RingotelEnv, cache: Cache): Promise<UsersStatusResponse> {
  const client = makeClient(env);
  const scope = scopeOf(env);
  const res = await resolveOrgForDomain(client, cache, scope, domain, parseOverrides(env), false); // directory cached
  const branches = connectionsOf(res);
  if (!branches.length) return { active: false };
  const orgid = orgidOf(res)!; // guarded above: branches.length > 0 ⇒ status is active/multi
  const users = await getOrgUsers(client, cache, scope, orgid, true); // users FRESH (bypass + refresh cache)
  return { active: true, users: usersStatusMap(users, branches, resolveRingotelConfig(env).suffix), age: 0 };
}

/** Body of GET /rapp/orgs: the caller's Ringotel-enabled domains → {orgId, appDomain}. */
export interface OrgsStatusResponse {
  enabled: Record<string, { orgId: string; appDomain?: string }>;
}

/**
 * PURE: resolve each domain to its Ringotel org against a prebuilt directory index. A domain bound to
 * one connection, or to several connections of ONE organization, is enabled and reports that org;
 * 0 matches or several ORGS are omitted (the client renders those grey, never guessing an org). No
 * I/O; a lookup over the cached directory. Powers the /portal/domains column.
 */
export function enabledOrgsForDomains(index: OrgBranchEntry[], domains: string[], overrides: Record<string, string> = {}): OrgsStatusResponse['enabled'] {
  const enabled: OrgsStatusResponse['enabled'] = {};
  for (const d of domains) {
    const res = classifyOrgMatch(index, d, overrides);
    const branches = connectionsOf(res);
    if (!branches.length) continue;
    const first = branches[0]!;
    const appDomain = first.orgDomain ?? first.host;
    enabled[d] = { orgId: first.orgid, ...(appDomain ? { appDomain } : {}) };
  }
  return enabled;
}

/** Bulk enabled-status over the caller's domains. Directory-only (cached ~1h) — NO per-domain calls. */
export async function orgsStatusForDomains(domains: string[], env: RingotelEnv, cache: Cache, opts: { refresh?: boolean } = {}): Promise<OrgsStatusResponse> {
  const client = makeClient(env);
  const index = await getDirectory(client, cache, scopeOf(env), opts.refresh);
  return { enabled: enabledOrgsForDomains(index, domains, parseOverrides(env)) };
}

/** A connection reference: the id we filter on, plus the operator-facing name we display. */
export type BranchRef = { branchid: string; branchName?: string };

/** Normalize the "which connection(s)" argument. A bare string keeps every existing single-connection
 *  caller working unchanged; an array is the multi-connection form. */
function branchIndex(branches: string | readonly BranchRef[]): Map<string, string | undefined> {
  if (typeof branches === 'string') return new Map([[branches, undefined]]);
  return new Map(branches.map((b) => [b.branchid, b.branchName]));
}

/** True when this user sits on one of the given connections. A record with NO branchid is accepted,
 *  matching the previous behaviour — the API has returned such records and excluding them would hide a
 *  live user. */
function onBranch(u: { branchid?: unknown }, wanted: Map<string, string | undefined>): boolean {
  return u.branchid == null || wanted.has(String(u.branchid));
}

/** Index the org's users by extension, limited to the bound connection(s). */
export function buildExtIndex(users: User[], branches: string | readonly BranchRef[]): Map<string, User> {
  const wanted = branchIndex(branches);
  const byExt = new Map<string, User>();
  for (const u of users) {
    if (!onBranch(u, wanted)) continue;
    const ext = u.extension != null ? String(u.extension) : '';
    if (ext) byExt.set(ext, u);
  }
  return byExt;
}

/**
 * Ringotel presence COLOR BUCKET from the user-level `state` (verified live 2026-07-15 vs the Ringotel
 * admin panel + help.ringotel.com/en/articles/11191265): state 0=Offline, 1=Online, 2=Available,
 * 5=Available on PBX; other non-zero values (Busy / Do Not Disturb / At the Desk) all mean the app is
 * registered. The ONLY not-really-there states are Offline and Available-on-PBX. NB the device-level
 * `st` (0=offline, 1=online, 2=available) is NOT presence — we previously read `st===0` as "online",
 * which was exactly backwards (an offline user's devices are `st:0`).
 */
export function presenceOf(u: User): 'active' | 'pbx' | 'offline' {
  const s = Number(u.state);
  if (Number.isNaN(s) || s === 0) return 'offline';
  if (s === 5) return 'pbx';
  return 'active';
}

/** Human label for a Ringotel user `state` (known values; unknown → "Status <n>"). */
export function stateLabel(state: number): string {
  switch (state) {
    case 0: return 'Offline';
    case 1: return 'Online';
    case 2: return 'Available';
    case 5: return 'Available on PBX';
    default: return `Status ${state}`;
  }
}

/** Per-user app status for the Users-page column. */
export interface UserAppStatus {
  /** Ringotel-activated (the app is provisioned): `status === 1`. */
  activated: boolean;
  /** Color bucket for the dot: active (green) | pbx (orange) | offline (gray). */
  presence: 'active' | 'pbx' | 'offline';
  /** Human status label (Online / Available / Available on PBX / Offline / Status N). */
  label: string;
  /** Raw Ringotel user `state`. */
  state: number;
  /** Configured app device count. */
  devices: number;
  /** Last-activity time (ms epoch, from `stime`); 0 if unknown. */
  lastSeen: number;
  /**
   * Deterministic record-health flags from `assessUserHealth` (@dszp/ringotel-lib) — computed from the
   * ALREADY-cached Ringotel user data, so this costs no extra API call. `no-ns-device` is appended
   * separately by the profile endpoint, which reads the user's device list anyway.
   */
  health: { flags: HealthFlag[]; severity: HealthSeverity };
  /** Ringotel SIP username (`<ext><suffix>`) — what a non-SSO user types to sign in. */
  username?: string;
  /** Connection (Ringotel branch) NAME this record lives on. Present only when the domain has more than
   *  one bound connection — with a single connection it is noise on every row. */
  connection?: string;
  /** True when this extension has a record on MORE THAN ONE connection. Surfaced, never resolved: which
   *  one is "right" is not something we can know, and picking one would write to the wrong seat. */
  connectionConflict?: boolean;
}

/** Project the bound connection(s)' Ringotel users to per-ext presence. Presence = the user-level
 *  `state` (see `presenceOf`), NOT device `st`. */
export function usersStatusMap(users: User[], branches: string | readonly BranchRef[], suffix = 'r'): Record<string, UserAppStatus> {
  const wanted = branchIndex(branches);
  const multi = wanted.size > 1;

  // Sibling counts must come from the RAW filtered list: buildExtIndex below keys by extension and
  // therefore collapses duplicates, which is exactly the condition the `duplicate` flag reports.
  // `branchesPerExt` is the multi-connection analogue — an extension whose records span two connections
  // is a CONFLICT, distinct from two records on one connection, which is a duplicate.
  const perExt = new Map<string, number>();
  const branchesPerExt = new Map<string, Set<string>>();
  for (const u of users) {
    if (!onBranch(u, wanted)) continue;
    const ext = u.extension != null ? String(u.extension) : '';
    if (!ext) continue;
    perExt.set(ext, (perExt.get(ext) ?? 0) + 1);
    const set = branchesPerExt.get(ext) ?? new Set<string>();
    if (u.branchid != null) set.add(String(u.branchid));
    branchesPerExt.set(ext, set);
  }

  const out: Record<string, UserAppStatus> = {};
  for (const [ext, u] of buildExtIndex(users, branches)) {
    const state = Number(u.state) || 0;
    const connection = multi && u.branchid != null ? wanted.get(String(u.branchid)) : undefined;
    out[ext] = {
      activated: Number(u.status) === 1,
      presence: presenceOf(u),
      label: stateLabel(state),
      state,
      devices: deviceCount(u),
      lastSeen: Number(u.stime) || 0,
      health: assessUserHealth(u, { ext, suffix, siblingCount: perExt.get(ext) ?? 1 }),
      ...(u.username ? { username: u.username } : {}),
      ...(connection ? { connection } : {}),
      ...((branchesPerExt.get(ext)?.size ?? 0) > 1 ? { connectionConflict: true } : {}),
    };
  }
  return out;
}

/** Device count from a Ringotel user's attached devices (`devs[]`). */
function deviceCount(u: User): number {
  return Array.isArray(u.devs) ? u.devs.length : 0;
}

/**
 * User "online" signal for the /flow diagram presence circle: the app is registered — i.e. the user
 * `state` is not Offline/Available-on-PBX (see `presenceOf`). NB the earlier device-`st===0` heuristic
 * was inverted (`st===0` is OFFLINE); presence lives on the user-level `state`.
 */
function isOnline(u: User): boolean {
  return presenceOf(u) === 'active';
}

/** The bare presence circle, e.g. "🟢 " — tied to the DEVICE, placed before the ext token. */
function presenceTag(u: User): string {
  return `${isOnline(u) ? '🟢' : '🔴'} `;
}

/**
 * The inline app annotation body: "<label>, <N> device(s)" — placed AFTER the ext token. Label is
 * config-driven (never a hard-coded internal name); the user's name is NOT repeated (the device/agent
 * line already carries it). Presence is a separate tag before the token, not part of this.
 */
function appBody(u: User, label: string): string {
  const n = deviceCount(u);
  return `${label}, ${n} device${n === 1 ? '' : 's'}`;
}

/** Extension of a `user` node, parsed from its `ext <n>` sub-label. */
function userNodeExt(sub: string | undefined): string | undefined {
  const m = (sub ?? '').match(/ext\s+(\d+)/i);
  return m ? m[1] : undefined;
}

const APP_DEVICE_TOKEN = /\((\d+)r\)/; // first "(211r)" token on a device/agent line → base ext "211"

/**
 * Pure post-processor: for each `agents`/`devices` line that references an `###r` app device whose
 * base extension resolves to a Ringotel user, annotate that line INLINE around the `(102r)` token —
 * a 🟢/🔴 presence circle BEFORE it (device-tied, only when `presence` is on) and the app + device
 * count AFTER it:
 *   "📱 Elizabeth Ross (102r) · manual" → "📱 Elizabeth Ross 🟢 (102r) (Ringotel, 2 devices) · manual"
 * The matching `user` node gets the same annotation on its `ext N` sub. `label`/`presence` come from
 * config (the live deploy swaps the label). Mutates `graph` in place; returns the number of
 * lines/nodes annotated. No network, no env — trivially unit-testable.
 */
export function enrichGraph(graph: FlowGraph, byExt: Map<string, User>, label: string, presence = false): number {
  let changed = 0;
  for (const node of graph.nodes) {
    if (node.kind === 'agents' || node.kind === 'devices') {
      if (!Array.isArray(node.lines) || node.lines.length === 0) continue;
      node.lines = node.lines.map((line) => {
        const m = line.match(APP_DEVICE_TOKEN);
        if (!m) return line;
        const user = byExt.get(m[1]!);
        if (!user) return line;
        changed++;
        // 🟢/🔴 before the "(102r)" token; app info after it; any trailing " · manual" stays put.
        const prefix = presence ? presenceTag(user) : '';
        return line.replace(m[0], `${prefix}${m[0]} (${appBody(user, label)})`);
      });
    } else if (node.kind === 'user') {
      const ext = userNodeExt(node.sub);
      const user = ext ? byExt.get(ext) : undefined;
      if (user) {
        const tag = presence ? `${isOnline(user) ? '🟢' : '🔴'} ` : '';
        node.sub = `${node.sub ?? `ext ${ext}`} · ${tag}${appBody(user, label)}`;
        changed++;
      }
    }
  }
  return changed;
}

/**
 * Orchestrate enrichment for one flow. NO-OP unless enabled. Best-effort and fully isolated: a domain
 * with no Ringotel org renders silently un-enriched (the common case); a genuine failure (auth,
 * network, malformed overrides) is caught, logged, and noted on the graph — it NEVER changes the
 * /flow status or blocks the NS diagram.
 */
export async function enrichFlowGraph(graph: FlowGraph, domain: string, env: RingotelEnv, cache: Cache, opts: { refresh?: boolean } = {}): Promise<void> {
  if (!ringotelEnabled(env)) return; // the gate
  try {
    const client = makeClient(env);
    const scope = scopeOf(env);
    const overrides = parseOverrides(env);
    const res = await resolveOrgForDomain(client, cache, scope, domain, overrides, opts.refresh);
    if (res.status === 'none') return; // NORMAL & COMMON: no Ringotel org for this NS domain — silent.
    if (res.status === 'ambiguous') {
      // Two orgs claim this NS domain's address — refuse to guess (would risk cross-domain data bleed).
      console.error(JSON.stringify({ msg: 'ringotel binding ambiguous', domain, orgs: res.orgs }));
      graph.notes = [...(graph.notes ?? []), `${labelOf(env)} enrichment ambiguous (multiple orgs)`];
      return;
    }
    const branches = connectionsOf(res);
    if (!branches.length) return; // 'none' and 'ambiguous' already returned above
    const orgid = orgidOf(res)!; // guarded above: branches.length > 0 ⇒ status is active/multi
    const users = await getOrgUsers(client, cache, scope, orgid, opts.refresh);
    // Every bound connection: an agent on a diagram is on whichever connection holds their record, and
    // a diagram that silently omits half a domain's agents is worse than one with no presence at all.
    enrichGraph(graph, buildExtIndex(users, branches), labelOf(env), presenceEnabled(env));
  } catch (err) {
    console.error(JSON.stringify({ msg: 'ringotel enrichment failed', domain, error: (err as Error).message }));
    graph.notes = [...(graph.notes ?? []), `${labelOf(env)} enrichment unavailable`];
  }
}
