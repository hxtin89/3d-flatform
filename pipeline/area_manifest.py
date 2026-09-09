#!/usr/bin/env python3
"""Build logical area manifests and area-only wrapper tilesets."""
from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path
from typing import Any



STATUS_READY = "ready"
STATUS_NOT_BUILT = "not_built"
EXPLORE_GROUP_SUFFIX = "explore-p10"
DETAIL_GROUP_SUFFIX = "detail-p100"
OVERVIEW_EXCLUDING_GROUP_SUFFIX = "overview-p02-excluding"
DETAIL_CONTEXT_GROUP_SUFFIX = "overview-p001-excluding"


def public_root(args: argparse.Namespace) -> str:
    return args.public_root.strip("/")


def public_dataset(args: argparse.Namespace, dataset: str) -> str:
    root = public_root(args)
    if not root or dataset == root or dataset.startswith(f"{root}/"):
        return dataset
    return f"{root}/{dataset}"


def logical_dataset(args: argparse.Namespace) -> str:
    return public_root(args) or args.dataset


def manifest_path(tilesets_dir: Path, args: argparse.Namespace) -> Path:
    return tilesets_dir / logical_dataset(args) / "area-manifest.json"


def dataset_dir(tilesets_dir: Path, args: argparse.Namespace, dataset: str) -> Path:
    return tilesets_dir / public_dataset(args, dataset)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def status_for(tilesets_dir: Path, dataset: str) -> str:
    return STATUS_READY if (tilesets_dir / dataset / "tileset.json").exists() else STATUS_NOT_BUILT


def mode_dataset(dataset: str, status: str) -> dict[str, str]:
    return {"dataset": dataset, "status": status}


def chunk_reports(root: Path, args: argparse.Namespace) -> list[tuple[str, Path, dict[str, Any]]]:
    tilesets_dir = root / "local-storage" / "tilesets"
    chunks_dir = dataset_dir(tilesets_dir, args, f"{args.dataset}-chunked-copc") / "chunks"
    reports = []
    for report_path in sorted(chunks_dir.glob("*/conversion-report.json")):
        reports.append((report_path.parent.name, report_path, read_json(report_path)))
    if reports:
        return reports
    return intermediate_copc_reports(root, args, chunks_dir)


