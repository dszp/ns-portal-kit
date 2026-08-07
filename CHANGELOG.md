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

**Why some versions have no release link:** this repository is published in batches, so several versions
can land in one release. Every version is documented below, but only the ones that were published
separately have a tag to link to — the entries between them describe changes that reached you in the next
release. The version at `/health` always matches a heading here.

## [0.2.21] — 2026-08-07

### Added

- **Support for a PBX domain served by several app connections in one organization.** Previously any
  domain matching more than one connection was treated as an ambiguous binding: every app feature
  returned 409, call-flow enrichment degraded to a note, and the domain was invisible to the orphan
  sweep. Several connections under one organization is a supported topology — per site, per
  white-label app, or a pilot beside production — and is now handled throughout.

  Ambiguity is now about **organizations**: two or more organizations claiming one domain still
  refuses everywhere, because there is no single source of truth for whose users those are.

  App status reads search every bound connection, and each user reports the connection it sits on.
  The orphan sweep and the user-change event handler act per connection. Password resets and
  re-activations locate the record's own connection. Creating a user that does not exist yet — a first
  activation, or bulk pre-population — still refuses on such a domain, because nothing yet says which
  connection a new user belongs to; the message says so.

  An extension holding records on **more than one** connection is reported as a conflict and never
  resolved by picking one.

### Fixed

- **Attached secondary records are no longer mistaken for provisionable users.** A user attached to a
  second connection shares one app login with a primary and carries a link to it. Such a record sits
  at the same extension as its primary, so it could previously be selected as the record to activate,
  reset or deactivate — and being newer, it would win. It is now excluded from that selection and from
  the orphan sweep.

- **The `*` event scope no longer skips multi-connection domains.** Scope was computed by counting
  directory rows per domain, so a domain with a second connection was dropped and never swept — the
  orphaned billed seats that the sweep exists to clean up accumulated precisely there.

## [0.2.20] — 2026-07-31

### Added

- **Offboarding for NetSapiens event subscriptions** (`NS_EVENTS_OFFBOARD=deactivate`, off by default). A
  user deleted in NetSapiens now has their app record deactivated — confirmed only by a 404 on re-read,
  never by the event payload, since a deleted user leaves no record to re-read and the `subscriber` model
  carries no removal flag. It fires immediately from the change event, and again on an hourly sweep that
  also cleans up records orphaned before this feature shipped.
- **Device self-heal on user change** (`NS_EVENTS_DEVICE_REPAIR=report|heal`, off by default). An active
  app user whose softphone device has gone missing gets it recreated and its credentials re-pushed;
  `report` logs the drift without writing anything, for watching before acting.
- **`NS_EVENTS_SWEEP_MAX`** caps how many records the hourly sweep will touch in a single run (default
  200). Overflow is logged, never silent.

### Changed

- **Turning subscriptions off now unsubscribes.** Previously the reconciler stopped *managing*
  subscriptions the moment the feature went inert, while NetSapiens kept delivering to a now-dead route
  until the subscription itself errored out. It now removes its own subscriptions when it goes inert —
  emptying `NS_EVENTS_DOMAINS` or setting `NS_EVENTS=off` — provided the callback origin and service
  credentials are still configured at that point. See SETUP for the retirement order.

## [0.2.19] — 2026-07-28

### Changed

- **The Manager Portal's own table-refresh button now also refreshes the app column.** On the Domains and
  Users lists, the refresh control in the panel header reloads the NetSapiens table in place; it now also
  forces a fresh read of the app organization directory instead of serving the cached one. This matters
  most for a domain that was *just* connected to the app service: the directory is cached for an hour, and
  the only refresh control until now lived inside the app column itself — which isn't drawn for a domain
  that has no organization yet, so from that page there was no way to ask for a fresh read at all. The
  forced read is limited to callers holding the directory-refresh permission (resellers and super-users by
  default); for everyone else the button behaves exactly as it did before.

## [0.2.18] — 2026-07-27

### Added

