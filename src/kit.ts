/**
 * Worker-served Manager-Portal injection: the neutral public PRIMARY bootstrap, the per-tier
 * policy-generated gated BUNDLE, and the pluggable SECONDARY-injection manifest.
 *
 * VENDOR-NEUTRAL + MIRROR-BOUND. This file is client-visible (served to browsers) AND it reaches the
 * public `ns-portal-kit` mirror. So it obeys the injection repo's rules:
 *   - terse, non-informative; NO backend-describing comments; NO customer data, host, label, filename,
 *     or vendor URL baked in source. Every deployment-specific value (basename, handoff URL, manifest,
 *     labels) arrives at runtime from `env` (the private `wrangler.jsonc`), NEVER as a literal here.
 *   - the served PRIMARY is PUBLIC (no auth, cache-in-front). It must NOT embed anything sensitive —
 *     in particular the white-label label/name lives ONLY in the gated bundle, behind auth.
 *
 * Levels (secondary auth) and features (bundle contents) resolve through the SAME level vocabulary the
 * data routes use (src/features.ts `resolveGate` → the policy engine). Everything fails closed: an
 * unknown level/scope ⇒ deny.
 */
import { isAllowed, type Principal } from '@dszp/netsapiens-lib';
import { resolveGate, FeaturesConfigError, type Gate } from './features.js';
import { parseDownloads } from './appAccess.js';
import { VERSION, productName, releaseNotesUrl } from './brand.js';
import { SPK_BRIDGE } from './spkBridge.js';

/** The subset of the Worker `Env` the kit helpers read. Structural, so worker.ts's `Env` satisfies it. */
export interface KitEnv {
  /** Public primary basename: served at `/<basename>.js`. Default `p`. Validated `^[a-z0-9_-]+$`. */
  PRIMARY_BASENAME?: string;
  /** Vendor bundle-router URL the primary chain-loads first (async). No default. Present-empty ⇒ none. */
  PORTAL_HANDOFF_URL?: string;
  /** JSON array of secondary-injection manifest entries (see ManifestEntry). Unset/empty ⇒ none. */
  PORTAL_SECONDARIES?: string;
  /** Long display label for the gated features (e.g. a column header / banner). Gated bundle only. */
  RINGOTEL_LABEL?: string;
  /** Short label for tight surfaces. Defaults to RINGOTEL_LABEL. Gated bundle only. */
  RINGOTEL_LABEL_SHORT?: string;
  /** Optional app-dashboard link base for enriched lines; empty ⇒ plain label, no hyperlink. Gated only. */
  RINGOTEL_APP_BASE_URL?: string;
  /** JSON array of app-download links rendered in the stock Apps menu. Self bundle only. Unset ⇒ []. */
  PORTAL_APP_DOWNLOADS?: string;
  /** Company name for the footer version line's product name (`productName`). Unset ⇒ unbranded. */
  BRAND_NAME?: string;
  /** Where the footer version line links, `{version}` substituted. Empty ⇒ never link (`releaseNotesUrl`). */
  PORTAL_RELEASE_NOTES_URL?: string;
  /** Endpoint returning the status-banner message for the caller. Unset ⇒ the feature is inert.
   *  Receives the caller's live ns_t, so it must be an endpoint the operator controls. */
  STATUS_BANNER_WEBHOOK?: string;
  /** Structural for `kitConfigError`'s ASSETS-binding check; see the Worker `Env`'s own doc comment. */
  ASSETS?: { get(key: string): Promise<{ text(): Promise<string> } | null> };
}

/** Loud, distinct error for a bad kit config value so the caller can map it to a 500 (fail closed). */
export class KitConfigError extends Error {}

export const DEFAULT_PRIMARY_BASENAME = 'p';
const BASENAME_RE = /^[a-z0-9_-]+$/;

/**
 * Feature registry: each folded feature's `_AF` flag ↔ the NS policy key that gates it. ORDER IS THE
 * CONTRACT — `buildKitBundle` emits `_AF` in this order so a given allowed-key set is byte-identical.
 * The same key gates the data route server-side; the `_AF` flag is cosmetic (self-hide only).
 */
// Each `key` MUST exist in FEATURE_REGISTRY (src/features.ts) — that registry is the single source of
// truth for gating; these are the subset the folded bundle self-hides via `_AF`, mapped to the short
// `flag` names the bundle body reads (`_AF.callflow` etc.). worker.ts filters these keys through the
// resolved policies, so the flags can't grant more than the server route does.
export const FEATURE_KEYS = [
  { flag: 'callflow', key: 'callflow.view' },
  { flag: 'orgStatus', key: 'ringotel.orgStatus' },
  { flag: 'userStatus', key: 'ringotel.userStatus' },
  { flag: 'orgList', key: 'ringotel.orgList' },
  { flag: 'profileStatus', key: 'ringotel.profileStatus' },
  { flag: 'activate', key: 'ringotel.activate' },
  { flag: 'resetPassword', key: 'ringotel.resetPassword' },
  { flag: 'profileAppAccess', key: 'ringotel.profileAppAccess' },
  // Drives the users-list freshness control. That list stays cached ~10 minutes on purpose (it is a bulk
  // view; making it always-fresh would put a getUsers on every page view of a large domain), so the
  // honest answer is to SHOW how old it is and give whoever may force a re-read a way to do it.
  // `?refresh=ringotel` has existed all along with NO UI, which meant the only way to clear a stale read
  // was to know the query parameter. Same key the route enforces — the flag only decides whether the
  // control is drawn, never whether the refresh is permitted.
  { flag: 'refresh', key: 'ringotel.refresh' },
] as const;

/** All policy keys a principal is tested against for the bundle (in registry order). */
export const featurePolicyKeys = (): string[] => FEATURE_KEYS.map((f) => f.key);

/** The SELF bundle's flag↔key map — drives its `_AF` (registry order). Kept apart from FEATURE_KEYS so the
 * admin bundle is unaffected.
 *
 * WHICH keys belong here is not a judgement call: it is every registry key whose `deliveredBy` resolves to
 * `self`, and `kit.selftest.ts` asserts exactly that set. So a new self-delivered feature that forgets its
 * entry here fails the tests instead of shipping a flag the bundle never sees. What is NOT derivable is the
 * `flag` — those are bundle-local short names (`resetPassword` means `me.resetPassword` here and
 * `ringotel.resetPassword` in the admin bundle), so they stay written down. */
export const SELF_FEATURE_KEYS = [
  { flag: 'appStatus', key: 'me.appStatus' },
  { flag: 'devices', key: 'me.devices' },
  { flag: 'resetPassword', key: 'me.resetPassword' },
  { flag: 'appAccess', key: 'me.appAccess' },
  { flag: 'menuConfig', key: 'me.menuConfig' },
  { flag: 'statusBanner', key: 'portal.statusBanner' },
  { flag: 'versionLine', key: 'portal.versionLine' },
] as const;

/** The self bundle's policy keys, in order. */
export const selfFeaturePolicyKeys = (): string[] => SELF_FEATURE_KEYS.map((f) => f.key);

/** The public primary basename (validated). Throws KitConfigError on a malformed value. */
export function primaryBasename(env: KitEnv): string {
  const raw = (env.PRIMARY_BASENAME ?? '').trim();
  if (!raw) return DEFAULT_PRIMARY_BASENAME;
  if (!BASENAME_RE.test(raw)) throw new KitConfigError('PRIMARY_BASENAME must match ^[a-z0-9_-]+$');
  return raw;
}

/** One secondary-injection entry. `from`: `r2:<key>` (Worker-served from ASSETS) or `url:<https>` (direct). */
export interface ManifestEntry {
  /** Served at `/kit/asset/<name>.js` (r2) or loaded direct (url). `^[a-z0-9_-]+$`. */
  name: string;
  from: string;
  /**
   * `public` (no token), or ANY gate the feature vocabulary accepts — a level, a list of levels, or
   * `{levels, users}` to name accounts. Resolved by the same `resolveGate` a feature gate uses, so
   * "gate this by user" means one thing across the kit rather than two. Ignored for url: entries.
   */
  auth: Gate;
}

/** True for `r2:` entries — the ones the Worker serves from the ASSETS binding at `/kit/asset/<name>.js`. */
export const isR2Entry = (e: ManifestEntry): boolean => e.from.startsWith('r2:');
/** The R2 object key for an `r2:` entry (`r2:foo` ⇒ `foo`). */
export const r2Key = (e: ManifestEntry): string => e.from.slice('r2:'.length);
/** The external https URL for a `url:` entry. */
export const urlHref = (e: ManifestEntry): string => e.from.slice('url:'.length);

/**
 * Parse + validate PORTAL_SECONDARIES. Unset/empty ⇒ []. Any structural problem ⇒ KitConfigError
 * (loud; the deployment is misconfigured). `url:` entries must be https.
 */
export function parseManifest(env: KitEnv): ManifestEntry[] {
  const raw = (env.PORTAL_SECONDARIES ?? '').trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KitConfigError('PORTAL_SECONDARIES is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new KitConfigError('PORTAL_SECONDARIES must be a JSON array');
  const seen = new Set<string>();
  return parsed.map((raw0, i) => {
    const e = raw0 as Record<string, unknown>;
    const name = typeof e?.name === 'string' ? e.name.trim() : '';
    const from = typeof e?.from === 'string' ? e.from.trim() : '';
    // A STRING OR A GATE OBJECT. It was string-only, which refused `{"users": [...]}` even though
    // resolveGate has always accepted it — so a secondary could be gated to a level but never to named
    // accounts, while a feature could. The asymmetry was an accident of this parse, not a decision.
    const rawAuth = (e as { auth?: unknown } | null)?.auth;
    const auth: Gate = typeof rawAuth === 'string' ? rawAuth.trim() : (rawAuth as Gate);
    if (!BASENAME_RE.test(name)) throw new KitConfigError(`PORTAL_SECONDARIES[${i}].name must match ^[a-z0-9_-]+$`);
    if (seen.has(name)) throw new KitConfigError(`PORTAL_SECONDARIES[${i}].name is duplicated: ${name}`);
    seen.add(name);
    if (from.startsWith('r2:')) {
      if (!from.slice(3).trim()) throw new KitConfigError(`PORTAL_SECONDARIES[${i}].from r2: key is empty`);
    } else if (from.startsWith('url:')) {
      const href = from.slice(4).trim();
      if (!/^https:\/\/\S+$/i.test(href)) throw new KitConfigError(`PORTAL_SECONDARIES[${i}].from url: must be https`);
    } else {
      throw new KitConfigError(`PORTAL_SECONDARIES[${i}].from must start with r2: or url:`);
    }
    // `public` (no token) or a gating level (all/reseller/office_manager/…). Validate the LEVEL here at
    // config time — like PORTAL_FEATURES — so a bad/legacy value (e.g. the old `auth`/`admin`/`superadmin`
    // presets, now dropped) is a loud, actionable deploy-time 500 (uniform, pre-auth via kitConfigError),
    // not a silent per-request throw for authenticated callers only. url: entries ignore auth at serve
    // time, but a coherent manifest still validates it.
    if (auth === undefined || auth === null || auth === '') throw new KitConfigError(`PORTAL_SECONDARIES[${i}].auth is required`);
    if (auth !== 'public') {
      try {
        resolveGate(auth, []);
      } catch (e) {
        if (e instanceof FeaturesConfigError)
          throw new KitConfigError(`PORTAL_SECONDARIES[${i}].auth ${e.message} — use "public", a gating level (all/super_user/reseller/office_manager/site_manager/advanced_user/basic_user/call_center_agent/call_center_supervisor/superadmin/off), or {"levels": [...], "users": [...]}`);
        throw e;
      }
    }
    return { name, from, auth };
  });
}

/**
 * Loud, fail-closed validation of the static injection config (portal-mode-only). A malformed
 * PRIMARY_BASENAME / PORTAL_SECONDARIES / PORTAL_HANDOFF_URL is a deploy-time mistake: surface it as a
 * 500 with an actionable reason on every request (after /health), rather than throwing deep in a route.
 * Returns null when the configuration is valid. The single check — worker.ts calls this rather than
 * re-validating the same manifest/basename/handoff shape itself.
 */
export function kitConfigError(env: KitEnv): string | null {
  try {
    primaryBasename(env);
    parseManifest(env);
  } catch (e) {
    if (e instanceof KitConfigError) return e.message;
    throw e;
  }
  const h = env.PORTAL_HANDOFF_URL;
  if (h !== undefined && h.trim() !== '' && !/^https:\/\/\S+$/i.test(h.trim()))
    return 'PORTAL_HANDOFF_URL must be an https URL (or unset for a loud no-handoff signal, or "" for an intentional none)';
  // RINGOTEL_APP_BASE_URL becomes an <a href> in the gated bundle — require https (buildKitBundle also
  // drops a non-https value defensively, but fail loud so the operator fixes it rather than silently
  // losing the app-dashboard links).
  const ab = env.RINGOTEL_APP_BASE_URL;
  if (ab !== undefined && ab.trim() !== '' && !/^https:\/\/\S+$/i.test(ab.trim()))
    return 'RINGOTEL_APP_BASE_URL must be an https URL (it becomes an app-dashboard link href), or unset';
  // STATUS_BANNER_WEBHOOK receives the caller's live ns_t, so wrapBundle refuses to emit a non-https
  // value. That refusal is SILENT from the operator's side: the feature reads as configured and on, and
  // simply never draws anything -- the same shape as the endpoint returning an unrecognised body, which
  // is the failure this whole feature has proven hardest to diagnose. Fail loud here instead.
  const bw = env.STATUS_BANNER_WEBHOOK;
  if (bw !== undefined && bw.trim() !== '' && !/^https:\/\/\S+$/i.test(bw.trim()))
    return 'STATUS_BANNER_WEBHOOK must be an https URL (it receives the caller\'s live ns_t), or unset to turn the banner off';
  // PORTAL_RELEASE_NOTES_URL becomes an <a href> in the portal footer and the console header. Escaping
  // does not neutralise a javascript: value in an href position, and this was the one operator URL
  // rendered that way with no scheme check -- the others above have had one since they shipped. '' is a
  // deliberate "never link", so only a non-empty value is checked.
  const rn = env.PORTAL_RELEASE_NOTES_URL;
  if (rn !== undefined && rn.trim() !== '' && !/^https:\/\/\S+$/i.test(rn.trim()))
    return 'PORTAL_RELEASE_NOTES_URL must be an https URL (it becomes the version link href), "" to never link, or unset for the default';
  // An r2: secondary with no ASSETS binding is a broken deploy — surface it uniformly here (loud, every
  // route) rather than as a per-name 500 on the asset route (which would disclose config to an
  // unauthenticated caller before the gate). parseManifest already validated above, so it won't throw.
  if (!env.ASSETS && parseManifest(env).some(isR2Entry))
    return 'A PORTAL_SECONDARIES entry uses r2: but no ASSETS R2 binding is bound';
  return null;
}

/**
 * Gate a secondary/asset by its manifest `auth` value (a Gate: a level like `all`/`reseller`/
 * `office_manager`, a union, an object, or raw rules). Resolved through the SAME level vocabulary the
 * data routes use (src/features.ts `resolveGate`), so secondaries and features can't drift apart.
 * Fail-closed by construction:
 *   public → allow (no token needed — the one value that is NOT a level);
 *   any other value with no principal → deny (a valid ns_t is required);
 *   otherwise → isAllowed(principal, resolveGate(auth, superadmins)) — `all` = any authenticated,
 *               the scope levels nest, `superadmin`/forced users unioned in; unknown ⇒ throws (loud).
 */
export function kitGateAllows(auth: Gate, principal: Principal | null, superadmins: string[]): boolean {
  if (auth === 'public') return true;
  if (principal == null) return false;
  return isAllowed(principal, resolveGate(auth, superadmins));
}

/** True when the level needs a valid ns_t (everything except `public`). Drives 401-vs-serve on the route. */
export const secondaryNeedsAuth = (auth: Gate): boolean => auth !== 'public';

// ── Cache tiering ────────────────────────────────────────────────────────────────────────────────
// A "tier" is the exact allowed-key set. Two principals with the same set get byte-identical bundles,
// so the server cache is keyed by the set (order-independent) + VERSION, and never by any per-user field.
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};
/** Stable hash of an allowed-key set (order-independent). */
export const tierHash = (allowedKeys: string[]): string => fnv1a([...allowedKeys].sort().join('|'));

