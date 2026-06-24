#!/usr/bin/env bash
# pipeline/area-detail.sh — Build a selected-area full-detail wrapper without duplicating PNTS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
DATASET="2404PeruB2"
AREA_ID="area-001"
POSITIONAL_ARGS=()
OVERWRITE_FLAG=""

for arg in "$@"; do
  case "$arg" in
    --overwrite)
      OVERWRITE_FLAG="--overwrite"
      ;;
    -h|--help)
      echo "Usage: npm run pipeline:area:detail -- [dataset] [area-id] [--overwrite]"
      exit 0
      ;;
    --*)
      echo "Unknown option: $arg" >&2
      echo "Usage: npm run pipeline:area:detail -- [dataset] [area-id] [--overwrite]" >&2
      exit 2
      ;;
    *)
      POSITIONAL_ARGS+=("$arg")
      ;;
  esac
done

if [ "${#POSITIONAL_ARGS[@]}" -gt 0 ]; then
  DATASET="${POSITIONAL_ARGS[0]}"
fi
if [ "${#POSITIONAL_ARGS[@]}" -gt 1 ]; then
  AREA_ID="${POSITIONAL_ARGS[1]}"
fi
if [ "${#POSITIONAL_ARGS[@]}" -gt 2 ]; then
  echo "Too many positional arguments: ${POSITIONAL_ARGS[*]}" >&2
  echo "Usage: npm run pipeline:area:detail -- [dataset] [area-id] [--overwrite]" >&2
  exit 2
fi

OUTPUT_DATASET="$(pointcloud_public_dataset "$DATASET-detail-p100/areas/$AREA_ID")"
OUTPUT_DIR="$ROOT_DIR/local-storage/tilesets/$OUTPUT_DATASET"

if [ "${POINTCLOUD_AREA_OVERWRITE:-0}" = "1" ]; then
  OVERWRITE_FLAG="--overwrite"
fi

PUBLIC_ROOT="$(pointcloud_public_root)"
AREA_MANIFEST_ARGS=(
  "$SCRIPT_DIR/area_manifest.py" detail
  --root "$ROOT_DIR"
  --dataset "$DATASET"
  --area-id "$AREA_ID"
)

if [ -n "$PUBLIC_ROOT" ]; then
  AREA_MANIFEST_ARGS+=(--public-root "$PUBLIC_ROOT")
fi
if [ -n "$OVERWRITE_FLAG" ]; then
  AREA_MANIFEST_ARGS+=("$OVERWRITE_FLAG")
fi

python3 "${AREA_MANIFEST_ARGS[@]}"

python3 "$SCRIPT_DIR/dataset_report.py" \
  --root "$ROOT_DIR" \
  --dataset "$OUTPUT_DATASET" \
  --source-dataset "$DATASET" \
  --source-type copc-area-full-reference \
  --tiles-dir "$OUTPUT_DIR"

echo ""
echo "✓ Area detail wrapper generated:"
echo "  dataset : $OUTPUT_DATASET"
echo "  output  : $OUTPUT_DIR"
