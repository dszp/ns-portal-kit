/**
 * App-access: config parsing + the pure sign-in decision. No I/O, no Worker globals — the whole
 * matrix is testable offline.
 *
 * FAIL CLOSED throughout: an unset `RINGOTEL_SSO_SERVICE` never claims SSO, an unset download list
 * renders no links, an unset hide list hides nothing. The failure this guards against is telling a
 * user the wrong way to sign in, so every degradation lands on "say less", never "say wrong".
 */

/** Loud, distinct error for bad app-access config (⇒ a 500 upstream, like FeaturesConfigError). */
export class AppAccessConfigError extends Error {}

export interface AppAccessEnv {
  RINGOTEL_SSO_SERVICE?: string;
  SSO_AUTO_ACTIVATE?: string;
  PORTAL_APPS_HIDE?: string;
  PORTAL_APP_DOWNLOADS?: string;
}

export interface DownloadLink {
  label: string;
  url: string;
  title?: string;
  /** Show the URL as a copyable line under the label (default true). Set false for a long/ugly link. */
  showUrl?: boolean;
}

/**
 * Is THIS org's SSO binding ours? `ssoService` is `"<serviceDefId>/<serviceName>"`. A non-empty
 * binding only means *some* SSO service is attached — it may be a third-party IdP, for which "use
 * your portal password" would be wrong. So we match the NAME half against the configured service.
 * Unset config ⇒ false, always: never claim SSO we cannot substantiate.
 */
export function ssoEnabled(ssoService: string | undefined, env: AppAccessEnv): boolean {
  const want = (env.RINGOTEL_SSO_SERVICE ?? '').trim().toLowerCase();
  if (!want) return false;
  const raw = (ssoService ?? '').trim();
  const slash = raw.indexOf('/');
  if (slash < 0) return false;              // malformed — do not guess
  return raw.slice(slash + 1).toLowerCase() === want;
}

const csv = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Is create-on-login enabled for this domain? MIRRORS the SSO worker's provisioning policy, because
 * the information is not derivable here: `params.sso` records that an SSO service is BOUND, which is a
 * different setting from whether that service creates an account for a user who has none. Empty ⇒
 * assume OFF, so we never invite a sign-in that would need an account created.
 */
export function autoActivates(domain: string, env: AppAccessEnv): boolean {
  const raw = (env.SSO_AUTO_ACTIVATE ?? '').trim();
  if (!raw) return false;
  if (raw === '*') return true;
  const want = domain.trim().toLowerCase();
  return csv(raw).some((d) => d.toLowerCase() === want);
}

/** PORTAL_APP_DOWNLOADS → the menu's download entries, in order ([] if unset). */
export function parseDownloads(env: AppAccessEnv): DownloadLink[] {
  const raw = (env.PORTAL_APP_DOWNLOADS ?? '').trim();
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new AppAccessConfigError('PORTAL_APP_DOWNLOADS is not valid JSON'); }
  if (!Array.isArray(parsed)) throw new AppAccessConfigError('PORTAL_APP_DOWNLOADS must be a JSON array');
  return parsed.map((e, i) => {
    const o = e as Record<string, unknown>;
    if (!o || typeof o !== 'object') throw new AppAccessConfigError(`PORTAL_APP_DOWNLOADS[${i}] must be an object`);
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    if (!label) throw new AppAccessConfigError(`PORTAL_APP_DOWNLOADS[${i}] needs a label`);
    if (!/^https:\/\//i.test(url)) throw new AppAccessConfigError(`PORTAL_APP_DOWNLOADS[${i}].url must start with https://`);
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : undefined;
    if (o.showUrl !== undefined && typeof o.showUrl !== 'boolean') throw new AppAccessConfigError(`PORTAL_APP_DOWNLOADS[${i}].showUrl must be a boolean`);
    return { label, url, ...(title ? { title } : {}), ...(o.showUrl === false ? { showUrl: false } : {}) };
  });
}

/**
 * PORTAL_APPS_HIDE → the stock menu labels to hide for THIS domain ([] if unset).
 *
 * Polymorphic, following the `Gate` precedent in features.ts: a bare CSV applies fleet-wide; an
 * object keys per domain with `*` as the default, and an empty array means "hide nothing here".
 * NOT conditioned on the domain running the app — a domain may be served by another white-label app,
 * so leaving it with no softphone entry is a supported outcome, not a hazard.
 */
