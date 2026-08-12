/**
 * Portal menu config — static add/hide per menu, optionally conditional on which app is active.
 * Pure: config in, the resolved outcome for ONE user's domain out. No I/O, no Worker globals.
 *
 * The whole targeting model is one rule — **a default plus specific overrides** — which is why there is
 * no separate include/exclude syntax. `{"*": [x]}` changes everywhere; adding `{"acme": []}` makes it
 * "everywhere except acme"; `{"*": [], "acme": [x]}` makes it "only acme". The same holds on every axis.
 *
 * Precedence, most specific wins:  account  →  domain  →  user scope  →  app state  →  "*"
 *
 * A domain key, when present, WINS OUTRIGHT — it is not merged with the app-state list. Merging would
 * make "turn it off here" inexpressible, which is the likeliest reason to reach for an override at all.
 *
 * FAIL LOUD, not silently: an unknown menu name, an unknown app key, or a bad URL is a config error that
 * fails the whole Worker at request time. A typo'd app key must never read as "never matches".
 */

/** Loud, distinct error for bad menu config (⇒ a 500 upstream, like AppAccessConfigError). */
import { parseHideList } from './appAccess.js';
import { looksLikeAccount, KNOWN_SCOPES } from './features.js';

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
 * WHICH RUNG ANSWERED — the provenance the editor's chip renders ("default (*)", "scopes → Reseller",
 * "app → ringotel"), reported by the code that made the choice.
 *
 * It exists so a console never re-derives precedence to explain a result it was handed. The value and the
 * reason for it come from one place or they drift, and the half that drifted would be the one telling an
 * operator whose menu they are looking at.
 *
 * `axis: 'all'` is the untargeted flat form, which applies to everyone unconditionally. `key` is the key
 * AS WRITTEN, not normalized, so the chip shows the operator their own spelling.
 */
export type MenuAxis = 'users' | 'domains' | 'scopes' | 'app' | '*' | 'all';
export interface MenuSource { axis: MenuAxis; key: string }
/**
 * A sink for {@link MenuSource}, passed by callers that want the provenance.
 *
 * PLURAL since the app axis became a union tier: a both-active half legitimately answers from two app
 * rungs, and the editor's chip has to name both. Identity axes still contribute exactly one, so the list
 * is length 0 or 1 for everything except the app tier.
 */
export interface SourceOut { sources: MenuSource[] }

/**
 * Menus we support by NAME. Operators never supply a selector — that would hand a DOM-injection surface to
 * whoever can set env vars, and it would break on every portal update. Adding a name is a code change:
 *   apps       — the portal's Apps dropdown (`ul#app-menu-list`)
 *   account    — the user's own name dropdown in the toolbar (My Account / Profile / Messages / Log Out).
 *                It has NO id and shares a generic Bootstrap class, so the client identifies it by content.
 *   management — the top-nav Management dropdown, present for administrative scopes only. Its toggle
 *                carries no id and no href, so it is found by the toggle's own LABEL — which means a
 *                portal that renames it will simply not match (nothing breaks; the entry is absent).
 *                Entries are appended at the END, since this menu has no trailing sign-out to sit above.
 */
/**
 * STOCK ENTRIES THE PORTAL SHOWS ONLY TO SOME SCOPES — label → the lowest LEVEL that sees it.
 *
 * The console's stock list is ONE session's DOM, read as whoever opened it. Preview a lower scope and the
 * picture still carries entries that reader would never see, which is confusing in a specific way: it
 * invites a hide rule for something that is not there. This is the cheap half of the fix; the correct one
 * is observe-and-cache (capture each persona's real menu by masquerading once), which is designed and not
 * built.
 *
 * ⚠️ CURATED, therefore INCOMPLETE, and only ever subtracts. It cannot know what a lower scope sees that
 * this session does not, and it must never silently drop a row: the console names what it withheld. Keyed
 * by the exact stock label, normalized; the levels are `features.ts` LEVEL_SCOPES so there is one
 * ordering of scopes in this codebase and not two.
 *
 * Add an entry only when you have SEEN the portal withhold it — a guess here removes a row an operator
 * needs, which is the failure this list exists to prevent, pointed the other way.
 *
 * ⚠️ AND ONLY WHAT EVERY DEPLOYMENT SEES. This file is published, so a label here is a label told to
 * everyone — which rules out anything a particular portal's add-on contributes, however true it is of
 * ours. That is not a hypothetical: the entry this table shipped with was one, and the leak guard is what
 * caught it. Deployment-specific entries have a home already, and a better one: **capture the role**. The
 * capture is a reading rather than a guess, it needs no code change, and it never leaves the browser.
 */
export const STOCK_SCOPE_FLOOR: Record<string, string> = {
  // The account menu relabels itself by CONTEXT — `My Account` while managing a domain or organisation,
  // `Profile` inside your own account — and a user with nothing to manage is only ever in the second row.
  // Stock NetSapiens behaviour, documented in CONFIG.md under PORTAL_MENUS, and true wherever this runs.
  // `site_manager` rather than `office_manager` because it is the conservative read: a Site Manager
  // manages something, so withholding from them would be the guess this table must not make.
  'my account': 'site_manager',
};

