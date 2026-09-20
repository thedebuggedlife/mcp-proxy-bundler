# Pluggable MCP Runtimes (.NET first) + Immich MCP — Design Specification

> **Status:** Approved design — not yet implemented.
> **Date:** 2026-09-19
> **Extends:** [`2026-06-22-mcp-proxy-bundler.md`](2026-06-22-mcp-proxy-bundler.md) (the founding spec; D-numbers below refer to it).

---

## Goal

Let the bundler publish a hardened composite image for a stdio MCP that is **not** an npm package, starting with the **.NET runtime**, and use it to onboard an **Immich** MCP. The builder gains a *runtime type* seam shaped so a third runtime (e.g. Python) is an additive change, not another restructuring.

The driving use case is accessing pictures and videos from an agent — including a Claude Cowork session that must get media onto its local disk to manipulate it — rather than administering the Immich server.

---

## Why a new runtime: the Immich MCP survey

Thirteen Immich MCP servers were surveyed (source-verified, not README-verified; none were run against a live Immich). Weighted for media access:

| Candidate | Stack / transport | Image bytes to the model | Verdict |
|---|---|---|---|
| **`barryw/ImmichMCP`** | C# / .NET 10, stdio (`--stdio`) + HTTP | **Yes** — `ImageContentBlock` from Immich's preview rendition when `DOWNLOAD_MODE=base64`; 25 MiB cap | **Selected** |
| `immich-mcp` (npm, lidless-labs) | TypeScript, stdio | No — URL paths only | Fits the builder today, but cannot deliver pixels; documented upload confinement (`IMMICH_UPLOAD_BASE_DIR`) is absent from the shipped code; pins `@immich/sdk` 2.x against Immich 3.x |
| `whitehara/immich-mcp` | Python, stdio + HTTP | No — URLs embedding `?apiKey=` (leaks the key into model context) | Best-tested, but no pixels and no license |
| `tomereli`, `wanjau2` | Python, **HTTP only** | Yes | Personal 9-commit projects; no stdio; `wanjau2` has committed secrets and no license |
| `homeserverhq/immich-mcp` | Python, HTTP only | No | 135 tools, GPL-3.0, per-request API key — does not fit a baked stdio image |
| others (`mcp-immich`, `mattmaas`, `pimpmypixel`, `zygou-31`, `sandraschi`, `claw2immich`, `mbay-ODW`) | — | — | Broken against the Immich API, abandoned, skeletal, or a stale copy of `barryw` |

`barryw/ImmichMCP` is the only candidate combining pixel delivery, strong retrieval (CLIP + metadata + OCR search, filterable by person/date/place/type), stdio, an actively released and tested codebase (86 commits, 29 releases, 142 tests, targets Immich v3), and confirm-gated destructive calls. It requires the ASP.NET Core shared framework, which the builder cannot host today.

---

## Current State

The Node/npm assumption is encoded in six places:

1. `scripts/lib/mcp-config.ts` — the schema requires `mcpPackage` + `mcpBin` and cross-checks a `package.json` dependency.
2. `Dockerfile` — `npm ci --omit=dev`; `ENV MCP_BIN`.
3. `entrypoint.sh` — execs `/app/node_modules/.bin/"$MCP_BIN"`.
4. `scripts/build.sh` and `scripts/release-image.sh` — ~30 duplicated lines parsing `FROM` tags and assembling `docker build` args/labels.
5. `test/integration/helpers/stdio-client.ts` — hard-codes `--entrypoint /app/node_modules/.bin/${mcpBin}`.
6. `renovate.json` + `test/unit/renovate-rules.test.ts` — per-MCP rules assume the `npm` manager and `mcps/<name>/package.json`.

Two constraints carry over unchanged:

- **The stdio schema shim is a Node script** (`mcp-schema-shim.cjs`) and `mcp-auth-proxy#178` is still open (2.10.2 is still the latest proxy release). Every image, whatever its MCP runtime, needs a Node binary until the shim is retired.
- **The workflows are already runtime-neutral.** `ci.yml` and `release.yml` discover `mcps/*/mcp.yaml` and drive everything through the scripts. No workflow change is needed.

---

## Design

### R1. Runtime type in `mcp.yaml`

`runtime:` is already taken (it holds `apiKeyEnvs` / `telemetryHosts`), so the discriminator is a top-level **`type: node | dotnet`**, defaulting to `node`. The five existing `mcp.yaml` files stay byte-for-byte unchanged. `McpConfigSchema` becomes a strict zod discriminated union.

A `.NET` MCP is two files — no `package.json`, no lockfile:

