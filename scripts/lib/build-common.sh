# Sourced by build.sh and release-image.sh with MCP_NAME set. load_build_context sets REPO_ROOT,
# DOCKERFILE, PROXY_VERSION, NODE_VERSION, BUILD_SUMMARY and the BUILD_ARGS array.
# On error load_build_context returns 1, so callers must run under `set -e` for that to be fatal.

BUILD_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

load_build_context() {
  REPO_ROOT="$(cd "$BUILD_COMMON_DIR/../.." && pwd)"
  DOCKERFILE="$REPO_ROOT/Dockerfile"
  local mcp_dir="mcps/$MCP_NAME"

  [ -d "$REPO_ROOT/$mcp_dir" ] || { echo "error: $mcp_dir does not exist" >&2; return 1; }

  local meta
  meta="$(node "$BUILD_COMMON_DIR/../mcp-meta.ts" "$MCP_NAME")"
  local target upstream upstream_version launch node_override
  target="$(sed -n 's/^target=//p' <<<"$meta")"
  upstream="$(sed -n 's/^upstream=//p' <<<"$meta")"
  upstream_version="$(sed -n 's/^upstreamVersion=//p' <<<"$meta")"
  launch="$(sed -n 's/^launch=//p' <<<"$meta")"
  node_override="$(sed -n 's/^nodeVersion=//p' <<<"$meta")"

  # Versions come from the literal Dockerfile FROM tags; strip a pinDigests `@sha256:...` suffix.
  PROXY_VERSION="$(sed -n 's#^FROM ghcr.io/sigbit/mcp-auth-proxy:\([^ ]*\).*#\1#p' "$DOCKERFILE" | head -n1)"
  local node_tag
  node_tag="$(sed -n 's#^FROM node:\([^ ]*\).*#\1#p' "$DOCKERFILE" | head -n1)"
  PROXY_VERSION="${PROXY_VERSION%@*}"
  node_tag="${node_tag%@*}"
  NODE_VERSION="${node_tag%-slim}"

  [ -n "$PROXY_VERSION" ] || { echo "error: could not parse proxy version from $DOCKERFILE" >&2; return 1; }
  [ -n "$NODE_VERSION" ] || { echo "error: could not parse node version from $DOCKERFILE" >&2; return 1; }

  # nodeVersion override is schema-accepted but not wired into the build: fail rather than ignore it.
  if [ -n "$node_override" ] && [ "$node_override" != "$NODE_VERSION" ]; then
    echo "error: mcp.yaml nodeVersion '$node_override' for '$MCP_NAME' differs from the shared Dockerfile node base '$NODE_VERSION'." >&2
    echo "       Per-MCP node base override is not yet wired into the build." >&2
    return 1
  fi

  BUILD_SUMMARY="target=$target proxy=$PROXY_VERSION node=$NODE_VERSION upstream=$upstream@$upstream_version"
  BUILD_ARGS=(
    -f "$DOCKERFILE"
    --target "$target"
    --build-arg "MCP_DIR=$mcp_dir"
    --build-arg "MCP_LAUNCH=$launch"
    --label "io.thedebuggedlife.mcp.proxy-version=$PROXY_VERSION"
    --label "io.thedebuggedlife.mcp.package=$upstream"
    --label "io.thedebuggedlife.mcp.package-version=$upstream_version"
    --label "io.thedebuggedlife.mcp.node-version=$NODE_VERSION"
  )
}
