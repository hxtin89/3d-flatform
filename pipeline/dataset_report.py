#!/usr/bin/env python3
"""Build a per-dataset performance/scalability report for local tilesets."""
from __future__ import annotations

import argparse
import json
import os
import struct
from pathlib import Path
from typing import Any


def file_size(path: Path) -> dict[str, Any] | None:
    if not path.exists() or not path.is_file():
        return None
    return {"bytes": path.stat().st_size, "human": human_bytes(path.stat().st_size)}


def dir_size(path: Path) -> dict[str, Any] | None:
    if not path.exists() or not path.is_dir():
        return None
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for filename in filenames:
            try:
                total += (Path(dirpath) / filename).stat().st_size
            except OSError:
                continue
    return {"bytes": total, "human": human_bytes(total)}


def human_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(value)
    unit = units[0]
    for unit in units:
        if size < 1024 or unit == units[-1]:
            break
        size /= 1024
    if unit == "B":
        return f"{int(size)} {unit}"
    return f"{size:.1f} {unit}"


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def crs_name(srs: dict[str, Any]) -> str | None:
    json_crs = srs.get("json")
    if isinstance(json_crs, dict) and isinstance(json_crs.get("name"), str):
        return json_crs["name"]
    for key in ("compoundwkt", "wkt", "horizontal"):
        value = srs.get(key)
        if isinstance(value, str) and value:
            return value.split("[", 1)[0] if "[" in value else value
    return None


def info_metrics(info: dict[str, Any] | None) -> dict[str, Any]:
    if not info:
        return {
            "rawLasSize": None,
            "pointCount": None,
            "hasRgb": None,
            "crs": None,
        }

    raw_bytes = 0
    has_rgb = False
    crs = None
    for item in info.get("files", []):
        path = Path(item.get("path", ""))
        if path.exists():
            raw_bytes += path.stat().st_size
        summary = item.get("summary", {})
        dimensions = str(summary.get("dimensions", "")).lower()
        has_rgb = has_rgb or all(name in dimensions for name in ("red", "green", "blue"))
        if crs is None:
            srs = summary.get("srs")
            if isinstance(srs, dict):
                crs = crs_name(srs)

    return {
        "rawLasSize": {"bytes": raw_bytes, "human": human_bytes(raw_bytes)} if raw_bytes else None,
        "pointCount": info.get("total_points"),
        "hasRgb": has_rgb,
        "crs": crs,
    }


def pnts_points(path: Path) -> int | None:
    try:
        with path.open("rb") as fh:
            header = fh.read(28)
            if len(header) != 28 or header[:4] != b"pnts":
                return None
            _, _, _, feature_json_len, _, _, _ = struct.unpack("<4sIIIIII", header)
            feature_json = fh.read(feature_json_len).decode("utf-8").strip()
            return int(json.loads(feature_json).get("POINTS_LENGTH", 0))
    except Exception:
        return None


def tiles_metrics(tiles_dir: Path) -> dict[str, Any]:
    if not tiles_dir.exists() or not tiles_dir.is_dir():
        return {"tilesSize": None, "tileCount": 0, "maxTilePoints": None}

    total_bytes = 0
    tile_count = 0
    max_tile_points = 0
    largest_tile_bytes = 0
    largest_pnts: list[tuple[int, Path]] = []

    for dirpath, _, filenames in os.walk(tiles_dir):
        for filename in filenames:
            path = Path(dirpath) / filename
            try:
                size = path.stat().st_size
                total_bytes += size
            except OSError:
                continue

            suffix = path.suffix.lower()
            if suffix not in {".pnts", ".b3dm"}:
                continue

            tile_count += 1
            largest_tile_bytes = max(largest_tile_bytes, size)
            if suffix == ".pnts":
                largest_pnts.append((size, path))

    largest_pnts.sort(key=lambda item: item[0], reverse=True)
    for _, path in largest_pnts[:64]:
        points = pnts_points(path)
        if points is not None:
            max_tile_points = max(max_tile_points, points)

    return {
        "tilesSize": {"bytes": total_bytes, "human": human_bytes(total_bytes)},
        "tileCount": tile_count,
        "maxTilePoints": max_tile_points or None,
        "maxTilePointsSource": "largest-pnts-headers" if largest_pnts else None,
        "averageTileBytes": int(total_bytes / tile_count) if tile_count else None,
        "largestTileBytes": largest_tile_bytes or None,
    }


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    root = Path(args.root)
    source_dataset = args.source_dataset
    tiles_dir = Path(args.tiles_dir)
    intermediate_dir = root / "local-storage" / "intermediate" / source_dataset
    info = read_json(intermediate_dir / "info.json")
    conversion_report = (
        read_json(tiles_dir / "conversion-report.json")
        or read_json(tiles_dir / "chunked-conversion-report.json")
    )
    measured_tiles_dir = tiles_dir
    if conversion_report and conversion_report.get("referencedTilesDir"):
        measured_tiles_dir = Path(conversion_report["referencedTilesDir"])
    copc_size = file_size(intermediate_dir / f"{source_dataset}.copc.laz")
    if copc_size is None and args.source_type in {
        "copc-chunked-custom",
        "copc-overview-custom",
        "copc-area-custom",
        "copc-area-full-reference",
    }:
        copc_size = dir_size(intermediate_dir / "chunks-copc")

    report = {
        "dataset": args.dataset,
        "sourceType": args.source_type,
        "sourceDataset": source_dataset,
        **info_metrics(info),
        "lazSize": file_size(intermediate_dir / f"{source_dataset}.prepared.laz"),
        "copcSize": copc_size,
        **tiles_metrics(measured_tiles_dir),
    }

    if conversion_report:
        if conversion_report.get("source_point_count") is not None:
            report["sourcePointCount"] = conversion_report.get("source_point_count")
        if conversion_report.get("emitted_point_count") is not None:
            report["emittedPointCount"] = conversion_report.get("emitted_point_count")
            report["pointCount"] = conversion_report.get("emitted_point_count")
        else:
            report["pointCount"] = conversion_report.get("source_point_count", report["pointCount"])
        report["hasRgb"] = conversion_report.get("has_rgb", report["hasRgb"])
        report["tileCount"] = conversion_report.get("tile_count", report["tileCount"])
        report["maxTilePoints"] = conversion_report.get("max_tile_points", report["maxTilePoints"])
        crs = conversion_report.get("crs")
        if isinstance(crs, dict):
            report["crs"] = crs.get("name") or crs.get("wkt") or report["crs"]
        for key in (
            "pointStep",
            "densityTarget",
            "densityApproximate",
            "actualDensityRatio",
            "tilePacking",
            "areaId",
            "sourceChunkId",
        ):
            if key in conversion_report:
                report[key] = conversion_report[key]

    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate dataset-report.json for a tileset.")
    parser.add_argument("--root", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--source-dataset", required=True)
    parser.add_argument(
        "--source-type",
        required=True,
        choices=[
            "py3dtiles-fallback",
            "copc-custom",
            "copc-chunked-custom",
            "copc-overview-custom",
            "copc-area-custom",
            "copc-area-full-reference",
        ],
    )
    parser.add_argument("--tiles-dir", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    tiles_dir = Path(args.tiles_dir)
    report_path = tiles_dir / "dataset-report.json"
    report_path.write_text(json.dumps(build_report(args), indent=2), encoding="utf-8")
    print(f"✓ Dataset report: {report_path}")


if __name__ == "__main__":
    main()
