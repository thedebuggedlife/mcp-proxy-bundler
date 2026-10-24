// Renders the per-MCP docker-compose override for the integration stack's image-under-test.

export interface ComposeOverrideInput {
  apiKeyEnvs: string[]
  telemetryHosts: string[]
  dummyEnv?: Record<string, string>
}

const literal = (value: string): string => `'${value.replace(/'/g, "''").replace(/\$/g, '$$$$')}'`

export function renderComposeOverride(i: ComposeOverrideInput): string {
  const lines: string[] = ['services:', '  image-under-test:']

  const dummyEnv = i.dummyEnv ?? {}
  const env: [string, string][] = [
    ...i.apiKeyEnvs.map((name): [string, string] => [
      name,
      Object.hasOwn(dummyEnv, name) ? literal(dummyEnv[name]) : "'${MCP_API_KEY}'",
    ]),
    ...Object.entries(dummyEnv)
      .filter(([name]) => !i.apiKeyEnvs.includes(name))
      .map(([name, value]): [string, string] => [name, literal(value)]),
  ]
  if (env.length > 0) {
    lines.push('    environment:')
    for (const [name, value] of env) lines.push(`      ${name}: ${value}`)
  }

  if (i.telemetryHosts.length === 0) {
    lines.push('    extra_hosts: []')
  } else {
    lines.push('    extra_hosts:')
    for (const host of i.telemetryHosts) {
      lines.push(`      - "${host}:127.0.0.1"`)
      lines.push(`      - "${host}:::1"`)
    }
  }

  return lines.join('\n') + '\n'
}
