# ns-portal-kit

A deployable toolkit of add-ons for the **NetSapiens Manager Portal**, running on Cloudflare Workers.
Bring your own NetSapiens platform and Cloudflare account.

It is the **backend half of a Manager Portal add-on**: the Worker serves a small JavaScript file, your
portal loads it, and every call that script makes carries **the signed-in user's own portal token**. No
NetSapiens credential is stored for user traffic, and NetSapiens enforces each caller's scope — so your
users get more inside the portal they already use, without logging in anywhere else.

> ### 📖 Read **[SETUP.md](./SETUP.md)** first — before you deploy.
> It is short. It covers what each feature is for, what that feature needs, and the one thing the deploy
> form cannot tell you: **who can point your Manager Portal at this Worker**, because nothing reaches a
> user until somebody does — and if you are a reseller under another carrier, that somebody is not you.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dszp/ns-portal-kit)

That clones this repo into **your own** GitHub account and deploys to **your own** Cloudflare. The form
asks for everything up front, so a click-through gives you a working deployment. No bindings to provision
(no KV, R2, D1, or Durable Objects), so it deploys clean.

## What it adds to your portal

Everything is **off until you turn it on**, and each is independently gated to a role.

- **Call-flow diagrams** — a **Call Flow** button on the pages where a routable entity lives (Inventory,
  Call Queues, Auto Attendants, Users). It resolves that entity's live routing — DID → time-of-day →
  auto-attendant menu → queue → agents → voicemail/external — and renders it from the API, not from a
  stored picture. Pan/zoom, theme picker, export.
- **Softphone app status** — a reseller banner with the app domain at a glance, a per-user column on the
  Users page, and an app column on the domain list. NetSapiens does not know your app platform exists;
  this is what makes "does this user have the app" answerable without opening a second console.
- **App activation and password reset, from the user's profile** — activate, deactivate, or reset a user's
  app account without leaving NetSapiens, plus a preview-and-apply tool that pre-populates a whole domain's
  directory. These are writes, gated harder than anything else here and bounded by an explicit list of
  domains they may touch.
- **App sign-in details, shown to the user** — the Apps menu and the user's home page explain how *that
  specific person* signs in: which app domain, which username, and where the password comes from (their
  portal password under SSO, or the credentials email otherwise — worded from the organization's own
  setting rather than hedged). A user who cannot yet sign in is told so, instead of being shown credentials
  that would not work.
- **The same message, for operators** — on the user-profile page a reseller or office manager sees the
  *user-visible* sign-in message for the person they are editing, so they can talk them through it or see
  why that user is not set up yet.
