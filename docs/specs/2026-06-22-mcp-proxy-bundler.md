# MCP Proxy Bundler — Design Specification

> **Status:** Implemented — founding design. Later changes are described in newer specs.
> **Date:** 2026-06-22

---

## Origin / Precursor

This project is the direct outgrowth of a precursor deployment in a private consumer repo: a homelab instance of the Hevy MCP stood up as a **single custom container** — the `mcp-auth-proxy` Go binary on a `node:26-slim` base, spawning `npx hevy-mcp` over stdio, gated by Authelia OIDC at a private hostname.

That deployment exposed the gap this project closes: because the image is a **local custom build** (`hevy-mcp-proxy:local`), it fell out of the homelab's WUD + n8n auto-update pipeline — unlike `todoist-mcp`, which runs the **stock** proxy image and *is* auto-updated. Since the proxy is the **internet-facing auth boundary**, an un-auto-patched edge is the most critical place to leave a vulnerability window. `mcp-proxy-bundler` generalizes the build so the edge is patched automatically and new MCPs are config-only.

---

## Goal

Build and publish **hardened, auto-updated OCI images** — one per MCP — that bundle `mcp-auth-proxy` (the OAuth 2.1 edge) with a **stdio** MCP server baked in, from **declarative per-MCP config**. The internet-facing proxy is then patched automatically through the existing WUD + n8n pipeline on the consuming server, and onboarding a new MCP is a config change, not a bespoke build.

---

## Current State

### What exists (in the homelab — the consumer)

| Component | State | Auto-updated? |
|---|---|---|
| `hevy-mcp` | Custom local image `hevy-mcp-proxy:local` (proxy binary on `node:26.3.1-slim` + `npx hevy-mcp@1.25.5` stdio) | ❌ **No** — local build, no `wud.watch` |
| `todoist-mcp` | **Stock** `ghcr.io/sigbit/mcp-auth-proxy:2.10.2` (two containers: proxy + `todoist-ai-http` HTTP backend) | ✅ Proxy image + node base via WUD |
| MCP npm packages (`hevy-mcp`, `@doist/todoist-ai`) | Pinned in compose `command:` / `npx` | ❌ Never WUD-tracked (both MCPs) |
| Auto-update pipeline | WUD detects image updates → n8n "Docker Updates" workflow: **patch auto-applies, minor/major → Claude safety review → Discord** | n/a (this is the consumer of our output) |
| Edge auth | `mcp-auth-proxy` (OAuth 2.1 IDP) → Authelia OIDC (`mcp-admins`). No Traefik `auth@file` on MCP routers — the proxy IS the gate (`/mcp` → 401, not a portal 302) | n/a |

### Problems this design solves

1. **The edge proxy for `hevy` is not auto-patched** — the highest-criticality update gap (internet-facing auth boundary).
2. **MCP npm packages are never auto-tracked** for *any* MCP — manual version bumps only.
3. **A local custom image cannot be WUD-tracked** — WUD has no registry tag/`FROM`-stage visibility.
4. **Per-MCP setup is bespoke** — does not scale to "todoist + hevy + future MCPs."
5. **No reproducible or tested build** — the `ca-certificates`/TLS panic we hit during the hevy deploy would have been caught by a build-time smoke test; there was none.

### Settled architectural fact (verified)

`mcp-auth-proxy` is **strictly single-upstream**: one MCP per instance, single `/mcp` endpoint, no multi-backend/path routing (confirmed from its README). A single proxy container **cannot** front multiple MCPs. The "one proxy, many MCPs" goal is only reachable by inserting an MCP **aggregator/gateway** — explicitly **rejected** here (see [D1]).

---

## Design

### D1. Topology: per-MCP composite image (and why not a shared gateway)

**One proxy : one MCP**, baked into one image. Each composite = `mcp-auth-proxy` Go binary + a Node runtime + the MCP package, published as `ghcr.io/thedebuggedlife/mcp-<name>`.

