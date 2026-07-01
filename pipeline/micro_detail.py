#!/usr/bin/env python3
"""Plan and build exact p100 micro-area tilesets from one COPC area chunk."""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from laspy._compression.selection import DecompressionSelection
from laspy.copc import CopcReader, load_octree_for_query


BOUNDARY_POLICY = "half-open-xy-outer-inclusive-v1"
DEFAULT_BASE_DEPTH = 2
DEFAULT_MAX_DEPTH = 4
DEFAULT_MAX_POINTS = 8_000_000
DEFAULT_GROUP_LEVELS = (3, 4, 5)
DEFAULT_TARGET_BYTES = 512 * 1024
DEFAULT_MIN_AVERAGE_BYTES = 250 * 1024
DEFAULT_HARD_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_MAX_TILES = 250
MIN_TARGET_BYTES = 384 * 1024
MAX_TARGET_BYTES = 768 * 1024


@dataclass(frozen=True)
class GridCell:
    depth: int
    x: int
    y: int
    point_count: int
    raw_mins: tuple[int, int, int]
    raw_maxs: tuple[int, int, int]
    include_max_x: bool
    include_max_y: bool

    @property
    def micro_area_id(self) -> str:
        return f"micro-d{self.depth}-x{self.x}-y{self.y}"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def raw_axis_bounds(raw_min: int, raw_max: int, divisions: int) -> np.ndarray:
    span = raw_max - raw_min + 1
    return np.asarray(
        [raw_min + (span * index) // divisions for index in range(divisions)] + [raw_max + 1],
        dtype=np.int64,
    )


def count_deep_grid(copc_path: Path, max_depth: int) -> tuple[np.ndarray, Any, np.ndarray, np.ndarray]:
    divisions = 1 << max_depth
    with CopcReader.open(copc_path, decompression_selection=DecompressionSelection.XY_RETURNS_CHANNEL) as reader:
        header = reader.header
        raw_mins = np.rint((header.mins - header.offsets) / header.scales).astype(np.int64)
        raw_maxs = np.rint((header.maxs - header.offsets) / header.scales).astype(np.int64)
        x_bounds = raw_axis_bounds(int(raw_mins[0]), int(raw_maxs[0]), divisions)
        y_bounds = raw_axis_bounds(int(raw_mins[1]), int(raw_maxs[1]), divisions)
        counts = np.zeros((divisions, divisions), dtype=np.int64)
        nodes = load_octree_for_query(reader.source, reader.copc_info, reader.root_page)
        for node in nodes:
            if int(node.point_count) <= 0:
                continue
            points = reader._fetch_and_decompress_points_of_nodes([node])
            if len(points) == 0:
                continue
            xs = np.searchsorted(x_bounds[1:-1], points.X, side="right")
            ys = np.searchsorted(y_bounds[1:-1], points.Y, side="right")
            flat = ys * divisions + xs
            counts += np.bincount(flat, minlength=divisions * divisions).reshape((divisions, divisions))
        return counts, header, x_bounds, y_bounds


def adaptive_cells(
    counts: np.ndarray,
    raw_z_min: int,
    raw_z_max: int,
    x_bounds: np.ndarray,
    y_bounds: np.ndarray,
    base_depth: int,
    max_depth: int,
    max_points: int,
) -> list[GridCell]:
    if base_depth > max_depth:
        raise ValueError("baseDepth must be <= maxDepth")
    divisions = 1 << max_depth
    cells: list[GridCell] = []

    def visit(depth: int, x: int, y: int) -> None:
        leaf_span = 1 << (max_depth - depth)
        x0 = x * leaf_span
        y0 = y * leaf_span
        count = int(counts[y0:y0 + leaf_span, x0:x0 + leaf_span].sum())
        if count > max_points and depth < max_depth:
            for child_y in range(y * 2, y * 2 + 2):
                for child_x in range(x * 2, x * 2 + 2):
                    visit(depth + 1, child_x, child_y)
            return
        if count > max_points:
            raise RuntimeError(
                f"{depth=},{x=},{y=} has {count} points above maxPoints={max_points}"
            )
        if count == 0:
            return
        raw_x_min = int(x_bounds[x0])
        raw_x_exclusive = int(x_bounds[x0 + leaf_span])
        raw_y_min = int(y_bounds[y0])
        raw_y_exclusive = int(y_bounds[y0 + leaf_span])
        include_max_x = raw_x_exclusive == int(x_bounds[-1])
        include_max_y = raw_y_exclusive == int(y_bounds[-1])
        cells.append(GridCell(
            depth=depth,
            x=x,
            y=y,
            point_count=count,
            raw_mins=(raw_x_min, raw_y_min, raw_z_min),
            raw_maxs=(
                raw_x_exclusive - 1 if include_max_x else raw_x_exclusive,
                raw_y_exclusive - 1 if include_max_y else raw_y_exclusive,
                raw_z_max,
            ),
            include_max_x=include_max_x,
            include_max_y=include_max_y,
        ))

    for y in range(1 << base_depth):
        for x in range(1 << base_depth):
            visit(base_depth, x, y)
    return sorted(cells, key=lambda cell: (cell.depth, cell.y, cell.x))


def scaled_bbox(cell: GridCell, header: Any) -> tuple[np.ndarray, np.ndarray]:
    mins = np.asarray(cell.raw_mins, dtype=np.float64) * header.scales + header.offsets
    maxs = np.asarray(cell.raw_maxs, dtype=np.float64) * header.scales + header.offsets
    return mins, maxs


def scan_tileset(tileset_path: Path) -> dict[str, Any]:
    missing: list[str] = []
    violations: list[dict[str, float]] = []
    visited: set[Path] = set()

    def scan(path: Path) -> None:
        path = path.resolve()
        if path in visited:
            return
        visited.add(path)
        tileset = read_json(path)
        base = path.parent

        def walk(tile: dict[str, Any], parent_error: float | None = None) -> None:
            error = float(tile.get("geometricError") or 0)
            if parent_error is not None and error > parent_error + 1e-9:
                violations.append({"parent": parent_error, "child": error})
            content = tile.get("content") if isinstance(tile.get("content"), dict) else None
            uri = (content or {}).get("uri") or (content or {}).get("url")
            if isinstance(uri, str):
                target = (base / uri).resolve()
                if not target.exists():
                    missing.append(str(target))
                elif target.suffix.lower() == ".json":
                    scan(target)
            for child in tile.get("children") or []:
                walk(child, error)

        walk(tileset["root"])

    scan(tileset_path)
    return {
        "missingContentUris": missing,
        "geometricErrorViolations": violations,
    }


def candidate_metrics(output_dir: Path) -> dict[str, Any]:
    report = read_json(output_dir / "conversion-report.json")
    point_files = list((output_dir / "points").glob("*.pnts"))
    total_bytes = sum(path.stat().st_size for path in point_files)
    tile_count = len(point_files)
    average = int(total_bytes / tile_count) if tile_count else 0
    largest = max((path.stat().st_size for path in point_files), default=0)
    tree = scan_tileset(output_dir / "tileset.json")
    packing = report.get("tilePacking") or {}
    return {
        "pointCount": int(report.get("emitted_point_count") or 0),
        "sourcePointCount": int(report.get("source_point_count") or 0),
        "actualDensityRatio": report.get("actualDensityRatio"),
        "tileCount": tile_count,
        "tilesBytes": total_bytes,
        "averageTileBytes": average,
        "largestTileBytes": largest,
        "groupLevel": packing.get("groupLevel"),
        "targetTileBytes": packing.get("targetTileBytes"),
        **tree,
    }


def gate_reasons(metrics: dict[str, Any], expected_points: int, args: argparse.Namespace) -> list[str]:
    reasons: list[str] = []
    if metrics["pointCount"] != expected_points or metrics["sourcePointCount"] != expected_points:
        reasons.append("point_count_mismatch")
    if not math.isclose(float(metrics.get("actualDensityRatio") or 0), 1.0, rel_tol=0, abs_tol=1e-12):
        reasons.append("density_ratio_not_one")
    if metrics["tileCount"] > args.max_tiles:
        reasons.append("tile_count_gt_max")
    if metrics["averageTileBytes"] < args.min_average_tile_bytes:
        reasons.append("average_tile_bytes_lt_min")
    if metrics["largestTileBytes"] > args.hard_max_tile_bytes:
        reasons.append("largest_tile_bytes_gt_hard_max")
    if not MIN_TARGET_BYTES <= metrics["targetTileBytes"] <= MAX_TARGET_BYTES:
        reasons.append("target_tile_bytes_out_of_range")
    if metrics["missingContentUris"]:
        reasons.append("missing_content_uris")
    if metrics["geometricErrorViolations"]:
        reasons.append("geometric_error_violations")
    return reasons


def run_converter(
    args: argparse.Namespace,
    copc_path: Path,
    output_dir: Path,
    dataset: str,
    cell: GridCell,
    header: Any,
    group_level: int,
    coordinate_mode: str,
    enu_origin: list[float] | None,
) -> None:
    mins, maxs = scaled_bbox(cell, header)
    clip = ",".join(f"{value:.12g}" for value in [*mins, *maxs])
    command = [
        args.python,
        str(Path(__file__).with_name("copc_to_3dtiles.py")),
        str(copc_path),
        "--out", str(output_dir),
        "--dataset", dataset,
        "--overwrite",
        "--point-step", "1",
        "--density-target", "full",
        "--clip-bounds", clip,
        "--coordinate-mode", coordinate_mode,
        "--tile-pack-mode", "level-group",
        "--tile-pack-group-level", str(group_level),
        "--tile-pack-target-bytes", str(args.target_tile_bytes),
        "--tile-pack-hard-max-bytes", str(args.hard_max_tile_bytes),
    ]
    if cell.include_max_x:
        command.append("--clip-include-max-x")
    if cell.include_max_y:
        command.append("--clip-include-max-y")
    if coordinate_mode == "globe" and enu_origin:
        command.extend(["--enu-origin-source", ",".join(str(value) for value in enu_origin)])
    subprocess.run(command, check=True)


def public_dataset(public_root: str, dataset: str) -> str:
    public_root = public_root.strip("/")
    if not public_root or dataset.startswith(f"{public_root}/"):
        return dataset
    return f"{public_root}/{dataset}"


def resolve_area(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], Path, Path, str]:
    root = Path(args.root).resolve()
    logical = args.public_root.strip("/") or args.dataset
    area_manifest_path = root / "local-storage" / "tilesets" / logical / "area-manifest.json"
    manifest = read_json(area_manifest_path)
    area = next((item for item in manifest.get("areas", []) if item.get("areaId") == args.area_id), None)
    if area is None:
        raise SystemExit(f"Area not found: {args.area_id}")
    chunk_id = area["sourceChunkId"]
    copc_path = root / "local-storage" / "intermediate" / args.dataset / "chunks-copc" / f"{chunk_id}.copc.laz"
    if not copc_path.exists():
        raise SystemExit(f"COPC chunk missing: {copc_path}")
    detail_dataset = public_dataset(
        args.public_root,
        f"{args.dataset}-detail-p100/areas/{args.area_id}",
    )
    area_dir = root / "local-storage" / "tilesets" / detail_dataset
    return manifest, area, copc_path, area_dir, detail_dataset


