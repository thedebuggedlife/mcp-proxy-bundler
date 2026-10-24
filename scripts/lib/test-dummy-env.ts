// Dummy values for credential env vars whose shape an MCP validates (e.g. a URL); the test harness uses 'dummy' otherwise.
export const TEST_DUMMY_ENV: Record<string, Record<string, string>> = {
  immich: { IMMICH_BASE_URL: 'http://immich.invalid' },
}
