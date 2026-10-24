import { describe, expect, it } from 'vitest'
import { discoverMcps } from '../../scripts/discover-mcps.ts'
import { loadMcpConfig } from '../../scripts/lib/mcp-config.ts'
import { TEST_DUMMY_ENV } from '../../scripts/lib/test-dummy-env.ts'
import { mcpTestSpec } from '../integration/helpers/mcp-under-test.ts'

describe('integration harness registry', () => {
  it.each(discoverMcps())('has a spec for %s whose apiKeyEnvs match mcp.yaml', (name) => {
    const spec = mcpTestSpec(name)
    expect(spec, `add "${name}" to test/integration/helpers/mcp-under-test.ts`).toBeDefined()
    expect(spec!.apiKeyEnvs).toEqual(loadMcpConfig(name).apiKeyEnvs)
    expect(spec!.expectedTools.length).toBeGreaterThan(0)
    // Tier-1 reads dummyEnv from the registry, Tier-2 reads TEST_DUMMY_ENV directly.
    expect(spec!.dummyEnv).toEqual(TEST_DUMMY_ENV[name])
  })

  it('returns undefined for an unknown MCP', () => {
    expect(mcpTestSpec('nope')).toBeUndefined()
  })
})
