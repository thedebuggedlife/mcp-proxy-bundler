#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MCP_NAME="${MCP_NAME:-hevy}"
IMAGE="ghcr.io/thedebuggedlife/mcp-${MCP_NAME}:dev"
COMPOSE_FILE="$REPO_ROOT/test/docker-compose.ci.yml"
SECRETS_DIR="$REPO_ROOT/test/.secrets"
MCP_OVERRIDE="$SECRETS_DIR/compose.mcp.yml"
PROJECT_NAME="mcp-proxy-bundler-ci"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image $IMAGE not found; building it." >&2
  "$SCRIPT_DIR/build.sh" "$MCP_NAME"
fi

# Generate ephemeral secrets + rendered Authelia config (D13).
"$SCRIPT_DIR/gen-test-secrets.sh"

# Render a per-MCP compose override: sets the MCP's API-key env var (named per
# mcp.yaml runtime.apiKeyEnv) and black-holes its telemetry hosts (D10 /
# Finding 11). Keeps the base compose file MCP-agnostic.
node "$SCRIPT_DIR/gen-compose-override.ts" "$MCP_NAME" >"$MCP_OVERRIDE"

export IMAGE_UNDER_TEST="$IMAGE"
export MCP_NAME

COMPOSE=(docker compose
  -p "$PROJECT_NAME"
  --env-file "$SECRETS_DIR/test.env"
  -f "$COMPOSE_FILE"
  -f "$MCP_OVERRIDE")

cleanup() {
  echo "Tearing down CI stack..." >&2
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Bringing up CI stack (image=$IMAGE)..." >&2
if ! "${COMPOSE[@]}" up -d --wait --wait-timeout 180; then
  echo "Stack failed to become healthy; dumping logs:" >&2
  "${COMPOSE[@]}" ps >&2 || true
  "${COMPOSE[@]}" logs >&2 || true
  exit 1
fi

cd "$REPO_ROOT"
npx vitest run test/integration "$@"
