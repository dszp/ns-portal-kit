/** Offline test for the Ringotel Integration page renderer. pnpm test:provisionpage */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  FLEET_STATES, renderFleetRows, renderChecklist, ringotelProvisionHtml, rowScript,
  type DomainReport, type FleetReport, type ProvisionDoc,
} from './ringotelProvisionPage.js';
import { diffConnector, type ChecklistRow, type FleetStateId } from './ringotelProvision.js';
import { SPK_BRIDGE } from './spkBridge.js';
import { esc } from './pageShell.js';
import { buildSpkBundle } from './kit.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

const scriptOf = (html: string): string =>
  html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────
// Fictional throughout (example.com / acme / demo.12345.service): this repo generates a PUBLIC mirror,
// and a fixture there is published forever.

/** The two secrets the connector diff must NEVER render. They are real-shaped strings on purpose — the
 *  assertion below is "neither of these appears anywhere in the output", which is only worth making
 *  against a value that would be recognisable if it leaked. */
const T_SECRET = 'template-proxy-pass-fixture';
const B_SECRET = 'branch-proxy-pass-fixture';

/** Built by the real `diffConnector` rather than hand-written, so the masking under test is the
 *  product's own and not the fixture's. Two sections (`app`, `proxy`), one of them a masked key. */
const DRIFT = diffConnector(
  { country: 'US', provision: { proxy: { pserver: 'sip.example.com', ppass: T_SECRET }, app: { showQr: true } } },
  { address: 'initech.example', country: 'US', provision: { proxy: { pserver: 'sip.alt.example.com', ppass: B_SECRET }, app: { showQr: false } } },
);

/** One row per fleet state, plus a domain whose name carries markup — the row renderer escapes every
 *  value it is handed, and a domain is the one field an operator never chose. */
const APP = 'Acme App';

const FLEET = (label = APP): FleetReport => ({
  generatedAt: '2026-09-14T12:00:00.000Z',
  hidden: 2,
  template: 'Standard Connection',
  templateProblem: null,
  appLabel: label,
  rows: [
    { domain: 'globex.example', state: 'multiple', orgLabel: 'globex', expectedLabel: 'globex', enableable: true, detail: '2 organizations answer to this domain; this page does not act on it.' },
    // NOT a state: the rail says what this PAGE may do, so the domain still reports its real audit state
    // and carries the lock beside it. Two read-only rows, in different states, so the shortcut filter has
    // something to gather that the state chips cannot.
    { domain: 'initech.example', state: 'enabled', orgLabel: 'initech', expectedLabel: 'initech', enableable: false, detail: 'The organization, its connection and the cached organization list all match. This page is read-only for this domain. Add it to RINGOTEL_PROVISION_DOMAINS to allow changes.' },
    { domain: 'acme.example', state: 'no-org', orgLabel: null, expectedLabel: 'acme', enableable: true, detail: 'No organization matches this domain yet. Open it to set one up.' },
    { domain: 'umbrella.example', state: 'label-mismatch', orgLabel: 'umbrella-old', expectedLabel: 'umbrella', enableable: true, detail: 'The Acme App domain name "umbrella-old" is not the NetSapiens short domain "umbrella". Acme App does not allow editing it yet.' },
    { domain: 'stark.example', state: 'signin-differs', orgLabel: 'stark', expectedLabel: 'stark', enableable: true, detail: "The organization's sign-in parameters do not match RINGOTEL_SSO_SERVICE_ID." },
    { domain: 'wayne.example', state: 'package-differs', orgLabel: 'wayne', expectedLabel: 'wayne', enableable: true, detail: 'The organization is on a package other than the one RINGOTEL_DEFAULT_PACKAGE names.' },
    { domain: 'wonka.example', state: 'drift', orgLabel: 'wonka', expectedLabel: 'wonka', enableable: true, detail: 'The connection differs from the template in: app, proxy.', drift: ['app', 'proxy'] },
    { domain: 'hooli.example', state: 'not-in-index', orgLabel: 'hooli', expectedLabel: 'hooli', enableable: true, detail: 'The organization exists but the cached index has not seen it yet.' },
    { domain: 'demo.12345.service', state: 'enabled', orgLabel: 'demo', expectedLabel: 'demo', enableable: true, detail: 'The organization, its connection and the index all match.' },
    // NOT a mismatch: the label matches once it is trimmed and lowercased, which is the only reading
    // `labelMatches` has. Both copies normalise, and only a fixture like this one pins that they do —
    // exactly-equal and obviously-different pairs pass whether either copy normalises or not.
    { domain: 'initrode.example', state: 'enabled', orgLabel: ' INITRODE ', expectedLabel: 'initrode', enableable: true, detail: 'The organization, its connection and the index all match.' },
    // Not a state of its own: a domain whose name would be markup if it were not escaped.
    { domain: 'a<b&c".example', state: 'no-org', orgLabel: null, expectedLabel: 'a<b&c".example', enableable: false, detail: 'No organization matches this <b>domain</b> yet. This page is read-only for this domain.' },
  ],
});

/** A load that found nothing — the row whose colspan the two copies compute differently (a client
 *  constant, a server ternary), which a fixture with rows in it never touches. */
const FLEET_EMPTY = (): FleetReport => ({ ...FLEET(), rows: [], hidden: 0, template: null, templateProblem: 'Two connection templates are named "Standard Connection".' });

const ROWS_OK = (): ChecklistRow[] => [
  { step: 'rail', verdict: 'ok', title: 'Provisioning rail', detail: 'RINGOTEL_PROVISION_DOMAINS admits this domain.', fixable: false },
  { step: 'org', verdict: 'ok', title: 'Organization exists', detail: 'An Acme App organization matches this domain.', fixable: false },
  { step: 'label', verdict: 'ok', title: 'Organization label', detail: 'The organization label matches the domain: "acme".', fixable: false },
  { step: 'package', verdict: 'ok', title: 'Package', detail: 'The organization is on the "Essentials" package.', fixable: false },
  { step: 'signin', verdict: 'ok', title: 'Sign-in mode', detail: 'The organization is set for single sign-on.', fixable: false },
  { step: 'connector', verdict: 'ok', title: 'Connection matches the template', detail: 'The connection matches the connection template.', fixable: false },
  { step: 'index', verdict: 'ok', title: 'Organization index', detail: 'The cached organization index resolves this domain.', fixable: false },
  { step: 'reconcile', verdict: 'ok', title: 'Directory reconcile', detail: 'The directory reconcile has run for this domain.', fixable: false },
  { step: 'rails', verdict: 'ok', title: 'Sync and offboarding rails', detail: 'All three rails cover this domain.', fixable: false },
];

const PKGS = ['Essentials', 'Pro', 'Enterprise & Co "quoted"'];

/** The tenant's connection templates as the route hands them over — newest first, each carrying the ISO
 *  stamp the picker shows a date from, and one carrying none at all. The second name holds markup for the
 *  reason a package name does: it is a string somebody typed into a vendor panel, not a literal. */
const TPLS: DomainReport['templates'] = [
  { name: 'Standard Connection', createdAt: '2026-09-01T10:00:00.000Z', hasProvision: true, hasCountry: true },
  { name: 'Pilot & "Co"', createdAt: '2026-08-15T09:30:00.000Z', hasProvision: true, hasCountry: true },
  { name: 'Legacy', createdAt: null, hasProvision: true, hasCountry: true },
];
const DEF_TPL = 'Standard Connection';

