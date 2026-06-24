#!/usr/bin/env python3
"""Convert COPC nodes to a local 3D Tiles PNTS tileset.

By default this mirrors COPC nodes one-to-one. Overview builds can opt into
level-group packing to reduce tiny PNTS files without changing sampling.
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


@dataclass
class SampledNode:
    key: tuple[int, int, int, int]
    bounds_mins: np.ndarray
    bounds_maxs: np.ndarray
    xyz_world: np.ndarray
    rgb: np.ndarray | None

    @property
    def level(self) -> int:
        return self.key[0]

    @property
    def point_count(self) -> int:
        return int(self.xyz_world.shape[0])


@dataclass
class PackedTileRecord:
    name: str
    level: int
    bounds_mins: np.ndarray
    bounds_maxs: np.ndarray
    geometric_error_level: int | None = None
    content_uri: str | None = None
    children: list["PackedTileRecord"] = field(default_factory=list)


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


def packed_tile_json(record: PackedTileRecord, root_center: np.ndarray, root_spacing: float) -> dict[str, Any]:
    children = [packed_tile_json(child, root_center, root_spacing) for child in record.children]
    error_level = record.geometric_error_level if record.geometric_error_level is not None else record.level
    geometric_error = root_spacing / (2 ** max(error_level, 0))
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


def ancestor_tuple(key: tuple[int, int, int, int], level: int) -> tuple[int, int, int, int]:
    key_level, x, y, z = key
    if level >= key_level:
        return key
    shift = key_level - level
    return (level, x >> shift, y >> shift, z >> shift)


def tuple_name(key: tuple[int, int, int, int]) -> str:
    level, x, y, z = key
    return f"r{level}_{x}_{y}_{z}"


def merge_np_bounds(nodes: list[SampledNode] | list[PackedTileRecord]) -> tuple[np.ndarray, np.ndarray]:
    mins = np.vstack([node.bounds_mins for node in nodes]).min(axis=0)
    maxs = np.vstack([node.bounds_maxs for node in nodes]).max(axis=0)
    return mins, maxs


def estimated_pnts_bytes(point_count: int, has_rgb: bool) -> int:
    binary_bytes = point_count * (15 if has_rgb else 12)
    binary_bytes += (8 - (binary_bytes % 8)) % 8
    return 28 + 256 + binary_bytes


def color_to_u8(values: np.ndarray, color_scale: float) -> np.ndarray:
    scaled = np.asarray(values, dtype=np.float64) / color_scale
    return np.clip(scaled, 0, 255).astype(np.uint8)


def actual_density_ratio(source_points: int, emitted_points: int) -> float | None:
    if source_points <= 0:
        return None
    return emitted_points / source_points


def build_packed_tree(
    sampled_nodes: list[SampledNode],
    root_mins: np.ndarray,
    root_maxs: np.ndarray,
    root_center: np.ndarray,
    root_diagonal: float,
    output_dir: Path,
    has_rgb: bool,
    pack_group_level: int,
    hard_max_bytes: int,
) -> tuple[PackedTileRecord, dict[str, Any]]:
    root_record = PackedTileRecord(
        name="root",
        level=0,
        geometric_error_level=pack_group_level,
        bounds_mins=root_mins,
        bounds_maxs=root_maxs,
    )
    if not sampled_nodes:
        return root_record, {
            "tile_count": 0,
            "max_tile_points": 0,
            "max_tile_bytes": 0,
            "warnings": [],
        }

    warnings: list[dict[str, Any]] = []
    tile_count = 0
    max_tile_points = 0
    max_tile_bytes = 0
    max_level = max(node.level for node in sampled_nodes)
    root_content_record: PackedTileRecord | None = None

    def write_group(name: str, level: int, nodes: list[SampledNode]) -> PackedTileRecord:
        nonlocal tile_count, max_tile_points, max_tile_bytes
        mins, maxs = merge_np_bounds(nodes)
        xyz_world = np.vstack([node.xyz_world for node in nodes])
        rgb = None
        if has_rgb:
            rgb_parts = [node.rgb for node in nodes if node.rgb is not None]
            rgb = np.vstack(rgb_parts) if rgb_parts else None

        tile_center_world = (mins + maxs) / 2.0
        local_positions = xyz_world - tile_center_world
        rtc_center = tile_center_world - root_center
        content_uri = f"points/{name}.pnts"
        byte_length = write_pnts(output_dir / content_uri, local_positions, rgb, rtc_center)

        point_count = int(xyz_world.shape[0])
        tile_count += 1
        max_tile_points = max(max_tile_points, point_count)
        max_tile_bytes = max(max_tile_bytes, byte_length)

        if point_count > WARN_TILE_POINTS:
            warnings.append({
                "code": "tile_points_gt_150000",
                "tile": content_uri,
                "points": point_count,
            })
        if byte_length > WARN_TILE_BYTES:
            warnings.append({
                "code": "tile_bytes_gt_5mb",
                "tile": content_uri,
                "bytes": byte_length,
            })

        return PackedTileRecord(
            name=name,
            level=level,
            bounds_mins=mins,
            bounds_maxs=maxs,
            content_uri=content_uri,
        )

    def build_groups(
        nodes: list[SampledNode],
        level: int,
        container_geometric_error_level: int | None = None,
    ) -> list[PackedTileRecord]:
        grouped: dict[tuple[int, int, int, int], list[SampledNode]] = {}
        for node in nodes:
            grouped.setdefault(ancestor_tuple(node.key, level), []).append(node)

        children: list[PackedTileRecord] = []
        for group_key, group_nodes in sorted(grouped.items()):
            point_count = sum(node.point_count for node in group_nodes)
            if (
                estimated_pnts_bytes(point_count, has_rgb) > hard_max_bytes
                and level < max_level
                and len(group_nodes) > 1
            ):
                subchildren = build_groups(group_nodes, level + 1, container_geometric_error_level)
                mins, maxs = merge_np_bounds(subchildren)
                children.append(PackedTileRecord(
                    name=tuple_name(group_key),
                    level=level,
                    geometric_error_level=container_geometric_error_level,
                    bounds_mins=mins,
                    bounds_maxs=maxs,
                    children=subchildren,
                ))
                continue

            children.append(write_group(tuple_name(group_key), level, group_nodes))

        return children

    coarse_nodes = [node for node in sampled_nodes if node.level < pack_group_level]
    detail_nodes = [node for node in sampled_nodes if node.level >= pack_group_level]

    if coarse_nodes and estimated_pnts_bytes(sum(node.point_count for node in coarse_nodes), has_rgb) > hard_max_bytes:
        root_record.children.extend(build_groups(coarse_nodes, 1, pack_group_level))
    elif coarse_nodes:
        root_content_record = write_group("root_packed", 0, coarse_nodes)
        root_record.content_uri = root_content_record.content_uri
    if detail_nodes:
        root_record.children.extend(build_groups(detail_nodes, pack_group_level))

    root_bounds_records = [*root_record.children]
    if root_content_record is not None:
        root_bounds_records.append(root_content_record)
    root_record.bounds_mins, root_record.bounds_maxs = merge_np_bounds(
        root_bounds_records
    ) if root_bounds_records else merge_np_bounds(sampled_nodes)

    return root_record, {
        "tile_count": tile_count,
        "max_tile_points": max_tile_points,
        "max_tile_bytes": max_tile_bytes,
        "warnings": warnings,
    }


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
        sampled_nodes: list[SampledNode] = []

        for record in sorted(records_by_key.values(), key=lambda r: key_tuple(r.key)):
            if record.point_count <= 0:
                skipped_empty_nodes += 1
                continue

            points = reader._fetch_and_decompress_points_of_nodes([nodes_by_key[key_tuple(record.key)]])
            xyz_world = np.column_stack((points.x, points.y, points.z)).astype(np.float64)
            if xyz_world.shape[0] == 0:
                skipped_empty_nodes += 1
                continue

            if args.point_step > 1:
                xyz_world = xyz_world[::args.point_step]

            tile_center_world = (record.bounds_mins + record.bounds_maxs) / 2.0
            local_positions = xyz_world - tile_center_world
            rtc_center = tile_center_world - root_center

            rgb = None
            if has_rgb:
                red = points.red
                green = points.green
                blue = points.blue
                if args.point_step > 1:
                    red = red[::args.point_step]
                    green = green[::args.point_step]
                    blue = blue[::args.point_step]
                rgb = np.column_stack(
                    (
                        color_to_u8(red, args.color_scale),
                        color_to_u8(green, args.color_scale),
                        color_to_u8(blue, args.color_scale),
                    )
                )

            if args.tile_pack_mode == "level-group":
                sampled_nodes.append(SampledNode(
                    key=key_tuple(record.key),
                    bounds_mins=record.bounds_mins,
                    bounds_maxs=record.bounds_maxs,
                    xyz_world=xyz_world,
                    rgb=rgb,
                ))
                emitted_points += int(xyz_world.shape[0])
                continue

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

        tile_packing: dict[str, Any] | None = None
        if args.tile_pack_mode == "level-group":
            root_geometric_error_before = root_diagonal
            root_geometric_error_after = root_diagonal / (2 ** args.tile_pack_group_level)
            packed_root_record, packed_metrics = build_packed_tree(
                sampled_nodes,
                root_mins,
                root_maxs,
                root_center,
                root_diagonal,
                output_dir,
                has_rgb,
                args.tile_pack_group_level,
                args.tile_pack_hard_max_bytes,
            )
            tile_count = int(packed_metrics["tile_count"])
            max_tile_points = int(packed_metrics["max_tile_points"])
            max_tile_bytes = int(packed_metrics["max_tile_bytes"])
            warnings.extend(packed_metrics["warnings"])
            tile_packing = {
                "mode": args.tile_pack_mode,
                "groupLevel": args.tile_pack_group_level,
                "targetTileBytes": args.tile_pack_target_bytes,
                "hardMaxTileBytes": args.tile_pack_hard_max_bytes,
                "sourceNodeTileCount": len(sampled_nodes),
                "packedTileCount": tile_count,
                "geometricErrorPolicy": "packed-group-level",
                "rootGeometricErrorBefore": root_geometric_error_before,
                "rootGeometricErrorAfter": root_geometric_error_after,
            }
            root_tile = packed_tile_json(packed_root_record, root_center, root_diagonal)
        else:
            def prune_empty(record: TileRecord) -> bool:
                record.children = [child for child in record.children if prune_empty(child)]
                return record.content_uri is not None or bool(record.children)

            prune_empty(root_record)
            root_tile = tile_json(root_record, root_center, root_diagonal)

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
            "pointStep": args.point_step,
            "densityTarget": args.density_target,
            "densityApproximate": args.point_step > 1,
            "actualDensityRatio": actual_density_ratio(int(header.point_count), emitted_points),
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
        if tile_packing is not None:
            report["tilePacking"] = tile_packing
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
    parser.add_argument(
        "--point-step",
        type=int,
        default=1,
        help="Emit every Nth point per COPC node. This is approximate density sampling.",
    )
    parser.add_argument(
        "--density-target",
        default="full",
        help="Human label for the intended approximate density, e.g. p02, p10, full.",
    )
    parser.add_argument(
        "--tile-pack-mode",
        choices=["none", "level-group"],
        default="none",
        help="Optional PNTS packing strategy. Default keeps one COPC node per PNTS.",
    )
    parser.add_argument(
        "--tile-pack-group-level",
        type=int,
        default=3,
        help="COPC ancestor level used for level-group packing.",
    )
    parser.add_argument(
        "--tile-pack-target-bytes",
        type=int,
        default=524288,
        help="Soft target PNTS size for packing metadata and tuning.",
    )
    parser.add_argument(
        "--tile-pack-hard-max-bytes",
        type=int,
        default=5 * 1024 * 1024,
        help="Hard max estimated PNTS size before recursively splitting packed groups.",
    )
    args = parser.parse_args()
    if args.point_step < 1:
        parser.error("--point-step must be >= 1")
    if args.tile_pack_group_level < 1:
        parser.error("--tile-pack-group-level must be >= 1")
    if args.tile_pack_target_bytes < 1:
        parser.error("--tile-pack-target-bytes must be >= 1")
    if args.tile_pack_hard_max_bytes < args.tile_pack_target_bytes:
        parser.error("--tile-pack-hard-max-bytes must be >= --tile-pack-target-bytes")
    return args


if __name__ == "__main__":
    convert(parse_args())
