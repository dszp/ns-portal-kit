/**
 * Offline proof of the Cloudflare Access RS256 verification (src/access.ts). No network: we mint an
 * RSA key, sign real Access-shaped tokens, and check the pure `verifyAccessToken` accepts the good one
 * and rejects tampering / wrong aud / wrong issuer / expiry / bad kid. Run: `pnpm test:access`.
 */
import { verifyAccessToken, type AccessJwk } from './access.js';

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

  console.log(`\naccess.selftest: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