```yaml
# mcps/immich/mcp.yaml
name: immich
displayName: "Immich MCP"
type: dotnet
mcpImage: ghcr.io/barryw/immichmcp   # must match upstream.Dockerfile's FROM
mcpRepo: barryw/ImmichMCP            # GitHub repo for release-notes lookup (R6)
mcpAssembly: ImmichMCP.dll           # relative to /app in the upstream image
mcpArgs: ["--stdio"]
runtime:
  apiKeyEnvs: [IMMICH_BASE_URL, IMMICH_API_KEY]
```

```dockerfile
# mcps/immich/upstream.Dockerfile — one literal line; the Renovate-tracked pin
FROM ghcr.io/barryw/immichmcp:v3.3.3@sha256:<digest>
```

`upstream.Dockerfile` matches Renovate's default `dockerfile` file pattern (`(^|/|\.)[Dd]ockerfile$`) and its name says it is not the build recipe. The digest is resolved when the file is first written.

**Validation mirrors the node path.** Where the loader today asserts `mcpPackage ∈ package.json.dependencies`, for `dotnet` it parses the `FROM` line in `upstream.Dockerfile`, asserts the image name equals `mcpImage`, requires both a tag and a digest, and derives the version from the tag (leading `v` stripped).

**Injection safety.** `mcpBin`, `mcpAssembly`, and each `mcpArgs` item must match `^[A-Za-z0-9._=:/@-]+$`, because they are interpolated into a generated launcher script (R3).

**Runtime-neutral metadata.** `mcp-meta.ts` stops emitting `mcpPackage` / `packageVersion` / `mcpBin` and emits keys every script consumes without knowing the type:

| Key | `node` | `dotnet` |
|---|---|---|
| `type` / `target` | `node` | `dotnet` |
| `upstream` | npm package name | image name |
| `upstreamVersion` | pinned dependency version | image tag, `v` stripped |
| `mcpImageRef` | *(empty)* | full `image:tag@digest` from `upstream.Dockerfile` |
| `launch` | `/app/node_modules/.bin/<bin>` | `dotnet /app/mcp/<assembly> <args…>` |

**One targeted cleanup.** The duplicated block in `build.sh` / `release-image.sh` is extracted once into `scripts/lib/build-common.sh`, so per-type logic (the `--target`, the build args, the labels) has a single home. No other refactoring.

### R2. Why our own ASP.NET base, not upstream's image

Upstream's image already contains a .NET runtime, but it is only used as an **artifact carrier** — we `COPY --from` its `/app` (3.2 MB of portable IL assemblies; no native `runtimes/` directory) and discard the rest. Measured on `immichmcp:v3.3.3` (released 2026-08-05):

| | Upstream's image | Our pinned `aspnet` base |
|---|---|---|
| .NET runtime | 10.0.10, frozen at upstream's build | 10.0.12, bumped by Renovate |
| OS | Ubuntu 24.04.4, 40 pending package upgrades | rebuilt with every base-digest bump |
| User | root | `1000:1000` |
| Extras | `curl`, `HEALTHCHECK`, `EXPOSE 5000`, `ASPNETCORE_URLS` | none |

Building on upstream's image would tie runtime and OS patching to upstream's release cadence — the exact gap the founding spec exists to close. The app's `rollForward` is default (latest patch), so it runs on whatever 10.0.x we supply.

`aspnet` rather than `runtime`: ImmichMCP is a `Microsoft.NET.Sdk.Web` project and needs the `Microsoft.AspNetCore.App` shared framework even in `--stdio` mode. .NET 10 ships no Debian images (Ubuntu, Alpine, Azure Linux only), so the fleet spans two base OSes by design: **each runtime uses its ecosystem's official base**, plus the proxy, plus (temporarily) Node for the shim.

### R3. One multi-target Dockerfile, uniform launcher

