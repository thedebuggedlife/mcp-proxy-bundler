import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The Phase 7 secrets generator writes test/.secrets/test.env for compose
// interpolation; it is NOT exported into the vitest process. The Tier-2 e2e
// test needs the throwaway user credentials and the OIDC client id, so read
// them straight from that file (single source of truth, also works when vitest
// is run by hand against an already-up stack).

const moduleDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(moduleDir, '..', '..', '..')

export interface TestSecrets {
  oidcClientId: string
  testUser: string
  testPassword: string
  testGroup: string
  testEmail: string
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return out
}

export function loadTestSecrets(): TestSecrets {
  const envPath = join(repoRoot, 'test', '.secrets', 'test.env')
  let raw: string
  try {
    raw = readFileSync(envPath, 'utf8')
  } catch {
    throw new Error(
      `Missing ${envPath}. Run the CI stack via 'npm run test:integration' ` +
        '(it calls scripts/gen-test-secrets.sh first).',
    )
  }
  const env = parseEnvFile(raw)
  const require = (key: string): string => {
    const value = env[key]
    if (!value) throw new Error(`test.env is missing ${key}`)
    return value
  }
  return {
    oidcClientId: require('OIDC_CLIENT_ID'),
    testUser: require('TEST_USER'),
    testPassword: require('TEST_PASSWORD'),
    testGroup: require('TEST_GROUP'),
    testEmail: require('TEST_EMAIL'),
  }
}
