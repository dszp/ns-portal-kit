/**
 * The ungated-service-token gate.
 *
 * A stored `NS_API_TOKEN` is AMBIENT AUTHORITY: it answers whatever request reaches the Worker, with
 * that token's full NetSapiens scope. A reseller-scoped token means every domain it covers. So a
 * publicly-reachable deployment with a stored token and no gate in front hands your fleet to anyone
 * who finds the URL — and `workers_dev: true` (which the deploy button needs, or the Worker has no URL
 * at all) makes that URL trivially findable.
 *
 * So: **refuse to use the stored token until something is verifiably in front of it.** Not a warning —
 * a warning is a thing you scroll past, and the failure is silent and total.
 *
 * The gate opens when ANY of these is true:
 *   1. `ACCESS_AUD` is set — the in-Worker Cloudflare Access check is live and fails closed, so a
 *      request that skipped Access never reaches the token.
 *   2. The request is local (`wrangler dev`) — not internet-reachable, so there is nothing to expose.
 *   3. `ALLOW_UNGATED_SERVICE_TOKEN` is truthy — a deliberate opt-out, for someone who has put their
 *      own protection in front (mTLS, a WAF, an authenticating proxy) and doesn't need ours.
 *
 * DELEGATED / PORTAL MODE IS UNAFFECTED, and that's the point: there the caller supplies their own
 * `ns_t`, so there is no ambient authority to protect. The gate exists precisely and only where the
 * Worker would otherwise lend out a credential the caller never proved they should have.
 */

import { page } from './pageShell.js';

export interface ExposureEnv {
  NS_API_TOKEN?: string;
  ACCESS_AUD?: string;
  ALLOW_UNGATED_SERVICE_TOKEN?: string;
}

const truthy = (v?: string): boolean => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
const set = (v?: string): boolean => (v ?? '').trim().length > 0;

/**
 * Is this request local (`wrangler dev`)? A deployed Worker is routed by Host, so a request carrying
 * `Host: localhost` is never routed to it by Cloudflare — this can't be spoofed into opening the gate
 * on a real deployment.
 */
export function isLocalRequest(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}

/**
 * True when the stored service token must NOT be used: it exists, nothing verifiable is in front of it,
 * and this isn't local dev. Callers should refuse rather than fall back to it.
 */
export function serviceTokenBlocked(env: ExposureEnv, hostname: string): boolean {
  if (!set(env.NS_API_TOKEN)) return false;              // no ambient authority to protect
  if (set(env.ACCESS_AUD)) return false;                 // Access check is live, and fails closed
  if (truthy(env.ALLOW_UNGATED_SERVICE_TOKEN)) return false; // deliberate opt-out
  if (isLocalRequest(hostname)) return false;            // wrangler dev; not reachable
  return true;
}

/** Operator-facing explanation. Names no values — only which settings are absent. */
export const BLOCKED_REASON =
  'A stored NS_API_TOKEN is configured, but nothing verifiable is in front of it. Reads that would use ' +
  'it are refused so a public URL cannot borrow your NetSapiens scope. Fix by setting ACCESS_AUD + ' +
  'ACCESS_TEAM_DOMAIN (Cloudflare Access; recommended), or switching to PORTAL_MODE=1 so each caller ' +
  'supplies their own ns_t, or setting ALLOW_UNGATED_SERVICE_TOKEN=1 if you have your own protection ' +
  'in front and accept the risk.';

/**
 * The page shown instead of the app while the gate is closed. Teaches rather than refuses: the reader
 * is an operator who just deployed this and needs to know what to do next, not that they did wrong.
 *
 * Discloses nothing: it names settings, never values, and it disappears the moment Access is configured.
 */
export function exposureHtml(env: ExposureEnv, hostname: string, productName = 'NS Portal Kit'): string {
  const host = hostname || 'your-worker.workers.dev';
  return page({
    title: `Protect this deployment — ${productName}`,
    heading: 'Set up Cloudflare Access first',
    intro:
      'This deployment has a NetSapiens API token, which means anyone who reaches this URL could read ' +
      'everything that token can. It is refusing to use the token until you put Access in front — about ' +
      'two minutes. Nothing is broken; finish the steps and this page is replaced by the app.',
    items: [
      {
        level: 'step',
        title: 'Open Zero Trust → Access → Applications',
        body: [
          'In the Cloudflare dashboard, pick your account, then Zero Trust in the sidebar. Access → Applications → Add an application → Self-hosted.',
          'Zero Trust is free for the first 50 users.',
        ],
      },
      {
        level: 'step',
        title: 'Point the application at this hostname',
        body: ['Use this Worker\'s hostname as the application domain:'],
        code: host,
      },
      {
        level: 'step',
        title: 'Add a policy for who may in',
        body: [
          'Action Allow, then a rule — commonly Emails ending in @yourcompany.com, or a specific list of emails. This is who can see your NetSapiens data, so keep it tight.',
        ],
      },
      {
        level: 'step',
        title: 'Copy the Application Audience (AUD) tag',
        body: [
          'On the application\'s Overview tab. It is a long hex string, and it is a public identifier — safe to commit.',
        ],
      },
      {
        level: 'step',
        title: 'Put both values in wrangler.jsonc and redeploy',
        body: ['Your team domain is the yourteam.cloudflareaccess.com hostname from Zero Trust → Settings → Custom Pages (or your Zero Trust URL).'],
        code:
          '"vars": {\n' +
          '  "ACCESS_AUD": "<the AUD tag you copied>",\n' +
          '  "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com"\n' +
          '}',
      },
      {
        level: 'step',
        title: 'Reload',
        body: [
          'The Worker verifies the Access JWT itself (RS256 against your team\'s JWKS) on every request, so a direct hit that skipped Access is still refused — the gate does not rely on Cloudflare\'s routing alone.',
        ],
      },
    ],
    footer:
      'Other ways to clear this: run <code>PORTAL_MODE=1</code> so each caller supplies their own ' +
      '<code>ns_t</code> and no token is stored at all; or, if you have your own protection in front ' +
      '(mTLS, a WAF, an authenticating proxy), set <code>ALLOW_UNGATED_SERVICE_TOKEN=1</code> to accept ' +
      'the risk deliberately. See SETUP.md.',
  });
}
