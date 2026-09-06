/**
 * Pure unit tests for the OneBill config module (no network, no Worker).
 *   tsx src/onebill.selftest.ts
 */
import { onebillEnabled, onebillConfigError, parseDeviceSuffixes, resolveOnebillConfig, rulesUseCatalog, CacheTokenCache, buildLinkReport, loadLinkReport, applyLinks, refreshAppliedAccounts, patchReportAccounts, allowedTargets, allowedAccounts, existingLinks, applyBounds, groupSetup, setupChecklist, ONEBILL_SETUP_TITLE, OnebillRequestError, REFRESH_COOLDOWN_S, type NsDomainInfo, type AccountRef, type SetupCheck } from './onebill.js';
import { targetKey as targetKeyT } from '@dszp/onebill-lib';
import type { GatherResult, UsageReconcileRow, SourcedLink, Subscription } from '@dszp/onebill-lib';

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${m}`);
};

const base = { ONEBILL_TENANT_ID: 't1', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p' };

/**
 * A read source answering with the subscriber RECORD a set of gather rows describes: one PBX group
 * instance per link, exactly as OneBill returns them. `applyLinks` now reads each account it is about
 * to touch and builds that account's bounds from this, so every test that writes has to say what the
 * record actually holds — which is the point: the fixture states it once, and the join and the write
 * path read the same fact rather than two.
 */
const readerFor = (rows: { accountNumber: string; links: { value: string; qualifier?: string }[] }[]) => ({
  getSubscriber: async (n: string) => {
    const r = rows.find((x) => x.accountNumber === n);
    return {
      accountNumber: n,
      accountAttribute: (r?.links ?? []).map((l, i) => ({
        key: 'PBX', aggregator: i + 1,
        childAttribute: [{ key: 'Domain', value: l.value }, ...(l.qualifier ? [{ key: 'Site', value: l.qualifier }] : [])],
      })),
    } as any;
  },
});
/** An account holding nothing in this namespace — the bounds then rest on `targets` alone. */
const noRecords = readerFor([]);

ok(!onebillEnabled({}), 'off with nothing set');
ok(!onebillEnabled({ ...base, ONEBILL_PASSWORD: '' }), 'off when any of the four is empty');
ok(onebillEnabled(base), 'on with all four');

const cfg = resolveOnebillConfig(base);
ok(cfg.mapping.length === 1 && cfg.mapping[0]!.group === 'PBX' && cfg.mapping[0]!.ns === 'NS'
  && cfg.mapping[0]!.valueField === 'Domain' && cfg.mapping[0]!.qualifierField === 'Site', 'default mapping is PBX/NS/Domain/Site');
ok(cfg.ns === 'NS', 'ns comes from the mapping');
ok(cfg.offerNames.length === 0, 'no usage offers by default');
ok(cfg.usageIgnore.join('|') === '_OLD', 'retirement markers default to _OLD');
ok(cfg.baseUrl === undefined, 'no base url by default');

const custom = resolveOnebillConfig({ ...base, ONEBILL_LINK_GROUP: '{"group":"PHONE","ns":"PBX","valueField":"Tenant","qualifierField":"Branch"}', ONEBILL_USAGE_OFFERS: ' Domain Usage , Extra ', ONEBILL_BASE_URL: 'https://api.example.com/' });
ok(custom.mapping[0]!.group === 'PHONE' && custom.ns === 'PBX', 'custom mapping parsed');
ok(custom.offerNames.join('|') === 'Domain Usage|Extra', 'offers trimmed, empties dropped');
ok(custom.baseUrl === 'https://api.example.com/', 'base url passed through as given — ONEBILL_BASE_URL keeps its trailing slash');

const ignores = resolveOnebillConfig({ ...base, ONEBILL_USAGE_IGNORE: ' _RETIRED , ,_dead ' });
ok(ignores.usageIgnore.join('|') === '_RETIRED|_dead', 'retirement markers trimmed, empties dropped');
ok(resolveOnebillConfig({ ...base, ONEBILL_USAGE_IGNORE: '  ' }).usageIgnore.join('|') === '_OLD',
  'a blank setting is unset, not "ignore nothing" — an empty marker would match every identifier');

ok(onebillConfigError(base) === null, 'no error on defaults');
ok(/ONEBILL_LINK_GROUP/.test(onebillConfigError({ ...base, ONEBILL_LINK_GROUP: '{nope' }) ?? ''), 'malformed group JSON names the setting');
ok(/ONEBILL_LINK_GROUP/.test(onebillConfigError({ ...base, ONEBILL_LINK_GROUP: '{"group":"PBX"}' }) ?? ''), 'missing fields name the setting');
ok(/ONEBILL_LINK_GROUP/.test(onebillConfigError({ ...base, ONEBILL_LINK_GROUP: '{"group":"PBX","ns":"lower","valueField":"D"}' }) ?? ''), 'ns must match [A-Z][A-Z0-9]{0,7}');
ok(/ONEBILL_BASE_URL/.test(onebillConfigError({ ...base, ONEBILL_BASE_URL: 'http://plain.example' }) ?? ''), 'base url must be https');
ok(onebillConfigError({}) === null, 'off is not an error');

// -- NS_DEVICE_SUFFIXES ----------------------------------------------------------------------------
// The legend that says what a device-name suffix means here. Validated in `resolveOnebillConfig` — and
// so reported by `onebillConfigError` — because the status page is the one place a bad setting gets
// NAMED to an operator; failing only at read time would surface as an unlabelled chip instead.
{
  const suf = (v: string | undefined) => onebillConfigError({ ...base, NS_DEVICE_SUFFIXES: v }) ?? '';
  ok(parseDeviceSuffixes(undefined) === undefined, 'unset parses to undefined, which is what says "use the library default"');
  ok(parseDeviceSuffixes('   ') === undefined, 'and so does a blank value');
  ok(JSON.stringify(parseDeviceSuffixes('{}')) === '{}', 'but an EMPTY object is honoured as written - "no suffix means anything here" is a legitimate thing to say');

  const legend = parseDeviceSuffixes('{"WP":{"label":"  SNAPmobile Web  "},"t":{"label":"Teams","teams":true},"r":{"label":"Acme App","teams":false}}')!;
  ok(legend.wp!.label === 'SNAPmobile Web', 'a label is trimmed, and the key is lower-cased so the library matches it case-insensitively');
  ok(legend.t!.teams === true, 'teams: true survives');
  ok(legend.r!.teams === undefined, 'and teams: false is dropped rather than carried - absent and false are the same thing');
  ok(suf('{"wp":{"label":"SNAPmobile Web"}}') === '', 'a valid legend is not an error');

  ok(/not valid JSON/.test(suf('{nope')), 'malformed JSON names the setting');
  ok(/must be a JSON object/.test(suf('[{"wp":1}]')), 'an array is refused - the legend is an object');
  ok(/must be a JSON object/.test(suf('"wp"')), 'and so is a bare string');
  ok(/1-8 letters or digits/.test(suf('{"w-p":{"label":"x"}}')), 'a suffix with punctuation in it is refused');
  ok(/1-8 letters or digits/.test(suf('{"":{"label":"x"}}')), 'and an empty one');
  ok(/1-8 letters or digits/.test(suf('{"abcdefghi":{"label":"x"}}')), 'and one over eight characters');
  ok(/needs a non-empty "label"/.test(suf('{"wp":{}}')), 'an entry with no label is refused');
  ok(/needs a non-empty "label"/.test(suf('{"wp":{"label":"  "}}')), 'and a blank one');
  ok(/40 characters or fewer/.test(suf(`{"wp":{"label":"${'x'.repeat(41)}"}}`)), 'a label over 40 characters is refused - a chip is not a sentence');
  ok(/"teams" must be true or false/.test(suf('{"wp":{"label":"x","teams":"yes"}}')), 'teams must be a boolean, not a truthy string');
  ok(/must be an object/.test(suf('{"wp":"SNAPmobile Web"}')), 'a bare label string is refused - the entry is an object');
  ok(/NS_DEVICE_SUFFIXES/.test(suf('{"w p":{"label":"x"}}')), 'and every one of those errors names the setting');
}

// -- ONEBILL_RECURRING_RULES ---------------------------------------------------------------------
{
  const good = '[{"offer":"Seat","counts":"extensions.total","group":"seats"},{"offer":"Pack","counts":"dids.total","perUnit":10},{"offer":"E911","counts":"e911Addresses","alsoCounts":{"dids.total":1}}]';
  const cfg = resolveOnebillConfig({ ...base, ONEBILL_RECURRING_RULES: good });
  ok(cfg.recurringRules.length === 3, 'three rules parsed');
  ok(cfg.recurringRules[0]!.group === 'seats', 'the group survives');
  ok(cfg.recurringRules[1]!.perUnit === 10, 'perUnit survives');
  ok(cfg.recurringRules[2]!.alsoCounts!['dids.total'] === 1, 'alsoCounts survives');
  ok(resolveOnebillConfig(base).recurringRules.length === 0, 'absent means no rules, not an error');
  ok(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: good }) === null, 'a valid rulebook is not an error');

  const bad = (v: string): string => onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: v }) ?? '';
  ok(/ONEBILL_RECURRING_RULES/.test(bad('{nope')), 'malformed JSON names the setting');
  ok(/ONEBILL_RECURRING_RULES/.test(bad('{"offer":"x"}')), 'a non-array names the setting');
  // A group is a LABEL an operator reads on the panel, so the readable forms are legal: spaces,
  // parentheses, an ampersand, a slash. Markup-significant characters still are not.
  ok(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"offer":"x","counts":"dids.total","group":"Phone Number (DID)"}]' }) === null, 'a group label may carry parentheses');
  ok(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"offer":"x","counts":"dids.total","group":"E911 & Number"}]' }) === null, 'and an ampersand');
  ok(/short label/.test(bad('[{"offer":"x","counts":"dids.total","group":"<b>seats</b>"}]')), 'but not angle brackets');
  ok(/ONEBILL_RECURRING_RULES/.test(bad('[{"counts":"dids.total"}]')), 'a rule with no offer is refused');
  ok(/ONEBILL_RECURRING_RULES/.test(bad('[{"offer":"x"}]')), 'a rule with no counts is refused');
  ok(/ONEBILL_RECURRING_RULES/.test(bad('[{"offer":"x","counts":"dids total"}]')), 'a counts path with a space is refused');
  ok(/ONEBILL_RECURRING_RULES/.test(bad('[{"offer":"x","counts":"dids.total","perUnit":0}]')), 'perUnit must be a positive number');
  ok(/ONEBILL_RECURRING_RULES/.test(bad('[{"offer":"x","counts":"dids.total","alsoCounts":{"dids.total":"1"}}]')), 'an alsoCounts value must be a number');
  ok(/offer/.test(bad('[{"counts":"dids.total"}]')), 'and the message names the field that is wrong, not just the setting');

  // -- rulebook v2: planCode/productCode keys, path lists, ignore, keyless rows, and the widened COUNTS_RE --
  const rulesOf = (json: string) => resolveOnebillConfig({ ...base, ONEBILL_RECURRING_RULES: json }).recurringRules;
  ok(rulesOf('[{"planCode":"STD24","counts":"extensions.total","group":"seats"}]')[0]!.planCode === 'STD24', 'planCode is a rule key');
  ok(rulesOf('[{"productCode":"SEAT","counts":"extensions.total","group":"seats"}]')[0]!.productCode === 'SEAT', 'productCode is a rule key');
  ok(Array.isArray(rulesOf('[{"group":"cc","counts":["extensions.byScope.A","extensions.byScope.B"]}]')[0]!.counts), 'counts may be an array');
  ok(rulesOf('[{"group":"cc","counts":"extensions.byScope.A"}]')[0]!.offer === undefined, 'a rule with no key is a comparison-only row');
  ok(rulesOf('[{"offer":"Fax","ignore":true}]')[0]!.ignore === true, 'ignore rules parse');
  ok(/exactly one/.test(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"offer":"A","planCode":"B","counts":"dids.total"}]' }) ?? ''), 'two keys on one rule is an error');
  ok(/needs "counts"/.test(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"offer":"A"}]' }) ?? ''), 'no counts and no ignore is an error');
  ok(/not both/.test(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"offer":"A","counts":"dids.total","ignore":true}]' }) ?? ''), 'counts and ignore together is an error');
  ok(/needs an offer/.test(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"ignore":true}]' }) ?? ''), 'a bare ignore rule with no key names what it is missing');
  ok(/needs a "group"/.test(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"counts":"dids.total"}]' }) ?? ''), 'a keyless rule must name its group');
  ok(/alsoCounts/.test(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"offer":"A","counts":"dids.total","alsoCounts":{"bad key!":1}}]' }) ?? ''), 'alsoCounts keys are a dotted path or a group label');

  // `entitles` is the other credit map: same key vocabulary, same value rule, validated by the same
  // loop — a divergence between the two would be a rulebook that parses one way and reads another.
  ok(rulesOf('[{"offer":"A","counts":"extensions.total","entitles":{"smsNumbers":1}}]')[0]!.entitles!.smsNumbers === 1, 'entitles survives the parse');
  ok(rulesOf('[{"offer":"A","counts":"extensions.total","entitles":{"Call Center Seats":2},"alsoCounts":{"dids.total":1}}]')[0]!.alsoCounts!['dids.total'] === 1,
    'and a rule may carry both credit maps at once');
  ok(/entitles/.test(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"offer":"A","counts":"dids.total","entitles":{"bad key!":1}}]' }) ?? ''), 'an entitles key is a dotted path or a group label, like alsoCounts');
  ok(/entitles/.test(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"offer":"A","counts":"dids.total","entitles":{"smsNumbers":"1"}}]' }) ?? ''), 'and an entitles value must be a number');
  ok(/entitles/.test(onebillConfigError({ ...base, ONEBILL_RECURRING_RULES: '[{"offer":"A","counts":"dids.total","entitles":[1]}]' }) ?? ''), 'and entitles itself must be an object');
  ok(rulesUseCatalog(rulesOf('[{"productCode":"SEAT","counts":"extensions.total","group":"seats"}]')) && !rulesUseCatalog(rulesOf('[{"offer":"A","counts":"dids.total"}]')), 'rulesUseCatalog says whether any rule needs the catalogue');

  // `why` is this Worker's own field on a rule, not onebill-lib's: a note for whoever reads the rulebook
  // next. The setting is a JSON string inside a JSONC file, so a `//` comment cannot reach inside it.
  ok(rulesOf('[{"offer":"MFAX Line","ignore":true,"why":"  Documo fax, not a NetSapiens line  "}]')[0]!.why === 'Documo fax, not a NetSapiens line',
    'why survives the parse, trimmed');
  ok(rulesOf('[{"offer":"A","counts":"dids.total"}]')[0]!.why === undefined, 'and is absent when not written, rather than an empty string');
  ok(/"why" must be a note/.test(bad(`[{"offer":"A","ignore":true,"why":"${'x'.repeat(121)}"}]`)), 'a why over 120 characters is refused');
  ok(/"why" must be a note/.test(bad('[{"offer":"A","ignore":true,"why":"   "}]')), 'and a blank one is refused rather than kept as noise');
  ok(/"why" must be a note/.test(bad('[{"offer":"A","ignore":true,"why":7}]')), 'and a non-string one');

  ok(rulesOf('[{"offer":"A","counts":"extensions.byServiceCode."}]')[0]!.counts === 'extensions.byServiceCode.', 'COUNTS_RE accepts a trailing dot');
  ok(rulesOf('[{"offer":"A","counts":"extensions.byScope.Call Center Agent"}]')[0]!.counts === 'extensions.byScope.Call Center Agent', 'COUNTS_RE accepts spaces in the final segment');
}

