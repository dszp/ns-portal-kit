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
  NS_API_TOKEN?: string;
  NS_PORTAL_ISS?: string;
  PORTAL_MODE?: string;
  ACCESS_AUD?: string;
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
      detail: 'Service mode needs a stored token; portal mode is off, so no delegated ns_t will arrive either.',
      fix: 'Either `wrangler secret put NS_API_TOKEN` (service mode), or set vars.PORTAL_MODE = "1" to take the caller\'s ns_t instead.',
    });
  }

  // Required for the delegated path — which portal mode always uses, and service mode uses whenever a
  // caller sends a Bearer token. It has no default on purpose: a default issuer would accept tokens
  // minted by a portal you don't control.
  if ((portal || set(env.NS_API_TOKEN)) && (!set(iss) || iss === PLACEHOLDER_ISS)) {
    issues.push({
      level: portal ? 'blocker' : 'warning',
      title: 'NS_PORTAL_ISS is not configured',
      detail: portal
        ? 'Portal mode validates every ns_t against this, so all requests will be refused (fail-closed).'
        : 'Service mode works without it, but any caller sending a Bearer ns_t will be refused.',
      fix: 'Set vars.NS_PORTAL_ISS to the Manager Portal host that issues your ns_t. Comma-separate several hosts if one backend has more than one portal hostname.',
    });
  }

  // A stored token is ambient authority: it answers ANY request that reaches the Worker, with the full
  // NetSapiens scope of that token. Worth saying out loud.
  if (!portal && set(env.NS_API_TOKEN) && !set(env.ACCESS_AUD)) {
    issues.push({
      level: 'warning',
      title: 'Service token is not behind an access gate',
      detail: 'Anyone who reaches this Worker gets whatever the stored token can read — a reseller-scoped token means your whole fleet.',
      fix: 'Set ACCESS_AUD + ACCESS_TEAM_DOMAIN to turn on the in-Worker Cloudflare Access check (it fails closed), and/or ALLOWED_DOMAINS to bound it at the app layer. Keep workers_dev false.',
    });
  }

  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'blocker' ? -1 : 1));
}

/** True when this deployment cannot work as configured. Warnings alone do NOT trigger setup. */
export function needsSetup(env: SetupEnv): boolean {
  return setupIssues(env).some((i) => i.level === 'blocker');
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain, self-contained checklist page. No CDN, no fonts — it must render on a broken deployment. */
export function setupHtml(env: SetupEnv, productName = 'NS Portal Kit'): string {
  const issues = setupIssues(env);
  const rows = issues
    .map(
      (i) => `<li class="${i.level}">
      <div class="t"><span class="tag">${i.level === 'blocker' ? 'must fix' : 'review'}</span>${esc(i.title)}</div>
      <p>${esc(i.detail)}</p>
      <p class="fix">${esc(i.fix)}</p>
    </li>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup — ${esc(productName)}</title>
<style>
  :root { color-scheme: light dark; --fg:#1e293b; --dim:#64748b; --bg:#f8fafc; --card:#fff; --line:#e2e8f0; --red:#b91c1c; --amber:#b45309; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e2e8f0; --dim:#94a3b8; --bg:#0f172a; --card:#1e293b; --line:#334155; --red:#f87171; --amber:#fbbf24; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:2.5rem 1.25rem; background:var(--bg); color:var(--fg);
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .35rem; }
  .sub { color:var(--dim); margin:0 0 1.75rem; }
  ul { list-style:none; padding:0; margin:0 0 1.75rem; }
  li { background:var(--card); border:1px solid var(--line); border-left-width:4px; border-radius:8px;
       padding:1rem 1.1rem; margin-bottom:.75rem; }
  li.blocker { border-left-color:var(--red); } li.warning { border-left-color:var(--amber); }
  .t { font-weight:600; display:flex; gap:.6rem; align-items:baseline; }
  .tag { font-size:.7rem; text-transform:uppercase; letter-spacing:.04em; padding:.1rem .4rem;
         border-radius:4px; border:1px solid var(--line); color:var(--dim); font-weight:600; }
  p { margin:.45rem 0 0; color:var(--dim); }
  .fix { color:var(--fg); }
  code { background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:.05rem .3rem; font-size:.9em; }
  footer { color:var(--dim); font-size:.85rem; border-top:1px solid var(--line); padding-top:1rem; }
</style></head><body><main>
<h1>${esc(productName)} — finish setup</h1>
<p class="sub">This deployment is not configured yet, so it can't talk to NetSapiens. Nothing here is
secret: it reports only which settings are missing, never their values, and this page disappears once
they're set.</p>
<ul>
${rows}
</ul>
<footer>Configure <code>vars</code> in <code>wrangler.jsonc</code>, set secrets with
<code>wrangler secret put &lt;NAME&gt;</code>, then redeploy. Full setup notes are in the README.</footer>
</main></body></html>`;
}
