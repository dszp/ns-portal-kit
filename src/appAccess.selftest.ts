/** Offline test for app-access config parsing + the sign-in mode matrix. pnpm test:appaccess */
import { ssoEnabled, autoActivates, parseDownloads, parseHideList, AppAccessConfigError, resolveAppAccess, appAccessConfigError, type AppAccessInput } from './appAccess.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };
const threw = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch (e) { return e instanceof AppAccessConfigError; }
};

// ── ssoEnabled: fail closed on an unset service name ──────────────────────
ok(!ssoEnabled('123/netsapiens_sso', {}), 'unset RINGOTEL_SSO_SERVICE never claims SSO');
ok(ssoEnabled('123/netsapiens_sso', { RINGOTEL_SSO_SERVICE: 'netsapiens_sso' }), 'matching service name ⇒ SSO');
ok(ssoEnabled('123/NetSapiens_SSO', { RINGOTEL_SSO_SERVICE: 'netsapiens_sso' }), 'match is case-insensitive');
ok(!ssoEnabled('123/other_idp', { RINGOTEL_SSO_SERVICE: 'netsapiens_sso' }), 'a different service is NOT our SSO');
ok(!ssoEnabled(undefined, { RINGOTEL_SSO_SERVICE: 'netsapiens_sso' }), 'no binding ⇒ not SSO');
ok(!ssoEnabled('', { RINGOTEL_SSO_SERVICE: 'netsapiens_sso' }), 'empty binding ⇒ not SSO');
ok(!ssoEnabled('netsapiens_sso', { RINGOTEL_SSO_SERVICE: 'netsapiens_sso' }), 'malformed (no slash) ⇒ not SSO');

// ── autoActivates: fail closed — assume create-on-login is OFF ────────────
ok(!autoActivates('a.example', {}), 'unset SSO_AUTO_ACTIVATE ⇒ no auto-activation');
ok(autoActivates('a.example', { SSO_AUTO_ACTIVATE: '*' }), '"*" ⇒ every domain auto-activates');
ok(autoActivates('a.example', { SSO_AUTO_ACTIVATE: 'a.example, b.example' }), 'CSV match');
ok(!autoActivates('c.example', { SSO_AUTO_ACTIVATE: 'a.example, b.example' }), 'CSV non-match');
ok(autoActivates('A.Example', { SSO_AUTO_ACTIVATE: 'a.example' }), 'domain match is case-insensitive');

// ── parseDownloads ────────────────────────────────────────────────────────
ok(parseDownloads({}).length === 0, 'unset PORTAL_APP_DOWNLOADS ⇒ no links');
ok(parseDownloads({ PORTAL_APP_DOWNLOADS: '[]' }).length === 0, 'empty array ⇒ no links');
const dl = parseDownloads({ PORTAL_APP_DOWNLOADS: '[{"label":"Get it","url":"https://e.example/app","title":"T"}]' });
ok(dl.length === 1 && dl[0].label === 'Get it' && dl[0].url === 'https://e.example/app' && dl[0].title === 'T', 'parses label/url/title');
ok(threw(() => parseDownloads({ PORTAL_APP_DOWNLOADS: 'not json' })), 'bad JSON throws');
ok(threw(() => parseDownloads({ PORTAL_APP_DOWNLOADS: '{"label":"x"}' })), 'object (not array) throws');
ok(threw(() => parseDownloads({ PORTAL_APP_DOWNLOADS: '[{"label":"x","url":"http://e.example"}]' })), 'non-https url throws');
ok(threw(() => parseDownloads({ PORTAL_APP_DOWNLOADS: '[{"url":"https://e.example"}]' })), 'missing label throws');
// showUrl: optional per-entry boolean, preserved; absent ⇒ undefined (URL shown by default)
ok(parseDownloads({ PORTAL_APP_DOWNLOADS: '[{"label":"Get it","url":"https://e.example","showUrl":false}]' })[0].showUrl === false, 'parseDownloads preserves showUrl:false');
ok(parseDownloads({ PORTAL_APP_DOWNLOADS: '[{"label":"Get it","url":"https://e.example"}]' })[0].showUrl === undefined, 'showUrl absent ⇒ undefined (shown by default)');
ok(parseDownloads({ PORTAL_APP_DOWNLOADS: '[{"label":"Get it","url":"https://e.example","showUrl":true}]' })[0].showUrl === undefined, 'showUrl:true is canonicalized to absent (default-shown)');
ok(threw(() => parseDownloads({ PORTAL_APP_DOWNLOADS: '[{"label":"x","url":"https://e.example","showUrl":"yes"}]' })), 'non-boolean showUrl throws');