// ─────────────────────────────────────────────────────────────────────────────
// groupSetup — the preflight: is the group + fields OneBill needs actually DECLARED (present, whether
// or not populated)? Pure, hand-built records.
// ─────────────────────────────────────────────────────────────────────────────
{
  const spec = cfg.mapping[0]!; // { group: 'PBX', ns: 'NS', valueField: 'Domain', qualifierField: 'Site' }
  const groupInstance = (children: { key: string; value?: string }[]) => ({
    accountAttribute: [{ key: 'PBX', childAttribute: children }],
  });

  ok(groupSetup({ accountNumber: 'x' } as any, spec).ok === false, 'no accountAttribute at all: not ok');
  ok(JSON.stringify(groupSetup({ accountNumber: 'x' } as any, spec).missing) === JSON.stringify(['group']),
    'and the only thing named missing is the group itself');

  ok(groupSetup({ accountNumber: 'x', accountAttribute: [] } as any, spec).ok === false, 'accountAttribute present but the group instance absent: not ok');
  ok(JSON.stringify(groupSetup({ accountNumber: 'x', accountAttribute: [] } as any, spec).missing) === JSON.stringify(['group']),
    'same missing: group');

  // The blank instance OneBill materialises on every record: the group exists, but neither field has
  // ever been declared as a child at all (not merely empty).
  const blank = { accountNumber: 'x', ...groupInstance([]) } as any;
  const setupBlank = groupSetup(blank, spec);
  ok(setupBlank.ok === false && JSON.stringify(setupBlank.missing) === JSON.stringify(['valueField', 'qualifierField']),
    `group present, no fields declared: both named missing (${JSON.stringify(setupBlank.missing)})`);

  // The group exists and the value field is declared (even with a BLANK value — declared, not
  // populated, is the question), but no qualifier field.
  const noQualifier = { accountNumber: 'x', ...groupInstance([{ key: 'Domain', value: '' }]) } as any;
  const setupNoQual = groupSetup(noQualifier, spec);
  ok(setupNoQual.ok === false && JSON.stringify(setupNoQual.missing) === JSON.stringify(['qualifierField']),
    `an empty but DECLARED value field is not "missing" — only the qualifier field is (${JSON.stringify(setupNoQual.missing)})`);

  // Both fields declared: ok, regardless of whether either is populated.
  const both = { accountNumber: 'x', ...groupInstance([{ key: 'Domain', value: 'acme.example' }, { key: 'Site' }]) } as any;
  ok(groupSetup(both, spec).ok === true, 'both fields declared: ok');
  ok(groupSetup(both, spec).missing.length === 0, 'and nothing is reported missing');

  // A mapping with no qualifier field configured never asks for one.
  const noQualSpec = { group: 'PBX', ns: 'NS', valueField: 'Domain' };
  const domainOnly = { accountNumber: 'x', ...groupInstance([{ key: 'Domain' }]) } as any;
  ok(groupSetup(domainOnly, noQualSpec).ok === true, 'no qualifierField configured: the value field alone is enough');

  // Same record, both mapping shapes: qualifier is optional per MAPPING, not per record.
  ok(groupSetup(domainOnly, spec).ok === false, 'the SAME record fails the mapping that does want a qualifier field');

  ok(setupChecklist({ ok: false, missing: ['group'], group: 'PBX', valueField: 'Domain', qualifierField: 'Site' })
    .includes('create an account-level custom-field group with the key "PBX"'), 'the checklist names the group key');
  ok(setupChecklist({ ok: false, missing: ['valueField'], group: 'PBX', valueField: 'Domain', qualifierField: 'Site' })
    .includes('Missing: the "Domain" field.'), 'and names exactly which field is missing');
  ok(!setupChecklist({ ok: false, missing: ['group'], group: 'PBX', valueField: 'Domain' }).includes('optional text field'),
    'no qualifier field in the mapping: the checklist never mentions one');
  ok(ONEBILL_SETUP_TITLE === 'OneBill needs a custom-field group before links can be stored', 'the title is the exact page heading');
}

// token cache: namespaced by scope, round-trips, deletes
{
  const store = new Map<string, Response>();
  const cache = { match: async (r: Request) => store.get(r.url), put: async (r: Request, res: Response) => { store.set(r.url, res); }, delete: async (r: Request) => store.delete(r.url) } as unknown as Cache;
  const tc = new CacheTokenCache(cache, 'dev');
  ok((await tc.get('k')) === undefined, 'miss');
  await tc.set('k', { token: 'abc', expiresAt: Date.now() + 60_000 });
  ok((await tc.get('k'))?.token === 'abc', 'hit');
  ok([...store.keys()][0]!.includes('/dev/'), 'key carries the scope');
  await tc.delete('k');
  ok((await tc.get('k')) === undefined, 'deleted');
}

