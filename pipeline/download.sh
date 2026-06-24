#!/usr/bin/env bash
# pipeline/download.sh — Download or verify raw point cloud source
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RAW_DIR="$ROOT_DIR/local-storage/raw"
DATASET="${1:-autzen}"
RAW_DATASET_DIR="$RAW_DIR/$DATASET"
OUTPUT_FILE="$RAW_DIR/$DATASET.laz"
RAW_SOURCE_FILE="$RAW_DIR/$DATASET"

mkdir -p "$RAW_DIR"

echo "=== Pipeline: Download ==="
echo "→ Dataset: $DATASET"

if [[ "$DATASET" = /* ]] && [ -f "$DATASET" ]; then
  SIZE=$(du -sh "$DATASET" | cut -f1)
  echo "✓ Raw source file exists: $DATASET ($SIZE), skipping download."
  exit 0
fi

if [ -f "$RAW_SOURCE_FILE" ]; then
  SIZE=$(du -sh "$RAW_SOURCE_FILE" | cut -f1)
  echo "✓ Raw source file exists: $RAW_SOURCE_FILE ($SIZE), skipping download."
  exit 0
fi

if [ -d "$RAW_DATASET_DIR" ]; then
  FILE_COUNT=$(find "$RAW_DATASET_DIR" -maxdepth 1 -type f \( -name "*.las" -o -name "*.laz" \) | wc -l | tr -d ' ')
  if [ "$FILE_COUNT" -gt 0 ]; then
    SIZE=$(du -sh "$RAW_DATASET_DIR" | cut -f1)
    echo "✓ Raw source exists: $RAW_DATASET_DIR ($SIZE, $FILE_COUNT LAS/LAZ files), skipping download."
    exit 0
  fi
fi

if [ -f "$OUTPUT_FILE" ]; then
  SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)
  echo "✓ Already exists: $OUTPUT_FILE ($SIZE), skipping download."
  exit 0
fi

if [ "$DATASET" != "autzen" ]; then
  echo "✗ Error: Raw source not found for dataset: $DATASET"
  echo "  Expected either:"
  echo "  - $RAW_DATASET_DIR/*.las or *.laz"
  echo "  - $OUTPUT_FILE"
  exit 1
fi

# PDAL official sample data (autzen.laz from PDAL test data)
DOWNLOAD_URL="https://github.com/PDAL/data/raw/main/autzen/autzen.laz"

echo "Target: $OUTPUT_FILE"
echo "→ Downloading from: $DOWNLOAD_URL"
curl -L --progress-bar -o "$OUTPUT_FILE" "$DOWNLOAD_URL"

SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)
echo "✓ Download complete: $OUTPUT_FILE ($SIZE)"
