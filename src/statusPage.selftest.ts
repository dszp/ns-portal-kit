/** Offline test for the status page renderer. pnpm test:statuspage */
import { Script } from 'node:vm';
import { toPrincipal, type Principal } from '@dszp/netsapiens-lib';
import { buildStatus } from './status.js';
import { statusHtml, richPara, CHECKS_INTRO_TEXT } from './statusPage.js';
import { PROBE_CATALOG, probeCatalogFor, type ProbeResult } from './statusModel.js';
import { parseFeatures } from './features.js';
import { SPK_BRIDGE } from './spkBridge.js';
import { buildSpkBundle } from './kit.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };
const P = (scope: string, id = 'boss@example.com'): Principal =>
  toPrincipal({ user: 'u', domain: 'example.com', sub: id, scope } as any);

/**
 * THE ASSERTION THAT MATTERS MOST. Every credential key is set to a distinctive sentinel; none of them
 * may appear anywhere in the rendered output. If this fails, the page leaks a secret to its reader —
 * do not "fix" it by escaping or truncating the value. Stop carrying the value at all.
 */
const SENTINELS: Record<string, string> = {
  RINGOTEL_API_KEY: 'SENTINEL-RINGOTEL-KEY-d4e5f6',
  NS_EVENTS_PATH_SECRET: 'SENTINEL-PATH-SECRET-g7h8i9',
  NS_API_KEY: 'SENTINEL-NS-API-KEY-j1k2l3',
  NS_ADMIN_USER: 'SENTINEL-ADMIN-USER-m4n5o6',
  NS_ADMIN_PASS: 'SENTINEL-ADMIN-PASS-p7q8r9',
  NS_OAUTH_CLIENT_ID: 'SENTINEL-CLIENT-ID-s1t2u3',
  NS_OAUTH_CLIENT_SECRET: 'SENTINEL-CLIENT-SECRET-v4w5x6',
};
{
  const env = {
    NS_SERVER: 'api.example.com', NS_PORTAL_ISS: 'manage.example.com', PORTAL_MODE: '1',
    PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'portal',
    RINGOTEL_WRITE_DOMAINS: '*', NS_EVENTS: 'on', NS_EVENTS_DOMAINS: '*',
    NS_EVENTS_BASE_URL: 'https://svc.example.com', ...SENTINELS,
  };
  const doc = buildStatus(env, { principal: P('Super User'), hostname: 'svc.example.com' });
  const html = statusHtml(doc);
  const leaked = Object.entries(SENTINELS).filter(([, v]) => html.includes(v)).map(([k]) => k);
  ok(leaked.length === 0, `no secret value appears in the rendered page${leaked.length ? ` — LEAKED: ${leaked.join(', ')}` : ''}`);
  // Also assert a partial: a truncation or fingerprint would still be a disclosure.
  const partial = Object.values(SENTINELS).filter((v) => html.includes(v.slice(0, 12)));
  ok(partial.length === 0, 'not even a prefix of a secret appears');
  const tail = Object.values(SENTINELS).filter((v) => html.includes(v.slice(-8)));
  ok(tail.length === 0, 'nor a trailing fingerprint of one — the "last four" habit is still a disclosure');
  ok(html.includes('NS_API_KEY'), 'the secret NAME is shown — name the setting, never the value');

  // THE SAME CLAIM, AT THIS FILE'S OWN LAYER. The block above cannot fail from a bug in statusPage.ts:
  // status.ts already sets `value: null` for every secret, so removing renderSettingRow's own secret
  // special-case left the whole suite green — the belt-and-braces design was real in the code and untested
  // here. Feed the renderer a document that HAS secret values (the technique the escaping block below
  // uses) and assert this file's own guard is what stops them.
  const poisoned = {
    ...doc,
    settings: doc.settings.map((s) => (s.kind === 'secret' ? { ...s, set: true, value: SENTINELS[s.name] ?? 'SENTINEL-UNLISTED-SECRET-y7z8' } : s)),
  };
  const poisonedHtml = statusHtml(poisoned);
  const poisonedLeak = poisoned.settings
    .filter((s) => s.kind === 'secret' && s.value !== null && poisonedHtml.includes(s.value))
    .map((s) => s.name);
  ok(poisonedLeak.length === 0,
    `renderSettingRow refuses to print a secret even when the DOCUMENT carries one${poisonedLeak.length ? ` — LEAKED: ${poisonedLeak.join(', ')}` : ''}`);
  ok(poisonedHtml.includes('value withheld'), 'and says so, rather than silently omitting the line');
}

const DOC = () => buildStatus(
  { NS_SERVER: 'api.example.com', NS_PORTAL_ISS: 'manage.example.com', PORTAL_MODE: '1',
    PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'dev' },
  { principal: P('Super User'), hostname: 'svc-dev.example.com' });