export const MENU_NAMES = ['apps', 'account', 'management'] as const;
export type MenuName = (typeof MENU_NAMES)[number];

/**
 * App providers, in REGISTRY ORDER — which becomes load-bearing the day there are two (see below).
 *
 * ⚠️ "Never a new branch in the targeting logic" was true while at most one app can be active, and only
 * then. `app` is a select-one axis today because its keys are mutually exclusive the way a scope or a
 * domain is: you have one. A second integration breaks that — "ringotel active" and "documo active" are
 * INDEPENDENT conditions that can both hold of one domain — and select-one would then pick an arbitrary
 * winner between two rungs that each legitimately own their entries, silently dropping the loser's.
 *
 * BUILT 2026-08-10, when `documo` was registered — which is what made it testable. With one app the two
 * semantics are indistinguishable on every expressible config, so the backward-compat assertion could not
 * fail; with two, it can, and it does real work:
 *
 *   - The app axis becomes a UNION tier: every rung whose app is in the active set contributes, and their
 *     lists merge. Hides union commutatively (see `unionLabels`, which already does exactly this for the
 *     two apps-menu hide settings); adds concatenate in REGISTRY ORDER, which is what makes the merge
 *     deterministic and is why this list's order matters.
 *   - Identity axes (`users`, `domains`, `scopes`) stay SELECT-ONE and still win outright over the whole
 *     app tier, so a domain rung remains the "turn it off here" tool.
 *   - `none` matches exactly when the active set is empty. The in-axis `*` and the whole-object default
 *     fire only when NO app rung matched any active app — a default must never beat a rule that names
 *     you, and under union "names you" means at least one match.
 *   - An empty app rung then means "this app contributes nothing", NOT "this audience gets nothing". The
 *     exemption idiom moves to the identity axes, where it still works.
 *
 * ⚠️ EACH REGISTRATION SUPPLIES TWO PREDICATES, and neither derives from the other:
 *
 *   - **active for this domain** — does this domain have it? (`documoEnabled`; for ringotel, an org.)
 *   - **available on this deployment** — could any domain here have it? (`appAvailable`.)
 *
 * The second was implicit until 2026-08-10 and is a different question: ringotel is available when the API
 * key is set and active only where an org exists, so it is routinely available-but-active-nowhere. The
 * console needs the second to decide whether to offer an app in the preview picker at all — inferring it
 * from usage deadlocks (no toggle ⇒ no rung ⇒ nothing names it ⇒ no toggle), and inferring it from vendor
 * presence is noise on a deployment nobody asked.
 *
 * Where the config is a domain list, the shape is absent/empty/value — the same three states
 * `PORTAL_HANDOFF_URL` uses. ABSENT means not available; PRESENT BUT EMPTY means available and enabled
 * nowhere, which is a deliberate "I am planning this" that lets the menus be designed first; a list means
 * enabled on those. A fourth app should implement both predicates at registration rather than discovering
 * the second as a UI bug.
 *
 * `documo` is registered with a STUB driver (`documoEnabled`, reading `DOCUMO_DOMAINS`) rather than a
 * live signal — deliberately the real seam and not a bypass, so the integration replaces the stub's body
 * and nothing else moves. It answers false wherever the var is unset, so outside dev the active set never
 * reaches two and union-over-at-most-one IS select-one. An inert `documo` rung in a config is
 * ahead-of-launch config, not breakage — and because the editor previews against the ASKED-FOR context
 * rather than live state, that config can be written and previewed before the integration exists.
 *
 * Two things the format still cannot say, recorded together because they are deferred on the same
 * grounds — add them if real demand appears, not in anticipation of it:
 *   - CONJUNCTIONS: "Documo active AND Office Manager" is not expressible. Targeting is by one axis.
 *   - NEGATIVES: "where ringotel is NOT active" has no spelling. `none` means no app at all, so it stops
 *     firing the moment any other integration is live on that domain.
 */
export const APP_NAMES = ['ringotel', 'documo'] as const;
/** Reserved app-axis keys: no app active, and the any-state default. */
export const APP_RESERVED = ['none', '*'] as const;

/**
 * Is Documo active for this domain?
 *
 * ⚠️ A STUB, and deliberately the real seam rather than a bypass. The integration does not exist yet, so
 * the answer comes from operator config — a comma-separated domain list, the same shape
 * `RINGOTEL_WRITE_DOMAINS` uses — and not from a fake wired into the resolver. When the live signal
 * exists, THIS FUNCTION'S BODY is what changes; the targeting logic above never learns the difference.
 *
 * It answers false wherever the var is unset, which is what keeps the union inert outside dev: with at
 * most one app active the union takes at most one rung, and union-over-one IS select-one. An unset var in
 * production therefore cannot change a single resolution. A `documo` rung written before launch is
 * ahead-of-launch config, not breakage — and since the editor previews against the ASKED-FOR context
 * rather than live state, that config can be authored and previewed now.
 */
