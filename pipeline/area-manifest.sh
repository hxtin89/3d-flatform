#!/usr/bin/env bash
# pipeline/area-manifest.sh — Build logical area manifest for a chunked COPC dataset.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-2404PeruB2}"
PUBLIC_ROOT="$(pointcloud_public_root)"

ARGS=(
  "$SCRIPT_DIR/area_manifest.py" manifest
  --root "$ROOT_DIR"
  --dataset "$DATASET"
)

if [ -n "$PUBLIC_ROOT" ]; then
  ARGS+=(--public-root "$PUBLIC_ROOT")
fi

CONDA_ENV_PYTHON="${CONDA_ENV_PYTHON:-/Volumes/WD_BLACK/conda/envs/$CONDA_ENV/bin/python}"
if [ -x "$CONDA_ENV_PYTHON" ]; then
  "$CONDA_ENV_PYTHON" "${ARGS[@]}"
else
  run_tool python "${ARGS[@]}"
fi
