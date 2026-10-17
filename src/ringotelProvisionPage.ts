/**
 * `ringotelProvisionHtml` — the Ringotel Integration page, served at `GET /kit/ringotel` and opened in
 * the injected bundle's sandboxed modal.
 *
 * ⚠️ THE PAGE FETCHES NOTHING. It runs in a `srcdoc` iframe with no `allow-same-origin`, so it has no
 * origin, no `localStorage` and therefore no `ns_t` to authenticate with. Everything it shows arrives
 * over the `SPK_BRIDGE` protocol from the injected bundle in the portal page, which holds the token and
 * calls the three routes. That is the same arrangement the OneBill page and the integration console use,
 * for the same reason.
 *
 * THE ROWS ARE DRAWN TWICE, and that is the interesting part of this file. The server copy
 * ({@link renderFleetRows} / {@link renderChecklist}) exists so the markup can be asserted without a DOM;
 * the client copy ({@link rowScript}) is what actually runs, because the data arrives after the page does.
 * Two copies of one renderer is exactly the shape this repo has shipped bugs in — so
 * `ringotelProvisionPage.selftest.ts` evaluates the client copy in a VM and asserts it produces the SAME
 * BYTES as the server copy for the same report. A divergence is a failing test rather than a table that
 * renders differently depending on which half you are looking at.
 *
 * THE WRITE SURFACE IS DECIDED BY `doc.canWrite` AND BY NOTHING ELSE. A reader gets `ROW_STUB`, whose
 * renderers draw no control at all — not a disabled one. A disabled button still names an action the
 * reader cannot take, and still ships the code behind it to somebody the route would refuse.
 *
 * Spec: docs/superpowers/specs/2026-09-14-ringotel-integration-page-design.md
 */
import { esc } from './pageShell.js';
import { SPK_BRIDGE } from './spkBridge.js';
import { labelMatches, type ChecklistRow, type ConnectorDiff, type FleetRow, type FleetStateId } from './ringotelProvision.js';

/** What the route knows about the caller and the deployment. Everything else on this page arrives over
 *  the bridge — this is only what the shell itself has to be built from. */
export interface ProvisionDoc {
  /** The caller holds `ringotel.provision.write`. False ⇒ the write surface is not rendered AT ALL. */
  canWrite: boolean;
  version: string;
  /** The domain the page was opened from, when it was opened from inside one. Route-validated against
   *  the caller's own visible domains before it gets here, and attribute-escaped when it is written. */
  prefilter?: string;
  /** `RINGOTEL_SSO_SERVICE_ID` is set — this deployment manages Ringotel sign-in mode at all. */
  ssoConfigured: boolean;
  /** `RINGOTEL_PROVISION_DOMAINS` is set. Unset ⇒ every write is inert and the page says so in both
   *  modes: it is a fact about the deployment, not about the reader. */
  railSet: boolean;
  /** What this operator calls the app — `RINGOTEL_LABEL`, or "Ringotel" when they have not said. It
   *  rides on EVERY document rather than being baked into the page once, because the mirrored renderers
   *  must read it off the report they are handed: a client copy holding a build-time literal would say
   *  one deployment's name while rendering another's data. */
  appLabel: string;
}

/** `GET /kit/ringotel/fleet`. One row per domain the caller can read; `hidden` counts the ones this
 *  deployment's allow/block lists removed and NEVER names them. */
export interface FleetReport {
  rows: FleetRow[];
  hidden: number;
  generatedAt: string;
  /** The resolved connection template's name, or null when it did not resolve. */
  template: string | null;
  /** Why it did not — rendered verbatim, so the operator reads the reason rather than a blank. */
  templateProblem: string | null;
  /** See {@link ProvisionDoc.appLabel}. */
  appLabel: string;
}

/** `GET /kit/ringotel/domain`, and the `report` half of an enable's answer. */
export interface DomainReport {
  domain: string;
  rows: ChecklistRow[];
  /** `derived` is what the domain derives; `current` is the live organization's label, null when there
   *  is no single organization. `current === null` is what "a create is possible here" means on this
   *  page — it is the same fact the org checklist row is built from. */
  label: { derived: string; current: string | null };
  packages: string[];
  defaultPackage: string;
  /** EVERY connection template in the tenant, newest first, each with the ISO stamp the picker shows a
   *  date from (null when the record carries none). A connection is built from one of these ONCE and
   *  nothing records which afterwards, so the choice is offered only where no connection exists yet.
   *
   *  `hasProvision: false` is a template carrying no PBX settings at all; `hasCountry: false` one that
   *  names no dialling country. Either is still LISTED — it exists, and a picker that silently omitted it
   *  would leave an operator hunting for a template they can see in the vendor panel — but its option is
   *  disabled and says WHICH of the two it is, because the create refuses it for that reason. */
  templates: { name: string; createdAt: string | null; hasProvision: boolean; hasCountry: boolean }[];
  /** The CONFIGURED standard's name — what the picker preselects, and what the audit compares against. */
  defaultTemplate: string;
  ssoConfigured: boolean;
  /** The live organization's display name, null when there is none. */
  orgName: string | null;
  /** The NetSapiens domain's own description, null or empty when it has none. Shown in the panel head
   *  and used to prefill the organization name on a create — what the customer is called in the system
   *  of record is a better default than a domain label. */
  nsDescription: string | null;
  /** See {@link ProvisionDoc.appLabel}. */
  appLabel: string;
  /**
   * The domain name of an organization that already exists with NO connection and that a create here
   * would collide with — an earlier run of this page that stopped after its `org` step.
   *
   * Present ⇒ the label input is prefilled with it instead of the derivation, and a line above the inputs
   * says so. Absent ⇒ nothing changes. It is not a suggestion: submitting THIS label is what makes the
   * route recognise the unfinished organization and finish it, and any other one would create a second.
   */
  orphanLabel?: string;
}

/**
 * The fleet states, in the precedence order `fleetState` decides them in, with the words the page shows.
 *
 * The KEY is the state id and is what every attribute, filter and test is written against; the VALUE is
 * read by a person and says what the state IS ("Not set up"), leaving what to DO about it to the row's
 * own detail. The two move independently on purpose — relabelling a chip must never be a data change.
 *
 * A `Record<FleetStateId, string>` on purpose: a state added to the union without a label here fails to
 * compile, where a hand-kept array would quietly render a row with no chip. The ORDER is the object's
 * own insertion order, which is what the filter row is built from.
 */
const STATE_LABELS: Record<FleetStateId, string> = {
  multiple: 'Multiple organizations',
  'no-org': 'Not set up',
  'label-mismatch': 'Domain names differ',
  'signin-differs': 'SSO mismatch',
  'package-differs': 'Different licensing',
  drift: 'Differs from template',
  'not-in-index': 'Not yet indexed',
  enabled: 'Enabled',
};

/** What a checklist verdict says to a person. Same arrangement as STATE_LABELS and for the same reason:
 *  the KEY is the verdict id every class and test is written against, the VALUE is read by an operator.
 *  A `Record<Verdict, string>` so a new verdict cannot ship without words. */
const VERDICT_LABELS: Record<ChecklistRow['verdict'], string> = {
  ok: 'OK', fix: 'Fix needed', info: 'Note', blocked: 'Blocked',
};

/** Every fleet state, in precedence order — the filter row and the selftest both read this. */
export const FLEET_STATES: readonly FleetStateId[] = Object.keys(STATE_LABELS) as FleetStateId[];

/**
 * The two tables' column counts, interpolated into BOTH copies of each renderer and into the static
 * shell. The mirror test would catch a disagreement here (an empty report is one of its fixtures, and an
 * empty row is nothing but a colspan), but a number that cannot be written down twice cannot disagree in
 * the first place — and this is the one number on the page whose two copies have no other reason to move
 * together. The checklist's count is ALSO what decides whether there is an Action column at all.
 */
