/** Offline test for the on-demand live checks. pnpm test:statusprobes */
import { runProbes } from './statusProbes.js';
import { PROBE_CATALOG, probeCatalogFor } from './statusModel.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

const SECRET = 'SENTINEL-RT-KEY-zz9';
const CTX = { server: 'mock.local', token: 'delegated-token', domain: 'acme.example' };
const byId = (rs: any[], id: string) => rs.find((r) => r.id === id)!;

/** Stub fetch. `mode` decides the upstream verdict; every probe shares one stub. */
let mode: 'ok' | 'unauthorized' | 'boom' = 'ok';
const realFetch = globalThis.fetch;
const modeFetch = (async () => {
  if (mode === 'boom') throw new Error('connection reset');
  if (mode === 'unauthorized') return new Response('no', { status: 401 });
  return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
globalThis.fetch = modeFetch;

// ── skips: nothing configured means nothing to check, and that is not a failure ──
{
  mode = 'ok';
  const rs = await runProbes({ NS_SERVER: 'mock.local' } as any, CTX);
  ok(byId(rs, 'ringotel').state === 'skip', 'no API key ⇒ the Ringotel probe skips');
  ok(/RINGOTEL_API_KEY/.test(byId(rs, 'ringotel').detail), 'and it names the missing setting');
  ok(byId(rs, 'ns-identity').state === 'skip', 'no service identity ⇒ the identity probe skips');
  ok(byId(rs, 'ns-events').state === 'skip', 'events not armed ⇒ the events probe skips');
  // The point of this detail is that it carries `cfg.inertReason`, which NAMES the missing settings. The
  // earlier form (/identity/i || /armed|configur/i) was satisfied by the hardcoded fallback literal
  // 'Event subscriptions are not armed' — so dropping the inertReason interpolation entirely left it green.
  {
    const d = byId(rs, 'ns-events').detail;
    ok(/NS_EVENTS_BASE_URL/.test(d) && /NS_EVENTS_PATH_SECRET/.test(d),
      `and it names the settings it was waiting on, not just that it was waiting (got: ${d})`);
  }
  ok(byId(rs, 'onebill-documo').state === 'skip', 'OneBill/Documo are not integrated');
}

// ── a working upstream ─────────────────────────────────────────────────────────
{
  mode = 'ok';
  const rs = await runProbes({ NS_SERVER: 'mock.local', RINGOTEL_API_KEY: SECRET } as any, CTX);
  ok(byId(rs, 'ringotel').state === 'pass', 'a reachable Ringotel API passes');
  ok(byId(rs, 'ns-read').state === 'pass', 'a delegated NS read passes');
}

// ── a rejected credential: report it WITHOUT quoting the credential ────────────
{
  mode = 'unauthorized';
  const rs = await runProbes({ NS_SERVER: 'mock.local', RINGOTEL_API_KEY: SECRET } as any, CTX);
  const r = byId(rs, 'ringotel');
  ok(r.state === 'fail', 'a 401 from Ringotel is a failure');
  ok(/reject|unauth|401/i.test(r.detail), 'and the detail says why');
  const leaked = rs.filter((x) => JSON.stringify(x).includes(SECRET) || JSON.stringify(x).includes(SECRET.slice(0, 10)));
  ok(leaked.length === 0, 'NO probe result quotes the credential, not even a prefix');
}

// ── runProbes must never reject: a panel that 500s the page is worse than "unknown" ──
{
  mode = 'boom';
  let threw = false;
  let rs: any[] = [];
  try { rs = await runProbes({ NS_SERVER: 'mock.local', RINGOTEL_API_KEY: SECRET } as any, CTX); }
  catch { threw = true; }
  ok(!threw, 'an upstream throw does not reject runProbes');
  ok(byId(rs, 'ringotel').state === 'fail', 'it becomes a fail result instead');
  ok(rs.every((r) => typeof r.detail === 'string' && r.detail.length > 0), 'every result still explains itself');
}

// ── ns-events: one flat list() call, matched against configured domains — no per-domain fan-out ──
{
  const EVENTS_BASE = 'https://mock.local';
  const PREFIX = `${EVENTS_BASE}/ns-events/`;
  // ns-read and ringotel skip with no I/O (no token/domain; no RINGOTEL_API_KEY), so subs.list() is the
  // ONLY fetch call these scenarios make — safe to stub its exact response per scenario.
  const NO_READ_CTX = { server: 'mock.local', token: null, domain: null };
  const baseEnv = {
    NS_SERVER: 'mock.local',
    NS_API_KEY: 'test-key-not-real', // 'api' identity — getServiceToken returns it with no network call
    NS_EVENTS: 'on',
    NS_EVENTS_BASE_URL: EVENTS_BASE,
    NS_EVENTS_PATH_SECRET: 'test-path-secret',
    RINGOTEL_WRITE_DOMAINS: '*', // NS_EVENTS_DOMAINS is intersected against the write rail; '*' keeps it unfiltered
  };
  const subRecord = (domain: string) => ({ id: `sub-${domain}`, model: 'subscriber', 'post-url': `${PREFIX}tok/${domain}`, domain });
  const stubList = (subs: unknown[]) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(subs), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  };

  // every configured domain has an owned subscription
  stubList([subRecord('acme.example'), subRecord('beta.example')]);
  let rs = await runProbes({ ...baseEnv, NS_EVENTS_DOMAINS: 'acme.example,beta.example' } as any, NO_READ_CTX);
  ok(byId(rs, 'ns-events').state === 'pass', 'every configured domain has an owned subscription ⇒ pass');
  ok(/2 of 2/.test(byId(rs, 'ns-events').detail), 'and the detail says how many, out of how many');

  // one configured domain has no owned subscription
  stubList([subRecord('acme.example')]);
  rs = await runProbes({ ...baseEnv, NS_EVENTS_DOMAINS: 'acme.example,beta.example' } as any, NO_READ_CTX);
  ok(byId(rs, 'ns-events').state === 'fail', 'a configured domain with no owned subscription ⇒ fail');
  ok(/beta\.example/.test(byId(rs, 'ns-events').detail), 'and the detail names the missing domain');

  // wildcard, with owned subscriptions
  stubList([subRecord('acme.example'), subRecord('beta.example')]);
  rs = await runProbes({ ...baseEnv, NS_EVENTS_DOMAINS: '*' } as any, NO_READ_CTX);
  ok(byId(rs, 'ns-events').state === 'pass', 'a wildcard config with owned subscriptions ⇒ pass');
  ok(/2 owned/.test(byId(rs, 'ns-events').detail), 'and the detail carries the owned count');

  // wildcard, no owned subscriptions at all
  stubList([]);
  rs = await runProbes({ ...baseEnv, NS_EVENTS_DOMAINS: '*' } as any, NO_READ_CTX);
  ok(byId(rs, 'ns-events').state === 'fail', 'an armed wildcard config with ZERO owned subscriptions ⇒ fail');

  // ── item 35/53: the same list() result, enumerated ────────────────────────────────────────────────
  // The verdict is a count; the table is the answer to the questions a count cannot reach. Under a
  // wildcard especially — "at least one is ours" passes identically for one monitored domain and forty.
  {
    const expiring = { ...subRecord('acme.example'), 'subscription-expires-datetime': '2027-01-01 00:00:00' };
    stubList([expiring, subRecord('beta.example')]);
    rs = await runProbes({ ...baseEnv, NS_EVENTS_DOMAINS: '*' } as any, NO_READ_CTX);
    const t = byId(rs, 'ns-events').table;
    ok(!!t && t.rows.length === 2, 'a wildcard result enumerates every owned subscription, not just a count');
    ok(!!t && t.rows.map((r: string[]) => r[0]).join(',') === 'acme.example,beta.example',
      'one row per monitored domain, sorted');
    ok(!!t && t.rows[0]!.includes('2027-01-01 00:00:00'), 'carrying the expiry NetSapiens reported');
    ok(!!t && t.rows.every((r: string[]) => /every domain is configured/.test(r[3]!)),
      'and a wildcard says every domain is configured rather than implying a check happened');

    // A subscription that is OURS but whose domain is no longer configured is live and should not be —
    // the reason for enumerating rather than counting. Nothing else on the page surfaces it.
    stubList([subRecord('acme.example'), subRecord('gone.example')]);
    rs = await runProbes({ ...baseEnv, NS_EVENTS_DOMAINS: 'acme.example' } as any, NO_READ_CTX);
    const t2 = byId(rs, 'ns-events').table;
    const stray = t2.rows.find((r: string[]) => r[0] === 'gone.example');
    ok(!!stray && /^NO/.test(stray[3]!), 'an owned subscription for an unconfigured domain is flagged in the table');
    ok(t2.rows.find((r: string[]) => r[0] === 'acme.example')![3] === 'yes', 'and a configured one is not');

    // Foreign subscriptions are counted, never listed — the count is the whole useful fact, and a bounded
    // table must say what it is not showing.
    stubList([subRecord('acme.example'), { id: 'other', model: 'subscriber', 'post-url': 'https://someone.else/hook', domain: 'third.example' }]);
    rs = await runProbes({ ...baseEnv, NS_EVENTS_DOMAINS: 'acme.example' } as any, NO_READ_CTX);
    const t3 = byId(rs, 'ns-events').table;
    ok(t3.rows.length === 1 && !JSON.stringify(t3).includes('third.example'),
      'a subscription belonging to another integration is not listed');
    ok(/1 subscription\(s\).*another integration/.test(t3.note ?? ''), 'but it is counted, in a note on the table');
  }

  // the list() read itself fails
  globalThis.fetch = (async () => { throw new Error('connection reset'); }) as any;
  rs = await runProbes({ ...baseEnv, NS_EVENTS_DOMAINS: 'acme.example' } as any, NO_READ_CTX);
  ok(byId(rs, 'ns-events').state === 'fail', 'a failed subscription list ⇒ fail, never a throw');
  // Rule 2 of the module doc: no `detail` may carry a raw upstream response/error body. Every detail
  // string in statusProbes.ts is a non-empty literal, so the earlier `detail.length > 0` form passed on
  // every code path — including one where the whole error branch interpolated the caught error. The
  // thrown message is already injected right above, so assert THAT does not come back out.
  ok(!/connection reset/.test(byId(rs, 'ns-events').detail),
    'and the detail does not quote the upstream error text (rule 2: no raw upstream body in a detail)');
  ok(rs.every((r) => !/connection reset/.test(r.detail)), 'nor does any other probe result');

  // Rule 1 of the module doc: `runProbes` must never reject — enforced by `guarded()`, and NOTHING
  // exercised it. The `mode:'boom'` case above is absorbed by each probe's OWN try/catch first, so
  // deleting guarded's try/catch left the suite green. This throws OUTSIDE any local try: an armed events
  // config with no NS_SERVER reaches `assertBareServer(env.NS_SERVER)` (statusProbes.ts's
  // NsSubscriptionsClient construction), which is on no guarded path but guarded's own.
  {
    globalThis.fetch = (async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })) as any;
    const noServer = { ...baseEnv, NS_SERVER: undefined, NS_EVENTS_DOMAINS: 'acme.example' };
    let threw = false;
    let out: any[] = [];
    try { out = await runProbes(noServer as any, NO_READ_CTX); }
    catch { threw = true; }
    ok(!threw, 'a probe that throws OUTSIDE its own try/catch still does not reject runProbes (guarded)');
    ok(out.length === probeCatalogFor().length, 'and every applicable catalog entry still produces a result');
    // Found by index, not by byId(): byId's `!` is a compile-time assertion only, so when this mutation
    // fires there IS no ns-events result and a property read would kill the process before the summary.
    const ev = out.find((r) => r?.id === 'ns-events');
    ok(!!ev && ev.state === 'fail' && /failed unexpectedly/.test(ev.detail),
      'the escaping throw becomes guarded\'s own fail result, not a lost panel');
  }

  globalThis.fetch = modeFetch; // restore the shared mode-based stub for the blocks below
}

