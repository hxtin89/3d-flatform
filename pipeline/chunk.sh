#!/usr/bin/env bash
# pipeline/chunk.sh — Split a large LAS/LAZ source into spatial LAZ chunks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
SOURCE="${1:-autzen}"
CHUNK_LENGTH="${POINTCLOUD_CHUNK_LENGTH:-500}"
CHUNK_BUFFER="${POINTCLOUD_CHUNK_BUFFER:-0}"
CHUNK_OVERWRITE="${POINTCLOUD_CHUNK_OVERWRITE:-0}"

resolve_source_path() {
  local source="$1"

  if [[ "$source" = /* ]]; then
    echo "$source"
  elif [ -e "$ROOT_DIR/$source" ]; then
    echo "$ROOT_DIR/$source"
  elif [ -e "$ROOT_DIR/local-storage/intermediate/$source/$source.prepared.laz" ]; then
    echo "$ROOT_DIR/local-storage/intermediate/$source/$source.prepared.laz"
  elif [ -e "$ROOT_DIR/local-storage/raw/$source" ]; then
    echo "$ROOT_DIR/local-storage/raw/$source"
  elif [ -e "$ROOT_DIR/local-storage/raw/$source.laz" ]; then
    echo "$ROOT_DIR/local-storage/raw/$source.laz"
  elif [ -e "$ROOT_DIR/local-storage/$source" ]; then
    echo "$ROOT_DIR/local-storage/$source"
  else
    echo "$ROOT_DIR/local-storage/raw/$source"
  fi
}

dataset_from_path() {
  local source_path="$1"
  local base
  local parent

  if [ -d "$source_path" ]; then
    basename "$source_path"
    return
  fi

  parent="$(basename "$(dirname "$source_path")")"
  if [ "$parent" != "raw" ] && [ "$parent" != "local-storage" ]; then
    echo "$parent"
    return
  fi

  base="$(basename "$source_path")"
  base="${base%.copc.laz}"
  base="${base%.prepared.laz}"
  base="${base%.standard.laz}"
  base="${base%.laz}"
  base="${base%.las}"
  echo "$base"
}

SOURCE_PATH="$(resolve_source_path "$SOURCE")"
DATASET="$(dataset_from_path "$SOURCE_PATH")"
OUTPUT_DIR="$ROOT_DIR/local-storage/intermediate/$DATASET/chunks-laz"
PIPELINE_FILE="$ROOT_DIR/local-storage/intermediate/$DATASET/chunk.pipeline.json"
CHUNK_MODE="${POINTCLOUD_CHUNK_MODE:-tile}"
CHUNK_ORIGIN_X="${POINTCLOUD_CHUNK_ORIGIN_X:-}"
CHUNK_ORIGIN_Y="${POINTCLOUD_CHUNK_ORIGIN_Y:-}"

echo "=== Pipeline: Chunk LAS/LAZ ==="

if [ ! -f "$SOURCE_PATH" ]; then
  echo "✗ Error: Source file not found: $SOURCE"
  echo "  Expected path: $SOURCE_PATH"
  exit 1
fi

if [ -d "$OUTPUT_DIR" ] && find "$OUTPUT_DIR" -maxdepth 1 -type f -name "*.laz" | grep -q .; then
  if [ "$CHUNK_OVERWRITE" != "1" ]; then
    COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name "*.laz" | wc -l | tr -d ' ')
    echo "✓ Existing chunks found: $OUTPUT_DIR ($COUNT files), skipping."
    echo "  Set POINTCLOUD_CHUNK_OVERWRITE=1 to regenerate."
    exit 0
  fi
  echo "→ Removing existing chunks: $OUTPUT_DIR"
  rm -rf "$OUTPUT_DIR"
fi

mkdir -p "$OUTPUT_DIR"

echo "→ Dataset:      $DATASET"
echo "→ Input:        $SOURCE_PATH"
echo "→ Output:       $OUTPUT_DIR"
echo "→ Chunk length: $CHUNK_LENGTH"
echo "→ Buffer:       $CHUNK_BUFFER"
echo "→ Mode:         $CHUNK_MODE"

if [ "$CHUNK_MODE" = "tile" ]; then
  TILE_ARGS=(tile "$SOURCE_PATH" "$OUTPUT_DIR/chunk-#.laz" --length "$CHUNK_LENGTH" --buffer "$CHUNK_BUFFER")
  if [ -n "$CHUNK_ORIGIN_X" ]; then
    TILE_ARGS+=(--origin_x "$CHUNK_ORIGIN_X")
  fi
  if [ -n "$CHUNK_ORIGIN_Y" ]; then
    TILE_ARGS+=(--origin_y "$CHUNK_ORIGIN_Y")
  fi

  echo "→ Running PDAL tile command..."
  run_tool pdal "${TILE_ARGS[@]}"

  COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name "*.laz" | wc -l | tr -d ' ')
  SIZE=$(du -sh "$OUTPUT_DIR" | cut -f1)
  echo "✓ Chunks generated: $COUNT files ($SIZE)"
  echo "  Next: npm run pipeline:copc:chunks -- $DATASET"
  exit 0
fi

if [ "$CHUNK_MODE" != "splitter" ]; then
  echo "✗ Error: Unknown POINTCLOUD_CHUNK_MODE=$CHUNK_MODE"
  echo "  Supported: tile, splitter"
  exit 1
fi

run_tool python -c '
import json
import sys
from pathlib import Path

pipeline_file = Path(sys.argv[1])
input_file = sys.argv[2]
output_pattern = sys.argv[3]
length = float(sys.argv[4])
buffer = float(sys.argv[5])

pipeline = [
    {"type": "readers.las", "filename": input_file},
    {"type": "filters.splitter", "length": length, "buffer": buffer},
    {
        "type": "writers.las",
        "filename": output_pattern,
        "compression": "laszip",
    },
]
pipeline_file.write_text(json.dumps({"pipeline": pipeline}, indent=2), encoding="utf-8")
' "$PIPELINE_FILE" "$SOURCE_PATH" "$OUTPUT_DIR/chunk-#.laz" "$CHUNK_LENGTH" "$CHUNK_BUFFER"

echo "→ Running PDAL splitter..."
run_tool pdal pipeline "$PIPELINE_FILE"

COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name "*.laz" | wc -l | tr -d ' ')
SIZE=$(du -sh "$OUTPUT_DIR" | cut -f1)
echo "✓ Chunks generated: $COUNT files ($SIZE)"
echo "  Next: npm run pipeline:copc:chunks -- $DATASET"
