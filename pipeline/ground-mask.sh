#!/usr/bin/env bash
# pipeline/ground-mask.sh — Bake the ground coverage mask as a per-cell distance field.
#
# DESIGN SKETCH — never run. See .agents/skills/ground-coverage-mask/SKILL.md.
#
# Needs the area manifest (for rootTransform) and the source COPC, so it slots after
# area-manifest and can run alongside the tileset builds.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-2404PeruB2}"
COPC="${2:-$ROOT_DIR/local-storage/copc/$DATASET.copc.laz}"
PUBLIC_ROOT="$(pointcloud_public_root)"

ARGS=(
  "$SCRIPT_DIR/build_ground_mask.py"
  --root "$ROOT_DIR"
  --dataset "$DATASET"
  --copc "$COPC"
)

if [ -n "$PUBLIC_ROOT" ]; then
  ARGS+=(--public-root "$PUBLIC_ROOT")
fi

python3 "${ARGS[@]}"
