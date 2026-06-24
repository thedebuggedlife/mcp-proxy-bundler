import { afterAll, beforeAll, expect, test } from 'vitest'
import { connectBakedMcp, type BakedMcpClient } from './helpers/stdio-client.ts'
import { mcpUnderTest } from './helpers/mcp-under-test.ts'

const mcp = mcpUnderTest()

let conn: BakedMcpClient

beforeAll(async () => {
  conn = await connectBakedMcp({
    image: mcp.image,
    mcpBin: mcp.mcpBin,
    apiKeyEnv: mcp.apiKeyEnv,
  })
})

afterAll(async () => {
  await conn?.close()
})

test(`baked ${mcp.name} MCP answers initialize + tools/list with a dummy key`, async () => {
  const result = await conn.client.listTools()
  const names = result.tools.map((t) => t.name)

  expect(names.length).toBeGreaterThan(0)
  for (const expected of mcp.expectedTools) {
    expect(names).toContain(expected)
  }
})