// ─────────────────────────────────────────────────────────────────────────────
// buildLinkReport — the pure join of NS domains against the OneBill link group + usage subscriptions.
// ─────────────────────────────────────────────────────────────────────────────
{
  const NS = 'NS';
  const cfg = { ns: NS, offerNames: ['Domain Usage'] };

  const domains: NsDomainInfo[] = [
    { domain: 'acme.example', sites: [] },
    { domain: 'beta.example', sites: [] },
    { domain: 'Gamma.Example', sites: [] },
    { domain: 'delta.example', sites: [] },
    { domain: 'eps.example', sites: [] },
    { domain: 'zeta.example', sites: [] },
    { domain: 'shared.example', sites: ['HQ', 'Annex'] },
    { domain: 'quiet.example', sites: ['Main'] },
    { domain: 'dup.example', sites: [] },
    { domain: 'twin.example', sites: [] },
    { domain: 'acme2.example', sites: [] },
    { domain: 'clash.example', sites: ['HQ'] },
    { domain: 'multi.example', sites: ['North', 'South'] },
    { domain: 'silent.example', sites: ['East', 'West'] },
  ];

  const accounts: AccountRef[] = [
    { accountNumber: 'CLI00001', accountName: 'Acme Co', status: 'Active' },
    { accountNumber: 'CLI00002', accountName: 'Beta Co', status: 'Active' },
    { accountNumber: 'CLI00003', accountName: 'Shared HQ Co', status: 'Active' },
    { accountNumber: 'CLI00004', accountName: 'Shared Annex Co', status: 'Active' },
    { accountNumber: 'CLI00005', accountName: 'Gone Stale Co', status: 'Active' },
    { accountNumber: 'CLI00007', accountName: 'Gone Closed Co', status: 'Closed' },
    { accountNumber: 'CLI00008', accountName: 'Dup A', status: 'Active' },
    { accountNumber: 'CLI00009', accountName: 'Dup B', status: 'Active' },
    { accountNumber: 'CLI00010', accountName: 'Gamma Co', status: 'Active' },
    { accountNumber: 'CLI00011', accountName: 'Eps Co', status: 'Active' },
    { accountNumber: 'CLI00013', accountName: 'Typo Co', status: 'Active' },
    { accountNumber: 'CLI00014', accountName: 'Twin A', status: 'Active' },
    { accountNumber: 'CLI00015', accountName: 'Twin B', status: 'Active' },
    { accountNumber: 'CLI00016', accountName: 'Bad Site Co', status: 'Active' },
    { accountNumber: 'CLI00017', accountName: 'Dup Link Co', status: 'Active' },
    { accountNumber: 'CLI00018', accountName: 'Clash A', status: 'Active' },
    { accountNumber: 'CLI00019', accountName: 'Clash B', status: 'Active' },
    { accountNumber: 'CLI00020', accountName: 'Clash Site Co', status: 'Active' },
    { accountNumber: 'CLI00021', accountName: 'Multi North Co', status: 'Active' },
    { accountNumber: 'CLI00022', accountName: 'Multi South Co', status: 'Active' },
    { accountNumber: 'CLI00023', accountName: 'Silent East Co', status: 'Active' },
    { accountNumber: 'CLI00024', accountName: 'Silent West Co', status: 'Active' },
  ];

  const link = (value: string, qualifier?: string): SourcedLink => ({ ns: NS, group: 'PBX', value, ...(qualifier ? { qualifier } : {}) });
  const sub = (identifier: string): Subscription => ({ subscriptionIdentifier: identifier, subscriptionOffer: [{ name: 'Domain Usage' }] });
  const row = (accountNumber: string, links: SourcedLink[], subscriptions: Subscription[]): UsageReconcileRow => ({ accountNumber, links, subscriptions });

  const gather: GatherResult = {
    rows: [
      row('CLI00001', [link('acme.example')], [sub('acme.example')]), // linked + usage agrees ⇒ 'ok', omitted from usage
      row('CLI00002', [], [sub('beta.example')]), // case 2: unlinked, exact candidate
      row('CLI00003', [link('shared.example', 'HQ')], [sub('shared.example')]),
      row('CLI00004', [link('shared.example', 'Annex')], [sub('shared.example')]),
      row('CLI00005', [link('gone.example'), link('gone2.example')], []), // case 7: foreign, Active ⇒ stale
      row('CLI00007', [link('gone.example')], []), // case 7: foreign, Closed ⇒ closed
      row('CLI00008', [link('dup.example')], []), // case 6: conflict
      row('CLI00009', [link('dup.example')], []), // case 6: conflict
      row('CLI00010', [], [sub('gamma.example')]), // case 3: NS spelling "Gamma.Example" vs sub "gamma.example" ⇒ canonicalized
      // case 9 & 11: linked to eps.example, but its usage subscription points at zeta.example — a real NS
      // domain, unclaimed everywhere else — so it would be an 'exact' candidate if it were eligible at
      // all; only the library's mismatch-skip (not the confidence filter) keeps it off zeta.example's row.
      row('CLI00011', [link('eps.example')], [sub('zeta.example')]),
      // case: a link to a real NS domain, but under a site that domain doesn't have — the remediation is
      // "fix the site", not "remove the link", so it must carry a note rather than read as plain 'stale'.
      row('CLI00016', [link('shared.example', 'Warehouse')], []),
      // case: one account with the SAME link duplicated twice must not read as a two-account conflict.
      row('CLI00017', [link('acme2.example'), link('acme2.example')], []),
      row('CLI00013', [], [sub('totally-unknown.example')]), // case 12: unknown confidence, never attached
      row('CLI00014', [], [sub('twin.example')]), // proposal.conflicts: two accounts proposing the same new target
      row('CLI00015', [], [sub('twin.example')]),
      // A CONTESTED bare domain that also has one site claimed: the parent is a conflict, not a split,
      // and its site row has to travel with it rather than sort away among the linked rows.
      row('CLI00018', [link('clash.example')], []),
      row('CLI00019', [link('clash.example')], []),
      row('CLI00020', [link('clash.example', 'HQ')], []),
      // Case 13: a split domain where one sited account holds the active usage subscription.
      row('CLI00021', [link('multi.example', 'North')], [sub('multi.example')]),
      row('CLI00022', [link('multi.example', 'South')], []),
      // Case 13b: a split domain where NEITHER sited account holds a usage subscription.
      row('CLI00023', [link('silent.example', 'East')], []),
      row('CLI00024', [link('silent.example', 'West')], []),
    ],
    failures: [{ accountNumber: 'CLI00099', error: new Error('read timed out') }],
    requestCount: 42,
    retried: 2,
  };

  const now = new Date('2026-09-02T00:00:00Z');
  const report = buildLinkReport(domains, gather, cfg, accounts, { now });
  const byDomain = (d: string, s?: string) => report.rows.find((r) => r.domain === d && r.site === s);

  // Case 1: linked
  {
    const r = byDomain('acme.example');
    ok(r?.state === 'linked' && r.accounts.length === 1 && r.accounts[0]!.accountNumber === 'CLI00001', 'acme.example linked to CLI00001');
  }

  // Case 2: unlinked with an exact candidate
  {
    const r = byDomain('beta.example');
    ok(r?.state === 'unlinked' && r.candidate?.accountNumber === 'CLI00002' && r.candidate.confidence === 'exact', 'beta.example unlinked, exact candidate CLI00002');
  }

  // Case 3: NS-spelling domain vs a differently-cased subscription identifier ⇒ canonicalized, NS spelling kept on the row
  {
    const r = byDomain('Gamma.Example');
    ok(r?.domain === 'Gamma.Example', 'row keeps the NS spelling "Gamma.Example"');
    ok(r?.candidate?.accountNumber === 'CLI00010' && r.candidate.confidence === 'canonicalized', 'Gamma.Example candidate is canonicalized, from CLI00010');
  }

  // Case 4: unlinked, no subscription at all ⇒ no candidate
  {
    const r = byDomain('delta.example');
    ok(r?.state === 'unlinked' && r.candidate === undefined, 'delta.example unlinked with no candidate');
  }

  // Case 5: a domain split by site
  {
    const bare = byDomain('shared.example');
    const hq = byDomain('shared.example', 'HQ');
    const annex = byDomain('shared.example', 'Annex');
    // The account column now lists each sited claimant by itself, so a note repeating the same fact in
    // words would say it twice — dropped (task 11 item 6); `linkedSites` still carries it structurally.
    ok(bare?.state === 'split' && (bare.notes ?? []).length === 0, 'shared.example bare row is SPLIT (no bare claim, sited claims) with no redundant note');
    ok(bare?.candidate === undefined, 'a split parent never carries a candidate — the domain is already billed, per site');
    ok((bare?.linkedSites ?? []).join(',') === 'HQ,Annex', 'and it names the sites already claimed, so the picker can default to one that is not');
    // Adjacency by INDEX, not by "they are all in the list somewhere": the site rows have to read as
    // children of the row above them, and a sort that scatters them reads as three unrelated rows.
    const iBare = report.rows.findIndex((r) => r.domain === 'shared.example' && r.site === undefined);
    const kids = report.rows.slice(iBare + 1, iBare + 3).map((r) => r.site);
    ok(kids.join(',') === 'Annex,HQ', `the split parent's site rows sit directly under it, in site order (got: ${kids.join(',')})`);
    ok(report.rows[iBare + 1]!.state === 'linked' && report.rows[iBare + 2]!.state === 'linked', 'and each of those children is linked in its own right');
    ok(hq?.state === 'linked' && hq.accounts[0]!.accountNumber === 'CLI00003', 'shared.example/HQ linked to CLI00003');
    ok(annex?.state === 'linked' && annex.accounts[0]!.accountNumber === 'CLI00004', 'shared.example/Annex linked to CLI00004');
    // Task 12 item 2: a site row carries the count of its sibling site rows, so the page can say "one of
    // N" without looking up the parent. Two claimed sites here ⇒ 2 on both children.
    ok(hq?.siteCount === 2 && annex?.siteCount === 2, `both of shared.example's site rows carry siteCount 2 (got HQ:${hq?.siteCount}, Annex:${annex?.siteCount})`);
    ok(bare?.siteCount === undefined, 'the split PARENT itself carries no siteCount — only its site rows do');
    const quietSiteRows = report.rows.filter((r) => r.domain === 'quiet.example' && r.site !== undefined);
    ok(quietSiteRows.length === 0, 'quiet.example has sites but no sited links ⇒ no site rows emitted');
  }

  // Case 6: bare domain conflict
  {
    const r = byDomain('dup.example');
    const nums = (r?.accounts ?? []).map((a) => a.accountNumber).sort();
    ok(r?.state === 'conflict' && nums.join(',') === 'CLI00008,CLI00009', 'dup.example is a conflict between CLI00008 and CLI00009');
  }

  // A site row follows its parent WHATEVER the parent's state — the grouping is the parent's rank, not
  // "split rows have children". A conflict parent with a claimed site is the case that separates the two.
  {
    const i = report.rows.findIndex((r) => r.domain === 'clash.example' && r.site === undefined);
    ok(report.rows[i]!.state === 'conflict', 'clash.example is a conflict (two accounts claim it bare), not a split');
    ok(report.rows[i]!.linkedSites === undefined, 'and it carries no linkedSites — only a split parent offers the next site');
    ok(report.rows[i + 1]?.domain === 'clash.example' && report.rows[i + 1]?.site === 'HQ',
      `its site row sits directly under it (got: ${report.rows[i + 1]?.domain}${report.rows[i + 1]?.site ? '/' + report.rows[i + 1]!.site : ''})`);
    ok(report.rows[i + 1]!.state === 'linked', 'that child is linked in its own right, and does not sort away with the other linked rows');
    ok(report.rows[i + 1]!.siteCount === 1, 'clash.example has exactly one claimed site, so its site row carries siteCount 1 (the singular case)');
  }

  // Case 7: links to a domain NS doesn't have ⇒ foreign — and only while the account is still Active.
  // A closed account's link cannot be written from the page at all, so listing it is noise; it is
  // dropped here and reaches the reader (if at all) through the decommission callout instead.
  {
    const stale = report.foreign.find((f) => f.value === 'gone.example' && f.account.accountNumber === 'CLI00005');
    const closed = report.foreign.find((f) => f.account.accountNumber === 'CLI00007');
    ok(stale?.state === 'stale', 'gone.example on an Active account is stale');
    ok(closed === undefined, 'the same link on a CLOSED account gets no foreign row — nothing on it is writable from here');
    ok(!report.decommission.some((d) => d.account.accountNumber === 'CLI00007'),
      'and it is not called out for decommissioning either, because gone.example is not a domain NetSapiens has');
    ok((stale?.links ?? []).some((l) => l.domain === 'gone2.example'), 'foreign row carries the account\'s full link set, not just this one value');
    ok((stale?.notes ?? []).length === 0, 'gone.example is a genuinely unknown domain ⇒ empty notes, no site-typo advice');
  }

  // A link whose DOMAIN exists in NS but whose SITE doesn't ⇒ still foreign (this exact target isn't
  // real), but the note steers toward fixing the site rather than removing a link to nowhere.
  {
    const badSite = report.foreign.find((f) => f.value === 'shared.example' && f.qualifier === 'Warehouse');
    ok(badSite?.state === 'stale', 'shared.example/Warehouse is foreign (no such sited target) — Active account ⇒ stale');
    ok((badSite?.notes ?? []).some((n) => /exists in NetSapiens/.test(n) && /no site "Warehouse"/.test(n)), 'note explains the domain is real but the site is not');
  }

  // Case 8: ordering — alphabetical by domain, case-insensitive (state no longer ranks the rows at all:
  // that ordering is gone, and the chips + the filter box carry it now). Each domain's site rows sit
  // directly beneath it, in site order, also case-insensitive.
  {
    const order = report.rows.map((r) => `${r.domain}${r.site ? '/' + r.site : ''}`);
    ok(order.join('|') === [
      'acme.example', 'acme2.example', 'beta.example',
      'clash.example', 'clash.example/HQ',
      'delta.example', 'dup.example', 'eps.example', 'Gamma.Example',
      'multi.example', 'multi.example/North', 'multi.example/South',
      'quiet.example',
      'shared.example', 'shared.example/Annex', 'shared.example/HQ',
      'silent.example', 'silent.example/East', 'silent.example/West',
      'twin.example', 'zeta.example',
    ].join('|'), `row order is alphabetical by domain, case-insensitive, each domain's sites directly beneath it (got: ${order.join('|')})`);
  }

  // Minor fix: one account claiming the same target twice must not read as a conflict with itself
  {
    const r = byDomain('acme2.example');
    ok(r?.state === 'linked' && r.accounts.length === 1 && r.accounts[0]!.accountNumber === 'CLI00017', 'a duplicated link within one account dedupes to a single "linked" claim, not a conflict');
  }

  // Case 9: mismatch appears in usage; 'ok' rows are omitted
  {
    const mismatch = report.usage.find((u) => u.account.accountNumber === 'CLI00011');
    ok(mismatch?.verdict === 'mismatch', 'CLI00011 (linked to eps.example, subscription says zeta.example) reports mismatch');
    ok(!report.usage.some((u) => u.account.accountNumber === 'CLI00001'), 'CLI00001 verdict is ok and is omitted from usage');
  }

  // Case 10: failures and requestCount pass through
  {
    ok(report.failures.length === 1 && report.failures[0]!.accountNumber === 'CLI00099' && report.failures[0]!.message === 'read timed out', 'failure passed through with its message');
    ok(report.requestCount === 42, 'requestCount passed through');
    ok(report.retried === 2, 'retried passed through from the gather result');
  }

  // Case 10b: a gather result predating `retried` (an older lib) reads as zero, not a crash
  {
    const oldGather = { ...gather } as GatherResult;
    delete (oldGather as { retried?: number }).retried;
    const r = buildLinkReport(domains, oldGather, cfg, accounts, { now });
    ok(r.retried === 0, 'retried defaults to 0 when the gather result predates the field');
  }

  // Case 11: a candidate whose account is already linked elsewhere (mismatch) is never proposed. zeta.example
  // is a real, otherwise-unclaimed NS domain that CLI00011's subscription names exactly — if the mismatch-skip
  // mechanism vanished it would be an 'exact' candidate, so this isolates that mechanism from the confidence filter.
  {
    const zeta = byDomain('zeta.example');
    ok(zeta?.state === 'unlinked' && zeta.candidate === undefined, 'zeta.example gets no candidate even though CLI00011\'s identifier matches it exactly');
    ok(!report.rows.some((r) => r.candidate?.accountNumber === 'CLI00011'), 'CLI00011 never appears as a candidate anywhere');
  }

  // Case 12: an unknown-confidence candidate is never attached to a row
  {
    ok(!report.rows.some((r) => r.candidate?.accountNumber === 'CLI00013'), 'CLI00013 (typo identifier matching no NS domain) never appears as a candidate');
  }

  // Bonus: a proposal.conflicts entry (two accounts proposing the same brand-new target) blocks the candidate too
  {
    const r = byDomain('twin.example');
    ok(r?.state === 'unlinked' && r.candidate === undefined, 'twin.example has two competing proposers ⇒ no candidate attached');
  }

  // accounts: every Active account only
  {
    ok(report.accounts.length === accounts.filter((a) => a.status === 'Active').length, 'report.accounts is every Active account');
    ok(!report.accounts.some((a) => a.accountNumber === 'CLI00007'), 'Closed account CLI00007 excluded from the picker list');
  }

  ok(report.generatedAt === now.toISOString(), 'generatedAt comes from the injected clock');

  // Case 13: a split parent's `siteAccounts` — one entry per sited claim, in site order, with the usage
  // holder marked. multi.example/North (CLI00021) holds an active usage subscription naming the domain;
  // multi.example/South (CLI00022) does not.
  {
    const r = byDomain('multi.example');
    ok(r?.state === 'split', 'multi.example is split, no bare claim');
    const sa = r?.siteAccounts ?? [];
    ok(sa.length === 2, `multi.example carries two siteAccounts entries (got ${sa.length})`);
    ok(sa.map((x) => x.site).join(',') === 'North,South', `in site order, matching the site rows beneath it (got ${sa.map((x) => x.site).join(',')})`);
    ok(sa[0]!.account.accountNumber === 'CLI00021' && sa[0]!.usageHolder === true, 'North (CLI00021) is the usage holder');
    ok(sa[1]!.account.accountNumber === 'CLI00022' && sa[1]!.usageHolder === false, 'South (CLI00022) is not');
  }

  // Case 13b: a split parent where NO sited account holds the usage subscription — both false.
  {
    const r = byDomain('silent.example');
    const sa = r?.siteAccounts ?? [];
    ok(sa.length === 2 && sa.every((x) => x.usageHolder === false), 'silent.example: neither East (CLI00023) nor West (CLI00024) holds usage');
  }

  // Case 13c: only a `split` row carries the field.
  {
    const r = byDomain('acme.example');
    ok(r?.state === 'linked' && r.siteAccounts === undefined, 'a non-split (linked) row has no siteAccounts');
    const conflict = byDomain('dup.example');
    ok(conflict?.state === 'conflict' && conflict.siteAccounts === undefined, 'nor does a conflict row');
    const hq = byDomain('shared.example', 'HQ');
    ok(hq?.state === 'linked' && hq.siteAccounts === undefined, 'nor does a site row itself — only its split parent');
  }
}

// A dedicated case-insensitive sort check, isolated from the big fixture above: mixed-case domains that
// would sort differently under a plain (case-sensitive) compare — capital letters sort before every
// lowercase letter in code-point order, so a naive sort would put "Bravo" before "alpha".
{
  const NS = 'NS';
  const cfg = { ns: NS, offerNames: [] as string[] };
  const domains: NsDomainInfo[] = [
    { domain: 'Bravo.example', sites: [] },
    { domain: 'alpha.example', sites: [] },
    { domain: 'Charlie.example', sites: ['zulu', 'Alpha'] },
  ];
  const link = (value: string, qualifier?: string): SourcedLink => ({ ns: NS, group: 'PBX', value, ...(qualifier ? { qualifier } : {}) });
  const gather: GatherResult = {
    rows: [
      { accountNumber: 'CLI00001', links: [link('Charlie.example', 'zulu')], subscriptions: [] },
      { accountNumber: 'CLI00002', links: [link('Charlie.example', 'Alpha')], subscriptions: [] },
    ],
    failures: [], requestCount: 0, retried: 0,
  };
  const report = buildLinkReport(domains, gather, cfg, [], {});
  const order = report.rows.map((r) => `${r.domain}${r.site ? '/' + r.site : ''}`);
  ok(order.join('|') === 'alpha.example|Bravo.example|Charlie.example|Charlie.example/Alpha|Charlie.example/zulu',
    `sort is case-insensitive on both the domain and the site (got: ${order.join('|')})`);
}


