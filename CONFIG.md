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
- [Portal menus](#group-menus) — `PORTAL_MENUS` · `PORTAL_APPS_HIDE`
- [App integration](#group-ringotel) — `RINGOTEL_API_KEY` and its display settings
- [Activation rules](#group-eligibility) — the write rail and the exclusion lists
- [Self-service app access](#group-appaccess) — `RINGOTEL_SSO_SERVICE` · `SSO_AUTO_ACTIVATE` · `PORTAL_APP_DOWNLOADS`
- [Change events](#group-events) — the 15 `NS_EVENTS_*` settings
- [Background service identity](#group-identity) — `NS_API_KEY`, or admin credentials + OAuth
- [Branding](#group-branding) — `BRAND_NAME` · `BRAND_ACCENT` · `BRAND_LABEL`
- [Worker bindings](#group-bindings) — `ASSETS` · `JWT_RATE_LIMITER`
- **Reference sections**
  - [Features and gating](#features-and-gating) — the level vocabulary, the feature registry, `PORTAL_FEATURES`, resolution rules
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

Adding and hiding entries in the portal's stock menus. Gated by `me.menuConfig` (default `all`).

> Hiding a menu entry is **cosmetic, not a security control.** It removes a link, not access to whatever
> the link pointed at. Never use it to "lock" a feature — that is what the gates are for.

**Use the builder, not this syntax.** The console's **Menus** tab reads the menus off the portal page you
opened it from, so you tick real entries instead of typing labels and hoping they match. It emits both the
readable JSON and the escaped `wrangler.jsonc` line, and validates the result against your own deployment
before you paste it anywhere. Everything below is what the builder composes — worth reading once, not
worth typing.

<a id="PORTAL_MENUS"></a>

### `PORTAL_MENUS` · `vars`

JSON adding and hiding entries in the **Apps**, **account** and **Management** menus, optionally targeted
by user, domain, NetSapiens scope, or whether your app is active for that domain.

- **Example**
  `{"apps": {"hide": {"app": {"ringotel": ["SNAPmobile Web"], "none": []}}, "add": [{"label": "Support", "url": "https://support.example.com"}]}}`
- **Unset** No customization from this setting. `PORTAL_APPS_HIDE`, if set, still applies independently.
- **Needs no other integration.** With no app API key set the app state is `none`, so static add and hide
  work on any deployment.
- **Full targeting model, variables and URL rules:** [Menu targeting](#menu-targeting).

**Which menus you can target.** Menus are referenced by name — you never supply a CSS selector, which
would break on portal updates and would turn an environment variable into a DOM-injection surface:

| Name | Menu | Where entries are added |
|---|---|---|
| `apps` | the portal's **Apps** dropdown | appended after the stock entries |
| `account` | the signed-in user's **own name** dropdown | into the first group, **above** the divider and the sign-out entry |
| `management` | the top-nav **Management** dropdown — **not stock**, added by a vendor add-on, shown to administrative scopes only. Targeting it on a portal that lacks it is not an error; nothing appears. | appended at the **end** |

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

Accent colour used in the flow modal and the branded theme.

- **Example** `#1a6bb0`
- **Must be hex** (`#rgb` or `#rrggbb`). Anything else is ignored.
- **Unset** The neutral `ns-portal` theme, which matches the stock Manager-Portal scheme.

<a id="BRAND_LABEL"></a>

### `BRAND_LABEL` · `vars`

Override the theme picker's label for your brand theme.

- **Example** `Acme Portal`
- **Unset** `"<BRAND_NAME> portal"` when `BRAND_NAME` is set, else `"Brand"`.

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
| `portal.self` | Receive the **self-service** bundle | `all` |
| `me.appStatus` | App-status indicator on the user's **own** home page | `all` |
| `me.devices` | The user's **own** device list/status | `off` |
| `me.resetPassword` | Reset the user's **own** app password (**write**) | `off` |
| `me.appAccess` | App sign-in details on the Apps menu and home card | `all` |
| `me.menuConfig` | Portal menu customization | `all` |
| `portal.versionLine` | This kit's name + version in the portal footer | `all` |
| `portal.statusBanner` | The status banner across the top of the portal | `all` |
| `kit.status` | The integration console (floored — see below) | `superadmin` |

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
  "callflow.view":       { "levels": ["reseller"], "users": ["x@y.example"] }, // 3. levels + forced users
  "ringotel.orgList":    "off"                                                 // 4. kill-switch
}
```

Disambiguation is by type: `"x"` → a level · `["x","y"]` → a union of levels · `{...}` → levels plus forced
users. An unknown key or level is a **loud config error** — a 500 on every route after `/health`. It never
silently allows.

<a id="gate-resolution-rules"></a>

### Resolution rules

- **`off` is absolute:** denied to everyone — no roles, no forced users, no superadmins. To peek at an
  off feature, flip it to `superadmin` or add your account to its `users`.
- For any other gate, a principal is granted if **any** of these match: the resolved level role-sets, the
  gate's forced `users`, **or** a `PORTAL_SUPERADMINS` account (unless the gate is call-center-only).
- **Forced users win over roles:** an account in `users` is granted even with no qualifying role.
- **`{ "users": ["x@y.example"] }`** with no `levels` means "off for roles, on for these accounts" (plus
  superadmins) — distinct from `off`.
- Secondary scripts use the **same** level vocabulary in their `auth` field, plus `public`.

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

`add` entries take `label`, a `url`, and an optional `title`. Added links open in a new tab.

**URL schemes:** `https://` and `mailto:` only. Anything else — notably `javascript:` and `data:` — is
refused at startup, so a dangerous scheme can never reach the page.

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
`NS_EVENTS_ALLOW_IPS`, `NS_EVENTS_PREFERRED_SERVER`, `NS_OAUTH_SERVER`, `BRAND_ACCENT`, `BRAND_LABEL`.

**Secrets** — `wrangler secret put <NAME>`, never committed:

`RINGOTEL_API_KEY`, `NS_EVENTS_PATH_SECRET`, `NS_API_KEY` (or `NS_ADMIN_USER` / `NS_ADMIN_PASS` with
`NS_OAUTH_CLIENT_ID` / `NS_OAUTH_CLIENT_SECRET`), `PORTAL_SUPERADMINS`.

**Bindings** — structural entries in `wrangler.jsonc`: `ASSETS`, `JWT_RATE_LIMITER`.

⚠️ **Deployment-identifying values belong in secrets even though they are not credentials.**
`RINGOTEL_WRITE_DOMAINS`, `NS_EVENTS_DOMAINS`, `ALLOWED_DOMAINS`, `BLOCKED_DOMAINS`, any
`RINGOTEL_EXCLUDE_*` value that names a real domain or reseller, `BRAND_NAME`, `RINGOTEL_LABEL` and
`RINGOTEL_LABEL_SHORT` all say which provider you run on and which customers you serve. In a private repo
a var is fine; **if your copy of this repo is public, they must be secrets.**

**Locally:** `cp .dev.vars.example .dev.vars` and fill it in. That file is also what the *Deploy to
Cloudflare* button reads to build its prompt form, which is why it is kept short — every key in it is one
more blank box a newcomer has to understand.
