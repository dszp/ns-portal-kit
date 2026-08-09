/**
 * NetSapiens event subscriptions — config, inbound receiver verification, payload decoding, and
 * subscription reconciliation.
 *
 * NetSapiens can POST a change event to a URL we own whenever a subscriber record changes. That closes the
 * gap where identity only reached the app directory as a side effect of an explicit action (activate,
 * deactivate, password reset, SSO login), so an edit made directly in NetSapiens never propagated.
 *
 * Two invariants shape everything here, and both are load-bearing:
 *
 * 1. **The payload is a trigger, not truth.** We extract only *who changed* and then re-read that user
 *    from the API. A pushed value is never consumed. This keeps the "a field that is absent means unknown,
 *    NOT removed" contract intact (the re-read is unambiguous), makes replays idempotent, and means the
 *    event's field spellings are not a correctness dependency. That last part matters: the event payload is
 *    v1 `snake_case` (`email_address`, `firstname`, `lastname`, `subscriber_group`) and does NOT match the
 *    v2 record we read (`email`, `name-first-name`, `name-last-name`, `department`).
 * 2. **The receiver is unauthenticated by nature**, so it is gated by config alone and layered:
 *    a per-domain derived path token, a strict domain grammar, an explicit domain allowlist, and the
 *    existing write rail. An event that cannot be verified is dropped, never applied.
 */
import {
  type Subscription,
  type SubscriptionModel,
  type DesiredSubscription,
  type SubscriptionAction,
  type NsSubscriptionsClient,
  isSubscriptionModel,
  nsDatetime,
} from '@dszp/netsapiens-lib';

export interface NsEventsEnv {
  /** `auto` (default) | `on` | `off`. See {@link parseNsEventsConfig} for what "auto" means. */
  NS_EVENTS?: string;
  /**
   * Enumerated domains, or `*` for every domain the write rail permits (concrete list discovered from
   * the Ringotel directory at reconcile time). Empty/unset ⇒ inert — `*` must be chosen deliberately.
   */
  NS_EVENTS_DOMAINS?: string;
  /** Public origin of this Worker, e.g. `https://portal.example.com`. Must be host-distinct per env. */
  NS_EVENTS_BASE_URL?: string;
  /** Master secret; the per-domain path token is derived from it. */
  NS_EVENTS_PATH_SECRET?: string;
  /** CSV of models. Default `subscriber`. */
  NS_EVENTS_MODELS?: string;
  /** Seconds. Renew when the remaining lifetime drops below this. Default 7 days. */
  NS_EVENTS_RENEW_HORIZON?: string;
  /** Seconds. Lifetime requested on create/renew. Default 365 days. */
  NS_EVENTS_TARGET_LIFETIME?: string;
  /** Optional CSV source-IP allowlist. Default empty = off; see the receiver notes. */
  NS_EVENTS_ALLOW_IPS?: string;
  /** `yes` (default) | `no` — NS geo-redundant delivery. */
  NS_EVENTS_GEO_SUPPORT?: string;
  /** Optional preferred delivering node. */
  NS_EVENTS_PREFERRED_SERVER?: string;
  /** Max events processed per invocation. Default 40. */
  NS_EVENTS_MAX_EVENTS?: string;
  /** Truthy ⇒ log payload shape (keys/sizes only, never values) to learn a payload we haven't seen. */
  NS_EVENTS_DIAG_RAW?: string;
  /**
   * `off` (default) | `deactivate`. Whether an NS-deleted user's app record is deactivated, by both the
   * event tier and the cron sweep.
   *
   * `deactivate+delete` is deliberately NOT accepted: hard deletion needs a verified "how long has this
   * been an orphan" clock, and none has been established (see the design spec §6). Rejecting it here
   * means the fail-safe is enforced by the parser rather than by remembering.
   */
  NS_EVENTS_OFFBOARD?: string;
  /** `off` (default) | `report` | `heal`. Device self-heal on a user-change event. */
  NS_EVENTS_DEVICE_REPAIR?: string;
  /** Max extensions deactivated per sweep run. Default 200; overflow is logged, never silent. */
  NS_EVENTS_SWEEP_MAX?: string;
  /** Service identity — an API key, or admin credentials for an OAuth password grant. */
  NS_API_KEY?: string;
  NS_ADMIN_USER?: string;
  NS_ADMIN_PASS?: string;
  /** Read for the `auto` decision and the write rail. */
  RINGOTEL_API_KEY?: string;
  RINGOTEL_WRITE_DOMAINS?: string;
}

export class NsEventsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NsEventsConfigError';
  }
}