// ── String builders ──────────────────────────────────────────────────────────────────────────────
// All injected values go through JSON.stringify so they are valid, escaped JS literals. The served
// artifacts are external .js (content-type text/javascript), never inside an HTML <script>, so `</script>`
// in a value is inert. `?v=VERSION` busts the browser cache the instant a deploy changes VERSION.

/**
 * The neutral PUBLIC primary bootstrap. Host-neutral: derives its API base at runtime from
 * `document.currentScript.src` (falling back to a pre-set `window.__kitCfg.base`), never a baked host.
 * Does the vendor handoff first (async, priority), then — if an ns_t is present — fetch+injects the
 * gated bundle, then loads the manifest secondaries. Carries NOTHING sensitive (no labels): those live
 * in the gated bundle, behind auth.
 */
export function primaryJs(env: KitEnv): string {
  const handoff = (env.PORTAL_HANDOFF_URL ?? '').trim();
  const manifest = parseManifest(env);
  const H = JSON.stringify(handoff);
  // Absent (undefined) is distinct from "" — the primary can't tell them apart from `H` alone (both are
  // ""), so inject the "missing" signal explicitly. Absent ⇒ loud reseller nag; "" ⇒ intentional silence.
  const HM = JSON.stringify(env.PORTAL_HANDOFF_URL === undefined);
  // `pub`, not the gate. The client's only question is "fetch this with a token, or load it plainly?" —
  // one boolean. This used to ship the gate value itself into the PUBLIC, unauthenticated primary, which
  // was merely needless when a gate was a level like "reseller" and becomes a real disclosure now that a
  // gate can name accounts. The narrowest thing the consumer needs is the only thing it gets.
  const M = JSON.stringify(manifest.map((e) => ({ name: e.name, from: e.from, pub: e.auth === 'public' })));
  const V = JSON.stringify(VERSION);
  return `(function(){
"use strict";
var cs=document.currentScript;
var base=(cs&&cs.src)||(window.__kitCfg&&window.__kitCfg.base)||null;
if(base){try{base=new URL(base);base=base.origin;}catch(e){base=null;}}
if(!base){console.error("[kit] no base");return;}
window.__kitCfg=window.__kitCfg||{};window.__kitCfg.base=base;
if(window.__kitCfg.loaded)return;window.__kitCfg.loaded=1;
var HANDOFF=${H},HANDOFF_MISSING=${HM},MANIFEST=${M},V=${V};
var HO={u:HANDOFF,m:HANDOFF_MISSING,pre:false,add:false};
if(HANDOFF){try{var hs=document.getElementsByTagName("script");for(var hi=0;hi<hs.length;hi++){if(hs[hi].src===HANDOFF){HO.pre=true;break;}}}catch(e){}if(!HO.pre){var s=document.createElement("script");s.async=true;s.src=HANDOFF;(document.head||document.documentElement).appendChild(s);HO.add=true;}}
else if(HANDOFF_MISSING){console.error("[kit] handoff not configured");kitNag();}
window.__kitCfg.ho=HO;
function tok(){try{return localStorage.getItem("ns_t")||"";}catch(e){return "";}}
function inject(code){try{var b=new Blob([code],{type:"text/javascript"});var u=URL.createObjectURL(b);var s=document.createElement("script");s.src=u;s.onload=function(){URL.revokeObjectURL(u);};(document.head||document.documentElement).appendChild(s);}catch(e){var s2=document.createElement("script");s2.textContent=code;(document.head||document.documentElement).appendChild(s2);}}
function fetchInject(path){var t=tok();if(!t)return;fetch(base+path+"?v="+encodeURIComponent(V),{headers:{Authorization:"Bearer "+t}}).then(function(r){return r.status===200?r.text():null;}).then(function(c){if(c)inject(c);}).catch(function(){});}
fetchInject("/kit/portal.js");
fetchInject("/kit/self.js");
fetchInject("/kit/spk.js");
function ext(src){var s=document.createElement("script");s.src=src;(document.head||document.documentElement).appendChild(s);}
for(var i=0;i<MANIFEST.length;i++){(function(e){
if(e.from.indexOf("url:")===0){ext(e.from.slice(4));return;}
if(e.from.indexOf("r2:")!==0)return;
if(e.pub){ext(base+"/kit/asset/"+e.name+".js?v="+encodeURIComponent(V));}
else{fetchInject("/kit/asset/"+e.name+".js");}
})(MANIFEST[i]);}
function _scope(){try{var t=tok();if(!t)return "";var p=t.split(".")[1];if(!p)return "";var j=JSON.parse(decodeURIComponent(escape(atob(p.replace(/-/g,"+").replace(/_/g,"/")))));return ""+(j.user_scope||j.scope||"");}catch(e){return "";}}
function _isReseller(s){s=(""+s).toLowerCase();return s==="reseller"||s==="super user"||s==="superuser"||s==="super-user";}
function kitNag(){try{if(!_isReseller(_scope()))return;function show(){try{if(document.getElementById("_kitnag"))return;var d=document.createElement("div");d.id="_kitnag";d.style.cssText="position:fixed;top:0;left:0;right:0;z-index:2147483600;background:#c0392b;color:#fff;font:600 13px system-ui,sans-serif;padding:8px 12px;display:flex;align-items:center;justify-content:center;gap:12px";var m=document.createElement("span");m.textContent="⚠ Portal add-on: no handoff script is configured, so any custom passthrough scripts won't run. Set the handoff URL in your portal-kit config, or set it blank to dismiss.";var x=document.createElement("button");x.textContent="Dismiss";x.style.cssText="border:1px solid #fff;background:transparent;color:#fff;cursor:pointer;padding:2px 8px;border-radius:4px;font:inherit";x.addEventListener("click",function(){d.remove();});d.appendChild(m);d.appendChild(x);(document.body||document.documentElement).appendChild(d);}catch(e){}}if(document.body)show();else document.addEventListener("DOMContentLoaded",show);}catch(e){}}
}());
`;
}

/**
 * The CONSTANT feature body of the gated bundle (same bytes for every tier — `_AF` in the header gates
 * which features run, so two same-tier principals stay byte-identical). Ported from the Manager-Portal
 * `svc` injection and NEUTRALIZED: labels come from `_KC` (`RINGOTEL_LABEL`/`_SHORT`), the app-dashboard
 * base from `_KC.appBase` (`RINGOTEL_APP_BASE_URL`; empty ⇒ plain label, no hyperlink), the Worker base
 * from `window.__kitCfg.base`, and every scope gate is an `_AF.<key>` flag — NO deployment host, label,
 * or vendor URL is a literal here (mirror-safe). Selectors (`.user-toolbar`, `/portal/*`, `svx-*`) are
 * generic Manager-Portal/DOM, not customer data. `String.raw` keeps the regex backslashes intact.
 * Client `_AF` flags are cosmetic self-hide — the Worker's data routes enforce the same keys.
 */
/** Shared client primitives used by BOTH bundles (concatenated ahead of each body). Kept minimal so the
 * self bundle carries no admin feature code. `B`/`_AF`/`_KC` are defined by the wrapper preamble. */
const KIT_COMMON = String.raw`
function tok(){try{return localStorage.getItem('ns_t')}catch(e){return null}}
function dom(){return(typeof window.current_domain!=='undefined'&&window.current_domain)||null}
function masq(){try{return !!(document.querySelector('.mask-bar')||document.querySelector('a[href*="endMasquerade"]'))}catch(e){return false}}
function jget(p){var j=tok();if(!j)return Promise.reject(new Error('auth'));return fetch(B+p,{headers:{Authorization:'Bearer '+j}}).then(function(x){if(!x.ok)throw new Error(x.status);return x.json()})}
function jpost(p,body){var j=tok();if(!j)return Promise.reject(new Error('auth'));return fetch(B+p,{method:'POST',headers:{Authorization:'Bearer '+j,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(x){if(!x.ok)throw new Error(x.status);return x.json()})}
// Reseller-or-above, decoded from the caller's own ns_t. Lives here in COMMON rather than in one bundle
// because both need it now: the admin body gates the force-activate override on it, and the self body
// decides whether the footer version line is a link. Two copies of a scope decoder is the shape of bug
// this repo has already shipped four times.
function _kscope(){try{var t=tok();if(!t)return '';var p=t.split('.')[1];if(!p)return '';var j=JSON.parse(decodeURIComponent(escape(atob(p.replace(/-/g,'+').replace(/_/g,'/')))));return ''+(j.user_scope||j.scope||'')}catch(e){return ''}}
function _isRes(){var s=_kscope().toLowerCase();return s==='reseller'||s==='super user'||s==='superuser'||s==='super-user'}
// ── Shared app-access sign-in rendering — the SINGLE source of the sign-in verbiage/decision, used by
// the Apps menu, the home card, AND the admin profile block, so the wording can never fork. ──
function copyBtn(v,name){var b=document.createElement('button');b.type='button';b.title='Click to copy';b.setAttribute('aria-label','Copy'+(name?' '+name:''));
b.textContent='⧉';   // ⧉ copy glyph (textContent, never innerHTML)
b.style.cssText='justify-self:end;width:18px;height:18px;border:1px solid #d5d9dd;border-radius:3px;background:#fafbfc;cursor:pointer;padding:0;font:11px/16px system-ui,sans-serif;color:#8a9199;text-align:center;flex:none';
// Flip to a green ✓ ONLY on an actual successful copy — writeText returns a promise, so a plain
// try/catch would flash success even when the clipboard write is denied.
b.addEventListener('click',function(e){e.preventDefault();
function done(){b.textContent='✓';b.style.borderColor='#3a7d3a';b.style.color='#3a7d3a';
setTimeout(function(){b.textContent='⧉';b.style.borderColor='#d5d9dd';b.style.color='#8a9199'},1100)}
try{var p=navigator.clipboard.writeText(v);if(p&&p.then){p.then(done,function(){})}else{done()}}catch(x){}});
return b}
// Where the app password actually is depends on a per-organization setting. When the server could read
// it we say the true thing; when it could not, we keep the old hedge rather than assert either case.
function pwHint(r){
if(r&&r.hPIE===false)return 'Find the credentials in your email.';
if(r&&r.hPIE===true)return 'Click the emailed one-time link to reveal your credentials.';
return 'In the email itself, or behind the one-time link in it.'}
function aaModel(r,L){var m=r&&r.mode,sso=m==='sso',pw=m==='password';
if(sso||pw){return {signable:true,advisory:null,fields:[
{k:'Domain',v:(r.appDomain||''),hint:'The same for everyone in your organization.',warn:false,copy:true},
{k:'Username',v:(r.username||''),hint:sso?'Your full portal sign-in — not just your extension.':'Your app username — not your portal sign-in.',warn:sso,copy:true},
{k:'Password',v:(sso?'Your portal password':'From your welcome email'),hint:sso?'The same one you use here.':pwHint(r),warn:false,copy:false}
]}}
return {signable:false,fields:[],advisory:{t:(m==='needs-portal-setup'
?'Your portal sign-in isn’t set up yet. Contact your administrator.'
:m==='unavailable'
?'The '+L+' sign-in status is temporarily unavailable — please try again in a moment.'
:'The '+L+' isn’t set up for this extension. Contact your administrator if you think it should be.'),warn:true}}}
function aaUrlLine(url,asDiv){var w=document.createElement(asDiv?'div':'li');
w.style.cssText='display:flex;align-items:center;gap:6px;font-size:11px;color:#8a9199;word-break:break-all'+(asDiv?';margin-top:2px':';padding:0 16px 4px');
if(!asDiv)w.className='_svxrow';
var s=document.createElement('span');s.textContent=url;s.style.cursor='pointer';s.title='Click to copy';
var cb=copyBtn(url,'URL');s.addEventListener('click',function(e){e.preventDefault();cb.click()});
w.appendChild(s);w.appendChild(cb);return w}
// Apply a resolved menu plan to a <ul>. Hiding is fail-OPEN (an entry we can't find is skipped, so a
// portal rename degrades to "it stays" rather than a broken menu) and uses display:none rather than
// removal, since stock scripts may expect their own element to exist. The before arg inserts ahead of an
// element instead of appending: the account menu wants new items in the first group, not after Log Out.
function menuApply(ul,plan,before){
(plan&&plan.hide||[]).forEach(function(h){
for(var i=0;i<ul.children.length;i++){var a=ul.children[i].querySelector('a');
if(a&&a.textContent.trim().toLowerCase()===String(h).trim().toLowerCase())ul.children[i].style.display='none'}});
var add=(plan&&plan.add)||[];if(!add.length)return;
// {page} is the one variable the server can't fill. PATH only — a portal URL's query can carry
// identifiers and these links may leave for a third party.
var pg=encodeURIComponent(location.pathname),pgRaw=location.pathname;
function fill(s){return String(s==null?'':s).split('{page}').join(pg)}
// A label or title is read by a human, not parsed as a URL — show the plain path there.
function fillRaw(s){return String(s==null?'':s).split('{page}').join(pgRaw)}
var seen=[];
add.forEach(function(m){if(!m||!m.url||seen.indexOf(m.url)>=0)return;seen.push(m.url);
var li=document.createElement('li');li.className='_svxadd';li.setAttribute('data-u',m.url);
var a=document.createElement('a');a.textContent=fillRaw(m.label);a.href=fill(m.url);a.target='_blank';a.rel='noopener noreferrer';
if(m.title)a.title=fillRaw(m.title);li.appendChild(a);
if(before&&before.parentNode===ul)ul.insertBefore(li,before);else ul.appendChild(li)})}
function aaDownloads(target,asButtons){(_KC.dl||[]).forEach(function(d){
if(asButtons){var col=document.createElement('div');col.style.cssText='display:flex;flex-direction:column;align-items:center;gap:2px';
var a=document.createElement('a');a.className='btn btn-small';a.textContent=d.label;a.href=d.url;a.target='_blank';a.rel='noopener noreferrer';if(d.title)a.title=d.title;col.appendChild(a);
if(d.showUrl!==false)col.appendChild(aaUrlLine(d.url,true));target.appendChild(col)}
else{var li=document.createElement('li');var a2=document.createElement('a');a2.textContent=d.label;a2.href=d.url;a2.target='_blank';a2.rel='noopener noreferrer';if(d.title)a2.title=d.title;li.appendChild(a2);target.appendChild(li);
if(d.showUrl!==false)target.appendChild(aaUrlLine(d.url,false))}
})}
function box(t,src,note){
var p=document.getElementById('_svx');if(p)p.remove();
var o=document.createElement('div');o.id='_svx';
function close(){o.remove();document.removeEventListener('keydown',key)}
function key(e){if(e.key==='Escape')close()}
o.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483000;display:flex;align-items:center;justify-content:center';
var b=document.createElement('div');
b.style.cssText='background:#fff;width:92vw;height:88vh;border-radius:8px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.4)';
var h=document.createElement('div');
h.style.cssText='display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #ddd;font:600 14px system-ui,sans-serif';
var s=document.createElement('span');s.textContent=t;
if(note){var nn=document.createElement('span');nn.textContent=' '+note;nn.style.cssText='color:#888;font-weight:400;font-size:12px;margin-left:8px';s.appendChild(nn)}
var x=document.createElement('button');x.textContent='✕';
x.style.cssText='border:0;background:transparent;font-size:18px;cursor:pointer;line-height:1';
x.addEventListener('click',close);
h.appendChild(s);h.appendChild(x);
var f=document.createElement('iframe');f.style.cssText='flex:1;border:0;width:100%';f.sandbox='allow-scripts allow-popups';f.title=t;f.srcdoc=src;
f.addEventListener('load',function(){try{f.contentDocument.addEventListener('keydown',key)}catch(e){}});
b.appendChild(h);b.appendChild(f);o.appendChild(b);
o.addEventListener('click',function(e){if(e.target===o)close()});
document.addEventListener('keydown',key);
document.body.appendChild(o);
}
// The top-nav Management dropdown (administrative scopes only). It has no id, and its toggle carries no
// href either -- the ONLY anchor is the toggle's own label, so a portal that renames the menu simply does
// not match and the entry is absent. That is the honest failure: nothing breaks, nothing lands elsewhere.
// The toggle's text is read from the TOGGLE, never from a container, for the same reason the account menu
// is tested per item. Its caret is an empty <i>, so trimmed textContent is the label alone.
// is exactly why neither anchor may be an item we expect to be present.
// Does this menu have a sign-out entry? Tested PER ITEM, never against the <ul>'s textContent: that
// concatenates children with no separator ("Some Entry"+"Log Out" -> "Some EntryLog Out"), which makes
// any word-boundary test fail and matched nothing at all. Anchoring on the item also stops a label like
// "Log Outbound Calls" from counting.
function hasSignOut(ul){var ch=ul.children;
for(var i=0;i<ch.length;i++){if(/^log\s*out\b/i.test((ch[i].textContent||'').trim()))return true}
return false}
function acctUl(){
var scopes=[document.querySelector('ul.user-toolbar'),document];
for(var s=0;s<scopes.length;s++){var root=scopes[s];if(!root)continue;
// Log Out is the one entry present in every variant of this menu, so it is the primary anchor.
// Prefer a menu carrying BOTH signals — a sign-out entry AND this user's own profile link. Either
// alone can appear on some other dropdown; together they identify the account menu. Sign-out alone is
// the fallback (some variants show no profile link), and the profile link alone is the last resort.
var ls=root.querySelectorAll('ul.dropdown-menu'),soOnly=null;
for(var i=0;i<ls.length;i++){var u=ls[i];
if(u.id==='app-menu-list'||!hasSignOut(u))continue;
if(u.querySelector('a[href*="/portal/users/edit/profile/"]'))return u;
if(!soOnly)soOnly=u}
if(soOnly)return soOnly;
var a=root.querySelector('ul.dropdown-menu a[href*="/portal/users/edit/profile/"]');
var ul=a&&a.closest('ul.dropdown-menu');if(ul)return ul}
return null}
// The apps dropdown is the one menu with a stable id.
function appsUl(){return document.getElementById('app-menu-list')}
// MENU_NAMES (src/menus.ts) -> the element, in ONE place. The three appliers in the self bundle and the
// builder in the console bundle now resolve a menu the same way; two finders for one menu is how the
// builder would end up offering to hide an entry from an element nothing else touches.
function menuUl(n){return n==='apps'?appsUl():n==='account'?acctUl():n==='management'?mgmtUl():null}
function mgmtUl(){
var ts=document.querySelectorAll('a.dropdown-toggle[data-toggle="dropdown"]');
for(var i=0;i<ts.length;i++){var t=ts[i];
if(!/^management$/i.test((t.textContent||'').replace(/\s+/g,' ').trim()))continue;
// Bootstrap puts the menu either directly after the toggle or beside it inside the same <li>. Accept
// both rather than assume one: this markup is the vendor's, and it has changed before.
var n=t.nextElementSibling;
if(n&&n.tagName&&n.tagName.toLowerCase()==='ul'&&/dropdown-menu/.test(n.className||''))return n;
var li=t.closest&&t.closest('li');var u=li&&li.querySelector('ul.dropdown-menu');if(u)return u}
return null}
`;

