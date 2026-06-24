import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createCookieFetch, type CookieFetch } from './helpers/cookie-fetch.ts'
import { PROXY_BASE_URL } from './helpers/http-client.ts'
import { mcpUnderTest } from './helpers/mcp-under-test.ts'
import { generatePkce, randomState } from './helpers/pkce.ts'
import { loadTestSecrets, type TestSecrets } from './helpers/test-secrets.ts'

// Tier-2 end-to-end OAuth handshake (D8): scripted Authelia first-factor login
// + consent -> upstream OIDC code -> proxy bearer token -> authenticated
// tools/list through /mcp. Proves the entire edge auth path, not just startup.
//
// Two legs, two schemes (Appendix A / Phase 7 observations):
//   - downstream (the proxy IS the OAuth AS for the MCP client): plain http on
//     localhost:8080. DCR at /.idp/register; authorize at /.idp/auth; token at
//     /.idp/token. The proxy advertises NO scopes (scopes_supported: []), so the
//     downstream authorize must NOT request 'openid' or it is rejected
//     invalid_scope. It also serves its own one-button authorize/consent form.
//   - upstream (the proxy is an OIDC RP to Authelia): TLS at authelia.test:9091.
//     Login is POST /api/firstfactor (with flow/flowID to get the OIDC
//     data.redirect), then explicit consent via POST /api/oidc/consent.
//
// The exact endpoint/payload shapes below were verified live against
// mcp-auth-proxy 2.10.2 + Authelia 4.39.20 (recorded in Phase 9 observations).

const REDIRECT_URI = 'http://localhost:8080/test-callback'
const AUTHELIA_ORIGIN = 'https://authelia.test:9091'

interface AsMetadata {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
}

const mcp = mcpUnderTest()

let http: CookieFetch
let secrets: TestSecrets

beforeAll(() => {
  http = createCookieFetch()
  secrets = loadTestSecrets()
})

afterAll(async () => {
  await http?.close()
})

async function getJson(res: Awaited<ReturnType<CookieFetch['fetch']>>) {
  return res.json() as Promise<Record<string, unknown>>
}

// Walk 3xx hops on the proxy edge until a non-redirect or the first Location
// that points at Authelia (where the scripted login must take over). Returns the
// last Location seen (the Authelia login URL) or the final response.
async function followUntilAuthelia(
  startUrl: string,
): Promise<{ autheliaUrl: string | undefined; lastUrl: string }> {
  let url = startUrl
  let res = await http.fetch(url)
  for (let i = 0; i < 12; i++) {
    if (res.status < 300 || res.status >= 400) break
    const loc = res.headers.get('location')
    if (!loc) break
    const next = new URL(loc, url)
    if (next.origin === AUTHELIA_ORIGIN && next.searchParams.has('flow_id')) {
      return { autheliaUrl: next.toString(), lastUrl: url }
    }
    url = next.toString()
    res = await http.fetch(url)
  }
  return { autheliaUrl: undefined, lastUrl: url }
}

// Follow 3xx hops until the downstream redirect_uri carries a code, or until the
// proxy's own one-button authorize form (/.idp/auth/<id>, a 200) which we submit.
async function followToDownstreamCode(startUrl: string): Promise<string> {
  let url = startUrl
  let res = await http.fetch(url)
  for (let i = 0; i < 14; i++) {
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) break
      const next = new URL(loc, url)
      const code = next.searchParams.get('code')
      if (next.href.startsWith(REDIRECT_URI) && code) return code
      url = next.toString()
      res = await http.fetch(url)
      continue
    }
    if (res.status === 200 && new URL(url).pathname.startsWith('/.idp/auth/')) {
      // The proxy's downstream authorize/consent page: a single Authorize button
      // posting back to the same URL. Submit it to get the downstream code.
      res = await http.fetch(url, { method: 'POST' })
      continue
    }
    break
  }
  throw new Error(
    `did not reach downstream code (last url ${url}, status ${res.status}): ${await res
      .clone()
      .text()
      .catch(() => '')}`,
  )
}

