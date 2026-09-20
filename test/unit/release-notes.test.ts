import { describe, expect, it } from 'vitest'
import {
  aggregateReleaseNotes,
  type AggregateInput,
  type FetchLike,
} from '../../scripts/aggregate-release-notes.ts'
import { deriveChange } from '../../scripts/release-notes-from-commits.ts'

interface MockResponse {
  ok?: boolean
  status?: number
  json?: unknown
  text?: string
}

function mockFetch(routes: Record<string, MockResponse>): {
  fetch: FetchLike
  calls: string[]
} {
  const calls: string[] = []
  const fetch: FetchLike = async (url: string) => {
    calls.push(url)
    const route = routes[url]
    if (!route) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      }
    }
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      json: async () => route.json ?? {},
      text: async () => route.text ?? '',
    }
  }
  return { fetch, calls }
}

describe('aggregateReleaseNotes', () => {
  it('embeds proxy upstream notes for a proxy bump', async () => {
    const { fetch } = mockFetch({
      'https://api.github.com/repos/sigbit/mcp-auth-proxy/releases/tags/v2.11.0':
        {
          json: {
            name: 'v2.11.0',
            body: 'Fixed a TLS bug.\nAdded a flag.',
            html_url:
              'https://github.com/sigbit/mcp-auth-proxy/releases/tag/v2.11.0',
          },
        },
    })
    const input: AggregateInput = {
      kind: 'proxy',
      image: 'mcp-hevy',
      semver: '1.4.0',
      oldVersion: '2.10.2',
      newVersion: '2.11.0',
      labels: { proxyVersion: '2.11.0', nodeVersion: '26.3.1' },
    }
    const body = await aggregateReleaseNotes(input, { fetch })
    expect(body).toContain('# mcp-hevy 1.4.0 — proxy 2.10.2 → 2.11.0')
    expect(body).toContain('mcp-auth-proxy 2.11.0')
    expect(body).toContain('Fixed a TLS bug.')
    expect(body).toContain(
      'https://github.com/sigbit/mcp-auth-proxy/releases/tag/v2.11.0',
    )
    expect(body).toContain('proxy-version: `2.11.0`')
  })

  it('falls back to a link when the proxy release has no body', async () => {
    const { fetch } = mockFetch({}) // 404 for the release lookup
    const input: AggregateInput = {
      kind: 'proxy',
      image: 'mcp-hevy',
      semver: '1.3.1',
      newVersion: '2.10.3',
    }
    const body = await aggregateReleaseNotes(input, { fetch })
    expect(body).toContain('Upstream notes unavailable')
    expect(body).toContain(
      'https://github.com/sigbit/mcp-auth-proxy/releases/tag/v2.10.3',
    )
  })

  it('resolves the MCP repo via npm and embeds its GitHub release', async () => {
    const { fetch, calls } = mockFetch({
      'https://registry.npmjs.org/hevy-mcp': {
        json: {
          versions: {
            '1.26.0': {
              repository: {
                url: 'git+https://github.com/chrisdoc/hevy-mcp.git',
              },
            },
          },
        },
      },
      'https://api.github.com/repos/chrisdoc/hevy-mcp/releases/tags/v1.26.0': {
        json: {
          name: 'v1.26.0',
          body: 'New tool: get-foo.',
          html_url: 'https://github.com/chrisdoc/hevy-mcp/releases/tag/v1.26.0',
        },
      },
    })
    const input: AggregateInput = {
      kind: 'mcp',
      image: 'mcp-hevy',
      semver: '2.0.0',
      oldVersion: '1.25.5',
      newVersion: '1.26.0',
      mcpPackage: 'hevy-mcp',
      labels: { package: 'hevy-mcp', packageVersion: '1.26.0' },
    }
    const body = await aggregateReleaseNotes(input, { fetch })
    expect(body).toContain('# mcp-hevy 2.0.0 — mcp 1.25.5 → 1.26.0')
    expect(body).toContain('hevy-mcp 1.26.0')
    expect(body).toContain('New tool: get-foo.')
    expect(body).toContain('package-version: `1.26.0`')
    expect(calls).toContain('https://registry.npmjs.org/hevy-mcp')
  })

  it('links the npm version page when the MCP has no GitHub release', async () => {
    const { fetch } = mockFetch({
      'https://registry.npmjs.org/@doist/todoist-mcp': {
        json: {
          versions: {
            '10.4.0': {
              repository: 'github:Doist/todoist-mcp',
            },
          },
        },
      },
      // GitHub release lookups both 404
    })
    const input: AggregateInput = {
      kind: 'mcp',
      image: 'mcp-todoist',
      semver: '1.0.0',
      newVersion: '10.4.0',
      mcpPackage: '@doist/todoist-mcp',
    }
    const body = await aggregateReleaseNotes(input, { fetch })
    expect(body).toContain('Upstream notes unavailable')
    expect(body).toContain(
      'https://www.npmjs.com/package/@doist/todoist-mcp/v/10.4.0',
    )
    expect(body).toContain(
      'https://github.com/Doist/todoist-mcp/blob/HEAD/CHANGELOG.md',
    )
  })

  it('links the Node changelog for a node version bump', async () => {
    const { fetch } = mockFetch({})
    const input: AggregateInput = {
      kind: 'node',
      image: 'mcp-hevy',
      semver: '1.2.0',
      oldVersion: '26.3.1',
      newVersion: '26.4.0',
    }
    const body = await aggregateReleaseNotes(input, { fetch })
    expect(body).toContain('# mcp-hevy 1.2.0 — node 26.3.1 → 26.4.0')
    expect(body).toContain('Node.js 26.4.0')
    expect(body).toContain('https://github.com/nodejs/node/releases/tag/v26.4.0')
  })

  it('notes a digest-only node rebuild as a patch', async () => {
    const { fetch } = mockFetch({})
    const input: AggregateInput = {
      kind: 'node',
      image: 'mcp-hevy',
      semver: '1.1.1',
      oldVersion: '26.3.1',
      newVersion: '26.3.1',
    }
    const body = await aggregateReleaseNotes(input, { fetch })
    expect(body).toContain('Base OS layer rebuild')
    expect(body).toContain('new digest')
  })

  it('throws when kind is mcp but mcpPackage is missing', async () => {
    const { fetch } = mockFetch({})
    const input: AggregateInput = {
      kind: 'mcp',
      image: 'mcp-hevy',
      semver: '1.0.0',
      newVersion: '1.26.0',
    }
    await expect(aggregateReleaseNotes(input, { fetch })).rejects.toThrow(
      /mcpPackage is required/,
    )
  })

  it('links Microsoft’s servicing notes for a dotnet bump, stripping the distro suffix', async () => {
    const failingFetch: FetchLike = async (url) => {
      throw new Error(`unexpected fetch: ${url}`)
    }
    const body = await aggregateReleaseNotes(
      {
        kind: 'dotnet',
        image: 'mcp-immich',
        semver: '1.0.1',
        oldVersion: '10.0.12-noble',
        newVersion: '10.0.13-noble',
      },
      { fetch: failingFetch },
    )
    expect(body).toContain('# mcp-immich 1.0.1 — dotnet 10.0.12-noble → 10.0.13-noble')
    expect(body).toContain('### .NET 10.0.13')
    expect(body).toContain(
      'https://github.com/dotnet/core/blob/main/release-notes/10.0/10.0.13/10.0.13.md',
    )
  })

  it('notes a digest-only dotnet rebuild as a patch', async () => {
    const failingFetch: FetchLike = async (url) => {
      throw new Error(`unexpected fetch: ${url}`)
    }
    const body = await aggregateReleaseNotes(
      {
        kind: 'dotnet',
        image: 'mcp-immich',
        semver: '1.0.2',
        oldVersion: '10.0.13',
        newVersion: '10.0.13',
      },
      { fetch: failingFetch },
    )
    expect(body).toContain('Base OS layer rebuild (same .NET version, new digest) → patch.')
  })

  it('uses mcpRepo directly for a repo-tracked MCP and never queries npm', async () => {
    const { fetch } = mockFetch({
      'https://api.github.com/repos/barryw/ImmichMCP/releases/tags/v3.3.4': {
        json: {
          html_url: 'https://github.com/barryw/ImmichMCP/releases/tag/v3.3.4',
          body: 'Adds OCR search.',
        },
      },
    })
    const guardedFetch: FetchLike = async (url, init) => {
      if (url.includes('registry.npmjs.org')) {
        throw new Error(`unexpected npm request: ${url}`)
      }
      return fetch(url, init)
    }
    const body = await aggregateReleaseNotes(
      {
        kind: 'mcp',
        image: 'mcp-immich',
        semver: '1.1.0',
        newVersion: '3.3.4',
        mcpRepo: 'barryw/ImmichMCP',
        labels: {
          package: 'ghcr.io/barryw/immichmcp',
          packageVersion: '3.3.4',
          dotnetVersion: '10.0.12',
        },
      },
      { fetch: guardedFetch },
    )
    expect(body).toContain('### barryw/ImmichMCP 3.3.4')
    expect(body).toContain('Adds OCR search.')
    expect(body).toContain('- dotnet-version: `10.0.12`')
  })

  it('falls back to the GitHub release link when a repo-tracked MCP has no release body', async () => {
    const { fetch } = mockFetch({}) // both release-tag lookups (v3.3.4 and 3.3.4) 404
    const body = await aggregateReleaseNotes(
      {
        kind: 'mcp',
        image: 'mcp-immich',
        semver: '1.1.0',
        newVersion: '3.3.4',
        mcpRepo: 'barryw/ImmichMCP',
      },
      { fetch },
    )
    expect(body).toContain('https://github.com/barryw/ImmichMCP/releases/tag/v3.3.4')
    expect(body).not.toContain('npmjs.com')
  })
})