const KIT_ADMIN_BODY = String.raw`
function get(k,r,d){
var j=tok();if(!j)return Promise.reject(new Error('auth'));
return fetch(B+'/flow?domain='+encodeURIComponent(d)+'&kind='+k+'&ref='+encodeURIComponent(r)+'&format=html',{headers:{Authorization:'Bearer '+j}}).then(function(x){if(!x.ok)throw new Error(x.status);return x.text()});
}
function resAct(){return !!_AF.orgStatus&&!!dom()&&!masq()}
function cfAud(){return !!_AF.callflow}
var _bnSkip=null;
function banner(){
if(!resAct())return;
var tb=document.querySelector('ul.user-toolbar');if(!tb)return;
if(document.getElementById('_svx_res'))return;
var d=dom();
if(d===_bnSkip||banner._p===d)return;
banner._p=d;
jget('/rapp/org?domain='+encodeURIComponent(d)).then(function(r){
banner._p=null;
if(document.getElementById('_svx_res'))return;
if(!r||(!r.active&&!r.eligible)){_bnSkip=d;return;}
// The app domain is domain-global (same for every user here, SSO or not), so showing it in the toolbar
// is a genuine at-a-glance fact rather than per-user detail. The toolbar is a fixed-height row with
// limited width, so when we spend room on the domain we buy it back with the SHORT label, and the
// domain itself truncates rather than pushing the row. Full value stays in the title.
var nm=(r.active&&r.appDomain&&_KC.labelShort)?_KC.labelShort:_KC.label;
var li=document.createElement('li');li.id='_svx_res';
var sp=document.createElement('span');sp.className='dropdown language-dropdown';
var ic=document.createElement('i');ic.className='icon icon-cloud';
sp.appendChild(ic);sp.appendChild(document.createTextNode(' '));
if(r.active){
var lnk=!!(r.orgId&&_KC.appBase);
var a=document.createElement(lnk?'a':'span');a.style.fontWeight='bold';a.style.color='darkgreen';a.textContent=nm+' Active';
if(lnk){a.href=_KC.appBase+'/account/en-US/#/orgs/'+encodeURIComponent(r.orgId)+'/dashboard';a.target='_blank';a.rel='noopener noreferrer'}
if(r.appDomain)a.title=_KC.label+' domain: '+r.appDomain;
sp.appendChild(a);
if(r.appDomain){var dm=document.createElement('span');dm.textContent=': '+r.appDomain;
dm.title=_KC.label+' domain: '+r.appDomain;
dm.style.cssText='font-weight:400;color:#6b747c;max-width:13em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom';
sp.appendChild(dm)}
}else{
var lb=document.createElement('span');lb.style.fontWeight='bold';lb.style.cursor='default';lb.style.color='#c09853';
lb.textContent=nm+' Not Active';lb.title=nm+' not activated for this PBX domain';
sp.appendChild(lb);
}
li.appendChild(sp);tb.insertBefore(li,tb.firstChild);
}).catch(function(){banner._p=null;_bnSkip=d});
}
var UK='_svx_appcol';
function colOn(){try{return localStorage.getItem(UK)!=='0'}catch(e){return true}}
function colSet(v){try{localStorage.setItem(UK,v?'1':'0')}catch(e){}colApply()}
function colApply(){var on=colOn(),e=document.querySelectorAll('.svx-appcol');for(var i=0;i<e.length;i++)e[i].classList.toggle('hide',!on);var c=document.querySelector('.svx-appopt');if(c)c.checked=on}
function svdot(c){var s=document.createElement('span');s.style.cssText='display:inline-block;width:9px;height:9px;border-radius:50%;vertical-align:middle;margin-left:5px;background:'+c;return s}
function colFill(){var t=document.querySelectorAll('td.svx-appcol');for(var i=0;i<t.length;i++){var td=t[i],s=_uD[td.getAttribute('data-ext')],st='',ti='';if(s&&s.activated){st=s.presence||'offline';ti=s.label||'';if(s.devices)ti+=' · '+s.devices+' device'+(s.devices===1?'':'s');if(st==='offline'&&s.lastSeen){try{ti+=' · last seen '+new Date(s.lastSeen).toLocaleDateString()}catch(e){}}}var _h=s&&s.health&&s.health.flags&&s.health.flags.length?s.health:null;if(_h){ti=(ti?ti+' · ':'')+_h.flags.join(', ');if(_h.severity==='broken')st=st?st+' broken':'broken'}if(s&&s.warning){ti=(ti?ti+' · ':'')+'connection conflict';st=st?st+' broken':'broken'}else if(s&&s.connection){ti=(ti?ti+' · ':'')+s.connection}if(td.getAttribute('data-st')!==st){td.setAttribute('data-st',st);td.textContent='';if(st){var _b=st.indexOf('broken')!==-1;var _p=st.split(' ')[0];td.appendChild(document.createTextNode(_b?'⚠️':'📱'));td.appendChild(svdot(_b?'#d93025':_p==='active'?'#3ba55d':_p==='pbx'?'#e8930c':'#9aa0a6'))}}if(td.title!==ti)td.title=ti}}
function colMenu(){var o=document.querySelector('label.checkbox input[data-table="user"]'),m=o&&o.closest('label.checkbox').parentNode;if(!m||m.querySelector('.svx-appopt'))return;var l=document.createElement('label');l.className='checkbox';var c=document.createElement('input');c.type='checkbox';c.className='svx-appopt';c.checked=colOn();c.addEventListener('change',function(e){e.stopPropagation();colSet(c.checked)});l.appendChild(c);l.appendChild(document.createTextNode(' '+_KC.labelShort));m.appendChild(l)}
function colBuild(){var hr=document.querySelector('thead tr');if(!hr)return;var th=hr.querySelector('th.svx-appcol');if(!th){th=document.createElement('th');th.className='svapp-header svapp svx-appcol';th.textContent=_KC.labelShort;th.style.textAlign='center';var a=hr.querySelector('th.department-header')||hr.querySelector('th.department')||hr.lastElementChild;hr.insertBefore(th,a)}var j=[].indexOf.call(hr.children,th);var cbs=document.querySelectorAll('input.userChkBox[data-extension]');for(var i=0;i<cbs.length;i++){var tr=cbs[i].closest('tr');if(!tr||tr.querySelector('td.svx-appcol'))continue;var td=document.createElement('td');td.className='svapp svx-appcol';td.style.whiteSpace='nowrap';td.style.textAlign='center';td.setAttribute('data-ext',cbs[i].getAttribute('data-extension'));tr.insertBefore(td,tr.children[j]||null)}colFresh(th);colMenu();colApply();colFill()}
function colRemove(){var e=document.querySelectorAll('.svx-appcol,.svx-appopt');for(var i=0;i<e.length;i++){var n=e[i];if(n.classList.contains('svx-appopt')){var lb=n.closest('label');if(lb)lb.remove()}else n.remove()}}
var _uD={},_uAct=false,_uDom=null,_uOb=0,_uRaf=0,_uBusy=false,_uAge=null,_uT=0;
// Human age of the cached read. A silent wrong answer is worse than a visibly old one -- this column is
// deliberately served from a ~10-minute cache, so it says so rather than presenting stale activation
// state as current.
function ageTxt(s){if(s==null)return '';if(s<45)return 'just now';var m=Math.round(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);return h+'h '+(m%60)+'m ago'}
// Server-reported age PLUS the time since we received it, so each RENDER shows the true age rather than
// whatever it was when the data arrived. It does not tick on its own -- colFresh runs from colBuild,
// which runs from the MutationObserver -- so on a page nobody touches the tooltip holds its last value.
function uAgeNow(){return _uAge==null?null:_uAge+Math.floor((Date.now()-_uT)/1000)}
// The 'force' argument sends the NEUTRAL ?refresh=1 -- these bytes are read in devtools by admins of a
// white-labeled deployment, so no vendor name goes in them (same reason the routes are /rapp/*). The
// server decides whether that caller may actually force a re-dig and coalesces it; a refused one simply
// reads the cache, so the worst a client can do by asking is get the same answer back.
function uFetch(d,force){
_uAct=false;_uD={};_uAge=null;_uBusy=true;
jget('/rapp/users?domain='+encodeURIComponent(d)+(force?'&refresh=1':'')).then(function(r){
_uAct=!!(r&&r.active);_uD=(r&&r.users)||{};_uAge=(r&&typeof r.age==='number')?r.age:null;_uT=Date.now();_uBusy=false;uSched()
}).catch(function(){_uAct=false;_uD={};_uAge=null;_uBusy=false;uSched()})}
// The age + refresh affordance on the column header. Re-applied on every render (colBuild runs from a
// MutationObserver), so the label tracks the data instead of the moment the header was created.
function colFresh(th){
var a=uAgeNow();
th.title=_KC.label+(a==null?'':' \u2014 data as of '+ageTxt(a));
var r=th.querySelector('a.svx-rfr');
if(!_AF.refresh){if(r)r.remove();return}
if(!r){r=document.createElement('a');r.className='svx-rfr';r.href='javascript:void(0)';r.textContent='\u27f3';
r.style.cssText='margin-left:6px;text-decoration:none;font-weight:normal;opacity:.6';
r.addEventListener('click',function(e){e.preventDefault();if(_uBusy||!_uDom)return;r.style.opacity='.25';uFetch(_uDom,true)});
th.appendChild(r)}
r.style.opacity=_uBusy?'.25':'.6';
r.title='Refresh '+_KC.label+' data'+(a==null?'':' (currently '+ageTxt(a)+')');
}
function uSched(){if(_uRaf)return;_uRaf=requestAnimationFrame(function(){_uRaf=0;try{usersCol()}catch(e){}})}
function usersCol(){
if(!/^\/portal\/users\/?($|index)/.test(location.pathname))return;
if(!_AF.userStatus){colRemove();return}
if(!_uOb){_uOb=1;new MutationObserver(uSched).observe(document.body,{childList:true,subtree:true})}
var d=dom();if(!d){colRemove();return}
if(_uDom!==d){_uDom=d;uFetch(d,false)}
if(_uBusy)return;
if(_uAct)colBuild();else colRemove();
}
function btn(lbl,kind,ref,d,tip,note){
var a=document.createElement('a');a.href='javascript:void(0)';a.className='helpsy';a.title=tip||'Call Flow Diagram';a.textContent='🔀';a.style.cssText='margin-right:6px;font-size:16px;line-height:1;vertical-align:middle;text-decoration:none';
a.addEventListener('click',function(e){e.preventDefault();a.style.opacity='.5';get(kind,ref,d).then(function(html){box('Call Flow Diagram — '+lbl,html,note)}).catch(function(err){alert('Call Flow unavailable: '+(err&&err.message?err.message:err))}).then(function(){a.style.opacity=''})});
return a;
}
function place(tr,el){var cell=tr.querySelector('td.action-buttons')||tr.lastElementChild;if(cell)cell.insertBefore(el,cell.firstChild)}
function inv(){
var rs=document.querySelectorAll('tr');
for(var i=0;i<rs.length;i++){var tr=rs[i];if(tr.dataset.svx)continue;
var cb=tr.querySelector('input.inventoryChkBox[data-sipnumber]');if(!cb)continue;
var mm=(cb.getAttribute('data-sipnumber')||'').match(/SIP(\d+)@/i);if(!mm)continue;
var d=cb.getAttribute('data-domain-owner')||dom();if(!d)continue;
tr.dataset.svx='1';place(tr,btn(cb.getAttribute('data-formatednumber')||mm[1],'did',mm[1],d));}
// Fallback anchor: the number's own edit link. The checkbox above is a RESELLER inventory-management
// affordance (bulk-assign between domains) and is absent for an Office Manager, so every row bailed on
// the first selector and no DID buttons rendered. The link is present in both views; rows the checkbox
// pass already claimed carry data-svx and are skipped here, so the reseller keeps data-domain-owner —
// which is authoritative when the owning domain isn't the one being viewed. SIP(\d+) yields the same
// ref as data-sipnumber, and the trailing path segment is the domain, matching byLink's (ref,domain).
byLink('a[href*="/portal/inventory/edit/phonenumber/"]',/\/inventory\/edit\/phonenumber\/SIP(\d+)@[^/]*\/([^/?#]+)/,'did');
}
function byLink(sel,re,kind){
var ls=document.querySelectorAll(sel);
for(var i=0;i<ls.length;i++){var a=ls[i],tr=a.closest('tr');if(!tr||tr.dataset.svx)continue;
var m=(a.getAttribute('href')||'').match(re);if(!m)continue;
tr.dataset.svx='1';place(tr,btn((a.textContent||'').trim()||m[1],kind,m[1],m[2]));}
}
function cq(){byLink('a[href*="/portal/callqueues/edit/"]',/\/callqueues\/edit\/(\d+)@([^/?#]+)/,'queue')}
function aa(){
byLink('a[href*="/portal/attendants/edit/"]',/\/attendants\/edit\/(\d+)@([^/?#]+)/,'attendant');
var ss=document.querySelectorAll('td.single-button audio source[src*="object=audio"]');
for(var i=0;i<ss.length;i++){var s=ss[i],tr=s.closest('tr');if(!tr||tr.dataset.svx)continue;
var src=s.getAttribute('src')||'',u=src.match(/[?&]user=(\d+)/),d=src.match(/[?&]domain=([^&]+)/);if(!u||!d)continue;
tr.dataset.svx='1';place(tr,btn(u[1],'attendant',u[1],d[1]));}
}
function aae(){
if(document.querySelector('a.svxaae'))return;
var bar=document.getElementById('navigation-subbar');if(!bar)return;
var s=document.querySelector('audio source[src*="object=audio"]'),src=s?(s.getAttribute('src')||''):'';
var u=src.match(/[?&]user=(\d+)/),d=src.match(/[?&]domain=([^&]+)/),ext=u?u[1]:null;
if(!ext){var q=document.querySelectorAll('span.uneditable-input');for(var k=0;k<q.length;k++){var t=(q[k].textContent||'').trim();if(/^\d{3,6}$/.test(t)){ext=t;break}}}
var domn=d?d[1]:dom();if(!ext||!domn)return;
var name=(document.querySelector('input[name="data[Attendant][name]"]')||{}).value;
var a=btn(name||ext,'attendant',ext,domn,'Call Flow Diagram (last saved state)','reflects last saved configuration');
a.className='btn subbar-btn helpsy svxaae';
var ic=(document.getElementById('pageRefresh')||bar).querySelector('i');
a.style.cssText='text-decoration:none;line-height:1;vertical-align:middle;font-size:'+(ic?(parseFloat(getComputedStyle(ic).fontSize)+2):16)+'px';
bar.appendChild(a);
}
function usr(){
var cbs=document.querySelectorAll('input.userChkBox[data-extension]');
for(var i=0;i<cbs.length;i++){var cb=cbs[i],tr=cb.closest('tr');if(!tr||tr.dataset.svx)continue;
var ext=cb.getAttribute('data-extension'),d=cb.getAttribute('data-domain')||dom();if(!ext||!d)continue;
tr.dataset.svx='1';place(tr,btn(cb.getAttribute('data-username')||ext,'user',ext,d));}
}
function usredit(){
if(document.querySelector('a.svxue'))return;
var bar=document.getElementById('navigation-subbar');if(!bar)return;
var masqb=bar.querySelector('.subbar-btn-masq[data-href*="/mask/"]');if(!masqb)return;
var m=(masqb.getAttribute('data-href')||'').match(/(\d+)@([^/?#]+)/);if(!m)return;
var ct=masqb.getAttribute('data-confirm-title')||'',nm=(ct.match(/Masquerade as (.+?)\??$/)||[])[1]||m[1];
var a=btn(nm,'user',m[1],m[2],'Call Flow Diagram (last saved state)','reflects last saved configuration');
a.className='btn subbar-btn helpsy svxue';
var ic=(document.getElementById('pageRefresh')||masqb).querySelector('i');
a.style.cssText='text-decoration:none;line-height:1;vertical-align:middle;font-size:'+(ic?(parseFloat(getComputedStyle(ic).fontSize)+2):16)+'px';
bar.appendChild(a);
}
function resList(){return !!_AF.orgList&&!masq()}
var _rtMap=null,_rtBusy=false;
function rtTable(){return document.querySelector('table.fixed-table-header')}
function rtHeader(){var t=rtTable();if(!t)return;var hrs=t.querySelectorAll(':scope > thead > tr');for(var i=0;i<hrs.length;i++){var hr=hrs[i];if(hr.querySelector('th.svx-rtcol'))continue;var after=hr.children[1];if(!after)continue;var th=document.createElement('th');th.className='svx-rtcol';th.textContent=_KC.labelShort;th.style.textAlign='center';hr.insertBefore(th,after)}}
function rtFill(){var t=rtTable();if(!t||!_rtMap)return;var rows=t.querySelectorAll(':scope > tbody > tr');for(var i=0;i<rows.length;i++){var tr=rows[i];if(tr.querySelector('td.svx-rtcol'))continue;var dc=tr.children[1];if(!dc)continue;var la=tr.children[0]&&tr.children[0].querySelector('a');var d=la?(la.textContent||'').trim().toLowerCase():'';var td=document.createElement('td');td.className='svx-rtcol';td.style.textAlign='center';td.style.whiteSpace='nowrap';var e=(d&&Object.prototype.hasOwnProperty.call(_rtMap,d))?_rtMap[d]:null,el;if(e){if(_KC.appBase){el=document.createElement('a');el.href=_KC.appBase+'/account/en-US/#/orgs/'+encodeURIComponent(e.orgId)+'/dashboard';el.target='_blank';el.rel='noopener noreferrer';el.style.textDecoration='none'}else{el=document.createElement('span')}el.style.fontSize='16px';if(e.appDomain)el.title='App Domain: '+e.appDomain;el.textContent='☁'}else{el=document.createElement('span');el.textContent='–';el.style.color='#9aa0a6'}td.appendChild(el);tr.insertBefore(td,dc)}}
// rtFill SKIPS any row that already carries a cell, so a forced re-read must drop the old cells or the
// new map lands in memory and nothing on screen changes. Cells only -- the header stays, so the column
// never briefly loses its th and misaligns the row above.
function rtClear(){var e=document.querySelectorAll('td.svx-rtcol');for(var i=0;i<e.length;i++)e[i].remove()}
// force=true re-reads the org list with the server-side directory re-dig (?refresh=1) instead of serving the
// per-page-load memo, and repaints. On a FORCED read that fails we keep the map we already had: blanking a
// good column to '–' would report every domain as not enabled, which is worse than showing it a minute old.
function domCol(force){if(_rtMap&&!force){rtHeader();rtFill();return}if(_rtBusy)return;_rtBusy=true;jget('/rapp/orgs'+(force?'?refresh=1':'')).then(function(r){_rtMap=(r&&r.enabled)||{}}).catch(function(){if(!_rtMap)_rtMap={}}).then(function(){_rtBusy=false;if(force)rtClear();rtHeader();rtFill();var t=rtTable(),tb=t&&t.querySelector(':scope > tbody');if(tb&&!tb._svxRt){tb._svxRt=1;new MutationObserver(function(){rtFill()}).observe(tb,{childList:true})}})}
// The portal's OWN table-reload button (#pageRefresh, present on both the domains and users lists) reloads
// the NS table in place. Piggyback a forced re-read of our data on it, because otherwise the only refresh
// control lives INSIDE the app column -- which is not drawn for a domain that has no org yet, i.e. exactly
// the domain someone is refreshing after enabling one.
//
// Delegated in the CAPTURE phase off document so it survives the portal re-creating the button during its
// own redraw, and needs no ordering against page load. It never interferes with the NS refresh this button
// exists for: no preventDefault, no stopPropagation, and its own failure is swallowed.
function pgRefresh(){
if(pgRefresh._on)return;pgRefresh._on=1;
document.addEventListener('click',function(e){
var t=e.target;if(!t||!t.closest||!t.closest('#pageRefresh'))return;
// Forcing a fleet-wide re-dig is gated on the same key the route enforces. A caller without it would be
// refused server-side, so asking is pointless -- their click stays an ordinary NS table reload.
if(!_AF.refresh)return;
try{
if(/^\/portal\/domains\/?($|index)/.test(location.pathname)){if(resList())domCol(true)}
// The SAME call the column's own refresh control makes -- one intent, one code path, so the two controls
// cannot drift. uFetch runs even when the domain resolves to no org, which is what lets the column APPEAR
// here rather than only refreshing one that is already drawn.
else if(/^\/portal\/users\/?($|index)/.test(location.pathname)){if(_AF.userStatus&&_uDom)uFetch(_uDom,true)}
}catch(x){}
},true);
}
// Pending-change flag: set when WE trigger an activate/deactivate (Save or force); consumed once on the
// reloaded page so it polls-until-flip. Keyed to this ext/domain and expires in 30s.
// NB: this portal patches Date.now() to return a Date-like (JSON-serialized as an ISO string), so use
// new Date().getTime() for a reliable number and parse p.t tolerantly (number OR ISO string).
function setPend(d,ext,want){try{localStorage.setItem('_svxPend',JSON.stringify({d:d,e:ext,w:want,t:new Date().getTime()}))}catch(e){}}
function getPend(d,ext){try{var raw=localStorage.getItem('_svxPend');if(!raw)return null;localStorage.removeItem('_svxPend');var p=JSON.parse(raw);var age=new Date().getTime()-new Date(p.t).getTime();if(p&&p.d===d&&p.e===ext&&age<30000)return !!p.w}catch(e){}return null}
// Poll the live status until it matches the wanted state, then call cb ONCE. Two-phase schedule: every
// ~300ms for the first 3s, then ~1s out to a 10s cap — a slow write (device + app user) still resolves.
// cb always fires exactly once (incl. a hard cap), so the UI never sits on "Loading" forever.
// NB: this portal patches Date.now(); use new Date().getTime().
function pollUntil(d,ext,want,cb){
var t0=new Date().getTime(),fired=false;
function el(){return new Date().getTime()-t0}
function fin(r){if(fired)return;fired=true;try{cb(r)}catch(e){}}
function nap(){return el()<3000?300:1000}
setTimeout(function(){fin(null)},10500);
(function tick(){if(fired)return;jget('/rapp/user?domain='+encodeURIComponent(d)+'&ext='+encodeURIComponent(ext)+'&fresh=1&poll=1').then(function(r2){if(fired)return;var now=!!(r2&&r2.status&&r2.status.activated);if(now===want||el()>=10000){fin(r2)}else{setTimeout(tick,nap())}}).catch(function(){if(fired)return;if(el()>=10000){fin(null)}else{setTimeout(tick,nap())}})})()
}
function profExt(){try{
// The profile page's OWN extension is authoritative for WHOSE profile this is — derive it from the URL
// segment, then the form, FIRST. window.sub_user (the masqueraded identity) is only a fallback for a
// self-profile page that carries no ext (e.g. My Account under masquerade). Using it first made an OM
// who masqueraded and then opened ANOTHER user's profile read/activate/reset THEMSELVES (1042 vs 1045).
var seg=decodeURIComponent((location.pathname.split('/').pop()||''));var m=seg.match(/^([^@]+)@/);if(m)return m[1];
var q=document.querySelectorAll('span.uneditable-input');for(var k=0;k<q.length;k++){var t=(q[k].textContent||'').trim();if(/^\d{3,6}$/.test(t))return t}
if(masq())return window.sub_user!=null?(''+window.sub_user):'';
}catch(e){}return ''}
function profEmail(){try{for(var i=0;i<10;i++){var f=document.getElementById('UserEmailAddress'+i);if(f&&f.value&&f.value.trim())return f.value.trim()}var q=document.querySelectorAll('input[name^="data[User][email_address]"]');for(var k=0;k<q.length;k++){if(q[k].value&&q[k].value.trim())return q[k].value.trim()}}catch(e){}return ''}
// On Save we only RECORD the intent (a cross-origin POST fired during the Save reload gets cancelled).
// The reloaded page (stable, no navigation) fires the actual write via jpost — see actSection phase 2.
function actSave(d,ext,on){setPend(d,ext,on)}
// Bound once per page load; reads the CURRENT toggle by id at click time (the section may be rebuilt by a
// poll, replacing the checkbox element) + its data-init, so it never goes stale.
function hookSave(d,ext){
function bind(b){if(b&&!b._svxSv){b._svxSv=1;b.addEventListener('click',function(){try{var c=document.getElementById('_svx_act_tgl');if(!c||c.disabled)return;if(c.checked!==(c.getAttribute('data-init')==='1'))actSave(d,ext,c.checked)}catch(e){}})}}
var s=document.querySelector("input.saveBtn[type='submit']");if(s){bind(s);return}
var bs=document.querySelectorAll('button,input[type="submit"],a.btn');
for(var i=0;i<bs.length;i++){var b=bs[i],t=(b.textContent||b.value||'').trim();if(/^save$/i.test(t))bind(b)}
}
// Pending-submission placeholder: we just Saved a change; show "Loading status…" (not the stale cached
// value) while the write + poll resolve, then rebuild with the true status.
function actLoading(panel,d,ext,email,r,pend){
var fs=document.createElement('div');fs.id='_svx_act';fs.style.marginTop='20px';
var lg=document.createElement('legend');lg.textContent=_KC.label+' Status';fs.appendChild(lg);
var cl=document.createElement('label');cl.className='control-label';cl.textContent='Status';
var cc=document.createElement('div');cc.className='controls';
var wc=document.createElement('label');wc.className='checkbox';
var sp=document.createElement('span');sp.textContent='Loading updated activation status…';sp.style.cssText='color:#888;font-style:italic';
wc.appendChild(sp);cc.appendChild(wc);
fs.appendChild(cl);fs.appendChild(cc);
var anchor=null,lgs=panel.querySelectorAll('legend');for(var i=0;i<lgs.length;i++){if(/caller id/i.test(lgs[i].textContent||'')){anchor=lgs[i].closest('fieldset')||lgs[i];break}}
if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(fs,anchor);else panel.appendChild(fs);
hookSave(d,ext);
function done(r2){rebuildAct(panel,d,ext,email,r2?{active:r2.active,status:r2.status,eligibility:r&&r.eligibility}:r)}
jpost('/rapp/activate',{domain:d,ext:ext,activate:pend}).then(function(){pollUntil(d,ext,pend,done)}).catch(function(){done(null)});
}
function actSection(panel,d,ext,email,r,noRefresh){
if(document.getElementById('_svx_act'))return;
// No app org bound to this domain ⇒ render NOTHING. On /rapp/user, active means "org present" (NOT
// "user activated"), so a domain that doesn't run the app was still getting a full App Status block
// reading "Inactive" — an app it cannot have, offered to whoever could see the profile. A degraded
// org read lands here too, which is the right way to fail: say less rather than claim a state.
if(!r||!r.active)return;
if(!noRefresh){var _p=getPend(d,ext);if(_p!==null&&(!!(r&&r.status&&r.status.activated))!==_p){actLoading(panel,d,ext,email,r,_p);return}}
var active=!!(r&&r.status&&r.status.activated),canAct=!!_AF.activate,canReset=!!_AF.resetPassword;
// Only when we KNOW it will provision: a not-activated user whose app-access mode resolved to 'sso'
// means SSO is on AND create-on-login is enabled AND they're eligible (see resolveAppAccess). Absent
// projection / any other mode ⇒ leave a plain 'Inactive'.
var willAuto=!!(r&&r.appAccess&&r.appAccess.mode==='sso'&&!active);
var fs=document.createElement('div');fs.id='_svx_act';fs.style.marginTop='20px';
var lg=document.createElement('legend');lg.textContent=_KC.label+' Status';fs.appendChild(lg);
var cl=document.createElement('label');cl.className='control-label';cl.textContent='Status';
var cc=document.createElement('div');cc.className='controls';
var wc=document.createElement('label');wc.className='checkbox';
var chk=document.createElement('input');chk.type='checkbox';chk.id='_svx_act_tgl';chk.checked=active;chk.setAttribute('data-init',active?'1':'0');var init=active;
var st=document.createElement('span');st.style.fontWeight='bold';st.style.marginLeft='8px';
function setL(){if(chk.checked){st.textContent=(chk.checked===init)?'Activated':'Activate on Save (creates and emails a new password)';st.style.color='green'}else if(chk.checked===init){st.textContent=willAuto?'Inactive (will auto-activate on login)':'Inactive';st.style.color=''}else{st.textContent='Deactivate on Save (reactivation creates and emails a new password)';st.style.color='#c0392b'}}
setL();
var elig=r&&r.eligibility,dis=false,tip='',showForce=false;
if(!canAct){dis=true;tip='Contact an administrator to change this.'}
else if(masq()){dis=true;tip='Cannot change activation while masquerading.'}
else if(!email&&!active){dis=true;tip='An email address is required to activate.'}
else if(!active&&elig&&!elig.activatable){dis=true;tip=(elig.reasons&&elig.reasons.length)?elig.reasons.join('; '):'This user is not eligible for activation.';if(elig.tier==='soft'&&_isRes())showForce=true}
if(dis){chk.disabled=true;wc.style.opacity='.6';st.style.opacity='.6';wc.title=tip}
chk.addEventListener('change',setL);
wc.appendChild(chk);wc.appendChild(st);cc.appendChild(wc);
// Shown while masquerading, but DISABLED — matching the activation checkbox above rather than
// vanishing. Two reasons it must not just disappear: a control that silently absents itself reads as
// "this user cannot be reset" instead of "you cannot do this from here", and under a mask the portal
// withholds Change Account Security entirely, so email is blank because it is UNREADABLE, not
// because it is unset — the 'requires an email' wording below would be an outright wrong explanation.
// Mask check therefore comes FIRST. (The server-side write is unaffected: emailForWrite() in worker.ts
// refuses to read a masked blank as a removal.)
if(canReset&&active){
var rb=document.createElement('button');rb.type='button';rb.className='btn btn-default';rb.textContent='Reset '+_KC.label+' Password';rb.style.cssText='display:block;margin-top:8px';
// The tooltip goes on a WRAPPER, not on the button: a disabled control receives no mouse events, so its
// own title never renders. Same trick the activation checkbox uses (title on the enclosing label, not on
// the disabled input) — without it the greyed button would explain nothing on hover.
var rw=document.createElement('span');rw.style.display='block';var rtip='';
if(masq()){rtip='Cannot reset the password while masquerading.'}
else if(!email){rtip='An email address is required.'}
if(rtip){rb.disabled=true;rb.title=rtip;rw.title=rtip;rw.style.opacity='.6'}
rb.addEventListener('click',function(){if(!confirm('Reset the '+_KC.label+' password and email a new one to the user?'))return;rb.disabled=true;rb.textContent='Resetting…';jpost('/rapp/resetPassword',{domain:d,ext:ext}).then(function(){rb.textContent='Password reset — emailed'}).catch(function(){rb.textContent='Reset failed';rb.disabled=false})});
rw.appendChild(rb);cc.appendChild(rw);
}
if(showForce){
var fb=document.createElement('button');fb.type='button';fb.textContent='Force-activate App';fb.title=tip;
fb.style.cssText='display:block;margin-top:8px;background:#f5f5f5;color:#333;border:1px solid #e8930c;border-radius:4px;padding:4px 10px;cursor:pointer';
fb.addEventListener('click',function(){if(!confirm('Force-activate '+_KC.label+' for this user, overriding the exclusion?'))return;fb.disabled=true;fb.textContent='Activating…';jpost('/rapp/activate',{domain:d,ext:ext,activate:true,force:true}).then(function(){pollUntil(d,ext,true,function(r2){if(r2&&r2.status&&r2.status.activated){rebuildAct(panel,d,ext,email,{active:r2.active,status:r2.status,eligibility:r&&r.eligibility})}else{fb.textContent='Activated — reload to refresh'}})}).catch(function(e){fb.disabled=false;fb.textContent='Force-activate App';alert('Force-activate failed: '+(e&&e.message?e.message:e))})});
cc.appendChild(fb);
}
// Which app connection this record sits on -- an operator looking at a user who cannot sign in needs
// this before anything else makes sense. A conflict (records on two DIFFERENT connections) reads as a
// problem, same red as the disabled-control messaging above; a plain connection name is neutral info.
if(r&&r.status&&(r.status.warning||r.status.connection)){
var cn=document.createElement('div');cn.style.cssText='font-size:12px;margin-top:6px;color:'+(r.status.warning?'#c0392b':'#6b747c');
cn.textContent=r.status.warning?'Connection conflict — this extension has records on more than one connection.':'Connection: '+r.status.connection;
cc.appendChild(cn);
}
fs.appendChild(cl);fs.appendChild(cc);
// User-visible app sign-in message — the SAME projection + verbiage the user sees (r.appAccess from
// /rapp/user, rendered via the shared aaModel), so the operator sees a masqueraded copy. Gated on
// ringotel.profileAppAccess. Absent when the write-poll reconstructs r (r.appAccess dropped) ⇒ hidden
// until reload rather than showing a stale message.
if(_AF.profileAppAccess&&r&&r.appAccess&&r.appAccess.present){var aa=r.appAccess,AL=_KC.label;
var hd=document.createElement('div');hd.textContent='User-visible '+AL+' sign-in message:';
hd.style.cssText='margin-top:12px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#8a9199';
// Align with the form's value column (.controls indents past the label column), and frame the message
// in a light border so it reads as "the user's own view", distinct from the operator's controls above.
var actl=document.createElement('div');actl.className='controls';actl.appendChild(hd);
var abox=document.createElement('div');abox.style.cssText='display:inline-block;border:1px solid #d5d9dd;border-radius:5px;padding:9px 12px;background:#fafbfc;min-width:240px;margin-top:4px';
var awrap=document.createElement('div');awrap.style.cssText='display:grid;gap:10px;text-align:left';
var amdl=aaModel(aa,AL);
if(amdl.signable){amdl.fields.forEach(function(f){var dd=document.createElement('div');
var kk=document.createElement('div');kk.textContent=f.k;kk.style.cssText='font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#8a9199';
var vr=document.createElement('div');vr.style.cssText='display:flex;align-items:center;gap:6px;margin-top:1px';
var vv=document.createElement('span');vv.textContent=f.v;vv.style.cssText='font-size:13.5px;color:#1a1d21;word-break:break-all';vr.appendChild(vv);
if(f.copy&&f.v)vr.appendChild(copyBtn(f.v,f.k));
dd.appendChild(kk);dd.appendChild(vr);
if(f.hint){var hh=document.createElement('div');hh.textContent=f.hint;hh.style.cssText='font-size:12px;margin-top:2px;color:'+(f.warn?'#8a6d3b':'#6b747c');dd.appendChild(hh)}
awrap.appendChild(dd)})}
else if(amdl.advisory){var av=document.createElement('div');av.textContent=amdl.advisory.t;av.style.cssText='font-size:12.5px;color:#8a6d3b';awrap.appendChild(av)}
abox.appendChild(awrap);
var adv=document.createElement('div');adv.style.cssText='display:flex;gap:12px;flex-wrap:wrap;margin-top:8px';aaDownloads(adv,true);if(adv.children.length)abox.appendChild(adv);
actl.appendChild(abox);fs.appendChild(actl)}
var anchor=null,lgs=panel.querySelectorAll('legend');for(var i=0;i<lgs.length;i++){if(/caller id/i.test(lgs[i].textContent||'')){anchor=lgs[i].closest('fieldset')||lgs[i];break}}
if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(fs,anchor);else panel.appendChild(fs);
hookSave(d,ext);
}
// After a write settles, re-read the section from /rapp/user (non-fresh: the activate/reset write
// invalidated the org-users cache, so this returns the TRUE post-write status AND the app-access
// projection). Gives the operator the updated user-visible message without a page reload; on a read
// failure it falls back to the reconstructed r (status only, no message — the pre-fix behavior).
function rebuildAct(panel,d,ext,email,fallback){
function show(rr){var s=document.getElementById('_svx_act');if(s)s.remove();actSection(panel,d,ext,email,rr,true)}
jget('/rapp/user?domain='+encodeURIComponent(d)+'&ext='+encodeURIComponent(ext)).then(show,function(){show(fallback)})}
var _actSched=false;
function profileActivation(){
if(!_AF.profileStatus)return;
if(_actSched||document.getElementById('_svx_act'))return;
var panel=document.querySelector('.profile-panel-main');if(!panel)return;
var d=dom();if(!d)return;var ext=profExt();if(!ext)return;
_actSched=true;var email=profEmail();
// FRESH on load, not cached. The cached org-user list is ~10 minutes old and is invalidated only by
// OUR OWN writes -- so a plain reload, or any change made elsewhere (in the Ringotel admin, or by the
// SSO worker provisioning a user on first login), showed the pre-change state here for up to the TTL.
// Bounded cost: one getUsers per profile view, which is precisely the page where someone is mid-change.
// The bulk users LIST deliberately stays cached; it gets a visible age + refresh control instead.
// poll=1 is NOT set, so the eligibility + app-access reads still happen -- see the two flags in
// worker.ts's /rapp/user route.
jget('/rapp/user?domain='+encodeURIComponent(d)+'&ext='+encodeURIComponent(ext)+'&fresh=1').then(function(r){_actSched=false;actSection(panel,d,ext,email,r)}).catch(function(){_actSched=false});
}
var F=[
{p:/^\//,m:banner},
{p:/^\/portal\/inventory/,m:inv,a:cfAud},
{p:/^\/portal\/callqueues/,m:cq,a:cfAud},
{p:/^\/portal\/attendants\/edit/,m:aae,a:cfAud},
{p:/^\/portal\/attendants\/?($|index)/,m:aa,a:cfAud},
{p:/^\/portal\/users\/?($|index)/,m:usr,a:cfAud},
{p:/^\/portal\/users\/?($|index)/,m:usersCol},
{p:/^\/portal\/(users|answerrules|phones)/,m:usredit,a:cfAud},
{p:/^\/portal\/domains\/?($|index)/,m:domCol,a:resList},
// Installed on both list pages, once (self-guarded). No activation gate here -- the handler decides per click, so a
// policy flag read at install time can't go stale against the page it fires on.
{p:/^\/portal\/(domains|users)\/?($|index)/,m:pgRefresh},
{p:/^\/portal\//,m:profileActivation,a:function(){return !!_AF.profileStatus}}
];
function run(){for(var i=0;i<F.length;i++){try{var f=F[i];if(f.p.test(location.pathname)&&(!f.a||f.a()))f.m()}catch(e){}}}
var raf=0;function sched(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;run()})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
var ob=new MutationObserver(sched);ob.observe(document.documentElement,{childList:true,subtree:true});
setTimeout(function(){ob.disconnect()},8000);`;

