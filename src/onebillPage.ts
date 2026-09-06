/**
 * `onebillHtml` — the OneBill links page, served at `GET /kit/onebill` and opened in the injected
 * bundle's sandboxed modal.
 *
 * ⚠️ THE PAGE FETCHES NOTHING. It runs in a `srcdoc` iframe with no `allow-same-origin`, so it has no
 * origin, no `localStorage` and therefore no `ns_t` to authenticate with. Everything it shows arrives
 * over the `SPK_BRIDGE` protocol from the injected bundle in the portal page, which holds the token and
 * calls the two routes. That is the same arrangement the integration console uses, for the same reason.
 *
 * THE ROWS ARE DRAWN TWICE, and that is the interesting part of this file. The server copy
 * ({@link renderRows}) exists so the markup can be asserted without a DOM; the client copy
 * ({@link rowScript}) is what actually runs, because the data arrives after the page does. Two copies of
 * one renderer is exactly the shape this repo has shipped bugs in — so `onebillPage.selftest.ts`
 * evaluates the client copy in a VM and asserts it produces the SAME BYTES as the server copy for the
 * same report. A divergence is a failing test rather than a table that renders differently depending on
 * which half you are looking at.
 */
import { esc } from './pageShell.js';
import { SPK_BRIDGE } from './spkBridge.js';
import type { LinkReport, SetupCheck, SetupMissing } from './onebill.js';
import type { AccountReport, ScopedComparisonItem, ScopedComparisonRow } from './onebillAccount.js';
import type { AccountRef, UnassignedItem } from './onebillScope.js';
import type { ComparisonItem, ComparisonRow, RecurringComparison } from '@dszp/onebill-lib';
import type { DomainInventory, DomainInventoryDetail, EndpointItem, ExtensionItem, InventoryItem, NumberItem } from '@dszp/netsapiens-lib';

export interface OnebillDoc {
  /** The caller holds `onebill.write`. False ⇒ the write surface is not rendered AT ALL — see below. */
  canWrite: boolean;
  version: string;
  /**
   * The domain the portal was already looking at when this page was opened — ROUTE-VALIDATED against
   * the caller's own visible domain set (worker.ts compares a `?domain=` query param with `normDomain`
   * and passes back the ORIGINAL spelling from that set, never the query string's own spelling). Absent
   * at the top level, where there is no "current domain" to prefill. Rendered into a `data-prefilter`
   * attribute — see `onebillHtml` — never trust a caller-supplied string into markup unvalidated.
   */
  prefilter?: string;
}

/**
 * The row states, declared once and mirrored into the client copy. Every token needs a `.chip-<token>`
 * rule in the stylesheet, and the selftest checks both facts — a state the CSS does not know about
 * renders as an unstyled word, which reads as a rendering bug rather than as the state it is.
 */
export const ROW_STATES = ['conflict', 'unlinked', 'split', 'linked'] as const;
/**
 * The foreign-row states. `stale` is an Active account pointing at nothing we can see; `closed` is not.
 * `closed` no longer reaches this page from a fresh report — `buildLinkReport` drops those rows — but it
 * stays a state here because a cached report can still hold one, and because the join still classifies it.
 */
export const FOREIGN_STATES = ['stale', 'closed'] as const;

// ── the shared row renderer, as client JavaScript ───────────────────────────────────────────────────
// String.raw, and NO BACKTICKS anywhere inside it (including in comments) — this is spliced into a
// template literal, and one backtick ends the page.

/**
 * The decommission block's heading and intro, declared ONCE and spliced into both copies — the one
 * string in this file whose two renderings could drift without any test noticing, since the mirror test
 * compares the two copies against each other and would pass on two identical-but-wrong headings.
 */
const DECOM_HEAD = '<h2>Closed accounts whose domain is still live</h2>'
  + '<p class="dim">These OneBill accounts are closed, but NetSapiens still has their domain.'
  + ' They may need decommissioning.</p>';

