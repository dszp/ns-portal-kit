/**
 * Offline test for the menu-config targeting model. The contract under test is that ONE rule — a default
 * plus specific overrides — expresses all four intents (everywhere / all-except / only-these / nothing) on
 * both axes, and that precedence is domain → app → "*". pnpm test:menus
 */
import { resolveMenus, menuConfigError, MenuConfigError, resolveTargeted, MENU_NAMES, type MenuItem } from './menus.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };
const threw = (fn: () => unknown): boolean => { try { fn(); return false; } catch (e) { return e instanceof MenuConfigError; } };

const ACME = 'acme.example';
const OTHER = 'other.example';
const apps = (env: Record<string, string>, domain: string, app: string) => resolveMenus(env, { domain, app }).apps;
const hideOf = (env: Record<string, string>, domain: string, app: string) => apps(env, domain, app).hide;
const M = (o: unknown) => ({ PORTAL_MENUS: JSON.stringify(o) });

// ── Unset ⇒ nothing, for every menu ────────────────────────────────────────
{
  const r = resolveMenus({}, { domain: ACME, app: 'ringotel' });
  ok(MENU_NAMES.every((n) => r[n].hide.length === 0 && r[n].add.length === 0), 'unset config ⇒ every menu is untouched');
}

// ── The four intents, on the DOMAIN axis ───────────────────────────────────
{
  const everywhere = M({ apps: { hide: ['X'] } });
  ok(hideOf(everywhere, ACME, 'none')[0] === 'X' && hideOf(everywhere, OTHER, 'none')[0] === 'X', 'bare array ⇒ applies everywhere');

  const allExcept = M({ apps: { hide: { '*': ['X'], [ACME]: [] } } });
  ok(hideOf(allExcept, OTHER, 'none')[0] === 'X', 'all-except: an unlisted domain still gets it');
  ok(hideOf(allExcept, ACME, 'none').length === 0, 'all-except: the listed domain is exempted');

  const onlyThese = M({ apps: { hide: { '*': [], [ACME]: ['X'] } } });
  ok(hideOf(onlyThese, ACME, 'none')[0] === 'X', 'only-these: the listed domain gets it');
  ok(hideOf(onlyThese, OTHER, 'none').length === 0, 'only-these: everyone else is untouched');

  const noDefault = M({ apps: { hide: { [ACME]: ['X'] } } });
  ok(hideOf(noDefault, OTHER, 'none').length === 0, 'a domain map with no "*" ⇒ unlisted domains get nothing');
}

// ── The four intents, on the APP axis ──────────────────────────────────────
{
  const onlyActive = M({ apps: { hide: { app: { ringotel: ['X'], none: [] } } } });
  ok(hideOf(onlyActive, ACME, 'ringotel')[0] === 'X', 'app axis: hidden where the app is active');
  ok(hideOf(onlyActive, ACME, 'none').length === 0, 'app axis: left alone where no app is active — the motivating case');

  const anyState = M({ apps: { hide: { app: { '*': ['X'] } } } });
  ok(hideOf(anyState, ACME, 'ringotel')[0] === 'X' && hideOf(anyState, ACME, 'none')[0] === 'X', 'app "*" applies in every state');

  const fallThrough = M({ apps: { hide: { app: { ringotel: ['X'] }, '*': ['Y'] } } });
  ok(hideOf(fallThrough, ACME, 'ringotel')[0] === 'X', 'app match wins over the top-level default');
  ok(hideOf(fallThrough, ACME, 'none')[0] === 'Y', 'no app rung matches ⇒ falls through to "*"');
}

// ── Precedence: domain beats app beats "*" ─────────────────────────────────
{
  const combo = M({ apps: { hide: { app: { ringotel: ['APP'] }, domains: { [ACME]: ['DOM'] }, '*': ['DEF'] } } });
  ok(hideOf(combo, ACME, 'ringotel')[0] === 'DOM', 'domain override beats an app-state match');
  ok(hideOf(combo, OTHER, 'ringotel')[0] === 'APP', 'app-state beats the default');
  ok(hideOf(combo, OTHER, 'none')[0] === 'DEF', 'default is the last rung');

  // The single most likely override: "hide on every app-active domain EXCEPT this one".
  const except = M({ apps: { hide: { app: { ringotel: ['X'], none: [] }, domains: { [ACME]: [] } } } });
  ok(hideOf(except, OTHER, 'ringotel')[0] === 'X', 'app-active domains still hide');
  ok(hideOf(except, ACME, 'ringotel').length === 0, 'an empty domain override WINS — it is not merged with the app list');
}

