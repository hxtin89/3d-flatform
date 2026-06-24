#!/usr/bin/env bash
# pipeline/tiles.sh — Convert LAZ/COPC LAZ to 3D Tiles using py3dtiles
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
SOURCE="${1:-}"

find_laz_file() {
  local source_dir="$1"
  local laz_files=()
  local laz_file

  while IFS= read -r laz_file; do
    laz_files+=("$laz_file")
  done < <(find "$source_dir" -maxdepth 1 -type f -name "*.laz" | sort)

  if [ "${#laz_files[@]}" -eq 0 ]; then
    echo "✗ Error: No .laz file found in: $source_dir" >&2
    exit 1
  fi

  if [ "${#laz_files[@]}" -gt 1 ]; then
    echo "✗ Error: Multiple .laz files found in: $source_dir" >&2
    echo "  Pass a specific file path instead:" >&2
    printf '  - %s\n' "${laz_files[@]}" >&2
    exit 1
  fi

  echo "${laz_files[0]}"
}

detect_color_scale() {
  local input_file="$1"

  run_tool python -c '
import sys

import laspy
import numpy as np

input_file = sys.argv[1]

with laspy.open(input_file) as las_file:
    names = set(las_file.header.point_format.dimension_names)
    if not {"red", "green", "blue"}.issubset(names):
        print("none\tno RGB dimensions detected")
        raise SystemExit(0)

    point_count = las_file.header.point_count
    if point_count == 0:
        print("none\tRGB dimensions detected, but file has no points")
        raise SystemExit(0)

    points = next(las_file.chunk_iterator(min(point_count, 10000)))
    max_rgb = max(
        int(np.max(points["red"])),
        int(np.max(points["green"])),
        int(np.max(points["blue"])),
    )

    if 0 < max_rgb <= 255:
        print(f"256\tdetected RGB max {max_rgb}; scaling 8-bit LAS color up for py3dtiles")
    else:
        print(f"none\tdetected RGB max {max_rgb}; omitting color scale")
' "$input_file"
}

