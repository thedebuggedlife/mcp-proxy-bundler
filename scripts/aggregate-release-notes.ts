// Aggregate the changed input's upstream release notes into a composite GitHub
// Release body (design Appendix B.4). The fetcher is injectable so the logic is
// unit-tested with mocked upstream responses and no live network.

export type ChangedKind = 'proxy' | 'node' | 'dotnet' | 'mcp'

export interface AggregateInput {
  kind: ChangedKind
  image: string // e.g. mcp-hevy
  semver: string // composite image version, e.g. 1.4.0
  oldVersion?: string
  newVersion: string
  // for kind === 'mcp': the npm package, or the GitHub repo of an MCP that is not on npm
  mcpPackage?: string
  mcpRepo?: string
  // OCI label values for traceability
  labels?: {
    proxyVersion?: string
    nodeVersion?: string
    dotnetVersion?: string
    package?: string
    packageVersion?: string
  }
}

export interface FetchLike {
  (url: string, init?: { headers?: Record<string, string> }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    text(): Promise<string>
  }>
}

export interface AggregateDeps {
  fetch: FetchLike
  githubToken?: string
}

interface GithubRelease {
  name?: string | null
  body?: string | null
  html_url?: string | null
}

function ghHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mcp-proxy-bundler-release-notes',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function fetchGithubRelease(
  deps: AggregateDeps,
  repo: string,
  tag: string,
): Promise<GithubRelease | undefined> {
  const res = await deps.fetch(
    `https://api.github.com/repos/${repo}/releases/tags/${tag}`,
    { headers: ghHeaders(deps.githubToken) },
  )
  if (!res.ok) return undefined
  return (await res.json()) as GithubRelease
}

function renderUpstreamBlock(
  heading: string,
  release: GithubRelease | undefined,
  fallbackLinks: string[],
): string {
  if (release && (release.body || release.html_url)) {
    const parts: string[] = [`### ${heading}`]
    if (release.html_url) parts.push(`Upstream release: ${release.html_url}`)
    if (release.body) parts.push('', release.body.trim())
    return parts.join('\n')
  }
  const parts: string[] = [`### ${heading}`]
  if (fallbackLinks.length > 0) {
    parts.push('Upstream notes unavailable; see:')
    for (const link of fallbackLinks) parts.push(`- ${link}`)
  } else {
    parts.push('Upstream notes unavailable.')
  }
  return parts.join('\n')
}

