# Architecture

How `ns-portal-kit` fits together, and the non-obvious things that will bite you.

This repo is the **host layer**. The portable core — the flow model, resolver, Mermaid/HTML renderers,
themes, `ns_t` validation, and the NetSapiens API client — lives in
[`@dszp/netsapiens-lib`](https://github.com/dszp/netsapiens-lib), so the same code runs here, in a
CLI, or in a browser. Ringotel talks through
[`@dszp/ringotel-lib`](https://github.com/dszp/ringotel-lib).

| File | Role |
|---|---|
| `worker.ts` | Cloudflare Worker entry: dual-mode auth, route table, `CacheApiVerdictCache`. Worker-only APIs. |
| `viewerApp.ts` | the viewer SPA the Worker serves (`viewerHtml`). |
| `brand.ts` | deploy-time branding → a theme layered onto the neutral registry. |
| `ringotel.ts` | the optional Ringotel integration, behind one gate. |
| `nsDevices.ts` | optional desk-phone model + registration enrichment. |
| `access.ts` | Cloudflare Access JWT verification (RS256/JWKS). Active only when **both** `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` are set. |
| `exposure.ts` | the service-token gate: refuses to use a stored `NS_API_TOKEN` when nothing verifiable is in front of it, and serves the teaching page instead. |
| `setup.ts` | the unconfigured-deployment checklist: which settings are unset, and the fix for each. Presence only, never values. |
| `pageShell.ts` | the shared HTML shell + `esc()` used by the setup / exposure / portal-info pages. |
| `portalInfo.ts` | the terse 404 a portal-backend-mode deployment returns at `/`. Deliberately static — no config, no branding. |
| `cli.ts` | dev CLI over snapshot files (Node-only). |
| `*.selftest.ts` | offline suites; stub `caches` + `fetch`. |

## Auth

**Standalone mode** — a stored token reads any domain it's scoped to. The token's NetSapiens scope is the
real boundary; `ALLOWED_DOMAINS` is an app-layer gate on top. Pair it with Cloudflare Access
(`ACCESS_AUD` **+** `ACCESS_TEAM_DOMAIN` — both, or the check can't run): the in-Worker check fails
closed, so the token only ever answers requests that already passed the Zero Trust policy — a
`*.workers.dev` or direct-route bypass is refused. Until something verifiable is in front of the token,
`exposure.ts` refuses to use it at all rather than answer an unauthenticated caller.

**Portal backend mode** — delegated only, no service-token fallback. `verify → toPrincipal → can()` gates every
request; resellers unlock cross-domain reads, everyone else is domain-locked.

### `ns_t` validation, and why it looks paranoid

`ns_t` is HS256, signed with a secret only the NetSapiens core holds — there is no public JWKS. So the
signature **cannot** be checked locally, and the live `GET /jwt` call *is* the signature authority (it
also catches logout). Consequences:

- **Don't call `/jwt` per request.** `verify()` gates on a cheap local check first (structure, `exp`,
  `aud`, `iss`), then serves a **cached** verdict keyed by a hash of the token, TTL capped by the
  token's own `exp`. A bad, expired, or wrong-issuer token never reaches the server.
- **Only a literal 200 means valid.** 401/403 ⇒ invalid; 3xx/5xx/timeout ⇒ error → fail closed and
  uncached.
- **Revocation gap.** Logout is server-side with no evict event, so a cached "valid" can survive up to
  the TTL. Sensitive/write routes pass `forceFresh`. Every route is classified with `CallSensitivity`,
  and the `satisfies` on the route table makes an unclassified route a **compile error** — that's the
  point: you can't add a route and forget.
- **`NS_PORTAL_ISS` is required and has no default.** A default issuer would accept tokens minted by a
  portal you don't control. Unset ⇒ fails closed with an actionable message, not a mystifying 401.

The verdict cache uses the **Cache API** (per-colo). Cloudflare Anycast keeps a user on a stable colo,
so the hit rate is high and the worst case is one `/jwt` per colo per token per TTL. KV/DO would only
earn their overhead for cross-colo sharing.

## The integration-gate convention

Every optional integration lives in its own module behind **one predicate** — for Ringotel,
`ringotelEnabled(env)` (is a key configured?). When false: no network calls, no enrichment, its routes
404, and the Worker is behaviorally identical to the NetSapiens-only baseline. That's a **tested
invariant**, not a convention. Copy this shape for new integrations.

## Branding is deploy config

`@dszp/netsapiens-lib` ships vendor-neutral themes only — a brand baked into a shared library would
ship one deployment's colors to everyone. `brand.ts` layers a theme from `BRAND_ACCENT` / `BRAND_NAME`
at request time and **returns a new object** rather than mutating the imported registry: module scope
is shared across requests in a Worker, so mutating it would leak one request's branding into every
other. The accent is validated as hex before it reaches CSS.

## NetSapiens routing model (what the resolver decodes)

- **DID** (`phonenumbers[]`): `dial-rule-application` → `to-user[-residential]`, `to-callqueue`,
  `to-voicemail`, `to-connection*`.
- Every "extension" is a **user record**; some are virtual: a queue, an auto attendant, a time-of-day
  router, a shared mailbox.
- **User routing** = answer rules per time-frame, by `ordinal-priority`: `forward-always` |
  `simultaneous-ring`/`<OwnDevices>` then `forward-no-answer` | `forward-on-busy` |
  `forward-when-unregistered`.
- **Queue "Stay in queue" is a state, not an absence.** A `forward-no-answer` block that is
  `{enabled:'no', parameters:[]}` means the caller re-queues and agents ring again — they are NOT
  dropped to voicemail. The resolver draws that explicitly rather than rendering nothing.
- **Auto-attendant menus are not in a backup.** The authoritative menu lives in the AA's own dialplan
  (`<domain>_<ext>`): `Prompt_<id>.Default` is no-key/timeout, `.*` the catch-all, `.<digit>` a
  keypress. The `/autoattendants/{prompt}` detail omits the no-key/star routing.
- **A NetSapiens domain is opaque.** It may be bare (`acme`) or carry a territory suffix
  (`acme.12345.service`), and both coexist in one scope — domains keep their original name when they
  move, so the suffix says where a domain was created, not who holds it. Never infer scope from it.

## Deployment notes

**No bindings.** No KV/R2/D1/DO — all caching is the Workers Cache API, so a fork provisions nothing.

**Don't put a gated response behind cache-in-front.** A cache hit skips the Worker, and therefore the
auth gate. Cache *inside* the Worker (`caches.default`), keyed per tier.

**Verify in real workerd.** The offline suites run under Node's lenient undici and miss Workers
`this`-binding traps: a global like `fetch` called as `this.x(...)` throws "Illegal invocation" in
workerd but passes in Node. Always call such globals as free functions, and hit `/health` plus one real
endpoint on a deploy before trusting it.

**A var in both `wrangler.jsonc` and `.dev.vars` is shadowed by the config value** during
`wrangler dev` — which silently disables an allowlist declared in both. Pick one place.
