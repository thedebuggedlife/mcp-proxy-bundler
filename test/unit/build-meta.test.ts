import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMeta } from '../../scripts/lib/build-meta.ts'

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'mcps',
)

describe('buildMeta', () => {
  it('derives runtime-neutral metadata for a node MCP', () => {
    expect(buildMeta('valid', fixturesDir)).toEqual({
      name: 'valid',
      type: 'node',
      target: 'node',
      upstream: 'valid-mcp',
      upstreamVersion: '1.0.0',
      launch: '/app/node_modules/.bin/valid-mcp',
      nodeVersion: '',
    })
  })

  it('resolves a real MCP from the repo mcps/ directory by default', () => {
    const meta = buildMeta('hevy')
    expect(meta.launch).toBe('/app/node_modules/.bin/hevy-mcp')
    expect(meta.upstream).toBe('hevy-mcp')
    expect(meta.upstreamVersion).toMatch(/^\d+\.\d+\.\d+/)
  })
})
