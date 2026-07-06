# CLAUDE.md

Config-driven builder that publishes one hardened OCI image per MCP — `mcp-auth-proxy`
(the OAuth edge) bundled with a baked stdio MCP server — from declarative `mcps/<name>/`
config. See `README.md` for usage and `ralph/projects/mcp-proxy-bundler/design.md` for the
architecture (local-only, not committed).

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
  `test/integration/helpers/mcp-under-test.ts` (harness registry — bin, apiKeyEnvs, stable `expectedTools`)
  and `test/unit/ci-matrix.test.ts` (inventory tripwire), and add a row to the README **Available MCPs**
  table. No Dockerfile or CI-workflow change is needed (the matrix auto-discovers `mcps/*`).