/** (a) everything already true, an org present, SSO configured. */
const DOM_OK = (): DomainReport => ({
  domain: 'acme.example', rows: ROWS_OK(), label: { derived: 'acme', current: 'acme' },
  packages: PKGS, defaultPackage: 'Essentials', templates: TPLS, defaultTemplate: DEF_TPL,
  ssoConfigured: true, orgName: 'Acme & Sons',
  nsDescription: 'Acme Manufacturing <HQ>', appLabel: APP,
});

/** (b) no org yet, fixable, SSO configured — the create choices (label, name, package) are offered. */
const DOM_NEW = (): DomainReport => ({
  domain: 'globex.example',
  rows: [
    { step: 'rail', verdict: 'ok', title: 'Provisioning rail', detail: 'RINGOTEL_PROVISION_DOMAINS admits this domain.', fixable: false },
    { step: 'org', verdict: 'fix', title: 'Create the organization', detail: 'No Acme App organization matches this domain yet.', fixable: true },
    { step: 'label', verdict: 'info', title: 'Organization label', detail: 'The organization will be created as "globex".', fixable: false },
    { step: 'package', verdict: 'info', title: 'Package', detail: 'The organization will be created on the "Essentials" package.', fixable: false },
    { step: 'signin', verdict: 'info', title: 'Sign-in mode', detail: 'The organization will be created for single sign-on.', fixable: false },
    { step: 'connector', verdict: 'fix', title: 'Create the connection', detail: 'The organization must exist before its connection can be created.', fixable: false },
    { step: 'index', verdict: 'info', title: 'Organization index', detail: 'The index will resolve this domain once the organization exists.', fixable: false },
    { step: 'reconcile', verdict: 'info', title: 'Directory reconcile', detail: 'There is nothing to reconcile until the organization exists.', fixable: false },
    { step: 'rails', verdict: 'info', title: 'Sync and offboarding rails', detail: 'NS_EVENTS_DOMAINS does not cover this domain.', fixable: false },
  ],
  label: { derived: 'globex', current: null }, packages: PKGS, defaultPackage: 'Essentials',
  templates: TPLS, defaultTemplate: DEF_TPL,
  ssoConfigured: true, orgName: null, nsDescription: 'Globex Corporation', appLabel: APP,
});

/** (c) an org whose connection drifts, on a deployment that does no Ringotel SSO — so the sign-in
 *  picker is absent and the drift row carries a two-group diff, one group of it masked. */
const DOM_DRIFT = (): DomainReport => ({
  domain: 'initech.example',
  rows: [
    ...ROWS_OK().slice(0, 5).map((r) => ({ ...r })),
    { step: 'connector', verdict: 'info', title: 'Connection matches the template', detail: 'The connection differs from the template in: app, proxy.', fixable: false, diff: DRIFT },
    { step: 'index', verdict: 'fix', title: 'Refresh the org index', detail: 'The organization exists but the cached index has not seen it yet.', fixable: true },
    { step: 'reconcile', verdict: 'blocked', title: 'Directory reconcile', detail: 'Integration is off for this domain. Add it to RINGOTEL_PROVISION_DOMAINS to enable it.', fixable: false },
    { step: 'rails', verdict: 'info', title: 'Sync and offboarding rails', detail: 'RINGOTEL_WRITE_DOMAINS does not cover this domain.', fixable: false },
  ],
  label: { derived: 'initech', current: 'initech-legacy' }, packages: PKGS, defaultPackage: 'Essentials',
  templates: TPLS, defaultTemplate: DEF_TPL,
  ssoConfigured: false, orgName: 'Initech <Holdings>', nsDescription: null, appLabel: APP,
});

/** (d) no org AND no SSO — the one combination (a)–(c) leave out: create choices without a sign-in
 *  picker. Cheap, and it is the shape a deployment that does no Ringotel SSO enables a domain from. */
const DOM_NEW_NOSSO = (): DomainReport => ({ ...DOM_NEW(), domain: 'demo.12345.service', label: { derived: 'demo', current: null }, ssoConfigured: false });

/** (f) the configured default differs from the catalog only in case — the picker must still select it,
 *  because packageIdOf and byName both resolve it and a create would succeed. */
const DOM_PKG_CASE = (): DomainReport => ({ ...DOM_NEW(), domain: 'initrode.example', label: { derived: 'initrode', current: null }, defaultPackage: 'essentials' });

/** (g) the configured default is not in the catalog at all. Nothing may be preselected: the browser
 *  would otherwise hand rpChoice the first option and the create would land on an arbitrary package. */
const DOM_PKG_MISSING = (): DomainReport => ({ ...DOM_NEW(), domain: 'vandelay.example', label: { derived: 'vandelay', current: null }, defaultPackage: 'Legacy Bundle' });

/** (h) neither a description nor an organization name — both head lines are omitted, and the org-name
 *  input falls back to the derived domain name. */
const DOM_BARE = (): DomainReport => ({ ...DOM_NEW(), domain: 'wonka.example', label: { derived: 'wonka', current: null }, nsDescription: null, orgName: null });

/** (e) a report with no rows at all — the checklist's own colspan case. */
const DOM_EMPTY = (): DomainReport => ({ ...DOM_OK(), rows: [] });

/** (i) the configured standard is not among the tenant's templates. Nothing may be preselected: the
 *  browser would otherwise hand `rpChoice` the first option and the connection would be built from
 *  whichever template the tenant happened to list first — permanent, and invisible afterwards. */
const DOM_TPL_MISSING = (): DomainReport => ({ ...DOM_NEW(), domain: 'stark.example', label: { derived: 'stark', current: null }, defaultTemplate: 'Retired Connection' });

/** (j) one template in the whole tenant — the picker still offers it, and still preselects it. */
const DOM_TPL_ONE = (): DomainReport => ({ ...DOM_NEW(), domain: 'hooli.example', label: { derived: 'hooli', current: null }, templates: [TPLS[0]!] });

/** (l) a template carrying no PBX settings at all. It is LISTED — it exists in the vendor panel the
 *  operator is looking at — and disabled, saying why, because the create refuses it by the same
 *  predicate. Without this the option would be pickable and an `all` run would create the organization,
 *  set its sign-in mode, and only then refuse, leaving the domain half-enabled. */
const DOM_TPL_NOPROV = (): DomainReport => ({
  ...DOM_NEW(), domain: 'wayne.example', label: { derived: 'wayne', current: null },
  templates: [TPLS[0]!, { name: 'Sketch', createdAt: '2026-07-04T00:00:00.000Z', hasProvision: false, hasCountry: true }],
});

/** (m) a template that carries PBX settings and names no dialling country. Disabled for the OTHER
 *  reason, and the option has to say which — the two send an operator to different fields in the vendor
 *  panel. `country: ?? 'US'` used to swallow this and ship a connection quietly dialling as American. */
const DOM_TPL_NOCOUNTRY = (): DomainReport => ({
  ...DOM_NEW(), domain: 'cyberdyne.example', label: { derived: 'cyberdyne', current: null },
  templates: [TPLS[0]!, { name: 'Countryless', createdAt: '2026-07-04T00:00:00.000Z', hasProvision: true, hasCountry: false }],
});

/** (n) an organization an earlier run created and never connected. The label input is prefilled with ITS
 *  domain name rather than the derivation — the only label the route will accept here — and a line above
 *  the inputs says the record will be finished rather than duplicated. */
const DOM_ORPHAN = (): DomainReport => ({
  ...DOM_NEW(), domain: 'soylent.example', label: { derived: 'soylent', current: null },
  nsDescription: 'Soylent & "Co"', orphanLabel: 'soylent-pilot',
});

/** (k) the configured standard differs from the catalog only in case and whitespace — the picker must
 *  still select it, because `resolveTemplateChoice` resolves it and the create would succeed. */
