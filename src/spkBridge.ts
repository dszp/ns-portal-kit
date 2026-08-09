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
  /** iframe → parent: the candidate PORTAL_MENUS JSON string. parent → iframe: `{ok, error}`. */
  checkKey: 'menucheck',
} as const;
