# ns-portal-kit

A deployable toolkit of add-ons for the **NetSapiens Manager Portal**, running on Cloudflare Workers.
Bring your own NetSapiens credentials and Cloudflare account.

> ### 📖 Read **[SETUP.md](./SETUP.md)** first — before you deploy.
> It's short, and it covers the two things the deploy form can't tell you: **which of the two modes you
> want** (they're different products, and one needs JavaScript that isn't published yet), and **what
> each field means**. Ten minutes there saves an afternoon.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dszp/ns-portal-kit)

That clones this repo into **your own** GitHub account and deploys to **your own** Cloudflare. The form
asks for everything up front — Worker name, `NS_SERVER`, your API token, and which mode to run — so a
click-through gives you a working deployment. No bindings to provision (no KV, R2, D1, or Durable
Objects), so it deploys clean.

**Two modes, one form.** Leave `PORTAL_MODE` blank for an internal tool for your team (needs
`NS_API_TOKEN`) — **start here**. Set it to `1` for a Manager Portal add-on backend, where every request
carries the calling user's own login token and no credential is stored at all. Want both? Click the
button twice — two Workers from this one repo. See **[SETUP.md](./SETUP.md)**.

> **Portal backend mode needs an injection script that isn't published yet.** It's the backend half: nothing
> calls it until JS running inside your Manager Portal does. A reference script is planned; until then
> portal backend mode means writing that yourself. Standalone mode is complete and works today.

- **Call-flow diagrams** — resolve a domain's routing (DID → time-of-day → auto-attendant menu → queue
  → agents → voicemail/external) and render it as a Mermaid diagram, live from the API. Comes with a
  viewer: theme picker, pan/zoom, PNG export. *Both modes.*
- **Ringotel app status** — a reseller banner, a per-user app column, and an app column on the domain
  list. *Portal backend mode only* — these live inside the Manager Portal.
- **Enrichment on the diagrams** — app presence and desk-phone model/registration shown inline on agent
  lines. *Both modes, optional.*

## Quick start

Scaffold it with Cloudflare's own CLI:

```bash
npm create cloudflare@latest my-portal -- --template=dszp/ns-portal-kit
```

Or clone it directly:

```bash
git clone https://github.com/dszp/ns-portal-kit && cd ns-portal-kit
pnpm install
```

**Try it locally first** — no Cloudflare Access, no deploy, nothing to provision:

```bash
cp .dev.vars.example .dev.vars     # add your NS_API_TOKEN
npx wrangler dev                   # -> http://localhost:8787
```