/** Reading only. Identical in both builds, because what a row SAYS does not depend on who is looking. */
const ROW_BASE = String.raw`
var OB_DECOM_HEAD=${JSON.stringify(DECOM_HEAD)};` + String.raw`
var OB_STATES=['conflict','unlinked','split','linked'];
var OB_FSTATES=['stale','closed'];
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
// Every account mention on this page carries data-account, so obPaintApplied can find it later by
// IDENTITY rather than by array index. Two callers can render the same account (a split parent's site
// line and that site's own row), and both get their own span; a click handler never reads this
// attribute, so its value needs no further escaping than esc() gives it. Account numbers are plain text
// on purpose: OneBill's web UI does not render its account-summary route when opened from outside
// (a spinner, then a blank page), so a deep link there is a link that never works.
function obAcct(a){var label=esc(a.accountNumber)+(a.accountName?' — '+esc(a.accountName):'');
return '<span data-account="'+esc(a.accountNumber)+'">'+label+'</span>'}
function obNotes(ns){var o='';for(var i=0;i<(ns||[]).length;i++)o+='<div class="note">'+esc(ns[i])+'</div>';return o}
// Is this failure message the shape of a transient upstream hiccup — a 5xx from OneBill, or the request
// never got an answer at all — rather than a 4xx or an in-band-at-200 error the account itself caused?
// A 4xx and an in-band error are OneBill's ANSWER; a Refresh sends the exact same question again and
// gets the exact same answer, so offering it there would be a button that never helps.
function obTransient(m){var s=String(m==null?'':m);
return /-> 5\d\d/.test(s)||/HTTP 5\d\d/.test(s)||/fetch failed/i.test(s)||/timed out/i.test(s)||/ECONN/i.test(s)}
// Does THIS row, on its own, match the filter text? The Domain/Site cell is always first; the Account
// cell is always third, whether or not the caller has the write key (Action, when present, is last) —
// so both builds can share one index into the same row. A split parent's site-account lines live inside
// that same cell (obSiteAccts), so this reads them for free without knowing they exist.
function obRowMatches(rowEl,q){var s=String(q==null?'':q).trim().toLowerCase();if(!s)return true;
var tds=rowEl&&rowEl.querySelectorAll?rowEl.querySelectorAll('td'):[];
var tgt=tds[0]?String(tds[0].textContent||''):'';
var acct=tds[2]?String(tds[2].textContent||''):'';
return tgt.toLowerCase().indexOf(s)>=0||acct.toLowerCase().indexOf(s)>=0}
function obChip(s){return '<span class="chip chip-'+esc(s)+'">'+esc(s==='split'?'split by site':s)+'</span>'}
// The mark an applied row wears in its Action cell until the next apply or Refresh replaces it — three
// shapes: a failure names why, a removal counts what it removed, anything else just says what happened.
// Lives here (rather than beside the toast, which is read-only-write-only) so it VM-tests the same way
// every other pure helper on this page does.
function obAppliedMark(r){r=r||{};
if(!r.ok)return '<span class="applied bad">✗ failed: '+esc(r.error||'OneBill gave no reason.')+'</span>';
if(r.removed)return '<span class="applied">✓ '+esc(r.removed)+' removed</span>';
if(r.created)return '<span class="applied">✓ linked</span>';
if(r.updated)return '<span class="applied">✓ updated</span>';
return '<span class="applied">✓ done</span>'}
// The last apply's results, by account number — read once per render so a fresh set of rows can be
// marked without the row renderer (obRows) knowing this state exists at all.
var OB_APPLIED={};
// Every account mention on the page carries data-account (see obAcct) — so a mark is found by IDENTITY,
// never by lining up rep.rows[i] against the i-th <tr>. That correlation broke the moment a client-side
// re-sort (obSortGroups) could put the rows in a different order than the report that named them; this
// reads the DOM as it actually stands, whatever order rendered it. One mark per ROW: a match found via
// the row's own account cell or (for a split parent) a sited claimant's line both resolve to the same
// <tr>, and data-oba-marked stops a second mention from writing the mark twice.
function obPaintApplied(){var keys=Object.keys(OB_APPLIED);if(!keys.length)return;
var els=document.querySelectorAll('[data-account]');
for(var i=0;i<els.length;i++){var el=els[i],an=el.getAttribute('data-account');
if(!Object.prototype.hasOwnProperty.call(OB_APPLIED,an))continue;
var hit=OB_APPLIED[an];
if(!hit)continue;
var tr=el.closest?el.closest('tr'):null;if(!tr||tr.getAttribute('data-oba-marked'))continue;
var act=tr.querySelector('td.act');if(!act)continue;
tr.setAttribute('data-oba-marked','1');
act.innerHTML=obAppliedMark(hit)+act.innerHTML}}
// A split parent's Account cell: one line per sited claimant, with the usage-subscription holder (if
// any) marked. Mirrors sacct/siteAccts server-side.
function obSacct(x){return '<div class="sacct"><b class="sname">'+esc(x.site)+'</b> — '+obAcct(x.account)+(x.usageHolder?' <span class="chip usage">USAGE</span>':'')+'</div>'}
function obSiteAccts(r){var sa=r.siteAccounts||[];if(!sa.length)return '';
var o='',any=false;for(var i=0;i<sa.length;i++){o+=obSacct(sa[i]);if(sa[i].usageHolder)any=true}
if(!any)o+='<div class="dim">No account on this domain holds a usage subscription.</div>';
return o}
// Groups the parent GROUPS of a row list, keeping every row's position within its own group untouched —
// a domain's site rows never flip order relative to each other, only which group comes before which.
// Rows already arrive with each domain's rows contiguous (buildLinkReport's own join), so a run of rows
// sharing one domain IS one group; nothing here needs to know which row is the bare parent.
function obGroupsOf(rows){var gs=[],cur=null,curDom=null;
for(var i=0;i<rows.length;i++){var r=rows[i];
if(cur&&r.domain===curDom){cur.push(r)}else{cur=[r];curDom=r.domain;gs.push(cur)}}
return gs}
// The rank a reseller acts in: a conflict needs a decision before anything else, then something with no
// account at all, then a domain only partly linked, and a fully linked domain last — nothing to do there.
var OB_STATE_RANK=['conflict','unlinked','split','linked'];
function obStateRank(s){var i=OB_STATE_RANK.indexOf(s);return i<0?OB_STATE_RANK.length:i}
// Pure: asc/desc, case-insensitive, groups intact. The header buttons call this at RENDER time — the
// report itself is never resorted or mutated, so a Refresh or an apply's re-read still hands back rows
// in the server's own (alphabetical) order, and this is reapplied on top of that.
// key: 'domain' sorts groups by domain, reversed by dir. 'state' sorts groups by the PARENT row's state
// (gs[i][0] — a group's bare/parent row always leads it), reversed by dir; ties (and every 'domain' sort)
// break on domain A→Z, which is NEVER reversed — the secondary order is a fixed, predictable fallback,
// not a mirror of the primary direction.
function obSortGroups(rows,key,dir){var gs=obGroupsOf(rows||[]);
gs.sort(function(a,b){var byDom=a[0].domain.localeCompare(b[0].domain,undefined,{sensitivity:'base'});
if(key==='state'){var c=obStateRank(a[0].state)-obStateRank(b[0].state);
if(dir==='desc')c=-c;
return c!==0?c:byDom}
return dir==='desc'?-byDom:byDom});
var out=[];for(var i=0;i<gs.length;i++)for(var j=0;j<gs[i].length;j++)out.push(gs[i][j]);
return out}
// Pure header-click state transition, so it VM-tests the same way every other helper here does rather
// than only being exercised through a DOM click. The active key is whichever header was clicked LAST;
// direction is kept PER KEY, so switching back to a key you left toggled restores that toggle instead of
// resetting to ascending. The argument shape is {key, dir:{domain,state}}; never mutated.
function obSortNext(state,key){var s=state||{},k=s.key||'domain',d=s.dir||{};
var nd={domain:d.domain||'asc',state:d.state||'asc'};
if(k===key)nd[key]=nd[key]==='asc'?'desc':'asc';else k=key;
return {key:k,dir:nd}}
// A shallow copy of a report with its rows replaced — used to hand the sorted order to obRows/obAfterRender
// without mutating the report the page was given, or the caching that report may still be involved in.
function obWithRows(rep,rows){var o={},k;for(k in rep)if(Object.prototype.hasOwnProperty.call(rep,k))o[k]=rep[k];
o.rows=rows;return o}
// A site row's own count, said in words rather than left for a reader to derive by scrolling up to the
// parent and counting its siblings. Mirrors siteCountLine server-side.
function obSiteCountLine(r){if(!r.site||!r.siteCount)return '';
return '<div class="dim">('+(r.siteCount===1?'the only site on this domain':'one of '+r.siteCount+' sites on this domain')+')</div>'}
// How long ago, in words, for the header's "usage last verified" clause. Whole units only: a header
// that says "4 minutes ago" and one that says "4.2 minutes ago" answer the same question, and only one
// of them reads like a sentence. Anything under a minute is "just now" rather than a count of seconds.
function obAgo(iso,nowMs){var t=Date.parse(String(iso||''));if(!isFinite(t))return '';
var s=Math.floor((nowMs-t)/1000);if(s<60)return 'just now';
var m=Math.floor(s/60);if(m<60)return m===1?'1 minute ago':m+' minutes ago';
var h=Math.floor(m/60);if(h<24)return h===1?'1 hour ago':h+' hours ago';
var d=Math.floor(h/24);return d===1?'1 day ago':d+' days ago'}
// The one line under the title. A quick view says WHERE its links came from and when usage was last
// really checked, because both are things the reader would otherwise have to assume; a full pass says
// when it ran, which is the whole truth about it. The fmt argument is the caller's local-time formatter,
// passed in rather than reached for, so this stays pure.
function obHeadline(rep,nowMs,fmt){rep=rep||{};
if(rep.mode!=='quick')return 'Generated '+fmt(rep.generatedAt);
return 'Quick view · links from the OneBill index · '
+(rep.verifiedAt?'usage last verified '+obAgo(rep.verifiedAt,nowMs):'not yet verified')}
// Do every site of this split domain bill to ONE account? Then the domain has a single subject and the
// panel can open by it; two accounts and there is nothing for a click on the domain to name.
function obSplitOne(r){var sa=r.siteAccounts||[],i;if(r.state!=='split'||!sa.length)return false;
for(i=1;i<sa.length;i++)if(sa[i].account.accountNumber!==sa[0].account.accountNumber)return false;
return true}
// The Domain/Site cell's opener. A LINKED site row names its ACCOUNT, because that is the subject the
// panel is about; a whole-domain link and a wholly-one-account split name the DOMAIN, which the route
// resolves to the same account. Anything else is text: a conflict row has two claimants and
// resolveAccountScope throws on one, and a control whose only outcome is a refusal is not a control.
function obTarget(r){
if(r.site&&r.state==='linked'&&(r.accounts||[]).length)return '<button type="button" class="linkish dom" data-open-account="'+esc(r.accounts[0].accountNumber)+'">'+esc(r.domain)+'</button>';
if((r.state==='linked'&&!r.site)||obSplitOne(r))return '<button type="button" class="linkish dom" data-open-domain="'+esc(r.domain)+'">'+esc(r.domain)+'</button>';
return '<span class="dom">'+esc(r.domain)+'</span>'}
function obRows(rep){var rs=(rep&&rep.rows)||[];
if(!rs.length)return '<tr class="empty"><td colspan="'+OB_COLS+'">This deployment sees no domains, so there is nothing to link.</td></tr>';
var o='';
// A quick-view row is drawn from the DERIVED index, so it is marked as such for anything reading the
// table — the value is a constant, never report data. Mirrored by the unv const server-side.
var unv=(rep&&rep.mode==='quick')?' data-unverified="1"':'';
for(var i=0;i<rs.length;i++){var r=rs[i];
var accs=[];for(var j=0;j<(r.accounts||[]).length;j++)accs.push(obAcct(r.accounts[j]));
var cand=r.candidate?obAcct(r.candidate)+' <span class="conf">'+esc(r.candidate.confidence)+'</span>':'—';
var acctCell=accs.length?accs.join('<br>')+obSiteCountLine(r):(obSiteAccts(r)||'—');
o+='<tr data-state="'+esc(r.state)+'" data-domain="'+esc(r.domain)+'"'+unv+(r.site?' class="site" data-site="'+esc(r.site)+'"':'')+'>'
// A LINKED SITE row opens BY ACCOUNT and never by domain: reconciliation is scoped to what the account
// holds, and ?domain= on a split domain names a row several accounts share. A conflict site row opens
// nothing — two accounts claim it, resolveAccountScope throws on one, and the page does not pick. A split
// parent opens by domain only when every site bills to the same account, the one case ?domain= resolves.
+'<td class="tgt">'+obTarget(r)+(r.site?'<div class="siterow">Site: <b>'+esc(r.site)+'</b></div>':'')+obNotes(r.notes)+'</td>'
+'<td>'+obChip(r.state)+'</td>'
+'<td>'+acctCell+'</td>'
+'<td>'+cand+'</td>'
+obActionCell(r)
+'</tr>'}
return o}
function obHidden(rep){var n=(rep&&rep.hiddenLinkCount)||0;if(!n)return '';
return '<p class="dim">'+n+(n===1?' link points at a domain':' links point at domains')+' this portal is set not to show. They are not listed here.</p>'}
function obForeign(rep){var f=(rep&&rep.foreign)||[];var h=obHidden(rep);
if(!f.length)return h||'<p class="dim">Every OneBill link points at a domain or site NetSapiens has.</p>';
var o=h;
for(var i=0;i<f.length;i++){var x=f[i];
o+='<div class="frow" data-account="'+esc(x.account.accountNumber)+'" data-value="'+esc(x.value)+'" data-qualifier="'+esc(x.qualifier||'')+'" data-links="'+esc(JSON.stringify(x.links||[]))+'">'
+'<div class="fhead">'+obChip(x.state)+' <b>'+obAcct(x.account)+'</b> <span class="arrow">→</span> <code>'+esc(x.value)+(x.qualifier?' / '+esc(x.qualifier):'')+'</code></div>'
+obNotes(x.notes)
+obRemove(x)
+'</div>'}
return o}
// Closed in OneBill, still live in NetSapiens. Heading and all, this renders NOTHING when the list is
// empty: a standing heading over an empty div reads as a section that failed to load.
function obDecom(rep){var ds=(rep&&rep.decommission)||[];if(!ds.length)return '';
var o=OB_DECOM_HEAD;
for(var i=0;i<ds.length;i++){var x=ds[i],dm=x.domains||[],c='';
for(var j=0;j<dm.length;j++)c+=(j?' ':'')+'<code>'+esc(dm[j])+'</code>';
o+='<div class="res decom"><b>'+obAcct(x.account)+'</b><div>'+c+'</div></div>'}
return o}
// The remediation card shown IN PLACE of the table and every write control when OneBill has not
// declared the custom-field group this deployment maps links onto — see onebill.ts groupSetup /
// setupChecklist, whose exact wording this mirrors so the page and applyLinks' refusal never drift.
function obSetupMissingLabel(m,setup){if(m==='group')return 'the group itself (key "'+esc(setup.group)+'")';
if(m==='valueField')return 'the "'+esc(setup.valueField)+'" field';
return 'the "'+esc(setup.qualifierField||'')+'" field'}
function obSetupChecklist(setup){var q=setup.qualifierField?(' and an optional text field "'+esc(setup.qualifierField)+'"'):'';
var steps='In OneBill, create an account-level custom-field group with the key "'+esc(setup.group)+'" and add a text field "'+esc(setup.valueField)+'"'+q+'. Then Refresh and fully verify.';
var ms=[];for(var i=0;i<(setup.missing||[]).length;i++)ms.push(obSetupMissingLabel(setup.missing[i],setup));
return ms.length?(steps+' Missing: '+ms.join(' and ')+'.'):steps}
function obSetupCard(setup){
return '<div class="setup-card" data-setup-missing="'+esc((setup.missing||[]).join(','))+'">'
+'<h2>OneBill needs a custom-field group before links can be stored</h2>'
+'<p>'+obSetupChecklist(setup)+'</p></div>'}

// ── the account detail panel ───────────────────────────────────────────────────────────────────────
// Reading only, like everything else in this block: whether an Accept control is drawn is a fact ON THE
// REPORT (canWrite + baselinesEnabled), because the server renders the first paint and the client every
// refresh, and a control that appeared only on one of those would be a control that came and went.
function obNum(n){return esc(String(n==null?0:n))}
function obVerdictChip(v){return '<span class="chip chip-'+esc(v)+'">'+esc(v)+'</span>'}
// A row that exists only because something entitles it, and nothing is using the entitlement. The
// engine says match, which is true and reads as a reassurance nobody asked for; what the reader needs
// off this row is that it is included and unused.
function obOptionalChip(r){return (r.optional&&r.observed===0)?'<span class="chip chip-optional">optional, unused</span>':obVerdictChip(r.verdict)}
// Headroom above the billed count, said beside it. Nothing where nothing entitles the row - the great
// majority of rows - so the column stays a column of numbers.
function obEntitled(r){return r.entitled>0?' <span class="dim ent">+'+obNum(r.entitled)+' entitled</span>':''}
// Is anything on this row tagged with the plan it is billed as? The row counts its UNTAGGED accepted
// items, so the answer is "fewer untagged than accepted". Where nothing is tagged, no offer says
// "0 tagged": a column of zeroes on a row nobody has tagged is noise about a thing nobody has done.
function obAnyTagged(r){var n=0,i;for(i=0;i<(r.items||[]).length;i++)if(r.items[i].status==='accepted')n++;
return n>(r.untagged||0)}
// What the billed count is MADE OF, and — for a row billed by nothing of its own — what pays for it or
// permits it. A list rather than a sentence, because these are separate facts about separate plans and
// a comma-joined line made the reader parse where one ended.
// How offer names are matched everywhere they are matched: trimmed, case-insensitively. Same rule the
// library uses, so the page cannot group two lines differently from the engine that counted them.
function obNameKey(v){return String(v==null?'':v).trim().toLowerCase()}
// One option per NAME: two subscription lines of one plan are two offers[] entries, but a billed-as tag
// names the plan, so the picker would show the same words twice with nothing to choose between.
function obUniqOffers(offers){var out=[],seen={},i;for(i=0;i<(offers||[]).length;i++){var k=obNameKey(offers[i]);if(seen[k]===1)continue;seen[k]=1;out.push(offers[i])}return out}
// How many more items are tagged to this offer's PLAN than the bill carries of it, or 0.
// Two things this has to get right, and got wrong:
//   the bill is quantity x PACK SIZE, so three numbers tagged to one pack of ten are not an excess; and
//   tagged is a count per NAME that repeats across every line of that name rather than dividing
//   between them, so the comparison is against the SUM over those lines.
// Printed on the first line of a name only: the excess is a fact about the plan, and saying it twice
// under two lines of one plan would read as two separate overages.
function obOverTagged(os,i){var x=os[i],t=x.tagged||0,k=obNameKey(x.name),n=0,j;
for(j=0;j<os.length;j++){if(obNameKey(os[j].name)!==k)continue;
if(j<i)return 0;
n+=os[j].quantity*(os[j].perUnit>1?os[j].perUnit:1)}
return t>n?t-n:0}
function obOfferList(r){var os=r.offers||[],cs=r.credits||[],any=obAnyTagged(r),o='',i;
for(i=0;i<os.length;i++){var x=os[i],t=x.tagged||0;
o+='<li>'+esc(x.name)+' x'+obNum(x.quantity)+(x.perUnit>1?(' (pack of '+obNum(x.perUnit)+')'):'');
if(any&&typeof x.tagged==='number'){o+=' — '+obNum(t)+' tagged';
var over=obOverTagged(os,i);
if(over>0)o+=' ('+obNum(over)+' more tagged than billed)'}
o+='</li>'}
for(i=0;i<cs.length;i++){var c=cs[i];
if(!(c.quantity>0))continue;
o+='<li class="credit">'+(c.kind==='entitles'?'included with ':'via ')+esc(c.from)+' x'+obNum(c.quantity)+'</li>'}
return o?('<ul class="offers">'+o+'</ul>'):''}
// An item is a KEY on the comparison row and a record in rep.detail — the comparison carries counts and
// identities, never names, so the columns an operator recognises a thing by are re-joined here by key. A
// key with no record left renders blank rather than throwing: a stale acceptance names a thing that has
// gone, and that row still has to draw.
// An item key is DOMAIN-QUALIFIED — "branch.example/ext:100" — because one account's report can hold two
// domains with the same extension number on each. The domain is stripped to read the KIND off the front;
// the lookup itself still matches the whole scoped key, since rep.detail is scoped the same way. A cached
// pre-scoping key has no slash and is its own bare form.
function obBareKey(k){var i=String(k==null?'':k).indexOf('/');return i>=0?k.slice(i+1):k}
// The one predicate behind every write control on this panel, so the accept column, the item buttons, the
// group buttons and the Unassigned picker cannot disagree about whether this report can be written from.
// partial is in here because a report missing a domain cannot say what an account holds, and every
// control here decides something about exactly that.
function obCanAct(rep){return !!(rep.canWrite&&rep.baselinesEnabled&&!rep.partial)}
// What this account holds, as the operator would say it: a site where it holds one, the whole domain
// where it holds all of it. The panel's subject is the ACCOUNT now, and this line is its extent.
function obScopesLine(rep){var ss=rep.scopes||[],o=[],i;
for(i=0;i<ss.length;i++)o.push(esc(ss[i].domain)+(ss[i].site?' / '+esc(ss[i].site):' (whole domain)'));
return o.join(' · ')}
// Which domain-and-site an item is on — and only where the account holds more than one PLACE. Two
// domains, or two sites of ONE domain: either way the rows differ from each other and the badge says
// which is which. An account holding a single scope gets none — every row would carry the same badge,
// which is a column of noise saying nothing.
// NAMED obItemWhere and not obWhere: WRITE_JS declares its own obWhere(s) for the link confirmations, and
// in the shipped bundle the two share ONE function scope — the later declaration won, and every item line
// rendered "site [object Object]". The mirror test now evaluates the SHIPPED script and asserts no ob-name
// is declared twice in it, so the class of bug is closed rather than this instance of it.
function obItemWhere(it,rep){if((rep.domains||[]).length<2&&(rep.scopes||[]).length<2)return '';
return '<span class="where">'+esc(it.domain)+(it.site?' / '+esc(it.site):'')+'</span>'}
// Someone put this item here by hand. The tooltip names the ACCOUNT the automatic rule would have billed
// it to instead — naming only the site would leave the reader to work out whose site it is, which is the
// question the badge exists to answer. An 'unknown' attribution is a stale acceptance whose scope meta is
// gone: nothing here knows where it came from, so nothing is claimed.
function obManualChip(it){if(it.attribution!=='manual')return '';
var a=it.automatic,t=a?(' title="automatically: '+esc(a.accountNumber)+(a.site?' ('+esc(a.site)+')':'')+'"'):'';
return '<span class="chip chip-manual"'+t+'>manual</span>'}
// What the chip says AFTER the device name. The model when there is one; failing that the KIND, which is
// what the suffix legend calls this device (SNAPmobile, Teams, the deployment's own app) - a connector or
// a softphone has no model to print and its kind is the more useful fact anyway; failing both, the plain
// statement that the model is missing. "(unknown)" is the LIBRARY's placeholder for a record NetSapiens
// has no model on, so it counts as no model here - printed as written it reads as a rendering fault, and
// a reader cannot tell it from a bug in this page. Display only; the library value is left alone, and the
// inventory breakdown still buckets it under its own name.
function obModel(m,k){var real=m&&m!=='(unknown)';
if(real)return ' '+esc(m);
if(k)return ' '+esc(k);
return ' <span class="dim">(no model)</span>'}
// What is actually plugged in, named. The device NAME, then its model or what kind of device it is. The
// title carries the name and its kind, because a narrow panel truncates the chip and those two are what
// identify the device in the portal.
// A record with NO devices array at all is a report cached before netsapiens-lib 0.5.0 — it says
// nothing rather than "no device", which would be a claim this page cannot support.
function obDevices(x){if(!x.devices)return '';
var ds=x.devices,o='',i;
if(!ds.length)return '<div class="devs"><span class="dim">no device</span></div>';
for(i=0;i<ds.length;i++){var d=ds[i];
o+='<span class="dev'+(d.teams?' dev-teams':'')+'" title="'+esc(d.name+(d.kind?' \u00b7 '+d.kind:''))+'">'+esc(d.name)+obModel(d.model,d.kind)+'</span>'}
return '<div class="devs">'+o+'</div>'}
function obExtDetail(x){return esc([x.name,x.site].filter(Boolean).join(', '))+(x.scope?' <span class="dim">'+esc(x.scope)+'</span>':'')+obDevices(x)}
// A number is local or toll-free, it routes somewhere, and the portal wrote a note on it when it created
// it. The kind alone was what an operator could already read off the label; where it GOES is the thing
// they cannot, and it is what decides whether a number is billable or plumbing.
function obDidDetail(n){var o=n.kind==='tollFree'?'toll-free':'local';
if(n.destination)o+=' · '+esc(n.destination);
if(n.description)o+=' · <span class="dim">'+esc(n.description)+'</span>';
return o}
// One dispatcher over a record already in hand, so a placed item and an Unassigned one cannot describe
// the same thing two ways. The KIND comes off the bare key; the record comes from wherever the caller
// found it (rep.detail for a placed item, the row itself for an unassigned one).
// An ENDPOINT is a callback number in the label cell and nothing else; what an operator reconciling an
// E911 line needs beside it is who the carrier announces and where responders are sent.
function obEpDetail(e){var p=[];
if(e.callerName)p.push(esc(e.callerName));
if(e.billingAddress)p.push(esc(e.billingAddress));
return p.join(' · ')}
function obRecDetail(k,rec){if(!rec)return '';
var b=obBareKey(k);
if(b.indexOf('ext:')===0)return obExtDetail(rec);
if(b.indexOf('did:')===0)return obDidDetail(rec);
if(b.indexOf('e911:')===0)return obEpDetail(rec);
return ''}
// The scoped detail record behind a placed item's key, or null. The comparison carries identities and
// counts, never names, so this is the join back to them; the KIND comes off the bare key and the lookup
// matches the whole SCOPED key, rep.detail being scoped the same way. A key with no record left answers
// null and its row still draws — a stale acceptance names a thing that has gone.
// Looked up ONCE per row and handed to both the kind chip and the detail cell: a fax line is one only
// according to its record, and two lookups of one key are two chances for the chip to say "number"
// while the cell beside it describes a fax line.
function obDetailRec(k,rep){var d=rep.detail||{},b=obBareKey(k),i;
if(b.indexOf('ext:')===0){var xs=(d.extensions||[]).concat(d.systemUsers||[]);for(i=0;i<xs.length;i++)if(xs[i].key===k)return xs[i];return null}
if(b.indexOf('did:')===0){var ns=d.dids||[];for(i=0;i<ns.length;i++)if(ns[i].key===k)return ns[i];return null}
if(b.indexOf('e911:')===0){var es=d.e911Endpoints||[];for(i=0;i<es.length;i++)if(es[i].key===k)return es[i];return null}
return null}
// "as <plan>" is part of the DECISION, not of the item: an operator who tags nine seats to a tier that
// bills eight has recorded something for the next reader, and the next reader can only see it here.
function obItemChip(it){var a=it.acceptance;
return '<span class="chip chip-item-'+esc(it.status)+'">'+esc(it.status)+'</span>'+(a?'<span class="dim small">'+(a.offer?' as '+esc(a.offer):'')+' by '+esc(a.decidedBy)+' on '+esc(String(a.decidedAt).slice(0,10))+(a.note?' - '+esc(a.note):'')+'</span>':'')}
// WHICH KIND of thing this line is, from the bare key's prefix — the four an inventory read produces.
// First in the label cell because a list of "100", "+15550100" and "North dock" reads as one kind of
// thing until something says otherwise, and the four bill under different rules and different controls.
// A FAX LINE is the one kind the key cannot tell you: it is an ordinary number whose dial rule hands it
// to the fax server, so the RECORD decides — rec.fax, set by netsapiens-lib from the deployment's
// NS_FAX_SERVER_HOSTS. Without a record (or on a report cached before 0.7.0) it reads as a number,
// which is what it was called before fax lines were counted apart.
function obKind(k,rec){var b=obBareKey(k);
if(b.indexOf('ext:')===0)return '<span class="kind kind-ext">extension</span>';
if(b.indexOf('did:')===0)return (rec&&rec.fax===true)?'<span class="kind kind-fax">fax line</span>':'<span class="kind kind-did">number</span>';
if(b.indexOf('addr:')===0)return '<span class="kind kind-addr">E911 address</span>';
// e911legacy: FIRST. It does not begin with 'e911:' (there is no colon at that position), so the order
// is not load-bearing today - but a reader should not have to work that out to see they are two rows.
if(b.indexOf('e911legacy:')===0)return '<span class="kind kind-e911legacy">Legacy E911</span>';
if(b.indexOf('e911:')===0)return '<span class="kind kind-e911">E911 endpoint</span>';
if(b.indexOf('sms:')===0)return '<span class="kind kind-sms">SMS number</span>';
return ''}
// What ONE co-holder's own bill says about the same group. billed -1 is "their subscriptions would not
// read", which is a different fact from the zero it would otherwise be indistinguishable from.
function obCoLine(x){if(x.billed<0)return '(could not read)';
if(!x.billed&&!x.entitled)return '(no '+esc(x.group)+' line)';
return '('+esc(x.group)+' x'+obNum(x.billed)+(x.entitled>0?' +'+obNum(x.entitled)+' entitled':'')+')'}
// The other accounts holding this same item, and what each is billed for it. Only an ADDRESS can be on
// two accounts — an address is a fact about a place, and two sites' accounts can each buy an E911 bundle
// for it. Without this line the duplicated count reads as a double-bill; with it, the reader can also
// see the case worth finding, which is a co-holder billing nothing.
// GROUP then key: one item can sit on two comparison rows, and those rows have different billed
// numbers, so the group the caller is drawing has to reach the lookup. hasOwnProperty on both hops --
// a group name is operator-supplied prose out of the rulebook and an item key is report data.
function obCoFor(rep,group,key){var m=rep.coBilled;
if(!m||!Object.prototype.hasOwnProperty.call(m,group))return [];
var g=m[group];
if(!g||!Object.prototype.hasOwnProperty.call(g,key))return [];
return g[key]||[]}
function obShared(it,rep,group){var ws=it.sharedWith;if(!ws||!ws.length)return '';
var cb=obCoFor(rep,group,it.key),o='',i,j,x;
for(i=0;i<ws.length;i++){x=null;
for(j=0;j<cb.length;j++)if(cb[j].accountNumber===ws[i].accountNumber){x=cb[j];break}
o+='<div class="dim small also">also on '+esc(ws[i].accountNumber)+(ws[i].accountName?' — '+esc(ws[i].accountName):'')+(x?' '+obCoLine(x):'')+'</div>'}
return o}
// Who ELSE holds this item's domain — the accounts a Move could send it to. A domain nobody else holds
// offers no control at all: a select with no options beside a Move button is a control that can only be
// clicked into a refusal. Read through hasOwnProperty because a domain is report data, and "constructor"
// is not a holder list.
function obOtherHolders(it,rep){var hs=rep.holders,o=[],l,i;
if(!hs||!Object.prototype.hasOwnProperty.call(hs,it.domain))return o;
l=hs[it.domain]||[];
for(i=0;i<l.length;i++)if(l[i].accountNumber!==rep.accountNumber)o.push(l[i]);
return o}
// One <option> per account a picker offers. The NUMBER is the value the route reads and the NAME is
// what makes the list answerable — a column of CLI numbers asks the operator to recognise one, which is
// the question naming the client answers. An account with no name on the report shows its number alone
// rather than a dangling dash.
function obAcctOpts(as){var o='',i;
for(i=0;i<(as||[]).length;i++){var a=as[i];
o+='<option value="'+esc(a.accountNumber)+'">'+esc(a.accountNumber)+(a.accountName?' — '+esc(a.accountName):'')+'</option>'}
return o}
// Move: the same write the Unassigned picker sends, offered on an item that is already PLACED here. Keyed
// bare beside its own domain, like Clear assignment, because that is the shape the assign route reads.
// data-placed is what tells the click handler which sentence to confirm with — a placed item's acceptance
// on this account goes with it, and an unassigned one has none to lose.
function obMoveCtl(it,rep){var hs=obOtherHolders(it,rep);if(!hs.length)return '';
var o='<select data-role="assign-to">'+obAcctOpts(hs);
return o+'</select><button type="button" class="btn small" data-act="assign" data-placed="1" data-domain="'+esc(it.domain)+'" data-key="'+esc(obBareKey(it.key))+'" data-label="'+esc(it.label)+'">Move</button>'}
// Who could still be ADDED to this item's set: the domain's other holders, minus the ones already on it.
// Offering an account that already holds it is a control whose only outcome is a write that changes
// nothing.
function obAddable(it,rep){var hs=obOtherHolders(it,rep),ws=it.sharedWith||[],o=[],i,j,on;
for(i=0;i<hs.length;i++){on=false;
for(j=0;j<ws.length;j++)if(ws[j].accountNumber===hs[i].accountNumber)on=true;
if(!on)o.push(hs[i])}
return o}
// Which kinds an account SHARES rather than owns outright - an E911 address, an endpoint, a legacy
// number. Mirrors isSharedKind in onebillScope.ts, which is what the assign route enforces; the two
// disagreeing would offer a control the route then refuses.
function obSharedKind(b){return b.indexOf('addr:')===0||b.indexOf('e911:')===0||b.indexOf('e911legacy:')===0}
// A SHARED KIND IS PLACED ON A SET, so its controls are add-one and remove-one rather than Move: moving
// it would take an E911 line off an account that really does bill for the place. Remove appears only
// where this account is in the MANUAL set - an automatic placement belongs to the site link, and the
// site link would put it straight back, so a button offering to undo it does nothing.
function obSharedCtl(it,rep){var o='',as=obAddable(it,rep);
if(it.attribution==='manual')o+='<button type="button" class="btn small" data-act="unassign" data-domain="'+esc(it.domain)+'" data-key="'+esc(obBareKey(it.key))+'" data-label="'+esc(it.label)+'">Remove from this account</button>';
if(as.length)o+='<select data-role="assign-to">'+obAcctOpts(as)+'</select><button type="button" class="btn small" data-act="assign" data-domain="'+esc(it.domain)+'" data-key="'+esc(obBareKey(it.key))+'" data-label="'+esc(it.label)+'">Assign</button>';
return o}
// The acceptance pair, and — on an item somebody placed by hand — the button that takes that decision
// back. Clear assignment is keyed BARE beside its own domain, because that is the shape the assign route
// reads: a scoped key would name the domain twice, once in a field nothing reads it from. Move comes last
// because it is the only one of the three that sends the item somewhere else.
// No data-placed on a shared kind's Assign: it ADDS an account and clears nothing here, so the
// placeholder warning about losing this account's acceptance would be a sentence about the wrong write.
function obItemCtl(it,rep){if(!obCanAct(rep))return '';
var o='';
if(obSharedKind(obBareKey(it.key)))return '<td class="act">'+obSharedCtl(it,rep)+'</td>';
if(it.attribution==='manual')o+='<button type="button" class="btn small" data-act="clear-assign" data-domain="'+esc(it.domain)+'" data-key="'+esc(obBareKey(it.key))+'" data-label="'+esc(it.label)+'">Clear assignment</button>';
o+=obMoveCtl(it,rep);
return '<td class="act">'+o+'</td>'}
// Rendered hidden and always present, rather than built on the first click: the row a click has to swap
// after an accept is then the same row on the first paint and on every refresh.
function obItemRows(r,rep,cols){if(!r.items)return '';var o=r.items.length?obItemHead(rep):'',i;
for(i=0;i<r.items.length;i++){var it=r.items[i];
// ONE lookup per row, shared by the kind chip and the detail cell. Two lookups of the same key is two
// chances for the chip to say "number" while the cell beside it describes a fax line.
var rec=obDetailRec(it.key,rep);
o+='<tr data-item-key="'+esc(it.key)+'" data-status="'+esc(it.status)+'">'+obItemSel(it,r,rep)+'<td>'+obKind(it.key,rec)+esc(it.label)+obItemWhere(it,rep)+obShared(it,rep,r.group)+'</td><td>'+obRecDetail(it.key,rec)+'</td><td>'+obItemChip(it)+obManualChip(it)+'</td>'+obItemCtl(it,rep)+'</tr>'}
return '<tr class="items" data-items-for="'+esc(r.group)+'" hidden><td colspan="'+cols+'"><table class="items"><tbody>'+o+'</tbody></table></td></tr>'}
// What moved since the acceptance, and only that: a drift verdict is the difference between then and
// now, so a sentence about a number that did not change is noise an operator has to read past.
function obDriftLine(r){var G=r.groupRow;if(!G||r.verdict!=='drift')return '';var p=[];
if(G.billed!==r.billed)p.push('Billed '+obNum(G.billed)+' when accepted, '+obNum(r.billed)+' now.');
if(r.items&&r.unreviewed>0)p.push(obNum(r.unreviewed)+' new since accepted.');
if(r.stale>0)p.push(obNum(r.stale)+' accepted item'+(r.stale===1?'':'s')+' no longer exist'+(r.stale===1?'s':'')+'.');
if(!r.items&&G.accepted!==r.observed)p.push('Accepted '+obNum(G.accepted)+', '+obNum(r.observed)+' now.');
return p.length?'<div class="dim small">'+p.join(' ')+'</div>':''}
function obGroupNote(r){var G=r.groupRow;return G&&G.note?'<div class="dim small">'+esc(G.note)+'</div>':''}
// The gap, in words, because three numbers in three columns leave the reader to do the subtraction — and
// the subtraction is not the obvious one: entitlements are headroom above billed, so an unbilled count
// that ignored them would call a row with free capacity a finding. Below billed is the other direction
// and has no entitlement in it: paying for twelve and running ten is ten live, two not. Silent inside the
// range, which is where a healthy row sits.
// SILENT ALSO where observedMissing: that row's Live is 0 because the count path names nothing in this
// deployment's inventory, not because nothing is there. "12 billed, not live" would be a claim about the
// phone system read off a rulebook typo, and the row already says the path counts nothing.
function obDelta(r){if(r.observedMissing)return '';
var ent=r.entitled||0;
if(r.observed>r.billed+ent)return '<div class="dim small">'+obNum(r.observed-r.billed-ent)+' unbilled</div>';
if(r.observed<r.billed)return '<div class="dim small">'+obNum(r.billed-r.observed)+' billed, not live</div>';
return ''}
// Two rules can count the SAME extensions by different tests - Hosted Seats by device presence, Call
// Center Seats by NS role - and two rows reading 18 and 12 add up to 30 in a reader's head when there are
// only 18 things. This says how many of each row's items are on the other. A row wholly inside another
// says so in those words; a partial overlap just gives the number. Sorted by the other group's name, so
// the order does not follow the rulebook's.
// Singular is written out rather than left as "1 of these are": a row with one item is the common case
// on a small domain, and a sentence that does not agree with itself reads as a bug in the page.
function obKeySet(r){var s=Object.create(null),i;for(i=0;i<(r.items||[]).length;i++)s[r.items[i].key]=1;return s}
function obOverlap(r,rep){if(!r.items)return '';
var rs=(rep.comparison&&rep.comparison.rows)||[],mine=obKeySet(r),others=[],o='',i,j;
for(i=0;i<rs.length;i++)if(rs[i]!==r&&rs[i].items)others.push(rs[i]);
others.sort(function(a,b){return String(a.group).localeCompare(String(b.group))});
for(i=0;i<others.length;i++){var x=others[i],n=0;
for(j=0;j<x.items.length;j++)if(mine[x.items[j].key]===1)n++;
if(!n)continue;
o+=(n===r.items.length&&x.items.length>r.items.length)
?(n===1?'<div class="dim small">this one is among the '+obNum(x.items.length)+' on '+esc(x.group)+'</div>'
:'<div class="dim small">these '+obNum(n)+' are among the '+obNum(x.items.length)+' on '+esc(x.group)+'</div>')
:'<div class="dim small">'+obNum(n)+' of these '+(n===1?'is':'are')+' also on '+esc(x.group)+'</div>'}
return o}
// The count of PRESENT items nobody has accepted - not the excess over billed. Twelve seats billed as
// twelve are still twelve things nobody has looked at, and that is what this number says.
function obCounts(r){var o='';if(r.unreviewed>0)o+=' <span class="cnt">'+obNum(r.unreviewed)+' unreviewed</span>';if(r.stale>0)o+=' <span class="cnt">'+obNum(r.stale)+' stale</span>';return o}
// Two pairs over two stores, and NOT over the direction of the gap: accept-all/clear-all act on the item
// acceptances, so they need an item list and nothing else - a row billed for more than it has still has
// items nobody has reviewed. accept-shortfall/clear-shortfall act on the group row, which is what an
// item-less dimension or a genuine shortfall is judged against. A row can offer one of each.
// clear-shortfall also waits for the items to be clear: the route refuses to drop a group row out from
// under an accepted item and says to use Clear all instead, which is the button already beside it.
// Each label names its STORE, never a quantity - "Accept 2" beside "Accept all 2" on a shortfall row
// with items is two different writes wearing one label. The numbers go on the button as data instead,
// because what says them back is the confirmation, and a dialog that counted rows in the DOM would be
// counting whatever the last swap left there rather than what the button was drawn for.
// The group-row pair's label says what the group row MEANS here: "shortfall" where items exist and the
// gap is the seats they cannot explain, "count" where there are none and the group row is the whole
// judgement in either direction - calling an over-observed device row a shortfall would lie about it.
// A match verdict suppresses the GROUP pair (no gap to accept) but not the ITEM pair: a matched row's
// unreviewed items still want accepting, so that a later swap reads as drift rather than match.
// What is ticked in this group's item list right now: how many checked rows each bulk button would act
// on, and every checked key. Defaulted rather than required — the first paint has no selection to read,
// and making every caller construct an empty one would put that shape in two places.
function obNoPick(){return {unreviewed:0,accepted:0,keys:[]}}
// The buttons, without the cell around them — so the change handler can re-render the group's action
// cell alone as boxes are ticked, from the same function that drew it, rather than a second copy of the
// same decisions that could disagree with the one a full paint produces.
function obGroupCtlHtml(r,picked){
var p=picked||obNoPick();
var b=function(act,label,extra){return '<button type="button" class="btn" data-act="'+act+'" data-group="'+esc(r.group)+'"'+extra+'>'+label+'</button>'},o='';
var nAccepted=0,i;for(i=0;i<(r.items||[]).length;i++)if(r.items[i].status==='accepted')nAccepted++;
var groupCtl=r.verdict!=='match'&&(!r.items||r.observed<r.billed);
var gword=r.items?'shortfall':'count';
var gnums=' data-billed="'+obNum(r.billed)+'" data-observed="'+obNum(r.observed)+'"';
if(r.items){
// A selection REPLACES the -all pair rather than sitting beside it: "Accept all 12" next to "Accept
// selected (3)" is two buttons whose difference the reader has to work out from two numbers.
if(p.keys.length){if(p.unreviewed>0)o+=b('accept-selected','Accept selected ('+obNum(p.unreviewed)+')',' data-count="'+obNum(p.unreviewed)+'"');
if(p.accepted>0)o+=b('clear-selected','Clear selected ('+obNum(p.accepted)+')',' data-count="'+obNum(p.accepted)+'"')}
else{if(r.unreviewed>0)o+=b('accept-all','Accept all '+obNum(r.unreviewed),' data-count="'+obNum(r.unreviewed)+'"');
if(nAccepted>0||r.groupRow)o+=b('clear-all','Clear all',' data-count="'+obNum(nAccepted)+'"')}}
if(groupCtl){if(!r.groupRow)o+=b('accept-shortfall','Accept '+gword,gnums+' data-word="'+gword+'"');else if(nAccepted===0)o+=b('clear-shortfall','Clear '+gword,' data-word="'+gword+'"')}
return o}
function obGroupControls(r,rep,picked){if(!obCanAct(rep))return '';
return '<td class="act">'+obGroupCtlHtml(r,picked)+'</td>'}
// How many columns the group row spans - the items row's colspan, and the one thing a caller re-rendering
// a single row after a write has to be told, since it is a fact about the table rather than the row.
function obCompCols(rep){return obCanAct(rep)?6:5}
// data-col on the three number cells: a test (and a reader picking a column out of the DOM) can name
// which count it is looking at, rather than counting <td>s whose number changes with the Accept column.
// A row with nothing billed, nothing observed, no items (present or stale), no recorded group decision:
// there is no gap, nothing to review and nothing to undo, so the Details link would open an empty list
// and the row is drawn quiet rather than pretending it has something to say. A recorded groupRow, any
// item, or any nonzero count means a decision or a change is on file even at 0/0, and is not idle.
function obRowIdle(r){return r.billed===0&&r.observed===0&&(!r.items||r.items.length===0)&&!r.groupRow&&r.stale===0}
function obCompRow(r,rep,cols){
var dims=(r.dimensions&&r.dimensions.length)?r.dimensions.join(' + '):r.dimension;
var idle=obRowIdle(r);
return '<tr data-verdict="'+esc(r.verdict)+'" data-group="'+esc(r.group)+'"'+(idle?' class="idle"':'')+'><td><b>'+esc(r.group)+'</b><div class="dim small">'+esc(dims)+(r.observedMissing?' (this deployment counts nothing at that path)':'')+'</div>'+obOverlap(r,rep)+obOfferList(r)
+(!idle&&r.items?'<button type="button" class="linkish" data-act="toggle-items" data-group="'+esc(r.group)+'" aria-expanded="false">Details</button>':'')+'</td>'
+'<td class="n" data-col="billed">'+obNum(r.billed)+obEntitled(r)+'</td><td class="n" data-col="observed">'+obNum(r.observed)+'</td>'
+'<td class="n" data-col="accepted">'+(r.items?obNum(r.items.length-r.unreviewed-r.stale):(r.groupRow?obNum(r.groupRow.accepted):'-'))+'</td>'
+'<td>'+obOptionalChip(r)+obCounts(r)+obDelta(r)+obDriftLine(r)+obGroupNote(r)+'</td>'+obGroupControls(r,rep)+'</tr>'+(idle?'':obItemRows(r,rep,cols))}
function obCompRows(rep){var rs=(rep.comparison&&rep.comparison.rows)||[],o='',i,cols=obCompCols(rep);
for(i=0;i<rs.length;i++)o+=obCompRow(rs[i],rep,cols);
return o}
// Ignored offers are folded in here rather than given a section of their own: they are the other half of
// "what did the rulebook do with each line", and a reader checking one is checking both.
function obUnmapped(rep){var c=rep.comparison||{},us=c.unmapped||[],ig=c.ignored||[],o='',i;
if(us.length){for(i=0;i<us.length;i++)o+='<li>'+esc(us[i].name)+' x'+obNum(us[i].quantity)+'</li>';o='<h3>Recurring lines no rule accounts for</h3><ul class="unmapped">'+o+'</ul>'}
if(ig.length){var g='';for(i=0;i<ig.length;i++)g+='<li>'+esc(ig[i].name)+' x'+obNum(ig[i].quantity)+' <span class="dim small">'+esc(ig[i].rule)+'</span></li>';o+='<details class="ignored"><summary>Ignored by rule ('+ig.length+')</summary><ul class="unmapped">'+g+'</ul></details>'}
if(c.catalogMisses&&c.catalogMisses.length)o+='<p class="dim small">The catalogue does not know '+obNum(c.catalogMisses.length)+' plan name(s) a code-keyed rule would need: '+esc(c.catalogMisses.join(', '))+'.</p>';
return o}
// A count of 0 for something whose read failed is a read error wearing a number's clothes. Named under
// the header, because the row it makes untrustworthy is a row with an Accept on it. The list is no longer
// device-only — a whole domain that would not read, a domain's devices and a domain's SMS numbers all
// arrive here as "<domain>: ..." lines — so the sentence names neither devices nor a cause, and the lines
// are joined with '; ' because each one already contains commas of its own.
function obReadFails(rep){var fs=rep.readFailures||[];if(!fs.length)return '';
return '<p class="fail">Some reads did not complete: '+esc(fs.join('; '))+'. Counts from those reads are not facts - refresh before accepting a gap they touch.</p>'}
// Keys sorted, so the same inventory always lists in the same order — an object's own key order depends
// on how it was built, and a breakdown that reshuffles between two loads reads as data that changed.
function obBreakdown(t,m){var ks=Object.keys(m||{}).sort(),o='',i;
if(!ks.length)return '';
for(i=0;i<ks.length;i++)o+='<li>'+esc(ks[i]===''?'(no service code)':ks[i])+' - '+obNum(m[ks[i]])+'</li>';
return '<div class="bd"><b>'+esc(t)+'</b><ul>'+o+'</ul></div>'}
// The domains that have unassigned items, in first-appearance order — a grouping that does not depend on
// the list arriving sorted, which is a fact about scopeInventory rather than about this renderer.
// Object.create(null), not {}: a domain string is report data, and on an ordinary object "__proto__" is
// a setter rather than a key — the write would be swallowed and the domain would head a second table.
function obUnaDomains(us){var o=[],seen=Object.create(null),i;
for(i=0;i<us.length;i++)if(seen[us[i].domain]!==1){seen[us[i].domain]=1;o.push(us[i].domain)}
return o}
// Items on a domain this account touches that NO account holds — an orphaned site, an address two sites
// share. Each names why, and offers the accounts that could take it. Rendered for a reader too: what is
// unassigned is a reading of the domain, and only the picker is a write.
function obUnassigned(rep){var us=rep.unassigned||[],act=obCanAct(rep),ds=obUnaDomains(us),o='',i,j;
if(!us.length)return '';
for(i=0;i<ds.length;i++){o+='<h3>Unassigned on '+esc(ds[i])+'</h3><table class="una"><tbody>';
for(j=0;j<us.length;j++){var u=us[j];if(u.domain!==ds[i])continue;
var ctl='';
// No candidates, no picker: an empty select beside an Assign button is a control that can only be
// clicked into a 400. The reason still renders — that this has nowhere to go is the thing to read.
if(act&&(u.candidates||[]).length){var sel='<select data-role="assign-to">'+obAcctOpts(u.candidates)+'</select>';
ctl='<td class="act">'+sel+'<button type="button" class="btn small" data-act="assign" data-domain="'+esc(u.domain)+'" data-key="'+esc(u.key)+'" data-label="'+esc(u.label)+'">Assign</button></td>'}
o+='<tr data-unassigned-key="'+esc(u.key)+'" data-domain="'+esc(u.domain)+'">'
// The record is ON the row here, not in rep.detail — an unassigned item is by definition outside the
// account's slice — so the kind chip is told the same fact by a different route.
+'<td>'+obKind(u.key,u.item)+esc(u.label)+'</td>'
// The same cell a placed item gets, from the record on the row: an operator deciding who a number
// belongs to needs to know where it rings, and the label is a bare number until something says so.
+'<td>'+obRecDetail(u.key,u.item)+'</td>'
+'<td>'+esc(u.reason)+(u.staleAssignment?(' — assigned to '+esc(u.staleAssignment)+', which no longer holds this domain'):'')+'</td>'
+ctl+'</tr>'}
o+='</tbody></table>'}
return o}
// What the WHOLE domain holds, beside the slice this account bills for — and only where the two differ,
// which on a single-domain account they never do. One number per JUDGED dimension and no more; a
// breakdown here would be a second inventory nobody asked for. E911 endpoints and legacy numbers joined
// the list when they became billable dimensions, for the reason fax lines did before them: a domain
// differing from this slice by nothing but its endpoints would otherwise print no line at all.
function obDomainTotals(rep){var ds=rep.domains||[],t=rep.domainTotals||{},v=rep.inventory||{},o='',i;
for(i=0;i<ds.length;i++){var d=ds[i];
if(!Object.prototype.hasOwnProperty.call(t,d))continue;
var x=t[d],xe=x.extensions||{},xd=x.dids||{},ve=v.extensions||{},vd=v.dids||{};
// Fax lines are in the test AND in the sentence: they are a judged dimension of their own now, and a
// domain differing from this slice by nothing but its fax lines would otherwise print no line at all.
if(xe.total===ve.total&&xd.total===vd.total&&xd.fax===vd.fax&&x.e911Endpoints===v.e911Endpoints&&x.e911Legacy===v.e911Legacy&&x.e911Addresses===v.e911Addresses&&x.smsNumbers===v.smsNumbers)continue;
o+='<div class="dim small">of '+esc(d)+': '+obNum(xe.total)+' extensions · '+obNum(xd.total)+' numbers · '+obNum(xd.fax)+' fax lines · '+obNum(x.e911Endpoints)+' E911 endpoints · '+obNum(x.e911Legacy)+' legacy E911 · '+obNum(x.e911Addresses)+' E911 addresses · '+obNum(x.smsNumbers)+' SMS numbers</div>'}
return o}
// A domain that would not read makes every count on this page a lower bound, so nothing is accepted from
// it. Said where an Accept would have been, rather than only withheld: a panel that quietly dropped its
// controls reads as a permissions problem.
function obPartial(rep){return rep.partial?'<p class="fail">One of this account\'s domains could not be read, so the counts are incomplete and nothing can be accepted from this view. Refresh to try again.</p>':''}
// Extensions carrying nothing at all — no handset, no softphone, no Teams connector. Informational and
// closed by default: a seat rule counting extensions.withAnyDevice already excludes these, so this is
// the list explaining a gap between that count and the extension total rather than anything to accept.
// Nothing at all when there are none, because a standing empty section reads as a section that failed.
function obNoDevice(rep){var xs=((rep.detail||{}).extensions)||[],o='',i,n=0;
for(i=0;i<xs.length;i++){var x=xs[i];
if(x.anyDevice)continue;
n++;
o+='<tr><td>'+esc(x.ext)+'</td><td>'+esc([x.name,x.site,x.scope].filter(Boolean).join(' · '))+'</td></tr>'}
if(!n)return '';
return '<details class="nodev"><summary>Extensions without a device ('+obNum(n)+')</summary><table class="nodev"><tbody>'+o+'</tbody></table></details>'}
function obInventory(rep){var v=rep.inventory||{},e=v.extensions||{},d=v.dids||{},dv=v.devices||{},s=v.systemUsers||{};
return '<h3>What is on the phone system</h3><div class="inv">'
+'<div class="bd"><b>Extensions</b><ul><li>Total - '+obNum(e.total)+'</li>'
+'<li>Transcription enabled - '+obNum(v.transcriptionEnabled)+'</li></ul></div>'
+obBreakdown('Extensions by scope',e.byScope)
+obBreakdown('Extensions by service code',e.byServiceCode)
+obBreakdown('Extensions by device count',e.byDeviceCount)
+obBreakdown('System users',s.byServiceCode)
// Total is dids.ALL - every number the domain holds - and the three lines under it partition it:
// toll-free + local + fax. netsapiens-lib 0.7.0 takes fax lines out of dids.total (they bill as fax
// lines, not as DIDs), so a summary headed by that number would under-report what is actually there,
// and a Total its own breakdown does not add up to is the kind of number a reader stops trusting.
// The all==null fallback is the same rule every other field here follows: a report cached before the
// field existed still renders, with the number it used to show.
+'<div class="bd"><b>Numbers</b><ul><li>Total - '+obNum(d.all==null?d.total:d.all)+'</li><li>Toll-free - '+obNum(d.tollFree)+'</li><li>Local - '+obNum(d.local)+'</li>'
+'<li>Fax lines - '+obNum(d.fax)+'</li>'
// The ENDPOINT is the billed E911 unit, and a LEGACY number is the same thing on a domain that predates
// endpoints - so they share a line, and the ADDRESS count stays beneath them as information. An address
// is where responders are sent; nobody bills one.
+'<li>E911 endpoints - '+obNum(v.e911Endpoints)+' · legacy numbers - '+obNum(v.e911Legacy)+'</li>'
+'<li>E911 addresses - '+obNum(v.e911Addresses)+'</li><li>SMS numbers - '+obNum(v.smsNumbers)+'</li></ul></div>'
+'<div class="bd"><b>Devices</b><ul><li>Total - '+obNum(dv.total)+'</li></ul></div>'
+obBreakdown('Devices by model',dv.byModel)
+'</div>'+obDomainTotals(rep)+obNoDevice(rep)}
function obPanel(rep){rep=rep||{};
var acct=esc(rep.accountNumber);
// The ACCOUNT is the subject: one panel can span two domains and half of a third, so a domain in the
// heading would name whichever the operator happened to click. Its extent goes underneath.
var head='<header class="panel-head"><button type="button" class="btn" data-act="back">Back to the list</button>'
+'<h2>'+acct+(rep.accountName?(' — '+esc(rep.accountName)):'')+'</h2>'
+'<div class="dim">'+obScopesLine(rep)+'</div>'
+'<div class="dim small">Loaded '+esc(String(rep.loadedAt||'').replace('T',' ').slice(0,16))+' UTC <button type="button" class="btn" data-act="refresh-account">Refresh</button></div></header>';
var note=rep.baselinesEnabled?'':'<p class="dim">Baselines are not configured on this deployment, so gaps cannot be accepted here.</p>';
var acceptHead=obCanAct(rep)?'<th></th>':'';
var table='<table class="cmp"><thead><tr><th>Group</th><th class="n">Billed</th><th class="n">Live</th><th class="n">Accepted</th><th>Verdict</th>'+acceptHead+'</tr></thead><tbody>'+obCompRows(rep)+'</tbody></table>';
return '<section class="panel">'+head+obPartial(rep)+obReadFails(rep)+note+table+obUnmapped(rep)+obUnassigned(rep)+obInventory(rep)+'</section>'}
`;

