/**
 * Cloudflare Worker entry — the deployable backend + internal viewer. Two auth modes:
 *
 *   STANDALONE mode (internal viewer, behind CF Access): a stored NS service token (`NS_API_TOKEN`
 *     secret) reads ANY domain the token is scoped to. Enables the domain browser. CF Access
 *     authenticates the human at the edge; this Worker trusts requests that reach it. This is the
 *     "local fake-worker + internal viewer" path — start here.
 *
 *   DELEGATED mode (portal injection, later): the portal user's `ns_t` arrives as
 *     `Authorization: Bearer <ns_t>`; jwt.verify() gates it (cached) and reads are scoped to the
 *     token's own domain. No service token involved.
 *
 * Endpoints:
 *   GET /                       → the viewer SPA (standalone mode)
 *   GET /health                 → { ok }
 *   GET /domains                → [{ domain, description }]  (service: all scoped; delegated: just yours)
 *   GET /entities?domain=D      → { dids, users, queues, attendants }  (shallow read)
 *   GET /flow?domain=D&kind&ref&format=json|html|mermaid  → the resolved flow
 *
 * Worker-only (caches / ExecutionContext); NOT in the portable library surface. See REORG.md.
 */

import {
  verify,
  tokenKey,
  assertBareServer,
  NsClient,
  NsApiError,
  fetchDomainSnapshot,
  listDomains,
  resolveFlow,
  listEntities,
  toMermaid,
  renderGalleryHtml,
  toPrincipal,
  isResellerScope,
  can,
  type Principal,
  type FeaturePolicies,
  type CallSensitivity,
  type JwtVerdict,
  type VerdictCache,
  type EntityRef,
} from '@dszp/netsapiens-lib';
import { viewerHtml } from './viewerApp.js';
import { brandAccent, productName, VERSION } from './brand.js';
import { needsSetup, setupHtml } from './setup.js';
import { portalModeHtml } from './portalInfo.js';
import { serviceTokenBlocked, exposureHtml, BLOCKED_REASON } from './exposure.js';
import { enrichFlowGraph, ringotelEnabled, orgStatusForDomain, usersStatusForDomain, orgsStatusForDomains } from './ringotel.js';
import { enrichDeviceDetails, nsDeviceDetailsEnabled } from './nsDevices.js';
import { accessConfig, verifyAccessRequest } from './access.js';

interface Env {
  /** NS API host, e.g. "api.example.com" (var). */
  NS_SERVER: string;
  /** Service API token for the internal viewer (secret; `wrangler secret put` / .dev.vars). Optional. */
  NS_API_TOKEN?: string;
  /** Comma-separated allowed browser origins for CORS (var). */
  ALLOWED_ORIGINS?: string;
  /**
   * Comma-separated domain allowlist. When set, /domains is filtered to it and /entities + /flow
   * reject any other domain (403) — even one a valid token could otherwise read. Empty ⇒ unrestricted
   * (bounded only by the token's NS scope). Set this in dev to keep the tool off the wider fleet.
   */
  ALLOWED_DOMAINS?: string;

  /** Manager Portal host that issues ns_t, e.g. "manage.example.com". REQUIRED for delegated auth:
   *  jwt.verify() has no issuer default, so an unset value fails closed (see portalIss()). */
  NS_PORTAL_ISS?: string;
  /** Deliberate opt-out of the ungated-service-token gate (src/exposure.ts). Truthy ⇒ use NS_API_TOKEN
   *  even with no Access gate in front. Only for deployments protected some other way (mTLS, a WAF, an
   *  authenticating proxy). */
  ALLOW_UNGATED_SERVICE_TOKEN?: string;

  // ── Optional: branding (see src/brand.ts) ──────────────────────────────────
  // The shared library ships vendor-neutral themes only, so branding is deploy config, not source.
  /** Brand accent hex (e.g. "#b3282d") for the flow modal + the viewer's brand theme. Absent ⇒
   *  unbranded: the neutral `ns-portal` theme. */
  BRAND_ACCENT?: string;
  /** Company name, e.g. "Acme Voice" — drives the product name ("<name> Portal Kit v<ver>") and the
   *  default theme label ("<name> portal"). A white-label NAME ⇒ set as a SECRET, never a var. */
  BRAND_NAME?: string;
  /** Theme label override for the viewer's picker. Defaults to "<BRAND_NAME> portal", else "Brand". */
  BRAND_LABEL?: string;