/** How the service identity authenticates to NetSapiens. Mirrors the SSO worker so config transfers. */
export type NsWriteIdentity = { kind: 'api'; token: string } | { kind: 'admin'; user: string; pass: string };

/**
 * Resolve the background-write identity from raw presence — admin credentials win when BOTH are set,
 * matching the SSO worker's precedence, else the API key, else none. Extracted so a diagnostic surface
 * (the integration console) can ask "what identity would this resolve to" without re-deriving the precedence
 * itself — a second copy of "admin wins over api" is exactly the kind of drift this function exists to
 * prevent. Pure presence-only and NEVER throws: whether an 'admin' identity can actually MINT a token
 * additionally needs `NS_OAUTH_CLIENT_ID`/`NS_OAUTH_CLIENT_SECRET`, which is `nsIdentity.ts`'s
 * `getServiceToken` precondition (see its `identityUsable`) — a different, later question than "which
 * credential was configured".
 */
export function resolveWriteIdentity(env: Pick<NsEventsEnv, 'NS_API_KEY' | 'NS_ADMIN_USER' | 'NS_ADMIN_PASS'>): NsWriteIdentity | undefined {
  const apiKey = (env.NS_API_KEY ?? '').trim();
  const adminUser = (env.NS_ADMIN_USER ?? '').trim();
  const adminPass = (env.NS_ADMIN_PASS ?? '').trim();
  return adminUser && adminPass
    ? { kind: 'admin', user: adminUser, pass: adminPass }
    : apiKey
      ? { kind: 'api', token: apiKey }
      : undefined;
}

export type NsEventsIntent = 'auto' | 'on' | 'off';

export interface NsEventsConfig {
  intent: NsEventsIntent;
  /** True ⇒ the feature runs. False ⇒ route absent, no cron work. */
  armed: boolean;
  /** When not armed, why — logged once so an operator can see what is missing. */
  inertReason?: string;
  /**
   * `'*'` = every domain the write rail permits, with the concrete per-domain subscription list
   * discovered at reconcile time (see {@link desiredSubscriptions}). Otherwise an explicit, already
   * rail-intersected list.
   */
  domains: string[] | '*';
  /** The Ringotel write rail, kept so the receiver can apply it when `domains` is `'*'`. */
  writeRail: string[] | '*';
  baseUrl: string;
  pathSecret: string;
  models: SubscriptionModel[];
  renewHorizonSeconds: number;
  targetLifetimeSeconds: number;
  allowIps: string[];
  geoSupport: 'yes' | 'no';
  preferredServer?: string;
  maxEvents: number;
  diagRaw: boolean;
  offboard: 'off' | 'deactivate';
  deviceRepair: 'off' | 'report' | 'heal';
  sweepMax: number;
  identity?: NsWriteIdentity;
}

const csv = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test((v ?? '').trim());

/** `unit` describes what the number counts (e.g. "seconds", "events") so the error stays accurate for
 *  both the duration settings and the plain-count ones (NS_EVENTS_MAX_EVENTS, NS_EVENTS_SWEEP_MAX). */
function intOr(raw: string | undefined, dflt: number, label: string, unit: string = 'number'): number {
  const t = (raw ?? '').trim();
  if (!t) return dflt;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) throw new NsEventsConfigError(`${label} must be a non-negative ${unit}`);
  return Math.floor(n);
}

/** Parse a fixed-vocabulary switch. Case-insensitive; an unknown value is loud, never a silent default. */
function enumOr<T extends string>(raw: string | undefined, allowed: readonly T[], dflt: T, label: string): T {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t) return dflt;
  if ((allowed as readonly string[]).includes(t)) return t as T;
  throw new NsEventsConfigError(`${label} must be one of ${allowed.join('|')} (got "${raw}")`);
}

/**
 * NS domains are lowercase, dotted or bare (a legacy pre-white-label domain has no territory suffix), and
 * at most 64 characters. This is deliberately strict and runs **before** anything else touches the value.
 *
 * The value arrives in a URL path and is then interpolated into API paths, so the rejections matter:
 * `~` is NetSapiens' literal self-reference wildcard (and `encodeURIComponent` leaves `~` untouched, so
 * encoding is not a defence), `*` is its all-domains wildcard, and `/` `%` `..` are path traversal. Any of
 * those reaching a privileged read would name a scope the caller must never be able to choose.
 */
