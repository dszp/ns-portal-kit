/**
 * Selftests for NetSapiens event subscriptions: arming, domain grammar, derived path tokens, receiver
 * verification, payload decoding, and plan execution. Fully offline.
 *
 * Run: pnpm test:nsevents
 */
import {
  parseNsEventsConfig,
  nsEventsConfigError,
  NsEventsConfigError,
  isValidEventDomain,
  derivePathToken,
  safeEqual,
  verifyEventRequest,
  decodeEventBatch,
  diagShape,
  callbackUrlFor,
  desiredSubscriptions,
  sweepScope,
  ownedPrefix,
  isDomainEnabled,
  applySubscriptionPlan,
  planInertCleanup,
  NS_EVENTS_PREFIX,
  locateConnection,
  type NsEventsEnv,
  type NsEventsConfig,
} from './nsEvents.js';
import type { SubscriptionAction } from '@dszp/netsapiens-lib';

let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${m}`);
};

const FULL: NsEventsEnv = {
  NS_EVENTS_DOMAINS: 'acme.example.com,baredomain',
  NS_EVENTS_BASE_URL: 'https://portal.example.com',
  NS_EVENTS_PATH_SECRET: 'master-secret-with-plenty-of-entropy',
  NS_API_KEY: 'nsr_key',
  RINGOTEL_API_KEY: 'rt_key',
  RINGOTEL_WRITE_DOMAINS: '*',
};

// ── arming matrix (the regression this guards is a prod-wide 500) ──────────────
{
  const c = parseNsEventsConfig(FULL);
  ok(c.armed && c.intent === 'auto', 'auto + complete config + Ringotel key ⇒ ARMED (default-on as required)');
  ok(nsEventsConfigError(FULL) === null, 'a valid armed config reports no error');
}
{
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_BASE_URL: undefined });
  ok(!c.armed, 'auto + missing base URL ⇒ inert');
  ok((c.inertReason ?? '').includes('NS_EVENTS_BASE_URL'), 'the inert reason names what is missing');
  ok(nsEventsConfigError({ ...FULL, NS_EVENTS_BASE_URL: undefined }) === null, 'auto + missing config is NOT a config error — this is what prevents a 500 on every route');
}
{
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_PATH_SECRET: undefined, NS_API_KEY: undefined });
  ok(!c.armed && (c.inertReason ?? '').includes('NS_EVENTS_PATH_SECRET'), 'auto + missing secret and identity ⇒ inert, both named');
  ok((c.inertReason ?? '').includes('NS_API_KEY'), 'the missing identity is named too');
}
{
  let threw = '';
  try {
    parseNsEventsConfig({ ...FULL, NS_EVENTS: 'on', NS_EVENTS_BASE_URL: undefined });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(threw.includes('not armed'), 'explicit on + missing config ⇒ THROWS (the operator asked for it)');
  ok((nsEventsConfigError({ ...FULL, NS_EVENTS: 'on', NS_EVENTS_BASE_URL: undefined }) ?? '').includes('misconfigured'), 'and that surfaces as a config error');
}
{
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS: 'off' });
  ok(!c.armed && c.inertReason === 'NS_EVENTS=off', 'off ⇒ inert kill switch even with complete config');
}
{
  const c = parseNsEventsConfig({ ...FULL, RINGOTEL_API_KEY: undefined });
  ok(!c.armed && (c.inertReason ?? '').includes('RINGOTEL_API_KEY'), 'auto without a Ringotel key ⇒ inert (nothing to sync to)');
  const on = parseNsEventsConfig({ ...FULL, NS_EVENTS: 'on', RINGOTEL_API_KEY: undefined });
  ok(on.armed, 'explicit on does not require a Ringotel key — a future non-Ringotel handler is legal');
}
{
  let threw = '';
  try {
    parseNsEventsConfig({ ...FULL, NS_EVENTS: 'enabled' });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(threw.includes('auto|on|off'), 'a typo in NS_EVENTS throws instead of silently reading as off');
}

// ── domain scope: wildcard allowed, rail always narrows ───────────────────────
{
  // '*' is a deliberate operator choice: every domain the write rail permits.
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_DOMAINS: '*' });
  ok(c.armed && c.domains === '*', 'NS_EVENTS_DOMAINS="*" is accepted and arms the feature');
  ok(isDomainEnabled(c, 'anything.example.com'), 'with "*" and a "*" rail, any domain is in scope');
  const railed = parseNsEventsConfig({ ...FULL, NS_EVENTS_DOMAINS: '*', RINGOTEL_WRITE_DOMAINS: 'acme.example.com' });
  ok(isDomainEnabled(railed, 'acme.example.com'), '"*" still honours the write rail (allowed domain)');
  ok(!isDomainEnabled(railed, 'other.example.com'), '"*" NEVER exceeds the write rail (denied domain)');
}
{
  // Regression test for the sweep's wildcard scope, and for the fact that there is now only ONE place
  // this composition lives: `runOrphanSweep` (worker.ts) and `desiredSubscriptions` (below) both route
  // a '*'-scoped discovered list through the EXPORTED `sweepScope` helper rather than each hand-composing
  // `isValidEventDomain(d) && isDomainEnabled(cfg, d)` — which is exactly how the sweep previously lost
  // the grammar half (see the fix-wave report). This calls the real exported `sweepScope`, not a local
  // reimplementation, so it fails if the helper itself regresses rather than merely asserting something
  // about this test file.
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_DOMAINS: '*', RINGOTEL_WRITE_DOMAINS: '*' });
  const discovered = ['~', '*', 'acme.example.com', 'trailing.example.com.', 'bad domain', 'good.example.com'];
  const scope = sweepScope(c, discovered);
  ok(
    scope.length === 2 && scope.join(',') === 'acme.example.com,good.example.com',
    'sweepScope keeps only the grammar-valid domains out of a mixed discovered list, sorted',
  );
  ok(!scope.includes('~'), 'sweepScope rejects "~" (NS domain self-reference wildcard) even under a wide-open "*" write rail, where isDomainEnabled alone would allow it');
  ok(!scope.includes('*') && !scope.includes('trailing.example.com.') && !scope.includes('bad domain'), 'sweepScope also rejects "*", a trailing dot, and an embedded space');
}
{
  // The write-rail half of the same composition: a grammar-valid domain outside RINGOTEL_WRITE_DOMAINS
  // must still be excluded from sweepScope's output — grammar alone is not authorisation.
  const railed = parseNsEventsConfig({ ...FULL, NS_EVENTS_DOMAINS: '*', RINGOTEL_WRITE_DOMAINS: 'acme.example.com' });
  const scope = sweepScope(railed, ['acme.example.com', 'other.example.com']);
  ok(scope.length === 1 && scope[0] === 'acme.example.com', 'sweepScope also enforces the write rail — a grammar-valid domain outside it is excluded');
}
{
  // A wildcard must expand to real domains: a Reseller key cannot create domain:'*' subscriptions.
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_DOMAINS: '*', RINGOTEL_WRITE_DOMAINS: 'acme.example.com,beta.example.com' });
  const d = await desiredSubscriptions(c, ['ACME.example.com', 'beta.example.com', 'notallowed.example.com', 'acme.example.com']);
  ok(d.length === 2, '"*" expands to the discovered domains, rail-filtered and de-duplicated');
  ok(d.map((x) => x.domain).join(',') === 'acme.example.com,beta.example.com', 'discovery is lowercased and sorted');
  ok(new Set(d.map((x) => x.postUrl)).size === 2, 'each discovered domain still gets its own derived token');
  ok((await desiredSubscriptions(c, [])).length === 0, 'no discovered domains ⇒ nothing desired (never a domain:"*" subscription)');
  ok((await desiredSubscriptions(c, ['~', '*', 'bad domain'])).length === 0, 'discovery output is still grammar-checked');
}
{
  const explicit = parseNsEventsConfig(FULL);
  const d = await desiredSubscriptions(explicit, ['ignored.example.com']);
  ok(d.length === 2 && !d.some((x) => x.domain === 'ignored.example.com'), 'an explicit list ignores discovery entirely');
}
{
  const c = parseNsEventsConfig({ ...FULL, RINGOTEL_WRITE_DOMAINS: 'acme.example.com' });
  ok(c.domains !== '*' && c.domains.length === 1 && c.domains[0] === 'acme.example.com', 'the write rail NARROWS the enabled set');
}
{
  const c = parseNsEventsConfig({ ...FULL, RINGOTEL_WRITE_DOMAINS: 'somewhere.else' });
  ok(!c.armed && c.domains !== '*' && c.domains.length === 0, 'a domain outside the write rail is dropped, leaving the feature inert');
}
{
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_DOMAINS: undefined });
  ok(!c.armed && c.domains !== '*' && c.domains.length === 0, 'no domains configured ⇒ inert (does NOT inherit the rail)');
}
{
  let threw = '';
  try {
    parseNsEventsConfig({ ...FULL, NS_EVENTS_DOMAINS: 'acme.example.com,~' });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(threw.includes('invalid domain'), 'an invalid domain in config throws at parse time');
}
{
  ok(parseNsEventsConfig(FULL).geoSupport === 'yes', "geoSupport defaults to 'yes' — the documented API default is wrong, so we always send it");
  ok(parseNsEventsConfig({ ...FULL, NS_EVENTS_GEO_SUPPORT: 'no' }).geoSupport === 'no', 'geoSupport can be turned off deliberately');
  let threw = '';
  try {
    parseNsEventsConfig({ ...FULL, NS_EVENTS_GEO_SUPPORT: 'true' });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(threw.includes('yes or no'), 'a bad geo value throws');
}
{
  let threw = '';
  try {
    parseNsEventsConfig({ ...FULL, NS_EVENTS_MODELS: 'subscriber,device' });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(threw.includes('unknown model'), 'an unknown model is rejected loudly (there is no device model)');
  ok(parseNsEventsConfig(FULL).models.join(',') === 'subscriber', 'models default to subscriber');
}
{
  let threw = '';
  try {
    parseNsEventsConfig({ ...FULL, NS_EVENTS_TARGET_LIFETIME: '3600', NS_EVENTS_RENEW_HORIZON: '7200' });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(threw.includes('must exceed'), 'a lifetime shorter than the renew horizon throws — otherwise every run renews');
}
{
  for (const bad of ['http://portal.example.com', 'portal.example.com', 'https://p.example.com/?x=1']) {
    let threw = false;
    try {
      parseNsEventsConfig({ ...FULL, NS_EVENTS_BASE_URL: bad });
    } catch {
      threw = true;
    }
    ok(threw, `NS_EVENTS_BASE_URL rejects ${bad}`);
  }
}
{
  const c = parseNsEventsConfig({ ...FULL, NS_ADMIN_USER: 'admin', NS_ADMIN_PASS: 'pw' });
  ok(c.identity?.kind === 'admin', 'admin credentials win over an API key, matching the SSO worker');
  const k = parseNsEventsConfig(FULL);
  ok(k.identity?.kind === 'api', 'an API key alone yields the api identity');
}

// ── domain grammar (C3) ───────────────────────────────────────────────────────
{
  const good = ['acme.example.com', 'baredomain', 'a', 'demo.12345.service', 'x-y.example.com', 'a1.b2'];
  for (const d of good) ok(isValidEventDomain(d), `grammar accepts ${JSON.stringify(d)}`);
  const bad = ['~', '*', '/', '..', '', 'ACME.example.com', 'acme.example.com.', 'a b', '-lead', 'trail-', 'a%2e', 'a/b', 'ünicode', '.leadingdot', 'x'.repeat(65), ' acme', 'acme ', '~/../etc'];
  for (const d of bad) ok(!isValidEventDomain(d), `grammar REJECTS ${JSON.stringify(d)}`);
  ok(!isValidEventDomain(undefined) && !isValidEventDomain(42), 'grammar rejects non-strings');
}

// ── derived token ─────────────────────────────────────────────────────────────
{
  const S = 'master';
  const a = await derivePathToken(S, 'acme.example.com');
  const b = await derivePathToken(S, 'beta.example.com');
  ok(/^[0-9a-f]{64}$/.test(a), 'the derived token is 64 hex chars (HMAC-SHA256)');
  ok(a !== b, 'different domains derive different tokens — one leaked URL is not the master');
  ok(a === (await derivePathToken(S, 'acme.example.com')), 'derivation is deterministic');
  ok(a === (await derivePathToken(S, 'ACME.example.com')), 'derivation is case-insensitive on the domain');
  ok(a !== (await derivePathToken('other', 'acme.example.com')), 'rotating the master changes every token');
}
{
  ok(safeEqual('abc', 'abc') && !safeEqual('abc', 'abd') && !safeEqual('abc', 'ab'), 'safeEqual compares correctly');
  ok(!safeEqual('', 'a') && safeEqual('', ''), 'safeEqual handles empty strings');
}

// ── receiver verification ─────────────────────────────────────────────────────
const CFG: NsEventsConfig = parseNsEventsConfig(FULL);
const DOM = 'acme.example.com';
const TOKEN = await derivePathToken(CFG.pathSecret, DOM);
const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://portal.example.com${path}`, { method: 'POST', headers });

