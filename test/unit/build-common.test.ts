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

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []))
}

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
    expect(args[args.indexOf('--target') + 1]).toBe('node')
    expect(valuesAfter(args, '--build-arg')).toEqual([
      'MCP_DIR=mcps/hevy',
      'MCP_LAUNCH=/app/node_modules/.bin/hevy-mcp',
    ])
  })

  it('stamps the four OCI labels from the Dockerfile and package.json', () => {
    expect(valuesAfter(args, '--label')).toEqual([
      `io.thedebuggedlife.mcp.proxy-version=${proxyVersion}`,
      'io.thedebuggedlife.mcp.package=hevy-mcp',
      `io.thedebuggedlife.mcp.package-version=${hevyPkg.dependencies['hevy-mcp']}`,
      `io.thedebuggedlife.mcp.node-version=${nodeVersion}`,
    ])
  })

  it('fails for an MCP that does not exist', () => {
    expect(() => buildArgsFor('does-not-exist')).toThrowError()
  })
})

describe('build-common.sh load_build_context — dotnet MCP', () => {
  const args = buildArgsFor('immich')
  const pin = readFileSync(
    join(repoRoot, 'mcps', 'immich', 'upstream.Dockerfile'),
    'utf8',
  )
    .trim()
    .replace(/^FROM\s+/, '')
  const dotnetVersion = /^FROM mcr\.microsoft\.com\/dotnet\/aspnet:([^@\s]+?)-noble/m.exec(dockerfile)![1]

  it('selects the dotnet target and passes the pinned upstream image', () => {
    expect(args[args.indexOf('--target') + 1]).toBe('dotnet')
    expect(valuesAfter(args, '--build-arg')).toEqual([
      `MCP_IMAGE=${pin}`,
      'MCP_LAUNCH=dotnet /app/mcp/ImmichMCP.dll --stdio',
    ])
  })

  it('stamps the four shared labels plus dotnet-version', () => {
    const labels = valuesAfter(args, '--label')
    expect(labels).toHaveLength(5)
    expect(labels).toContain('io.thedebuggedlife.mcp.package=ghcr.io/barryw/immichmcp')
    expect(labels).toContain(
      `io.thedebuggedlife.mcp.package-version=${pin.split(':')[1].split('@')[0].replace(/^v/, '')}`,
    )
    expect(labels[4]).toBe(`io.thedebuggedlife.mcp.dotnet-version=${dotnetVersion}`)
  })
})
