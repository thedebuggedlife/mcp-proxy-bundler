import { describe, expect, it } from 'vitest'
import { loadMcpConfig } from '../../scripts/lib/mcp-config.ts'

describe('todoist mcp config', () => {
  it('loads and normalizes mcps/todoist (scoped package key)', () => {
    const config = loadMcpConfig('todoist')
    expect(config).toEqual({
      name: 'todoist',
      mcpPackage: '@doist/todoist-mcp',
      mcpBin: 'todoist-mcp',
      displayName: 'Todoist MCP',
      nodeVersion: undefined,
      apiKeyEnvs: ['TODOIST_API_KEY'],
      telemetryHosts: [],
    })
  })
})