```dockerfile
ARG MCP_IMAGE=scratch

# Literal, digest-pinned upstreams — single-sourced for Renovate + the version parse (Appendix B.3)
FROM ghcr.io/sigbit/mcp-auth-proxy:2.10.2@sha256:…            AS proxy
FROM node:26.9.0-slim@sha256:…                                AS node-upstream
FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-noble@sha256:…   AS dotnet-upstream
FROM ${MCP_IMAGE}                                             AS mcp-image

# Runtime-neutral payload, defined once
FROM scratch AS common
COPY --from=proxy /usr/local/bin/mcp-auth-proxy /usr/local/bin/mcp-auth-proxy
COPY mcp-schema-shim.cjs /app/mcp-schema-shim.cjs
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

FROM node-upstream AS node
#   ca-certificates · COPY package*.json · npm ci --omit=dev   (as today)
#   + shared tail

FROM dotnet-upstream AS dotnet
#   apt: libatomic1                                  (required by the Node binary on Ubuntu noble)
#   COPY --from=node-upstream /usr/local/bin/node    (for the shim only)
#   COPY --from=mcp-image /app /app/mcp
#   ENV DOTNET_EnableDiagnostics=0
#   + shared tail

# Shared tail, in every target:
#   COPY --from=common / /
#   RUN printf '#!/bin/sh\nexec %s "$@"\n' "$MCP_LAUNCH" > /app/mcp-launch && chmod +x /app/mcp-launch
#   USER 1000:1000
#   ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- The scripts pass `--target <type>`, `--build-arg MCP_LAUNCH=…`, and for `dotnet` `--build-arg MCP_IMAGE=<mcpImageRef>`. BuildKit builds only the stages the target needs: a `node` build never pulls the ASP.NET image; a `dotnet` build never runs `npm`.
- `MCP_IMAGE=scratch` keeps the unused `mcp-image` stage valid for `node` builds and makes Renovate ignore that line — the real pin is tracked in `upstream.Dockerfile`.
- A second `Dockerfile.dotnet` was rejected: it would duplicate the literal proxy/Node `FROM` lines that Renovate and the version parse both depend on being single-sourced.

**Uniform launcher.** `/app/mcp-launch` replaces the `MCP_BIN` build-arg/ENV pair. `entrypoint.sh` becomes runtime-neutral and identical in every image:

```sh
exec mcp-auth-proxy -- node /app/mcp-schema-shim.cjs /app/mcp-launch "$@"
```

The integration harness uses `--entrypoint /app/mcp-launch` for every image, so `mcpBin` leaves `mcp-under-test.ts`.

**Verified for `--stdio` mode** (upstream `Program.cs`): the generic `Host` is used (no Kestrel, no port bound) and `LogToStandardErrorThreshold = Trace` sends all logging to stderr, keeping stdout clean for JSON-RPC. Copying only `/app` means none of upstream's `ASPNETCORE_URLS` / `MCP_PORT` / `HEALTHCHECK` / `EXPOSE` is inherited. A throwaway build confirmed Node 26.9.0 and both .NET 10.0.12 shared frameworks run side by side as uid 1000 on `aspnet:10.0` once `libatomic1` is installed.

**Hardening parity.** Same posture as the node target: slim official base, CA bundle (already present in the ASP.NET image), non-root `1000:1000` (not the image's `app`/1654, so the consumer contract is identical across images), no build tooling. `DOTNET_EnableDiagnostics=0` disables the diagnostics IPC channel. A unit test parses the Dockerfile and asserts **every** runtime target ends with `USER 1000:1000` and the shared `ENTRYPOINT`.

### R4. Versioning and release routing

One new shared scope, `dotnet`:

| Scope | Triggered by | Releases |
|---|---|---|
| `immich` | Renovate bump of `mcps/immich/upstream.Dockerfile` | `mcp-immich` only |
| `dotnet` *(new)* | Renovate bump of the ASP.NET `FROM` line | only `type: dotnet` images |
| `node` | Node `FROM` bump | every image (every image carries Node for the shim) |
| `proxy`, `image` | unchanged | every image |

`releaseRulesFor(name)` becomes `releaseRulesFor(name, type)`, generating the same deny-by-default rule list (catch-all first, explicit `breaking → major`) from one table:

```ts
const SHARED_SCOPES = {
  node: ['proxy', 'image', 'node'],
  dotnet: ['proxy', 'image', 'node', 'dotnet'],
}
```

`release.config.js` loads the MCP's config to obtain `type`. When the shim is retired, removing `'node'` from the `dotnet` row stops .NET images re-releasing on Node bumps.

### R5. Renovate — no new managers

Two new `packageRules`; the `dockerfile` manager is already enabled and extracts `FROM` (and `COPY --from`) references.

1. **ASP.NET base** — `matchManagers: ["dockerfile"]`, `matchDepNames: ["mcr.microsoft.com/dotnet/aspnet"]` → `semanticCommitScope: "dotnet"`. A companion rule sets `enabled: false` for **major** updates of this dep: the runtime major must track upstream's target framework (`net10.0` will not start on 11.x), so it is bumped by hand when upstream retargets. Docker versioning keeps the `-noble` suffix fixed.
2. **Immich** — `matchManagers: ["dockerfile"]`, `matchFileNames: ["mcps/immich/upstream.Dockerfile"]` → `semanticCommitScope: "immich"`.

Everything else applies unchanged because the existing `matchUpdateTypes → semanticCommitType` rules are manager-agnostic: minor → `feat`, patch/digest → `fix`, major → `feat` + `BREAKING CHANGE`; minor/patch/digest auto-merge after CI, majors wait for a human. Renovate's docker versioning strips a leading `v` (`version.replace(/^v/, '')`), so upstream's `vX.Y.Z` tags yield correct major/minor/patch classification; `latest` and `dev-<sha>` do not parse and are ignored. With `pinDigests`, an upstream re-push of an existing tag surfaces as a digest bump → patch release (D5).

`test/unit/renovate-rules.test.ts` becomes type-aware: for each discovered MCP it requires a rule scoped to `<name>` whose `matchFileNames` names the file for that MCP's type — `package.json` for `node`, `upstream.Dockerfile` (with the `dockerfile` manager) for `dotnet`.

### R6. OCI labels and release notes

**Labels are additive.** The four existing labels keep their names and meaning. For `dotnet` images `package` = the upstream image name and `package-version` = its version; `node-version` is still stamped (Node is in the image). One new label on `dotnet` images only: `io.thedebuggedlife.mcp.dotnet-version`, parsed from the literal ASP.NET `FROM` line (digest and `-noble` suffix stripped).

**Release notes.** `ChangedKind` gains `'dotnet'`, rendered as a links-only block to Microsoft's release notes for that servicing version (same shape as `node`). For an MCP bump on a `dotnet`-type image, the repo comes from `mcpRepo` instead of the npm registry's `repository` field, then the existing `fetchGithubRelease(repo, tag)` path is reused. `deriveChange`'s `to v?([\w.-]+)` parse already handles Renovate's Docker-tag commit subjects. The exact Microsoft release-notes URL/tag format for a servicing release is confirmed during implementation.

### R7. Immich onboarding

Per the CLAUDE.md checklist, adjusted for the new type: `mcps/immich/{mcp.yaml,upstream.Dockerfile}`; the Renovate rule (R5); a harness registry entry with `expectedTools` `immich_search_smart`, `immich_search_metadata`, `immich_people_assets`, `immich_assets_download_thumbnail` (names verified in upstream source); the `ci-matrix` inventory; a README **Available MCPs** row; and the README "add a new MCP" section rewritten to cover both types.

`DOWNLOAD_MODE=base64` — which enables image content blocks — is **consumer configuration** and is not baked into the image (D3: the bundler carries MCP facts only). The README row documents it prominently, along with `MAX_INLINE_DOWNLOAD_BYTES`.

---

## Test Plan

**Unit (Vitest).**
- Config union: fixtures for a valid `dotnet` MCP, image-name mismatch, missing digest, unsafe characters in `mcpArgs`, missing `mcpRepo`; all existing `node` fixtures unchanged.
- Launch-string construction per type; ASP.NET `FROM` version parsing (digest and suffix stripped).
- Release routing: a `dotnet`-scope commit releases immich but not hevy; a `node`-scope commit releases both.
- Type-aware Renovate guard (R5); Dockerfile hardening tripwire (R3).
- `aggregate-release-notes`: the `'dotnet'` kind, and `mcpRepo`-based resolution.

**Integration.** The existing four suites (harness smoke, proxy gate, OAuth e2e, `tools/list`) run against the immich image unchanged, selected by `MCP_NAME=immich`. Two harness changes: `--entrypoint /app/mcp-launch`, and an optional per-MCP dummy-env override in `mcp-under-test.ts` so immich gets `IMMICH_BASE_URL=http://immich.invalid` (the harness's literal `dummy` is not a valid URL; upstream reads both values lazily, but the test should not depend on that). Real tool execution remains an explicit non-goal (D8) — there is no Immich backend in CI.

