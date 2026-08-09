/** Offline test for the setting descriptor table + its drift guard. pnpm test:status */
import { readFileSync, readdirSync } from 'node:fs';
import { APP_NAMES } from './menus.js';
import { SETTINGS, settingNames, PROBE_CATALOG, probeCatalogFor, SUBSYSTEM_DETAIL } from './statusModel.js';
import { buildStatus } from './status.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

/**
 * THE DRIFT GUARD. `interface Env` in worker.ts is the authority on what this deployment reads; the
 * descriptor table is what the console shows. If they disagree, the console lies — so parse the
 * interface as text and assert set-equality. A key added to Env without a row here fails this test.
 * Text-parsed on purpose: a TS interface is erased at runtime, so there is nothing to reflect over.
 */
function envKeysFromSource(): string[] {
  const src = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^interface Env \{/.test(l));
  if (start < 0) throw new Error('could not find `interface Env {` in worker.ts — the guard is broken, not the table');
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  if (end < 0) throw new Error('could not find the end of `interface Env` — the guard is broken, not the table');
  const keys = lines.slice(start + 1, end)
    .map((l) => /^  ([A-Z][A-Z0-9_]*)\??\s*:/.exec(l)?.[1])
    .filter((k): k is string => !!k);
  if (keys.length < 40) throw new Error(`extracted only ${keys.length} keys — the regex stopped matching, the table is not at fault`);
  return keys;
}

const inEnv = new Set(envKeysFromSource());
const inTable = new Set(settingNames());
const missing = [...inEnv].filter((k) => !inTable.has(k));
const extra = [...inTable].filter((k) => !inEnv.has(k));

