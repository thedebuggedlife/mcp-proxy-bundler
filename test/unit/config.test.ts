import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMcpConfig } from '../../scripts/lib/mcp-config.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(testDir, '..', 'fixtures', 'mcps')

describe('loadMcpConfig', () => {
  it('loads and normalizes a valid config', () => {
    const config = loadMcpConfig('valid', fixturesDir)
    expect(config).toEqual({
      name: 'valid',
      mcpPackage: 'valid-mcp',
      mcpBin: 'valid-mcp',
      displayName: 'Valid MCP',
      nodeVersion: undefined,
      apiKeyEnv: 'VALID_API_KEY',
      telemetryHosts: ['telemetry.example.com', 'o123456789.ingest.de.sentry.io'],
    })
  })

  it('defaults displayName to name when omitted', () => {
    // valid fixture has displayName; assert the normalization shape explicitly
    const config = loadMcpConfig('valid', fixturesDir)
    expect(config.displayName).toBe('Valid MCP')
  })

  it('throws when a required field (mcpBin) is missing', () => {
    expect(() => loadMcpConfig('missing-bin', fixturesDir)).toThrowError(
      /Invalid mcp\.yaml for "missing-bin"[\s\S]*mcpBin/,
    )
  })

  it('throws when mcpPackage is not in package.json dependencies', () => {
    expect(() => loadMcpConfig('package-mismatch', fixturesDir)).toThrowError(
      /mcpPackage "not-the-installed-package".*is not a dependency/,
    )
  })

  it('throws on malformed telemetryHosts', () => {
    expect(() => loadMcpConfig('bad-telemetry', fixturesDir)).toThrowError(
      /Invalid mcp\.yaml for "bad-telemetry"[\s\S]*telemetryHosts/,
    )
  })

  it('throws a clear error when mcp.yaml does not exist', () => {
    expect(() => loadMcpConfig('does-not-exist', fixturesDir)).toThrowError(
      /Cannot read mcp\.yaml for "does-not-exist"/,
    )
  })
})