{
  const v = await verifyEventRequest(post(`${NS_EVENTS_PREFIX}${TOKEN}/${DOM}`, { 'x-correlation-id': '0123456789abcdef0123456789abcdef' }), CFG, '203.0.113.7');
  ok(v.ok && v.domain === DOM, 'a correct request verifies and yields the domain');
  ok(v.correlationId === '0123456789abcdef0123456789abcdef', 'the correlation id is captured for logging');
}
{
  const v = await verifyEventRequest(post(`${NS_EVENTS_PREFIX}${TOKEN}/${DOM}`), CFG, '203.0.113.7');
  ok(v.ok, 'a missing correlation id does NOT reject — it is advisory, not the gate');
}
{
  const cases: [string, string][] = [
    [`${NS_EVENTS_PREFIX}${'f'.repeat(64)}/${DOM}`, 'bad-token'],
    [`${NS_EVENTS_PREFIX}short/${DOM}`, 'bad-token'],
    [`${NS_EVENTS_PREFIX}${TOKEN}/~`, 'bad-domain'],
    [`${NS_EVENTS_PREFIX}${TOKEN}/*`, 'bad-domain'],
    [`${NS_EVENTS_PREFIX}${TOKEN}/ACME.example.com`, 'bad-domain'],
    [`${NS_EVENTS_PREFIX}${TOKEN}/other.example.com`, 'domain-not-enabled'],
    [`${NS_EVENTS_PREFIX}${TOKEN}`, 'bad-path-shape'],
    [`${NS_EVENTS_PREFIX}${TOKEN}/${DOM}/extra`, 'bad-path-shape'],
    ['/somewhere-else', 'bad-path'],
  ];
  for (const [path, expected] of cases) {
    const v = await verifyEventRequest(post(path), CFG, '203.0.113.7');
    ok(!v.ok && v.reason === expected, `rejects ${JSON.stringify(path.slice(0, 46))} as ${expected}`);
  }
}
{
  // The `~` hole specifically: NS treats it as the self-wildcard and encodeURIComponent leaves it alone.
  const tildeToken = await derivePathToken(CFG.pathSecret, '~');
  const v = await verifyEventRequest(post(`${NS_EVENTS_PREFIX}${tildeToken}/~`), CFG, '203.0.113.7');
  ok(!v.ok && v.reason === 'bad-domain', 'even a CORRECTLY derived token for "~" is refused by the grammar');
}
{
  const v = await verifyEventRequest(
    new Request(`https://portal.example.com${NS_EVENTS_PREFIX}${TOKEN}/${DOM}`, { method: 'GET' }),
    CFG,
    '203.0.113.7',
  );
  ok(!v.ok && v.reason === 'bad-method', 'a GET is refused');
}
{
  const inert = parseNsEventsConfig({ ...FULL, NS_EVENTS: 'off' });
  const v = await verifyEventRequest(post(`${NS_EVENTS_PREFIX}${TOKEN}/${DOM}`), inert, '203.0.113.7');
  ok(!v.ok && v.reason === 'not-armed', 'an unarmed config refuses everything');
}
{
  const withIps = parseNsEventsConfig({ ...FULL, NS_EVENTS_ALLOW_IPS: '198.51.100.1,2001:db8:4011:1800::9676' });
  const bad = await verifyEventRequest(post(`${NS_EVENTS_PREFIX}${TOKEN}/${DOM}`), withIps, '203.0.113.7');
  ok(!bad.ok && bad.reason === 'ip-not-allowed', 'an allowlist rejects an unlisted IP');
  const good = await verifyEventRequest(post(`${NS_EVENTS_PREFIX}${TOKEN}/${DOM}`), withIps, '2001:DB8:4011:1800::9676');
  ok(good.ok, 'the allowlist matches IPv6 case-insensitively (real deliveries arrive over IPv6)');
}
{
  const tokenForBare = await derivePathToken(CFG.pathSecret, 'baredomain');
  const v = await verifyEventRequest(post(`${NS_EVENTS_PREFIX}${tokenForBare}/baredomain`), CFG, '203.0.113.7');
  ok(v.ok, 'a bare domain with no territory suffix verifies');
  const cross = await verifyEventRequest(post(`${NS_EVENTS_PREFIX}${TOKEN}/baredomain`), CFG, '203.0.113.7');
  ok(!cross.ok && cross.reason === 'bad-token', "one domain's token does not authorize another domain");
}

