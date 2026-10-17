/** Offline tests for the Ringotel provision planner. pnpm test:provision */
import { provisionEnabled, provisionLabel, resolveProvisionConfig, ProvisionConfigError, railAdmits, deriveOrgLabel, labelProblem, diffConnector, DIFF_EXCLUDED_KEYS, maskedKey, planChecklist, fleetState, signinMatches, labelMatches, STEP_ORDER, type ProvisionConfig, type ChecklistInput, type ChecklistRow, type OrgView, type StepId } from './ringotelProvision.js';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); };
const throws = (f: () => unknown, re: RegExp, m: string) => { try { f(); ok(false, `${m} (did not throw)`); } catch (e) { ok(re.test((e as Error).message) && e instanceof ProvisionConfigError, `${m}: ${(e as Error).message}`); } };

const BASE = { RINGOTEL_API_KEY: 'k', RINGOTEL_CONNECTION_TEMPLATE: 'Standard', RINGOTEL_DEFAULT_PACKAGE: 'Essentials', RINGOTEL_REGION: 'US East' };

// ── enabled ──
ok(!provisionEnabled({}), '[cfg] off without any setting');
ok(!provisionEnabled({ RINGOTEL_API_KEY: 'k' }), '[cfg] off without a template name');
ok(provisionEnabled(BASE), '[cfg] on with key + template');

// ── config ──
{
  const c = resolveProvisionConfig(BASE);
  ok(c.rail === null, '[cfg] unset rail ⇒ null (inert writes)');
  ok(c.ssoServiceId === null, '[cfg] unset SSO service ⇒ null');
  ok(c.connectionName === 'Ringotel', '[cfg] connection name defaults to Ringotel');
  ok(c.templateName === 'Standard' && c.defaultPackage === 'Essentials' && c.region === 'US East', '[cfg] names pass through trimmed');
}
ok(resolveProvisionConfig({ ...BASE, RINGOTEL_LABEL: 'Acme App' }).connectionName === 'Acme App', '[cfg] connection name = RINGOTEL_LABEL');
// ONE reading of the setting, because the route needs the name before this config exists: every refusal
// in its gate chain is produced first, and one of them is the refusal that this would not resolve.
ok(provisionLabel({ RINGOTEL_LABEL: ' Acme App ' }) === 'Acme App', '[cfg] the app label is trimmed');
ok(provisionLabel({ RINGOTEL_LABEL: '   ' }) === 'Ringotel' && provisionLabel({}) === 'Ringotel', '[cfg] and falls back when it is unset or blank');
ok(resolveProvisionConfig({ ...BASE, RINGOTEL_LABEL: ' Acme App ' }).appLabel === provisionLabel({ RINGOTEL_LABEL: ' Acme App ' }),
  '[cfg] and the config fills appLabel from that same reading, so the page and its errors cannot disagree');
ok(resolveProvisionConfig({ ...BASE, RINGOTEL_SSO_SERVICE_ID: ' 1/x_sso ' }).ssoServiceId === '1/x_sso', '[cfg] SSO service trimmed');
throws(() => resolveProvisionConfig({ ...BASE, RINGOTEL_DEFAULT_PACKAGE: '' }), /RINGOTEL_DEFAULT_PACKAGE/, '[cfg] empty package refused');
throws(() => resolveProvisionConfig({ ...BASE, RINGOTEL_REGION: '  ' }), /RINGOTEL_REGION/, '[cfg] empty region refused');
throws(() => resolveProvisionConfig({ ...BASE, RINGOTEL_PROVISION_DOMAINS: 'a.example.com,*' }), /RINGOTEL_PROVISION_DOMAINS/, '[cfg] rail grammar errors carry the setting name');
{
  const c = resolveProvisionConfig({ ...BASE, RINGOTEL_PROVISION_DOMAINS: '*,!lab.example.com' });
  ok(c.rail !== null && c.rail.wildcard === true && c.rail.except.includes('lab.example.com'), '[cfg] wildcard rail with carve-out');
}

// ── rail ──
ok(!railAdmits(null, 'a.example.com'), '[rail] null admits nothing');
ok(railAdmits({ wildcard: true, except: [] }, 'a.example.com'), '[rail] * admits');
ok(!railAdmits({ wildcard: true, except: ['a.example.com'] }, 'A.Example.com'), '[rail] carve-out wins, case-insensitive');
ok(railAdmits({ wildcard: false, domains: ['b.example.com'] }, 'b.example.com') && !railAdmits({ wildcard: false, domains: ['b.example.com'] }, 'c.example.com'), '[rail] explicit list');

// ── label ──
ok(deriveOrgLabel('acme.12345.service') === 'acme', '[label] territory suffix stripped');
ok(deriveOrgLabel('Acme.12345.SERVICE') === 'acme', '[label] lowercased');
ok(deriveOrgLabel('acmevoice') === 'acmevoice', '[label] bare domain is its own label');
ok(deriveOrgLabel('hy-phen.12345.service') === 'hy-phen', '[label] hyphen survives');
ok(deriveOrgLabel('acme.example.com') === 'acme.example.com', '[label] a bare dotted domain is NOT truncated (no territory suffix)');
ok(labelProblem('acme', ['other']) === null, '[label] free label is fine');
ok(/taken/i.test(labelProblem('acme', ['ACME']) ?? ''), '[label] collision is case-insensitive and says taken');
ok(/characters|invalid/i.test(labelProblem('ac me', []) ?? ''), '[label] space refused');
ok(/characters|invalid/i.test(labelProblem('', []) ?? ''), '[label] empty refused');
ok(labelProblem('a'.repeat(64), []) === null && labelProblem('a'.repeat(65), []) !== null, '[label] 64 max');

