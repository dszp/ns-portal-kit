/**
 * `statusHtml` — renders a `StatusDoc` into a self-contained HTML page.
 *
 * This is injected as the `srcdoc` of an `<iframe sandbox="allow-scripts allow-popups">` — that sandbox
 * has NO `allow-same-origin`, so the document runs in an opaque origin with no network access, no
 * localStorage, and no way to read `?query` params. Consequences that shape this file:
 *
 *   - Everything is inline: one `<style>` block, one `<script>` block. No CDN, no external font, no
 *     `<link rel=stylesheet>`, no `<script src=...>`.
 *   - Tabs are radio inputs + CSS sibling selectors — no script needed to switch panels.
 *   - Script is used for four things only: the Config filter, cross-tab jump-to-setting, the scope
 *     checker on the Permissions tab, and the probe postMessage bridge. None of it ever touches `doc`;
 *     it manipulates DOM already rendered server-side, or builds new DOM from a postMessage payload
 *     using `textContent` (never `innerHTML` with untrusted strings).
 *
 * THE SECRET RULE: every interpolated string goes through `esc()`. No object is ever `JSON.stringify`'d
 * into the page, and no field is read off a card except the specific named strings this file expects —
 * so a secret can't reach the page even by accident, structurally, not just because `status.ts` already
 * sets `value: null` for every secret setting. A `kind === 'secret'` row additionally renders no
 * `example` and no `defaultValue`, so nothing value-shaped appears on a secret row at all.
 *
 * WHAT THE PAGE IS ORGANISED AROUND, and why it changed (2026-08-08): the first version split cards by
 * "does it have an entry in FEATURE_REGISTRY" — a fact about our code, which put nine things that are not
 * integrations on a tab called Integrations — and answered "can YOU use this" on every card, a question
 * whose answer is structurally yes for essentially everyone who can open this console. The taxonomy is
 * now Features (capabilities, split by audience) / Integrations (external systems, owning their own
 * sub-aspects) / Deployment (how this Worker runs) / Permissions (the matrix: which of YOUR users get
 * what). See `docs/superpowers/specs/2026-08-08-status-console-ux-pass.md`.
 */

import { esc } from './pageShell.js';
import { PROBE_CATALOG, probeCatalogFor, GROUP_ORDER, GROUP_LABEL, GROUP_BLURB, DOCS_BASE, groupDocsUrl } from './statusModel.js';
import { SPK_BRIDGE } from './spkBridge.js';
import { KNOWN_SCOPES, LEVEL_SCOPES } from './features.js';
import { APP_NAMES, APP_RESERVED, MENU_NAMES, STOCK_SCOPE_FLOOR, MENU_VARS, MENU_VAR_HELP } from './menus.js';
import type {
  StatusDoc, FeatureCard, SubsystemCard, SettingView, ProbeResult, FeatureState, MissingRequirement,
  ProbeCatalogEntry, ProbeTable, PermissionsView, PermissionRow, PermissionCell, CellVerdict, SettingImportance,
  SettingGroup,
} from './statusModel.js';

// ── state pills: colour AND word, never colour alone ─────────────────────────────────────────────────

const PILL_LABEL: Record<FeatureState, string> = {
  on: 'ON', off: 'OFF', inert: 'INERT', misconfigured: 'MISCONFIGURED', 'not-integrated': 'NOT INTEGRATED',
};

function pill(state: FeatureState): string {
  return `<span class="pill pill-${state}">${PILL_LABEL[state]}</span>`;
}

/** Three states, not two: a setting can be absent, present-and-empty, or present with a value. `SET` /
 *  `UNSET` alone forced a present-empty value (`PORTAL_HANDOFF_URL=""` — a deliberate declaration) to
 *  render as UNSET beside `source: default`, which is a claim about this deployment that is simply untrue. */
function setPill(s: SettingView): string {
  if (s.set) return `<span class="pill pill-on">SET</span>`;
  if (s.source === 'env') return `<span class="pill pill-inert">SET (EMPTY)</span>`;
  return `<span class="pill pill-off">UNSET</span>`;
}

const escList = (xs: string[]): string => (xs.length ? xs.map(esc).join(', ') : '—');

function missingList(items: MissingRequirement[]): string {
  if (!items.length) return '';
  const rows = items.map((m) => `<li><strong>${esc(m.setting)}</strong> — ${richPara(m.why)} ${richPara(m.how)}</li>`).join('');
  return `<dt>Missing</dt><dd><ul class="plain">${rows}</ul></dd>`;
}

function notesList(notes: string[]): string {
  if (!notes.length) return '';
  return `<dt>Notes</dt><dd><ul class="plain">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></dd>`;
}

/**
 * A setting name rendered as a jump to its row on the Config tab.
 *
 * A card's disclosure used to list six bare names — no description, no way to reach the detail — so the
 * reader had to memorise one, switch tabs and search for it. The page has no URL (it is `srcdoc` in a
 * sandboxed iframe), so this cannot be an anchor; the button carries the name and `script()` switches the
 * tab, scrolls and highlights.
 */
function settingLink(name: string, what?: string): string {
  // The description on `title`, so hovering answers "what is this setting" without a cross-tab jump. Most
  // uses of these links are that question, not a desire to go read the whole row.
  const tip = what ? ` title="${esc(plainPara(`${name} — ${what}`))}"` : '';
  return `<button type="button" class="setref" data-setting="${esc(name)}"${tip}>${esc(name)}</button>`;
}

/**
 * `whats` maps setting name → its one-liner (for the tooltip); `vals` maps name → a SHORT current value.
 * Both are passed in rather than imported: this module renders a document and does not own the descriptor
 * table.
 *
 * Showing the value beside the name is David's Branding observation generalised — "the Branding card should
 * probably display the values of the settings with the settings list" is true wherever the value is short:
 * knowing that `RINGOTEL_WRITE_DOMAINS` is `*` is most of what you came to the card for, and a trip to the
 * Config tab to learn one character is a bad trade. Bounded on purpose: only non-secret, only short. A long
 * JSON blob would turn the list back into the wall of text the links replaced, and it is one click away.
 */
const settingLinks = (names: string[], whats: Record<string, string>, vals: Record<string, string>): string =>
  (names.length
    ? names.map((n) => `${settingLink(n, whats[n])}${vals[n] !== undefined ? `<code class="setval">${esc(vals[n])}</code>` : ''}`).join(' ')
    : '—');

// ── header ─────────────────────────────────────────────────────────────────────────────────────────

function renderHeader(doc: StatusDoc): string {
  const d = doc.deployment;
  return `<header class="spk-header">
  <div class="title-row">
    <h1>${esc(d.productName)} <span class="subtitle">- Integration Console</span> ${d.releaseNotesUrl
      ? `<a class="ver" href="${esc(d.releaseNotesUrl)}" target="_blank" rel="noopener noreferrer" title="What changed in this version, and what is newer">v${esc(d.version)}</a>`
      : `<span class="ver">v${esc(d.version)}</span>`}</h1>
    <span class="envbadge envbadge-${esc(d.envBadge.toLowerCase())}">${esc(d.envBadge)}</span>
  </div>
  <div class="meta">
    <span>${esc(d.hostname)}</span>
    <span class="sep">·</span>
    <span>${d.mode === 'portal-backend' ? 'portal-backend mode' : 'standalone mode'}</span>
    <span class="sep">·</span>
    <span>NS_SERVER: <code>${esc(d.nsServer)}</code></span>
    <span class="sep">·</span>
    <span>cache scope: <code>${esc(d.cacheScope)}</code></span>
    <span class="sep">·</span>
    <span>${d.configured ? 'no setup blockers' : 'setup incomplete'}</span>
  </div>
</header>`;
}

// ── tabs: radio + CSS sibling selectors, no script required to switch panels ─────────────────────────

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'features', label: 'Features' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'permissions', label: 'Permissions' },
  // Menus before Config: this tab WRITES a setting, Config READS them all. A reader who has just been
  // told what PORTAL_MENUS does should meet the thing that composes one before the flat list of 65 keys.
  { id: 'menus', label: 'Menus' },
  { id: 'config', label: 'Config' },
  // "Backend" rather than "Deployment": the old name reads as a noun about the ACT of deploying, when the tab
  // is about this Worker — the backend half of the injected add-on. Moved after Config to match its value:
  // it is information worth keeping and the least often needed.
  { id: 'backend', label: 'Backend' },
  { id: 'checks', label: 'Checks' },
] as const;

function renderTabInputs(): string {
  return TABS.map((t, i) => `<input type="radio" name="spktab" id="spktab-${t.id}" class="spk-tabin"${i === 0 ? ' checked' : ''}>`).join('\n');
}

function renderTabBar(): string {
  const labels = TABS.map((t) => `<label for="spktab-${t.id}">${esc(t.label)}</label>`).join('\n');
  return `<nav class="spk-tabbar">${labels}</nav>`;
}

/** The CSS that makes the radio inputs switch panels — generated from TABS so a new tab cannot be added
 *  to the bar and then silently fail to show, which is what a hand-written selector list invites. */
function tabCss(): string {
  const show = TABS.map((t) => `#spktab-${t.id}:checked ~ #spkpanel-${t.id}`).join(',\n');
  const active = TABS.map((t) => `#spktab-${t.id}:checked ~ .spk-tabbar label[for="spktab-${t.id}"]`).join(',\n');
  return `${show} { display:block; }\n${active} { color:var(--fg); border-color:var(--blue); background:var(--bg); }`;
}

// ── Overview panel ─────────────────────────────────────────────────────────────────────────────────

/** How the viewer got in, in words. The value is a RULE (`superadmin` | `level` | `named-user`), which is
 *  why the old label "Access granted by" misled — "by" implies a person, and only one of the three values
 *  involves one. */
const GRANTED_WORDS: Record<StatusDoc['viewer']['grantedBy'], string> = {
  superadmin: 'your account is listed in PORTAL_SUPERADMINS',
  level: 'your NetSapiens scope passes on its own',
  'named-user': 'your account is named directly in this feature\'s gate',
  unknown: 'could not be determined — see the config errors below',
};

/**
 * Who is reading, and how they got in.
 *
 * Masquerading and Operator are rendered ONLY when a mask is actually in effect. They are not merely
 * usually-empty: they are dead by construction here. `toPrincipal` makes a masked session's effective
 * identity the MASKED user, so a masquerading principal carries that user's scope and fails
 * `requireFleetRead` — masquerading into this console is impossible, and `operator` is only ever populated
 * from a mask chain. A row that can only ever say one thing carries no information; a row that appears
 * because something surprising happened does.
 */
function renderViewer(doc: StatusDoc): string {
  const v = doc.viewer;
  if (!v.id) {
    return `<p class="dim">No signed-in viewer — offline or preview mode.</p>`;
  }
  const mask = v.masquerading
    ? `<dt>Masquerading</dt><dd><strong>yes</strong> — as <code>${esc(v.id)}</code>${v.operator ? `, on behalf of <code>${esc(v.operator)}</code>` : ''}. This is unexpected: a masked session normally cannot reach this console.</dd>`
    : '';
  return `<dl class="kv">
    <dt>Signed in as</dt><dd><code>${esc(v.id)}</code></dd>
    <dt>Scope</dt><dd>${v.scope ? esc(v.scope) : '<span class="warn">not reported by your token — unexpected, and it means scope-based gates cannot admit you</span>'}</dd>
    <dt>Domain</dt><dd><code>${esc(v.domain)}</code></dd>
    <dt>Access via</dt><dd>${esc(GRANTED_WORDS[v.grantedBy])}</dd>
    ${mask}
  </dl>`;
}

function renderIssues(doc: StatusDoc): string {
  if (!doc.issues.length) return `<p class="dim">No setup issues found.</p>`;
  const rows = doc.issues
    .map((i) => `<li class="issue ${i.level}"><div class="t"><span class="tag ${i.level}">${i.level === 'blocker' ? 'must fix' : 'review'}</span>${esc(i.title)}</div><p>${esc(i.detail)}</p><p class="fix">${esc(i.fix)}</p></li>`)
    .join('');
  return `<ul class="plain issues">${rows}</ul>`;
}

function renderConfigErrors(doc: StatusDoc): string {
  if (!doc.configErrors.length) return '';
  const rows = doc.configErrors
    .map((e) => `<li class="issue blocker"><div class="t"><span class="tag blocker">config error</span>${esc(e.subsystem)}</div><p>${esc(e.reason)}</p></li>`)
    .join('');
  return `<section><h3>Config errors</h3><ul class="plain issues">${rows}</ul></section>`;
}

/** A count per state, over features and subsystems together — the one-line answer to "is this deployment
 *  healthy". Derived from the cards themselves, never a separate tally. */
