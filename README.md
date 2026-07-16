# ns-portal-kit

A deployable toolkit of add-ons for the **NetSapiens Manager Portal**, running on Cloudflare Workers.
Bring your own NetSapiens credentials and Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dszp/ns-portal-kit)

That clones this repo into your own GitHub account and deploys it to your own Cloudflare — you pick the
repo and Worker names on the way through. There are no bindings to provision (no KV, R2, D1, or Durable
Objects), so it deploys clean.

It **won't** be working yet: the button can't prompt for credentials, so the first deploy lands with
placeholder settings. Open `/` and it hands you a checklist of exactly what to set. See
[Quick start](#quick-start).

- **Call-flow diagrams** — resolve a domain's routing (DID → time-of-day → auto-attendant menu →
  queue → agents → voicemail/external) and render it as a Mermaid diagram, live from the API. A
  viewer SPA with a theme picker, pan/zoom, and PNG export comes with it.
- **Ringotel app status** — optional enrichment: per-user app presence and device counts, joined to
  the NetSapiens extension.
- **Device details** — optional: desk-phone model and SIP registration state.

Read-only. It never writes to NetSapiens.

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

Then configure — this part can't be automated, because neither C3 nor the deploy button can prompt for
values:

```bash
# 1. point it at your NetSapiens server
#    edit wrangler.jsonc -> vars.NS_SERVER   (and NS_PORTAL_ISS for delegated auth)

# 2. give it a token (service mode — reads any domain the token is scoped to)
wrangler secret put NS_API_TOKEN

# 3. run it
pnpm dev            # http://localhost:8787
pnpm deploy
```

**Not sure what's missing?** Open `/` on an unconfigured deployment and it tells you: a checklist of
exactly which settings are unset, with the fix for each. `GET /health` reports the same as
`{"ok":true,"configured":false}`. Both report only *whether* a setting is present — never its value —
and the checklist disappears once setup is complete.

Everything else is off until you turn it on.

## Two auth modes

**Service mode** — a stored `NS_API_TOKEN` reads any domain the token is scoped to, which enables the
domain browser and the viewer SPA. The token's NetSapiens scope is the real boundary, so a broad
(reseller) token can read your whole fleet.

> **Put this behind something.** With `workers_dev: true` and no gate, anyone who finds the URL
> inherits your token's scope. Set `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` to turn on the in-Worker
> Cloudflare Access check (it fails closed, so a direct-route or `*.workers.dev` hit is refused even
> with a valid token configured), and/or `ALLOWED_DOMAINS` to bound it at the app layer.

**Portal mode** (`PORTAL_MODE=1`) — no service token at all. The portal user's `ns_t` arrives as
`Authorization: Bearer …`, is validated (cached, fail-closed), and reads are scoped to that user:
resellers may read across domains, everyone else is locked to their own. This is the mode for a
Manager Portal injection backend.

## Configuration

Required:

| Var | What |
|---|---|
| `NS_SERVER` | your NetSapiens API host, e.g. `api.example.com` |
| `NS_PORTAL_ISS` | the Manager Portal host issuing your `ns_t`. **No default** — a default issuer would mean accepting tokens minted by a portal you don't control. Comma-separate for several portal hostnames fronting one backend (exact match, no wildcards). |

Secrets (`wrangler secret put <NAME>`), all optional:

| Secret | Effect |
|---|---|
| `NS_API_TOKEN` | enables service mode |
| `RINGOTEL_API_KEY` | **the Ringotel gate.** Absent ⇒ no Ringotel calls, no enrichment, its routes 404. The Worker is then exactly the NetSapiens-only baseline — a tested invariant. |
| `RINGOTEL_LABEL` / `RINGOTEL_LABEL_SHORT` | white-label display names (default `Ringotel`) |
| `BRAND_NAME` | your company name → `"<name> Portal Kit v<ver>"` and a `"<name> portal"` theme |

Optional vars: `BRAND_ACCENT` (hex), `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN`, `PORTAL_MODE`,
`ALLOWED_ORIGINS`, `ALLOWED_DOMAINS`, `BLOCKED_DOMAINS`, `RINGOTEL_PRESENCE`, `NS_DEVICE_DETAILS`.

**Branding is config, never source.** Unset, you get the neutral `ns-portal` theme (the stock
NetSapiens scheme) and "NS Portal Kit".

## No bindings to provision

No KV, R2, D1, or Durable Objects. All caching uses the Workers Cache API (`caches.default`), so a
fork deploys with nothing to set up first.

## Built on

- [`@dszp/netsapiens-lib`](https://github.com/dszp/netsapiens-lib) — the portable NetSapiens toolkit
  (read-only client, `ns_t` validation, resolver, renderers)
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

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how it fits together, the `ns_t` design, the NetSapiens
  routing model, and the rendering traps.

## License

[MIT](./LICENSE) © David Szpunar