// ── diff ──
{
  const tpl = { country: 'US', domain: 'src', address: 'src.12345.service', name: 'Acme', provision: { nochats: true, proxy: { paddr: 'sbc.example.net', ppass: 'a' }, forwarding: { cfon: '*40' }, vmail: { ext: '9901' } } };
  const same = { country: 'US', address: 'other.12345.service', name: 'Acme App', provision: { nochats: true, proxy: { paddr: 'sbc.example.net', ppass: 'a' }, forwarding: { cfon: '*40' }, vmail: { ext: '9901' }, maxregs: 0, aiPrompt: '', ip_list: [], nopop: false } };
  const d = diffConnector(tpl, same);
  ok(d.matches && d.groups.length === 0, '[diff] address/domain/name and keys the template never defined are ignored');
  ok(d.compared > 0, '[diff] compared counts the keys it looked at');
  ok(DIFF_EXCLUDED_KEYS.includes('address'), '[diff] address is in the exported exclusion list');
}
{
  // The live report this rule came from: Ringotel fills a created connector with server-side defaults the
  // template never carried — `provision.maxregs: 3` — and a connection made from the template five
  // seconds earlier read as "differs from template". A template has an opinion about the fields it
  // defines and none at all about the rest. The value is deliberately NOT one of the shapes the old
  // "looks like a default" list would have forgiven ('', false, 0, [], null): 3 is a real value, and it
  // is still not a difference, because nothing asked for it.
  const tpl = { provision: { nochats: true } };
  const fresh = { provision: { nochats: true, maxregs: 3, ip_list: ['10.0.0.1'], aiPrompt: 'hello' } };
  const d = diffConnector(tpl, fresh);
  ok(d.matches && d.groups.length === 0, '[diff] a key the template does not define is never a difference, whatever the branch value');
  ok(d.compared === 1, `[diff] and compared counts the TEMPLATE's keys only (${d.compared})`);
}
{
  // The other direction still is one: the template asked for it and the connection does not have it.
  const tpl = { provision: { nochats: true, vmail: { ext: '9901' } } };
  const b = { provision: { nochats: true } };
  const d = diffConnector(tpl, b);
  const f = d.groups.flatMap((g) => g.fields).find((x) => x.key === 'provision.vmail.ext');
  ok(!d.matches && f !== undefined && f.branch === null && f.template === '"9901"',
    '[diff] a key the template defines and the connection lacks IS a difference, and renders absent on the branch');
}
{
  const tpl = { country: 'US', provision: { nochats: true, proxy: { paddr: 'sbc.example.net', ppass: 'a' }, forwarding: { cfon: '*40' } } };
  const b = { country: 'CA', provision: { nochats: false, proxy: { paddr: 'sbc2.example.net', ppass: 'b' }, forwarding: { cfon: '*40' } } };
  const d = diffConnector(tpl, b);
  ok(!d.matches, '[diff] differences ⇒ not matching');
  const sections = d.groups.map((g) => g.section);
  ok(JSON.stringify(sections) === JSON.stringify(['general', 'proxy']), `[diff] grouped by section, sorted: ${sections}`);
  const general = d.groups.find((g) => g.section === 'general')!;
  ok(general.fields.map((f) => f.key).join(',') === 'country,provision.nochats', `[diff] general fields sorted: ${general.fields.map((f) => f.key)}`);
  const proxy = d.groups.find((g) => g.section === 'proxy')!;
  const pp = proxy.fields.find((f) => f.key === 'provision.proxy.ppass')!;
  ok(pp.template === '••••' && pp.branch === '••••', '[diff] secrets are masked on both sides');
  ok(!JSON.stringify(d).includes('"a"') && !JSON.stringify(d).includes('"b"'), '[diff] masked values never appear in the output');
}
// ── masking is a PATTERN on the leaf, not a list of three keys ─────────────────────────────────────
// The denylist named the secrets this connector blob was known to carry on the day the diff was written.
// The blob is a vendor's, and a fourth secret key would have rendered its value into the page in full.
{
  const secret = (key: string, a: unknown, b: unknown) => {
    const path = key.split('.');
    const nest = (v: unknown): Record<string, unknown> => [...path].reverse().reduce<unknown>((acc, k) => ({ [k]: acc }), v) as Record<string, unknown>;
    const d = diffConnector({ provision: nest(a) }, { provision: nest(b) });
    return d.groups.flatMap((g) => g.fields).find((f) => f.key === `provision.${key}`);
  };
  for (const [key, why] of [
    ['proxy.ppass', 'the proxy password the old denylist named'],
    ['authpass', 'the auth password it named too'],
    ['proxy.pauth', 'and the proxy auth secret'],
    ['sipToken', 'a key NOBODY listed \u2014 which is the whole point'],
    ['apiKey', 'and one that says "key"'],
    ['clientSecret', 'and one that says "secret"'],
    ['sipPwd', 'and the short spelling'],
  ] as const) {
    const f = secret(key, 'aaa', 'bbb')!;
    ok(f !== undefined && f.template === '\u2022\u2022\u2022\u2022' && f.branch === '\u2022\u2022\u2022\u2022', `[mask] ${key} is masked on both sides \u2014 ${why}`);
  }
  const both = diffConnector({ provision: { sipToken: 'aaa' } }, { provision: { sipToken: 'bbb' } });
  ok(!JSON.stringify(both).includes('aaa') && !JSON.stringify(both).includes('bbb'), '[mask] and neither value reaches the output');
  ok(!both.matches, '[mask] a masked field that disagrees is still a difference, not a match');
  // The allowlist, one decision per entry: an auth USERNAME is an identity this kit already renders
  // everywhere, and blanking it would hide the one connector field a mis-provisioned SIP identity shows in.
  const an = secret('authname', '100r', '200r')!;
  ok(an.template === '"100r"' && an.branch === '"200r"', `[mask] authname is NOT masked \u2014 it is a username (${an.template} vs ${an.branch})`);
  // On the LEAF: a section called `auth` must not blank every field under it.
  const under = secret('auth.paddr', 'sbc.example.net', 'sbc2.example.net')!;
  ok(under.template === '"sbc.example.net"', '[mask] a plain field under a section whose NAME matches keeps its value \u2014 the leaf decides, not the path');
  ok(maskedKey('provision.proxy.PPASS') && !maskedKey('provision.AUTHNAME'), '[mask] both readings are case-insensitive');
  ok(!maskedKey('provision.proxy.paddr') && !maskedKey('country'), '[mask] and an ordinary field is never masked');
}
// ── masking also depends on the VALUE, not just the key ────────────────────────────────────────────
// The live false positive this rule fixes: `provision.nochangepass` is a BOOLEAN (may app users change
// their own password), matches DIFF_MASK_RE on its name, and used to render as `••••` on both sides.
{
  const d = diffConnector({ provision: { nochangepass: false } }, { provision: { nochangepass: true } });
  const f = d.groups.flatMap((g) => g.fields).find((x) => x.key === 'provision.nochangepass')!;
  ok(f !== undefined && f.template === 'false' && f.branch === 'true',
    `[mask] nochangepass is a boolean and is never masked, allowlisted or not (${f?.template} vs ${f?.branch})`);
}
{
  // A key that matches the pattern and holds a BOOLEAN — not on the allowlist — still never masks: the
  // value-type gate covers unknown keys the same way it covers the documented ones.
  const d = diffConnector({ provision: { sipToken: true } }, { provision: { sipToken: false } });
  const f = d.groups.flatMap((g) => g.fields).find((x) => x.key === 'provision.sipToken')!;
  ok(f !== undefined && f.template === 'true' && f.branch === 'false',
    `[mask] a masked-pattern key holding a boolean is not masked (${f?.template} vs ${f?.branch})`);
}
{
  // A STRING secret is still masked exactly as before — the value-type rule narrows what masks, it
  // doesn't remove masking from the case it exists for.
  const d = diffConnector({ provision: { proxy: { ppass: 'a' } } }, { provision: { proxy: { ppass: 'b' } } });
  const f = d.groups.flatMap((g) => g.fields).find((x) => x.key === 'provision.proxy.ppass')!;
  ok(f !== undefined && f.template === '••••' && f.branch === '••••', '[mask] proxy.ppass string values are still masked on both sides');
}
{
  // Each side is decided independently: a masked string on the template next to an absent branch value
  // masks only the template side — the branch renders absent (null), not '••••' over nothing.
  const d = diffConnector({ provision: { authpass: 'topsecret' } }, { provision: {} });
  const f = d.groups.flatMap((g) => g.fields).find((x) => x.key === 'provision.authpass')!;
  ok(f !== undefined && f.template === '••••' && f.branch === null,
    `[mask] a masked string on the template vs absent on the branch ⇒ '••••' vs null (${f?.template} vs ${f?.branch})`);
}
{
  // `country` is the same rule as any other key: the template does not define one, so the connection's is
  // not a finding. It used to be reported as "null vs US", which said the template disagreed when it had
  // said nothing.
  const tpl = { provision: { nochats: true } };
  const b = { country: 'US', provision: { nochats: true } };
  const d = diffConnector(tpl, b);
  ok(d.matches, '[diff] country absent on the template, present on the branch: not a difference');
}
{
  const tpl = { provision: { nochats: true } };
  const b = { provision: { nochats: true } };
  const d = diffConnector(tpl, b);
  ok(!d.groups.some((g) => g.fields.some((f) => f.key === 'country')), '[diff] country absent on both sides produces no field');
  ok(d.compared === 1, '[diff] country absent on both sides is not counted in compared');
}