// ── Case-insensitivity ─────────────────────────────────────────────────────
{
  const mixed = M({ apps: { hide: { 'ACME.Example': ['X'] } } });
  ok(hideOf(mixed, ACME, 'none')[0] === 'X', 'domain keys match case-insensitively');
  const mixedApp = M({ apps: { hide: { app: { RingoTel: ['X'] } } } });
  ok(hideOf(mixedApp, ACME, 'ringotel')[0] === 'X', 'app keys match case-insensitively');
}

// ── add: static entries, validated ─────────────────────────────────────────
{
  const cfg = M({ apps: { add: [{ label: 'Support', url: 'https://support.example.com', title: 'T' }] } });
  const a = apps(cfg, ACME, 'none').add[0] as MenuItem;
  ok(a.label === 'Support' && a.url === 'https://support.example.com' && a.title === 'T', 'add parses label/url/title');
  ok(apps(M({ apps: { add: { app: { none: [{ label: 'L', url: 'https://e.example' }] } } } }), ACME, 'ringotel').add.length === 0,
    'add is targeted by the same rules as hide');
  ok(threw(() => apps(M({ apps: { add: [{ label: 'L', url: 'http://e.example' }] } }), ACME, 'none')), 'a non-https add URL is a config error');
  ok(threw(() => apps(M({ apps: { add: [{ label: 'L', url: 'javascript:alert(1)' }] } }), ACME, 'none')), 'a javascript: add URL is a config error');
  ok(threw(() => apps(M({ apps: { add: [{ url: 'https://e.example' }] } }), ACME, 'none')), 'an add item without a label is a config error');
}

// ── Loud failures ──────────────────────────────────────────────────────────
{
  ok(threw(() => apps(M({ nosuchmenu: { hide: ['X'] } }), ACME, 'none')), 'an unknown menu name is a config error');
  ok(threw(() => apps(M({ apps: { hide: { app: { ringotell: ['X'] } } } }), ACME, 'none')), 'a typo\'d app key is a config error, not a silent never-match');
  ok(threw(() => apps(M({ apps: { nope: ['X'] } }), ACME, 'none')), 'an unknown key inside a menu is a config error');
  ok(threw(() => apps({ PORTAL_MENUS: 'not json' }, ACME, 'none')), 'malformed JSON is a config error');
  ok(threw(() => apps(M({ apps: { hide: { [ACME]: 'X' } } }), ACME, 'none')), 'a rung that is not an array is a config error');
  ok(threw(() => resolveMenus({ PORTAL_APPS_HIDE: 'X', PORTAL_MENUS: JSON.stringify({ apps: { hide: ['Y'] } }) }, { domain: ACME, app: 'none' })),
    'setting BOTH PORTAL_APPS_HIDE and PORTAL_MENUS.apps.hide is an error, not a silent precedence rule');
}

// ── Back-compat: PORTAL_APPS_HIDE keeps working, unchanged ─────────────────
{
  ok(hideOf({ PORTAL_APPS_HIDE: 'A, B' }, ACME, 'none').join('|') === 'A|B', 'legacy CSV still applies fleet-wide');
  ok(hideOf({ PORTAL_APPS_HIDE: JSON.stringify({ '*': ['A'], [ACME]: [] }) }, ACME, 'none').length === 0, 'legacy per-domain object still overrides');
  ok(hideOf({ PORTAL_APPS_HIDE: JSON.stringify({ '*': ['A'], [ACME]: [] }) }, OTHER, 'none')[0] === 'A', 'legacy default still applies elsewhere');
  ok(hideOf({ PORTAL_APPS_HIDE: 'A' }, ACME, 'ringotel')[0] === 'A', 'legacy hide is NOT app-conditional (unchanged behavior)');
  // Legacy coexists with a NEW add — only a duplicate `hide` is ambiguous.
  const both = { PORTAL_APPS_HIDE: 'A', PORTAL_MENUS: JSON.stringify({ apps: { add: [{ label: 'L', url: 'https://e.example' }] } }) };
  ok(hideOf(both, ACME, 'none')[0] === 'A' && apps(both, ACME, 'none').add.length === 1, 'legacy hide coexists with a new add');
}