// ── payload decoding, against the REAL observed shape ─────────────────────────
// Field names verified from a live `subscriber` event: v1 snake_case throughout.
const realEvent = {
  user: '1044',
  aor_user: '1044',
  domain: 'acme.example.com',
  aor_host: 'acme.example.com',
  dial_plan: 'acme.example.com',
  subscriber_login: '1044@acme.example.com',
  subscriber_name: '',
  firstname: 'Demo',
  lastname: 'User4',
  email_address: 'demo4@example.com',
  subscriber_group: 'Support',
  site: '',
  srv_code: '',
  scope: 'Basic User',
  presence: 'inactive',
  last_update: '2026-07-25 07:33:18',
};
{
  const d = decodeEventBatch([realEvent], DOM, 40);
  ok(d.users.length === 1 && d.users[0]!.ext === '1044' && d.users[0]!.domain === DOM, 'the real v1 payload identifies the changed extension');
  ok(d.total === 1 && !d.truncated && d.unidentified === 0 && d.domainMismatch === 0, 'and reports a clean batch');
}
{
  // Identity via subscriber_login alone — the fallback path.
  const d = decodeEventBatch([{ subscriber_login: '1044@acme.example.com' }], DOM, 40);
  ok(d.users.length === 1 && d.users[0]!.ext === '1044', 'subscriber_login alone yields the extension (it is <ext>@<domain>, not an email)');
}
{
  const d = decodeEventBatch([{ aor_user: '1050', aor_host: 'acme.example.com' }], DOM, 40);
  ok(d.users.length === 1 && d.users[0]!.ext === '1050', 'aor_user/aor_host are accepted');
}
{
  // In-batch coalescing: the cross-request cache cannot help inside one delivery.
  const batch = Array.from({ length: 10 }, () => ({ ...realEvent }));
  const d = decodeEventBatch(batch, DOM, 40);
  ok(d.users.length === 1 && d.total === 10, 'ten events for one extension coalesce to ONE read');
}
{
  const batch = [realEvent, { ...realEvent, user: '1045' }, { ...realEvent, user: '1046' }];
  const d = decodeEventBatch(batch, DOM, 40);
  ok(d.users.length === 3, 'distinct extensions are all kept');
}
{
  const batch = Array.from({ length: 10 }, (_, i) => ({ ...realEvent, user: String(2000 + i) }));
  const d = decodeEventBatch(batch, DOM, 3);
  ok(d.users.length === 3 && d.truncated, 'the cap is enforced and truncation is reported, never silent');
}
{
  const d = decodeEventBatch([{ ...realEvent, domain: 'evil.example.net', aor_host: 'evil.example.net', dial_plan: 'evil.example.net', subscriber_login: '1@evil.example.net' }], DOM, 40);
  ok(d.users.length === 0 && d.domainMismatch === 1, 'an event whose own domain disagrees with the path domain is DROPPED');
}
{
  const d = decodeEventBatch([{ user: '1044' }], DOM, 40);
  ok(d.users.length === 1 && d.domainAbsent === 1, 'an event with no domain field is accepted (path domain already verified) and counted');
}
{
  const d = decodeEventBatch([{ ...realEvent, domain: 'ACME.EXAMPLE.COM.' }], DOM, 40);
  ok(d.users.length === 1, 'the payload domain comparison tolerates case and a trailing dot');
}
{
  const d = decodeEventBatch([{ firstname: 'Nobody' }, null, 'string', 42, []], DOM, 40);
  ok(d.users.length === 0 && d.unidentified === 5, 'unidentifiable and non-object entries are counted, not crashed on');
}
{
  const d = decodeEventBatch([{ user: 'a/../b', domain: DOM }], DOM, 40);
  ok(d.users.length === 0 && d.unidentified === 1, 'an extension with path characters is refused');
}
// ── extension grammar admits no pure dot-segment (fix-wave S1) ────────────────
// `encodeURIComponent` leaves `.`/`..` untouched, but `NsClient.get` builds the request with `new URL(...)`,
// which normalises dot segments — so an extension of `..` would turn `/domains/x/users/..` into
// `GET /domains/x/`, and `.` would turn `/users/.` into the full user list. Requiring at least one
// alphanumeric character closes this while every ordinary extension still passes.
{
  const d = decodeEventBatch([{ user: '.', domain: DOM }], DOM, 40);
  ok(d.users.length === 0 && d.unidentified === 1, 'a single dot "." is refused');
}
{
  const d = decodeEventBatch([{ user: '..', domain: DOM }], DOM, 40);
  ok(d.users.length === 0 && d.unidentified === 1, 'a double dot ".." is refused — URL normalisation would rewrite it to the parent path');
}
{
  const d = decodeEventBatch([{ user: '...', domain: DOM }], DOM, 40);
  ok(d.users.length === 0 && d.unidentified === 1, 'a triple dot "..." is refused');
}
{
  const d = decodeEventBatch([{ user: '-', domain: DOM }], DOM, 40);
  ok(d.users.length === 0 && d.unidentified === 1, 'a bare "-" (no alphanumeric at all) is refused');
}
{
  const d = decodeEventBatch([{ user: '100.5', domain: DOM }], DOM, 40);
  ok(d.users.length === 1 && d.users[0]!.ext === '100.5', 'an ordinary extension containing a dot still passes');
}
{
  const d = decodeEventBatch([{ user: 'ext-100', domain: DOM }], DOM, 40);
  ok(d.users.length === 1 && d.users[0]!.ext === 'ext-100', 'an ordinary extension with a hyphen alongside alphanumerics still passes');
}
{
  ok(decodeEventBatch(realEvent, DOM, 40).users.length === 1, 'a bare object (not an array) is tolerated');
  ok(decodeEventBatch(null, DOM, 40).users.length === 0 && decodeEventBatch([], DOM, 40).total === 0, 'null and empty payloads are safe');
}
{
  const shape = diagShape([realEvent], post(`${NS_EVENTS_PREFIX}${TOKEN}/${DOM}`, { authorization: 'Bearer secret', 'x-correlation-id': 'abc' }));
  ok((shape['topLevelKeys'] as string[]).includes('email_address'), 'the diagnostic reports key NAMES');
  ok(!(shape['headerNames'] as string[]).includes('authorization'), 'the diagnostic never reports the authorization header');
  ok(JSON.stringify(shape).indexOf('demo4@example.com') === -1, 'the diagnostic contains no field VALUES');
}

