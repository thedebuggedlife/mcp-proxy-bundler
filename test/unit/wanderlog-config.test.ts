import { describe, expect, it } from 'vitest'
import { loadMcpConfig } from '../../scripts/lib/mcp-config.ts'

describe('wanderlog mcp config', () => {
  it('loads and normalizes mcps/wanderlog (scoped fork package)', () => {
    expect(loadMcpConfig('wanderlog')).toEqual({
      name: 'wanderlog',
      type: 'node',
      mcpPackage: '@thedebuggedlife/wanderlog-mcp',
      mcpBin: 'wanderlog-mcp',
      displayName: 'Wanderlog MCP',
      nodeVersion: undefined,
      apiKeyEnvs: ['WANDERLOG_COOKIE'],
      telemetryHosts: [],
    })
  })
})