- **Menu customization** — add and hide entries in the Apps menu, the user's own account dropdown, and the
  Management dropdown, targeted by domain, by NetSapiens **role**, by account, and by whether an app is
  actually active for that domain — so a support link can reach office managers and their users without
  cluttering an administrator's menu. Added links can interpolate the signed-in user's own details plus the
  page they are on, which makes a "get help" link arrive already identified.
  See [CONFIG.md](./CONFIG.md#group-menus).
- **A status banner** across the top of the portal, with the text supplied by an endpoint you host — so a
  maintenance notice goes up and comes down without a redeploy.
- **Change-event sync** — NetSapiens pushes subscriber changes here, so the app directory stays correct
  even when someone is edited directly in NetSapiens rather than through the portal. This is the one
  feature that holds a stored credential, because an event arrives with no caller. Off unless configured.
- **The integration console** — a read-only **Super Portal Kit** page inside the portal reporting how the
  deployment is actually configured: every feature and whether it can *run* as opposed to merely being
  *allowed*, a permissions matrix, every setting with its current value and a copy-ready config line, a
  menu builder, and live checks against NetSapiens and your app platform.
- **Enrichment on the diagrams** — app presence and desk-phone model/registration inline on agent lines.

## Quick start

**Deploying with a coding agent? That's the recommended path** — point it at
[AGENTS.md](./AGENTS.md) ("read AGENTS.md and deploy this for me; ask me the questions it says to ask").
It turns the setup reference into an ordered procedure, asks you the decisions that are yours to make, and
won't quietly enable a write feature or point a webhook at somebody else's host. The manual route is below
and stays fully supported.

Scaffold it with Cloudflare's own CLI:

```bash
npm create cloudflare@latest my-portal -- --template=dszp/ns-portal-kit
```

Or clone it directly:

```bash
git clone https://github.com/dszp/ns-portal-kit && cd ns-portal-kit
pnpm install
```

Then configure and deploy (the button asks for all of this on its form instead):

```bash
# 1. edit wrangler.jsonc -> vars
#    NS_SERVER            your NetSapiens API host
#    NS_PORTAL_ISS        the Manager Portal host that issues your ns_t
#    PORTAL_HANDOFF_URL   your vendor bundle-router URL, or "" if you run no add-on
#    ALLOWED_ORIGINS      https://your-portal-host

# 2. name at least one superadmin, or nobody can open the console — including you
wrangler secret put PORTAL_SUPERADMINS

# 3. deploy
pnpm run deploy     # `run` matters: bare `pnpm deploy` is a pnpm builtin, not this script
```

Then give your Manager Portal one URL — `https://<your-worker>/p.js` — and open the console from inside
the portal to decide what else you want on. **[SETUP.md](./SETUP.md)** walks the whole path.

**Not sure what's missing?** `GET /health` reports `{"ok":true,"configured":false}` until everything
required is set. It reports only *whether* a setting is present, never its value.

> `.dev.vars.example` doubles as the deploy button's prompt list — Cloudflare reads it and asks for each
> key. `NS_SERVER`/`NS_PORTAL_ISS` are deliberately absent from it and live in `wrangler.jsonc` `vars`:
> a key in both is prompted twice and then shadowed by the config value, silently ignoring the answer.

## How the auth works

No stored credential for user traffic, and no second login. Your portal loads the primary script; it reads
the `ns_t` the portal already issued for the signed-in user; the Worker verifies that token is real and has
not been logged out, then forwards it to NetSapiens **verbatim**. Every read therefore runs *as that user*,
with their scope enforced by the platform rather than by us. Two users hitting the same Worker see
different data because NetSapiens says so.

The Worker serves the JavaScript too — point your Manager Portal's injected-script slot at the primary
(`https://<your-worker>/<PRIMARY_BASENAME>.js`) and it fetches the gated feature bundles (admin +
self-service) and injects them. You can also compose it into a script you already inject, or add your own
gated secondaries (`PORTAL_SECONDARIES`, external or private-R2).
[The full flow, with a diagram →](./SETUP.md#portal-backend-mode)

## Configuration

A working deployment needs **three** settings:

| Setting | Where | What |
|---|---|---|
| `NS_SERVER` | `vars` in `wrangler.jsonc` | your NetSapiens API host, e.g. `api.example.com` |
| `NS_PORTAL_ISS` | `vars` | the Manager Portal host that issues your `ns_t` |
| `PORTAL_HANDOFF_URL` | `vars` | your vendor bundle-router URL, or `""` for none — **absent and `""` mean different things** |

Plus `PORTAL_SUPERADMINS` (a secret) if you want to be able to open the console, and `ALLOWED_ORIGINS`
(your portal's origin) so the browser is allowed to call the Worker at all.

Everything else is **optional and off unless set** — domain scoping, branding, the app integration, menus,
the status banner, change events.

**→ [CONFIG.md](./CONFIG.md) defines every setting**: what it means, what a valid value looks like, and
whether it belongs in `vars`, a secret, or a binding. **[SETUP.md](./SETUP.md)** is the ordered path
through a first deployment; start there if a field on the deploy form isn't obvious.

**Branding is config, never source.** Unset, you get the neutral `ns-portal` theme (the stock NetSapiens
scheme) and "NS Portal Kit".

## No bindings to provision

No KV, D1, or Durable Objects — and R2 only if you choose to serve your own gated scripts from it. All
caching uses the Workers Cache API (`caches.default`), so a fresh copy deploys with nothing to set up
first.

## Built on

- [`@dszp/netsapiens-lib`](https://github.com/dszp/netsapiens-lib) — the portable NetSapiens toolkit
  (API client, `ns_t` validation, resolver, renderers)
- [`@dszp/ringotel-lib`](https://github.com/dszp/ringotel-lib) — the portable Ringotel AdminAPI toolkit

Both are Node-free and run unchanged in a Worker, in Node, or the browser.

## Develop

```
pnpm install
pnpm typecheck
pnpm test                      # every offline suite; no credentials, no snapshot needed
pnpm test:worker <snapshot.json>   # optional: run it against a snapshot of your own
pnpm flow <snapshot.json> gallery  # offline CLI -> out/*.gallery.html
```

**Verify Worker changes in real workerd, not just the tests.** The offline suites stub `caches` and
`fetch` and run under Node's lenient undici, so they won't catch Workers-specific traps — a global
like `fetch` called as `this.x(...)` throws "Illegal invocation" in workerd but passes in Node. Boot
`npx wrangler dev` and hit `/health` plus one real endpoint before trusting a change.

## Docs

- **[SETUP.md](./SETUP.md)** — what each feature is for, what it needs, and how to get deployed. Start
  here.
- **[CONFIG.md](./CONFIG.md)** — the settings reference: every value, its default, and what happens when
  you leave it out.
- **[AGENTS.md](./AGENTS.md)** — deploying this, written for a coding agent: the order of operations, the
  decisions that belong to you rather than to it, and what it must not do on your behalf. Point an agent at
  this file if you're delegating the deployment.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how it fits together, the `ns_t` design, the NetSapiens
  routing model, and the rendering traps.
- **[CHANGELOG.md](./CHANGELOG.md)** — what changed, and how to tell which version you're running
  (`GET /health` reports it) so you know whether there's anything worth pulling.

## License

[MIT](./LICENSE) © David Szpunar
