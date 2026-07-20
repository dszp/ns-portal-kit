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
  NsWriteClient,
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
  needsFreshAuth,
  type Principal,
  type FeaturePolicies,
  type CallSensitivity,
  type JwtVerdict,
  type VerdictCache,
  type EntityRef,
} from '@dszp/netsapiens-lib';
import { worstSeverity, type HealthFlag } from '@dszp/ringotel-lib';
import { viewerHtml } from './viewerApp.js';
import { brandAccent, productName, VERSION } from './brand.js';
import { needsSetup, setupHtml } from './setup.js';
import { portalModeHtml } from './portalInfo.js';
import { serviceTokenBlocked, exposureHtml, BLOCKED_REASON } from './exposure.js';
import { enrichFlowGraph, ringotelEnabled, orgStatusForDomain, usersStatusForDomain, usersStatusForDomainFresh, orgsStatusForDomains, makeWriteClient, invalidateOrgUsers, resolveForWrite, buildExtIndex } from './ringotel.js';
import { resolveRingotelConfig, ringotelConfigError, evaluateEligibility, type EligUser } from './eligibility.js';
import { activate, deactivate, resetPassword, isDomainWritable, RingotelWriteError } from './ringotelActivation.js';
import { enrichDeviceDetails, nsDeviceDetailsEnabled } from './nsDevices.js';
import { accessConfig, verifyAccessRequest } from './access.js';
import { resolveFeaturePolicies, featuresConfigError, parseSuperadmins } from './features.js';
import {
  primaryBasename,
  primaryJs,
  parseManifest,
  buildKitBundle,
  buildSelfBundle,
  featurePolicyKeys,
  selfFeaturePolicyKeys,
  tierHash,
  kitGateAllows,
  secondaryNeedsAuth,
  isR2Entry,
  r2Key,
  KitConfigError,
} from './kit.js';

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

  // ── Ringotel activation (writes) — eligibility + the write safety rail (see src/eligibility.ts) ──
  /** NS device-name suffix for the softphone, e.g. "r" → device "100r". Default "r". */
  RINGOTEL_ACTIVATION_SUFFIX?: string;
  /** CSV of name-contains matchers to soft-exclude (default `SHARED,SHARED VOICEMAIL,FAX`). */
  RINGOTEL_EXCLUDE_NAMES?: string;
  /** CSV of extension patterns to soft-exclude (default empty; trailing `*` = prefix wildcard). */
  RINGOTEL_EXCLUDE_EXTS?: string;
  /** JSON `{ "<domain>": { add?: [...], remove?: [...] } }` per-domain override of the exclude-exts. */
  RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN?: string;
  /** Truthy ⇒ the no-device heuristic tightens the name matcher (default off). */
  RINGOTEL_EXCLUDE_NO_DEVICES?: string;
  /** CSV of soft categories a reseller may override: `names|exts|no_devices|all`. */
  RINGOTEL_RESELLER_OVERRIDE?: string;
  /** WRITE SAFETY RAIL — allowlist of domains where writes may mutate. Empty ⇒ all writes refused
   *  (fail-closed); `*` ⇒ all scope-permitted; a CSV list ⇒ only those. NS + Ringotel are LIVE. */
  RINGOTEL_WRITE_DOMAINS?: string;

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

  // ── Worker-served Manager-Portal injection (portal-mode-only; see src/kit.ts) ──────────────────────
  /** Public primary basename, served at `/<basename>.js` (default `p`). Validated `^[a-z0-9_-]+$`. */
  PRIMARY_BASENAME?: string;
  /** Vendor bundle-router URL the primary chain-loads first (async). No default; present-empty ⇒ none;
   *  absent ⇒ loud-but-non-fatal (a `/health` `configured:false` signal, see setup.ts). Must be https. */
  PORTAL_HANDOFF_URL?: string;
  /** JSON array of secondary-injection manifest entries (`{name,from:'r2:<key>'|'url:<https>',auth}`). */
  PORTAL_SECONDARIES?: string;
  /** JSON `{ "<feature.key>": <gate> }` overriding the built-in gating defaults (see src/features.ts). */
  PORTAL_FEATURES?: string;
  /** Comma-separated `user@domain` accounts that see everything (except CC-only) + gate `superadmin`. */
  PORTAL_SUPERADMINS?: string;
  /** Optional app-dashboard link base for gated features (empty ⇒ plain label). Gated bundle only. */
  RINGOTEL_APP_BASE_URL?: string;
  /** OPTIONAL private R2 binding serving `r2:` manifest secondaries. Structural so selftests can mock it;
   *  absent ⇒ any `r2:` entry is a loud config error (never served). */
  ASSETS?: { get(key: string): Promise<{ text(): Promise<string> } | null> };

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
 * Feature policies are no longer hardcoded here — they're assembled per-request by
 * `resolveFeaturePolicies(env)` (src/features.ts) from the FEATURE_REGISTRY defaults ⊕ any
 * PORTAL_FEATURES / PORTAL_SUPERADMINS overrides. The registry defaults reproduce the prior per-scope
 * matrix exactly, so behavior is unchanged until an operator sets those vars.
 */

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
  '/ringotel/user': { sensitivity: 'read' },
  '/ringotel/activate': { sensitivity: 'write' },
  '/ringotel/resetPassword': { sensitivity: 'write' },
  '/kit/portal.js': { sensitivity: 'read' },
  '/kit/self.js': { sensitivity: 'read' },
  '/me/status': { sensitivity: 'read' },
  '/me/devices': { sensitivity: 'read' },
  '/me/resetPassword': { sensitivity: 'write' },
} satisfies Record<string, { sensitivity: CallSensitivity }>;

