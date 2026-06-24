#!/usr/bin/env bash
# pipeline/area-overview-p001.sh — Build ultra-light approximate p001 overview tiles for Detail context.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-2404PeruB2}"

COPC_TILE_OUTPUT_DATASET="${DATASET}-overview-p001" \
COPC_TILE_POINT_STEP="${COPC_TILE_POINT_STEP:-1000}" \
COPC_TILE_DENSITY_TARGET="p001" \
COPC_TILE_SOURCE_TYPE="copc-overview-custom" \
COPC_TILE_CHUNK_OVERWRITE="${COPC_TILE_CHUNK_OVERWRITE:-0}" \
bash "$SCRIPT_DIR/copc-tiles-chunks.sh" "$DATASET"

bash "$SCRIPT_DIR/area-manifest.sh" "$DATASET"
