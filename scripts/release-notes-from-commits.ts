// Bridge for @semantic-release/exec generateNotesCmd: derive the changed input
// (proxy | node | dotnet | <mcp>) and old→new version from the conventional-commit
// scope + subject of the commits in this release, then call the upstream notes
// aggregator (design Appendix B.4). Emits the composite GitHub Release body to stdout.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aggregateReleaseNotes,
  type AggregateInput,
  type ChangedKind,
  type FetchLike,
} from './aggregate-release-notes.ts'
import { buildMeta } from './lib/build-meta.ts'
import { loadMcpConfig, type McpType } from './lib/mcp-config.ts'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(moduleDir, '..')

interface DerivedChange {
  kind: ChangedKind
  oldVersion?: string
  newVersion: string
  mcpPackage?: string
}

// Renovate commit subjects look like:
//   "chore(node): update node Docker tag to v26.4.0"
//   "fix(proxy): update ghcr.io/sigbit/mcp-auth-proxy Docker tag to v2.11.0"
//   "feat(hevy): update dependency hevy-mcp to v1.26.0"
//   "fix(dotnet): update mcr.microsoft.com/dotnet/aspnet docker tag to v10.0.13-noble"
// We extract the scope and a "from X to Y" / "to vY" version pair.
export function deriveChange(
  commitSubjects: string[],
  mcpName: string,
  type: McpType = 'node',
): DerivedChange | undefined {
  for (const subject of commitSubjects) {
    const scopeMatch = subject.match(/^[a-z]+\(([^)]+)\)[!]?:/i)
    if (!scopeMatch) continue
    const scope = scopeMatch[1].toLowerCase()
    const kind: ChangedKind | undefined =
      scope === 'proxy' || scope === 'node'
        ? scope
        : scope === 'dotnet' && type === 'dotnet'
          ? 'dotnet'
          : scope === mcpName
            ? 'mcp'
            : undefined
    if (!kind) continue

    const fromTo = subject.match(/from v?([\w.-]+) to v?([\w.-]+)/i)
    const toOnly = subject.match(/to v?([\w.-]+)/i)
    const newVersion = fromTo?.[2] ?? toOnly?.[1]
    if (!newVersion) continue

    return {
      kind,
      oldVersion: fromTo?.[1],
      newVersion,
    }
  }
  return undefined
}

function readDockerfileTags(): { proxy: string; node: string; dotnet?: string } {
  const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8')
  const proxy = dockerfile.match(
    /^FROM ghcr\.io\/sigbit\/mcp-auth-proxy:([^\s@]+)/m,
  )?.[1]
  const node = dockerfile
    .match(/^FROM node:([^\s@]+)/m)?.[1]
    ?.replace(/-slim$/, '')
  const dotnet = dockerfile
    .match(/^FROM mcr\.microsoft\.com\/dotnet\/aspnet:([^\s@]+)/m)?.[1]
    ?.replace(/-[a-z].*$/i, '')
  if (!proxy || !node) throw new Error('Could not parse Dockerfile FROM tags')
  return { proxy, node, dotnet }
}

// No usable range means a first release: nothing changed upstream, so unrelated history is not mined.
export function releaseLogArgs(range: string | undefined): string[] | undefined {
  return range && !range.startsWith('..')
    ? ['log', '--format=%s', range]
    : undefined
}

function commitsInRelease(): string[] {
  const args = releaseLogArgs(process.env.GIT_RANGE)
  if (!args) return []
  try {
    const out = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    return out.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  const mcpName = process.env.MCP_NAME
  if (!mcpName) throw new Error('MCP_NAME env var is required')
  const semver = process.env.NEXT_RELEASE_VERSION
  if (!semver) throw new Error('NEXT_RELEASE_VERSION env var is required')

  const config = loadMcpConfig(mcpName)
  const meta = buildMeta(mcpName)
  const tags = readDockerfileTags()
  const upstreamSource =
    config.type === 'dotnet'
      ? { mcpRepo: config.mcpRepo }
      : { mcpPackage: config.mcpPackage }

  const labels = {
    proxyVersion: tags.proxy,
    nodeVersion: tags.node,
    dotnetVersion: config.type === 'dotnet' ? tags.dotnet : undefined,
    package: meta.upstream,
    packageVersion: meta.upstreamVersion,
  }

  const derived = deriveChange(commitsInRelease(), mcpName, config.type)

  let input: AggregateInput
  if (derived) {
    input = {
      kind: derived.kind,
      image: `mcp-${mcpName}`,
      semver,
      oldVersion: derived.oldVersion,
      newVersion: derived.newVersion,
      ...(derived.kind === 'mcp' ? upstreamSource : {}),
      labels,
    }
  } else {
    // No recognizable upstream-bump commit (e.g. a manual change). Still emit a
    // traceable body with the current image metadata.
    input = {
      kind: 'mcp',
      image: `mcp-${mcpName}`,
      semver,
      newVersion: meta.upstreamVersion || semver,
      ...upstreamSource,
      labels,
    }
  }

  const body = await aggregateReleaseNotes(input, {
    fetch: globalThis.fetch as unknown as FetchLike,
    githubToken: process.env.GITHUB_TOKEN,
  })
  process.stdout.write(body)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`)
    process.exit(1)
  })
}
