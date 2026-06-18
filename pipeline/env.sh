#!/usr/bin/env bash
# Shared tool resolution for the local point cloud pipeline.

CONDA_BIN="${CONDA_BIN:-/Volumes/WD_BLACK/conda/miniforge/bin/conda}"
CONDA_ENV="${CONDA_ENV:-pointcloud-pipeline}"

run_tool() {
  local tool="$1"
  shift

  if command -v "$tool" &>/dev/null; then
    "$tool" "$@"
    return
  fi

  if [ -x "$CONDA_BIN" ]; then
    "$CONDA_BIN" run -n "$CONDA_ENV" "$tool" "$@"
    return
  fi

  echo "✗ $tool not found in PATH, and conda fallback is unavailable." >&2
  echo "  Expected conda: $CONDA_BIN" >&2
  echo "  Expected env  : $CONDA_ENV" >&2
  exit 1
}

has_tool() {
  local tool="$1"

  if command -v "$tool" &>/dev/null; then
    return 0
  fi

  if [ -x "$CONDA_BIN" ]; then
    "$CONDA_BIN" run -n "$CONDA_ENV" "$tool" --help &>/dev/null
    return $?
  fi

  return 1
}
