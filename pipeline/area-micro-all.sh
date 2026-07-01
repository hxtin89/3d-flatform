#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"
DATASET="${1:-2404PeruB2}"
shift || true
MANIFEST="$(pointcloud_manifest_path "$ROOT_DIR" "$DATASET")"

while IFS= read -r area_id; do
  bash "$SCRIPT_DIR/area-micro-detail.sh" build "$DATASET" "$area_id" "$@"
done < <(python3 - "$MANIFEST" <<'PY'
import json, sys
for area in json.load(open(sys.argv[1], encoding="utf-8")).get("areas", []):
    print(area["areaId"])
PY
)
