#!/bin/sh
exec mcp-auth-proxy -- /app/node_modules/.bin/"$MCP_BIN" "$@"
