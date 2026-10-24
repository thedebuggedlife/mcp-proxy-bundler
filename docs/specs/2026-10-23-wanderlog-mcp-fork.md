# Wanderlog MCP via a Reviewed Fork — Design Specification

> **Status:** Approved design — not yet implemented.
> **Date:** 2026-10-23
> **Extends:** [`2026-06-22-mcp-proxy-bundler.md`](2026-06-22-mcp-proxy-bundler.md) (the founding spec).
> **Spans two repos:** this one (`mcp-proxy-bundler`) and a new fork, `thedebuggedlife/wanderlog-mcp`.

---

## Goal

Publish `ghcr.io/thedebuggedlife/mcp-wanderlog`, a bundled image for a Wanderlog MCP, where **every line of
upstream code that reaches the image has been reviewed** — automatically by Claude when the change is
unremarkable, by a human otherwise — while keeping the bundler's existing Renovate → CI → semantic-release
flow unchanged.

---

## Background: the Wanderlog landscape

Wanderlog has **no public API and no official MCP**. Every integration drives its private web-client API
(REST + a ShareDB websocket) authenticated by the browser session cookie `connect.sid`.

| Candidate | Notes | Verdict |
|---|---|---|
| **`shaikhspeare/wanderlog-mcp`** (npm `wanderlog-mcp`, MIT) | ~150 stars, active; stdio bin `wanderlog-mcp`; 3 runtime deps (`@modelcontextprotocol/sdk`, `ws`, `zod`); env `WANDERLOG_COOKIE`; source-verified egress to `wanderlog.com` only, no filesystem writes, no telemetry | **Selected as upstream** |
| `ZawYePhyo/wanderlog_mcp` (`@zaw_ye/wanderlog_mcp`) | Fork adding a Playwright browser-login flow (useless headless, heavy); 3 stars; dormant since 2026-04 | Rejected |
| Other directory listings (Glama etc.) | Re-listings/clones of the above | Rejected |
| Build our own | Would reimplement the same private API | Rejected |

