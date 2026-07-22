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

  // {page} is CLIENT-resolved: the server validates it but must pass it through verbatim.
  ok(at('https://s.example/t?p={page}').url === 'https://s.example/t?p={page}', '{page} is passed through for the browser to fill');
  ok(at('https://s.example/t?p={PAGE}').url === 'https://s.example/t?p={page}', '{page} is normalized to one token the client can match');

  // Missing facts resolve empty rather than leaving a placeholder in a live link.
  const noVars = resolveMenus(M({ apps: { add: [{ label: 'L', url: 'https://s.example/?e={email}' }] } }), { domain: ACME, app: 'none' }).apps.add[0];
  ok(noVars.url === 'https://s.example/?e=', 'an absent value resolves empty, never a literal {email}');
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
