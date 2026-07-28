#!/usr/bin/env python3
"""Upgrade an existing 4-level Spatial LOD output to the 5-level p001 profile.

This is the "save the 36 hour build" path:

* build the new z0 p001 tiles from COPC with the canonical global ordinal
  sampling rule;
* split the already-built old z0 p02 2000m PNTS tiles into new z1 p02
  1000m PNTS tiles;
* hardlink the expensive old p10/p50/p100 PNTS levels into z2/z3/z4;
* rewrite only the 3D Tiles metadata tree.

It intentionally does not rebuild p02, p10, p50, or p100 from COPC.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import re
import shutil
import struct
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import numpy as np

import build_spatial_lod_tree as spatial


STATE_NAME = ".spatial-lod-p001-upgrade-state.json"
P001_FRAGMENTS_DIR = ".spatial-lod-p001-fragments"
SPLIT_Z1_FRAGMENTS_DIR = ".spatial-lod-z1-split-fragments"
UPGRADE_REPORT_GENERATOR = "SBB Spatial LOD P001 Upgrade V1"

OLD_PROFILE = (
    ("z0", 2000.0, 50, "p02", 2000.0),
    ("z1", 500.0, 10, "p10", 500.0),
    ("z2", 250.0, 2, "p50", 250.0),
    ("z3", 50.0, 1, "p100", 0.0),
)

SHIFTED_POINT_LEVELS = (
    ("z1", "z2"),
    ("z2", "z3"),
    ("z3", "z4"),
)

TILE_ID_RE = re.compile(r"^(z\d)_x(-?\d+)_y(-?\d+)$")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def zrange_from_box(box: list[float]) -> tuple[float, float]:
    return (float(box[2]) - abs(float(box[11])), float(box[2]) + abs(float(box[11])))


def union_zranges(ranges: Iterable[tuple[float, float]]) -> tuple[float, float] | None:
    items = list(ranges)
    if not items:
        return None
    return (min(item[0] for item in items), max(item[1] for item in items))


def parse_tile_id(value: str) -> tuple[str, int, int]:
    name = Path(value).stem if value.endswith(".pnts") or value.endswith(".json") else value
    match = TILE_ID_RE.match(name)
    if not match:
        raise SystemExit(f"Cannot parse tile id: {value}")
    return match.group(1), int(match.group(2)), int(match.group(3))


def tile_indices_from_tile(
    tile: dict[str, Any],
    level_name: str,
    grid_origin: tuple[float, float],
    cell: float,
) -> tuple[int, int]:
    uri = tile.get("content", {}).get("uri")
    if isinstance(uri, str) and uri.endswith(".pnts"):
        _level, ix, iy = parse_tile_id(Path(uri).name)
        return ix, iy

    box = tile.get("boundingVolume", {}).get("box")
    if not isinstance(box, list) or len(box) < 12:
        raise SystemExit(f"Cannot infer {level_name} tile index without content URI or box")
    ox, oy = grid_origin
    ix = int(round((float(box[0]) - ox) / cell - 0.5))
    iy = int(round((float(box[1]) - oy) / cell - 0.5))
    return ix, iy


def content_target(base_json_path: Path, uri: str) -> Path:
    return (base_json_path.parent / uri).resolve()


def read_pnts_header_light(path: Path) -> dict[str, Any]:
    with open(path, "rb") as fp:
        header = fp.read(28)
        if len(header) != 28:
            raise ValueError(f"PNTS header too short: {path}")
        magic, version, byte_length, ft_json_len, ft_bin_len, bt_json_len, bt_bin_len = struct.unpack(
            "<4sIIIIII", header
        )
        if magic != b"pnts":
            raise ValueError(f"Not a PNTS file: {path}")
        feature_json = fp.read(ft_json_len)
    feature = json.loads(feature_json.decode("utf-8").strip())
    return {
        "version": int(version),
        "byteLength": int(byte_length),
        "ftJsonLength": int(ft_json_len),
        "ftBinaryLength": int(ft_bin_len),
        "btJsonLength": int(bt_json_len),
        "btBinaryLength": int(bt_bin_len),
        "featureTable": feature,
    }


def read_pnts_points(path: Path) -> tuple[np.ndarray, np.ndarray | None, np.ndarray]:
    data = path.read_bytes()
    if len(data) < 28 or data[:4] != b"pnts":
        raise SystemExit(f"Not a PNTS file: {path}")
    _magic, _version, byte_length, ft_json_len, ft_bin_len, _bt_json_len, _bt_bin_len = struct.unpack(
        "<4sIIIIII", data[:28]
    )
    if byte_length != len(data):
        raise SystemExit(f"PNTS byteLength mismatch: {path}")
    ft_start = 28
    ft_end = ft_start + ft_json_len
    ft = json.loads(data[ft_start:ft_end].decode("utf-8").strip())
    points_length = int(ft.get("POINTS_LENGTH", 0))
    if points_length <= 0:
        return np.empty((0, 3), dtype=np.float64), None, np.asarray(ft.get("RTC_CENTER", [0, 0, 0]), dtype=np.float64)
    rtc_center = np.asarray(ft["RTC_CENTER"], dtype=np.float64)
    bin_start = ft_end
    bin_end = bin_start + ft_bin_len
    feature_bin = memoryview(data)[bin_start:bin_end]

    pos_offset = int(ft.get("POSITION", {}).get("byteOffset", 0))
    pos_bytes = points_length * spatial.POINT_BYTES_XYZ
    positions = np.frombuffer(
        feature_bin[pos_offset : pos_offset + pos_bytes],
        dtype="<f4",
        count=points_length * 3,
    ).reshape(points_length, 3)
    xyz_abs = positions.astype(np.float64) + rtc_center

    rgb = None
    if "RGB" in ft:
        rgb_offset = int(ft["RGB"].get("byteOffset", pos_bytes))
        rgb = np.frombuffer(
            feature_bin[rgb_offset : rgb_offset + points_length * 3],
            dtype=np.uint8,
            count=points_length * 3,
        ).reshape(points_length, 3).copy()
    return xyz_abs, rgb, rtc_center


def write_absolute_pnts(
    path: Path,
    xyz_abs: np.ndarray,
    rgb: np.ndarray | None,
    rtc_center: np.ndarray,
) -> int:
    local = np.asarray(xyz_abs, dtype=np.float64) - np.asarray(rtc_center, dtype=np.float64)
    return spatial.write_pnts_atomic(path, local, rgb, np.asarray(rtc_center, dtype=np.float64))


def iter_xy_groups(ixs: np.ndarray, iys: np.ndarray) -> Iterable[tuple[int, int, np.ndarray]]:
    if ixs.size == 0:
        return
    order = np.lexsort((iys, ixs))
    six = ixs[order]
    siy = iys[order]
    breaks = np.flatnonzero((np.diff(six) != 0) | (np.diff(siy) != 0)) + 1
    for group in np.split(order, breaks):
        if group.size:
            yield int(ixs[group[0]]), int(iys[group[0]]), group


def serialize_tile_counts(counts: dict[tuple[int, int], int]) -> list[list[int]]:
    return [[ix, iy, cnt] for (ix, iy), cnt in sorted(counts.items())]


def deserialize_tile_counts(items: list[list[int]]) -> dict[tuple[int, int], int]:
    return {(int(ix), int(iy)): int(cnt) for ix, iy, cnt in items}


def serialize_zranges(zranges: dict[tuple[int, int], tuple[float, float]]) -> list[list[float]]:
    return [[ix, iy, float(zmin), float(zmax)] for (ix, iy), (zmin, zmax) in sorted(zranges.items())]


def deserialize_zranges(items: list[list[float]]) -> dict[tuple[int, int], tuple[float, float]]:
    return {(int(ix), int(iy)): (float(zmin), float(zmax)) for ix, iy, zmin, zmax in items}


def update_zrange(
    zranges: dict[tuple[int, int], tuple[float, float]],
    key: tuple[int, int],
    z_values: np.ndarray,
) -> None:
    if z_values.size == 0:
        return
    zmin = float(np.min(z_values))
    zmax = float(np.max(z_values))
    if key in zranges:
        old_min, old_max = zranges[key]
        zranges[key] = (min(old_min, zmin), max(old_max, zmax))
    else:
        zranges[key] = (zmin, zmax)


def validate_old_profile(report: dict[str, Any]) -> None:
    profile = report.get("profile")
    if not isinstance(profile, list) or len(profile) != len(OLD_PROFILE):
        raise SystemExit("Source spatial-lod report does not look like the old 4-level profile")
    for actual, expected in zip(profile, OLD_PROFILE):
        level, cell, step, density, error = expected
        if (
            actual.get("level") != level
            or float(actual.get("cell")) != cell
            or int(actual.get("step")) != step
            or actual.get("density") != density
            or float(actual.get("geometricError")) != error
        ):
            raise SystemExit(
                "Source spatial-lod profile mismatch. Expected the old "
                "z0:p02/z1:p10/z2:p50/z3:p100 output."
            )


def collect_z0_records(source_dir: Path, entry_doc: dict[str, Any]) -> list[dict[str, Any]]:
    root = entry_doc.get("root")
    if not isinstance(root, dict):
        raise SystemExit("Source tileset has no root")
    records: list[dict[str, Any]] = []
    for leaf in root.get("children", []):
        uri = leaf.get("content", {}).get("uri")
        if not isinstance(uri, str) or not uri.endswith(spatial.ENTRY_TILESET):
            raise SystemExit(f"Unexpected source z0 URI: {uri}")
        _level, ix, iy = parse_tile_id(Path(uri).parent.name)
        z0_doc_path = (source_dir / uri).resolve()
        z0_doc = read_json(z0_doc_path)
        z0_root = z0_doc.get("root")
        if not isinstance(z0_root, dict):
            raise SystemExit(f"z0 document has no root: {z0_doc_path}")
        content_uri = z0_root.get("content", {}).get("uri")
        if not isinstance(content_uri, str) or not content_uri.endswith(".pnts"):
            raise SystemExit(f"Old z0 p02 content missing: {z0_doc_path}")
        old_pnts = content_target(z0_doc_path, content_uri)
        if not old_pnts.exists():
            raise SystemExit(f"Old z0 p02 PNTS missing: {old_pnts}")
        records.append({
            "id": spatial.tile_id("z0", ix, iy),
            "ix": ix,
            "iy": iy,
            "entryLeaf": leaf,
            "docPath": z0_doc_path,
            "doc": z0_doc,
            "root": z0_root,
            "box": z0_root["boundingVolume"]["box"],
            "oldPnts": old_pnts,
        })
    return sorted(records, key=lambda item: (item["ix"], item["iy"]))


def append_level_fragment(
    fragments_dir: Path,
    fragment_group: str,
    level_name: str,
    tile_id: str,
    xyz_abs: np.ndarray,
    rgb: np.ndarray | None,
    has_rgb: bool,
) -> None:
    frag_path = fragments_dir / fragment_group / level_name / f"{tile_id}.bin"
    frag_path.parent.mkdir(parents=True, exist_ok=True)
    if has_rgb and rgb is not None:
        rec = np.empty(int(xyz_abs.shape[0]), dtype=spatial.RGB_DTYPE)
        rec["xyz"] = np.asarray(xyz_abs, dtype="<f4")
        rec["rgb"] = np.asarray(rgb, dtype=np.uint8)
        payload = rec.tobytes()
    else:
        payload = np.asarray(xyz_abs, dtype="<f4").tobytes(order="C")
    with open(frag_path, "ab") as fp:
        fp.write(payload)


def append_fragment(
    fragments_dir: Path,
    chunk_id: str,
    tile_id: str,
    xyz_abs: np.ndarray,
    rgb: np.ndarray | None,
    has_rgb: bool,
) -> None:
    append_level_fragment(fragments_dir, chunk_id, "z0", tile_id, xyz_abs, rgb, has_rgb)


def merge_level_fragments(
    fragments_dir: Path,
    level_name: str,
    tile_id: str,
    has_rgb: bool,
) -> tuple[np.ndarray, np.ndarray | None]:
    point_bytes = spatial.POINT_BYTES_RGB if has_rgb else spatial.POINT_BYTES_XYZ
    parts = []
    for chunk_dir in sorted(fragments_dir.iterdir()):
        frag = chunk_dir / level_name / f"{tile_id}.bin"
        if frag.exists():
            parts.append(np.frombuffer(frag.read_bytes(), dtype=np.uint8))
    if not parts:
        return np.empty((0, 3), dtype=np.float32), None
    buf = np.concatenate(parts)
    count = buf.size // point_bytes
    buf = buf[: count * point_bytes]
    if has_rgb:
        rec = np.frombuffer(buf.tobytes(), dtype=spatial.RGB_DTYPE, count=count)
        return rec["xyz"].astype(np.float32).copy(), rec["rgb"].copy()
    return np.frombuffer(buf.tobytes(), dtype="<f4", count=count * 3).reshape(count, 3).copy(), None


def merge_p001_fragments(
    fragments_dir: Path,
    tile_id: str,
    has_rgb: bool,
) -> tuple[np.ndarray, np.ndarray | None]:
    return merge_level_fragments(fragments_dir, "z0", tile_id, has_rgb)


def process_p001_batch(
    xyz_enu: np.ndarray,
    rgb: np.ndarray | None,
    ordinals: np.ndarray,
    grid_origin: tuple[float, float],
    has_rgb: bool,
    fragments_dir: Path,
    chunk_id: str,
    counts: dict[tuple[int, int], int],
    zranges: dict[tuple[int, int], tuple[float, float]],
) -> None:
    xyz = np.asarray(xyz_enu, dtype=np.float64)
    finite = np.isfinite(xyz).all(axis=1)
    mask = finite & ((ordinals % spatial.LEVEL_BY_NAME["z0"].step) == 0)
    if not bool(mask.any()):
        return
    selected = xyz[mask]
    selected_rgb = None
    if has_rgb and rgb is not None:
        selected_rgb = np.asarray(rgb, dtype=np.uint8)[mask]
    ox, oy = grid_origin
    ixs = np.floor((selected[:, 0] - ox) / spatial.Z0_CELL).astype(np.int64)
    iys = np.floor((selected[:, 1] - oy) / spatial.Z0_CELL).astype(np.int64)
    for ix, iy, group in iter_xy_groups(ixs, iys):
        sub = selected[group]
        tid = spatial.tile_id("z0", ix, iy)
        append_fragment(
            fragments_dir,
            chunk_id,
            tid,
            sub,
            selected_rgb[group] if selected_rgb is not None else None,
            has_rgb,
        )
        key = (ix, iy)
        counts[key] = counts.get(key, 0) + int(group.size)
        update_zrange(zranges, key, sub[:, 2])


def stream_p001_from_copc(
    files: list[Path],
    frame: dict[str, Any],
    grid_origin: tuple[float, float],
    has_rgb: bool,
    fragments_dir: Path,
    state_path: Path,
    state: dict[str, Any],
    resume: bool,
) -> tuple[dict[tuple[int, int], int], dict[tuple[int, int], tuple[float, float]]]:
    import laspy  # noqa: F401  # lazy import documents the runtime dependency
    from laspy._compression.selection import DecompressionSelection
    from laspy.copc import CopcReader, load_octree_for_query

    counts = deserialize_tile_counts(state.get("p001Counts", [])) if resume else {}
    zranges = deserialize_zranges(state.get("p001Zrange", [])) if resume else {}
    completed = set(state.get("completedChunks", [])) if resume else set()
    ordinal = 0
    selection = DecompressionSelection.XY_RETURNS_CHANNEL | DecompressionSelection.Z
    if has_rgb:
        selection |= DecompressionSelection.RGB

    for path in files:
        chunk_id = path.stem
        if chunk_id in completed:
            ordinal = int(state.get("chunkOrdinals", {}).get(chunk_id, ordinal))
            print(f"  p001: skip {chunk_id} (checkpoint ordinal={ordinal})")
            continue

        chunk_frag_dir = fragments_dir / chunk_id
        if chunk_frag_dir.exists():
            shutil.rmtree(chunk_frag_dir)

        with CopcReader.open(path, decompression_selection=selection) as reader:
            nodes = load_octree_for_query(reader.source, reader.copc_info, reader.root_page)
            node_count = len(nodes)
            print(f"  p001: {chunk_id}: {node_count} nodes")
            node_index = 0
            for node in sorted(nodes, key=lambda nd: spatial.nodes_by_key_key(nd.key)):
                if int(node.point_count) <= 0:
                    continue
                node_index += 1
                points = reader._fetch_and_decompress_points_of_nodes([node])
                xyz_source = np.column_stack(
                    (np.asarray(points.x), np.asarray(points.y), np.asarray(points.z))
                ).astype(np.float64)
                n = int(xyz_source.shape[0])
                ordinals = ordinal + np.arange(n, dtype=np.int64)
                rgb = None
                if has_rgb:
                    rgb = np.column_stack(
                        (
                            spatial.color_to_u8(np.asarray(points.red)),
                            spatial.color_to_u8(np.asarray(points.green)),
                            spatial.color_to_u8(np.asarray(points.blue)),
                        )
                    )
                xyz_enu = spatial.source_points_to_enu(xyz_source, frame)
                process_p001_batch(
                    xyz_enu,
                    rgb,
                    ordinals,
                    grid_origin,
                    has_rgb,
                    fragments_dir,
                    chunk_id,
                    counts,
                    zranges,
                )
                ordinal += n
                if node_index % 25 == 0 or node_index == node_count:
                    print(f"    p001: {chunk_id}: node {node_index}/{node_count} ordinal={ordinal}")

        state.setdefault("chunkOrdinals", {})[chunk_id] = ordinal
        state.setdefault("completedChunks", []).append(chunk_id)
        state["p001Counts"] = serialize_tile_counts(counts)
        state["p001Zrange"] = serialize_zranges(zranges)
        spatial.write_json_atomic(state_path, state)
        print(f"  p001 checkpoint: {chunk_id} (ordinal={ordinal})")

    return counts, zranges


def finalize_p001_z0(
    target_dir: Path,
    fragments_dir: Path,
    z0_records: list[dict[str, Any]],
    counts: dict[tuple[int, int], int],
    has_rgb: bool,
    grid_origin: tuple[float, float],
) -> dict[str, dict[str, int]]:
    z0_box_by_key = {(rec["ix"], rec["iy"]): rec["box"] for rec in z0_records}
    per_level = {"tiles": 0, "points": 0, "bytes": 0}
    for (ix, iy), cnt in sorted(counts.items()):
        if cnt <= 0:
            continue
        tid = spatial.tile_id("z0", ix, iy)
        xyz_abs, rgb = merge_p001_fragments(fragments_dir, tid, has_rgb)
        if int(xyz_abs.shape[0]) != int(cnt):
            raise SystemExit(f"p001 fragment count mismatch for {tid}: {xyz_abs.shape[0]} != {cnt}")
        box = z0_box_by_key.get((ix, iy))
        if box is None:
            zmin = float(xyz_abs[:, 2].min())
            zmax = float(xyz_abs[:, 2].max())
            box = spatial.box_for_cell(
                "z0", ix, iy, grid_origin[0], grid_origin[1], spatial.Z0_CELL, zmin, zmax
            )
        rtc_center = np.asarray([box[0], box[1], box[2]], dtype=np.float64)
        out_path = target_dir / "points" / "z0" / f"{tid}.pnts"
        byte_len = write_absolute_pnts(out_path, xyz_abs, rgb, rtc_center)
        per_level["tiles"] += 1
        per_level["points"] += int(cnt)
        per_level["bytes"] += byte_len
    return {"z0": per_level}


def split_old_z0_p02_to_new_z1(
    source_z0_records: list[dict[str, Any]],
    target_dir: Path,
    grid_origin: tuple[float, float],
    has_rgb: bool,
) -> tuple[dict[str, int], dict[tuple[int, int], tuple[float, float]]]:
    ox, oy = grid_origin
    per_level = {"tiles": 0, "points": 0, "bytes": 0}
    z1_zranges: dict[tuple[int, int], tuple[float, float]] = {}
    counts: dict[tuple[int, int], int] = {}
    split_fragments_dir = target_dir / SPLIT_Z1_FRAGMENTS_DIR
    if split_fragments_dir.exists():
        shutil.rmtree(split_fragments_dir)

    for rec in source_z0_records:
        xyz_abs, rgb, _rtc = read_pnts_points(rec["oldPnts"])
        if xyz_abs.size == 0:
            continue
        ixs = np.floor((xyz_abs[:, 0] - ox) / spatial.Z1_CELL).astype(np.int64)
        iys = np.floor((xyz_abs[:, 1] - oy) / spatial.Z1_CELL).astype(np.int64)
        for ix, iy, group in iter_xy_groups(ixs, iys):
            key = (ix, iy)
            sub = xyz_abs[group]
            sub_rgb = rgb[group] if rgb is not None else None
            tid = spatial.tile_id("z1", ix, iy)
            append_level_fragment(
                split_fragments_dir,
                str(rec["id"]),
                "z1",
                tid,
                sub,
                sub_rgb,
                has_rgb,
            )
            counts[key] = counts.get(key, 0) + int(group.size)
            update_zrange(z1_zranges, key, sub[:, 2])

    for (ix, iy), cnt in sorted(counts.items()):
        tid = spatial.tile_id("z1", ix, iy)
        xyz_abs, rgb = merge_level_fragments(split_fragments_dir, "z1", tid, has_rgb)
        if int(xyz_abs.shape[0]) != int(cnt):
            raise SystemExit(f"z1 split fragment count mismatch for {tid}: {xyz_abs.shape[0]} != {cnt}")
        zmin, zmax = z1_zranges[(ix, iy)]
        rtc_center = np.asarray(
            [ox + (ix + 0.5) * spatial.Z1_CELL, oy + (iy + 0.5) * spatial.Z1_CELL, (zmin + zmax) / 2.0],
            dtype=np.float64,
        )
        out_path = target_dir / "points" / "z1" / f"{tid}.pnts"
        byte_len = write_absolute_pnts(out_path, xyz_abs, rgb, rtc_center)
        per_level["tiles"] += 1
        per_level["points"] += int(cnt)
        per_level["bytes"] += byte_len

    shutil.rmtree(split_fragments_dir, ignore_errors=True)

    if has_rgb:
        for path in sorted((target_dir / "points" / "z1").glob("*.pnts"))[:3]:
            header = read_pnts_header_light(path)
            if "RGB" not in header["featureTable"]:
                raise SystemExit(f"Expected RGB in split p02 tile: {path}")
    return per_level, z1_zranges


def link_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        if dst.stat().st_size == src.stat().st_size:
            return
        raise SystemExit(f"Target exists with different size: {dst}")
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def link_shifted_point_levels(source_dir: Path, target_dir: Path, old_report: dict[str, Any]) -> dict[str, dict[str, int]]:
    per_level: dict[str, dict[str, int]] = {}
    for old_level, new_level in SHIFTED_POINT_LEVELS:
        src_dir = source_dir / "points" / old_level
        if not src_dir.exists():
            raise SystemExit(f"Missing old point level: {src_dir}")
        for src in sorted(src_dir.glob("*.pnts")):
            _level, ix, iy = parse_tile_id(src.name)
            new_tid = spatial.tile_id(new_level, ix, iy)
            dst = target_dir / "points" / new_level / f"{new_tid}.pnts"
            link_or_copy(src, dst)
        old_metrics = old_report.get("perLevel", {}).get(old_level)
        if not isinstance(old_metrics, dict):
            raise SystemExit(f"Missing old report metrics for {old_level}")
        per_level[new_level] = {
            "tiles": int(old_metrics.get("tiles", 0)),
            "points": int(old_metrics.get("points", 0)),
            "bytes": int(old_metrics.get("bytes", 0)),
        }
    return per_level


def rewrite_content_uri(uri: str, new_level: str, ix: int, iy: int) -> str:
    new_tid = spatial.tile_id(new_level, ix, iy)
    return f"../../points/{new_level}/{new_tid}.pnts"


def shift_old_tile(
    old_tile: dict[str, Any],
    old_level: str,
    grid_origin: tuple[float, float],
) -> dict[str, Any]:
    new_level = f"z{int(old_level[1]) + 1}"
    old_cell = OLD_PROFILE[int(old_level[1])][1]
    ix, iy = tile_indices_from_tile(old_tile, old_level, grid_origin, old_cell)

    tile = copy.deepcopy(old_tile)
    tile["geometricError"] = spatial.LEVEL_BY_NAME[new_level].error
    content = tile.get("content")
    if isinstance(content, dict) and isinstance(content.get("uri"), str):
        tile["content"] = {"uri": rewrite_content_uri(content["uri"], new_level, ix, iy)}

    old_children = [child for child in old_tile.get("children", []) if isinstance(child, dict)]
    if old_children:
        child_old_level = f"z{int(old_level[1]) + 1}"
        tile["children"] = [
            shift_old_tile(child, child_old_level, grid_origin)
            for child in old_children
        ]
    else:
        tile.pop("children", None)
    return tile


def sort_tiles_by_index(
    tiles: list[dict[str, Any]],
    level_name: str,
    grid_origin: tuple[float, float],
    cell: float,
) -> list[dict[str, Any]]:
    return sorted(
        tiles,
        key=lambda tile: tile_indices_from_tile(tile, level_name, grid_origin, cell),
    )


def refresh_z4_request_volumes(tile: dict[str, Any], level_name: str, grid_origin: tuple[float, float]) -> None:
    children = [child for child in tile.get("children", []) if isinstance(child, dict)]
    if not children:
        return
    if level_name == "z3":
        box = tile.get("boundingVolume", {}).get("box")
        if not isinstance(box, list) or len(box) != 12:
            raise SystemExit("Cannot refresh z4 viewerRequestVolume without z3 bounding box")
        ix, iy = tile_indices_from_tile(tile, "z3", grid_origin, spatial.Z3_CELL)
        zmin, zmax = zrange_from_box(box)
        rv = spatial.detail_request_volume("z3", ix, iy, grid_origin[0], grid_origin[1], zmin, zmax)
        for child in children:
            child["viewerRequestVolume"] = {"box": rv}
        return
    next_level = f"z{int(level_name[1]) + 1}"
    for child in children:
        refresh_z4_request_volumes(child, next_level, grid_origin)


def build_new_tree(
    old_entry: dict[str, Any],
    z0_records: list[dict[str, Any]],
    target_dir: Path,
    grid_origin: tuple[float, float],
    p001_counts: dict[tuple[int, int], int],
    z1_zranges: dict[tuple[int, int], tuple[float, float]],
    output_name: str,
    logical: str,
) -> tuple[dict[str, Any], int]:
    ox, oy = grid_origin
    z0_leaves: list[dict[str, Any]] = []
    occupied_count = 0

    for rec in z0_records:
        ix0, iy0 = int(rec["ix"]), int(rec["iy"])
        old_root = rec["root"]
        shifted_by_z1: dict[tuple[int, int], list[dict[str, Any]]] = {}
        for old_child in old_root.get("children", []):
            if not isinstance(old_child, dict):
                continue
            old_ix, old_iy = tile_indices_from_tile(old_child, "z1", grid_origin, OLD_PROFILE[1][1])
            parent_key = (old_ix // 2, old_iy // 2)
            shifted_by_z1.setdefault(parent_key, []).append(shift_old_tile(old_child, "z1", grid_origin))

        z1_keys = set(shifted_by_z1.keys())
        for key in z1_zranges:
            if key[0] // 2 == ix0 and key[1] // 2 == iy0:
                z1_keys.add(key)

        z1_children: list[dict[str, Any]] = []
        for ix1, iy1 in sorted(z1_keys):
            children = sort_tiles_by_index(
                shifted_by_z1.get((ix1, iy1), []),
                "z2",
                grid_origin,
                spatial.Z2_CELL,
            )
            ranges = []
            if (ix1, iy1) in z1_zranges:
                ranges.append(z1_zranges[(ix1, iy1)])
            ranges.extend(zrange_from_box(child["boundingVolume"]["box"]) for child in children)
            zrng = union_zranges(ranges)
            if zrng is None:
                continue
            box = spatial.box_for_cell("z1", ix1, iy1, ox, oy, spatial.Z1_CELL, zrng[0], zrng[1])
            z1_tile: dict[str, Any] = {
                "boundingVolume": {"box": box},
                "geometricError": spatial.LEVEL_BY_NAME["z1"].error,
                "refine": "REPLACE",
            }
            if (ix1, iy1) in z1_zranges:
                tid = spatial.tile_id("z1", ix1, iy1)
                z1_tile["content"] = {"uri": f"../../points/z1/{tid}.pnts"}
            if children:
                z1_tile["children"] = children
            z1_children.append(z1_tile)

        z0_root: dict[str, Any] = {
            "boundingVolume": copy.deepcopy(old_root["boundingVolume"]),
            "geometricError": spatial.LEVEL_BY_NAME["z0"].error,
            "refine": "REPLACE",
        }
        if (ix0, iy0) in p001_counts:
            tid = spatial.tile_id("z0", ix0, iy0)
            z0_root["content"] = {"uri": f"../../points/z0/{tid}.pnts"}
        if z1_children:
            z0_root["children"] = z1_children
        refresh_z4_request_volumes(z0_root, "z0", grid_origin)

        z0_doc = {
            "asset": {
                "version": "1.0",
                "extras": {
                    "generator": UPGRADE_REPORT_GENERATOR,
                    "spatialLod": True,
                    "z0Tile": rec["id"],
                    "sourceProfile": "z0:p02,z1:p10,z2:p50,z3:p100",
                    "targetProfile": "z0:p001,z1:p02,z2:p10,z3:p50,z4:p100",
                },
            },
            "geometricError": spatial.LEVEL_BY_NAME["z0"].error,
            "root": z0_root,
        }
        z0_dir = target_dir / "z0" / rec["id"]
        spatial.write_json_atomic(z0_dir / spatial.ENTRY_TILESET, z0_doc)
        print(f"    wrote subtree {rec['id']} ({len(z1_children)} z1 children)")
        occupied_count += sum(1 for _ in walk_tiles(z0_root))

        entry_leaf = copy.deepcopy(rec["entryLeaf"])
        entry_leaf["geometricError"] = spatial.LEVEL_BY_NAME["z0"].error
        z0_leaves.append(entry_leaf)

    new_entry = copy.deepcopy(old_entry)
    extras = new_entry.setdefault("asset", {}).setdefault("extras", {})
    extras["generator"] = UPGRADE_REPORT_GENERATOR
    extras["logicalDataset"] = logical
    extras["spatialLod"] = True
    extras["profile"] = [level.name for level in spatial.LEVELS]
    extras["upgradeSourceProfile"] = ["z0:p02", "z1:p10", "z2:p50", "z3:p100"]
    extras["upgradeOutputName"] = output_name
    new_entry["root"]["children"] = z0_leaves
    return new_entry, occupied_count


def walk_tiles(tile: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield tile
    for child in tile.get("children", []):
        if isinstance(child, dict):
            yield from walk_tiles(child)


def validate_fast(entry_doc: dict[str, Any], output_dir: Path, validate_headers: bool = False) -> None:
    root = entry_doc.get("root")
    if not isinstance(root, dict):
        raise SystemExit("Entry has no root")
    if not isinstance(root.get("transform"), list) or len(root["transform"]) != 16:
        raise SystemExit("Entry root must carry a 16-value transform")
    if root.get("refine") != "REPLACE":
        raise SystemExit("Entry root must use REPLACE")
    entry_error = float(root.get("geometricError", 0.0))
    grid_origin = grid_origin_from_entry(entry_doc)

    for leaf in root.get("children", []):
        uri = leaf.get("content", {}).get("uri")
        if not isinstance(uri, str) or not uri.endswith(spatial.ENTRY_TILESET):
            raise SystemExit(f"Entry child must reference a z0 tileset: {uri}")
        if float(leaf.get("geometricError", 0.0)) > entry_error + 1e-6:
            raise SystemExit("Entry child geometricError exceeds entry root")
        z0_path = (output_dir / uri).resolve()
        if not z0_path.exists():
            raise SystemExit(f"Missing z0 document: {uri}")
        z0_doc = read_json(z0_path)
        print(f"    validate subtree {Path(uri).parent.name}")
        validate_z0_doc_fast(z0_path, z0_doc, validate_headers=validate_headers, grid_origin=grid_origin)


def grid_origin_from_entry(entry_doc: dict[str, Any]) -> tuple[float, float] | None:
    extras = entry_doc.get("asset", {}).get("extras", {})
    grid_origin_raw = extras.get("gridOrigin")
    if isinstance(grid_origin_raw, list) and len(grid_origin_raw) >= 2:
        return (float(grid_origin_raw[0]), float(grid_origin_raw[1]))
    return None


def refresh_output_z4_request_volumes(output_dir: Path, entry_doc: dict[str, Any]) -> None:
    grid_origin = grid_origin_from_entry(entry_doc)
    if grid_origin is None:
        raise SystemExit("Cannot refresh z4 viewerRequestVolume without entry asset.extras.gridOrigin")
    root = entry_doc.get("root")
    if not isinstance(root, dict):
        raise SystemExit("Entry has no root")
    for leaf in root.get("children", []):
        uri = leaf.get("content", {}).get("uri")
        if not isinstance(uri, str) or not uri.endswith(spatial.ENTRY_TILESET):
            continue
        z0_path = (output_dir / uri).resolve()
        z0_doc = read_json(z0_path)
        refresh_z4_request_volumes(z0_doc["root"], "z0", grid_origin)
        spatial.write_json_atomic(z0_path, z0_doc)
    report_path = output_dir / spatial.REPORT_NAME
    if report_path.exists():
        report = read_json(report_path)
        report["requestVolumePolicy"] = spatial.request_volume_policy()
        spatial.write_json_atomic(report_path, report)


def validate_z0_doc_fast(
    path: Path,
    doc: dict[str, Any],
    validate_headers: bool = False,
    grid_origin: tuple[float, float] | None = None,
) -> None:
    root = doc.get("root")
    if not isinstance(root, dict):
        raise SystemExit(f"z0 document has no root: {path}")
    if "transform" in root:
        raise SystemExit(f"Only entry root may carry transform: {path}")

    def visit(
        tile: dict[str, Any],
        parent_box: list[float] | None,
        parent_error: float,
        level_name: str,
    ) -> None:
        if tile.get("refine") != "REPLACE":
            raise SystemExit(f"Tile must use REPLACE: {path}")
        box = tile.get("boundingVolume", {}).get("box")
        if not isinstance(box, list) or len(box) != 12:
            raise SystemExit(f"Invalid boundingVolume in {path}")
        error = float(tile.get("geometricError", 0.0))
        if error > parent_error + 1e-6:
            raise SystemExit(f"geometricError increases in {path}: {error} > {parent_error}")
        if parent_box is not None and not spatial.box_contains(parent_box, box):
            raise SystemExit(f"Parent bbox does not contain child in {path}")
        uri = tile.get("content", {}).get("uri")
        if isinstance(uri, str):
            target = (path.parent / uri).resolve()
            if not target.exists():
                raise SystemExit(f"Missing content in {path}: {uri}")
            if validate_headers and uri.endswith(".pnts"):
                header = read_pnts_header_light(target)
                if header["byteLength"] != target.stat().st_size:
                    raise SystemExit(f"PNTS byteLength mismatch: {target}")
                if int(header["featureTable"].get("POINTS_LENGTH", -1)) < 0:
                    raise SystemExit(f"Invalid PNTS point length: {target}")
            if "/z4/" in uri and "viewerRequestVolume" not in tile:
                raise SystemExit(f"z4 leaf missing viewerRequestVolume: {uri}")
        children = [child for child in tile.get("children", []) if isinstance(child, dict)]
        if level_name == "z3" and children:
            leaf_volumes: list[list[float]] = []
            for child in children:
                child_uri = child.get("content", {}).get("uri")
                if isinstance(child_uri, str) and "/z4/" in child_uri:
                    rv = child.get("viewerRequestVolume", {}).get("box")
                    if not isinstance(rv, list) or len(rv) != 12:
                        raise SystemExit(f"z4 leaf missing valid viewerRequestVolume: {child_uri}")
                    if not spatial.box_contains(rv, box):
                        raise SystemExit(f"z4 viewerRequestVolume does not contain z3 parent box: {child_uri}")
                    leaf_volumes.append(rv)
            if leaf_volumes:
                first = leaf_volumes[0]
                for rv in leaf_volumes[1:]:
                    if rv != first:
                        raise SystemExit(f"z4 siblings do not share viewerRequestVolume in {path}")
                if grid_origin is not None:
                    ix, iy = tile_indices_from_tile(tile, "z3", grid_origin, spatial.Z3_CELL)
                    zmin, zmax = zrange_from_box(box)
                    expected = spatial.detail_request_volume("z3", ix, iy, grid_origin[0], grid_origin[1], zmin, zmax)
                    if first != expected:
                        raise SystemExit(f"z4 viewerRequestVolume does not match z3 parent in {path}")
        next_level = f"z{int(level_name[1]) + 1}" if level_name != "z4" else "z4"
        for child in tile.get("children", []):
            if isinstance(child, dict):
                visit(child, box, error, next_level)

    visit(root, None, float("inf"), "z0")


def build_report(
    old_report: dict[str, Any],
    old_entry: dict[str, Any],
    preflight: dict[str, Any],
    per_level: dict[str, dict[str, int]],
    logical: str,
    output_name: str,
    occupied_count: int,
    z0_count: int,
) -> dict[str, Any]:
    extras = old_entry.get("asset", {}).get("extras", {})
    root = old_entry["root"]
    grid_origin = tuple(float(v) for v in extras.get("gridOrigin", old_report.get("gridOrigin")))
    report = spatial._build_report(
        logical=logical,
        output_name=output_name,
        grid_origin=grid_origin,
        root_transform=root["transform"],
        enu_origin_lonlat=tuple(float(v) for v in extras.get("enuOriginLonLat", old_report["enuOriginLonLat"])),
        enu_origin_source=[float(v) for v in extras.get("enuOriginSource", old_report["enuOriginSource"])],
        enu_origin_ecef=[float(v) for v in extras.get("enuOriginEcef", old_report["enuOriginEcef"])],
        bounds_filter=tuple(old_report["boundsFilter"]) if old_report.get("boundsFilter") else None,
        has_rgb=bool(old_report.get("hasRgb", preflight["has_rgb"])),
        per_level=per_level,
        source_files=preflight["records"],
        area_manifest_uri=str(old_report.get("areaManifestUri", "../area-manifest.json")),
        total_source_points=int(old_report.get("totalSourcePoints", preflight["total_points"])),
        entry_box=root["boundingVolume"]["box"],
        entry_error=float(root["geometricError"]),
        z0_count=z0_count,
        occupied_count=occupied_count,
    )
    report["generator"] = UPGRADE_REPORT_GENERATOR
    report["upgrade"] = {
        "strategy": "build-z0-p001-from-copc;split-old-z0-p02-to-z1;hardlink-old-z1-z2-z3-to-new-z2-z3-z4",
        "sourceProfile": old_report.get("profile"),
        "targetProfile": report.get("profile"),
        "sourceOutputName": old_report.get("outputName"),
    }
    return report


def replace_source_with_target(source_dir: Path, target_dir: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = source_dir.with_name(f"{source_dir.name}.backup-before-p001-{timestamp}")
    if backup_dir.exists():
        raise SystemExit(f"Backup path already exists: {backup_dir}")
    source_dir.rename(backup_dir)
    target_dir.rename(source_dir)
    return backup_dir


def upgrade_spatial_lod_p001(
    root_dir: Path,
    dataset: str,
    public_root: str = "",
    source_name: str | None = None,
    target_name: str | None = None,
    overwrite_target: bool = False,
    resume: bool = False,
    replace: bool = False,
    dry_run: bool = False,
    promote_existing: bool = False,
    full_validate: bool = False,
) -> dict[str, Any]:
    dataset = spatial.validate_name(dataset, "dataset")
    public_root = spatial.validate_name(public_root, "public-root") if public_root else ""
    logical = public_root or dataset
    source_name = spatial.validate_name(source_name or f"{logical}-spatial-lod", "source-name")
    target_name = spatial.validate_name(target_name or f"{logical}-spatial-lod-p001-upgrade", "target-name")
    if overwrite_target and resume:
        raise SystemExit("--overwrite-target and --resume are mutually exclusive")
    if promote_existing and (overwrite_target or resume or replace):
        raise SystemExit("--promote-existing cannot be combined with --overwrite-target, --resume, or --replace")

    root_dir = root_dir.resolve()
    tilesets_root = (root_dir / "local-storage" / "tilesets").resolve()
    intermediate_root = (root_dir / "local-storage" / "intermediate").resolve()
    source_dir = (tilesets_root / logical / source_name).resolve()
    target_dir = (tilesets_root / logical / target_name).resolve()
    input_dir = (intermediate_root / dataset / "chunks-copc").resolve()

    if target_dir == source_dir:
        raise SystemExit("target-name must be different from source-name for this safe upgrade path")
    if not source_dir.exists():
        raise SystemExit(f"Source spatial-lod output not found: {source_dir}")
    spatial.assert_inside(source_dir, tilesets_root, "source dir")
    spatial.assert_inside(target_dir, tilesets_root, "target dir")

    if promote_existing:
        if not target_dir.exists() or not (target_dir / spatial.ENTRY_TILESET).exists():
            raise SystemExit(f"Completed target tileset not found: {target_dir / spatial.ENTRY_TILESET}")
        if dry_run:
            print("=== Spatial LOD p001 promote dry-run ===")
            print(f"  source:       {source_dir}")
            print(f"  target:       {target_dir}")
            print("  action:       no files written")
            return {
                "outputPath": str(source_dir / spatial.ENTRY_TILESET),
                "backupPath": None,
                "perLevel": {},
                "dryRun": True,
            }
        target_entry = read_json(target_dir / spatial.ENTRY_TILESET)
        refresh_output_z4_request_volumes(target_dir, target_entry)
        validate_fast(target_entry, target_dir, validate_headers=full_validate)
        backup_dir = replace_source_with_target(source_dir, target_dir)
        print(f"Promoted existing upgraded output: {source_dir / spatial.ENTRY_TILESET}")
        print(f"Backup: {backup_dir}")
        return {
            "outputPath": str(source_dir / spatial.ENTRY_TILESET),
            "backupPath": str(backup_dir),
            "perLevel": {},
            "dryRun": False,
        }

    if not input_dir.exists():
        raise SystemExit(f"COPC chunks not found: {input_dir}")
    spatial.assert_inside(input_dir, intermediate_root, "input dir")

    state_path = target_dir / STATE_NAME
    if target_dir.exists() and not (overwrite_target or resume):
        raise SystemExit(f"Target exists. Pass --overwrite-target or --resume: {target_dir}")
    if overwrite_target and target_dir.exists():
        shutil.rmtree(target_dir)
    if resume and not state_path.exists():
        raise SystemExit(f"Cannot resume: no state file at {state_path}")

    old_entry = read_json(source_dir / spatial.ENTRY_TILESET)
    old_report = read_json(source_dir / spatial.REPORT_NAME)
    validate_old_profile(old_report)
    z0_records = collect_z0_records(source_dir, old_entry)
    if not z0_records:
        raise SystemExit("Source output has no z0 records")

    preflight = spatial.preflight(input_dir)
    if bool(old_report.get("hasRgb", preflight["has_rgb"])) != bool(preflight["has_rgb"]):
        raise SystemExit("COPC RGB availability differs from old spatial-lod report")
    has_rgb = bool(preflight["has_rgb"])
    extras = old_entry.get("asset", {}).get("extras", {})
    grid_origin = tuple(float(v) for v in extras.get("gridOrigin", old_report["gridOrigin"]))
    enu_origin_source = np.asarray(extras.get("enuOriginSource", old_report["enuOriginSource"]), dtype=np.float64)
    frame = spatial.build_enu_frame(spatial._crs_from_wkt(preflight["crs_wkt"]), enu_origin_source)

    if dry_run:
        print(f"=== Spatial LOD p001 upgrade dry-run: {dataset} ===")
        print(f"  logical:      {logical}")
        print(f"  source:       {source_dir}")
        print(f"  target:       {target_dir}")
        print(f"  chunks:       {len(preflight['files'])}")
        print(f"  source z0:    {len(z0_records)} old p02 subtree docs")
        print("  mapping:      old z0 p02 -> new z1 p02")
        print("  mapping:      old z1 p10 -> new z2 p10")
        print("  mapping:      old z2 p50 -> new z3 p50")
        print("  mapping:      old z3 p100 -> new z4 p100")
        print("  action:       no files written")
        return {
            "outputPath": str(target_dir / spatial.ENTRY_TILESET),
            "backupPath": None,
            "perLevel": {},
            "dryRun": True,
        }

    target_dir.mkdir(parents=True, exist_ok=True)
    for level in ["z0", "z1", "z2", "z3", "z4"]:
        (target_dir / "points" / level).mkdir(parents=True, exist_ok=True)

    output_name_for_report = source_name if replace else target_name
    state: dict[str, Any]
    if resume:
        state = read_json(state_path)
    else:
        state = {
            "generator": UPGRADE_REPORT_GENERATOR,
            "dataset": dataset,
            "logical": logical,
            "sourceName": source_name,
            "targetName": target_name,
            "gridOrigin": [grid_origin[0], grid_origin[1]],
            "enuOriginSource": enu_origin_source.tolist(),
            "sourceFiles": preflight["records"],
            "completedChunks": [],
            "chunkOrdinals": {},
            "p001Counts": [],
            "p001Zrange": [],
        }
        spatial.write_json_atomic(state_path, state)

    print(f"=== Spatial LOD p001 upgrade: {dataset} ===")
    print(f"  logical:      {logical}")
    print(f"  source:       {source_dir}")
    print(f"  target:       {target_dir}")
    print(f"  strategy:     COPC z0 p001 + split old p02 + hardlink p10/p50/p100")

    fragments_dir = target_dir / P001_FRAGMENTS_DIR
    fragments_dir.mkdir(parents=True, exist_ok=True)
    p001_counts, _p001_zranges = stream_p001_from_copc(
        files=preflight["files"],
        frame=frame,
        grid_origin=grid_origin,
        has_rgb=has_rgb,
        fragments_dir=fragments_dir,
        state_path=state_path,
        state=state,
        resume=resume,
    )

    print("  finalizing z0 p001 PNTS...")
    per_level = {level.name: {"tiles": 0, "points": 0, "bytes": 0} for level in spatial.LEVELS}
    per_level.update(finalize_p001_z0(target_dir, fragments_dir, z0_records, p001_counts, has_rgb, grid_origin))

    print("  splitting old z0 p02 -> new z1 p02...")
    z1_metrics, z1_zranges = split_old_z0_p02_to_new_z1(z0_records, target_dir, grid_origin, has_rgb)
    per_level["z1"] = z1_metrics

    print("  hardlinking old p10/p50/p100 levels...")
    per_level.update(link_shifted_point_levels(source_dir, target_dir, old_report))

    print("  rewriting tileset tree...")
    new_entry, occupied_count = build_new_tree(
        old_entry=old_entry,
        z0_records=z0_records,
        target_dir=target_dir,
        grid_origin=grid_origin,
        p001_counts=p001_counts,
        z1_zranges=z1_zranges,
        output_name=output_name_for_report,
        logical=logical,
    )
    validate_label = "full PNTS header validation" if full_validate else "fast URI/tree validation"
    print(f"  validating output ({validate_label})...")
    validate_fast(new_entry, target_dir, validate_headers=full_validate)

    report = build_report(
        old_report=old_report,
        old_entry=old_entry,
        preflight=preflight,
        per_level=per_level,
        logical=logical,
        output_name=output_name_for_report,
        occupied_count=occupied_count,
        z0_count=len(z0_records),
    )
    spatial.write_json_atomic(target_dir / spatial.REPORT_NAME, report)
    spatial.write_json_atomic(target_dir / spatial.ENTRY_TILESET, new_entry)
    shutil.rmtree(fragments_dir, ignore_errors=True)
    state_path.unlink(missing_ok=True)

    final_dir = target_dir
    backup_dir = None
    if replace:
        print("  replacing canonical source folder with upgraded output...")
        backup_dir = replace_source_with_target(source_dir, target_dir)
        final_dir = source_dir

    print(f"  z0 p001:     {per_level['z0']['tiles']} tiles, {per_level['z0']['points']} points")
    print(f"  z1 p02:      {per_level['z1']['tiles']} tiles, {per_level['z1']['points']} points")
    print(f"  z2 p10:      {per_level['z2']['tiles']} tiles, {per_level['z2']['points']} points")
    print(f"  z3 p50:      {per_level['z3']['tiles']} tiles, {per_level['z3']['points']} points")
    print(f"  z4 p100:     {per_level['z4']['tiles']} tiles, {per_level['z4']['points']} points")
    print(f"  entry:       {final_dir / spatial.ENTRY_TILESET}")
    if backup_dir is not None:
        print(f"  backup:      {backup_dir}")
    return {
        "outputPath": str(final_dir / spatial.ENTRY_TILESET),
        "backupPath": str(backup_dir) if backup_dir else None,
        "perLevel": per_level,
        "dryRun": False,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upgrade old spatial-lod output to z0:p001,z1:p02,z2:p10,z3:p50,z4:p100 without rebuilding expensive levels."
    )
    parser.add_argument("dataset", help="Source COPC dataset, e.g. 2404PeruB2.")
    parser.add_argument("--root", required=True, help="Project root containing local-storage/.")
    parser.add_argument(
        "--public-root",
        default=os.environ.get("POINTCLOUD_PUBLIC_ROOT", ""),
        help="Logical/public root. Defaults to POINTCLOUD_PUBLIC_ROOT.",
    )
    parser.add_argument("--source-name", default=None, help="Existing old spatial-lod folder name.")
    parser.add_argument("--target-name", default=None, help="New upgraded folder name.")
    parser.add_argument("--overwrite-target", action="store_true", help="Delete and recreate the target folder.")
    parser.add_argument("--resume", action="store_true", help="Resume p001 COPC streaming from chunk checkpoints.")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="After validation, rename old source folder to a timestamped backup and move target into its place.",
    )
    parser.add_argument(
        "--promote-existing",
        action="store_true",
        help="Validate an already-built target folder and promote it into the source-name without rebuilding.",
    )
    parser.add_argument(
        "--full-validate",
        action="store_true",
        help="Also read every PNTS header during final validation. Default is fast URI/tree validation.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Validate inputs and print the upgrade plan without writing files.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    result = upgrade_spatial_lod_p001(
        root_dir=Path(args.root),
        dataset=args.dataset,
        public_root=args.public_root,
        source_name=args.source_name,
        target_name=args.target_name,
        overwrite_target=args.overwrite_target,
        resume=args.resume,
        replace=args.replace,
        dry_run=args.dry_run,
        promote_existing=args.promote_existing,
        full_validate=args.full_validate,
    )
    if result.get("dryRun"):
        print(f"Dry-run complete. Planned output: {result['outputPath']}")
    else:
        print(f"Upgraded spatial LOD tree: {result['outputPath']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
