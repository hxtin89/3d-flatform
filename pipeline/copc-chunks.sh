#!/usr/bin/env bash
# pipeline/copc-chunks.sh — Convert spatial LAZ chunks to COPC one chunk at a time.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-autzen}"
INPUT_DIR="$ROOT_DIR/local-storage/intermediate/$DATASET/chunks-laz"
OUTPUT_DIR="$ROOT_DIR/local-storage/intermediate/$DATASET/chunks-copc"
PIPELINE_DIR="$ROOT_DIR/local-storage/intermediate/$DATASET/chunk-copc-pipelines"
COPC_THREADS="${COPC_THREADS:-1}"
COPC_CHUNK_LIMIT="${COPC_CHUNK_LIMIT:-0}"
COPC_CHUNK_OVERWRITE="${COPC_CHUNK_OVERWRITE:-0}"

echo "=== Pipeline: Chunk COPC Generation ==="

if [ ! -d "$INPUT_DIR" ]; then
  echo "✗ Error: Chunk LAZ directory not found: $INPUT_DIR"
  echo "  Run: npm run pipeline:chunk -- $DATASET"
  exit 1
fi

mkdir -p "$OUTPUT_DIR" "$PIPELINE_DIR"

echo "→ Dataset: $DATASET"
echo "→ Input:   $INPUT_DIR"
echo "→ Output:  $OUTPUT_DIR"
echo "→ Threads: $COPC_THREADS"

PROCESSED=0
SKIPPED=0
FAILED=0

while IFS= read -r chunk_file; do
  chunk_name="$(basename "$chunk_file" .laz)"
  output_file="$OUTPUT_DIR/$chunk_name.copc.laz"
  pipeline_file="$PIPELINE_DIR/$chunk_name.pipeline.json"

  if [ "$COPC_CHUNK_LIMIT" != "0" ] && [ "$PROCESSED" -ge "$COPC_CHUNK_LIMIT" ]; then
    break
  fi

  if [ -f "$output_file" ] && [ "$COPC_CHUNK_OVERWRITE" != "1" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  run_tool python -c '
import json
import sys
from pathlib import Path

pipeline_file = Path(sys.argv[1])
input_file = sys.argv[2]
output_file = sys.argv[3]
threads = int(sys.argv[4])

pipeline = [
    {"type": "readers.las", "filename": input_file},
    {"type": "writers.copc", "filename": output_file, "threads": threads},
]
pipeline_file.write_text(json.dumps({"pipeline": pipeline}, indent=2), encoding="utf-8")
' "$pipeline_file" "$chunk_file" "$output_file" "$COPC_THREADS"

  echo "→ COPC chunk: $chunk_name"
  if run_tool pdal pipeline "$pipeline_file"; then
    PROCESSED=$((PROCESSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "✗ Failed chunk: $chunk_name"
    break
  fi
done < <(find "$INPUT_DIR" -maxdepth 1 -type f -name "*.laz" | sort)

COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name "*.copc.laz" | wc -l | tr -d ' ')
SIZE=$(du -sh "$OUTPUT_DIR" | cut -f1)

echo "✓ COPC chunks available: $COUNT files ($SIZE)"
echo "  Processed: $PROCESSED"
echo "  Skipped:   $SKIPPED"
echo "  Failed:    $FAILED"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

echo "  Next: npm run pipeline:tiles:copc:chunks -- $DATASET"