// ── callback URLs + desired set ───────────────────────────────────────────────
{
  const url = await callbackUrlFor(CFG, DOM);
  ok(url === `https://portal.example.com${NS_EVENTS_PREFIX}${TOKEN}/${DOM}`, 'the callback URL is base + prefix + token + domain');
  ok(url.startsWith(ownedPrefix(CFG)), 'the owned prefix matches our own URLs');
  ok(!('https://other.example.com' + NS_EVENTS_PREFIX).startsWith(ownedPrefix(CFG)), 'a different host is not ours — this is what isolates envs');
}
{
  const d = await desiredSubscriptions(CFG);
  ok(d.length === 2 && d.every((x) => x.model === 'subscriber'), 'one desired subscription per enabled domain');
  ok(new Set(d.map((x) => x.postUrl)).size === 2, 'each domain gets a distinct callback URL');
}

// ── plan execution ────────────────────────────────────────────────────────────
{
  const seen: Record<string, unknown>[] = [];
  const client = {
    create: async (i: unknown) => {
      seen.push({ op: 'create', i });
      return { id: 'n', raw: {} };
    },
    update: async (id: string, c: unknown) => {
      seen.push({ op: 'update', id, c });
      return {};
    },
    remove: async (id: string, o: unknown) => {
      seen.push({ op: 'remove', id, o });
      return {};
    },
  };
  const NOW = Date.UTC(2026, 6, 25, 0, 0, 0);
  const actions: SubscriptionAction[] = [
    { kind: 'create', domain: DOM, model: 'subscriber', postUrl: 'u', expiresAt: 'ignored', reason: 'r' },
    { kind: 'renew', id: 'r1', domain: DOM, expiresAt: 'ignored', reason: 'r' },
    { kind: 'repair-url', id: 'r2', domain: DOM, postUrl: 'u2', reason: 'r' },
    { kind: 'delete', id: 'd1', domain: DOM, reason: 'r' },
    { kind: 'report', id: 'x', domain: DOM, reason: 'unhealthy', status: 'error', errorCount: 9, postsCount: 9 },
    { kind: 'noop', id: 'n1', domain: DOM, reason: 'fine' },
  ];
  const res = await applySubscriptionPlan(client, actions, CFG, NOW);
  ok(res.applied === 4 && res.failed === 0, 'create/renew/repair/delete are applied; report and noop are not writes');
  const created = seen.find((s) => s['op'] === 'create')!['i'] as Record<string, unknown>;
  ok(created['geoSupport'] === 'yes', 'create sends geoSupport explicitly (the documented default is wrong)');
  ok(created['expiresAt'] === '2027-07-25 00:00:00', 'create sends an explicit expiry computed from the target lifetime');
  ok(created['user'] === '*', 'create subscribes to all users in the domain');
  const removed = seen.find((s) => s['op'] === 'remove')!;
  ok((removed['o'] as Record<string, unknown>)['domain'] === DOM, 'delete passes the domain, required below Super User scope');
  ok(res.logs.some((l) => l['act'] === 'report' && l['status'] === 'error'), 'a report is logged, not silently dropped');
}
{
  // Fix-wave F5 (2026-07-31): `planInertCleanup` maps a subscription the API returned with no domain to
  // `domain: ''`. The library's `remove` sends `domain` in the wire body whenever the OPTION KEY is
  // present at all — `{ domain: '' }` still sends an empty-string domain, which NetSapiens may reject,
  // leaving a permanently-retried failed delete in the hourly log. The option must be omitted entirely.
  const seen: Record<string, unknown>[] = [];
  const client = {
    create: async () => ({ id: 'n', raw: {} }),
    update: async () => ({}),
    remove: async (id: string, o: unknown) => {
      seen.push({ id, o });
      return {};
    },
  };
  await applySubscriptionPlan(client, [{ kind: 'delete', id: 'd2', domain: '', reason: 'r' }], CFG, Date.now());
  const call = seen[0]!['o'] as Record<string, unknown>;
  ok(!('domain' in call), 'a domainless delete action omits `domain` from the remove call entirely, rather than sending an empty string');
}
{
  // A 409 on create is the desired state reached by someone else, not a failure.
  const client = {
    create: async () => {
      throw Object.assign(new Error('conflict'), { status: 409 });
    },
    update: async () => ({}),
    remove: async () => ({}),
  };
  const res = await applySubscriptionPlan(
    client,
    [{ kind: 'create', domain: DOM, model: 'subscriber', postUrl: 'u', expiresAt: 'x', reason: 'r' }],
    CFG,
    Date.now(),
  );
  ok(res.failed === 0 && res.applied === 1, 'a 409 on create counts as already-correct, not a failure');
  ok(res.logs.some((l) => l['outcome'] === 'already-exists'), 'and it is logged as such');
}
{
  const client = {
    create: async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    },
    update: async () => ({}),
    remove: async () => ({}),
  };
  const res = await applySubscriptionPlan(
    client,
    [{ kind: 'create', domain: DOM, model: 'subscriber', postUrl: 'u', expiresAt: 'x', reason: 'r' }],
    CFG,
    Date.now(),
  );
  ok(res.failed === 1, 'a real error is counted as a failure');
  ok(res.logs.some((l) => l['outcome'] === 'error'), 'and logged with its status');
}