function renderCounts(doc: StatusDoc): string {
  const states: FeatureState[] = ['on', 'inert', 'misconfigured', 'off', 'not-integrated'];
  const all = [...doc.features.map((f) => f.state), ...doc.subsystems.map((s) => s.state)];
  const parts = states
    .map((st) => ({ st, n: all.filter((x) => x === st).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${pill(x.st)} ${x.n}`);
  return `<p class="counts">${parts.join(' ')} <span class="dim">across ${all.length} features, integrations and deployment settings</span></p>`;
}

/** Attribution. The kit is MIT-licensed and its public source is a real destination a reader can go read —
 *  which is worth saying on the one page an operator of a deployment they did not build will actually open. */
function renderCredits(): string {
  return `<p class="credits">Super Portal Kit — part of
    <a href="https://github.com/dszp/ns-portal-kit" target="_blank" rel="noopener noreferrer">ns-portal-kit</a>,
    by <a href="https://david.szpunar.com" target="_blank" rel="noopener noreferrer">David Szpunar</a>.
    Copyright © 2026 David Szpunar. Released under the MIT License.</p>`;
}

function renderOverview(doc: StatusDoc): string {
  return `<section id="spkpanel-overview" class="spk-panel">
  <section><h3>You</h3>${renderViewer(doc)}</section>
  <section><h3>State</h3>${renderCounts(doc)}</section>
  <section><h3>Setup</h3>${renderIssues(doc)}</section>
  ${renderConfigErrors(doc)}
  <footer class="spk-footer">
    <p>This console reports configuration and gating — it is not a log viewer. For request-level detail,
    open <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">the Cloudflare dashboard</a>
    → Workers &amp; Pages → this Worker → Logs. Observability there runs at full sampling; nothing here
    is sampled or summarized.</p>
    ${renderCredits()}
  </footer>
</section>`;
}

/**
 * A jump bar for a long panel, plus the id each entry targets.
 *
 * Config is the real need — 64 rows in 12 sections, and once you have scrolled past the first heading
 * nothing on screen says what the others are. Generated from the sections actually rendered, so a heading
 * can never exist without an entry (or an entry point at a heading that is not there).
 */
function renderTocBar(items: { id: string; label: string; count?: number }[]): string {
  if (items.length < 2) return '';
  const links = items
    .map((i) => `<button type="button" class="tocref" data-target="${esc(i.id)}">${esc(i.label)}${i.count !== undefined ? ` <span class="dim">${i.count}</span>` : ''}</button>`)
    .join('');
  return `<nav class="toc">${links}</nav>`;
}

/** A section heading that a jump bar can reach, and that offers a way back up from the bottom of a long
 *  section — David's "and maybe back to top?", which matters most on Config. */
function sectionHead(id: string, label: string, count?: number): string {
  return `<h3 id="${esc(id)}" class="jumph">${esc(label)}${count !== undefined ? ` <span class="dim">(${count})</span>` : ''}<button type="button" class="totop" title="Back to the top of this tab">top</button></h3>`;
}

// ── Features panel ─────────────────────────────────────────────────────────────────────────────────
//
// Split by AUDIENCE, because the two kinds answer different questions. For an ADMIN feature the reader is
// the subject: "who can use this, and can you" is directly useful. For a SELF-SERVICE feature the reader's
// USERS are the subject, and whether the viewing superadmin passes `me.devices` says nothing about whether
// a Basic User sees their own device list — which is the only question an operator has about it.
//
// The word "Gate" is gone from this tab entirely. It came straight from the implementation
// (`resolveGate`, `gateLevels`, `allowedLevels`) and an operator has to translate it before they can
// answer their own question. Detail about WHO belongs on the Permissions tab, whose whole subject that is.

/** A feature key as a DOM id. Derived from the key rather than the name, because the key is the stable
 *  identifier an operator can also search for, and because two features could one day share a name. */
export const featureAnchor = (key: string): string => `feat-${key.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`;

function renderFeatureCard(f: FeatureCard, whats: Record<string, string>, vals: Record<string, string>): string {
  // Rendered only when the answer is NO. A superadmin passes every non-`off` gate by construction, so
  // "you pass" would be true on ~16 of 18 cards on every deployment forever — and a row that cannot vary
  // is not information. "You do not have access to this" can be, and is worth the space.
  const you = f.viewerPasses ? '' : `<dt>Your access</dt><dd class="warn">no — your own account cannot use this</dd>`;
  // A card with `detail` spans the full grid width: several paragraphs in a 20rem column is a ribbon, and the
  // features that earn an explanation are the ones a reader most needs to be able to read.
  const why = f.detail.length
    ? `<div class="why">${f.detail.map(richBlock).join('')}</div>`
    : '';
  return `<div class="card${f.detail.length ? ' card-wide' : ''}" id="${esc(featureAnchor(f.key))}">
  <div class="card-head">${pill(f.state)}<span class="card-name">${esc(f.name)}</span><code class="card-key">${esc(f.key)}</code><button type="button" class="totop" title="Back to the top of the page">top</button></div>
  <p class="card-desc">${esc(f.description)}</p>
  ${why}
  <dl class="kv">
    <dt>Available to</dt><dd>${esc(f.gate.inWords)} <span class="dim">(${f.gate.source === 'PORTAL_FEATURES' ? 'set in PORTAL_FEATURES' : 'built-in default'})</span></dd>
    ${you}
  </dl>
  <details>
    <summary>What it needs &middot; which settings control it</summary>
    <dl class="kv">
      ${missingList(f.missing)}
      <dt>Settings</dt><dd class="setrefs">${settingLinks(f.settings, whats, vals)}</dd>
      ${notesList(f.notes)}
    </dl>
  </details>
</div>`;
}

/**
 * A jump list naming EVERY feature in a group, not just the two group headings.
 *
 * The section bar answers "which half am I in", which stopped being the question once this tab grew past
 * twenty cards — several of them full-width with paragraphs of prose, so the group a reader wants can be
 * several screens below the heading that names it. Somebody looking for one feature had to scroll the
 * whole list to find out where it is, which is the failure a table of contents exists to remove.
 *
 * Names, not keys: this is for finding a thing you can describe. The key is on the card, and stays the
 * anchor's basis so the link survives a rename.
 *
 * ⚠️ No nested element inside the button. The shared jump handler reads `data-target` off the CLICKED
 * node, so a `<span>` inside a `.tocref` is a dead click when the reader happens to hit the span.
 */
function renderFeatureJumps(features: FeatureCard[]): string {
  if (features.length < 2) return '';
  const links = features
    .map((f) => `<button type="button" class="tocref" data-target="${esc(featureAnchor(f.key))}" title="${esc(f.key)}">${esc(f.name)}</button>`)
    .join('');
  return `<nav class="toc toc-jump">${links}</nav>`;
}

function renderFeatures(doc: StatusDoc, whats: Record<string, string>, vals: Record<string, string>): string {
  const admin = doc.features.filter((f) => f.audience === 'admin');
  const self = doc.features.filter((f) => f.audience === 'self');
  return `<section id="spkpanel-features" class="spk-panel">
  ${renderTocBar([{ id: 'sec-feat-admin', label: 'Administrative', count: admin.length }, { id: 'sec-feat-self', label: 'Self-service', count: self.length }])}
  ${sectionHead('sec-feat-admin', 'Administrative features', admin.length)}
  <p class="dim">Things an administrator does to other people's accounts. "Available to" is who may use them.</p>
  ${renderFeatureJumps(admin)}
  <div class="card-grid">${admin.map((f) => renderFeatureCard(f, whats, vals)).join('')}</div>
  ${sectionHead('sec-feat-self', 'Self-service features', self.length)}
  <p class="dim">Things a signed-in user sees about their own account. Here <strong>your</strong> users are
  the subject, not you — see the Permissions tab for what each scope actually gets.</p>
  ${renderFeatureJumps(self)}
  <div class="card-grid">${self.map((f) => renderFeatureCard(f, whats, vals)).join('')}</div>
</section>`;
}

/**
 * Render one `detail` paragraph's inline markup: exactly TWO forms, `[label](https://…)` and a
 * `\`code\`` span. Block-level structure (a `### ` subheading) is `richBlock`'s job, above.
 *
 * Every other string in this file goes straight through `esc()`, and that rule is what makes a secret
 * unable to reach the page by accident. This is the single exception, so it is built to be provably safe
 * rather than conveniently safe:
 *
 *   - The string is SPLIT on the markup patterns; every text segment, every link label and every code span
 *     is `esc()`d. Nothing is ever escaped-then-unescaped, and no string reaches the output un-escaped.
 *   - Links and code spans are matched in ONE alternating pass, so neither can be produced from the other's
 *     rendered output.
 *   - The href must match `https://` followed by URL-safe characters — a whitelist, not a blocklist, so
 *     `javascript:`, `data:` and protocol-relative `//host` are refused by construction rather than by
 *     enumeration. A non-matching link renders as its plain label, so a typo degrades to text.
 *   - Every anchor gets `target="_blank" rel="noopener noreferrer"`, because these point off-site and the
 *     console is embedded in a portal whose window must not be reachable from the opened tab.
 *
 * The prose lives in `statusModel.ts` and is authored by us, never supplied by config — so this is a
 * convenience for writing readable source, not a general markdown renderer. It must not grow into one.
 */
const SAFE_HREF = /^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/;

/** `### ` prefix ⇒ a small SUBHEADING rather than a paragraph. Added because the prose was using ALL-CAPS
 *  labels ("THREE MENUS", "ONE TRAP") to do a heading's job, which reads as shouting. One derivation, read by
 *  the feature and subsystem card renderers alike, so they cannot style the same convention differently. */
export function richBlock(para: string): string {
  const HEAD = '### ';
  return para.startsWith(HEAD)
    ? `<h4 class="whyh">${richPara(para.slice(HEAD.length))}</h4>`
    : `<p>${richPara(para)}</p>`;
}

/**
 * The same two markup forms, reduced to PLAIN TEXT — for the places markup cannot go: a `title` attribute
 * and the filter's search index. Backticks were reaching both, so a description that read correctly as
 * source rendered its punctuation to the operator, and a hover tip showed markup it had no way to draw.
 * Stripping is the honest reduction: the words are all still there, only the emphasis is lost.
 */
export function plainPara(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1').replace(/`([^`]+)`/g, '$1');
}

export function richPara(text: string): string {
  let out = '';
  let rest = text;
  // ONE pass over both forms, alternating, so neither can be produced by the other's output — a two-pass
  // version would let a link's rendered markup be re-scanned for code spans, which is the shape of an
  // injection even when both halves are ours.
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    out += esc(rest.slice(0, m.index));
    if (m[3] !== undefined) {
      out += `<code>${esc(m[3])}</code>`;
    } else {
      const label = esc(m[1]!);
      out += SAFE_HREF.test(m[2]!)
        ? `<a href="${esc(m[2]!)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out + esc(rest);
}

// ── Integrations + Deployment panels ───────────────────────────────────────────────────────────────
//
// An integration OWNS its sub-aspects rather than standing beside them. Activation rules, the write rail,
// SSO, change events, offboarding and the background service identity are not peers of the app
// integration — they are parts of it, and every one is inert without its API key. Rendered as nine
// sibling cards they gave a reader no way to see that, which is why "nothing on the page says the
// NS_EVENTS_* block is app-related at all" was a fair complaint about twelve settings at once.

/**
 * `layout` decides whether the requirements/settings block is disclosed or always visible, and it is a
 * property of the COLUMN WIDTH rather than of the card.
 *
 * At full width the settings list is one or two wrapped lines — shorter than the disclosure control that
 * hides it, which costs a line of its own plus a click. And `missing`/`notes` are the ACTIONABLE part: a card
 * reading INERT should say what is absent without being asked. In a three-across grid the same list wraps to
 * five or six lines, and there the disclosure is still earning its place.
 */
function renderSubsystemCard(
  s: SubsystemCard,
  whats: Record<string, string>,
  vals: Record<string, string>,
  opts: { child?: boolean; layout?: 'full' | 'grid' } = {},
): string {
  const { child = false, layout = 'grid' } = opts;
  // A card with no settings, no missing requirements and no notes has nothing to show — rendering a
  // disclosure anyway is a control that promises detail and delivers an empty box (the OneBill and Documo
  // rows, which are not wired in and have nothing to configure).
  const hasDetail = s.settings.length > 0 || s.missing.length > 0 || s.notes.length > 0;
  const body = `<dl class="kv">
      ${missingList(s.missing)}
      <dt>Settings</dt><dd class="setrefs">${settingLinks(s.settings, whats, vals)}</dd>
      ${notesList(s.notes)}
    </dl>`;
  const detail = !hasDetail
    ? ''
    : layout === 'full'
      ? `<div class="reqs">${body}</div>`
      : `<details>
    <summary>What it needs &middot; which settings control it</summary>
    ${body}
  </details>`;
  // The explanation sits ABOVE the disclosure, not inside it: `description` is the skim line and the
  // settings list is reference, but "why does this exist, and why are there several options" is the thing a
  // reader deciding what to configure actually needs, and putting it behind a click makes it optional.
  const why = s.detail.length
    ? `<div class="why">${s.detail.map(richBlock).join('')}</div>`
    : '';
  // Every card can now be several screens tall on its own, so each carries its own way back up. Reuses the
  // same `.totop` handler the section headings use — one behaviour, not two.
  return `<div class="card${child ? ' card-child' : ''}">
  <div class="card-head">${pill(s.state)}<span class="card-name">${esc(s.name)}</span><code class="card-key">${esc(s.id)}</code><button type="button" class="totop" title="Back to the top of this tab">top</button></div>
  <p class="card-desc">${esc(s.description)}</p>
  ${why}
  ${detail}
</div>`;
}

/**
 * A roll-up of a group's children, by state.
 *
 * It exists so COLLAPSING the group costs the reader nothing they were using: the states are the thing you
 * scan an integration for, and the prose is what you open it for. Derived from the child cards themselves —
 * a hand-kept count beside the cards it summarises is the two-derivations bug this codebase keeps finding,
 * and it would be visible the moment one disagreed.
 */
function childRollup(kids: SubsystemCard[]): string {
  const order: FeatureState[] = ['misconfigured', 'inert', 'on', 'off', 'not-integrated'];
  const parts = order
    .map((st) => ({ st, n: kids.filter((k) => k.state === st).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${pill(x.st)} ${x.n}`)
    .join(' ');
  return `<span class="rollup">${kids.length} part${kids.length === 1 ? '' : 's'}</span> ${parts}`;
}

function renderIntegrations(doc: StatusDoc, whats: Record<string, string>, vals: Record<string, string>): string {
  const rows = doc.subsystems.filter((s) => s.tab === 'integration');
  const parents = rows.filter((s) => s.parent === null);
  // OPEN BY DEFAULT while only one integration has parts — nobody discovers a collapsed group they did not
  // know existed, and right now there is exactly one, so hiding it hides the whole point of the tab. Once a
  // second integration has parts, the same reasoning flips: several open groups is the wall of text collapsing
  // was for, so they close and behave as an accordion instead. Derived from the count rather than naming a
  // particular integration, so it adjusts itself when the second one lands.
  const groupsWithKids = parents.filter((p) => rows.some((k) => k.parent === p.id));
  const soleGroup = groupsWithKids.length === 1;
  const blocks = parents.map((p) => {
    const kids = rows.filter((s) => s.parent === p.id);
    const anchor = `sec-int-${p.id}`;
    if (!kids.length) return `<div class="integration" id="${esc(anchor)}">${renderSubsystemCard(p, whats, vals, { layout: 'full' })}</div>`;
    const gateNote = p.state === 'on'
      ? ''
      : `<p class="gatenote">Everything below is part of this integration and is inert while it is not configured.</p>`;
    // Collapsed by default, with the states still on the toggle. Now that every card carries several
    // paragraphs, an all-expanded tab is thousands of words before the second integration — so the default
    // is an index you can scan, and opening one is the deliberate act of reading it. `<details>` rather than
    // script, so it works identically with JS unavailable and needs no state of its own.
    return `<div class="integration" id="${esc(anchor)}">
      ${renderSubsystemCard(p, whats, vals, { layout: 'full' })}
      ${gateNote}
      <details class="kidgroup"${soleGroup ? ' open' : ''}>
        <summary>${childRollup(kids)}</summary>
        <div class="card-grid card-grid-child">${kids.map((k) => renderSubsystemCard(k, whats, vals, { child: true, layout: 'full' })).join('')}</div>
      </details>
    </div>`;
  }).join('');
  const toc = renderTocBar(parents.map((p) => ({ id: `sec-int-${p.id}`, label: p.name })));
  return `<section id="spkpanel-integrations" class="spk-panel">
  <p class="dim">External systems this deployment talks to. Each one owns its own parts${soleGroup ? ' — collapse a group once you have read it' : ' — open a group to read what its parts do and why there are several'}.</p>
  ${toc}
  ${blocks}
</section>`;
}

/**
 * The URLs this deployment serves and calls.
 *
 * The console reported which settings were SET and never what they compose into — an operator had to assemble
 * scheme + hostname + basename + ".js" in their head to get the one string they actually paste into a portal.
 * `verifiable: false` is load-bearing rather than decorative, most of all on the primary: serving it says
 * nothing whatever about whether any portal is loading it, and a page that implied otherwise would be
 * over-claiming in the one place an operator would most believe it.
 */
function renderEndpoints(doc: StatusDoc): string {
  const rows = doc.deployment.endpoints.map((e) => {
    const value = e.url
      ? `<code class="epurl">${esc(e.url)}</code>`
      : `<span class="dim">${esc(e.emptyLabel ?? 'not set')}</span>`;
    return `<div class="endpoint">
      <div class="ep-head">
        <span class="epdir epdir-${e.direction}">${e.direction === 'serves' ? 'serves' : 'calls'}</span>
        <strong>${esc(e.label)}</strong>
        ${e.verifiable ? '' : '<span class="epunver" title="This deployment cannot confirm this from inside a request.">unverifiable from here</span>'}
      </div>
      ${value}
      <p class="dim">${esc(e.what)}</p>
    </div>`;
  }).join('');
  return `<h3>Addresses</h3>
  <p class="dim">What this deployment's settings add up to. Anything marked unverifiable is a value this Worker
  serves or points at but cannot confirm from inside a request — serving the injected primary is not the same
  as a portal loading it. For the chain-loading half of that question, see what this page actually loaded,
  below.</p>
  <div class="endpoints">${rows}</div>
  ${renderObserved()}`;
}

/**
 * "What this page actually loaded" — the observed counterpart to the configured addresses above.
 *
 * Two facts, two blocks, deliberately: the endpoint rows say what this deployment is CONFIGURED to do, and
 * this says what is TRUE of the portal page the console was opened from. Folding the observation into the
 * rows would make a setting's row change meaning depending on which browser opened it.
 *
 * Filled over the bridge rather than server-rendered, because the server cannot know it: the answer lives in
 * `document.scripts` of the portal page. The console's own bundle runs there, so this was always knowable —
 * "unverifiable from here" was true of the sandboxed iframe and got mistaken for a fact about the kit.
 *
 * Rendered as a pending block rather than omitted-until-answered: a section that appears out of nowhere a
 * moment after open reads as a glitch, and if the reply never arrives the pending text is the honest state.
 */
function renderObserved(): string {
  return `<h3>What this page actually loaded</h3>
  <p class="dim">Read from the portal page this console was opened from — not from configuration. It answers
  the one question the settings cannot: whether the vendor hand-off is really on the page, and whether this
  kit is what put it there.</p>
  <div class="endpoints"><div class="endpoint" id="spkobs">
    <p class="dim" id="spkobs-txt">Asking the portal page…</p>
  </div></div>`;
}

function renderBackend(doc: StatusDoc, whats: Record<string, string>, vals: Record<string, string>): string {
  const rows = doc.subsystems.filter((s) => s.tab === 'deployment');
  // Full width, one per row — the same reasoning as an integration's parts. These cards carry several
  // paragraphs each now, and several paragraphs in a 20rem column is a ribbon. `layout: 'full'` follows from
  // it: at this width the settings list is one line, so hiding it behind a disclosure costs more than it saves.
  return `<section id="spkpanel-backend" class="spk-panel">
  <p class="dim">This Worker itself — the addresses it serves and calls, how it authenticates, and the limits
  around it. Not features, and not integrations.</p>
  ${renderEndpoints(doc)}
  <h3>Subsystems</h3>
  <div class="card-stack">${rows.map((s) => renderSubsystemCard(s, whats, vals, { layout: 'full' })).join('')}</div>
</section>`;
}

// ── Permissions panel ──────────────────────────────────────────────────────────────────────────────

/**
 * Verdict marks. Deliberately restricted to characters a system UI font actually covers: a headless render
 * showed `✔` and `✕` (Dingbats) coming out BLANK, and a verdict cell that renders as nothing reads as "no
 * answer" rather than "available" — the console being confidently unreadable instead of confidently wrong.
 * Colour is never the only signal: each cell also carries a `title` with the reason, and the legend spells
 * every mark out.
 */
const VERDICT: Record<CellVerdict, { glyph: string; label: string }> = {
  yes: { glyph: '●', label: 'available' },
  no: { glyph: '·', label: 'not allowed' },
  blocked: { glyph: '!', label: 'allowed, but blocked by a second gate' },
  inert: { glyph: '~', label: 'allowed, but not configured to run' },
  broken: { glyph: '×', label: 'cannot be evaluated — config error' },
};

/**
 * Short column headers, with the full scope name on the element's `title`.
 *
 * Not cosmetic: at the modal's real width the full names pushed the two NAMED columns — the ones that
 * carry the finding a scope column structurally cannot show — off the right edge, where a reader would
 * never scroll to find them. Abbreviating a header the legend and assumptions spell out in full costs
 * nothing; hiding the most informative columns costs the tab its point.
 */
const SCOPE_SHORT: Record<string, string> = {
  'Super User': 'Super', Reseller: 'Reseller', 'Office Manager': 'Office Mgr',
  'Site Manager': 'Site Mgr', 'Advanced User': 'Advanced', 'Basic User': 'Basic',
  'Simple User': 'Simple', 'Call Center Agent': 'CC Agent', 'Call Center Supervisor': 'CC Super',
};

/** A single cell. `title` carries the reason, so the glyph is never the only explanation available. */
/** What the configuration DID to this cell, said in words for the tooltip. */
const DELTA_WORDS: Record<'granted' | 'revoked', string> = {
  granted: 'Changed by PORTAL_FEATURES: available here, NOT available on the built-in default.',
  revoked: 'Changed by PORTAL_FEATURES: available on the built-in default, NOT available here.',
};

function renderCell(c: PermissionCell, unavailable: boolean, extra = ''): string {
  const cls = extra ? ` ${extra}` : '';
  if (unavailable) {
    return `<td class="pc pc-na${cls}" title="This level cannot be granted for this feature: it is outside the floor shown in the row.">–</td>`;
  }
  const v = VERDICT[c.verdict];
  // The row's OVERRIDDEN badge says the FEATURE was configured; this ring says which CELL the configuration
  // actually changed, and in which direction. An amber ring rather than a different fill, so the verdict
  // mark stays readable as itself and the override is a second, orthogonal signal.
  const delta = c.delta ? ` pc-delta pc-delta-${c.delta}` : '';
  const title = c.delta ? `${v.label}: ${c.why} — ${DELTA_WORDS[c.delta]}` : `${v.label}: ${c.why}`;
  return `<td class="pc pc-${c.verdict}${delta}${cls}" data-verdict="${c.verdict}"${c.delta ? ` data-delta="${c.delta}"` : ''} title="${esc(title)}">${v.glyph}</td>`;
}

function renderPermissionRow(r: PermissionRow, showNamed: boolean): string {
  // `floorBlocks` is resolved in status.ts — the level-to-scope mapping is gating semantics, not layout.
  const cells = r.cells.map((c) => renderCell(c, r.floorBlocks.includes(c.scope))).join('');
  const floorNote = r.floor
    ? `<div class="rowfloor">config may widen this no further than: ${escList(r.floor)}</div>`
    : '';
  return `<tr data-key="${esc(r.key)}">
    <th scope="row">
      <div class="rowname">${esc(r.name)}</div>
      <code class="card-key">${esc(r.key)}</code>${r.audience === 'self' ? '<span class="aud aud-self">self-service</span>' : ''}${r.source === 'PORTAL_FEATURES' ? '<span class="aud aud-override">overridden</span>' : ''}
      ${r.namedAccounts.length ? `<div class="rowfloor">gate names: ${r.namedAccounts.map((a) => `<code>${esc(a)}</code>`).join(', ')}</div>` : ''}
      ${floorNote}
    </th>
    ${cells}
    ${renderCell(r.superadmin, false, 'pc-super')}
    ${showNamed ? (r.named ? renderCell(r.named, false, 'pc-named') : '<td class="pc pc-na pc-named" title="This feature\'s gate names no specific accounts.">–</td>') : ''}
  </tr>`;
}

function renderPermissions(doc: StatusDoc): string {
  const p = doc.permissions;
  // The Named column renders ONLY when some gate names an account. An always-dash column is the same
  // dead-row defect item 18b removed from the feature cards — reintroduced here, by me, one commit later.
  // `users:` grants are the escape hatch, not the norm, so on most deployments this column should not exist.
  const showNamed = p.anyNamed;
  const colCount = p.columns.length + (showNamed ? 2 : 1);
  const head = [
    ...p.columns.map((c) => `<th scope="col" title="${esc(c)}">${esc(SCOPE_SHORT[c] ?? c)}</th>`),
    `<th scope="col" class="sacol" title="An account listed in PORTAL_SUPERADMINS, evaluated at the lowest scope">Superadmin</th>`,
    ...(showNamed ? [`<th scope="col" title="An account this feature's own gate names directly, evaluated at the lowest scope">Named</th>`] : []),
  ].join('');

  // A divider between the two audiences, driven by `audienceRank` (status.ts sorts on it) rather than by
  // registry order. The names alone do not carry the distinction — "App sign-in details on profile" and "My
  // app sign-in details" are one letter of intent apart — and a per-row ADMIN badge would be back to 18 of
  // 18, which is what got removed.
  const AUD_HEAD: Record<0 | 1, string> = {
    0: 'Administrative — what an admin does to other people&rsquo;s accounts',
    1: 'Self-service — what a signed-in user sees about their own account',
  };
  let lastRank: number | null = null;
  const body = p.rows.map((r) => {
    const divider = r.audienceRank !== lastRank
      ? `<tr class="audrow"><th scope="colgroup" colspan="${colCount + 1}">${AUD_HEAD[r.audienceRank]}</th></tr>`
      : '';
    lastRank = r.audienceRank;
    return divider + renderPermissionRow(r, showNamed);
  }).join('');

  const legend = (Object.keys(VERDICT) as CellVerdict[])
    .map((k) => `<span class="lg"><span class="pc pc-${k}">${VERDICT[k].glyph}</span> ${esc(VERDICT[k].label)}</span>`)
    .join('')
    + `<span class="lg"><span class="pc pc-yes pc-delta pc-delta-granted">${VERDICT.yes.glyph}</span> changed by your config</span>`;
  const opts = p.columns.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const sa = p.superadmins.length
    ? `<p class="dim">Named superadmins: ${p.superadmins.map((s) => `<code>${esc(s)}</code>`).join(', ')} — these accounts pass at any scope.</p>`
    : `<p class="warn">PORTAL_SUPERADMINS is empty, so the superadmin column grants nobody.</p>`;

  // `open` when there is something to show: this block existed, collapsed, and David asked for the feature
  // it already was — so its discoverability failed, not its design. An EMPTY block stays collapsed, since
  // opening one to reveal "nothing here" is worse than leaving it shut.
  const jsonBlock = (id: string, title: string, caveat: string, json: string, open = false): string => {
    if (!json) return `<details><summary>${esc(title)}</summary><p class="dim">Nothing to show — no overrides are configured.</p></details>`;
    return `<details${open ? ' open' : ''}>
      <summary>${esc(title)}</summary>
      <p class="dim">${esc(caveat)}</p>
      <button type="button" class="copy-btn" data-copy="${id}">Copy</button>
      <pre id="${id}" class="jsonblock">${esc(json)}</pre>
    </details>`;
  };

  // What is POSSIBLE, not only what this deployment does. Both emitted forms are derived from the live
  // config, so a deployment using one single-level override can only ever be shown single-level overrides —
  // three of the four gate shapes stay invisible, including the one the Named column exists to describe.
  const examples = p.examples
    .map((e, i) => `<div class="example">
      <div class="ex-head"><strong>${esc(e.title)}</strong><button type="button" class="copy-btn" data-copy="spkEx${i}">Copy</button></div>
      <p class="dim">${esc(e.what)}</p>
      <pre id="spkEx${i}" class="jsonblock">${esc(e.json)}</pre>
    </div>`)
    .join('');

  const jsonErr = p.jsonError
    ? `<p class="warn">This deployment's own validator would REFUSE the configuration below: ${esc(p.jsonError)} — that is a bug in the kit, not in your config. Do not paste it.</p>`
    : '';

  return `<section id="spkpanel-permissions" class="spk-panel">
  <p class="dim">Which of your users get what. Rows are features; columns are NetSapiens scopes.</p>

  <div class="checker">
    <label for="spkScopePick">Show one scope:</label>
    <select id="spkScopePick"><option value="">— every scope —</option>${opts}</select>
    <button type="button" id="spkScopeSuper">Named superadmin</button>
    ${showNamed ? '<button type="button" id="spkScopeNamed">Named in gate</button>' : ''}
    <p id="spkScopeSummary" class="dim"></p>
  </div>

  <div class="legend">${legend}<span class="lg"><span class="pc pc-na">–</span> cannot be granted</span></div>

  <div class="tablewrap"><table class="pmatrix">
    <thead><tr><th scope="col">Feature</th>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>

  ${sa}

  <details>
    <summary>What this evaluation assumes</summary>
    <ul class="plain">${p.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
  </details>

  <h3>Copy the configuration</h3>
  <p class="dim">A Worker cannot write its own environment, so this console cannot change these gates. It
  can hand you the exact text to paste — which was always the hard part.</p>
  ${jsonErr}
  ${jsonBlock('spkJsonOverrides', 'PORTAL_FEATURES as configured today (overrides only)',
    'Only the keys you have overridden. Everything else keeps its built-in default, including in future releases — this is the form to prefer.',
    p.jsonOverrides, true)}
  ${jsonBlock('spkJsonExplicit', 'Every feature, written out explicitly',
    'Unambiguous, but it PINS every feature: a later release that changes a built-in default will not reach a deployment using this. Prefer the overrides-only form unless you specifically want that.',
    p.jsonExplicit)}

  ${sectionHead('sec-perm-examples', 'What else you can write', p.examples.length)}
  <p class="dim">The gate vocabulary has more shapes than any one deployment uses, so the two blocks above
  can only show you what you are already doing. Every example below is checked against this deployment's own
  validator before it is shown — if one were invalid, this tab would say so rather than hand it to you.</p>
  <div class="examples">${examples}</div>
</section>`;
}

// ── Config panel ───────────────────────────────────────────────────────────────────────────────────
//
// Grouped, ordered by consequence, and with the "why can't I edit this here" explanation stated ONCE at
// the top rather than repeated verbatim on all 64 rows — where it was most of the tab's text and told the
// reader nothing about the row it was attached to.

const IMPORTANCE_ORDER: Record<SettingImportance, number> = { critical: 0, important: 1, normal: 2, minor: 3 };
const IMPORTANCE_LABEL: Partial<Record<SettingImportance, string>> = { critical: 'critical', minor: 'minor' };

function renderSettingRow(s: SettingView): string {
  // plainPara, not the raw source: a reader filtering for a phrase types the words, never the backticks
  // that mark up an identifier inside them.
  const search = esc(plainPara(`${s.name} ${s.group} ${s.kind} ${s.what}`).toLowerCase());
  const dim = !s.applicability.applicable || (s.gate !== null && !s.gate.satisfied);

  const emptyLine = `<p class="value dim">Declared in this deployment's configuration with an empty value — not absent.</p>`;
  let valueLine: string;
  if (s.kind === 'secret') {
    valueLine = s.set
      ? `<p class="value secret">value withheld — secrets never render, present or not</p>`
      : (s.source === 'env' ? emptyLine : '');
  } else if (s.value !== null) {
    // Two forms of one value, because a `wrangler.jsonc` var is a JSON STRING: the readable one to check
    // against, and the escaped one to paste. Showing only the first left an operator hand-escaping their own
    // edit, which is where a stray quote silently breaks a deploy — and it was the single most annoying thing
    // about changing one of these.
    const pretty = s.copy?.pretty ?? null;
    const wrangler = s.copy?.wrangler ?? null;
    const id = `spkw-${esc(s.name)}`;
    valueLine = (pretty
      ? `<pre class="value jsonblock">${esc(pretty)}</pre>`
      : `<p class="value"><code>${esc(s.value)}</code></p>`)
      + (wrangler
        ? `<details class="copywr">
        <summary>Copy this value for <code>wrangler.jsonc</code></summary>
        <button type="button" class="copy-btn" data-copy="${id}">Copy</button>
        <pre id="${id}" class="jsonblock">${esc(wrangler)}</pre>
      </details>`
        : '');
  } else {
    valueLine = s.source === 'env' ? emptyLine : '';
  }

  // Inline, beside the value, where someone comparing two environments will actually see it — not behind
  // the disclosure. `defaultValue` and `whenUnset` are DIFFERENT facts and only one of them is a value:
  // CACHE_SCOPE has a default ("default"); NS_SERVER has a consequence ("nothing works").
  const defaultLine = s.defaultValue !== null
    ? `<p class="deflt"><span class="dim">Default when unset:</span> <code>${esc(s.defaultValue)}</code></p>`
    : '';

  const naLine = s.applicability.why
    ? `<p class="nabox"><strong>Not applicable to this deployment.</strong> ${esc(s.applicability.why)}</p>`
    : '';
  const gateLine = s.gate && !s.gate.satisfied
    ? `<p class="nabox"><strong>Doing nothing right now.</strong> This setting only takes effect once ${settingLink(s.gate.setting)} is configured.</p>`
    : s.gate
      ? `<p class="dim gateok">Takes effect via ${settingLink(s.gate.setting)}, which is configured.</p>`
      : '';

  const impLabel = IMPORTANCE_LABEL[s.importance];
  const imp = impLabel ? `<span class="imp imp-${s.importance}">${esc(impLabel)}</span>` : '';

  // A secret renders no example: there is nothing value-shaped that belongs on a secret row at all.
  const exampleLine = s.example && s.kind !== 'secret'
    ? `<p><span class="dim">Example value:</span> <code>${esc(s.example)}</code></p>`
    : '';

  // The row is a summary of one setting; the reference is where the syntax, the worked examples and the
  // failure modes live. Linking from the row is what keeps the row short enough to scan — without it, every
  // description grows until it is a documentation page rendered inside a card.
  const docs = `<a class="doclink" href="${esc(s.docsUrl)}" target="_blank" rel="noopener noreferrer"
    title="${esc(`${s.name} in the settings reference`)}">reference &#8599;</a>`;

  return `<div class="setting-row${dim ? ' dimmed' : ''}" id="spkset-${esc(s.name)}" data-search="${search}">
  <div class="setting-head">
    ${setPill(s)}
    <code class="card-key">${esc(s.name)}</code>
    ${imp}
    <span class="dim">${esc(s.kind)}</span>
    ${docs}
  </div>
  <p class="card-desc">${richPara(s.what)}</p>
  ${valueLine}
  ${defaultLine}
  ${naLine}
  ${gateLine}
  <details>
    <summary>How to set it &middot; what happens when unset</summary>
    <p>${richPara(s.whenUnset)}</p>
    ${exampleLine}
    <pre class="howto">${esc(s.howToSet)}</pre>
    <p class="dim">Affects: ${escList(s.affects)}</p>
  </details>
</div>`;
}

/** Stated once per tab instead of 64 times. Three mechanisms, because naming the wrong one sends an
 *  operator to add a `vars` string that creates no binding while the loud 500 does not go away. */
const CONFIG_PREAMBLE = `<div class="preamble">
  <p><strong>Nothing on this tab can be edited from here.</strong> A Worker cannot write its own
  environment, and this kit has no config store (KV or D1) layered over it. Every value below is set in
  your deployment's configuration and takes effect on redeploy. Each row shows the literal line to add.</p>
  <ul class="plain">
    <li><strong>Plain settings</strong> go in <code>wrangler.jsonc</code> under this environment's
    <code>vars</code>. Vars are <strong>not inherited</strong> between environments — setting one on the
    top level does not set it for a named environment.</li>
    <li><strong>Secrets</strong> never go in <code>wrangler.jsonc</code>: use
    <code>wrangler secret put &lt;NAME&gt; --env &lt;environment&gt;</code>. This console can only report
    whether a secret is present — a Worker cannot read one back, and a length or a prefix would be a
    guessing oracle rather than information.</li>
    <li><strong>Bindings</strong> (the Worker-bindings group) are structural entries in
    <code>wrangler.jsonc</code>, not strings. Adding a var with a binding's name creates nothing.</li>
  </ul>
  <p class="dim">Every row links to its full entry in
  <a href="${DOCS_BASE}" target="_blank" rel="noopener noreferrer">the settings reference</a>, which carries
  the syntax, worked examples and failure modes a card has no room for.</p>
</div>`;

/**
 * One Config group, collapsed.
 *
 * 64 settings in 12 sections is too long to be useful as a flat page, so each group is a `<details>` and the
 * tab opens as a 12-item index. Exclusivity (opening one closes the others) is done in `script()` rather than
 * with the native `name=` attribute, because the FILTER has to be able to open several at once — a filter
 * that matched rows in three groups while the browser enforced one-open-at-a-time would silently show a
 * third of its results.
 *
 * The `id` sits on the `<details>`, so a jump from another tab can scroll to it AND open it.
 *
 * The "top" control moved to the END of the section rather than into the summary: a button inside a
 * `<summary>` fights the toggle for the click, and the bottom of a long section is where you actually want it.
 */
function renderConfigGroup(group: SettingGroup, rows: SettingView[]): string {
  if (!rows.length) return '';
  const sorted = [...rows].sort((a, b) => IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance]);
  return `<details class="cfggroup cfgsec" id="sec-cfg-${esc(group)}" data-group="${esc(group)}">
    <summary><span class="secname">${esc(GROUP_LABEL[group])}</span> <span class="dim">${rows.length}</span>
      <span class="secblurb dim">${richPara(GROUP_BLURB[group])}</span></summary>
    <div class="setting-list">${sorted.map(renderSettingRow).join('')}</div>
    <p class="secfoot"><a href="${esc(groupDocsUrl(group))}" target="_blank" rel="noopener noreferrer">${esc(GROUP_LABEL[group])} in the settings reference &#8599;</a></p>
    <button type="button" class="totop seclast" title="Back to the top of the page">back to top</button>
  </details>`;
}

// ── Menus panel: what the config does now, and a builder that composes the next one ──────────────────
//
// The one capability that works with no other integration, so it is where a new deployment starts — and
// the one whose config is most annoying to hand-write, because `wrangler.jsonc` wants the JSON as an
// escaped string. Hence a builder rather than more prose about the shape.
//
// Two halves, deliberately separate. CURRENT STATE is server-rendered from `doc.menus`: it is a fact about
// the deployment and it renders with no script, no bridge and no portal. THE BUILDER is client-side and
// starts empty until the portal page answers, because its whole value is working from the REAL menu
// entries rather than a mock-up — a mock-up would be wrong for every portal but ours, and hiding an entry
// means naming a label only that portal knows.
function renderMenus(doc: StatusDoc): string {
  const m = doc.menus;

  const err = m.error
    ? `<div class="mnote mbad"><strong>This menu config is not valid, so none of it is being applied.</strong> ${esc(m.error)}</div>`
    : '';

  // VALID AND STILL WRONG. Distinct from the error above and rendered as loudly, because it is the state
  // an operator cannot discover any other way: the deployment accepts the config, serves it, reports no
  // problem, and some of what they wrote reaches nobody at all.
  const dead = m.unreachable.length
    ? `<div class="mnote mbad"><strong>Some of this config reaches nobody.</strong> It is valid and this
       deployment is serving it — but a default applies only to readers no group names, and these groups
       already name everyone.<ul class="plain">${m.unreachable.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></div>`
    : '';

  // ⚠️ "WHAT YOUR CONFIG DOES NOW" IS GONE, deliberately (David, 2026-08-10). It was a server-rendered
  // card per menu, resolved at ONE fictional rung — a domain no config names, no app, no scope — which is
  // why every targeted card had to carry a paragraph apologising that what it showed was not the config.
  // The builder answers the same question at a rung the reader CHOOSES, so keeping both meant a screen of
  // scrolling before the better answer, saying a weaker version of it.
  //
  // What that section carried and this does not: a view with no JavaScript. The raw value is still
  // server-rendered on the Config tab, which is the honest split — the raw config there, its
  // interpretation here. The merged-apps-hide note went with it: "both settings are set and they merge"
  // is already told by the setup warning and by the Features menus card, and the per-audience answer is
  // now a tag on the row itself.
  const unset = m.configured ? '' : '<p class="dim">Nothing is configured yet, so every menu is exactly as the portal ships it. The builder below is the quickest way to change that.</p>';

  return `<section id="spkpanel-menus" class="spk-panel">
  <p class="dim">Adding entries to the portal's menus, and hiding stock ones you do not offer. This needs no
  other integration — with nothing else configured at all, add and hide still work.</p>
  ${err}
  ${dead}
  ${unset}
  <h3>Builder</h3>
  <p class="dim">Pick who you are previewing as, and each menu below is drawn the way that person would see
  it — stock entries struck through where your config hides them, your own entries in place. Edit the
  picture; the config composes itself. Nothing here changes anything until you paste the result, and it is
  checked by this deployment's own validator rather than by a second copy of the rules.</p>
  <p class="mnote"><strong>It sees one page, as one person</strong> — and a hide matches the label exactly.
  The account menu relabels itself by context: while you are managing a domain it reads <em>My Account</em>
  and <em>Messages</em>, and inside your own account the same menu reads <em>Profile</em>. One menu, different
  labels, and the same both ways for a reseller and an office manager. So an entry you hide here can reappear
  elsewhere under another name. Tick it here and add the other label by hand — listing a label that never
  appears is harmless, since a hide that matches nothing changes nothing.</p>
  <div id="spkmb">
    <!-- THE PERSONA BAR — the one global control. Everything below answers "what would THIS person see",
         which is the question an operator actually has; the rules that produce it are behind each card.
         Scope is a picker because a reader has exactly one. Apps are TOGGLES because two can be active at
         once, and a tab or a radio would hide one that is live. -->
    <div class="persona" id="spkmb-persona">
      <div><label for="spkmb-scope">Previewing as</label>
        <select id="spkmb-scope"></select></div>
      <!-- "Integrations", not "Apps" (David, 2026-08-11) — an operator reading this page thinks in
           integrations, and "Apps" collides with the Apps MENU three inches below it, which is a
           different thing entirely. The config key stays app, and anywhere this console echoes the key
           it still says app: a label may speak the reader's language, but a value they have to type
           must be the value. -->
      <div id="spkmb-appswrap"><label>Integrations active</label><div class="toggles" id="spkmb-apps"></div></div>
      <div><label for="spkmb-domain">Domain <span class="lc">(optional)</span></label>
        <div class="domwrap"><input id="spkmb-domain" placeholder="a domain your config names"><span id="spkmb-domclear"></span></div>
        <span id="spkmb-domnote"></span></div>
    </div>
    <p class="mnote" id="spkmb-capture"></p>
    <p class="mnote" id="spkmb-caveat" hidden></p>
    <p class="dim" id="spkmb-status">Asking the portal page for its menus…</p>
    <p><button type="button" class="copy-btn" id="spkmb-reset">Reset to the running config</button>
       <span class="dim">Discards this session's edits. Not "reset to empty" — empty is a config too, and a
       destructive one.</span></p>
    <!-- TWO COLUMNS. The menus are what you read; what changed and which rules exist are what you check
         against, and they were previously a second screenful below. The rail is bound to the menus by
         naming each one — an unbound rail is the lost-track failure moved one column right. -->
    <div class="cols">
      <div id="spkmb-menus"></div>
      <div class="rail">
        <p class="railh">Changed this session</p>
        <div class="box" id="spkmb-changed"></div>
        <p class="railh">Rules</p>
        <div class="box" id="spkmb-rules"></div>
        <p class="railh">Output</p>
        <div class="box">
          <p><button type="button" class="copy-btn" data-copy="spkmb-wr">Copy the wrangler line</button></p>
          <p id="spkmb-verdict" class="mnote"></p>
          <p class="dim">The complete config, not a diff — every menu you did not touch, exactly as it is
          running now. The readable form is below.</p>
        </div>
      </div>
    </div>
    <div id="spkmb-out" hidden>
      <h4 class="whyh">The config</h4>
      <!-- ABOVE the output rather than below it (David): collapsed either way, but a reader scrolls to
           the config and stops there, so a reference underneath is one nobody knows exists. It costs a
           line here and buys the chance of being noticed. -->
      ${menuSchema()}
      <p class="dim">Two forms of the same thing. The escaped one is what <code>wrangler.jsonc</code> wants,
      since a JSON value has to be embedded there as a string.</p>
      <p class="mnote"><strong>This is the complete config, not a diff.</strong> It replaces
      <code>PORTAL_MENUS</code> in full, so it carries every menu you did not touch exactly as it is running
      now — pasting it changes only what you changed here. A half whose shape this editor cannot round-trip
      is passed through byte for byte and shown, read-only, on its own menu.</p>
      <p class="dim">For <code>wrangler.jsonc</code> — the line to paste
      <button type="button" class="copy-btn" data-copy="spkmb-wr">Copy</button></p>
      <pre id="spkmb-wr" class="jsonblock"></pre>
      <!-- Collapsible but OPEN: it is what you check before pasting, so it earns its space by default —
           the reference above it is the opposite case and stays shut. Both fold, so neither is a wall. -->
      <details class="schema" open>
        <summary>Readable JSON, for checking what you are about to paste</summary>
        <p class="dim"><button type="button" class="copy-btn" data-copy="spkmb-json">Copy</button></p>
        <pre id="spkmb-json" class="jsonblock"></pre>
      </details>
    </div>
  </div>
</section>`;
}

/**
 * EVERY KEY AND EVERY LEGAL VALUE, in one annotated shape.
 *
 * The builder composes this for you, which is why this sits below the fold rather than above it — but a
 * config is a text file an operator edits by hand at 2am when the console is not the fastest route, and
 * until now nothing anywhere said what the whole vocabulary IS. `CONFIG.md` explains the model in prose;
 * this is the shape, with the legal values in it.
 *
 * ⚠️ GENERATED FROM THE MODULES THAT VALIDATE, never typed out here: menu names, axis names, the scope
 * list, the app names and their reserved keys, the variables. A hand-written reference is one that
 * disagrees with the parser eventually, and the disagreement is invisible until someone writes the
 * config it describes and the deployment refuses it at boot.
 *
 * Annotated, so NOT valid JSON as written — said plainly, because a block that looks pasteable and is not
 * is worse than one that obviously is not.
 */
function menuSchema(): string {
  const q = (xs: readonly string[]): string => xs.map((x) => `"${x}"`).join(' | ');
  /**
   * Wrap across comment lines, breaking ONLY at the given separator. A list that runs off the right edge
   * of a scrolling block is a list nobody reads, which is the one thing this section exists to provide —
   * but wrapping on plain spaces split a multi-word scope down the middle, so the break points have to be
   * the separators between values, not the spaces inside them. (The derivation guard in the selftest
   * then flagged the scope I had named in this very comment, which is the guard working.)
   */
  const wrap = (parts: string[], sep: string, indent: string, width = 82): string[] => {
    const out: string[] = [];
    let line = '';
    for (const part of parts) {
      if (line && (line + sep + part).length + indent.length > width) { out.push(indent + line + sep.trimEnd()); line = part; }
      else line = line ? line + sep + part : part;
    }
    if (line) out.push(indent + line);
    return out;
  };
  // name, one line about it, and the legal values it accepts (empty ⇒ free text).
  const axes: [string, string[], readonly string[]][] = [
    ['users', ['one account, as user@domain — the most specific axis there is:',
      'a rule naming an account beats one naming their domain.'], []],
    ['domains', ['one NetSapiens domain, matched exactly.',
      'Beats scope and app rules for that domain.'], []],
    ['scopes', ['one NS scope, matched exactly:'], KNOWN_SCOPES],
    ['app', ['whether an integration is active. A UNION: every rule whose app is',
      'active contributes and their lists merge.'], [...APP_NAMES, ...APP_RESERVED]],
  ];
  const lines = [
    '{',
    `  // One key per menu: ${q(MENU_NAMES)}. Anything else is refused at startup.`,
    '  "apps": {',
    '',
    '    // HIDE — stock entries to remove, by their exact visible label.',
    '    // Either a plain array (applies to everyone) or an object targeting one axis.',
    '    "hide": ["SNAPmobile Web"],',
    '',
    '    // ADD — your own entries. label and url required, title optional. https:// or mailto: only.',
    '    "add": [{ "label": "Support", "url": "https://help.example/x", "title": "Opens a new tab" }]',
    '  },',
    '',
    '  // The same two keys, TARGETED. NARROWEST SELECTOR WINS:',
    '  //   users → domains → scopes → app → "*"',
    '  // The narrowest rule that matches the reader answers on its own — lists are never merged across',
    '  // axes, so a domain rule REPLACES what a scope rule would have given that reader rather than',
    '  // adding to it. A "*" inside an axis is that axis\u2019s own catch-all: it answers only for',
    '  // readers no specific key in that axis matched.',
    '  // EVERY KEY IS OPTIONAL, including this whole object. A menu you do not name keeps the portal\u2019s',
    '  // own; a half you do not name changes nothing; and there is no rule that another key has to be',
    '  // present for. The "*" below is a catch-all you write only if you want one.',
    '  "account": {',
    '    "add": {',
    // The value lists get their own lines above the key rather than trailing it: as a trailing comment
    // the scopes list ran past the right edge of the block, and a legal-values list you have to scroll
    // sideways to finish reading is the one thing this section is here to avoid.
    ...axes.flatMap(([name, what, values]) => [
      ...what.map((w) => `      // ${w}`),
      ...(values.length ? wrap(values.map((v) => `"${v}"`), ' | ', '      //   ') : []),
      `      "${name}": { "<key>": [] },`,
      '',
    ]),
    '      // Optional, like everything else. Present and EMPTY is not the same as absent: absent means',
    '      // those readers fall through to nothing in particular, while [] is a deliberate "these',
    '      // readers get none" — which is how you exempt an audience from a rule that would name them.',
    '      "*": []',
    '    }',
    '  }',
    '}',
  ];
  const vars = MENU_VARS.map((v) => `<code>{${v}}</code> ${esc(MENU_VAR_HELP[v])}`).join(' · ');
  return `<details class="schema"><summary>Every key and legal value, annotated</summary>
  <p class="dim">The builder above composes all of this. This is for reading the config by hand — the
  shape, with the values this deployment actually accepts. It carries comments, so it is <strong>not
  valid JSON as written</strong>.</p>
  <pre class="jsonblock">${esc(lines.join('\n'))}</pre>
  <p class="dim"><strong>Variables</strong>, usable in a label, url or title: ${vars}. Values are
  per signed-in user and percent-encoded in a url; a variable may not appear in the host.</p>
  <p class="dim">An unknown menu name, scope, app key or variable is a <strong>startup error</strong>, not
  a rule that silently never matches — so a typo fails loudly rather than going quiet.</p>
</details>`;
}

function renderConfig(doc: StatusDoc): string {
  const groups = GROUP_ORDER.map((g) => renderConfigGroup(g, doc.settings.filter((s) => s.group === g))).join('');
  // Every group in GROUP_ORDER is rendered above; anything whose group is somehow not listed would
  // otherwise vanish silently, so sweep for it rather than trust the list.
  const listed = new Set<string>(GROUP_ORDER);
  const orphans = doc.settings.filter((s) => !listed.has(s.group));
  const orphanBlock = orphans.length
    ? `<details class="cfggroup cfgsec" id="sec-cfg-ungrouped"><summary><span class="secname">Ungrouped</span> <span class="dim">${orphans.length}</span></summary><div class="setting-list">${orphans.map(renderSettingRow).join('')}</div></details>`
    : '';
  // The jump bar covers only groups that actually rendered — an entry pointing at an absent heading would
  // be the console offering navigation to nothing.
  const toc = renderTocBar(
    GROUP_ORDER
      .map((g) => ({ g, n: doc.settings.filter((s) => s.group === g).length }))
      .filter((x) => x.n > 0)
      .map((x) => ({ id: `sec-cfg-${x.g}`, label: GROUP_LABEL[x.g], count: x.n })),
  );
  return `<section id="spkpanel-config" class="spk-panel">
  <div id="spkBackBar" class="backbar"><button type="button" class="backbtn" id="spkBackBtn"></button></div>
  ${CONFIG_PREAMBLE}
  <div class="filterwrap">
    <input type="search" id="spkConfigFilter" class="filter" placeholder="Filter settings by name, group, or description…" autocomplete="off">
    <button type="button" id="spkFilterClear" class="filterclear" title="Clear the filter (Esc)" aria-label="Clear the filter">&times;</button>
  </div>
  ${toc}
  ${groups}${orphanBlock}
</section>`;
}

// ── Checks panel: renders doc.probes when present, otherwise explains the checks and offers to run them
//
// The not-run rows are rendered FROM `PROBE_CATALOG` — the same table `runProbes` (statusProbes.ts) drives
// every result from. A second, hand-written list of "what the checks are" used to live here, and it had
// drifted into describing three checks that were not the six that run: it promised a live `/jwt`
// verification probe that does not exist, described the NetSapiens read as using the background service
// credential when it actually uses the caller's own delegated `ns_t`, and omitted the two probes that mint
// tokens and list every subscription on the account — i.e. it hid the expensive ones on the very panel
// whose job is informed consent before making live calls against production. One catalog, two readers.

/**
 * A probe's per-item detail, collapsed. Collapsed because the useful ones are LONG — the subscription
 * table is one row per monitored domain — and a reader opening the Checks tab is asking for six verdicts,
 * not for a fleet listing they have to scroll past to reach the next one.
 *
 * Every cell is upstream data (domain names come from NetSapiens), so it is escaped here and built with
 * textContent in the client-side twin below. Neither path ever hands one to innerHTML.
 */
function renderProbeTable(t: ProbeTable): string {
  if (!t.rows.length) return '';
  const head = t.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('');
  const body = t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  const note = t.note ? `<p class="dim">${esc(t.note)}</p>` : '';
  return `<details class="probetable"><summary>${esc(t.caption)}</summary>
    <div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${note}</details>`;
}

function renderProbeRow(p: ProbeResult): string {
  const cls: FeatureState = p.state === 'pass' ? 'on' : p.state === 'fail' ? 'misconfigured' : 'off';
  const label = p.state === 'pass' ? 'PASS' : p.state === 'fail' ? 'FAIL' : 'SKIP';
  const table = p.table ? renderProbeTable(p.table) : '';
  return `<div class="check-row"><span class="pill pill-${cls}">${label}</span><strong>${esc(p.name)}</strong><p>${esc(p.detail)}</p><p class="dim">${esc(p.cost)}</p>${table}</div>`;
}

function renderNotRunRow(c: ProbeCatalogEntry): string {
  return `<div class="check-row"><span class="pill pill-off">NOT RUN</span><strong>${esc(c.name)}</strong><p>${esc(c.what)}</p><p class="dim">${esc(c.cost)}</p></div>`;
}

// The intro must not characterize the SET of checks: it used to say "each check below is a live network
// call" directly above two rows whose own `cost` reads "No network call" (`access`, which cannot be probed
// from inside a request, and `onebill-documo`, which is not integrated). A count or an adjective here is a
// second derivation of the catalog that drifts the moment a row is added — and this panel exists for
// informed consent, which a claim the rows beneath it contradict actively damages. So the intro points at
// each row's own declared cost, which IS the catalog, and states only what is true of every row.
//
// 2026-08-08, reversed deliberately: checks now run automatically the FIRST time this tab is opened in a
// given modal instance (see `autoRan` in `script()` below) — "these never run automatically" would be
// false the instant that fires. The on-demand rationale (probes cost upstream calls) still holds for the
// CONSOLE — nothing runs at page load — but opening the Checks tab is itself the deliberate ask on an
// already superadmin-gated page, so asking a second time added friction, not consent. `notRun` is only
// what a reader sees for the instant before the auto-run fires (or if it can't — e.g. JS disabled, in
// which case the button is still there and nothing runs on its own).
// Exported for statusPage.selftest.ts, so the test that proves the client-side update writes THIS exact
// sentence never needs its own hand-typed copy — a copy is precisely how the earlier bug (the stale
// server-rendered intro) went unnoticed by every test that only checked the initial `statusHtml()` output.
export const CHECKS_INTRO_TEXT = {
  notRun: 'Nothing has been run yet. Opening this tab runs them once, automatically — use Run Checks Again to run them again. Each row below states what the check does — against which system, with which credential — and what running it costs.',
  // The text shown WHILE a run is in flight — client-side only; there is no server-rendered "running"
  // state (the server never knows a run is mid-flight; it only ever renders not-run or complete). Says
  // what is happening because the six probes are sequential live calls: on a slow or broken deployment
  // this can take real seconds, and a tab that just sits there looks frozen, not busy.
  running: 'Running the checks now, one at a time — this can take several seconds, longer if a system is slow or unreachable. Each row below states what that check does and what it costs; results replace them when the run finishes.',
  // Also the text a live run switches TO, client-side — see script() below. Keeping both strings here, read
  // by both the server render and the client script from the SAME object, is what makes drift structurally
  // impossible: there is exactly one place that knows what "already ran" reads like.
  ranAlready: 'Results from the last run. Run again any time — the checks also ran automatically the first time this tab was opened. Each row states what that check does and what running it costs.',
};

// `id="spkChecksIntro"` is the seam script()'s message handler (and its auto-run trigger) update after a
// live run — the results below it are injected client-side (the page is a sandboxed iframe with no
// network; the PARENT frame makes the actual call and posts the results in, see the probe bridge doc
// comment near script()), but this paragraph was server-rendered once, from whatever `doc.probes` was at
// PAGE LOAD — always null for a fresh modal, since a run only ever starts once the Checks tab is opened,
// never at load. Left alone, the "nothing has been run yet" claim would sit there, provably false,
// directly above completed rows the moment a run finished. Deriving it from `doc.probes !== null`
// (below) is necessary but not sufficient — the fix has to reach the client-side update too, which is why
// this element carries an id and script() writes the SAME `CHECKS_INTRO_TEXT.ranAlready` string into it.
function checksIntro(hasRun: boolean): string {
  return `<p class="dim" id="spkChecksIntro">${esc(hasRun ? CHECKS_INTRO_TEXT.ranAlready : CHECKS_INTRO_TEXT.notRun)}</p>`;
}

// The button label is a claim about state, same as the intro paragraph above it — a button that still
// reads "Run Checks" above a tab full of results implies, by omission, that nothing has run yet. That is
// the identical defect CHECKS_INTRO_TEXT exists to prevent, just carried in a control instead of a
// sentence, so it is derived from the SAME `hasRun` fact, not a second hand-typed judgement call.
const RUN_BTN_LABEL = { notRun: 'Run Checks', ranAlready: 'Run Checks Again' };

function renderChecks(doc: StatusDoc): string {
  const hasRun = doc.probes !== null;
  const body = hasRun
    ? doc.probes!.map(renderProbeRow).join('')
    : probeCatalogFor().map(renderNotRunRow).join('');
  // The button sits ABOVE the rows, not below them — a reader who opens this tab must be able to tell
  // there is an action available without first scrolling past the explainer/result rows.
  const btnLabel = hasRun ? RUN_BTN_LABEL.ranAlready : RUN_BTN_LABEL.notRun;
  return `<section id="spkpanel-checks" class="spk-panel">
  <button id="spkRunChecks" class="run-btn" type="button">${esc(btnLabel)}</button>
  ${checksIntro(hasRun)}
  <div id="spkChecksResults" class="check-list">${body}</div>
</section>`;
}

// ── style ──────────────────────────────────────────────────────────────────────────────────────────

const STYLE = `
:root { color-scheme: light dark; --fg:#1e293b; --dim:#64748b; --bg:#f8fafc; --card:#fff; --line:#e2e8f0;
        --red:#b91c1c; --amber:#b45309; --blue:#1a6bb0; --green:#15803d; --grey:#94a3b8; }
@media (prefers-color-scheme: dark) { :root { --fg:#e2e8f0; --dim:#94a3b8; --bg:#0f172a; --card:#1e293b;
        --line:#334155; --red:#f87171; --amber:#fbbf24; --blue:#5b8bc0; --green:#4ade80; --grey:#64748b; } }
* { box-sizing:border-box; }
html, body { max-width:100%; overflow-x:hidden; }
body { margin:0; padding:1rem 1rem 2.5rem; background:var(--bg); color:var(--fg);
       font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:70rem; margin:0 auto; }
code { background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:.05rem .3rem; font-size:.9em; word-break:break-word; }
a { color:var(--blue); }
h1 { font-size:1.25rem; margin:0; }
h3 { font-size:.95rem; margin:1.4rem 0 .35rem; }
.dim { color:var(--dim); }
.warn { color:var(--amber); font-weight:600; }
.spk-header { border-bottom:1px solid var(--line); padding-bottom:.75rem; margin-bottom:.75rem; }
.title-row { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
.ver { font-weight:400; color:var(--dim); font-size:.85em; }
a.ver { color:var(--blue); text-decoration:none; }
a.ver:hover { text-decoration:underline; }
/* Part of the title, so it keeps the heading's weight — but set in the dim colour so the product name still
   reads first. */
.subtitle { color:var(--dim); }
.meta { color:var(--dim); font-size:.85rem; margin-top:.35rem; display:flex; flex-wrap:wrap; gap:.3rem; }
.meta .sep { opacity:.5; }
.envbadge { font-weight:700; font-size:.75rem; letter-spacing:.04em; padding:.15rem .5rem; border-radius:5px;
            border:1px solid var(--line); }
.envbadge-prod { color:#fff; background:var(--red); border-color:var(--red); }
.envbadge-dev { color:#fff; background:var(--amber); border-color:var(--amber); }
.envbadge-local { color:var(--dim); background:transparent; }
.envbadge-unknown { color:var(--dim); background:transparent; }
.spk-tabin { position:absolute; opacity:0; pointer-events:none; }
.spk-tabbar { display:flex; gap:.35rem; flex-wrap:wrap; margin-bottom:1rem; }
.spk-tabbar label { cursor:pointer; padding:.4rem .8rem; border-radius:6px 6px 0 0; border:1px solid var(--line);
                     border-bottom:none; color:var(--dim); font-size:.85rem; font-weight:600; background:var(--card); }
.spk-panel { display:none; }
__TABCSS__
/* align-items:start so opening one card's disclosure cannot stretch its whole grid row and shove the
   cards beside it around. Expanding a card the reader IS looking at must not move the ones they are not. */
.card-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(20rem, 1fr)); gap:.75rem; align-items:start; }
.card, .setting-row { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.85rem 1rem; }
.setting-row { margin-bottom:.6rem; }
.card-head, .setting-head { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
.card-name { font-weight:600; }
.card-key { font-size:.75em; }
.card-desc { margin:.4rem 0 0; color:var(--dim); }
.integration { margin-bottom:1.4rem; }
/* An integration's parts are a LIST to read top to bottom, not a grid of peers to scan: they are aspects of
   one thing, in a deliberate order, and three-across made that read as nine unrelated boxes. Full width also
   resolves the expansion complaint — the settings links fit on one line, so opening a card grows it by a
   line or two instead of by the height of a wrapped list. */
.card-stack { display:grid; grid-template-columns:1fr; gap:.6rem; align-items:start; }
.card-grid-child { display:grid; grid-template-columns:1fr; margin-top:.6rem; margin-left:1.25rem; gap:.5rem; }
.card-child { background:transparent; }
/* With the full width available, the label/value pairs inside a child card can sit side by side rather than
   stacking. */
.card-child dl.kv { grid-template-columns:max-content 1fr; }
.gatenote { margin:.5rem 0 0 1.25rem; color:var(--amber); font-size:.85rem; }
.counts { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; margin:.3rem 0 0; }
dl.kv { display:grid; grid-template-columns:auto 1fr; gap:.25rem .75rem; margin:.6rem 0 0; }
dl.kv dt { color:var(--dim); font-size:.85em; }
dl.kv dd { margin:0; }
ul.plain { list-style:none; margin:0; padding:0; }
ul.plain li { margin:.25rem 0; }
.issues .issue { border-left:3px solid var(--line); padding:.4rem 0 .4rem .6rem; margin-bottom:.5rem; }
.issue.blocker { border-left-color:var(--red); }
.issue.warning { border-left-color:var(--amber); }
.issue .t { font-weight:600; display:flex; gap:.5rem; align-items:baseline; }
.issue p { margin:.25rem 0 0; color:var(--dim); }
.issue p.fix { color:var(--fg); }
.tag { font-size:.65rem; text-transform:uppercase; letter-spacing:.04em; padding:.1rem .4rem;
       border-radius:4px; border:1px solid var(--line); color:var(--dim); font-weight:600; }
.tag.blocker { color:var(--red); border-color:var(--red); }
.tag.warning { color:var(--amber); border-color:var(--amber); }
.pill { display:inline-block; font-size:.65rem; font-weight:700; letter-spacing:.03em; padding:.15rem .45rem;
        border-radius:4px; border:1px solid transparent; white-space:nowrap; }
.pill-on { color:#fff; background:var(--green); }
.pill-off { color:var(--dim); background:transparent; border-color:var(--line); }
.pill-inert { color:#000; background:var(--amber); }
.pill-misconfigured { color:#fff; background:var(--red); }
.pill-not-integrated { color:var(--dim); background:transparent; border-color:var(--dim); border-style:dashed; }
.imp { font-size:.62rem; text-transform:uppercase; letter-spacing:.05em; font-weight:700; padding:.1rem .35rem;
       border-radius:3px; border:1px solid currentColor; }
.imp-critical { color:var(--red); }
.imp-minor { color:var(--dim); }
/* Pushed to the far end of the head row so it never sits between the name and its state, and left dim: it is
   a way out of the page, not a thing to read on the way down it. */
.doclink { margin-left:auto; font-size:.72rem; color:var(--dim); text-decoration:none; white-space:nowrap; }
.doclink:hover { color:var(--blue); text-decoration:underline; }
.secfoot { margin:0 .8rem .6rem; font-size:.8rem; }
details { margin-top:.6rem; }
details summary { cursor:pointer; color:var(--blue); font-size:.85rem; }
.filterwrap { position:relative; margin-bottom:.75rem; }
.filter { width:100%; padding:.5rem 2.1rem .5rem .65rem; border:1px solid var(--line); border-radius:6px;
          background:var(--card); color:var(--fg); font-size:.9rem; }
/* Ours, not the browser's: type=search gives WebKit a clear button and gives Firefox nothing, so relying on
   the native one means the affordance exists for some readers and not others. Suppress it and draw our own. */
.filter::-webkit-search-cancel-button { -webkit-appearance:none; appearance:none; }
.filterclear { position:absolute; right:.4rem; top:50%; transform:translateY(-50%); display:none;
        border:0; background:transparent; color:var(--dim); font-size:1.15rem; line-height:1; cursor:pointer;
        padding:.15rem .35rem; border-radius:4px; }
.filterclear.on { display:block; }
.filterclear:hover { color:var(--fg); background:var(--bg); }
.value code { display:inline-block; max-width:100%; overflow-wrap:break-word; }
.value.secret { color:var(--dim); font-style:italic; }
.deflt { margin:.25rem 0 0; font-size:.9em; }
.jsonblock, .howto { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:.5rem .65rem;
        overflow-x:auto; font-size:.8rem; margin:.4rem 0 0; white-space:pre; }
.nabox { margin:.4rem 0 0; padding:.4rem .6rem; border-left:3px solid var(--amber); background:var(--bg);
         font-size:.9em; }
.gateok { margin:.3rem 0 0; font-size:.85em; }
/* Dimmed, not hidden: "not applicable here, and why" is information; silence is not. */
.setting-row.dimmed { opacity:.62; }
.setting-row.dimmed:hover, .setting-row.dimmed:focus-within { opacity:1; }
.preamble { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.85rem 1rem;
            margin-bottom:.9rem; font-size:.9rem; }
.preamble p { margin:0 0 .5rem; }
.setref { background:var(--bg); border:1px solid var(--line); border-radius:4px; color:var(--blue);
          font:inherit; font-size:.8rem; padding:.1rem .35rem; cursor:pointer; }
.setref:hover { border-color:var(--blue); }
.setrefs { display:flex; flex-wrap:wrap; gap:.25rem; }
.hilite { outline:2px solid var(--blue); outline-offset:2px; }
.checker { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.7rem .9rem;
           margin-bottom:.75rem; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
.checker select, .checker button { font:inherit; font-size:.85rem; padding:.25rem .5rem; border-radius:5px;
           border:1px solid var(--line); background:var(--bg); color:var(--fg); }
.checker button { cursor:pointer; }
.checker #spkScopeSummary { flex:1 1 100%; margin:.35rem 0 0; }
.legend { display:flex; gap:.9rem; flex-wrap:wrap; font-size:.8rem; color:var(--dim); margin-bottom:.5rem; }
.legend .lg { display:flex; align-items:center; gap:.3rem; }
.tablewrap { overflow-x:auto; border:1px solid var(--line); border-radius:8px; background:var(--card); }
table.pmatrix { border-collapse:collapse; width:100%; font-size:.8rem; }
table.pmatrix th, table.pmatrix td { border-bottom:1px solid var(--line); padding:.35rem .45rem; text-align:left; }
table.pmatrix thead th { background:var(--card); font-size:.7rem; text-transform:uppercase;
        letter-spacing:.02em; color:var(--dim); white-space:nowrap; padding:.4rem .3rem; }
table.pmatrix tbody th { font-weight:400; min-width:11rem; }
table.pmatrix .rowname { font-weight:600; }
table.pmatrix td.pc { text-align:center; font-size:1rem; width:2rem; padding:.35rem .2rem; }
.pc-yes { color:var(--green); }
.pc-no { color:var(--grey); }
.pc-blocked { color:var(--amber); }
.pc-inert { color:var(--amber); }
.pc-broken { color:var(--red); }
.pc-na { color:var(--grey); opacity:.45; }
.sacol { border-left:2px solid var(--line); }
table.pmatrix td.colhi { background:color-mix(in srgb, var(--blue) 14%, transparent); }
.aud { font-size:.6rem; text-transform:uppercase; letter-spacing:.04em; padding:.05rem .3rem; border-radius:3px;
       border:1px solid var(--line); color:var(--dim); margin-left:.3rem; }
.aud-self { border-color:var(--blue); color:var(--blue); }
.aud-override { border-color:var(--amber); color:var(--amber); }
.rowfloor { color:var(--dim); font-size:.72rem; margin-top:.15rem; }
.copy-btn, .run-btn { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:5px;
                       padding:.2rem .6rem; font:inherit; font-size:.8rem; cursor:pointer; }
.run-btn { margin-top:.25rem; }
.check-row { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.7rem .9rem; margin-bottom:.6rem; }
.check-row strong { display:block; margin:.2rem 0 .1rem; }
.check-row p { margin:.15rem 0 0; color:var(--dim); }
.probetable table { border-collapse:collapse; width:100%; font-size:.8rem; }
.probetable th, .probetable td { border-bottom:1px solid var(--line); padding:.3rem .45rem; text-align:left;
                                 white-space:nowrap; }
.probetable thead th { font-size:.7rem; text-transform:uppercase; letter-spacing:.04em; color:var(--dim); }
.probetable tbody tr:last-child td { border-bottom:0; }
.spk-footer { margin-top:1.5rem; border-top:1px solid var(--line); padding-top:.75rem; color:var(--dim); font-size:.85rem; }
.credits { margin:.6rem 0 0; }
/* item 31: the "why does this exist" prose. Readable measure even in a full-width card — long lines of body
   text are hard to track back to the start of the next one, which is the whole reason the cards went full
   width in the first place. */
.card-head .totop { margin-left:auto; }
details.cfgsec { margin:0 0 .5rem; border:1px solid var(--line); border-radius:8px; background:var(--card); }
details.cfgsec > summary { padding:.6rem .8rem; display:flex; align-items:baseline; gap:.5rem; flex-wrap:wrap;
        color:var(--fg); font-size:.95rem; font-weight:600; }
details.cfgsec > summary .secblurb { flex:1 1 18rem; font-weight:400; font-size:.85rem; }
details.cfgsec[open] > summary { border-bottom:1px solid var(--line); }
details.cfgsec > .setting-list { padding:.7rem .8rem 0; }
.seclast { margin:0 .8rem .8rem; }
/* A feature that carries an explanation spans the grid, and is ordered first — several paragraphs in a 20rem
   column is a ribbon, and the features that earn an explanation are the ones most worth reading. */
.card-wide { grid-column:1 / -1; order:-1; }
/* Menus tab. mnote is the one new note style — an inline caveat inside a card, where why/kv are
   block-level and dim carries no emphasis. mbad is the same box in the error colour.
   NO BACKTICKS in here: this CSS lives inside a template literal, and one would close it. */
.mnote { margin:.5rem 0 0; padding:.45rem .6rem; border-left:3px solid var(--line); background:var(--bg);
         font-size:.9rem; border-radius:0 4px 4px 0; }
.mbad { border-left-color:var(--red); }
.mlist { list-style:none; padding:0; margin:.5rem 0 0; }
.mlist li { padding:.2rem 0; border-bottom:1px solid var(--line); display:flex; gap:.5rem; align-items:baseline; flex-wrap:wrap; }
.mlist li:last-child { border-bottom:0; }
.mtag { font-size:.7rem; font-weight:700; text-transform:uppercase; letter-spacing:.04em;
        padding:.1rem .35rem; border-radius:3px; white-space:nowrap; }
.mtag-hide { background:var(--line); color:var(--dim); }
.mtag-add { background:var(--green); color:var(--card); }
/* Builder rows: a checkbox per real entry, so the operator ticks rather than types a label. */
.mbrow { display:flex; gap:.5rem; align-items:center; padding:.25rem 0; flex-wrap:wrap; }
.mbrow label { display:flex; gap:.4rem; align-items:center; cursor:pointer; }
/* ── two columns: the picture on the left, the context that explains it on the right. The rail takes the
      dead space rather than adding a screen of scrolling below the menus. ── */
.cols { display:grid; grid-template-columns:minmax(0,1fr) 20rem; gap:1.1rem; align-items:start; }
@media (max-width:64rem) { .cols { grid-template-columns:1fr; } }
.rail { position:sticky; top:5.4rem; }
.railh { font-size:.72rem; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); margin:0 0 .3rem; }
.rail .box { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.55rem .7rem;
             margin:0 0 .8rem; font-size:.85rem; }
.rail .box > p:first-child { margin-top:0; }
.railmenu { font-size:.7rem; text-transform:uppercase; letter-spacing:.04em; color:var(--dim);
            margin:.5rem 0 .1rem; border-bottom:1px solid var(--line); }
.railmenu:first-child { margin-top:0; }
.chgrow { display:flex; gap:.45rem; padding:.22rem 0; border-bottom:1px solid var(--line); align-items:baseline; }
.chgrow:last-child { border-bottom:0; }
.chgrow .what { flex:1; }
.kind { font-size:.66rem; padding:.02rem .35rem; border-radius:999px; border:1px solid currentColor;
        white-space:nowrap; }
.k-add { color:var(--green); } .k-edit { color:var(--blue); } .k-hide { color:var(--amber); }
/* "new group" must not wear the removal colour — a rule being CREATED reading as red is the rail telling
   the operator the opposite of what happened. */
.k-rule { color:var(--blue); } .k-rm { color:var(--red); }
.rule { padding:.28rem 0; border-bottom:1px solid var(--line); }
.rule:last-child { border-bottom:0; }
.rule.live { border-left:3px solid var(--green); padding-left:.4rem; }
.rule.dead { opacity:.7; }
.rule .aud { font-weight:600; }
/* ── the persona bar: sticky, because it governs everything below it and scrolling past it is how you
      lose track of whose menu you are reading. ── */
/* ── a menu panel. One heading level per thing: page > menu > group, and the menu is the level you
      navigate by, so it gets the border, the edge and the weight. ── */
.card.mbmenu { border-left:4px solid var(--blue); padding:.9rem 1rem 1rem; margin-bottom:1.1rem; }
.card.mbmenu > .card-head:first-child > strong { font-size:1.05rem; letter-spacing:-.01em; }
.card.mbmenu > .card-head:first-child { margin-bottom:.1rem; }
/* The provenance row sits under the title, not beside it — chips beside a heading read as part of the
   name, and these are a statement about which rule answered. */
.card.mbmenu .card-head .chip { font-weight:400; }
/* The provenance chip. GREEN is the one exact-match signal and it must never leak onto a shared rung —
   an app rung applies to every domain in that state, so it is always amber. */
.chip { font-size:.72rem; padding:.06rem .5rem; border-radius:999px; border:1px solid var(--line);
        color:var(--dim); background:var(--bg); white-space:nowrap; }
.chip.exact { border-color:var(--green); color:var(--green); }
.chip.shared { border-color:var(--amber); color:var(--amber); }
/* align-items:flex-START, not flex-end. The domain group is taller than the others (it carries a note
   when a capture filled it), and bottom-aligning made its LABEL float above the rest — the labels are
   what the eye lines up on, so they are what has to line up. */
.persona { position:sticky; top:0; z-index:6; background:var(--bg); border-bottom:2px solid var(--line);
           padding:.6rem 0 .7rem; margin-bottom:.8rem; display:flex; gap:1.4rem; align-items:flex-start;
           flex-wrap:wrap; }
.persona > div { padding-top:.05rem; }
.toggles, .persona select, .domwrap { margin-top:.05rem; }
.persona label { display:block; font-size:.72rem; text-transform:uppercase; letter-spacing:.05em;
                 color:var(--dim); margin-bottom:.2rem; }
.persona label .lc { text-transform:none; letter-spacing:0; }
.persona select, .persona input { font:inherit; padding:.3rem .45rem; border:1px solid var(--line);
                 border-radius:6px; background:var(--card); color:var(--fg); min-width:11rem; }
/* A domain is 25-30 characters of real data and the field was showing about 20 — see the screenshot
   that prompted this. Wide enough to read one without scrolling inside the box. */
.domwrap { display:flex; align-items:center; gap:.3rem; }
#spkmb-domain { min-width:22rem; }
@media (max-width:64rem) { #spkmb-domain { min-width:14rem; } }
/* ⚠️ AMBER, NOT RED, and the distinction is load-bearing in this console: red means removed or refused
   everywhere else, and an auto-filled domain is neither — it is correct, and consequential, and easy to
   miss. Amber is already this page's "wider or narrower audience than the one you think you are looking
   at", which is exactly what an unnoticed domain does: a domain rung outranks every other rule, so the
   preview AND the carve options quietly become specific to it. */
#spkmb-domain.auto { border-color:var(--amber); background:color-mix(in srgb, var(--amber) 8%, var(--card)); }
#spkmb-domnote { display:block; font-size:.76rem; color:var(--dim); margin-top:.2rem; max-width:26rem; }
#spkmb-domnote .domclear { font-size:.74rem; margin-left:.2rem; }
.domclear { font:inherit; font-size:.78rem; padding:.1rem .45rem; border:1px solid var(--line);
            border-radius:6px; background:var(--card); color:var(--dim); cursor:pointer; }
.domclear:hover { border-color:var(--blue); color:var(--blue); }
.domclear.warn { border-color:var(--red); color:var(--red); }
.toggles { display:flex; gap:.4rem; }
.tog { font:inherit; font-size:.85rem; padding:.3rem .7rem; border-radius:999px; cursor:pointer;
       border:1px solid var(--line); background:var(--card); color:var(--dim); }
.tog[aria-pressed=true] { background:var(--blue); border-color:var(--blue); color:#fff; }
.tog .off { font-size:.72em; opacity:.8; }
/* ── the composed menu: hides and adds as ONE picture, which is what stops them reading as two
      identical sections. ── */
.fake { border:1px solid var(--line); border-radius:8px; background:var(--bg); max-width:24rem;
        padding:.3rem 0; margin:.55rem 0 .2rem; }
.fm { display:flex; align-items:center; gap:.55rem; padding:.28rem .75rem; font-size:.92rem; }
.fm .lbl { flex:1; color:var(--blue); }
.fm.hid .lbl { color:var(--grey); text-decoration:line-through; }
.fm.add { background:color-mix(in srgb, var(--green) 9%, transparent); }
.fm.add .lbl { color:var(--fg); }
.fm .tag { font-size:.68rem; color:var(--dim); white-space:nowrap; }
.fm input[type=checkbox] { margin:0; flex:none; }
.fm .act { border:0; background:none; color:var(--blue); cursor:pointer; font:inherit; font-size:.76rem;
           padding:0 .1rem; }
.fm .act.rm { color:var(--red); }
/* A row the editor does not own — the kit's own injected rows. Dimmed and control-free, so it reads as
   part of the menu without inviting an edit there is nothing to make. */
.fm.fixed .lbl { color:var(--dim); font-style:italic; }
.fmdiv { border-top:1px solid var(--line); margin:.25rem 0; }
.fmfoot { padding:.3rem .75rem .15rem; font-size:.78rem; color:var(--dim); display:flex; gap:.4rem;
          flex-wrap:wrap; align-items:center; }
.fmform { display:flex; flex-wrap:wrap; gap:.3rem; padding:.35rem .75rem; align-items:center; }
.mbin { font:inherit; font-size:.85rem; padding:.2rem .35rem; border:1px solid var(--line);
        border-radius:4px; background:var(--card); color:var(--fg); }
.fmvars { display:flex; flex-wrap:wrap; gap:.25rem; align-items:center; padding:.1rem .75rem; font-size:.78rem; }
.varchip { font:inherit; font-size:.72rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
           padding:.05rem .35rem; border:1px solid var(--line); border-radius:4px; background:var(--card);
           color:var(--blue); cursor:pointer; }
.varchip:hover { border-color:var(--blue); }
.btn { font:inherit; font-size:.8rem; padding:.15rem .55rem; border:1px solid var(--line);
       border-radius:6px; background:var(--card); color:var(--fg); cursor:pointer; }
.btn:hover { border-color:var(--blue); }
/* ── where the next edit lands, and the question that decides it. Not decoration: a sticky BROAD answer
      means later ticks widen to an audience the operator is not looking at, and this line is the only
      thing that keeps that honest. ── */
.mbwhere { margin:.35rem 0 0; font-size:.82rem; color:var(--dim); }
.mbwhere .tgt { color:var(--fg); font-weight:600; }
.mbwhere .act { border:0; background:none; color:var(--blue); cursor:pointer; font:inherit;
                font-size:.8rem; padding:0 .2rem; }
.mbfork { margin:.5rem 0 0; padding:.5rem .65rem; border:1px solid var(--amber); border-radius:8px;
          background:var(--bg); max-width:34rem; font-size:.86rem; }
.mbfork > p { margin:.15rem 0 .3rem; }
.mbfork .opt { display:block; width:100%; text-align:left; margin:.3rem 0 0; }
.mbfork .optnote { display:block; font-size:.78rem; color:var(--dim); margin:.05rem 0 .3rem .25rem; }
.mbfork .act { border:0; background:none; color:var(--dim); cursor:pointer; font:inherit;
               font-size:.8rem; padding:.3rem .1rem 0; }
.pv-bad { border:1px solid var(--red); border-left:4px solid var(--red); border-radius:8px;
          padding:.55rem .7rem; margin:.55rem 0; font-size:.88rem; max-width:34rem; }
.endpoints { display:grid; grid-template-columns:repeat(auto-fill, minmax(24rem, 1fr)); gap:.6rem; align-items:start; }
.endpoint { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.7rem .85rem; }
.ep-head { display:flex; align-items:center; gap:.45rem; flex-wrap:wrap; margin-bottom:.3rem; }
.epdir { font-size:.6rem; text-transform:uppercase; letter-spacing:.05em; font-weight:700; padding:.1rem .35rem;
         border-radius:3px; border:1px solid currentColor; }
.epdir-serves { color:var(--green); }
.epdir-calls { color:var(--blue); }
.epunver { font-size:.68rem; color:var(--amber); border:1px dashed var(--amber); border-radius:3px; padding:.05rem .3rem; }
.epurl { display:inline-block; max-width:100%; overflow-wrap:anywhere; }
.endpoint p { margin:.35rem 0 0; font-size:.88rem; }
.copywr { margin-top:.35rem; }
details.schema { margin-top:.8rem; }
details.schema > summary { cursor:pointer; color:var(--blue); font-size:.85rem; }
details.schema p { margin:.4rem 0; }
.copywr > summary { font-size:.8rem; }
.setval { font-size:.72rem; margin-left:.15rem; color:var(--fg); background:var(--bg); }
.reqs { margin-top:.6rem; padding-top:.5rem; border-top:1px solid var(--line); }
.kidgroup { margin-top:.5rem; }
.kidgroup > summary { cursor:pointer; display:flex; align-items:center; gap:.4rem; flex-wrap:wrap;
        padding:.4rem .6rem; margin-left:1.25rem; border:1px dashed var(--line); border-radius:6px;
        color:var(--blue); font-size:.85rem; }
.kidgroup > summary:hover { border-color:var(--blue); }
.kidgroup[open] > summary { margin-bottom:.2rem; }
.rollup { font-weight:600; color:var(--fg); }
.why { margin:.55rem 0 0; max-width:56rem; }
.why p { margin:0 0 .5rem; }
.why p:last-child { margin-bottom:0; }
/* Small enough to organise a card without competing with its title — a subheading, not a second heading. */
.why h4.whyh { font-size:.85rem; font-weight:700; margin:.85rem 0 .3rem; color:var(--fg); }
.why h4.whyh:first-child { margin-top:0; }
/* item 26: the jump bar, and a back-to-top on every jumpable heading */
.toc { display:flex; flex-wrap:wrap; gap:.3rem; margin:.2rem 0 1rem; padding:.55rem .65rem; background:var(--card);
       border:1px solid var(--line); border-radius:8px; }
.tocref { font:inherit; font-size:.78rem; padding:.15rem .45rem; border-radius:5px; border:1px solid var(--line);
          background:var(--bg); color:var(--blue); cursor:pointer; }
.tocref:hover { border-color:var(--blue); }
/* The per-feature jump list is longer than the section bar, so it reads as a list rather than a toolbar:
   quieter chrome, tighter rows, and a scroll cap so it can never push the cards it points at off-screen. */
.toc-jump { margin:.1rem 0 1rem; padding:.45rem .55rem; max-height:9.5rem; overflow-y:auto; }
.toc-jump .tocref { font-size:.74rem; padding:.1rem .4rem; }
/* A card jumped to must not land under the sticky header, and must be findable once it does. */
.card[id] { scroll-margin-top:4.5rem; }
h3.jumph { display:flex; align-items:baseline; gap:.5rem; scroll-margin-top:.5rem; }
.totop { font:inherit; font-size:.68rem; padding:0 .3rem; border-radius:4px; border:1px solid var(--line);
         background:transparent; color:var(--dim); cursor:pointer; margin-left:auto; }
.totop:hover { color:var(--blue); border-color:var(--blue); }
/* item 27: a way back after a cross-tab jump. There is no history to go back through — the page is srcdoc
   in a sandboxed iframe with no URL — so the return trip has to be an explicit control. */
.backbar { position:sticky; top:0; z-index:5; display:none; margin:0 0 .6rem; padding:.4rem .6rem;
           background:var(--card); border:1px solid var(--blue); border-radius:6px; font-size:.85rem; }
.backbar.on { display:block; }
.backbtn { font:inherit; font-size:.85rem; background:none; border:none; color:var(--blue); cursor:pointer; padding:0; }
/* item 23: which CELL the configuration changed, and in which direction. A ring, not a fill, so the
   verdict mark stays readable as itself. */
.pc-delta { position:relative; }
/* Hugs the mark rather than filling the cell: inset by percentage so a tall row (one whose header wraps)
   does not stretch the ring into a box, and a pill radius so it reads as an annotation on the dot rather
   than a second cell border. Solid = granted, dashed = revoked. */
.pc-delta::after { content:''; position:absolute; left:50%; top:50%; width:1.25rem; height:1.25rem;
        transform:translate(-50%, -50%); border:1.5px solid var(--amber); border-radius:999px; }
.pc-delta-revoked::after { border-style:dashed; }
/* item 25: the audience divider */
tr.audrow th { background:var(--bg); font-size:.7rem; text-transform:uppercase; letter-spacing:.04em;
               color:var(--dim); font-weight:700; padding:.45rem .45rem; text-align:left; }
/* item 30: the worked examples */
.examples { display:grid; grid-template-columns:repeat(auto-fill, minmax(21rem, 1fr)); gap:.7rem; align-items:start; }
.example { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.7rem .85rem; }
.ex-head { display:flex; align-items:center; gap:.5rem; }
.ex-head .copy-btn { margin-left:auto; }
.example p { margin:.3rem 0 0; font-size:.88rem; }
`;

// ── script: tabs need none; this wires the Config filter, cross-tab jump-to-setting, the Permissions
// scope checker, the JSON copy buttons, the probe postMessage bridge, and the once-per-modal-instance
// auto-run on first Checks-tab open ──────────────────────────────────────────────────────────────────
//
// A function of `hasRun`, not a constant, because `autoRan`'s seed value is per-document: a fresh modal
// always renders with `hasRun === false`, but if a document is ever built already carrying results there
// is no run left to trigger. One boolean, the same one the intro and the button label already read.
/**
 * The page's inline script. `menusBase` is this deployment's LIVE `PORTAL_MENUS`, embedded so the builder
 * can start from it — the builder emits a complete config, and it can only do that if it knows what is
 * already there. Passed as a value rather than re-parsed in the browser from the rendered Config tab: one
 * parse, server-side, where a malformed value is already reported.
 */
function script(hasRun: boolean, menusBase: string, doc: StatusDoc): string {
  // Embedded via JSON.stringify of the PARSED object, so whatever lands in the script is valid JS and
  // cannot carry the operator's raw string into a code position. A config that does not parse yields {} —
  // the builder then starts from nothing, which is correct, because there is no config to preserve.
  let parsed: unknown = {};
  try { parsed = JSON.parse(menusBase || '{}'); } catch { parsed = {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  // NORMALIZE THE MENU KEYS, because the runtime does. `parseMenus` lowercases each menu name before
  // applying it, so `{"Apps":{...}}` is valid config that genuinely runs -- while this builder looked the
  // menu up by its canonical lowercase name and found nothing. Since 0.2.39 the builder emits the
  // COMPLETE config rather than a diff, so seeding from an unmatched key produced an empty menu that,
  // pasted, DELETED a working one. Two readings of one value is the recurring shape here; this makes the
  // builder read it the way the thing that acts on it does.
  const seeded: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) seeded[k.trim().toLowerCase()] = v;
  // JSON.stringify does not escape `</script>`, and a menu LABEL is operator prose that is never
  // scheme-checked the way a url is. The console is a sandboxed srcdoc with no same-origin, so the blast
  // radius is the operator's own view -- but "never put raw text into a script position" is the rule this
  // file holds everywhere else, and a partial rule is the one that gets forgotten.
  const mbBaseJson = JSON.stringify(seeded).replace(/</g, '\\u003c');
  return `(function(){
  var filt = document.getElementById('spkConfigFilter');
  function filtering(){ return !!(filt && (filt.value || '').trim()); }

  // Open a setting's containing section, and scroll it into view. Needed because the sections start
  // collapsed: a jump from another tab, or a filter match, would otherwise land on a closed box.
  function openSection(el, exclusive){
    var sec = el && el.closest ? el.closest('details.cfgsec') : null;
    if (!sec) return null;
    sec.open = true;
    if (exclusive) closeOthers(sec);
    return sec;
  }

  // Exclusivity is done here rather than with the native name= attribute on <details>, because the filter
  // has to be able to open SEVERAL at once — with the browser enforcing one-at-a-time, a filter matching rows
  // in three groups would silently show only one group's worth of results.
  function closeOthers(keep){
    var secs = document.querySelectorAll('details.cfgsec');
    for (var i = 0; i < secs.length; i++) if (secs[i] !== keep) secs[i].open = false;
  }

  // Filtering hides ROWS, so a group whose every row is hidden must hide itself too — otherwise a filter that
  // matches nothing in "Branding" still shows a Branding section, which reads as a match. And a group that
  // DOES match must open itself, or the results are behind a click the reader has no reason to expect.
  function applyFilter(){
    var q = (filt.value || '').trim().toLowerCase();
    var rows = document.querySelectorAll('.setting-row');
    for (var i = 0; i < rows.length; i++) {
      var hay = rows[i].getAttribute('data-search') || '';
      rows[i].style.display = hay.indexOf(q) === -1 ? 'none' : '';
    }
    var groups = document.querySelectorAll('.cfggroup');
    for (var g = 0; g < groups.length; g++) {
      var vis = groups[g].querySelectorAll('.setting-row:not([style*="display: none"])').length;
      groups[g].style.display = vis === 0 ? 'none' : '';
      // Only while a filter is active. With the box cleared, restore the collapsed index rather than leaving
      // twelve sections hanging open from the last search.
      if (q) groups[g].open = vis > 0;
      else groups[g].open = false;
    }
  }
  // The clear control. Shown only when there is something to clear — a permanently-visible × on an empty box
  // is a control that does nothing, which is the same defect as a row that cannot vary.
  var clearBtn = document.getElementById('spkFilterClear');
  function syncClear(){ if (clearBtn) clearBtn.classList.toggle('on', filtering()); }
  function clearFilter(){
    if (!filt) return;
    filt.value = '';
    applyFilter();
    syncClear();
    filt.focus();
  }
  if (filt) {
    filt.addEventListener('input', function(){ applyFilter(); syncClear(); });
    // Escape clears while the box has focus, which is what the placeholder's own hint promises.
    filt.addEventListener('keydown', function(ev){ if (ev.key === 'Escape' && filtering()) { ev.stopPropagation(); clearFilter(); } });
  }
  if (clearBtn) clearBtn.addEventListener('click', clearFilter);
  syncClear();

  // The Integrations groups behave as an accordion only when there is more than one to compete for the space.
  // With a single group, opening it is the default and closing it must not be undone by anything.
  var kidGroups = document.querySelectorAll('details.kidgroup');
  if (kidGroups.length > 1) {
    for (var kg = 0; kg < kidGroups.length; kg++) {
      kidGroups[kg].addEventListener('toggle', function(){
        if (!this.open) return;
        for (var j = 0; j < kidGroups.length; j++) if (kidGroups[j] !== this) kidGroups[j].open = false;
      });
    }
  }

  // The accordion. Guarded on filtering() so a filter-driven open does not immediately close its siblings,
  // and on .open so collapsing one does not reshuffle the rest.
  var cfgSecs = document.querySelectorAll('details.cfgsec');
  for (var cs = 0; cs < cfgSecs.length; cs++) {
    cfgSecs[cs].addEventListener('toggle', function(){
      if (this.open && !filtering()) closeOthers(this);
    });
  }

  // The jump bar and the back-to-top buttons on each heading. Both are pure scrolls within the current tab.
  document.addEventListener('click', function(ev){
    var raw = ev.target;
    if (!raw || !raw.closest) return;
    // closest(), not classList on the clicked node: these buttons contain child elements — the section
    // bar wraps its count in a span — and a click that lands on the child was silently doing nothing.
    // Reading the button the click is INSIDE makes the whole control clickable, which is what it looks
    // like, and it stops the markup of a jump entry from being load-bearing.
    var t = raw.closest('.tocref') || raw.closest('.totop') || raw;
    if (!t || !t.classList) return;
    if (t.classList.contains('tocref')) {
      var el = document.getElementById(t.getAttribute('data-target') || '');
      if (!el) return;
      // A Config section is collapsed, so pointing at it is not enough — open it, and honour the accordion.
      if (el.tagName === 'DETAILS') { el.open = true; if (!filtering()) closeOthers(el); }
      el.scrollIntoView({ block: 'start' });
      return;
    }
    if (t.classList.contains('totop')) {
      // The DOCUMENT top, not the panel top. The header and the tab bar sit ABOVE every panel, so scrolling
      // the panel into view left them off-screen — which defeats the point: the reason to go back up is
      // usually to switch tabs.
      window.scrollTo(0, 0);
    }
  });

  // Jump to a setting from any card that names it: switch to the Config tab, clear any filter that would
  // keep the row hidden, scroll it into view and mark it. Delegated on the document so it covers every
  // .setref anywhere on the page, including ones inside a collapsed <details> the reader just opened.
  //
  // The trip is one-way without help: the page is srcdoc in a sandboxed iframe, so there is no URL and no
  // history for a browser Back to walk. So remember BOTH the tab and the card that was open, and offer an
  // explicit return that restores the card too — returning only to the tab still leaves the reader hunting
  // for where they were.
  var lastHi = null;
  var backBar = document.getElementById('spkBackBar');
  var backBtn = document.getElementById('spkBackBtn');
  var origin = null;

  function clearBack(){
    origin = null;
    if (backBar) backBar.classList.remove('on');
  }

  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.classList || !t.classList.contains('setref')) return;
    var name = t.getAttribute('data-setting');
    if (!name) return;

    // Where we came FROM, captured before switching tabs. The label is the tab's own visible text, so it
    // cannot drift from the tab bar.
    var fromPanel = t.closest('.spk-panel');
    var fromCard = t.closest('.card') || t.closest('.setting-row');
    if (fromPanel && fromPanel.id !== 'spkpanel-config') {
      var id = fromPanel.id.replace('spkpanel-', '');
      var lbl = document.querySelector('.spk-tabbar label[for="spktab-' + id + '"]');
      origin = { tab: id, card: fromCard, label: lbl ? lbl.textContent : id };
      if (backBar && backBtn) {
        backBtn.textContent = '\u2190 Back to ' + origin.label;
        backBar.classList.add('on');
      }
    }

    var cfg = document.getElementById('spktab-config');
    if (cfg) cfg.checked = true;
    if (filt && filt.value) { filt.value = ''; applyFilter(); }
    var row = document.getElementById('spkset-' + name);
    if (!row) return;
    // The row's section starts collapsed, so scrolling to the row alone lands on a closed box — which is the
    // one way this navigation could look broken rather than merely unhelpful.
    openSection(row, true);
    if (lastHi) lastHi.classList.remove('hilite');
    row.classList.add('hilite');
    lastHi = row;
    row.scrollIntoView({ block: 'center' });
  });

  if (backBtn) backBtn.addEventListener('click', function(){
    if (!origin) return;
    var input = document.getElementById('spktab-' + origin.tab);
    if (input) input.checked = true;
    if (origin.card) origin.card.scrollIntoView({ block: 'center' });
    if (lastHi) { lastHi.classList.remove('hilite'); lastHi = null; }
    clearBack();
  });

  // Switching tabs by hand means the reader is no longer mid-trip, so the offer to go back is stale.
  var tabInputs = document.querySelectorAll('.spk-tabin');
  for (var ti = 0; ti < tabInputs.length; ti++) {
    tabInputs[ti].addEventListener('change', function(){
      if (this.id !== 'spktab-config') clearBack();
    });
  }

  // Copy a JSON block.
  //
  // THIS PAGE IS A SANDBOXED srcdoc IFRAME with no allow-same-origin, so its origin is OPAQUE — and the
  // async Clipboard API is gated on a permissions policy that an opaque origin never satisfies. The
  // promise rejects (or the whole API is absent), which is why the button reported "select and copy
  // manually" and copied nothing. Adding allow-same-origin would fix it by handing this frame
  // same-origin access to the portal that hosts it, which is not a trade worth making for a Copy button.
  //
  // So: try the modern API, fall back to execCommand — deprecated, but it works from a user gesture in a
  // sandboxed frame precisely because it is not permission-gated — and if even that fails, SELECT the
  // block so the reader can press the keyboard shortcut without hunting for the boundaries. Each step is
  // strictly better than telling them to do it themselves.
  function selectBlock(pre) {
    try {
      var r = document.createRange(); r.selectNodeContents(pre);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return true;
    } catch (e) { return false; }
  }
  function copyViaExec(text, pre) {
    try {
      // A textarea rather than the <pre>: selecting the block would leave the reader's own selection
      // changed under them on success, and a hidden textarea leaves the page as it found it.
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var okc = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!okc;
    } catch (e) { return false; }
  }
  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.classList || !t.classList.contains('copy-btn')) return;
    var pre = document.getElementById(t.getAttribute('data-copy') || '');
    if (!pre) return;
    var text = pre.textContent || '';
    var done = function(msg){ t.textContent = msg; setTimeout(function(){ t.textContent = 'Copy'; }, 2000); };
    var fallback = function(){
      if (copyViaExec(text, pre)) { done('Copied'); return; }
      done(selectBlock(pre) ? 'Selected — press copy' : 'Select and copy manually');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function(){ done('Copied'); }, fallback);
        return;
      }
    } catch (e) { /* fall through */ }
    fallback();
  });

  // The scope checker. It does NOT re-evaluate anything — it reads the verdicts the server already
  // rendered into each cell. A second, client-side derivation of "who can do what" is exactly the
  // one-fact-two-derivations failure a permissions view must not have.
  var pick = document.getElementById('spkScopePick');
  var superBtn = document.getElementById('spkScopeSuper');
  var summary = document.getElementById('spkScopeSummary');
  var table = document.querySelector('table.pmatrix');
  var VERDICT_WORD = { yes: 'available', no: 'not allowed', blocked: 'blocked by a second gate', inert: 'not configured to run', broken: 'unevaluable (config error)' };

  // One wording for both the scope dropdown and the superadmin button — two hand-written summaries of the
  // same buckets is how the two controls would end up describing the same verdicts differently.
  function summarize(buckets){
    var order = ['yes', 'inert', 'blocked', 'no', 'broken', 'na'];
    var out = [];
    for (var k = 0; k < order.length; k++) {
      var key = order[k];
      if (!buckets[key] || !buckets[key].length) continue;
      var word = key === 'na' ? 'cannot be granted' : (VERDICT_WORD[key] || key);
      out.push(buckets[key].length + ' ' + word + ' (' + buckets[key].join(', ') + ')');
    }
    return out.length ? out.join('; ') : 'nothing to report';
  }

  function clearHi(){
    if (!table) return;
    var hi = table.querySelectorAll('td.colhi');
    for (var i = 0; i < hi.length; i++) hi[i].classList.remove('colhi');
  }

  function showColumn(index, label){
    if (!table || !summary) return;
    clearHi();
    if (index < 0) { summary.textContent = ''; return; }
    var rows = table.querySelectorAll('tbody tr');
    var buckets = {};
    for (var i = 0; i < rows.length; i++) {
      var cell = rows[i].querySelectorAll('td.pc')[index];
      if (!cell) continue;
      cell.classList.add('colhi');
      var v = cell.getAttribute('data-verdict') || 'na';
      var nameEl = rows[i].querySelector('.rowname');
      (buckets[v] = buckets[v] || []).push(nameEl ? nameEl.textContent : '');
    }
    summary.textContent = label + ': ' + summarize(buckets) + '.';
  }

  if (pick) pick.addEventListener('change', function(){
    var i = pick.selectedIndex - 1; // index 0 is the "every scope" placeholder
    showColumn(i, pick.value || '');
  });
  // Selected by CLASS, never by an arithmetic guess at a column index: the superadmin cell is marked
  // .pc-super server-side, so adding or reordering a scope column cannot silently point this at the wrong
  // one.
  // Both named axes go through ONE function, selected by CLASS rather than by an arithmetic guess at a
  // column index: the cells are marked server-side, so adding or reordering a scope column cannot silently
  // point this at the wrong one.
  function showNamedAxis(cls, label){
    if (!table || !summary) return;
    clearHi();
    var cells = table.querySelectorAll('td.' + cls);
    var buckets = {};
    for (var i = 0; i < cells.length; i++) {
      cells[i].classList.add('colhi');
      var v = cells[i].getAttribute('data-verdict') || 'na';
      var row = cells[i].closest('tr');
      var nameEl = row ? row.querySelector('.rowname') : null;
      (buckets[v] = buckets[v] || []).push(nameEl ? nameEl.textContent : '');
    }
    summary.textContent = label + ': ' + summarize(buckets) + '.';
    if (pick) pick.selectedIndex = 0;
  }
  if (superBtn) superBtn.addEventListener('click', function(){
    showNamedAxis('pc-super', 'A named superadmin account, at the lowest scope');
  });
  var namedBtn = document.getElementById('spkScopeNamed');
  if (namedBtn) namedBtn.addEventListener('click', function(){
    showNamedAxis('pc-named', 'An account named directly in the gate, at the lowest scope');
  });

  var btn = document.getElementById('spkRunChecks');
  var introEl = document.getElementById('spkChecksIntro');
  var host = document.getElementById('spkChecksResults');

  function checkRow(state, label, name, detail, cost) {
    var row = document.createElement('div');
    row.className = 'check-row';
    var p = document.createElement('span');
    p.className = 'pill pill-' + state;
    p.textContent = label;
    var n = document.createElement('strong');
    n.textContent = name;
    var d = document.createElement('p');
    d.textContent = detail;
    var c = document.createElement('p');
    c.className = 'dim';
    c.textContent = cost;
    row.appendChild(p); row.appendChild(n); row.appendChild(d); row.appendChild(c);
    return row;
  }

  // The client-side twin of renderProbeTable. Results arrive over the bridge, so every cell here is a
  // string this page did not author — built node by node with textContent, never assembled into markup.
  // Collapsed, same as the server-rendered form: these tables are long by nature.
  function checkTable(t) {
    if (!t || !t.rows || !t.rows.length) return null;
    var det = document.createElement('details');
    det.className = 'probetable';
    var sum = document.createElement('summary');
    sum.textContent = t.caption || 'Detail';
    det.appendChild(sum);
    var wrap = document.createElement('div');
    wrap.className = 'tablewrap';
    var tbl = document.createElement('table');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    (t.columns || []).forEach(function(cn){
      var th = document.createElement('th'); th.scope = 'col'; th.textContent = cn; hr.appendChild(th);
    });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = document.createElement('tbody');
    t.rows.forEach(function(r){
      var tr = document.createElement('tr');
      (r || []).forEach(function(cell){
        var td = document.createElement('td'); td.textContent = cell; tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl); det.appendChild(wrap);
    if (t.note) { var np = document.createElement('p'); np.className = 'dim'; np.textContent = t.note; det.appendChild(np); }
    return det;
  }

  // One code path for both triggers (the button and the auto-run below), so they can never show
  // different "running" behaviour. Disabling the button here — not just relabeling it — is what stops a
  // second press (or a second auto-fire) from queuing a duplicate run. Does not touch the host's existing
  // rows (the not-yet-run explainer, or a prior result set): it only PREPENDS a pending row, so the
  // per-check cost disclosure stays visible while a run is in flight, never removed to "make room" for a
  // status message.
  // IS THERE A PARENT TO TALK TO? Every live thing on this page — the checks, the observed-page block, the
  // builder's menu read — is a postMessage round-trip to the portal window this console is embedded in.
  // Rendered anywhere else (a static export, a saved page, a devtools reload of the srcdoc) there is no
  // parent, the messages go nowhere, and the page sat on "Running…" and "Asking the portal page…"
  // indefinitely — states that claim something is in flight when nothing is. Say so instead: a console
  // whose whole job is reporting the truth should not be the thing implying work is happening.
  var HOSTED = false;
  try { HOSTED = window.parent && window.parent !== window; } catch (e) { HOSTED = false; }

  function runChecks(){
    if (!HOSTED) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    if (introEl) introEl.textContent = ${JSON.stringify(CHECKS_INTRO_TEXT.running)};
    if (host) host.insertBefore(
      checkRow('off', 'RUNNING', 'Checks are running…',
        'Six checks run one at a time against live systems — this can take several seconds, longer if one is slow or unreachable.',
        ''),
      host.firstChild);
    window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.request}' }, '*');
  }

  if (btn) btn.addEventListener('click', function(){ autoRan = true; runChecks(); });

  // Auto-run ONCE per modal instance: the first time the Checks tab itself is opened, not on page load
  // (the console can be opened and closed without ever visiting this tab) and not again on switching
  // back to it. autoRan seeds from whether this document already carries results — a fresh modal
  // always starts false — and this 'change' listener is the only place that flips it, checked BEFORE it
  // is set and set BEFORE runChecks() is called, so a second 'change' event on this same input (tab
  // away, tab back) reads autoRan === true and is a no-op.
  var autoRan = ${hasRun ? 'true' : 'false'};
  var checksTabIn = document.getElementById('spktab-checks');
  if (checksTabIn) checksTabIn.addEventListener('change', function(){
    if (checksTabIn.checked && !autoRan) { autoRan = true; runChecks(); }
  });
  if (!HOSTED) {
    // Disabled rather than left to fail: pressing a button that cannot work, and then waiting, is worse
    // than being told up front. The per-check cost disclosure stays on screen either way — it is the
    // description of what the checks ARE, which is still true here.
    if (btn) { btn.disabled = true; btn.textContent = 'Checks need the portal'; }
    if (introEl) introEl.textContent = 'This page is not running inside the portal, so the checks cannot run — '
      + 'they reach live systems through the portal window that normally hosts this console. '
      + 'What each check does, and what it would cost, is listed below.';
  }

  // ── observed page facts ────────────────────────────────────────────────────────────────────────────
  // Asked once on open, unprompted: it costs nothing (the parent reads its own DOM) and the answer belongs
  // on screen before the reader goes looking for it. Never renders a guess — if no reply arrives, the
  // pending text stays, which is the true state.
  var obsEl = document.getElementById('spkobs-txt');
  function showObserved(p){
    if (!obsEl) return;
    var lines = [];
    if (p.missing) {
      lines.push('No vendor hand-off is configured, so this kit chain-loaded nothing.');
    } else if (!p.declared) {
      lines.push('The hand-off is declared as none, so this kit chain-loaded nothing. Anything else on this page was put there by something that is not this kit.');
    } else if (p.present && p.addedByKit) {
      lines.push('The vendor hand-off is on this page, and this kit is what loaded it.');
    } else if (p.present && p.preexisting) {
      lines.push('The vendor hand-off is on this page, and it was already there before this kit ran — so something else loads it too. This kit skipped its own injection rather than loading it twice.');
    } else if (p.present) {
      lines.push('The vendor hand-off is on this page.');
    } else {
      lines.push('The vendor hand-off is configured, but no script with that exact URL is on this page. The check matches the exact string, so a different-looking URL for the same file would not be recognised here — and would have been loaded twice.');
    }
    var hosts = Array.isArray(p.hosts) ? p.hosts : [];
    if (hosts.length) lines.push('Scripts on this page come from: ' + hosts.join(', ') + '.');
    // textContent, one paragraph per line: the host list is page-derived, so it never reaches innerHTML.
    obsEl.textContent = '';
    for (var li = 0; li < lines.length; li++) {
      var p2 = document.createElement('p');
      p2.className = 'dim';
      p2.style.margin = li ? '.4rem 0 0' : '0';
      p2.textContent = lines[li];
      obsEl.appendChild(p2);
    }
  }
  if (HOSTED) window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.pageRequest}' }, '*');
  else if (obsEl) obsEl.textContent = 'This page is not running inside the portal, so there is no page to '
    + 'inspect. Opened from the portal, this reports whether the vendor hand-off is really loaded and which '
    + 'hosts its scripts come from.';

  // ── the menu builder ────────────────────────────────────────────────────────────────────────────────
  // Starts from the config this deployment is ALREADY running, not from empty. That is a correctness
  // requirement, not a convenience: the emitted string replaces PORTAL_MENUS wholesale, so a builder that
  // only knew about your edits would produce a config that silently deletes everything you did not touch
  // this session. It did, in 0.2.37. Now the output is always the complete config — untouched menus
  // included, byte-for-byte where they were not edited.
  //
  // The other half of that promise: a menu whose config is TARGETED (varies by domain, scope or app state)
  // cannot be represented by the flat tick-list this builder shows, so it is NOT editable here and its
  // original value is carried through verbatim. Flattening it to whatever applies to one probe rung would
  // quietly narrow it to a single audience.
  var MB_MENUS = [
    // The audience line sits BESIDE the menu name, not under it as a paragraph: one heading level per
    // thing, and a sentence of chrome per menu is three sentences of scrolling on a tab whose complaint
    // was scrolling. Short enough to read without stopping.
    { name: 'apps', label: 'Apps', who: 'everyone who can sign in' },
    { name: 'account', label: 'Account', who: 'their own name dropdown' },
    { name: 'management', label: 'Management', who: 'administrative scopes, where a vendor supplies it' }
  ];
  // The live config, embedded server-side. The builder is a differ against THIS.
  var MB_BASE = ${mbBaseJson};
  // The scope vocabulary the scopes axis accepts, from the same list the runtime validates against
  // (features.ts KNOWN_SCOPES) rather than a second copy typed here — a rung naming a scope this
  // deployment does not know is refused at boot, so offering one would be offering a config that breaks.
  var MB_SCOPES = ${JSON.stringify(KNOWN_SCOPES)};
  // Same for the app axis: the app names this deployment knows, plus the reserved "none" (a domain running
  // no app). Both lists come from the modules that validate them, never a second copy typed here.
  var MB_APPS = ${JSON.stringify([...APP_NAMES, 'none'])};
  // Apps this deployment could EVER run — availability, not usage. An app that is available and active
  // nowhere still gets a toggle, because that is exactly when its menus want designing; one that is not
  // available gets none, because "what would this persona see with it active" has no referent here.
  var MB_AVAIL = ${JSON.stringify(doc.menus.availableApps)};
  // Rows the KIT puts in the Apps menu, which are not config and cannot be hidden by it. Drawn so the
  // picture is not missing entries the user will actually see — the one direction of inaccuracy that
  // invites an operator to add something that is already there.
  var MB_INJECTED = ${JSON.stringify(doc.menus.injected)};
  // The placeholders an entry may carry, offered where one is typed. From the module that VALIDATES them,
  // so a variable this deployment would refuse at startup can never be offered here — the same rule the
  // scope and app vocabularies follow.
  var MB_VARS = ${JSON.stringify(MENU_VARS.map((v) => ({ v, h: MENU_VAR_HELP[v] })))};
  // The reader's OWN scope. The stock entries in every picture below came off the page they opened this
  // from, as them — so the moment the persona is somebody else, the entries are an approximation and the
  // page has to say so.
  var MB_ME = ${JSON.stringify(doc.viewer.scope)};
  var mbCaveatEl = document.getElementById('spkmb-caveat');
  var mbCapEl = document.getElementById('spkmb-capture');

  // Two-step confirm for forgetting the captures — see mbCapturePanel for why it cannot be a confirm().
  var mbForget = false;
  // The tab is switched at most once, on the first captures to arrive. After that the reader has chosen
  // where they are.
  var mbTabbed = false;
  // Menus captured while masquerading, keyed by lower-cased scope. Written on the portal page by the
  // capture bundle; read back over the bridge because this frame has no storage of its own.
  var mbStock = {};
  // Which captures have had their context adopted already. Adopting ONCE per capture, not on every
  // redraw: the context is a starting point, and an operator who turns a toggle back on must not have it
  // silently reset under them on the next reply.
  var mbAdopted = {};
  // Stock entries the portal shows only to some scopes, as label -> the scopes that see it. Flattened
  // server-side from STOCK_SCOPE_FLOOR through LEVEL_SCOPES, so the console carries no second ordering of
  // scopes. See the list's own comment: curated, incomplete, and it only ever subtracts.
  var MB_FLOOR = ${JSON.stringify(
    Object.fromEntries(Object.entries(STOCK_SCOPE_FLOOR).map(([label, level]) => [label, LEVEL_SCOPES[level] ?? []])),
  )};
  var mbState = {};
  var mbStatus = document.getElementById('spkmb-status');
  var mbHost = document.getElementById('spkmb-menus');
  var mbOut = document.getElementById('spkmb-out');
  var mbJson = document.getElementById('spkmb-json');
  var mbWr = document.getElementById('spkmb-wr');
  var mbVerdict = document.getElementById('spkmb-verdict');
  var mbCheckTimer = 0;
  var mbCheckSeq = 0;   // the last question asked
  var mbCheckWait = 0;  // the one whose answer we are still waiting for
  var mbLive = null;

  function mbIsTargeted(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function mbClone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  // ── targeted lists, editable rung by rung (item 47) ────────────────────────────────────────────────
  // A targeted half used to be read-only in full, because the flat tick-list this builder shows cannot
  // express one and flattening it would quietly narrow it to a single audience. That reasoning holds for
  // an axis as a whole and NOT for the rungs inside one: a rung IS a flat list, for a named audience.
  //
  // And targeting is the point of the feature, not an edge of it — a reseller-only Management menu is the
  // ordinary thing an operator writes here, not the exotic one. So EVERY axis whose rungs are flat lists
  // is editable, one rung at a time, plus the whole-menu default. Nothing is flattened and nothing is
  // merged: an axis this cannot round-trip is still carried through and still SHOWN, because "not
  // editable" on its own tells you a rule exists and hides what it says.
  //
  // In PRECEDENCE order (users, domains, scopes, app, then the default) — the rule the reader needs and
  // the one the JSON does not state. Emission keeps the original key order, so a diff against the running
  // config shows what you changed and nothing else. The label is what a rung is CALLED in the editor:
  // the key is what you would have had to learn from the docs, the audience is what you already know.
  var MB_AXES = [
    { name: 'users', label: 'account' },
    { name: 'domains', label: 'domain' },
    { name: 'scopes', label: 'scope' },
    { name: 'app', label: 'app state' }
  ];
  function mbAxisDef(name) {
    for (var i = 0; i < MB_AXES.length; i++) if (MB_AXES[i].name === name) return MB_AXES[i];
    return null;
  }
  function mbAxisKey(raw, name) {
    if (!mbIsTargeted(raw)) return undefined;
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) if (keys[i].trim().toLowerCase() === name) return keys[i];
    return undefined;
  }
  /** One axis sub-map, when this half has it AND every rung in it is a flat list we can round-trip. */
  function mbAxisOf(raw, name) {
    var k = mbAxisKey(raw, name);
    if (k === undefined) return null;
    var m = raw[k];
    if (!mbIsTargeted(m)) return null;            // present but not an object: invalid config, so do not touch it
    var keys = Object.keys(m);
    for (var i = 0; i < keys.length; i++) if (!Array.isArray(m[keys[i]])) return null; // a rung we cannot render
    return { key: k, map: m, keys: keys };
  }
  /** The keys of a targeted half this builder is NOT taking over, cloned — emitted back verbatim, in the
   *  KEY ORDER they were written in. Order is not cosmetic here: the builder emits the whole config every
   *  time, and an operator's first move is to diff that against what they are running. A rebuild that
   *  moved a block would show as a change on a menu nobody edited, which is exactly the noise that makes
   *  a real change easy to miss. */
  function mbRest(raw, handled) {
    var out = {};
    Object.keys(raw).forEach(function(k){ if (handled.indexOf(k) < 0) out[k] = mbClone(raw[k]); });
    return out;
  }

  /**
   * ONE ADDED ENTRY, AS THE EDITOR HOLDS IT: the three fields it can change, plus the entry exactly as the
   * operator WROTE it.
   *
   * ⚠️ menuItemAt reads label/url/title and ignores every other key, so {"label","url","note"} is
   * valid running config — and rebuilding each entry from its three known fields quietly deleted the rest,
   * on menus nobody had touched. The builder emits the WHOLE config every time and an operator's first
   * move is to diff it against what they are running, so a dropped key and a reordered pair both read as a
   * change on a menu they did not edit. That noise is what hides the change they did make.
   */
  function mbEntryIn(a) {
    return { label: (a && a.label) || '', url: (a && a.url) || '', title: (a && a.title) || '', _o: a };
  }
  /** The inverse: what gets written back. An untouched entry comes back byte for byte, key order included;
   *  an edited one keeps whatever else was written beside the fields this editor understands. */
  function mbEntryOut(a) {
    var o = (a && a._o && typeof a._o === 'object' && !Array.isArray(a._o)) ? mbClone(a._o) : {};
    o.label = a.label;
    o.url = a.url;
    if (a.title) o.title = a.title; else delete o.title;
    return o;
  }

  // The full config: every menu, edited or not. Untouched menus are emitted from MB_BASE unchanged, and a
  // targeted menu is emitted from MB_BASE even when its sibling half was edited.
  function mbConfig() {
    var cfg = {};
    MB_MENUS.forEach(function(mn){
      var st = mbState[mn.name];
      var base = MB_BASE[mn.name] || {};
      var one = {};
      // A rung is emitted even when EMPTY: an empty rung is the "everyone except these" idiom, and
      // dropping it would change who the rule applies to rather than tidying the output. The rest of the
      // object — every other axis, and the whole-object "*" — is re-emitted from the state's own clone of
      // it, so an untouched axis survives byte for byte through an edit to a sibling one.
      function fromRungs(r, asEntries) {
        function listOut(v) {
          return asEntries
            ? v.filter(function(a){ return a.label && a.url; }).map(mbEntryOut)
            : v.slice();
        }
        var byKey = {};
        r.axes.forEach(function(ax){
          var axis = {};
          ax.order.forEach(function(k){ axis[k] = listOut(ax.map[k]); });
          byKey[ax.axisKey] = axis;
        });
        if (r.top) byKey[r.top.key] = listOut(r.top.list);
        var rest = mbClone(r.rest) || {};
        var out = {};
        // Rebuilt in the ORIGINAL key order, each edited block substituted where it already sat, so a
        // diff against the running config shows what changed and nothing else. A block added this session
        // (an axis that had no key before) lands after them, which is the only place it can go.
        var order = (r.keyOrder || []).slice();
        Object.keys(byKey).forEach(function(k){ if (order.indexOf(k) < 0) order.push(k); });
        Object.keys(rest).forEach(function(k){ if (order.indexOf(k) < 0) order.push(k); });
        order.forEach(function(k){
          if (byKey[k] !== undefined) out[k] = byKey[k];
          else if (rest[k] !== undefined) out[k] = rest[k];
        });
        return out;
      }
      // hide
      if (st && st.hideRungs) {
        one.hide = fromRungs(st.hideRungs, false);
      } else if (st && !st.hideLocked) {
        var hide = st.hide.slice();
        // AN EMPTY FLAT LIST IS A KEY THE OPERATOR WROTE, and dropping it made an untouched menu emit
        // differently from how it runs. An empty list and no hide key mean the same thing to the resolver,
        // which is exactly why the difference is pure diff noise rather than a correction.
        if (hide.length || Array.isArray(base.hide)) one.hide = hide;
      } else if (base.hide !== undefined) {
        one.hide = mbClone(base.hide);
      }
      // add
      if (st && st.addRungs) {
        one.add = fromRungs(st.addRungs, true);
      } else if (st && !st.addLocked) {
        var add = st.add.filter(function(a){ return a.label && a.url; }).map(mbEntryOut);
        if (add.length || Array.isArray(base.add)) one.add = add;
      } else if (base.add !== undefined) {
        one.add = mbClone(base.add);
      }
      if (one.hide !== undefined || one.add !== undefined) cfg[mn.name] = one;
    });
    return cfg;
  }

  function mbRender() {
    var cfg = mbConfig();
    // The preview is of the CANDIDATE, not of what is deployed — an edit that changes nothing visible for
    // this persona is a fact worth seeing, and so is one that changes something you did not expect.
    if (mbPreviewReply !== null) mbRefreshPreview();
    // Always shown once there is a base or an edit — an operator needs to see the full config even when
    // they have changed nothing, because that is the thing they are about to paste.
    var empty = !Object.keys(cfg).length;
    mbOut.hidden = empty;
    if (empty) { if (mbVerdict) mbVerdict.textContent = ''; return; }
    mbJson.textContent = JSON.stringify(cfg, null, 2);
    // Double-stringify IS the wrangler escaping rule, so this cannot disagree with what the file parses.
    mbWr.textContent = '"PORTAL_MENUS": ' + JSON.stringify(JSON.stringify(cfg));
    mbVerdict.textContent = 'Checking…';
    if (mbCheckTimer) clearTimeout(mbCheckTimer);
    mbCheckTimer = setTimeout(function(){
      // Stamped, and only the outstanding stamp is believed — a verdict for a config the operator has
      // already typed past would sit under the one on screen saying "Valid" about something else.
      mbCheckWait = ++mbCheckSeq;
      window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.checkRequest}', ${SPK_BRIDGE.idKey}: mbCheckWait,
        ${SPK_BRIDGE.checkKey}: JSON.stringify(cfg) }, '*');
    }, 400);
  }

  function mbBtn(label, fn, host, cls) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = cls || 'copy-btn'; b.textContent = label;
    b.addEventListener('click', fn);
    host.appendChild(b);
    return b;
  }

  // A TARGETED rung this editor cannot round-trip, shown read-only. "Not editable here" on its own tells
  // you a rule exists and hides what it says, which is the worst of both — you cannot edit it AND you
  // cannot read it without going to the Config tab. Whatever the builder cannot edit, it can still show.
  function mbShowRungs(raw, card, what) {
    var wrap = document.createElement('div');
    var head = document.createElement('p'); head.className = 'dim';
    head.textContent = 'Targeted ' + what + ', shown as configured — edit these on the Config tab:';
    wrap.appendChild(head);
    Object.keys(raw).forEach(function(axis){
      var sub = raw[axis];
      // Two shapes: a named axis (scopes, domains, app, users) or a bare domain/default map.
      var named = sub && typeof sub === 'object' && !Array.isArray(sub);
      var rows = named ? Object.keys(sub).map(function(k){ return { key: axis + ' → ' + k, v: sub[k] }; })
                       : [{ key: axis, v: sub }];
      rows.forEach(function(r){
        var line = document.createElement('div'); line.className = 'mbrow';
        var t = document.createElement('span');
        var items = Array.isArray(r.v)
          ? r.v.map(function(x){ return typeof x === 'string' ? x : (x && x.label) || '?'; })
          : [];
        // An EMPTY rung is meaningful — it is the "everyone except these" idiom — so name it rather than
        // rendering an empty line that reads as a bug.
        t.textContent = r.key + ': ' + (items.length ? items.join(', ') : '(nothing — an exemption)');
        line.appendChild(t);
        wrap.appendChild(line);
      });
    });
    card.appendChild(wrap);
  }

  /**
   * MAKE A FLAT HALF TARGETED — the leap the builder could not previously make.
   *
   * A half written as a plain list applies to everyone, so it has no groups, and there was no way from
   * there to "add this entry only where the app is active" without hand-editing the JSON. The format has
   * always allowed it; the editor just could not get there.
   *
   * ⚠️ THE NEW GROUP IS SEEDED TOO, and that is the whole correctness of this function.
   *
   * The obvious construction — existing entries become the default, new group starts empty — is safe for
   * exactly as long as the new group stays empty, and silently wrong after the first edit. A DEFAULT IS
   * SUPPRESSED FOR ANYONE A RULE NAMES: match the new group and the default never fires, so the audience
   * being added to loses every shared entry at the moment something is added for them. That rule is not
   * an accident and union did not change it — it is what makes "these people get nothing" expressible at
   * all, and merging defaults into matched rungs would buy this case by making that one inexpressible.
   *
   * So converting copies the current list into BOTH the new group and the default. The invariant is
   * checkable rather than intentional: converting is a NO-OP ON THE RESOLVED PLAN for every persona —
   * asserted across the axis vocabulary in the tests, not just asserted here in prose.
   *
   * The honest cost, and it is the format's real shape rather than an editor defect: a shared entry now
   * lives in N groups, and changing it later means changing every copy. The UI says so at the point of
   * conversion, because that is the moment the operator is deciding.
   */
  function mbMakeTargeted(existing, axisName, key) {
    var map = {};
    map[key] = existing.slice();
    return {
      axes: [{ name: axisName, axisKey: axisName, order: [key], map: map }],
      top: { key: '*', list: existing.slice() },
      rest: {},
      keyOrder: [axisName, '*']
    };
  }

  // ── WHERE AN EDIT LANDS ────────────────────────────────────────────────────────────────────────────
  //
  // The composed picture merges every rule that applies to the persona on screen, so a tick is
  // structurally ambiguous in a way it never was inside a group: with two apps active, which rung takes
  // the hide? The old builder answered it by putting you physically inside a group, and that is the one
  // thing the picture gives up. This is what replaces it.
  //
  // STICKY, per menu half, per persona. The first edit to a half asks; the answer sticks until the persona
  // changes; while it is stuck a line under the picture names the target. The line is not decoration — a
  // sticky BROAD choice means later ticks silently widen to an audience the operator is not looking at,
  // and the line is the only thing keeping that honest.
  var mbFork = {};      // "<menu>|<half>" -> a target descriptor
  var mbAsk = null;     // the edit being HELD while the question is on screen
  var mbEditing = null; // the one added entry currently open in its form
  var mbChanges = [];   // this session's edits, in the order they were made

  function mbForkKey(mn, half) { return mn.name + '|' + half; }
  /** A target is {axis, key}; "all" is the flat half and "*" the whole-menu default. */
  function mbSameTarget(a, b) {
    if (!a || !b || a.axis !== b.axis) return false;
    return String(a.key === undefined ? '' : a.key).trim().toLowerCase()
      === String(b.key === undefined ? '' : b.key).trim().toLowerCase();
  }
  /** A persona change invalidates every answer: they were answers about ONE audience. */
  function mbResetForks() { mbFork = {}; mbAsk = null; mbEditing = null; }

  /**
   * A rung named in the OPERATOR'S terms, never as "axis → key".
   *
   * Two of the five axis values mean "everyone" differently — "all" is the flat form (the half IS the
   * list) and "*" is an object's default key. They read the same to an operator and serialize
   * differently, so this maps them to text rather than printing the pair. Nothing should ever render as
   * "all → *".
   */
  function mbSrcName(src) {
    if (!src) return 'nothing';
    if (src.axis === 'all') return 'everyone';
    if (src.axis === '*') return 'everyone else';
    var def = mbAxisDef(src.axis);
    var lbl = def ? def.label : src.axis;
    if (String(src.key).trim() === '*') return 'any ' + lbl;
    // No leading article: this is a NAME, and it lands in a chip ("hides: rule for Basic User") as often
    // as in a sentence. The one sentence that needs an article adds it — see mbTheName.
    if (src.axis === 'app') return src.key + ' rule';
    if (src.axis === 'scopes') return 'rule for ' + src.key;
    return src.key;
  }

  /** The same name inside a sentence. "the rule for Basic User" reads; "the everyone" does not. */
  function mbTheName(t) {
    var n = mbSrcName(t);
    return /^(everyone|any )/.test(n) ? n : 'the ' + n;
  }

  function mbNorm(s) { return String(s === null || s === undefined ? '' : s).trim().toLowerCase(); }
  /**
   * Scope matching, punctuation-insensitive — the rule normScope in menus.ts exists for, because cores
   * emit "Office Manager", "office_manager" and "officeManager" interchangeably. A capture is stored
   * under whatever spelling the token carried and looked up by whatever the picker offers; case-only
   * matching means a variant spelling is stored, never found, and the operator who did the masquerade
   * errand keeps being told to go and do it.
   *
   * A LOOKUP CONVENIENCE, never a resolution: no rule is selected by it and no rung is keyed on it.
   */
  function mbScopeKey(s) { return mbNorm(s).replace(/[^a-z0-9]+/g, ''); }
  /** The capture for a scope, tolerant of spelling. */
  function mbCapture(scope) {
    var want = mbScopeKey(scope);
    if (!want) return null;
    var keys = Object.keys(mbStock);
    for (var i = 0; i < keys.length; i++) {
      var c = mbStock[keys[i]];
      if (mbScopeKey((c && c.scope) || keys[i]) === want) return c;
    }
    return null;
  }
  function mbSame(a, b) { return mbNorm(a) === mbNorm(b); }
  function mbSameUrl(a, b) { return !!a && !!b && mbNorm(a.url) === mbNorm(b.url) && !!mbNorm(a.url); }

  function mbHalf(mn, half) {
    var st = mbState[mn.name] || {};
    return {
      st: st,
      rungs: half === 'hide' ? st.hideRungs : st.addRungs,
      flat: half === 'hide' ? st.hide : st.add,
      locked: half === 'hide' ? st.hideLocked : st.addLocked
    };
  }

  /** The live array behind one target, or null when this editor does not own it. Never creates. */
  function mbListFor(mn, half, t) {
    var h = mbHalf(mn, half);
    if (h.locked || !t) return null;
    if (t.axis === 'all') return h.rungs ? null : h.flat;
    if (!h.rungs) return null;
    if (t.axis === '*') return h.rungs.top ? h.rungs.top.list : null;
    for (var i = 0; i < h.rungs.axes.length; i++) {
      var ax = h.rungs.axes[i];
      if (ax.name !== t.axis) continue;
      for (var j = 0; j < ax.order.length; j++) {
        if (mbSame(ax.order[j], t.key)) return ax.map[ax.order[j]];
      }
    }
    return null;
  }

  /**
   * WHAT THIS PERSONA ALREADY GETS — the seed for any rung created underneath them, so that creating one
   * changes nobody's menu. Same invariant mbMakeTargeted holds for the flat case, arriving through the
   * other door.
   *
   * ⚠️ The apps hide list is the UNION of two settings and this editor owns only one of them. Seeding
   * from the EFFECTIVE list would copy PORTAL_APPS_HIDE into PORTAL_MENUS — a second home for a value
   * that already has one, and one that then drifts.
   */
  function mbSeedList(mn, half, v) {
    if (!v || !v.plan) return [];
    var plan = v.plan[mn.name] || { hide: [], add: [] };
    if (half === 'add') {
      // ⚠️ THE RAW FORMS, not the resolved ones. The preview resolves with no user facts, so every
      // server-side {variable} in plan.add has already been interpolated to empty — seeding from it
      // writes the EMPTIED url into the new rung and the result validates green. Same bug as the row
      // identity one, one layer down, and rawAdds was already on the reply and going unused.
      var src = (v.rawAdds && v.rawAdds[mn.name]) || plan.add || [];
      return mbClone(src).map(function(a){
        return { label: (a && a.label) || '', url: (a && a.url) || '', title: (a && a.title) || '' };
      });
    }
    var src = (mn.name === 'apps' && v.appsHide) ? v.appsHide.menus : plan.hide;
    return (src || []).slice();
  }

  /** The list behind a target, CREATING the rung — seeded — if it is not there yet. */
  function mbEnsure(mn, half, t) {
    var have = mbListFor(mn, half, t);
    if (have) return have;
    var h = mbHalf(mn, half);
    if (h.locked) return null;
    if (t.axis === 'all') return h.rungs ? null : h.flat;
    var seed = mbSeedList(mn, half, mbPreviewReply);
    // THE WHOLE-MENU DEFAULT IS A RUNG AND HAS NO AXIS. mbListFor knew that; this did not, so a target
    // naming it after the rung had been deleted fell through to the generic branch and pushed an axis
    // literally called "*" — emitted as {"*":{"*":[…]}}, which the validator rejects. Reachable through
    // the preview debounce: delete the "everyone else" rung, and for 250ms the stale provenance still
    // offers it as a fork option.
    if (t.axis === '*') {
      if (!h.rungs) return null;
      h.rungs.top = { key: (t.key && String(t.key).trim()) || '*', list: seed.slice() };
      mbNote('rule', mn, 'new rule — ' + mbSrcName(t), 'seeded from what that audience gets today');
      return h.rungs.top.list;
    }
    if (!h.rungs) {
      var made = mbMakeTargeted(h.flat, t.axis, t.key);
      if (half === 'hide') mbState[mn.name].hideRungs = made; else mbState[mn.name].addRungs = made;
      mbNote('rule', mn, 'new rule — ' + mbSrcName(t), 'seeded from what that audience already gets');
      return mbListFor(mn, half, t);
    }
    var ax = null;
    for (var i = 0; i < h.rungs.axes.length; i++) if (h.rungs.axes[i].name === t.axis) ax = h.rungs.axes[i];
    if (!ax) { ax = { name: t.axis, axisKey: t.axis, order: [], map: {} }; h.rungs.axes.push(ax); }
    ax.order.push(t.key);
    ax.map[t.key] = seed.slice();
    // ⚠️ "SEEDED FROM WHAT THAT AUDIENCE ALREADY GETS" WAS A FALSE CLAIM, and Fable proved it against the
    // real resolver: the seed is what the persona ON SCREEN gets, but the rung's audience is everyone it
    // names. Carve a domains rung while previewing an Office Manager, on a half that already has a
    // scopes rung, and the domains rung outranks it — the Reseller at that domain silently loses their
    // entries and gets the Office Manager's.
    //
    // NO SEED FIXES THIS. A rung holds ONE list for its whole audience, so where that audience is not
    // uniform today there is no value that leaves everyone unchanged. The honest move is to say what the
    // carve does and name who it takes over, which is computable from the config we already hold.
    var over = mbShadowed(mn, half, t);
    mbNote('rule', mn, 'new rule — ' + mbSrcName(t),
      over.length
        ? 'seeded from this persona; it now OVERRIDES ' + over.join(', ')
        : 'seeded from what that audience gets today');
    return ax.map[t.key];
  }

  /** Which editable rungs actually carry this item for this persona — where a removal has to act. */
  function mbOwners(mn, half, sources, match) {
    var out = [];
    (sources || []).forEach(function(src){
      var list = mbListFor(mn, half, src);
      if (!list) return;
      for (var i = 0; i < list.length; i++) if (match(list[i])) { out.push({ src: src, list: list }); return; }
    });
    return out;
  }

  /**
   * The options the fork question offers, derived from the persona rather than from a vocabulary.
   *
   * The rungs that ANSWERED come first: changing one of them is usually what an operator means, and it is
   * the option whose effect is already on screen. Then the carves, each of which is a rule that names
   * this reader — and each seeds from what they already get, so creating it changes nothing until the
   * held edit lands.
   *
   * The users axis is never offered. It stays preservation-tier by decision: visible and removable, never
   * a picker dimension and never a fork option, which is what keeps this question short.
   */
  function mbCandidates(mn, half, sources) {
    var out = [], seen = {};
    function push(t, label, note) {
      var k = t.axis + '|' + mbNorm(t.key);
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ t: t, label: label, note: note });
    }
    (sources || []).forEach(function(src){
      if (src.axis === 'all') {
        push({ axis: 'all' }, 'everyone', 'this menu is one list today, and it applies to every reader');
      } else if (src.axis === '*') {
        push({ axis: '*', key: src.key }, 'everyone else', 'the whole-menu default — every reader no other rule names');
      } else if (src.axis === 'scopes' && mbSame(src.key, mbPersona.scope)) {
        push({ axis: 'scopes', key: src.key }, 'the rule for ' + src.key, 'this rule already names exactly the reader you are previewing');
      } else {
        push({ axis: src.axis, key: src.key }, 'the shared rule ' + src.axis + ' → ' + src.key,
          'SHARED — every reader this rule names, not only the one on screen');
      }
    });
    var h = mbHalf(mn, half);
    if (!out.length) {
      if (!h.rungs) push({ axis: 'all' }, 'everyone', 'this menu has no rules yet, so one list is the simplest thing that works');
      else if (h.rungs.top) push({ axis: '*', key: h.rungs.top.key }, 'everyone else', 'the whole-menu default');
    }
    if (mbPersona.domain) {
      push({ axis: 'domains', key: mbPersona.domain }, 'just ' + mbPersona.domain,
        'a domain rule beats every scope and app rule for that domain');
    }
    if (mbPersona.scope) {
      push({ axis: 'scopes', key: mbPersona.scope }, 'just ' + mbPersona.scope,
        'applies to that scope on EVERY domain, and outranks the app rules');
    }
    // An app carve only where the persona names exactly one app state, because that is the only case
    // where "this audience" has a single app rung. Both on, and there is no one rung to mean.
    var act = mbPersona.apps.slice();
    if (act.length === 1 && MB_APPS.indexOf(act[0]) >= 0) {
      push({ axis: 'app', key: act[0] }, 'just where ' + act[0] + ' is active',
        'every domain running it, in every scope');
    } else if (!act.length && MB_APPS.indexOf('none') >= 0) {
      push({ axis: 'app', key: 'none' }, 'just where no app is active',
        'the audience an operator forgets to check');
    }
    return out;
  }

  /**
   * Which existing rungs on this half a new one would OUTRANK for its audience.
   *
   * Precedence is users → domains → scopes → app → default, and a rung wins OUTRIGHT rather than merging
   * — so a carve on a more specific axis takes over every reader it names, including ones who were being
   * answered by a rung further down. They get this rung's single list, seeded from one persona.
   *
   * This reads the operator's own config for structure only. It is not a second copy of precedence: the
   * ORDER is a fixed property of the format, and nothing here decides which rung answers anybody.
   */
  function mbShadowed(mn, half, t) {
    var order = ['users', 'domains', 'scopes', 'app'];
    var rank = order.indexOf(t.axis);
    if (rank < 0) return [];
    var h = mbHalf(mn, half);
    if (!h.rungs) return [];
    var out = [];
    h.rungs.axes.forEach(function(ax){
      var r = order.indexOf(ax.name);
      if (r <= rank) return;                       // same axis or more specific: not shadowed by this
      ax.order.forEach(function(k){ out.push(mbSrcName({ axis: ax.name, key: k })); });
    });
    if (h.rungs.top) out.push('the whole-menu default');
    return out;
  }

  /** Record one change for the rail. Derived from the action taken, never from a diff. */
  function mbNote(kind, mn, what, where) {
    mbChanges.push({ kind: kind, menu: mn.label, what: what, where: where || '' });
  }

  /** Run an edit, asking first if this half has no answer yet. The callback gets the list and the target. */
  function mbEdit(mn, half, run, describe) {
    var t = mbFork[mbForkKey(mn, half)];
    if (t) { mbApply(mn, half, t, run, describe); return; }
    mbAsk = { menu: mn.name, half: half, run: run, describe: describe };
    mbRebuild();
  }
  function mbApply(mn, half, t, run, describe) {
    var list = mbEnsure(mn, half, t);
    if (list) {
      run(list, t);
      if (describe) mbNote(describe.kind, mn, describe.what, mbSrcName(t));
    }
    mbRebuild();
  }
  function mbAnswer(mn, half, t) {
    mbFork[mbForkKey(mn, half)] = t;
    var p = mbAsk;
    mbAsk = null;
    if (p && p.menu === mn.name && p.half === half) mbApply(mn, half, t, p.run, p.describe);
    else mbRebuild();
  }

  /**
   * Removals act WHERE THE THING IS, not where the indicator points. Adding is the ambiguous direction —
   * a new entry could go in any rung — while "stop hiding this" has exactly one honest reading: take it
   * out of whichever rules are hiding it for this reader. If that is more than one rule, the rail says so.
   */
  function mbUnhide(mn, sources, label) {
    var owners = mbOwners(mn, 'hide', sources, function(x){ return mbSame(x, label); });
    owners.forEach(function(o){
      for (var i = o.list.length - 1; i >= 0; i--) if (mbSame(o.list[i], label)) o.list.splice(i, 1);
    });
    mbNote('hide', mn, 'stopped hiding ' + label,
      owners.map(function(o){ return mbSrcName(o.src); }).join(', '));
    mbRebuild();
  }
  function mbDropEntry(refs) {
    (refs || []).forEach(function(r){
      var i = r.list.indexOf(r.entry);
      if (i >= 0) r.list.splice(i, 1);
    });
  }
  function mbRemoveAdd(mn, sources, item) {
    var owners = mbOwners(mn, 'add', sources, function(x){ return mbSameUrl(x, item); });
    var refs = [];
    owners.forEach(function(o){
      for (var i = o.list.length - 1; i >= 0; i--) if (mbSameUrl(o.list[i], item)) refs.push({ list: o.list, entry: o.list[i] });
    });
    mbDropEntry(refs);
    mbNote('rm', mn, 'removed ' + (item.label || item.url),
      owners.map(function(o){ return mbSrcName(o.src); }).join(', '));
    mbRebuild();
  }

  // ── the composed picture, and the editing that happens in it ───────────────────────────────────────
  /**
   * Provenance, in the operator's terms. GREEN means "this rule names exactly the persona you are looking
   * at"; AMBER means it is shared with a wider audience — which every app rung is, since a rung applies
   * to every domain in that state. If green ever leaks onto a shared rung the chip stops carrying the one
   * warning it exists for.
   */
  function mbChip(list, what) {
    var c = document.createElement('span'); c.className = 'chip';
    if (!list.length) { c.textContent = what + ': nothing configured'; return c; }
    var names = list.map(function(x){ return mbSrcName(x); }).join(' + ');
    var exact = list.length === 1 && list[0].axis === 'scopes' && mbSame(list[0].key, mbPersona.scope);
    c.className = 'chip ' + (exact ? 'exact' : 'shared');
    c.textContent = what + ': ' + names;
    return c;
  }

  /** A row this editor does not own: drawn for accuracy, with no control and a reason. */
  function mbFixedRow(label, from) {
    var row = document.createElement('div'); row.className = 'fm fixed';
    var l = document.createElement('span'); l.className = 'lbl'; l.textContent = label;
    var t = document.createElement('span'); t.className = 'tag';
    t.textContent = from + ' · not config';
    row.appendChild(l); row.appendChild(t);
    return row;
  }

  /** The form for one added entry, opened in place of its row. */
  function mbEntryForm(mn, host) {
    var refs = mbEditing.refs;
    var e = refs[0] ? refs[0].entry : { label: '', url: '', title: '' };
    var wrap = document.createElement('div'); wrap.className = 'fmform';
    function inp(cls, ph, val, size) {
      var i = document.createElement('input');
      i.className = 'mbin ' + cls; i.placeholder = ph; i.value = val || ''; i.size = size;
      return i;
    }
    var lab = inp('mbin-label', 'Label', e.label, 14);
    var url = inp('mbin-url', 'https://…', e.url, 26);
    var ttl = inp('mbin-title', 'Tooltip (optional)', e.title, 16);
    function sync() {
      refs.forEach(function(r){
        r.entry.label = lab.value.trim(); r.entry.url = url.value.trim(); r.entry.title = ttl.value.trim();
      });
      // mbRender, NOT mbRebuild: replacing the DOM under someone mid-keystroke is the "the UI changed too
      // much" complaint in its purest form. The output and the validator keep up; the picture waits.
      mbRender();
    }
    // WHICH FIELD a variable lands in. All three accept them, so the chips insert into whichever was last
    // focused rather than always the url — a tooltip reading "Support for {name}" is the ordinary case,
    // and a chip that always wrote into the url would make it the awkward one.
    var lastField = url;
    [lab, url, ttl].forEach(function(i){
      i.addEventListener('input', sync);
      i.addEventListener('focus', function(){ lastField = i; });
      wrap.appendChild(i);
    });
    mbBtn('Done', function(){
      var cur = refs[0] ? refs[0].entry : null;
      // An entry with no label or no url is not config — mbConfig drops it — so do not leave a ghost of
      // one in the state where it would come back as an empty row on the next structural edit.
      if (!cur || !cur.label || !cur.url) mbDropEntry(refs);
      else mbNote(mbEditing.isNew ? 'add' : 'edit', mn, cur.label, mbEditing.where || '');
      mbEditing = null;
      mbRebuild();
    }, wrap, 'act');
    mbBtn('Remove', function(){
      mbDropEntry(refs);
      mbEditing = null;
      mbRebuild();
    }, wrap, 'act rm');
    host.appendChild(wrap);

    // ── the placeholders, at the point of use ─────────────────────────────────────────────────────────
    // They were documented in the reference and nowhere near the box you type a url into, so the feature
    // existed for whoever had already read about it. Each chip names what it fills and inserts AT THE
    // CARET, because appending to the end is wrong for every url that has a query string after it.
    var vars = document.createElement('div'); vars.className = 'fmvars';
    var vh = document.createElement('span'); vh.className = 'dim'; vh.textContent = 'Insert:';
    vars.appendChild(vh);
    MB_VARS.forEach(function(mv){
      var tok = '{' + mv.v + '}';
      var b = mbBtn(tok, function(){
        var f = lastField || url;
        var val = f.value || '';
        var at = typeof f.selectionStart === 'number' ? f.selectionStart : val.length;
        var to = typeof f.selectionEnd === 'number' ? f.selectionEnd : at;
        f.value = val.slice(0, at) + tok + val.slice(to);
        sync();
        f.focus();
        if (f.setSelectionRange) f.setSelectionRange(at + tok.length, at + tok.length);
      }, vars, 'varchip');
      b.title = tok + ' \u2014 ' + mv.h;
    });
    host.appendChild(vars);
    var vn = document.createElement('div'); vn.className = 'fmfoot';
    vn.textContent = 'Filled per signed-in user, from their own record. Hover one to see what it fills; '
      + 'PORTAL_MENUS on the Config tab has the full rules.';
    host.appendChild(vn);

    if (refs.length > 1) {
      var n = document.createElement('div'); n.className = 'fmfoot';
      n.textContent = 'This entry is written in ' + refs.length + ' rules and all of them change together.';
      host.appendChild(n);
    }
  }

  /**
   * THE COMPOSED MENU — what this persona actually gets, hides and adds in ONE picture, and the place the
   * editing happens. A hidden entry is a struck-through row IN the menu; an added entry is a marked row
   * IN the menu. That is the whole layout decision: they were two structurally identical sections with
   * same-weight headings, and restyling would only have made the duplication prettier.
   */
  function mbComposed(mn, card) {
    var v = mbPreviewReply;
    var bad = mbPreviewNotice(v);
    if (bad) {
      // NEVER an empty menu. An empty plan drawn as a menu says "nothing is hidden and nothing is added",
      // which is a confident wrong answer when the truth is that we could not ask.
      var p = document.createElement('div'); p.className = 'pv-bad'; p.textContent = bad.text;
      card.appendChild(p);
      return;
    }
    if (!v || !v.plan) {
      var w = document.createElement('p'); w.className = 'dim';
      w.textContent = 'Building the preview…';
      card.appendChild(w);
      return;
    }
    var plan = v.plan[mn.name] || { hide: [], add: [] };
    var matched = (v.matched && v.matched[mn.name]) || { hide: [], add: [] };
    var stock = mbStockFor(mn);
    var live = stock.live;

    var chips = document.createElement('div'); chips.className = 'card-head';
    chips.appendChild(mbChip(matched.hide, 'hides'));
    chips.appendChild(mbChip(matched.add, 'adds'));
    card.appendChild(chips);

    // TWO EMPTIES ARE DIFFERENT FACTS. An empty list WITH a source is an exemption — someone deliberately
    // gets nothing. An empty list from the default is just an empty default. Different fixes, so they
    // must not share a sentence.
    if (!plan.add.length && matched.add.length) {
      var why = matched.add[0];
      var e = document.createElement('p'); e.className = 'dim';
      e.textContent = why.axis === '*' || why.axis === 'all'
        ? 'Nothing is added for anyone — the default is empty.'
        : 'Nothing is added for this audience — an exemption, written as an empty rule.';
      card.appendChild(e);
    }

    // ⚠️ A MENU IS MODIFIED, NEVER CREATED — and until now nothing said so. Every applier in the injected
    // bundle starts by FINDING its menu and returns when it is not there, so an add aimed at a menu this
    // reader does not have simply does not happen. Drawing a panel for it invites the opposite belief: it
    // looks like somewhere an entry could go. Which sentence is honest depends on where the emptiness came
    // from — a capture is evidence about THAT ROLE, the reader's own page is evidence about nobody else.
    if (!live.present) {
      var np = document.createElement('p'); np.className = 'dim';
      np.textContent = stock.src
        ? 'Your capture of ' + (stock.src.scope || mbPersona.scope) + ' has no ' + mn.label + ' menu, so '
          + 'this role does not get one. Nothing configured here will appear for them: an entry is added to '
          + 'a menu that already exists, and the kit never creates one.'
        : 'This menu is not on the page you opened the console from, so only your config is '
          + 'drawn below — the portal’s own entries could not be read. Note that an entry is only ever '
          + 'added to a menu the reader already has; where the portal does not give them this menu, '
          + 'nothing configured here appears. Remember this role while masquerading to find out which.';
      card.appendChild(np);
    }

    var menu = document.createElement('div'); menu.className = 'fake';
    var hidden = {};
    plan.hide.forEach(function(h){ hidden[mbNorm(h)] = 1; });
    var legacy = {};
    if (mn.name === 'apps' && v.appsHide) (v.appsHide.legacy || []).forEach(function(h){ legacy[mbNorm(h)] = 1; });

    // WITHHELD, not silently dropped. The list this reads is one session's DOM, so an entry the portal
    // only shows to a Reseller is still in it while previewing an Office Manager — confusing in the one
    // direction that costs something, because it invites a hide rule for a row that is not there. What is
    // taken out is named below the menu; a picture that quietly shrinks is a different lie.
    var withheld = [];
    var entries = live.entries.filter(function(e){
      var seenBy = MB_FLOOR[mbNorm(e)];
      if (!seenBy || !mbPersona.scope) return true;
      for (var wi = 0; wi < seenBy.length; wi++) if (mbSame(seenBy[wi], mbPersona.scope)) return true;
      withheld.push(e);
      return false;
    });
    var soIdx = -1;
    // ⚠️ DOUBLE THE BACKSLASHES. This script is emitted from a PLAIN template literal, not String.raw —
    // so a lone backslash never reaches the browser. This regex read /^logs*out<backspace>/i for its
    // whole life, matching nothing a portal renders, so added entries were appended at the end of the
    // account menu in the preview instead of above the divider before Log Out. kit.ts has the same
    // regex and is correct, because that file uses String.raw — which is why the LIVE menu placed them
    // properly and only the picture was wrong.
    for (var i = 0; i < entries.length; i++) if (/^log\\s*out\\b/i.test(entries[i])) { soIdx = i; break; }
    var insertAt = (mn.name !== 'management' && soIdx >= 0) ? soIdx : entries.length;

    function stockRow(label) {
      var lc = mbNorm(label);
      var isHidden = !!hidden[lc], isLegacy = !!legacy[lc];
      var row = document.createElement('div'); row.className = 'fm' + (isHidden ? ' hid' : '');
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = isHidden;
      var owners = isHidden ? mbOwners(mn, 'hide', matched.hide, function(x){ return mbSame(x, label); }) : [];
      if (isHidden && !owners.length) {
        // Ticked and not ours to untick. Disabled with a reason beats a control that silently does
        // nothing — this is the PORTAL_APPS_HIDE case, and the carried-through-rung case.
        cb.disabled = true;
        cb.title = isLegacy
          ? 'Hidden by PORTAL_APPS_HIDE, which is a separate setting this builder does not edit.'
          : 'Hidden by a rule this editor cannot round-trip — it is listed under Rules.';
      } else {
        cb.addEventListener('change', function(){
          if (cb.checked) {
            mbEdit(mn, 'hide', function(list){
              for (var k = 0; k < list.length; k++) if (mbSame(list[k], label)) return;
              list.push(label);
            }, { kind: 'hide', what: 'hid ' + label });
          } else {
            mbUnhide(mn, matched.hide, label);
          }
        });
      }
      var l = document.createElement('span'); l.className = 'lbl'; l.textContent = label;
      var t = document.createElement('span'); t.className = 'tag';
      t.textContent = !isHidden ? 'stock'
        : isLegacy && owners.length ? 'hidden · PORTAL_APPS_HIDE + your rule'
        : isLegacy ? 'hidden · PORTAL_APPS_HIDE'
        : owners.length ? 'hidden · ' + owners.map(function(o){ return mbSrcName(o.src); }).join(' + ')
        : 'hidden';
      row.appendChild(cb); row.appendChild(l); row.appendChild(t);
      return row;
    }

    /**
     * The first argument is what the READER would get; the second is the same entry AS WRITTEN, from the
     * endpoint's rawAdds.
     * They differ whenever a url carries a {variable} — the preview resolves with no user facts, so every
     * server-side placeholder renders empty. Matching a drawn row to its config entry by the resolved url
     * therefore failed on exactly the entries that use the feature, and the row said "not editable here".
     * The identity is the written form, and only the resolver can supply it.
     */
    function addRow(it, key) {
      var row = document.createElement('div'); row.className = 'fm add';
      var ident = key || it;
      var owners = mbOwners(mn, 'add', matched.add, function(x){ return mbSameUrl(x, ident); });
      var l = document.createElement('span'); l.className = 'lbl'; l.textContent = it.label || '(unnamed)';
      var t = document.createElement('span'); t.className = 'tag';
      t.textContent = 'added' + (owners.length ? ' · ' + owners.map(function(o){ return mbSrcName(o.src); }).join(' + ') : '');
      row.appendChild(l); row.appendChild(t);
      if (!owners.length) {
        var lockNote = document.createElement('span'); lockNote.className = 'tag';
        lockNote.textContent = '· not editable here';
        row.appendChild(lockNote);
        return row;
      }
      mbBtn('edit', function(){
        var refs = [];
        owners.forEach(function(o){
          for (var i2 = 0; i2 < o.list.length; i2++) if (mbSameUrl(o.list[i2], ident)) refs.push({ list: o.list, entry: o.list[i2] });
        });
        mbEditing = { menu: mn.name, refs: refs, isNew: false, hideUrls: [mbNorm(ident.url)],
                      where: owners.map(function(o){ return mbSrcName(o.src); }).join(', ') };
        mbRebuild();
      }, row, 'act');
      mbBtn('remove', function(){ mbRemoveAdd(mn, matched.add, ident); }, row, 'act rm');
      return row;
    }

    var editingHere = mbEditing && mbEditing.menu === mn.name;
    var skip = (editingHere && mbEditing.hideUrls) || [];
    for (var a1 = 0; a1 < insertAt; a1++) menu.appendChild(stockRow(entries[a1]));
    // rawAdds is index-aligned with plan.add by construction on the server, so pair them BEFORE any
    // filtering — filter first and the indexes no longer mean the same thing.
    var rawAdds = (v.rawAdds && v.rawAdds[mn.name]) || [];
    var drawnAdds = plan.add
      .map(function(it, i){ return { it: it, key: rawAdds[i] || it }; })
      .filter(function(p){ return skip.indexOf(mbNorm(p.key.url)) < 0; });
    if (drawnAdds.length) {
      if (insertAt > 0) { var d1 = document.createElement('div'); d1.className = 'fmdiv'; menu.appendChild(d1); }
      drawnAdds.forEach(function(p){ menu.appendChild(addRow(p.it, p.key)); });
    }
    if (editingHere) {
      var d3 = document.createElement('div'); d3.className = 'fmdiv'; menu.appendChild(d3);
      mbEntryForm(mn, menu);
    }
    // ── what the kit itself appends, in the order it appends it ───────────────────────────────────────
    // Downloads first (getting the app is the common errand), then the sign-in block. Both are ours and
    // neither is editable here: they are a feature, not a menu entry, and there is nothing in PORTAL_MENUS
    // to change. Shown because leaving them out makes the picture wrong in the direction that costs
    // something — an operator adding a link the menu already has.
    // ⚠️ THAT app, not ANY app. These rows are one integration's sign-in block; with a second integration
    // active on its own they were still drawn, which had the picture promising a sign-in panel the portal
    // would never render there (David, toggling documo alone).
    var appOn = mn.name === 'apps' && !!MB_INJECTED.app
      && mbPersona.apps.indexOf(MB_INJECTED.app) >= 0;
    if (appOn && (MB_INJECTED.downloads || MB_INJECTED.signIn)) {
      var dk = document.createElement('div'); dk.className = 'fmdiv'; menu.appendChild(dk);
      if (MB_INJECTED.downloads) menu.appendChild(mbFixedRow('Download ' + MB_INJECTED.label, 'app integration'));
      if (MB_INJECTED.signIn) {
        menu.appendChild(mbFixedRow('Sign in details for ' + MB_INJECTED.label, 'app integration'));
      }
    }
    if (insertAt < entries.length) {
      var d2 = document.createElement('div'); d2.className = 'fmdiv'; menu.appendChild(d2);
      for (var a2 = insertAt; a2 < entries.length; a2++) menu.appendChild(stockRow(entries[a2]));
    }
    if (!entries.length && !drawnAdds.length && !editingHere) {
      var em = document.createElement('div'); em.className = 'fmfoot';
      em.textContent = 'Nothing to show for this audience.';
      menu.appendChild(em);
    }
    // HIDES NAMING LABELS THAT ARE NOT HERE are real config and must stay visible — the menu relabels
    // itself by context, so a hide that matches nothing on this page can be doing its job elsewhere. In
    // the rail this degrades to a count; at the menu's foot it keeps its name and stays un-hideable by
    // accident.
    // Withheld rows count as PRESENT for this: a hide naming one is doing its job on the page, it is just
    // not drawn for the scope being previewed. Counting them absent would move a working rule into a list
    // headed "not on this page", which is the withholding turning into a second, worse inaccuracy.
    var onPage = entries.concat(withheld);
    var absent = plan.hide.filter(function(h){
      for (var i2 = 0; i2 < onPage.length; i2++) if (mbSame(onPage[i2], h)) return false;
      return true;
    });
    if (absent.length) {
      var af = document.createElement('div'); af.className = 'fmfoot';
      af.textContent = 'Also hidden by your config, not on this page: ' + absent.join(', ');
      menu.appendChild(af);
    }
    if (withheld.length) {
      var wf = document.createElement('div'); wf.className = 'fmfoot';
      wf.textContent = 'Not drawn for this scope, though your own session has it: ' + withheld.join(', ') + '.';
      menu.appendChild(wf);
    }
    // The way in for an entry that is not on this page, and the way in for a new one. Both go through the
    // same fork question, so neither can quietly widen a rule.
    // ⚠️ TWO CONTROLS FOR TWO DIFFERENT HALVES, on two rows. They sat side by side with ONE button
    // between them, so the button beside the hide box belonged to the add half and the hide box
    // responded only to Enter — David, reading his own menu: "are they supposed to click Add an entry to
    // add? It's a little confusing between adding a custom Hide entry and adding a new item entry."
    // Each half now owns its own row and its own button, and neither is reachable by a control that
    // belongs to the other.
    if (!editingHere) {
      var foot = document.createElement('div'); foot.className = 'fmfoot';
      mbBtn('Add an entry…', function(){
        mbEdit(mn, 'add', function(list, t){
          var e2 = { label: '', url: '', title: '' };
          list.push(e2);
          mbEditing = { menu: mn.name, refs: [{ list: list, entry: e2 }], isNew: true, hideUrls: [],
                        where: mbSrcName(t) };
        }, null);
      }, foot, 'btn');
      menu.appendChild(foot);

      // Hiding by name is for the entry that is NOT on this page — the menu relabels itself by context,
      // and another injection may add rows this page load did not show.
      var hfoot = document.createElement('div'); hfoot.className = 'fmfoot';
      var hb = document.createElement('input');
      hb.className = 'mbin mbin-hide'; hb.placeholder = 'Hide an entry by name'; hb.size = 20;
      function hideByName() {
        var val = hb.value.trim();
        if (!val) return;
        mbEdit(mn, 'hide', function(list){
          for (var k = 0; k < list.length; k++) if (mbSame(list[k], val)) return;
          list.push(val);
        }, { kind: 'hide', what: 'hid ' + val });
      }
      hb.addEventListener('keydown', function(ev){
        if (ev.key !== 'Enter') return;
        if (ev.preventDefault) ev.preventDefault();
        hideByName();
      });
      hfoot.appendChild(hb);
      mbBtn('Hide it', hideByName, hfoot, 'btn');
      menu.appendChild(hfoot);
    } else {
      menu.appendChild(document.createElement('div'));
    }
    card.appendChild(menu);

    // Where the next edit lands, per half, and the question that decides it.
    mbWhere(mn, 'hide', card);
    mbWhere(mn, 'add', card);
    if (mbAsk && mbAsk.menu === mn.name) mbForkPrompt(mn, mbAsk.half, matched, card);
  }

  /**
   * ⚠️ THE ONE THING THIS VIEW CANNOT KNOW, said where it cannot be missed.
   *
   * The rules are exact — the Worker resolves them for the persona asked for. The STOCK ENTRIES are not:
   * they are whatever was on the page this console was opened from, read as whoever opened it. Preview
   * another role and the portal may give that role entries this account never renders, and there is no
   * way to find out from here. Without this line the picture invites exactly the wrong belief — that it
   * is what that person sees — which is worse than the old builder's honest list of labels.
   *
   * Under the persona bar rather than on each menu: it is a fact about WHO you are previewing, and three
   * copies of one sentence is the duplication this rebuild removed.
   */
  /**
   * The entries to draw for THIS persona: a capture for their scope when one exists, otherwise the
   * reader's own page.
   *
   * The capture is the better answer and is still not a perfect one — it is a snapshot, and it was taken
   * through a masquerade, which some portals render differently from a real sign-in. So it never replaces
   * the caveat, it changes what the caveat says.
   */
  function mbStockFor(mn) {
    var cap = mbCapture(mbPersona.scope);
    if (cap && cap.menus && cap.menus[mn.name]) return { src: cap, live: cap.menus[mn.name] };
    return { src: null, live: (mbLive && mbLive[mn.name]) || { present: false, entries: [] } };
  }
  /** A capture's age in the reader's own words. A snapshot that does not say when it was taken is the
   *  next wrong answer, and "3 days ago" is the form that makes staleness obvious at a glance. */
  function mbAgo(ms) {
    var d = Math.floor((new Date().getTime() - ms) / 86400000);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    return d + ' days ago';
  }

  /**
   * ADOPT THE CAPTURE'S OWN CONTEXT. A capture carries a role's real entries AND the session they were
   * read from; pairing the first with whatever the persona bar happened to be set to is how a Basic User
   * on a domain with no app still had that app's entry struck through — the toggles default to every
   * available app, and the resolver did exactly as asked.
   *
   * The domain is a fact the token carried. The app state is an INFERENCE with one bit of evidence, so it
   * is only acted on where that bit is unambiguous, and the caveat says which case applies rather than
   * presenting a guess as a reading.
   */
  function mbAdopt() {
    var key = mbScopeKey(mbPersona.scope);
    var cap = mbCapture(mbPersona.scope);
    if (!cap || mbAdopted[key]) return false;
    mbAdopted[key] = true;
    // ⚠️ THE DOMAIN IS OFFERED, NOT ADOPTED (David, 2026-08-11). A capture is about a ROLE; filling its
    // domain in silently adds a second dimension to what you are editing, and a domains rung outranks
    // everything — so the preview and the fork's narrower option both become specific to one customer
    // without anyone choosing that. Marking it made the narrowing visible; not doing it makes the
    // narrowing a decision. The offer sits in the caveat line, one click away, where the fact it came
    // from is written down anyway.
    var moved = false;
    if (cap.appRows === false && mbPersona.apps.length) { mbPersona.apps = []; moved = true; }
    else if (cap.appRows === true && MB_AVAIL.length === 1 && !mbPersona.apps.length) {
      mbPersona.apps = MB_AVAIL.slice(); moved = true;
    }
    // A PERSONA CHANGE RESETS THE FORK ANSWERS — and this is one, arriving through a door that is not the
    // persona bar. Every other route to a changed persona goes through changed(), which resets first; if
    // this one did not, a sticky answer about one audience would survive onto another.
    if (moved) { mbResetForks(); mbSyncBar(); }
    return moved;
  }
  /**
   * The domain field's own state: whether it was filled FOR the operator, and the way out.
   *
   * ⚠️ An auto-filled domain is not a cosmetic detail. A domains rung outranks every other rule, so a
   * domain sitting in this box quietly makes both the preview and the fork's carve options specific to
   * it — an operator trying to make a fleet-wide change would be looking at one customer and offered
   * "just that customer" as the narrower option. It was filled by a capture, which is correct and
   * useful; it just must not be missed.
   */
  function mbDomainBox() {
    var box = document.getElementById('spkmb-domain');
    var clear = document.getElementById('spkmb-domclear');
    var note = document.getElementById('spkmb-domnote');
    if (!box) return;
    // ⚠️ NOTHING FILLS THIS FIELD BUT THE OPERATOR. It used to adopt a capture's domain, marked amber
    // with a line explaining the risk — and the mark existed only because the narrowing was not chosen.
    // Removing the fill removes the reason for the mark, the note, and a bug David found: adopt-once is
    // per capture, so switching to a SECOND captured role filled the field again and a Clear never
    // survived. What is left is the offer in the caveat line, and this Clear.
    box.className = '';
    if (clear) {
      clear.textContent = '';
      if ((mbPersona.domain || '').trim()) {
        mbBtn('Clear', function(){
          mbPersona.domain = '';
          mbResetForks();
          // The FIELD too. Nothing else rewrites an input's value, so clearing only the persona left the
          // old domain sitting on screen while the preview had stopped using it — the two disagreeing
          // about what is being previewed, which is the failure this whole panel exists to prevent.
          mbSyncBar();
          mbRebuild();
        }, clear, 'domclear');
      }
    }
    if (!note) return;
    note.textContent = '';

    // ── the domains the captures came from, offered to ANY role (David, 2026-08-11) ──────────────────
    //
    // Under the field, because it is about the field. Across every capture rather than only the role on
    // screen: a domain is a domain, and previewing an Office Manager against a domain you happened to
    // capture a Basic User on is a perfectly ordinary thing to want. Offered, never applied — a domains
    // rung outranks everything, so narrowing to one has to be a decision rather than a side effect of
    // having captured something.
    // Most recently captured first — with several to choose from, the one you just took is the one you
    // are most likely to want next.
    var seen = {}, doms = [];
    mbCaptured().slice().sort(function(a, b2){ return (mbStock[b2].at || 0) - (mbStock[a].at || 0); }).forEach(function(k){
      var d = (mbStock[k].domain || '').trim();
      if (!d || seen[mbNorm(d)]) return;
      seen[mbNorm(d)] = 1;
      doms.push(d);
    });
    var offer = doms.filter(function(d){ return mbNorm(d) !== mbNorm(mbPersona.domain); });
    if (!offer.length) return;
    note.className = 'dim';
    note.appendChild(document.createTextNode(doms.length > 1 ? 'Captured from: ' : 'Captured from '));
    offer.forEach(function(d, i){
      if (i) note.appendChild(document.createTextNode(' '));
      mbBtn(d, function(){
        mbPersona.domain = d;
        mbResetForks();
        mbSyncBar();
        mbRebuild();
      }, note, 'domclear');
    });
  }

  /** Push the persona back onto its own controls, after something other than a click changed it. */
  function mbSyncBar() {
    var dom = document.getElementById('spkmb-domain');
    if (dom) dom.value = mbPersona.domain || '';
    var apps = document.getElementById('spkmb-apps');
    if (!apps) return;
    var bs = apps.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      bs[i].setAttribute('aria-pressed', mbPersona.apps.indexOf(bs[i].textContent) >= 0 ? 'true' : 'false');
    }
  }

  /**
   * ARMING CAPTURE, from the one place that exists before a masquerade.
   *
   * The mode decides only whether the button is OFFERED while masked; the capture itself is always a
   * click, so there is no ambient behaviour to go stale and nothing here needs an expiry. What this
   * panel owes in exchange is an answer to "did that one take?", which is why it lists what is stored
   * and when rather than just carrying a checkbox.
   */
  function mbCapturePanel() {
    if (!mbCapEl) return;
    mbCapEl.textContent = '';
    var mode = mbStock.__mode && mbStock.__mode.on;
    var lab = document.createElement('label');
    lab.style.cssText = 'display:flex;gap:.4rem;align-items:baseline;cursor:pointer';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!mode;
    cb.addEventListener('change', function(){
      if (!HOSTED) return;
      window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.stockRequest}',
        ${SPK_BRIDGE.stockKey}: { mode: cb.checked } }, '*');
    });
    var t = document.createElement('span');
    t.textContent = mode
      ? 'Capture is armed. While you are masquerading, a "Remember this role" button sits beside End Masquerade — click it when the page looks right, then come back here.'
      : 'Arm capture before you masquerade, and a "Remember this role" button appears beside End Masquerade while you are.';
    lab.appendChild(cb); lab.appendChild(t);
    mbCapEl.appendChild(lab);

    // WHAT IS ACTUALLY STORED. The whole errand is worthless if you cannot tell whether it worked, and
    // the entry count is what makes a capture taken mid-load visible instead of authoritative.
    var have = mbCaptured();
    var line = document.createElement('span'); line.className = 'dim';
    line.style.cssText = 'display:block;margin-top:.3rem;font-size:.85rem';
    if (!have.length) {
      line.textContent = 'Nothing captured yet, so every role below is drawn from your own menus.';
      mbCapEl.appendChild(line);
      return;
    }
    // THE ROLE IS THE THING BEING SCANNED FOR — the counts and ages are what you read once you have found
    // the row you wanted, so the name carries the weight and the rest stays dim.
    line.appendChild(document.createTextNode('Captured: '));
    have.forEach(function(k, i){
      var c = mbStock[k];
      var n = 0;
      Object.keys(c.menus || {}).forEach(function(m){ n += ((c.menus[m] || {}).entries || []).length; });
      if (i) line.appendChild(document.createTextNode(' \u00b7 '));
      var nm = document.createElement('strong'); nm.textContent = c.scope;
      line.appendChild(nm);
      line.appendChild(document.createTextNode(' (' + n + ' entries, ' + mbAgo(c.at) + ')'));
    });
    line.appendChild(document.createTextNode('. '));

    /**
     * START FRESH. Deliberately understated — it is for debugging and for people who like a clean slate,
     * not a thing to reach for by accident.
     *
     * ⚠️ TWO CLICKS, NOT A confirm(). This frame is sandboxed WITHOUT allow-modals (kit.ts sets
     * "allow-scripts allow-popups"), so confirm() and alert() are blocked here — the same class of fact
     * that made the Copy button silently do nothing for months, and localStorage unavailable. A
     * confirmation that never appears would either destroy the captures without asking or do nothing at
     * all, depending on how the browser refuses.
     *
     * It forgets the CAPTURES and keeps the arming: one is data the operator gathered by walking around
     * the portal, the other is a preference about how the tool behaves.
     */
    var armToo = mbStock.__mode && mbStock.__mode.on;
    var b = mbBtn(mbForget ? 'Click again to forget them' : 'Forget all captures', function(){
      if (!mbForget) { mbForget = true; mbRebuild(); return; }
      mbForget = false;
      if (HOSTED) {
        window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.stockRequest}',
          ${SPK_BRIDGE.stockKey}: { clear: true } }, '*');
      }
    }, line, mbForget ? 'domclear warn' : 'domclear');
    b.title = 'Deletes the captured menus from this browser'
      + (armToo ? '. Capture stays armed.' : '.');
    mbCapEl.appendChild(line);
  }

  /** The captured roles, in the order they are stored — everything that is not the mode flag. */
  function mbCaptured() {
    return Object.keys(mbStock).filter(function(k){ return k !== '__mode' && mbStock[k] && mbStock[k].scope; });
  }

  /**
   * Mark the roles you have a capture for, in the picker itself.
   *
   * ⚠️ BOLD AND A WORD, not bold alone. font-weight on an <option> is honoured by some browsers and
   * ignored by others — macOS renders that dropdown with the native menu, which drops most styling —
   * and a signal that is invisible on the machine the operator uses is not a signal. The text always
   * renders, so the text carries it and the weight is a bonus where it lands.
   *
   * Rebuilt from option.value every time rather than appended to, or a second pass would say
   * "Basic User (captured) (captured)". The VALUE is untouched, which is what the persona reads.
   */
  function mbMarkScopes() {
    var sel = document.getElementById('spkmb-scope');
    if (!sel) return;
    var opts = sel.options || [];
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      // Strip before appending as well as rebuilding from the VALUE. Rebuilding alone is already
      // idempotent, but the value is the one thing here another pass could dirty, and the failure it
      // would produce — "Basic User (captured) (captured)" — is silent and permanent once it happens.
      var base = String(o.value || '').replace(/\\s*\\(captured\\)\\s*$/, '');
      var has = !!mbCapture(base);
      o.value = base;
      o.textContent = base + (has ? ' (captured)' : '');
      o.style.fontWeight = has ? '700' : '';
    }
  }

  function mbCaveat() {
    if (!mbCaveatEl) return;
    var mine = mbPersona.scope && MB_ME && mbSame(mbPersona.scope, MB_ME);
    if (!mbPersona.scope || mine) { mbCaveatEl.hidden = true; mbCaveatEl.textContent = ''; return; }
    mbCaveatEl.hidden = false;
    mbCaveatEl.textContent = '';
    var cap = mbCapture(mbPersona.scope);
    var b = document.createElement('strong');
    var t = document.createElement('span');
    if (cap) {
      // CAPTURED: the entries are that role's own, and the remaining caveats are age and the masquerade.
      // Both are real and neither is a reason to hide the date — a snapshot presented as current is the
      // failure this whole line exists to prevent, one level up.
      b.textContent = 'Drawn from a capture of ' + cap.scope
        + (cap.domain ? ' on ' + cap.domain : '') + ', taken ' + mbAgo(cap.at) + '.';
      // WHAT WAS CAPTURED vs WHAT WAS INFERRED, kept apart. The entries and the domain came off that
      // session; which apps were active is one bit of evidence, and saying so is what stops the next
      // confusion after the one this fixed.
      // "AN", not "the" (David) — with more than one available, the definite article claims a specific
      // integration in the same breath as saying we cannot tell which. And where only one is available
      // we can do better than an article at all: name it.
      var app = cap.appRows === true
        ? (MB_AVAIL.length === 1
          ? ' ' + MB_AVAIL[0] + ' was on that page, so the toggle above is set to match.'
          : ' An app integration was on that page, but the capture cannot tell which of them — set the toggles above yourself.')
        : ' No app rows were on that page, so the toggles above are set to none. That is an inference, not '
          + 'a reading: a session whose own bundle did not load looks the same. Set them yourself if it is wrong.';
      t.textContent = ' These are the entries that role really had, read off their own page while you were '
        + 'masquerading — not yours.' + app + ' Two things it still cannot promise: the portal may have '
        + 'changed since, and a masqueraded session is not always rendered identically to a real sign-in. '
        + 'Capture again from that role to refresh it.';
    } else {
      b.textContent = 'The rules below are exact. The stock entries are not.';
      t.textContent = ' You are previewing as ' + mbPersona.scope + ' and you are signed in as ' + MB_ME
        + '. Every entry drawn as stock came off the page you opened this console from, as you — so someone '
        + 'at that scope may have menu entries your own account never renders, and this cannot know what '
        + 'they are. To fix it for good: masquerade as someone at that scope and use "Remember this '
        + 'role\u2019s menus" in the portal menu, then come back here. Meanwhile the few known to be '
        + 'senior-only are left out and named under their menu, and a hide still works on the rest — add '
        + 'it by name.';
    }
    mbCaveatEl.appendChild(b);
    mbCaveatEl.appendChild(t);
  }

  function mbWhere(mn, half, card) {
    var t = mbFork[mbForkKey(mn, half)];
    if (!t) return;
    var p = document.createElement('p'); p.className = 'mbwhere';
    var a = document.createElement('span');
    a.textContent = (half === 'hide' ? 'Hiding' : 'Adding') + ' lands in ';
    var b = document.createElement('span'); b.className = 'tgt'; b.textContent = mbTheName(t);
    p.appendChild(a); p.appendChild(b);
    mbBtn('change', function(){ delete mbFork[mbForkKey(mn, half)]; mbRebuild(); }, p, 'act');
    card.appendChild(p);
  }

  function mbForkPrompt(mn, half, matched, card) {
    var box = document.createElement('div'); box.className = 'mbfork';
    var q = document.createElement('strong');
    q.textContent = half === 'hide' ? 'Which rule should hide it?' : 'Which rule should carry it?';
    box.appendChild(q);
    var lead = document.createElement('p'); lead.className = 'dim';
    lead.textContent = 'Asked once. The answer sticks until you change who you are previewing as, and the '
      + 'line under the menu says where edits are going while it does.';
    box.appendChild(lead);
    mbCandidates(mn, half, half === 'hide' ? matched.hide : matched.add).forEach(function(c){
      mbBtn(c.label, function(){ mbAnswer(mn, half, c.t); }, box, 'copy-btn opt');
      var n = document.createElement('span'); n.className = 'optnote';
      // The consequence AT THE MOMENT OF DECIDING, not in a note afterwards. A rung wins outright rather
      // than merging, so a carve on a more specific axis takes over readers another rung was answering —
      // and it can only give them the one list seeded from the persona on screen.
      var over = mbListFor(mn, half, c.t) ? [] : mbShadowed(mn, half, c.t);
      n.textContent = c.note
        + (over.length
          ? ' ⚠ It would OVERRIDE ' + over.join(', ') + ' for that audience — they would get this list instead of theirs.'
          : '');
      box.appendChild(n);
    });
    mbBtn('Cancel', function(){ mbAsk = null; mbRebuild(); }, box, 'act');
    card.appendChild(box);
  }

  function mbCard(mn) {
    var st = mbState[mn.name];
    var base = MB_BASE[mn.name] || {};
    var card = document.createElement('div');
    // The mbmenu class carries the chrome: the blue left edge David singled out as the one thing that
    // helped him track structure, and a heading with enough weight that the menu name stops competing
    // with the labels inside it. The level you navigate by should be the level that looks like a level.
    card.className = 'card card-wide mbmenu';
    var head = document.createElement('div'); head.className = 'card-head';
    var nm = document.createElement('strong'); nm.textContent = mn.label; head.appendChild(nm);
    var who = document.createElement('span'); who.className = 'dim'; who.textContent = mn.who;
    head.appendChild(who);
    card.appendChild(head);

    mbComposed(mn, card);

    // Not editable NEVER means not readable. A half whose shape this editor cannot round-trip is carried
    // through byte for byte and shown here, rather than being named and hidden.
    if (st.hideLocked && base.hide !== undefined) {
      var hn = document.createElement('p'); hn.className = 'mnote';
      // ONE LINE, on purpose: a phrase wrapped across a concatenation is invisible to the phrase grep
      // that asserts it, which is a trap this repo has already paid for once.
      hn.textContent = 'This menu’s hide list is in a shape this builder cannot round-trip, so it is not editable here'
        + ' — it is carried through to the output exactly as it is, and shown below.';
      card.appendChild(hn);
      mbShowRungs(base.hide, card, 'hides');
    }
    if (st.addLocked && base.add !== undefined) {
      var an = document.createElement('p'); an.className = 'mnote';
      an.textContent = 'This menu’s added entries are in a shape this builder cannot round-trip, so they are not editable here.'
        + ' They are carried through exactly as they are, and shown below.';
      card.appendChild(an);
      mbShowRungs(base.add, card, 'entries');
    }
    return card;
  }

  // ── the persona bar ────────────────────────────────────────────────────────────────────────────────
  function mbPersonaBar() {
    var sel = document.getElementById('spkmb-scope');
    var apps = document.getElementById('spkmb-apps');
    var dom = document.getElementById('spkmb-domain');
    var wrap = document.getElementById('spkmb-appswrap');
    if (!sel || !apps || !dom) return;
    if (sel.options.length) return;
    // A PERSONA CHANGE RESETS EVERY FORK ANSWER. Those answers were about one audience; carrying one to
    // the next persona is exactly the silent widening the indicator exists to prevent.
    function changed() { mbResetForks(); mbAdopt(); mbRebuild(); }
    MB_SCOPES.forEach(function(sc){
      var o = document.createElement('option'); o.value = sc; o.textContent = sc; sel.appendChild(o);
    });
    sel.value = mbPersona.scope;
    sel.addEventListener('change', function(){ mbPersona.scope = sel.value; changed(); });
    dom.addEventListener('input', function(){ mbPersona.domain = dom.value.trim(); changed(); });
    // No available app ⇒ no toggles at all, and no empty control sitting there asking to be understood.
    if (!MB_AVAIL.length) { wrap.style.display = 'none'; return; }
    MB_AVAIL.forEach(function(name){
      var b = document.createElement('button'); b.type = 'button'; b.className = 'tog';
      b.textContent = name;
      b.setAttribute('aria-pressed', mbPersona.apps.indexOf(name) >= 0 ? 'true' : 'false');
      b.addEventListener('click', function(){
        var i = mbPersona.apps.indexOf(name);
        if (i >= 0) mbPersona.apps.splice(i, 1); else mbPersona.apps.push(name);
        b.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
        changed();
      });
      apps.appendChild(b);
    });
    // ALL OFF IS A REAL AUDIENCE, not an empty selection: it is the none-rung's audience, and the
    // one an operator forgets to check.
    var hint = document.createElement('span'); hint.className = 'dim'; hint.style.fontSize = '.78rem';
    hint.textContent = 'all off = a domain running none of them';
    apps.appendChild(hint);
  }

  /** Ask the Worker what the CURRENT config does for the CURRENT persona, then redraw. */
  var mbPvTimer = 0;
  var mbLastAsk = null;
  /**
   * ⚠️ THE LOOP THIS GUARD EXISTS TO BREAK: the reply redraws, the redraw calls mbRender, mbRender asks
   * again. Every 250ms the whole tab was wiped and rebuilt — a disclosure snapped shut the instant it was
   * opened, and every control looked dead because its DOM node was replaced before anything could be
   * read. Asking again for an answer already on screen is never useful, so key on the exact question and
   * skip a repeat: the rebuild triggered BY a reply re-asks the same question and stops there.
   */
  function mbRefreshPreview(force) {
    var key = JSON.stringify([mbConfig(), mbPersona.domain, mbPersona.scope, mbPersona.apps.slice().sort()]);
    if (!force && key === mbLastAsk) return;
    mbLastAsk = key;
    if (mbPvTimer) clearTimeout(mbPvTimer);
    mbPvTimer = setTimeout(function(){
      mbAskPreview(mbConfig(), { domain: mbPersona.domain, scope: mbPersona.scope, apps: mbPersona.apps },
        function(v){ mbPreviewReply = v; if (mbEditing) mbRender(); else mbRebuild(); });
    }, 250);
  }
  var mbPreviewReply = null;

  // ── the right rail: what changed, and which rules exist ────────────────────────────────────────────
  //
  // ⚠️ THE RULES LIST IS BOUND TO THE MENU IT DESCRIBES, by grouping under the menu's own name. Unbound —
  // a Reseller rule sitting in the rail while the reader is looking at the Management panel — is the
  // lost-track-of-what-is-what failure reborn one column to the right, which is the thing this layout
  // exists to fix.
  function mbRail() {
    var chg = document.getElementById('spkmb-changed');
    var rules = document.getElementById('spkmb-rules');
    if (chg) {
      chg.textContent = '';
      if (!mbChanges.length) {
        var none = document.createElement('p'); none.className = 'dim';
        none.textContent = 'Nothing yet. Untouched menus are emitted exactly as they run now.';
        chg.appendChild(none);
      }
      mbChanges.slice().reverse().forEach(function(c){
        var row = document.createElement('div'); row.className = 'chgrow';
        var k = document.createElement('span'); k.className = 'kind k-' + c.kind; k.textContent = c.kind;
        var w = document.createElement('span'); w.className = 'what';
        var strong = document.createElement('strong'); strong.textContent = c.menu + ' · ' + c.what;
        w.appendChild(strong);
        if (c.where) {
          var sub = document.createElement('span'); sub.className = 'dim';
          sub.textContent = ' — ' + c.where;
          w.appendChild(sub);
        }
        row.appendChild(k); row.appendChild(w);
        chg.appendChild(row);
      });
    }
    if (!rules) return;
    rules.textContent = '';
    var v = mbPreviewReply;
    var any = false;
    MB_MENUS.forEach(function(mn){
      var rows = mbRulesOf(mn, v);
      if (!rows.length) return;
      any = true;
      var h = document.createElement('div'); h.className = 'railmenu'; h.textContent = mn.label;
      rules.appendChild(h);
      rows.forEach(function(r){
        var row = document.createElement('div');
        row.className = 'rule' + (r.live ? ' live' : '') + (r.inert ? ' dead' : '');
        var a = document.createElement('span'); a.className = 'aud'; a.textContent = r.name;
        row.appendChild(a);
        var meta = document.createElement('span'); meta.className = 'dim';
        meta.textContent = (r.live ? ' · applies now' : '') + (r.inert ? ' · kept, not available here' : '');
        row.appendChild(meta);
        var counts = document.createElement('div'); counts.className = 'dim';
        counts.textContent = 'hides ' + r.hides + ' · adds ' + r.adds;
        row.appendChild(counts);
        if (r.targets.length) {
          mbBtn('remove this rule', function(){
            r.targets.forEach(function(tt){ mbDeleteRung(mn, tt.half, tt.t); });
            mbRebuild();
          }, row, 'act rm');
        }
        rules.appendChild(row);
      });
    });
    if (!any) {
      var p = document.createElement('p'); p.className = 'dim';
      p.textContent = 'No rules yet — every menu is exactly as the portal ships it.';
      rules.appendChild(p);
    }
  }

  /** Every rung on one menu, both halves folded into one row per audience — which is how it is read. */
  function mbRulesOf(mn, v) {
    var matched = (v && v.matched && v.matched[mn.name]) || { hide: [], add: [] };
    var order = [], byKey = {};
    function slot(t) {
      var k = t.axis + '|' + mbNorm(t.key);
      if (!byKey[k]) {
        byKey[k] = { name: mbSrcName(t), hides: 0, adds: 0, targets: [],
          live: (matched.hide || []).concat(matched.add || []).some(function(s){ return mbSameTarget(s, t); }),
          // Config for an app this deployment cannot run is kept byte-identically and reported here —
          // that is a fact about the config, not a control, so it belongs in the rail and nowhere else.
          inert: t.axis === 'app' && mbNorm(t.key) !== 'none' && MB_AVAIL.indexOf(mbNorm(t.key)) < 0 };
        order.push(byKey[k]);
      }
      return byKey[k];
    }
    ['hide', 'add'].forEach(function(half){
      var h = mbHalf(mn, half);
      if (h.locked) {
        var s0 = slot({ axis: 'locked', key: half });
        s0.name = 'a rule this editor cannot round-trip';
        s0.targets = [];
        return;
      }
      if (!h.rungs) {
        if (h.flat.length) { var s1 = slot({ axis: 'all' }); s1[half === 'hide' ? 'hides' : 'adds'] = h.flat.length; }
        return;
      }
      h.rungs.axes.forEach(function(ax){
        ax.order.forEach(function(k){
          var t = { axis: ax.name, key: k };
          var s = slot(t);
          s[half === 'hide' ? 'hides' : 'adds'] = (ax.map[k] || []).length;
          s.targets.push({ half: half, t: t });
        });
      });
      if (h.rungs.top) {
        var td = { axis: '*', key: h.rungs.top.key };
        var s2 = slot(td);
        s2[half === 'hide' ? 'hides' : 'adds'] = h.rungs.top.list.length;
        s2.targets.push({ half: half, t: td });
      }
    });
    return order;
  }

  /** Delete one rung. The fork resets when the rung it named goes, or it would point at nothing. */
  function mbDeleteRung(mn, half, t) {
    var h = mbHalf(mn, half);
    if (h.locked || !h.rungs) return;
    if (t.axis === '*') { h.rungs.top = null; }
    else {
      for (var i = 0; i < h.rungs.axes.length; i++) {
        var ax = h.rungs.axes[i];
        if (ax.name !== t.axis) continue;
        for (var j = ax.order.length - 1; j >= 0; j--) {
          if (mbSame(ax.order[j], t.key)) { delete ax.map[ax.order[j]]; ax.order.splice(j, 1); }
        }
      }
    }
    if (mbSameTarget(mbFork[mbForkKey(mn, half)], t)) delete mbFork[mbForkKey(mn, half)];
    mbNote('rm', mn, 'removed the rule ' + mbSrcName(t), half === 'hide' ? 'hides' : 'adds');
  }

  // A structural edit re-renders every card, because a rung change can move anything. What it must NOT do
  // is move the PAGE — David, after adding one entry: "I actually lost track of what had been changed at
  // all really, the UI changed too much." Rebuilding under a reader who is mid-edit scrolls them somewhere
  // else and takes their focus with it, so the change they just made is somewhere off screen and the thing
  // they were about to do next has moved. Hold the scroll position and put focus back where it was.
  function mbRebuild() {
    if (!mbHost) return;
    var y = window.scrollY;
    // Where focus was, as a path we can find again after the DOM is replaced: the menu panel, the row it
    // was in, and which control within it. Anchored on the ROW LABEL rather than an index, because a
    // rebuild can reorder rows and restoring the wrong control is worse than restoring none.
    var act = document.activeElement;
    var mark = null;
    if (act && act !== document.body) {
      var cardEl = act.closest && act.closest('.card');
      if (cardEl) {
        var heads = cardEl.querySelectorAll('strong');
        var rowEl = act.closest && act.closest('.fm');
        var lbl = rowEl ? rowEl.querySelector('.lbl') : null;
        mark = { card: heads[0] ? heads[0].textContent : '', row: lbl ? lbl.textContent : null,
                 tag: act.tagName, cls: act.className || '' };
      }
    }
    mbHost.textContent = '';
    MB_MENUS.forEach(function(mn){ mbHost.appendChild(mbCard(mn)); });
    mbCaveat();
    mbMarkScopes();
    mbDomainBox();
    mbCapturePanel();
    mbRail();
    mbRender();
    window.scrollTo(0, y);
    if (mark) {
      try {
        var cards = mbHost.querySelectorAll('.card');
        for (var i = 0; i < cards.length; i++) {
          var hh = cards[i].querySelector('strong');
          if (!hh || hh.textContent !== mark.card) continue;
          var scope = cards[i];
          if (mark.row) {
            var rs = cards[i].querySelectorAll('.fm');
            for (var j = 0; j < rs.length; j++) {
              var rl = rs[j].querySelector('.lbl');
              if (rl && rl.textContent === mark.row) { scope = rs[j]; break; }
            }
          }
          var cand = scope.querySelectorAll(mark.tag.toLowerCase());
          for (var k = 0; k < cand.length; k++) {
            if ((cand[k].className || '') === mark.cls) { cand[k].focus(); return; }
          }
          return;
        }
      } catch (e) { /* focus is a nicety; never let it break the render */ }
    }
  }

  function mbSeed() {
    MB_MENUS.forEach(function(mn){
      var base = MB_BASE[mn.name] || {};
      // The READER'S own page, deliberately: this seeds config state and the found-on-this-page status
      // line, both of which are facts about the session rather than about whichever persona is selected.
      // The persona's entries are mbComposed's business, and only it consults a capture.
      var live = (mbLive && mbLive[mn.name]) || { present: false, entries: [] };
      // A targeted half is one of three things now: rungs we can edit (its scopes axis is a map of flat
      // lists), or still locked, or not targeted at all. Locked is what it was before, minus the case
      // this pass took over.
      function rungsOf(raw, asEntries) {
        function asList(v) {
          return asEntries ? mbClone(v).map(mbEntryIn) : v.slice();
        }
        // Every axis this half carries that is a map of flat lists. An axis that is not — a nested shape,
        // or a value that is not an object — is left out, which puts it in the carried-through remainder
        // and keeps it visible read-only rather than half-understood.
        var axes = [], handled = [];
        MB_AXES.forEach(function(def){
          var ax = mbAxisOf(raw, def.name);
          if (!ax) return;
          var m = {};
          ax.keys.forEach(function(k){ m[k] = asList(ax.map[k]); });
          axes.push({ name: def.name, axisKey: ax.key, order: ax.keys.slice(), map: m });
          handled.push(ax.key);
        });
        // THE WHOLE-OBJECT DEFAULT IS A RUNG TOO, and on a real config it is usually the one carrying the
        // content: a scopes map naming Reseller with nothing, beside a top-level star holding the entry
        // everyone gets, is how "everyone but resellers" is written. Left in the carried-through
        // remainder it would be the one thing on the card you could not edit, beside an empty rung you
        // could — so it is lifted out and rendered as its own group. Only when it is a flat list;
        // anything else stays carried-through.
        var topKey = mbAxisKey(raw, '*');
        var top = topKey !== undefined && Array.isArray(raw[topKey])
          ? { key: topKey, list: asList(raw[topKey]) } : null;
        if (top) handled.push(top.key);
        // Nothing round-trippable ⇒ not editable at all, and the caller keeps it locked.
        if (!axes.length && !top) return null;
        return { axes: axes, top: top, rest: mbRest(raw, handled), keyOrder: Object.keys(raw) };
      }
      var hideRungs = mbIsTargeted(base.hide) ? rungsOf(base.hide, false) : null;
      var addRungs = mbIsTargeted(base.add) ? rungsOf(base.add, true) : null;
      mbState[mn.name] = {
        present: !!live.present,
        hideLocked: mbIsTargeted(base.hide) && !hideRungs,
        addLocked: mbIsTargeted(base.add) && !addRungs,
        hideRungs: hideRungs,
        addRungs: addRungs,
        hide: Array.isArray(base.hide) ? base.hide.slice() : [],
        add: Array.isArray(base.add) ? mbClone(base.add).map(mbEntryIn) : []
      };
    });
  }

  function mbStart(live) {
    mbLive = live;
    mbSeed();
    mbPersonaBar();
    mbRebuild();
    mbRefreshPreview();
    var any = MB_MENUS.some(function(mn){ return mbState[mn.name].present; });
    mbStatus.textContent = any
      ? 'Read from the portal page. Your current config is loaded — the output below is always the complete config, not only your changes.'
      : 'None of these menus were found on this page, so there is nothing to tick. Your current config is loaded and you can still edit it by name.';
  }

  var mbReset = document.getElementById('spkmb-reset');
  if (mbReset) mbReset.addEventListener('click', function(){
    // Back to the deployment's live config, discarding this session's edits. Not "back to empty" — empty
    // is a config too, and a destructive one. The rail's change log and every fork answer go with them:
    // a log of edits that are no longer in the config is a log that lies.
    mbSeed(); mbResetForks(); mbChanges.length = 0; mbRebuild();
  });

  // ── the preview: ask the WORKER what this config does for one audience ────────────────────────────
  // Precedence lives in resolveTargeted and nowhere else, so the console asks rather than computes. The
  // three replies are three different states and the page must never collapse them:
  //   plan       — this is what that audience gets
  //   invalid    — the config cannot be resolved (normal while typing one)
  //   unavailable— we could not ask. NOT a report about the config, and NOT an empty menu.
  // WHO WE ARE PREVIEWING AS. Scope is single (a reader has one); apps are a SET (two can be active at
  // once, which is the whole reason they are toggles); domain is optional and only matters where a
  // domains rung exists.
  // OPENS ON YOUR OWN SCOPE, not on the top of the list. It is the one persona whose stock entries are
  // genuinely accurate — they came off your page, as you — so it is the only starting point that is not
  // already an approximation, and the caveat above is correctly silent until you move off it. Only a
  // scope this deployment knows; anything else falls back to the head of the list rather than putting an
  // unspellable value in the picker.
  var mbPersona = {
    scope: (function(){
      for (var i = 0; i < MB_SCOPES.length; i++) if (mbSame(MB_SCOPES[i], MB_ME)) return MB_SCOPES[i];
      return MB_SCOPES[0] || '';
    })(),
    apps: MB_AVAIL.slice(),
    domain: ''
  };
  var mbPreview = null;      // last good plan, per persona key
  var mbPreviewState = 'idle';
  function mbAskPreview(cfg, persona, done) {
    if (!HOSTED) { done({ unavailable: 'This page is not running inside the portal, so it cannot build a preview.' }); return; }
    mbPreviewState = 'asking';
    // ⚠️ STAMP THE QUESTION. Asking again does not cancel the first round-trip, so two answers can be in
    // flight and they can arrive in either order; the slot below holds one callback. See SPK_BRIDGE.idKey.
    mbPreviewWait = ++mbPreviewSeq;
    window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.resolveRequest}', ${SPK_BRIDGE.idKey}: mbPreviewWait,
      ${SPK_BRIDGE.resolveKey}: {
        c: JSON.stringify(cfg), domain: persona.domain || '', scope: persona.scope || '', apps: persona.apps || []
      } }, '*');
    mbPreviewDone = done;
  }
  var mbPreviewDone = null;
  var mbPreviewSeq = 0;
  var mbPreviewWait = 0;

  /**
   * The rendering rule this whole pair exists for. An EMPTY PLAN DRAWN AS A MENU says "nothing is hidden
   * and nothing is added for this audience", which is a confident wrong answer when the truth is "we could
   * not ask" — the same failure the Checks panel's errorKey exists to prevent, in a different panel.
   */
  function mbPreviewNotice(v) {
    if (v && v.unavailable) return { bad: true, text: 'Preview unavailable — ' + v.unavailable
      + ' Nothing below is a statement about your config.' };
    if (v && v.invalid) return { bad: true, text: 'This config cannot be resolved, so there is nothing to preview: ' + v.invalid };
    return null;
  }

  /**
   * What a resolve reply DOES, as a function rather than as three lines inside a message listener — so
   * the DOM harness drives the same code path the bridge does. A behaviour test that re-implements the
   * two lines it is testing is a test of the copy.
   */
  /** What a captures reply DOES — a function, so the DOM harness drives the same path the bridge does. */
  function mbOnStock(st) {
    if (!st || typeof st !== 'object') return;
    mbStock = st;
    // Captures cleared ⇒ nothing left to have been adopted from.
    if (!mbCaptured().length) mbAdopted = {};
    mbAdopt();
    // STRAIGHT TO THE MENUS TAB when there is something captured to look at — the operator has just come
    // back from masquerading to see it, and the console opens on Overview. Once only, and only while
    // they are still on the tab it opened on: switching a tab out from under someone who navigated is
    // worse than the click it saves.
    if (!mbTabbed && mbCaptured().length) {
      mbTabbed = true;
      var ov = document.getElementById('spktab-overview');
      var menus = document.getElementById('spktab-menus');
      if (menus && ov && ov.checked) menus.checked = true;
    }
    if (mbHost && mbHost.children.length) mbRebuild();
  }

  /**
   * ⚠️ ONLY THE OUTSTANDING QUESTION IS ANSWERED. An answer for a config the operator has already edited
   * past is not a late answer to the question on screen — it is an answer to a different one, and taking
   * it paints the picture, the chips and the rule owners from a config that is no longer anywhere. It also
   * empties the callback slot, so the RIGHT answer is then dropped and the no-repeat guard already holds
   * the newer key: nothing re-asks and the wrong picture stays until the next edit.
   *
   * An UNSTAMPED reply is taken, so a page holding a cached older parent bundle keeps a working preview
   * (with the old race) instead of a permanently blank one. See SPK_BRIDGE.idKey.
   */
  function mbOnResolve(rv, rid) {
    if (rid != null && mbPreviewWait && rid !== mbPreviewWait) return;
    mbPreviewWait = 0;
    mbPreviewState = rv && rv.plan ? 'ok' : 'failed';
    if (rv && rv.plan) mbPreview = rv;
    if (mbPreviewDone) { var f = mbPreviewDone; mbPreviewDone = null; f(rv); }
  }

  if (mbHost && HOSTED) {
    window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.menusRequest}' }, '*');
    // Asked alongside the live read, not instead of it: a persona with no capture still falls back to
    // this session's own menus, which is better than an empty picture and is what the caveat describes.
    window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.stockRequest}' }, '*');
  }
  else if (mbHost) {
    // Still useful without a portal: the builder's OTHER half is your existing config, which is
    // server-rendered and needs no bridge. Start it with no live entries rather than leaving the tab
    // pending — you can edit what you have and hide by name, just not tick what is on screen.
    mbStart({});
    mbStatus.textContent = 'This page is not running inside the portal, so there are no live menu entries '
      + 'to tick. Your configured menus are loaded and editable, and you can still hide an entry by name.';
  }


  window.addEventListener('message', function(ev){
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (m && m.${SPK_BRIDGE.tag} === '${SPK_BRIDGE.pageResponse}') {
      if (m.${SPK_BRIDGE.pageKey}) showObserved(m.${SPK_BRIDGE.pageKey});
      return;
    }
    if (m && m.${SPK_BRIDGE.tag} === '${SPK_BRIDGE.resolveResponse}') {
      mbOnResolve(m.${SPK_BRIDGE.resolveKey} || {}, m.${SPK_BRIDGE.idKey});
      return;
    }
    if (m && m.${SPK_BRIDGE.tag} === '${SPK_BRIDGE.stockResponse}') {
      mbOnStock(m.${SPK_BRIDGE.stockKey});
      return;
    }
    if (m && m.${SPK_BRIDGE.tag} === '${SPK_BRIDGE.menusResponse}') {
      if (m.${SPK_BRIDGE.menusKey} && mbHost) mbStart(m.${SPK_BRIDGE.menusKey});
      return;
    }
    if (m && m.${SPK_BRIDGE.tag} === '${SPK_BRIDGE.checkResponse}') {
      // The same stale-answer rule as the preview, one panel over: a verdict about a config that is no
      // longer in the box is not a verdict about the one that is. Unstamped is taken — see SPK_BRIDGE.idKey.
      var cid = m.${SPK_BRIDGE.idKey};
      if (cid != null && mbCheckWait && cid !== mbCheckWait) return;
      mbCheckWait = 0;
      var v = m.${SPK_BRIDGE.checkKey} || {};
      // Three outcomes, not two. "Could not check" must never render as valid — the whole reason this
      // round-trips to the deployment is so the verdict is the real one, and a failed round-trip that
      // reads as a pass would be worse than no check at all.
      if (mbVerdict) {
        var warn = (v.warnings || []).join(' ');
        if (v.unchecked) mbVerdict.textContent = 'Not checked. ' + v.unchecked;
        // ACCEPTED AND STILL WRONG is a real state, and it has to read as neither "valid" nor "rejected":
        // this deployment will take the config, and some of it will reach nobody.
        else if (v.ok && warn) mbVerdict.textContent = 'Accepted, but some of it reaches nobody. ' + warn;
        else if (v.ok) mbVerdict.textContent = 'Valid — this deployment accepts this config.';
        else mbVerdict.textContent = 'Rejected: ' + (v.error || 'this deployment will not accept this config.');
        mbVerdict.className = v.ok && warn ? 'mnote mbad' : 'mnote';
      }
      return;
    }
    if (!m || m.${SPK_BRIDGE.tag} !== '${SPK_BRIDGE.response}') return;
    // A response arrived — a run was attempted, whatever its outcome — so neither the not-run intro nor
    // the running one is still true, and the button can no longer read "Run Checks" (implying nothing has
    // run). Swap in the SAME strings statusHtml() renders for a doc whose probes is non-null
    // (CHECKS_INTRO_TEXT.ranAlready / RUN_BTN_LABEL.ranAlready, embedded as literals at page-build time,
    // not typed twice), so the two can't drift apart. textContent only: this element's content is
    // server-known, not part of the postMessage payload, so it never touches an upstream-influenced string.
    if (introEl) introEl.textContent = ${JSON.stringify(CHECKS_INTRO_TEXT.ranAlready)};
    if (host) {
      var results = Array.isArray(m.${SPK_BRIDGE.dataKey}) ? m.${SPK_BRIDGE.dataKey} : [];
      host.innerHTML = '';
      // A run that did not complete must say so. Replacing the panel with an empty list is
      // indistinguishable from "every check passed with nothing to report", which is the exact class of
      // confidently-wrong statement this console exists to avoid.
      if (m.${SPK_BRIDGE.errorKey} || !results.length) {
        host.appendChild(checkRow('misconfigured', 'FAIL', 'The checks did not run',
          m.${SPK_BRIDGE.errorKey}
            ? 'This deployment could not be asked to run the checks, so nothing was checked. This is NOT a report that everything is healthy — try again, and see the Worker logs in the Cloudflare dashboard if it keeps failing.'
            : 'The run came back with no results at all, so nothing was checked. This is NOT a report that everything is healthy.',
          'No live call was completed.'));
      }
      for (var i = 0; i < results.length; i++) {
        var r = results[i] || {};
        var state = r.state === 'pass' ? 'on' : r.state === 'fail' ? 'misconfigured' : 'off';
        var label = r.state === 'pass' ? 'PASS' : r.state === 'fail' ? 'FAIL' : 'SKIP';
        var rowEl = checkRow(state, label, r.name || r.id || '', r.detail || '', r.cost || '');
        var tbl = checkTable(r.table);
        if (tbl) rowEl.appendChild(tbl);
        host.appendChild(rowEl);
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = ${JSON.stringify(RUN_BTN_LABEL.ranAlready)}; }
  });
})();`;
}

// ── top level ──────────────────────────────────────────────────────────────────────────────────────

export function statusHtml(doc: StatusDoc): string {
  // Same wording as the header and the modal chrome. The three are the same title in three places, and a
  // reader switching between a browser tab, a modal frame and a page heading should not have to work out
  // that they are looking at one thing.
  const title = `${doc.deployment.productName} - Integration Console`;
  // name → its one-liner, so every setting LINK can carry the description as a tooltip. Built from the doc
  // rather than imported: a reader hovering a name usually wants to know what it means, not to travel.
  const whats: Record<string, string> = {};
  // name → a SHORT current value, for the inline chips beside setting links.
  //
  // `s.kind !== 'secret'` is checked HERE and not left to `s.value` being null. I first wrote this relying on
  // the value being null for secrets — which is true of `status.ts` today — and the leak test caught it
  // immediately: it builds a document where secrets DO carry values, precisely because "the renderer never
  // prints a secret" must hold structurally rather than because the layer above happens to be correct. That
  // is this file's stated safety property, and I had just written the rationalisation for breaking it into a
  // comment. Anything long is omitted rather than truncated — a truncated blob looks like a value you could
  // act on.
  const vals: Record<string, string> = {};
  for (const s of doc.settings) {
    whats[s.name] = s.what;
    if (s.kind === 'secret') continue;
    if (s.value !== null && s.value.length <= 32 && !s.value.includes('\n')) vals[s.name] = s.value;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE.replace('__TABCSS__', tabCss())}</style></head><body><main>
${renderHeader(doc)}
${renderTabInputs()}
${renderTabBar()}
${renderOverview(doc)}
${renderFeatures(doc, whats, vals)}
${renderIntegrations(doc, whats, vals)}
${renderPermissions(doc)}
${renderMenus(doc)}
${renderConfig(doc)}
${renderBackend(doc, whats, vals)}
${renderChecks(doc)}
</main>
<script>${script(doc.probes !== null, doc.menus.raw, doc)}</script>
</body></html>`;
}