/** The SELF feature body: own-account features. Neutral — the label comes from `_KC` (post-auth), every
 * gate is an `_AF.<flag>` flag, selectors are generic Manager-Portal DOM. `me.appStatus` renders the
 * home widget (status + `me.appAccess` sign-in details/downloads, reusing `aaFetch`) and `me.appAccess`
 * also renders the Apps-menu rows; `me.devices`/`me.resetPassword` are server-only until exposed. */
const KIT_SELF_BODY = String.raw`
function homeStatus(){
if(!_AF.appStatus)return;
if(document.getElementById('_svx_home'))return;
if(!/^\/portal\/home/.test(location.pathname))return;
var panel=document.querySelector('.phones-panel-home');if(!panel)return;
if(homeStatus._p)return;homeStatus._p=1;
jget('/me/status').then(function(r){
homeStatus._p=0;
if(!r||!r.present)return;
if(document.getElementById('_svx_home'))return;
var panel2=document.querySelector('.phones-panel-home');if(!panel2)return;
var card=document.createElement('div');card.id='_svx_home';card.className='softphone-panel-home rounded show';card.style.marginTop='10px';
var h=document.createElement('h6');h.textContent=_KC.label+' Status';
var bd=document.createElement('div');bd.style.cssText='display:flex;align-items:center;justify-content:center;min-height:50px';
var pp=document.createElement('p');var st=document.createElement('strong');
if(r.active){st.textContent='Activated';st.style.color='green'}else{st.textContent='Inactive';st.style.color='black'}
pp.appendChild(st);bd.appendChild(pp);card.appendChild(h);card.appendChild(bd);
panel2.parentNode.insertBefore(card,panel2.nextSibling);
if(_AF.appAccess){aaFetch(function(r2){
if(!r2||!r2.present)return;
if(document.getElementById('_svx_home')!==card)return;
// Not activated but the mode resolved to 'sso' ⇒ SSO + create-on-login: it activates on first sign-in,
// so 'Inactive' alone is misleading. (Same signal the profile view uses.)
if(!r.active&&r2.mode==='sso'){st.textContent='Inactive (will auto-activate on login)'}
var wrap=document.createElement('div');wrap.style.cssText='display:grid;gap:11px;margin:12px 0 14px;text-align:left';
function fld(k,v,hint,warn){var d=document.createElement('div');
var kk=document.createElement('div');kk.textContent=k;
kk.style.cssText='font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#8a9199';
var vv=document.createElement('div');vv.textContent=v;
vv.style.cssText='font-size:13.5px;color:#1a1d21;word-break:break-all;margin-top:1px';
d.appendChild(kk);d.appendChild(vv);
if(hint){var hh=document.createElement('div');hh.textContent=hint;
hh.style.cssText='font-size:12px;margin-top:2px;color:'+(warn?'#8a6d3b':'#6b747c');d.appendChild(hh)}
return d}
var mdl=aaModel(r2,_KC.label);
if(mdl.signable){mdl.fields.forEach(function(f){wrap.appendChild(fld(f.k,f.v,f.hint,f.warn))});card.appendChild(wrap)}
if((_KC.dl||[]).length){var br=document.createElement('div');br.style.cssText='display:flex;gap:12px;flex-wrap:wrap;justify-content:center';
aaDownloads(br,true);card.appendChild(br)}
})}
}).catch(function(){homeStatus._p=0});
}
var _aaP=null;
// Memoise the IN-FLIGHT PROMISE, not the resolved value: two callers arriving before the first
// response (the Apps menu + the home card both call this on /portal/home) must share ONE request —
// /me/app-access makes three uncached upstream calls, so a duplicate is expensive. On failure,
// null out _aaP so the next call retries (a transient error shouldn't wedge this open forever);
// callers attached to the failed promise are swallowed, same as before.
function aaFetch(cb){if(!_aaP)_aaP=jget('/me/app-access').catch(function(e){_aaP=null;throw e});_aaP.then(cb,function(){})}
function row(k,v,hint,copy){
var li=document.createElement('li');li.className='_svxrow';
li.style.cssText='display:grid;grid-template-columns:62px 1fr 20px;gap:8px;align-items:baseline;padding:2px 14px 2px 16px;font-size:12.5px';
var ks=document.createElement('span');ks.textContent=k;ks.style.color='#999';
var vs=document.createElement('span');vs.textContent=v;vs.style.cssText='color:#1a1d21;word-break:break-all'+(copy?';font-family:monospace':'');
li.appendChild(ks);li.appendChild(vs);
if(copy){li.appendChild(copyBtn(v,k))}else{li.appendChild(document.createElement('span'))}
return li}
function note(t,warn){var li=document.createElement('li');li.className='_svxrow';
li.style.cssText='padding:1px 16px 6px;font-size:11.5px;color:'+(warn?'#8a6d3b':'#8a9199');
li.textContent=t;return li}
function sep(){var li=document.createElement('li');li.className='divider _svxrow';return li}
// The user's own name dropdown in the toolbar. Unlike the Apps menu it has NO id and wears a generic
// Bootstrap class (dropdown-menu pull-right) that other dropdowns share, so it is identified by CONTENT:
// the toolbar dropdown holding the profile link, or failing that a Log Out entry. Its items vary by scope
// and mode (My Account / Profile / Messages, plus whatever a vendor add-on injects for admins), which
function accountMenu(){
if(!_AF.menuConfig)return;
var ul=acctUl();if(!ul||ul.dataset.svxacct)return;
aaFetch(function(r){
var plan=r&&r.menus&&r.menus.account;if(!plan)return;
if(!(plan.hide||[]).length&&!(plan.add||[]).length)return;
var u=acctUl();if(!u||u.dataset.svxacct)return;u.dataset.svxacct='1';
// KNOWN LIMITATION (found 2026-08-08, not yet fixed): this guard makes the whole pass one-shot, hides
// included. The account menu is filled by several sources — stock entries, the vendor add-on (it adds
// its own entries), and this kit — and every one of them loads async, so an entry that arrives AFTER this
// pass is never hidden. That is load-order-dependent, which means it can work in testing and fail
// intermittently in production. The fix is to split the guard the way the model already splits the lists:
// adds stay one-shot (repeating them would duplicate entries), hides re-run on mutation (they are
// idempotent — setting display:none twice is setting it once). Deliberately not done in the same pass that
// discovered it; see item 37 in the open-items index.
// Insert into the FIRST group — above the divider that precedes Log Out — rather than after it.
var lo=null,ch=u.children;
for(var i=0;i<ch.length;i++){if(/^log\s*out\b/i.test((ch[i].textContent||'').trim())){lo=ch[i];break}}
var before=lo;
if(before&&before.previousElementSibling&&/divider/.test(before.previousElementSibling.className||''))before=before.previousElementSibling;
menuApply(u,plan,before)})}
function managementMenu(){
if(!_AF.menuConfig)return;
var ul=mgmtUl();if(!ul||ul.dataset.svxmgmt)return;
aaFetch(function(r){
var plan=r&&r.menus&&r.menus.management;if(!plan)return;
if(!(plan.hide||[]).length&&!(plan.add||[]).length)return;
var u=mgmtUl();if(!u||u.dataset.svxmgmt)return;u.dataset.svxmgmt='1';
// Appended at the END: this menu has no trailing sign-out to sit above, and an added tool belongs
// after the portal's own entries rather than jumping ahead of them.
menuApply(u,plan,null)})}
function appsMenu(){
// Two independent surfaces share this menu: menu customization (menuConfig) and the sign-in panel
// (appAccess). Either alone is a reason to touch the menu.
if(!_AF.appAccess&&!_AF.menuConfig)return;
var ul=appsUl();if(!ul||ul.dataset.svx)return;
aaFetch(function(r){
if(!ul||ul.dataset.svx)return;ul.dataset.svx='1';
// ONE guard on the <ul>, not per row. Bootstrap's dropdown closes on a document-level click, and a
// click's target is the nearest common ancestor of mousedown and mouseup — so selecting text inside a
// row and releasing outside it resolves the target to the <ul>, ABOVE any per-row listener, and the
// menu closes. Verified live 2026-07-21. Stock items are all <a href> and SHOULD close+navigate;
// everything else (our rows, the copy buttons, an ancestor-resolved click) is swallowed.
ul.addEventListener('click',function(e){if(!e.target.closest('a[href]'))e.stopPropagation()});
// Menu customization is independent of whether the domain runs the app — a domain served by another
// app, or none, still gets its curated menu. The server resolved which entries apply to THIS user.
var plan=(r.menus&&r.menus.apps)||{hide:(r.hide||[]),add:[]};
// Divider before any appended group, so added entries read as ours rather than stock ones.
if((plan.add||[]).length)ul.appendChild(sep());
menuApply(ul,plan,null);
if(!_AF.appAccess||!r.present)return;
var L=_KC.label;
// Widen the dropdown: the stock menu is sized for one-word labels, so a username like
// 100@acme wraps mid-token at Bootstrap's default width. 300px fits a typical login; a very
// long NS login still word-breaks rather than overflowing. Only when we add sign-in content.
ul.style.minWidth='300px';
// Download FIRST — getting the app is the common errand.
if((_KC.dl||[]).length){ul.appendChild(sep());aaDownloads(ul,false)}
ul.appendChild(sep());
var h=document.createElement('li');h.className='_svxrow';
h.style.cssText='padding:6px 16px 3px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#999';
h.textContent='Sign in to '+L;ul.appendChild(h);
var mdl=aaModel(r,L);
if(mdl.signable){mdl.fields.forEach(function(f){ul.appendChild(row(f.k,f.v,null,f.copy));ul.appendChild(note(f.hint,f.warn))})}
else{ul.appendChild(note(mdl.advisory.t,true))}
})}
// ── The status banner (portal.statusBanner) ──
// The message comes from an endpoint the OPERATOR hosts, asked once per page load. The kit holds no
// message store and makes no eligibility decision — it sends who is asking and shows what comes back.
//
// TEXT, never markup. The content is remote and it renders for every signed-in user, which is the exact
// shape where an innerHTML would be an injection vector reachable by whoever controls (or compromises) that
// endpoint. No sanitizer is as safe as not parsing HTML at all, and this repo already forbids innerHTML in
// injected code. A banner that cannot be bold is a fair price.
//
// The request carries the caller's own ns_t so the endpoint can decide what this person should see. That is
// a live credential leaving for a configured URL, which is why the Worker refuses a non-https endpoint and
// why the setting's documentation says to point it only at something you control.
// Render a status message that MAY contain HTML, without ever handing markup to innerHTML.
//
// The operator controls this endpoint, so the content is as trusted as their own config — that is David's
// argument and it holds. But his own code already sanitized rather than trusting the response raw, and this
// is the better version of that instinct: parse in an INERT document, then copy across only the tags and
// attributes a support message needs. Script cannot execute because nothing script-bearing is ever copied,
// which makes the guarantee structural rather than a matter of everyone remembering the rule.
//
// DOMParser does not run scripts and does not fire load handlers, so the parse itself is safe; the danger
// would be adopting parsed nodes wholesale, since an onerror attribute becomes live the moment its node
// enters the document. Copying attribute-by-attribute is what avoids that.
var BAN_TAGS={A:1,B:1,STRONG:1,I:1,EM:1,U:1,BR:1,SPAN:1,P:1,SMALL:1,CODE:1};
function bannerHtml(host,html){
var doc=null;try{doc=new DOMParser().parseFromString(String(html),'text/html')}catch(e){}
if(!doc||!doc.body){host.textContent=String(html);return}
(function copy(from,to){
for(var n=from.firstChild;n;n=n.nextSibling){
if(n.nodeType===3){to.appendChild(document.createTextNode(n.nodeValue));continue}
if(n.nodeType!==1)continue;
if(!BAN_TAGS[n.tagName]){
// An unknown tag is UNWRAPPED, not dropped: the words inside it are the message, and silently losing
// half a sentence is worse than losing its formatting.
copy(n,to);continue}
var el=document.createElement(n.tagName.toLowerCase());
if(n.tagName==='A'){
var href=n.getAttribute('href')||'';
// Same scheme rule the menu entries use — https or mailto, nothing else can be an href here.
if(/^(https:\/\/|mailto:)/i.test(href)){el.setAttribute('href',href);el.setAttribute('target','_blank');el.setAttribute('rel','noopener noreferrer')}}
var ttl=n.getAttribute&&n.getAttribute('title');if(ttl)el.setAttribute('title',ttl);
copy(n,el);to.appendChild(el)}
}(doc.body,host))}
function statusBanner(){
if(!_KC.bw)return;
if(document.getElementById('_svxbanner'))return;
var t=tok();if(!t)return;
// Guarded once per page: this is a network call on every portal page, and a re-entrant observer pass
// would multiply it. The element check above cannot cover the in-flight window.
if(window.__svxBannerAsked)return;window.__svxBannerAsked=1;
var body={validate:t,path:location.pathname,
domain:(typeof window.current_domain!=='undefined'&&window.current_domain)||null,
scope_mode:(typeof window.scope_mode!=='undefined'&&window.scope_mode)||null,
sub_scope:(typeof window.sub_scope!=='undefined'&&window.sub_scope)||null,
user:(typeof window.sub_user!=='undefined'&&window.sub_user)||null};
fetch(_KC.bw,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
.then(function(r){return r.ok?r.text():''})
.then(function(raw){
if(!raw)return;
var msg='';
// Accept either a bare string or {message|text|banner}. An endpoint returning plain text is the
// simplest thing an operator can write, and refusing it would make the easy case the unsupported one.
// banner_message is in this list because a real endpoint returns it — accepting only the keys that
// seemed obvious meant a working webhook produced a blank banner and no error anywhere. (No backticks in
// this file's injected bodies: they live inside a template literal and one ends it.)
try{var j=JSON.parse(raw);msg=(j&&(j.message||j.banner_message||j.text||j.banner))||(typeof j==='string'?j:'')}catch(e){msg=raw}
msg=String(msg||'').trim();if(!msg)return;
if(document.getElementById('_svxbanner'))return;
var d=document.createElement('div');d.id='_svxbanner';
// Inside the portal's own header when there is one: that band is where a notice belongs on this portal,
// and pinning it to the top of <body> instead pushed the whole page down and read as a browser chrome bar.
// Normal flow rather than absolute positioning — a hand-tuned coordinate is a layout that breaks on the
// next portal change, and centred text in the header reads the same without the arithmetic.
// WHERE it goes — OVERLAID in the header, not inserted into the flow.
//
// Normal flow was the first attempt and it was wrong for a concrete reason: it adds height, so every page
// shifts down by the banner. That is worse than the arithmetic it avoided, and it is why this portal's own
// banner is absolutely positioned. The header already contains a blank strip; using it costs no layout.
//
// ONE measurement, not five. The portal's own version computes against the logo, the user menu, the nav and
// its first and last items to centre between them; centring across the full width lands in the same place
// to the eye and needs only the logo's lower edge. Fewer rects is fewer things that move under us.
//
// If the header is missing entirely — a portal shaped differently — fall back to a normal-flow bar at the
// top of the page. Shifting a page we do not recognise is better than overlaying something unknown.
var head=document.getElementById('header');
if(head){
if(getComputedStyle(head).position==='static')head.style.position='relative';
// No line clamp and no max-height: those truncate at two lines, which would fire before the shrink loop
// below ever got a chance. Shrinking to fit beats clipping a sentence.
d.style.cssText='position:absolute;z-index:2;padding:0 12px;font-weight:700;font-size:14px;line-height:1.2;color:#a11d2f;text-align:center;pointer-events:auto';
bannerHtml(d,msg);
head.appendChild(d);
// TWO PLACEMENTS, chosen by measurement, because the blank strip is not always there.
//
// Measured on the real portal at three widths (David, 2026-08-09), local to #header:
//
//   1248 wide   logo y 0..90   user y  0..60    nav y  90..199   → strip 60..90  (30px)
//   1135 wide   logo y 0..90   user y  0..60    nav y  90..199   → strip 60..90  (30px)
//    687 wide   logo y 0..90   user y 90..150   nav y 150..259   → strip is ZERO
//
// Below roughly 700px the user menu wraps onto its own row and the header stacks with nothing spare. That
// is why every fixed approach collided with something: overlay-always has nowhere to go when narrow, and
// flow-always shifts the page when there was room all along.
//
// So: OVERLAY when the message fits the strip — no layout change, the common case — and fall back to
// NORMAL FLOW when it does not, pushing the buttons down rather than striking through them. The layout
// only moves in the case that genuinely has no room.
var flowed=false;
var place=function(){try{
var hb=head.getBoundingClientRect();
var lg=document.getElementById('header-logo'),hu=document.getElementById('header-user');
var nav=document.getElementById('navigation')||document.getElementById('nav-buttons');
var top=hu?(hu.getBoundingClientRect().bottom-hb.top):0;
var strip=nav?((nav.getBoundingClientRect().top-hb.top)-top):0;
// Measure the message at the width it would occupy, not at whatever width it currently has.
// SYMMETRIC margins, both set by the logo's width. Anchoring the left to the logo and the right to the
// page edge centred the text in that lopsided box, so it read visibly off-centre — and it was: the box's
// middle was not the header's middle. Mirroring the inset makes the box centred on the header, so the text
// is centred on the PAGE, it still cannot reach the logo, and as the window narrows the box narrows evenly
// and the message wraps to a second line instead of drifting or colliding. One change, three symptoms.
var left=lg?Math.max(0,lg.getBoundingClientRect().right-hb.left+14):12;
if(!flowed){d.style.left=left+'px';d.style.right=left+'px'}
// A CONSTANT, never the element's own height. Measuring d.offsetHeight fed the decision with a value that
// DEPENDS on the decision — the flowed element is 12.5px and full width, the overlaid one 14px and inset,
// so each mode measured a different requirement, flipped, and measured again. That is what made it stutter
// during a resize and settle on whichever mode the drag happened to stop in.
//
// The strip itself is a stable input: our element sits inside #navigation when flowed, so it changes that
// element's HEIGHT but never its top, and the strip is measured from that top.
//
// HYSTERESIS, so the two thresholds cannot touch. Dropping into flow at 20 and returning to overlay only
// above 30 means a width that sits exactly on the boundary picks one and stays there.
var need=20;
if(nav&&(flowed?strip<30:strip<need+2)){
// No room: move into the flow ahead of the navigation. Idempotent — only re-parents on a change, so a
// resize storm does not thrash the DOM.
if(!flowed){flowed=true;
// NO clear:both. This header is float-based, and clearing pushed the banner below every float, inflating
// the header and shoving the whole thing down — the "weird bump" at the narrowest width. Inserted INSIDE
// the navigation, above the buttons, rather than before the nav block: that container is already a block,
// so a plain div stacks above the button row without interacting with the floats at all.
// Smaller when it lands here: this only happens at widths where the button row is already being clipped,
// so a slightly smaller message is the cheaper compromise — the same trade the portal's own banner makes.
// Full width too, with no left offset for the logo: at this vertical position the logo is a row above, so
// reserving space beside it would waste the width that lets the text stay on one line.
// Pulled UP into the whitespace that already sits above this row, so a second line grows into space the
// page was not using rather than shoving the buttons down. Deliberately NOT clamped to one line here:
// David would rather it wrap than be truncated at these widths, and wrapping upward costs nothing.
d.style.cssText='margin-top:-12px;padding:0 8px 2px;font-weight:700;font-size:12.5px;line-height:1.2;color:#a11d2f;text-align:center';
var btns=document.getElementById('nav-buttons');
if(btns&&btns.parentNode)btns.parentNode.insertBefore(d,btns);
else if(nav.parentNode)nav.parentNode.insertBefore(d,nav)}
return}
if(flowed){flowed=false;
// No line clamp and no max-height: those truncate at two lines, which would fire before the shrink loop
// below ever got a chance. Shrinking to fit beats clipping a sentence.
d.style.cssText='position:absolute;z-index:2;padding:0 12px;font-weight:700;font-size:14px;line-height:1.2;color:#a11d2f;text-align:center;pointer-events:auto';
head.appendChild(d);d.style.left=left+'px';d.style.right='12px'}
// EIGHT PIXELS ABOVE the strip's nominal top, which is deliberate rather than a fudge. The strip measures
// ~30px (menu row ends at 60, buttons begin at 90) and a two-line message needs ~34, so anchored at 60 it
// ends at 94 and clips the buttons. The menu row's own text does not reach its lower edge, so borrowing
// that slack fits two lines at 52..86 — clear of the buttons — and lifts the one-line case a touch too,
// which is where it looked low.
d.style.top=Math.max(0,top-8)+'px';
// SHRINK TO FIT rather than clip. Two lines fit the borrowed strip at 14px; a longer message needs three,
// and truncating a status notice mid-sentence is the one outcome a status notice must not have.
//
// Safe to measure the element here, even though measuring it is exactly what caused the resize stutter
// earlier: that fed the element's height into the MODE decision, so the decision changed its own input.
// This only chooses a font size WITHIN a mode — the mode is already settled from the strip and a constant —
// so there is no path back. Reset to 14 first, or it ratchets down and never recovers on a widen.
var room=nav?((nav.getBoundingClientRect().top-hb.top)-(Math.max(0,top-8))):999;
d.style.fontSize='14px';
for(var fs=14;fs>10&&d.offsetHeight>room;fs--)d.style.fontSize=fs+'px'}catch(e){}};
place();
// Re-measured on resize because the strip appears and disappears with the wrap.
window.addEventListener('resize',place)}
else{
d.style.cssText='padding:8px 14px;background:#e8f2fb;border-bottom:1px solid #b8d4ea;color:#123;font-weight:700;font-size:14px;line-height:1.4;text-align:center';
bannerHtml(d,msg);
var b=document.body;if(b)b.insertBefore(d,b.firstChild)}})
.catch(function(){})}
// ── The footer version line (portal.versionLine) ──
// Joined onto the footer's LAST paragraph with the same separator the platform's own version entries use,
// rather than added as a line of its own: this is one more entry in an existing row, and a portal footer
// is not worth another line of page height. The last paragraph is the version row whether or not a vendor
// add-on has put its own entry there — the platform's version sits on it either way.
// Our content is one <span> so the whole entry can be found, and so a vendor re-render that replaces the
// paragraph simply drops it and the observer puts it back, rather than leaving a half-entry behind.
// The link is absent from the page for anyone below reseller — not disabled, so there is nothing to
// re-enable — and absent for everyone when the deployment has declared PORTAL_RELEASE_NOTES_URL empty.
// No footer, or no version config, means nothing is added: the least consequential thing the kit does
// should be the quietest to fail.
// REMOVE A FOSSIL OF OUR OWN ENTRY, which is what the reported "duplicate version line" actually was.
// Mechanism, from a live footer capture (2026-08-09): we append our span to the platform's version row,
// and the vendor's release-notes widget LATER rebuilds that row from its textContent. That inlines our
// words into the vendor's own anchor as plain characters and destroys our span, so what remains has no
// class on it and the dedupe below cannot see it. The next pass finds zero entries and adds a fresh one
// to the new last version row, leaving one live entry plus a fossil that reads exactly like a duplicate.
// The capture named itself: the fossil's separator was our box-drawing bar while the platform's own is a
// pipe, and only we emit the former.
//
// We put those characters on the page, so taking them back out is repairing our own damage rather than
// editing someone else's content. The match is anchored on our exact product name and version, which
// nothing else on the page emits, and it takes the separator with it. Both separators are matched: a
// page rendered before this version fossilised the old bar, and it should still heal.
//
// This is also what makes writing early SAFE. The alternative was to defer until the footer settled,
// which trades a duplicate for a race against a vendor whose timing we do not control -- and would show
// nothing at all on a portal where that vendor never loads. Clean-then-ensure is idempotent, so the
// early write can simply be corrected.
function vlFossil(f,txt){
// '$' sits at the END of this character class on purpose. A dollar immediately followed by an open
// brace opens a template substitution inside a String.raw body, so writing the class in its natural
// order breaks the file -- and TypeScript then reports it dozens of lines away, never at the cause.
// Same family as a backtick in one of these bodies. Writing THIS comment cost a compile too: the
// sequence breaks the literal from inside a comment just as readily, which is why it is described
// here in words instead of quoted.
var esc=txt.replace(/[.*+?^{}()|[\]\\$]/g,'\\$&');
var re=new RegExp('[\\s\\u00a0]*[|\\u2502][\\s\\u00a0]*'+esc,'g');
var w=document.createTreeWalker(f,NodeFilter.SHOW_TEXT,null,false),n,hit=[];
while((n=w.nextNode())){
// Never touch text inside our own span -- that one IS the live entry.
var own=false;
for(var q=n.parentNode;q&&q!==f;q=q.parentNode){
if(q.className&&String(q.className).indexOf('_svxver')>=0){own=true;break}}
re.lastIndex=0;
if(!own&&re.test(n.nodeValue||'')){hit.push(n)}}
for(var h=0;h<hit.length;h++){re.lastIndex=0;hit[h].nodeValue=hit[h].nodeValue.replace(re,'')}}
function verLine(){
var f=document.getElementById('footer');if(!f)return;
var v=_KC.vl;if(!v)return;
// Clean before measuring: a fossil carries a version pair, so leaving it in place would let a row that
// only LOOKS like a version row win the host election below.
vlFossil(f,v.name+': '+v.ver);
// TARGET THE VERSION ROW, not "the last paragraph". The old heuristic produced a DUPLICATE line in
// production, and the race behind it is worth remembering: a vendor add-on appends its own version row
// asynchronously, so "the last paragraph" resolves to the Powered-by line when we run first and to the
// version row when we run second. One rule, two destinations, decided by load order. A version row is
// identified by CARRYING a version pair, which is what that row is, rather than by where it sits.
var ps=f.getElementsByTagName('p'),host=null;
for(var i=ps.length-1;i>=0;i--){if(/:\s*\d+\.\d+/.test(ps[i].textContent||'')){host=ps[i];break}}
// SELF-HEALING, and document-wide rather than scoped to the row we picked: whatever produced a duplicate,
// the invariant is ONE entry on the page. If exactly one exists and it is already in the right row, leave
// it alone; otherwise remove every instance and insert one. A stray copy is then corrected on the next
// observer pass instead of persisting until reload.
var old=f.querySelectorAll('._svxver');
if(old.length===1&&host&&old[0].parentNode===host)return;
for(var k=0;k<old.length;k++){if(old[k].parentNode)old[k].parentNode.removeChild(old[k])}
// No version row yet? Do nothing and let the observer try again. Falling back to the Powered-by line is
// what stranded the entry in the wrong paragraph in the first place.
if(!host)return;
var txt=v.name+': '+v.ver,inner;
// Below reseller this is a text node, not a link -- absent from the page rather than disabled, which
// matches the platform: an Office Manager's own version row is plain text there too.
if(v.url&&_isRes()){inner=document.createElement('a');inner.href=v.url;inner.target='_blank';inner.rel='noopener noreferrer';inner.textContent=txt}
else{inner=document.createTextNode(txt)}
var sp=document.createElement('span');sp.className='_svxver';
// The platform's own separator, byte for byte: NBSP, pipe, NBSP -- it renders '&nbsp;|&nbsp;' between its
// footer entries, confirmed from a live capture. This used to emit '\u2502' (BOX DRAWINGS LIGHT VERTICAL)
// with ordinary spaces while the comment above claimed it matched the platform; on a real footer the
// mismatch was plain, our taller heavier bar beside the portal's thin pipe in the same row. An entry
// appended to someone else's row should be indistinguishable from the entries already there.
// Written as escapes, not literals, so the emitted bundle stays pure ASCII and decodes identically
// whatever charset the response or host page is read as -- a literal did not (a mock server without
// charset=utf-8 rendered it as mojibake). NBSP also stops the separator wrapping to its own line.
// MATCH THE PORTAL'S OWN SEPARATOR, by reading it off the page rather than pinning values. Measured on
// a live footer: ours inherited the version row's 10px #a2a2a2 while the portal's separator between
// entries is 13px #333, because theirs is a SIBLING of the paragraphs and ours is inside one. Two pipes
// a few characters apart, visibly different weights. These are the operator's portal styles; hardcoding
// them here would bake one deployment's theme into a kit that ships to others, and would go stale the
// first time they restyle a footer.
//
// Found structurally, not by id: a sibling element whose ENTIRE text is a separator. Keying off the
// vendor container's name would couple this to one add-on and break on a portal without it.
var bar=document.createElement('span');
bar.appendChild(document.createTextNode('\u00a0|\u00a0'));
sp.appendChild(bar);sp.appendChild(inner);host.appendChild(sp);
// STYLE AFTER INSERTION, because the reference has to be measured in place -- and which reference is
// right depends on what else is in the row.
//
// With the vendor add-on present the row already contains a separator of its own, and ours should be
// indistinguishable from it: copy both colour and size. Without the add-on there is no separator to
// match, and the row is the platform's PLAIN TEXT while our entry is a link -- which the portal styles
// larger. Inheriting the row then rendered a 10px pipe against our own 13px link and read as a mistake.
//
// With no separator to copy, the size is scaled RELATIVELY and the colour is left alone. Inheriting the
// row outright produced a 10px pipe beside our own 13px link and read as a bug; the stock portal's own
// separator is 1.3x its row, so that ratio is the fallback. Relative rather than pinned pixels, so it
// tracks whatever base size the operator's footer uses instead of assuming ours. Colour stays inherited
// on purpose: a pinned one is the value that goes wrong on a portal themed unlike the stock one, and
// punctuation reading as body text is right on every theme.
var BAR_SCALE='130%';
var par=host.parentNode,kids=par?par.children:null,ref=null;
for(var r=0;kids&&r<kids.length;r++){
if(kids[r].tagName==='SPAN'&&/^[\s\u00a0]*[|\u2502][\s\u00a0]*$/.test(kids[r].textContent||'')){ref=kids[r];break}}
var cs=ref?getComputedStyle(ref):null;
if(cs){bar.style.color=cs.color;bar.style.fontSize=cs.fontSize}else{bar.style.fontSize=BAR_SCALE}}
var F=[{p:/^\/portal\/home/,m:homeStatus,a:function(){return !!_AF.appStatus}},
{p:/^\//,m:appsMenu,a:function(){return !!_AF.appAccess||!!_AF.menuConfig}},
{p:/^\//,m:accountMenu,a:function(){return !!_AF.menuConfig}},
{p:/^\//,m:managementMenu,a:function(){return !!_AF.menuConfig}},
{p:/^\//,m:verLine,a:function(){return !!_AF.versionLine}},
// EVERY portal page. The predecessor this replaced gated client-side to six paths — /portal/home,
// /portal/users*, /portal/domains, /portal/siptrunks, /portal/callhistory, /portal/inventory — and David's
// recollection (2026-08-09) is that this was "maybe not bothering with the other pages", not a decision
// worth preserving. A status notice that appears on some pages and not others is the kind of inconsistency
// people learn to distrust, so it now runs everywhere and the endpoint decides.
//
// The trade, recorded because it is real: one webhook call per portal page load rather than six page types.
// If that volume ever matters, the endpoint already receives the path and can answer empty, or the six
// above are here to be turned into a setting.
{p:/^\//,m:statusBanner,a:function(){return !!_AF.statusBanner}}];
function run(){for(var i=0;i<F.length;i++){try{var f=F[i];if(f.p.test(location.pathname)&&(!f.a||f.a()))f.m()}catch(e){}}}
var raf=0;function sched(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;run()})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
var ob=new MutationObserver(sched);ob.observe(document.documentElement,{childList:true,subtree:true});
setTimeout(function(){ob.disconnect()},8000);
// THE FOOTER OUTLIVES THE OBSERVER, so the version line gets its own late passes.
// The vendor's release-notes widget rebuilds the footer whenever it happens to finish, and when that
// lands after the 8s disconnect above, nothing runs again and the fossil it makes of our entry stays
// until reload. That is the state the reported duplicate was captured in.
//
// Only verLine re-runs, and only it should: it is idempotent by construction -- it cleans, then ensures
// exactly one entry -- so a late pass either changes nothing or repairs something. The menus and the
// banner are deliberately one-shot (repeating an add duplicates it), so widening the observer window for
// everyone would change their behaviour to fix this one.
var VLT=[2000,5000,12000,25000];
for(var vi=0;vi<VLT.length;vi++)setTimeout(function(){try{if(_AF.versionLine)verLine()}catch(e){}},VLT[vi]);`;

