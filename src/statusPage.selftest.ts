/** Offline test for the status page renderer. pnpm test:statuspage */
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';
import { toPrincipal, type Principal } from '@dszp/netsapiens-lib';
import { buildStatus } from './status.js';
import { resolveMenus, appsHideSources, menuConfigError, MENU_VARS, MENU_NAMES, APP_NAMES } from './menus.js';
import { statusHtml, richPara, plainPara, featureAnchor, CHECKS_INTRO_TEXT } from './statusPage.js';
import { PROBE_CATALOG, probeCatalogFor, settingDocsUrl, groupDocsUrl, type ProbeResult } from './statusModel.js';
import { parseFeatures, KNOWN_SCOPES } from './features.js';
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
    // The readable config, on the Menus tab. It is the thing you check before pasting, so it earns its
    // space by default; it folds because the reader may not want it every time. The schema reference
    // sitting immediately above it is the opposite case and stays shut — reference material announces
    // itself by existing, and the config does not.
    'class="schema" open',
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
  // Feature cards also carry an `id` now (the per-feature jump list points at it), so the class attribute
  // is no longer the end of the tag — match up to the closing quote and let the id follow.
  const featureCards = panel('features', 'integrations').split(/<div class="card(?: card-wide)?" id="/).slice(1);
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

  // The per-feature jump list. The tab is past twenty cards, several of them full-width with paragraphs
  // of prose, so a reader looking for one feature was scrolling the whole list to find where it is.
  {
    const feats = panel('features', 'integrations');
    const missing = doc.features.filter((f) => !feats.includes(`data-target="${featureAnchor(f.key)}"`)).map((f) => f.key);
    ok(missing.length === 0, `every feature has a jump-list entry${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    const noAnchor = doc.features.filter((f) => !feats.includes(`id="${featureAnchor(f.key)}"`)).map((f) => f.key);
    ok(noAnchor.length === 0, `and a card carrying the id that entry points at${noAnchor.length ? ` (missing: ${noAnchor.join(', ')})` : ''}`);
    // EVERY card gets the back-to-top button, not only the wide ones that carry prose. Restricting it to
    // those was a guess about which cards a reader would be deep inside; with a jump list above, a reader
    // arrives at ANY card from anywhere, and the one they land on is the one they need to leave.
    const heads = featureCards.map((c) => c.slice(0, c.indexOf('</div>')));
    ok(heads.every((h) => h.includes('class="totop"')), 'every feature card offers a way back to the top, not just the wide ones');

    // Two features colliding on one anchor would send both jump entries to the same card, silently.
    const anchors = doc.features.map((f) => featureAnchor(f.key));
    ok(new Set(anchors).size === anchors.length, 'and no two features share an anchor id');
    // These buttons contain child elements (the section bar wraps its count in a span), so the shared
    // handler has to resolve the button the click landed INSIDE. Reading classList off the clicked node
    // made every click on a child do nothing at all — silently, since a jump that does not jump looks
    // like a page that has not finished loading.
    ok(/raw\.closest\('\.tocref'\)/.test(html) && /raw\.closest\('\.totop'\)/.test(html),
      'the jump handler resolves the button a click landed inside, so a click on a child is not dead');
  }

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

  // Item 28 — each row links to its own entry in the settings reference. Asserted against the row's OWN
  // name, not against a count: a link on every row that all point at the same anchor would satisfy a count
  // and send every reader to the same wrong place.
  const wrongLink = rows.filter((r) => !r.includes(`href="${settingDocsUrl(idOf(r))}"`)).map(idOf);
  ok(wrongLink.length === 0,
    `each row links to its own entry in the settings reference${wrongLink.length ? ` (wrong or missing: ${wrongLink.join(', ')})` : ''}`);
  const cfgPanel = panel('config', 'checks');
  const groupLinks = [...new Set(doc.settings.map((s) => s.group))]
    .filter((g) => !cfgPanel.includes(`href="${groupDocsUrl(g)}"`));
  ok(groupLinks.length === 0,
    `and each group section links its own${groupLinks.length ? ` (missing: ${groupLinks.join(', ')})` : ''}`);
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
  const expected = [SPK_BRIDGE.tag, SPK_BRIDGE.idKey, SPK_BRIDGE.dataKey, SPK_BRIDGE.errorKey,
    SPK_BRIDGE.pageKey, SPK_BRIDGE.menusKey, SPK_BRIDGE.checkKey, SPK_BRIDGE.resolveKey,
    SPK_BRIDGE.stockKey].sort();
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

// ── item 2: setting prose renders its markup, and only markup that renders ─────────────────────────
// The descriptions were written with backticks around identifiers and pushed through esc(), so the
// punctuation reached the operator as punctuation — and inside a `title` attribute it could not have
// rendered at all. Both are fixed at the renderer, which means the guard belongs there too: prose may
// use exactly what richPara draws, and anything else is caught here rather than on the page.
{
  const doc = DOC();
  const leftovers = doc.settings.flatMap((s) => [['what', s.name, richPara(s.what)], ['whenUnset', s.name, richPara(s.whenUnset)]] as const)
    .filter(([, , html]) => html.includes('`') || html.includes('**') || /\]\(https?:/.test(html));
  ok(leftovers.length === 0,
    `no setting's prose uses markup this renderer does not draw${leftovers.length ? ` (${leftovers.map(([f, n]) => `${n}.${f}`).join(', ')})` : ''}`);

  const withCode = doc.settings.filter((s) => s.what.includes('`'));
  ok(withCode.length > 0 && richPara(withCode[0]!.what).includes('<code>'),
    'and a backticked identifier becomes a code span rather than punctuation');

  // The same string in a `title` attribute has no markup to draw, so it is reduced instead of escaped.
  ok(plainPara('set `NS_SERVER` first') === 'set NS_SERVER first', 'a title strips the markup rather than showing it');
  const html = statusHtml(doc);
  const titled = html.match(/title="[^"]*"/g) ?? [];
  ok(titled.length > 0 && !titled.some((t) => t.includes('`')), 'and no rendered title attribute carries a backtick');
}

// ── the preview pair: a failed preview must never draw as a menu ───────────────────────────────────
// The rule the pair exists for, and the one a future edit is most likely to lose: an empty plan rendered
// as a composed menu says "nothing is hidden and nothing is added for this audience", which is a
// confident wrong answer when the truth is "we could not ask". Same failure the Checks panel's errorKey
// prevents, in a different panel — so the same shape, asserted the same way.
{
  const html = statusHtml(DOC());
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  const bundle = buildSpkBundle(['kit.status'], { PORTAL_HANDOFF_URL: '' } as any);

  ok(script.includes(SPK_BRIDGE.resolveRequest) && bundle.includes(SPK_BRIDGE.resolveRequest),
    '[preview] both sides speak the resolve message');
  ok(/\/kit\/menus\/resolve\?/.test(bundle),
    '[preview] and the PARENT does the fetching — the sandboxed frame has no origin to fetch from');

  // THREE replies, three states, never collapsed: a plan, a config that will not resolve (normal while
  // typing one), and could-not-ask. The third is the dangerous one.
  const fn = script.slice(script.indexOf('function mbPreviewNotice'), script.indexOf('if (mbHost && HOSTED)'));
  ok(/unavailable/.test(fn) && /invalid/.test(fn),
    '[preview] the page tells could-not-ask apart from will-not-resolve');
  ok(/Nothing below is a statement about your config/.test(fn),
    '[preview] and an unavailable preview says so rather than implying an answer');

  // The parent bounds the candidate BEFORE building the URL, same 8000 as the check pair — a config that
  // previews but will not validate (or the reverse) is worse than either refusing.
  const parentResolve = bundle.slice(bundle.indexOf(SPK_BRIDGE.resolveRequest));
  // \b, because /8000/ is a substring match: widening the guard to >80000 kept it green. And the claim
  // was "the same size as the check pair", which nothing compared — so assert the two bounds against
  // each other, and against the server's cap, since a config that previews but will not validate (or
  // the reverse) is worse than either refusing.
  const bounds = [...bundle.matchAll(/length>(\d+)/g)].map((m) => Number(m[1]));
  ok(bounds.length === 2 && bounds[0] === bounds[1],
    `[preview] the check and resolve pairs bound the candidate at the SAME size (${bounds.join(' vs ')})`);
  ok(bounds[0] === 8000, `[preview] at 8000 (got ${bounds[0]})`);
  ok(/if \(candidate\.length > 8192\)/.test(readFileSync(new URL('./worker.ts', import.meta.url), 'utf8')),
    '[preview] under the server cap of 8192, so the client refuses first and says why');
  ok(/unavailable:/.test(parentResolve.slice(0, 1400)),
    '[preview] and a Worker it cannot reach reports unavailable, never an empty plan');

  // ── the check reply carries THREE facts, and the bridge dropped one ────────────────────────────────
  // ACCEPTED AND STILL WRONG is a real verdict: this deployment takes the config and some of it reaches
  // nobody. The route computed the warnings and the page had the wording for them — and the parent's
  // reply forwarded ok and error only, so that whole branch was dead code with nothing failing anywhere.
  // The field-agreement test above could not see it: `warnings` rides INSIDE the check payload, not as a
  // top-level message field, so this is asserted at the payload level or not at all.
  const parentCheck = bundle.slice(bundle.indexOf(SPK_BRIDGE.checkRequest));
  const replyAt = parentCheck.indexOf('/kit/menus/check');
  ok(/warnings:/.test(parentCheck.slice(replyAt, replyAt + 400)),
    '[preview] the parent forwards the validator\'s warnings, not only its verdict');
  ok(/v\.warnings/.test(script) && /reaches nobody/.test(script),
    '[preview] and the page renders accepted-with-warnings as neither valid nor rejected');
}

// ── the persona bar and the composed menu ──────────────────────────────────────────────────────────
{
  const html = statusHtml(DOC());
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));

  ok(html.includes('id="spkmb-persona"') && html.includes('id="spkmb-apps"'),
    '[persona] the bar exists, above everything it governs');
  // TOGGLES, not tabs or a radio: two apps can be active at once, so a control that shows one and hides
  // the other would hide a rule that is live. This is the whole reason the layout is shaped this way.
  ok(/aria-pressed/.test(script) && /mbPersona\.apps\.splice/.test(script),
    '[persona] apps are independently toggleable, because two can apply at once');
  ok(/all off = a domain running none of them/.test(script),
    '[persona] and all-off is named as the audience it is, not left reading as an empty selection');
  // Availability, not usage — an app that can never be active here has no toggle, because "what would
  // this persona see with it active" has no referent.
  ok(/MB_AVAIL = /.test(script) && /if \(!MB_AVAIL\.length\)/.test(script),
    '[persona] the toggles come from what this deployment could run, and vanish when it could run none');

  // The composed menu is drawn from the SERVER's plan, never from a client-side resolution.
  ok(/function mbComposed/.test(script) && /v\.plan\[mn\.name\]/.test(script),
    '[composed] the picture is drawn from the resolved plan the Worker returned');
  // ⚠️ THIS USED TO BE A GREP FOR /return;/ IN THE REST OF THE FILE, which every later function
  // satisfies — deleting mbComposed's early return left it green while a failed preview drew a
  // confident empty menu, the exact lie the pair exists to prevent. It is behavioural now, in the DOM
  // harness below, where the failure branch is actually executed. Only the wiring stays a grep.
  ok(/mbPreviewNotice\(v\)/.test(script), '[composed] the notice is consulted at all');
  // Provenance colour carries exactly one warning, so it must not leak.
  const chipAt = script.indexOf('function mbChip(list, what)');
  const chip = script.slice(chipAt, chipAt + 900);
  ok(/axis === 'scopes'/.test(chip) && /mbPersona\.scope/.test(chip),
    '[composed] green means the rule names THIS persona — an app rung is shared, and stays amber');
  // Two empties, two sentences.
  ok(/an exemption, written as an empty rule/.test(script) && /the default is empty/.test(script),
    '[composed] an exemption and an empty default are told apart, because the fixes differ');
  // Nothing should ever render as "all → *": two of the five axis values mean "everyone" differently, and
  // the chip maps them to words rather than printing the pair it was handed.
  ok(/function mbSrcName/.test(script) && /'everyone else'/.test(script) && /'everyone'/.test(script),
    '[composed] provenance is mapped to the operator\'s words, never printed as axis → key');

  // ⚠️ THE TWO BUGS THAT SHIPPED TO DEV are no longer asserted by grep. Both were behavioural, both
  // passed every grep in this file, and both are now covered by the DOM harness further down, which runs
  // the real emitted builder against a stub DOM. A grep pins the one line that was wrong; the harness
  // pins the property. What stays here is the structural half of the loop fix, because the guard's shape
  // is the thing a tidy-up would remove:
  ok(/mbLastAsk/.test(script) && /if \(!force && key === mbLastAsk\) return;/.test(script),
    '[regress] the preview refuses to re-ask a question already answered, which is what breaks the loop');

  // Config that names a label this page does not have is still real config.
  ok(/Also hidden by your config, not on this page/.test(script),
    '[composed] and a hide naming an absent label stays visible rather than silently vanishing');
}

