/**
 * Cloudflare Access (Zero Trust) JWT verification — defense in depth for the Access-gated
 * deployment (`--env dia`). When Access is CONFIGURED, every request except /health must carry a
 * valid `Cf-Access-Jwt-Assertion` (Cloudflare Access injects it at the edge AFTER the user
 * satisfies the app's policy). A request that bypasses Access — e.g. a direct hit on a
 * *.workers.dev URL — lacks a valid token and is refused (403). Combined with `workers_dev:false`
 * this means the service NS token can only ever answer requests that passed the Access policy.
 *
 * "CONFIGURED" MEANS **BOTH** `ACCESS_AUD` AND `ACCESS_TEAM_DOMAIN` — i.e. `accessConfig() !== null`.
 * Not ACCESS_AUD alone. This distinction is load-bearing and this comment used to get it wrong: the
 * team domain is what builds the JWKS URL, so with AUD alone there is nothing to verify against and
 * this module CANNOT run. Something keyed off `ACCESS_AUD` on its own therefore believed a
 * half-configured deployment was protected when the check was inert — that was a real fail-open
 * (fixed in 356e6d8; see exposure.ts). If you are adding a new "is Access on?" test anywhere, call
 * `accessConfig(env) !== null` and nothing else. setup.ts raises a blocker for the half-config state.
 *
 * Fully env-gated: with Access unconfigured this module is inert — local dev, the offline selftests,
 * and the delegated/portal deployment (which authenticates via `ns_t` instead) are unaffected.
 *
 * Worker-only (uses `crypto.subtle`, `fetch`, Cache API). NOT part of the portable library surface.
 * Fails CLOSED: any decode/fetch/verify problem returns a non-ok result, never a pass.
 */

export interface AccessConfig {
  /** Application Audience (AUD) tag of the Access app. */
  aud: string;
  /** Token issuer, e.g. "https://yourteam.cloudflareaccess.com". */
  issuer: string;
  /** JWKS endpoint for the team's Access signing keys. */
  certsUrl: string;
}

/** Build Access config from env; null ⇒ Access verification disabled (no ACCESS_AUD/team domain). */
export function accessConfig(env: { ACCESS_AUD?: string; ACCESS_TEAM_DOMAIN?: string }): AccessConfig | null {
  const aud = (env.ACCESS_AUD ?? '').trim();
  let team = (env.ACCESS_TEAM_DOMAIN ?? '').trim();
  if (!aud || !team) return null;
  team = team.replace(/^https?:\/\//, '').replace(/\/+$/, ''); // accept bare host or full URL
  const issuer = `https://${team}`;
  return { aud, issuer, certsUrl: `${issuer}/cdn-cgi/access/certs` };
}

export interface AccessJwk { kid: string; kty: string; n: string; e: string; alg?: string }

export type AccessResult =
  | { ok: true; email?: string; sub?: string }
  | { ok: false; status: number; reason: string };

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

/**
 * Pure verification: check RS256 signature against the JWKS and validate exp/nbf/iss/aud.
 * No I/O — unit-testable (see access.selftest.ts). `now` overridable for tests.
 */
export async function verifyAccessToken(
  token: string,
  jwks: AccessJwk[],
  opts: { aud: string; issuer: string; now?: number },
): Promise<AccessResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, status: 403, reason: 'malformed token' };

  let header: { alg?: string; kid?: string };
  let payload: { exp?: number; nbf?: number; iss?: string; aud?: string | string[]; email?: string; sub?: string };
  try {
    header = JSON.parse(b64urlToString(parts[0]));
    payload = JSON.parse(b64urlToString(parts[1]));
  } catch {
    return { ok: false, status: 403, reason: 'undecodable token' };
  }

  if (header.alg !== 'RS256') return { ok: false, status: 403, reason: `unexpected alg ${header.alg}` };
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, status: 403, reason: 'unknown signing key (kid)' };

  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch (e) {
    return { ok: false, status: 403, reason: `verify error: ${(e as Error).message}` };
  }
  if (!valid) return { ok: false, status: 403, reason: 'bad signature' };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  // exp is mandatory — never accept a non-expiring Access token (a missing exp must not skip the check).
  if (typeof payload.exp !== 'number') return { ok: false, status: 403, reason: 'missing exp' };
  if (payload.exp <= now) return { ok: false, status: 403, reason: 'token expired' };
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return { ok: false, status: 403, reason: 'token not yet valid' };
  if (payload.iss !== opts.issuer) return { ok: false, status: 403, reason: 'issuer mismatch' };
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(opts.aud)) return { ok: false, status: 403, reason: 'aud mismatch' };

  return { ok: true, email: payload.email, sub: payload.sub };
}

/** Extract the Access JWT from the request (header first, then the CF_Authorization cookie). */
function readAccessToken(request: Request): string | null {
  const h = request.headers.get('Cf-Access-Jwt-Assertion');
  if (h) return h.trim();
  const cookie = request.headers.get('Cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** JWKS fetch with a per-colo Cache API cache (1h). Access rotates keys; a miss just refetches. */
async function fetchJwks(cfg: AccessConfig, cache: Cache): Promise<AccessJwk[]> {
  const cacheKey = new Request(cfg.certsUrl);
  let res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(cfg.certsUrl);
    if (res.ok) {
      const cached = new Response(await res.clone().text(), res);
      cached.headers.set('Cache-Control', 'max-age=3600');
      await cache.put(cacheKey, cached);
    }
  }
  if (!res.ok) throw new Error(`certs fetch ${res.status}`);
  const body = (await res.json()) as { keys?: AccessJwk[] };
  return body.keys ?? [];
}

/** Verify the Access token on a live request. 403 when absent/invalid, 502 if JWKS unreachable. */
export async function verifyAccessRequest(request: Request, cfg: AccessConfig, cache: Cache): Promise<AccessResult> {
  const token = readAccessToken(request);
  if (!token) return { ok: false, status: 403, reason: 'no Cloudflare Access token' };
  let jwks: AccessJwk[];
  try {
    jwks = await fetchJwks(cfg, cache);
  } catch (e) {
    return { ok: false, status: 502, reason: `Access certs unavailable: ${(e as Error).message}` };
  }
  return verifyAccessToken(token, jwks, { aud: cfg.aud, issuer: cfg.issuer });
}