// ── offboarding + device-repair config ────────────────────────────────────────
{
  const c = parseNsEventsConfig(FULL);
  ok(c.offboard === 'off', 'NS_EVENTS_OFFBOARD defaults to off — offboarding is opt-in');
  ok(c.deviceRepair === 'off', 'NS_EVENTS_DEVICE_REPAIR defaults to off');
  ok(c.sweepMax === 200, 'NS_EVENTS_SWEEP_MAX defaults to 200');
}
{
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_OFFBOARD: 'Deactivate', NS_EVENTS_DEVICE_REPAIR: 'HEAL' });
  ok(c.offboard === 'deactivate' && c.deviceRepair === 'heal', 'both switches are case-insensitive');
}
{
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_DEVICE_REPAIR: 'report' });
  ok(c.deviceRepair === 'report', 'device repair accepts report mode');
}
{
  let threw = false;
  try { parseNsEventsConfig({ ...FULL, NS_EVENTS_OFFBOARD: 'yes' }); } catch (e) { threw = e instanceof NsEventsConfigError; }
  ok(threw, 'an unknown NS_EVENTS_OFFBOARD value is a loud config error, not a silent off');
}
{
  // The grace clock is unproven (spec §6), so hard delete is not a value you can select yet. The parser
  // is where that fail-safe is enforced, rather than by remembering.
  let threw = false;
  try { parseNsEventsConfig({ ...FULL, NS_EVENTS_OFFBOARD: 'deactivate+delete' }); } catch (e) { threw = e instanceof NsEventsConfigError; }
  ok(threw, 'deactivate+delete is REFUSED — no verified grace clock, so hard delete cannot be enabled');
}
{
  let threw = false;
  try { parseNsEventsConfig({ ...FULL, NS_EVENTS_DEVICE_REPAIR: 'maybe' }); } catch (e) { threw = e instanceof NsEventsConfigError; }
  ok(threw, 'an unknown NS_EVENTS_DEVICE_REPAIR value is a loud config error');
}
{
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_SWEEP_MAX: '5' });
  ok(c.sweepMax === 5, 'NS_EVENTS_SWEEP_MAX is honoured');
}
{
  // Validated even when the feature is inert, so a typo surfaces rather than hiding behind a switch.
  let threw = false;
  try { parseNsEventsConfig({ ...FULL, NS_EVENTS: 'off', NS_EVENTS_OFFBOARD: 'bogus' }); } catch (e) { threw = e instanceof NsEventsConfigError; }
  ok(threw, 'the new switches are validated even when NS_EVENTS=off');
}

