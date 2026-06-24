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
3. **Create `mcps/<name>/mcp.yaml`** (see the contract below). Use the package's `bin` field to find the
   **stdio** bin name for `mcpBin`, and the MCP's docs to find the env var it reads for `runtime.apiKeyEnv`.
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
| `runtime.apiKeyEnv` | no | The env var the MCP reads at runtime — supplied by the consumer, **not baked** |
| `runtime.telemetryHosts` | no | Hostnames the consumer should black-hole via `extra_hosts` (telemetry egress control) |

Example (`mcps/hevy/mcp.yaml`):

```yaml
name: hevy
displayName: "Hevy MCP"
mcpPackage: hevy-mcp
mcpBin: hevy-mcp
runtime:
  apiKeyEnv: HEVY_API_KEY
  telemetryHosts:
    - o4508975499575296.ingest.de.sentry.io
```

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
| `<apiKeyEnv>` (e.g. `HEVY_API_KEY`) | Passed through to the stdio MCP child |

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

## Deployment

This repo produces **images only**. Deploying an image as a live MCP (compose service, IdP client, tunnel
hostname, secrets, auto-update wiring) is the consumer's job. The deploy blueprint is hand-maintained in the
private [`avargaskun/unraid-agent`](https://github.com/avargaskun/unraid-agent) consumer repo — no consumer
artifacts are generated here, keeping this repo decoupled and secret-free. `mcp.yaml` is the contract the
consumer reads when hand-writing each deployment: `runtime.apiKeyEnv` (which secret to supply),
`runtime.telemetryHosts` (the `extra_hosts` black-hole entries), and `mcpBin`/`name`.

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
