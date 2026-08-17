#!/usr/bin/env bash
# pipeline/spatial-lod.sh — Build a Spatial LOD Grid/Tree for ?lod=spatial-lod.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"

DATASET="${1:-2404PeruB2}"
shift || true
PUBLIC_ROOT="$(pointcloud_public_root)"
ARGS=(--root "$ROOT_DIR" "$DATASET")

if [ -n "$PUBLIC_ROOT" ]; then
  ARGS+=(--public-root "$PUBLIC_ROOT")
fi

CONDA_ENV_PYTHON="${CONDA_ENV_PYTHON:-/Volumes/WD_BLACK/conda/envs/$CONDA_ENV/bin/python}"

if [ -x "$CONDA_ENV_PYTHON" ]; then
  "$CONDA_ENV_PYTHON" "$SCRIPT_DIR/build_spatial_lod_tree.py" "${ARGS[@]}" "$@"
else
  run_tool python "$SCRIPT_DIR/build_spatial_lod_tree.py" "${ARGS[@]}" "$@"
fi