export function documoEnabled(env: MenuEnv, domain: string): boolean {
  const list = (env.DOCUMO_DOMAINS ?? '').trim();
  if (!list) return false;
  // Parsed with THIS module's own `norm`, which is what the `domains` axis already means by a domain —
  // trim and lowercase, comma-separated, `*` for all. That is the same shape the Ringotel write rail
  // uses, and the agreement is asserted in the tests rather than assumed: two settings that both name
  // domains must not disagree about what a domain is, and a copy only promises what delegation
  // guarantees. Delegating here would mean menus.ts importing the eligibility module for a five-token
  // parse — a module edge for less than the test costs.
  const d = norm(domain);
  return list.split(',').map((x) => norm(x)).filter(Boolean).some((x) => x === '*' || x === d);
}

/**
 * Could any domain on this deployment have this app? See the two-predicate contract on {@link APP_NAMES}.
 *
 * NOT derivable from {@link activeApps}: an app can be available and active nowhere, which is precisely
 * the state in which an operator wants to design its menus. Absent ⇒ unavailable; present-but-empty ⇒
 * available and enabled nowhere; a value ⇒ available.
 */
export function appAvailable(env: MenuEnv, app: string): boolean {
  const name = norm(app);
  if (name === 'ringotel') return !!(env.RINGOTEL_API_KEY ?? '').trim();
  if (name === 'documo') return env.DOCUMO_DOMAINS !== undefined;
  return false;
}

/** Every registered app this deployment could ever run — what the preview picker offers. */
export function availableApps(env: MenuEnv): string[] {
  return APP_NAMES.filter((a) => appAvailable(env, a));
}

/** The apps active for one domain — the ctx the `app` axis matches against. One place decides this, so a
 *  new integration is a line here plus its own predicate, exactly as APP_NAMES' contract says. */
export function activeApps(env: MenuEnv, domain: string, ringotelActive: boolean): string[] {
  const out: string[] = [];
  if (ringotelActive) out.push('ringotel');
  if (documoEnabled(env, domain)) out.push('documo');
  return out;
}

export interface MenuEnv {
  PORTAL_MENUS?: string;
  /** Presence alone marks the app integration AVAILABLE here — see `appAvailable`. */
  RINGOTEL_API_KEY?: string;
  /** Domains to treat as Documo-active until the integration ships — see {@link documoEnabled}. */
  DOCUMO_DOMAINS?: string;
  PORTAL_APPS_HIDE?: string;
}

/** Which app is active for the domain being resolved (`'none'` when nothing is). */
export type AppState = string;

/** Which apps are active for this domain, in no particular order — the set the `app` axis matches
 *  against. Empty ⇒ the `none` key matches. Was a single string until 2026-08-10; two integrations can be
 *  active at once and a scalar had to pick a winner between rungs that each legitimately own their
 *  entries. */
export type ActiveApps = readonly string[];

export interface TargetCtx {
  domain: string;
  /** The apps active for this domain. A bare string is accepted and read as a one-element set, so every
   *  existing caller and config keeps working; `''`/`'none'` mean the empty set. */
  app: AppState | ActiveApps;
  /**
   * This user's EFFECTIVE NS scope (the masked user's when masquerading, like every other authz decision
   * here), for the `scopes` axis. Absent ⇒ no scope rung can match; the rule falls through as if unlisted.
   */
  scope?: string;
  /**
   * This user's EFFECTIVE account id (`user@domain`), for the `users` axis. Effective, not the operator's,
   * for the same reason `scope` is: while masquerading, every other authz decision here is made as the
   * masked user, and a menu rule that followed the operator instead would show one person's entries to
   * another. Absent ⇒ no user rung can match, and the rule falls through as if the account were unlisted.
   */
  user?: string;
  /** This user's own facts, for `{var}` substitution in add entries. Absent ⇒ variables resolve empty. */
  vars?: Record<string, string>;
}

/**
 * Canonical form for scope matching: case- and separator-insensitive, so `Office Manager`,
 * `office_manager` and `officeManager` are one key. It also collapses the interchangeable Super User
 * spellings a NetSapiens core may emit ("Super User" / "superuser" / "super-user"), the same unification
 * the policy engine does — a rule written with one spelling must match a token carrying another.
 */
const normScope = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
const KNOWN_SCOPE_KEYS = new Set(KNOWN_SCOPES.map(normScope));

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const norm = (s: string): string => s.trim().toLowerCase();

/** The active set from a ctx that may carry either spelling. `none` and the empty string are the EMPTY
 *  set — `none` is the config's way of writing "no apps active", so accepting it here means a caller that
 *  already passed a single `'none'` keeps working unchanged. */