  // ── Optional integration: Ringotel enrichment ──────────────────────────────
  // Fully gated: absent RINGOTEL_API_KEY ⇒ the Worker behaves exactly as the NS-only baseline
  // (no Ringotel calls, no enrichment, future Ringotel routes 404). See src/ringotel.ts.
  /** Ringotel AdminAPI key (secret). Presence enables the Ringotel integration. */
  RINGOTEL_API_KEY?: string;
  /** Optional non-default Ringotel shell base URL. */
  RINGOTEL_BASE_URL?: string;
  /** Long display label for enriched lines (default "Ringotel"; set a white-label name via env only). */
  RINGOTEL_LABEL?: string;
  /** Short label for tight surfaces, e.g. a column header. Defaults to RINGOTEL_LABEL, then "Ringotel". */
  RINGOTEL_LABEL_SHORT?: string;
  /** Opt-in 🟢/🔴 presence circle on enriched lines ("1"/"true"/…). Off by default (see src/ringotel.ts). */
  RINGOTEL_PRESENCE?: string;
  /** Optional JSON `{ "<nsDomain>": "<branchAddressToMatch>" }` for rare address mismatches. */
  RINGOTEL_OVERRIDES?: string;

  // ── Optional integration: NetSapiens device details (basic; see src/nsDevices.ts) ──
  /** Truthy enables desk-phone enrichment (model + 🟢/🔴 registration presence) on ###/#### device lines. */
  NS_DEVICE_DETAILS?: string;

  // ── Optional: Cloudflare Access gate (standalone-mode deployments behind Zero Trust; see src/access.ts) ──
  /** Access Application Audience (AUD) tag. Presence turns ON in-Worker Access-JWT verification. */
  ACCESS_AUD?: string;
  /** Access team domain, e.g. "yourteam.cloudflareaccess.com" (bare host or full URL). */
  ACCESS_TEAM_DOMAIN?: string;

  /**
   * Comma-separated domains to hide/refuse regardless of the token's scope — e.g. the DID-holding
   * "0000.…service" domain that has nothing to diagram. Filtered out of /domains AND refused (403) on
   * /entities + /flow, so a deep-link can't reach one either. Applies to both auth modes.
   */
  BLOCKED_DOMAINS?: string;

  /**
   * "1"/"true" ⇒ PORTAL BACKEND MODE: delegated-only (no service-token fallback) + policy-gated
   * (verify → toPrincipal → can('portal.access')). Unset ⇒ the existing dual-mode Worker (dia/local),
   * byte-identical. See src/portal.selftest.ts.
   */
  PORTAL_MODE?: string;

