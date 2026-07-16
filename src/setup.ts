import { page } from './pageShell.js';
import { accessConfig } from './access.js';
/**
 * First-run setup check.
 *
 * Neither the "Deploy to Cloudflare" button nor `npm create cloudflare -- --template=…` can prompt for
 * configuration — Cloudflare's own template guidance says so, and recommends validating at runtime and
 * warning prominently instead. This is that warning.
 *
 * A fresh fork ships `NS_SERVER: "api.example.com"` and no token, so its first request would otherwise
 * fail somewhere deep in an API call with a confusing error. Instead the viewer route renders a short
 * checklist naming exactly what's missing.
 *
 * SAFE TO SERVE UNAUTHENTICATED: it only ever reports whether values are *present* or still the shipped
 * placeholder — never a value, never a secret, and it disappears entirely once configured, so a running
 * deployment discloses nothing. It also can't mask a real problem: if setup IS complete, this module is
 * inert.
 */

/** The values a fresh fork ships with. Matching one means "never configured", not "configured oddly". */
const PLACEHOLDER_SERVER = 'api.example.com';
const PLACEHOLDER_ISS = 'manage.example.com';

export interface SetupEnv {
  NS_SERVER?: string;
  ALLOW_UNGATED_SERVICE_TOKEN?: string;
  NS_API_TOKEN?: string;
  NS_PORTAL_ISS?: string;
  PORTAL_MODE?: string;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

export interface SetupIssue {
  /** 'blocker' = nothing will work until fixed. 'warning' = it runs, but you probably don't want this. */
  level: 'blocker' | 'warning';
  title: string;
  detail: string;
  fix: string;
}

const truthy = (v?: string): boolean => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
const set = (v?: string): boolean => (v ?? '').trim().length > 0;

/** Everything wrong with this deployment's config, worst first. Empty ⇒ good to go. */
export function setupIssues(env: SetupEnv): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const portal = truthy(env.PORTAL_MODE);
  const server = (env.NS_SERVER ?? '').trim();
  const iss = (env.NS_PORTAL_ISS ?? '').trim();

  if (!set(server) || server === PLACEHOLDER_SERVER) {
    issues.push({
      level: 'blocker',
      title: 'NS_SERVER is not configured',
      detail: `Still the shipped placeholder (${PLACEHOLDER_SERVER}), so every API read would go nowhere.`,
      fix: 'Set vars.NS_SERVER in wrangler.jsonc to your NetSapiens API host, then redeploy.',
    });
  }

  // Something has to authenticate to NetSapiens: a stored service token, or a delegated ns_t.
  if (!portal && !set(env.NS_API_TOKEN)) {
    issues.push({
      level: 'blocker',
      title: 'No way to authenticate',
      detail: 'Standalone mode needs a stored token; portal backend mode is off, so no delegated ns_t will arrive either.',
      fix: 'Either `wrangler secret put NS_API_TOKEN` (standalone mode), or set vars.PORTAL_MODE = "1" to take the caller\'s ns_t instead.',
    });
  }

  // Required for the delegated path — which portal backend mode always uses, and standalone mode uses whenever a
  // caller sends a Bearer token. It has no default on purpose: a default issuer would accept tokens
  // minted by a portal you don't control.
  if ((portal || set(env.NS_API_TOKEN)) && (!set(iss) || iss === PLACEHOLDER_ISS)) {
    issues.push({
      level: portal ? 'blocker' : 'warning',
      title: 'NS_PORTAL_ISS is not configured',
      detail: portal
        ? 'Portal backend mode validates every ns_t against this, so all requests will be refused (fail-closed).'
        : 'Standalone mode works without it, but any caller sending a Bearer ns_t will be refused.',
      fix: 'Set vars.NS_PORTAL_ISS to the Manager Portal host that issues your ns_t. Comma-separate several hosts if one backend has more than one portal hostname.',
    });
  }