function activeSet(app: AppState | ActiveApps): string[] {
  const list = Array.isArray(app) ? (app as readonly string[]) : [app as string];
  return list.map((a) => norm(a)).filter((a) => a && a !== 'none');
}

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
 * What each placeholder fills in, in the words an operator would use — so the editor can offer them at
 * the point they are typed rather than only in a reference file nobody opens mid-edit.
 *
 * ⚠️ This is a SECOND copy of the table in `CONFIG.public.md`, and the only honest reason is that the
 * console cannot read markdown. `statusModel.selftest.ts` asserts every key here appears in that table,
 * so the copy cannot quietly diverge — which is the failure a duplicated list actually has. The reference
 * stays the long-form answer (encoding, the host ban, who can interpolate whom); this is the reminder.
 */
export const MENU_VAR_HELP: Record<MenuVar, string> = {
  ext: 'their extension',
  domain: 'their PBX domain',
  email: 'their email address',
  fname: 'first name',
  lname: 'last name',
  name: 'display name',
  page: 'the portal page they are on when they click',
};

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

/**
 * THE SAME ENTRY, TWICE: as the reader gets it, and as the operator WROTE it.
 *
 * `menuItemAt` interpolates `{variable}` placeholders, so the url in a resolved plan is not the url in the
 * config — and the preview resolves with no user facts, which renders every server-side placeholder to the
 * empty string. An editor that matched a drawn row back to its config entry by url therefore failed on
 * exactly the entries that use the feature, and reported them as "not editable here".
 *
 * Both halves are produced in ONE pass and merged on ONE identity, so they are index-aligned BY
 * CONSTRUCTION. Resolving twice and zipping the results would not be: the dedupe key differs between the
 * template and the substitution, so two entries that differ as templates and coincide once substituted
 * would shift every index after them.
 */