// ── checklist planner + fleet state ──
const PKGS = [{ id: 7, name: 'Essentials' }, { id: 9, name: 'Pro' }];
const TPL = { params: { country: 'US', provision: { nochats: true, proxy: { paddr: 'sbc.example.net' } } } };
const BRANCH = { id: 'b1', address: 'acme.12345.service', country: 'US', name: 'Ringotel', provision: { nochats: true, proxy: { paddr: 'sbc.example.net' } } };
const DRIFTED = { ...BRANCH, id: 'b2', country: 'CA', provision: { nochats: true, proxy: { paddr: 'sbc2.example.net' } } };
const CFG = (over: Partial<ProvisionConfig> = {}): ProvisionConfig => ({ rail: { wildcard: true, except: [] }, templateName: 'Standard', ssoServiceId: '1/x_sso', defaultPackage: 'Essentials', region: 'US East', connectionName: 'Ringotel', appLabel: 'Ringotel', ...over });
const ORG = (over: Partial<OrgView> = {}): OrgView => ({ id: 'o1', domain: 'acme', packageid: 7, params: { sso: '1/x_sso', hidePassInEmail: true }, ...over });
const INPUT = (over: Partial<ChecklistInput> = {}): ChecklistInput => ({
  domain: 'acme.12345.service', cfg: CFG(), org: ORG(), branches: [BRANCH], template: TPL, packages: PKGS,
  inIndex: true, reconciled: true, addressOverride: false, eventsCovered: true, prepopCovered: true, writeCovered: true, ...over,
});
const steps = (over: Partial<ChecklistInput> = {}): Record<StepId, ChecklistRow> => {
  const m = {} as Record<StepId, ChecklistRow>;
  for (const r of planChecklist(INPUT(over))) m[r.step] = r;
  return m;
};
const fleet = (over: Partial<ChecklistInput> & { orgCount?: number; orgCountBy?: 'address' | 'name' } = {}) => {
  const { orgCount = over.org === null ? 0 : 1, orgCountBy = 'address', ...rest } = over;
  const { choice, reconciled, ...base } = INPUT(rest);
  void choice; void reconciled;
  return fleetState({ ...base, orgCount, orgCountBy });
};
const NO_RAIL = CFG({ rail: null });
const OFF_RAIL = CFG({ rail: { wildcard: false, domains: ['other.12345.service'] } });

