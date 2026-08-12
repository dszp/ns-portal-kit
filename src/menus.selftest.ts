/**
 * Offline test for the menu-config targeting model. The contract under test is that ONE rule — a default
 * plus specific overrides — expresses all four intents (everywhere / all-except / only-these / nothing) on
 * both axes, and that precedence is domain → app → "*". pnpm test:menus
 */
import { resolveMenus, menuConfigError, MenuConfigError, resolveTargeted, MENU_NAMES, appsHideSources, bothAppsHideSet,
  documoEnabled, activeApps, unreachableDefaults, appAvailable, availableApps,
  type MenuItem, type TargetCtx, type SourceOut, type MenuSource } from './menus.js';
// The write rail's OWN parse, so "these two settings agree about what a domain is" is a claim about
// production rather than about a third copy typed into this file.
import { resolveRingotelConfig } from './eligibility.js';

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
}

// ── the `users` axis (2026-08-08) ──────────────────────────────────────────
// Added to match the per-user grants PORTAL_FEATURES already has: "gate this by user" should mean one
// thing across the kit. It is the MOST specific axis, because naming an account is only ever worth doing
// to carve an exception out of a broader rule.
{
  const ME = 'boss@acme.example';
  const at = (env: Record<string, string>, over: Record<string, unknown> = {}) =>
    resolveMenus(env, { domain: ACME, app: 'none', user: ME, ...over } as never).apps;

  const byUser = M({ apps: { hide: { users: { [ME]: ['X'] } } } });
  ok(at(byUser).hide.join() === 'X', '[users] a rule naming your account matches');
  ok(at(byUser, { user: 'someone@else.example' }).hide.length === 0, '[users] and nobody else');
  ok(at(byUser, { user: undefined }).hide.length === 0, '[users] no account in context ⇒ falls through, never throws');
  ok(at(M({ apps: { hide: { users: { 'BOSS@Acme.Example': ['X'] } } } })).hide.join() === 'X',
    '[users] account keys match case-insensitively, like every other axis');

  // Most specific WINS. Without this an account key could never carve an exception out of a domain rule,
  // which is the only reason to write one.
  const both = M({ apps: { hide: { users: { [ME]: ['USER'] }, domains: { [ACME]: ['DOM'] } } } });
  ok(at(both).hide.join() === 'USER', '[users] account beats domain');
  ok(at(both, { user: 'other@acme.example' }).hide.join() === 'DOM', '[users] and the domain rule still covers everyone else');
  // The empty-override idiom has to work here too: "everyone in this domain except me".
  const except = M({ apps: { hide: { domains: { [ACME]: ['X'] }, users: { [ME]: [] } } } });
  ok(at(except).hide.length === 0, '[users] an empty account rung exempts that one account');
  ok(at(except, { user: 'other@acme.example' }).hide.join() === 'X', '[users] while the domain rule stands for the rest');

  // A star on this axis is a DEFAULT, so it must not beat an exact match on a less specific axis.
  const star = M({ apps: { hide: { users: { '*': ['ANY'] }, domains: { [ACME]: ['DOM'] } } } });
  ok(at(star).hide.join() === 'DOM', '[users] a users "*" is a default and loses to a domain that names you');

  // Loud on a key that can never match — same standard as the scope and app axes.
  ok(threw(() => apps(M({ apps: { hide: { users: { 'not-an-account': ['X'] } } } }), ACME, 'none')),
    '[users] a key that is not user@domain is a config error, not a silent never-match');
  ok(threw(() => apps(M({ apps: { hide: { users: ['X'] } } }), ACME, 'none')), '[users] and the axis must be an object');
  // The startup probe must EXERCISE this axis, or a malformed key ships.
  ok(menuConfigError(M({ apps: { hide: { users: { bad: ['X'] } } } })) !== null,
    '[users] menuConfigError catches it at startup, not on the one request that matches');
  ok(menuConfigError(M({ apps: { hide: { users: { [ME]: ['X'] } } } })) === null, '[users] and accepts a good one');

  // Works on add as well as hide — one targeting engine, not two.
  const addByUser = M({ apps: { add: { users: { [ME]: [{ label: 'Mine', url: 'https://e.example' }] } } } });
  ok(at(addByUser).add.length === 1 && at(addByUser, { user: 'x@y.example' }).add.length === 0,
    '[users] add is targeted by account the same way hide is');
}

