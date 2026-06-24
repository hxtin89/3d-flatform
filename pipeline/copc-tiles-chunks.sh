#!/usr/bin/env bash
# pipeline/copc-tiles-chunks.sh — Convert COPC chunks to PNTS and build a root tileset.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-autzen}"
INPUT_DIR="$ROOT_DIR/local-storage/intermediate/$DATASET/chunks-copc"
OUTPUT_DATASET="$(pointcloud_public_dataset "${COPC_TILE_OUTPUT_DATASET:-$DATASET-chunked-copc}")"
OUTPUT_DIR="$ROOT_DIR/local-storage/tilesets/$OUTPUT_DATASET"
CHILDREN_DIR="$OUTPUT_DIR/chunks"
CONDA_ENV_PYTHON="${CONDA_ENV_PYTHON:-/Volumes/WD_BLACK/conda/envs/$CONDA_ENV/bin/python}"
COPC_TILE_COLOR_SCALE="${COPC_TILE_COLOR_SCALE:-256}"
COPC_TILE_CHUNK_LIMIT="${COPC_TILE_CHUNK_LIMIT:-0}"
COPC_TILE_CHUNK_OVERWRITE="${COPC_TILE_CHUNK_OVERWRITE:-0}"
COPC_TILE_CHUNK_FILTER="${COPC_TILE_CHUNK_FILTER:-}"
COPC_TILE_POINT_STEP="${COPC_TILE_POINT_STEP:-1}"
COPC_TILE_DENSITY_TARGET="${COPC_TILE_DENSITY_TARGET:-full}"
COPC_TILE_SOURCE_TYPE="${COPC_TILE_SOURCE_TYPE:-copc-chunked-custom}"
COPC_TILE_PACK_MODE="${COPC_TILE_PACK_MODE:-none}"
COPC_TILE_PACK_GROUP_LEVEL="${COPC_TILE_PACK_GROUP_LEVEL:-3}"
COPC_TILE_PACK_TARGET_BYTES="${COPC_TILE_PACK_TARGET_BYTES:-524288}"
COPC_TILE_PACK_HARD_MAX_BYTES="${COPC_TILE_PACK_HARD_MAX_BYTES:-5242880}"

echo "=== Pipeline: Chunked COPC → 3D Tiles PNTS ==="

if [ ! -d "$INPUT_DIR" ]; then
  echo "✗ Error: COPC chunk directory not found: $INPUT_DIR"
  echo "  Run: npm run pipeline:copc:chunks -- $DATASET"
  exit 1
fi

mkdir -p "$CHILDREN_DIR"

echo "→ Dataset:        $OUTPUT_DATASET"
echo "→ Source dataset: $DATASET"
echo "→ Input:          $INPUT_DIR"
echo "→ Output:         $OUTPUT_DIR"
echo "→ Point step:     $COPC_TILE_POINT_STEP ($COPC_TILE_DENSITY_TARGET, approximate)"
echo "→ Tile packing:   $COPC_TILE_PACK_MODE"
if [ -n "$COPC_TILE_CHUNK_FILTER" ]; then
  echo "→ Chunk filter:   $COPC_TILE_CHUNK_FILTER"
fi

PROCESSED=0
SKIPPED=0
FAILED=0

while IFS= read -r chunk_file; do
  chunk_name="$(basename "$chunk_file" .copc.laz)"
  child_output="$CHILDREN_DIR/$chunk_name"

  if [ -n "$COPC_TILE_CHUNK_FILTER" ] && [ "$chunk_name" != "$COPC_TILE_CHUNK_FILTER" ]; then
    continue
  fi

  if [ "$COPC_TILE_CHUNK_LIMIT" != "0" ] && [ "$PROCESSED" -ge "$COPC_TILE_CHUNK_LIMIT" ]; then
    break
  fi

  if [ -f "$child_output/tileset.json" ] && [ "$COPC_TILE_CHUNK_OVERWRITE" != "1" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo "→ PNTS chunk: $chunk_name"
  if [ -x "$CONDA_ENV_PYTHON" ]; then
    "$CONDA_ENV_PYTHON" "$SCRIPT_DIR/copc_to_3dtiles.py" \
      "$chunk_file" \
      --out "$child_output" \
      --dataset "$OUTPUT_DATASET-$chunk_name" \
      --color-scale "$COPC_TILE_COLOR_SCALE" \
      --point-step "$COPC_TILE_POINT_STEP" \
      --density-target "$COPC_TILE_DENSITY_TARGET" \
      --tile-pack-mode "$COPC_TILE_PACK_MODE" \
      --tile-pack-group-level "$COPC_TILE_PACK_GROUP_LEVEL" \
      --tile-pack-target-bytes "$COPC_TILE_PACK_TARGET_BYTES" \
      --tile-pack-hard-max-bytes "$COPC_TILE_PACK_HARD_MAX_BYTES" \
      --overwrite
  else
    run_tool python "$SCRIPT_DIR/copc_to_3dtiles.py" \
      "$chunk_file" \
      --out "$child_output" \
      --dataset "$OUTPUT_DATASET-$chunk_name" \
      --color-scale "$COPC_TILE_COLOR_SCALE" \
      --point-step "$COPC_TILE_POINT_STEP" \
      --density-target "$COPC_TILE_DENSITY_TARGET" \
      --tile-pack-mode "$COPC_TILE_PACK_MODE" \
      --tile-pack-group-level "$COPC_TILE_PACK_GROUP_LEVEL" \
      --tile-pack-target-bytes "$COPC_TILE_PACK_TARGET_BYTES" \
      --tile-pack-hard-max-bytes "$COPC_TILE_PACK_HARD_MAX_BYTES" \
      --overwrite
  fi

  if [ -f "$child_output/tileset.json" ]; then
    PROCESSED=$((PROCESSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "✗ Failed PNTS chunk: $chunk_name"
    break
  fi
done < <(find "$INPUT_DIR" -maxdepth 1 -type f -name "*.copc.laz" | sort)

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

python3 "$SCRIPT_DIR/build_chunked_tileset.py" \
  --dataset "$OUTPUT_DATASET" \
  --source-dataset "$DATASET" \
  --output "$OUTPUT_DIR"

python3 "$SCRIPT_DIR/dataset_report.py" \
  --root "$ROOT_DIR" \
  --dataset "$OUTPUT_DATASET" \
  --source-dataset "$DATASET" \
  --source-type "$COPC_TILE_SOURCE_TYPE" \
  --tiles-dir "$OUTPUT_DIR"

echo ""
echo "✓ Chunked COPC 3D Tiles generated:"
echo "  tileset.json    : $OUTPUT_DIR/tileset.json"
echo "  dataset report  : $OUTPUT_DIR/dataset-report.json"
echo "  Processed chunks: $PROCESSED"
echo "  Skipped chunks  : $SKIPPED"
echo ""
echo "  → Open viewer: http://localhost:5173/?dataset=$OUTPUT_DATASET"