async function resolveMcpRepo(
  deps: AggregateDeps,
  mcpPackage: string,
  version: string,
): Promise<string | undefined> {
  const res = await deps.fetch(`https://registry.npmjs.org/${mcpPackage}`)
  if (!res.ok) return undefined
  const meta = (await res.json()) as {
    versions?: Record<
      string,
      { repository?: { url?: string } | string; homepage?: string }
    >
  }
  const v = meta.versions?.[version]
  if (!v) return undefined
  const repoUrl =
    typeof v.repository === 'string' ? v.repository : v.repository?.url
  const source = repoUrl ?? v.homepage
  if (!source) return undefined
  const githubUrl = source.match(/github\.com[/:]([^/]+\/[^/.#]+)/)
  if (githubUrl) return githubUrl[1]
  const shorthand = source.match(/^github:([^/]+\/[^/.#]+)/)
  return shorthand ? shorthand[1] : undefined
}

function renderLabels(labels?: AggregateInput['labels']): string {
  if (!labels) return ''
  const rows: string[] = []
  if (labels.proxyVersion) rows.push(`- proxy-version: \`${labels.proxyVersion}\``)
  if (labels.nodeVersion) rows.push(`- node-version: \`${labels.nodeVersion}\``)
  if (labels.dotnetVersion) rows.push(`- dotnet-version: \`${labels.dotnetVersion}\``)
  if (labels.package) rows.push(`- package: \`${labels.package}\``)
  if (labels.packageVersion)
    rows.push(`- package-version: \`${labels.packageVersion}\``)
  if (rows.length === 0) return ''
  return ['### Image metadata', ...rows].join('\n')
}

export async function aggregateReleaseNotes(
  input: AggregateInput,
  deps: AggregateDeps,
): Promise<string> {
  const range = input.oldVersion
    ? `${input.oldVersion} → ${input.newVersion}`
    : input.newVersion
  const heading = `# ${input.image} ${input.semver} — ${input.kind} ${range}`

  let block: string
  if (input.kind === 'proxy') {
    const release = await fetchGithubRelease(
      deps,
      'sigbit/mcp-auth-proxy',
      `v${input.newVersion}`,
    )
    block = renderUpstreamBlock(
      `mcp-auth-proxy ${input.newVersion}`,
      release,
      [
        `https://github.com/sigbit/mcp-auth-proxy/releases/tag/v${input.newVersion}`,
      ],
    )
  } else if (input.kind === 'node') {
    // Node has no GitHub Release body worth embedding inline; link the changelog.
    const isDigestOnly = input.oldVersion === input.newVersion
    const lines = [`### Node.js ${input.newVersion}`]
    if (isDigestOnly) {
      lines.push(
        'Base OS layer rebuild (same Node version, new digest) → patch.',
      )
    }
    lines.push(
      `- https://github.com/nodejs/node/releases/tag/v${input.newVersion}`,
    )
    block = lines.join('\n')
  } else if (input.kind === 'dotnet') {
    const version = input.newVersion.replace(/-[a-z].*$/i, '')
    const band = version.split('.').slice(0, 2).join('.')
    const lines = [`### .NET ${version}`]
    if (input.oldVersion === input.newVersion) {
      lines.push(
        'Base OS layer rebuild (same .NET version, new digest) → patch.',
      )
    }
    lines.push(
      `- https://github.com/dotnet/core/blob/main/release-notes/${band}/${version}/${version}.md`,
    )
    block = lines.join('\n')
  } else {
    const upstreamName = input.mcpPackage ?? input.mcpRepo
    if (!upstreamName) {
      throw new Error(
        'mcpPackage is required when kind === "mcp" (or mcpRepo for an MCP that is not on npm)',
      )
    }
    const repo =
      input.mcpRepo ??
      (await resolveMcpRepo(deps, upstreamName, input.newVersion))
    let release: GithubRelease | undefined
    if (repo) {
      release =
        (await fetchGithubRelease(deps, repo, `v${input.newVersion}`)) ??
        (await fetchGithubRelease(deps, repo, input.newVersion))
    }
    const fallbackLinks: string[] = []
    if (input.mcpPackage) {
      fallbackLinks.push(
        `https://www.npmjs.com/package/${input.mcpPackage}/v/${input.newVersion}`,
      )
    }
    if (repo) {
      fallbackLinks.push(
        input.mcpRepo
          ? `https://github.com/${repo}/releases/tag/v${input.newVersion}`
          : `https://github.com/${repo}/blob/HEAD/CHANGELOG.md`,
      )
    }
    block = renderUpstreamBlock(
      `${upstreamName} ${input.newVersion}`,
      release,
      fallbackLinks,
    )
  }

  const sections = [heading, block]
  const labelBlock = renderLabels(input.labels)
  if (labelBlock) sections.push(labelBlock)
  return sections.join('\n\n')
}

async function mainCli(): Promise<void> {
  const args = process.argv.slice(2)
  const opts: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '')
    const value = args[i + 1]
    if (key && value !== undefined) opts[key] = value
  }

  const required = ['kind', 'image', 'semver', 'newVersion']
  for (const key of required) {
    if (!opts[key]) {
      process.stderr.write(
        `Usage: aggregate-release-notes.ts --kind <proxy|node|dotnet|mcp> --image <name> --semver <v> --newVersion <v> [--oldVersion <v>] [--mcpPackage <pkg> | --mcpRepo <owner/repo>]\n`,
      )
      process.exit(2)
    }
  }

  const input: AggregateInput = {
    kind: opts.kind as ChangedKind,
    image: opts.image,
    semver: opts.semver,
    newVersion: opts.newVersion,
    oldVersion: opts.oldVersion,
    mcpPackage: opts.mcpPackage,
    mcpRepo: opts.mcpRepo,
    labels: {
      proxyVersion: opts.proxyVersion,
      nodeVersion: opts.nodeVersion,
      dotnetVersion: opts.dotnetVersion,
      package: opts.package,
      packageVersion: opts.packageVersion,
    },
  }

  const body = await aggregateReleaseNotes(input, {
    fetch: globalThis.fetch as unknown as FetchLike,
    githubToken: process.env.GITHUB_TOKEN,
  })
  process.stdout.write(body)
}

if (process.argv[1] && process.argv[1].endsWith('aggregate-release-notes.ts')) {
  mainCli()
}
