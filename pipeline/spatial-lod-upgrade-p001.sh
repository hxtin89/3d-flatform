#!/usr/bin/env bash
# pipeline/spatial-lod-upgrade-p001.sh — Upgrade old spatial-lod to z0 p001 + z1..z4.
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
  "$CONDA_ENV_PYTHON" "$SCRIPT_DIR/upgrade_spatial_lod_p001.py" "${ARGS[@]}" "$@"
else
  run_tool python "$SCRIPT_DIR/upgrade_spatial_lod_p001.py" "${ARGS[@]}" "$@"
fi
