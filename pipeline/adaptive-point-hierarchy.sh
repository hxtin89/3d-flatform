#!/usr/bin/env bash
# pipeline/adaptive-point-hierarchy.sh — Build the Adaptive Point Hierarchy (APH) for ?lod=adaptive-point-hierarchy.
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
  "$CONDA_ENV_PYTHON" "$SCRIPT_DIR/build_adaptive_point_hierarchy.py" "${ARGS[@]}" "$@"
else
  run_tool python "$SCRIPT_DIR/build_adaptive_point_hierarchy.py" "${ARGS[@]}" "$@"
fi