export function isValidEventDomain(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  if (raw !== raw.trim() || raw === '') return false;
  if (raw.length > 64) return false;
  if (raw !== raw.toLowerCase()) return false;
  if (raw.includes('..') || raw.endsWith('.') || raw.endsWith('-')) return false;
  return /^[a-z0-9][a-z0-9.-]*$/.test(raw);
}

/**
 * Resolve configuration, separating **intent** from **armed**.
 *
 * `auto` (the default) means "on when Ringotel is configured", so the feature is on by default where it is
 * useful. But intent alone must never make missing configuration fatal: the config-error gates in the
 * Worker run before routing, so treating an unconfigured `auto` as an error would return 500 for *every*
 * route the moment this deploys. So:
 *
 * - `auto` + complete config ⇒ armed.
 * - `auto` + incomplete config ⇒ **inert**, with `inertReason`. Not an error.
 * - `on` + incomplete config ⇒ throws. The operator asked explicitly, so fail loudly.
 * - `off` ⇒ inert, unconditionally.
 */
export function parseNsEventsConfig(env: NsEventsEnv): NsEventsConfig {
  const rawIntent = (env.NS_EVENTS ?? '').trim().toLowerCase();
  const intent: NsEventsIntent =
    rawIntent === '' || rawIntent === 'auto'
      ? 'auto'
      : rawIntent === 'on' || rawIntent === 'off'
        ? (rawIntent as NsEventsIntent)
        : (() => {
            throw new NsEventsConfigError(`NS_EVENTS must be one of auto|on|off (got "${env.NS_EVENTS}")`);
          })();

  // Parsed even when inert, so a typo is caught rather than hidden behind an unrelated switch.
  const models = csv(env.NS_EVENTS_MODELS).length ? csv(env.NS_EVENTS_MODELS) : ['subscriber'];
  for (const m of models) {
    if (!isSubscriptionModel(m)) throw new NsEventsConfigError(`NS_EVENTS_MODELS has an unknown model: ${m}`);
  }
  const rawGeo = (env.NS_EVENTS_GEO_SUPPORT ?? '').trim().toLowerCase();
  if (rawGeo !== '' && rawGeo !== 'yes' && rawGeo !== 'no') {
    throw new NsEventsConfigError('NS_EVENTS_GEO_SUPPORT must be yes or no');
  }
  const geoSupport: 'yes' | 'no' = rawGeo === 'no' ? 'no' : 'yes';

  // Parsed unconditionally, like `models` above: a typo must surface rather than hide behind a switch.
  const offboard = enumOr(env.NS_EVENTS_OFFBOARD, ['off', 'deactivate'] as const, 'off', 'NS_EVENTS_OFFBOARD');
  const deviceRepair = enumOr(env.NS_EVENTS_DEVICE_REPAIR, ['off', 'report', 'heal'] as const, 'off', 'NS_EVENTS_DEVICE_REPAIR');
  const sweepMax = Math.max(1, intOr(env.NS_EVENTS_SWEEP_MAX, 200, 'NS_EVENTS_SWEEP_MAX', 'count'));

  // The write rail may narrow, never widen — `'*'` here still cannot exceed it.
  const rawRail = (env.RINGOTEL_WRITE_DOMAINS ?? '').trim();
  const writeRail: string[] | '*' = rawRail === '*' ? '*' : csv(rawRail).map((x) => x.toLowerCase());

  /**
   * `'*'` is a deliberate, operator-chosen setting, not the default (unset ⇒ inert). It means "every
   * domain the write rail permits", with the concrete list discovered from the Ringotel directory at
   * reconcile time — a Reseller-scoped credential cannot create a subscription with `domain: '*'`
   * anyway (that needs Super User), so a wildcard must always expand to real domains.
   *
   * Note what does and does not protect this. The enumerated list was defence-in-depth; the actual gate
   * is the per-domain derived path token, which an attacker cannot forge without the master secret. What
   * `'*'` genuinely widens is the blast radius *if that secret leaks*: from the listed domains to every
   * domain the rail permits. Rotate the secret if it is ever exposed.
   */
  const rawDomains = (env.NS_EVENTS_DOMAINS ?? '').trim();
  let domains: string[] | '*';
  if (rawDomains === '*') {
    domains = '*';
  } else {
    const requested = csv(rawDomains).map((d) => d.trim().toLowerCase());
    for (const d of requested) {
      if (!isValidEventDomain(d)) throw new NsEventsConfigError(`NS_EVENTS_DOMAINS contains an invalid domain: ${d}`);
    }
    domains = writeRail === '*' ? requested : requested.filter((d) => writeRail.includes(d));
  }

  const baseUrlRaw = (env.NS_EVENTS_BASE_URL ?? '').trim().replace(/\/+$/, '');
  let baseUrl = '';
  if (baseUrlRaw) {
    let u: URL | undefined;
    try {
      u = new URL(baseUrlRaw);
    } catch {
      u = undefined;
    }
    if (!u || u.protocol !== 'https:' || u.search || u.hash) {
      throw new NsEventsConfigError('NS_EVENTS_BASE_URL must be an absolute https origin with no query or fragment');
    }
    baseUrl = baseUrlRaw;
  }

  const pathSecret = (env.NS_EVENTS_PATH_SECRET ?? '').trim();
  const allowIps = csv(env.NS_EVENTS_ALLOW_IPS).map((s) => s.toLowerCase());
  const renewHorizonSeconds = intOr(env.NS_EVENTS_RENEW_HORIZON, 7 * 86400, 'NS_EVENTS_RENEW_HORIZON', 'number of seconds');
  const targetLifetimeSeconds = intOr(env.NS_EVENTS_TARGET_LIFETIME, 365 * 86400, 'NS_EVENTS_TARGET_LIFETIME', 'number of seconds');
  if (targetLifetimeSeconds <= renewHorizonSeconds) {
    throw new NsEventsConfigError('NS_EVENTS_TARGET_LIFETIME must exceed NS_EVENTS_RENEW_HORIZON, or every run renews');
  }
  const maxEvents = Math.max(1, intOr(env.NS_EVENTS_MAX_EVENTS, 40, 'NS_EVENTS_MAX_EVENTS', 'count'));
  const preferredServer = (env.NS_EVENTS_PREFERRED_SERVER ?? '').trim();

  const identity = resolveWriteIdentity(env);

  const base: Omit<NsEventsConfig, 'armed' | 'inertReason'> = {
    intent,
    domains,
    baseUrl,
    pathSecret,
    writeRail,
    models: models as SubscriptionModel[],
    renewHorizonSeconds,
    targetLifetimeSeconds,
    allowIps,
    geoSupport,
    maxEvents,
    diagRaw: truthy(env.NS_EVENTS_DIAG_RAW),
    offboard,
    deviceRepair,
    sweepMax,
    ...(preferredServer ? { preferredServer } : {}),
    ...(identity ? { identity } : {}),
  };

  if (intent === 'off') return { ...base, armed: false, inertReason: 'NS_EVENTS=off' };

  const missing: string[] = [];
  if (!baseUrl) missing.push('NS_EVENTS_BASE_URL');
  if (!pathSecret) missing.push('NS_EVENTS_PATH_SECRET');
  if (!identity) missing.push('NS_API_KEY or NS_ADMIN_USER+NS_ADMIN_PASS');
  if (domains !== '*' && domains.length === 0) missing.push('NS_EVENTS_DOMAINS (within RINGOTEL_WRITE_DOMAINS)');

  if (missing.length) {
    const detail = `NetSapiens event subscriptions not armed — missing: ${missing.join(', ')}`;
    if (intent === 'on') throw new NsEventsConfigError(detail);
    return { ...base, armed: false, inertReason: detail };
  }

  // `auto` needs Ringotel configured to mean anything; the only handler today writes to Ringotel.
  if (intent === 'auto' && !(env.RINGOTEL_API_KEY ?? '').trim()) {
    return { ...base, armed: false, inertReason: 'NS_EVENTS=auto and RINGOTEL_API_KEY is not set' };
  }

  return { ...base, armed: true };
}