const FLEET_COLS = 4;
const ckCols = (canWrite: boolean): number => (canWrite ? 4 : 3);

// ── the row renderers, client copy ──────────────────────────────────────────────────────────────────

/** Reading only. Identical in both builds, because what a row SAYS does not depend on who is looking. */
const ROW_BASE = String.raw`
var RP_LABELS=${JSON.stringify(STATE_LABELS)},RP_VERDICTS=${JSON.stringify(VERDICT_LABELS)};
// The fleet table's column count. One value for everybody, not a ternary: the fleet table is the same
// four columns in both builds, because a row names a finding and every action it could offer lives in
// the drilldown, where the choices that action needs are also on screen.
var RP_FCOLS=${FLEET_COLS};` + String.raw`
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
// The "locked" modifier darkens the state's OWN colour rather than replacing it: which colour means
// what must not change just because this page cannot act on the row.
function rpChip(s,locked){return '<span class="chip chip-'+esc(s)+(locked?' locked':'')+'">'+esc(RP_LABELS[s]||s)+'</span>'}
// A lock beside the state, never instead of it: a domain this page may not change can be perfectly well
// set up. Icon-only so the pair fits one line — the WORDS still exist for anyone not reading pixels, as
// the accessible name and the hover, and the reason itself is the last sentence of the row's own detail
// (which differs between an excluded domain and an overridden one, so the tooltip does not repeat it).
// Written as an escape, not as a literal glyph: an astral character in source is a byte sequence grep
// and the leak guard read differently from the rest of the file.
// Rendered BEFORE the state chip, not after: scanning the column for which rows are locked reads left
// to right, and a trailing space (not leading) keeps the gap between the two chips now that the lock
// leads — a leading space here would sit at the start of the cell and collapse away in the browser.
function rpLock(r){return r.enableable?'':'<span class="chip lock" role="img" aria-label="Read-only" title="This page is read-only for this domain.">\u{1F512}</span> '}
// Does this row's label differ from the one its domain derives — INDEPENDENTLY of the state it landed
// in? The "Label mismatches" filter is the mismatch report, and a mismatching domain that is "multiple"
// never reaches the label-mismatch state — an earlier state wins. So the answer rides on the row as an
// attribute and the filter reads the DOM, rather than each re-deriving it from the state.
function rpMismatch(r){return r.orgLabel!=null&&String(r.orgLabel).trim().toLowerCase()!==String(r.expectedLabel).trim().toLowerCase()}
// Three shapes, because the second line answers a different question in each: with no organization it
// says what WILL be created, with a differing one what was EXPECTED, and with a matching one there is
// nothing to say.
function rpLabelCell(r){
if(r.orgLabel==null)return '<span class="dim">none yet</span><div class="dim">will be <code>'+esc(r.expectedLabel)+'</code></div>';
if(rpMismatch(r))return '<b>'+esc(r.orgLabel)+'</b><div class="dim">expected <code>'+esc(r.expectedLabel)+'</code></div>';
return esc(r.orgLabel)}
// "drift" is not rendered here on purpose: fleetState builds this row's own detail from that same
// array ("differs from the template in: app, proxy"), so drawing both would say it twice. The sections
// are shown field by field in the drilldown, which is the only place they can be acted on.
// The row itself is the control — tabindex so it is reachable without a mouse, and no <button> inside
// it, so a reader's fleet table carries no control markup at all.
function rpFleet(rep){var rows=(rep&&rep.rows)||[];
if(!rows.length)return '<tr class="empty"><td colspan="'+RP_FCOLS+'">No domain to show.</td></tr>';
var o='';
for(var i=0;i<rows.length;i++){var r=rows[i];
o+='<tr data-state="'+esc(r.state)+'" data-domain="'+esc(r.domain)+'" data-mismatch="'+(rpMismatch(r)?'1':'0')+'" data-enableable="'+(r.enableable?'1':'0')+'" tabindex="0">'
+'<td class="dom">'+esc(r.domain)+'</td>'
+'<td class="state">'+rpLock(r)+rpChip(r.state,!r.enableable)+'</td>'
+'<td>'+rpLabelCell(r)+'</td>'
+'<td>'+esc(r.detail)+'</td></tr>'}
return o}
function rpVerdict(v){return '<span class="v v-'+esc(v)+'">'+esc(RP_VERDICTS[v]||v)+'</span>'}
// A value the template or the connection does not carry at all is not an empty value — one side having
// the key and the other not having it is the whole finding on some of these rows.
function rpVal(x){return x==null?'<span class="dim">absent</span>':'<code>'+esc(x)+'</code>'}
// The masked keys arrive already masked from diffConnector ('••••' on both sides). Rendering them is
// therefore rendering the mask, and there is nothing here that could un-mask one.
function rpDiff(d){var gs=(d&&d.groups)||[];if(!gs.length)return '';
var o='';
for(var i=0;i<gs.length;i++){var g=gs[i],f=g.fields||[];
o+='<details class="drift"><summary><b>'+esc(g.section)+'</b> — '+f.length+(f.length===1?' field':' fields')+'</summary>'
+'<div class="scroll"><table class="diff"><thead><tr><th>Field</th><th>Template</th><th>This connection</th></tr></thead><tbody>';
for(var j=0;j<f.length;j++)o+='<tr><td><code>'+esc(f[j].key)+'</code></td><td>'+rpVal(f[j].template)+'</td><td>'+rpVal(f[j].branch)+'</td></tr>';
o+='</tbody></table></div></details>'}
return o}
function rpCkRow(r,rep){return '<tr data-step="'+esc(r.step)+'" data-verdict="'+esc(r.verdict)+'">'
+'<td>'+rpVerdict(r.verdict)+'</td>'
+'<td class="step">'+esc(r.title)+'</td>'
+'<td>'+esc(r.detail)+rpDiff(r.diff)+'</td>'
+rpActions(r,rep)+'</tr>'}
// Guards rep.label where the server copy does not have to: the server BUILDS this object and the
// client RECEIVES it from the parent frame, so a malformed reply must render a sentence rather than
// throw and leave the panel half-drawn. The type forbids it, which is why the mirror never sees it.
function rpHead(rep){var o='';
if(rep.nsDescription)o+='<div class="dim">NetSapiens: '+esc(rep.nsDescription)+'</div>';
if(rep.orgName)o+='<div class="dim">'+esc(rep.appLabel)+' organization: '+esc(rep.orgName)+'</div>';
if(!rep.label||rep.label.current==null)o+='<div class="dim">No organization matches this domain yet.</div>';
return o}
// RP_COLS is the checklist's column count and the ONE fact that says whether there is an Action column,
// so the header cell is drawn from it rather than from a second copy of "is this the write build".
function rpChecklist(rep){if(!rep)return '';
var rows=rep.rows||[];
var o='<div class="ck-head"><h2>'+esc(rep.domain)+'</h2>'+rpHead(rep)+'</div>'+rpInputs(rep)
+'<div class="scroll"><table class="rp ck"><thead><tr><th>Status</th><th>Check</th><th>Detail</th>'
+(RP_COLS>3?'<th>Action</th>':'')+'</tr></thead><tbody>';
if(!rows.length)o+='<tr class="empty"><td colspan="'+RP_COLS+'">This domain has no checklist rows.</td></tr>';
for(var i=0;i<rows.length;i++)o+=rpCkRow(rows[i],rep);
return o+'</tbody></table></div>'}
`;