**MCP transport — stdio is the default; HTTP-only is still single-image-bundleable.** The clean path bakes `mcp-auth-proxy -- <stdio bin>`: the proxy spawns and supervises the stdio child — one foreground process, simplest lifecycle. An MCP that is **HTTP-only** can *still* be bundled into **one image** by running its HTTP backend as a **co-process** on `localhost` and pointing the proxy at `http://localhost:<port>` (the proxy's upstream-URL mode — what todoist-mcp uses across two containers today, collapsed into one), via a small supervisor or a background-then-`exec` entrypoint. That works but manages two processes, so **prefer stdio when an MCP offers it** — most do, including todoist (OQ10). The co-process path is a supported fallback, not an exclusion.

**Rejected alternative — a shared MCP aggregator/gateway behind one proxy** (e.g. `tbxark/mcp-proxy`, `DXHeroes/local-mcp-gateway`, `agentgateway`; see the [Q1-2026 landscape survey](https://www.heyitworks.tech/blog/mcp-aggregation-gateway-proxy-tools-q1-2026)). It would collapse to one edge but trades away the exact properties the project optimizes for:

- **Isolation / blast radius** — one shared gateway means a bug/outage/compromise exposes or downs *all* MCPs at once; per-MCP proxies are independent.
- **Minimal edge surface** — `mcp-auth-proxy` is a tiny single-purpose Go binary; most aggregators are large Node/Python apps.
- **Per-MCP auth scoping** — separate Authelia clients/policies per MCP.

Revisit only when per-MCP container sprawl outweighs the isolation benefits — an operational tipping point not yet reached. Recorded as a non-goal, not a forgotten option.

### D2. Repository layout

```
mcp-proxy-bundler/
├── mcps/                          # the config-driven heart — one dir per MCP
│   ├── hevy/
│   │   ├── package.json           # { "dependencies": { "hevy-mcp": "1.25.5" } }  ← Renovate npm-native
│   │   ├── package-lock.json      # deterministic install + npm digest pinning
│   │   └── mcp.yaml               # bin, runtime contract, telemetry hosts, labels (D3)
│   └── todoist/
│       ├── package.json           # { "dependencies": { "@doist/todoist-mcp": "x.y.z" } }
│       ├── package-lock.json
│       └── mcp.yaml
├── Dockerfile                     # SHARED, parameterized by build args (D4)
│                                  #   holds `FROM mcp-auth-proxy:<ver>` + `FROM node:<ver>` ← Renovate docker-native
├── entrypoint.sh                  # shim: exec mcp-auth-proxy -- /app/node_modules/.bin/$MCP_BIN (D4)
├── scripts/
│   └── build.sh                   # build one image from mcps/<name>/
├── test/
│   ├── docker-compose.ci.yml      # authelia (file user DB) + redis + image-under-test
│   ├── authelia/configuration.yml # throwaway test OIDC client + file user
│   └── integration/               # Tier-1 smoke + MCP tools/list test (D8)
├── .github/workflows/
│   ├── ci.yml                     # PR: build + test matrix, NO publish
│   ├── release.yml                # main: semantic-release → build → push GHCR → GH Release w/ aggregated notes
│   └── renovate.yml               # scheduled self-hosted Renovate (own GitHub App token) (D6/OQ3)
├── renovate.json                  # native docker + npm managers; severity mapping (D5/D6)
├── release.config.js              # semantic-release config
├── README.md
├── docs/ralph/specs/              # design specs (committed)
│   └── 2026-06-22-mcp-proxy-bundler.md   ← this file
└── ralph/                         # LOCAL-ONLY (.git/info/exclude) — planning scratch, never committed
```

**Why this shape:** it keeps Renovate on **native managers** (no brittle custom regex). The MCP package version lives in `mcps/<name>/package.json` (npm manager); the proxy + node versions live as `FROM` lines in the shared `Dockerfile` (docker manager).

### D3. Per-MCP configuration

Two files per MCP. `package.json` is the Renovate-managed version pin; `mcp.yaml` is everything else.

```yaml
# mcps/hevy/mcp.yaml
name: hevy                         # → image ghcr.io/thedebuggedlife/mcp-hevy
displayName: "Hevy MCP"
mcpPackage: hevy-mcp               # must match the package.json dependency key
mcpBin: hevy-mcp                   # the bin to spawn (node_modules/.bin/<mcpBin>)
# nodeVersion: "26"                # OPTIONAL override; default = shared base (D4). hevy requires >=26.
runtime:
  apiKeyEnv: HEVY_API_KEY          # env var the MCP reads at runtime (NOT baked; supplied by the consumer)
  telemetryHosts:                  # MCP fact: hosts the consumer should black-hole (extra_hosts, D10)
    - o4508975499575296.ingest.de.sentry.io
# NOTE: bundler-only config — MCP facts, never consumer/platform specifics. No internal hostnames,
# domains, secrets, or UI/platform fields (e.g. Unraid icons) — those live in the private
# consumer repo (D11/D13). This repo is PUBLIC.
```

### D4. Shared Dockerfile (parameterized, multi-stage)

```dockerfile
# Stage 1: pinned mcp-auth-proxy Go binary (Renovate docker manager updates this tag)
FROM ghcr.io/sigbit/mcp-auth-proxy:2.10.2 AS proxy

# Stage 2: shared Node base (Renovate docker manager updates this tag). node:26 satisfies all current MCPs.
FROM node:26.3.1-slim
ARG MCP_DIR                        # e.g. mcps/hevy
ARG MCP_BIN                        # e.g. hevy-mcp

# node:*-slim omits the system CA bundle; the Go proxy uses the SYSTEM trust store to verify the
# Authelia OIDC endpoint — without this it panics `x509: certificate signed by unknown authority`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=proxy /usr/local/bin/mcp-auth-proxy /usr/local/bin/mcp-auth-proxy

WORKDIR /app
COPY ${MCP_DIR}/package.json ${MCP_DIR}/package-lock.json ./
RUN npm ci --omit=dev             # deterministic; MCP baked at build time (no npx-at-runtime)

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENV MCP_BIN=$MCP_BIN
USER 1000:1000
# Docker CMD can't interpolate build args at runtime, so the per-MCP stdio bin is carried via
# ARG → ENV → a shim. entrypoint.sh execs: mcp-auth-proxy -- /app/node_modules/.bin/"$MCP_BIN"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

**`entrypoint.sh`** (repo root, committed executable):
```sh
#!/bin/sh
exec mcp-auth-proxy -- /app/node_modules/.bin/"$MCP_BIN" "$@"
```

> **Resolved (OQ4):** one shared Dockerfile; the per-MCP stdio bin is carried by `--build-arg MCP_BIN` → `ENV` → `entrypoint.sh`. No per-MCP Dockerfile generation. *Verify per MCP* that the local `.bin` spawns cleanly given `WORKDIR /app`.

Key properties: **MCP baked at build time** (reproducible, instant start, version is a real image property), **ca-certificates installed**, **non-root**, single shared base + proxy version across all images.

### D5. Versioning & "what changed" metadata (consumer-agnostic)

The composite carries its **own semver** (managed by semantic-release), bumped to **honestly mirror the changed input's** semver bump — upstream major → composite major, minor → minor, patch → patch — for whichever input changed (proxy, MCP package, or Node base). **No consumer policy is encoded in the version**; the bundler stays agnostic to how any consumer auto-updates (just as it is IdP-agnostic, D9).

Every image **records exactly what changed**, so a consumer can implement any apply/review policy:
- **OCI labels** stamped at build: `io.thedebuggedlife.mcp.proxy-version`, `io.thedebuggedlife.mcp.package`, `io.thedebuggedlife.mcp.package-version`, `io.thedebuggedlife.mcp.node-version`.
- **GitHub Release notes** (D7) that aggregate the changed input's upstream notes + links.

**Mechanism:** Renovate `packageRules` with `matchUpdateTypes` → `semanticCommitType` map an upstream major/minor/patch to the same-severity composite bump; the build stamps the labels from its build args. Tags: `:<composite-semver>` + `:latest`. A consumer's `wud.tag.include` matches the composite semver. A **digest-only** base-image update (same version tag, new SHA — an OS-layer rebuild, common while the Node base sits in its pre-LTS window, D6) maps to a **patch** composite bump.

Per-image versions use **scope-based commit routing**, not path-based monorepo plugins: each image is its own semantic-release run (tag prefix `mcp-<name>-v*`) that accepts its **own** commit scope (`hevy`/`todoist`) **plus** the shared `proxy`/`node` scopes — so a shared base bump versions every image while an MCP bump versions one. Directory/path-filtered monorepo plugins (`semantic-release-monorepo`, `multi-semantic-release`) are **unsuitable**: they can't see the root `Dockerfile`, so they'd skip shared-base bumps entirely.

> **Apply/review/approval policy is the consumer's, not the bundler's (resolved OQ9).** Deciding which updates auto-apply vs. require review vs. need explicit human approval — including the homelab's "**always review when the proxy (edge) version changed**" rule — is owned by the consuming repo. For this homelab that lives in the consumer repo's n8n "Docker Updates" flow, which reads the labels/notes above (and may need a small enhancement to gate on the proxy label rather than the semver diff). The security property ("never silently auto-apply the edge") is **preserved** — just **enforced at the consumer**, where the policy belongs.

### D6. Renovate

- **Native managers only:** `docker` (the two `FROM` tags) + `npm` (each `mcps/<name>/package.json`).
- `pinDigests: true` (immutable, reproducible Docker deps).
- **Node base tracks LTS only:** the `node` Docker dependency uses Renovate's `node` versioning (preset `workarounds:nodeDockerVersioning`), so only Active-LTS releases are eligible and non-LTS "Current" lines are never proposed. Renovate keys stability off the **official Node release schedule** (`now > lts-start`), so it **never downgrades** and **auto-adapts** to Node's post-v27 schedule change (odd/even distinction dropped — every major becomes LTS). Path from the current `node:26.3.1-slim` pin: hold on 26 (Active LTS Oct 2026) → `26 → 27` once 27 reaches Active LTS (Oct 2027) → annually thereafter, each major adopted only when it enters Active LTS. During 26's pre-LTS "Current" window (until Oct 2026) `pinDigests` still patches the base OS layer (digest → patch, D5); only Node-runtime *version* bumps within 26 may defer until Oct 2026.
- `minimumReleaseAge: 0` — **no soak** (fast edge patching is the priority; CI + n8n review are the safety gate, not a timer).
- **Separate PRs per dependency** so each maps cleanly to its composite bump (D5). A proxy/node bump is one shared PR (rebuilds all images); each MCP bump is its own PR (rebuilds one).
- `packageRules` → `semanticCommitType` **and `semanticCommitScope`** mapping per D5: each MCP npm PR is scoped to that MCP (`hevy`/`todoist`); the shared docker `FROM` PRs are scoped `proxy` / `node`. The per-image semantic-release runs route on this scope (D5).
- **Release-notes propagation:** Renovate embeds upstream notes in the PR; `release.yml` re-fetches and embeds them in the composite **GitHub Release** body (D7) so the n8n Claude review reads them via WUD's link.
- Runs **self-hosted in GitHub Actions** — a scheduled `renovate.yml` runs the official `renovatebot/github-action`, authenticated by a **dedicated GitHub App we own** (installation token minted per-run via `actions/create-github-app-token`). No Mend account, no third-party access. The built-in `GITHUB_TOKEN` is unusable here (PRs it opens don't trigger CI → would bypass the gate). *Not* a custom Claude-MAX bumper either — rejected (ToS + credential exposure of a personal subscription in cloud CI; the AI safety review already lives in n8n).

### D7. CI/CD (GitHub Actions)

- **`ci.yml` (pull requests):** matrix over `mcps/*`; build each image; run the test harness (D8); **no publish**. This is the gate that blocks a bad Renovate bump.
- **`release.yml` (push to `main`):** `semantic-release` computes the new version per changed image; build + push to GHCR (`:<semver>` + `:latest` + OCI labels); create a **GitHub Release** whose body **aggregates the changed dependency's upstream release notes** (proxy via GitHub Releases API; MCP via npm + its repo changelog) plus links. This Release is what WUD's `wud.link.template` points at and what the n8n Claude review consumes.
- **GHCR auth:** the workflow's built-in `GITHUB_TOKEN` with `packages: write` (no PAT). Org package settings must permit Actions to publish (owner toggle).
- **Matrix scope:** for a handful of MCPs, the **CI/PR gate** (`ci.yml`) **builds + tests all** images on every change (simple, cheap). **Release** (`release.yml`) is different: it publishes only the image(s) whose version actually changed (per-image semver, D5) — it does **not** re-push unchanged images or their `:latest`. Switch the CI gate to build-affected only if the matrix grows large (open question).
- **Arch:** `linux/amd64` only — the common deployment target; add `arm64` only if a consumer needs it (OQ8).

### D8. CI test harness — real Authelia, no paid backend keys

`test/docker-compose.ci.yml` brings up **a real Authelia** (file-based user database — no LLDAP needed; **SQLite** as the required `storage` provider, since Authelia won't start without one even with file users) + **redis** (session store) + the **image under test** (with a **dummy** MCP API key and a throwaway test OIDC client).

The IdP is a **test fixture**, not a coupling: Authelia is the reference (high-fidelity for the homelab consumer), but because the image is IdP-agnostic (D9) the same handshake test can target any OIDC provider. A generic/standard-OIDC profile can be added later to *assert* agnosticism if a non-Authelia consumer appears.

**Tier 1 — required gate** (catches the bug classes we actually hit):
1. Image builds.
2. Proxy starts and **initializes its OIDC provider against the real Authelia discovery URL** → catches the `ca-certificates`/TLS panic and OIDC misconfig at startup.
3. `GET /.well-known/oauth-authorization-server` → **200** with `authorization`/`token`/`registration` endpoints.
4. `GET /mcp` unauthenticated → **401** (proxy gate active; not a portal redirect).
5. **MCP layer** (no paid call): spawn the baked bin over stdio (via the `@modelcontextprotocol/sdk` stdio client) with the dummy key → `initialize` + `tools/list` → assert the expected tool names. Tools register regardless of key validity; only tool *execution* hits the paid API.

**Tier 2 — required (resolved OQ6):** full end-to-end OAuth handshake against the Authelia test container, proving the entire edge auth path Claude exercises:
1. Discover AS metadata → Dynamic Client Registration (`POST /.idp/register`).
2. Begin OAuth 2.1 authorization-code + PKCE at the proxy `/authorize` → 302 to Authelia.
3. **Authelia login (scripted):** POST the test user's credentials to Authelia's first-factor API (`/api/firstfactor`) with a cookie jar, then complete the OIDC consent/authorize → redirect back to the proxy callback with the OIDC code.
4. Proxy issues its own authorization code → exchange at `/token` (with the PKCE verifier) → bearer token.
5. Call `/mcp` with the bearer token → authenticated MCP `initialize` + `tools/list` → assert tool names match Tier 1.

Primary implementation: Authelia's first-factor **API** via a cookie-jar HTTP client; fall back to **Playwright** driving the login UI only if the API flow is fragile across Authelia versions. This exercises proxy token issuance + validation, not just startup/metadata.

**Explicit non-goal:** real tool **execution** (needs a live, paid Hevy/Todoist key). Out of scope by design.

### D9. Runtime contract & token continuity

The image expects these at runtime (supplied by the consumer's compose, **not** baked). The variable **names** below derive from the precursor deployment, **not** the public README (which documents CLI **flags** + simple-password auth, no OIDC). They are re-verified against the proxy's docs site and recorded in **Appendix A** (Phase 0) before the Dockerfile/harness depend on them:

| Env | Purpose |
|---|---|
| `EXTERNAL_URL` | `https://<mcp>.<your-domain>` |
| `OIDC_CONFIGURATION_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES`, `OIDC_ALLOWED_ATTRIBUTES`, `OIDC_PROVIDER_NAME`, `OIDC_USER_ID_FIELD` | Standard OIDC client at the configured IdP (group/claim authz, e.g. `mcp-admins`) |
| `AUTH_HMAC_SECRET`, `TRUSTED_PROXIES`, `NO_AUTO_TLS`, `LISTEN`, `DATA_PATH=/data` | Proxy config |
| `<apiKeyEnv>` (e.g. `HEVY_API_KEY`) | Passed through to the stdio child |

**Token continuity (a deployment requirement for any consumer):** the proxy's `DATA_PATH=/data` holds `private_key.pem` (JWT signing key) + the bbolt `db` (registered OAuth clients, access/refresh tokens). Mounting `/data` to a **per-instance persistent host directory** makes **image swaps token-safe** — clients don't re-authenticate across an update (or a one-time cutover from a pre-existing image). The npm cache is irrelevant (the MCP is baked, D4).

**IdP-agnostic by design.** The `OIDC_*` variables are **standard OIDC** — `mcp-auth-proxy` is a generic OIDC Relying Party that discovers any compliant provider via its `/.well-known/openid-configuration`. The generated images therefore work with **any OIDC-compliant gateway** (Authelia, Keycloak, Authentik, Auth0/Okta/Entra ID, Dex, Zitadel, Pocket ID, …); the IdP is **100% runtime config — nothing IdP-specific is baked**. Authelia is simply the reference deployment's choice. Two runtime caveats (both upstream-proxy behavior, not the bundler):
- **Group/claim authorization is IdP-specific runtime config:** `OIDC_ALLOWED_ATTRIBUTES` / `OIDC_USER_ID_FIELD` point at whatever claims your IdP emits (`groups` in Authelia; a roles/custom claim elsewhere).
- **The proxy's RP does not send PKCE to the upstream IdP:** the IdP must permit a **confidential (`client_secret`) client without mandatory PKCE** (Authelia via `require_pkce: false`). An IdP that *mandates* PKCE for confidential clients would need it relaxed, or the proxy updated upstream.

### D10. Telemetry egress control

Some MCPs ship always-on, non-disableable telemetry (e.g. `hevy-mcp` → Sentry; see the precursor's security review). This is blocked at the **compose layer** via `extra_hosts` mapping the telemetry host to **both** `127.0.0.1` **and** `::1` (IPv4-only lets the AAAA lookup fall through to DNS). It **cannot** be baked into the image: `/etc/hosts` is rewritten by Docker at runtime and is not writable by the non-root user. `mcp.yaml.runtime.telemetryHosts` drives the entries emitted into the consumer compose snippet (D11).

### D11. Consumer contract / blueprint handoff

This repo produces **images** only. **Deploying** an image as a live MCP (compose service, Authelia client, CF Tunnel hostname, secrets, WUD/n8n wiring) is the consumer's job, and the **deploy blueprint is hand-maintained in the private consumer repo** (resolved OQ5) — matching today's hand-written compose-snippet pattern for the precursor deployment. No consumer artifacts are generated here (keeps this public repo decoupled and secret-free).

`mcp.yaml` is the **contract** the consumer reads when hand-writing each deployment: `runtime.apiKeyEnv` (which secret to supply), `runtime.telemetryHosts` (the `extra_hosts` black-hole entries), `mcpBin`/`name`. The consumer's hand-maintained service snippet carries all hardening: `user: "1000:1000"`, `pids_limit: 2048`, the `/.idp/register` rate-limit, the `extra_hosts` telemetry block (D10), the `DATA_PATH` appdata mount (D9), Traefik labels (`http,https`, port 80), and WUD labels (`wud.watch`, semver `wud.tag.include`, `wud.link.template` → this repo's Releases). The Authelia OIDC client (`mcp-admins`, redirect `…/.auth/oidc/callback`, `require_pkce: false`) is likewise defined in the consumer repo.

### D12. Security posture (summary)

- **The image is the edge**; the proxy is the sole gate (`/mcp` → 401, no Authelia portal 302). Minimal Go-binary edge, not a large gateway.
- **Per-MCP isolation** (independent blast radius), **non-root**, `pids_limit`, **rate-limited** dynamic client registration.
- **Supply chain:** digest-pinned deps; **owning the build neutralizes upstream "yanks"** (a later upstream unpublish can't touch an image we already built). Auto-patching shrinks the vuln window; **CI green + n8n Claude review** prevent a bad/compromised upstream release from reaching the edge — no soak timer needed.

### D13. Public-repo hygiene (this repo is PUBLIC)

The repo and its GHCR packages are **public** (resolved OQ1). This is safe because **no credentials live in the source**, by design:

- **No secrets baked into images.** API keys, OIDC client secrets, and HMAC secrets are **runtime env** supplied by the private consumer repo — never in the Dockerfile, `mcp.yaml`, or any committed file.
- **CI test secrets are ephemeral.** The CI Authelia harness (D8) **generates its throwaway secrets at runtime** (test OIDC client secret, session/storage/JWT secrets, the test user password, the dummy MCP API key). Nothing secret-shaped is committed; any unavoidable static test value is obviously-fake and clearly test-only, never a reused real value.
- **No internal topology in build config.** Real hostnames (`*.example.com`), `EXTERNAL_URL`, and Authelia client details stay in the private consumer repo. `mcp.yaml` carries only env-var **names**, public package names, public telemetry hostnames, and icons.
- **Architecture is intentionally public.** The repo reveals *that* we bundle `mcp-auth-proxy` + Authelia OIDC — security rests on the runtime secrets and the auth gate, not on obscuring the design.

---

## Interaction with Existing Code (the private consumer repo)

**Changes when this builder ships:**
- **`hevy-mcp`:** swap `image: hevy-mcp-proxy:local` → `image: ghcr.io/thedebuggedlife/mcp-hevy:<semver>`; remove the local `build:` + its custom Dockerfile; **add WUD labels**. **Keep** the `DATA_PATH` appdata mount, the `extra_hosts` Sentry block, the Traefik labels, and the existing Authelia client (token-safe cutover via the same mount).
- **`todoist-mcp` (later phase):** migrate from the **two-container stock-proxy** setup to a single composite image, and move the package `@doist/todoist-ai` → **`@doist/todoist-mcp`** (the former is deprecated/renamed). Note: todoist's proxy *already* auto-updates, so this is **consistency/blueprint-conformance, not a gap** — lower priority than hevy.

**What stays the same (do not refactor):** Authelia client definitions and the `mcp-admins` policy, CF Tunnel hostnames, the consumer's `.env` secret storage, and the WUD + n8n "Docker Updates" pipeline (this builder feeds it; it is not modified).

---

## Test Plan

**Existing infra:** none — greenfield repo. Recommended minimal stack consistent with the MCP ecosystem:
- **Runner:** Node + **Vitest** (the MCP SDK is TS/JS; the stdio `tools/list` test uses `@modelcontextprotocol/sdk`).
- **Harness:** `docker compose` (the `test/docker-compose.ci.yml` Authelia+redis+image stack), orchestrated from the test or a thin bash wrapper.
- **CI:** the `ci.yml` matrix runs the suite per image; green is required to merge a Renovate bump.

**Integration tests** (`test/integration/`):
- `proxy-starts-and-gates.test.ts` — against the real Authelia container: OIDC provider initializes (no `x509` panic), `/.well-known/oauth-authorization-server` = 200, `/mcp` unauth = 401. *Fixtures:* the CI compose stack, a dummy API key. *(Tier 1 — the regression net for the bugs we hit.)*
- `mcp-tools-list.test.ts` — spawn the baked bin via the SDK stdio client with a dummy key → `initialize` + `tools/list` → assert expected tool names. *Fixtures:* the built image; no network/paid backend.
- `oauth-handshake-e2e.test.ts` — **(required, Tier 2 — D8)** scripted Authelia first-factor login → OIDC code → proxy bearer token → authenticated `tools/list` through the proxy. *Fixtures:* the CI Authelia stack + a cookie-jar HTTP client (Playwright fallback). Asserts the full token issuance/validation path, not just startup.

**Unit tests** (`test/unit/`):
- `config.test.ts` — `mcp.yaml` schema validation (required keys, `mcpPackage` matches the `package.json` dependency, valid `telemetryHosts`).
- `version-mapping.test.ts` — the upstream-change → composite-bump severity logic (D5) for each row of the table.

**Backward compatibility:** verify a published image, deployed with the same `DATA_PATH` mount as the current `:local` container, preserves issued tokens (no forced re-auth) — manual/Tier-2 check noted in the consumer cutover runbook.

---

## Files Changed

| File | Change |
|------|--------|
| `Dockerfile` | **New.** Shared, parameterized multi-stage build (D4) |
| `mcps/hevy/{package.json,package-lock.json,mcp.yaml}` | **New.** First MCP config |
| `mcps/todoist/{package.json,package-lock.json,mcp.yaml}` | **New (later phase).** Second MCP, on `@doist/todoist-mcp` |
| `scripts/build.sh` | **New.** Build one image from `mcps/<name>/` |
| `entrypoint.sh` | **New.** Shim: `exec mcp-auth-proxy -- /app/node_modules/.bin/$MCP_BIN` (D4) |
| `test/docker-compose.ci.yml`, `test/authelia/configuration.yml` | **New.** Real-Authelia CI harness (D8) |
| `test/integration/*.test.ts`, `test/unit/*.test.ts` | **New.** Test suite (Test Plan) |
| `.github/workflows/ci.yml` | **New.** PR build + test matrix, no publish (D7) |
| `.github/workflows/release.yml` | **New.** semantic-release → build → push → GH Release w/ aggregated notes (D7) |
| `.github/workflows/renovate.yml` | **New.** Scheduled self-hosted Renovate via own GitHub App token (D6/OQ3) |
| `renovate.json` | **New.** Native managers, pinDigests, severity mapping (D6) |
| `release.config.js` | **New.** semantic-release config |
| `README.md` | **New.** Repo overview + pointer to the consumer repo |
| — the consumer's compose file | (consumer) swap hevy image to GHCR + WUD labels |
| — the private consumer repo's deploy blueprint | (consumer) hand-maintained compose snippet + Authelia client per MCP (D11) |

---

## Open Questions

1. **Repo & package visibility.**
   _Resolved:_ **repo public, packages public.** No credentials live in the source (D13) — secrets are runtime-only in the private consumer repo, CI test secrets are ephemeral, and no internal hostnames are in build config. Public packages let WUD pull on Unraid without registry credentials.

2. **Local folder name mismatch.** _Resolved:_ typo confirmed; local folder renamed `~/Source/mcp-proxy-builder` → `~/Source/mcp-proxy-bundler` to match the repo.

3. **Renovate hosting.** _Resolved:_ **self-hosted in GitHub Actions** (no Mend account, no email/marketing opt-in, no third-party write access):
   - **Runner & auth:** a scheduled `.github/workflows/renovate.yml` runs the official `renovatebot/github-action`, authenticated by a **dedicated GitHub App we own**; its installation token is minted per-run via `actions/create-github-app-token`. The built-in `GITHUB_TOKEN` is deliberately not used — PRs it opens don't trigger CI, which would bypass the gate.
   - **Least privilege:** because we own the App, its permissions are set to exactly what Renovate needs — Contents R/W, Pull requests R/W, Metadata R, Checks R, Issues R/W (dependency dashboard), and Workflows R/W *only if* it should bump action versions — and it's installed on **only `mcp-proxy-bundler`**. (Tighter than a hosted app's fixed permission set.)
   - **Branch protection (live):** the `main` ruleset `protect-main` (active) requires PRs and blocks **force-pushes** + **deletion** (admin bypass for bootstrap); a **required CI status check** joins it once `ci.yml` exists, so Renovate PRs can't merge to `main` without green CI.

   > **Plan note — expected manual phase.** Creating the GitHub App is **not automatable by a code agent** (owner UI flow: create the App with the minimal permissions above, generate a private key, install it on the repo). The execution plan must include an explicit **manual phase** to create + install the App and capture its **App ID + private key**, stored as repo secrets (`RENOVATE_APP_ID`, `RENOVATE_APP_PRIVATE_KEY`). The automatable phases (`renovate.yml`, `renovate.json`, secret wiring) depend on that output.

4. **`CMD` per-MCP rendering mechanism.** _Resolved:_ entrypoint shim — `--build-arg MCP_BIN` → `ENV` → `entrypoint.sh` execs `mcp-auth-proxy -- /app/node_modules/.bin/$MCP_BIN` (D4). One shared Dockerfile, no per-MCP generation. (Still verify per MCP that the local `.bin` spawns cleanly given `WORKDIR /app`.)

5. **Where the consumer templates live.** _Resolved:_ hand-maintained in the private consumer repo (matches the precursor deployment's existing pattern). This repo generates no consumer artifacts; `mcp.yaml` is the contract (D11).

6. **Tier-2 OAuth e2e test.** _Resolved:_ **in scope / required.** The full scripted Authelia first-factor login → proxy bearer token → authenticated `tools/list` is part of the CI gate (D8), via Authelia's `/api/firstfactor` (Playwright fallback).

7. **Shared vs per-MCP Node base.** _Resolved:_ shared `node:26.3.1-slim` (exact pin + Renovate digest) for all images, with the optional `mcp.yaml.nodeVersion` override as an escape hatch. **Upgrade policy:** LTS-only via Renovate `node` versioning (D6) — schedule-driven, never downgrades, `26 → 27 → …` adopted at each Active-LTS date. (`hevy-mcp@1.25.5` declares `engines.node: ">=26.0.0"`, verified against the npm registry — 26 is a hard floor, so an Active-LTS-strict policy is consistent: Renovate holds 26 and won't try to drop to 24.)

8. **Matrix scope & arch.** _Resolved:_ build-all images on every change + `linux/amd64`-only (the common deployment target; add `arm64` only if a consumer needs it). Revisit build-affected only past ~5–10 MCPs.

9. **Versioning & apply policy.** _Resolved (decoupled):_ the bundler versions **honest semver** + stamps "what changed" labels/notes (D5) — the **bundler** concern, now settled. The **apply/review/human-approval gate** (incl. "always review proxy/edge changes") is a **consumer** concern owned by the consumer repo's n8n flow — **out of scope here.**

10. **Todoist onboarding.** _Resolved (not a bundler design Q):_ todoist is simply the **2nd MCP instance**. Spike confirmed `@doist/todoist-mcp` (v10.3.2) ships a **stdio bin** (`todoist-mcp` → `dist/main.js`, alongside `todoist-mcp-http`), so it bundles single-image **exactly like hevy** — `mcpBin: todoist-mcp`, no co-process needed. (`engines` is unset; verify it runs on the shared `node:26` base at onboarding.) Its current two-container HTTP setup is a Node-18-era legacy artifact; collapsing it to the composite is a **consumer** decision.

---

## Appendix A: Verified `mcp-auth-proxy` contract (v2.10.2)

> **Verified 2026-06-23** against `ghcr.io/sigbit/mcp-auth-proxy:2.10.2`
> (digest `sha256:f92e0ccd22b2a7585bccedc366a3c872bbfa3500c7fa5e7443b40962bf248e8d`)
> by: `docker inspect`/`docker run` of the image; reading the proxy's Go source
> (`main.go`, `pkg/idp/idp.go`, `pkg/proxy/proxy.go`, `pkg/auth/{auth,oidc}.go`,
> `pkg/mcp-proxy/main.go`) at `github.com/sigbit/mcp-auth-proxy@main`; the docs
> Configuration Reference (`/docs/configuration`); **and a live end-to-end run** of
> the proxy with a real stdio MCP child, probing every endpoint with `curl`.
> Where a value was confirmed empirically it is marked **(live)**.

### A.1 Image facts (binary path & runtime defaults)

| Fact | Value |
|---|---|
| `mcp-auth-proxy` binary path | **`/usr/local/bin/mcp-auth-proxy`** — matches D4's `COPY` source ✓ |
| Image `Entrypoint` | `["/usr/local/bin/mcp-auth-proxy"]` (no `Cmd`) |
| Image `User` / `WorkingDir` / `ExposedPorts` | **all unset** — runs as **root** by default, no declared workdir/ports. (Our baked image overrides with `USER 1000:1000`.) |
| Image env baked in | `DATA_PATH=/data` (only non-PATH env) |
| Proxy image base OS | **Debian 12 (bookworm)** — has `ca-certificates` itself; the `node:*-slim` final base does **not**, which is exactly why D4 installs it ✓ |
| Internal binary/usage name | Help banner says `mcp-warp` (cosmetic — the binary on disk is `mcp-auth-proxy`) |

### A.2 `--` stdio passthrough (D4) — **confirmed (live)**

`mcp-auth-proxy [flags] -- <command> [args...]` runs `<command>` as the backend.
**Backend selection** (`pkg/mcp-proxy/main.go`): if the **first token after `--`**
parses as an `http://`/`https://` URL → *transparent HTTP backend* (the co-process /
upstream-URL mode, D1); **otherwise → stdio backend** that spawns and supervises the
command. So `entrypoint.sh`'s `mcp-auth-proxy -- /app/node_modules/.bin/"$MCP_BIN"`
is the stdio path. ✓

- **(live)** The proxy spawns the `--` child as a **foreground subprocess** (D1): with
  `-- npx -y @modelcontextprotocol/server-filesystem /tmp`, PID 1 = the proxy and a
  child PID = the MCP server, both running. Child env is inherited (so `HEVY_API_KEY`
  passes through). ✓
- **⚠️ CRITICAL FINDING (live) — the HTTP listener does NOT start until the stdio child
  completes its MCP handshake.** With a non-MCP child (`-- sleep infinity`), the proxy
  process stays up, spawns the child, **logs nothing, and never opens its listener**
  (no socket in `/proc/net/tcp`, all HTTP probes return connection-refused). Only after
  a *real* MCP child prints its stdio-ready line does the proxy log
  `"Starting server" listen=[":8080"]` and begin listening.
  **Test-harness implications:**
  1. The Tier-1 stdio test (Phase 6) bypasses the proxy and drives the bin directly — unaffected.
  2. The proxy-up tests (Phases 7–9) require the **baked MCP bin to actually speak MCP
     over stdio**, or the proxy never listens and a compose `--wait`/healthcheck will
     time out. A proxy-container healthcheck (Phase 7) should poll an HTTP endpoint
     (e.g. `/.well-known/oauth-authorization-server`) — its 200 proves *both* the proxy
     and the baked MCP came up. Allow generous startup time.

### A.3 Configuration is **env-var driven** (D9 confirmed) — **all D9 names correct**

**Env config IS fully supported** (not flag-only). Mechanism (`main.go`): each cobra flag's
default is `getEnvWithDefault("<ENV_NAME>", default)` — an **explicit per-flag env binding**
(not viper auto-env). Env name = flag name uppercased with `-`→`_`. **Every D9 env var name is
correct as written.** Confirmed table (env → flag → default; required/optional):

| Env var (D9) | Flag | Default | Notes |
|---|---|---|---|
| `EXTERNAL_URL` | `--external-url` / `-e` | `http://localhost` | Issuer + base for all advertised endpoints. **Normalized with a trailing `/`** (live: issuer = `http://localhost:8080/`). |
| `LISTEN` | `--listen` | `:80` | Plain-HTTP listen addr when `NO_AUTO_TLS`. |
| `TLS_LISTEN` | `--tls-listen` | `:443` | TLS listener (unused with `NO_AUTO_TLS`). |
| `NO_AUTO_TLS` | `--no-auto-tls` | `false` | Disables ACME auto-TLS. **Auto-TLS only triggers when `EXTERNAL_URL` scheme is `https` AND host ≠ `localhost`**; an `http://` EXTERNAL_URL alone keeps it plain HTTP, but set `NO_AUTO_TLS=true` to be explicit (Finding 5). |
| `DATA_PATH` | `--data-path` / `-d` | binary default `./data`; **image sets `/data`** | Holds `private_key.pem`, `secret` (HMAC), `db` (bbolt). **Must be writable by uid 1000** (Finding 4 — verified the proxy writes all three on first start). |
| `OIDC_CONFIGURATION_URL` | `--oidc-configuration-url` | `""` | Upstream OIDC discovery URL. |
| `OIDC_CLIENT_ID` | `--oidc-client-id` | `""` | |
| `OIDC_CLIENT_SECRET` | `--oidc-client-secret` | `""` | Confidential client (no PKCE sent upstream — D9 caveat). |
| `OIDC_SCOPES` | `--oidc-scopes` | `openid,profile,email` | |
| `OIDC_ALLOWED_ATTRIBUTES` | `--oidc-allowed-attributes` | `""` | `key=value` pairs, **keys are JSON pointers** e.g. `/groups=mcp-admins`. (Also `OIDC_ALLOWED_ATTRIBUTES_GLOB` for `/groups=*-admins`.) |
| `OIDC_PROVIDER_NAME` | `--oidc-provider-name` | `OIDC` | |
| `OIDC_USER_ID_FIELD` | `--oidc-user-id-field` | `/email` | JSON pointer into userinfo. |
| `AUTH_HMAC_SECRET` | *(no flag — `os.Getenv` only)* | auto-generated → persisted to `$DATA_PATH/secret` | base64 32-byte session secret. **Optional**; if unset it's generated and written to DATA_PATH. |
| `TRUSTED_PROXIES` | `--trusted-proxies` | `""` | IP/CIDR list of trusted upstream proxies. |

Extra env vars discovered (not in D9, available if needed):
`JWT_PRIVATE_KEY` (PEM; else auto-generated → `$DATA_PATH/private_key.pem`),
`REPOSITORY_BACKEND` (default `local` = embedded bbolt; also sqlite/postgres/mysql),
`REPOSITORY_DSN`, `MODE` (`debug` enables verbose/dev logging),
`PASSWORD`/`PASSWORD_HASH` (simple-password auth — the README's documented mode),
`PROXY_BEARER_TOKEN`, `PROXY_FORWARD_AUTHORIZATION`, `PROXY_HEADERS`,
`HEADER_MAPPING`, `HEADER_MAPPING_BASE` (default `/userinfo`), `HTTP_STREAMING_ONLY`,
plus `GOOGLE_*` / `GITHUB_*` provider blocks.

### A.4 HTTP endpoint paths — **all confirmed (live)**; ⚠️ two D8/D9 sketch paths corrected

The proxy's **own** OAuth endpoints are namespaced under **`/.idp/`** and its upstream-OIDC
login flow under **`/.auth/`**. The generic `/authorize` and `/token` names in the D8/D9
sketch are **WRONG** for this proxy — the real paths are below. **Tests should read the
actual `authorization_endpoint`/`token_endpoint` from the AS-metadata document rather than
hardcoding paths**, but the literals are stable in 2.10.2:

| Purpose | Path | Verified |
|---|---|---|
| OAuth **AS metadata** | `GET /.well-known/oauth-authorization-server` | **(live) 200** — matches D8 ✓ |
| OAuth **protected-resource** metadata | `GET /.well-known/oauth-protected-resource` | **(live) 200** |
| **JWKS** | `GET /.well-known/jwks.json` | **(live) 200** |
| **Dynamic Client Registration** | `POST /.idp/register` | **(live) 201**, returns `client_id`; no auth required — matches D8 ✓ |
| **Authorization** (the proxy's `/authorize`) | `GET /.idp/auth` | **(live)** advertised in metadata; bare GET → 401 |
| Authorization return/consent | `/.idp/auth/:ar_id` (GET form + POST) | from source |
| **Token** (the proxy's `/token`) | `POST /.idp/token` | **(live)** advertised in metadata |
| Token introspection | `POST /.idp/introspect` | from source |
| **Upstream OIDC callback** (redirect_uri) | `GET /.auth/oidc/callback` | from source — **matches D11 exactly** ✓ (upstream auth init is `GET /.auth/oidc`) |
| Login portal page | `GET /.auth/login` (+ POST), `GET /.auth/logout` | **(live)** `/.auth/login` → 200 |
| **Proxied MCP endpoint** | **catch-all** — any non-reserved path is proxied to the backend (gated). `/mcp` is the conventional backend path. | **(live)** `/mcp` gated (below) |

**AS-metadata body (live, `EXTERNAL_URL=http://localhost:8080`):**
```json
{
  "issuer": "http://localhost:8080/",
  "authorization_endpoint": "http://localhost:8080/.idp/auth",
  "token_endpoint": "http://localhost:8080/.idp/token",
  "registration_endpoint": "http://localhost:8080/.idp/register",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic","client_secret_post","none"],
  "code_challenge_methods_supported": ["S256"]
}
```
So toward downstream MCP clients the proxy is an OAuth 2.1 **authorization-code + PKCE (S256)**
server with **DCR** — exactly the Phase 9 Tier-2 flow.

### A.5 The `/mcp` gate (D8 #4 / D12) — **confirmed (live)**

`pkg/proxy/proxy.go` installs `handleProxy` as a catch-all (`router.Use`). It requires an
`Authorization: Bearer <jwt>` whose JWT is **RS256-signed by the proxy's own key**, with
**issuer == audience == `EXTERNAL_URL`**. Live results:

- `GET /mcp` (no auth) → **401** `{"error":"Unauthorized"}` — JSON, **not** a portal 302 ✓ (D8 #4 / D12)
- `GET /mcp` (bogus bearer) → **401** `{"error":"Invalid token"}` ✓
- `GET /` and `GET /.idp/auth` unauth → **401** as well (the gate, not a redirect)

### A.6 Default listen / HTTP scheme (Phases 7/9, Finding 5) — **confirmed (live)**

With `NO_AUTO_TLS=true`, `EXTERNAL_URL=http://...`, `LISTEN=:8080`, the proxy serves
**plain HTTP on `:8080`** (listener verified on `::` all-interfaces). The session cookie's
`Secure` flag derives from the `EXTERNAL_URL` scheme, so **http end-to-end works** for the
compose harness. **Scheme must be consistent** across `EXTERNAL_URL`, the listener, the
Authelia client `redirect_uris`, and the test client (Finding 5) — pick **http** for CI.

### A.7 D-assertion corrections summary

- **D4 binary path `/usr/local/bin/mcp-auth-proxy`** → **CONFIRMED.**
- **D9 env-var names** → **ALL CONFIRMED** (env config supported; names exact). Added: the
  HMAC/JWT secrets persist to `DATA_PATH` and are auto-generated if unset; `MODE=debug`,
  `REPOSITORY_*`, `JWT_PRIVATE_KEY` exist too.
- **D8/D9 `/authorize` & `/token`** → **CORRECTED** to **`/.idp/auth`** and **`/.idp/token`**
  (read them from AS metadata to stay version-robust).
- **D8 `/.well-known/oauth-authorization-server`, `POST /.idp/register`** → **CONFIRMED.**
- **D11 OIDC callback `/.auth/oidc/callback`** → **CONFIRMED.**
- **`/mcp` → 401 (not 302)** → **CONFIRMED.**
- **NEW (no prior D assertion):** the **HTTP listener blocks on the stdio MCP handshake** —
  a non-MCP `--` child means no listener ever opens (drives Phase 7 healthcheck design).
- **NEW:** `/data` must be writable by uid 1000 (proxy writes `secret`, `private_key.pem`,
  `db` on first start) — confirms Finding 4.

---

## Appendix B: Versioning & release mechanism

> **Decided 2026-06-23.** Resolves Phase 1: *how* the repo produces independent per-image
> semver with semantic-release, *how* Renovate maps an upstream major/minor/patch/digest
> bump to the same-severity composite bump, the OCI-label sources, and the notes-aggregation
> outline. Verified against the `@semantic-release/commit-analyzer` `releaseRules` docs
> (scope-glob matching; `feat`→minor, `fix`→patch; BREAKING CHANGE must be in the **footer**),
> the semantic-release `tagFormat`/`branches` docs (`tagFormat` must contain `${version}`
> exactly once, default `v${version}`), and the Renovate config docs (`semanticCommitScope`,
> `commitBody` appended after two newlines, `matchUpdateTypes` accepts `digest`,
> `matchManagers`/`matchDatasources` select docker vs npm). This is the spec **Phases 11 & 12**
> implement. Phase 11 = semantic-release + `release.yml` + notes script; Phase 12 = `renovate.json`.

### B.1 Per-image versioning strategy — scope-routed matrix of semantic-release runs

**Decision (critique Finding 1): scope-based commit routing, one semantic-release run per
image — NOT path-based monorepo plugins.**

**Why not the monorepo plugins.** `semantic-release-monorepo` / `multi-semantic-release`
scope a package's commits to its **directory** (plus declared workspace deps). The shared
`Dockerfile` + `entrypoint.sh` live at the **repo root**, *outside* every `mcps/<name>/`, so a
proxy/node `FROM`-bump is filtered out of **every** per-MCP run → **no image gets versioned**,
directly contradicting D5/D6 (a shared base bump must version *all* images). The "no npm
workspaces" decision (plan Design Decisions) also rules out `multi-semantic-release`, which
discovers packages via workspaces. Both are **unsuitable**.

**Mechanism — a matrix of runs, one per MCP, routed by conventional-commit *scope*:**

- **Tag format, per image:** `tagFormat: 'mcp-<name>-v${version}'` (e.g. `mcp-hevy-v1.4.0`,
  `mcp-todoist-v2.1.3`). Confirmed valid: `tagFormat` need only contain `${version}` exactly
  once. Each image's tags are an **independent semver lineage** — semantic-release reads the
  latest `mcp-<name>-v*` tag to compute that image's next version.
- **`branches: ['main']`** for every run.
- **Scope routing via `@semantic-release/commit-analyzer` `releaseRules`:** each per-MCP run
  accepts **its own MCP scope plus the shared `proxy`/`node` scopes**, and ignores other MCPs'
  scopes. Example for the **hevy** run (`releaseRules` is *additive* to the angular preset's
  defaults, which already map unscoped `feat`→minor / `fix`→patch; we constrain by scope):

  ```js
  // release.config.hevy.js (one per MCP; parameterize <name> = hevy|todoist)
  module.exports = {
    branches: ['main'],
    tagFormat: 'mcp-hevy-v${version}',
    plugins: [
      ['@semantic-release/commit-analyzer', {
        preset: 'angular',
        releaseRules: [
          // this image's own scope
          { scope: 'hevy', type: 'feat',  release: 'minor' },
          { scope: 'hevy', type: 'fix',   release: 'patch' },
          // shared inputs version EVERY image
          { scope: 'proxy', type: 'feat', release: 'minor' },
          { scope: 'proxy', type: 'fix',  release: 'patch' },
          { scope: 'node',  type: 'feat', release: 'minor' },
          { scope: 'node',  type: 'fix',  release: 'patch' },
          // ignore other MCPs' commits in this run
          { scope: 'todoist', release: false },
        ],
        // BREAKING CHANGE in the footer of a proxy/node/hevy commit → major (preset default).
      }],
      // notes/release/tagging plugins — see B.4
    ],
  };
  ```

  > **Major path:** the preset already triggers **major** on a `BREAKING CHANGE:` footer
  > (or `!`) regardless of `releaseRules`. Renovate emits that footer (B.2). The per-MCP
  > `{ scope: 'todoist', release: false }` line is what keeps a *todoist* commit (incl. a
  > breaking todoist bump) from versioning the *hevy* image. A **shared** proxy/node breaking
  > bump carries scope `proxy`/`node`, which every run accepts → all images go major. ✓

- **`release.yml` enumerates images** by globbing `mcps/*` (same discovery as the CI matrix,
  Phase 10) → for each `<name>`, run semantic-release with that MCP's config/`tagFormat`.
- **"Did this image's version change?" signal (Finding 6 / Phase 11 gate):** capture
  semantic-release's output per run. The clean signal is `@semantic-release/exec`'s
  `publishCmd`/`successCmd` (or the `nextRelease.version` exposed to plugins) — i.e. **a run
  only reaches the build/push/Release step if it produced a new version**. Concretely: gate the
  build+push step on whether semantic-release created a **new `mcp-<name>-v*` tag** this run
  (no new tag ⇒ no version change ⇒ skip build, skip `:latest` re-push, skip Release). Use
  `@semantic-release/exec` `publishCmd` to invoke `build.sh <name>` + push **only when a release
  happens**, so semantic-release itself is the gate (no separate dry-run diffing). `dryRun`
  in a pre-step can pre-compute the matrix of "which images will release" if the workflow needs
  the list up front.

### B.2 Renovate → conventional-commit → bump chain (D5)

Renovate `packageRules` stamp each PR's commit so the matching semantic-release run derives the
intended severity. **Per-row mapping (verified on paper):**

| Upstream change | Renovate `packageRule` output | semantic-release reads | Composite bump |
|---|---|---|---|
| **proxy major** (docker `FROM mcp-auth-proxy` major) | `semanticCommitType: feat`, `semanticCommitScope: proxy`, **`commitBody: 'BREAKING CHANGE: ...'`** | breaking footer + scope `proxy` | **major**, all images |
| **proxy minor** | `feat` / scope `proxy` | `feat(proxy)` | **minor**, all images |
| **proxy patch** | `fix` / scope `proxy` | `fix(proxy)` | **patch**, all images |
| **node major** (docker `FROM node` major) | `feat` / scope `node` / `commitBody: BREAKING CHANGE:` | breaking + scope `node` | **major**, all images |
| **node minor** | `feat` / scope `node` | `feat(node)` | **minor**, all images |
| **node patch** | `fix` / scope `node` | `fix(node)` | **patch**, all images |
| **node digest-only** (same tag, new SHA) | `fix` / scope `node` (matchUpdateTypes `digest` → `fix`) | `fix(node)` | **patch**, all images (D5 digest→patch) |
| **MCP major** (npm `mcps/<name>/package.json`) | `feat` / scope `<name>` / `commitBody: BREAKING CHANGE:` | breaking + scope `<name>` | **major**, that image only |
| **MCP minor** | `feat` / scope `<name>` | `feat(<name>)` | **minor**, that image only |
| **MCP patch** | `fix` / scope `<name>` | `fix(<name>)` | **patch**, that image only |
| **MCP digest** (npm digest) | `fix` / scope `<name>` | `fix(<name>)` | **patch**, that image only |

**The three mapping mechanics:**

1. **minor → `feat`, patch → `fix`:** `packageRule` with `matchUpdateTypes: ["minor"]` sets
   `semanticCommitType: "feat"`; `matchUpdateTypes: ["patch","digest"]` sets
   `semanticCommitType: "fix"`. (`semanticCommits: "enabled"` globally so Renovate emits
   conventional commits.)
2. **major → breaking footer (the hard one, confirmed feasible):** semantic-release bumps major
   only on a `!`/`BREAKING CHANGE` token **in the footer**. Renovate's **`commitBody`** is
   *appended to the commit message separated by two line returns* — i.e. it lands as a
   trailing block = the **footer**. So a `packageRule` with `matchUpdateTypes: ["major"]`,
   `semanticCommitType: "feat"`, and `commitBody: "BREAKING CHANGE: {{{depName}}} updated to
   {{{newVersion}}} (major)"` yields a commit whose footer carries `BREAKING CHANGE:` → major. ✓
   **Do NOT** put the breaking token in the subject/`commitMessagePrefix` only — the
   angular parser requires it in the footer.
3. **scope routing (implements B.1):** every `packageRule` sets `semanticCommitScope` —
   per-MCP npm rules → that MCP's scope (`hevy`/`todoist`); the two docker `FROM` deps →
   `proxy` (the `mcp-auth-proxy` image) and `node`. The per-MCP `commit-analyzer.releaseRules`
   accept own-scope + `proxy`/`node` and `release:false` the other MCPs (B.1). Manager/dep
   selection: `matchManagers: ["docker"]` + `matchDatasources`/`matchDepNames` to split
   `proxy` vs `node`; `matchManagers: ["npm"]` + `matchFileNames: ["mcps/<name>/**"]` (or
   `matchDepNames`) to scope each MCP.

**Cost/benefit of the indirection (Finding 12) — KEEP semantic-release.** The
Renovate→conventional-commit→semantic-release chain is the source of the scope-routing +
footer complexity. The simpler alternative is to **derive the composite bump directly** from
Renovate's known update type (a small script in `release.yml` that reads the merged PR's
update type and `npm version`s each affected image), skipping conventional-commit parsing.
**Decision: keep semantic-release** because we want its automated **git tagging
(`mcp-<name>-v*`), changelog, and GitHub Release creation** (D7) — the notes-aggregation
(B.4) plugs into `@semantic-release/release-notes-generator`/`github`. The scope-routing
config is written **once** and is the cleanest way to express "shared bump → all, MCP bump →
one." If the matrix later grows unwieldy, revisit the direct-derivation script (recorded as
the fallback).

### B.3 OCI label sources (D5) — all derivable from build inputs

The four `io.thedebuggedlife.mcp.*` labels are stamped by `build.sh` (Phase 5) and re-stamped
by `release.yml` (Phase 11). Exact source per label:

| Label | Source |
|---|---|
| `io.thedebuggedlife.mcp.proxy-version` | The tag in `Dockerfile` line `FROM ghcr.io/sigbit/mcp-auth-proxy:<TAG> AS proxy` — parse `<TAG>` (strip any `@sha256:` digest Renovate pins; keep the human semver). |
| `io.thedebuggedlife.mcp.node-version` | The tag in `Dockerfile` line `FROM node:<TAG>-slim` — parse `<TAG>` (e.g. `26.3.1`, strip `-slim` and any digest). |
| `io.thedebuggedlife.mcp.package` | `mcps/<name>/package.json` → the single key under `dependencies` (== `mcp.yaml.mcpPackage`, cross-checked by the Phase 3 loader). |
| `io.thedebuggedlife.mcp.package-version` | `mcps/<name>/package.json` → `dependencies[<mcpPackage>]` (the pinned version string; or read the resolved version from `package-lock.json` for the exact installed version). |

The composite image semver (the `:<semver>` tag) comes from semantic-release's
`nextRelease.version` for that run (B.1) — it is **not** an OCI label, it's the tag.
Parsing the `FROM` tags is a small shell/node step in `build.sh` (a `grep`/regex over the
literal `FROM` lines — they're kept literal precisely so both Renovate and this parse work).

### B.4 Release-notes aggregation outline (D7)

`scripts/aggregate-release-notes.ts` (Phase 11) builds the composite GitHub Release body from
**the changed input's** upstream notes. Inputs: the changed dependency kind (`proxy` | `node` |
`<mcp>`), old→new versions, the image name + new composite semver. Sources:

- **proxy** (`mcp-auth-proxy`): GitHub Releases API —
  `GET /repos/sigbit/mcp-auth-proxy/releases/tags/v<newVersion>` (fields: `name`, `body`,
  `html_url`). Fallback to `GET /repos/sigbit/mcp-auth-proxy/releases` and match the tag.
- **MCP** (e.g. `hevy-mcp`): two sources — (a) **npm registry**
  `GET https://registry.npmjs.org/<pkg>` → `versions[<newVersion>]` and its
  `repository`/`homepage`/`bugs` fields to resolve the **GitHub repo**
  (confirmed: `hevy-mcp` → `github.com/chrisdoc/hevy-mcp`); then (b) **GitHub Releases API**
  on that repo for the version's release body / changelog. If no GitHub Release exists, link
  the npm version page (`https://www.npmjs.com/package/<pkg>/v/<newVersion>`) and the repo
  `CHANGELOG.md`. (Scoped packages like `@doist/todoist-mcp` resolve the same way.)
- **node**: link the Node.js release/changelog
  (`https://github.com/nodejs/node/releases/tag/v<newVersion>`); for a **digest-only** bump,
  note "base OS layer rebuild (same Node version, new digest) → patch" with the new digest.

**Assembled body:** a heading (`mcp-<name> <semver> — <kind> <old>→<new>`), the fetched
upstream notes block (or links if unavailable), and the four OCI label values for traceability.
This Release is what WUD's `wud.link.template` points at and what the n8n Claude review reads
(D7). Auth = the workflow's built-in `GITHUB_TOKEN` (read access to public upstream repos +
`contents: write` to create our own Release); no PAT.

**Phase 11/12 implementation checklist (derived from this appendix):**
- Phase 11: `release.config.js` per-MCP (B.1) · `@semantic-release/exec` gating build+push on a
  real release (B.1 signal) · `aggregate-release-notes.ts` (B.4) · `release.yml` globbing
  `mcps/*`, building+pushing only changed images with the four labels (B.3).
- Phase 12: `renovate.json` `packageRules` realizing the B.2 table (incl. the `commitBody`
  major recipe and `digest`→`fix`), `semanticCommits: enabled`, per-dep `semanticCommitScope`,
  `pinDigests`, `workarounds:nodeDockerVersioning` for the `node` dep.
