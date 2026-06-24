#!/usr/bin/env bash
# pipeline/area-overview-excluding.sh — Build p02 overview context wrappers excluding each selected area.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-2404PeruB2}"
PUBLIC_ROOT="$(pointcloud_public_root)"

ARGS=(
  "$SCRIPT_DIR/area_manifest.py" overview-excluding
  --root "$ROOT_DIR"
  --dataset "$DATASET"
  --overwrite
)

if [ -n "$PUBLIC_ROOT" ]; then
  ARGS+=(--public-root "$PUBLIC_ROOT")
fi

python3 "${ARGS[@]}"