export function parseHideList(env: AppAccessEnv, domain: string): string[] {
  const raw = (env.PORTAL_APPS_HIDE ?? '').trim();
  if (!raw) return [];
  if (!raw.startsWith('{')) return csv(raw);

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new AppAccessConfigError('PORTAL_APPS_HIDE is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppAccessConfigError('PORTAL_APPS_HIDE must be a CSV string or a JSON object');
  }
  const map = new Map<string, string[]>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new AppAccessConfigError(`PORTAL_APPS_HIDE["${k}"] must be an array of strings`);
    }
    map.set(k.trim().toLowerCase(), (v as string[]).map((x) => x.trim()).filter(Boolean));
  }
  const own = map.get(domain.trim().toLowerCase());
  return own !== undefined ? own : (map.get('*') ?? []);
}

/** Null when the app-access config is valid (or absent); a loud, actionable message otherwise. */
export function appAccessConfigError(env: AppAccessEnv): string | null {
  try {
    parseDownloads(env);
    parseHideList(env, 'probe.example');
    return null;
  } catch (e) {
    if (e instanceof AppAccessConfigError) return `App-access config invalid: ${e.message}`;
    throw e;
  }
}

export type AppAccessMode = 'sso' | 'password' | 'needs-portal-setup' | 'not-set-up' | 'unavailable';

export interface AppAccessInput {
  /** A Ringotel org resolved for this domain. */
  orgActive: boolean;
  /** Raw `OrgBranchEntry.ssoService`. */
  ssoService?: string;
  /** NS `account-status` from the self-record. */
  accountStatus?: string;
  /** NS `user-scope` from the self-record. */
  userScope?: string;
  /** The eligibility engine's verdict for this extension. Governs CREATION (create-on-login); it does
   *  NOT block an already-activated user's sign-in — SOFT/email exclusions are creation-only. */
  eligible: boolean;
  /** Was the eligibility verdict a HARD exclusion (system/service user or structurally-invalid extension)?
   *  HARD identities are "never activatable" and stay blocked even when already activated, unlike SOFT/
   *  email exclusions. Absent ⇒ treated as not hard-excluded. */
  hardExcluded?: boolean;
  /** Does an activated Ringotel user exist for this extension? */
  activated: boolean;
  /** Is create-on-login enabled for this domain (`SSO_AUTO_ACTIVATE`)? Not derivable from the org. */
  autoActivate: boolean;
  /** NS `login-username`, verbatim. */
  loginUsername?: string;
  /** Ringotel SIP username (`<ext><suffix>`). */
  sipUsername?: string;
}

/**
 * Can this user complete an SSO sign-in at all? SSO authenticates against NetSapiens, so a user with
 * no usable NS password (`account-status` other than `standard`) or no portal access at all
 * (`user-scope: No Portal`) cannot finish it.
 *
 * SSO-SCOPED ONLY — do not apply this to the password path, where the user types the *app* password
 * and their NS credentials are irrelevant. Applying it there would block users who activate perfectly
 * well from a Ringotel welcome email.
 */
function nsLoginUsable(input: AppAccessInput): boolean {
  const status = (input.accountStatus ?? '').trim().toLowerCase();
  const scope = (input.userScope ?? '').trim().toLowerCase();
  if (scope === 'no portal') return false;
  return status === 'standard';
}

/**
 * The whole decision. Pure. Advisory modes deliberately return NO username, so a caller structurally
 * cannot render credentials to someone who should not be signing in.
 */
export function resolveAppAccess(input: AppAccessInput, env: AppAccessEnv): { mode: AppAccessMode; username?: string } {
  if (!input.orgActive) return { mode: 'unavailable' };

  if (ssoEnabled(input.ssoService, env)) {
    if (!nsLoginUsable(input)) return { mode: 'needs-portal-setup' };
    // An already-activated user has a working Ringotel account, so eligibility — which governs whether we
    // may CREATE one — no longer applies to their sign-in. SOFT/email exclusions are creation-only (see
    // eligibility.ts); only a HARD identity (system/service, structurally-invalid ext) stays blocked.
    if (input.activated) {
      if (input.hardExcluded) return { mode: 'not-set-up' };
      return { mode: 'sso', ...(input.loginUsername ? { username: input.loginUsername } : {}) };
    }
    // Not activated ⇒ the create-on-login path: needs BOTH eligibility AND create-on-login enabled.
    // create-on-login is a different setting from the SSO binding and is not readable here, so it
    // arrives as config; without it, an eligible user with no account would be told to sign in and fail.
    if (!input.eligible) return { mode: 'not-set-up' };
    if (!input.autoActivate) return { mode: 'not-set-up' };
    return { mode: 'sso', ...(input.loginUsername ? { username: input.loginUsername } : {}) };
  }

  if (!input.activated) return { mode: 'not-set-up' };
  return { mode: 'password', ...(input.sipUsername ? { username: input.sipUsername } : {}) };
}