// ── the nine rows, in order ──
{
  ok(JSON.stringify(STEP_ORDER) === JSON.stringify(['rail', 'org', 'label', 'package', 'signin', 'connector', 'index', 'reconcile', 'rails']), '[plan] STEP_ORDER is the order Enable-all applies');
  const rows = planChecklist(INPUT());
  ok(rows.map((r) => r.step).join(',') === STEP_ORDER.join(','), '[plan] planChecklist emits one row per step in STEP_ORDER');
}

// ── everything right ⇒ every row ok (asserted per row, not merged) ──
{
  const s = steps();
  ok(s.rail.verdict === 'ok', '[plan/all-ok] rail ok');
  ok(s.org.verdict === 'ok', '[plan/all-ok] org ok');
  ok(s.label.verdict === 'ok', '[plan/all-ok] label ok');
  ok(s.package.verdict === 'ok', '[plan/all-ok] package ok');
  ok(s.signin.verdict === 'ok', '[plan/all-ok] signin ok');
  ok(s.connector.verdict === 'ok', '[plan/all-ok] connector ok');
  ok(s.index.verdict === 'ok', '[plan/all-ok] index ok');
  ok(s.reconcile.verdict === 'ok', '[plan/all-ok] reconcile ok');
  ok(s.rails.verdict === 'ok', '[plan/all-ok] rails ok');
  ok(Object.values(s).every((r) => r.fixable === false), '[plan/all-ok] nothing is fixable when nothing needs fixing');
  ok(s.connector.diff === undefined, '[plan/all-ok] a matching connector carries no diff');
}

// ── no org, rail admits, template resolved ──
{
  const s = steps({ org: null, branches: [], inIndex: false, reconciled: null });
  ok(s.org.verdict === 'fix' && s.org.title === 'Create the organization', '[plan/no-org] org is a fix titled Create the organization');
  ok(s.org.fixable === true, '[plan/no-org] org is fixable when rail admits, template resolved and label clean');
  ok(s.connector.verdict === 'fix' && s.connector.title === 'Create the connection', '[plan/no-org] connector is a fix titled Create the connection');
  ok(s.connector.fixable === false, '[plan/no-org] connector is not fixable until the org exists');
  ok(s.label.verdict === 'info' && /acme/.test(s.label.detail), '[plan/no-org] label reports the derived label');
  ok(s.package.verdict === 'info' && /create/i.test(s.package.detail), '[plan/no-org] package will be set on create');
  ok(s.signin.verdict === 'info' && /create/i.test(s.signin.detail), '[plan/no-org] sign-in will be set on create');
  ok(steps({ org: null, branches: [], template: null }).org.fixable === false, '[plan/no-org] an unresolved template makes the org create not fixable');
  ok(s.index.verdict === 'info', '[plan/no-org] index is informational');
  ok(s.reconcile.verdict === 'info', '[plan/no-org] reconcile is informational');
}

// ── rail unset ⇒ blocked, and the write steps with it ──
{
  const s = steps({ cfg: NO_RAIL, org: null, branches: [], inIndex: false, reconciled: null });
  ok(s.rail.verdict === 'blocked' && /RINGOTEL_PROVISION_DOMAINS/.test(s.rail.detail), '[plan/rail-null] rail blocked, naming RINGOTEL_PROVISION_DOMAINS');
  // The two variants say different things because the reader can do different things about them: an
  // unset rail is a deployment-wide fact, an excluding one is a list this domain can be added to.
  ok(/is not set/.test(s.rail.detail), '[plan/rail-null] rail detail says the setting is not set');
  ok(!/Add it to/.test(s.rail.detail), '[plan/rail-null] and does not tell the reader to add a domain to a setting that does not exist');
  ok(s.org.verdict === 'blocked' && s.org.fixable === false, '[plan/rail-null] org is blocked, not fixable');
  ok(s.connector.verdict === 'blocked', '[plan/rail-null] creating the connection is blocked too');
  ok(s.label.verdict === 'info' && /acme/.test(s.label.detail), '[plan/rail-null] label still reports — a pure observation');
  ok(s.index.verdict === 'info', '[plan/rail-null] index still reports');
}
{
  const s = steps({ cfg: OFF_RAIL, org: ORG({ params: {} }), inIndex: false, reconciled: false });
  ok(s.rail.verdict === 'blocked' && !/unset/i.test(s.rail.detail), '[plan/off-rail] a set rail that excludes the domain does not claim to be unset');
  ok(s.signin.verdict === 'blocked', '[plan/off-rail] a sign-in fix becomes blocked off the rail');
  ok(s.reconcile.verdict === 'blocked', '[plan/off-rail] running the reconcile is blocked off the rail');
  ok(s.index.verdict === 'fix', '[plan/off-rail] refreshing the index is not a tenant write, so it still offers a fix');
  ok(s.label.verdict === 'ok', '[plan/off-rail] a matching label still reads ok');
  ok(s.connector.verdict === 'ok', '[plan/off-rail] a matching connector still reads ok');
}
// ── RINGOTEL_OVERRIDES: the domain's connection lives at an address this page does not derive ──
// Every create writes `address: <the NS domain>` while matching goes through the override, so a
// connection built here would never be the one the override points at — the row would go on offering the
// same create, one duplicate connection per press. The same shape as the rail block, and it takes
// precedence: a rail can be widened by editing a setting, an overridden domain cannot be provisioned here.
{
  const s = steps({ addressOverride: true, org: null, branches: [], inIndex: false, reconciled: false });
  ok(s.org.verdict === 'blocked' && s.org.fixable === false, '[plan/override] the org row is blocked and offers no fix');
  ok(/RINGOTEL_OVERRIDES/.test(s.org.detail), '[plan/override] naming the setting that makes it unsupported');
  ok(s.connector.verdict === 'blocked', '[plan/override] and the connection create with it — the same address is what both would write');
  ok(s.index.verdict === 'info' && s.label.verdict === 'info', '[plan/override] while the observation-only rows still report');
}
{
  // ON the rail and overridden: the override alone has to block, or a wide-open rail would let the
  // create through. This is the case a check written only into the rail pass would miss.
  const s = steps({ addressOverride: true, org: ORG({ params: {} }), reconciled: false });
  ok(s.signin.verdict === 'blocked' && /RINGOTEL_OVERRIDES/.test(s.signin.detail),
    '[plan/override] a writing fix on a domain the rail DOES admit is still blocked, by the override');
  ok(s.reconcile.verdict === 'blocked', '[plan/override] and so is the reconcile');
}
{
  // Both bounds at once: the override is the one reported, because it is the one that cannot be lifted.
  const s = steps({ addressOverride: true, cfg: OFF_RAIL, org: null, branches: [] });
  ok(/RINGOTEL_OVERRIDES/.test(s.org.detail) && !/RINGOTEL_PROVISION_DOMAINS/.test(s.org.detail),
    '[plan/override] off the rail AND overridden reports the override — the stronger statement');
}
ok(steps({ addressOverride: false, org: null, branches: [] }).org.fixable === true,
  '[plan/override] and a domain with no override is untouched by any of it');

