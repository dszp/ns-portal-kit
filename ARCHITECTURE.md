# Architecture

How `ns-portal-kit` fits together, and the non-obvious things that will bite you.

This repo is the **host layer**. The portable core — the flow model, resolver, Mermaid/HTML renderers,
themes, `ns_t` validation, and the NetSapiens API clients — lives in
[`@dszp/netsapiens-lib`](https://github.com/dszp/netsapiens-lib), so the same code runs here, in a
CLI, or in a browser. Its client surface is **split by capability**: a read-only `NsClient` (holding one, you
*cannot* write) plus a small, **separate** `NsWriteClient` (device provisioning for activation) — so reads
stay read-only by construction. Ringotel reads and writes go through
[`@dszp/ringotel-lib`](https://github.com/dszp/ringotel-lib), which models the same read/write split.

| File | Role |
|---|---|
| `worker.ts` | Cloudflare Worker entry: dual-mode auth, the route table + sensitivity map, per-tier bundle serving, `CacheApiVerdictCache`. Worker-only APIs. |
| `kit.ts` | The **Worker-served injection**: the neutral public **primary** bootstrap, the per-tier gated **bundles** (admin `/kit/portal.js` + self-service `/kit/self.js`), the `PORTAL_SECONDARIES` manifest, and `/kit/asset` secondaries. |
| `features.ts` | **Feature gating**: the LEVELS scope vocabulary, the `FEATURE_REGISTRY` (defaults), and `resolveFeaturePolicies(env)` from `PORTAL_FEATURES` / `PORTAL_SUPERADMINS`. |
| `viewerApp.ts` | the viewer SPA the Worker serves (`viewerHtml`). |
| `brand.ts` | deploy-time branding → a theme layered onto the neutral registry. |
| `ringotel.ts` | the optional Ringotel integration (org/user status **reads**), behind one gate. |
| `eligibility.ts` | Ringotel **activation eligibility** (HARD / SOFT / precondition tiers) + `RINGOTEL_*` config resolution. |
| `ringotelActivation.ts` | activate / deactivate / reset **orchestration** (provision the NS device, copy SIP creds to the app user), incl. duplicate-extension self-heal. |
| `nsDevices.ts` | optional desk-phone model + registration enrichment (on the diagrams). |
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

**Portal backend mode** — delegated only, no service-token fallback. Every request runs
`verify → toPrincipal → can(feature)`. A valid `ns_t` **always** yields a policy-gated principal (there is
no "delegated but unpoliced" path). `portal.access` is the entry gate; a reseller unlocks cross-domain
reads, everyone else is domain-locked to their own. Two systems sit on top — **feature gating** and the
**self-service tier** (below, after `ns_t` validation).

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

### Feature gating

Portal-mode features are gated by a small policy engine, not hardcoded scope checks. `features.ts` holds a
**LEVELS** vocabulary (an `office_manager ⊃ site_manager ⊃ … basic_user` scope ladder, plus orthogonal
call-center levels) and a `FEATURE_REGISTRY` whose defaults reproduce the built-in per-scope matrix.
`resolveFeaturePolicies(env)` folds in operator overrides from `PORTAL_FEATURES` (a per-feature gate: a
level, a union of levels, `levels + users`, raw rules, or `off` as a kill-switch) and `PORTAL_SUPERADMINS`
(an account-based tier unioned into every gate). A bad key/level is a **loud 500**, never a silent allow.
The *same* key gates the server-side data route and the cosmetic `_AF` self-hide flag in the bundle — the
flag can never grant more than the route.

### The self-service tier

Orthogonal to the admin ladder: a user acting on **their own** account. `portal.self` (default `all`) is a
second entry gate — a valid `ns_t` that fails `portal.access` is admitted as a **self principal**, *fenced*
to `/me/*` + `/kit/self.js` (portal-mode only; a self principal 403s on every admin route). Every `/me/*`
route derives identity from the NetSapiens **`~` self-wildcard** (`GET /domains/~/users/~`), resolved
server-side from the bearer — so a caller can only ever read or write their **own** account (client-supplied
ext/domain are ignored; IDOR-proof by construction). `me.appStatus` (own home app-status) is exposed;
`me.devices` + `me.resetPassword` ship gated `off`.

## Worker-served injection

Portal-backend mode serves its own client JS, **per tier**, instead of shipping a static file (`kit.ts`):

- **Primary** (`/<PRIMARY_BASENAME>.js`) — a neutral, public bootstrap. Host-neutral (derives its API base
  from its own `currentScript.src`), carries **nothing sensitive** (labels ride the gated bundle, not here),
  safe to cache-in-front. It reads the `ns_t`, then fetches whichever gated bundles the caller is entitled to.
- **Bundles** — `buildKitBundle` (admin) and `buildSelfBundle` (self) wrap a shared `KIT_COMMON` + a
  per-tier body. `allowedKeys` is `can()`-filtered by the caller *before* the bundle is built, so a bundle is
  a **pure function of (allowed keys, env)** — no per-user field can enter a shared tier's bytes. Served
  `private` + `Vary: Origin, Authorization`, cached **inside the Worker** per tier (key = host + tier hash +
  VERSION), so a deploy busts it.
- **Secondaries** (`PORTAL_SECONDARIES`) — a manifest of extra scripts: `url:` (external, loaded
  client-side) or `r2:` (a file in a private R2 bucket bound as `ASSETS`, which the Worker serves + gates at
  `/kit/asset/<name>.js`). The gate reuses the same LEVELS vocabulary.

**Don't front a gated bundle with edge caching** — a cache hit would skip the Worker and its gate. The tier
cache lives *inside* the Worker; the neutral primary is the only injection artifact safe to cache-in-front.

## The integration-gate convention

Every optional integration lives in its own module behind **one predicate** — for Ringotel,
`ringotelEnabled(env)` (is a key configured?). When false: no network calls, no enrichment, its routes
404, and the Worker is behaviorally identical to the NetSapiens-only baseline. That's a **tested
invariant**, not a convention. Copy this shape for new integrations.

## Ringotel writes — activation & password reset

The Worker's writes all flow through one orchestration (`ringotelActivation.ts`), across two surfaces: the
**admin** profile-page controls (`/rapp/activate`, `/rapp/resetPassword`) and the **self-service**
reset (`/me/resetPassword`, the self tier). It runs **activate / deactivate / reset** over two portable
clients: `@dszp/netsapiens-lib`'s `NsWriteClient` (provision the NS softphone device
`<ext><suffix>`, read its generated SIP password) and `@dszp/ringotel-lib`'s write client (create/attach/
deactivate the app user, reset password). `eligibility.ts` decides *who* may be activated — **HARD**
(system/structural, never overridable) → **SOFT** (name/ext/no-device heuristics, reseller-overridable) → an
**email precondition**. Every write is gated three ways: the feature policy
(`ringotel.activate`/`ringotel.resetPassword`, or the self-tier `me.resetPassword`), a forced fresh `/jwt`
re-validation (`needsFreshAuth('write')` closes the revocation gap), and the **`RINGOTEL_WRITE_DOMAINS`
rail** — empty ⇒ all writes refused (fail-closed), `*` ⇒ every in-scope domain. A write also **self-heals a
duplicate extension** (keeps the real provisioned record, best-effort deletes the rest) so a stale app record
can't hijack a login.

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

**Minimal bindings.** Caching is the Workers Cache API (no KV/D1/DO), so a default fork provisions nothing.
The one optional binding is an **`ASSETS` R2 bucket** — needed *only* to serve `r2:` secondaries
(`PORTAL_SECONDARIES`); deployments without them need no binding at all.

**Don't put a gated response behind cache-in-front.** A cache hit skips the Worker, and therefore the
auth gate. Cache *inside* the Worker (`caches.default`), keyed per tier.

**Verify in real workerd.** The offline suites run under Node's lenient undici and miss Workers
`this`-binding traps: a global like `fetch` called as `this.x(...)` throws "Illegal invocation" in
workerd but passes in Node. Always call such globals as free functions, and hit `/health` plus one real
endpoint on a deploy before trusting it.

**A var in both `wrangler.jsonc` and `.dev.vars` is shadowed by the config value** during
`wrangler dev` — which silently disables an allowlist declared in both. Pick one place.