// ─────────────────────────────────────────────────────────────────────────────
// Hidden domains: counted, never named. A "hidden" value is a link value that IS an NS domain this
// deployment refuses to show (BLOCKED_DOMAINS, or absent from a set ALLOWED_DOMAINS). The predicate is
// built in worker.ts from those env keys and passed in; this module never reads them.
// ─────────────────────────────────────────────────────────────────────────────
{
  const NS = 'NS';
  const cfg = { ns: NS, offerNames: [] as string[] };
  const domains: NsDomainInfo[] = [{ domain: 'acme.example', sites: ['HQ'] }];
  const accounts: AccountRef[] = [
    { accountNumber: 'CLI00001', accountName: 'Visible Co', status: 'Active' },
    { accountNumber: 'CLI00002', accountName: 'Hidden Only Co', status: 'Active' },
    { accountNumber: 'CLI00003', accountName: 'Mixed Co', status: 'Active' },
    { accountNumber: 'CLI00004', accountName: 'Stale Co', status: 'Active' },
    { accountNumber: 'CLI00005', accountName: 'No Links Co', status: 'Active' },
    { accountNumber: 'CLI00006', accountName: 'Part Hidden Co', status: 'Active' },
    { accountNumber: 'CLI00007', accountName: 'Shut Co', status: 'Closed' },
  ];
  const link = (value: string, qualifier?: string): SourcedLink => ({ ns: NS, group: 'PBX', value, ...(qualifier ? { qualifier } : {}) });
  const sub = (identifier: string): Subscription => ({ subscriptionIdentifier: identifier, subscriptionOffer: [{ name: 'Domain Usage' }] });
  const gather: GatherResult = {
    rows: [
      { accountNumber: 'CLI00001', links: [link('acme.example')], subscriptions: [] },
      { accountNumber: 'CLI00002', links: [link('blocked.example')], subscriptions: [sub('blocked.example')] },
      { accountNumber: 'CLI00003', links: [link('acme.example', 'HQ'), link('blocked.example')], subscriptions: [] },
      { accountNumber: 'CLI00004', links: [link('gone.example')], subscriptions: [] },
      { accountNumber: 'CLI00005', links: [], subscriptions: [sub('blocked.example')] },
      { accountNumber: 'CLI00006', links: [link('blocked.example'), link('gone2.example')], subscriptions: [] },
      { accountNumber: 'CLI00007', links: [link('gone3.example')], subscriptions: [] },
    ],
    failures: [], requestCount: 0, retried: 0,
  };
  const hidden = (value: string): boolean => value === 'blocked.example';
  const rep = buildLinkReport(domains, gather, { ns: NS, offerNames: ['Domain Usage'] }, accounts, { hidden });

  ok(rep.hiddenLinkCount === 3, `every hidden link is counted once (${rep.hiddenLinkCount} of 3)`);
  // Per row, with a label: an aggregate "the JSON does not contain it" cannot say WHICH row leaked.
  for (const f of rep.foreign) ok(!hidden(f.value), `foreign row for ${f.account.accountNumber} does not name a hidden domain (${f.value})`);
  ok(!JSON.stringify(rep).includes('blocked.example'), 'and the hidden name appears nowhere in the shipped report at all');
  // The usage findings are the library's prose and interpolate BOTH link values and subscription identifiers,
  // so a row that would name a hidden domain from either side is dropped whole, per account, with a label.
  for (const acct of ['CLI00002', 'CLI00005', 'CLI00006']) ok(!rep.usage.some((u) => u.account.accountNumber === acct), `no usage row for ${acct}, whose findings would name the hidden domain`);
  ok(rep.usage.some((u) => u.account.accountNumber === 'CLI00004'), 'a usage row whose findings name only a non-hidden value is kept (CLI00004)');
  ok(rep.foreign.some((f) => f.account.accountNumber === 'CLI00004' && f.value === 'gone.example'),
    'a value that is neither visible nor hidden is still the honest stale case, named as before');
  ok(!rep.accounts.some((a) => a.accountNumber === 'CLI00002'), 'an account whose links are ALL hidden is not offered in the picker');
  ok(rep.accounts.some((a) => a.accountNumber === 'CLI00003'), 'one carrying a visible link as well as a hidden one is');
  ok(rep.accounts.some((a) => a.accountNumber === 'CLI00005'), 'and so is an account with no links in this namespace at all');
  const mixed = rep.foreign.find((f) => f.account.accountNumber === 'CLI00003');
  ok(mixed === undefined, 'the mixed account has no foreign row here — its only unresolved link is the hidden one');

  // The ROW-level flag: a boolean, naming nothing, so the page can decline to draw a Remove control it
  // knows the route would refuse. It must agree with `bounds.restricted` — two derivations of one fact.
  const partHidden = rep.foreign.find((f) => f.account.accountNumber === 'CLI00006');
  ok(partHidden?.restricted === true, 'a foreign row on an account that also holds a hidden link is marked restricted');
  ok(rep.foreign.find((f) => f.account.accountNumber === 'CLI00004')?.restricted === false,
    'and one whose account holds nothing hidden is not');
  ok(!JSON.stringify(rep.foreign).includes('blocked'), 'the flag names nothing — it is a boolean');

  const full = buildLinkReport(domains, gather, cfg, accounts);
  ok(full.hiddenLinkCount === 0, 'with no predicate nothing is hidden — the default hides nothing');
  ok(full.foreign.some((f) => f.value === 'blocked.example'), 'and the same link reads as an ordinary foreign row');

  // ── the bounds, which are built from the UNFILTERED join so the Worker knows what the page does not ──
  const bounds = applyBounds(rep, full);
  ok(bounds.restricted.has('CLI00002') && bounds.restricted.has('CLI00003'), 'an account carrying ANY hidden link is restricted');
  ok(!bounds.restricted.has('CLI00001') && !bounds.restricted.has('CLI00004'), 'and one carrying none is not');
  ok(!bounds.accounts.has('CLI00002'), 'an account the page cannot name is not writable');
  ok(bounds.accounts.has('CLI00004'), 'while an ACTIVE account named only by a foreign row is — that is how a stale link gets removed');
  ok(!bounds.accounts.has('CLI00007'), 'a CLOSED account is not — and it no longer even has a foreign row to be named by');
  ok(!rep.foreign.some((f) => f.account.accountNumber === 'CLI00007'), 'the closed account is absent from the foreign list entirely');
  for (const f of rep.foreign) {
    ok(f.restricted === bounds.restricted.has(f.account.accountNumber),
      `the row flag and the bound agree for ${f.account.accountNumber} (row: ${f.restricted})`);
  }
  ok(applyBounds(rep).restricted.size === 0, 'one report on its own restricts nobody: there is nothing hidden to compare against');

  {
    const store = new Map<string, Response>();
    const cache = { match: async (r: Request) => store.get(r.url), put: async (r: Request, res: Response) => { store.set(r.url, res); }, delete: async (r: Request) => store.delete(r.url) } as unknown as Cache;
    const env = { ONEBILL_TENANT_ID: 't1', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p', CACHE_SCOPE: 'dev' };
    const writes: any[] = [];
    const writer = { setSubscriberLinks: async (accountNumber: string, links: any, _m: any, opts: any) => {
      writes.push({ accountNumber, links, opts });
      return { created: links, updated: [], unchanged: [], removed: [], notRemoved: [], unmapped: [], externalId: 'NS|x', collateral: [] };
    } };

    let threw: any = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00007', links: [], removeUnlisted: true }], bounds, { writer, reader: readerFor(gather.rows), hidden });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && threw.status === 400, 'an op against a CLOSED account is a 400');
    ok(writes.length === 0, 'refused here, before any write client exists — not left to the library\'s in-band refusal');

    threw = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00002', links: [], removeUnlisted: true }], bounds, { writer, reader: readerFor(gather.rows), hidden });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && threw.status === 400, 'clearing an account the page cannot name is a 400');
    ok(/not an account this page lists/.test(threw?.message ?? ''), 'and says so in those terms');
    ok(writes.length === 0, 'with the writer never called');

    threw = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00003', links: [{ domain: 'acme.example', site: 'HQ' }], removeUnlisted: true }], bounds, { writer, reader: readerFor(gather.rows), hidden });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && threw.status === 400, 'removeUnlisted on a RESTRICTED account is a 400 — the list it would match is missing the hidden links');
    ok(/removeUnlisted is refused/.test(threw?.message ?? ''), 'and the refusal names the rule');
    ok(writes.length === 0, 'and still nothing was written');

    const out = await applyLinks(env, cache, [{ accountNumber: 'CLI00003', links: [{ domain: 'acme.example', site: 'HQ' }] }], bounds, { writer, reader: readerFor(gather.rows), hidden });
    ok(out[0]?.ok === true && writes.length === 1, 'while a plain add/update on that same account is allowed — only the matching write is refused');
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Editing a link that already exists: change its site, add a second site, unlink it.
//
// Each edit is ONE op on ONE account, and the interesting half is what it carries ALONG: the account's
// other links, so a `removeUnlisted` write leaves them where they are. That list comes from
// `RowAccount.links` — the row's own account entry, carrying every NON-hidden link it holds in this
// namespace — which is why that field exists at all. The bounds are what decide whether such an op is
// allowed, so they are what these assertions are about.
// ─────────────────────────────────────────────────────────────────────────────
{
  const NS = 'NS';
  const cfg = { ns: NS, offerNames: [] as string[] };
  const domains: NsDomainInfo[] = [
    { domain: 'acme.example', sites: ['HQ', 'Lab'] },
    { domain: 'beta.example', sites: [] },
  ];
  const accounts: AccountRef[] = [
    { accountNumber: 'CLI00001', accountName: 'Acme Co', status: 'Active' },
    { accountNumber: 'CLI00002', accountName: 'Mixed Co', status: 'Active' },
  ];
  const link = (value: string, qualifier?: string): SourcedLink => ({ ns: NS, group: 'PBX', value, ...(qualifier ? { qualifier } : {}) });
  const gather: GatherResult = {
    rows: [
      // Two VISIBLE links on one Active account: the shape every edit below is measured against.
      { accountNumber: 'CLI00001', links: [link('acme.example', 'HQ'), link('beta.example')], subscriptions: [] },
      // One visible, one hidden — the account an edit must be refused on.
      { accountNumber: 'CLI00002', links: [link('acme.example', 'Lab'), link('blocked.example')], subscriptions: [] },
    ],
    failures: [], requestCount: 0, retried: 0,
  };
  const hidden = (value: string): boolean => value === 'blocked.example';
  const rep = buildLinkReport(domains, gather, cfg, accounts, { hidden });
  const full = buildLinkReport(domains, gather, cfg, accounts);
  const bounds = applyBounds(rep, full);

  // ── the row account carries what an edit has to send back ──────────────────────────────────────
  const hq = rep.rows.find((r) => r.domain === 'acme.example' && r.site === 'HQ');
  const rowAcct = hq?.accounts[0];
  ok(rowAcct?.accountNumber === 'CLI00001', 'the HQ site row is claimed by CLI00001');
  ok(JSON.stringify(rowAcct?.links) === JSON.stringify([{ domain: 'acme.example', site: 'HQ' }, { domain: 'beta.example' }]),
    `the row's account entry carries every visible link it holds, this one included (${JSON.stringify(rowAcct?.links)})`);
  ok(rowAcct?.restricted === false, 'and is not restricted — nothing it holds is hidden from this caller');

  const lab = rep.rows.find((r) => r.domain === 'acme.example' && r.site === 'Lab');
  const labAcct = lab?.accounts[0];
  ok(labAcct?.restricted === true, 'while the row for an account that ALSO holds a hidden link is restricted');
  ok(labAcct?.restricted === bounds.restricted.has('CLI00002'), 'which is the same fact the bounds derive independently');
  ok(!JSON.stringify(rep.rows).includes('blocked'), 'and the hidden link is named on no row — `links` is the VISIBLE list');

  // ── the three edits, each as the page would send it ────────────────────────────────────────────
  {
    const store = new Map<string, Response>();
    const cache = { match: async (r: Request) => store.get(r.url), put: async (r: Request, res: Response) => { store.set(r.url, res); }, delete: async (r: Request) => store.delete(r.url) } as unknown as Cache;
    const env = { ONEBILL_TENANT_ID: 't1', ONEBILL_CLIENT_SECRET: 's', ONEBILL_USERNAME: 'u', ONEBILL_PASSWORD: 'p', CACHE_SCOPE: 'dev' };
    const writes: any[] = [];
    const writer = { setSubscriberLinks: async (accountNumber: string, links: any, _m: any, opts: any) => {
      writes.push({ accountNumber, links, opts });
      return { created: links, updated: [], unchanged: [], removed: [], notRemoved: [], unmapped: [], externalId: 'NS|x', collateral: [] };
    } };

    // Change site: this link becomes acme.example / Lab, the other link rides along, removeUnlisted.
    const moved = await applyLinks(env, cache, [{ accountNumber: 'CLI00001',
      links: [{ domain: 'beta.example' }, { domain: 'acme.example', site: 'Lab' }], removeUnlisted: true }], bounds, { writer, reader: readerFor(gather.rows), hidden });
    ok(moved[0]?.ok === true, 'change-site passes the bounds for an Active account holding two visible links');

    // Add a site: the FULL list plus the new one, and no removeUnlisted — nothing is being taken away.
    const added = await applyLinks(env, cache, [{ accountNumber: 'CLI00001',
      links: [{ domain: 'acme.example', site: 'HQ' }, { domain: 'beta.example' }, { domain: 'acme.example', site: 'Lab' }] }], bounds, { writer, reader: readerFor(gather.rows), hidden });
    ok(added[0]?.ok === true, 'and so does add-a-site, which carries the whole list and removes nothing');

    // Unlink: the other link alone, removeUnlisted — the write is "make it match this".
    const unlinked = await applyLinks(env, cache, [{ accountNumber: 'CLI00001',
      links: [{ domain: 'beta.example' }], removeUnlisted: true }], bounds, { writer, reader: readerFor(gather.rows), hidden });
    ok(unlinked[0]?.ok === true, 'and so does unlink, which sends the other links and nothing else');
    ok(writes.length === 3, `each edit is exactly one write against one account (${writes.length})`);

    // The restricted account: refused BEFORE any write, because the list it would be matched against is
    // missing the link this caller was never shown.
    writes.length = 0;
    let threw: any = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00002', links: [{ domain: 'acme.example' }], removeUnlisted: true }], bounds, { writer, reader: readerFor(gather.rows), hidden });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && threw.status === 400, 'change-site on a RESTRICTED account is a 400');
    ok(/removeUnlisted is refused/.test(threw?.message ?? ''), 'naming the rule');
    ok(writes.length === 0, 'and nothing was written before it was refused');
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Retired identifiers (ONEBILL_USAGE_IGNORE) and the decommission callout.
//
// Three rules, and they compose. A subscription whose identifier carries a retirement marker is not a
// usage match at all, so every verdict is computed as if it did not exist. An account that is not Active
// leaves BOTH the usage list and the foreign list — nothing on it is writable from this page, so both
// entries are noise. And whatever it leaves behind, it is called out for decommissioning when any value
// it names is a domain NetSapiens still has and this caller may see.
// ─────────────────────────────────────────────────────────────────────────────
{
  const NS = 'NS';
  const link = (value: string): SourcedLink => ({ ns: NS, group: 'PBX', value });
  const sited = (value: string, qualifier: string): SourcedLink => ({ ns: NS, group: 'PBX', value, qualifier });
  const sub = (identifier: string): Subscription => ({ subscriptionIdentifier: identifier, subscriptionOffer: [{ name: 'Domain Usage' }] });

  const domains: NsDomainInfo[] = [
    { domain: 'acme.example', sites: [] },
    { domain: 'live.example', sites: [] },
    { domain: 'live2.example', sites: [] },
    { domain: 'live3.example', sites: [] },
    { domain: 'live4.example', sites: ['Real'] },
    { domain: 'live5.example', sites: [] },
    { domain: 'blocked.example', sites: [] },
  ];
  const accounts: AccountRef[] = [
    { accountNumber: 'CLI00000', accountName: 'Shut Zero Co', status: 'Closed' },
    { accountNumber: 'CLI00001', accountName: 'Shut Live Co', status: 'Closed' },
    { accountNumber: 'CLI00002', accountName: 'Shut Gone Co', status: 'Cancelled' },
    { accountNumber: 'CLI00003', accountName: 'Active Co', status: 'Active' },
    { accountNumber: 'CLI00004', accountName: 'Shut Hidden Co', status: 'Closed' },
    { accountNumber: 'CLI00006', accountName: 'Shut Sub Only Co', status: 'Closed' },
    { accountNumber: 'CLI00007', accountName: 'Shut Bad Site Co', status: 'Closed' },
    { accountNumber: 'CLI00008', accountName: 'Shut Tidy Co', status: 'Closed' },
  ];
  const gather: GatherResult = {
    rows: [
      // Closed, with a RETIRED subscription that must not count, and a link NetSapiens still has.
      { accountNumber: 'CLI00001', links: [link('live.example')], subscriptions: [sub('live.example_OLD')] },
      // Closed, and nothing it names is a domain NetSapiens has — it belongs nowhere.
      { accountNumber: 'CLI00002', links: [link('gone.example')], subscriptions: [] },
      // Active, one retired identifier beside a real one: the verdict must come from the real one alone.
      { accountNumber: 'CLI00003', links: [link('acme.example')], subscriptions: [sub('acme.example'), sub('stale.example_old')] },
      // Closed, pointing only at a domain this deployment hides from the caller.
      { accountNumber: 'CLI00004', links: [link('blocked.example')], subscriptions: [] },
      // Closed, named by a SUBSCRIPTION rather than a link — the other half of the OR.
      { accountNumber: 'CLI00006', links: [], subscriptions: [sub('live3.example')] },
      // Closed, linked to a live domain under a site NetSapiens does not have. Before rule 3 this was a
      // 'closed' foreign row; now it is dropped from that list and the callout names the DOMAIN, since
      // whether the site is right has nothing to do with whether the domain is still live.
      { accountNumber: 'CLI00007', links: [sited('live4.example', 'Nowhere')], subscriptions: [] },
      // Closed, and its billing agrees with its link — verdict 'ok', which never was a usage row. The
      // callout is not a redirect of the usage list: it asks about the account, not about its verdict.
      { accountNumber: 'CLI00008', links: [link('live5.example')], subscriptions: [sub('live5.example')] },
      // Last in the sweep, first by account number: the section is ordered, not read order.
      { accountNumber: 'CLI00000', links: [link('live2.example')], subscriptions: [] },
    ],
    failures: [], requestCount: 0, retried: 0,
  };
  const cfg = { ns: NS, offerNames: ['Domain Usage'], usageIgnore: ['_OLD'] };
  const hidden = (v: string): boolean => v === 'blocked.example';
  const rep = buildLinkReport(domains, gather, cfg, accounts, { hidden });
  const decom = (n: string) => rep.decommission.find((d) => d.account.accountNumber === n);

  // Rule 1 — a retired identifier is not a usage match at all.
  ok(!rep.usage.some((u) => u.account.accountNumber === 'CLI00003'),
    'an Active account whose only live subscription agrees with its link is ok, and the retired one does not make it ambiguous');
  const noIgnore = buildLinkReport(domains, gather, { ns: NS, offerNames: ['Domain Usage'] }, accounts, { hidden });
  ok(noIgnore.usage.find((u) => u.account.accountNumber === 'CLI00003')?.verdict === 'ambiguous',
    'and without the marker that same account IS ambiguous — the ignore rule is what changed the verdict, not the fixture');

  // The marker is case-insensitive (the identifier here ends "_old") and is a substring, not a suffix rule.
  const upper = buildLinkReport(domains, gather, { ns: NS, offerNames: ['Domain Usage'], usageIgnore: ['_old'] }, accounts, { hidden });
  ok(!upper.usage.some((u) => u.account.accountNumber === 'CLI00003'), 'the marker matches regardless of case in either direction');

  // Configurable: a deployment that retires with _RETIRED must not have _OLD ignored out from under it.
  const other = buildLinkReport(domains, gather, { ns: NS, offerNames: ['Domain Usage'], usageIgnore: ['_RETIRED'] }, accounts, { hidden });
  ok(other.usage.find((u) => u.account.accountNumber === 'CLI00003')?.verdict === 'ambiguous',
    'with ONEBILL_USAGE_IGNORE=_RETIRED, an _OLD identifier still counts');

  // Rule 2 — a CLOSED account leaves the usage list.
  for (const n of ['CLI00000', 'CLI00001', 'CLI00002', 'CLI00004', 'CLI00006', 'CLI00007', 'CLI00008']) {
    ok(!rep.usage.some((u) => u.account.accountNumber === n), `no usage row for closed account ${n}`);
  }

  // …but a closed account whose domain NetSapiens still has is called out instead.
  ok(decom('CLI00001')?.domains.join('|') === 'live.example',
    'a closed account whose link is a live NS domain is called out for decommissioning, naming the domain');
  ok(decom('CLI00001')?.account.accountName === 'Shut Live Co', 'with the account name it is known by');
  ok(decom('CLI00006')?.domains.join('|') === 'live3.example',
    'and so is one named only by a subscription identifier — link values OR identifiers, not links alone');
  ok(decom('CLI00002') === undefined, 'a closed account whose values match nothing live appears nowhere');
  ok(decom('CLI00007')?.domains.join('|') === 'live4.example',
    'a closed account linked under a site NetSapiens does not have is called out by its DOMAIN — the site is not the question');
  ok(!rep.foreign.some((f) => f.account.accountNumber === 'CLI00007'),
    'and that link gets no foreign row, because nothing on a closed account is written from this page');
  ok(decom('CLI00008')?.domains.join('|') === 'live5.example',
    'a closed account whose billing AGREES with its link is called out too — the callout is about the account, not its usage verdict');
  ok(rep.decommission.map((d) => d.account.accountNumber).join(',') === 'CLI00000,CLI00001,CLI00006,CLI00007,CLI00008',
    `the callout is ordered by account number, not sweep order (${rep.decommission.map((d) => d.account.accountNumber).join(',')})`);
  ok(rep.foreign.every((f) => f.state !== 'closed'), 'no closed row survives into the foreign list at all');

  // Hidden domains are never named here either — the same rule that governs every other section.
  ok(decom('CLI00004') === undefined, 'a closed account whose only live domain is hidden gets no entry, because the entry would have to name it');
  ok(!JSON.stringify(rep.decommission).includes('blocked'), 'and no hidden name reaches the callout at all');

  // The retired subscription must not become a decommission reason on its own account either: it names
  // a domain nothing else does, and honouring it would reinstate exactly what rule 1 discarded.
  ok(!JSON.stringify(rep.decommission).includes('_OLD'), 'a retired identifier never appears in the callout');

  // An Active account is never a decommission entry, however many live domains it names.
  ok(!rep.decommission.some((d) => d.account.status === 'Active'), 'only accounts that are not Active are listed');
}


// ─────────────────────────────────────────────────────────────────────────────
// loadLinkReport / applyLinks — the I/O half. No network: the NS reader and the OneBill read/write
// clients are all injected, so this file never touches `fetch`.
// ─────────────────────────────────────────────────────────────────────────────
{
  const memory = () => {
    const store = new Map<string, Response>();
    const cache = {
      match: async (r: Request) => { const hit = store.get(r.url); return hit ? hit.clone() : undefined; },
      put: async (r: Request, res: Response) => { store.set(r.url, res.clone()); },
      delete: async (r: Request) => store.delete(r.url),
    } as unknown as Cache;
    return { store, cache };
  };

  const env = { ...base, ONEBILL_USAGE_OFFERS: 'Domain Usage', CACHE_SCOPE: 'dev' };

  const subscriber = (accountNumber: string, accountName: string, accountStatus: string) => ({ accountNumber, accountName, accountStatus });

  // A read source that counts its calls, so "did the cache serve this" is observable.
  const makeSource = (subs: any[] = [subscriber('CLI00001', 'Acme Co', 'Active'), subscriber('CLI00002', 'Closed Co', 'Closed')]) => {
    const calls = { list: 0, sub: 0, subscriptions: 0 };
    let statuses: readonly string[] | undefined;
    return {
      calls,
      seenStatuses: () => statuses,
      source: {
        listAllSubscribers: async (o?: { statuses?: readonly string[] }) => { calls.list++; statuses = o?.statuses; return subs as any; },
        getSubscriber: async (n: string) => { calls.sub++; return subs.find((s) => s.accountNumber === n) as any; },
        getSubscriptions: async () => { calls.subscriptions++; return []; },
      },
    };
  };

  // The NS side: only `get` is used, and only for the sites read.
  const makeNs = (sites: Record<string, unknown>, fail = new Set<string>()) => {
    const seen: string[] = [];
    return {
      seen,
      ns: {
        get: async (path: string) => {
          seen.push(path);
          const m = path.match(/^\/domains\/([^/]+)\/sites$/);
          const d = decodeURIComponent(m?.[1] ?? '');
          if (fail.has(d)) throw new Error('NS says no');
          return (sites[d] ?? []) as any;
        },
      },
    };
  };

  // ── the sites read, the account mapping, and the statuses the sweep covers ──
  {
    const { cache } = memory();
    const src = makeSource();
    const nsq = makeNs({ 'acme.example': [{ site: 'HQ' }, { site: '  Annex  ' }, { site: '' }, {}] });
    const { report } = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });

    ok(nsq.seen[0] === '/domains/acme.example/sites', 'the sites read is GET /domains/{domain}/sites on the caller\'s client');
    const row = report.rows.find((r) => r.domain === 'acme.example' && !r.site);
    ok(row?.sites.join('|') === 'HQ|Annex', 'sites come from the `site` field, trimmed, blanks dropped');
    ok(src.seenStatuses()?.join('|') === 'Active|Closed|Inactive', 'the sweep covers every subscriber status, not the search default');
    ok(report.accounts.length === 1 && report.accounts[0]!.accountName === 'Acme Co', 'accountName maps from the Subscriber field of that name');
    ok(!report.accounts.some((a) => a.accountNumber === 'CLI00002'), 'accountStatus maps too — the Closed account is not in the picker list');
    ok(report.siteReadFailures.length === 0, 'no site read failures when every read answered');
  }

  // ── a failed sites read is counted, never hidden, and the domain still lists ──
  {
    const { cache } = memory();
    const src = makeSource();
    const nsq = makeNs({ 'beta.example': [{ site: 'Main' }] }, new Set(['acme.example']));
    const { report } = await loadLinkReport(env, cache, nsq.ns, ['acme.example', 'beta.example'], { readSource: src.source });
    ok(report.rows.some((r) => r.domain === 'acme.example'), 'a domain whose sites read failed is still listed');
    ok(report.siteReadFailures.join() === 'acme.example', 'and it is named in siteReadFailures');
  }

  // ── the report cache: keyed by scope + the sorted domain set, 600s, refresh bypasses ──
  {
    const { store, cache } = memory();
    const src = makeSource();
    const nsq = makeNs({});
    await loadLinkReport(env, cache, nsq.ns, ['b.example', 'a.example'], { readSource: src.source });
    ok(src.calls.list === 1, 'the first call reads');
    const k = [...store.keys()].find((u) => u.includes('/quick/'))!;
    ok(/^https:\/\/onebill\.internal\/dev\/quick\/v3\/[0-9a-f]{64}$/.test(k), 'the report key is scope-namespaced, names its MODE, and carries a sha256 of the domain set');

    await loadLinkReport(env, cache, nsq.ns, ['a.example', 'b.example'], { readSource: src.source });
    ok(src.calls.list === 1, 'a second call with the same domains in a different order hits the cache');
    await loadLinkReport(env, cache, nsq.ns, ['a.example'], { readSource: src.source });
    ok(src.calls.list === 2, 'a different domain set is a different key');
    await loadLinkReport(env, cache, nsq.ns, ['a.example', 'b.example'], { readSource: src.source, refresh: true });
    ok(src.calls.list === 2, 'a refresh inside REFRESH_COOLDOWN_S is served from the entry instead — this sweep is a paged subscriber walk plus a /sites read per domain, and nothing else on the route bounds how often one caller may ask for a fresh one');
    await loadLinkReport(env, cache, nsq.ns, ['a.example', 'b.example'],
      { readSource: src.source, refresh: true, now: new Date(Date.now() + (REFRESH_COOLDOWN_S + 1) * 1000) });
    ok(src.calls.list === 3, 'and past the cooldown refresh bypasses the cache');
    const stored = store.get(k)!;
    ok((stored.headers.get('cache-control') ?? '').includes('max-age=600'), 'the entry is stored with a 600s TTL');
  }

  // ── the cache entry holds the BOUNDS as well as the report ────────────────────────────────────
  // The bounds are derived from the unfiltered join, so a cache hit that restored only the report would
  // hand the apply route a weaker bound set than the load that filled it — and `restricted` would be
  // empty exactly when the page is hiding something.
  {
    const { cache } = memory();
    const src = makeSource([subscriber('CLI00001', 'Acme Co', 'Active')]);
    const nsq = makeNs({});
    const hidden = (v: string) => v === 'acme.example';
    const first = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source, hidden });
    const second = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source, hidden });
    ok(src.calls.list === 1, 'the second load is served from the cache');
    ok(second.bounds.targets instanceof Set && second.bounds.existing instanceof Map, 'and the bounds come back as the Sets and Map they went in as');
    ok([...second.bounds.targets].sort().join('|') === [...first.bounds.targets].sort().join('|'), 'with the same targets');
    ok([...second.bounds.restricted].sort().join('|') === [...first.bounds.restricted].sort().join('|'), 'and the same restricted accounts');
    ok(second.report.hiddenLinkCount === first.report.hiddenLinkCount, 'and the report the page gets is the one that was cached');
  }

  // ── an entry in the OLD shape (a bare report, no bounds) is a miss, never a 500 ─────────────────
  {
    const { store, cache } = memory();
    const src = makeSource([subscriber('CLI00001', 'Acme Co', 'Active')]);
    const nsq = makeNs({});
    const first = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    // Overwrite the entry the load just wrote with a bare report under the same key.
    const k = [...store.keys()].find((u) => u.includes('/quick/'))!;
    ok(k.includes('/quick/v3/'), 'the key carries the entry-shape version');
    store.set(k, new Response(JSON.stringify(first.report), { headers: { 'content-type': 'application/json' } }));
    const again = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    ok(src.calls.list === 2, 'a bare-report entry is treated as a miss and the report is rebuilt');
    ok(again.bounds.targets instanceof Set, 'and the rebuilt load carries bounds');
  }

  // ── the setup preflight, wired through loadLinkReport ──────────────────────────────────────────
  {
    const groupOn = (n: string, name: string) => ({
      accountNumber: n, accountName: name, accountStatus: 'Active',
      accountAttribute: [{ key: 'PBX', childAttribute: [{ key: 'Domain', value: '' }, { key: 'Site', value: '' }] }],
    });
    const groupOff = (n: string, name: string) => ({ accountNumber: n, accountName: name, accountStatus: 'Active' });

    // The group IS declared on the first Active account: setup reads ok.
    {
      const { cache } = memory();
      const src = makeSource([groupOn('CLI00001', 'Acme Co')]);
      const nsq = makeNs({});
      const { report } = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
      ok(report.setup?.ok === true, 'the group is declared on the first Active account, so setup reads ok');
    }

    // The group is NOT declared: setup reads not-ok, naming what is missing — in both modes.
    for (const mode of ['quick', 'full'] as const) {
      const { cache } = memory();
      const src = makeSource([groupOff('CLI00001', 'No Group Co')]);
      const nsq = makeNs({});
      const { report } = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source, mode });
      ok(report.setup?.ok === false, `[${mode}] the group is not declared anywhere, so setup reads not-ok`);
      ok(JSON.stringify(report.setup?.missing) === JSON.stringify(['group']), `[${mode}] and names the group itself as missing`);
      ok(report.setup?.group === 'PBX' && report.setup?.valueField === 'Domain' && report.setup?.qualifierField === 'Site',
        `[${mode}] carrying the configured group/valueField/qualifierField`);
    }

    // No Active account to check at all: nothing is known to be missing, so setup reads ok rather than
    // painting a working deployment as unconfigured on a fluke of which accounts exist.
    {
      const { cache } = memory();
      const src = makeSource([{ accountNumber: 'CLI00009', accountName: 'Closed Only Co', accountStatus: 'Closed' }]);
      const nsq = makeNs({});
      const { report } = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
      ok(report.setup?.ok === true, 'no Active account exists to check, so setup reads ok rather than unknown-as-failure');
    }

    // A cache entry from before `setup` existed is a MISS, not a report silently missing the field.
    {
      const { store, cache } = memory();
      const src = makeSource([groupOn('CLI00001', 'Acme Co')]);
      const nsq = makeNs({});
      await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
      const k = [...store.keys()].find((u) => u.includes('/quick/'))!;
      const raw = JSON.parse(await (await store.get(k)!.clone().text()));
      delete raw.inputs.setup;
      store.set(k, new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } }));
      const again = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
      ok(src.calls.list === 2, 'an entry predating `setup` is a miss, so the report is rebuilt rather than served without it');
      ok(again.report.setup !== undefined, 'and the rebuilt report carries one');
    }
  }

  // ── the allowed set the apply route derives from a report ──
  {
    const { cache } = memory();
    const src = makeSource();
    const nsq = makeNs({ 'acme.example': [{ site: 'HQ' }] });
    const { report } = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    const allowed = allowedTargets(report);
    ok(allowed.has(targetKeyT('acme.example')) && allowed.has(targetKeyT('acme.example', 'HQ')), 'a domain and each of its sites are writable targets');
    ok(!allowed.has(targetKeyT('acme.example', 'Nope')) && !allowed.has(targetKeyT('other.example')), 'nothing else is');
    const accts = allowedAccounts(report);
    ok(accts.has('CLI00001') && accts.size === 1, 'and the writable accounts are the report\'s own — Active only');
    ok(!accts.has('CLI00002'), 'the Closed account is not one of them, matching the library\'s allowNonActive default');
  }

  // ── the third bound: what an account ALREADY holds, so a foreign link can be removed at all ──────
  // Removal is "make the record match this list", so removing one of an account's two foreign links
  // means sending the other — which is foreign, and which a targets-only check refuses. The Remove
  // button was therefore un-pressable: it always produced a 400 naming the link it was keeping.
  {
    const { cache } = memory();
    const report = {
      generatedAt: '2026-09-02T00:00:00.000Z',
      rows: [{ domain: 'acme.example', state: 'linked' as const, accounts: [{ accountNumber: 'CLI00001', status: 'Active' }], sites: ['HQ'], notes: [] }],
      foreign: [{ account: { accountNumber: 'CLI00009', status: 'Active' }, value: 'gone.example', state: 'stale' as const,
        links: [{ domain: 'gone.example' }, { domain: 'alsogone.example', site: 'Lab' }], notes: [] }],
      usage: [], decommission: [], accounts: [{ accountNumber: 'CLI00001', status: 'Active' }, { accountNumber: 'CLI00009', status: 'Active' }],
      failures: [], siteReadFailures: [], requestCount: 0,
    };
    const ex = existingLinks(report);
    ok(ex.get('CLI00009')?.has(targetKeyT('gone.example')) === true, 'a foreign row contributes every link its account holds');
    ok(ex.get('CLI00009')?.has(targetKeyT('alsogone.example', 'Lab')) === true, 'including the qualified ones');
    ok(ex.get('CLI00001')?.has(targetKeyT('acme.example')) === true, 'and a linked row contributes its own target to the account claiming it');
    ok(ex.get('CLI00001')?.has(targetKeyT('gone.example')) !== true, 'one account\'s record never vouches for another\'s');

    const bounds = applyBounds(report);
    // What those two accounts really hold, as `applyLinks` will read it back off the record.
    const foreignRecords = [
      { accountNumber: 'CLI00009', links: [{ value: 'gone.example' }, { value: 'alsogone.example', qualifier: 'Lab' }] },
      { accountNumber: 'CLI00001', links: [{ value: 'acme.example' }] },
    ];
    const writes: any[] = [];
    const writer = { setSubscriberLinks: async (accountNumber: string, links: any, _m: any, opts: any) => {
      writes.push({ accountNumber, links, opts });
      return { created: [], updated: [], unchanged: links, removed: [], notRemoved: [], unmapped: [], externalId: 'NS|x', collateral: [] };
    } };
    // Removing gone.example: the OTHER foreign link rides along, and is accepted because it is already
    // on this account's record in the report the caller just loaded.
    const out = await applyLinks(env, cache, [{ accountNumber: 'CLI00009', links: [{ domain: 'alsogone.example', site: 'Lab' }], removeUnlisted: true }], bounds, { writer, reader: readerFor(foreignRecords) });
    ok(out[0]?.ok === true && writes.length === 1, 'an account can be made to match its own remaining links');
    ok(writes[0].opts.removeUnlisted === true, 'and the removal is expressed as removeUnlisted, not as a delete call');

    // Neither visible nor on that account: still refused, whole batch, nothing written.
    let m1 = '';
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00009', links: [{ domain: 'invented.example' }], removeUnlisted: true }], bounds, { writer, reader: readerFor(foreignRecords) });
    } catch (e) { m1 = (e as Error).message; }
    ok(/invented\.example/.test(m1) && writes.length === 1, 'a target that is neither visible nor already on the record is still a 400');

    // The map is PER ACCOUNT. CLI00001 may not write CLI00009's foreign link just because it exists.
    let m2 = '';
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'gone.example' }] }], bounds, { writer, reader: readerFor(foreignRecords) });
    } catch (e) { m2 = (e as Error).message; }
    ok(/gone\.example/.test(m2) && writes.length === 1, 'and it never grants one account a target that is on a different one');
  }

  // ── applyLinks: every op is validated against the server-derived allowed set BEFORE any write ──
  {
    const { cache } = memory();
    const writes: any[] = [];
    const writer = { setSubscriberLinks: async (accountNumber: string, links: any, mapping: any, opts: any) => {
      writes.push({ accountNumber, links, mapping, opts });
      return { created: links, updated: [], unchanged: [], removed: [], notRemoved: [], unmapped: [], externalId: 'NS|x', collateral: [] };
    } };
    const bounds = { targets: new Set([targetKeyT('acme.example'), targetKeyT('acme.example', 'HQ')]), accounts: new Set(['CLI00001']), existing: new Map<string, Set<string>>(), restricted: new Set<string>() };

    let threw: any = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'nope.example' }] }], bounds, { writer, reader: noRecords });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && threw.status === 400, 'a target outside the allowed set is a 400');
    ok(writes.length === 0, 'and nothing was written');

    threw = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example', site: 'Nope' }] }], bounds, { writer, reader: noRecords });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError, 'a site outside the allowed set is refused too — the site is part of the target');

    threw = null;
    try {
      const many = Array.from({ length: 51 }, () => ({ accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] }));
      await applyLinks(env, cache, many, bounds, { writer, reader: noRecords });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && threw.status === 400, 'more than 50 ops is a 400');
    ok(writes.length === 0, 'and still nothing was written');

    threw = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: '  ', links: [] }], bounds, { writer, reader: noRecords });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError, 'an op with no account number is a 400');

    // ⚠️ THE EMPTY OP IS THE DESTRUCTIVE ONE. With no links there is no target to check, so a
    // target-only guard passes it vacuously — and `removeUnlisted` then clears every link on whatever
    // account was named, including links to domains ALLOWED_DOMAINS/the blocklist hide from this caller.
    threw = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI09999', links: [], removeUnlisted: true }], bounds, { writer, reader: noRecords });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && threw.status === 400, 'an account outside the caller\'s report is a 400, even with no links to check');
    ok(writes.length === 0, 'and the writer was never constructed, let alone called');

    // The same op against an account the report DOES list is allowed through — the guard is the account
    // set, not a ban on clearing links.
    const cleared = await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [], removeUnlisted: true }], bounds, { writer, reader: noRecords });
    ok(cleared[0]!.ok && writes.length === 1, 'while clearing a listed account\'s links is exactly what Remove does');

    // A validation failure ANYWHERE refuses the whole batch: op 1 is legal, op 2 names an unknown
    // account, and nothing is written — a half-applied batch is one the operator cannot reason about.
    writes.length = 0;
    threw = null;
    try {
      await applyLinks(env, cache, [
        { accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] },
        { accountNumber: 'CLI09999', links: [], removeUnlisted: true },
      ], bounds, { writer, reader: noRecords });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && writes.length === 0, 'one bad op refuses the whole batch, before the good one is written');

    // Site normalisation happens ONCE, above both the check and the write: a non-string site cannot
    // validate as one target and be written as another.
    writes.length = 0;
    await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example', site: '  HQ  ' as any }] }], bounds, { writer, reader: noRecords });
    ok(writes[0]!.links[0]!.qualifier === 'HQ', 'a padded site is trimmed once, and the value checked is the value written');
    threw = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example', site: 0 as any }] }], bounds, { writer, reader: noRecords });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError, 'and a non-string site is stringified before the check, not silently dropped');
  }

  // ── applyLinks: the setup preflight refuses the WHOLE batch, before any read or write ───────────
  {
    const { cache } = memory();
    const writes: any[] = [];
    const reads: string[] = [];
    const writer = { setSubscriberLinks: async (accountNumber: string, links: any) => { writes.push({ accountNumber, links }); return { created: links, updated: [], unchanged: [], removed: [], notRemoved: [], unmapped: [], externalId: 'NS|x', collateral: [] }; } };
    const reader = { getSubscriber: async (n: string) => { reads.push(n); return { accountNumber: n } as any; } };
    const bounds = { targets: new Set([targetKeyT('acme.example')]), accounts: new Set(['CLI00001']), existing: new Map<string, Set<string>>(), restricted: new Set<string>() };
    const notOk: SetupCheck = { ok: false, missing: ['valueField'], group: 'PBX', valueField: 'Domain', qualifierField: 'Site' };

    let threw: any = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] }], bounds, { writer, reader, setup: notOk });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && threw.status === 400, 'not-ok setup refuses with a 400');
    ok(threw?.message === `${ONEBILL_SETUP_TITLE}: ${setupChecklist(notOk)}`, 'in the SAME words setupChecklist composes for the page');
    ok(reads.length === 0 && writes.length === 0, 'refused before any read or write — results.length === 0, nothing attempted');

    const okSetup: SetupCheck = { ok: true, missing: [], group: 'PBX', valueField: 'Domain', qualifierField: 'Site' };
    const results = await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] }], bounds, { writer, reader, setup: okSetup });
    ok(results.length === 1 && results[0]!.ok, 'an ok setup does not interfere with an otherwise-valid apply');

    // No `setup` passed at all: the check is skipped entirely (older callers, and every other test
    // in this file that never mentions it).
    writes.length = 0; reads.length = 0;
    const skipped = await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] }], bounds, { writer, reader });
    ok(skipped.length === 1 && writes.length === 1, 'omitting `setup` entirely skips the check rather than refusing');
  }

  // ── applyLinks: sequential, one call per op, a failure does not stop the ones after it ──
  {
    const { cache } = memory();
    const order: string[] = [];
    const writer = { setSubscriberLinks: async (accountNumber: string, links: any, _m: any, opts: any) => {
      order.push(accountNumber);
      if (accountNumber === 'CLI00002') throw new Error('PUT /subscribers/CLI00002 -> OneBill API: Bad Request: contact echo');
      return {
        created: links, updated: [], unchanged: [],
        removed: opts?.removeUnlisted ? links : [],
        // The two "your record does not match what you sent" signals, on the op that did not ask to remove.
        notRemoved: opts?.removeUnlisted ? [] : [{ ns: 'NS', value: 'left.example' }],
        unmapped: accountNumber === 'CLI00001' ? [{ ns: 'OTHER', value: 'x' }] : [],
        externalId: `NS|${accountNumber}`,
        collateral: accountNumber === 'CLI00003' ? ['address'] : [],
      };
    } };
    const bounds = {
      existing: new Map(),
      targets: new Set([targetKeyT('acme.example'), targetKeyT('beta.example'), targetKeyT('gamma.example')]),
      accounts: new Set(['CLI00001', 'CLI00002', 'CLI00003']),
      restricted: new Set<string>(),
    };
    const results = await applyLinks(env, cache, [
      { accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] },
      { accountNumber: 'CLI00002', links: [{ domain: 'beta.example' }] },
      { accountNumber: 'CLI00003', links: [{ domain: 'gamma.example' }], removeUnlisted: true },
    ], bounds, { writer, reader: noRecords });

    ok(order.join('|') === 'CLI00001|CLI00002|CLI00003', 'one call per op, in order');
    ok(results.length === 3, 'one outcome per op');
    ok(results[0]!.ok && results[0]!.created === 1 && results[0]!.externalId === 'NS|CLI00001', 'the first op reports what it did');
    ok(!results[1]!.ok && /contact echo/.test(results[1]!.error ?? ''), 'the failed op carries OneBill\'s own message — the only thing that names the next write trap');
    ok(results[2]!.ok, 'and the op after the failure still ran');
    ok(results[2]!.removed === 1, 'removeUnlisted is passed through and what went is reported');
    ok((results[2]!.collateral ?? []).join() === 'address', 'collateral is a note on a successful result, not a failure');
    ok(results[0]!.notRemoved === 1, 'links left on the record because nothing asked to remove them are counted — the record does NOT match what was sent');
    ok(results[2]!.notRemoved === 0, 'and the removeUnlisted op leaves none behind');
    ok(results[0]!.unmapped === 1 && results[2]!.unmapped === 0, 'requested links no mapping covers are counted too — that part of the op did nothing');
  }

  // ── a successful apply does NOT evict this scope's report ─────────────────────────────────────
  // Throwing away a report that is right about every other account is what made a post-apply reload
  // cost a whole sweep. The route patches the written accounts in instead — see refreshAppliedAccounts.
  {
    const { cache } = memory();
    const src = makeSource();
    const nsq = makeNs({});
    await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    ok(src.calls.list === 1, 'cached before the apply');
    const writer = { setSubscriberLinks: async (_a: string, links: any) => ({ created: links, updated: [], unchanged: [], removed: [], notRemoved: [], unmapped: [], externalId: 'NS|x', collateral: [] }) };
    await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] }], { targets: new Set([targetKeyT('acme.example')]), accounts: new Set(['CLI00001']), existing: new Map(), restricted: new Set<string>() }, { writer, reader: noRecords });
    await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    ok(src.calls.list === 1, 'and the cached report still stands afterwards — the sweep is not repeated');
  }

  // ── a failed apply leaves the cache alone: nothing changed upstream, so nothing to invalidate ──
  {
    const { cache } = memory();
    const src = makeSource();
    const nsq = makeNs({});
    await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    const writer = { setSubscriberLinks: async () => { throw new Error('nope'); } };
    const results = await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] }], { targets: new Set([targetKeyT('acme.example')]), accounts: new Set(['CLI00001']), existing: new Map(), restricted: new Set<string>() }, { writer: writer as any, reader: noRecords });
    ok(!results[0]!.ok, 'the op failed');
    await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    ok(src.calls.list === 1, 'and the cached report still stands');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // QUICK vs FULL: what each mode reads, what it costs, and which store it believes.
  // ─────────────────────────────────────────────────────────────────────────────

  /** One subscriber as the SEARCH returns it: the derived index rides the row, the group does not. */
  const indexed = (accountNumber: string, accountName: string, externalId: string, group: [string, string?][] = []) => ({
    accountNumber, accountName, accountStatus: 'Active', externalId,
    accountAttribute: group.map(([v, q], i) => ({
      key: 'PBX', aggregator: i + 1,
      childAttribute: [{ key: 'Domain', value: v }, ...(q ? [{ key: 'Site', value: q }] : [])],
    })),
  });

  // ── quick reads the list, no subscriptions, and the record only where the index names >1 link ──
  {
    const { cache } = memory();
    const src = makeSource([
      indexed('CLI00001', 'One Link Co', 'NS:acme.example', [['acme.example']]),
      indexed('CLI00002', 'Two Link Co', 'NS:acme.example/HQ|NS:beta.example', [['acme.example', 'HQ'], ['beta.example']]),
      indexed('CLI00003', 'No Link Co', ''),
    ]);
    const nsq = makeNs({ 'acme.example': [{ site: 'HQ' }] });
    const { report } = await loadLinkReport(env, cache, nsq.ns, ['acme.example', 'beta.example'], { readSource: src.source });

    ok(report.mode === 'quick', 'the default mode is quick');
    ok(src.calls.list === 1, 'which reads the subscriber list once');
    ok(src.calls.subscriptions === 0, 'and NEVER reads subscriptions — that read is the whole cost of the audit pass');
    // Plus one more: the setup preflight's own extra `getSubscriber` on the first Active account
    // (CLI00001), which the quick sweep did not otherwise need to read in full.
    ok(src.calls.sub === 2, `and reads the full record for the one account whose index names two links, plus the setup preflight's own read (${src.calls.sub})`);
    ok(report.rows.find((r) => r.domain === 'acme.example' && !r.site)?.accounts[0]?.accountNumber === 'CLI00001',
      'a single-link account is joined from the index alone');
    ok(report.usage.length === 0 && report.verifiedAt === null && report.usageStale === true,
      'with no full pass cached, usage is empty, unverified, and says so');
    ok(report.requestCount === 3, `the cost is honest: one walk, one record, plus the setup preflight's read (${report.requestCount})`);
  }

  // ── a 2-link account whose INDEX disagrees with its GROUP: the group wins ──────────────────────
  // The index is derived and hand-editable; the group is the record. A split-domain account is exactly
  // where the two drift, which is why those are the accounts quick mode pays to read in full.
  {
    const { cache } = memory();
    const src = makeSource([
      // The index still names the old pair; the group has moved the second link to another site.
      indexed('CLI00002', 'Two Link Co', 'NS:acme.example/HQ|NS:acme.example/Lab', [['acme.example', 'HQ'], ['acme.example', 'Annex']]),
    ]);
    const nsq = makeNs({ 'acme.example': [{ site: 'HQ' }, { site: 'Lab' }, { site: 'Annex' }] });
    const { report } = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    const claimed = report.rows.filter((r) => r.accounts.length).map((r) => r.site).sort();
    ok(claimed.join('|') === 'Annex|HQ', `the group's sites are the ones claimed, not the index's (${claimed.join('|')})`);
    ok(!report.rows.some((r) => r.site === 'Lab' && r.accounts.length), 'and the site only the stale index named claims nothing');
  }

  // ── full reads subscriptions, keys separately, and leaves the usage a quick view borrows ───────
  {
    const { cache } = memory();
    const src = makeSource([indexed('CLI00001', 'One Link Co', 'NS:acme.example', [['acme.example']])]);
    const nsq = makeNs({});
    const full = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source, mode: 'full', now: new Date('2026-09-03T10:00:00.000Z') });
    ok(full.report.mode === 'full' && full.report.usageStale === false, 'a full pass is not stale');
    ok(full.report.verifiedAt === '2026-09-03T10:00:00.000Z', 'and it verified itself, at its own generatedAt');
    ok(src.calls.subscriptions === 1, 'it reads subscriptions, one per account');

    const before = { ...src.calls };
    await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source, mode: 'full' });
    ok(src.calls.list === before.list, 'a second full load is served from the full cache');

    // The quick entry is a DIFFERENT key: a full pass does not silently answer a quick request.
    const quick = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source, now: new Date('2026-09-03T10:05:00.000Z') });
    ok(src.calls.list === before.list + 1, 'so a quick load after a full one still reads');
    ok(quick.report.mode === 'quick' && quick.report.generatedAt === '2026-09-03T10:05:00.000Z', 'and is its own, newer report');
    ok(quick.report.verifiedAt === '2026-09-03T10:00:00.000Z',
      `whose usage carries the FULL pass's own timestamp, not its own (${quick.report.verifiedAt})`);
    ok(quick.report.usageStale === true, 'and is labelled stale even so');
    ok(JSON.stringify(quick.report.usage) === JSON.stringify(full.report.usage), 'the verdicts themselves are the full pass’s, verbatim');
  }

  // ── the post-apply patch: only the written account changes, and the rest is byte-equal ─────────
  {
    const { cache } = memory();
    const subs = [
      indexed('CLI00001', 'One Link Co', 'NS:acme.example', [['acme.example']]),
      indexed('CLI00007', 'Unclaimed Co', ''),
    ];
    const src = makeSource(subs);
    const nsq = makeNs({});
    const before = await loadLinkReport(env, cache, nsq.ns, ['acme.example', 'beta.example'], { readSource: src.source });
    ok(before.report.rows.find((r) => r.domain === 'beta.example')?.state === 'unlinked', 'beta.example starts unlinked');

    // CLI00007 has just been linked to beta.example in OneBill. Only it is re-read.
    subs[1] = indexed('CLI00007', 'Unclaimed Co', 'NS:beta.example', [['beta.example']]);
    const reads = { sub: 0, subscriptions: 0 };
    await refreshAppliedAccounts(env, cache, ['acme.example', 'beta.example'], ['CLI00007'], {
      readSource: {
        getSubscriber: async (n: string) => { reads.sub++; return subs.find((x) => x.accountNumber === n) as any; },
        getSubscriptions: async () => { reads.subscriptions++; return []; },
      },
    });
    ok(reads.sub === 1 && reads.subscriptions === 1, 'the re-read is two calls for the one account written');

    const listBefore = src.calls.list;
    const after = await loadLinkReport(env, cache, nsq.ns, ['acme.example', 'beta.example'], { readSource: src.source });
    ok(src.calls.list === listBefore, 'and the page’s reload right after is a CACHE HIT — no second sweep');
    ok(after.report.rows.find((r) => r.domain === 'beta.example')?.accounts[0]?.accountNumber === 'CLI00007',
      'showing the link that was just written');
    ok(after.report.generatedAt === before.report.generatedAt, 'the sweep still ran when it ran — generatedAt is not restamped');
    ok(after.report.requestCount === before.report.requestCount + 2, `and the two extra reads are counted (${after.report.requestCount})`);
    // Byte-equality on everything the write did not touch, per row rather than over the whole document:
    // a JSON.stringify of the pair would fail on the ONE row that is supposed to differ and say nothing
    // about which of the others moved with it.
    for (const row of before.report.rows) {
      if (row.domain === 'beta.example') continue;
      const now = after.report.rows.find((r) => r.domain === row.domain && r.site === row.site);
      ok(JSON.stringify(now) === JSON.stringify(row), `the row for ${row.domain}${row.site ? '/' + row.site : ''} is byte-identical after the patch`);
    }
    ok(after.bounds.accounts.has('CLI00007'), 'and the patched bounds still name the account');
    ok(after.bounds.existing.get('CLI00007')?.has(targetKeyT('beta.example')) === true, 'with its new link on its record');
  }

  // ── an index that admits it is incomplete is not an index to join from ────────────────────────
  // A `+N` continuation says links live outside the field; an unparsed token is something the codec did
  // not understand. Either way, joining from it would report the account as holding less than it does.
  {
    const { cache } = memory();
    const src = makeSource([
      indexed('CLI00001', 'Continued Co', 'NS:acme.example|+2', [['acme.example']]),
      indexed('CLI00002', 'Odd Token Co', 'NS:beta.example|WAT', [['beta.example']]),
      indexed('CLI00003', 'Plain Co', 'NS:gamma.example', [['gamma.example']]),
    ]);
    const nsq = makeNs({});
    await loadLinkReport(env, cache, nsq.ns, ['acme.example', 'beta.example', 'gamma.example'], { readSource: src.source });
    // Plus one more: the setup preflight's extra read of the first Active account (CLI00001), which
    // in this fixture happens to be the same account the continuation rule already reads in full.
    ok(src.calls.sub === 3, `the record is read for the continued and the unparsed one, and not for the plain one, plus the setup preflight's own read (${src.calls.sub})`);
  }

  // ── the 24 h usage overlay is re-filtered by the CURRENT hidden predicate ──────────────────────
  // The overlay outlives a change to ALLOWED_DOMAINS/BLOCKED_DOMAINS by up to a day. Filtering it only
  // at write time would keep naming a newly-blocked domain for that whole day.
  {
    const { cache } = memory();
    const subs = [{ accountNumber: 'CLI00001', accountName: 'Over Co', accountStatus: 'Active', externalId: 'NS:acme.example', accountAttribute: [] as any[] }];
    const source = {
      listAllSubscribers: async () => subs as any,
      getSubscriber: async (n: string) => subs.find((x) => x.accountNumber === n) as any,
      // A usage subscription naming a domain nothing links: 'missing'/'orphan'-shaped, and its findings
      // name acme.example — which is exactly the value the later predicate hides.
      getSubscriptions: async () => [{ subscriptionIdentifier: 'acme.example', subscriptionOffer: [{ name: 'Domain Usage' }] }] as any,
    };
    const nsq = makeNs({});
    const full = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: source, mode: 'full' });
    ok(full.report.usage.length > 0, 'the full pass, hiding nothing, produced a usage row');
    ok((full.report.usage[0]!.values ?? []).includes('acme.example'), 'carrying the values its verdict rests on');

    const quick = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: source, hidden: (v) => v === 'acme.example' });
    ok(quick.report.usage.length === 0, 'and a later quick view that now hides that domain shows no row for it');
    ok(!JSON.stringify(quick.report.usage).includes('acme.example'), 'so the newly-blocked name is not served from a day-old entry');

    // Past the refresh cooldown, or this is served from the entry the previous line just wrote.
    const still = await loadLinkReport(env, cache, nsq.ns, ['acme.example'],
      { readSource: source, refresh: true, now: new Date(Date.now() + (REFRESH_COOLDOWN_S + 1) * 1000) });
    ok(still.report.usage.length === 1, 'while a caller who hides nothing still sees it — the overlay itself was not rewritten');
  }

  // ── patchReportAccounts is PURE: same inputs, same bytes, no clock and no I/O ──────────────────
  {
    const { store, cache } = memory();
    const subs = [indexed('CLI00001', 'One Link Co', 'NS:acme.example', [['acme.example']])];
    const src = makeSource(subs);
    const nsq = makeNs({});
    await loadLinkReport(env, cache, nsq.ns, ['acme.example', 'beta.example'], { readSource: src.source });
    const url = [...store.keys()].find((u) => u.includes('/quick/'))!;
    const entry = await store.get(url)!.clone().json() as any;
    const fresh = [{ accountNumber: 'CLI00001', accountName: 'One Link Co', links: [{ ns: 'NS', value: 'beta.example' }], subscriptions: [] }];
    const cfg2 = resolveOnebillConfig(env);
    const a = patchReportAccounts(entry, ['CLI00001'], fresh as any, cfg2, { reads: 2 });
    const b = patchReportAccounts(entry, ['CLI00001'], fresh as any, cfg2, { reads: 2 });
    ok(JSON.stringify(a) === JSON.stringify(b), 'two patches of one entry produce identical bytes');
    ok(JSON.stringify(entry.inputs.rows) === JSON.stringify([{ accountNumber: 'CLI00001', accountName: 'One Link Co', links: [{ ns: 'NS', value: 'acme.example' }], subscriptions: [] }]),
      'and the entry it was given is not mutated');
    ok(a.report.rows.find((r) => r.domain === 'beta.example')?.accounts[0]?.accountNumber === 'CLI00001', 'the patched account moved to its new domain');
    ok(a.report.rows.find((r) => r.domain === 'acme.example')?.state === 'unlinked', 'and left the old one');
  }

  // ── a re-read that FAILS drops the entries rather than leaving them wrong ──────────────────────
  {
    const { cache } = memory();
    const src = makeSource([indexed('CLI00001', 'One Link Co', 'NS:acme.example', [['acme.example']])]);
    const nsq = makeNs({});
    await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    await refreshAppliedAccounts(env, cache, ['acme.example'], ['CLI00001'], {
      readSource: { getSubscriber: async () => { throw new Error('OneBill said no'); }, getSubscriptions: async () => [] },
    });
    const listBefore = src.calls.list;
    await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    ok(src.calls.list === listBefore + 1, 'a cached report that could not be patched is deleted, so the next load re-reads');
  }

  // ── THE BOUNDS COME FROM THE RECORD, NOT THE INDEX ────────────────────────────────────────────
  // The quick report is built from `externalId`, which names one link; the account's GROUP also holds a
  // link to a domain this deployment hides. A matching write would delete it silently — so the refusal
  // must come from the record `applyLinks` reads for itself, since nothing in the report can know.
  {
    const { cache } = memory();
    const src = makeSource([indexed('CLI00001', 'Mixed Co', 'NS:acme.example', [['acme.example'], ['blocked.example']])]);
    const nsq = makeNs({});
    const hidden = (v: string): boolean => v === 'blocked.example';
    const { report, bounds } = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source, hidden });
    ok(report.hiddenLinkCount === 0, 'the index knew nothing about the hidden link, so the report cannot count it');
    ok(!bounds.restricted.has('CLI00001'), 'and the report-derived bounds do not mark the account restricted');

    const writes: any[] = [];
    const writer = { setSubscriberLinks: async (accountNumber: string, links: any, _m: any, opts: any) => {
      writes.push({ accountNumber, links, opts });
      return { created: links, updated: [], unchanged: [], removed: [], notRemoved: [], unmapped: [], externalId: 'NS|x', collateral: [] };
    } };
    const reader = { getSubscriber: (n: string) => src.source.getSubscriber(n) };
    let threw: any = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }], removeUnlisted: true }], bounds, { writer, reader, hidden });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && threw.status === 400, 'the matching write is refused anyway — the record is read before it is validated');
    ok(/removeUnlisted is refused/.test(threw?.message ?? ''), 'naming the rule');
    ok(!/blocked\.example/.test(threw?.message ?? ''), 'and not the domain it is protecting');
    ok(writes.length === 0, 'with nothing written');

    // The same account, added to rather than matched: allowed, exactly as before.
    const out = await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] }], bounds, { writer, reader, hidden });
    ok(out[0]?.ok === true && writes.length === 1, 'while a plain add on the same account still goes through');

    // And the record is what says an account may keep a link the report never mentioned: the group's
    // acme.example link is in-bounds for this account even though the index-built report is the source
    // of `targets`. A read that fails takes the whole batch with it.
    threw = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] }], bounds,
        { writer, reader: { getSubscriber: async () => { throw new Error('boom'); } }, hidden });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && /before writing/.test(threw?.message ?? ''), 'an account whose record will not read refuses the batch');
    ok(writes.length === 1, 'before anything else is written');
  }

  // ── an account whose GROUP is entirely hidden is not this caller's to touch ────────────────────
  // `buildLinkReport` drops such an account from the picker, so a FULL report never names it. A quick
  // report is built from the derived index, which for that same account can be EMPTY — and an account
  // with no links reads as an ordinary one, so it stays in the picker. Only the record can tell.
  {
    const { cache } = memory();
    const src = makeSource([indexed('CLI00001', 'Hidden Only Co', '', [['blocked.example']])]);
    const nsq = makeNs({});
    const hidden = (v: string): boolean => v === 'blocked.example';
    const { report, bounds } = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source, hidden });
    ok(report.accounts.some((a) => a.accountNumber === 'CLI00001'),
      'the quick report offers the account, because its index says it holds nothing');
    ok(bounds.accounts.has('CLI00001'), 'and the report-derived bounds admit it');

    const writes: any[] = [];
    const writer = { setSubscriberLinks: async (a: string, links: any) => { writes.push({ a, links }); return { created: links, updated: [], unchanged: [], removed: [], notRemoved: [], unmapped: [], externalId: 'NS|x', collateral: [] }; } };
    const reader = { getSubscriber: (n: string) => src.source.getSubscriber(n) };
    let threw: any = null;
    try {
      await applyLinks(env, cache, [{ accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] }], bounds, { writer, reader, hidden });
    } catch (e) { threw = e; }
    ok(threw instanceof OnebillRequestError && threw.status === 400, 'the write is refused anyway, on the record');
    ok(/is not an account this page lists/.test(threw?.message ?? ''), 'in the same words the report-derived refusal uses — which check was tripped is not the caller’s business');
    ok(!/blocked\.example/.test(threw?.message ?? ''), 'and it names no hidden domain');
    ok(writes.length === 0, 'with nothing written');
  }

  // ── one account named twice in a batch is read ONCE, and both ops answer to that record ────────
  {
    const { cache } = memory();
    const src = makeSource([indexed('CLI00001', 'Acme Co', 'NS:acme.example', [['acme.example']])]);
    const nsq = makeNs({ 'acme.example': [{ site: 'HQ' }] });
    const { bounds } = await loadLinkReport(env, cache, nsq.ns, ['acme.example'], { readSource: src.source });
    let reads = 0;
    const reader = { getSubscriber: async (n: string) => { reads++; return src.source.getSubscriber(n); } };
    const writes: any[] = [];
    const writer = { setSubscriberLinks: async (a: string, links: any) => { writes.push({ a, links }); return { created: links, updated: [], unchanged: [], removed: [], notRemoved: [], unmapped: [], externalId: 'NS|x', collateral: [] }; } };
    const out = await applyLinks(env, cache, [
      { accountNumber: 'CLI00001', links: [{ domain: 'acme.example' }] },
      { accountNumber: 'CLI00001', links: [{ domain: 'acme.example', site: 'HQ' }] },
    ], bounds, { writer, reader });
    ok(reads === 1, `the record is read once for the account, not once per op (${reads})`);
    ok(out.length === 2 && writes.length === 2, 'while both ops still run');
    ok(out.every((r) => r.ok), 'and both are bounded by that one record');
  }

  // ── a patch that cannot be written must not turn a write that HAPPENED into a failure ──────────
  {
    const { store } = memory();
    const failing = {
      match: async (r: Request) => { const hit = store.get(r.url); return hit ? hit.clone() : undefined; },
      put: async (r: Request, res: Response) => { if (r.url.includes('/quick/')) { store.set(r.url, res.clone()); return; } throw new Error('cache is unwell'); },
      delete: async (r: Request) => store.delete(r.url),
    } as unknown as Cache;
    const src = makeSource([indexed('CLI00001', 'Acme Co', 'NS:acme.example', [['acme.example']])]);
    const nsq = makeNs({});
    await loadLinkReport(env, failing, nsq.ns, ['acme.example'], { readSource: src.source });
    ok([...store.keys()].some((u) => u.includes('/quick/')), 'the quick entry is cached');
    // The re-read succeeds; writing the patch back does not.
    const brokenPut = { ...failing, put: async () => { throw new Error('cache is unwell'); } } as unknown as Cache;
    let threw: any = null;
    try {
      await refreshAppliedAccounts(env, brokenPut, ['acme.example'], ['CLI00001'], {
        readSource: { getSubscriber: (n: string) => src.source.getSubscriber(n), getSubscriptions: async () => [] },
      });
    } catch (e) { threw = e; }
    ok(threw === null, 'refreshAppliedAccounts never throws — the write already happened, and reporting it is the caller’s job now');
    ok(![...store.keys()].some((u) => u.includes('/quick/')), 'and the entry it could not patch is deleted, so the next load re-reads');
  }

  // ── after a patch, the overlay a quick view borrows is re-derived from the patched full entry ──
  {
    const { cache } = memory();
    const subs = [
      { accountNumber: 'CLI00001', accountName: 'Acme Co', accountStatus: 'Active', externalId: 'NS:acme.example', accountAttribute: [{ key: 'PBX', aggregator: 1, childAttribute: [{ key: 'Domain', value: 'acme.example' }] }] },
    ];
    const source = {
      listAllSubscribers: async () => subs as any,
      getSubscriber: async (n: string) => subs.find((x) => x.accountNumber === n) as any,
      getSubscriptions: async () => [{ subscriptionIdentifier: 'beta.example', subscriptionOffer: [{ name: 'Domain Usage' }] }] as any,
    };
    const nsq = makeNs({});
    const full = await loadLinkReport(env, cache, nsq.ns, ['acme.example', 'beta.example'], { readSource: source, mode: 'full', now: new Date('2026-09-03T10:00:00.000Z') });
    ok(full.report.usage.length === 1 && full.report.usage[0]!.verdict === 'mismatch',
      'the full pass left a mismatch behind: the subscription says beta.example, the link says acme.example');

    // THE PAGE IS ALREADY ON THE QUICK VIEW when the write happens — so a quick entry exists, cached
    // with the overlay as it stood BEFORE the write. That entry is what the reload reads back.
    const onScreen = await loadLinkReport(env, cache, nsq.ns, ['acme.example', 'beta.example'], { readSource: source, now: new Date('2026-09-03T10:01:00.000Z') });
    ok(onScreen.report.usage.length === 1, 'the quick view on screen shows the mismatch the full pass found');

    // The account is relinked to beta.example, which is what its usage subscription always said.
    subs[0] = { ...subs[0]!, externalId: 'NS:beta.example', accountAttribute: [{ key: 'PBX', aggregator: 1, childAttribute: [{ key: 'Domain', value: 'beta.example' }] }] };
    await refreshAppliedAccounts(env, cache, ['acme.example', 'beta.example'], ['CLI00001'], { readSource: source });

    // THE PAGE'S REAL PATH: after an apply it reloads WITHOUT refresh, so this is a cache HIT of the
    // quick entry the patch just rewrote. With `refresh: true` this assertion passes for the wrong
    // reason — a fresh quick load re-reads the overlay key and would show the new verdict whatever the
    // quick entry holds. The bug it guards is patching quick BEFORE the overlay is re-derived, which
    // bakes the pre-write verdicts into exactly the entry the page is about to read back.
    const quick = await loadLinkReport(env, cache, nsq.ns, ['acme.example', 'beta.example'], { readSource: source, now: new Date('2026-09-03T10:02:00.000Z') });
    ok(quick.report.mode === 'quick', 'the reload is the quick view the page was on');
    ok(quick.report.verifiedAt === '2026-09-03T10:00:00.000Z',
      'the overlay keeps the timestamp of the pass that actually verified it — a patch verifies nothing');
    ok(quick.report.usage.length === 0,
      'while the verdict itself follows the patched record — the relink resolved the mismatch, and the cached quick entry does not keep showing it for the rest of the TTL');
    ok(quick.report.rows.find((r) => r.domain === 'beta.example')?.accounts[0]?.accountNumber === 'CLI00001',
      'and that same cached entry shows the link the write made');
  }

  // ── a cache that refuses to DELETE cannot fail a write either ─────────────────────────────────
  // The read phase's own catch drops the entries it can no longer patch. That delete runs after a write
  // that already happened, so it is guarded exactly like the patch phase's.
  {
    const { store } = memory();
    const src = makeSource([indexed('CLI00001', 'Acme Co', 'NS:acme.example', [['acme.example']])]);
    const nsq = makeNs({});
    const brittle = {
      match: async (r: Request) => { const hit = store.get(r.url); return hit ? hit.clone() : undefined; },
      put: async (r: Request, res: Response) => { store.set(r.url, res.clone()); },
      delete: async () => { throw new Error('cache will not let go'); },
    } as unknown as Cache;
    await loadLinkReport(env, brittle, nsq.ns, ['acme.example'], { readSource: src.source });
    let threw: any = null;
    try {
      // The re-read fails, so the read-phase catch runs — and its delete throws.
      await refreshAppliedAccounts(env, brittle, ['acme.example'], ['CLI00001'], {
        readSource: { getSubscriber: async () => { throw new Error('OneBill said no'); }, getSubscriptions: async () => [] },
      });
    } catch (e) { threw = e; }
    ok(threw === null, 'a delete that throws in the READ-phase catch is swallowed too — the write already happened');
  }
}