interface MenuItemPair { it: MenuItem; raw: MenuItem }
const menuItemPairAt = (ctx: TargetCtx) => (v: unknown, path: string): MenuItemPair => {
  const it = menuItemAt(ctx)(v, path);
  const o = v as Record<string, unknown>;
  const label = String(o.label ?? '').trim();
  const url = String(o.url ?? '').trim();
  const rawTitle = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : undefined;
  return { it, raw: { label, url, ...(rawTitle ? { title: rawTitle } : {}) } };
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
 *   {"app": {...}, "domains": {...}, "scopes": {...}, "*": [...]} — by any axis, with a default
 *
 * `app`/`domains`/`scopes` are reserved keys: their presence selects the nested form. A PBX domain
 * literally named `app`, `domains` or `scopes` is therefore only addressable via the explicit `domains`
 * map.
 *
 * **The `scopes` axis matches ONE scope exactly — it does not nest.** This is the opposite of the feature
 * levels in `features.ts`, where `office_manager` deliberately means "Office Manager and everyone above".
 * Nesting is what makes "office managers but NOT resellers" inexpressible there, and expressing exactly
 * that is why this axis exists: `{"scopes": {"Reseller": []}, "*": [x]}`.
 *
 * Selection order: an EXACT match on the most specific axis wins (domain → scope → app); if no axis
 * matches exactly, an in-axis `"*"` does (same order); then the top-level `"*"`; then nothing.
 */
export function resolveTargeted<T>(
  raw: unknown,
  ctx: TargetCtx,
  path: string,
  item: (v: unknown, p: string) => T,
  /** Optional provenance sink — written with the rung(s) that answered. Purely additive. */
  out?: SourceOut,
  /** How two or more app rungs combine, when more than one app is active. Supplied by the caller because
   *  the two item kinds have different merge identities and this function cannot know which it holds:
   *  hides are LABELS and idempotent, so they union; adds are records that exist because of a particular
   *  integration, so they concatenate in registry order. Defaults to concatenation. */
  merge: (lists: T[][]) => T[] = (lists) => lists.flat(),
): T[] {
  const took = (axis: MenuAxis, key: string): void => { if (out) out.sources = [{ axis, key }]; };
  if (out) out.sources = [];
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) { took('all', '*'); return rung(raw, path, item); }
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
  const pickCIKey = (map: Record<string, T[]>, key: string): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(map, key)) return key;
    for (const k of Object.keys(map)) if (norm(k) === key) return k;
    return undefined;
  };
  const pickCI = (map: Record<string, T[]>, key: string): T[] | undefined => {
    const k = pickCIKey(map, key);
    return k === undefined ? undefined : map[k];
  };

  const dom = norm(ctx.domain);
  const keyOf = (want: string): string | undefined => Object.keys(raw).find((k) => norm(k) === want);
  // Reserved-key detection is case-insensitive, like every other key match here. Exact-case detection
  // meant `{"App": {...}}` was silently read as a domain literally named "app" — a never-matching rule.
  const appKey = keyOf('app');
  const domainsKey = keyOf('domains');
  const scopesKey = keyOf('scopes');
  const usersKey = keyOf('users');

  if (appKey !== undefined || domainsKey !== undefined || scopesKey !== undefined || usersKey !== undefined) {
    let chosen: T[] | undefined;
    // The source of whichever of the three the join below takes. Recorded WHERE the choice is made, not
    // re-derived after it: a second reading of "which rung won" is the drift this whole sink exists to
    // avoid, and it would be a copy of the very logic it describes. Plural because the app tier can take
    // more than one rung; every other axis fills exactly one.
    let chosenSrc: MenuSource[] = [];
    let defaultSrc: MenuSource[] = [];
    // An in-axis "*", from the most specific axis that carries one. Held back until every axis has had a
    // chance at an EXACT match, so `{"scopes":{"*":[a]},"app":{"ringotel":[b]}}` gives an app-active user
    // `b` — a star is a default, and a default must never beat a rule that actually names you.
    let axisDefault: T[] | undefined;
    // USERS FIRST — it is the most specific axis there is. A rule naming your account must beat one naming
    // your domain, or naming an account could never carve an exception out of a domain-wide rule, which is
    // the only reason to name one.
    if (usersKey !== undefined) {
      const umap = raw[usersKey];
      if (!isObj(umap)) throw new MenuConfigError(`${path}.users must be an object`);
      for (const k of Object.keys(umap)) {
        // Loud on a non-account, exactly like the scope and app axes: a key that can never match is a rule
        // that is silently absent for everyone. Same predicate PORTAL_SUPERADMINS uses, imported rather
        // than re-written — three settings that name accounts must agree on what an account is.
        if (k.trim() !== '*' && !looksLikeAccount(k.trim())) {
          throw new MenuConfigError(`${path}.users has an entry that is not a user@domain: "${k}"`);
        }
      }
      const v = validated(umap, `${path}.users`);
      const me = norm(ctx.user ?? '');
      if (me) { const k = pickCIKey(v, me); if (k !== undefined) { chosen = v[k]; chosenSrc = [{ axis: 'users', key: k }]; } }
      if (axisDefault === undefined) { const k = pickCIKey(v, '*'); if (k !== undefined) { axisDefault = v[k]; defaultSrc = [{ axis: 'users', key: k }]; } }
    }
    if (chosen === undefined && domainsKey !== undefined) {
      const dmap = raw[domainsKey];
      if (!isObj(dmap)) throw new MenuConfigError(`${path}.domains must be an object`);
      const v = validated(dmap, `${path}.domains`);
      { const k = pickCIKey(v, dom); if (k !== undefined) { chosen = v[k]; chosenSrc = [{ axis: 'domains', key: k }]; } }
      // The in-axis default, which this axis alone used to omit. `users`, `scopes` and `app` all pick up
      // their own `"*"`; `domains` did not, so `{"domains":{"*":["A"],"acme.example":[]}}` -- the exact
      // "change everywhere except some" shape this file's own contract documents, and the console teaches
      // -- validated green and then matched nothing anywhere. A rule that silently never fires is the
      // failure mode every other axis here throws to prevent.
      if (axisDefault === undefined) { const k = pickCIKey(v, '*'); if (k !== undefined) { axisDefault = v[k]; defaultSrc = [{ axis: 'domains', key: k }]; } }
    }
    if (scopesKey !== undefined) {
      const smap = raw[scopesKey];
      if (!isObj(smap)) throw new MenuConfigError(`${path}.scopes must be an object`);
      for (const k of Object.keys(smap)) {
        // `normScope` strips punctuation, so the wildcard has to be recognized BEFORE normalizing —
        // otherwise "*" normalizes to the empty string and reads as an unknown scope.
        const kk = normScope(k);
        // Loud on a typo, exactly like the app axis: `{"Office Mgr": []}` that silently never matches is
        // a menu that is wrong for someone with nothing anywhere to say why.
        if (k.trim() !== '*' && !KNOWN_SCOPE_KEYS.has(kk)) {
          throw new MenuConfigError(`${path}.scopes has an unknown scope "${k}" (known: ${KNOWN_SCOPES.join(', ')})`);
        }
      }
      const v = validated(smap, `${path}.scopes`);
      const mine = ctx.scope ? normScope(ctx.scope) : '';
      if (chosen === undefined && mine) {
        for (const k of Object.keys(v)) if (normScope(k) === mine) { chosen = v[k]; chosenSrc = [{ axis: 'scopes', key: k }]; break; }
      }
      if (axisDefault === undefined) { const k = pickCIKey(v, '*'); if (k !== undefined) { axisDefault = v[k]; defaultSrc = [{ axis: 'scopes', key: k }]; } }
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
      // THE UNION TIER. Every rung whose app is active contributes; their lists merge. The identity axes
      // above stay select-one and still win outright over this whole block, so a domain rung remains the
      // "turn it off here" tool.
      //
      // Walked in APP_NAMES order rather than in the config's key order, so the merge is a function of the
      // registry and not of how the operator happened to type their JSON — two configs that say the same
      // thing must resolve the same way.
      //
      // ⚠️ AN EMPTY RUNG HERE MEANS "this app contributes nothing", NOT "this audience gets nothing". The
      // exemption idiom moved to the identity axes when this became a union, because `{ringotel: [],
      // documo: [x]}` on a both-active domain yields `[x]` — there is no way to say "both active, show
      // nothing" within the axis, and a domain or scope rung is how you say it instead.
      if (chosen === undefined) {
        const active = activeSet(ctx.app);
        const hits: T[][] = [];
        for (const name of APP_NAMES) {
          if (!active.includes(name)) continue;
          const k = pickCIKey(v, name);
          if (k !== undefined) { hits.push(v[k]!); chosenSrc.push({ axis: 'app', key: k }); }
        }
        // `none` matches exactly when the active set is EMPTY — it is a rung like any other, not a default.
        if (!active.length) {
          const k = pickCIKey(v, 'none');
          if (k !== undefined) { hits.push(v[k]!); chosenSrc.push({ axis: 'app', key: k }); }
        }
        if (hits.length) chosen = hits.length === 1 ? hits[0]! : merge(hits);
      }
      // The in-axis default fires only when NO app rung matched ANY active app — a default must never beat
      // a rule that names you, and under union "names you" means at least one match.
      if (axisDefault === undefined) { const k = pickCIKey(v, '*'); if (k !== undefined) { axisDefault = v[k]; defaultSrc = [{ axis: 'app', key: k }]; } }
    }
    const defKey = keyOf('*');
    const def = defKey !== undefined ? rung(raw[defKey], `${path}["*"]`, item) : undefined;
    // The join, and the one place that knows which of the three it took. An EMPTY list with a non-null
    // source is the exemption idiom ("these people get nothing"); an empty list with a null source is
    // "nothing matched at all". The editor renders those differently, so they must be distinguishable.
    if (chosen !== undefined) { if (out) out.sources = chosenSrc; return chosen; }
    if (axisDefault !== undefined) { if (out) out.sources = defaultSrc; return axisDefault; }
    if (def !== undefined) { took('*', defKey!); return def; }
    return [];
  }

  // Flat form: a domain map, with an optional "*" default. Every entry is validated (see above).
  const v = validated(raw, path);
  const dk = pickCIKey(v, dom);
  if (dk !== undefined) { took('domains', dk); return v[dk]!; }
  const sk = pickCIKey(v, '*');
  if (sk !== undefined) { took('*', sk); return v[sk]!; }
  return [];
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
 * Where each entry of the apps-menu hide list came from. Exists so the console can show one effective list
 * and still say which setting contributed each label — which is what makes two settings safe rather than
 * confusing. The union below is only defensible because this exists.
 */
