/**
 * Brand configuration — deploy-time, never source.
 *
 * `@dszp/netsapiens-lib` ships vendor-neutral themes only: a brand value baked into a shared library
 * would ship one deployment's colors to every consumer of it, so a branded theme has no business
 * living there. The brand lives HERE instead, in this host's config, layered onto the registry at
 * request time:
 *
 *   BRAND_ACCENT  hex color for the accent/brand chrome (e.g. "#b3282d"). Absent ⇒ unbranded, and the
 *                 neutral `ns-portal` palette (stock NetSapiens blue) is what everyone sees.
 *
 * Set them as vars/secrets per environment, so a fork of this repo brands itself without touching a line
 * of code — and ships unbranded by default.
 *
 * ⚠️ THIS FILE IS DUPLICATED into `ns-callflow-viewer`, and the two copies have DIVERGED here on purpose.
 * That repo serves the standalone viewer, which HAS a theme picker, so it keeps `themesFor` and the
 * `BRAND_LABEL` that names the brand theme in it. This deployment renders diagrams server-side with one
 * palette and no picker: both were dead here from 0.3.0 and are gone as of 0.3.1. Check the other copy
 * before assuming a difference is an oversight.
 */
import pkg from '../package.json' with { type: 'json' };

export interface BrandEnv {
  PORTAL_RELEASE_NOTES_URL?: string;
  /** Hex accent color, e.g. "#b3282d". Absent/invalid ⇒ no brand theme. */
  BRAND_ACCENT?: string;
  /** Company name, e.g. "Acme Voice". Drives {@link productName} and the default theme label.
   *  Absent ⇒ unbranded. A white-label NAME, so set it as a secret (same as RINGOTEL_LABEL). */
  BRAND_NAME?: string;
}

/** The neutral half of the product title — the software, independent of whose brand fronts it. */
const PRODUCT = 'Portal Kit';
/** Stand-in for the company name when BRAND_NAME is unset (a fork ships unbranded). */
const DEFAULT_ORG = 'NS';

/** Software version — read from package.json so there is exactly one place to bump. */
export const VERSION: string = pkg.version;

/**
 * Where "what changed in this version" lives, with `{version}` substituted — or null when this deployment
 * has declared that it should not be linked.
 *
 * Three states, the same shape `PORTAL_HANDOFF_URL` already uses, so a reader who has met one has met both:
 *   - absent ⇒ the public release list, anchored at this version
 *   - a value ⇒ theirs, with `{version}` replaced (a fork, or their own notes)
 *   - present but EMPTY ⇒ null: a deliberate "never link", not an omission
 *
 * The default anchors into the full release LIST rather than the single-release page, deliberately. Both
 * work; they fail differently, and the list is the better landing either way. Someone clicking a version
 * number is usually asking two things at once — what is in mine, and am I behind — and the list answers both
 * (it carries a version sidebar and GitHub's Compare control) while the anchor answers the first directly.
 * If the anchor ever stops matching, the reader lands on a page that states which version it is showing,
 * beside a list they can pick theirs from — a degraded landing rather than a silent wrong answer.
 *
 * Only `{version}` is substituted, and the result is not validated as a URL here: it is operator
 * configuration, rendered into an href by callers that escape it, and a wrong value is visibly wrong.
 */
const DEFAULT_RELEASE_NOTES = 'https://github.com/dszp/ns-portal-kit/releases#release-v{version}';

export function releaseNotesUrl(env: { PORTAL_RELEASE_NOTES_URL?: string }): string | null {
  const raw = env.PORTAL_RELEASE_NOTES_URL;
  if (raw !== undefined && raw.trim() === '') return null; // declared as "do not link"
  const tpl = (raw ?? '').trim() || DEFAULT_RELEASE_NOTES;
  return tpl.replace(/\{version\}/g, VERSION);
}

/** Configured company name, or undefined when unset. */
export function brandName(env: BrandEnv): string | undefined {
  return (env.BRAND_NAME ?? '').trim() || undefined;
}

/** Product name: "Acme Voice Portal Kit" when BRAND_NAME is set, else "NS Portal Kit". */
export function productName(env: BrandEnv): string {
  return `${brandName(env) ?? DEFAULT_ORG} ${PRODUCT}`;
}

/** Product name + version, e.g. "Acme Voice Portal Kit v0.1.0". For an about/version line. */
export function productTitle(env: BrandEnv): string {
  return `${productName(env)} v${VERSION}`;
}

/** #rgb | #rrggbb | #rrggbbaa — reject anything else rather than inject it into CSS. */
const HEX = /^#[0-9a-f]{3}(?:[0-9a-f]{1,5})?$/i;

/** The configured brand accent, or undefined when unset/invalid (⇒ callers fall back to the theme). */
export function brandAccent(env: BrandEnv): string | undefined {
  const a = (env.BRAND_ACCENT ?? '').trim();
  return HEX.test(a) ? a : undefined;
}
