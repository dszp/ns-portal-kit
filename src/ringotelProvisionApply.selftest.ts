/** Offline tests for the Ringotel provisioning I/O half — catalog, fresh snapshots, the write steps.
 *  Recording fakes stand in for the read and write clients, so every assertion is about the exact
 *  call this module makes. pnpm test:provisionapply */
import {
  loadCatalog, loadDomainSnapshot, loadFleetSnapshot, applyStep, ProvisionRefused,
  type ProvisionReader, type ProvisionWriter, type Catalog, type DomainSnapshot, type ApplyInput,
} from './ringotelProvisionApply.js';
import type { ProvisionConfig } from './ringotelProvision.js';
import type { Organization, Branch, Rec, CreateOrgInput, UpdateOrgInput, CreateBranchInput } from '@dszp/ringotel-lib';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); };
const refuses = async (f: () => Promise<unknown>, status: 403 | 409 | 422, m: string) => {
  try { await f(); ok(false, `${m} (did not throw)`); }
  catch (e) {
    const r = e as ProvisionRefused;
    ok(e instanceof ProvisionRefused && r.status === status, `${m} [${r.status ?? 'bare Error'}]: ${(e as Error).message}`);
  }
};

// ── Fakes ──────────────────────────────────────────────────────────────────────────────────────────
type Call = [string, unknown];
interface FleetData { orgs: Organization[]; branches: Record<string, Branch[]>; templates?: Rec[]; packages?: Rec[]; regions?: Rec[] }

const reader = (f: FleetData): ProvisionReader & { calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    async getOrganizations() { calls.push(['getOrganizations', null]); return f.orgs; },
    async getBranches(orgid: string) { calls.push(['getBranches', orgid]); return f.branches[orgid] ?? []; },
    async getTemplates() { calls.push(['getTemplates', null]); return f.templates ?? []; },
    async getPackages() { calls.push(['getPackages', null]); return f.packages ?? []; },
    async getRegions() { calls.push(['getRegions', null]); return f.regions ?? []; },
  };
};

const writer = (): ProvisionWriter & { calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    async createOrganization(i: CreateOrgInput) { calls.push(['createOrganization', i]); return { id: 'org-new', ...i } as Organization; },
    async updateOrganization(id: string, c: UpdateOrgInput) { calls.push(['updateOrganization', { id, ...c }]); return { id, ...c } as Organization; },
    async createBranch(i: CreateBranchInput) { calls.push(['createBranch', i]); return { id: 'branch-new', ...i } as Branch; },
  };
};

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────────
const DOMAIN = 'acme.12345.service';
const PROVISION: Rec = { proxy: { paddr: 'sbc.example.net', ppass: 's3cret' }, codecs: ['opus'] };
/** A real template carries the address/domain/name of the connector it was saved from — the three
 *  fields a create must never inherit. The fixture keeps them so the test can prove it doesn't. */
const TEMPLATE: Rec = { id: 't1', name: 'Standard', created: 1_750_000_000_000, params: { country: 'GB', address: 'saved-from.example.com', domain: 'savedfrom', name: 'Saved From', provision: PROVISION } };
/** A SECOND usable template, saved more recently than the standard — so the catalog lists it FIRST. */
const PILOT_PROVISION: Rec = { proxy: { paddr: 'pilot.example.net' }, codecs: ['g722'] };
const TEMPLATE_PILOT: Rec = { id: 't2', name: 'Pilot', created: 1_757_000_000_000, params: { country: 'US', provision: PILOT_PROVISION } };
/** A template with no `provision` blob: it is still OFFERED (it exists in the tenant) and the create
 *  refuses it, because a connection built from it would have no PBX settings at all. */
const TEMPLATE_BARE: Rec = { id: 't3', name: 'Sketch', created: 1_700_000_000_000, params: { country: 'US' } };
/** No `created` at all — it sorts LAST, because "newest first" cannot place a template with no date. */
const TEMPLATE_UNDATED: Rec = { id: 't4', name: 'Legacy', params: { country: 'US', provision: PROVISION } };
const ALL_TEMPLATES: Rec[] = [TEMPLATE_UNDATED, TEMPLATE_BARE, TEMPLATE, TEMPLATE_PILOT];
const PACKAGES: Rec[] = [{ id: 3, name: 'Essentials' }, { id: 4, name: 'Pro' }];
const REGIONS: Rec[] = [{ id: '1', name: 'US East' }, { id: '2', name: 'EU West' }];

const ORG_ACME: Organization = { id: 'o1', domain: 'acme', name: 'Acme', packageid: 3, params: { sso: '1/x_sso', hidePassInEmail: true, emailcc: 'ops@example.com' } };
const ORG_DEMO: Organization = { id: 'o2', domain: 'demo', name: 'Demo', packageid: 4, params: {} };
const BR_ACME: Branch = { id: 'b1', orgid: 'o1', name: 'Ringotel', address: 'Acme.12345.Service:5061', country: 'US', provision: { proxy: { paddr: 'sbc.example.net' } } };
const BR_DEMO: Branch = { id: 'b2', orgid: 'o2', name: 'Ringotel', address: 'demo.12345.service' };

const FLEET: FleetData = { orgs: [ORG_ACME, ORG_DEMO], branches: { o1: [BR_ACME], o2: [BR_DEMO] }, templates: [TEMPLATE], packages: PACKAGES, regions: REGIONS };

