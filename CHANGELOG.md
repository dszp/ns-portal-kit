# Changelog

Notable changes to **ns-portal-kit**.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Which version am I running?** `GET /health` on your deployment reports it:

```json
{ "ok": true, "configured": true, "version": "0.1.1" }
```

Compare that against the latest entry below to see whether there's anything worth pulling. Updating is
`git fetch upstream && git merge upstream/main` — see
[SETUP.md → Getting updates later](./SETUP.md#7-getting-updates-later).

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/dszp/ns-portal-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dszp/ns-portal-kit/releases/tag/v0.1.0
