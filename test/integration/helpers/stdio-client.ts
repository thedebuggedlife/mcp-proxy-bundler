import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export interface BakedMcpOptions {
  image: string
  mcpBin: string
  apiKeyEnvs: string[]
  apiKeyValue?: string
}

export interface BakedMcpClient {
  client: Client
  close: () => Promise<void>
}

/**
 * Drives the baked MCP bin directly over stdio (proxy bypassed): `docker run -i --rm`
 * with the bin as the entrypoint, wired to the SDK's StdioClientTransport.
 */
export async function connectBakedMcp(
  opts: BakedMcpOptions,
): Promise<BakedMcpClient> {
  const apiKeyValue = opts.apiKeyValue ?? 'dummy'
  const binPath = `/app/node_modules/.bin/${opts.mcpBin}`

  const envArgs = opts.apiKeyEnvs.flatMap((env) => [
    '-e',
    `${env}=${apiKeyValue}`,
  ])

  const args = [
    'run',
    '-i',
    '--rm',
    ...envArgs,
    '--entrypoint',
    binPath,
    opts.image,
  ]

  const transport = new StdioClientTransport({
    command: 'docker',
    args,
    stderr: 'pipe',
  })

  const stderrChunks: string[] = []
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk.toString())
  })

  const client = new Client(
    { name: 'mcp-proxy-bundler-test', version: '0.0.0' },
    { capabilities: {} },
  )

  try {
    await client.connect(transport)
  } catch (err) {
    const stderr = stderrChunks.join('')
    throw new Error(
      `Failed to connect to baked MCP (${opts.image}, bin=${opts.mcpBin}): ${
        err instanceof Error ? err.message : String(err)
      }${stderr ? `\n--- child stderr ---\n${stderr}` : ''}`,
    )
  }

  return {
    client,
    close: () => client.close(),
  }
}
