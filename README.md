# mcp-proxy-bundler

Config-driven monorepo that produces **hardened, auto-updated per-MCP OCI images**. Each image
bundles the [`mcp-auth-proxy`](https://github.com/sigbit/mcp-auth-proxy) OAuth 2.1 edge with a baked
stdio MCP server, published as `ghcr.io/thedebuggedlife/mcp-<name>`.

The internet-facing proxy is the auth boundary, so keeping it patched matters most. This repo makes the
edge **auto-patched** (Renovate + CI gate + semantic-release publish) and turns onboarding a new MCP
into a **config change**, not a bespoke build.

## Why this exists

An MCP deployed as a one-off custom image (proxy binary on a Node base, spawning the MCP over stdio)
falls out of any registry-based auto-update pipeline — the single most critical place to leave a
vulnerability window, since the proxy is the internet-facing gate. This builder generalizes that build:

- The edge proxy and Node base are **digest-pinned** and **auto-bumped** by Renovate.
- Every bump is gated by a real CI test suite (build + OAuth e2e against a live Authelia) before publish.
- Each image carries **honest semver** and OCI labels recording exactly what changed.
- Adding an MCP is two files plus a lockfile.

## Available MCPs

| MCP | Image | Upstream package | Source |
|---|---|---|---|
| Hevy | `ghcr.io/thedebuggedlife/mcp-hevy` | [`hevy-mcp`](https://www.npmjs.com/package/hevy-mcp) | [chrisdoc/hevy-mcp](https://github.com/chrisdoc/hevy-mcp) |
| Todoist | `ghcr.io/thedebuggedlife/mcp-todoist` | [`@doist/todoist-mcp`](https://www.npmjs.com/package/@doist/todoist-mcp) | [Doist/todoist-mcp](https://github.com/Doist/todoist-mcp) |
| Trello | `ghcr.io/thedebuggedlife/mcp-trello` | [`@delorenj/mcp-server-trello`](https://www.npmjs.com/package/@delorenj/mcp-server-trello) | [delorenj/mcp-server-trello](https://github.com/delorenj/mcp-server-trello) |

**Want another MCP?** [Open a new-MCP request](https://github.com/thedebuggedlife/mcp-proxy-bundler/issues/new?template=new-mcp.yml)
with the npm package and, if you know them, its stdio bin and API-key env var. Most stdio MCPs onboard as a
[config-only change](#how-to-add-a-new-mcp) — which you're also welcome to send as a PR yourself.

## How to use (deploy a published image)

Each image is self-contained — the proxy and the MCP are baked in. To run one you supply your IdP
config, the MCP's API key, and **one persistent volume** for the proxy's OAuth state. A minimal
`docker-compose.yml` for `mcp-hevy` (front it with your own TLS-terminating reverse proxy or tunnel):

```yaml
services:
  mcp-hevy:
    image: ghcr.io/thedebuggedlife/mcp-hevy:1.0.0   # pin a semver; see Versioning for auto-update
    restart: unless-stopped
    environment:
      # Public URL of THIS proxy — issuer + base for every advertised OAuth endpoint.
      # Stays https even though the container listens HTTP: TLS is terminated upstream.
      EXTERNAL_URL: "https://hevy.example.com"
      # Your OIDC provider (any compliant IdP; Authelia shown).
      OIDC_CONFIGURATION_URL: "https://auth.example.com/.well-known/openid-configuration"
      OIDC_CLIENT_ID: "mcp-hevy"
      OIDC_CLIENT_SECRET: "${MCP_HEVY_OIDC_CLIENT_SECRET}"   # from a gitignored .env, never committed
      OIDC_SCOPES: "openid,profile,email,groups"
      OIDC_ALLOWED_ATTRIBUTES: "/groups=mcp-admins"          # who is allowed in
      OIDC_USER_ID_FIELD: "/email"
      OIDC_PROVIDER_NAME: "Authelia"
      # The MCP's own API key(s). The var NAME(s) come from this image's mcp.yaml (runtime.apiKeyEnvs).
      HEVY_API_KEY: "${HEVY_API_KEY}"                        # from a gitignored .env, never committed
      # Listen plain HTTP and let the reverse proxy / tunnel terminate TLS.
      NO_AUTO_TLS: "true"
      LISTEN: ":8080"
      TRUSTED_PROXIES: "172.16.0.0/12"                       # CIDR of your reverse proxy
    volumes:
      # REQUIRED for token continuity. The proxy writes its JWT signing key + the OAuth
      # client/token DB here; without a persistent mount they reset on every container
      # recreate and ALL clients must re-authenticate. The host dir MUST be writable by
      # uid 1000 (the image runs as 1000:1000) — bind mounts do NOT inherit image ownership:
      #   mkdir -p ./appdata/hevy && sudo chown -R 1000:1000 ./appdata/hevy
      - ./appdata/hevy:/data
    extra_hosts:
      # Telemetry black-hole — entries come from this image's mcp.yaml (runtime.telemetryHosts).
      - "o4508975499575296.ingest.de.sentry.io:127.0.0.1"
    ports:
      - "8080:8080"   # or drop this and route via your reverse proxy's Docker network
```

- **Don't skip the `/data` volume.** It is the one piece of required state; everything else the image
  regenerates on start. See the [Runtime contract](#runtime-contract-what-a-consumer-must-supply) for the
  details and the uid-1000 ownership requirement.
- **TLS:** the example assumes something upstream terminates TLS. To let the proxy do ACME itself, drop
  `NO_AUTO_TLS`/`LISTEN`/`TRUSTED_PROXIES`, give `EXTERNAL_URL` a public https host, and expose 80/443.
- **Per-MCP facts** (the `apiKeyEnvs` names and any `telemetryHosts`) live in that image's
  `mcps/<name>/mcp.yaml`. The full env reference is the
  [Runtime contract](#runtime-contract-what-a-consumer-must-supply); tag pinning and auto-update are under
  [Versioning](#versioning).

## Repository layout

```
mcp-proxy-bundler/
├── mcps/                          # the config-driven heart — one dir per MCP
│   ├── hevy/
│   │   ├── package.json           # { "dependencies": { "hevy-mcp": "<ver>" } }  ← Renovate npm-managed
│   │   ├── package-lock.json      # deterministic install + digest pinning
│   │   └── mcp.yaml               # bin, runtime contract, telemetry hosts
│   └── todoist/
│       ├── package.json
│       ├── package-lock.json
│       └── mcp.yaml
├── Dockerfile                     # SHARED, parameterized by build args (MCP_DIR, MCP_BIN)
│                                  #   holds `FROM mcp-auth-proxy:<ver>` + `FROM node:<ver>` ← Renovate docker-managed
├── entrypoint.sh                  # shim: exec mcp-auth-proxy -- /app/node_modules/.bin/$MCP_BIN
├── scripts/
│   ├── build.sh                   # build one image from mcps/<name>/ + stamp OCI labels
│   ├── test-integration.sh        # bring up the Authelia CI stack and run the integration suite
│   └── lib/mcp-config.ts          # mcp.yaml schema + loader (single source of truth)
├── test/
│   ├── docker-compose.ci.yml      # authelia (file user DB + SQLite) + redis + image-under-test
│   ├── authelia/                  # throwaway test OIDC client + file user (templated, secrets ephemeral)
│   ├── integration/               # Tier-1 stdio tools/list + proxy gate + Tier-2 OAuth e2e
│   └── unit/                      # config, matrix, release-notes, version-mapping tests
├── .github/workflows/
│   ├── ci.yml                     # PR: build + test matrix over mcps/*, NO publish
│   ├── release.yml                # main: semantic-release → build → push GHCR → GH Release
│   └── renovate.yml               # scheduled self-hosted Renovate (own GitHub App token)
├── renovate.json                  # native docker + npm managers; severity → bump mapping
└── release.config.js              # semantic-release config (scope-routed, per-image)
```

The shape keeps Renovate on **native managers** (no custom regex): the MCP package version lives in
`mcps/<name>/package.json` (npm manager), while the proxy and Node versions live as `FROM` lines in the
shared `Dockerfile` (docker manager).

## Architecture

One proxy : one MCP, baked into one image. The clean path bakes `mcp-auth-proxy -- <stdio bin>`: the
proxy spawns and supervises the stdio child as a single foreground process. The MCP package is installed
at **build time** (`npm ci`), so the image starts instantly and its version is a real image property.

`mcp-auth-proxy` is a generic OIDC Relying Party that discovers any compliant provider via its
`/.well-known/openid-configuration`, so the images are **IdP-agnostic** — nothing IdP-specific is baked.
Authelia is the reference deployment's choice and the CI test fixture; the same image works with
Keycloak, Authentik, Auth0/Okta/Entra ID, Dex, Zitadel, Pocket ID, and so on.

A shared MCP aggregator/gateway behind one proxy is a deliberate non-goal: per-MCP proxies give
independent blast radius, a minimal Go-binary edge surface, and per-MCP auth scoping.

## How to add a new MCP

Onboarding is config-only — no Dockerfile, build, harness, or CI change is needed (the CI matrix
auto-discovers `mcps/*`).

1. **Create `mcps/<name>/package.json`** pinning the MCP npm package:
   ```json
   { "dependencies": { "<mcp-package>": "<version>" } }
   ```
2. **Generate the lockfile** (committed — the Dockerfile's `npm ci` consumes it):
   ```sh
   npm install --prefix mcps/<name> --package-lock-only
   ```
   If the package mis-declares a test/eval dependency as a runtime one (so `npm ci --omit=dev` would bake
   it), stub it out with an `overrides` entry in `package.json` rather than letting it bloat the image —
   e.g. `mcps/trello` maps the mis-packaged `mcp-evals` to `npm:empty-npm-package@1.0.0`.
3. **Create `mcps/<name>/mcp.yaml`** (see the contract below). Use the package's `bin` field to find the
   **stdio** bin name for `mcpBin`, and the MCP's docs to find the env var(s) it reads for `runtime.apiKeyEnvs`.
4. **Build and test locally:**
   ```sh
   ./scripts/build.sh <name>
   npm run test:integration        # MCP_NAME=<name> targets one image; defaults to hevy
   ```
5. **Open a PR.** CI builds the image and runs the full Tier-1 + Tier-2 suite against a live Authelia.
   On merge to `main`, a `feat(<name>)`/`fix(<name>)`-scoped commit triggers the first publish.

### `mcp.yaml` contract

This file carries **MCP facts only** — never consumer/platform specifics (no internal hostnames, domains,
secrets, or UI fields). The schema is validated by `scripts/lib/mcp-config.ts`.

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Image name → `ghcr.io/thedebuggedlife/mcp-<name>` |
| `mcpPackage` | yes | npm package name; **must match the `package.json` dependency key** (cross-checked by the loader) |
| `mcpBin` | yes | The stdio bin to spawn (`node_modules/.bin/<mcpBin>`) |
| `displayName` | no | Human label (defaults to `name`) |
| `nodeVersion` | no | Per-MCP Node base override. **Schema-accepted but not yet wired into the build** — `build.sh` errors clearly if it differs from the shared base, rather than silently ignoring it. |
| `runtime.apiKeyEnvs` | no | List of env vars the MCP reads at runtime (one or more credentials) — supplied by the consumer, **not baked** |
| `runtime.telemetryHosts` | no | Hostnames the consumer should black-hole via `extra_hosts` (telemetry egress control) |

Example (`mcps/hevy/mcp.yaml`):

```yaml
name: hevy
displayName: "Hevy MCP"
mcpPackage: hevy-mcp
mcpBin: hevy-mcp
runtime:
  apiKeyEnvs:
    - HEVY_API_KEY
  telemetryHosts:
    - o4508975499575296.ingest.de.sentry.io
```

MCPs that need more than one credential list them all under `apiKeyEnvs` (the consumer supplies each at
runtime). For example, `mcps/trello/mcp.yaml` declares both `TRELLO_API_KEY` and `TRELLO_TOKEN`.

## Runtime contract (what a consumer must supply)

The image expects these at **runtime** (in the consumer's compose, **never baked** into the image). The
env-var names are the verified `mcp-auth-proxy` contract (design Appendix A):

| Env | Purpose |
|---|---|
| `EXTERNAL_URL` | `https://<mcp>.<your-domain>` — issuer + base for all advertised OAuth endpoints |
| `OIDC_CONFIGURATION_URL` | Upstream OIDC discovery URL |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Confidential client at your IdP (the proxy's RP does not send PKCE upstream — the IdP must permit a confidential client without mandatory PKCE) |
| `OIDC_SCOPES` | Defaults to `openid,profile,email` |
| `OIDC_ALLOWED_ATTRIBUTES`, `OIDC_USER_ID_FIELD` | Group/claim authorization (IdP-specific; e.g. `/groups=mcp-admins`) |
| `OIDC_PROVIDER_NAME` | Display name for the upstream provider |
| `AUTH_HMAC_SECRET` | Optional — auto-generated and persisted to `$DATA_PATH/secret` if unset |
| `TRUSTED_PROXIES` | IP/CIDR list of trusted upstream proxies |
| `NO_AUTO_TLS`, `LISTEN` | Proxy listener config |
| `DATA_PATH` (`/data`) | Holds `private_key.pem` (JWT signing key) + the bbolt `db` (registered OAuth clients/tokens). **Must be writable by uid 1000** (the image runs as `1000:1000`). |
| `<apiKeyEnvs>` (e.g. `HEVY_API_KEY`; Trello needs `TRELLO_API_KEY` + `TRELLO_TOKEN`) | Passed through to the stdio MCP child |

**Token continuity:** mount `DATA_PATH=/data` to a per-instance persistent host directory. The proxy keeps
its signing key and registered-client/token database there, so image swaps are token-safe — clients do
not re-authenticate across an update.

The proxy is the **sole gate**: `GET /mcp` unauthenticated returns `401` (not a portal redirect). It speaks
OAuth 2.1 authorization-code + PKCE (S256) with Dynamic Client Registration toward downstream MCP clients.

## OCI labels

Every image is stamped at build with these labels (source: `scripts/build.sh`), so a consumer can record
exactly what changed:

| Label | Source |
|---|---|
| `io.thedebuggedlife.mcp.proxy-version` | `mcp-auth-proxy` `FROM` tag in the Dockerfile |
| `io.thedebuggedlife.mcp.node-version` | `node` `FROM` tag in the Dockerfile (`-slim` stripped) |
| `io.thedebuggedlife.mcp.package` | `mcpPackage` from `mcp.yaml` |
| `io.thedebuggedlife.mcp.package-version` | the pinned version from `mcps/<name>/package.json` |

## Versioning

Each image carries its **own semver** (semantic-release), bumped to honestly mirror the changed input —
upstream major → composite major, minor → minor, patch → patch — for whichever input changed (proxy, MCP
package, or Node base). A digest-only base rebuild maps to a patch bump.

Per-image versions use **scope-based commit routing**: one semantic-release run per image (tag prefix
`mcp-<name>-v*`) accepts its own commit scope (`hevy`/`todoist`) plus the shared `proxy`/`node`/`image`
scopes — so a shared change versions every image while an MCP bump versions only its own. Any other commit
(unscoped, or `ci:`/`docs:`/`chore:`) releases nothing — see [CLAUDE.md](./CLAUDE.md) for the conventions.
Tags published: `:<semver>` + `:latest`.

**Apply/review policy is the consumer's, not the bundler's.** This repo versions honestly and stamps
"what changed"; deciding which updates auto-apply vs. require review (including "always review when the edge
proxy changed") is owned by the consumer.

### What a version bump looks like

Every input maps to one Conventional Commit on `main`, which `release.config.js` routes to the right
image(s). Using `mcp-hevy` as the example:

| Input that changed | Commit on `main` (author) | `mcp-hevy` | other images |
|---|---|---|---|
| `hevy-mcp` upstream **patch** / digest re-pin | `fix(hevy): …` (Renovate) | patch | — |
| `hevy-mcp` upstream **minor** | `feat(hevy): …` (Renovate) | minor | — |
| `hevy-mcp` upstream **major** | `feat(hevy): …` + `BREAKING CHANGE:` footer (Renovate) | major | — |
| `mcp-auth-proxy` edge bump | `fix(proxy):` / `feat(proxy): …` (Renovate) | per severity | **all bump** |
| `node` base bump (LTS) | `fix(node):` / `feat(node): …` (Renovate) | per severity | **all bump** |
| image runtime change (entrypoint, schema shim, baked script) | `fix(image):` / `feat(image): …` (us) | per severity | **all bump** |

"Per severity" follows the same rule as the MCP rows: `feat` → minor, `fix`/digest → patch,
`BREAKING CHANGE:` → major. A shared scope (`proxy`/`node`/`image`) versions **every** image; an MCP scope
versions only its own.

### Auto-updating (WUD and friends)

Collapsing four moving inputs into **one semver per image** is what makes registry-based auto-update work:
a watcher only sees image **tags**, not the proxy/Node/MCP versions baked inside. One honest semver means
any change produces exactly one higher, comparable number to act on — while the [OCI labels](#oci-labels)
and the GitHub release notes still record *which* input moved, so you can gate "review when the edge proxy
changed."

Images publish `:<semver>` and `:latest`. Pin the semver tag and let [WUD](https://github.com/getwud/wud)
watch the series — add these labels to the service in your compose:

```yaml
    labels:
      wud.watch: "true"
      wud.tag.include: '^\d+\.\d+\.\d+$'
      wud.link.template: "https://github.com/thedebuggedlife/mcp-proxy-bundler/releases"
```

With the service pinned to e.g. `:1.4.2`, WUD flags `1.4.3` / `1.5.0` / `2.0.0` as they publish. Run WUD
**notify-only** to review before applying, or let it auto-update — that apply/review choice is yours (see
the policy above). To track a moving tag instead, pin `:latest` and add `wud.watch.digest: "true"` so WUD
notices re-pinned digests.

## Public-repo hygiene

This repo and its GHCR packages are **public**. That is safe because no credentials live in the source:

- **No secrets baked into images.** API keys, OIDC client secrets, and HMAC secrets are runtime env
  supplied by the consumer — never in the Dockerfile, `mcp.yaml`, or any committed file.
- **CI test secrets are ephemeral.** The CI Authelia harness generates its throwaway secrets at runtime
  (test OIDC client secret, session/storage/JWT secrets, the test user password, the dummy MCP API key)
  into a gitignored `test/.secrets/`. Nothing secret-shaped is committed.
- **No internal topology in build config.** Real hostnames, `EXTERNAL_URL` values, and IdP client details
  stay in the private consumer repo. `mcp.yaml` carries only env-var names, public package names, and
  public telemetry hostnames.
- **Architecture is intentionally public.** Security rests on the runtime secrets and the auth gate, not on
  obscuring the design.

## Development

Host tooling runs on Node + Vitest (the build images use Node 26 internally; the host test runner does not
require it).

```sh
npm install
npm run test:unit          # config / matrix / release-notes / version-mapping tests
./scripts/build.sh hevy    # build one image locally → ghcr.io/thedebuggedlife/mcp-hevy:dev
npm run test:integration   # MCP_NAME=<name> brings up Authelia+redis+image and runs Tier-1 + Tier-2
```

The integration suite stands up a real Authelia (file user DB + SQLite + redis) and the image under test,
then runs the full edge auth path end-to-end (scripted first-factor login → OIDC code → proxy bearer token
→ authenticated `tools/list`). It tears the stack down on exit. Docker is required.