// ── menuConfigError probes every app state ─────────────────────────────────
{
  ok(menuConfigError({}) === null, 'unset config ⇒ valid');
  ok(menuConfigError(M({ apps: { hide: { app: { ringotel: ['X'], none: [] } } } })) === null, 'well-formed config ⇒ valid');
  const onlyBadWhenNoApp = M({ apps: { hide: { app: { none: 'X' } } } });
  ok((menuConfigError(onlyBadWhenNoApp) ?? '').includes('must be an array'),
    'a rung only reachable in ANOTHER app state is still caught (probes every state)');
  ok((menuConfigError(M({ nosuch: {} })) ?? '').startsWith('Menu config invalid:'), 'the error message is prefixed and actionable');
}

// ── Validation is EAGER: a bad rung is caught even when no current caller reaches it ──
// Lazy validation made the module's promise false — a rung keyed by some OTHER domain passed the startup
// probe and then 500'd the route for exactly that domain's users, invisibly to the operator.
{
  const badElsewhere = M({ apps: { hide: { domains: { 'someone-else.example': 'X' } } } });
  ok((menuConfigError(badElsewhere) ?? '').includes('must be an array'),
    'a bad rung under ANOTHER domain is a startup error, not a 500 for that domain only');
  const badUrlElsewhere = M({ apps: { add: { domains: { 'someone-else.example': [{ label: 'L', url: 'http://e.example' }] } } } });
  ok((menuConfigError(badUrlElsewhere) ?? '').includes('https://'),
    'a non-https URL under ANOTHER domain is caught at startup too');
  const badFlatElsewhere = M({ apps: { hide: { 'someone-else.example': [123] } } });
  ok(menuConfigError(badFlatElsewhere) !== null, 'the flat domain form is validated eagerly as well');
  // ...and resolution for an unaffected domain still throws rather than quietly serving.
  ok(threw(() => hideOf(badElsewhere, ACME, 'none')), 'resolving for an unaffected domain still reports the bad rung');
}

// ── Reserved keys are matched case-insensitively, like every other key ─────
{
  const capitalised = M({ apps: { hide: { App: { ringotel: ['X'], none: [] } } } });
  ok(hideOf(capitalised, ACME, 'ringotel')[0] === 'X', '"App" is the nested app form, not a domain named "app"');
  ok(hideOf(capitalised, ACME, 'none').length === 0, '...and its rungs target correctly');
  const capDomains = M({ apps: { hide: { Domains: { [ACME]: ['X'] } } } });
  ok(hideOf(capDomains, ACME, 'none')[0] === 'X', '"Domains" is the nested domains form');
}

