import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function genComposeOverride(name: string): string {
  return execFileSync(
    'node',
    ['scripts/gen-compose-override.ts', name],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

describe('gen-compose-override', () => {
  it('emits the per-MCP dummy value for immich alongside the interpolated API key', () => {
    const output = genComposeOverride('immich')
    expect(output).toContain("      IMMICH_BASE_URL: 'http://immich.invalid'\n")
    expect(output).toContain("      IMMICH_API_KEY: '${MCP_API_KEY}'\n")
  })

  it('leaves MCPs without a dummy override on the interpolated API key alone', () => {
    const output = genComposeOverride('hevy')
    expect(output).toContain("      HEVY_API_KEY: '${MCP_API_KEY}'\n")
    expect(output).not.toContain('immich.invalid')
  })
})
