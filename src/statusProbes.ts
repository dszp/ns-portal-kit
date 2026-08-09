/**
 * On-demand live checks for the integration console — the only I/O this feature performs. Everything else in
 * `status.ts`/`statusModel.ts` answers "is this configured"; `runProbes` answers "does this actually
 * work", by making a small, bounded set of real upstream calls when a human clicks the button
 * (`?probe=1`).
 *
 * Three rules shape every probe here:
 *
 * 1. **`runProbes` must never reject.** A diagnostic panel that throws takes down the very page meant to
 *    explain a broken deployment. Every probe runs through {@link guarded}, which converts an escaping
 *    exception into a `fail` result — belt-and-braces on top of each probe's own try/catch, so this
 *    holds even if a probe's internal handling has a gap.
 * 2. **No `detail` string may carry a credential, a key, or a raw upstream response/error body.** An
 *    upstream error message can quote the request it failed on, and Ringotel/NetSapiens both echo up
 *    to 500 chars of response body into their thrown errors' `.message`. So no probe here ever
 *    interpolates a caught error's `.message` into a result — only an HTTP status code (never a secret)
 *    plus this module's own wording.
 * 3. **Sequential, bounded, and cheap.** Six probes run one after another (a human-triggered button,
 *    not a hot path). The Ringotel probe is one `getOrganizations()` call — never the fleet-wide
 *    `buildOrgBranchIndex` dig. The events probe is exactly what production's own reconcile does: one
 *    flat `NsSubscriptionsClient.list()` call, partitioned by `ownedPrefix` — never a per-domain
 *    fan-out. (An earlier draft of this probe called `listForDomain` once per configured domain, capped
 *    at 10. That was wrong: the domain-scoped route it used 404s on this fleet, so it would have
 *    reported a healthy deployment as broken — the exact failure this feature exists to prevent. It also
 *    tested a code path production never uses. Fixed to mirror the reconcile instead.)
 *
 * The events probe additionally depends on the identity probe: it never attempts a read that cannot
 * authenticate, and reports why (`skip`) rather than a confusing downstream failure.
 */
import { NsClient, NsApiError, assertBareServer, NsSubscriptionsClient } from '@dszp/netsapiens-lib';
import { RingotelReadClient, RingotelApiError } from '@dszp/ringotel-lib';

import { PROBE_CATALOG, probeCatalogFor } from './statusModel.js';
import type { ProbeResult, ProbeCatalogEntry } from './statusModel.js';
import type { StatusEnv } from './status.js';
import { ringotelEnabled } from './ringotel.js';
import { resolveWriteIdentity, parseNsEventsConfig, ownedPrefix, type NsEventsConfig } from './nsEvents.js';
import { getServiceToken, NsIdentityError } from './nsIdentity.js';

export interface ProbeCtx {
  /** NS API host — the same value the rest of the Worker reads from `env.NS_SERVER`. */
  server: string;
  /** The caller's own delegated `ns_t`, if any. Null ⇒ the read probe skips. */
  token: string | null;
  /** The domain in scope for this session, if any. Null ⇒ the read probe skips. */
  domain: string | null;
}

/** {@link PROBE_CATALOG} is the contract this module and the Checks tab BOTH render against; it lives in
 *  `statusModel.ts` (pure data) so the page can describe the checks without importing this I/O module. */
const CATALOG_BY_ID: Record<string, ProbeCatalogEntry> = Object.fromEntries(PROBE_CATALOG.map((c) => [c.id, c]));

type ProbeOutcome = Pick<ProbeResult, 'state' | 'detail'>;

/** A string reports set when non-blank; a binding/other value reports set when non-null. Mirrors
 *  `status.ts`'s own `isSet` — kept as a small local copy rather than exporting one more surface from
 *  `status.ts` for a single caller. */
function isSet(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null;
}

/** Run one probe body and normalize it into a full {@link ProbeResult}. ANY exception escaping `fn` —
 *  a bug in the probe as much as an upstream failure — becomes a `fail` result here rather than an
 *  unhandled rejection; see the module doc comment's rule 1. */
async function guarded(id: string, fn: () => Promise<ProbeOutcome>): Promise<ProbeResult> {
  const entry = CATALOG_BY_ID[id]!;
  try {
    const { state, detail } = await fn();
    return { id: entry.id, name: entry.name, cost: entry.cost, state, detail };
  } catch {
    return { id: entry.id, name: entry.name, cost: entry.cost, state: 'fail', detail: `${entry.name} could not be checked — the probe failed unexpectedly.` };
  }
}