// ── item 35/53: a probe's table renders, collapsed, on BOTH paths ───────────────────────────────────
// Two renderers exist for one shape — the server's, and the client's, which is the one a real run
// actually uses (results arrive over the bridge and are injected into the DOM). A test that only checked
// the server render would pass with the client half deleted, which is the exact way the stale-intro bug
// above went unnoticed.
{
  const withTable: ProbeResult[] = [{
    id: PROBE_CATALOG[0]!.id, name: PROBE_CATALOG[0]!.name, cost: PROBE_CATALOG[0]!.cost,
    state: 'pass', detail: 'ok',
    table: {
      caption: 'Event subscriptions this deployment owns (1)',
      columns: ['Domain', 'Events', 'Expires', 'In NS_EVENTS_DOMAINS'],
      rows: [['acme<script>.example', 'subscriber', '2027-01-01 00:00:00', 'yes']],
      note: '3 subscription(s) belong to another integration.',
    },
  }];
  const doc = buildStatus(
    { NS_SERVER: 'api.example.com', NS_PORTAL_ISS: 'manage.example.com', PORTAL_MODE: '1',
      PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'dev' },
    { principal: P('Super User'), hostname: 'svc-dev.example.com', probes: withTable });
  const html = statusHtml(doc);
  const at = html.indexOf('id="spkpanel-checks"');
  const panel = html.slice(at, html.indexOf('</main>', at));

  ok(panel.includes('<details class="probetable"><summary>Event subscriptions this deployment owns (1)'),
    '[item35] the table renders under its check row, collapsed');
  ok(panel.includes('<td>2027-01-01 00:00:00</td>') && panel.includes('<th scope="col">Domain</th>'),
    '[item35] with its columns and its cells');
  ok(panel.includes('another integration'), '[item35] and the note saying what it is NOT showing');
  // Every cell is upstream data. NetSapiens supplies these domain names, so a cell reaching innerHTML
  // unescaped would be an injection this console handed itself.
  ok(!panel.includes('acme<script>') && panel.includes('acme&lt;script&gt;.example'),
    '[item35] cells are escaped — they are upstream strings, not ours');

  // The client half: a run injects results, so the table has to be built there too, and by DOM node
  // rather than markup for the same reason.
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  ok(/function checkTable\(/.test(script), '[item35] the client script builds the table for an injected result');
  ok(/checkTable\(r\.table\)/.test(script), '[item35] reading it off the result the bridge delivered');
  const fn = script.slice(script.indexOf('function checkTable('), script.indexOf('// One code path for both triggers'));
  ok(fn.length > 0 && !/innerHTML/.test(fn), '[item35] and never touches innerHTML with an upstream cell');
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

  /**
   * ONE CARD'S OWN HTML, bounded by the next card.
   *
   * ⚠️ A FIXED-LENGTH WINDOW READS ITS NEIGHBOUR. `slice(at, at + 4000)` ran past the end of the card and
   * into the ones after it, so "this INERT card shows what is missing" was satisfied by ANY later card
   * having a Missing block — a one-card regression was invisible, and with several inert cards in the
   * fixture the assertion could not fail at all. Bounded here, and the boundary is itself asserted below.
   */
  // Two spellings of one pattern on purpose: matchAll needs the /g, and .test() on a /g regex advances
  // lastIndex, so reusing it for the boundary check would make the assertion depend on call order.
  const CARD_AT = /class="card(?: card-child)?"/g;
  const CARD_ONE = /class="card(?: card-child)?"/;
  const cardFor = (panelHtml: string, id: string): string => {
    const at = panelHtml.indexOf(`>${id}<`);
    if (at < 0) return '';
    // ⚠️ NOT indexOf('class="card') — that is a prefix of `class="card-key"`, the element the id itself
    // sits in, so the window closed on the heading and every card looked empty.
    const bounds = [...panelHtml.matchAll(CARD_AT)].map((m) => m.index);
    const start = bounds.filter((i) => i <= at).pop();
    const next = bounds.find((i) => i > at);
    return panelHtml.slice(start ?? at, next ?? panelHtml.length);
  };

  // An INERT card is the case this exists for: its missing list must be on screen, not behind a control.
  const inert = doc.subsystems.filter((x) => x.tab === 'integration' && x.state === 'inert' && x.missing.length > 0);
  ok(inert.length > 0, '[reqs] the fixture has an INERT card to assert about');
  for (const c of inert) {
    const card = cardFor(intPanel, c.id);
    ok(card.length > 0 && !CARD_ONE.test(card.slice(1)),
      `[reqs] ${c.id}'s window is that card and nothing after it`);
    ok(/<dt>Missing<\/dt>/.test(card), `[reqs] ${c.id} is INERT and shows what is missing inline`);
  }
  // A card with nothing to say still gets neither — an empty block is as bad as an empty disclosure.
  const bare = doc.subsystems.filter((x) => x.tab === 'integration' && x.settings.length === 0 && x.missing.length === 0 && x.notes.length === 0);
  ok(bare.length > 0, '[reqs] there is at least one card with nothing to show (the unwired integrations)');
  for (const c of bare) {
    const card = cardFor(intPanel, c.id);
    ok(card.length > 0 && !CARD_ONE.test(card.slice(1)),
      `[reqs] ${c.id}'s window is that card and nothing after it`);
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

  // ── THE SCHEMA REFERENCE ──────────────────────────────────────────────────────────────────────────
  // A config is a text file someone edits by hand when the console is not the fastest route, and nothing
  // anywhere said what the whole vocabulary IS. Generated from the modules that VALIDATE, so it cannot
  // describe a config this deployment would refuse at boot — a hand-written reference disagrees with the
  // parser eventually, and the disagreement is invisible until someone writes what it describes.
  ok(/Every key and legal value/.test(html), '[schema] the reference is on the page');
  {
    const at = html.indexOf('Every key and legal value');
    const block = html.slice(at, html.indexOf('</details>', at));
    for (const scope of KNOWN_SCOPES) {
      ok(block.includes(`&quot;${scope}&quot;`), `[schema] naming the scope ${scope}, from the list the runtime checks`);
    }
    for (const app of [...APP_NAMES, 'none']) {
      ok(block.includes(`&quot;${app}&quot;`), `[schema] and the app key ${app}`);
    }
    for (const v of MENU_VARS) ok(block.includes(`{${v}}`), `[schema] and the variable {${v}}`);
    ok(MENU_NAMES.every((m) => block.includes(`&quot;${m}&quot;`)), '[schema] and every menu name');
    ok(/users/.test(block) && /domains/.test(block) && /scopes/.test(block) && /app/.test(block)
      && /users → domains → scopes → app/.test(block),
      '[schema] with the axes and the precedence order they resolve in');
    // It carries comments, so it is NOT valid JSON — a block that looks pasteable and is not is worse
    // than one that obviously is not.
    ok(/not\s*\n?\s*<strong>valid JSON as written|not valid JSON as written/.test(block.replace(/\s+/g, ' ')),
      '[schema] and says it is annotated rather than pasteable');

    // ⚠️ THE ASSERTIONS ABOVE ARE CIRCULAR ON THEIR OWN, and I only noticed by trying the wrong mutation:
    // adding a scope to KNOWN_SCOPES fed BOTH the reference and the expectation, so it stayed green. They
    // catch the reference dropping the list; they cannot catch it carrying a hardcoded copy that is right
    // today. That is the failure that matters — a reference which disagrees with the parser is invisible
    // until someone writes the config it describes and the deployment refuses it at boot. So assert the
    // DERIVATION, in source: the vocabularies come from the modules that validate them, and no scope or
    // app name is typed into this function.
    const src = readFileSync(new URL('./statusPage.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('function menuSchema()'), src.indexOf('function renderConfig('));
    ok(fn.length > 400 && fn.length < 6000, '[schema] (sliced the right function)');
    for (const ref of ['KNOWN_SCOPES', 'APP_NAMES', 'APP_RESERVED', 'MENU_NAMES', 'MENU_VARS', 'MENU_VAR_HELP']) {
      ok(fn.includes(ref), `[schema] built from ${ref}, not from a copy of it`);
    }
    const typedOut = [...KNOWN_SCOPES, ...APP_NAMES].filter((v) => fn.includes(`'${v}'`) || fn.includes(`"${v}"`));
    ok(typedOut.length === 0,
      `[schema] and no scope or app name is written into it by hand${typedOut.length ? ` (found: ${typedOut.join(', ')})` : ''}`);
  }

  // ⚠️ "What your config does now" was REMOVED (David, 2026-08-10). It rendered a card per menu resolved
  // at ONE fictional rung, which is why every targeted card carried a paragraph apologising that what it
  // showed was not the config. The builder answers the same question at a rung the reader chooses, so the
  // section was a screenful of a weaker answer standing in front of the better one.
  ok(!/What your config does now/.test(html), '[menus] the fictional-rung summary is gone, not merely demoted');
  // What must NOT go with it: the two verdicts on the LIVE config. They are rung-independent, and the
  // second is the state an operator cannot discover any other way.
  ok(/is not valid, so none of it is being applied/.test(statusHtml({ ...doc, menus: { ...doc.menus, error: 'boom' } } as never)),
    '[menus] an invalid live config still leads the tab');
  ok(/Some of this config reaches nobody/.test(statusHtml({ ...doc, menus: { ...doc.menus, unreachable: ['apps.add'] } } as never)),
    '[menus] and so does valid-but-reaches-nobody');

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
  // A targeted menu is edited RUNG BY RUNG since item 47 — never flattened, which would narrow the rule
  // to a single audience. What stays locked is a shape this cannot round-trip, and it is still SHOWN.
  ok(/hideLocked: mbIsTargeted\(base\.hide\) && !hideRungs/.test(script)
    && /addLocked: mbIsTargeted\(base\.add\) && !addRungs/.test(script),
    '[full] a targeted menu is locked only where it cannot be round-tripped');
  ok(/cannot round-trip, so it is not editable here/.test(script),
    '[full] and says so where the operator is looking');
  ok(/mbShowRungs\(base\.hide, card/.test(script) && /mbShowRungs\(base\.add, card/.test(script),
    '[full] and shows it anyway — not editable must never mean not readable');
  // Not editable is only half an answer. Saying a rule exists while hiding what it says is the worst of
  // both — you can neither change it nor read it without leaving the tab. Whatever the builder cannot edit,
  // it still shows.
  ok(/function mbShowRungs/.test(script), '[full] and shows the targeted rungs read-only rather than only naming them');
  ok(/nothing — an exemption/.test(script),
    '[full] naming an empty rung, since an empty list is the "everyone except these" idiom and not a blank');

  // Reset returns to the RUNNING config, not to empty. Empty is a config too, and a destructive one — and
  // it takes the rail's change log and every fork answer with it, because a log of edits that are no
  // longer in the config is a log that lies.
  ok(/spkmb-reset/.test(html) && /mbSeed\(\); mbResetForks\(\); mbChanges\.length = 0; mbRebuild\(\);/.test(script),
    '[full] Reset restores the running config, and clears what described the edits it just discarded');

  // Hide-by-name exists: the menu relabels itself by context, and other injections add entries this page
  // load never showed, so ticking what is visible cannot be the only way in.
  ok(/Hide an entry by name/.test(script), '[full] an entry can be hidden by name');
  ok(/Also hidden by your config, not on this page/.test(script),
    '[full] and hides for labels not on this page stay visible instead of vanishing');

  // ── the old rung editor is GONE, and that is the point of the rebuild ─────────────────────────────
  // It was never meant to survive beside the picture: two editors for one config is how "a ton of
  // scrolling and a lot more confusing" happened. Editing moved INTO the composed menu, so the widgets
  // that made a second copy of it must not still be here, waiting to be re-attached by a later change.
  for (const gone of ['mbRungs', 'mbHideList', 'mbAddList', 'mbAddRow', 'mbNewRung', 'mbTargetControl', 'mbDefaultList']) {
    ok(!script.includes(gone), `[rebuild] the old rung editor's ${gone} is deleted, not hidden behind a disclosure`);
  }
  ok(!/Hidden entries/.test(script) && !/Added entries/.test(script),
    '[rebuild] and hides and adds are one picture — those two headings do not exist to compete');
  // What must SURVIVE the deletion: the seeding rule and the emit layer hold the round-trip and the
  // no-op-on-the-resolved-plan invariants, and both were expensive to get right.
  ok(/function mbMakeTargeted/.test(script) && /function mbConfig/.test(script),
    '[rebuild] the seeding rule and the emit layer survive it, because the invariants live in them');

  // ── item 47: the scopes axis is editable rung by rung ────────────────────────────────────────────
  // The builder's promise is that it emits the COMPLETE config, so the thing that must be proven is not
  // that a rung can be edited — it is that editing one leaves everything it did not touch identical.
  // That is a property of the state→JSON path, which needs no DOM, so the real emitted functions are run
  // here rather than grepped. A grep would have passed on a builder that dropped the sibling axis.
  {
    const slice = (from: string, to: string): string => {
      const a = script.indexOf(from);
      const b = script.indexOf(to, a);
      if (a < 0 || b < 0) throw new Error(`could not slice ${from} → ${to} out of the builder`);
      return script.slice(a, b);
    };
    const src = [
      slice('function mbIsTargeted', 'function mbRender'),
      slice('function mbSeed', 'function mbStart'),
      'MB_MENUS=M;MB_BASE=B;MB_SCOPES=S;MB_APPS=A;mbState=ST;mbLive=null;'
        + '({ mbConfig: mbConfig, mbSeed: mbSeed, mbAxisOf: mbAxisOf })',
    ].join('\n');
    const build = (base: unknown) => {
      const ctx: Record<string, unknown> = {
        M: [{ name: 'apps' }, { name: 'account' }, { name: 'management' }],
        B: base, S: ['Super User', 'Reseller', 'Office Manager'], A: ['ringotel', 'none'], ST: {},
        MB_MENUS: null, MB_BASE: null, MB_SCOPES: null, MB_APPS: null, mbState: null, mbLive: null,
      };
      const api = runInNewContext(src, ctx) as {
        mbConfig: () => unknown; mbSeed: () => void;
        mbAxisOf: (raw: unknown, name: string) => unknown;
      };
      api.mbSeed();
      return { api, state: ctx.ST as Record<string, any> };
    };

    // A scopes-targeted hide, sitting beside a domains axis and a whole-object default — the shape where
    // "carry the rest through" is a claim that can actually be wrong.
    const BASE = {
      apps: {
        hide: {
          scopes: { Reseller: ['Voicemail'], 'Office Manager': [] },
          domains: { 'acme.example': ['Meeting'] },
          '*': ['Fax'],
        },
        add: { scopes: { 'Office Manager': [{ label: 'Support', url: 'https://support.example.com' }] } },
      },
      account: { hide: ['Messages'] },
      management: { hide: { users: { 'boss@acme.example': ['Billing'] } } },
    };

    const { api, state } = build(BASE);
    const axisOf = (r: any, name: string) => r.axes.find((a: any) => a.name === name);
    ok(!!state.apps.hideRungs && state.apps.hideLocked === false,
      '[item47] a targeted hide is editable rather than locked');
    ok(!!state.apps.addRungs && state.apps.addLocked === false, '[item47] and so is a targeted add');
    ok(!!state.management.hideRungs && state.management.hideLocked === false,
      '[item47] every axis is editable, accounts included — targeting is the feature, not an edge of it');
    ok(axisOf(state.apps.hideRungs, 'scopes').order.join(',') === 'Reseller,Office Manager',
      '[item47] every rung is carried, in the order it was written');
    ok(!!axisOf(state.apps.hideRungs, 'domains'),
      '[item47] and a second axis on the same half is its own editable block, not a carried-through blob');
    ok(axisOf(state.apps.hideRungs, 'scopes').map['Office Manager'].length === 0,
      '[item47] including an empty rung — that is the "everyone except these" idiom, not an absent rule');
    ok(!!state.apps.hideRungs.top && state.apps.hideRungs.top.list.join(',') === 'Fax',
      '[item47] the whole-menu default is a rung too — usually the one holding what everyone gets');

    // Untouched ⇒ byte-for-byte. The builder emits the whole config on every render, so a round-trip that
    // is merely equivalent is not good enough: an operator diffs this against what they are running.
    ok(JSON.stringify(api.mbConfig()) === JSON.stringify(BASE),
      `[item47] an untouched config round-trips identically (got ${JSON.stringify(api.mbConfig())})`);

    // Edit ONE rung. Everything else — the sibling axis, the whole-object default, the other menus — must
    // come back unchanged. This is the assertion that would catch a builder that flattened.
    axisOf(state.apps.hideRungs, 'scopes').map['Office Manager'].push('Meeting');
    const after = api.mbConfig() as typeof BASE;
    ok(JSON.stringify(after.apps.hide.scopes) === JSON.stringify({ Reseller: ['Voicemail'], 'Office Manager': ['Meeting'] }),
      '[item47] editing a rung changes that rung');
    ok(JSON.stringify(after.apps.hide.domains) === JSON.stringify(BASE.apps.hide.domains)
      && JSON.stringify(after.apps.hide['*']) === JSON.stringify(BASE.apps.hide['*']),
      '[item47] and leaves the other axis and the default on that menu exactly as configured');
    ok(JSON.stringify(after.account) === JSON.stringify(BASE.account)
      && JSON.stringify(after.management) === JSON.stringify(BASE.management),
      '[item47] and leaves every other menu alone, editable or not');

    // The rung PICKER is gone with the old editor: a new rule is no longer chosen from a vocabulary of
    // keys, it is carved from the persona on screen (see the fork prompt in the DOM harness below). That
    // is the same capability arriving in the operator's terms instead of the format's, and it is why
    // mbFreeKeys and its three assertions were deleted rather than ported.

    // MAKING A FLAT HALF TARGETED — the leap that was missing. David, live on dev: "I can't tell if I can
    // add a menu item to Apps ONLY if ringotel is true. I see I can hide an option based on these; the add
    // form doesn't seem to let me select an app state." His apps.add is a plain list, so it had no groups
    // and no axis control, and there was no route from there to a targeted rule without editing JSON.
    // The property that matters is that converting LOSES NOTHING: whatever applied to everyone still does.
    {
      const flat = build({ apps: { add: [{ label: 'Support', url: 'https://s.example' }] } });
      const st = flat.state.apps;
      ok(!st.addRungs && !st.addLocked, '[targetable] a plain list starts untargeted, as it should');
      const mk = runInNewContext(`${slice('function mbMakeTargeted', '// \u2500\u2500 WHERE AN EDIT LANDS')}; mbMakeTargeted`, {}) as
        (existing: unknown[], axis: string, key: string) => any;
      st.addRungs = mk(st.add, 'app', 'ringotel');
      const after = flat.api.mbConfig() as any;
      ok(JSON.stringify(after.apps.add['*']) === JSON.stringify([{ label: 'Support', url: 'https://s.example' }]),
        '[targetable] what applied to everyone still does — it becomes the default, never dropped');
      ok(JSON.stringify(after.apps.add.app) === JSON.stringify({ ringotel: [{ label: 'Support', url: 'https://s.example' }] }),
        '[targetable] and the NEW group is seeded with the same entries, which is the correctness of it');

      // THE INVARIANT, checked against the real resolver rather than asserted in prose. A default is
      // SUPPRESSED for anyone a rule names, so seeding only the default is safe until the first edit and
      // silently wrong after it — the audience being added to loses every shared entry. David built
      // exactly that config on dev before this was fixed, and it dropped two entries for everyone.
      {
        const before = { apps: { add: [{ label: 'Support', url: 'https://s.example' }] } };
        const afterCfg = flat.api.mbConfig();
        const personas = [
          { domain: 'acme.example', app: [] as string[] },
          { domain: 'acme.example', app: ['ringotel'] },
          { domain: 'acme.example', app: ['documo'] },
          { domain: 'acme.example', app: ['ringotel', 'documo'] },
          { domain: 'other.example', app: ['ringotel'], scope: 'Reseller' },
          { domain: 'other.example', app: [], scope: 'Office Manager' },
        ];
        const differ = personas.filter((p) => {
          const a1 = resolveMenus({ PORTAL_MENUS: JSON.stringify(before) }, p as never).apps;
          const a2 = resolveMenus({ PORTAL_MENUS: JSON.stringify(afterCfg) }, p as never).apps;
          return JSON.stringify(a1) !== JSON.stringify(a2);
        });
        ok(differ.length === 0,
          `[targetable] converting is a no-op on the RESOLVED PLAN for every persona${differ.length ? ` (differs for: ${differ.map((p) => `${p.scope ?? 'any'}/${p.app.join('+') || 'none'}`).join(', ')})` : ''}`);
      }
    }

    // A rung that is not a flat list is not something this can round-trip, so its axis stays out of the
    // editable set rather than being half-understood.
    const weird = build({ apps: { hide: { scopes: { Reseller: { nested: true } } } } });
    ok(weird.state.apps.hideLocked === true, '[item47] a rung that is not a flat list stays locked');
    // ...but a menu where ONE axis is unreadable and another is fine keeps the good one editable, and
    // carries the other through untouched.
    const mixed = build({ apps: { hide: { scopes: { Reseller: { nested: true } }, domains: { 'acme.example': ['Meeting'] } } } });
    ok(!!mixed.state.apps.hideRungs && !mixed.state.apps.hideLocked,
      '[item47] one unreadable axis does not lock a half whose other axis is fine');
    ok(JSON.stringify(mixed.api.mbConfig()) === JSON.stringify({ apps: { hide: { scopes: { Reseller: { nested: true } }, domains: { 'acme.example': ['Meeting'] } } } }),
      '[item47] and the unreadable one round-trips byte for byte beside it');
  }

  // A malformed running config must not break the page — the console is where you go to fix it.
  const bad = { ...DOC(), menus: { ...DOC().menus, raw: '{ not json' } };
  let threw = false;
  try { statusHtml(bad as never); } catch { threw = true; }
  ok(!threw, '[full] a malformed running config still renders the tab');
}

// ── THE DOM HARNESS: run the real emitted builder against a stub DOM ─────────────────────────────────
//
// Why this exists, in one sentence: two bugs reached dev inside one hour and NOT ONE test in this file
// could see either, because the client half of the console is JavaScript emitted as a string and every
// assertion above verifies it by READING it. A grep catches the regression it was written for and nothing
// else; the shape that catches a class of bug is the one `kit.selftest.ts` already uses for `menuHide` —
// slice the real emitted source out of the page, run it in a `vm` against a stub small enough to be
// obviously honest, and assert BEHAVIOUR.
//
// The stub is deliberately tiny: create/append/remove, class and text, a three-form selector matcher, and
// timers you have to flush by hand. Anything the builder needs that is not here shows up as a throw, which
// is the right failure — a silent stub that answers every call is a harness that always passes.

interface StubEl {
  tagName: string; className: string; id: string; type: string; value: string; checked: boolean;
  disabled: boolean; hidden: boolean; open: boolean; title: string; placeholder: string; size: number;
  textContent: string; style: Record<string, string>; children: StubEl[]; parentNode: StubEl | null;
  appendChild(c: StubEl): StubEl; removeChild(c: StubEl): StubEl; remove(): void;
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | null;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  fire(t: string, ev?: unknown): void; focus(): void;
  querySelector(sel: string): StubEl | null; querySelectorAll(sel: string): StubEl[];
  closest(sel: string): StubEl | null;
  /** Every descendant's text, flattened — the cheap way to ask "is this label anywhere in here?". */
  all(sel: string): StubEl[];
}

function makeDom(ids: string[]) {
  // Three selector forms and no more: a tag, a `.class` (optionally `tag.class`), and `details[id]`.
  // Anything else throws rather than quietly matching nothing — a selector the stub does not understand
  // must fail the test that used it, not weaken it.
  const matches = (n: StubEl, sel: string): boolean => {
    const s = sel.trim();
    if (s === 'details[id]') return n.tagName === 'DETAILS' && !!n.id;
    const dot = s.indexOf('.');
    if (dot === 0) return ` ${n.className} `.includes(` ${s.slice(1)} `);
    if (dot > 0) {
      return n.tagName === s.slice(0, dot).toUpperCase() && ` ${n.className} `.includes(` ${s.slice(dot + 1)} `);
    }
    if (/^[a-z]+$/i.test(s)) return n.tagName === s.toUpperCase();
    throw new Error(`the DOM stub does not understand the selector "${sel}" — teach it, do not widen it`);
  };
  const walk = (n: StubEl, fn: (x: StubEl) => void): void => { for (const c of n.children) { fn(c); walk(c, fn); } };
  const mk = (tag: string): StubEl => {
    let text = '';
    const attrs: Record<string, string> = {};
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const el = {
      tagName: tag.toUpperCase(), className: '', id: '', type: '', value: '', checked: false,
      disabled: false, hidden: false, open: false, title: '', placeholder: '', size: 0,
      style: {} as Record<string, string>, children: [] as StubEl[], parentNode: null as StubEl | null,
      appendChild(c: StubEl) { c.parentNode = el as StubEl; el.children.push(c); return c; },
      removeChild(c: StubEl) {
        const i = el.children.indexOf(c);
        if (i >= 0) el.children.splice(i, 1);
        c.parentNode = null;
        return c;
      },
      remove() { if (el.parentNode) el.parentNode.removeChild(el as StubEl); },
      setAttribute(k: string, v: string) { attrs[k] = String(v); },
      getAttribute(k: string) { return k in attrs ? attrs[k]! : null; },
      addEventListener(t: string, fn: (e: unknown) => void) { (listeners[t] = listeners[t] || []).push(fn); },
      fire(t: string, ev?: unknown) { for (const f of listeners[t] || []) f.call(el, ev ?? {}); },
      focus() { doc.activeElement = el as StubEl; },
      all(sel: string) { const out: StubEl[] = []; walk(el as StubEl, (n) => { if (matches(n, sel)) out.push(n); }); return out; },
      querySelectorAll(sel: string) { return (el as StubEl).all(sel); },
      querySelector(sel: string) { return (el as StubEl).all(sel)[0] ?? null; },
      closest(sel: string) {
        let n: StubEl | null = el as StubEl;
        while (n) { if (matches(n, sel)) return n; n = n.parentNode; }
        return null;
      },
      // A <select>'s options track its children in a real DOM, and the persona bar's "already built?"
      // guard reads exactly that. A stub that returned a fixed empty array would rebuild the bar forever.
      get options() { return el.children; },
    } as unknown as StubEl;
    Object.defineProperty(el, 'textContent', {
      get() { return text + el.children.map((c) => c.textContent).join(''); },
      set(v: string) { el.children.length = 0; text = v === null || v === undefined ? '' : String(v); },
    });
    return el as StubEl;
  };
  const byId: Record<string, StubEl> = {};
  for (const id of ids) { byId[id] = mk('div'); byId[id]!.id = id; }
  const doc = {
    activeElement: null as StubEl | null,
    body: mk('body'),
    createElement: (t: string) => mk(t),
    // A text node is an element with no tag as far as this stub is concerned — enough for textContent to
    // aggregate correctly, which is all any assertion here reads.
    createTextNode: (t: string) => { const n = mk('#text'); n.textContent = t; return n; },
    getElementById: (id: string) => byId[id] ?? null,
  };
  // Timers you flush by hand. The builder debounces both the validator and the preview, so a real timer
  // would make the harness a race and an immediate one would recurse.
  let seq = 0;
  const timers = new Map<number, () => void>();
  const posts: Record<string, unknown>[] = [];
  const win = {
    scrollY: 0,
    scrollTo: () => {},
    parent: { postMessage: (m: Record<string, unknown>) => { posts.push(m); } },
  };
  (win as { parent: unknown }).parent = win.parent;
  return {
    byId, doc, posts,
    ctx: {
      document: doc, window: win, HOSTED: true, console,
      setTimeout: (fn: () => void) => { timers.set(++seq, fn); return seq; },
      clearTimeout: (id: number) => { timers.delete(id); },
    } as Record<string, unknown>,
    flush() {
      // One generation at a time: a callback that schedules another must not spin this loop forever, and
      // "did that edit schedule a second round?" is exactly what the loop regression is about.
      const now = [...timers.entries()];
      timers.clear();
      for (const [, fn] of now) fn();
      return now.length;
    },
    pending: () => timers.size,
  };
}

/** Slice the whole builder — declarations included, so the harness runs the values the page really ships. */
function builderSource(script: string, exports: string): string {
  const a = script.indexOf('  var MB_MENUS = [');
  const b = script.indexOf('if (mbHost && HOSTED)', a);
  if (a < 0 || b < 0) throw new Error('could not slice the menu builder out of the page');
  return `${script.slice(a, b)}\n;(${exports})`;
}

{
  const d = buildStatus(
    { NS_SERVER: 'api.example.com', NS_PORTAL_ISS: 'manage.example.com', PORTAL_MODE: '1',
      PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'dev',
      RINGOTEL_API_KEY: 'k', DOCUMO_DOMAINS: 'acme.example',
      PORTAL_MENUS: JSON.stringify({
        apps: {
          hide: { app: { ringotel: ['SNAPmobile Web'] }, '*': [] },
          // ⚠️ A {variable} on purpose. menuItemAt interpolates it and the preview resolves with no user
          // facts, so the plan's url is NOT this url — which is what made every entry using the feature
          // report itself as "not editable here".
          add: { app: { ringotel: [{ label: 'App Admin', url: 'https://admin.example/?ext={ext}' }] }, '*': [] },
        },
        account: { hide: { scopes: { Reseller: [] }, '*': ['My Account'] } },
      }) },
    { principal: P('Super User'), hostname: 'svc-dev.example.com' });
  const html = statusHtml(d);
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));

  const dom = makeDom(['spkmb-status', 'spkmb-menus', 'spkmb-out', 'spkmb-json', 'spkmb-wr', 'spkmb-verdict',
    'spkmb-reset', 'spkmb-scope', 'spkmb-apps', 'spkmb-domain', 'spkmb-appswrap', 'spkmb-changed', 'spkmb-caveat', 'spkmb-capture', 'spkmb-domclear', 'spkmb-domnote',
    'spkmb-rules']);
  const api = runInNewContext(
    builderSource(script, '{ mbStart: mbStart, mbRebuild: mbRebuild, mbOnResolve: mbOnResolve, mbOnStock: mbOnStock, mbPersona: mbPersona, mbStockRaw: function(){ return mbStock }, mbMarkScopes: mbMarkScopes }'),
    dom.ctx,
  ) as {
    mbStart: (live: unknown) => void;
    mbRebuild: () => void;
    mbOnResolve: (rv: unknown, rid?: unknown) => void;
    mbOnStock: (st: unknown) => void;
    mbStockRaw: () => unknown;
    mbMarkScopes: () => void;
    mbPersona: { scope: string; apps: string[]; domain: string };
  };

  const LIVE = {
    apps: { present: true, entries: ['User Portal', 'SNAPmobile Web', 'Attendant Console'] },
    account: { present: true, entries: ['My Account', 'Log Out'] },
    management: { present: false, entries: [] },
  };
  api.mbPersona.scope = 'Office Manager';
  api.mbPersona.apps = ['ringotel'];
  api.mbPersona.domain = 'acme.example';
  api.mbStart(LIVE);

  const host = dom.byId['spkmb-menus']!;

  // ── REGRESSION 1: mbCard returned the disclosure it had rebound `card` to, so the real card was built,
  // never attached, and the tab rendered as three bare summaries. A grep can only pin the one line that
  // was wrong; this pins the property — every menu's own name is on the page.
  ok(host.children.length === 3, `[dom] one panel per menu (got ${host.children.length})`);
  for (const label of ['Apps', 'Account', 'Management']) {
    ok(host.children.some((c) => c.textContent.includes(label)),
      `[dom] and the ${label} panel carries its own name — mbCard returns the card, not something inside it`);
  }

  // ── REGRESSION 2: reply → rebuild → render → ask → reply, every 250ms, wiping the DOM under the reader.
  //
  // ⚠️ THE HARNESS HAS TO CLOSE THE CIRCUIT. A first cut delivered ONE reply and then flushed timers, and
  // it passed with the loop guard deleted — because nothing answered the ask that the rebuild produced,
  // so of course it stopped. A loop test that never completes the loop is a test that cannot fail.
  // Answering every request the way the bridge does is what makes the runaway actually run away.
  // THE REPLY IS COMPUTED BY THE REAL RESOLVER, not hand-written. A canned payload is a second opinion
  // about the wire shape, and the console's job is to render the first one — the "not editable here" bug
  // lived exactly in the gap between the plan's url and the config's, which a hand-written reply that
  // used the same string for both could never show.
  const MENU_CTX = { domain: 'acme.example', app: ['ringotel'], scope: 'Office Manager' };
  const REPLY = (() => {
    const matched = {} as never;
    const rawAdds = {} as never;
    const plan = resolveMenus({ PORTAL_MENUS: d.menus.raw } as never, MENU_CTX as never, matched, rawAdds);
    return { plan, matched, rawAdds, appsHide: appsHideSources({ PORTAL_MENUS: d.menus.raw } as never, MENU_CTX as never) };
  })();
  const askCount = () => dom.posts.filter((m) => m[SPK_BRIDGE.tag] === SPK_BRIDGE.resolveRequest).length;
  /** Run the real cycle to a standstill: fire the timers, answer whatever they asked, repeat. */
  const askedIds = () => dom.posts.filter((m) => m[SPK_BRIDGE.tag] === SPK_BRIDGE.resolveRequest)
    .map((m) => m[SPK_BRIDGE.idKey]);
  const pump = (max: number) => {
    let asks = 0, rounds = 0;
    while (dom.pending() && rounds < max) {
      const before = askCount();
      dom.flush();
      const ids = askedIds();
      const added = ids.length - before;
      asks += added;
      // ANSWERED THE WAY THE PARENT ANSWERS — the question's own id echoed back. A harness that replies
      // untagged takes the compatibility path and never drives the stale-answer guard at all.
      for (let i = 0; i < added; i++) api.mbOnResolve(REPLY, ids[before + i]);
      rounds++;
    }
    return { asks, rounds, settled: dom.pending() === 0 };
  };
  const lastAsk = () => {
    const asks = dom.posts.filter((m) => m[SPK_BRIDGE.tag] === SPK_BRIDGE.resolveRequest);
    return (asks[asks.length - 1] ?? {})[SPK_BRIDGE.resolveKey] as
      { c: string; domain: string; scope: string; apps: string[] } | undefined;
  };
  const run = pump(12);
  // ⚠️ THE HARNESS ANSWERED EVERY ASK WITH ONE CANNED REPLY AND NEVER READ THE QUESTION. Dropping the
  // persona from mbAskPreview entirely would have left every assertion here green while every preview
  // in production answered for the wrong audience — the same family as the loop test that settled for
  // the wrong reason. So check the payload, not just that something was sent.
  const asked = lastAsk();
  ok(!!asked && asked.scope === api.mbPersona.scope && asked.domain === api.mbPersona.domain
    && asked.apps.slice().sort().join('+') === api.mbPersona.apps.slice().sort().join('+'),
    `[ask] the Worker is asked about the persona actually on screen (${JSON.stringify(asked && { s: asked.scope, d: asked.domain, a: asked.apps })})`);
  ok(!!asked && JSON.parse(asked.c) && Object.keys(JSON.parse(asked.c)).length > 0,
    '[ask] and about the candidate config, not an empty one');
  ok(run.settled && run.rounds < 12,
    `[dom] the reply cycle reaches a standstill instead of redrawing forever (${run.asks} asks, ${run.rounds} rounds)`);
  ok(askCount() <= 2, `[dom] and it asks the Worker once per real question, not once per redraw (${askCount()})`);

  // The picture itself: hidden rows are struck through IN the menu rather than listed in a second section,
  // and an added row sits in the same list. This is the whole layout decision, asserted once.
  const appsPanel = host.children[0]!;
  const rows = appsPanel.all('.fm');
  const rowText = rows.map((r) => `${r.className}:${r.textContent}`);
  ok(rows.some((r) => r.className.includes('hid') && r.textContent.includes('SNAPmobile Web')),
    `[dom] a hidden stock entry is a struck-through row in the menu (${rowText.join(' | ')})`);
  ok(rows.some((r) => r.className.includes('add') && r.textContent.includes('App Admin')),
    '[dom] and an added entry is a marked row in the same menu, not a second section');

  // ⚠️ THE IDENTITY OF A DRAWN ROW IS THE ENTRY AS WRITTEN, not as resolved. This entry's url carries a
  // {variable}; the preview resolves with no user facts, so the plan's url is the template with the
  // placeholder emptied. Matching by the resolved url found nothing and the row said "not editable here"
  // — on exactly the entries that use the feature. The endpoint supplies the written form; nothing here
  // re-derives the substitution.
  const addRow = rows.find((r) => r.textContent.includes('App Admin'))!;
  ok(addRow.all('button').some((b) => b.textContent === 'edit')
    && addRow.all('button').some((b) => b.textContent === 'remove'),
    `[dom] an entry whose url carries a variable is still editable (${addRow.textContent})`);
  ok(!addRow.textContent.includes('not editable here'),
    '[dom] and it does not claim otherwise');

  // The kit's OWN rows are drawn and marked not-config: they are in the menu the user opens, they cannot
  // be hidden by config (menuHide skips them), and a picture missing them invites an operator to add a
  // link the menu already has.
  const fixed = appsPanel.all('.fm').filter((r) => r.className.includes('fixed'));
  ok(fixed.some((r) => r.textContent.includes('Sign in details')),
    `[dom] the app sign-in row is drawn where the app is active (${fixed.map((f) => f.textContent).join(' | ')})`);
  ok(fixed.every((r) => r.all('input').length === 0 && r.all('button').length === 0),
    '[dom] with no control on it — there is nothing in the config to change');
  ok(host.children[1]!.all('.fm').every((r) => !r.className.includes('fixed')),
    '[dom] and only on the Apps menu, which is the one the kit appends to');
  // ⚠️ AND ONLY WHEN THAT INTEGRATION IS THE ACTIVE ONE. They are one integration's sign-in block; drawn
  // for ANY active app, a domain running a different one was promised a panel the portal would never
  // render there (David, toggling documo on its own).
  {
    const apps = dom.byId['spkmb-apps']!.all('button');
    const ringotel = apps.find((b) => b.textContent === 'ringotel')!;
    const documo = apps.find((b) => b.textContent === 'documo')!;
    documo.fire('click');                              // documo ON  → ringotel + documo
    ringotel.fire('click');                            // ringotel OFF → documo only
    pump(12);
    ok(host.children[0]!.all('.fm').every((r) => !r.className.includes('fixed')),
      '[dom] a different integration active alone draws no sign-in rows for this one');
    ringotel.fire('click');
    documo.fire('click');                              // back to ringotel only
    pump(12);
    ok(host.children[0]!.all('.fm').some((r) => r.className.includes('fixed')),
      '[dom] and they come back when it is the active one');
  }

  // ── the placeholders are offered WHERE A URL IS TYPED ─────────────────────────────────────────────
  // They were documented in the reference and nowhere near the box, so the feature existed for whoever
  // had already read about it. Opening an entry's form must offer every variable the runtime accepts —
  // from the module that validates them, so one this deployment would refuse at startup is unofferable.
  addRow.all('button').find((b) => b.textContent === 'edit')!.fire('click');
  const form = host.children[0]!.all('.fmvars')[0]!;
  const chips = form.all('button');
  ok(chips.length === MENU_VARS.length,
    `[vars] every placeholder is offered at the point of use (${chips.map((c) => c.textContent).join(' ')})`);
  ok(chips.every((c) => c.title.includes('—') && c.title.length > c.textContent.length + 3),
    '[vars] and each says what it fills, rather than being a token you have to go look up');
  // AT THE CARET, not appended: every url with a query string after the insertion point breaks otherwise.
  const urlField = host.children[0]!.all('.mbin-url')[0]!;
  urlField.value = 'https://x.example/?a=1&b=2';
  (urlField as unknown as { selectionStart: number; selectionEnd: number }).selectionStart = 22;
  (urlField as unknown as { selectionStart: number; selectionEnd: number }).selectionEnd = 22;
  urlField.fire('focus');
  chips.find((c) => c.textContent === '{ext}')!.fire('click');
  ok(host.children[0]!.all('.mbin-url')[0]!.value === 'https://x.example/?a=1{ext}&b=2',
    `[vars] inserted where the caret was (${host.children[0]!.all('.mbin-url')[0]!.value})`);

  // Close it again: an open form suppresses the redraw on a preview reply (replacing the DOM under
  // someone mid-keystroke is the complaint this whole rebuild answers), so leaving it open would make
  // everything after this assert against a deliberately frozen picture.
  host.children[0]!.all('.fmform')[0]!.all('button').find((b) => b.textContent === 'Done')!.fire('click');

  // ── SEEDING A CARVE MUST KEEP THE TEMPLATE, NOT THE SUBSTITUTION ──────────────────────────────────
  // A new rung is seeded with what the persona already gets — and "what they get" in the preview is the
  // RESOLVED plan, in which every server-side {variable} has already been interpolated to empty, because
  // the preview has no user facts. Seeding from it wrote the emptied url into the new rung and the
  // result validated green: the operator's placeholder was gone and nothing said so. The raw forms are
  // on the same reply. This is the assertion the fix had no guard for.
  {
    const addRows = host.children[0]!.all('.fm').filter((r) => r.className.includes('add'));
    const addBtn = host.children[0]!.all('button').find((b) => b.textContent.startsWith('Add an entry'));
    ok(!!addBtn, '[seed] the Apps menu offers a way in');
    addBtn!.fire('click');
    const prompt = host.children[0]!.all('.mbfork')[0]!;
    // A CARVE, not the rung that already answered — that is the path that seeds.
    prompt.all('button').find((b) => b.textContent.startsWith('just Office Manager'))!.fire('click');
    const cfg = JSON.parse(dom.byId['spkmb-json']!.textContent) as
      { apps: { add: { scopes?: Record<string, { url: string }[]> } } };
    const carved = cfg.apps.add.scopes?.['Office Manager'] ?? [];
    ok(carved.length > 0 && carved.some((e) => e.url.includes('{ext}')),
      `[seed] the carved rung keeps the operator's placeholder, not the emptied substitution (${JSON.stringify(carved)})`);
    ok(!carved.some((e) => /\?ext=$/.test(e.url)),
      '[seed] and does not silently emit the interpolated form, which validates green while being wrong');
    ok(addRows.length > 0, '[seed] (the persona genuinely had an added entry to seed from)');
    // "Add an entry…" opens a form on a blank entry, and an open form deliberately suppresses the
    // rebuild a preview reply would otherwise cause. Leaving it open makes every later assertion read a
    // frozen picture — which is how the failure-branch block below started failing for a reason that had
    // nothing to do with it. Done on a blank entry drops it and leaves the carved rung behind.
    host.children[0]!.all('.fmform')[0]!.all('button').find((b) => b.textContent === 'Done')!.fire('click');
  }


  // A stock entry the portal only shows to someone with something to manage is WITHHELD while previewing
  // a user who has nothing — and NAMED, because a picture that quietly shrinks is a different lie from the
  // one being fixed. `My Account` is the case: the account menu relabels itself by context, and a Basic
  // User is only ever in the row that says `Profile`. The fixture hides it by config too, so the third
  // assertion covers the interaction — a hide naming a withheld row is working, not failing to match.
  //
  // Previewed as a BASIC USER, since the floor is what it is: an Office Manager manages a domain and sees
  // the row. That means resolving a reply for that audience rather than reusing this block's — the harness
  // answering with the wrong persona's plan is the failure mode the ask-payload assertions exist for.
  {
    const BASIC_CTX = { domain: 'acme.example', app: [] as string[], scope: 'Basic User' };
    const REPLY_BASIC = (() => {
      const matched = {} as never;
      const rawAdds = {} as never;
      const plan = resolveMenus({ PORTAL_MENUS: d.menus.raw } as never, BASIC_CTX as never, matched, rawAdds);
      return { plan, matched, rawAdds, appsHide: appsHideSources({ PORTAL_MENUS: d.menus.raw } as never, BASIC_CTX as never) };
    })();
    const wasScope = api.mbPersona.scope, wasApps = api.mbPersona.apps.slice();
    api.mbPersona.scope = 'Basic User';
    api.mbPersona.apps = [];
    api.mbRebuild();
    dom.flush();
    api.mbOnResolve(REPLY_BASIC, askedIds().pop());
    const acctB = host.children[1]!;
    ok(!acctB.all('.fm').some((r) => r.textContent.includes('My Account')),
      `[scope] a row this reader's scope never sees is not drawn for them (${acctB.all('.fm').map((r) => r.textContent).join(' | ')})`);
    ok(acctB.all('.fmfoot').some((f) => f.textContent.includes('My Account') && f.textContent.includes('your own session')),
      '[scope] and the picture says what it withheld rather than quietly shrinking');
    ok(!acctB.all('.fmfoot').some((f) => f.textContent.includes('not on this page')),
      '[scope] a hide naming a withheld row is not then reported as matching nothing — it is doing its job');
    // Back to the audience the rest of this block is written about.
    api.mbPersona.scope = wasScope;
    api.mbPersona.apps = wasApps;
    api.mbRebuild();
    dom.flush();
    api.mbOnResolve(REPLY, askedIds().pop());
  }
  const acct = host.children[1]!;
  ok(acct.all('.fm').some((r) => r.textContent.includes('My Account')),
    '[scope] while an Office Manager, who does manage something, is shown the row (and its hide)');
  ok(appsPanel.all('.halfhead').length === 0,
    '[dom] "Hidden entries" and "Added entries" are gone as headings — one picture, per the layout decision');

  // ── THE FAILURE BRANCH, EXECUTED ──────────────────────────────────────────────────────────────────
  // Never run until now: the harness only ever delivered a successful reply, and the claim that a failed
  // preview does not draw a menu was a grep for /return;/ that any later function satisfied. An empty
  // plan drawn as a menu asserts "nothing is hidden or added for this audience", which is a confident
  // wrong answer when the truth is that we could not ask.
  const before = api.mbPersona.domain;
  for (const [i, bad] of [{ unavailable: 'the Worker could not be reached.' },
    { invalid: 'apps.hide must be an array' }].entries()) {
    // A reply is only applied while an ask is outstanding — which is the guard that stops a late reply
    // being taken for an answer to a question nobody asked. So genuinely ask first: change the persona,
    // let the debounce fire, and answer THAT.
    api.mbPersona.domain = `bad${i}.example`;
    api.mbRebuild();
    dom.flush();
    api.mbOnResolve(bad);
    const drawn = host.all('.fm');
    const notice = host.all('.pv-bad').map((n) => n.textContent).join(' | ');
    ok(drawn.length === 0, `[failed] ${Object.keys(bad)[0]}: nothing menu-shaped is drawn (${drawn.length} rows)`);
    ok(host.all('.fake').length === 0, `[failed] ${Object.keys(bad)[0]}: not even an empty menu frame`);
    ok(notice.includes('Preview unavailable') || notice.includes('cannot be resolved'),
      `[failed] ${Object.keys(bad)[0]}: and it says which of the two happened (${notice})`);
  }
  api.mbPersona.domain = 'unavail.example';
  api.mbRebuild();
  dom.flush();
  api.mbOnResolve({ unavailable: 'the Worker could not be reached.' });
  ok(host.all('.pv-bad').some((n) => n.textContent.includes('Nothing below is a statement about your config')),
    '[failed] could-not-ask is not reported as a fact about the config');
  api.mbPersona.domain = before;
  api.mbRebuild();
  dom.flush();

  // Back to a good reply, or everything after this asserts against a deliberately blank picture.
  api.mbPersona.domain = before;
  api.mbRebuild();
  dom.flush();
  api.mbOnResolve(REPLY);
  ok(host.all('.fm').length > 0, '[failed] and a good reply afterwards restores the picture');

  // ── A LATE ANSWER TO A QUESTION THAT IS NO LONGER ON SCREEN ───────────────────────────────────────
  // Asking again does not cancel the round-trip already in flight, so two answers can be outstanding and
  // can land in either order. Untagged, the first one to arrive was handed to the callback waiting for
  // the second — the picture drawn from a config nobody is looking at — and it emptied the slot, so the
  // RIGHT answer was then dropped with the no-repeat guard already holding the newer key. Nothing ever
  // re-asked. The second assertion below is the one that fails without the id: the correct answer must
  // still be able to land after a stale one has been ignored.
  {
    const shows = (what: string) => host.children[0]!.all('.fm').some((r) => r.textContent.includes(what));
    ok(shows('App Admin'), '[stale] the picture starts from the answer to the question on screen');
    // Q1 — a different audience: no apps active, so this config adds nothing to the Apps menu. Its answer
    // is therefore visibly different from the one already drawn, which is what makes the race observable.
    api.mbPersona.apps = [];
    api.mbRebuild();
    dom.flush();
    const rid1 = askedIds().pop();
    const NONE_CTX = { domain: api.mbPersona.domain, app: [] as string[], scope: api.mbPersona.scope };
    const REPLY_NONE = (() => {
      const matched = {} as never;
      const rawAdds = {} as never;
      const plan = resolveMenus({ PORTAL_MENUS: d.menus.raw } as never, NONE_CTX as never, matched, rawAdds);
      return { plan, matched, rawAdds, appsHide: appsHideSources({ PORTAL_MENUS: d.menus.raw } as never, NONE_CTX as never) };
    })();
    // Q2 — the operator moves on before Q1 comes back. This is now the question on screen.
    api.mbPersona.apps = ['ringotel'];
    api.mbRebuild();
    dom.flush();
    const rid2 = askedIds().pop();
    ok(typeof rid1 === 'number' && typeof rid2 === 'number' && rid1 !== rid2,
      `[stale] each question carries its own id (${String(rid1)} → ${String(rid2)})`);
    // Q1's answer arrives now, late and correct — about an audience nobody is looking at.
    api.mbOnResolve(REPLY_NONE, rid1);
    ok(shows('App Admin'),
      '[stale] a late answer to the previous question does not redraw the picture for this one');
    api.mbOnResolve(REPLY, rid2);
    ok(shows('App Admin'),
      '[stale] and the answer to the question on screen still lands — the stale one did not consume the '
      + 'slot it was waiting in, which is what left the wrong picture up with nothing left to re-ask');
  }


  // ── EDITING HAPPENS IN THE PICTURE, and the first edit asks where it lands ─────────────────────────
  // The tick is ambiguous by construction once two apps can be active, so the fork question is not
  // decoration: without it a tick silently widens to an audience the operator is not looking at.
  const box = rows.find((r) => r.textContent.includes('Attendant Console'))!.all('input')[0]!;
  box.checked = true;
  box.fire('change');
  const fork = host.children[0]!.all('.mbfork');
  ok(fork.length === 1, `[dom] the first edit to a half asks where it should land (${fork.length} prompts)`);
  const opts = fork[0]!.all('button');
  ok(opts.some((b) => b.textContent.includes('ringotel')),
    '[dom] offering the shared rule that answered — named as the operator wrote it');
  ok(opts.some((b) => b.textContent.includes('Office Manager')),
    '[dom] and a narrower rule for exactly the persona being previewed');

  // Answer it: the edit that was held is applied, and the answer STICKS — a second tick must not re-ask.
  opts.find((b) => b.textContent.includes('ringotel'))!.fire('click');
  const cfg1 = JSON.parse(dom.byId['spkmb-json']!.textContent) as
    { apps: { hide: { app: { ringotel: string[] } } } };
  ok(cfg1.apps.hide.app.ringotel.includes('Attendant Console'),
    `[dom] the held edit lands in the rung that was chosen (${JSON.stringify(cfg1.apps.hide)})`);
  // One line PER HALF that has an answer — this menu now has an add target too, carved by the seeding
  // block above, and each half's line must name its own target rather than the count being pinned.
  const whereLines = host.children[0]!.all('.mbwhere').map((w) => w.textContent);
  ok(whereLines.some((w) => w.startsWith('Hiding lands in') && w.includes('ringotel')),
    `[dom] and a persistent line says where hides are landing while the answer is stuck (${whereLines.join(' | ')})`);
  ok(whereLines.every((w) => /^(Hiding|Adding) lands in \S/.test(w)),
    '[dom] each line names its own half and a target, rather than being a bare marker');

  const box2 = host.children[0]!.all('.fm').find((r) => r.textContent.includes('User Portal'))!.all('input')[0]!;
  box2.checked = true;
  box2.fire('change');
  ok(host.children[0]!.all('.mbfork').length === 0, '[dom] a second edit to the same half does not ask again');
  const cfg2 = JSON.parse(dom.byId['spkmb-json']!.textContent) as
    { apps: { hide: { app: { ringotel: string[] } } } };
  ok(cfg2.apps.hide.app.ringotel.includes('User Portal'),
    '[dom] it goes straight to the stuck target');

  // THE RAIL, and the one property that decides whether it helps or repeats the failure it replaces: each
  // rule is filed under the menu it belongs to. A Reseller answer sitting beside the Management panel
  // while showing Apps data is the lost-track failure moved one column right.
  const rules = dom.byId['spkmb-rules']!;
  const groups = rules.all('.railmenu').map((g) => g.textContent);
  ok(groups.includes('Apps') && groups.includes('Account'),
    `[rail] rules are grouped under the menu they belong to (${groups.join(', ')})`);
  const appsGroupAt = rules.children.indexOf(rules.all('.railmenu').find((g) => g.textContent === 'Apps')!);
  const acctGroupAt = rules.children.indexOf(rules.all('.railmenu').find((g) => g.textContent === 'Account')!);
  const appsRules = rules.children.slice(appsGroupAt + 1, acctGroupAt).map((r) => r.textContent).join(' | ');
  const acctRules = rules.children.slice(acctGroupAt + 1).map((r) => r.textContent).join(' | ');
  ok(appsRules.includes('ringotel') && !acctRules.includes('ringotel'),
    `[rail] and the Apps rule is filed under Apps, not floating (apps: ${appsRules} / account: ${acctRules})`);
  ok(rules.all('.rule').some((r) => r.className.includes('live')),
    '[rail] and the rule that answered for this persona is marked as applying now');
  const changed = dom.byId['spkmb-changed']!;
  ok(changed.textContent.includes('Attendant Console') && changed.textContent.includes('User Portal'),
    `[rail] the change log names what this session actually did (${changed.textContent})`);

  // ── THE LIMIT, SAID WHERE IT CANNOT BE MISSED ─────────────────────────────────────────────────────
  // The rules are exact; the stock entries are one session's DOM read as whoever opened it. Without this
  // said out loud the picture invites the belief it is what that role sees — which is a worse failure
  // than the list of labels it replaced, because it looks authoritative. It appears only when the persona
  // is somebody else: on your own scope the entries are your own, and a caveat that is always on screen
  // is one nobody reads.
  const caveat = dom.byId['spkmb-caveat']!;
  ok(!caveat.hidden && caveat.textContent.includes('Office Manager') && caveat.textContent.includes('Super User'),
    `[caveat] previewing another role names both roles and says the entries are approximate (${caveat.textContent.slice(0, 80)}…)`);
  ok(/rules below are exact/i.test(caveat.textContent) && /stock entries are not/i.test(caveat.textContent),
    '[caveat] and separates what IS exact from what is not, rather than hedging both');
  ok(/Remember this role/i.test(caveat.textContent) && /a hide still works on the rest/i.test(caveat.textContent),
    '[caveat] and says what to do about it — both the real fix and the one available right now, because a '
    + 'limit with no remedy is just discouragement');

  // ── A MENU THE READER DOES NOT HAVE ───────────────────────────────────────────────────────────────
  // Every applier finds its menu before it applies anything and returns when it is not there, so an add
  // aimed at a menu this reader does not have never happens. The panel is drawn anyway (you can still
  // write config for it), which is exactly why it has to say so — a drawn menu looks like somewhere an
  // entry could go. Management is absent from LIVE here and there is no capture yet, so this is the
  // weaker of the two sentences: it is a fact about the reader's own page, not about the persona.
  {
    const mgmt = host.children[2]!.textContent;
    ok(/only ever\s+added to a menu the reader already has/.test(mgmt.replace(/\s+/g, ' ')),
      `[absent] a menu missing from this page says an add would not appear (${mgmt.slice(0, 120)})`);
    ok(/Remember this role/.test(mgmt),
      '[absent] and points at the one thing that would settle it for another role');
  }

  // ── A CAPTURE REPLACES THE APPROXIMATION ──────────────────────────────────────────────────────────
  // The whole point of capturing a role's menus while masquerading: the picture stops being drawn from
  // the reader's own page. Delivered the way the bridge delivers it, then asserted on the DRAWN ROWS —
  // a test that only checked the caveat text would pass with the capture stored and never used.
  api.mbOnStock({
    'office manager': {
      scope: 'Office Manager',
      at: new Date('2026-08-09T00:00:00Z').getTime(),
      // The context the capture was taken in. Without it the picture pairs a role's real entries with
      // whatever the persona bar happened to say — David, on his own capture: a Basic User on a domain
      // with no app still had that app's entry struck through, because the toggles default to all-on.
      domain: 'other.example',
      appRows: false,
      // Management ABSENT for this role, which is the real shape: it is shown to administrative scopes
      // only, so an Office Manager on many portals has no such dropdown at all.
      menus: { apps: { present: true, entries: ['User Portal', 'Softphone'] },
        management: { present: false, entries: [] } },
    },
  });
  pump(12);
  // ⚠️ THE APP STATE IS ADOPTED; THE DOMAIN IS OFFERED. A capture is about a ROLE, and filling its domain
  // in silently adds a second dimension to what you are editing — a domains rung outranks everything, so
  // the preview and the fork's narrower option both become specific to one customer without anyone
  // choosing it. It also could not be undone: adopt-once is per capture, so switching to a SECOND
  // captured role filled the field again and a Clear never survived (David, on his own two captures).
  ok(api.mbPersona.apps.length === 0,
    `[capture] the app state the capture observed is adopted (${api.mbPersona.apps.join('+') || 'none'})`);
  ok(api.mbPersona.domain !== 'other.example',
    `[capture] but the DOMAIN is not — narrowing to one customer is a decision, not a side effect (${api.mbPersona.domain})`);
  ok(dom.byId['spkmb-apps']!.all('button').every((b) => b.getAttribute('aria-pressed') === 'false'),
    '[capture] and the controls show what was adopted, rather than disagreeing with what is drawn');
  ok(/No app rows were on that page/.test(caveat.textContent) && /an inference, not a reading/.test(caveat.textContent),
    '[capture] the app state is reported as the inference it is — one bit of evidence, and absence is ambiguous');
  // Adopted ONCE. An operator who turns a toggle back on must not have it reset under them by the next
  // preview reply, which arrives every time anything changes.
  api.mbPersona.apps = ['ringotel'];
  api.mbOnStock(api.mbStockRaw());
  ok(api.mbPersona.apps.join('') === 'ringotel',
    '[capture] and adopting is once per capture, so a correction sticks');
  const appsRows = host.children[0]!.all('.fm').map((r) => r.textContent).join(' | ');
  ok(appsRows.includes('Softphone') && !appsRows.includes('Attendant Console'),
    `[capture] the picture is drawn from the captured role, not from the reader's own menus (${appsRows})`);
  ok(caveat.textContent.includes('capture of Office Manager') && /days ago|today|yesterday/.test(caveat.textContent),
    `[capture] and the caveat becomes the capture's age, because a snapshot presented as current is the next wrong answer (${caveat.textContent.slice(0, 90)})`);
  ok(!/stock entries are not/i.test(caveat.textContent),
    '[capture] the approximation warning is replaced, not stacked on top of it');
  // A menu the capture does not carry falls back rather than rendering empty — an empty menu is a claim.
  ok(host.children[1]!.all('.fm').some((r) => r.textContent.includes('My Account')),
    '[capture] a menu missing from the capture falls back to this session rather than drawing nothing');
  // ⚠️ CARRIED-AND-EMPTY IS NOT MISSING. The capture says this role HAS no Management menu, which is
  // evidence about the role rather than about the reader — so the sentence gets stronger, and it is the
  // question an operator actually has: will the entry I add here show up? (David, 2026-08-11.)
  {
    const mgmt = host.children[2]!.textContent.replace(/\s+/g, ' ');
    ok(/has no Management menu/.test(mgmt) && /this role does not get one/.test(mgmt),
      `[absent] a capture with the menu absent says so about the ROLE (${mgmt.slice(0, 140)})`);
    ok(/the kit never creates one/.test(mgmt),
      '[absent] and answers the question directly: nothing configured here will appear for them');
  }

  // ── AN AUTO-FILLED DOMAIN MUST NOT BE MISSED ──────────────────────────────────────────────────────
  // It is not cosmetic. A domains rung outranks every other rule, so a domain sitting in that box makes
  // the preview AND the fork's carve options specific to one customer — an operator making a fleet-wide
  // change would be looking at one domain and offered "just that domain" as their narrower option. The
  // capture filling it is correct and useful; being unable to tell that it happened is the defect.
  // The domains the captures came from, OFFERED under the field — for any role, not only the one they
  // were taken on. A domain is a domain, and previewing one role against a domain you happened to
  // capture another on is an ordinary thing to want.
  const note = dom.byId['spkmb-domnote']!;
  ok(note.textContent.includes('Captured from') && note.textContent.includes('other.example'),
    `[domain] the captured domain is offered, not applied (${note.textContent})`);
  const offer = note.all('button').find((b) => b.textContent === 'other.example')!;
  ok(!!offer, '[domain] as something to click');
  offer.fire('click');
  ok(api.mbPersona.domain === 'other.example' && dom.byId['spkmb-domain']!.value === 'other.example',
    '[domain] clicking it narrows the preview, which is now a decision the operator made');
  ok(!dom.byId['spkmb-domnote']!.textContent.includes('other.example'),
    '[domain] and it stops being offered once it is in the field — a control that does nothing is worse than none');
  const clearBtn = dom.byId['spkmb-domclear']!.all('button')[0];
  ok(!!clearBtn && clearBtn.textContent === 'Clear', '[domain] with a way out beside the field');
  clearBtn!.fire('click');
  ok(api.mbPersona.domain === '' && dom.byId['spkmb-domain']!.value === '',
    '[domain] clearing it clears the persona too');
  ok(dom.byId['spkmb-domclear']!.all('button').length === 0,
    '[domain] and the control goes away with nothing left to clear');
  // ⚠️ AND A CLEAR SURVIVES A ROLE SWITCH. The bug this replaced: adopt-once is per capture, so moving to
  // a second captured role adopted ITS domain and the field filled itself again.
  const sel0 = dom.byId['spkmb-scope']!;
  const was = sel0.value;
  sel0.value = 'Reseller'; sel0.fire('change');
  sel0.value = was; sel0.fire('change');
  ok(api.mbPersona.domain === '',
    `[domain] and switching roles does not fill it back in (${api.mbPersona.domain})`);

  // ── ARMING CAPTURE, and being able to tell whether it worked ──────────────────────────────────────
  const cap = dom.byId['spkmb-capture']!;
  ok(cap.textContent.includes('Arm capture before you masquerade'),
    `[arm] the console offers to arm capture, which is the only place you can do it before one starts (${cap.textContent.slice(0, 60)})`);
  ok(cap.textContent.includes('Captured: Office Manager') && /\d+ entries/.test(cap.textContent),
    `[arm] and says what is stored, with the entry count that makes a mid-load capture visible (${cap.textContent})`);
  const armBox = cap.all('input')[0]!;
  armBox.checked = true;
  armBox.fire('change');
  const armed = dom.posts.filter((m) => m[SPK_BRIDGE.tag] === SPK_BRIDGE.stockRequest)
    .map((m) => m[SPK_BRIDGE.stockKey]).filter(Boolean);
  ok(armed.some((q) => (q as { mode?: boolean }).mode === true),
    `[arm] ticking it asks the PARENT to store the mode — this frame has no storage of its own (${JSON.stringify(armed)})`);
  // Armed state comes back from the store, never from the checkbox: the frame is not the authority.
  api.mbOnStock({ ...(api.mbStockRaw() as Record<string, unknown>), __mode: { on: true, at: 1 } });
  ok(dom.byId['spkmb-capture']!.textContent.includes('beside End Masquerade'),
    '[arm] and once the store says it is armed, the panel says where the button will be');

  // ── THE TWO FOOT CONTROLS BELONG TO DIFFERENT HALVES ──────────────────────────────────────────────
  // They were on one row with a single button between them, so the button next to the hide box belonged
  // to the ADD half and the hide box answered only to Enter. Nothing in the emitted source said which
  // control drove which — the reader had to try it.
  {
    const panel = host.children[2]!;                       // Management: no config, so both are offered
    const feet = panel.all('.fmfoot');
    const addFoot = feet.find((f) => f.all('button').some((b) => b.textContent.startsWith('Add an entry')));
    const hideFoot = feet.find((f) => f.all('input').length);
    ok(!!addFoot && !!hideFoot && addFoot !== hideFoot,
      '[foot] the add control and the hide-by-name control are separate rows');
    ok(hideFoot!.all('button').some((b) => b.textContent === 'Hide it'),
      '[foot] and the hide box has its own button, not the neighbouring half\'s');
    ok(!addFoot!.all('input').length,
      '[foot] with no input beside the add button to be mistaken for its argument');
    // And it works by click, not only by Enter — which was the whole of the confusion.
    const box = hideFoot!.all('input')[0]!;
    box.value = 'Some Vendor Thing';
    hideFoot!.all('button').find((b) => b.textContent === 'Hide it')!.fire('click');
    const askedOrDone = host.children[2]!.all('.mbfork').length > 0
      || JSON.stringify(JSON.parse(dom.byId['spkmb-json']!.textContent)).includes('Some Vendor Thing');
    ok(askedOrDone, '[foot] clicking Hide it acts — asking where it lands counts, typing Enter is not required');
  }

  // ── THE PICKER SAYS WHICH ROLES YOU HAVE ──────────────────────────────────────────────────────────
  // ⚠️ Bold AND a word. font-weight on an <option> is honoured by some browsers and dropped by others —
  // macOS draws that menu natively — so a signal that is only weight is invisible on the machine the
  // operator uses. The text always renders.
  {
    const opts = dom.byId['spkmb-scope']!.all('option');
    const captured = opts.filter((o) => /\(captured\)/.test(o.textContent));
    ok(captured.length > 0 && captured.every((o) => o.style.fontWeight === '700'),
      `[picker] a role with a capture is marked in the picker (${captured.map((o) => o.textContent).join(', ')})`);
    ok(opts.filter((o) => !/\(captured\)/.test(o.textContent)).every((o) => !o.style.fontWeight),
      '[picker] and one without is left plain');
    // ⚠️ The VALUE is untouched — it is what the persona is read from, and marking must not rename a
    // scope into one no rung could spell.
    ok(opts.every((o) => KNOWN_SCOPES.includes(o.value)),
      '[picker] the option VALUES stay the scopes themselves, whatever the labels say');
    // Rebuilt from the value each pass, or a redraw says "(captured) (captured)". Redrawn several times
    // AND with a deliberately dirtied value, because that is the one input another pass could poison and
    // the result is silent and permanent once it happens.
    api.mbRebuild(); api.mbRebuild(); api.mbRebuild();
    const twice = (t: string) => (t.match(/\(captured\)/g) || []).length > 1;
    ok(!dom.byId['spkmb-scope']!.all('option').some((o) => twice(o.textContent)),
      `[picker] redrawing does not stack the marker (${dom.byId['spkmb-scope']!.all('option').map((o) => o.textContent).join(' | ')})`);
    const dirty = dom.byId['spkmb-scope']!.all('option').find((o) => /\(captured\)/.test(o.textContent))!;
    dirty.value = `${dirty.value} (captured)`;
    // The marker function directly, not through a redraw: this is a unit test of the STRIP, and routing
    // it through mbRebuild would have it depend on whatever else that does first.
    api.mbMarkScopes();
    ok(!twice(dirty.textContent) && KNOWN_SCOPES.includes(dirty.value),
      `[picker] and a value that somehow arrived already marked is cleaned rather than compounded (text="${dirty.textContent}" value="${dirty.value}")`);
  }

  // ── FORGET THE CAPTURES ────────────────────────────────────────────────────────────────────────────
  // Understated on purpose: for debugging and for people who like a clean slate, not something to reach
  // for by accident. ⚠️ TWO CLICKS RATHER THAN A confirm(): this frame is sandboxed without allow-modals,
  // so confirm() and alert() are blocked in it — the same class of fact that made the Copy button
  // silently do nothing for months and localStorage unavailable here. A confirmation that never appears
  // would either destroy the captures without asking or do nothing at all.
  const capPanel = () => dom.byId['spkmb-capture']!;
  const forget = () => capPanel().all('button').find((b) => /forget/i.test(b.textContent));
  ok(!!forget(), '[forget] there is a way to start fresh');
  const postsBefore = dom.posts.length;
  forget()!.fire('click');
  ok(dom.posts.length === postsBefore, '[forget] the first click sends nothing — it asks');
  ok(/click again/i.test(forget()!.textContent), `[forget] and says so (${forget()!.textContent})`);
  forget()!.fire('click');
  const cleared = dom.posts.filter((m) => m[SPK_BRIDGE.tag] === SPK_BRIDGE.stockRequest)
    .map((m) => m[SPK_BRIDGE.stockKey]).filter((q) => (q as { clear?: boolean })?.clear === true);
  ok(cleared.length === 1,
    `[forget] the second click asks the parent to forget them, since this frame has no storage (${JSON.stringify(cleared)})`);
  // The parent keeps the arming and drops the captures — one is data the operator gathered by walking
  // around the portal, the other is a preference about how the tool behaves.
  api.mbOnStock({ __mode: { on: true, at: 1 } });
  ok(capPanel().textContent.includes('Nothing captured yet')
    && capPanel().textContent.includes('beside End Masquerade'),
    `[forget] and the panel comes back empty but still armed (${capPanel().textContent.slice(0, 70)})`);
  ok(!capPanel().all('button').some((b) => /forget/i.test(b.textContent)),
    '[forget] with nothing left to forget, the control is gone');

  // Changing the persona RESETS the fork: the answer was about one audience, and carrying it to another is
  // exactly the silent widening the indicator exists to prevent.
  const scopeSel = dom.byId['spkmb-scope']!;
  scopeSel.value = 'Reseller';
  scopeSel.fire('change');
  pump(12);
  ok(!host.children[0]!.all('.mbwhere').some((w) => w.textContent.includes('ringotel')),
    '[dom] the stuck target does not survive a persona change');
  const box3 = host.children[0]!.all('.fm').find((r) => r.textContent.includes('Attendant Console'))!;
  const cb3 = box3.all('input')[0]!;
  cb3.checked = !cb3.checked;
  cb3.fire('change');
  ok(host.children[0]!.all('.mbfork').length === 1,
    '[dom] and the next edit asks again, against the audience now on screen');
}

// ── the persona opens on the READER'S OWN scope ──────────────────────────────────────────────────────
// Not the head of the scope list. Their own is the one persona whose stock entries are genuinely
// accurate — they came off their page, as them — so it is the only starting point that is not already an
// approximation, and it is what keeps the caveat above correctly silent until you move off it. It also
// matters practically: this console is reachable by Reseller and above, so the head of the list is a
// scope its own operator may have no account for.
{
  const forScope = (scope: string): string => {
    const doc = buildStatus(
      { NS_SERVER: 'api.example.com', NS_PORTAL_ISS: 'manage.example.com', PORTAL_MODE: '1',
        PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'dev' },
      { principal: P(scope, 'boss@example.com'), hostname: 'svc.example.com' });
    const html = statusHtml(doc);
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
    const dom = makeDom(['spkmb-status', 'spkmb-menus', 'spkmb-out', 'spkmb-json', 'spkmb-wr',
      'spkmb-verdict', 'spkmb-reset', 'spkmb-scope', 'spkmb-apps', 'spkmb-domain', 'spkmb-appswrap',
      'spkmb-changed', 'spkmb-caveat', 'spkmb-capture', 'spkmb-domclear', 'spkmb-domnote', 'spkmb-rules']);
    const api = runInNewContext(
      builderSource(script, '{ mbStart: mbStart, mbPersona: mbPersona }'), dom.ctx,
    ) as { mbStart: (l: unknown) => void; mbPersona: { scope: string } };
    api.mbStart({});
    return api.mbPersona.scope;
  };
  ok(forScope('Reseller') === 'Reseller', `[persona] a Reseller opens previewing as a Reseller (got ${forScope('Reseller')})`);
  ok(forScope('Super User') === 'Super User', '[persona] and a Super User as a Super User');
  // A scope the deployment does not know cannot go in the picker — it would be unspellable in a rung and
  // refused at startup — so it falls back rather than seeding a value nothing accepts.
  ok(KNOWN_SCOPES.includes(forScope('Nonesuch')), '[persona] and an unknown scope falls back to one the picker can offer');
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

// ── AN UNTOUCHED CONFIG COMES BACK BYTE FOR BYTE ──────────────────────────────────────────────────────
// The CHANGELOG makes this claim and it was not quite true. `menuItemAt` reads label/url/title and ignores
// every other key, so `{"label","url","note"}` is valid running config — and the editor rebuilt each entry
// from the three fields it understands, dropping the rest and normalising the key order, on menus nobody
// had opened. An empty flat list went the same way. Neither is a change to what the config DOES, which is
// precisely why they are pure noise in the diff the operator runs before pasting: a menu they never
// touched shows up as changed, and the change they did make is one line further down.
{
  const written = {
    apps: {
      // A key that means "nothing", written down. Dropping it is not tidying — it is a diff on an
      // untouched menu.
      hide: [],
      // Key order as the operator typed it, and a key this editor has no idea about.
      add: [{ url: 'https://a.example/x', label: 'Alpha', note: 'why this is here' }],
    },
    account: {
      hide: { scopes: { Reseller: [] }, '*': ['My Account'] },
      add: { '*': [{ label: 'Beta', title: 'tip', url: 'https://b.example/y', note: 'keep me' }] },
    },
  };
  const raw = JSON.stringify(written);
  ok(menuConfigError({ PORTAL_MENUS: raw }) === null,
    `[roundtrip] the premise: a config carrying an unknown key is accepted and runs (${menuConfigError({ PORTAL_MENUS: raw })})`);

  const d = DOC();
  d.menus.raw = raw;
  const html = statusHtml(d);
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  const dom = makeDom(['spkmb-status', 'spkmb-menus', 'spkmb-out', 'spkmb-json', 'spkmb-wr', 'spkmb-verdict',
    'spkmb-reset', 'spkmb-scope', 'spkmb-apps', 'spkmb-domain', 'spkmb-appswrap', 'spkmb-changed',
    'spkmb-caveat', 'spkmb-capture', 'spkmb-domclear', 'spkmb-domnote', 'spkmb-rules']);
  const api = runInNewContext(builderSource(script, '{ mbStart: mbStart }'), dom.ctx) as
    { mbStart: (live: unknown) => void };
  api.mbStart({ apps: { present: true, entries: ['User Portal'] },
    account: { present: true, entries: ['My Account', 'Log Out'] },
    management: { present: false, entries: [] } });

  const emitted = dom.byId['spkmb-json']!.textContent;
  ok(emitted === JSON.stringify(written, null, 2),
    `[roundtrip] a config nobody edited is emitted exactly as it was written\n--- emitted ---\n${emitted}\n--- written ---\n${JSON.stringify(written, null, 2)}`);
  // And the wrangler line is the same value, escaped — the thing actually pasted into the config file.
  ok(dom.byId['spkmb-wr']!.textContent === `"PORTAL_MENUS": ${JSON.stringify(raw)}`,
    '[roundtrip] and the wrangler line escapes that same value, not a re-serialised one');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
