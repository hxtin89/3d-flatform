#!/usr/bin/env bash
# pipeline/area-one-lod-tree.sh — Build external sidecars for ?lod=one-lod-tree.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"

DATASET="${1:-2404PeruB2}"
AREA="${2:-}"
PUBLIC_ROOT="$(pointcloud_public_root)"

ARGS=(
  "$SCRIPT_DIR/build_one_lod_tree.py"
  --root "$ROOT_DIR"
  --dataset "$DATASET"
  --explore-request-ratio "${ONE_LOD_EXPLORE_REQUEST_RATIO:-2.5}"
  --detail-request-ratio "${ONE_LOD_DETAIL_REQUEST_RATIO:-0.75}"
)

if [ -n "$AREA" ]; then
  ARGS+=(--area "$AREA")
fi

if [ -n "$PUBLIC_ROOT" ]; then
  ARGS+=(--public-root "$PUBLIC_ROOT")
fi

python3 "${ARGS[@]}"