/**
 * Null when the config is valid; a loud message otherwise. Fires **only** for an explicit `NS_EVENTS=on`
 * or a genuinely malformed value — never merely because the feature could not be armed. Wiring this into
 * the Worker's config-error gates any other way would 500 every route on an unconfigured deploy.
 */
export function nsEventsConfigError(env: NsEventsEnv): string | null {
  try {
    parseNsEventsConfig(env);
    return null;
  } catch (e) {
    if (e instanceof NsEventsConfigError) return `NetSapiens events config misconfigured: ${e.message}`;
    throw e;
  }
}

/**
 * Is this domain in scope for event handling? Applies the wildcard and the write rail together, so the
 * receiver and the reconciler can never disagree about scope.
 *
 * Call only on a domain that has already passed {@link isValidEventDomain} — this answers "is it allowed",
 * not "is it well-formed".
 */
export function isDomainEnabled(cfg: NsEventsConfig, domain: string): boolean {
  const d = domain.toLowerCase();
  if (cfg.domains !== '*') return cfg.domains.includes(d);
  return cfg.writeRail === '*' || cfg.writeRail.includes(d);
}

// ── receiver ──────────────────────────────────────────────────────────────────────────────────────────

/** Path prefix for the receiver. The full shape is `/ns-events/{token}/{domain}`. */
export const NS_EVENTS_PREFIX = '/ns-events/';

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Per-domain path token, `HMAC-SHA256(masterSecret, domain)` as hex.
 *
 * Deriving per domain rather than sharing one literal secret means a leaked callback URL exposes one
 * tenant, not the master and therefore the whole fleet. It costs no storage: the receiver recomputes the
 * expected token from the domain in the path.
 *
 * The URL is a **capability, not a password** — NetSapiens stores it, returns it from `GET /subscriptions`
 * to any holder of the reseller key, and logs it. Rotating the master requires PUTting every
 * subscription's `post-url` (which is why the planner has a `repair-url` action) before the old URLs die.
 */