const DOM_TPL_CASE = (): DomainReport => ({ ...DOM_NEW(), domain: 'umbrella.example', label: { derived: 'umbrella', current: null }, defaultTemplate: '  standard connection ' });

const FLEET_CASES: [string, FleetReport][] = [['full fleet', FLEET()], ['empty fleet', FLEET_EMPTY()], ['fallback app label', FLEET('Ringotel')]];
const DOMAIN_CASES: [string, DomainReport][] = [
  ['all ok', DOM_OK()], ['no org', DOM_NEW()], ['drift, no SSO', DOM_DRIFT()],
  ['no org, no SSO', DOM_NEW_NOSSO()], ['no rows', DOM_EMPTY()],
  ['default package differs by case', DOM_PKG_CASE()], ['default package not in catalog', DOM_PKG_MISSING()],
  ['no description, no org name', DOM_BARE()],
  ['configured template not in the tenant', DOM_TPL_MISSING()],
  ['one template only', DOM_TPL_ONE()],
  ['configured template differs by case', DOM_TPL_CASE()],
  ['a template with no connection settings', DOM_TPL_NOPROV()],
  ['a template with no country', DOM_TPL_NOCOUNTRY()],
  ['an orphaned organization to finish', DOM_ORPHAN()],
  // The fallback name, mirrored too: a deployment that never set RINGOTEL_LABEL says "Ringotel".
  ['fallback app label', { ...DOM_OK(), appLabel: 'Ringotel' }],
];

const DOC = (o: Partial<ProvisionDoc> = {}): ProvisionDoc =>
  ({ canWrite: true, version: '0.8.5', ssoConfigured: true, railSet: true, appLabel: APP, ...o });

// ── the two copies of the renderer, held byte-identical ────────────────────────────────────────────
// The rows are drawn server-side (so the markup can be asserted without a DOM) and client-side (from the
// bridge reply, which is what actually runs). Comparing tokens would catch a renamed state and miss
// everything else, so the client copy is EVALUATED here and its output compared byte for byte. One
// assertion per fixture, named — an assertion over a joined blob covers more subject with fewer ways to
// fail, and would not say which fixture diverged.
{
  for (const cw of [true, false]) {
    for (const [name, rep] of FLEET_CASES) {
      const out = runInNewContext(`${rowScript(cw)}\n[rpFleet(R), rpChecklist(D)]`, { R: rep, D: DOM_OK() }) as string[];
      ok(out[0] === renderFleetRows(rep, cw), `[mirror] the client fleet renderer matches the server one (${name}, canWrite=${cw})`);
    }
    for (const [name, rep] of DOMAIN_CASES) {
      const out = runInNewContext(`${rowScript(cw)}\n[rpFleet(R), rpChecklist(D)]`, { R: FLEET(), D: rep }) as string[];
      ok(out[1] === renderChecklist(rep, cw), `[mirror] the client checklist renderer matches the server one (${name}, canWrite=${cw})`);
    }
  }
}

// ── every fleet state is drawn, and drawn once ─────────────────────────────────────────────────────
{
  const expected: FleetStateId[] = ['multiple', 'no-org', 'label-mismatch', 'signin-differs', 'package-differs', 'drift', 'not-in-index', 'enabled'];
  ok(FLEET_STATES.length === expected.length, `[states] FLEET_STATES carries ${expected.length} states (${FLEET_STATES.length})`);
  for (const s of expected) ok(FLEET_STATES.includes(s), `[states] FLEET_STATES carries "${s}"`);
  const rows = renderFleetRows(FLEET(), true);
  for (const s of expected) ok(rows.includes(`data-state="${s}"`), `[states] the fleet fixture draws a "${s}" row`);
  // The label-mismatch shortcut filter keys off an attribute, not off the state: a mismatching domain
  // that is `multiple` never reaches the label-mismatch state, and the mismatch report
  // is exactly the place that must still list it.
  ok(rows.includes('data-domain="umbrella.example" data-mismatch="1"'), '[states] a mismatching row is marked data-mismatch="1"');
  ok(rows.includes('data-domain="demo.12345.service" data-mismatch="0"'), '[states] a matching row is marked data-mismatch="0"');
  // Normalisation, pinned on BOTH copies: whitespace and case are not a mismatch, because they are not
  // one to `labelMatches`, and a row that called them one would put the domain in the mismatch report.
  for (const [what, html] of [
    ['server', rows],
    ['client', runInNewContext(`${rowScript(true)}\nrpFleet(R)`, { R: FLEET() }) as string],
  ] as const) {
    ok(html.includes('data-domain="initrode.example" data-mismatch="0"'), `[states] " INITRODE " matches "initrode" — not a mismatch (${what})`);
    ok(html.includes('<td> INITRODE </td>'), `[states] and its cell carries the label alone, with no "derives" line (${what})`);
  }
}

// ── the words on a chip are for a person, and are pinned ───────────────────────────────────────────
// The id and the label move independently — that is the point of the map — so the label is asserted
// here rather than derived from the id, and a rewording is a deliberate edit to this list. One per
// state, so a failure names which chip changed.
{
  const LABELS: [FleetStateId, string][] = [
    ['multiple', 'Multiple organizations'], ['no-org', 'Not set up'],
    ['label-mismatch', 'Domain names differ'], ['signin-differs', 'SSO mismatch'], ['package-differs', 'Different licensing'],
    ['drift', 'Differs from template'], ['not-in-index', 'Not yet indexed'], ['enabled', 'Enabled'],
  ];
  const rows = renderFleetRows(FLEET(), true);
  const client = runInNewContext(`${rowScript(true)}\nrpFleet(R)`, { R: FLEET() }) as string;
  const page = ringotelProvisionHtml(DOC());
  for (const [id, label] of LABELS) {
    ok(rows.includes(`<span class="chip chip-${id}">${label}</span>`), `[words] the "${id}" chip reads "${label}"`);
    ok(client.includes(`<span class="chip chip-${id}">${label}</span>`), `[words] and the client copy agrees ("${id}")`);
    ok(page.includes(`data-filter="${id}" aria-pressed="false">${label}</button>`), `[words] and its filter button too ("${id}")`);
  }
  // Sentence case is the point of the relabel, so the stylesheet must not shout it back in capitals.
  const style = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
  const chipRule = style.slice(style.indexOf('.chip {'), style.indexOf('}', style.indexOf('.chip {')));
  ok(!chipRule.includes('text-transform'), '[words] and .chip forces no uppercase');
}

