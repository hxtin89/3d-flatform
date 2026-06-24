#!/usr/bin/env bash
# pipeline/area-all.sh — Build Explore and/or Detail outputs for every manifest area.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/env.sh"

DATASET="2404PeruB2"
MODE=""
OVERWRITE=0
POSITIONAL_ARGS=()
EXPLORE_AUTO_PACK="${COPC_EXPLORE_AUTO_PACK:-1}"
EXPLORE_AUTO_PACK_LEVELS="${COPC_EXPLORE_AUTO_PACK_LEVELS:-3,4}"
SUMMARY_TMP=""
SUMMARY_PATH=""
FAILED_AREAS=0

usage() {
  cat <<'EOF'
Usage:
  npm run pipeline:area:explore:all -- [dataset] [--overwrite]
  npm run pipeline:area:detail:all -- [dataset] [--overwrite]

Examples:
  npm run pipeline:area:explore:all -- 2404PeruB2 --overwrite
  npm run pipeline:area:detail:all -- 2404PeruB2 --overwrite

Explore auto-pack env:
  COPC_EXPLORE_AUTO_PACK=0 disables per-area selection.
  COPC_EXPLORE_AUTO_PACK_LEVELS=3,4 controls candidate group levels.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      if [ -z "$MODE" ]; then
        echo "Missing value for --mode" >&2
        usage >&2
        exit 2
      fi
      shift 2
      ;;
    --mode=*)
      MODE="${1#--mode=}"
      shift
      ;;
    --explore)
      MODE="explore"
      shift
      ;;
    --detail)
      MODE="detail"
      shift
      ;;
    --overwrite)
      OVERWRITE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      POSITIONAL_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ "${#POSITIONAL_ARGS[@]}" -gt 0 ]; then
  DATASET="${POSITIONAL_ARGS[0]}"
fi
if [ "${#POSITIONAL_ARGS[@]}" -gt 1 ]; then
  echo "Too many positional arguments: ${POSITIONAL_ARGS[*]}" >&2
  usage >&2
  exit 2
fi

case "$MODE" in
  explore|detail) ;;
  "")
    echo "Missing mode. Use pipeline:area:explore:all or pipeline:area:detail:all." >&2
    usage >&2
    exit 2
    ;;
  *)
    echo "Invalid mode: $MODE" >&2
    usage >&2
    exit 2
    ;;
esac

MANIFEST="$(pointcloud_manifest_path "$ROOT_DIR" "$DATASET")"
if [ ! -f "$MANIFEST" ]; then
  bash "$SCRIPT_DIR/area-manifest.sh" "$DATASET"
fi

AREA_IDS=()
while IFS= read -r area_id; do
  AREA_IDS+=("$area_id")
done < <(
  python3 - "$MANIFEST" <<'PY'
import json
import sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
for area in manifest.get("areas", []):
    area_id = area.get("areaId")
    if area_id:
        print(area_id)
PY
)

if [ "${#AREA_IDS[@]}" -eq 0 ]; then
  echo "No areas found in manifest: $MANIFEST" >&2
  exit 1
fi

explore_output_dir() {
  local area_id="$1"
  local output_dataset
  output_dataset="$(pointcloud_public_dataset "${DATASET}-explore-p10/areas/${area_id}")"
  printf '%s/local-storage/tilesets/%s' "$ROOT_DIR" "$output_dataset"
}

explore_summary_path() {
  local output_dataset
  output_dataset="$(pointcloud_public_dataset "${DATASET}-explore-p10")"
  printf '%s/local-storage/tilesets/%s/pack-selection-report.json' "$ROOT_DIR" "$output_dataset"
}

append_summary() {
  local item_json="$1"
  if [ -n "$SUMMARY_TMP" ]; then
    printf '%s\n' "$item_json" >> "$SUMMARY_TMP"
  fi
}

