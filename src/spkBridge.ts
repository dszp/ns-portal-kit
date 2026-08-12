/**
 * The `postMessage` protocol between the injected SPK bundle (which runs in the Manager-Portal page —
 * `src/kit.ts`) and the integration console rendered inside its sandboxed iframe (`src/statusPage.ts`).
 *
 * It lives in its own module because NEITHER side owns it. Both files emit JavaScript as a *string*, so
 * the field names are literals in two generated artifacts that no compiler ever compares — and they did
 * diverge: the parent posted results under `data` while the page read `results`, so pressing "Run checks"
 * made a full round of real calls against production, then blanked the Checks panel. To the operator that
 * read as "nothing to report", which is the one thing this console must never say.
 *
 * Interpolating these constants into both generated strings makes that divergence unrepresentable.
 * `statusPage.selftest.ts` additionally re-derives the field names back OUT of the two generated
 * artifacts and asserts they agree, so a future hand-typed literal on either side is caught as well.
 */
export const SPK_BRIDGE = {
  /** Marks a message as belonging to this protocol at all. Both directions carry it. */
  tag: '__spk',

  /**
   * BOTH DIRECTIONS, on the ENVELOPE rather than inside a payload: which question this answer is for.
   *
   * ⚠️ THE BUG IT EXISTS TO PREVENT. The console asks {@link resolveRequest} on every edit and keeps ONE
   * callback slot for the answer. Two questions can be outstanding at once (the second edit lands while
   * the first round-trip is still in flight), and with untagged replies the answer to the FIRST is handed
   * to the callback waiting for the second — the picture, the chips and the owners are then computed from
   * a config that is no longer on screen. Worse, the real answer arrives to an empty slot and is dropped,
   * and the "don't re-ask the same question" guard already holds the newer key, so nothing ever corrects
   * it. The console therefore stamps each question and ignores a reply that is not the one outstanding.
   *
   * The parent echoes whatever it was sent, verbatim and without interpreting it — it is the asker's
   * bookkeeping, not the answerer's. A reply with no id is accepted, so a page holding a cached older
   * bundle degrades to the previous behaviour rather than going silent.
   */
  idKey: 'rid',
  /** iframe → parent: "run the live checks". */
  request: 'probe',
  /** parent → iframe: the reply, carrying either {@link dataKey} or {@link errorKey}. */
  response: 'probe-result',
  /** parent → iframe: the `ProbeResult[]` payload. */
  dataKey: 'data',
  /** parent → iframe: truthy when the run did not complete. The page must render this as a FAILED run,
   *  never as an empty result list — an empty list is indistinguishable from "everything is fine". */
  errorKey: 'error',

  /**
   * iframe → parent: "what is actually loaded on the portal page?"
   *
   * A separate message rather than a field on the probe reply, because the two answers have nothing in
   * common: probes cost real upstream calls and run on a button, while this reads `document.scripts` in
   * the page the parent is already in — free, synchronous, and safe to ask for on open.
   *
   * It exists because the console spent its first weeks saying "unverifiable from here" about chain
   * loading, which was true of the SANDBOXED IFRAME and false of the parent. The console's own bundle runs
   * in the portal page and can simply look.
   */
  pageRequest: 'page',
  /** parent → iframe: the reply to {@link pageRequest}. */
  pageResponse: 'page-result',
  /** parent → iframe: the observed-page payload (see `PageFacts` in `statusPage.ts`). */
  pageKey: 'page',

  /**
   * iframe → parent: "what entries are in the portal's menus right now?"
   *
   * The menu builder's whole premise. It could render a mock-up of a portal menu from nothing, and that
   * mock-up would be wrong for every deployment whose portal differs from ours — which is all of them,
   * since hiding a stock entry means naming a label that only that portal knows. Reading the real menus
   * off the page turns "guess the label" into "tick the entry", and costs a DOM walk.
   */
  menusRequest: 'menus',
  /** parent → iframe: the reply to {@link menusRequest}. */
  menusResponse: 'menus-result',
  /** parent → iframe: `{ [menuName]: { present: boolean, entries: string[] } }`. */
  menusKey: 'menus',

  /**
   * iframe → parent: "ask the Worker whether this candidate PORTAL_MENUS is valid", carrying the JSON
   * under {@link checkKey}. The parent forwards it to `GET /kit/menus/check` and returns the verdict.
   *
   * Round-tripped to the server on purpose. The builder must not re-implement the validation rules — the
   * https-only scheme, the ban on `{variable}` in a URL's authority, the known-variable list, the rung
   * shapes. A second copy in the browser is a copy that drifts, and the half that drifts is the one
   * enforcing a phishing guard. `menuConfigError` is the authority; this asks it.
   */
  checkRequest: 'menucheck',
  /** parent → iframe: the reply to {@link checkRequest}. */
  checkResponse: 'menucheck-result',
  /** iframe → parent: the candidate PORTAL_MENUS JSON string. parent → iframe: `{ok, error, warnings}`. */
  checkKey: 'menucheck',

  /**
   * iframe → parent: "resolve this candidate for this audience" — the editor's preview.
   *
   * The sibling of {@link checkRequest} and it exists for the same reason one step further on: `check`
   * asks whether a config would be ACCEPTED, this asks what it would DO for one person. Precedence is
   * decided by `resolveTargeted` and nowhere else — a browser-side copy of "which rule wins" would be a
   * copy that drifts, and the half that drifted would be the one telling an operator whose menu they are
   * looking at.
   *
   * ⚠️ A FAILED PREVIEW MUST NOT RENDER AS A MENU. An empty plan drawn as a composed menu says "nothing is
   * hidden and nothing is added here", which is a confident wrong answer of exactly the kind
   * {@link errorKey} exists to prevent on the checks panel. The reply therefore carries `unavailable`, and
   * the page renders preview-unavailable rather than an empty menu — the same shape, and the same rule,
   * as "could not check must never show as valid".
   */
  resolveRequest: 'menuresolve',
  /** parent → iframe: the reply to {@link resolveRequest}. */
  resolveResponse: 'menuresolve-result',
  /** iframe → parent: `{c, domain, scope, apps[], user?}`. parent → iframe: `{plan, matched, appsHide}`,
   *  or `{unavailable: '<why>'}` when the Worker could not answer. */
  resolveKey: 'menuresolve',

  /**
   * iframe → parent: "what role menus have been captured?"
   *
   * ⚠️ THE STORE HAS TO LIVE IN THE PARENT. The console is a sandboxed `srcdoc` with no
   * `allow-same-origin`, so its origin is opaque and `localStorage` throws there — the same fact that
   * made the Copy button silently do nothing for months. The captures are written by the injected bundle
   * on the portal page (which has storage, and already uses it for `ns_t`) and read back over this pair.
   *
   * The payload is menu LABELS the reader's own browser already rendered, keyed by the scope they were
   * masqueraded as. Nothing leaves the browser: the Worker never sees a capture, and no configuration
   * changes because of one.
   */
  stockRequest: 'stock',
  /** parent → iframe: the reply to {@link stockRequest}. */
  stockResponse: 'stock-result',
  /**
   * BOTH DIRECTIONS, one field. iframe → parent it is optional and may carry `{mode: true|false}` to arm
   * or disarm capture, or `{clear: true}` to forget the captures (the arming survives — it is a
   * preference about the tool, not part of what was gathered); parent → iframe it is the store:
   * `{ "<scope>": { scope, at, domain, appRows, menus: {…} }, __mode: { on, at } }`.
   *
   * Arming has to happen from the console because the console is the only place you can be BEFORE a
   * masquerade — and the store lives in the parent because a sandboxed frame has no localStorage. A
   * separate message would be a second field for one boolean travelling the same wire to the same place.
   */
  stockKey: 'stock',
} as const;