// ── the catalog IS the contract the Checks tab renders against (it now genuinely is: statusPage.ts renders
// the not-run rows from PROBE_CATALOG. It previously carried its own list of three, which disagreed with
// these six on content, count and mechanics — and this block's stated premise was what made that easy to
// miss). Both sides read one table, so what remains to assert is that the table is complete. ──────────
{
  mode = 'ok';
  const rs = await runProbes({ NS_SERVER: 'mock.local' } as any, CTX);
  const known = new Set(PROBE_CATALOG.map((p) => p.id));
  const unknown = rs.filter((r) => !known.has(r.id)).map((r) => r.id);
  ok(unknown.length === 0, `every result id is in PROBE_CATALOG${unknown.length ? ` (${unknown.join(', ')})` : ''}`);
  // Per APPLICABLE entry: these envs set no PORTAL_MODE, so this is a standalone deployment and the
  // banner check is not among them. The 1:1 contract holds against the same filter the renderer uses.
  const applicable = probeCatalogFor();
  ok(rs.length === applicable.length, 'and every applicable catalog entry produces a result');
  ok(rs.map((r) => r.id).join(',') === applicable.map((p) => p.id).join(','),
    'in the catalog\'s own order — the order the not-run rows are rendered in');
  ok(PROBE_CATALOG.every((p) => p.cost.trim().length > 0), 'each catalog entry states its cost');
  ok(PROBE_CATALOG.every((p) => p.what.trim().length > 0), 'and what it does — the Checks tab renders this before you run anything');
  // The three specific wrong statements the old hand-written explainer list made. A probe that calls /jwt
  // does not exist, so the page must not promise one; and the two probes with real side effects must be
  // named in the pre-run list, since informed consent is that list's entire job.
  ok(!PROBE_CATALOG.some((p) => /\/jwt/.test(p.what)), 'no catalog entry claims a live /jwt verification probe — there is none');
  ok(/delegated ns_t|own delegated/i.test(PROBE_CATALOG.find((p) => p.id === 'ns-read')!.what),
    'the NS read names the credential it ACTUALLY uses (the caller\'s delegated ns_t, not the service credential)');
  ok(PROBE_CATALOG.some((p) => p.id === 'ns-identity') && PROBE_CATALOG.some((p) => p.id === 'ns-events'),
    'the two probes that mint a token / list every subscription are declared, not hidden');
}

