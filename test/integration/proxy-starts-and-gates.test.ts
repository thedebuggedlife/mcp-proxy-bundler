import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  PROXY_BASE_URL,
  createTestHttp,
  type TestHttp,
} from './helpers/http-client.ts'
import {
  getProxyHealthStatus,
  getProxyLogs,
} from './helpers/proxy-container.ts'

// Tier-1 regression net (D8 #2-#4) against the running CI compose stack: the
// proxy initializes its OIDC provider against the REAL Authelia discovery URL
// with no x509/TLS panic (the missing-ca-certificates regression the precursor
// hit), serves OAuth AS metadata, and gates /mcp with a 401 (not a portal 302).

let http: TestHttp

beforeAll(() => {
  http = createTestHttp()
})

afterAll(async () => {
  await http?.close()
})

test('proxy started clean: healthy, listening, no x509/OIDC panic', async () => {
  // The proxy's HTTP listener only opens after its OIDC provider initialized
  // against Authelia AND the baked MCP child completed its stdio handshake
  // (Appendix A). A 'healthy' status therefore proves OIDC init succeeded with
  // no x509 panic; the log scan asserts it explicitly.
  const status = await getProxyHealthStatus()
  expect(status).toBe('healthy')

  const logs = await getProxyLogs()
  const failureMarkers = [
    /x509/i,
    /certificate signed by unknown authority/i,
    /\bpanic\b/i,
    /tls: failed/i,
  ]
  for (const marker of failureMarkers) {
    expect(
      marker.test(logs),
      `proxy log unexpectedly matched ${marker} — startup regression:\n${logs}`,
    ).toBe(false)
  }

  // The listener only logs this once OIDC init + the MCP handshake both
  // succeeded, so its presence is positive proof of a clean startup.
  expect(logs).toMatch(/Starting server/i)
})

test('GET /.well-known/oauth-authorization-server -> 200 with required endpoints', async () => {
  const res = await http.fetch(
    `${PROXY_BASE_URL}/.well-known/oauth-authorization-server`,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    authorization_endpoint?: string
    token_endpoint?: string
    registration_endpoint?: string
  }
  expect(body.authorization_endpoint).toBeTruthy()
  expect(body.token_endpoint).toBeTruthy()
  expect(body.registration_endpoint).toBeTruthy()
})

test('GET /mcp unauthenticated -> 401 (gate active, not a portal redirect)', async () => {
  const res = await http.fetch(`${PROXY_BASE_URL}/mcp`, { redirect: 'manual' })
  expect(res.status).toBe(401)
  // A portal would 3xx-redirect to a login page; the proxy must reject outright.
  expect(res.status).toBeGreaterThanOrEqual(400)
  expect(res.status).toBeLessThan(500)
})