const CFG = (over: Partial<ProvisionConfig> = {}): ProvisionConfig => ({
  rail: { wildcard: true, except: [] }, templateName: 'Standard', ssoServiceId: '1/x_sso',
  defaultPackage: 'Essentials', region: 'US East', connectionName: 'Ringotel', appLabel: 'Ringotel', ...over,
});
const CATALOG = (over: Partial<Catalog> = {}): Catalog => ({
  template: { id: 't1', name: 'Standard', params: TEMPLATE.params as Record<string, unknown> },
  templateProblem: null,
  templates: [
    { id: 't2', name: 'Pilot', created: 1_757_000_000_000, hasProvision: true, hasCountry: true, params: TEMPLATE_PILOT.params as Record<string, unknown> },
    { id: 't1', name: 'Standard', created: 1_750_000_000_000, hasProvision: true, hasCountry: true, params: TEMPLATE.params as Record<string, unknown> },
    { id: 't3', name: 'Sketch', created: 1_700_000_000_000, hasProvision: false, hasCountry: true, params: TEMPLATE_BARE.params as Record<string, unknown> },
    { id: 't4', name: 'Legacy', created: null, hasProvision: true, hasCountry: true, params: TEMPLATE_UNDATED.params as Record<string, unknown> },
  ],
  packages: [{ id: 3, name: 'Essentials' }, { id: 4, name: 'Pro' }],
  regions: [{ id: '1', name: 'US East' }, { id: '2', name: 'EU West' }],
  ...over,
});
const SNAP = (over: Partial<DomainSnapshot> = {}): DomainSnapshot => ({ orgs: [], orphans: [], org: null, orgCount: 0, orgCountBy: 'address', branches: [], ...over });
const INPUT = (over: Partial<ApplyInput> = {}): ApplyInput => ({ domain: DOMAIN, cfg: CFG(), catalog: CATALOG(), snap: SNAP(), choice: {}, ...over });

// ── Catalog ────────────────────────────────────────────────────────────────────────────────────────
{
  const r = reader(FLEET);
  const c = await loadCatalog(r, CFG());
  ok(c.template !== null && c.template.id === 't1' && c.template.name === 'Standard', '[catalog] the named template resolves to id + name');
  ok(c.template !== null && (c.template.params.provision as Rec) === PROVISION, '[catalog] the template params come through whole');
  ok(c.templateProblem === null, '[catalog] a resolved template has no problem');
  ok(JSON.stringify(c.packages) === JSON.stringify([{ id: 3, name: 'Essentials' }, { id: 4, name: 'Pro' }]), '[catalog] package ids are numbers');
  ok(c.regions.every((x) => typeof x.id === 'string') && c.regions[0]!.id === '1', '[catalog] region ids are strings');
  ok(JSON.stringify(r.calls.map(([m]) => m).sort()) === JSON.stringify(['getPackages', 'getRegions', 'getTemplates']), `[catalog] exactly the three catalog reads, each once: ${r.calls.map(([m]) => m).join(', ')}`);
}
{
  const c = await loadCatalog(reader({ ...FLEET, templates: [] }), CFG());
  ok(c.template === null && !!c.templateProblem && /RINGOTEL_CONNECTION_TEMPLATE/.test(c.templateProblem), '[catalog] an absent template is a problem naming the setting');
}
{
  // The sentence the page and the status console both render verbatim, so it says the operator's OWN
  // word for the app \u2014 a white-label deployment must not read the vendor's name in its own portal.
  const wl = CFG({ appLabel: 'Acme App', connectionName: 'Acme App' });
  const none = await loadCatalog(reader({ ...FLEET, templates: [] }), wl);
  ok(/Acme App tenant/.test(none.templateProblem ?? '') && !/Ringotel/.test(none.templateProblem ?? ''),
    `[catalog] the absent-template problem is named in the operator's own word for the app: ${none.templateProblem}`);
  const two = await loadCatalog(reader({ ...FLEET, templates: [TEMPLATE, { id: 't5', name: 'standard', params: {} }] }), wl);
  ok(/Acme App panel/.test(two.templateProblem ?? '') && !/Ringotel/.test(two.templateProblem ?? ''),
    `[catalog] and so is the ambiguous one: ${two.templateProblem}`);
}
{
  const c = await loadCatalog(reader({ ...FLEET, templates: [TEMPLATE, { id: 't2', name: 'standard', params: {} }] }), CFG());
  ok(c.template === null && /more than one|two/i.test(c.templateProblem ?? ''), `[catalog] two templates sharing the name are ambiguous: ${c.templateProblem}`);
}
{
  const c = await loadCatalog(reader({ ...FLEET, packages: [{ name: 'Broken' }], regions: [{ name: 'Nowhere' }] }), CFG());
  ok(c.packages.length === 0 && c.regions.length === 0, '[catalog] a catalog row with no usable id is dropped, never mapped to NaN');
}

// ── Catalog: EVERY template, newest first ──────────────────────────────────────────────────────────
// The create step offers the whole list, so the whole list has to come back — the configured standard
// is one row of it, not the only row. Order is a fact the picker shows and must not be re-derived there.
{
  const c = await loadCatalog(reader({ ...FLEET, templates: ALL_TEMPLATES }), CFG());
  ok(c.templates.map((t) => t.name).join(',') === 'Pilot,Standard,Sketch,Legacy',
    `[catalog] every template comes back, newest first, undated last (${c.templates.map((t) => t.name).join(',')})`);
  ok(c.templates[0]!.created === 1_757_000_000_000 && c.templates[3]!.created === null, '[catalog] each row carries its own created stamp, or null');
  ok(c.templates.find((t) => t.name === 'Sketch')!.hasProvision === false, '[catalog] a template with no provision blob is flagged');
  ok(c.templates.filter((t) => t.hasProvision).length === 3, '[catalog] and the three that carry one are not');
  ok(c.template?.name === 'Standard', '[catalog] while the configured standard still resolves to exactly one');
  ok(c.templates.every((t) => typeof t.params === 'object'), '[catalog] every row carries the params a create would build from');
}
{
  // A row nothing can name is a row nothing can choose: it would render as a blank option and no
  // `byName` could ever resolve it, so it is dropped rather than offered.
  const c = await loadCatalog(reader({ ...FLEET, templates: [TEMPLATE, { id: 't9', params: {} }, { id: 't8', name: '   ', params: {} }] }), CFG());
  ok(c.templates.length === 1 && c.templates[0]!.name === 'Standard', `[catalog] a nameless template is dropped from the picker (${c.templates.length})`);
}
{
  // Two templates sharing the configured name leave `template` null — and the PICKER still lists both,
  // because an operator can pick one by name only if the name is unambiguous. It is not, so a create
  // naming it would be refused by the same rule that refused the standard.
  const c = await loadCatalog(reader({ ...FLEET, templates: [TEMPLATE, { id: 't5', name: 'standard', created: 1, params: {} }] }), CFG());
  ok(c.template === null && c.templates.length === 2, '[catalog] an ambiguous standard still lists every template');
}

