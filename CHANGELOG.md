# Changelog

Notable changes to **ns-portal-kit**.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Which version am I running?** `GET /health` on your deployment reports it:

```json
{ "ok": true, "configured": true, "version": "0.2.0" }
```

Compare that against the latest entry below to see whether there's anything worth pulling. Updating is
`git fetch upstream && git merge upstream/main` — see
[SETUP.md → Getting updates later](./SETUP.md#7-getting-updates-later).

## [Unreleased]

## [0.2.3] — 2026-07-20

### Added

- **App-record health flags on the users column and the user profile.** Each user's app record is now
  classified from data the portal already had cached, at no extra API cost: a record that has lost its
  SIP identity (still active and billable, but unable to register — and un-editable through the vendor
  API), one whose SIP identity no longer matches the expected device, duplicates at the same extension,
  a record never linked to the phone system, one that has never once been signed into, and deactivated
  remnants. Broken records are marked in the users column; every flag appears in the cell tooltip.
- **A missing softphone device is flagged on the profile endpoint.** If a user's app record is active
  but the device backing its registration has been deleted, the profile now says so — previously this
  was invisible from either side: the app record looked healthy, and the user simply could not register.
  Costs no extra call, since the profile already reads the device list.

### Changed

- Requires `@dszp/netsapiens-lib` and `@dszp/ringotel-lib` **0.1.4 or newer** (health classification
  lives in the shared library, so every consumer agrees on what "broken" means).

## [0.2.2] — 2026-07-19

### Fixed

- **Closed a window where activating a user could strand their app account.** When an extension carried
  more than one app record, the leftover records were deleted *before* the real one was re-activated — so
  for a moment the extension had no active record at all, and an app sign-in landing in that window could
  permanently strand the account. Activation now re-activates the canonical record **first** and removes
  leftovers **after**. The refusal to guess between two records that share the same SIP identity still
  happens up front, so an ambiguous extension never leaves a half-provisioned device behind.
- **Picking the canonical record now prefers an *active* one over a merely newer one.** Where no record
  carried the extension's SIP identity, the most recently created was chosen — which could pick an inactive
  leftover over the user's working account and then remove the working one. Active wins; newest is only the
  final tiebreak. (Matches `resolveCanonicalUser` in `@dszp/ringotel-lib` 0.1.3.)

## [0.2.1] — 2026-07-19

### Fixed

- **App activation status could sit on "Loading…" forever.** After saving an activate/deactivate change on
  a user's profile, the status was polled every ~300ms for only ~3s; a slower write (the softphone device
  plus the app-user write can take several seconds) outran that window, and if the in-flight request never
  settled the placeholder never resolved. The poll now runs every ~300ms for the first 3s, then every ~1s
  out to a 10s cap, and always resolves the UI exactly once (hard cap included) instead of hanging.

### Added

- **Self-service tier (own-account features).** A new `portal.self` entry gate (default `all`) admits
  non-admin users — Basic/Simple users, who never pass `portal.access` — to a **minimal, separate bundle**
  containing only own-account features. It is orthogonal to the admin ladder: a Simple User outranks
  nobody yet sees their own status. First exposed feature: a **read-only app-status indicator on the
  user's own `/portal/home`** (`me.appStatus`, default `all`). Two further own-account routes ship but are
  **off by default**: `me.devices` (read) and `me.resetPassword` (write). Every self route derives identity
  from the NetSapiens `~` self-wildcard (`GET /domains/~/users/~`), so a user can only ever see or change
  **their own** account — client-supplied extension/domain are ignored.
- **App activation from the user-profile page (writes).** The Manager-Portal user profile gains an app
  status indicator plus, for authorized roles, an **activate / deactivate** toggle (deferred to the
  native Save button) and a **reset-password** button (re-syncs credentials and emails a new app password
  to the current address without changing activation state) — replacing an external webhook backend. Three new,
  independently-gated features: `ringotel.profileStatus` (read indicator), `ringotel.activate`,
  `ringotel.resetPassword` (default level `office_manager`). Activation ensures the NetSapiens softphone
  device `<ext><suffix>` (suffix configurable via `RINGOTEL_ACTIVATION_SUFFIX`, default `r`), copies its
  generated SIP password into the app user, and the app emails the credentials; deactivation removes the
  device and deactivates the app user (kept as a directory entry). On create, (re)activate, and
  deactivate, the app user's display name (composed from the NetSapiens first + last name) and email are
  synced from the current NetSapiens user — so a re-activated directory entry never keeps a stale name and
  the credentials email is sent to the current address. (Ongoing change-sync via a NetSapiens webhook
  subscription is planned.) Every write also **self-heals a duplicate extension**: because the app's login
  maps by extension, a leftover record at the same extension can hijack a login — so a write keeps the
  real provisioned user (the record whose SIP username/authname is `<ext>r`, else the most recent) and
  **best-effort** deletes the rest, tolerating records that cannot be removed. Only a genuine tie (two
  records sharing that SIP identity) is refused. Write preconditions — an ambiguous extension, or a reset
  targeting an absent or inactive user — return a specific `409`/`404` rather than a generic error.
