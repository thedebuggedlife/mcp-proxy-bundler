import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMcpConfig } from './mcp-config.ts'

export interface BuildMeta {
  name: string
  type: 'node'
  target: string
  upstream: string
  upstreamVersion: string
  launch: string
  nodeVersion: string
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const defaultMcpsDir = resolve(moduleDir, '..', '..', 'mcps')

function readPinnedVersion(pkgPath: string, mcpPackage: string): string {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const version = pkg.dependencies?.[mcpPackage]
  if (!version) {
    throw new Error(`Cannot resolve version for "${mcpPackage}" in ${pkgPath}`)
  }
  return version
}

export function buildMeta(
  name: string,
  mcpsDir: string = defaultMcpsDir,
): BuildMeta {
  const config = loadMcpConfig(name, mcpsDir)
  return {
    name: config.name,
    type: config.type,
    target: config.type,
    upstream: config.mcpPackage,
    upstreamVersion: readPinnedVersion(
      join(mcpsDir, name, 'package.json'),
      config.mcpPackage,
    ),
    launch: `/app/node_modules/.bin/${config.mcpBin}`,
    nodeVersion: config.nodeVersion ?? '',
  }
}