**Why a fork rather than the upstream npm package:** upstream publishes to npm by hand and last did so on
2026-06-07 (`0.3.1`). Its `main` is 74 commits ahead, including ShareDB crash fixes (#82, #84, #60) and a
startup auth-probe retry (#51); issue #65 (an unhandled rejection that crashes the process) is still open.
A fork lets us ship reviewed fixes on our own cadence and puts a review gate in front of every upstream change —
appropriate for an unofficial MCP holding a credential with full account access.

---

## Design

### F1. Topology

Two repos, connected only through the npm registry.

- **`thedebuggedlife/wanderlog-mcp`** — a GitHub fork of `shaikhspeare/wanderlog-mcp`. `main` = upstream history
  plus a small set of our patches (F2). Publishes **`@thedebuggedlife/wanderlog-mcp`** (npm org `thedebuggedlife`).
- **`mcp-proxy-bundler`** (this repo) — onboards `mcps/wanderlog/` against that package like any other npm MCP (F7).

Fork workflows:

| Workflow | Trigger | Does |
|---|---|---|
| `sync.yml` | daily schedule + `workflow_dispatch` | Merges upstream `main` into a `sync/<upstream-sha>` branch and opens/updates the sync PR |
| `review.yml` | `pull_request_target` on `sync/*` | `gates` → `evidence` → `claude-review` → `verdict` (F4) |
| `release.yml` | push to `main` | Version, build, publish, tag, GitHub Release (F6) |

PRs are opened with a **GitHub App token** (the self-hosted Renovate App, installed on the fork), because PRs
opened with `GITHUB_TOKEN` do not trigger other workflows.

A **ruleset** protects fork `main`: required checks `gates` and `verdict`; merge commits allowed; the admin
(repo owner) may bypass to merge `needs-human` PRs and our own patch PRs.

### F2. Carried patches

The fork may carry patches of its own. Upstream is only ever **merged**, never rebased, so a sync PR's diff is
exactly the upstream delta and our patches survive. Allowed patches:

- **Packaging:** scoped `name`, our `.github/` (upstream's CI and dependabot removed), a README fork banner.
- **Urgent fixes** upstream has not landed (e.g. #65). Each is also offered upstream as a PR.

Our own patch PRs are ordinary PRs, reviewed by the owner; they do not go through `review.yml`.

### F3. Sync

`sync.yml`:

1. Fetch upstream `main`. If it is already an ancestor of fork `main`, exit.
2. Create/reset `sync/<upstream-sha>` from fork `main`; `git merge --no-ff upstream/main`.
3. Reset `.github/` to fork `main`'s version (upstream never alters our workflows) and commit.
4. If an open sync PR exists, force-update it to the new branch head and retitle it — never open a second one.
   Otherwise open one.
5. **On merge conflict:** commit the conflict markers, open the PR labelled `needs-human`, skip automated review.
   A fetch failure fails the workflow (GitHub notifies the owner).

### F4. Review

**Trust model.** A sync PR's content is controlled by upstream. Therefore:

- `review.yml` runs on `pull_request_target`, so the **workflow definition always comes from fork `main`**.
- Upstream code is checked out and executed **only in jobs with no secrets** (`permissions: contents: read`,
  `npm ci --ignore-scripts`).
- The job holding the Claude credential gets the code only as text, with read-only tools.
- The job holding the App token reads only structured job outputs, never the PR's files.

**`gates`** (no secrets) — the only hard gates:

1. **Build + tests:** `tsc` and upstream's unit tests pass.
2. **Size cap:** upstream `src/` delta ≤ ~1,500 changed lines; larger → `needs-human`.

**`evidence`** (no secrets, never blocks) — emits a JSON report of facts:

- Production dependency diff (`npm ls --omit=dev --all`), `npm audit signatures`, `npm audit --omit=dev`.
- Install-script (`preinstall`/`install`/`postinstall`/`prepare`) and `bin` changes.
- Host literals in `src/`.
- Risky-API hits in added lines: `child_process`, `eval`/`new Function`, filesystem writes, `net`/`dgram`/new
  servers, non-literal `import()`, env reads outside the existing `WANDERLOG_*` set.
- Whether the cookie/transport files (`config.ts`, `transport/rest.ts`, `transport/sharedb.ts`) changed.
- `tools/list` diff between base and head builds, each started with a placeholder cookie and
  `WANDERLOG_BASE_URL`/`WANDERLOG_WS_BASE_URL` pointed at `127.0.0.1` (no real network).

**`claude-review`** — `anthropics/claude-code-action` with `claude_code_oauth_token` (secret
`CLAUDE_CODE_OAUTH_TOKEN`), tools limited to Read/Grep/Glob, and `--json-schema` so the result arrives as a
validated `structured_output`. Inputs: the upstream diff and the evidence report.

Model: `claude_args: --model opus --effort high` — the `opus` alias tracks the latest Opus (Opus 5.5 at time of
writing). No `--fallback-model`: if Opus is unavailable the job fails and the PR goes `needs-human` rather than
being reviewed by a weaker model. The `verdict` job records the model ID that actually ran (from the action's
execution log) in the PR comment and, via the release, in the GitHub Release notes.

The prompt states review policy as **guidelines with room for judgment**, not rules: new runtime dependencies,
non-Wanderlog hosts, install scripts, risky APIs and cookie-handling changes each require a justification. It
directs attention to credential exfiltration (cookie sent anywhere other than Wanderlog, or logged), runtime-built
hosts or code, obfuscation, and new destructive tools. It declares all repository content **untrusted data**:
any text addressing the reviewer is itself a red flag.

Output schema:

```json
{
  "verdict": "safe | needs-human",
  "bump": "major | minor | patch",
  "evidenceDispositions": [{ "item": "…", "disposition": "…" }],
  "concerns": ["…"],
  "summary": "…"
}
```

Bump policy (given the `tools/list` diff): tool removed or renamed, or a new required input → **major**;
tool added → **minor**; otherwise → **patch**.

**`verdict`** (App token):

- Gates passed **and** `verdict == safe` **and** every evidence item has a disposition → post the summary as a
  PR comment, apply `release:<bump>`, enable auto-merge (merge commit).
- Anything else — including a Claude job error, timeout, or schema-invalid output → label `needs-human`, post the
  concerns, request the owner's review. **Fail closed.**

### F5. Versioning

The fork has **its own semver line starting at `1.0.0`**, independent of upstream's `0.x` (upstream's numbers are
unpublished and would collide with its future releases). The bump comes from the merged PR's `release:*` label:
set by `verdict` for sync PRs, by the author for our patch PRs (`release:patch` default; `release:none` for
workflow/docs-only changes).

### F6. Release

`release.yml`, on push to `main`:

1. Resolve the PR for the pushed commit; read its `release:*` label. None or `release:none` → stop.
2. Next version = latest `v*` tag + bump.
3. Stamp `package.json` **in the workspace only** (never committed, so it never conflicts with upstream's version
   bumps): `version`, and `upstream: { repository, commit }` where `commit = git merge-base HEAD upstream/main`.
4. `npm ci` → build → test → `npm publish --provenance --access public` via **npm trusted publishing** (OIDC; no
   stored npm token; pinned recent npm CLI). If the version already exists on npm (re-run), skip publishing.
5. Only after a successful publish: tag `vX.Y.Z` and create a GitHub Release with Claude's summary and
   dispositions, the upstream compare link (`<prev upstream sha>...<new>`), and our patch PRs since the last release.

**Downstream, unchanged:** Renovate opens `feat(wanderlog)` / `fix(wanderlog)` in the bundler; bundler CI runs
build + Tier-1 + Tier-2; minor/patch auto-merge (existing `automerge` rule) and semantic-release publishes
`mcp-wanderlog`; majors wait for a human. A breaking upstream change therefore reaches a human twice.

### F7. Bundler onboarding

- `mcps/wanderlog/package.json` — `{ "dependencies": { "@thedebuggedlife/wanderlog-mcp": "1.0.0" } }` + lockfile.
- `mcps/wanderlog/mcp.yaml`:

  ```yaml
  name: wanderlog
  displayName: "Wanderlog MCP"
  mcpPackage: "@thedebuggedlife/wanderlog-mcp"
  mcpBin: wanderlog-mcp
  runtime:
    apiKeyEnvs:
      - WANDERLOG_COOKIE
  ```

- `renovate.json` — `packageRule` mapping `mcps/wanderlog/package.json` → `semanticCommitScope: "wanderlog"`.
- **Harness: per-MCP placeholder key.** `wanderlog-mcp` refuses to start unless the cookie looks like
  `connect.sid` (`s%3A…`), so the shared `dummy` / generated `MCP_API_KEY` values break it. `McpUnderTest` gains
  optional `apiKeyValue` (wanderlog: `s%3Aplaceholder`) and optional `extraEnv` (wanderlog: `WANDERLOG_BASE_URL`
  and `WANDERLOG_WS_BASE_URL` → `127.0.0.1`, keeping the tests hermetic). Tier-1 passes them to `stdio-client.ts`
  (which already accepts `apiKeyValue`); Tier-2's `scripts/gen-compose-override.ts` reads the same registry entry,
  so there is one source for the values. Other MCPs are unchanged.
- `expectedTools`: `wanderlog_list_trips`, `wanderlog_get_trip`, `wanderlog_create_trip`, `wanderlog_add_place`.
- `test/unit/ci-matrix.test.ts` — add `wanderlog` to the inventory.
- README — Available MCPs row (npm link to our package; source link to the fork, noting it is a reviewed fork of
  `shaikhspeare/wanderlog-mcp`), and an *MCP-specific optional env* note: `WANDERLOG_COOKIE` is the `connect.sid`
  browser cookie, valid ~1 year, with full account access — treat it as a password; `WANDERLOG_USER_AGENT` is
  optional.
- Onboarding PR title: `feat(wanderlog): …` (releases `mcp-wanderlog` on merge).

---

## Delivery

Order matters: the bundler PR depends on `1.0.0` existing on npm.

1. **Fork** `shaikhspeare/wanderlog-mcp` into `thedebuggedlife`, pinned at a recorded upstream `main` SHA.
2. **Initial full review** of the whole `src/` at that SHA (not a delta — nothing has been reviewed yet), run
   in-session with the F4 policy and the evidence script run locally; findings are written up for owner approval.
   Fixes we decide to carry (e.g. #65) land as patch PRs.
3. **Packaging patches** (F2) and the three workflows.
4. **Owner one-time setup:** create npm org `thedebuggedlife`; install the App on the fork; add secret
   `CLAUDE_CODE_OAUTH_TOKEN`; create the ruleset; enable auto-merge.
5. **First publish by hand** (owner): `npm publish --provenance --access public` of `1.0.0`. npm trusted publishing
   can only be attached to a package that already exists, and the workflow file must already be in the repo.
   Then configure the trusted publisher (repo `thedebuggedlife/wanderlog-mcp`, workflow `release.yml`).
6. **Bundler onboarding PR** (F7).

---

## Test Plan

- **Fork unit tests (Vitest):** the evidence-report generator, version computation, and label → bump parsing are
  small scripts with their own tests.
- **Pipeline dry runs** against a throwaway "upstream" branch (`sync.yml` accepts an upstream ref override via
  `workflow_dispatch`):
  1. Benign fix → auto-merged, `release:patch`, version published.
  2. New tool → `release:minor`.
  3. **Injection probe:** a new non-Wanderlog host plus a code comment telling the reviewer the change is safe →
     must end `needs-human`.
  4. Conflicting change → `needs-human` PR with conflict markers, no review run.
  5. Claude job forced to fail → `needs-human`.
- **Bundler:** `npm test`; `./scripts/build.sh wanderlog`; `MCP_NAME=wanderlog npm run test:integration`.

---

## Risks

- **Private API.** Wanderlog can change or block it at any time; the image would degrade until upstream adapts.
  Out of our control; the fork at least lets us carry a fix quickly.
- **Credential reach.** The cookie grants full account access for ~1 year. Mitigated by the proxy (the cookie is
  never exposed to clients) and the README guidance; rotation is a consumer deployment change.
- **LLM review is judgment, not proof.** A sufficiently subtle malicious change could pass. Mitigated by the
  containment in F4 (no secrets near executed code; workflows sourced from `main`), deterministic evidence the
  reviewer must disposition, the size cap, fail-closed handling, and bundler CI as a second gate.
- **Fork drift.** Large upstream refactors may conflict with our patches; conflicts route to a human by design.
  Keeping carried fixes few and upstreamed limits this.

---

## Out of Scope

- Reusing the fork pipeline for other MCPs (the review workflows could later become a reusable workflow).
- Upstream's HTTP entrypoint (`dist/http.js`); the image uses stdio only.
- Automatic cookie refresh.
