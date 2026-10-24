import { mcpTestSpec } from '../test/integration/helpers/mcp-under-test.ts'
import { renderComposeOverride } from './lib/compose-override.ts'
import { loadMcpConfig } from './lib/mcp-config.ts'

// Emits a docker-compose override (to stdout) for the image-under-test that is
// specific to the selected MCP, so the base test/docker-compose.ci.yml stays
// MCP-agnostic (Phase 15: config-only onboarding):
//   - the MCP's API-key env vars (named per mcp.yaml runtime.apiKeyEnvs), set to
//     the ephemeral ${MCP_API_KEY} unless the harness registry gives a literal
//     placeholder, plus any extra env the registry declares;
//   - extra_hosts black-holing each runtime.telemetryHosts entry to 127.0.0.1
//     and ::1 (D10 / Finding 11), keeping the test hermetic.

function main(): void {
  const name = process.argv[2]
  if (!name) {
    process.stderr.write('Usage: gen-compose-override.ts <mcp-name>\n')
    process.exit(2)
  }

  const config = loadMcpConfig(name)
  const spec = mcpTestSpec(name)
  process.stdout.write(
    renderComposeOverride({
      apiKeyEnvs: config.apiKeyEnvs,
      telemetryHosts: config.telemetryHosts,
      apiKeyValue: spec?.apiKeyValue,
      extraEnv: spec?.extraEnv,
    }),
  )
}

main()