evaluate_explore_pack() {
  local area_id="$1"
  local group_level="$2"
  local out_dir="$3"
  local report_path="$out_dir/dataset-report.json"
  local tileset_path="$out_dir/tileset.json"

  python3 - "$area_id" "$group_level" "$report_path" "$tileset_path" <<'PY'
import json
import math
import sys
from pathlib import Path

area_id, group_level, report_path, tileset_path = sys.argv[1:5]
report_file = Path(report_path)
tileset_file = Path(tileset_path)

def result(status, reasons, metrics=None, tree=None):
    print(json.dumps({
        "areaId": area_id,
        "groupLevel": int(group_level),
        "status": status,
        "reasons": reasons,
        "metrics": metrics or {},
        "tree": tree or {},
    }, separators=(",", ":")))

def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

if not report_file.exists():
    result("failed", ["report_missing"])
    raise SystemExit(0)

try:
    report = json.loads(report_file.read_text(encoding="utf-8"))
except Exception as exc:
    result("failed", [f"report_unreadable:{exc.__class__.__name__}"])
    raise SystemExit(0)

packing = report.get("tilePacking") if isinstance(report.get("tilePacking"), dict) else {}
metrics = {
    "tileCount": report.get("tileCount"),
    "averageTileBytes": report.get("averageTileBytes"),
    "largestTileBytes": report.get("largestTileBytes"),
    "actualDensityRatio": report.get("actualDensityRatio"),
    "tilePacking": {
        "groupLevel": packing.get("groupLevel"),
        "rootGeometricErrorBefore": packing.get("rootGeometricErrorBefore"),
        "rootGeometricErrorAfter": packing.get("rootGeometricErrorAfter"),
    },
}

missing = []
ge_violations = []
visited_tilesets = set()

def scan_tileset(path, parent_ge=None):
    path = path.resolve()
    if path in visited_tilesets:
        return
    visited_tilesets.add(path)
    try:
        tileset = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        missing.append(f"{path}:unreadable:{exc.__class__.__name__}")
        return

    base = path.parent

    def walk(tile, inherited_parent_ge):
        ge = tile.get("geometricError", 0)
        ge = float(ge) if is_number(ge) else 0.0
        if inherited_parent_ge is not None and ge > inherited_parent_ge + 1e-9:
            ge_violations.append({
                "tile": tile.get("content", {}).get("uri"),
                "geometricError": ge,
                "parentGeometricError": inherited_parent_ge,
            })

        content = tile.get("content")
        if isinstance(content, dict) and content.get("uri"):
            content_path = (base / content["uri"]).resolve()
            if not content_path.exists():
                missing.append(str(content_path))
            elif content_path.suffix == ".json":
                scan_tileset(content_path, ge)

        for child in tile.get("children") or []:
            if isinstance(child, dict):
                walk(child, ge)

    root = tileset.get("root")
    if isinstance(root, dict):
        walk(root, parent_ge)
    else:
        missing.append(f"{path}:root_missing")

if tileset_file.exists():
    scan_tileset(tileset_file)
else:
    missing.append(str(tileset_file))

tree = {
    "missingContentUris": len(missing),
    "geometricErrorViolations": len(ge_violations),
}

reasons = []
tile_count = report.get("tileCount")
avg_bytes = report.get("averageTileBytes")
largest_bytes = report.get("largestTileBytes")
density = report.get("actualDensityRatio")
ge_before = packing.get("rootGeometricErrorBefore")
ge_after = packing.get("rootGeometricErrorAfter")

if not is_number(tile_count):
    reasons.append("tileCount_missing")
elif tile_count < 200:
    reasons.append("tileCount_lt_200")
elif tile_count > 1000:
    reasons.append("tileCount_gt_1000")

if not is_number(avg_bytes):
    reasons.append("averageTileBytes_missing")
elif avg_bytes < 102400:
    reasons.append("averageTileBytes_lt_102400")
elif avg_bytes > 512000:
    reasons.append("averageTileBytes_gt_512000")

if not is_number(largest_bytes):
    reasons.append("largestTileBytes_missing")
elif largest_bytes > 5242880:
    reasons.append("largestTileBytes_gt_5242880")

if not is_number(density):
    reasons.append("actualDensityRatio_missing")
elif density < 0.095 or density > 0.105:
    reasons.append("actualDensityRatio_outside_0.095_0.105")

if not is_number(ge_before) or not is_number(ge_after):
    reasons.append("tilePacking_rootGeometricError_missing")
elif ge_after >= ge_before:
    reasons.append("tilePacking_rootGeometricErrorAfter_not_lt_before")

if missing:
    reasons.append("content_uri_missing")
if ge_violations:
    reasons.append("geometricError_not_monotonic")

status = "accepted" if not reasons else "needsReview"
if missing or ge_violations:
    status = "failed"
result(status, reasons, metrics, tree)
PY
}