// ── Domain snapshot ────────────────────────────────────────────────────────────────────────────────
{
  const r = reader(FLEET);
  const s = await loadDomainSnapshot(r, DOMAIN, {});
  ok(s.orgCount === 1 && s.org?.id === 'o1', '[snapshot] matches through the branch address despite :port and case');
  ok(s.org?.packageid === 3 && (s.org?.params as Rec).emailcc === 'ops@example.com', '[snapshot] the org is the RAW record (packageid, params), not the index projection');
  ok(s.branches.length === 1 && s.branches[0]!.provision !== undefined, '[snapshot] the branches are the RAW records (provision), limited to this address');
  ok(s.orgs.length === 2, '[snapshot] the full org roster comes back for the label-collision check');
  ok(r.calls.length === 3 && r.calls[0]![0] === 'getOrganizations', `[snapshot] one dig: 1 + N calls, not 2 + 2N (${r.calls.length})`);
}
{
  const s = await loadDomainSnapshot(reader(FLEET), 'nobody.12345.service', {});
  ok(s.org === null && s.orgCount === 0 && s.branches.length === 0, '[snapshot] an unmatched domain resolves to no org');
  ok(s.orgs.length === 2, '[snapshot] an unmatched domain still carries the roster');
}
{
  const twoOrgs: FleetData = { ...FLEET, orgs: [ORG_ACME, { ...ORG_DEMO, id: 'o3' }], branches: { o1: [BR_ACME], o3: [{ id: 'b3', address: DOMAIN }] } };
  const s = await loadDomainSnapshot(reader(twoOrgs), DOMAIN, {});
  ok(s.orgCount === 2 && s.org === null && s.branches.length === 0, '[snapshot] two organizations claiming one domain ⇒ no org, count 2');
}
{
  const twoBranches: FleetData = { ...FLEET, branches: { o1: [BR_ACME, { id: 'b1b', address: DOMAIN, name: 'Pilot' }, { id: 'b1c', address: 'other.12345.service' }], o2: [BR_DEMO] } };
  const s = await loadDomainSnapshot(reader(twoBranches), DOMAIN, {});
  ok(s.orgCount === 1 && s.branches.length === 2, '[snapshot] one org with two connections at this address ⇒ count 1, both branches');
  ok(!s.branches.some((b) => b.id === 'b1c'), '[snapshot] a branch at a different address is not in the snapshot');
}
{
  const s = await loadDomainSnapshot(reader(FLEET), 'renamed.12345.service', { 'renamed.12345.service': 'demo.12345.service' });
  ok(s.org?.id === 'o2', '[snapshot] RINGOTEL_OVERRIDES maps the domain to a REPLACEMENT ADDRESS');
}

// ── The orphaned organization: created, never connected ────────────────────────────────────────────
// An enable whose `org` step succeeded and whose `connector` step then failed leaves an organization that
// answers to no address at all — the index is per-branch. Before adoption the next run saw no
// organization, offered to create one, and `applyOrg` refused it because the derived domain name was
// taken; the "run the connection step instead" it suggested refused in its turn. A dead end on the page's
// main path, reachable by one failed API call.
const ORG_ORPHAN: Organization = { id: 'o7', domain: 'acme', name: 'Acme Co', packageid: 3, params: {} };
const FLEET_ORPHAN: FleetData = { ...FLEET, orgs: [ORG_DEMO, ORG_ORPHAN], branches: { o2: [BR_DEMO], o7: [] } };
{
  const s = await loadDomainSnapshot(reader(FLEET_ORPHAN), DOMAIN, {});
  ok(s.org?.id === 'o7' && s.orgCount === 1, '[orphan] an organization holding the derived domain name with NO connection is adopted as this domain\u2019s');
  ok(s.adopted === true, '[orphan] and the snapshot says so, so the refusals can name what happened');
  ok(s.branches.length === 0, '[orphan] with no connections, which is what makes the connector step a create');
  ok(s.orphans.length === 1 && s.orphans[0]!.id === 'o7', '[orphan] the connection-less roster carries exactly that record');
}
{
  // The same organization once it HAS a connection somewhere else: it belongs to another domain, and
  // adopting it would point this domain’s users at that customer’s organization.
  const elsewhere: FleetData = { ...FLEET, orgs: [ORG_DEMO, ORG_ORPHAN], branches: { o2: [BR_DEMO], o7: [{ id: 'b7', orgid: 'o7', address: 'somewhere.12345.service' }] } };
  const s = await loadDomainSnapshot(reader(elsewhere), DOMAIN, {});
  ok(s.orgCount === 0 && s.org === null && !s.adopted, '[orphan] an organization with a connection at ANOTHER address is never adopted');
  ok(s.orphans.length === 0, '[orphan] and is not on the connection-less roster at all');
}
{
  const other: FleetData = { ...FLEET, orgs: [ORG_DEMO, { ...ORG_ORPHAN, domain: 'acme-pilot' }], branches: { o2: [BR_DEMO], o7: [] } };
  const s = await loadDomainSnapshot(reader(other), DOMAIN, {});
  ok(s.orgCount === 0 && s.org === null, '[orphan] a connection-less organization under a DIFFERENT domain name is not this domain\u2019s');
  ok(s.orphans.length === 1, '[orphan] though it is still on the roster, which is what the name rule reads');
}
{
  // Two claimants is the same refusal two matching organizations have always produced: no single
  // organization, so no write. Ringotel should not permit it; the snapshot does not assume that.
  const twins: FleetData = { ...FLEET, orgs: [ORG_ORPHAN, { ...ORG_ORPHAN, id: 'o8' }], branches: { o7: [], o8: [] } };
  const s = await loadDomainSnapshot(reader(twins), DOMAIN, {});
  ok(s.orgCount === 2 && s.org === null && !s.adopted, '[orphan] two connection-less organizations holding the derived name are ambiguous, not adopted');
}
{
  // The resumption itself: org is a refusal that says what to do, sign-in and connector run.
  const adopted = SNAP({ orgs: [ORG_ORPHAN], orphans: [ORG_ORPHAN], org: ORG_ORPHAN, orgCount: 1, adopted: true });
  const w = writer();
  await refuses(() => applyStep('org', w, INPUT({ snap: adopted })), 409, '[orphan] a deliberate re-run of the org step on an adopted organization is refused');
  try { await applyStep('org', writer(), INPUT({ snap: adopted })); } catch (e) {
    ok(/connection step/.test((e as Error).message), `[orphan] saying to run the connection step \u2014 which is now true: ${(e as Error).message}`);
  }
  ok(w.calls.length === 0, '[orphan] and no second organization is created');

  const wc = writer();
  const out = await applyStep('connector', wc, INPUT({ snap: adopted }));
  ok(out.action === 'created' && (wc.calls[0]![1] as CreateBranchInput).orgid === 'o7', '[orphan] the connection is created UNDER the adopted organization');
  ok((wc.calls[0]![1] as CreateBranchInput).address === DOMAIN, '[orphan] at this domain\u2019s address');

  const ws = writer();
  const sig = await applyStep('signin', ws, INPUT({ snap: adopted }));
  ok(sig.action === 'updated' && (ws.calls[0]![1] as Rec).id === 'o7', '[orphan] and the sign-in step reaches it too, so an `all` run finishes what the first one started');
}

