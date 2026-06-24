#!/usr/bin/env bash
set -euo pipefail

# Build + push a composite image for a single MCP at the semantic-release-computed
# version. Invoked by @semantic-release/exec publishCmd ONLY when a release happens
# (design Appendix B.1), so an unchanged image is never rebuilt or re-pushed.

usage() {
  echo "Usage: MCP_NAME=<name> $0 <semver>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
SEMVER="$1"
MCP_NAME="${MCP_NAME:?MCP_NAME env var is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE="$REPO_ROOT/Dockerfile"
MCP_DIR="mcps/$MCP_NAME"
REGISTRY="${REGISTRY:-ghcr.io/thedebuggedlife}"
PLATFORM="${PLATFORM:-linux/amd64}"

[ -d "$REPO_ROOT/$MCP_DIR" ] || { echo "error: $MCP_DIR does not exist" >&2; exit 1; }

META="$(node "$SCRIPT_DIR/mcp-meta.ts" "$MCP_NAME")"
get_meta() { echo "$META" | sed -n "s/^$1=//p"; }

MCP_BIN="$(get_meta mcpBin)"
MCP_PACKAGE="$(get_meta mcpPackage)"
PACKAGE_VERSION="$(get_meta packageVersion)"
NODE_OVERRIDE="$(get_meta nodeVersion)"

PROXY_VERSION="$(sed -n 's#^FROM ghcr.io/sigbit/mcp-auth-proxy:\([^ ]*\).*#\1#p' "$DOCKERFILE" | head -n1)"
NODE_TAG="$(sed -n 's#^FROM node:\([^ ]*\).*#\1#p' "$DOCKERFILE" | head -n1)"
# strip a Renovate pinDigests `@sha256:...` suffix so version labels stay clean
PROXY_VERSION="${PROXY_VERSION%@*}"
NODE_TAG="${NODE_TAG%@*}"
NODE_VERSION="${NODE_TAG%-slim}"

[ -n "$PROXY_VERSION" ] || { echo "error: could not parse proxy version from $DOCKERFILE" >&2; exit 1; }
[ -n "$NODE_VERSION" ] || { echo "error: could not parse node version from $DOCKERFILE" >&2; exit 1; }

if [ -n "$NODE_OVERRIDE" ] && [ "$NODE_OVERRIDE" != "$NODE_VERSION" ]; then
  echo "error: mcp.yaml nodeVersion '$NODE_OVERRIDE' for '$MCP_NAME' differs from the shared Dockerfile node base '$NODE_VERSION'." >&2
  exit 1
fi

IMAGE="$REGISTRY/mcp-${MCP_NAME}"

echo "Releasing $IMAGE:$SEMVER (proxy=$PROXY_VERSION node=$NODE_VERSION pkg=$MCP_PACKAGE@$PACKAGE_VERSION)" >&2

docker build \
  --platform "$PLATFORM" \
  -f "$DOCKERFILE" \
  --build-arg "MCP_DIR=$MCP_DIR" \
  --build-arg "MCP_BIN=$MCP_BIN" \
  --label "io.thedebuggedlife.mcp.proxy-version=$PROXY_VERSION" \
  --label "io.thedebuggedlife.mcp.package=$MCP_PACKAGE" \
  --label "io.thedebuggedlife.mcp.package-version=$PACKAGE_VERSION" \
  --label "io.thedebuggedlife.mcp.node-version=$NODE_VERSION" \
  -t "$IMAGE:$SEMVER" \
  -t "$IMAGE:latest" \
  "$REPO_ROOT"

docker push "$IMAGE:$SEMVER"
docker push "$IMAGE:latest"

echo "Pushed $IMAGE:$SEMVER and $IMAGE:latest" >&2
