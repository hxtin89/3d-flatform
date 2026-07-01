#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"

COMMAND="${1:-build}"
shift || true
DATASET="${1:-2404PeruB2}"
AREA_ID="${2:-area-015}"
shift $(( $# > 1 ? 2 : $# )) || true
CONDA_ENV_PYTHON="${CONDA_ENV_PYTHON:-/Volumes/WD_BLACK/conda/envs/$CONDA_ENV/bin/python}"
PYTHON_BIN="$CONDA_ENV_PYTHON"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="python3"
fi

ARGS=(
  "$SCRIPT_DIR/micro_detail.py" "$COMMAND"
  --root "$ROOT_DIR"
  --dataset "$DATASET"
  --area-id "$AREA_ID"
  --python "$PYTHON_BIN"
  --base-depth "${MICRO_DETAIL_BASE_DEPTH:-2}"
  --max-depth "${MICRO_DETAIL_MAX_DEPTH:-4}"
  --max-points "${MICRO_DETAIL_MAX_POINTS:-8000000}"
  --group-levels "${MICRO_DETAIL_GROUP_LEVELS:-3,4,5}"
  --target-tile-bytes "${MICRO_DETAIL_TARGET_TILE_BYTES:-524288}"
  --min-average-tile-bytes "${MICRO_DETAIL_MIN_AVERAGE_TILE_BYTES:-256000}"
  --hard-max-tile-bytes "${MICRO_DETAIL_HARD_MAX_TILE_BYTES:-5242880}"
  --max-tiles "${MICRO_DETAIL_MAX_TILES:-250}"
)

PUBLIC_ROOT="$(pointcloud_public_root)"
if [ -n "$PUBLIC_ROOT" ]; then
  ARGS+=(--public-root "$PUBLIC_ROOT")
fi
for arg in "$@"; do
  case "$arg" in
    --overwrite) ARGS+=(--overwrite) ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

"$PYTHON_BIN" "${ARGS[@]}"