{
  // The count `adoptOrphan` leaves behind is a statement about NAMES, not addresses — nothing answers to
  // this domain's address at all. A refusal saying two organizations "claim this domain" would send an
  // operator looking for connections neither of them has.
  const twins: FleetData = { ...FLEET, orgs: [ORG_ORPHAN, { ...ORG_ORPHAN, id: 'o8' }], branches: { o7: [], o8: [] } };
  const s2 = await loadDomainSnapshot(reader(twins), DOMAIN, {});
  ok(s2.orgCountBy === 'name', '[orphan] the snapshot says the count is about names, not addresses');
  try { await applyStep('org', writer(), INPUT({ snap: s2 })); } catch (e) {
    ok(/without a connection hold this domain/.test((e as Error).message) && !/claim this domain/.test((e as Error).message),
      `[orphan] and the refusal says which tenant to go and fix: ${(e as Error).message}`);
  }
  try { await applyStep('connector', writer(), INPUT({ snap: s2 })); } catch (e) {
    ok(/without a connection hold this domain/.test((e as Error).message), '[orphan] the later steps say it too, from the same clause');
  }
  const matched = await loadDomainSnapshot(reader({ ...FLEET, orgs: [ORG_ACME, { ...ORG_DEMO, id: 'o3' }], branches: { o1: [BR_ACME], o3: [{ id: 'b3', address: DOMAIN }] } }), DOMAIN, {});
  ok(matched.orgCountBy === 'address', '[orphan] while two organizations really answering to the address still count by address');
  try { await applyStep('org', writer(), INPUT({ snap: matched })); } catch (e) {
    ok(/claim this domain/.test((e as Error).message), '[orphan] and keep the sentence that has always been true of them');
  }
}

// ── The custom-label retry: the orphan the derived name cannot find ────────────────────────────────
// A first attempt under an operator-chosen label leaves an organization whose domain name this domain
// does not derive, so neither adoption nor the derived-name check sees it. The retry’s label input has
// gone back to the derivation, and the create would add a SECOND organization for one customer. The name
// is the only handle left.
const ORPH_PILOT: Organization = { id: 'o9', domain: 'acme-pilot', name: 'Acme Co', params: {} };
{
  const snap = SNAP({ orgs: [ORPH_PILOT], orphans: [ORPH_PILOT] });
  const w = writer();
  await refuses(() => applyStep('org', w, INPUT({ snap, choice: { label: 'acme-two', orgName: 'Acme Co' } })), 422, '[orphan] a custom label is refused while a connection-less organization already carries the name this create would give');
  ok(w.calls.length === 0, '[orphan] with no organization created');
  try { await applyStep('org', writer(), INPUT({ snap, choice: { label: 'acme-two', orgName: 'Acme Co' } })); } catch (e) {
    ok(/"acme-pilot"/.test((e as Error).message), `[orphan] and the refusal names the domain name to type instead: ${(e as Error).message}`);
  }
  await refuses(() => applyStep('org', writer(), INPUT({ snap, choice: { label: 'acme-two', orgName: '  ACME co  ' } })), 422, '[orphan] the name is matched trimmed and case-insensitively, as every catalog name on this page is');
}
{
  // Not every collision: a different name is a different customer, and the label rule below still guards
  // the domain name itself.
  const snap = SNAP({ orgs: [ORPH_PILOT], orphans: [ORPH_PILOT] });
  const w = writer();
  await applyStep('org', w, INPUT({ snap, choice: { label: 'acme-two', orgName: 'Initech' } }));
  ok((w.calls[0]![1] as CreateOrgInput).domain === 'acme-two', '[orphan] a connection-less organization with an unrelated name does not block the create');
}
{
  // The DERIVED label never trips this rule \u2014 adoption is what handles a derived-label retry, and
  // refusing here too would make the one path that resumes cleanly the one path that cannot.
  const snap = SNAP({ orgs: [ORPH_PILOT], orphans: [ORPH_PILOT] });
  const w = writer();
  await applyStep('org', w, INPUT({ snap, choice: { orgName: 'Acme Co' } }));
  ok((w.calls[0]![1] as CreateOrgInput).domain === 'acme', '[orphan] the derived label is never refused by the name rule');
}