// ── label ──
ok(steps({ org: ORG({ domain: 'ACME' }) }).label.verdict === 'ok', '[plan/label] comparison is case-insensitive');
ok(labelMatches('ACME', 'acme') === true, '[plan/label] the shared comparison ignores case');
ok(labelMatches('acme-old', 'acme') === false, '[plan/label] the shared comparison rejects a different label');
ok(labelMatches('  acme  ', 'acme') === true, '[plan/label] the shared comparison ignores surrounding whitespace');
ok(labelMatches(null, 'acme') === false, '[plan/label] an absent org label never matches');
{
  const r = steps({ org: ORG({ domain: 'acme-old' }) }).label;
  ok(r.verdict === 'info' && r.fixable === false, '[plan/label] a mismatch is info and never fixable');
  ok(/editing/i.test(r.detail) && /"acme-old"/.test(r.detail) && /"acme"/.test(r.detail), '[plan/label] the mismatch names both values and says Ringotel does not allow editing');
}
{
  const r = steps({ org: null, branches: [], choice: { label: 'ac me' } }).label;
  ok(r.verdict === 'info' && /letters, digits/.test(r.detail), '[plan/label] a chosen label that breaks the rule carries the problem');
  ok(steps({ org: null, branches: [], choice: { label: 'ac me' } }).org.fixable === false, '[plan/label] an unusable label makes the org create not fixable');
}

// ── package ──
{
  const r = steps({ cfg: CFG({ defaultPackage: 'Nope' }) }).package;
  ok(r.verdict === 'blocked' && /RINGOTEL_DEFAULT_PACKAGE/.test(r.detail), '[plan/package] an unresolvable default package is blocked and names the setting');
}
ok(steps({ choice: { pkg: 'Nope' } }).package.verdict === 'blocked', '[plan/package] an unresolvable chosen package is blocked too');
ok(steps({ choice: { pkg: 'essentials' } }).package.verdict === 'ok', '[plan/package] package names resolve case-insensitively');
{
  const r = steps({ org: ORG({ packageid: 9 }) }).package;
  ok(r.verdict === 'info' && r.fixable === false, '[plan/package] a live org on another package is info, never a fix');
}
{
  const r = steps({ org: ORG({ packageid: 9 }), choice: { pkg: 'Essentials' } }).package;
  ok(r.verdict === 'info' && r.fixable === false, '[plan/package] an explicit choice still cannot rewrite a live org package');
}
ok(steps({ org: ORG({ packageid: 9 }), choice: { pkg: 'Pro' } }).package.verdict === 'ok', '[plan/package] the chosen package is what the org is compared against');

// ── sign-in ──
ok(/RINGOTEL_SSO_SERVICE_ID/.test(steps({ cfg: CFG({ ssoServiceId: null }) }).signin.detail), '[plan/signin] no SSO service configured ⇒ info naming the setting');
ok(steps({ cfg: CFG({ ssoServiceId: null }) }).signin.verdict === 'info', '[plan/signin] no SSO service configured ⇒ the step is skipped, not failed');
ok(steps().signin.verdict === 'ok', '[plan/signin] matching service id + hidePassInEmail ⇒ ok');
ok(steps({ org: ORG({ params: { sso: '', hidePassInEmail: true } }) }).signin.verdict === 'fix', '[plan/signin] an empty sso is no SSO, so SSO mode is a fix');
ok(steps({ org: ORG({ params: { hidePassInEmail: true } }) }).signin.verdict === 'fix', '[plan/signin] an absent sso is a fix in SSO mode');
ok(steps({ org: ORG({ params: { sso: '2/other', hidePassInEmail: true } }) }).signin.verdict === 'fix', '[plan/signin] a different service id is a fix');
// ⚠️ THE WELCOME-EMAIL SETTING IS NOT A SIGN-IN SETTING. A live domain whose SSO was correctly bound
// reported "SSO mismatch" because `hidePassInEmail` was false — a finding naming the wrong thing, whose
// fix rewrote a setting the operator had chosen. The row judges the SSO service and says the rest.
ok(steps({ org: ORG({ params: { sso: '1/x_sso' } }) }).signin.verdict === 'ok', '[plan/signin] SSO bound but hidePassInEmail off ⇒ still ok');
ok(!/welcome email/i.test(steps({ org: ORG({ params: { sso: '1/x_sso' } }) }).signin.detail),
  '[plan/signin] and under SSO the row says nothing about welcome emails at all — the app never emails a password');
