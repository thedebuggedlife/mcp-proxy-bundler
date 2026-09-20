import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const hostnameRegex =
  /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/

export const LAUNCH_SAFE = /^[A-Za-z0-9._=:/@-]+$/

const launchSafe = z
  .string()
  .regex(LAUNCH_SAFE, 'may only contain A-Z a-z 0-9 . _ = : / @ -')

const commonFields = {
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  runtime: z
    .object({
      apiKeyEnvs: z.array(z.string().min(1)).optional(),
      telemetryHosts: z
        .array(z.string().regex(hostnameRegex, 'must be a valid hostname'))
        .optional(),
    })
    .strict()
    .optional(),
}

const NodeMcpSchema = z
  .object({
    ...commonFields,
    type: z.literal('node'),
    mcpPackage: z.string().min(1),
    mcpBin: launchSafe,
    nodeVersion: z.string().min(1).optional(),
  })
  .strict()

const DotnetMcpSchema = z
  .object({
    ...commonFields,
    type: z.literal('dotnet'),
    mcpImage: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._/-]*$/, 'must be an image name without a tag or digest'),
    mcpRepo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be a GitHub <owner>/<repo>'),
    mcpAssembly: launchSafe,
    mcpArgs: z.array(launchSafe).default([]),
  })
  .strict()

export const McpConfigSchema = z.preprocess(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !('type' in value)
      ? { ...value, type: 'node' }
      : value,
  z.discriminatedUnion('type', [NodeMcpSchema, DotnetMcpSchema]),
)

export type McpConfig = z.infer<typeof McpConfigSchema>
export type McpType = McpConfig['type']

interface NormalizedCommon {
  name: string
  displayName: string
  apiKeyEnvs: string[]
  telemetryHosts: string[]
}

export interface NormalizedNodeConfig extends NormalizedCommon {
  type: 'node'
  mcpPackage: string
  mcpBin: string
  nodeVersion?: string
}

export interface NormalizedDotnetConfig extends NormalizedCommon {
  type: 'dotnet'
  mcpImage: string
  mcpRepo: string
  mcpAssembly: string
  mcpArgs: string[]
  upstreamRef: string
  upstreamVersion: string
}

export type NormalizedMcpConfig = NormalizedNodeConfig | NormalizedDotnetConfig

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

export function parseUpstreamDockerfile(
  source: string,
): { image: string; tag: string; digest: string } | undefined {
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (lines.length !== 1) return undefined
  const match = /^FROM\s+([^\s@]+):([^\s@:]+)@(sha256:[0-9a-f]{64})$/.exec(
    lines[0],
  )
  return match
    ? { image: match[1], tag: match[2], digest: match[3] }
    : undefined
}

function assertNodeDependency(name: string, dir: string, mcpPackage: string): void {
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
  if (!Object.prototype.hasOwnProperty.call(deps, mcpPackage)) {
    throw new Error(
      `mcpPackage "${mcpPackage}" for "${name}" is not a dependency in ${pkgPath}. ` +
        `Found dependencies: [${Object.keys(deps).join(', ')}]`,
    )
  }
}

function readUpstreamPin(
  name: string,
  dir: string,
  mcpImage: string,
): { upstreamRef: string; upstreamVersion: string } {
  const pinPath = join(dir, 'upstream.Dockerfile')
  let source: string
  try {
    source = readFileSync(pinPath, 'utf8')
  } catch {
    throw new Error(`Cannot read upstream.Dockerfile for "${name}" at ${pinPath}`)
  }

  const pin = parseUpstreamDockerfile(source)
  if (!pin) {
    throw new Error(
      `upstream.Dockerfile for "${name}" must be exactly one line: FROM <image>:<tag>@sha256:<digest>`,
    )
  }
  if (pin.image !== mcpImage) {
    throw new Error(
      `mcpImage "${mcpImage}" for "${name}" does not match the image in ${pinPath}: "${pin.image}"`,
    )
  }
  return {
    upstreamRef: `${pin.image}:${pin.tag}@${pin.digest}`,
    upstreamVersion: pin.tag.replace(/^v/, ''),
  }
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

  const common: NormalizedCommon = {
    name: config.name,
    displayName: config.displayName ?? config.name,
    apiKeyEnvs: config.runtime?.apiKeyEnvs ?? [],
    telemetryHosts: config.runtime?.telemetryHosts ?? [],
  }

  if (config.type === 'dotnet') {
    return {
      ...common,
      type: 'dotnet',
      mcpImage: config.mcpImage,
      mcpRepo: config.mcpRepo,
      mcpAssembly: config.mcpAssembly,
      mcpArgs: config.mcpArgs,
      ...readUpstreamPin(name, dir, config.mcpImage),
    }
  }

  assertNodeDependency(name, dir, config.mcpPackage)
  return {
    ...common,
    type: 'node',
    mcpPackage: config.mcpPackage,
    mcpBin: config.mcpBin,
    nodeVersion: config.nodeVersion,
  }
}