export async function derivePathToken(masterSecret: string, domain: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(masterSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(domain.toLowerCase())));
}

/** Constant-time-ish string compare. Length is compared first, which leaks only length — fine for a
 *  high-entropy derived token, and the same trade the SSO worker already makes for Basic auth. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface EventRequestVerdict {
  ok: boolean;
  /** Machine-readable outcome for logs. */
  reason: string;
  domain?: string;
  correlationId?: string;
}

/**
 * Verify an inbound event POST. Fail-closed at every step; the response body must stay opaque regardless.
 *
 * Order matters: the domain grammar runs before the token is derived, so a hostile value never reaches
 * `crypto.subtle` or any API path, and the allowlist check runs before any work is done.
 */
export async function verifyEventRequest(
  request: Request,
  cfg: NsEventsConfig,
  clientIpValue: string,
): Promise<EventRequestVerdict> {
  if (!cfg.armed) return { ok: false, reason: 'not-armed' };
  if (request.method !== 'POST') return { ok: false, reason: 'bad-method' };

  const url = new URL(request.url);
  if (!url.pathname.startsWith(NS_EVENTS_PREFIX)) return { ok: false, reason: 'bad-path' };
  const rest = url.pathname.slice(NS_EVENTS_PREFIX.length).split('/');
  if (rest.length !== 2) return { ok: false, reason: 'bad-path-shape' };
  const [token, rawDomain] = rest as [string, string];
  if (!token || !rawDomain) return { ok: false, reason: 'bad-path-shape' };

  // Grammar FIRST — before deriving, before any API path is built.
  let domain: string;
  try {
    domain = decodeURIComponent(rawDomain);
  } catch {
    return { ok: false, reason: 'bad-domain-encoding' };
  }
  if (rawDomain !== domain) return { ok: false, reason: 'bad-domain-encoding' };
  if (!isValidEventDomain(domain)) return { ok: false, reason: 'bad-domain' };
  if (!isDomainEnabled(cfg, domain)) return { ok: false, reason: 'domain-not-enabled' };

  const expected = await derivePathToken(cfg.pathSecret, domain);
  if (!safeEqual(token, expected)) return { ok: false, reason: 'bad-token' };

  if (cfg.allowIps.length && !cfg.allowIps.includes(clientIpValue.toLowerCase())) {
    return { ok: false, reason: 'ip-not-allowed' };
  }

  // Advisory only: the derived token is the gate. Observed real IDs are 32 lowercase hex, but a hard
  // format rule here would drop every delivery if that ever varied.
  const correlationId = request.headers.get('X-Correlation-ID') ?? '';
  return { ok: true, reason: 'ok', domain, ...(correlationId ? { correlationId } : {}) };
}

// ── payload decoding ──────────────────────────────────────────────────────────────────────────────────

/** A user the batch says changed. Only identity — every value is re-read from the API. */
export interface ChangedUser {
  domain: string;
  ext: string;
}

export interface DecodedBatch {
  users: ChangedUser[];
  /** Events seen in the payload, before coalescing or capping. */
  total: number;
  /** True ⇒ the cap was hit and events were dropped; log it, never fail silently. */
  truncated: boolean;
  /** Events whose extension could not be identified at all. */
  unidentified: number;
  /** Events whose payload domain disagreed with the path domain (dropped). */
  domainMismatch: number;
  /** Events carrying no domain field — allowed, since the path domain is already verified. */
  domainAbsent: number;
}

/**
 * Extension spellings, **v1 `snake_case` first** because that is what the wire actually carries. Verified
 * against a real `subscriber` event: `user` and `aor_user` are present, and `subscriber_login` is
 * `<ext>@<domain>` (not an email address). The v2 record read afterwards happens to spell these the same.
 */