/** `GET /ns-api/v2/domains/{ctx.domain}` with the caller's own delegated token. */
async function nsReadProbe(ctx: ProbeCtx): Promise<ProbeOutcome> {
  if (!ctx.token) return { state: 'skip', detail: 'No delegated session token is available to read with.' };
  if (!ctx.domain) return { state: 'skip', detail: 'No domain is resolved for this session to read.' };
  try {
    const client = new NsClient({ server: ctx.server, token: ctx.token });
    await client.get(`/domains/${encodeURIComponent(ctx.domain)}`);
    return { state: 'pass', detail: 'Read the current domain using this session.' };
  } catch (e) {
    if (e instanceof NsApiError) return { state: 'fail', detail: `NetSapiens rejected the read (HTTP ${e.status}).` };
    return { state: 'fail', detail: 'Could not reach the NetSapiens API.' };
  }
}

/** One `getOrganizations()` call — no per-org fan-out, never `buildOrgBranchIndex`. */
async function ringotelProbe(env: StatusEnv): Promise<ProbeOutcome> {
  if (!ringotelEnabled(env)) return { state: 'skip', detail: 'RINGOTEL_API_KEY is not set.' };
  try {
    const client = new RingotelReadClient({ token: env.RINGOTEL_API_KEY!, ...(env.RINGOTEL_BASE_URL ? { baseUrl: env.RINGOTEL_BASE_URL } : {}) });
    const orgs = await client.getOrganizations();
    return { state: 'pass', detail: `Reached the Ringotel AdminAPI (${orgs.length} organization${orgs.length === 1 ? '' : 's'} visible).` };
  } catch (e) {
    if (e instanceof RingotelApiError) return { state: 'fail', detail: `Ringotel rejected the request (HTTP ${e.status}).` };
    return { state: 'fail', detail: 'Could not reach the Ringotel AdminAPI.' };
  }
}

/** Mint the background service identity via `nsIdentity.ts` — the same precedence (admin wins over
 *  API key) and the same OAuth-pair precondition every other consumer of that module shares. Skips only
 *  when NOTHING is configured; an identity that is configured but can't actually mint (admin creds with
 *  no OAuth client pair) is attempted and reported as a `fail`, since that is a real, fixable gap. */
async function nsIdentityProbe(env: StatusEnv): Promise<ProbeOutcome> {
  const identity = resolveWriteIdentity(env);
  if (!identity) return { state: 'skip', detail: 'Neither NS_API_KEY nor NS_ADMIN_USER/NS_ADMIN_PASS is set.' };
  try {
    await getServiceToken(identity, env);
    // The two paths are NOT equally verified, and the wording must say so. For 'admin', `getServiceToken`
    // performs a real OAuth password grant — reaching this line means NetSapiens itself accepted the
    // credential, so "Minted" is an earned claim. For 'api', `getServiceToken` returns the configured
    // token straight back with no network call at all (this catalog entry's own `cost` says so: "nothing
    // over the network for an API key") — so reaching this line proves only that NS_API_KEY is non-empty,
    // never that NetSapiens will accept it. `pass` still fits (presence is a true, checkable fact — unlike
    // the unconfigured case above, which is `skip`), but the detail must not upgrade presence into
    // readiness the way "present and ready to use" did.
    return {
      state: 'pass',
      detail: identity.kind === 'admin'
        ? 'Minted an OAuth access token for the admin-credential identity — NetSapiens accepted it.'
        : 'NS_API_KEY is present, but not exercised — nothing was called, so this does not prove NetSapiens will accept it.',
    };
  } catch (e) {
    if (e instanceof NsIdentityError) return { state: 'fail', detail: 'The admin-credential identity is missing NS_OAUTH_CLIENT_ID/NS_OAUTH_CLIENT_SECRET.' };
    return { state: 'fail', detail: 'Could not mint a token for the service identity.' };
  }
}

/**
 * `parseNsEventsConfig`'s `inertReason` is not one shape: the missing-config case (`nsEvents.ts` line
 * ~311) already reads as a complete "not armed" sentence — `NetSapiens event subscriptions not armed —
 * missing: X, Y` — while the other two (`NS_EVENTS=off`, `NS_EVENTS=auto and RINGOTEL_API_KEY is not
 * set`) are bare setting values with no verb at all. Prefixing "Event subscriptions are not armed — "
 * unconditionally onto all three used to double the phrase for the first case: "Event subscriptions are
 * not armed — NetSapiens event subscriptions not armed — missing: …". So: use `inertReason` alone
 * (period added) when it already says "not armed" itself; otherwise lead with our own "not armed" so the
 * bare setting value reads as a sentence.
 */
