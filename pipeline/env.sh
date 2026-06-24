#!/usr/bin/env bash
# Shared tool resolution for the local point cloud pipeline.

CONDA_BIN="${CONDA_BIN:-/Volumes/WD_BLACK/conda/miniforge/bin/conda}"
CONDA_ENV="${CONDA_ENV:-pointcloud-pipeline}"

pointcloud_public_root() {
  local root="${POINTCLOUD_PUBLIC_ROOT:-}"
  root="${root#/}"
  root="${root%/}"
  printf '%s' "$root"
}

pointcloud_public_dataset() {
  local dataset="$1"
  local root
  root="$(pointcloud_public_root)"

  if [ -z "$root" ] || [ "$dataset" = "$root" ] || [[ "$dataset" == "$root/"* ]]; then
    printf '%s' "$dataset"
    return
  fi

  printf '%s/%s' "$root" "$dataset"
}

pointcloud_logical_dataset() {
  local dataset="$1"
  local root
  root="$(pointcloud_public_root)"

  if [ -n "$root" ]; then
    printf '%s' "$root"
    return
  fi

  printf '%s' "$dataset"
}

pointcloud_manifest_path() {
  local root_dir="$1"
  local dataset="$2"
  printf '%s/local-storage/tilesets/%s/area-manifest.json' \
    "$root_dir" \
    "$(pointcloud_logical_dataset "$dataset")"
}

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
