#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <mcp-name>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
MCP_NAME="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE="$REPO_ROOT/Dockerfile"
MCP_DIR="mcps/$MCP_NAME"

[ -d "$REPO_ROOT/$MCP_DIR" ] || { echo "error: $MCP_DIR does not exist" >&2; exit 1; }

# Load validated metadata via the Phase 3 loader.
META="$(node "$SCRIPT_DIR/mcp-meta.ts" "$MCP_NAME")"
get_meta() { echo "$META" | sed -n "s/^$1=//p"; }

MCP_BIN="$(get_meta mcpBin)"
MCP_PACKAGE="$(get_meta mcpPackage)"
PACKAGE_VERSION="$(get_meta packageVersion)"
NODE_OVERRIDE="$(get_meta nodeVersion)"

# Parse proxy + node versions from the literal Dockerfile FROM tags (design Appendix B.3).
PROXY_VERSION="$(sed -n 's#^FROM ghcr.io/sigbit/mcp-auth-proxy:\([^ ]*\).*#\1#p' "$DOCKERFILE" | head -n1)"
NODE_TAG="$(sed -n 's#^FROM node:\([^ ]*\).*#\1#p' "$DOCKERFILE" | head -n1)"
NODE_VERSION="${NODE_TAG%-slim}"

[ -n "$PROXY_VERSION" ] || { echo "error: could not parse proxy version from $DOCKERFILE" >&2; exit 1; }
[ -n "$NODE_VERSION" ] || { echo "error: could not parse node version from $DOCKERFILE" >&2; exit 1; }

# nodeVersion override is schema-accepted but not yet wired into the build (Design Decisions):
# fail clearly rather than silently ignoring a mismatch with the shared base.
if [ -n "$NODE_OVERRIDE" ] && [ "$NODE_OVERRIDE" != "$NODE_VERSION" ]; then
  echo "error: mcp.yaml nodeVersion '$NODE_OVERRIDE' for '$MCP_NAME' differs from the shared Dockerfile node base '$NODE_VERSION'." >&2
  echo "       Per-MCP node base override is not yet wired into the build." >&2
  exit 1
fi

IMAGE="ghcr.io/thedebuggedlife/mcp-${MCP_NAME}:dev"

echo "Building $IMAGE (proxy=$PROXY_VERSION node=$NODE_VERSION pkg=$MCP_PACKAGE@$PACKAGE_VERSION)" >&2

docker build \
  -f "$DOCKERFILE" \
  --build-arg "MCP_DIR=$MCP_DIR" \
  --build-arg "MCP_BIN=$MCP_BIN" \
  --label "io.thedebuggedlife.mcp.proxy-version=$PROXY_VERSION" \
  --label "io.thedebuggedlife.mcp.package=$MCP_PACKAGE" \
  --label "io.thedebuggedlife.mcp.package-version=$PACKAGE_VERSION" \
  --label "io.thedebuggedlife.mcp.node-version=$NODE_VERSION" \
  -t "$IMAGE" \
  "$REPO_ROOT"

echo "Built $IMAGE" >&2
