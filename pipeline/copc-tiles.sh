#!/usr/bin/env bash
# pipeline/copc-tiles.sh — Convert COPC LAZ directly to local 3D Tiles PNTS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
SOURCE="${1:-}"

find_copc_file() {
  local source_dir="$1"
  local copc_files=()
  local copc_file

  while IFS= read -r copc_file; do
    copc_files+=("$copc_file")
  done < <(find "$source_dir" -maxdepth 1 -type f -name "*.copc.laz" | sort)

  if [ "${#copc_files[@]}" -eq 0 ]; then
    echo "✗ Error: No .copc.laz file found in: $source_dir" >&2
    exit 1
  fi

  if [ "${#copc_files[@]}" -gt 1 ]; then
    echo "✗ Error: Multiple .copc.laz files found in: $source_dir" >&2
    echo "  Pass a specific file path instead:" >&2
    printf '  - %s\n' "${copc_files[@]}" >&2
    exit 1
  fi

  echo "${copc_files[0]}"
}

if [ -z "$SOURCE" ]; then
  echo "✗ Error: Missing source folder or .copc.laz file." >&2
  echo "  Example: npm run pipeline:tiles:copc -- wi-1" >&2
  exit 1
fi

if [[ "$SOURCE" = /* ]]; then
  SOURCE_PATH="$SOURCE"
elif [ -e "$ROOT_DIR/$SOURCE" ]; then
  SOURCE_PATH="$ROOT_DIR/$SOURCE"
elif [ -e "$ROOT_DIR/local-storage/intermediate/$SOURCE/$SOURCE.copc.laz" ]; then
  SOURCE_PATH="$ROOT_DIR/local-storage/intermediate/$SOURCE/$SOURCE.copc.laz"
else
  SOURCE_PATH="$ROOT_DIR/local-storage/$SOURCE"
fi

if [ -d "$SOURCE_PATH" ]; then
  INPUT_FILE="$(find_copc_file "$SOURCE_PATH")"
  DATASET="$(basename "$SOURCE_PATH")"
elif [ -f "$SOURCE_PATH" ]; then
  INPUT_FILE="$SOURCE_PATH"
  DATASET="$(basename "$(dirname "$SOURCE_PATH")")"
else
  echo "✗ Error: Source not found: $SOURCE" >&2
  exit 1
fi

if [[ "$(basename "$INPUT_FILE")" != *.copc.laz ]]; then
  echo "✗ Error: COPC converter requires a .copc.laz input: $INPUT_FILE" >&2
  exit 1
fi

OUTPUT_DIR="$ROOT_DIR/local-storage/tilesets/$DATASET-copc"
CONDA_ENV_PYTHON="${CONDA_ENV_PYTHON:-/Volumes/WD_BLACK/conda/envs/$CONDA_ENV/bin/python}"
COPC_TILE_COORDINATE_MODE="${COPC_TILE_COORDINATE_MODE:-local}"
COPC_TILE_ENU_ORIGIN_SOURCE="${COPC_TILE_ENU_ORIGIN_SOURCE:-}"

if [ "$COPC_TILE_COORDINATE_MODE" != "local" ] && [ "$COPC_TILE_COORDINATE_MODE" != "globe" ]; then
  echo "✗ Error: COPC_TILE_COORDINATE_MODE must be local or globe." >&2
  exit 1
fi

COORDINATE_ARGS=(--coordinate-mode "$COPC_TILE_COORDINATE_MODE")
if [ "$COPC_TILE_COORDINATE_MODE" = "globe" ] && [ -n "$COPC_TILE_ENU_ORIGIN_SOURCE" ]; then
  COORDINATE_ARGS+=(--enu-origin-source "$COPC_TILE_ENU_ORIGIN_SOURCE")
fi

echo "=== Pipeline: COPC → 3D Tiles PNTS ==="
echo "→ Dataset: $DATASET-copc"
echo "→ Input:   $INPUT_FILE"
echo "→ Output:  $OUTPUT_DIR"
echo "→ Coordinate mode: $COPC_TILE_COORDINATE_MODE"
if [ "$COPC_TILE_COORDINATE_MODE" = "globe" ] && [ -n "$COPC_TILE_ENU_ORIGIN_SOURCE" ]; then
  echo "→ ENU origin: $COPC_TILE_ENU_ORIGIN_SOURCE (source CRS)"
fi

if [ -x "$CONDA_ENV_PYTHON" ]; then
  "$CONDA_ENV_PYTHON" "$SCRIPT_DIR/copc_to_3dtiles.py" \
    "$INPUT_FILE" \
    --out "$OUTPUT_DIR" \
    --dataset "$DATASET-copc" \
    "${COORDINATE_ARGS[@]}" \
    --overwrite
else
  run_tool python "$SCRIPT_DIR/copc_to_3dtiles.py" \
    "$INPUT_FILE" \
    --out "$OUTPUT_DIR" \
    --dataset "$DATASET-copc" \
    "${COORDINATE_ARGS[@]}" \
    --overwrite
fi

run_tool python "$SCRIPT_DIR/dataset_report.py" \
  --root "$ROOT_DIR" \
  --dataset "$DATASET-copc" \
  --source-dataset "$DATASET" \
  --source-type copc-custom \
  --tiles-dir "$OUTPUT_DIR"

echo ""
echo "✓ COPC 3D Tiles generated:"
echo "  tileset.json : $OUTPUT_DIR/tileset.json"
echo "  report       : $OUTPUT_DIR/conversion-report.json"
echo "  dataset report: $OUTPUT_DIR/dataset-report.json"
echo ""
echo "  → Restart tile server after conversion: npm run pipeline:serve"
echo "  → Open viewer: http://localhost:5173/?dataset=$DATASET-copc&debugTiles=1"
