import { lookup as dnsLookup } from 'node:dns'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'

export { undiciFetch }

// Test HTTP client wiring for the CI compose stack.
//
// Authelia derives its OIDC issuer from the request host, so the test client
// must reach it at the same host the proxy uses ('authelia.test') rather than
// 'localhost'. That host only exists as a docker network alias, so we resolve
// it to 127.0.0.1 (the host-published port) via a custom undici connector, and
// trust the self-signed Authelia cert via the generated CA.

const moduleDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(moduleDir, '..', '..', '..')

const AUTHELIA_ALIAS = 'authelia.test'
const AUTHELIA_HOST_IP = '127.0.0.1'

function loadProxyCa(): string | undefined {
  const caPath = join(repoRoot, 'test', '.secrets', 'authelia', 'proxy-ca.crt')
  try {
    return readFileSync(caPath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * An undici Agent that (a) resolves the Authelia network-alias host to the
 * host-published port and (b) trusts the test CA. Pass to `fetch`/undici as
 * `dispatcher`.
 */
export function createTestAgent(): Agent {
  const ca = loadProxyCa()
  return new Agent({
    connect: {
      ca,
      rejectUnauthorized: ca !== undefined,
      // Map the Authelia alias to the host-published address; delegate any
      // other host to Node's default resolver. undici calls lookup with
      // { all: true }, so honor both the array and single-address callback forms.
      lookup: (hostname, options, callback) => {
        if (hostname === AUTHELIA_ALIAS) {
          if (options && (options as { all?: boolean }).all) {
            callback(null, [{ address: AUTHELIA_HOST_IP, family: 4 }] as never)
          } else {
            callback(null, AUTHELIA_HOST_IP as never, 4)
          }
          return
        }
        dnsLookup(hostname, options, callback)
      },
    },
  })
}

export const AUTHELIA_BASE_URL = `https://${AUTHELIA_ALIAS}:9091`
export const PROXY_BASE_URL = process.env.PROXY_URL ?? 'http://localhost:8080'

export interface TestHttp {
  dispatcher: Dispatcher
  /** undici fetch bound to the test dispatcher (alias resolution + test CA). */
  fetch: (
    url: string,
    init?: Parameters<typeof undiciFetch>[1],
  ) => ReturnType<typeof undiciFetch>
  close: () => Promise<void>
}

export function createTestHttp(): TestHttp {
  const agent = createTestAgent()
  return {
    dispatcher: agent,
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher: agent }),
    close: () => agent.close(),
  }
}
