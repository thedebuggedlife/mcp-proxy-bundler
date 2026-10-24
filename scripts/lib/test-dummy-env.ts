// Per-MCP test env: an entry replaces that apiKeyEnv's placeholder (for MCPs that validate a credential's shape, e.g. a URL); any other entry is passed as extra env.
export const TEST_DUMMY_ENV: Record<string, Record<string, string>> = {
  immich: { IMMICH_BASE_URL: 'http://immich.invalid' },
  wanderlog: {
    // The MCP refuses to start unless the cookie looks like connect.sid.
    WANDERLOG_COOKIE: 's%3Aplaceholder',
    WANDERLOG_BASE_URL: 'http://127.0.0.1:9',
    WANDERLOG_WS_BASE_URL: 'ws://127.0.0.1:9',
  },
}
