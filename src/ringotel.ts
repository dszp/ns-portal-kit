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

import { RingotelReadClient, buildOrgBranchIndex, type OrgBranchEntry, type User } from '@dszp/ringotel-lib';
import type { FlowGraph } from '@dszp/netsapiens-lib';

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
}

/** Vendor name. Both labels default to it, so an unconfigured deploy says "Ringotel" — the truth —
 *  rather than anyone's white-label branding. White-label names arrive via env, never source. */
const DEFAULT_LABEL = 'Ringotel';
const INDEX_KEY = 'https://ringotel-cache.internal/index';
const INDEX_TTL = 3600; // 1h
const USERS_TTL = 600; //  10m
const orgUsersKey = (orgid: string) => `https://ringotel-cache.internal/org/${orgid}/users`;

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
async function cacheGet<T>(cache: Cache, key: string): Promise<T | undefined> {
  const hit = await cache.match(new Request(key));
  if (!hit) return undefined;
  try {
    return (await hit.json()) as T;
  } catch {
    return undefined;
  }
}
async function cachePut(cache: Cache, key: string, value: unknown, ttl: number): Promise<void> {
  await cache.put(new Request(key), new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` } }));
}

/** Fleet org/branch directory, Cache-API-cached. Miss (or refresh) → the expensive gather. */
export async function getDirectory(client: RingotelReadClient, cache: Cache, refresh = false): Promise<OrgBranchEntry[]> {
  if (!refresh) {
    const hit = await cacheGet<OrgBranchEntry[]>(cache, INDEX_KEY);
    if (hit) return hit;
  }
  const index = await buildOrgBranchIndex(client);
  await cachePut(cache, INDEX_KEY, index, INDEX_TTL);
  return index;
}

/** Per-org Ringotel users, Cache-API-cached. */
export async function getOrgUsers(client: RingotelReadClient, cache: Cache, orgid: string, refresh = false): Promise<User[]> {
  const key = orgUsersKey(orgid);
  if (!refresh) {
    const hit = await cacheGet<User[]>(cache, key);
    if (hit) return hit;
  }
  const users = await client.getUsers(orgid);
  await cachePut(cache, key, users, USERS_TTL);
  return users;
}

/** Match ringotel-lib's normAddress exactly: strip a trailing :port, lowercase. */
const normAddr = (a: string): string => a.replace(/:\d+$/, '').toLowerCase();

/**
 * ALL org/branch entries whose normalized `branch.address` equals the (optionally remapped) NS domain.
 * Returning every match (not the first) is what lets the caller detect an ambiguous binding and refuse
 * rather than silently pick one org's data for another domain.
 */
export function matchOrgsForDomain(index: OrgBranchEntry[], nsDomain: string, overrides: Record<string, string> = {}): OrgBranchEntry[] {
  const target = normAddr(overrides[nsDomain] ?? nsDomain);
  return index.filter((e) => typeof e.address === 'string' && normAddr(e.address) === target);
}

/** NS domain → the SINGLE bound org+branch. 0 or ≥2 matches ⇒ undefined (never guess). */
export function resolveDomainToOrg(index: OrgBranchEntry[], nsDomain: string, overrides: Record<string, string> = {}): OrgBranchEntry | undefined {
  const matches = matchOrgsForDomain(index, nsDomain, overrides);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Result of resolving an NS domain to its Ringotel org: exactly-one binding, or a refusal. */
export type OrgResolution =
  | { status: 'active'; entry: OrgBranchEntry }
  | { status: 'none' }
  | { status: 'ambiguous'; orgs: string[] };

/** PURE classifier over a prebuilt index. 0 → none; 1 → active(entry); ≥2 → ambiguous(orgids). */
export function classifyOrgMatch(index: OrgBranchEntry[], nsDomain: string, overrides: Record<string, string> = {}): OrgResolution {
  const matches = matchOrgsForDomain(index, nsDomain, overrides);
  if (matches.length === 0) return { status: 'none' };
  if (matches.length > 1) return { status: 'ambiguous', orgs: matches.map((m) => m.orgid) };
  return { status: 'active', entry: matches[0]! };
}

/** Async wrapper: fetch/cache the fleet directory, then classify this domain. */
export async function resolveOrgForDomain(client: RingotelReadClient, cache: Cache, domain: string, overrides: Record<string, string> = {}, refresh = false): Promise<OrgResolution> {
  const index = await getDirectory(client, cache, refresh);
  return classifyOrgMatch(index, domain, overrides);
}

/** Construct the Ringotel read client from env (shared by enrichment + the status endpoints). */
function makeClient(env: RingotelEnv): RingotelReadClient {
  return new RingotelReadClient({ token: env.RINGOTEL_API_KEY!, ...(env.RINGOTEL_BASE_URL ? { baseUrl: env.RINGOTEL_BASE_URL } : {}) });
}

/** Banner endpoint body. `eligible` is a stubbed future signal (OneBill paid flag / client-type block). */
export interface OrgStatusResponse {
  active: boolean;
  orgId?: string;
  appDomain?: string;
  eligible: boolean;
}

/** Is domain D's Ringotel org active? Thin projection over the cached directory. */
export async function orgStatusForDomain(domain: string, env: RingotelEnv, cache: Cache, opts: { refresh?: boolean } = {}): Promise<OrgStatusResponse> {
  const eligible = true; // TODO(eligible): compute from a future signal (OneBill paid-access flag / client-type block); false ⇒ client suppresses amber.
  const client = makeClient(env);
  const res = await resolveOrgForDomain(client, cache, domain, parseOverrides(env), opts.refresh);
  if (res.status === 'active') return { active: true, orgId: res.entry.orgid, appDomain: res.entry.orgDomain ?? res.entry.host, eligible };
  return { active: false, eligible };
}

/** Users-column endpoint body. `users` present only when the domain has exactly one org. */
export interface UsersStatusResponse {
  active: boolean;
  users?: Record<string, UserAppStatus>;
}

/** Per-user app status for domain D (bulk, one org-users call). Empty unless exactly one org. */
export async function usersStatusForDomain(domain: string, env: RingotelEnv, cache: Cache, opts: { refresh?: boolean } = {}): Promise<UsersStatusResponse> {
  const client = makeClient(env);
  const res = await resolveOrgForDomain(client, cache, domain, parseOverrides(env), opts.refresh);
  if (res.status !== 'active') return { active: false };
  const users = await getOrgUsers(client, cache, res.entry.orgid, opts.refresh);
  return { active: true, users: usersStatusMap(users, res.entry.branchid) };
}

/** Body of GET /ringotel/orgs: the caller's Ringotel-enabled domains → {orgId, appDomain}. */
export interface OrgsStatusResponse {
  enabled: Record<string, { orgId: string; appDomain?: string }>;
}

/**
 * PURE: resolve each domain to its Ringotel org against a prebuilt directory index, honoring the
 * exactly-one binding invariant — 0 matches or ≥2 (ambiguous) → omitted (the client renders those grey,
 * never guessing an org). No I/O; a lookup over the cached directory. Powers the /portal/domains column.
 */
export function enabledOrgsForDomains(index: OrgBranchEntry[], domains: string[], overrides: Record<string, string> = {}): OrgsStatusResponse['enabled'] {
  const enabled: OrgsStatusResponse['enabled'] = {};
  for (const d of domains) {
    const res = classifyOrgMatch(index, d, overrides);
    if (res.status === 'active') {
      const appDomain = res.entry.orgDomain ?? res.entry.host;
      enabled[d] = { orgId: res.entry.orgid, ...(appDomain ? { appDomain } : {}) };
    }
  }
  return enabled;
}

/** Bulk enabled-status over the caller's domains. Directory-only (cached ~1h) — NO per-domain calls. */
export async function orgsStatusForDomains(domains: string[], env: RingotelEnv, cache: Cache, opts: { refresh?: boolean } = {}): Promise<OrgsStatusResponse> {
  const client = makeClient(env);
  const index = await getDirectory(client, cache, opts.refresh);
  return { enabled: enabledOrgsForDomains(index, domains, parseOverrides(env)) };
}

/** Index the org's users by extension, limited to the NS-connected branch. */
export function buildExtIndex(users: User[], branchid: string): Map<string, User> {
  const byExt = new Map<string, User>();
  for (const u of users) {
    if (u.branchid != null && String(u.branchid) !== branchid) continue;
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
}

/** Project a branch's Ringotel users to per-ext presence (branch-filtered). Presence = the user-level
 *  `state` (see `presenceOf`), NOT device `st`. */
export function usersStatusMap(users: User[], branchid: string): Record<string, UserAppStatus> {
  const out: Record<string, UserAppStatus> = {};
  for (const [ext, u] of buildExtIndex(users, branchid)) {
    const state = Number(u.state) || 0;
    out[ext] = { activated: Number(u.status) === 1, presence: presenceOf(u), label: stateLabel(state), state, devices: deviceCount(u), lastSeen: Number(u.stime) || 0 };
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
    const overrides = parseOverrides(env);
    const res = await resolveOrgForDomain(client, cache, domain, overrides, opts.refresh);
    if (res.status === 'none') return; // NORMAL & COMMON: no Ringotel org for this NS domain — silent.
    if (res.status === 'ambiguous') {
      // Two orgs claim this NS domain's address — refuse to guess (would risk cross-domain data bleed).
      console.error(JSON.stringify({ msg: 'ringotel binding ambiguous', domain, orgs: res.orgs }));
      graph.notes = [...(graph.notes ?? []), `${labelOf(env)} enrichment ambiguous (multiple orgs)`];
      return;
    }
    const users = await getOrgUsers(client, cache, res.entry.orgid, opts.refresh);
    enrichGraph(graph, buildExtIndex(users, res.entry.branchid), labelOf(env), presenceEnabled(env));
  } catch (err) {
    console.error(JSON.stringify({ msg: 'ringotel enrichment failed', domain, error: (err as Error).message }));
    graph.notes = [...(graph.notes ?? []), `${labelOf(env)} enrichment unavailable`];
  }
}
