import { analyzeCommits } from '@semantic-release/commit-analyzer'
import { describe, expect, test } from 'vitest'
import { releaseRulesFor } from '../../scripts/lib/release-rules.ts'

// Behavioral check: run the REAL commit-analyzer over a single crafted commit and
// return the release type it computes for `mcpName`'s per-image release run.
async function releaseTypeFor(
  mcpName: string,
  message: string,
  type: 'node' | 'dotnet' = 'node',
): Promise<string | null> {
  return analyzeCommits(
    { preset: 'angular', releaseRules: releaseRulesFor(mcpName, type) },
    { commits: [{ hash: 'deadbeef', message }], logger: { log() {} }, cwd: process.cwd() },
  ) as Promise<string | null>
}

describe('release rules — hevy run', () => {
  test('own MCP bump releases this image', async () => {
    expect(await releaseTypeFor('hevy', 'fix(hevy): update dependency hevy-mcp')).toBe('patch')
    expect(await releaseTypeFor('hevy', 'feat(hevy): add a tool')).toBe('minor')
  })

  test('shared proxy/node/image scopes release every image', async () => {
    expect(await releaseTypeFor('hevy', 'fix(proxy): pin digests')).toBe('patch')
    expect(await releaseTypeFor('hevy', 'feat(node): bump base')).toBe('minor')
    expect(await releaseTypeFor('hevy', 'fix(image): tweak entrypoint')).toBe('patch')
    expect(await releaseTypeFor('hevy', 'feat(image): add schema shim')).toBe('minor')
  })

  test('BREAKING CHANGE footer on a relevant scope -> major', async () => {
    expect(await releaseTypeFor('hevy', 'fix(proxy): bump\n\nBREAKING CHANGE: proxy v3')).toBe('major')
    expect(await releaseTypeFor('hevy', 'feat(image): rework\n\nBREAKING CHANGE: x')).toBe('major')
  })

  test('another MCP scope does NOT release this image (even when breaking)', async () => {
    expect(await releaseTypeFor('hevy', 'fix(todoist): update')).toBeNull()
    expect(await releaseTypeFor('hevy', 'feat(todoist): add')).toBeNull()
    expect(await releaseTypeFor('hevy', 'feat(todoist): add\n\nBREAKING CHANGE: x')).toBeNull()
  })

  test('unscoped / non-release scopes do NOT release (over-release hardened)', async () => {
    expect(await releaseTypeFor('hevy', 'fix: tidy up')).toBeNull()
    expect(await releaseTypeFor('hevy', 'feat: a thing')).toBeNull()
    expect(await releaseTypeFor('hevy', 'fix(ci): adjust workflow')).toBeNull()
    expect(await releaseTypeFor('hevy', 'chore(proxy): pin dependencies')).toBeNull() // chore type, not feat/fix
    expect(await releaseTypeFor('hevy', 'docs: update readme')).toBeNull()
  })
})

describe('release rules — parameterized by MCP name', () => {
  test('todoist run', async () => {
    expect(await releaseTypeFor('todoist', 'feat(todoist): add')).toBe('minor')
    expect(await releaseTypeFor('todoist', 'fix(hevy): update')).toBeNull()
    expect(await releaseTypeFor('todoist', 'fix(image): tweak')).toBe('patch')
  })
})

describe('release rules — dotnet scope', () => {
  test('a dotnet base bump releases a dotnet image', async () => {
    expect(await releaseTypeFor('immich', 'fix(dotnet): update aspnet digest', 'dotnet')).toBe('patch')
    expect(await releaseTypeFor('immich', 'feat(dotnet): bump base', 'dotnet')).toBe('minor')
    expect(
      await releaseTypeFor('immich', 'feat(dotnet): bump\n\nBREAKING CHANGE: x', 'dotnet'),
    ).toBe('major')
  })

  test('a dotnet base bump does NOT release a node image', async () => {
    expect(await releaseTypeFor('hevy', 'fix(dotnet): update aspnet digest')).toBeNull()
    expect(await releaseTypeFor('hevy', 'feat(dotnet): bump\n\nBREAKING CHANGE: x')).toBeNull()
  })

  test('a node base bump releases both (every image carries Node for the shim)', async () => {
    expect(await releaseTypeFor('hevy', 'fix(node): update digest')).toBe('patch')
    expect(await releaseTypeFor('immich', 'fix(node): update digest', 'dotnet')).toBe('patch')
  })

  test('a dotnet image still releases on its own scope and on proxy/image', async () => {
    expect(await releaseTypeFor('immich', 'feat(immich): update upstream image', 'dotnet')).toBe('minor')
    expect(await releaseTypeFor('immich', 'fix(proxy): pin digests', 'dotnet')).toBe('patch')
    expect(await releaseTypeFor('immich', 'fix(image): tweak entrypoint', 'dotnet')).toBe('patch')
    expect(await releaseTypeFor('immich', 'fix(hevy): update', 'dotnet')).toBeNull()
  })
})
