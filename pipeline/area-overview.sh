#!/usr/bin/env bash
# pipeline/area-overview.sh — Build approximate p02 overview tiles for all areas.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-2404PeruB2}"

COPC_TILE_OUTPUT_DATASET="${DATASET}-overview-p02" \
COPC_TILE_POINT_STEP="${COPC_TILE_POINT_STEP:-50}" \
COPC_TILE_DENSITY_TARGET="p02" \
COPC_TILE_SOURCE_TYPE="copc-overview-custom" \
COPC_TILE_PACK_MODE="${COPC_TILE_PACK_MODE:-level-group}" \
COPC_TILE_PACK_GROUP_LEVEL="${COPC_TILE_PACK_GROUP_LEVEL:-3}" \
COPC_TILE_PACK_TARGET_BYTES="${COPC_TILE_PACK_TARGET_BYTES:-524288}" \
COPC_TILE_PACK_HARD_MAX_BYTES="${COPC_TILE_PACK_HARD_MAX_BYTES:-5242880}" \
COPC_TILE_CHUNK_OVERWRITE="${COPC_TILE_CHUNK_OVERWRITE:-0}" \
bash "$SCRIPT_DIR/copc-tiles-chunks.sh" "$DATASET"

bash "$SCRIPT_DIR/area-manifest.sh" "$DATASET"