const EXT_KEYS = ['user', 'aor_user'] as const;
/** Domain spellings, likewise v1-first: `domain`, plus `aor_host` and `dial_plan` seen carrying it. */
const DOMAIN_KEYS = ['domain', 'aor_host', 'dial_plan'] as const;

function firstString(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function extFromLogin(rec: Record<string, unknown>): string | undefined {
  const login = rec['subscriber_login'];
  if (typeof login !== 'string' || !login.includes('@')) return undefined;
  const ext = login.slice(0, login.lastIndexOf('@')).trim();
  return ext || undefined;
}

function domainFromLogin(rec: Record<string, unknown>): string | undefined {
  const login = rec['subscriber_login'];
  if (typeof login !== 'string' || !login.includes('@')) return undefined;
  const d = login.slice(login.lastIndexOf('@') + 1).trim();
  return d || undefined;
}

/**
 * Decode a batch into the distinct users that changed.
 *
 * NetSapiens delivers "an array of objects". Coalescing happens **here, inside the batch** — the
 * cross-request cache debounce cannot help within a single delivery, so without this a batch touching one
 * user ten times would cost ten API reads and ten Ringotel writes.
 *
 * The payload-domain check is *authoritative if present, skipped if absent* (and logged either way). A
 * fail-closed check on a field whose spelling we might not know would silently drop exactly the events we
 * need in order to learn the shape — the mistake the SSO worker already made and fixed.
 */
export function decodeEventBatch(body: unknown, pathDomain: string, maxEvents: number): DecodedBatch {
  const events = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  const out: ChangedUser[] = [];
  const seen = new Set<string>();
  let unidentified = 0;
  let domainMismatch = 0;
  let domainAbsent = 0;
  let truncated = false;

  for (const raw of events) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      unidentified++;
      continue;
    }
    const rec = raw as Record<string, unknown>;

    const evDomainRaw = firstString(rec, DOMAIN_KEYS) ?? domainFromLogin(rec);
    if (evDomainRaw === undefined) {
      domainAbsent++;
    } else if (evDomainRaw.toLowerCase().replace(/\.+$/, '') !== pathDomain) {
      domainMismatch++;
      continue;
    }

    // Requires at least one alphanumeric character (fix-wave S1, 2026-07-31): the plain
    // `[A-Za-z0-9._-]{1,32}` grammar also accepted pure dot-segments (`.`, `..`, `...`), which
    // `encodeURIComponent` leaves untouched but `new URL(...)` (inside `NsClient.get`) normalises — so
    // `/domains/x/users/..` would resolve to `GET /domains/x/` and `/users/.` to the full user list. Not
    // exploitable to deactivate anyone (it can't manufacture a 404 for a live user, and the response here
    // is discarded), but it contradicts this branch's own strict-grammar-before-any-API-path stance.
    const ext = firstString(rec, EXT_KEYS) ?? extFromLogin(rec);
    if (!ext || !/^(?=[^A-Za-z0-9]*[A-Za-z0-9])[A-Za-z0-9._-]{1,32}$/.test(ext)) {
      unidentified++;
      continue;
    }

    const key = `${pathDomain}\u0000${ext}`;
    if (seen.has(key)) continue;
    if (out.length >= maxEvents) {
      truncated = true;
      continue;
    }
    seen.add(key);
    out.push({ domain: pathDomain, ext });
  }

  return { users: out, total: events.length, truncated, unidentified, domainMismatch, domainAbsent };
}

/** Shape-only diagnostic for an unfamiliar payload: keys and sizes, never values. */
export function diagShape(body: unknown, request: Request): Record<string, unknown> {
  const events = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  const first = events[0];
  return {
    isArray: Array.isArray(body),
    batchSize: events.length,
    topLevelKeys: first && typeof first === 'object' ? Object.keys(first as object).sort() : [],
    headerNames: [...request.headers.keys()].filter((h) => h.toLowerCase() !== 'authorization').sort(),
    contentType: request.headers.get('content-type'),
  };
}

// ── subscription reconciliation ───────────────────────────────────────────────────────────────────────

/** The callback URL for one (domain) — the token is derived, so this is async. */
export async function callbackUrlFor(cfg: NsEventsConfig, domain: string): Promise<string> {
  const token = await derivePathToken(cfg.pathSecret, domain);
  return `${cfg.baseUrl}${NS_EVENTS_PREFIX}${token}/${domain}`;
}

