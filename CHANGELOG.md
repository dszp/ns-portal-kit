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

## [0.2.12] — 2026-07-22

### Added

- **The user's own account dropdown is now a menu target** (`"account"`), alongside `"apps"`. Same add/hide
  rules; entries are inserted into the first group, above the divider and Log Out, rather than appended
  after them. Useful for a "get help" link that belongs with the user's own actions rather than with the
  apps. The menu carries no id and shares a generic class with other dropdowns, so it is identified by
  content — the sign-out entry, which is present in every variant of it — and the Apps menu is explicitly
  excluded so the two can never be confused.

## [0.2.11] — 2026-07-22

### Added

- **Portal menu customization (`PORTAL_MENUS`).** Add and hide entries in the portal's stock menus, and —
  new — make that **conditional on whether an app is actually active for the domain**. The motivating case
  was not expressible before: hide a stock softphone entry only where your own app is running, and leave
  the stock menu alone on domains that have none, so those users keep their only softphone link.

  Targeting is one rule — a default plus specific overrides — so "everywhere", "everywhere except these"
  and "only these" all fall out of the same shape, on either the domain or the app axis, or both.
  Precedence is most-specific-first: a domain entry, then app state, then the default. Entries added are
  static (a label and an `https://` URL); a misspelled menu or app name is a startup error rather than a
  rule that silently never matches. Gated by `me.menuConfig` (default on); unset ⇒ nothing changes.

  `PORTAL_APPS_HIDE` keeps working exactly as before and remains the right answer for the common
  one-liner. Setting both it and `PORTAL_MENUS`' apps hide list is a loud error rather than a silent
  precedence rule.

  **Upgrading with `me.appAccess` turned off:** that route previously refused every caller. It now also
  serves the menu surface, which is on by default — so a deployment that disabled the sign-in panel will
  find the route answering again (with menu data only; no sign-in fields). Set `me.menuConfig: "off"` as
  well to keep it fully closed.

  Added entries may use `mailto:` as well as `https://`, and may interpolate the signed-in user's own
  details — `{ext}`, `{domain}`, `{email}`, `{fname}`, `{lname}`, `{name}` — plus `{page}`, the portal page
  they are on when they click, which is useful for pre-filling a support request. Values are
  percent-encoded so they cannot inject query parameters; `{page}` is the path only, never the query
  string. A misspelled variable is a startup error rather than a literal brace in a live link.

  Menu customization does **not** require the app integration: with no `RINGOTEL_API_KEY` configured the
  app state is simply `none`, so static add/hide still works.

### Changed

- **The app-password instruction now says where the password actually is.** It previously hedged — "in the
  email itself, or behind the one-time link in it" — because the deployment could not tell. The app
  organization reports it, and it genuinely differs between organizations, so the instruction now states
  the user's own case: the credentials are in the email, or a one-time link must be clicked to reveal them.
  Where an organization does not report the setting the previous wording is kept rather than asserting
  either case. Requires `@dszp/ringotel-lib` **^0.1.5**.

## [0.2.10] — 2026-07-22

### Added

- **The app domain now shows in the toolbar banner**, e.g. "App Active: acme". It is the same value for
  every user on a PBX domain — whether they sign in with SSO or an app password — so it is a useful
  at-a-glance fact for whoever is looking at that domain, but it was previously only reachable by hovering
  the banner. The toolbar is a fixed-height row, so the space is bought back by using
  `RINGOTEL_LABEL_SHORT` when a domain is shown, and the domain truncates with an ellipsis rather than
  widening the row; the full label and domain remain in the tooltip. Follows the existing banner gate
  (`ringotel.orgStatus`, reseller by default).

## [0.2.9] — 2026-07-22

### Fixed

- **A domain that doesn't run the app no longer shows an app-status section on the user profile.** The
  section rendered as soon as the profile read returned, without checking whether the domain has an app
  organization bound at all — so a domain with no app still showed "App Status → Inactive", offering an
  app it cannot have to anyone who could see the profile. It now renders only when an organization is
  bound; a degraded upstream read takes the same path, which is the correct failure (say less rather than
  assert a state).

### Changed

- **The activation-eligibility decision now comes from `@dszp/netsapiens-lib` (requires `^0.1.5`).** This
  Worker carried its own copy of that engine while other consumers used the library's, which is precisely
  the divergence a shared library exists to prevent — and it had already begun to diverge. The copy is
  gone; only this deployment's own configuration (the `RINGOTEL_*` environment parsing, its seeded name
  matchers, the device suffix and the write rail) stays here, since the library deliberately ships no
  defaults that would bind it to one deployment. No behavior change — the two implementations were
  identical apart from the email-precondition waiver, which now lives in the library as
  `EligContext.emailNotRequired` / `EligResult.emailWaived`.

## [0.2.8] — 2026-07-22

### Added

- **App sign-in details on the user-profile page, for operators.** When a reseller or office manager
  edits another user, the profile's app-status section now shows a **"User-visible app sign-in
  message"** block — the same sign-in instructions (and download links) that user sees on their own
  surfaces, so an operator can walk a user through sign-in, or see *why* a user can't yet (e.g. "not
  set up"). It reuses the existing profile app-status read; gated by a new `ringotel.profileAppAccess`
  feature (default office-manager). Advisory states omit any username, exactly as the self view does.
- **Per-download `showUrl`.** Each `PORTAL_APP_DOWNLOADS` entry may set `"showUrl": false` to hide the
  small copyable URL line rendered under its button (default: shown) — useful for a long link that
  would not fit a menu width.

### Changed