export interface AppsHideSources {
  /** Labels from `PORTAL_APPS_HIDE`, in its own parser's order. */
  legacy: string[];
  /** Labels from `PORTAL_MENUS["apps"].hide`, after targeting resolution. */
  menus: string[];
  /** The effective list: the union, first-seen order, case-insensitively de-duplicated. */
  effective: string[];
}

/** Case-insensitive union preserving first-seen order and the first spelling seen. Hiding is idempotent
 *  and commutative, so a union is the only merge of two hide lists with no order dependence. */
function unionLabels(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const label of list) {
      const k = label.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(label);
    }
  }
  return out;
}

/**
 * The two apps-menu hide settings, separately and merged, for one user.
 *
 * Setting both used to be a fatal config error, on the reasoning that two places to look for one answer is
 * how a menu ends up wrong with nobody able to say why. The reasoning was right about the risk and wrong
 * about the remedy: the cost fell on the wrong thing entirely. `menuConfigError` runs in the pre-routing
 * gauntlet, so two overlapping cosmetic settings took down every route except `/health` and the console —
 * the injected primary included — and the whole portal add-on went dark for every user. A hide list is the
 * least consequential config this kit has, and it had the largest blast radius of any of them.
 *
 * The remedy that actually addresses the risk is to make the answer VISIBLE rather than to make the
 * combination illegal: one effective list, with provenance, on the console. Precedence was the other
 * candidate and is worse — it silently discards a setting the operator wrote, which is the failure mode
 * that is hardest to debug and the one this repo has been bitten by before.
 */
export function appsHideSources(env: MenuEnv, ctx: TargetCtx, out?: SourceOut): AppsHideSources {
  const cfg = rawMenus(env)['apps'] ?? {};
  const legacy = (env.PORTAL_APPS_HIDE ?? '').trim() ? legacyHide(env, ctx) : [];
  const menus = resolveTargeted<string>(cfg.hide, ctx, 'PORTAL_MENUS["apps"].hide', asStringItem, out, mergeHides);
  return { legacy, menus, effective: unionLabels(menus, legacy) };
}

