#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <mcp-name>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
MCP_NAME="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/build-common.sh"
load_build_context

IMAGE="ghcr.io/thedebuggedlife/mcp-${MCP_NAME}:dev"

echo "Building $IMAGE ($BUILD_SUMMARY)" >&2

docker build "${BUILD_ARGS[@]}" -t "$IMAGE" "$REPO_ROOT"

echo "Built $IMAGE" >&2