ok(missing.length === 0, `every interface Env key has a SETTINGS row${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
ok(extra.length === 0, `no SETTINGS row describes a key Env does not have${extra.length ? ` (extra: ${extra.join(', ')})` : ''}`);

/**
 * THE OTHER DIRECTION. `interface Env` is only the authority if it is complete — and it was not:
 * PORTAL_MENUS and three NS_EVENTS_* keys were read by their modules and declared nowhere in Env, so a
 * guard that trusted Env alone silently omitted four real settings from the console.
 *
 * This scans READS, not declarations. The earlier version unioned every `export interface *Env {` block,
 * which is the same declaration site whose ABSENCE caused the bug it was written for: it reached 58 of the
 * 64 keys, and six were already invisible to it (`JWT_RATE_LIMITER`, `ALLOWED_DOMAINS`, `BLOCKED_DOMAINS`,
 * `ALLOWED_ORIGINS`, `RINGOTEL_ROTATE_SIP_ON_ACTIVATE`, `RINGOTEL_PREPOP_INCLUDE_SOFT`). Adding
 * `export const _k = (env: any) => env.SOME_NEW_KNOB;` to any module, declared in no interface anywhere,
 * passed it. Teaching it `extends` would have closed one syntactic form and left the family open; keying on
 * `env.SOMETHING` closes the family, because a key that is never read off `env` cannot affect behavior.
 *
 * Its own blind spot, named honestly: a key reached ONLY through a computed lookup (`readKey(env, name)`,
 * `(env as any)[x]`) is invisible here, since there is no literal to find. Today `readKey` is only ever
 * called with a name that already comes from this very table, so nothing escapes that way — but a NEW
 * computed read of a key absent from SETTINGS would not be caught by either direction of this guard.
 */
function envReadsFromSource(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dir = new URL('.', import.meta.url);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.includes('selftest')) continue;
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\benv\??\.([A-Z][A-Z0-9_]{2,})\b/g)) {
      const k = m[1]!;
      const seen = out.get(k) ?? [];
      if (!seen.includes(f)) out.set(k, [...seen, f]);
    }
  }
  // Same self-check as envKeysFromSource: if the regex or the naming convention stops matching, say so
  // loudly rather than reporting a clean tree. 40 is a floor well under the ~64 keys read today.
  if (out.size < 40) throw new Error(`the read scan found only ${out.size} env reads — the guard is broken, not the table`);
  return out;
}

const readKeys = envReadsFromSource();
ok(readKeys.size >= 40, `scanned actual env reads across src/ (${readKeys.size} keys)`);
const undeclared = [...readKeys.keys()].filter((k) => !inEnv.has(k));
ok(undeclared.length === 0,
  `every key any module READS off env is declared in interface Env${undeclared.length ? ` (undeclared: ${undeclared.map((k) => `${k} (${readKeys.get(k)!.join(',')})`).join('; ')})` : ''}`);
// And every key it reads has a row here, by the same argument — the forward direction covers this via
// `inEnv`, but state it against the reads too so the two guards cannot both be satisfied by a stale Env.
const unrowed = [...readKeys.keys()].filter((k) => !inTable.has(k));
ok(unrowed.length === 0,
  `and has a SETTINGS row${unrowed.length ? ` (no row: ${unrowed.map((k) => `${k} (${readKeys.get(k)!.join(',')})`).join('; ')})` : ''}`);

// Shape hygiene — a row with empty prose is a row that teaches nobody anything.
ok(SETTINGS.every((s) => s.what.trim().length > 0), 'every row has a `what`');
ok(SETTINGS.every((s) => s.whenUnset.trim().length > 0), 'every row has a `whenUnset`');
ok(new Set(settingNames()).size === SETTINGS.length, 'no duplicate rows');

// The bindings group is a security-adjacent control of a different kind: it decides which fix-it text an
// operator is handed (BINDING_WHY_NOT vs CONFIG_WHY_NOT), so assert it explicitly rather than trusting the
// table. `group`, not a third `SettingKind` — see BINDING_WHY_NOT's own comment.
const BINDINGS = ['ASSETS', 'JWT_RATE_LIMITER'];
const markedBinding = SETTINGS.filter((s) => s.group === 'bindings').map((s) => s.name).sort();
ok(JSON.stringify(markedBinding) === JSON.stringify([...BINDINGS].sort()),
  `exactly the structural bindings are group:'bindings' (got: ${markedBinding.join(', ')})`);
ok(SETTINGS.filter((s) => s.group === 'bindings').every((s) => s.kind === 'config'),
  'and a binding is never marked secret — it has no value to withhold');

// The probe catalog: one row per live check, and the Checks tab renders the not-run state from it.
ok(PROBE_CATALOG.length === 6, `the probe catalog has exactly 6 checks (got ${PROBE_CATALOG.length})`);
ok(new Set(PROBE_CATALOG.map((p) => p.id)).size === PROBE_CATALOG.length, 'with no duplicate ids');
ok(PROBE_CATALOG.every((p) => p.name.trim() && p.what.trim() && p.cost.trim()), 'each carrying a name, a what and a cost');

// The secret list is a security control, so assert it explicitly rather than trusting the table.
const SECRETS = ['RINGOTEL_API_KEY', 'NS_EVENTS_PATH_SECRET', 'NS_API_KEY',
  'NS_ADMIN_USER', 'NS_ADMIN_PASS', 'NS_OAUTH_CLIENT_ID', 'NS_OAUTH_CLIENT_SECRET'];
const markedSecret = SETTINGS.filter((s) => s.kind === 'secret').map((s) => s.name).sort();
ok(JSON.stringify(markedSecret) === JSON.stringify([...SECRETS].sort()),
  `exactly the credential keys are kind:'secret' (got: ${markedSecret.join(', ')})`);

// ── item 31: every subsystem the console draws has an explanation, not just a state ──────────────────
// Same class of guard as the Env↔SETTINGS drift check above, and it exists for the same reason: a card that
// acquires a state but no "why does this exist" is a silent gap, and silence is exactly what this feature was
// built to eliminate. Keyed off the ids `buildSubsystems` actually renders — a hand-typed list here could
// drift from the real card set, which is the failure mode this whole file is about.
{
  const doc = buildStatus(
    { NS_SERVER: 'ns.example.com', NS_PORTAL_ISS: 'portal.example.com', PORTAL_MODE: '1',
      PORTAL_HANDOFF_URL: '', PORTAL_SUPERADMINS: 'boss@example.com', CACHE_SCOPE: 'dev' },
    { principal: null, hostname: 'svc-dev.example.com' },
  );
  const integrations = doc.subsystems.filter((x) => x.tab === 'integration');
  const missing = integrations.filter((x) => x.detail.length === 0).map((x) => x.id);
  ok(missing.length === 0,
    `every Integrations card explains why it exists${missing.length ? ` (no detail: ${missing.join(', ')})` : ''}`);

  // A stub would satisfy a presence check, so require it to be prose. The threshold is low on purpose — the
  // point is to catch a placeholder, not to mandate a word count.
  const thin = integrations.filter((x) => x.detail.join(' ').length < 200).map((x) => x.id);
  ok(thin.length === 0, `and does so in prose, not a stub${thin.length ? ` (too thin: ${thin.join(', ')})` : ''}`);

  // No entry may name a subsystem that does not exist — a table keyed by id drifts silently otherwise, and
  // the Features/Deployment pass will add entries to this same table.
  // Against the UNION of both modes, not just this doc: a subsystem that cannot act in the mode being built is
  // filtered out of it, so checking one mode makes the other mode's cards look like orphans. `access` and
  // `exposure` are exactly that case — real cards, absent from a portal document by design.
  const ids = new Set(doc.subsystems.map((x) => x.id));
  const orphans = Object.keys(SUBSYSTEM_DETAIL).filter((k) => !ids.has(k));
  ok(orphans.length === 0, `no explanation is written for a card that does not exist${orphans.length ? ` (${orphans.join(', ')})` : ''}`);

  // The Backend tab is covered too now — this assertion used to say the opposite ("deliberately not covered
  // yet, flip this when its pass lands"), which is what made the gap a decision rather than an oversight and
  // gave the pass an obvious place to land.
  const backend = doc.subsystems.filter((x) => x.tab === 'deployment');
  const bareBackend = backend.filter((x) => x.detail.length === 0).map((x) => x.id);
  ok(bareBackend.length === 0,
    `every Backend card explains why it exists${bareBackend.length ? ` (no detail: ${bareBackend.join(', ')})` : ''}`);
  const thinBackend = backend.filter((x) => x.detail.join(' ').length < 200).map((x) => x.id);
  ok(thinBackend.length === 0, `and in prose, not a stub${thinBackend.length ? ` (too thin: ${thinBackend.join(', ')})` : ''}`);

  // Every card on BOTH tabs, in one assertion, so a future tab cannot be added and quietly left bare.
  const allCards = doc.subsystems;
  const bare = allCards.filter((x) => x.detail.length === 0).map((x) => x.id);
  ok(bare.length === 0,
    `and no card in EITHER mode carries a state with no explanation${bare.length ? ` (${[...new Set(bare)].join(', ')})` : ''}`);
}


// ── PORTAL_MENUS' prose must name the ACTUAL legal app-axis keys ─────────────────────────────────────
// David, 2026-08-08: "which app is active" was true and useless — it never said what you may write there.
// The legal set is APP_NAMES plus the two reserved keys, and it lives in menus.ts. statusModel is the
// import-free data table by design, so this is enforced with a test rather than an import: the prose is
// allowed to be a copy, but not allowed to be a DIFFERENT copy.
{
  const row = SETTINGS.find((x) => x.name === 'PORTAL_MENUS')!;
  const legal = [...APP_NAMES, 'none', '*'];
  // Every AXIS is named too, not just the app values. `users` was added later, and prose that lists three
  // of four axes is how an operator concludes the fourth does not exist.
  for (const axis of ['domains', 'scopes', 'app', 'users']) {
    ok(row.what.includes('`' + axis + '`'), `[menus-prose] the ${axis} axis is named`);
  }
  const missing = legal.filter((k) => !row.what.includes('`' + k + '`'));
  ok(missing.length === 0,
    `[menus-prose] every legal app-axis key is named in the description${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  // And the example must actually DEMONSTRATE the axis it describes — the old one showed a bare add list,
  // which is the case nobody needs help with.
  ok(row.example!.includes('"app"'), '[menus-prose] and the example demonstrates the app axis');
  let parsed = true;
  try { JSON.parse(row.example!); } catch { parsed = false; }
  ok(parsed, '[menus-prose] with an example that is valid JSON — it is meant to be copied');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
