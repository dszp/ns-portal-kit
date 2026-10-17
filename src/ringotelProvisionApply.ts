/**
 * Ringotel provisioning — the I/O half. Three catalog reads, the fresh org+connection snapshots the
 * page and the write steps both work from, and the only place this feature writes to Ringotel.
 *
 * The split from `ringotelProvision.ts` is the point: everything that decides lives there and is pure,
 * everything that reads or writes lives here and decides nothing it can borrow. `applyStep('signin')`
 * calls the planner's own `signinMatches` for its noop verdict rather than re-deriving one, because a
 * planner that says "ok" and an apply that rewrites anyway is a button that never settles.
 *
 * NOTHING here reads a cache. A write decided from an hour-old index is a write decided from a fleet
 * that may already have the org, the connection, or the label this one is about to claim — so both
 * snapshot functions dig live and the caller caches the RESULT (the fleet route does, for its list),
 * never the input to a write.
 *
 * Spec: docs/superpowers/specs/2026-09-14-ringotel-integration-page-design.md
 */
import {
  buildOrgBranchIndex,
  type RingotelReadClient,
  type Organization,
  type Branch,
  type Rec,
  type OrgBranchEntry,
  type CreateOrgInput,
  type UpdateOrgInput,
  type CreateBranchInput,
} from '@dszp/ringotel-lib';
import { matchOrgsForDomain } from './ringotel.js';
import { deriveOrgLabel, labelMatches, labelProblem, signinMatches, type ProvisionConfig } from './ringotelProvision.js';

/** The read surface this module needs — the structural subset of `RingotelReadClient`, so a test can
 *  supply five functions and the worker can hand over the real client unchanged. */
export interface ProvisionReader {
  getOrganizations(): Promise<Organization[]>;
  getBranches(orgid: string): Promise<Branch[]>;
  getTemplates(): Promise<Rec[]>;
  getPackages(): Promise<Rec[]>;
  getRegions(): Promise<Rec[]>;
}

/** The write surface this feature is allowed to use — three methods of `RingotelWriteClient` and no
 *  more. A holder of this cannot delete an org, move a user or touch a branch that already exists. */
export interface ProvisionWriter {
  createOrganization(i: CreateOrgInput): Promise<Organization>;
  updateOrganization(id: string, c: UpdateOrgInput): Promise<Organization>;
  createBranch(i: CreateBranchInput): Promise<Branch>;
}

/** A refusal this feature's own rules produced, carrying the status the route should answer with.
 *  409 = the world already disagrees with the request; 422 = the request cannot be carried out as
 *  stated; 403 = the caller may not. Never a bare `Error` for any of the three — a bare one reaches
 *  the route as a 500 and tells the operator nothing they can act on. */