def intermediate_copc_reports(
    root: Path,
    args: argparse.Namespace,
    missing_legacy_dir: Path,
) -> list[tuple[str, Path, dict[str, Any]]]:
    """Recreate area records from durable APH inputs without decoding points."""
    intermediate_dir = root / "local-storage" / "intermediate" / args.dataset / "chunks-copc"
    logical = logical_dataset(args)
    aph_dir = root / "local-storage" / "tilesets" / logical / f"{logical}-adaptive-point-hierarchy"
    state_path = aph_dir / ".adaptive-point-hierarchy-state.json"
    files = sorted(intermediate_dir.glob("*.copc.laz"))
    if not files or not state_path.exists():
        raise SystemExit(
            f"No chunk conversion reports found in: {missing_legacy_dir}\n"
            f"APH fallback requires COPC chunks in {intermediate_dir} and state {state_path}"
        )

    state = read_json(state_path)
    required_state = ("enuOriginSource", "rootTransform", "enuOriginLonLat", "enuOriginEcef")
    missing_state = [key for key in required_state if not state.get(key)]
    if missing_state:
        raise SystemExit(f"APH state is missing required manifest metadata: {', '.join(missing_state)}")

    state_sources = state.get("sourceFiles") or []
    expected_sources = {str(item.get("name")): item for item in state_sources}
    actual_names = {path.name for path in files}
    if expected_sources and actual_names != set(expected_sources):
        missing = sorted(set(expected_sources) - actual_names)
        extra = sorted(actual_names - set(expected_sources))
        raise SystemExit(f"APH source files do not match intermediate COPC chunks: missing={missing}, extra={extra}")
    for path in files:
        expected_size = int(expected_sources.get(path.name, {}).get("size") or path.stat().st_size)
        if path.stat().st_size != expected_size:
            raise SystemExit(f"APH source size changed since build: {path}")

    # Legacy reports and --help do not require the point-cloud toolchain.
    import numpy as np
    from laspy import open as open_las
    from build_adaptive_point_hierarchy import build_enu_frame, transform_bounds_to_enu

    with open_las(files[0]) as reader:
        source_crs = reader.header.parse_crs()
    if source_crs is None:
        raise SystemExit(f"COPC source has no CRS: {files[0]}")
    frame = build_enu_frame(source_crs, np.asarray(state["enuOriginSource"], dtype=np.float64))
    if not np.allclose(frame["root_transform"], state["rootTransform"], rtol=0, atol=1e-6):
        raise SystemExit("Intermediate COPC CRS/origin does not reproduce the durable APH root transform")

    reports: list[tuple[str, Path, dict[str, Any]]] = []
    total_points = 0
    for path in files:
        with open_las(path) as reader:
            mins = np.asarray(reader.header.mins, dtype=np.float64)
            maxs = np.asarray(reader.header.maxs, dtype=np.float64)
            point_count = int(reader.header.point_count)
        enu_mins, enu_maxs = transform_bounds_to_enu(mins, maxs, frame)
        total_points += point_count
        chunk_id = path.name.removesuffix(".copc.laz")
        reports.append((chunk_id, path, {
            "coordinateMode": "globe",
            "root_transform": state["rootTransform"],
            "enuOriginSource": state["enuOriginSource"],
            "enuOriginEcef": state["enuOriginEcef"],
            "enuOriginLonLat": state["enuOriginLonLat"],
            "source_bbox": {"mins": mins.tolist(), "maxs": maxs.tolist()},
            "root_bbox_enu": {"mins": enu_mins.tolist(), "maxs": enu_maxs.tolist()},
            "source_point_count": point_count,
        }))

    expected_total = int(state.get("totalSourcePoints") or 0)
    if expected_total and total_points != expected_total:
        raise SystemExit(
            f"Intermediate COPC point total does not match APH state: {total_points} != {expected_total}"
        )
    print(f"ℹ Area manifest source: {len(files)} intermediate COPC headers + durable APH state")
    return reports


def chunked_report(root: Path, args: argparse.Namespace) -> dict[str, Any]:
    tilesets_dir = root / "local-storage" / "tilesets"
    report_path = dataset_dir(tilesets_dir, args, f"{args.dataset}-chunked-copc") / "chunked-conversion-report.json"
    return read_json(report_path) if report_path.exists() else {}


def bbox_values(bbox: dict[str, Any]) -> list[Any]:
    mins = bbox.get("mins") or [0, 0, 0]
    maxs = bbox.get("maxs") or [0, 0, 0]
    return [*mins, *maxs]


