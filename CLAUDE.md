# CLAUDE.md

Config-driven builder that publishes one hardened OCI image per MCP — `mcp-auth-proxy`
(the OAuth edge) bundled with a baked stdio MCP server — from declarative `mcps/<name>/`
config. See `README.md` for usage and `docs/specs/2026-06-22-mcp-proxy-bundler.md` for
the architecture.

## Releases & commit conventions

Releases are automated by **semantic-release**, run per image on every push to `main`
(`release.yml`). It reads **Conventional Commit messages on `main`** since each image's last
tag and decides the bump. The rules live in `scripts/lib/release-rules.ts` and are covered by
`test/unit/release-rules.test.ts` — change them there, not by hand in `release.config.js`.

**The commit that lands on `main` is what counts** — not the PR title. On a **squash merge**
the subject defaults to the PR title (multi-commit PR) or the single commit's subject
(one-commit PR), so for one-commit PRs pass an explicit `--subject` to keep it conventional.
(A non-conventional subject like `Phase 15: …` parses as no release.)

### Scopes that trigger a release

| Scope | Releases | Who writes it |
|-------|----------|---------------|
| `<mcp>` (e.g. `hevy`, `todoist`) | that one image | Renovate (MCP npm bump) |
| `proxy`, `node` | **every** image (shared base) | Renovate (Dockerfile `FROM` bump) |
| `image` | **every** image | **us**, for changes to the built image's runtime (Dockerfile non-`FROM`, `entrypoint.sh`, the schema shim, baked scripts) |

### Types

- `feat(<scope>):` → **minor**
- `fix(<scope>):` (and Renovate digest pins) → **patch**
- **major** → a `BREAKING CHANGE:` footer (Renovate appends one for major upstream bumps)

### Everything else does NOT release

Deny-by-default: a commit with **no scope** (`fix:`, `feat:`) or a **non-release scope**
(`ci:`, `test:`, `docs:`, `chore:`, `refactor:`, `build:`, …) triggers **no** image release.
Use these for repo plumbing (CI, tests, docs, the release config itself).

> Examples: a shared image-runtime fix → `fix(image): …` (rebuilds all images). A CI/workflow
> or test change → `ci: …` / `test: …` (no release). A hevy dependency bump → `fix(hevy): …`
> (Renovate-authored; only `mcp-hevy` releases).

## Build & test

- `npm run test:unit` — unit tests (Vitest)
- `./scripts/build.sh <mcp>` — build one image locally
- `MCP_NAME=<mcp> npm run test:integration` — full real-Authelia integration suite for one image
- Add a new MCP: drop `mcps/<name>/{package.json,package-lock.json,mcp.yaml}`, then register `<name>` in
  `renovate.json` (a `packageRule` scoping `mcps/<name>/package.json` bumps to `semanticCommitScope`
  `<name>`, else upstream bumps never release — guarded by `test/unit/renovate-rules.test.ts`),
  `test/integration/helpers/mcp-under-test.ts` (harness registry — apiKeyEnvs, stable `expectedTools`)
  and `test/unit/ci-matrix.test.ts` (inventory tripwire), and add a row to the README **Available MCPs**
  table. No Dockerfile or CI-workflow change is needed (the matrix auto-discovers `mcps/*`).

## Agent workflow (superpowers + Paseo)

These are declared preferences; they override the superpowers skills' defaults.

- **Worktrees are owned by Paseo** (`paseo.json` runs `npm ci` on creation; they live under
  `~/.paseo/worktrees/`). If already in a linked worktree, work there. Never use `EnterWorktree`
  or `git worktree add`. From the main checkout, create a Paseo worktree
  (`paseo worktree create --mode branch-off --new-branch <name>`, or `mcp__paseo__create_workspace`)
  and work in it — the main checkout may be shared with other agents. Don't run `npm install`
  in a worktree; if `node_modules` is missing, run `npm ci`.
- **Baseline / verification** is `npm test` (= `npm run test:unit`). Run the integration suite only
  for changes to the built image's runtime or to the harness itself. It is a **machine-wide
  singleton** (fixed compose project name and host ports 8080/9091) — never run two at once — and
  it reuses an existing `:dev` image, so run `./scripts/build.sh <mcp>` first or you may test an
  image built from another worktree.
- **Finishing a branch:** always push and open a PR; never merge into `main` locally. The PR
  title must be the conventional squash subject (see *Releases*), since that alone decides what
  releases. Commits on the branch use non-release types (`test:`, `refactor:`, `docs:`, `chore:`…).
  Archiving the worktree is done through Paseo, and deletes the branch — push first.
- **Specs** go in `docs/specs/YYYY-MM-DD-<feature>.md`, committed as `docs:` on the feature branch.
- **Plans** and other agent workflow artifacts **never** get committed into the tree.
