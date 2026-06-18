#!/usr/bin/env bash
# pipeline/inspect.sh — Run PDAL info on source LAS/LAZ files and save metadata JSON
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
OUTPUT_FILE="$OUTPUT_DIR/info.json"

echo "=== Pipeline: Inspect ==="

if [ ! -e "$SOURCE_PATH" ]; then
  echo "✗ Error: Source not found: $SOURCE"
  echo "  Expected path: $SOURCE_PATH"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "→ Dataset: $DATASET"
echo "→ Source:  $SOURCE_PATH"

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

echo "→ Files: ${#INPUT_FILES[@]}"
run_tool python -c '
import json
import subprocess
import sys
from pathlib import Path

output_file = Path(sys.argv[1])
dataset = sys.argv[2]
input_files = sys.argv[3:]
files = []
total_points = 0

for input_file in input_files:
    result = subprocess.run(
        ["pdal", "info", input_file, "--summary"],
        check=True,
        capture_output=True,
        text=True,
    )
    info = json.loads(result.stdout)
    summary = info.get("summary", {})
    points = summary.get("num_points")
    if isinstance(points, int):
        total_points += points
    files.append({
        "path": input_file,
        "summary": summary,
    })

output_file.write_text(json.dumps({
    "dataset": dataset,
    "files": files,
    "file_count": len(files),
    "total_points": total_points,
}, indent=2), encoding="utf-8")
' "$OUTPUT_FILE" "$DATASET" "${INPUT_FILES[@]}"

echo "✓ Metadata saved: $OUTPUT_FILE"
echo ""
echo "--- Summary ---"
run_tool python -c '
import json, sys
with open(sys.argv[1]) as f:
    info = json.load(f)
print("Dataset: {}".format(info.get("dataset", "N/A")))
print("Files  : {}".format(info.get("file_count", "N/A")))
print("Points : {}".format(info.get("total_points", "N/A")))
for file_info in info.get("files", []):
    summary = file_info.get("summary", {})
    bounds = summary.get("bounds", "N/A")
    points = summary.get("num_points", "N/A")
    print("- {}: {} points, bounds={}".format(file_info.get("path"), points, bounds))
' "$OUTPUT_FILE" 2>/dev/null || echo "(Run 'cat $OUTPUT_FILE | python3 -m json.tool' to see full metadata)"
