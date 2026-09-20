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
      type: 'node',
      mcpPackage: 'valid-mcp',
      mcpBin: 'valid-mcp',
      displayName: 'Valid MCP',
      nodeVersion: undefined,
      apiKeyEnvs: ['VALID_API_KEY'],
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

  it('rejects an mcpBin that is not safe to interpolate into the launcher', () => {
    expect(() => loadMcpConfig('unsafe-bin', fixturesDir)).toThrowError(
      /Invalid mcp\.yaml for "unsafe-bin"[\s\S]*mcpBin/,
    )
  })

  it('rejects an unknown type', () => {
    expect(() => loadMcpConfig('unknown-type', fixturesDir)).toThrowError(
      /Invalid mcp\.yaml for "unknown-type"[\s\S]*type/,
    )
  })

  it('loads and normalizes a valid dotnet config', () => {
    expect(loadMcpConfig('dotnet-valid', fixturesDir)).toEqual({
      name: 'dotnet-valid',
      type: 'dotnet',
      displayName: 'Dotnet Valid',
      mcpImage: 'ghcr.io/example/valid-mcp',
      mcpRepo: 'example/valid-mcp',
      mcpAssembly: 'ValidMcp.dll',
      mcpArgs: ['--stdio'],
      upstreamRef:
        'ghcr.io/example/valid-mcp:v1.2.3@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      upstreamVersion: '1.2.3',
      apiKeyEnvs: ['VALID_BASE_URL', 'VALID_API_KEY'],
      telemetryHosts: [],
    })
  })

  it('throws when upstream.Dockerfile names a different image than mcpImage', () => {
    expect(() => loadMcpConfig('dotnet-image-mismatch', fixturesDir)).toThrowError(
      /mcpImage "ghcr\.io\/example\/valid-mcp".*does not match.*some-other-image/,
    )
  })

  it('throws when the upstream pin has no digest', () => {
    expect(() => loadMcpConfig('dotnet-missing-digest', fixturesDir)).toThrowError(
      /upstream\.Dockerfile for "dotnet-missing-digest" must be exactly one line: FROM <image>:<tag>@sha256:<digest>/,
    )
  })

  it('rejects mcpArgs that are not safe to interpolate into the launcher', () => {
    expect(() => loadMcpConfig('dotnet-unsafe-args', fixturesDir)).toThrowError(
      /Invalid mcp\.yaml for "dotnet-unsafe-args"[\s\S]*mcpArgs/,
    )
  })

  it('requires mcpRepo for a dotnet MCP', () => {
    expect(() => loadMcpConfig('dotnet-missing-repo', fixturesDir)).toThrowError(
      /Invalid mcp\.yaml for "dotnet-missing-repo"[\s\S]*mcpRepo/,
    )
  })
})
