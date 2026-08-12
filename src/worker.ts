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
import { worstSeverity, type HealthFlag, type User } from '@dszp/ringotel-lib';
import { brandAccent, productName, VERSION } from './brand.js';
import { needsSetup, setupHtml } from './setup.js';
import { portalModeHtml } from './portalInfo.js';
import { enrichFlowGraph, ringotelEnabled, orgStatusForDomain, usersStatusForDomain, usersStatusForDomainFresh, orgsStatusForDomains, makeWriteClient, invalidateOrgUsers, resolveForWrite, buildExtIndex, ringotelDomains, scopeOf, connectionsOf, orgidOf, type OrgResolution, type UserAppStatus } from './ringotel.js';
// The eligibility DECISION is the shared engine in the library — one implementation with the SSO worker,
// so the two can't drift. Only this deployment's config parsing is local.
import { evaluateEligibility, type EligUser } from '@dszp/netsapiens-lib';
import { resolveRingotelConfig, ringotelConfigError } from './eligibility.js';
import { activate, deactivate, resetPassword, isDomainWritable, RingotelWriteError } from './ringotelActivation.js';
import { planDirectoryPrepop, applyDirectoryPrepop, type PrepopInput } from './ringotelPrepop.js';
import { enrichDeviceDetails, nsDeviceDetailsEnabled } from './nsDevices.js';
import { planDomainSweep, type SweepPlan } from './nsOffboard.js';
import {
  parseNsEventsConfig, nsEventsConfigError, verifyEventRequest, decodeEventBatch, diagShape,
  desiredSubscriptions, ownedPrefix, applySubscriptionPlan, planInertCleanup, healthLine,
  sweepScope, NS_EVENTS_PREFIX, locateConnection, type NsEventsConfig,
} from './nsEvents.js';
import { getServiceToken } from './nsIdentity.js';
import { syncIdentity, deactivateAppOnly, repairDeviceForEvent } from './ringotelActivation.js';
import { NsSubscriptionsClient, planSubscriptions } from '@dszp/netsapiens-lib';
import { resolveFeaturePolicies, featuresConfigError, parseSuperadmins, kitStatusLockedReason, fleetReadAllowed } from './features.js';
import { resolveMenus, menuConfigError, appsHideSources, activeApps, unreachableDefaults, type MenuPlan } from './menus.js';
import { resolveAppAccess, ssoEnabled, autoActivates, parseDownloads, parseHideList, appAccessConfigError, appStatusView, type AppAccessMode, type DownloadLink } from './appAccess.js';
import {
  primaryBasename,
  primaryJs,
  parseManifest,
  buildKitBundle,
  buildSelfBundle,
  buildSpkBundle,
  featurePolicyKeys,
  selfFeaturePolicyKeys,
  spkFeaturePolicyKeys,
  tierHash,
  kitGateAllows,
  secondaryNeedsAuth,
  isR2Entry,
  r2Key,
  kitConfigError,
} from './kit.js';
import { buildStatus } from './status.js';
import { statusHtml } from './statusPage.js';
import { runProbes } from './statusProbes.js';

interface Env {
  /** NS API host, e.g. "api.example.com" (var). */
  NS_SERVER: string;
  /** Comma-separated allowed browser origins for CORS (var). */
  ALLOWED_ORIGINS?: string;
  /**
   * Comma-separated domain allowlist. When set, /domains is filtered to it and /entities + /flow
   * reject any other domain (403) — even one a valid token could otherwise read. Empty ⇒ unrestricted
   * (bounded only by the token's NS scope). Set this in dev to keep the tool off the wider fleet.
   */
  ALLOWED_DOMAINS?: string;
  /**
   * Cache-key namespace for THIS deployment — set it to a distinct value in EVERY env block (`vars` are
   * not inherited). `caches.default` is zone-shared across every Worker on the zone, so without this the
   * portal, dev and dia deployments read and write ONE set of Ringotel cache entries: one deployment's
   * write-invalidate is undone by another's read, and a dev refresh holds the refresh lock against prod.
   * Deliberately NOT derived from `url.hostname` — `scheduled()` has no request. See `scopeOf`.
   */
  CACHE_SCOPE?: string;

  /** Manager Portal host that issues ns_t, e.g. "manage.example.com". REQUIRED for delegated auth:
   *  jwt.verify() has no issuer default, so an unset value fails closed (see portalIss()). */
  NS_PORTAL_ISS?: string;

  // ── Optional: branding (see src/brand.ts) ──────────────────────────────────
  // The shared library ships vendor-neutral themes only, so branding is deploy config, not source.
  /** Brand accent hex (e.g. "#b3282d") for the call-flow diagrams this Worker renders. Absent ⇒
   *  unbranded: the neutral `ns-portal` palette. */
  BRAND_ACCENT?: string;
  /** Company name, e.g. "Acme Voice" — drives the product name ("<name> Portal Kit v<ver>") shown in page
   *  titles and the portal footer. A white-label NAME ⇒ set as a SECRET, never a var. */
  BRAND_NAME?: string;

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

  // ── Self-service app-access surface (me.appAccess; see src/appAccess.ts) ──────────────────
  /** Ringotel org `params.sso` service NAME this deployment's SSO webhook answers for (the half after
   *  the `/`). Unset ⇒ never claim SSO, even if an org has SOME service bound (fail closed). */
  RINGOTEL_SSO_SERVICE?: string;
  /** Does an SSO sign-in create the Ringotel account on demand? A different setting from the SSO
   *  binding itself (not derivable from the org) — CSV of domains, `*` for all, unset ⇒ off. */
  SSO_AUTO_ACTIVATE?: string;
  /** Stock app-menu labels to hide, fleet-wide (CSV) or per-domain (JSON `{"<domain>":[...],"*":[...]}`). */
  PORTAL_APPS_HIDE?: string;
  /** JSON `{ "<menu>": { hide?: [...], add?: [...], rename?: [...] } }` for the apps/account/management
   *  menus, targetable by user/domain/scope/app state (see src/menus.ts). A `rename` relabels a stock
   *  entry in place, keyed on the label the portal ships. Setting both this AND PORTAL_APPS_HIDE for the
   *  apps menu's hide list is fine: the two hide lists MERGE (see appsHideSources) and the console
   *  attributes each entry to the setting it came from. It used to be a config error; that was undone
   *  deliberately, and this comment went on saying otherwise. */
  PORTAL_MENUS?: string;
  /** Domains to treat as Documo-active for menu targeting, until that integration ships and can answer
   *  for itself. A stand-in for a live signal, not a feature flag — see `documoEnabled` in menus.ts. */
  DOCUMO_DOMAINS?: string;
  /** JSON array of `{label,url,title?}` download links shown on the app-access surface. Unset ⇒ none. */
  PORTAL_APP_DOWNLOADS?: string;

  // ── Optional integration: NetSapiens device details (basic; see src/nsDevices.ts) ──
  /** Truthy enables desk-phone enrichment (model + 🟢/🔴 registration presence) on ###/#### device lines. */
  NS_DEVICE_DETAILS?: string;

  // ── Optional: Cloudflare Access gate (standalone-mode deployments behind Zero Trust; see src/access.ts) ──

  /**
   * Comma-separated domains to hide/refuse regardless of the token's scope — e.g. the DID-holding
   * "0000.…service" domain that has nothing to diagram. Filtered out of /domains AND refused (403) on
   * /entities + /flow, so a deep-link can't reach one either. Applies to both auth modes.
   */
  BLOCKED_DOMAINS?: string;


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
  /** Where "what changed in this version" lives, with `{version}` substituted. Absent ⇒ the public release
   *  list anchored at this version; present but EMPTY ⇒ never link (see brand.ts releaseNotesUrl). */
  PORTAL_RELEASE_NOTES_URL?: string;
  /** Endpoint the status banner asks for the caller's message. Unset ⇒ the feature is inert. Must be https:
   *  the request carries the caller's live ns_t, so it may only be an endpoint the operator controls. */
  STATUS_BANNER_WEBHOOK?: string;
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

  // ── NetSapiens event subscriptions (see nsEvents.ts) ───────────────────────────────────────────────
  /** `auto` (default) | `on` | `off`. `auto` = on once Ringotel and the settings below are configured. */
  /**
   * Rotate the `<ext><suffix>` SIP password when activating a user whose device ALREADY existed.
   * (Unrelated to the NS_EVENTS_* block below.)
   * **Defaults to ON** — set `0`/`false`/`no`/`off` to keep the previous reuse-the-stored-password
   * behaviour. Rotating invalidates any other endpoint still holding that credential, which would
   * otherwise fight this one for the same SIP registration. Only activation rotates; per-login paths
   * must not, or concurrent logins churn the credential.
   */
  RINGOTEL_ROTATE_SIP_ON_ACTIVATE?: string;
  /** Truthy ⇒ directory pre-population also creates entries for SOFT-gated users (SHARED/VOICEMAIL/etc). */
  RINGOTEL_PREPOP_INCLUDE_SOFT?: string;
  NS_EVENTS?: string;
  /** Enumerated domains, or `*` for every domain the Ringotel write rail permits. Unset ⇒ inert. */
  NS_EVENTS_DOMAINS?: string;
  /** This Worker's public origin. MUST be host-distinct per env, or two reconcilers fight over one
   *  subscription set (ownership is decided by post-url prefix). */
  NS_EVENTS_BASE_URL?: string;
  /** SECRET. Master key for the per-domain callback token; rotating it means re-PUTting every post-url. */
  NS_EVENTS_PATH_SECRET?: string;
  NS_EVENTS_MODELS?: string;
  NS_EVENTS_RENEW_HORIZON?: string;
  NS_EVENTS_TARGET_LIFETIME?: string;
  NS_EVENTS_ALLOW_IPS?: string;
  NS_EVENTS_GEO_SUPPORT?: string;
  NS_EVENTS_PREFERRED_SERVER?: string;
  NS_EVENTS_MAX_EVENTS?: string;
  NS_EVENTS_DIAG_RAW?: string;
  /** `off` (default) | `deactivate`. Whether an NS-deleted user's app record is deactivated, by both the
   *  event tier and the cron sweep. `deactivate+delete` is deliberately NOT accepted (see src/nsEvents.ts). */
  NS_EVENTS_OFFBOARD?: string;
  /** `off` (default) | `report` | `heal`. Device self-heal triggered by a user-change event. */
  NS_EVENTS_DEVICE_REPAIR?: string;
  /** Max extensions deactivated per sweep run. Default 200; overflow is logged, never silent. */
  NS_EVENTS_SWEEP_MAX?: string;

