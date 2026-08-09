import { page } from './pageShell.js';
import { truthy } from './mode.js';
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
  NS_PORTAL_ISS?: string;
  PORTAL_HANDOFF_URL?: string;
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
  const iss = (env.NS_PORTAL_ISS ?? '').trim();

  if (!nsServerConfigured(env)) {
    issues.push({
      level: 'blocker',
      title: 'NS_SERVER is not configured',
      detail: `Still the shipped placeholder (${PLACEHOLDER_SERVER}), so every API read would go nowhere.`,
      fix: 'Set vars.NS_SERVER in wrangler.jsonc to your NetSapiens API host, then redeploy.',
    });
  }

  // Required for the delegated path — which portal backend mode always uses, and standalone mode uses whenever a
  // caller sends a Bearer token. It has no default on purpose: a default issuer would accept tokens
  // minted by a portal you don't control.
  if (!set(iss) || iss === PLACEHOLDER_ISS) {
    issues.push({
      level: 'blocker',
      title: 'NS_PORTAL_ISS is not configured',
      detail: 'Every ns_t is validated against this, so with it unset all requests are refused (fail-closed).',
      fix: 'Set vars.NS_PORTAL_ISS to the Manager Portal host that issues your ns_t. Comma-separate several hosts if one backend has more than one portal hostname.',
    });
  }

  // Portal backend mode chain-loads the vendor bundle-router from PORTAL_HANDOFF_URL. ABSENT (undefined)
  // is a misconfiguration — loud but non-fatal: the primary still serves, but the vendor add-on would
  // break, so reflect it in /health `configured`. Present-empty ("") is an INTENTIONAL "no handoff" (correct when
  // not replacing a vendor) and is NOT flagged. Scoped under portal mode so dia/local are never touched.
  if (env.PORTAL_HANDOFF_URL === undefined) {
    issues.push({
      level: 'blocker',
      title: 'PORTAL_HANDOFF_URL is not configured',
      detail:
        'This Worker serves a primary that chain-loads the vendor bundle-router from this URL. ' +
        'Unset, the vendor product it replaces would break. Set it to "" only if you are deliberately not replacing a vendor.',
      fix: 'Set vars.PORTAL_HANDOFF_URL to your vendor bundle-router URL (https), or "" for an intentional no-handoff.',
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
      '<code>wrangler secret put &lt;NAME&gt;</code>, then redeploy. Every setting is defined in CONFIG.md.',
  });
}
