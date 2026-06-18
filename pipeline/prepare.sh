#!/usr/bin/env bash
# pipeline/prepare.sh — Validate and prepare LAS/LAZ for tiling
# Phase 1: pass-through with validation. Reproject only if PDAL reports SRS mismatch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
SOURCE="${1:-autzen}"

resolve_source_path() {
  local source="$1"

  if [[ "$source" = /* ]]; then
    echo "$source"
  elif [ -e "$ROOT_DIR/$source" ]; then
    echo "$ROOT_DIR/$source"
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
OUTPUT_DIR="$ROOT_DIR/local-storage/intermediate/$DATASET"
OUTPUT_FILE="$OUTPUT_DIR/$DATASET.prepared.laz"
INFO_FILE="$OUTPUT_DIR/info.json"
PIPELINE_FILE="$OUTPUT_DIR/prepare.pipeline.json"

echo "=== Pipeline: Prepare ==="

if [ ! -e "$SOURCE_PATH" ]; then
  echo "✗ Error: Source not found: $SOURCE"
  echo "  Expected path: $SOURCE_PATH"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

if [ -d "$SOURCE_PATH" ]; then
  INPUT_FILES=()
  while IFS= read -r input_file; do
    INPUT_FILES+=("$input_file")
  done < <(find "$SOURCE_PATH" -maxdepth 1 -type f \( -name "*.las" -o -name "*.laz" \) | sort)
else
  INPUT_FILES=("$SOURCE_PATH")
fi

if [ "${#INPUT_FILES[@]}" -eq 0 ]; then
  echo "✗ Error: No .las or .laz files found in: $SOURCE_PATH"
  exit 1
fi

# Phase 1: use source CRS, just validate and copy with PDAL
# This ensures the file is readable by PDAL and pdal writers can process it.
echo "→ Dataset: $DATASET"
echo "→ Source:  $SOURCE_PATH"
echo "→ Files:   ${#INPUT_FILES[@]}"
printf '  - %s\n' "${INPUT_FILES[@]}"

# Check SRS from info.json if it exists, otherwise run info
if [ -f "$INFO_FILE" ]; then
  echo "→ Using existing metadata: $INFO_FILE"
else
  echo "→ Running inspect first..."
  bash "$SCRIPT_DIR/inspect.sh" "$SOURCE"
fi

# Read point count from metadata
POINT_COUNT=$(run_tool python -c "
import json
try:
    with open('$INFO_FILE') as f:
        info = json.load(f)
    print(info.get('total_points', 'unknown'))
except Exception as e:
    print('unknown')
" 2>/dev/null)

echo "→ Point count: $POINT_COUNT"

# Phase 1: Pass-through pipeline (keep source CRS, validate readability)
run_tool python -c '
import json
import sys
from pathlib import Path

pipeline_file = Path(sys.argv[1])
output_file = sys.argv[2]
input_files = sys.argv[3:]
pipeline = [{"type": "readers.las", "filename": input_file} for input_file in input_files]
pipeline.append({
    "type": "writers.las",
    "filename": output_file,
    "compression": "laszip",
})
pipeline_file.write_text(json.dumps({"pipeline": pipeline}, indent=2), encoding="utf-8")
' "$PIPELINE_FILE" "$OUTPUT_FILE" "${INPUT_FILES[@]}"

echo "→ Running PDAL pass-through pipeline..."
run_tool pdal pipeline "$PIPELINE_FILE"

if [ -f "$OUTPUT_FILE" ]; then
  SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)
  echo "✓ Prepared file: $OUTPUT_FILE ($SIZE)"
  echo ""
  echo "  Phase 1 Note: Source CRS preserved."
  echo "  If CesiumJS render fails due to CRS mismatch, reproject to EPSG:4978 (ECEF)."
else
  echo "✗ Error: Prepared file was not created."
  exit 1
fi
