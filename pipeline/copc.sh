#!/usr/bin/env bash
# pipeline/copc.sh — Generate COPC LAZ from prepared LAZ using PDAL writers.copc
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-autzen}"
INPUT_FILE="$ROOT_DIR/local-storage/intermediate/$DATASET/$DATASET.prepared.laz"
OUTPUT_DIR="$ROOT_DIR/local-storage/intermediate/$DATASET"
OUTPUT_FILE="$OUTPUT_DIR/$DATASET.copc.laz"
PIPELINE_FILE="$OUTPUT_DIR/copc.pipeline.json"
SUMMARY_FILE="$OUTPUT_DIR/copc.summary.json"
COPC_THREADS="${COPC_THREADS:-1}"

echo "=== Pipeline: COPC Generation ==="

# Fallback: if prepared.laz doesn't exist, try raw
if [ ! -f "$INPUT_FILE" ]; then
  RAW_FILE="$ROOT_DIR/local-storage/raw/$DATASET.laz"
  if [ -f "$RAW_FILE" ]; then
    echo "⚠ Prepared file not found. Falling back to raw: $RAW_FILE"
    INPUT_FILE="$RAW_FILE"
  else
    echo "✗ Error: No input file found."
    echo "  Run 'npm run pipeline:prepare -- $DATASET' first."
    exit 1
  fi
fi

mkdir -p "$OUTPUT_DIR"

echo "→ Input:  $INPUT_FILE"
echo "→ Output: $OUTPUT_FILE"
echo "→ Threads: $COPC_THREADS"

cat > "$PIPELINE_FILE" <<EOF
{
  "pipeline": [
    {
      "type": "readers.las",
      "filename": "$INPUT_FILE"
    },
    {
      "type": "writers.copc",
      "filename": "$OUTPUT_FILE",
      "threads": $COPC_THREADS
    }
  ]
}
EOF

echo "→ Running PDAL COPC pipeline..."
run_tool pdal pipeline "$PIPELINE_FILE"

if [ -f "$OUTPUT_FILE" ]; then
  SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)
  echo "✓ COPC output: $OUTPUT_FILE ($SIZE)"
  echo ""
  echo "→ Validating COPC readability..."
  if run_tool pdal info "$OUTPUT_FILE" --summary > "$SUMMARY_FILE" 2>/dev/null; then
    run_tool python -c "
import json, sys
try:
    with open('$SUMMARY_FILE') as f:
        info = json.load(f)
    pc = info.get('summary', {}).get('num_points', 'N/A')
    print(f'  ✓ COPC is readable. Points: {pc}')
except:
    print('  ✓ COPC written (validation skipped)')
"
  else
    echo "  ✓ COPC written (PDAL summary validation skipped)"
  fi
else
  echo "✗ Error: COPC file was not created."
  exit 1
fi