def build_partition(args: argparse.Namespace, copc_path: Path) -> tuple[list[GridCell], Any]:
    counts, header, x_bounds, y_bounds = count_deep_grid(copc_path, args.max_depth)
    raw_mins = np.rint((header.mins - header.offsets) / header.scales).astype(np.int64)
    raw_maxs = np.rint((header.maxs - header.offsets) / header.scales).astype(np.int64)
    cells = adaptive_cells(
        counts,
        int(raw_mins[2]),
        int(raw_maxs[2]),
        x_bounds,
        y_bounds,
        args.base_depth,
        args.max_depth,
        args.max_points,
    )
    total = sum(cell.point_count for cell in cells)
    if total != int(header.point_count):
        raise SystemExit(f"Partition point total {total} != source {header.point_count}")
    return cells, header


def plan(args: argparse.Namespace) -> None:
    _, area, copc_path, _, detail_dataset = resolve_area(args)
    cells, header = build_partition(args, copc_path)
    bytes_per_point = 15 if {"red", "green", "blue"}.issubset(header.point_format.dimension_names) else 12
    result = {
        "dataset": detail_dataset,
        "areaId": args.area_id,
        "sourceChunkId": area["sourceChunkId"],
        "sourcePointCount": int(header.point_count),
        "cellCount": len(cells),
        "estimatedPntsBytes": int(header.point_count) * bytes_per_point,
        "partition": {
            "strategy": "adaptive-quadtree",
            "baseDepth": args.base_depth,
            "maxDepth": args.max_depth,
            "maxPoints": args.max_points,
            "boundaryPolicy": BOUNDARY_POLICY,
        },
        "cells": [
            {
                "microAreaId": cell.micro_area_id,
                "pointCount": cell.point_count,
                "sourceBbox": [*scaled_bbox(cell, header)[0], *scaled_bbox(cell, header)[1]],
            }
            for cell in cells
        ],
    }
    print(json.dumps(result, indent=2, default=float))