/**
 * The discovered-domain scope EVERY consumer of a `'*'`-configured discovered list must agree on — today
 * that's the subscription reconciler (`desiredSubscriptions`, below) and the hourly orphan sweep
 * (`runOrphanSweep` in worker.ts). The discovered list comes from Ringotel branch `address` fields —
 * operator-entered data, never validated — so both predicates below are required, and dropping either one
 * silently changes which population a `'*'`-scoped feature acts on:
 *
 *  - **`isValidEventDomain` is the grammar check.** It rejects `~`, `*`, `/`, `%`, and `..`. `~` matters
 *    specifically: it is NetSapiens' own domain **self-reference wildcard**, and `encodeURIComponent`
 *    leaves it untouched, so a discovered value of literal `~` would silently resolve a privileged
 *    `/domains/~/users` read to the CREDENTIAL's own domain rather than to any real tenant — not an
 *    error, a wrong answer that looks like a right one.
 *  - **`isDomainEnabled` is the authorisation check** — the write rail (`RINGOTEL_WRITE_DOMAINS`), which a
 *    grammatically-valid domain can still fail if it's outside what this deployment is allowed to touch.
 *
 * Neither predicate alone is enough. This is the ONE place either is composed for a discovered list —
 * every caller MUST route through here rather than re-composing the pair, which is what let one of the
 * two call sites drift and lose the grammar half. See this branch's fix-wave report for the incident.
 */
export function sweepScope(cfg: NsEventsConfig, discovered: string[]): string[] {
  return [...new Set(discovered.map((d) => d.toLowerCase()))].filter((d) => isValidEventDomain(d) && isDomainEnabled(cfg, d)).sort();
}

/**
 * Every (domain, model) pair we want to exist, with its derived callback URL.
 *
 * When `domains` is `'*'`, `discovered` supplies the concrete list — the caller passes the NS domains that
 * resolve to exactly one Ringotel organization, which is the set where a sync has anything to do. A
 * wildcard can never be sent to the API as `domain: '*'`: that requires Super User scope, and it would
 * subscribe to domains with no Ringotel presence at all.
 */
export async function desiredSubscriptions(cfg: NsEventsConfig, discovered: string[] = []): Promise<DesiredSubscription[]> {
  const scope = cfg.domains === '*' ? sweepScope(cfg, discovered) : cfg.domains;
  const out: DesiredSubscription[] = [];
  for (const domain of scope) {
    const postUrl = await callbackUrlFor(cfg, domain);
    for (const model of cfg.models) out.push({ domain, model, postUrl });
  }
  return out;
}

/** The prefix that marks a subscription as ours. Host-distinct per env, which is what keeps the dev and
 *  prod reconcilers from fighting over each other's subscriptions. */
export const ownedPrefix = (cfg: NsEventsConfig): string => `${cfg.baseUrl}${NS_EVENTS_PREFIX}`;

export interface ReconcileResult {
  actions: SubscriptionAction[];
  applied: number;
  failed: number;
  /** Set when the run was abandoned without applying anything. */
  aborted?: string;
  logs: Record<string, unknown>[];
}

/**
 * Execute a plan. Read failures **abort the whole run** rather than degrading: with no local registry the
 * API listing *is* the source of truth, so a partial read would make "nothing exists" indistinguishable
 * from "could not read" and mass-create duplicates.
 */
