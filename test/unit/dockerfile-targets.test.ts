import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8')

interface Stage {
  name: string
  base: string
  instructions: string[]
}

function parseStages(source: string): Stage[] {
  const logical = source
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  const stages: Stage[] = []
  for (const line of logical) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line)
    if (from) {
      stages.push({ name: from[2] ?? '', base: from[1], instructions: [] })
    } else {
      stages.at(-1)?.instructions.push(line)
    }
  }
  return stages
}

const stages = parseStages(dockerfile)
const runtimeTargets = stages.filter((s) => s.base === `${s.name}-upstream`)

describe('Dockerfile runtime targets', () => {
  it('has a node target built on the literal node-upstream stage', () => {
    expect(runtimeTargets.map((s) => s.name)).toContain('node')
    expect(stages.find((s) => s.name === 'node-upstream')?.base).toMatch(
      /^node:\d+\.\d+\.\d+-slim@sha256:[0-9a-f]{64}$/,
    )
  })

  it.each(runtimeTargets.map((s) => [s.name, s] as const))(
    'target %s takes the shared payload, bakes the launcher and ends hardened',
    (_name, stage) => {
      expect(stage.instructions).toContain('COPY --from=common / /')
      expect(
        stage.instructions.some(
          (i) => i.startsWith('RUN') && i.includes('> /app/mcp-launch'),
        ),
      ).toBe(true)
      expect(stage.instructions.slice(-2)).toEqual([
        'USER 1000:1000',
        'ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]',
      ])
    },
  )

  it('has a dotnet target built on the literal, noble-pinned ASP.NET stage', () => {
    expect(runtimeTargets.map((s) => s.name)).toContain('dotnet')
    expect(stages.find((s) => s.name === 'dotnet-upstream')?.base).toMatch(
      /^mcr\.microsoft\.com\/dotnet\/aspnet:\d+\.\d+\.\d+-noble@sha256:[0-9a-f]{64}$/,
    )
  })

  it('takes the dotnet MCP payload from the build-arg image, defaulting to scratch', () => {
    expect(dockerfile).toMatch(/^ARG MCP_IMAGE=scratch$/m)
    expect(stages.find((s) => s.name === 'mcp-image')?.base).toBe('${MCP_IMAGE}')
    const dotnet = stages.find((s) => s.name === 'dotnet')
    expect(dotnet?.instructions).toContain('COPY --from=mcp-image /app /app/mcp')
    expect(dotnet?.instructions).toContain('ENV DOTNET_EnableDiagnostics=0')
  })
})

describe('entrypoint.sh', () => {
  const entrypoint = readFileSync(join(repoRoot, 'entrypoint.sh'), 'utf8')

  it('launches the baked launcher and knows nothing about node_modules', () => {
    expect(entrypoint).toContain(
      'exec mcp-auth-proxy -- node /app/mcp-schema-shim.cjs /app/mcp-launch "$@"',
    )
    expect(entrypoint).not.toMatch(/MCP_BIN|node_modules/)
  })
})
