import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const hostnameRegex =
  /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/

export const McpConfigSchema = z
  .object({
    name: z.string().min(1),
    mcpPackage: z.string().min(1),
    mcpBin: z.string().min(1),
    displayName: z.string().min(1).optional(),
    nodeVersion: z.string().min(1).optional(),
    runtime: z
      .object({
        apiKeyEnv: z.string().min(1).optional(),
        telemetryHosts: z
          .array(z.string().regex(hostnameRegex, 'must be a valid hostname'))
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type McpConfig = z.infer<typeof McpConfigSchema>

export interface NormalizedMcpConfig {
  name: string
  mcpPackage: string
  mcpBin: string
  displayName: string
  nodeVersion?: string
  apiKeyEnv?: string
  telemetryHosts: string[]
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(moduleDir, '..', '..')

function formatZodError(name: string, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `  - ${path}: ${issue.message}`
    })
    .join('\n')
  return `Invalid mcp.yaml for "${name}":\n${issues}`
}

export function loadMcpConfig(
  name: string,
  mcpsDir: string = join(repoRoot, 'mcps'),
): NormalizedMcpConfig {
  const dir = join(mcpsDir, name)
  const yamlPath = join(dir, 'mcp.yaml')

  let rawYaml: string
  try {
    rawYaml = readFileSync(yamlPath, 'utf8')
  } catch {
    throw new Error(`Cannot read mcp.yaml for "${name}" at ${yamlPath}`)
  }

  let parsed: unknown
  try {
    parsed = parseYaml(rawYaml)
  } catch (err) {
    throw new Error(
      `Failed to parse YAML in ${yamlPath}: ${(err as Error).message}`,
    )
  }

  const result = McpConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(formatZodError(name, result.error))
  }
  const config = result.data

  const pkgPath = join(dir, 'package.json')
  let pkgRaw: string
  try {
    pkgRaw = readFileSync(pkgPath, 'utf8')
  } catch {
    throw new Error(`Cannot read package.json for "${name}" at ${pkgPath}`)
  }

  let pkg: { dependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(pkgRaw)
  } catch (err) {
    throw new Error(
      `Failed to parse JSON in ${pkgPath}: ${(err as Error).message}`,
    )
  }

  const deps = pkg.dependencies ?? {}
  if (!Object.prototype.hasOwnProperty.call(deps, config.mcpPackage)) {
    const depKeys = Object.keys(deps)
    throw new Error(
      `mcpPackage "${config.mcpPackage}" for "${name}" is not a dependency in ${pkgPath}. ` +
        `Found dependencies: [${depKeys.join(', ')}]`,
    )
  }

  return {
    name: config.name,
    mcpPackage: config.mcpPackage,
    mcpBin: config.mcpBin,
    displayName: config.displayName ?? config.name,
    nodeVersion: config.nodeVersion,
    apiKeyEnv: config.runtime?.apiKeyEnv,
    telemetryHosts: config.runtime?.telemetryHosts ?? [],
  }
}