  // A stored token is ambient authority: it answers ANY request that reaches the Worker, with the full
  // NetSapiens scope of that token. Worth saying out loud.
  // `accessConfig(env) === null`, NOT `!set(env.ACCESS_AUD)`: AUD alone leaves the check inert, so
  // testing it here would hide this warning from exactly the half-configured deployment that needs it.
  // The exposure gate keys off accessConfig too — these three must agree or they lie to each other.
  if (!portal && set(env.NS_API_TOKEN) && accessConfig(env) === null && !truthy(env.ALLOW_UNGATED_SERVICE_TOKEN)) {
    issues.push({
      level: 'warning',
      title: 'Service token is not behind an access gate — reads are REFUSED',
      detail: 'Anyone who reaches this Worker would get whatever the stored token can read, so the token is not used at all until something is in front of it. This is enforced, not advisory (src/exposure.ts).',
      fix: 'Set ACCESS_AUD + ACCESS_TEAM_DOMAIN to turn on the in-Worker Cloudflare Access check (it fails closed). Or run PORTAL_MODE=1 so each caller brings their own ns_t. Or, if you have your own protection in front, set ALLOW_UNGATED_SERVICE_TOKEN=1 to accept the risk deliberately.',
    });
  }

  // Cloudflare Access needs BOTH ACCESS_AUD and ACCESS_TEAM_DOMAIN to build a config (accessConfig,
  // src/access.ts). With only one, the check can't run and is silently inert — and because the exposure
  // gate keys off the same accessConfig, a stored token is then REFUSED (fail-closed). So an operator who
  // set ACCESS_AUD expecting protection instead gets a dead deployment. Name the missing half out loud.
  // Symmetric on purpose: EITHER half alone is the same dead deployment, and an operator who set only
  // the team domain is just as entitled to be told which var is missing as one who set only the AUD.
  const missingHalf = set(env.ACCESS_AUD) && !set(env.ACCESS_TEAM_DOMAIN)
    ? { absent: 'ACCESS_TEAM_DOMAIN', present: 'ACCESS_AUD', fix: 'Set vars.ACCESS_TEAM_DOMAIN to your yourteam.cloudflareaccess.com host, or remove ACCESS_AUD if you did not mean to enable Access. Then redeploy.' }
    : set(env.ACCESS_TEAM_DOMAIN) && !set(env.ACCESS_AUD)
      ? { absent: 'ACCESS_AUD', present: 'ACCESS_TEAM_DOMAIN', fix: 'Set vars.ACCESS_AUD to your Access application\'s AUD tag (Zero Trust → Access → your app → Overview), or remove ACCESS_TEAM_DOMAIN if you did not mean to enable Access. Then redeploy.' }
      : null;
  if (missingHalf) {
    issues.push({
      level: !portal && set(env.NS_API_TOKEN) ? 'blocker' : 'warning',
      title: `Cloudflare Access is half-configured (${missingHalf.absent} missing)`,
      detail:
        `${missingHalf.present} is set but ${missingHalf.absent} is not. The Access check needs both, so it cannot run — ` +
        'Access is NOT verifying anyone, and a stored service token is refused until this is fixed.',
      fix: missingHalf.fix,
    });
  }

  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'blocker' ? -1 : 1));
}

/** True when this deployment cannot work as configured. Warnings alone do NOT trigger setup. */
export function needsSetup(env: SetupEnv): boolean {
  return setupIssues(env).some((i) => i.level === 'blocker');
}

/** A plain, self-contained checklist page. No CDN, no fonts — it must render on a broken deployment. */
export function setupHtml(env: SetupEnv, productName = 'NS Portal Kit'): string {
  return page({
    title: `Setup — ${productName}`,
    heading: `${productName} — finish setup`,
    intro:
      "This deployment is not configured yet, so it can't talk to NetSapiens. Nothing here is secret: it " +
      'reports only which settings are missing, never their values, and it disappears once they are set.',
    items: setupIssues(env).map((i) => ({ level: i.level, title: i.title, body: [i.detail, i.fix] })),
    footer:
      'Configure <code>vars</code> in <code>wrangler.jsonc</code>, set secrets with ' +
      '<code>wrangler secret put &lt;NAME&gt;</code>, then redeploy. Every setting is defined in SETUP.md.',
  });
}