/**
 * True when both apps-menu hide settings carry a value — not an error, but worth reporting once.
 *
 * TOTAL, deliberately: `setupIssues` calls this, and `setupIssues` is the function whose whole job is to
 * REPORT what is wrong with a deployment. A reporting predicate that throws takes down the page that would
 * have shown the problem — this one did, for a few minutes, on a deployment with malformed `PORTAL_MENUS`,
 * which is precisely the deployment that needs the checklist to render. An unparseable value cannot be
 * "both set", and `menuConfigError` reports the malformed JSON itself, loudly and at the right layer.
 */
export function bothAppsHideSet(env: MenuEnv): boolean {
  if (!(env.PORTAL_APPS_HIDE ?? '').trim()) return false;
  try {
    return (rawMenus(env)['apps'] ?? {}).hide !== undefined;
  } catch {
    return false;
  }
}

/** Hides from two active apps MERGE as a set: hiding is idempotent and commutative, so order cannot
 *  matter and a duplicate label is not a second instruction. The same `unionLabels` the two apps-menu
 *  hide settings already share, for the same reason. */
const mergeHides = (lists: string[][]): string[] => unionLabels(...lists);
/**
 * Adds CONCATENATE, in the registry order `resolveTargeted` walks — each app's rung holds entries that
 * exist because of that integration, so none is redundant with another's.
 *
 * DE-DUPLICATED BY URL, and that is a decision rather than an inherited accident. `menuApply` already
 * drops a repeated URL client-side, so listing one entry under two apps was never going to draw twice in
 * the portal — but the resolved PLAN would have carried both, and the console's preview renders the plan.
 * The preview would then show a doubled row the live menu does not have, which is the preview lying about
 * the thing it exists to show. Deduping here puts the rule where the plan is made, so preview and portal
 * agree by construction instead of by two implementations happening to match.
 *
 * First spelling wins, like `unionLabels`. Provenance still reports BOTH rungs — the operator asked for
 * the entry twice and both rules are real, even though one entry is drawn.
 */
