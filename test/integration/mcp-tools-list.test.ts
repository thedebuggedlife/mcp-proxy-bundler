import { afterAll, beforeAll, expect, test } from 'vitest'
import { connectBakedMcp, type BakedMcpClient } from './helpers/stdio-client.ts'

const IMAGE = process.env.IMAGE_UNDER_TEST ?? 'ghcr.io/thedebuggedlife/mcp-hevy:dev'

const EXPECTED_HEVY_TOOLS = [
  'get-workouts',
  'get-routines',
  'get-exercise-templates',
  'get-user-info',
]

let conn: BakedMcpClient

beforeAll(async () => {
  conn = await connectBakedMcp({
    image: IMAGE,
    mcpBin: 'hevy-mcp',
    apiKeyEnv: 'HEVY_API_KEY',
  })
})

afterAll(async () => {
  await conn?.close()
})

test('baked hevy MCP answers initialize + tools/list with a dummy key', async () => {
  const result = await conn.client.listTools()
  const names = result.tools.map((t) => t.name)

  expect(names.length).toBeGreaterThan(0)
  for (const expected of EXPECTED_HEVY_TOOLS) {
    expect(names).toContain(expected)
  }
})