// ── …and the retry that types it back: adoption by the CHOSEN label ────────────────────────────────
// The refusal above names a domain name for the operator to set. The page prefills it, and the resubmitted
// run has to RESUME — anything else is a second dead end behind the first, telling somebody to type the
// value they just typed.
{
  const orphanFleet: FleetData = { ...FLEET, orgs: [ORG_DEMO, { id: 'o9', domain: 'acme-pilot', name: 'Acme Co', packageid: 3, params: {} }], branches: { o2: [BR_DEMO], o9: [] } };
  const bare = await loadDomainSnapshot(reader(orphanFleet), DOMAIN, {});
  ok(bare.orgCount === 0 && !bare.adopted, '[resume] with no label typed, the derived name does not reach an organization created under a custom one');

  const s3 = await loadDomainSnapshot(reader(orphanFleet), DOMAIN, {}, 'acme-pilot');
  ok(s3.adopted === true && s3.org?.id === 'o9' && s3.orgCount === 1, '[resume] typing that label adopts it');
  ok(s3.branches.length === 0, '[resume] with no connection, so the connector step is still a create');
  ok((await loadDomainSnapshot(reader(orphanFleet), DOMAIN, {}, '  ACME-Pilot ')).org?.id === 'o9', '[resume] matched trimmed and case-insensitively, like every other label comparison here');
  ok((await loadDomainSnapshot(reader(orphanFleet), DOMAIN, {}, 'something-else')).orgCount === 0, '[resume] while an unrelated label adopts nothing');

  // What the resubmitted Enable-all does with it, step by step.
  const w = writer();
  await refuses(() => applyStep('org', w, INPUT({ snap: s3, choice: { label: 'acme-pilot', orgName: 'Acme Co' } })), 409, '[resume] the org step is a refusal a run SKIPS as a noop, never a second create');
  ok(w.calls.length === 0, '[resume] and writes nothing');
  try { await applyStep('org', writer(), INPUT({ snap: s3, choice: { label: 'acme-pilot', orgName: 'Acme Co' } })); } catch (e) {
    ok(/"acme-pilot"/.test((e as Error).message) && /connection step/.test((e as Error).message),
      `[resume] naming the record's OWN domain name, not the derivation: ${(e as Error).message}`);
  }
  const wc = writer();
  const out = await applyStep('connector', wc, INPUT({ snap: s3, choice: { label: 'acme-pilot', orgName: 'Acme Co' } }));
  ok(out.action === 'created' && (wc.calls[0]![1] as CreateBranchInput).orgid === 'o9', '[resume] and the connection is created under it');

  // Two connection-less organizations, one under each name, is a tenant nothing here can choose between.
  const both: FleetData = { ...FLEET, orgs: [{ id: 'oA', domain: 'acme', name: 'A' }, { id: 'oB', domain: 'acme-pilot', name: 'B' }], branches: { oA: [], oB: [] } };
  const amb = await loadDomainSnapshot(reader(both), DOMAIN, {}, 'acme-pilot');
  ok(amb.orgCount === 2 && amb.org === null && amb.orgCountBy === 'name', '[resume] the derived name and the typed one are one candidate set, not a preference order');
}
{
  // The duplication refusal survives where it is still true: the typed label names NO unfinished record,
  // and an unfinished record already carries the name this create would give.
  const orph: Organization = { id: 'o9', domain: 'acme-pilot', name: 'Acme Co', params: {} };
  const snap = SNAP({ orgs: [orph], orphans: [orph] });
  await refuses(() => applyStep('org', writer(), INPUT({ snap, choice: { label: 'acme-three', orgName: 'Acme Co' } })), 422, '[resume] a THIRD label with the same name is still the duplication case');
  // …and is gone where it is not: the label names that very record.
  const w = writer();
  await refuses(() => applyStep('org', w, INPUT({ snap, choice: { label: 'acme-pilot', orgName: 'Acme Co' } })), 422, '[resume] typing the named label never produces the "set the domain name to" loop');
  try { await applyStep('org', writer(), INPUT({ snap, choice: { label: 'acme-pilot', orgName: 'Acme Co' } })); } catch (e) {
    ok(!/Set the domain name to "acme-pilot"/.test((e as Error).message),
      `[resume] \u2014 a hand-built snapshot that skipped adoption refuses on the label being taken, never by asking for the value just submitted: ${(e as Error).message}`);
  }
  ok(w.calls.length === 0, '[resume] and nothing is created on either path');
}

// ── Fleet snapshot ─────────────────────────────────────────────────────────────────────────────────
{
  const r = reader(FLEET);
  const f = await loadFleetSnapshot(r);
  ok(r.calls.length === 3, `[fleet] exactly 1 + N calls for a two-org fleet (${r.calls.map(([m]) => m).join(', ')})`);
  ok(r.calls.filter(([m]) => m === 'getBranches').length === 2, '[fleet] getBranches runs once per org, never twice');
  ok(f.orgs.length === 2 && f.orgs[0] === ORG_ACME, '[fleet] the raw orgs come back');
  ok(f.branchesByOrg.o1?.[0] === BR_ACME && f.branchesByOrg.o2?.[0] === BR_DEMO, '[fleet] branches are keyed by orgid');
  ok(f.index.length === 2 && f.index.some((e) => e.orgid === 'o1' && e.address === BR_ACME.address), '[fleet] the index is the library projection');
}

