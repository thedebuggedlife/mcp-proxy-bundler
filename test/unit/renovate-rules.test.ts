import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverMcps } from '../../scripts/discover-mcps.ts'
import { loadMcpConfig } from '../../scripts/lib/mcp-config.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface PackageRule {
  matchManagers?: string[]
  matchFileNames?: string[]
  semanticCommitScope?: string
}

function renovatePackageRules(): PackageRule[] {
  const raw = readFileSync(join(repoRoot, 'renovate.json'), 'utf8')
  return (JSON.parse(raw).packageRules ?? []) as PackageRule[]
}

describe('renovate per-MCP scoping', () => {
  const rules = renovatePackageRules()
  const mcps = discoverMcps()

  // Guards the empty-each false-pass below: if discovery breaks, fail loudly
  // rather than register zero cases.
  it('discovers at least one MCP', () => {
    expect(mcps.length).toBeGreaterThan(0)
  })

  // Each MCP image releases ONLY on its own conventional-commit scope
  // (scripts/lib/release-rules.ts is deny-by-default). Renovate must tag that
  // MCP's upstream bump with semanticCommitScope=<name>, or the bump lands under a
  // non-release scope and no image is ever published. The tracked file and
  // manager depend on the MCP's type.
  it.each(mcps)('renovate.json scopes %s upstream bumps to that image', (name) => {
    const tracked =
      loadMcpConfig(name).type === 'dotnet'
        ? { manager: 'dockerfile', file: `mcps/${name}/upstream.Dockerfile` }
        : { manager: 'npm', file: `mcps/${name}/package.json` }
    const rule = rules.find(
      (r) =>
        (r.matchManagers ?? []).includes(tracked.manager) &&
        (r.matchFileNames ?? []).includes(tracked.file) &&
        r.semanticCommitScope === name,
    )
    expect(
      rule,
      `renovate.json needs a packageRule with matchManagers ["${tracked.manager}"], matchFileNames ["${tracked.file}"] and semanticCommitScope "${name}"`,
    ).toBeDefined()
  })
})