def build_manifest(args: argparse.Namespace) -> None:
    root = Path(args.root).resolve()
    dataset = args.dataset
    tilesets_dir = root / "local-storage" / "tilesets"
    logical_dir = tilesets_dir / logical_dataset(args)
    reports = chunk_reports(root, args)
    group_report = chunked_report(root, args)
    globe_mode = all((report.get("coordinateMode") == "globe") for _, _, report in reports)
    manifest_extras: dict[str, Any] = {}
    if globe_mode:
        root_transform = group_report.get("root_transform") or next(
            (report.get("root_transform") for _, _, report in reports if report.get("root_transform")),
            None,
        )
        manifest_extras = {
            "coordinateMode": "globe",
            "bboxFrame": "enu",
            "rootTransform": root_transform,
            "enuOriginSource": group_report.get("enuOriginSource") or reports[0][2].get("enuOriginSource"),
            "enuOriginEcef": group_report.get("enuOriginEcef") or reports[0][2].get("enuOriginEcef"),
            "enuOriginLonLat": group_report.get("enuOriginLonLat") or reports[0][2].get("enuOriginLonLat"),
        }
    else:
        manifest_extras = {
            "coordinateMode": "local",
            "bboxFrame": "source",
        }

    areas = []
    for index, (chunk_id, _, report) in enumerate(reports, start=1):
        area_id = f"area-{index:03d}"
        source_bbox = report.get("source_bbox") or report.get("root_bbox") or {}
        area_bbox = report.get("root_bbox_enu") if globe_mode else source_bbox
        area_bbox = area_bbox or source_bbox
        explore_dataset = public_dataset(args, f"{dataset}-{EXPLORE_GROUP_SUFFIX}/areas/{area_id}")
        detail_dataset = public_dataset(args, f"{dataset}-{DETAIL_GROUP_SUFFIX}/areas/{area_id}")
        context_dataset = public_dataset(args, f"{dataset}-{DETAIL_CONTEXT_GROUP_SUFFIX}/areas/{area_id}")
        areas.append({
            "areaId": area_id,
            "label": f"Area {index:03d}",
            "sourceChunkId": chunk_id,
            "bbox": bbox_values(area_bbox),
            "sourceBbox": bbox_values(source_bbox),
            "pointCount": report.get("source_point_count") or report.get("emitted_point_count"),
            "datasets": {
                "explore": mode_dataset(explore_dataset, status_for(tilesets_dir, explore_dataset)),
                "detail": mode_dataset(detail_dataset, status_for(tilesets_dir, detail_dataset)),
                "context": mode_dataset(context_dataset, status_for(tilesets_dir, context_dataset)),
            },
        })

    overview_dataset = public_dataset(args, f"{dataset}-overview-p02")
    manifest = {
        "dataset": logical_dataset(args),
        "defaultMode": "overview",
        "defaultAreaId": areas[0]["areaId"] if areas else None,
        "datasets": {
            "overview": mode_dataset(overview_dataset, status_for(tilesets_dir, overview_dataset)),
        },
        "areas": areas,
        **manifest_extras,
    }
    write_json(logical_dir / "area-manifest.json", manifest)
    print(f"✓ Area manifest: {logical_dir / 'area-manifest.json'}")
    print(f"✓ Areas: {len(areas)}")


def content_uri(child: dict[str, Any]) -> str | None:
    content = child.get("content")
    if not isinstance(content, dict):
        return None
    uri = content.get("uri") or content.get("url")
    return uri if isinstance(uri, str) else None