// ── applyStep: org ─────────────────────────────────────────────────────────────────────────────────
await refuses(() => applyStep('org', writer(), INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1 }) })), 409, '[org] refuses when an organization already answers to this domain');
await refuses(() => applyStep('org', writer(), INPUT({ snap: SNAP({ org: null, orgCount: 2 }) })), 409, '[org] refuses when two organizations claim the domain');
await refuses(() => applyStep('org', writer(), INPUT({ snap: SNAP({ org: null, orgCount: 1, branches: [BR_ACME] }) })), 409, '[org] refuses on a standing match even when the raw org record is missing');
await refuses(() => applyStep('org', writer(), INPUT({ snap: SNAP({ orgs: [{ id: 'o9', domain: 'acme-pilot' }] }), choice: { label: 'acme-pilot' } })), 422, '[org] refuses a chosen label another organization already holds');
{
  // The half-finished enable: an org exists from a previous run but its connector never got created,
  // so it contributes NO index rows and `snap.org` is null. A different label must not create a second.
  const w = writer();
  await refuses(() => applyStep('org', w, INPUT({ snap: SNAP({ orgs: [{ id: 'o9', domain: 'acme' }] }), choice: { label: 'acme-two' } })), 422, '[org] refuses when the DERIVED label is already held, whatever label was chosen');
  ok(w.calls.length === 0, '[org] a domain whose derived label is taken produces no createOrganization call');
}
{
  const w = writer();
  await applyStep('org', w, INPUT({ snap: SNAP({ orgs: [{ id: 'o9', domain: 'demo' }] }), choice: { label: 'acme-two' } }));
  ok(w.calls.length === 1 && (w.calls[0]![1] as CreateOrgInput).domain === 'acme-two', '[org] a roster holding neither label lets the create proceed');
}
await refuses(() => applyStep('org', writer(), INPUT({ choice: { pkg: 'Platinum' } })), 422, '[org] refuses a package this tenant does not offer');
await refuses(() => applyStep('org', writer(), INPUT({ cfg: CFG({ region: 'Mars' }) })), 422, '[org] refuses a region this tenant does not offer');
await refuses(() => applyStep('org', writer(), INPUT({ choice: { orgName: 'x'.repeat(65) } })), 422, '[org] refuses an organization name over 64 characters');
await refuses(() => applyStep('org', writer(), INPUT({ choice: { orgName: 'Acme\u0007Inc' } })), 422, '[org] refuses an organization name with a control character');
await refuses(() => applyStep('org', writer(), INPUT({ choice: { orgName: '   ' } })), 422, '[org] refuses a blank organization name');
await refuses(() => applyStep('org', writer(), INPUT({ choice: { label: 'Acme Inc!' } })), 422, '[org] refuses a label the label rule rejects');
{
  const w = writer();
  const out = await applyStep('org', w, INPUT());
  const sent = w.calls[0]![1] as CreateOrgInput;
  ok(w.calls.length === 1 && w.calls[0]![0] === 'createOrganization', '[org] one createOrganization call');
  ok(sent.domain === 'acme', '[org] the org domain is the derived label');
  ok(sent.name === 'acme', '[org] the org name defaults to the label');
  ok(sent.region === '1' && typeof sent.region === 'string', '[org] the region is sent as the string id');
  ok(sent.packageid === 3 && typeof sent.packageid === 'number', '[org] the package is sent as the numeric id');
  ok((sent.params as Rec).hidePassInEmail === true, '[org] passwords are kept out of welcome emails');
  ok((sent.params as Rec).sso === '1/x_sso', '[org] SSO mode binds the configured service id');
  ok(out.step === 'org' && out.action === 'created' && out.orgid === 'org-new', '[org] the outcome carries the new orgid');
  ok(JSON.stringify(Object.keys(sent).sort()) === JSON.stringify(['domain', 'name', 'packageid', 'params', 'region']), `[org] exactly five fields are sent, nothing spread in: ${Object.keys(sent).sort().join(', ')}`);
}
{
  const w = writer();
  await applyStep('org', w, INPUT({ choice: { label: 'acme-pilot' } }));
  ok((w.calls[0]![1] as CreateOrgInput).domain === 'acme-pilot', '[org] an operator’s chosen label REPLACES the derived one');
}
{
  const w = writer();
  await applyStep('org', w, INPUT({ choice: { label: '   ' } }));
  ok((w.calls[0]![1] as CreateOrgInput).domain === 'acme', '[org] a blank chosen label falls back to the derivation, as the planner says it will');
}
{
  const w = writer();
  await applyStep('org', w, INPUT({ choice: { signin: 'credentials' } }));
  const p = (w.calls[0]![1] as CreateOrgInput).params as Rec;
  ok(!('sso' in p) && p.hidePassInEmail === true, '[org] credentials mode sends no sso key at all');
}
{
  const w = writer();
  await applyStep('org', w, INPUT({ cfg: CFG({ ssoServiceId: null }) }));
  ok(!('sso' in ((w.calls[0]![1] as CreateOrgInput).params as Rec)), '[org] with no SSO service configured, no sso key is sent');
}
{
  const w = writer();
  await applyStep('org', w, INPUT({ choice: { orgName: 'Acme Incorporated', label: 'ACME', pkg: 'Pro' } }));
  const sent = w.calls[0]![1] as CreateOrgInput;
  ok(sent.name === 'Acme Incorporated' && sent.domain === 'acme', '[org] a chosen display name never becomes the label');
  ok(sent.packageid === 4, '[org] a chosen package wins over RINGOTEL_DEFAULT_PACKAGE');
}