test('full OAuth handshake: Authelia login + consent -> proxy bearer -> authenticated tools/list', async () => {
  // 1. Discover AS metadata + Dynamic Client Registration (no scopes — the proxy
  //    advertises none and rejects 'openid' on the downstream authorize).
  const metaRes = await http.fetch(
    `${PROXY_BASE_URL}/.well-known/oauth-authorization-server`,
  )
  expect(metaRes.status).toBe(200)
  const metadata = (await metaRes.json()) as AsMetadata

  const dcrRes = await http.fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'mcp-proxy-bundler-e2e',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  expect(
    dcrRes.status,
    `DCR failed: ${dcrRes.status} ${await dcrRes.clone().text()}`,
  ).toBe(201)
  const { client_id: clientId } = (await getJson(dcrRes)) as {
    client_id: string
  }
  expect(clientId).toBeTruthy()

  // 2. Begin authorization-code + PKCE at the proxy authorize endpoint (no scope).
  const pkce = generatePkce()
  const state = randomState()
  const authorizeUrl = new URL(metadata.authorization_endpoint)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authorizeUrl.searchParams.set('code_challenge', pkce.challenge)
  authorizeUrl.searchParams.set('code_challenge_method', pkce.method)
  authorizeUrl.searchParams.set('state', state)

  const { autheliaUrl } = await followUntilAuthelia(authorizeUrl.toString())
  expect(
    autheliaUrl,
    'proxy authorize did not redirect to the Authelia login flow',
  ).toBeTruthy()
  const loginUrl = new URL(autheliaUrl as string)
  const flow = loginUrl.searchParams.get('flow') ?? 'openid_connect'
  const flowId = loginUrl.searchParams.get('flow_id') as string
  expect(flowId).toBeTruthy()

  // 3a. Scripted Authelia first-factor login (with flow context so it returns the
  //     OIDC continuation redirect rather than a bare OK).
  const ffRes = await http.fetch(`${AUTHELIA_ORIGIN}/api/firstfactor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      username: secrets.testUser,
      password: secrets.testPassword,
      keepMeLoggedIn: false,
      flowID: flowId,
      flow,
    }),
  })
  expect(
    ffRes.status,
    `firstfactor failed: ${ffRes.status} ${await ffRes.clone().text()}`,
  ).toBe(200)
  const ffBody = (await getJson(ffRes)) as {
    status: string
    data?: { redirect?: string }
  }
  expect(ffBody.status).toBe('OK')
  const oidcRedirect = ffBody.data?.redirect
  expect(oidcRedirect, 'firstfactor did not return an OIDC redirect').toBeTruthy()

  // 3b. Following the OIDC authorization lands on the consent step; approve it.
  let resumeUrl: string
  {
    const res = await http.fetch(oidcRedirect as string)
    const loc =
      res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    const onConsent =
      (loc && new URL(loc, oidcRedirect).pathname.startsWith('/consent')) ||
      new URL(oidcRedirect as string).pathname.startsWith('/consent')
    if (onConsent || loc?.includes('/consent')) {
      const consentRes = await http.fetch(`${AUTHELIA_ORIGIN}/api/oidc/consent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          flow,
          flow_id: flowId,
          client_id: secrets.oidcClientId,
          consent: true,
          claims: [],
          pre_configure: false,
        }),
      })
      expect(
        consentRes.status,
        `consent failed: ${consentRes.status} ${await consentRes.clone().text()}`,
      ).toBe(200)
      const consentBody = (await getJson(consentRes)) as {
        data?: { redirect_uri?: string }
      }
      resumeUrl = consentBody.data?.redirect_uri ?? (oidcRedirect as string)
    } else {
      // No consent required (pre-configured) — resume from where we are.
      resumeUrl = loc ? new URL(loc, oidcRedirect).toString() : (oidcRedirect as string)
    }
  }

  // 3c/4-prep. Resume the (now consent-approved) authorization: upstream code ->
  //     proxy callback -> proxy authorize form -> downstream code.
  const code = await followToDownstreamCode(resumeUrl)
  expect(code).toBeTruthy()

  // 4. Exchange the downstream code at the proxy token endpoint with the PKCE
  //    verifier.
  const tokenRes = await http.fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  expect(
    tokenRes.status,
    `token exchange failed: ${tokenRes.status} ${await tokenRes.clone().text()}`,
  ).toBe(200)
  const token = (await getJson(tokenRes)) as { access_token: string }
  expect(token.access_token).toBeTruthy()

  // 5. Call /mcp with the bearer token -> authenticated initialize + tools/list.
  const transport = new StreamableHTTPClientTransport(
    new URL(`${PROXY_BASE_URL}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${token.access_token}` },
      },
    },
  )
  const client = new Client(
    { name: 'mcp-proxy-bundler-e2e', version: '0.0.0' },
    { capabilities: {} },
  )
  try {
    await client.connect(transport)
    // Low-level tools/list request: returns the same result as the high-level
    // listTools() but skips its optional output-schema validator pre-compilation.
    // mcp-auth-proxy 2.10.2 rewrites a tool schema's `definitions` keyword to
    // `$defs` while leaving the `#/definitions/...` $ref targets intact (an
    // upstream proxy bug surfaced by todoist's get-overview schema), which makes
    // that pre-compilation throw. The auth path + tool names are what this test
    // asserts, so we read the tools directly.
    const { tools } = await client.request(
      { method: 'tools/list', params: {} },
      ListToolsResultSchema,
    )
    const names = tools.map((t) => t.name)
    expect(names.length).toBeGreaterThan(0)
    // Same tool subset asserted by the Tier-1 stdio test.
    for (const expected of mcp.expectedTools) {
      expect(names).toContain(expected)
    }
  } finally {
    await client.close()
  }
})