- **"Inactive" now says when an account will create itself.** Where SSO *and* create-on-login are both
  in play for an eligible user who has no app account yet, the status reads "Inactive (will auto-activate
  on login)" instead of a bare "Inactive" — on both the profile page and the user's own home card. Shown
  only when that outcome is actually known; otherwise the plain wording stands.
- **Served bundles no longer ship their source comments.** The injected JavaScript is emitted without its
  whole-line comments, cutting bytes sent to every portal page. Source keeps them.

### Fixed

- **SSO sign-in no longer requires the user to have an email address.** The email requirement exists
  because activation *emails* credentials — but an SSO sign-in creates the account from the user's own
  portal login and sends nothing, so requiring an address there wrongly told eligible users the app
  "isn't set up". The requirement still applies to the welcome-email activation path.
- **An already-activated user is no longer told the app "isn't set up".** Eligibility governs whether an
  account may be *created*; it was also gating sign-in instructions, so a user who already had a working
  account but later matched an exclusion was shown an advisory instead of how to sign in. Structural
  exclusions (service/system identities) still apply.
- **A temporary upstream failure now says so.** It previously reused the "isn't set up for this
  extension" wording, which reads as a settled answer rather than "try again in a moment".
- **The profile page now acts on the profile you are viewing while masquerading.** When an operator was
  masquerading and opened *another* user's profile, the app-status section resolved the masqueraded
  identity instead of the profile's own extension, so it displayed that other account's status,
  eligibility and sign-in message. (Writes were already blocked during masquerade, so this was display
  only.)
- **The sign-in message refreshes after activate/deactivate** instead of disappearing until reload.

## [0.2.7] — 2026-07-21

### Added

- **App sign-in details, shown to the user themselves.** The self-service bundle's Apps menu and
  home-page card now explain *how* a given user signs in to their softphone/desktop/mobile app — SSO
  ("sign in with your portal password") vs. a dedicated app password vs. "not set up yet" — instead of
  a generic status dot. The decision is computed server-side from data already available (never
  guessed client-side), and an advisory ("needs setup"/"unavailable") response structurally omits any
  username, so a user who can't yet sign in is never shown credentials that won't work.
- **Curate the Apps menu per deployment or per domain.** Two new settings: hide stock app entries you
  don't offer (`PORTAL_APPS_HIDE`, a CSV for the whole fleet or a JSON object for per-domain overrides),
  and add your own download links (`PORTAL_APP_DOWNLOADS`, ordered `{label, url, title?}` entries,
  `url` must be `https://`).
- **SSO awareness (`RINGOTEL_SSO_SERVICE`).** If your app fleet is bound to an SSO service and you also
  run the matching SSO integration, set this to the service's name and users whose sign-in is bound to
  it are told to use their portal password instead of a separate app password. **Unset by default —
  never claims SSO exists** unless you explicitly confirm which service answers for it, since an SSO
  binding could just as easily point at a third-party identity provider, and guessing wrong would send
  a user to try a password that will never work.
- **Create-on-login awareness (`SSO_AUTO_ACTIVATE`).** Whether an eligible user with no app account yet
  gets one created automatically on their first SSO sign-in is a setting on the SSO integration itself,
  not something this deployment can observe — so it's told here (a CSV of domains, or `*` for the whole
  fleet). Left unset, an eligible-but-unactivated user is told to contact an admin rather than being
  invited to attempt a sign-in that would fail.

### Changed

- **Two existing admin-gated responses grew a field.** `/rapp/org` now includes `ssoService` (the
  org's raw SSO binding, unchanged since Ringotel already sent it — just not previously returned to
  callers); `/rapp/users` now includes a per-extension `username` (the app sign-in name for a user
  who has one). Both are additive fields on responses only reseller/office-manager tiers could already
  read; neither is a secret.

## [0.2.6] — 2026-07-20

### Fixed

- Call-flow buttons now appear on the Phone Numbers (Inventory) page for non-reseller scopes. The page
  was anchored solely to the bulk-select checkbox (`input.inventoryChkBox[data-sipnumber]`), which is a
  reseller inventory-management affordance and is absent from the Office Manager view — so every row was
  skipped and no diagram buttons rendered, while Users/Queues/Attendants worked. The number's own edit
  link is now a fallback anchor. Rows the checkbox pass already claimed are skipped, so the reseller view
  keeps using `data-domain-owner`, which stays authoritative when a number's owning domain isn't the one
  being viewed.

## [0.2.5] — 2026-07-20

### Changed

- Narrowed the seeded `GENERAL` name matcher to `GENERAL VOICEMAIL` and `GENERAL MAILBOX`. The matcher
  is a substring test, so bare `GENERAL` also caught a staffed extension displayed as "General Manager".
  Since a soft name exclusion prevents activation, that cost a real person their app rather than merely
  skipping a non-human extension. Same reasoning that keeps `CONFERENCE` spelled out instead of `CONF`,
  which would match surnames. Override the whole list with `RINGOTEL_EXCLUDE_NAMES`.

## [0.2.4] — 2026-07-20

### Changed

- Widened the seeded soft-exclusion name list used when `RINGOTEL_EXCLUDE_NAMES` is not set, to cover
  the usual shapes of non-human extensions: `SHARED`, `SHARED VOICEMAIL`, `VOICEMAIL`, `FAX`, `GENERAL`,
  `CONFERENCE`, `CONF RM`, `CONF ROOM`, `ROUTING`. The matcher is substring and case-insensitive, so
  `VOICEMAIL` catches any department mailbox.
  `CONFERENCE` is spelled out rather than `CONF`, which would also match surnames, with the abbreviated
  room forms listed explicitly. These are **soft** exclusions: creation-only and reseller-overridable —
  an existing user is never blocked. Set `RINGOTEL_EXCLUDE_NAMES` to override the list entirely, or to
  empty to disable name exclusions.

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