def build_overview_excluding_wrappers(args: argparse.Namespace) -> None:
    root = Path(args.root).resolve()
    dataset = args.dataset
    tilesets_dir = root / "local-storage" / "tilesets"
    overview_dataset = args.overview_dataset or f"{dataset}-overview-{args.density_target}"
    output_suffix = args.output_suffix or f"overview-{args.density_target}-excluding"
    overview_dataset = public_dataset(args, overview_dataset)
    overview_dir = tilesets_dir / overview_dataset
    overview_tileset_path = overview_dir / "tileset.json"
    overview_report_path = overview_dir / "dataset-report.json"
    area_manifest_path = manifest_path(tilesets_dir, args)

    if not overview_tileset_path.exists():
        raise SystemExit(f"Overview tileset missing: {overview_tileset_path}")

    build_manifest(args)
    manifest = read_json(area_manifest_path)
    overview_tileset = read_json(overview_tileset_path)
    overview_report = read_json(overview_report_path) if overview_report_path.exists() else {}
    root_tile = overview_tileset.get("root", {})
    children = root_tile.get("children")
    if not isinstance(children, list):
        raise SystemExit(f"Overview root has no children: {overview_tileset_path}")

    output_group_dataset = public_dataset(args, f"{dataset}-{output_suffix}")
    output_group = tilesets_dir / output_group_dataset
    built = 0
    for area in manifest.get("areas", []):
        area_id = area["areaId"]
        chunk_id = area["sourceChunkId"]
        excluded_uri = f"chunks/{chunk_id}/tileset.json"
        output_dataset = public_dataset(args, f"{dataset}-{output_suffix}/areas/{area_id}")
        output_dir = tilesets_dir / output_dataset
        if output_dir.exists():
            if not args.overwrite:
                continue
            shutil.rmtree(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        kept_children = []
        excluded_count = 0
        for child in children:
            uri = content_uri(child)
            if uri == excluded_uri:
                excluded_count += 1
                continue
            cloned = json.loads(json.dumps(child))
            cloned_uri = content_uri(cloned)
            if cloned_uri:
                target = overview_dir / cloned_uri
                rel_uri = Path(os.path.relpath(target, output_dir)).as_posix()
                cloned.setdefault("content", {})["uri"] = rel_uri
                cloned["content"].pop("url", None)
            kept_children.append(cloned)

        if excluded_count != 1:
            raise SystemExit(
                f"Expected one overview child for {area_id} ({excluded_uri}), found {excluded_count}"
            )

        wrapper = json.loads(json.dumps(overview_tileset))
        wrapper["asset"]["extras"] = {
            **wrapper.get("asset", {}).get("extras", {}),
            "generator": "SBB Overview P02 Excluding Area Wrapper V1",
            "dataset": output_dataset,
            "sourceDataset": dataset,
            "sourceOverviewDataset": overview_dataset,
            "areaId": area_id,
            "excludedAreaId": area_id,
            "excludedSourceChunkId": chunk_id,
            "local_only": True,
        }
        wrapper["root"]["children"] = kept_children
        write_json(output_dir / "tileset.json", wrapper)

        report = {
            **overview_report,
            "dataset": output_dataset,
            "sourceDataset": dataset,
            "sourceType": "copc-overview-excluding-custom",
            "sourceOverviewDataset": overview_dataset,
            "areaId": area_id,
            "excludedAreaId": area_id,
            "excludedSourceChunkId": chunk_id,
            "pointStep": overview_report.get("pointStep", 50),
            "densityTarget": overview_report.get("densityTarget", args.density_target),
            "densityApproximate": overview_report.get("densityApproximate", True),
            "overviewChildCount": len(children),
            "contextChildCount": len(kept_children),
        }
        excluded_report_path = overview_dir / "chunks" / chunk_id / "conversion-report.json"
        if excluded_report_path.exists():
            excluded_report = read_json(excluded_report_path)
            source_points = report.get("sourcePointCount")
            emitted_points = report.get("emittedPointCount")
            tile_count = report.get("tileCount")
            excluded_source_points = int(excluded_report.get("source_point_count") or 0)
            excluded_emitted_points = int(excluded_report.get("emitted_point_count") or 0)
            excluded_tile_count = int(excluded_report.get("tile_count") or 0)
            if isinstance(source_points, int):
                report["sourcePointCount"] = max(source_points - excluded_source_points, 0)
            if isinstance(emitted_points, int):
                report["emittedPointCount"] = max(emitted_points - excluded_emitted_points, 0)
                report["pointCount"] = report["emittedPointCount"]
            if isinstance(tile_count, int):
                report["tileCount"] = max(tile_count - excluded_tile_count, 0)
            if report.get("sourcePointCount"):
                report["actualDensityRatio"] = report.get("emittedPointCount", 0) / report["sourcePointCount"]
        write_json(output_dir / "dataset-report.json", report)
        built += 1

    build_manifest(args)
    print(f"✓ Overview excluding wrappers: {output_group / 'areas'}")
    print(f"✓ Built/updated: {built}")


def build_detail_wrapper(args: argparse.Namespace) -> None:
    root = Path(args.root).resolve()
    dataset = args.dataset
    area_id = args.area_id
    tilesets_dir = root / "local-storage" / "tilesets"
    area_manifest_path = manifest_path(tilesets_dir, args)
    build_manifest(args)
    manifest = read_json(area_manifest_path)
    selected = next((area for area in manifest.get("areas", []) if area.get("areaId") == area_id), None)
    if selected is None:
        raise SystemExit(f"Area not found in manifest: {area_id}")

    chunk_id = selected["sourceChunkId"]
    full_root = dataset_dir(tilesets_dir, args, f"{dataset}-chunked-copc")
    child_dir = full_root / "chunks" / chunk_id
    child_tileset = child_dir / "tileset.json"
    child_report_path = child_dir / "conversion-report.json"
    if not child_tileset.exists() or not child_report_path.exists():
        raise SystemExit(f"Full child tileset missing for {area_id}: {child_dir}")

    output_dataset = selected["datasets"]["detail"]["dataset"]
    output_dir = tilesets_dir / output_dataset
    if output_dir.exists():
        if not args.overwrite:
            raise SystemExit(f"Output exists. Pass --overwrite to replace: {output_dir}")
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    child_report = read_json(child_report_path)
    child_tileset_json = read_json(child_tileset)
    globe_mode = child_report.get("coordinateMode") == "globe"
    source_bbox = (
        child_report.get("root_bbox_enu")
        if globe_mode
        else child_report.get("root_bbox")
    ) or child_report.get("root_bbox") or child_report.get("source_bbox")
    root_transform = child_report.get("root_transform") if globe_mode else None
    geometric_error = (
        child_tileset_json.get("geometricError")
        or child_tileset_json.get("root", {}).get("geometricError")
        or diagonal_from_bbox(source_bbox)
    )
    child_rel_uri = Path(os.path.relpath(child_tileset, output_dir))
    tileset = {
        "asset": {
            "version": "1.0",
            "extras": {
                "generator": "SBB Area Detail Wrapper V1",
                "dataset": output_dataset,
                "sourceDataset": dataset,
                "areaId": area_id,
                "sourceChunkId": chunk_id,
                "local_only": not globe_mode,
                "coordinateMode": "globe" if globe_mode else "local",
            },
        },
        "geometricError": geometric_error,
        "root": {
            "boundingVolume": {"box": box_from_bbox(source_bbox)},
            "geometricError": geometric_error,
            "refine": "ADD",
            "content": {"uri": child_rel_uri.as_posix()},
        },
    }
    if globe_mode:
        if not isinstance(root_transform, list) or len(root_transform) != 16:
            raise SystemExit(f"Globe detail wrapper missing root_transform: {child_report_path}")
        tileset["root"]["transform"] = root_transform
    write_json(output_dir / "tileset.json", tileset)

    report = {
        **child_report,
        "dataset": output_dataset,
        "sourceDataset": dataset,
        "sourceType": "copc-area-full-reference",
        "areaId": area_id,
        "sourceChunkId": chunk_id,
        "pointStep": 1,
        "densityTarget": "full",
        "densityApproximate": False,
        "actualDensityRatio": 1.0,
        "referencedTilesDir": str(child_dir),
    }
    write_json(output_dir / "conversion-report.json", report)
    build_manifest(args)
    print(f"✓ Detail wrapper: {output_dir / 'tileset.json'}")
    print(f"✓ References only area: {chunk_id}")


def box_from_bbox(bbox: dict[str, Any]) -> list[float]:
    mins = bbox["mins"]
    maxs = bbox["maxs"]
    center = [(mins[i] + maxs[i]) / 2 for i in range(3)]
    half = [(maxs[i] - mins[i]) / 2 for i in range(3)]
    return [
        center[0], center[1], center[2],
        half[0], 0, 0,
        0, half[1], 0,
        0, 0, half[2],
    ]


def diagonal_from_bbox(bbox: dict[str, Any]) -> float:
    mins = bbox["mins"]
    maxs = bbox["maxs"]
    return sum((maxs[i] - mins[i]) ** 2 for i in range(3)) ** 0.5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build area manifest or area detail wrapper.")
    parser.add_argument("command", choices=["manifest", "detail", "overview-excluding"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--area-id", default="area-001")
    parser.add_argument("--overview-dataset", default="")
    parser.add_argument("--density-target", default="p02")
    parser.add_argument("--output-suffix", default="")
    parser.add_argument("--public-root", default="")
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "manifest":
        build_manifest(args)
    elif args.command == "overview-excluding":
        build_overview_excluding_wrappers(args)
    else:
        build_detail_wrapper(args)


if __name__ == "__main__":
    main()
