import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// The compose project + service the proxy (image-under-test) runs as. Mirrors
// scripts/test-integration.sh (-p) and test/docker-compose.ci.yml.
const PROJECT_NAME = 'mcp-proxy-bundler-ci'
const PROXY_SERVICE = 'image-under-test'

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, {
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

/** The proxy container's id, located by its compose project/service labels. */
export async function getProxyContainerId(): Promise<string> {
  const out = await docker([
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${PROJECT_NAME}`,
    '--filter',
    `label=com.docker.compose.service=${PROXY_SERVICE}`,
  ])
  const id = out.trim().split('\n')[0]?.trim()
  if (!id) {
    throw new Error(
      `Proxy container not found (project=${PROJECT_NAME}, service=${PROXY_SERVICE}). Is the CI stack up?`,
    )
  }
  return id
}

/** The proxy container's Docker health status (e.g. 'healthy'). */
export async function getProxyHealthStatus(): Promise<string> {
  const id = await getProxyContainerId()
  const out = await docker([
    'inspect',
    '--format',
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
    id,
  ])
  return out.trim()
}

/** The full stdout+stderr log of the proxy container. */
export async function getProxyLogs(): Promise<string> {
  const id = await getProxyContainerId()
  // `docker logs` writes the container's stdout to our stdout and its stderr to
  // our stderr; capture both.
  const { stdout, stderr } = await execFileAsync('docker', ['logs', id], {
    maxBuffer: 16 * 1024 * 1024,
  })
  return `${stdout}${stderr}`
}
