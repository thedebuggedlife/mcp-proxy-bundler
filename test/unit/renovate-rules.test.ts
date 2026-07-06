import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverMcps } from '../../scripts/discover-mcps.ts'

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
  // MCP's npm bump with semanticCommitScope=<name>, or the bump lands under a
  // non-release scope and no image is ever published. This enforces the mapping.
  it.each(mcps)('renovate.json scopes %s npm bumps to that image', (name) => {
    const rule = rules.find(
      (r) =>
        (r.matchFileNames ?? []).includes(`mcps/${name}/package.json`) &&
        r.semanticCommitScope === name,
    )
    expect(
      rule,
      `renovate.json needs a packageRule with matchFileNames ["mcps/${name}/package.json"] and semanticCommitScope "${name}"`,
    ).toBeDefined()
  })
})