// ── parseHideList: CSV form applies fleet-wide ────────────────────────────
ok(parseHideList({}, 'a.example').length === 0, 'unset ⇒ hide nothing');
ok(parseHideList({ PORTAL_APPS_HIDE: 'SNAPmobile Web' }, 'a.example')[0] === 'SNAPmobile Web', 'CSV applies to any domain');
const csvHide = parseHideList({ PORTAL_APPS_HIDE: 'A, B' }, 'a.example');
ok(csvHide.length === 2 && csvHide[0] === 'A' && csvHide[1] === 'B', 'CSV splits and trims');

// ── parseHideList: object form, "*" default + per-domain override ─────────
const obj = '{"*":["SNAPmobile Web"],"quiet.example":[],"extra.example":["SNAPanalytics"]}';
ok(parseHideList({ PORTAL_APPS_HIDE: obj }, 'other.example')[0] === 'SNAPmobile Web', 'falls back to "*"');
ok(parseHideList({ PORTAL_APPS_HIDE: obj }, 'quiet.example').length === 0, 'empty array overrides to hide nothing');
ok(parseHideList({ PORTAL_APPS_HIDE: obj }, 'extra.example')[0] === 'SNAPanalytics', 'per-domain replaces the default');
ok(parseHideList({ PORTAL_APPS_HIDE: '{"A.Example":["X"]}' }, 'a.example')[0] === 'X', 'domain match is case-insensitive');
ok(threw(() => parseHideList({ PORTAL_APPS_HIDE: '{"a":"b"}' }, 'a')), 'object values must be arrays');

// ── resolveAppAccess: the sign-in mode matrix ──────────────────────────────
const ENV = { RINGOTEL_SSO_SERVICE: 'netsapiens_sso' };
const SSO = '9/netsapiens_sso';
const base: AppAccessInput = {
  orgActive: true, eligible: true, activated: true, autoActivate: false,
  accountStatus: 'standard', userScope: 'Basic User',
  loginUsername: '100@acme', sipUsername: '100r',
};
const mode = (o: Partial<AppAccessInput>) => resolveAppAccess({ ...base, ...o }, ENV).mode;
const user = (o: Partial<AppAccessInput>) => resolveAppAccess({ ...base, ...o }, ENV).username;

ok(mode({ orgActive: false }) === 'unavailable', 'no org ⇒ unavailable');
ok(mode({ ssoService: SSO }) === 'sso', 'SSO + usable login + eligible ⇒ sso');
ok(mode({ ssoService: SSO, activated: false, autoActivate: true }) === 'sso',
   'SSO + no account + auto-activate ⇒ sso (signing in creates it)');
ok(mode({ ssoService: SSO, activated: false, autoActivate: false }) === 'not-set-up',
   'SSO + no account + NO auto-activate ⇒ not-set-up (do not invite a login that cannot create one)');
ok(user({ ssoService: SSO, activated: false, autoActivate: false }) === undefined,
   'that advisory carries no username');
ok(user({ ssoService: SSO }) === '100@acme', 'sso mode shows login-username verbatim');

ok(mode({ ssoService: SSO, accountStatus: 'new' }) === 'needs-portal-setup', 'SSO + account-status new ⇒ needs-portal-setup');
ok(mode({ ssoService: SSO, accountStatus: 'reset' }) === 'needs-portal-setup', 'SSO + reset ⇒ needs-portal-setup');
ok(mode({ ssoService: SSO, accountStatus: 'pwd reset' }) === 'needs-portal-setup', 'SSO + pwd reset ⇒ needs-portal-setup');
ok(mode({ ssoService: SSO, userScope: 'No Portal' }) === 'needs-portal-setup', 'SSO + No Portal scope ⇒ needs-portal-setup');
// Eligibility governs CREATION only. An already-activated user has a working account, so a SOFT/email
// ineligibility must NOT block their sign-in (base.activated === true).
ok(mode({ ssoService: SSO, eligible: false }) === 'sso',
   'SSO + ALREADY-activated + soft-ineligible ⇒ sso (eligibility is creation-only, never blocks an existing user)');