/** The write surface. Emitted ONLY for a caller who holds `onebill.write` — see {@link ROW_STUB}. */
const ROW_WRITE = String.raw`
// What a confirmation adds when the table it was clicked from is a quick view. Not a warning: the write
// is no less safe there, because the route re-reads THIS account's record and builds its bounds from
// that before writing anything. The reader is told because the row they clicked may be a little behind.
function obUnv(){return (OB_LAST_REP&&OB_LAST_REP.mode==='quick')?'\n\n(quick view — this account\'s record is re-read before writing)':''}
// The row's own decision, in the FIRST cell beside its checkbox. The two controls that send an item
// somewhere else stay on the far side of the row: they are the ones a mis-click cannot be undone by the
// button that replaces it.
// No checkbox on a stale row. The two bulk buttons count checked-unreviewed and checked-accepted, so a
// checked stale item would be carried by neither and the selection would name a number it cannot act on.
// Its own Clear is still here, which is the one thing a stale acceptance needs.
function obItemSel(it,r,rep){if(!obCanAct(rep))return '<td class="sel"></td>';
var act=it.status==='unreviewed'?'accept-item':'clear-item';
var box=it.status==='stale'?'':'<input type="checkbox" data-role="pick" data-key="'+esc(it.key)+'">';
return '<td class="sel">'+box+'<button type="button" class="btn small" data-act="'+act+'" data-group="'+esc(r.group)+'" data-key="'+esc(it.key)+'">'+(act==='accept-item'?'Accept':'Clear')+'</button></td>'}
// One box that ticks every UNREVIEWED row, so a group of twelve is accepted in one decision without
// twelve clicks and without re-accepting the ones already decided. Write build only: a reader has
// nothing to select. Five empty cells rather than a colspan, so the header cannot drift from the row.
function obItemHead(rep){if(!obCanAct(rep))return '';
return '<tr class="ihead"><td class="sel"><input type="checkbox" data-role="pick-all" aria-label="Select every unreviewed item"></td><td></td><td></td><td></td><td class="act"></td></tr>'}
function obDefaultSite(r){if(r.state!=='split')return '';
var ls=r.linkedSites||[];
for(var i=0;i<r.sites.length;i++)if(ls.indexOf(r.sites[i])<0)return r.sites[i];
return ''}
function obSites(r){if(r.site||!r.sites||!r.sites.length)return '';
var df=obDefaultSite(r);
var o='<select class="site" data-domain="'+esc(r.domain)+'"><option value=""'+(df===''?' selected':'')+'>whole domain</option>';
for(var i=0;i<r.sites.length;i++)o+='<option value="'+esc(r.sites[i])+'"'+(r.sites[i]===df?' selected':'')+'>'+esc(r.sites[i])+'</option>';
return o+'</select>'}
var OB_COLS=5;
function obActionCell(r){return '<td class="act">'+obAction(r)+'</td>'}
function obAction(r){
if(r.state==='linked'){var la=(r.accounts||[])[0];if(!la||!la.links)return '';
if(la.restricted)return '<div class="note">This account also has links to domains this portal is set not to show. Change them in OneBill.</div>';
return obEditor(r,la)}
if(r.state!=='unlinked'&&r.state!=='split')return '';
var d=' data-domain="'+esc(r.domain)+'" data-site="'+esc(r.site||'')+'"';
if(r.state==='unlinked'&&r.candidate)return '<label class="pickwrap"><input type="checkbox" class="pick" data-account="'+esc(r.candidate.accountNumber)+'"'+d+' checked> select</label>'
+obSites(r)+'<button type="button" class="btn" data-act="link" data-account="'+esc(r.candidate.accountNumber)+'"'+d+'>Link</button>';
return '<input class="acct" data-role="acct" placeholder="Client name or account number" autocomplete="off"'+d+'>'
+'<ul class="ta" data-role="acctlist" hidden></ul>'+obSites(r)
+'<button type="button" class="btn" data-act="link"'+d+'>'+(r.state==='split'?'Link another site':'Link')+'</button>'}
// The account picker. The report's account list arrives with the rows, so the matches are drawn here
// rather than shipped as a datalist of numbers nobody has memorised.
var OB_ACCTS=[];
function obAccountMatches(as,q){var s=String(q==null?'':q).trim().toLowerCase(),o=[];
for(var i=0;i<(as||[]).length;i++){var a=as[i];
if(s&&String(a.accountName||'').toLowerCase().indexOf(s)<0&&String(a.accountNumber||'').toLowerCase().indexOf(s)<0)continue;
o.push(a)}
o.sort(function(x,y){return String(x.accountName||'').localeCompare(String(y.accountName||''))||String(x.accountNumber||'').localeCompare(String(y.accountNumber||''))});
return o.slice(0,12)}
function obTaLabel(a){return (a.accountName?a.accountName+' — ':'')+a.accountNumber}
// Which typeahead list is open, if any, and how to close it. ONE pair of page-level listeners acts on
// it: obTypeahead runs again on EVERY render, so registering them per row left the previous render's
// set attached — a Refresh, or any apply, added a whole new one.
var OB_TA=null;
function obTaShut(){var t=OB_TA;if(!t)return;OB_TA=null;t.close()}
if(typeof window!=='undefined'&&window.addEventListener){
// Any scroll UNDER the list moves the rect it was placed against, so the list has to go. Its OWN scroll
// does not: an arrow key past the visible window scrolls it, and closing there would eat the keystroke.
window.addEventListener('scroll',function(ev){var t=OB_TA;if(!t)return;
if(ev.target===t.ul||(t.ul.contains&&t.ul.contains(ev.target)))return;
obTaShut()},true);
window.addEventListener('resize',function(){obTaShut()})}
// The row remembers the NUMBER in data-acct; the input shows the human label. Editing the text clears
// it, so a stale pick can never be sent under a name the reader has since typed over.
function obTypeahead(row){var inp=row.querySelector('input[data-role="acct"]'),ul=row.querySelector('ul[data-role="acctlist"]');
if(!inp||!ul)return;var cur=[],idx=-1;
function close(){if(OB_TA&&OB_TA.ul===ul)OB_TA=null;ul.hidden=true;ul.innerHTML='';cur=[];idx=-1}
function draw(){cur=obAccountMatches(OB_ACCTS,inp.value);
if(!cur.length){close();return}
if(idx>=cur.length)idx=cur.length-1;
var o='';for(var i=0;i<cur.length;i++)o+='<li class="ta-row'+(i===idx?' on':'')+'" data-acct="'+esc(cur[i].accountNumber)+'"><strong>'+esc(cur[i].accountName||'(no name)')+'</strong> <span class="ta-num">'+esc(cur[i].accountNumber)+'</span></li>';
ul.innerHTML=o;ul.hidden=false;OB_TA={ul:ul,close:close};
// Fixed, and placed at open: the table scrolls sideways in a clipping box, so an absolutely positioned
// list inside it would be cut off exactly when the row is near the right edge.
var r=inp.getBoundingClientRect();ul.style.left=r.left+'px';ul.style.top=(r.bottom+2)+'px';ul.style.minWidth=r.width+'px';
if(idx>=0&&ul.children[idx]&&ul.children[idx].scrollIntoView)ul.children[idx].scrollIntoView({block:'nearest'})}
function pick(i){var a=cur[i];if(!a)return;row.setAttribute('data-acct',a.accountNumber);inp.value=obTaLabel(a);close()}
inp.addEventListener('focus',function(){idx=-1;draw()});
inp.addEventListener('input',function(){row.removeAttribute('data-acct');idx=-1;draw()});
inp.addEventListener('keydown',function(ev){
if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){if(ul.hidden){draw();if(!cur.length)return}
idx+=(ev.key==='ArrowDown'?1:-1);if(idx<0)idx=cur.length-1;if(idx>=cur.length)idx=0;draw();ev.preventDefault();return}
if(ev.key==='Enter'){if(!ul.hidden&&idx>=0){pick(idx);ev.preventDefault()}return}
if(ev.key==='Escape'){close()}});
// A tick, because a click on the list is a blur on the input: closing first would delete the row the
// pointer is on. mousedown carries the pick before the blur regardless, and preventDefault keeps focus.
inp.addEventListener('blur',function(){setTimeout(close,150)});
ul.addEventListener('mousedown',function(ev){var li=ev.target&&ev.target.closest?ev.target.closest('li'):null;
if(!li)return;ev.preventDefault();
for(var i=0;i<cur.length;i++)if(cur[i].accountNumber===li.getAttribute('data-acct')){pick(i);break}});}
// Which account a Link on this row means. A pick wins; otherwise a typed value that IS an account
// number, a name or the label the picker writes resolves to it, so a keyboard-only reader is not stuck.
// Anything else goes as typed — the same as before this picker existed, and the route grades it.
function obResolveAcct(row){var d=row.getAttribute('data-acct');if(d)return d;
var inp=row.querySelector('input[data-role="acct"]'),v=inp?inp.value.trim():'';
if(!v)return '';var s=v.toLowerCase();
for(var i=0;i<OB_ACCTS.length;i++){var a=OB_ACCTS[i];
if(String(a.accountNumber||'').toLowerCase()===s||String(a.accountName||'').toLowerCase()===s||obTaLabel(a).toLowerCase()===s)return a.accountNumber}
return v}
function obAfterRender(rep){OB_ACCTS=(rep&&rep.accounts)||[];
var rs=document.querySelectorAll('tr[data-state]');
for(var i=0;i<rs.length;i++)obTypeahead(rs[i])}
// ── editing a link that already exists ─────────────────────────────────────────────────────────────
// One link, three things a reader can do to it, and every one of them is ONE op on ONE account. What
// makes them safe is the account's OTHER links riding along: a change-site and an unlink are both
// "make this account's links match this list", so a list missing one is a silent deletion.
function obLink(d,s){return s?{domain:d,site:s}:{domain:d}}
function obOther(a,domain,site){var ls=(a&&a.links)||[],o=[];
for(var i=0;i<ls.length;i++){var l=ls[i];if(l.domain===domain&&(l.site||'')===(site||''))continue;o.push(obLink(l.domain,l.site))}
return o}
// removeUnlisted only where something is taken away. Adding a site removes nothing, so it never
// matches the record — on THIS account it rides in one op carrying the full list, on another it is an
// ordinary link op that touches nothing either account already holds.
function obEditOps(r,a,act,args){var g=args||{},ls=(a&&a.links)||[];
var others=obOther(a,r.domain,r.site);
if(act==='unlink')return [{accountNumber:a.accountNumber,links:others,removeUnlisted:true}];
if(act==='site'){var nl=obLink(r.domain,g.site||'');var dup=others.some(function(o){return o.domain===nl.domain&&(o.site||'')===(nl.site||'')});return [{accountNumber:a.accountNumber,links:dup?others:others.concat([nl]),removeUnlisted:true}]}
if(act==='add'){var ln=obLink(r.domain,g.site||''),to=g.account||a.accountNumber;
if(to!==a.accountNumber)return [{accountNumber:to,links:[ln]}];
var all=[];for(var i=0;i<ls.length;i++)all.push(obLink(ls[i].domain,ls[i].site));
return [{accountNumber:to,links:all.concat([ln])}]}
return []}
// The sites this account does not already hold on this domain — the only ones "add a site" can offer.
// Derived from the account's own links because that is what the ROW knows: a site billed to a DIFFERENT
// account is a separate row this one cannot see, and adding it here surfaces as a conflict on the next
// read rather than as a bad write.
function obFreeSites(r,a){var ss=r.sites||[],ls=(a&&a.links)||[],out=[];
for(var i=0;i<ss.length;i++){var s=ss[i],held=false;
for(var j=0;j<ls.length;j++)if(ls[j].domain===r.domain&&(ls[j].site||'')===s)held=true;
if(!held)out.push(s)}
return out}
function obEditSel(role,sites,sel,whole){var o='<select class="site" data-role="'+esc(role)+'">';
if(whole)o+='<option value=""'+(sel===''?' selected':'')+'>whole domain</option>';
for(var i=0;i<sites.length;i++)o+='<option value="'+esc(sites[i])+'"'+(sites[i]===sel?' selected':'')+'>'+esc(sites[i])+'</option>';
return o+'</select>'}
function obErow(label,body){return '<div class="erow"><span class="elab">'+esc(label)+'</span>'+body+'</div>'}
// The editor carries what an op needs on its own attributes, the way a foreign row carries its links:
// the click handler has the DOM and nothing else, and re-deriving the account from the table would be
// a second source for a fact the row already knows.
function obEditor(r,a){var ss=r.sites||[],ls=a.links||[],free=obFreeSites(r,a),o='';
if(ss.length)o+=obErow('Change site',obEditSel('esite',ss,r.site||'',true)+'<button type="button" class="btn" data-act="edit-site">Change</button>');
if(free.length)o+=obErow('Add a site',obEditSel('asite',free,free[0],false)
+'<input class="acct" data-role="acct" placeholder="This account, or search for another" autocomplete="off">'
+'<ul class="ta" data-role="acctlist" hidden></ul>'
+'<button type="button" class="btn" data-act="edit-add">Add</button>');
var kept=ls.length-1;
o+=obErow('Unlink',(kept>0?'<span class="note">The account keeps its '+(kept===1?'one other link':esc(kept)+' other links')+'.</span>':'')
+'<button type="button" class="btn" data-act="edit-unlink">Unlink this link</button>');
return '<button type="button" class="btn" data-act="edit">Edit</button>'
+'<div class="editor" data-role="editor" data-domain="'+esc(r.domain)+'" data-site="'+esc(r.site||'')+'" data-account="'+esc(a.accountNumber)+'" data-name="'+esc(a.accountName||'')+'" data-links="'+esc(JSON.stringify(ls))+'" hidden>'+o+'</div>'}
// A CLOSED account is one this deployment does not write to: the report's own account list is Active
// only, so the apply route would refuse the op. Offering the button anyway would be offering a click
// that always ends in a 400 naming a rule the reader cannot see from here.
// KEPT although buildLinkReport no longer puts a closed row in foreign[]: the page renders whatever
// report it is handed, and a report cached before that rule shipped still carries closed rows for up to
// the report TTL. The branch costs two lines and is the difference between a note and a 400.
function obRemove(x){if(x.state==='closed')return '<div class="note">Closed account — links on it are not written from here.</div>';
if(x.restricted)return '<div class="note">This account also has links to domains this portal is set not to show. Change them in OneBill.</div>';
return '<button type="button" class="btn" data-act="remove">Remove this link</button>'}
`;

/**
 * The read-only build. The controls are ABSENT, not disabled: a disabled button still names an action
 * the reader cannot take, and still ships the code behind it to someone the route would refuse. The
 * page says which key would grant them instead, which a page with silently missing controls cannot.
 */
const ROW_STUB = String.raw`
// A column that can never hold anything is not an empty column, it is a column that should not be there.
var OB_COLS=4;
function obActionCell(r){return ''}
// The item list's first cell, empty. Present rather than absent so the nested table's column count is
// the same for a reader as for a writer; the checkbox and the row's own Accept live in ROW_WRITE, so a
// read-only page does not carry their bytes at all.
function obItemSel(it,r,rep){return '<td class="sel"></td>'}
function obItemHead(rep){return ''}
function obRemove(x){return ''}
// No editor either: the whole point of the Action cell being absent is that nothing in it ships.
function obEditor(r,a){return ''}
// The read-only build has no picker to attach, and render() must not have to know that.
function obAfterRender(rep){}
`;

/** The row renderer as it is shipped to this caller. Exported so the selftest can run it in a VM. */
export const rowScript = (canWrite: boolean): string => ROW_BASE + (canWrite ? ROW_WRITE : ROW_STUB);

// ── the same renderer, server-side ──────────────────────────────────────────────────────────────────
// Mirrors rowScript() byte for byte; the selftest asserts that rather than trusting it.

/**
 * Every account mention carries `data-account` — mirrors `obAcct`. Two callers can render the SAME account (a split parent's site line and that site's own
 * row), so this is what lets `obPaintApplied` find every mention by identity rather than by array
 * index, which a client-side re-sort of the groups (see `obSortGroups`) would otherwise desync.
 */
const acct = (a: { accountNumber: string; accountName?: string }): string => {
  const label = esc(a.accountNumber) + (a.accountName ? ` — ${esc(a.accountName)}` : '');
  return `<span data-account="${esc(a.accountNumber)}">${label}</span>`;
};
const notes = (ns: string[] | undefined): string =>
  (ns ?? []).map((n) => `<div class="note">${esc(n)}</div>`).join('');
// `split` reads as a token and not as a fact; the state stays one word in the data and in the class,
// and only the visible label spells it out. Mirrored in `obChip`, and the mirror test draws a split row.
const chip = (s: string): string => `<span class="chip chip-${esc(s)}">${esc(s === 'split' ? 'split by site' : s)}</span>`;

/** Mirrors `obSacct`/`obSiteAccts`: a split parent's Account cell, one line per sited claimant. */
const sacct = (x: NonNullable<LinkReport['rows'][number]['siteAccounts']>[number]): string =>
  `<div class="sacct"><b class="sname">${esc(x.site)}</b> — ${acct(x.account)}${x.usageHolder ? ' <span class="chip usage">USAGE</span>' : ''}</div>`;
function siteAccts(r: LinkReport['rows'][number]): string {
  const sa = r.siteAccounts ?? [];
  if (!sa.length) return '';
  const any = sa.some((x) => x.usageHolder);
  return sa.map((x) => sacct(x)).join('') + (any ? '' : '<div class="dim">No account on this domain holds a usage subscription.</div>');
}

/** Mirrors `obSiteCountLine`: a site row's own count, said in words rather than left for a reader to
 *  derive by scrolling up to the parent and counting its siblings. Site rows only — `siteCount` is never
 *  set on any other row. */
function siteCountLine(r: LinkReport['rows'][number]): string {
  if (!r.site || !r.siteCount) return '';
  return `<div class="dim">(${r.siteCount === 1 ? 'the only site on this domain' : `one of ${r.siteCount} sites on this domain`})</div>`;
}

/**
 * On a SPLIT row the default is the first site OneBill does not already bill — the action there is
 * "add the next site". Everywhere else the default stays "whole domain": linking a split domain as a
 * whole is a deliberate act, so it is offered without being the thing a distracted click sends.
 */
function defaultSite(r: LinkReport['rows'][number]): string {
  if (r.state !== 'split') return '';
  const linked = r.linkedSites ?? [];
  return r.sites.find((s) => !linked.includes(s)) ?? '';
}

function sitePicker(r: LinkReport['rows'][number]): string {
  if (r.site || !r.sites || !r.sites.length) return '';
  const df = defaultSite(r);
  return `<select class="site" data-domain="${esc(r.domain)}"><option value=""${df === '' ? ' selected' : ''}>whole domain</option>`
    + r.sites.map((s) => `<option value="${esc(s)}"${s === df ? ' selected' : ''}>${esc(s)}</option>`).join('')
    + '</select>';
}

// ── the editor, server-side. Mirrors obLink/obFreeSites/obEditSel/obErow/obEditor ──────────────────
// `obEditOps` has no mirror on purpose: it produces an OP, not markup, so there is nothing for the
// mirror test to compare — it is asserted directly, by evaluating the client copy in a VM.

const editSel = (role: string, sites: string[], sel: string, whole: boolean): string =>
  `<select class="site" data-role="${esc(role)}">`
  + (whole ? `<option value=""${sel === '' ? ' selected' : ''}>whole domain</option>` : '')
  + sites.map((x) => `<option value="${esc(x)}"${x === sel ? ' selected' : ''}>${esc(x)}</option>`).join('')
  + '</select>';

const erow = (label: string, body: string): string => `<div class="erow"><span class="elab">${esc(label)}</span>${body}</div>`;

/** Sites this account does not already hold on this domain — mirrors `obFreeSites`, same reasoning. */
function freeSites(r: LinkReport['rows'][number], a: LinkReport['rows'][number]['accounts'][number]): string[] {
  const ls = a?.links ?? [];
  return (r.sites ?? []).filter((x) => !ls.some((l) => l.domain === r.domain && (l.site ?? '') === x));
}

/**
 * The inline editor on a linked row: change this link's site, add a second site (here or on another
 * account), unlink it. Mirrors `obEditor`.
 */