  /**
   * SECRET. The background **service identity** — used when an event arrives with no caller.
   *
   * ⚠️ NOT the same thing as `NS_API_TOKEN` above, and there is deliberately no fallback between them.
   * `NS_API_TOKEN` is the standalone-mode *read* token; this one performs privileged writes on behalf of
   * nobody. Make it a dedicated least-privilege key (`allowed-models`, domain and IP restrictions).
   */
  NS_API_KEY?: string;
  /** SECRET. Alternative to NS_API_KEY: admin credentials exchanged for an OAuth token. Wins if both set. */
  NS_ADMIN_USER?: string;
  NS_ADMIN_PASS?: string;
  NS_OAUTH_SERVER?: string;
  NS_OAUTH_CLIENT_ID?: string;
  NS_OAUTH_CLIENT_SECRET?: string;
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
export const ROUTES = {
  '/domains': { sensitivity: 'read' },
  '/entities': { sensitivity: 'read' },
  '/flow': { sensitivity: 'read' },
  '/rapp/org': { sensitivity: 'read' },
  '/rapp/users': { sensitivity: 'read' },
  '/rapp/orgs': { sensitivity: 'read' },
  '/rapp/user': { sensitivity: 'read' },
  '/rapp/prepop/preview': { sensitivity: 'read' },
  '/rapp/prepop/apply': { sensitivity: 'write' },
  '/rapp/activate': { sensitivity: 'write' },
  '/rapp/resetPassword': { sensitivity: 'write' },
  '/kit/portal.js': { sensitivity: 'read' },
  '/kit/self.js': { sensitivity: 'read' },
  // `read` is correct here: the console BUNDLE carries no configuration — it is neutral menu + bridge JS.
  '/kit/spk.js': { sensitivity: 'read' },
  // `sensitive`, not `read`: THIS route returns the deployment's configuration, so needsFreshAuth forces
  // a fresh GET /jwt and a logged-out token cannot pull it from a cached verdict. The extra NetSapiens
  // round-trip is deliberate — decided 2026-08-07. Do NOT relax this to `read` to save a call.
  '/kit/status': { sensitivity: 'sensitive' },
  // `read`, not `sensitive`: it discloses nothing about the deployment. It takes a CANDIDATE config the
  // caller just typed and answers whether `menuConfigError` accepts it — a pure function of the query
  // string, touching neither env nor any upstream. Still gated on `kit.status` like the rest of the
  // console, and still a GET, so the "non-GET means write" invariant is untouched.
  '/kit/menus/check': { sensitivity: 'read' },
  // Same classification and the same grounds as the check route above: a pure function of the query
  // string plus this deployment's own PORTAL_APPS_HIDE, disclosing nothing a console caller cannot
  // already read from the Config tab.
  '/kit/menus/resolve': { sensitivity: 'read' },
  '/me/status': { sensitivity: 'read' },
  '/me/devices': { sensitivity: 'read' },
  '/me/resetPassword': { sensitivity: 'write' },
  '/me/app-access': { sensitivity: 'read' },
} satisfies Record<string, { sensitivity: CallSensitivity }>;

/** POST paths — the write routes. Everything else is GET-only (405 otherwise). */
const WRITE_PATHS = new Set(['/rapp/activate', '/rapp/resetPassword', '/me/resetPassword', '/rapp/prepop/apply']);

/**
 * Routes matched by PREFIX rather than exact pathname, because they carry path parameters.
 *
 * `ROUTES` and `WRITE_PATHS` both key on exact `url.pathname`, so a parameterized path can be registered
 * in NEITHER — `satisfies` cannot force a classification it has no key for, and a `WRITE_PATHS` entry
 * would be dead code (`.has()` can never match). This table restores the invariant those two were written
 * to protect: every route is classified somewhere, and adding one unclassified fails to compile.
 */
const PREFIX_ROUTES = {
  [NS_EVENTS_PREFIX]: { sensitivity: 'write' },
} satisfies Record<string, { sensitivity: CallSensitivity }>;

// kitConfigError moved to src/kit.ts (exported) — it validates only KitEnv-shaped config, so it lives
// with the module that owns the injection manifest rather than being re-derived here.

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
  /** The delegated caller. REQUIRED: `resolveAuth` returns a principal on every success path, because
   *  there is no stored-credential path left to produce an `Auth` without one. Making it required is what
   *  keeps that invariant visible at the call sites — three consumers used to read its ABSENCE as
   *  permission (skip the policy check, grant a fleet-wide cache refresh, skip the fresh-token
   *  re-validation), which was correct while a service-mode caller existed and would have become
   *  allow-by-default the moment anything else constructed an Auth without one. */
  principal: Principal;
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
  // Policy applies to every caller, because every caller is a delegated identity now — `Auth.principal`
  // is required, so there is no "authenticated but unpoliced" shape for a request to arrive in.
  if (!can(auth.principal, feature, policies)) throw new HttpError(403, `Not authorized: ${feature}`);
}

/**
 * The console's SECOND gate, independent of the feature policy.
 *
 * `kit.status`'s allowedLevels floor constrains which LEVELS config may name, but a `users:` grant names
 * an account directly at any scope — so the floor alone cannot keep a domain-locked principal out. This
 * page necessarily reports settings that carry OTHER customers' domain names (ALLOWED_DOMAINS,
 * NS_EVENTS_DOMAINS, RINGOTEL_WRITE_DOMAINS, SSO_AUTO_ACTIVATE, PORTAL_MENUS targeting, PORTAL_APPS_HIDE,
 * RINGOTEL_OVERRIDES, RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN, PORTAL_SUPERADMINS — and whatever is added next).
 *
 * Two doors, both deliberate: reseller scope (structural — resolveAuth already lets them read any domain,
 * so the console discloses nothing they could not GET), or a named superadmin (the operator's own account
 * list, fleet-disclosing by definition).
 *
 * A rule on the VIEWER rather than a per-setting redaction list, on purpose: an enumeration of "settings
 * that can contain a domain name" is a second hand-maintained list with no mechanical guard, and
 * forgetting to mark one leaks silently. That is the exact failure this whole feature exists to prevent.
 */
function requireFleetRead(principal: Principal, env: Env): void {
  // The predicate itself lives in features.ts — the integration console's Permissions matrix reads the SAME
  // one to decide what each scope can actually reach, so a matrix that says "an Office Manager can open
  // the console" and a Worker that refuses them cannot come apart. This function owns only the wording.
  if (fleetReadAllowed(principal, env)) return;
  throw new HttpError(403,
    'The configuration console requires reseller scope or a listed superadmin account: it reports settings ' +
    'that name other domains, and this account is limited to its own domain.');
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

  // No bearer. This is a delegated-only backend: there is no stored credential to fall back to, and
  // there is no configuration that creates one.
  throw new HttpError(401, 'This portal backend requires Authorization: Bearer <ns_t>');
}

/**
 * Is a forced Ringotel/device cache refresh permitted for THIS caller? `?refresh=ringotel` bypasses
 * the ~1h fleet-directory cache and re-digs against the shared RINGOTEL_API_KEY, so it's an operator
 * capability, not a caller one. Standalone mode (dia) is the operator's own Access-gated tool → allowed.
 * With a delegated principal → reseller/super-user only (ringotel.refresh); a looping Office Manager is
 * refused and simply reads the cache. getDirectory additionally coalesces refreshes fleet-wide.
 *
 * `?refresh=1` is the NEUTRAL spelling and the one the injected client emits. The vendor spelling is
 * still accepted — it is the documented form and predates any UI — but it must not appear in bytes we
 * SERVE: the injection bundle is read in devtools by admins of a white-labeled deployment, which is the
 * same reason these routes are `/rapp/*` and the org flag is `hPIE` rather than its upstream name.
 */
function refreshRequested(url: URL, auth: Auth, env: Env, policies: FeaturePolicies): boolean {
  const want = url.searchParams.get('refresh');
  if (want !== '1' && want !== 'ringotel') return false;
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
const EMAIL_KEYS = ['email', 'email-address', 'email_address', 'emailaddress'] as const;

/**
 * Does this record carry an email field AT ALL — regardless of its value?
 *
 * The distinction matters on the unattended event path. A record read with a projected or
 * permission-limited credential can come back *successfully* with the email field simply absent, which
 * `firstEmail` cannot tell apart from "present and blank". Treating that as a removal would push a blank
 * address to every user the read covered. NetSapiens itself always includes the key (verified live: a user
 * with no address returns `email: ""`), so an absent key means the RESPONSE was narrowed, not that the
 * address was cleared.
 */
function hasEmailField(u: Record<string, unknown>): boolean {
  return EMAIL_KEYS.some((k) => k in u);
}

/** First non-blank email across the likely v2 field spellings (a user may carry several). */
function firstEmail(u: Record<string, unknown>): string {
  for (const k of EMAIL_KEYS) {
    const v = u[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v)) for (const e of v) if (typeof e === 'string' && e.trim()) return e.trim();
  }
  return '';
}

/**
 * The caller's OWN facts, for `{var}` substitution in added menu entries. Sourced from the `~` self-read,
 * so a user can only ever interpolate themselves — there is no path to another user's name or address.
 * Missing fields resolve to an empty string rather than a literal placeholder.
 */
function menuVars(u: Record<string, unknown> | null, ext: string, domain: string): Record<string, string> {
  const r = u ?? {};
  const fname = str(r['first-name'] ?? r['first_name'] ?? r['name-first-name']);
  const lname = str(r['last-name'] ?? r['last_name'] ?? r['name-last-name']);
  const name = str(r['display-name'] ?? r['name'] ?? r['subscriber_name']) || [fname, lname].filter(Boolean).join(' ');
  return { ext, domain, email: firstEmail(r), fname, lname, name };
}

function nsUserToElig(u: Record<string, unknown>, ext: string, deviceCount: number): EligUser {
  const first = str(u['first-name'] ?? u['first_name'] ?? u['name-first-name']);
  const last = str(u['last-name'] ?? u['last_name'] ?? u['name-last-name']);
  const display = str(u['display-name'] ?? u['name'] ?? u['subscriber_name']);
  const srvCode = str(u['srv_code'] ?? u['srv-code'] ?? u['service-code']);
  return { ext, srvCode, email: firstEmail(u), names: [first, last, display].filter(Boolean), deviceCount };
}

/**
 * The NS email to send on an app-directory write, honoring `ActivationOpts.email`'s three states:
 * `undefined` = we don't know (touch nothing), `''` = the user genuinely has none (propagate the
 * removal), a string = the current address.
 *
 * Two ways to not know, and only one of them is a failed request:
 *  1. **The read failed** (`record` is null) — the obvious case.
 *  2. **The session is MASQUERADING.** Email is auth-adjacent, and the portal does not let an operator
 *     view or change a masked user's address — so a read on that session may be REDACTED rather than
 *     truthful, and a redacted field is indistinguishable from a removed one. Propagating it would
 *     silently wipe a good address, which is exactly what the three-state contract exists to prevent.
 *     So a blank read under a mask means "unknown", never "removed". A non-blank value is still trusted:
 *     it can only have come from the record. (The client already disables these controls while masked;
 *     this is the server-side half, and it fails closed whether or not NS actually redacts the field.)
 */
