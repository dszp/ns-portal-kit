/** Offline test for the OneBill links page renderer. pnpm test:onebillpage */
import { Script, runInNewContext } from 'node:vm';
import { onebillHtml, renderRows, renderForeign, renderDecommission, renderSetupCard, renderAccountPanel, rowScript, groupCtlHtml, ROW_STATES, FOREIGN_STATES } from './onebillPage.js';
import { SPK_BRIDGE } from './spkBridge.js';
import { buildSpkBundle } from './kit.js';
import type { LinkReport } from './onebill.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

const scriptOf = (html: string): string =>
  html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

/** A report with one row of every state, a foreign account carrying two links and a site note, and a
 *  failure — so the renderers are exercised on every branch rather than on the happy one. */
const REPORT = (): LinkReport => ({
  generatedAt: '2026-09-02T12:00:00.000Z',
  mode: 'full',
  verifiedAt: '2026-09-02T12:00:00.000Z',
  usageStale: false,
  rows: [
    { domain: 'globex.example', state: 'conflict', accounts: [
      { accountNumber: 'CLI00002', accountName: 'Globex', status: 'Active', links: [{ domain: 'globex.example' }], restricted: false },
      { accountNumber: 'CLI00003', accountName: 'Globex North', status: 'Active', links: [{ domain: 'globex.example' }], restricted: false }],
      sites: [], notes: ['Two accounts claim this domain.'] },
    { domain: 'acme.example', state: 'unlinked', accounts: [],
      candidate: { accountNumber: 'CLI00001', accountName: 'Acme', status: 'Active', confidence: 'exact' },
      sites: ['Main', 'Warehouse'], notes: [] },
    { domain: 'initech.example', state: 'unlinked', accounts: [], sites: ['HQ'], notes: [] },
    { domain: 'umbrella.example', site: 'Lab', state: 'linked',
      accounts: [{ accountNumber: 'CLI00004', accountName: 'Umbrella', status: 'Active',
        links: [{ domain: 'umbrella.example', site: 'Lab' }, { domain: 'wayne.example' }], restricted: false }],
      sites: ['Lab', 'Annex'], notes: [] },
    // A split domain and the site row it parents: no bare claim, one site already billed. The two sit
    // adjacent here because `buildLinkReport` sorts them that way — the renderer draws the order it is given.
    { domain: 'stark.example', state: 'split', accounts: [], sites: ['HQ', 'Lab', 'Annex'],
      linkedSites: ['HQ'], notes: [] },
    { domain: 'stark.example', site: 'HQ', state: 'linked',
      accounts: [{ accountNumber: 'CLI00006', accountName: 'Stark HQ', status: 'Active',
        links: [{ domain: 'stark.example', site: 'HQ' }], restricted: false }],
      sites: ['HQ', 'Lab', 'Annex'], siteCount: 1, notes: [] },
    // A linked row whose account ALSO holds a link this deployment hides: the editor is refused, because
    // every edit it offers is a removeUnlisted write the apply route would answer with a 400.
    { domain: 'hooli.example', state: 'linked',
      accounts: [{ accountNumber: 'CLI00014', accountName: 'Hooli', status: 'Active',
        links: [{ domain: 'hooli.example' }], restricted: true }],
      sites: ['HQ'], notes: [] },
  ],
  foreign: [
    { account: { accountNumber: 'CLI00009', accountName: 'Stale Co', status: 'Active' },
      value: 'gone.example', state: 'stale', links: [{ domain: 'gone.example' }, { domain: 'acme.example', site: 'Main' }],
      restricted: false,
      notes: ['The domain exists but not under this site — fix the site rather than remove the link.'] },
    { account: { accountNumber: 'CLI00010', accountName: 'Shut Co', status: 'Cancelled' },
      value: 'shut.example', state: 'closed', links: [{ domain: 'shut.example' }], restricted: false, notes: [] },
    { account: { accountNumber: 'CLI00011', accountName: 'Part Hidden Co', status: 'Active' },
      value: 'alsogone.example', state: 'stale', links: [{ domain: 'alsogone.example' }], restricted: true, notes: [] },
  ],
  usage: [{ account: { accountNumber: 'CLI00005', accountName: 'Wayne', status: 'Active' }, verdict: 'over', findings: ['3 more seats billed than provisioned.'] }],
  decommission: [
    { account: { accountNumber: 'CLI00012', accountName: 'Wound Down Co', status: 'Closed' }, domains: ['winddown.example', 'winddown2.example'] },
    { account: { accountNumber: 'CLI00013', status: 'Cancelled' }, domains: ['cancelled.example'] },
  ],
  accounts: [
    { accountNumber: 'CLI00001', accountName: 'Acme', status: 'Active' },
    { accountNumber: 'CLI00004', accountName: 'Umbrella', status: 'Active' },
  ],
  failures: [{ accountNumber: 'CLI00007', message: 'OneBill said: subscriber lookup timed out' }],
  siteReadFailures: ['initech.example'],
  hiddenLinkCount: 3,
  requestCount: 12,
  retried: 0,
  usageOffers: ['Domain Usage'],
});

// ── read-only vs writable: the controls are ABSENT, not disabled ────────────────────────────────────
// A disabled control still names an action the reader cannot take and still ships the code behind it.
// The page a reader without onebill.write gets does not contain the write surface at all, and says which
// key would grant it — a page that simply omits controls with no explanation reads as a broken page.
{
  const ro = onebillHtml({ canWrite: false, version: '1.2.3' });
  const rw = onebillHtml({ canWrite: true, version: '1.2.3' });

  ok(ro.includes('--integ:'), '[style] the read-only page carries the integration accent token');
  ok(ro.includes('Integration'), '[header] and the eyebrow');
  ok(ro.includes('OneBill links'), '[header] and the title');
  ok(ro.includes('Refresh'), '[header] and the Refresh control, which is a read');
  ok(ro.includes('1.2.3'), '[header] and the running version');

  for (const marker of ['data-act="link"', 'data-act="remove"', 'id="ob-apply"', 'type="checkbox"']) {
    ok(!ro.includes(marker), `[readonly] no ${marker} anywhere in the read-only page`);
    ok(rw.includes(marker), `[write] and it IS present when the caller holds onebill.write (${marker})`);
  }
  ok(ro.includes('onebill.write'), '[readonly] the read-only note names the key that would grant writing');
  ok(!ro.includes('confirm('), '[readonly] and no apply confirmation code ships either');
  ok(rw.includes('confirm('), '[write] while the writable page confirms a bulk apply before sending');

  for (const html of [ro, rw]) {
    let syntax = true; try { new Script(scriptOf(html)); } catch { syntax = false; }
    ok(syntax, `[script] the page script parses (canWrite=${html === rw})`);
  }
}