finalize_explore_summary() {
  if [ -z "$SUMMARY_TMP" ] || [ -z "$SUMMARY_PATH" ]; then
    return
  fi

  mkdir -p "$(dirname "$SUMMARY_PATH")"
  python3 - "$DATASET" "$EXPLORE_AUTO_PACK" "$EXPLORE_AUTO_PACK_LEVELS" "$SUMMARY_TMP" "$SUMMARY_PATH" <<'PY'
import json
import sys
from pathlib import Path

dataset, auto_pack, levels, tmp_path, out_path = sys.argv[1:6]
items = []
tmp = Path(tmp_path)
if tmp.exists():
    for line in tmp.read_text(encoding="utf-8").splitlines():
        if line.strip():
            items.append(json.loads(line))

status_counts = {}
for item in items:
    status = item.get("status", "unknown")
    status_counts[status] = status_counts.get(status, 0) + 1

payload = {
    "dataset": dataset,
    "mode": "explore",
    "autoPack": auto_pack != "0",
    "candidateGroupLevels": [
        int(part.strip()) for part in levels.split(",") if part.strip()
    ],
    "statusCounts": status_counts,
    "areas": items,
}
Path(out_path).write_text(json.dumps(payload, indent=2), encoding="utf-8")
PY
  echo "✓ Explore pack selection report: $SUMMARY_PATH"
}

build_explore_area_once() {
  local area_id="$1"
  local group_level="$2"
  local overwrite="$3"
  if [ "$overwrite" = "1" ]; then
    COPC_TILE_PACK_GROUP_LEVEL="$group_level" \
    COPC_TILE_CHUNK_OVERWRITE=1 \
    bash "$SCRIPT_DIR/area-explore.sh" "$DATASET" "$area_id"
  else
    COPC_TILE_PACK_GROUP_LEVEL="$group_level" \
    bash "$SCRIPT_DIR/area-explore.sh" "$DATASET" "$area_id"
  fi
}

build_explore_area_auto() {
  local area_id="$1"
  local levels_csv="$2"
  local out_dir
  out_dir="$(explore_output_dir "$area_id")"

  IFS=',' read -r -a levels <<< "$levels_csv"
  local tried_json="[]"
  local selected_level="null"
  local final_status="failed"
  local final_reasons_json="[]"
  local final_metrics_json="{}"
  local final_tree_json="{}"
  local attempt_index=0

  for raw_level in "${levels[@]}"; do
    local group_level
    group_level="$(printf '%s' "$raw_level" | tr -d '[:space:]')"
    if [ -z "$group_level" ]; then
      continue
    fi

    local attempt_overwrite="$OVERWRITE"
    if [ "$attempt_index" -gt 0 ]; then
      attempt_overwrite=1
    fi

    echo "→ Explore pack candidate: $area_id groupLevel=$group_level"
    local build_status="success"
    if ! build_explore_area_once "$area_id" "$group_level" "$attempt_overwrite"; then
      build_status="failed"
    fi

    local eval_json
    if [ "$build_status" = "success" ]; then
      eval_json="$(evaluate_explore_pack "$area_id" "$group_level" "$out_dir")"
    else
      eval_json="$(python3 - "$area_id" "$group_level" <<'PY'
import json
import sys
area_id, group_level = sys.argv[1:3]
print(json.dumps({
    "areaId": area_id,
    "groupLevel": int(group_level),
    "status": "failed",
    "reasons": ["build_failed"],
    "metrics": {},
    "tree": {},
}, separators=(",", ":")))
PY
)"
    fi

    tried_json="$(python3 - "$tried_json" "$eval_json" <<'PY'
import json
import sys
items = json.loads(sys.argv[1])
items.append(json.loads(sys.argv[2]))
print(json.dumps(items, separators=(",", ":")))
PY
)"

    local eval_status
    eval_status="$(python3 - "$eval_json" <<'PY'
import json
import sys
print(json.loads(sys.argv[1]).get("status", "failed"))
PY
)"
    local eval_reasons
    eval_reasons="$(python3 - "$eval_json" <<'PY'
import json
import sys
print(json.dumps(json.loads(sys.argv[1]).get("reasons", []), separators=(",", ":")))
PY
)"
    final_reasons_json="$eval_reasons"
    final_metrics_json="$(python3 - "$eval_json" <<'PY'
import json
import sys
print(json.dumps(json.loads(sys.argv[1]).get("metrics", {}), separators=(",", ":")))
PY
)"
    final_tree_json="$(python3 - "$eval_json" <<'PY'
