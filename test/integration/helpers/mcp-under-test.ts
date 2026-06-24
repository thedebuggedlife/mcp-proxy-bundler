// Per-MCP integration-test parameters, selected by MCP_NAME (the same env the
// integration wrapper / CI matrix sets). Keeps the test bodies MCP-agnostic so
// the matrix proves every image with one spec (Phase 15: config-only onboarding).

export interface McpUnderTest {
  name: string
  image: string
  mcpBin: string
  apiKeyEnv: string
  // A resilient subset of stable tool names (asserted as a contained-subset, not
  // exact equality, so upstream tool additions don't break the test).
  expectedTools: string[]
}

const REGISTRY = 'ghcr.io/thedebuggedlife'

const MCPS: Record<string, Omit<McpUnderTest, 'image'>> = {
  hevy: {
    name: 'hevy',
    mcpBin: 'hevy-mcp',
    apiKeyEnv: 'HEVY_API_KEY',
    expectedTools: [
      'get-workouts',
      'get-routines',
      'get-exercise-templates',
      'get-user-info',
    ],
  },
  todoist: {
    name: 'todoist',
    mcpBin: 'todoist-mcp',
    apiKeyEnv: 'TODOIST_API_KEY',
    expectedTools: ['find-tasks', 'add-tasks', 'find-projects', 'find-labels'],
  },
}

export function mcpUnderTest(): McpUnderTest {
  const name = process.env.MCP_NAME ?? 'hevy'
  const spec = MCPS[name]
  if (!spec) {
    throw new Error(
      `Unknown MCP_NAME "${name}". Known: ${Object.keys(MCPS).join(', ')}`,
    )
  }
  // The wrapper exports IMAGE_UNDER_TEST; fall back to the conventional dev tag.
  const image = process.env.IMAGE_UNDER_TEST ?? `${REGISTRY}/mcp-${name}:dev`
  return { ...spec, image }
}
