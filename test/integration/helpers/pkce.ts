import { createHash, randomBytes } from 'node:crypto'

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export interface Pkce {
  verifier: string
  challenge: string
  method: 'S256'
}

export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

export function randomState(): string {
  return base64url(randomBytes(16))
}