ok(user({ ssoService: SSO, eligible: false }) === '100@acme',
   'that existing user still gets their login-username');
// A HARD identity (system/service, invalid ext) stays blocked even when somehow activated.
ok(mode({ ssoService: SSO, eligible: false, hardExcluded: true }) === 'not-set-up',
   'SSO + activated + HARD exclusion ⇒ not-set-up (never activatable, by definition)');
ok(user({ ssoService: SSO, eligible: false, hardExcluded: true }) === undefined,
   'the HARD-blocked advisory carries no username');
// But on the CREATION path (no account yet), soft-ineligibility still gates.
ok(mode({ ssoService: SSO, activated: false, autoActivate: true, eligible: false }) === 'not-set-up',
   'SSO + NO account + ineligible ⇒ not-set-up (eligibility still gates create-on-login)');
ok(user({ ssoService: SSO, activated: false, autoActivate: true, eligible: false }) === undefined,
   'the creation-gate advisory carries no username');

// non-SSO: account-status is irrelevant (the app password has nothing to do with NS credentials)
ok(mode({}) === 'password', 'no SSO + activated ⇒ password');
ok(user({}) === '100r', 'password mode shows the SIP username');
ok(mode({ accountStatus: 'new' }) === 'password', 'non-SSO ignores account-status (SSO-scoped only)');
ok(mode({ userScope: 'No Portal' }) === 'password', 'non-SSO ignores No Portal scope');
ok(mode({ activated: false }) === 'not-set-up', 'no SSO + not activated ⇒ not-set-up');
ok(mode({ ssoService: SSO }) === 'sso' && mode({ ssoService: '9/other' }) === 'password',
   'a third-party SSO binding falls back to the password path');
ok(resolveAppAccess({ ...base, ssoService: SSO }, {}).mode === 'password',
   'unset RINGOTEL_SSO_SERVICE degrades sso → password, never the reverse');

// ── Gap 1: case-folding and whitespace trimming ────────────────────────────
ok(mode({ ssoService: SSO, userScope: 'no portal' }) === 'needs-portal-setup', 'user-scope match is case-insensitive');
ok(mode({ ssoService: SSO, userScope: '  No Portal  ' }) === 'needs-portal-setup', 'user-scope match trims whitespace');
ok(mode({ ssoService: SSO, accountStatus: 'Standard' }) === 'sso', 'account-status match is case-insensitive');
ok(mode({ ssoService: SSO, accountStatus: ' standard ' }) === 'sso', 'account-status match trims whitespace');

// ── Gap 2: advisory modes carry no username for all three advisory modes ──────
ok(user({ ssoService: SSO, userScope: 'No Portal' }) === undefined, 'needs-portal-setup carries no username');
ok(user({ orgActive: false }) === undefined, 'unavailable carries no username');

// ── Gap 3: pin empty-string username behaviour ─────────────────────────────
ok(user({ ssoService: SSO, loginUsername: '' }) === undefined, 'an empty login-username yields no username, never an empty one');

// ── appAccessConfigError: loud, fail-closed guard (mirrors featuresConfigError) ────
ok(appAccessConfigError({}) === null, 'no config at all ⇒ valid (null)');
ok(appAccessConfigError({ PORTAL_APP_DOWNLOADS: '[{"label":"Get it","url":"https://e.example/app"}]', PORTAL_APPS_HIDE: 'A,B' }) === null, 'well-formed config ⇒ valid (null)');
ok(typeof appAccessConfigError({ PORTAL_APP_DOWNLOADS: 'not json' }) === 'string', 'bad PORTAL_APP_DOWNLOADS ⇒ a loud message, not a throw');
ok(typeof appAccessConfigError({ PORTAL_APPS_HIDE: '{"a":"b"}' }) === 'string', 'bad PORTAL_APPS_HIDE ⇒ a loud message, not a throw');

console.log(`\n${pass} passed, ${fail} failed`);