function editor(r: LinkReport['rows'][number], a: LinkReport['rows'][number]['accounts'][number]): string {
  const ss = r.sites ?? [];
  const ls = a.links ?? [];
  const free = freeSites(r, a);
  let o = '';
  if (ss.length) o += erow('Change site', editSel('esite', ss, r.site ?? '', true) + '<button type="button" class="btn" data-act="edit-site">Change</button>');
  if (free.length) o += erow('Add a site', editSel('asite', free, free[0]!, false)
    + '<input class="acct" data-role="acct" placeholder="This account, or search for another" autocomplete="off">'
    + '<ul class="ta" data-role="acctlist" hidden></ul>'
    + '<button type="button" class="btn" data-act="edit-add">Add</button>');
  const kept = ls.length - 1;
  o += erow('Unlink', (kept > 0 ? `<span class="note">The account keeps its ${kept === 1 ? 'one other link' : `${esc(String(kept))} other links`}.</span>` : '')
    + '<button type="button" class="btn" data-act="edit-unlink">Unlink this link</button>');
  return '<button type="button" class="btn" data-act="edit">Edit</button>'
    + `<div class="editor" data-role="editor" data-domain="${esc(r.domain)}" data-site="${esc(r.site ?? '')}" data-account="${esc(a.accountNumber)}" data-name="${esc(a.accountName ?? '')}" data-links="${esc(JSON.stringify(ls))}" hidden>${o}</div>`;
}

function actionCell(r: LinkReport['rows'][number], canWrite: boolean): string {
  return canWrite ? `<td class="act">${action(r)}</td>` : '';
}

function action(r: LinkReport['rows'][number]): string {
  // A linked row is the only one with something to EDIT. A restricted account gets the reason instead
  // of the controls, for the same cause `removeControl` does: every edit here is (or rides in) a
  // matching write, and the apply route refuses those on exactly this account.
  if (r.state === 'linked') {
    const la = r.accounts?.[0];
    // NO `links`, NO EDITOR. A report cached before this field shipped still renders for up to its TTL,
    // and treating absent as empty would draw an Unlink that sends `links: []` with removeUnlisted —
    // clearing the account instead of removing one link. Drawing nothing is what this row did before.
    if (!la || !la.links) return '';
    if (la.restricted) return '<div class="note">This account also has links to domains this portal is set not to show. Change them in OneBill.</div>';
    return editor(r, la);
  }
  if (r.state !== 'unlinked' && r.state !== 'split') return '';
  const d = ` data-domain="${esc(r.domain)}" data-site="${esc(r.site ?? '')}"`;
  if (r.state === 'unlinked' && r.candidate) {
    return `<label class="pickwrap"><input type="checkbox" class="pick" data-account="${esc(r.candidate.accountNumber)}"${d} checked> select</label>`
      + sitePicker(r)
      + `<button type="button" class="btn" data-act="link" data-account="${esc(r.candidate.accountNumber)}"${d}>Link</button>`;
  }
  // The list is EMPTY here and filled in by the client copy: the matches depend on what the reader has
  // typed, which the server has not seen.
  return `<input class="acct" data-role="acct" placeholder="Client name or account number" autocomplete="off"${d}>`
    + '<ul class="ta" data-role="acctlist" hidden></ul>' + sitePicker(r)
    + `<button type="button" class="btn" data-act="link"${d}>${r.state === 'split' ? 'Link another site' : 'Link'}</button>`;
}

/** Mirrors `obSplitOne`: do every site of this split domain bill to ONE account? Then the domain has a
 *  single subject and `?domain=` resolves to it; two accounts and a click on the domain names nothing. */
function splitOne(r: LinkReport['rows'][number]): boolean {
  const sa = r.siteAccounts ?? [];
  if (r.state !== 'split' || !sa.length) return false;
  return sa.every((x) => x.account.accountNumber === sa[0]!.account.accountNumber);
}

/**
 * Mirrors `obTarget`: the Domain/Site cell's opener.
 *
 * A LINKED SITE row opens BY ACCOUNT, because reconciliation is scoped to what the account holds and the
 * panel's subject is that account — `?domain=` on a split domain names a row several accounts share, which
 * is why `/kit/onebill/account` refuses it. A whole-domain link and a split billed entirely to one account
 * open BY DOMAIN, which the route resolves to the same account. Anything else is text: a conflict row has
 * two claimants and `resolveAccountScope` throws on one, and a control whose only outcome is a refusal is
 * not a control.
 */
function target(r: LinkReport['rows'][number]): string {
  if (r.site && r.state === 'linked' && (r.accounts ?? []).length) {
    return `<button type="button" class="linkish dom" data-open-account="${esc(r.accounts[0]!.accountNumber)}">${esc(r.domain)}</button>`;
  }
  if ((r.state === 'linked' && !r.site) || splitOne(r)) {
    return `<button type="button" class="linkish dom" data-open-domain="${esc(r.domain)}">${esc(r.domain)}</button>`;
  }
  return `<span class="dom">${esc(r.domain)}</span>`;
}

/** The table rows for `report`, as the client script would draw them. */
export function renderRows(report: LinkReport, canWrite: boolean): string {
  const rs = report.rows ?? [];
  if (!rs.length) return `<tr class="empty"><td colspan="${canWrite ? 5 : 4}">This deployment sees no domains, so there is nothing to link.</td></tr>`;
  // Mirrors `unv` in the client copy: a quick-view row is drawn from the derived index and says so.
  const unv = report.mode === 'quick' ? ' data-unverified="1"' : '';
  return rs.map((r) => {
    const accs = (r.accounts ?? []).map((a) => acct(a));
    const cand = r.candidate ? `${acct(r.candidate)} <span class="conf">${esc(r.candidate.confidence)}</span>` : '—';
    const acctCell = accs.length ? accs.join('<br>') + siteCountLine(r) : (siteAccts(r) || '—');
    return `<tr data-state="${esc(r.state)}" data-domain="${esc(r.domain)}"${unv}${r.site ? ` class="site" data-site="${esc(r.site)}"` : ''}>`
      + `<td class="tgt">${target(r)}${r.site ? `<div class="siterow">Site: <b>${esc(r.site)}</b></div>` : ''}${notes(r.notes)}</td>`
      + `<td>${chip(r.state)}</td>`
      + `<td>${acctCell}</td>`
      + `<td>${cand}</td>`
      + actionCell(r, canWrite)
      + '</tr>';
  }).join('');
}

/**
 * Mirrors `obRemove` in the client copy: a closed account gets the reason, not the control — and so
 * does one the apply route would refuse a matching write on, since the list this button would send is
 * missing the links the caller was never shown. Closed takes precedence: it is the blunter fact.
 */
function removeControl(x: LinkReport['foreign'][number]): string {
  if (x.state === 'closed') return '<div class="note">Closed account — links on it are not written from here.</div>';
  if (x.restricted) return '<div class="note">This account also has links to domains this portal is set not to show. Change them in OneBill.</div>';
  return '<button type="button" class="btn" data-act="remove">Remove this link</button>';
}

/**
 * Hidden links, COUNTED and never named — mirrors `obHidden` in the client copy.
 *
 * The names are exactly what ALLOWED_DOMAINS/BLOCKED_DOMAINS exist to withhold; the count is what
 * keeps the page honest that it is not showing the whole tenant.
 */
function hiddenNote(report: LinkReport): string {
  const n = report.hiddenLinkCount || 0;
  if (!n) return '';
  return `<p class="dim">${n}${n === 1 ? ' link points at a domain' : ' links point at domains'} this portal is set not to show. They are not listed here.</p>`;
}

/** The foreign block: OneBill links pointing at targets this deployment cannot see. */
export function renderForeign(report: LinkReport, canWrite: boolean): string {
  const f = report.foreign ?? [];
  const h = hiddenNote(report);
  if (!f.length) return h || '<p class="dim">Every OneBill link points at a domain or site NetSapiens has.</p>';
  return h + f.map((x) =>
    `<div class="frow" data-account="${esc(x.account.accountNumber)}" data-value="${esc(x.value)}" data-qualifier="${esc(x.qualifier ?? '')}" data-links="${esc(JSON.stringify(x.links ?? []))}">`
    + `<div class="fhead">${chip(x.state)} <b>${acct(x.account)}</b> <span class="arrow">→</span> <code>${esc(x.value)}${x.qualifier ? ` / ${esc(x.qualifier)}` : ''}</code></div>`
    + notes(x.notes)
    + (canWrite ? removeControl(x) : '')
    + '</div>').join('');
}

/** The decommission callout: closed accounts whose domain NetSapiens still has — mirrors `obDecom`. */
export function renderDecommission(report: LinkReport): string {
  const ds = report.decommission ?? [];
  if (!ds.length) return '';
  return DECOM_HEAD + ds.map((x) =>
    `<div class="res decom"><b>${acct(x.account)}</b><div>`
    + (x.domains ?? []).map((d) => `<code>${esc(d)}</code>`).join(' ')
    + '</div></div>').join('');
}

/** Mirrors `obSetupMissingLabel`. */
const setupMissingLabel = (m: SetupMissing, setup: SetupCheck): string => {
  if (m === 'group') return `the group itself (key "${esc(setup.group)}")`;
  if (m === 'valueField') return `the "${esc(setup.valueField)}" field`;
  return `the "${esc(setup.qualifierField ?? '')}" field`;
};

/** Mirrors `obSetupChecklist`. The exact words `applyLinks`' refusal (onebill.ts) uses too, so a caller
 *  sees the same instructions whether the page or the API told them. */
const setupChecklistHtml = (setup: SetupCheck): string => {
  const q = setup.qualifierField ? ` and an optional text field "${esc(setup.qualifierField)}"` : '';
  const steps = `In OneBill, create an account-level custom-field group with the key "${esc(setup.group)}" and add a text field "${esc(setup.valueField)}"${q}. Then Refresh and fully verify.`;
  const missing = setup.missing.map((m) => setupMissingLabel(m, setup)).join(' and ');
  return missing ? `${steps} Missing: ${missing}.` : steps;
};

/**
 * The remediation card shown in place of the table and every write control when the group is not
 * declared — mirrors `obSetupCard`. `data-setup-missing` names which of `group`/`valueField`/
 * `qualifierField` is absent, for tests.
 */
export function renderSetupCard(setup: SetupCheck): string {
  return `<div class="setup-card" data-setup-missing="${esc(setup.missing.join(','))}">`
    + '<h2>OneBill needs a custom-field group before links can be stored</h2>'
    + `<p>${setupChecklistHtml(setup)}</p></div>`;
}


// ── the account detail panel, server-side ──────────────────────────────────────────────────────────
// The client copy is `obPanel` in ROW_BASE, and the selftest holds the two byte-identical — the same
// hand-written-twin arrangement the links table uses (there is no shared implementation in this file to
// borrow), for the same reason: the page renders server-side on first paint and client-side on every
// refresh, and two renderers free to disagree would disagree about which numbers an operator is reading.

/** Mirrors `obNum`: a count, escaped like everything else — the report's numbers are typed, but nothing
 *  here should depend on that being true of a cached or hand-written one. */
const num = (n: number | undefined | null): string => esc(String(n == null ? 0 : n));

/** Mirrors `obVerdictChip`. Every verdict needs a `.chip-<verdict>` rule; the selftest checks that. */
const verdictChip = (v: string): string => `<span class="chip chip-${esc(v)}">${esc(v)}</span>`;

/** Mirrors `obOptionalChip`: a row that exists only because something entitles it, with nothing using
 *  the entitlement. The engine says `match`, which is true and reads as a reassurance nobody asked for;
 *  what the reader needs off this row is that it is included and unused. */
const optionalChip = (r: ComparisonRow): string => (r.optional && r.observed === 0
  ? '<span class="chip chip-optional">optional, unused</span>'
  : verdictChip(r.verdict));

/** Mirrors `obEntitled`: headroom above the billed count, said beside it. Nothing where nothing
 *  entitles the row, so the column stays a column of numbers. */
const entitledNote = (r: ComparisonRow): string => (r.entitled > 0 ? ` <span class="dim ent">+${num(r.entitled)} entitled</span>` : '');

/** Mirrors `obAnyTagged`: is anything on this row tagged with the plan it is billed as? The row counts
 *  its UNTAGGED accepted items, so the answer is "fewer untagged than accepted". Where nothing is
 *  tagged, no offer says "0 tagged" — a column of zeroes about a thing nobody has done is noise. */
function anyTagged(r: ComparisonRow): boolean {
  return (r.items ?? []).filter((it) => it.status === 'accepted').length > (r.untagged ?? 0);
}

/** Mirrors `obNameKey`: how offer names are matched everywhere they are matched — trimmed, case
 *  insensitively. The library's own rule, so the page cannot group two lines differently from the
 *  engine that counted them. */
const nameKey = (v: string | undefined): string => (v ?? '').trim().toLowerCase();

/**
 * Mirrors `obOverTagged`: how many more items are tagged to this offer's PLAN than the bill carries of
 * it, or 0. Two things this has to get right, and got wrong:
 *
 * - the bill is `quantity × perUnit`, so three numbers tagged to one pack of ten are not an excess; and
 * - `tagged` is a count per NAME that repeats across every line of that name rather than dividing
 *   between them, so the comparison is against the SUM over those lines.
 *
 * Printed on the first line of a name only: the excess is a fact about the plan, and saying it twice
 * under two lines of one plan would read as two separate overages.
 */
function overTagged(os: ComparisonRow['offers'], i: number): number {
  const x = os[i]!;
  const t = x.tagged ?? 0;
  const k = nameKey(x.name);
  let n = 0;
  for (let j = 0; j < os.length; j++) {
    if (nameKey(os[j]!.name) !== k) continue;
    if (j < i) return 0;
    n += os[j]!.quantity * (os[j]!.perUnit > 1 ? os[j]!.perUnit : 1);
  }
  return t > n ? t - n : 0;
}

/**
 * Mirrors `obOfferList`: what the billed count is MADE OF, and — for a row billed by nothing of its own
 * — what pays for it (`via`) or permits it (`included with`).
 *
 * A list rather than a comma-joined sentence: these are separate facts about separate plans, and one
 * line made the reader work out where each ended. A zero-quantity credit is left out entirely, being a
 * rule that landed here and contributed nothing.
 */
function offerList(r: ComparisonRow): string {
  let o = '';
  const any = anyTagged(r);
  const os = r.offers ?? [];
  for (let i = 0; i < os.length; i++) {
    const x = os[i]!;
    const t = x.tagged ?? 0;
    o += `<li>${esc(x.name)} x${num(x.quantity)}${x.perUnit > 1 ? ` (pack of ${num(x.perUnit)})` : ''}`;
    if (any && typeof x.tagged === 'number') {
      o += ` — ${num(t)} tagged`;
      const over = overTagged(os, i);
      if (over > 0) o += ` (${num(over)} more tagged than billed)`;
    }
    o += '</li>';
  }
  for (const c of r.credits ?? []) {
    if (!(c.quantity > 0)) continue;
    o += `<li class="credit">${c.kind === 'entitles' ? 'included with ' : 'via '}${esc(c.from)} x${num(c.quantity)}</li>`;
  }
  return o ? `<ul class="offers">${o}</ul>` : '';
}

/**
 * Mirrors `obBareKey`. An item key is DOMAIN-QUALIFIED — `branch.example/ext:100` — because one account's
 * report can hold two domains with the same extension number on each. Callers strip the domain to read
 * the KIND off the front, or to name the item to a route that takes the domain in its own field. A cached
 * pre-scoping key has no slash and is already its own bare form.
 */
const bareKey = (k: string): string => {
  const i = k.indexOf('/');
  return i >= 0 ? k.slice(i + 1) : k;
};

/**
 * Mirrors `obCanAct`: the one predicate behind every write control on this panel, so the accept column,
 * the item buttons, the group buttons and the Unassigned picker cannot disagree about whether this report
 * can be written from. `partial` belongs in it because a report missing a domain cannot say what an
 * account holds, and every control here decides something about exactly that.
 */
const canAct = (rep: AccountReport): boolean => rep.canWrite && rep.baselinesEnabled && !rep.partial;

/** Mirrors `obScopesLine`: what this account holds, as an operator would say it — a site where it holds
 *  one, the whole domain where it holds all of it. The panel's subject is the ACCOUNT, and this is its
 *  extent. */
const scopesLine = (rep: AccountReport): string =>
  (rep.scopes ?? []).map((x) => esc(x.domain) + (x.site ? ` / ${esc(x.site)}` : ' (whole domain)')).join(' · ');

/** Mirrors `obItemWhere`: which domain-and-site an item is on, and only where the account holds more than
 *  one PLACE — two domains, or two sites of one domain. An account holding a single scope gets none:
 *  every row would carry the same badge, which is a column saying nothing. */
function where(it: ScopedComparisonItem, rep: AccountReport): string {
  if ((rep.domains ?? []).length < 2 && (rep.scopes ?? []).length < 2) return '';
  return `<span class="where">${esc(it.domain)}${it.site ? ` / ${esc(it.site)}` : ''}</span>`;
}

/**
 * Mirrors `obManualChip`: somebody put this item here by hand.
 *
 * The tooltip names the ACCOUNT the automatic rule would have billed it to instead. Naming only the site
 * would leave the reader to work out whose site that is, which is the question the badge exists to answer.
 * An `unknown` attribution is a stale acceptance whose scope meta is gone — nothing here knows where it
 * came from, so nothing is claimed.
 */
function manualChip(it: ScopedComparisonItem): string {
  if (it.attribution !== 'manual') return '';
  const a = it.automatic;
  const t = a ? ` title="automatically: ${esc(a.accountNumber)}${a.site ? ` (${esc(a.site)})` : ''}"` : '';
  return `<span class="chip chip-manual"${t}>manual</span>`;
}

/**
 * Mirrors `obModel`: what the chip says after the device name. The model when there is one; failing that
 * the KIND, which is what the suffix legend calls this device (SNAPmobile, Teams, the deployment's own
 * app) — a connector or a softphone has no model to print and its kind is the more useful fact anyway;
 * failing both, the plain statement that the model is missing. `(unknown)` is the LIBRARY's placeholder
 * for a record NetSapiens has no model on, so it counts as no model here — printed as written it reads as
 * a rendering fault, and a reader cannot tell it from a bug in this page. Display only: the library value
 * is untouched, and the inventory breakdown still buckets it under its own name, where it is a key rather
 * than a sentence.
 */
const modelPart = (m: string, k: string): string =>
  (m && m !== '(unknown)' ? ` ${esc(m)}` : k ? ` ${esc(k)}` : ' <span class="dim">(no model)</span>');

/**
 * Mirrors `obDevices`: what is actually plugged in, named. The device NAME, then its model or what kind
 * of device it is. The chip's `title` carries the name and its kind, because a narrow panel truncates the
 * chip and those two are what identify the device in the portal. A record with NO `devices` array is a
 * report cached before netsapiens-lib 0.5.0 — it says nothing rather than "no device", which would be a
 * claim this page cannot support.
 */
function devices(x: ExtensionItem): string {
  if (!x.devices) return '';
  if (!x.devices.length) return '<div class="devs"><span class="dim">no device</span></div>';
  return `<div class="devs">${x.devices.map((d) =>
    `<span class="dev${d.teams ? ' dev-teams' : ''}" title="${esc(`${d.name}${d.kind ? ` \u00b7 ${d.kind}` : ''}`)}">${esc(d.name)}${modelPart(d.model, d.kind)}</span>`).join('')}</div>`;
}

/** Mirrors `obExtDetail`. */
function extDetail(x: ExtensionItem): string {
  return esc([x.name, x.site].filter(Boolean).join(', ')) + (x.scope ? ` <span class="dim">${esc(x.scope)}</span>` : '') + devices(x);
}

/** Mirrors `obDidDetail`: a number is local or toll-free, it routes somewhere, and the portal wrote a
 *  note on it when it created it. The kind alone was already readable off the label; where it GOES is
 *  what an operator cannot see otherwise, and it is what decides whether a number is billable or
 *  plumbing. */
function didDetail(n: NumberItem): string {
  return (n.kind === 'tollFree' ? 'toll-free' : 'local')
    + (n.destination ? ` · ${esc(n.destination)}` : '')
    + (n.description ? ` · <span class="dim">${esc(n.description)}</span>` : '');
}

/** Mirrors `obEpDetail`: an ENDPOINT is a callback number in the label cell and nothing else; what an
 *  operator reconciling an E911 line needs beside it is who the carrier announces and where responders
 *  are sent. */
function epDetail(e: EndpointItem): string {
  return [e.callerName, e.billingAddress].filter(Boolean).map((x) => esc(x)).join(' · ');
}

/** Mirrors `obRecDetail`: one dispatcher over a record already in hand, so a placed item and an
 *  Unassigned one cannot describe the same thing two ways. The KIND comes off the bare key; the record
 *  comes from wherever the caller found it. */
function recDetail(k: string, rec: ExtensionItem | NumberItem | EndpointItem | undefined): string {
  if (!rec) return '';
  const b = bareKey(k);
  if (b.indexOf('ext:') === 0) return extDetail(rec as ExtensionItem);
  if (b.indexOf('did:') === 0) return didDetail(rec as NumberItem);
  if (b.indexOf('e911:') === 0) return epDetail(rec as EndpointItem);
  return '';
}

/**
 * Mirrors `obDetailRec`: the scoped detail record behind a placed item's key, or `undefined`. The
 * comparison carries identities and counts, never names, so this is the join back to them; the KIND
 * comes off the bare key and the lookup matches the whole SCOPED key, `rep.detail` being scoped the same
 * way. A key with no record left answers `undefined` and its row still draws blank rather than throwing
 * — a stale acceptance names a thing that has gone.
 *
 * Looked up ONCE per row and handed to both `kindChip` and `recDetail`: a fax line is one only according
 * to its record, and two lookups of one key are two chances for the chip to say "number" while the cell
 * beside it describes a fax line.
 */
function detailRec(k: string, rep: AccountReport): ExtensionItem | NumberItem | EndpointItem | undefined {
  const d: Partial<DomainInventoryDetail> = rep.detail ?? {};
  const b = bareKey(k);
  if (b.indexOf('ext:') === 0) return (d.extensions ?? []).concat(d.systemUsers ?? []).find((e) => e.key === k);
  if (b.indexOf('did:') === 0) return (d.dids ?? []).find((y) => y.key === k);
  if (b.indexOf('e911:') === 0) return (d.e911Endpoints ?? []).find((y) => y.key === k);
  return undefined;
}

/** Mirrors `obItemChip`. Every status needs a `.chip-item-<status>` rule; the selftest checks that.
 *  "as <plan>" is part of the DECISION, not of the item: an operator who tags nine seats to a tier that
 *  bills eight has recorded something for the next reader, and this is where the next reader sees it. */
function itemChip(it: ComparisonItem): string {
  const a = it.acceptance;
  return `<span class="chip chip-item-${esc(it.status)}">${esc(it.status)}</span>`
    + (a ? `<span class="dim small">${a.offer ? ` as ${esc(a.offer)}` : ''} by ${esc(a.decidedBy)} on ${esc(String(a.decidedAt).slice(0, 10))}${a.note ? ` - ${esc(a.note)}` : ''}</span>` : '');
}

/**
 * Mirrors `obKind`: WHICH KIND of thing this line is, from the bare key's prefix. First in the label cell
 * because a list of "100", "+15550100" and "North dock" reads as one kind of thing until something says
 * otherwise, and they bill under different rules and different controls.
 *
 * A FAX LINE is the one kind the key cannot tell you: it is an ordinary phone number whose dial rule
 * hands it to the fax server, so the RECORD decides — `fax`, set by netsapiens-lib from this
 * deployment's `NS_FAX_SERVER_HOSTS`. With no record (an Unassigned row carries its own; a report cached
 * before 0.7.0 has no `fax` on it) it reads "number", which is what it was called before fax lines were
 * counted apart.
 */
function kindChip(key: string, rec?: ExtensionItem | NumberItem | EndpointItem | InventoryItem): string {
  const b = bareKey(key);
  if (b.indexOf('ext:') === 0) return '<span class="kind kind-ext">extension</span>';
  if (b.indexOf('did:') === 0) {
    return (rec as NumberItem | undefined)?.fax === true
      ? '<span class="kind kind-fax">fax line</span>'
      : '<span class="kind kind-did">number</span>';
  }
  if (b.indexOf('addr:') === 0) return '<span class="kind kind-addr">E911 address</span>';
  // `e911legacy:` FIRST. It does not begin with `e911:` (there is no colon at that position), so the
  // order is not load-bearing today — but a reader should not have to work that out to see they differ.
  if (b.indexOf('e911legacy:') === 0) return '<span class="kind kind-e911legacy">Legacy E911</span>';
  if (b.indexOf('e911:') === 0) return '<span class="kind kind-e911">E911 endpoint</span>';
  if (b.indexOf('sms:') === 0) return '<span class="kind kind-sms">SMS number</span>';
  return '';
}

/** Mirrors `obCoLine`: what ONE co-holder's own bill says about the same group. `billed: -1` is "their
 *  subscriptions would not read", a different fact from the zero it would be indistinguishable from. */
function coLine(x: AccountReport['coBilled'][string][string][number]): string {
  if (x.billed < 0) return '(could not read)';
  if (!x.billed && !x.entitled) return `(no ${esc(x.group)} line)`;
  return `(${esc(x.group)} x${num(x.billed)}${x.entitled > 0 ? ` +${num(x.entitled)} entitled` : ''})`;
}

/** Mirrors `obShared`: the other accounts holding this same item, and what each is billed for it. Only
 *  an ADDRESS can be on two accounts — an address is a fact about a place, and two sites' accounts can
 *  each buy an E911 bundle for it. Without this line the duplicated count reads as a double-bill; with
 *  it, the reader can also see the case worth finding, which is a co-holder billing nothing.
 *
 *  `group` is a parameter and not read off the item: one key can sit on two comparison rows, and those
 *  rows have different billed numbers. Mirrors `obShared`/`obCoFor`. */
function coFor(rep: AccountReport, group: string, key: string): AccountReport['coBilled'][string][string] {
  const m = rep.coBilled;
  if (!m || !Object.hasOwn(m, group)) return [];
  const g = m[group];
  if (!g || !Object.hasOwn(g, key)) return [];
  return g[key] ?? [];
}

function sharedLine(it: ScopedComparisonItem, rep: AccountReport, group: string): string {
  const ws = it.sharedWith;
  if (!ws?.length) return '';
  const cb = coFor(rep, group, it.key);
  return ws.map((w) => {
    const x = cb.find((c) => c.accountNumber === w.accountNumber);
    return `<div class="dim small also">also on ${esc(w.accountNumber)}${w.accountName ? ` — ${esc(w.accountName)}` : ''}${x ? ` ${coLine(x)}` : ''}</div>`;
  }).join('');
}

/** Mirrors `obOtherHolders`: who ELSE holds this item's domain — the accounts a Move could send it to.
 *  `Object.hasOwn`, not bracket-truthiness: a domain is report data, and `constructor` is not a holder
 *  list. */
function otherHolders(it: ScopedComparisonItem, rep: AccountReport): AccountRef[] {
  const hs = rep.holders;
  if (!hs || !Object.hasOwn(hs, it.domain)) return [];
  return (hs[it.domain] ?? []).filter((a) => a.accountNumber !== rep.accountNumber);
}