export function emailForWrite(
  record: Record<string, unknown> | null,
  ext: string,
  principal: Principal | undefined,
): string | undefined {
  if (!record) return undefined;
  const email = nsUserToElig(record, ext, 0).email;
  if (email) return email;
  // No usable address. Blank-because-narrowed is NOT blank-because-removed: if the record carries no
  // email field at all, the read was projected rather than the address cleared, so say "unknown".
  if (!hasEmailField(record)) return undefined;
  return principal?.operator ? undefined : '';
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

/**
 * Merge `appStatusView`'s connection/warning view fields onto one `UserAppStatus` record for the client.
 * Applied here, in the Worker, rather than in `ringotel.ts`: `usersStatusMap` is the data layer and stays
 * ignorant of what the client does with a conflict, and `appAccess.ts` (the decision/view layer) is
 * already imported here alongside `ringotel.ts` — importing it INTO `ringotel.ts` instead would pull a
 * client-facing view concern into the data layer for no reason. One function, called at every place a
 * `UserAppStatus` record reaches a response body, so `/rapp/users` (bulk), `/rapp/user` (single, both the
 * cached and `?fresh=1` paths) and anything else built on `usersStatusForDomain`/`usersStatusForDomainFresh`
 * can't independently forget it.
 */
function withConnectionView(u: UserAppStatus): UserAppStatus & { warning?: 'connection-conflict' } {
  return { ...u, ...appStatusView(u) };
}

/** Shared status projection: does `domain` have a bound Ringotel org (`present`), and is `ext` activated
 * within it (`active`)? Reads the cached org-users blob (~10-min TTL) — the SAME source the admin
 * `/rapp/user` route uses, so self + admin reads share one Ringotel AdminAPI call. */
async function computeUserStatus(domain: string, ext: string, env: Env, cache: Cache): Promise<{ present: boolean; active: boolean; status: unknown; age?: number }> {
  const all = await usersStatusForDomain(domain, env, cache, { refresh: false });
  const present = !!all.active;
  const raw = present && ext && all.users ? (all.users[ext] ?? null) : null;
  const status = raw ? withConnectionView(raw) : null;
  const active = present && !!(status && status.activated);
  return { present, active, status, ...(typeof all.age === 'number' ? { age: all.age } : {}) };
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

/**
 * Per-user eligibility verdict for `ext`, via the SAME engine call `/rapp/user` uses (an NS user
 * read + device count fed through `evaluateEligibility`) — NOT `orgStatusForDomain`'s `eligible`, which
 * is an org-level stub, not a per-user verdict. Best-effort: any read failure yields `null` so the
 * caller degrades (treats as ineligible) rather than fabricating a pass.
 *
 * Also returns the raw `devs` read (whatever `client.get` resolved, or `null` on a failed/absent read)
 * so a caller that ALSO needs the device list — `/rapp/user`'s no-ns-device health flag — can reuse
 * it instead of re-issuing the same devices GET a second time (one implementation, one NS round-trip).
 */
async function evaluateEligibilityForExt(
  client: NsClient,
  domain: string,
  ext: string,
  env: Env,
  isReseller: boolean,
  emailNotRequired = false,
): Promise<{ activatable: boolean; tier: string; reasons: string[]; devs: unknown; nsUser: Record<string, unknown> } | null> {
  if (!ext) return null;
  const nsUser = (await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}`).catch(() => null)) as Record<string, unknown> | null;
  if (!nsUser) return null;
  const devs = await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}/devices`).catch(() => null);
  const devCount = Array.isArray(devs) ? devs.length : 0;
  const rtConfig = resolveRingotelConfig(env);
  const e = evaluateEligibility(nsUserToElig(nsUser, ext, devCount), { domain, isReseller, emailNotRequired }, rtConfig);
  return { activatable: e.activatable, tier: e.tier, reasons: e.reasons, devs, nsUser };
}

/**
 * The app-access sign-in projection for one user — SHARED by /me/app-access (self, record from `~`) and
 * /rapp/user (admin, record = the target user). One implementation so self + admin cannot drift.
 * `record === null` means the NS self/user read failed ⇒ fail-closed to `unavailable` on the SSO path.
 */
async function computeAppAccessProjection(
  client: NsClient, ext: string, domain: string, record: Record<string, unknown> | null,
  env: Env, isReseller: boolean, cache: Cache,
): Promise<{ present: boolean; mode: AppAccessMode; username?: string; appDomain?: string; hPIE?: boolean; downloads: DownloadLink[]; hide: string[]; label: string }> {
  const rec = record ?? {};
  const hide = parseHideList(env, domain);
  const downloads = parseDownloads(env);
  const label = (env.RINGOTEL_LABEL ?? '').trim() || 'Ringotel';

  const org = await orgStatusForDomain(domain, env, cache);
  if (!org.active) return { present: false, mode: 'unavailable', downloads: [], hide, label };

  const s = await computeUserStatus(domain, ext, env, cache);
  const st = (s.status ?? {}) as { activated?: boolean; username?: string };

  const ssoActive = ssoEnabled(org.ssoService, env);
  const elig = ssoActive
    ? await evaluateEligibilityForExt(client, domain, ext, env, isReseller, true) // emailNotRequired on SSO
    : null;
  const eligibilityAttempted = ssoActive;
  if (ssoActive && (record === null || (eligibilityAttempted && elig === null))) {
    return { present: true, mode: 'unavailable', downloads, hide, label };
  }

  const decision = resolveAppAccess({
    orgActive: true,
    ssoService: org.ssoService,
    accountStatus: str(rec['account-status']),
    userScope: str(rec['user-scope']),
    eligible: elig?.activatable ?? false,
    hardExcluded: elig?.tier === 'hard',
    activated: st.activated ?? false,
    autoActivate: autoActivates(domain, env),
    loginUsername: str(rec['login-username']), // VERBATIM — never assembled as `${ext}@${domain}`
    sipUsername: st.username,
  }, env);

  const usableMode = decision.mode === 'sso' || decision.mode === 'password';
  return {
    present: true,
    mode: decision.mode,
    ...(usableMode && org.appDomain ? { appDomain: org.appDomain } : {}),
    ...(decision.username ? { username: decision.username } : {}),
    // Whether the credentials email carries the password itself or hides it behind a one-time link is a
    // per-org setting we can now read, so the password instruction states the user's ACTUAL case instead
    // of hedging across both. Only meaningful on the password path; absent ⇒ the client keeps hedging.
    // Terse on purpose — this is serialized to the browser (see OrgStatusResponse.hPIE).
    ...(decision.mode === 'password' && typeof org.hPIE === 'boolean' ? { hPIE: org.hPIE } : {}),
    downloads, hide, label,
  };
}


/** Default ON: only an explicit falsy value keeps the old reuse-the-stored-password behaviour. */
function rotateSipOnActivate(env: Env): boolean {
  return !/^(0|false|no|off)$/i.test((env.RINGOTEL_ROTATE_SIP_ON_ACTIVATE ?? '').trim());
}

/**
 * Resolve the ONE connection a write must act on.
 *
 * `mayCreate` is the whole distinction. An operation on an existing record can find its connection —
 * the record is the answer. An operation that CREATES one cannot: on a multi-connection domain nothing
 * here knows which connection a new user belongs to, and picking the first would silently provision
 * people onto the wrong one. That decision is the configured default connection, which is Half B; until
 * it exists, creation on such a domain refuses rather than guesses.
 */
function resolveWriteConnection(
  org: OrgResolution & { users?: User[] },
  ext: string,
  opts: { mayCreate: boolean },
): { orgid: string; branchid: string } {
  if (org.status === 'none') throw new HttpError(404, 'No app organization is configured for this domain');
  if (org.status === 'ambiguous') throw new HttpError(409, 'App organization binding is ambiguous for this domain');
  if (org.status === 'active') {
    // SINGLE CONNECTION — must behave exactly as it did before this feature existed, message included.
    // The reset routes carried their own existence check and 404; folding it in here keeps their
    // response byte-identical instead of quietly rewording it.
    //
    // `buildExtIndex`, NOT `locateConnection`: the two disagree on a record whose `branchid` is ABSENT.
    // buildExtIndex accepts it (the API does return such records, and excluding them would hide a live
    // user); locateConnection requires a match against the bound set. Using the latter here would 404
    // a working user on a single-connection domain — the exact kind of silent change this constraint
    // exists to prevent.
    if (!opts.mayCreate && !buildExtIndex(org.users ?? [], org.entry.branchid).get(ext)) {
      throw new HttpError(404, 'No app user to reset for this extension');
    }
    return { orgid: org.entry.orgid, branchid: org.entry.branchid };
  }

  const at = locateConnection((org.users ?? []) as never[], org.branches.map((b) => b.branchid), ext);
  if (at.kind === 'one') return { orgid: org.orgid, branchid: at.branchid };
  if (at.kind === 'conflict') {
    throw new HttpError(409, `Extension ${ext} exists on more than one app connection — resolve the duplicate before changing it`);
  }
  if (opts.mayCreate) {
    throw new HttpError(409, 'This domain has more than one app connection and no default is configured — create the user on the intended connection first');
  }
  throw new HttpError(404, 'No app user to reset for this extension');
}

/**
 * Build the pre-population plan for a domain: read the NetSapiens users, read the Ringotel branch, and
 * decide which users lack a directory entry. Shared by preview and apply so the two cannot disagree —
 * apply re-plans rather than trusting anything the client sends back.
 */
async function buildPrepopPlan(client: NsClient, env: Env, cache: Cache, domain: string, isReseller: boolean) {
  const org = await resolveForWrite(env, cache, domain);
  if (org.status === 'none') throw new HttpError(404, 'No app organization is configured for this domain');
  if (org.status === 'ambiguous') throw new HttpError(409, 'App organization binding is ambiguous for this domain');
  if (org.status === 'multi') {
    // Bulk pre-population creates many records at once; on a multi-connection domain there is no basis
    // to choose a connection for any of them. Half B's default connection is what unblocks this.
    throw new HttpError(409, 'This domain has more than one app connection — bulk pre-population needs a default connection');
  }

  const raw = await client.get(`/domains/${encPath(domain)}/users`);
  const nsUsers = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const rtConfig = resolveRingotelConfig(env);

  const inputs: PrepopInput[] = nsUsers.map((u) => {
    const ext = str(u['user'] ?? u['extension']);
    // Drop the device count rather than fabricate one. Counting devices would be one extra API call PER
    // USER across a whole domain; a wrong count is worse than an absent one, because `excludeNoDevices`
    // tightens name matching only when the count is exactly 0.
    const { deviceCount: _dropped, ...elig } = nsUserToElig(u, ext, 0);
    const email = firstEmail(u);
    return { ext, name: nsDisplayName(u), elig, ...(email !== undefined ? { email } : {}) };
  });

  const plan = planDirectoryPrepop(inputs, org.users ?? [], {
    domain,
    branchid: org.entry.branchid,
    suffix: rtConfig.suffix,
    isReseller,
    config: rtConfig,
    includeSoft: /^(1|true|yes|on)$/i.test((env.RINGOTEL_PREPOP_INCLUDE_SOFT ?? '').trim()),
  });
  return { plan, org };
}


// ── NetSapiens event subscriptions ────────────────────────────────────────────────────────────────────
// The receiver is an UNAUTHENTICATED inbound write path, so it is gated by config alone (`requireFeature`
// would fail OPEN here — it returns, rather than throws, when there is no principal). Verification lives
// in nsEvents.ts; this is the wiring plus the "re-read NetSapiens, then sync" step.

/** Cap on a single delivery. Generous — NS batches a few seconds of changes, not a backlog. */
const NS_EVENT_MAX_BYTES = 1_000_000;

/**
 * Read one NS user for an event, distinguishing the three outcomes that matter.
 *
 * The original code collapsed 404 and transient failure into one `null`, which is correct for identity
 * sync (both mean "do nothing") and **fatal for offboarding**: a 404 is the authorisation to deactivate,
 * and a 500 or a timeout must never be mistaken for one. `NsClient` throws `NsApiError` carrying
 * `.status`, so the split is exact rather than inferred from a message.
 */
export type NsUserReadResult =
  | { kind: 'ok'; rec: Record<string, unknown> }
  | { kind: 'gone' }
  | { kind: 'failed'; status?: number };

export async function readNsUser(
  client: Pick<NsClient, 'get'>,
  domain: string,
  ext: string,
): Promise<NsUserReadResult> {
  try {
    const rec = (await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}`)) as Record<string, unknown> | null;
    // A 200 carrying nothing is not a deletion — NS answered, so absence here is a shape surprise, not
    // evidence. Treat it as a failed read so it can never authorise a deactivation.
    if (!rec || typeof rec !== 'object') return { kind: 'failed' };
    return { kind: 'ok', rec };
  } catch (e) {
    const status = e instanceof NsApiError ? e.status : undefined;
    if (status === 404) return { kind: 'gone' };
    return { kind: 'failed', ...(status !== undefined ? { status } : {}) };
  }
}

/**
 * The ONE authorisation rule both offboarding tiers now share (fix-wave F1, 2026-07-31): a candidate may
 * be deactivated only when the confirming re-read reports the NetSapiens user is truly gone — a 404.
 *
 * `ok` means the candidate still exists: whatever produced it (a stale cache, a truncated or filtered
 * `/users` listing) was wrong, and the safe response is to refuse and log it loudly — that refusal is
 * itself the strongest available signal that the list read was bad. `failed` means the read didn't
 * resolve either way and must never be mistaken for a deletion. Pulled out as a pure predicate so the
 * decision is unit-testable without a network (see `runOrphanSweep`, which is I/O-bound and consumes it).
 */
export function authorisesDeactivation(read: NsUserReadResult): boolean {
  return read.kind === 'gone';
}

/**
 * Whether this batch is about to lose real work to a missing Ringotel key (diagnosability fix, 2026-07-31,
 * replacing the reverted F3 — see `parseNsEventsConfig`'s doc comment). Pulled out as a pure predicate for
 * the same reason as `nsEventLimitDecision`/`authorisesDeactivation` above: testable without the network
 * calls `processNsEventUsers` makes.
 *
 * `NS_EVENTS=on` may legally arm with no Ringotel key — a future non-Ringotel handler is legal, and that is
 * a design decision, not an oversight. But every handler wired in TODAY (identity sync, offboard, device
 * repair) writes through Ringotel via `makeWriteClient`, so an armed batch with no key is about to fail on
 * every user in it. `userCount === 0` means there is nothing about to fail, so nothing to warn about.
 */
export function nsEventsMissingRingotelKey(env: Pick<Env, 'RINGOTEL_API_KEY'>, userCount: number): boolean {
  return userCount > 0 && !(env.RINGOTEL_API_KEY ?? '').trim();
}

/**
 * Apply one batch, after the response has already been sent. Each user is re-read from NetSapiens and
 * synced from THAT record; nothing in the payload is trusted (see nsEvents.ts). One failure never stops
 * the rest of the batch.
 *
 * Exported (not test-only-aliased) for the same reason `resolveCanonical` is: it is a coherent unit —
 * "handle a batch of user-change events" — worth naming and testing directly, not just reachable through
 * `handleNsEvent`'s HTTP path (whose `ctx.waitUntil` fires-and-forgets this in production, and is a
 * no-op stub in the offline selftest, so calling it directly is the only deterministic way to await it).
 */
export async function processNsEventUsers(env: Env, cfg: NsEventsConfig, users: { domain: string; ext: string }[]): Promise<void> {
  if (!users.length || !cfg.identity) return;
  // Loud, ONCE per invocation (this function runs once per receiver POST — see handleNsEvent) rather than
  // a per-user line, which would just be a second flood alongside 'ns-event sync failed' below. Names the
  // missing var explicitly so an operator isn't left inferring it from an opaque write-client failure.
  const keyMissing = nsEventsMissingRingotelKey(env, users.length);
  if (keyMissing) {
    console.error(JSON.stringify({
      msg: 'ns-events armed without RINGOTEL_API_KEY',
      detail: 'Ringotel-writing handlers (identity sync, offboard, device repair) will fail for every user in this batch until RINGOTEL_API_KEY is set',
      users: users.length,
    }));
  }
  const token = await getServiceToken(cfg.identity, env);
  const client = new NsClient({ server: assertBareServer(env.NS_SERVER), token });
  const nsWrite = new NsWriteClient({ server: assertBareServer(env.NS_SERVER), token });
  const cache = caches.default;
  const rtConfig = resolveRingotelConfig(env);

  for (const u of users) {
    try {
      // Three outcomes, deliberately NOT collapsed. `gone` is the only one that may ever authorise a
      // deactivation (Task 4); `failed` must never be mistaken for it. Both still skip identity sync,
      // because inferring "the address was removed" from a read that did not succeed would violate the
      // three-state contract.
      const read = await readNsUser(client, u.domain, u.ext);
      if (read.kind !== 'ok') {
        // A 404 is the ONLY read outcome that may authorise a deactivation. `failed` never does — a
        // transient NS error mistaken for a deletion would offboard a live user.
        if (read.kind === 'gone' && cfg.offboard === 'deactivate') {
          const org = await resolveForWrite(env, cache, u.domain);
          const branches = connectionsOf(org);
          if (!branches.length) {
            console.log(JSON.stringify({ msg: 'ns-event offboard skip', domain: u.domain, ext: u.ext, reason: `org-${org.status}` }));
            continue;
          }
          const orgid = orgidOf(org)!; // guarded above: branches.length > 0 ⇒ status is active/multi
          const at = locateConnection((org.users ?? []) as never[], branches.map((b) => b.branchid), u.ext);
          if (at.kind !== 'one') {
            // 'none' is ordinary (no app record for this extension); 'conflict' is a real problem we
            // surface rather than guess our way through.
            console.log(JSON.stringify({
              msg: 'ns-event offboard skip', domain: u.domain, ext: u.ext,
              reason: at.kind === 'none' ? 'no-app-record' : 'connection-conflict',
              ...(at.kind === 'conflict' ? { branchids: at.branchids } : {}),
            }));
            continue;
          }
          const off = await deactivateAppOnly({
            nsWrite, rtWrite: makeWriteClient(env),
            users: org.users ?? [],
            orgid, branchid: at.branchid,
            domain: u.domain, ext: u.ext, suffix: rtConfig.suffix,
          });
          if (off.action === 'deactivated') await invalidateOrgUsers(cache, scopeOf(env), orgid);
          console.log(JSON.stringify({ msg: 'ns-event offboard', domain: u.domain, ext: u.ext, action: off.action, rtUserIds: off.rtUserIds }));
          continue;
        }
        console.log(JSON.stringify({
          msg: 'ns-event skip', domain: u.domain, ext: u.ext,
          reason: read.kind === 'gone' ? 'ns-404' : 'ns-read-failed',
          ...(read.kind === 'failed' && read.status !== undefined ? { status: read.status } : {}),
        }));
        continue;
      }
      const rec = read.rec;
      const org = await resolveForWrite(env, cache, u.domain);
      const branches = connectionsOf(org);
      if (!branches.length) {
        console.log(JSON.stringify({ msg: 'ns-event skip', domain: u.domain, ext: u.ext, reason: `org-${org.status}` }));
        continue;
      }
      const orgid = orgidOf(org)!; // guarded above: branches.length > 0 ⇒ status is active/multi
      const branchids = branches.map((b) => b.branchid);
      const syncAt = locateConnection((org.users ?? []) as never[], branchids, u.ext);
      if (syncAt.kind !== 'one') {
        // 'none' is ordinary (no app record for this extension); 'conflict' is a real problem we
        // surface rather than guess our way through.
        console.log(JSON.stringify({
          msg: 'ns-event skip', domain: u.domain, ext: u.ext,
          reason: syncAt.kind === 'none' ? 'no-app-record' : 'connection-conflict',
          ...(syncAt.kind === 'conflict' ? { branchids: syncAt.branchids } : {}),
        }));
        continue;
      }
      const res = await syncIdentity({
        nsWrite,
        rtWrite: makeWriteClient(env),
        users: org.users ?? [],
        orgid,
        branchid: syncAt.branchid,
        domain: u.domain,
        ext: u.ext,
        suffix: rtConfig.suffix,
        name: nsDisplayName(rec),
        // No principal ⇒ not a masqueraded read ⇒ a successful read with no address is a REAL removal.
        email: emailForWrite(rec, u.ext, undefined),
      });
      if (res.action === 'synced') await invalidateOrgUsers(cache, scopeOf(env), orgid);
      // `flattenedEmails` is present only when the write destroyed extra addresses the user had entered in
      // the app — irreversible, and invisible from their side. It rides the normal sync line rather than a
      // separate warning so the count sits next to the `changed: ['email']` that caused it.
      console.log(JSON.stringify({
        msg: 'ns-event sync', domain: u.domain, ext: u.ext, action: res.action, changed: res.changed,
        ...(res.flattenedEmails ? { flattenedEmails: res.flattenedEmails } : {}),
      }));

      if (cfg.deviceRepair !== 'off') {
        // Its own try/catch: a device problem must never lose the identity sync that already succeeded,
        // and resolveCanonical can throw 409 on a genuine SIP-identity tie.
        try {
          // Same connection lookup as `syncAt` above (identical `org.users`/`branchids`/`u.ext`), reused
          // rather than recomputed — and `syncAt` is already proven 'one' by this point (the code above
          // `continue`s on anything else), so there is no separate 'none'/'conflict' case left to handle
          // here. If that ever stops being true — e.g. this block moves above the `syncAt.kind` check, or
          // starts using a different lookup — `syncAt.branchid` fails to compile, which forces a real
          // decision about what device-repair-specific skip message belongs here, rather than silently
          // reusing three-release-old log semantics.
          const rep = await repairDeviceForEvent({
            nsWrite, rtWrite: makeWriteClient(env),
            users: org.users ?? [],
            orgid, branchid: syncAt.branchid,
            domain: u.domain, ext: u.ext, suffix: rtConfig.suffix,
            mode: cfg.deviceRepair,
          });
          if (rep.action === 'repaired') await invalidateOrgUsers(cache, scopeOf(env), orgid);
          if (rep.changed.length) {
            console.log(JSON.stringify({ msg: 'ns-event device', domain: u.domain, ext: u.ext, action: rep.action, changed: rep.changed }));
          }
        } catch (e) {
          console.error(JSON.stringify({
            msg: 'ns-event device repair failed', domain: u.domain, ext: u.ext,
            error: String((e as Error)?.message ?? e).slice(0, 200),
            ...(keyMissing ? { cause: 'RINGOTEL_API_KEY is not set' } : {}),
          }));
        }
      }
    } catch (e) {
      // Includes the deliberate 409 when an extension has a genuine SIP-identity tie — log and move on.
      // `cause` names the missing key (fix-wave F3 revert, 2026-07-31) so an operator reading ONE of these
      // lines sees why, instead of whatever opaque throw the Ringotel write client produced with no token.
      console.error(JSON.stringify({
        msg: 'ns-event sync failed', domain: u.domain, ext: u.ext,
        error: String((e as Error)?.message ?? e).slice(0, 200),
        ...(keyMissing ? { cause: 'RINGOTEL_API_KEY is not set' } : {}),
      }));
    }
  }
}

/**
 * The event receiver's rate-limit / verification decision, pulled out as a pure function so the priority
 * is unit-testable without a Request (fix-wave F4, 2026-07-31).
 *
 * The limiter is counted before verification regardless — an unverified request still costs an HMAC and a
 * log line, so the budget has to cover the traffic an attacker actually controls. But the RESPONSE depends
 * on verification too: a 429 counts as a delivery error to NetSapiens and can flip the subscription to
 * `error`, disabling it — the exact hazard already avoided for oversized and unparseable bodies. NetSapiens
 * delivers from a small, stable set of node IPs, so a genuine bulk change (a CSV import, a mass edit) is
 * exactly the traffic shape that can trip the limiter; only a request that FAILS verification is traffic an
 * attacker actually controls, and 429 is safe only for that case.
 */
export type NsEventLimitDecision = 'proceed' | 'accept-drop' | 'reject-429' | 'reject-404';
export function nsEventLimitDecision(verified: boolean, overLimit: boolean): NsEventLimitDecision {
  if (!verified) return overLimit ? 'reject-429' : 'reject-404';
  return overLimit ? 'accept-drop' : 'proceed';
}

/** The inbound receiver. Always answers fast; NS counts anything above 302 as a delivery error. */
async function handleNsEvent(request: Request, env: Env, cfg: NsEventsConfig, ctx: ExecutionContext, cors: Record<string, string>): Promise<Response> {
  const ip = clientIp(request);
  // Counted before verification on purpose (see nsEventLimitDecision above) — captured once so the same
  // request is never counted twice against the bucket.
  const overLimit = inIsolateOverLimit(`nsev:${ip}`, Date.now());
  const verdict = await verifyEventRequest(request, cfg, ip);
  const decision = nsEventLimitDecision(verdict.ok, overLimit);

  if (decision === 'reject-404') {
    console.warn(JSON.stringify({ msg: 'ns-event refused', reason: verdict.reason, ip }));
    // Opaque body, and deliberately IDENTICAL to the not-armed 404 below — otherwise the pair of
    // responses tells an unauthenticated caller whether the feature is switched on for this deployment.
    return json({ error: 'Not found' }, 404, cors);
  }
  if (decision === 'reject-429') {
    console.warn(JSON.stringify({ msg: 'ns-event rate limited', ip, reason: verdict.reason }));
    return json({ error: 'Not found' }, 429, cors);
  }
  if (decision === 'accept-drop') {
    // Verified — a genuine NetSapiens delivery — but over the in-isolate budget. Accept-and-drop rather
    // than 429, same reasoning as the oversized/unparseable cases below: never hand NetSapiens a delivery
    // error that can disable the subscription. Loud in the log instead.
    console.error(JSON.stringify({ msg: 'ns-event rate limited, dropped', ip, domain: verdict.domain }));
    return json({ ok: true }, 200, cors);
  }
  const raw = await request.text();
  if (raw.length > NS_EVENT_MAX_BYTES) {
    // Accept-and-drop rather than reject: a 413 to a genuine delivery raises error-count and can flip the
    // subscription to `error`, disabling it. Loud in the log instead.
    console.error(JSON.stringify({ msg: 'ns-event oversized, dropped', bytes: raw.length, domain: verdict.domain }));
    return json({ ok: true }, 200, cors);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    console.error(JSON.stringify({ msg: 'ns-event unparseable body', bytes: raw.length, domain: verdict.domain }));
    return json({ ok: true }, 200, cors);
  }
  if (cfg.diagRaw) console.log(JSON.stringify({ diag: 'ns-event-raw', domain: verdict.domain, ...diagShape(body, request) }));

  const decoded = decodeEventBatch(body, verdict.domain!, cfg.maxEvents);
  console.log(JSON.stringify({
    msg: 'ns-event', domain: verdict.domain, correlationId: verdict.correlationId, sourceIp: ip,
    total: decoded.total, users: decoded.users.length, truncated: decoded.truncated,
    unidentified: decoded.unidentified, domainMismatch: decoded.domainMismatch, domainAbsent: decoded.domainAbsent,
  }));

  ctx.waitUntil(
    processNsEventUsers(env, cfg, decoded.users).catch((e) =>
      console.error(JSON.stringify({ msg: 'ns-event batch failed', error: String((e as Error)?.message ?? e).slice(0, 200) })),
    ),
  );
  return json({ ok: true }, 200, cors);
}

/**
 * Delete every subscription this deployment owns, and plan nothing else.
 *
 * Runs when the feature is inert but still holds the callback origin and the service identity. Two
 * inherent limits, documented in SETUP rather than pretended away: removing the credentials at the same
 * time leaves nothing able to clean up (hence the retirement order — empty NS_EVENTS_DOMAINS, let one
 * reconcile run, verify, *then* remove the secrets), and changing NS_EVENTS_BASE_URL orphans the old
 * subscriptions because the prefix is what marks them as ours.
 */
async function runInertCleanup(env: Env, cfg: NsEventsConfig): Promise<void> {
  const token = await getServiceToken(cfg.identity!, env);
  const subs = new NsSubscriptionsClient({ server: assertBareServer(env.NS_SERVER), token });

  let actual;
  try {
    actual = await subs.list();
  } catch (e) {
    // Same rule as the reconcile: with no local registry the listing IS the source of truth, so a failed
    // read must abort rather than be read as "nothing to clean up".
    console.error(JSON.stringify({ msg: 'ns-events inert cleanup ABORTED', reason: 'subscription list failed', error: String((e as Error)?.message ?? e).slice(0, 200) }));
    return;
  }
  const plan = planInertCleanup(actual, ownedPrefix(cfg));
  if (!plan.length) {
    console.log(JSON.stringify({ msg: 'ns-events inert cleanup', reason: cfg.inertReason ?? 'not-armed', ours: 0 }));
    return;
  }
  const res = await applySubscriptionPlan(subs, plan, cfg, Date.now());
  console.log(JSON.stringify({ msg: 'ns-events inert cleanup', reason: cfg.inertReason ?? 'not-armed', ours: plan.length, applied: res.applied, failed: res.failed, actions: res.logs }));
}

/**
 * Cron: make the live subscriptions match what config says they should be.
 *
 * NetSapiens is the registry (there is no local store), so a failed listing ABORTS the run — degrading to
 * "nothing exists" would mass-create duplicates.
 */
async function runNsEventsReconcile(env: Env): Promise<void> {
  const cfg = parseNsEventsConfig(env);
  if (!cfg.armed) {
    // Going inert used to STRAND our subscriptions: NetSapiens kept delivering to a route that now 404s,
    // error-count climbed, and the subscription eventually flipped to `error` — an orphan nobody owned.
    // When the callback origin and the service identity are still present we know which subscriptions are
    // ours (the prefix IS the ownership marker) and have the right to remove them, so clean up after
    // ourselves. No new configuration: those two values are exactly the precondition.
    if (cfg.baseUrl && cfg.pathSecret && cfg.identity) {
      await runInertCleanup(env, cfg);
      return;
    }
    console.log(JSON.stringify({ msg: 'ns-events reconcile skipped', reason: cfg.inertReason ?? 'not-armed' }));
    return;
  }
  if (!cfg.identity) {
    console.log(JSON.stringify({ msg: 'ns-events reconcile skipped', reason: 'no service identity' }));
    return;
  }
  const token = await getServiceToken(cfg.identity, env);
  const subs = new NsSubscriptionsClient({ server: assertBareServer(env.NS_SERVER), token });

  // `*` needs a concrete list: a Reseller-scoped credential cannot create a domain:'*' subscription, and
  // a domain with no Ringotel org has nothing to sync anyway.
  const discovered = cfg.domains === '*' ? await ringotelDomains(env, caches.default) : [];
  const desired = await desiredSubscriptions(cfg, discovered);

  let actual;
  try {
    actual = await subs.list();
  } catch (e) {
    console.error(JSON.stringify({ msg: 'ns-events reconcile ABORTED', reason: 'subscription list failed', error: String((e as Error)?.message ?? e).slice(0, 200) }));
    return;
  }
  const mine = actual.filter((x) => (x.postUrl ?? '').startsWith(ownedPrefix(cfg)));
  console.log(JSON.stringify({ msg: 'ns-events reconcile', desired: desired.length, total: actual.length, ours: mine.length, health: mine.map(healthLine) }));

  const plan = planSubscriptions(desired, actual, Date.now(), {
    ownedPrefix: ownedPrefix(cfg),
    renewHorizonSeconds: cfg.renewHorizonSeconds,
    targetLifetimeSeconds: cfg.targetLifetimeSeconds,
  });
  const res = await applySubscriptionPlan(subs, plan, cfg, Date.now());
  console.log(JSON.stringify({ msg: 'ns-events reconciled', applied: res.applied, failed: res.failed, actions: res.logs }));
}

/** Deactivate one connection's confirmed orphans. Lifted out of `runOrphanSweep` when the sweep became
 *  per-connection — the 404-only authorisation rule and its reasoning are exactly as they were. */
async function deactivateOrphans(a: {
  env: Env; cache: Cache; client: NsClient; nsWrite: NsWriteClient;
  domain: string; branchid: string; orgid: string;
  users: User[]; plan: Extract<SweepPlan, { status: 'ok' }>; suffix: string; nsUsers: number;
}): Promise<void> {
  const { env, cache, client, nsWrite, domain, branchid, orgid, users, plan, suffix, nsUsers } = a;
  let deactivated = 0;
  for (const o of plan.orphans) {
    try {
      // Confirm the LIST-derived candidate against NetSapiens itself before writing anything — the
      // SAME 404-only authorisation rule the event tier already uses (readNsUser / authorisesDeactivation
      // above), so a truncated or partially-filtered `/users` response can only ever waste this one
      // extra read, never manufacture a deactivation. Costs nothing at steady state: no orphans means
      // no confirm reads.
      const read = await readNsUser(client, domain, o.ext);
      if (!authorisesDeactivation(read)) {
        if (read.kind === 'ok') {
          // Loud and distinct on purpose: this IS direct evidence the NS list read was wrong —
          // truncated, filtered, or otherwise incomplete — which is far more valuable than the count
          // logging it replaces (see Task 11).
          console.error(JSON.stringify({ msg: 'ns-events sweep candidate still exists', domain, branchid, ext: o.ext }));
        } else if (read.kind === 'failed') {
          console.error(JSON.stringify({
            msg: 'ns-events sweep confirm failed', domain, branchid, ext: o.ext,
            ...(read.status !== undefined ? { status: read.status } : {}),
          }));
        }
        continue;
      }
      const res = await deactivateAppOnly({
        nsWrite, rtWrite: makeWriteClient(env),
        users,
        orgid, branchid,
        domain, ext: o.ext, suffix,
      });
      if (res.action === 'deactivated') deactivated++;
    } catch (e) {
      console.error(JSON.stringify({ msg: 'ns-events sweep deactivate failed', domain, branchid, ext: o.ext, error: String((e as Error)?.message ?? e).slice(0, 200) }));
    }
  }
  if (deactivated) await invalidateOrgUsers(cache, scopeOf(env), orgid);
  // `nsUsers` is DOMAIN-wide while this line is per-connection — deliberately kept anyway, and on the
  // same key it has always used. It was added as a truncation diagnostic: comparing the returned NS
  // user count against the domain's known total is how a silently truncated (unpaged) `/users` read
  // gets caught, and the line that fires when orphans WERE found is exactly where you want to sanity-
  // check it. Dropping it here would have removed the diagnostic from the only case that matters.
  console.log(JSON.stringify({ msg: 'ns-events sweep', domain, branchid, nsUsers, scanned: plan.scanned, orphans: plan.orphans.length, deactivated, exts: plan.orphans.map((o) => o.ext) }));
}

/**
 * Cron: deactivate app records whose NetSapiens user no longer exists.
 *
 * The correctness half of offboarding. The event tier is faster but at-least-once, so a missed delete
 * would be permanent drift — and no event can clean up an orphan that predates the feature. This
 * converges regardless.
 *
 * Domains are isolated: one domain's failure never stops the rest, and each aborts independently on a
 * bad NS read (see `planOrphanSweep`).
 */
async function runOrphanSweep(env: Env): Promise<void> {
  const cfg = parseNsEventsConfig(env);
  if (!cfg.armed || !cfg.identity || cfg.offboard !== 'deactivate') {
    console.log(JSON.stringify({ msg: 'ns-events sweep skipped', reason: cfg.armed ? `offboard-${cfg.offboard}` : (cfg.inertReason ?? 'not-armed') }));
    return;
  }
  const token = await getServiceToken(cfg.identity, env);
  const client = new NsClient({ server: assertBareServer(env.NS_SERVER), token });
  const nsWrite = new NsWriteClient({ server: assertBareServer(env.NS_SERVER), token });
  const cache = caches.default;
  const rtConfig = resolveRingotelConfig(env);

  // sweepScope is the SAME composition desiredSubscriptions uses for its '*'-scoped reconcile — one
  // exported helper, not two hand-kept copies. See its doc comment in nsEvents.ts for why both the
  // grammar check and the write-rail check are required.
  const scope = cfg.domains === '*' ? sweepScope(cfg, await ringotelDomains(env, cache)) : cfg.domains;

  for (const domain of scope) {
    try {
      // Ringotel read comes FIRST, NetSapiens read SECOND — deliberately. A just-in-time-activated user
      // (portal activate route, or the SSO Worker's own JIT provisioning) can land in Ringotel between
      // these two reads; reading NS second means a race can only make the NS list MORE complete, never
      // less, so it can never manufacture a false orphan. Reading NS first (the original order) let a
      // user provisioned mid-sweep be present in Ringotel but missing from the (now stale) NS list,
      // i.e. a live user losing phone service. This also skips the NS user-list call entirely for a
      // domain whose org isn't resolvable/active, which is otherwise a wasted request every cycle.
      const org = await resolveForWrite(env, cache, domain);
      const branches = connectionsOf(org);
      if (!branches.length) {
        console.log(JSON.stringify({ msg: 'ns-events sweep skip', domain, reason: `org-${org.status}` }));
        continue;
      }
      const orgid = orgidOf(org)!; // guarded above: branches.length > 0 ⇒ status is active/multi

      // null on ANY read failure — planDomainSweep refuses to act on it. Never degrade to [].
      const nsExtensions = await client
        .get(`/domains/${encPath(domain)}/users`)
        .then((raw) => (Array.isArray(raw) ? (raw as Record<string, unknown>[]).map((u) => str(u['user'] ?? u['extension'])).filter(Boolean) : null))
        .catch(() => null);

      // ONE budget for the whole domain — see planDomainSweep.
      const perConnection = planDomainSweep({
        nsExtensions,
        rtUsers: org.users ?? [],
        branchids: branches.map((b) => b.branchid),
        max: cfg.sweepMax,
      });

      for (const { branchid, plan } of perConnection) {
        if (plan.status === 'abort') {
          console.error(JSON.stringify({ msg: 'ns-events sweep ABORTED', domain, branchid, reason: plan.reason }));
          continue;
        }
        if (plan.truncated) {
          // Loud on purpose: a silently truncated sweep reads as "everything is clean".
          console.warn(JSON.stringify({ msg: 'ns-events sweep truncated', domain, branchid, cap: cfg.sweepMax }));
        }
        if (!plan.orphans.length) {
          console.log(JSON.stringify({ msg: 'ns-events sweep', domain, branchid, nsUsers: nsExtensions?.length ?? 0, scanned: plan.scanned, orphans: 0 }));
          continue;
        }
        await deactivateOrphans({ env, cache, client, nsWrite, domain, branchid, orgid, users: org.users ?? [], plan, suffix: rtConfig.suffix, nsUsers: nsExtensions?.length ?? 0 });
      }
    } catch (e) {
      console.error(JSON.stringify({ msg: 'ns-events sweep domain failed', domain, error: String((e as Error)?.message ?? e).slice(0, 200) }));
    }
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
    // `scope` is the cache namespace (CACHE_SCOPE, or "default" when unset). It is here to be CHECKABLE:
    // one deployment missing the var degrades safely to its own distinct namespace, but TWO missing it
    // both land on "default" and silently re-merge their caches — the original bug, reborn with no
    // signal. Comparing this field across deployments is the cheapest way to catch that. It is a config
    // label, not a secret: same disclosure class as `version`, which is already here.
    if (url.pathname === '/health') return json({ ok: true, configured: !needsSetup(env), version: VERSION, scope: scopeOf(env) }, 200, cors);

    // ── Group 1: gates that must hold before ANY route, including the console ──────────────────────
    // featuresConfigError CANNOT be demoted to Group 2. resolveFeaturePolicies() IS the authorization
    // the console is gated on; if PORTAL_FEATURES or PORTAL_SUPERADMINS is malformed it throws, and a
    // Worker that cannot evaluate can('kit.status', …) does not know who may see this page. Serving the
    // configuration document in that state is the fail-open shape this repo has been bitten by before.
    // The 500 already carries an actionable reason — the same thing the console would have told them.
    const featErr = featuresConfigError(env);
    if (featErr) return json({ error: 'Server misconfigured', reason: featErr }, 500, cors);

    // The effective feature policies for THIS request: registry defaults ⊕ PORTAL_FEATURES overrides,
    // each gate resolved through the level vocabulary + the superadmin union. Computed once per fetch
    // (cheap, pure) and threaded to every gate below — never memoized in module scope (avoids stale
    // config across deploys). Safe here: featuresConfigError above already proved it won't throw. Moved
    // ahead of Group 2 (was previously computed right before the Access gate) because the console's own
    // auth chain, immediately below, needs it before any Group 2 gate has run.
    const policies = resolveFeaturePolicies(env);

    // ── The operator console: GET /kit/status (the document) and GET /kit/spk.js (the bundle — bytes
    // ship starting Task 7). Both are gated by the SAME two checks — resolveAuth, the kit.status feature
    // gate, then requireFleetRead — run HERE, ahead of Group 2, so a deployment broken in one of Group
    // 2's five ways still serves the diagnostic document instead of a bare 500 (Task 3's finding:
    // `misconfigured` and `configErrors[]` were unreachable in production before this reorder). Applying
    // the gate to /kit/spk.js now (rather than waiting for Task 7's bundle) means the bytes are refused
    // from day one even if a future edit to the bundle handler forgets to re-check — a judgment call
    // beyond what Task 6's brief spelled out for this route; see the Task 6 report for why. Scoped to
    // exactly these two pathnames: no other route's auth timing changes, and resolveAuth is not called
    // twice for a single request — a match here returns before the normal routing section's own call.
    if ((url.pathname === '/kit/status' || url.pathname === '/kit/spk.js' || url.pathname === '/kit/menus/check'
      || url.pathname === '/kit/menus/resolve')) {
      try {
        const auth = await resolveAuth(request, env, policies);
        if (!auth.principal) throw new HttpError(403, 'The console requires a delegated ns_t');
        // TWO WAYS TO BE HANDED THE CONSOLE BUNDLE, and they are never the same principal at the same
        // moment. `kit.status` is the console proper. `kit.captureMenus` exists only DURING a masquerade
        // — while masking, `sub` is the masked user, so a superadmin stops passing every `users:`-shaped
        // gate including this one, which is correct and stays that way. The capture gate matches on the
        // masquerade itself plus the operator behind it.
        const canConsole = can(auth.principal, 'kit.status', policies);
        const canCapture = url.pathname === '/kit/spk.js' && can(auth.principal, 'kit.captureMenus', policies);
        if (!canConsole && !canCapture) {
          // If nobody at all can reach the console (off, or no superadmin named), say so and name the
          // setting to fix — that's actionable. Otherwise this caller just isn't on a list that does
          // admit others, and the terse message is correct as-is (naming who IS admitted would leak it).
          const lockedReason = kitStatusLockedReason(env);
          // /kit/spk.js is fetched speculatively by EVERY authenticated user on EVERY page load (see
          // primaryJs's fetchInject calls in kit.ts) — a non-superadmin being refused is the steady
          // state, not an incident. A permanently-high 403 rate from normal operation is a worse signal
          // than one that only fires when something is actually broken, so this specific case — the
          // bundle route, refused, and the policy still admits SOMEONE (lockedReason null) — answers
          // quietly: 204, no body, same as if the route didn't exist for this caller. fetchInject only
          // injects on a literal `r.status===200`, so a 204 is skipped exactly as the 403 was; nothing
          // downstream changes. Do NOT extend this to /kit/status: that route is only ever requested by
          // someone who already received the bundle and clicked the menu item, so a denial there means
          // the menu should not have appeared — genuinely actionable, and it must stay loud. Do NOT
          // extend this to a null-`can` reason with lockedReason SET either (misconfiguration — nobody
          // at all can open the console — stays a loud 403 that names the setting to fix.
          // Same header treatment as the 403 it replaces (the catch block below, via `json(..., cors)`):
          // plain `cors` — Access-Control-Allow-* when the Origin matched, Vary: Origin from
          // corsHeaders()'s baseline. Not the wider `Vary: Origin, Authorization` used on the 200
          // bundle/status responses above — those vary the RESPONSE BODY by principal (tiered Cache
          // API entries), and this 204 is never cached, so there is no per-Authorization content to
          // distinguish. A browser must still be able to make the same cross-origin accept/reject call
          // it made on the 403 this replaces, which plain `cors` already guarantees.
          if (url.pathname === '/kit/spk.js' && !lockedReason) {
            return new Response(null, { status: 204, headers: { ...cors } });
          }
          throw new HttpError(403, lockedReason ? `Not authorized: kit.status — ${lockedReason}` : 'Not authorized: kit.status');
        }
        // ⚠️ FLEET READ IS A CONSOLE GATE, NOT A BUNDLE GATE. It exists because the console DOCUMENT
        // reports settings naming other customers' domains, and every scope below Reseller is
        // domain-locked — so a `users:` grant to a domain-locked account must still be refused. A
        // capture-only caller receives none of that: their bundle carries one menu item that reads the
        // labels already rendered on the page in front of them and writes to their own browser. Running
        // the fleet gate on them would refuse the whole feature for exactly the case it is for, since a
        // masqueraded user is domain-locked by construction.
        if (canConsole) requireFleetRead(auth.principal, env);
        if (url.pathname === '/kit/spk.js') {
          // Both gates above already ran (kit.status + requireFleetRead) — this is the tier-cached bundle
          // response, same shape as /kit/portal.js and /kit/self.js below. Its own tier namespace (`spk`)
          // keeps it from colliding with those caches even when the allowed-key sets happen to hash equal.
          const spkKeys = spkFeaturePolicyKeys().filter((k) => can(auth.principal!, k, policies));
          const tierKey = new Request(`https://inject.internal/${url.hostname}/spk/${tierHash(spkKeys)}/${VERSION}`);
          const hit = await caches.default.match(tierKey);
          let bundle: string;
          if (hit) {
            bundle = await hit.text();
          } else {
            bundle = buildSpkBundle(spkKeys, env);
            await caches.default.put(tierKey, new Response(bundle, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=60' } }));
          }
          return new Response(bundle, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...cors, 'Cache-Control': 'private, max-age=120', Vary: 'Origin, Authorization' } });
        }
        // Validate a CANDIDATE PORTAL_MENUS the builder just assembled. It answers only "would this be
        // accepted", touching neither `env` nor any upstream — so it is `read`, not `sensitive`, and skips
        // the fresh-auth round-trip the config document needs. It exists so the builder does not carry a
        // second copy of the validation rules: the https-only scheme, the ban on a {variable} in a URL's
        // authority, the known-variable list. A browser-side copy is a copy that drifts, and the half that
        // drifts would be the one enforcing a phishing guard.
        if (url.pathname === '/kit/menus/check') {
          const candidate = url.searchParams.get('c') ?? '';
          // Bounded so a runaway value cannot turn into an expensive parse. The builder refuses to send
          // more than this too; the limit is repeated here because a route may not trust its caller.
          if (candidate.length > 8192) throw new HttpError(413, 'Candidate config too large to validate');
          // Probed against ONLY the candidate: passing the live env would let a deployment that is already
          // misconfigured report every candidate as broken, which is the opposite of useful while fixing it.
          const error = menuConfigError({ PORTAL_MENUS: candidate });
          // WARNINGS ARE NOT ERRORS, and the distinction is the point: a config whose default can never
          // apply is accepted and deployed, because refusing it in the pre-routing gauntlet is how a
          // cosmetic menu mistake once took the whole injection down. It is told to the operator here,
          // where they are writing it, which is the only place the telling is useful.
          const warnings = error === null ? unreachableDefaults({ PORTAL_MENUS: candidate }) : [];
          return json({ ok: error === null, error, warnings }, 200, { ...cors, "Cache-Control": "no-store" });
        }
        // RESOLVE a candidate config for one audience — what the editor's preview renders from. Same
        // shape and same reasoning as the check route above, one step further on: `check` answers "would
        // this be accepted", this answers "what would it PRODUCE for this person".
        //
        // It exists so the console never re-implements precedence. `resolveTargeted` selects exactly one
        // rung per half (users → domains → scopes → app, then the most specific in-axis `*`, then the
        // whole-object `*`), and a browser-side copy of that is a copy that drifts — the same argument
        // that keeps validation server-side, except the half that drifted would be the one deciding whose
        // menu an operator is looking at. A preview that quietly disagrees with the runtime is worse than
        // no preview: it is a wrong answer delivered with a picture.
        //
        // GET, deliberately. `WRITE_PATHS` is this Worker's whole POST allowlist and everything else is
        // 405, so "non-GET means write" holds by construction; a POST that only computes would be the
        // first exception to it. The 8192-char cap is the price, shared with the check route, and a
        // config past it is already past what the editor can usefully render.
        //
        // ⚠️ MIXED SOURCES, on purpose, and this is the one place in the console where that is right.
        // `PORTAL_MENUS` comes from the CANDIDATE (the whole point). `PORTAL_APPS_HIDE` comes from the
        // LIVE env, because the editor does not edit that setting and the apps hide list is the UNION of
        // the two (`appsHideSources`). Resolving the candidate alone would draw an apps menu missing
        // entries this deployment really hides, and the operator would go looking for a bug in their own
        // config. The check route's "candidate only" rule is the opposite case and stays as it is: there,
        // the live env's own breakage must not be reported against a config being written to fix it.
        if (url.pathname === '/kit/menus/resolve') {
          const candidate = url.searchParams.get('c') ?? '';
          if (candidate.length > 8192) throw new HttpError(413, 'Candidate config too large to resolve');
          const menuEnv = { PORTAL_MENUS: candidate, PORTAL_APPS_HIDE: env.PORTAL_APPS_HIDE };
          // The active SET the preview resolves against — the editor's persona picker sends one `app` per
          // active integration. Multiple values are a legal question now that the axis unions across them;
          // the refusal that used to live here was the union seam, and it is gone with the join.
          //
          // The ASKED-FOR set, never the live one: authoring config for a state a domain is not in yet is
          // most of what the preview is for, and it is why a Documo rung can be written before Documo
          // ships. What the preview does not claim is that any persona's stock menu looks like this — see
          // the observe-and-cache caveat.
          const apps = url.searchParams.getAll('app').flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
          const ctx = {
            domain: (url.searchParams.get('domain') ?? '').trim(),
            app: apps,
            ...(url.searchParams.get('scope') ? { scope: url.searchParams.get('scope')!.trim() } : {}),
            ...(url.searchParams.get('user') ? { user: url.searchParams.get('user')!.trim() } : {}),
          };
          try {
            // WHICH RUNG ANSWERED, per half, reported by the code that chose it. Without this the console
            // would have to re-derive precedence to draw a provenance chip — precedence in a second place,
            // which is the whole reason this endpoint exists. Arrays for the same reason `app` is a list.
            const matched = {} as Record<string, { hide: unknown[]; add: unknown[]; rename: unknown[] }>;
            // AS WRITTEN, beside as resolved. `menuItemAt` interpolates {variable} placeholders and this
            // preview resolves with no user facts, so a plan url is not a config url — an editor matching
            // a drawn row back to its config entry by url fails on exactly the entries that use the
            // feature. Index-aligned with plan.add by construction; see MenuItemPair.
            const rawAdds = {} as Record<string, unknown[]>;
            // Same for renames: `to` and `title` carry {variable} too, so the resolved label is not the
            // configured one, and the console has to be able to show what the operator wrote.
            const rawRenames = {} as Record<string, unknown[]>;
            const plan = resolveMenus(menuEnv, ctx, matched as never, rawAdds as never, rawRenames as never);
            // The apps provenance split rides along: the editor renders a legacy-hidden entry as ticked,
            // disabled and attributed, and it cannot work that out from the effective list alone.
            return json({ ok: true, plan, matched, rawAdds, rawRenames, appsHide: appsHideSources(menuEnv, ctx) }, 200, { ...cors, 'Cache-Control': 'no-store' });
          } catch (e) {
            // A candidate that does not parse is the normal case while typing one, not a server fault —
            // same 200-with-a-verdict shape the check route uses, so the editor has one thing to read.
            return json({ ok: false, error: e instanceof Error ? e.message : 'Could not resolve this config' }, 200, { ...cors, 'Cache-Control': 'no-store' });
          }
        }
        if (needsFreshAuth(ROUTES['/kit/status'].sensitivity)) await requireFreshAuth(auth, env);
        const wantProbes = url.searchParams.get('probe') === '1';
        // Bound the button: probes reach upstream APIs, so spend the same per-IP budget the ns_t live
        // check uses rather than inventing a second limiter.
        if (wantProbes && (await liveCheckRateLimited(request, env))) throw new HttpError(429, 'Too many checks — try again in a minute');
        const probes = wantProbes
          ? await runProbes(env, { server: env.NS_SERVER, token: auth.token ?? null, domain: auth.lockedDomain ?? auth.defaultDomain ?? null })
          : null;
        const doc = buildStatus(env, { principal: auth.principal, hostname: url.hostname, probes });
        // Header order: ours go AFTER ...cors so `Vary: Origin, Authorization` wins over cors's bare
        // `Vary: Origin` — getting this backwards lets a cache serve one principal's bytes to another.
        if (url.searchParams.get('format') === 'json') {
          return new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json; charset=utf-8', ...cors, 'Cache-Control': 'no-store', Vary: 'Origin, Authorization' } });
        }
        return new Response(statusHtml(doc), { headers: { 'content-type': 'text/html; charset=utf-8', ...cors, 'Cache-Control': 'no-store', Vary: 'Origin, Authorization' } });
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message, ...(err.reason ? { reason: err.reason } : {}) }, err.status, cors);
        console.error(JSON.stringify({ msg: 'request failed', path: url.pathname, error: (err as Error).message }));
        return json({ error: 'Request failed' }, 500, cors);
      }
    }

    // ── Group 2: reportable by the console, still fatal for every other route ─────────────────────
    // These five are why the console exists. It is a diagnostic surface, not a licence to run broken:
    // every OTHER route still refuses on them exactly as before.
    // Fail closed + loud on a malformed injection config (portal-mode-only). A bad basename/manifest/
    // handoff is a deploy mistake; 500 with a reason beats a deep throw.
    const kitErr = kitConfigError(env);
    if (kitErr) return json({ error: 'Server misconfigured', reason: kitErr }, 500, cors);

    // Fail closed + loud on a malformed PORTAL_APP_DOWNLOADS / PORTAL_APPS_HIDE (me.appAccess config).
    const appErr = appAccessConfigError(env);
    if (appErr) return json({ error: 'Server misconfigured', reason: appErr }, 500, cors);

    // Fail closed + loud on bad RINGOTEL_* activation config (exclusion matchers, the write-domain rail).
    const menuErr = menuConfigError(env);
    if (menuErr) return json({ error: 'Server misconfigured', reason: menuErr }, 500, cors);
    const rtErr = ringotelConfigError(env);
    if (rtErr) return json({ error: 'Server misconfigured', reason: rtErr }, 500, cors);

    // Fail closed + loud ONLY on an explicit NS_EVENTS=on that cannot be satisfied, or a malformed value.
    // An unconfigured `auto` resolves to inert, NOT an error — these gates run before routing, so treating
    // it as an error would 500 every route the moment the feature ships unconfigured.
    const evErr = nsEventsConfigError(env);
    if (evErr) return json({ error: 'Server misconfigured', reason: evErr }, 500, cors);

    // The NetSapiens event receiver. Placed here deliberately: AFTER the config gates (so it never runs
    // on broken config) and BEFORE the Cloudflare Access gate (which would otherwise reject NetSapiens'
    // POST outright on an Access-protected deployment). Absent entirely when not armed.
    if (url.pathname.startsWith(NS_EVENTS_PREFIX)) {
      const evCfg = parseNsEventsConfig(env);
      if (!evCfg.armed) return json({ error: 'Not found' }, 404, cors);
      return handleNsEvent(request, env, evCfg, _ctx, cors);
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/app')) {
      // This is the backend half of an injected add-on: there is no UI here, and there never was one for
      // a portal deployment. Still 404 — but say why, because someone who just deployed this and opened
      // the URL deserves better than a bare error. Discloses nothing: no config, no names, no data.
      // Deliberately NOT productName(env): BRAND_NAME is a secret, and this page is unauthenticated.
      return new Response(portalModeHtml(), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', ...cors } });
    }
    if (request.method !== 'GET' && !(request.method === 'POST' && WRITE_PATHS.has(url.pathname)))
      return json({ error: 'Method not allowed' }, 405, cors);

    try {
      // ── Worker-served injection (portal-mode-only; dia/local never expose these) ──────────────────
      // Public neutral PRIMARY at /<basename>.js — no auth, cache-in-front OK. Carries nothing sensitive.
      if (url.pathname === `/${primaryBasename(env)}.js`) {
        return new Response(primaryJs(env), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...cors } });
      }

      // Manifest SECONDARY at /kit/asset/<name>.js — served from the private ASSETS binding, gated
      // per-entry (public / auth / admin / superadmin / any key). Pre-resolveAuth: `public` needs no token,
      // and `auth` admits any valid ns_t (not just portal.access), so it can't use resolveAuth.
      if (url.pathname.startsWith('/kit/asset/')) {
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
      // `/kit/status` and `/kit/spk.js` are deliberately NOT listed here. Neither reaches this fence at
      // all — both are handled in their own branch earlier in fetch(), ahead of Group 2 — but even setting
      // that aside, a self principal is domain-locked by construction and can never satisfy
      // requireFleetRead (reseller scope or a listed superadmin), so listing them here would buy nothing
      // but a false sense that this is where they're gated. Do not "fix" this omission by adding them.
      if (auth.self) {
        const sp = url.pathname;
        const selfOk = (sp === '/me/status' || sp === '/me/devices' || sp === '/me/resetPassword' || sp === '/me/app-access' || sp === '/kit/self.js');
        if (!selfOk) throw new HttpError(403, 'Not authorized for the svc portal');
      }

      // Gated per-tier BUNDLE. Portal-mode-only (like the primary/asset routes) so dia/local stay
      // byte-identical — otherwise an Access-gated dia caller with a reseller ns_t would get the bundle
      // (incl. the label) instead of a 404. resolveAuth already gated portal.access; also require a
      // delegated principal (service mode has none ⇒ 403, fail closed). Per-tier bytes only.
      if (url.pathname === '/kit/portal.js') {
        if (!auth.principal) throw new HttpError(403, 'The gated bundle requires a delegated ns_t');
        const allowedKeys = featurePolicyKeys().filter((k) => can(auth.principal!, k, policies));
        // Server tier-cache: key includes a host discriminator (caches.default is zone-shared across
        // dia/portal/dev on example.com) + VERSION, so tiers never collide and a deploy busts it.
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
      if (url.pathname === '/kit/self.js') {
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
          if (nsDeviceDetailsEnabled(env)) await enrichDeviceDetails(graph, client, caches.default, env, domain, { refresh });
          if (ringotelEnabled(env)) await enrichFlowGraph(graph, domain, env, caches.default, { refresh });
        }

        const format = url.searchParams.get('format') ?? 'json';
        if (format === 'html') return new Response(renderGalleryHtml(domain, [graph], { subtitle: graph.entity.label, theme: 'light', accent: brandAccent(env) }), { headers: { 'content-type': 'text/html; charset=utf-8', ...cors } });
        if (format === 'mermaid') return new Response(toMermaid(graph), { headers: { 'content-type': 'text/plain; charset=utf-8', ...cors } });
        // JSON carries the rendered mermaid so the SPA can render + export client-side.
        return json({ ...graph, __mermaid: toMermaid(graph) }, 200, cors);
      }

      if (url.pathname === '/rapp/org') {
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
        // hPIE is a per-user sign-in detail: it only means anything once a user has been resolved to the
        // password path, which this org-level route never does. /me/app-access emits it exactly there.
        // Strip it here so "emitted only where it is actionable" holds on BOTH routes rather than one --
        // the projection stays a dumb org fact, and the decision about what to disclose stays at the edge.
        const { hPIE: _hPIE, ...orgBody } = await orgStatusForDomain(domain, env, caches.default, { refresh });
        return json(orgBody, 200, cors);
      }

      if (url.pathname === '/rapp/users') {
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
        const usersRes = await usersStatusForDomain(domain, env, caches.default, { refresh });
        if (usersRes.users) {
          for (const [ext, u] of Object.entries(usersRes.users)) usersRes.users[ext] = withConnectionView(u);
        }
        return json(usersRes, 200, cors);
      }

      if (url.pathname === '/rapp/orgs') {
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
      if (url.pathname === '/rapp/user') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        const domain = requireDomain(auth, url, env);
        await maybeElevate(auth, domain, env);
        requireFeature(auth, 'ringotel.profileStatus', env, policies);
        if (!auth.principal || domain !== normDomain(auth.principal.domain)) await assertDomainReadable(client, domain);
        const ext = str(url.searchParams.get('ext'));
        // TWO INDEPENDENT KNOBS, and they used to be one:
        //   ?fresh=1 — read the Ringotel user list LIVE instead of from the ~10-minute cache.
        //   ?poll=1  — this is the client's cheap repeat poll: skip the NS-side extras (eligibility, the
        //              app-access projection), which it already has from the initial load and discards.
        // They were a single `fresh` flag, which quietly made "give me current data" and "give me less
        // data" the same request. That was fine while only the post-write poll asked for fresh data — but
        // the profile page now asks for it ON LOAD (a change made anywhere else, including by the SSO
        // worker, is otherwise invisible until the cache expires), and on load the extras are exactly what
        // renders the Force button and the sign-in panel. Splitting them is what makes that safe.
        // An older cached client that sends only `fresh=1` therefore gets the extras computed rather than
        // silently dropped — it pays for a read it doesn't use, which is the right way round to be wrong.
        // ACCEPTED, deliberately (2026-07-27): unlike `?refresh=`, `fresh=1` is not policy-gated beyond
        // ringotel.profileStatus and is not coalesced by any lock, so it costs one org `getUsers` per
        // request — and since the profile page now sends it on load, that is a steady-state cost rather
        // than only a post-write one. A scripted caller holding that feature could drive it at request
        // rate against the fleet-wide Ringotel key. A 2-5s micro-TTL would cap it and would still be
        // correct (the write path invalidates the org-users key, so a post-write read still misses), but
        // it would put a floor under the post-write poll's ~1s cadence and make a just-saved change take
        // visibly longer to appear. Degrading the feature to bound a semi-trusted, domain-locked role was
        // judged the worse trade. Revisit if Ringotel ever rate-limits us.
        const wantFresh = str(url.searchParams.get('fresh')) === '1';
        const isPoll = str(url.searchParams.get('poll')) === '1';
        let active: boolean, status: unknown, age: number | undefined;
        if (wantFresh) {
          const all = await usersStatusForDomainFresh(domain, env, caches.default);
          active = !!all.active;
          const raw = all.active && ext && all.users ? (all.users[ext] ?? null) : null;
          status = raw ? withConnectionView(raw) : null;
          age = all.age;
        } else {
          const s = await computeUserStatus(domain, ext, env, caches.default);
          active = s.present; // preserve `/rapp/user` semantics: `active` means "org present"
          status = s.status;
          age = s.age;
        }
        // Eligibility (so the client shows a plain checkbox for a normal user, and a Force button ONLY for
        // a soft-excluded one). Best-effort: a read failure ⇒ null, and the client falls back gracefully.
        // Shared with /me/app-access via evaluateEligibilityForExt — ONE implementation of the NS-user +
        // devices read → evaluateEligibility call, so the two routes can't drift.
        let eligibility: { activatable: boolean; tier: string; reasons: string[] } | null = null;
        // Reuse the NS-user record the eligibility read already fetched as the projection's record below,
        // so a non-poll /rapp/user reads the user once, not once here + once for the projection.
        let sharedNsUser: Record<string, unknown> | null = null;
        if (ext && !isPoll) {
          const isReseller = auth.principal ? isResellerScope(auth.principal.scope) : false;
          const elig = await evaluateEligibilityForExt(client, domain, ext, env, isReseller);
          if (elig) {
            sharedNsUser = elig.nsUser;
            eligibility = { activatable: elig.activatable, tier: elig.tier, reasons: elig.reasons };

            // The one health flag that needs an upstream read. Free here: the device list was fetched
            // for the eligibility count above (reused from the shared helper, not re-fetched). Only
            // meaningful for an ACTIVATED app user — a user with no app is supposed to have no
            // `<ext><suffix>` device. `null` marks a FAILED read, which must stay distinguishable from a
            // genuinely empty device list — otherwise a transient NS error would be reported as missing
            // hardware below.
            const devs = elig.devs;
            const devList = Array.isArray(devs) ? devs : [];
            const st = status as { activated?: boolean; health?: { flags: HealthFlag[]; severity: string } } | null;
            if (devs !== null && st?.activated && st.health) {
              const want = ext + resolveRingotelConfig(env).suffix;
              if (!devList.some((d) => String((d as Record<string, unknown>)?.device ?? '') === want)) {
                st.health.flags = [...st.health.flags, 'no-ns-device'];
                st.health.severity = worstSeverity(st.health.flags);
              }
            }
          }
        }
        // Admin third-party app-access projection — the SAME helper /me/app-access uses, so the operator
        // sees exactly the user's sign-in message. Gated on ringotel.profileAppAccess (default
        // office_manager), so the extra NS-user read + larger payload are only paid on the profile page
        // where the feature is on. Delegated (portal) principals only — service tokens (dia) have no
        // "user-visible message" concept.
        // Not on the ?poll=1 repeat: like `eligibility` above, the projection is skipped on the poll
        // (pollUntil discards it and reconstructs r without appAccess), so the poll stays cheap — the
        // profile page pays it once, on the initial read.
        let appAccess: Awaited<ReturnType<typeof computeAppAccessProjection>> | undefined;
        if (ext && !isPoll && auth.principal && can(auth.principal, 'ringotel.profileAppAccess', policies)) {
          // sharedNsUser is the record the eligibility read fetched (null iff that read failed ⇒ the
          // projection fails closed to `unavailable` on SSO, the correct degradation).
          appAccess = await computeAppAccessProjection(client, ext, domain, sharedNsUser, env, isResellerScope(auth.principal.scope), caches.default);
        }
        return json({ active: !!active, ext, status, eligibility, ...(typeof age === 'number' ? { age } : {}), ...(appAccess ? { appAccess } : {}) }, 200, cors);
      }

      // ── Self-service (own-account) routes ────────────────────────────────────────────
      // Own app status for the home widget. Identity comes from the NS `~` self-wildcard (authoritative,
      // token-scoped) — never client input. Shares the Ringotel org-users cache with /rapp/user.
      if (url.pathname === '/me/status') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        if (!auth.principal) throw new HttpError(403, 'The self status route requires a delegated ns_t');
        if (!can(auth.principal, 'portal.self', policies)) throw new HttpError(403, 'Not authorized: portal.self');
        requireFeature(auth, 'me.appStatus', env, policies);
        const { ext, domain } = await resolveSelfNsUser(client, auth.principal);
        const s = await computeUserStatus(domain, ext, env, caches.default);
        return json({ active: s.active, present: s.present }, 200, cors);
      }

      // Own app-access sign-in details (mode + username + downloads + hide list) for the "how do I sign
      // in" panel. Identity from the NS `~` self-wildcard ONLY — never a request parameter, so no
      // cross-user read is expressible (see src/appAccess.ts for the pure decision matrix).
      if (url.pathname === '/me/app-access') {
        if (!auth.principal) throw new HttpError(403, 'The self app-access route requires a delegated ns_t');
        if (!can(auth.principal, 'portal.self', policies)) throw new HttpError(403, 'Not authorized: portal.self');
        // This route now carries TWO independent surfaces: the sign-in details (me.appAccess) and portal
        // menu customization (me.menuConfig). They ride one request because both need the same org read —
        // but each is gated on its own key, so an operator can run stock-menu curation without the sign-in
        // panel, or the reverse. Neither permitted ⇒ the route is not theirs to call.
        const wantAccess = can(auth.principal, 'me.appAccess', policies);
        const wantMenus = can(auth.principal, 'me.menuConfig', policies);
        if (!wantAccess && !wantMenus) throw new HttpError(403, 'Not authorized: me.appAccess or me.menuConfig');

        // Menu customization does NOT depend on the app integration — static add/hide is useful to a
        // deployment that runs no app at all, and gating it behind RINGOTEL_API_KEY made it silently do
        // nothing there. With no integration configured the app state is simply 'none'; the sign-in
        // surface still requires the integration, as before.
        if (!ringotelEnabled(env)) {
          if (!wantMenus) return json({ error: 'Not found' }, 404, cors);
          // Pass the same vars as the integrated path: without them {ext}/{name} would silently resolve
          // empty on exactly the deployments this branch exists to serve.
          const { ext: e0, domain: d0, record: r0 } = await resolveSelfNsUser(client, auth.principal);
          return json({ menus: resolveMenus(env, { domain: d0, app: activeApps(env, d0, false), scope: auth.principal.scope, user: auth.principal.id, vars: menuVars(r0, e0, d0) }) }, 200, cors);
        }

        // Identity from `~` ONLY (resolveSelfNsUser). The org/status/eligibility/decision logic — incl.
        // the fail-closed guards and the SSO email-not-required rule — lives in computeAppAccessProjection,
        // shared verbatim with the admin /rapp/user view so the two can never drift.
        const { ext, domain, record } = await resolveSelfNsUser(client, auth.principal);
        const proj = await computeAppAccessProjection(client, ext, domain, record, env, isResellerScope(auth.principal.scope), caches.default);

        // Menu plan for THIS user's domain. `present` is the app-org signal the projection already
        // resolved, so the app state costs no extra read. Only this user's outcome is returned — the
        // fleet's config never reaches a client.
        let menus: Record<string, MenuPlan> | undefined;
        if (wantMenus) {
          // `principal.scope` is the EFFECTIVE scope — the masked user's while masquerading — so an
          // operator viewing a masked session sees the menu that user sees, which is the point of masking.
          // The ACTIVE SET, not one app: two integrations can be live on one domain, and the axis unions
          // across them. `proj.present` is the Ringotel half; `activeApps` owns the rest.
          menus = resolveMenus(env, { domain, app: activeApps(env, domain, proj.present), scope: auth.principal.scope, user: auth.principal.id, vars: menuVars(record, ext, domain) });
        }

        // The sign-in fields (mode/username/appDomain/downloads) belong to me.appAccess — a menus-only
        // caller must not receive them. `hide` and `label` stay: `hide` for back-compat with clients that
        // read it directly, `label` because it is already in the bundle's own config.
        const body = wantAccess ? proj : { hide: proj.hide, label: proj.label };
        return json({ ...body, ...(menus ? { menus } : {}) }, 200, cors);
      }

      // Own devices (read). Built but default off (me.devices). NS `~` self-wildcard — no ext derivation,
      // no ringotelEnabled gate (a pure NS device read).
      if (url.pathname === '/me/devices') {
        if (!auth.principal) throw new HttpError(403, 'The self devices route requires a delegated ns_t');
        if (!can(auth.principal, 'portal.self', policies)) throw new HttpError(403, 'Not authorized: portal.self');
        requireFeature(auth, 'me.devices', env, policies);
        const devs = await client.get('/domains/~/users/~/devices').catch(() => []);
        return json({ devices: Array.isArray(devs) ? devs : [] }, 200, cors);
      }

      // Reset OWN app password (write). Built but default off (me.resetPassword). Identity from the `~`
      // wildcard; write-rail fenced (RINGOTEL_WRITE_DOMAINS). No assertDomainReadable — own domain by
      // construction, and a low-priv token may be refused NS GET /domains/{d}.
      if (url.pathname === '/me/resetPassword' && request.method === 'POST') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        if (!auth.principal) throw new HttpError(403, 'The self reset route requires a delegated ns_t');
        if (!can(auth.principal, 'portal.self', policies)) throw new HttpError(403, 'Not authorized: portal.self');
        requireWriteFeature(auth, 'me.resetPassword', policies);
        const { ext, domain, record } = await resolveSelfNsUser(client, auth.principal);
        const rtConfig = resolveRingotelConfig(env);
        assertDomainWritable(domain, rtConfig.writeDomains);
        if (needsFreshAuth(ROUTES['/me/resetPassword'].sensitivity)) await requireFreshAuth(auth, env);
        const res = await resolveForWrite(env, caches.default, domain);
        const target = resolveWriteConnection(res, ext, { mayCreate: false });
        const users = res.users ?? [];
        const email = emailForWrite(record, ext, auth.principal);
        const result = await resetPassword({ nsWrite: new NsWriteClient({ server: env.NS_SERVER, token: auth.token }), rtWrite: makeWriteClient(env), users, orgid: target.orgid, branchid: target.branchid, domain, ext, suffix: rtConfig.suffix, email });
        await invalidateOrgUsers(caches.default, scopeOf(env), target.orgid);
        return json({ ok: true, ...result }, 200, cors);
      }

      // Activate / deactivate (write). Chain: feature (fail-closed) → domain → WRITABLE rail → READABLE
      // scope → forceFresh → (activate only) eligibility → write → cache invalidate.
        if (url.pathname === '/rapp/prepop/preview') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        const domain = requireDomain(auth, url, env);
        await maybeElevate(auth, domain, env);
        requireFeature(auth, 'ringotel.prepop', env, policies);
        // Same scope bound as every other Ringotel route: these resolve from the fleet-wide Ringotel key
        // by domain string alone, so a caller must not be able to name a domain their NS token can't read.
        if (!auth.principal || domain !== normDomain(auth.principal.domain)) await assertDomainReadable(client, domain);
        const { plan } = await buildPrepopPlan(client, env, caches.default, domain, isResellerScope(auth.principal?.scope));
        return json({ domain, ...plan }, 200, cors);
      }

      if (url.pathname === '/rapp/prepop/apply' && request.method === 'POST') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        const body = (await request.json().catch(() => null)) as { domain?: string } | null;
        requireWriteFeature(auth, 'ringotel.prepop', policies);
        const domain = requireDomainValue(auth, str(body?.domain), env);
        const rtConfig = resolveRingotelConfig(env);
        assertDomainWritable(domain, rtConfig.writeDomains);
        await assertDomainReadable(client, domain);
        if (needsFreshAuth(ROUTES['/rapp/prepop/apply'].sensitivity)) await requireFreshAuth(auth, env);
        // Re-plan rather than accept a client-supplied list: the caller names the DOMAIN to reconcile,
        // never the individual users to create.
        const { plan, org } = await buildPrepopPlan(client, env, caches.default, domain, isResellerScope(auth.principal?.scope));
        const res = await applyDirectoryPrepop(makeWriteClient(env), org.entry.orgid, org.entry.branchid, plan.create);
        if (res.created > 0) await invalidateOrgUsers(caches.default, scopeOf(env), org.entry.orgid);
        console.log(JSON.stringify({ msg: 'prepop applied', domain, planned: plan.create.length, created: res.created, failed: res.failed.length }));
        return json({ domain, planned: plan.create.length, ...res }, 200, cors);
      }

    if (url.pathname === '/rapp/activate' && request.method === 'POST') {
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
        if (needsFreshAuth(ROUTES['/rapp/activate'].sensitivity)) await requireFreshAuth(auth, env);

        const res = await resolveForWrite(env, caches.default, domain);
        // mayCreate stays TRUE for deactivate too, deliberately. Threading `wantActive` through here also
        // makes the single-connection path require an existing record, turning today's 200/no-op deactivate
        // of a never-activated extension into a 404. That may well be the better behaviour — it currently
        // still reaches for an NS device delete with no app record — but it is a live behaviour change on
        // every existing domain and needs the owner's sign-off, not a refactor's side effect.
        const target = resolveWriteConnection(res, ext, { mayCreate: true });
        const users = res.users ?? [];
        const nsWrite = new NsWriteClient({ server: env.NS_SERVER, token: auth.token });
        const rtWrite = makeWriteClient(env);
        const common = { nsWrite, rtWrite, users, orgid: target.orgid, branchid: target.branchid, domain, ext, suffix: rtConfig.suffix };

        let result;
        if (wantActive) {
          const nsUser = (await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}`).catch(() => null)) as Record<string, unknown> | null;
          if (!nsUser) return json({ error: 'User not found' }, 404, cors);
          const devices = await nsWrite.getDevices(domain, ext);
          const eu = nsUserToElig(nsUser, ext, devices.length);
          // `force` is a reseller RUNTIME override (bypasses soft, never hard); honored only for a reseller.
          const elig = evaluateEligibility(eu, { domain, isReseller: isResellerScope(auth.principal!.scope), force: body?.force === true }, rtConfig);
          if (!elig.activatable) return json({ error: 'Not eligible for activation', tier: elig.tier, reasons: elig.reasons }, 403, cors);
          result = await activate({
            ...common,
            name: nsDisplayName(nsUser) || ext,
            email: emailForWrite(nsUser, ext, auth.principal),
            rotateExistingDevice: rotateSipOnActivate(env),
          });
        } else {
          // Best-effort identity sync on deactivate too: the RT user stays as a visible directory entry.
          // If the NS user is gone (a common reason to deactivate) the fetch is null → deactivate skips
          // the sync and just turns the user off.
          const nsUser = (await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}`).catch(() => null)) as Record<string, unknown> | null;
          const name = nsUser ? nsDisplayName(nsUser) || undefined : undefined;
          const email = emailForWrite(nsUser, ext, auth.principal);
          result = await deactivate({ ...common, name, email });
        }
        await invalidateOrgUsers(caches.default, scopeOf(env), target.orgid);
        return json({ ok: true, ...result }, 200, cors);
      }

      // Reset the app password (write). Requires an existing app user for the extension.
      if (url.pathname === '/rapp/resetPassword' && request.method === 'POST') {
        if (!ringotelEnabled(env)) return json({ error: 'Not found' }, 404, cors);
        const body = (await request.json().catch(() => null)) as { domain?: string; ext?: string } | null;
        const ext = str(body?.ext);
        if (!ext) return json({ error: 'Provide { ext }' }, 400, cors);
        requireWriteFeature(auth, 'ringotel.resetPassword', policies);
        const domain = requireDomainValue(auth, str(body?.domain), env);
        const rtConfig = resolveRingotelConfig(env);
        assertDomainWritable(domain, rtConfig.writeDomains);
        await assertDomainReadable(client, domain);
        if (needsFreshAuth(ROUTES['/rapp/resetPassword'].sensitivity)) await requireFreshAuth(auth, env);

        const res = await resolveForWrite(env, caches.default, domain);
        const target = resolveWriteConnection(res, ext, { mayCreate: false });
        const users = res.users ?? [];
        const nsUser = (await client.get(`/domains/${encPath(domain)}/users/${encPath(ext)}`).catch(() => null)) as Record<string, unknown> | null;
        const email = emailForWrite(nsUser, ext, auth.principal);
        const result = await resetPassword({ nsWrite: new NsWriteClient({ server: env.NS_SERVER, token: auth.token }), rtWrite: makeWriteClient(env), users, orgid: target.orgid, branchid: target.branchid, domain, ext, suffix: rtConfig.suffix, email });
        await invalidateOrgUsers(caches.default, scopeOf(env), target.orgid);
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

  /** Subscription lifecycle. Cron cadence is relaxed on purpose: an explicit expiry is honoured even for
   *  an OAuth-minted subscription, so this validates and repairs rather than keeping anything alive. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runNsEventsReconcile(env).catch((e) =>
        console.error(JSON.stringify({ msg: 'ns-events reconcile failed', error: String((e as Error)?.message ?? e).slice(0, 200) })),
      ),
    );
    ctx.waitUntil(
      runOrphanSweep(env).catch((e) =>
        console.error(JSON.stringify({ msg: 'ns-events sweep failed', error: String((e as Error)?.message ?? e).slice(0, 200) })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
