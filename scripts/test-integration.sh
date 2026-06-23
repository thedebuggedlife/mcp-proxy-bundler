#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MCP_NAME="${MCP_NAME:-hevy}"
IMAGE="ghcr.io/thedebuggedlife/mcp-${MCP_NAME}:dev"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image $IMAGE not found; building it." >&2
  "$SCRIPT_DIR/build.sh" "$MCP_NAME"
fi

cd "$REPO_ROOT"
exec npx vitest run test/integration "$@"
