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
import { VERSION } from './brand.js';

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
] as const;

/** All policy keys a principal is tested against for the bundle (in registry order). */
export const featurePolicyKeys = (): string[] => FEATURE_KEYS.map((f) => f.key);

/** The self-service (`me.*`) flag↔key map — drives the SELF bundle's `_AF` (registry order). Kept apart
 * from FEATURE_KEYS so the admin bundle is unaffected; each key MUST exist in FEATURE_REGISTRY. */
export const SELF_FEATURE_KEYS = [
  { flag: 'appStatus', key: 'me.appStatus' },
  { flag: 'devices', key: 'me.devices' },
  { flag: 'resetPassword', key: 'me.resetPassword' },
  { flag: 'appAccess', key: 'me.appAccess' },
  { flag: 'menuConfig', key: 'me.menuConfig' },
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
  /** `public` (no token) or a gating level from the vocabulary (`all`/`reseller`/`office_manager`/… —
   *  see src/features.ts `resolveGate`), resolved the same way as a feature gate. Ignored for url:. */
  auth: string;
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
    const auth = typeof e?.auth === 'string' ? e.auth.trim() : '';
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
    if (!auth) throw new KitConfigError(`PORTAL_SECONDARIES[${i}].auth is required`);
    if (auth !== 'public') {
      try {
        resolveGate(auth, []);
      } catch (e) {
        if (e instanceof FeaturesConfigError)
          throw new KitConfigError(`PORTAL_SECONDARIES[${i}].auth ${e.message} — use "public" or a gating level (all/super_user/reseller/office_manager/site_manager/advanced_user/basic_user/call_center_agent/call_center_supervisor/superadmin/off)`);
        throw e;
      }
    }
    return { name, from, auth };
  });
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
export const secondaryNeedsAuth = (auth: string): boolean => auth !== 'public';

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
  const M = JSON.stringify(manifest.map((e) => ({ name: e.name, from: e.from, auth: e.auth })));
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
if(HANDOFF){var hl=false;try{var hs=document.getElementsByTagName("script");for(var hi=0;hi<hs.length;hi++){if(hs[hi].src===HANDOFF){hl=true;break;}}}catch(e){}if(!hl){var s=document.createElement("script");s.async=true;s.src=HANDOFF;(document.head||document.documentElement).appendChild(s);}}
else if(HANDOFF_MISSING){console.error("[kit] handoff not configured");kitNag();}
function tok(){try{return localStorage.getItem("ns_t")||"";}catch(e){return "";}}
function inject(code){try{var b=new Blob([code],{type:"text/javascript"});var u=URL.createObjectURL(b);var s=document.createElement("script");s.src=u;s.onload=function(){URL.revokeObjectURL(u);};(document.head||document.documentElement).appendChild(s);}catch(e){var s2=document.createElement("script");s2.textContent=code;(document.head||document.documentElement).appendChild(s2);}}
function fetchInject(path){var t=tok();if(!t)return;fetch(base+path+"?v="+encodeURIComponent(V),{headers:{Authorization:"Bearer "+t}}).then(function(r){return r.status===200?r.text():null;}).then(function(c){if(c)inject(c);}).catch(function(){});}
fetchInject("/kit/portal.js");
fetchInject("/kit/self.js");
function ext(src){var s=document.createElement("script");s.src=src;(document.head||document.documentElement).appendChild(s);}
for(var i=0;i<MANIFEST.length;i++){(function(e){
if(e.from.indexOf("url:")===0){ext(e.from.slice(4));return;}
if(e.from.indexOf("r2:")!==0)return;
if(e.auth==="public"){ext(base+"/kit/asset/"+e.name+".js?v="+encodeURIComponent(V));}
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
`;

const KIT_ADMIN_BODY = String.raw`
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
var f=document.createElement('iframe');f.style.cssText='flex:1;border:0;width:100%';f.sandbox='allow-scripts allow-popups';f.srcdoc=src;
f.addEventListener('load',function(){try{f.contentDocument.addEventListener('keydown',key)}catch(e){}});
b.appendChild(h);b.appendChild(f);o.appendChild(b);
o.addEventListener('click',function(e){if(e.target===o)close()});
document.addEventListener('keydown',key);
document.body.appendChild(o);
}
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
function colFill(){var t=document.querySelectorAll('td.svx-appcol');for(var i=0;i<t.length;i++){var td=t[i],s=_uD[td.getAttribute('data-ext')],st='',ti='';if(s&&s.activated){st=s.presence||'offline';ti=s.label||'';if(s.devices)ti+=' · '+s.devices+' device'+(s.devices===1?'':'s');if(st==='offline'&&s.lastSeen){try{ti+=' · last seen '+new Date(s.lastSeen).toLocaleDateString()}catch(e){}}}var _h=s&&s.health&&s.health.flags&&s.health.flags.length?s.health:null;if(_h){ti=(ti?ti+' · ':'')+_h.flags.join(', ');if(_h.severity==='broken')st=st?st+' broken':'broken'}if(td.getAttribute('data-st')!==st){td.setAttribute('data-st',st);td.textContent='';if(st){var _b=st.indexOf('broken')!==-1;var _p=st.split(' ')[0];td.appendChild(document.createTextNode(_b?'⚠️':'📱'));td.appendChild(svdot(_b?'#d93025':_p==='active'?'#3ba55d':_p==='pbx'?'#e8930c':'#9aa0a6'))}}if(td.title!==ti)td.title=ti}}
function colMenu(){var o=document.querySelector('label.checkbox input[data-table="user"]'),m=o&&o.closest('label.checkbox').parentNode;if(!m||m.querySelector('.svx-appopt'))return;var l=document.createElement('label');l.className='checkbox';var c=document.createElement('input');c.type='checkbox';c.className='svx-appopt';c.checked=colOn();c.addEventListener('change',function(e){e.stopPropagation();colSet(c.checked)});l.appendChild(c);l.appendChild(document.createTextNode(' '+_KC.labelShort));m.appendChild(l)}
function colBuild(){var hr=document.querySelector('thead tr');if(!hr)return;var th=hr.querySelector('th.svx-appcol');if(!th){th=document.createElement('th');th.className='svapp-header svapp svx-appcol';th.textContent=_KC.labelShort;th.style.textAlign='center';var a=hr.querySelector('th.department-header')||hr.querySelector('th.department')||hr.lastElementChild;hr.insertBefore(th,a)}var j=[].indexOf.call(hr.children,th);var cbs=document.querySelectorAll('input.userChkBox[data-extension]');for(var i=0;i<cbs.length;i++){var tr=cbs[i].closest('tr');if(!tr||tr.querySelector('td.svx-appcol'))continue;var td=document.createElement('td');td.className='svapp svx-appcol';td.style.whiteSpace='nowrap';td.style.textAlign='center';td.setAttribute('data-ext',cbs[i].getAttribute('data-extension'));tr.insertBefore(td,tr.children[j]||null)}colMenu();colApply();colFill()}
function colRemove(){var e=document.querySelectorAll('.svx-appcol,.svx-appopt');for(var i=0;i<e.length;i++){var n=e[i];if(n.classList.contains('svx-appopt')){var lb=n.closest('label');if(lb)lb.remove()}else n.remove()}}
var _uD={},_uAct=false,_uDom=null,_uOb=0,_uRaf=0,_uBusy=false;
function uSched(){if(_uRaf)return;_uRaf=requestAnimationFrame(function(){_uRaf=0;try{usersCol()}catch(e){}})}
function usersCol(){
if(!/^\/portal\/users\/?($|index)/.test(location.pathname))return;
if(!_AF.userStatus){colRemove();return}
if(!_uOb){_uOb=1;new MutationObserver(uSched).observe(document.body,{childList:true,subtree:true})}
var d=dom();if(!d){colRemove();return}
if(_uDom!==d){_uDom=d;_uAct=false;_uD={};_uBusy=true;jget('/rapp/users?domain='+encodeURIComponent(d)).then(function(r){_uAct=!!(r&&r.active);_uD=(r&&r.users)||{};_uBusy=false;uSched()}).catch(function(){_uAct=false;_uD={};_uBusy=false})}
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
function domCol(){if(_rtMap){rtHeader();rtFill();return}if(_rtBusy)return;_rtBusy=true;jget('/rapp/orgs').then(function(r){_rtMap=(r&&r.enabled)||{}}).catch(function(){_rtMap={}}).then(function(){_rtBusy=false;rtHeader();rtFill();var t=rtTable(),tb=t&&t.querySelector(':scope > tbody');if(tb&&!tb._svxRt){tb._svxRt=1;new MutationObserver(function(){rtFill()}).observe(tb,{childList:true})}})}
function _kscope(){try{var t=tok();if(!t)return '';var p=t.split('.')[1];if(!p)return '';var j=JSON.parse(decodeURIComponent(escape(atob(p.replace(/-/g,'+').replace(/_/g,'/')))));return ''+(j.user_scope||j.scope||'')}catch(e){return ''}}
function _isRes(){var s=_kscope().toLowerCase();return s==='reseller'||s==='super user'||s==='superuser'||s==='super-user'}
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
(function tick(){if(fired)return;jget('/rapp/user?domain='+encodeURIComponent(d)+'&ext='+encodeURIComponent(ext)+'&fresh=1').then(function(r2){if(fired)return;var now=!!(r2&&r2.status&&r2.status.activated);if(now===want||el()>=10000){fin(r2)}else{setTimeout(tick,nap())}}).catch(function(){if(fired)return;if(el()>=10000){fin(null)}else{setTimeout(tick,nap())}})})()
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
if(canReset&&active&&!masq()){
var rb=document.createElement('button');rb.type='button';rb.className='btn btn-default';rb.textContent='Reset '+_KC.label+' Password';rb.style.cssText='display:block;margin-top:8px';
if(!email){rb.disabled=true;rb.title='An email address is required.'}
rb.addEventListener('click',function(){if(!confirm('Reset the '+_KC.label+' password and email a new one to the user?'))return;rb.disabled=true;rb.textContent='Resetting…';jpost('/rapp/resetPassword',{domain:d,ext:ext}).then(function(){rb.textContent='Password reset — emailed'}).catch(function(){rb.textContent='Reset failed';rb.disabled=false})});
cc.appendChild(rb);
}
if(showForce){
var fb=document.createElement('button');fb.type='button';fb.textContent='Force-activate App';fb.title=tip;
fb.style.cssText='display:block;margin-top:8px;background:#f5f5f5;color:#333;border:1px solid #e8930c;border-radius:4px;padding:4px 10px;cursor:pointer';
fb.addEventListener('click',function(){if(!confirm('Force-activate '+_KC.label+' for this user, overriding the exclusion?'))return;fb.disabled=true;fb.textContent='Activating…';jpost('/rapp/activate',{domain:d,ext:ext,activate:true,force:true}).then(function(){pollUntil(d,ext,true,function(r2){if(r2&&r2.status&&r2.status.activated){rebuildAct(panel,d,ext,email,{active:r2.active,status:r2.status,eligibility:r&&r.eligibility})}else{fb.textContent='Activated — reload to refresh'}})}).catch(function(e){fb.disabled=false;fb.textContent='Force-activate App';alert('Force-activate failed: '+(e&&e.message?e.message:e))})});
cc.appendChild(fb);
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
// Phase 1: cached read → instant display (actSection then does a ~1s live poll to catch a just-saved change).
jget('/rapp/user?domain='+encodeURIComponent(d)+'&ext='+encodeURIComponent(ext)).then(function(r){_actSched=false;actSection(panel,d,ext,email,r)}).catch(function(){_actSched=false});
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
// and mode (My Account / Profile / Messages, plus a vendor-injected Partner Central for resellers), which
// is exactly why neither anchor may be an item we expect to be present.
function acctUl(){
var scopes=[document.querySelector('ul.user-toolbar'),document];
for(var s=0;s<scopes.length;s++){var root=scopes[s];if(!root)continue;
// Log Out is the one entry present in every variant of this menu, so it is the primary anchor.
var ls=root.querySelectorAll('ul.dropdown-menu');
for(var i=0;i<ls.length;i++){if(ls[i].id!=='app-menu-list'&&/\blog\s*out\b/i.test(ls[i].textContent||''))return ls[i]}
// Fallback if a deployment relabels it: the dropdown holding this user's own profile link.
var a=root.querySelector('ul.dropdown-menu a[href*="/portal/users/edit/profile/"]');
var ul=a&&a.closest('ul.dropdown-menu');if(ul)return ul}
return null}
function accountMenu(){
if(!_AF.menuConfig)return;
var ul=acctUl();if(!ul||ul.dataset.svxacct)return;
aaFetch(function(r){
var plan=r&&r.menus&&r.menus.account;if(!plan)return;
if(!(plan.hide||[]).length&&!(plan.add||[]).length)return;
var u=acctUl();if(!u||u.dataset.svxacct)return;u.dataset.svxacct='1';
// Insert into the FIRST group — above the divider that precedes Log Out — rather than after it.
var lo=null,ch=u.children;
for(var i=0;i<ch.length;i++){if(/\blog\s*out\b/i.test(ch[i].textContent||'')){lo=ch[i];break}}
var before=lo;
if(before&&before.previousElementSibling&&/divider/.test(before.previousElementSibling.className||''))before=before.previousElementSibling;
menuApply(u,plan,before)})}
function appsMenu(){
// Two independent surfaces share this menu: menu customization (menuConfig) and the sign-in panel
// (appAccess). Either alone is a reason to touch the menu.
if(!_AF.appAccess&&!_AF.menuConfig)return;
var ul=document.getElementById('app-menu-list');if(!ul||ul.dataset.svx)return;
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
var F=[{p:/^\/portal\/home/,m:homeStatus,a:function(){return !!_AF.appStatus}},
{p:/^\//,m:appsMenu,a:function(){return !!_AF.appAccess||!!_AF.menuConfig}},
{p:/^\//,m:accountMenu,a:function(){return !!_AF.menuConfig}}];
function run(){for(var i=0;i<F.length;i++){try{var f=F[i];if(f.p.test(location.pathname)&&(!f.a||f.a()))f.m()}catch(e){}}}
var raf=0;function sched(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;run()})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
var ob=new MutationObserver(sched);ob.observe(document.documentElement,{childList:true,subtree:true});
setTimeout(function(){ob.disconnect()},8000);`;

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
  const cfg = JSON.stringify({ label, labelShort, appBase, dl: parseDownloads(env) });
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