const mergeAdds = (lists: MenuItemPair[][]): MenuItemPair[] => {
  const seen = new Set<string>();
  const out: MenuItemPair[] = [];
  for (const list of lists) {
    for (const p of list) {
      // Deduped on the RESOLVED url, because that is what the portal would draw twice. The raw half
      // rides along on the pair, so the two lists cannot fall out of step.
      const k = norm(p.it.url);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out;
};

/**
 * The resolved plan for every supported menu, for ONE user's domain + scope + app state.
 *
 * Hides and adds are two independent lists, and the client applies them in that order — see `menuApply` in
 * `kit.ts`. That order is the contract: a hide names a STOCK entry, so it can never remove one of this
 * config's own additions, and neither list's meaning depends on the other.
 */
export function resolveMenus(
  env: MenuEnv,
  ctx: TargetCtx,
  /**
   * Optional provenance sink — which rung answered each half, for a caller that has to EXPLAIN the plan
   * rather than apply it. `MenuPlan` deliberately does not carry it: the appliers in the injected bundle
   * never need it and should not pay bytes for it, and the console is the only caller that does.
   *
   * ARRAYS, with 0 or 1 entry today. The app axis is select-one only because at most one app can be
   * active; a second integration makes "ringotel active" and "documo active" independent conditions that
   * can both hold, at which point a half's list legitimately comes from more than one app rung. Plural
   * now is free; plural later is a breaking change to a shape the editor already consumes.
   */
  sources?: Record<MenuName, { hide: MenuSource[]; add: MenuSource[] }>,
  /**
   * Optional sink for the added entries AS WRITTEN — same list, same order, `{variable}` placeholders
   * intact. Only the console asks for it, and only because a resolved url is not a config url: it is the
   * stable identity for "which entry in my config produced this drawn row". Index-aligned with
   * `plan.add` by construction (see {@link MenuItemPair}), never by a second resolve.
   */
  rawAdds?: Record<MenuName, MenuItem[]>,
): Record<MenuName, MenuPlan> {
  const menus = rawMenus(env);

  const out = {} as Record<MenuName, MenuPlan>;
  for (const name of MENU_NAMES) {
    const cfg = menus[name] ?? {};
    const hs: SourceOut = { sources: [] };
    const as: SourceOut = { sources: [] };
    // The apps menu has two hide settings and they MERGE — see appsHideSources. Every other menu has one.
    // Its provenance is the PORTAL_MENUS half only; the legacy half is reported separately by
    // appsHideSources, because they are two settings and an operator fixes them in different places.
    const hide = name === 'apps'
      ? appsHideSources(env, ctx, hs).effective
      : resolveTargeted<string>(cfg.hide, ctx, `PORTAL_MENUS["${name}"].hide`, asStringItem, hs, mergeHides);
    const pairs = resolveTargeted<MenuItemPair>(cfg.add, ctx, `PORTAL_MENUS["${name}"].add`, menuItemPairAt(ctx), as, mergeAdds);
    out[name] = { hide, add: pairs.map((p) => p.it) };
    if (sources) sources[name] = { hide: hs.sources, add: as.sources };
    if (rawAdds) rawAdds[name] = pairs.map((p) => p.raw);
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
 * ENTRIES THAT REACH NOBODY — reported, never refused.
 *
 * A default fires only when no rung matched, so once an axis covers its whole value space the default is
 * dead: `{app: {ringotel: […], documo: […], none: […]}, "*": […]}` has a rung for every domain that can
 * exist, and the `*` list is config that will never be applied to anyone. David built exactly that, group
 * by group, and lost two entries fleet-wide without a word from anywhere.
 *
 * General reachability needs to know which domains exist and is undecidable from config. THESE two are
 * not: the app axis's value space is `APP_NAMES` + `none`, and the scope axis's is `KNOWN_SCOPES`, both
 * closed and known at compile time. So "this axis covers everything, therefore the default below it is
 * unreachable" is a static fact about the config alone — the same class of silently-never-fires the
 * unknown-key checks already throw for, differing only in being dead by COVERAGE rather than by typo.
 *
 * ⚠️ ITS BLIND SPOT, AND THE DIRECTION IS CHOSEN. Computed from config alone, it uses the FULL app
 * vocabulary — so a config naming `ringotel` + `none` on a deployment where documo is unavailable does
 * cover every state that can occur there, and this will still call the `*` reachable. A missed warning,
 * never a false alarm, and that is the right way round: folding availability in would make one candidate
 * config warn on one deployment and not another, which breaks the portability of the answer the check
 * route hands back. Do not "fix" this into a deployment-dependent warning.
 *
 * ⚠️ AND YET IT DOES NOT THROW, deliberately. `menuConfigError` runs in the pre-routing gauntlet, and the
 * last time a cosmetic menu mistake was made fatal there it took down every route including the injected
 * primary — see `bothAppsHideSet`, whose comment records the lesson: make the answer VISIBLE rather than
 * make the combination illegal. Dead config is not wrong behaviour, and refusing to boot over it would
 * repeat precisely the mistake that comment exists to prevent. It is surfaced where the operator is
 * editing instead.
 */
export function unreachableDefaults(env: MenuEnv): string[] {
  const out: string[] = [];
  let menus: Record<string, { hide?: unknown; add?: unknown }>;
  try { menus = rawMenus(env); } catch { return out; } // invalid config is menuConfigError's to report
  const closed: Record<string, string[]> = {
    app: [...APP_NAMES, 'none'],
    scopes: KNOWN_SCOPES.map((x) => normScope(x)),
  };
  for (const [name, cfg] of Object.entries(menus)) {
    for (const half of ['hide', 'add'] as const) {
      const raw = cfg[half];
      if (!isObj(raw)) continue;
      const keys = Object.keys(raw);
      const hasTopDefault = keys.some((k) => k.trim() === '*');
      for (const [axis, space] of Object.entries(closed)) {
        const axisKey = keys.find((k) => norm(k) === axis);
        if (axisKey === undefined) continue;
        const m = raw[axisKey];
        if (!isObj(m)) continue;
        const present = Object.keys(m).map((k) => (axis === 'scopes' ? normScope(k) : norm(k)));
        if (present.includes('*')) continue;            // an in-axis star is itself the catch-all
        const missing = space.filter((v) => !present.includes(v));
        if (missing.length) continue;                    // something still falls through — default lives
        if (!hasTopDefault) continue;                    // nothing to strand
        out.push(`PORTAL_MENUS["${name}"].${half} names every ${axis === 'app' ? 'app state' : 'scope'} `
          + `(${present.join(', ')}), so its "*" default can never apply to anyone — those entries reach `
          + `nobody. Put them in each group that should have them, or remove a group so some readers fall `
          + `through.`);
      }
    }
  }
  return out;
}

/**
 * Null when the menu config is valid (or absent); a loud, actionable message otherwise.
 *
 * ⚠️ THE SWEEP IS NOT WHAT PROVIDES COVERAGE — eager validation is. `resolveTargeted` validates every rung
 * of every axis on ANY resolution, not just the one that matches, so a single probe would catch every bad
 * rung and an unknown key is rejected whether or not it matches the caller. That mattered when the app
 * axis became a UNION tier: its state space stopped being a list of values and became the SUBSETS of the
 * registry, which no sweep could enumerate without going exponential. It does not need to. The loop below
 * is kept because it also exercises the join cheaply, not because coverage depends on it.
 */
export function menuConfigError(env: MenuEnv): string | null {
  try {
    // A probe ACCOUNT as well as a probe domain: without one, a `users` rung would never be exercised by
    // the startup check, and a malformed key there would sail past exactly the way an unvalidated app key
    // used to. Eager validation inside resolveTargeted does the work — the probe just has to reach it.
    for (const app of [...APP_NAMES, 'none']) resolveMenus(env, { domain: 'probe.example', app, user: 'probe@probe.example' });
    return null;
  } catch (e) {
    if (e instanceof MenuConfigError) return `Menu config invalid: ${e.message}`;
    throw e;
  }
}