// ── mailto: and {var} interpolation ────────────────────────────────────────
{
  const VARS = { ext: '100', domain: ACME, email: 'a b@acme.example', fname: 'Ann', lname: 'Ross & Co', name: 'Ann O’Hara' };
  const at = (url: string, extra: Record<string, unknown> = {}) =>
    resolveMenus(M({ apps: { add: [{ label: 'L', url, ...extra }] } }), { domain: ACME, app: 'none', vars: VARS }).apps.add[0];

  ok(at('mailto:support@acme.example').url === 'mailto:support@acme.example', 'mailto: is an allowed scheme');
  ok(threw(() => at('javascript:alert(1)')), 'javascript: is still refused');
  ok(threw(() => at('data:text/html,x')), 'data: is still refused');
  ok(threw(() => at('http://e.example')), 'plain http is still refused');

  ok(at('https://s.example/t?e={ext}&d={domain}').url === 'https://s.example/t?e=100&d=acme.example', '{ext}/{domain} interpolate');
  ok(at('https://s.example/u/{ext}/open').url === 'https://s.example/u/100/open', 'variables work in a path segment too');
  // A value containing a space and an & must not break out of the query value.
  ok(at('https://s.example/t?m={email}').url === 'https://s.example/t?m=a%20b@acme.example', 'values are percent-encoded; @ stays readable');
  // The real injection risk: a value containing `&` must not become a second query parameter.
  ok(at('https://s.example/t?n={lname}&z=1').url === 'https://s.example/t?n=Ross%20%26%20Co&z=1',
    'an & inside a value is encoded — it cannot inject another query parameter');
  ok(at('mailto:support@acme.example?subject=Help%20for%20{name}').url.includes('Ann%20O%E2%80%99Hara'), 'interpolation works inside a mailto subject');
  ok(threw(() => at('https://s.example/?x={emial}')), 'an unknown variable is a config error, not a literal brace in a live link');
  ok(at('https://s.example/', { title: 'Help for {fname}' }).title === 'Help for Ann', 'title interpolates');
  ok(at('https://s.example/?u={ext}').label === 'L', 'label without variables is untouched');

  // A value must never be able to choose the DESTINATION. The scheme is fixed by the template, but the
  // host is not — so a variable in the authority is refused outright (a domain admin sets their users'
  // names, which would otherwise be a phishing primitive).
  ok(threw(() => at('https://{fname}/support')), 'a variable cannot BE the host');
  ok(threw(() => at('https://help-{fname}.example.com/x')), 'a variable cannot be part of the host');
  ok(at('https://s.example/{ext}').url === 'https://s.example/100', '...but a variable in the PATH is fine');
  ok(at('mailto:{email}').url.startsWith('mailto:'), '...and a mailto address may be a variable');

  // label/title are read by humans, not parsed as URLs — encoding them would render %20 and %E2%80%99.
  ok(at('https://s.example/', { title: 'Help for {name}' }).title === 'Help for Ann O\u2019Hara',
    'title is NOT percent-encoded');
  const lbl = resolveMenus(M({ apps: { add: [{ label: 'Ask {name}', url: 'https://s.example/' }] } }),
    { domain: ACME, app: 'none', vars: VARS }).apps.add[0];
  ok(lbl.label === 'Ask Ann O\u2019Hara', 'label is NOT percent-encoded');

  // {page} is CLIENT-resolved: the server validates it but must pass it through verbatim.
  ok(at('https://s.example/t?p={page}').url === 'https://s.example/t?p={page}', '{page} is passed through for the browser to fill');
  ok(at('https://s.example/t?p={PAGE}').url === 'https://s.example/t?p={page}', '{page} is normalized to one token the client can match');

  // Missing facts resolve empty rather than leaving a placeholder in a live link.
  const noVars = resolveMenus(M({ apps: { add: [{ label: 'L', url: 'https://s.example/?e={email}' }] } }), { domain: ACME, app: 'none' }).apps.add[0];
  ok(noVars.url === 'https://s.example/?e=', 'an absent value resolves empty, never a literal {email}');
}

// ── The SCOPE axis: exact match, no nesting ────────────────────────────────
// The motivating case is inexpressible with feature levels, where `office_manager` means "OM and everyone
// above" — including the resellers you are trying to exclude.
{
  const hideForScope = (env: Record<string, string>, scope: string | undefined) =>
    resolveMenus(env, { domain: ACME, app: 'none', scope }).apps.hide;

  const allExcept = M({ apps: { hide: { scopes: { Reseller: [] }, '*': ['X'] } } });
  ok(hideForScope(allExcept, 'Office Manager')[0] === 'X', 'scope axis: an unlisted scope gets the default');
  ok(hideForScope(allExcept, 'Reseller').length === 0, 'scope axis: the named scope is exempted — the motivating case');
  ok(hideForScope(allExcept, 'Super User')[0] === 'X', 'scope axis does NOT nest: Super User is not covered by a Reseller rung');

  const onlyThese = M({ apps: { hide: { scopes: { 'Office Manager': ['X'], '*': [] } } } });
  ok(hideForScope(onlyThese, 'Office Manager')[0] === 'X', 'only-these: the named scope gets it');
  ok(hideForScope(onlyThese, 'Basic User').length === 0, 'only-these: every other scope is untouched');

  // Key spelling: word-form, level-style and the Super User synonyms are all one key.
  const spellings = M({ apps: { hide: { scopes: { office_manager: ['X'] } } } });
  ok(hideForScope(spellings, 'Office Manager')[0] === 'X', 'a level-style key matches the NS word-form scope');
  const su = M({ apps: { hide: { scopes: { 'Super User': ['X'] } } } });
  ok(hideForScope(su, 'superuser')[0] === 'X' && hideForScope(su, 'super-user')[0] === 'X',
    'the interchangeable Super User spellings collapse to one key');

  // No scope on the context ⇒ nothing matches; the rule falls through rather than guessing.
  ok(hideForScope(allExcept, undefined)[0] === 'X', 'an absent scope falls through to the default, never a random rung');

  ok(threw(() => hideForScope(M({ apps: { hide: { scopes: { 'Office Mgr': ['X'] } } } }), 'Reseller')),
    "a typo'd scope key is a config error, not a silent never-match");
  ok((menuConfigError(M({ apps: { hide: { scopes: { Resellr: ['X'] } } } })) ?? '').includes('unknown scope'),
    '...and it is caught at startup, for every deployment, before anyone signs in');
  ok(threw(() => hideForScope(M({ apps: { hide: { scopes: ['X'] } } }), 'Reseller')), 'scopes must be an object');
  ok(hideForScope(M({ apps: { hide: { Scopes: { Reseller: ['X'] } } } }), 'Reseller')[0] === 'X',
    '"Scopes" is the nested scope form, like "App"/"Domains"');
}