// ── inert cleanup: the config shape that permits a delete-only pass ───────────
{
  // Inert because no domains are configured, but the callback origin and the service identity remain —
  // which is exactly what is needed to know which subscriptions are ours AND to have the right to remove
  // them. That combination is the trigger for cleaning up after ourselves.
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_DOMAINS: '' });
  ok(!c.armed, 'emptying NS_EVENTS_DOMAINS makes the feature inert');
  ok(!!c.baseUrl && !!c.pathSecret && !!c.identity, 'the credentials survive going inert, so cleanup is still possible');
  ok(ownedPrefix(c) === 'https://portal.example.com/ns-events/', 'ownedPrefix is computable while inert — it is the ownership marker');
}
{
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS: 'off' });
  ok(!c.armed && !!c.baseUrl && !!c.pathSecret && !!c.identity, 'NS_EVENTS=off is a stop-managing switch, and cleanup is still possible');
}
{
  const c = parseNsEventsConfig({ ...FULL, NS_EVENTS_DOMAINS: '', NS_EVENTS_PATH_SECRET: undefined, NS_API_KEY: undefined });
  ok(!c.armed && !c.identity, 'removing the credentials leaves nothing able to clean up — the documented retirement order exists for this');
}

// ── planInertCleanup: the selection rule ─────────────────────────────────────
const sub = (o: { id: string; postUrl?: string; domain?: string }) => ({ id: o.id, postUrl: o.postUrl, domain: o.domain, raw: {} });
const PREFIX = 'https://portal.example.com/ns-events/';
{
  const acts = planInertCleanup(
    [sub({ id: 'S1', postUrl: `${PREFIX}tok/acme.example.com`, domain: 'acme.example.com' })] as any,
    PREFIX,
  );
  ok(acts.length === 1 && acts[0]!.kind === 'delete' && acts[0]!.id === 'S1', 'a subscription under our prefix is deleted');
  ok(acts[0]!.domain === 'acme.example.com', 'the delete carries the domain — DELETE /subscriptions/{id} needs it below Super User scope');
}
{
  // The whole safety property: other integrations legitimately subscribe to the same domains.
  const acts = planInertCleanup(
    [
      sub({ id: 'S1', postUrl: 'https://someone-else.example/hook', domain: 'acme.example.com' }),
      sub({ id: 'S2', postUrl: `${PREFIX}tok/acme.example.com`, domain: 'acme.example.com' }),
      sub({ id: 'S3' }),
    ] as any,
    PREFIX,
  );
  ok(acts.length === 1 && acts[0]!.id === 'S2', 'a FOREIGN subscription and one with no post-url are both left strictly alone');
}
{
  // Host-distinct prefixes are what keep dev and prod from deleting each other's subscriptions.
  const acts = planInertCleanup([sub({ id: 'S1', postUrl: 'https://dev.example.com/ns-events/tok/acme.example.com' })] as any, PREFIX);
  ok(acts.length === 0, 'another deployment’s subscription is not ours to delete');
}
{
  // The prefix must ANCHOR at the start, not merely appear anywhere in the URL — otherwise an
  // open-redirect-shaped post-url that merely contains our prefix as a substring would be treated as
  // ours. `.startsWith` rejects this; `.includes` would wrongly accept it.
  const acts = planInertCleanup(
    [sub({ id: 'S1', postUrl: `https://evil.example/?next=${PREFIX}tok/acme.example.com` })] as any,
    PREFIX,
  );
  ok(acts.length === 0, 'a post-url that merely CONTAINS our prefix, without it anchoring the start, is not ours');
}
{
  const acts = planInertCleanup([] as any, PREFIX);
  ok(acts.length === 0, 'nothing to clean up yields no actions');
}
{
  const acts = planInertCleanup([sub({ id: 'S1', postUrl: `${PREFIX}tok/acme.example.com` })] as any, PREFIX);
  ok(acts[0]!.domain === '', 'a subscription with no domain still yields a delete, with an empty domain rather than undefined');
}

