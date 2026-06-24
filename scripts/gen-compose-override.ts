import { loadMcpConfig } from './lib/mcp-config.ts'

// Emits a docker-compose override (to stdout) for the image-under-test that is
// specific to the selected MCP, so the base test/docker-compose.ci.yml stays
// MCP-agnostic (Phase 15: config-only onboarding):
//   - the MCP's API-key env var (named per mcp.yaml runtime.apiKeyEnv) set to
//     the ephemeral ${MCP_API_KEY} (compose interpolates it from --env-file);
//   - extra_hosts black-holing each runtime.telemetryHosts entry to 127.0.0.1
//     and ::1 (D10 / Finding 11), keeping the test hermetic.

function main(): void {
  const name = process.argv[2]
  if (!name) {
    process.stderr.write('Usage: gen-compose-override.ts <mcp-name>\n')
    process.exit(2)
  }

  const config = loadMcpConfig(name)
  const lines: string[] = ['services:', '  image-under-test:']

  // The stdio child reads its API key from the MCP-specific env var name.
  if (config.apiKeyEnv) {
    lines.push('    environment:')
    lines.push(`      ${config.apiKeyEnv}: '\${MCP_API_KEY}'`)
  }

  if (config.telemetryHosts.length === 0) {
    lines.push('    extra_hosts: []')
  } else {
    lines.push('    extra_hosts:')
    for (const host of config.telemetryHosts) {
      lines.push(`      - "${host}:127.0.0.1"`)
      lines.push(`      - "${host}:::1"`)
    }
  }

  process.stdout.write(lines.join('\n') + '\n')
}

main()
