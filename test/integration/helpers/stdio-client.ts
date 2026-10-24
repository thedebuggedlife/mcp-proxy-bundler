import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export interface BakedMcpOptions {
  image: string
  apiKeyEnvs: string[]
  apiKeyValue?: string
  // Replaces an apiKeyEnv's value; entries not in apiKeyEnvs are passed as extra env.
  envOverrides?: Record<string, string>
}

export interface BakedMcpClient {
  client: Client
  close: () => Promise<void>
}

/**
 * Drives the baked MCP directly over stdio (proxy bypassed): `docker run -i --rm`
 * with the image's launcher as the entrypoint, wired to the SDK's StdioClientTransport.
 */
export async function connectBakedMcp(
  opts: BakedMcpOptions,
): Promise<BakedMcpClient> {
  const apiKeyValue = opts.apiKeyValue ?? 'dummy'

  const overrides = opts.envOverrides ?? {}
  const envArgs = [
    ...opts.apiKeyEnvs.flatMap((env) => [
      '-e',
      `${env}=${overrides[env] ?? apiKeyValue}`,
    ]),
    ...Object.entries(overrides)
      .filter(([name]) => !opts.apiKeyEnvs.includes(name))
      .flatMap(([name, value]) => ['-e', `${name}=${value}`]),
  ]

  const args = [
    'run',
    '-i',
    '--rm',
    ...envArgs,
    '--entrypoint',
    '/app/mcp-launch',
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
      `Failed to connect to baked MCP (${opts.image}): ${
        err instanceof Error ? err.message : String(err)
      }${stderr ? `\n--- child stderr ---\n${stderr}` : ''}`,
    )
  }

  return {
    client,
    close: () => client.close(),
  }
}
