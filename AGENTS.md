# AGENTS.md — deploying this project

For a coding agent asked to **deploy** `ns-portal-kit` for an operator. It carries the order of operations
and the decisions that belong to a human; it does **not** restate what each setting means — that is
[CONFIG.md](./CONFIG.md), linked at each step. One fact, one place.

If you are changing the code rather than deploying it, this file is not for you: read
[ARCHITECTURE.md](./ARCHITECTURE.md) and run `pnpm test`.

Two things make this deployment unusual, and both are decisions rather than commands:

- **It is a backend for JavaScript loaded by the operator's Manager Portal**, and somebody has to point
  the portal at it. That somebody may not be the operator.
- **The configuration names your customers.** Domain lists, a portal hostname and brand strings are
  ordinary settings here, so *where the config lives* is a privacy decision, not a preference.

---

## STOP — find out who controls the injected-script slot

Everything here is a backend. It holds no credential for user traffic, has no UI of its own, and does
nothing at all until the operator's Manager Portal loads one script from it. **Ask before you deploy
anything**, because the answer sets the timeline and it may not be the operator's to give:

| Who they are | What has to happen |
|---|---|
| **They operate the NetSapiens platform**, or have Manager-Portal admin access to the injected-/custom-JS setting | They point that slot at the Worker's primary URL themselves. Minutes. |
| **They are a reseller or partner under another provider or carrier** | The portal-wide injected-script setting is an upstream control they most likely **cannot** change. It becomes a **request to their provider** — give them the exact URL and let them file it. Nothing works until it is honoured, and you cannot estimate how long that takes. |

Deploy anyway if they want — the Worker is useful to have standing and verified before the request goes
in — but state plainly that no feature reaches a single user until the portal loads the primary. Do not
present a deployed Worker as a finished job.

**One credential question, asked separately.** Ordinary user traffic carries only the calling user's own
`ns_t`; nothing is stored. **Change-event subscriptions are the one exception**: turning them on gives this
Worker a stored NetSapiens credential (`NS_API_KEY`, or an admin pair), because an event arrives with no
caller attached and something has to read NetSapiens on nobody's behalf. That is its own decision, asked
below, and it is off unless every one of its settings is present.

## Step 1 — get the code as a PRIVATE copy

**Default: a private repository they own.** Not a fork. A fork of a public repository is itself public, and
this project's `wrangler.jsonc` legitimately holds `NS_SERVER`, the Manager Portal hostname, and domain
allow/block lists — so a public fork publishes which provider the operator runs on and which customer
domains they serve. That is the operator's business information, and it is permanent once pushed.

Two ways to get one, depending on whether the operator wants a terminal:

- **No terminal:** use the *Deploy to Cloudflare* button and tick **Create private Git repository**. The
  button copies the code into their account and wires auto-deploy.
- **Terminal:** clone, create an empty private repo in their account, and push to it.

Either way, the copy has **no link back upstream**, so add one once — this is the whole update story:

```bash
git remote add upstream https://github.com/dszp/ns-portal-kit   # once
git fetch upstream && git merge upstream/main                   # to update, later
git push                                                        # deploys if wired to Workers Builds
```

