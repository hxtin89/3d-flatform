#!/usr/bin/env python3
"""Build a root 3D Tiles tileset that references per-chunk external tilesets."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def box_from_bounds(mins: list[float], maxs: list[float]) -> list[float]:
    center = [(mins[i] + maxs[i]) / 2.0 for i in range(3)]
    half = [(maxs[i] - mins[i]) / 2.0 for i in range(3)]
    return [
        center[0],
        center[1],
        center[2],
        half[0],
        0.0,
        0.0,
        0.0,
        half[1],
        0.0,
        0.0,
        0.0,
        half[2],
    ]


def diagonal(mins: list[float], maxs: list[float]) -> float:
    return math.sqrt(sum((maxs[i] - mins[i]) ** 2 for i in range(3)))


def merge_bounds(bounds: list[tuple[list[float], list[float]]]) -> tuple[list[float], list[float]]:
    mins = [min(item[0][axis] for item in bounds) for axis in range(3)]
    maxs = [max(item[1][axis] for item in bounds) for axis in range(3)]
    return mins, maxs


def build(args: argparse.Namespace) -> None:
    output_dir = Path(args.output).resolve()
    chunks_dir = output_dir / "chunks"
    reports = sorted(chunks_dir.glob("*/conversion-report.json"))

    if not reports:
        raise SystemExit(f"No child conversion reports found in: {chunks_dir}")

    children = []
    bounds = []
    total_points = 0
    total_source_points = 0
    total_tiles = 0
    has_rgb = False
    warnings: list[dict[str, Any]] = []
    point_steps = set()
    density_targets = set()
    density_approximate = False
    tile_pack_modes = set()
    tile_pack_group_levels = set()
    tile_pack_target_bytes = set()
    tile_pack_hard_max_bytes = set()
    tile_pack_error_policies = set()
    tile_pack_root_error_before: list[float] = []
    tile_pack_root_error_after: list[float] = []
    tile_pack_source_node_count = 0
    tile_pack_packed_count = 0

    for report_path in reports:
        report = read_json(report_path)
        rel_tileset = report_path.parent.relative_to(output_dir) / "tileset.json"
        source_bbox = report.get("source_bbox") or report.get("root_bbox")
        mins = source_bbox["mins"]
        maxs = source_bbox["maxs"]
        bounds.append((mins, maxs))
        child_error = diagonal(mins, maxs)
        children.append({
            "boundingVolume": {"box": box_from_bounds(mins, maxs)},
            "geometricError": child_error,
            "refine": "ADD",
            "content": {"uri": rel_tileset.as_posix()},
        })
        source_points = int(report.get("source_point_count") or 0)
        emitted_points = int(report.get("emitted_point_count") or source_points or 0)
        total_source_points += source_points
        total_points += emitted_points
        total_tiles += int(report.get("tile_count") or 0)
        has_rgb = has_rgb or bool(report.get("has_rgb"))
        if report.get("pointStep") is not None:
            point_steps.add(int(report["pointStep"]))
        if report.get("densityTarget"):
            density_targets.add(str(report["densityTarget"]))
        density_approximate = density_approximate or bool(report.get("densityApproximate"))
        tile_packing = report.get("tilePacking")
        if isinstance(tile_packing, dict):
            if tile_packing.get("mode"):
                tile_pack_modes.add(str(tile_packing["mode"]))
            if tile_packing.get("groupLevel") is not None:
                tile_pack_group_levels.add(int(tile_packing["groupLevel"]))
            if tile_packing.get("targetTileBytes") is not None:
                tile_pack_target_bytes.add(int(tile_packing["targetTileBytes"]))
            if tile_packing.get("hardMaxTileBytes") is not None:
                tile_pack_hard_max_bytes.add(int(tile_packing["hardMaxTileBytes"]))
            if tile_packing.get("geometricErrorPolicy"):
                tile_pack_error_policies.add(str(tile_packing["geometricErrorPolicy"]))
            if tile_packing.get("rootGeometricErrorBefore") is not None:
                tile_pack_root_error_before.append(float(tile_packing["rootGeometricErrorBefore"]))
            if tile_packing.get("rootGeometricErrorAfter") is not None:
                tile_pack_root_error_after.append(float(tile_packing["rootGeometricErrorAfter"]))
            tile_pack_source_node_count += int(tile_packing.get("sourceNodeTileCount") or 0)
            tile_pack_packed_count += int(tile_packing.get("packedTileCount") or 0)
        for warning in report.get("warnings", []):
            warnings.append({"chunk": report_path.parent.name, **warning})

    root_mins, root_maxs = merge_bounds(bounds)
    root_error = diagonal(root_mins, root_maxs)
    tileset = {
        "asset": {
            "version": "1.0",
            "extras": {
                "generator": "SBB Chunked COPC External Tileset V1",
                "dataset": args.dataset,
                "sourceDataset": args.source_dataset,
                "local_only": True,
            },
        },
        "geometricError": root_error,
        "root": {
            "boundingVolume": {"box": box_from_bounds(root_mins, root_maxs)},
            "geometricError": root_error,
            "refine": "ADD",
            "children": children,
        },
    }

    report = {
        "dataset": args.dataset,
        "sourceDataset": args.source_dataset,
        "sourceType": "copc-chunked-custom",
        "chunk_count": len(reports),
        "source_point_count": total_source_points,
        "emitted_point_count": total_points,
        "pointStep": point_steps.pop() if len(point_steps) == 1 else None,
        "densityTarget": density_targets.pop() if len(density_targets) == 1 else None,
        "densityApproximate": density_approximate,
        "actualDensityRatio": total_points / total_source_points if total_source_points else None,
        "tile_count": total_tiles,
        "root_bbox": {"mins": root_mins, "maxs": root_maxs},
        "has_rgb": has_rgb,
        "warnings": warnings,
    }
    if tile_pack_modes:
        report["tilePacking"] = {
            "mode": tile_pack_modes.pop() if len(tile_pack_modes) == 1 else "mixed",
            "groupLevel": tile_pack_group_levels.pop() if len(tile_pack_group_levels) == 1 else None,
            "targetTileBytes": tile_pack_target_bytes.pop() if len(tile_pack_target_bytes) == 1 else None,
            "hardMaxTileBytes": tile_pack_hard_max_bytes.pop() if len(tile_pack_hard_max_bytes) == 1 else None,
            "sourceNodeTileCount": tile_pack_source_node_count,
            "packedTileCount": tile_pack_packed_count,
            "geometricErrorPolicy": tile_pack_error_policies.pop() if len(tile_pack_error_policies) == 1 else "mixed",
            "rootGeometricErrorBefore": max(tile_pack_root_error_before) if tile_pack_root_error_before else None,
            "rootGeometricErrorAfter": max(tile_pack_root_error_after) if tile_pack_root_error_after else None,
        }

    (output_dir / "tileset.json").write_text(json.dumps(tileset, separators=(",", ":")), encoding="utf-8")
    (output_dir / "chunked-conversion-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"✓ Chunked root tileset: {output_dir / 'tileset.json'}")
    print(f"✓ Chunked report: {output_dir / 'chunked-conversion-report.json'}")
    print(f"✓ Children: {len(reports)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a root tileset for chunked COPC PNTS outputs.")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--source-dataset", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    build(parse_args())