/** The write build. Every control on this page is in here, so a reader's page does not carry its bytes. */
const ROW_WRITE = `
var RP_COLS=${ckCols(true)};` + String.raw`
// A create is possible exactly when no single organization answers to the domain — the same fact the
// "org" checklist row is built from, read once here so the inputs and that row cannot disagree.
function rpNoOrg(rep){return !rep||!rep.label||rep.label.current==null}
// Matched the way packageIdOf, byName and chosenTemplate match — trimmed and case-insensitive — because
// whatever this picker calls "the default" is what the create will be asked for, and a picker that agrees
// with the catalog only on exact bytes disagrees with the layer that resolves the name.
// ⚠️ NOTHING MATCHING IS NOT "PICK THE FIRST ONE". With no option selected the browser selects the first
// and rpChoice would send it, so a default naming something this tenant does not offer would create the
// organization on an arbitrary package, or its connection from an arbitrary template — permanent, on a
// shared tenant. An empty option that cannot be chosen leaves select.value empty, rpChoice omits the
// field, and the apply layer refuses by name instead.
// One function for both pickers: the rule is about "nothing matched", not about what is being picked.
// The value is what the route resolves by name; the label is what the reader chooses by.
function rpOpts(list,sel,ph){var l=list||[],want=String(sel==null?'':sel).trim().toLowerCase(),hit=-1,i;
for(i=0;i<l.length;i++)if(String(l[i].value).trim().toLowerCase()===want){hit=i;break}
var o=hit<0?'<option value="" selected disabled>'+esc(ph)+'</option>':'';
for(i=0;i<l.length;i++)o+='<option value="'+esc(l[i].value)+'"'+(i===hit?' selected':'')+(l[i].disabled?' disabled':'')+'>'+esc(l[i].label)+'</option>';
return o}
// A package is chosen by the only thing it has — its name.
function rpPkgOpts(rep){var p=(rep&&rep.packages)||[],l=[],i;
for(i=0;i<p.length;i++)l.push({value:p[i],label:p[i]});
return rpOpts(l,rep.defaultPackage,'Choose a licensing package')}
// A template is chosen by name and DATE: two templates a year apart are told apart by when they were
// saved, which is the only thing about them the panel shows. The day is SLICED off the ISO stamp rather
// than formatted — a locale-formatted date reads differently for two operators, and differently again in
// the two copies of this renderer, which are held byte-identical.
// A template with no PBX settings is LISTED and DISABLED rather than hidden: it exists in the panel the
// operator is looking at, and "why can I not see it here" is a worse question than "why can I not pick
// it". The create refuses the same template for the same reason, so the option says which one it is.
// TWO reasons a template cannot be built from, said apart: no PBX settings, and no dialling country. One
// disabled state, two sentences, because they send the operator to different fields in the vendor panel.
function rpTplOpts(rep){var t=(rep&&rep.templates)||[],l=[],i,d,n;
for(i=0;i<t.length;i++){d=t[i].createdAt?String(t[i].createdAt).slice(0,10):'';
n=String(t[i].name)+(d?' · '+d:'')+(t[i].hasProvision?'':' · no connection settings')+(t[i].hasCountry?'':' · no country');
l.push({value:t[i].name,label:n,disabled:!t[i].hasProvision||!t[i].hasCountry})}
return rpOpts(l,rep.defaultTemplate,'Choose a connection template')}
// "fixable" is the planner's own "this fix may be offered right now" — off the rail, or with the
// template unresolved, a fix row is "blocked" and carries false. The page never re-derives that.
function rpActions(r,rep){return '<td class="act">'+(r.fixable?'<button type="button" class="btn" data-act="fix" data-step="'+esc(r.step)+'">Fix</button>':'')+'</td>'}
// Label, name, package and template are CREATE-ONLY choices — applyOrg and applyConnector are the only
// steps that read them — so they are offered only where a create is possible. Offering them on a live
// organization would be offering an edit that the next Enable all silently ignores. Sign-in mode is
// offered whenever the deployment manages it, because it is read on a create AND by the sign-in fix.
// rpNoOrg is also "this domain has no connection": the match is made THROUGH a connection at this
// address, so no single organization answers here precisely when no connection does.
// An orphanLabel is an organization an earlier run created and never finished. The label input is
// prefilled with ITS domain name rather than the derivation, because that is the only label the route
// will accept here — every other one is refused as a second organization for the same customer.
function rpInputs(rep){var o='',nm,orph;
if(rpNoOrg(rep)){
nm=rep.orgName||rep.nsDescription||(rep.label?rep.label.derived:'');
orph=rep.orphanLabel||'';
if(orph)o+='<p class="orphnote">An organization named '+esc(nm)+' already exists as '+esc(orph)+' with no connection. The label below is set to '+esc(orph)+', so Enable finishes that organization instead of creating a second one.</p>';
o+='<div class="erow"><label class="elab" for="rp-label">Label</label>'
+'<input id="rp-label" class="txt" type="text" maxlength="64" value="'+esc(orph||(rep.label?rep.label.derived:''))+'">'
+'<span class="note">The '+esc(rep.appLabel)+' domain name. Set when the organization is created; '+esc(rep.appLabel)+' does not allow editing it afterwards.</span></div>';
o+='<div class="erow"><label class="elab" for="rp-orgname">Name</label>'
+'<input id="rp-orgname" class="txt" type="text" maxlength="64" value="'+esc(nm)+'">'
+'<span class="note">What the '+esc(rep.appLabel)+' panel shows. Free text, and not the domain name above.</span></div>';
o+='<div class="erow"><label class="elab" for="rp-pkg">Licensing</label>'
+'<select id="rp-pkg">'+rpPkgOpts(rep)+'</select>'
+'<span class="note">Set when the organization is created and never changed from here.</span></div>';
o+='<div class="erow"><label class="elab" for="rp-template">Template</label>'
+'<select id="rp-template">'+rpTplOpts(rep)+'</select>'
+'<span class="note">What the connection is built from. Set when the connection is created and never changed from here.</span></div>'}
if(rep.ssoConfigured)o+='<div class="erow"><label class="elab" for="rp-signin">Sign-in</label>'
+'<select id="rp-signin"><option value="sso" selected>Single sign-on</option>'
+'<option value="credentials">'+esc(rep.appLabel)+' credentials</option></select>'
+'<span class="note">Single sign-on uses NetSapiens credentials; app credentials sends a welcome email.</span></div>';
o+='<div class="erow"><button type="button" class="btn primary" id="rp-all" data-act="all">Enable all</button>'
+'<span class="note">Runs each fix in order, re-checks after each one, and stops at the first failure.</span></div>';
return '<div class="inputs">'+o+'</div>'}
// A checklist with nothing fixable on it still renders Enable all — the button is what the reader looks
// for — but pressing it would be a round trip that changes nothing, so it is disabled and says why.
function rpAfterRender(rep){var b=document.getElementById('rp-all');if(!b)return;
var rows=(rep&&rep.rows)||[],any=false;
for(var i=0;i<rows.length;i++)if(rows[i].fixable)any=true;
b.disabled=!any;
b.title=any?'':'Nothing on this checklist can be fixed from here.'}
`;

/**
 * The read-only build. The controls are ABSENT, not disabled: a disabled control still names an action
 * the reader cannot take, and still ships the code behind it to somebody the route would refuse. The
 * page says which key would grant them instead, which a page with silently missing controls cannot.
 */
const ROW_STUB = `
// A column that can never hold anything is not an empty column, it is a column that should not be there.
var RP_COLS=${ckCols(false)};` + String.raw`
function rpActions(r,rep){return ''}
function rpInputs(rep){return ''}
// The read-only build has no run-everything button to arm, and rpChecklist must not have to know that.
function rpAfterRender(rep){}
`;