// ── the words on a checklist row, and on the headings ──────────────────────────────────────────────
// The verdict ids are the data ('ok' | 'fix' | 'info' | 'blocked'); these are the words beside them,
// pinned per verdict on both copies so a rewording is a deliberate edit rather than a surprise.
{
  const VERDICTS: [ChecklistRow['verdict'], string][] = [
    ['ok', 'OK'], ['fix', 'Fix needed'], ['info', 'Note'], ['blocked', 'Blocked'],
  ];
  const server = renderChecklist(DOM_DRIFT(), true) + renderChecklist(DOM_NEW(), true);
  const client = (runInNewContext(`${rowScript(true)}\n[rpChecklist(D), rpChecklist(E)]`, { D: DOM_DRIFT(), E: DOM_NEW() }) as string[]).join('');
  for (const [id, label] of VERDICTS) {
    ok(server.includes(`<span class="v v-${id}">${label}</span>`), `[words] the "${id}" verdict reads "${label}"`);
    ok(client.includes(`<span class="v v-${id}">${label}</span>`), `[words] and the client copy agrees ("${id}")`);
  }
  const page = ringotelProvisionHtml(DOC());
  // Column headings a phone-system admin can read: the two domains are named for the systems they
  // belong to, and "Verdict"/"Step" were our words for "Status"/"Check".
  for (const th of ['<th>NetSapiens domain</th>', `<th>${APP} domain</th>`, '<th>Status</th>', '<th>Check</th>']) {
    ok(page.includes(th), `[words] the table heading ${th}`);
  }
  ok(!page.includes('<th>Verdict</th>') && !page.includes('<th>Ringotel label</th>'), '[words] and neither old heading survives');
  // An outcome line names the step in words; the ids stay on the wire.
  const wj = scriptOf(ringotelProvisionHtml(DOC({ canWrite: true })));
  for (const [id, words] of [['connector', 'the connection'], ['reconcile', 'the directory sync'], ['index', 'the organization list']] as const) {
    ok(wj.includes(`"${id}":"${words}"`), `[words] the "${id}" step reads "${words}" in an outcome line`);
  }
  // …while the id itself is what the button carries and what ask('enable') sends. The words are for the
  // reader; nothing downstream ever sees them.
  ok(renderChecklist(DOM_NEW(), true).includes('data-step="org"'), '[words] and the raw step id still rides the Fix button');
  ok(wj.includes('step:step'), '[words] and is what the enable request carries');
}

// ── the operator's own name for the app, everywhere ────────────────────────────────────────────────
// A white-label deployment must not see the vendor's name in its own portal. The label rides on every
// document rather than being baked in once, so the MIRRORED renderers read it off the report they are
// handed — a client copy holding a build-time literal would say one deployment's name over another
// deployment's data. Swept rather than pinned sentence by sentence: the failure mode is one string
// nobody remembered to parameterise.
{
  const lab = (h: string): string => h
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')   // a code comment is not a rendered string
    .replace(/RINGOTEL_[A-Z_]+/g, '')          // setting names are verbatim by rule
    .replace(/<code>[\s\S]*?<\/code>/g, '')    // and so is anything shown as code (feature keys, settings)
    .replace(/ringotel\.provision\.[a-z]+/g, '');
  for (const [what, html] of [
    ['page', ringotelProvisionHtml(DOC())],
    ['read-only page', ringotelProvisionHtml(DOC({ canWrite: false }))],
    ['server fleet rows', renderFleetRows(FLEET(), true)],
    ['client fleet rows', runInNewContext(`${rowScript(true)}\nrpFleet(R)`, { R: FLEET() }) as string],
    ['server checklist', renderChecklist(DOM_NEW(), true) + renderChecklist(DOM_OK(), true) + renderChecklist(DOM_DRIFT(), false)],
    ['client checklist', (runInNewContext(`${rowScript(true)}\n[rpChecklist(A), rpChecklist(B)]`, { A: DOM_NEW(), B: DOM_OK() }) as string[]).join('')],
  ] as const) {
    ok(!/Ringotel/.test(lab(html)), `[label] nothing says the vendor's name when the label is "${APP}" (${what})`);
  }
  ok(ringotelProvisionHtml(DOC()).includes(`<title>${APP} Integration</title>`), '[label] the page is titled with it');
  ok(renderChecklist(DOM_NEW(), true).includes(`${APP} credentials`), '[label] the sign-in option carries it');
  ok(renderChecklist(DOM_NEW(), true).includes(`The ${APP} domain name.`), '[label] and the create notes');
  // The fallback, for a deployment that never set RINGOTEL_LABEL.
  ok(renderChecklist({ ...DOM_NEW(), appLabel: 'Ringotel' }, true).includes('Ringotel credentials'), '[label] and an unset label falls back to "Ringotel"');
}

// ── the rail is not a state ────────────────────────────────────────────────────────────────────────
// A domain this page may not change can be perfectly well set up. The audit state says what is true of
// the integration; the lock says what is true of THIS PAGE, and the reason is already the last sentence
// of the row's own detail, so the chip carries no second copy of it.
{
  for (const [what, html] of [
    ['server', renderFleetRows(FLEET(), true)],
    ['client', runInNewContext(`${rowScript(true)}\nrpFleet(R)`, { R: FLEET() }) as string],
  ] as const) {
    ok(html.includes('data-enableable="0"') && html.includes('data-enableable="1"'), `[lock] each row says whether this page may change it (${what})`);
    // Icon-only so the pair fits one line — but the WORDS still have to exist for anyone not reading
    // pixels, which is the half of this change a screenshot would never catch.
    ok(html.includes('\u{1F512}'), `[lock] a locked row wears the padlock (${what})`);
    ok(html.includes('role="img" aria-label="Read-only"'), `[lock] with an accessible name that still says it (${what})`);
    ok(html.includes('title="This page is read-only for this domain."'), `[lock] and a hover that does too (${what})`);
    ok((html.match(/chip lock/g) ?? []).length === 2, `[lock] exactly the two locked fixtures wear it (${what})`);
    // The lock leads the state chip (not trails it), so scanning the column for who is locked reads
    // left to right and unlocked rows' state chips aren't pushed rightward by a trailing icon.
    ok(html.includes('<span class="chip lock" role="img" aria-label="Read-only" title="This page is read-only for this domain.">\u{1F512}</span> <span class="chip chip-enabled locked">'),
      `[lock] the padlock renders BEFORE the state chip (${what})`);
    // The state keeps its OWN colour and is only darkened, so the palette still means one thing.
    ok(html.includes('<span class="chip chip-enabled locked">'), `[lock] a locked row's state chip is the same state, darkened (${what})`);
    ok(html.includes('<span class="chip chip-enabled">'), `[lock] while an unlocked row of the same state is not (${what})`);
    ok(!/chip-[a-z-]+ locked[^>]*>[^<]*Read-only/.test(html), `[lock] and the darkening never replaces the state's words (${what})`);
    // The lock is BESIDE the state, not instead of it — the read-only fixture is a fully set-up domain.
    ok(/data-state="enabled"[^>]*data-enableable="0"/.test(html), `[lock] and an enabled domain can still be read-only (${what})`);
  }
  ok(!FLEET_STATES.includes('outside-rail' as never), '[lock] "outside-rail" is no longer a state');
  const page = ringotelProvisionHtml(DOC());
  // The FILTER keeps its words — it is a control, not a marker beside one.
  ok(page.includes('data-only="readonly"') && page.includes('>Read-only</button>'), '[lock] and the shortcut filter gathers them whatever state they are in');
  ok(/\.chip\.locked \{[^}]*filter:brightness/.test(page), '[lock] the stylesheet darkens rather than recolours');
  ok(!page.includes('data-filter="outside-rail"'), '[lock] with no state filter left for it');
}

// ── the panel head: what the customer is called, in each system ────────────────────────────────────
{
  for (const [what, render] of [
    ['server', (d: DomainReport) => renderChecklist(d, true)],
    ['client', (d: DomainReport) => runInNewContext(`${rowScript(true)}\nrpChecklist(D)`, { D: d }) as string],
  ] as const) {
    const ok1 = render(DOM_OK());
    ok(ok1.includes('NetSapiens: Acme Manufacturing &lt;HQ&gt;'), `[head] the NetSapiens description, escaped (${what})`);
    ok(ok1.includes(`${APP} organization: Acme &amp; Sons`), `[head] and the organization name beside it (${what})`);
    const drift = render(DOM_DRIFT());
    ok(!drift.includes('NetSapiens:'), `[head] a domain with no description gets no line for one (${what})`);
    ok(drift.includes(`${APP} organization: Initech &lt;Holdings&gt;`), `[head] while its organization name still shows (${what})`);
    const bare = render(DOM_BARE());
    ok(!bare.includes('NetSapiens:') && !bare.includes('organization:'), `[head] neither value ⇒ neither line (${what})`);
    ok(bare.includes('No organization matches this domain yet.'), `[head] and a create still says so (${what})`);
  }
  // The NS description is the sensible default for a new organization's name — it is what the customer
  // is called in the system of record.
  ok(renderChecklist(DOM_NEW(), true).includes('id="rp-orgname" class="txt" type="text" maxlength="64" value="Globex Corporation"'),
    '[head] a create prefills the organization name from the NetSapiens description');
  ok(renderChecklist(DOM_BARE(), true).includes('value="wonka"'), '[head] and falls back to the derived domain name when there is none');
}

