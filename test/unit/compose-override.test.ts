import { describe, expect, it } from 'vitest'
import { renderComposeOverride } from '../../scripts/lib/compose-override.ts'

describe('renderComposeOverride', () => {
  it('keeps the existing output for a plain MCP', () => {
    expect(
      renderComposeOverride({ apiKeyEnvs: ['HEVY_API_KEY'], telemetryHosts: ['o1.ingest.sentry.io'] }),
    ).toBe(
      [
        'services:',
        '  image-under-test:',
        '    environment:',
        "      HEVY_API_KEY: '${MCP_API_KEY}'",
        '    extra_hosts:',
        '      - "o1.ingest.sentry.io:127.0.0.1"',
        '      - "o1.ingest.sentry.io:::1"',
        '',
      ].join('\n'),
    )
  })

  it('emits an empty extra_hosts list and no environment when there is nothing to set', () => {
    expect(renderComposeOverride({ apiKeyEnvs: [], telemetryHosts: [] })).toBe(
      ['services:', '  image-under-test:', '    extra_hosts: []', ''].join('\n'),
    )
  })

  it('uses a literal placeholder key and extra env when given', () => {
    const out = renderComposeOverride({
      apiKeyEnvs: ['WANDERLOG_COOKIE'],
      telemetryHosts: [],
      apiKeyValue: 's%3Aplaceholder',
      extraEnv: { WANDERLOG_BASE_URL: 'http://127.0.0.1:9' },
    })
    expect(out).toContain("      WANDERLOG_COOKIE: 's%3Aplaceholder'\n")
    expect(out).toContain("      WANDERLOG_BASE_URL: 'http://127.0.0.1:9'\n")
    expect(out).not.toContain('MCP_API_KEY')
  })

  it('escapes quotes and compose interpolation in literal values', () => {
    const out = renderComposeOverride({ apiKeyEnvs: ['K'], telemetryHosts: [], apiKeyValue: "it's $HOME" })
    expect(out).toContain("      K: 'it''s $$HOME'\n")
  })
})
