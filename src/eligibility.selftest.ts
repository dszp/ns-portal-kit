/**
 * Offline test for this deployment's config resolver, and for how that config drives the SHARED
 * eligibility engine. The engine itself is `@dszp/netsapiens-lib`'s and has its own unit tests there —
 * these are the integration assertions that our resolved `RingotelConfig` produces the verdicts this
 * Worker depends on (seeded name matchers, per-domain ext overrides, reseller override, SSO waiver).
 *   pnpm test:eligibility
 */
import { evaluateEligibility, type EligUser, type EligContext } from '@dszp/netsapiens-lib';
import {
  resolveRingotelConfig,
  ringotelConfigError,
  RingotelConfigError,
  type RingotelConfig,
} from './eligibility.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

/** A fully-resolved config; soft matchers empty unless overridden per-test. */
const cfg = (o: Partial<RingotelConfig> = {}): RingotelConfig => ({
  suffix: 'r',
  excludeNames: [],
  excludeExts: [],
  excludeExtsByDomain: {},
  excludeNoDevices: false,
  resellerOverride: new Set(),
  writeDomains: [],
  ...o,
});

const admin: EligContext = { domain: 'acme.example', isReseller: false };
const reseller: EligContext = { domain: 'acme.example', isReseller: true };

const user = (o: Partial<EligUser> = {}): EligUser => ({
  ext: '100', srvCode: '', email: 'a@b.example', names: ['Jane', 'Doe'], deviceCount: 1, ...o,
});

// --- HARD: system/service user (srv_code non-blank) — never activatable, not even a reseller ---
ok(evaluateEligibility(user({ srvCode: 'anything' }), admin, cfg()).activatable === false, 'system user (srv_code non-blank) is not activatable');
ok(evaluateEligibility(user({ srvCode: 'anything' }), admin, cfg()).tier === 'hard', 'system user blocked at HARD tier');
ok(evaluateEligibility(user({ srvCode: '   ' }), admin, cfg()).activatable === true, 'whitespace-only srv_code is treated as blank (not a system user)');
ok(evaluateEligibility(user({ srvCode: 'x' }), reseller, cfg({ resellerOverride: new Set(['names', 'exts', 'no_devices']) })).activatable === false, 'a reseller CANNOT override a system user (HARD)');

// --- HARD: extension must be 3-4 digits (auto-excludes TOD / pseudo extensions) ---
ok(evaluateEligibility(user({ ext: '100' }), admin, cfg()).activatable === true, '3-digit ext is activatable');
ok(evaluateEligibility(user({ ext: '1000' }), admin, cfg()).activatable === true, '4-digit ext is activatable');
ok(evaluateEligibility(user({ ext: '10' }), admin, cfg()).activatable === false, '2-digit ext is not activatable (HARD)');
ok(evaluateEligibility(user({ ext: '99999' }), admin, cfg()).activatable === false, '5-digit ext is not activatable (HARD)');
ok(evaluateEligibility(user({ ext: 'tod-open' }), admin, cfg()).tier === 'hard', 'non-numeric ext blocked at HARD tier');

// --- Precondition: email required (Ringotel emails creds; can't without an address) ---
ok(evaluateEligibility(user({ email: '' }), admin, cfg()).activatable === false, 'no email ⇒ not activatable');
ok(evaluateEligibility(user({ email: '   ' }), admin, cfg()).activatable === false, 'whitespace email ⇒ not activatable');
ok(evaluateEligibility(user({ email: '' }), admin, cfg()).tier === 'precondition', 'no email blocked at precondition tier (indicator still shows)');

// --- emailNotRequired: the SSO/JIT path provisions on login and mails nothing, so the email
//     precondition does not apply — but it must NOT rescue a HARD or SOFT exclusion ---
const noEmailSso: EligContext = { domain: 'acme.example', isReseller: false, emailNotRequired: true };
ok(evaluateEligibility(user({ email: '' }), noEmailSso, cfg()).activatable === true, 'emailNotRequired: no email is activatable on the SSO path');
ok(evaluateEligibility(user({ email: '' }), noEmailSso, cfg()).tier === 'ok', 'emailNotRequired: an emailless SSO user lands at OK (no precondition block)');
ok(evaluateEligibility(user({ email: 'a@b.example' }), noEmailSso, cfg()).activatable === true, 'emailNotRequired with an email present is still activatable');
ok(evaluateEligibility(user({ email: '', srvCode: 'x' }), noEmailSso, cfg()).tier === 'hard', 'emailNotRequired does NOT rescue a HARD (system) user');
ok(evaluateEligibility(user({ email: '', ext: '900' }), noEmailSso, cfg({ excludeExts: ['900'] })).tier === 'soft', 'emailNotRequired does NOT rescue a SOFT (excluded-ext) user');
ok(evaluateEligibility(user({ email: '' }), admin, cfg()).tier === 'precondition', 'without emailNotRequired the email precondition still fires (default path unchanged)');