// WHICH of the two it is, named. "The sign-in settings do not match" is a sentence an operator cannot
// act on, and the two causes take different actions. One assertion per cause.
ok(/no SSO service is set/.test(steps({ org: ORG({ params: { hidePassInEmail: true } }) }).signin.detail),
  '[plan/signin] an absent sso says so');
ok(/a different SSO service is set/.test(steps({ org: ORG({ params: { sso: '2/other', hidePassInEmail: true } }) }).signin.detail),
  '[plan/signin] a different service id says so');
// In credentials mode a welcome email really is sent, so what it contains is worth saying — as a fact
// about the organization, appended to the verdict, never as a finding and never as a fix.
ok(/Welcome emails for new activations include the password\./
  .test(steps({ org: ORG({ params: { hidePassInEmail: false } }), choice: { signin: 'credentials' } }).signin.detail),
  '[plan/signin] credentials mode reports a welcome email that carries the password');
ok(/Welcome emails for new activations hide the password behind a link\./
  .test(steps({ org: ORG({ params: { hidePassInEmail: true } }), choice: { signin: 'credentials' } }).signin.detail),
  '[plan/signin] and one that does not');
ok(steps({ org: ORG({ params: { hidePassInEmail: false } }), choice: { signin: 'credentials' } }).signin.verdict === 'ok',
  '[plan/signin] and neither is a fix — it is informational');
ok(/Welcome emails for new activations/.test(steps({ cfg: CFG({ ssoServiceId: null }) }).signin.detail),
  '[plan/signin] a deployment managing no SSO gets the same sentence, because we cannot know which mode its users are in');
ok(steps({ org: ORG({ params: { hidePassInEmail: true } }), choice: { signin: 'credentials' } }).signin.verdict === 'ok', '[plan/signin] credentials mode wants no SSO');
ok(steps({ org: ORG({ params: { sso: '', hidePassInEmail: true } }), choice: { signin: 'credentials' } }).signin.verdict === 'ok', '[plan/signin] an empty sso reads as no SSO in credentials mode too');
ok(steps({ org: ORG({ params: { sso: '1/x_sso', hidePassInEmail: true } }), choice: { signin: 'credentials' } }).signin.verdict === 'fix', '[plan/signin] an SSO service in credentials mode is a fix');
ok(steps({ org: ORG({ params: {} }), choice: { signin: 'credentials' } }).signin.verdict === 'ok', '[plan/signin] credentials mode does NOT require hidePassInEmail');
ok(!steps({ org: ORG({ params: {} }) }).signin.detail.includes('1/x_sso'), '[plan/signin] the detail never carries the service id value');
ok(signinMatches(CFG(), { sso: '1/x_sso', hidePassInEmail: true }, 'sso') === true && signinMatches(CFG(), { sso: '1/x_sso' }, 'sso') === true, '[plan/signin] the exported predicate applyStep shares reads SSO mode the same way — the service id, and only that');
ok(signinMatches(CFG(), { sso: '2/other' }, 'sso') === false, '[plan/signin] and a different service id is still a mismatch');
ok(signinMatches(CFG(), { hidePassInEmail: false }, 'credentials') === true && signinMatches(CFG(), { sso: '1/x_sso', hidePassInEmail: true }, 'credentials') === false, '[plan/signin] the exported predicate reads credentials mode the same way');

// ── connector ──
{
  const r = steps({ template: null }).connector;
  ok(r.verdict === 'blocked' && /RINGOTEL_CONNECTION_TEMPLATE/.test(r.detail), '[plan/connector] no template ⇒ blocked, naming the setting');
}
{
  const r = steps({ branches: [] }).connector;
  ok(r.verdict === 'fix' && r.fixable === true, '[plan/connector] an org with no connection is a fixable fix');
}
{
  const r = steps({ branches: [BRANCH, DRIFTED] }).connector;
  ok(r.verdict === 'info' && r.fixable === false, '[plan/connector] two connections are info, never acted on');
  ok(/2/.test(r.detail) && /does not change them/i.test(r.detail), '[plan/connector] the multiple-connection detail carries the count and says the page leaves them alone');
}
{
  const r = steps({ branches: [DRIFTED] }).connector;
  ok(r.verdict === 'info' && r.fixable === false, '[plan/connector] drift is info and not fixable in v1');
  ok(r.diff !== undefined && r.diff.matches === false, '[plan/connector] the drift row carries the diff');
  ok(/general/.test(r.detail) && /proxy/.test(r.detail), '[plan/connector] the drift detail lists the section names');
  ok(!r.detail.includes('sbc2.example.net'), '[plan/connector] the detail never carries provision values — the diff does');
}