// ── locate the connection a record actually sits on ───────────────────────────────────────────────────
{
  const users = [
    { id: 'a', extension: '100', branchid: 'B1', status: 1 },
    { id: 'b', extension: '200', branchid: 'B2', status: 1 },
    { id: 'c', extension: '300', branchid: 'B1', status: 1 },
    { id: 'd', extension: '300', branchid: 'B2', status: 1 },
    { id: 'e', extension: '400', branchid: 'B9', status: 1 },
    { id: 'f', extension: '500', branchid: 'B2', status: 2, userid: 'b' },
  ];
  const branchids = ['B1', 'B2'];

  const one = locateConnection(users, branchids, '200');
  ok(one.kind === 'one' && one.branchid === 'B2', 'locate: a record on the second connection is found there');

  ok(locateConnection(users, branchids, '999').kind === 'none', 'locate: an extension with no record → none');
  ok(locateConnection(users, branchids, '400').kind === 'none', 'locate: a record on an UNBOUND connection is not ours');

  const c = locateConnection(users, branchids, '300');
  ok(c.kind === 'conflict', 'locate: an extension on TWO connections is a conflict, never a guess');
  ok(c.kind === 'conflict' && c.branchids.join(',') === 'B1,B2', 'locate: the conflict names both connections');

  ok(locateConnection(users, branchids, '500').kind === 'none', 'locate: an attached secondary is not a locatable primary');

  // Two records on ONE connection is a duplicate, not a conflict — resolveCanonical already owns that.
  const dup = [
    { id: 'x', extension: '600', branchid: 'B1', status: 1 },
    { id: 'y', extension: '600', branchid: 'B1', status: 1 },
  ];
  const d = locateConnection(dup, branchids, '600');
  ok(d.kind === 'one' && d.branchid === 'B1', 'locate: two records on ONE connection is a duplicate, not a connection conflict');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
