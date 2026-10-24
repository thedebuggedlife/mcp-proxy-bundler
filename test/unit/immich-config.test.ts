import { describe, expect, it } from 'vitest'
import { loadMcpConfig } from '../../scripts/lib/mcp-config.ts'

describe('immich mcp config', () => {
  it('loads and normalizes mcps/immich as a dotnet MCP', () => {
    const config = loadMcpConfig('immich')
    expect(config).toMatchObject({
      name: 'immich',
      type: 'dotnet',
      displayName: 'Immich MCP',
      mcpImage: 'ghcr.io/barryw/immichmcp',
      mcpRepo: 'barryw/ImmichMCP',
      mcpAssembly: 'ImmichMCP.dll',
      mcpArgs: ['--stdio'],
      apiKeyEnvs: ['IMMICH_BASE_URL', 'IMMICH_API_KEY'],
      telemetryHosts: [],
    })
    if (config.type !== 'dotnet') throw new Error('expected a dotnet config')
    expect(config.upstreamVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(config.upstreamRef).toMatch(
      /^ghcr\.io\/barryw\/immichmcp:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
    )
  })
})