// --- OK: valid user, no soft hits ---
const good = evaluateEligibility(user(), admin, cfg());
ok(good.activatable === true && good.tier === 'ok', 'a normal 3-digit user with email is activatable (ok)');

// --- SOFT: name matchers (default-excluded, reseller-overridable), case-insensitive contains ---
const shared = user({ names: ['Shared', 'Voicemail Box'] });
// The SEEDED default (no RINGOTEL_EXCLUDE_NAMES set). Pinned because the same seed is duplicated in the
// SSO worker's config parser — if the two drift, one system auto-provisions a user the other refuses.
// The matcher is substring + case-insensitive, so the short forms cover the long ones.
{
  const seeded = resolveRingotelConfig({}).excludeNames;
  ok(JSON.stringify(seeded) === JSON.stringify(['shared', 'shared voicemail', 'voicemail', 'fax', 'general voicemail', 'general mailbox', 'conference', 'conf rm', 'conf room', 'routing']),
     'seeded excludeNames match the documented default');
  const hits = (n: string) => seeded.some((m) => n.toLowerCase().includes(m));
  ok(hits('General Voicemail') && hits('General Mailbox') && hits('Conference Room') && hits('Conf Rm 2') && hits('CONF ROOM B') && hits('Routing') && hits('Fax Line'),
     'seeded list catches the long forms via their short prefixes');
  ok(hits('Sales Voicemail'), 'bare VOICEMAIL catches department mailboxes');
  ok(!hits('Dana Reed') && !hits('Front Office') && !hits('General Manager') && !hits('Confalone'),
     'seeded list leaves ordinary names alone (incl. General Manager — why bare GENERAL was narrowed)');
}
ok(evaluateEligibility(shared, admin, cfg({ excludeNames: ['shared'] })).activatable === false, 'name contains SHARED ⇒ soft-excluded');
ok(evaluateEligibility(shared, admin, cfg({ excludeNames: ['shared'] })).tier === 'soft', 'name match blocked at SOFT tier');
ok(evaluateEligibility(user({ names: ['Front Desk', 'FAX'] }), admin, cfg({ excludeNames: ['fax'] })).activatable === false, 'name contains FAX ⇒ soft-excluded');
ok(evaluateEligibility(shared, admin, cfg({ excludeNames: ['shared'] })).activatable === false, 'admin (non-reseller) does NOT get the soft override');
ok(evaluateEligibility(shared, reseller, cfg({ excludeNames: ['shared'], resellerOverride: new Set(['names']) })).activatable === true, 'reseller WITH names-override activates a SHARED box');
ok(evaluateEligibility(shared, reseller, cfg({ excludeNames: ['shared'], resellerOverride: new Set() })).activatable === false, 'reseller WITHOUT names-override is still blocked by SHARED');
ok(evaluateEligibility(shared, reseller, cfg({ excludeNames: ['shared'], resellerOverride: new Set(['exts']) })).activatable === false, 'reseller override of a DIFFERENT category does not unblock a name match');