// ── Defect 2 (2026-08-08): the events probe must never double its own "not armed" claim ────────────
// The bug: `Event subscriptions are not armed — ${cfg.inertReason}.` prefixed unconditionally, but the
// missing-config `inertReason` (nsEvents.ts) ALREADY reads "NetSapiens event subscriptions not armed —
// missing: X" — so the rendered detail read "...not armed — NetSapiens event subscriptions not armed —
// missing: ...", saying the same thing twice. Exercise all three `inertReason` shapes `parseNsEventsConfig`
// can produce and assert none of them double the phrase — generically, across every probe result, not just
// this one, so a future probe that grows its own "not armed"-shaped wording is covered too.
{
  mode = 'ok';
  const notArmedCount = (s: string): number => (s.match(/not armed/gi) || []).length;

  // Shape 1: NS_EVENTS=off — inertReason is a bare setting value ('NS_EVENTS=off'), not a sentence.
  let rs = await runProbes({ NS_SERVER: 'mock.local', NS_EVENTS: 'off' } as any, CTX);
  let d = byId(rs, 'ns-events').detail;
  ok(notArmedCount(d) === 1, `off: "not armed" appears exactly once (got ${notArmedCount(d)}: ${JSON.stringify(d)})`);
  ok(/NS_EVENTS=off/.test(d), 'off: and still names the reason');

  // Shape 2: auto + nothing configured — inertReason is nsEvents.ts's OWN "not armed" sentence
  // ("NetSapiens event subscriptions not armed — missing: ..."). This is the exact shape that doubled.
  rs = await runProbes({ NS_SERVER: 'mock.local' } as any, CTX);
  d = byId(rs, 'ns-events').detail;
  ok(notArmedCount(d) === 1, `unconfigured: "not armed" appears exactly once, not doubled (got ${notArmedCount(d)}: ${JSON.stringify(d)})`);
  ok(/NS_EVENTS_BASE_URL/.test(d) && /NS_EVENTS_PATH_SECRET/.test(d), 'unconfigured: and still names the missing settings');

  // Shape 3: auto, fully configured except RINGOTEL_API_KEY — another bare-value inertReason.
  rs = await runProbes({
    NS_SERVER: 'mock.local', NS_API_KEY: 'test-key-not-real',
    NS_EVENTS_BASE_URL: 'https://mock.local', NS_EVENTS_PATH_SECRET: 'test-path-secret',
    NS_EVENTS_DOMAINS: 'acme.example', RINGOTEL_WRITE_DOMAINS: '*',
  } as any, CTX);
  d = byId(rs, 'ns-events').detail;
  ok(notArmedCount(d) === 1, `auto/no-ringotel: "not armed" appears exactly once (got ${notArmedCount(d)}: ${JSON.stringify(d)})`);
  ok(/RINGOTEL_API_KEY/.test(d), 'auto/no-ringotel: and still names the reason');

  // Generic sweep: no result of any probe, in any of the three scenarios above, doubles the phrase.
  const allDetails = [
    ...(await runProbes({ NS_SERVER: 'mock.local', NS_EVENTS: 'off' } as any, CTX)),
    ...(await runProbes({ NS_SERVER: 'mock.local' } as any, CTX)),
  ].map((r) => r.detail);
  const doubled = allDetails.filter((s) => notArmedCount(s) > 1);
  ok(doubled.length === 0, `no probe detail anywhere doubles "not armed"${doubled.length ? ` (${JSON.stringify(doubled)})` : ''}`);
}