/** Shared bundle preamble: the `(function(){ _AF; _KC; base; <body> }())` wrapper. `featureKeys` is the
 * flag↔key map for THIS bundle (admin vs self); `allowedKeys` is already `can()`-filtered by the caller,
 * so this is a pure fn of its inputs and the per-tier cache key covers everything. Label rides `_KC`
 * (post-auth) — never a literal, so the served bytes stay neutral/mirror-safe. `appBase` requires https
 * so a misconfigured value can't inject a `javascript:` href. */
/** Strip whole-line comment lines from the injected body before serving. Source keeps its comments for
 * maintainability; the client does not need the prose. Only lines whose first non-space characters are a
 * line comment are dropped — never a trailing comment — so a mid-line double-slash inside a string,
 * regex, or URL is left untouched. Blank runs left behind collapse. Not a minifier: no rename or join. */
function stripLineComments(js: string): string {
  const isFullLineComment = (ln: string): boolean => ln.replace(/^\s+/, '').slice(0, 2) === '//';
  return js.split('\n').filter((ln) => !isFullLineComment(ln)).join('\n').replace(/\n\n+/g, '\n');
}

function wrapBundle(featureKeys: ReadonlyArray<{ flag: string; key: string }>, allowedKeys: string[], env: KitEnv, body: string): string {
  const af = featureKeys.map((f) => `${f.flag}:${allowedKeys.includes(f.key)}`).join(',');
  const label = (env.RINGOTEL_LABEL ?? '').trim() || 'Ringotel';
  const labelShort = (env.RINGOTEL_LABEL_SHORT ?? '').trim() || label;
  const appBaseRaw = (env.RINGOTEL_APP_BASE_URL ?? '').trim();
  const appBase = /^https:\/\//i.test(appBaseRaw) ? appBaseRaw : '';
  // The version line's own config, and ONLY when this caller's tier actually carries the feature — same
  // reasoning as buildSelfBundle stripping appBase: bytes a bundle will not use have no business in it.
  // `url` is '' when the deployment declared PORTAL_RELEASE_NOTES_URL empty, which the body reads as
  // "text only". Whether the reader is senior enough for a link is decided in the browser from their own
  // token, because two callers with the same allowed-key set share these cached bytes.
  // The banner endpoint, only for a tier that carries the feature. https required: this request carries the
  // caller's ns_t, and sending a live credential over plain http is not a mistake worth supporting.
  const bwRaw = (env.STATUS_BANNER_WEBHOOK ?? '').trim();
  const bw = allowedKeys.includes('portal.statusBanner') && /^https:\/\//i.test(bwRaw) ? { bw: bwRaw } : {};
  const vl = allowedKeys.includes('portal.versionLine')
    ? { vl: { name: productName(env), ver: VERSION, url: releaseNotesUrl(env) ?? '' } }
    : {};
  const cfg = JSON.stringify({ label, labelShort, appBase, dl: parseDownloads(env), ...vl, ...bw });
  return `(function(){
"use strict";
var _AF={${af}};
var _KC=${cfg};
window.__kitCfg=window.__kitCfg||{};window.__kitCfg.af=_AF;window.__kitCfg.kc=_KC;
var B=window.__kitCfg.base;
if(!B)return;
${stripLineComments(body)}
}());
`;
}

