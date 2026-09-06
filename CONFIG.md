# Configuration reference

Every setting this deployment reads, what it controls, and what happens when you leave it out.

**[SETUP.md](./SETUP.md) is the path; this is the map.** Setup tells you the handful of values a working
deployment needs and the order to do things in. This file is the full list, for when you want to turn
something on and need to know exactly what it takes.

**Your deployment already answers most of this about itself.** The integration console's **Config** tab
shows every setting *with the value yours currently has*, its real default, and a copy-ready
`wrangler.jsonc` line. Read that for *what is set*; read this for *what it means and what it costs*.

---

## Contents

- [How to read this](#how-to-read-this)
- [Core](#group-core) — `NS_SERVER` · `NS_PORTAL_ISS` · `ALLOWED_ORIGINS` · `CACHE_SCOPE` · `NS_DEVICE_DETAILS`
- [Domain limits](#group-domains) — `ALLOWED_DOMAINS` · `BLOCKED_DOMAINS`
- [Portal injection](#group-injection) — `PRIMARY_BASENAME` · `PORTAL_HANDOFF_URL` · `PORTAL_SECONDARIES` · `PORTAL_FEATURES` · `PORTAL_SUPERADMINS` · `PORTAL_RELEASE_NOTES_URL` · `STATUS_BANNER_WEBHOOK` · `RINGOTEL_APP_BASE_URL`
- [Portal menus](#group-menus) — `PORTAL_MENUS` · `PORTAL_HANDOFF_ORIGINS` · `PORTAL_APPS_HIDE`
- [App integration](#group-ringotel) — `RINGOTEL_API_KEY` and its display settings
- [OneBill](#group-onebill) — `ONEBILL_TENANT_ID` and its three secrets · `ONEBILL_LINK_GROUP` · `ONEBILL_USAGE_OFFERS` · `ONEBILL_USAGE_IGNORE` · `ONEBILL_RECURRING_RULES` · `NS_FAX_SERVER_HOSTS` · `NS_DEVICE_SUFFIXES`
- [Activation rules](#group-eligibility) — the write rail and the exclusion lists
- [Self-service app access](#group-appaccess) — `RINGOTEL_SSO_SERVICE` · `SSO_AUTO_ACTIVATE` · `PORTAL_APP_DOWNLOADS`
- [Change events](#group-events) — the 15 `NS_EVENTS_*` settings
- [Background service identity](#group-identity) — `NS_API_KEY`, or admin credentials + OAuth
- [Branding](#group-branding) — `BRAND_NAME` · `BRAND_ACCENT`
- [Worker bindings](#group-bindings) — `ASSETS` · `ONEBILL_DB` · `JWT_RATE_LIMITER`
- **Reference sections**
  - [Features and gating](#features-and-gating) — the level vocabulary, the feature registry, `PORTAL_FEATURES`, resolution rules
    - [Denying named accounts](#gate-users-deny) — `users.deny`: "everyone who has this today, except these people", and how to add one to a config you already have
    - [The domain-record keys](#domain-record-keys) — `portal.domainCreate` · `portal.domainEdit` · `portal.domainDelete`
  - [Menu targeting](#menu-targeting) — the axes, precedence, variables, URL rules
  - [Secondary scripts](#secondaries-reference) — `url:` vs `r2:`, and the round-trip rule
  - [Event subscriptions in depth](#events-reference) — what a callback URL is, retiring the feature, cost
  - [Where each value goes](#where-each-value-goes) — vars vs secrets, and what must never be committed

---

<a id="how-to-read-this"></a>

## How to read this

**Three places a value can live, and they are not interchangeable:**

| Kind | How you set it | Notes |
|---|---|---|
| **`vars`** | a `vars` entry in `wrangler.jsonc` | committed to your repo, so anyone who can read the repo can read the value |
| **secret** | `wrangler secret put <NAME>` | never committed, never readable back — not even by the Worker's own console |
| **binding** | a structural entry in `wrangler.jsonc` (`r2_buckets`, `ratelimits`) | not a string; adding a var of the same name creates nothing |

**Nothing is inherited between environments.** `vars`, secrets and bindings are all per-environment. An
`env.portal` block needs its own full copy of every var — a missing one does not warn, it is simply absent
at runtime.

**Put each key in exactly one place.** A key in both `vars` and `.dev.vars` is shadowed by the
`wrangler.jsonc` value. This is the classic way to "set" `ALLOWED_DOMAINS` and have it do nothing.

**Blank is always a safe answer.** Every setting below is off, inert, or at a documented default when
unset. Nothing here fails open: the settings that could be dangerous to guess at (the write rail, the SSO
claim, the superadmin list) refuse rather than assume.

**Each setting's anchor is stable.** `CONFIG.md#RINGOTEL_WRITE_DOMAINS` resolves and keeps resolving even
if the heading around it is reworded.

**A settings-only deploy takes up to about three minutes to reach a signed-in browser.** Server-side
answers — `/health`, the console, every data route — change the instant the deploy lands. The injected
client bundle does not: it is cached per tier inside the Worker under a key that includes the kit's
*version*, so a release replaces it immediately while a config-only deploy leaves that key identical. The
old bundle is then served until its own `max-age=60` expires, plus up to 120 seconds more in the browser
that already has it. This heals itself and needs no purge — but it is worth knowing before you change
`PORTAL_MENUS`, reload the portal, see the old menu and go hunting for a mistake in your JSON. Hard-reload
the portal tab, or wait. The console's **Config** tab is answered server-side, so it shows the value you
just deployed straight away — if it reports the new value and the menu still looks old, you are looking at
this cache and not at a broken config.

---

<a id="group-core"></a>

## Core

What this deployment is and how it authenticates.

<a id="NS_SERVER"></a>

### `NS_SERVER` · `vars` · **required**

Your NetSapiens API host — host only, no scheme, no path. Every read and write goes to
`https://{NS_SERVER}/ns-api/v2`.

- **Example** `api.example.com`
- **Unset** Nothing works. A fresh deployment ships the placeholder `api.example.com`, which is reported
  as a setup blocker by `/health` and by the console.

<a id="NS_PORTAL_ISS"></a>

### `NS_PORTAL_ISS` · `vars` · **required**

The Manager Portal hostname that issues your `ns_t` tokens — the `iss` claim inside them. Every token this
Worker accepts is matched against it.

- **Example** `manage.example.com`
- **Several portals, one backend** Comma-separate: `manage.a.example,manage.b.example`. Matched
  **exactly**; there are no wildcards, so `*.a.example` is a literal that matches nothing.
- **Unset** Every request is refused. Fail-closed on purpose: it has **no default**, because a default
  would mean accepting tokens minted by a portal you do not control.

<a id="ALLOWED_ORIGINS"></a>

### `ALLOWED_ORIGINS` · `vars` · **recommended**

Comma-separated, exact-match list of browser origins allowed to call this Worker cross-origin — normally
just your Manager Portal. Scheme included.

- **Example** `https://manage.example.com`
- **Unset** Empty allowlist: every cross-origin browser request is denied. The injected script runs on
  your portal's origin and calls the Worker on another, so in practice this must be set.

<a id="CACHE_SCOPE"></a>

### `CACHE_SCOPE` · `vars` · default `default`

Namespace for every cache entry this deployment writes.

- **Example** `portal-prod`
- **One Worker** Leave it alone.
- **More than one Worker on the same zone** Give each a distinct value. Cloudflare's `caches.default` is
  shared **zone-wide**, not per Worker, so two deployments at the same scope read and write one set of
  cached entries — each serving the other's data, and each suppressing the other's forced refresh.
- **How to check** `GET /health` reports the value in use. Compare the `scope` field across your
  deployments and make sure they differ. One deployment missing the setting degrades safely to its own
  namespace; *two* missing it quietly share one again.

<a id="NS_DEVICE_DETAILS"></a>

### `NS_DEVICE_DETAILS` · `vars`

Show each user's desk-phone model and live registration status on the agent lines of a call-flow diagram,
read live per render.

- **Example** `1`
- **Unset** Off — agent lines show no model or registration detail.
- **Cost** Extra NetSapiens reads on every diagram render.

Truthy values anywhere in this document are `1`, `true`, `yes`, `on`.

---

<a id="group-domains"></a>

## Domain limits

App-layer bounds on which NetSapiens domains this deployment will touch — **on top of** the caller's own
NetSapiens scope, never a replacement for it.

Comma-separated NetSapiens domain names, exactly as NetSapiens has them. A domain may be bare (`acme`) or
carry a territory suffix (`acme.12345.service`); use whichever form is real for you.

<a id="ALLOWED_DOMAINS"></a>

### `ALLOWED_DOMAINS` · `vars`

Allowlist. Set it and only these domains are listed; any other is refused with a 403 **even if the caller
could otherwise read it**.

- **Example** `acme.example,demo.12345.service`
- **Unset** No app-layer limit — bounded only by each caller's own NetSapiens scope.
- **This is the outer boundary of a first deployment.** See [SETUP.md § A safe first
  deploy](./SETUP.md#safe-first-deploy).

<a id="BLOCKED_DOMAINS"></a>

### `BLOCKED_DOMAINS` · `vars`

Hide specific domains and refuse every domain-scoped read against them — a DID-holding domain with nothing
to show, say.

- **Example** `0000.12345.service`
- **Unset** No domain is blocked beyond each caller's own scope.

---

<a id="group-injection"></a>

## Portal injection

What gets served to the Manager Portal, and who may receive it.

<a id="PRIMARY_BASENAME"></a>

### `PRIMARY_BASENAME` · `vars` · default `p`

The basename the injected primary script is served at: `/<basename>.js`. This is the value that decides the
URL you hand your portal.

- **Example** `p` → `https://your-worker.example/p.js`
- **Must match** `^[a-z0-9_-]+$`
- **Unset** Defaults to `p`.

<a id="PORTAL_HANDOFF_URL"></a>

### `PORTAL_HANDOFF_URL` · `vars` · **required — and absent is not empty**

The vendor bundle-router your primary should chain-load, so an add-on you already run keeps working
alongside this kit.

- **Example** `https://vendor.example.com/bundleRouter.bundle.js`

| Value | Meaning |
|---|---|
| **absent** | ⚠️ unconfigured — `GET /health` reports `configured:false`, and resellers see a warning banner |
| **`""`** (present, empty) | a deliberate "this Worker chain-loads nothing" — the right answer when you run no vendor add-on |
| a URL | chain-load that router |

Absent and empty look identical in a config file and mean opposite things here. That is deliberate, so
that "I have not decided yet" is never silently treated as "I decided no". **If you have no vendor add-on,
set it to `""`.**

**It will not double-load.** The primary checks the page first and skips the injection if a script with
that exact URL is already present. The match is on the exact URL string, so a different-looking URL for
the same file would load twice.

**Empty says nothing about the rest of the page.** The router may still be loaded by a static loader or by
other code that is not this kit — a normal arrangement. It should be loaded in exactly one place: if an
add-on is present and working while this is empty, something else is loading it, and that is where to look.

<a id="PORTAL_SECONDARIES"></a>

### `PORTAL_SECONDARIES` · `vars`

JSON array of extra scripts the primary should load for entitled callers, beyond the built-in bundles.

- **Example** `[{"name": "my-feature", "from": "url:https://cdn.example.com/my-feature.js", "auth": "public"}]`
- **Unset** No secondaries. The built-in features are unaffected.
- **Full syntax, the `url:`/`r2:` difference, and the rule about what may ship in client JS:**
  [Secondary scripts](#secondaries-reference).

<a id="PORTAL_FEATURES"></a>

### `PORTAL_FEATURES` · `vars`

JSON object overriding the built-in gate on one or more features — who sees the call-flow button, who can
activate an app account, what is switched off entirely.

- **Example** `{"callflow.view": "office_manager", "ringotel.orgList": "off"}`
- **Unset** Every feature uses its built-in default. That is a supported, complete configuration.
- **Vocabulary, the registry of keys, and the four accepted shapes:** [Features and
  gating](#features-and-gating).
- **An unknown key or level is a loud config error** — a 500 on every route after `/health`. It never
  silently allows.

<a id="PORTAL_SUPERADMINS"></a>

### `PORTAL_SUPERADMINS` · secret (recommended) or `vars` · **effectively required**

Comma-separated `user@domain` accounts that pass every gate regardless of their NetSapiens scope.

- **Example** `you@example.com,ops@example.com`
- **Unset** No superadmins — every feature is gated purely by NetSapiens scope.
- **Why it is effectively required** The integration console defaults to `superadmin`, and with nobody
  named it admits **nobody, including you**. It refuses with a message that says so, but you will have
  deployed a console you cannot open. Set it before you deploy.
- **What these accounts get** They are unioned into **every** gate — except one that targets *only*
  call-center levels — and they can be targeted directly by the `superadmin` level.

<a id="PORTAL_RELEASE_NOTES_URL"></a>

### `PORTAL_RELEASE_NOTES_URL` · `vars`

Where a version number links to. Two surfaces share it: the portal footer's version line, and the
console's own header. `{version}` is replaced with the version actually running.

- **Example** `https://github.com/you/your-copy/releases#release-v{version}`

| Value | Where the version links |
|---|---|
| **absent** | the public release list, anchored at your running version — right for an unmodified deployment |
| **a URL** | yours: your own copy's releases, or internal notes |
| **present but empty** | nowhere — the version is still shown, it just is not a link |

Linking the release *list* rather than one release page is deliberate: the list carries a version sidebar
and a compare control, so it answers *am I behind* as well as *what is in mine* — and if the anchor ever
stops matching, the reader still lands somewhere that states which version it is showing.

<a id="STATUS_BANNER_WEBHOOK"></a>

### `STATUS_BANNER_WEBHOOK` · `vars`

An `https` endpoint **you host** that returns the status-banner message for the caller, or nothing.

- **Example** `https://automation.example.com/webhook/portal-banner`
- **Unset** The banner is inert: nothing is requested and nothing is drawn. There is no half-configured
  state to get wrong.

**The call, exactly.** A `POST` on every portal page load, on every portal page:

```jsonc
{ "validate": "<the caller's ns_t>", "path": "/portal/home",
  "domain": "acme.example", "scope_mode": "...", "sub_scope": "...", "user": "..." }
```

Reply with plain text, or JSON carrying `message`, `banner_message`, `text` or `banner`. An empty body, an
empty string, or a non-2xx status all mean **show nothing** — that is how a notice comes down, and how a
failing endpoint stays invisible instead of breaking the portal. Nothing is cached; the endpoint is asked
again on the next page load, so a message appears and disappears as fast as your side changes it. That is
one call per page view — the payload includes `path` so your side can answer empty cheaply.

⚠️ **Point it only at an endpoint you control.** The request carries the signed-in user's live `ns_t`, so
whatever is named here receives a working portal credential from every user who loads the portal. It must
be `https` for the same reason.

**Simple HTML is supported** — links, bold, italics, and `<br>` — because a welcome or support notice
usually needs them. The reply never reaches the page as markup: it is parsed in an inert document and
copied across tag by tag from an allow-list, so `<script>`, event handlers and any non-`https`/`mailto:`
link are dropped whatever the endpoint returns. An unknown tag is unwrapped rather than deleted, so a
message never silently loses half a sentence. That is a backstop against a mistake, **not** a substitute
for trusting your own endpoint: this renders into every signed-in user's portal.

**Placement adapts to the window.** Where there is room it overlays blank space in the header, so nothing
on the page moves; where there is not, it takes its own row above the button grid. A long message shrinks
to fit rather than being truncated.

<a id="RINGOTEL_APP_BASE_URL"></a>

### `RINGOTEL_APP_BASE_URL` · `vars`

Base URL for a deep link to the app dashboard, shown on the gated feature surfaces.

- **Example** `https://app.example.com`
- **Unset** A plain text label instead of a link.

---

<a id="group-menus"></a>

## Portal menus

Adding, hiding and renaming entries in the portal's stock menus. Gated by `me.menuConfig` (default `all`).

> Hiding a menu entry is **cosmetic, not a security control.** It removes a link, not access to whatever
> the link pointed at. Never use it to "lock" a feature — that is what the gates are for.
>
> Renaming is cosmetic in the same way, and adds one thing worth knowing: a renamed entry can say
> something other than where it goes. That is not new power — anyone who can set this key could already
> hide an entry and add their own with any label and any URL, which is strictly more — and a rename never
> touches the destination. But it does mean the label is yours to get right.

**Use the builder, not this syntax.** The console's **Menus** tab reads the menus off the portal page you
opened it from, so you tick real entries instead of typing labels and hoping they match. It emits both the
readable JSON and the escaped `wrangler.jsonc` line, and validates the result against your own deployment
before you paste it anywhere. Everything below is what the builder composes — worth reading once, not
worth typing.

<a id="PORTAL_MENUS"></a>

### `PORTAL_MENUS` · `vars`

JSON adding, hiding and renaming entries in the **Apps**, **account** and **Management** menus, optionally
targeted by user, domain, NetSapiens scope, or whether your app is active for that domain.

- **Example**
  `{"apps": {"hide": {"app": {"ringotel": ["SNAPmobile Web"], "none": []}}, "add": [{"label": "Support", "url": "https://support.example.com"}]}}`
- **Unset** No customization from this setting. `PORTAL_APPS_HIDE`, if set, still applies independently.
- **Needs no other integration.** With no app API key set the app state is `none`, so static add, hide and
  rename work on any deployment.
- **Full targeting model, variables and URL rules:** [Menu targeting](#menu-targeting).
- **An entry can hand the user's session to another tool** — add `"handoff": "ns_t"` and list the
  destination's origin in [`PORTAL_HANDOFF_ORIGINS`](#PORTAL_HANDOFF_ORIGINS). See
  [Handoff entries](#menu-handoff).

**Which menus you can target.** Menus are referenced by name — you never supply a CSS selector, which
would break on portal updates and would turn an environment variable into a DOM-injection surface:

| Name | Menu | Where entries are added |
|---|---|---|
| `apps` | the portal's **Apps** dropdown | appended after the stock entries |
| `account` | the signed-in user's **own name** dropdown | into the first group, **above** the divider and the sign-out entry |
| `management` | the top-nav **Management** dropdown — **not stock**, added by a vendor add-on, shown to administrative scopes only. Targeting it on a portal that lacks it is not an error; nothing appears. | appended at the **end** |

**⚠ A menu is modified, never created.** Each of these is found in the page before anything is applied, so
an entry aimed at a menu a given reader does not have is simply absent for them — no error, no empty menu
conjured to hold it. This is per **reader**, not per portal: `Management` is shown to administrative scopes
only, so adding an entry to it for an Office Manager who has no Management dropdown changes nothing they
see. The same is true of `apps` and `account` wherever a portal omits them. If you are unsure whether a
role has a menu, masquerade as one and use the console's **Remember this role** button — the builder then
draws that role's real menus and says outright when one of them is absent.

An unknown menu name is a startup error. The `account` menu carries no id and shares a generic class with
other dropdowns, so it is located by its sign-out entry — the one item present in every variant. The
`management` menu likewise has no id and its toggle carries no link, so it is found by the toggle's
**label**: a portal that renames that menu simply will not match, and your entry is absent rather than
misplaced.

**⚠ The `account` menu relabels itself by context, and a hide list matches labels exactly.** It is one
menu throughout — same dropdown, same anchor — but its entries depend on whether you are *managing
something* or *inside your own account*:

| Where you are | What the menu says |
|---|---|
| Managing a domain or organisation | `My Account` · `Messages` · `Log Out` |
| Inside your own account | `Profile` · `Log Out` |

The labels follow the context; the scope decides which contexts you can be in. A Reseller and an Office
Manager see both rows and switch between them. A Basic User has no organisation to manage, so they are
always in the second row — they see `Profile` and never `My Account`.

The practical consequence when writing a hide: **`Profile` hits Basic Users all the time and admins only
inside their own account, while `My Account` hits admins only, and never a Basic User at all.** If you
mean "this entry, always, for everyone", name both. Listing a label that never appears is harmless — a
hide that matches nothing changes nothing. (`Profile` opens a modal, at every level it appears on, so
hiding it removes a modal launcher rather than a link to somewhere. `My Account` navigates.)

**Hides are applied before adds.** A hide names a *stock* entry, so it acts on the menu as the portal
shipped it, before any of your own entries exist. That keeps the two lists independent: a hide can never
remove something you added, and neither list's meaning depends on the other.

**`rename` — relabel a stock entry without moving it.** The third key beside `hide` and `add`, targeted
the same way:

```json
{"apps": {"rename": [{"from": "SNAPAnalytics", "to": "Analytics Dashboard"}]}}
```

Reach for it when you sell this portal as your own product and your documentation calls the entry
something else. Hiding it and adding a replacement is not the same thing: that needs the target URL, it
moves the row to the end of the menu, and it discards the portal's own link along with its icon and
anything the portal attached to it. A rename changes the label in place, and nothing else.

- **`from` is the entry as the portal ships it, and it stays that name everywhere else.** A hide naming
  it still works; a capture still records it; the builder still offers it under that name.
- **A rename never matches a row that a rename produced.** Rename `A` to `B` and a second rule with
  `"from": "B"` will not touch that row — otherwise the result would depend on which order the rows
  happen to sit in. It *will* still match a stock entry the portal genuinely ships as `B`, which is the
  right answer: that row is stock, and nothing about your first rule changes what it is called.
- **`title` has three states.** Omit it to leave the portal's own tooltip alone; `""` removes the
  tooltip; a string sets it. `null` is refused at startup rather than guessed at, since both readings
  are defensible and the wrong one silently deletes a tooltip you meant to keep.
- **A rename changes the label and the tooltip. It does not change where the entry goes.** If you want
  it to go somewhere else, hide it and add your own.
- **`to` and `title` take the same [`{variable}` placeholders](#menu-targeting) an added entry's label
  does** — `{name}`, `{ext}`, `{domain}`, `{page}` and the rest, filled per signed-in user. An unknown
  one is a startup error, the same as anywhere else. `from` never interpolates: it has to stay the one
  name every other rule agrees on.
- A `from` that matches nothing changes nothing, exactly like a hide that matches nothing.
- A rename never touches an entry *you* added — change those where you wrote them.
- **It desynchronizes the entry from your vendor's documentation and support language.** That is the
  point when you are branding your own product, and a trap when you are not: whoever hits the confusion
  will not be whoever wrote the config.

**Writing one in the builder.** The Menus tab draws every menu the way the reader sees it, so a stock row
offers *rename* and a renamed one offers *edit name* and *revert*. Two things about that form are
deliberate:

- **The original name is pinned to the row, not typed.** It is the row you clicked. That is what makes
  "there is no renaming a renamed entry" a property of the editor rather than only a rule here — offering
  the control on stock rows alone would enforce nothing if the form then let you type a `from`.
- **The tooltip is a picker, not a text box.** *Leave as it is* / *set to* / *remove*, because a box can
  express two of those three states and the missing one is the default. Reverting removes the rename from
  every rule renaming that entry for the reader you are previewing — and from no rule that was not.

One case where the control is withheld: a captured role stores the labels a page was showing, so a
capture taken **before** you wrote a rename holds that entry under its *renamed* name — and the original
is missing from the capture entirely. Offering to rename that row would write a rule against a name the
portal never uses. Those rows say so; recapture the role and the control comes back. A row that merely
*shares* a name another rule renames to is not this: it is a stock entry in its own right and keeps the
control.

<a id="PORTAL_HANDOFF_ORIGINS"></a>

### `PORTAL_HANDOFF_ORIGINS` · `vars`

The origins a menu entry marked `"handoff": "ns_t"` may POST the signed-in user's session token to.
Comma-separated, each an **exact origin**: scheme, host and, if not the default, port — nothing after.

- **Example** `https://tools.example.com`
- **Unset** No handoff entry is allowed. A `PORTAL_MENUS` entry carrying `handoff` is then a startup error
  that names this setting. Plain links are unaffected.
- **What it gates** Only the token. A plain `add` entry may link anywhere `https://` reaches; this list
  is consulted only for entries that hand the session over. See [Handoff entries](#menu-handoff) for the
  entry itself.

**Two settings on purpose.** The entry's `url` already has to be `https://` with a fixed host, and for a
link that is enough. A handoff sends a working NetSapiens credential, so the destination has to be a
decision you make twice — once in the menu, once here — and an edit to `PORTAL_MENUS` alone can never
send the token somewhere new.

**Exact means exact.** `https://tools.example.com:8443` and `https://sub.tools.example.com` are different
origins from `https://tools.example.com`; the receiver compares the browser's `Origin` header the same
way. An entry with a path (`https://tools.example.com/launch`) or a scheme other than `https` is refused
at startup rather than accepted and never matched. A trailing slash is fine — it is how a browser prints
an origin.

<a id="DOCUMO_DOMAINS"></a>

### `DOCUMO_DOMAINS` · `vars`

Which domains count as running the fax integration, **for menu targeting only**.

- **Example** `acme.example`, or `*` for every domain
- **Why it exists** A menu rule can target `app`, and one of the app names is `documo`. That integration
  cannot answer "am I active on this domain?" yet, so this answers for it. When it ships, it answers
  directly and this becomes an override rather than the source.
- **Unset** No domain counts as running it — the state every deployment is in today. A menu rule naming
  `documo` is then written but inert, which is legitimate ahead-of-launch config: the console's menu
  preview resolves against the audience you ask for, not against live state, so you can write and check
  those rules before the integration exists.
- **It changes nothing else.** Nothing outside menu targeting reads it.

<a id="PORTAL_APPS_HIDE"></a>

### `PORTAL_APPS_HIDE` · `vars`

The older, terser way to hide stock Apps-menu entries: comma-separated for a fleet-wide list, or JSON
`{"<domain>": [...], "*": [...]}` to vary by domain.

- **Example** `SNAPmobile Web,Meeting`
- **Unset** No entries hidden from this setting.
- **When to prefer it** For exactly one thing: a plain fleet-wide list, which needs no escaping in
  `wrangler.jsonc` where a JSON value must be embedded as an escaped string. Its JSON form has no
  advantage at all over `PORTAL_MENUS`' `apps.hide` — identical escaping, fewer targeting axes. If you are
  reaching for the JSON here, reach for `PORTAL_MENUS` instead.
- **Setting both is fine.** The two hide lists **merge**; neither silently wins, a label named by both is
  hidden once, and the console shows the effective list with each entry attributed to the setting it came
  from. Move the old list into `PORTAL_MENUS` if you want everything in one place, but nothing breaks if
  you do not.

---

<a id="group-ringotel"></a>

## App integration

The softphone-app integration (Ringotel). **`RINGOTEL_API_KEY` is the gate**: absent, there are no app
calls, no enrichment, its routes return 404, and the deployment behaves exactly as if the integration did
not exist. Every other setting in this group and the next two is inert without it.

<a id="RINGOTEL_API_KEY"></a>

### `RINGOTEL_API_KEY` · **secret**

Your Ringotel AdminAPI key. Its presence is what turns the whole integration on.

- **Unset** Integration fully off. The NetSapiens-only features are unaffected.

<a id="RINGOTEL_BASE_URL"></a>

### `RINGOTEL_BASE_URL` · `vars` · gated by `RINGOTEL_API_KEY`

Non-default AdminAPI base URL, for a non-standard deployment.

- **Example** `https://shell.ringotel.co`
- **Unset** The standard base URL.

<a id="RINGOTEL_LABEL"></a>

### `RINGOTEL_LABEL` · `vars` · default `Ringotel` · gated by `RINGOTEL_API_KEY`

Long display name for the app, wherever it is named in the portal.

- **Example** `Acme App`
- **White-label names belong in a secret**, not a committed var.

<a id="RINGOTEL_LABEL_SHORT"></a>

### `RINGOTEL_LABEL_SHORT` · `vars` · gated by `RINGOTEL_API_KEY`

Short name for tight spots, such as a column header.

- **Example** `Acme`
- **Unset** Falls back to `RINGOTEL_LABEL`, then `Ringotel`.

<a id="RINGOTEL_PRESENCE"></a>

### `RINGOTEL_PRESENCE` · `vars` · gated by `RINGOTEL_API_KEY`

Show live presence (active / on a PBX call / offline) in the app-status columns and on diagram agent lines.

- **Example** `1`
- **Unset** Off — status shows activation only. Off by default because presence is a point-in-time
  snapshot (cached ≤10 min) while the rest of a diagram is static configuration.

<a id="RINGOTEL_OVERRIDES"></a>

### `RINGOTEL_OVERRIDES` · `vars` · gated by `RINGOTEL_API_KEY`

JSON `{"<nsDomain>": "<branchAddressToMatch>"}`, for the rare domain whose app branch address does not
equal its NetSapiens domain.

- **Example** `{"weird.example": "actual-branch-address"}`
- **Unset** No overrides — a branch's `address` is matched to the NetSapiens domain automatically, which
  is what binds them. If yours match (they normally do), you need none of this.

**More than one branch may share a domain**, and that is supported: an organization can serve one
NetSapiens domain from several branches — per site, per white-label app, or a pilot beside production. The
user list spans every bound branch and each row names the branch it belongs to. Two rules follow, both
fail-safe:

- **Two different *organizations* claiming one domain is refused everywhere.** Several branches under one
  organization is a topology; two organizations is a misconfiguration, and nothing can tell which one's
  users belong to that domain.
- **An extension with records on more than one branch is reported, never resolved.** The portal shows a
  conflict and refuses writes to that extension until a human fixes it, rather than picking a record and
  possibly changing the wrong seat. Activating a user who has **no** record yet is also refused on such a
  domain — create the user on the intended branch first.

<a id="RINGOTEL_ROTATE_SIP_ON_ACTIVATE"></a>

### `RINGOTEL_ROTATE_SIP_ON_ACTIVATE` · `vars` · **default ON** · gated by `RINGOTEL_API_KEY`

When activating a user whose `<ext><suffix>` device **already existed**, replace its SIP password instead
of reusing the stored one.

- **Example** `0` to disable (also `false`, `no`, `off`)
- **Unset** ON. This is the only switch in the whole file that defaults on.

**Why.** Reusing the stored password leaves *any other endpoint still holding it* with valid credentials
for the same address-of-record. Both then register, the most recent wins, and they trade the registration
back and forth — intermittent call failures with nothing obviously wrong in either system. Rotating at
activation invalidates the stranger.

A device the activation *creates* is not rotated (it is already exclusive), and per-login paths never
rotate — doing so on every sign-in would churn the credential and could race a re-registration. Rotation
is best-effort: if it fails, activation still succeeds using the existing password.

---

<a id="group-onebill"></a>

## OneBill

The [OneBill](https://www.onebillsoftware.com/) billing link report. **All four of `ONEBILL_TENANT_ID`,
`ONEBILL_CLIENT_SECRET`, `ONEBILL_USERNAME` and `ONEBILL_PASSWORD` are the gate**: any one missing, there
are no OneBill calls, the Management-menu entry is absent, and its routes return 404. This is an
unofficial integration.

**One thing must exist in OneBill before any of it works:** the subscriber custom-field group named by
[`ONEBILL_LINK_GROUP`](#ONEBILL_LINK_GROUP). See
[SETUP.md → Set up the OneBill custom-field group first](./SETUP.md#onebill-group).

**What the page costs upstream.** Opening it, and its **Refresh** button, read the subscriber list once
— a handful of paged requests for the whole tenant, plus one extra read for each account holding more
than one link. **Refresh and fully verify** reads every account's custom fields and subscriptions, which
is roughly two requests per subscriber and takes appreciably longer; it is what checks usage
subscriptions. Either result is cached for ten minutes per deployment, and the last full verification's
usage verdicts are kept for a day so a quick view can show them.

<a id="ONEBILL_TENANT_ID"></a>

### `ONEBILL_TENANT_ID` · `vars`

OneBill tenant identifier, from Config > Settings > Business Profile. Doubles as the OAuth client id. A
var, not a secret — it identifies your tenant but does not authenticate against it — but nothing stops
you setting it as a secret instead if you would rather keep it out of `wrangler.jsonc` entirely; either
way works the same at runtime.

- **Unset** The integration is off: no OneBill calls, the Management-menu entry is absent, its routes
  answer 404.

<a id="ONEBILL_CLIENT_SECRET"></a>

### `ONEBILL_CLIENT_SECRET` · **secret**

OneBill OAuth client secret, from the same Business Profile screen.

- **Unset** The integration is off: no OneBill calls, the Management-menu entry is absent, its routes
  answer 404.

<a id="ONEBILL_USERNAME"></a>

### `ONEBILL_USERNAME` · **secret**

OneBill API username.

- **Unset** The integration is off: no OneBill calls, the Management-menu entry is absent, its routes
  answer 404.

<a id="ONEBILL_PASSWORD"></a>

### `ONEBILL_PASSWORD` · **secret**

OneBill API password.

- **Unset** The integration is off: no OneBill calls, the Management-menu entry is absent, its routes
  answer 404.

<a id="ONEBILL_BASE_URL"></a>

### `ONEBILL_BASE_URL` · `vars` · gated by `ONEBILL_CLIENT_SECRET`

Non-default OneBill API base URL. Must be `https://`.

- **Example** `https://api.example.com`
- **Unset** Uses OneBill's standard API base URL.

<a id="ONEBILL_LINK_GROUP"></a>

### `ONEBILL_LINK_GROUP` · `vars` · default `{"group":"PBX","ns":"NS","valueField":"Domain","qualifierField":"Site"}` · gated by `ONEBILL_CLIENT_SECRET`

JSON describing which subscriber custom-field group carries the NetSapiens link: the group key, the
namespace it maps to, the field holding the domain, and (optionally) the field holding the site.

- **Unset** Uses the default above — group `PBX`, namespace `NS`, domain in `Domain`, site in `Site`.

**Before you start:** setting this variable does not create anything in OneBill — it only tells this
deployment where to look. In OneBill, create an account-level custom-field group whose key matches
`group`, allow it to hold more than one instance, and add a text field whose name matches `valueField`
(and, if you set one, a second optional text field matching `qualifierField`). Until that group exists
with those fields declared, the links page shows a setup card instead of the table and refuses every
write, naming exactly which of the three — the group itself, the value field, or the qualifier field —
is missing.

**The numbered procedure is in
[SETUP.md → Set up the OneBill custom-field group first](./SETUP.md#onebill-group).** Follow it before you
open the links page.

`ns` is the namespace the links this group carries are encoded under in the subscriber's derived
`externalId`, which is how an account is found by domain without reading every record. It must match
`[A-Z][A-Z0-9]{0,7}`; a value that does not is refused when the configuration is parsed, with this setting
named.

<a id="ONEBILL_USAGE_OFFERS"></a>

### `ONEBILL_USAGE_OFFERS` · `vars` · gated by `ONEBILL_CLIENT_SECRET`

Comma-separated subscription offer names whose subscription identifier is the NetSapiens domain. The page
uses them to propose a link for an account that has none.

- **Example** `Domain Usage`
- **Unset** No links are proposed; unlinked domains still list, and an account can be picked by hand.

<a id="ONEBILL_USAGE_IGNORE"></a>

### `ONEBILL_USAGE_IGNORE` · `vars` · default `_OLD` · gated by `ONEBILL_CLIENT_SECRET`

Comma-separated substrings that mark a subscription identifier as retired, matched case-insensitively
anywhere in the identifier. A subscription whose identifier contains one is not a usage match at all, so
its account's verdict is worked out as though the subscription did not exist.

Set this to whatever your team appends when it retires an identifier rather than deleting it. Without it,
a renamed leftover reads as a second live subscription and the account reports `ambiguous` when nothing
is actually wrong.

- **Example** `_OLD,_RETIRED`
- **Unset** Uses `_OLD`. A blank value is treated as unset, not as "ignore nothing" — an empty marker
  would match every identifier and silence the usage section entirely.

<a id="ONEBILL_RECURRING_RULES"></a>

### `ONEBILL_RECURRING_RULES` · `vars` · gated by `ONEBILL_CLIENT_SECRET`

JSON array of rules keyed by offer name, price plan code or product code (one per rule) saying which
inventory dimension(s) each counts toward, which rules sum into one group, which lines are ignored on
purpose, and which include another dimension. See
[SETUP.md → The recurring comparison](./SETUP.md#recurring-comparison) for a worked rulebook.

- **Example** `[{"offer":"Seat","counts":"extensions.total","group":"seats"}]`
- **Unset** Every recurring offer is listed as unmapped and the account panel still shows the inventory —
  the comparison degrades to a fact sheet rather than disappearing.

**The keys a rule takes:**

| Key | What it does |
|---|---|
| `offer` | Match the subscription's price plan **name**. The one identifier every line always carries. |
| `planCode` | Match OneBill's price plan code. A retail plan can carry a blank plan code, and a rule keyed this way can never reach one. |
| `productCode` | Match OneBill's product code — the product-level fallback under whatever the plans are named. |
| `counts` | One dotted inventory path, or an array of several. An array sums them and unions their items. |
| `ignore` | `true` marks the offer as known and deliberately not compared. It takes the place of `counts`. |
| `group` | The row label these rules sum into. Rules sharing a `group` are one row. |
| `perUnit` | Each unit of the line counts this many — a pack of ten numbers is `"perUnit": 10`. |
| `alsoCounts` | Each unit **pays for** this many of another dimension: raises that row's *billed*, so fewer live than billed is a shortfall. |
| `entitles` | Each unit **permits** this many at no charge: raises that row's *entitled*, which is headroom above billed and never a shortfall. |
| `why` | A note for the next reader, at most 120 characters. The comparison never reads it. |

A rule is keyed by exactly one of `offer`, `planCode` or `productCode`, or by none of the three. Every
rule needs exactly one of `counts` or `ignore`, and `ignore` needs a key to ignore — so a keyless rule
always carries `counts`.

**A keyless rule is a comparison-only row.** It names a `group`, its `counts` gives the row's live side,
and its billed side comes only from other rules' `alsoCounts` credits — it matches no subscription line
of its own. (Another rule's `entitles` can reach the same row, but that raises `entitled`, which is
headroom above billed rather than part of it.) Write
`{ "group": "callcenter", "counts": "extensions.byScope.Call Center Agent" }` and the seat rules that
credit `"alsoCounts": { "callcenter": 1 }` are what give that row something to compare against.

**Precedence, when one line matches more than one rule:** `planCode`, then `offer`, then `productCode`. A
named plan always beats the product-level fallback under it.

**A `group` label is free text**, and may contain spaces, parentheses, `&`, `/` and `+` — write
`"Native Fax (Analog)"` if that is what you call the row.

**Give every `ignore` rule a `why`.** An offer name alone does not say whether the offer is unbilled,
counted somewhere else, or not a line at all, and this setting is a JSON string inside a JSONC file, so a
`//` comment cannot reach inside it. Write `{"offer":"MFAX Line","ignore":true,"why":"Documo fax, not a
NetSapiens line"}`.

**Catalogue codes cost one extra read.** `planCode` and `productCode` resolve through an index this Worker
builds from OneBill's `ProductService/v1/products` and `/products/{code}` and caches for 24 hours. A
rulebook that only uses `offer` never makes that call.

**A rule credits other rows two ways, and the difference is what a shortfall means.** `alsoCounts` says
each unit of this line PAYS FOR that many of another dimension, so it raises that row's billed count and
fewer live than billed is a shortfall to explain. `entitles` says each unit PERMITS that many at no
charge, so it raises the row's `entitled` instead — headroom above billed, where anything from billed up
to billed-plus-entitled is a match and using none of it is not a finding. Both take the same keys (a
dotted inventory path, or another rule's `group` name) and both scale by the line's quantity rather than
its `perUnit`. A key naming neither a tracked path nor a declared group gets a comparison-only row of its
own, named after the key.

**Account-scoped reconciliation adds nothing to configure.** Which account holds which domain or site
comes from the OneBill links you already set on the account panel itself, and manual per-item
assignment writes to its own D1 tables — there is no new setting here for either.

<a id="NS_FAX_SERVER_HOSTS"></a>

### `NS_FAX_SERVER_HOSTS` · `vars` · gated by `ONEBILL_CLIENT_SECRET`

Comma-separated fax server hosts. A phone number whose dial rule hands it to one of these is counted as a
**fax line** (`dids.fax`) instead of as a DID, so a rulebook can bill it as what it is.

- **Example** `203.0.113.7` (an IP or a hostname; several, comma-separated, is fine)
- **Unset** No number is a fax line, and the DID counts include them — the numbers you got before this
  setting existed.

**Where the value comes from.** On the portal's *Fax Server* treatment a fax line is an ordinary phone
number whose dial rule reads `to-connection` with the fax server as its destination host. Open one such
number in the Manager Portal, or read a snapshot, and copy the
`dial-rule-translation-destination-host` value verbatim. Matching is on that host alone, trimmed and
case-insensitive — never on the `Portal Created: Phonenumber -> FaxServer` description, which is a note
an operator can edit.

**Analog and digital fax read identically here.** NetSapiens has no fax-account endpoint and the ATA is
not a device on the user, so nothing in the API tells the two apart. Point every fax offer at `dids.fax`
in `ONEBILL_RECURRING_RULES` and let the billed-as tag on each acceptance record which one was sold.

<a id="NS_DEVICE_SUFFIXES"></a>

### `NS_DEVICE_SUFFIXES` · `vars` · gated by `ONEBILL_CLIENT_SECRET`

JSON object naming what a device-name **suffix** means on your system. A device's suffix is what its name
carries after the extension number: `1001wp` on extension `1001` has suffix `wp`, and a bare `1001` has
none. The account panel prints the label on the device chip, and the suffix marked `teams` is what
identifies a Microsoft Teams connector — which is the device the seat counts deliberately exclude.

- **Example** `{"wp":{"label":"SNAPmobile Web"},"m":{"label":"SNAPmobile"},"t":{"label":"Teams","teams":true},"d":{"label":"Acme Desktop"}}`
- **Unset** The three suffixes NetSapiens itself ships: `wp` SNAPmobile Web, `m` SNAPmobile, and `t` Teams
  (`teams: true`).

**Setting it REPLACES the default, it does not add to it.** Whatever you write is the whole legend, so
the example above restates `wp`, `m` and `t` in order to keep them. That is deliberate: a deployment
without TeamMate omits `t`, and Teams detection is then off entirely — every `<ext>t` device is a handset
and is counted as one — which a merge could not express.

**A suffix the legend does not carry has no label.** Its chip falls back to the device model, and to
`(no model)` when NetSapiens has none. Nothing is guessed from an unlisted suffix.

**Values.** A suffix is 1–8 letters or digits and is matched case-insensitively. A `label` is 1–40
characters. `teams` is `true` or `false` and may be left out. A malformed value is reported with the
setting named, the same way a malformed `ONEBILL_RECURRING_RULES` is.

**Ringotel adds its own entry.** When `RINGOTEL_API_KEY` is set, the activation suffix
([`RINGOTEL_ACTIVATION_SUFFIX`](#RINGOTEL_ACTIVATION_SUFFIX), default `r`) is added to the legend labelled
with [`RINGOTEL_LABEL_SHORT`](#RINGOTEL_LABEL_SHORT) — so a white-labelled app names itself on the chip
with no second setting to keep in step. It never overwrites a suffix you set here: name that suffix
yourself and your label wins.

**A change shows on each domain's next read.** The legend is applied when a domain's inventory is read
and then cached with it, but it is **not** part of the cache key — so an entry written under the old
legend keeps serving the old labels, and the old Teams count, until it lapses. That is within ten
minutes; Refresh on the account panel does it now. (The one-off key bump that came with this setting
covered the UPGRADE, where entries had no `suffix` or `kind` on any device at all. It does not fire again
when you edit the value.)

---

<a id="group-eligibility"></a>

## Activation rules

Which extensions are treated as real people, and the rail that bounds every write. All gated by
`RINGOTEL_API_KEY`.

The features here — `ringotel.activate`, `ringotel.resetPassword`, `ringotel.profileStatus`,
`ringotel.profileAppAccess`, `ringotel.prepop` — let authorized roles manage a user's app account from the
NetSapiens user profile. They are *writes*, so they are gated harder than the read features; see
[Features and gating](#features-and-gating) to re-level them.

**Two facts that are not configurable and are worth knowing.** **System/service users** (a non-blank
`srv_code`) and non-3-4-digit extensions are **hard-excluded** and can never be activated, not even by a
reseller force. And writes require a delegated `ns_t` — never a stored credential — and force a fresh
token re-validation before mutating.

> The eligibility decision itself lives in `@dszp/netsapiens-lib` (`evaluateEligibility`) so that every
> consumer of that library — this portal backend, and any SSO integration you run beside it — reaches the
> same verdict from the same inputs. Only the configuration below is read here.

<a id="RINGOTEL_WRITE_DOMAINS"></a>

### `RINGOTEL_WRITE_DOMAINS` · `vars` (prefer a **secret**) · **the safety rail**

The only domains in which activate / deactivate / password-reset may run.

- **Example** `acme.12345.service` (CSV), or `*` for every domain the caller's scope permits
- **Unset** ⚠️ **Every write is refused.** Empty is fail-closed, not unrestricted. Set it deliberately.
- **It also bounds change events** — `NS_EVENTS_DOMAINS` can never exceed it.
- **It names real customer domains**, so prefer a secret over a committed var. See [Where each value
  goes](#where-each-value-goes).

<a id="RINGOTEL_ACTIVATION_SUFFIX"></a>

### `RINGOTEL_ACTIVATION_SUFFIX` · `vars` · default `r` · gated by `RINGOTEL_API_KEY`

The suffix appended to an extension to name its softphone device — suffix `r` on extension `100` creates
device `100r`.

- **Example** `r`
- **Unset** Defaults to `r`. An explicitly-set blank value is a configuration error, not "no suffix".

<a id="RINGOTEL_EXCLUDE_NAMES"></a>

### `RINGOTEL_EXCLUDE_NAMES` · `vars` · gated by `RINGOTEL_API_KEY`

Case-insensitive **substring** matchers on a user's name that soft-exclude it from activation — shared
lines, voicemail boxes, fax, conference rooms.

- **Example** `SHARED,FAX`
- **Unset** A built-in list of ten applies: `SHARED`, `SHARED VOICEMAIL`, `VOICEMAIL`, `FAX`,
  `GENERAL VOICEMAIL`, `GENERAL MAILBOX`, `CONFERENCE`, `CONF RM`, `CONF ROOM`, `ROUTING`.
- ⚠️ **Setting this REPLACES that list entirely** — it does not add to it. And read the defaults before
  relying on them: bare `VOICEMAIL` and `ROUTING` match *any* name containing them.

<a id="RINGOTEL_EXCLUDE_EXTS"></a>

### `RINGOTEL_EXCLUDE_EXTS` · `vars` · gated by `RINGOTEL_API_KEY`

Extension patterns to soft-exclude. A trailing `*` is a prefix wildcard.

- **Example** `900,8*`
- **Unset** Empty — no extension is excluded by pattern.

<a id="RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN"></a>

### `RINGOTEL_EXCLUDE_EXTS_BY_DOMAIN` · `vars` · gated by `RINGOTEL_API_KEY`

JSON `{"<domain>": {"add": [...], "remove": [...]}}` letting one domain adjust the extension-exclusion
list without changing it fleet-wide.

- **Example** `{"acme.example": {"remove": ["900"]}}`
- **Unset** Every domain uses the same `RINGOTEL_EXCLUDE_EXTS` list.

<a id="RINGOTEL_EXCLUDE_NO_DEVICES"></a>

### `RINGOTEL_EXCLUDE_NO_DEVICES` · `vars` · gated by `RINGOTEL_API_KEY`

Tighten the name matcher: a name-matched user is excluded only if it *also* has no devices.

- **Example** `1`
- **Unset** Off — the looser default applies.
- **It never excludes a no-device user on its own.** A normal-named user with no devices stays
  activatable, because activation is what creates the device.

<a id="RINGOTEL_RESELLER_OVERRIDE"></a>

### `RINGOTEL_RESELLER_OVERRIDE` · `vars` · gated by `RINGOTEL_API_KEY`

Which soft-exclusion categories a reseller may override per activation: `names`, `exts`, `no_devices`, or
`all`.

- **Example** `names,exts`
- **Unset** Empty — resellers cannot override any soft category.
- Hard exclusions are never overridable by anyone.

<a id="RINGOTEL_PREPOP_INCLUDE_SOFT"></a>

### `RINGOTEL_PREPOP_INCLUDE_SOFT` · `vars` · gated by `RINGOTEL_API_KEY`

When pre-populating the app directory, also create entries for **soft-excluded** users.

- **Example** `1`
- **Unset** Off — pre-population skips soft-excluded users, the same as activation does. Those extensions
  are not people, and a directory full of entries nobody should activate is noise.

**About directory pre-population** (`ringotel.prepop`, default `reseller`). It creates **inactive**
directory entries for NetSapiens users who have none, so the directory reflects your organization before
anyone is activated. Bounded by `RINGOTEL_WRITE_DOMAINS`, and exposed as two routes: a **preview** listing
what it would create along with every skip and its reason, and an **apply** that performs it. Apply
re-plans server-side — the caller names a *domain*, never the individual users.

Users with **no email address** *are* included: a missing address blocks activation, not a directory
entry, and such a user can still be activated later via SSO. Hard-excluded users never are.

**A placeholder deliberately carries no SIP identity** — no username, authname, or password. A record that
owns `<ext><suffix>` is exactly what collides when an extension is later reassigned; activation fills
those fields in afterwards.

**Soft exclusions are creation-only.** They decide whether an account may be *created*; they never block a
user who already has a working one from being shown how to sign in.

---

<a id="group-appaccess"></a>

## Self-service app access

What a signed-in user is told about their own app access: the Apps menu and their home-page card show
**how** they sign in — SSO with their portal password, a dedicated app password, or "not set up yet" —
instead of a bare status dot. The feature is `me.appAccess` (default `all`); the operator-facing twin on
the user-profile page is `ringotel.profileAppAccess`.

All three settings are optional and fail closed: leave any unset and the deployment behaves as if it were
not configured — no SSO claimed, no create-on-login assumed, no download links.

<a id="RINGOTEL_SSO_SERVICE"></a>

### `RINGOTEL_SSO_SERVICE` · `vars` · gated by `RINGOTEL_API_KEY`

The NAME half of the SSO service your app fleet is bound to — the part after the `/` in the organisation's
`params.sso` — used to tell a user whether SSO sign-in is available to them.

- **Example** `netsapiens_sso`
- **Unset** ⚠️ **Never claim SSO for any org**, even one with an SSO service bound. A binding could point
  at a third-party identity provider, and claiming SSO wrongly tells a user to try a password that will
  not work.
- ⚠️ **Setting this does not enable single sign-on.** It turns on the portal-side surface around it. SSO
  additionally requires its own separate Worker deployment and enablement by the app platform's support
  pointed at that Worker — neither of which this deployment can see or verify. The console's Integrations
  tab shows the full chain.

**One consequence worth stating.** The email requirement applies to the *emailed* activation path, not to
SSO. Activating a user from the profile page mails them their credentials, so it needs an address on the
NS user. An SSO sign-in creates the account from the user's own portal login and mails nothing, so on an
SSO-bound domain a user with no email address is still treated as eligible and is shown how to sign in.
Soft and hard exclusions are unaffected either way.

<a id="SSO_AUTO_ACTIVATE"></a>

### `SSO_AUTO_ACTIVATE` · `vars` · gated by `RINGOTEL_API_KEY`

Whether your SSO integration creates an app account on first login for an eligible user who does not have
one yet. This is a setting on *that* integration, declared here so the portal describes it correctly.

- **Example** `acme.example,demo.example` (CSV), or `*` for every domain
- **Unset** Assume off — such a user is told to contact an admin rather than invited to a sign-in that
  would fail.

<a id="PORTAL_APP_DOWNLOADS"></a>

### `PORTAL_APP_DOWNLOADS` · `vars` · gated by `RINGOTEL_API_KEY`

JSON array of app download links, shown in the order you list them.

- **Example** `[{"label": "Get the App", "url": "https://example.com/app", "title": "...", "showUrl": false}]`
- **Required per entry** `label`, and an `https://` `url`. `title` is an optional tooltip.
- **`showUrl`** A small copyable URL line is shown under each link by default; set `"showUrl": false` on an
  entry to hide it — for a long link that will not fit.
- **Unset** No links shown.

---

<a id="group-events"></a>

## Change events

Keeping the app directory in sync with edits made **directly in NetSapiens**, rather than only as a side
effect of an activation, a password reset, or an SSO sign-in.

**The problem this solves.** Edit a user in NetSapiens and the app directory keeps the old values
indefinitely. Clear someone's email address and the directory keeps the stale one — which can later
receive an app password for an extension that has since been reassigned.

NetSapiens instead **pushes** subscriber changes here. This Worker registers a subscription per domain,
receives the events, and syncs identity to the directory. A scheduled job keeps those subscriptions
correct and reports their delivery health.

**It is inert until configured.** Leave these unset and there is no route, no scheduled work, and no
behaviour change. The feature arms only when the origin, the secret, the service credential and the domain
list are all present.

**Requirements beyond the settings:** a NetSapiens release exposing the flat `/subscriptions` endpoints
(the domain-scoped variants are v45+ and absent on v44), and a scheduled trigger — add
`"triggers": { "crons": ["17 * * * *"] }` to each environment that should reconcile. Hourly is deliberate:
the job validates and repairs, it does not keep anything alive.

⚠️ **Turning this on is the number one reason to be on Cloudflare's Paid Workers plan.** It is usually the
largest source of Worker requests on a real deployment, and it does not scale with your users. Every subscriber edit in NetSapiens becomes a request here whether anyone has the portal
open or not, so the volume tracks the size and churn of the domains you subscribe. And unlike a page load, this work is unattended: a delivery that exceeds a
limit fails silently overnight, and the symptom is a directory that has quietly stopped matching
NetSapiens. Size it before you turn it on — see [SETUP.md § Cloudflare plan](./SETUP.md#cloudflare-plan).

Deeper notes — what a callback URL is, how to retire the feature safely, and what it costs — are in [Event
subscriptions in depth](#events-reference). All settings below are gated by `RINGOTEL_API_KEY`.

<a id="NS_EVENTS"></a>

### `NS_EVENTS` · `vars` · default `auto`

`auto` · `on` · `off`.

- **`auto`** (default) On once the app integration and the settings below are all present; inert, with no
  error, until then.
- **`on`** Forces it, and makes missing settings a loud startup error.
- **`off`** Inert — and, on the next reconcile, **also removes this deployment's own subscriptions**,
  provided the callback origin and service credentials are still configured.

<a id="NS_EVENTS_DOMAINS"></a>

### `NS_EVENTS_DOMAINS` · `vars` (prefer a **secret**) · **required for the feature**

Which domains get a subscription.

- **Example** `acme.example` (CSV), or `*`
- **`*`** means every domain the write rail permits, discovered at reconcile time. It can never exceed
  `RINGOTEL_WRITE_DOMAINS`, and it must be chosen deliberately — it is never a default.
- **Unset** Inert: no domain gets a subscription even with `NS_EVENTS=on`.
- **Dropping a domain removes its subscription** on the next reconcile. So does emptying the list — see
  [retiring the feature](#events-reference).
- It names real customer domains: treat it like the write rail.
- **This value is a request, not a report.** What is subscribed lives in NetSapiens. The
  event-subscription check on the console's **Checks** tab lists every subscription this deployment owns,
  with its expiry — including one still live for a domain this list no longer names.

<a id="NS_EVENTS_BASE_URL"></a>

### `NS_EVENTS_BASE_URL` · `vars` · **required for the feature**

This deployment's own public origin — the base NetSapiens posts change events back to.

- **Example** `https://portal.example.com`
- **Origin only.** A path breaks every callback.
- ⚠️ **Must differ per deployment.** Subscription ownership is decided by URL prefix, so two deployments
  sharing an origin will fight over one subscription set.
- **Unset** Subscriptions cannot be created — inert, or a startup error if `NS_EVENTS=on`.

<a id="NS_EVENTS_PATH_SECRET"></a>

### `NS_EVENTS_PATH_SECRET` · **secret** · **required for the feature**

Master key the per-domain callback path token is derived from. Anyone who could forge that token could
post fake change events.

- **Generate it, do not invent it.** High entropy.
- **Unset** Subscriptions cannot be created.
- ⚠️ **Rotation is not seamless.** Every existing callback is refused from the moment it changes until the
  next reconcile re-points it, and deliveries in that window are lost. Trigger a reconcile immediately
  after rotating.

<a id="NS_EVENTS_MODELS"></a>

### `NS_EVENTS_MODELS` · `vars` · default `subscriber`

Which NetSapiens record types to subscribe to.

- **Example** `subscriber`
- **Unset** `subscriber` only. An unknown model is a startup error.

<a id="NS_EVENTS_TARGET_LIFETIME"></a>

### `NS_EVENTS_TARGET_LIFETIME` · `vars` · default `31536000` (365 days)

Seconds of subscription lifetime requested on create or renew. Must exceed `NS_EVENTS_RENEW_HORIZON`, or
every reconcile would renew immediately.

<a id="NS_EVENTS_RENEW_HORIZON"></a>

### `NS_EVENTS_RENEW_HORIZON` · `vars` · default `604800` (7 days)

Renew when less than this much lifetime remains.

<a id="NS_EVENTS_GEO_SUPPORT"></a>

### `NS_EVENTS_GEO_SUPPORT` · `vars` · default `yes`

`yes` or `no` — whether the created subscription requests geo-redundant delivery.

- **Send it explicitly.** NetSapiens behaves as `no` when the field is omitted, despite documenting `yes`.

<a id="NS_EVENTS_MAX_EVENTS"></a>

### `NS_EVENTS_MAX_EVENTS` · `vars` · default `40`

Ceiling on how many queued events are processed in one delivery. Truncation is logged, never silent.

- **Size it against your Cloudflare plan** if `NS_EVENTS_DEVICE_REPAIR` is on — see
  [cost](#events-reference).

<a id="NS_EVENTS_SWEEP_MAX"></a>

### `NS_EVENTS_SWEEP_MAX` · `vars` · default `200`

Ceiling on how many records the hourly sweep will touch in one run. Overflow is logged, never silently
dropped.

<a id="NS_EVENTS_OFFBOARD"></a>

### `NS_EVENTS_OFFBOARD` · `vars` · default `off`

`off` or `deactivate` — whether a user deleted in NetSapiens has their app record deactivated.

- Deletion is confirmed only by a 404 on re-read, never by the event payload.
- Fires immediately from the change event, and again on the hourly sweep, which also cleans up records
  orphaned before this feature shipped.
- Full deletion is deliberately not offered: it needs a verified "how long orphaned" clock that does not
  exist yet.

<a id="NS_EVENTS_DEVICE_REPAIR"></a>

### `NS_EVENTS_DEVICE_REPAIR` · `vars` · default `off`

`off` · `report` · `heal` — self-heal an active app user whose softphone device has gone missing.

- **`report`** logs the drift without writing. **`heal`** recreates the device and re-pushes its
  credentials.
- ⚠️ **It adds requests per event**, and `heal` adds a write on top when it repairs something. See
  [cost](#events-reference).

<a id="NS_EVENTS_ALLOW_IPS"></a>

### `NS_EVENTS_ALLOW_IPS` · `vars`

Optional source-IP allowlist for the inbound receiver, on top of the per-domain path token.

- **Example** `203.0.113.10,203.0.113.11`
- **Unset** Off — **and expected to stay off.** Delivery is geo-redundant across NetSapiens nodes and
  fails over between them, so the source address is not stable, and it arrives over IPv6. Making it
  predictable means disabling redundancy. The path token is the real gate.

<a id="NS_EVENTS_DIAG_RAW"></a>

### `NS_EVENTS_DIAG_RAW` · `vars`

Log the *shape* of an inbound payload — key names and sizes, never values — to diagnose an unfamiliar
delivery.

- **Example** `1`
- **Unset** Off.

<a id="NS_EVENTS_PREFERRED_SERVER"></a>

### `NS_EVENTS_PREFERRED_SERVER` · `vars`

Ask NetSapiens to deliver events from a particular node.

- **Unset** No preference; their own routing applies.

---

<a id="group-identity"></a>

## Background service identity

The credential used for work that runs with **no signed-in caller** — creating and renewing event
subscriptions, adding and removing a softphone device, deactivating an app record on deletion. This is the
only path in a portal deployment that holds a stored NetSapiens credential, and it exists only because an
event arrives with nobody attached to it.

**Two ways to supply it. Configure whichever your provider gives you, not both** — admin credentials win
if both are set.

⚠️ **Make it a dedicated least-privilege credential.** NetSapiens can restrict a key by `allowed-models`,
domain, and IP. Narrow it as far as your deployment allows: the caller-scope bound that limits every other
write in this kit does not apply to it.

<a id="NS_API_KEY"></a>

### `NS_API_KEY` · **secret**

A NetSapiens bearer token, sent as-is. Nothing is exchanged.

- **Unset** No API-key identity. Falls back to the admin-credential path below; if neither is configured,
  subscriptions cannot be created or renewed and the event handler cannot write.

<a id="NS_ADMIN_USER"></a>

### `NS_ADMIN_USER` · **secret**

Admin username, for a NetSapiens deployment that issues administrator credentials rather than a standalone
API key. Paired with `NS_ADMIN_PASS`.

Unlike `NS_API_KEY` these are **not** sent directly — they are exchanged for an access token via an OAuth
password grant, which is why this path additionally needs `NS_OAUTH_CLIENT_ID` and
`NS_OAUTH_CLIENT_SECRET`.

<a id="NS_ADMIN_PASS"></a>

### `NS_ADMIN_PASS` · **secret**

Admin password, paired with `NS_ADMIN_USER`.

<a id="NS_OAUTH_CLIENT_ID"></a>

### `NS_OAUTH_CLIENT_ID` · **secret**

OAuth client ID, required whenever `NS_ADMIN_USER`/`NS_ADMIN_PASS` are set. Without it the
admin-credential path cannot mint a token.

<a id="NS_OAUTH_CLIENT_SECRET"></a>

### `NS_OAUTH_CLIENT_SECRET` · **secret**

OAuth client secret, paired with `NS_OAUTH_CLIENT_ID`.

<a id="NS_OAUTH_SERVER"></a>

### `NS_OAUTH_SERVER` · `vars`

OAuth host for the admin-credential grant, for the uncommon case where it is not the same host as
`NS_SERVER`.

- **Example** `api.example.com`
- **Unset** Falls back to `NS_SERVER`.

---

<a id="group-branding"></a>

## Branding

Branding is configuration, never code — so a fork ships unbranded and yours never enters the source.

<a id="BRAND_NAME"></a>

### `BRAND_NAME` · **secret** (by convention) or `vars`

Your company name. Produces `"Acme Voice Portal Kit v<version>"` and an `"Acme Voice portal"` theme.

- **Example** `Acme Voice`
- **Unset** `"NS Portal Kit"` and the neutral theme.
- A white-label name is deployment-identifying: prefer a secret so it stays out of a committed file.

<a id="BRAND_ACCENT"></a>

### `BRAND_ACCENT` · `vars`

Accent colour for the call-flow diagrams this deployment renders.

- **Example** `#1a6bb0`
- **Must be hex** (`#rgb` or `#rrggbb`). Anything else is ignored.
- **Unset** The neutral `ns-portal` palette, which matches the stock Manager-Portal scheme.

---

<a id="group-bindings"></a>

## Worker bindings

Two settings are Cloudflare **bindings** rather than string values: declared structurally in
`wrangler.jsonc`, never with `wrangler secret put`. Adding a `vars` entry of the same name creates
nothing. Bindings are not inherited between environments either.

<a id="ASSETS"></a>

### `ASSETS` — private R2 bucket

The bucket an `r2:` secondary is served from.

```jsonc
"r2_buckets": [{ "binding": "ASSETS", "bucket_name": "your-bucket" }]
```

- **Unset** Harmless — unless `PORTAL_SECONDARIES` lists an `r2:` entry, in which case every request fails
  with a loud config error.
- Details: [Secondary scripts](#secondaries-reference).

<a id="ONEBILL_DB"></a>

### `ONEBILL_DB` — billing baseline database

Optional D1 database holding the account panel's **baseline** (which billing-vs-inventory items an
operator has accepted, with append-only history) and its manual item→account **assignments**. Bind it,
then apply `migrations/`:

```jsonc
"d1_databases": [
  { "binding": "ONEBILL_DB", "database_name": "ns-portal-kit-billing", "database_id": "<id>" }
]
```

```bash
npx wrangler d1 create ns-portal-kit-billing
# add the block above to wrangler.jsonc, then:
npx wrangler d1 migrations apply ns-portal-kit-billing --remote
```

- **Unset** Not bound. The account panel renders the inventory and the comparison without the accepted
  column, and the baseline and assign routes answer 404; nothing else is affected.

**Apply the migrations before you deploy this version.** The baseline reads name the current columns by
hand, so against a database still on an older migration they fail outright and the account panel answers
an error rather than degrading.

| Migration | What it does |
|---|---|
| `0001_billing_baseline.sql` | Creates the original count-based baseline table. |
| `0002_billing_baseline_items.sql` | Moves to per-item acceptance. **Deletes every existing `billing_baseline` row** — an accepted count against unknown items is not the same fact as item acceptances. |
| `0003_billing_item_assignment.sql` | Adds the manual assignment tables, and **deletes every existing row from `billing_baseline_item` and `billing_baseline`**: item keys inside an account-scoped comparison became domain-qualified, so the item acceptances and the group rows both had to go. |
| `0004_billing_baseline_item_offer.sql` | Adds `offer` to the item tables and `entitled` to the group tables. Additive — deletes nothing. |
| `0005_billing_item_assignment_multi.sql` | Rebuilds `billing_item_assignment` with the account in its primary key, so one E911 address can be assigned to several accounts. Copies every existing row across; deletes nothing. |

Re-run `wrangler d1 migrations apply` after every update, not only the first time.

<a id="JWT_RATE_LIMITER"></a>

### `JWT_RATE_LIMITER` — rate limiting

Throttles the live `ns_t` verification calls this Worker makes to your NetSapiens core, so a flood of
forged tokens is bounded before it reaches the platform.

```jsonc
"ratelimits": [
  { "name": "JWT_RATE_LIMITER", "namespace_id": "1000", "simple": { "limit": 100, "period": 60 } }
]
```

- **Unset** An in-isolate limiter still applies — but only *per isolate*, so a distributed flood is bounded
  once per edge location rather than once overall. A deployment without this is safe, just less effective.
  That is why it is not a startup requirement.

---

<a id="features-and-gating"></a>

## Features and gating

Every feature is gated to a role by default. You do not have to touch source to change who sees what: two
settings, [`PORTAL_FEATURES`](#PORTAL_FEATURES) and [`PORTAL_SUPERADMINS`](#PORTAL_SUPERADMINS), override
the built-in defaults over the registry below. Leave them unset and behaviour is exactly the defaults.

**The console's Permissions tab answers this better than a table can.** It shows one row per feature and
one column per NetSapiens scope, and each cell answers three questions in the order the Worker applies
them: does the gate admit this person, do they receive the bundle that carries it, and can the feature run
as configured. *Allowed* and *works* are different answers, and a feature can be granted to a scope and
still show as not running — usually a missing setting rather than a gating mistake.

<a id="level-vocabulary"></a>

### The level vocabulary

A *level* is an allow-set of NetSapiens scopes, matched case-insensitively. The admin ladder nests;
call-center is exact and orthogonal.

| Level | Admits |
|---|---|
| `off` | **nobody** — a kill-switch |
| `all` | any authenticated user (any valid `ns_t`, any scope) |
| `call_center_agent` | `Call Center Agent` only |
| `call_center_supervisor` | `Call Center Supervisor` only |
| `super_user` | `Super User` only (the apex scope, exactly) |
| `reseller` | `Reseller`, `Super User` |
| `office_manager` | `Office Manager`, `Reseller`, `Super User` |
| `site_manager` | `Site Manager`, `Office Manager`, `Reseller`, `Super User` |
| `advanced_user` | `Advanced User` + all admins above |
| `basic_user` | `Basic User`, `Advanced User` + all admins above |
| `superadmin` | only the accounts in `PORTAL_SUPERADMINS` |

- **The ladder nests**: `basic_user` ⊇ `advanced_user` ⊇ `site_manager` ⊇ `office_manager` ⊇ `reseller` ⊇
  `super_user`. A lower rung as a *level name* is the **broader** set — "this scope and everyone above".
  `Super User` is in every admin set; `super_user` targets it *exactly*.
- **`super_user` is not `superadmin`.** The first is the platform's top *role*; the second is the *account
  list* in `PORTAL_SUPERADMINS`.
- **Call-center levels admit only their own scope** — never each other, never an admin role. They compose
  *onto* a gate (`["call_center_supervisor", "reseller"]`) but never cascade upward.
- **`Simple User`** (a rare tier below Basic) has no dedicated level — reach it with `all`.
- Scope word-forms are matched exactly, case-insensitively. `reseller`, `office_manager`, `site_manager`,
  `basic_user`, `call_center_agent` and `call_center_supervisor` are confirmed against live tokens.
  `advanced_user` and `super_user` use the standard NetSapiens forms (the engine also canonicalizes
  `superuser`/`super-user`) — verify against your own `ns_t` if you gate to them, as `Advanced User` in
  particular is not present on every deployment.

<a id="feature-registry"></a>

### The feature registry

| Key | Feature | Default |
|---|---|---|
| `portal.access` | Receive the injected admin bundle at all | `office_manager` |
| `callflow.view` | The call-flow diagram button + viewer | `reseller` |
| `ringotel.orgStatus` | Toolbar app-status banner | `reseller` |
| `ringotel.userStatus` | Per-user app column (Users page) | `office_manager` |
| `ringotel.orgList` | Per-domain app column (Domains page) | `reseller` |
| `ringotel.refresh` | Force a fleet-wide app-directory rebuild | `reseller` |
| `ringotel.profileStatus` | App active/inactive indicator on the user-profile page | `office_manager` |
| `ringotel.activate` | Activate/deactivate a user's app from the profile page (**write**) | `office_manager` |
| `ringotel.resetPassword` | Reset a user's app password from the profile page (**write**) | `office_manager` |
| `ringotel.profileAppAccess` | The user-visible app sign-in message, on the profile page | `office_manager` |
| `ringotel.prepop` | Preview/create inactive directory entries for a domain (**write**) | `reseller` |
| `portal.domainCreate` | The portal's own **Add Domain** control (see [below](#domain-record-keys)) | `reseller` |
| `portal.domainEdit` | The portal's own **Edit** controls for a domain's configuration record (see [below](#domain-record-keys)) | `reseller` |
| `portal.domainDelete` | The portal's own **delete** control for a domain (see [below](#domain-record-keys)) | `reseller` |
| `portal.self` | Receive the **self-service** bundle | `all` |
| `me.appStatus` | App-status indicator on the user's **own** home page | `all` |
| `me.devices` | The user's **own** device list/status | `off` |
| `me.resetPassword` | Reset the user's **own** app password (**write**) | `off` |
| `me.appAccess` | App sign-in details on the Apps menu and home card | `all` |
| `me.menuConfig` | Portal menu customization | `all` |
| `portal.versionLine` | This kit's name + version in the portal footer | `all` |
| `portal.statusBanner` | The status banner across the top of the portal | `all` |
| `onebill.view` | The OneBill links page and the account panel | `reseller` |
| `onebill.write` | Set, edit or clear a link; accept or clear an item; assign an item to an account (**write**) | `superadmin` |
| `kit.status` | The integration console (floored — see below) | `superadmin` |

Widening who may write a link to a named biller, on top of the `superadmin` default:

```jsonc
{ "onebill.write": { "levels": ["superadmin"], "users": ["billing@acme.example"] } }
```

**Self-service is its own tier.** `portal.access` gates the admin bundle along the admin ladder;
`portal.self` gates a separate, minimal bundle of **own-account** features that even a Basic or Simple user
receives. A self-service caller can reach **only** the `me.*` routes, and each derives identity from the
caller's signed token (via the NetSapiens `~` self-wildcard) — never from client input, so a user only ever
sees or changes their own account. `me.devices` and `me.resetPassword` ship **off**; enable them with
`PORTAL_FEATURES` (and, for the reset write, the domain must also be on `RINGOTEL_WRITE_DOMAINS`). Setting
`portal.self` to `off` disables the whole self-service tier.

**Two features ride that bundle without being self-service**, and it is worth knowing which so you look for
their settings in the right place: `me.menuConfig` and `portal.versionLine` are operator configuration
applied to everyone. They need the self bundle's reach — every signed-in user — but neither is about the
reader's own account. Turning `portal.self` off therefore also removes the menu customization and the
footer version line, which is the one surprise in that switch.

<a id="portal-features-shapes"></a>

### `PORTAL_FEATURES` — the four shapes

```jsonc
{
  "ringotel.orgStatus":  "reseller",                                           // 1. single level
  "ringotel.userStatus": ["office_manager", "call_center_agent"],              // 2. union of levels
  "callflow.view":       { "levels": ["reseller"], "users": ["x@y.example"] }, // 3. levels + users
  "ringotel.orgList":    "off"                                                 // 4. kill-switch
}
```

Disambiguation is by type: `"x"` → a level · `["x","y"]` → a union of levels · `{...}` → levels plus named
users. An unknown key or level is a **loud config error** — a 500 on every route after `/health`. It never
silently allows.

<a id="gate-users-deny"></a>

#### Denying named accounts — `users.deny`

*Naming the exception instead of its complement. This is the shape to reach for on `portal.domainCreate`, `portal.domainEdit` and `portal.domainDelete` — see [the domain-record keys](#domain-record-keys) for what those three do and do not prevent.*

Inside shape 3, `users` may be a plain list (which means **allow**, and is unchanged) or an object naming a
direction:

| Written | Means |
|---|---|
| `"users": ["a@y.example"]` | allow these, in addition to any `levels` |
| `"users": {"allow": ["a@y.example"]}` | identical to the line above |
| `"users": {"deny": ["b@y.example"]}` | **this feature's default, minus these accounts** |
| `"users": {"allow": […], "deny": […]}` | both; **deny wins** where they overlap |

The deny form exists because the allow form cannot say "everyone who has this today, except two people"
without listing everyone who *keeps* it — a list that is wrong the moment an account is created, and wrong
silently. So this:

```jsonc
{ "portal.domainEdit": { "users": { "deny": ["junior@y.example"] } } }
```

reads as *"reseller — this key's default — except that account"*, and stays correct as staff are added,
because the scope side is evaluated from each caller's own token rather than from a list you maintain.

`allow` rather than `allowOnly`: the list still unions with `levels`, so "only" would be untrue whenever
`levels` is present. Write no `levels` and the allow list is the whole gate, exactly as before.

<a id="gate-add-to-existing"></a>

##### Adding one to a config you already have

`PORTAL_FEATURES` is **one JSON object**, so a gate is a top-level entry in it beside the ones already
there. Adding a deny means adding a key — not nesting it under anything, and not replacing what is there.
Starting from a config that re-levels two features:

**Before:**

```jsonc
{ "ringotel.userStatus": "site_manager",
  "callflow.view":       ["reseller", "office_manager"] }
```

**After** — two keys added, the existing two untouched:

```jsonc
{ "ringotel.userStatus": "site_manager",
  "callflow.view":       ["reseller", "office_manager"],
  "portal.domainEdit":   { "users": { "deny": ["junior@y.example"] } },
  "portal.domainDelete": { "users": { "deny": ["junior@y.example"] } } }
```

Three things that catch people out here:

- **Every key is independent.** Adding `portal.domainDelete` says nothing about `portal.domainEdit`; a key
  you do not name keeps its registry default. That is why these are three keys rather than one — see
  [the domain-record keys](#domain-record-keys).
- **You are replacing the whole value, not editing it in place.** `PORTAL_FEATURES` is a single string in
  `wrangler.jsonc` (or a single Dashboard variable), so "adding a key" means writing the whole object back
  with the key in it. Do not retype it: the console's **Permissions** tab → *Copy the configuration* emits
  your current overrides as paste-ready JSON, and *What else you can write* below it carries a deny example
  validated against this deployment's own parser.
- **The account is `user@domain`, exactly as it appears in the token** — the same address the person signs
  in with, `100@customer.example` or `name@your-company.example` as your platform issues them. A deny entry
  that cannot be an account at all is a loud config error, but one that is merely the *wrong* account is
  not: it restricts nobody, silently. The Permissions tab grows a **Named** column as soon as any gate
  names an account, and a misspelt address is sitting in it, spelled wrong — which is the only place that
  particular mistake becomes visible at all.

<a id="gate-resolution-rules"></a>

### Resolution rules

- **`off` is absolute:** denied to everyone — no roles, no forced users, no superadmins. To peek at an
  off feature, flip it to `superadmin` or add your account to its `users`.
- For any other gate, a principal is granted if **any** of these match: the resolved level role-sets, the
  gate's forced `users`, **or** a `PORTAL_SUPERADMINS` account (unless the gate is call-center-only).
- **Named users win over roles:** an account in `users` (or `users.allow`) is granted even with no
  qualifying role.
- **`{ "users": ["x@y.example"] }`** with no `levels` means "off for roles, on for these accounts" (plus
  superadmins) — distinct from `off`.
- **A `users.deny` beats everything else in that gate**, including a `PORTAL_SUPERADMINS` account and an
  `allow` naming the same person. It is the one place a superadmin is refused other than `off`; that is
  deliberate, because a deny that names an account and then quietly does not apply to it is the worse of
  the two surprises.
- **A deny follows the person through a masquerade.** Every other condition is evaluated against the
  *effective* principal — so a grant follows the role currently being performed, and masquerading is full
  impersonation, as it is everywhere in this platform. A deny is the exception: it names a person, and it
  refuses whether that account is acting as itself or behind a mask. A denial that ended the moment its
  subject masqueraded into someone else would not be one.
- **A gate that only denies is read against the feature's own default.** `{"users":{"deny":[…]}}` with no
  `levels` and no `allow` means *that default, minus these accounts* — see
  [the table above](#gate-users-deny). Writing `"allow": []` explicitly is not the same thing: an empty
  allow list names nobody, so it is refused as a config error rather than guessed at.
- **A `deny` entry must look like `user@domain`**, and is a loud config error otherwise. A typo in an
  allow list merely admits nobody extra; a typo in a deny list restricts nobody, silently — the failure
  runs the wrong way, so this one list is checked.
- Secondary scripts use the **same** level vocabulary in their `auth` field, plus `public`.

<a id="domain-record-keys"></a>

### The domain-record keys — a guardrail, not a permission

`portal.domainCreate`, `portal.domainEdit` and `portal.domainDelete` are unlike every other key here, and
the difference matters before you rely on them.

Every other feature gates something **this kit adds**, and the same key gates the route behind it — so
denying one both hides the control and refuses the work. These three hide controls belonging to **your
NetSapiens portal**: the `Add Domain` button on the domains list, the edit and delete controls on each row,
and the `Edit Domain` button shown while viewing a domain. Those forms post straight from the browser to
your NetSapiens core. This kit is not in that path and cannot be.

**So denying one removes the way in, not the ability.** Someone who knows the URL is unaffected, and a
portal update that renames a control means the control simply stays — it fails toward *visible*, never
toward a false sense that something was blocked. Use it to keep the wrong click out of reach of someone who
should not be making it. For anything that must actually be prevented, the platform's own scopes are the
only thing that can prevent it.

Three keys rather than one so that *"may adjust a customer's limits, may never delete the customer"* is
expressible. The default is `reseller` on all three, which changes nothing anywhere: no lower scope is
offered these controls by the portal, so the keys are inert until you configure one.

#### What to write

The usual configuration is a **deny**, because the ask behind these keys is almost always "everyone who has
this today, except these people". A deny with no `allow` side reads as *this key's own default* — `reseller`
— *minus the accounts named*, so it stays correct as staff are added. The full grammar is
[Denying named accounts](#gate-users-deny); these are the four configurations worth having in front of you.

**One person, kept out of the destructive one.** They keep the Add Domain button and the Edit controls:

```jsonc
{ "portal.domainDelete": { "users": { "deny": ["junior@y.example"] } } }
```

**May adjust a customer's limits, may never delete the customer** — the split these three keys exist to
express. Each key is independent, so naming two leaves the third at its default:

```jsonc
{ "portal.domainDelete": { "users": { "deny": ["junior@y.example"] } },
  "portal.domainCreate": { "users": { "deny": ["junior@y.example"] } } }
```

**All three, for several accounts.** One list per key, repeated — there is no "all domain keys" shorthand,
deliberately, since the three are meant to be set apart:

```jsonc
{ "portal.domainCreate": { "users": { "deny": ["junior@y.example", "temp@y.example"] } },
  "portal.domainEdit":   { "users": { "deny": ["junior@y.example", "temp@y.example"] } },
  "portal.domainDelete": { "users": { "deny": ["junior@y.example", "temp@y.example"] } } }
```

**Narrow the level as well.** The explicit form says both halves at once — which levels hold the key, and
who is carved out of them. Use it when you are also changing the level; the short form above is better when
you are not, because it does not pin a default:

```jsonc
{ "portal.domainDelete": { "levels": ["reseller"], "users": { "deny": ["junior@y.example"] } } }
```

Adding any of these to a `PORTAL_FEATURES` you already have is
[a top-level key beside the ones already there](#gate-add-to-existing) — the whole object is rewritten with
the key in it, and every key you do not name keeps its default.

Two things that surprise people, both covered in full under [Resolution rules](#gate-resolution-rules):
a deny **beats a `PORTAL_SUPERADMINS` account**, which no other gate value does short of `off`; and a deny
**follows the person through a masquerade**, matching the operator behind the mask as well as the identity
being worn. An empty `"levels": []` or `"allow": []` is a config error rather than a silent "everybody
minus these" — name who keeps the feature, or write the deny on its own.

Editing a domain's **record** is not the same as administering what is inside it. Users, call queues, auto
attendants, time frames and inventory are untouched by these keys — someone denied domain editing can still
work inside any domain they can open, which is usually the point.

<a id="kit-status-gate"></a>

### The console's own gate (`kit.status`)

Defended harder than anything else here, because the page names other customers' domains and settings, and
every scope below reseller is domain-locked everywhere else in this kit.

**Two independent gates, and they are not the same rule:**

1. `PORTAL_FEATURES["kit.status"]` may name only `off`, `superadmin`, `super_user`, or `reseller` — never
   a lower level. Naming one is a **configuration error refused when the configuration is parsed**, which
   means **every route after `/health` returns 500** until you fix it. Note what that is and is not: the
   deploy succeeds and the Worker starts, so this looks like a running deployment that answers nothing
   rather than a failed release. `/health` still responds, and still reports the version — which is why it
   is the first thing to check.
2. Independently, **at request time**, the console requires the caller to hold reseller scope or be a
   listed superadmin account. Naming a domain-locked account under `kit.status`'s `users:` grants that
   account nothing here — it gets a 403 explaining why.

The floor in (1) constrains which **levels** may be granted, not which **named accounts** are. An operator
who reads it as "the floor alone makes this page safe" could name one customer's office manager under
`users:` and believe that is a smaller grant than it is; it is not a grant at all, because of gate (2).

⚠️ **Multi-reseller caveat.** Widening `kit.status` to `reseller` is justified by "a reseller can already
enumerate the whole fleet via `/domains`" — true, but only on a deployment with **exactly one reseller**.
If yours serves several independent resellers, the request-time gate admits *any* reseller-scope
principal, so Reseller A widened to `reseller` would also see Reseller B's domain names and settings — an
actual cross-tenant disclosure. If that is your topology, **leave `kit.status` at `superadmin`** and grant
access to specific trusted accounts via `PORTAL_SUPERADMINS`.

---

<a id="menu-targeting"></a>

## Menu targeting

Anywhere a list of entries is accepted you may instead give an object, and **one rule covers every case: a
default plus specific overrides.** There is no separate "include" and "exclude" syntax because you do not
need one:

| You want | Write |
|---|---|
| change everywhere | `["A"]` — or `{"*": ["A"]}` |
| change everywhere **except** some | `{"*": ["A"], "acme.example": []}` |
| change **only** some | `{"*": [], "acme.example": ["A"]}` |

**The axes**, and the keys each accepts:

| Axis | Keys |
|---|---|
| `users` | `user@domain` accounts |
| `domains` | NetSapiens domain names, exact |
| `scopes` | `Super User`, `Reseller`, `Office Manager`, `Site Manager`, `Advanced User`, `Basic User`, `Simple User`, `Call Center Agent`, `Call Center Supervisor`, plus `*`. Spelling is forgiving — `Office Manager`, `office_manager` and `officeManager` are one key |
| `app` | `ringotel` (an app organization is active for the domain), `none` (none is), `*` (either) |

**Precedence, most specific first: `users` → `domains` → `scopes` → `app` → `"*"`.** Naming an account beats
naming their domain, which is the only reason to name one — it is how you carve an exception out of a
domain-wide rule. A matching `domains` entry wins **outright**; it is *not* merged with the app list,
because otherwise "turn it off just here" would be inexpressible. A `"*"` **inside** an axis is a default,
so an exact match on any axis still beats it.

> **The `scopes` axis matches one scope exactly — it does not nest**, unlike the feature levels above where
> `office_manager` means "Office Manager *and everyone above*". That difference is the point: it is what
> lets you write "office managers and their users, but not resellers", which no feature level can say.

A misspelled app, scope or menu name is a **startup error**, not a rule that silently never matches. While
a user is being **masqueraded**, the scope that matches is the *masqueraded* user's — an administrator
viewing a session sees the menu that user sees.

### Added entries

`add` entries take `label`, a `url`, an optional `title`, and optionally `"handoff": "ns_t"` (below).
Added links open in a new tab.

**URL schemes:** `https://` and `mailto:` only. Anything else — notably `javascript:` and `data:` — is
refused at startup, so a dangerous scheme can never reach the page.

<a id="menu-handoff"></a>

**Handoff entries.** An entry with `"handoff": "ns_t"` opens the destination **with the signed-in user's
own session token**, so a tool of yours can act as that user without a second login:

```json
{"management": {"add": {"scopes": {"Reseller": [
  { "label": "Bulk tool", "url": "https://tools.example.com/launch", "handoff": "ns_t" }
]}}}}
```

It is drawn as a form, not a link. When the user clicks it, the browser POSTs one field named `ns_t` to
the `url` in a new tab; the token is read from the page at that moment and never appears in the address
bar, in browser history, in a `Referer`, or in an access log. The value is the literal string `ns_t` —
a boolean is refused — so a second kind of handoff, if one is ever added, is a new value rather than a
second flag.

Three rules apply on top of the ordinary URL rules, and each is a startup error when broken:

| Rule | Why |
|---|---|
| The `url` must be `https://` — `mailto:` cannot carry a POST | The token travels only in a request body over TLS. |
| The url's origin must be listed in [`PORTAL_HANDOFF_ORIGINS`](#PORTAL_HANDOFF_ORIGINS) | Two settings have to agree before a credential leaves, so a menu edit alone cannot re-aim it. |
| The receiver verifies the token and its issuer itself | This kit only decides *when* the token leaves and *where it may go*; the destination decides whether to trust it. Do not point a handoff at a tool that does not check. |

The entry is only ever served to a signed-in user: the menu plan is fetched with the caller's own token,
and a page with no token in it cancels the click and sends nothing. **Under masquerade the page holds the
masqueraded user's session, so that is what the handoff carries** — the receiver acts as that user, which
is the same rule every other decision here follows while masquerading. Variables work in the path and query
as for any entry; the host is pinned, as for any entry.

**Variables.** `label`, `url` and `title` may contain placeholders, filled in per signed-in user:

| Variable | Value |
|---|---|
| `{ext}` | their extension |
| `{domain}` | their PBX domain |
| `{email}` | their email address |
| `{fname}` / `{lname}` | first / last name |
| `{name}` | display name (falls back to first + last) |
| `{page}` | the portal page they are on **when they click** |

Values are percent-encoded in a URL, so a name containing a space or `&` cannot inject an extra query
parameter. A variable may **not** appear in the host — `https://{fname}.example.com/x` is refused at
startup — because the destination has to be a decision you made, not one a user's own profile field can
change. In a `label` or `title` the value is shown as-is, since those are read by a person. Everything
except `{page}` is substituted on the server from the signed-in user's **own** record, so one user can
never interpolate another's details. `{page}` is filled in the browser and is the **path only**, never the
query string, since a portal URL's query can carry identifiers and the link may leave for a third party. A
variable with no value becomes empty rather than leaving a literal `{email}` in a live link; a misspelled
one (`{emial}`) is a startup error.

### Worked examples

**Try your first rule on yourself.** Every rule accepts a `users` rung, so a change can be real for one
account before anyone else sees it:

```json
{ "apps": { "hide": { "users": { "you@yourdomain.example": ["SNAPmobile Web"] }, "*": [] } } }
```

That is the whole preview mechanism, and it is why there is no separate preview mode: `"*": []` means
*change nothing for everyone else*, so the blast radius is one account until you decide otherwise.

**Hide an entry only where your app is active**, leaving the stock menu alone on domains that have no app,
so those users keep their only softphone entry. This is the case a plain list cannot express:

```json
{ "apps": { "hide": { "app": { "ringotel": ["SNAPmobile Web"], "none": [] } } } }
```

**The same, but not on one domain.** A domain entry wins outright, so `[]` means "change nothing here":

```json
{ "apps": { "hide": { "app":     { "ringotel": ["SNAPmobile Web"], "none": [] },
                      "domains": { "acme.example": [] } } } }
```

**Add a static link for everyone:**

```json
{ "apps": { "add": [ { "label": "Support", "url": "https://support.example.com", "title": "Get help" } ] } }
```

**Put a help link on the user's own menu instead**, where it sits with their other personal actions:

```json
{ "account": { "add": [ { "label": "Email Support",
                          "url": "mailto:support@example.com?subject=Help%20for%20{name}%20({ext}@{domain})",
                          "title": "Opens your mail client" } ] } }
```

**Add a tool to the Management menu, for resellers only.** The portal already restricts that menu to
administrative scopes; the scope rung makes it exact:

```json
{ "management": { "add": { "scopes": { "Reseller": [ { "label": "Device Provisioning",
                                                      "url": "https://provisioning.example.com/manage" } ] },
                           "*": [] } } }
```

**Show it to office managers and their users, but not to resellers** — the support desk belongs to the
customer, not to the partner who administers them:

```json
{ "account": { "add": { "scopes": { "Reseller": [], "Super User": [] },
                        "*": [ { "label": "Email Support", "url": "mailto:support@example.com" } ] } } }
```

**A "get help" link that arrives already identified:**

```json
{ "apps": { "add": [
  { "label": "Get help",
    "url": "https://support.example.com/new?ext={ext}&domain={domain}&from={page}" } ] } }
```

---

<a id="secondaries-reference"></a>

## Secondary scripts

Beyond the built-in bundles, the primary can load **additional** scripts you list in
[`PORTAL_SECONDARIES`](#PORTAL_SECONDARIES) — a JSON array where each entry is
`{ "name": "...", "from": "...", "auth": "..." }`:

```jsonc
[
  { "name": "my-feature",     "from": "url:https://cdn.example.com/my-feature.js", "auth": "public" },
  { "name": "reseller-tools", "from": "r2:reseller-tools",                          "auth": "reseller" }
]
```

**`from` picks the source:**

- **`url:<absolute-url>`** — an external script the browser loads **directly**. The Worker never touches
  it, so it is effectively public.
- **`r2:<key>`** — the file `<key>.js` in a **private R2 bucket** bound to the Worker as
  [`ASSETS`](#ASSETS). The Worker **serves and gates** it at `/kit/asset/<name>.js`, so its bytes never
  leave the Worker except to an entitled caller. This is how you ship a script that must stay private, or
  be gated per role.

**`auth` is the gate:** `public` (no token), or any [level](#level-vocabulary). For an `r2:` entry a
non-`public` level means the Worker requires a valid `ns_t` of that tier before serving the bytes
(per-tier cached). For a `url:` entry the browser loads it directly, so its `auth` is **advisory** — real
gating needs `r2:`.

**Binding the bucket.** `r2:` sources need the `ASSETS` binding in `wrangler.jsonc` pointing at your
bucket; upload each `<key>.js` there and it ships with `wrangler deploy` plus a cache purge. Deployments
with no `r2:` entries need no binding — `PORTAL_SECONDARIES` can stay `"[]"`.

> **The round-trip rule (why `r2:` exists).** The browser cannot do per-domain authorization, so anything
> domain-scoped — a customer's names, a per-tenant option — must **not** ship in client JS. Resolve it in a
> Worker round-trip that returns only the current user's data; every built-in feature already does this. A
> `url:` script is public bytes, and a gated `r2:` script keeps the *code* private but is still not a
> substitute for server-side scoping of *data*.

---

<a id="events-reference"></a>

## Event subscriptions in depth

Read this before enabling [Change events](#group-events).

- **A pushed event is a trigger, not data.** The receiver extracts only *which user changed*, then re-reads
  that user from the API and syncs from the response. So a field missing from a payload can never be
  mistaken for a field that was cleared, and a replayed delivery is a no-op.
- **The callback URL is a capability, not a password.** Its path token is derived per domain, so one leaked
  URL exposes one tenant rather than all of them. But NetSapiens stores that URL, returns it when you list
  subscriptions, and logs it — treat it accordingly.
- **Your other subscriptions are never touched.** Only subscriptions whose URL starts with your own
  `NS_EVENTS_BASE_URL` are managed; anything else on the same domain is reported and left alone.
- **Going inert cleans up after itself.** Drop a domain from `NS_EVENTS_DOMAINS` while others remain and
  the next reconcile deletes its subscription. Emptying the list **entirely**, or setting `NS_EVENTS=off`,
  does the same at the next reconcile: a delete-only pass removes every subscription this deployment owns,
  then plans nothing else — **provided the callback origin and the service credentials are still
  configured.** Remove those first and nothing is left able to clean up.

**Retiring the feature, in order.** Empty `NS_EVENTS_DOMAINS` (or set `NS_EVENTS=off`) → let one reconcile
run → verify the subscriptions are gone → *then* remove the secrets. Removing the credentials first leaves
nothing able to clean up, and deleting the Worker outright always strands its subscriptions. Changing
`NS_EVENTS_BASE_URL` likewise orphans subscriptions created under the previous origin, because the URL
prefix is what marks them as ours — rotate an origin with the same delete-first discipline.

**Cost, and the one plan trap.** With `NS_EVENTS_DEVICE_REPAIR` set to `report` or `heal`, every processed
event does extra work on top of its normal user lookup, and `heal` adds a write when it actually repairs
something. A full batch at the default `NS_EVENTS_MAX_EVENTS` (40) with repair on can land in the low
hundreds of subrequests for a single delivery — comfortably inside a paid Workers plan's per-invocation
limit, but potentially over a free plan's. Size `NS_EVENTS_MAX_EVENTS` accordingly on a free plan.

---

<a id="where-each-value-goes"></a>

## Where each value goes

**`vars` in `wrangler.jsonc`** — non-secret, committed, visible to anyone who can read your repo:

`NS_SERVER`, `NS_PORTAL_ISS`, `ALLOWED_ORIGINS`, `CACHE_SCOPE`, `NS_DEVICE_DETAILS`,
`ALLOWED_DOMAINS`, `BLOCKED_DOMAINS`, `PRIMARY_BASENAME`, `PORTAL_HANDOFF_URL`, `PORTAL_SECONDARIES`,
`PORTAL_FEATURES`, `PORTAL_RELEASE_NOTES_URL`, `STATUS_BANNER_WEBHOOK`, `RINGOTEL_APP_BASE_URL`,
`PORTAL_MENUS`, `PORTAL_APPS_HIDE`, `RINGOTEL_BASE_URL`, `RINGOTEL_PRESENCE`, `RINGOTEL_OVERRIDES`,
`RINGOTEL_ROTATE_SIP_ON_ACTIVATE`, `RINGOTEL_ACTIVATION_SUFFIX`, `RINGOTEL_EXCLUDE_*`,
`RINGOTEL_RESELLER_OVERRIDE`, `RINGOTEL_PREPOP_INCLUDE_SOFT`, `RINGOTEL_SSO_SERVICE`, `SSO_AUTO_ACTIVATE`,
`PORTAL_APP_DOWNLOADS`, `NS_EVENTS`, `NS_EVENTS_BASE_URL`, `NS_EVENTS_MODELS`,
`NS_EVENTS_TARGET_LIFETIME`, `NS_EVENTS_RENEW_HORIZON`, `NS_EVENTS_GEO_SUPPORT`, `NS_EVENTS_MAX_EVENTS`,
`NS_EVENTS_SWEEP_MAX`, `NS_EVENTS_DIAG_RAW`, `NS_EVENTS_OFFBOARD`, `NS_EVENTS_DEVICE_REPAIR`,
`NS_EVENTS_ALLOW_IPS`, `NS_EVENTS_PREFERRED_SERVER`, `NS_OAUTH_SERVER`, `BRAND_ACCENT`,
`ONEBILL_TENANT_ID`, `ONEBILL_BASE_URL`, `ONEBILL_LINK_GROUP`, `ONEBILL_USAGE_OFFERS`,
`ONEBILL_USAGE_IGNORE`, `ONEBILL_RECURRING_RULES`, `NS_FAX_SERVER_HOSTS`, `NS_DEVICE_SUFFIXES`.

**Secrets** — `wrangler secret put <NAME>`, never committed:

`RINGOTEL_API_KEY`, `NS_EVENTS_PATH_SECRET`, `NS_API_KEY` (or `NS_ADMIN_USER` / `NS_ADMIN_PASS` with
`NS_OAUTH_CLIENT_ID` / `NS_OAUTH_CLIENT_SECRET`), `PORTAL_SUPERADMINS`, `ONEBILL_CLIENT_SECRET`,
`ONEBILL_USERNAME`, `ONEBILL_PASSWORD`.

**Bindings** — structural entries in `wrangler.jsonc`: `ASSETS`, `ONEBILL_DB`, `JWT_RATE_LIMITER`.

⚠️ **Deployment-identifying values belong in secrets even though they are not credentials.**
`RINGOTEL_WRITE_DOMAINS`, `NS_EVENTS_DOMAINS`, `ALLOWED_DOMAINS`, `BLOCKED_DOMAINS`, any
`RINGOTEL_EXCLUDE_*` value that names a real domain or reseller, `BRAND_NAME`, `RINGOTEL_LABEL` and
`RINGOTEL_LABEL_SHORT` all say which provider you run on and which customers you serve. In a private repo
a var is fine; **if your copy of this repo is public, they must be secrets.**

**Locally:** `cp .dev.vars.example .dev.vars` and fill it in. That file is also what the *Deploy to
Cloudflare* button reads to build its prompt form, which is why it is kept short — every key in it is one
more blank box a newcomer has to understand.