/** Mirrors `obAcctOpts`: one `<option>` per account a picker offers. The NUMBER is the value the route
 *  reads and the NAME is what makes the list answerable — a column of CLI numbers asks the operator to
 *  recognise one, which is the question naming the client answers. An account with no name on the
 *  report shows its number alone rather than a dangling dash. */
function acctOptions(as: AccountRef[]): string {
  return as.map((a) => `<option value="${esc(a.accountNumber)}">${esc(a.accountNumber)}${a.accountName ? ` — ${esc(a.accountName)}` : ''}</option>`).join('');
}

/** Mirrors `obMoveCtl`: the same write the Unassigned picker sends, offered on an item that is already
 *  PLACED here. Nothing at all when no other account holds the domain — a select with no options beside a
 *  Move button is a control that can only be clicked into a refusal. `data-placed` is what tells the click
 *  handler which sentence to confirm with: a placed item's acceptance on this account goes with it. */
function moveCtl(it: ScopedComparisonItem, rep: AccountReport): string {
  const hs = otherHolders(it, rep);
  if (!hs.length) return '';
  return '<select data-role="assign-to">'
    + acctOptions(hs)
    + `</select><button type="button" class="btn small" data-act="assign" data-placed="1" data-domain="${esc(it.domain)}" data-key="${esc(bareKey(it.key))}" data-label="${esc(it.label)}">Move</button>`;
}

/** Mirrors `obAddable`: who could still be ADDED to this item's set — the domain's other holders, minus
 *  the ones already on it. Offering an account that already holds it is a control whose only outcome is
 *  a write that changes nothing. */
function addable(it: ScopedComparisonItem, rep: AccountReport): AccountRef[] {
  const ws = it.sharedWith ?? [];
  return otherHolders(it, rep).filter((h) => !ws.some((w) => w.accountNumber === h.accountNumber));
}

/** Mirrors `obSharedKind`: which kinds an account SHARES rather than owns outright. The same three
 *  `isSharedKind` names in `onebillScope.ts`, which is what the assign route enforces — a page offering
 *  a control the route then refuses is worse than no control. Written out rather than imported because
 *  the client copy beside it cannot import anything. */
const sharedKind = (b: string): boolean =>
  b.indexOf('addr:') === 0 || b.indexOf('e911:') === 0 || b.indexOf('e911legacy:') === 0;

/** Mirrors `obSharedCtl`. A SHARED KIND IS PLACED ON A SET, so its controls are add-one and remove-one
 *  rather than Move: moving it would take an E911 line off an account that really does bill for the
 *  place. Remove appears only where this account is in the MANUAL set — an automatic placement belongs
 *  to the site link, and the site link would put it straight back, so a button offering to undo it does
 *  nothing. */
function sharedCtl(it: ScopedComparisonItem, rep: AccountReport): string {
  const as = addable(it, rep);
  return (it.attribution === 'manual'
    ? `<button type="button" class="btn small" data-act="unassign" data-domain="${esc(it.domain)}" data-key="${esc(bareKey(it.key))}" data-label="${esc(it.label)}">Remove from this account</button>`
    : '')
    + (as.length
      ? `<select data-role="assign-to">${acctOptions(as)}</select><button type="button" class="btn small" data-act="assign" data-domain="${esc(it.domain)}" data-key="${esc(bareKey(it.key))}" data-label="${esc(it.label)}">Assign</button>`
      : '');
}

/**
 * Mirrors `obItemCtl`: the two controls that send an item SOMEWHERE ELSE — the button that takes a
 * by-hand placement back, and the Move picker. The row's own accept/clear moved to the first cell (see
 * {@link itemSel}), which leaves this cell holding only what a mis-click here cannot undo by clicking
 * again. ABSENT, not disabled, for a reader without the key or a deployment with no baseline store.
 *
 * Clear assignment is keyed BARE beside its own domain, because that is the shape `/kit/onebill/assign`
 * reads: a scoped key would name the domain twice, once in a field nothing reads it from. Move comes
 * last because it is the only one of the two that names another account.
 *
 * A SHARED KIND takes the set controls instead (see {@link sharedCtl}), and its Assign carries no
 * `data-placed`: it adds an account and clears nothing here, so the placeholder warning about losing
 * this account's acceptance would be a sentence about the wrong write.
 */
function itemCtl(it: ScopedComparisonItem, rep: AccountReport): string {
  if (!canAct(rep)) return '';
  if (sharedKind(bareKey(it.key))) return `<td class="act">${sharedCtl(it, rep)}</td>`;
  return '<td class="act">'
    + (it.attribution === 'manual'
      ? `<button type="button" class="btn small" data-act="clear-assign" data-domain="${esc(it.domain)}" data-key="${esc(bareKey(it.key))}" data-label="${esc(it.label)}">Clear assignment</button>`
      : '')
    + moveCtl(it, rep)
    + '</td>';
}

/**
 * Mirrors `obItemSel`: the row's own decision, in the first cell, beside the checkbox that puts it in a
 * bulk one. Empty (but present) for a reader, so the column count matches the header either way.
 *
 * NO checkbox on a stale row. The two bulk buttons count checked-unreviewed and checked-accepted, so a
 * checked stale item would be carried by neither and the selection would name a number it cannot act on.
 * Its own Clear is still here, which is the one thing a stale acceptance needs.
 */
function itemSel(it: ScopedComparisonItem, r: ComparisonRow, rep: AccountReport): string {
  if (!canAct(rep)) return '<td class="sel"></td>';
  const act = it.status === 'unreviewed' ? 'accept-item' : 'clear-item';
  const box = it.status === 'stale' ? '' : `<input type="checkbox" data-role="pick" data-key="${esc(it.key)}">`;
  return `<td class="sel">${box}<button type="button" class="btn small" data-act="${act}" data-group="${esc(r.group)}" data-key="${esc(it.key)}">${act === 'accept-item' ? 'Accept' : 'Clear'}</button></td>`;
}

/** Mirrors `obItemHead`: one box that ticks every UNREVIEWED row, so a group of twelve is accepted in
 *  one decision without twelve clicks and without re-accepting the ones already decided. Write build
 *  only — a reader has nothing to select. Five empty cells rather than a colspan, so the header cannot
 *  drift from the row beneath it. */
function itemHead(rep: AccountReport): string {
  if (!canAct(rep)) return '';
  return '<tr class="ihead"><td class="sel"><input type="checkbox" data-role="pick-all" aria-label="Select every unreviewed item"></td><td></td><td></td><td></td><td class="act"></td></tr>';
}

/** Mirrors `obItemRows`. Rendered HIDDEN and always present, rather than built on the first click: the
 *  row a click has to swap after an accept is then the same row on first paint and on every refresh. */
function itemRows(r: ScopedComparisonRow, rep: AccountReport, cols: number): string {
  if (!r.items) return '';
  const o = (r.items.length ? itemHead(rep) : '') + r.items.map((it) => {
    // ONE lookup per row, shared by the kind chip and the detail cell — see `detailRec`.
    const rec = detailRec(it.key, rep);
    return `<tr data-item-key="${esc(it.key)}" data-status="${esc(it.status)}">${itemSel(it, r, rep)}<td>${kindChip(it.key, rec)}${esc(it.label)}${where(it, rep)}${sharedLine(it, rep, r.group)}</td><td>${recDetail(it.key, rec)}</td><td>${itemChip(it)}${manualChip(it)}</td>${itemCtl(it, rep)}</tr>`;
  }).join('');
  return `<tr class="items" data-items-for="${esc(r.group)}" hidden><td colspan="${cols}"><table class="items"><tbody>${o}</tbody></table></td></tr>`;
}

/** Mirrors `obDriftLine`: what moved since the acceptance, and only that. A drift verdict IS the
 *  difference between then and now, so a sentence about a number that did not change is noise. */
function driftLine(r: ComparisonRow): string {
  const g = r.groupRow;
  if (!g || r.verdict !== 'drift') return '';
  const p: string[] = [];
  if (g.billed !== r.billed) p.push(`Billed ${num(g.billed)} when accepted, ${num(r.billed)} now.`);
  if (r.items && r.unreviewed > 0) p.push(`${num(r.unreviewed)} new since accepted.`);
  if (r.stale > 0) p.push(`${num(r.stale)} accepted item${r.stale === 1 ? '' : 's'} no longer exist${r.stale === 1 ? 's' : ''}.`);
  if (!r.items && g.accepted !== r.observed) p.push(`Accepted ${num(g.accepted)}, ${num(r.observed)} now.`);
  return p.length ? `<div class="dim small">${p.join(' ')}</div>` : '';
}

/** Mirrors `obGroupNote`. */
function groupNote(r: ComparisonRow): string {
  return r.groupRow?.note ? `<div class="dim small">${esc(r.groupRow.note)}</div>` : '';
}

/**
 * Mirrors `obDelta`: the gap in words, because three numbers in three columns leave the reader to do the
 * subtraction — and the subtraction is not the obvious one. Entitlements are HEADROOM above billed, so
 * an unbilled count that ignored them would report a finding on a row with free capacity it has not used.
 * Below billed is the other direction and has no entitlement in it: paying for twelve and running ten is
 * ten live and two not, whatever else the row is entitled to. Silent inside the range, which is where a
 * healthy row sits — a line that renders on every row is a line nobody reads on any of them.
 *
 * Silent ALSO on an `observedMissing` row. Its Live is 0 because a `counts` path names nothing in this
 * deployment's inventory — a rulebook typo, or a dimension nobody counts — not because nothing is there.
 * "12 billed, not live" would be a claim about the phone system read off a rulebook, and the row already
 * says out loud that the path counts nothing.
 */
function deltaLine(r: ComparisonRow): string {
  if (r.observedMissing) return '';
  const ent = r.entitled ?? 0;
  if (r.observed > r.billed + ent) return `<div class="dim small">${num(r.observed - r.billed - ent)} unbilled</div>`;
  if (r.observed < r.billed) return `<div class="dim small">${num(r.billed - r.observed)} billed, not live</div>`;
  return '';
}

/**
 * Mirrors `obOverlap`: how many of this row's items are also on another row.
 *
 * Two rules can count the SAME extensions by different tests — Hosted Seats by device presence, Call
 * Center Seats by NetSapiens role — and two rows reading 18 and 12 add up to 30 in a reader's head when
 * the domain holds 18 things. A row wholly inside another says so in those words ("these 12 are among the
 * 18 on Hosted Seats"); a partial overlap gives the number alone, because "among" would claim a
 * containment that is not there. Derived from the report the renderer already has: no new field, and
 * nothing for a cached report to be missing.
 *
 * Singular is written out ("this one is among the 18", "1 of these is also on") rather than left to
 * read "1 of these are": a row with one item is the common case on a small domain, and a sentence that
 * does not agree with itself reads as a bug in the page.
 *
 * Sorted by the OTHER group's name, so the order is a property of the page rather than of the rulebook's
 * declaration order.
 */
function overlapLine(r: ScopedComparisonRow, rep: AccountReport): string {
  if (!r.items) return '';
  const mine = new Set(r.items.map((it) => it.key));
  const others = (rep.comparison?.rows ?? []).filter((x) => x !== r && x.items);
  others.sort((a, b) => String(a.group).localeCompare(String(b.group)));
  return others.map((x) => {
    const n = x.items!.filter((it) => mine.has(it.key)).length;
    if (!n) return '';
    return n === r.items!.length && x.items!.length > r.items!.length
      ? (n === 1
        ? `<div class="dim small">this one is among the ${num(x.items!.length)} on ${esc(x.group)}</div>`
        : `<div class="dim small">these ${num(n)} are among the ${num(x.items!.length)} on ${esc(x.group)}</div>`)
      : `<div class="dim small">${num(n)} of these ${n === 1 ? 'is' : 'are'} also on ${esc(x.group)}</div>`;
  }).join('');
}

/** Mirrors `obCounts`. The count of PRESENT items nobody has accepted — not the excess over billed.
 *  Twelve seats billed as twelve are still twelve things nobody has looked at. */
function counts(r: ComparisonRow): string {
  return (r.unreviewed > 0 ? ` <span class="cnt">${num(r.unreviewed)} unreviewed</span>` : '')
    + (r.stale > 0 ? ` <span class="cnt">${num(r.stale)} stale</span>` : '');
}

/**
 * Mirrors `obGroupControls`. Two pairs over two stores, and NOT over the direction of the gap:
 * `accept-all`/`clear-all` act on the ITEM acceptances, so an item list is all they need — a row billed
 * for more than it has still has items nobody has reviewed, and hiding Accept all there would leave the
 * operator clicking twelve buttons. `accept-shortfall`/`clear-shortfall` act on the GROUP ROW, which is
 * what an item-less dimension or a genuine shortfall is judged against. A row can offer one of each.
 *
 * `clear-shortfall` additionally waits for the items to be clear, because `applyBaselineAction` refuses
 * to drop a group row out from under an accepted item — it answers 409 and says to use Clear all, which
 * is the button already beside it. A control whose only outcome is an error is not a control.
 *
 * Each label names its STORE and never a quantity: "Accept 2" sitting beside "Accept all 2" on a
 * shortfall row with items is two different writes wearing one label. The numbers ride on the button
 * as `data-count` (the items the -all pair would touch) and `data-billed`/`data-observed` (the two the
 * group-row sentence names), because what says them back to the reader is the confirmation — and a
 * dialog that counted rows in the DOM would count whatever the last swap left there.
 *
 * The group-row pair's label says what the group row MEANS on this row, which is not the same thing on
 * both kinds. Where there are items, the group row can only be about the gap they cannot explain — a
 * seat that does not exist has no item to point at — so it reads "shortfall". Where there are none
 * (`devices.total`), the group row is the whole judgement, in either direction, so it reads "count":
 * calling an over-observed device row a shortfall would be the label lying about the direction.
 *
 * A `match` verdict short-circuits the ITEM pair not at all — a matched row still has twelve seats
 * nobody has reviewed, and accepting them is what makes a later swap read as drift. It does suppress
 * the GROUP pair outright: with observed equal to billed there is no gap to accept, and an item-less
 * matched row would otherwise offer a control whose only content is a number that already agrees.
 *
 * ABSENT, not disabled, for a reader — the same rule `itemCtl` follows.
 */
export interface PickedItems { unreviewed: number; accepted: number; keys: string[] }

/** Mirrors `obNoPick`: no selection, which is what the first paint of every row has. */
const noPick = (): PickedItems => ({ unreviewed: 0, accepted: 0, keys: [] });

/**
 * Mirrors `obGroupCtlHtml` — the buttons without the cell around them, so the page's change handler can
 * re-render this group's action cell alone as boxes are ticked, from the SAME function that drew it. A
 * second copy of these decisions living in the handler is a second copy that can disagree with the one a
 * full paint produces, which is the class of bug this whole file is arranged against.
 *
 * A selection REPLACES the -all pair rather than sitting beside it: "Accept all 12" next to "Accept
 * selected (3)" is two buttons whose difference the reader has to work out from two numbers. The
 * group-row pair is unaffected — a shortfall is a fact about the row, not about what is ticked in it.
 */
export function groupCtlHtml(r: ComparisonRow, picked?: PickedItems): string {
  const p = picked ?? noPick();
  const b = (act: string, label: string, extra: string): string =>
    `<button type="button" class="btn" data-act="${act}" data-group="${esc(r.group)}"${extra}>${label}</button>`;
  let o = '';
  const nAccepted = (r.items ?? []).filter((it) => it.status === 'accepted').length;
  const groupCtl = r.verdict !== 'match' && (!r.items || r.observed < r.billed);
  const gword = r.items ? 'shortfall' : 'count';
  const gnums = ` data-billed="${num(r.billed)}" data-observed="${num(r.observed)}"`;
  if (r.items) {
    if (p.keys.length) {
      if (p.unreviewed > 0) o += b('accept-selected', `Accept selected (${num(p.unreviewed)})`, ` data-count="${num(p.unreviewed)}"`);
      if (p.accepted > 0) o += b('clear-selected', `Clear selected (${num(p.accepted)})`, ` data-count="${num(p.accepted)}"`);
    } else {
      if (r.unreviewed > 0) o += b('accept-all', `Accept all ${num(r.unreviewed)}`, ` data-count="${num(r.unreviewed)}"`);
      if (nAccepted > 0 || r.groupRow) o += b('clear-all', 'Clear all', ` data-count="${num(nAccepted)}"`);
    }
  }
  if (groupCtl) {
    if (!r.groupRow) o += b('accept-shortfall', `Accept ${gword}`, `${gnums} data-word="${gword}"`);
    else if (nAccepted === 0) o += b('clear-shortfall', `Clear ${gword}`, ` data-word="${gword}"`);
  }
  return o;
}

function groupControls(r: ComparisonRow, rep: AccountReport, picked?: PickedItems): string {
  if (!canAct(rep)) return '';
  return `<td class="act">${groupCtlHtml(r, picked)}</td>`;
}

/** Mirrors `obCompCols`: how many columns the group row spans — the items row's colspan, and the one
 *  thing a caller re-rendering a single row has to be told, being a fact about the table not the row. */
function compCols(rep: AccountReport): number {
  return canAct(rep) ? 6 : 5;
}

/** Mirrors `obRowIdle`: nothing billed, nothing observed, no items (present or stale), no recorded group
 *  decision — no gap, nothing to review, nothing to undo. A groupRow, any item, or any nonzero count is a
 *  decision or a change on file even at 0/0, so those rows are not idle. */
function rowIdle(r: ComparisonRow): boolean {
  return r.billed === 0 && r.observed === 0 && (!r.items || r.items.length === 0) && !r.groupRow && r.stale === 0;
}

/** Mirrors `obCompRow`. `data-col` names each number cell, so a reader (or a test) picks a column by
 *  what it is rather than by counting `<td>`s whose index moves with the Accept column. */
function compRow(r: ScopedComparisonRow, rep: AccountReport, cols: number): string {
  const dims = r.dimensions?.length ? r.dimensions.join(' + ') : r.dimension;
  const idle = rowIdle(r);
  return `<tr data-verdict="${esc(r.verdict)}" data-group="${esc(r.group)}"${idle ? ' class="idle"' : ''}><td><b>${esc(r.group)}</b><div class="dim small">${esc(dims)}${r.observedMissing ? ' (this deployment counts nothing at that path)' : ''}</div>${overlapLine(r, rep)}${offerList(r)}`
    + (!idle && r.items ? `<button type="button" class="linkish" data-act="toggle-items" data-group="${esc(r.group)}" aria-expanded="false">Details</button>` : '') + '</td>'
    + `<td class="n" data-col="billed">${num(r.billed)}${entitledNote(r)}</td><td class="n" data-col="observed">${num(r.observed)}</td>`
    + `<td class="n" data-col="accepted">${r.items ? num(r.items.length - r.unreviewed - r.stale) : (r.groupRow ? num(r.groupRow.accepted) : '-')}</td>`
    + `<td>${optionalChip(r)}${counts(r)}${deltaLine(r)}${driftLine(r)}${groupNote(r)}</td>${groupControls(r, rep)}</tr>${idle ? '' : itemRows(r, rep, cols)}`;
}

/** Mirrors `obCompRows`. */
function compRows(rep: AccountReport): string {
  const cols = compCols(rep);
  return (rep.comparison?.rows ?? []).map((r) => compRow(r, rep, cols)).join('');
}

/** Mirrors `obUnmapped`: active recurring offers no rule maps, then the ones a rule deliberately
 *  excluded. Nothing at all when there are none — a standing heading over an empty list reads as a
 *  section that failed to load. The ignored offers are folded in here rather than given a section of
 *  their own: they are the other half of "what did the rulebook do with each line". */
function unmappedBlock(rep: AccountReport): string {
  const c: Partial<RecurringComparison> = rep.comparison ?? {};
  const us = c.unmapped ?? [];
  const ig = c.ignored ?? [];
  let o = us.length
    ? '<h3>Recurring lines no rule accounts for</h3><ul class="unmapped">'
      + us.map((u) => `<li>${esc(u.name)} x${num(u.quantity)}</li>`).join('') + '</ul>'
    : '';
  if (ig.length) {
    o += `<details class="ignored"><summary>Ignored by rule (${ig.length})</summary><ul class="unmapped">`
      + ig.map((g) => `<li>${esc(g.name)} x${num(g.quantity)} <span class="dim small">${esc(g.rule)}</span></li>`).join('') + '</ul></details>';
  }
  if (c.catalogMisses?.length) {
    o += `<p class="dim small">The catalogue does not know ${num(c.catalogMisses.length)} plan name(s) a code-keyed rule would need: ${esc(c.catalogMisses.join(', '))}.</p>`;
  }
  return o;
}

/** Mirrors `obReadFails`. A count of 0 for something whose read failed is a read error wearing a number's
 *  clothes — named under the header, because the row it makes untrustworthy is a row with an Accept on it.
 *  The list carries a whole domain that would not read as well as per-extension device and SMS failures,
 *  so the sentence names no cause, and the lines join with `'; '`: each already contains commas. */
function readFailBlock(rep: AccountReport): string {
  const fs = rep.readFailures ?? [];
  if (!fs.length) return '';
  return `<p class="fail">Some reads did not complete: ${esc(fs.join('; '))}. Counts from those reads are not facts - refresh before accepting a gap they touch.</p>`;
}

/** Mirrors `obBreakdown`. Keys SORTED: an object's own key order depends on how it was built, and a
 *  breakdown that reshuffles between two loads reads as data that changed. */
function breakdown(t: string, m: Record<string, number> | undefined): string {
  const ks = Object.keys(m ?? {}).sort();
  if (!ks.length) return '';
  return `<div class="bd"><b>${esc(t)}</b><ul>`
    + ks.map((k) => `<li>${esc(k === '' ? '(no service code)' : k)} - ${num((m ?? {})[k])}</li>`).join('') + '</ul></div>';
}

/** Mirrors `obUnaDomains`: the domains that have unassigned items, in first-appearance order — a
 *  grouping that does not depend on the list arriving sorted, which is a fact about `scopeInventory`
 *  rather than about this renderer. */
function unaDomains(us: UnassignedItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of us) if (!seen.has(u.domain)) { seen.add(u.domain); out.push(u.domain); }
  return out;
}

/**
 * Mirrors `obUnassigned`: items on a domain this account touches that NO account holds — an orphaned
 * site, an address two sites share. Each names why nothing claimed it, and offers the accounts that
 * could take it.
 *
 * Rendered for a READER too, unlike the acceptance controls: what is unassigned is a reading of the
 * domain, and only the picker beside it is a write. Nothing at all when the list is empty — a standing
 * heading over an empty table reads as a section that failed to load.
 */
function unassignedBlock(rep: AccountReport): string {
  const us = rep.unassigned ?? [];
  if (!us.length) return '';
  const act = canAct(rep);
  return unaDomains(us).map((d) => {
    const rows = us.filter((u) => u.domain === d).map((u) => {
      // No candidates, no picker: an empty select beside an Assign button is a control that can only be
      // clicked into a 400. The reason still renders — that this has nowhere to go is the thing to read.
      const ctl = act && (u.candidates ?? []).length
        ? `<td class="act"><select data-role="assign-to">`
          + acctOptions(u.candidates)
          + `</select><button type="button" class="btn small" data-act="assign" data-domain="${esc(u.domain)}" data-key="${esc(u.key)}" data-label="${esc(u.label)}">Assign</button></td>`
        : '';
      return `<tr data-unassigned-key="${esc(u.key)}" data-domain="${esc(u.domain)}">`
        + `<td>${kindChip(u.key, u.item)}${esc(u.label)}</td>`
        // The same cell a placed item gets, from the record on the row: an operator deciding who a
        // number belongs to needs to know where it rings, and the label is a bare number until
        // something says so.
        + `<td>${recDetail(u.key, u.item as ExtensionItem | NumberItem | EndpointItem | undefined)}</td>`
        + `<td>${esc(u.reason)}${u.staleAssignment ? ` — assigned to ${esc(u.staleAssignment)}, which no longer holds this domain` : ''}</td>`
        + `${ctl}</tr>`;
    }).join('');
    return `<h3>Unassigned on ${esc(d)}</h3><table class="una"><tbody>${rows}</tbody></table>`;
  }).join('');
}

/** Mirrors `obDomainTotals`: what the WHOLE domain holds, beside the slice this account bills for — and
 *  only where the two differ, which on a single-domain account they never do. One number per JUDGED
 *  dimension and no more — fax lines joined the list when netsapiens-lib 0.7.0 took them out of
 *  `dids.total`, and E911 endpoints and legacy numbers when 0.9.0 made them billable, each for the same
 *  reason: a domain differing from this slice by nothing but that dimension would otherwise print no
 *  line at all. A breakdown here would be a second inventory. */
function domainTotalsLine(rep: AccountReport): string {
  const t = rep.domainTotals ?? {};
  const v: Partial<DomainInventory> = rep.inventory ?? {};
  return (rep.domains ?? []).map((d) => {
    if (!Object.hasOwn(t, d)) return '';
    // Partial all the way down, mirroring the client copy's defaults — a report cached before a field
    // existed still renders. The types promise these are there; a cached JSON body does not.
    const x: Partial<DomainInventory> = t[d]!;
    const xe: Partial<DomainInventory['extensions']> = x.extensions ?? {};
    const xd: Partial<DomainInventory['dids']> = x.dids ?? {};
    if (xe.total === v.extensions?.total && xd.total === v.dids?.total && xd.fax === v.dids?.fax
      && x.e911Endpoints === v.e911Endpoints && x.e911Legacy === v.e911Legacy
      && x.e911Addresses === v.e911Addresses && x.smsNumbers === v.smsNumbers) return '';
    return `<div class="dim small">of ${esc(d)}: ${num(xe.total)} extensions · ${num(xd.total)} numbers`
      + ` · ${num(xd.fax)} fax lines · ${num(x.e911Endpoints)} E911 endpoints · ${num(x.e911Legacy)} legacy E911`
      + ` · ${num(x.e911Addresses)} E911 addresses · ${num(x.smsNumbers)} SMS numbers</div>`;
  }).join('');
}

/** Mirrors `obPartial`. A domain that would not read makes every count on this page a lower bound, so
 *  nothing is accepted from it. SAID where an Accept would have been, rather than only withheld: a panel
 *  that quietly dropped its controls reads as a permissions problem. */
const partialNote = (rep: AccountReport): string => rep.partial
  ? `<p class="fail">One of this account's domains could not be read, so the counts are incomplete and nothing can be accepted from this view. Refresh to try again.</p>`
  : '';

/**
 * Mirrors `obNoDevice`: extensions carrying nothing at all — no handset, no softphone, no Teams
 * connector. Informational and closed by default: a seat rule counting `extensions.withAnyDevice`
 * already excludes these, so this is the list that explains the gap between that count and the
 * extension total rather than anything to accept. Nothing at all when there are none, because a
 * standing empty section reads as a section that failed to load.
 */
function noDeviceBlock(rep: AccountReport): string {
  const xs = (rep.detail?.extensions ?? []).filter((x) => !x.anyDevice);
  if (!xs.length) return '';
  const rows = xs.map((x) => `<tr><td>${esc(x.ext)}</td><td>${esc([x.name, x.site, x.scope].filter(Boolean).join(' · '))}</td></tr>`).join('');
  return `<details class="nodev"><summary>Extensions without a device (${num(xs.length)})</summary><table class="nodev"><tbody>${rows}</tbody></table></details>`;
}