// ── a shared domain: the account linked by site can never hold the usage subscription ─────────────
// OneBill forbids duplicate identifiers, so on a domain split across accounts exactly one holds Domain
// Usage. `missing` on the sited accounts is the design, not a fault, and must not be reported.
{
  const NS = 'NS';
  const domains: NsDomainInfo[] = [{ domain: 'shared.example', sites: ['HQ'] }, { domain: 'solo.example', sites: [] }];
  const accounts: AccountRef[] = [
    { accountNumber: 'CLI00101', accountName: 'Holder Co', status: 'Active' },
    { accountNumber: 'CLI00102', accountName: 'Sited Co', status: 'Active' },
    { accountNumber: 'CLI00103', accountName: 'Solo Co', status: 'Active' },
  ];
  const link = (value: string, qualifier?: string): SourcedLink => ({ ns: NS, group: 'PBX', value, ...(qualifier ? { qualifier } : {}) });
  const sub = (identifier: string): Subscription => ({ subscriptionIdentifier: identifier, subscriptionOffer: [{ name: 'Domain Usage' }] });
  const gather: GatherResult = {
    rows: [
      { accountNumber: 'CLI00101', links: [link('shared.example')], subscriptions: [sub('shared.example')] },
      { accountNumber: 'CLI00102', links: [link('shared.example', 'HQ')], subscriptions: [] },
      { accountNumber: 'CLI00103', links: [link('solo.example')], subscriptions: [] },
    ],
    failures: [], requestCount: 0, retried: 0,
  };
  const rep = buildLinkReport(domains, gather, { ns: NS, offerNames: ['Domain Usage'], usageIgnore: ['_OLD'] } as any, accounts);
  ok(!rep.usage.some((u) => u.account.accountNumber === 'CLI00102'), 'the sited account on a domain another account covers is not reported as missing');
  ok(!rep.usage.some((u) => u.account.accountNumber === 'CLI00101'), 'the holder is ok and not reported');
  ok(rep.usage.some((u) => u.account.accountNumber === 'CLI00103' && u.verdict === 'missing'), 'an account nobody covers is still missing (CLI00103)');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