// --- SOFT: custom extension exclusions (global + per-domain override + reseller override) ---
ok(evaluateEligibility(user({ ext: '900' }), admin, cfg({ excludeExts: ['900'] })).activatable === false, 'ext 900 in global exclude list ⇒ soft-excluded');
ok(evaluateEligibility(user({ ext: '900' }), admin, cfg({ excludeExts: ['900'] })).tier === 'soft', 'ext exclusion is SOFT tier');
ok(evaluateEligibility(user({ ext: '901' }), admin, cfg({ excludeExts: ['900'] })).activatable === true, 'a non-listed ext is not excluded');
ok(evaluateEligibility(user({ ext: '900' }), reseller, cfg({ excludeExts: ['900'], resellerOverride: new Set(['exts']) })).activatable === true, 'reseller WITH exts-override activates an excluded ext');
ok(evaluateEligibility(user({ ext: '900' }), reseller, cfg({ excludeExts: ['900'], resellerOverride: new Set(['names']) })).activatable === false, 'reseller override of names does NOT unblock an ext exclusion');
// per-domain remove re-allows (the "one domain re-allows 900" case)
ok(evaluateEligibility(user({ ext: '900' }), admin, cfg({ excludeExts: ['900'], excludeExtsByDomain: { 'acme.example': { remove: ['900'] } } })).activatable === true, 'per-domain remove re-allows an otherwise-excluded ext');
ok(evaluateEligibility(user({ ext: '900' }), { domain: 'other.example', isReseller: false }, cfg({ excludeExts: ['900'], excludeExtsByDomain: { 'acme.example': { remove: ['900'] } } })).activatable === false, 'per-domain remove applies ONLY to its own domain');
// per-domain add excludes only in that domain
ok(evaluateEligibility(user({ ext: '850' }), admin, cfg({ excludeExtsByDomain: { 'acme.example': { add: ['850'] } } })).activatable === false, 'per-domain add excludes an ext in that domain');
ok(evaluateEligibility(user({ ext: '850' }), { domain: 'other.example', isReseller: false }, cfg({ excludeExtsByDomain: { 'acme.example': { add: ['850'] } } })).activatable === true, 'per-domain add does NOT affect other domains');
// simple trailing-* wildcard
ok(evaluateEligibility(user({ ext: '801' }), admin, cfg({ excludeExts: ['8*'] })).activatable === false, 'wildcard 8* excludes 801');
ok(evaluateEligibility(user({ ext: '790' }), admin, cfg({ excludeExts: ['8*'] })).activatable === true, 'wildcard 8* does not exclude 790');

// --- SOFT: no-device heuristic tightens the name matcher (never decides alone) ---
const sharedName = { names: ['Shared', 'Line'] };
ok(evaluateEligibility(user({ ...sharedName, deviceCount: 0 }), admin, cfg({ excludeNames: ['shared'], excludeNoDevices: false })).activatable === false, 'no-device OFF: a SHARED box is excluded regardless of device count');
ok(evaluateEligibility(user({ ...sharedName, deviceCount: 2 }), admin, cfg({ excludeNames: ['shared'], excludeNoDevices: true })).activatable === true, 'no-device ON: a SHARED box WITH devices is kept (real endpoint, not a pure VM box)');
ok(evaluateEligibility(user({ ...sharedName, deviceCount: 0 }), admin, cfg({ excludeNames: ['shared'], excludeNoDevices: true })).activatable === false, 'no-device ON: a SHARED box with zero devices is excluded');
ok(evaluateEligibility(user({ names: ['Jane', 'Doe'], deviceCount: 0 }), admin, cfg({ excludeNoDevices: true })).activatable === true, 'no-device never decides alone: a normal 0-device user is still activatable');

// --- Reseller RUNTIME force override (bypasses ALL soft; never HARD / precondition) ---
const rForce: EligContext = { domain: 'acme.example', isReseller: true, force: true };
ok(evaluateEligibility(shared, rForce, cfg({ excludeNames: ['shared'] })).activatable === true, 'reseller force bypasses a soft NAME exclusion (even without the config category)');
ok(evaluateEligibility(user({ ext: '900' }), rForce, cfg({ excludeExts: ['900'] })).activatable === true, 'reseller force bypasses a soft EXT exclusion');
ok(evaluateEligibility(user({ srvCode: 'x' }), rForce, cfg()).activatable === false, 'reseller force does NOT bypass a system user (HARD)');
ok(evaluateEligibility(user({ srvCode: 'x' }), rForce, cfg()).tier === 'hard', 'force + system user is still HARD');
ok(evaluateEligibility(user({ email: '', names: ['Shared', 'x'] }), rForce, cfg({ excludeNames: ['shared'] })).activatable === false, 'reseller force does NOT bypass the email precondition');
ok(evaluateEligibility(shared, { domain: 'acme.example', isReseller: false, force: true }, cfg({ excludeNames: ['shared'] })).activatable === false, 'force requires reseller scope (a non-reseller force is ignored)');

