/**
 * What a portal-backend-mode Worker returns at `/` (status 404).
 *
 * This URL is DISCOVERABLE — it's referenced from the injected portal JavaScript, which is
 * client-visible — so this page is deliberately terse and neutral. It must NOT narrate the auth
 * mechanism, the ns_t / injection architecture, or anything deployment-specific: a client who finds
 * the URL should see a boring "no content here" backend, with nothing to probe. Whoever deploys this
 * gets their onboarding from SETUP.md (and standalone mode has its own guided setup/exposure pages);
 * the portal backend has no reason to explain itself in a browser.
 *
 * Discloses nothing — no config, no hostnames, no data, no mechanism. Same bytes for every deployment.
 *
 * That last sentence is load-bearing, so this function takes NO arguments. It used to accept
 * productName(env), which put BRAND_NAME — a value brand.ts tells you to store as a SECRET — into
 * the <title> of an unauthenticated page (portal-mode deployments have no Access gate in front).
 * Escaped, so never an injection; but it fingerprinted the white-label operator to exactly the
 * client this page exists to bore. Keep it static: no env, no config, no branding.
 */

import { esc } from './pageShell.js';

/** The neutral product name. Deliberately NOT brand.ts's productName(env) — see above. */
const NEUTRAL_NAME = 'NS Portal Kit';

export function portalModeHtml(): string {
  const productName = NEUTRAL_NAME;
  const msg =
    'This host serves application requests and has no public web content. ' +
    'Setup documentation contains admin configuration instructions.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(productName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         padding:2rem; background:#f8fafc; color:#334155;
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  @media (prefers-color-scheme: dark) { body { background:#0f172a; color:#94a3b8; } }
  p { max-width:34rem; margin:0; text-align:center; }
</style></head><body><p>${esc(msg)}</p></body></html>`;
}