// ── closing the panel puts the reader back where they were ─────────────────────────────────────────
// Structural, against the generated script: the behaviour needs a DOM, but what must not regress is that
// the row is found by its own attribute (the table is re-rendered after an enable, so the clicked
// element may be gone) and that there is a fallback when it is.
{
  const script = scriptOf(ringotelProvisionHtml(DOC()));
  ok(script.includes("rows[i].getAttribute('data-domain')===d"), '[back] the row is found by walking and comparing, never by a selector built from a domain');
  ok(script.includes("row.scrollIntoView({block:'center'})"), '[back] and scrolled back into the middle of the screen');
  ok(script.includes("row.classList.add('just')") && script.includes("row.classList.remove('just')"), '[back] and marked for a moment');
  ok(script.includes('window.scrollTo(0,0)'), '[back] with a fallback for a row that is no longer there');
  ok(script.includes("elPanel.scrollIntoView({block:'start'})"), '[back] and opening one scrolls the panel into view');
  const style = ringotelProvisionHtml(DOC());
  ok(/tr\.just td \{/.test(style), '[back] the stylesheet defines the mark');
}

// ── the second line of the domain cell answers the question the row actually poses ─────────────────
{
  for (const [what, html] of [
    ['server', renderFleetRows(FLEET(), true)],
    ['client', runInNewContext(`${rowScript(true)}\nrpFleet(R)`, { R: FLEET() }) as string],
  ] as const) {
    ok(html.includes('none yet</span><div class="dim">will be <code>acme</code>'), `[cell] no organization ⇒ what will be created (${what})`);
    ok(html.includes('<b>umbrella-old</b><div class="dim">expected <code>umbrella</code>'), `[cell] a differing one ⇒ what was expected (${what})`);
    ok(html.includes('<td>hooli</td>'), `[cell] a matching one ⇒ no second line at all (${what})`);
    ok(!/derives/.test(html), `[cell] and nothing "derives" anything (${what})`);
  }
}

// ── the write surface is decided ONLY by canWrite ──────────────────────────────────────────────────
// The controls are ABSENT, not disabled: a disabled control still names an action the reader cannot
// take, and still ships the code behind it to someone the route would refuse.
{
  for (const [name, rep] of DOMAIN_CASES) {
    const ro = renderChecklist(rep, false);
    ok(!ro.includes('<button'), `[ro] the read-only checklist has no <button (${name})`);
    ok(!ro.includes('<select'), `[ro] the read-only checklist has no <select (${name})`);
    ok(!ro.includes('<input'), `[ro] the read-only checklist has no <input (${name})`);
    ok(!ro.includes('Enable all'), `[ro] and does not name Enable all (${name})`);
  }
  for (const [name, rep] of FLEET_CASES) {
    for (const cw of [true, false]) {
      const f = renderFleetRows(rep, cw);
      ok(!f.includes('<button') && !f.includes('<select') && !f.includes('<input'),
        `[ro] the fleet rows carry no control at all — the drilldown owns every action (${name}, canWrite=${cw})`);
    }
  }
  const w = renderChecklist(DOM_NEW(), true);
  ok(w.includes('Enable all'), '[write] the write build offers Enable all');
  ok(w.includes('data-act="all"'), '[write] and it runs step "all"');
  ok(w.includes('data-act="fix"') && w.includes('data-step="org"'), '[write] a fixable row gets a Fix button naming its step');
  ok((w.match(/data-act="fix"/g) ?? []).length === 1, '[write] and only the fixable row does (1 of 9)');
  // Package is set on create and never rewritten, so it is offered only where a create is possible.
  ok(w.includes('id="rp-pkg"'), '[write] a domain with no org gets the package picker');
  ok(!renderChecklist(DOM_OK(), true).includes('id="rp-pkg"'), '[write] a live organization does not — its package is set on create only');
  ok(!renderChecklist(DOM_OK(), true).includes('id="rp-label"'), '[write] nor the label input — Ringotel does not allow editing a label');
  ok(w.includes('id="rp-label"') && w.includes('value="globex"'), '[write] the label input is prefilled with the derivation');
  ok(w.includes('id="rp-orgname"'), '[write] and the organization-name input is offered on create');
  ok(w.includes(`<option value="Essentials" selected>`), '[write] the configured default package is preselected');
  // A default that resolves only after normalisation still resolves — packageIdOf and byName both trim
  // and lowercase, so a picker that needed exact bytes would refuse a create the apply layer accepts.
  const byCase = renderChecklist(DOM_PKG_CASE(), true);
  ok(byCase.includes(`<option value="Essentials" selected>`), '[write] a default differing only in case selects the same option');
  ok(!byCase.includes('<option value="" selected disabled>'), '[write] and needs no placeholder');
  // Nothing in the catalog answers to the default: the browser would select the FIRST option and
  // rpChoice would send it, creating the organization on an arbitrary package — permanent on a shared
  // tenant. An unselectable empty option leaves select.value empty, so pkg is omitted and the apply
  // layer refuses by name.
  const missing = renderChecklist(DOM_PKG_MISSING(), true);
  ok(missing.includes('<option value="" selected disabled>Choose a licensing package</option>'), '[write] an unresolvable default preselects an empty, unchoosable option');
  for (const pkg of PKGS) {
    ok(!missing.includes(`<option value="${esc(pkg)}" selected>`), `[write] and preselects no real package (${pkg})`);
  }
  ok(w.includes('id="rp-signin"'), '[write] SSO configured ⇒ the sign-in picker');
  ok(!renderChecklist(DOM_DRIFT(), true).includes('id="rp-signin"'), '[write] no SSO configured ⇒ no sign-in picker');
  ok(!renderChecklist(DOM_NEW_NOSSO(), true).includes('id="rp-signin"'), '[write] including on a create');
}

// ── the template a connection is created FROM ──────────────────────────────────────────────────────
// Ringotel keeps no record of which template a connection came from, so this choice is made once and is
// never visible again — which is why the picker preselects the configured standard and why "nothing
// matches" must not fall through to whichever template the tenant listed first. Same discipline as the
// package select, and the same reason: a create on a shared tenant is permanent.
{
  const w = renderChecklist(DOM_NEW(), true);
  ok(w.includes('id="rp-template"'), '[tpl] a domain with no connection gets the template picker');
  ok(!renderChecklist(DOM_OK(), true).includes('id="rp-template"'),
    '[tpl] a domain whose connection exists does not — a connection is built once and this page never rewrites one');
  // "<name> · <date>": the date is the ISO stamp's own day, sliced rather than formatted, so the two
  // copies cannot disagree and no reader's locale can change what the option says.
  ok(w.includes('<option value="Standard Connection" selected>Standard Connection · 2026-09-01</option>'),
    '[tpl] each option reads "<name> · <date>", and the configured standard is preselected');
  ok(w.includes('>Pilot &amp; &quot;Co&quot; · 2026-08-15</option>'), '[tpl] a template name carrying markup is escaped in its option');
  ok(w.includes('<option value="Pilot &amp; &quot;Co&quot;">'), '[tpl] in the value too');
  ok(w.includes('<option value="Legacy">Legacy</option>'), '[tpl] and a template with no stamp is offered by name alone, with no dangling separator');
  ok(!w.includes('<option value="" selected disabled>'), '[tpl] a resolvable standard needs no placeholder');
  // Order is the ROUTE's (newest first); the picker draws what it is handed rather than re-sorting it.
  const at = (n: string): number => w.indexOf(`<option value="${esc(n)}"`);
  ok(at('Standard Connection') < at('Pilot & "Co"') && at('Pilot & "Co"') < at('Legacy'),
    '[tpl] the options keep the order the report listed them in');

  const byCase = renderChecklist(DOM_TPL_CASE(), true);
  ok(byCase.includes('<option value="Standard Connection" selected>'), '[tpl] a standard differing only in case and whitespace selects the same option');
  ok(!byCase.includes('<option value="" selected disabled>'), '[tpl] and needs no placeholder either');

  const missing = renderChecklist(DOM_TPL_MISSING(), true);
  ok(missing.includes('<option value="" selected disabled>Choose a connection template</option>'),
    '[tpl] a standard the tenant does not offer preselects an empty, unchoosable option');
  for (const t of TPLS) ok(!missing.includes(`<option value="${esc(t.name)}" selected>`), `[tpl] and preselects no real template (${t.name})`);

  // A template with no PBX settings: offered, disabled, and saying which it is. The create refuses the
  // same one, and the route refuses it before the first write, so the picker and the write agree.
  const noprov = renderChecklist(DOM_TPL_NOPROV(), true);
  ok(noprov.includes('<option value="Sketch" disabled>Sketch · 2026-07-04 · no connection settings</option>'),
    '[tpl] a template with no connection settings is listed, disabled, and says why');
  ok(noprov.includes('<option value="Standard Connection" selected>'), '[tpl] while the usable standard is still preselected beside it');

  const one = renderChecklist(DOM_TPL_ONE(), true);
  /** Just the template `<select>` — the checklist also draws the package and sign-in pickers. */
  const tplSelect = (html: string): string => {
    const at = html.indexOf('id="rp-template"');
    return at < 0 ? '' : html.slice(at, html.indexOf('</select>', at));
  };
  ok((tplSelect(one).match(/<option/g) ?? []).length === 1, `[tpl] one template ⇒ exactly one option (${(tplSelect(one).match(/<option/g) ?? []).length})`);
  ok(one.includes('<option value="Standard Connection" selected>Standard Connection · 2026-09-01</option>'), '[tpl] and it is still preselected');
  ok(!one.includes('Choose a connection template'), '[tpl] with no placeholder');

  // The choice only reaches the route when the operator really has one: an empty select.value is
  // omitted, so the apply layer falls back to the configured standard rather than being handed ''.
  const script = scriptOf(ringotelProvisionHtml(DOC({ canWrite: true })));
  ok(script.includes("e=document.getElementById('rp-template');if(e&&e.value)c.template=e.value"),
    '[tpl] rpChoice sends the template only when one is selected');
  ok(!scriptOf(ringotelProvisionHtml(DOC({ canWrite: false }))).includes('rp-template'),
    '[tpl] and the read-only build carries no template control at all');
}

// ── escaping, on both copies ───────────────────────────────────────────────────────────────────────
{
  const cases: [string, string][] = [
    ['server fleet', renderFleetRows(FLEET(), true)],
    ['client fleet', runInNewContext(`${rowScript(true)}\nrpFleet(R)`, { R: FLEET() }) as string],
  ];
  for (const [what, html] of cases) {
    ok(html.includes('a&lt;b&amp;c&quot;.example'), `[esc] a domain carrying markup is escaped (${what})`);
    ok(!html.includes('a<b&c".example'), `[esc] and the raw form appears nowhere (${what})`);
    ok(html.includes('&lt;b&gt;domain&lt;/b&gt;'), `[esc] a detail string is escaped too (${what})`);
  }
  const ck = renderChecklist(DOM_DRIFT(), true);
  ok(ck.includes('Initech &lt;Holdings&gt;'), '[esc] the organization name is escaped in the checklist head');
  const pick = renderChecklist(DOM_NEW(), true);
  ok(pick.includes('Enterprise &amp; Co &quot;quoted&quot;'), '[esc] a package name is escaped inside its <option>');
}

// ── a masked diff value is rendered as the mask and nothing else ───────────────────────────────────
{
  for (const [what, html] of [
    ['server', renderChecklist(DOM_DRIFT(), true)],
    ['client', runInNewContext(`${rowScript(true)}\nrpChecklist(D)`, { D: DOM_DRIFT() }) as string],
  ] as const) {
    ok(html.includes('••••'), `[mask] the masked field renders as the mask (${what})`);
    ok(!html.includes(T_SECRET), `[mask] the template's secret appears nowhere (${what})`);
    ok(!html.includes(B_SECRET), `[mask] nor the connection's (${what})`);
    ok(html.includes('<details'), `[mask] the drift row expands its sections (${what})`);
    ok(html.includes('>app<') && html.includes('>proxy<'), `[mask] one <details> per section (${what})`);
  }
  ok(!renderChecklist(DOM_OK(), true).includes('<details'), '[mask] a row with no diff expands nothing');
}

// ── the page document ──────────────────────────────────────────────────────────────────────────────
{
  const ro = ringotelProvisionHtml(DOC({ canWrite: false }));
  const rw = ringotelProvisionHtml(DOC({ canWrite: true }));
  ok(ro.includes('ringotel.provision.write'), '[page] the read-only page names the key that would grant the write surface');
  ok(ro.includes('This page is read-only for you.'), '[page] with the read-only sentence');
  ok(!rw.includes('ringotel.provision.write'), '[page] a writer is not told about a key they hold');
  for (const marker of ['Enable all', 'data-act="fix"', 'data-act="all"', 'id="rp-pkg"', 'id="rp-signin"', 'id="rp-label"']) {
    ok(!ro.includes(marker), `[page] and no write control reaches the read-only page (${marker})`);
  }
  // The rail note is about the DEPLOYMENT, not about the reader: a view-only operator reading an audit
  // that can never be acted on needs the same sentence a writer does.
  const railOff = ['No domain can be enabled from here until <code>RINGOTEL_PROVISION_DOMAINS</code> is set. The audit below still runs.'];
  for (const cw of [true, false]) {
    ok(ringotelProvisionHtml(DOC({ canWrite: cw, railSet: false })).includes(railOff[0]!), `[page] the rail-unset note shows in both modes (canWrite=${cw})`);
    ok(!ringotelProvisionHtml(DOC({ canWrite: cw, railSet: true })).includes(railOff[0]!), `[page] and is absent when the rail is set (canWrite=${cw})`);
  }
  // Pinned whole, both forms: the brief names this sentence, and a substring assertion would pass on a
  // page that had lost half of it.
  ok(ro.includes("1 domain hidden by this deployment's allow/block lists"), '[page] the hidden-count line, singular');
  ok(ro.includes(" domains hidden by this deployment's allow/block lists"), '[page] and plural');
  // Every state gets a filter button, plus All and the mismatch shortcut.
  for (const s of FLEET_STATES) ok(rw.includes(`data-filter="${s}"`), `[page] a filter button for "${s}"`);
  ok(rw.includes('data-filter="all"'), '[page] and an All button');
  // Named apart from the state chip on purpose: it is broader, not the same filter twice — a domain
  // whose names differ can land in `multiple` and never reach the label-mismatch state.
  ok(rw.includes('data-only="mismatch"') && rw.includes('Domain names differ (any state)'), '[page] and the shortcut for that finding in any state');
  const shortcutText = rw.match(/data-only="mismatch"[^>]*>([^<]*)</)?.[1] ?? '';
  const stateText = rw.match(/data-filter="label-mismatch"[^>]*>([^<]*)</)?.[1] ?? '';
  ok(shortcutText !== '' && stateText !== '' && shortcutText !== stateText,
    `[page] and the two buttons do not share one label ("${shortcutText}" vs "${stateText}")`);
  ok(rw.includes('id="rp-refresh"'), '[page] and a Refresh button');
}

// ── nothing the script hides can be left visible by its own stylesheet ─────────────────────────────
// A class setting `display` beats the UA's `[hidden]{display:none}`. Set `.hidden` on such an element
// and the attribute lands while the element stays on screen — which is how the busy overlay sat over a
// fully rendered table reading "Loading…". The rule is mechanical, so the test is a sweep rather than
// one assertion per element I happened to think of: derive BOTH sets from the generated document — the
// elements the script toggles, and the selectors the stylesheet gives a `display` — and require a
// `<selector>[hidden]{display:none}` rule wherever they meet.
{
  const html = ringotelProvisionHtml(DOC({ canWrite: true }));
  const script = scriptOf(html);
  // Comments stripped FIRST: one of them talks about `[hidden]{display:none}`, and a rule parser that
  // reads prose as CSS finds a rule whose selector is half a sentence — which is how this sweep first
  // reported a missing rule that was three lines above it.
  const style = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'))
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Flat rules only: the regex cannot span a nested brace, so an @media / @keyframes wrapper is skipped
  // and the rules INSIDE it are still read — which is what matters, since that is where a display can hide.
  const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sels: m[1]!.split(',').map((x) => x.trim()).filter(Boolean), decls: m[2]! }));

  const byVar = new Map<string, string>();
  for (const m of script.matchAll(/(\w+)\s*=\s*document\.getElementById\('([^']+)'\)/g)) byVar.set(m[1]!, m[2]!);
  const toggled = new Set<string>();
  for (const m of script.matchAll(/(\w+)\.hidden\s*=/g)) { const id = byVar.get(m[1]!); if (id) toggled.add(id); }

  /** Every selector that could match this element: its id, and each class it is rendered with. */
  const selectorsFor = (id: string): string[] => {
    const tag = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';
    const cls = (tag.match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean);
    return [`#${id}`, ...cls.map((c) => `.${c}`)];
  };
  const setsDisplay = (sel: string): boolean =>
    rules.some((r) => r.sels.includes(sel) && /(^|[;{\s])display\s*:/.test(r.decls));
  const guarded = (sel: string): boolean =>
    rules.some((r) => r.sels.includes(`${sel}[hidden]`) && /display\s*:\s*none/.test(r.decls));

  // A sweep that swept nothing would pass forever, so both halves are asserted before the rule is.
  ok(toggled.size >= 3, `[hidden] the sweep found the elements the script toggles (${[...toggled].sort().join(', ')})`);
  let checked = 0;
  for (const id of [...toggled].sort()) {
    for (const sel of selectorsFor(id)) {
      if (!setsDisplay(sel)) continue;
      checked++;
      ok(guarded(sel), `[hidden] ${sel} sets display and #${id} is toggled with .hidden, so ${sel}[hidden]{display:none} must exist`);
    }
  }
  ok(checked > 0, `[hidden] and at least one of them is matched by a display-setting selector (${checked})`);
}

// ── an enable that stopped carries its reason, report or no report ─────────────────────────────────
// Asserted on the SOURCE of deliver() rather than by running it: the page script needs a DOM, and the
// fact under test is an ordering — the reason is rendered before the report is looked for, so a reply
// carrying `stoppedAt` and no checklist still shows the operator what refused it.
{
  const script = scriptOf(ringotelProvisionHtml(DOC({ canWrite: true })));
  const body = script.slice(script.indexOf('function deliver(op,v)'));
  const outcomesAt = body.indexOf('rpOutcomes(v)');
  const repAt = body.indexOf('var rep=v.checklist||v.report');
  ok(outcomesAt > -1 && repAt > -1 && outcomesAt < repAt, '[enable] the outcomes render before the report is looked for');
  ok(body.includes("else if(op!=='enable')failDomain("), '[enable] and a reportless enable is not overwritten with "answered with no checklist"');
  ok(body.includes("wrote=op==='enable'&&!!(v.outcomes&&v.outcomes.length)"), '[enable] the fleet is re-read only when a step actually ran');
}

// ── data-prefilter ─────────────────────────────────────────────────────────────────────────────────
// Route-validated (the worker checks it against the caller's own visible domains) and attribute-escaped
// here — a domain is never chosen by the reader, so neither half may assume it is safe markup.
{
  ok(!ringotelProvisionHtml(DOC()).includes('data-prefilter='), '[pre] no prefilter ⇒ no attribute at all');
  ok(ringotelProvisionHtml(DOC({ prefilter: 'acme.example' })).includes('data-prefilter="acme.example"'), '[pre] a prefilter rides on the body');
  const nasty = ringotelProvisionHtml(DOC({ prefilter: 'a<b"c.example' }));
  ok(nasty.includes('data-prefilter="a&lt;b&quot;c.example"'), '[pre] escaped into the attribute');
  ok(!nasty.includes('data-prefilter="a<b"'), '[pre] and never raw');
}

// ── an unfinished organization: what the create form says and what it offers ───────────────────────
// `orphanLabel` is the domain name of a record an earlier run created and never connected. Prefilling the
// derivation there would offer the one label the route refuses, so the input carries the orphan's and a
// line above it says what pressing Enable will do.
{
  for (const [what, render] of [
    ['server', (d: DomainReport) => renderChecklist(d, true)],
    ['client', (d: DomainReport) => runInNewContext(`${rowScript(true)}\nrpChecklist(D)`, { D: d }) as string],
  ] as const) {
    const html = render(DOM_ORPHAN());
    ok(html.includes('value="soylent-pilot"'), `[orphan] the label input is prefilled with the existing organization's domain name (${what})`);
    ok(!html.includes('value="soylent"'), `[orphan] never with the derivation, which the route would refuse (${what})`);
    ok(html.includes('class="orphnote"'), `[orphan] with a note above the inputs (${what})`);
    ok(html.includes('so Enable finishes that organization instead of creating a second one'), `[orphan] saying what pressing Enable will do with it (${what})`);
    ok(html.includes('The label below is set to soylent-pilot'), `[orphan] and tying the sentence to the input it just changed (${what})`);
    ok(html.includes('Soylent &amp; &quot;Co&quot;'), `[orphan] and naming it, escaped — it is a string somebody typed into a vendor panel (${what})`);
    // No orphan ⇒ nothing changes: the derivation, and no note at all.
    const plain = render(DOM_NEW());
    ok(plain.includes('value="globex"') && !plain.includes('orphnote'), `[orphan] a domain with no unfinished record is untouched (${what})`);
  }
}
// ── a template that cannot be built from says WHICH reason ─────────────────────────────────────────
// Two failures, one disabled state: no PBX settings, and no dialling country. They send an operator to
// different fields in the vendor panel, so an option labelled with the wrong one is worse than a blank.
{
  for (const [what, render] of [
    ['server', (d: DomainReport) => renderChecklist(d, true)],
    ['client', (d: DomainReport) => runInNewContext(`${rowScript(true)}\nrpChecklist(D)`, { D: d }) as string],
  ] as const) {
    const html = render(DOM_TPL_NOCOUNTRY());
    ok(/<option value="Countryless"[^>]*disabled>/.test(html), `[template] a template naming no country is offered disabled (${what})`);
    ok(html.includes('· no country'), `[template] saying which field is missing (${what})`);
    ok(!html.includes('· no connection settings'), `[template] and not the other reason, which is not true of it (${what})`);
    const noprov = render(DOM_TPL_NOPROV());
    ok(noprov.includes('· no connection settings') && !noprov.includes('· no country'), `[template] while a template with no PBX settings says only that (${what})`);
  }
}
// ── the bridge, the REQUEST direction ──────────────────────────────────────────────────────────────
// The block above walks the reply. This one walks the ask: every key the page puts in an `ask()` payload
// has to be a key the kit's provision handler reads off `pq`, and every `pq.<key>` the handler reads has
// to be one the page sends. A key added on one side and not the other is silently dropped — the request
// still goes, still answers, and quietly ignores whatever the new field was for.
{
  const script = scriptOf(ringotelProvisionHtml(DOC({ canWrite: true })));
  const bundle = buildSpkBundle(['ringotel.provision.view'], { PORTAL_HANDOFF_URL: '' } as any);

  // The envelope `ask()` builds itself (`var q={op:op}`), plus every payload literal handed to it.
  const envelope = [...script.matchAll(/var q=\{([^}]*)\}/g)].flatMap((m) => m[1]!.split(',').map((kv) => kv.split(':')[0]!.trim()));
  const payloads = [...script.matchAll(/ask\('(?:enable|domain|fleet)',\{([^}]*)\}\)/g)]
    .flatMap((m) => m[1]!.split(',').map((kv) => kv.split(':')[0]!.trim()));
  const keysSent = new Set([...envelope, ...payloads].filter(Boolean));
  const keysRead = new Set([...bundle.matchAll(/\bpq\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!));

  ok(keysSent.size >= 4 && keysRead.size >= 4, `[bridge] both sides were really extracted (sent ${[...keysSent].sort().join(',')} | read ${[...keysRead].sort().join(',')})`);
  const sentUnread = [...keysSent].filter((k) => !keysRead.has(k));
  ok(sentUnread.length === 0, `[bridge] every key the page asks with is read by the kit's handler (sent-but-unread: ${sentUnread.join(',') || 'none'})`);
  const readUnsent = [...keysRead].filter((k) => !keysSent.has(k));
  ok(readUnsent.length === 0, `[bridge] and every pq.<key> the handler reads is one the page sends (read-but-unsent: ${readUnsent.join(',') || 'none'})`);
}
// ── the page script is JavaScript, and asks over the bridge by name ────────────────────────────────
{
  for (const cw of [true, false]) {
    const script = scriptOf(ringotelProvisionHtml(DOC({ canWrite: cw })));
    let parsed = true;
    try { new Function(script); } catch { parsed = false; }
    ok(parsed, `[script] the page script parses (canWrite=${cw})`);
    ok(script.includes(`'${SPK_BRIDGE.provisionRequest}'`), `[script] it asks with the bridge's request name (canWrite=${cw})`);
    ok(script.includes(`'${SPK_BRIDGE.provisionResponse}'`), `[script] and listens for its response name (canWrite=${cw})`);
    ok(script.includes(`${SPK_BRIDGE.provisionKey}:`), `[script] and carries its payload key (canWrite=${cw})`);
    // Both builds READ; only the write build enables. Asserted per op rather than over a joined blob,
    // so a missing one says which.
    for (const op of ['fleet', 'domain']) {
      ok(script.includes(`ask('${op}'`), `[script] and asks op "${op}" (canWrite=${cw})`);
    }
  }
  const rwScript = scriptOf(ringotelProvisionHtml(DOC({ canWrite: true })));
  ok(rwScript.includes("ask('enable'"), '[script] the write build asks op "enable"');
  ok(rwScript.includes('confirm('), '[script] and every enable is confirmed first');
  // The read-only build ships none of the write code at all — not a disabled copy of it.
  const roScript = scriptOf(ringotelProvisionHtml(DOC({ canWrite: false })));
  ok(!roScript.includes("ask('enable'"), '[script] the read-only build never asks to enable anything');
  ok(!roScript.includes('confirm('), '[script] and has nothing to confirm');
}