  /**
   * OPTIONAL Cloudflare Rate Limiting binding for ns_t live-check throttling (defense-in-depth, see
   * rateLimitLiveCheck). Declared in wrangler.jsonc as a `ratelimits` binding; absent ⇒ the in-isolate
   * limiter still applies, so a fork with no binding is safe, just per-isolate. Structural type so the
   * offline selftests satisfy Env without a real binding.
   */
  JWT_RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

// ── ns_t live-check rate limit (defense-in-depth vs forged-token upstream amplification) ─────────────
// A forged ns_t needs only aud:"ns" + the PUBLIC portal host + a future exp — no signing key — so an
// attacker can mint N distinct tokens, each a verdict-cache MISS → N live GET /jwt calls to the NS core.
// The live check is still the real authority; this only bounds how fast ONE client can force those
// upstream calls. The Worker is the only place a cap can live: NS sees Cloudflare egress IPs, not the
// caller's, so an NS-side limit can't tell the attacker from the legitimate portal. TWO layers:
//   1. an in-isolate per-IP token bucket — zero-config, portable, always on (survives a missing binding);
//   2. the optional CF Rate Limiting binding (env.JWT_RATE_LIMITER) — per-colo, managed, cross-isolate.
// Only CACHE-MISSING checks are counted (a cache hit does no upstream call), so legitimate cached
// traffic — even a busy office behind one NAT IP — is never throttled.
const LIVE_CHECK_LIMIT = 30; // cache-missing live checks per IP per window
const LIVE_CHECK_WINDOW_MS = 60_000;
const ipBuckets = new Map<string, { count: number; resetAt: number }>();

function clientIp(request: Request): string {
  const xff = request.headers.get('X-Forwarded-For');
  return request.headers.get('CF-Connecting-IP') || (xff ? xff.split(',')[0]!.trim() : '') || 'unknown';
}

function inIsolateOverLimit(ip: string, nowMs: number): boolean {
  if (ipBuckets.size > 5000) for (const [k, v] of ipBuckets) if (v.resetAt <= nowMs) ipBuckets.delete(k); // bound the map
  const b = ipBuckets.get(ip);
  if (!b || b.resetAt <= nowMs) {
    ipBuckets.set(ip, { count: 1, resetAt: nowMs + LIVE_CHECK_WINDOW_MS });
    return false;
  }
  b.count++;
  return b.count > LIVE_CHECK_LIMIT;
}

/** True ⇒ this IP has exceeded the cache-missing live-check budget; the caller should 429. Layer 1
 *  (in-isolate) always runs; layer 2 (CF binding) runs when configured and never fails the request on
 *  a binding hiccup (layer 1 still stands). */
async function liveCheckRateLimited(request: Request, env: Env): Promise<boolean> {
  const ip = clientIp(request);
  if (inIsolateOverLimit(ip, Date.now())) return true;
  if (env.JWT_RATE_LIMITER) {
    try {
      const { success } = await env.JWT_RATE_LIMITER.limit({ key: `jwt:${ip}` });
      if (!success) return true;
    } catch {
      /* binding unavailable this request — layer 1 already applied */
    }
  }
  return false;
}

/** Normalize a domain for comparison: NS domains are lowercase; guard against case / trailing-dot
 *  variants (e.g. `?domain=0000.12345.Service.` slipping the blocklist). */
const normDomain = (d: string): string => d.trim().toLowerCase().replace(/\.+$/, '');

/** Portal backend mode: delegated-only + policy-gated. Off ⇒ existing dual-mode (dia/local) unchanged. */
function portalMode(env: Env): boolean {
  const v = (env.PORTAL_MODE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * PORTAL_MODE must be unset (⇒ standalone) or a recognized boolean. A typo like `enabled` used to
 * read as "off" via portalMode() — silently disabling the portal policy gate while the delegated
 * reads still served. Return a message (⇒ 500, fail closed) for any unrecognized non-empty value so
 * the misconfiguration is loud, not silent. Names no value (it's operator config, but this is served
 * pre-auth). Pairs with the belt-and-braces fix: policy now applies to any delegated principal, mode
 * flag or not (see resolveAuth / requireFeature).
 */
function portalModeConfigError(env: Env): string | null {
  const raw = (env.PORTAL_MODE ?? '').trim();
  if (raw === '') return null;
  const v = raw.toLowerCase();
  const known = ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'];
  return known.includes(v)
    ? null
    : 'PORTAL_MODE is set to an unrecognized value. Use "1" to enable portal backend mode, or leave it unset for standalone. A typo must not silently disable the policy gate.';
}

/**
 * Host-owned feature policies for the svc portal (fail-closed; empty/unknown ⇒ deny). First pass:
 * David only — as himself (reseller/super-user) or masked into any domain (masking is a reseller
 * capability). Expanding later = add rules / feature keys, not code.
 */
const POLICIES: FeaturePolicies = {
  // Reach the svc portal at all: reseller/super-user (cross-domain) + office managers (own domain,
  // real or masked-as). Matching is by EFFECTIVE scope, so "masking as OM" surfaces as scope OM here.
  'portal.access': [{ scopes: ['Super User', 'Reseller', 'Office Manager'] }],
  // Call Flow Diagram (/flow): reseller-level — ALL resellers, not office managers.
  'callflow.view': [{ scopes: ['Super User', 'Reseller'] }],
  // Ringotel "App Active/Not Active" banner (/ringotel/org): reseller-level only.
  'ringotel.orgStatus': [{ scopes: ['Super User', 'Reseller'] }],
  // Force a fleet-directory cache refresh (?refresh=ringotel): reseller-level only. A refresh bypasses
  // the ~1h directory cache and re-digs the WHOLE fleet against the shared RINGOTEL_API_KEY (~200
  // upstream calls). ringotel.userStatus admits Office Managers, so without this an OM could loop
  // ?refresh and exhaust/ban the fleet key for every customer. Reseller-only, and additionally
  // coalesced fleet-wide in getDirectory so even a reseller can't loop it into an unbounded dig.
  'ringotel.refresh': [{ scopes: ['Super User', 'Reseller'] }],
  // Per-user app-status column (/ringotel/users): resellers + office managers (real or masked).
  'ringotel.userStatus': [{ scopes: ['Super User', 'Reseller', 'Office Manager'] }],
  // App-status column on the reseller domain list (/ringotel/orgs): reseller-level only.
  'ringotel.orgList': [{ scopes: ['Super User', 'Reseller'] }],
  // NOTE: shipped features are ungated to all resellers (by scope). A NEW feature that should start
  // David-only adds its own key with a `users: ['admin@0000.12345.service']` restriction on the rule.
};

/**
 * Route sensitivity — `sensitivity` is compile-required (the `satisfies` forces classification, so a
 * new route can't be added unclassified). Reads are cache-fronted; cross-domain reseller reads are
 * elevated to force-fresh at request time (Task 4), independent of this base class.
 */
const ROUTES = {
  '/domains': { sensitivity: 'read' },
  '/entities': { sensitivity: 'read' },
  '/flow': { sensitivity: 'read' },
  '/ringotel/org': { sensitivity: 'read' },
  '/ringotel/users': { sensitivity: 'read' },
  '/ringotel/orgs': { sensitivity: 'read' },
} satisfies Record<string, { sensitivity: CallSensitivity }>;

/** Parse the domain allowlist (normalized); null ⇒ unrestricted. */
function domainAllowlist(env: Env): Set<string> | null {
  const list = (env.ALLOWED_DOMAINS ?? '').split(',').map(normDomain).filter(Boolean);
  return list.length ? new Set(list) : null;
}

/** Parse the domain blocklist (normalized, subtractive; always applied). */
function domainBlocklist(env: Env): Set<string> {
  return new Set((env.BLOCKED_DOMAINS ?? '').split(',').map(normDomain).filter(Boolean));
}

const ENTITY_KINDS = new Set(['did', 'user', 'queue', 'attendant']);

class CacheApiVerdictCache implements VerdictCache {
  constructor(private cache: Cache) {}
  private keyReq(key: string): Request {
    return new Request(`https://jwt-verdict.internal/${key}`);
  }
  async get(key: string): Promise<JwtVerdict | undefined> {
    const hit = await this.cache.match(this.keyReq(key));
    if (!hit) return undefined;
    try {
      return (await hit.json()) as JwtVerdict;
    } catch {
      return undefined;
    }
  }
  async set(key: string, verdict: JwtVerdict, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.cache.put(
      this.keyReq(key),
      new Response(JSON.stringify(verdict), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${Math.floor(ttlSeconds)}` } }),
    );
  }
}

/**
 * Strict allowlist CORS. Emits `Access-Control-Allow-Origin` ONLY for an exact-match (case-insensitive)
 * origin in `ALLOWED_ORIGINS`. Empty allowlist ⇒ deny all cross-origin — which is correct for the
 * same-origin `dia` SPA (browsers don't CORS-check same-origin, so it still works) and for any host
 * that shouldn't be embedded. The future `svc` portal endpoint sets `ALLOWED_ORIGINS` to exactly
 * `https://manage.example.com` (the Manager Portal that injects the JS caller). ns_t rides an
 * Authorization header (not a cookie), so `Access-Control-Allow-Credentials` is deliberately NEVER set.
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim().toLowerCase()).filter(Boolean);
  // Baseline security headers on EVERY response (spread into all of them). The CSP is the deliberately
  // NON-BREAKING subset: it does NOT restrict script-src (the viewer runs inline modules + a
  // SRI-pinned Mermaid from jsDelivr, so a script-src policy would need 'unsafe-inline' or a nonce
  // refactor for little gain) — it locks down the cheap, high-value directives instead. The viewer is
  // never framed, so `frame-ancestors 'none'` (+ X-Frame-Options for old browsers) forbids embedding;
  // object-src/base-uri/form-action 'none' kill plugin, <base>-hijack, and form-exfil vectors.
  const h: Record<string, string> = {
    Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
  };
  if (origin && allowed.includes(origin.toLowerCase())) {
    h['Access-Control-Allow-Origin'] = origin; // echo the exact allowed origin (never '*')
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, Accept';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const json = (body: unknown, status: number, extra: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });

interface Auth {
  /** Token used for NS reads. */
  token: string;
  /** If set, the ONLY domain this caller may see (delegated non-reseller / service takes ?domain). */
  lockedDomain?: string;
  /** Portal reseller fallback: any domain allowed; this one when ?domain is absent. */
  defaultDomain?: string;
  /** Portal-backend-mode principal (set only in portal backend mode). */
  principal?: Principal;
}

/** HttpError carries a status so the handler can map it to a response. */
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public reason?: string,
  ) {
    super(message);
  }
}

/**
 * The Manager Portal host that issues our ns_t, e.g. "manage.example.com".
 *
 * REQUIRED — `verify()` has no issuer default by design: a default would be one specific portal, and
 * would silently accept tokens minted by it for every other deployment. Unset ⇒ fail closed with an
 * actionable message rather than a bare 401, because "every login broke" should say why.
 */
function portalIss(env: Env): string | string[] {
  const raw = (env.NS_PORTAL_ISS ?? '').trim();
  // Comma-separate several portal hostnames when one backend fronts more than one — SETUP.md and
  // wrangler.jsonc both document this, and verify()'s expectedIss already accepts a list (exact match,
  // no wildcards). Return a bare string for the common single-host case so nothing downstream shifts.
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new HttpError(500, 'Server misconfigured', 'NS_PORTAL_ISS is required: set it to your Manager Portal host (e.g. manage.example.com), or a comma-separated list of them');
  return list.length === 1 ? list[0] : list;
}

/**
 * Feature gate for the Ringotel routes. Portal backend mode MUST have a principal (verify -> toPrincipal ran),
 * so an absent one means something is wrong: fail closed rather than sail past the check. Standalone mode
 * has no principal BY DESIGN -- there is no delegated identity, only a stored token -- so policy is not
 * the control there. assertDomainReadable is: it bounds these routes to domains the caller's token can
 * actually read in NetSapiens, in BOTH modes.
 */
function requireFeature(auth: Auth, feature: string, env: Env): void {
  // Policy applies whenever a delegated identity is present — NOT only when PORTAL_MODE parses. A
  // principal is built for every valid Bearer ns_t now (resolveAuth), so a delegated caller can't
  // dodge feature gating by the deployment forgetting/mistyping the mode flag. Standalone SERVICE mode
  // has no principal by design (there is no delegated identity, only a stored token); there,
  // assertDomainReadable is the control, not policy.
  if (!auth.principal) return;
  if (!can(auth.principal, feature, POLICIES)) throw new HttpError(403, `Not authorized: ${feature}`);
}

/**
 * Resolve auth. A valid Bearer ns_t ALWAYS yields a policy-gated principal, regardless of PORTAL_MODE
 * — so there is no "delegated but unpoliced" path (the W2 fix: a blank/typo'd PORTAL_MODE used to
 * serve delegated reads with every gate bypassed). Portal mode's only remaining difference is that it
 * has NO service-token fallback. Standalone service mode (a stored token, no bearer) is unchanged.
 */
async function resolveAuth(request: Request, env: Env): Promise<Auth> {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

  if (bearer) {
    const vcache = new CacheApiVerdictCache(caches.default);
    // Rate-limit ONLY the expensive path. Peek the verdict cache with the SAME key verify() uses
    // (tokenKey(token, assertBareServer(server)) — must mirror the lib); a hit is served without an
    // upstream call, so it doesn't count. A miss would drive a live /jwt roundtrip → apply the per-IP
    // budget and 429 over it, so a flood of distinct forged tokens can't amplify against the NS core.
    let cachedHit = false;
    try {
      cachedHit = !!(await vcache.get(await tokenKey(bearer, assertBareServer(env.NS_SERVER))));
    } catch {
      /* bad server / cache miss: treat as a miss and let verify() produce the real verdict */
    }
    if (!cachedHit && (await liveCheckRateLimited(request, env))) {
      throw new HttpError(429, 'Too many authentication attempts; please slow down');
    }
    const verdict = await verify(bearer, { server: env.NS_SERVER, mode: 'live', expectedIss: portalIss(env), cache: vcache });
    if (!verdict.ok) {
      const status = verdict.live === 'invalid' ? (verdict.statusCode ?? 401) : verdict.live === 'error' ? 502 : 401;
      throw new HttpError(status, 'JWT validation failed', verdict.reason);
    }
    if (!verdict.domain) throw new HttpError(403, 'Token has no domain claim; cannot scope reads');
    const principal = toPrincipal(verdict);
    if (!can(principal, 'portal.access', POLICIES)) throw new HttpError(403, 'Not authorized for the svc portal');
    const reseller = isResellerScope(principal.scope);
    return reseller
      ? { token: bearer, principal, defaultDomain: verdict.domain }   // any domain; own by default
      : { token: bearer, principal, lockedDomain: verdict.domain };   // as-user, domain-locked
  }

  // No bearer. Portal backend mode is delegated-only: never fall back to the stored token.
  if (portalMode(env)) throw new HttpError(401, 'The svc portal requires Authorization: Bearer <ns_t>');

  if (env.NS_API_TOKEN) {
    // The one place the Worker lends out a credential the caller never proved they should have. Refuse
    // unless something verifiable is in front of it (Access), it isn't reachable (local dev), or the
    // operator explicitly accepted the risk. See src/exposure.ts.
    if (serviceTokenBlocked(env, new URL(request.url).hostname)) throw new HttpError(403, 'Service token is not protected', BLOCKED_REASON);
    return { token: env.NS_API_TOKEN };
  }
  throw new HttpError(401, 'Unauthenticated: provide Authorization: Bearer <ns_t>, or configure NS_API_TOKEN (standalone mode)');
}

/**
 * Is a forced Ringotel/device cache refresh permitted for THIS caller? `?refresh=ringotel` bypasses
 * the ~1h fleet-directory cache and re-digs against the shared RINGOTEL_API_KEY, so it's an operator
 * capability, not a caller one. Standalone mode (dia) is the operator's own Access-gated tool → allowed.
 * With a delegated principal → reseller/super-user only (ringotel.refresh); a looping Office Manager is
 * refused and simply reads the cache. getDirectory additionally coalesces refreshes fleet-wide.
 */
function refreshRequested(url: URL, auth: Auth, env: Env): boolean {
  if (url.searchParams.get('refresh') !== 'ringotel') return false;
  if (!auth.principal) return true;                 // standalone service tool (behind Access): operator-controlled
  return can(auth.principal, 'ringotel.refresh', POLICIES);
}

/** Which domain this request may read: delegated is locked to its own; service takes ?domain.
 *  The ALLOWED_DOMAINS gate applies to BOTH modes — a domain outside it is refused (403). */
function requireDomain(auth: Auth, url: URL, env: Env): string {
  const param = normDomain(url.searchParams.get('domain') ?? '');
  let domain: string;
  if (auth.lockedDomain) {
    const locked = normDomain(auth.lockedDomain);
    if (param && param !== locked) throw new HttpError(403, 'This token may only read its own domain');
    domain = locked;
  } else if (auth.defaultDomain) {
    domain = param || normDomain(auth.defaultDomain); // reseller: any domain; own when ?domain absent
  } else {
    if (!param) throw new HttpError(400, 'Provide ?domain=<domain>');
    domain = param;
  }
  if (domainBlocklist(env).has(domain)) throw new HttpError(403, `Domain "${domain}" is blocked`);
  const allow = domainAllowlist(env);
  if (allow && !allow.has(domain)) throw new HttpError(403, `Domain "${domain}" is not in ALLOWED_DOMAINS`);
  return domain;
}

/**
 * Cross-domain reseller reads are SENSITIVE: re-validate the token live (force-fresh, bypassing the
 * verdict cache) so a server-side logout/revocation is caught immediately instead of after the TTL.
 * No-op outside portal backend mode, for non-reseller principals, or for own-domain reads (those stay
 * cache-fronted). Throws (401/502) if the fresh check fails.
 */
async function maybeElevate(auth: Auth, domain: string, env: Env): Promise<void> {
  if (!auth.principal || !auth.defaultDomain) return;         // only reseller principals (any mode) read cross-domain
  if (domain === normDomain(auth.principal.domain)) return;   // own-domain read: cache is fine
  const fresh = await verify(auth.token, { server: env.NS_SERVER, mode: 'live', expectedIss: portalIss(env), forceFresh: true, cache: new CacheApiVerdictCache(caches.default) });
  if (!fresh.ok) {
    const status = fresh.live === 'invalid' ? (fresh.statusCode ?? 401) : 502;
    throw new HttpError(status, 'Cross-domain read requires a fresh token; re-validation failed', fresh.reason);
  }
}

/**
 * Authorization probe for the Ringotel routes. Those resolve data from the fleet-wide RINGOTEL_API_KEY
 * keyed only by domain string — so, unlike /flow and /entities (which read through the caller's NsClient
 * and inherit the NS 401/403 scope boundary for free), they'd otherwise serve ANY domain to any
 * reseller. Before serving, confirm the caller's own ns_t can read `domain` via a cheap GET /domains/{d}:
 * an NS 401/403 means this token isn't scoped to that domain ⇒ 403. Only needed for reseller
 * cross-domain reads — own-domain reads are trivially in-scope, standalone mode is the internal tool, and
 * Office-Manager principals are domain-locked upstream (requireDomain). See SECURITY-REVIEW.md §1.
 */
async function assertDomainReadable(client: NsClient, domain: string): Promise<void> {
  try {
    await client.get(`/domains/${encodeURIComponent(domain)}`);
  } catch (err) {
    if (err instanceof NsApiError && (err.status === 401 || err.status === 403))
      throw new HttpError(403, 'This token may not read that domain');
    throw err; // 5xx/other → surfaces as a generic 502, never a false allow
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);

    // Public, no-auth route (probes / uptime). Stays open even behind Access.
    // Public, unauthenticated, and deliberately so: an operator (or an uptime probe) must be able to
    // ask 'is this alive, is it set up, and what is it running?' without credentials. `version` is what
    // lets a deployment be compared against the CHANGELOG to see if an upgrade is worth pulling. None
    // of it is sensitive -- the code is public, and `configured` is a boolean, never a value.
    if (url.pathname === '/health') return json({ ok: true, configured: !needsSetup(env), version: VERSION }, 200, cors);

    // Fail closed on a mistyped PORTAL_MODE (e.g. "enabled") — after /health so probes still work, and
    // before every other route so a typo can't serve a single delegated read with the gate disabled.
    const pmErr = portalModeConfigError(env);
    if (pmErr) return json({ error: 'Server misconfigured', reason: pmErr }, 500, cors);

    // Cloudflare Access gate (defense in depth for standalone-mode deployments). Inert unless BOTH
    // ACCESS_AUD and ACCESS_TEAM_DOMAIN are set (accessConfig() !== null — AUD alone cannot build the
    // JWKS URL, so the check can't run), so local `pnpm dev` and the portal deployment are unaffected.
    // The exposure gate keys off the SAME predicate on purpose: believing AUD alone meant "protected"
    // was the 356e6d8 fail-open. When active,
    // EVERYTHING below (SPA + data) requires a valid Access token — a direct hit that bypassed Access
    // (e.g. *.workers.dev) is refused, so the service NS token never answers an unauthenticated caller.
    const accessCfg = accessConfig(env);
    if (accessCfg) {
      const verdict = await verifyAccessRequest(request, accessCfg, caches.default);
      if (!verdict.ok) return json({ error: 'Cloudflare Access required', reason: verdict.reason }, verdict.status, cors);
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/app')) {
      // The internal domain-browser SPA is a SERVICE-mode tool (dia). The delegated `portal` env is an
      // injection backend, not an SPA host — and the SPA there is non-functional anyway (its fetches carry
      // no ns_t) — so don't serve it: withhold the internal tooling surface. dia keeps serving it.
      // Portal backend mode has no UI: it's the backend half of an injected add-on, and the internal SPA is
      // deliberately withheld here (it's a tooling surface, and its fetches carry no ns_t anyway).
      // Still 404 — but say why, because someone who just deployed this and opened the URL deserves
      // better than a bare error. Discloses nothing: no config, no names, no data.
      // Deliberately NOT productName(env): BRAND_NAME is a secret, and this page is unauthenticated.
      if (portalMode(env)) {
        return new Response(portalModeHtml(), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', ...cors } });
      }
      // A fresh fork (C3 / the deploy button) cannot be prompted for config, so it arrives here with
      // placeholders and would otherwise serve an SPA that dies on its first fetch. Say what's missing
      // instead. Discloses nothing: presence-only, never values, and it vanishes once configured.
      if (needsSetup(env)) {
        return new Response(setupHtml(env, productName(env)), { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', ...cors } });
      }
      // Configured, but the stored token has nothing verifiable in front of it. Don't serve the app —
      // teach them how to put Access there. Replaced by the real app the moment ACCESS_AUD is set.
      if (serviceTokenBlocked(env, url.hostname)) {
        return new Response(exposureHtml(env, url.hostname, productName(env)), { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', ...cors } });
      }
      return new Response(viewerHtml(env), { headers: { 'content-type': 'text/html; charset=utf-8', ...cors } });
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);

    try {
      const auth = await resolveAuth(request, env);
      const client = new NsClient({ server: env.NS_SERVER, token: auth.token });

      if (url.pathname === '/domains') {
        const allow = domainAllowlist(env);
        const block = domainBlocklist(env);
        let doms = auth.lockedDomain ? [{ domain: auth.lockedDomain }] : await listDomains(client);
        if (allow) doms = doms.filter((d) => allow.has(normDomain(d.domain)));
        if (block.size) doms = doms.filter((d) => !block.has(normDomain(d.domain)));
        return json(doms, 200, cors);
      }

      if (url.pathname === '/entities') {
        const domain = requireDomain(auth, url, env);
        await maybeElevate(auth, domain, env);
        const shallow = await fetchDomainSnapshot(client, domain, { shallow: true, includeDidDestRules: true });
        return json(listEntities(shallow), 200, cors);
      }

      if (url.pathname === '/flow') {
        const domain = requireDomain(auth, url, env);
        await maybeElevate(auth, domain, env);
        if (auth.principal && !can(auth.principal, 'callflow.view', POLICIES)) throw new HttpError(403, 'Not authorized: callflow.view');
        const kind = (url.searchParams.get('kind') ?? '').toLowerCase();
        const ref = url.searchParams.get('ref') ?? '';
        if (!ENTITY_KINDS.has(kind) || !ref) return json({ error: 'Provide ?kind=did|user|queue|attendant&ref=<id>' }, 400, cors);

        const snapshot = await fetchDomainSnapshot(client, domain, { includeDialrules: true });
        const graph = resolveFlow(snapshot, { kind, ref } as EntityRef);

        // Optional Ringotel enrichment — fully gated. When RINGOTEL_API_KEY is unset this is a no-op
        // and the graph is byte-identical to the NS-only baseline. Best-effort & isolated: it never
        // changes this handler's status (enrichFlowGraph swallows its own errors).
        if (url.searchParams.get('enrich') !== '0') {
          const refresh = refreshRequested(url, auth, env);
          if (nsDeviceDetailsEnabled(env)) await enrichDeviceDetails(graph, client, caches.default, domain, { refresh });
          if (ringotelEnabled(env)) await enrichFlowGraph(graph, domain, env, caches.default, { refresh });
        }

        const format = url.searchParams.get('format') ?? 'json';
        if (format === 'html') return new Response(renderGalleryHtml(domain, [graph], { subtitle: graph.entity.label, theme: 'light', accent: brandAccent(env) }), { headers: { 'content-type': 'text/html; charset=utf-8', ...cors } });
        if (format === 'mermaid') return new Response(toMermaid(graph), { headers: { 'content-type': 'text/plain; charset=utf-8', ...cors } });
        // JSON carries the rendered mermaid so the SPA can render + export client-side.
        return json({ ...graph, __mermaid: toMermaid(graph) }, 200, cors);
      }

      if (url.pathname === '/ringotel/org') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        const domain = requireDomain(auth, url, env);
        await maybeElevate(auth, domain, env);
        requireFeature(auth, 'ringotel.orgStatus', env);
        // Bound Ringotel data by NetSapiens scope in EVERY mode. These routes resolve from the
        // fleet-wide RINGOTEL_API_KEY keyed only by a domain string, so without this a caller could name
        // any domain in the Ringotel fleet -- including one their NS token cannot read. Skipped only for
        // a principal's own domain, which they can read by definition.
        if (!auth.principal || domain !== normDomain(auth.principal.domain)) await assertDomainReadable(client, domain);
        const refresh = refreshRequested(url, auth, env);
        return json(await orgStatusForDomain(domain, env, caches.default, { refresh }), 200, cors);
      }

      if (url.pathname === '/ringotel/users') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        const domain = requireDomain(auth, url, env);
        await maybeElevate(auth, domain, env);
        requireFeature(auth, 'ringotel.userStatus', env);
        // Bound Ringotel data by NetSapiens scope in EVERY mode. These routes resolve from the
        // fleet-wide RINGOTEL_API_KEY keyed only by a domain string, so without this a caller could name
        // any domain in the Ringotel fleet -- including one their NS token cannot read. Skipped only for
        // a principal's own domain, which they can read by definition.
        if (!auth.principal || domain !== normDomain(auth.principal.domain)) await assertDomainReadable(client, domain);
        const refresh = refreshRequested(url, auth, env);
        return json(await usersStatusForDomain(domain, env, caches.default, { refresh }), 200, cors);
      }

      if (url.pathname === '/ringotel/orgs') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        requireFeature(auth, 'ringotel.orgList', env);
        // Scope = the caller's own NS-visible domains (never a client-supplied list). Same block/allow
        // filters as /domains, then resolve enablement in-memory against the cached fleet directory.
        const allow = domainAllowlist(env);
        const block = domainBlocklist(env);
        let doms = (auth.lockedDomain ? [{ domain: auth.lockedDomain }] : await listDomains(client)).map((d) => normDomain(d.domain));
        if (allow) doms = doms.filter((d) => allow.has(d));
        if (block.size) doms = doms.filter((d) => !block.has(d));
        const refresh = refreshRequested(url, auth, env);
        return json(await orgsStatusForDomains(doms, env, caches.default, { refresh }), 200, cors);
      }

      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...(err.reason ? { reason: err.reason } : {}) }, err.status, cors);
      const status = err instanceof NsApiError ? (err.status === 401 || err.status === 403 ? err.status : 502) : 500;
      // Log the full error (incl. upstream NS path + response body) server-side only. The client gets a
      // generic message — NsApiError.message embeds internal API routes and up to 500 chars of the NS
      // response body, which must not be echoed to the caller.
      console.error(JSON.stringify({ msg: 'request failed', path: url.pathname, error: (err as Error).message }));
      return json({ error: 'Request failed' }, status, cors);
    }
  },
} satisfies ExportedHandler<Env>;
