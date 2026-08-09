/**
 * Offline proof of the Cloudflare Access RS256 verification (src/access.ts). No network: we mint an
 * RSA key, sign real Access-shaped tokens, and check the pure `verifyAccessToken` accepts the good one
 * and rejects tampering / wrong aud / wrong issuer / expiry / bad kid. Run: `pnpm test:access`.
 */
import { accessConfig, verifyAccessToken, type AccessJwk } from './access.js';

// A deliberately-fake 64-hex placeholder. The self-test only needs the AUD to be self-consistent
// (mint with it, verify against it) — never a real one. Do NOT paste a deployment's real Access AUD
// here: this file ships to the public mirror, and a real AUD fingerprints the Access app.
const AUD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ISS = 'https://yourteam.cloudflareaccess.com';
const KID = 'test-kid-1';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const enc = (s: string) => new TextEncoder().encode(s);

async function makeToken(
  priv: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: KID, typ: 'JWT' },
): Promise<string> {
  const h = b64url(enc(JSON.stringify(header)));
  const p = b64url(enc(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, enc(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

async function main() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey;
  const jwks: AccessJwk[] = [{ kid: KID, kty: jwk.kty!, n: jwk.n!, e: jwk.e! }];
  const now = 1_800_000_000; // fixed clock for deterministic exp checks
  const good = { aud: [AUD], iss: ISS, email: 'tester@acme.example', sub: 'u1', iat: now - 10, exp: now + 3600 };

  const okTok = await makeToken(privateKey, good);
  check('valid token accepted', (await verifyAccessToken(okTok, jwks, { aud: AUD, issuer: ISS, now })).ok);

  const r = await verifyAccessToken(okTok, jwks, { aud: AUD, issuer: ISS, now });
  check('email surfaced', r.ok && r.email === 'tester@acme.example');

  // aud as a bare string (Access sometimes emits scalar aud) is accepted too
  const scalarAud = await makeToken(privateKey, { ...good, aud: AUD });
  check('scalar aud accepted', (await verifyAccessToken(scalarAud, jwks, { aud: AUD, issuer: ISS, now })).ok);

  // tampered payload → signature fails
  const parts = okTok.split('.');
  const forgedPayload = b64url(enc(JSON.stringify({ ...good, email: 'attacker@evil.com' })));
  const tampered = `${parts[0]}.${forgedPayload}.${parts[2]}`;
  check('tampered payload rejected', !(await verifyAccessToken(tampered, jwks, { aud: AUD, issuer: ISS, now })).ok);

  const wrongAud = await verifyAccessToken(okTok, jwks, { aud: 'some-other-app-aud', issuer: ISS, now });
  check('wrong aud rejected', !wrongAud.ok && wrongAud.reason === 'aud mismatch');

  const wrongIss = await verifyAccessToken(okTok, jwks, { aud: AUD, issuer: 'https://evil.cloudflareaccess.com', now });
  check('wrong issuer rejected', !wrongIss.ok && wrongIss.reason === 'issuer mismatch');

  const expiredTok = await makeToken(privateKey, { ...good, exp: now - 1 });
  const expired = await verifyAccessToken(expiredTok, jwks, { aud: AUD, issuer: ISS, now });
  check('expired token rejected', !expired.ok && expired.reason === 'token expired');

  const noExpTok = await makeToken(privateKey, { aud: [AUD], iss: ISS, sub: 'u1', iat: now - 10 }); // no exp
  const noExp = await verifyAccessToken(noExpTok, jwks, { aud: AUD, issuer: ISS, now });
  check('missing exp rejected (no non-expiring tokens)', !noExp.ok && noExp.reason === 'missing exp');

  const wrongKidTok = await makeToken(privateKey, good, { alg: 'RS256', kid: 'nope', typ: 'JWT' });
  check('unknown kid rejected', !(await verifyAccessToken(wrongKidTok, jwks, { aud: AUD, issuer: ISS, now })).ok);

  // signed by a DIFFERENT key (same kid) → signature must fail
  const other = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const foreignTok = await makeToken(other.privateKey, good);
  check('foreign-key signature rejected', !(await verifyAccessToken(foreignTok, jwks, { aud: AUD, issuer: ISS, now })).ok);

  check('malformed token rejected', !(await verifyAccessToken('not.a.jwt.at.all', jwks, { aud: AUD, issuer: ISS, now })).ok);
  check('alg none rejected', !(await verifyAccessToken(
    await makeToken(privateKey, good, { alg: 'none', kid: KID }), jwks, { aud: AUD, issuer: ISS, now })).ok);

  // ── accessConfig: WHEN the gate is live at all ──────────────────────────────────────────────────
  //
  // The predicate, not the crypto. Two independent reasons to return null, and the second one is the whole
  // of UX-spec item 11: in portal-backend mode an Access gate is not redundant, it is an outage — the
  // Manager Portal loads the injected primary with a plain `<script src>`, which cannot complete an Access
  // login. Enforced in ONE place so every consumer (requireAccess, the global gate, setupIssues'
  // half-configured warning, the exposure gate, the integration console's Access card) inherits it; scattering
  // `portalMode` checks across each call site is how the original confusion survived a code read.
  const bothVars = { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: 'yourteam.cloudflareaccess.com' };
  check('accessConfig: both vars set (standalone) → live', accessConfig(bothVars) !== null);
  check('accessConfig: AUD alone → null (the 356e6d8 fail-open shape — never trust AUD on its own)',
    accessConfig({ ACCESS_AUD: AUD }) === null);
  check('accessConfig: team domain alone → null', accessConfig({ ACCESS_TEAM_DOMAIN: 'yourteam.cloudflareaccess.com' }) === null);
  check('accessConfig: neither → null', accessConfig({}) === null);
  // Each of the recognized truthy forms, because portalMode() accepts all of them and honouring Access
  // under any one of them breaks that deployment. Tested individually rather than via one representative:
  // a regression that only re-read "1" would otherwise pass.
  for (const v of ['1', 'true', 'yes', 'on', 'ON', ' 1 ']) {
    check(`accessConfig: PORTAL_MODE=${JSON.stringify(v)} → null even with BOTH vars set (Access is ignored, not honoured)`,
      accessConfig({ ...bothVars, PORTAL_MODE: v }) === null);
  }
  // And the negative: a falsy/absent PORTAL_MODE must NOT suppress the gate, or the standalone deployment
  // whose only protection this is would be serving its ambient-authority token unguarded.
  for (const v of ['0', 'false', 'no', 'off', '', undefined]) {
    check(`accessConfig: PORTAL_MODE=${JSON.stringify(v)} (standalone) → still live`,
      accessConfig({ ...bothVars, PORTAL_MODE: v }) !== null);
  }

  console.log(`\naccess.selftest: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