/** The row renderers as they are shipped to this caller. Exported so the selftest can run them in a VM. */
export const rowScript = (canWrite: boolean): string => ROW_BASE + (canWrite ? ROW_WRITE : ROW_STUB);

// ── the same renderers, server-side ─────────────────────────────────────────────────────────────────
// Mirrors rowScript() byte for byte; the selftest asserts that rather than trusting it.

const chip = (s: FleetStateId, locked: boolean): string =>
  `<span class="chip chip-${esc(s)}${locked ? ' locked' : ''}">${esc(STATE_LABELS[s] ?? s)}</span>`;
/** Mirrors `rpLock`. */
const lock = (r: FleetRow): string =>
  (r.enableable ? '' : '<span class="chip lock" role="img" aria-label="Read-only" title="This page is read-only for this domain.">\u{1F512}</span> ');

/** Mirrors `rpMismatch`. Reuses the planner's own `labelMatches`, which is the one reading of "this
 *  label matches this domain" the create path and the fleet row also go through.
 *
 *  `== null` rather than `=== null`, matching the client copy exactly: a report reaches the client over
 *  a wire and a missing key is `undefined` there, so the two copies must read absence the same way. */
const mismatch = (r: FleetRow): boolean => r.orgLabel != null && !labelMatches(r.orgLabel, r.expectedLabel);

/** Mirrors `rpLabelCell`. */
function labelCell(r: FleetRow): string {
  if (r.orgLabel == null) return `<span class="dim">none yet</span><div class="dim">will be <code>${esc(r.expectedLabel)}</code></div>`;
  if (mismatch(r)) return `<b>${esc(r.orgLabel)}</b><div class="dim">expected <code>${esc(r.expectedLabel)}</code></div>`;
  return esc(r.orgLabel);
}

/**
 * The fleet table's rows. Mirrors `rpFleet`.
 *
 * `canWrite` is in the signature and not in the body, deliberately: the fleet table is byte-identical
 * for a reader and a writer, because a row names a finding and every action it could offer lives in the
 * drilldown beside the choices that action needs. It stays in the signature so both renderers on this
 * page have one shape, so the mirror test drives them the same way, and so adding a column one day is
 * not a change at every call site.
 */
export function renderFleetRows(report: FleetReport, canWrite: boolean): string {
  void canWrite;
  const rows = report.rows ?? [];
  if (!rows.length) return `<tr class="empty"><td colspan="${FLEET_COLS}">No domain to show.</td></tr>`;
  return rows.map((r) =>
    `<tr data-state="${esc(r.state)}" data-domain="${esc(r.domain)}" data-mismatch="${mismatch(r) ? '1' : '0'}" data-enableable="${r.enableable ? '1' : '0'}" tabindex="0">`
    + `<td class="dom">${esc(r.domain)}</td>`
    + `<td class="state">${lock(r)}${chip(r.state, !r.enableable)}</td>`
    + `<td>${labelCell(r)}</td>`
    + `<td>${esc(r.detail)}</td></tr>`).join('');
}

const verdict = (v: ChecklistRow['verdict']): string => `<span class="v v-${esc(v)}">${esc(VERDICT_LABELS[v] ?? v)}</span>`;
// `== null` for the reason `mismatch` uses it: the client is handed this report over a wire, where a
// missing key is undefined, so both copies must read absence the same way.
const diffVal = (x: string | null): string => (x == null ? '<span class="dim">absent</span>' : `<code>${esc(x)}</code>`);

/** Mirrors `rpDiff`. */
function diffBlock(d: ConnectorDiff | undefined): string {
  const gs = d?.groups ?? [];
  if (!gs.length) return '';
  return gs.map((g) => {
    const f = g.fields ?? [];
    return `<details class="drift"><summary><b>${esc(g.section)}</b> — ${f.length}${f.length === 1 ? ' field' : ' fields'}</summary>`
      + `<div class="scroll"><table class="diff"><thead><tr><th>Field</th><th>Template</th><th>This connection</th></tr></thead><tbody>`
      + f.map((x) => `<tr><td><code>${esc(x.key)}</code></td><td>${diffVal(x.template)}</td><td>${diffVal(x.branch)}</td></tr>`).join('')
      + `</tbody></table></div></details>`;
  }).join('');
}

/** Mirrors `rpActions`. */
const actionCell = (r: ChecklistRow, canWrite: boolean): string =>
  canWrite ? `<td class="act">${r.fixable ? `<button type="button" class="btn" data-act="fix" data-step="${esc(r.step)}">Fix</button>` : ''}</td>` : '';

/** Mirrors `rpOpts` — including "no match selects nothing", which is what stops a create from landing on
 *  whichever package, or whichever template, the catalog happened to list first. */
function optionList(list: { value: string; label: string; disabled?: boolean }[], sel: string, ph: string): string {
  const l = list ?? [];
  const want = String(sel ?? '').trim().toLowerCase();
  const hit = l.findIndex((p) => String(p.value).trim().toLowerCase() === want);
  return (hit < 0 ? `<option value="" selected disabled>${esc(ph)}</option>` : '')
    + l.map((p, i) => `<option value="${esc(p.value)}"${i === hit ? ' selected' : ''}${p.disabled ? ' disabled' : ''}>${esc(p.label)}</option>`).join('');
}

/** Mirrors `rpPkgOpts`. */
const pkgOptions = (rep: DomainReport): string =>
  optionList((rep.packages ?? []).map((p) => ({ value: p, label: p })), rep.defaultPackage, 'Choose a licensing package');

/** Mirrors `rpTplOpts` — the day sliced off the ISO stamp, never a formatted date. */
const tplOptions = (rep: DomainReport): string =>
  optionList((rep.templates ?? []).map((t) => {
    const d = t.createdAt ? String(t.createdAt).slice(0, 10) : '';
    const label = `${String(t.name)}${d ? ` · ${d}` : ''}${t.hasProvision ? '' : ' · no connection settings'}${t.hasCountry ? '' : ' · no country'}`;
    return { value: t.name, label, disabled: !t.hasProvision || !t.hasCountry };
  }), rep.defaultTemplate, 'Choose a connection template');

/** Mirrors `rpInputs`. */
function inputsBlock(rep: DomainReport, canWrite: boolean): string {
  if (!canWrite) return '';
  let o = '';
  if (rep.label.current == null) {
    const nm = rep.orgName || rep.nsDescription || rep.label.derived;
    const orph = rep.orphanLabel || '';
    if (orph) o += `<p class="orphnote">An organization named ${esc(nm)} already exists as ${esc(orph)} with no connection. The label below is set to ${esc(orph)}, so Enable finishes that organization instead of creating a second one.</p>`;
    o += `<div class="erow"><label class="elab" for="rp-label">Label</label>`
      + `<input id="rp-label" class="txt" type="text" maxlength="64" value="${esc(orph || rep.label.derived)}">`
      + `<span class="note">The ${esc(rep.appLabel)} domain name. Set when the organization is created; ${esc(rep.appLabel)} does not allow editing it afterwards.</span></div>`;
    o += `<div class="erow"><label class="elab" for="rp-orgname">Name</label>`
      + `<input id="rp-orgname" class="txt" type="text" maxlength="64" value="${esc(nm)}">`
      + `<span class="note">What the ${esc(rep.appLabel)} panel shows. Free text, and not the domain name above.</span></div>`;
    o += `<div class="erow"><label class="elab" for="rp-pkg">Licensing</label>`
      + `<select id="rp-pkg">${pkgOptions(rep)}</select>`
      + `<span class="note">Set when the organization is created and never changed from here.</span></div>`;
    o += `<div class="erow"><label class="elab" for="rp-template">Template</label>`
      + `<select id="rp-template">${tplOptions(rep)}</select>`
      + `<span class="note">What the connection is built from. Set when the connection is created and never changed from here.</span></div>`;
  }
  if (rep.ssoConfigured) o += `<div class="erow"><label class="elab" for="rp-signin">Sign-in</label>`
    + `<select id="rp-signin"><option value="sso" selected>Single sign-on</option>`
    + `<option value="credentials">${esc(rep.appLabel)} credentials</option></select>`
    + `<span class="note">Single sign-on uses NetSapiens credentials; app credentials sends a welcome email.</span></div>`;
  o += `<div class="erow"><button type="button" class="btn primary" id="rp-all" data-act="all">Enable all</button>`
    + `<span class="note">Runs each fix in order, re-checks after each one, and stops at the first failure.</span></div>`;
  return `<div class="inputs">${o}</div>`;
}

