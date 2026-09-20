#!/bin/sh
# WORKAROUND(mcp-auth-proxy#178): route the MCP child through the stdio schema
# normalizer so the proxy's tools/list relay can't emit dangling $refs.
# To remove: exec mcp-auth-proxy -- /app/mcp-launch "$@"
exec mcp-auth-proxy -- node /app/mcp-schema-shim.cjs /app/mcp-launch "$@"