/** Mirrors `obInventory`: what NetSapiens actually holds, beside what OneBill bills for. */
function inventoryBlock(rep: AccountReport): string {
  // Partial all the way down, mirroring the client copy's defaults: a report cached before a field
  // existed still renders, rather than throwing halfway through the panel.
  const v: Partial<DomainInventory> = rep.inventory ?? {};
  const e: Partial<DomainInventory['extensions']> = v.extensions ?? {};
  const d: Partial<DomainInventory['dids']> = v.dids ?? {};
  const dv: Partial<DomainInventory['devices']> = v.devices ?? {};
  const s: Partial<DomainInventory['systemUsers']> = v.systemUsers ?? {};
  return '<h3>What is on the phone system</h3><div class="inv">'
    + `<div class="bd"><b>Extensions</b><ul><li>Total - ${num(e.total)}</li>`
    + `<li>Transcription enabled - ${num(v.transcriptionEnabled)}</li></ul></div>`
    + breakdown('Extensions by scope', e.byScope)
    + breakdown('Extensions by service code', e.byServiceCode)
    + breakdown('Extensions by device count', e.byDeviceCount as Record<string, number> | undefined)
    + breakdown('System users', s.byServiceCode)
    // Total is `dids.all` — every number the domain holds — and the three lines under it partition it:
    // toll-free + local + fax. netsapiens-lib 0.7.0 takes fax lines out of `dids.total` (they bill as fax
    // lines, not as DIDs), so a summary headed by that number would under-report what is actually there,
    // and a Total its own breakdown does not add up to is the kind of number a reader stops trusting.
    // The `all == null` fallback is the rule every other field here follows: a report cached before the
    // field existed still renders, with the number it used to show.
    + `<div class="bd"><b>Numbers</b><ul><li>Total - ${num(d.all == null ? d.total : d.all)}</li><li>Toll-free - ${num(d.tollFree)}</li><li>Local - ${num(d.local)}</li>`
    + `<li>Fax lines - ${num(d.fax)}</li>`
    // The ENDPOINT is the billed E911 unit, and a LEGACY number is the same thing on a domain that
    // predates endpoints — so they share a line, and the ADDRESS count stays beneath them as
    // information. An address is where responders are sent; nobody bills one.
    + `<li>E911 endpoints - ${num(v.e911Endpoints)} · legacy numbers - ${num(v.e911Legacy)}</li>`
    + `<li>E911 addresses - ${num(v.e911Addresses)}</li><li>SMS numbers - ${num(v.smsNumbers)}</li></ul></div>`
    + `<div class="bd"><b>Devices</b><ul><li>Total - ${num(dv.total)}</li></ul></div>`
    + breakdown('Devices by model', dv.byModel)
    + '</div>' + domainTotalsLine(rep) + noDeviceBlock(rep);
}

/**
 * One account's panel: what it is billed for, what is live on the domain, and where those disagree.
 * Mirrors `obPanel` byte for byte — the selftest evaluates the client copy and compares.
 *
 * `canWrite` is taken from the REPORT (`loadAccountReport` puts the caller's own key on it); the
 * parameter is kept so this reads like `renderRows`, and the two must agree.
 */
export function renderAccountPanel(report: AccountReport, canWrite: boolean): string {
  const rep: AccountReport = { ...report, canWrite: report.canWrite && canWrite };
  const account = esc(rep.accountNumber);
  // The ACCOUNT is the subject: one panel can span two domains and half of a third, so a domain in the
  // heading would name whichever the operator happened to click. Its extent goes underneath.
  const head = '<header class="panel-head"><button type="button" class="btn" data-act="back">Back to the list</button>'
    + `<h2>${account}${rep.accountName ? ` — ${esc(rep.accountName)}` : ''}</h2>`
    + `<div class="dim">${scopesLine(rep)}</div>`
    + `<div class="dim small">Loaded ${esc(String(rep.loadedAt ?? '').replace('T', ' ').slice(0, 16))} UTC <button type="button" class="btn" data-act="refresh-account">Refresh</button></div></header>`;
  const note = rep.baselinesEnabled ? '' : '<p class="dim">Baselines are not configured on this deployment, so gaps cannot be accepted here.</p>';
  const acceptHead = canAct(rep) ? '<th></th>' : '';
  const table = `<table class="cmp"><thead><tr><th>Group</th><th class="n">Billed</th><th class="n">Live</th><th class="n">Accepted</th><th>Verdict</th>${acceptHead}</tr></thead><tbody>${compRows(rep)}</tbody></table>`;
  return `<section class="panel">${head}${partialNote(rep)}${readFailBlock(rep)}${note}${table}${unmappedBlock(rep)}${unassignedBlock(rep)}${inventoryBlock(rep)}</section>`;
}

// ── style ───────────────────────────────────────────────────────────────────────────────────────────
// The console's palette, plus one token of its own: --integ, the amber that marks this as an integration
// page rather than a portal one. Both themes are complete; a token defined only under one media query is
// a page that renders unstyled for half its readers.

const STYLE = `
:root { color-scheme: light dark; --fg:#1e293b; --dim:#64748b; --bg:#f8fafc; --card:#fff; --line:#e2e8f0;
        --red:#b91c1c; --amber:#b45309; --blue:#1a6bb0; --green:#15803d; --grey:#94a3b8; --integ:#b45309;
        --chip-split:#1a6bb0;
        /* Ink for anything printed ON one of those fills. It flips with the theme because the fills do:
           the light palette is saturated and takes white, the dark one is bright and takes near-black.
           A fixed #fff was legible on the light chips and washed out on every dark one. */
        --onink:#fff; }
@media (prefers-color-scheme: dark) { :root { --fg:#e2e8f0; --dim:#94a3b8; --bg:#0f172a; --card:#1e293b;
        --line:#334155; --red:#f87171; --amber:#fbbf24; --blue:#5b8bc0; --green:#4ade80; --grey:#64748b; --integ:#fbbf24;
        --chip-split:#60a5fa;
        --onink:#0f172a; } }
* { box-sizing:border-box; }
html, body { max-width:100%; }
body { margin:0; padding:0 1rem 2.5rem; background:var(--bg); color:var(--fg);
       font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:78rem; margin:0 auto; }
h1 { font-size:1.25rem; margin:0; }
h2 { font-size:1rem; margin:1.6rem 0 .5rem; }
code { background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:.05rem .3rem; font-size:.9em; word-break:break-word; }
.dim { color:var(--dim); }
.ob-head { border-top:3px solid var(--integ); padding-top:.7rem; margin-bottom:1rem;
           border-bottom:1px solid var(--line); padding-bottom:.7rem; }
.eyebrow { color:var(--integ); font-size:.7rem; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
.title-row { display:flex; align-items:baseline; gap:.6rem; flex-wrap:wrap; margin-top:.15rem; }
.grow { flex:1 1 auto; }
.ver { color:var(--dim); font-size:.85em; }
.meta { color:var(--dim); font-size:.85rem; margin-top:.35rem; display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
.meta .sep { opacity:.5; }
.btn { font:inherit; font-size:.85rem; padding:.28rem .7rem; border-radius:5px; border:1px solid var(--line);
       background:var(--card); color:var(--fg); cursor:pointer; }
.btn:hover { border-color:var(--integ); }
.btn.primary { background:var(--integ); border-color:var(--integ); color:var(--onink); font-weight:600; }
.btn:disabled { opacity:.55; cursor:default; }
.legend { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; margin:0 0 .8rem; font-size:.82rem; color:var(--dim); }
.chip { display:inline-block; font-size:.68rem; font-weight:700; letter-spacing:.03em; padding:.12rem .45rem;
        border-radius:4px; border:1px solid transparent; white-space:nowrap; text-transform:uppercase; }
.chip-linked { color:var(--onink); background:var(--green); }
.chip-unlinked { color:var(--onink); background:var(--amber); }
.chip-conflict { color:var(--onink); background:var(--red); }
.chip-split { color:var(--onink); background:var(--chip-split); }
.chip-stale { color:var(--dim); background:transparent; border-color:var(--grey); }
.chip-closed { color:var(--dim); background:transparent; border-color:var(--grey); border-style:dashed; }
/* A small NEUTRAL chip — not a row state, just a marker on the one account (of a split domain's several)
   that actually holds the usage subscription. --dim/--grey already flip between the light and dark
   palettes above, so this reads correctly in both without a dedicated token. */
.chip.usage { color:var(--dim); background:transparent; border-color:var(--grey); }
.sacct { margin-bottom:.2rem; }
.sacct:last-child { margin-bottom:0; }
.sacct .sname { color:var(--fg); }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:8px; background:var(--card); }
table.ob { border-collapse:collapse; width:100%; font-size:.88rem; }
table.ob th { text-align:left; font-size:.72rem; letter-spacing:.04em; text-transform:uppercase; color:var(--dim);
              padding:.5rem .7rem; border-bottom:1px solid var(--line); white-space:nowrap; }
table.ob td { padding:.45rem .7rem; border-bottom:1px solid var(--line); vertical-align:top; }
table.ob tr:last-child td { border-bottom:0; }
/* The Domain/Site header is a button, not a label — it sorts the parent groups. Sized and cased to read
   as plain header text: the button reset removes a button's own font/border, and the rest is inherited. */
.thbtn { background:none; border:0; padding:0; margin:0; font:inherit; color:inherit; text-transform:inherit;
         letter-spacing:inherit; cursor:pointer; display:inline-flex; align-items:center; gap:.3rem; }
.thbtn:hover, .thbtn:focus-visible { color:var(--fg); }
.thbtn:focus-visible { outline:2px solid var(--integ); outline-offset:2px; border-radius:3px; }
.sortglyph { font-size:.8em; opacity:.8; }
td.tgt .dom { font-weight:600; }
/* An account link into the OneBill portal reads as a link, not as plain data — same blue the rest of the
   console uses for an outbound reference (see the "Usage subscriptions" details/summary link). */
td a, .frow a, .res a, .sacct a { color:var(--blue); text-decoration:underline; text-underline-offset:.1em; }
td a:hover, .frow a:hover, .res a:hover, .sacct a:hover { text-decoration:none; }
/* A site row's second line: the parent's own domain span stays above it, unindented, so the pair reads
   as "this domain, this site of it" rather than "domain / site" run together on one line. */
.siterow { color:var(--dim); margin-top:.15rem; margin-left:1rem; font-size:.85em; }
td.act { white-space:nowrap; }
td.act > * { margin-right:.35rem; }
.applied { display:inline-block; font-size:.78rem; color:var(--green); }
.applied.bad { color:var(--red); }
.pickwrap { font-size:.8rem; color:var(--dim); }
.conf { font-size:.7rem; color:var(--dim); border:1px solid var(--line); border-radius:3px; padding:0 .25rem; }
.note { color:var(--dim); font-size:.8rem; margin-top:.2rem; }
input.acct, select.site { font:inherit; font-size:.82rem; padding:.2rem .35rem; border:1px solid var(--line);
       border-radius:4px; background:var(--bg); color:var(--fg); max-width:13rem; }
/* Fixed, not absolute: the table lives in an overflow-x:auto box, which clips anything positioned
   inside it — so the list is placed against the viewport when it opens. */
ul.ta { position:fixed; z-index:20; margin:0; padding:.15rem; list-style:none; max-height:14rem; overflow-y:auto;
        background:var(--card); border:1px solid var(--line); border-radius:6px; box-shadow:0 8px 22px rgb(0 0 0 / .22); }
ul.ta[hidden] { display:none; }
li.ta-row { padding:.22rem .45rem; border-radius:4px; cursor:pointer; white-space:nowrap; font-size:.85rem; }
li.ta-row:hover, li.ta-row.on { background:var(--integ); color:var(--onink); }
li.ta-row .ta-num { color:var(--dim); font-size:.85em; margin-left:.35rem; }
li.ta-row:hover .ta-num, li.ta-row.on .ta-num { color:var(--onink); opacity:.8; }
.editor { display:block; margin-top:.45rem; max-width:36rem; white-space:normal; }
/* A class setting display beats the UA's [hidden] rule, so the editor drew itself open on every linked
   row until this line existed. Same trap as ul.ta, one block down. */
.editor[hidden] { display:none; }
.erow { display:flex; gap:.35rem; align-items:center; flex-wrap:wrap; margin-top:.3rem; }
.elab { font-size:.72rem; letter-spacing:.04em; text-transform:uppercase; color:var(--dim); min-width:5.8rem; }
.erow .note { margin-top:0; }
/* WIDTH, not max-width: the input's default size is narrower than either cap, and this placeholder has
   to be readable whole — it is the only thing that says leaving it blank means this account. */
.erow input.acct { width:15rem; max-width:100%; }
.frow { border:1px solid var(--line); border-left:3px solid var(--grey); border-radius:6px; background:var(--card);
        padding:.5rem .7rem; margin-bottom:.5rem; }
.fhead { display:flex; gap:.45rem; align-items:baseline; flex-wrap:wrap; }
.fhead .arrow { color:var(--dim); }
.frow .btn { margin-top:.4rem; }
.res { border:1px solid var(--line); border-left:3px solid var(--green); border-radius:6px; background:var(--card);
       padding:.45rem .7rem; margin-bottom:.4rem; font-size:.88rem; }
.res.bad { border-left-color:var(--red); }
.res.decom { border-left-color:var(--integ); }
.res .why { color:var(--red); }
.res .caveat { color:var(--amber); }
.fail { border:1px solid var(--red); border-left:3px solid var(--red); border-radius:6px; background:var(--card);
        padding:.5rem .7rem; margin:.6rem 0; }
.fail b { color:var(--red); }
.ronote { border-left:3px solid var(--integ); background:var(--card); padding:.45rem .7rem; margin:0 0 1rem;
          border-radius:0 6px 6px 0; font-size:.88rem; }
.setup-card { border:1px solid var(--amber); border-left:3px solid var(--amber); border-radius:6px;
              background:var(--card); padding:.7rem .9rem; margin:.6rem 0; }
.setup-card h2 { margin:0 0 .4rem; font-size:1rem; color:var(--amber); }
.setup-card p { margin:0; font-size:.9rem; }
details { margin-top:.4rem; }
details summary { cursor:pointer; color:var(--blue); font-size:.85rem; }
.bar { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; margin:.8rem 0; }
#ob-filter { font:inherit; font-size:.85rem; padding:.3rem .6rem; border:1px solid var(--line); border-radius:5px;
             background:var(--card); color:var(--fg); min-width:18rem; max-width:100%; }
#ob-filter-count { font-size:.8rem; }
#ob-prefilter { font-size:.85rem; }
#ob-prefilter-clear { color:var(--blue); text-decoration:underline; text-underline-offset:.1em; }
#ob-prefilter-clear:hover { text-decoration:none; }
/* ── the account detail panel ─────────────────────────────────────────────────────────────────────
   The four verdict chips. Fixed pairs rather than palette tokens: these are the one place on this page
   where the colour IS the message, and each pair is contrast-checked against its own fill in both
   themes, which a token that flips underneath them would not be. */
.chip-match { background:#e6f4ea; color:#137333; }
.chip-accepted { background:#e8f0fe; color:#1a56c4; }
.chip-drift { background:#fce8e6; color:#c5221f; }
.chip-unbaselined { background:#fef7e0; color:#8a6116; }
/* Not a verdict — a row nothing bills and nothing uses. Deliberately the quietest of the five: it is
   the one that never needs acting on. */
.chip-optional { background:transparent; color:var(--dim); border-color:var(--grey); }
/* What the billed count is made of. Tight against the group name, and the credits sit one notch dimmer
   than the offers, because a credit is why the row exists rather than a line on the bill. */
ul.offers { margin:.15rem 0 0; padding-left:1.1rem; font-size:.78rem; color:var(--dim); }
ul.offers li.credit { color:var(--grey); }
.ent { font-size:.72rem; font-weight:400; }
/* What is plugged into an extension. Chips rather than a comma list: a device name and its model are
   one thing, and two devices on one user are two. The connector is outlined rather than filled — it is
   a Teams registration, not a handset on a desk. */
.devs { margin-top:.15rem; display:flex; gap:.25rem; flex-wrap:wrap; }
.dev { font-size:.72rem; color:var(--dim); background:var(--bg); border:1px solid var(--line);
       border-radius:4px; padding:0 .3rem; }
.dev-teams { background:transparent; border-style:dashed; }
details.nodev { margin-top:.8rem; }
details.nodev summary { color:var(--dim); font-size:.85rem; }
table.nodev { border-collapse:collapse; margin-top:.35rem; font-size:.82rem; }
table.nodev td { padding:.15rem .7rem .15rem 0; color:var(--dim); }
.panel { margin-top:1rem; }
.panel-head h2 { margin:.4rem 0 .2rem; }
.panel h3 { font-size:.95rem; margin:1.4rem 0 .4rem; }
table.cmp { border-collapse:collapse; width:100%; font-size:.88rem; background:var(--card);
            border:1px solid var(--line); border-radius:8px; }
table.cmp th { text-align:left; font-size:.72rem; letter-spacing:.04em; text-transform:uppercase;
               color:var(--dim); padding:.5rem .7rem; border-bottom:1px solid var(--line); }
table.cmp td { padding:.45rem .7rem; border-bottom:1px solid var(--line); vertical-align:top; }
table.cmp tr:last-child td { border-bottom:0; }
/* An idle row — 0/0, no items, no recorded decision — carries no Details link and reads quiet: the same
   --dim used for meta text and footnotes, and a dimmed verdict chip rather than a fully-lit one. */
tr.idle td { color:var(--dim); }
tr.idle .chip { opacity:.6; }
.cmp td.n, .cmp th.n { text-align:right; font-variant-numeric:tabular-nums; }
.inv { display:grid; grid-template-columns:repeat(auto-fit,minmax(14rem,1fr)); gap:1rem; }
.inv .bd ul { margin:.2rem 0 0; padding-left:1.1rem; }
.small { font-size:.85em; }
ul.unmapped { margin:.2rem 0 0; padding-left:1.1rem; }
/* A linked row's domain opens that account's panel — a button, so it is reachable by keyboard and
   announced as the control it is, drawn as the link it reads as. */
.linkish { background:none; border:0; padding:0; font:inherit; color:var(--blue); cursor:pointer;
           text-decoration:underline; text-underline-offset:.1em; }
.linkish:hover { text-decoration:none; }
.linkish:focus-visible { outline:2px solid var(--integ); outline-offset:2px; border-radius:3px; }
/* The panel note field, opened beside an Accept button. */
input[data-role="note"] { font:inherit; font-size:.82rem; padding:.2rem .35rem; border:1px solid var(--line);
       border-radius:4px; background:var(--bg); color:var(--fg); max-width:16rem; margin-right:.35rem; }
/* Fixed + centered, over everything: a page that answers "Loading…" only in a corner reads as though
   nothing is happening, on a call that can genuinely take a while. */
.busy { position:fixed; inset:0; z-index:40; display:flex; align-items:center; justify-content:center;
        background:rgb(15 23 42 / .55); }
.busy[hidden] { display:none; }
.busy-box { display:flex; align-items:center; gap:.8rem; background:var(--card); color:var(--fg);
            border:1px solid var(--line); border-radius:8px; padding:1rem 1.4rem; box-shadow:0 12px 32px rgb(0 0 0 / .35); }
.spinner { width:1.5rem; height:1.5rem; border-radius:50%; flex:none;
           border:3px solid var(--line); border-top-color:var(--integ); animation:ob-spin .8s linear infinite; }
@keyframes ob-spin { to { transform:rotate(360deg); } }
/* A spinning ring is exactly the kind of motion prefers-reduced-motion asks pages to drop — the static
   ring still says "busy" without the spin. */
@media (prefers-reduced-motion: reduce) { .spinner { animation:none; } }
/* The apply-results toast. Fixed at the top of the viewport and z-INDEXED ABOVE the busy overlay
   (--busy is 40) on purpose: the re-read that follows a successful apply shows "Reloading the report…"
   on that overlay, and the toast must still read through it rather than being buried under it. */
#ob-toast { position:fixed; top:0; left:50%; transform:translate(-50%,-120%); z-index:50;
            max-width:40rem; width:calc(100% - 2rem); background:var(--card); color:var(--fg);
            border:1px solid var(--line); border-top:4px solid var(--grey); border-radius:0 0 8px 8px;
            padding:.6rem 2.4rem .6rem .9rem; box-shadow:0 10px 28px rgb(0 0 0 / .3);
            transition:transform .25s ease; }
#ob-toast[hidden] { display:none; }
#ob-toast.show { transform:translate(-50%,0); }
#ob-toast.ok { border-top-color:var(--green); }
#ob-toast.bad { border-top-color:var(--red); }
#ob-toast .toast-x { position:absolute; top:.3rem; right:.5rem; background:none; border:0; color:var(--dim);
                      font-size:1.3rem; line-height:1; cursor:pointer; padding:.2rem .4rem; }
#ob-toast .toast-x:hover { color:var(--fg); }
@media (prefers-reduced-motion: reduce) { #ob-toast { transition:none; } }
/* ── the per-item rows ───────────────────────────────────────────────────────────
   An item's status, in the same shape as a verdict chip but on the palette tokens: these three ride
   alongside the four fixed verdict pairs above and flip with the theme the rest of the panel does. */
.chip-item-accepted { color:var(--onink); background:var(--green); }
.chip-item-unreviewed { color:var(--onink); background:var(--amber); }
.chip-item-stale { color:var(--dim); background:transparent; border-color:var(--grey); text-decoration:line-through; }
.cnt { font-size:.75rem; color:var(--dim); margin-left:.3rem; }
/* Which domain an item is on, beside its label. Quiet on purpose: on a two-domain account it is on every
   row, and a badge that shouts the same word twelve times is a column pretending to be a highlight. */
.where { font-size:.75rem; color:var(--dim); margin-left:.4rem; }
/* Somebody placed this item by hand. Outlined rather than filled: it is not a state of the reconciliation
   (those are the item chips above), it is a note about how the item got here. */
.chip-manual { color:var(--dim); background:transparent; border-color:var(--grey); }
/* WHICH KIND of thing a line is, first in the label cell. Quieter than a chip and set in caps rather than
   coloured: it is on every row of every list, so five colours here would be five colours competing with
   the status chips that actually change. The per-kind classes carry no colour today and exist so one can
   be given one without touching the renderer. */
.kind { display:inline-block; margin-right:.4rem; font-size:.65rem; letter-spacing:.04em;
        text-transform:uppercase; color:var(--dim); }
.kind-ext, .kind-did, .kind-fax, .kind-addr, .kind-e911, .kind-e911legacy, .kind-sms { }
/* The other accounts this item is also on, and what each is billed for it. Under the label rather than
   beside it: there can be three, and a row that grows sideways pushes the numbers off the table. */
.also { margin-top:.15rem; }
/* The Unassigned list. Its own table rather than a section of the comparison: these rows are not billed
   anywhere yet, so they have no billed/live/accepted to sit under. */
table.una { border-collapse:collapse; width:100%; font-size:.88rem; background:var(--card);
            border:1px solid var(--line); border-radius:8px; margin-bottom:1rem; }
table.una td { padding:.45rem .7rem; border-bottom:1px solid var(--line); vertical-align:top; }
table.una tr:last-child td { border-bottom:0; }
table.una td.act { white-space:nowrap; }
table.una select { font:inherit; font-size:.85rem; margin-right:.35rem; }
/* SCOPED UNDER table.cmp, all of it. The inner table's cells are also descendants of the outer one, so
   a bare "table.items td" loses to "table.cmp td" on specificity and the item rows would draw with the
   group rows' padding. Same reason the row and the strike-through rule carry the prefix. */
table.cmp tr.items > td { padding:0 .7rem .6rem 1.4rem; background:var(--bg); }
table.cmp table.items { width:100%; border-collapse:collapse; font-size:.84rem; }
table.cmp table.items td { padding:.25rem .5rem; border-bottom:1px solid var(--line); }
table.cmp table.items tr:last-child td { border-bottom:0; }
/* The LABEL cell, which is the one after the selection cell — not td:first-child, which is now the
   checkbox and the row's own Accept. Striking those would strike a live control. */
table.cmp tr[data-status="stale"] td.sel + td { text-decoration:line-through; color:var(--dim); }
/* The selection cell: checkbox and the row's own decision, kept on one line and out of the label's way.
   Empty but present on a read-only page, so both builds have the same column count. */
table.cmp table.items td.sel { white-space:nowrap; width:1%; padding-right:.6rem; }
table.cmp table.items td.sel input { margin-right:.4rem; vertical-align:middle; }
table.cmp table.items tr.ihead td { border-bottom:1px solid var(--line); padding-top:.1rem; padding-bottom:.35rem; }
.btn.small { font-size:.75rem; padding:.15rem .45rem; }
/* The Details toggle only. .linkish is shared with the links table's domain buttons, which are body
   size — sizing the shared class here would shrink those too. */
.cmp .linkish { font-size:.82rem; }
details.ignored { margin-top:.6rem; }
details.ignored summary { color:var(--dim); }
`;

// ── the page script ─────────────────────────────────────────────────────────────────────────────────

/** The write half of the page script: the confirmations and the two apply paths. Never emitted for a
 *  reader without the key — the bytes are not theirs to hold, and the route would refuse them anyway. */