function eventsNotArmedDetail(inertReason: string | undefined): string {
  if (!inertReason) return 'Event subscriptions are not armed.';
  if (/not armed/i.test(inertReason)) return `${inertReason}.`;
  return `Event subscriptions are not armed — ${inertReason}.`;
}

/**
 * One flat `list()` read — the same call `runNsEventsReconcile` (`worker.ts`) makes before planning —
 * partitioned by {@link ownedPrefix} into "ours" vs. everything else, exactly as the reconcile's own
 * `mine` filter does. No per-domain fan-out and no domain-scoped route: `listForDomain` uses
 * `/domains/{domain}/subscriptions`, which is not present on every NetSapiens cluster and would report a
 * perfectly healthy deployment as broken wherever it 404s — precisely the failure this whole feature
 * exists to prevent. Using the same call the reconcile depends on also means a `pass` here means
 * something about production, not about a route production never touches.
 *
 * Skips unless the config is armed AND the identity probe passed — a read that cannot authenticate would
 * only produce a confusing failure, not a useful one.
 *
 * A `NS_EVENTS_DOMAINS=*` wildcard no longer needs resolving into a concrete list: with the full
 * subscription set already in hand from the one `list()` call, "does this work" is just "is at least one
 * subscription ours" — no Ringotel directory dig required.
 */
async function nsEventsProbe(env: StatusEnv, identityPassed: boolean): Promise<ProbeOutcome> {
  let cfg: NsEventsConfig;
  try {
    cfg = parseNsEventsConfig(env);
  } catch {
    return { state: 'skip', detail: 'Event subscription configuration is invalid — see the config errors above.' };
  }
  if (!cfg.armed) {
    return { state: 'skip', detail: eventsNotArmedDetail(cfg.inertReason) };
  }
  if (!identityPassed) {
    return { state: 'skip', detail: 'Not checked — the NetSapiens service identity probe did not pass.' };
  }

  let token: string;
  try {
    token = await getServiceToken(cfg.identity!, env); // armed ⇒ identity resolved (parseNsEventsConfig's own check)
  } catch {
    return { state: 'fail', detail: 'Could not mint the service identity token for this check.' };
  }

  const subs = new NsSubscriptionsClient({ server: assertBareServer(env.NS_SERVER), token });
  let actual;
  try {
    actual = await subs.list();
  } catch (e) {
    const status = e instanceof NsApiError ? e.status : 0;
    return { state: 'fail', detail: `Could not list NetSapiens event subscriptions (HTTP ${status || 'unknown'}).` };
  }

  const prefix = ownedPrefix(cfg);
  const ours = actual.filter((s) => (s.postUrl ?? '').startsWith(prefix));

  if (cfg.domains === '*') {
    if (ours.length > 0) {
      return { state: 'pass', detail: `${ours.length} owned subscription${ours.length === 1 ? '' : 's'} found (${actual.length} total on the account).` };
    }
    return {
      state: 'fail',
      detail: `No owned subscriptions found (${actual.length} total on the account) — an armed wildcard deployment should have reconciled at least one.`,
    };
  }

  const oursByDomain = new Set(ours.map((s) => (s.domain ?? '').toLowerCase()));
  const missing = cfg.domains.filter((d) => !oursByDomain.has(d.toLowerCase()));
  const covered = cfg.domains.length - missing.length;
  const summary = `${covered} of ${cfg.domains.length} configured domain${cfg.domains.length === 1 ? '' : 's'} have an owned subscription (${actual.length} total, ${ours.length} ours)`;
  if (missing.length === 0) return { state: 'pass', detail: `${summary}.` };
  return { state: 'fail', detail: `${summary} — missing: ${missing.join(', ')}.` };
}

/**
 * Call `STATUS_BANNER_WEBHOOK` the way the injected code does and grade the reply.
 *
 * The four outcomes are deliberately distinct, because they have different fixes and the middle two are
 * the ones nothing else surfaces: unreachable is a URL or a network problem, non-2xx is the endpoint
 * refusing, and 2xx-with-no-recognised-key is an endpoint that WORKS and still renders nothing. That last
 * one cost a live capture to diagnose -- it looks exactly like the feature being switched off.
 *
 * The accepted keys are NAMED in the failure text rather than described, because "the body has no message
 * field" is not actionable when four field names are accepted and the endpoint author guessed a fifth.
 *
 * This spends the caller's own `ns_t` against a third-party endpoint, which is why it sits behind the
 * button with the other on-demand checks rather than running on tab open. Same 4s ceiling the JWT check
 * uses: a hung endpoint must not hold the console open.
 */
