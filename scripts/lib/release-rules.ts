import type { McpType } from './mcp-config.ts'

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
//   - `proxy` / `node` -> the shared base, so EVERY image (every image carries
//     Node for the schema shim). Renovate sets these for the Dockerfile FROM bumps.
//   - `dotnet` -> the shared ASP.NET base, so every `type: dotnet` image only.
//   - `image` -> a human-authored change to the built image's runtime
//     (Dockerfile non-FROM, entrypoint.sh, the schema shim, baked scripts) that
//     should rebuild EVERY image.

export const SHARED_SCOPES: Record<McpType, string[]> = {
  node: ['proxy', 'image', 'node'],
  dotnet: ['proxy', 'image', 'node', 'dotnet'],
}

export function releaseRulesFor(name: string, type: McpType = 'node') {
  const scopes = [name, ...SHARED_SCOPES[type]]
  return [
    { release: false },
    ...scopes.map((scope) => ({ breaking: true, scope, release: 'major' })),
    ...scopes.flatMap((scope) => [
      { scope, type: 'feat', release: 'minor' },
      { scope, type: 'fix', release: 'patch' },
    ]),
  ]
}