// ── the state tokens: two renderers, one list ───────────────────────────────────────────────────────
// The rows are drawn twice — server-side here, and by the client script from the bridge reply — so the
// two copies can disagree about what a state is called, and the CSS can know about neither. The token
// list is declared once per copy and asserted equal; every token must also have a chip rule.
{
  const html = onebillHtml({ canWrite: true, version: '0' });
  const script = scriptOf(html);
  const arr = (name: string): string[] => {
    const m = new RegExp(`var ${name}=\\[([^\\]]*)\\]`).exec(script);
    return m ? m[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
  };
  ok(JSON.stringify(arr('OB_STATES')) === JSON.stringify([...ROW_STATES]),
    `[states] the client script's row-state list matches the server renderer's (client: ${arr('OB_STATES').join(',')} / server: ${ROW_STATES.join(',')})`);
  ok(JSON.stringify(arr('OB_FSTATES')) === JSON.stringify([...FOREIGN_STATES]),
    `[states] and so does the foreign-state list (client: ${arr('OB_FSTATES').join(',')} / server: ${FOREIGN_STATES.join(',')})`);
  for (const t of [...ROW_STATES, ...FOREIGN_STATES]) {
    ok(html.includes(`.chip-${t} {`), `[states] the stylesheet defines a chip for ${t}`);
  }
}

// ── the bridge, re-derived out of both generated artifacts ──────────────────────────────────────────
// Same guard as statusPage.selftest.ts, for the same reason: the page and the injected parent are two
// generated strings that no compiler compares, and the failure mode is silent — the page waits forever
// on a reply whose field it does not read.
{
  const script = scriptOf(onebillHtml({ canWrite: true, version: '0' }));
  const bundle = buildSpkBundle(['onebill.view'], { PORTAL_HANDOFF_URL: '' } as any);

  const fieldsRead = new Set([...script.matchAll(/\bm\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!));
  // Only the replies stamped with THIS protocol's response type: the same bundle answers the console's
  // messages too, and folding those in would assert the union of two protocols against one page.
  const sendRe = new RegExp(`postMessage\\(\\{([^}]*${SPK_BRIDGE.onebillResponse}[^}]*)\\}`, 'g');
  const fieldsSent = new Set(
    [...bundle.matchAll(sendRe)].flatMap((m) => m[1]!.split(',').map((kv) => kv.split(':')[0]!.trim())),
  );
  const expected = [SPK_BRIDGE.tag, SPK_BRIDGE.idKey, SPK_BRIDGE.onebillKey].sort().join(',');
  const sorted = (s: Set<string>): string => [...s].sort().join(',');
  ok(sorted(fieldsSent) === expected, `[bridge] the bundle's reply carries exactly the protocol's fields (sends: ${sorted(fieldsSent)})`);
  // The page reads MORE than the links reply carries: it also asks the account, baseline and assign pairs
  // over the same bridge, and their payloads ride on their own keys. Still an exact set — a field the page
  // reads that no pair declares is a page waiting forever on something nobody sends.
  const expectedRead = [SPK_BRIDGE.tag, SPK_BRIDGE.idKey, SPK_BRIDGE.onebillKey, SPK_BRIDGE.accountKey, SPK_BRIDGE.baselineKey, SPK_BRIDGE.assignKey].sort().join(',');
  ok(sorted(fieldsRead) === expectedRead, `[bridge] and the page reads exactly the fields the four pairs declare (reads: ${sorted(fieldsRead)})`);

  ok(script.includes(`${SPK_BRIDGE.tag}: '${SPK_BRIDGE.onebillRequest}'`) && bundle.includes(`d.${SPK_BRIDGE.tag}==='${SPK_BRIDGE.onebillRequest}'`),
    '[bridge] the request the page posts is the one the parent listens for');
  ok(script.includes(`m.${SPK_BRIDGE.tag} !== '${SPK_BRIDGE.onebillResponse}'`) && bundle.includes(`${SPK_BRIDGE.tag}:'${SPK_BRIDGE.onebillResponse}'`),
    '[bridge] and the reply type the page guards on is the one the parent stamps');
  ok(/op: *'list'/.test(script) && /op: *'apply'/.test(script), '[bridge] the page names both operations');
  ok(bundle.includes(`jget('/kit/onebill/links?mode='`) && bundle.includes(`jpost('/kit/onebill/apply'`),
    '[bridge] and the parent forwards them to the two routes');
  ok(/oq\.mode==='full'\?'full':'quick'/.test(bundle) && /oq\.refresh\?'&refresh=1':''/.test(bundle),
    '[bridge] carrying the mode the page asked for, and refresh only when it asked to bypass the cache');
  // unavailable must never render as an empty table — the errorKey rule, one page over.
  ok(script.includes('unavailable'), '[bridge] the page handles the unavailable reply');
  ok(bundle.includes('unavailable:'), '[bridge] which the parent sends when it could not ask');
}

// -- the account, baseline and assign message pairs are declared and the parent handles all three ---
// The PARENT's half. The page's half of the assign pair is asserted with the rest of the panel wiring
// further down, against the real tag rather than the bare 'assign' word the markup already carries.
{
  const bundle = buildSpkBundle(['onebill.view'], { PORTAL_HANDOFF_URL: '' } as any);
  const F = SPK_BRIDGE as unknown as Record<string, string>;
  for (const field of ['accountRequest', 'accountResponse', 'accountKey', 'baselineRequest', 'baselineResponse', 'baselineKey',
    'assignRequest', 'assignResponse', 'assignKey']) {
    ok(typeof F[field] === 'string' && F[field] !== '', `[bridge] SPK_BRIDGE.${field} is declared`);
    ok(bundle.includes(F[field]!), `[bridge] and the parent bundle carries ${field} - a message one side has and the other does not is a silent no-op`);
  }
  ok(bundle.includes('/kit/onebill/account?'), '[bridge] the parent fetches the account route');
  ok(bundle.includes('/kit/onebill/baseline'), '[bridge] and posts the baseline route');
  ok(bundle.includes("/kit/onebill/assign?viewing='+encodeURIComponent("), '[bridge] and posts the assign route with the viewed account on the query string');
  // EITHER selector, and the account one wins when both arrive -- the route refuses two at once, so the
  // parent must send exactly one.
  ok(/aq\.account\?'account='\+encodeURIComponent\(aq\.account\):'domain='\+encodeURIComponent\(aq\.domain\|\|''\)/.test(bundle),
    '[bridge] the account request carries ?account= when the page named one, and ?domain= otherwise');
  // accountNumber crosses EXACTLY as sent: null means "hand it back to the automatic rule" and absent is
  // a page bug, so the parent must not coalesce the two into a decision nobody made.
  ok(bundle.includes('accountNumber:gq.accountNumber'), '[bridge] and the assign body forwards accountNumber verbatim, null included');
  ok(!/assign[\s\S]{0,400}decidedBy/.test(bundle), '[bridge] while decidedBy is never forwarded - the Worker takes it from the ns_t');
}

// ── the rows themselves ─────────────────────────────────────────────────────────────────────────────
{
  const report = REPORT();
  const rw = renderRows(report, true);
  const ro = renderRows(report, false);
  const trs = [...rw.matchAll(/<tr data-state="([a-z]+)"/g)].map((m) => m[1]!);
  ok(trs.length === report.rows.length, `[rows] one row per report row (${trs.length} of ${report.rows.length})`);
  ok(JSON.stringify(trs) === JSON.stringify(['conflict', 'unlinked', 'unlinked', 'linked', 'split', 'linked', 'linked']),
    `[rows] each carrying its own state, in the report's order (${trs.join(',')})`);

  const cells = rw.split('<tr data-state=');
  const conflictRow = cells[1]!, candidateRow = cells[2]!, manualRow = cells[3]!, linkedRow = cells[4]!;
  ok(/type="checkbox"[^>]*checked/.test(candidateRow), '[rows] the candidate row\'s checkbox is pre-checked');
  ok(candidateRow.includes('CLI00001'), '[rows] and names the candidate account');
  ok(!/data-act=/.test(conflictRow), '[rows] the conflict row offers no controls — two accounts claim it and the page cannot choose');
  ok(!/data-act="link"/.test(linkedRow), '[rows] and neither does a row that is already linked — its only control is Edit');
  ok(manualRow.includes('data-role="acct"') && manualRow.includes('data-act="link"'),
    '[rows] a row with no candidate gets the manual account picker and a Link button');
  ok(candidateRow.includes('<select') && candidateRow.includes('Warehouse'),
    '[rows] a domain with sites gets the site picker, so a split can be recorded');
  ok(!/data-act=|type="checkbox"/.test(ro), '[rows] and a read-only render has no controls at all');
  ok(!ro.includes('<td class="act">'), '[rows] nor an Action cell, which could never hold anything');
  ok(!onebillHtml({ canWrite: false, version: '0' }).includes('<th>Action</th>'), '[rows] and no Action header over it');
  ok(ro.includes('CLI00004'), '[rows] while still reporting what each domain is linked to');

  // The Domain/Site cell's button opens the account panel, which compares a WHOLE domain's inventory.
  // A site row must not offer it: `resolveAccountForDomain` refuses one with a 409, and a control that
  // leads only to a refusal is worse than no control. Both copies of the renderer are checked, one at a
  // time, so a divergence names which side moved.
  const clientRows = runInNewContext(`${rowScript(true)}\nobRows(R)`, { R: report }) as string;
  for (const [which, html] of [['server', rw], ['client', clientRows]] as const) {
    ok(html.includes('data-open-domain="hooli.example"'), `[rows] a linked WHOLE-DOMAIN row still opens the account panel (${which})`);
    // A SITE row opens BY ACCOUNT, never by domain: the panel is scoped to what the account holds, and
    // `?domain=` on a split domain names a row several accounts share.
    ok(!html.includes('data-open-domain="umbrella.example"'), `[rows] a linked SITE row does not open by domain (${which})`);
    ok(html.includes('<button type="button" class="linkish dom" data-open-account="CLI00004">umbrella.example</button>'),
      `[rows] it opens by the account that bills the site instead (${which})`);
    ok(!html.includes('data-open-domain="stark.example"'), `[rows] nor does the site row under a split parent (${which})`);
    ok(html.includes('data-open-account="CLI00006"'), `[rows] which opens by ITS account too (${which})`);
    ok(/<div class="siterow">Site: <b>Lab<\/b><\/div>/.test(html), `[rows] and the Site: line still sits under the button (${which})`);
    // A split parent stays plain text while its sites are billed to different accounts: there is no one
    // account the domain could open to.
    ok(/<span class="dom">stark\.example<\/span>/.test(html), `[rows] a split parent with no single billing account is plain text (${which})`);
  }

  // A CONFLICT site row opens nothing either: two accounts claim it, `resolveAccountScope` throws rather
  // than picking one, and a button whose only outcome is that refusal is not a button.
  const conflictSite: LinkReport = { ...REPORT(), rows: [{ domain: 'clash.example', site: 'Y', state: 'conflict',
    accounts: [{ accountNumber: 'CLI00041', accountName: 'One', status: 'Active', links: [{ domain: 'clash.example', site: 'Y' }], restricted: false },
      { accountNumber: 'CLI00042', accountName: 'Two', status: 'Active', links: [{ domain: 'clash.example', site: 'Y' }], restricted: false }],
    sites: ['Y'], notes: [] }] };
  const clash = renderRows(conflictSite, true);
  ok(!/data-open-(account|domain)=/.test(clash), '[rows] a conflicted site row offers no way into the panel');
  ok(/<span class="dom">clash\.example<\/span>/.test(clash), '[rows] and stays plain text');
  ok(runInNewContext(`${rowScript(true)}\nobRows(R)`, { R: conflictSite }) === clash,
    '[mirror] the client copy agrees about the conflicted site row');
}

// ── the foreign block ───────────────────────────────────────────────────────────────────────────────
{
  const report = REPORT();
  const rw = renderForeign(report, true);
  const ro = renderForeign(report, false);
  ok(rw.includes('data-act="remove"'), '[foreign] Remove is offered when the caller can write');
  ok(!ro.includes('data-act="remove"'), '[foreign] and never when they cannot');
  ok(rw.includes('CLI00009') && rw.includes('gone.example'), '[foreign] the account and the link it holds are named');
  ok(rw.includes('fix the site'), '[foreign] and its notes ride beside the control, since they name the likely remedy');
  ok(/data-links="[^"]*acme\.example[^"]*"/.test(rw),
    '[foreign] the row carries the account\'s OTHER links, which is what a removal has to send back');
  ok(rw.includes('chip-stale'), '[foreign] the state is chipped');

  // Hidden links are COUNTED, never named: the count says the report is not the whole tenant, and the
  // names are what the allow/block lists exist to withhold.
  ok(/3 links point at domains this portal is set not to show/.test(rw), '[foreign] hidden links are counted in one line');
  ok(/3 links point at domains this portal is set not to show/.test(ro), '[foreign] for a read-only caller too — it is a fact about the report, not about writing');
  const one = renderForeign({ ...report, hiddenLinkCount: 1 }, true);
  ok(/1 link points at a domain this portal is set not to show/.test(one), '[foreign] and it reads as one link when there is one');
  ok(!/point at domains outside/.test(renderForeign({ ...report, hiddenLinkCount: 0 }, true)),
    '[foreign] while a report hiding nothing says nothing about hiding');

  // A CLOSED account is not one this deployment writes to — the report's account list is Active only, so
  // the apply route would refuse the op. The button would be a click that always ends in a 400.
  //
  // `buildLinkReport` no longer PUTS a closed row in `foreign` at all; the branch below stays because the
  // renderer draws whatever report it is handed, and a cached report written before that rule still holds
  // closed rows for up to the report TTL. The fixture is therefore synthetic on purpose.
  const blocks = rw.split('<div class="frow"');
  const stale = blocks[1]!, closed = blocks[2]!, restricted = blocks[3]!;
  ok(stale.includes('data-act="remove"'), '[foreign] a stale row keeps its Remove control');
  ok(!closed.includes('data-act="remove"'), '[foreign] a CLOSED account gets none, however writable the caller is');
  ok(closed.includes('Closed account'), '[foreign] and is told why instead');

  // A RESTRICTED account is one the apply route refuses a matching write on, because the list the page
  // would send it is missing the links it was not shown. Drawing the button would be a guaranteed 400.
  ok(!restricted.includes('data-act="remove"'), '[foreign] an account also holding links outside this deployment\'s view gets no Remove either');
  ok(restricted.includes('Change them in OneBill'), '[foreign] and is told what to do instead, naming nothing hidden');
  ok(!/blocked|hidden domain/i.test(restricted), '[foreign] the note names no domain at all');
}

// ── the decommission callout ────────────────────────────────────────────────────────────────────────
// Closed in OneBill, still live in NetSapiens. A callout, not a control: nothing on a closed account is
// written from this page, which is exactly why its foreign rows are gone and this block exists instead.
{
  const report = REPORT();
  const out = renderDecommission(report);
  ok(out.includes('Closed accounts whose domain is still live'), '[decom] the block titles itself');
  ok(out.includes('These OneBill accounts are closed, but NetSapiens still has their domain. They may need decommissioning.'),
    '[decom] and says in one line what the reader is looking at');
  ok(out.includes('CLI00012') && out.includes('Wound Down Co'), '[decom] each entry names the account');
  ok(out.includes('<code>winddown.example</code>') && out.includes('<code>winddown2.example</code>'),
    '[decom] and every domain it still holds, as code');
  ok(out.includes('CLI00013'), '[decom] an account with no name still lists');
  ok(!/data-act=|<button/.test(out), '[decom] with no control of any kind — this is a callout');

  // Nothing when empty, heading included: a heading over nothing reads as a section that failed to load.
  ok(renderDecommission({ ...report, decommission: [] }) === '', '[decom] an empty callout renders nothing at all, not an empty heading');
  ok(renderDecommission({ ...report, decommission: undefined as any }) === '', '[decom] and a report predating the field is empty, not a crash');

  const html = onebillHtml({ canWrite: true, version: '0' });
  ok(html.indexOf('id="ob-decom"') > 0 && html.indexOf('id="ob-decom"') < html.indexOf('id="ob-usage"'),
    '[decom] the page reserves a slot for it above the usage details');
}

// ── the parts that must never be hidden ─────────────────────────────────────────────────────────────
{
  const html = onebillHtml({ canWrite: true, version: '0' });
  const script = scriptOf(html);
  ok(script.includes('siteReadFailures'), '[report] a domain whose sites could not be read is reported, not assumed empty');
  ok(script.includes('failures'), '[report] and so are the accounts the report could not read');
  ok(script.includes('notRemoved') && script.includes('unmapped'),
    '[results] an apply result reports links it did not remove and targets it could not map');
  ok(script.includes('.error'), '[results] and renders the server\'s own error message');
}

// ── the setup card: shown in place of the table when OneBill has not declared the group ────────────
{
  const notOk = { ok: false as const, missing: ['valueField' as const], group: 'PBX', valueField: 'Domain', qualifierField: 'Site' };
  const server = renderSetupCard(notOk);
  const client = runInNewContext(`${rowScript(true)}\nobSetupCard(S)`, { S: notOk }) as string;
  ok(server === client, '[setup] the server and client renderers produce byte-identical markup');
  ok(server.includes('OneBill needs a custom-field group before links can be stored'), '[setup] the exact title');
  ok(server.includes('In OneBill, create an account-level custom-field group with the key "PBX"'), '[setup] and the exact checklist');
  ok(server.includes('add a text field "Domain"') && server.includes('an optional text field "Site"'), '[setup] naming both fields when a qualifier is configured');
  ok(server.includes('Then Refresh and fully verify.'), '[setup] and the remediation step');
  ok(server.includes('Missing: the "Domain" field.'), '[setup] naming exactly which of the three is missing');
  ok(/data-setup-missing="valueField"/.test(server), '[setup] carried in a data attribute for tests');

  // No qualifier configured at all: the checklist never invents one, and the card names the group.
  const noQual = { ok: false as const, missing: ['group' as const], group: 'PBX', valueField: 'Domain' };
  ok(!renderSetupCard(noQual).includes('optional text field'), '[setup] no qualifierField in the mapping: never mentioned');
  ok(renderSetupCard(noQual).includes('Missing: the group itself (key "PBX")'), '[setup] and a missing group is named as such');

  // Wired into render(): not-ok hides the table, the filter bar and every write control; ok shows them.
  const html = onebillHtml({ canWrite: true, version: '0' });
  const script = scriptOf(html);
  ok(script.includes("if(elSetup){if(rep&&rep.setup&&rep.setup.ok===false){"), '[setup] render() branches on rep.setup.ok before drawing anything else');
  ok(html.indexOf('id="ob-setup"') < html.indexOf('id="ob-normal"'), '[setup] the card slot sits above the normal content it replaces');
  ok(/<div id="ob-setup" hidden><\/div>\s*<div id="ob-normal">/.test(html), '[setup] the card starts hidden, and the whole table/controls/foreign/decom/usage block is one togglable container');
  for (const id of ['ob-filter', 'ob-rows', 'ob-foreign', 'ob-decom', 'ob-usage']) {
    ok(html.indexOf(`id="${id}"`) > html.indexOf('id="ob-normal"'), `[setup] #${id} lives inside #ob-normal, so it is hidden along with it`);
  }
}

// ── the split-by-site parent ────────────────────────────────────────────────────────────────────────
// A domain nobody bills as a whole, but whose sites are billed one by one. It is NOT unlinked: nothing
// is missing, the billing is just per site — so it gets its own state, its own chip, and an action that
// adds the NEXT site rather than claiming the domain.
{
  const report = REPORT();
  const rw = renderRows(report, true);
  const rows = rw.split('<tr data-state=');
  const splitRow = rows[5]!, childRow = rows[6]!;

  ok(splitRow.startsWith('"split"'), '[split] the parent row carries the split state');
  ok(splitRow.includes('<span class="chip chip-split">split by site</span>'),
    '[split] chipped as SPLIT BY SITE (the stylesheet uppercases it), not as a bare token');
  ok(!splitRow.includes('Split by site in OneBill'), '[split] the redundant note is gone — the account cell already lists each sited claimant');
  ok(childRow.includes('<div class="siterow">Site: <b>HQ</b></div>'), '[split] and its site row renders indented, directly under it');
  ok(!childRow.includes(' / '), '[split] with no " / " separator anywhere on the site row');
  ok(childRow.startsWith('"linked" data-domain="stark.example" class="site" data-site="HQ">'),
    `[split] the site row's <tr> carries the site class and data-site attribute (${childRow.slice(0, 80)})`);
  // stark.example has exactly one claimed site, so it reads as "the only site", not "one of 1 sites".
  ok(childRow.includes('<div class="dim">(the only site on this domain)</div>'),
    '[split] a domain with one claimed site says it is the only one');

  // The site picker: the default is the first site NOT already billed, and "whole domain" is offered
  // without being the default — linking a split domain as a whole is a deliberate act, not a slip.
  const sel = /<select class="site"[^>]*>([\s\S]*?)<\/select>/.exec(splitRow)?.[1] ?? '';
  ok(/<option value="Lab" selected>/.test(sel), `[split] the site picker defaults to the first site not yet linked (${sel})`);
  ok(/<option value="">whole domain<\/option>/.test(sel), '[split] "whole domain" is still on offer');
  ok(!/<option value="" selected/.test(sel), '[split] but never as the default');
  ok(sel.indexOf('value="HQ"') >= 0, '[split] a site already linked is still listed — the reader can see it');
  ok(splitRow.includes('>Link another site</button>'), '[split] and the button says what it does here');
  ok(splitRow.includes('data-role="acct"'), '[split] the account picker rides with it');

  // A split parent never carries a candidate, so the Candidate cell is the em dash and nothing else.
  ok(splitRow.includes('<td>—</td>'), '[split] no candidate is proposed for a domain that is already billed per site');
  ok(!/type="checkbox"/.test(splitRow), '[split] and there is no pre-selected tick for a bulk apply');

  const legend = onebillHtml({ canWrite: true, version: '0' });
  ok(legend.includes('<span class="chip chip-split">split by site</span> linked per site'),
    '[split] the legend explains the state');
  ok(/--chip-split:/.test(legend.split('@media (prefers-color-scheme: dark)')[0]!)
    && /--chip-split:/.test(legend.split('@media (prefers-color-scheme: dark)')[1]!),
    '[split] and the chip colour is defined in BOTH palettes, not just the light one');
}

// ── a site row's own count (task 12 item 2): "one of N" vs "the only site" ─────────────────────────────
// stark.example above exercises the singular case (one claimed site). A domain with three carries the
// plural — asserted here directly on a hand-built site row, since `siteCount` is set by `buildLinkReport`
// (see onebill.selftest.ts) and is otherwise just data the renderer reads.
{
  const threeSites: LinkReport = {
    ...REPORT(),
    rows: [{ domain: 'wayne.example', site: 'Annex', state: 'linked',
      accounts: [{ accountNumber: 'CLI00040', accountName: 'Wayne Annex', status: 'Active',
        links: [{ domain: 'wayne.example', site: 'Annex' }], restricted: false }],
      sites: ['HQ', 'Lab', 'Annex'], siteCount: 3, notes: [] }],
  };
  const rw = renderRows(threeSites, true);
  ok(rw.includes('<div class="dim">(one of 3 sites on this domain)</div>'),
    `[sitecount] a site row with three sited siblings says "one of 3" (${rw})`);
  ok(!rw.includes('the only site'), '[sitecount] and never the singular phrasing when there is more than one');

  const out = runInNewContext(`${rowScript(true)}\nobRows(R)`, { R: threeSites }) as string;
  ok(out === rw, '[mirror] the client copy renders the site-count line identically');

  // A non-site row (no `site`) never carries a count line, even if `siteCount` were somehow set on it.
  const { site: _site, ...bareRow } = threeSites.rows[0]!;
  const bareWithCount: LinkReport = { ...REPORT(), rows: [bareRow] };
  ok(!renderRows(bareWithCount, true).includes('sites on this domain'),
    '[sitecount] a bare (non-site) row never shows the count line');
}

// ── a split parent's Account cell lists its sited accounts, marking the usage holder ───────────────────
// Only a split row has `siteAccounts`, and only when it does does the account cell stop reading "—".
const splitAccts = (): LinkReport => ({
  ...REPORT(),
  rows: [
    { domain: 'wonka.example', state: 'split', accounts: [], sites: ['North', 'South'], linkedSites: ['North', 'South'],
      siteAccounts: [
        { site: 'North', account: { accountNumber: 'CLI00030', accountName: 'Wonka & North Co', status: 'Active' }, usageHolder: true },
        { site: 'South', account: { accountNumber: 'CLI00031', accountName: 'Wonka South', status: 'Active' }, usageHolder: false },
      ], notes: [] },
  ],
});
const splitAcctsNoHolder = (): LinkReport => ({
  ...REPORT(),
  rows: [
    { domain: 'flint.example', state: 'split', accounts: [], sites: ['East', 'West'], linkedSites: ['East', 'West'],
      siteAccounts: [
        { site: 'East', account: { accountNumber: 'CLI00032', accountName: 'Flint East', status: 'Active' }, usageHolder: false },
        { site: 'West', account: { accountNumber: 'CLI00033', accountName: 'Flint West', status: 'Active' }, usageHolder: false },
      ], notes: [] },
  ],
});
/** Every site billed to the SAME account: the one split shape that still has a single subject to open. */
const splitAcctsOne = (): LinkReport => ({
  ...REPORT(),
  rows: [
    { domain: 'oscorp.example', state: 'split', accounts: [], sites: ['East', 'West'], linkedSites: ['East', 'West'],
      siteAccounts: [
        { site: 'East', account: { accountNumber: 'CLI00034', accountName: 'Oscorp', status: 'Active' }, usageHolder: true },
        { site: 'West', account: { accountNumber: 'CLI00034', accountName: 'Oscorp', status: 'Active' }, usageHolder: false },
      ], notes: [] },
  ],
});
{
  const rw = renderRows(splitAccts(), true);
  ok(rw.includes('<div class="sacct"><b class="sname">North</b> — <span data-account="CLI00030">CLI00030 — Wonka &amp; North Co</span> <span class="chip usage">USAGE</span></div>'),
    '[siteAccts] the holder\'s line leads with the bold site name, then the account, and carries the USAGE chip');
  ok(rw.includes('<div class="sacct"><b class="sname">South</b> — <span data-account="CLI00031">CLI00031 — Wonka South</span></div>'),
    '[siteAccts] the other account\'s line leads with its site too, with no chip');
  ok(rw.indexOf('<b class="sname">North</b>') < rw.indexOf('<b class="sname">South</b>'),
    '[siteAccts] the sites list in the same order as the site rows');
  ok((rw.match(/chip usage/g) ?? []).length === 1, '[siteAccts] the USAGE chip appears exactly once');
  ok(!rw.includes('No account on this domain holds a usage subscription'), '[siteAccts] and the no-holder line is absent when one holds it');

  const none = renderRows(splitAcctsNoHolder(), true);
  ok(none.includes('<div class="dim">No account on this domain holds a usage subscription.</div>'),
    '[siteAccts] when NO account holds usage, the dim line says so');
  ok(!/chip usage/.test(none), '[siteAccts] and no USAGE chip appears anywhere');
  ok(none.includes('CLI00032') && none.includes('CLI00033'), '[siteAccts] both non-holding accounts still list, in site order');
  ok(none.indexOf('CLI00032') < none.indexOf('CLI00033'), '[siteAccts] East before West, matching site order');

  // A split row carrying NO siteAccounts (an older cached report, or one with no sited claims at all)
  // still falls back to the em dash, exactly as before this field existed.
  const bare = renderRows({ ...REPORT(), rows: [{ domain: 'nobody.example', state: 'split', accounts: [], sites: ['A', 'B'], linkedSites: ['A'], notes: [] }] }, true);
  ok(bare.includes('<td>—</td>'), '[siteAccts] a split row with no siteAccounts still renders the em dash');

  for (const [report, which] of [[splitAccts(), 'holder'], [splitAcctsNoHolder(), 'no holder']] as const) {
    const out = runInNewContext(`${rowScript(true)}\nobRows(R)`, { R: report }) as string;
    ok(out === renderRows(report, true), `[mirror] the client copy renders the split-account cell identically (${which})`);
  }

  // A split parent whose sites all bill to ONE account has exactly one account the domain can open to,
  // so it gets the button back — `?domain=` resolves to that account and the panel is its whole scope.
  // Two accounts and it stays plain text: there is no single subject for the click to name.
  const oneAcct = renderRows(splitAcctsOne(), true);
  ok(oneAcct.includes('<button type="button" class="linkish dom" data-open-domain="oscorp.example">oscorp.example</button>'),
    '[siteAccts] a split parent billed entirely to one account opens by domain');
  ok(!renderRows(splitAccts(), true).includes('data-open-domain='),
    '[siteAccts] while one split across two accounts opens nothing');
  ok(runInNewContext(`${rowScript(true)}\nobRows(R)`, { R: splitAcctsOne() }) === oneAcct,
    '[mirror] the client copy agrees on the single-account split parent');
}

// ── the account typeahead ───────────────────────────────────────────────────────────────────────────
// The old picker was an <input list> over a <datalist> of account NUMBERS, which is only usable by
// someone who already knows the number. This one searches name or number and writes the number back.
{
  const report = REPORT();
  const rw = renderRows(report, true);
  const html = onebillHtml({ canWrite: true, version: '0' });
  const script = scriptOf(html);
  const rows = rw.split('<tr data-state=');
  const manualRow = rows[3]!, splitRow = rows[5]!, linkedRow = rows[4]!;

  ok(!html.includes('<datalist'), '[ta] no datalist survives anywhere on the page');
  ok(!html.includes('ob-accts'), '[ta] nor the id it was referenced by');
  for (const [name, row] of [['unlinked', manualRow], ['split', splitRow]] as const) {
    ok(/<input class="acct" data-role="acct" placeholder="Client name or account number"/.test(row),
      `[ta] the ${name} row gets the search input, labelled for a name OR a number`);
    ok(row.includes('<ul class="ta" data-role="acctlist" hidden></ul>'),
      `[ta] and an EMPTY list container beside it — the matches are drawn client-side (${name})`);
  }
  // A linked row DOES carry one now — inside its editor, so "add a site" can put the new site on a
  // different account. It is the same helper, attached the same way, and it is hidden until Edit.
  ok(linkedRow.includes('data-role="editor"') && linkedRow.includes('data-role="acct"'),
    '[ta] a linked row carries one too, inside its editor, so a site can be added on another account');

  ok(script.includes('ta-num'), '[ta] the client script draws the account number in its own class');
  ok(/localeCompare/.test(script) && /accountName/.test(script), '[ta] and sorts the matches by name');
  ok(script.includes('function obTypeahead('), '[ta] one implementation, attached per row after each render');
  ok(script.includes('ArrowDown') && script.includes('Escape') && script.includes('Enter'),
    '[ta] keyboard: move, choose, dismiss');
  ok(script.includes('data-acct'), '[ta] a pick writes the NUMBER onto the row, not the label the reader sees');
  // The list is placed against a rect, so a scroll under it or a resize invalidates it — but its OWN
  // scroll must not close it, or an arrow key that scrolls the list dismisses the list.
  ok(/\.ul\.contains\(ev\.target\)/.test(script), '[ta] a scroll INSIDE the list is not a scroll that closes it');
  ok(/addEventListener\('resize'/.test(script), '[ta] and a resize closes it, because the rect it was placed against is stale');
  // ONE delegated pair for the page, not one per row: obTypeahead runs again on every render, and the
  // per-row registration left the old ones attached — a Refresh added a whole set of listeners.
  for (const ev of ['scroll', 'resize']) {
    const n = (script.match(new RegExp(`window\\.addEventListener\\('${ev}'`, 'g')) || []).length;
    ok(n === 1, `[ta] exactly one page-level ${ev} listener is registered, however many rows there are (${n})`);
  }
  ok(script.indexOf("window.addEventListener('scroll'") < script.indexOf('function obTypeahead('),
    '[ta] and it is registered once at page level, outside the per-row attach');
  ok(!scriptOf(onebillHtml({ canWrite: false, version: '0' })).includes('function obTypeahead('),
    '[ta] and a reader without the write key is shipped none of it');

  // The matcher itself, run for real: it decides what the reader is offered, and a substring rule is
  // exactly the kind of thing that silently becomes a prefix rule.
  const ACCTS = [
    { accountNumber: 'CLI00021', accountName: 'Zeta Holdings', status: 'Active' },
    { accountNumber: 'CLI00022', accountName: 'acme Freight', status: 'Active' },
    { accountNumber: 'CLI00023', accountName: 'Acme Bakery', status: 'Active' },
    { accountNumber: 'CLI00099', accountName: 'Numbers Only Co', status: 'Active' },
    ...Array.from({ length: 15 }, (_, i) => ({ accountNumber: `CLI001${String(i).padStart(2, '0')}`, accountName: `Acme Branch ${i}`, status: 'Active' })),
  ];
  const run = (q: string): { accountNumber: string; accountName: string }[] =>
    runInNewContext(`${rowScript(true)}\nobAccountMatches(A,Q)`, { A: ACCTS, Q: q }) as never;

  const acme = run('ACME');
  ok(acme.length === 12, `[ta] at most 12 matches are offered (${acme.length})`);
  ok(acme.every((a) => /acme/i.test(a.accountName)), '[ta] matching is case-insensitive on the name');
  const names = acme.map((a) => a.accountName);
  ok(JSON.stringify(names) === JSON.stringify([...names].sort((x, y) => x.localeCompare(y))),
    `[ta] and the offered matches are sorted by name (${names.join(' | ')})`);
  ok(run('bakery').length === 1 && run('bakery')[0]!.accountNumber === 'CLI00023',
    '[ta] a substring anywhere in the name matches, not just a prefix');
  ok(run('00099').length === 1 && run('00099')[0]!.accountName === 'Numbers Only Co',
    '[ta] and a substring of the account NUMBER matches too');
  ok(run('').length === 12, '[ta] an empty query offers the first page of accounts rather than nothing');
  ok(run('nothing-matches-this').length === 0, '[ta] a query that matches nothing offers nothing');
}

// ── editing a link that already exists ──────────────────────────────────────────────────────────────
// A linked row gets an Edit button that reveals three actions in the Action cell: change this link's
// site, add a second site (on this account or another), and unlink it. Each is ONE op on ONE account,
// and each carries the account's OTHER links so a matching write leaves them alone.
{
  const report = REPORT();
  const rw = renderRows(report, true);
  const ro = renderRows(report, false);
  const rows = rw.split('<tr data-state=');
  const linkedRow = rows[4]!, restrictedRow = rows[7]!;

  ok(linkedRow.includes('data-act="edit"'), '[edit] a linked row offers Edit');
  ok(!ro.includes('data-act="edit"'), '[edit] and never to a reader without the write key');
  ok(linkedRow.includes('data-role="editor"') && linkedRow.includes('hidden>'),
    '[edit] the editor is rendered with the row and hidden until Edit is clicked');
  ok(linkedRow.includes('data-act="edit-site"'), '[edit] it offers Change site');
  ok(linkedRow.includes('data-act="edit-add"'), '[edit] Add a site');
  ok(linkedRow.includes('data-act="edit-unlink"'), '[edit] and Unlink');
  ok(/data-role="esite"[\s\S]*?<option value="Lab" selected>/.test(linkedRow),
    '[edit] the change-site picker starts on the site this link already has');
  ok(/data-role="esite"[\s\S]*?<option value="">whole domain<\/option>/.test(linkedRow),
    '[edit] with "whole domain" on offer, which is what unsiting a link means');
  const add = /data-role="asite"[^>]*>([\s\S]*?)<\/select>/.exec(linkedRow)?.[1] ?? '';
  ok(/value="Annex"/.test(add) && !/value="Lab"/.test(add),
    `[edit] the add-a-site picker offers only sites this account does not already hold (${add})`);
  ok(linkedRow.includes('data-role="acct"') && linkedRow.includes('data-role="acctlist"'),
    '[edit] and the same account typeahead, so a site can be added on a DIFFERENT account');
  // The editor carries what an op needs, the way a foreign row carries its links: the DOM is the only
  // thing the click handler has, and re-deriving the account from the table would be a second source.
  ok(/data-role="editor"[^>]*data-account="CLI00004"/.test(linkedRow), '[edit] the editor names its account');
  ok(/data-links="[^"]*wayne\.example[^"]*"/.test(linkedRow),
    '[edit] and carries the account\'s OTHER links, which is what a matching write has to send back');

  // A restricted account: the note instead of the control, naming nothing hidden. Every edit is a
  // removeUnlisted write (or rides in one), and the apply route refuses those on exactly this account.
  ok(!restrictedRow.includes('data-act="edit'), '[edit] a restricted account gets no editor at all');
  ok(restrictedRow.includes('Change them in OneBill'), '[edit] and is told what to do instead');
  ok(!/blocked|hidden domain/i.test(restrictedRow), '[edit] with the note naming no domain');

  // A report cached before `links` shipped renders for up to its TTL. Absent must not read as EMPTY:
  // an Unlink built from an empty list is `links: []` with removeUnlisted, which clears the account.
  const stale = REPORT();
  delete (stale.rows[3]!.accounts[0] as any).links;
  ok(!renderRows(stale, true).split('<tr data-state=')[4]!.includes('data-act="edit"'),
    '[edit] a row account with NO links at all gets no editor — absent is not empty');

  // A conflict row still offers nothing: two accounts claim it and the page cannot choose between them.
  ok(!rows[1]!.includes('data-act="edit"'), '[edit] a conflict row offers no editor — the page cannot choose between two claims');

  const html = onebillHtml({ canWrite: true, version: '0' });
  ok(/\.editor \{/.test(html) && /\.erow \{/.test(html), '[edit] the stylesheet knows about the editor and its rows');
}

// ── obEditOps: the op each edit sends, asserted exactly ─────────────────────────────────────────────
// The whole risk in this feature is the `links` array: it is what a removeUnlisted write matches the
// record to, so a missing entry is a silent deletion. One assertion per action, exact arrays.
{
  const R = { domain: 'acme.example', site: 'Main', state: 'linked' };
  const A = { accountNumber: 'CLI00001', accountName: 'Acme',
    links: [{ domain: 'acme.example', site: 'Main' }, { domain: 'other.example' }] };
  const ops = (act: string, args: unknown = null): unknown =>
    runInNewContext(`${rowScript(true)}\nobEditOps(R,A,ACT,G)`, { R, A, ACT: act, G: args });
  const eq = (got: unknown, want: unknown): boolean => JSON.stringify(got) === JSON.stringify(want);

  const moved = ops('site', { site: 'Warehouse' });
  ok(eq(moved, [{ accountNumber: 'CLI00001', links: [{ domain: 'other.example' }, { domain: 'acme.example', site: 'Warehouse' }], removeUnlisted: true }]),
    `[ops] change-site replaces THIS link and carries the others, matching (${JSON.stringify(moved)})`);

  const unsited = ops('site', { site: '' });
  ok(eq(unsited, [{ accountNumber: 'CLI00001', links: [{ domain: 'other.example' }, { domain: 'acme.example' }], removeUnlisted: true }]),
    `[ops] change-site to "whole domain" sends the link with no site at all (${JSON.stringify(unsited)})`);

  const unlinked = ops('unlink');
  ok(eq(unlinked, [{ accountNumber: 'CLI00001', links: [{ domain: 'other.example' }], removeUnlisted: true }]),
    `[ops] unlink sends the other links and nothing else, matching (${JSON.stringify(unlinked)})`);

  const addSame = ops('add', { site: 'Warehouse' });
  ok(eq(addSame, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example', site: 'Main' }, { domain: 'other.example' }, { domain: 'acme.example', site: 'Warehouse' }] }]),
    `[ops] add-a-site on the SAME account rides in one op with the full list and no removeUnlisted (${JSON.stringify(addSame)})`);

  const addOther = ops('add', { site: 'Warehouse', account: 'CLI00002' });
  ok(eq(addOther, [{ accountNumber: 'CLI00002', links: [{ domain: 'acme.example', site: 'Warehouse' }] }]),
    `[ops] while on ANOTHER account it is a plain link op, which removes nothing from either (${JSON.stringify(addOther)})`);

  // Nothing an edit sends may be a removeUnlisted op on an account other than the one being edited.
  const all = [moved, unsited, unlinked, addSame, addOther] as { accountNumber: string; removeUnlisted?: boolean }[][];
  for (const o of all) ok(o.length === 1, `[ops] every edit is exactly ONE op (${JSON.stringify(o).slice(0, 60)})`);
  ok((addOther as any)[0].removeUnlisted === undefined, '[ops] and the other-account op never carries removeUnlisted');
}

// ── the two copies of the renderer, held byte-identical ─────────────────────────────────────────────
// The rows are drawn server-side (above, so the markup can be asserted without a DOM) and client-side
// (from the bridge reply, which is what actually runs). Comparing tokens would catch a renamed state and
// miss everything else, so the client copy is EVALUATED here and its output compared byte for byte. A
// divergence in either direction fails, which is the only version of this guard worth having.
{
  // The EMPTY report is compared too: its row is one cell with a colspan, and the two copies compute that
  // number differently (a client constant, a server ternary) — exactly the pair a fixture with rows in it
  // never touches.
  const empty: LinkReport = { ...REPORT(), rows: [], foreign: [], accounts: [], decommission: [] };
  const quick: LinkReport = { ...REPORT(), mode: 'quick', verifiedAt: null, usageStale: true };
  for (const report of [REPORT(), empty, quick]) {
  for (const cw of [true, false]) {
    const ctx: Record<string, unknown> = { R: report };
    const which = `${report.rows.length ? report.mode : 'empty'} report, canWrite=${cw}`;
    const out = runInNewContext(`${rowScript(cw)}\n[obRows(R), obForeign(R), obDecom(R)]`, ctx) as string[];
    ok(out[0] === renderRows(report, cw), `[mirror] the client row renderer matches the server one (${which})`);
    ok(out[1] === renderForeign(report, cw), `[mirror] and the foreign block (${which})`);
    ok(out[2] === renderDecommission(report), `[mirror] and the decommission callout (${which})`);
  }
  }
}

// ── account mentions are never links ───────────────────────────────────────────────────────────────────
// OneBill's web UI does not render its account-summary route when opened from outside the app (a
// spinner, then a blank page — a reload does not recover it), so an account number is plain text in
// every place it appears: the row's own cell, a split parent's sited claimants, a foreign row, the
// decommission callout, and the account panel head. Both copies.
{
  const splitReport: LinkReport = { ...REPORT(),
    rows: [{ domain: 'wonka.example', state: 'split', accounts: [], sites: ['North', 'South'], linkedSites: ['North', 'South'],
      siteAccounts: [{ site: 'North', account: { accountNumber: 'CLI00030', accountName: 'Wonka & North Co', status: 'Active' }, usageHolder: true }], notes: [] }] };
  for (const [what, html] of [
    ['rows', renderRows(REPORT(), true)], ['split rows', renderRows(splitReport, true)],
    ['foreign', renderForeign(REPORT(), true)], ['decommission', renderDecommission(REPORT())],
    ['client rows', runInNewContext(`${rowScript(true)}\nobRows(R)`, { R: REPORT() }) as string],
  ] as const) {
    ok(!html.includes('<a '), `[links] no account mention is a link (${what})`);
  }
  ok(renderRows(splitReport, true).includes('<span data-account="CLI00030">CLI00030 — Wonka &amp; North Co</span>'),
    '[links] a split parent\'s sited claimant is plain text inside its data-account span');
}

// ── the sortable Domain/Site AND State headers (task 13 part A, task 16) ───────────────────────────────
{
  const html = onebillHtml({ canWrite: true, version: '0' });
  const script = scriptOf(html);
  ok(html.includes('id="ob-sort-dom-btn"') && html.includes('id="ob-sort-state-btn"'), '[sort] both headers are buttons, not labels');
  // aria-sort/data-sort live on the <th>, not the button (task 13 review addendum item 3). The default
  // sort is now STATE ascending, not Domain (task 17 addendum) — State carries the glyph and attributes.
  ok(/<th id="ob-sort-state-th" aria-sort="ascending" data-sort="asc">/.test(html),
    '[sort] State starts ascending — conflict, unlinked, split, linked — and the attribute is on the th');
  ok(!/<button[^>]*id="ob-sort-state-btn"[^>]*aria-sort/.test(html) && !/<button[^>]*id="ob-sort-state-btn"[^>]*data-sort/.test(html),
    '[sort] and NOT on the button itself');
  ok(!/<th id="ob-sort-dom-th"[^>]*aria-sort/.test(html) && !/<th id="ob-sort-dom-th"[^>]*data-sort/.test(html),
    '[sort] Domain/Site carries neither attribute while State is the active sort');
  const markup = html.slice(0, html.indexOf('<script>'));
  ok((markup.match(/aria-sort/g) ?? []).length === 1, '[sort] in the markup, only the active header carries aria-sort at all');
  ok(html.includes('class="sortglyph"') && html.includes('▲'), '[sort] with a glyph showing the current direction');
  // Present on the READ-ONLY build too — sorting is a display concern, not a write.
  ok(scriptOf(onebillHtml({ canWrite: false, version: '0' })).includes('function obSortGroups('),
    '[sort] obSortGroups ships to a reader without onebill.write too');
  ok(/var OB_SORT=\{key:'state',dir:\{domain:'asc',state:'asc'\}\}/.test(script), '[sort] the primary key defaults to state, direction tracked per key, both starting ascending');
  ok(script.includes('OB_SORT=obSortNext(OB_SORT,key)'), '[sort] a click on either header advances the shared, pure state transition');
  ok(script.includes("OB_SORT_THS[obsi].btn.addEventListener('click'"), '[sort] and re-renders the last report');

  // obSortGroups itself: asc/desc, case-insensitive, groups intact — a domain's site rows never
  // reorder relative to EACH OTHER, only which domain's group comes before which.
  const rows = [
    { domain: 'Bravo.example', state: 'linked' }, { domain: 'alpha.example', state: 'linked' },
    { domain: 'Charlie.example', state: 'linked' }, { domain: 'Charlie.example', site: 'zulu', state: 'linked' }, { domain: 'Charlie.example', site: 'Alpha', state: 'linked' },
  ];
  const sortRun = (key: string, dir: string): string[] => (runInNewContext(`${rowScript(true)}\nobSortGroups(R,K,D)`, { R: rows, K: key, D: dir }) as { domain: string; site?: string }[])
    .map((r) => `${r.domain}${r.site ? '/' + r.site : ''}`);
  ok(sortRun('domain', 'asc').join('|') === 'alpha.example|Bravo.example|Charlie.example|Charlie.example/zulu|Charlie.example/Alpha',
    `[sort] domain ascending is case-insensitive, and never reorders a group's own rows (${sortRun('domain', 'asc').join('|')})`);
  ok(sortRun('domain', 'desc').join('|') === 'Charlie.example|Charlie.example/zulu|Charlie.example/Alpha|Bravo.example|alpha.example',
    `[sort] domain descending reverses the GROUP order only — Charlie's own two site rows stay zulu-then-Alpha (${sortRun('domain', 'desc').join('|')})`);

  // State asc = conflict, unlinked, split, linked (the rank a reseller acts in); desc reverses it.
  // Secondary is ALWAYS domain A→Z, in both directions — groups move as a unit keyed by the PARENT's state.
  const stateRows = [
    { domain: 'zulu.example', state: 'linked' },
    { domain: 'bravo.example', state: 'conflict' },
    { domain: 'alpha.example', state: 'split' }, { domain: 'alpha.example', site: 'HQ', state: 'linked' },
    { domain: 'delta.example', state: 'unlinked' },
    { domain: 'charlie.example', state: 'conflict' },
  ];
  const stateRun = (dir: string): string[] => (runInNewContext(`${rowScript(true)}\nobSortGroups(R,'state',D)`, { R: stateRows, D: dir }) as { domain: string; site?: string }[])
    .map((r) => `${r.domain}${r.site ? '/' + r.site : ''}`);
  ok(stateRun('asc').join('|') === 'bravo.example|charlie.example|delta.example|alpha.example|alpha.example/HQ|zulu.example',
    `[sort] state ascending is conflict, unlinked, split, linked, tying within a state by domain (${stateRun('asc').join('|')})`);
  ok(stateRun('desc').join('|') === 'zulu.example|alpha.example|alpha.example/HQ|delta.example|bravo.example|charlie.example',
    `[sort] state descending reverses only the STATE order — the two conflicts still tie domain A→Z, not Z→A (${stateRun('desc').join('|')})`);

  // Wired into render(): a report with un-sorted rows (as if a cache predated this feature, or the
  // server's own order changed) still draws grouped and ascending on first render.
  const messy: LinkReport = { ...REPORT(), rows: [...REPORT().rows].reverse() };
  ok(renderRows(REPORT(), true) !== renderRows(messy, true), '[sort] (sanity: reversing the fixture actually changes the server-rendered order)');

  // obSortNext: the pure header-click state transition the page wires to both buttons. A different key
  // becomes active without touching direction; the SAME key toggles its own direction, so switching away
  // and back restores whatever toggle was left, rather than resetting to ascending.
  const next = (state: unknown, key: string): { key: string; dir: { domain: string; state: string } } =>
    runInNewContext(`${rowScript(true)}\nobSortNext(S,K)`, { S: state, K: key }) as never;
  const s0 = { key: 'domain', dir: { domain: 'asc', state: 'asc' } };
  const s1 = next(s0, 'state');
  ok(JSON.stringify(s1) === JSON.stringify({ key: 'state', dir: { domain: 'asc', state: 'asc' } }), `[sort] clicking State makes it the active key, direction untouched (${JSON.stringify(s1)})`);
  const s2 = next(s1, 'domain');
  ok(JSON.stringify(s2) === JSON.stringify({ key: 'domain', dir: { domain: 'asc', state: 'asc' } }), `[sort] and clicking Domain after State restores the domain sort, still ascending (${JSON.stringify(s2)})`);
  const s3 = next(s2, 'domain');
  ok(JSON.stringify(s3) === JSON.stringify({ key: 'domain', dir: { domain: 'desc', state: 'asc' } }), `[sort] clicking the ACTIVE key again toggles only that key's own direction (${JSON.stringify(s3)})`);
  ok(JSON.stringify(s0) === JSON.stringify({ key: 'domain', dir: { domain: 'asc', state: 'asc' } }), '[sort] obSortNext never mutates the state it was handed');

  // The filter (task 11), inline marks (task 13) and the toast are unconditional in render() — none of
  // them branch on which key sorted the rows, so a State sort cannot silently disable any of them.
  ok(script.includes('obApplyFilter()') && script.includes('obSortGroups(rep.rows'), '[sort] the filter still runs on every render, State-sorted or not');
  ok(script.includes('obPaintApplied()') && script.includes('OB_SORT.key'), '[sort] inline applied-marks still paint on every render');
  ok(script.includes('obToastShow') && !/OB_SORT\.key===['"]state['"]/.test(script), '[sort] the apply toast has no dependency on the active sort key');
}

// ── obPaintApplied: correlates by data-account, not by array index (task 13 addendum) ──────────────────
// A client-side re-sort can put the rendered <tr>s in a different order than rep.rows — an index zip
// would then paint a result onto the WRONG row. This drives obPaintApplied directly against a hand-built
// DOM shim whose rows are in a different order than the results array, and asserts the marks land on the
// right accounts and nowhere else.
{
  const makeEl = (tag: string, attrs: Record<string, string>): any => {
    const el: any = {
      tag, attrs: { ...attrs }, children: [] as any[], html: '',
      getAttribute(n: string) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
      setAttribute(n: string, v: string) { this.attrs[n] = v; },
      querySelector(sel: string) {
        if (sel === 'td.act') return this.children.find((c: any) => c.tag === 'td' && c.attrs.class === 'act') ?? null;
        return null;
      },
      closest(sel: string) {
        if (sel === 'tr') { let n = this; while (n && n.tag !== 'tr') n = n.parent; return n ?? null; }
        return null;
      },
      set innerHTML(v: string) { this.html = v; },
      get innerHTML() { return this.html; },
    };
    return el;
  };
  // tr1 = CLI00002 (will get a result), tr2 = CLI00003 (no result) — but tr1 is rendered SECOND, and its
  // account is the SECOND element document.querySelectorAll('[data-account]') returns. An implementation
  // that zipped the i-th result onto the i-th matching element, instead of looking up by data-account
  // identity, would pair the (only) result with the FIRST element — tr2's — and fail every assertion below.
  const act1 = makeEl('td', { class: 'act' });
  const acctSpan1 = makeEl('span', { 'data-account': 'CLI00002' });
  const tr1 = makeEl('tr', { 'data-state': 'linked' });
  tr1.children = [acctSpan1, act1]; acctSpan1.parent = tr1; act1.parent = tr1;

  const act2 = makeEl('td', { class: 'act' });
  const acctSpan2 = makeEl('span', { 'data-account': 'CLI00003' });
  const tr2 = makeEl('tr', { 'data-state': 'linked' });
  tr2.children = [acctSpan2, act2]; acctSpan2.parent = tr2; act2.parent = tr2;

  // tr2 (no result) FIRST, tr1 (the result) SECOND — the result must land on the SECOND <tr>.
  const allSpans = [acctSpan2, acctSpan1];
  const fakeDocument = {
    querySelectorAll(sel: string) { return sel === '[data-account]' ? allSpans : []; },
  };

  // ROW_BASE itself declares `var OB_APPLIED={}` at top level, which — inside a vm context — assigns
  // the context's global OB_APPLIED and would clobber a value handed in via the sandbox object before
  // the script runs. So the fixture rides in under its own name and is assigned AFTER the script loads.
  const ctx: Record<string, unknown> = {
    document: fakeDocument,
    OB_APPLIED_IN: {
      CLI00002: { ok: true, accountNumber: 'CLI00002', created: 1 },
      // CLI00003 gets NO result — it must be left alone.
    },
  };
  runInNewContext(`${rowScript(true)}\nOB_APPLIED=OB_APPLIED_IN;\nobPaintApplied()`, ctx);
  ok(act1.innerHTML === '<span class="applied">✓ linked</span>', '[paint] the account that has a result is marked, found by data-account');
  ok(act2.innerHTML === '', '[paint] the account with no result is untouched');

  // A failure paints its own reason, and a row is never marked twice even if it carries the account in
  // more than one place (a linked row's account span AND its editor div both name the same account).
  const editorDiv = makeEl('div', { 'data-account': 'CLI00002', 'data-role': 'editor' });
  editorDiv.parent = tr1; tr1.children.push(editorDiv);
  const ctx2: Record<string, unknown> = {
    document: { querySelectorAll: (sel: string) => (sel === '[data-account]' ? [acctSpan1, editorDiv] : []) },
    OB_APPLIED_IN: { CLI00002: { ok: false, accountNumber: 'CLI00002', error: 'boom' } },
  };
  act1.innerHTML = '';
  delete tr1.attrs['data-oba-marked']; // a fresh render never carries the PREVIOUS render's mark
  runInNewContext(`${rowScript(true)}\nOB_APPLIED=OB_APPLIED_IN;\nobPaintApplied()`, ctx2);
  ok(act1.innerHTML === '<span class="applied bad">✗ failed: boom</span>', '[paint] a failure names why');
  ok((act1.innerHTML.match(/applied/g) ?? []).length === 1, '[paint] and the row is marked exactly once, despite two mentions of its account');
}

// ── the filter box (task 11 item 1) ─────────────────────────────────────────────────────────────────
// obRowMatches decides whether ONE row matches, in isolation; the grouping rule (a site row follows its
// split parent unless it matches on its own) lives in the client-only obApplyFilter and is not part of
// this pure helper's contract.
{
  const fakeTd = (text: string): { textContent: string } => ({ textContent: text });
  const fakeRow = (tgt: string, acct: string): { querySelectorAll: (sel: string) => unknown[] } => ({
    querySelectorAll: (sel: string) => (sel === 'td' ? [fakeTd(tgt), fakeTd(''), fakeTd(acct), fakeTd('')] : []),
  });
  const matches = (tgt: string, acct: string, q: string): boolean =>
    runInNewContext(`${rowScript(true)}\nobRowMatches(ROW,Q)`, { ROW: fakeRow(tgt, acct), Q: q }) as boolean;

  ok(matches('acme.example', 'CLI00001 — Acme', 'acme.example') === true, '[filter] a domain match');
  ok(matches('umbrella.example / Lab', '—', 'lab') === true, '[filter] a site-only match, case-insensitive');
  ok(matches('acme.example', 'CLI00001 — Acme', 'CLI00001') === true, '[filter] an account-number match');
  ok(matches('acme.example', 'CLI00001 — Acme', 'acme') === true, '[filter] an account-NAME match');
  ok(matches('acme.example', 'CLI00001 — Acme', 'globex') === false, '[filter] no match on either cell fails');
  ok(matches('acme.example', 'CLI00001 — Acme', '') === true, '[filter] an empty query matches every row');
  ok(matches('acme.example', 'CLI00001 — Acme', '  ') === true, '[filter] and so does one that is only whitespace');

  const html = onebillHtml({ canWrite: true, version: '0' });
  const script = scriptOf(html);
  ok(html.includes('id="ob-filter"') && html.includes('type="search"'), '[filter] the search box is on the page');
  ok(html.includes('Filter domain, site, or account'), '[filter] labelled for what it searches, short enough to read whole');
  ok(html.includes('id="ob-filter-count"'), '[filter] and a place to say how many rows match');
  ok(script.includes("addEventListener('input',obApplyFilter)"), '[filter] typing filters as you go — no debounce at this size');
  ok(/addEventListener\('keydown'[\s\S]*?Escape[\s\S]*?elFilter\.value=''/.test(script), '[filter] Escape clears it');
  ok(script.includes('obApplyFilter()'), '[filter] and the render path re-applies it, so a Refresh does not forget what was typed');
  // The same box exists — unconditionally — on the read-only build too: filtering is a read, not a write.
  ok(scriptOf(onebillHtml({ canWrite: false, version: '0' })).includes('elFilter'),
    '[filter] the filter box is not gated on onebill.write');

  // The grouping rule, run for real against the actual rows: a split parent that fails to match should
  // still show a site row that matches on its own, and hide one that does not (and does not match the
  // parent either).
  const report = REPORT();
  const rowsHtml = renderRows(report, true);
  const runFilter = (q: string): { domain: string; state: string; hidden: boolean }[] => runInNewContext(
    `${rowScript(true)}
    var doc={rows:ROWS,cur:0};
    function mkTd(t){return {textContent:t}}
    function parseRow(html){
      var stateM=/data-state="([^"]*)"/.exec(html),domM=/data-domain="([^"]*)"/.exec(html);
      var cells=html.split('<td').slice(1).map(function(c){return c.replace(/^[^>]*>/,'').replace(/<\\/td>$/,'')});
      return {state:stateM?stateM[1]:'',domain:domM?domM[1]:'',
        querySelectorAll:function(sel){return sel==='td'?[mkTd(cells[0]||''),mkTd(cells[1]||''),mkTd(cells[2]||''),mkTd(cells[3]||'')]:[]},
        getAttribute:function(n){if(n==='data-state')return stateM?stateM[1]:null;if(n==='data-domain')return domM?domM[1]:null;return null}}}
    var rows=ROWS.map(parseRow);
    var groupDomain=null,groupVisible=false,out=[];
    for(var i=0;i<rows.length;i++){var row=rows[i],dom=row.getAttribute('data-domain')||'',self=obRowMatches(row,Q),vis;
      if(row.getAttribute('data-state')==='split'){groupDomain=dom;groupVisible=self;vis=self}
      else if(dom&&dom===groupDomain){vis=self||groupVisible}
      else{groupDomain=null;groupVisible=false;vis=self}
      out.push({domain:dom,state:row.state,hidden:!vis})}
    out`,
    { ROWS: rowsHtml.split('<tr ').slice(1).map((s) => `<tr ${s}`), Q: q },
  ) as never;

  const byQuery = runFilter('stark');
  const starkRows = byQuery.filter((r) => r.domain === 'stark.example');
  ok(starkRows.every((r) => !r.hidden), '[filter] a query matching the split parent shows every site row under it too');

  // The rule runs one way only: a site row rides on its PARENT's match, not the reverse — a query that
  // matches only the child's own account hides the parent (it does not match, on its own terms) while
  // still showing the child that does.
  const byHq = runFilter('CLI00006');
  const parent = byHq.find((r) => r.domain === 'stark.example' && r.state === 'split');
  const child = byHq.find((r) => r.domain === 'stark.example' && r.state === 'linked');
  ok(parent && parent.hidden, '[filter] a query matching only the site account\'s own row does not drag the parent along');
  ok(child && !child.hidden, '[filter] but the matching site row itself still shows');

  const byMiss = runFilter('nonexistent-client-xyz');
  ok(byMiss.every((r) => r.hidden), '[filter] a query matching nothing hides every row, parents included');
}

// ── the busy overlay (task 11 item 2) ───────────────────────────────────────────────────────────────
{
  const html = onebillHtml({ canWrite: true, version: '0' });
  const script = scriptOf(html);
  ok(html.includes('id="ob-busy"') && /id="ob-busy"[^>]*hidden/.test(html), '[busy] the overlay starts hidden');
  ok(html.includes('Loading… this can take a little while.'), '[busy] and names what the reader is waiting on');
  ok(/class="spinner"/.test(html), '[busy] a spinner element rides inside it');
  ok(/@keyframes ob-spin/.test(html), '[busy] with a keyframe animation defined');
  ok(/@media \(prefers-reduced-motion: reduce\)[^}]*\{[^}]*\.spinner[^}]*animation *: *none/.test(html.replace(/\s+/g, ' ')),
    '[busy] and reduced motion turns the spin off, leaving a static ring');
  ok(html.includes('.busy {') && /position *: *fixed/.test(html), '[busy] the overlay itself is fixed and centered');

  ok(script.includes('function obBusy('), '[busy] one function toggles it, called from one place');
  ok(/obLoad[\s\S]*?obBusy\(true,/.test(script), '[busy] a load — first render or Refresh — shows it before asking');
  ok(script.includes('rb.disabled=v'), '[busy] and the Refresh button is disabled while it is up');
  ok(/obBusy\(false\)/.test(script), '[busy] the deliver path hides it again once a reply lands');
  // Success and unavailable both count as "landed" — the overlay hides before either branch runs, not
  // only on the happy path.
  const deliverBody = script.slice(script.indexOf('function deliver('), script.indexOf('function deliver(') + 400);
  ok(deliverBody.indexOf('obBusy(false)') < deliverBody.indexOf("v.unavailable){failLoad"),
    '[busy] the overlay is cleared before the unavailable branch runs, not only on success');

  // On for a fresh load AND a Refresh, WITH ITS OWN WORDS for each (task 12 addendum): the overlay must
  // not just be up, it must say what is happening — "Loading…" vs "Reloading the report…".
  const obLoadBody = script.slice(script.indexOf('function obLoad('), script.indexOf('function obLoad(') + 400);
  ok(obLoadBody.includes("obBusy(true,OB_MODE==='full'?'Verifying every OneBill account…':(refresh?'Reloading the report…':'Loading…'))"),
    `[busy] obLoad shows it with per-phase text — first load, Refresh, and the verify each say their own thing (${obLoadBody})`);

  // An apply now shows the SAME overlay, with its own text — task 12's addendum: a write that goes
  // quiet until the whole page reloads reads as though nothing happened.
  const obSendBody = script.slice(script.indexOf('function obSend('), script.indexOf('function obSend(') + 120);
  ok(obSendBody.includes("obBusy(true,'Writing to OneBill…')"), `[busy] obSend shows the overlay with its own words (${obSendBody})`);
}

// ── the apply toast + row marks (task 12 item 4 + addendum) ────────────────────────────────────────────
{
  const html = onebillHtml({ canWrite: true, version: '0' });
  const script = scriptOf(html);

  ok(html.includes('id="ob-toast"'), '[toast] the toast container is on the page');
  const flat = html.replace(/\s+/g, ' ');
  ok(/#ob-toast\s*\{[^}]*position\s*:\s*fixed[^}]*top\s*:\s*0/.test(flat), '[toast] positioned fixed, at the top of the viewport');
  ok(/#ob-toast\s*\{[^}]*z-index\s*:\s*50/.test(flat),
    '[toast] and stacked ABOVE the busy overlay (z-index 40), so a reload cannot bury it');
  ok(/#ob-toast\.ok\s*\{[^}]*border-top-color\s*:\s*var\(--green\)/.test(flat), '[toast] all-ok gets the green edge');
  ok(/#ob-toast\.bad\s*\{[^}]*border-top-color\s*:\s*var\(--red\)/.test(flat), '[toast] and any failure gets the red edge');

  ok(script.includes('function obToastShow('), '[toast] one function shows it');
  ok(script.includes('toast-x'), '[toast] with a dismiss control');

  // Success schedules the auto-dismiss; failure does not — a failure that vanishes on its own is one the
  // reader may not have finished reading.
  const showBody = script.slice(script.indexOf('function obToastShow('), script.indexOf('function obToastShow(') + 500);
  ok(/if\(ok\)obToastTimer=setTimeout\(obToastHide,8000\)/.test(showBody), `[toast] the timer is set only when ok is truthy (${showBody})`);

  // Ordering: the toast renders BEFORE the re-read starts, so a reader sees the outcome immediately
  // rather than after the whole report has reloaded.
  const showResultsBody = script.slice(script.indexOf('function showResults('), script.indexOf('function deliver('));
  ok(showResultsBody.indexOf('obToastShow(') < showResultsBody.indexOf('obLoad(false,OB_MODE)'),
    '[toast] the results toast is shown before the re-read that follows it');
  ok(showResultsBody.includes('obLoad(false,OB_MODE)'),
    '[toast] and that re-read reads the CACHE in the mode on screen — the route patched the written accounts into it, so a refresh here would pay for the whole sweep again');

  // obAppliedMark: the three shapes named in the brief.
  const mark = (r: unknown): string => runInNewContext(`${rowScript(true)}\nobAppliedMark(R)`, { R: r }) as string;
  ok(mark({ ok: true, accountNumber: 'CLI1', removed: 1 }) === '<span class="applied">✓ 1 removed</span>', '[applied] a removal counts what it removed');
  ok(mark({ ok: true, accountNumber: 'CLI1', created: 1 }) === '<span class="applied">✓ linked</span>', '[applied] a creation reads as linked');
  ok(mark({ ok: true, accountNumber: 'CLI1', updated: 1 }) === '<span class="applied">✓ updated</span>', '[applied] an update says so');
  ok(mark({ ok: false, accountNumber: 'CLI1', error: 'boom' }) === '<span class="applied bad">✗ failed: boom</span>', '[applied] a failure names why');
  ok(mark({ ok: false, accountNumber: 'CLI1' }) === '<span class="applied bad">✗ failed: OneBill gave no reason.</span>',
    '[applied] and a reasonless failure still says something');
}

// ── the kit-side verdict sentence is gone — the library's own finding says it now (task 11 item 3) ──
{
  const js = onebillHtml({ canWrite: true, version: '0.0.0' });
  ok(!js.includes('obVerdictText'), '[usage] no verdict-to-sentence helper ships anymore');
  ok(!js.includes("subscription on this account has that domain as its identifier"), '[usage] and none of its sentence fragments linger');
}

// ── retries surfaced in the header line (task 11 item 5) ───────────────────────────────────────────
{
  const script = scriptOf(onebillHtml({ canWrite: true, version: '0' }));
  ok(/rep\.requestCount\|\|0\)\+' upstream requests'\+\(\(rep\.retried\|\|0\)>0\?' \('\+rep\.retried\+' retried\)':''\)/.test(script),
    '[retries] the header appends "(N retried)" only when retried is greater than zero');

  // Evaluated for real — the same expression the script computes, run for both inputs — rather than
  // trusted from the regex above: 155 requests / 2 retried is the exact reader-facing string from the
  // brief, and a clean sweep must say nothing extra about retries.
  const headerLine = (rep: { requestCount: number; retried?: number }): string =>
    runInNewContext('(rep.requestCount||0)+\' upstream requests\'+((rep.retried||0)>0?\' (\'+rep.retried+\' retried)\':\'\')', { rep });
  ok(headerLine({ requestCount: 155, retried: 2 }) === '155 upstream requests (2 retried)',
    '[retries] "155 upstream requests (2 retried)" is exactly what a sweep with retries reads');
  ok(headerLine({ requestCount: 40, retried: 0 }) === '40 upstream requests',
    '[retries] and a clean sweep says nothing about retries at all');
}

// ── obTransient: which failures say a Refresh might help (task 11 item 4) ──────────────────────────
// A 4xx and an in-band-at-200 error are OneBill's ANSWER — a Refresh repeats the exact same question and
// gets the exact same answer, so offering it there would be a button that never helps.
{
  const transient = (m: string): boolean => runInNewContext(`${rowScript(true)}\nobTransient(M)`, { M: m }) as boolean;
  ok(transient('GET /rest/SubscriberService/v1/subscribers/CLI00001 -> 525: error code: 525') === true,
    '[transient] a 525 in the "-> STATUS" shape reads as transient');
  ok(transient('GET /rest/SubscriberService/v1/subscribers/CLI00001 -> 400: Bad Request') === false,
    '[transient] a 400 does not — it is the account\'s own answer, not an upstream hiccup');
  ok(transient('GET /rest/SubscriberService/v1/subscribers/CLI00001 -> 200: Bad Request') === false,
    '[transient] an in-band error reported at HTTP 200 is not transient either');
  ok(transient('fetch failed') === true, '[transient] a network-shaped message (fetch failed) reads as transient');
  ok(transient('The connection timed out') === true, '[transient] "timed out" reads as transient');
  ok(transient('') === false, '[transient] an empty message is not transient');

  // Wired into the failure cards: gated on the failure's own message, not applied unconditionally.
  const script = scriptOf(onebillHtml({ canWrite: true, version: '0' }));
  ok(script.includes('This is a transient API error; a Refresh may clear it.'), '[transient] the render path carries the hint text');
  ok(script.includes('obTransient(fs[k].message)'), '[transient] and gates it on the failure\'s own message');
}

// ── opening pre-filtered to the current domain (task 14) ───────────────────────────────────────────
// The route (worker.ts) is what validates ?domain= against the caller's visible domain set; this page
// only has to (a) render the value it is HANDED into an attribute-escaped data-prefilter, and only when
// present, and (b) on load, read it back, set the filter box, apply it, and show the "Showing … — Show
// all" line whose link clears it.
{
  const noPre = onebillHtml({ canWrite: true, version: '0' });
  ok(!/<body[^>]*\bdata-prefilter=/.test(noPre), '[prefilter] absent at the top level — no data-prefilter attribute on <body> at all');

  const withPre = onebillHtml({ canWrite: true, version: '0', prefilter: 'acme.example' });
  ok(/<body[^>]*\bdata-prefilter="acme\.example"/.test(withPre), '[prefilter] rendered on <body> when the doc carries one');

  // Attribute-escaped — a domain is never validated for HTML-safe characters upstream, so the page must
  // not trust it is already safe.
  const withQuote = onebillHtml({ canWrite: true, version: '0', prefilter: 'a"b<c' });
  ok(withQuote.includes('data-prefilter="a&quot;b&lt;c"'), '[prefilter] escaped into the attribute, not trusted raw');
  ok(!withQuote.includes('data-prefilter="a"b<c"'), '[prefilter] and the raw (unescaped) form is not present');

  // Present regardless of canWrite — filtering is a read, same as the box itself.
  const roWithPre = onebillHtml({ canWrite: false, version: '0', prefilter: 'acme.example' });
  ok(roWithPre.includes('data-prefilter="acme.example"'), '[prefilter] not gated on onebill.write');

  ok(withPre.includes('id="ob-prefilter"') && withPre.includes('id="ob-prefilter-dom"') && withPre.includes('id="ob-prefilter-clear"'),
    '[prefilter] the "Showing … — Show all" line is on the page');
  ok(/id="ob-prefilter"[^>]*\bhidden\b/.test(withPre), '[prefilter] and starts hidden — the client shows it only when a prefilter actually applies');

  const script = scriptOf(withPre);
  ok(script.includes("document.body.getAttribute('data-prefilter')"), '[prefilter] the client reads it back off <body>');
  ok(/OB_PRE&&elFilter\)\{elFilter\.value=OB_PRE;obApplyFilter\(\)/.test(script),
    '[prefilter] on load: the filter box is set to it and the filter is applied');
  ok(/elPreDom\)elPreDom\.textContent=OB_PRE/.test(script), '[prefilter] the line names which domain');
  ok(/elPre\)elPre\.hidden=false/.test(script), '[prefilter] and the line is revealed');
  ok(/elPreClear\.addEventListener\('click'[\s\S]*?elFilter\.value=''[\s\S]*?obApplyFilter\(\)[\s\S]*?elPre\.hidden=true/.test(script),
    '[prefilter] "Show all" clears the filter, re-applies it, and hides the line again');
}

// ── the two loads: quick by default, the audit on demand (task 15) ──────────────────────────────────
{
  const html = onebillHtml({ canWrite: true, version: '0' });
  const script = scriptOf(html);

  ok(html.includes('id="ob-refresh"') && html.includes('>Refresh</button>'), '[modes] the Refresh button is the quick one');
  ok(html.includes('id="ob-verify"') && html.includes('>Refresh and fully verify</button>'), '[modes] and a second button asks for the audit pass');
  ok(html.indexOf('id="ob-refresh"') < html.indexOf('id="ob-verify"'), '[modes] the cheap one comes first — it is what a reader wants nine times in ten');
  ok(/id="ob-refresh" class="btn primary"/.test(html) && /id="ob-verify" class="btn"/.test(html),
    '[modes] and only the cheap one is the primary control');

  ok(/rb\.addEventListener\('click',function\(\)\{OB_APPLIED=\{\};obLoad\(true,'quick'\)\}\)/.test(script), '[modes] Refresh re-reads in quick mode');
  ok(/vb\.addEventListener\('click',function\(\)\{OB_APPLIED=\{\};obLoad\(true,'full'\)\}\)/.test(script), '[modes] and the verify button in full');
  ok(script.includes("obLoad(false,'quick')"), '[modes] the first load of the page is a quick one');
  ok(script.includes('if(vb)vb.disabled=v'), '[modes] both buttons are disabled while anything is in flight');

  // The headline. Two shapes, and the quick one has two: verified once, or never.
  const head = (rep: unknown, now: number): string =>
    runInNewContext(`${rowScript(false)}\nobHeadline(R,N,function(s){return 'AT '+s})`, { R: rep, N: now }) as string;
  const t0 = Date.parse('2026-09-03T12:00:00.000Z');
  ok(head({ mode: 'full', generatedAt: '2026-09-03T11:00:00.000Z' }, t0) === 'Generated AT 2026-09-03T11:00:00.000Z',
    '[headline] a full report says when it was generated, in the reader\'s own local format');
  ok(head({ mode: 'quick', generatedAt: '2026-09-03T12:00:00.000Z', verifiedAt: '2026-09-03T11:00:00.000Z' }, t0)
    === 'Quick view · links from the OneBill index · usage last verified 1 hour ago',
    '[headline] a quick one says where its links came from and how old the usage is');
  ok(head({ mode: 'quick', generatedAt: '2026-09-03T12:00:00.000Z', verifiedAt: null }, t0)
    === 'Quick view · links from the OneBill index · not yet verified',
    '[headline] and says so plainly when nothing has ever verified it');
  ok(head({}, t0) === 'Generated AT undefined', '[headline] a report with no mode at all reads as the full one it used to be');

  const ago = (iso: string, now: number): string => runInNewContext(`${rowScript(false)}\nobAgo(I,N)`, { I: iso, N: now }) as string;
  ok(ago('2026-09-03T11:59:31.000Z', t0) === 'just now', '[ago] under a minute is not a count of seconds');
  ok(ago('2026-09-03T11:59:00.000Z', t0) === '1 minute ago', '[ago] singular at one');
  ok(ago('2026-09-03T11:56:00.000Z', t0) === '4 minutes ago', '[ago] plural after');
  ok(ago('2026-09-03T09:00:00.000Z', t0) === '3 hours ago', '[ago] hours');
  ok(ago('2026-08-31T12:00:00.000Z', t0) === '3 days ago', '[ago] and days');
  ok(ago('not a date', t0) === '', '[ago] an unparseable stamp says nothing rather than "NaN minutes ago"');

  // The row stamp: a quick row is drawn from the derived index and carries a marker saying so.
  const quick: LinkReport = { ...REPORT(), mode: 'quick', verifiedAt: null, usageStale: true };
  const qr = renderRows(quick, true);
  ok((qr.match(/data-unverified="1"/g) ?? []).length === quick.rows.length,
    '[unverified] every quick row is stamped, once each');
  ok(!renderRows(REPORT(), true).includes('data-unverified'), '[unverified] and a full report stamps none of them');
  ok(runInNewContext(`${rowScript(true)}\nobRows(R)`, { R: quick }) === qr, '[unverified] the client copy stamps them identically');

  // The confirmation says the row may be a little behind AND that the record is re-read before writing —
  // the reassurance is the second half, and it is the half that is actually load-bearing.
  const unv = (rep: unknown): string => runInNewContext(`var OB_LAST_REP=R;${rowScript(true)}\nobUnv()`, { R: rep }) as string;
  ok(unv({ mode: 'quick' }) === "\n\n(quick view — this account's record is re-read before writing)",
    '[confirm] a quick view adds the note to every confirmation');
  ok(unv({ mode: 'full' }) === '', '[confirm] a verified one adds nothing');
  ok(unv(null) === '', '[confirm] and neither does a page with no report yet');
}


// ── the account detail panel ────────────────────────────────────────────────────────────────────────
// One account's report, with a row of every verdict — a match, an unexplained gap, a recorded one, and a
// baseline the live count has moved away from — so the panel is exercised on every branch it has. Each
// row also exercises one shape of item list: none at all (devices), all unreviewed (seats, numbers), all
// accepted (transcription), and the mixed one a drift verdict is made of (locations).
const NAMES = ['Ann Lee', 'Bo Chen', 'Cy Diaz', 'Dee Fox', 'Eli Gray', 'Fay Hall',
  'Gil Iyer', 'Hana Jones', 'Ivo Kim', 'Jo Lane', 'Kit Moss', 'Lou Nash'];
/** The twelve extensions behind `extensions.total`, five of them with transcription on. */
const EXTS = NAMES.map((name, i) => ({
  key: `ext:${100 + i}`, ext: String(100 + i), name, site: i < 6 ? 'North' : 'South',
  scope: i < 10 ? 'Basic User' : 'Office Manager', serviceCode: i < 4 ? '' : 'premium',
  transcription: i < 5, teams: false, deviceCount: 1, deviceModels: ['Model A'], anyDevice: true,
}));
/** Fourteen numbers, the first two toll-free — so the detail column has both kinds to name. */
const DIDS = Array.from({ length: 14 }, (_, i) => {
  const number = `+1555010${String(i).padStart(2, '0')}`;
  return { key: `did:${number}`, number, kind: i < 2 ? 'tollFree' : 'local' };
});
const DECIDED = { decidedAt: '2026-08-01T00:00:00.000Z', decidedBy: 'ops@example.com' };
const unreviewed = (key: string, label: string) => ({ key, label, status: 'unreviewed' });
/** `offer` is the plan the operator said the item is billed as — absent on an untagged acceptance, which
 *  every acceptance recorded before migration 0004 is. */
const accepted = (key: string, label: string, note?: string, offer?: string) => ({
  key, label, status: 'accepted',
  acceptance: { key, label, ...(offer === undefined ? {} : { offer }), ...(note === undefined ? {} : { note }), ...DECIDED },
});
const ACME_INVENTORY = () => ({
  extensions: { total: 12, byScope: { 'Basic User': 10, 'Office Manager': 2 }, byServiceCode: { '': 4, premium: 8 }, byDeviceCount: { '0': 1, '1': 9, '2': 1, '3+': 1 } },
  systemUsers: { total: 3, byServiceCode: { 'system-aa': 2, 'system-queue': 1 } },
  transcriptionEnabled: 5,
  // 14 DIDs and one fax line: `total` and `all` DIFFER, so the summary's Total is provably reading
  // `all` rather than the DID count that used to be there.
  dids: { total: 14, tollFree: 2, local: 12, fax: 1, all: 15 },
  e911Addresses: 3, smsNumbers: 2,
  devices: { total: 13, byModel: { 'Model A': 9, 'Model B': 4 } },
});
const ACCOUNT = () => ({
  domain: 'acme.example', accountNumber: 'CLI00001', accountName: 'Acme',
  // One whole domain and nothing else: the account holds all of it, so no scope line, no where badge and
  // no "of the domain" totals — the plain shape every assertion below was written against.
  scopes: [{ domain: 'acme.example' }], domains: ['acme.example'],
  // Nobody else holds it either, so no item line offers a Move — the control needs somewhere to move TO.
  holders: { 'acme.example': [{ accountNumber: 'CLI00001', accountName: 'Acme' }] },
  domainTotals: { 'acme.example': ACME_INVENTORY() },
  unassigned: [], partial: false,
  loadedAt: '2026-09-03T12:00:00.000Z',
  inventory: ACME_INVENTORY(),
  detail: {
    extensions: EXTS,
    systemUsers: [],
    dids: DIDS,
    e911Addresses: [{ key: 'addr:a-1', label: 'Head office' }, { key: 'addr:a-2', label: 'Warehouse' }, { key: 'addr:a-3', label: 'Annexe' }],
    smsNumbers: [{ key: 'sms:+15550100', number: '+15550100' }, { key: 'sms:+15550101', number: '+15550101' }],
  },
  // One extension whose device read failed. Its device count is 0 in the inventory above, and that zero
  // is a read error rather than a fact — the panel has to say so beside a device row.
  readFailures: ['107'],
  comparison: {
    examined: 6,
    rows: [
      { group: 'seats', dimension: 'extensions.total', dimensions: ['extensions.total'], billed: 12, observed: 12, verdict: 'match',
        items: EXTS.map((x) => unreviewed(x.key, `${x.ext} ${x.name}`)), unreviewed: 12, stale: 0,
        offers: [{ name: 'Seat Tier One', quantity: 12, perUnit: 1 }] },
      { group: 'numbers', dimension: 'dids.total', dimensions: ['dids.total'], billed: 10, observed: 14, verdict: 'unbaselined',
        items: DIDS.map((d) => unreviewed(d.key, d.number)), unreviewed: 14, stale: 0,
        offers: [{ name: 'Number Pack', quantity: 1, perUnit: 10 }] },
      { group: 'transcription', dimension: 'transcriptionEnabled', dimensions: ['transcriptionEnabled'], billed: 4, observed: 5, verdict: 'accepted',
        items: EXTS.slice(0, 5).map((x) => accepted(x.key, `${x.ext} ${x.name}`)), unreviewed: 0, stale: 0,
        groupRow: { billed: 4, observed: 5, accepted: 5, note: 'one comped', ...DECIDED },
        offers: [{ name: 'Transcription Add-on', quantity: 4, perUnit: 1 }] },
      { group: 'locations', dimension: 'e911Addresses', dimensions: ['e911Addresses'], billed: 1, observed: 3, verdict: 'drift',
        items: [accepted('addr:a-1', 'Head office'), unreviewed('addr:a-2', 'Warehouse'), unreviewed('addr:a-3', 'Annexe'),
          { ...accepted('addr:a-0', 'Old dock'), status: 'stale' }],
        unreviewed: 2, stale: 1,
        groupRow: { billed: 1, observed: 1, accepted: 1, ...DECIDED },
        offers: [{ name: 'Emergency Location', quantity: 1, perUnit: 1 }] },
      // No item list at all: a device count is a number the inventory answers and nothing enumerates,
      // so this row is the one that still needs a whole-group decision, and has nothing to accept but
      // the shortfall.
      { group: 'devices', dimension: 'devices.total', dimensions: ['devices.total'], billed: 12, observed: 13, verdict: 'unbaselined',
        unreviewed: 0, stale: 0, offers: [{ name: 'Handset Rental', quantity: 12, perUnit: 1 }] },
      // A SHORTFALL with items: billed for three, two exist. Both pairs of controls apply at once — the
      // two unreviewed numbers can be accepted as items, and the missing third as a group shortfall.
      { group: 'sms', dimension: 'smsNumbers', dimensions: ['smsNumbers'], billed: 3, observed: 2, verdict: 'unbaselined',
        items: [unreviewed('sms:+15550100', '+15550100'), unreviewed('sms:+15550101', '+15550101')], unreviewed: 2, stale: 0,
        offers: [{ name: 'SMS Enablement', quantity: 3, perUnit: 1 }] },
      // A match row with an EMPTY item list and nothing accepted: nothing unreviewed, nothing accepted,
      // no group row and no gap, so the item conditions offer nothing on their own.
      { group: 'faxlines', dimension: 'faxNumbers', dimensions: ['faxNumbers'], billed: 0, observed: 0, verdict: 'match',
        items: [], unreviewed: 0, stale: 0, offers: [] },
      // A match row with NO item list at all. This one needs the verdict gate: `!r.items` alone reads as
      // "the group row is the only instrument here", which is true, but seven billed against seven
      // counted has no gap for that instrument to record.
      { group: 'ports', dimension: 'sipPorts.total', dimensions: ['sipPorts.total'], billed: 7, observed: 7, verdict: 'match',
        unreviewed: 0, stale: 0, offers: [{ name: 'SIP Port', quantity: 7, perUnit: 1 }] },
      // Item-less AND already judged as a group: the only thing left to undo is the group row. Also the
      // row of two dimensions, one of which this deployment counts nothing at — a rulebook typo looks
      // exactly like a real zero, so the row says which it is.
      { group: 'callpaths', dimension: 'callPaths.total', dimensions: ['callPaths.total', 'callPaths.extra'],
        billed: 4, observed: 0, observedMissing: true, verdict: 'accepted', unreviewed: 0, stale: 0,
        groupRow: { billed: 4, observed: 0, accepted: 0, ...DECIDED },
        offers: [{ name: 'Call Path', quantity: 4, perUnit: 1 }] },
    ],
    unmapped: [{ name: 'Something Unbudgeted', quantity: 2 }],
    ignored: [{ name: 'Fax Line', quantity: 1, rule: 'offer:Fax Line' }],
    catalogMisses: [],
  },
  baselinesEnabled: true, canWrite: true,
});

{
  const rw = renderAccountPanel(ACCOUNT() as never, true);
  ok(rw.includes('acme.example'), '[panel] the header names the domain');
  ok(rw.includes('CLI00001'), '[panel] and the account');
  ok(/chip-match/.test(rw), '[panel] a matching row gets a match chip');
  ok(/chip-unbaselined/.test(rw), '[panel] an unexplained gap is unbaselined');
  ok(/chip-accepted/.test(rw), '[panel] a recorded gap is accepted');
  ok(/chip-drift/.test(rw), '[panel] and a moved count is drift');
  ok(rw.includes('Something Unbudgeted'), '[panel] the unmapped offer is listed');
  ok(rw.includes('Office Manager'), '[panel] the inventory detail lists extensions by scope');
  ok(rw.includes('Model B'), '[panel] and devices by model');
  ok(/toll-free/i.test(rw), '[panel] and splits numbers local and toll-free');
  ok(rw.includes('one comped'), '[panel] an accepted row shows its note');
  // The drift row must show BOTH numbers: "3 now, 1 accepted" is the whole content of the verdict. Read
  // out of LABELLED cells — a bare includes('1') passes on any digit anywhere in the row, the dimension
  // text and the baseline sentence included, so it would pass on a panel that dropped the column.
  const driftRow = rw.split('<tr').find((s) => s.startsWith(' data-verdict="drift"')) ?? '';
  ok(driftRow.includes('data-col="observed">3<'), "[panel] the drift row shows today's count");
  ok(driftRow.includes('data-col="accepted">1<'), '[panel] and the accepted count beside it');

  // ── the item lists ────────────────────────────────────────────────────────────────────────────
  ok(/data-act="toggle-items" data-group="seats"/.test(rw), '[panel] a row with items has a Details toggle');
  ok(!/data-act="toggle-items" data-group="devices"/.test(rw), '[panel] an item-less row has none');
  ok(/<tr class="items" data-items-for="numbers" hidden>/.test(rw), '[panel] the items row is present and hidden');
  ok((rw.match(/data-item-key="did:/g) ?? []).length === 14, '[panel] every number is listed');
  // Counted INSIDE the drift row: "12 unreviewed" on the seats row contains "2 unreviewed", so the same
  // check against the whole panel would pass on a drift row that printed no counts at all.
  ok(/>2 unreviewed</.test(driftRow), '[panel] the drift row counts its unreviewed items');
  ok(/>1 stale</.test(driftRow), '[panel] and its stale ones');
  ok(/data-item-key="addr:a-0" data-status="stale"/.test(rw), '[panel] a stale acceptance is listed as stale');
  ok(/2 new since accepted/.test(rw), '[panel] the drift line says how many are new since the acceptance');
  ok(/1 accepted item no longer exists/.test(rw), '[panel] and how many accepted items have gone');
  ok(!/Billed 1 when accepted, 1 now/.test(rw), '[panel] and does not say the billed count moved when it did not');
  ok(/Ann Lee/.test(rw), '[panel] an extension item shows its name');
  ok(/North/.test(rw), '[panel] and its site');
  ok(/Ignored by rule \(1\)/.test(rw) && /Fax Line/.test(rw), '[panel] ignored offers are listed under their own heading');

  // ── the controls ──────────────────────────────────────────────────────────────────────────────
  ok(/data-act="accept-all" data-group="numbers"/.test(rw), '[panel] an unbaselined row with items offers Accept all');
  ok(/data-act="clear-all" data-group="transcription"/.test(rw) && !/data-act="accept-all" data-group="transcription"/.test(rw),
    '[panel] a fully accepted row offers Clear all only');
  ok(/data-act="accept-shortfall" data-group="devices"/.test(rw), '[panel] an item-less row offers the group-row accept');
  // The label says which STORE, never a quantity ("Accept 2" beside "Accept all 2" is two different
  // writes wearing one label) AND, for the group-row pair, what the group row means on THIS row. The
  // devices row is item-less and over-observed: 13 handsets against 12 billed is not a shortfall, and
  // a button that called it one would be lying about the direction of the gap.
  const devRow = rw.split('<tr').find((s) => s.startsWith(' data-verdict="unbaselined" data-group="devices"')) ?? '';
  ok(devRow !== '', '[panel] the devices row is the item-less over-observed one');
  ok(/data-act="accept-shortfall"[^>]*>Accept count</.test(devRow), '[panel] whose accept is labelled Accept count, not Accept shortfall');
  ok(!/>Accept shortfall</.test(devRow), '[panel] and never the shortfall word, the row having 13 against 12');
  // Items present and a real gap the items cannot explain: that IS a shortfall, and keeps the word.
  const smsRow = rw.split('<tr').find((s) => s.startsWith(' data-verdict="unbaselined" data-group="sms"')) ?? '';
  ok(smsRow !== '', '[panel] the sms row is the one with items AND a shortfall');
  ok(/data-act="accept-shortfall"[^>]*>Accept shortfall</.test(smsRow), '[panel] and it is labelled Accept shortfall');
  ok(/data-act="clear-shortfall"[^>]*>Clear count</.test(rw), '[panel] the item-less group-row clear is labelled Clear count');
  // The word rides on the button so the confirmation can say the same one back.
  ok(/data-act="accept-shortfall"[^>]*data-word="count"/.test(devRow), '[panel] and the devices accept carries data-word="count"');
  ok(/data-act="accept-shortfall"[^>]*data-word="shortfall"/.test(smsRow), '[panel] while the sms one carries data-word="shortfall"');
  // The numbers each confirmation says back, written by the renderer onto the button that will say them.
  ok(/data-act="accept-all" data-group="numbers" data-count="14"/.test(rw), '[panel] accept-all carries its unreviewed count');
  ok(/data-act="clear-all" data-group="transcription" data-count="5"/.test(rw), '[panel] clear-all carries its accepted-item count');
  ok(/data-act="accept-shortfall" data-group="devices" data-billed="12" data-observed="13"/.test(rw),
    '[panel] and accept-shortfall carries the two numbers its sentence names');
  // Both pairs at once. The direction of the gap decides nothing about the item controls: two numbers
  // nobody has reviewed are two numbers nobody has reviewed whether or not a third is missing.
  ok(/data-act="accept-all" data-group="sms"/.test(rw) && /data-act="accept-shortfall" data-group="sms"/.test(rw),
    '[panel] a shortfall row with items offers Accept all AND Accept the shortfall');
  ok(/data-act="accept-item" data-group="sms" data-key="sms:/.test(rw), '[panel] and each of its items has its own Accept');
  ok(/data-act="clear-shortfall" data-group="callpaths"/.test(rw), '[panel] an item-less row already judged offers the group-row clear');
  ok(!/data-act="clear-all" data-group="callpaths"/.test(rw), '[panel] and no Clear all, having no items to clear');
  // A MATCHED row's items are still twelve things nobody has reviewed. Accepting them is what makes a
  // later swap — one seat deleted, one created, the count unchanged — read as drift instead of match,
  // so the control has to be there. Read out of the GROUP row: the items each carry their own Accept.
  const seatsRow = rw.split('<tr').find((s) => s.startsWith(' data-verdict="match" data-group="seats"')) ?? '';
  ok(seatsRow !== '', '[panel] the seats row is a match row');
  ok(/data-act="accept-all" data-group="seats" data-count="12"/.test(seatsRow),
    '[panel] and it offers Accept all for its twelve unreviewed seats, matched or not');
  ok(!/data-act="clear-all" data-group="seats"/.test(seatsRow), '[panel] with no Clear all, nothing having been accepted');
  ok(!/data-act="(accept|clear)-shortfall"/.test(seatsRow), '[panel] and no group-row control, the counts being equal');
  // Two shapes with genuinely nothing to offer. An empty item list — nothing accepted, no group row,
  // no gap — and an item-LESS matched row, which needs the verdict gate: the group-row pair is the only
  // instrument such a row has, and seven against seven gives it nothing to record.
  const faxRow = rw.split('<tr').find((s) => s.startsWith(' data-verdict="match" data-group="faxlines"')) ?? '';
  ok(faxRow !== '', '[panel] the faxlines row is a match row with an empty item list');
  ok(!/data-act="(accept|clear)-/.test(faxRow), '[panel] and it offers no acceptance control at all');
  const portsRow = rw.split('<tr').find((s) => s.startsWith(' data-verdict="match" data-group="ports"')) ?? '';
  ok(portsRow !== '', '[panel] the ports row is a match row with no item list at all');
  ok(!/data-act="(accept|clear)-/.test(portsRow), '[panel] and it offers nothing either - a matched row has no gap to accept');
  ok(!/>Accept count</.test(portsRow), '[panel] specifically not the count control an item-less row would otherwise get');
  ok(/<td class="act"><\/td>/.test(portsRow), '[panel] just the empty controls cell');
  ok(/<td class="act"><\/td>/.test(faxRow), '[panel] just the empty controls cell');
  ok(/data-act="accept-item" data-group="numbers" data-key="did:/.test(rw), '[panel] each unreviewed item has Accept');
  ok(/data-act="clear-item" data-group="transcription" data-key="ext:/.test(rw), '[panel] each accepted item has Clear');

  // ── the rest of the markup contract Task 9 clicks on ──────────────────────────────────────────
  ok(/data-act="toggle-items" data-group="seats" aria-expanded="false"/.test(rw), '[panel] the Details toggle starts collapsed');
  ok(/<tr class="items" data-items-for="seats" hidden><td colspan="6">/.test(rw), '[panel] an items row spans all six columns of the writer table');
  // A row of several dimensions names them all, because the sum is the only thing the observed count
  // explains — and says when one of them counts nothing, which a rulebook typo looks exactly like.
  const cpRow = rw.split('<tr').find((x) => x.startsWith(' data-verdict="accepted" data-group="callpaths"')) ?? '';
  ok(/callPaths\.total \+ callPaths\.extra/.test(cpRow), '[panel] a row of two dimensions names both');
  ok(/counts nothing at that path/.test(cpRow), '[panel] and says so when one of them counts nothing');
  // Four billed against a Live of 0 that means "not counted here". The delta line must NOT read "4
  // billed, not live" — that is a claim about the phone system read off a rulebook typo.
  ok(!/billed, not live/.test(cpRow),
    '[delta] a row whose count path names nothing says no delta - its 0 is "not counted", not "not there"');
  ok(/billed, not live/.test(rw), '[delta] while a row that really is short still says so, so the guard is not silencing everything');

  // ── the Numbers block: Total is every number, and the three under it partition it ──────────────
  ok(rw.includes('<div class="bd"><b>Numbers</b><ul><li>Total - 15</li><li>Toll-free - 2</li><li>Local - 12</li><li>Fax lines - 1</li>'),
    '[inv] Total is dids.all - 14 DIDs plus one fax line - and toll-free + local + fax add up to it');
  ok(!rw.includes('<b>Numbers</b><ul><li>Total - 14</li>'),
    '[inv] never dids.total, which stopped counting fax lines in netsapiens-lib 0.7.0 and would under-report the domain');
  // A report cached before `all` existed still renders the number it used to show, rather than 0.
  const preAll = renderAccountPanel({ ...ACCOUNT(), inventory: { ...ACME_INVENTORY(), dids: { total: 14, tollFree: 2, local: 12 } } } as never, true);
  ok(preAll.includes('<b>Numbers</b><ul><li>Total - 14</li>'), '[inv] and falls back to dids.total where a cached report has no all');

  // ── a read that failed ────────────────────────────────────────────────────────────────────────
  // Named, because the extension's device count is 0 on this report and that 0 is a read error. The
  // extension number alone would pass on any panel — 107 is also one of the twelve seats.
  ok(/Some reads did not complete: 107\. Counts from those reads are not facts - refresh before accepting a gap they touch\./.test(rw),
    '[panel] a swallowed read is named under the header, and the sentence says what to do about it');
  ok(!/Device reads failed/.test(rw), '[panel] and no longer claims it was a device read - the list carries three kinds now');
  ok(!/Some reads did not complete/.test(renderAccountPanel({ ...ACCOUNT(), readFailures: [] } as never, true)),
    '[panel] nothing is said when every read answered');
  // The lines already contain commas of their own, so the joiner has to be something else.
  const threeFails = renderAccountPanel({ ...ACCOUNT(), readFailures: ['a.example: could not be read (503)', 'b.example: devices for 100, 101', 'b.example: SMS for 102'] } as never, true);
  ok(threeFails.includes('Some reads did not complete: a.example: could not be read (503); b.example: devices for 100, 101; b.example: SMS for 102.'),
    '[panel] and the lines join on a semicolon, each already carrying commas');

  const ro = renderAccountPanel(ACCOUNT() as never, false);
  ok(!/data-act="(accept|clear)/.test(ro), '[panel] a reader gets no acceptance control of any kind');
  ok(/data-act="toggle-items"/.test(ro), '[panel] but can still open the item lists');
  ok(/<tr class="items" data-items-for="seats" hidden><td colspan="5">/.test(ro),
    '[panel] whose rows span five columns, the reader table having no controls column');
  ok(!/colspan="6"/.test(ro), '[panel] and no row spans the six the writer table has');

  const noDb = renderAccountPanel({ ...ACCOUNT(), baselinesEnabled: false } as never, true);
  ok(!/data-act="(accept|clear)/.test(noDb), '[panel] no acceptance control when baselines are not configured');
  ok(/not configured/i.test(noDb), '[panel] and one line says why');

  const doc = onebillHtml({ canWrite: true, version: 'test' });
  for (const v of ['match', 'accepted', 'drift', 'unbaselined', 'optional']) {
    ok(doc.includes('.chip-' + v), `[panel] the stylesheet knows .chip-${v} - an unstyled verdict word reads as a rendering bug`);
  }
  for (const v of ['accepted', 'unreviewed', 'stale']) {
    ok(doc.includes('.chip-item-' + v), `[panel] the stylesheet knows .chip-item-${v}`);
  }
  // Task 8 shipped the bridge pairs; this page is what sends them. The exact tag strings, because a
  // renamed tag on one side is a message the other side silently drops.
  ok(doc.includes(SPK_BRIDGE.accountRequest), '[panel] the page sends the account request tag');
  ok(doc.includes('account:load'), '[panel] spelled exactly account:load');
  ok(doc.includes(SPK_BRIDGE.baselineRequest), '[panel] and the baseline request tag');
  ok(doc.includes('baseline:accept'), '[panel] spelled exactly baseline:accept');

  // ── the click handlers ────────────────────────────────────────────────────────────────────────
  // Read out of the SCRIPT, not the document: every control's name is also markup the renderer emits,
  // so a check against the whole document passes on a page that draws the buttons and wires none.
  const wjs = scriptOf(doc);
  const rjs = scriptOf(onebillHtml({ canWrite: false, version: 'test' }));
  ok(/\[data-act="toggle-items"\]/.test(rjs), '[panel js] the toggle handler is wired');
  // aria-expanded="false" is also what the renderer PRINTS, so this is a check on the WRITE: a handler
  // that shows the list without moving the attribute leaves a screen reader saying "collapsed".
  ok(/setAttribute\('aria-expanded'/.test(rjs), '[panel js] and it moves aria-expanded');
  for (const act of ['accept-item', 'clear-item', 'accept-all', 'clear-all', 'accept-shortfall', 'clear-shortfall']) {
    ok(wjs.includes(`button[data-act="${act}"]`), `[panel js] the writer bundle handles ${act}`);
  }
  // NOT !/accept-item/ over the reader's bundle: obItemCtl is shared by both copies (it returns nothing
  // for a reader, which is how the mirror test can run it), so the reader's script knows the WORD. What
  // it must not carry is the handler that SENDS one — the closest() selector is that handler's signature.
  ok(!/button\[data-act="(accept|clear)-/.test(rjs), '[panel js] the reader bundle carries no acceptance handler');
  ok(!/askBaseline/.test(rjs), '[panel js] nor any way to ask for a write');
  ok(/data-act="toggle-items"/.test(rjs), '[panel js] but it does carry the toggle');
  // EVERY group-level control confirms, and every confirmation says back the four things the reader
  // needs to recognise what they are about to do: the group, the OneBill ACCOUNT, the domain, and how
  // many things it touches. One ok() each — an alternation over four sentences passes when three of
  // them are missing.
  ok(/confirm\('Accept all '\+nc\+' unreviewed item'.*\+group\+' for '\+where/.test(wjs),
    '[panel js] accept-all confirms, naming the count, the group and the account');
  ok(/confirm\('Clear all '\+nc\+' accepted item'.*\+group\+' for '\+where/.test(wjs),
    '[panel js] clear-all confirms, naming the count, the group and the account');
  ok(/confirm\('Record '\+ob\+' live as the accepted count for '\+group\+' on '\+where\+', against '\+bi\+' billed\?'\)/.test(wjs),
    '[panel js] accept-shortfall confirms, naming both counts, the group and the account');
  ok(/confirm\('Clear the accepted '\+gw\+' on '\+group\+' for '\+where/.test(wjs),
    '[panel js] clear-shortfall confirms, naming the group and the account');
  // …and using the same word the button did. "Clear the accepted shortfall" under a button labelled
  // "Clear count" would name a gap the row does not have, which is what the relabelling fixed.
  ok(/var gw=t\.getAttribute\('data-word'\)/.test(wjs), '[panel js] the group-row word comes off the button, not from a second derivation');
  // `where` is the account number and the domain together, off the loaded report rather than the DOM.
  ok(/function obConfirmWhere\(\)/.test(wjs), '[panel js] one helper builds what the confirmations name');
  ok(/OB_LAST_ACCOUNT&&OB_LAST_ACCOUNT\.accountNumber/.test(wjs), '[panel js] it reads the account number off the loaded report');
  ok(/var r=OB_LAST_ACCOUNT,a=r&&r\.accountNumber,d=r&&r\.domain/.test(wjs),
    '[panel js] and the domain beside it, so nothing is read out of the page state the panel was opened with');
  ok(/var where=obConfirmWhere\(\)/.test(wjs), '[panel js] and every group confirmation is built from it');
  // The counts come off the BUTTON, written there by the renderer. Counting rows in the DOM instead
  // would count whatever the last swap left behind, which is not what the button was drawn for.
  ok(/getAttribute\('data-count'\)/.test(wjs), '[panel js] the -all counts are read off data-count');
  ok(/getAttribute\('data-observed'\)/.test(wjs), '[panel js] and the shortfall observed count off data-observed');
  ok(/getAttribute\('data-billed'\)/.test(wjs), '[panel js] and the billed one off data-billed');
  // A second click while the note field is open must not re-ask the confirm. obNoteFor's own guard runs
  // AFTER the dialog, so the reader would be asked again and then nothing would happen — which is why
  // this asserts the ORDER, not the presence: the same check further down the function is the bug.
  ok(wjs.includes('obNoting(cell)'), '[panel js] one predicate answers whether a note field is open here');
  // The handler's OWN guard, not obNoteFor's — obNoteFor is defined further up the file, so a plain
  // indexOf on the predicate would find its call and pass on a handler that never guards at all.
  ok(wjs.includes('if(accepting&&obNoting(cell))return'), '[panel js] the accept path guards on it too');
  ok(wjs.indexOf('if(accepting&&obNoting(cell))return') < wjs.indexOf("confirm('Accept all"),
    '[panel js] and does so BEFORE it confirms, so a second click is not asked twice');
  ok(/data-items-for/.test(wjs), '[panel js] the swap finds the item list by its data-items-for');
  ok(/outerHTML/.test(wjs), '[panel js] and swaps the row in place rather than reloading the panel');
  ok(/OB_LAST_ACCOUNT/.test(rjs), '[panel js] the swap keeps the last report to render against');
  ok(/OB_OPEN/.test(rjs), '[panel js] and which item lists were open');
  // A bare object answers truthily for constructor, toString and every other Object.prototype key, and a
  // group name comes out of the rulebook. The open map is read for an exact true.
  ok(/OB_OPEN\[g\]===true/.test(rjs), '[panel js] the open map is tested for an exact true, not for truthiness');
  // A reply belongs to the domain it was asked for: the reader can move to another account while a write
  // is in flight, and swapping a row computed for one account into another table would be a lie.
  ok(/OB_BASELINE_FOR/.test(rjs), '[panel js] a pending baseline is bound to the account it was sent for');
  ok(/forAccount&&\(!OB_LAST_ACCOUNT\|\|forAccount!==OB_LAST_ACCOUNT\.accountNumber\)/.test(rjs),
    '[panel js] and a reply for another account is ignored');
  // A 409 from the route can echo a caller-supplied key back in its message. It reaches the page as
  // v.unavailable and lands in innerHTML, so it goes through esc() or it is an injection point.
  ok(/esc\(v\.unavailable\)/.test(rjs), '[panel js] the failure text is escaped');
  ok(!/data-act="accept-save"/.test(wjs), '[panel js] the v1 accept-save button is gone');
  ok(!/button\[data-act="accept"\]/.test(wjs), '[panel js] and so is the handler that listened for it');

  // Server and client copies, from the SAME input on both sides — canWrite reaches the client copy on
  // the report, so the server call is given the report it would actually have been handed.
  for (const cw of [true, false]) {
    const rep = { ...ACCOUNT(), canWrite: cw };
    const out = runInNewContext(`${rowScript(cw)}\nobPanel(R)`, { R: rep }) as string;
    ok(out === renderAccountPanel(rep as never, cw), `[mirror] the client panel renderer matches the server one (canWrite=${cw})`);
  }
}


// ── idle comparison rows ───────────────────────────────────────────────────────────────────────────
// A row with nothing billed, nothing observed, no items and no recorded decision has no gap to review
// and nothing to undo — greyed out, and offered no Details link into a list that would open empty. A
// recorded groupRow, any item (present or stale), or any nonzero count is a decision or a change on file
// even at 0/0, so none of those rows are idle.
const idleRow = {
  group: 'MS Teams Integration', dimension: 'teamsConnected', dimensions: ['teamsConnected'],
  billed: 0, observed: 0, verdict: 'match', items: [] as unknown[], unreviewed: 0, stale: 0, offers: [],
};
const idleWithGroupRow = { ...idleRow, group: 'decommissioned seats', groupRow: { billed: 0, observed: 0, accepted: 0, ...DECIDED } };
const idleWithStale = {
  ...idleRow, group: 'ghost extensions', verdict: 'drift',
  items: [{ ...accepted('ext:900', 'Old desk'), status: 'stale' }], stale: 1,
};
const IDLE_ACCOUNT = () => ({ ...ACCOUNT(), comparison: { ...ACCOUNT().comparison, rows: [idleRow, idleWithGroupRow, idleWithStale] } });

{
  const rw = renderAccountPanel(IDLE_ACCOUNT() as never, true);
  const idle = rw.split('<tr').find((s) => s.startsWith(' data-verdict="match" data-group="MS Teams Integration"')) ?? '';
  ok(idle !== '', '[idle] the fixture row renders');
  ok(idle.startsWith(' data-verdict="match" data-group="MS Teams Integration" class="idle">'),
    '[idle] and carries the idle class, right after data-verdict and data-group');
  ok(!/data-act="toggle-items"/.test(idle), '[idle] with no Details toggle');
  ok(!rw.includes('<tr class="items" data-items-for="MS Teams Integration"'), '[idle] and no hidden items row for it');
  ok(/<td class="act"><\/td>/.test(idle), '[idle] the write column still gets an empty action cell, so the column count matches the header');
  ok(idle.includes('<b>MS Teams Integration</b>') && idle.includes('teamsConnected') && idle.includes('chip-match'),
    '[idle] the group name, dimension line and verdict chip are all still drawn');

  const withGroupRow = rw.split('<tr').find((s) => s.startsWith(' data-verdict="match" data-group="decommissioned seats"')) ?? '';
  ok(withGroupRow !== '' && !withGroupRow.includes('class="idle"'), '[idle] a 0/0 row with a recorded groupRow is not idle');

  const withStale = rw.split('<tr').find((s) => s.startsWith(' data-verdict="drift" data-group="ghost extensions"')) ?? '';
  ok(withStale !== '' && !withStale.includes('class="idle"'), '[idle] a 0/0 row with one stale item is not idle');

  // Server and client copies, from the same input on both sides.
  for (const cw of [true, false]) {
    const rep = { ...IDLE_ACCOUNT(), canWrite: cw };
    const out = runInNewContext(`${rowScript(cw)}\nobPanel(R)`, { R: rep }) as string;
    ok(out === renderAccountPanel(rep as never, cw), `[idle mirror] the client row script agrees with the server one (canWrite=${cw})`);
  }

  const doc = onebillHtml({ canWrite: true, version: 'test' });
  ok(/tr\.idle td \{/.test(doc), '[idle] the stylesheet greys idle rows');
}


// ── the account panel, scoped: two domains, one of them by site ──────────────────────────────────────
// The shape reconciliation is actually FOR: an account that holds one site of one domain and the whole
// of another. Every scoped surface has exactly one instance here — a where badge, a manual attribution
// with an automatic owner to disagree with, a stale item with no meta at all, an Unassigned list with a
// picker and a stale assignment on it, and a domain whose own totals dwarf the account's slice.
// netsapiens-lib 0.5.0 lists every device on an extension, the Teams connector included — so these
// carry `devices` as well as the counts. 100 has a handset AND one whose model NetSapiens does not know,
// 101 has a handset and a connector, 200 has the connector alone, and 201 has nothing at all — which is
// every shape the device chip has to draw.
//
// 0.8.0 adds `suffix` and `kind` per device, and the chip now has THREE shapes rather than two: the
// model when there is one (`100a`), the KIND when there is not (`101t`, `200t`, and `101r` — an app,
// which is a kind that is not Teams), and "(no model)" when there is neither (`100b`). All three are
// here, so the mirror and the shipped bundle draw every one of them.
const SPLIT_EXTS = [
  // 100b carries the library's `(unknown)` placeholder AND a suffix the legend does not name — nothing
  // to print and nothing to fall back on, which is what "(no model)" is for. The chip must never print
  // the placeholder itself, which reads as a rendering fault.
  { key: 'branch.example/ext:100', ext: '100', name: 'Ann Lee', site: 'North', scope: 'Basic User', serviceCode: 'premium', transcription: true, teams: false, deviceCount: 2, deviceModels: ['Model A', '(unknown)'], devices: [{ name: '100a', model: 'Model A', teams: false, suffix: 'a', kind: '' }, { name: '100b', model: '(unknown)', teams: false, suffix: 'b', kind: '' }], anyDevice: true },
  // 101r is the deployment's own app: a real handset by the count, no model NetSapiens knows, and a kind
  // that says what it is. It is why the fallback is the kind and not the word "no model".
  { key: 'branch.example/ext:101', ext: '101', name: 'Bo Chen', site: 'South', scope: 'Basic User', serviceCode: 'premium', transcription: false, teams: true, deviceCount: 2, deviceModels: ['Model A', '(unknown)'], devices: [{ name: '101a', model: 'Model A', teams: false, suffix: 'a', kind: '' }, { name: '101r', model: '(unknown)', teams: false, suffix: 'r', kind: 'Acme App' }, { name: '101t', model: '', teams: true, suffix: 't', kind: 'Teams' }], anyDevice: true },
  { key: 'other.example/ext:200', ext: '200', name: 'Cy Diaz', site: 'HQ', scope: 'Basic User', serviceCode: 'premium', transcription: false, teams: true, deviceCount: 0, deviceModels: [], devices: [{ name: '200t', model: '', teams: true, suffix: 't', kind: 'Teams' }], anyDevice: true },
  { key: 'other.example/ext:201', ext: '201', name: 'Dee Fox', site: 'HQ', scope: 'Basic User', serviceCode: 'premium', transcription: false, teams: false, deviceCount: 0, deviceModels: [], devices: [], anyDevice: false },
];
const SPLIT_INVENTORY = () => ({
  extensions: { total: 4, byScope: { 'Basic User': 4 }, byServiceCode: { premium: 4 }, byDeviceCount: { '1': 2, '2': 2 } },
  systemUsers: { total: 1, byServiceCode: { 'system-aa': 1 } },
  transcriptionEnabled: 1,
  // netsapiens-lib 0.7.0: the fax line is NOT in `total`, `local` or `tollFree`. `all` is everything.
  dids: { total: 5, tollFree: 1, local: 4, fax: 1, all: 6 },
  e911Addresses: 1, smsNumbers: 1,
  devices: { total: 6, byModel: { 'Model A': 4, '(unknown)': 2 } },
});
/** The two accounts that share branch.example, as a picker offers them. */
const SHARED_HOLDERS = [{ accountNumber: 'CLI00002', accountName: 'Branch North' }, { accountNumber: 'CLI00003', accountName: 'Branch South' }];
const ACCOUNT_SPLIT = () => ({
  accountNumber: 'CLI00002', accountName: 'Branch North',
  scopes: [{ domain: 'branch.example', site: 'North' }, { domain: 'other.example' }],
  domains: ['branch.example', 'other.example'],
  domain: 'branch.example',
  loadedAt: '2026-09-04T09:30:00.000Z',
  inventory: SPLIT_INVENTORY(),
  detail: {
    extensions: SPLIT_EXTS,
    systemUsers: [{ key: 'branch.example/ext:900', ext: '900', name: 'Main Menu', site: 'North', scope: 'Auto Attendant', serviceCode: 'system-aa', transcription: false, teams: false, deviceCount: 0, deviceModels: [], anyDevice: false }],
    dids: [
      { key: 'branch.example/did:+15550100', number: '+15550100', kind: 'tollFree', destination: 'to user 100 — Ann Lee', description: 'Portal Created: User - 100' },
      { key: 'branch.example/did:+15550101', number: '+15550101', kind: 'local', destination: 'to queue 701 — Sales', description: '' },
      // A FAX LINE: an ordinary local number whose dial rule hands it to the fax server. netsapiens-lib
      // flags it and says "to fax server" rather than printing the host, and this page chips it apart
      // from a DID because it bills under a different rule.
      { key: 'branch.example/did:+15550102', number: '+15550102', kind: 'local', fax: true, destination: 'to fax server', description: 'Portal Created: Phonenumber -> FaxServer' },
      { key: 'other.example/did:+15550200', number: '+15550200', kind: 'local' },
      { key: 'other.example/did:+15550201', number: '+15550201', kind: 'local' },
      { key: 'other.example/did:+15550202', number: '+15550202', kind: 'local' },
    ],
    e911Addresses: [{ key: 'branch.example/addr:a-2', label: 'North dock' }],
    smsNumbers: [{ key: 'other.example/sms:+15550200', number: '+15550200' }],
  },
  // branch.example is much bigger than the slice this account bills; other.example is entirely theirs,
  // so its totals match the scoped counts and it must NOT get a line.
  domainTotals: {
    'branch.example': {
      extensions: { total: 9, byScope: { 'Basic User': 9 }, byServiceCode: { premium: 9 }, byDeviceCount: { '1': 9 } },
      systemUsers: { total: 2, byServiceCode: { 'system-aa': 2 } },
      transcriptionEnabled: 2,
      dids: { total: 11, tollFree: 1, local: 10, fax: 2, all: 13 },
      e911Addresses: 3, smsNumbers: 2,
      devices: { total: 9, byModel: { 'Model A': 9 } },
    },
    'other.example': SPLIT_INVENTORY(),
  },
  readFailures: ['other.example: SMS for 102'],
  partial: false,
  // branch.example is shared with CLI00003, so its items can be moved there; other.example is entirely
  // this account's, so its items have nowhere to go and get no control at all.
  holders: { 'branch.example': [{ accountNumber: 'CLI00002', accountName: 'Branch North' }, { accountNumber: 'CLI00003', accountName: 'Branch South' }],
    'other.example': [{ accountNumber: 'CLI00002', accountName: 'Branch North' }] },
  unassigned: [
    { domain: 'branch.example', key: 'addr:a-1', label: 'Shared', reason: 'address shared by North and South',
      item: { key: 'addr:a-1', label: 'Shared' }, candidates: SHARED_HOLDERS },
    // An extension nobody holds, carrying the device detail an operator deciding who owns it needs.
    { domain: 'branch.example', key: 'ext:300', label: '300', reason: 'site Annex is not linked',
      item: { key: 'ext:300', ext: '300', name: 'Ed Ng', site: 'Annex', scope: 'Basic User', serviceCode: 'premium', transcription: false, teams: false, deviceCount: 1, deviceModels: ['Model B'], devices: [{ name: '300a', model: 'Model B', teams: false, suffix: 'a', kind: '' }], anyDevice: true },
      candidates: SHARED_HOLDERS, staleAssignment: 'CLI00007' },
    // A NUMBER nobody holds: the case the detail cell exists for, since "+15550999" tells an operator
    // nothing about whether it is billable or plumbing until it says where it rings.
    { domain: 'branch.example', key: 'did:+15550999', label: '+15550999', reason: 'routed to system-queue',
      item: { key: 'did:+15550999', number: '+15550999', kind: 'local', destination: 'to queue 701 — Sales', description: '' },
      candidates: SHARED_HOLDERS },
    // And an unassigned FAX line. The Unassigned row has no entry in `detail` to look up, so its chip is
    // decided from the record on the row itself — the one place the two routes to `fax` could diverge.
    { domain: 'branch.example', key: 'did:+15550998', label: '+15550998', reason: 'no site set',
      item: { key: 'did:+15550998', number: '+15550998', kind: 'local', fax: true, destination: 'to fax server', description: '' },
      candidates: SHARED_HOLDERS },
  ],
  comparison: {
    examined: 2,
    rows: [
      { group: 'seats', dimension: 'extensions.total', dimensions: ['extensions.total'], billed: 4, observed: 4, verdict: 'match',
        items: [
          { key: 'branch.example/ext:100', label: '100 Ann Lee', status: 'unreviewed', domain: 'branch.example', site: 'North', attribution: 'site' },
          { key: 'branch.example/ext:101', label: '101 Bo Chen', status: 'unreviewed', domain: 'branch.example', site: 'South', attribution: 'manual', automatic: { accountNumber: 'CLI00003', site: 'South' } },
          { key: 'other.example/ext:200', label: '200 Cy Diaz', status: 'unreviewed', domain: 'other.example', attribution: 'domain' },
          // Accepted AS a named plan (migration 0004), so the item line's " as <plan>" renders in every
          // sweep this fixture feeds rather than only where a test asks for it.
          { key: 'other.example/ext:201', label: '201 Dee Fox', status: 'accepted', acceptance: { key: 'other.example/ext:201', label: '201 Dee Fox', offer: 'Seat Tier One', ...DECIDED }, domain: 'other.example', attribution: 'domain' },
        ], unreviewed: 3, stale: 0, offers: [{ name: 'Seat Tier One', quantity: 4, perUnit: 1 }] },
      // The stale acceptance: scoping never saw it, so it has no meta and its attribution is 'unknown'.
      // An unknown is not a manual, and must carry no attribution badge at all.
      { group: 'numbers', dimension: 'dids.total', dimensions: ['dids.total'], billed: 6, observed: 5, verdict: 'drift',
        items: [
          { key: 'branch.example/did:+15550100', label: '+15550100', status: 'unreviewed', domain: 'branch.example', site: 'North', attribution: 'site' },
          { key: 'other.example/did:+15550999', label: '+15550999', status: 'stale', acceptance: { key: 'other.example/did:+15550999', label: '+15550999', ...DECIDED }, domain: 'other.example', attribution: 'unknown' },
        ], unreviewed: 1, stale: 1,
        groupRow: { billed: 6, observed: 5, accepted: 5, ...DECIDED },
        offers: [{ name: 'Number Pack', quantity: 6, perUnit: 1 }] },
      // ADDRESSES, the one kind that can sit on two accounts at once. Three of them, so every shape of
      // the co-billing line is drawn by the fixture every mirror sweep runs: a co-holder that bills one
      // (with an entitlement), one that bills nothing, and one whose subscriptions would not read.
      // a-3 is MANUAL here, which is the only state that offers Remove; CLI00003 already holds all three,
      // so none of them offers a picker — branch.example has exactly two holders.
      { group: 'e911', dimension: 'e911Addresses', dimensions: ['e911Addresses'], billed: 3, observed: 3, verdict: 'match',
        items: [
          { key: 'branch.example/addr:a-2', label: 'North dock', status: 'unreviewed', domain: 'branch.example', attribution: 'site',
            sharedWith: [{ accountNumber: 'CLI00003', accountName: 'Branch South' }] },
          { key: 'branch.example/addr:a-3', label: 'Loading bay', status: 'unreviewed', domain: 'branch.example', attribution: 'manual',
            sharedWith: [{ accountNumber: 'CLI00003', accountName: 'Branch South' }] },
          { key: 'branch.example/addr:a-5', label: 'Annex dock', status: 'unreviewed', domain: 'branch.example', attribution: 'site',
            sharedWith: [{ accountNumber: 'CLI00003', accountName: 'Branch South' }] },
        ], unreviewed: 3, stale: 0, offers: [{ name: 'E911 Location', quantity: 3, perUnit: 1 }] },
      // The SAME address key on a SECOND group. A rulebook can count one dimension under two groups, and
      // then one item sits on two rows whose billed numbers differ — so the co-holder line has to be
      // looked up by (group, key) and not by key alone.
      { group: 'e911 with a number', dimension: 'e911Addresses', dimensions: ['e911Addresses'], billed: 4, observed: 3, verdict: 'drift',
        items: [
          { key: 'branch.example/addr:a-2', label: 'North dock', status: 'unreviewed', domain: 'branch.example', attribution: 'site',
            sharedWith: [{ accountNumber: 'CLI00003', accountName: 'Branch South' }] },
        ], unreviewed: 1, stale: 0, offers: [] },
      // Fax lines, their own dimension since netsapiens-lib 0.7.0 — and the row's own item is the one
      // placed item whose kind chip has to read "fax line". Nothing bills it yet, so this row is also
      // where the delta line's OVER direction is drawn: observed 1, billed 0, so "1 unbilled".
      { group: 'Fax Lines', dimension: 'dids.fax', dimensions: ['dids.fax'], billed: 0, entitled: 0, observed: 1, verdict: 'unbaselined',
        items: [{ key: 'branch.example/did:+15550102', label: '+15550102', status: 'unreviewed', domain: 'branch.example', site: 'North', attribution: 'site' }],
        unreviewed: 1, stale: 0, offers: [] },
      // The fourth kind, so the chip set is complete in one sweep.
      { group: 'sms', dimension: 'smsNumbers', dimensions: ['smsNumbers'], billed: 1, observed: 1, verdict: 'match',
        items: [{ key: 'other.example/sms:+15550200', label: '+15550200', status: 'unreviewed', domain: 'other.example', attribution: 'domain' }],
        unreviewed: 1, stale: 0, offers: [] },
    ],
    unmapped: [], ignored: [], catalogMisses: [],
  },
  // What the co-holder's own bill says about the same group. GROUP then key: `addr:a-2` is on the e911
  // row AND on the e911-and-number row, with a different number on each, which is exactly the pair a
  // map keyed by the item alone reported twice with the first row's figures.
  coBilled: {
    e911: {
      'branch.example/addr:a-2': [{ accountNumber: 'CLI00003', accountName: 'Branch South', group: 'e911', billed: 1, entitled: 2 }],
      'branch.example/addr:a-3': [{ accountNumber: 'CLI00003', accountName: 'Branch South', group: 'e911', billed: 0, entitled: 0 }],
      'branch.example/addr:a-5': [{ accountNumber: 'CLI00003', accountName: 'Branch South', group: 'e911', billed: -1, entitled: 0 }],
    },
    'e911 with a number': {
      'branch.example/addr:a-2': [{ accountNumber: 'CLI00003', accountName: 'Branch South', group: 'e911 with a number', billed: 4, entitled: 0 }],
    },
  },
  baselinesEnabled: true, canWrite: true,
});

{
  const rw = renderAccountPanel(ACCOUNT_SPLIT() as never, true);

  // ── the header: the ACCOUNT is the subject, its scope is the subtitle ─────────────────────────
  ok(rw.includes('<h2>CLI00002 — Branch North</h2>'), '[scoped] the panel is headed by the account, not by a domain');
  ok(rw.includes('<div class="dim">branch.example / North · other.example (whole domain)</div>'),
    '[scoped] and the scope line names every domain-or-site it holds');
  ok(rw.indexOf('<h2>CLI00002') < rw.indexOf('branch.example / North'), '[scoped] account first, scope beneath it');
  ok(!/<h2>branch\.example/.test(rw), '[scoped] the old domain heading is gone');

  // ── which domain an item is on ────────────────────────────────────────────────────────────────
  ok(rw.includes('<span class="where">branch.example / North</span>'), '[scoped] an item says which domain and site it is on');
  ok(rw.includes('<span class="where">other.example</span>'), '[scoped] and a whole-domain item names just the domain');
  ok(!renderAccountPanel(ACCOUNT() as never, true).includes('class="where"'),
    '[scoped] a single-domain account gets no where badge — there is nowhere else it could be');

  // ── attribution: manual is the only one that shows ────────────────────────────────────────────
  // The title names the ACCOUNT the automatic rule would have billed this to. Naming only the site
  // would leave the reader to work out whose site it is, which is the question the badge is answering.
  ok(rw.includes('<span class="chip chip-manual" title="automatically: CLI00003 (South)">manual</span>'),
    '[scoped] a manually assigned item is chipped, and says where automatic placement would have put it');
  // Two: the seat, and the address somebody added this account to by hand.
  ok((rw.match(/chip-manual/g) ?? []).length === 2, '[scoped] and only the items placed by hand carry the chip');
  // The plan an acceptance was recorded AS (migration 0004) — the only part of the decision the numbers
  // do not already say, so it is the one part that has to be on screen.
  const deeItem = rw.split('<tr data-item-key=').find((x) => x.startsWith('"other.example/ext:201"')) ?? '';
  ok(deeItem.includes('<span class="chip chip-item-accepted">accepted</span><span class="dim small"> as Seat Tier One by ops@example.com on 2026-08-01</span>'),
    '[scoped] an accepted item says which plan it was billed as, before who decided it and when');
  const annItem2 = rw.split('<tr data-item-key=').find((x) => x.startsWith('"branch.example/ext:100"')) ?? '';
  ok(!/ as /.test(annItem2), '[scoped] while an untagged one says nothing about a plan');

  // ── the kind chip, first in every label cell, on all four kinds ───────────────────────────────
  // A list of "100", "+15550100", "North dock" and "+15550200" reads as one kind of thing until
  // something says otherwise, and the four bill under different rules and offer different controls.
  /** One item row's LABEL cell — the second, the checkbox cell being first on a write build. */
  const itemCell = (k: string): string => ((rw.split(`<tr data-item-key="${k}"`)[1] ?? '').split('</td><td>')[1] ?? '');
  ok(itemCell('branch.example/ext:100').startsWith('<span class="kind kind-ext">extension</span>100 Ann Lee'),
    '[kind] an extension line opens with its kind, then its label');
  ok(itemCell('branch.example/did:+15550100').startsWith('<span class="kind kind-did">number</span>+15550100'), '[kind] a number says number');
  ok(itemCell('branch.example/addr:a-2').startsWith('<span class="kind kind-addr">E911 address</span>North dock'), '[kind] an address says E911 address');
  ok(itemCell('other.example/sms:+15550200').startsWith('<span class="kind kind-sms">SMS number</span>+15550200'), '[kind] and an SMS number says SMS number');
  // The Unassigned rows carry it too — that list mixes all four kinds by construction.
  ok(rw.includes('<td><span class="kind kind-addr">E911 address</span>Shared</td>'), '[kind] the Unassigned list is chipped the same way');
  ok(rw.includes('<td><span class="kind kind-did">number</span>+15550999</td>'), '[kind] including its numbers');
  // The stylesheet has to know the class, or it renders as an unstyled word beside the label.
  ok(onebillHtml({ canWrite: true, version: 't' }).includes('.kind {'), '[kind] and the stylesheet has a rule for it - an unstyled word beside the label reads as a rendering bug');

  // ── "also on", and what the co-holder's own bill says ────────────────────────────────────────
  // Only an address can be on two accounts. Without this line the duplicated count reads as a
  // double-bill; with it, the case worth finding — a co-holder billing NOTHING — is on the page.
  const addrRow = (k: string): string => (rw.split(`<tr data-item-key="branch.example/addr:${k}"`)[1] ?? '').split('</tr>')[0] ?? '';
  ok(addrRow('a-2').includes('<div class="dim small also">also on CLI00003 — Branch South (e911 x1 +2 entitled)</div>'),
    '[shared] a co-holder billing one, with an entitlement, is named with both numbers');
  ok(addrRow('a-3').includes('<div class="dim small also">also on CLI00003 — Branch South (no e911 line)</div>'),
    '[shared] a co-holder with nothing on the group says so, rather than showing a bare zero');
  ok(addrRow('a-5').includes('<div class="dim small also">also on CLI00003 — Branch South (could not read)</div>'),
    '[shared] and one whose subscriptions would not read says THAT, which a 0 could not be told apart from');
  ok(!/class="also"/.test(itemCell('branch.example/ext:100')), '[shared] an item on one account carries no such line');
  // THE SAME KEY ON TWO ROWS. A rulebook can count one dimension under two groups, and those rows have
  // different billed numbers — a co-holder map keyed by the item alone gave the second row the first
  // row's figures, which is a wrong number on a billing page.
  const rowsFor = (k: string): string[] => rw.split(`<tr data-item-key="${k}"`).slice(1).map((x) => x.split('</tr>')[0] ?? '');
  const a2 = rowsFor('branch.example/addr:a-2');
  ok(a2.length === 2, '[shared] the address sits on two comparison rows');
  ok(a2.some((r) => r.includes('(e911 x1 +2 entitled)')) && a2.some((r) => r.includes('(e911 with a number x4)')),
    '[shared] and each row reads the co-holder line for ITS OWN group, not the other row\'s numbers');

  // ── an address is added to and removed from, never moved ─────────────────────────────────────
  // Moving a shared address would take an E911 bundle off an account that really does bill for the
  // place. Remove appears only where THIS account is in the manual set: an automatic placement belongs
  // to the site link, which would put it straight back.
  ok(addrRow('a-3').includes('data-act="unassign" data-domain="branch.example" data-key="addr:a-3" data-label="Loading bay">Remove from this account</button>'),
    '[shared] the address this account was added to by hand offers Remove, keyed bare beside its domain');
  ok(!/data-act="unassign"/.test(addrRow('a-2')), '[shared] while one placed by the site rule does not - the site link would put it straight back');
  ok(!/data-act="assign"/.test(addrRow('a-2')) && !/data-act="assign"/.test(addrRow('a-3')),
    '[shared] and neither offers a picker, both of the domain\'s holders already being on it');
  ok(!/data-placed/.test(addrRow('a-2')), '[shared] no Move on an address at all - the control that would take a bundle away');
  ok(rw.split('<tr data-item-key="branch.example/ext:100"')[1]!.split('</tr>')[0]!.includes('data-placed="1"'),
    '[shared] while an extension still moves, being a fact about one thing');
  // WRITE SURFACE ONLY, the same rule every other control here follows.
  ok(!/data-act="unassign"/.test(renderAccountPanel({ ...ACCOUNT_SPLIT(), canWrite: false } as never, false)),
    '[shared] a reader is offered no Remove');
  ok(renderAccountPanel({ ...ACCOUNT_SPLIT(), canWrite: false } as never, false).includes('class="kind kind-addr"'),
    '[shared] but reads the kind chips, which are a reading of the item and not a write');

  const staleItem = rw.split('<tr data-item-key=').find((x) => x.startsWith('"other.example/did:+15550999"')) ?? '';
  ok(staleItem !== '', '[scoped] the stale item is listed');
  ok(!/chip-manual/.test(staleItem), '[scoped] an unknown attribution renders no badge — nothing here knows where it came from');

  // ── the item detail joins on a SCOPED key ─────────────────────────────────────────────────────
  const annItem = rw.split('<tr data-item-key=').find((x) => x.startsWith('"branch.example/ext:100"')) ?? '';
  ok(annItem !== '', '[scoped] the extension item is listed under its scoped key');
  ok(/Ann Lee, North/.test(annItem), '[scoped] and still finds its record — the join strips the domain off the key');
  const numItem = rw.split('<tr data-item-key=').find((x) => x.startsWith('"branch.example/did:+15550100"')) ?? '';
  ok(/toll-free/.test(numItem), '[scoped] a scoped number key still resolves its kind');

  // ── Clear assignment ──────────────────────────────────────────────────────────────────────────
  // The key on the button is BARE: the assign route takes a domain and a key, and a scoped key would
  // name the domain twice, once in a field the route does not read it from.
  ok(rw.includes('data-act="clear-assign" data-domain="branch.example" data-key="ext:101"'),
    '[scoped] a manual item offers Clear assignment, keyed bare beside its domain');
  ok((rw.match(/data-act="clear-assign"/g) ?? []).length === 1, '[scoped] and no other item does');

  // ── Move ──────────────────────────────────────────────────────────────────────────────────────
  // The Unassigned picker's write, offered on an item that is already PLACED. It needs somewhere to move
  // to: only a domain another account also holds gets the control, so branch.example's items have one and
  // other.example's — held entirely by this account — have none.
  ok(annItem.includes('<select data-role="assign-to"><option value="CLI00003">CLI00003 — Branch South</option></select>'),
    '[move] a placed item on a shared domain offers the OTHER holders by number AND name, and not this account');
  ok(annItem.includes('data-act="assign" data-placed="1" data-domain="branch.example" data-key="ext:100" data-label="100 Ann Lee">Move</button>'),
    '[move] beside a Move button keyed bare, like Clear assignment, and marked as a placed item');
  const cyItem = rw.split('<tr data-item-key=').find((x) => x.startsWith('"other.example/ext:200"')) ?? '';
  ok(cyItem !== '' && !/data-act="assign"/.test(cyItem),
    '[move] an item on a domain nobody else holds gets no control - there is nowhere to move it to');
  // Order in the cell: the acceptance pair, then Clear assignment, then Move. Move last because it is the
  // only one of the three that sends the item somewhere else.
  const boItem = rw.split('<tr data-item-key=').find((x) => x.startsWith('"branch.example/ext:101"')) ?? '';
  ok(boItem.indexOf('data-act="accept-item"') < boItem.indexOf('data-act="clear-assign"')
    && boItem.indexOf('data-act="clear-assign"') < boItem.indexOf('data-act="assign"'),
    '[move] and comes after Accept and Clear assignment on a manual item');

  // ── the Unassigned list ───────────────────────────────────────────────────────────────────────
  ok(rw.includes('<h3>Unassigned on branch.example</h3>'), '[scoped] the unassigned items are headed by their domain');
  ok(!/Unassigned on other\.example/.test(rw), '[scoped] and a domain with none gets no heading');
  const unaRow = rw.split('<tr data-unassigned-key=').find((x) => x.startsWith('"addr:a-1"')) ?? '';
  ok(unaRow !== '', '[scoped] each unassigned item is a row keyed by its bare key');
  ok(unaRow.includes('data-domain="branch.example"'), '[scoped] carrying the domain it is on');
  ok(unaRow.includes('Shared') && unaRow.includes('address shared by North and South'), '[scoped] with its label and the reason nothing claimed it');
  ok((unaRow.match(/<option /g) ?? []).length === 2 && /<select data-role="assign-to">/.test(unaRow),
    '[scoped] and a picker of the accounts that could hold it');
  ok(/data-act="assign" data-domain="branch\.example" data-key="addr:a-1"/.test(unaRow), '[scoped] beside an Assign button');
  const staleRow = rw.split('<tr data-unassigned-key=').find((x) => x.startsWith('"ext:300"')) ?? '';
  ok(staleRow.includes('assigned to CLI00007, which no longer holds this domain'),
    '[scoped] an assignment naming an account that has lost the domain says so');
  ok(!renderAccountPanel(ACCOUNT() as never, true).includes('data-unassigned-key'),
    '[scoped] an account with nothing unassigned gets no list at all');

  // ── the domain totals line ────────────────────────────────────────────────────────────────────
  ok(rw.includes('<div class="dim small">of branch.example: 9 extensions · 11 numbers · 2 fax lines · 3 E911 addresses · 2 SMS numbers</div>'),
    '[scoped] the inventory says what the whole domain holds beside the account\'s slice');
  ok(!/of other\.example:/.test(rw), '[scoped] and says nothing for a domain the account holds entirely');
  ok(!/of acme\.example:/.test(renderAccountPanel(ACCOUNT() as never, true)),
    '[scoped] a single-domain account whose totals match gets no line either');

  // ── a domain that could not be read ───────────────────────────────────────────────────────────
  const partial = renderAccountPanel({ ...ACCOUNT_SPLIT(), partial: true } as never, true);
  ok(/<p class="fail">One of this account's domains could not be read/.test(partial),
    '[scoped] a partial report says so, in the place an Accept would have been');
  ok(!/data-act="accept-/.test(partial), '[scoped] and offers no acceptance control');
  ok(!/data-act="clear-/.test(partial), '[scoped] nor a clear of any kind');
  ok(!/data-act="assign"/.test(partial), '[scoped] nor an Assign, nor the Move that shares its action');
  ok(!/data-role="assign-to"/.test(partial), '[scoped] nor the picker beside it');
  ok(!/colspan="6"/.test(partial), '[scoped] and the table loses its controls column, like a reader\'s');
  ok(rw.includes('data-act="accept-item"'), '[scoped] while the same report un-partialled has them');

  // ── a reader ──────────────────────────────────────────────────────────────────────────────────
  const ro = renderAccountPanel(ACCOUNT_SPLIT() as never, false);
  ok(!/data-role="assign-to"/.test(ro), '[scoped] a reader gets no assignment picker, on an item line or an unassigned one');
  ok(!/data-act="assign"|data-act="clear-assign"/.test(ro), '[scoped] and no way to move anything');
  ok(/data-unassigned-key="addr:a-1"/.test(ro), '[scoped] but still sees WHAT is unassigned, which is a reading');
  ok(/chip-manual/.test(ro), '[scoped] and that an item was placed by hand');

  // ── the stylesheet knows the new tokens ───────────────────────────────────────────────────────
  const doc = onebillHtml({ canWrite: true, version: 'test' });
  // The RULE, not the substring: '.where' matches the class name the renderer prints, so a bare includes
  // passes on a stylesheet that never styles it. Same shape as the .chip-<verdict> checks above.
  ok(doc.includes('.chip-manual {'), '[scoped] the stylesheet has a .chip-manual rule');
  ok(doc.includes('.where {'), '[scoped] and a .where rule');
  ok(doc.includes('table.una {'), '[scoped] and a table.una rule');
  ok(doc.includes('table.una td {'), '[scoped] whose cells are styled too, the panel having no other table like it');

  // ── the two copies, byte for byte, on every branch this fixture has ───────────────────────────
  for (const [rep, what] of [
    [ACCOUNT_SPLIT(), 'writer'],
    [{ ...ACCOUNT_SPLIT(), partial: true }, 'partial'],
    [{ ...ACCOUNT_SPLIT(), canWrite: false }, 'reader'],
  ] as const) {
    const cw = rep.canWrite;
    const out = runInNewContext(`${rowScript(cw)}\nobPanel(R)`, { R: rep }) as string;
    ok(out === renderAccountPanel(rep as never, cw), `[mirror] the client panel matches the server one, scoped (${what})`);
  }
}

// ── the panel's client wiring, scoped ────────────────────────────────────────────────────────────────
{
  const wjs = scriptOf(onebillHtml({ canWrite: true, version: 'test' }));
  const rjs = scriptOf(onebillHtml({ canWrite: false, version: 'test' }));

  // The panel is opened by a SELECTOR now, not by a domain: a site row names its account, because
  // `?domain=` on a split domain names a row several accounts share.
  ok(/var o=\[\],seen=Object\.create\(null\)/.test(rjs),
    '[scoped js] the unassigned grouping dedupes on a prototype-less map, so a "__proto__" domain cannot no-op the write');
  ok(/OB_PANEL_SEL/.test(rjs), '[scoped js] the open panel is remembered as a selector');
  ok(!/OB_PANEL_DOMAIN/.test(rjs) && !/OB_PANEL_DOMAIN/.test(wjs), '[scoped js] and the domain-only variable is gone');
  ok(/\[data-open-account\]/.test(rjs), '[scoped js] a click on an account button is handled');
  ok(/obOpenAccount\(\{account:oa\},false\)/.test(rjs), '[scoped js] and opens the panel by account number');
  ok(/obOpenAccount\(\{domain:od\},false\)/.test(rjs), '[scoped js] while a domain button still opens by domain');
  ok(/sel\.account\?\{account:sel\.account\}:\{domain:sel\.domain\}/.test(rjs),
    '[scoped js] and exactly one selector reaches the request');

  // Confirmations name the account and the domain it was opened by, off the loaded REPORT.
  ok(/function obConfirmWhere\(\)/.test(wjs), '[scoped js] one helper builds what the confirmations name');
  ok(/a\+' \('\+d\+'\)'/.test(wjs), '[scoped js] and renders CLI00002 (branch.example) from the report');
  // BY ACCOUNT, not by domain. A panel open on an account holding one SITE of a domain has no domain
  // that resolves back to it: the bare row belongs to the whole-domain holder, so a write sent by domain
  // lands on a different account or 409s on a multi-account split.
  ok(/\{account:OB_LAST_ACCOUNT\.accountNumber,group:group\}/.test(wjs),
    '[scoped js] a baseline names the account the panel is showing');
  ok(!/domain:OB_LAST_ACCOUNT\.domain/.test(wjs), '[scoped js] and never the domain, which can name someone else');
  ok(/OB_BASELINE_FOR\[RID\]=OB_LAST_ACCOUNT&&OB_LAST_ACCOUNT\.accountNumber/.test(wjs),
    '[scoped js] and is bound to the ACCOUNT it was sent for, not the domain');

  // Assign and clear-assign.
  ok(wjs.includes('button[data-act="assign"]'), '[scoped js] the writer bundle handles assign');
  ok(wjs.includes('button[data-act="clear-assign"]'), '[scoped js] and clear-assign');
  ok(!/button\[data-act="(clear-)?assign"\]/.test(rjs), '[scoped js] the reader bundle carries neither handler');
  ok(!/askAssign/.test(rjs), '[scoped js] nor any way to ask for a move');
  ok(wjs.includes(SPK_BRIDGE.assignRequest) && wjs.includes('assign:set'), '[scoped js] the assign request tag is spelled assign:set');
  ok(!rjs.includes('assign:set'), '[scoped js] and never reaches a reader');
  ok(/select\[data-role="assign-to"\]/.test(wjs), '[scoped js] the target account is read off the picker beside the button');
  // Two lines of one plan must not offer the same words twice: the picker is per NAME.
  ok(/function obNoteFor\(cell,offers,dflt,cb\)\{if\(obNoting\(cell\)\)return;offers=obUniqOffers\(offers\);/.test(wjs),
    '[scoped js] the billed-as picker lists each offer name once');
  ok(runInNewContext(`${rowScript(true)}\nJSON.stringify(obUniqOffers(O))`, { O: ['E911 Physical Location and Phone Number', 'e911 physical location and phone number ', 'Single Voice Phone Number (DID)'] }) === JSON.stringify(['E911 Physical Location and Phone Number', 'Single Voice Phone Number (DID)']),
    '[scoped js] and dedupes the way the library matches names - trimmed, case-insensitive');
  // A group with an item LIST but no items (an E911 row whose one address sits on another account)
  // must not draw a pick-all header over nothing: a checkbox that selects no rows is a control that lies.
  {
    const empty = { ...ACCOUNT_SPLIT(), comparison: { ...ACCOUNT_SPLIT().comparison, rows: [{ group: 'E911 and Number', dimension: 'e911Addresses', billed: 1, observed: 0, unreviewed: 0, stale: 0, verdict: 'unbaselined', items: [], offers: [{ name: 'E911 Physical Location and Phone Number', quantity: 1, perUnit: 1, tagged: 0 }], credits: [], entitled: 0, optional: false, untagged: 0 }] } } as never;
    const html = renderAccountPanel(empty, true);
    ok(!/data-role="pick-all"/.test(html), '[items] an empty item list draws no pick-all header');
    ok(runInNewContext(`${rowScript(true)}\nobPanel(R)`, { R: empty }) === html, '[mirror] and the client agrees');
  }
  // No confirm dialog on assign/move: the note field's Save is the second step and a move is undone by
  // moving back (removed at the operator's request, 2026-09-05). The one fact the dialog carried — a
  // placed item loses its acceptance here — is the note field's placeholder, chosen off data-placed.
  // (The links table's own "Move <domain> …" confirm is a different write and stays.)
  ok(!/confirm\('Assign '\+lbl/.test(wjs) && !/confirm\('Move '\+lbl/.test(wjs) && !/confirm\(msg\)/.test(wjs),
    '[scoped js] assign and move open the note field without a confirm dialog first');
  ok(/data-placed'\)==='1'\)\{var nf=cell\.querySelector\('input\[data-role="note"\]'\);if\(nf\)nf\.placeholder='Why \(optional\) - its acceptance here is cleared'/.test(wjs),
    '[scoped js] and a placed item says in the note field that its acceptance here goes with it');
  ok(/confirm\('Return '\+lbl\+' on '\+dom\+' to automatic placement\? Its acceptance on the current account is cleared\.'\)/.test(wjs),
    '[scoped js] clear-assign confirms, saying what else it clears');
  ok(/accountNumber:null/.test(wjs), '[scoped js] and sends an explicit null, which is what hands the item back');
  ok(/var viewing=OB_LAST_ACCOUNT\.accountNumber/.test(wjs) && /viewing:viewing/.test(wjs),
    '[scoped js] every move says which panel is open, off the loaded report');
  // The label rides on the button, written there by the renderer: reading it out of the DOM cell would
  // read whatever the last repaint left there, plus the where badge beside it.
  ok(/getAttribute\('data-label'\)/.test(wjs), '[scoped js] the confirmation names the item off data-label');

  // A reply for a panel the reader has already left. The id gate only says the reply was asked for, not
  // that it is about what is on screen NOW — two opens can be in flight.
  ok(/if\(psel&&psel\.account&&v\.report\.accountNumber!==psel\.account\)return/.test(rjs),
    '[scoped js] an account reply that names a different account is dropped');
  ok(/if\(psel&&psel\.domain&&\(v\.report\.domains\|\|\[\]\)\.indexOf\(psel\.domain\)<0\)return/.test(rjs),
    '[scoped js] and a domain reply that does not hold the domain asked for');

  // Nothing was sent, so nothing will answer: an unhosted send drops its own pending entries rather than
  // leaving an id the message listener would later admit for a reply nobody is waiting on.
  ok(/if\(!HOSTED\)\{delete PEND\[RID\];deliverAccount\(/.test(rjs),
    '[scoped js] an unhosted account request clears its pending id');
  ok(/if\(!HOSTED\)\{delete PEND\[RID\];delete OB_BASELINE_FOR\[RID\];/.test(wjs),
    '[scoped js] and an unhosted baseline clears both of its entries, like an unhosted assign');

  // The reply is a whole report, because an item can move OUT of the account being viewed.
  ok(/function obRepaint\(/.test(wjs), '[scoped js] the reply repaints the whole panel');
  ok(/OB_ASSIGN_FOR/.test(wjs), '[scoped js] a pending move is bound to the account it was sent from');
  // The assign route resolves the account, not the domain the operator opened it by — so the reply's
  // own `domain` is whatever sorted first. Keeping the opened-by domain is what stops a confirmation
  // renaming the row the operator clicked.
  ok(/OB_PANEL_SEL&&OB_PANEL_SEL\.domain/.test(wjs), '[scoped js] and the domain the panel was opened by survives the repaint');

  // A second click while a move for the same item is in flight must not re-ask the dialog and then do
  // nothing. clear-assign opens no note field, so obNoting has nothing on screen to find — it needs a
  // pending mark of its own, tested BEFORE the confirm on both paths and cleared when the reply lands.
  ok(/function obMoving\(/.test(wjs) && /function obMoveMark\(/.test(wjs),
    '[scoped js] a move in flight is marked by domain and key');
  ok(wjs.includes('if(obMoving(dom,key))return'), '[scoped js] and a second click on it is dropped');
  ok(wjs.indexOf('if(obMoving(dom,key))return') < wjs.indexOf("confirm('Return '+lbl"),
    '[scoped js] BEFORE the clear-assign confirmation, so it is not asked twice');
  ok(wjs.indexOf('if(obMoving(dom,key))return') < wjs.indexOf("obNoteFor(cell,[],'',function(note){if(obMoving(dom,key))return;"),
    '[scoped js] and before the assign note field opens');
  ok(/obMoveMark\(dom,key\);obBusy\(true,'Moving…'\);askAssign\(\{domain:dom,key:key,accountNumber:null/.test(wjs),
    '[scoped js] clear-assign marks the item as it sends');
  ok(/if\(moved\)delete OB_MOVING\[moved\]/.test(wjs), '[scoped js] and the mark is cleared when the reply lands');
  // Object.create(null) in both places a report-data string is used as a key: on a plain object
  // "__proto__" is a setter, so the write is swallowed and the guard silently stops guarding.
  ok((wjs.match(/Object\.create\(null\)/g) ?? []).length >= 2,
    '[scoped js] both key maps are prototype-less, a domain being report data');
  ok(/var OB_MOVING=Object\.create\(null\)/.test(wjs), '[scoped js] the in-flight map among them');
}


// ── what the billed count is made of, and the rows nothing bills ─────────────────────────────────────
// onebill-lib 0.6.0 splits a rule's credits into two kinds and reports them per row: `alsoCounts` PAYS
// for the thing (so a shortfall is real) and `entitles` PERMITS it (so headroom is not a finding). A row
// billed by nothing but an entitlement is `optional` — and one nobody is using is not a `match` worth
// reassuring anybody about.
const twoOffers = {
  group: 'Hosted Seats', dimension: 'extensions.withAnyDevice', dimensions: ['extensions.withAnyDevice'],
  billed: 4, entitled: 0, observed: 5, verdict: 'unbaselined',
  items: [accepted('ext:100', '100 Ann Lee'), accepted('ext:101', '101 Bo Chen'),
    accepted('ext:102', '102 Cy Diaz'), accepted('ext:103', '103 Dee Fox'), unreviewed('ext:104', '104 Eli Gray')],
  unreviewed: 1, untagged: 1, stale: 0, optional: false, credits: [],
  // Three accepted as Premium against two billed of it — the tally an operator who tags is looking for.
  offers: [{ name: 'Premium Hosted Phone Seat', quantity: 2, perUnit: 1, tagged: 3 },
    { name: 'Standard Hosted Phone Seat', quantity: 2, perUnit: 1, tagged: 0 }],
};
/** Every accepted item untagged: no offer says "0 tagged", which would be noise about a thing nobody did. */
const noneTagged = {
  group: 'Phone Number (DID)', dimension: 'dids.total', dimensions: ['dids.total'],
  billed: 10, entitled: 0, observed: 10, verdict: 'match',
  items: [accepted('did:+15550100', '+15550100'), accepted('did:+15550101', '+15550101')],
  unreviewed: 0, untagged: 2, stale: 0, optional: false, credits: [],
  offers: [{ name: 'Phone Numbers - Pack of 10', quantity: 1, perUnit: 10, tagged: 0 }],
};
/** Billed by nothing, entitled by a seat plan, and nobody is using it. The zero-quantity credit is a
 *  rule that landed here and contributed nothing, so it renders as nothing. */
const optionalUnused = {
  group: 'transcriptionEnabled', dimension: 'transcriptionEnabled', dimensions: ['transcriptionEnabled'],
  billed: 0, entitled: 8, observed: 0, verdict: 'match',
  items: [] as unknown[], unreviewed: 0, untagged: 0, stale: 0, optional: true, offers: [],
  credits: [{ from: 'Premium Hosted Phone Seat', kind: 'entitles', quantity: 8 },
    { from: 'Bundled Premium Seat', kind: 'entitles', quantity: 0 }],
};
/** The same shape, in use: the engine's verdict stands and the provenance line stays. */
const optionalUsed = {
  ...optionalUnused, group: 'smsNumbers', dimension: 'smsNumbers', dimensions: ['smsNumbers'],
  observed: 3, items: [unreviewed('sms:a', 'a'), unreviewed('sms:b', 'b'), unreviewed('sms:c', 'c')], unreviewed: 3,
  credits: [{ from: 'Premium Hosted Phone Seat', kind: 'entitles', quantity: 8 }],
};
/** A PACK: one line of quantity 1 that bills ten numbers. Three tagged to it is not an excess, which
 *  comparing tagged against the raw quantity would have called one. */
const packRow = {
  group: 'Number Pack', dimension: 'dids.total', dimensions: ['dids.total'],
  billed: 10, entitled: 0, observed: 10, verdict: 'match',
  items: [accepted('did:+15550110', '+15550110', undefined, 'Phone Numbers - Pack of 10'),
    accepted('did:+15550111', '+15550111', undefined, 'Phone Numbers - Pack of 10'),
    accepted('did:+15550112', '+15550112', undefined, 'Phone Numbers - Pack of 10')],
  unreviewed: 0, untagged: 0, stale: 0, optional: false, credits: [],
  offers: [{ name: 'Phone Numbers - Pack of 10', quantity: 1, perUnit: 10, tagged: 3 }],
};
/** TWO subscription lines of ONE plan, two seats each. `tagged` is a count per NAME and repeats across
 *  both lines rather than dividing between them, so five tagged is one over the four billed — said once,
 *  under the first line, because the excess is a fact about the plan and not about either line. */
const twoLinesOneName = {
  group: 'Bundled Seats', dimension: 'extensions.withAnyDevice', dimensions: ['extensions.withAnyDevice'],
  billed: 4, entitled: 0, observed: 5, verdict: 'unbaselined',
  items: [accepted('ext:110', '110 Fay Hall', undefined, 'Bundled Premium Seat'),
    accepted('ext:111', '111 Gil Iyer', undefined, 'Bundled Premium Seat'),
    accepted('ext:112', '112 Hana Jones', undefined, 'Bundled Premium Seat'),
    accepted('ext:113', '113 Ivo Kim', undefined, 'Bundled Premium Seat'),
    accepted('ext:114', '114 Jo Lane', undefined, 'Bundled Premium Seat')],
  unreviewed: 0, untagged: 0, stale: 0, optional: false, credits: [],
  // Spelled differently on the two lines, because the library matches names trimmed and
  // case-insensitively and this page must group them the same way the engine counted them.
  offers: [{ name: 'Bundled Premium Seat', quantity: 2, perUnit: 1, tagged: 5 },
    { name: ' bundled premium seat ', quantity: 2, perUnit: 1, tagged: 5 }],
};
/** A comparison-only row whose billed comes entirely from another rule PAYING for it. */
const creditedRow = {
  group: 'Call Center Seats', dimension: 'extensions.byScope.Call Center Agent',
  dimensions: ['extensions.byScope.Call Center Agent'],
  billed: 2, entitled: 0, observed: 2, verdict: 'match',
  unreviewed: 0, untagged: 0, stale: 0, optional: false, offers: [],
  credits: [{ from: 'Call Center Hosted Phone Seat', kind: 'alsoCounts', quantity: 2 }],
};
const OFFERS_ACCOUNT = () => ({
  ...ACCOUNT(),
  comparison: { ...ACCOUNT().comparison, rows: [twoOffers, noneTagged, packRow, twoLinesOneName, optionalUnused, optionalUsed, creditedRow] },
});

{
  const rw = renderAccountPanel(OFFERS_ACCOUNT() as never, true);
  const rowOf = (g: string) => rw.split('<tr data-verdict=').find((x) => x.includes(`data-group="${g}"`)) ?? '';

  const seats = rowOf('Hosted Seats');
  ok(seats.includes('<ul class="offers"><li>Premium Hosted Phone Seat x2 — 3 tagged (1 more tagged than billed)</li>'),
    '[offers] each offer is its own line, with the count accepted as it and the excess over what is billed');
  ok(seats.includes('<li>Standard Hosted Phone Seat x2 — 0 tagged</li>'),
    '[offers] and an offer nothing was tagged to still says so, once anything on the row is tagged');

  const dids = rowOf('Phone Number (DID)');
  ok(dids.includes('<li>Phone Numbers - Pack of 10 x1 (pack of 10)</li>'), '[offers] a pack still says how big it is');
  ok(!/tagged/.test(dids), '[offers] and a row where nothing is tagged says nothing about tagging');

  const trans = rowOf('transcriptionEnabled');
  ok(trans.includes('<span class="chip chip-optional">optional, unused</span>'),
    '[optional] a row billed by nothing, entitled, and unused wears optional, unused');
  ok(!/chip-match/.test(trans), '[optional] in place of the match the engine gives it');
  ok(trans.includes('class="idle"'), '[optional] and is greyed like any other row with nothing to do');
  ok(trans.includes('<li class="credit">included with Premium Hosted Phone Seat x8</li>'),
    '[optional] saying what includes it');
  ok(!/Bundled Premium Seat/.test(trans), '[optional] while a credit that contributed nothing renders as nothing');
  ok(trans.includes('data-col="billed">0 <span class="dim ent">+8 entitled</span></td>'),
    '[optional] and the Billed cell carries the headroom beside the count');

  const sms = rowOf('smsNumbers');
  ok(sms.includes('<span class="chip chip-match">match</span>'), '[optional] an entitlement in use keeps the engine\'s verdict');
  ok(sms.includes('<li class="credit">included with Premium Hosted Phone Seat x8</li>'), '[optional] and the same provenance line');
  ok(!/optional, unused/.test(sms), '[optional] and never the unused words');

  // The bill is quantity x PACK SIZE. Three numbers tagged to one pack of ten is well inside it, and
  // comparing tagged against the raw quantity of 1 called it a two-over excess.
  const pack = rowOf('Number Pack');
  ok(pack.includes('<li>Phone Numbers - Pack of 10 x1 (pack of 10) — 3 tagged</li>'),
    '[offers] a pack counts what it BILLS, so three tagged to a pack of ten is no excess');
  ok(!/more tagged than billed/.test(pack), '[offers] and says nothing about one');

  // `tagged` is a count per NAME and repeats across both lines of that name rather than dividing
  // between them, so the comparison is against the SUM: five tagged against two lines of two is one over.
  const twoLines = rowOf('Bundled Seats');
  ok(twoLines.includes('<li>Bundled Premium Seat x2 — 5 tagged (1 more tagged than billed)</li>'),
    '[offers] two lines of one plan are summed before the excess is worked out');
  ok((twoLines.match(/more tagged than billed/g) ?? []).length === 1,
    '[offers] and the excess is said once, under the first line - it is a fact about the plan, not the line');
  ok(twoLines.includes('<li> bundled premium seat  x2 — 5 tagged</li>'),
    '[offers] the second line still shows its own tally, spelled as the bill spells it');

  const cc = rowOf('Call Center Seats');
  ok(cc.includes('<li class="credit">via Call Center Hosted Phone Seat x2</li>'),
    '[offers] a credit that PAYS for the row reads via, not included with - the difference is whether a shortfall is real');
  ok(!/data-col="billed">2 <span class="dim ent"/.test(cc), '[offers] and a row nothing entitles carries no headroom note');

  // No row of the plain fixture carries 0.6.0's fields at all, which is what a report cached before
  // them looks like: it must render, and it must claim nothing.
  const old = renderAccountPanel(ACCOUNT() as never, true);
  ok(!/chip-optional/.test(old) && !/class="ent"/.test(old) && !/li class="credit"/.test(old),
    '[offers] a pre-0.6.0 cached report renders with none of it rather than throwing');

  for (const cw of [true, false]) {
    const rep = { ...OFFERS_ACCOUNT(), canWrite: cw };
    const out = runInNewContext(`${rowScript(cw)}\nobPanel(R)`, { R: rep }) as string;
    ok(out === renderAccountPanel(rep as never, cw), `[offers mirror] the client copy agrees (canWrite=${cw})`);
  }

  const doc = onebillHtml({ canWrite: true, version: 'test' });
  ok(doc.includes('.chip-optional'), '[optional] the stylesheet knows .chip-optional');
  ok(/ul\.offers \{/.test(doc) && /ul\.offers li\.credit \{/.test(doc), '[offers] and the offers list and its credit lines');
}

// ── the item list: controls on the left, checkboxes, and a bulk selection ────────────────────────────
// The row's OWN decision moved to the first cell beside a checkbox; the two controls that send an item
// somewhere else stayed on the right. Ticking boxes swaps the group's -all pair for a -selected pair,
// which the page re-renders through the SAME function that drew it.
{
  const rw = renderAccountPanel(ACCOUNT_SPLIT() as never, true);
  const ro = renderAccountPanel({ ...ACCOUNT_SPLIT(), canWrite: false } as never, false);
  const annItem = rw.split('<tr data-item-key=').find((x) => x.startsWith('"branch.example/ext:100"')) ?? '';
  ok(annItem !== '', '[sel] the item row renders');
  ok(annItem.startsWith('"branch.example/ext:100" data-status="unreviewed"><td class="sel">'),
    '[sel] whose FIRST cell is the selection cell, before the label');
  ok(/<td class="sel"><input type="checkbox" data-role="pick" data-key="branch\.example\/ext:100"><button type="button" class="btn small" data-act="accept-item"/.test(annItem),
    '[sel] carrying the box and then the row\'s own Accept, in that order');
  ok(annItem.indexOf('data-act="accept-item"') < annItem.indexOf('data-act="assign"'),
    '[sel] and the Move that sends it elsewhere is still further right');
  ok(/data-act="assign"[^>]*>Move<\/button><\/td>/.test(annItem), '[sel] in the act cell, which now ends the row');

  // A reader gets the cell but nothing in it, so the nested table has the same column count either way.
  const roItem = ro.split('<tr data-item-key=').find((x) => x.startsWith('"branch.example/ext:100"')) ?? '';
  ok(roItem.startsWith('"branch.example/ext:100" data-status="unreviewed"><td class="sel"></td><td>'),
    '[sel] a reader gets an empty selection cell, present so the columns still line up');
  ok(!/type="checkbox"/.test(ro) && !/data-act="accept-item"/.test(ro), '[sel] and no box or button anywhere in it');

  // A stale acceptance keeps its Clear and loses its box: the two bulk buttons count unreviewed and
  // accepted, so a ticked stale row would be carried by neither and the selection would say a number it
  // could not act on.
  const staleItem = rw.split('<tr data-item-key=').find((x) => x.startsWith('"other.example/did:+15550999"')) ?? '';
  ok(staleItem !== '' && /<td class="sel"><button type="button" class="btn small" data-act="clear-item"/.test(staleItem),
    '[sel] a stale item gets its Clear with no checkbox before it');
  ok((rw.match(/data-role="pick"/g) ?? []).length === 11,
    `[sel] so the panel has one box per non-stale item (${(rw.match(/data-role="pick"/g) ?? []).length})`);

  // One tick-everything box per item list, write build only.
  ok((rw.match(/data-role="pick-all"/g) ?? []).length === 6, '[sel] each item list is headed by one pick-all box');
  ok(rw.includes('<tr class="ihead"><td class="sel"><input type="checkbox" data-role="pick-all" aria-label="Select every unreviewed item"></td><td></td><td></td><td></td><td class="act"></td></tr>'),
    '[sel] whose header row has the same five cells as the rows under it, so the columns cannot drift');
  ok(rw.indexOf('<tr class="ihead">') < rw.indexOf('<tr data-item-key='), '[sel] and heads the list rather than trailing it');
  ok(!/pick-all/.test(ro), '[sel] a reader gets none - there is nothing to select');

  // The group cell with a selection, rendered by the same helper the change handler calls.
  const seats = (ACCOUNT_SPLIT().comparison.rows)[0]!;
  const none = groupCtlHtml(seats as never);
  ok(/data-act="accept-all"/.test(none) && !/data-act="accept-selected"/.test(none),
    '[sel] with nothing ticked the group offers Accept all, as before');
  const some = groupCtlHtml(seats as never, { unreviewed: 2, accepted: 1, keys: ['a', 'b', 'c'] });
  ok(some.includes('>Accept selected (2)</button>'), '[sel] with boxes ticked it offers Accept selected, counting the unreviewed ones');
  ok(some.includes('>Clear selected (1)</button>'), '[sel] and Clear selected, counting the accepted ones');
  ok(!/data-act="accept-all"|data-act="clear-all"/.test(some),
    '[sel] INSTEAD of the -all pair, not beside it - two buttons differing only by a number is a question for the reader');
  ok(/data-act="accept-selected" data-group="seats" data-count="2"/.test(some), '[sel] each carrying the count its confirmation says back');
  const onlyAccepted = groupCtlHtml(seats as never, { unreviewed: 0, accepted: 2, keys: ['a', 'b'] });
  ok(!/accept-selected/.test(onlyAccepted) && /clear-selected/.test(onlyAccepted),
    '[sel] a selection of accepted items offers only the clear');

  // The group-row pair is a fact about the ROW, not about what is ticked in it, so a selection leaves it
  // alone. The sms row of the plain fixture is the one with items AND a shortfall.
  const smsRow = (ACCOUNT().comparison.rows).find((r) => r.group === 'sms')!;
  ok(/data-act="accept-shortfall"/.test(groupCtlHtml(smsRow as never, { unreviewed: 1, accepted: 0, keys: ['a'] })),
    '[sel] a selection does not take the shortfall control away');

  // Both copies, on a report with a selection nowhere in it - the mirror only ever renders the default.
  for (const cw of [true, false]) {
    const rep = { ...ACCOUNT_SPLIT(), canWrite: cw };
    const out = runInNewContext(`${rowScript(cw)}\nobPanel(R)`, { R: rep }) as string;
    ok(out === renderAccountPanel(rep as never, cw), `[sel mirror] the client copy agrees on the new cells (canWrite=${cw})`);
  }

  const doc = onebillHtml({ canWrite: true, version: 'test' });
  ok(/table\.cmp table\.items td\.sel \{/.test(doc), '[sel] the stylesheet knows the selection cell');
  ok(/tr\[data-status="stale"\] td\.sel \+ td/.test(doc),
    '[sel] and strikes the LABEL of a stale row, not the live control now sitting first');
}

// ── the selection wiring, and billed-as ──────────────────────────────────────────────────────────────
{
  const wjs = scriptOf(onebillHtml({ canWrite: true, version: 'test' }));
  const rjs = scriptOf(onebillHtml({ canWrite: false, version: 'test' }));

  ok(/document\.addEventListener\('change',function/.test(wjs), '[pick js] one delegated change listener handles every box');
  ok(!/data-role="pick-all"/.test(rjs) && !/obPickedItems/.test(rjs), '[pick js] and a reader carries none of it');
  ok(/function obPickedItems\(/.test(wjs), '[pick js] the selection is read out of the DOM, never remembered across a swap');
  ok(/out\.unreviewed\+\+;out\.unreviewedKeys\.push\(k\)/.test(wjs),
    '[pick js] counted and collected by the row\'s own status, so the label and the payload cannot disagree');
  ok(/function obPickKeys\(p,action\)/.test(wjs) && /action==='accept'\?p\.unreviewedKeys:p\.acceptedKeys/.test(wjs),
    '[pick js] and each action sends only the half it applies to');
  ok(/if\(role==='pick-all'\)/.test(wjs) && /getAttribute\('data-status'\)==='unreviewed'\)ps\[i\]\.checked=t\.checked/.test(wjs),
    '[pick js] pick-all ticks the UNREVIEWED rows only - it must not arm Clear selected');
  // The cell is re-rendered from the same function the paint used; the ROWS are left alone, because
  // re-rendering them would throw away the ticks that caused the re-render.
  ok(/cell\.innerHTML=obGroupCtlHtml\(row,obPickedItems\(g\)\)/.test(wjs),
    '[pick js] a tick re-renders the group action cell alone, through the renderer that drew it');
  ok(/function obGroupOfEvent\(t\)\{var row=t&&t\.closest\?t\.closest\('tr\.items'\)/.test(wjs),
    '[pick js] the group is walked to, never built into a selector out of a rulebook name');
  ok(/var picked=\(act==='accept-selected'\|\|act==='clear-selected'\)\?obPickedItems\(group\):null/.test(wjs),
    '[pick js] the selection is read ONCE, when the button is clicked, so a later tick cannot change what was confirmed');
  ok(/Accept the '\+nc\+' selected unreviewed item/.test(wjs), '[pick js] Accept selected confirms, naming how many and which group');
  ok(/Clear the '\+nc\+' selected accepted item/.test(wjs), '[pick js] and Clear selected likewise');
  ok(wjs.includes("obSay('Nothing is selected on that row.')"), '[pick js] a -selected click with nothing ticked says so rather than sending an empty list');

  // Billed as.
  ok(/function obOfferSel\(offers,dflt\)\{if\(!offers\|\|offers\.length<2\)return ''/.test(wjs),
    '[billed-as] one offer gets no select - a control with one option asks a question with one answer');
  ok(/<span class="erow">'\+obOfferSel\(offers,dflt\)\+'<input data-role="note"/.test(wjs),
    '[billed-as] the picker and the note share one erow, being one answer to one question');
  ok(/cb\(f\.value\.trim\(\),sel\?sel\.value:\(\(offers&&offers\.length===1\)\?offers\[0\]:''\)\)/.test(wjs),
    '[billed-as] and a single offer still rides on the request, with nothing on screen to choose');
  ok(/if\(offer&&b\.action==='accept'\)\{b\.offer=offer;OB_OFFER_LAST\[group\]=offer\}/.test(wjs),
    '[billed-as] the payload gains offer only when there is one, and only on an accept');
  ok(/var OB_OFFER_LAST=Object\.create\(null\)/.test(wjs),
    '[billed-as] remembered per group in a prototype-less map, a group name being rulebook data');
  // Same lifetime as OB_OPEN: a plan chosen on one account must not default the picker on the next
  // account's identically-named group to something the operator never said there.
  ok(/OB_OPEN=\{\};OB_OFFER_LAST=Object\.create\(null\)\}\nfunction obPanelShow/.test(wjs),
    '[billed-as] and cleared when the panel closes');
  ok((wjs.match(/OB_OPEN=\{\};OB_OFFER_LAST=Object\.create\(null\)/g) ?? []).length === 2,
    '[billed-as] and again when a different panel is drawn');
  ok(/var offers=act==='accept-shortfall'\?\[\]:obOffersOf\(group\)/.test(wjs),
    '[billed-as] a shortfall gets no picker - it is a decision about a count, not about a plan');
  ok(/obNoteFor\(cell,offers,OB_OFFER_LAST\[group\]\|\|offers\[0\]\|\|'',send\)/.test(wjs),
    '[billed-as] defaulting to the last plan chosen on this group, else the first the row carries');
  ok(/obNoteFor\(cell,\[\],'',function\(note\)/.test(wjs), '[billed-as] while a move offers no plan at all');
  ok(!/data-role="offer"/.test(rjs), '[billed-as] and a reader carries no picker');
}

// ── what a thing IS: the DID line, the device line, and the extensions carrying nothing ─────────────
// netsapiens-lib 0.5.0 answers where a number routes, what the portal wrote on it, and every device on
// an extension. The panel's job here is to say those without making the reader open NetSapiens.
{
  const rw = renderAccountPanel(ACCOUNT_SPLIT() as never, true);
  const itemOf = (k: string) => rw.split('<tr data-item-key=').find((x) => x.startsWith(`"${k}"`)) ?? '';

  const tf = itemOf('branch.example/did:+15550100');
  ok(tf.includes('toll-free · to user 100 — Ann Lee · <span class="dim">Portal Created: User - 100</span>'),
    '[did] a number says its kind, where it routes and the note the portal left, in that order');
  const queue = rw.split('<tr data-unassigned-key=').find((x) => x.startsWith('"did:+15550999"')) ?? '';
  ok(queue.includes('<td>local · to queue 701 — Sales</td>'), '[did] and one with no note stops after the destination');
  ok(!/ · <span class="dim"><\/span>/.test(queue), '[did] rather than trailing an empty separator');

  const ann = itemOf('branch.example/ext:100');
  ok(ann.includes('<span class="dev" title="100a">100a Model A</span>'),
    '[dev] an extension names the device on it, and its model');
  ok(ann.includes('<span class="dev" title="100b">100b <span class="dim">(no model)</span></span>'),
    '[dev] a device with no model AND no kind says "(no model)" - the library placeholder "(unknown)" read as a rendering fault');
  ok(!/\(unknown\)/.test(ann.split('</td>')[1] ?? ''), '[dev] and the placeholder itself never reaches the chip');
  ok(/title="100a"/.test(ann) && /title="100b"/.test(ann),
    '[dev] each chip carries its device name as the title, so a truncated chip can still be identified');
  const bo = itemOf('branch.example/ext:101');
  ok(bo.includes('<span class="dev" title="101a">101a Model A</span>'), '[dev] a handset is named by its model');
  ok(bo.includes('<span class="dev" title="101r \u00b7 Acme App">101r Acme App</span>'),
    '[dev] a device with no model but a known kind says what KIND it is, rather than reporting a model missing');
  ok(bo.includes('<span class="dev dev-teams" title="101t \u00b7 Teams">101t Teams</span>'),
    '[dev] a Teams connector is listed beside the handsets, marked, and named by its kind');
  ok(!/101t \(unknown\)/.test(bo) && !/101t <span class="dim">\(no model\)/.test(bo),
    '[dev] and the connector never reports a model missing - it has none to have');
  ok(/title="101r \u00b7 Acme App"/.test(bo) && /title="101t \u00b7 Teams"/.test(bo),
    '[dev] the title carries the kind beside the name, so a truncated chip still says what the device is');
  const dee = itemOf('other.example/ext:201');
  ok(dee.includes('<div class="devs"><span class="dim">no device</span></div>'),
    '[dev] an extension carrying nothing says so');
  // A pre-0.5.0 cached record has no `devices` at all — different from an empty one, and it must not
  // claim "no device" about a thing it cannot see.
  ok(!/class="devs"/.test(renderAccountPanel(ACCOUNT() as never, true)),
    '[dev] while a report cached before the field says nothing about devices at all');
  // A record cached BEFORE 0.8.0 carries devices with no `suffix`/`kind` at all. The chip must fall back
  // to the model, and to "(no model)" when there is not one — never print "undefined".
  {
    const legacy = { ...ACCOUNT_SPLIT() } as Record<string, unknown>;
    const det = JSON.parse(JSON.stringify((legacy as { detail: unknown }).detail)) as { extensions: Array<{ devices?: Array<Record<string, unknown>> }> };
    for (const x of det.extensions) for (const d of x.devices ?? []) { delete d.suffix; delete d.kind; }
    legacy.detail = det;
    const out = renderAccountPanel(legacy as never, true);
    ok(!/undefined/.test(out), '[dev] a pre-0.8.0 cached device renders without printing "undefined"');
    ok(out.includes('<span class="dev" title="100a">100a Model A</span>'), '[dev] and it still says the model it has');
    ok(out.includes('<span class="dev" title="100b">100b <span class="dim">(no model)</span></span>'), '[dev] and "(no model)" for the one it has not');
    ok(out === runInNewContext(`${rowScript(true)}\nobPanel(R)`, { R: legacy }), '[dev mirror] and the client copy agrees on all of that');
  }

  // The Unassigned rows get the same cell, from the record on the row: `detail` is the ACCOUNT's slice,
  // and an unassigned item is by definition not in it.
  const una = rw.split('<tr data-unassigned-key=').find((x) => x.startsWith('"ext:300"')) ?? '';
  ok(una !== '', '[una] the unassigned extension renders');
  ok(/<td><span class="kind kind-ext">extension<\/span>300<\/td><td>Ed Ng, Annex <span class="dim">Basic User<\/span><div class="devs"><span class="dev" title="300a">300a Model B<\/span><\/div><\/td><td>site Annex is not linked/.test(una),
    '[una] with the kind chip first, then the same detail cell a placed item gets, then the reason');
  ok(una.includes('<option value="CLI00003">CLI00003 — Branch South</option>'),
    '[una] and a picker naming each candidate account, not just numbering it');

  // Extensions with nothing plugged in, under the inventory. A seat rule counting withAnyDevice already
  // excludes these, so the block explains the gap rather than offering anything to do about it.
  ok(rw.includes('<details class="nodev"><summary>Extensions without a device (1)</summary>'),
    '[nodev] the panel counts the extensions carrying nothing');
  ok(/<table class="nodev"><tbody><tr><td>201<\/td><td>Dee Fox · HQ · Basic User<\/td><\/tr><\/tbody><\/table>/.test(rw),
    '[nodev] and lists each by extension, name, site and scope');
  ok(rw.indexOf('What is on the phone system') < rw.indexOf('details class="nodev"'), '[nodev] under the inventory heading');
  ok(!/data-act=/.test(rw.slice(rw.indexOf('<details class="nodev"'))), '[nodev] with no control on it - it is a reading, not a decision');
  ok(!/class="nodev"/.test(renderAccountPanel(ACCOUNT() as never, true)),
    '[nodev] and no block at all where every extension has something');

  const doc = onebillHtml({ canWrite: true, version: 'test' });
  for (const rule of ['.devs {', '.dev {', '.dev-teams {', 'details.nodev {', 'table.nodev {']) {
    ok(doc.includes(rule), `[dev] the stylesheet knows ${rule.slice(0, -2)}`);
  }
}

// ── fax lines, the delta line, and rows that count the same things ──────────────────────────────────
// netsapiens-lib 0.7.0 splits fax lines out of the DID counts, and the panel has to say so in three
// places: the kind chip on an item, the inventory summary, and — because a number the portal hands to a
// fax server is a number like any other — the detail line that names where it goes.
{
  const rw = renderAccountPanel(ACCOUNT_SPLIT() as never, true);
  /** One item row's LABEL cell — the second, the checkbox cell being first on a write build. */
  const cellOf = (k: string): string => ((rw.split(`<tr data-item-key="${k}"`)[1] ?? '').split('</td><td>')[1] ?? '');
  /** One GROUP row: from its `data-group` attribute to the end of that `<tr>`, items excluded. Sliced
   *  rather than split, because the Details button inside the row carries `data-group` too. */
  const groupRow = (g: string): string => {
    const i = rw.indexOf(`data-group="${g}"`);
    return i < 0 ? '' : rw.slice(i, rw.indexOf('</tr>', i));
  };

  ok(cellOf('branch.example/did:+15550102').startsWith('<span class="kind kind-fax">fax line</span>+15550102'),
    '[fax] a number handed to the fax server is chipped a fax line, not a number');
  ok(cellOf('branch.example/did:+15550100').startsWith('<span class="kind kind-did">number</span>'),
    '[fax] while an ordinary number is still a number - the chip comes off the RECORD, the key says did: for both');
  const faxDetail = (rw.split('<tr data-item-key="branch.example/did:+15550102"')[1] ?? '').split('</tr>')[0] ?? '';
  ok(faxDetail.includes('local · to fax server · <span class="dim">Portal Created: Phonenumber -&gt; FaxServer</span>'),
    '[fax] it still says local or toll-free, and reads "to fax server" rather than printing the host');
  ok(!/66\.172\.52\.16|\d+\.\d+\.\d+\.\d+/.test(rw), '[fax] no fax server address reaches the page at all');

  // The Unassigned row has no `detail` entry to look up - `detail` is the account's slice - so its chip
  // is decided from the record on the row. The two routes to `fax` must agree.
  ok(rw.includes('<td><span class="kind kind-fax">fax line</span>+15550998</td>'),
    '[fax] an unassigned fax line is chipped the same way, from the record the row carries');
  ok(rw.includes('<td><span class="kind kind-did">number</span>+15550999</td>'),
    '[fax] and an unassigned number beside it is not');
  ok(rw.includes('<li>Fax lines - 1</li>'),
    '[fax] the inventory summary counts them on their own line - they are no longer inside Total, so without this they vanish');
  ok(onebillHtml({ canWrite: true, version: 't' }).includes('.kind-fax'),
    '[fax] and the stylesheet knows the class, or the chip renders as an unstyled word');

  // ── the delta line ────────────────────────────────────────────────────────────────────────────
  // Three numbers in three columns leave the reader to subtract, and the subtraction is not the obvious
  // one: entitlements are headroom above billed, so they come off the OVER direction and not the under.
  ok(groupRow('Fax Lines').includes('<div class="dim small">1 unbilled</div>'),
    '[delta] a row with more live than billed says how many are unbilled');
  ok(groupRow('numbers').includes('<div class="dim small">1 billed, not live</div>'),
    '[delta] and one paying for more than it runs says how many are billed and not live');
  ok(!/unbilled|billed, not live/.test(groupRow('seats')), '[delta] a row inside its range says nothing');
  ok(!/unbilled|billed, not live/.test(groupRow('sms')), '[delta] nor does a matched one-for-one row');
  ok(groupRow('Fax Lines').indexOf('1 unbilled') > groupRow('Fax Lines').indexOf('chip-unbaselined'),
    '[delta] the line sits after the verdict chip, not before it');

  // ── rows that count the same items ────────────────────────────────────────────────────────────
  // `addr:a-2` is on the e911 row AND on the e911-and-number row. Without this line the two rows read
  // as six addresses when the domain holds three.
  ok(groupRow('e911 with a number').includes('<div class="dim small">this one is among the 3 on e911</div>'),
    '[overlap] a row whose one item is on a bigger row says so, in the singular');
  ok(groupRow('e911').includes('<div class="dim small">1 of these is also on e911 with a number</div>'),
    '[overlap] and the bigger row says how many of ITS items are on the smaller one - "is" for one');
  ok(!/these 1 are among|1 of these are also/.test(rw),
    '[overlap] a sentence that does not agree with itself reads as a bug in the page, so neither plural form survives at n=1');
  ok(!/are among the|are also on/.test(groupRow('seats')), '[overlap] a row sharing nothing says nothing');
  ok(groupRow('e911').indexOf('are also on') < groupRow('e911').indexOf('<button'),
    '[overlap] the line sits under the group name, above the offers and the Details button');
}

// ── the scoped panel's awkward shapes, held byte-identical ───────────────────────────────────────────
// The two fixtures above cover the shapes the design is FOR. These are the ones it has to survive: a
// field the report omits, a list with nothing in it, a domain the read lost, and text that is markup.
// Each is compared client-to-server, because a branch only one copy takes is a divergence no fixture
// test would otherwise reach.
const SCOPED_INV = () => ({
  extensions: { total: 2, byScope: { 'Basic User': 2 }, byServiceCode: { premium: 2 }, byDeviceCount: { '1': 2 } },
  systemUsers: { total: 0, byServiceCode: {} }, transcriptionEnabled: 0,
  dids: { total: 2, tollFree: 0, local: 2, fax: 0, all: 2 }, e911Addresses: 1, smsNumbers: 0,
  devices: { total: 2, byModel: { 'Model A': 2 } },
});
/** The edge fixture's own account, and a minimal extension record for an Unassigned row to describe. */
const EDGE_ME = { accountNumber: 'CLI00050', accountName: 'Edge Co' };
const edgeExt = (key: string, name: string) => ({
  key, ext: key.slice(4), name, site: '', scope: 'Basic User', serviceCode: 'premium',
  transcription: false, teams: false, deviceCount: 0, deviceModels: [], devices: [], anyDevice: false,
});
const SCOPED = (over: Record<string, unknown>) => ({
  accountNumber: 'CLI00050', accountName: 'Edge Co',
  scopes: [{ domain: 'one.example' }, { domain: 'two.example', site: 'Dock' }],
  domains: ['one.example', 'two.example'], domain: 'one.example',
  loadedAt: '2026-09-04T00:00:00.000Z',
  inventory: SCOPED_INV(),
  detail: { extensions: [], systemUsers: [], dids: [], e911Addresses: [], smsNumbers: [] },
  domainTotals: { 'one.example': SCOPED_INV(), 'two.example': SCOPED_INV() },
  holders: { 'one.example': [EDGE_ME], 'two.example': [EDGE_ME] },
  readFailures: [], partial: false, unassigned: [],
  comparison: { examined: 1, rows: [], unmapped: [], ignored: [], catalogMisses: [] },
  baselinesEnabled: true, canWrite: true, ...over,
});
const scopedItem = (over: Record<string, unknown>) => ({
  key: 'one.example/ext:100', label: '100 Ann Lee', status: 'unreviewed',
  domain: 'one.example', attribution: 'domain', ...over,
});
const scopedRow = (items: unknown[]) => ({
  group: 'seats', dimension: 'extensions.total', dimensions: ['extensions.total'],
  billed: 2, observed: 2, verdict: 'match', items, unreviewed: items.length, stale: 0, offers: [],
});
const oneRow = (items: unknown[]) => ({ examined: 1, rows: [scopedRow(items)], unmapped: [], ignored: [], catalogMisses: [] });

/** The six shapes, each named by what it is testing rather than by what it contains. */
const EDGE_CASES: Array<[string, Record<string, unknown>]> = [
  // obUnaDomains' whole reason for existing: the list is NOT sorted by domain, so a contiguous-run
  // grouping would head three tables where there are two.
  ['unassigned interleaved across two domains', { unassigned: [
    { domain: 'two.example', key: 'ext:1', label: 'two-1', reason: 'site Dock is not linked', item: edgeExt('ext:1', 'two-1'), candidates: [EDGE_ME] },
    { domain: 'one.example', key: 'ext:2', label: 'one-2', reason: 'no site set', item: edgeExt('ext:2', 'one-2'), candidates: [EDGE_ME, { accountNumber: 'CLI00051', accountName: 'Edge Two' }] },
    { domain: 'two.example', key: 'ext:3', label: 'two-3', reason: 'no site set', item: edgeExt('ext:3', 'two-3'), candidates: [EDGE_ME], staleAssignment: 'CLI00099' },
  ] }],
  // Nothing could hold it. An empty <select> beside an Assign button is a control that can only be
  // clicked into a 400, so the row is reason-only.
  ['an unassigned item with no candidates', { unassigned: [
    { domain: 'one.example', key: 'addr:a-9', label: 'Orphan dock', reason: 'no account holds this domain', item: { key: 'addr:a-9', label: 'Orphan dock' }, candidates: [] },
  ] }],
  // The two `automatic` shapes the scoping module can produce, and the absence it can also produce.
  ['a manual item with no automatic at all', { comparison: oneRow([scopedItem({ attribution: 'manual' })]) }],
  ['automatic naming an account but no site', { comparison: oneRow([scopedItem({ attribution: 'manual', automatic: { accountNumber: 'CLI00051' } })]) }],
  // A domain whose snapshot failed has no entry in domainTotals, and must not print a line of zeroes.
  ['domainTotals missing a domain', { domainTotals: { 'one.example': { ...SCOPED_INV(), dids: { total: 9, tollFree: 0, local: 9 } } },
    readFailures: ['two.example: could not be read (503)'] }],
  // Every string on this panel is report data. One copy escaping and the other not is the divergence
  // the mirror exists to catch, and a quote is what breaks out of an attribute.
  ['quotes and angle brackets in a group, a site and a label', {
    scopes: [{ domain: 'one.example', site: 'S"<1>' }, { domain: 'two.example' }],
    unassigned: [{ domain: 'one.example', key: 'ext:<9>', label: 'la"bel', reason: 're<a>son & more',
      item: { ...edgeExt('ext:<9>', 'la"bel'), name: 'N"<a>me', site: 'S"<1>', devices: [{ name: 'd"<1>', model: 'M"<1>', teams: false, suffix: 'x', kind: 'K"<1>' }, { name: 'd"<2>', model: '', teams: false, suffix: 'y', kind: 'K"<2>' }] },
      candidates: [{ accountNumber: 'C"1', accountName: 'N"<ame>' }], staleAssignment: 'C<7>' }],
    comparison: { examined: 1, rows: [{ ...scopedRow([scopedItem({ label: 'l"a<b>el', site: 'S"<1>', attribution: 'manual', automatic: { accountNumber: 'C&3', site: 'S"<2>' } })]), group: 'g"<r>oup' }],
      unmapped: [], ignored: [], catalogMisses: [] } }],
  // A report cached before `holders` existed. The Move control is absent, not thrown over.
  ['holders absent entirely', { holders: undefined, comparison: oneRow([scopedItem({})]) }],
  // The Move picker's own escaping — an account number is report data like everything else here.
  ['a placed item another account could take', {
    holders: { 'one.example': [{ accountNumber: 'C"1', accountName: 'N"<ame>' }, EDGE_ME], 'two.example': [EDGE_ME] },
    comparison: oneRow([scopedItem({})]) }],
  // A shared address on a domain with a THIRD holder: Remove (this account is in the manual set) AND a
  // picker offering only the holder not on it yet. Offering CLI00051, which already holds it, would be a
  // control whose only outcome is a write that changes nothing.
  ['a shared address with a holder still addable', {
    holders: { 'one.example': [EDGE_ME, { accountNumber: 'CLI00051', accountName: 'Edge Two' }, { accountNumber: 'CLI00052', accountName: 'Edge Three' }], 'two.example': [EDGE_ME] },
    coBilled: { seats: { 'one.example/addr:a-1': [{ accountNumber: 'CLI00051', accountName: 'Edge Two', group: 'seats', billed: 2, entitled: 0 }] } },
    comparison: oneRow([scopedItem({ key: 'one.example/addr:a-1', label: 'Dock', attribution: 'manual',
      sharedWith: [{ accountNumber: 'CLI00051', accountName: 'Edge Two' }] })]) }],
  // A report cached before `coBilled` existed. The "also on" line still renders — the sharing is a fact
  // the panel knows — with no parenthetical, rather than throwing or printing an empty one.
  ['a shared item with no coBilled at all', {
    holders: { 'one.example': [EDGE_ME, { accountNumber: 'CLI00051', accountName: 'Edge Two' }], 'two.example': [EDGE_ME] },
    comparison: oneRow([scopedItem({ key: 'one.example/addr:a-1', label: 'Dock',
      sharedWith: [{ accountNumber: 'CLI00051' }] })]) }],
  // ONE domain, TWO sites of it. The where badge used to key off the domain count alone, so these rows —
  // which differ from each other by site and nothing else — all rendered bare.
  ['one domain held at two sites', {
    scopes: [{ domain: 'one.example', site: 'North' }, { domain: 'one.example', site: 'South' }],
    domains: ['one.example'], domainTotals: { 'one.example': SCOPED_INV() },
    holders: { 'one.example': [EDGE_ME] },
    comparison: oneRow([scopedItem({ site: 'North' }),
      scopedItem({ key: 'one.example/ext:101', label: '101 Bo Chen', site: 'South' })]) }],
  // Entitlement HEADROOM, which the delta line has to subtract before it calls anything unbilled. Three
  // live against two billed on a row entitled to two more is not a finding, and a delta that ignored
  // `entitled` would report one on a row using capacity somebody already paid for.
  ['an excess that the row is entitled to', { comparison: { examined: 1, rows: [{
    ...scopedRow([scopedItem({}), scopedItem({ key: 'one.example/ext:101', label: '101' }), scopedItem({ key: 'one.example/ext:102', label: '102' })]),
    group: 'seats', billed: 2, entitled: 2, observed: 3, verdict: 'match',
  }], unmapped: [], ignored: [], catalogMisses: [] } }],
  // Two rules counting the SAME extensions by different tests: every Call Center seat is also a Hosted
  // Seat. 3 and 2 read as 5 things unless the rows say otherwise, and only the smaller row can claim
  // containment.
  ['one row whose items are all on another', { comparison: { examined: 2, rows: [
    { ...scopedRow([scopedItem({}), scopedItem({ key: 'one.example/ext:101', label: '101' }), scopedItem({ key: 'one.example/ext:102', label: '102' })]),
      group: 'Hosted Seats', billed: 3, observed: 3 },
    { ...scopedRow([scopedItem({ key: 'one.example/ext:101', label: '101' }), scopedItem({ key: 'one.example/ext:102', label: '102' })]),
      group: 'Call Center Seats', billed: 2, observed: 2 },
  ], unmapped: [], ignored: [], catalogMisses: [] } }],
  // Two rows that merely INTERSECT. Neither contains the other, so neither may say "among": both give
  // the count and nothing more.
  ['two rows sharing some of their items', { comparison: { examined: 2, rows: [
    { ...scopedRow([scopedItem({}), scopedItem({ key: 'one.example/ext:101', label: '101' })]),
      group: 'Alpha', billed: 2, observed: 2 },
    { ...scopedRow([scopedItem({ key: 'one.example/ext:101', label: '101' }), scopedItem({ key: 'one.example/ext:102', label: '102' })]),
      group: 'Beta', billed: 2, observed: 2 },
  ], unmapped: [], ignored: [], catalogMisses: [] } }],
];
/** One edge fixture BY NAME. By index is how the two cases added for shared addresses silently
 *  renumbered every assertion below them — a fixture list is not a stable ordinal. */
const edge = (what: string): Record<string, unknown> => EDGE_CASES.find(([n]) => n === what)![1];
{
  for (const [what, over] of EDGE_CASES) {
    for (const cw of [true, false]) {
      const rep = { ...SCOPED(over), canWrite: cw };
      const out = runInNewContext(`${rowScript(cw)}\nobPanel(R)`, { R: rep }) as string;
      ok(out === renderAccountPanel(rep as never, cw), `[mirror] ${what} (canWrite=${cw})`);
    }
  }

  // Two of them also assert what they RENDER, not only that the copies agree — the mirror alone would
  // pass on two identically-wrong panels.
  const interleaved = renderAccountPanel(SCOPED(edge('unassigned interleaved across two domains')) as never, true);
  ok((interleaved.match(/<h3>Unassigned on /g) ?? []).length === 2,
    '[edge] two domains, two headings — the grouping does not depend on the list arriving sorted');
  ok(interleaved.indexOf('Unassigned on two.example') < interleaved.indexOf('Unassigned on one.example'),
    '[edge] in the order the items first name them');
  ok((interleaved.split('<h3>Unassigned on one.example</h3>')[1] ?? '').split('<h3>')[0]!.includes('one-2'),
    '[edge] with each item under its own domain');

  const noCands = renderAccountPanel(SCOPED(edge('an unassigned item with no candidates')) as never, true);
  ok(noCands.includes('data-unassigned-key="addr:a-9"'), '[edge] an item nothing can hold is still listed');
  ok(noCands.includes('no account holds this domain'), '[edge] with the reason it is here');
  ok(!/data-role="assign-to"/.test(noCands), '[edge] and no picker, there being nothing to pick');
  ok(!/data-act="assign"/.test(noCands), '[edge] nor an Assign that could only be clicked into a 400');

  const noAuto = renderAccountPanel(SCOPED(edge('a manual item with no automatic at all')) as never, true);
  ok(/<span class="chip chip-manual">manual<\/span>/.test(noAuto),
    '[edge] a manual item with nothing to disagree with is chipped without a title');
  const siteless = renderAccountPanel(SCOPED(edge('automatic naming an account but no site')) as never, true);
  ok(siteless.includes('title="automatically: CLI00051"'), '[edge] and automatic with no site names the account alone');

  const lostDomain = renderAccountPanel(SCOPED(edge('domainTotals missing a domain')) as never, true);
  ok(lostDomain.includes('of one.example: 2 extensions · 9 numbers'), '[edge] the domain that read gets its totals line');
  ok(!/of two\.example:/.test(lostDomain), '[edge] and the one that did not gets no line of zeroes');

  const entitledExcess = renderAccountPanel(SCOPED(edge('an excess that the row is entitled to')) as never, true);
  ok(!/unbilled|billed, not live/.test(entitledExcess),
    '[edge] three live against two billed, on a row entitled to two more, is not a delta - the entitlement is headroom, not a second thing to pay for');

  const subset = renderAccountPanel(SCOPED(edge('one row whose items are all on another')) as never, true);
  ok(subset.includes('<div class="dim small">these 2 are among the 3 on Hosted Seats</div>'),
    '[edge] a row whose every item is on a bigger row says so in those words');
  ok(subset.includes('<div class="dim small">2 of these are also on Call Center Seats</div>'),
    '[edge] and the bigger row counts how many of its own are over there');
  ok(!/these 3 are among/.test(subset), '[edge] containment is claimed by the SMALLER row only');

  const partialOverlap = renderAccountPanel(SCOPED(edge('two rows sharing some of their items')) as never, true);
  ok((partialOverlap.match(/1 of these is also on/g) ?? []).length === 2,
    '[edge] two rows that merely intersect each give the count');
  ok(!/are among the/.test(partialOverlap), '[edge] and neither claims containment, because neither has it');

  const noHolders = renderAccountPanel(SCOPED(edge('holders absent entirely')) as never, true);
  ok(/data-act="accept-item"/.test(noHolders), '[edge] a report cached before `holders` existed still draws its controls');
  ok(!/data-act="assign"/.test(noHolders), '[edge] minus the Move, which has no list to offer');
  const otherHolder = renderAccountPanel(SCOPED(edge('a placed item another account could take')) as never, true);
  ok(otherHolder.includes('<option value="C&quot;1">C&quot;1 — N&quot;&lt;ame&gt;</option>'),
    '[edge] an account number AND its name are escaped in the picker like every other report string');
  ok(!/value="CLI00050"/.test(otherHolder), '[edge] and the account already holding it is not offered as somewhere to move it');

  // A third holder that is NOT on the address yet: Remove and a picker, and the picker offers only the
  // account missing from the set — offering one already on it is a write that changes nothing.
  const addrEdge = renderAccountPanel(SCOPED(edge('a shared address with a holder still addable')) as never, true);
  ok(addrEdge.includes('>Remove from this account</button>'), '[edge] a manual shared address offers Remove');
  ok(addrEdge.includes('<option value="CLI00052">CLI00052 — Edge Three</option>'), '[edge] and a picker naming the holder not yet on it');
  ok(!/value="CLI00051"/.test(addrEdge), '[edge] never the co-holder already on it');
  ok(addrEdge.includes('also on CLI00051 — Edge Two (seats x2)'), '[edge] with the co-holder\'s own billed line, entitlement omitted at zero');
  ok(addrEdge.includes('data-act="assign" data-domain="one.example" data-key="addr:a-1"') && !/data-placed/.test(addrEdge),
    '[edge] the Assign adds an account and carries no data-placed - nothing here is being cleared');

  // A report cached before coBilled existed still says the item is shared; it just cannot say more.
  const noCo = renderAccountPanel(SCOPED(edge('a shared item with no coBilled at all')) as never, true);
  ok(noCo.includes('<div class="dim small also">also on CLI00051</div>'), '[edge] a shared item with no coBilled names the holder and stops there');

  // The where badge is about how many PLACES the account holds, not how many domains: two sites of one
  // domain are two places, and the rows differ from each other by exactly that.
  const twoSites = renderAccountPanel(SCOPED(edge('one domain held at two sites')) as never, true);
  ok(twoSites.includes('<span class="where">one.example / North</span>')
    && twoSites.includes('<span class="where">one.example / South</span>'),
    '[edge] a two-site single-domain account badges each item with its site');
  ok(!renderAccountPanel(SCOPED({ scopes: [{ domain: 'one.example' }], domains: ['one.example'], domainTotals: { 'one.example': SCOPED_INV() }, comparison: oneRow([scopedItem({})]) }) as never, true).includes('class="where"'),
    '[edge] while an account holding one whole domain still gets none');
}


// ── the SHIPPED bundle, not just the row script ──────────────────────────────────────────────────────
// Every mirror test above evaluates `rowScript(canWrite)`. THE PAGE SHIPS MORE THAN THAT: `pageScript()`
// splices the row script, the page wiring and — for a writer — `WRITE_JS` into ONE IIFE, so all three
// share a single function scope. A name declared in two of them is a redeclaration the LAST one wins.
//
// That is not hypothetical: `obWhere` was the item line's where badge in the row script AND the link
// confirmations' word for a site in `WRITE_JS`, so in the writer's shipped bundle every item line rendered
// `site [object Object]` while every test above passed, because none of them ran the bundle. These do.
{
  /** The IIFE's body — its wrapper and its boot call stripped, everything the page declares left behind. */
  const shippedBody = (canWrite: boolean): string => {
    const raw = scriptOf(onebillHtml({ canWrite, version: 't' })).trimEnd();
    const open = '(function(){', close = '})();', boot = "obLoad(false,'quick');";
    ok(raw.startsWith(open) && raw.endsWith(close), `[shipped] the bundle is one IIFE (canWrite=${canWrite})`);
    const inner = raw.slice(open.length, -close.length).trimEnd();
    ok(inner.endsWith(boot), `[shipped] whose last statement is the boot call (canWrite=${canWrite})`);
    return inner.slice(0, -boot.length);
  };

  // Enough DOM for the top-level wiring to run: every getElementById is guarded on this page, so null is
  // an honest answer, and `document.body` is the one node the boot path actually reads (data-prefilter).
  // Nothing here renders — the two renderers are pure functions of the report, which is the whole point.
  const stubs = () => {
    const el = { getAttribute: () => null };
    return {
      document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [], body: el },
      window: { addEventListener: () => {}, parent: null },
      setTimeout: () => 0, clearTimeout: () => {}, confirm: () => false,
    };
  };
  /** The two renderers, lifted out of the bundle the browser is served. */
  const shipped = (canWrite: boolean) => runInNewContext(
    `(function(){${shippedBody(canWrite)}\nreturn {panel:obPanel,rows:obRows}})()`, stubs(),
  ) as { panel: (r: unknown) => string; rows: (r: unknown) => string };

  for (const cw of [true, false]) {
    const run = shipped(cw);
    // The panel, over every account fixture this file has: the plain one, the scoped one on each of its
    // three branches, and the six awkward shapes.
    const panels: Array<[string, Record<string, unknown>]> = [
      ['ACCOUNT', ACCOUNT()],
      ['IDLE_ACCOUNT', IDLE_ACCOUNT()],
      ['OFFERS_ACCOUNT', OFFERS_ACCOUNT()],
      ['ACCOUNT_SPLIT', ACCOUNT_SPLIT()],
      ['ACCOUNT_SPLIT partial', { ...ACCOUNT_SPLIT(), partial: true }],
      ...EDGE_CASES.map(([what, over]) => [`EDGE ${what}`, SCOPED(over)] as [string, Record<string, unknown>]),
    ];
    for (const [what, base] of panels) {
      const rep = { ...base, canWrite: cw };
      ok(run.panel(rep) === renderAccountPanel(rep as never, cw), `[shipped] the bundle's panel matches the server one - ${what} (canWrite=${cw})`);
    }
    // And the links table, which is what the other half of the bundle draws.
    ok(run.rows(REPORT()) === renderRows(REPORT(), cw), `[shipped] and the bundle's rows match the server ones (canWrite=${cw})`);
  }

  // The instance is fixed above; THIS is the class. A second `function ob…(` of the same name anywhere in
  // one bundle is a silent override — no error, no warning, and the loser is whichever copy was written
  // first. Checked over the raw script text rather than by evaluating, because by evaluation time the
  // collision has already happened and only one of the two is left to find.
  for (const cw of [true, false]) {
    const raw = scriptOf(onebillHtml({ canWrite: cw, version: 't' }));
    const seen = new Map<string, number>();
    for (const m of raw.matchAll(/(?:^|[^\w$.])function\s+(ob[A-Za-z0-9_$]*)\s*\(/g)) {
      seen.set(m[1]!, (seen.get(m[1]!) ?? 0) + 1);
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([n, c]) => `${n} x${c}`);
    ok(dupes.length === 0, `[shipped] no ob-name is declared twice in one bundle (canWrite=${cw})${dupes.length ? ` - ${dupes.join(', ')}` : ''}`);
    ok(seen.size > 40, `[shipped] and the scan found the declarations at all (canWrite=${cw}, ${seen.size} names)`);
  }
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
