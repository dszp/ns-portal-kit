/**
 * Parity: "would auto-provision on SSO login" (ringotel-ns-sso) and "gets a placeholder" (this repo) are two
 * env parsers over ONE library function. This is the seam where they can silently diverge. Skips — loudly —
 * when the sibling repo is not checked out beside this one, so a fresh clone does not fail.
 *
 * Run: pnpm test:parity
 */
import { existsSync } from 'node:fs';
import { evaluateEligibility, type EligUser } from '@dszp/netsapiens-lib';
import { resolveRingotelConfig } from './eligibility.js';

const SIBLING = new URL('../../ringotel-ns-sso/src/config.ts', import.meta.url);
if (!existsSync(SIBLING)) { console.log('SKIP: ../ringotel-ns-sso not present — parity not checked'); process.exit(0); }
const { parseEligibility } = await import(SIBLING.href);
if (typeof parseEligibility !== 'function') {
  console.log('SKIP: parseEligibility is not exported by ../ringotel-ns-sso — parity not checked');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

// One env, both parsers. The SSO worker reads the same RINGOTEL_EXCLUDE_* names (check its config.ts if this fails).
const env = { RINGOTEL_EXCLUDE_NAMES: 'SHARED,VOICEMAIL,CONFERENCE', RINGOTEL_EXCLUDE_EXTS: '9*', RINGOTEL_WRITE_DOMAINS: '*' };
const mine = resolveRingotelConfig(env);
const theirs = parseEligibility(env);
const users: EligUser[] = [
  { ext: '100', names: ['Jane', 'Doe'], email: 'j@example.com' },
  { ext: '101', names: ['SHARED', 'VOICEMAIL'], email: '' },
  { ext: '900', names: ['Nine', 'Hundred'], email: 'n@example.com' },
  { ext: '102', names: ['Svc'], email: 's@example.com', srvCode: '11' },
  { ext: '103', names: ['No', 'Mail'], email: '' },
  // The directory flag: graded by RINGOTEL_UNLISTED_USERS, which neither env below sets — so both sides
  // must land on the library's own default (soft). A parser that ignores the key still agrees here,
  // because agreeing means resolving to the same default, not to the same explicit value.
  { ext: '104', names: ['Hidden', 'Person'], email: 'h@example.com', listedInDirectory: false },
];
for (const u of users) {
  const a = evaluateEligibility(u, { domain: 'acme.example', isReseller: false, emailNotRequired: false }, mine);
  const b = evaluateEligibility(u, { domain: 'acme.example', isReseller: false, emailNotRequired: false }, theirs);
  ok(a.tier === b.tier, `ext ${u.ext}: kit=${a.tier} sso=${b.tier}`);
}

// Second pass: NO RINGOTEL_EXCLUDE_* set at all, so both parsers fall back to their own SEEDED default
// name list (see eligibility.ts's `rawNames` fallback) — the actual out-of-the-box behavior most
// deployments run with, not the explicit-list case above. Exercise users that hit those defaults
// ('SHARED VOICEMAIL', 'CONF RM', 'ROUTING' — substring, case-insensitive) plus one plain person who
// should hit neither list.
const envDefaults = { RINGOTEL_WRITE_DOMAINS: '*' };
const mineDefaults = resolveRingotelConfig(envDefaults);
const theirsDefaults = parseEligibility(envDefaults);
const defaultUsers: EligUser[] = [
  { ext: '200', names: ['SHARED VOICEMAIL'], email: '' },
  { ext: '201', names: ['CONF RM'], email: '' },
  { ext: '202', names: ['ROUTING'], email: '' },
  { ext: '203', names: ['Jane', 'Doe'], email: 'j@example.com' },
  { ext: '204', names: ['Hidden', 'Person'], email: 'h@example.com', listedInDirectory: false },
];
for (const u of defaultUsers) {
  const a = evaluateEligibility(u, { domain: 'acme.example', isReseller: false, emailNotRequired: false }, mineDefaults);
  const b = evaluateEligibility(u, { domain: 'acme.example', isReseller: false, emailNotRequired: false }, theirsDefaults);
  ok(a.tier === b.tier, `[defaults] ext ${u.ext}: kit=${a.tier} sso=${b.tier}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