// ── index, reconcile, rails ──
{
  const r = steps({ inIndex: false }).index;
  ok(r.verdict === 'fix' && r.title === 'Refresh the organization list', '[plan/index] an org the cached list has not seen is a fix');
}
ok(steps({ org: null, branches: [], inIndex: false }).index.verdict === 'info', '[plan/index] no org ⇒ informational');
{
  const r = steps({ reconciled: false }).reconcile;
  ok(r.verdict === 'fix' && r.title === 'Run the first directory sync', '[plan/reconcile] a domain not yet synced is a fix');
}
ok(/not known/i.test(steps({ reconciled: null }).reconcile.detail), '[plan/reconcile] null is not known until it runs');
ok(steps({ org: null, branches: [], reconciled: false }).reconcile.verdict === 'info', '[plan/reconcile] with no org there is nothing to reconcile');
{
  const r = steps({ eventsCovered: false }).rails;
  ok(r.verdict === 'info' && r.fixable === false, '[plan/rails] a rail that does not cover the domain is info');
  ok(/NS_EVENTS_DOMAINS/.test(r.detail) && !/RINGOTEL_PREPOP_AUTO/.test(r.detail) && !/RINGOTEL_WRITE_DOMAINS/.test(r.detail), '[plan/rails] only the settings that do not cover it are named');
}
{
  const r = steps({ prepopCovered: false, writeCovered: false }).rails;
  ok(/RINGOTEL_PREPOP_AUTO/.test(r.detail) && /RINGOTEL_WRITE_DOMAINS/.test(r.detail) && !/NS_EVENTS_DOMAINS/.test(r.detail), '[plan/rails] both uncovered rails are named and the covered one is not');
}
ok(steps().rails.verdict === 'ok', '[plan/rails] all three covered ⇒ ok');

// ── fleet state, precedence tested pairwise where one beats another ──
ok(fleet({ orgCount: 2 }).state === 'multiple', '[fleet] two orgs ⇒ multiple');
ok(fleet({ orgCount: 2, cfg: OFF_RAIL }).state === 'multiple', '[fleet] multiple still wins over everything');
ok(fleet({ branches: [BRANCH, DRIFTED] }).state === 'multiple', '[fleet] two connections ⇒ multiple');
ok(/2/.test(fleet({ orgCount: 2 }).detail), '[fleet] the multiple row carries the count');
// Two organizations ANSWERING to this address and two merely HOLDING a name it could claim are different
// tenants to go and fix. Nothing answers to the address in the second case, so telling the reader that
// two organizations "claim this domain" would send them looking for connections neither one has.
{
  const byAddr = fleet({ orgCount: 2 }).detail;
  const byName = fleet({ orgCount: 2, orgCountBy: 'name' }).detail;
  ok(/match this domain/.test(byAddr) && !/without a connection/.test(byAddr), `[fleet] two organizations at this address match it: ${byAddr}`);
  ok(/2 .* organizations without a connection hold this domain/.test(byName) && !/match this domain/.test(byName),
    `[fleet] while two holding its NAME are said to do exactly that: ${byName}`);
  ok(fleet({ orgCount: 2, orgCountBy: 'name' }).state === 'multiple', '[fleet] both are the same state — one row, two sentences');
}
// THE RAIL IS NOT A STATE. A domain this page may not change can be perfectly well set up, and calling
// that "integration off" said the opposite of what was true. The audit runs for every domain; whether
// the page may act on it rides alongside as `enableable`, and the reason is the detail's last sentence.
{
  const off = fleet({ cfg: OFF_RAIL, org: null, branches: [] });
  ok(off.state === 'no-org', '[fleet] outside the rail a domain still reports its real audit state');
  ok(off.enableable === false, '[fleet] and is marked not enableable');
  ok(/read-only for this domain/.test(off.detail) && /RINGOTEL_PROVISION_DOMAINS/.test(off.detail),
    '[fleet] with the reason appended to its own detail');
  const on = fleet();
  ok(on.state === 'enabled' && on.enableable === true, '[fleet] a domain the rail includes is enableable');
  ok(!/read-only/.test(on.detail), '[fleet] and carries no read-only sentence');
  // An overridden domain is read-only too, and for a DIFFERENT reason — telling the operator to edit the
  // rail would send them to the wrong setting.
  const ov = fleet({ addressOverride: true });
  ok(ov.enableable === false, '[fleet] an overridden domain is not enableable either');
  ok(/RINGOTEL_OVERRIDES/.test(ov.detail) && !/read-only for this domain/.test(ov.detail),
    '[fleet] and says the override, not the rail');
  ok(fleet({ cfg: OFF_RAIL }).state === 'enabled', '[fleet] a fully set-up domain outside the rail reads as enabled');
}
ok(/RINGOTEL_PROVISION_DOMAINS/.test(fleet({ cfg: OFF_RAIL }).detail), '[fleet] a row the rail excludes names the setting that would admit it');
ok(fleet({ cfg: NO_RAIL }).enableable === false, '[fleet] an unset rail makes every domain read-only for this page');
{
  const r = fleet({ org: null, branches: [], inIndex: false });
  ok(r.state === 'no-org', '[fleet] no org ⇒ no-org');
  ok(r.orgLabel === null && r.expectedLabel === 'acme', '[fleet] a no-org row still carries the expected label');
}
{
  const r = fleet({ org: ORG({ domain: 'acme-old' }) });
  ok(r.state === 'label-mismatch', '[fleet] a differing label ⇒ label-mismatch');
  ok(r.orgLabel === 'acme-old' && r.expectedLabel === 'acme', '[fleet] the row carries both labels');
}
ok(fleet({ org: ORG({ domain: 'acme-old', params: {} }) }).state === 'label-mismatch', '[fleet] label-mismatch beats signin-differs');
ok(fleet({ org: ORG({ domain: 'ACME' }) }).state === 'enabled', '[fleet] label comparison is case-insensitive');
ok(fleet({ org: ORG({ params: {} }) }).state === 'signin-differs', '[fleet] an org without SSO ⇒ signin-differs');
ok(fleet({ org: ORG({ params: { sso: '1/x_sso' } }) }).state !== 'signin-differs', '[fleet] SSO bound but hidePassInEmail off is NOT signin-differs — the row follows the predicate, and the two settings are unrelated');
ok(fleet({ org: ORG({ params: {}, packageid: 9 }) }).state === 'signin-differs', '[fleet] signin-differs beats package-differs');
ok(fleet({ cfg: CFG({ ssoServiceId: null }), org: ORG({ params: {} }) }).state === 'enabled', '[fleet] with no SSO service configured the sign-in state does not exist');
ok(fleet({ org: ORG({ packageid: 9 }) }).state === 'package-differs', '[fleet] a different package ⇒ package-differs');
ok(fleet({ org: ORG({ packageid: 9 }), branches: [DRIFTED] }).state === 'package-differs', '[fleet] package-differs beats drift');
{
  const r = fleet({ branches: [DRIFTED] });
  ok(r.state === 'drift', '[fleet] a connector that differs from the template ⇒ drift');
  ok(JSON.stringify(r.drift) === JSON.stringify(['general', 'proxy']), `[fleet] the drift row names the sections: ${r.drift}`);
  ok(!JSON.stringify(r).includes('sbc2.example.net'), '[fleet] a fleet row never carries provision values');
}
ok(fleet({ branches: [DRIFTED], inIndex: false }).state === 'drift', '[fleet] drift beats not-in-index');
ok(fleet({ inIndex: false }).state === 'not-in-index', '[fleet] an org the cached index has not seen ⇒ not-in-index');
{
  const r = fleet();
  ok(r.state === 'enabled', '[fleet] everything matching ⇒ enabled');
  ok(r.drift === undefined, '[fleet] an enabled row carries no drift list');
  ok(r.domain === 'acme.12345.service', '[fleet] the row carries the NS domain');
}
ok(fleet({ template: null, branches: [DRIFTED] }).state === 'enabled', '[fleet] with no template there is nothing to call drift');