The viewer runs against your live NetSapiens data. (The service-token gate exempts localhost — it isn't
internet-reachable, so there's nothing to expose.) Fastest way to see if this is useful to you.

Then configure for a real deploy (the button asks for all of this on its form instead):

```bash
# 1. point it at your NetSapiens server
#    edit wrangler.jsonc -> vars.NS_SERVER   (and NS_PORTAL_ISS for delegated auth)

# 2. give it a token (standalone mode — reads any domain the token is scoped to)
wrangler secret put NS_API_TOKEN

# 3. copy the local-dev template and fill in what you need
cp .dev.vars.example .dev.vars

# 4. run it
pnpm dev            # http://localhost:8787
pnpm run deploy     # `run` matters: bare `pnpm deploy` is a pnpm builtin, not this script
```

**Not sure what's missing?** Open `/` on an unconfigured deployment and it tells you: a checklist of
exactly which settings are unset, with the fix for each. `GET /health` reports the same as
`{"ok":true,"configured":false}`. Both report only *whether* a setting is present — never its value —
and the checklist disappears once setup is complete.

> `.dev.vars.example` doubles as the deploy button's prompt list — Cloudflare reads it and asks for each
> key. `NS_SERVER`/`NS_PORTAL_ISS` are deliberately absent from it and live in `wrangler.jsonc` `vars`:
> a key in both is prompted twice and then shadowed by the config value, silently ignoring the answer.

Everything else is off until you turn it on.

## Two auth modes

**Standalone mode** — a stored `NS_API_TOKEN` reads any domain the token is scoped to, which enables the
domain browser and the viewer SPA. The token's NetSapiens scope is the real boundary, so a broad
(reseller) token can read your whole fleet.

> **Put this behind something.** With `workers_dev: true` and no gate, anyone who finds the URL
> inherits your token's scope. Set `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` to turn on the in-Worker
> Cloudflare Access check (it fails closed, so a direct-route or `*.workers.dev` hit is refused even
> with a valid token configured), and/or `ALLOWED_DOMAINS` to bound it at the app layer.

**Portal backend mode** (`PORTAL_MODE=1`) — no stored credential at all. It has no UI: it's the **backend half
of a Manager Portal add-on**. You inject JavaScript into your portal; that JS reads the logged-in
user's `ns_t` (which the portal already issued), sends it here, and this Worker forwards it to
NetSapiens verbatim — so every read runs **as that user**, with their scope enforced by the platform
rather than by us. Your JS then updates the live page with what comes back.

**You supply that JavaScript today** — a reference implementation is planned but not published yet, so
portal backend mode is currently the advanced path. Standalone mode needs nothing extra.
[The full flow, with a diagram →](./SETUP.md#4-portal-backend-mode-what-it-actually-is)

## Configuration

A working deployment needs **three** settings:

| Setting | Where | What |
|---|---|---|
| `NS_SERVER` | `vars` in `wrangler.jsonc` | your NetSapiens API host, e.g. `api.example.com` |
| `NS_PORTAL_ISS` | `vars` in `wrangler.jsonc` | the Manager Portal host that issues your `ns_t` |
| `NS_API_TOKEN` | secret | a NetSapiens API token (standalone mode; blank for portal backend mode) |

Everything else is **optional and off unless set** — access gating, domain scoping, branding, Ringotel
app status, device details.

**→ [SETUP.md](./SETUP.md) defines every setting**: what it means, what a valid value looks like, and
whether it belongs in `vars` or a secret. Start there if a field on the deploy form isn't obvious.

**Branding is config, never source.** Unset, you get the neutral `ns-portal` theme (the stock
NetSapiens scheme) and "NS Portal Kit".

## No bindings to provision

No KV, R2, D1, or Durable Objects. All caching uses the Workers Cache API (`caches.default`), so a
fork deploys with nothing to set up first.

## Built on

- [`@dszp/netsapiens-lib`](https://github.com/dszp/netsapiens-lib) — the portable NetSapiens toolkit
  (API client, `ns_t` validation, resolver, renderers)
- [`@dszp/ringotel-lib`](https://github.com/dszp/ringotel-lib) — the portable Ringotel AdminAPI toolkit

Both are Node-free and run unchanged in a Worker, in Node, or the browser.

## Develop

```
pnpm install
pnpm typecheck
pnpm test                      # offline suites; no credentials needed
pnpm test:worker <snapshot.json>   # needs a real domain snapshot (not in this repo)
pnpm flow <snapshot.json> gallery  # offline CLI -> out/*.gallery.html
```

**Verify Worker changes in real workerd, not just the tests.** The offline suites stub `caches` and
`fetch` and run under Node's lenient undici, so they won't catch Workers-specific traps — a global
like `fetch` called as `this.x(...)` throws "Illegal invocation" in workerd but passes in Node. Boot
`pnpm dev` and hit `/health` plus one real endpoint before trusting a change.

## Docs

- **[SETUP.md](./SETUP.md)** — every setting, what it means, and what a valid value looks like. Start
  here if a field on the deploy form isn't obvious.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how it fits together, the `ns_t` design, the NetSapiens
  routing model, and the rendering traps.
- **[CHANGELOG.md](./CHANGELOG.md)** — what changed, and how to tell which version you're running
  (`GET /health` reports it) so you know whether there's anything worth pulling.

## License

[MIT](./LICENSE) © David Szpunar