const WRITE_JS = String.raw`
function obPicked(){var ps=document.querySelectorAll('.pick:checked'),by={},order=[];
for(var i=0;i<ps.length;i++){var p=ps[i],tr=p.closest('tr'),sel=tr?tr.querySelector('select.site'):null;
var site=sel?sel.value:(p.getAttribute('data-site')||'');
var a=p.getAttribute('data-account');
if(!by[a]){by[a]={accountNumber:a,links:[]};order.push(a)}
by[a].links.push(site?{domain:p.getAttribute('data-domain'),site:site}:{domain:p.getAttribute('data-domain')})}
var ops=[];for(var k=0;k<order.length;k++)ops.push(by[order[k]]);
return ops}
function obCount(ops){var n=0;for(var i=0;i<ops.length;i++)n+=ops[i].links.length;return n}
function obNames(ops){var o=[];for(var i=0;i<ops.length;i++)o.push(ops[i].accountNumber);return o.join(', ')}
var applyBtn=document.getElementById('ob-apply'),prevBtn=document.getElementById('ob-preview');
if(prevBtn)prevBtn.addEventListener('click',function(){var ops=obPicked();
if(!ops.length){obSay('Nothing is selected, so there is nothing to preview.');return}
var o='';for(var i=0;i<ops.length;i++){var t=[];for(var j=0;j<ops[i].links.length;j++){var l=ops[i].links[j];t.push(esc(l.domain)+(l.site?' / '+esc(l.site):''))}
o+='<div class="res"><b>'+esc(ops[i].accountNumber)+'</b> would be linked to: '+t.join(', ')+'</div>'}
elRes.innerHTML='<h2>Preview — nothing has been sent</h2>'+o});
if(applyBtn)applyBtn.addEventListener('click',function(){var ops=obPicked();
if(!ops.length){obSay('Nothing is selected, so there is nothing to apply.');return}
if(!confirm('Link '+obCount(ops)+' target(s) to '+ops.length+' OneBill account(s): '+obNames(ops)+'.\n\nThis writes to OneBill now.'+obUnv()))return;
obSend(ops)});
// The words a confirmation uses for a target, and for an account. A dialog that says CLI00001 and
// nothing else asks the reader to recognise a number; naming the client is what makes it answerable.
function obWhere(s){return s?'site '+s:'whole domain'}
function obWho(no,nm){if(nm)return no+' — '+nm;
for(var i=0;i<OB_ACCTS.length;i++)if(OB_ACCTS[i].accountNumber===no)return no+(OB_ACCTS[i].accountName?' — '+OB_ACCTS[i].accountName:'');
return no}
// BLANK means this account. The input is rendered empty on purpose: a pre-filled label could be sent as
// an account number after the reader has typed over it, which is the bug data-acct exists to prevent.
function obEditAcct(row,dflt){var a=row?row.getAttribute('data-acct'):null;if(a)return a;
var inp=row?row.querySelector('input[data-role="acct"]'):null,v=inp?inp.value.trim():'';
return v?obResolveAcct(row):dflt}
document.addEventListener('click',function(ev){var t=ev.target;if(!t||!t.getAttribute)return;
var act=t.getAttribute('data-act');
if(act==='edit'){var etr=t.closest('tr'),ed0=etr?etr.querySelector('div[data-role="editor"]'):null;
if(!ed0)return;ed0.hidden=!ed0.hidden;t.textContent=ed0.hidden?'Edit':'Close';return}
if(act==='edit-site'||act==='edit-add'||act==='edit-unlink'){
var ed=t.closest('div[data-role="editor"]');if(!ed)return;
var etr2=ed.closest('tr');
// An unreadable list must NOT read as an empty one: with removeUnlisted an empty list clears the account.
var lks=null;try{lks=JSON.parse(ed.getAttribute('data-links')||'null')}catch(x){lks=null}
if(!Array.isArray(lks)){obSay('This row could not be read. Refresh the page and try again.');return}
var er={domain:ed.getAttribute('data-domain'),site:ed.getAttribute('data-site')||undefined};
var ea={accountNumber:ed.getAttribute('data-account'),accountName:ed.getAttribute('data-name')||'',links:lks};
var who=obWho(ea.accountNumber,ea.accountName);
if(act==='edit-site'){var esel=ed.querySelector('select[data-role="esite"]'),tos=esel?esel.value:'';
if((tos||'')===(er.site||'')){obSay('That link already points at the '+obWhere(tos)+'.');return}
if(!confirm('Move '+er.domain+' on '+who+' from '+obWhere(er.site)+' to '+obWhere(tos)+'?\n\nThis writes to OneBill now.'+obUnv()))return;
obSend(obEditOps(er,ea,'site',{site:tos}));return}
if(act==='edit-add'){var asel=ed.querySelector('select[data-role="asite"]'),adds=asel?asel.value:'';
if(!adds){obSay('There is no site left to add on this domain.');return}
var to=obEditAcct(etr2,ea.accountNumber);
if(!to){obSay('Search for a OneBill client by name or account number, then pick one.');return}
if(!confirm('Add '+obWhere(adds)+' of '+er.domain+' to '+obWho(to,'')+'?\n\nThis writes to OneBill now.'+obUnv()))return;
obSend(obEditOps(er,ea,'add',{site:adds,account:to}));return}
var uops=obEditOps(er,ea,'unlink');
if(!confirm('Unlink '+er.domain+' ('+obWhere(er.site)+') from '+who+'?\n\nThe account keeps its other '+uops[0].links.length+' link(s) in this namespace.\n\nThis writes to OneBill now.'+obUnv()))return;
obSend(uops);return}
if(act==='link'){var tr=t.closest('tr'),sel=tr?tr.querySelector('select.site'):null;
var a=t.getAttribute('data-account')||(tr?obResolveAcct(tr):'');
if(!a){obSay('Search for a OneBill client by name or account number, then pick one.');return}
var site=sel?sel.value:(t.getAttribute('data-site')||'');
var dom=t.getAttribute('data-domain');
obSend([{accountNumber:a,links:[site?{domain:dom,site:site}:{domain:dom}]}]);return}
if(act==='remove'){var box=t.closest('.frow');if(!box)return;
var links=null;try{links=JSON.parse(box.getAttribute('data-links')||'null')}catch(x){links=null}
if(!Array.isArray(links)){obSay('This row could not be read. Refresh the page and try again.');return}
var val=box.getAttribute('data-value'),q=box.getAttribute('data-qualifier')||'';
var rest=[];for(var i=0;i<links.length;i++){var l=links[i];if(l.domain===val&&(l.site||'')===q)continue;rest.push(l)}
var acctNo=box.getAttribute('data-account');
if(!confirm('Remove the link from OneBill account '+acctNo+' to '+val+(q?' / '+q:'')+'?\n\nThe account keeps its other '+rest.length+' link(s) in this namespace.'+obUnv()))return;
obSend([{accountNumber:acctNo,links:rest,removeUnlisted:true}])}});

// ── accepting and clearing, item by item or a whole group ──────────────────────────────────────────────
// The payload names the ACCOUNT the panel is showing, and never a domain: a panel can be open on an
// account that holds one SITE of a domain, and that domain's bare row belongs to somebody else — a write
// sent by domain would land on the whole-domain holder or be refused as a multi-account split. Naming the
// account is not naming a permission: the route resolves the number through the caller's own link report
// and refuses any scope reaching a domain they cannot see, so this page still cannot reach one.
// The DOMAIN a pending baseline was sent for, beside PEND rather than inside it: PEND's values are kind
// strings that two other listeners read, and widening them there to carry one extra fact for one message
// pair would make every reader of PEND handle a shape it does not need.
var OB_BASELINE_FOR={};
function askBaseline(payload){RID++;PEND[RID]='baseline';OB_BASELINE_FOR[RID]=OB_LAST_ACCOUNT&&OB_LAST_ACCOUNT.accountNumber;
// Nothing was sent, so nothing will answer: the entries are dropped rather than left for a reply that
// cannot arrive. askAssign already does this, and a PEND id that never clears is a leak that also makes
// the "was this asked for?" gate in the message listener answer yes to an id nobody is waiting on.
if(!HOSTED){delete PEND[RID];delete OB_BASELINE_FOR[RID];
obBaselineDone({unavailable:'This page is not running inside the portal, so it cannot reach this deployment.'});return}
window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.baselineRequest}', ${SPK_BRIDGE.idKey}: RID, ${SPK_BRIDGE.baselineKey}: payload },'*')}
// Is a decision already pending in this cell? One predicate, because the answer gates two things: the
// field itself (obNoteFor must not open a second one) and, further up, the confirmation — a second
// click that re-asks the dialog and then quietly does nothing is worse than a click that does nothing.
function obNoting(cell){return !!cell.querySelector('input[data-role="note"]')}
// Who a group-level confirmation is about: the OneBill account number and the domain, "CLI00001
// (acme.example)". The account is the thing being written to and the domain is how the operator got
// here; naming only one of them leaves the dialog ambiguous on a report where several domains bill to
// one account. BOTH come off the loaded report — the domain on it is the one the panel was opened by,
// which the account request carries and the assign reply has restored. Empty if no report is loaded,
// which the click handler should make impossible but a confirmation is a bad place to throw.
function obConfirmWhere(){var r=OB_LAST_ACCOUNT,a=r&&r.accountNumber,d=r&&r.domain;
return a?a+' ('+d+')':String(d||'')}
// An accept opens a note field rather than sending on the click that confirmed it: the note is the only
// part of an acceptance a later reader cannot reconstruct from the numbers. A clear asks for none — the
// history keeps what was cleared either way, and a field between the reader and undoing their own
// mistake is friction with nothing on the other side of it.
// Which plan the items being accepted are billed as. Only where the row carries MORE THAN ONE: with a
// single offer there is nothing to choose, and a select with one option is a control that asks a
// question with one answer. That single name still rides on the request — see the caller.
function obOfferSel(offers,dflt){if(!offers||offers.length<2)return '';
var o='<select data-role="offer" aria-label="Billed as">',i;
for(i=0;i<offers.length;i++)o+='<option value="'+esc(offers[i])+'"'+(offers[i]===dflt?' selected':'')+'>'+esc(offers[i])+'</option>';
return o+'</select>'}
// The offer picker and the note share ONE erow, because they are one answer to one question: what this
// acceptance says. The callback takes both; a caller with no offer to record passes an empty list and
// ignores the second argument.
function obNoteFor(cell,offers,dflt,cb){if(obNoting(cell))return;offers=obUniqOffers(offers);
cell.insertAdjacentHTML('beforeend','<span class="erow">'+obOfferSel(offers,dflt)+'<input data-role="note" placeholder="Why (optional)"><button type="button" class="btn" data-act="note-save">Save</button></span>');
var f=cell.querySelector('input[data-role="note"]');if(f&&f.focus)f.focus();
var sel=cell.querySelector('select[data-role="offer"]');
cell.querySelector('button[data-act="note-save"]').addEventListener('click',function(){
cb(f.value.trim(),sel?sel.value:((offers&&offers.length===1)?offers[0]:''))})}
// ── the item selection ─────────────────────────────────────────────────────────────────────────────────
// Selection is DOM STATE and nothing else. Nothing here is remembered across a row swap, because the
// swap replaces the boxes: a remembered key set would outlive the rows it names and the two bulk buttons
// would count things that are no longer on screen.
// The comparison row behind a group name, out of the report the panel last drew — the same object the
// full paint rendered from, so the action cell this re-renders cannot disagree with the one it replaces.
function obRowFor(g){var c=OB_LAST_ACCOUNT&&OB_LAST_ACCOUNT.comparison,rs=c?c.rows:null,i;
if(!rs)return null;
for(i=0;i<rs.length;i++)if(rs[i].group===g)return rs[i];
return null}
// Every ticked box in one group's list, counted by what its row IS: an unreviewed pick is something
// Accept selected would record, an accepted one something Clear selected would take back. A stale row
// carries no box at all (see obItemSel), so every key here is one of those two.
// The two key lists are what the SENDERS use and the counts what the BUTTONS say, so the label and the
// payload cannot disagree: Accept selected records the unreviewed ones and Clear selected takes back the
// accepted ones, even when the reader has ticked some of each.
function obPickedItems(g){var out={unreviewed:0,accepted:0,keys:[],unreviewedKeys:[],acceptedKeys:[]},row=obItemsRow(g),i;
if(!row)return out;
var ps=row.querySelectorAll('input[data-role="pick"]');
for(i=0;i<ps.length;i++){if(!ps[i].checked)continue;
var tr=ps[i].closest?ps[i].closest('tr'):null,st=tr?tr.getAttribute('data-status'):'',k=ps[i].getAttribute('data-key');
out.keys.push(k);
if(st==='unreviewed'){out.unreviewed++;out.unreviewedKeys.push(k)}
else if(st==='accepted'){out.accepted++;out.acceptedKeys.push(k)}}
return out}
// The half of a selection one action applies to, in the shape the route's items form takes.
function obPickKeys(p,action){var ks=action==='accept'?p.unreviewedKeys:p.acceptedKeys,o=[],i;
for(i=0;i<ks.length;i++)o.push({key:ks[i]});
return o}
// The plans this row is billed under, as the picker offers them. Empty for a row nothing bills, which
// is a row whose acceptance has no plan to name.
function obOffersOf(g){var row=obRowFor(g),os=(row&&row.offers)||[],o=[],i;
for(i=0;i<os.length;i++)if(os[i]&&os[i].name)o.push(os[i].name);
return o}
// The group's action cell, redrawn alone. The ROWS are left exactly as they are: re-rendering them would
// throw away the ticks that caused this, which is the one piece of state the reader is holding.
function obRepaintCtl(g){var row=obRowFor(g),tr=obGroupRow(g);
if(!row||!tr)return;
var cell=tr.querySelector('td.act');
if(cell)cell.innerHTML=obGroupCtlHtml(row,obPickedItems(g))}
// The group an event inside an item list belongs to. Walked, never built into a selector: a group name
// comes out of the rulebook, and a quote in one makes a selector that throws or matches the wrong row.
function obGroupOfEvent(t){var row=t&&t.closest?t.closest('tr.items'):null;
return row?row.getAttribute('data-items-for'):null}
document.addEventListener('change',function(ev){var t=ev.target;if(!t||!t.getAttribute)return;
var role=t.getAttribute('data-role');
if(role!=='pick'&&role!=='pick-all')return;
var g=obGroupOfEvent(t);if(g==null)return;
// UNREVIEWED rows only. A tick-everything that also ticked the accepted ones would arm Clear selected
// on a click the reader made to accept things.
if(role==='pick-all'){var row=obItemsRow(g),ps=row?row.querySelectorAll('input[data-role="pick"]'):[],i;
for(i=0;i<ps.length;i++){var tr=ps[i].closest?ps[i].closest('tr'):null;
if(tr&&tr.getAttribute('data-status')==='unreviewed')ps[i].checked=t.checked}}
obRepaintCtl(g)});

document.addEventListener('click',function(ev){var t=ev.target&&ev.target.closest?ev.target.closest('button[data-act="accept-item"],button[data-act="clear-item"],button[data-act="accept-all"],button[data-act="clear-all"],button[data-act="accept-selected"],button[data-act="clear-selected"],button[data-act="accept-shortfall"],button[data-act="clear-shortfall"]'):null;
if(!t)return;
if(!OB_LAST_ACCOUNT){obSay('This panel has no account loaded, so there is nothing to accept.');return}
var act=t.getAttribute('data-act'),group=t.getAttribute('data-group'),key=t.getAttribute('data-key'),cell=t.parentNode;
var accepting=act==='accept-item'||act==='accept-all'||act==='accept-selected'||act==='accept-shortfall';
// BEFORE the confirmation, not after: obNoteFor's own guard would let the dialog open on a second click
// and then drop the answer on the floor.
if(accepting&&obNoting(cell))return;
// Read ONCE, when the button is clicked, and closed over — not re-read when Save is pressed. A box
// ticked while the note field is open would otherwise change what the confirmation already named.
var picked=(act==='accept-selected'||act==='clear-selected')?obPickedItems(group):null;
if(picked&&!picked.keys.length){obSay('Nothing is selected on that row.');return}
// EXACTLY ONE of items/all/shortfall, because the route answers anything else with a 400. Which one is
// decided by the BUTTON rather than by what happens to be on the row: the three are three questions.
// A selection is the items form too — it names its keys, so the route needs to know nothing about how
// the operator chose them.
var send=function(note,offer){var b={account:OB_LAST_ACCOUNT.accountNumber,group:group};
if(act==='accept-item'||act==='clear-item'){b.action=act==='accept-item'?'accept':'clear';b.items=[{key:key}]}
else if(act==='accept-selected'||act==='clear-selected'){b.action=act==='accept-selected'?'accept':'clear';
b.items=obPickKeys(picked,b.action)}
else if(act==='accept-all'||act==='clear-all'){b.action=act==='accept-all'?'accept':'clear';b.all=true}
else{b.action=act==='accept-shortfall'?'accept':'clear';b.shortfall=true}
if(note)b.note=note;
// Remembered per GROUP, so the next accept on the same row defaults to the plan the operator just used
// — twelve seats accepted a few at a time should not ask the same question twelve times.
if(offer&&b.action==='accept'){b.offer=offer;OB_OFFER_LAST[group]=offer}
obBusy(true,b.action==='accept'?'Recording…':'Clearing…');askBaseline(b)};
// EVERY group-level control confirms, and says back the group, the domain and how many things it
// touches — a dialog that says "Clear all" and nothing else asks the reader to recognise the button
// they have just clicked, which is not a second look at anything. The counts come off the button, where
// the renderer wrote them. Only the two per-ITEM controls send on the click: each is one named thing the
// reader is looking at, and each is undone by the button that replaces it.
// Accepting then opens the note field; clearing sends straight away, since the history keeps the record.
var nc=Number(t.getAttribute('data-count')||0),plural=nc===1?'':'s';
// The word the BUTTON used for the group row - "shortfall" where items exist, "count" where none do.
// Off the button rather than re-derived here: a dialog that said "shortfall" under a button labelled
// "Clear count" would be naming a gap the row does not have, which is the thing the label fixed.
var gw=t.getAttribute('data-word')||'shortfall';
// The write lands on a OneBill ACCOUNT, so the dialog names it. A domain alone reads as a NetSapiens
// statement, and the operator opened this panel from a list where one account can hold several domains.
var where=obConfirmWhere();
if(act==='clear-item'){send('');return}
if(act==='clear-all'){if(!confirm('Clear all '+nc+' accepted item'+plural+' on '+group+' for '+where+'?\n\nEach goes back to unreviewed. History keeps the record.'))return;
send('');return}
if(act==='clear-selected'){if(!confirm('Clear the '+nc+' selected accepted item'+plural+' on '+group+' for '+where+'?\n\nEach goes back to unreviewed. History keeps the record.'))return;
send('');return}
if(act==='clear-shortfall'){if(!confirm('Clear the accepted '+gw+' on '+group+' for '+where+'?\n\nHistory keeps the record.'))return;
send('');return}
// An accept asks nothing here: the note-and-plan step that follows is the confirmation, and its Save
// is the click that writes. Clears above still confirm — they undo a recorded decision in one click.
// A shortfall is a decision about a COUNT, so it has no plan to be billed as and gets no picker. The
// item forms do: which plan they are billed as is the one thing about an acceptance the numbers do not
// already say.
var offers=act==='accept-shortfall'?[]:obOffersOf(group);
obNoteFor(cell,offers,OB_OFFER_LAST[group]||offers[0]||'',send)});

// ── moving one item to another account ─────────────────────────────────────────────────────────────────
// The ACCOUNT this move was sent from, beside PEND for the reason OB_BASELINE_FOR is: PEND's values are
// kind strings two other listeners read, and widening them there for one message pair would make every
// reader handle a shape it does not need.
var OB_ASSIGN_FOR={};
// Which items have a move in flight, by domain and key. A separate mark from the note field's, because a
// clear-assign opens no field and so has nothing on screen for obNoting to find. Object.create(null) for
// the reason obUnaDomains uses one: the key is report data, and "__proto__" on a plain object is a setter.
// Cleared when the reply lands, not when the confirm returns — the window that matters is the round trip.
var OB_MOVING=Object.create(null),OB_ASSIGN_ITEM={};
function obMoveKey(d,k){return String(d)+'\u0000'+String(k)}
function obMoving(d,k){return OB_MOVING[obMoveKey(d,k)]===true}
function obMoveMark(d,k){OB_MOVING[obMoveKey(d,k)]=true}
function askAssign(payload){RID++;PEND[RID]='assign';OB_ASSIGN_FOR[RID]=OB_LAST_ACCOUNT&&OB_LAST_ACCOUNT.accountNumber;
OB_ASSIGN_ITEM[RID]=obMoveKey(payload.domain,payload.key);
if(!HOSTED){delete PEND[RID];delete OB_ASSIGN_FOR[RID];var mk=OB_ASSIGN_ITEM[RID];delete OB_ASSIGN_ITEM[RID];
obAssignDone({unavailable:'This page is not running inside the portal, so it cannot reach this deployment.'},null,mk);return}
window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.assignRequest}', ${SPK_BRIDGE.idKey}: RID, ${SPK_BRIDGE.assignKey}: payload },'*')}
// The reply is the VIEWED account's whole report, not one row: an item can move out of this account
// entirely, and every count on the page moves with it. So the panel is repainted rather than swapped.
function obAssignDone(v,forAccount,moved){obBusy(false);
if(moved)delete OB_MOVING[moved];
if(forAccount&&(!OB_LAST_ACCOUNT||forAccount!==OB_LAST_ACCOUNT.accountNumber))return;
if(v.unavailable){obToastShow('<div class="res bad"><b>The item was not moved</b><div>'+esc(v.unavailable)+'</div></div>',false);return}
if(!v.report){obToastShow('<div class="res bad"><b>The item was not moved</b><div>The reply carried no report.</div></div>',false);return}
var rep=v.report;
// The assign route resolves the account, so its report cannot know which of that account's domains the
// operator opened the panel by — it answers with whichever sorts first. Putting the opened-by domain back
// is what stops the next confirmation naming a domain the operator never clicked.
if(OB_PANEL_SEL&&OB_PANEL_SEL.domain)rep.domain=OB_PANEL_SEL.domain;
obRepaint(rep)}
window.addEventListener('message',function(e){var m=e.data;
if(!m||m.${SPK_BRIDGE.tag} !== '${SPK_BRIDGE.assignResponse}')return;
var id=m.${SPK_BRIDGE.idKey},forAcct=null,moved=null;
if(id!=null){if(!PEND[id])return;delete PEND[id];forAcct=OB_ASSIGN_FOR[id];delete OB_ASSIGN_FOR[id];
moved=OB_ASSIGN_ITEM[id];delete OB_ASSIGN_ITEM[id]}
obAssignDone(m.${SPK_BRIDGE.assignKey}||{},forAcct,moved)});
// The label rides on the BUTTON, written there by the renderer: reading the cell would pick up the where
// badge beside it, and after a repaint would read whatever the repaint left there.
document.addEventListener('click',function(ev){var t=ev.target&&ev.target.closest?ev.target.closest('button[data-act="assign"],button[data-act="clear-assign"],button[data-act="unassign"]'):null;
if(!t)return;
if(!OB_LAST_ACCOUNT){obSay('This panel has no account loaded, so there is nothing to move.');return}
// The CELL, found by walking up rather than by t.parentNode: the same button is rendered in an
// Unassigned row's control cell and in an item row's, and only one of those is guaranteed to have the
// button as a direct child. closest('td') is the fact both share — it is where the picker lives too.
var act=t.getAttribute('data-act'),dom=t.getAttribute('data-domain'),key=t.getAttribute('data-key'),lbl=t.getAttribute('data-label')||key,cell=(t.closest&&t.closest('td'))||t.parentNode;
var viewing=OB_LAST_ACCOUNT.accountNumber;
// BEFORE the confirmation, on BOTH paths. A second click while a move for this item is already in flight
// must not re-ask the dialog and then quietly do nothing — being asked twice and answered once is worse
// than a click that does nothing. clear-assign opens no note field, so it needs a pending mark of its own.
if(obMoving(dom,key))return;
// null is a decision of its own — "let the automatic rule have this back" — so it is sent explicitly.
// The acceptance the item carries on THIS account goes with it, which the dialog says because nothing
// else on the page would tell the reader afterwards.
if(act==='clear-assign'){
if(!confirm('Return '+lbl+' on '+dom+' to automatic placement? Its acceptance on the current account is cleared.'))return;
obMoveMark(dom,key);obBusy(true,'Moving…');askAssign({domain:dom,key:key,accountNumber:null,viewing:viewing});return}
// Taking THIS account out of an address's set. Not the clear above: an address is placed on a set, and
// the other accounts on it keep their placement. The sentence does not promise the acceptance goes,
// because a site link that also places the address here keeps both it and the review.
if(act==='unassign'){
if(!confirm('Remove '+lbl+' on '+dom+' from this account? If no site link still places it here, its acceptance here is cleared.'))return;
obMoveMark(dom,key);obBusy(true,'Moving…');askAssign({domain:dom,key:key,accountNumber:viewing,remove:true,viewing:viewing});return}
var sel=cell?cell.querySelector('select[data-role="assign-to"]'):null;
var to=sel?sel.value:'';
if(!to){obSay('Pick the account this should be billed to.');return}
if(obNoting(cell))return;
// No confirm dialog here: the note field's Save IS the second step, and a move is undone by moving
// back. Asking twice for a reversible write is a step the operator asked to have removed (2026-09-05).
// The one fact a dialog used to carry — a PLACED item loses its acceptance on this account — is what
// the note field's placeholder says instead, so it is read where the decision is made.
obNoteFor(cell,[],'',function(note){if(obMoving(dom,key))return;
obMoveMark(dom,key);obBusy(true,'Moving…');
var b={domain:dom,key:key,accountNumber:to,viewing:viewing};if(note)b.note=note;
askAssign(b)});
if(t.getAttribute('data-placed')==='1'){var nf=cell.querySelector('input[data-role="note"]');if(nf)nf.placeholder='Why (optional) - its acceptance here is cleared'}});
`;

