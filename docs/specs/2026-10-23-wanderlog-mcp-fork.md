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
startup auth-probe retry (#51), and the fix for issue #65 (an unhandled rejection that crashed the process; the issue is still open but the code on `main` no longer has the bug).
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
| `sync.yml` | daily schedule + `workflow_dispatch` | Merges upstream `main` into the fixed branch `sync/upstream` and opens/updates the sync PR |
| `review.yml` | `pull_request_target` on `sync/*` | `static` (evidence, never runs PR code) + `exec` (build/test/`tools/list`) → `claude-review` → `verdict` (gates + decision) (F4) |
| `release.yml` | push to `main` | `build` (no privileges) → `publish` (OIDC): version, publish, tag, GitHub Release (F6) |

All fork tooling (scripts, prompt, schema, tests) lives under **`.github/fork/`** with its own `package.json`
(dev-only `vitest`; scripts use only Node built-ins and run under Node's TypeScript type-stripping), so it never
depends on upstream-controlled packages and is protected by the sync reset (F3).

PRs are opened with a **GitHub App token** (the self-hosted Renovate App, installed on the fork), because PRs
opened with `GITHUB_TOKEN` do not trigger other workflows. The App needs Contents, Pull requests, Commit
statuses and **Workflows** write (pushing upstream history that touches `.github/workflows` requires it).

A **ruleset** protects fork `main`: required **commit statuses** `fork/gates` and `fork/verdict`, which the
`verdict` job posts on the PR head SHA (explicit statuses, rather than relying on how `pull_request_target`
check runs attach to commits); merge commits allowed; the admin (repo owner) may bypass to merge `needs-human`
PRs and our own patch PRs.

### F2. Carried patches

The fork may carry patches of its own. Upstream is only ever **merged**, never rebased, so a sync PR's diff is
exactly the upstream delta and our patches survive. Allowed patches:

- **Packaging:** scoped `name`; `repository`/`homepage`/`bugs` pointing at the fork (npm provenance rejects a
  `repository.url` that does not match the publishing repo); our `.github/` (upstream's CI and dependabot
  removed); a README fork banner.
- **Fork-owned paths removed:** `CLAUDE.md`, `.claude/`, `.mcp.json` — Claude Code loads these as instructions
  from the review workspace, so upstream must never control them.
- **Urgent fixes** upstream has not landed. Each is also offered upstream as a PR. (#65 is already fixed on
  upstream `main` — `scheduleReconnect` now awaits `subscribe()` inside the caught chain — so no fix is carried
  for it; the initial review confirms.)

Our own patch PRs are ordinary PRs, reviewed by the owner; they do not go through `review.yml`.

### F3. Sync

`sync.yml`:

1. Fetch upstream `main`. If it is already an ancestor of fork `main`, exit.
2. Reset `sync/upstream` to fork `main`; `git merge --no-ff --no-commit <upstream sha>`.
3. Reset the **fork-owned paths** (`.github/`, `CLAUDE.md`, `.claude/`, `.mcp.json`) to fork `main`'s state
   inside the same merge commit, so upstream never alters our workflows or reviewer instructions.
4. Force-push `sync/upstream`. If an open sync PR exists, retitle it — never open a second one. Otherwise open one.
5. **On merge conflict:** commit the conflict markers; `review.yml` detects them deterministically, skips the
   Claude review, and routes the PR to `needs-human`. Conflicts that leave no markers (e.g. upstream deletes a file
   a carried patch modifies) are found by re-running `git merge-tree` on the merge's two parents in `static`.
   A fetch failure fails the workflow (GitHub notifies the owner).
6. **No re-rolls:** if `sync/upstream` already merges the current `main` and upstream SHA, the sync is a no-op, so
   an unchanged merge is never re-reviewed.

`workflow_dispatch` accepts `upstream_repo`/`upstream_ref` overrides and `dry_run`; a dry run uses the branch
`sync/dry-run`, and `verdict` never enables auto-merge on that branch.

### F4. Review

**Trust model.** A sync PR's content is controlled by upstream. Therefore:

- `review.yml` runs on `pull_request_target`, so the **workflow definition always comes from fork `main`**.
- Upstream code is checked out and executed **only in jobs with no secrets** (`permissions: contents: read`,
  `npm ci --ignore-scripts`).
- The job holding the Claude credential gets the code only as text, with read-only tools.
- The job holding the App token reads only structured job outputs, never the PR's files.
- Values derived from the PR (review text, branch names) reach `run:` steps only through `env:`, never by
  `${{ }}` interpolation into scripts.

**Artifact integrity.** Upstream code can run arbitrary commands wherever it executes (its build, its tests, its
own server for `tools/list`), so nothing it could have touched is trusted. Two separate jobs (separate runners),
both without secrets:

- **`static`** never executes PR code (`npm ci --ignore-scripts`, `npm ls`, `npm audit`, git diffs, file reads
  only). It produces the trusted `analysis` artifact: the diff, numstat, conflict list and evidence.
- **`exec`** runs the build, tests and `tools/list`. Its results are untrusted: the build/test outcomes are a
  sanity check (upstream controls its own tests by definition), and `tools.json` is used by the reviewer only to
  choose the version bump.

`verdict` evaluates the gates itself from the trusted `analysis` files plus `exec`'s build/test outcomes.

Hard gates — the only ones:

1. **Build + tests:** `tsc` and upstream's unit tests pass.
2. **Size cap:** upstream `src/` delta ≤ 1,500 changed lines; larger → `needs-human`.
3. **No conflict markers** outside the fork-owned paths (F3).

Evidence (never blocks) — a JSON report of facts, each item with a stable `id`:

- Production dependency diff (`npm ls --omit=dev --all`), `npm audit signatures`, `npm audit --omit=dev`.
- Lifecycle-script changes (`preinstall`/`install`/`postinstall`/`prepare`/`prepublish`/`prepublishOnly`/
  `prepack`/`postpack`/`publish`/`postpublish`) and `bin` changes.
- Hosts in `src/` that are new versus base, or not `wanderlog.com`/its subdomains/loopback.
- Risky-API hits in added lines: `child_process`, `eval`/`new Function`, filesystem writes, `net`/`dgram`/new
  servers, non-literal `import()`, env reads outside the existing `WANDERLOG_*` set.
- Whether the cookie/transport files (`config.ts`, `transport/rest.ts`, `transport/sharedb.ts`) or `.npmrc` changed.
- (From `exec`, untrusted, not an evidence item:) the `tools/list` diff between base and head builds, each
  started with a placeholder cookie and `WANDERLOG_BASE_URL`/`WANDERLOG_WS_BASE_URL` pointed at `127.0.0.1`
  (no real network).

**`claude-review`** — `anthropics/claude-code-action` with `claude_code_oauth_token` (secret
`CLAUDE_CODE_OAUTH_TOKEN`), tools limited to Read/Grep/Glob, and `--json-schema` so the result arrives as a
validated `structured_output`. Inputs: the upstream diff and the evidence report.

Workspace layout follows the action's `pull_request_target` guidance: fork `main` at the workspace root, the PR
head in `pr-head/` passed via `--add-dir`. Hardening: Bash/Write/Edit/Web tools disallowed; a deny rule on
reading `/proc`; and `verdict` redacts token-shaped strings (`sk-ant-…`, `gh?_…`) from everything it posts, so a
manipulated reviewer cannot publish a credential through its own output.

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
- `needs-human` is **sticky**: while the label is on the PR, `verdict` never auto-merges. The owner removes it and
  re-runs the workflow to re-arm automated review.

### F5. Versioning

The fork has **its own semver line starting at `1.0.0`**, independent of upstream's `0.x` (upstream's numbers are
unpublished and would collide with its future releases). The bump comes from the merged PR's `release:*` label:
set by `verdict` for sync PRs, by the author for our patch PRs (`release:patch` default; `release:none` for
workflow/docs-only changes). When several PRs merged since the last fork release tag (e.g. a queued release run
was cancelled), the bump is the maximum over all of them.

### F6. Release

No workflow uses any cache (`actions/cache`, or setup-node's implicit `package-manager-cache`, which is disabled
explicitly): `exec` runs PR code with the base branch's cache scope, so a cache would let it poison later jobs.

`release.yml`, on push to `main`, in two jobs so code never runs where publish credentials exist:

**`build`** (`contents: read` only):

1. Resolve the PR for the pushed commit; read its `release:*` label. None or `release:none` → stop.
2. Next version = latest `v*` tag + bump.
3. `npm ci --ignore-scripts` → build → test.
4. Stamp `package.json` **in the workspace only** (never committed, so it never conflicts with upstream's version
   bumps): `version`, and `upstream: { repository, commit }` where `commit = git merge-base HEAD upstream/main`.
5. `npm pack` → upload the tarball as an artifact.

**`publish`** (`id-token: write`, `contents: write`; runs no repo code):

1. `npm publish <tarball> --provenance --access public --ignore-scripts` via **npm trusted publishing** (OIDC; no
   stored npm token; pinned npm CLI ≥ 11.5.1). If the version already exists on npm (re-run), skip publishing.
2. Only after a successful publish: create the **annotated** tag `vX.Y.Z` (message `upstream-commit: <sha>`, which
   the next release reads to build its compare link) and a GitHub Release with Claude's summary and dispositions,
   the model that reviewed, the upstream compare link (`<prev upstream sha>...<new>`), and the first-parent
   commits since the last release.

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
  browser cookie, valid ~1 year, with full account access — treat it as a password; `WANDERLOG_USER_AGENT` and
  `WANDERLOG_DEFAULT_CURRENCY` are optional.
- Onboarding PR title: `feat(wanderlog): …` (releases `mcp-wanderlog` on merge).

---

## Delivery

Order matters: the bundler PR depends on `1.0.0` existing on npm.

1. **Fork** `shaikhspeare/wanderlog-mcp` into `thedebuggedlife`, pinned at a recorded upstream `main` SHA.
2. **Initial full review** of the whole `src/` at that SHA (not a delta — nothing has been reviewed yet), run
   in-session with the F4 policy and the evidence script run locally; findings are written up for owner approval.
   Fixes we decide to carry land as patch PRs.
3. **Packaging patches** (F2) and the three workflows.
4. **Owner one-time setup:** create npm org `thedebuggedlife`; install the App on the fork; add secret
   `CLAUDE_CODE_OAUTH_TOKEN`; create the ruleset; enable auto-merge.
5. **Placeholder publish by hand** (owner): npm trusted publishing can only be attached to a package that already
   exists, and provenance can only be generated in CI. So the owner publishes a throwaway
   `0.0.1-bootstrap.0` locally (`npm publish --access public --tag bootstrap`), configures the trusted publisher
   (repo `thedebuggedlife/wanderlog-mcp`, workflow `release.yml`), then deprecates the placeholder.
6. **First real release from CI:** `release.yml` also accepts `workflow_dispatch` with a `bump` input; dispatching
   it with no prior `v*` tag publishes **`1.0.0` with provenance**.
7. **Bundler onboarding PR** (F7).

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
