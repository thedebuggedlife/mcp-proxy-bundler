import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMcpConfig } from './lib/mcp-config.ts'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(moduleDir, '..')

function readPackageVersion(name: string, mcpPackage: string): string {
  const pkgPath = join(repoRoot, 'mcps', name, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const version = pkg.dependencies?.[mcpPackage]
  if (!version) {
    throw new Error(
      `Cannot resolve version for "${mcpPackage}" in ${pkgPath}`,
    )
  }
  return version
}

function main(): void {
  const name = process.argv[2]
  if (!name) {
    process.stderr.write('Usage: mcp-meta.ts <mcp-name>\n')
    process.exit(2)
  }

  const config = loadMcpConfig(name)
  const packageVersion = readPackageVersion(name, config.mcpPackage)

  const meta = {
    name: config.name,
    mcpBin: config.mcpBin,
    mcpPackage: config.mcpPackage,
    packageVersion,
    nodeVersion: config.nodeVersion ?? '',
  }

  for (const [key, value] of Object.entries(meta)) {
    process.stdout.write(`${key}=${value}\n`)
  }
}

main()