// ============ resolveRingotelConfig(env) — parsing + fail-closed ============
const d = resolveRingotelConfig({});
ok(d.suffix === 'r', 'default suffix is "r"');
ok(d.excludeNames.includes('shared') && d.excludeNames.includes('fax'), 'default name matchers seed shared + fax (lowercased)');
ok(d.excludeExts.length === 0, 'default exclude-exts is empty (900 is an operator convention, not a default)');
ok(d.excludeNoDevices === false, 'default no-device heuristic is off');
ok(d.resellerOverride.size === 0, 'default reseller-override is empty');
ok(Array.isArray(d.writeDomains) && (d.writeDomains as string[]).length === 0, 'default writeDomains is empty ⇒ all writes refused (fail-closed rail)');

ok(resolveRingotelConfig({ RINGOTEL_ACTIVATION_SUFFIX: 'x' }).suffix === 'x', 'suffix override');
ok(JSON.stringify(resolveRingotelConfig({ RINGOTEL_EXCLUDE_NAMES: 'Shared, FAX' }).excludeNames) === JSON.stringify(['shared', 'fax']), 'names parsed CSV, lowercased + trimmed');
ok(JSON.stringify(resolveRingotelConfig({ RINGOTEL_EXCLUDE_EXTS: '900, 8*' }).excludeExts) === JSON.stringify(['900', '8*']), 'exts parsed CSV + trimmed');
ok(resolveRingotelConfig({ RINGOTEL_EXCLUDE_NO_DEVICES: '1' }).excludeNoDevices === true, 'no-device true via "1"');
ok(resolveRingotelConfig({ RINGOTEL_EXCLUDE_NO_DEVICES: 'true' }).excludeNoDevices === true, 'no-device true via "true"');
ok(resolveRingotelConfig({ RINGOTEL_EXCLUDE_NO_DEVICES: 'false' }).excludeNoDevices === false, 'no-device false via "false"');
ok(resolveRingotelConfig({ RINGOTEL_RESELLER_OVERRIDE: 'names, exts' }).resellerOverride.has('names') && resolveRingotelConfig({ RINGOTEL_RESELLER_OVERRIDE: 'names,exts' }).resellerOverride.has('exts'), 'reseller-override parsed CSV');
ok(resolveRingotelConfig({ RINGOTEL_RESELLER_OVERRIDE: 'all' }).resellerOverride.size === 3, '"all" expands to every soft category');
ok(JSON.stringify(resolveRingotelConfig({ RINGOTEL_WRITE_DOMAINS: 'demo.example, two.example' }).writeDomains) === JSON.stringify(['demo.example', 'two.example']), 'writeDomains parsed CSV (lowercased)');
ok(resolveRingotelConfig({ RINGOTEL_WRITE_DOMAINS: '*' }).writeDomains === '*', 'writeDomains "*" ⇒ all scope-permitted');

const pd = resolveRingotelConfig({ RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN: JSON.stringify({ 'acme.example': { remove: ['900'] } }) });
ok(pd.excludeExtsByDomain['acme.example']?.remove?.[0] === '900', 'per-domain exts JSON parsed');

let t1 = false; try { resolveRingotelConfig({ RINGOTEL_RESELLER_OVERRIDE: 'bogus' }); } catch (e) { t1 = e instanceof RingotelConfigError; }
ok(t1, 'unknown reseller-override category throws RingotelConfigError (fail-closed)');
let t2 = false; try { resolveRingotelConfig({ RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN: '{bad json' }); } catch (e) { t2 = e instanceof RingotelConfigError; }
ok(t2, 'bad per-domain-exts JSON throws');
let t3 = false; try { resolveRingotelConfig({ RINGOTEL_ACTIVATION_SUFFIX: '   ' }); } catch (e) { t3 = e instanceof RingotelConfigError; }
ok(t3, 'blank suffix throws (loud)');

ok(ringotelConfigError({}) === null, 'valid (empty) config ⇒ no error');
ok(ringotelConfigError({ RINGOTEL_RESELLER_OVERRIDE: 'bogus' }) !== null, 'bad config ⇒ error message');

// Integration: the resolved DEFAULT config soft-excludes a SHARED box.
ok(evaluateEligibility(user({ names: ['Shared', 'VM'] }), admin, resolveRingotelConfig({})).activatable === false, 'resolved default config soft-excludes a SHARED box');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
