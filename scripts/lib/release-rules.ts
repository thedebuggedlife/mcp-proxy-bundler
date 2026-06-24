// Hardened per-image release rules for @semantic-release/commit-analyzer.
//
// The analyzer applies the HIGHEST release type among ALL matching custom rules,
// and only falls back to the angular defaults (feat->minor, fix->patch,
// BREAKING->major) when NO custom rule matches. Two consequences drive the shape
// below:
//   1. `{ release: false }` must come FIRST as a deny-by-default catch-all. It
//      matches every commit; later, more-specific rules override it. (A trailing
//      catch-all would instead suppress everything, because `false` sorts higher
//      than any real release type.)
//   2. Since nothing falls through to the angular defaults now, the
//      BREAKING-change -> major rules are declared explicitly.
//
// Net effect: an unscoped or non-release-scoped conventional commit (e.g.
// `fix(ci):`, `chore:`, a bare `feat:`) no longer over-releases every image.
//
// Scopes that release (see CLAUDE.md for the authoring conventions):
//   - <mcp> (e.g. `hevy`, `todoist`) -> that one image. Renovate sets this for
//     MCP npm bumps.
//   - `proxy` / `node` -> the shared base, so EVERY image. Renovate sets these
//     for the Dockerfile FROM bumps.
//   - `image` -> a human-authored change to the built image's runtime
//     (Dockerfile non-FROM, entrypoint.sh, the schema shim, baked scripts) that
//     should rebuild EVERY image.
export function releaseRulesFor(name: string) {
  return [
    { release: false },
    { breaking: true, scope: name, release: 'major' },
    { breaking: true, scope: 'proxy', release: 'major' },
    { breaking: true, scope: 'node', release: 'major' },
    { breaking: true, scope: 'image', release: 'major' },
    { scope: name, type: 'feat', release: 'minor' },
    { scope: name, type: 'fix', release: 'patch' },
    { scope: 'proxy', type: 'feat', release: 'minor' },
    { scope: 'proxy', type: 'fix', release: 'patch' },
    { scope: 'node', type: 'feat', release: 'minor' },
    { scope: 'node', type: 'fix', release: 'patch' },
    { scope: 'image', type: 'feat', release: 'minor' },
    { scope: 'image', type: 'fix', release: 'patch' },
  ]
}