// ── applyStep: signin ──────────────────────────────────────────────────────────────────────────────
await refuses(() => applyStep('signin', writer(), INPUT()), 409, '[signin] refuses without an organization');
await refuses(() => applyStep('signin', writer(), INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 2 }) })), 409, '[signin] refuses when two organizations claim the domain');
{
  const org = { ...ORG_ACME, params: { emailcc: 'ops@example.com', sso: 'stale/id' } };
  const w = writer();
  const out = await applyStep('signin', w, INPUT({ snap: SNAP({ org, orgCount: 1 }) }));
  const sent = (w.calls[0]![1] as Rec).params as Rec;
  ok(out.action === 'updated' && w.calls[0]![0] === 'updateOrganization', '[signin] a differing sign-in mode is an update');
  ok(sent.sso === '1/x_sso', '[signin] SSO mode sets the service id');
  ok(!('hidePassInEmail' in sent), '[signin] and does NOT touch the welcome-email setting — that is not a sign-in setting, and this step must not change an operator\'s own choice about it');
  ok(sent.emailcc === 'ops@example.com', '[signin] the update MERGES the organization’s existing params');
  ok((w.calls[0]![1] as Rec).id === 'o1', '[signin] the update addresses the org by id');
}
{
  const w = writer();
  const out = await applyStep('signin', w, INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1 }) }));
  ok(out.action === 'noop' && w.calls.length === 0, '[signin] an already-matching organization is a noop with no write');
}
{
  // The live bug this rule came from: a domain whose SSO was perfectly bound reported "SSO mismatch"
  // because its welcome emails included the password. The two are unrelated — one decides how a person
  // signs in, the other what an activation email contains — and the fix rewrote a setting nobody asked
  // about. Now it is a noop with no write at all.
  const org = { ...ORG_ACME, params: { sso: '1/x_sso', hidePassInEmail: false } };
  const w = writer();
  const out = await applyStep('signin', w, INPUT({ snap: SNAP({ org, orgCount: 1 }) }));
  ok(out.action === 'noop' && w.calls.length === 0, '[signin] the right sso with hidePassInEmail false is a NOOP — the welcome-email setting is not a sign-in setting');
}
{
  const org = { ...ORG_ACME, params: { hidePassInEmail: false } };
  const w = writer();
  const out = await applyStep('signin', w, INPUT({ snap: SNAP({ org, orgCount: 1 }), choice: { signin: 'credentials' } }));
  ok(out.action === 'noop' && w.calls.length === 0, '[signin] credentials with hidePassInEmail false is a noop too');
}
{
  const w = writer();
  const out = await applyStep('signin', w, INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1 }), choice: { signin: 'credentials' } }));
  ok(out.action === 'updated' && ((w.calls[0]![1] as Rec).params as Rec).sso === '', '[signin] credentials mode CLEARS sso to the empty string');
}
{
  const org = { ...ORG_ACME, params: {} };
  const w = writer();
  const out = await applyStep('signin', w, INPUT({ snap: SNAP({ org, orgCount: 1 }), choice: { signin: 'credentials' } }));
  ok(out.action === 'noop' && w.calls.length === 0, '[signin] credentials is a noop when sso is ABSENT');
}
{
  const org = { ...ORG_ACME, params: { sso: '', hidePassInEmail: true } };
  const w = writer();
  const out = await applyStep('signin', w, INPUT({ snap: SNAP({ org, orgCount: 1 }), choice: { signin: 'credentials' } }));
  ok(out.action === 'noop' && w.calls.length === 0, "[signin] credentials is a noop when sso is already ''");
}
{
  const org = { ...ORG_ACME, params: { sso: 'anything', hidePassInEmail: false } };
  const w = writer();
  const out = await applyStep('signin', w, INPUT({ snap: SNAP({ org, orgCount: 1 }), cfg: CFG({ ssoServiceId: null }) }));
  ok(out.action === 'noop' && w.calls.length === 0, '[signin] with no SSO service configured the step never writes');
}

// ── applyStep: connector ───────────────────────────────────────────────────────────────────────────
await refuses(() => applyStep('connector', writer(), INPUT()), 409, '[connector] refuses without an organization');
await refuses(() => applyStep('connector', writer(), INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 2 }) })), 409, '[connector] refuses when two organizations claim the domain');
await refuses(() => applyStep('connector', writer(), INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1, branches: [BR_ACME] }) })), 409, '[connector] refuses when a connection already exists at this address');
await refuses(() => applyStep('connector', writer(), INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1 }), catalog: CATALOG({ template: null, templateProblem: 'absent' }) })), 422, '[connector] refuses when the template has not resolved');
await refuses(() => applyStep('connector', writer(), INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1 }), catalog: CATALOG({ template: { id: 't1', name: 'Standard', params: { country: 'US' } } }) })), 422, '[connector] refuses a template that carries no provision blob');
{
  const w = writer();
  const out = await applyStep('connector', w, INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1 }) }));
  const sent = w.calls[0]![1] as CreateBranchInput;
  ok(w.calls.length === 1 && w.calls[0]![0] === 'createBranch', '[connector] one createBranch call');
  ok(sent.address === DOMAIN, '[connector] the address is the NS domain');
  ok(sent.address !== (TEMPLATE.params as Rec).address, '[connector] the address is NOT the template’s saved-from address');
  ok(sent.name === 'Ringotel', '[connector] the name is RINGOTEL_LABEL, not the template’s name');
  ok(!('domain' in sent), '[connector] the template’s domain is never copied');
  ok(sent.orgid === 'o1', '[connector] the connection is created under the matched org');
  ok(sent.country === 'GB', '[connector] the country comes from the template');
  ok(sent.provision === PROVISION, '[connector] the provision blob is passed through by reference, unedited');
  ok(out.step === 'connector' && out.action === 'created' && out.branchid === 'branch-new' && out.orgid === 'o1', '[connector] the outcome carries both ids');
  ok(JSON.stringify(Object.keys(sent).sort()) === JSON.stringify(['address', 'country', 'name', 'orgid', 'provision']), `[connector] exactly five fields are sent — no template field can arrive by a future spread: ${Object.keys(sent).sort().join(', ')}`);
}
{
  const w = writer();
  await applyStep('connector', w, INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1 }), cfg: CFG({ connectionName: 'Acme App' }) }));
  ok((w.calls[0]![1] as CreateBranchInput).name === 'Acme App', '[connector] a white-label RINGOTEL_LABEL names the connection');
}
// ── a template naming no country is refused, never defaulted ───────────────────────────────────────
// `country: String(t.params.country ?? 'US')` made an unfinished template into a connection quietly
// dialling as American — wrong outside the US, silent everywhere, and permanent, because nothing here
// ever rewrites a connection it created.
{
  const noCountry = CATALOG({ template: { id: 't1', name: 'Standard', params: { provision: PROVISION } } });
  const w = writer();
  await refuses(() => applyStep('connector', w, INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1 }), catalog: noCountry })), 422, '[connector] a template naming no country is refused rather than defaulted to US');
  ok(w.calls.length === 0, '[connector] with no connection created from it');
  try { await applyStep('connector', writer(), INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1 }), catalog: noCountry })); } catch (e) {
    ok(/"Standard"/.test((e as Error).message) && /country/i.test((e as Error).message), `[connector] and the refusal names the template and the missing field: ${(e as Error).message}`);
  }
  // An EMPTY country is the same absence — a template field somebody cleared says no more than one
  // nobody filled, and `String('' ?? 'US')` would have shipped '' rather than falling back at all.
  await refuses(() => applyStep('connector', writer(), INPUT({ snap: SNAP({ org: ORG_ACME, orgCount: 1 }), catalog: CATALOG({ template: { id: 't1', name: 'Standard', params: { country: '  ', provision: PROVISION } } }) })), 422, '[connector] a blank country is refused too');
  // The picker is drawn from the SAME predicate, so what the page offers is what this accepts.
  const cat = await loadCatalog(reader({ ...FLEET, templates: [TEMPLATE, { id: 't5', name: 'Countryless', created: 5, params: { provision: PROVISION } }] }), CFG());
  ok(cat.templates.find((t) => t.name === 'Countryless')?.hasCountry === false, '[catalog] a template naming no country is flagged for the picker to disable');
  ok(cat.templates.find((t) => t.name === 'Standard')?.hasCountry === true, '[catalog] while one that names a country is not');
  ok(cat.templates.find((t) => t.name === 'Countryless')?.hasProvision === true, '[catalog] and the two reasons are reported apart — this one has PBX settings, just no country');
}

