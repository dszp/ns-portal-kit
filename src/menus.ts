/**
 * Portal menu config — static add/hide per menu, optionally conditional on which app is active.
 * Pure: config in, the resolved outcome for ONE user's domain out. No I/O, no Worker globals.
 *
 * The whole targeting model is one rule — **a default plus specific overrides** — which is why there is
 * no separate include/exclude syntax. `{"*": [x]}` changes everywhere; adding `{"acme": []}` makes it
 * "everywhere except acme"; `{"*": [], "acme": [x]}` makes it "only acme". The same holds on the app axis.
 *
 * Precedence, most specific wins:  domain  →  app state  →  "*"
 *
 * A domain key, when present, WINS OUTRIGHT — it is not merged with the app-state list. Merging would
 * make "turn it off here" inexpressible, which is the likeliest reason to reach for an override at all.
 *
 * FAIL LOUD, not silently: an unknown menu name, an unknown app key, or a bad URL is a config error that
 * fails the whole Worker at request time. A typo'd app key must never read as "never matches".
 */

/** Loud, distinct error for bad menu config (⇒ a 500 upstream, like AppAccessConfigError). */
import { parseHideList } from './appAccess.js';

export class MenuConfigError extends Error {}

/** A static menu entry. `url` must be https — never a rendered href otherwise. */
export interface MenuItem {
  label: string;
  url: string;
  title?: string;
}

/** The resolved outcome for one menu, for one user. */
export interface MenuPlan {
  hide: string[];
  add: MenuItem[];
}

/**
 * Menus we support by NAME. Operators never supply a selector — that would hand a DOM-injection surface to
 * whoever can set env vars, and it would break on every portal update. Adding a name is a code change:
 *   apps    — the portal's Apps dropdown (`ul#app-menu-list`)
 *   account — the user's own name dropdown in the toolbar (My Account / Profile / Messages / Log Out).
 *             It has NO id and shares a generic Bootstrap class, so the client identifies it by content.
 */
export const MENU_NAMES = ['apps', 'account'] as const;
export type MenuName = (typeof MENU_NAMES)[number];

/**
 * App providers, in registry order. One today; a second app is a registration here plus a resolver that
 * answers "active for this domain?", never a new branch in the targeting logic.
 */
export const APP_NAMES = ['ringotel'] as const;
/** Reserved app-axis keys: no app active, and the any-state default. */
const APP_RESERVED = ['none', '*'] as const;

export interface MenuEnv {
  PORTAL_MENUS?: string;
  PORTAL_APPS_HIDE?: string;
}

/** Which app is active for the domain being resolved (`'none'` when nothing is). */
export type AppState = string;