// ── the bridge's PAYLOAD shape, re-derived out of both generated artifacts ─────────────────────────
// onebillPage.selftest.ts's bridge block (and statusPage.selftest.ts's) re-derive the ENVELOPE fields
// (tag/idKey/payloadKey) -- and neither would have caught 2026-09-14's bug: the kit forwarded the bare
// route JSON as the payload, and this page read v.fleet/v.checklist off it, so the fleet table rendered
// permanently empty. This block opens the payload itself, `v`, which `deliver(op,v)` is called with as
// `m.${SPK_BRIDGE.provisionKey}||{}` -- so every `v.<field>` read here is a field of the reply payload.
{
  const script = scriptOf(ringotelProvisionHtml(DOC({ canWrite: true })));
  const bundle = buildSpkBundle(['ringotel.provision.view'], { PORTAL_HANDOFF_URL: '' } as any);

  // Every field the page's deliver()/rpOutcomes() read off the payload.
  const fieldsRead = new Set([...script.matchAll(/\bv\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!));

  // Every field the kit LITERALLY sends: the prr({...}) calls whose payload is an inline object literal.
  // enable's success path is deliberately excluded from this extraction -- it forwards the route's own
  // JSON unwrapped (prr(r), no braces to match), so its fields are route-produced, not kit-authored.
  const sendRe = /prr\(\{([^}]*)\}\)/g;
  const fieldsSent = new Set(
    [...bundle.matchAll(sendRe)].flatMap((m) => m[1]!.split(',').map((kv) => kv.split(':')[0]!.trim())),
  );

  // What POST /kit/ringotel/enable answers with, unwrapped (worker.ts, the route handler's final line):
  //   return json({ outcomes, ...(stoppedAt ? { stoppedAt } : {}), report }, 200, …)
  // These never appear as a literal in kit.ts -- the enable branch forwards the route's `r` as-is -- so
  // they cannot show up in fieldsSent, but the page is entitled to read them.
  const ROUTE_PRODUCED = ['outcomes', 'stoppedAt', 'report'];

  const sentButUnread = [...fieldsSent].filter((f) => !fieldsRead.has(f));
  ok(sentButUnread.length === 0,
    `[bridge] every field the kit sends is read by the page (sent-but-unread: ${sentButUnread.join(',') || 'none'})`);
  const readUnaccounted = [...fieldsRead].filter((f) => !fieldsSent.has(f) && !ROUTE_PRODUCED.includes(f));
  ok(readUnaccounted.length === 0,
    `[bridge] every field the page reads is either sent by the kit or produced by the enable route (unaccounted: ${readUnaccounted.join(',') || 'none'})`);
}

// ── the bridge names are interpolated, never typed ─────────────────────────────────────────────────
// Both sides of this protocol emit JavaScript as a STRING, so a hand-typed literal here is a divergence
// no compiler would ever compare. The source is scanned rather than the output, because the output is
// where a literal and an interpolation look identical.
{
  const src = readFileSync(fileURLToPath(new URL('./ringotelProvisionPage.ts', import.meta.url)), 'utf8');
  for (const lit of [SPK_BRIDGE.provisionResponse, SPK_BRIDGE.provisionRequest]) {
    ok(!src.includes(`'${lit}'`) && !src.includes(`"${lit}"`),
      `[bridge] "${lit}" is never a literal in the renderer — it comes from SPK_BRIDGE`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