/** Mirrors `rpHead`. */
const ckHead = (rep: DomainReport): string =>
  (rep.nsDescription ? `<div class="dim">NetSapiens: ${esc(rep.nsDescription)}</div>` : '')
  + (rep.orgName ? `<div class="dim">${esc(rep.appLabel)} organization: ${esc(rep.orgName)}</div>` : '')
  + (rep.label.current == null ? `<div class="dim">No organization matches this domain yet.</div>` : '');

/** One domain's checklist panel. Mirrors `rpChecklist`. */
export function renderChecklist(report: DomainReport, canWrite: boolean): string {
  const cols = ckCols(canWrite);
  const rows = report.rows ?? [];
  let o = `<div class="ck-head"><h2>${esc(report.domain)}</h2>${ckHead(report)}</div>${inputsBlock(report, canWrite)}`
    + `<div class="scroll"><table class="rp ck"><thead><tr><th>Status</th><th>Check</th><th>Detail</th>`
    + `${cols > 3 ? '<th>Action</th>' : ''}</tr></thead><tbody>`;
  if (!rows.length) o += `<tr class="empty"><td colspan="${cols}">This domain has no checklist rows.</td></tr>`;
  o += rows.map((r) =>
    `<tr data-step="${esc(r.step)}" data-verdict="${esc(r.verdict)}">`
    + `<td>${verdict(r.verdict)}</td>`
    + `<td class="step">${esc(r.title)}</td>`
    + `<td>${esc(r.detail)}${diffBlock(r.diff)}</td>`
    + `${actionCell(r, canWrite)}</tr>`).join('');
  return o + `</tbody></table></div>`;
}

// ── the stylesheet ──────────────────────────────────────────────────────────────────────────────────

const STYLE = `
:root { color-scheme: light dark; --fg:#1e293b; --dim:#64748b; --bg:#f8fafc; --card:#fff; --line:#e2e8f0;
        --red:#b91c1c; --amber:#b45309; --blue:#1a6bb0; --green:#15803d; --grey:#94a3b8; --integ:#b45309;
        /* Ink for anything printed ON one of those fills; it flips with the theme because the fills do. */
        --onink:#fff; }
@media (prefers-color-scheme: dark) { :root { --fg:#e2e8f0; --dim:#94a3b8; --bg:#0f172a; --card:#1e293b;
        --line:#334155; --red:#f87171; --amber:#fbbf24; --blue:#5b8bc0; --green:#4ade80; --grey:#64748b;
        --integ:#fbbf24; --onink:#0f172a; } }
* { box-sizing:border-box; }
html, body { max-width:100%; }
body { margin:0; padding:0 1rem 2.5rem; background:var(--bg); color:var(--fg);
       font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:78rem; margin:0 auto; }
h1 { font-size:1.25rem; margin:0; }
h2 { font-size:1rem; margin:0 0 .2rem; }
code { background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:.05rem .3rem;
       font-size:.9em; word-break:break-word; }
.dim { color:var(--dim); }
.warn { color:var(--amber); }
.rp-head { border-top:3px solid var(--integ); padding-top:.7rem; margin-bottom:1rem;
           border-bottom:1px solid var(--line); padding-bottom:.7rem; }
.eyebrow { color:var(--integ); font-size:.7rem; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
.title-row { display:flex; align-items:baseline; gap:.6rem; flex-wrap:wrap; margin-top:.15rem; }
.grow { flex:1 1 auto; }
.ver { color:var(--dim); font-size:.85em; }
.meta { color:var(--dim); font-size:.85rem; margin-top:.35rem; display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
.meta .sep { opacity:.5; }
.btn { font:inherit; font-size:.85rem; padding:.28rem .7rem; border-radius:5px; border:1px solid var(--line);
       background:var(--card); color:var(--fg); cursor:pointer; }
.btn:hover { border-color:var(--integ); }
.btn.primary { background:var(--integ); border-color:var(--integ); color:var(--onink); font-weight:600; }
.btn:disabled { opacity:.55; cursor:default; }
.fbtn { font:inherit; font-size:.75rem; padding:.15rem .5rem; border-radius:999px; border:1px solid var(--line);
        background:var(--card); color:var(--dim); cursor:pointer; }
.fbtn[aria-pressed="true"] { background:var(--integ); border-color:var(--integ); color:var(--onink); font-weight:600; }
.filters { display:flex; gap:.35rem; flex-wrap:wrap; align-items:center; margin:.8rem 0 .4rem; }
.bar { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; margin:.4rem 0 .8rem; }
input[type="search"], input.txt { font:inherit; font-size:.85rem; padding:.22rem .4rem; border:1px solid var(--line);
       border-radius:4px; background:var(--card); color:var(--fg); max-width:18rem; }
select { font:inherit; font-size:.85rem; padding:.2rem .35rem; border:1px solid var(--line);
       border-radius:4px; background:var(--card); color:var(--fg); }
.chip { display:inline-block; font-size:.75rem; font-weight:600; padding:.12rem .45rem;
        border-radius:4px; border:1px solid transparent; white-space:nowrap; }
.chip-enabled { color:var(--onink); background:var(--green); }
.chip-no-org, .chip-label-mismatch, .chip-signin-differs { color:var(--onink); background:var(--amber); }
.chip-multiple { color:var(--onink); background:var(--red); }
.chip-drift, .chip-not-in-index { color:var(--onink); background:var(--blue); }
.chip-package-differs { color:var(--dim); background:transparent; border-color:var(--grey); }
/* The lock is an icon, so it carries no text metrics of its own — the padding and line-height come from
   .chip and the glyph is sized to sit level with the state chip's capitals. */
.chip.lock { background:transparent; border-color:var(--grey); border-style:dashed; font-size:.9em;
             line-height:1; padding:.16rem .3rem; }
/* Darker, not different: the state keeps its own hue, so which colour means what does not change just
   because this page cannot act on the row. One declaration that follows every chip colour, including the
   two outline ones, rather than a darker token per state to keep in step with the palette above. */
.chip.locked { filter:brightness(.75); }
.v { display:inline-block; font-size:.75rem; font-weight:600; padding:.12rem .45rem;
     border-radius:4px; border:1px solid transparent; white-space:nowrap; }
.v-ok { color:var(--onink); background:var(--green); }
.v-fix { color:var(--onink); background:var(--amber); }
.v-blocked { color:var(--onink); background:var(--red); }
.v-info { color:var(--dim); background:transparent; border-color:var(--grey); }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:8px; background:var(--card); }
table.rp { border-collapse:collapse; width:100%; font-size:.88rem; }
table.rp th { text-align:left; font-size:.72rem; letter-spacing:.04em; text-transform:uppercase; color:var(--dim);
              padding:.5rem .7rem; border-bottom:1px solid var(--line); white-space:nowrap; }
table.rp td { padding:.45rem .7rem; border-bottom:1px solid var(--line); vertical-align:top; }
table.rp tr:last-child td { border-bottom:0; }
table.rp tbody tr[data-domain] { cursor:pointer; }
table.rp tbody tr[data-domain]:hover { background:color-mix(in srgb, var(--integ) 8%, transparent); }
table.rp tbody tr[data-domain]:focus-visible { outline:2px solid var(--integ); outline-offset:-2px; }
/* Where you just were. Closing the panel scrolls this row back into the middle of the screen and marks
   it for a moment — without it the page snaps to wherever the panel left the viewport, which on a long
   fleet is nowhere near the row that was clicked. */
tr.just td { background:color-mix(in srgb, var(--integ) 18%, transparent); }
td.dom { font-weight:600; }
td.act { white-space:nowrap; }
/* Wide enough for the lock chip plus the longest STATE_LABELS value ("Multiple organizations", 22
   chars — longer than "Differs from template") so that pair never wraps onto two lines; the domain and
   detail columns have no such floor, so auto table layout gives this column its room by shrinking them
   (detail already wraps: it's prose, not a chip). */
td.state { white-space:nowrap; min-width:14em; }
table.diff { border-collapse:collapse; width:100%; font-size:.82rem; }
table.diff th, table.diff td { text-align:left; padding:.3rem .55rem; border-bottom:1px solid var(--line); vertical-align:top; }
details.drift { margin-top:.4rem; }
details.drift summary { cursor:pointer; color:var(--blue); font-size:.85rem; }
.note { color:var(--dim); font-size:.8rem; }
.ck-head { margin:0 0 .6rem; }
.inputs { border:1px solid var(--line); border-radius:8px; background:var(--card); padding:.6rem .8rem; margin-bottom:.8rem; }
.erow { display:flex; gap:.45rem; align-items:center; flex-wrap:wrap; margin-top:.35rem; }
.erow:first-child { margin-top:0; }
.elab { font-size:.72rem; letter-spacing:.04em; text-transform:uppercase; color:var(--dim); min-width:5rem; }
.res { border:1px solid var(--line); border-left:3px solid var(--green); border-radius:6px; background:var(--card);
       padding:.45rem .7rem; margin-bottom:.4rem; font-size:.88rem; }
.res.bad { border-left-color:var(--red); }
.fail { border:1px solid var(--red); border-left:3px solid var(--red); border-radius:6px; background:var(--card);
        padding:.5rem .7rem; margin:.6rem 0; }
.fail b { color:var(--red); }
.ronote, .railnote, .orphnote { border-left:3px solid var(--integ); background:var(--card); padding:.45rem .7rem;
          margin:0 0 .7rem; border-radius:0 6px 6px 0; font-size:.88rem; }
#rp-panel { margin-top:1.4rem; border-top:1px solid var(--line); padding-top:.9rem; }
.busy { position:fixed; inset:0; background:rgb(15 23 42 / .35); display:flex; align-items:center;
        justify-content:center; z-index:30; }
/* A class setting display BEATS the UA's [hidden]{display:none}, so without this line rpBusy(false)
   sets the attribute and the overlay stays on screen forever — the page reads as stuck on "Loading…"
   over a table that has already rendered. Every element this script toggles with .hidden needs the same
   rule if any selector matching it sets display; the selftest sweeps for that rather than trusting it. */
.busy[hidden] { display:none; }
.busy-box { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:1rem 1.4rem;
            display:flex; gap:.7rem; align-items:center; font-size:.9rem; }
.spinner { width:1rem; height:1rem; border:2px solid var(--line); border-top-color:var(--integ);
           border-radius:50%; animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation:none; } }
`;