// ── The two apps-menu hide settings MERGE (2026-08-08) ─────────────────────
// This used to be a fatal config error. The risk it named was real — two places to look for one answer —
// but the cost landed on the wrong thing: `menuConfigError` runs before routing, so two overlapping
// COSMETIC settings returned 500 on every route including the injected primary, and the entire add-on went
// dark for every user. The answer is to make the merged result visible, not to make the combination
// illegal. Precedence was the alternative and is worse: it silently discards a setting somebody wrote.
{
  const both = { PORTAL_APPS_HIDE: 'X', PORTAL_MENUS: JSON.stringify({ apps: { hide: ['Y'] } }) };
  const ctx = { domain: ACME, app: 'none' };
  ok(menuConfigError(both) === null, '[merge] setting both is no longer a config error');
  const plan = resolveMenus(both, ctx).apps;
  ok(plan.hide.includes('X') && plan.hide.includes('Y'),
    `[merge] and BOTH lists take effect (${plan.hide.join(', ')})`);
  // Neither setting silently wins. That is the whole difference from a precedence rule, and the property
  // most likely to be lost in a refactor that "simplifies" the merge.
  ok(resolveMenus({ PORTAL_APPS_HIDE: 'X' }, ctx).apps.hide.join() === 'X', '[merge] legacy alone still works');
  ok(resolveMenus({ PORTAL_MENUS: JSON.stringify({ apps: { hide: ['Y'] } }) }, ctx).apps.hide.join() === 'Y',
    '[merge] and PORTAL_MENUS alone still works');

  // De-duplicated case-insensitively: the same entry named in both settings is one hide, not two, and
  // hiding twice must not depend on matching the operator's capitalisation.
  const dupe = { PORTAL_APPS_HIDE: 'Voicemail', PORTAL_MENUS: JSON.stringify({ apps: { hide: ['voicemail'] } }) };
  ok(resolveMenus(dupe, ctx).apps.hide.length === 1, '[merge] a label named in both appears once');

  // Provenance is what makes two settings safe rather than confusing — the console shows one effective
  // list AND which setting each label came from, so there is still one place to look for the answer.
  const src = appsHideSources(both, ctx);
  ok(src.legacy.join() === 'X' && src.menus.join() === 'Y', '[merge] each source is reported separately');
  ok(src.effective.length === 2, '[merge] alongside the effective union');
  ok(bothAppsHideSet(both) && !bothAppsHideSet({ PORTAL_APPS_HIDE: 'X' }),
    '[merge] and the both-are-set condition is reportable without being fatal');
  // TOTAL: setupIssues calls this, and setupIssues exists to REPORT what is wrong. A predicate that threw
  // on malformed PORTAL_MENUS took down the console for the one deployment that needed it — caught by the
  // suite, but only because buildStatus happens to be tested with a malformed value.
  let threwOnGarbage = false;
  try { bothAppsHideSet({ PORTAL_APPS_HIDE: 'X', PORTAL_MENUS: 'not json' }); } catch { threwOnGarbage = true; }
  ok(!threwOnGarbage, '[merge] and it never throws — malformed JSON is menuConfigError\'s to report, not this');

  // Targeting still applies to the PORTAL_MENUS half after the merge — a merge that flattened away the
  // per-domain rungs would hide entries for domains that never asked.
  const targeted = { PORTAL_APPS_HIDE: 'X', PORTAL_MENUS: JSON.stringify({ apps: { hide: { [ACME]: ['Y'], '*': [] } } }) };
  ok(resolveMenus(targeted, ctx).apps.hide.join() === 'Y,X', '[merge] the targeted rung applies for its domain');
  ok(resolveMenus(targeted, { domain: 'other.example', app: 'none' }).apps.hide.join() === 'X',
    '[merge] and another domain gets only the legacy list');
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

// ── The Management menu is a third target, with the same rules ─────────────
{
  const cfg = M({ management: { add: { scopes: { Reseller: [{ label: 'Provisioning', url: 'https://rps.example.com/x' }] }, '*': [] } } });
  const at = (scope: string) => resolveMenus(cfg, { domain: ACME, app: 'none', scope }).management;
  ok(at('Reseller').add[0]?.label === 'Provisioning', 'management: a reseller-scoped entry resolves');
  ok(at('Office Manager').add.length === 0, 'management: everyone else gets nothing');
  ok(threw(() => resolveMenus(M({ managment: { add: [] } }), { domain: ACME, app: 'none' })),
    "a typo'd menu name is still a config error");
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

// ── the domains axis has an in-axis default, like every other axis (Fable review, 2026-08-09) ──────────
// It was the only axis that did not pick up its own "*", so the shape this module's contract documents --
// "change everywhere EXCEPT some" -- validated green and matched nothing anywhere. Asserted per axis
// rather than once, because the bug was an omission in one branch of four that otherwise agree.
{
  const cfg = M({ apps: { hide: { domains: { '*': ['Everywhere'], [ACME]: [] } } } });
  ok(hideOf(cfg, OTHER, 'none').join(',') === 'Everywhere',
    'domains: an in-axis "*" applies where no domain entry matches');
  ok(hideOf(cfg, ACME, 'none').length === 0,
    'and an explicit domain entry still wins outright over it');

  // Precedence is unchanged: the FIRST axis to supply a default wins, users before domains.
  const both = M({ apps: { hide: { users: { '*': ['FromUsers'] }, domains: { '*': ['FromDomains'] } } } });
  ok(resolveMenus(both, { domain: OTHER, app: 'none', user: 'u@x.example' }).apps.hide.join(',') === 'FromUsers',
    "and users' default still outranks the domains default, as the documented order says");
}


// ── provenance: WHICH rung answered, reported by the code that chose it ──────────────────────────────
// The console draws a chip from this ("default (*)", "scopes → Reseller"), and the alternative is
// re-deriving precedence in the browser to explain a result the server already decided. These cases pin
// the distinctions the chip depends on — especially the two empties, which look identical in the plan and
// mean opposite things.
{
  // One source today for every axis but the app tier, which can report two — so these read [0] and the
  // union block below asserts the plural case directly.
  const srcs = (raw: unknown, ctx: TargetCtx) => {
    const out: SourceOut = { sources: [] };
    resolveTargeted<string>(raw, ctx, 'X', (v) => String(v), out, (ls) => ls.flat());
    return out.sources;
  };
  const src = (raw: unknown, ctx: TargetCtx) => srcs(raw, ctx)[0] ?? null;
  const at = (domain: string, scope?: string, app = 'none'): TargetCtx =>
    ({ domain, app, ...(scope ? { scope } : {}) });

  ok(src(['A'], at('acme.example'))?.axis === 'all',
    '[source] an untargeted list reports that it applies to everyone');
  ok(src({ scopes: { Reseller: ['A'] } }, at('acme.example', 'Reseller'))?.axis === 'scopes',
    '[source] an exact rung reports its own axis');
  ok(src({ scopes: { 'ReSeLLer': ['A'] } }, at('acme.example', 'reseller'))?.key === 'ReSeLLer',
    '[source] and the key AS WRITTEN, so the chip shows the operator their own spelling');
  ok(src({ scopes: { '*': ['A'] } }, at('acme.example', 'Reseller'))?.axis === 'scopes',
    '[source] an in-axis default is attributed to its axis, not to the whole-object default');
  ok(src({ scopes: { Reseller: ['A'] }, '*': ['B'] }, at('acme.example', 'Office Manager'))?.axis === '*',
    '[source] while the whole-object default reports itself');
  ok(src({ 'acme.example': ['A'] }, at('acme.example'))?.axis === 'domains',
    '[source] the flat form is attributed to the domains axis it really is');

  // THE TWO EMPTIES. `{scopes:{Reseller:[]}}` for a Reseller is the exemption idiom — "these people get
  // nothing" — and the same empty list with nothing matched means "no rule reached you". The plan cannot
  // tell them apart; the source can, and the editor renders them differently.
  const exemption = src({ scopes: { Reseller: [] } }, at('acme.example', 'Reseller'));
  const nothing = src({ scopes: { Reseller: [] } }, at('acme.example', 'Office Manager'));
  ok(exemption !== null && exemption.axis === 'scopes',
    '[source] an EMPTY rung that matched is an exemption, and says so');
  ok(nothing === null, '[source] while nothing matching at all reports no source — a different fact');

  // Precedence, read off the provenance rather than off the items: the most specific axis wins, and an
  // in-axis default is held back until every axis has had a chance at an exact match.
  const both = src({ domains: { 'acme.example': ['A'] }, scopes: { Reseller: ['B'] } }, at('acme.example', 'Reseller'));
  ok(both?.axis === 'domains', '[source] domains outranks scopes, and the chip will say which one won');
  const held = src({ scopes: { '*': ['A'] }, app: { ringotel: ['B'] } }, at('acme.example', 'Basic User', 'ringotel'));
  ok(held?.axis === 'app', '[source] and a star is a default: an exact app match beats an in-axis scope star');
}

// The plan and the provenance are produced by ONE pass, so they cannot describe different resolutions.
{
  const env = { PORTAL_MENUS: JSON.stringify({ account: { add: { scopes: { Reseller: [] }, '*': [{ label: 'S', url: 'https://e.example' }] } } }) };
  const sources = {} as Record<string, { hide: MenuSource[]; add: MenuSource[] }>;
  const plan = resolveMenus(env, { domain: 'acme.example', app: 'none', scope: 'Reseller' }, sources as never);
  ok(plan.account.add.length === 0 && sources.account!.add.length === 1 && sources.account!.add[0]!.axis === 'scopes',
    '[source] resolveMenus reports the exemption its own plan produced');
  const other = {} as Record<string, { hide: MenuSource[]; add: MenuSource[] }>;
  resolveMenus(env, { domain: 'acme.example', app: 'none', scope: 'Office Manager' }, other as never);
  ok(other.account!.add[0]!.axis === '*', '[source] and the default for an audience no rung names');
  // ARRAY-shaped, with one entry today. A second integration makes a half legitimately answer from two
  // app rungs at once, and widening a scalar then would break a shape the editor already consumes.
  ok(Array.isArray(sources.account!.add), '[source] provenance is a list, sized for the integration tier that is coming');
}


// ── the app axis is a UNION tier (2026-08-10) ────────────────────────────────────────────────────────
// Registering a second app is what made these writable: with one, union and select-one agree on every
// expressible config, so every assertion here would have passed vacuously.
{
  const hides = (raw: unknown, apps: string[]) =>
    resolveTargeted<string>(raw, { domain: 'acme.example', app: apps }, 'X', (v) => String(v), undefined,
      (ls) => unionLabelsForTest(ls));
  const unionLabelsForTest = (ls: string[][]) => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const l of ls) for (const x of l) { const k = x.trim().toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
    return out;
  };
  const adds = (raw: unknown, apps: string[]) =>
    resolveTargeted<string>(raw, { domain: 'acme.example', app: apps }, 'X', (v) => String(v), undefined,
      (ls) => ls.flat());

  const cfg = { app: { ringotel: ['A'], documo: ['B'], none: ['N'] } };
  ok(hides(cfg, ['ringotel', 'documo']).join() === 'A,B',
    '[union] both active ⇒ both rungs contribute; neither integration silently loses its entries');
  ok(hides(cfg, ['documo']).join() === 'B', '[union] one active ⇒ only its rung');
  ok(hides(cfg, []).join() === 'N', '[union] and `none` fires exactly when the active set is empty');

  // REGISTRY ORDER, not the order the operator typed their JSON — two configs that say the same thing
  // must resolve the same way.
  const reversed = { app: { documo: ['B'], ringotel: ['A'] } };
  ok(adds(reversed, ['ringotel', 'documo']).join() === 'A,B',
    '[union] adds concatenate in APP_NAMES order regardless of how the config was written');

  // THE MIGRATED IDIOM. Under select-one an empty rung meant "this audience gets nothing". Under union it
  // means "this app contributes nothing" — there is no way to say "both active, show nothing" WITHIN the
  // axis, which is why the exemption idiom lives on the identity axes now.
  ok(hides({ app: { ringotel: [], documo: ['B'] } }, ['ringotel', 'documo']).join() === 'B',
    '[union] an empty app rung contributes nothing rather than exempting the audience');
  ok(hides({ domains: { 'acme.example': [] }, app: { ringotel: ['A'] } }, ['ringotel']).length === 0,
    '[union] while an identity rung still exempts outright — it outranks the whole app tier');

  // DEFAULT GATING. A default must never beat a rule that names you, and under union "names you" means at
  // least one match across the active set.
  const withStar = { app: { ringotel: ['A'], '*': ['D'] } };
  ok(hides(withStar, ['documo']).join() === 'D',
    '[union] the in-axis default fires when NO app rung matched any active app');
  ok(hides(withStar, ['ringotel', 'documo']).join() === 'A',
    '[union] and is held back as soon as one did, even with another app active and unmatched');

  // DUPLICATE ADDS ACROSS RUNGS. `menuApply` drops a repeated URL client-side, so the portal was never
  // going to draw it twice — but the PLAN would have carried both, and the console renders the plan, so
  // the preview would have shown a row the live menu does not have.
  {
    const dup = { app: { ringotel: [{ label: 'Support', url: 'https://s.example' }],
                         documo: [{ label: 'Support (fax)', url: 'https://s.example' }] } };
    const out: SourceOut = { sources: [] };
    const got = resolveTargeted<MenuItem>(dup, { domain: 'acme.example', app: ['ringotel', 'documo'] },
      'X', (v) => v as MenuItem, out, (ls) => mergeAddsForTest(ls));
    ok(got.length === 1 && got[0]!.label === 'Support',
      '[union] one URL added by two rungs resolves to one entry, first spelling winning');
    ok(out.sources.length === 2,
      '[union] and provenance still names both rules — the operator wrote two, even though one draws');
  }

  // ⚠️ AND THE SAME CASE THROUGH THE PRODUCTION PATH. Everything above hands resolveTargeted a merge
  // written IN THIS FILE, so `mergeAdds` could lose its dedupe entirely and every assertion here would
  // stay green — while the console's preview drew a doubled row the live portal does not have. Union is
  // the headline of this train; it must not ship on a test of its own mirror image.
  {
    const dup = { apps: { add: { app: {
      // A {variable} on purpose: the raw sink must stay index-aligned with the resolved plan THROUGH the
      // dedupe, and it is the dedupe that can silently drop one side out of step with the other.
      ringotel: [{ label: 'Support', url: 'https://s.example/?d={domain}' }],
      documo: [{ label: 'Support (fax)', url: 'https://s.example/?d={domain}' }],
    } } } };
    const sources = {} as Record<string, { hide: MenuSource[]; add: MenuSource[] }>;
    const raw = {} as Record<string, MenuItem[]>;
    const plan = resolveMenus(M(dup), { domain: ACME, app: ['ringotel', 'documo'] }, sources as never, raw as never);
    ok(plan.apps.add.length === 1 && plan.apps.add[0]!.label === 'Support',
      `[union] resolveMenus itself dedupes a URL added by two rungs (${JSON.stringify(plan.apps.add)})`);
    ok(plan.apps.add[0]!.url === 'https://s.example/?d=',
      `[union] and the surviving entry is the RESOLVED one — no vars supplied, so the placeholder is empty (${plan.apps.add[0]!.url})`);
    ok(raw.apps!.length === plan.apps.add.length && raw.apps![0]!.url.includes('{domain}'),
      `[union] the raw sink stays index-aligned with the plan through the dedupe (${JSON.stringify(raw.apps)})`);
    ok(sources.apps!.add.length === 2,
      '[union] and both rules are still reported, so the operator can find the one they can delete');
  }

  // Provenance goes plural exactly here and nowhere else.
  const out: SourceOut = { sources: [] };
  resolveTargeted<string>(cfg, { domain: 'acme.example', app: ['ringotel', 'documo'] }, 'X', (v) => String(v), out, (ls) => ls.flat());
  ok(out.sources.length === 2 && out.sources.every((x) => x.axis === 'app'),
    '[union] a both-active half reports BOTH rungs — the case scalar provenance would have broken');
}

// Two settings both name domains — the write rail and the Documo stand-in — and they must not disagree
// about what a domain IS. The parse in `menus.ts` is a copy rather than a delegation (a module edge for
// five tokens was the worse trade), so the agreement is asserted rather than assumed.
//
// ⚠️ AGAINST THE REAL RAIL. This block used to spell the rail's parse out a third time, right here — which
// made it an assertion that documoEnabled matches a rule typed into a test, and left the actual rail free
// to change underneath it. resolveRingotelConfig is what production asks, so it is what this asks.
{
  const railOf = (v: string) => resolveRingotelConfig({ RINGOTEL_WRITE_DOMAINS: v } as never).writeDomains;
  const cases = ['acme.example', ' ACME.example ', 'a.example, b.example', '*', 'A.example,,b.example '];
  const disagree = cases.filter((v) => {
    const rail = railOf(v);
    const wild = rail === '*';
    for (const probe of ['acme.example', 'a.example', 'b.example', 'other.example']) {
      const byRail = wild || (rail as string[]).includes(probe);
      if (documoEnabled({ DOCUMO_DOMAINS: v }, probe) !== byRail) return true;
      // ...and the same answer for a differently-cased probe, since neither is case-sensitive.
      if (documoEnabled({ DOCUMO_DOMAINS: v }, probe.toUpperCase()) !== byRail) return true;
    }
    return false;
  });
  ok(disagree.length === 0,
    `[union] DOCUMO_DOMAINS and the write rail agree on what a domain is${disagree.length ? ` (differ on: ${disagree.join(' | ')})` : ''}`);
  ok(documoEnabled({}, 'acme.example') === false,
    '[union] and unset means no domain is active — which is what keeps the union inert in production');
}

/** The dedupe-by-URL merge, mirrored here so the assertion above tests the RULE rather than the wiring. */
function mergeAddsForTest(lists: MenuItem[][]): MenuItem[] {
  const seen = new Set<string>(); const out: MenuItem[] = [];
  for (const l of lists) for (const it of l) {
    const k = it.url.trim().toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

// ── the migration claim, as a test that can actually fail ────────────────────────────────────────────
// With `documo` registered but inactive everywhere, union must equal select-one on every config that was
// expressible before. This is the assertion that was vacuous while one app was registered: it could not
// distinguish the semantics because no config could tell them apart.
{
  const legacyShapes: unknown[] = [
    ['A'],
    { 'acme.example': ['A'], '*': ['B'] },
    { app: { ringotel: ['A'], none: ['B'] } },
    { app: { ringotel: ['A'], '*': ['B'] } },
    { scopes: { Reseller: ['A'] }, app: { ringotel: ['B'] }, '*': ['C'] },
    { domains: { 'acme.example': [] }, app: { ringotel: ['B'] } },
    { users: { 'a@acme.example': ['A'] }, app: { none: ['B'] } },
  ];
  // Every ctx a single-app deployment could produce.
  const ctxs = [
    { domain: 'acme.example', app: 'ringotel' as const },
    { domain: 'acme.example', app: 'none' as const },
    { domain: 'other.example', app: 'ringotel' as const, scope: 'Reseller' },
    { domain: 'acme.example', app: 'none' as const, scope: 'Reseller', user: 'a@acme.example' },
  ];
  let same = 0, differ: string[] = [];
  for (const raw of legacyShapes) {
    for (const ctx of ctxs) {
      const got = resolveTargeted<string>(raw, ctx, 'X', (v) => String(v));
      // The pre-union answer, computed the old way: exactly one rung, first match wins.
      const expected = selectOneReference(raw, ctx);
      if (JSON.stringify(got) === JSON.stringify(expected)) same++;
      else differ.push(`${JSON.stringify(raw)} @ ${JSON.stringify(ctx)}: ${JSON.stringify(got)} vs ${JSON.stringify(expected)}`);
    }
  }
  ok(differ.length === 0,
    `[union] with the second app inactive, every previously-expressible config resolves identically (${same} cases)${differ.length ? `\n    ${differ.join('\n    ')}` : ''}`);
}

/** The pre-union rule, written out independently so the equivalence test compares against a SECOND
 *  derivation rather than against the implementation it is checking. Select-one: users → domains →
 *  scopes → app exact, then the most specific in-axis star, then the whole-object star. */
function selectOneReference(raw: unknown, ctx: { domain: string; app: string; scope?: string; user?: string }): string[] {
  const n = (x: string) => x.trim().toLowerCase();
  if (Array.isArray(raw)) return raw as string[];
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, any>;
  const key = (want: string) => Object.keys(o).find((k) => n(k) === want);
  const axes = ['users', 'domains', 'scopes', 'app'] as const;
  const has = axes.some((a) => key(a) !== undefined);
  const pick = (m: Record<string, any>, want: string) => {
    const k = Object.keys(m).find((x) => n(x) === want);
    return k === undefined ? undefined : (m[k] as string[]);
  };
  if (!has) return pick(o, n(ctx.domain)) ?? pick(o, '*') ?? [];
  const want: Record<string, string | undefined> = {
    users: ctx.user ? n(ctx.user) : undefined,
    domains: n(ctx.domain),
    scopes: ctx.scope ? n(ctx.scope) : undefined,
    app: n(ctx.app),
  };
  let chosen: string[] | undefined, def: string[] | undefined;
  for (const a of axes) {
    const k = key(a); if (k === undefined) continue;
    const m = o[k] as Record<string, any>;
    const w = want[a];
    if (chosen === undefined && w) chosen = pick(m, w);
    if (def === undefined) def = pick(m, '*');
  }
  const topKey = key('*');
  return chosen ?? def ?? (topKey !== undefined ? (o[topKey] as string[]) : []) ?? [];
}


// ── entries that reach nobody: the decidable half of reachability ────────────────────────────────────
// David's own config is the fixture. He built a covering app axis one group at a time, and the "*" that
// carried Support and Email Support went dead fleet-wide with nothing anywhere saying so.
{
  const shared = [{ label: 'Support', url: 'https://s.example' }, { label: 'Email', url: 'mailto:a@e.example' }];
  const covering = {
    apps: { add: { app: { ringotel: [{ label: 'A', url: 'https://a.example' }],
                          documo: [{ label: 'B', url: 'https://b.example' }],
                          none: [{ label: 'C', url: 'https://c.example' }] }, '*': shared } },
  };
  const w = unreachableDefaults({ PORTAL_MENUS: JSON.stringify(covering) });
  ok(w.length === 1 && /can never apply/.test(w[0]!),
    '[dead] a covering app axis strands its default, and the config says which one');
  ok(/reach nobody/.test(w[0]!) && /each group/.test(w[0]!),
    '[dead] and says what to do about it, not just that it is wrong');

  // Prove the claim rather than trusting the detector: resolve it for every app state and confirm the
  // shared entries genuinely reach no one.
  const seen = new Set<string>();
  for (const apps of [[], ['ringotel'], ['documo'], ['ringotel', 'documo']]) {
    for (const it of resolveMenus({ PORTAL_MENUS: JSON.stringify(covering) }, { domain: 'acme.example', app: apps }).apps.add) seen.add(it.label);
  }
  ok(!seen.has('Support') && !seen.has('Email'),
    '[dead] and the entries really are unreachable — asserted by resolving, not by reading the config');

  // One state left uncovered ⇒ the default is live and must NOT be reported.
  const partial = JSON.parse(JSON.stringify(covering));
  delete partial.apps.add.app.none;
  ok(unreachableDefaults({ PORTAL_MENUS: JSON.stringify(partial) }).length === 0,
    '[dead] leave one state uncovered and the default is live again — no warning');
  ok(resolveMenus({ PORTAL_MENUS: JSON.stringify(partial) }, { domain: 'acme.example', app: [] }).apps.add.length === 2,
    '[dead] which resolving confirms: an app-less domain falls through to it');

  // An in-axis "*" IS the catch-all, so a covering axis beneath it strands nothing.
  const starred = JSON.parse(JSON.stringify(covering));
  starred.apps.add.app['*'] = [];
  ok(unreachableDefaults({ PORTAL_MENUS: JSON.stringify(starred) }).length === 0,
    '[dead] an in-axis star is itself a catch-all, so nothing is stranded under it');

  // No default to strand ⇒ nothing to say. A covering axis is a perfectly good config on its own.
  const noDefault = JSON.parse(JSON.stringify(covering));
  delete noDefault.apps.add['*'];
  ok(unreachableDefaults({ PORTAL_MENUS: JSON.stringify(noDefault) }).length === 0,
    '[dead] and a covering axis with no default is not a problem at all');

  // It REPORTS, it does not refuse — the bothAppsHideSet lesson: a cosmetic menu mistake made fatal in
  // the pre-routing gauntlet took down every route including the injected primary.
  ok(menuConfigError({ PORTAL_MENUS: JSON.stringify(covering) }) === null,
    '[dead] a stranded default is still VALID config — this deployment boots and serves it');
}


// ── availability is a SECOND predicate, not a view of the first ──────────────────────────────────────
// The console decides whether to offer an app in the preview picker from this. Inferring it from usage
// deadlocks: no toggle means no rung, means nothing names it, means no toggle, forever.
{
  ok(appAvailable({ RINGOTEL_API_KEY: 'k' }, 'ringotel') && !appAvailable({}, 'ringotel'),
    '[avail] the app integration is available exactly when its key is set');
  // The three states, the same shape PORTAL_HANDOFF_URL uses.
  ok(!appAvailable({}, 'documo'), '[avail] absent ⇒ not available on this deployment');
  ok(appAvailable({ DOCUMO_DOMAINS: '' }, 'documo'),
    '[avail] present but EMPTY ⇒ available and enabled nowhere — the design-ahead state');
  ok(appAvailable({ DOCUMO_DOMAINS: 'acme.example' }, 'documo'), '[avail] a list ⇒ available');

  // AVAILABLE AND ACTIVE NOWHERE is a real, ordinary state — the one the picker has to keep offering.
  ok(appAvailable({ DOCUMO_DOMAINS: '' }, 'documo') && !documoEnabled({ DOCUMO_DOMAINS: '' }, 'acme.example'),
    '[avail] available and active nowhere is a state, which is why one predicate cannot serve both');
  ok(JSON.stringify(availableApps({ RINGOTEL_API_KEY: 'k', DOCUMO_DOMAINS: '' })) === JSON.stringify(['ringotel', 'documo']),
    '[avail] and the picker is offered the registry order it will render in');
  ok(availableApps({}).length === 0, '[avail] while a deployment that declared neither is offered neither');
}

// The detector's blind spot, asserted so the trade stays deliberate: it uses the FULL vocabulary, so a
// config covering every state that can actually OCCUR on a deployment where documo is unavailable is not
// reported. A missed warning, never a false alarm — folding availability in would make one config warn on
// one deployment and not another, which is what makes the check answer portable.
{
  const covering = { apps: { add: { app: { ringotel: [{ label: 'A', url: 'https://a.example' }],
                                           none: [{ label: 'B', url: 'https://b.example' }] },
                                    '*': [{ label: 'S', url: 'https://s.example' }] } } };
  ok(unreachableDefaults({ PORTAL_MENUS: JSON.stringify(covering) }).length === 0,
    '[avail] the detector stays deployment-independent, missing rather than inventing a warning');
}


// ══ THE RENAME HALF ══════════════════════════════════════════════════════════════════════════════════
// A third operation beside hide and add: relabel a stock entry in place, same destination, same row.
{
  const R = (o: unknown) => ({ PORTAL_MENUS: JSON.stringify(o) });
  const plan = (o: unknown, ctx: Partial<TargetCtx> = {}) =>
    resolveMenus(R(o), { domain: ACME, app: 'none', ...ctx } as TargetCtx).apps.rename;

  // ── the key has to be admitted before anything else can be reached ──────────────────────────────
  ok(menuConfigError(R({ apps: { rename: [{ from: 'A', to: 'B' }] } })) === null,
    'rename is a valid menu key');
  ok(/unknown key/.test(menuConfigError(R({ apps: { renmae: [] } })) ?? ''),
    'and a typo of it still fails loudly, naming all three');

  // ── the same targeting as every other half, for free ────────────────────────────────────────────
  const targeted = { apps: { rename: { scopes: { Reseller: [] }, '*': [{ from: 'X', to: 'Y' }] } } };
  ok(plan(targeted, { scope: 'Office Manager' }).length === 1, 'a rename targets like any other half');
  ok(plan(targeted, { scope: 'Reseller' }).length === 0, 'and an empty rung is still the exemption idiom');

  // ── ⚠️ TITLE IS THREE STATES, and menuItemAt collapses them at four points, so this parser is
  // written longhand rather than modelled on it. Absent is an INSTRUCTION: leave the portal's alone.
  const three = plan({ apps: { rename: [
    { from: 'A', to: 'A2' },
    { from: 'B', to: 'B2', title: 'tip' },
    { from: 'C', to: 'C2', title: '' },
  ] } });
  ok(!('title' in three[0]!), 'an omitted title stays omitted — the leave-it-alone state survives the resolver');
  ok(three[1]!.title === 'tip', 'a string is carried');
  ok(three[2]!.title === '', 'and an empty string SURVIVES as an empty string — the clear-it state');
  // The wire is where a three-state value usually dies. It does not here, and that is worth pinning.
  const wire = JSON.parse(JSON.stringify(three)) as { title?: string }[];
  ok(!('title' in wire[0]!) && wire[2]!.title === '',
    'and both states survive JSON, which is how the plan reaches the browser');
  ok(plan({ apps: { rename: [{ from: 'A', to: 'B', title: '   ' }] } })[0]!.title === '',
    'whitespace-only clears, decided here rather than left to wherever a trim happens to sit');

  // null is refused rather than guessed at — both readings are defensible and one silently deletes a
  // tooltip the operator meant to keep.
  const nullErr = menuConfigError(R({ apps: { rename: [{ from: 'A', to: 'B', title: null }] } })) ?? '';
  ok(/title must be a string/.test(nullErr), `a null title is refused (${nullErr})`);
  ok(/Omit it/.test(nullErr) && /to clear it/.test(nullErr),
    'and the refusal names both alternatives, because the operator cannot see this table');

  // ── what a rename must have ──────────────────────────────────────────────────────────────────────
  ok(/needs a "from"/.test(menuConfigError(R({ apps: { rename: [{ to: 'B' }] } })) ?? ''), 'from is required');
  ok(/needs a "to"/.test(menuConfigError(R({ apps: { rename: [{ from: 'A' }] } })) ?? ''), 'to is required');
  ok(/unknown key "url"/.test(menuConfigError(R({ apps: { rename: [{ from: 'A', to: 'B', url: 'x' }] } })) ?? ''),
    'and a key from the WRONG half is caught rather than ignored');

  // ── variables, on the same non-encoding path labels use ──────────────────────────────────────────
  ok(resolveMenus(R({ apps: { rename: [{ from: 'A', to: 'Hi {fname}' }] } }),
    { domain: ACME, app: 'none', vars: { fname: "Ann O'Hara" } } as TargetCtx).apps.rename[0]!.to === "Hi Ann O'Hara",
    'a variable in `to` interpolates unencoded — a label is read, not fetched');
  ok(/unknown variable/.test(menuConfigError(R({ apps: { rename: [{ from: 'A', to: '{nope}' }] } })) ?? ''),
    'and an unknown one fails at startup like everywhere else');

  // ── dedupe across app rungs, THROUGH resolveMenus ────────────────────────────────────────────────
  // Through the real path on purpose: the union tests elsewhere in this file pass a test-local merge
  // into resolveTargeted, so production could lose its dedupe and stay green.
  {
    const dup = { apps: { rename: { app: {
      ringotel: [{ from: 'Support', to: 'Help' }],
      documo: [{ from: 'support', to: 'Fax help' }],
    } } } };
    const src = {} as Record<string, { hide: MenuSource[]; add: MenuSource[]; rename: MenuSource[] }>;
    const raw = {} as Record<string, unknown[]>;
    // ⚠️ FIFTH ARGUMENT, not the fourth — the fourth is rawAdds. Passing it in the wrong slot made this
    // assertion read an empty adds list and fail, which is the sink doing its job on its own test.
    const got = resolveMenus(R(dup), { domain: ACME, app: ['ringotel', 'documo'] } as TargetCtx,
      src as never, undefined, raw as never).apps.rename;
    ok(got.length === 1 && got[0]!.to === 'Help',
      `one entry renamed by two rungs resolves once, first winning (${JSON.stringify(got)})`);
    ok(src.apps!.rename.length === 2,
      'and both rules are still reported — the operator wrote two, even though one applies');
    ok(raw.apps!.length === got.length, 'the raw sink stays index-aligned through the dedupe');
  }

  // ── the raw sink exists because `to` is interpolated and the config's `to` is not ─────────────────
  {
    const raw = {} as Record<string, { to: string }[]>;
    const got = resolveMenus(R({ apps: { rename: [{ from: 'A', to: 'Hi {fname}' }] } }),
      { domain: ACME, app: 'none' } as TargetCtx, undefined, undefined, raw as never).apps.rename;
    ok(got[0]!.to === 'Hi ' && raw.apps![0]!.to === 'Hi {fname}',
      `the resolved label is emptied of placeholders while the written one keeps them (${got[0]!.to} / ${raw.apps![0]!.to})`);
  }

  // ── the reaches-nobody warning covers the newest half too ────────────────────────────────────────
  {
    const closed = { apps: { rename: {
      app: { ringotel: [{ from: 'A', to: 'B' }], documo: [], none: [] },
      '*': [{ from: 'C', to: 'D' }],
    } } };
    ok(unreachableDefaults(R(closed)).some((w) => /\.rename names every app state/.test(w)),
      `a rename default that can never apply is reported (${unreachableDefaults(R(closed)).join(' | ')})`);
  }

  // ── every menu carries the half, unset or not ────────────────────────────────────────────────────
  const empty = resolveMenus({}, { domain: ACME, app: 'none' } as TargetCtx);
  ok(MENU_NAMES.every((n) => Array.isArray(empty[n].rename) && empty[n].rename.length === 0),
    'an unset config still gives every menu an empty rename list, so no applier has to guard for absence');
}

// ── ⚠️ THE TWO TARGETED FORMS DO NOT MIX, AND MIXING THEM WAS SILENT ─────────────────────────────────
// A reserved key selects the nested form, after which nothing reads a bare top-level domain key — so a
// live per-customer rule beside a scopes axis resolved as if it had never been written, and the
// deployment's own validator called the config Valid. Reachable without hand-writing it: the console
// carries a bare domain map through as remainder, and carving any axis on that half emits the mixture.
{
  const mixed = JSON.stringify({ apps: { hide: {
    'acme.example': ['User Portal'],
    '*': [],
    scopes: { 'Office Manager': ['Meeting'] },
  } } });
  const err = menuConfigError({ PORTAL_MENUS: mixed });
  ok(err !== null, `[mixed] a half naming an axis AND bare domain keys is refused at startup (${err})`);
  ok(!!err && /acme\.example/.test(err) && /domains/.test(err),
    `[mixed] naming the keys that would never have matched, and where to move them (${err})`);
  // Each form ALONE is still fine — this refuses the mixture, not either shape.
  ok(menuConfigError({ PORTAL_MENUS: JSON.stringify({ apps: { hide: { 'acme.example': ['X'], '*': [] } } }) }) === null,
    '[mixed] the bare domain map on its own still resolves');
  ok(menuConfigError({ PORTAL_MENUS: JSON.stringify({ apps: { hide: { domains: { 'acme.example': ['X'] }, '*': [] } } }) }) === null,
    '[mixed] and so does the named-axis form, which is where those keys belong');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
