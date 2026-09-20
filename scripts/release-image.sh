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
REGISTRY="${REGISTRY:-ghcr.io/thedebuggedlife}"
PLATFORM="${PLATFORM:-linux/amd64}"

source "$SCRIPT_DIR/lib/build-common.sh"
load_build_context

IMAGE="$REGISTRY/mcp-${MCP_NAME}"

echo "Releasing $IMAGE:$SEMVER ($BUILD_SUMMARY)" >&2

docker build \
  --platform "$PLATFORM" \
  "${BUILD_ARGS[@]}" \
  -t "$IMAGE:$SEMVER" \
  -t "$IMAGE:latest" \
  "$REPO_ROOT"

docker push "$IMAGE:$SEMVER"
docker push "$IMAGE:latest"

echo "Pushed $IMAGE:$SEMVER and $IMAGE:latest" >&2
