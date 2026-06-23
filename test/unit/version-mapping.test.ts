import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const renovate = JSON.parse(
  readFileSync(join(repoRoot, 'renovate.json'), 'utf8'),
) as RenovateConfig

interface PackageRule {
  matchManagers?: string[]
  matchDepNames?: string[]
  matchFileNames?: string[]
  matchUpdateTypes?: string[]
  semanticCommitType?: string
  semanticCommitScope?: string
  commitBody?: string
}

interface RenovateConfig {
  extends?: string[]
  enabledManagers?: string[]
  pinDigests?: boolean
  semanticCommits?: string
  packageRules?: PackageRule[]
}

interface Dep {
  manager: string
  depName: string
  fileName: string
  updateType: string
}

interface Resolved {
  type?: string
  scope?: string
  /** true when the resulting commit carries a `BREAKING CHANGE:` footer */
  breaking: boolean
}

// Mirrors Renovate's packageRules merge: every rule whose match* predicates all
// hold applies, in order, later rules overriding earlier ones for the same field.
function resolve(dep: Dep): Resolved {
  const out: Resolved = { breaking: false }
  for (const rule of renovate.packageRules ?? []) {
    if (rule.matchManagers && !rule.matchManagers.includes(dep.manager)) continue
    if (rule.matchDepNames && !rule.matchDepNames.includes(dep.depName)) continue
    if (rule.matchFileNames && !rule.matchFileNames.includes(dep.fileName))
      continue
    if (rule.matchUpdateTypes && !rule.matchUpdateTypes.includes(dep.updateType))
      continue
    if (rule.semanticCommitType !== undefined) out.type = rule.semanticCommitType
    if (rule.semanticCommitScope !== undefined)
      out.scope = rule.semanticCommitScope
    if (rule.commitBody !== undefined)
      out.breaking = /BREAKING CHANGE:/.test(rule.commitBody)
  }
  return out
}

const PROXY: Omit<Dep, 'updateType'> = {
  manager: 'dockerfile',
  depName: 'ghcr.io/sigbit/mcp-auth-proxy',
  fileName: 'Dockerfile',
}
const NODE: Omit<Dep, 'updateType'> = {
  manager: 'dockerfile',
  depName: 'node',
  fileName: 'Dockerfile',
}
const HEVY: Omit<Dep, 'updateType'> = {
  manager: 'npm',
  depName: 'hevy-mcp',
  fileName: 'mcps/hevy/package.json',
}

describe('renovate.json config shape', () => {
  it('enables only the docker + npm native managers', () => {
    expect(renovate.enabledManagers).toEqual(['dockerfile', 'npm'])
  })

  it('pins digests and emits conventional commits', () => {
    expect(renovate.pinDigests).toBe(true)
    expect(renovate.semanticCommits).toBe('enabled')
  })

  it('applies node Docker (LTS-only) versioning via the workaround preset', () => {
    expect(renovate.extends).toContain('workarounds:nodeDockerVersioning')
  })
})

describe('Appendix B.2 — Renovate → conventional-commit → bump mapping', () => {
  // proxy
  it('proxy major → feat(proxy) + BREAKING CHANGE footer → composite major', () => {
    expect(resolve({ ...PROXY, updateType: 'major' })).toEqual({
      type: 'feat',
      scope: 'proxy',
      breaking: true,
    })
  })

  it('proxy minor → feat(proxy) → composite minor', () => {
    expect(resolve({ ...PROXY, updateType: 'minor' })).toEqual({
      type: 'feat',
      scope: 'proxy',
      breaking: false,
    })
  })

  it('proxy patch → fix(proxy) → composite patch', () => {
    expect(resolve({ ...PROXY, updateType: 'patch' })).toEqual({
      type: 'fix',
      scope: 'proxy',
      breaking: false,
    })
  })

  it('proxy digest → fix(proxy) → composite patch', () => {
    expect(resolve({ ...PROXY, updateType: 'digest' })).toEqual({
      type: 'fix',
      scope: 'proxy',
      breaking: false,
    })
  })

  // node
  it('node major → feat(node) + BREAKING CHANGE footer → composite major', () => {
    expect(resolve({ ...NODE, updateType: 'major' })).toEqual({
      type: 'feat',
      scope: 'node',
      breaking: true,
    })
  })

  it('node minor → feat(node) → composite minor', () => {
    expect(resolve({ ...NODE, updateType: 'minor' })).toEqual({
      type: 'feat',
      scope: 'node',
      breaking: false,
    })
  })

  it('node patch → fix(node) → composite patch', () => {
    expect(resolve({ ...NODE, updateType: 'patch' })).toEqual({
      type: 'fix',
      scope: 'node',
      breaking: false,
    })
  })

  it('node digest-only → fix(node) → composite patch (D5 digest→patch)', () => {
    expect(resolve({ ...NODE, updateType: 'digest' })).toEqual({
      type: 'fix',
      scope: 'node',
      breaking: false,
    })
  })

  // MCP (hevy)
  it('MCP major → feat(hevy) + BREAKING CHANGE footer → composite major (that image only)', () => {
    expect(resolve({ ...HEVY, updateType: 'major' })).toEqual({
      type: 'feat',
      scope: 'hevy',
      breaking: true,
    })
  })

  it('MCP minor → feat(hevy) → composite minor (that image only)', () => {
    expect(resolve({ ...HEVY, updateType: 'minor' })).toEqual({
      type: 'feat',
      scope: 'hevy',
      breaking: false,
    })
  })

  it('MCP patch → fix(hevy) → composite patch (that image only)', () => {
    expect(resolve({ ...HEVY, updateType: 'patch' })).toEqual({
      type: 'fix',
      scope: 'hevy',
      breaking: false,
    })
  })

  it('MCP digest → fix(hevy) → composite patch (that image only)', () => {
    expect(resolve({ ...HEVY, updateType: 'digest' })).toEqual({
      type: 'fix',
      scope: 'hevy',
      breaking: false,
    })
  })
})
