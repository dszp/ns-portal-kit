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
[SETUP.md → Getting updates later](./SETUP.md#getting-updates).

**Why some versions have no release link:** this repository is published in batches, so several versions
can land in one release. Every version is documented below, but only the ones that were published
separately have a tag to link to — the entries between them describe changes that reached you in the next
release. The version at `/health` always matches a heading here.

## [Unreleased]

### Changed

- **`SETUP.md` is a setup guide again, and the settings reference moved to a new `CONFIG.md`.** The old
  file had grown to 1,400 lines that opened by asking you to choose between two products and then defined
  66 settings inline — which meant the reader had to finish a reference manual before deploying anything.
  Setup now covers **one** deployment shape: what each feature is for and why, what that feature needs,
  how to get onto Cloudflare, how to hand your portal the one URL it needs, and what to check afterwards.
  Everything past "it works" is a decision, and the integration console is where those get made.
- **`CONFIG.md` is the new settings reference**, ordered the way the console's Config tab is ordered, with
  a stable per-setting anchor — `CONFIG.md#RINGOTEL_WRITE_DOMAINS` resolves and survives a heading
  rewording. It carries the fuller material too: the level vocabulary and feature registry, the menu
  targeting model, the secondary-script rules, the event-subscription depth notes, and where each value
  belongs.
- **`SETUP.md` no longer documents the standalone viewer deployment.** That is a separate product with a
  different security model — a stored credential and a perimeter, rather than a per-caller token — and
  describing both in one file made the reader carry a fork through every section. Its documentation moves
  with it. Nothing about the code changed in this release: a deployment running with `PORTAL_MODE` unset
  behaves exactly as before.
- **`README.md` and `AGENTS.md` are portal-only too.** They previously opened by asking the reader to pick
  between two products, which put the first and least reversible decision before anything they could use.
  `README.md` now says what this is in its first paragraph and what it adds to a portal in the next.
  `AGENTS.md`'s opening STOP is no longer "choose a mode" but **"find out who controls the injected-script
  slot"** — the genuinely blocking question, since for a reseller under another carrier it is a request to
  their provider rather than a setting, and nothing reaches a user until it is honoured. Its sequence and
  verify rungs lost their per-mode branches, gained `/p.js` as its own verification step (the one check
  that separates "the Worker is broken" from "the portal is not loading it"), and gained a narrow-rollout
  step for an operator whose portal already serves customers.
- **`.dev.vars.example` prompts for what a portal deployment actually needs.** It is the deploy button's
  form, so every key in it is a blank box a newcomer must understand: it now asks for `PORTAL_SUPERADMINS`
  — the one value whose absence produces a working deployment nobody can inspect — and
  `RINGOTEL_API_KEY`, and explains that features are gated by default so `PORTAL_FEATURES` is optional.
- **The unconfigured-deployment setup page** now points at `CONFIG.md` rather than `SETUP.md` for settings.

## [0.3.0] — 2026-08-09

**The standalone viewer is gone from this project.** It moved to its own repo, and this one is the portal
backend and nothing else. If you run this in portal-backend mode — which is what the deploy button and every
recent version of the docs set up — **nothing about your deployment's behaviour changes.** Upgrade normally.

⚠️ **If you were running it WITHOUT `PORTAL_MODE`** — the standalone call-flow viewer at `/`, with a stored
`NS_API_TOKEN` behind Cloudflare Access — **do not upgrade to 0.3.0.** That product is not here any more.
It has its own project now; stay on 0.2.47 until you have moved. This release fails closed rather than
silently (every request is refused, because there is no stored credential left to serve), but nothing in
the deployment will tell you why, which is the reason this paragraph exists.

### Removed

- **Two routes: `/` and `/app`.** `/` still answers — with the same page explaining there is no UI here —
  so a stray bookmark gets an explanation rather than a bare 404.
- **Five settings**, which are no longer read: `NS_API_TOKEN`, `ALLOW_UNGATED_SERVICE_TOKEN`, `ACCESS_AUD`,
  `ACCESS_TEAM_DOMAIN`, and **`PORTAL_MODE`** itself. Leaving any of them set in your `wrangler.jsonc` is
  harmless — nothing reads them and nothing errors — so there is no migration step. Delete them when
  convenient.
- **The Cloudflare Access gate and the stored-credential exposure gate.** Both existed to protect a
  credential this deployment never had. An Access gate in front of a portal backend could never work
  anyway: the Manager Portal loads the injected primary with a plain `<script src>`, which cannot complete
  an Access login.
- **Two console cards** (Access, exposure) and the Access check on the Checks tab, along with the
  "not applicable to this deployment" treatment on the Config tab — with one product there is nothing left
  that a setting can be inapplicable *to*. The Config tab now lists 61 settings, all of them live.

### Changed

- **`PORTAL_MODE` is not a mode selector any more, because there is only one mode.** Every conditional it
  guarded is now unconditional. A deployment that never set it behaves identically to one that set it to
  `1` — which is the direction that matters, since the failure mode of forgetting it used to be a Worker
  that served nothing.
- **`Auth.principal` is required.** Three internal checks used to treat a missing principal as permission —
  skipping the feature-policy check, granting a fleet-wide cache rebuild, and skipping the fresh-token
  re-validation before a write. Each was correct while a stored-credential caller existed. With every
  caller now delegated they would have become allow-by-default branches, so they are gone and the type
  enforces what `resolveAuth` already guaranteed.
- **The local dev launcher no longer resolves a NetSapiens credential.** It was handing a broad fleet-read
  token to a Worker that ignores it, and forcing a secret-store unlock on every dev boot for nothing.

### Notes

- The route table was verified line-by-line across the change: 24 path comparisons before, 24 after,
  differing only by the removed mode guard. Nothing was dropped — including the injected primary, whose
  route is built from a template literal and would not have shown up in a naive check.
- 2001 offline tests pass. The ~100 that went with this release were the ones describing the removed
  product; the ones that merely *used* it as a convenient way to authenticate were converted to a delegated
  caller instead, so their coverage of the portal read path is intact.

## [0.2.47] — 2026-08-09

### Fixed

- **`domains` was the only targeting axis whose in-axis `"*"` did nothing.** `users`, `scopes` and `app`
  each fall back to their own `"*"`; `domains` did not. So
  `{"domains": {"*": ["A"], "acme.example": []}}` — the "change everywhere except some" shape the
  documentation describes and the console's own examples teach — validated green and then matched nothing,
  anywhere. A rule that silently never fires is the exact failure every other axis throws a startup error
  to prevent. The workaround (a top-level `"*"` with domain exceptions) still works and is unchanged.

- **The menu builder could delete a working configuration.** Menu names are matched case-insensitively at
  runtime, so `{"Apps": {…}}` is valid config that genuinely applies — but the builder seeded itself from
  the raw key while looking the menu up by its canonical lowercase name, found nothing, and emitted an
  empty menu. Since the builder emits the *complete* configuration rather than a diff, pasting that output
  removed the running config. It now normalises keys the same way the code that acts on them does.

- **Two operator URLs failed silently instead of loudly.** A non-`https` `STATUS_BANNER_WEBHOOK` was
  dropped when the bundle was built, so the banner read as configured and simply never appeared;
  `PORTAL_RELEASE_NOTES_URL` was not validated at all, though it becomes an `href` in the portal footer and
  the console header. Both are now startup errors, matching how every other operator URL here already
  behaved.

### Changed

- **The Checks tab shows only the checks that mean something in this deployment's mode.** Cloudflare Access
  is a standalone-mode control — a portal-backend Worker stores no credential for it to protect, and an
  Access gate in front of one would refuse the plain `<script src>` that loads the injected primary — so
  that row no longer appears in portal mode. It is unchanged in standalone. This is the other half of the
  0.2.31 change that removed the Access *settings* from the Config tab for the same reason.

- **A new check for the status-banner endpoint**, in portal mode, on the button with the others. It makes
  the same call the injected code makes and separates the four outcomes that matter: unreachable, a non-2xx
  reply, a 2xx reply carrying no field the parser accepts (it names the accepted fields), and a usable
  message, which it shows. The third is why this exists — an endpoint that answers 200 with the wrong shape
  draws nothing and reports nothing, and from inside the portal that is indistinguishable from the feature
  being switched off.

- **The status banner's feature card described a renderer that was replaced before release.** It said the
  reply was inserted as text and could not carry markup, while the settings list and the code both allow
  simple HTML through an allow-list. The card overstated a safety property; it now describes what the code
  does.

### Documentation

- **Nine corrections, the important ones where a document overstated something.** `access.ts` is not
  merely inactive without its two variables — it is inert in portal mode by construction, and saying only
  the former implied a perimeter a portal deployment does not have. Portal mode was described as storing
  "no credential at all" without the event-subscriptions exception. `RINGOTEL_EXCLUDE_NAMES` documented
  three defaults where there are ten, and they are case-insensitive *substring* matchers including bare
  `VOICEMAIL` and `ROUTING`. The paid subrequest ceiling is 1,000, not 10,000. And `kit.status` levels
  were said to be "refused at deploy time" with the Worker refusing to start; in fact the deploy succeeds
  and every route after `/health` returns 500 — a different thing to look for.

- **`PORTAL_HANDOFF_URL` is documented as the portal-mode blocker it is.** Leaving it out holds `/health`
  at `configured:false`; absent and `""` look identical in a config file and mean opposite things here.
  Both states are now in a table with the reason the distinction exists.

### Testing

- **`pnpm test` runs every offline suite**, not five of eighteen. It previously skipped every gating
  suite — features, menus, kit, eligibility and the console — while `AGENTS.md` told contributors to run
  it. `test:worker` is included and needs no arguments: it falls back to the fictional snapshot shipped in
  `test/snapshots`, and the note claiming it required customer data was wrong.

- **Two long-standing call-flow failures are fixed, and were not what they appeared to be.** They compared
  a graph resolved from a raw fixture against one the Worker assembled through `fetchDomainSnapshot`, then
  attributed the difference to the route. Both graphs held the same nodes; the assembled one carried two
  additional edges because the graph builder collapses an edge whose target is an ancestor on its current
  traversal path, which makes the rendered edge set depend on the order the input arrived in. The
  assertion now holds the input constant and varies only the delivery path, which is what it was for.

## [0.2.46] — 2026-08-09

### Fixed

- **The footer version line could appear twice, and one of the two was a ghost.** What looked like a
  duplicate was one real entry plus a *fossil* of an earlier one. The kit appends its entry to the portal's
  version row; a vendor add-on may then rebuild that row from its text content, which inlines the kit's
  entry into the add-on's own link as plain characters and destroys the element around it. The text survives
  with
  nothing marking them, so the de-duplication could not see them — it found no entry at all and correctly
  added a fresh one to the row that now existed, leaving both on screen.

  The kit now removes that fossil before deciding where to write, matching its own product name and version
  and taking the separator with it. Since it only ever removes text this kit put there, and since
  clean-then-ensure is idempotent, an early write is now safe to correct rather than something to avoid —
  which matters on a portal where no vendor add-on loads at all, where waiting would have meant showing
  nothing.

  Two smaller parts of the same fix: the version line is re-checked on a few late passes that outlive the
  8-second mutation observer, because a footer rebuilt after that window used to stay wrong until reload;
  and pages rendered by older versions heal on their next load, because both the old and new separators are
  matched.

- **The separator now matches the portal's own, byte for byte** — non-breaking space, pipe, non-breaking
  space. It previously used a box-drawing bar with ordinary spaces, which rendered as a taller, heavier
  line beside the platform's own thin pipe in the same row. An entry added to someone else's row should not
  be identifiable as a guest.

### Documentation

- **Every setting has a stable link into SETUP.md now.** All 66 keys the console lists — plus each section
  — carry an explicit anchor, so `SETUP.md#RINGOTEL_WRITE_DOMAINS` keeps working when a heading is reworded.
- **Five settings that had never been documented** are now covered: `JWT_RATE_LIMITER`,
  `NS_EVENTS_PREFERRED_SERVER`, `NS_OAUTH_SERVER`, `PORTAL_RELEASE_NOTES_URL` and `RINGOTEL_APP_BASE_URL`.
  Worker bindings get a section of their own, and the release-notes URL is documented beside the status
  banner.
- **`AGENTS.md` covers the console, the banner and menus.** It had not been updated since 0.2.20, so an
  agent deploying from it never named a superadmin — and with `PORTAL_SUPERADMINS` unset nobody can open the
  integration console at all. It now asks for those accounts, sets them, and walks the operator to the page,
  including where the menu entry appears on a stock portal versus one with a vendor add-on.
- **Menu changes: try them on one account first.** SETUP now says plainly that any rule can be scoped with
  `users` or `domains` and widened afterwards, which is the whole preview mechanism on a live portal.
- **The 0.2.45 entry below described behaviour that did not ship.** It said the banner reply was rendered as
  text and not markup, while also saying HTML was supported four paragraphs later. HTML is supported; the
  entry now says so once, correctly.

## [0.2.45] — 2026-08-08

### Added

- **A status banner across the top of the portal**, with the message supplied by an endpoint you host. One
  setting turns it on: **`STATUS_BANNER_WEBHOOK`**. Unset, the feature is inert — nothing requested, nothing
  drawn, no half-configured state.

  **The kit stores no messages and decides nobody's eligibility.** It posts the caller's identity to your
  endpoint on each portal page load and shows whatever comes back, or nothing. That keeps the kit stateless —
  no database, no binding to provision — while letting you post and pull a notice without a redeploy. Write
  the logic you want behind that URL; a notice board, a maintenance schedule, per-customer messaging.

  Two deliberate constraints, both narrower than a hand-rolled banner:

  - **Simple HTML is supported, and it is rebuilt rather than inserted.** A welcome or support notice
    usually needs a link, bold, italics and `<br>`, so the reply may contain them. What it may not do is
    reach the page as markup: the response is parsed in an inert document and then copied across tag by
    tag and attribute by attribute, from an allow-list. `<script>`, event handlers, and `href`s that are
    not `https:` or `mailto:` are dropped whatever the endpoint returns, and an unknown tag is *unwrapped*
    rather than deleted, so a message never silently loses half a sentence to a stray `<div>`. Nothing
    script-bearing is ever copied, which makes the guarantee structural rather than a rule someone has to
    remember. Verified against a live `<img onerror>` payload: it does not execute.

    This is a backstop against a mistake, not a substitute for trusting the endpoint. It renders into
    every signed-in user's portal, so return only messages you trust.
  - **The endpoint must be https**, because the request carries the signed-in user's live `ns_t` so your
    side can decide what that person should see. Point it only at something you control: anything named
    there receives a working portal credential from every user who loads the portal.

  A plain-text reply works, as does JSON with a `message`, `banner_message`, `text` or `banner` field — the
  simplest endpoint someone can write should not be the unsupported one.

  **Placement adapts to the width, because the space it wants is not always there.** Measured on a real
  portal: above roughly 700px there is a ~30px strip between the top menu row and the button grid, and the
  banner overlays it so nothing on the page moves. Below that the menu row wraps onto its own line and the
  strip disappears entirely — so the banner takes a row of its own above the buttons instead of striking
  through them. It re-measures on resize and switches back. HTML in the message is supported (links, bold,
  italics) and is rebuilt from an allow-list rather than inserted as markup.

## [0.2.44] — 2026-08-08

### Changed

- **The builder now shows targeted menu rules instead of only naming them.** A rule that varies by scope,
  domain, account or app state still cannot be edited there — a flat tick-list cannot express targeting, and
  flattening it would quietly narrow it to one audience — but "not editable here" on its own told you a rule
  existed while hiding what it said, which is the worst of both: you could neither change it nor read it
  without leaving the tab. Each rung is now listed read-only, per axis and per key.

  An empty rung is named as `(nothing — an exemption)` rather than rendered blank, because an empty list is
  the "everyone except these" idiom and a blank line there reads as a bug.

## [0.2.43] — 2026-08-08

### Documented

- **§5a — a safe first deploy, when your portal is already live.** Most operators cannot experiment on
  production, and this kit injects into the portal every one of their customers uses. Every lever needed to
  start small already shipped; nobody had written the recipe. Restrict the deployment with `ALLOWED_DOMAINS`,
  name your own account on the two delivery gates so nobody else is served a bundle at all, point the portal
  at the Worker, then widen one axis at a time.

  It also states plainly what your other users experience in the meantime, rather than leaving it to be
  discovered: they still load the injected primary — it is public by design — and it is refused the gated
  bundles and injects nothing. "Everyone loads a small script that does nothing" is the honest description,
  not "nothing reaches them". If even that is unacceptable, the browser-local test harness changes no portal
  configuration at all.

## [0.2.42] — 2026-08-08

### Added

- **Menus can be targeted by account.** A new `users` axis alongside `domains`, `scopes` and `app`:
  `{"users": {"someone@example.com": [...]}}`. It is the **most specific** axis, so naming an account beats
  naming their domain — which is the only reason to name one, since it is how you carve an exception out of
  a domain-wide rule. Same rules as every other axis: case-insensitive keys, `*` is a default that never
  beats a rule naming you, an empty list exempts, and a key that is not a `user@domain` is a startup error
  rather than a rule that silently never matches. It uses the same "is this an account" test as
  `PORTAL_SUPERADMINS` and `PORTAL_FEATURES`, so three settings that name accounts cannot disagree about
  what an account is.

- **A secondary can be gated to named accounts too.** `PORTAL_SECONDARIES[].auth` now accepts any gate the
  feature vocabulary accepts — a level, a list of levels, or `{"levels": [...], "users": [...]}` — not only
  a level string. The gate resolver always supported it; this parse did not, so a *feature* could be granted
  to named accounts and a *script* could not. That asymmetry was an accident, not a decision.

### Fixed

- **The public primary no longer carries each secondary's gate.** It shipped the `auth` value into an
  unauthenticated script, which was merely unnecessary when a gate was a level like `reseller` and would
  have published an account list now that a gate can name accounts. The client's only question is whether an
  entry needs a token, so that is the only thing it receives: one boolean.

## [0.2.41] — 2026-08-08

### Documented

- **`PORTAL_MENUS` never said what you may actually write on the app axis.** Its description offered
  "targetable by … which app is active", which is true and unusable: the keys there are a fixed set — an app
  name, `none` for a domain with no app active, and `*` for any state — and anything else is a startup error.
  The description now names them, states the precedence (domain, then app, then `*`), and points at the Menus
  tab. The **example** now demonstrates the app axis too, instead of the bare add-a-link case that nobody
  needs help with. A test asserts the prose lists exactly the keys the parser accepts, so the two cannot
  drift apart.

## [0.2.40] — 2026-08-08

### Fixed

- **Opened outside the portal, the console no longer implies work is in progress.** Everything live on the
  page — the checks, the observed-page block, the builder's menu read — is a round-trip to the portal window
  that hosts it. Rendered anywhere else those messages go nowhere, and the page sat on **"Running…"** and
  **"Asking the portal page…"** indefinitely: states that assert something is in flight when nothing is. It
  now detects that it has no host and says so, the Run button is disabled with a reason instead of being
  left to fail, and the builder still loads your configured menus — the half that needs no portal.

## [0.2.39] — 2026-08-08

### Fixed

- **The menu builder's output would have deleted config you did not touch.** It emitted only the entries you
  edited in that session, and `PORTAL_MENUS` is replaced wholesale — so pasting it removed every menu you had
  not opened. It now **starts from the config your deployment is running** and always emits the complete
  thing, with untouched menus carried through exactly as they are.

### Added

- **A menu whose config is targeted** (by domain, scope or app state) is now **passed through untouched** and
  marked not-editable in the builder. A flat tick-list cannot express targeting, and flattening it to
  whatever applies at one rung would quietly narrow it to a single audience.
- **Entries you have already added are editable in place** — same row as a new one, rather than read-only
  text above the editor.
- **Hide an entry by name.** Ticking what is on the page cannot be the only route: the account menu relabels
  itself by context (`My Account` in one, `Profile` in another), and other injected code can add entries this
  page load never showed. Hides for labels that are not on this page stay visible, listed separately, rather
  than disappearing from the builder.
- **Reset to the running config** — discards the session's edits. Not "reset to empty": empty is a config
  too, and a destructive one.
- Each menu now says **who can normally see it**, including that the Management menu is not part of a stock
  portal.

## [0.2.38] — 2026-08-08

### Fixed

- **The footer version line could appear twice.** It attached to "the last paragraph in the footer", and a
  vendor add-on appends its own version row *asynchronously* — so that rule resolved to the "Powered by" line
  when the kit ran first and to the version row when it ran second. One rule, two destinations, decided by
  load order.

  It now targets **the row that carries a version**, identified by containing one rather than by position,
  and waits for that row instead of settling for another paragraph. The guard is also self-healing: it
  removes any stray copy and inserts exactly one, because the previous guard could only decline to add a
  second — and a second appeared anyway. Verified against the exact sequence that produced it.

## [0.2.37] — 2026-08-08

### Added

- **A Menus tab, with a builder.** Menu customization is the one capability that works with no other
  integration, so it is where most deployments start — and its config is the most annoying to hand-write,
  because `wrangler.jsonc` wants the JSON embedded as an escaped string.

  **The builder reads the menus off the portal page you opened the console from.** You tick real entries
  instead of typing labels and hoping they match — which matters because hiding a stock entry means naming
  a label only your portal knows, so a drawn mock-up would be wrong for every deployment but the one it was
  drawn against. Entries this kit added itself are excluded: offering to hide your own addition would
  compose a config that contradicts itself, and the hide would not work anyway, since hides run before adds.

  It emits both forms — readable JSON and the escaped `wrangler.jsonc` line — each copyable. The escaped one
  is derived by stringifying the string rather than hand-escaped, so it cannot disagree with what the file
  will parse.

  **The result is checked by your deployment's own validator, not by a second copy of the rules.** The
  builder round-trips the candidate to a new `GET /kit/menus/check` (gated on `kit.status`, reads no config,
  writes nothing) and reports what `menuConfigError` actually says. The rules it enforces include a phishing
  guard — no `{variable}` in a URL's host — and a browser-side copy of that is a copy that can drift.
  "Could not check" is a third outcome, never rendered as valid.

  The tab also shows **what your config does now**, per menu, server-rendered. A menu whose config is
  targeted by domain, scope or app state says so: one rung is not "the config" when other users get others.

### Fixed

- **The console had no entry point on a portal without a Management menu.** That menu is found by its
  toggle's label — it carries no id and no href — so the match misses a portal that renames it, one that
  does not have it, and any scope the portal hides it from. In all three cases the bundle shipped, the
  routes answered, and there was nothing to click. It now falls back to the account menu, which is found by
  its sign-out entry plus the user's own profile link rather than by a name. Same gate either way, so which
  menu carries the entry changes nothing about who can open it.

### Documented

- **Where the console entry actually appears, corrected.** `SETUP.md` told you to open it from
  **Management → Super Portal Kit**. That menu is **not stock** — verified against a portal running no
  add-ons at all, which has no Management menu — so on a default NetSapiens portal the entry appears at the
  top of your **own name dropdown** instead. Same gate, same page. The old instruction was wrong for exactly
  the reader least able to work out why.
- **The `account` menu's entries change with the view, and a hide matches labels exactly.** A reseller sees
  `My Account` and `Messages` while managing a domain, and `Profile` in the top-level view — one menu, not
  two. Hiding one label does nothing in the view that uses the other, so list every label an entry goes by.
  A hide that matches nothing changes nothing, which makes that safe advice.

### Changed

- **The builder says out loud that it sees one page, as one person.** Portal menus vary by page, by scope,
  and by whether you are viewing a domain or your own profile — so the entries it lists may not be all there
  are. Without saying so it quietly implies its list is complete, which is the kind of wrong a builder makes
  confidently.
- The console's Management entry is now marked internally, so anything walking that menu can tell this kit's
  own entry from the portal's. Nothing visible changes.

## [0.2.36] — 2026-08-08

### Changed

- **Setting both `PORTAL_APPS_HIDE` and `PORTAL_MENUS["apps"].hide` no longer breaks the deployment — the two
  hide lists merge.** It used to be a fatal config error, and that error ran *before routing*: two overlapping
  cosmetic settings returned 500 on every route except `/health` and the console, **including the injected
  primary**, so the entire portal add-on went dark for every user. A hide list should not have the largest
  blast radius of any setting in the kit.

  The risk the error was guarding against was real — two places to look for one answer is how a menu ends up
  wrong with nobody able to say why — but the remedy was aimed at the wrong thing. What actually addresses it
  is making the answer visible: the console now shows the effective list with **each entry attributed to the
  setting it came from**, and the setup checklist raises a warning (not a blocker) when both are set. A
  precedence rule was the other candidate and is worse — it silently discards a setting somebody wrote, which
  is the failure mode hardest to debug.

  Hiding is idempotent and commutative, so a union is the only merge with no order dependence and no lost
  information. A label named by both is hidden once, case-insensitively, and per-domain/per-scope/per-app
  targeting on the `PORTAL_MENUS` half is unaffected.

### Documented

- **Hides are applied before adds**, and that order is now part of the documented contract rather than an
  accident of two statements in one function. A hide names a *stock* entry, so it acts on the menu as the
  portal shipped it — which is what keeps the two lists independent: a hide can never remove one of your own
  additions, and neither list's meaning depends on the other. There is now a test asserting it.

## [0.2.35] — 2026-08-08

### Added

- **A version line in the portal footer** — `<your brand> Portal Kit: <version>`, appended to the platform's
  own version row with the same separator it already uses, so anyone looking at a portal can tell which
  version of this kit is behind it without the footer growing a line. **Reseller scope and above get it linked** to that version's release notes; everyone
  else gets the same words as plain text, with no link in the page at all rather than a disabled one. Gated by
  the new registry key **`portal.versionLine`** (default `all`), and off in one line if you don't want it.
  It reuses `PORTAL_RELEASE_NOTES_URL`, so setting that to empty removes the link from both the footer and the
  console header at once.
- **`FeatureDef.deliveredBy`** — a feature now *declares* which injected bundle carries it, rather than having
  it inferred from a `me.` prefix in its name. Two features already needed the self bundle's reach without
  being about the reader's own account; the second one is what made the inference untenable. `SETUP.md` now
  says which those two are, because turning `portal.self` off also turns them off — the one surprise in that
  switch.

- **The Backend tab now says what the portal page actually loaded**, under the configured addresses: whether
  the vendor hand-off is really on the page, whether this kit is what put it there or found it already
  present, and which hosts the page's scripts come from. Chain loading was never unverifiable — it was
  unverifiable *from inside the sandboxed iframe*, and the console's own bundle runs in the portal page,
  where it can simply look. It costs no network call and fills itself on open.

### Changed

- **"Status Console" is now "Integration Console"**, in the modal frame, the page heading and the browser tab.
  The name was accurate for a page that reported configuration; it is about to describe cross-system matching
  too, and renaming it before that arrives is cheaper than renaming it after.

## [0.2.34] — 2026-08-08

### Added

- **The version number in the console header links to that version's release notes**, so "what am I running"
  and "what changed, and am I behind" are one click apart. It points at the release list anchored to your
  version rather than the single-release page — the list also carries a version sidebar and a compare control,
  so it answers the second question too, and if the anchor ever stops matching you still land somewhere that
  says which version it is showing.
- **`PORTAL_RELEASE_NOTES_URL`** to override that, with `{version}` substituted anywhere it appears — for a
  fork, or your own documentation. Three states, the same shape `PORTAL_HANDOFF_URL` uses: absent takes the
  default, a value is yours, and **present-but-empty means never link at all**, which is how you keep the
  version visible while switching the link off.

## [0.2.33] — 2026-08-08

### Added

- The status console's title now reads **"… Portal Kit - Status Console"** in the modal frame, the page
  heading and the browser tab, which previously carried three different wordings for one thing.
- **A clear button in the Config filter**, so you no longer select-and-delete to get back to the full list.
  Escape clears it too. Drawn rather than left to the browser: `type="search"` gives some browsers a clear
  button and others nothing, which would mean the control existed for some readers and not others.
- **Every modal the kit opens now has an accessible name.** The iframe had none, so a screen reader announced
  it as "frame" — this covers the call-flow diagrams as well as the console.

- **A copy-ready `wrangler.jsonc` line for the value a setting holds now**, beside the readable form. A var's
  value is a JSON *string*, so an object-valued setting has to be embedded with every quote escaped — and the
  console was showing you a pretty-printed value and a generic escaped *example*, which is useful right up
  until you have a real value. After that it left you hand-escaping your own edit, which is where a stray
  quote silently breaks a deploy.
- **A first-five-minutes section in `SETUP.md`**, which did not exist before: name a superadmin, check
  `/health` reports the version you deployed, then open the console and work through the badge, the setup
  issues, anything reading *inert*, the addresses and the checks. Plus what the console cannot tell you —
  serving the injected primary and being loaded by a portal are different facts.

### Changed

- The vendor hand-off card no longer claims more than it can see. Declaring no hand-off means *this Worker*
  chain-loads nothing — the vendor router may still be loaded by a static loader or by other code that is not
  this kit, which is a normal arrangement. The card said "this deployment is the only script in the chain",
  which contradicted its own "unverifiable from here" marking.
- `PORTAL_SUPERADMINS` is now listed among the settings you actually need for a portal deployment, rather than
  under gating. With nobody named, the status console admits nobody — including you.
- `PORTAL_APPS_HIDE` is grouped with the other menu setting instead of with app access. It was filed by where
  it originated; what it does is hide menu entries, and setting it *and* `PORTAL_MENUS`' apps hide list is an
  error you can only notice if the two are adjacent.
- Both menu settings now say what "configuration error" actually costs here: every route except `/health` and
  the console returns 500 until it is fixed, including the injected primary — so the whole add-on goes dark,
  not just the menus.
- `PORTAL_APPS_HIDE` is no longer described as "legacy". It is older and terser and fully supported; the
  release that introduced `PORTAL_MENUS` said so explicitly. Its one real advantage is the comma-separated
  form, which needs no escaping — its JSON form has no advantage over `PORTAL_MENUS` at all.
- The `SETUP.md` "not sure if you're done?" instruction no longer points at `/` unconditionally: that is a
  deliberate 404 in portal backend mode.

## [0.2.32] — 2026-08-08

### Added

- **Every card on the Backend tab now explains why it exists**, the same treatment the Integrations cards got.
  Authentication covers the two modes and, more usefully, what does *not* change between them: a valid token
  always yields a policy-gated principal, so there is no authenticated-but-ungated path. The domain lists
  explain why there are two and when each is the right one. The cache namespace explains what actually goes
  wrong without a distinct value. Injection explains why the first script is public and neutral while the rest
  are gated per role — and why that lets a feature's bytes be withheld rather than merely hidden. Rate limiting
  explains what it protects and why the binding is optional but worth having.
- The longer Integrations cards gained subheadings too, so a card with five paragraphs reads as sections
  rather than as a wall.

### Changed

- **Backend cards are full width, one per row**, now that each carries several paragraphs — and they show
  their requirements inline for the same reason, since at that width the settings list is shorter than the
  control that would hide it.
- **The explanatory prose stops shouting.** It had been using ALL-CAPS for emphasis — and in several places to
  do a heading's job. Long cards now use small subheadings, and the remaining emphasis is carried by the
  sentences. A test guards against the habit returning, with an allowlist for genuine acronyms and literal
  setting names.

## [0.2.31] — 2026-08-08

### Added

- **An Addresses block on the Backend tab.** The console reported which settings were *set* and never what
  they compose into, so an operator had to assemble scheme + hostname + basename + `.js` in their head to get
  the one string they actually paste into a portal. It now shows that string, the vendor hand-off it
  chain-loads, where the gated bundles live, and the change-event callback origin — each marked *serves* or
  *calls*, and marked **unverifiable from here** where this Worker genuinely cannot confirm it. Serving the
  injected primary says nothing about whether a portal is loading it, and the page says so rather than
  implying otherwise.
- Setting links show a short current value inline where there is one, so a card answers "what is it set to"
  without a trip to the Config tab. Never for secrets, and long values are omitted rather than truncated.

### Changed

- **The Deployment tab is now "Backend", and sits after Config.** The old name read as a noun about the act
  of deploying; the tab is about this Worker — the backend half of the injected add-on. Its position now
  matches its value: worth keeping, least often needed.
- **Cloudflare Access and the service-token exposure gate are no longer shown at all on a portal-backend
  deployment** — not dimmed, not present, whether or not they happen to be configured. Neither can do
  anything there: every caller supplies their own `ns_t`, no stored token is ever read, and an Access gate
  would refuse the plain `<script src>` that loads the injected primary. Their settings are gone from the
  Config tab for the same reason. **A standalone deployment is unaffected** and still shows both, where
  Access is the only thing in front of a stored token's full NetSapiens scope.
- **`NS_API_TOKEN` and `NS_API_KEY` now explain themselves on both rows, and the difference between them.**
  They are mechanically the same kind of value — both are NetSapiens bearer tokens, sent as-is — so the names
  imply a technical distinction that does not exist while hiding the one that does. `NS_API_TOKEN` is the
  standalone deployment's read credential and is never read in portal mode; `NS_API_KEY` is the background
  service identity, used where work runs with no signed-in caller. There is deliberately no fallback between
  them, and `NS_API_KEY`'s row now says outright that setting `NS_API_TOKEN` will not satisfy it.
- The background-identity card names the four operations that cannot run without it — creating subscriptions,
  renewing them, removing them when the feature is switched off, and the NetSapiens writes the event handler
  makes (adding and removing a user's softphone device, and deactivating an app record on deletion) — plus why
  a stored credential is the only way to do any of them: background work has no session to borrow.

## [0.2.30] — 2026-08-08

### Added

- **Portal menu customization now explains itself properly**, and sits first on the Features tab. It is one
  of the few capabilities here that is useful on its own — it needs no other integration — and it had a
  one-line description. The card now covers which three menus can be targeted and why they are addressed by name rather
  than by CSS selector, the three conditional axes (domain, scope, and whether your app is active), the shape
  of the value, the fact that setting both this and the older `PORTAL_APPS_HIDE` is a loud error rather than a
  merge, and the one thing it is not: hiding a menu entry is cosmetic, and must never be used to lock a
  feature.
- Feature cards can carry that kind of explanation; ones that do span the full width and sort first, so the
  capability someone came for is the first thing on the tab.

### Changed

- **Portal menu customization is no longer filed as self-service.** It is operator configuration applied to
  every user — nothing about it concerns the reader's own account — so describing it as self-service sent an
  operator looking for a per-user setting that does not exist.
- An integration's parts start expanded while only one integration has any, since a collapsed group nobody
  knows exists is undiscoverable. They collapse and behave as an accordion once a second integration has parts.
- Prose may contain inline `code`, which was previously rendering as literal backtick characters.

## [0.2.29] — 2026-08-08

### Changed

- **The single-sign-on card now says what it does NOT do.** Naming the SSO service makes this portal *claim*
  SSO — it does not make single sign-on function, and an operator who set it expecting otherwise would have a
  portal confidently telling users about a sign-in method that fails for them. The card now spells out the
  three separate things that must all be true, and which one this kit is responsible for: a separate SSO
  Worker deployment that this kit cannot see; enablement on the app platform's side by their support, pointed
  at that Worker, possibly as a licensed capability, which nothing here can verify; and the portal-side
  surface — indicators, settings and user lifecycle handling — which is the part this setting switches on.
  The `RINGOTEL_SSO_SERVICE` and `SSO_AUTO_ACTIVATE` rows on the Config tab carry the same warning, since a
  reader who arrives there by filtering never sees the card.
- **The Config tab's sections collapse, and it opens as an index.** 64 settings across 12 sections was too
  long to be useful flat. Opening one section closes the others; the filter opens every section it matched
  and restores the index when cleared; and following a setting link from another tab opens the section it
  lands in rather than scrolling to a closed box.
- **"Back to top" goes to the top of the page**, not the top of the panel. The header and tab bar sit above
  every panel, so the previous behaviour left them off-screen — which defeated the purpose, since the usual
  reason to go back up is to switch tabs.

## [0.2.28] — 2026-08-08

### Changed

- **An integration's parts are collapsed by default, with their states on the toggle.** Now that every card
  carries several paragraphs, an all-expanded tab was thousands of words before the second integration. The
  toggle shows how many parts there are and how many are on, inert or off — which is what you scan an
  integration for, so collapsing costs nothing you were using; the prose is what you open it for. Built with
  `<details>`, so it behaves identically with JavaScript unavailable.
- **Requirements and settings are always visible on the full-width cards**, rather than behind a disclosure.
  At that width the settings list is one or two wrapped lines — shorter than the control that hid it — and
  what a card is *missing* is the actionable part, so a card reading INERT now says what is absent without
  being asked. The three-across cards on the Deployment tab keep their disclosure, where the same list wraps
  to five or six lines and hiding it still earns its place.
- Every card carries a small "top" control, since a card with prose can now be taller than the screen on its
  own.
- The two unwired integrations no longer repeat "nothing to configure" three times on one card — their
  description, their prose and a note all said it, and the note was the least informative of the three.

## [0.2.27] — 2026-08-08

### Added

- **Each integration now explains why it exists**, not just what it is. Every card on the Integrations tab
  carries a few paragraphs above its settings covering the two questions a one-line description cannot: why
  this exists at all, and — the one nothing here addressed before — **why there are several options**. A
  reader looking at three independent exclusion mechanisms, or two ways to supply one credential, cannot tell
  from the names whether those are alternatives, layers, or historical accident; two of those three readings
  lead to configuring it wrong. So the app integration explains what a read-only connection buys and why its
  eight parts are drawn underneath it rather than beside it; the eligibility rules explain why not every
  extension is a person and why three overlapping mechanisms are needed rather than one; the write rail
  explains why it is separate from the feature gate that already decides who may write, and why it is the one
  setting in the kit that refuses everything when left empty; the change-event subsystem explains what drifts
  without it; and the background identity explains why it is deliberately not the same credential as the
  read token, and why there are two ways to provide it.
- The unwired integrations now say what they are **intended** to do and that they are unofficial, rather than
  only that they are absent.

### Changed

- Integration prose may contain a link, and the Integrations tab links out to the third-party products it
  names. Links are restricted to `https://` by a whitelist, escaped on both halves, and always opened with
  `noopener noreferrer` — a page embedded in a portal must not hand its opener to a new tab.

## [0.2.26] — 2026-08-08

### Changed

- **An integration's parts are laid out full width, one per row**, instead of three across. They are aspects
  of one thing in a deliberate order, not a grid of peers to scan, and three-across made them read as
  unrelated boxes. It also resolves the expansion complaint: at full width a card's settings list fits on one
  or two lines rather than five, so opening one grows it by about a line.

## [0.2.25] — 2026-08-08

### Added

- **Worked examples of every gate shape** on the Permissions tab. The two emitted `PORTAL_FEATURES` blocks
  are derived from your deployment, so they can only show you what you are already doing — three of the four
  gate shapes stay invisible on a typical config, including the one nobody finds by accident (a level plus
  named accounts). Every example is checked against this deployment's own validator before it is shown.
- **Per-cell override marks on the permissions matrix.** A ring around the mark shows which *cell* your
  configuration changed, and in which direction — solid where it granted access, dashed where it took access
  away. The row badge only said the feature was configured; this says what the configuration did. A gating
  change on a feature that cannot run either way is deliberately not marked, since it crosses no boundary you
  can act on.
- **An audience divider on the matrix**, so administrative features and self-service ones are visibly two
  groups. "App sign-in details on profile" and "My app sign-in details" are one letter of intent apart, and
  the names alone were not carrying it. Rows are now sorted by audience rather than happening to be adjacent.
- **Jump links on the long tabs** (Config, Features, Integrations), with a back-to-top on each heading.
  Config is 64 settings across 12 sections, and nothing on screen said what the sections were once you had
  scrolled past the first.
- **A way back after jumping to a setting.** Following a setting link from a card crosses tabs, and there is
  no browser history to return through, so there is now an explicit "back to …" control that restores the
  card you came from, not just the tab.
- **Setting descriptions on hover.** Every setting link carries its one-line description as a tooltip, so
  the common question — what is this setting? — no longer requires leaving the card at all.

### Changed

- **The "Named in gate" column now appears only when some gate actually names an account.** It was
  introduced in 0.2.24 to show that being named directly is not a bypass, but `users:` grants are the
  exception rather than the rule, so on most deployments it was a column of dashes — the same
  nothing-to-say row that was removed from the feature cards in the same release. Same rule, applied
  consistently.
- The `PORTAL_FEATURES` block on the Permissions tab opens by default when you have overrides configured.
  It was there before, collapsed, and therefore easy to miss.

## [0.2.24] — 2026-08-08

### Added

- **A Permissions tab on the status console** — the matrix the rest of the console was working around.
  One row per feature, one column per NetSapiens scope, plus two columns for the account-based axes
  (an account listed in `PORTAL_SUPERADMINS`, and an account a feature's own gate names directly). Each
  cell answers three questions at once, in the order the Worker actually applies them: does the gate admit
  this person, do they receive the bundle that carries the feature, and can the feature run as configured.
  "Allowed" and "works" are different answers, and the marks distinguish them.
  - A **scope picker** highlights one column and summarises it in a sentence. It re-reads the verdicts
    already rendered rather than re-deciding anything, so it cannot disagree with the table above it.
  - Where a gate has an `allowedLevels` floor, the levels it puts out of reach render as **unavailable**
    rather than merely un-granted — otherwise the rule is something you learn by trying it and getting a
    startup error.
- **Copy-pasteable `PORTAL_FEATURES`.** The console still writes nothing (a Worker cannot change its own
  environment), but it can hand you the exact text, in two forms with their consequences stated:
  *overrides only* (round-trips, keeps built-in defaults for everything else — the one to prefer) and
  *fully explicit* (unambiguous, but pins every feature, so a later release that changes a default will
  not reach you). Both are validated against this deployment's own parser before being offered.
- **A Deployment tab**, so features, external integrations, and how-the-Worker-runs are three things
  rather than two. Authentication, the Access gate, the exposure gate, injection, menus, branding, domain
  limits, cache namespace, device enrichment and rate limiting live there.
- **Jump-to-setting.** Every setting named on a feature or integration card is now a link that switches to
  the Config tab and highlights that row, instead of a bare name to memorise and go find.

### Changed

- **Cloudflare Access is now ignored in portal-backend mode** rather than honoured. It could never work
  there: the Manager Portal loads the injected primary with a plain `<script src>`, which cannot complete
  an Access login, so setting `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` on a portal deployment would take the
  whole injection down — while there is nothing for it to protect, since portal mode never reads a stored
  `NS_API_TOKEN` (every caller supplies their own `ns_t`, and that is the gate). The setting is now inert
  there, in one place, so every consumer inherits it; the console reports it as *configured but ignored
  here, and why*, and the setup checklist no longer asks you to "finish" configuring it. **Unchanged for
  standalone deployments**, where Access remains required and is the only thing in front of a stored
  token.
- **Integrations now own their own parts.** Activation rules, the write rail, self-service app access, SSO,
  change events, offboarding and the background service identity are shown nested under the app
  integration they belong to, instead of as sibling cards with no indication they are related. "Everything
  below here is off because the API key is unset" is now one visible fact rather than nine repetitions.
- **The Features tab is split by audience.** Administrative features (what you do to other people's
  accounts) are separated from self-service ones (what a signed-in user sees about their own account),
  because the second kind is about *your users*, not about you.
- **The word "Gate" is gone from the interface**, along with the per-card "you pass this gate" row. That
  row was true on almost every card for anyone who can open the console at all, so it carried no
  information; a card now says *who* it is available to, and only mentions your own access when the answer
  is no. Who-can-do-what lives on the Permissions tab.
- **The Config tab is grouped, ordered and annotated.** Sections by area rather than one flat list of 64;
  ordered by consequence within each; a real default value shown inline where one exists (distinct from
  what happens when a setting is absent, which is a different fact); JSON values pretty-printed, falling
  back to the raw string when they do not parse, because a malformed value is when you most need to see it;
  a literal example of the line to type; and settings that are behind an unconfigured gate, or that cannot
  apply in this deployment's mode, dimmed with the reason stated. The "why can't I edit this here"
  explanation is now stated once at the top of the tab instead of on all 64 rows.
- The Overview tab drops two rows that could only ever say one thing, relabels "Access granted by" (the
  value is a rule, not a person), and carries authorship and licence information.

## [0.2.23] — 2026-08-07

### Added

- **The Super Portal Kit status console.** A read-only page, reached from a **"Super Portal Kit"** entry
  in the Manager Portal's Management dropdown, that reports how this deployment is actually configured:
  which features are on, off, or gated-but-unmet; which subsystems (Ringotel, event subscriptions, the
  Access gate, and the rest) are wired up; every setting this deployment reads, its current state, and
  what it affects; and a set of live checks (NetSapiens reachability, Ringotel reachability,
  event-subscription state, and more), with a **Run Checks Again** button to re-run them any time.
  Secrets are reported by **presence only** — never a value, a prefix, or a fingerprint of one; the page
  can say `NS_API_TOKEN` is set without ever being able to say what it's set to.

  Served by two new routes: `GET /kit/status` (the data) and `GET /kit/spk.js` (the gated bundle that
  opens it). Both are gated by a new feature key, **`kit.status`**, which defaults to `superadmin` — so
  an unset `PORTAL_SUPERADMINS` means nobody sees this page, not everybody. Widening it via
  `PORTAL_FEATURES` is deliberately floored: it may name no level broader than `reseller`, refused as a
  configuration error at deploy time if you try. That floor is only half the gate — independently, at
  request time, the console additionally requires reseller scope or a listed superadmin account, because
  the page can report other customers' domain names. Naming a domain-locked account under `users:` does
  not open it.

  The console is served ahead of most of this Worker's own config validators, on purpose: a
  misconfigured deployment can still open this page and read why, instead of only getting an opaque
  error from the route it actually needed.

### Changed

- **The Checks tab now runs its live checks once, automatically, the first time you open the tab in a
  given console session** — not on every load of the console, and not again if you switch away and back.
  Opening the console at all already requires the superadmin gate, so the original on-demand rationale
  (checks cost upstream calls) still holds for the console as a whole; asking a second time, for the tab
  itself, was friction without added consent. The **Run Checks** button becomes **Run Checks Again** once
  results exist, and re-runs the same checks with the same per-row cost disclosure at any time.

- **The console's own refusal now explains itself when nobody at all is let in.** If `kit.status` is
  switched off, or `PORTAL_SUPERADMINS` is unset so the default gate admits no one, the 403 says which
  setting to fix instead of the same bare "Not authorized" a merely-unqualified caller would also get.

- **A routine "not entitled" refusal of the console bundle is now a quiet 204, not a 403.** `GET
  /kit/spk.js` is fetched speculatively on every page load, for every signed-in user, so a non-superadmin
  being turned away is the normal, permanent state — not something worth a loud error status. It now
  answers with an empty `204 No Content` instead. A misconfiguration that stops *anyone at all* from
  opening the console — `kit.status` switched off, or no `PORTAL_SUPERADMINS` named — is unaffected and
  still answers `403` naming the setting to fix, and `GET /kit/status` (the page itself, only ever
  requested after the menu entry was already shown) keeps its `403` and message for every refusal.

### Fixed

- **The Checks tab's intro no longer contradicts the results below it.** A live run happens entirely in
  the browser — results are injected into the tab without a new page load — so the "Nothing has been run
  yet" intro used to sit there, unchanged and now false, directly above a completed run's rows. It now
  updates in place to describe results being present, tied to the same rendering the initial page uses so
  the two cannot drift apart again.
- **The event-subscriptions check no longer says "not armed" twice in one sentence.** One of its inputs
  already reads as a complete "not armed" sentence; the check was unconditionally prefixing its own copy
  of the same phrase onto it.
- **The service-identity check no longer reports an unused credential as "ready to use."** For an API-key
  identity this check makes no network call at all — its own stated cost says so — so a pass only ever
  proved the key was configured, never that NetSapiens would accept it. The wording now says exactly
  that, and keeps the admin-credential path (which does make a real call) visibly more verified than the
  API-key path.

## [0.2.22] — 2026-08-07

### Fixed

- **A user's extra email addresses are no longer destroyed by the identity sync.** The app lets a user
  add a second Email row to their profile, which turns that field into a list. The sync read the field
  as a single value, so a list read as *empty* — the stored address never matched the one in the phone
  system, and every user-change event rewrote it as a single value, discarding the extra addresses. The
  next event did it again.

  The sync now compares against the **first** address, which is the one the phone system owns and the
  one the app shows as the main Email. A matching address is a no-op, so a user who keeps extra
  addresses keeps them. Activation, deactivation and password reset use the same rule and no longer
  rewrite an address that already matches.

  **Removing an address is deliberately not symmetric**: when the phone system has no address for a
  user, every stored value is cleared, not just the first. Leaving a previous occupant's address behind
  is what the removal exists to prevent — app credentials are mailed to the stored address.

  This cannot be made lossless: the API rejects a list outright, so only the app can create one and no
  call can put a discarded address back. When a genuine change does collapse a list, the sync log line
  reports how many values were stored, so the loss is visible rather than silent.

  **Scope:** this covers the writes this service makes. If you also run a sign-in repair service against
  the same directory, it writes the address on every login and is not yet covered.

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
  user sees. See [CONFIG.md](./CONFIG.md#PORTAL_MENUS).

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
