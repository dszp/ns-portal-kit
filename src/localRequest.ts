/**
 * Is this request local (`wrangler dev`)?
 *
 * A deployed Worker is routed by Host, so a request carrying `Host: localhost` is never routed to it by
 * Cloudflare — this cannot be spoofed into changing behaviour on a real deployment.
 *
 * It lived in `exposure.ts` until the standalone viewer left this repo (2026-08-09). Nothing about it was
 * ever standalone-specific: the integration console uses it for the environment badge, which is why it
 * outlived the module it came from.
 */
export function isLocalRequest(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}