// ── self-contained: this renders inside a sandboxed iframe with no network ───────
{
  const html = statusHtml(DOC());
  // (Two assertions that used to sit here were dropped: one repeated the table below verbatim, the other
  // was a strict subset of its <link href> row.)

  // The real constraint: this page LOADS nothing external. It renders as the srcdoc of a sandboxed
  // iframe with no network, so a CDN script, remote stylesheet, web font or remote image would break it
  // silently. Assert on resource POSITIONS, not on any URL-shaped string — help text that mentions an
  // example URL is documentation, and an <a href target=_blank> is user-initiated navigation. Both are
  // fine. The earlier form asserted the broader claim and pushed the fix into the copy: a prose() helper
  // stripped "https://" out of operator guidance, which for NS_EVENTS_BASE_URL deleted the very part of
  // the example that carries the requirement.
  const externalLoads: [RegExp, string][] = [
    [/<script[^>]+\bsrc\s*=/i,      'no external script'],
    [/<link[^>]+\bhref\s*=/i,       'no <link> (stylesheet, font, preload, icon)'],
    [/<img[^>]+\bsrc\s*=/i,         'no remote image'],
    [/<iframe[^>]+\bsrc\s*=/i,      'no nested iframe src'],
    [/@import/i,                    'no CSS @import'],
    [/url\(\s*['"]?(?:https?:)?\/\//i, 'no absolute url() in CSS'],
    [/\bnew\s+XMLHttpRequest\b/i,   'no XHR'],
    [/\bfetch\s*\(/i,               'no fetch — the page cannot reach the Worker; it posts to the parent'],
    [/\bnew\s+WebSocket\b/i,        'no WebSocket'],
    [/\bnew\s+EventSource\b/i,      'no EventSource'],
  ];
  externalLoads.forEach(([re, msg]) => ok(!re.test(html), msg));
  // A data: URI is the sanctioned way to embed an asset, so it is allowed — but flag a big one, which
  // usually means someone inlined something that should not be in a status page at all.
  ok(!/data:[^;,]*;base64,[A-Za-z0-9+/=]{2000,}/.test(html), 'no large base64 asset inlined');

  ok(/@media \(prefers-color-scheme: dark\)/.test(html), 'the page is theme-aware');
  ok(/<details/.test(html), 'advanced sections are collapsible');
  // Collapsed by default, with the exceptions ENUMERATED rather than a blanket ban. The blanket version broke
  // the moment one deliberate exception landed, and a test that has to be relaxed teaches nothing; this one
  // forces each exception to be named, so an accidental `open` still fails.
  const OPEN_BY_DESIGN = [
    'class="kidgroup" open',   // the sole integration with parts — a collapsed group nobody knows exists is undiscoverable
  ];
  const opened = [...html.matchAll(/<details[^>]*\bopen\b[^>]*>/g)].map((m2) => m2[0]!);
  const unexpected = opened.filter((tag) => !OPEN_BY_DESIGN.some((allowed) => tag.includes(allowed)));
  ok(unexpected.length === 0,
    `every disclosure starts collapsed except the enumerated exceptions${unexpected.length ? ` (unexpected: ${unexpected.join(' | ')})` : ''}`);
}

// ── help text keeps its meaning — a scheme in an example can BE the requirement ──
{
  const html = statusHtml(DOC());
  ok(html.includes('https://portal.example.com'),
    'help text keeps its https:// — the scheme IS the requirement for this setting');
}

// ── the deployment badge must be unmissable ──────────────────────────────────────
// Match the whole TAG, not the word: `DEV` also occurs inside RINGOTEL_EXCLUDE_NO_DEVICES,
// NS_DEVICE_DETAILS and NS_EVENTS_DEVICE_REPAIR — all in the first half of the document, so deleting the
// entire <span class="envbadge"> satisfied both of the earlier assertions. And compare the position against
// the tab bar rather than half the byte length: "above the tabs" is what "not buried" actually means here,
// and it does not loosen as the document grows.
{
  const html = statusHtml(DOC());
  ok(html.includes('<span class="envbadge envbadge-dev">DEV</span>'), 'the badge tag itself is rendered, with its state');
  const badgeAt = html.indexOf('<span class="envbadge');
  const tabsAt = html.indexOf('<nav class="spk-tabbar"'); // the bar itself, not its CSS rule up in <style>

  ok(badgeAt > -1 && tabsAt > -1 && badgeAt < tabsAt, 'and it sits above the tab bar, not buried in a panel');
}

// ── escaping ─────────────────────────────────────────────────────────────────────
{
  const doc = DOC();
  doc.settings[0] = { ...doc.settings[0], value: '<img src=x onerror=alert(1)>' };
  const html = statusHtml(doc);
  ok(!html.includes('<img src=x'), 'a hostile config value is escaped, not rendered as markup');
  ok(html.includes('&lt;img'), 'and it appears escaped');
}

// ── every card reaches the page, IN ITS OWN ROW ──────────────────────────────────
// Row-scoped on purpose. A whole-document `html.includes(name)` is satisfied by any other mention of the
// same string anywhere on the page: stripping the name from every settings row caught 1 of 64, and
// stripping the key from every feature card caught 7 of 18. Slice the panel, split it into rows, and check
// that row i carries item i.
{
  const doc = DOC();
  const html = statusHtml(doc);
  const panel = (id: string, nextId: string): string => {
    const a = html.indexOf(`id="spkpanel-${id}"`);
    const b = html.indexOf(`id="spkpanel-${nextId}"`);
    return a > -1 && b > a ? html.slice(a, b) : '';
  };

  // Quoted token: `<div class="card` (unquoted) also matches `card-head` and `card-grid`, which triples
  // the count. Feature cards are always the bare `card` class — the nested `card card-child` variant only
  // appears on the Integrations tab.
  // Matches both card shapes: a feature that carries explanatory prose spans the grid (`card card-wide`).
  // The bare quoted token silently dropped those, which read as a one-off count mismatch.
  const featureCards = panel('features', 'integrations').split(/<div class="card(?: card-wide)?">/).slice(1);
  ok(featureCards.length === doc.features.length,
    `the features panel renders exactly one card per feature (${featureCards.length} vs ${doc.features.length})`);
  // The tab is split by AUDIENCE (admin features, then self-service), so the expected order is that
  // partition — not registry order. Derived from the doc's own `audience` field rather than a hand-typed
  // list, so re-classifying a feature moves the expectation with it.
  const expectedOrder = [...doc.features.filter((f) => f.audience === 'admin'), ...doc.features.filter((f) => f.audience === 'self')];
  const wrongCards = expectedOrder.filter((f, i) => !featureCards[i]?.includes(f.key)).map((f) => f.key);
  ok(wrongCards.length === 0,
    `each feature card carries its OWN key, in audience order${wrongCards.length ? ` (not in their own card: ${wrongCards.join(', ')})` : ''}`);
  // Every feature lands in exactly one of the two sections — a feature whose audience were neither would
  // silently vanish from the tab.
  ok(expectedOrder.length === doc.features.length, 'and every feature is in one of the two audience sections');

  // Split WITHOUT the closing quote: a row that is dimmed (not applicable, or behind an unsatisfied gate)
  // renders `class="setting-row dimmed"`, and the quoted token silently matched only the 21 undimmed ones —
  // which read as a passing "one row per setting" assertion right up until the counts were printed.
  const rows = panel('config', 'checks').split('<div class="setting-row').slice(1);
  ok(rows.length === doc.settings.length,
    `the config panel renders exactly one row per setting (${rows.length} vs ${doc.settings.length})`);
  // Rows are grouped and importance-sorted now, so position no longer tracks `doc.settings` order. Each
  // row carries `id="spkset-<NAME>"` (the jump target) AND a rendered `<code class="card-key">NAME</code>`,
  // which makes the identity check stronger than the old positional one: it catches a row that names a
  // DIFFERENT setting than the one it is the anchor for, not merely a missing name somewhere on the page.
  const idOf = (row: string): string => (row.match(/id="spkset-([A-Z_]+)"/) ?? [])[1] ?? '';
  const keyOf = (row: string): string => (row.match(/<code class="card-key">([A-Z_]+)<\/code>/) ?? [])[1] ?? '';
  const mismatched = rows.filter((r) => idOf(r) === '' || idOf(r) !== keyOf(r));
  ok(mismatched.length === 0,
    `each settings row names the SAME setting it anchors${mismatched.length ? ` (${mismatched.length} row(s) disagree: ${mismatched.map((r) => `${idOf(r)}/${keyOf(r)}`).join(', ')})` : ''}`);
  const rendered = new Set(rows.map(idOf));
  const absent = doc.settings.filter((s) => !rendered.has(s.name)).map((s) => s.name);
  ok(absent.length === 0, `and every setting has a row${absent.length ? ` (absent: ${absent.join(', ')})` : ''}`);
}

// ── the probe bridge: one field name, agreed by two generated artifacts ──────────
// This is the assertion that would have caught the Critical. The parent posted probe results under `data`
// while the page read `results`, so a run of real production calls blanked the panel and the operator read
// it as "nothing to report". Both sides now interpolate src/spkBridge.ts — but this test does not trust
// that: it re-derives the field names back OUT of the two generated strings and asserts they agree, so a
// hand-typed literal on either side still fails. The earlier form (`html.includes('__spk')`) would have
// passed with the entire message handler deleted.
{
  const html = statusHtml(DOC());
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  const bundle = buildSpkBundle(['kit.status'], { PORTAL_HANDOFF_URL: '' } as any);

  // Every field the page's handler reads off the received message.
  const fieldsRead = new Set([...script.matchAll(/\bm\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!));
  // Every field the parent puts into ANY reply. Scoped by the protocol tag rather than by one message
  // type: there are two replies now (probe results, and the observed-page facts), and a rule that only
  // covered the first would have gone quiet on the second exactly when it was newest.
  const sendRe = new RegExp(`postMessage\\(\\{([^}]*${SPK_BRIDGE.tag}[^}]*)\\}`, 'g');
  const fieldsSent = new Set(
    [...bundle.matchAll(sendRe)].flatMap((m) => m[1]!.split(',').map((kv) => kv.split(':')[0]!.trim())),
  );

  // Every payload field the protocol defines. Listed explicitly rather than derived from SPK_BRIDGE's
  // values, because half of those are message TYPES rather than fields — and an assertion that derived
  // both sides from the same object would pass with either side deleted.
  const expected = [SPK_BRIDGE.tag, SPK_BRIDGE.dataKey, SPK_BRIDGE.errorKey, SPK_BRIDGE.pageKey,
    SPK_BRIDGE.menusKey, SPK_BRIDGE.checkKey].sort();
  const sorted = (s: Set<string>): string => [...s].sort().join(',');
  ok(sorted(fieldsSent) === expected.join(','),
    `the bundle sends exactly the protocol's fields (sends: ${sorted(fieldsSent)})`);
  ok(sorted(fieldsRead) === expected.join(','),
    `and the page reads exactly those same fields — no more, no fewer (reads: ${sorted(fieldsRead)})`);
  ok(sorted(fieldsRead) === sorted(fieldsSent),
    `the two sides of the bridge agree on every field name (sent: ${sorted(fieldsSent)} / read: ${sorted(fieldsRead)})`);

  // The tag+type the page guards on must be the tag+type the parent stamps, and the page's request must be
  // the one the parent listens for.
  ok(script.includes(`m.${SPK_BRIDGE.tag} !== '${SPK_BRIDGE.response}'`) && bundle.includes(`${SPK_BRIDGE.tag}:'${SPK_BRIDGE.response}'`),
    'the page guards on the same tag and message type the parent stamps');
  ok(script.includes(`{ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.request}' }`) && bundle.includes(`d.${SPK_BRIDGE.tag}!=='${SPK_BRIDGE.request}'`),
    'and the request the page posts is the one the parent listens for');

  // ── the observed-page protocol, held to the same standard as the probe one ──────────────────────────
  // Same failure mode, same guard: two generated artifacts, no compiler between them. The probe protocol
  // shipped a mismatch that blanked a panel; this one would silently leave "Asking the portal page…" on
  // screen forever, which is quieter and therefore worse.
  ok(script.includes(`{ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.pageRequest}' }`) && bundle.includes(`d.${SPK_BRIDGE.tag}==='${SPK_BRIDGE.pageRequest}'`),
    '[observed] the page-facts request the page posts is the one the parent listens for');
  ok(script.includes(`m.${SPK_BRIDGE.tag} === '${SPK_BRIDGE.pageResponse}'`) && bundle.includes(`${SPK_BRIDGE.tag}:'${SPK_BRIDGE.pageResponse}'`),
    '[observed] and the reply type the page guards on is the one the parent stamps');
  ok(script.includes(`m.${SPK_BRIDGE.pageKey}`) && bundle.includes(`${SPK_BRIDGE.pageKey}:spkPage()`),
    '[observed] carrying its payload under the protocol\'s own field name');
  // The parent must answer from the PAGE, not from anything the console tells it — the whole point is that
  // this fact is only knowable outside the sandbox.
  ok(/function spkPage\(\)/.test(bundle) && bundle.includes('getElementsByTagName(\'script\')'),
    '[observed] and computes the answer by reading the portal page\'s own scripts');
  // Asked unprompted on open. A block that only fills after the reader presses something is a block most
  // readers never see filled.
  ok(script.indexOf(`{ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.pageRequest}' }`) > -1
    && !/addEventListener\('click'[^)]*pageRequest/.test(script),
    '[observed] the request is sent on open, not behind a control');

  // The script is a generated string, so a syntax error in it is invisible until a browser loads the page
  // (and the iframe has no console anyone is watching). `new Script` COMPILES and never runs — the same
  // compile-only check kit.selftest.ts uses on the injected bundles.
  let parses = true;
  try { new Script(script.replace(/^<script>/, '')); } catch { parses = false; }
  ok(parses, 'the inline script compiles');

  // A run that did not complete must never render as an empty result list — that reads as "all clear".
  ok(script.includes(`m.${SPK_BRIDGE.errorKey}`), 'the page inspects the error field at all');
  ok(/did not run/.test(script) && /NOT a report that everything is healthy/.test(script),
    'and a failed or empty run renders a FAIL row saying nothing was checked');
}

// ── the console is READ-ONLY, and says so once rather than 64 times ──────────────
//
// This replaced a count of 64 disabled Edit buttons. That control WAS the write seam, and the count was a
// real assertion (an earlier `/disabled/` regex was satisfied by the CSS rule `.edit-btn:disabled` and so
// tested nothing) — but 64 copies of "you cannot do this here" was the same repetition complaint the
// hoisted preamble exists to fix, and the honest write seam turned out to be the Permissions tab's
// copy-pasteable JSON: the hard part was never the writing, it was knowing what to write. So the property
// under test changed shape: no editing affordance ANYWHERE, the reason stated exactly once, and the JSON
// the console hands out validated against this deployment's own parser before it is offered.
{
  const doc = DOC();
  const html = statusHtml(doc);

  // No control on the page offers to change configuration. Counts every button, then subtracts the ones
  // that are known-navigational (jump-to-setting, copy, run checks, the scope checker) — so a NEW
  // write-shaped control cannot be added without failing here. Anchored on the class attribute, not on
  // the word "Edit", because a rename would otherwise walk straight past it.
  const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"/g)].map((m) => m[1]!);
  // Navigational/informational controls only. Every addition here is a deliberate statement that the
  // control does not change configuration — which is the whole point of the assertion: a new write-shaped
  // control cannot be added without someone editing this line.
  const navigational = new Set(['setref', 'copy-btn', 'run-btn', 'tocref', 'totop', 'backbtn', 'filterclear']);
  const unknown = buttons.filter((c) => !c.split(/\s+/).some((k) => navigational.has(k)));
  ok(unknown.length === 0,
    `no control on the page offers to change configuration${unknown.length ? ` (unexpected: ${unknown.join(' | ')})` : ''}`);

  // Stated ONCE. Two occurrences would mean the hoist regressed into per-row repetition.
  const saysReadOnly = (html.match(/Nothing on this tab can be edited from here/g) || []).length;
  ok(saysReadOnly === 1, `and says so exactly once, not per row (found ${saysReadOnly})`);
  // Case-sensitive and anchored: `/KV/i` matched `dl.kv` in the CSS and `class="kv"` on ~100 elements, so
  // rewriting the explanation to claim there IS a config store used to leave the suite green.
  ok(html.includes('config store (KV or D1)'), 'and explains why, naming what would be needed');

  // The write seam that DOES exist: emitted config, validated before it is offered. `jsonError` non-null
  // means the console would have handed out a blob its own Worker rejects at boot.
  ok(doc.permissions.jsonError === null,
    `the JSON the console offers passes this deployment's own validator${doc.permissions.jsonError ? ` (got: ${doc.permissions.jsonError})` : ''}`);
}

// ── three-state settings: absent, present-empty, present ────────────────────────
// F5: `isSet` cannot tell absent from present-empty, so the Config tab reported a deliberate
// PORTAL_HANDOFF_URL="" as UNSET with source "default" — then printed that row's own prose warning about
// the OTHER state — while the Integrations tab said injection was ON.
{
  // Scoped to the Config panel: a feature/subsystem card's `missing[]` list also renders the setting's
  // name inside a <strong>, so splitting the whole document would match the wrong chunk.
  const rowFor = (html: string, name: string): string => {
    const a = html.indexOf('id="spkpanel-config"');
    const rows = html.slice(a, html.indexOf('id="spkpanel-checks"')).split('<div class="setting-row');
    return rows.find((r) => r.includes(`id="spkset-${name}"`)) ?? '';
  };
  const base = { NS_SERVER: 'api.example.com', NS_PORTAL_ISS: 'manage.example.com', PORTAL_MODE: '1',
    PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'dev' };
  const opts = { principal: P('Super User'), hostname: 'svc-dev.example.com' };

  const emptyRow = rowFor(statusHtml(buildStatus({ ...base, PORTAL_HANDOFF_URL: '' }, opts)), 'PORTAL_HANDOFF_URL');
  ok(/SET \(EMPTY\)/.test(emptyRow), 'a deliberately-empty setting renders its own pill, not UNSET');
  ok(!/>UNSET</.test(emptyRow), 'and does not also claim to be unset');
  ok(/empty value — not absent/.test(emptyRow), 'and says what that means');

  const absentRow = rowFor(statusHtml(buildStatus(base, opts)), 'PORTAL_HANDOFF_URL');
  ok(/>UNSET</.test(absentRow), 'an absent setting still renders UNSET');
  ok(!/SET \(EMPTY\)/.test(absentRow), 'and is not confused with the empty case');

  const setRow = rowFor(statusHtml(buildStatus({ ...base, PORTAL_HANDOFF_URL: 'https://vendor.example.com/r.js' }, opts)), 'PORTAL_HANDOFF_URL');
  ok(/>SET</.test(setRow) && !/SET \(EMPTY\)/.test(setRow), 'and a real value renders plain SET');
}

// ── NS_SERVER absent must not crash the page — the exact operator who most needs it ──
// `interface Env` types NS_SERVER as required, but at runtime a fresh fork can simply omit it from
// `wrangler.jsonc` vars, and status.ts's own StatusEnv types it optional for exactly this reason. Before
// `env.NS_SERVER ?? ''` was added at the env boundary in `buildStatus`, `deployment.nsServer` carried
// `undefined` straight through to `esc(d.nsServer)` in renderHeader — and `esc` calls `.replace` on its
// argument, so `esc(undefined)` throws a TypeError. That 500'd the console for precisely the deployment
// whose NS_SERVER row would otherwise read "Nothing works" — the one operator who most needs this page to
// load. Unguarded before: reverting the `?? ''` at status.ts's env boundary stays green in every OTHER
// suite, because nothing else calls statusHtml with an NS_SERVER-less doc. This does.
{
  const env = { NS_PORTAL_ISS: 'portal.example.com', PORTAL_MODE: '1', PORTAL_SUPERADMINS: 'boss@example.com' };
  let threw: unknown = null;
  let html: string | null = null;
  try {
    const doc = buildStatus(env as any, { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' });
    html = statusHtml(doc);
  } catch (e) {
    threw = e;
  }
  ok(!threw, `statusHtml(buildStatus(...)) survives an absent NS_SERVER${threw ? ` (threw: ${threw instanceof Error ? threw.message : String(threw)})` : ''}`);
  ok(!!html && html.includes('<!doctype html>'), 'and still returns a real document, not a partial/empty string');
  ok(!!html && html.includes('NS_SERVER: <code></code>'), 'rendering the missing value as empty, not the literal word "undefined"');
}

// ── the Checks tab, before you run anything, describes the checks that actually run ──
// F2: this panel used to carry its own list of three checks — a second derivation that disagreed with
// PROBE_CATALOG on content, count and mechanics, and it was the DEFAULT render.
{
  const html = statusHtml(DOC());
  const a = html.indexOf('id="spkpanel-checks"');
  const panel = html.slice(a, html.indexOf('</main>', a));
  // Against the checks THIS MODE runs, not the whole catalog: a check that cannot apply here is removed,
  // and asserting the full list would demand rows the runner will never produce — the same 1:1 contract,
  // read through the same filter both sides use.
  const applicable = probeCatalogFor(DOC().deployment.mode);
  const missing = applicable.filter((p) => !panel.includes(p.name)).map((p) => p.id);
  ok(missing.length === 0, `every catalog check is listed before any run${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  ok((panel.match(/NOT RUN/g) || []).length === applicable.length,
    `and there are exactly ${applicable.length} NOT RUN rows — one per check that will actually run`);
  const missingWhat = applicable.filter((p) => !panel.includes(p.what.slice(0, 40))).map((p) => p.id);
  ok(missingWhat.length === 0, `each row carries the catalog's own description${missingWhat.length ? ` (missing: ${missingWhat.join(', ')})` : ''}`);
  ok(!/ns_t live verification/.test(panel), 'and the page promises no probe that does not exist');

  // ACCESS IS A STANDALONE-ONLY CHECK (David, 2026-08-09). A portal-mode Worker holds no stored credential
  // for Access to protect, and an Access gate in front of one would refuse the plain <script src> that
  // loads the injected primary -- so the row does not describe an inert setting, it describes a control
  // this deployment could not adopt. Asserted in BOTH directions: removing it from portal mode is only
  // correct if it survives where it is real, and a filter that quietly drops it everywhere would pass a
  // one-sided test.
  ok(!panel.includes('Cloudflare Access'), 'no Cloudflare Access row in portal-backend mode');


  // L2 (2026-08-07 pre-deploy review): the intro must not contradict the rows beneath it. It claimed "each
  // check below is a live network call" above two rows whose own `cost` says "No network call". Tied to the
  // CATALOG, not to that one sentence: forbidding only the exact literal string that happened to ship is
  // unguarded against a reword ("every one of these hits the network", "each check makes a live call") —
  // the claim would still be false, and a differently-worded regression would sail through a test that only
  // knows one phrasing. So match the CLAIM itself (a totalizing quantifier next to "network call"), while
  // ANY catalog row declares no network call.
  const noNetwork = PROBE_CATALOG.filter((c) => /no network call/i.test(c.cost)).map((c) => c.id);
  ok(noNetwork.length > 0, `sanity: some catalog rows declare no network call (${noNetwork.join(', ')})`);
  const introOnly = panel.slice(0, panel.indexOf('spkChecksResults'));
  const totalizingNetworkClaim = /\b(each|every|all)\b(?:(?!\.).){0,80}\bnetwork call\b/i;
  ok(!totalizingNetworkClaim.test(introOnly),
    'so the intro makes no "each/every/all ... network call" claim, in any wording, while a catalog row says otherwise');
  ok(/each row/i.test(introOnly) && /cost/i.test(introOnly),
    'and it points at each row\'s own declared cost instead');

  // Prove the assertion above is not vacuously satisfied by "the intro merely never mentions network calls
  // at all" — construct the exact over-claim (reworded, not the literal historical sentence) and confirm
  // the regex actually catches it, so a future rewrite of `intro` in statusPage.ts is caught by MEANING.
  ok(totalizingNetworkClaim.test('Every one of the checks below makes a live network call.'),
    'sanity: the totalizing-claim regex actually fires on a reworded over-claim');
  ok(!totalizingNetworkClaim.test('Nothing has been run yet — checks run only when you ask.'),
    'sanity: and does not fire on ordinary, non-totalizing prose');
}

// ── Defect 1 (2026-08-08, David's first real use): the Checks intro must not go stale after a run ──
// The bug: a live run happens ENTIRELY client-side — the iframe has no network (see this file's own top
// doc comment), so "Run checks" posts to the parent, the parent hits `/kit/status?probe=1`, and the
// results come back over postMessage and get injected into `#spkChecksResults` only. The intro paragraph
// above it was chosen once, at the initial server render, when `doc.probes` is always null (checks never
// run automatically, so nothing has run yet at page-load). So "Nothing has been run yet" sat there,
// provably false, directly above four completed rows — the console stating something false about its own
// contents, which is exactly the failure mode this whole feature exists to prevent. Deriving the SERVER
// render from `doc.probes !== null` is necessary but not sufficient on its own, since the server only ever
// renders the not-run state in practice; the fix has to reach the client-side update too.
{
  // State 1: nothing run yet (doc.probes === null, the DOC() helper's default).
  const notRunHtml = statusHtml(DOC());
  const notRunAt = notRunHtml.indexOf('id="spkpanel-checks"');
  const notRunPanel = notRunHtml.slice(notRunAt, notRunHtml.indexOf('</main>', notRunAt));
  ok(notRunPanel.includes(CHECKS_INTRO_TEXT.notRun), 'not-run: the intro is the exact not-run sentence');

  // State 2: a completed run — four passing results, mirroring "four completed results" from the report.
  const sampleProbes: ProbeResult[] = PROBE_CATALOG.slice(0, 4).map((c) => ({ id: c.id, name: c.name, cost: c.cost, state: 'pass', detail: 'ok' }));
  ok(sampleProbes.length === 4, 'sanity: the catalog has at least four entries to sample from');
  const ranDoc = buildStatus(
    { NS_SERVER: 'api.example.com', NS_PORTAL_ISS: 'manage.example.com', PORTAL_MODE: '1',
      PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'dev' },
    { principal: P('Super User'), hostname: 'svc-dev.example.com', probes: sampleProbes });
  const ranHtml = statusHtml(ranDoc);
  const ranAt = ranHtml.indexOf('id="spkpanel-checks"');
  const ranPanel = ranHtml.slice(ranAt, ranHtml.indexOf('</main>', ranAt));
  const ranIntroOnly = ranPanel.slice(0, ranPanel.indexOf('spkChecksResults'));
  // Match the CLAIM, not one literal string, so a reword ("nothing has run", "no checks have been run")
  // is still caught — the same reasoning the L2 block above already applies to the network-call claim.
  const notRunClaim = /nothing has (?:been )?run|have not (?:yet )?(?:been )?run|no checks? (?:have|has) (?:been )?run/i;
  ok(!notRunClaim.test(ranIntroOnly),
    `run: with results present, the intro makes no "nothing has been run" claim (got: ${JSON.stringify(ranIntroOnly)})`);
  ok(ranPanel.includes(CHECKS_INTRO_TEXT.ranAlready), 'run: and instead carries the exact "results from the last run" sentence');

  // Sanity: prove the regex above actually fires on the historical bug, so a silent no-op change to the
  // matcher wouldn't leave this green for the wrong reason.
  ok(notRunClaim.test(CHECKS_INTRO_TEXT.notRun), 'sanity: the not-run-claim regex fires on the actual not-run sentence');

  // The client-side seam. Results are injected into the DOM entirely via postMessage — no second
  // `statusHtml()` render happens in the browser — so the two assertions above, which only exercise the
  // SERVER branch, cannot by themselves prove the intro updates after a real button click. The message
  // handler must locate the same #spkChecksIntro element and write the identical, single-sourced sentence
  // (CHECKS_INTRO_TEXT.ranAlready, imported — not a second hand-typed copy that could drift from it).
  const script = ranHtml.slice(ranHtml.indexOf('<script>'), ranHtml.lastIndexOf('</script>'));
  ok(script.includes("getElementById('spkChecksIntro')"), 'the client script locates the intro element by its id');
  ok(script.includes(JSON.stringify(CHECKS_INTRO_TEXT.ranAlready)),
    'and the response handler writes the SAME "already ran" sentence exported from statusPage.ts — not a retyped copy');
}

// ── Task: Run-checks control moves to the TOP of the tab, and auto-runs once per modal instance ─────
// David's request, reversing the on-demand decision deliberately: opening the Checks tab at all is
// already a deliberate action on a superadmin-gated page, so the checks now fire automatically the first
// time the tab is opened — once per modal instance, not on every switch back to it. The button stays (it
// re-runs on demand) and must be reachable without scrolling past the explainer/result rows first.
{
  // The control sits BEFORE the first check row, in document order — not merely present somewhere in the
  // panel. Position, not presence: a button appended after 18 rows would satisfy `panel.includes(...)`
  // but not "visible without scrolling".
  const html = statusHtml(DOC());
  const panelAt = html.indexOf('id="spkpanel-checks"');
  const btnAt = html.indexOf('id="spkRunChecks"', panelAt);
  const firstRowAt = html.indexOf('class="check-row"', panelAt);
  ok(panelAt > -1 && btnAt > -1 && firstRowAt > -1 && btnAt < firstRowAt,
    'the Run-checks control appears before the first check row, not after it');
}

{
  // State 1 (probes: null — nothing run yet). The intro must still say nothing has run (this state is
  // only briefly visible, or the fallback when auto-run cannot fire), and the auto-run TRIGGER must be
  // present in the emitted script — a DOM-less test cannot click through a live iframe, so this proves
  // the wiring exists, not that a browser actually fires it (see the ordering assertion below for what
  // it also proves about firing at most once).
  const html = statusHtml(DOC());
  const panelAt = html.indexOf('id="spkpanel-checks"');
  const panel = html.slice(panelAt, html.indexOf('</main>', panelAt));
  ok(panel.includes(CHECKS_INTRO_TEXT.notRun), 'not-run: the intro is the exact not-run sentence');

  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  ok(/\bautoRan\s*=\s*false\b/.test(script), 'not-run: the auto-run flag seeds false, since nothing has run yet');
  ok(script.includes("getElementById('spktab-checks')") && /addEventListener\(\s*'change'/.test(script),
    'and the script wires a change listener on the Checks-tab radio input — the auto-run trigger');
}

{
  // State 3 (a non-empty probes array — a completed run). The intro must not claim nothing has run
  // (covered in depth by the Defect 1 block above), and a re-run control must be present. Checked by the
  // control's own text, not just the intro, per David's follow-up: a button that still reads "Run Checks"
  // above a tab full of results implies, by omission, that nothing has run — the same defect the intro
  // fix addresses, carried in a control instead of a sentence.
  const sampleProbes: ProbeResult[] = PROBE_CATALOG.slice(0, 2).map((c) => ({ id: c.id, name: c.name, cost: c.cost, state: 'pass', detail: 'ok' }));
  const ranDoc = buildStatus(
    { NS_SERVER: 'api.example.com', NS_PORTAL_ISS: 'manage.example.com', PORTAL_MODE: '1',
      PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'dev' },
    { principal: P('Super User'), hostname: 'svc-dev.example.com', probes: sampleProbes });
  const html = statusHtml(ranDoc);
  const panelAt = html.indexOf('id="spkpanel-checks"');
  const panel = html.slice(panelAt, html.indexOf('</main>', panelAt));
  const notRunClaim = /nothing has (?:been )?run|have not (?:yet )?(?:been )?run|no checks? (?:have|has) (?:been )?run/i;
  ok(!notRunClaim.test(panel), 'complete: the intro makes no "nothing has run" claim');

  const btnMatch = panel.match(/id="spkRunChecks"[^>]*>([^<]*)</);
  ok(!!btnMatch && btnMatch[1] === 'Run Checks Again',
    `complete: the control reads exactly "Run Checks Again" (got: ${btnMatch ? JSON.stringify(btnMatch[1]) : 'no match'})`);
}

{
  // Sanity, mirrored from the not-run case: with nothing run yet the control reads exactly "Run Checks",
  // not "Run Checks Again" — proving the label is state-derived in BOTH directions, not just append-only.
  const html = statusHtml(DOC());
  const panelAt = html.indexOf('id="spkpanel-checks"');
  const panel = html.slice(panelAt, html.indexOf('</main>', panelAt));
  const btnMatch = panel.match(/id="spkRunChecks"[^>]*>([^<]*)</);
  ok(!!btnMatch && btnMatch[1] === 'Run Checks',
    `not-run: the control reads exactly "Run Checks" (got: ${btnMatch ? JSON.stringify(btnMatch[1]) : 'no match'})`);
}

{
  // The once-only guard. A DOM-less test cannot observe a real 'change' event firing twice, so this
  // proves the GUARD EXISTS AND IS ORDERED CORRECTLY in the emitted source: the listener checks
  // `!autoRan` BEFORE setting `autoRan = true`, and sets it BEFORE calling `runChecks()` — so a second
  // 'change' event on the same radio input (switch away from Checks, switch back) reads autoRan === true
  // and does nothing. What this does NOT prove: that the browser actually fires 'change' only on the
  // transition into checked (it does, per radio-group semantics — the same semantics the CSS
  // `:checked` tab-switcher already relies on), or that no other code path could still trigger a second
  // run. It proves the source contains the guard, ordered the way a no-double-fire guard has to be.
  const html = statusHtml(DOC());
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  const listenerAt = script.indexOf("getElementById('spktab-checks')");
  const guardAt = script.indexOf('!autoRan', listenerAt);
  const setAt = script.indexOf('autoRan = true', guardAt);
  const callAt = script.indexOf('runChecks()', setAt);
  ok(listenerAt > -1 && guardAt > listenerAt && setAt > guardAt && callAt > setAt,
    'the tab-open handler checks !autoRan, THEN sets autoRan = true, THEN calls runChecks() — in that order');
}

// ── the Named column exists only when it can say something ───────────────────────
// Item 22, and the sharpest lesson in this feature: this column was ADDED to answer item 18b (do not render
// a row that cannot vary for the people reading), and it committed the same defect one commit later. A gate
// carries `users:` only when someone configured one, which is the escape hatch rather than the norm — so on
// a typical deployment the column read "–" on all 18 rows while its highlight button reported "18 cannot be
// granted". Asserted in BOTH directions, because "hide it" that hides it always would be a different bug.
{
  const base = { NS_SERVER: 'ns.example.com', NS_PORTAL_ISS: 'portal.example.com', PORTAL_MODE: '1',
    PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'dev' };
  const opts = { principal: P('Super User', 'boss@example.com'), hostname: 'svc-dev.example.com' };

  const plainDoc = buildStatus(base, opts);
  ok(plainDoc.permissions.anyNamed === false, 'no gate names an account on a default config');
  const plain = statusHtml(plainDoc);
  ok(!/>Named</.test(plain), 'so the Named column header is absent — not rendered as a column of dashes');
  ok(!plain.includes('id="spkScopeNamed"'), 'and the control offering to highlight it is absent too');

  const namedDoc = buildStatus({ ...base, PORTAL_FEATURES: JSON.stringify({ 'callflow.view': { levels: ['reseller'], users: ['auditor@example.com'] } }) }, opts);
  ok(namedDoc.permissions.anyNamed === true, 'a users: grant flips anyNamed');
  const named = statusHtml(namedDoc);
  ok(/>Named</.test(named), 'and the column appears when it has something to report');
  ok(named.includes('id="spkScopeNamed"'), 'along with its highlight control');
  ok(named.includes('auditor@example.com'), 'and the row names the account its gate grants');

  // The general rule, checkable rather than remembered: no column may be uniformly non-informative. Applied
  // to the scope columns too — if one were dashes on every row it would be the same defect in a new place.
  const cellsOf = (html: string, cls: string): string[] =>
    [...html.matchAll(new RegExp('<td class="pc ([a-z- ]*' + cls + '[a-z- ]*)"', 'g'))].map((m) => m[1]!);
  const superCells = cellsOf(named, 'pc-super');
  ok(superCells.length > 0 && !superCells.every((c) => c.includes('pc-na')),
    'the Superadmin column is informative (not uniformly "cannot be granted")');
}

// ── item 23: the CELL a config change touched, in both directions ────────────────
{
  const base = { NS_SERVER: 'ns.example.com', NS_PORTAL_ISS: 'portal.example.com', PORTAL_MODE: '1',
    PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'dev' };
  const opts = { principal: P('Super User', 'boss@example.com'), hostname: 'svc-dev.example.com' };

  // callflow.view defaults to `reseller`; widening it to office_manager GRANTS the Office Manager cell.
  const granted = buildStatus({ ...base, PORTAL_FEATURES: JSON.stringify({ 'callflow.view': 'office_manager' }) }, opts);
  const gRow = granted.permissions.rows.find((r) => r.key === 'callflow.view')!;
  const gOm = gRow.cells.find((c) => c.scope === 'Office Manager')!;
  ok(gOm.delta === 'granted', `[delta] widening a gate marks the newly-available cell (got: ${gOm.delta})`);
  ok(gRow.cells.find((c) => c.scope === 'Reseller')!.delta === null,
    '[delta] and a cell the change did not affect carries no mark');
  ok(gRow.cells.find((c) => c.scope === 'Basic User')!.delta === null,
    '[delta] nor does one that was and remains unavailable');
  ok(/pc-delta pc-delta-granted/.test(statusHtml(granted)), '[delta] the mark reaches the page');

  // Narrowing is the direction that matters more — an override that takes access away is the easier one to
  // write by accident, and the row-level OVERRIDDEN badge cannot say which way it went. `RINGOTEL_API_KEY`
  // is set here on purpose: the mark tracks the AVAILABLE boundary, so a feature that is inert either way
  // has no boundary to cross (see the next assertion, which pins that decision).
  const withKey = { ...base, RINGOTEL_API_KEY: 'k' };
  const revoked = buildStatus({ ...withKey, PORTAL_FEATURES: JSON.stringify({ 'ringotel.userStatus': 'reseller' }) }, opts);
  const rOm = revoked.permissions.rows.find((r) => r.key === 'ringotel.userStatus')!.cells.find((c) => c.scope === 'Office Manager')!;
  ok(rOm.delta === 'revoked', `[delta] narrowing a gate marks the cell it took away (got: ${rOm.delta})`);
  ok(/pc-delta-revoked/.test(statusHtml(revoked)), '[delta] and that mark is visually distinct in the page');

  // The deliberate limit, pinned so it is a decision rather than an accident: a gating change on a feature
  // that cannot run either way crosses no boundary the reader can act on, so it is NOT marked. Same
  // narrowing, without the API key ⇒ inert on both sides ⇒ no mark.
  const inertBoth = buildStatus({ ...base, PORTAL_FEATURES: JSON.stringify({ 'ringotel.userStatus': 'reseller' }) }, opts);
  const iOm = inertBoth.permissions.rows.find((r) => r.key === 'ringotel.userStatus')!.cells.find((c) => c.scope === 'Office Manager')!;
  ok(iOm.delta === null,
    `[delta] a gating change on a feature that is inert either way is NOT marked — no boundary the reader can act on (got: ${iOm.delta})`);

  // No overrides ⇒ no marks anywhere. Otherwise the ring would be decoration rather than a signal.
  const plain = buildStatus(base, opts);
  ok(plain.permissions.rows.every((r) => [...r.cells, r.superadmin].every((c) => c.delta === null)),
    '[delta] an unconfigured deployment carries no marks at all');
  // Scoped to the TABLE BODY: the <style> block defines .pc-delta and the legend renders one as a swatch,
  // both legitimately. Only a mark inside a data cell is a claim about this deployment's config.
  const plainHtml = statusHtml(plain);
  const tbody = plainHtml.slice(plainHtml.indexOf('<tbody>'), plainHtml.indexOf('</tbody>'));
  ok(tbody.length > 100 && !/pc-delta/.test(tbody), '[delta] and no data cell in the matrix carries one');
}

// ── item 25: the audience split is structural on the matrix, not a per-row badge ──
{
  const doc = DOC();
  const html = statusHtml(doc);
  const panel = html.slice(html.indexOf('id="spkpanel-permissions"'), html.indexOf('id="spkpanel-config"'));
  const dividers = (panel.match(/class="audrow"/g) || []).length;
  ok(dividers === 2, `[audience] the matrix carries exactly two audience dividers (found ${dividers})`);
  // Rows are SORTED by audience, so the split is a fact rather than a coincidence of registry order that a
  // future insertion would break.
  const ranks = doc.permissions.rows.map((r) => r.audienceRank);
  ok(ranks.every((v, i) => i === 0 || ranks[i - 1]! <= v), '[audience] and the rows are sorted by it');
  ok(ranks.includes(0) && ranks.includes(1), '[audience] with both blocks non-empty');
  // And the removed ADMIN badge stays removed: it was on 18 of 18 rows, which is what got it cut.
  ok(!/aud-admin/.test(panel), '[audience] no per-row ADMIN badge came back');
}

// ── item 30: the worked examples must survive our OWN validator ──────────────────
// The property that makes it safe to ship documentation from the console: an example that stopped being
// valid fails here rather than teaching an adopter something false.
{
  const doc = DOC();
  ok(doc.permissions.examples.length >= 5, 'a worked example exists for each gate shape');
  for (const e of doc.permissions.examples) {
    let threw: unknown = null;
    try { parseFeatures({ PORTAL_FEATURES: e.json }); } catch (err) { threw = err; }
    ok(!threw, `[examples] "${e.title}" parses${threw ? ` (${threw instanceof Error ? threw.message : String(threw)})` : ''}`);
    ok(e.what.length > 30, `[examples] "${e.title}" says what the shape is FOR, not just what it looks like`);
  }
  // jsonError folds the example check in, so a bad example surfaces on the page rather than silently.
  ok(doc.permissions.jsonError === null, '[examples] and the page reports no validation problem');
  // The shapes that a live config cannot show are exactly the ones worth documenting.
  const all = doc.permissions.examples.map((e) => e.json).join('\n');
  ok(/"users"/.test(all), '[examples] the named-accounts shape is covered — the one nobody finds by accident');
  ok(/"off"/.test(all), '[examples] and the kill switch');
  ok(/\[/.test(all), '[examples] and the level-union shape');
  ok(statusHtml(doc).includes('What else you can write'), '[examples] the block reaches the page');
}

// ── item 26/27: the long tabs can be navigated, and the trip back exists ─────────
{
  const html = statusHtml(DOC());
  const cfg = html.slice(html.indexOf('id="spkpanel-config"'), html.indexOf('id="spkpanel-checks"'));
  const tocs = (cfg.match(/class="tocref"/g) || []).length;
  const secs = (cfg.match(/class="cfggroup cfgsec"/g) || []).length;
  ok(tocs > 5, `[toc] the Config tab offers a jump per group (${tocs} links)`);
  ok(tocs === secs, `[toc] one jump link per rendered section, no dangling either way (${tocs} vs ${secs})`);
  // Every jump target must exist — a link to an absent id is navigation to nothing.
  const targets = [...cfg.matchAll(/data-target="([^"]+)"/g)].map((m) => m[1]!);
  const missing = targets.filter((t) => !cfg.includes(`id="${t}"`));
  ok(missing.length === 0, `[toc] every jump target exists${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  ok(cfg.includes('id="spkBackBar"'), '[back] the Config tab carries the return control');
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  ok(/origin\.card/.test(script), '[back] and the return restores the CARD, not just the tab');
  ok(/if \(this\.id !== 'spktab-config'\) clearBack\(\)/.test(script),
    '[back] a manual tab switch clears the stale offer to go back');
}


// ── the ONE place markup is allowed in this file, and it must be provably safe ────
// `richPara` is the single exception to "every string goes through esc()", which is the rule that makes a
// secret structurally unable to reach the page. So it is tested as a security boundary, not as a formatter:
// a whitelist on the scheme, escaping on both halves, and graceful degradation to plain text.
{
  ok(richPara('plain text') === 'plain text', '[rich] text with no link passes through unchanged');
  ok(richPara('a [b](https://example.com) c') === 'a <a href="https://example.com" target="_blank" rel="noopener noreferrer">b</a> c',
    '[rich] an https link becomes an anchor that cannot reach the opener');

  // Refused schemes degrade to the plain LABEL — never to an anchor, and never to nothing (silently
  // dropping the text would lose content).
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://example.com', '//example.com', 'HTTPS://example.com']) {
    const out = richPara(`see [here](${bad}) now`);
    ok(!/<a /.test(out), `[rich] refuses ${bad} — no anchor`);
    ok(out.includes('here'), `[rich] and keeps the label as text for ${bad}`);
  }

  // Both halves escaped. The label is the one an author controls loosely, so prove it cannot open a tag.
  ok(!/<b>/.test(richPara('x [<b>bold</b>](https://example.com) y')), '[rich] the label is escaped');
  ok(richPara('a < b & c').includes('&lt;') && richPara('a < b & c').includes('&amp;'),
    '[rich] and so is the surrounding text');
  // A quote in the href must not be able to close the attribute.
  ok(!/href="https:\/\/example.com" onload/.test(richPara('[x](https://example.com" onload=y)')),
    '[rich] a quote in the href cannot break out of the attribute');

  // And the prose actually reaches the page as a link, not as visible brackets.
  const html = statusHtml(DOC());
  ok(html.includes('rel="noopener noreferrer"'), '[rich] the rendered page contains a safe outbound link');
  ok(!/\[Ringotel\]\(/.test(html), '[rich] and no raw link syntax is left visible');

  // Code spans, added because prose that mentions a setting or a JSON key naturally uses backticks, and they
  // were rendering as literal characters on the page.
  ok(richPara('set `add` here') === 'set <code>add</code> here', '[rich] a code span becomes a code element');
  ok(richPara('`<script>`') === '<code>&lt;script&gt;</code>', '[rich] and its contents are escaped');
  ok(richPara('`a` and `b`') === '<code>a</code> and <code>b</code>', '[rich] several spans in one paragraph');
  ok(richPara('an unclosed ` backtick') === 'an unclosed ` backtick', '[rich] an unpaired backtick is left as text');
  // Both forms in one paragraph, and neither produced from the other's output.
  ok(richPara('[x](https://example.com) and `y`').includes('<code>y</code>') && richPara('[x](https://example.com) and `y`').includes('<a href='),
    '[rich] links and code coexist');
  ok(!/<code>/.test(richPara('[`a`](https://example.com)')) || richPara('[`a`](https://example.com)').includes('<a href='),
    '[rich] a link whose label contains backticks still renders as a link, not as nested markup');
  // Scoped to the `.why` blocks — the prose `richPara` actually renders. A blanket "no backtick anywhere"
  // assertion fails on something older and different: the 64 setting descriptions have always used markdown
  // backticks in plain-text fields, which surface literally in the Config rows and unavoidably inside
  // `title` attributes (an attribute cannot carry markup). That is a real cosmetic wart, but it is item 2's
  // prose pass, not this change — and asserting it here would have made this test fail for a reason it is
  // not about.
  {
    const body = statusHtml(DOC());
    const whys = [...body.matchAll(/<div class="why">([\s\S]*?)<\/div>/g)].map((m2) => m2[1]!);
    ok(whys.length > 0, '[rich] there are prose blocks to check');
    const leaked = whys.filter((w) => w.includes('`'));
    ok(leaked.length === 0, `[rich] no literal backtick survives in rendered prose (${leaked.length} block(s) leak)`);
  }
}


// ── the collapsed integration groups, and a roll-up that cannot disagree with them ─
// Collapsing is only safe if it costs the reader nothing they were using — the states are what you scan an
// integration for. So the toggle carries them, and the counts are DERIVED from the child cards rather than
// kept beside them, which is the two-derivations bug this codebase keeps finding.
{
  const doc = DOC();
  const html = statusHtml(doc);
  const panel = html.slice(html.indexOf('id="spkpanel-integrations"'), html.indexOf('id="spkpanel-permissions"'));
  const rows = doc.subsystems.filter((x) => x.tab === 'integration');
  const withKids = rows.filter((p) => p.parent === null && rows.some((k) => k.parent === p.id));

  ok((panel.match(/class="kidgroup"/g) || []).length === withKids.length,
    'each integration that has parts wraps them in a collapsible group');
  // Collapsed by DEFAULT: an all-expanded tab is thousands of words before the second integration now that
  // every card carries prose.
  // Open by default while only ONE integration has parts: nobody discovers a collapsed group they did not
  // know existed, and hiding the only one hides the point of the tab. The rule is derived from the count, not
  // from naming an integration, so it flips itself when a second one gains parts.
  if (withKids.length === 1) {
    ok(/class="kidgroup" open>/.test(panel), 'the sole group with parts starts OPEN, so its parts are discoverable');
    const script1 = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
    ok(/if \(kidGroups\.length > 1\)/.test(script1),
      'and no accordion competes for the space while there is only one group');
  } else {
    ok(!/class="kidgroup" open>/.test(panel), 'with several groups they start collapsed and behave as an accordion');
  }

  // The roll-up must agree with the cards it summarises, for every group.
  for (const p of withKids) {
    const kids = rows.filter((k) => k.parent === p.id);
    // Anchored on the KIDGROUP's summary, not the first summary after the anchor — the parent card's own
    // "what it needs" disclosure comes first, and slicing that instead silently tested the wrong element.
    const at = panel.indexOf(`id="sec-int-${p.id}"`);
    const groupAt = panel.indexOf('class="kidgroup"', at);
    const summary = panel.slice(panel.indexOf('<summary>', groupAt), panel.indexOf('</summary>', groupAt));
    ok(summary.includes(`${kids.length} part`), `[rollup] ${p.id} names its part count (${kids.length})`);
    for (const st of ['on', 'off', 'inert', 'misconfigured', 'not-integrated']) {
      const n = kids.filter((k) => k.state === st).length;
      if (n === 0) continue;
      ok(new RegExp(`pill-${st}">[A-Z ]+</span> ${n}`).test(summary),
        `[rollup] ${p.id} reports ${n} ${st}`);
    }
    // A state with no children must not appear — a zero in a roll-up reads as a category that exists.
    const absent = ['on', 'off', 'inert', 'misconfigured'].filter((st) => kids.every((k) => k.state !== st));
    for (const st of absent) {
      ok(!new RegExp(`pill-${st}">[A-Z ]+</span> 0`).test(summary), `[rollup] ${p.id} shows no zero for ${st}`);
    }
  }

  // Every card carries its own way back up, since a card can now be several screens tall on its own.
  const cards = (panel.match(/class="card(?: card-child)?"/g) || []).length;
  const tops = (panel.match(/class="totop"/g) || []).length;
  ok(cards > 0 && tops >= cards, `[top] every integration card offers a way back to the top (${tops} vs ${cards} cards)`);
}


// ── requirements are disclosed or always-visible per COLUMN WIDTH, not per card ────
// At full width the settings list is shorter than the control that would hide it, and `missing`/`notes` are
// the actionable part — an INERT card should say what is absent without being asked. In a three-across grid
// the same list wraps to five or six lines and the disclosure still earns its place.
{
  const doc = DOC();
  const html = statusHtml(doc);
  const intPanel = html.slice(html.indexOf('id="spkpanel-integrations"'), html.indexOf('id="spkpanel-permissions"'));
  const depPanel = html.slice(html.indexOf('id="spkpanel-backend"'), html.indexOf('id="spkpanel-checks"'));

  ok(intPanel.includes('class="reqs"'), '[reqs] full-width integration cards show requirements without a click');
  ok(!/<summary>What it needs/.test(intPanel), '[reqs] and offer no disclosure to open');
  // The Backend cards became full-width too, once every one of them carried prose — so they now show their
  // requirements inline for the same reason the integration cards do. This assertion used to say the opposite
  // and was correct when it was written; the layout choice moved, so the expectation moves with it. What is
  // still asserted is the RULE: `layout: 'full'` means inline, and it is applied consistently.
  ok(depPanel.includes('class="reqs"'), '[reqs] full-width Backend cards also show requirements without a click');
  ok(!/<summary>What it needs/.test(depPanel), '[reqs] and offer no disclosure to open');
  // The grid layout still exists and still discloses — asserted on the Features tab, which uses it.
  const featPanel = html.slice(html.indexOf('id="spkpanel-features"'), html.indexOf('id="spkpanel-integrations"'));
  ok(/<summary>What it needs/.test(featPanel), '[reqs] the three-across Features cards keep theirs disclosed');

  // An INERT card is the case this exists for: its missing list must be on screen, not behind a control.
  const inert = doc.subsystems.filter((x) => x.tab === 'integration' && x.state === 'inert' && x.missing.length > 0);
  for (const c of inert) {
    const at = intPanel.indexOf(`>${c.id}<`);
    const card = intPanel.slice(at, at + 4000);
    ok(/<dt>Missing<\/dt>/.test(card), `[reqs] ${c.id} is INERT and shows what is missing inline`);
  }
  // A card with nothing to say still gets neither — an empty block is as bad as an empty disclosure.
  const bare = doc.subsystems.filter((x) => x.tab === 'integration' && x.settings.length === 0 && x.missing.length === 0 && x.notes.length === 0);
  ok(bare.length > 0, '[reqs] there is at least one card with nothing to show (the unwired integrations)');
  for (const c of bare) {
    const at = intPanel.indexOf(`>${c.id}<`);
    const card = intPanel.slice(at, intPanel.indexOf('class="card', at + 10) === -1 ? at + 3000 : intPanel.indexOf('class="card', at + 10));
    ok(!/class="reqs"/.test(card), `[reqs] ${c.id} has nothing to show and renders no empty block`);
  }
}


// ── "top" means the top of the PAGE, not the top of the panel ─────────────────────
// The header and the tab bar sit above every panel, so scrolling a panel into view left them off-screen —
// which defeats the purpose, since the usual reason to go back up is to switch tabs. Asserted on the emitted
// script because there is no DOM here to scroll.
{
  const script = statusHtml(DOC());
  const body = script.slice(script.indexOf('<script>'), script.lastIndexOf('</script>'));
  const handler = body.slice(body.indexOf("classList.contains('totop')"), body.indexOf("classList.contains('totop')") + 400);
  ok(/window\.scrollTo\(0, 0\)/.test(handler), '[top] the handler scrolls the document to the top');
  ok(!/spk-panel/.test(handler), '[top] and does NOT scroll the panel, which would hide the tab bar');
}

// ── the SSO setting carries the same warning its card does ────────────────────────
// Naming the service makes the portal CLAIM sso; it does not make SSO work. Someone reading the Config tab
// row in isolation must get that, or the console has moved the trap rather than closed it.
{
  const doc = DOC();
  const row = doc.settings.find((x) => x.name === 'RINGOTEL_SSO_SERVICE')!;
  // Case-insensitive on purpose: the assertion is about the CLAIM being present, not about it being shouted.
  // It was written against "does NOT enable", and the caps were later toned down — a test that pins emphasis
  // rather than meaning fails on an editorial pass and teaches nothing.
  ok(/does not enable single sign-on/i.test(row.what), '[sso] the setting says it does not enable SSO');
  ok(/separate Worker/.test(row.what), '[sso] and names the separate deployment that does');
  ok(/can see or verify/.test(row.what), '[sso] and is explicit that this deployment cannot verify it');
  // The pointer must name a real destination on this page, or it is a dead reference.
  ok(/Integrations tab/.test(row.what) && statusHtml(doc).includes('>Integrations<'),
    '[sso] and points at a tab that exists');
}


// ── the Config accordion, and the two ways it could silently break ────────────────
// 64 settings in 12 sections is too long flat, so each section collapses and the tab opens as an index. Two
// things must hold or the collapse costs more than it saves: a FILTER must open what it matched, and a JUMP
// from another tab must open the section it lands in. Both are the difference between "unhelpful" and "looks
// broken".
{
  const html = statusHtml(DOC());
  const cfg = html.slice(html.indexOf('id="spkpanel-config"'), html.indexOf('id="spkpanel-checks"'));
  ok((cfg.match(/<details class="cfggroup cfgsec"/g) || []).length > 5, '[accordion] each group is collapsible');
  ok(!/cfgsec"[^>]*\sopen/.test(cfg), '[accordion] and every one starts closed — the tab is an index');
  // The native exclusive-accordion attribute must NOT be used: it would enforce one-open-at-a-time even for
  // scripted opens, so a filter matching three groups would show one group's results and silently drop two.
  ok(!/<details class="cfggroup cfgsec"[^>]*name=/.test(cfg),
    '[accordion] exclusivity is NOT the native name= attribute, which would break multi-group filtering');

  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  ok(/function closeOthers/.test(script), '[accordion] exclusivity is implemented in script instead');
  ok(/if \(this\.open && !filtering\(\)\) closeOthers\(this\)/.test(script),
    '[accordion] and is suppressed while a filter is active');
  // The filter opens matches and restores the index when cleared.
  ok(/if \(q\) groups\[g\]\.open = vis > 0;/.test(script), '[accordion] a filter opens every matching group');
  ok(/else groups\[g\]\.open = false;/.test(script), '[accordion] and clearing the box restores the collapsed index');
  // A jump must open the section it targets — from a card, and from the tab's own jump bar.
  ok(/openSection\(row, true\)/.test(script), '[accordion] jumping to a setting opens its section');
  ok(/if \(el\.tagName === 'DETAILS'\) \{ el\.open = true;/.test(script),
    '[accordion] and a jump-bar link opens the section it points at');
  // Every jump target is a section that exists, still.
  const targets = [...cfg.matchAll(/data-target="([^"]+)"/g)].map((m2) => m2[1]!);
  const missing = targets.filter((t) => !cfg.includes(`id="${t}"`));
  ok(missing.length === 0, `[accordion] every jump target exists${missing.length ? ` (${missing.join(', ')})` : ''}`);
}


// ── the prose must not shout ──────────────────────────────────────────────────────
// David, reading 0.2.31: "too many capitals for emphasis like THREE MENUS or NAME or READ or DO or ONE TRAP
// those are a little overenthusiastic". He was right, and several of them were doing a HEADING's job — hence
// `richBlock`'s `### ` form. This guard stops the habit returning: a run of shouted words in rendered prose
// fails, with an allowlist for the things that are genuinely acronyms or literal setting names.
{
  const doc = DOC();
  // Genuine acronyms, product/protocol names, literal config VALUES (`on`/`off` are settings values, not
  // emphasis) and single letters. Everything else that is shouted has to be justified by editing this line,
  // which is the point — the list is the record of what counts as not-shouting.
  const ALLOWED = /^(SSO|API|JSON|URL|URI|CSV|IP|WAF|SIP|PBX|JWT|JWKS|GET|POST|PUT|OAUTH|CDN|DOM|CSS|HTML|R2|KV|D1|NS|CF|TTL|MFA|TOTP|UI|DID|ID|ON|OFF|SHARED|VOICEMAIL|FAX|CONFERENCE|CONF|RM|ROOM|ROUTING|GENERAL|MAILBOX|APP|WEB|A|I)$/;
  const isSettingName = (w: string): boolean => /_/.test(w) || doc.settings.some((x) => x.name === w);
  const shouted: string[] = [];
  const scan = (para: string, where: string): void => {
    // Two or more consecutive all-caps words, or one word of 4+ caps — the shapes he objected to.
    for (const m2 of para.matchAll(/\b[A-Z][A-Z]+(?: [A-Z][A-Z]+)*\b/g)) {
      const phrase = m2[0]!;
      const words = phrase.split(' ');
      if (words.every((w) => ALLOWED.test(w) || isSettingName(w))) continue;
      // No length bypass. A "short words are probably acronyms" exemption let "AS" through in
      // "performed AS the person", which is exactly the shouting being guarded against — the allowlist above
      // already covers the genuinely short acronyms (IP, R2, KV, NS, UI, GET…), so anything not on it is a
      // deliberate decision to add, not something to wave past on length.
      shouted.push(`${where}: "${phrase}"`);
    }
  };
  for (const c of doc.subsystems) c.detail.forEach((p2) => scan(p2, c.id));
  for (const f of doc.features) f.detail.forEach((p2) => scan(p2, f.key));
  // The endpoint prose too. It is the same kind of operator-facing text and was NOT covered when this guard
  // was written — so it still said "THE string to load" while everything the guard did scan had been cleaned
  // up. A guard with a hole in it reads as coverage.
  for (const e of doc.deployment.endpoints) scan(e.what, `endpoint:${e.label}`);
  for (const st of doc.settings) { scan(st.what, `setting:${st.name}`); scan(st.whenUnset, `unset:${st.name}`); }
  ok(shouted.length === 0,
    `no card prose shouts for emphasis${shouted.length ? ` (${[...new Set(shouted)].slice(0, 8).join(' | ')})` : ''}`);

  // And the replacement mechanism is actually used, rather than the caps merely being lowercased into a wall
  // of undifferentiated paragraphs.
  const heads = [...doc.features, ...doc.subsystems].flatMap((c) => c.detail).filter((p2) => p2.startsWith('### '));
  ok(heads.length >= 5, `long cards use subheadings instead (${heads.length} found)`);
  const html = statusHtml(doc);
  ok(html.includes('class="whyh"'), 'and they render as headings, not as paragraphs');
  ok(!html.includes('&gt;## ') && !/<p>### /.test(html), 'with no raw marker left visible');
}


// ── the filter can be cleared without selecting and deleting ──────────────────────
{
  const html = statusHtml(DOC());
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  ok(html.includes('id="spkFilterClear"'), '[filter] there is a clear control');
  ok(/aria-label="Clear the filter"/.test(html), '[filter] with an accessible name — it renders as a bare glyph');
  // Ours rather than the browser's: type=search gives WebKit a clear button and Firefox nothing, so relying on
  // the native one means the affordance exists for some readers and not others.
  ok(/::-webkit-search-cancel-button/.test(html), '[filter] the native clear button is suppressed');
  ok(/\.filterclear\.on \{ display:block/.test(html), '[filter] and ours appears only when there is text');
  ok(/function syncClear/.test(script) && /clearBtn\.classList\.toggle\('on', filtering\(\)\)/.test(script),
    '[filter] shown/hidden from the same `filtering()` the accordion uses, not a second notion of "has text"');
  // Clearing must re-run the filter, or the rows stay hidden with an empty box — which reads as "no results".
  ok(/function clearFilter\(\)\{?[\s\S]{0,200}applyFilter\(\)/.test(script),
    '[filter] clearing re-runs the filter rather than only emptying the box');
  ok(/ev\.key === 'Escape'/.test(script), '[filter] Escape clears it too');
}


// ── the header version is a link, and safely ──────────────────────────────────────
{
  const html = statusHtml(DOC());
  const h1 = html.slice(html.indexOf('<h1>'), html.indexOf('</h1>') + 5);
  ok(/<a class="ver" href="https:\/\//.test(h1), '[verlink] the version in the header is a link');
  ok(/rel="noopener noreferrer"/.test(h1),
    '[verlink] which cannot reach the opener — this page is embedded in a portal');
  ok(/target="_blank"/.test(h1), '[verlink] and opens in a new tab rather than replacing the modal');

  // Declared-as-none renders the version as plain text, not a dead anchor.
  const off = statusHtml(buildStatus(
    { NS_SERVER: 'ns.example.com', NS_PORTAL_ISS: 'p.example.com', PORTAL_MODE: '1',
      PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', PORTAL_RELEASE_NOTES_URL: '' },
    { principal: P('Super User', 'boss@example.com'), hostname: 'svc.example.com' },
  ));
  const offH1 = off.slice(off.indexOf('<h1>'), off.indexOf('</h1>') + 5);
  ok(!/<a /.test(offH1) && /<span class="ver">v/.test(offH1),
    '[verlink] with the link switched off, the version is plain text and no anchor is left in the DOM');
}


// ── the Menus tab and its builder (item 33) ──────────────────────────────────────────────────────────
{
  const doc = DOC();
  const html = statusHtml(doc);
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));

  ok(/id="spkpanel-menus"/.test(html), '[menus] the tab renders a panel');
  ok(/label for="spktab-menus"/.test(html), '[menus] with a tab to reach it');
  // Before Config: this tab WRITES a setting and Config READS all of them.
  ok(html.indexOf('spktab-menus') < html.indexOf('spktab-config'), '[menus] and it sits before Config');

  // Current state is SERVER-rendered, so the tab says something true with no bridge, no script and no
  // portal — which is also what makes it testable offline and renderable in the static demo.
  ok(/What your config does now/.test(html), '[menus] current state is server-rendered');
  for (const name of ['apps', 'account', 'management']) {
    ok(html.includes(`>${name}</code>`), `[menus] naming the ${name} menu`);
  }

  // The builder starts EMPTY and asks the page. A builder that rendered a mock-up of a portal menu would
  // be wrong for every deployment but the one it was drawn against.
  ok(/Asking the portal page for its menus/.test(html), '[menus] the builder starts pending, not populated');
  ok(script.includes(`{ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.menusRequest}' }`), '[menus] and asks over the bridge');

  // Validation round-trips to the deployment's own validator. The builder must NOT carry a second copy of
  // the rules — the https-only scheme and the ban on a {variable} in a URL authority are a phishing guard,
  // and the copy that drifts would be the one enforcing it.
  ok(script.includes(SPK_BRIDGE.checkRequest), '[menus] the builder asks the deployment to validate');
  ok(!/https:\\\/\\\//.test(script) && !script.includes('must start with https'),
    '[menus] and carries no copy of the URL rules of its own');
  // Three outcomes. "Could not check" rendering as valid would be worse than not checking at all.
  ok(/v\.unchecked/.test(script) && /v\.ok/.test(script) && /v\.error/.test(script),
    '[menus] with unchecked, valid and rejected as three distinct outcomes');

  // Both output forms, and the escaped one DERIVED rather than hand-escaped.
  ok(/id="spkmb-json"/.test(html) && /id="spkmb-wr"/.test(html), '[menus] both config forms have a home');
  ok(script.includes('JSON.stringify(JSON.stringify(cfg))'),
    '[menus] the wrangler form is derived by double-stringify, not hand-escaped');
}

// ── rendered OUTSIDE the portal, the page must not imply work is happening ───────────────────────────
// Every live thing here is a postMessage round-trip to the hosting portal window. Rendered anywhere else —
// a static export, a saved page — the messages go nowhere, and the page sat on "Running…" and "Asking the
// portal page…" forever. Those states assert that something is in flight. A console whose entire job is
// reporting the truth must not be the thing implying work is underway.
{
  const html = statusHtml(DOC());
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  ok(/window\.parent && window\.parent !== window/.test(script),
    '[unhosted] the page detects whether it has a parent to talk to');
  // Guarded at the SEND sites, not just the button, or the auto-run on tab-open still hangs it.
  ok(/if \(!HOSTED\) return;/.test(script), '[unhosted] the check runner refuses rather than hanging');
  ok(/if \(HOSTED\) window\.parent\.postMessage/.test(script), '[unhosted] and the observed-page request is guarded');
  ok(/if \(mbHost && HOSTED\)/.test(script), '[unhosted] as is the builder\'s menu read');
  // Disabled, not left to fail: pressing a button that cannot work and then waiting is worse than being
  // told up front.
  ok(/Checks need the portal/.test(script), '[unhosted] the button says why it cannot run');
  // The builder still works on the half that needs no bridge — your existing config.
  ok(/mbStart\(\{\}\);/.test(script), '[unhosted] the builder still loads your configured menus');
}

// ── the builder emits a COMPLETE config, which is a correctness property ─────────────────────────────
// The emitted string replaces PORTAL_MENUS wholesale. A builder that knew only about your edits would
// therefore produce a config that silently deletes every menu you did not touch — which is what 0.2.37
// shipped. These assertions are about not doing that again.
{
  const running = {
    apps: { hide: ['Meeting'] },
    account: { add: { scopes: { Reseller: [] }, '*': [{ label: 'Email Support', url: 'https://e.example' }] } },
  };
  const doc = { ...DOC(), menus: { ...DOC().menus, raw: JSON.stringify(running) } };
  const html = statusHtml(doc as never);
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));

  // The live config is embedded, so the builder can differ against it rather than starting from empty.
  ok(/var MB_BASE = \{/.test(script), '[full] the running config is embedded as the builder\'s starting point');
  ok(script.includes('Email Support') && script.includes('Meeting'),
    '[full] carrying what is actually configured, both menus');
  // Emitted per menu from MB_BASE when untouched — the property that makes the output non-destructive.
  ok(/one\.hide = mbClone\(base\.hide\)/.test(script) && /one\.add = mbClone\(base\.add\)/.test(script),
    '[full] an untouched menu is emitted from the running config, not omitted');
  // A TARGETED menu cannot be represented by a flat tick-list, so it must be locked and passed through.
  // Flattening it to one probe rung would quietly narrow it to a single audience.
  ok(/hideLocked: mbIsTargeted\(base\.hide\)/.test(script) && /addLocked: mbIsTargeted\(base\.add\)/.test(script),
    '[full] a targeted menu is locked rather than flattened');
  ok(/not editable here yet/.test(script), '[full] and says so where the operator is looking');
  // Not editable is only half an answer. Saying a rule exists while hiding what it says is the worst of
  // both — you can neither change it nor read it without leaving the tab. Whatever the builder cannot edit,
  // it still shows.
  ok(/function mbShowRungs/.test(script), '[full] and shows the targeted rungs read-only rather than only naming them');
  ok(/nothing — an exemption/.test(script),
    '[full] naming an empty rung, since an empty list is the "everyone except these" idiom and not a blank');

  // Reset returns to the RUNNING config, not to empty. Empty is a config too, and a destructive one.
  ok(/spkmb-reset/.test(html) && /mbSeed\(\); mbRebuild\(\);/.test(script),
    '[full] Reset restores the running config rather than clearing');

  // Hide-by-name exists: the menu relabels itself by context, and other injections add entries this page
  // load never showed, so ticking what is visible cannot be the only way in.
  ok(/Hide an entry by name/.test(script), '[full] an entry can be hidden by name');
  ok(/Also hidden by your config, but not on this page/.test(script),
    '[full] and hides for labels not on this page stay visible instead of vanishing');

  // Existing added entries are EDITABLE in place, not read-only prose above the editor.
  ok(/st\.add\.forEach\(function\(entry\)\{ mbAddRow/.test(script),
    '[full] entries already in your config are editable');

  // A malformed running config must not break the page — the console is where you go to fix it.
  const bad = { ...DOC(), menus: { ...DOC().menus, raw: '{ not json' } };
  let threw = false;
  try { statusHtml(bad as never); } catch { threw = true; }
  ok(!threw, '[full] a malformed running config still renders the tab');
}

// ── the menu builder seeds from NORMALIZED keys (Fable review, 2026-08-09) ─────────────────────────────
// `parseMenus` lowercases each menu name before applying it, so `{"Apps":{...}}` is valid config that
// genuinely runs. The builder looked it up by the canonical lowercase name, found nothing, and -- since
// 0.2.39 it emits the COMPLETE config rather than a diff -- would have produced an empty menu that,
// pasted back, DELETED the working one. Asserted on the embedded seed, which is what the builder reads.
{
  const d = DOC();
  d.menus.raw = JSON.stringify({ Apps: { hide: ['SNAPmobile Web'] } });
  const html = statusHtml(d);
  const m = html.match(/MB_BASE\s*=\s*(\{.*?\});/);
  ok(!!m, 'the builder embeds a seed object');
  const seed = JSON.parse(m![1].replace(/\\u003c/g, '<'));
  ok(Object.keys(seed).includes('apps'), 'a capitalised menu key is seeded under its canonical lowercase name');
  ok(!Object.keys(seed).includes('Apps'), 'and not under the operator\'s casing, which the builder cannot find');
  ok(JSON.stringify(seed.apps) === JSON.stringify({ hide: ['SNAPmobile Web'] }), 'carrying that menu\'s real contents');
}

// A menu LABEL is operator prose and is never scheme-checked the way a url is, so it must not be able to
// close the inline script it is embedded in. The console is a sandboxed srcdoc, so this is the operator's
// own view rather than a cross-tenant issue -- but "no raw text in a script position" is held everywhere
// else in this file, and a rule with one exception is the one that gets forgotten.
{
  const d = DOC();
  d.menus.raw = JSON.stringify({ apps: { add: [{ label: '</script><b>x', url: 'https://example.com' }] } });
  const html = statusHtml(d);
  const seedLine = html.slice(html.indexOf('MB_BASE'), html.indexOf('MB_BASE') + 400);
  ok(!seedLine.includes('</script>'), 'a label cannot terminate the script element it is embedded in');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
