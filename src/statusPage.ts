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
import { PROBE_CATALOG, probeCatalogFor, GROUP_ORDER, GROUP_LABEL, GROUP_BLURB } from './statusModel.js';
import { SPK_BRIDGE } from './spkBridge.js';
import type {
  StatusDoc, FeatureCard, SubsystemCard, SettingView, ProbeResult, FeatureState, MissingRequirement,
  ProbeCatalogEntry, PermissionsView, PermissionRow, PermissionCell, CellVerdict, SettingImportance,
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
  const rows = items.map((m) => `<li><strong>${esc(m.setting)}</strong> — ${esc(m.why)} ${esc(m.how)}</li>`).join('');
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
  const tip = what ? ` title="${esc(`${name} — ${what}`)}"` : '';
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
  return `<div class="card${f.detail.length ? ' card-wide' : ''}">
  <div class="card-head">${pill(f.state)}<span class="card-name">${esc(f.name)}</span><code class="card-key">${esc(f.key)}</code>${f.detail.length ? '<button type="button" class="totop" title="Back to the top of the page">top</button>' : ''}</div>
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

function renderFeatures(doc: StatusDoc, whats: Record<string, string>, vals: Record<string, string>): string {
  const admin = doc.features.filter((f) => f.audience === 'admin');
  const self = doc.features.filter((f) => f.audience === 'self');
  return `<section id="spkpanel-features" class="spk-panel">
  ${renderTocBar([{ id: 'sec-feat-admin', label: 'Administrative', count: admin.length }, { id: 'sec-feat-self', label: 'Self-service', count: self.length }])}
  ${sectionHead('sec-feat-admin', 'Administrative features', admin.length)}
  <p class="dim">Things an administrator does to other people's accounts. "Available to" is who may use them.</p>
  <div class="card-grid">${admin.map((f) => renderFeatureCard(f, whats, vals)).join('')}</div>
  ${sectionHead('sec-feat-self', 'Self-service features', self.length)}
  <p class="dim">Things a signed-in user sees about their own account. Here <strong>your</strong> users are
  the subject, not you — see the Permissions tab for what each scope actually gets.</p>
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
  const search = esc(`${s.name} ${s.group} ${s.kind} ${s.what}`.toLowerCase());
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

  return `<div class="setting-row${dim ? ' dimmed' : ''}" id="spkset-${esc(s.name)}" data-search="${search}">
  <div class="setting-head">
    ${setPill(s)}
    <code class="card-key">${esc(s.name)}</code>
    ${imp}
    <span class="dim">${esc(s.kind)}</span>
  </div>
  <p class="card-desc">${esc(s.what)}</p>
  ${valueLine}
  ${defaultLine}
  ${naLine}
  ${gateLine}
  <details>
    <summary>How to set it &middot; what happens when unset</summary>
    <p>${esc(s.whenUnset)}</p>
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
      <span class="secblurb dim">${esc(GROUP_BLURB[group])}</span></summary>
    <div class="setting-list">${sorted.map(renderSettingRow).join('')}</div>
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

  const current = m.menus.map((mv) => {
    const hides = mv.hide.length
      ? `<ul class="mlist">${mv.hide.map((h) => `<li><span class="mtag mtag-hide">hidden</span> ${esc(h)}</li>`).join('')}</ul>`
      : '<p class="dim">Nothing hidden.</p>';
    const adds = mv.add.length
      ? `<ul class="mlist">${mv.add.map((a) => `<li><span class="mtag mtag-add">added</span> ${esc(a.label)} <code class="epurl">${esc(a.url)}</code></li>`).join('')}</ul>`
      : '<p class="dim">Nothing added.</p>';
    // A targeted menu resolves differently per user, so one rung is NOT "the config". Say so on the card
    // rather than in a footnote — a reader who misses it walks away with a specific wrong belief.
    const targeted = mv.targeted
      ? '<p class="mnote">This menu is <strong>targeted</strong>, so what is shown here is only the rung that applies to a domain your config does not name, with no app active. Other domains, scopes or app states get different entries.</p>'
      : '';
    return `<div class="card card-wide">
      <div class="card-head"><strong>${esc(mv.label)}</strong> <code class="card-key">${esc(mv.name)}</code></div>
      <p class="dim">${esc(mv.what)}</p>
      ${targeted}${hides}${adds}
    </div>`;
  }).join('');

  // Provenance for the merged apps hide list. Two settings may write it; there is one place to read it.
  const prov = m.appsHide
    ? `<div class="mnote"><strong>Two settings are hiding Apps entries, and they merge.</strong>
       PORTAL_MENUS["apps"].hide contributes ${m.appsHide.menus.length ? `<code>${esc(m.appsHide.menus.join(', '))}</code>` : 'nothing at this rung'};
       PORTAL_APPS_HIDE contributes ${m.appsHide.legacy.length ? `<code>${esc(m.appsHide.legacy.join(', '))}</code>` : 'nothing at this rung'}.
       A label named by both is hidden once.</div>`
    : '';

  const unset = m.configured ? '' : '<p class="dim">Nothing is configured yet, so every menu is exactly as the portal ships it. The builder below is the quickest way to change that.</p>';

  return `<section id="spkpanel-menus" class="spk-panel">
  <p class="dim">Adding entries to the portal's menus, and hiding stock ones you do not offer. This needs no
  other integration — with nothing else configured at all, add and hide still work.</p>
  ${err}
  <h3>What your config does now</h3>
  ${unset}${prov}
  <div class="card-stack">${current}</div>

  <h3>Builder</h3>
  <p class="dim">Reads the menus off the portal page you opened this from, so you tick real entries instead
  of typing labels and hoping they match. Nothing here changes anything: it composes the config and you
  paste it into your deployment. The result is checked by this deployment's own validator, not by a second
  copy of the rules.</p>
  <p class="mnote"><strong>It sees one page, as one person</strong> — and a hide matches the label exactly.
  The account menu relabels itself by context: while you are managing a domain it reads <em>My Account</em>
  and <em>Messages</em>, and inside your own account the same menu reads <em>Profile</em>. One menu, different
  labels, and the same both ways for a reseller and an office manager. So an entry you hide here can reappear
  elsewhere under another name. Tick it here and add the other label by hand — listing a label that never
  appears is harmless, since a hide that matches nothing changes nothing.</p>
  <div id="spkmb">
    <p class="dim" id="spkmb-status">Asking the portal page for its menus…</p>
    <p><button type="button" class="copy-btn" id="spkmb-reset">Reset to the running config</button>
       <span class="dim">Discards this session's edits. Not "reset to empty" — empty is a config too, and a
       destructive one.</span></p>
    <div id="spkmb-menus"></div>
    <div id="spkmb-out" hidden>
      <h4 class="whyh">The config</h4>
      <p class="dim">Two forms of the same thing. The escaped one is what <code>wrangler.jsonc</code> wants,
      since a JSON value has to be embedded there as a string.</p>
      <p class="mnote"><strong>This is the complete config, not a diff.</strong> It replaces
      <code>PORTAL_MENUS</code> in full, so it carries every menu you did not touch exactly as it is running
      now — pasting it changes only what you changed here. A menu whose config is targeted by domain, scope
      or app state is passed through untouched and cannot be edited above: a flat list cannot express it, and
      flattening it would quietly narrow it to one audience.</p>
      <p class="dim">Readable JSON <button type="button" class="copy-btn" data-copy="spkmb-json">Copy</button></p>
      <pre id="spkmb-json" class="jsonblock"></pre>
      <p class="dim">For <code>wrangler.jsonc</code> <button type="button" class="copy-btn" data-copy="spkmb-wr">Copy</button></p>
      <pre id="spkmb-wr" class="jsonblock"></pre>
      <p id="spkmb-verdict" class="mnote"></p>
    </div>
  </div>
</section>`;
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

function renderProbeRow(p: ProbeResult): string {
  const cls: FeatureState = p.state === 'pass' ? 'on' : p.state === 'fail' ? 'misconfigured' : 'off';
  const label = p.state === 'pass' ? 'PASS' : p.state === 'fail' ? 'FAIL' : 'SKIP';
  return `<div class="check-row"><span class="pill pill-${cls}">${label}</span><strong>${esc(p.name)}</strong><p>${esc(p.detail)}</p><p class="dim">${esc(p.cost)}</p></div>`;
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
.mbadd input { font:inherit; padding:.25rem .4rem; border:1px solid var(--line); border-radius:4px;
               background:var(--card); color:var(--fg); }
.mbadd { display:flex; gap:.4rem; flex-wrap:wrap; align-items:center; margin:.4rem 0; }
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
function script(hasRun: boolean, menusBase: string): string {
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
    var t = ev.target;
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

  // Copy a JSON block. No clipboard permission in a sandboxed iframe is guaranteed, so this reports
  // failure rather than silently doing nothing and leaving the reader to believe it worked.
  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.classList || !t.classList.contains('copy-btn')) return;
    var pre = document.getElementById(t.getAttribute('data-copy') || '');
    if (!pre) return;
    var done = function(msg){ t.textContent = msg; setTimeout(function(){ t.textContent = 'Copy'; }, 2000); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pre.textContent).then(function(){ done('Copied'); }, function(){ done('Select and copy manually'); });
        return;
      }
    } catch (e) { /* fall through to the manual path */ }
    done('Select and copy manually');
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

  // One code path for both triggers (the button and the auto-run below), so they can never show
  // different "running" behaviour. Disabling the button here — not just relabeling it — is what stops a
  // second press (or a second auto-fire) from queuing a duplicate run. Does not touch \host\'s existing
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
  // back to it. \autoRan\ seeds from whether this document already carries results — a fresh modal
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
    { name: 'apps', label: 'Apps', who: 'Everyone who can sign in sees this menu.' },
    { name: 'account', label: 'Account', who: 'Everyone sees this menu — it is their own name dropdown.' },
    { name: 'management', label: 'Management', who: 'Administrative scopes only, and only where a vendor add-on supplies this menu — it is not part of a stock portal.' }
  ];
  // The live config, embedded server-side. The builder is a differ against THIS.
  var MB_BASE = ${mbBaseJson};
  var mbState = {};
  var mbStatus = document.getElementById('spkmb-status');
  var mbHost = document.getElementById('spkmb-menus');
  var mbOut = document.getElementById('spkmb-out');
  var mbJson = document.getElementById('spkmb-json');
  var mbWr = document.getElementById('spkmb-wr');
  var mbVerdict = document.getElementById('spkmb-verdict');
  var mbCheckTimer = 0;
  var mbLive = null;

  function mbIsTargeted(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function mbClone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  // The full config: every menu, edited or not. Untouched menus are emitted from MB_BASE unchanged, and a
  // targeted menu is emitted from MB_BASE even when its sibling half was edited.
  function mbConfig() {
    var cfg = {};
    MB_MENUS.forEach(function(mn){
      var st = mbState[mn.name];
      var base = MB_BASE[mn.name] || {};
      var one = {};
      // hide
      if (st && !st.hideLocked) {
        var hide = st.hide.slice();
        if (hide.length) one.hide = hide;
      } else if (base.hide !== undefined) {
        one.hide = mbClone(base.hide);
      }
      // add
      if (st && !st.addLocked) {
        var add = st.add.filter(function(a){ return a.label && a.url; })
          .map(function(a){ var o = { label: a.label, url: a.url }; if (a.title) o.title = a.title; return o; });
        if (add.length) one.add = add;
      } else if (base.add !== undefined) {
        one.add = mbClone(base.add);
      }
      if (one.hide !== undefined || one.add !== undefined) cfg[mn.name] = one;
    });
    return cfg;
  }

  function mbRender() {
    var cfg = mbConfig();
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
      window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.checkRequest}', ${SPK_BRIDGE.checkKey}: JSON.stringify(cfg) }, '*');
    }, 400);
  }

  function mbBtn(label, fn, host) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'copy-btn'; b.textContent = label;
    b.addEventListener('click', fn);
    host.appendChild(b);
    return b;
  }

  // One editable added entry. Used for entries already in your config AND for new ones, so an existing
  // entry is edited in the same place a new one is written rather than being read-only prose above it.
  function mbAddRow(name, host, entry, focus) {
    var st = mbState[name];
    var wrap = document.createElement('div');
    wrap.className = 'mbadd';
    function inp(ph, val, size) {
      var i = document.createElement('input');
      i.placeholder = ph; i.value = val || ''; i.size = size; return i;
    }
    var lab = inp('Label', entry.label, 16);
    var url = inp('https://…', entry.url, 28);
    var ttl = inp('Tooltip (optional)', entry.title, 20);
    function sync(){ entry.label = lab.value.trim(); entry.url = url.value.trim(); entry.title = ttl.value.trim(); mbRender(); }
    [lab, url, ttl].forEach(function(i){ i.addEventListener('input', sync); });
    [lab, url, ttl].forEach(function(el){ wrap.appendChild(el); });
    mbBtn('Remove', function(){
      var i = st.add.indexOf(entry); if (i >= 0) st.add.splice(i, 1);
      wrap.remove(); mbRender();
    }, wrap);
    host.appendChild(wrap);
    if (focus) lab.focus();
  }

  // A TARGETED rung, shown read-only. "Not editable here" on its own tells you a rule exists and hides what
  // it says, which is the worst of both — you cannot edit it AND you cannot read it without going to the
  // Config tab. Whatever the builder cannot edit, it can still show.
  function mbShowRungs(raw, card, what) {
    var wrap = document.createElement('div');
    var head = document.createElement('p'); head.className = 'dim';
    head.textContent = 'Targeted ' + what + ', shown as configured — edit these on the Config tab:';
    wrap.appendChild(head);
    Object.keys(raw).forEach(function(axis){
      var sub = raw[axis];
      // Two shapes: a named axis ({scopes:{…}}) or a bare domain/default map ({acme.example:[…]}).
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

  function mbCard(mn) {
    var st = mbState[mn.name];
    var base = MB_BASE[mn.name] || {};
    var card = document.createElement('div');
    card.className = 'card card-wide';
    var head = document.createElement('div'); head.className = 'card-head';
    var nm = document.createElement('strong'); nm.textContent = mn.label; head.appendChild(nm);
    var key = document.createElement('code'); key.className = 'card-key'; key.textContent = mn.name; head.appendChild(key);
    card.appendChild(head);

    // Who normally sees this menu at all — asked for, and the answer a hide list depends on.
    var who = document.createElement('p'); who.className = 'dim'; who.textContent = mn.who;
    card.appendChild(who);

    function note(text, bad) {
      var p = document.createElement('p'); p.className = bad ? 'mnote mbad' : 'mnote';
      p.textContent = text; card.appendChild(p);
    }

    // ── hides ──
    if (st.hideLocked) {
      note('This menu’s hide list is targeted, so it is not editable here yet — a flat tick-list cannot express it, and flattening it would quietly narrow it to one audience. It is carried through to the output exactly as it is.');
      mbShowRungs(base.hide, card, 'hides');
    } else {
      if (!st.present) {
        note('This menu is not on this page. That is expected for one your scope does not see, or one this portal does not have. You can still configure it — and you can name an entry to hide by hand below.');
      }
      var stock = (mbLive && mbLive[mn.name] && mbLive[mn.name].entries) || [];
      if (stock.length) {
        var hint = document.createElement('p'); hint.className = 'dim';
        hint.textContent = 'Entries on this page. Tick one to hide it.';
        card.appendChild(hint);
        stock.forEach(function(label){
          var row = document.createElement('div'); row.className = 'mbrow';
          var l = document.createElement('label');
          var cb = document.createElement('input'); cb.type = 'checkbox';
          cb.checked = st.hide.indexOf(label) >= 0;
          cb.addEventListener('change', function(){
            var i = st.hide.indexOf(label);
            if (cb.checked && i < 0) st.hide.push(label);
            if (!cb.checked && i >= 0) st.hide.splice(i, 1);
            mbRender();
          });
          var t = document.createElement('span'); t.textContent = label;
          l.appendChild(cb); l.appendChild(t); row.appendChild(l);
          card.appendChild(row);
        });
      }
      // Labels in your config that are NOT on this page. They are not mistakes — the menu relabels itself
      // by context, and another injection may add entries this page load did not — so show them as hides
      // you already have rather than dropping them from the tick-list.
      var offPage = st.hide.filter(function(h){ return stock.indexOf(h) < 0; });
      if (offPage.length) {
        var oh = document.createElement('p'); oh.className = 'dim';
        oh.textContent = 'Also hidden by your config, but not on this page:';
        card.appendChild(oh);
        offPage.forEach(function(label){
          var row = document.createElement('div'); row.className = 'mbrow';
          var t = document.createElement('span'); t.textContent = label; row.appendChild(t);
          mbBtn('Stop hiding', function(){
            var i = st.hide.indexOf(label); if (i >= 0) st.hide.splice(i, 1);
            mbRebuild();
          }, row);
          card.appendChild(row);
        });
      }
      // Hide by name. Needed because the menu shows different labels in different contexts, and because
      // other injected code can add entries this page load never showed.
      var manual = document.createElement('div'); manual.className = 'mbadd';
      var mi = document.createElement('input'); mi.placeholder = 'Hide an entry by name'; mi.size = 24;
      manual.appendChild(mi);
      function addManual(){
        var v = mi.value.trim(); if (!v) return;
        if (st.hide.indexOf(v) < 0) st.hide.push(v);
        mi.value = ''; mbRebuild();
      }
      mi.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); addManual(); } });
      mbBtn('Hide it', addManual, manual);
      card.appendChild(manual);
    }

    // ── adds ──
    if (st.addLocked) {
      note('This menu’s added entries are targeted, so they are not editable here yet. They are carried through to the output exactly as they are.');
      mbShowRungs(base.add, card, 'entries');
    } else {
      if (st.add.length) {
        var ah = document.createElement('p'); ah.className = 'dim';
        ah.textContent = 'Entries you add. These are yours — edit or remove them here.';
        card.appendChild(ah);
      }
      var addHost = document.createElement('div');
      card.appendChild(addHost);
      st.add.forEach(function(entry){ mbAddRow(mn.name, addHost, entry, false); });
      mbBtn('Add an entry', function(){
        var entry = { label: '', url: '', title: '' };
        st.add.push(entry);
        mbAddRow(mn.name, addHost, entry, true);
        mbRender();
      }, card);
    }
    return card;
  }

  function mbRebuild() {
    if (!mbHost) return;
    mbHost.textContent = '';
    MB_MENUS.forEach(function(mn){ mbHost.appendChild(mbCard(mn)); });
    mbRender();
  }

  function mbSeed() {
    MB_MENUS.forEach(function(mn){
      var base = MB_BASE[mn.name] || {};
      var live = (mbLive && mbLive[mn.name]) || { present: false, entries: [] };
      mbState[mn.name] = {
        present: !!live.present,
        hideLocked: mbIsTargeted(base.hide),
        addLocked: mbIsTargeted(base.add),
        hide: Array.isArray(base.hide) ? base.hide.slice() : [],
        add: Array.isArray(base.add) ? mbClone(base.add).map(function(a){
          return { label: a.label || '', url: a.url || '', title: a.title || '' };
        }) : []
      };
    });
  }

  function mbStart(live) {
    mbLive = live;
    mbSeed();
    mbRebuild();
    var any = MB_MENUS.some(function(mn){ return mbState[mn.name].present; });
    mbStatus.textContent = any
      ? 'Read from the portal page. Your current config is loaded — the output below is always the complete config, not only your changes.'
      : 'None of these menus were found on this page, so there is nothing to tick. Your current config is loaded and you can still edit it by name.';
  }

  var mbReset = document.getElementById('spkmb-reset');
  if (mbReset) mbReset.addEventListener('click', function(){
    // Back to the deployment's live config, discarding this session's edits. Not "back to empty" — empty
    // is a config too, and a destructive one.
    mbSeed(); mbRebuild();
  });

  if (mbHost && HOSTED) window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.menusRequest}' }, '*');
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
    if (m && m.${SPK_BRIDGE.tag} === '${SPK_BRIDGE.menusResponse}') {
      if (m.${SPK_BRIDGE.menusKey} && mbHost) mbStart(m.${SPK_BRIDGE.menusKey});
      return;
    }
    if (m && m.${SPK_BRIDGE.tag} === '${SPK_BRIDGE.checkResponse}') {
      var v = m.${SPK_BRIDGE.checkKey} || {};
      // Three outcomes, not two. "Could not check" must never render as valid — the whole reason this
      // round-trips to the deployment is so the verdict is the real one, and a failed round-trip that
      // reads as a pass would be worse than no check at all.
      if (mbVerdict) {
        if (v.unchecked) mbVerdict.textContent = 'Not checked. ' + v.unchecked;
        else if (v.ok) mbVerdict.textContent = 'Valid — this deployment accepts this config.';
        else mbVerdict.textContent = 'Rejected: ' + (v.error || 'this deployment will not accept this config.');
      }
      return;
    }
    if (!m || m.${SPK_BRIDGE.tag} !== '${SPK_BRIDGE.response}') return;
    // A response arrived — a run was attempted, whatever its outcome — so neither the not-run intro nor
    // the running one is still true, and the button can no longer read "Run Checks" (implying nothing has
    // run). Swap in the SAME strings statusHtml() renders for a doc whose \probes\ is non-null
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
        host.appendChild(checkRow(state, label, r.name || r.id || '', r.detail || '', r.cost || ''));
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
<script>${script(doc.probes !== null, doc.menus.raw)}</script>
</body></html>`;
}