function pageScript(doc: OnebillDoc): string {
  return `(function(){
${rowScript(doc.canWrite)}
// Is there a parent to ask? Rendered anywhere else — a saved page, a devtools reload of the srcdoc —
// the messages go nowhere, and a page that sits on "Loading…" forever is claiming work is in flight
// when none is.
var HOSTED=false;try{HOSTED=window.parent&&window.parent!==window}catch(e){HOSTED=false}
var elRows=document.getElementById('ob-rows'),
elForeign=document.getElementById('ob-foreign'),elUsage=document.getElementById('ob-usage'),
elDecom=document.getElementById('ob-decom'),
elFail=document.getElementById('ob-failures'),elRes=document.getElementById('ob-results'),
elGen=document.getElementById('ob-gen'),elReq=document.getElementById('ob-req'),elSay=document.getElementById('ob-say'),
elSetup=document.getElementById('ob-setup'),elNormal=document.getElementById('ob-normal');
function obSay(t){if(elSay)elSay.textContent=t}
// One outstanding question per id, and the KIND is remembered with it: a list and an apply can both be
// in flight, and rendering one as the other would redraw the table from an apply result.
var RID=0,PEND={};
function ask(kind,payload){RID++;PEND[RID]=kind;
if(!HOSTED){deliver(kind,{unavailable:'This page is not running inside the portal, so it cannot reach this deployment.'});return}
window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.onebillRequest}', ${SPK_BRIDGE.idKey}: RID, ${SPK_BRIDGE.onebillKey}: payload },'*')}
// Writing shows the SAME overlay a load does, with its own words — a click that goes quiet until the
// whole page has re-read reads as nothing happened, which is worse than a spinner that says otherwise.
function obSend(ops){obSay('Applying …');obBusy(true,'Writing to OneBill…');ask('apply',{op: 'apply', ops: ops})}
var elBusy=document.getElementById('ob-busy'),elBusyText=document.getElementById('ob-busy-text'),rb=document.getElementById('ob-refresh'),vb=document.getElementById('ob-verify');
// Every write control, not just Refresh: a click on a row's Link/Edit/Remove while an apply is already
// in flight would be a second write racing the first, and disabling only the button that started this
// one leaves every other one clickable.
function obBusy(v,text){if(elBusy){elBusy.hidden=!v;if(text&&elBusyText)elBusyText.textContent=text}
var bs=document.querySelectorAll('.btn');for(var i=0;i<bs.length;i++)bs[i].disabled=v;
if(rb)rb.disabled=v;if(vb)vb.disabled=v}
// Which sweep the table on screen came from, and therefore which one a reload asks for. Set by whichever
// button was pressed; the post-apply reload keeps it, so verifying and then writing does not silently
// drop the reader back to the quick view.
var OB_MODE='quick';
// The two loads say different things because they cost different things: a quick pass is one paged walk,
// and the verify reads every account in the tenant. A spinner with the same four words over both would
// make the slow one look broken.
function obLoad(refresh,mode){OB_MODE=(mode==='full')?'full':'quick';
obBusy(true,OB_MODE==='full'?'Verifying every OneBill account…':(refresh?'Reloading the report…':'Loading…'));
obSay(OB_MODE==='full'?'Reading every OneBill account …':(refresh?'Re-reading OneBill …':'Loading …'));
var q={op: 'list', mode: OB_MODE};if(refresh)q.refresh=true;
ask('list',q)}
function failBox(title,why,extra){return '<div class="fail"><b>'+esc(title)+'</b><div>'+esc(why)+'</div>'+(extra||'')+'</div>'}
var OB_TRANSIENT_LINE='<div class="note">This is a transient API error; a Refresh may clear it.</div>';
// A failed load is NOT an empty table. An empty links table reads as "OneBill has nothing here", which
// is a confident answer to a question that was never successfully asked.
function failLoad(why){obSay('');
if(elRows)elRows.innerHTML='<tr class="empty"><td colspan="'+OB_COLS+'">'+esc(why)+'</td></tr>';
if(elFail)elFail.innerHTML=failBox('The report did not load',why+' Nothing on this page is a report about your links.')}
// The apply toast — one element, reused for a whole apply's outcome AND for the rarer "it never even
// ran" case. z-INDEXED ABOVE the busy overlay in the stylesheet, so the re-read that follows a
// successful apply cannot bury it under "Reloading the report…".
var elToast=document.getElementById('ob-toast'),obToastTimer=null;
function obToastHide(){if(!elToast)return;elToast.classList.remove('show');elToast.hidden=true;
if(obToastTimer){clearTimeout(obToastTimer);obToastTimer=null}}
// ok ⇒ green edge, auto-dismiss after 8s; anything failed ⇒ red edge, stays until the reader dismisses
// it — a failure that vanishes on its own is one the reader may not have finished reading.
function obToastShow(html,ok){if(!elToast)return;
if(obToastTimer){clearTimeout(obToastTimer);obToastTimer=null}
elToast.className=ok?'ok':'bad';
elToast.innerHTML=html+'<button type="button" class="toast-x" aria-label="Dismiss">&times;</button>';
elToast.hidden=false;
if(window.requestAnimationFrame)requestAnimationFrame(function(){elToast.classList.add('show')});else elToast.classList.add('show');
if(ok)obToastTimer=setTimeout(obToastHide,8000)}
if(elToast)elToast.addEventListener('click',function(ev){if(ev.target&&ev.target.classList&&ev.target.classList.contains('toast-x'))obToastHide()});
function failApply(why){obBusy(false);obSay('');
obToastShow('<div class="res bad"><b>The apply did not run</b><div>'+esc(why)+'</div></div>',false)}
function fmtWhen(s){try{return new Date(s).toLocaleString()}catch(x){return String(s||'')}}
// Persists across re-renders within this page's own session (a header click, a Refresh, an apply's
// re-read) — never across a reload, since it is only a variable in THIS script's closure. The state
// TRANSITION is obSortNext (a pure helper, VM-tested directly) — this just holds the current value and
// wires it to the two headers.
var OB_SORT={key:'state',dir:{domain:'asc',state:'asc'}},OB_LAST_REP=null;
var OB_SORT_THS=[{key:'domain',th:document.getElementById('ob-sort-dom-th'),btn:document.getElementById('ob-sort-dom-btn')},
{key:'state',th:document.getElementById('ob-sort-state-th'),btn:document.getElementById('ob-sort-state-btn')}];
// aria-sort and data-sort live on the <th> itself, not the button inside it — a screen reader looks for
// aria-sort on the column header cell, and only the ACTIVE header carries either attribute or a glyph.
function obApplySortUI(){for(var i=0;i<OB_SORT_THS.length;i++){var e=OB_SORT_THS[i];if(!e.th)continue;
var on=e.key===OB_SORT.key;
if(on){e.th.setAttribute('aria-sort',OB_SORT.dir[e.key]==='asc'?'ascending':'descending');e.th.setAttribute('data-sort',OB_SORT.dir[e.key])}
else{e.th.removeAttribute('aria-sort');e.th.removeAttribute('data-sort')}
var g=e.th.querySelector('.sortglyph');if(g)g.textContent=on?(OB_SORT.dir[e.key]==='asc'?'▲':'▼'):''}}
function obSortClick(key){return function(){
OB_SORT=obSortNext(OB_SORT,key);
obApplySortUI();if(OB_LAST_REP)render(OB_LAST_REP)}}
for(var obsi=0;obsi<OB_SORT_THS.length;obsi++)if(OB_SORT_THS[obsi].btn)OB_SORT_THS[obsi].btn.addEventListener('click',obSortClick(OB_SORT_THS[obsi].key));
function render(rep){OB_LAST_REP=rep;obSay('');
// A links report is the LIST view. If an account panel is open (header Refresh while reading one),
// close it first, or the list un-hides underneath the panel and both show at once.
if(elPanel&&!elPanel.hidden)obPanelHide();
if(elGen)elGen.textContent=obHeadline(rep,Date.now(),fmtWhen);
if(elReq)elReq.textContent=(rep.requestCount||0)+' upstream requests'+((rep.retried||0)>0?' ('+rep.retried+' retried)':'');
// OneBill has not declared the group this deployment maps links onto: the table, the filter bar and
// every write control are replaced with a remediation card. Refresh and Verify stay live in the header
// — they are how a reader checks again after fixing it in OneBill.
if(elSetup){if(rep&&rep.setup&&rep.setup.ok===false){
elSetup.innerHTML=obSetupCard(rep.setup);elSetup.hidden=false;
if(elNormal)elNormal.hidden=true;
return}
elSetup.hidden=true;elSetup.innerHTML='';if(elNormal)elNormal.hidden=false}
// The report itself is never resorted — only the group ORDER drawn from it, at render time, so a
// Refresh or an apply's re-read still hands back rows in the server's own order underneath this.
if(elRows){var rr=obWithRows(rep,obSortGroups(rep.rows||[],OB_SORT.key,OB_SORT.dir[OB_SORT.key]));
elRows.innerHTML=obRows(rr);obAfterRender(rr);obPaintApplied()}
if(elForeign)elForeign.innerHTML=obForeign(rep);
if(elDecom)elDecom.innerHTML=obDecom(rep);
if(elUsage){var us=rep.usage||[],uo='';
for(var i=0;i<us.length;i++)uo+='<div class="res"><b>'+obAcct(us[i].account)+'</b> — '+esc(us[i].verdict)+obNotes(us[i].findings)+'</div>';
elUsage.innerHTML=uo||'<p class="dim">No usage subscription needs attention.</p>'}
// NEVER HIDDEN when non-empty. An account that could not be read, or a domain whose sites could not be
// listed, is the difference between a link to fix and a link to remove.
if(elFail){var fo='',fs=rep.failures||[],sf=rep.siteReadFailures||[];
for(var k=0;k<fs.length;k++)fo+=failBox('OneBill account '+fs[k].accountNumber+' could not be read',fs[k].message,obTransient(fs[k].message)?OB_TRANSIENT_LINE:'');
if(sf.length)fo+=failBox('Sites could not be read for '+sf.length+' domain(s)','Their sites are missing here, not absent in NetSapiens: '+sf.join(', ')+'. A link to a site of one of these looks stale on this page when it may be correct.');
elFail.innerHTML=fo}
// The rows JUST redrawn are brand-new elements with no display style of their own — a filter typed
// before this render would otherwise be silently forgotten the moment a Refresh or an apply replaces them.
obApplyFilter()}
function showResults(list){var o='',allOk=true;
for(var i=0;i<list.length;i++){var r=list[i]||{};
if(!r.ok){allOk=false;o+='<div class="res bad"><b>'+obAcct({accountNumber:r.accountNumber})+'</b> — not written. <span class="why">'+esc(r.error||'OneBill gave no reason.')+'</span></div>';continue}
var bits=[];
if(r.created)bits.push(esc(r.created)+' created');
if(r.updated)bits.push(esc(r.updated)+' updated');
if(r.unchanged)bits.push(esc(r.unchanged)+' unchanged');
if(r.removed)bits.push(esc(r.removed)+' removed');
var caveat='';
// Non-zero here means the account does NOT match what was sent — the library documents this as the
// thing to check before believing it does.
if(r.notRemoved)caveat+='<div class="caveat">'+esc(r.notRemoved)+' link(s) were left on the record that this did not ask for — the account does not match what was sent.</div>';
if(r.unmapped)caveat+='<div class="caveat">'+esc(r.unmapped)+' requested link(s) this deployment cannot map, so that part did nothing.</div>';
if(r.collateral&&r.collateral.length)caveat+='<div class="caveat">OneBill also moved: '+esc(r.collateral.join(', '))+'. The write succeeded.</div>';
o+='<div class="res"><b>'+obAcct({accountNumber:r.accountNumber})+'</b> — '+(bits.length?bits.join(', '):'nothing to do')+'.'+caveat+'</div>'}
// NO RESULTS IS A FAILED APPLY. An empty list is indistinguishable from "it all worked and there was
// nothing to say", which is the same confident-wrong shape unavailable exists to prevent.
if(!o){failApply('The apply came back with no results at all, so nothing is known to have changed. Nothing here is a report about what was written.');return}
// The toast renders BEFORE the re-read starts — a reader who just clicked Apply sees what happened
// immediately, not after the whole report has reloaded underneath it.
OB_APPLIED={};for(var m=0;m<list.length;m++)if(list[m]&&list[m].accountNumber)OB_APPLIED[list[m].accountNumber]=list[m];
obToastShow(o,allOk);
obLoad(false,OB_MODE)}
function deliver(kind,v){
if(kind==='apply'){if(v.unavailable){failApply(v.unavailable);return}showResults(v.results||[]);return}
// A list reply, success or unavailable: either way the question that was asked has an answer now, so
// the overlay claiming work is still in flight would be a lie the moment either branch below runs.
obBusy(false);
if(v.unavailable){failLoad(v.unavailable);return}
if(!v.report){failLoad('The reply carried no report.');return}
render(v.report)}
window.addEventListener('message',function(e){var m=e.data;
if(!m||m.${SPK_BRIDGE.tag} !== '${SPK_BRIDGE.onebillResponse}')return;
var id=m.${SPK_BRIDGE.idKey},v=m.${SPK_BRIDGE.onebillKey}||{};
var kind=null;
if(id!=null){kind=PEND[id];if(!kind)return;delete PEND[id]}
// An unstamped reply is still read — a page holding an older cached bundle degrades to the previous
// behaviour rather than going silent. See SPK_BRIDGE.idKey.
if(!kind)kind=v.results?'apply':'list';
deliver(kind,v)});
if(rb)rb.addEventListener('click',function(){OB_APPLIED={};obLoad(true,'quick')});
if(vb)vb.addEventListener('click',function(){OB_APPLIED={};obLoad(true,'full')});
// ── the filter box ──────────────────────────────────────────────────────────────────────────────────
// A site row FOLLOWS its split parent's visibility unless it matches on its own — so the rows are
// walked in table order (they are already grouped that way by buildLinkReport) rather than filtered
// independently, which would let a matching parent's non-matching child vanish mid-group.
var elFilter=document.getElementById('ob-filter'),elFcount=document.getElementById('ob-filter-count');
function obApplyFilter(){if(!elFilter)return;
var q=elFilter.value,rows=document.querySelectorAll('tr[data-state]'),total=rows.length,shown=0;
var groupDomain=null,groupVisible=false;
for(var i=0;i<rows.length;i++){var row=rows[i],dom=row.getAttribute('data-domain')||'',self=obRowMatches(row,q),vis;
if(row.getAttribute('data-state')==='split'){groupDomain=dom;groupVisible=self;vis=self}
else if(dom&&dom===groupDomain){vis=self||groupVisible}
else{groupDomain=null;groupVisible=false;vis=self}
row.style.display=vis?'':'none';if(vis)shown++}
if(elFcount)elFcount.textContent=q.trim()?(shown+' of '+total+' rows'):''}
if(elFilter){elFilter.addEventListener('input',obApplyFilter);
elFilter.addEventListener('keydown',function(ev){if(ev.key==='Escape'){elFilter.value='';obApplyFilter()}})}
// ── the domain this page was opened FOR, if any ────────────────────────────────────────────────────
// data-prefilter is route-validated (worker.ts checks it against the caller's own visible domains) and
// attribute-escaped, so reading it back here needs no further checking. Setting elFilter.value and
// calling obApplyFilter() now is what makes typing-equivalent filtering active before the report even
// arrives — render() calls obApplyFilter() again once rows exist, so the prefilter still applies then.
var elPre=document.getElementById('ob-prefilter'),elPreDom=document.getElementById('ob-prefilter-dom'),elPreClear=document.getElementById('ob-prefilter-clear');
var OB_PRE=document.body.getAttribute('data-prefilter');
if(OB_PRE&&elFilter){elFilter.value=OB_PRE;obApplyFilter();
if(elPreDom)elPreDom.textContent=OB_PRE;
if(elPre)elPre.hidden=false}
if(elPreClear)elPreClear.addEventListener('click',function(ev){ev.preventDefault();elFilter.value='';obApplyFilter();if(elPre)elPre.hidden=true});
// ── one account's detail panel ─────────────────────────────────────────────────────────────────────
// A second question over the SAME bridge, tagged differently on purpose: the links report and one
// account's report are different documents, and a mis-tagged reply that redrew the table from an account
// report would empty the page.
var elPanel=document.getElementById('ob-panel');
// WHICH account the panel is showing, as the SELECTOR it was opened by: {domain} for a row the operator
// clicked, {account} for a site row, whose domain is shared with other accounts and so cannot name it.
// Kept as the selector rather than as a resolved account number because a Refresh has to re-ask the same
// question, and because the domain in it is the one the operator's confirmations should keep naming.
var OB_PANEL_SEL=null;
// The report the panel last drew. A single-row swap after a save has to re-render that row from the SAME
// facts the rest of the table was drawn from: rep.detail is what names an item, and canWrite +
// baselinesEnabled are what decide whether the row carries controls at all.
var OB_LAST_ACCOUNT=null;
// Which item lists are open, by group — read only by the swap, so a list the reader opened is still open
// after their accept lands. A repaint draws every list closed, so this is cleared with the panel rather
// than carried across one. Read for an EXACT true: a group name comes out of the rulebook, and a bare
// object answers truthily for constructor, toString and the rest of Object.prototype.
var OB_OPEN={};
// The last plan chosen on each group, this page-load — read by the write bundle's accept path. Declared
// HERE, beside OB_OPEN, because it has the same lifetime: it is a convenience about the panel on screen,
// and carrying one account's plan choice onto the next account's identically-named group would default
// the picker to something the operator never said. Object.create(null) for the reason every other
// report-data-keyed map on this page uses one: a group name comes out of the rulebook, and "__proto__"
// on a plain object is a setter that swallows the write.
var OB_OFFER_LAST=Object.create(null);
// The header Refresh/Verify re-read the LINKS report, which is the list view. While an account panel is
// open they are hidden — the panel carries its own Refresh — so a reader cannot stack the two views.
function obHeadActions(show){var h=document.getElementById('ob-head-actions');if(h)h.hidden=!show}
function obPanelHide(){if(elPanel){elPanel.hidden=true;elPanel.innerHTML=''}if(elNormal)elNormal.hidden=false;obHeadActions(true);OB_PANEL_SEL=null;OB_LAST_ACCOUNT=null;OB_OPEN={};OB_OFFER_LAST=Object.create(null)}
function obPanelShow(html){if(!elPanel)return;elPanel.innerHTML=html;elPanel.hidden=false;if(elNormal)elNormal.hidden=true;obHeadActions(false);OB_OPEN={};OB_OFFER_LAST=Object.create(null)}
// Both rows are found by WALKING and comparing the attribute, never by building a selector out of the
// group name: a group is rulebook-supplied text, and a quote or a bracket in one makes a selector that
// throws or, worse, matches a different row.
function obGroupRow(g){var rs=elPanel?elPanel.querySelectorAll('tr[data-group]'):[];
for(var i=0;i<rs.length;i++)if(rs[i].getAttribute('data-group')===g)return rs[i];
return null}
function obItemsRow(g){var rs=elPanel?elPanel.querySelectorAll('tr.items'):[];
for(var i=0;i<rs.length;i++)if(rs[i].getAttribute('data-items-for')===g)return rs[i];
return null}
// The kept report is updated in place too. A later full repaint — a Refresh, or the fallback below —
// renders rep.comparison.rows, and leaving the pre-save row sitting there would redraw exactly the state
// the save had just changed.
function obRowStore(row){var c=OB_LAST_ACCOUNT&&OB_LAST_ACCOUNT.comparison,rs=c?c.rows:null,i;
if(!rs)return;
for(i=0;i<rs.length;i++)if(rs[i].group===row.group){rs[i]=row;return}}
// A save answers with the one row it changed, so that row is re-rendered and swapped for the pair on
// screen: the group row and, when it has one, its item list. Re-asking for the whole account instead
// would repaint the table, closing every list the reader had opened and losing their place on it.
// outerHTML parses in the row's own parent, so one obCompRow string can produce both nodes — the same
// function, and therefore the same markup, a full paint would have produced for that row.
function obSwapRow(row){if(!row||!row.group||!OB_LAST_ACCOUNT||!elPanel)return false;
var g=row.group,tr=obGroupRow(g);if(!tr||!tr.parentNode)return false;
var old=obItemsRow(g);if(old&&old.parentNode)old.parentNode.removeChild(old);
tr.outerHTML=obCompRow(row,OB_LAST_ACCOUNT,obCompCols(OB_LAST_ACCOUNT));
if(OB_OPEN[g]===true){var it=obItemsRow(g);if(it)it.hidden=false;
var ng=obGroupRow(g),btn=ng?ng.querySelector('button[data-act="toggle-items"]'):null;
if(btn)btn.setAttribute('aria-expanded','true')}
obRowStore(row);
return true}
function askAccount(payload){RID++;PEND[RID]='account';
// Dropped for the reason the write bundle's senders drop theirs: nothing was sent, so nothing will answer.
if(!HOSTED){delete PEND[RID];deliverAccount({unavailable:'This page is not running inside the portal, so it cannot reach this deployment.'});return}
window.parent.postMessage({ ${SPK_BRIDGE.tag}: '${SPK_BRIDGE.accountRequest}', ${SPK_BRIDGE.idKey}: RID, ${SPK_BRIDGE.accountKey}: payload },'*')}
// EXACTLY ONE selector reaches the request: the route refuses two subjects at once, and ranking them
// would make which one wins a thing to remember rather than to read.
function obOpenAccount(sel,refresh){OB_PANEL_SEL=sel;
obBusy(true,refresh?'Re-reading this account…':'Loading this account…');
var q=sel.account?{account:sel.account}:{domain:sel.domain};if(refresh)q.refresh=true;
askAccount(q)}
// A repaint of the WHOLE panel that keeps the reader's place: obPanelShow draws every item list closed,
// so the lists that were open are re-opened afterwards. Used where one row is not enough — an assignment
// moves an item between accounts, and every count on the page moves with it.
function obRepaint(report){var open=OB_OPEN,g;
OB_LAST_ACCOUNT=report;
obPanelShow(obPanel(report));
for(g in open){if(!Object.prototype.hasOwnProperty.call(open,g)||open[g]!==true)continue;
var it=obItemsRow(g);if(!it)continue;
it.hidden=false;OB_OPEN[g]=true;
var tr=obGroupRow(g),btn=tr?tr.querySelector('button[data-act="toggle-items"]'):null;
if(btn)btn.setAttribute('aria-expanded','true')}}
// A failed load is NOT an empty panel: an empty comparison table reads as "this account is billed for
// nothing", which is a confident answer to a question that was never successfully asked.
function obPanelFail(why){OB_LAST_ACCOUNT=null;obPanelShow('<section class="panel"><header class="panel-head"><button type="button" class="btn" data-act="back">Back to the list</button><h2>This account did not load</h2></header><div class="fail"><b>Nothing here is a report about this account.</b><div>'+esc(why)+'</div></div></section>')}
function deliverAccount(v){obBusy(false);
if(v.unavailable){obPanelFail(v.unavailable);return}
if(!v.report){obPanelFail('The reply carried no report.');return}
// A reply for a panel the reader has already moved off. The id gate above only says this reply was asked
// for at some point, not that it is about what is on screen NOW — two opens can be in flight, and the
// slower one would repaint the panel with the account the reader just left. Checked against the SELECTOR,
// because that is what the open panel IS: an account selector must be answered by that account, a domain
// selector by a report that holds that domain.
var psel=OB_PANEL_SEL;
if(psel&&psel.account&&v.report.accountNumber!==psel.account)return;
if(psel&&psel.domain&&(v.report.domains||[]).indexOf(psel.domain)<0)return;
OB_LAST_ACCOUNT=v.report;
obPanelShow(obPanel(v.report))}
// A recorded baseline answers with the ROW it changed — recomputed by the server, because which verdict
// a row now carries is the rule engine's to decide and redrawing it here would be the page guessing at
// that answer. The row is swapped in place, so the reader keeps their scroll position and their open
// item lists. Without one — a reply that carried no row — it falls back to RE-ASKING for the account.
// Not a refresh either way: the design merges the new baseline into the cached snapshot precisely so an
// accept costs one D1 read, not a full NetSapiens re-fetch. Only "refresh account" bypasses the cache.
// The failure text can echo a key the caller sent (a 409 names the item it collided on), so it is
// escaped: this string goes into innerHTML.
function obBaselineDone(v,forAccount){obBusy(false);
// The reader can have moved to another account, or closed the panel, while the write was in flight.
// Swapping a row computed for one account into another account's table would be a lie the page told
// itself, and a toast naming neither would be one it told the reader — so a late reply is dropped. By
// ACCOUNT, not by domain: two panels can be opened by the same domain and be about different accounts.
if(forAccount&&(!OB_LAST_ACCOUNT||forAccount!==OB_LAST_ACCOUNT.accountNumber))return;
if(v.unavailable){obToastShow('<div class="res bad"><b>The baseline was not recorded</b><div>'+esc(v.unavailable)+'</div></div>',false);return}
if(v.row&&obSwapRow(v.row))return;
if(OB_PANEL_SEL)obOpenAccount(OB_PANEL_SEL,false)}
window.addEventListener('message',function(e){var m=e.data;if(!m)return;
var t=m.${SPK_BRIDGE.tag};
if(t!=='${SPK_BRIDGE.accountResponse}'&&t!=='${SPK_BRIDGE.baselineResponse}')return;
var id=m.${SPK_BRIDGE.idKey};
if(id!=null){if(!PEND[id])return;delete PEND[id]}
if(t==='${SPK_BRIDGE.accountResponse}'){deliverAccount(m.${SPK_BRIDGE.accountKey}||{});return}
var forAcct=null;if(id!=null){forAcct=OB_BASELINE_FOR[id];delete OB_BASELINE_FOR[id]}
obBaselineDone(m.${SPK_BRIDGE.baselineKey}||{},forAcct)});
document.addEventListener('click',function(ev){var t=ev.target&&ev.target.closest?ev.target.closest('[data-open-domain],[data-open-account],[data-act="back"],[data-act="refresh-account"],[data-act="toggle-items"]'):null;
if(!t)return;
// A site row names its ACCOUNT: its domain is shared, and ?domain= on a shared domain is refused.
var oa=t.getAttribute('data-open-account');
if(oa){obOpenAccount({account:oa},false);return}
var od=t.getAttribute('data-open-domain');
if(od){obOpenAccount({domain:od},false);return}
var act=t.getAttribute('data-act');
if(act==='back'){obPanelHide();return}
// Opening an item list is READING, so it lives here rather than in the write half: a reader who can
// accept nothing still has to be able to see what a count is made of. aria-expanded moves with the row,
// because a list that opens without it leaves a screen reader saying "collapsed".
if(act==='toggle-items'){var g=t.getAttribute('data-group'),it=obItemsRow(g);
if(!it)return;
it.hidden=!it.hidden;OB_OPEN[g]=!it.hidden;
t.setAttribute('aria-expanded',it.hidden?'false':'true');return}
if(OB_PANEL_SEL)obOpenAccount(OB_PANEL_SEL,true)});
${doc.canWrite ? WRITE_JS : ''}
obLoad(false,'quick');
})();`;
}

// ── the document ────────────────────────────────────────────────────────────────────────────────────

export function onebillHtml(doc: OnebillDoc): string {
  const write = doc.canWrite;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OneBill Integration</title>
<style>${STYLE}</style></head><body${doc.prefilter ? ` data-prefilter="${esc(doc.prefilter)}"` : ''}><main>
<header class="ob-head">
  <div class="eyebrow">Integration</div>
  <div class="title-row"><h1>OneBill links</h1><span class="ver">v${esc(doc.version)}</span><span class="grow"></span>
    <span id="ob-head-actions"><button id="ob-refresh" class="btn primary" type="button">Refresh</button>
    <button id="ob-verify" class="btn" type="button">Refresh and fully verify</button></span></div>
  <div class="meta"><span id="ob-gen">Loading…</span><span class="sep">·</span><span id="ob-req"></span>
    <span id="ob-say"></span></div>
</header>
${write ? '' : `<p class="ronote">This page is read-only for you. Linking a domain, removing a link and applying a selection all need the <code>onebill.write</code> key.</p>`}
<div id="ob-setup" hidden></div>
<div id="ob-normal">
<p class="legend"><span class="chip chip-linked">linked</span> one OneBill account
  <span class="chip chip-unlinked">unlinked</span> none yet
  <span class="chip chip-conflict">conflict</span> two or more claim it
  <span class="chip chip-split">split by site</span> linked per site
  <span class="chip chip-stale">stale</span> points at nothing here</p>
<div class="bar">
  <input id="ob-filter" type="search" placeholder="Filter domain, site, or account">
  <span id="ob-filter-count" class="dim"></span>
  <span id="ob-prefilter" class="dim" hidden>Showing <b id="ob-prefilter-dom"></b> — <a href="#" id="ob-prefilter-clear">Show all</a></span>
  ${write ? `<span class="grow"></span><button id="ob-apply" class="btn primary" type="button">Apply selected</button>
  <button id="ob-preview" class="btn" type="button">Preview selected</button>
  <span class="dim">Rows with a candidate are pre-selected. Untick anything you do not want written.</span>` : ''}
</div>
<div class="scroll"><table class="ob">
<thead><tr><th id="ob-sort-dom-th"><button type="button" id="ob-sort-dom-btn" class="thbtn">Domain / Site <span class="sortglyph" aria-hidden="true"></span></button></th><th id="ob-sort-state-th" aria-sort="ascending" data-sort="asc"><button type="button" id="ob-sort-state-btn" class="thbtn">State <span class="sortglyph" aria-hidden="true">▲</span></button></th><th>OneBill account</th><th>Candidate</th>${write ? '<th>Action</th>' : ''}</tr></thead>
<tbody id="ob-rows"><tr class="empty"><td colspan="${write ? 5 : 4}">Loading…</td></tr></tbody>
</table></div>
<div id="ob-results"></div>
<div id="ob-failures"></div>
<h2>Links pointing somewhere else</h2>
<p class="dim">These OneBill accounts are linked to a domain or site that NetSapiens does not have under that name.
  Usually the site was mistyped or renamed; sometimes the domain was deleted. Read the note on each one before removing a link.</p>
<div id="ob-foreign"><p class="dim">Loading…</p></div>
<div id="ob-decom"></div>
<details><summary>Usage subscriptions worth a look</summary><div id="ob-usage"></div></details>
</div>
<section id="ob-panel" hidden></section>
</main>
<div id="ob-toast" role="status" aria-live="polite" hidden></div>
<div id="ob-busy" class="busy" hidden><div class="busy-box"><div class="spinner" aria-hidden="true"></div>
  <div id="ob-busy-text">Loading… this can take a little while.</div></div></div>
<script>${pageScript(doc)}</script>
</body></html>`;
}
