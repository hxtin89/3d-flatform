#!/usr/bin/env bash
# pipeline/one-lod-tree-pack.sh - Pack ?lod=one-lod-tree into one uploadable folder.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"

DATASET="${1:-2404PeruB2}"
if [ "$#" -gt 0 ]; then
  shift
fi
PUBLIC_ROOT="$(pointcloud_public_root)"

ARGS=(
  "$SCRIPT_DIR/pack_one_lod_tree.py"
  --root "$ROOT_DIR"
  --dataset "$DATASET"
)

if [ -n "$PUBLIC_ROOT" ]; then
  ARGS+=(--public-root "$PUBLIC_ROOT")
fi

python3 "${ARGS[@]}" "$@"
