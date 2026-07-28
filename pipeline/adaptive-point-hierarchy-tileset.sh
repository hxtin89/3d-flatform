#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"

DATASET="${1:-2404PeruB2}"
shift || true
ARGS=("$DATASET" --root "$ROOT_DIR")
PUBLIC_ROOT="$(pointcloud_public_root)"
if [ -n "$PUBLIC_ROOT" ]; then
  ARGS+=(--public-root "$PUBLIC_ROOT")
fi

CONDA_ENV_PYTHON="${CONDA_ENV_PYTHON:-/Volumes/WD_BLACK/conda/envs/$CONDA_ENV/bin/python}"
if [ -x "$CONDA_ENV_PYTHON" ]; then
  "$CONDA_ENV_PYTHON" "$SCRIPT_DIR/build_adaptive_point_hierarchy_tileset.py" "${ARGS[@]}" "$@"
else
  run_tool python "$SCRIPT_DIR/build_adaptive_point_hierarchy_tileset.py" "${ARGS[@]}" "$@"
fi
