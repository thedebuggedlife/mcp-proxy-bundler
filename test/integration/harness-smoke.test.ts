import { afterAll, expect, test } from 'vitest'
import {
  AUTHELIA_BASE_URL,
  PROXY_BASE_URL,
  createTestHttp,
  type TestHttp,
} from './helpers/http-client.ts'

// Proves the CI compose stack (Phase 7) is wired up: Authelia serves OIDC
// discovery and the proxy's HTTP listener is reachable on its published port.
// No proxy-auth semantics asserted here (those are Phases 8-9).

let http: TestHttp | undefined

afterAll(async () => {
  await http?.close()
})

function getHttp(): TestHttp {
  http ??= createTestHttp()
  return http
}

test('Authelia serves OIDC discovery', async () => {
  // Reached at authelia.test:9091 (the host the proxy uses) so Authelia's
  // issuer-by-host derivation succeeds; via the test agent (alias + test CA).
  const res = await getHttp().fetch(
    `${AUTHELIA_BASE_URL}/.well-known/openid-configuration`,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { issuer?: string; token_endpoint?: string }
  expect(body.issuer).toBeTruthy()
  expect(body.token_endpoint).toBeTruthy()
})

test('proxy listener is reachable and serves AS metadata', async () => {
  const res = await getHttp().fetch(
    `${PROXY_BASE_URL}/.well-known/oauth-authorization-server`,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    issuer?: string
    authorization_endpoint?: string
    token_endpoint?: string
    registration_endpoint?: string
  }
  expect(body.issuer).toBeTruthy()
  expect(body.authorization_endpoint).toBeTruthy()
  expect(body.token_endpoint).toBeTruthy()
  expect(body.registration_endpoint).toBeTruthy()
})
