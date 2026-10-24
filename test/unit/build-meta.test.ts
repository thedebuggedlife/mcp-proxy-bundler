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
      mcpImageRef: '',
      launch: '/app/node_modules/.bin/valid-mcp',
      nodeVersion: '',
    })
  })

  it('derives runtime-neutral metadata for a dotnet MCP', () => {
    expect(buildMeta('dotnet-valid', fixturesDir)).toEqual({
      name: 'dotnet-valid',
      type: 'dotnet',
      target: 'dotnet',
      upstream: 'ghcr.io/example/valid-mcp',
      upstreamVersion: '1.2.3',
      mcpImageRef:
        'ghcr.io/example/valid-mcp:v1.2.3@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      launch: 'dotnet /app/mcp/ValidMcp.dll --stdio',
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
