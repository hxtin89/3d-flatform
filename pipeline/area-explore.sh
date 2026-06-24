#!/usr/bin/env bash
# pipeline/area-explore.sh — Build approximate p10 tiles for a selected area.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-2404PeruB2}"
AREA_ID="${2:-area-001}"
MANIFEST="$(pointcloud_manifest_path "$ROOT_DIR" "$DATASET")"

if [ ! -f "$MANIFEST" ]; then
  bash "$SCRIPT_DIR/area-manifest.sh" "$DATASET"
fi

CHUNK_ID="$(
python3 - "$MANIFEST" "$AREA_ID" <<'PY'
import json
import sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
area = next((a for a in manifest.get("areas", []) if a.get("areaId") == sys.argv[2]), None)
if area is None:
    raise SystemExit(f"Area not found: {sys.argv[2]}")
print(area["sourceChunkId"])
PY
)"

COPC_TILE_OUTPUT_DATASET="${DATASET}-explore-p10/areas/${AREA_ID}" \
COPC_TILE_CHUNK_FILTER="$CHUNK_ID" \
COPC_TILE_POINT_STEP="${COPC_TILE_POINT_STEP:-10}" \
COPC_TILE_DENSITY_TARGET="p10" \
COPC_TILE_SOURCE_TYPE="copc-area-custom" \
COPC_TILE_PACK_MODE="${COPC_TILE_PACK_MODE:-level-group}" \
COPC_TILE_PACK_GROUP_LEVEL="${COPC_TILE_PACK_GROUP_LEVEL:-3}" \
COPC_TILE_PACK_TARGET_BYTES="${COPC_TILE_PACK_TARGET_BYTES:-524288}" \
COPC_TILE_PACK_HARD_MAX_BYTES="${COPC_TILE_PACK_HARD_MAX_BYTES:-5242880}" \
COPC_TILE_CHUNK_OVERWRITE="${COPC_TILE_CHUNK_OVERWRITE:-0}" \
bash "$SCRIPT_DIR/copc-tiles-chunks.sh" "$DATASET"

bash "$SCRIPT_DIR/area-manifest.sh" "$DATASET"
