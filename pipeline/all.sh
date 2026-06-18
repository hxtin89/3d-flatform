#!/usr/bin/env bash
# pipeline/all.sh — Run the complete pipeline: download → inspect → prepare → copc → tiles
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATASET="${1:-autzen}"

echo "╔══════════════════════════════════════════════════╗"
echo "║   SBB Point Cloud Pipeline — Full Run            ║"
echo "║   download → inspect → prepare → copc → tiles    ║"
echo "╚══════════════════════════════════════════════════╝"
echo "Dataset: $DATASET"
echo ""

run_step() {
  local name="$1"
  local script="$2"
  echo ""
  echo "▶ Step: $name"
  echo "─────────────────────────────────────────────────"
  if bash "$SCRIPT_DIR/$script" "$DATASET"; then
    echo "─────────────────────────────────────────────────"
    echo "✓ $name complete"
  else
    echo "✗ $name FAILED — aborting pipeline."
    exit 1
  fi
}

START_TIME=$(date +%s)

run_step "Download"   "download.sh"
run_step "Inspect"    "inspect.sh"
run_step "Prepare"    "prepare.sh"
run_step "COPC"       "copc.sh"
run_step "3D Tiles"   "tiles.sh"
run_step "COPC 3D Tiles" "copc-tiles.sh"

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
