#!/usr/bin/env python3
"""Convert COPC nodes directly to a local 3D Tiles PNTS tileset.

V1 intentionally mirrors COPC nodes one-to-one. It does not merge, split,
reproject, or place data on the Cesium globe.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from laspy._compression.selection import DecompressionSelection
from laspy.copc import CopcReader, load_octree_for_query
from laspy.errors import LaspyException


WARN_TILE_POINTS = 150_000
WARN_TILE_BYTES = 5 * 1024 * 1024
WARN_TOTAL_TILES = 5_000
WARN_ROOT_BBOX_SIDE = 1_000_000


@dataclass
class TileRecord:
    key: Any
    point_count: int
    byte_size: int
    bounds_mins: np.ndarray
    bounds_maxs: np.ndarray
    content_uri: str | None = None
    children: list["TileRecord"] = field(default_factory=list)

    @property
    def level(self) -> int:
        return int(self.key.level)

    @property
    def name(self) -> str:
        return f"r{self.key.level}_{self.key.x}_{self.key.y}_{self.key.z}"


def padded_json_bytes(value: dict[str, Any], start_offset: int) -> bytes:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    padding = (8 - ((start_offset + len(raw)) % 8)) % 8
    return raw + (b" " * padding)


def pad_binary(raw: bytes) -> bytes:
    padding = (8 - (len(raw) % 8)) % 8
    return raw + (b"\x00" * padding)


def write_pnts(
    path: Path,
    xyz: np.ndarray,
    rgb: np.ndarray | None,
    rtc_center: np.ndarray,
) -> int:
    xyz = np.asarray(xyz, dtype="<f4")
    points_length = int(xyz.shape[0])

    feature_json: dict[str, Any] = {
        "POINTS_LENGTH": points_length,
        "RTC_CENTER": [float(v) for v in rtc_center],
        "POSITION": {"byteOffset": 0},
    }

    binary_parts = [xyz.tobytes(order="C")]
    if rgb is not None:
        rgb = np.asarray(rgb, dtype=np.uint8)
        feature_json["RGB"] = {"byteOffset": points_length * 12}
        binary_parts.append(rgb.tobytes(order="C"))

    feature_json_bytes = padded_json_bytes(feature_json, start_offset=28)
    feature_binary_bytes = pad_binary(b"".join(binary_parts))

    byte_length = 28 + len(feature_json_bytes) + len(feature_binary_bytes)
    header = struct.pack(
        "<4sIIIIII",
        b"pnts",
        1,
        byte_length,
        len(feature_json_bytes),
        len(feature_binary_bytes),
        0,
        0,
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + feature_json_bytes + feature_binary_bytes)
    return byte_length


def box_from_bounds(mins: np.ndarray, maxs: np.ndarray, root_center: np.ndarray) -> list[float]:
    center = ((mins + maxs) / 2.0) - root_center
    half = (maxs - mins) / 2.0
    return [
        float(center[0]),
        float(center[1]),
        float(center[2]),
        float(half[0]),
        0.0,
        0.0,
        0.0,
        float(half[1]),
        0.0,
        0.0,
        0.0,
        float(half[2]),
    ]


def tile_json(record: TileRecord, root_center: np.ndarray, root_spacing: float) -> dict[str, Any]:
    children = [tile_json(child, root_center, root_spacing) for child in record.children]
    geometric_error = root_spacing / (2 ** record.level)
    if not children:
        geometric_error = 0.0

    tile: dict[str, Any] = {
        "boundingVolume": {
            "box": box_from_bounds(record.bounds_mins, record.bounds_maxs, root_center)
        },
        "geometricError": float(geometric_error),
        "refine": "ADD",
    }

    if record.content_uri:
        tile["content"] = {"uri": record.content_uri}
    if children:
        tile["children"] = children

    return tile


def has_rgb_dimensions(header: Any) -> bool:
    names = set(header.point_format.dimension_names)
    return {"red", "green", "blue"}.issubset(names)


def crs_status(header: Any) -> dict[str, Any]:
    srs = header.parse_crs()
    if srs is None:
        return {"has_crs": False, "wkt": None}
    return {"has_crs": True, "wkt": srs.to_wkt()}


def key_tuple(key: Any) -> tuple[int, int, int, int]:
    return (int(key.level), int(key.x), int(key.y), int(key.z))


def parent_tuple(key: Any) -> tuple[int, int, int, int] | None:
    if key.level <= 0:
        return None
    return (int(key.level - 1), int(key.x >> 1), int(key.y >> 1), int(key.z >> 1))


def color_to_u8(values: np.ndarray, color_scale: float) -> np.ndarray:
    scaled = np.asarray(values, dtype=np.float64) / color_scale
    return np.clip(scaled, 0, 255).astype(np.uint8)


def convert(args: argparse.Namespace) -> None:
    input_path = Path(args.input).resolve()
    output_dir = Path(args.out).resolve()
    points_dir = output_dir / "points"

    if output_dir.exists():
        if not args.overwrite:
            raise SystemExit(f"Output exists. Pass --overwrite to replace: {output_dir}")
        shutil.rmtree(output_dir)
    points_dir.mkdir(parents=True, exist_ok=True)

    warnings: list[dict[str, Any]] = []

    with CopcReader.open(input_path) as metadata_reader:
        has_rgb = has_rgb_dimensions(metadata_reader.header)

    decompression_selection = DecompressionSelection.XY_RETURNS_CHANNEL | DecompressionSelection.Z
    if has_rgb:
        decompression_selection |= DecompressionSelection.RGB

    with CopcReader.open(input_path, decompression_selection=decompression_selection) as reader:
        header = reader.header
        crs = crs_status(header)
        if not crs["has_crs"]:
            warnings.append({"code": "missing_crs_metadata", "message": "Source COPC has no CRS metadata."})

        nodes = load_octree_for_query(reader.source, reader.copc_info, reader.root_page)
        nodes_by_key = {key_tuple(node.key): node for node in nodes}
        records_by_key: dict[tuple[int, int, int, int], TileRecord] = {}

        for node in nodes:
            record = TileRecord(
                key=node.key,
                point_count=int(node.point_count),
                byte_size=int(node.byte_size),
                bounds_mins=np.asarray(node.bounds.mins, dtype=np.float64),
                bounds_maxs=np.asarray(node.bounds.maxs, dtype=np.float64),
            )
            records_by_key[key_tuple(node.key)] = record

        for record in records_by_key.values():
            parent_key = parent_tuple(record.key)
            if parent_key in records_by_key:
                records_by_key[parent_key].children.append(record)
        for record in records_by_key.values():
            record.children.sort(key=lambda child: key_tuple(child.key))

        root_record = records_by_key.get((0, 0, 0, 0))
        if root_record is None:
            raise LaspyException("COPC hierarchy did not contain root node.")

        source_mins = np.asarray(header.mins, dtype=np.float64)
        source_maxs = np.asarray(header.maxs, dtype=np.float64)
        root_mins = root_record.bounds_mins
        root_maxs = root_record.bounds_maxs
        root_center = (root_mins + root_maxs) / 2.0
        root_size = root_maxs - root_mins
        root_diagonal = float(np.linalg.norm(root_size))
        if np.any(root_size > WARN_ROOT_BBOX_SIDE):
            warnings.append({
                "code": "unusually_large_root_bbox",
                "message": "Root bounding box has a side larger than warning threshold.",
                "root_size": root_size.tolist(),
            })

        emitted_points = 0
        max_tile_points = 0
        max_tile_bytes = 0
        tile_count = 0
        skipped_empty_nodes = 0

        for record in sorted(records_by_key.values(), key=lambda r: key_tuple(r.key)):
            if record.point_count <= 0:
                skipped_empty_nodes += 1
                continue

            points = reader._fetch_and_decompress_points_of_nodes([nodes_by_key[key_tuple(record.key)]])
            xyz_world = np.column_stack((points.x, points.y, points.z)).astype(np.float64)
            if xyz_world.shape[0] == 0:
                skipped_empty_nodes += 1
                continue

            tile_center_world = (record.bounds_mins + record.bounds_maxs) / 2.0
            local_positions = xyz_world - tile_center_world
            rtc_center = tile_center_world - root_center

            rgb = None
            if has_rgb:
                rgb = np.column_stack(
                    (
                        color_to_u8(points.red, args.color_scale),
                        color_to_u8(points.green, args.color_scale),
                        color_to_u8(points.blue, args.color_scale),
                    )
                )

            content_uri = f"points/{record.name}.pnts"
            byte_length = write_pnts(output_dir / content_uri, local_positions, rgb, rtc_center)
            record.content_uri = content_uri

            emitted_points += int(xyz_world.shape[0])
            tile_count += 1
            max_tile_points = max(max_tile_points, int(xyz_world.shape[0]))
            max_tile_bytes = max(max_tile_bytes, byte_length)

            if xyz_world.shape[0] > WARN_TILE_POINTS:
                warnings.append({
                    "code": "tile_points_gt_150000",
                    "tile": content_uri,
                    "points": int(xyz_world.shape[0]),
                })
            if byte_length > WARN_TILE_BYTES:
                warnings.append({
                    "code": "tile_bytes_gt_5mb",
                    "tile": content_uri,
                    "bytes": byte_length,
                })

        def prune_empty(record: TileRecord) -> bool:
            record.children = [child for child in record.children if prune_empty(child)]
            return record.content_uri is not None or bool(record.children)

        prune_empty(root_record)

        if tile_count > WARN_TOTAL_TILES:
            warnings.append({"code": "total_tiles_gt_5000", "tiles": tile_count})

        tile_mins = np.array([record.bounds_mins for record in records_by_key.values()])
        tile_maxs = np.array([record.bounds_maxs for record in records_by_key.values()])
        all_tile_mins = tile_mins.min(axis=0)
        all_tile_maxs = tile_maxs.max(axis=0)
        if np.any(all_tile_mins < root_mins - 1e-6) or np.any(all_tile_maxs > root_maxs + 1e-6):
            warnings.append({
                "code": "root_bbox_does_not_contain_all_tile_bboxes",
                "root_mins": root_mins.tolist(),
                "root_maxs": root_maxs.tolist(),
                "tile_mins": all_tile_mins.tolist(),
                "tile_maxs": all_tile_maxs.tolist(),
            })

        root_transform = [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            float(root_center[0]), float(root_center[1]), float(root_center[2]), 1.0
        ]

        root_tile = tile_json(root_record, root_center, root_diagonal)
        root_tile["transform"] = root_transform

        tileset = {
            "asset": {
                "version": "1.0",
                "extras": {
                    "generator": "SBB COPC Node PNTS Converter V1",
                    "dataset": args.dataset,
                    "local_only": True,
                },
            },
            "geometricError": root_diagonal,
            "root": root_tile,
        }

        (output_dir / "tileset.json").write_text(json.dumps(tileset, separators=(",", ":")), encoding="utf-8")

        report = {
            "dataset": args.dataset,
            "input": str(input_path),
            "output": str(output_dir),
            "source_point_count": int(header.point_count),
            "emitted_point_count": emitted_points,
            "tile_count": tile_count,
            "skipped_empty_nodes": skipped_empty_nodes,
            "max_tile_points": max_tile_points,
            "max_tile_bytes": max_tile_bytes,
            "root_transform": root_transform,
            "root_center": root_center.tolist(),
            "root_bbox": {"mins": root_mins.tolist(), "maxs": root_maxs.tolist()},
            "source_bbox": {"mins": source_mins.tolist(), "maxs": source_maxs.tolist()},
            "copc": {
                "center": np.asarray(reader.copc_info.center).tolist(),
                "halfsize": float(reader.copc_info.halfsize),
                "spacing": float(reader.copc_info.spacing),
            },
            "crs": crs,
            "has_rgb": has_rgb,
            "warnings": warnings,
        }
        (output_dir / "conversion-report.json").write_text(
            json.dumps(report, indent=2),
            encoding="utf-8",
        )

        print(f"✓ tileset.json: {output_dir / 'tileset.json'}")
        print(f"✓ tiles: {tile_count}")
        print(f"✓ points: {emitted_points}")
        print(f"✓ has_rgb: {has_rgb}")
        if warnings:
            print(f"⚠ warnings: {len(warnings)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert COPC nodes to local 3D Tiles PNTS.")
    parser.add_argument("input", help="Input .copc.laz file")
    parser.add_argument("--out", required=True, help="Output tileset directory")
    parser.add_argument("--dataset", required=True, help="Dataset name for reports")
    parser.add_argument("--overwrite", action="store_true", help="Replace existing output directory")
    parser.add_argument("--color-scale", type=float, default=256.0, help="Scale LAS RGB values to uint8")
    return parser.parse_args()


if __name__ == "__main__":
    convert(parse_args())