Conflicts are rare and boring: `wrangler.jsonc` is the file the operator edited and the file most likely to
change upstream. Their `vars` are theirs — keep them.
Detail: [SETUP.md § Getting updates later](./SETUP.md#getting-updates).

**Other cases, and what changes:**

| Case | Consequence you must state |
|---|---|
| **Public fork** (they want the *Sync fork* button) | The config is public. Then **every value that names a customer domain, a reseller, or a brand must be a secret**, not a var — `ALLOWED_DOMAINS`, `BLOCKED_DOMAINS`, `RINGOTEL_WRITE_DOMAINS`, `NS_EVENTS_DOMAINS`, `RINGOTEL_EXCLUDE_*`, `BRAND_NAME`. See [CONFIG.md § Where each value goes](./CONFIG.md#where-each-value-goes). |
| **`npm create cloudflare@latest my-portal -- --template=dszp/ns-portal-kit`** | Scaffolds with no git relationship at all, so there is no update path until they add the `upstream` remote above. |
| **Repo connected to Workers Builds** | **Editing variables in the Cloudflare dashboard will not stick** — the next build overwrites `vars` from `wrangler.jsonc`. Edit the file. (Secrets are not overwritten.) |

## Ask the operator these — do not choose them

Each answer becomes configuration, and each default is the *quiet* option rather than the useful one.

| Ask | Why you must not decide it |
|---|---|
| **Who controls the injected-script slot?** (above) | It decides whether this is finished today or waiting on a third party. |
| **Which accounts should be superadmins?** | `PORTAL_SUPERADMINS` is the account list that passes every gate, and it is the **only** thing that admits anyone to the integration console — the page that reports how the deployment is actually configured. **Unset, it admits nobody**, so skipping this question produces a working deployment that nobody can inspect. Ask for at least one account; do not pick them. |
| Which domains should be visible? | `ALLOWED_DOMAINS` is an app-layer bound **on top of** each caller's own NetSapiens scope. Without it, the deployment is bounded only by what each user could already see — which is correct, but it is also the operator's only lever for a cautious first rollout. |
| Should app activation **writes** be enabled, and for which domains? | `RINGOTEL_WRITE_DOMAINS` mutates a **third-party** app system: activating users, deactivating them, resetting passwords. **Empty means every write is refused**, which is the safe state; `*` means every in-scope domain. Note activation now **replaces the SIP password of a softphone device it did not create** (`RINGOTEL_ROTATE_SIP_ON_ACTIVATE`, default on) — correct, but it will break anything else still registering with that credential, so the operator should be told rather than surprised. |
| Should **change-event subscriptions** be enabled? | This is the only thing that puts a stored NetSapiens credential on this Worker, and it also publishes a callback URL and needs a cron trigger. In exchange, a user renamed or re-emailed in NetSapiens reaches the app directory without anyone clicking anything. Off unless all of its settings are present. |
| Should **directory pre-population** be enabled, and who may run it? | It creates *inactive* app-directory entries in bulk for users who have none — a write, gated by `ringotel.prepop` (default `reseller`) and bounded by `RINGOTEL_WRITE_DOMAINS`. Harmless in itself, but it is the operator's directory and they should expect it to fill up. |
| Who should see each feature? | Defaults are deliberate (`callflow.view` = `reseller`, the write features = `office_manager`). Widening a gate is a policy change about who can act on customers. |
| Should the portal's **menus** be customized? | `PORTAL_MENUS` adds and hides entries in menus the operator's *customers* use. It is cosmetic and never a security control — hiding a link does not remove access to what it pointed at — but it lands on real users' portals. A first rule should be scoped to one account or one domain and widened after they have looked at it. |
| Is there an endpoint that will supply the **status banner** text? | `STATUS_BANNER_WEBHOOK` names a URL **the operator has to build and host**. The kit renders whatever that endpoint returns and has no message store of its own, so there is no way to "just set a message" here — see the Never entry below. If they do not have such an endpoint, the answer is to leave it unset. |
| Brand name and accent colour? | Branding is configuration here, never source. Absent it ships unbranded, which is correct until they tell you otherwise. |

Settings, formats and defaults: [CONFIG.md](./CONFIG.md) ·
[§ Features and gating](./CONFIG.md#features-and-gating) ·
[§ Change events](./CONFIG.md#group-events) ·
[§ Activation rules](./CONFIG.md#group-eligibility).

## Never

- **Never leave `PORTAL_HANDOFF_URL` absent, and never set it to a URL to "fill it in".** Absent and empty
  mean opposite things: absent is treated as *undecided* and reported as unconfigured by `/health`; `""` is
  a deliberate "this Worker chain-loads no vendor bundle" and is the correct answer for an operator with no
  vendor add-on. Ask which they are; do not guess, and never invent a vendor URL.
- **Never treat `NS_API_KEY` as an ordinary API token to reuse.** It performs privileged writes **on behalf
  of nobody** when an event arrives, so the caller-scope bound that limits every other write here does not
  apply to it. Make it a dedicated least-privilege key — NetSapiens can restrict a key by model, domain and
  IP — rather than reusing whatever credential is already to hand.
- **Never give two deployments the same `NS_EVENTS_BASE_URL`.** Subscription ownership is decided by URL
  prefix, so two Workers sharing an origin will fight over one subscription set, each reconciling the
  other's away. And it must be an **origin** — a path breaks every callback.
- **Never let two Workers on one zone share a `CACHE_SCOPE`.** Cloudflare's `caches.default` is zone-wide,
  not per Worker, so a shared value means each deployment serves the other's cached app data. `env` blocks
  do **not** inherit `vars`, so each needs its own.
- **Never rotate `NS_EVENTS_PATH_SECRET` casually.** Rotation is not seamless: every existing callback is
  refused from the moment it changes until a reconcile re-points it, and deliveries in that window are
  lost. If you rotate, trigger a reconcile immediately.
- **Never put a value that names a customer domain, reseller, or brand into a committed file** unless the
  operator has confirmed the repository is private. Prefer a secret; see the fork row above.
- **Never invent `NS_SERVER` or `NS_PORTAL_ISS`.** `NS_PORTAL_ISS` has no default *on purpose* — a default
  would mean accepting tokens minted by a portal the operator does not control. Ask; do not guess from a
  domain name.
- **Never point `STATUS_BANNER_WEBHOOK` at anything but an endpoint the operator controls, and never invent
  one to see the feature work.** Every portal page load sends the calling user's live `ns_t` to that host —
  a working NetSapiens credential for that user, from every user who loads the portal. It must be `https`
  for the same reason. **The operator supplies the responder; the kit has no message store**, so there is no
  way to "just type a message" here and no default endpoint to fall back to. **If they do not already have
  an endpoint that returns banner text, the correct configuration is to leave the setting unset** — the
  feature is then completely inert: nothing is requested and nothing is drawn. Do not stand up a placeholder
  service, and do not point it at a third party's webhook tester. *(This division — kit owns the surface,
  operator owns the message — is deliberate and may change in a future version; today the responder is
  theirs to build.)*
- **Never widen `kit.status` to reach the console.** It accepts only `off`, `superadmin`, `super_user` or
  `reseller`; anything lower is refused when the configuration is parsed, which makes **every route after
  `/health` return 500** — the deploy itself succeeds, so this surfaces as a running Worker that answers
  nothing. The fix for "I cannot open the console" is naming an account in `PORTAL_SUPERADMINS`, not
  lowering the gate. On a deployment serving **more than one reseller**, widening it to `reseller` is an
  actual cross-tenant disclosure: the request-time gate admits any reseller-scope principal, so one
  reseller would see the others' domain names and settings.
- **Never enable a write feature that was not asked for**, and never widen `RINGOTEL_WRITE_DOMAINS` to `*`
  to make a test pass.
- **Never put the same key in both `vars` and `.dev.vars`.** The `wrangler.jsonc` value wins silently. This
  is the classic way to "set" `ALLOWED_DOMAINS` and have it do nothing.
- **Never commit `.dev.vars`.**
- **Never invent a config value to get past an error.** A missing answer is a question for the operator;
  an invented one converts a loud startup error into a silent misconfiguration.

## The sequence

1. **Install.**
   ```bash
   pnpm install        # or: npm install
   ```

2. **Configure.** Edit `wrangler.jsonc` `vars`: `NS_SERVER`, `NS_PORTAL_ISS`,
   `PORTAL_HANDOFF_URL` (a vendor router URL, or `""`), and `ALLOWED_ORIGINS` (the Manager Portal origin,
   scheme included) — then the answers from the questions above. Leave anything you were not told about
   unset; absent is a safe answer for every optional setting here.
   Reference: [SETUP.md § Before you start](./SETUP.md#prerequisites).
   - *Deploying more than one Worker:* give each `env` block a distinct `CACHE_SCOPE`, and remember `env`
     blocks do not inherit top-level `vars`. One Worker can leave the default alone.

3. **Set the secrets.** **Secrets are per-environment** — if you used `env` blocks, pass `--env <name>` or
   the secret lands on the wrong Worker and the deployment looks unconfigured for no visible reason.
   - ***Set `PORTAL_SUPERADMINS` now, with the accounts the operator named.***
     ```bash
     npx wrangler secret put PORTAL_SUPERADMINS --env <name>   # them@theirdomain.example
     ```
     This is what admits anyone to the integration console, and **unset it admits nobody** — so skipping it
     produces a deployment that works and that no one can look inside. It is a secret, so it can be changed
     later without a redeploy; setting it before the first deploy just means there is never a console you
     cannot open. Reference: [CONFIG.md § PORTAL_SUPERADMINS](./CONFIG.md#PORTAL_SUPERADMINS).
   - `RINGOTEL_API_KEY` if any app feature is wanted — that one key gates all of them.
   - Plus anything the fork/privacy decision moved out of `vars`.

4. **Deploy.**
   ```bash
   pnpm run deploy     # `run` matters: bare `pnpm deploy` is a pnpm builtin, not this script
   ```

5. **Hand over the primary URL.** Confirm `https://<your-worker-host>/p.js` returns **200** and JavaScript
   (`p` is the default `PRIMARY_BASENAME`), then give that exact URL to whoever controls the Manager
   Portal's injected-script slot — the operator, or their provider. Two more settings live in two different
   places and fail the same silent way: the Worker's `ALLOWED_ORIGINS` must include the portal origin, and
   the **portal's** Content-Security-Policy `script-src` must allow the Worker host. Detail, including how
   to compose the primary into a script the operator already injects:
   [SETUP.md § Point your portal at the primary](./SETUP.md#primary-url).

6. **If the operator's portal is already serving real customers, roll out narrow.** Do not go from nothing
   to everyone in one step: `ALLOWED_DOMAINS` set to one expendable domain, and `portal.access` +
   `portal.self` gated to the operator's own account, makes the first live test a change to exactly one
   person. Widen afterwards, one axis at a time. Procedure and the exact `PORTAL_FEATURES` line:
   [SETUP.md § A safe first deploy](./SETUP.md#safe-first-deploy). State what the other users experience
   meanwhile — they still load a few kilobytes of primary that is refused every bundle and injects nothing.

7. **Only if change-event subscriptions were asked for.** Confirm first that the operator's NetSapiens
   release exposes the flat `/subscriptions` endpoints — a core without them cannot register anything, and
   that is a platform fact you cannot configure around. Then: set `NS_EVENTS_BASE_URL` to *this
   deployment's own* origin, `NS_EVENTS_DOMAINS` (it can never exceed `RINGOTEL_WRITE_DOMAINS`), the
   `NS_EVENTS_PATH_SECRET` secret and the service credential — **and add a cron trigger to that
   environment** (`"triggers": { "crons": ["17 * * * *"] }`). Without the trigger the receiver still works
   and nothing ever reconciles, which is the failure that looks like success.
   Reference: [CONFIG.md § Change events](./CONFIG.md#group-events).

## Verify, in this order

Each rung proves something the previous one did not.

1. **`GET /health`** → `{"ok":true,"configured":true,...}`. Proves the Worker is deployed and routing, and
   reports whether configuration is complete — never any value. `configured:false` most often means
   `PORTAL_HANDOFF_URL` was left absent. It also reports the deployment's cache `scope`: if the operator
   runs more than one Worker, **compare that field across them**. Two deployments reporting the same scope
   are sharing a cache, which is invisible from either one.

2. **`/` returns 404, and that is correct.** There is no tool surface on a user-facing endpoint. A 404 here
   is not a broken deploy.

3. **Hit a route other than `/health` once.** An unknown key or unknown level in `PORTAL_FEATURES` is a
   **loud 500 on every route after `/health`**, by design. If `/health` is fine and everything else 500s,
   the feature configuration is wrong — not the deployment.

4. **Open `/p.js` directly.** 200 plus JavaScript proves the primary is live at the exact path you are
   about to hand over. This one step separates "the Worker is broken" from "the portal is not loading it",
   which are indistinguishable from inside the portal.

5. **Open the integration console, as a superadmin.** Sign in to the Manager Portal as an account named in
   `PORTAL_SUPERADMINS` and look for a bold **Super Portal Kit** entry. **Where it appears depends on the
   portal, and the common case is not the obvious one:**
   - **At the top of the signed-in user's own name dropdown** — this is where it lands on a **stock**
     NetSapiens portal, and it is what to expect unless you know otherwise.
   - **In the Management dropdown**, where the portal has one. That menu is **not stock** — a vendor add-on
     supplies it — and the console prefers it when present, because an operator tool belongs among
     administrative entries rather than among someone's personal links.

   Same gate, same page either way. This is the rung that replaces reading the configuration back to
   yourself: the **environment badge** says which deployment you are looking at, **Overview** lists whatever
   the setup checklist still wants, **Features** and **Integrations** separate *off* from **inert** (allowed,
   but unable to run because a setting it needs is absent — the state that looks like working configuration
   from every other angle), and **Checks** makes live calls that prove a credential works rather than merely
   being present.

   **If it refuses you**, the refusal names which of two things is wrong — no superadmin named, or the
   feature switched off in `PORTAL_FEATURES`. It will not name who *is* admitted; that would leak the
   account list to whoever asked. Walkthrough:
   [SETUP.md § The first five minutes](./SETUP.md#first-five-minutes).

   **The console reports configuration and reachability, not whether the portal is actually loading the
   script.** That is the next rung, and nothing here substitutes for it.

6. **A real portal page load, by a real user.** Nothing synthetic exercises the injection, the `ns_t` the
   portal stored, or the feature gating. Check the browser console is clean, then confirm a feature the
   caller is actually entitled to appears — and that one they are not entitled to does not. That second half
   is the only check that proves gating rather than assuming it.

7. **Subscriptions, if enabled: change a real user in NetSapiens and watch it arrive.** Rename a test user
   in the Manager Portal, then confirm the new name reaches the app directory without anyone touching this
   Worker's UI. That is the whole feature; nothing short of it proves the subscription is registered, the
   callback reachable, and the credential sufficient. Then confirm the reconcile job has run at least once
   — a registered subscription with no reconcile is a subscription nobody is keeping alive.

## Things that fail silently

- **`env` blocks do not inherit top-level `vars`.** Every environment needs its own complete `vars` block;
  a missing one does not warn, it is simply absent at runtime.
- **An absent `PORTAL_HANDOFF_URL` is not an empty one.** Absent reports the deployment unconfigured and
  shows resellers a warning banner; `""` is the deliberate no-handoff answer. They look identical in a
  config file and mean opposite things.
- **The Workers **Free** plan caps 50 subrequests per request.** A large domain's call-flow diagram fans out
  into many NetSapiens calls and can exceed it, so the diagram fails to render on Free while small domains
  work perfectly. That is the clearest single reason to move to the $5 plan
  ([SETUP.md § Cloudflare plan](./SETUP.md#cloudflare-plan)).
- **A status-banner endpoint that answers 200 with the wrong shape draws nothing at all.** The kit accepts
  plain text, or JSON carrying `message`, `banner_message`, `text` or `banner`. Anything else is a
  *successful* request that renders no banner — indistinguishable, from inside the portal, from the feature
  being switched off. If a banner does not appear, check the body the endpoint returns before you check
  anything in this Worker.
- **Soft exclusions are creation-only.** `RINGOTEL_EXCLUDE_*` decides whether an app account may be
  *created*; it never hides a user who already has one. Do not use it as a way to hide people.
- **System/service users and non-3-4-digit extensions can never be activated**, by anyone, including a
  reseller override. If activation "does nothing" for such a user, that is the rule working.
- **Deletion is covered now, but off by default.** `NS_EVENTS_OFFBOARD=deactivate` deactivates a user's
  app record when NetSapiens deletes them — confirmed only by a 404 on re-read, never by the event
  payload, since the `subscriber` model carries no removal flag and a deleted user has no record left to
  re-read. It fires immediately from the change event, and again on the hourly sweep, which also cleans
  up records orphaned before this feature shipped. Leave it `off` and a deleted user keeps their
  app-directory entry — and, if it was active, keeps costing money — exactly as before.
- **A cron trigger is per environment.** Add it to one `env` block and the others receive events but never
  reconcile — subscriptions drift out of date with nothing reporting it.
- **Turning subscriptions off now unsubscribes — but only while credentials remain.** Dropping *one*
  domain while others remain is handled as before — the next reconcile deletes that subscription. Emptying
  `NS_EVENTS_DOMAINS` completely, or setting `NS_EVENTS=off`, now does the same at the next reconcile: a
  delete-only pass removes every subscription this deployment owns, then plans nothing else — **provided
  the callback origin (`NS_EVENTS_BASE_URL`) and the service credentials are still configured.** Remove
  those first and nothing is left able to clean up. Retire in order: empty the domain list (or flip the
  switch) → let one reconcile run → verify the subscriptions are gone → *then* remove the secrets.
  Deleting the Worker outright always strands them, and changing `NS_EVENTS_BASE_URL` orphans subscriptions
  created under the old origin the same way — no setting can prevent either.

## If it fails

Most failures are one of: `PORTAL_HANDOFF_URL` left absent (`/health` says `configured:false`), a
`PORTAL_FEATURES` typo (500 on everything but `/health`), a secret set on the wrong environment, an origin
missing from `ALLOWED_ORIGINS` or a portal CSP that blocks the Worker host — or the inject slot not yet
pointed at the primary, which looks identical to a broken Worker from inside the portal and is diagnosed in
one step by opening `/p.js` directly. Check `GET /health` first, then the response body of the route that
failed: this project reports what is missing rather than failing blank.