describe('deriveChange', () => {
  it('derives a proxy bump with from→to versions', () => {
    expect(
      deriveChange(
        [
          'fix(proxy): update ghcr.io/sigbit/mcp-auth-proxy Docker tag from v2.10.2 to v2.10.3',
        ],
        'hevy',
      ),
    ).toEqual({ kind: 'proxy', oldVersion: '2.10.2', newVersion: '2.10.3' })
  })

  it('derives a node bump with only a "to" version', () => {
    expect(
      deriveChange(['feat(node): update node Docker tag to v26.4.0'], 'hevy'),
    ).toEqual({ kind: 'node', oldVersion: undefined, newVersion: '26.4.0' })
  })

  it('maps the matching MCP scope to kind mcp', () => {
    expect(
      deriveChange(
        ['feat(hevy): update dependency hevy-mcp from 1.25.5 to 1.26.0'],
        'hevy',
      ),
    ).toEqual({ kind: 'mcp', oldVersion: '1.25.5', newVersion: '1.26.0' })
  })

  it('ignores another MCP scope (not this image)', () => {
    expect(
      deriveChange(
        ['feat(todoist): update dependency @doist/todoist-mcp to v10.4.0'],
        'hevy',
      ),
    ).toBeUndefined()
  })

  it('returns undefined when no recognizable upstream-bump commit exists', () => {
    expect(
      deriveChange(['docs: tidy README', 'chore: reformat'], 'hevy'),
    ).toBeUndefined()
  })

  it('maps the dotnet scope to kind dotnet for a dotnet image', () => {
    expect(
      deriveChange(
        ['fix(dotnet): update mcr.microsoft.com/dotnet/aspnet docker tag to v10.0.13-noble'],
        'immich',
        'dotnet',
      ),
    ).toEqual({ kind: 'dotnet', oldVersion: undefined, newVersion: '10.0.13-noble' })
  })

  it('ignores the dotnet scope for a node image', () => {
    expect(
      deriveChange(['fix(dotnet): update mcr.microsoft.com/dotnet/aspnet docker tag to v10.0.13-noble'], 'hevy'),
    ).toBeUndefined()
  })

  it('derives an image-tracked MCP bump from a Renovate docker-tag subject', () => {
    expect(
      deriveChange(['feat(immich): update ghcr.io/barryw/immichmcp docker tag to v3.4.0'], 'immich', 'dotnet'),
    ).toEqual({ kind: 'mcp', oldVersion: undefined, newVersion: '3.4.0' })
  })
})
