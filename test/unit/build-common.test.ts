import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8')
const hevyPkg = JSON.parse(
  readFileSync(join(repoRoot, 'mcps', 'hevy', 'package.json'), 'utf8'),
) as { dependencies: Record<string, string> }

function buildArgsFor(mcpName: string): string[] {
  const out = execFileSync(
    'bash',
    [
      '-euo',
      'pipefail',
      '-c',
      'source scripts/lib/build-common.sh; load_build_context; printf "%s\\n" "${BUILD_ARGS[@]}"',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, MCP_NAME: mcpName },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  return out.trimEnd().split('\n')
}

describe('build-common.sh load_build_context', () => {
  const args = buildArgsFor('hevy')
  const proxyVersion = /^FROM ghcr\.io\/sigbit\/mcp-auth-proxy:([^@\s]+)/m.exec(dockerfile)![1]
  const nodeVersion = /^FROM node:([^@\s]+?)-slim/m.exec(dockerfile)![1]

  it('selects the node target and passes the launch command', () => {
    expect(args).toEqual(
      expect.arrayContaining([
        '--target',
        'node',
        'MCP_DIR=mcps/hevy',
        'MCP_LAUNCH=/app/node_modules/.bin/hevy-mcp',
      ]),
    )
    expect(args[args.indexOf('--target') + 1]).toBe('node')
  })

  it('stamps the four OCI labels from the Dockerfile and package.json', () => {
    expect(args).toEqual(
      expect.arrayContaining([
        `io.thedebuggedlife.mcp.proxy-version=${proxyVersion}`,
        'io.thedebuggedlife.mcp.package=hevy-mcp',
        `io.thedebuggedlife.mcp.package-version=${hevyPkg.dependencies['hevy-mcp']}`,
        `io.thedebuggedlife.mcp.node-version=${nodeVersion}`,
      ]),
    )
  })

  it('fails for an MCP that does not exist', () => {
    expect(() => buildArgsFor('does-not-exist')).toThrowError()
  })
})