// ── the page script ─────────────────────────────────────────────────────────────────────────────────

/** What each enable step is called in a sentence. The step IDS are the wire (`ask('enable', { step })`)
 *  and never change; these are the words beside them, so an outcome line reads "the connection —
 *  created" rather than naming a field of the request body back at the operator. */
const STEP_WORDS: Record<string, string> = {
  all: 'every step', org: 'the organization', signin: 'sign-in', connector: 'the connection',
  index: 'the organization list', reconcile: 'the directory sync',
};

/** Everything that writes. Shipped only to a caller the route would accept a write from. */
const WRITE_JS = `
var RP_STEP_WORDS=${JSON.stringify(STEP_WORDS)};` + String.raw`
// The choices an enable carries, read from the DOM at CLICK time rather than remembered at render time:
// the inputs are what the operator last typed, and a value captured when the panel was drawn is a value
// the operator may have changed since. Empty is omitted rather than sent as '' — the apply layer reads
// "absent" as "use the derivation / the default", and '' as a value it must validate.
function rpChoice(){var c={},e;
e=document.getElementById('rp-label');if(e&&e.value.trim())c.label=e.value.trim();
e=document.getElementById('rp-orgname');if(e&&e.value.trim())c.orgName=e.value.trim();
e=document.getElementById('rp-pkg');if(e&&e.value)c.pkg=e.value;
e=document.getElementById('rp-template');if(e&&e.value)c.template=e.value;
e=document.getElementById('rp-signin');if(e&&e.value)c.signin=e.value;
return c}
// An org created from here is live on a SHARED Ringotel tenant — every other deployment's fleet-wide
// rails adopt it — so the dialog names the domain and says where the write lands. Asked BEFORE anything
// is marked in flight: being asked twice and answered once is worse than a click that does nothing.
function rpEnable(step,words){if(!RP_DOMAIN)return;
if(!confirm(words+' on '+RP_DOMAIN+'?\n\nThis changes the live '+RP_LABEL+' account.'))return;
rpBusy(true,'Writing to '+RP_LABEL+'…');rpSay('Enabling '+RP_DOMAIN+' …');
ask('enable',{domain:RP_DOMAIN,step:step,choice:rpChoice()})}
document.addEventListener('click',function(ev){
var t=ev.target&&ev.target.closest?ev.target.closest('button[data-act="fix"],button[data-act="all"]'):null;
if(!t||t.disabled)return;
if(t.getAttribute('data-act')==='all'){rpEnable('all','Run every fix');return}
var step=t.getAttribute('data-step');if(!step)return;
rpEnable(step,'Fix '+rpStepWords(step))});
`;