- **NetSapiens event subscriptions — keep the app directory in sync when NetSapiens changes.** Until now,
  a user's name and email only reached the app directory as a *side effect* of an explicit action
  (activate, deactivate, password reset, or an SSO login). Edit a user directly in NetSapiens and the app
  directory kept the old values indefinitely. This adds an inbound receiver plus a scheduled reconciler
  that keeps the subscriptions themselves alive and reports their delivery health.

  It is **inert until configured**: unset means no route, no scheduled work, and no behaviour change at
  all. Set `NS_EVENTS_BASE_URL` (this deployment's public origin), the `NS_EVENTS_PATH_SECRET` secret, a
  service credential, and `NS_EVENTS_DOMAINS`, and it arms itself.

  Design notes worth knowing before you enable it:
  - **A pushed event is treated as a trigger, never as data.** The receiver extracts only *which user
    changed*, then re-reads that user from the API and syncs from the response. So a payload that omits a
    field can never be mistaken for a field that was cleared, and replaying a delivery is a no-op.
  - **The callback URL is a per-domain capability.** Its path token is derived as
    `HMAC-SHA256(NS_EVENTS_PATH_SECRET, domain)`, so one leaked URL does not expose the others. Treat the
    URL as a capability rather than a password: NetSapiens stores it, returns it when you list
    subscriptions, and logs it. Rotating the secret re-points every subscription automatically.
  - **Your other subscriptions are never touched.** Only subscriptions whose `post-url` starts with your
    own `NS_EVENTS_BASE_URL` are managed; anything else on the same domain is reported and left alone.
  - `NS_EVENTS_DOMAINS` accepts an explicit list or `*`, and can never exceed `RINGOTEL_WRITE_DOMAINS`.

- **Directory pre-population — create inactive app entries for users who have none.** So the app directory
  reflects your NetSapiens organization before anyone is activated, and a later activation updates an
  existing entry instead of inventing one. A **preview** lists what would be created and, just as usefully,
  every user it skipped and why; a separate **apply** performs it. Apply re-plans server-side, so the caller
  names a *domain* and never the individual users. Gated by the new `ringotel.prepop` feature (default
  `reseller`) and bounded by `RINGOTEL_WRITE_DOMAINS`.

  Users with **no email address are included** — a missing address blocks activation, not a directory entry,
  and such a user can still be activated later by signing in. Soft-excluded users (`SHARED`, `VOICEMAIL`,
  excluded extension patterns) are skipped unless you set `RINGOTEL_PREPOP_INCLUDE_SOFT`; hard-excluded ones
  never are. A created placeholder deliberately carries **no SIP identity** — a record owning
  `<ext><suffix>` is exactly what collides when an extension is later reassigned.

- **`AGENTS.md` — deploying this project, written for a coding agent.** If you delegate the deployment,
  point the agent at that file. It is the order of operations rather than a settings reference: which mode
  to pick and why the choice matters, how to obtain the code so your configuration does not become public,
  the decisions it must ask you about instead of guessing (write access, domain visibility, who sees which
  feature), the things it must not do on your behalf, and a verification sequence that ends by confirming a
  user *without* a feature's role genuinely cannot see it. SETUP.md remains the reference; AGENTS.md links
  into it rather than repeating it.

### Fixed

- **Stale app data: three separate causes, one symptom.** Users' app status, the activate/deactivate
  control, and the sign-in instructions could all show information that was minutes to an hour out of
  date, with nothing on screen to suggest it.

  - **Cached entries were shared between deployments.** Cloudflare's `caches.default` is shared
    **zone-wide**, not per Worker, so every deployment on the same zone read and wrote *one* set of cached
    app-provider entries. A deployment that invalidated an organization's cached user list after a write
    had that entry immediately repopulated by another deployment's read, and then served the other
    deployment's data until the TTL lapsed. The forced-refresh lock was shared the same way, so one
    deployment's refresh suppressed another's for a minute. Every cache key is now namespaced by the new
    **`CACHE_SCOPE`** var. A single deployment needs no configuration; if you run more than one Worker on
    one zone, give each `env.*` block its own value (`vars` are **not** inherited). The desk-phone
    device cache had the identical defect and is namespaced too. `GET /health` now reports the value in
    use, because one deployment missing the setting degrades safely to its own namespace but *two*
    missing it would quietly share one again — comparing the field across your deployments is the
    cheapest way to catch that.

  - **Two organization settings could be an hour stale with no way to notice.** The SSO binding and the
    "hide password in email" flag are part of a directory snapshot cached for an hour, because building it
    costs a fleet-wide organization list *plus* a branch read per organization. But those two settings
    change when an operator edits the organization in the app provider's own admin — which passes through
    none of this Worker's write paths, so nothing could ever invalidate them. The result was users being
    shown the wrong way to sign in, for up to an hour, silently. The expensive structural lookup still
    caches for an hour; those two settings are now overlaid from a **60-second per-organization read**
    costing one API call per view. Shortening the whole snapshot's lifetime would have multiplied the
    expensive part to fix the cheap part. If the overlay read fails the previous value is used — a
    freshness optimization must never turn a working request into a failed one.

  - **The user-profile page showed cached status on load.** It re-read live only after a change *it* had
    made, so a plain reload — or a change made anywhere else, including a user provisioned by an SSO login
    — showed the previous state until the cache expired. It now reads live on load; the cost is one extra
    request on the page where someone is most likely to be mid-change.

### Changed

- **Activating a user now replaces the SIP password of a softphone device it did not create.** Previously
  the stored password was reused, which left *any other endpoint still holding it* with valid credentials
  for the same address-of-record. Both would register, the most recent winning, and they would trade the
  registration back and forth — intermittent call failures with nothing obviously wrong in either system.
  Rotating at activation invalidates the stranger.

  A device the activation itself creates is not rotated (it is already exclusive), and sign-in paths never
  rotate — doing so on every login would churn the credential and could race a re-registration. The change
  is an in-place update, so the device keeps its emergency caller id, provisioning link and transport
  settings, and it is best-effort: if it fails, activation still succeeds using the existing password. Set
  `RINGOTEL_ROTATE_SIP_ON_ACTIVATE=0` for the previous behaviour.

- **The users list now shows how old its data is, and offers a refresh.** That list stays cached for ten
  minutes deliberately — it is a bulk view, and making it always-live would add an app-provider request to
  every page view of a large domain. So instead of presenting stale data as current, the column header
  reports its age and, for operators whose role permits a forced refresh, offers a control to trigger one.
  The capability existed already but had no interface, which meant the only way to clear a stale read was
  to know an undocumented query parameter. A visibly old answer is better than a silently wrong one.

  That parameter also gained a neutral spelling, `?refresh=1`, which is what the client now sends; the
  previous spelling still works. It named the app provider, and the served browser bundle is deliberately
  free of vendor names so a white-labeled deployment stays white-labeled in devtools.

## [0.2.17] — 2026-07-23

### Changed

- **An email address removed in NetSapiens now reaches the app directory.** Activate, deactivate and
  password-reset previously sent the address only when it was non-empty, so a user whose NetSapiens
  address had been cleared kept whatever the app directory still held. That leftover address could
  receive the app password for an extension that had since been reassigned — the new occupant's
  credentials mailed to the previous one. NetSapiens is the source of truth for identity, so the current
  value is now synced faithfully, blank included.
- **A failed NetSapiens read no longer looks like a removal.** The address is three-state internally: a
  read that failed leaves the directory value untouched, while a successful read showing no address
  clears it. Only a genuine removal propagates.

**Note:** a password reset for a user with no NetSapiens address now mails the new password nowhere,
where it previously went to the stale address. That is deliberate — it must not reach the wrong person.
Put an address on the NetSapiens user before resetting.

### Fixed

- **The app password reset button now appears greyed out while masquerading, instead of disappearing.**
  A control that silently absents itself reads as "this user cannot be reset" rather than "you cannot do
  this from here". It carries a hover tooltip explaining why, matching the activation checkbox beside it.
- **A masqueraded session can no longer mistake a hidden email address for a removed one.** The portal
  withholds account-security fields during masquerade, so the address reads as blank there whether or not
  the user has one. Writes made from such a session now leave the stored address untouched.

## [0.2.16] — 2026-07-22

### Added

- **The Management menu is a third menu target** (`"management"`), alongside `"apps"` and `"account"` —
  the top-nav dropdown the portal shows to administrative scopes. Useful for putting an operator tool
  (device provisioning, a vendor portal) where an administrator already looks for that kind of thing.
  Entries are appended after the portal's own, and the same targeting rules apply, so pairing it with the
  `scopes` axis narrows it to exactly one role.

  That menu carries no id and its toggle carries no link, so it is identified by the toggle's **label**.
  A portal that renames it will simply not match — the entry is absent rather than landing somewhere
  unintended, which is the failure mode worth having.

## [0.2.15] — 2026-07-22

### Added

- **Menu rules can target a user's role.** Alongside "which domain" and "which app is active", a menu rule
  may now name the NetSapiens **user scopes** it applies to — so a support link can reach office managers
  and their users while leaving administrators' menus untouched, or a stock entry can be hidden only from
  the people it confuses. It reads like every other axis (`{"scopes": {"Reseller": []}, "*": [...]}`) and
  slots into the same precedence, most specific first: domain, then scope, then app state, then the
  default.

  Unlike the feature levels, a scope here means **exactly** that scope and does not include the ones above
  it — which is what makes "office managers but not resellers" expressible at all. A scope this deployment
  does not know is a startup error rather than a rule that silently never matches, and existing menu
  configurations resolve exactly as before: the axis does nothing until a rule names it. While a user is
  masqueraded, the masqueraded user's scope is the one that matches, so an administrator sees the menu that
  user sees. See [SETUP.md](./SETUP.md#customizing-portal-menus-portal_menus).

### Changed

- **The organization-status route no longer returns the credentials-email flag.** That flag only means
  something once a specific user has been resolved to the app-password path, which an organization-level
  route never does — the user-facing route emits it exactly where it is actionable. Nothing consumed it
  here. This makes "returned only where it is actionable" true on both routes rather than one.

### Fixed

- **The account menu is identified more reliably.** A menu carrying *both* a sign-out entry and the
  signed-in user's own profile link is now preferred over one carrying only a sign-out entry, since either
  signal alone can appear on an unrelated dropdown. Sign-out alone remains the fallback, and the profile
  link alone the last resort, so variants that show neither together still work.

## [0.2.14] — 2026-07-22

### Fixed

- **Entries added to the account menu could stop appearing for some roles.** The menu is located by its
  sign-out entry, and 0.2.13 tightened that match so it would not also catch unrelated labels — but the
  test ran against the menu's combined text, which joins items with no separator. An adjacent item ending
  in a letter (for example a vendor-injected entry sitting directly above sign-out) therefore ran into it
  and the match failed, so nothing was added. The check now examines each item on its own, which is
  immune to how the markup is assembled and still ignores labels that merely begin with the same words.

## [0.2.13] — 2026-07-22

### Security

- **A menu variable can no longer appear in a link's host.** `{ext}`, `{name}` and friends are filled from
  the signed-in user's own directory record — but a template like `https://{fname}.example.com/x` would let
  that field choose the *destination*, and a domain administrator sets those fields for their users. Values
  are now refused in the host portion of an `https://` URL at startup, so the destination is always a
  decision the operator made. Variables in the path or query are unaffected, as are `mailto:` addresses.
- **Added links now send no referrer.** They already opened with `noopener`; they now also set
  `noreferrer`, so the portal URL — including a query string that may carry identifiers — is not handed to
  the destination. This closes the same gap that `{page}` deliberately avoids by sending only the path.

### Fixed

- **Variables in a `label` or `title` are no longer percent-encoded.** Those are read by a person, not
  parsed as a URL, so a name containing a space or an apostrophe rendered as `Ann%20O%E2%80%99Hara`.
- **Menu variables now resolve on deployments with no app integration.** They silently resolved to empty
  there — on exactly the deployments that path exists to serve. `{page}` likewise now shows a readable path
  in a label or title, while staying encoded inside the URL.
- **The account menu is matched more precisely.** Its anchor is the sign-out entry, which previously also
  matched unrelated text such as "Log Outbound Calls".

### Changed

- Requires `@dszp/ringotel-lib` **^0.1.6**.

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

[0.2.17]: https://github.com/dszp/ns-portal-kit/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/dszp/ns-portal-kit/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/dszp/ns-portal-kit/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.2.14
[0.2.13]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.2.13
[0.2.12]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.2.12
[0.2.6]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.2.6
[0.2.5]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.2.5
[0.2.3]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.2.3
[0.1.4]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.4
[0.1.3]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.3
[0.1.2]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.2
[0.1.1]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.1
[0.1.0]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.0
