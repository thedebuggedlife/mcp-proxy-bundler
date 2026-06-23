import { describe, expect, it } from 'vitest'
import { loadMcpConfig } from '../../scripts/lib/mcp-config.ts'

describe('hevy mcp config', () => {
  it('loads and normalizes mcps/hevy', () => {
    const config = loadMcpConfig('hevy')
    expect(config).toEqual({
      name: 'hevy',
      mcpPackage: 'hevy-mcp',
      mcpBin: 'hevy-mcp',
      displayName: 'Hevy MCP',
      nodeVersion: undefined,
      apiKeyEnv: 'HEVY_API_KEY',
      telemetryHosts: ['o4508975499575296.ingest.de.sentry.io'],
    })
  })
})