const BANNER_KEYS = ['message', 'banner_message', 'text', 'banner'] as const;

async function statusBannerProbe(env: StatusEnv, ctx: ProbeCtx): Promise<ProbeOutcome> {
  const url = (env.STATUS_BANNER_WEBHOOK ?? '').trim();
  if (!url) return { state: 'skip', detail: 'STATUS_BANNER_WEBHOOK is not set — nothing is requested and no banner is drawn.' };
  if (!/^https:\/\//i.test(url)) return { state: 'fail', detail: 'STATUS_BANNER_WEBHOOK is not an https URL, so the injected code will not call it.' };
  if (!ctx.token) return { state: 'skip', detail: 'No delegated session token is available to send, and this endpoint is called with one.' };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ validate: ctx.token, path: '/portal/home', domain: ctx.domain, scope_mode: null, sub_scope: null, user: null }),
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    return { state: 'fail', detail: 'Could not reach the endpoint — it did not respond, or the request timed out.' };
  }
  if (!res.ok) return { state: 'fail', detail: `The endpoint answered HTTP ${res.status}. The injected code treats any non-2xx as "no banner".` };

  let raw = '';
  try { raw = await res.text(); } catch { return { state: 'fail', detail: 'The endpoint answered 2xx but the body could not be read.' }; }
  if (!raw.trim()) return { state: 'pass', detail: 'Reachable, and answered 2xx with an empty body — which is how a notice is taken down. No banner will be drawn.' };

  // Same acceptance the injected code applies: a bare string, or JSON carrying one of the known keys.
  let msg = '';
  try {
    const j: unknown = JSON.parse(raw);
    if (typeof j === 'string') msg = j;
    else if (j && typeof j === 'object') {
      for (const k of BANNER_KEYS) {
        const v = (j as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.trim()) { msg = v; break; }
      }
    }
  } catch { msg = raw; }

  msg = String(msg || '').trim();
  if (!msg) {
    return { state: 'fail', detail: `The endpoint answered 2xx, but no message could be found in the reply. Send plain text, or JSON with one of: ${BANNER_KEYS.join(', ')}.` };
  }
  const shown = msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
  return { state: 'pass', detail: `Reachable, and returned a usable message: "${shown}"` };
}

/** Always `skip` — neither integration exists in this Worker. */
function onebillDocumoProbeResult(): ProbeResult {
  const entry = CATALOG_BY_ID['onebill-documo']!;
  return { id: entry.id, name: entry.name, cost: entry.cost, state: 'skip', detail: 'OneBill and Documo are not integrated into this Worker — there is nothing to check.' };
}

/**
 * Run every probe, sequentially, and return one result per {@link PROBE_CATALOG} entry. Never rejects
 * (see the module doc comment) — every failure mode, upstream or internal, becomes a `fail` ProbeResult.
 */
export async function runProbes(env: StatusEnv, ctx: ProbeCtx): Promise<ProbeResult[]> {
  const nsRead = await guarded('ns-read', () => nsReadProbe(ctx));
  const nsIdentity = await guarded('ns-identity', () => nsIdentityProbe(env));
  const ringotel = await guarded('ringotel', () => ringotelProbe(env));
  const nsEvents = await guarded('ns-events', () => nsEventsProbe(env, nsIdentity.state === 'pass'));
  const banner = await guarded('status-banner', () => statusBannerProbe(env, ctx));
  const onebillDocumo = onebillDocumoProbeResult();
  // Access gates the STANDALONE deployment's stored token; a portal-mode Worker has no stored credential
  // for it to protect, and an Access gate in front of one would refuse the plain <script src> that loads
  // the injected primary. So the row is not merely inert here, it describes a control this deployment
  // could not adopt -- and a check for it implies otherwise. The Config tab already removed the Access
  // SETTINGS in portal mode for the same reason; this is the half that was missed.
  const wanted = new Set(probeCatalogFor().map((c) => c.id));
  const all = [nsRead, nsIdentity, ringotel, nsEvents, banner, onebillDocumo];
  return all.filter((r) => wanted.has(r.id));
}
