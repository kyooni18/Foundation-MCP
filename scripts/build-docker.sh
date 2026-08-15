#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
image="${1:-kyooni18/foundation-mcp:latest}"
platforms="${PLATFORMS:-linux/amd64,linux/arm64}"
if [ "$#" -gt 0 ]; then shift; fi

cd "$repo_dir"
BUILDX_GIT_INFO=0 docker buildx build \
  --platform "$platforms" \
  -f Dockerfile.app \
  -t "$image" \
  . \
  "$@"
