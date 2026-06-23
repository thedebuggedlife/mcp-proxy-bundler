import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(moduleDir, '..')

export function discoverMcps(mcpsDir: string = join(repoRoot, 'mcps')): string[] {
  let entries: string[]
  try {
    entries = readdirSync(mcpsDir)
  } catch {
    return []
  }
  return entries
    .filter((name) => {
      const yamlPath = join(mcpsDir, name, 'mcp.yaml')
      try {
        return statSync(yamlPath).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(discoverMcps())}\n`)
}
