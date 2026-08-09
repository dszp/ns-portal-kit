import { page } from './pageShell.js';
import { accessConfig } from './access.js';
import { portalMode, truthy } from './mode.js';
import { bothAppsHideSet } from './menus.js';
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
  PORTAL_HANDOFF_URL?: string;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  PORTAL_MENUS?: string;
  PORTAL_APPS_HIDE?: string;
}

export interface SetupIssue {
  /** 'blocker' = nothing will work until fixed. 'warning' = it runs, but you probably don't want this. */
  level: 'blocker' | 'warning';
  title: string;
  detail: string;
  fix: string;
}

const set = (v?: string): boolean => (v ?? '').trim().length > 0;

/** Portal backend mode — re-exported from `mode.ts`, which is its home. It moved there because
 *  `access.ts` must know the mode too (Access is IGNORED in portal mode, see `accessConfig`) and this
 *  module already imports `access.ts`. Existing importers keep reading it from here; there is still
 *  exactly one parse of PORTAL_MODE. */
export { portalMode };

/**
 * PORTAL_MODE must be unset (⇒ standalone) or a recognized boolean. A typo like `enabled` used to
 * read as "off" via portalMode() — silently disabling the portal policy gate while the delegated
 * reads still served. Return a message (⇒ 500, fail closed) for any unrecognized non-empty value so
 * the misconfiguration is loud, not silent. Names no value (it's operator config, but this is served
 * pre-auth).
 */
export function portalModeConfigError(env: SetupEnv): string | null {
  const raw = (env.PORTAL_MODE ?? '').trim();
  if (raw === '') return null;
  const v = raw.toLowerCase();
  const known = ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'];
  return known.includes(v)
    ? null
    : 'PORTAL_MODE is set to an unrecognized value. Use "1" to enable portal backend mode, or leave it unset for standalone. A typo must not silently disable the policy gate.';
}

/** Is NS_SERVER set to something other than the shipped placeholder? The one predicate — setupIssues
 *  below and status.ts's callflow.view prerequisite (Task 3) both call this, so "is NS_SERVER really
 *  configured" can't drift between the setup checklist and the integration console. */
export function nsServerConfigured(env: SetupEnv): boolean {
  const server = (env.NS_SERVER ?? '').trim();
  return !!server && server !== PLACEHOLDER_SERVER;
}

/** Everything wrong with this deployment's config, worst first. Empty ⇒ good to go. */
export function setupIssues(env: SetupEnv): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const portal = portalMode(env);
  const iss = (env.NS_PORTAL_ISS ?? '').trim();

  if (!nsServerConfigured(env)) {
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

  // Portal backend mode chain-loads the vendor bundle-router from PORTAL_HANDOFF_URL. ABSENT (undefined)
  // is a misconfiguration — loud but non-fatal: the primary still serves, but the vendor add-on would
  // break, so reflect it in /health `configured`. Present-empty ("") is an INTENTIONAL "no handoff" (correct when
  // not replacing a vendor) and is NOT flagged. Scoped under portal mode so dia/local are never touched.
  if (portal && env.PORTAL_HANDOFF_URL === undefined) {
    issues.push({
      level: 'blocker',
      title: 'PORTAL_HANDOFF_URL is not configured',
      detail:
        'Portal backend mode serves a primary that chain-loads the vendor bundle-router from this URL. ' +
        'Unset, the vendor product it replaces would break. Set it to "" only if you are deliberately not replacing a vendor.',
      fix: 'Set vars.PORTAL_HANDOFF_URL to your vendor bundle-router URL (https), or "" for an intentional no-handoff.',
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
  // ...and not at all in portal mode, where Access is ignored outright (accessConfig returns null): a
  // half-configured setting that this deployment will never consult is not a problem to fix, and calling
  // it one sends an operator to "repair" a var whose repaired form would break their injection. The
  // integration console's Access card says "configured but ignored here, and why" instead — which is the
  // information, where silence would not be.
  const missingHalf = portal
    ? null
    : set(env.ACCESS_AUD) && !set(env.ACCESS_TEAM_DOMAIN)
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

  // Two settings can hide an Apps-menu entry, and setting both is legal — they merge. Worth saying once,
  // though: someone reading either one alone is reading half the effective list. A WARNING, deliberately:
  // this used to be a fatal config error, which meant a cosmetic overlap returned 500 on every route
  // including the injected primary. The blast radius was wildly out of proportion to the mistake, and the
  // real fix was to make the merged result visible rather than to make the combination illegal.
  if (bothAppsHideSet(env)) {
    issues.push({
      level: 'warning',
      title: 'Two settings are hiding Apps-menu entries',
      detail:
        'PORTAL_APPS_HIDE and PORTAL_MENUS["apps"].hide are both set. They merge — neither is ignored and ' +
        'duplicates collapse — so nothing is broken, but the effective list is not either setting on its own. ' +
        'The integration console shows the merged list with each entry attributed to its source.',
      fix: 'Optional. To keep it in one place, move the PORTAL_APPS_HIDE labels into PORTAL_MENUS["apps"].hide and unset PORTAL_APPS_HIDE — that key is a strict subset, with no scope or app-state targeting.',
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