/** POST paths — the write routes. Everything else is GET-only (405 otherwise). */
const WRITE_PATHS = new Set(['/ringotel/activate', '/ringotel/resetPassword', '/me/resetPassword']);

/**
 * Loud, fail-closed validation of the static injection config (portal-mode-only). A malformed
 * PRIMARY_BASENAME / PORTAL_SECONDARIES / PORTAL_HANDOFF_URL is a deploy-time mistake: surface it as a
 * 500 with an actionable reason on every request (after /health), rather than throwing deep in a route.
 * Returns null when off (non-portal) or valid.
 */
function kitConfigError(env: Env): string | null {
  if (!portalMode(env)) return null;
  try {
    primaryBasename(env);
    parseManifest(env);
  } catch (e) {
    if (e instanceof KitConfigError) return e.message;
    throw e;
  }
  const h = env.PORTAL_HANDOFF_URL;
  if (h !== undefined && h.trim() !== '' && !/^https:\/\/\S+$/i.test(h.trim()))
    return 'PORTAL_HANDOFF_URL must be an https URL (or unset for a loud no-handoff signal, or "" for an intentional none)';
  // RINGOTEL_APP_BASE_URL becomes an <a href> in the gated bundle — require https (buildKitBundle also
  // drops a non-https value defensively, but fail loud so the operator fixes it rather than silently
  // losing the app-dashboard links).
  const ab = env.RINGOTEL_APP_BASE_URL;
  if (ab !== undefined && ab.trim() !== '' && !/^https:\/\/\S+$/i.test(ab.trim()))
    return 'RINGOTEL_APP_BASE_URL must be an https URL (it becomes an app-dashboard link href), or unset';
  // An r2: secondary with no ASSETS binding is a broken deploy — surface it uniformly here (loud, every
  // route) rather than as a per-name 500 on the asset route (which would disclose config to an
  // unauthenticated caller before the gate). parseManifest already validated above, so it won't throw.
  if (!env.ASSETS && parseManifest(env).some(isR2Entry))
    return 'A PORTAL_SECONDARIES entry uses r2: but no ASSETS R2 binding is bound';
  return null;
}

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
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'; // POST for the write routes (activate/reset)
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
  /** True when this caller passed portal.self but NOT portal.access — fenced to the self surface. */
  self?: boolean;
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
function requireFeature(auth: Auth, feature: string, env: Env, policies: FeaturePolicies): void {
  // Policy applies whenever a delegated identity is present — NOT only when PORTAL_MODE parses. A
  // principal is built for every valid Bearer ns_t now (resolveAuth), so a delegated caller can't
  // dodge feature gating by the deployment forgetting/mistyping the mode flag. Standalone SERVICE mode
  // has no principal by design (there is no delegated identity, only a stored token); there,
  // assertDomainReadable is the control, not policy.
  if (!auth.principal) return;
  if (!can(auth.principal, feature, policies)) throw new HttpError(403, `Not authorized: ${feature}`);
}

/**
 * Verify a Bearer ns_t → Principal, WITHOUT the portal.access gate or domain scoping. The shared auth
 * core for resolveAuth (data routes) AND the per-entry gated /kit routes (a manifest secondary at level
 * `auth` admits ANY valid ns_t, so portal.access can't be baked in here). Applies the same live-check
 * rate-limit + verdict cache. Returns null when there is NO Bearer token; throws (401/429/502) on a bad
 * token or a flood. The CALLER decides authorization (portal.access, a manifest level, a feature key).
 */
async function resolvePrincipal(request: Request, env: Env): Promise<{ token: string; principal: Principal; verdict: JwtVerdict } | null> {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return null;
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
  return { token: bearer, principal: toPrincipal(verdict), verdict };
}

/**
 * Resolve auth. A valid Bearer ns_t ALWAYS yields a policy-gated principal, regardless of PORTAL_MODE
 * — so there is no "delegated but unpoliced" path (the W2 fix: a blank/typo'd PORTAL_MODE used to
 * serve delegated reads with every gate bypassed). Portal mode's only remaining difference is that it
 * has NO service-token fallback. Standalone service mode (a stored token, no bearer) is unchanged.
 */