export async function applySubscriptionPlan(
  client: Pick<NsSubscriptionsClient, 'create' | 'update' | 'remove'>,
  actions: SubscriptionAction[],
  cfg: NsEventsConfig,
  nowMs: number,
): Promise<ReconcileResult> {
  const logs: Record<string, unknown>[] = [];
  let applied = 0;
  let failed = 0;
  const expiresAt = nsDatetime(new Date(nowMs + cfg.targetLifetimeSeconds * 1000));

  for (const a of actions) {
    try {
      switch (a.kind) {
        case 'create':
          await client.create({
            model: a.model,
            postUrl: a.postUrl,
            domain: a.domain,
            user: '*',
            // Explicit, both because the documented default is wrong (omitting yields "no") and because
            // redundant delivery is what makes a source-IP allowlist unnecessary.
            geoSupport: cfg.geoSupport,
            expiresAt,
            ...(cfg.preferredServer ? { preferredServer: cfg.preferredServer } : {}),
          });
          applied++;
          logs.push({ act: 'create', domain: a.domain, model: a.model, reason: a.reason });
          break;
        case 'renew':
          await client.update(a.id, { expiresAt });
          applied++;
          logs.push({ act: 'renew', domain: a.domain, id: a.id, reason: a.reason });
          break;
        case 'repair-url':
          await client.update(a.id, { postUrl: a.postUrl });
          applied++;
          logs.push({ act: 'repair-url', domain: a.domain, id: a.id, reason: a.reason });
          break;
        case 'delete':
          // `a.domain` is typed `string` (SubscriptionAction has no way to express "none"), but
          // `planInertCleanup` maps a subscription the API returned with no domain to `''` (fix-wave F5,
          // 2026-07-31). The library only omits `domain` from the wire body when the option key is
          // absent, not merely falsy — `{ domain: '' }` would still send an empty-string domain, which
          // NetSapiens may reject, leaving a permanently-retried failed delete in the hourly log. Omit the
          // option entirely when there is nothing real to send.
          await client.remove(a.id, a.domain ? { domain: a.domain } : {});
          applied++;
          logs.push({ act: 'delete', domain: a.domain, id: a.id, reason: a.reason });
          break;
        case 'report':
          logs.push({ act: 'report', domain: a.domain, id: a.id, reason: a.reason, status: a.status, errorCount: a.errorCount, postsCount: a.postsCount });
          break;
        case 'noop':
          break;
      }
    } catch (e) {
      failed++;
      // A 409 on create means a matching subscription already exists — the desired state, reached by
      // someone else. Not a failure.
      const status = (e as { status?: number }).status;
      if (a.kind === 'create' && status === 409) {
        failed--;
        applied++;
        logs.push({ act: 'create', domain: a.domain, outcome: 'already-exists' });
      } else {
        logs.push({ act: a.kind, domain: a.domain, outcome: 'error', status, error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
  }
  return { actions, applied, failed, logs };
}

/**
 * Every action needed to unsubscribe this deployment entirely: delete what our prefix owns, and plan
 * nothing else.
 *
 * ⚠️ **The prefix test is the whole safety property.** Other integrations legitimately subscribe to the
 * same domains on the same cluster, and a delete-only pass that selected too broadly would silently
 * dismantle them. The prefix is host-distinct per environment, which is also what stops dev and prod
 * deleting each other's subscriptions — the same rule `planSubscriptions` already applies via
 * `ownedPrefix`, kept identical here on purpose.
 */
export function planInertCleanup(actual: Subscription[], prefix: string): SubscriptionAction[] {
  return actual
    .filter((s) => typeof s.postUrl === 'string' && s.postUrl.startsWith(prefix))
    .map((s) => ({
      kind: 'delete' as const,
      id: s.id,
      domain: s.domain ?? '',
      reason: 'feature inert — cleaning up after ourselves',
    }));
}

/** Health snapshot for logging — the fields worth watching, per subscription. */
export function healthLine(s: Subscription): Record<string, unknown> {
  return {
    id: s.id,
    domain: s.domain,
    model: s.model,
    status: s.status,
    errorCount: s.errorCount,
    postsCount: s.postsCount,
    activeServer: s.currentActiveServer,
    expires: s.expiresAt,
  };
}

// ── locate the connection a record actually sits on ──────────────────────────────────────────────────

/** Which connection an extension's record sits on. */
export type ConnectionLocation =
  | { kind: 'one'; branchid: string }
  | { kind: 'none' }
  | { kind: 'conflict'; branchids: string[] };

/**
 * PURE: find the connection holding this extension's record.
 *
 * Offboarding, identity sync and device repair each act on ONE connection, and on a multi-connection
 * domain the right one is wherever the record already is. That is knowable — unlike where a *new*
 * record should be created, which is a policy decision this deliberately does not make.
 *
 * Records on more than one connection are a **conflict**, reported rather than resolved: whichever we
 * picked, the write would land on a seat we had no basis to prefer. Two records on the SAME connection
 * are a duplicate, not a conflict — `resolveCanonical` already owns that case and is better at it.
 *
 * Attached secondaries (`userid` set) are skipped: they share a primary's app login and are never the
 * record an event should act on.
 */
export function locateConnection(
  users: { extension?: unknown; branchid?: unknown; userid?: unknown }[],
  branchids: string[],
  ext: string,
): ConnectionLocation {
  const wanted = new Set(branchids);
  const want = String(ext).trim();
  const found = new Set<string>();
  for (const u of users) {
    if (u.userid != null) continue;
    const b = String(u.branchid ?? '');
    if (!wanted.has(b)) continue;
    if (String(u.extension ?? '').trim() !== want) continue;
    found.add(b);
  }
  if (found.size === 0) return { kind: 'none' };
  if (found.size === 1) return { kind: 'one', branchid: [...found][0]! };
  return { kind: 'conflict', branchids: [...found].sort() };
}