function pageScript(doc: ProvisionDoc): string {
  return `(function(){
${rowScript(doc.canWrite)}
// Is there a parent to ask? Rendered anywhere else — a saved page, a devtools reload of the srcdoc —
// the messages go nowhere, and a page that sits on "Loading…" forever is claiming work is in flight
// when none is.
var HOSTED=false;try{HOSTED=window.parent&&window.parent!==window}catch(e){HOSTED=false}
// The app's name for the page's OWN chrome — dialogs, the busy overlay. The mirrored renderers do NOT
// read this: they take it off the report they are handed, so a client copy can never say one
// deployment's name over another deployment's data.
var RP_LABEL=${JSON.stringify(doc.appLabel)};
var elRows=document.getElementById('rp-rows'),elCk=document.getElementById('rp-ck'),
elPanel=document.getElementById('rp-panel'),elRes=document.getElementById('rp-res'),
elGen=document.getElementById('rp-gen'),elTpl=document.getElementById('rp-tpl'),elSay=document.getElementById('rp-say'),
elHidden=document.getElementById('rp-hidden'),elFail=document.getElementById('rp-fail'),
elBusy=document.getElementById('rp-busy'),elBusyText=document.getElementById('rp-busy-text'),
elFilter=document.getElementById('rp-filter'),elFcount=document.getElementById('rp-filter-count'),
elPre=document.getElementById('rp-prefilter'),elPreDom=document.getElementById('rp-prefilter-dom');
function rpSay(t){if(elSay)elSay.textContent=t}
// Every .btn, not just the one that was pressed: a second write racing the first is the failure this
// prevents, and disabling only the button that started this one leaves every other one clickable. The
// state filters are .fbtn and stay live — filtering a table is not a request.
function rpBusy(v,text){if(elBusy){elBusy.hidden=!v;if(text&&elBusyText)elBusyText.textContent=text}
var bs=document.querySelectorAll('.btn');for(var i=0;i<bs.length;i++)bs[i].disabled=v}
function fmtWhen(s){try{return new Date(s).toLocaleString()}catch(x){return String(s||'')}}
// One outstanding question per id, and the OP is remembered with it: a fleet refresh and an enable can
// be in flight at once, and rendering one as the other would redraw the page from the wrong document.
var RID=0,PEND={},RP_DOMAIN=null;
function ask(op,payload){RID++;PEND[RID]=op;
var q={op:op};
if(payload)for(var k in payload)if(Object.prototype.hasOwnProperty.call(payload,k))q[k]=payload[k];
if(!HOSTED){delete PEND[RID];
deliver(op,{unavailable:'This page is not running inside the portal, so it cannot reach this deployment.'});return}
window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.provisionRequest}', ${SPK_BRIDGE.idKey}: RID, ${SPK_BRIDGE.provisionKey}: q },'*')}
// A failed read is NOT an empty table. An empty fleet says "no domain is enabled for the app", which is
// a confident answer to a question that was never successfully asked.
function failFleet(why){rpSay('');
if(elRows)elRows.innerHTML='<tr class="empty"><td colspan="'+RP_FCOLS+'">'+esc(why)+'</td></tr>';
if(elFail)elFail.innerHTML='<div class="fail"><b>The domain list did not load</b><div>'+esc(why)+'</div></div>'}
// Escaped, because a refusal can quote text the caller typed — a label, a package name — straight back.
function failDomain(why,op){if(elPanel)elPanel.hidden=false;
if(elRes)elRes.innerHTML='<div class="res bad"><b>'+(op==='enable'?'Nothing was enabled':'This domain did not load')+'</b><div>'+esc(why)+'</div></div>'}
function renderFleet(rep){
if(elRows)elRows.innerHTML=rpFleet(rep);
if(elGen)elGen.textContent=rep.generatedAt?('Read '+fmtWhen(rep.generatedAt)):'';
if(elTpl)elTpl.innerHTML=rep.templateProblem?('<span class="warn">'+esc(rep.templateProblem)+'</span>')
:(rep.template?('Template '+esc(rep.template)):'');
// COUNTED, never named: a domain this deployment hides must not be discoverable from the page that
// counts it.
if(elHidden)elHidden.textContent=rep.hidden?(rep.hidden===1
?"1 domain hidden by this deployment's allow/block lists"
:rep.hidden+" domains hidden by this deployment's allow/block lists"):'';
if(elFail)elFail.innerHTML='';
rpApplyFilter()}
function renderCk(rep){RP_DOMAIN=rep.domain;
if(elCk)elCk.innerHTML=rpChecklist(rep);
if(elPanel)elPanel.hidden=false;
rpAfterRender(rep);
if(elPanel&&elPanel.scrollIntoView)elPanel.scrollIntoView({block:'start'})}
// What an enable actually did, step by step, and where it stopped. A refusal that rendered nowhere is a
// silent no-op, which is the one thing this bridge's reply must never be.
// The step words live in the WRITE build (only a writer ever sees an outcome), so this falls back to
// the id rather than assuming the map is there.
function rpStepWords(id){return (typeof RP_STEP_WORDS!=='undefined'&&RP_STEP_WORDS[id])||id}
function rpOutcomes(v){var o=v.outcomes||[],s=v.stoppedAt,h='';
// "from <template>" appears ONLY when the connection was built from something other than the configured
// standard — Ringotel keeps no record of which template a connection came from, so this line is the one
// place that is ever said, and the standard needs no saying because the page already names it.
for(var i=0;i<o.length;i++)h+='<div class="res"><b>'+esc(rpStepWords(o[i].step))+'</b> — '+esc(o[i].action)+(o[i].template?' from '+esc(o[i].template):'')+'</div>';
if(s)h+='<div class="res bad"><b>Stopped at '+esc(rpStepWords(s.step))+'</b><div>'+esc(s.error||'This deployment gave no reason.')+'</div></div>';
if(!h)h='<div class="res"><b>Nothing to do</b><div>No step changed anything.</div></div>';
if(elRes)elRes.innerHTML=h}
function deliver(op,v){rpBusy(false);rpSay('');v=v||{};
if(v.unavailable){if(op==='fleet')failFleet(v.unavailable);else failDomain(v.unavailable,op);return}
if(op==='fleet'){renderFleet(v.fleet||{rows:[],hidden:0,generatedAt:'',template:null,templateProblem:null});return}
// BEFORE the report is looked for: an enable that stopped carries its reason here, and a reply with a
// reason but no checklist must still show the reason rather than "answered with no checklist", which
// names nothing the operator can act on.
if(op==='enable')rpOutcomes(v);else if(elRes)elRes.innerHTML='';
var rep=v.checklist||v.report,wrote=op==='enable'&&!!(v.outcomes&&v.outcomes.length);
if(rep)renderCk(rep);
else if(op!=='enable')failDomain('This deployment answered with no checklist.',op);
else if(elPanel)elPanel.hidden=false;
// The table behind the panel was read before this write, so it now says something that is no longer
// true. Re-reading it costs one fleet dig and is the difference between closing the panel onto the
// truth and closing it onto the state the domain was in before the operator changed it. Only when a
// step actually ran: an enable refused before its first step changed nothing to re-read.
if(wrote)ask('fleet',{refresh:true})}
// The id is REQUIRED, not optional: this protocol pair ships with the bundle that speaks it, so there is
// no older parent to degrade for, and an untagged reply rendered against the wrong question is exactly
// what the id exists to prevent.
window.addEventListener('message',function(e){var m=e.data;if(!m)return;
if(m.${SPK_BRIDGE.tag}!=='${SPK_BRIDGE.provisionResponse}')return;
var id=m.${SPK_BRIDGE.idKey};if(id==null)return;
var op=PEND[id];if(!op)return;
delete PEND[id];
deliver(op,m.${SPK_BRIDGE.provisionKey}||{})});
// ── filtering ──────────────────────────────────────────────────────────────────────────────────────
// Three independent narrowings over one row set: the state chips, the label-mismatch shortcut, and the
// text box the prefilter lands in. Read off the row's own attributes rather than re-derived, so the
// mismatch report still lists a mismatching domain whose state is "multiple".
var RP_STATE='all',RP_ONLY='';
function rpApplyFilter(){var q=elFilter?String(elFilter.value||'').trim().toLowerCase():'';
var rows=document.querySelectorAll('#rp-rows tr[data-domain]'),shown=0,total=rows.length;
for(var i=0;i<rows.length;i++){var tr=rows[i];
var vis=(RP_STATE==='all'||tr.getAttribute('data-state')===RP_STATE)
&&(!RP_ONLY||(RP_ONLY==='mismatch'?tr.getAttribute('data-mismatch')==='1':tr.getAttribute('data-enableable')==='0'))
&&(!q||String(tr.getAttribute('data-domain')||'').toLowerCase().indexOf(q)>=0);
tr.style.display=vis?'':'none';if(vis)shown++}
if(elFcount)elFcount.textContent=(q||RP_ONLY||RP_STATE!=='all')?(shown+' of '+total+' domains'):''}
function rpMarkFilters(){var bs=document.querySelectorAll('.fbtn');
for(var i=0;i<bs.length;i++){var b=bs[i],only=b.getAttribute('data-only');
var on=only?RP_ONLY===only:(b.getAttribute('data-filter')===RP_STATE&&!RP_ONLY);
b.setAttribute('aria-pressed',on?'true':'false')}}
// Found by WALKING and comparing the attribute, never by building a selector out of the domain: a
// domain is data, and a quote or a bracket in one makes a selector that throws or matches another row.
function rpRowFor(d){var rows=document.querySelectorAll('#rp-rows tr[data-domain]');
for(var i=0;i<rows.length;i++)if(rows[i].getAttribute('data-domain')===d)return rows[i];
return null}
// The row may be GONE — the table is re-read after an enable, and a filter can hide it — so the fallback
// is the top of the page rather than leaving the viewport wherever the panel left it.
function rpBack(){var d=RP_DOMAIN;
if(elPanel)elPanel.hidden=true;if(elCk)elCk.innerHTML='';if(elRes)elRes.innerHTML='';RP_DOMAIN=null;
var row=d?rpRowFor(d):null;
if(row&&row.scrollIntoView){row.scrollIntoView({block:'center'});
row.classList.add('just');setTimeout(function(){row.classList.remove('just')},1500)}
else window.scrollTo(0,0)}
function rpOpen(d){if(!d)return;RP_DOMAIN=d;
if(elRes)elRes.innerHTML='';
rpBusy(true,'Reading this domain…');rpSay('Reading '+d+' …');
ask('domain',{domain:d})}
function rpLoad(refresh){rpBusy(true,refresh?'Re-reading the domain list…':'Loading…');
rpSay(refresh?'Re-reading the domain list …':'Loading …');
ask('fleet',{refresh:!!refresh})}
document.addEventListener('click',function(ev){var t=ev.target&&ev.target.closest
?ev.target.closest('.fbtn,#rp-refresh,#rp-back,#rp-reload,#rp-prefilter-clear,tr[data-domain]'):null;
if(!t)return;
if(t.id==='rp-refresh'){rpLoad(true);return}
if(t.id==='rp-back'){rpBack();return}
if(t.id==='rp-reload'){rpOpen(RP_DOMAIN);return}
if(t.id==='rp-prefilter-clear'){ev.preventDefault();if(elFilter)elFilter.value='';if(elPre)elPre.hidden=true;rpApplyFilter();return}
if(t.classList&&t.classList.contains('fbtn')){
var only=t.getAttribute('data-only');
if(only){RP_ONLY=RP_ONLY===only?'':only;if(RP_ONLY)RP_STATE='all'}
else{RP_STATE=t.getAttribute('data-filter')||'all';RP_ONLY=''}
rpMarkFilters();rpApplyFilter();return}
rpOpen(t.getAttribute('data-domain'))});
// The row is the control, so it answers to the keyboard the way a control does. Space is prevented from
// scrolling the page out from under the panel it just opened.
document.addEventListener('keydown',function(ev){if(ev.key!=='Enter'&&ev.key!==' ')return;
var t=ev.target&&ev.target.closest?ev.target.closest('tr[data-domain]'):null;
if(!t)return;ev.preventDefault();rpOpen(t.getAttribute('data-domain'))});
if(elFilter){elFilter.addEventListener('input',rpApplyFilter);
elFilter.addEventListener('keydown',function(ev){if(ev.key==='Escape'){elFilter.value='';rpApplyFilter()}})}
// ── the domain this page was opened FOR, if any ────────────────────────────────────────────────────
// data-prefilter is route-validated (the worker checks it against the caller's own visible domains) and
// attribute-escaped, so reading it back here needs no further checking. It narrows the table rather than
// opening the drilldown: a drilldown is a fresh 1+N read of the Ringotel tenant, and opening the page
// should not spend that before the operator has asked for it.
var RP_PRE=document.body.getAttribute('data-prefilter');
if(RP_PRE&&elFilter){elFilter.value=RP_PRE;
if(elPreDom)elPreDom.textContent=RP_PRE;
if(elPre)elPre.hidden=false}
${doc.canWrite ? WRITE_JS : ''}
rpLoad(false);
})();`;
}

