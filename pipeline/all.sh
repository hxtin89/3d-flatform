#!/usr/bin/env bash
# pipeline/all.sh — Run the complete pipeline: download → inspect → prepare → copc → tiles
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${1:-autzen}"

dataset_from_source() {
  local source="$1"
  local base

  if [ -d "$source" ]; then
    basename "$source"
    return
  fi

  base="$(basename "$source")"
  base="${base%.copc.laz}"
  base="${base%.prepared.laz}"
  base="${base%.standard.laz}"
  base="${base%.laz}"
  base="${base%.las}"
  echo "$base"
}

DATASET="$(dataset_from_source "$SOURCE")"

echo "╔══════════════════════════════════════════════════╗"
echo "║   SBB Point Cloud Pipeline — Full Run            ║"
echo "║   download → inspect → prepare → copc → tiles    ║"
echo "╚══════════════════════════════════════════════════╝"
echo "Source:  $SOURCE"
echo "Dataset: $DATASET"
echo ""

run_step() {
  local name="$1"
  local script="$2"
  local arg="$3"
  echo ""
  echo "▶ Step: $name"
  echo "─────────────────────────────────────────────────"
  if bash "$SCRIPT_DIR/$script" "$arg"; then
    echo "─────────────────────────────────────────────────"
    echo "✓ $name complete"
  else
    echo "✗ $name FAILED — aborting pipeline."
    exit 1
  fi
}

START_TIME=$(date +%s)

run_step "Download"   "download.sh" "$SOURCE"
run_step "Inspect"    "inspect.sh" "$SOURCE"
run_step "Prepare"    "prepare.sh" "$SOURCE"
run_step "COPC"       "copc.sh" "$DATASET"
run_step "3D Tiles"   "tiles.sh" "$DATASET"
run_step "COPC 3D Tiles" "copc-tiles.sh" "$DATASET"

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✓ Pipeline complete in ${ELAPSED}s                       ║"
echo "║                                                  ║"
echo "║   Next steps:                                    ║"
echo "║   1. npm run pipeline:serve    (port 8081)       ║"
echo "║   2. npm run viewer:dev        (port 5173)       ║"
echo "╚══════════════════════════════════════════════════╝"