async function resolveAuth(request: Request, env: Env, policies: FeaturePolicies): Promise<Auth> {
  const authed = await resolvePrincipal(request, env);
  if (authed) {
    const { token, principal, verdict } = authed;
    if (!verdict.domain) throw new HttpError(403, 'Token has no domain claim; cannot scope reads');
    if (can(principal, 'portal.access', policies)) {
      const reseller = isResellerScope(principal.scope);
      return reseller
        ? { token, principal, defaultDomain: verdict.domain }   // any domain; own by default
        : { token, principal, lockedDomain: verdict.domain };   // as-user, domain-locked
    }
    // Not an admin: admit as a SELF principal iff portal.self allows — fenced (below) to /me/* + /kit/self.js.
    if (can(principal, 'portal.self', policies)) {
      return { token, principal, lockedDomain: verdict.domain, self: true };
    }
    throw new HttpError(403, 'Not authorized for the svc portal');
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
function refreshRequested(url: URL, auth: Auth, env: Env, policies: FeaturePolicies): boolean {
  if (url.searchParams.get('refresh') !== 'ringotel') return false;
  if (!auth.principal) return true;                 // standalone service tool (behind Access): operator-controlled
  return can(auth.principal, 'ringotel.refresh', policies);
}

/** Which domain this request may act on, from a raw domain value (query for reads, JSON body for writes):
 *  delegated is locked to its own; service/reseller takes the supplied domain. The ALLOWED_DOMAINS gate
 *  applies to BOTH modes — a domain outside it is refused (403). */
function requireDomainValue(auth: Auth, raw: string, env: Env): string {
  const param = normDomain(raw ?? '');
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

/** Read-route convenience: the domain comes from `?domain=`. */
function requireDomain(auth: Auth, url: URL, env: Env): string {
  return requireDomainValue(auth, url.searchParams.get('domain') ?? '', env);
}

/**
 * Feature gate for WRITE routes. Unlike the read `requireFeature`, a missing principal fails CLOSED: a
 * write must never proceed without a delegated identity (there is no "service-token write" path). Then
 * the usual policy check.
 */
function requireWriteFeature(auth: Auth, feature: string, policies: FeaturePolicies): void {
  if (!auth.principal) throw new HttpError(403, `Not authorized: ${feature} (writes require a delegated ns_t)`);
  if (!can(auth.principal, feature, policies)) throw new HttpError(403, `Not authorized: ${feature}`);
}

/**
 * The write safety rail (deploy-level; NS + Ringotel are LIVE). A write may only mutate a domain on the
 * RINGOTEL_WRITE_DOMAINS allowlist — empty ⇒ ALL writes refused (fail-closed), '*' ⇒ all scope-permitted.
 * Orthogonal to the feature gate (WHO) — this bounds WHERE.
 */
function assertDomainWritable(domain: string, writeDomains: string[] | '*'): void {
  if (!isDomainWritable(domain, writeDomains))
    throw new HttpError(403, `Writes are not enabled for domain "${domain}"`, 'RINGOTEL_WRITE_DOMAINS does not permit this domain (empty ⇒ all writes refused)');
}

/**
 * Force a fresh live ns_t re-validation before a write (closes the revocation gap — a server-side logout
 * must not leave a cached "valid" verdict good enough to mutate). Driven by needsFreshAuth('write').
 */
async function requireFreshAuth(auth: Auth, env: Env): Promise<void> {
  if (!auth.principal) return; // writes already required a principal (requireWriteFeature)
  const fresh = await verify(auth.token, { server: env.NS_SERVER, mode: 'live', expectedIss: portalIss(env), forceFresh: true, cache: new CacheApiVerdictCache(caches.default) });
  if (!fresh.ok) {
    const status = fresh.live === 'invalid' ? (fresh.statusCode ?? 401) : 502;
    throw new HttpError(status, 'Write requires a fresh token; re-validation failed', fresh.reason);
  }
}

const encPath = (s: string): string => encodeURIComponent(s);
const str = (v: unknown): string => (v == null ? '' : String(v)).trim();

/**
 * Adapt a raw NS user record into the eligibility engine's normalized shape. Field names are read
 * defensively across v1/v2 spellings — the exact set is confirmed against the live API in the deploy
 * verify step. `srv_code` non-blank marks a system/service user (HARD-excluded).
 */
/** First non-blank email across the likely v2 field spellings (a user may carry several). */
function firstEmail(u: Record<string, unknown>): string {
  for (const k of ['email', 'email-address', 'email_address', 'emailaddress']) {
    const v = u[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v)) for (const e of v) if (typeof e === 'string' && e.trim()) return e.trim();
  }
  return '';
}

function nsUserToElig(u: Record<string, unknown>, ext: string, deviceCount: number): EligUser {
  const first = str(u['first-name'] ?? u['first_name'] ?? u['name-first-name']);
  const last = str(u['last-name'] ?? u['last_name'] ?? u['name-last-name']);
  const display = str(u['display-name'] ?? u['name'] ?? u['subscriber_name']);
  const srvCode = str(u['srv_code'] ?? u['srv-code'] ?? u['service-code']);
  return { ext, srvCode, email: firstEmail(u), names: [first, last, display].filter(Boolean), deviceCount };
}

/**
 * The single display name to push into Ringotel for an NS user: `First Last` when either part exists,
 * else an explicit display-name field. Deliberately does NOT fall back to `subscriber_name`/`name` — in
 * NS those carry the extension number (n8n uses `subscriber_name` as the `<ext>r` device base), which
 * would poison the Ringotel name. Distinct from `nsUserToElig().names`, which unions all parts for the
 * eligibility contains-matchers; here we want ONE clean name, not a concatenation. Caller falls back to
 * the extension when this is blank.
 */
function nsDisplayName(u: Record<string, unknown>): string {
  const first = str(u['first-name'] ?? u['first_name'] ?? u['name-first-name']);
  const last = str(u['last-name'] ?? u['last_name'] ?? u['name-last-name']);
  const full = [first, last].filter(Boolean).join(' ').trim();
  return full || str(u['display-name'] ?? u['name-full-name']);
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

/** Shared status projection: does `domain` have a bound Ringotel org (`present`), and is `ext` activated
 * within it (`active`)? Reads the cached org-users blob (~10-min TTL) — the SAME source the admin
 * `/ringotel/user` route uses, so self + admin reads share one Ringotel AdminAPI call. */
async function computeUserStatus(domain: string, ext: string, env: Env, cache: Cache): Promise<{ present: boolean; active: boolean; status: unknown }> {
  const all = await usersStatusForDomain(domain, env, cache, { refresh: false });
  const present = !!all.active;
  const status = present && ext && all.users ? (all.users[ext] ?? null) : null;
  const active = present && !!(status && (status as { activated?: boolean }).activated);
  return { present, active, status };
}

/** Resolve the CALLER's own NS user via the `~` self-wildcard — NS resolves it from the bearer token, so
 * it is authoritative and cannot be aimed at another user. Returns the base extension + domain (+ the raw
 * record for email). Falls back to the signed principal if the read fails. `~` is a literal wildcard —
 * never encPath it. */
async function resolveSelfNsUser(client: NsClient, principal: Principal): Promise<{ ext: string; domain: string; record: Record<string, unknown> | null }> {
  const rec = (await client.get('/domains/~/users/~').catch(() => null)) as Record<string, unknown> | null;
  const ext = rec && typeof rec.user === 'string' && rec.user.trim() ? rec.user.trim() : principal.user;
  const domain = normDomain(rec && typeof rec.domain === 'string' && rec.domain.trim() ? rec.domain.trim() : principal.domain);
  return { ext, domain, record: rec };
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

    // Fail closed + loud on a malformed injection config (portal-mode-only) — after /health so probes
    // still work. A bad basename/manifest/handoff is a deploy mistake; 500 with a reason beats a deep throw.
    const kitErr = kitConfigError(env);
    if (kitErr) return json({ error: 'Server misconfigured', reason: kitErr }, 500, cors);

    // Fail closed + loud on a malformed PORTAL_FEATURES / PORTAL_SUPERADMINS — after /health, and in
    // EVERY mode (the resolved policies below are used for delegated auth regardless of PORTAL_MODE).
    const featErr = featuresConfigError(env);
    if (featErr) return json({ error: 'Server misconfigured', reason: featErr }, 500, cors);

    // Fail closed + loud on bad RINGOTEL_* activation config (exclusion matchers, the write-domain rail).
    const rtErr = ringotelConfigError(env);
    if (rtErr) return json({ error: 'Server misconfigured', reason: rtErr }, 500, cors);

    // The effective feature policies for THIS request: registry defaults ⊕ PORTAL_FEATURES overrides,
    // each gate resolved through the level vocabulary + the superadmin union. Computed once per fetch
    // (cheap, pure) and threaded to every gate below — never memoized in module scope (avoids stale
    // config across deploys). Safe here: featuresConfigError above already proved it won't throw.
    const policies = resolveFeaturePolicies(env);

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
    if (request.method !== 'GET' && !(request.method === 'POST' && WRITE_PATHS.has(url.pathname)))
      return json({ error: 'Method not allowed' }, 405, cors);

    try {
      // ── Worker-served injection (portal-mode-only; dia/local never expose these) ──────────────────
      // Public neutral PRIMARY at /<basename>.js — no auth, cache-in-front OK. Carries nothing sensitive.
      if (portalMode(env) && url.pathname === `/${primaryBasename(env)}.js`) {
        return new Response(primaryJs(env), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...cors } });
      }

      // Manifest SECONDARY at /kit/asset/<name>.js — served from the private ASSETS binding, gated
      // per-entry (public / auth / admin / superadmin / any key). Pre-resolveAuth: `public` needs no token,
      // and `auth` admits any valid ns_t (not just portal.access), so it can't use resolveAuth.
      if (portalMode(env) && url.pathname.startsWith('/kit/asset/')) {
        const name = url.pathname.slice('/kit/asset/'.length).replace(/\.js$/i, '');
        const entry = parseManifest(env).find((e) => e.name === name && isR2Entry(e));
        if (!entry) return json({ error: 'Not found' }, 404, cors); // unknown, or a url: entry (loaded direct)
        // Gate BEFORE touching the binding, so an unauthenticated caller learns nothing about config.
        if (secondaryNeedsAuth(entry.auth)) {
          const authed = await resolvePrincipal(request, env);
          if (!authed) throw new HttpError(401, 'This asset requires Authorization: Bearer <ns_t>');
          if (!kitGateAllows(entry.auth, authed.principal, parseSuperadmins(env))) throw new HttpError(403, `Not authorized: ${entry.name}`);
        }
        // kitConfigError already 500s (uniformly, pre-auth) if an r2: entry exists with no ASSETS binding,
        // so reaching here guarantees it's bound.
        const obj = await env.ASSETS!.get(r2Key(entry));
        if (!obj) return json({ error: 'Not found' }, 404, cors);
        // Spread cache AFTER cors: corsHeaders always sets `Vary: Origin`, so a gated entry must win with
        // `Vary: Origin, Authorization` (drop Origin and a shared cache could serve one origin's bytes to
        // another). The public case keeps cors's `Vary: Origin`.
        const cache: Record<string, string> = secondaryNeedsAuth(entry.auth)
          ? { 'Cache-Control': 'private, max-age=120', Vary: 'Origin, Authorization' }
          : { 'Cache-Control': 'public, max-age=300' };
        return new Response(await obj.text(), { headers: { 'content-type': 'text/javascript; charset=utf-8', ...cors, ...cache } });
      }

      const auth = await resolveAuth(request, env, policies);
      const client = new NsClient({ server: env.NS_SERVER, token: auth.token });

      // A self principal (portal.self but not portal.access) may reach ONLY the self surface, and ONLY in
      // portal-backend mode — so dia/standalone gains no delegated self surface. Every admin route keeps
      // its own gate, but /domains and /entities lean on resolveAuth's admin gate, so fence here.
      if (auth.self) {
        const sp = url.pathname;
        const selfOk = portalMode(env) && (sp === '/me/status' || sp === '/me/devices' || sp === '/me/resetPassword' || sp === '/kit/self.js');
        if (!selfOk) throw new HttpError(403, 'Not authorized for the svc portal');
      }

      // Gated per-tier BUNDLE. Portal-mode-only (like the primary/asset routes) so dia/local stay
      // byte-identical — otherwise an Access-gated dia caller with a reseller ns_t would get the bundle
      // (incl. the label) instead of a 404. resolveAuth already gated portal.access; also require a
      // delegated principal (service mode has none ⇒ 403, fail closed). Per-tier bytes only.
      if (portalMode(env) && url.pathname === '/kit/portal.js') {
        if (!auth.principal) throw new HttpError(403, 'The gated bundle requires a delegated ns_t');
        const allowedKeys = featurePolicyKeys().filter((k) => can(auth.principal!, k, policies));
        // Server tier-cache: key includes a host discriminator (caches.default is zone-shared across
        // dia/portal/dev on acmevoice.cloud) + VERSION, so tiers never collide and a deploy busts it.
        const tierKey = new Request(`https://inject.internal/${url.hostname}/portal/${tierHash(allowedKeys)}/${VERSION}`);
        const hit = await caches.default.match(tierKey);
        let bundle: string;
        if (hit) {
          bundle = await hit.text();
        } else {
          bundle = buildKitBundle(allowedKeys, env);
          await caches.default.put(tierKey, new Response(bundle, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=60' } }));
        }
        // cors last would clobber Vary with `Origin`; set our headers AFTER cors so `Vary: Origin,
        // Authorization` wins (per-token bytes must not be shared across origins by a cache).
        return new Response(bundle, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...cors, 'Cache-Control': 'private, max-age=120', Vary: 'Origin, Authorization' } });
      }

      // The minimal SELF bundle: own-account features. Portal-mode-only (like the admin bundle). Any
      // principal that passes portal.self gets it (admins too, for their own home widget); per-tier bytes.
      if (portalMode(env) && url.pathname === '/kit/self.js') {
        if (!auth.principal) throw new HttpError(403, 'The self bundle requires a delegated ns_t');
        if (!can(auth.principal, 'portal.self', policies)) throw new HttpError(403, 'Not authorized: portal.self');
        const selfKeys = selfFeaturePolicyKeys().filter((k) => can(auth.principal!, k, policies));
        const tierKey = new Request(`https://inject.internal/${url.hostname}/self/${tierHash(selfKeys)}/${VERSION}`);
        const hit = await caches.default.match(tierKey);
        let bundle: string;
        if (hit) {
          bundle = await hit.text();
        } else {
          bundle = buildSelfBundle(selfKeys, env);
          await caches.default.put(tierKey, new Response(bundle, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=60' } }));
        }
        return new Response(bundle, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...cors, 'Cache-Control': 'private, max-age=120', Vary: 'Origin, Authorization' } });
      }

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
        if (auth.principal && !can(auth.principal, 'callflow.view', policies)) throw new HttpError(403, 'Not authorized: callflow.view');
        const kind = (url.searchParams.get('kind') ?? '').toLowerCase();
        const ref = url.searchParams.get('ref') ?? '';
        if (!ENTITY_KINDS.has(kind) || !ref) return json({ error: 'Provide ?kind=did|user|queue|attendant&ref=<id>' }, 400, cors);

        const snapshot = await fetchDomainSnapshot(client, domain, { includeDialrules: true });
        const graph = resolveFlow(snapshot, { kind, ref } as EntityRef);

        // Optional Ringotel enrichment — fully gated. When RINGOTEL_API_KEY is unset this is a no-op
        // and the graph is byte-identical to the NS-only baseline. Best-effort & isolated: it never
        // changes this handler's status (enrichFlowGraph swallows its own errors).
        if (url.searchParams.get('enrich') !== '0') {
          const refresh = refreshRequested(url, auth, env, policies);
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
        requireFeature(auth, 'ringotel.orgStatus', env, policies);
        // Bound Ringotel data by NetSapiens scope in EVERY mode. These routes resolve from the
        // fleet-wide RINGOTEL_API_KEY keyed only by a domain string, so without this a caller could name
        // any domain in the Ringotel fleet -- including one their NS token cannot read. Skipped only for
        // a principal's own domain, which they can read by definition.
        if (!auth.principal || domain !== normDomain(auth.principal.domain)) await assertDomainReadable(client, domain);
        const refresh = refreshRequested(url, auth, env, policies);
        return json(await orgStatusForDomain(domain, env, caches.default, { refresh }), 200, cors);
      }

      if (url.pathname === '/ringotel/users') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        const domain = requireDomain(auth, url, env);
        await maybeElevate(auth, domain, env);
        requireFeature(auth, 'ringotel.userStatus', env, policies);
        // Bound Ringotel data by NetSapiens scope in EVERY mode. These routes resolve from the
        // fleet-wide RINGOTEL_API_KEY keyed only by a domain string, so without this a caller could name
        // any domain in the Ringotel fleet -- including one their NS token cannot read. Skipped only for
        // a principal's own domain, which they can read by definition.
        if (!auth.principal || domain !== normDomain(auth.principal.domain)) await assertDomainReadable(client, domain);
        const refresh = refreshRequested(url, auth, env, policies);
        return json(await usersStatusForDomain(domain, env, caches.default, { refresh }), 200, cors);
      }

      if (url.pathname === '/ringotel/orgs') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        requireFeature(auth, 'ringotel.orgList', env, policies);
        // Scope = the caller's own NS-visible domains (never a client-supplied list). Same block/allow
        // filters as /domains, then resolve enablement in-memory against the cached fleet directory.
        const allow = domainAllowlist(env);
        const block = domainBlocklist(env);
        let doms = (auth.lockedDomain ? [{ domain: auth.lockedDomain }] : await listDomains(client)).map((d) => normDomain(d.domain));
        if (allow) doms = doms.filter((d) => allow.has(d));
        if (block.size) doms = doms.filter((d) => !block.has(d));
        const refresh = refreshRequested(url, auth, env, policies);
        return json(await orgsStatusForDomains(doms, env, caches.default, { refresh }), 200, cors);
      }

      // ── Ringotel activation (the profile-page feature) ────────────────────────────────
      // Single-user status indicator (read). Gated by ringotel.profileStatus; NS-scope-bound like the
      // other Ringotel reads.
      if (url.pathname === '/ringotel/user') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        const domain = requireDomain(auth, url, env);
        await maybeElevate(auth, domain, env);
        requireFeature(auth, 'ringotel.profileStatus', env, policies);
        if (!auth.principal || domain !== normDomain(auth.principal.domain)) await assertDomainReadable(client, domain);
        const ext = str(url.searchParams.get('ext'));
        // Phase 1 (default): CACHED status for an instant display. Phase 2 (?fresh=1): LIVE status to catch
        // a just-completed change. Eligibility (NS reads) is computed only on the cached phase and reused
        // client-side, so the follow-up live poll stays cheap.
        const wantFresh = str(url.searchParams.get('fresh')) === '1';
        let active: boolean, status: unknown;
        if (wantFresh) {
          const all = await usersStatusForDomainFresh(domain, env, caches.default);
          active = !!all.active;
          status = all.active && ext && all.users ? (all.users[ext] ?? null) : null;
        } else {
          const s = await computeUserStatus(domain, ext, env, caches.default);
          active = s.present; // preserve `/ringotel/user` semantics: `active` means "org present"
          status = s.status;
        }
        // Eligibility (so the client shows a plain checkbox for a normal user, and a Force button ONLY for
        // a soft-excluded one). Best-effort: a read failure ⇒ null, and the client falls back gracefully.
        let eligibility: { activatable: boolean; tier: string; reasons: string[] } | null = null;
        if (ext && !wantFresh) {
          const rtConfig = resolveRingotelConfig(env);
          const nsUser = (await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}`).catch(() => null)) as Record<string, unknown> | null;
          if (nsUser) {
            // `null` marks a FAILED read, which must stay distinguishable from a genuinely empty device
            // list — otherwise a transient NS error would be reported as missing hardware below.
            const devs = await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}/devices`).catch(() => null);
            const devList = Array.isArray(devs) ? devs : [];
            const devCount = devList.length;
            const e = evaluateEligibility(nsUserToElig(nsUser, ext, devCount), { domain, isReseller: auth.principal ? isResellerScope(auth.principal.scope) : false }, rtConfig);
            eligibility = { activatable: e.activatable, tier: e.tier, reasons: e.reasons };

            // The one health flag that needs an upstream read. Free here: the device list was fetched
            // for the eligibility count above. Only meaningful for an ACTIVATED app user — a user with
            // no app is supposed to have no `<ext><suffix>` device.
            const st = status as { activated?: boolean; health?: { flags: HealthFlag[]; severity: string } } | null;
            if (devs !== null && st?.activated && st.health) {
              const want = ext + rtConfig.suffix;
              if (!devList.some((d) => String((d as Record<string, unknown>)?.device ?? '') === want)) {
                st.health.flags = [...st.health.flags, 'no-ns-device'];
                st.health.severity = worstSeverity(st.health.flags);
              }
            }
          }
        }
        return json({ active: !!active, ext, status, eligibility }, 200, cors);
      }

      // ── Self-service (own-account) routes ────────────────────────────────────────────
      // Own app status for the home widget. Identity comes from the NS `~` self-wildcard (authoritative,
      // token-scoped) — never client input. Shares the Ringotel org-users cache with /ringotel/user.
      if (portalMode(env) && url.pathname === '/me/status') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        if (!auth.principal) throw new HttpError(403, 'The self status route requires a delegated ns_t');
        if (!can(auth.principal, 'portal.self', policies)) throw new HttpError(403, 'Not authorized: portal.self');
        requireFeature(auth, 'me.appStatus', env, policies);
        const { ext, domain } = await resolveSelfNsUser(client, auth.principal);
        const s = await computeUserStatus(domain, ext, env, caches.default);
        return json({ active: s.active, present: s.present }, 200, cors);
      }

      // Own devices (read). Built but default off (me.devices). NS `~` self-wildcard — no ext derivation,
      // no ringotelEnabled gate (a pure NS device read).
      if (portalMode(env) && url.pathname === '/me/devices') {
        if (!auth.principal) throw new HttpError(403, 'The self devices route requires a delegated ns_t');
        if (!can(auth.principal, 'portal.self', policies)) throw new HttpError(403, 'Not authorized: portal.self');
        requireFeature(auth, 'me.devices', env, policies);
        const devs = await client.get('/domains/~/users/~/devices').catch(() => []);
        return json({ devices: Array.isArray(devs) ? devs : [] }, 200, cors);
      }

      // Reset OWN app password (write). Built but default off (me.resetPassword). Identity from the `~`
      // wildcard; write-rail fenced (RINGOTEL_WRITE_DOMAINS). No assertDomainReadable — own domain by
      // construction, and a low-priv token may be refused NS GET /domains/{d}.
      if (portalMode(env) && url.pathname === '/me/resetPassword' && request.method === 'POST') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        if (!auth.principal) throw new HttpError(403, 'The self reset route requires a delegated ns_t');
        if (!can(auth.principal, 'portal.self', policies)) throw new HttpError(403, 'Not authorized: portal.self');
        requireWriteFeature(auth, 'me.resetPassword', policies);
        const { ext, domain, record } = await resolveSelfNsUser(client, auth.principal);
        const rtConfig = resolveRingotelConfig(env);
        assertDomainWritable(domain, rtConfig.writeDomains);
        if (needsFreshAuth(ROUTES['/me/resetPassword'].sensitivity)) await requireFreshAuth(auth, env);
        const res = await resolveForWrite(env, caches.default, domain);
        if (res.status === 'none') return json({ error: 'No app organization is configured for this domain' }, 404, cors);
        if (res.status === 'ambiguous') throw new HttpError(409, 'App organization binding is ambiguous for this domain');
        const users = res.users ?? [];
        if (!buildExtIndex(users, res.entry.branchid).get(ext)) return json({ error: 'No app user to reset for this extension' }, 404, cors);
        const email = record ? nsUserToElig(record, ext, 0).email : '';
        const result = await resetPassword({ nsWrite: new NsWriteClient({ server: env.NS_SERVER, token: auth.token }), rtWrite: makeWriteClient(env), users, orgid: res.entry.orgid, branchid: res.entry.branchid, domain, ext, suffix: rtConfig.suffix, email });
        await invalidateOrgUsers(caches.default, res.entry.orgid);
        return json({ ok: true, ...result }, 200, cors);
      }

      // Activate / deactivate (write). Chain: feature (fail-closed) → domain → WRITABLE rail → READABLE
      // scope → forceFresh → (activate only) eligibility → write → cache invalidate.
      if (url.pathname === '/ringotel/activate' && request.method === 'POST') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        const body = (await request.json().catch(() => null)) as { domain?: string; ext?: string; activate?: boolean; force?: boolean } | null;
        const ext = str(body?.ext);
        if (!ext) return json({ error: 'Provide { ext }' }, 400, cors);
        const wantActive = body?.activate !== false; // default: activate
        requireWriteFeature(auth, 'ringotel.activate', policies);
        const domain = requireDomainValue(auth, str(body?.domain), env);
        const rtConfig = resolveRingotelConfig(env);
        assertDomainWritable(domain, rtConfig.writeDomains);
        await assertDomainReadable(client, domain);
        if (needsFreshAuth(ROUTES['/ringotel/activate'].sensitivity)) await requireFreshAuth(auth, env);

        const res = await resolveForWrite(env, caches.default, domain);
        if (res.status === 'none') return json({ error: 'No app organization is configured for this domain' }, 404, cors);
        if (res.status === 'ambiguous') throw new HttpError(409, 'App organization binding is ambiguous for this domain');
        const users = res.users ?? [];
        const nsWrite = new NsWriteClient({ server: env.NS_SERVER, token: auth.token });
        const rtWrite = makeWriteClient(env);
        const common = { nsWrite, rtWrite, users, orgid: res.entry.orgid, branchid: res.entry.branchid, domain, ext, suffix: rtConfig.suffix };

        let result;
        if (wantActive) {
          const nsUser = (await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}`).catch(() => null)) as Record<string, unknown> | null;
          if (!nsUser) return json({ error: 'User not found' }, 404, cors);
          const devices = await nsWrite.getDevices(domain, ext);
          const eu = nsUserToElig(nsUser, ext, devices.length);
          // `force` is a reseller RUNTIME override (bypasses soft, never hard); honored only for a reseller.
          const elig = evaluateEligibility(eu, { domain, isReseller: isResellerScope(auth.principal!.scope), force: body?.force === true }, rtConfig);
          if (!elig.activatable) return json({ error: 'Not eligible for activation', tier: elig.tier, reasons: elig.reasons }, 403, cors);
          result = await activate({ ...common, name: nsDisplayName(nsUser) || ext, email: eu.email });
        } else {
          // Best-effort identity sync on deactivate too: the RT user stays as a visible directory entry.
          // If the NS user is gone (a common reason to deactivate) the fetch is null → deactivate skips
          // the sync and just turns the user off.
          const nsUser = (await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}`).catch(() => null)) as Record<string, unknown> | null;
          const name = nsUser ? nsDisplayName(nsUser) || undefined : undefined;
          const email = nsUser ? nsUserToElig(nsUser, ext, 0).email || undefined : undefined;
          result = await deactivate({ ...common, name, email });
        }
        await invalidateOrgUsers(caches.default, res.entry.orgid);
        return json({ ok: true, ...result }, 200, cors);
      }

      // Reset the app password (write). Requires an existing app user for the extension.
      if (url.pathname === '/ringotel/resetPassword' && request.method === 'POST') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        const body = (await request.json().catch(() => null)) as { domain?: string; ext?: string } | null;
        const ext = str(body?.ext);
        if (!ext) return json({ error: 'Provide { ext }' }, 400, cors);
        requireWriteFeature(auth, 'ringotel.resetPassword', policies);
        const domain = requireDomainValue(auth, str(body?.domain), env);
        const rtConfig = resolveRingotelConfig(env);
        assertDomainWritable(domain, rtConfig.writeDomains);
        await assertDomainReadable(client, domain);
        if (needsFreshAuth(ROUTES['/ringotel/resetPassword'].sensitivity)) await requireFreshAuth(auth, env);

        const res = await resolveForWrite(env, caches.default, domain);
        if (res.status === 'none') return json({ error: 'No app organization is configured for this domain' }, 404, cors);
        if (res.status === 'ambiguous') throw new HttpError(409, 'App organization binding is ambiguous for this domain');
        const users = res.users ?? [];
        if (!buildExtIndex(users, res.entry.branchid).get(ext)) return json({ error: 'No app user to reset for this extension' }, 404, cors);
        const nsUser = (await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}`).catch(() => null)) as Record<string, unknown> | null;
        const email = nsUser ? nsUserToElig(nsUser, ext, 0).email : '';
        const result = await resetPassword({ nsWrite: new NsWriteClient({ server: env.NS_SERVER, token: auth.token }), rtWrite: makeWriteClient(env), users, orgid: res.entry.orgid, branchid: res.entry.branchid, domain, ext, suffix: rtConfig.suffix, email });
        await invalidateOrgUsers(caches.default, res.entry.orgid);
        return json({ ok: true, ...result }, 200, cors);
      }

      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...(err.reason ? { reason: err.reason } : {}) }, err.status, cors);
      // A write resolve/precondition failure (ambiguous extension, reset on absent/non-active user) carries
      // its own status (409/404); the message is our own descriptive text (ext number only, no secrets).
      if (err instanceof RingotelWriteError) return json({ error: err.message }, err.status, cors);
      const status = err instanceof NsApiError ? (err.status === 401 || err.status === 403 ? err.status : 502) : 500;
      // Log the full error (incl. upstream NS path + response body) server-side only. The client gets a
      // generic message — NsApiError.message embeds internal API routes and up to 500 chars of the NS
      // response body, which must not be echoed to the caller.
      console.error(JSON.stringify({ msg: 'request failed', path: url.pathname, error: (err as Error).message }));
      return json({ error: 'Request failed' }, status, cors);
    }
  },
} satisfies ExportedHandler<Env>;