export interface TargetCtx {
  domain: string;
  app: AppState;
  /** This user's own facts, for `{var}` substitution in add entries. Absent ⇒ variables resolve empty. */
  vars?: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const norm = (s: string): string => s.trim().toLowerCase();

const asStringItem = (v: unknown, path: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new MenuConfigError(`${path} must be a non-empty string`);
  return v.trim();
};

/**
 * Placeholders an operator may put in a menu URL (or label/title). Substituted server-side from the
 * signed-in user's own NetSapiens record — the client is never handed a template to fill, and no other
 * user's data is reachable. An UNKNOWN placeholder is a config error: a silently-unsubstituted `{emial}`
 * would ship a literal brace into a live link.
 */
export const MENU_VARS = ['ext', 'domain', 'email', 'fname', 'lname', 'name', 'page'] as const;
export type MenuVar = (typeof MENU_VARS)[number];

/**
 * `{page}` is the one variable the SERVER cannot fill — it is where the user is in the portal at the
 * moment they click, which only the browser knows. It is validated here (so a typo is still a loud config
 * error) and passed through verbatim for the client to substitute. Deliberately the PATH only, never the
 * query string: a portal URL's query can carry identifiers, and this value leaves for a third-party
 * destination such as a support desk.
 */
const CLIENT_VARS: readonly string[] = ['page'];

/**
 * Only these schemes may be rendered as an href. `https:` for links, `mailto:` for "email support" style
 * entries. Everything else — notably `javascript:` and `data:` — has no legitimate use in a menu entry and
 * is refused at config time, so a dangerous scheme can never reach the DOM.
 */
const ALLOWED_SCHEME = /^(https:\/\/|mailto:)/i;

/**
 * Substitute `{var}` placeholders. Values are percent-encoded so a name with a space, `&` or `?` cannot
 * break out of a query value or inject another parameter. `@` is deliberately left readable: it is a legal
 * character in both a path and a query value, and encoding it would mangle every `mailto:` address.
 */
function interpolate(s: string, vars: Record<string, string> | undefined, path: string, encode = true): string {
  return s.replace(/\{([a-zA-Z]+)\}/g, (_m, name: string) => {
    const key = name.toLowerCase();
    if (!(MENU_VARS as readonly string[]).includes(key)) {
      throw new MenuConfigError(`${path} has an unknown variable "{${name}}" (known: ${MENU_VARS.map((v) => `{${v}}`).join(', ')})`);
    }
    // Client-resolved: hand it back untouched, normalized to lower case so the browser has one token to
    // match. Substituting an empty string here would silently drop the operator's placeholder.
    if (CLIENT_VARS.includes(key)) return `{${key}}`;
    const raw = (vars ?? {})[key] ?? '';
    // Only a URL needs percent-encoding. A label or title lands in textContent/title, where encoding
    // would render "Ann%20O%E2%80%99Hara" to the user.
    return encode ? encodeURIComponent(raw).replace(/%40/g, '@') : raw;
  });
}

const menuItemAt = (ctx: TargetCtx) => (v: unknown, path: string): MenuItem => {
  if (!isObj(v)) throw new MenuConfigError(`${path} must be an object`);
  const rawLabel = typeof v.label === 'string' ? v.label.trim() : '';
  const rawUrl = typeof v.url === 'string' ? v.url.trim() : '';
  if (!rawLabel) throw new MenuConfigError(`${path} needs a label`);
  // Validate the SCHEME on the template, before substitution: a value can only ever land inside a
  // query/path, never at the front, so it cannot turn an https link into something else.
  if (!ALLOWED_SCHEME.test(rawUrl)) throw new MenuConfigError(`${path}.url must start with https:// or mailto:`);
  // The scheme is fixed by the template, but the HOST is not — `https://{fname}/x` or
  // `https://help-{fname}.example.com/x` would let a value choose the destination (and `@`, left readable
  // for mailto, can push the real host into userinfo). Values are the user's own NS fields, which a
  // domain admin controls for their users, so this is a phishing primitive. Forbid variables in the
  // authority outright: the destination must be a decision the operator made.
  if (/^https:\/\//i.test(rawUrl)) {
    const authority = rawUrl.slice('https://'.length).split(/[/?#]/)[0] ?? '';
    if (authority.includes('{')) {
      throw new MenuConfigError(`${path}.url must not use a {variable} in the host — the destination has to be fixed`);
    }
  }
  const url = interpolate(rawUrl, ctx.vars, `${path}.url`);
  const label = interpolate(rawLabel, ctx.vars, `${path}.label`, false);
  const rawTitle = typeof v.title === 'string' && v.title.trim() ? v.title.trim() : undefined;
  const title = rawTitle ? interpolate(rawTitle, ctx.vars, `${path}.title`, false) : undefined;
  return { label, url, ...(title ? { title } : {}) };
};

/** Coerce one rung's value into a validated list. A rung must be an array — `{"acme": "x"}` is a mistake. */
function rung<T>(v: unknown, path: string, item: (v: unknown, p: string) => T): T[] {
  if (!Array.isArray(v)) throw new MenuConfigError(`${path} must be an array`);
  return v.map((x, i) => item(x, `${path}[${i}]`));
}

/**
 * Resolve a TARGETED LIST for one user. Accepted forms:
 *   ["A","B"]                                  — applies everywhere
 *   {"*": [...], "acme.example": [...]}        — by domain, with a default
 *   {"app": {...}, "domains": {...}, "*": [...]} — by app state and/or domain, with a default
 *
 * `app`/`domains` are reserved keys: their presence selects the nested form. A PBX domain literally named
 * `app` or `domains` is therefore only addressable via the explicit `domains` map.
 */
export function resolveTargeted<T>(
  raw: unknown,
  ctx: TargetCtx,
  path: string,
  item: (v: unknown, p: string) => T,
): T[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return rung(raw, path, item);
  if (!isObj(raw)) throw new MenuConfigError(`${path} must be an array or an object`);

  // EAGER validation: every rung is validated, not just the one that matches this caller. Validating
  // lazily made the module's own promise false — a bad rung keyed by some other domain sailed past the
  // startup probe and then 500'd the route for exactly that domain's users, invisibly to the operator.
  // Validate all, then select.
  const validated = (map: Record<string, unknown>, label: string): Record<string, T[]> => {
    const out: Record<string, T[]> = {};
    for (const [k, v] of Object.entries(map)) out[k] = rung(v, `${label}["${k}"]`, item);
    return out;
  };
  const pickCI = (map: Record<string, T[]>, key: string): T[] | undefined => {
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    for (const k of Object.keys(map)) if (norm(k) === key) return map[k];
    return undefined;
  };

  const dom = norm(ctx.domain);
  const keyOf = (want: string): string | undefined => Object.keys(raw).find((k) => norm(k) === want);
  // Reserved-key detection is case-insensitive, like every other key match here. Exact-case detection
  // meant `{"App": {...}}` was silently read as a domain literally named "app" — a never-matching rule.
  const appKey = keyOf('app');
  const domainsKey = keyOf('domains');

  if (appKey !== undefined || domainsKey !== undefined) {
    let chosen: T[] | undefined;
    if (domainsKey !== undefined) {
      const dmap = raw[domainsKey];
      if (!isObj(dmap)) throw new MenuConfigError(`${path}.domains must be an object`);
      const v = validated(dmap, `${path}.domains`);
      chosen = pickCI(v, dom);
    }
    if (appKey !== undefined) {
      const amap = raw[appKey];
      if (!isObj(amap)) throw new MenuConfigError(`${path}.app must be an object`);
      for (const k of Object.keys(amap)) {
        const kk = norm(k);
        const known = (APP_NAMES as readonly string[]).includes(kk) || (APP_RESERVED as readonly string[]).includes(kk);
        // Loud on a typo: a silently-never-matching key is a menu that is wrong with no way to tell.
        if (!known) throw new MenuConfigError(`${path}.app has an unknown app "${k}" (known: ${[...APP_NAMES, ...APP_RESERVED].join(', ')})`);
      }
      const v = validated(amap, `${path}.app`);
      if (chosen === undefined) chosen = pickCI(v, norm(ctx.app)) ?? pickCI(v, '*');
    }
    const defKey = keyOf('*');
    const def = defKey !== undefined ? rung(raw[defKey], `${path}["*"]`, item) : undefined;
    return chosen ?? def ?? [];
  }

  // Flat form: a domain map, with an optional "*" default. Every entry is validated (see above).
  const v = validated(raw, path);
  return pickCI(v, dom) ?? pickCI(v, '*') ?? [];
}

/** Parse PORTAL_MENUS into raw per-menu config, validating menu names. Unset ⇒ `{}`. */
function rawMenus(env: MenuEnv): Record<string, { hide?: unknown; add?: unknown }> {
  const src = (env.PORTAL_MENUS ?? '').trim();
  if (!src) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(src); } catch { throw new MenuConfigError('PORTAL_MENUS is not valid JSON'); }
  if (!isObj(parsed)) throw new MenuConfigError('PORTAL_MENUS must be a JSON object keyed by menu name');
  const out: Record<string, { hide?: unknown; add?: unknown }> = {};
  for (const [name, v] of Object.entries(parsed)) {
    const n = norm(name);
    if (!(MENU_NAMES as readonly string[]).includes(n)) {
      throw new MenuConfigError(`PORTAL_MENUS has an unknown menu "${name}" (known: ${MENU_NAMES.join(', ')})`);
    }
    if (!isObj(v)) throw new MenuConfigError(`PORTAL_MENUS["${name}"] must be an object`);
    for (const k of Object.keys(v)) {
      if (k !== 'hide' && k !== 'add') throw new MenuConfigError(`PORTAL_MENUS["${name}"] has an unknown key "${k}" (known: hide, add)`);
    }
    out[n] = v as { hide?: unknown; add?: unknown };
  }
  return out;
}

/**
 * The resolved plan for every supported menu, for ONE user's domain + app state.
 *
 * `PORTAL_APPS_HIDE` remains supported as the apps-menu hide list (unchanged parsing). Setting BOTH it and
 * `PORTAL_MENUS.apps.hide` is a config ERROR rather than a precedence rule: two places to look for one
 * answer is how a menu ends up wrong with nobody able to say why.
 */
export function resolveMenus(env: MenuEnv, ctx: TargetCtx): Record<MenuName, MenuPlan> {
  const menus = rawMenus(env);
  const legacyRaw = (env.PORTAL_APPS_HIDE ?? '').trim();

  const appsCfg = menus['apps'] ?? {};
  if (legacyRaw && appsCfg.hide !== undefined) {
    throw new MenuConfigError('Both PORTAL_APPS_HIDE and PORTAL_MENUS["apps"].hide are set — use one (PORTAL_MENUS supersedes)');
  }

  const out = {} as Record<MenuName, MenuPlan>;
  for (const name of MENU_NAMES) {
    const cfg = menus[name] ?? {};
    let hide = resolveTargeted<string>(cfg.hide, ctx, `PORTAL_MENUS["${name}"].hide`, asStringItem);
    if (name === 'apps' && cfg.hide === undefined && legacyRaw) hide = legacyHide(env, ctx);
    const add = resolveTargeted<MenuItem>(cfg.add, ctx, `PORTAL_MENUS["${name}"].add`, menuItemAt(ctx));
    out[name] = { hide, add };
  }
  return out;
}

/**
 * PORTAL_APPS_HIDE, parsed by its ORIGINAL parser (`parseHideList`) rather than a second copy here. A
 * re-implementation is how one variable ends up with two subtly different meanings — trimming, duplicate
 * keys and the `*` default all had to agree exactly, and "agree exactly" is what delegation guarantees and
 * a copy only promises. The error type is re-wrapped so callers still see one menu-config error class.
 */
function legacyHide(env: MenuEnv, ctx: TargetCtx): string[] {
  try {
    return parseHideList({ PORTAL_APPS_HIDE: env.PORTAL_APPS_HIDE }, ctx.domain);
  } catch (e) {
    throw new MenuConfigError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Null when the menu config is valid (or absent); a loud, actionable message otherwise. Probed against a
 * fictional domain and each app state, so a bad rung is caught even when today's traffic never reaches it.
 */
export function menuConfigError(env: MenuEnv): string | null {
  try {
    for (const app of [...APP_NAMES, 'none']) resolveMenus(env, { domain: 'probe.example', app });
    return null;
  } catch (e) {
    if (e instanceof MenuConfigError) return `Menu config invalid: ${e.message}`;
    throw e;
  }
}
