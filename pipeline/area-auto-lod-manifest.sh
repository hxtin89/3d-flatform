#!/usr/bin/env bash
# pipeline/area-auto-lod-manifest.sh — Build area-manifest-auto-lod.json for ?lod=auto.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-2404PeruB2}"
PUBLIC_ROOT="$(pointcloud_public_root)"

ARGS=(
  "$SCRIPT_DIR/area_auto_lod_manifest.py"
  --root "$ROOT_DIR"
  --dataset "$DATASET"
)

if [ -n "$PUBLIC_ROOT" ]; then
  ARGS+=(--public-root "$PUBLIC_ROOT")
fi

python3 "${ARGS[@]}"