/** The gated ADMIN bundle (unchanged behavior — same feature body, same FEATURE_KEYS). */
export function buildKitBundle(allowedKeys: string[], env: KitEnv): string {
  return wrapBundle(FEATURE_KEYS, allowedKeys, env, KIT_COMMON + KIT_ADMIN_BODY);
}

/** The minimal SELF bundle (own-account features only). Strips `RINGOTEL_APP_BASE_URL` from `_KC` — the
 * self body never uses `appBase` (only `_KC.label`), so the admin-dashboard URL must not ride a bundle
 * served to every ns_t (portal.self defaults `all`). */
export function buildSelfBundle(allowedKeys: string[], env: KitEnv): string {
  return wrapBundle(SELF_FEATURE_KEYS, allowedKeys, { ...env, RINGOTEL_APP_BASE_URL: '' }, KIT_COMMON + KIT_SELF_BODY);
}

/** Flag↔key map for the SPK bundle. One entry — but keep the shape so wrapBundle stays uniform. */
export const SPK_FEATURE_KEYS = [{ flag: 'status', key: 'kit.status' }] as const;
export const spkFeaturePolicyKeys = (): string[] => SPK_FEATURE_KEYS.map((f) => f.key);

const SPK_BODY = String.raw`
if(!_AF.status)return;
var _spkFrame=null;
// The console runs in box()'s sandboxed iframe: opaque origin, no localStorage, so it cannot fetch the
// Worker itself. It asks US, and we hand back only probe results — never the token.
// What is actually loaded on THIS page. Free to compute — the console's own bundle runs in the portal
// page, so chain loading was never unverifiable; it was unverifiable from inside the sandboxed iframe,
// which is a different claim. Hosts rather than full URLs: an unexpected host is the diagnostic, and a
// list of every script URL on a portal page is noise the reader has to filter.
function spkPage(){
var ho=(window.__kitCfg&&window.__kitCfg.ho)||{};
var present=false,hm={},hosts=[];
try{var hs=document.getElementsByTagName('script');
for(var i=0;i<hs.length;i++){var sc=hs[i].src;if(!sc)continue;
if(ho.u&&sc===ho.u)present=true;
// blob:/data: are how the primary injects the gated bundles — their host is the empty string, which
// rendered as a phantom nameless entry in the list. They are also this kit's own code, so naming them
// would answer a question nobody asked with the one host the reader already knows about.
try{var uu=new URL(sc,location.href);if(uu.protocol==='blob:'||uu.protocol==='data:')continue;if(uu.host)hm[uu.host]=1}catch(x){}}
hosts=Object.keys(hm).sort()}catch(x){}
return {declared:!!ho.u,missing:!!ho.m,preexisting:!!ho.pre,addedByKit:!!ho.add,present:present,hosts:hosts}}
// The portal's own menus as they stand right now, read through the SHARED finders in KIT_COMMON so the
// builder offers to hide exactly the elements the appliers act on. Entries this kit already added are
// skipped (any _svx* class): offering to hide your own addition would be offering to write a config that
// contradicts itself, and the hide would not work anyway — hides run before adds.
function spkMenus(){
var out={};
['apps','account','management'].forEach(function(n){
var ul=null;try{ul=menuUl(n)}catch(x){}
if(!ul){out[n]={present:false,entries:[]};return}
var seen={},entries=[];
for(var i=0;i<ul.children.length;i++){var li=ul.children[i];
if(li.className&&String(li.className).indexOf('_svx')>=0)continue;
var a=li.querySelector&&li.querySelector('a');if(!a)continue;
var t=(a.textContent||'').replace(/\s+/g,' ').trim();
if(!t||seen[t.toLowerCase()])continue;
seen[t.toLowerCase()]=1;entries.push(t)}
out[n]={present:true,entries:entries}});
return out}
window.addEventListener('message',function(e){
if(!_spkFrame||e.source!==_spkFrame.contentWindow)return;
var d=e.data;if(!d)return;
if(d.${SPK_BRIDGE.tag}==='${SPK_BRIDGE.pageRequest}'){
try{_spkFrame.contentWindow.postMessage({${SPK_BRIDGE.tag}:'${SPK_BRIDGE.pageResponse}',${SPK_BRIDGE.pageKey}:spkPage()},'*')}catch(x){}
return}
if(d.${SPK_BRIDGE.tag}==='${SPK_BRIDGE.menusRequest}'){
try{_spkFrame.contentWindow.postMessage({${SPK_BRIDGE.tag}:'${SPK_BRIDGE.menusResponse}',${SPK_BRIDGE.menusKey}:spkMenus()},'*')}catch(x){}
return}
if(d.${SPK_BRIDGE.tag}==='${SPK_BRIDGE.checkRequest}'){
// The candidate rides the query string, so bound it: a URL the edge refuses would come back as an
// opaque failure, and "could not check" must never be shown as "valid".
var c=String(d.${SPK_BRIDGE.checkKey}==null?'':d.${SPK_BRIDGE.checkKey});
var reply=function(v){try{_spkFrame.contentWindow.postMessage({${SPK_BRIDGE.tag}:'${SPK_BRIDGE.checkResponse}',${SPK_BRIDGE.checkKey}:v},'*')}catch(x){}};
if(c.length>8000){reply({ok:false,error:null,unchecked:'This config is too large to validate from here. Your deployment still validates it at startup, loudly.'});return}
jget('/kit/menus/check?c='+encodeURIComponent(c))
.then(function(r){reply({ok:!!(r&&r.ok),error:(r&&r.error)||null})})
.catch(function(){reply({ok:false,error:null,unchecked:'Could not reach this deployment to validate. Nothing is wrong with the config yet — this check just did not run.'})});
return}
if(d.${SPK_BRIDGE.tag}!=='${SPK_BRIDGE.request}')return;
jget('/kit/status?format=json&probe=1').then(function(r){
try{_spkFrame.contentWindow.postMessage({${SPK_BRIDGE.tag}:'${SPK_BRIDGE.response}',${SPK_BRIDGE.dataKey}:(r&&r.probes)||[]},'*')}catch(x){}
}).catch(function(){try{_spkFrame.contentWindow.postMessage({${SPK_BRIDGE.tag}:'${SPK_BRIDGE.response}',${SPK_BRIDGE.errorKey}:1},'*')}catch(x){}})});
function spkOpen(){
var j=tok();if(!j)return;
// Drop the previous frame reference BEFORE opening: box() removes any existing #_svx, so a stale
// contentWindow here would leave the message handler holding a detached frame. Hygiene, not a hole —
// the event.source=== guard already refuses anything else — but a dangling frame ref invites the next
// reader to assume the guard is weaker than it is.
_spkFrame=null;
fetch(B+'/kit/status',{headers:{Authorization:'Bearer '+j}}).then(function(x){if(!x.ok)throw new Error(x.status);return x.text()})
.then(function(html){box('Super Portal Kit - Integration Console',html,'');
var o=document.getElementById('_svx');_spkFrame=o&&o.querySelector('iframe')})
.catch(function(){alert('Super Portal Kit is unavailable right now.')})}
function spkMenu(){
// Management FIRST, account as the FALLBACK — and the fallback is the point, not politeness.
//
// mgmtUl() finds that menu by its toggle's own label, which is the only stable handle it has: it carries
// no id and no href. So it misses on a portal that renames it, on one that does not have it at all, and
// for any scope the portal does not show it to. Until this fallback, every one of those cases left the
// console with NO entry point whatsoever — the bundle shipped, the routes answered, and there was
// nothing to click. It has never bitten us because our portal has the menu; that is exactly the shape of
// bug a single-deployment test never finds.
//
// The account menu is the better fallback because acctUl() does not depend on a NAME: it keys on a
// sign-out entry plus the user's own profile link, and a portal without either is not a portal. Same
// gate either way (kit.status), so which menu carries the entry changes nothing about who can see it.
var ul=mgmtUl(),fallback=false;
if(!ul){ul=acctUl();fallback=!!ul}
if(!ul||ul.dataset.svxspk)return;ul.dataset.svxspk='1';
var li=document.createElement('li');
// Marked so anything walking this menu can tell OUR entry from the portal's. The builder skips _svx*
// rows: offering to hide the console's own link would compose a config that contradicts itself, and the
// hide would not even work, since hides run before adds.
li.className='_svxspk';
var a=document.createElement('a');a.href='javascript:void(0)';a.textContent='Super Portal Kit';
// Bold, because this is an operator/superadmin tool sitting among ordinary per-customer entries and
// should not read as one of them.
a.style.fontWeight='600';
// In the account menu it sits among the reader's OWN account entries, where an operator tool is more
// out of place than it is in Management. Say where it landed rather than let it read as one of them.
if(fallback)a.title='Operator console. Shown here because this portal has no Management menu.';
a.addEventListener('click',function(e){e.preventDefault();spkOpen()});
li.appendChild(a);
// PREPEND, not append. Two reasons. It belongs at the top as the operator entry. And appending made the
// position NON-DETERMINISTIC: managementMenu() (PORTAL_MENUS additions, in the self bundle) also appends
// to this same <ul>, so whichever bundle's fetch resolved first won — observed live moving between
// reloads. insertBefore(firstChild) is stable regardless of which runs first.
ul.insertBefore(li,ul.firstChild)}
var _spkF=[{p:/^\//,m:spkMenu}];
function spkRun(){for(var i=0;i<_spkF.length;i++){try{if(_spkF[i].p.test(location.pathname))_spkF[i].m()}catch(e){}}}
var _spkRaf=0;function spkSched(){if(_spkRaf)return;_spkRaf=requestAnimationFrame(function(){_spkRaf=0;spkRun()})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',spkRun);else spkRun();
var _spkOb=new MutationObserver(spkSched);_spkOb.observe(document.documentElement,{childList:true,subtree:true});
setTimeout(function(){_spkOb.disconnect()},8000);
`;