import json
import sys
print(json.dumps(json.loads(sys.argv[1]).get("tree", {}), separators=(",", ":")))
PY
)"

    if [ "$eval_status" = "accepted" ]; then
      selected_level="$group_level"
      if [ "$attempt_index" -eq 0 ]; then
        final_status="accepted"
      else
        final_status="fallbackAccepted"
      fi
      break
    fi

    if [ "$eval_status" = "failed" ]; then
      final_status="failed"
      break
    fi

    final_status="needsReview"
    selected_level="$group_level"

    local should_retry
    should_retry="$(python3 - "$eval_reasons" <<'PY'
import json
import sys
reasons = set(json.loads(sys.argv[1]))
retryable = {
    "tileCount_lt_200",
    "averageTileBytes_gt_512000",
    "largestTileBytes_gt_5242880",
}
blocked = {
    "tileCount_gt_1000",
    "averageTileBytes_lt_102400",
}
print("1" if reasons & retryable and not reasons & blocked else "0")
PY
)"
    if [ "$should_retry" != "1" ]; then
      break
    fi
    attempt_index=$((attempt_index + 1))
  done

  local summary_item
  summary_item="$(python3 - "$area_id" "$selected_level" "$final_status" "$final_reasons_json" "$tried_json" "$final_metrics_json" "$final_tree_json" <<'PY'
import json
import sys
area_id, selected_level, status, reasons, tried, metrics, tree = sys.argv[1:8]
print(json.dumps({
    "areaId": area_id,
    "selectedGroupLevel": None if selected_level == "null" else int(selected_level),
    "triedGroupLevels": [item.get("groupLevel") for item in json.loads(tried)],
    "status": status,
    "reasons": json.loads(reasons),
    "metrics": json.loads(metrics),
    "tree": json.loads(tree),
    "attempts": json.loads(tried),
}, separators=(",", ":")))
PY
)"
  append_summary "$summary_item"

  case "$final_status" in
    accepted|fallbackAccepted)
      echo "✓ Explore $area_id pack $final_status"
      ;;
    needsReview)
      echo "⚠ Explore $area_id needs review: $final_reasons_json"
      ;;
    failed)
      echo "✗ Explore $area_id failed: $final_reasons_json" >&2
      FAILED_AREAS=$((FAILED_AREAS + 1))
      ;;
  esac
}

if [ "$MODE" = "explore" ] && [ "$EXPLORE_AUTO_PACK" != "0" ]; then
  SUMMARY_PATH="$(explore_summary_path)"
  SUMMARY_TMP="$(mktemp "${TMPDIR:-/tmp}/explore-pack-selection.XXXXXX")"
fi

echo "Building mode=$MODE for dataset=$DATASET across ${#AREA_IDS[@]} areas"

for area_id in "${AREA_IDS[@]}"; do
  if [ "$MODE" = "explore" ]; then
    echo ""
    echo "== Explore $area_id =="
    if [ "$EXPLORE_AUTO_PACK" != "0" ]; then
      build_explore_area_auto "$area_id" "$EXPLORE_AUTO_PACK_LEVELS"
    elif [ "$OVERWRITE" = "1" ]; then
      COPC_TILE_CHUNK_OVERWRITE=1 bash "$SCRIPT_DIR/area-explore.sh" "$DATASET" "$area_id"
    else
      bash "$SCRIPT_DIR/area-explore.sh" "$DATASET" "$area_id"
    fi
  fi

  if [ "$MODE" = "detail" ]; then
    echo ""
    echo "== Detail $area_id =="
    if [ "$OVERWRITE" = "1" ]; then
      bash "$SCRIPT_DIR/area-detail.sh" "$DATASET" "$area_id" --overwrite
    else
      bash "$SCRIPT_DIR/area-detail.sh" "$DATASET" "$area_id"
    fi
  fi
done

bash "$SCRIPT_DIR/area-manifest.sh" "$DATASET"
finalize_explore_summary

echo ""
echo "✓ Area build complete:"
echo "  dataset : $DATASET"
echo "  mode    : $MODE"
echo "  areas   : ${#AREA_IDS[@]}"

if [ "$FAILED_AREAS" -gt 0 ]; then
  echo "✗ Explore auto pack failed for $FAILED_AREAS area(s)." >&2
  exit 1
fi