// ── Precedence across all three axes ───────────────────────────────────────
{
  const ctx = (domain: string, app: string, scope: string) => ({ domain, app, scope });
  const combo = M({
    apps: { hide: { domains: { [ACME]: ['DOM'] }, scopes: { Reseller: ['SCOPE'] }, app: { ringotel: ['APP'] }, '*': ['DEF'] } },
  });
  const h = (d: string, a: string, s: string) => resolveMenus(combo, ctx(d, a, s)).apps.hide[0];
  ok(h(ACME, 'ringotel', 'Reseller') === 'DOM', 'domain beats scope and app');
  ok(h(OTHER, 'ringotel', 'Reseller') === 'SCOPE', 'scope beats app');
  ok(h(OTHER, 'ringotel', 'Basic User') === 'APP', 'app still beats the default');
  ok(h(OTHER, 'none', 'Basic User') === 'DEF', 'default is the last rung');

  // An in-axis "*" is a DEFAULT, so an exact match on a LESS specific axis still wins over it.
  const starVsExact = M({ apps: { hide: { scopes: { '*': ['SCOPE-STAR'] }, app: { ringotel: ['APP'] } } } });
  ok(resolveMenus(starVsExact, ctx(ACME, 'ringotel', 'Reseller')).apps.hide[0] === 'APP',
    'an app-state match beats a scope "*" — a star never outranks a rule that names you');
  ok(resolveMenus(starVsExact, ctx(ACME, 'none', 'Reseller')).apps.hide[0] === 'SCOPE-STAR',
    '...and the scope "*" applies when no exact rung matches');
}

// ── The scope axis is INERT unless a config uses it ────────────────────────
// It must be possible to add this to a live deployment and have every existing rule resolve identically.
{
  const legacyShapes: Array<[string, unknown]> = [
    ['bare array', { apps: { hide: ['X'] } }],
    ['flat domain map', { apps: { hide: { '*': ['X'], [OTHER]: [] } } }],
    ['app axis', { apps: { hide: { app: { ringotel: ['X'], '*': ['Y'] } } } }],
    ['domains + app + default', { apps: { hide: { domains: { [OTHER]: ['D'] }, app: { ringotel: ['A'] }, '*': ['X'] } } }],
  ];
  for (const [name, cfg] of legacyShapes) {
    const env = M(cfg);
    for (const app of ['ringotel', 'none']) {
      const without = JSON.stringify(resolveMenus(env, { domain: ACME, app }).apps);
      const withScope = JSON.stringify(resolveMenus(env, { domain: ACME, app, scope: 'Reseller' }).apps);
      ok(without === withScope, `${name} (app=${app}) resolves identically with and without a scope`);
    }
  }
}

// ── resolveTargeted is exported for reuse and behaves standalone ───────────
{
  const got = resolveTargeted<string>(['A'], { domain: ACME, app: 'none' }, 'p', (v, p) => {
    if (typeof v !== 'string') throw new MenuConfigError(`${p} bad`); return v;
  });
  ok(got.length === 1 && got[0] === 'A', 'resolveTargeted works standalone');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