// ── applyStep: connector, with a template CHOSEN on create ─────────────────────────────────────────
// The choice is resolved against every template in the tenant, not against the configured standard —
// which is the whole point: the standard is the audit's yardstick, and a create may legitimately be made
// from a different one. Absent still means the standard, so an untouched form creates what it always did.
const LIVE = SNAP({ org: ORG_ACME, orgCount: 1 });
{
  const w = writer();
  const out = await applyStep('connector', w, INPUT({ snap: LIVE, choice: { template: 'Pilot' } }));
  const sent = w.calls[0]![1] as CreateBranchInput;
  ok(sent.provision === PILOT_PROVISION, '[connector] the CHOSEN template supplies the provision blob');
  ok(sent.country === 'US', '[connector] and its country');
  ok(sent.address === DOMAIN && sent.name === 'Ringotel', '[connector] while the address and the name are still this deployment’s, never the template’s');
  ok(out.template === 'Pilot', `[connector] the outcome names the template it was created from (${out.template})`);
}
{
  const w = writer();
  const out = await applyStep('connector', w, INPUT({ snap: LIVE, choice: { template: '  pIlOt ' } }));
  ok((w.calls[0]![1] as CreateBranchInput).provision === PILOT_PROVISION, '[connector] the name is matched trimmed and case-insensitively, as byName matches everywhere else');
  ok(out.template === 'Pilot', '[connector] and the outcome carries the CATALOG’s spelling, not the caller’s');
}
{
  const w = writer();
  const out = await applyStep('connector', w, INPUT({ snap: LIVE }));
  ok((w.calls[0]![1] as CreateBranchInput).provision === PROVISION, '[connector] no choice ⇒ the configured standard, unchanged');
  ok(out.template === undefined, '[connector] and the outcome says nothing — the standard is already named on the page');
}
{
  const w = writer();
  const out = await applyStep('connector', w, INPUT({ snap: LIVE, choice: { template: 'Standard' } }));
  ok((w.calls[0]![1] as CreateBranchInput).provision === PROVISION, '[connector] choosing the standard by name is the same create');
  ok(out.template === undefined, '[connector] and says nothing either');
}
{
  const w = writer();
  await applyStep('connector', w, INPUT({ snap: LIVE, choice: { template: '   ' } }));
  ok((w.calls[0]![1] as CreateBranchInput).provision === PROVISION, '[connector] a blank choice falls back to the standard');
}
await refuses(() => applyStep('connector', writer(), INPUT({ snap: LIVE, choice: { template: 'Nonesuch' } })), 422, '[connector] a template name this tenant does not offer is a 422 naming the value');
{
  const w = writer();
  try { await applyStep('connector', w, INPUT({ snap: LIVE, choice: { template: 'Nonesuch' } })); } catch (e) {
    ok(/"Nonesuch"/.test((e as Error).message), `[connector] and the refusal quotes it back: ${(e as Error).message}`);
  }
  ok(w.calls.length === 0, '[connector] with nothing created');
}
await refuses(() => applyStep('connector', writer(), INPUT({ snap: LIVE, choice: { template: 'Sketch' } })), 422, '[connector] a chosen template with no provision blob is refused by the same rule the standard is');
{
  // Two templates sharing a name is exactly what leaves `Catalog.template` null for the standard, and a
  // chosen name is no different: `byName` would hand back whichever the API listed first, and the
  // operator would have no way to tell which connector they got. Refused, on a live shared tenant.
  const twins = CATALOG({ templates: [
    { id: 't6', name: 'Twin', created: 2, hasProvision: true, params: { provision: PROVISION } },
    { id: 't7', name: 'twin', created: 1, hasProvision: true, params: { provision: PILOT_PROVISION } },
  ] });
  const w = writer();
  await refuses(() => applyStep('connector', w, INPUT({ snap: LIVE, catalog: twins, choice: { template: 'Twin' } })), 422, '[connector] an AMBIGUOUS chosen name is refused rather than resolved to whichever came first');
  ok(w.calls.length === 0, '[connector] with no connection created from either of them');
}

await refuses(() => applyStep('package' as unknown as 'org', writer(), INPUT()), 422, '[apply] an unrecognised step is a 422 refusal, not a fault');

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