def build(args: argparse.Namespace) -> None:
    manifest, area, copc_path, area_dir, detail_dataset = resolve_area(args)
    cells, header = build_partition(args, copc_path)
    coordinate_mode = manifest.get("coordinateMode") or "local"
    enu_origin = manifest.get("enuOriginSource")
    micro_root = area_dir / "micro"
    work_root = area_dir / ".micro-work"
    if work_root.exists():
        shutil.rmtree(work_root)
    work_root.mkdir(parents=True, exist_ok=True)
    if args.overwrite and micro_root.exists():
        shutil.rmtree(micro_root)
    micro_root.mkdir(parents=True, exist_ok=True)

    built_cells: list[dict[str, Any]] = []
    try:
        for index, cell in enumerate(cells, start=1):
            print(f"[{index}/{len(cells)}] {cell.micro_area_id}: {cell.point_count} points")
            final_dataset = f"{detail_dataset}/micro/{cell.micro_area_id}"
            candidates: list[tuple[dict[str, Any], Path]] = []
            attempts: list[dict[str, Any]] = []
            for level in args.group_levels:
                candidate_dir = work_root / f"{cell.micro_area_id}-g{level}"
                run_converter(
                    args,
                    copc_path,
                    candidate_dir,
                    final_dataset,
                    cell,
                    header,
                    level,
                    coordinate_mode,
                    enu_origin,
                )
                metrics = candidate_metrics(candidate_dir)
                reasons = gate_reasons(metrics, cell.point_count, args)
                attempts.append({"groupLevel": level, "reasons": reasons, "metrics": metrics})
                if not reasons:
                    candidates.append((metrics, candidate_dir))
            if not candidates:
                write_json(work_root / f"{cell.micro_area_id}-failed.json", {"attempts": attempts})
                raise RuntimeError(f"No packing candidate passed for {cell.micro_area_id}")
            metrics, selected_dir = min(
                candidates,
                key=lambda item: (
                    abs(item[0]["averageTileBytes"] - args.target_tile_bytes),
                    item[0]["tileCount"],
                    item[0]["groupLevel"],
                ),
            )
            final_dir = micro_root / cell.micro_area_id
            if final_dir.exists():
                shutil.rmtree(final_dir)
            shutil.move(str(selected_dir), final_dir)
            report = read_json(final_dir / "conversion-report.json")
            mins, maxs = scaled_bbox(cell, header)
            bbox = report.get("root_bbox_enu") or report.get("root_bbox")
            dataset_report = {
                "dataset": final_dataset,
                "sourceType": "copc-micro-area-full",
                "sourceDataset": args.dataset,
                "areaId": args.area_id,
                "microAreaId": cell.micro_area_id,
                "sourceChunkId": area["sourceChunkId"],
                "pointCount": metrics["pointCount"],
                "sourcePointCount": metrics["sourcePointCount"],
                "emittedPointCount": metrics["pointCount"],
                "pointStep": 1,
                "densityTarget": "full",
                "densityApproximate": False,
                "actualDensityRatio": metrics["actualDensityRatio"],
                "tileCount": metrics["tileCount"],
                "tilesSize": {"bytes": metrics["tilesBytes"]},
                "averageTileBytes": metrics["averageTileBytes"],
                "largestTileBytes": metrics["largestTileBytes"],
                "tilePacking": report.get("tilePacking"),
                "sourceBbox": [*mins.tolist(), *maxs.tolist()],
                "bbox": [*bbox["mins"], *bbox["maxs"]],
                "packAttempts": attempts,
            }
            write_json(final_dir / "dataset-report.json", dataset_report)
            built_cells.append({
                "microAreaId": cell.micro_area_id,
                "bbox": dataset_report["bbox"],
                "sourceBbox": dataset_report["sourceBbox"],
                "pointCount": metrics["pointCount"],
                "tileCount": metrics["tileCount"],
                "averageTileBytes": metrics["averageTileBytes"],
                "dataset": final_dataset,
                "status": "ready",
            })

        if sum(item["pointCount"] for item in built_cells) != int(header.point_count):
            raise RuntimeError("Built micro point total does not match source")
        micro_manifest = {
            "version": 1,
            "areaId": args.area_id,
            "sourceChunkId": area["sourceChunkId"],
            "coordinateMode": coordinate_mode,
            "bboxFrame": manifest.get("bboxFrame") or "source",
            "rootTransform": manifest.get("rootTransform"),
            "partition": {
                "strategy": "adaptive-quadtree",
                "baseDepth": args.base_depth,
                "maxDepth": args.max_depth,
                "maxPoints": args.max_points,
                "boundaryPolicy": BOUNDARY_POLICY,
            },
            "packing": {
                "mode": "level-group",
                "candidateGroupLevels": list(args.group_levels),
                "targetTileBytes": args.target_tile_bytes,
                "minAverageTileBytes": args.min_average_tile_bytes,
                "hardMaxTileBytes": args.hard_max_tile_bytes,
                "maxTileCount": args.max_tiles,
            },
            "cells": built_cells,
        }
        write_json(area_dir / "micro-manifest.json", micro_manifest)
    finally:
        if work_root.exists():
            shutil.rmtree(work_root)
    subprocess.run([
        sys.executable,
        str(Path(__file__).with_name("area_manifest.py")),
        "manifest",
        "--root", str(Path(args.root).resolve()),
        "--dataset", args.dataset,
        *(["--public-root", args.public_root] if args.public_root else []),
    ], check=True)
    print(f"✓ Micro manifest: {area_dir / 'micro-manifest.json'}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Plan/build exact p100 micro-area tilesets.")
    parser.add_argument("command", choices=["plan", "build"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--area-id", required=True)
    parser.add_argument("--public-root", default="")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--base-depth", type=int, default=DEFAULT_BASE_DEPTH)
    parser.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH)
    parser.add_argument("--max-points", type=int, default=DEFAULT_MAX_POINTS)
    parser.add_argument("--group-levels", default=",".join(map(str, DEFAULT_GROUP_LEVELS)))
    parser.add_argument("--target-tile-bytes", type=int, default=DEFAULT_TARGET_BYTES)
    parser.add_argument("--min-average-tile-bytes", type=int, default=DEFAULT_MIN_AVERAGE_BYTES)
    parser.add_argument("--hard-max-tile-bytes", type=int, default=DEFAULT_HARD_MAX_BYTES)
    parser.add_argument("--max-tiles", type=int, default=DEFAULT_MAX_TILES)
    args = parser.parse_args()
    args.group_levels = tuple(int(value) for value in args.group_levels.split(",") if value)
    if not MIN_TARGET_BYTES <= args.target_tile_bytes <= MAX_TARGET_BYTES:
        parser.error("--target-tile-bytes must be between 384KB and 768KB")
    return args


if __name__ == "__main__":
    parsed = parse_args()
    plan(parsed) if parsed.command == "plan" else build(parsed)