if [ -n "$SOURCE" ]; then
  if [[ "$SOURCE" = /* ]]; then
    SOURCE_PATH="$SOURCE"
  elif [ -e "$ROOT_DIR/$SOURCE" ]; then
    SOURCE_PATH="$ROOT_DIR/$SOURCE"
  elif [ -e "$ROOT_DIR/local-storage/intermediate/$SOURCE/$SOURCE.prepared.laz" ]; then
    SOURCE_PATH="$ROOT_DIR/local-storage/intermediate/$SOURCE/$SOURCE.prepared.laz"
  else
    SOURCE_PATH="$ROOT_DIR/local-storage/$SOURCE"
  fi

  if [ -d "$SOURCE_PATH" ]; then
    INPUT_FILE="$(find_laz_file "$SOURCE_PATH")"
    DATASET="$(basename "$SOURCE_PATH")"
  elif [ -f "$SOURCE_PATH" ]; then
    INPUT_FILE="$SOURCE_PATH"
    DATASET="$(basename "$(dirname "$SOURCE_PATH")")"
  else
    echo "✗ Error: Source not found: $SOURCE" >&2
    echo "  Examples:" >&2
    echo "    npm run pipeline:tiles -- wi-1" >&2
    echo "    npm run pipeline:tiles -- local-storage/wi-1/file.copc.laz" >&2
    exit 1
  fi

  OUTPUT_DIR="$ROOT_DIR/local-storage/tilesets/$DATASET"
else
  DATASET="${SOURCE:-autzen}"
  PREPARED_FILE="$ROOT_DIR/local-storage/intermediate/$DATASET/$DATASET.prepared.laz"
  RAW_FILE="$ROOT_DIR/local-storage/raw/$DATASET.laz"
  OUTPUT_DIR="$ROOT_DIR/local-storage/tilesets/$DATASET"
fi

echo "=== Pipeline: 3D Tiles Generation ==="

if [ -z "$SOURCE" ]; then
  # Choose input: prefer prepared, fall back to raw.
  if [ -f "$PREPARED_FILE" ]; then
    INPUT_FILE="$PREPARED_FILE"
  elif [ -f "$RAW_FILE" ]; then
    echo "⚠ Prepared file not found. Falling back to raw LAZ."
    INPUT_FILE="$RAW_FILE"
  else
    echo "✗ Error: No input LAZ file found."
    echo "  Run 'npm run pipeline:download' first, or pass a source folder:"
    echo "    npm run pipeline:tiles -- wi-1"
    exit 1
  fi
fi

if [[ "$(basename "$INPUT_FILE")" == *.copc.laz ]]; then
  STANDARD_DIR="$ROOT_DIR/local-storage/intermediate/$DATASET"
  STANDARD_FILE="$STANDARD_DIR/$DATASET.standard.laz"
  mkdir -p "$STANDARD_DIR"

  if [ ! -f "$STANDARD_FILE" ] || [ "$INPUT_FILE" -nt "$STANDARD_FILE" ]; then
    echo "→ COPC input detected. Normalizing to standard LAZ for py3dtiles..."
    echo "  Standard LAZ: $STANDARD_FILE"
    run_tool pdal translate "$INPUT_FILE" "$STANDARD_FILE" --writers.las.compression=laszip
  else
    echo "→ COPC input detected. Reusing standard LAZ: $STANDARD_FILE"
  fi

  INPUT_FILE="$STANDARD_FILE"
fi

if ! has_tool py3dtiles; then
  echo "✗ py3dtiles not found."
  echo "  Install it inside the pointcloud-pipeline env:"
  echo "    /Volumes/WD_BLACK/conda/miniforge/bin/conda run -n pointcloud-pipeline python -m pip install py3dtiles"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "→ Dataset: $DATASET"
echo "→ Input:  $INPUT_FILE"
echo "→ Output: $OUTPUT_DIR"
echo "→ Tool:   py3dtiles"
COLOR_SCALE_MODE="${PY3DTILES_COLOR_SCALE:-auto}"
COLOR_SCALE_ARGS=()

case "$COLOR_SCALE_MODE" in
  auto)
    COLOR_SCALE_DECISION="$(detect_color_scale "$INPUT_FILE")"
    COLOR_SCALE_VALUE="${COLOR_SCALE_DECISION%%	*}"
    COLOR_SCALE_REASON="${COLOR_SCALE_DECISION#*	}"
    if [ "$COLOR_SCALE_VALUE" = "256" ]; then
      COLOR_SCALE_ARGS=(--color_scale 256)
      echo "→ Color scale: --color_scale 256 ($COLOR_SCALE_REASON)"
    else
      echo "→ Color scale: omitted ($COLOR_SCALE_REASON)"
    fi
    ;;
  none|omit|off|false)
    echo "→ Color scale: omitted (PY3DTILES_COLOR_SCALE=$COLOR_SCALE_MODE)"
    ;;
  *)
    COLOR_SCALE_ARGS=(--color_scale "$COLOR_SCALE_MODE")
    echo "→ Color scale: --color_scale $COLOR_SCALE_MODE (PY3DTILES_COLOR_SCALE override)"
    ;;
esac
echo ""

# Clean output dir if it has stale data
if [ -f "$OUTPUT_DIR/tileset.json" ]; then
  echo "⚠ Existing tileset found in $OUTPUT_DIR. Cleaning before re-generation..."
  rm -rf "$OUTPUT_DIR"
  mkdir -p "$OUTPUT_DIR"
fi

echo "→ Running py3dtiles convert..."
if [ "${#COLOR_SCALE_ARGS[@]}" -gt 0 ]; then
  run_tool py3dtiles convert "$INPUT_FILE" --out "$OUTPUT_DIR" --overwrite "${COLOR_SCALE_ARGS[@]}"
else
  run_tool py3dtiles convert "$INPUT_FILE" --out "$OUTPUT_DIR" --overwrite
fi

if [ -f "$OUTPUT_DIR/tileset.json" ]; then
  run_tool python "$SCRIPT_DIR/dataset_report.py" \
    --root "$ROOT_DIR" \
    --dataset "$DATASET" \
    --source-dataset "$DATASET" \
    --source-type py3dtiles-fallback \
    --tiles-dir "$OUTPUT_DIR"

  TILE_COUNT=$(find "$OUTPUT_DIR" -name "*.pnts" -o -name "*.b3dm" | wc -l | tr -d ' ')
  TOTAL_SIZE=$(du -sh "$OUTPUT_DIR" | cut -f1)
  echo ""
  echo "✓ 3D Tiles generated:"
  echo "  tileset.json : $OUTPUT_DIR/tileset.json"
  echo "  report       : $OUTPUT_DIR/dataset-report.json"
  echo "  Tile files   : $TILE_COUNT"
  echo "  Total size   : $TOTAL_SIZE"
  echo ""
  echo "  → Start tile server: npm run pipeline:serve"
  echo "  → Open viewer:       npm run viewer:dev"
  echo "  → Dataset URL:       http://localhost:5173/?dataset=$DATASET"
else
  echo "✗ Error: tileset.json was not created."
  echo "  Check py3dtiles output above for errors."
  exit 1
fi