// ── the words an operator reads ────────────────────────────────────────────────────────────────────
// Every title and detail this module produces is read by a phone-system admin, not by the person who
// wrote the settings. The vocabulary below is ours, not theirs — "rail", "admits", "dig", "orgid",
// "org index", "reconcile" — and it kept leaking into sentences that were otherwise fine. Setting names
// stay verbatim: RINGOTEL_PROVISION_DOMAINS is the thing they have to edit, so naming it IS the fix.
// Swept across every branch rather than asserted one sentence at a time, because the failure mode is a
// word slipping into a sentence nobody thought to pin.
{
  const BANNED: [RegExp, string][] = [
    [/\brails?\b/i, 'rail'], [/\badmits?\b/i, 'admit'], [/\bdigs?\b/i, 'dig'],
    [/\borgid\b/i, 'orgid'], [/\bbranchid\b/i, 'branchid'], [/provision blob/i, 'provision blob'],
    [/\breconciles?\b|\breconciled\b/i, 'reconcile'], [/org index/i, 'org index'], [/\btenant\b/i, 'tenant'],
    [/carve-out/i, 'carve-out'],
  ];
  // One case per branch that produces its own sentence — every verdict of every row, plus every fleet state.
  const cases: [string, ChecklistInput | null][] = [
    ['all ok', INPUT()],
    ['no rail', INPUT({ cfg: NO_RAIL, org: null, branches: [], inIndex: false, reconciled: null })],
    ['off rail', INPUT({ cfg: OFF_RAIL })],
    ['override', INPUT({ addressOverride: true })],
    ['no org', INPUT({ org: null, branches: [], inIndex: false, reconciled: false })],
    ['no org, no template', INPUT({ org: null, branches: [], template: null })],
    ['label mismatch', INPUT({ org: ORG({ domain: 'acme-old' }) })],
    ['bad package', INPUT({ cfg: CFG({ defaultPackage: 'Nope' }) })],
    ['other package', INPUT({ org: ORG({ packageid: 9 }) })],
    ['no sso configured', INPUT({ cfg: CFG({ ssoServiceId: null }) })],
    ['sso differs', INPUT({ org: ORG({ params: {} }) })],
    ['drift', INPUT({ branches: [DRIFTED] })],
    ['two connections', INPUT({ branches: [BRANCH, DRIFTED] })],
    ['not indexed', INPUT({ inIndex: false })],
    ['unsynced', INPUT({ reconciled: false })],
    ['unknown sync', INPUT({ reconciled: null })],
    ['one setting missing', INPUT({ eventsCovered: false })],
    ['all settings missing', INPUT({ eventsCovered: false, prepopCovered: false, writeCovered: false })],
  ];
  const sentences: [string, string][] = [];
  for (const [what, input] of cases) {
    for (const r of planChecklist(input!)) { sentences.push([`${what}/${r.step} title`, r.title]); sentences.push([`${what}/${r.step} detail`, r.detail]); }
  }
  for (const [what, f] of [
    ['multiple orgs', fleet({ orgCount: 2 })], ['multiple connections', fleet({ branches: [BRANCH, DRIFTED] })],
    ['off rail', fleet({ cfg: OFF_RAIL })], ['no rail', fleet({ cfg: NO_RAIL })],
    ['no org', fleet({ org: null, branches: [] })], ['label mismatch', fleet({ org: ORG({ domain: 'acme-old' }) })],
    ['sso differs', fleet({ org: ORG({ params: {} }) })], ['package differs', fleet({ org: ORG({ packageid: 9 }) })],
    ['drift', fleet({ branches: [DRIFTED] })], ['not indexed', fleet({ inIndex: false })], ['enabled', fleet()],
  ] as const) sentences.push([`fleet/${what}`, f.detail]);

  ok(sentences.length > 300, `[words] the sweep reaches every branch (${sentences.length} sentences)`);
  for (const [re, word] of BANNED) {
    const hit = sentences.find(([, text]) => re.test(text));
    ok(hit === undefined, `[words] no operator-visible sentence says "${word}"${hit ? ` — ${hit[0]}: ${hit[1]}` : ''}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
