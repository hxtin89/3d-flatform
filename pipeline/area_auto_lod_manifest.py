#!/usr/bin/env python3
"""Build the self-contained auto-LOD manifest (`area-manifest-auto-lod.json`).

This generator is intentionally separate from the legacy `area_manifest.py`
(see plan: plans/plan-auto-lod.md). It only reads the existing
`area-manifest.json`, recomputes dataset readyness from the filesystem, and
emits a self-contained contract used by the viewer's `?lod=auto` mode.
It does NOT modify `area-manifest.json` or any built PNTS/tileset.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

VERSION = 1
MODE = "auto-lod"

DEFAULT_THRESHOLDS: dict[str, float] = {
    "p10EnterRatio": 2.5,
    "p10ExitRatio": 3.0,
    "p100EnterRatio": 0.75,
    "p100ExitRatio": 0.9,
    "settleMs": 750,
    "visibleTimeoutMs": 10000,
    "retryMs": 30000,
}

LEVEL_PRESETS = {
    "p02": {"scope": "global", "preset": "low"},
    "p10": {"scope": "area", "preset": "medium"},
    "p100": {"scope": "area", "preset": "high"},
}

STATUS_READY = "ready"
STATUS_NOT_BUILT = "not_built"


class ManifestError(ValueError):
    """Raised when the source manifest or produced auto-LOD manifest is invalid."""


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise ManifestError(f"Failed to read JSON {path}: {err}") from err


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write to a sibling temp file and rename for atomic publish.
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            fp.write(json.dumps(value, indent=2))
            fp.write("\n")
        os.replace(tmp_name, path)
        os.chmod(path, 0o644)
    except OSError as err:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise ManifestError(f"Failed to write {path}: {err}") from err


def status_for(tilesets_dir: Path, dataset: str) -> str:
    return STATUS_READY if (tilesets_dir / dataset / "tileset.json").exists() else STATUS_NOT_BUILT


def bbox_is_valid(bounds: list[Any]) -> bool:
    if not isinstance(bounds, list) or len(bounds) != 6:
        return False
    if not all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
        for v in bounds
    ):
        return False
    minx, miny, minz, maxx, maxy, maxz = bounds
    return maxx >= minx and maxy >= miny and maxz >= minz


def validate_thresholds(thresholds: dict[str, float]) -> None:
    required = [
        "p10EnterRatio", "p10ExitRatio",
        "p100EnterRatio", "p100ExitRatio",
        "settleMs", "visibleTimeoutMs", "retryMs",
    ]
    for key in required:
        if key not in thresholds:
            raise ManifestError(f"Missing threshold: {key}")
        value = thresholds[key]
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise ManifestError(f"Threshold {key} must be a finite number, got {value!r}")

    if not (0 < thresholds["p100EnterRatio"] < thresholds["p100ExitRatio"]):
        raise ManifestError("p100EnterRatio must satisfy 0 < enter < p100ExitRatio")
    if not (thresholds["p100ExitRatio"] < thresholds["p10EnterRatio"] < thresholds["p10ExitRatio"]):
        raise ManifestError(
            "Threshold ordering violated: p100ExitRatio < p10EnterRatio < p10ExitRatio"
        )
    if thresholds["settleMs"] < 0 or thresholds["visibleTimeoutMs"] <= 0 or thresholds["retryMs"] <= 0:
        raise ManifestError("settleMs >= 0; visibleTimeoutMs and retryMs must be > 0")


def build_area_entry(tilesets_dir: Path, area: dict[str, Any]) -> dict[str, Any]:
    area_id = area.get("areaId")
    chunk_id = area.get("sourceChunkId")
    if not isinstance(area_id, str) or not area_id:
        raise ManifestError(f"Area has invalid areaId: {area_id!r}")
    if not isinstance(chunk_id, str) or not chunk_id:
        raise ManifestError(f"Area {area_id} has invalid sourceChunkId: {chunk_id!r}")

    bbox = area.get("bbox")
    if not bbox_is_valid(bbox):
        raise ManifestError(f"Area {area_id} has invalid bbox: {bbox!r}")

    datasets = area.get("datasets") if isinstance(area.get("datasets"), dict) else {}

    explore = datasets.get("explore") or {}
    detail = datasets.get("detail") or {}

    explore_dataset = explore.get("dataset") if isinstance(explore.get("dataset"), str) else None
    detail_dataset = detail.get("dataset") if isinstance(detail.get("dataset"), str) else None
    if not explore_dataset or not explore_dataset.strip():
        raise ManifestError(f"Area {area_id} has no valid explore/p10 dataset path")
    if not detail_dataset or not detail_dataset.strip():
        raise ManifestError(f"Area {area_id} has no valid detail/p100 dataset path")

    p10 = {
        "dataset": explore_dataset,
        "status": status_for(tilesets_dir, explore_dataset),
    }
    p100 = {
        "dataset": detail_dataset,
        "status": status_for(tilesets_dir, detail_dataset),
    }

    point_count = area.get("pointCount")
    if point_count is not None and not (
        isinstance(point_count, int) and not isinstance(point_count, bool) and point_count >= 0
    ):
        raise ManifestError(f"Area {area_id} has invalid pointCount: {point_count!r}")

    return {
        "areaId": area_id,
        "label": area.get("label") or area_id,
        "sourceChunkId": chunk_id,
        "bbox": list(bbox),
        "sourceBbox": list(area["sourceBbox"]) if bbox_is_valid(area.get("sourceBbox")) else None,
        "pointCount": point_count,
        "levels": {
            "p10": p10,
            "p100": p100,
        },
    }


def build_auto_lod_manifest(
    root: Path,
    logical_dataset: str,
    thresholds: dict[str, float] | None = None,
    source_manifest_path: Path | None = None,
) -> dict[str, Any]:
    tilesets_dir = root / "local-storage" / "tilesets"
    logical_dir = tilesets_dir / logical_dataset
    source_path = source_manifest_path or (logical_dir / "area-manifest.json")
    if not source_path.exists():
        raise ManifestError(f"Source area-manifest.json missing: {source_path}")

    source = read_json(source_path)
    if not isinstance(source, dict):
        raise ManifestError("Source area-manifest.json is not an object")
    areas_src = source.get("areas")
    if not isinstance(areas_src, list) or not areas_src:
        raise ManifestError("Source area-manifest.json has no areas list")

    seen_area_ids: set[str] = set()
    seen_chunk_ids: set[str] = set()
    areas: list[dict[str, Any]] = []
    for area in areas_src:
        entry = build_area_entry(tilesets_dir, area)
        if entry["areaId"] in seen_area_ids:
            raise ManifestError(f"Duplicate areaId: {entry['areaId']}")
        if entry["sourceChunkId"] in seen_chunk_ids:
            raise ManifestError(
                f"Duplicate sourceChunkId: {entry['sourceChunkId']} (area {entry['areaId']})"
            )
        seen_area_ids.add(entry["areaId"])
        seen_chunk_ids.add(entry["sourceChunkId"])
        areas.append(entry)

    overview = source.get("datasets", {}).get("overview") or {}
    if not isinstance(overview, dict):
        raise ManifestError("Source manifest datasets.overview must be an object")
    overview_dataset = overview.get("dataset")
    if not isinstance(overview_dataset, str) or not overview_dataset.strip():
        raise ManifestError(
            "Source area-manifest.json has no valid overview dataset; "
            "cannot build auto-LOD manifest."
        )
    p02_dataset = overview_dataset
    p02_status = status_for(tilesets_dir, p02_dataset)

    coordinate_mode = "globe" if source.get("coordinateMode") == "globe" else "local"
    bbox_frame = "enu" if coordinate_mode == "globe" else "source"
    extras: dict[str, Any] = {"bboxFrame": bbox_frame}
    if coordinate_mode == "globe":
        root_transform = source.get("rootTransform")
        if not isinstance(root_transform, list) or len(root_transform) != 16:
            raise ManifestError(
                "Globe-mode source manifest requires rootTransform with 16 finite numbers"
            )
        if not all(
            isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
            for v in root_transform
        ):
            raise ManifestError("rootTransform entries must be finite numbers")
        extras["rootTransform"] = list(root_transform)
        extras["enuOriginSource"] = source.get("enuOriginSource")
        extras["enuOriginEcef"] = source.get("enuOriginEcef")
        extras["enuOriginLonLat"] = source.get("enuOriginLonLat")
    else:
        extras["rootTransform"] = None

    final_thresholds = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    validate_thresholds(final_thresholds)

    return {
        "version": VERSION,
        "dataset": logical_dataset,
        "mode": MODE,
        "coordinateMode": coordinate_mode,
        "defaultLevel": "p02",
        **extras,
        "levels": {
            "p02": {
                "scope": "global",
                "preset": "low",
                "dataset": p02_dataset,
                "status": p02_status,
            },
            "p10": {
                "scope": "area",
                "preset": "medium",
            },
            "p100": {
                "scope": "area",
                "preset": "high",
            },
        },
        "thresholds": final_thresholds,
        "areas": areas,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build area-manifest-auto-lod.json for ?lod=auto viewer mode."
    )
    parser.add_argument("--root", required=True, help="Project root containing local-storage/.")
    parser.add_argument("--dataset", required=True, help="Logical dataset name (e.g. 2404PeruB2).")
    parser.add_argument("--public-root", default="", help="Public root prefix for datasets.")
    parser.add_argument(
        "--source-manifest",
        default="",
        help="Optional explicit path to area-manifest.json. Defaults to <root>/local-storage/tilesets/<logical>/area-manifest.json.",
    )
    return parser.parse_args(argv)


def logical_dataset_for(args: argparse.Namespace) -> str:
    public_root = (args.public_root or "").strip("/")
    return public_root or args.dataset


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = Path(args.root).resolve()
    logical = logical_dataset_for(args)
    source_path = Path(args.source_manifest) if args.source_manifest else None

    try:
        manifest = build_auto_lod_manifest(root, logical, None, source_path)
    except ManifestError as err:
        print(f"✗ {err}", file=sys.stderr)
        return 1

    out_path = root / "local-storage" / "tilesets" / logical / "area-manifest-auto-lod.json"
    try:
        write_json_atomic(out_path, manifest)
    except ManifestError as err:
        print(f"✗ {err}", file=sys.stderr)
        return 1
    ready_p10 = sum(1 for area in manifest["areas"] if area["levels"]["p10"]["status"] == STATUS_READY)
    ready_p100 = sum(1 for area in manifest["areas"] if area["levels"]["p100"]["status"] == STATUS_READY)
    print(f"✓ Auto-LOD manifest: {out_path}")
    print(f"✓ Areas: {len(manifest['areas'])}")
    print(f"✓ p02={manifest['levels']['p02']['status']} p10 ready={ready_p10} p100 ready={ready_p100}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
