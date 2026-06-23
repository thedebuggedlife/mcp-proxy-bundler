import { loadMcpConfig } from './lib/mcp-config.ts'

// Emits a docker-compose override (to stdout) that black-holes the MCP's
// telemetry hosts (D10 / Finding 11): each mcp.yaml runtime.telemetryHosts
// entry is mapped to 127.0.0.1 and ::1 on the image-under-test, so the test
// stays hermetic (no outbound Sentry) and exercises the D10 mechanism.

function main(): void {
  const name = process.argv[2]
  if (!name) {
    process.stderr.write('Usage: gen-telemetry-override.ts <mcp-name>\n')
    process.exit(2)
  }

  const config = loadMcpConfig(name)
  const lines: string[] = ['services:', '  image-under-test:']

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