// ── Defect 3 (2026-08-08): a `pass` on the API-key path must not claim more than presence ──────────
// The bug: `getServiceToken` for an 'api' identity returns the configured token straight back with NO
// network call (this catalog entry's own `cost` says so: "nothing over the network for an API key") — so
// a `pass` here only proves NS_API_KEY is non-empty. The old detail, "The API-key identity is present and
// ready to use", claimed readiness NetSapiens itself never confirmed. The 'admin' path, by contrast, DOES
// perform a real OAuth password grant, so a `pass` there genuinely proves the credential works — the
// wording must keep that distinction visible, not flatten both paths to the same confidence.
{
  const claimsVerification = /ready to use|is verified|has been verified|netsapiens accepted|minted an? (?:oauth )?(?:access )?token/i;

  // API-key path: NS_API_KEY only, no admin creds ⇒ resolveWriteIdentity picks 'api'.
  mode = 'ok';
  let rs = await runProbes({ NS_SERVER: 'mock.local', NS_API_KEY: 'test-key-not-real' } as any, CTX);
  let d = byId(rs, 'ns-identity');
  ok(d.state === 'pass', 'API-key identity: still reported as pass — presence is a true, checkable fact');
  ok(!claimsVerification.test(d.detail),
    `API-key identity: the detail claims no readiness/verification it did not perform (got: ${JSON.stringify(d.detail)})`);
  ok(/not exercised|nothing was (?:called|verified)|no call/i.test(d.detail),
    'API-key identity: and says plainly that nothing was actually called');

  // Admin path: NS_ADMIN_USER/PASS + the OAuth client pair ⇒ resolveWriteIdentity picks 'admin', and
  // getServiceToken performs a real password-grant call — stub it to succeed.
  globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: 'minted-tok' }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  rs = await runProbes({
    NS_SERVER: 'mock.local', NS_ADMIN_USER: 'admin', NS_ADMIN_PASS: 'not-a-real-password',
    NS_OAUTH_CLIENT_ID: 'client-id', NS_OAUTH_CLIENT_SECRET: 'client-secret',
  } as any, CTX);
  d = byId(rs, 'ns-identity');
  ok(d.state === 'pass', 'admin identity: a successful OAuth grant passes');
  ok(claimsVerification.test(d.detail),
    `admin identity: the detail DOES claim what it verified — a real OAuth grant was attempted and accepted (got: ${JSON.stringify(d.detail)})`);
  globalThis.fetch = modeFetch;
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