// ── the document ────────────────────────────────────────────────────────────────────────────────────

const RAIL_NOTE = 'No domain can be enabled from here until <code>RINGOTEL_PROVISION_DOMAINS</code> is set. The audit below still runs.';

export function ringotelProvisionHtml(doc: ProvisionDoc): string {
  const filters = [`<button type="button" class="fbtn" data-filter="all" aria-pressed="true">All</button>`]
    .concat(FLEET_STATES.map((s) => `<button type="button" class="fbtn" data-filter="${esc(s)}" aria-pressed="false">${esc(STATE_LABELS[s])}</button>`))
    .concat([`<button type="button" class="fbtn" data-only="mismatch" aria-pressed="false" title="Every domain whose names differ, including the ones shown under another state.">Domain names differ (any state)</button>`,
      `<button type="button" class="fbtn" data-only="readonly" aria-pressed="false" title="Domains this page may not change, whatever state they are in.">Read-only</button>`])
    .join('\n    ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.appLabel)} Integration</title>
<style>${STYLE}</style></head><body${doc.prefilter ? ` data-prefilter="${esc(doc.prefilter)}"` : ''}><main>
<header class="rp-head">
  <div class="eyebrow">Integration</div>
  <div class="title-row"><h1>${esc(doc.appLabel)} Integration</h1><span class="ver">v${esc(doc.version)}</span><span class="grow"></span>
    <button id="rp-refresh" class="btn primary" type="button">Refresh</button></div>
  <div class="meta"><span id="rp-gen">Loading…</span><span class="sep">·</span><span id="rp-tpl"></span>
    <span id="rp-say"></span></div>
</header>
${doc.canWrite ? '' : `<p class="ronote">This page is read-only for you. Enabling a domain and fixing a row need the <code>ringotel.provision.write</code> key.</p>`}
${doc.railSet ? '' : `<p class="railnote">${RAIL_NOTE}</p>`}
${doc.ssoConfigured ? '' : `<p class="dim">This deployment does not manage ${esc(doc.appLabel)} sign-in: <code>RINGOTEL_SSO_SERVICE_ID</code> is not set.</p>`}
<div id="rp-normal">
<div class="filters">
    ${filters}
</div>
<div class="bar">
  <input id="rp-filter" type="search" placeholder="Filter by domain">
  <span id="rp-filter-count" class="dim"></span>
  <span id="rp-prefilter" class="dim" hidden>Showing <b id="rp-prefilter-dom"></b> — <a href="#" id="rp-prefilter-clear">Show all</a></span>
</div>
<p id="rp-hidden" class="dim"></p>
<div class="scroll"><table class="rp">
<thead><tr><th>NetSapiens domain</th><th>State</th><th>${esc(doc.appLabel)} domain</th><th>Detail</th></tr></thead>
<tbody id="rp-rows"><tr class="empty"><td colspan="${FLEET_COLS}">Loading…</td></tr></tbody>
</table></div>
<div id="rp-fail"></div>
</div>
<section id="rp-panel" hidden>
  <div class="bar"><button id="rp-back" class="btn" type="button">Back to the domain list</button>
    <button id="rp-reload" class="btn" type="button">Re-read this domain</button></div>
  <div id="rp-res"></div>
  <div id="rp-ck"></div>
</section>
</main>
<div id="rp-busy" class="busy" hidden><div class="busy-box"><div class="spinner" aria-hidden="true"></div>
  <div id="rp-busy-text">Loading…</div></div></div>
<script>${pageScript(doc)}</script>
</body></html>`;
}