- **A configurable eligibility engine** decides which users may be activated: system/service users and
  non-standard extensions are refused outright; name/extension matchers and a no-device heuristic are
  soft, default-excluded, and overridable per reseller/domain (`RINGOTEL_EXCLUDE_NAMES`,
  `RINGOTEL_EXCLUDE_EXTS`, `RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN`, `RINGOTEL_EXCLUDE_NO_DEVICES`,
  `RINGOTEL_RESELLER_OVERRIDE`). A reseller can additionally **force-activate** an otherwise soft-excluded
  user at runtime (never a system user).
- **`RINGOTEL_WRITE_DOMAINS` write safety rail.** Live mutations are refused for every domain not on this
  allowlist — **empty means all writes are refused** (fail-closed); `*` permits every in-scope domain.
  Writes additionally require a delegated `ns_t` and force a fresh token re-validation.

## [0.1.4] — 2026-07-16

### Security

- **The portal-mode root page's `<title>` is now a generic "No Content", not a product name.** 0.1.3
  made the page static but kept "NS Portal Kit" in the tab title — which tells a probing client almost
  as much about what the host is as a real brand name would. The tab now reveals nothing.

## [0.1.3] — 2026-07-16

### Security

- **A forced Ringotel refresh (`?refresh=ringotel`) is now an operator capability, not a caller one.**
  It bypasses the ~1h fleet-directory cache and re-digs the whole fleet against the shared Ringotel
  key (~200 upstream calls). Because the per-user status route admits Office Managers, a low-privilege
  tenant user could loop it and exhaust or get the shared key throttled — breaking Ringotel features
  for **every** customer. Now: only reseller/super-user principals may force a refresh, AND the refresh
  is coalesced fleet-wide (an actual re-dig happens at most once per minute regardless of how many
  callers ask). Standalone mode (an operator's own Access-gated tool) is unaffected.
- **Policy now applies to every delegated request, not only when `PORTAL_MODE` parses.** A blank or
  mistyped `PORTAL_MODE` (e.g. `enabled`) used to read as "off" and serve delegated `ns_t` reads with
  the policy gate bypassed. Two fixes: a valid Bearer `ns_t` **always** yields a policy-gated principal
  regardless of the mode flag, and an unrecognized non-empty `PORTAL_MODE` is now a hard configuration
  error (500) instead of silently disabling the gate. `/health` still answers so probes work.
- **Rate limit on `ns_t` live-checks (defense-in-depth vs forged-token amplification).** A forged token
  needs only `aud:"ns"`, the public portal host, and a future expiry — no signing key — so a flood of
  distinct tokens could drive one upstream `GET /jwt` per token against your NetSapiens core. The
  Worker now caps cache-*missing* live-checks per client IP (only the expensive path; cached traffic,
  even a busy office behind one NAT, is never throttled). Two layers: an always-on in-isolate limiter,
  plus the optional Cloudflare Rate Limiting binding (`JWT_RATE_LIMITER`, declared in `wrangler.jsonc`)
  for a managed per-colo cap. Over-limit ⇒ 429.
- **Security response headers on every response.** `Content-Security-Policy` (a non-breaking subset:
  `frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`), `X-Frame-Options:
  DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. The viewer is not meant to
  be framed; this forbids it.
- **The ELK diagram-layout plugin is now opt-in (`?engine=elk`), not on by default.** It loads from a
  jsDelivr endpoint that can't carry Subresource Integrity and pulls floating transitive dependencies,
  so a CDN/dependency compromise could run in the authenticated viewer. The default (dagre) is bundled
  with the SRI-pinned Mermaid, so a default session loads no un-integrity-checked code; users who want
  ELK's tidier layout opt in per session.
- **The portal-mode root page no longer discloses `BRAND_NAME`.** 0.1.2 made that page terse and
  neutral, but left the branded product name in its `<title>` — so a white-label deployment still
  identified its operator to any unauthenticated visitor who found the URL (portal-mode deployments
  have no Access gate in front, and the URL is referenced from client-visible portal JavaScript). The
  value was escaped, so this was never an injection — only a disclosure. The page is now genuinely
  static, as its own comment always claimed.
- **The theme registry is escaped for its `<script>` context.** `BRAND_NAME`/`BRAND_LABEL` reach the
  viewer inside a JSON literal in an inline `<script>`; a `</script>` in a brand label ended the
  element early. Operator-controlled, so self-inflicted rather than an attack path — but the escape is
  free. Values are unchanged (`<` parses back to `<`).

### Fixed

- **The super-user scope is matched by synonym.** A NetSapiens core that emits `superuser` or
  `super-user` (rather than `Super User`) is no longer denied at the policy gate.
- **The setup checklist now names either missing Access variable, not just one.** `ACCESS_TEAM_DOMAIN`
  without `ACCESS_AUD` produced only a generic warning, while the reverse named the missing var. Both
  halves are the same dead configuration and both now say which one is absent.

### Documentation

- **Corrected the Access rule everywhere it was stated wrong.** Several comments and docs said the
  in-Worker Cloudflare Access check turns on with `ACCESS_AUD` alone. It does not — it needs
  `ACCESS_AUD` **and** `ACCESS_TEAM_DOMAIN`, because the team domain builds the JWKS URL the check
  verifies against. This was the exact misconception behind the 0.1.1 fail-open fix, still sitting in
  the docs a reader would consult first. Behavior is unchanged; the docs now match it.
- `ARCHITECTURE.md`'s file table was missing `exposure.ts`, `setup.ts`, `pageShell.ts` and
  `portalInfo.ts` — including the service-token gate the README leads with.
- `README.md` said `pnpm deploy`, which resolves to pnpm's builtin deploy command in a workspace repo
  and errors instead of deploying. It's `pnpm run deploy`.
- `SETUP.md`'s `BRAND_NAME` example no longer hard-codes a version number that drifts every release.

## [0.1.2] — 2026-07-16

### Changed

- Portal backend mode's root page (`/`) is now a terse, neutral 404 that no longer describes the
  authentication or injection mechanism. This endpoint is referenced from client-visible portal
  JavaScript, so its landing response now says only that the host serves application requests and has
  no public web content; configuration guidance lives in SETUP.md.

## [0.1.1] — 2026-07-16

Security fix.

### Fixed

- **Access gate fail-open.** A deployment that set `ACCESS_AUD` but not `ACCESS_TEAM_DOMAIN` — both are
  required for the Cloudflare Access check to run — would still serve a stored `NS_API_TOKEN`'s full
  NetSapiens scope to unauthenticated callers. The exposure gate now stays closed unless Access is
  *fully* configured, and the setup checklist names the missing half. **If you run standalone mode
  behind Access, confirm BOTH vars are set.**

### Changed

- Pin the ELK diagram-layout plugin to an exact version (it was a floating range loaded from a CDN, so
  a compromised future release could have loaded into the viewer).
- `NS_PORTAL_ISS` now accepts a comma-separated list of portal hostnames, as the docs already described.

## [0.1.0] — 2026-07-16

Initial public release.

### Added

- **Call-flow diagrams.** Resolve a NetSapiens domain's routing — DID → time-of-day → auto-attendant
  menu → queue → agents → voicemail/external — and render it as a Mermaid diagram, live from the API.
  Ships with a viewer: theme picker, pan/zoom, PNG export.
- **Two modes.** *Standalone* — a viewer you open, authenticating with a stored `NS_API_TOKEN`.
  *Portal backend* (`PORTAL_MODE=1`) — no stored credential at all; each request carries the calling
  user's own `ns_t`, which is forwarded to NetSapiens verbatim so every read runs as that user.
- **Optional Ringotel app status.** A reseller banner, a per-user app column, and an app column on the
  domain list (portal backend mode), plus inline presence on diagram agent lines (both modes).
  Governed entirely by whether `RINGOTEL_API_KEY` is set.
- **Optional device details.** Desk-phone model and SIP registration state on diagrams.
- **Cloudflare Access support.** In-Worker verification of the Access JWT (RS256 against your team's
  JWKS), so a request that skipped Access is refused rather than trusted.
- **Branding from config** — `BRAND_NAME` / `BRAND_ACCENT`. A fork ships unbranded; no brand value ever
  enters the source.
- **First-run setup checklist.** An unconfigured deployment says what's missing at `/` instead of
  failing somewhere deep in an API call.
- **Deploy button + C3 template**, and a `SETUP.md` defining every setting.

### Security

- **A stored service token is refused until something is verifiably in front of it.** Not a warning —
  the token is not used at all unless Cloudflare Access is configured, the request is local, or you
  explicitly opt out with `ALLOW_UNGATED_SERVICE_TOKEN=1`. A public URL cannot borrow your NetSapiens
  scope.
- **The Ringotel routes are bounded by NetSapiens scope in every mode.** They resolve from a
  fleet-wide key by domain name, so each call first confirms the caller's own token can read that
  domain in NetSapiens.
- **`NS_PORTAL_ISS` is required and has no default.** A default issuer would mean accepting `ns_t`
  tokens minted by a portal you don't control. Unset ⇒ fails closed.
- **Route sensitivity is compile-enforced**: a new route without a `sensitivity` classification is a
  type error, so cache-vs-fresh-auth can't be forgotten.

### Notes

- **No bindings to provision** — no KV, R2, D1, or Durable Objects. All caching uses the Workers Cache
  API, so a fork deploys clean.
- Portal backend mode needs JavaScript injected into your Manager Portal to call it. A reference
  implementation is planned but **not published yet**, so that half is currently yours to write.
  Standalone mode is complete and works today.

[Unreleased]: https://github.com/dszp/ns-portal-kit/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.4
[0.1.3]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.3
[0.1.2]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.2
[0.1.1]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.1
[0.1.0]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.0