/** The operator console bundle. Its own file, not a flag inside the admin bundle: folding it in would
 *  ship these bytes to every Office Manager behind a cosmetic self-hide. Strips RINGOTEL_APP_BASE_URL
 *  for the same reason buildSelfBundle does — this body never uses it.
 *
 *  It ALSO strips `PORTAL_APP_DOWNLOADS`, which is not about bytes but about reachability: `wrapBundle`
 *  calls `parseDownloads`, which THROWS on malformed JSON, and `/kit/spk.js` is served ahead of the
 *  Group-2 validator (`appAccessConfigError`) that would otherwise have caught it. A thrown
 *  `AppAccessConfigError` is not an `HttpError`, so the console route's catch answers a bare
 *  `{"error":"Request failed"}`, the injected primary silently drops the non-200, and the operator loses
 *  the Management-menu entry that leads to the one page that names the broken setting. The console must
 *  survive exactly the class of config it exists to report — and this body never reads `_KC.dl`. */
export function buildSpkBundle(allowedKeys: string[], env: KitEnv): string {
  return wrapBundle(SPK_FEATURE_KEYS, allowedKeys, { ...env, RINGOTEL_APP_BASE_URL: '', PORTAL_APP_DOWNLOADS: '' }, KIT_COMMON + SPK_BODY);
}