---

## Delivery

Two PRs, so the re-release of the existing five images is isolated from the new image:

1. **`feat(image): runtime-neutral launcher`** — multi-target Dockerfile with only the `node` target, `/app/mcp-launch`, runtime-neutral `entrypoint.sh`, harness update, shared script library, `type` field defaulting to `node`. No new capability; proven by the existing five-image integration matrix. Releases all five images (minor).
2. **`feat(immich): .NET runtime support + Immich MCP`** — the `dotnet` type and target, `dotnet` scope and release routing, Renovate rules, new label and release-notes kind, the immich config. Leaves node images untouched, so only `mcp-immich` releases.

Commits on the branches use non-release types; the PR titles above are the squash subjects.

---

## Risks and validation order

| # | Risk | How it is retired |
|---|---|---|
| 0 | The server misbehaves against the consumer's Immich version | **Retired 2026-09-20.** The consumer ran upstream's `v3.3.3` image as a stdio MCP inside Immich's Docker network (Immich `v3.2.2`, `DOWNLOAD_MODE=base64`) from Claude Code: search and people tools worked, and the model could see images delivered as `image` content blocks |
| 1 | App fails to start as uid 1000 with no passwd entry / writable `HOME`, or its `tools/list` does not survive the shim | First `:dev` build + the `tools/list` integration test. On failure: stop and report, do not work around |
| 2 | `mcp-auth-proxy` mishandles multi-megabyte `image` results (25 MiB default cap, +33% base64) | Manual check against the consumer's Immich through the local `:dev` image. Mitigation: lower `MAX_INLINE_DOWNLOAD_BYTES`; report upstream |
| 3 | Image content blocks reach the model but not the agent's disk | **Observed 2026-09-20 in Claude Code** (Cowork still unverified): the agent could see an image but could not write it to a file. The URL fallback is **not viable for this consumer** — Immich sits behind mTLS, so neither asset URLs nor shared links are fetchable from an agent sandbox, least of all Cowork on the web. **Accepted:** ship with model-visible images only; on-disk delivery is a recorded follow-up (see Out of Scope) |
| 4 | Upstream has **no LICENSE file** (README and the csproj's `PackageLicenseExpression` both say MIT), and we redistribute its binaries in a public image | Ask upstream to add the file. Does not block building; see Open Questions |
| 5 | Our runtime patch level runs ahead of what upstream tested | Expected .NET servicing behaviour; the integration matrix runs on every `dotnet` bump |

---

## Files Changed

| File | Change |
|------|--------|
| `Dockerfile` | Multi-target (`node`, `dotnet`), `common` stage, `/app/mcp-launch`; third literal `FROM` for the ASP.NET base |
| `entrypoint.sh` | Runtime-neutral: launches `/app/mcp-launch` |
| `scripts/lib/mcp-config.ts` | Discriminated union on `type`; `dotnet` validation against `upstream.Dockerfile` |
| `scripts/lib/build-common.sh` | **New.** Shared `FROM`-tag parsing and `docker build` arg/label assembly, sourced by both scripts |
| `scripts/mcp-meta.ts`, `scripts/build.sh`, `scripts/release-image.sh` | Runtime-neutral metadata; `--target`; `dotnet-version` label |
| `scripts/lib/release-rules.ts`, `release.config.js` | `releaseRulesFor(name, type)` from the `SHARED_SCOPES` table |
| `scripts/aggregate-release-notes.ts`, `scripts/release-notes-from-commits.ts` | `'dotnet'` kind; `mcpRepo` resolution |
| `renovate.json` | `dotnet` scope rule, runtime-major disable, immich rule |
| `mcps/immich/{mcp.yaml,upstream.Dockerfile}` | **New.** First `dotnet` MCP |
| `test/integration/helpers/{stdio-client,mcp-under-test}.ts` | Launcher entrypoint; drop `mcpBin`; dummy-env override; immich entry |
| `test/unit/*`, `test/fixtures/mcps/*` | New cases and fixtures per the Test Plan |
| `README.md`, `CLAUDE.md` | Both types in "add a new MCP"; `dotnet` scope in the release table; immich row |

---

## Out of Scope (recorded follow-ups)

- **Chiseled ASP.NET base** (`aspnet:10.0-noble-chiseled`): no shell, no package manager, much smaller CVE surface. Needs a shell-free launcher (the shim could absorb that role) and a non-apt source for `libatomic`.
- **Dropping Node from `dotnet` images** once `mcp-auth-proxy#178` is fixed and the shim is deleted — then also remove `'node'` from the `dotnet` row of `SHARED_SCOPES`.
- **A Python runtime type.** Eight of the eleven Immich servers found were Python; the seam (`type` union member + Dockerfile target + metadata row) is shaped for it.
- **Getting media bytes onto the agent's disk through MCP itself** (risk 3), with no URL the sandbox must fetch. First establish what the MCP clients in play (Claude Code, Cowork) let an agent persist from a tool result; if a workable shape exists, contribute it to `barryw/ImmichMCP` rather than carrying a fork.
- **An automated large-payload relay test** for the proxy that needs no MCP backend.

---

## Open Questions

1. **Does the missing upstream LICENSE gate the first public `mcp-immich` release?** Recommendation: open an upstream issue asking for a `LICENSE` file now; build and validate in parallel; hold only the *public release* (PR 2's merge) until upstream responds or the consumer explicitly accepts the README/csproj MIT declaration as sufficient.