export class ProvisionRefused extends Error {
  constructor(m: string, public readonly status: 403 | 409 | 422) { super(m); this.name = 'ProvisionRefused'; }
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────

/** One connection template as this feature reads it.
 *
 *  `created` is the Ringotel panel's own ms-epoch stamp. A template's settings are immutable there, so it
 *  is effectively "when this template last said what it says", which is the only ordering an operator
 *  choosing between two of them can use. `hasProvision` is derived from `params` by
 *  {@link carriesProvision} — the SAME predicate `applyConnector` refuses on, so a picker cannot flag a
 *  template usable that the create then declines. `params` rides along because a create is built from it.
 *
 *  `hasCountry` is the SECOND half of "can a connection be built from this", and it is a flag of its own
 *  rather than folded into `hasProvision` because the two say different things to the reader: one
 *  template carries no PBX settings, the other carries no dialling country, and an option labelled with
 *  the wrong reason sends somebody to fix the wrong field in the vendor panel. Both come from the SAME
 *  predicates `resolveTemplateChoice` refuses on. */
export interface CatalogTemplate {
  id: string;
  name: string;
  created: number | null;
  hasProvision: boolean;
  hasCountry: boolean;
  params: Record<string, unknown>;
}

export interface Catalog {
  /** The CONFIGURED standard — what `RINGOTEL_CONNECTION_TEMPLATE` names, resolved to exactly one record.
   *  The audit's yardstick, and what a create uses when the operator chooses nothing. */
  template: { id: string; name: string; params: Record<string, unknown> } | null;
  templateProblem: string | null;
  /** EVERY template in the tenant, newest first — a create may legitimately be made from one that is not
   *  the standard, and the standard is one row of this list rather than a different kind of thing. */
  templates: CatalogTemplate[];
  packages: { id: number; name: string }[];
  regions: { id: string; name: string }[];
}

const sameName = (a: unknown, b: string): boolean => String(a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/** Does this template carry a usable `provision` blob? ONE reading of it, because two would let the
 *  picker call a template usable that `applyConnector` then refuses — see both callers. */
const carriesProvision = (params: Record<string, unknown>): boolean => {
  const p = params.provision;
  return !!p && typeof p === 'object' && !Array.isArray(p);
};

/** Does this template name a dialling country? Read here once for the same reason `carriesProvision` is:
 *  the picker disables the option and `resolveTemplateChoice` refuses the create from ONE predicate.
 *
 *  ⚠️ IT USED TO DEFAULT TO 'US'. `country: String(t.params.country ?? 'US')` turned a template nobody had
 *  finished into a connection quietly dialling as American — wrong for every deployment outside the US,
 *  silent everywhere, and permanent, because this page never rewrites a connection it has created. */
const carriesCountry = (params: Record<string, unknown>): boolean => String(params.country ?? '').trim() !== '';

/** Newest first, with an undated template LAST: "newest first" has nowhere to put a record carrying no
 *  stamp, and floating it to the top would claim it is the most recent one. `sort` is stable, so rows
 *  sharing a stamp (and the undated tail) keep the order the tenant listed them in. */
const byCreatedDesc = (a: CatalogTemplate, b: CatalogTemplate): number => {
  if (a.created === b.created) return 0;
  if (a.created === null) return 1;
  if (b.created === null) return -1;
  return b.created - a.created;
};

/** The three account-level catalogs, plus the operator's named connection template resolved to exactly
 *  one record. Zero or several matches both yield `template: null` with a `templateProblem` the page
 *  renders verbatim — picking one of two templates sharing a name would deploy whichever the API listed
 *  first, and the operator would have no way to tell which connector they got.
 *
 *  A catalog row whose id is unusable is DROPPED rather than mapped: `Number(undefined)` is `NaN`, and a
 *  `packageid: NaN` reaching `createOrganization` is a silently wrong write, where a missing row is a
 *  422 naming the setting. */
export async function loadCatalog(r: ProvisionReader, cfg: ProvisionConfig): Promise<Catalog> {
  const [templates, packages, regions] = await Promise.all([r.getTemplates(), r.getPackages(), r.getRegions()]);
  const named = templates.filter((t) => sameName(t.name, cfg.templateName));
  const template = named.length === 1
    ? { id: String(named[0]!.id), name: String(named[0]!.name ?? cfg.templateName), params: (named[0]!.params ?? {}) as Record<string, unknown> }
    : null;
  const templateProblem = named.length === 1 ? null
    : named.length === 0
      ? `No connection template named "${cfg.templateName}" exists in this ${cfg.appLabel} tenant. RINGOTEL_CONNECTION_TEMPLATE must name one exactly.`
      : `More than one connection template is named "${cfg.templateName}". Rename one in the ${cfg.appLabel} panel so RINGOTEL_CONNECTION_TEMPLATE resolves to a single template.`;
  return {
    template,
    templateProblem,
    // A template with no NAME is dropped rather than offered: nothing could choose it (the picker would
    // draw a blank option) and no `byName` could ever resolve it, so listing it would be an option that
    // does nothing. Same reasoning as the unusable ids below.
    templates: templates
      .filter((t) => String(t.name ?? '').trim() !== '')
      .map((t) => {
        const params = (t.params ?? {}) as Record<string, unknown>;
        return {
          id: String(t.id ?? ''),
          name: String(t.name),
          created: Number.isFinite(Number(t.created)) && t.created !== null && t.created !== '' ? Number(t.created) : null,
          hasProvision: carriesProvision(params),
          hasCountry: carriesCountry(params),
          params,
        };
      })
      .sort(byCreatedDesc),
    packages: packages
      .filter((p) => p.id !== undefined && p.id !== null && Number.isFinite(Number(p.id)))
      .map((p) => ({ id: Number(p.id), name: String(p.name ?? '') })),
    regions: regions
      .filter((x) => x.id !== undefined && x.id !== null && String(x.id) !== '')
      .map((x) => ({ id: String(x.id), name: String(x.name ?? '') })),
  };
}

/**
 * The single fleet dig: `buildOrgBranchIndex`'s own reads, captured on the way past.
 *
 * The library owns what an index entry is, so the index must come from the library — but its raw inputs
 * are exactly what the page and the write steps need next (`packageid` and `params` live on the org,
 * `provision` on the branch, and the projection carries neither). Reading them again would double an
 * already expensive dig to 2 + 2N calls and, worse, would read a fleet that may have moved between the
 * two passes. So the reader is wrapped, not re-called: one `getOrganizations`, one `getBranches` per
 * org, and both results kept.
 *
 * The cast is the price of a structural reader: `buildOrgBranchIndex` is typed against the concrete
 * `RingotelReadClient` class (private field and all), while it only ever calls these two methods.
 */
async function digFleet(r: ProvisionReader): Promise<FleetSnapshot> {
  let orgs: Organization[] = [];
  const branchesByOrg: Record<string, Branch[]> = {};
  const capture = {
    async getOrganizations(): Promise<Organization[]> { orgs = await r.getOrganizations(); return orgs; },
    async getBranches(orgid: string): Promise<Branch[]> {
      const b = await r.getBranches(orgid);
      branchesByOrg[orgid] = b;
      return b;
    },
  };
  const index = await buildOrgBranchIndex(capture as unknown as RingotelReadClient);
  return { orgs, branchesByOrg, index };
}

export interface DomainSnapshot {
  /** Every organization in the tenant — the roster a label-collision check needs, and the only honest
   *  basis for one: a cached roster is a roster that may not yet know about the label being claimed. */
  orgs: Organization[];
  /** The raw organization bound to this domain, or null when zero or several are. */
  org: Organization | null;
  /** DISTINCT organizations claiming this domain. Ambiguity is about organizations, not connections —
   *  one org serving a domain from several connections is a supported topology; two orgs claiming it is
   *  a misconfiguration nothing can resolve. */
  orgCount: number;
  /** The raw branches of the matched org that sit AT THIS ADDRESS — never its other connections. */
  branches: Branch[];
  /**
   * Every organization in the tenant with NO connection at all.
   *
   * An organization is only reachable BY ADDRESS through a connection, so one with none is invisible to
   * the index and to `matchOrgsForDomain` — and this feature is the one thing that creates such a record:
   * an enable whose `org` step succeeded and whose `connector` step then failed leaves exactly one. The
   * set is derived here, from the dig this snapshot was already built on, so the adoption rule below and
   * the create's own name check in `applyOrg` read one list rather than two.
   */
  orphans: Organization[];
  /**
   * `org` was ADOPTED rather than matched: it answers to no address, and this domain claimed it because
   * it holds a domain name this domain could be building under. Additive, and read only by sentences —
   * nothing gates on it — so a caller that has never heard of it behaves exactly as it did before.
   */
  adopted?: boolean;
  /**
   * WHAT `orgCount` COUNTED, because two of one kind is a different sentence from two of the other:
   *   - `'address'` — organizations whose connection carries this domain's address. "N organizations
   *     claim this domain" is true of these.
   *   - `'name'` — nothing answers to the address at all, so the count is connection-less organizations
   *     holding a domain name this domain could claim (see {@link adoptOrphan}). Telling an operator
   *     that two of THESE "claim this domain" would send them looking for connections that do not exist.
   */
  orgCountBy: 'address' | 'name';
}

/**
 * FRESH state for one NS domain: the live index, the match, and the raw records behind it.
 *
 * Matching goes through the library (`buildOrgBranchIndex` → `matchOrgsForDomain`), which is the one
 * definition of what "the same address" means — trailing `:port` and case included — and the one place
 * `RINGOTEL_OVERRIDES` keeps its real meaning, a REPLACEMENT ADDRESS for the audited domains whose
 * branch address is not their NS domain.
 */
export async function loadDomainSnapshot(r: ProvisionReader, domain: string, overrides: Record<string, string>, chosenLabel?: string): Promise<DomainSnapshot> {
  return snapshotForDomain(await digFleet(r), domain, overrides, chosenLabel);
}

/**
 * The same reading of one domain, over a dig the caller ALREADY holds.
 *
 * The fleet audit digs once and then asks this question of every domain in the caller's set; a per-domain
 * `loadDomainSnapshot` would re-dig the whole tenant per row. Splitting the derivation out rather than
 * copying those six lines into the route is what keeps a fleet ROW and the CHECKLIST behind it from
 * disagreeing about which organization serves a domain — they now resolve it through one function.
 *
 * ⚠️ A WRITE IS NEVER DECIDED FROM A CACHED DIG. The fleet route caches its `FleetSnapshot` for the list;
 * every apply path calls `loadDomainSnapshot`, which digs live.
 */
export function snapshotForDomain(dig: FleetSnapshot, domain: string, overrides: Record<string, string>, chosenLabel?: string): DomainSnapshot {
  const { orgs, branchesByOrg, index } = dig;
  // From the dig already in hand — `digFleet` calls `getBranches` for every organization, so an empty
  // list here is the tenant's answer and not a gap in the read.
  const orphans = orgs.filter((o) => (branchesByOrg[String(o.id)] ?? []).length === 0);
  const matches = matchOrgsForDomain(index, domain, overrides);
  const orgids = [...new Set(matches.map((m) => m.orgid))];
  if (orgids.length === 0) return adoptOrphan(orgs, orphans, domain, chosenLabel);
  if (orgids.length !== 1) return { orgs, orphans, org: null, orgCount: orgids.length, orgCountBy: 'address', branches: [] };
  const orgid = orgids[0]!;
  const org = orgs.find((o) => String(o.id) === orgid) ?? null;
  const here = new Set(matches.map((m) => m.branchid));
  return { orgs, orphans, org, orgCount: 1, orgCountBy: 'address', branches: (branchesByOrg[orgid] ?? []).filter((b) => here.has(String(b.id))) };
}

/**
 * NO CONNECTION ANSWERS TO THIS ADDRESS — so look for the organization an earlier run of THIS feature
 * left behind, and claim it.
 *
 * The index is per-branch. An enable whose `org` step succeeded and whose `connector` step then failed
 * leaves an organization that matches nothing, forever: the next run sees no organization, offers to
 * create one, and `applyOrg` refuses it because the derived domain name is already taken. That refusal
 * told the operator to "run the connection step instead", which refused in its turn — the organization it
 * would have created the connection under was invisible to this layer. A dead end, on the page's main
 * path, reachable by one failed API call.
 *
 * The handle is the DOMAIN NAME — either of the two this domain could legitimately be building under:
 *
 *   - THE DERIVED one, which this feature computes from the NS domain with no room for choice; and
 *   - THE ONE THE OPERATOR TYPED on this request, when they typed one. A first run under a custom label
 *     leaves an organization whose domain name this domain does not derive, so the derived handle cannot
 *     reach it — and the retry, whose label input the page has prefilled with that very label, would be
 *     told to "set the domain name to" the value it just submitted. That was a second dead end behind
 *     the first, and it is why `chosenLabel` reaches this far down.
 *
 * An organization holding either name with no connection at all is the record this page was in the
 * middle of building. Adopting it makes `org` a noop and `connector` a create — the sequence resuming
 * exactly where it stopped.
 *
 * ⚠️ WHAT IT COSTS WHEN IT IS WRONG, named rather than hedged:
 *   - A HAND-MADE organization under one of those names with no connection is adopted too. For the
 *     derived name that is the right outcome for this domain anyway. For a TYPED one it is the same
 *     trade with more intent behind it: the operator asked for that exact name on this request, where
 *     the old behaviour refused it as taken and left the record stranded. What it gives up is the
 *     refusal that used to catch a typo landing on somebody else's connection-less organization.
 *   - TWO NS DOMAINS DERIVING ONE LABEL (`acme.12345.service` and `acme.67890.service`) both claim the
 *     same orphan, so the second would create ITS connection under the first's half-built organization.
 *     Narrow — it needs the first domain's connector to have failed and nobody to have finished it — and
 *     recoverable by deleting that connection, where the state it replaces (a permanent dead end) is not.
 *     Nothing at this layer can tell the two apart: a snapshot is asked about one domain at a time.
 *
 * The two handles are ONE candidate set, not a preference order. Two different connection-less
 * organizations, one under each name, is a tenant nothing here can choose between — so the count stands
 * and produces a refusal, exactly as two organizations matching by address always have.
 */
function adoptOrphan(orgs: Organization[], orphans: Organization[], domain: string, chosenLabel?: string): DomainSnapshot {
  const wanted = [deriveOrgLabel(domain), ((chosenLabel ?? '').trim() || null)].filter((x): x is string => !!x);
  const claim = orphans.filter((o) => wanted.some((w) => labelMatches(String(o.domain ?? ''), w)));
  if (claim.length === 1) return { orgs, orphans, org: claim[0]!, orgCount: 1, orgCountBy: 'name', branches: [], adopted: true };
  // `orgCountBy: 'name'` even at zero: nothing answers to this address, so whatever the count says, it is
  // a statement about NAMES. It is what stops the refusals below from telling an operator that N
  // organizations answer to an address none of them has.
  return { orgs, orphans, org: null, orgCount: claim.length, orgCountBy: 'name', branches: [] };
}

/** The connection-less organization a create would collide with BY NAME — the same trimmed,
 *  case-insensitive reading every other catalog name on this page is matched by. Exported so the route's
 *  report and `applyOrg`'s refusal find the same record: a page that prefilled one label while the create
 *  refused for another would be worse than the refusal alone. */
export const orphanNamed = (orphans: Organization[], name: string): Organization | undefined =>
  orphans.find((o) => sameName(o.name, name));

/** One fleet dig and everything derivable from it: every organization, each one's connections, and the
 *  library's projected index over the two. */
export interface FleetSnapshot { orgs: Organization[]; branchesByOrg: Record<string, Branch[]>; index: OrgBranchEntry[] }

/** One fresh dig for the whole fleet (1 + N calls) — the fleet audit reads every org's package, params
 *  and connector from it. The fleet ROUTE caches this result briefly under a provision-scoped key; no
 *  write step is ever handed a cached one. */
export async function loadFleetSnapshot(r: ProvisionReader): Promise<FleetSnapshot> {
  return digFleet(r);
}

// ── Writes ─────────────────────────────────────────────────────────────────────────────────────────

/** The steps that write to Ringotel. `index` and `reconcile` are the worker's own (a cache drop and the
 *  directory reconcile), and `package` is not a step at all: a package is set ON CREATE and a live org
 *  on a different one is a finding, not a fix — Pro on a customer who bought Pro is deliberate. */
export type ApplyStep = 'org' | 'signin' | 'connector';
export interface ApplyInput {
  domain: string;
  cfg: ProvisionConfig;
  catalog: Catalog;
  snap: DomainSnapshot;
  /** `template` is a template NAME, create-only like `pkg` and `label`: it decides what a connection is
   *  built FROM, and nothing here ever rewrites a connection that exists. */
  choice: { pkg?: string; signin?: 'sso' | 'credentials'; label?: string; orgName?: string; template?: string };
}
/** What one step did. `template` is set ONLY when a connection was created from a template other than the
 *  configured standard — Ringotel keeps no record of which template a connection came from, so this line
 *  is the one place that fact is ever said. The standard needs no saying: the page already names it. */
export interface ApplyOutcome { step: ApplyStep; action: 'created' | 'updated' | 'noop'; orgid?: string; branchid?: string; template?: string }

/** Control characters, written as escapes on purpose: a literal one in source is invisible to `grep`
 *  and to the leak guard's manual path. */
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

/** Catalog lookup by display name — the same reading as the planner's `packageIdOf` in
 *  `ringotelProvision.ts`, and it must stay that way: the planner deciding a package resolves while the
 *  create refuses it (or the reverse) is a row that offers a button the write then declines. Exported for
 *  the provisioning probe, which asks the same question before any of them do — a probe with its own copy
 *  of this rule could report a package resolved that the create then refuses, which is the failure the
 *  probe exists to catch. */
export const byName = <T extends { name: string }>(rows: T[], name: string): T | undefined => rows.find((x) => sameName(x.name, name));

/** The label a create will claim: the operator's edit when they made a real one, else the derivation —
 *  the planner's `chosenLabel` rule, so the label the page says it will create is the label created.
 *  Normalised before it is CHECKED so that the string `labelProblem` approved is the string written; a
 *  label validated in one case and written in another is a label nothing validated. */
const labelFor = (i: ApplyInput): string => ((i.choice.label ?? '').trim() || deriveOrgLabel(i.domain)).toLowerCase();

/** How several organizations came to be in the way — the fact `snap.orgCountBy` carries, in a clause the
 *  refusals below build a sentence around. Two organizations answering to this address and two holding a
 *  name this domain could claim are different tenants to go and fix, and a reader sent looking for
 *  connections that do not exist has been told the wrong one. */
const manyOrgs = (i: ApplyInput): string =>
  i.snap.orgCountBy === 'name'
    ? `${i.snap.orgCount} ${i.cfg.appLabel} organizations without a connection hold this domain's name`
    : `${i.snap.orgCount} ${i.cfg.appLabel} organizations claim this domain`;

/** The single organization a step acts on, or the refusal that says why there isn't one. Gated on the
 *  match COUNT, never on `snap.org` alone: zero and several are different failures, and a domain two
 *  organizations claim must never reach a write that would pick one of them by accident. */
function requireOrg(i: ApplyInput, noun: string): Organization {
  if (i.snap.orgCount > 1) throw new ProvisionRefused(`${manyOrgs(i)}, so there is no single organization whose ${noun} could be set. Resolve that in the ${i.cfg.appLabel} panel first.`, 409);
  if (i.snap.orgCount < 1 || !i.snap.org) throw new ProvisionRefused(`The organization must exist before its ${noun} can be created.`, 409);
  return i.snap.org;
}

async function applyOrg(w: ProvisionWriter, i: ApplyInput): Promise<ApplyOutcome> {
  // Gated on the COUNT, not on `snap.org`. The two agree today, but "an org matched and its raw record
  // was not in the roster" would leave `org` null with a match standing — and a create refused only by
  // `snap.org` would then add a second organization to a domain that already has one.
  if (i.snap.orgCount > 0) {
    throw new ProvisionRefused(i.snap.orgCount > 1
      ? `${manyOrgs(i)}. Resolve that in the ${i.cfg.appLabel} panel before creating anything.`
      // An ADOPTED organization is one an earlier run created and never finished (see `adoptOrphan`), so
      // the sentence says that rather than "one already matches this domain" — which reads, to the person
      // who just pressed Create, as a page arguing with itself about a domain it has just called empty.
      : i.snap.adopted
        ? `An earlier run already created a ${i.cfg.appLabel} organization for this domain under the domain name "${String(i.snap.org?.domain ?? deriveOrgLabel(i.domain))}"; it has no connection yet. Run the connection step to finish it rather than creating a second organization.`
        : `A ${i.cfg.appLabel} organization already matches this domain. Creating a second one would leave the domain ambiguous.`, 409);
  }

  // The display name is free text an operator typed. It is never the label — only what the panel shows.
  let name: string | undefined;
  if (i.choice.orgName !== undefined) {
    name = i.choice.orgName.trim();
    if (name.length < 1 || name.length > 64) throw new ProvisionRefused('The organization name must be 1–64 characters.', 422);
    if (CONTROL_RE.test(name)) throw new ProvisionRefused('The organization name may not contain control characters.', 422);
  }

  const label = labelFor(i);
  // The derived domain name is already taken, and the snapshot did NOT adopt its holder — so that holder
  // has connections of its own at other addresses and belongs to somebody else. (An unfinished run of
  // this domain has no connection at all and is adopted upstream, which is why this is no longer the
  // place that tells an operator to run the connection step.) Refused whatever label was chosen:
  // creating a second organization under a different name would leave the domain with two.
  const derived = deriveOrgLabel(i.domain);
  const holder = i.snap.orgs.find((o) => labelMatches(String(o.domain ?? ''), derived));
  if (holder) {
    throw new ProvisionRefused(`A ${i.cfg.appLabel} organization already holds the domain name "${derived}" that this domain derives, and it has connections of its own — so it is not an unfinished setup of this domain. Resolve that in the ${i.cfg.appLabel} panel; creating this one under a different domain name would leave two organizations for this domain.`, 422);
  }
  // ⚠️ THE SAME UNFINISHED RUN, REACHED THE OTHER WAY. A first attempt under a CUSTOM label leaves an
  // organization whose domain name this one does not derive, so neither adoption nor the check above sees
  // it — and the retry, whose label input has gone back to the derivation, would create a second
  // organization for the same customer. The name is the only handle left: an organization with no
  // connection, named what this create is about to name one, is that first attempt. Refused with its
  // domain name, because typing that label is what resumes it.
  // ⚠️ ONLY WHERE THE TYPED LABEL NAMES NO UNFINISHED RECORD. A label that DOES name one was adopted
  // upstream and never reaches here — but the guard is stated rather than assumed, because a refusal
  // telling an operator to type the value they just typed is the dead end this whole rule exists to end.
  const resuming = i.snap.orphans.some((o) => labelMatches(String(o.domain ?? ''), label));
  if (!labelMatches(label, derived) && !resuming) {
    const twin = orphanNamed(i.snap.orphans, name ?? label);
    if (twin) {
      throw new ProvisionRefused(`A ${i.cfg.appLabel} organization named "${name ?? label}" already exists with no connection, under the ${i.cfg.appLabel} domain name "${String(twin.domain ?? '')}". Set the domain name to "${String(twin.domain ?? '')}" and run this again to finish that one rather than creating a second organization.`, 422);
    }
  }
  // Checked against the FRESH roster from this snapshot — a cached one cannot know about a label
  // claimed since it was written, and a collision is the one thing that makes SSO sign-in ambiguous.
  const problem = labelProblem(label, i.snap.orgs.map((o) => String(o.domain ?? '')), i.cfg.appLabel);
  if (problem) throw new ProvisionRefused(`The ${i.cfg.appLabel} domain name "${label}" cannot be used: ${problem}`, 422);

  const region = byName(i.catalog.regions, i.cfg.region);
  if (!region) throw new ProvisionRefused(`RINGOTEL_REGION names "${i.cfg.region}", which is not a region this ${i.cfg.appLabel} account offers.`, 422);
  const wantPkg = (i.choice.pkg ?? '').trim() || i.cfg.defaultPackage;
  const pkg = byName(i.catalog.packages, wantPkg);
  if (!pkg) throw new ProvisionRefused(`"${wantPkg}" is not a licensing package this ${i.cfg.appLabel} account offers.`, 422);

  const mode = i.choice.signin ?? 'sso';
  const params: Rec = { hidePassInEmail: true, ...(mode === 'sso' && i.cfg.ssoServiceId ? { sso: i.cfg.ssoServiceId } : {}) };
  const created = await w.createOrganization({ name: name ?? label, domain: label, region: region.id, packageid: pkg.id, params });
  // Not a refusal — the write was accepted and answered with something unusable. A bare Error is right:
  // the operator cannot fix this by changing their request, and the route should surface it as a fault.
  if (!created || created.id === undefined || created.id === null || String(created.id) === '') throw new Error('createOrganization returned no organization id');
  return { step: 'org', action: 'created', orgid: String(created.id) };
}

async function applySignin(w: ProvisionWriter, i: ApplyInput): Promise<ApplyOutcome> {
  const org = requireOrg(i, 'sign-in mode');
  const orgid = String(org.id);
  // The operator does no Ringotel SSO: this deployment has no opinion about `params.sso`, so it writes
  // nothing rather than clearing a binding someone else's tooling may own.
  if (i.cfg.ssoServiceId === null) return { step: 'signin', action: 'noop', orgid };

  const mode = i.choice.signin ?? 'sso';
  const existing: Rec = org.params ?? {};
  // The PLANNER's predicate, not a second reading of it. Whatever the checklist calls `ok` here must be
  // a write this declines, or the page offers a fix that changes nothing and never settles.
  if (signinMatches(i.cfg, existing, mode)) return { step: 'signin', action: 'noop', orgid };

  // Merged, never replaced: `params` is the org's whole options blob (`emailcc` and the rest live in
  // it), and Ringotel takes it wholesale — sending only our one key would blank everything else.
  // `''` is the cleared form the live fleet and the lib's `orgSettings` both read as "no SSO".
  //
  // ⚠️ `hidePassInEmail` IS NOT WRITTEN HERE. It is a setting about welcome emails, not about how anybody
  // signs in — this step fixes the SSO binding and must not quietly change an operator's own choice about
  // password emails on an organization that already exists. The CREATE still sets it true (`applyOrg`),
  // which is a default for a record nobody had an opinion about yet, not an override of one.
  const params: Rec = { ...existing, sso: mode === 'sso' ? i.cfg.ssoServiceId : '' };
  await w.updateOrganization(orgid, { params });
  return { step: 'signin', action: 'updated', orgid };
}

async function applyConnector(w: ProvisionWriter, i: ApplyInput): Promise<ApplyOutcome> {
  const org = requireOrg(i, 'connection');
  if (i.snap.branches.length > 0) throw new ProvisionRefused('A connection already exists at this address. Updating a connection is not offered here.', 409);
  const t = resolveTemplateChoice(i.catalog, i.cfg, i.choice.template);
  const provision = t.params.provision;

  const orgid = String(org.id);
  // `address`, `domain` and `name` are the identity of the connector the template was SAVED FROM, not
  // configuration — copying any of them would point this customer's app at another customer's domain.
  // Only `country` and `provision` come from the template; the address is THIS domain, always.
  // No `?? 'US'` — `resolveTemplateChoice` has already refused a template that names no country, so the
  // value here is one somebody chose rather than one this line invented.
  const created = await w.createBranch({
    orgid,
    name: i.cfg.connectionName,
    address: i.domain,
    country: String(t.params.country),
    provision: provision as Rec,
  });
  if (!created || created.id === undefined || created.id === null || String(created.id) === '') throw new Error('createBranch returned no branch id');
  return {
    step: 'connector', action: 'created', orgid, branchid: String(created.id),
    ...(sameName(t.name, i.cfg.templateName) ? {} : { template: t.name }),
  };
}

/**
 * WHICH template a create is built from: the operator's choice when they made one, else the configured
 * standard — and every reason there is not one, as a refusal.
 *
 * Resolved against `catalog.templates` — EVERY template in the tenant — because the standard is the
 * audit's yardstick, not a bound on what may be created. The name is matched the way every other catalog
 * name on this page is matched (trimmed, case-insensitive), and the record's OWN spelling is what comes
 * back, so an outcome line names the template rather than what the operator typed.
 *
 * ⚠️ AMBIGUITY IS REFUSED, NOT RESOLVED. `byName`'s first-match would hand back whichever template the
 * API happened to list first, and the operator would have no way to tell which connector they got — the
 * exact failure `loadCatalog` refuses to make for the configured standard. Two templates sharing a name
 * is a tenant to fix, on either path.
 *
 * ⚠️ EXPORTED SO THE ROUTE CAN ASK BEFORE ITS FIRST WRITE. An `all` run applies `org`, then `signin`, then
 * `connector`; a template that cannot build a connection — unknown, ambiguous, or carrying no `provision`
 * — would refuse at the LAST of those three, leaving the domain with an organization and no connection,
 * which is a state an operator then has to finish by hand. The route calls this as a pre-flight and
 * `applyConnector` calls it again for real: one set of rules, asked twice, so the two cannot disagree.
 */
export function resolveTemplateChoice(catalog: Catalog, cfg: ProvisionConfig, choice?: string): { id: string; name: string; params: Record<string, unknown> } {
  const want = (choice ?? '').trim();
  let t: { id: string; name: string; params: Record<string, unknown> };
  if (!want) {
    if (!catalog.template) throw new ProvisionRefused(catalog.templateProblem ?? 'The connection template named by RINGOTEL_CONNECTION_TEMPLATE has not resolved, so no connection can be created.', 422);
    t = catalog.template;
  } else {
    const named = catalog.templates.filter((x) => sameName(x.name, want));
    if (named.length === 0) throw new ProvisionRefused(`"${want}" is not a connection template this ${cfg.appLabel} account offers.`, 422);
    if (named.length > 1) throw new ProvisionRefused(`More than one connection template is named "${want}", so there is no single template a connection could be built from. Rename one in the ${cfg.appLabel} panel.`, 422);
    t = named[0]!;
  }
  // A template with no `provision` would create a connection with no PBX or SIP configuration at all — a
  // live, broken connector an operator then has to find and delete. Refuse instead of writing it. The same
  // predicate flags the option in the picker, so what the page draws disabled is what this declines.
  if (!carriesProvision(t.params)) {
    throw new ProvisionRefused(`The connection template "${t.name}" carries no provision configuration, so a connection built from it would have no PBX settings.`, 422);
  }
  // ⚠️ AND A DIALLING COUNTRY, REFUSED RATHER THAN DEFAULTED. This used to read `t.params.country ?? 'US'`
  // at the create, which turned an unfinished template into a connection quietly dialling as American —
  // wrong outside the US, silent everywhere, and permanent, since this page never rewrites a connection it
  // created. The picker disables the option from the same fact, so nothing here is offered and refused.
  if (!carriesCountry(t.params)) {
    throw new ProvisionRefused(`The connection template "${t.name}" names no country, so a connection built from it would have no dialling country. Set one on the template in the ${cfg.appLabel} panel.`, 422);
  }
  return t;
}

/** Apply one step. Every step is idempotent: re-running a finished one is a `noop` or a 409, never a
 *  second write, which is what lets a half-finished enable be resumed by running the sequence again. */
export async function applyStep(step: ApplyStep, w: ProvisionWriter, input: ApplyInput): Promise<ApplyOutcome> {
  switch (step) {
    case 'org': return applyOrg(w, input);
    case 'signin': return applySignin(w, input);
    case 'connector': return applyConnector(w, input);
    // A body asking for a step this feature does not have is a bad REQUEST, not a fault: the route
    // answers 422 naming it rather than a 500 the operator can do nothing with.
    default: throw new ProvisionRefused(`"${String(step)}" is not a provisioning step this page applies.`, 422);
  }
}
