#!/usr/bin/env python3
"""Build a Spatial LOD Grid/Tree for ``?lod=spatial-lod``.

The builder streams every COPC chunk in ``local-storage/intermediate/<dataset>/chunks-copc``,
transforms points into one shared ENU frame, partitions them into a fixed 2D grid
(z0 2000m p001, z1 1000m p02, z2 500m p10, z3 250m p50,
z4 50m p100) using deterministic ordinal nested sampling, writes PNTS per occupied tile,
and emits one external z0 subtree
per occupied z0 cell plus a single synthetic entry ``tileset.json``.

Area manifests are metadata only: they drive the viewer camera and reporting, never
tileset selection or point density.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import struct
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterable

import numpy as np


NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
COLOR_SCALE_DEFAULT = 256.0


Z0_CELL = 2000.0
Z1_CELL = 1000.0
Z2_CELL = 500.0
Z3_CELL = 250.0
Z4_CELL = 50.0
DETAIL_REQUEST_XY_SCALE = 3.0
DETAIL_REQUEST_VERTICAL_MIN = 500.0


@dataclass(frozen=True)
class LevelConfig:
    name: str
    cell: float
    step: int
    density: str
    error: float


LEVELS: tuple[LevelConfig, ...] = (
    LevelConfig("z0", Z0_CELL, 1000, "p001", 4000.0),
    LevelConfig("z1", Z1_CELL, 50, "p02", 1000.0),
    LevelConfig("z2", Z2_CELL, 10, "p10", 500.0),
    LevelConfig("z3", Z3_CELL, 2, "p50", 250.0),
    LevelConfig("z4", Z4_CELL, 1, "p100", 0.0),
)
LEVEL_BY_NAME = {lv.name: lv for lv in LEVELS}
LEAF_LEVEL_NAME = LEVELS[-1].name
REQUEST_VOLUME_PARENT_LEVEL_NAME = LEVELS[-2].name

# Child cells per parent axis; kept explicit through LEVELS so cell-size changes
# fail early if they do not form an integer grid tree.
PARENT_RATIO: dict[str, int] = {}
for parent, child in zip(LEVELS, LEVELS[1:]):
    ratio = parent.cell / child.cell
    if not float(ratio).is_integer():
        raise RuntimeError(f"{child.name} cell size must divide {parent.name} cell size")
    PARENT_RATIO[child.name] = int(ratio)

POINT_BYTES_RGB = 15  # float32 xyz (12) + uint8 rgb (3)
POINT_BYTES_XYZ = 12
RGB_DTYPE = np.dtype([('xyz', '<f4', (3,)), ('rgb', 'u1', (3,))])
STATE_NAME = ".spatial-lod-state.json"
FRAGMENTS_DIR = ".spatial-lod-fragments"
REPORT_NAME = "spatial-lod-report.json"
ENTRY_TILESET = "tileset.json"


def profile_hash() -> str:
    payload = json.dumps(
        [{"name": lv.name, "cell": lv.cell, "step": lv.step, "error": lv.error} for lv in LEVELS],
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ─── Pure grid helpers ────────────────────────────────────────────────


def snap_grid_origin(min_x: float, min_y: float, z0_cell: float = Z0_CELL) -> tuple[float, float]:
    """Snap dataset ENU minimum down to the nearest z0 boundary."""
    return (
        math.floor(min_x / z0_cell) * z0_cell,
        math.floor(min_y / z0_cell) * z0_cell,
    )


def cell_index(coord: float, origin: float, cell: float) -> int:
    """Cell index with the convention that a point exactly on a boundary
    belongs to the higher-index cell. ``floor`` maps an exact integer
    quotient to itself (the higher of the two neighbouring cells)."""
    return int(math.floor((coord - origin) / cell))


def tile_id(level_name: str, ix: int, iy: int) -> str:
    level_num = level_name[1]
    return f"z{level_num}_x{ix:06d}_y{iy:06d}"


def parent_indices(level_name: str, ix: int, iy: int) -> tuple[str, int, int] | None:
    if level_name == "z0":
        return None
    ratio = PARENT_RATIO[level_name]
    parent_name = f"z{int(level_name[1]) - 1}"
    return parent_name, ix // ratio, iy // ratio


def levels_for_ordinal(ordinal: int) -> list[str]:
    """Levels whose step divides ``ordinal``. Because steps nest
    (1000, 50, 10, 2, 1) this yields the superset chain
    p001 ⊂ p02 ⊂ p10 ⊂ p50 ⊂ p100."""
    return [lv.name for lv in LEVELS if ordinal % lv.step == 0]


def box_for_cell(
    level_name: str,
    ix: int,
    iy: int,
    origin_x: float,
    origin_y: float,
    cell: float,
    zmin: float,
    zmax: float,
) -> list[float]:
    cx = origin_x + (ix + 0.5) * cell
    cy = origin_y + (iy + 0.5) * cell
    cz = (zmin + zmax) / 2.0
    hx = cell / 2.0
    hy = cell / 2.0
    hz = max((zmax - zmin) / 2.0, 0.0)
    return [cx, cy, cz, hx, 0.0, 0.0, 0.0, hy, 0.0, 0.0, 0.0, hz]


def detail_request_volume(
    parent_level_name: str,
    parent_ix: int,
    parent_iy: int,
    origin_x: float,
    origin_y: float,
    zmin: float,
    zmax: float,
) -> list[float]:
    parent = LEVEL_BY_NAME[parent_level_name]
    cx = origin_x + (parent_ix + 0.5) * parent.cell
    cy = origin_y + (parent_iy + 0.5) * parent.cell
    cz = (zmin + zmax) / 2.0
    hxy = (parent.cell / 2.0) * DETAIL_REQUEST_XY_SCALE
    hz = max((zmax - zmin) / 2.0, DETAIL_REQUEST_VERTICAL_MIN)
    return [cx, cy, cz, hxy, 0.0, 0.0, 0.0, hxy, 0.0, 0.0, 0.0, hz]


def request_volume_policy() -> dict[str, Any]:
    return {
        "appliesTo": LEAF_LEVEL_NAME,
        "sharedWith": REQUEST_VOLUME_PARENT_LEVEL_NAME,
        "xyScale": DETAIL_REQUEST_XY_SCALE,
        "verticalMin": DETAIL_REQUEST_VERTICAL_MIN,
    }


def z2_request_volume(
    z2_ix: int,
    z2_iy: int,
    origin_x: float,
    origin_y: float,
    zmin: float,
    zmax: float,
) -> list[float]:
    """Backward-compatible helper for tests/old callers."""
    return detail_request_volume("z2", z2_ix, z2_iy, origin_x, origin_y, zmin, zmax)


def box_contains(outer: list[float], inner: list[float], eps: float = 1e-6) -> bool:
    if len(outer) < 12 or len(inner) < 12:
        return False
    for axis in range(3):
        outer_half = abs(float(outer[3 + axis * 4]))
        inner_half = abs(float(inner[3 + axis * 4]))
        center_diff = abs(float(inner[axis]) - float(outer[axis]))
        if center_diff + inner_half > outer_half + eps:
            return False
    return True


# ─── PNTS writer (inlined to keep the module self-contained) ──────────


def padded_json_bytes(value: dict[str, Any], start_offset: int) -> bytes:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    padding = (8 - ((start_offset + len(raw)) % 8)) % 8
    return raw + (b" " * padding)


def pad_binary(raw: bytes) -> bytes:
    padding = (8 - (len(raw) % 8)) % 8
    return raw + (b"\x00" * padding)


def write_pnts(path: Path, xyz: np.ndarray, rgb: np.ndarray | None, rtc_center: np.ndarray) -> int:
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


def write_pnts_atomic(path: Path, xyz: np.ndarray, rgb: np.ndarray | None, rtc_center: np.ndarray) -> int:
    """Write a PNTS to a temp file in the same directory, then atomic replace."""
    payload = build_pnts_bytes(xyz, rgb, rtc_center)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fp:
            fp.write(payload)
        os.replace(tmp, path)
        os.chmod(path, 0o644)
    except OSError as exc:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise SystemExit(f"Cannot write {path}: {exc}") from exc
    return len(payload)


def build_pnts_bytes(xyz: np.ndarray, rgb: np.ndarray | None, rtc_center: np.ndarray) -> bytes:
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
    header = struct.pack(
        "<4sIIIIII",
        b"pnts",
        1,
        28 + len(feature_json_bytes) + len(feature_binary_bytes),
        len(feature_json_bytes),
        len(feature_binary_bytes),
        0,
        0,
    )
    return header + feature_json_bytes + feature_binary_bytes


def pnts_is_valid(path: Path, expected_points: int, has_rgb: bool) -> bool:
    """Return True if a PNTS file exists, parses, and matches the expected point count."""
    if not path.exists():
        return False
    try:
        header = read_pnts_header(path)
    except (ValueError, OSError):
        return False
    if header["byteLength"] != path.stat().st_size:
        return False
    ft = header["featureTable"]
    if ft.get("POINTS_LENGTH") != expected_points:
        return False
    if has_rgb and "RGB" not in ft:
        return False
    if "RTC_CENTER" not in ft:
        return False
    return True


def read_pnts_header(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    if len(data) < 28 or data[:4] != b"pnts":
        raise ValueError(f"Not a PNTS file: {path}")
    (_magic, version, byte_length, ft_json_len, ft_bin_len, _bt_json, _bt_bin) = struct.unpack(
        "<4sIIIIII", data[:28]
    )
    ft_json = data[28 : 28 + ft_json_len]
    feature = json.loads(ft_json.decode("utf-8").strip())
    return {
        "version": version,
        "byteLength": byte_length,
        "featureTable": feature,
        "ftBinaryLength": ft_bin_len,
        "expectedBytes": 28 + ft_json_len + ft_bin_len,
    }


# ─── ENU frame (lazy pyproj) ──────────────────────────────────────────


def enu_basis(lon_degrees: float, lat_degrees: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    lon = math.radians(lon_degrees)
    lat = math.radians(lat_degrees)
    sin_lon, cos_lon = math.sin(lon), math.cos(lon)
    sin_lat, cos_lat = math.sin(lat), math.cos(lat)
    east = np.asarray([-sin_lon, cos_lon, 0.0], dtype=np.float64)
    north = np.asarray([-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat], dtype=np.float64)
    up = np.asarray([cos_lat * cos_lon, cos_lat * sin_lon, sin_lat], dtype=np.float64)
    return east, north, up


def enu_to_ecef_transform(
    origin_ecef: np.ndarray, east: np.ndarray, north: np.ndarray, up: np.ndarray
) -> list[float]:
    return [
        float(east[0]), float(east[1]), float(east[2]), 0.0,
        float(north[0]), float(north[1]), float(north[2]), 0.0,
        float(up[0]), float(up[1]), float(up[2]), 0.0,
        float(origin_ecef[0]), float(origin_ecef[1]), float(origin_ecef[2]), 1.0,
    ]


def parse_source_vector(value: str) -> np.ndarray:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 3 or any(part == "" for part in parts):
        raise ValueError('Expected "x,y,z".')
    return np.asarray([float(part) for part in parts], dtype=np.float64)


def validate_name(value: str, label: str) -> str:
    """Reject names that could escape their intended directory."""
    cleaned = (value or "").strip("/")
    if not cleaned or not NAME_PATTERN.match(cleaned):
        raise SystemExit(f"Invalid {label}: {value!r}")
    return cleaned


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def assert_inside(path: Path, root: Path, label: str) -> None:
    if not _inside(path, root):
        raise SystemExit(f"{label} escapes allowed root: {path} not inside {root}")


def color_to_u8(values: np.ndarray, color_scale: float = COLOR_SCALE_DEFAULT) -> np.ndarray:
    """Scale LAS RGB (uint16) to uint8 like the existing converter."""
    scaled = np.asarray(values, dtype=np.float64) / float(color_scale)
    return np.clip(scaled, 0, 255).astype(np.uint8)


def build_enu_frame(source_crs: Any, enu_origin_source: np.ndarray) -> dict[str, Any]:
    """Return ENU→ECEF transform + source→ECEF transformer for globe placement."""
    from pyproj import CRS, Transformer  # lazy import

    ecef_crs = CRS.from_epsg(4978)
    wgs84_crs = CRS.from_epsg(4326)
    source_to_ecef = Transformer.from_crs(source_crs, ecef_crs, always_xy=True)
    source_to_wgs84 = Transformer.from_crs(source_crs, wgs84_crs, always_xy=True)
    origin_ecef = np.asarray(
        source_to_ecef.transform(
            float(enu_origin_source[0]),
            float(enu_origin_source[1]),
            float(enu_origin_source[2]),
        ),
        dtype=np.float64,
    )
    lon, lat, _height = source_to_wgs84.transform(
        float(enu_origin_source[0]),
        float(enu_origin_source[1]),
        float(enu_origin_source[2]),
    )
    east, north, up = enu_basis(float(lon), float(lat))
    return {
        "root_transform": enu_to_ecef_transform(origin_ecef, east, north, up),
        "source_to_ecef": source_to_ecef,
        "source_to_wgs84": source_to_wgs84,
        "enu_origin_ecef": origin_ecef,
        "enu_origin_lonlat": (float(lon), float(lat), float(_height)),
        "enu_basis": (east, north, up),
    }


def source_points_to_enu(xyz_source: np.ndarray, frame: dict[str, Any]) -> np.ndarray:
    x, y, z = frame["source_to_ecef"].transform(
        xyz_source[:, 0], xyz_source[:, 1], xyz_source[:, 2],
    )
    ecef = np.column_stack((x, y, z)).astype(np.float64)
    relative = ecef - frame["enu_origin_ecef"]
    east, north, up = frame["enu_basis"]
    return np.column_stack((relative @ east, relative @ north, relative @ up)).astype(np.float64)


def transform_bounds_to_enu(
    mins: np.ndarray, maxs: np.ndarray, frame: dict[str, Any]
) -> tuple[np.ndarray, np.ndarray]:
    corners = np.asarray(
        [[x, y, z] for x in (mins[0], maxs[0]) for y in (mins[1], maxs[1]) for z in (mins[2], maxs[2])],
        dtype=np.float64,
    )
    enu = source_points_to_enu(corners, frame)
    return enu.min(axis=0), enu.max(axis=0)


# ─── Source fingerprinting ────────────────────────────────────────────


def fingerprint_file(path: Path) -> dict[str, Any]:
    stat = path.stat()
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        h.update(fp.read(1024 * 1024))
    return {
        "name": path.name,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "fingerprint": h.hexdigest(),
    }


def fingerprint_matches(record: dict[str, Any], path: Path) -> bool:
    if not path.exists():
        return False
    current = fingerprint_file(path)
    return (
        current["size"] == record.get("size")
        and current["mtime_ns"] == record.get("mtime_ns")
        and current["fingerprint"] == record.get("fingerprint")
    )


def serialize_counts(counts: dict[tuple[str, int, int], int]) -> list[list[Any]]:
    return [[lv, ix, iy, cnt] for (lv, ix, iy), cnt in sorted(counts.items())]


def deserialize_counts(items: list[list[Any]]) -> dict[tuple[str, int, int], int]:
    return {(str(lv), int(ix), int(iy)): int(cnt) for lv, ix, iy, cnt in items}


def serialize_leaf_zrange(zrange: dict[tuple[int, int], tuple[float, float]]) -> list[list[float]]:
    return [[ix, iy, float(zmin), float(zmax)] for (ix, iy), (zmin, zmax) in sorted(zrange.items())]


def deserialize_leaf_zrange(items: list[list[float]]) -> dict[tuple[int, int], tuple[float, float]]:
    return {(int(ix), int(iy)): (float(zmin), float(zmax)) for ix, iy, zmin, zmax in items}


# Backward-compatible names used by older tests/scripts while the serialized
# state now stores the leaf z-range under ``leafZrange``.
serialize_z3 = serialize_leaf_zrange
deserialize_z3 = deserialize_leaf_zrange


# ─── Point partition (vectorised, streaming) ──────────────────────────


def partition_points(
    xyz_enu: np.ndarray,
    rgb: np.ndarray | None,
    ordinal_start: int,
    bounds_filter: tuple[float, float, float, float] | None,
    grid_origin: tuple[float, float],
    has_rgb: bool,
    fragments_dir: Path,
    chunk_id: str,
    counts: dict[tuple[str, int, int], int],
    leaf_zrange: dict[tuple[int, int], tuple[float, float]],
) -> tuple[int, dict[tuple[str, int, int], int], dict[tuple[int, int], tuple[float, float]]]:
    """Distribute one node's points into per-tile fragment files.

    The global ordinal counter advances for every point (including out-of-bounds
    ones) so pilot and full builds select identical samples.
    """
    ox, oy = grid_origin
    xyz = np.asarray(xyz_enu, dtype=np.float64)
    n = int(xyz.shape[0])
    ordinals = ordinal_start + np.arange(n, dtype=np.int64)

    # Drop non-finite points (sentinel/invalid records in the source). Their
    # ordinals still advance so nested sampling of the survivors stays intact.
    finite = np.isfinite(xyz).all(axis=1)
    if not bool(finite.all()):
        xyz = xyz[finite]
        ordinals = ordinals[finite]
        if has_rgb and rgb is not None:
            rgb = np.asarray(rgb, dtype=np.uint8)[finite]
    elif has_rgb:
        rgb = np.asarray(rgb, dtype=np.uint8)
    else:
        rgb = None

    if bounds_filter is not None:
        minx, miny, maxx, maxy = bounds_filter
        mask = (
            (xyz[:, 0] >= minx) & (xyz[:, 0] <= maxx)
            & (xyz[:, 1] >= miny) & (xyz[:, 1] <= maxy)
        )
        xyz = xyz[mask]
        ordinals = ordinals[mask]
        if has_rgb and rgb is not None:
            rgb = rgb[mask]

    for lv in LEVELS:
        lmask = (ordinals % lv.step) == 0
        if not lmask.any():
            continue
        lxs = xyz[lmask, 0]
        lys = xyz[lmask, 1]
        lzs = xyz[lmask, 2]
        ixs = np.floor((lxs - ox) / lv.cell).astype(np.int64)
        iys = np.floor((lys - oy) / lv.cell).astype(np.int64)
        combined = ixs * 100_000_000 + iys
        order = np.argsort(combined, kind="stable")
        combined_sorted = combined[order]
        if combined_sorted.size:
            boundaries = np.flatnonzero(np.diff(combined_sorted)) + 1
            groups = np.split(order, boundaries)
        else:
            groups = []
        xyz_masked = xyz[lmask]
        lrgb = rgb[lmask] if (has_rgb and rgb is not None) else None
        for group in groups:
            if group.size == 0:
                continue
            ix = int(ixs[group[0]])
            iy = int(iys[group[0]])
            sub = xyz_masked[group]
            tid = tile_id(lv.name, ix, iy)
            frag_path = fragments_dir / chunk_id / lv.name / f"{tid}.bin"
            frag_path.parent.mkdir(parents=True, exist_ok=True)
            if has_rgb and lrgb is not None:
                rec = np.empty(group.size, dtype=RGB_DTYPE)
                rec['xyz'] = sub.astype('<f4')
                rec['rgb'] = lrgb[group]
                data = rec.tobytes()
            else:
                data = sub.astype('<f4').tobytes(order="C")
            with open(frag_path, "ab") as fp:
                fp.write(data)
            cnt = int(group.size)
            counts[(lv.name, ix, iy)] = counts.get((lv.name, ix, iy), 0) + cnt
            if lv.name == LEAF_LEVEL_NAME:
                zmin = float(sub[:, 2].min())
                zmax = float(sub[:, 2].max())
                key = (ix, iy)
                if key in leaf_zrange:
                    a, b = leaf_zrange[key]
                    leaf_zrange[key] = (min(a, zmin), max(b, zmax))
                else:
                    leaf_zrange[key] = (zmin, zmax)

    return ordinal_start + n, counts, leaf_zrange


# ─── Finalise: PNTS, hierarchy, external z0 docs, entry ───────────────


def _zrange_for_tile(
    level_name: str,
    ix: int,
    iy: int,
    leaf_zrange: dict[tuple[int, int], tuple[float, float]],
    propagated: dict[str, dict[tuple[int, int], tuple[float, float]]],
) -> tuple[float, float]:
    """Z range from full data (p100), propagated bottom-up from the leaf level."""
    cached = propagated.get(level_name, {}).get((ix, iy))
    if cached is not None:
        return cached
    if level_name == LEAF_LEVEL_NAME:
        rng = leaf_zrange.get((ix, iy))
        if rng is None:
            raise SystemExit(f"{LEAF_LEVEL_NAME} cell {ix},{iy} has no Z range")
        propagated.setdefault(LEAF_LEVEL_NAME, {})[(ix, iy)] = rng
        return rng
    child_level = f"z{int(level_name[1]) + 1}"
    ratio = PARENT_RATIO[child_level]
    child_map = propagated.get(child_level, {})
    mins_z: list[float] = []
    maxs_z: list[float] = []
    for dx in range(ratio):
        for dy in range(ratio):
            child_rng = child_map.get((ix * ratio + dx, iy * ratio + dy))
            if child_rng is not None:
                mins_z.append(child_rng[0])
                maxs_z.append(child_rng[1])
    if not mins_z:
        raise SystemExit(f"No child Z for {level_name} {ix},{iy}")
    rng = (min(mins_z), max(maxs_z))
    propagated.setdefault(level_name, {})[(ix, iy)] = rng
    return rng


def _occupied_ancestors(counts: dict[tuple[str, int, int], int]) -> set[tuple[str, int, int]]:
    occupied = set(counts.keys())
    for (level_name, ix, iy) in list(counts.keys()):
        cur = parent_indices(level_name, ix, iy)
        while cur is not None:
            if cur not in occupied:
                occupied.add(cur)
            cur = parent_indices(cur[0], cur[1], cur[2])
    return occupied


def _merge_fragments(
    fragments_dir: Path, level_name: str, ix: int, iy: int, has_rgb: bool
) -> tuple[np.ndarray, np.ndarray | None]:
    tid = tile_id(level_name, ix, iy)
    point_bytes = POINT_BYTES_RGB if has_rgb else POINT_BYTES_XYZ
    parts = []
    for chunk_dir in sorted(fragments_dir.iterdir()):
        frag = chunk_dir / level_name / f"{tid}.bin"
        if frag.exists():
            parts.append(np.frombuffer(frag.read_bytes(), dtype=np.uint8))
    if not parts:
        return np.empty((0, 3), dtype=np.float32), None
    buf = np.concatenate(parts)
    count = buf.size // point_bytes
    buf = buf[: count * point_bytes]
    if has_rgb:
        rec = np.frombuffer(buf.tobytes(), dtype=RGB_DTYPE, count=count)
        xyz = rec['xyz'].astype(np.float32).copy()
        rgb = rec['rgb'].copy()
    else:
        xyz = np.frombuffer(buf.tobytes(), dtype='<f4', count=count * 3).reshape(count, 3).copy()
        rgb = None
    return xyz, rgb


def _delete_tile_fragments(fragments_dir: Path, level_name: str, tid: str) -> None:
    """Remove the per-chunk fragment files for one tile after its PNTS is published."""
    if not fragments_dir.exists():
        return
    for chunk_dir in fragments_dir.iterdir():
        frag = chunk_dir / level_name / f"{tid}.bin"
        if frag.exists():
            frag.unlink()


def finalize_output(
    output_dir: Path,
    fragments_dir: Path,
    grid_origin: tuple[float, float],
    root_transform: list[float],
    enu_origin_lonlat: tuple[float, float, float],
    enu_origin_source: list[float],
    enu_origin_ecef: list[float],
    has_rgb: bool,
    counts: dict[tuple[str, int, int], int],
    leaf_zrange: dict[tuple[int, int], tuple[float, float]],
    source_files: list[dict[str, Any]],
    bounds_filter: tuple[float, float, float, float] | None,
    output_name: str,
    logical: str,
    area_manifest_uri: str,
    total_source_points: int,
    resume_finalize: bool = False,
) -> dict[str, Any]:
    ox, oy = grid_origin
    occupied = _occupied_ancestors(counts)
    propagated: dict[str, dict[tuple[int, int], tuple[float, float]]] = {
        LEAF_LEVEL_NAME: dict(leaf_zrange)
    }

    # Compute Z for every occupied tile (bottom-up ensures propagation).
    for level_name in reversed([lv.name for lv in LEVELS[:-1]]):
        for (lv, ix, iy) in sorted(occupied):
            if lv == level_name:
                _zrange_for_tile(level_name, ix, iy, leaf_zrange, propagated)

    # Write PNTS for every tile that has content.
    per_level: dict[str, dict[str, int]] = {lv.name: {"tiles": 0, "points": 0, "bytes": 0} for lv in LEVELS}
    pnts_uris: dict[tuple[str, int, int], str] = {}
    for (level_name, ix, iy), cnt in sorted(counts.items()):
        if cnt <= 0:
            continue
        zmin, zmax = _zrange_for_tile(level_name, ix, iy, leaf_zrange, propagated)
        lv = LEVEL_BY_NAME[level_name]
        rtc_center = np.asarray(
            [ox + (ix + 0.5) * lv.cell, oy + (iy + 0.5) * lv.cell, (zmin + zmax) / 2.0],
            dtype=np.float64,
        )
        tid = tile_id(level_name, ix, iy)
        pnts_path = output_dir / "points" / level_name / f"{tid}.pnts"
        if resume_finalize and pnts_is_valid(pnts_path, cnt, has_rgb):
            byte_len = pnts_path.stat().st_size
        else:
            xyz, rgb = _merge_fragments(fragments_dir, level_name, ix, iy, has_rgb)
            if xyz.shape[0] != cnt:
                raise SystemExit(
                    f"Fragment point count mismatch for {level_name} {ix},{iy}: "
                    f"{xyz.shape[0]} != {cnt}"
                )
            local = xyz.astype(np.float64) - rtc_center
            byte_len = write_pnts_atomic(pnts_path, local, rgb, rtc_center)
        # Delete this tile's fragments now that its PNTS is atomic-published.
        _delete_tile_fragments(fragments_dir, level_name, tid)
        pnts_uris[(level_name, ix, iy)] = f"../../points/{level_name}/{tid}.pnts"
        per_level[level_name]["tiles"] += 1
        per_level[level_name]["points"] += cnt
        per_level[level_name]["bytes"] += byte_len

    # Build the z0 external documents (each holds the full z0→leaf subtree).
    z0_tiles = sorted((ix, iy) for (lv, ix, iy) in occupied if lv == "z0")
    if not z0_tiles:
        raise SystemExit("No occupied z0 cells — dataset produced no tiles")

    z0_leaves: list[dict[str, Any]] = []
    for (ix0, iy0) in z0_tiles:
        z0_doc = _build_z0_subtree(
            ix0, iy0, grid_origin, counts, propagated, pnts_uris, output_dir
        )
        z0_dir = output_dir / "z0" / tile_id("z0", ix0, iy0)
        write_json_atomic(z0_dir / ENTRY_TILESET, z0_doc)
        z0_zmin, z0_zmax = _zrange_for_tile("z0", ix0, iy0, leaf_zrange, propagated)
        z0_box = box_for_cell("z0", ix0, iy0, ox, oy, Z0_CELL, z0_zmin, z0_zmax)
        z0_leaves.append({
            "boundingVolume": {"box": z0_box},
            "geometricError": LEVEL_BY_NAME["z0"].error,
            "refine": "REPLACE",
            "content": {"uri": f"z0/{tile_id('z0', ix0, iy0)}/{ENTRY_TILESET}"},
        })

    # Synthetic entry root: grid-aligned union of z0 cells + global Z.
    entry_zmin = min(_zrange_for_tile("z0", ix0, iy0, leaf_zrange, propagated)[0] for (ix0, iy0) in z0_tiles)
    entry_zmax = max(_zrange_for_tile("z0", ix0, iy0, leaf_zrange, propagated)[1] for (ix0, iy0) in z0_tiles)
    min_x = min(ox + ix0 * Z0_CELL for (ix0, _) in z0_tiles)
    max_x = max(ox + (ix0 + 1) * Z0_CELL for (ix0, _) in z0_tiles)
    min_y = min(oy + iy0 * Z0_CELL for (_, iy0) in z0_tiles)
    max_y = max(oy + (iy0 + 1) * Z0_CELL for (_, iy0) in z0_tiles)
    entry_box = [
        (min_x + max_x) / 2.0, (min_y + max_y) / 2.0, (entry_zmin + entry_zmax) / 2.0,
        (max_x - min_x) / 2.0, 0.0, 0.0,
        0.0, (max_y - min_y) / 2.0, 0.0,
        0.0, 0.0, (entry_zmax - entry_zmin) / 2.0,
    ]
    diagonal = math.sqrt((max_x - min_x) ** 2 + (max_y - min_y) ** 2 + (entry_zmax - entry_zmin) ** 2)
    entry_error = 2.0 * diagonal
    entry_doc = {
        "asset": {
            "version": "1.0",
            "extras": {
                "generator": "SBB Spatial LOD Tree V1",
                "logicalDataset": logical,
                "coordinateMode": "globe",
                "local_only": False,
                "spatialLod": True,
                "profile": [lv.name for lv in LEVELS],
                "gridOrigin": [ox, oy],
                "enuOriginSource": enu_origin_source,
                "enuOriginEcef": enu_origin_ecef,
                "enuOriginLonLat": list(enu_origin_lonlat),
            },
        },
        "geometricError": entry_error,
        "root": {
            "transform": root_transform,
            "boundingVolume": {"box": entry_box},
            "geometricError": entry_error,
            "refine": "REPLACE",
            "children": z0_leaves,
        },
    }

    validate_output(entry_doc, output_dir)

    write_json_atomic(output_dir / REPORT_NAME, _build_report(
        logical, output_name, grid_origin, root_transform, enu_origin_lonlat,
        enu_origin_source, enu_origin_ecef, bounds_filter, has_rgb, per_level,
        source_files, area_manifest_uri, total_source_points, entry_box, entry_error,
        z0_count=len(z0_tiles), occupied_count=len(occupied),
    ))
    # Publish the entry last so a crash never leaves a tree pointing at missing files.
    write_json_atomic(output_dir / ENTRY_TILESET, entry_doc)

    # Fragments are no longer needed once the tree is finalised.
    shutil.rmtree(fragments_dir, ignore_errors=True)

    return {
        "outputPath": str(output_dir / ENTRY_TILESET),
        "entryError": entry_error,
        "z0Count": len(z0_tiles),
        "occupiedCount": len(occupied),
        "perLevel": per_level,
    }


def _build_z0_subtree(
    ix0: int,
    iy0: int,
    grid_origin: tuple[float, float],
    counts: dict[tuple[str, int, int], int],
    propagated: dict[str, dict[tuple[int, int], tuple[float, float]]],
    pnts_uris: dict[tuple[str, int, int], str],
    output_dir: Path,
) -> dict[str, Any]:
    ox, oy = grid_origin
    z0_zmin, z0_zmax = _zrange_for_tile("z0", ix0, iy0, {}, propagated)
    z0_box = box_for_cell("z0", ix0, iy0, ox, oy, Z0_CELL, z0_zmin, z0_zmax)
    z0_root: dict[str, Any] = {
        "boundingVolume": {"box": z0_box},
        "geometricError": LEVEL_BY_NAME["z0"].error,
        "refine": "REPLACE",
    }
    if (LEVEL_BY_NAME["z0"].name, ix0, iy0) in pnts_uris:
        z0_root["content"] = {"uri": pnts_uris[(LEVEL_BY_NAME["z0"].name, ix0, iy0)]}
    z1_children = _build_children(
        "z1", ix0, iy0, PARENT_RATIO["z1"], grid_origin, counts, propagated, pnts_uris
    )
    if z1_children:
        z0_root["children"] = z1_children
    return {
        "asset": {
            "version": "1.0",
            "extras": {
                "generator": "SBB Spatial LOD Tree V1",
                "spatialLod": True,
                "z0Tile": tile_id("z0", ix0, iy0),
            },
        },
        "geometricError": LEVEL_BY_NAME["z0"].error,
        "root": z0_root,
    }


def _build_children(
    level_name: str,
    pix: int,
    piy: int,
    ratio: int,
    grid_origin: tuple[float, float],
    counts: dict[tuple[str, int, int], int],
    propagated: dict[str, dict[tuple[int, int], tuple[float, float]]],
    pnts_uris: dict[tuple[str, int, int], str],
) -> list[dict[str, Any]]:
    ox, oy = grid_origin
    lv = LEVEL_BY_NAME[level_name]
    children: list[dict[str, Any]] = []
    for dx in range(ratio):
        for dy in range(ratio):
            ix = pix * ratio + dx
            iy = piy * ratio + dy
            rng = propagated.get(level_name, {}).get((ix, iy))
            if rng is None:
                continue  # sparse: omit unoccupied tiles
            zmin, zmax = rng
            box = box_for_cell(level_name, ix, iy, ox, oy, lv.cell, zmin, zmax)
            tile: dict[str, Any] = {
                "boundingVolume": {"box": box},
                "geometricError": lv.error,
                "refine": "REPLACE",
            }
            if (level_name, ix, iy) in pnts_uris:
                tile["content"] = {"uri": pnts_uris[(level_name, ix, iy)]}
            if level_name == LEAF_LEVEL_NAME:
                # All leaf siblings under one parent share the parent's request volume.
                parent_ratio = PARENT_RATIO[level_name]
                parent_ix, parent_iy = ix // parent_ratio, iy // parent_ratio
                parent_rng = (
                    propagated.get(REQUEST_VOLUME_PARENT_LEVEL_NAME, {}).get((parent_ix, parent_iy))
                    or (zmin, zmax)
                )
                tile["viewerRequestVolume"] = {
                    "box": detail_request_volume(
                        REQUEST_VOLUME_PARENT_LEVEL_NAME,
                        parent_ix,
                        parent_iy,
                        ox,
                        oy,
                        parent_rng[0],
                        parent_rng[1],
                    )
                }
            else:
                child_level = f"z{int(level_name[1]) + 1}"
                sub_children = _build_children(
                    child_level, ix, iy,
                    PARENT_RATIO[child_level],
                    grid_origin, counts, propagated, pnts_uris,
                )
                if sub_children:
                    tile["children"] = sub_children
            children.append(tile)
    return children


# ─── Validation ───────────────────────────────────────────────────────


def _walk(tile: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield tile
    for child in tile.get("children", []):
        if isinstance(child, dict):
            yield from _walk(child)


def validate_output(entry_doc: dict[str, Any], output_dir: Path) -> None:
    root = entry_doc.get("root")
    if not isinstance(root, dict):
        raise SystemExit("Entry has no root")
    transform = root.get("transform")
    if not isinstance(transform, list) or len(transform) != 16:
        raise SystemExit("Entry root must carry a 16-value ENU→ECEF transform")
    if root.get("refine") != "REPLACE":
        raise SystemExit("Entry root must use REPLACE")
    entry_error = float(root.get("geometricError", 0))

    for leaf in root.get("children", []):
        uri = leaf.get("content", {}).get("uri")
        if not isinstance(uri, str) or not uri.endswith(ENTRY_TILESET):
            raise SystemExit(f"Entry child must reference a z0 tileset: {uri}")
        leaf_error = float(leaf.get("geometricError", 0))
        if leaf_error > entry_error + 1e-6:
            raise SystemExit(f"z0 leaf error {leaf_error} > entry {entry_error}")
        if leaf.get("refine") != "REPLACE":
            raise SystemExit("z0 leaf must use REPLACE")
        target = (output_dir / uri).resolve()
        if not target.exists():
            raise SystemExit(f"Entry references missing z0 document: {uri}")
        z0_doc = json.loads(target.read_text(encoding="utf-8"))
        _validate_z0_doc(target, z0_doc)


def _validate_z0_doc(path: Path, doc: dict[str, Any]) -> None:
    root = doc.get("root")
    if not isinstance(root, dict):
        raise SystemExit(f"z0 document has no root: {path}")
    if "transform" in root:
        raise SystemExit(f"Only the entry root may carry a transform: {path}")

    def visit(tile: dict[str, Any], parent_box: list[float] | None, parent_error: float, depth: int) -> None:
        if tile.get("refine") != "REPLACE":
            raise SystemExit(f"Tile must use REPLACE: {path}")
        box = tile.get("boundingVolume", {}).get("box")
        if not isinstance(box, list) or len(box) != 12:
            raise SystemExit(f"Invalid bounding volume: {path}")
        err = float(tile.get("geometricError", 0))
        if err > parent_error + 1e-6:
            raise SystemExit(f"geometricError increases under parent in {path}: {err} > {parent_error}")
        if parent_box is not None and not box_contains(parent_box, box):
            raise SystemExit(f"Parent bbox does not contain child in {path}")
        uri = tile.get("content", {}).get("uri")
        if isinstance(uri, str):
            target = (path.parent / uri).resolve()
            if not target.exists():
                raise SystemExit(f"Missing content URI in {path}: {uri}")
            if uri.endswith(".pnts"):
                header = read_pnts_header(target)
                if header["byteLength"] != target.stat().st_size:
                    raise SystemExit(f"PNTS byteLength mismatch: {uri}")
        children = [c for c in tile.get("children", []) if isinstance(c, dict)]
        # The leaf p100 tiles share one request volume per parent tile so they
        # do not request too early while the camera is still in coarse views.
        if depth == int(REQUEST_VOLUME_PARENT_LEVEL_NAME[1]) and children:
            leaf_volumes: list[list[float]] = []
            for child in children:
                if float(child.get("geometricError", -1)) == LEVEL_BY_NAME[LEAF_LEVEL_NAME].error:
                    rv = child.get("viewerRequestVolume", {}).get("box")
                    if isinstance(rv, list):
                        leaf_volumes.append(rv)
            if leaf_volumes:
                first = leaf_volumes[0]
                for v in leaf_volumes[1:]:
                    if v != first:
                        raise SystemExit(
                            f"{LEAF_LEVEL_NAME} siblings under {REQUEST_VOLUME_PARENT_LEVEL_NAME} "
                            f"do not share a request volume: {path}"
                        )
        for child in children:
            visit(child, box, err, depth + 1)

    visit(root, None, float("inf"), 0)


# ─── Report ───────────────────────────────────────────────────────────


def _build_report(
    logical: str,
    output_name: str,
    grid_origin: tuple[float, float],
    root_transform: list[float],
    enu_origin_lonlat: tuple[float, float, float],
    enu_origin_source: list[float],
    enu_origin_ecef: list[float],
    bounds_filter: tuple[float, float, float, float] | None,
    has_rgb: bool,
    per_level: dict[str, dict[str, int]],
    source_files: list[dict[str, Any]],
    area_manifest_uri: str,
    total_source_points: int,
    entry_box: list[float],
    entry_error: float,
    z0_count: int,
    occupied_count: int,
) -> dict[str, Any]:
    return {
        "logicalDataset": logical,
        "outputName": output_name,
        "generator": "SBB Spatial LOD Tree V1",
        "profile": [
            {"level": lv.name, "cell": lv.cell, "step": lv.step, "density": lv.density, "geometricError": lv.error}
            for lv in LEVELS
        ],
        "gridOrigin": [grid_origin[0], grid_origin[1]],
        "rootTransform": root_transform,
        "enuOriginSource": enu_origin_source,
        "enuOriginEcef": enu_origin_ecef,
        "enuOriginLonLat": list(enu_origin_lonlat),
        "entryBoundingVolume": {"box": entry_box},
        "entryGeometricError": entry_error,
        "boundsFilter": list(bounds_filter) if bounds_filter else None,
        "hasRgb": has_rgb,
        "colorScale": COLOR_SCALE_DEFAULT,
        "totalSourcePoints": total_source_points,
        "z0SubtreeCount": z0_count,
        "occupiedTileCount": occupied_count,
        "perLevel": per_level,
        "requestVolumePolicy": request_volume_policy(),
        "sourceFingerprints": source_files,
        "areaManifestUri": area_manifest_uri,
    }


# ─── Atomic IO ────────────────────────────────────────────────────────


def write_json_atomic(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            json.dump(obj, fp, indent=2)
            fp.write("\n")
        os.replace(tmp, path)
        os.chmod(path, 0o644)
    except OSError as exc:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise SystemExit(f"Cannot write {path}: {exc}") from exc


# ─── Preflight ────────────────────────────────────────────────────────


def preflight(input_dir: Path) -> dict[str, Any]:
    import laspy  # lazy
    from laspy.copc import CopcReader

    files = sorted(input_dir.glob("*.copc.laz"))
    if not files:
        raise SystemExit(f"No .copc.laz files in {input_dir}")
    crs_wkt = None
    has_rgb = True
    source_mins = None
    source_maxs = None
    total_points = 0
    records = []
    for path in files:
        with CopcReader.open(path) as reader:
            header = reader.header
            srs = header.parse_crs()
            if srs is None:
                raise SystemExit(f"Missing CRS metadata: {path}")
            wkt = srs.to_wkt()
            if crs_wkt is None:
                crs_wkt = wkt
            elif wkt != crs_wkt:
                raise SystemExit(f"CRS mismatch in {path}: expected {crs_wkt}")
            rgb = {"red", "green", "blue"}.issubset(set(header.point_format.dimension_names))
            if not rgb:
                has_rgb = False
            mins = np.asarray(header.mins, dtype=np.float64)
            maxs = np.asarray(header.maxs, dtype=np.float64)
            source_mins = mins if source_mins is None else np.minimum(source_mins, mins)
            source_maxs = maxs if source_maxs is None else np.maximum(source_maxs, maxs)
            total_points += int(header.point_count)
        records.append(fingerprint_file(path))
    return {
        "files": files,
        "records": records,
        "crs_wkt": crs_wkt,
        "has_rgb": has_rgb,
        "source_mins": source_mins,
        "source_maxs": source_maxs,
        "total_points": total_points,
    }


# ─── Streaming over COPC ──────────────────────────────────────────────


def enu_bbox_intersects(
    enu_min: np.ndarray, enu_max: np.ndarray, bounds: tuple[float, float, float, float]
) -> bool:
    """Axis-aligned XY intersection between an ENU bbox and pilot bounds."""
    return not (
        enu_max[0] < bounds[0] or enu_min[0] > bounds[2]
        or enu_max[1] < bounds[1] or enu_min[1] > bounds[3]
    )


def stream_copc(
    files: list[Path],
    frame: dict[str, Any],
    grid_origin: tuple[float, float],
    bounds_filter: tuple[float, float, float, float] | None,
    has_rgb: bool,
    fragments_dir: Path,
    completed: set[str],
    state_path: Path,
    state: dict[str, Any],
    counts: dict[tuple[str, int, int], int],
    leaf_zrange: dict[tuple[int, int], tuple[float, float]],
) -> tuple[dict[tuple[str, int, int], int], dict[tuple[int, int], tuple[float, float]], int]:
    import laspy  # lazy
    from laspy._compression.selection import DecompressionSelection
    from laspy.copc import CopcReader, load_octree_for_query

    counts = dict(counts)
    leaf_zrange = dict(leaf_zrange)
    ordinal = 0
    selection = DecompressionSelection.XY_RETURNS_CHANNEL | DecompressionSelection.Z
    if has_rgb:
        selection |= DecompressionSelection.RGB

    for path in files:
        chunk_id = path.stem  # e.g. chunk--1_-1
        if chunk_id in completed:
            # Skip but advance ordinal by the chunk's processed point count.
            ordinal = int(state.get("chunkOrdinals", {}).get(chunk_id, ordinal))
            continue
        # Clear any partial fragments from a crashed/killed run before re-streaming.
        chunk_frag_dir = fragments_dir / chunk_id
        if chunk_frag_dir.exists():
            shutil.rmtree(chunk_frag_dir)
        with CopcReader.open(path, decompression_selection=selection) as reader:
            header = reader.header
            chunk_point_count = int(header.point_count)
            # Pilot pruning at chunk level: skip chunks whose ENU XY bbox
            # does not intersect the pilot bounds. Ordinal still advances by
            # the chunk's full point count so nested sampling stays deterministic.
            if bounds_filter is not None:
                chunk_mins = np.asarray(header.mins, dtype=np.float64)
                chunk_maxs = np.asarray(header.maxs, dtype=np.float64)
                cenu_min, cenu_max = transform_bounds_to_enu(chunk_mins, chunk_maxs, frame)
                if not enu_bbox_intersects(cenu_min, cenu_max, bounds_filter):
                    ordinal += chunk_point_count
                    print(f"  {chunk_id}: skipped (no bounds overlap, +{chunk_point_count} ordinals)")
                    state.setdefault("chunkOrdinals", {})[chunk_id] = ordinal
                    state.setdefault("completedChunks", []).append(chunk_id)
                    state["counts"] = serialize_counts(counts)
                    state["leafZrange"] = serialize_leaf_zrange(leaf_zrange)
                    write_json_atomic(state_path, state)
                    continue
            nodes = load_octree_for_query(reader.source, reader.copc_info, reader.root_page)
            node_count = len(nodes)
            print(f"  {chunk_id}: {node_count} nodes, streaming...")
            node_index = 0
            for node in sorted(nodes, key=lambda nd: nodes_by_key_key(nd.key)):
                node_pts = int(node.point_count)
                if node_pts <= 0:
                    continue
                # Pilot pruning at node level: skip nodes whose ENU XY bbox
                # does not intersect the pilot bounds. Ordinal still advances.
                if bounds_filter is not None:
                    n_mins = np.asarray(node.bounds.mins, dtype=np.float64)
                    n_maxs = np.asarray(node.bounds.maxs, dtype=np.float64)
                    nenu_min, nenu_max = transform_bounds_to_enu(n_mins, n_maxs, frame)
                    if not enu_bbox_intersects(nenu_min, nenu_max, bounds_filter):
                        ordinal += node_pts
                        continue
                node_index += 1
                points = reader._fetch_and_decompress_points_of_nodes([node])
                xyz_source = np.column_stack(
                    (np.asarray(points.x), np.asarray(points.y), np.asarray(points.z))
                ).astype(np.float64)
                rgb = None
                if has_rgb:
                    rgb = np.column_stack(
                        (
                            color_to_u8(np.asarray(points.red)),
                            color_to_u8(np.asarray(points.green)),
                            color_to_u8(np.asarray(points.blue)),
                        )
                    )
                xyz_enu = source_points_to_enu(xyz_source, frame)
                ordinal, counts, leaf_zrange = partition_points(
                    xyz_enu, rgb, ordinal, bounds_filter, grid_origin, has_rgb,
                    fragments_dir, chunk_id, counts, leaf_zrange,
                )
                if node_index % 25 == 0 or node_index == node_count:
                    print(f"    {chunk_id}: node {node_index}/{node_count} ordinal={ordinal}")
        # Atomic checkpoint at source-chunk boundary.
        state.setdefault("chunkOrdinals", {})[chunk_id] = ordinal
        state.setdefault("completedChunks", []).append(chunk_id)
        state["counts"] = serialize_counts(counts)
        state["leafZrange"] = serialize_leaf_zrange(leaf_zrange)
        write_json_atomic(state_path, state)
        print(f"  checkpoint: {chunk_id} (ordinal={ordinal})")

    return counts, leaf_zrange, ordinal


def nodes_by_key_key(key: Any) -> tuple[int, int, int, int]:
    return (int(key.level), int(key.x), int(key.y), int(key.z))


# ─── Resume / disk safety ─────────────────────────────────────────────


RESUME_STATE_KEYS = (
    "profileHash", "gridOrigin", "enuOriginSource", "rootTransform",
    "enuOriginLonLat", "enuOriginEcef", "boundsFilter", "outputName",
    "hasRgb", "colorScale", "sourceFiles",
)


def _validate_resume_state(saved: dict[str, Any], fresh: dict[str, Any]) -> None:
    """Reject resume when the source set, ENU frame, bounds or profile changed."""
    if saved.get("profileHash") != fresh.get("profileHash"):
        raise SystemExit("Cannot resume: LOD profile changed")
    if saved.get("hasRgb") != fresh.get("hasRgb"):
        raise SystemExit("Cannot resume: hasRgb changed")
    if saved.get("colorScale") != fresh.get("colorScale"):
        raise SystemExit("Cannot resume: colorScale changed")
    if saved.get("outputName") != fresh.get("outputName"):
        raise SystemExit("Cannot resume: outputName changed")
    if list(saved.get("gridOrigin", [])) != list(fresh.get("gridOrigin", [])):
        raise SystemExit("Cannot resume: gridOrigin changed")
    if list(saved.get("boundsFilter") or []) != list(fresh.get("boundsFilter") or []):
        raise SystemExit("Cannot resume: boundsFilter changed")
    if list(saved.get("enuOriginSource", [])) != list(fresh.get("enuOriginSource", [])):
        raise SystemExit("Cannot resume: enuOriginSource changed")
    if list(saved.get("rootTransform", [])) != list(fresh.get("rootTransform", [])):
        raise SystemExit("Cannot resume: rootTransform changed")
    saved_files = saved.get("sourceFiles", [])
    fresh_files = fresh.get("sourceFiles", [])
    if len(saved_files) != len(fresh_files):
        raise SystemExit(
            f"Cannot resume: source file count changed ({len(saved_files)} -> {len(fresh_files)})"
        )
    for rec, fresh_rec in zip(saved_files, fresh_files):
        if rec != fresh_rec:
            raise SystemExit(
                f"Cannot resume: source fingerprint changed for {rec.get('name')}"
            )


def _estimate_output_bytes(total_points: int, has_rgb: bool, pilot: bool) -> int:
    """Rough PNTS payload estimate. Empirically the four-level nested sampling
    emits ~1.62× source points (p02+p10+p50+p100 overlap). Pilot builds are
    bounded by the bounds filter so the worst case is the full estimate."""
    bytes_per_point = POINT_BYTES_RGB if has_rgb else POINT_BYTES_XYZ
    return int(total_points * 1.62 * bytes_per_point)


def _check_disk_space(
    output_dir: Path,
    total_points: int,
    has_rgb: bool,
    pilot: bool,
    allow_low_disk: bool,
) -> None:
    usage = shutil.disk_usage(output_dir)
    estimate = _estimate_output_bytes(total_points, has_rgb, pilot)
    required = int(estimate * 1.15)
    free = usage.free
    label = "pilot" if pilot else "full"
    print(
        f"  disk:         free={free/1024**3:.1f} GiB, "
        f"estimated {label} output≈{estimate/1024**3:.1f} GiB, "
        f"required(×1.15)≈{required/1024**3:.1f} GiB"
    )
    if free < required and not allow_low_disk:
        raise SystemExit(
            f"Insufficient free space: need ~{required/1024**3:.1f} GiB, have {free/1024**3:.1f} GiB. "
            "Pass --allow-low-disk to override."
        )


# ─── Top-level orchestrator ───────────────────────────────────────────


def build_spatial_lod_tree(
    root_dir: Path,
    dataset: str,
    public_root: str = "",
    bounds_enu: tuple[float, float, float, float] | None = None,
    output_name: str | None = None,
    resume: bool = False,
    overwrite: bool = False,
    allow_low_disk: bool = False,
) -> dict[str, Any]:
    dataset = validate_name(dataset, "dataset")
    public_root = validate_name(public_root, "public-root") if public_root else ""
    logical = public_root or dataset
    name = validate_name(output_name, "output-name") if output_name else f"{logical}-spatial-lod"

    if resume and overwrite:
        raise SystemExit("--resume and --overwrite are mutually exclusive")

    intermediate_root = (root_dir / "local-storage" / "intermediate").resolve()
    tilesets_root = (root_dir / "local-storage" / "tilesets").resolve()
    input_dir = (intermediate_root / dataset / "chunks-copc").resolve()
    if not input_dir.exists():
        raise SystemExit(f"COPC chunks not found: {input_dir}")
    assert_inside(input_dir, intermediate_root, "input dir")
    logical_dir = tilesets_root / logical
    output_dir = (logical_dir / name).resolve()
    assert_inside(output_dir, tilesets_root, "output dir")
    # area-manifest.json sits next to the output folder; URI is relative to the output dir.
    area_manifest_uri = "../area-manifest.json"

    output_exists = output_dir.exists()
    if output_exists and not (resume or overwrite):
        raise SystemExit(f"Output exists. Pass --overwrite or --resume: {output_dir}")
    if resume and not output_exists:
        raise SystemExit(f"Cannot resume: output does not exist at {output_dir}")

    state_path = output_dir / STATE_NAME

    pre = preflight(input_dir)
    files = pre["files"]
    has_rgb = pre["has_rgb"]
    source_mins = pre["source_mins"]
    source_maxs = pre["source_maxs"]
    total_points = pre["total_points"]

    enu_origin_source = (source_mins + source_maxs) / 2.0
    frame = build_enu_frame(_crs_from_wkt(pre["crs_wkt"]), enu_origin_source)
    enu_min, enu_max = transform_bounds_to_enu(source_mins, source_maxs, frame)
    grid_origin = snap_grid_origin(float(enu_min[0]), float(enu_min[1]))

    state: dict[str, Any] = {
        "profileHash": profile_hash(),
        "gridOrigin": [grid_origin[0], grid_origin[1]],
        "enuOriginSource": enu_origin_source.tolist(),
        "rootTransform": frame["root_transform"],
        "enuOriginLonLat": list(frame["enu_origin_lonlat"]),
        "enuOriginEcef": frame["enu_origin_ecef"].tolist(),
        "boundsFilter": list(bounds_enu) if bounds_enu else None,
        "outputName": name,
        "hasRgb": has_rgb,
        "colorScale": COLOR_SCALE_DEFAULT,
        "sourceFiles": pre["records"],
        "completedChunks": [],
        "chunkOrdinals": {},
        "counts": [],
        "leafZrange": [],
    }

    completed: set[str] = set()
    counts: dict[tuple[str, int, int], int] = {}
    leaf_zrange: dict[tuple[int, int], tuple[float, float]] = {}
    if resume and state_path.exists():
        saved = json.loads(state_path.read_text(encoding="utf-8"))
        _validate_resume_state(saved, state)
        state = saved
        completed = set(saved.get("completedChunks", []))
        grid_origin = tuple(saved["gridOrigin"])
        bounds_enu = tuple(saved["boundsFilter"]) if saved.get("boundsFilter") else None
        counts = deserialize_counts(saved.get("counts", []))
        leaf_zrange = deserialize_leaf_zrange(saved.get("leafZrange", saved.get("z3Zrange", [])))
    elif resume:
        raise SystemExit(f"Cannot resume: no state file at {state_path}")

    # Validate the source, resume state, and disk budget before an overwrite can
    # remove a previously successful build.
    disk_check_path = output_dir if output_exists else root_dir.resolve()
    _check_disk_space(disk_check_path, total_points, has_rgb, bounds_enu is not None, allow_low_disk)

    if overwrite and output_exists:
        assert_inside(output_dir, tilesets_root, "output dir")
        shutil.rmtree(output_dir)

    output_dir.mkdir(parents=True, exist_ok=True)
    fragments_dir = output_dir / FRAGMENTS_DIR
    fragments_dir.mkdir(parents=True, exist_ok=True)
    if not resume:
        write_json_atomic(state_path, state)

    print(f"=== Spatial LOD Tree: {dataset} ===")
    print(f"  logical:      {logical}")
    print(f"  output:       {output_dir}")
    print(f"  grid origin:  {grid_origin}")
    print(f"  chunks:       {len(files)}  points≈{total_points}")
    print(f"  rgb:          {has_rgb}")
    if bounds_enu:
        print(f"  pilot bounds: {bounds_enu}")

    counts, leaf_zrange, final_ordinal = stream_copc(
        files, frame, grid_origin, bounds_enu, has_rgb, fragments_dir, completed, state_path, state,
        counts, leaf_zrange,
    )

    # Finalize: write PNTS (atomic), build z0 subtrees, validate, publish entry.
    result = finalize_output(
        output_dir=output_dir,
        fragments_dir=fragments_dir,
        grid_origin=grid_origin,
        root_transform=frame["root_transform"],
        enu_origin_lonlat=frame["enu_origin_lonlat"],
        enu_origin_source=enu_origin_source.tolist(),
        enu_origin_ecef=frame["enu_origin_ecef"].tolist(),
        has_rgb=has_rgb,
        counts=counts,
        leaf_zrange=leaf_zrange,
        source_files=pre["records"],
        bounds_filter=bounds_enu,
        output_name=name,
        logical=logical,
        area_manifest_uri=area_manifest_uri,
        total_source_points=total_points,
        resume_finalize=resume,
    )
    state_path.unlink(missing_ok=True)
    print(f"  z0 subtrees:  {result['z0Count']}")
    print(f"  occupied:     {result['occupiedCount']}")
    for lv in LEVELS:
        m = result["perLevel"][lv.name]
        print(f"  {lv.name}: {m['tiles']} tiles, {m['points']} points, {m['bytes']} bytes")
    print(f"  entry:        {result['outputPath']}")
    return result


def _crs_from_wkt(wkt: str) -> Any:
    from pyproj import CRS  # lazy
    return CRS.from_user_input(wkt)


# ─── Test entry: build from in-memory points (no COPC) ────────────────


def build_from_points(
    output_dir: Path,
    points_enu: np.ndarray,
    rgb: np.ndarray | None,
    grid_origin: tuple[float, float],
    root_transform: list[float],
    enu_origin_lonlat: tuple[float, float, float],
    enu_origin_source: list[float],
    enu_origin_ecef: list[float],
    has_rgb: bool,
    bounds_filter: tuple[float, float, float, float] | None = None,
    logical: str = "test-logical",
    chunk_id: str = "chunk-test",
    area_manifest_uri: str = "test-logical/area-manifest.json",
) -> dict[str, Any]:
    """Test helper: skip COPC streaming, partition a single in-memory point batch."""
    output_dir.mkdir(parents=True, exist_ok=True)
    fragments_dir = output_dir / FRAGMENTS_DIR
    fragments_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[tuple[str, int, int], int] = {}
    leaf_zrange: dict[tuple[int, int], tuple[float, float]] = {}
    _, counts, leaf_zrange = partition_points(
        points_enu, rgb, 0, bounds_filter, grid_origin, has_rgb,
        fragments_dir, chunk_id, counts, leaf_zrange,
    )
    return finalize_output(
        output_dir=output_dir,
        fragments_dir=fragments_dir,
        grid_origin=grid_origin,
        root_transform=root_transform,
        enu_origin_lonlat=enu_origin_lonlat,
        enu_origin_source=enu_origin_source,
        enu_origin_ecef=enu_origin_ecef,
        has_rgb=has_rgb,
        counts=counts,
        leaf_zrange=leaf_zrange,
        source_files=[{"name": chunk_id, "size": 0, "mtime_ns": 0, "fingerprint": "test"}],
        bounds_filter=bounds_filter,
        output_name=output_dir.name,
        logical=logical,
        area_manifest_uri=area_manifest_uri,
        total_source_points=int(points_enu.shape[0]),
        resume_finalize=False,
    )


# ─── CLI ──────────────────────────────────────────────────────────────


def parse_bounds_enu(value: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in value.split(",")]
    if len(parts) != 4 or any(not p for p in parts):
        raise argparse.ArgumentTypeError('Expected "minX,minY,maxX,maxY"')
    try:
        nums = [float(p) for p in parts]
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Non-numeric bounds: {exc}") from exc
    minx, miny, maxx, maxy = nums
    if minx > maxx or miny > maxy:
        raise argparse.ArgumentTypeError("min must be <= max for both axes")
    return (minx, miny, maxx, maxy)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a Spatial LOD Grid/Tree.")
    parser.add_argument("dataset", help="Source dataset, e.g. 2404PeruB2.")
    parser.add_argument("--root", required=True, help="Project root containing local-storage/.")
    parser.add_argument("--public-root", default="", help="Logical/public root.")
    parser.add_argument("--bounds-enu", type=parse_bounds_enu, default=None, help="Pilot ENU XY bounds minX,minY,maxX,maxY.")
    parser.add_argument("--output-name", default=None, help="Override default output folder name.")
    parser.add_argument("--resume", action="store_true", help="Resume from checkpoints.")
    parser.add_argument("--overwrite", action="store_true", help="Replace existing output.")
    parser.add_argument(
        "--allow-low-disk",
        action="store_true",
        help="Override the disk-space preflight check.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    result = build_spatial_lod_tree(
        root_dir=Path(args.root).resolve(),
        dataset=args.dataset,
        public_root=args.public_root,
        bounds_enu=args.bounds_enu,
        output_name=args.output_name,
        resume=args.resume,
        overwrite=args.overwrite,
        allow_low_disk=args.allow_low_disk,
    )
    print(f"Built spatial LOD tree: {result['outputPath']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
