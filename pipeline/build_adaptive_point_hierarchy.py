#!/usr/bin/env python3
"""Adaptive Point Hierarchy (APH) pipeline — foundation and residual tree.

This module owns the Plan 1 foundation plus the Plan 2 residual adaptive
quadtree. It does not emit 3D Tiles hierarchy JSON; that remains Plan 3. It
does not import, call, or modify
``build_spatial_lod_tree.partition_points`` or any other Spatial LOD symbol;
Spatial LOD (``?lod=spatial-lod``) is untouched by APH.
"""
from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import os
import re
import shutil
import struct
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np


NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
Z0_ID_PATTERN = re.compile(r"^z0_x-?\d+_y-?\d+$")

COLOR_SCALE_DEFAULT = 256.0
Z0_CELL = 2000.0  # exact 2 km z0 grid, same convention as Spatial LOD

SCHEMA_VERSION = 2
GENERATOR = "SBB Adaptive Point Hierarchy V1"
STATE_NAME = ".adaptive-point-hierarchy-state.json"
REPORT_NAME = "adaptive-point-hierarchy-report.json"

POINT_BYTES_RGB = 15  # float32 xyz (12) + uint8 rgb (3)
POINT_BYTES_XYZ = 12
ORDINAL_SIDECAR_BYTES = 8  # temporary per-point .ord.u64 duplicate/omission audit sidecar
FRAGMENT_BYTES_RGB = 35  # float64 xyz + uint8 rgb + uint64 ordinal
FRAGMENT_BYTES_XYZ = 32  # float64 xyz + uint64 ordinal
OWNERSHIP_MAP_BYTES = 1  # disk-backed uint8 ownership state per source ordinal
DISK_SAFETY_MARGIN = 1.20
CHUNK_SHARDS_DIR = ".chunks"
FINALIZING_DIR = ".aph-finalizing"

VRV_MODES = ("both", "none", "frontier-tight")
PILOT_MODES = ("auto", "none")

DEFAULT_INTERNAL_TARGET_POINTS = 75_000
DEFAULT_ACCEPTABLE_MIN_POINTS = 40_000
DEFAULT_LEAF_MAX_POINTS = 110_000
DEFAULT_HARD_MAX_POINTS = 150_000
DEFAULT_MAX_DEPTH = 11
DEFAULT_ERROR_SCALE = 2.0
DEFAULT_MICROCELL_GRID = 16
PROGRESS_INTERVAL_SECONDS = 30.0


# ─── Human-readable pipeline progress ──────────────────────────────────


def _format_point_count(value: int) -> str:
    value = int(value)
    if abs(value) >= 1_000_000_000:
        return f"{value / 1_000_000_000:.3f}B"
    if abs(value) >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if abs(value) >= 1_000:
        return f"{value / 1_000:.1f}K"
    return str(value)


def _format_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def _emit_pipeline_progress(
    phase: str,
    item_index: int,
    item_total: int,
    item_name: str,
    points_done: int,
    total_points: int,
    started_at: float,
    started_points: int = 0,
    detail: str = "",
) -> None:
    elapsed = max(0.0, time.monotonic() - started_at)
    session_points = max(0, int(points_done) - int(started_points))
    rate = session_points / elapsed if elapsed > 0 else 0.0
    percent = (100.0 * points_done / total_points) if total_points > 0 else 0.0
    remaining = max(0, total_points - points_done)
    eta = (remaining / rate) if rate > 0 and total_points > 0 else None
    point_text = f"{_format_point_count(points_done)}/{_format_point_count(total_points)}"
    parts = [
        f"[{phase} {item_index}/{item_total}] {item_name}",
        f"points={point_text} ({percent:.1f}%)",
        f"rate={_format_point_count(int(rate))} pts/s",
        f"elapsed={_format_duration(elapsed)}",
        f"ETA={_format_duration(eta)}" if eta is not None else "ETA=calculating",
    ]
    if detail:
        parts.insert(1, detail)
    print(" | ".join(parts), flush=True)


# ─── Name / path safety ────────────────────────────────────────────────


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


# ─── CLI profile validation ────────────────────────────────────────────


def validate_thresholds(
    acceptable_min_points: int,
    internal_target_points: int,
    leaf_max_points: int,
    hard_max_points: int,
) -> None:
    if acceptable_min_points <= 0:
        raise SystemExit("--acceptable-min-points must be positive")
    if not (acceptable_min_points < internal_target_points < leaf_max_points < hard_max_points):
        raise SystemExit(
            "Threshold ordering violated: require "
            "0 < acceptable-min-points < internal-target-points < leaf-max-points < hard-max-points "
            f"(got acceptable-min={acceptable_min_points}, internal-target={internal_target_points}, "
            f"leaf-max={leaf_max_points}, hard-max={hard_max_points})"
        )


def validate_z0_ids(z0_ids: list[str]) -> list[str]:
    seen: set[str] = set()
    for zid in z0_ids:
        if not Z0_ID_PATTERN.match(zid):
            raise SystemExit(f"Invalid --z0-id: {zid!r}")
        if zid in seen:
            raise SystemExit(f"Repeated --z0-id: {zid!r}")
        seen.add(zid)
    return list(z0_ids)


def profile_hash(cli_profile: dict[str, Any]) -> str:
    payload = json.dumps(cli_profile, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ─── Atomic JSON ────────────────────────────────────────────────────────


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


# ─── ENU frame (lazy pyproj) ────────────────────────────────────────────


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


def snap_grid_origin(min_x: float, min_y: float, z0_cell: float = Z0_CELL) -> tuple[float, float]:
    """Snap dataset ENU minimum down to the nearest exact z0 boundary."""
    return (
        math.floor(min_x / z0_cell) * z0_cell,
        math.floor(min_y / z0_cell) * z0_cell,
    )


# ─── Source fingerprinting ──────────────────────────────────────────────


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


# ─── Preflight ──────────────────────────────────────────────────────────


def preflight(input_dir: Path) -> dict[str, Any]:
    """Scan COPC sources: fingerprints, CRS agreement, RGB availability and bounds."""
    from laspy.copc import CopcReader  # lazy

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


def _crs_from_wkt(wkt: str) -> Any:
    from pyproj import CRS  # lazy
    return CRS.from_user_input(wkt)


# ─── Disk preflight ─────────────────────────────────────────────────────


def _estimate_output_bytes(total_points: int, has_rgb: bool) -> int:
    """Conservative full-selection peak estimate.

    Chunk shards remain immutable while one z0 is copied into a disposable
    finalization workspace. While an internal node is partitioned, its parent
    fragment and newly appended child fragments coexist, so the full-selection
    peak can reach three fragment records per point (source shard + parent +
    children). Also budget final/temporary PNTS payloads, ordinal sidecars, and
    the sparse uint8 ownership map. Pilot builds intentionally use the same
    full-source upper bound because selected-z0 counts are not known yet.
    """
    point_bytes = POINT_BYTES_RGB if has_rgb else POINT_BYTES_XYZ
    fragment_bytes = FRAGMENT_BYTES_RGB if has_rgb else FRAGMENT_BYTES_XYZ
    per_point = (
        3 * fragment_bytes
        + 2 * point_bytes
        + ORDINAL_SIDECAR_BYTES
        + OWNERSHIP_MAP_BYTES
    )
    return int(total_points * per_point)


def _check_disk_space(
    output_dir: Path,
    total_points: int,
    has_rgb: bool,
    allow_low_disk: bool,
) -> None:
    usage = shutil.disk_usage(output_dir)
    estimate = _estimate_output_bytes(total_points, has_rgb)
    required = int(estimate * DISK_SAFETY_MARGIN)
    free = usage.free
    print(
        f"  disk:         free={free/1024**3:.1f} GiB, "
        f"estimated output≈{estimate/1024**3:.1f} GiB, "
        f"required(×{DISK_SAFETY_MARGIN:.2f})≈{required/1024**3:.1f} GiB"
    )
    if free < required and not allow_low_disk:
        raise SystemExit(
            f"Insufficient free space: need ~{required/1024**3:.1f} GiB, have {free/1024**3:.1f} GiB. "
            "Pass --allow-low-disk to override."
        )


# ─── Resume ─────────────────────────────────────────────────────────────


def _validate_resume_state(saved: dict[str, Any], fresh: dict[str, Any]) -> bool:
    """Validate every input that can change point ownership.

    Returns True when a pristine schema-v1 foundation was safely migrated to
    schema v2. Partially streamed v1 state is deliberately rejected because
    v1 used non-transactional shared fragments.
    """
    migrated = False
    if saved.get("schemaVersion") != fresh.get("schemaVersion"):
        pristine_v1 = (
            saved.get("schemaVersion") == 1
            and fresh.get("schemaVersion") == SCHEMA_VERSION
            and saved.get("phase") == "initialized"
            and not saved.get("completedChunks")
            and not saved.get("selectedZ0Ids")
        )
        if not pristine_v1:
            raise SystemExit("Cannot resume: state schema changed")
        saved["schemaVersion"] = SCHEMA_VERSION
        migrated = True

    scalar_keys = (
        "profileHash", "pilotSelectionRequest", "requestedZ0Ids",
        "outputName", "hasRgb", "colorScale", "totalSourcePoints",
    )
    for key in scalar_keys:
        if key == "totalSourcePoints" and key not in saved and saved.get("phase") == "initialized":
            saved[key] = fresh.get(key)
            migrated = True
        if saved.get(key) != fresh.get(key):
            raise SystemExit(f"Cannot resume: {key} changed")

    vector_keys = (
        "gridOrigin", "enuOriginSource", "rootTransform",
        "enuOriginLonLat", "enuOriginEcef",
    )
    for key in vector_keys:
        if list(saved.get(key, [])) != list(fresh.get(key, [])):
            raise SystemExit(f"Cannot resume: {key} changed")

    saved_files = saved.get("sourceFiles", [])
    fresh_files = fresh.get("sourceFiles", [])
    if len(saved_files) != len(fresh_files):
        raise SystemExit(
            f"Cannot resume: source file count changed ({len(saved_files)} -> {len(fresh_files)})"
        )
    for rec, fresh_rec in zip(saved_files, fresh_files):
        if rec != fresh_rec:
            raise SystemExit(f"Cannot resume: source fingerprint changed for {rec.get('name')}")
    return migrated


# ─── Output skeleton ────────────────────────────────────────────────────


def _create_output_skeleton(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "z0").mkdir(parents=True, exist_ok=True)
    (output_dir / "points" / "z0").mkdir(parents=True, exist_ok=True)
    (output_dir / "points" / "adaptive").mkdir(parents=True, exist_ok=True)


def _build_report_skeleton(
    dataset: str,
    logical: str,
    output_name: str,
    cli_profile: dict[str, Any],
    pilot: str,
    z0_ids: list[str],
    total_source_points: int,
) -> dict[str, Any]:
    selection_mode = "explicit-z0" if z0_ids else ("full" if pilot == "none" else "pilot-auto")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generator": GENERATOR,
        "status": "initialized",
        "dataset": dataset,
        "logical": logical,
        "outputName": output_name,
        "cliProfile": cli_profile,
        "pilotSelectionRequest": pilot,
        "selectionMode": selection_mode,
        "requestedZ0Ids": z0_ids,
        "totalSourcePoints": int(total_source_points),
    }


def selection_metadata(state: dict[str, Any]) -> dict[str, Any]:
    """Human-facing selection scope; does not replace the stable CLI request."""
    extension = state.get("pilotExtension")
    if extension is not None:
        return {
            "selectionMode": "extended-full",
            "pilotZ0Ids": extension["baseSelectedZ0Ids"],
            "extendedZ0Ids": extension["addedZ0Ids"],
        }
    if state.get("requestedZ0Ids"):
        return {"selectionMode": "explicit-z0"}
    return {"selectionMode": "full" if state.get("pilotSelectionRequest") == "none" else "pilot-auto"}


def update_extension_report(report_path: Path, state: dict[str, Any]) -> None:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report.update({
        "status": "extending-full",
        "selectedZ0Ids": state["selectedZ0Ids"],
        **selection_metadata(state),
    })
    write_json_atomic(report_path, report)


# ─── z0 tile addressing (mirrors Spatial LOD's z0 convention) ──────────


def z0_cell_index(coord: float, origin: float, cell: float = Z0_CELL) -> int:
    """Cell index with the convention that a point exactly on a boundary
    belongs to the higher-index cell (same as Spatial LOD's cell_index)."""
    return int(math.floor((coord - origin) / cell))


def z0_tile_id(ix: int, iy: int) -> str:
    return f"z0_x{ix:06d}_y{iy:06d}"


def z0_bounds(ix: int, iy: int, origin_x: float, origin_y: float, cell: float = Z0_CELL) -> tuple[float, float, float, float]:
    minx = origin_x + ix * cell
    miny = origin_y + iy * cell
    return (minx, miny, minx + cell, miny + cell)


# ─── Adaptive quadtree geometry (fixed-center-cut, nominal bounds only) ──


QUAD_WEST_SOUTH = 0
QUAD_EAST_SOUTH = 1
QUAD_WEST_NORTH = 2
QUAD_EAST_NORTH = 3


def quadrant_for_point(x: float, y: float, center_x: float, center_y: float) -> int:
    """Fixed-center-cut routing: a point exactly on the center line always
    goes east/north (>=), never west/south. No median or tight-bounds split."""
    east = x >= center_x
    north = y >= center_y
    if east and north:
        return QUAD_EAST_NORTH
    if east:
        return QUAD_EAST_SOUTH
    if north:
        return QUAD_WEST_NORTH
    return QUAD_WEST_SOUTH


def node_path_str(path: tuple[int, ...]) -> str:
    return "".join(str(d) for d in path)


def node_id(z0_id: str, depth: int, path: tuple[int, ...]) -> str:
    return f"{z0_id}/d{depth}_q{node_path_str(path)}"


def nominal_bounds_for_path(
    z0_min_x: float, z0_min_y: float, z0_max_x: float, z0_max_y: float, path: tuple[int, ...]
) -> tuple[float, float, float, float]:
    """Analytic (data-independent) node bounds: bisect the z0 cell once per
    path digit. Depends only on the fixed z0 cell and the quadrant path, never
    on where points actually fall — this is the "fixed-center-cut" contract."""
    minx, miny, maxx, maxy = z0_min_x, z0_min_y, z0_max_x, z0_max_y
    for digit in path:
        cx = (minx + maxx) / 2.0
        cy = (miny + maxy) / 2.0
        if digit in (QUAD_EAST_SOUTH, QUAD_EAST_NORTH):
            minx = cx
        else:
            maxx = cx
        if digit in (QUAD_WEST_NORTH, QUAD_EAST_NORTH):
            miny = cy
        else:
            maxy = cy
    return (minx, miny, maxx, maxy)


def nominal_center(bounds: tuple[float, float, float, float]) -> tuple[float, float]:
    minx, miny, maxx, maxy = bounds
    return ((minx + maxx) / 2.0, (miny + maxy) / 2.0)


# ─── Node policy ──────────────────────────────────────────────────────


NODE_KIND_LEAF = "leaf"
NODE_KIND_INTERNAL = "internal"
NODE_KIND_LEAF_MAX_DEPTH = "leaf_max_depth"


def decide_node_kind(
    count: int,
    depth: int,
    max_depth: int,
    leaf_max_points: int,
    hard_max_points: int,
) -> str:
    """Node emission policy (checked in this exact order):

    count <= leaf_max_points               -> leaf (regardless of depth)
    depth < max_depth                      -> internal (sample + split remainder)
    count <= hard_max_points (depth==max)  -> leaf_max_depth
    otherwise                              -> hard-max validation failure
    """
    if count <= leaf_max_points:
        return NODE_KIND_LEAF
    if depth < max_depth:
        return NODE_KIND_INTERNAL
    if count <= hard_max_points:
        return NODE_KIND_LEAF_MAX_DEPTH
    raise SystemExit(
        f"Adaptive quadtree hard-max exceeded at depth {depth}: "
        f"count={count} > hard-max-points={hard_max_points}"
    )


# ─── Representative sampling: microcells, quota, stable hash ────────────


def microcell_index(
    x: float, y: float, bounds: tuple[float, float, float, float], grid: int
) -> int:
    """Flat row-major microcell index for a point within a node's nominal bounds."""
    minx, miny, maxx, maxy = bounds
    width = max(maxx - minx, 1e-9)
    height = max(maxy - miny, 1e-9)
    col = int((x - minx) / width * grid)
    row = int((y - miny) / height * grid)
    col = min(max(col, 0), grid - 1)
    row = min(max(row, 0), grid - 1)
    return row * grid + col


def microcell_index_batch(
    x: np.ndarray, y: np.ndarray, bounds: tuple[float, float, float, float], grid: int
) -> np.ndarray:
    """Vectorized form of microcell_index for a batch of points."""
    minx, miny, maxx, maxy = bounds
    width = max(maxx - minx, 1e-9)
    height = max(maxy - miny, 1e-9)
    col = np.clip(((x - minx) / width * grid).astype(np.int64), 0, grid - 1)
    row = np.clip(((y - miny) / height * grid).astype(np.int64), 0, grid - 1)
    return row * grid + col


def allocate_representative_quota(occupied_counts: dict[int, int], quota_total: int) -> dict[int, int]:
    """Largest-remainder proportional quota allocation across occupied microcells.

    Every occupied microcell receives at least one representative (when quota
    allows); remaining quota is distributed proportionally to each microcell's
    point count, floor first then largest-remainder, capacity-capped, tie-broken
    by ascending microcell index.
    """
    cells = sorted(occupied_counts.keys())
    total_count = sum(occupied_counts[c] for c in cells)
    quota_total = max(0, min(quota_total, total_count))
    n = len(cells)

    if quota_total <= 0:
        return {c: 0 for c in cells}

    if quota_total <= n:
        # Not enough quota to seed every occupied cell: award one representative
        # each to the `quota_total` cells with the largest counts, tie-break by
        # ascending microcell index.
        ranked = sorted(cells, key=lambda c: (-occupied_counts[c], c))
        chosen = set(ranked[:quota_total])
        return {c: (1 if c in chosen else 0) for c in cells}

    alloc = {c: 1 for c in cells}
    capacity = {c: occupied_counts[c] for c in cells}
    extra_quota = quota_total - n

    targets = {c: extra_quota * occupied_counts[c] / total_count for c in cells}
    floor_extra = {c: min(int(math.floor(targets[c])), capacity[c] - 1) for c in cells}
    for c in cells:
        alloc[c] += floor_extra[c]

    leftover = extra_quota - sum(floor_extra.values())
    remainder_order = sorted(cells, key=lambda c: (-(targets[c] - floor_extra[c]), c))
    for c in remainder_order:
        if leftover <= 0:
            break
        if alloc[c] >= capacity[c]:
            continue
        alloc[c] += 1
        leftover -= 1

    # Rare fallback: capacity constraints left quota undistributed (very skewed
    # counts). Sweep in index order for any remaining spare capacity.
    if leftover > 0:
        for c in cells:
            while leftover > 0 and alloc[c] < capacity[c]:
                alloc[c] += 1
                leftover -= 1

    return alloc


def combined_source_fingerprint(records: list[dict[str, Any]]) -> str:
    """Deterministic salt derived from the ordered set of source fingerprints."""
    payload = json.dumps([r.get("fingerprint") for r in records], sort_keys=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def fingerprint_salt(fingerprint_hex: str) -> int:
    return int(fingerprint_hex[:16], 16)


_SPLITMIX64_MASK = np.uint64(0xFFFFFFFFFFFFFFFF)


def stable_hash_batch(ordinals: np.ndarray, salt: int) -> np.ndarray:
    """Deterministic, vectorized per-point hash for representative selection.

    Combines the dataset's combined-source-fingerprint salt with each point's
    global ordinal via splitmix64 bit mixing. Avoids a per-point cryptographic
    hash (sha256) at the scale of hundreds of millions of points while staying
    fully deterministic and salt-bound to the exact source content."""
    with np.errstate(over="ignore"):
        z = (ordinals.astype(np.uint64) ^ np.uint64(salt & int(_SPLITMIX64_MASK)))
        z = z + np.uint64(0x9E3779B97F4A7C15)
        z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        z = z ^ (z >> np.uint64(31))
    return z


def stable_hash_one(ordinal: int, salt: int) -> int:
    return int(stable_hash_batch(np.asarray([ordinal], dtype=np.uint64), salt)[0])


# ─── Disk-backed fragments (fixed-record, memmap-readable) ──────────────
#
# A fragment is a bag of points routed to one quadtree node (or a z0's p001
# bucket). Records are appended as raw fixed-size structs so a fragment never
# needs to be fully materialized in RAM: it is read back through np.memmap and
# streamed in batches.


FRAGMENT_DTYPE_RGB = np.dtype(
    [("x", "<f8"), ("y", "<f8"), ("z", "<f8"), ("r", "u1"), ("g", "u1"), ("b", "u1"), ("ordinal", "<u8")]
)
FRAGMENT_DTYPE_XYZ = np.dtype([("x", "<f8"), ("y", "<f8"), ("z", "<f8"), ("ordinal", "<u8")])
FRAGMENT_BATCH_POINTS = 2_000_000

if FRAGMENT_DTYPE_RGB.itemsize != FRAGMENT_BYTES_RGB:
    raise RuntimeError("FRAGMENT_BYTES_RGB no longer matches FRAGMENT_DTYPE_RGB")
if FRAGMENT_DTYPE_XYZ.itemsize != FRAGMENT_BYTES_XYZ:
    raise RuntimeError("FRAGMENT_BYTES_XYZ no longer matches FRAGMENT_DTYPE_XYZ")


def fragment_dtype(has_rgb: bool) -> np.dtype:
    return FRAGMENT_DTYPE_RGB if has_rgb else FRAGMENT_DTYPE_XYZ


def append_fragment(
    path: Path,
    xyz: np.ndarray,
    rgb: np.ndarray | None,
    ordinals: np.ndarray,
    has_rgb: bool,
) -> None:
    n = int(xyz.shape[0])
    if n == 0:
        return
    dtype = fragment_dtype(has_rgb)
    records = np.empty(n, dtype=dtype)
    records["x"] = xyz[:, 0]
    records["y"] = xyz[:, 1]
    records["z"] = xyz[:, 2]
    if has_rgb:
        records["r"] = rgb[:, 0]
        records["g"] = rgb[:, 1]
        records["b"] = rgb[:, 2]
    records["ordinal"] = ordinals
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "ab") as fp:
        fp.write(records.tobytes(order="C"))


def fragment_record_count(path: Path, has_rgb: bool) -> int:
    if not path.exists():
        return 0
    itemsize = fragment_dtype(has_rgb).itemsize
    size = path.stat().st_size
    if size % itemsize != 0:
        raise SystemExit(f"Corrupt fragment (size not a multiple of record size): {path}")
    return size // itemsize


def iter_fragment_batches(
    path: Path, has_rgb: bool, batch_points: int = FRAGMENT_BATCH_POINTS
) -> Iterable[np.ndarray]:
    """Yield successive slices of a fragment without materializing it whole."""
    total = fragment_record_count(path, has_rgb)
    if total == 0:
        return
    mm = np.memmap(path, dtype=fragment_dtype(has_rgb), mode="r", shape=(total,))
    for start in range(0, total, batch_points):
        yield mm[start : start + batch_points]


def delete_fragment(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


# ─── PNTS writer (Cesium 3D Tiles point cloud tile format) ───────────────
#
# Adapted, independent copy of build_spatial_lod_tree's PNTS helpers — kept
# duplicated on purpose (see module docstring: APH never imports from Spatial
# LOD).


def padded_json_bytes(value: dict[str, Any], start_offset: int) -> bytes:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    padding = (8 - ((start_offset + len(raw)) % 8)) % 8
    return raw + (b" " * padding)


def pad_binary(raw: bytes) -> bytes:
    padding = (8 - (len(raw) % 8)) % 8
    return raw + (b"\x00" * padding)


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


def write_pnts_from_records(path: Path, records: np.ndarray, has_rgb: bool, rtc_center: np.ndarray) -> int:
    xyz = np.column_stack((records["x"], records["y"], records["z"])).astype(np.float64)
    rel = xyz - np.asarray(rtc_center, dtype=np.float64)
    rgb = None
    if has_rgb:
        rgb = np.column_stack((records["r"], records["g"], records["b"])).astype(np.uint8)
    return write_pnts_atomic(path, rel, rgb, np.asarray(rtc_center, dtype=np.float64))


# ─── Ordinal ownership sidecar (audit trail for the final emitted PNTS) ─


def ordinal_sidecar_path(pnts_path: Path) -> Path:
    return pnts_path.with_name(pnts_path.name + ".ord.u64")


def write_ordinal_sidecar_atomic(path: Path, ordinals: np.ndarray) -> None:
    arr = np.asarray(ordinals, dtype="<u8")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fp:
            fp.write(arr.tobytes(order="C"))
        os.replace(tmp, path)
        os.chmod(path, 0o644)
    except OSError as exc:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise SystemExit(f"Cannot write {path}: {exc}") from exc


def read_ordinal_sidecar(path: Path) -> np.ndarray:
    if not path.exists():
        return np.empty(0, dtype="<u8")
    return np.fromfile(path, dtype="<u8")


def iter_ordinal_sidecar_batches(
    path: Path, batch_points: int = FRAGMENT_BATCH_POINTS,
) -> Iterable[np.ndarray]:
    if not path.exists():
        return
    size = path.stat().st_size
    if size % ORDINAL_SIDECAR_BYTES != 0:
        raise SystemExit(f"Corrupt ordinal sidecar: {path}")
    total = size // ORDINAL_SIDECAR_BYTES
    if total == 0:
        return
    mm = np.memmap(path, dtype="<u8", mode="r", shape=(total,))
    for start in range(0, total, batch_points):
        yield mm[start : start + batch_points]


def z0_input_fragment_paths(fragments_root: Path, z0_id: str, filename: str) -> list[Path]:
    """Return immutable source shards for one z0 in source-chunk order.

    The legacy direct path is accepted only so pristine synthetic tests and
    pre-v2 initialized outputs can be migrated without changing point content.
    Production streaming writes under ``.chunks/<chunk>/<z0>/``.
    """
    paths = sorted((fragments_root / CHUNK_SHARDS_DIR).glob(f"*/{z0_id}/{filename}"))
    legacy = fragments_root / z0_id / filename
    if legacy.exists():
        paths.append(legacy)
    return paths


def concatenate_fragment_files(paths: list[Path], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with open(destination, "wb") as out:
        for source in paths:
            with open(source, "rb") as inp:
                shutil.copyfileobj(inp, out, length=8 * 1024 * 1024)


def read_fragment_files(paths: list[Path], has_rgb: bool) -> np.ndarray:
    batches = [
        np.array(batch)
        for path in paths
        for batch in iter_fragment_batches(path, has_rgb)
    ]
    if not batches:
        return np.empty(0, dtype=fragment_dtype(has_rgb))
    return np.concatenate(batches)


def delete_z0_input_shards(fragments_root: Path, z0_id: str) -> None:
    for chunk_dir in (fragments_root / CHUNK_SHARDS_DIR).glob("*"):
        target = chunk_dir / z0_id
        if target.exists():
            shutil.rmtree(target)
    legacy = fragments_root / z0_id
    if legacy.exists():
        shutil.rmtree(legacy)


# ─── Residual adaptive quadtree builder (per z0) ─────────────────────────
#
# The COPC streaming pass (below) accumulates every adaptive-eligible point of
# a selected z0 into one "root" fragment (``root.raw``) plus a separate p001
# fragment. This section consumes ``root.raw`` and grows the quadtree purely
# from disk-backed fragments — no full-z0 in-RAM materialization. Each
# internal node is resolved in three sequential reads of its own fragment:
#
#   Pass 1 — microcell occupancy counts only (O(1) memory: <= grid*grid cells).
#   Pass 2 — per-point stable hash; a bounded max-heap per microcell (size
#            capped at that microcell's quota) keeps only the ordinals of the
#            quota-smallest hashes (O(internal-target-points) memory total).
#   Pass 3 — partition every record by ordinal membership in the Pass-2
#            selection: node's own content, or routed by quadrant into one of
#            up to four child fragments.
#
# Leaves (count <= leaf-max-points, or count <= hard-max-points at max depth)
# skip sampling entirely: their content is bounded by policy, so it is safe to
# read in full.


def fragment_filename(depth: int, path: tuple[int, ...]) -> str:
    return f"d{depth}_q{node_path_str(path)}.raw"


def pnts_filename(depth: int, path: tuple[int, ...]) -> str:
    return f"d{depth}_q{node_path_str(path)}.pnts"


def append_fragment_records(path: Path, records: np.ndarray, has_rgb: bool) -> None:
    if records.size == 0:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "ab") as fp:
        fp.write(np.ascontiguousarray(records).tobytes(order="C"))


def content_bounds_from_records(records: np.ndarray) -> tuple[float, float, float, float, float, float]:
    return (
        float(records["x"].min()), float(records["y"].min()), float(records["z"].min()),
        float(records["x"].max()), float(records["y"].max()), float(records["z"].max()),
    )


def content_center(bounds6: tuple[float, float, float, float, float, float]) -> np.ndarray:
    minx, miny, minz, maxx, maxy, maxz = bounds6
    return np.array([(minx + maxx) / 2.0, (miny + maxy) / 2.0, (minz + maxz) / 2.0])


def leaf_content_diagnostics(
    content6: tuple[float, float, float, float, float, float], emitted_point_count: int
) -> dict[str, Any]:
    """Describe a leaf's content bounding box without inferring occupied area.

    Density intentionally uses the full XY content bbox.  A zero-area bbox is
    clamped only for division, and the clamp state is recorded so consumers do
    not mistake the resulting density for an occupied-surface measurement.
    """
    minx, miny, minz, maxx, maxy, maxz = content6
    width = maxx - minx
    height = maxy - miny
    z_span = maxz - minz
    area = width * height
    clamped_area = max(area, 1e-6)
    return {
        "extentMeters": {"width": width, "height": height, "zSpan": z_span},
        "bboxAreaSquareMeters": area,
        "bboxAreaClamped": area != clamped_area,
        "bboxDensityPointsPerSquareMeter": emitted_point_count / clamped_area,
    }


def _manifest_entry(
    z0_id: str,
    depth: int,
    path: tuple[int, ...],
    kind: str,
    count: int,
    nominal: tuple[float, float, float, float],
    content6: tuple[float, float, float, float, float, float],
    pnts_uri: str,
    acceptable_min_points: int,
    sampling_stats: dict[str, Any] | None = None,
    input_point_count: int | None = None,
    residual_routed_point_count: int | None = None,
) -> dict[str, Any]:
    is_leaf = kind != NODE_KIND_INTERNAL
    emitted_point_count = int(count)
    input_point_count = emitted_point_count if input_point_count is None else int(input_point_count)
    entry = {
        "nodeId": node_id(z0_id, depth, path),
        "z0Id": z0_id,
        "depth": depth,
        "path": node_path_str(path),
        "parent": node_id(z0_id, depth - 1, path[:-1]) if depth > 0 else None,
        "children": [],
        "kind": kind,
        # pointCount remains the legacy PNTS/content count.  The explicit
        # emittedPointCount makes disjoint ownership semantics unambiguous.
        "pointCount": emitted_point_count,
        "inputPointCount": input_point_count,
        "emittedPointCount": emitted_point_count,
        "nominalBounds": list(nominal),
        "contentBounds": list(content6),
        "pntsUri": pnts_uri,
        "underfilledReason": "sparseSpatialBranch" if (is_leaf and count < acceptable_min_points) else None,
        "samplingStats": sampling_stats,
    }
    if is_leaf:
        entry["leafDiagnostics"] = leaf_content_diagnostics(content6, emitted_point_count)
    else:
        entry["representativePointCount"] = emitted_point_count
        entry["residualRoutedPointCount"] = int(residual_routed_point_count or 0)
    return entry


def _select_representative_ordinals(
    frag_path: Path,
    has_rgb: bool,
    nominal: tuple[float, float, float, float],
    microcell_grid: int,
    quota: dict[int, int],
    salt: int,
) -> np.ndarray:
    """Pass 2: bounded per-microcell max-heap keeping the quota-smallest hashes.

    Only (hash, ordinal) pairs are retained — O(sum(quota)) memory regardless
    of how many points the fragment holds.

    KNOWN PERFORMANCE CHARACTERISTIC: the eviction loop below is a pure-Python
    per-point loop (heapq push/replace), verified correct at every scale tested
    but slow in wall-clock terms once a single node holds tens of millions of
    points (e.g. a z0 cell with heavy overlapping flight-strip coverage) — a
    real production build spent multiple minutes here per large internal node.
    Correctness (determinism, no loss/duplication, quota adherence) is fully
    covered by tests; a future pass could replace this with a vectorized
    top-k-per-group reduction if build wall-clock time becomes a bottleneck."""
    heaps: dict[int, list[tuple[int, int]]] = {}
    for batch in iter_fragment_batches(frag_path, has_rgb):
        cells = microcell_index_batch(batch["x"], batch["y"], nominal, microcell_grid)
        hashes = stable_hash_batch(batch["ordinal"], salt)
        for cell, h, o in zip(cells.tolist(), hashes.tolist(), batch["ordinal"].tolist()):
            k = quota.get(cell, 0)
            if k <= 0:
                continue
            heap = heaps.setdefault(cell, [])
            item = (-int(h), int(o))
            if len(heap) < k:
                heapq.heappush(heap, item)
            elif item > heap[0]:
                heapq.heapreplace(heap, item)
    selected = [ordinal for heap in heaps.values() for (_neg_hash, ordinal) in heap]
    return np.array(sorted(selected), dtype="<u8")


def _partition_fragment(
    frag_path: Path,
    has_rgb: bool,
    selected_ordinals: np.ndarray,
    center: tuple[float, float],
    child_paths: dict[int, Path],
) -> np.ndarray:
    """Pass 3: split a fragment into its own selected records (returned) and
    up to four child fragments (appended on disk, routed by fixed-center-cut
    quadrant)."""
    cx, cy = center
    own_batches: list[np.ndarray] = []
    for batch in iter_fragment_batches(frag_path, has_rgb):
        is_selected = np.isin(batch["ordinal"], selected_ordinals, assume_unique=True)
        if np.any(is_selected):
            own_batches.append(np.array(batch[is_selected]))
        remainder = batch[~is_selected]
        if remainder.size == 0:
            continue
        east = remainder["x"] >= cx
        north = remainder["y"] >= cy
        quadrant_masks = {
            QUAD_WEST_SOUTH: (~east) & (~north),
            QUAD_EAST_SOUTH: east & (~north),
            QUAD_WEST_NORTH: (~east) & north,
            QUAD_EAST_NORTH: east & north,
        }
        for digit, mask in quadrant_masks.items():
            subset = remainder[mask]
            if subset.size:
                append_fragment_records(child_paths[digit], subset, has_rgb)
    if own_batches:
        return np.concatenate(own_batches)
    return np.empty(0, dtype=fragment_dtype(has_rgb))


def build_z0_adaptive_tree(
    fragments_dir: Path,
    adaptive_output_dir: Path,
    z0_id: str,
    z0_bounds_enu: tuple[float, float, float, float],
    has_rgb: bool,
    cli_profile: dict[str, Any],
    salt: int,
) -> list[dict[str, Any]]:
    """Consume ``fragments_dir/root.raw`` and emit the residual adaptive
    quadtree for one z0 tile: PNTS + ordinal sidecar per node, plus a manifest
    entry per node. Returns the manifest entries (parent-before-children order
    is not guaranteed; consumers should index by nodeId)."""
    max_depth = cli_profile["maxDepth"]
    leaf_max_points = cli_profile["leafMaxPoints"]
    hard_max_points = cli_profile["hardMaxPoints"]
    internal_target_points = cli_profile["internalTargetPoints"]
    acceptable_min_points = cli_profile["acceptableMinPoints"]
    microcell_grid = cli_profile["microcellGrid"]

    manifest: list[dict[str, Any]] = []
    manifest_by_id: dict[str, dict[str, Any]] = {}
    root_fragment = fragments_dir / "root.raw"
    queue: list[tuple[int, tuple[int, ...], Path]] = [(0, (), root_fragment)]
    tree_started_at = time.monotonic()
    processed_nodes = 0

    while queue:
        depth, path, frag_path = queue.pop(0)
        count = fragment_record_count(frag_path, has_rgb)
        if count == 0:
            delete_fragment(frag_path)
            continue  # empty quadrant: omitted entirely, no manifest entry

        nominal = nominal_bounds_for_path(*z0_bounds_enu, path)
        kind = decide_node_kind(count, depth, max_depth, leaf_max_points, hard_max_points)
        pnts_uri = f"points/adaptive/{z0_id}/{pnts_filename(depth, path)}"
        pnts_path = adaptive_output_dir / pnts_filename(depth, path)
        current_node_id = node_id(z0_id, depth, path)
        if kind == NODE_KIND_INTERNAL:
            print(
                f"[tree {z0_id}] node={current_node_id} points={_format_point_count(count)} "
                f"kind={kind} queued={len(queue)}",
                flush=True,
            )

        if kind != NODE_KIND_INTERNAL:
            records = np.concatenate(list(iter_fragment_batches(frag_path, has_rgb)))
            content6 = content_bounds_from_records(records)
            rtc = content_center(content6)
            write_pnts_from_records(pnts_path, records, has_rgb, rtc)
            write_ordinal_sidecar_atomic(ordinal_sidecar_path(pnts_path), records["ordinal"])
            entry = _manifest_entry(
                z0_id, depth, path, kind, count, nominal, content6, pnts_uri, acceptable_min_points,
            )
            manifest.append(entry)
            manifest_by_id[entry["nodeId"]] = entry
            delete_fragment(frag_path)
            processed_nodes += 1
            if processed_nodes % 100 == 0 or not queue:
                print(
                    f"[tree {z0_id}] leaf progress nodesDone={processed_nodes} queued={len(queue)} "
                    f"last={current_node_id} elapsed={_format_duration(time.monotonic() - tree_started_at)}",
                    flush=True,
                )
            continue

        # Internal node: Pass 1 (occupancy) -> quota -> Pass 2 (selection) -> Pass 3 (partition).
        print(f"[tree {z0_id}] node={current_node_id} pass=1/3 occupancy", flush=True)
        occupied_counts: dict[int, int] = {}
        for batch in iter_fragment_batches(frag_path, has_rgb):
            cells = microcell_index_batch(batch["x"], batch["y"], nominal, microcell_grid)
            for cell, cell_count in zip(*np.unique(cells, return_counts=True)):
                occupied_counts[int(cell)] = occupied_counts.get(int(cell), 0) + int(cell_count)

        quota_total = min(internal_target_points, count)
        quota = allocate_representative_quota(occupied_counts, quota_total)
        print(f"[tree {z0_id}] node={current_node_id} pass=2/3 representative-sampling", flush=True)
        selected_ordinals = _select_representative_ordinals(
            frag_path, has_rgb, nominal, microcell_grid, quota, salt
        )

        center = nominal_center(nominal)
        child_paths = {digit: fragments_dir / fragment_filename(depth + 1, path + (digit,)) for digit in range(4)}
        print(f"[tree {z0_id}] node={current_node_id} pass=3/3 partition", flush=True)
        own_records = _partition_fragment(frag_path, has_rgb, selected_ordinals, center, child_paths)

        if own_records.shape[0] != selected_ordinals.shape[0]:
            raise SystemExit(
                f"Representative sampling mismatch at {node_id(z0_id, depth, path)}: "
                f"selected {selected_ordinals.shape[0]} ordinals but partitioned {own_records.shape[0]} records"
            )

        content6 = content_bounds_from_records(own_records)
        rtc = content_center(content6)
        write_pnts_from_records(pnts_path, own_records, has_rgb, rtc)
        write_ordinal_sidecar_atomic(ordinal_sidecar_path(pnts_path), own_records["ordinal"])

        occupied_cells = len(occupied_counts)
        represented_cells = sum(1 for c in occupied_counts if quota.get(c, 0) > 0)
        retention_ratios = [
            quota.get(c, 0) / occupied_counts[c] for c in occupied_counts if occupied_counts[c] > 0
        ]
        sampling_stats = {
            "occupiedMicrocells": occupied_cells,
            "representedMicrocells": represented_cells,
            "quotaTotal": quota_total,
            # Kept inside samplingStats for compatibility with existing
            # diagnostics, but named for the semantic quantity it records.
            "emittedPointCount": int(own_records.shape[0]),
            "representativePointCount": int(own_records.shape[0]),
            "minRetentionRatio": min(retention_ratios) if retention_ratios else 0.0,
            "maxRetentionRatio": max(retention_ratios) if retention_ratios else 0.0,
        }
        child_rows: list[tuple[int, Path, int]] = []
        for digit, child_path in child_paths.items():
            child_count = fragment_record_count(child_path, has_rgb)
            if child_count == 0:
                delete_fragment(child_path)
                continue
            child_rows.append((digit, child_path, child_count))
        residual_routed_point_count = sum(child_count for _digit, _path, child_count in child_rows)
        if count != int(own_records.shape[0]) + residual_routed_point_count:
            raise SystemExit(
                f"Ownership accounting mismatch at {current_node_id}: input={count} "
                f"emitted={own_records.shape[0]} residual={residual_routed_point_count}"
            )
        entry = _manifest_entry(
            z0_id, depth, path, kind, own_records.shape[0], nominal, content6, pnts_uri,
            acceptable_min_points, sampling_stats, input_point_count=count,
            residual_routed_point_count=residual_routed_point_count,
        )
        manifest.append(entry)
        manifest_by_id[entry["nodeId"]] = entry
        delete_fragment(frag_path)
        processed_nodes += 1

        for digit, child_path, _child_count in child_rows:
            child_id = node_id(z0_id, depth + 1, path + (digit,))
            entry["children"].append(child_id)
            queue.append((depth + 1, path + (digit,), child_path))

        print(
            f"[tree {z0_id}] emitted node={current_node_id} children={len(entry['children'])} "
            f"nodesDone={processed_nodes} queued={len(queue)} "
            f"elapsed={_format_duration(time.monotonic() - tree_started_at)}",
            flush=True,
        )

    return manifest


# ─── Census: exact per-z0 point counts, for pilot dense/sparse resolution ─


def accumulate_census_counts(
    counts: dict[str, int],
    xyz_enu: np.ndarray,
    valid: np.ndarray,
    grid_origin: tuple[float, float],
) -> dict[str, int]:
    """Bin one batch of ENU points (valid only) into their z0 tile id counts.

    Pure accumulation step so census logic is testable without real COPC
    files: production wires this to the COPC node stream, tests feed
    synthetic batches directly."""
    if not np.any(valid):
        return counts
    xs = xyz_enu[valid, 0]
    ys = xyz_enu[valid, 1]
    ix = np.floor((xs - grid_origin[0]) / Z0_CELL).astype(np.int64)
    iy = np.floor((ys - grid_origin[1]) / Z0_CELL).astype(np.int64)
    for a, b in zip(ix.tolist(), iy.tolist()):
        tid = z0_tile_id(a, b)
        counts[tid] = counts.get(tid, 0) + 1
    return counts


# ─── Pilot selection: dense/sparse resolution from census counts ────────


def resolve_dense_z0(counts: dict[str, int]) -> str:
    non_empty = {tid: c for tid, c in counts.items() if c > 0}
    if not non_empty:
        raise SystemExit("Cannot resolve pilot: census found no non-empty z0 tiles")
    return sorted(non_empty.keys(), key=lambda tid: (-non_empty[tid], tid))[0]


def resolve_sparse_z0(counts: dict[str, int], percentile: float = 25.0) -> str:
    non_empty = {tid: c for tid, c in counts.items() if c > 0}
    if not non_empty:
        raise SystemExit("Cannot resolve pilot: census found no non-empty z0 tiles")
    target = float(np.percentile(np.array(sorted(non_empty.values())), percentile))
    return sorted(non_empty.keys(), key=lambda tid: (abs(non_empty[tid] - target), tid))[0]


def resolve_pilot_selection(
    counts: dict[str, int], pilot: str, explicit_z0_ids: list[str]
) -> list[str]:
    """Explicit --z0-id always bypasses census-driven auto-selection.
    pilot="auto" -> dense + sparse (deduplicated). pilot="none" -> every
    non-empty z0 tile (full build)."""
    if explicit_z0_ids:
        return list(explicit_z0_ids)
    if pilot == "auto":
        dense = resolve_dense_z0(counts)
        sparse = resolve_sparse_z0(counts)
        return sorted({dense, sparse})
    if pilot == "none":
        return sorted(tid for tid, c in counts.items() if c > 0)
    raise SystemExit(f"Invalid --pilot: {pilot!r}")


def begin_pilot_extension(state: dict[str, Any], state_path: Path) -> dict[str, Any]:
    """Extend a completed ``--pilot auto`` build to every occupied z0.

    The completed pilot z0 artifacts remain immutable.  A separate streaming
    checkpoint is used for the missing z0s so their replay cannot alter the
    pilot accounting or accidentally append into its already-finalized shards.
    """
    existing = state.get("pilotExtension")
    if existing is not None:
        return existing
    if state.get("pilotSelectionRequest") != "auto" or state.get("requestedZ0Ids"):
        raise SystemExit("--extend-pilot requires a completed --pilot auto build without --z0-id")
    if state.get("phase") != "residual-complete":
        raise SystemExit("--extend-pilot requires a completed pilot (phase=residual-complete)")
    census = state.get("z0Census") or {}
    target = sorted(z0_id for z0_id, count in census.items() if int(count) > 0)
    completed = set(state.get("completedZ0Ids") or [])
    if not target or not completed.issubset(target):
        raise SystemExit("--extend-pilot found an invalid completed-pilot census")
    added = [z0_id for z0_id in target if z0_id not in completed]
    extension = {
        "baseSelectedZ0Ids": list(state.get("selectedZ0Ids") or []),
        "addedZ0Ids": added,
        "baseAccounting": json.loads(json.dumps(state.get("accounting") or empty_accounting())),
    }
    state["pilotExtension"] = extension
    state["selectedZ0Ids"] = target
    state["extensionStream"] = {
        "completedChunks": [], "chunkOrdinals": {}, "streamOrdinal": 0,
        "accounting": empty_accounting(),
    }
    state["phase"] = "streaming"
    write_json_atomic(state_path, state)
    return extension


def merge_pilot_extension_accounting(state: dict[str, Any]) -> dict[str, Any]:
    """Combine immutable pilot accounting with the missing-z0 replay."""
    extension = state["pilotExtension"]
    combined = merge_accounting(
        json.loads(json.dumps(extension["baseAccounting"])),
        state["extensionStream"]["accounting"],
    )
    census = state.get("z0Census") or {}
    selected_valid = sum(int(census.get(z0_id, 0)) for z0_id in state["selectedZ0Ids"])
    census_accounting = state.get("censusAccounting") or {}
    visited = int(census_accounting.get("sourcePointsVisited", state["totalSourcePoints"]))
    invalid = int(census_accounting.get("invalidPoints", 0))
    combined["sourcePointsVisited"] = visited
    combined["invalidPoints"] = invalid
    combined["outsideSelectedZ0"] = visited - invalid - selected_valid
    return combined


# ─── COPC traversal helpers (independent duplicates of Spatial LOD's) ────


def color_to_u8(values: np.ndarray, color_scale: float = COLOR_SCALE_DEFAULT) -> np.ndarray:
    """Scale LAS RGB (uint16) to uint8 like the existing converter."""
    scaled = np.asarray(values, dtype=np.float64) / float(color_scale)
    return np.clip(scaled, 0, 255).astype(np.uint8)


def nodes_by_key_key(key: Any) -> tuple[int, int, int, int]:
    return (int(key.level), int(key.x), int(key.y), int(key.z))


_Z0_ID_PARSE = re.compile(r"^z0_x(-?\d+)_y(-?\d+)$")


def parse_z0_tile_id(tile_id: str) -> tuple[int, int]:
    m = _Z0_ID_PARSE.match(tile_id)
    if not m:
        raise SystemExit(f"Malformed z0 tile id: {tile_id!r}")
    return int(m.group(1)), int(m.group(2))


# ─── Accounting ───────────────────────────────────────────────────────


def empty_accounting() -> dict[str, Any]:
    return {
        "sourcePointsVisited": 0,
        "invalidPoints": 0,
        "outsideSelectedZ0": 0,
        "perZ0": {},  # z0_id -> {"p001Points": int, "adaptivePoints": int}
    }


def merge_accounting(acc: dict[str, Any], delta: dict[str, Any]) -> dict[str, Any]:
    acc["sourcePointsVisited"] += delta["sourcePointsVisited"]
    acc["invalidPoints"] += delta["invalidPoints"]
    acc["outsideSelectedZ0"] += delta["outsideSelectedZ0"]
    for z0_id, counts in delta["perZ0"].items():
        bucket = acc["perZ0"].setdefault(z0_id, {"p001Points": 0, "adaptivePoints": 0})
        bucket["p001Points"] += counts["p001Points"]
        bucket["adaptivePoints"] += counts["adaptivePoints"]
    return acc


def accounting_totals(acc: dict[str, Any]) -> dict[str, int]:
    p001_total = sum(b["p001Points"] for b in acc["perZ0"].values())
    adaptive_total = sum(b["adaptivePoints"] for b in acc["perZ0"].values())
    return {
        "sourcePointsVisited": acc["sourcePointsVisited"],
        "invalidPoints": acc["invalidPoints"],
        "outsideSelectedZ0": acc["outsideSelectedZ0"],
        "eligibleSelectedZ0": p001_total + adaptive_total,
        "p001Points": p001_total,
        "adaptivePoints": adaptive_total,
    }


# ─── Point routing (pure, testable without COPC) ─────────────────────────


def route_batch_for_build(
    ordinal_start: int,
    xyz_enu: np.ndarray,
    rgb: np.ndarray | None,
    valid: np.ndarray,
    selected_z0_ids: set[str],
    grid_origin: tuple[float, float],
    fragments_root: Path,
    has_rgb: bool,
) -> dict[str, Any]:
    """Route one COPC-node batch of points into per-z0 p001 / adaptive-root
    fragments. ordinal % 1000 == 0 -> that z0's p001 bucket; otherwise ->
    that z0's adaptive root fragment. Points outside every selected z0, or
    invalid (non-finite ENU coordinates), still advance the ordinal (via
    ordinal_start + batch size in the caller) but produce no content."""
    n = int(xyz_enu.shape[0])
    ordinals = ordinal_start + np.arange(n, dtype=np.uint64)
    delta: dict[str, Any] = {
        "sourcePointsVisited": n,
        "invalidPoints": int(n - int(np.count_nonzero(valid))),
        "outsideSelectedZ0": 0,
        "perZ0": {},
    }
    if n == 0 or not np.any(valid):
        return delta

    vx = xyz_enu[valid]
    vord = ordinals[valid]
    vrgb = rgb[valid] if (has_rgb and rgb is not None) else None

    ix = np.floor((vx[:, 0] - grid_origin[0]) / Z0_CELL).astype(np.int64)
    iy = np.floor((vx[:, 1] - grid_origin[1]) / Z0_CELL).astype(np.int64)
    tile_ids = np.array([z0_tile_id(int(a), int(b)) for a, b in zip(ix.tolist(), iy.tolist())])

    in_selection = np.isin(tile_ids, np.array(sorted(selected_z0_ids)) if selected_z0_ids else np.array([]))
    delta["outsideSelectedZ0"] = int(np.count_nonzero(~in_selection))
    if not np.any(in_selection):
        return delta

    sel_tiles = tile_ids[in_selection]
    sel_xyz = vx[in_selection]
    sel_ord = vord[in_selection]
    sel_rgb = vrgb[in_selection] if vrgb is not None else None
    is_p001 = (sel_ord % np.uint64(1000)) == 0

    for tid in sorted(set(sel_tiles.tolist())):
        tile_mask = sel_tiles == tid
        p001_mask = tile_mask & is_p001
        adaptive_mask = tile_mask & ~is_p001
        bucket = delta["perZ0"].setdefault(tid, {"p001Points": 0, "adaptivePoints": 0})
        if np.any(p001_mask):
            append_fragment(
                fragments_root / tid / "p001.raw",
                sel_xyz[p001_mask],
                sel_rgb[p001_mask] if sel_rgb is not None else None,
                sel_ord[p001_mask],
                has_rgb,
            )
            bucket["p001Points"] += int(np.count_nonzero(p001_mask))
        if np.any(adaptive_mask):
            append_fragment(
                fragments_root / tid / "root.raw",
                sel_xyz[adaptive_mask],
                sel_rgb[adaptive_mask] if sel_rgb is not None else None,
                sel_ord[adaptive_mask],
                has_rgb,
            )
            bucket["adaptivePoints"] += int(np.count_nonzero(adaptive_mask))
    return delta


# ─── COPC streaming (real I/O; thin wrappers around the pure routing above) ─


def enu_bbox_intersects(
    enu_min: np.ndarray, enu_max: np.ndarray, bounds: tuple[float, float, float, float]
) -> bool:
    """Axis-aligned XY intersection between an ENU bbox and a target bounds box
    (independent duplicate of Spatial LOD's helper of the same name)."""
    return not (
        enu_max[0] < bounds[0] or enu_min[0] > bounds[2]
        or enu_max[1] < bounds[1] or enu_min[1] > bounds[3]
    )


def enu_bbox_intersects_any(
    enu_min: np.ndarray, enu_max: np.ndarray, bounds_list: list[tuple[float, float, float, float]]
) -> bool:
    return any(enu_bbox_intersects(enu_min, enu_max, b) for b in bounds_list)


def selected_z0_bounds_list(
    selected_z0_ids: set[str], grid_origin: tuple[float, float]
) -> list[tuple[float, float, float, float]]:
    bounds_list = []
    for tid in selected_z0_ids:
        ix, iy = parse_z0_tile_id(tid)
        bounds_list.append(z0_bounds(ix, iy, grid_origin[0], grid_origin[1]))
    return bounds_list


def run_census(
    files: list[Path],
    frame: dict[str, Any],
    grid_origin: tuple[float, float],
    total_source_points: int = 0,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Full-dataset pass with exact valid/invalid and per-z0 counts.

    Census itself is intentionally restart-only, but terminal progress is
    emitted at chunk boundaries and at least every progress interval while a
    large chunk is being decoded. The optional callback persists coarse
    chunk-level telemetry without turning partial census counts into a resume
    checkpoint.
    """
    from laspy._compression.selection import DecompressionSelection
    from laspy.copc import CopcReader, load_octree_for_query

    counts: dict[str, int] = {}
    source_points_visited = 0
    invalid_points = 0
    started_at = time.monotonic()
    last_progress_at = started_at
    total_chunks = len(files)
    print(
        f"=== Phase 1/3: census ({total_chunks} chunks, "
        f"{_format_point_count(total_source_points)} points) ===",
        flush=True,
    )
    selection = DecompressionSelection.XY_RETURNS_CHANNEL | DecompressionSelection.Z
    for chunk_index, path in enumerate(files, start=1):
        print(f"[census {chunk_index}/{total_chunks}] start {path.name}", flush=True)
        with CopcReader.open(path, decompression_selection=selection) as reader:
            nodes = load_octree_for_query(reader.source, reader.copc_info, reader.root_page)
            sorted_nodes = sorted(nodes, key=lambda nd: nodes_by_key_key(nd.key))
            for node_index, node in enumerate(sorted_nodes, start=1):
                if int(node.point_count) <= 0:
                    continue
                points = reader._fetch_and_decompress_points_of_nodes([node])
                xyz_source = np.column_stack(
                    (np.asarray(points.x), np.asarray(points.y), np.asarray(points.z))
                ).astype(np.float64)
                xyz_enu = source_points_to_enu(xyz_source, frame)
                valid = np.isfinite(xyz_enu).all(axis=1)
                actual = int(xyz_enu.shape[0])
                if actual != int(node.point_count):
                    raise SystemExit(
                        f"COPC census decode count mismatch in {path.name}: "
                        f"decoded {actual}, hierarchy says {int(node.point_count)}"
                    )
                source_points_visited += actual
                invalid_points += int(actual - np.count_nonzero(valid))
                counts = accumulate_census_counts(counts, xyz_enu, valid, grid_origin)
                now = time.monotonic()
                if now - last_progress_at >= PROGRESS_INTERVAL_SECONDS:
                    _emit_pipeline_progress(
                        "census", chunk_index, total_chunks, path.name,
                        source_points_visited, total_source_points, started_at,
                        detail=f"node={node_index}/{len(sorted_nodes)}",
                    )
                    last_progress_at = now

        _emit_pipeline_progress(
            "census", chunk_index, total_chunks, path.name,
            source_points_visited, total_source_points, started_at,
            detail="checkpoint=chunk-complete",
        )
        last_progress_at = time.monotonic()
        if progress_callback is not None:
            progress_callback(
                {
                    "completedChunks": chunk_index,
                    "totalChunks": total_chunks,
                    "currentChunk": path.name,
                    "sourcePointsVisited": source_points_visited,
                    "totalSourcePoints": int(total_source_points),
                    "percent": (
                        100.0 * source_points_visited / total_source_points
                        if total_source_points > 0 else 0.0
                    ),
                    "elapsedSeconds": time.monotonic() - started_at,
                    "restartableOnly": True,
                }
            )
    print(
        f"=== Census complete: {_format_point_count(source_points_visited)} points, "
        f"z0 tiles={len(counts)}, elapsed={_format_duration(time.monotonic() - started_at)} ===",
        flush=True,
    )
    return {
        "counts": counts,
        "sourcePointsVisited": source_points_visited,
        "invalidPoints": invalid_points,
    }


def stream_copc_for_build(
    files: list[Path],
    frame: dict[str, Any],
    grid_origin: tuple[float, float],
    selected_z0_ids: set[str],
    has_rgb: bool,
    fragments_root: Path,
    state: dict[str, Any],
    state_path: Path,
    allow_bbox_pruning: bool = False,
    checkpoint_key: str | None = None,
) -> dict[str, Any]:
    """Stream every COPC chunk/node in the same global order Spatial LOD uses,
    routing selected-z0 points into fragments. Resumable: checkpoints
    completed chunks + running ordinal + accounting into state after each
    chunk.

    Chunks/nodes whose ENU bbox does not intersect any selected z0 cell are
    skipped without decompressing their points (same convention Spatial LOD
    uses for pilot-bounds pruning): the ordinal still advances by the full
    skipped point count, and those points are tallied as outsideSelectedZ0."""
    from laspy._compression.selection import DecompressionSelection
    from laspy.copc import CopcReader, load_octree_for_query

    checkpoint = state if checkpoint_key is None else state.setdefault(checkpoint_key, {})
    accounting = checkpoint.get("accounting") or empty_accounting()
    completed_chunks = set(checkpoint.get("completedChunks", []))
    ordinal = int(checkpoint.get("streamOrdinal", 0))
    total_source_points = int(state.get("totalSourcePoints", 0))
    started_at = time.monotonic()
    started_points = ordinal
    last_progress_at = started_at
    total_chunks = len(files)
    target_bounds = selected_z0_bounds_list(selected_z0_ids, grid_origin)
    chunk_shards_root = fragments_root / CHUNK_SHARDS_DIR
    chunk_shards_root.mkdir(parents=True, exist_ok=True)

    selection = DecompressionSelection.XY_RETURNS_CHANNEL | DecompressionSelection.Z
    if has_rgb:
        selection |= DecompressionSelection.RGB

    print(
        f"=== Phase 2/3: stream selected z0 ({len(completed_chunks)}/{total_chunks} chunks resumed, "
        f"selected={sorted(selected_z0_ids)}) ===",
        flush=True,
    )
    for chunk_index, path in enumerate(files, start=1):
        chunk_id = path.stem
        if chunk_id in completed_chunks:
            if not (chunk_shards_root / chunk_id).is_dir():
                raise SystemExit(f"Completed chunk shard is missing: {chunk_id}")
            ordinal = int(checkpoint.get("chunkOrdinals", {}).get(chunk_id, ordinal))
            continue

        print(f"[stream {chunk_index}/{total_chunks}] start {path.name}", flush=True)

        # A chunk is written into its own temporary shard. If the previous run
        # died before checkpointing, both its temp shard and any uncheckpointed
        # promoted shard are discarded before replay, so append cannot duplicate
        # records already owned by earlier completed chunks.
        chunk_final = chunk_shards_root / chunk_id
        chunk_temp = chunk_shards_root / f".{chunk_id}.tmp"
        if chunk_temp.exists():
            shutil.rmtree(chunk_temp)
        if chunk_final.exists():
            shutil.rmtree(chunk_final)
        chunk_temp.mkdir(parents=True)

        with CopcReader.open(path, decompression_selection=selection) as reader:
            header = reader.header
            chunk_point_count = int(header.point_count)
            chunk_mins = np.asarray(header.mins, dtype=np.float64)
            chunk_maxs = np.asarray(header.maxs, dtype=np.float64)
            cenu_min, cenu_max = transform_bounds_to_enu(chunk_mins, chunk_maxs, frame)
            if allow_bbox_pruning and not enu_bbox_intersects_any(cenu_min, cenu_max, target_bounds):
                ordinal += chunk_point_count
                accounting = merge_accounting(
                    accounting,
                    {"sourcePointsVisited": chunk_point_count, "invalidPoints": 0,
                     "outsideSelectedZ0": chunk_point_count, "perZ0": {}},
                )
            else:
                nodes = load_octree_for_query(reader.source, reader.copc_info, reader.root_page)
                sorted_nodes = sorted(nodes, key=lambda nd: nodes_by_key_key(nd.key))
                for node_index, node in enumerate(sorted_nodes, start=1):
                    node_pts = int(node.point_count)
                    if node_pts <= 0:
                        continue
                    n_mins = np.asarray(node.bounds.mins, dtype=np.float64)
                    n_maxs = np.asarray(node.bounds.maxs, dtype=np.float64)
                    nenu_min, nenu_max = transform_bounds_to_enu(n_mins, n_maxs, frame)
                    if allow_bbox_pruning and not enu_bbox_intersects_any(nenu_min, nenu_max, target_bounds):
                        ordinal += node_pts
                        accounting = merge_accounting(
                            accounting,
                            {"sourcePointsVisited": node_pts, "invalidPoints": 0,
                             "outsideSelectedZ0": node_pts, "perZ0": {}},
                        )
                        now = time.monotonic()
                        if now - last_progress_at >= PROGRESS_INTERVAL_SECONDS:
                            _emit_pipeline_progress(
                                "stream", chunk_index, total_chunks, path.name,
                                ordinal, total_source_points, started_at, started_points,
                                detail=f"node={node_index}/{len(sorted_nodes)} pruned",
                            )
                            last_progress_at = now
                        continue
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
                    if int(xyz_enu.shape[0]) != node_pts:
                        raise SystemExit(
                            f"COPC decode count mismatch in {path.name}: "
                            f"decoded {xyz_enu.shape[0]}, hierarchy says {node_pts}"
                        )
                    valid = np.isfinite(xyz_enu).all(axis=1)
                    delta = route_batch_for_build(
                        ordinal, xyz_enu, rgb, valid, selected_z0_ids, grid_origin, chunk_temp, has_rgb
                    )
                    accounting = merge_accounting(accounting, delta)
                    ordinal += node_pts
                    now = time.monotonic()
                    if now - last_progress_at >= PROGRESS_INTERVAL_SECONDS:
                        _emit_pipeline_progress(
                            "stream", chunk_index, total_chunks, path.name,
                            ordinal, total_source_points, started_at, started_points,
                            detail=f"node={node_index}/{len(sorted_nodes)}",
                        )
                        last_progress_at = now
        os.replace(chunk_temp, chunk_final)
        checkpoint.setdefault("chunkOrdinals", {})[chunk_id] = ordinal
        checkpoint.setdefault("completedChunks", []).append(chunk_id)
        checkpoint["streamOrdinal"] = ordinal
        checkpoint["accounting"] = accounting
        checkpoint["streamProgress"] = {
            "completedChunks": len(checkpoint["completedChunks"]),
            "totalChunks": total_chunks,
            "currentChunk": path.name,
            "sourcePointsVisited": ordinal,
            "totalSourcePoints": total_source_points,
            "percent": 100.0 * ordinal / total_source_points if total_source_points > 0 else 0.0,
            "elapsedSecondsThisRun": time.monotonic() - started_at,
        }
        write_json_atomic(state_path, state)
        _emit_pipeline_progress(
            "stream", chunk_index, total_chunks, path.name,
            ordinal, total_source_points, started_at, started_points,
            detail="checkpoint=durable",
        )
        last_progress_at = time.monotonic()

    print(
        f"=== Streaming complete: {_format_point_count(ordinal)} source ordinals, "
        f"elapsed this run={_format_duration(time.monotonic() - started_at)} ===",
        flush=True,
    )
    return accounting


# ─── Per-z0 finalize: p001 + adaptive tree + ownership audit ─────────────


_EXPECTED_P001 = np.uint8(1)
_EXPECTED_ADAPTIVE = np.uint8(2)
_EMITTED_P001 = np.uint8(4)
_EMITTED_ADAPTIVE = np.uint8(8)
_EXPECTED_MASK = np.uint8(3)
_EMITTED_MASK = np.uint8(12)


def audit_z0_ownership(
    output_dir: Path,
    z0_id: str,
    manifest: list[dict[str, Any]],
    expected_p001_fragments: list[Path],
    expected_adaptive_fragments: list[Path],
    has_rgb: bool,
    total_source_points: int,
    expected_p001: int,
    expected_adaptive: int,
) -> dict[str, int]:
    """Verify exact ordinal ownership using a sparse disk-backed uint8 map.

    Immutable chunk fragments define the expected ordinal set. PNTS sidecars
    define the emitted set. This detects duplicates, omissions, extras,
    p001/adaptive substitution, modulo-policy violations, and out-of-range
    ordinals without concatenating a dense z0 into RAM.
    """
    if total_source_points <= 0:
        raise SystemExit("Ownership audit requires a positive total source point count")

    audit_dir = output_dir / ".aph-audit"
    audit_dir.mkdir(parents=True, exist_ok=True)
    owner_path = audit_dir / f"{z0_id}.owners.u8"
    with open(owner_path, "wb") as fp:
        fp.truncate(total_source_points)
    owners = np.memmap(owner_path, dtype=np.uint8, mode="r+", shape=(total_source_points,))

    expected_input_duplicates = 0
    expected_role_errors = 0

    def mark_expected(paths: list[Path], bit: np.uint8, p001_role: bool) -> int:
        nonlocal expected_input_duplicates, expected_role_errors
        record_count = 0
        for path in paths:
            for batch in iter_fragment_batches(path, has_rgb):
                ordinals = np.asarray(batch["ordinal"], dtype="<u8")
                record_count += int(ordinals.size)
                unique, multiplicity = np.unique(ordinals, return_counts=True)
                expected_input_duplicates += int(np.sum(multiplicity - 1))
                in_range = unique < np.uint64(total_source_points)
                expected_role_errors += int(np.count_nonzero(~in_range))
                unique = unique[in_range]
                if unique.size == 0:
                    continue
                modulo_ok = (unique % np.uint64(1000) == 0) if p001_role else (unique % np.uint64(1000) != 0)
                expected_role_errors += int(np.count_nonzero(~modulo_ok))
                prior = np.asarray(owners[unique], dtype=np.uint8)
                expected_input_duplicates += int(np.count_nonzero(prior & _EXPECTED_MASK))
                owners[unique] = prior | bit
        return record_count

    duplicates = 0
    extras = 0
    wrong_owner = 0
    emitted_role_errors = 0
    matched = 0

    def mark_emitted(paths: list[Path], expected_bit: np.uint8, emitted_bit: np.uint8, p001_role: bool) -> int:
        nonlocal duplicates, extras, wrong_owner, emitted_role_errors, matched
        record_count = 0
        for path in paths:
            for batch in iter_ordinal_sidecar_batches(path):
                ordinals = np.asarray(batch, dtype="<u8")
                record_count += int(ordinals.size)
                unique, multiplicity = np.unique(ordinals, return_counts=True)
                duplicates += int(np.sum(multiplicity - 1))
                in_range = unique < np.uint64(total_source_points)
                extras += int(np.count_nonzero(~in_range))
                unique = unique[in_range]
                if unique.size == 0:
                    continue
                modulo_ok = (unique % np.uint64(1000) == 0) if p001_role else (unique % np.uint64(1000) != 0)
                emitted_role_errors += int(np.count_nonzero(~modulo_ok))
                prior = np.asarray(owners[unique], dtype=np.uint8)
                already_emitted = (prior & _EMITTED_MASK) != 0
                duplicates += int(np.count_nonzero(already_emitted))
                expected_state = prior & _EXPECTED_MASK
                exact = expected_state == expected_bit
                extras += int(np.count_nonzero(expected_state == 0))
                wrong_owner += int(np.count_nonzero((expected_state != 0) & ~exact))
                matched += int(np.count_nonzero(exact & ~already_emitted))
                owners[unique] = prior | emitted_bit
        return record_count

    try:
        expected_p001_records = mark_expected(expected_p001_fragments, _EXPECTED_P001, True)
        expected_adaptive_records = mark_expected(expected_adaptive_fragments, _EXPECTED_ADAPTIVE, False)

        p001_pnts = output_dir / "points" / "z0" / f"{z0_id}.pnts"
        p001_sidecars = [ordinal_sidecar_path(p001_pnts)] if ordinal_sidecar_path(p001_pnts).exists() else []
        adaptive_dir = output_dir / "points" / "adaptive" / z0_id
        adaptive_sidecars = [
            ordinal_sidecar_path(adaptive_dir / entry["pntsUri"].rsplit("/", 1)[-1])
            for entry in manifest
        ]
        emitted_p001_records = mark_emitted(p001_sidecars, _EXPECTED_P001, _EMITTED_P001, True)
        emitted_adaptive_records = mark_emitted(
            adaptive_sidecars, _EXPECTED_ADAPTIVE, _EMITTED_ADAPTIVE, False,
        )
        owners.flush()

        expected_total = expected_p001_records + expected_adaptive_records
        omitted = max(0, expected_total - matched)
        count_mismatch = (
            expected_p001_records != expected_p001
            or expected_adaptive_records != expected_adaptive
        )
        if (
            count_mismatch
            or expected_input_duplicates
            or expected_role_errors
            or duplicates
            or omitted
            or extras
            or wrong_owner
            or emitted_role_errors
        ):
            raise SystemExit(
                f"Ownership audit failed for {z0_id}: duplicates={duplicates}, omitted={omitted}, "
                f"extras={extras}, wrongOwner={wrong_owner}, expectedInputDuplicates={expected_input_duplicates}, "
                f"roleErrors={expected_role_errors + emitted_role_errors}, "
                f"expectedCounts=({expected_p001},{expected_adaptive}), "
                f"fragmentCounts=({expected_p001_records},{expected_adaptive_records}), "
                f"emittedCounts=({emitted_p001_records},{emitted_adaptive_records})"
            )
        return {
            "duplicates": duplicates,
            "omittedEligiblePoints": omitted,
            "extraPoints": extras,
            "wrongOwnerPoints": wrong_owner,
            "p001Points": emitted_p001_records,
            "adaptivePoints": emitted_adaptive_records,
        }
    finally:
        del owners
        owner_path.unlink(missing_ok=True)
        try:
            audit_dir.rmdir()
        except OSError:
            pass


def finalize_one_z0(
    output_dir: Path,
    fragments_root: Path,
    z0_id: str,
    grid_origin: tuple[float, float],
    has_rgb: bool,
    cli_profile: dict[str, Any],
    salt: int,
    total_source_points: int,
    expected_p001: int,
    expected_adaptive: int,
) -> dict[str, Any]:
    finalize_started_at = time.monotonic()
    ix, iy = parse_z0_tile_id(z0_id)
    z0_bounds_enu = z0_bounds(ix, iy, grid_origin[0], grid_origin[1])
    p001_fragments = z0_input_fragment_paths(fragments_root, z0_id, "p001.raw")
    adaptive_fragments = z0_input_fragment_paths(fragments_root, z0_id, "root.raw")

    # Incomplete final output is never an input. Recreate the z0 in a disposable
    # workspace; immutable chunk shards survive until the caller checkpoints
    # completedZ0Ids, making a crash at any point safely retryable.
    finalizing_root = output_dir / FINALIZING_DIR
    stage_root = finalizing_root / f"{z0_id}.tmp"
    if stage_root.exists():
        shutil.rmtree(stage_root)
    stage_root.mkdir(parents=True)

    final_p001 = output_dir / "points" / "z0" / f"{z0_id}.pnts"
    final_p001_sidecar = ordinal_sidecar_path(final_p001)
    final_adaptive = output_dir / "points" / "adaptive" / z0_id
    final_manifest = output_dir / ".node-manifests" / f"{z0_id}.json"
    final_p001.unlink(missing_ok=True)
    final_p001_sidecar.unlink(missing_ok=True)
    final_manifest.unlink(missing_ok=True)
    if final_adaptive.exists():
        shutil.rmtree(final_adaptive)

    p001_records = read_fragment_files(p001_fragments, has_rgb)
    p001_count = int(p001_records.shape[0])
    print(
        f"[finalize {z0_id}] p001={_format_point_count(p001_count)} "
        f"adaptive={_format_point_count(expected_adaptive)}",
        flush=True,
    )
    p001_metadata = None
    stage_p001 = stage_root / "points" / "z0" / f"{z0_id}.pnts"
    if p001_count > 0:
        content6 = content_bounds_from_records(p001_records)
        rtc = content_center(content6)
        write_pnts_from_records(stage_p001, p001_records, has_rgb, rtc)
        write_ordinal_sidecar_atomic(ordinal_sidecar_path(stage_p001), p001_records["ordinal"])
        p001_metadata = {
            "pointCount": p001_count,
            "contentBounds": list(content6),
            "pntsUri": f"points/z0/{z0_id}.pnts",
        }

    work_fragments = stage_root / "work-fragments"
    concatenate_fragment_files(adaptive_fragments, work_fragments / "root.raw")
    stage_adaptive = stage_root / "points" / "adaptive" / z0_id
    stage_adaptive.mkdir(parents=True, exist_ok=True)
    print(f"[finalize {z0_id}] building residual adaptive tree", flush=True)
    manifest = build_z0_adaptive_tree(
        fragments_dir=work_fragments,
        adaptive_output_dir=stage_adaptive,
        z0_id=z0_id,
        z0_bounds_enu=z0_bounds_enu,
        has_rgb=has_rgb,
        cli_profile=cli_profile,
        salt=salt,
    )
    ownership_summary = validate_adaptive_manifest_ownership(manifest, expected_adaptive)

    print(f"[finalize {z0_id}] auditing exact ordinal ownership", flush=True)
    audit = audit_z0_ownership(
        output_dir=stage_root,
        z0_id=z0_id,
        manifest=manifest,
        expected_p001_fragments=p001_fragments,
        expected_adaptive_fragments=adaptive_fragments,
        has_rgb=has_rgb,
        total_source_points=total_source_points,
        expected_p001=expected_p001,
        expected_adaptive=expected_adaptive,
    )

    stage_manifest = stage_root / ".node-manifests" / f"{z0_id}.json"
    write_json_atomic(
        stage_manifest,
        {
            "z0Id": z0_id,
            "p001": p001_metadata,
            "adaptiveInputPointCount": ownership_summary["adaptiveInputPointCount"],
            "ownership": ownership_summary,
            "nodes": manifest,
        },
    )

    # Idempotent promotion. A crash between any two replacements is harmless:
    # state is not checkpointed yet, so the next retry clears and rebuilds all
    # final artifacts from the untouched chunk shards.
    final_adaptive.parent.mkdir(parents=True, exist_ok=True)
    os.replace(stage_adaptive, final_adaptive)
    final_manifest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(stage_manifest, final_manifest)
    if stage_p001.exists():
        final_p001.parent.mkdir(parents=True, exist_ok=True)
        os.replace(stage_p001, final_p001)
        os.replace(ordinal_sidecar_path(stage_p001), final_p001_sidecar)

    print(
        f"[finalize {z0_id}] promoted nodes={len(manifest)} "
        f"elapsed={_format_duration(time.monotonic() - finalize_started_at)}",
        flush=True,
    )

    shutil.rmtree(stage_root, ignore_errors=True)
    try:
        finalizing_root.rmdir()
    except OSError:
        pass

    return {
        "z0Id": z0_id,
        "p001Count": int(p001_count),
        "adaptiveNodeCount": len(manifest),
        "duplicates": audit["duplicates"],
        "omittedEligiblePoints": audit["omittedEligiblePoints"],
        "extraPoints": audit["extraPoints"],
        "wrongOwnerPoints": audit["wrongOwnerPoints"],
        "adaptiveOwnership": ownership_summary,
    }


def compute_leaf_stats(
    leaf_counts: list[int], acceptable_min_points: int, leaf_max_points: int
) -> dict[str, Any]:
    if not leaf_counts:
        return {"p50": 0.0, "p95": 0.0, "max": 0, "bandFraction": 0.0, "leafCount": 0}
    arr = np.array(sorted(leaf_counts), dtype=np.float64)
    in_band = arr[(arr >= acceptable_min_points) & (arr <= leaf_max_points)]
    return {
        "p50": float(np.percentile(arr, 50)),
        "p95": float(np.percentile(arr, 95)),
        "max": float(arr.max()),
        "bandFraction": float(in_band.shape[0] / arr.shape[0]),
        "leafCount": int(arr.shape[0]),
    }


def validate_adaptive_manifest_ownership(
    manifest: list[dict[str, Any]], expected_root_input_point_count: int
) -> dict[str, int]:
    """Enforce disjoint ownership accounting recorded in an adaptive manifest."""
    by_id = {str(node["nodeId"]): node for node in manifest}
    roots = [node for node in manifest if node.get("parent") is None]
    if len(roots) != 1:
        raise SystemExit(f"Adaptive ownership invariant failed: expected one root, found {len(roots)}")
    for node in manifest:
        emitted = int(node.get("emittedPointCount", node["pointCount"]))
        input_count = int(node.get("inputPointCount", emitted))
        if node["kind"] == NODE_KIND_INTERNAL:
            residual = int(node.get("residualRoutedPointCount", 0))
            child_input = sum(int(by_id[child].get("inputPointCount", by_id[child]["pointCount"]))
                              for child in node.get("children", []))
            if input_count != emitted + residual or residual != child_input:
                raise SystemExit(
                    f"Adaptive ownership invariant failed at {node['nodeId']}: "
                    f"input={input_count} emitted={emitted} residual={residual} children={child_input}"
                )
        elif input_count != emitted:
            raise SystemExit(
                f"Adaptive leaf ownership invariant failed at {node['nodeId']}: "
                f"input={input_count} emitted={emitted}"
            )
    root_input = int(roots[0].get("inputPointCount", roots[0]["pointCount"]))
    total_emitted = sum(int(node.get("emittedPointCount", node["pointCount"])) for node in manifest)
    if root_input != expected_root_input_point_count or total_emitted != expected_root_input_point_count:
        raise SystemExit(
            "Adaptive z0 ownership invariant failed: "
            f"rootInput={root_input} emittedTotal={total_emitted} expected={expected_root_input_point_count}"
        )
    return {
        "adaptiveInputPointCount": root_input,
        "emittedPointCount": total_emitted,
        "duplicateOrOmittedPointCount": 0,
    }


def _distribution_summary(values: list[float]) -> dict[str, Any]:
    if not values:
        return {
            "available": False, "count": 0, "total": 0.0, "min": None, "max": None,
            "avg": None, "p50": None, "p95": None,
        }
    arr = np.array(values, dtype=np.float64)
    return {
        "available": True,
        "count": int(arr.size),
        "total": float(arr.sum()),
        "min": float(arr.min()),
        "max": float(arr.max()),
        "avg": float(arr.mean()),
        # NumPy's default is linear interpolation.  Keeping that explicit in
        # the report contract avoids a weighted-by-points interpretation.
        "p50": float(np.percentile(arr, 50, method="linear")),
        "p95": float(np.percentile(arr, 95, method="linear")),
    }


def compute_leaf_diagnostics(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarize emitted ownership and leaf bbox diagnostics by depth.

    Every percentile is computed over leaves, not weighted by their point
    counts.  Empty groups are explicitly unavailable rather than zero-valued.
    """
    groups: dict[str, list[dict[str, Any]]] = {"global": [n for n in nodes if n["kind"] != NODE_KIND_INTERNAL]}
    for node in nodes:
        if node["kind"] != NODE_KIND_INTERNAL:
            groups.setdefault(f"d{int(node['depth'])}", []).append(node)

    def summarize(leaves: list[dict[str, Any]]) -> dict[str, Any]:
        emitted = [float(n.get("emittedPointCount", n["pointCount"])) for n in leaves]
        widths = [float(n.get("leafDiagnostics", {}).get("extentMeters", {}).get("width", 0.0)) for n in leaves]
        heights = [float(n.get("leafDiagnostics", {}).get("extentMeters", {}).get("height", 0.0)) for n in leaves]
        z_spans = [float(n.get("leafDiagnostics", {}).get("extentMeters", {}).get("zSpan", 0.0)) for n in leaves]
        densities = [float(n.get("leafDiagnostics", {}).get("bboxDensityPointsPerSquareMeter", 0.0)) for n in leaves]
        return {
            "emittedPoints": _distribution_summary(emitted),
            "underfilledCount": sum(1 for n in leaves if n.get("underfilledReason") is not None),
            "bboxAreaClampedCount": sum(1 for n in leaves if n.get("leafDiagnostics", {}).get("bboxAreaClamped") is True),
            "extentMeters": {"width": _distribution_summary(widths), "height": _distribution_summary(heights), "zSpan": _distribution_summary(z_spans)},
            "bboxDensityPointsPerSquareMeter": _distribution_summary(densities),
        }

    ownership_by_depth: dict[str, dict[str, int]] = {}
    for node in nodes:
        depth = f"d{int(node['depth'])}"
        bucket = ownership_by_depth.setdefault(depth, {
            "emittedPointCount": 0, "internalRepresentativePointCount": 0,
            "residualRoutedPointCount": 0, "leafResidualRoutedPointCount": 0,
        })
        emitted = int(node.get("emittedPointCount", node["pointCount"]))
        bucket["emittedPointCount"] += emitted
        if node["kind"] == NODE_KIND_INTERNAL:
            bucket["internalRepresentativePointCount"] += int(node.get("representativePointCount", emitted))
            bucket["residualRoutedPointCount"] += int(node.get("residualRoutedPointCount", 0))

    ownership_composition = {
        "emittedPointCount": sum(bucket["emittedPointCount"] for bucket in ownership_by_depth.values()),
        "internalRepresentativePointCount": sum(bucket["internalRepresentativePointCount"] for bucket in ownership_by_depth.values()),
        "residualRoutedPointCount": sum(bucket["residualRoutedPointCount"] for bucket in ownership_by_depth.values()),
        "leafResidualRoutedPointCount": 0,
    }

    return {
        "percentileMethod": "numpy-linear-per-leaf-unweighted",
        "global": summarize(groups["global"]),
        "perDepth": {depth: summarize(leaves) for depth, leaves in sorted(groups.items()) if depth != "global"},
        "ownershipComposition": ownership_composition,
        "ownershipCompositionByDepth": ownership_by_depth,
    }


# ─── Top-level orchestrator ─────────────────────────────────────────────


def build_adaptive_point_hierarchy_foundation(
    root_dir: Path,
    dataset: str,
    public_root: str = "",
    internal_target_points: int = DEFAULT_INTERNAL_TARGET_POINTS,
    acceptable_min_points: int = DEFAULT_ACCEPTABLE_MIN_POINTS,
    leaf_max_points: int = DEFAULT_LEAF_MAX_POINTS,
    hard_max_points: int = DEFAULT_HARD_MAX_POINTS,
    max_depth: int = DEFAULT_MAX_DEPTH,
    error_scale: float = DEFAULT_ERROR_SCALE,
    microcell_grid: int = DEFAULT_MICROCELL_GRID,
    vrv_mode: str = "both",
    pilot: str = "auto",
    z0_ids: list[str] | None = None,
    resume: bool = False,
    overwrite: bool = False,
    allow_low_disk: bool = False,
) -> dict[str, Any]:
    dataset = validate_name(dataset, "dataset")
    public_root = validate_name(public_root, "public-root") if public_root else ""
    logical = public_root or dataset
    name = f"{logical}-adaptive-point-hierarchy"

    if resume and overwrite:
        raise SystemExit("--resume and --overwrite are mutually exclusive")

    validate_thresholds(acceptable_min_points, internal_target_points, leaf_max_points, hard_max_points)
    if max_depth < 1:
        raise SystemExit("--max-depth must be >= 1")
    if not math.isfinite(error_scale) or error_scale <= 0:
        raise SystemExit("--error-scale must be finite and > 0")
    if microcell_grid < 1:
        raise SystemExit("--microcell-grid must be >= 1")
    if vrv_mode not in VRV_MODES:
        raise SystemExit(f"Invalid --vrv-mode: {vrv_mode!r}")
    if pilot not in PILOT_MODES:
        raise SystemExit(f"Invalid --pilot: {pilot!r}")
    z0_ids = validate_z0_ids(list(z0_ids or []))

    intermediate_root = (root_dir / "local-storage" / "intermediate").resolve()
    tilesets_root = (root_dir / "local-storage" / "tilesets").resolve()
    input_dir = (intermediate_root / dataset / "chunks-copc").resolve()
    if not input_dir.exists():
        raise SystemExit(f"COPC chunks not found: {input_dir}")
    assert_inside(input_dir, intermediate_root, "input dir")

    logical_dir = tilesets_root / logical
    output_dir = (logical_dir / name).resolve()
    assert_inside(output_dir, tilesets_root, "output dir")

    output_exists = output_dir.exists()
    if output_exists and not (resume or overwrite):
        raise SystemExit(f"Output exists. Pass --overwrite or --resume: {output_dir}")
    if resume and not output_exists:
        raise SystemExit(f"Cannot resume: output does not exist at {output_dir}")

    state_path = output_dir / STATE_NAME
    report_path = output_dir / REPORT_NAME

    cli_profile = {
        "internalTargetPoints": internal_target_points,
        "acceptableMinPoints": acceptable_min_points,
        "leafMaxPoints": leaf_max_points,
        "hardMaxPoints": hard_max_points,
        "maxDepth": max_depth,
        "errorScale": error_scale,
        "microcellGrid": microcell_grid,
        "vrvMode": vrv_mode,
    }

    pre = preflight(input_dir)
    files = pre["files"]
    has_rgb = pre["has_rgb"]
    source_mins = pre["source_mins"]
    source_maxs = pre["source_maxs"]
    total_points = pre["total_points"]

    enu_origin_source = (source_mins + source_maxs) / 2.0
    frame = build_enu_frame(_crs_from_wkt(pre["crs_wkt"]), enu_origin_source)
    enu_min, _enu_max = transform_bounds_to_enu(source_mins, source_maxs, frame)
    grid_origin = snap_grid_origin(float(enu_min[0]), float(enu_min[1]))

    fresh_state: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "phase": "initialized",
        "profileHash": profile_hash(cli_profile),
        "cliProfile": cli_profile,
        "pilotSelectionRequest": pilot,
        "requestedZ0Ids": z0_ids,
        "sourceFiles": pre["records"],
        "totalSourcePoints": total_points,
        "gridOrigin": [grid_origin[0], grid_origin[1]],
        "enuOriginSource": enu_origin_source.tolist(),
        "rootTransform": frame["root_transform"],
        "enuOriginLonLat": list(frame["enu_origin_lonlat"]),
        "enuOriginEcef": list(frame["enu_origin_ecef"]),
        "outputName": name,
        "hasRgb": has_rgb,
        "colorScale": COLOR_SCALE_DEFAULT,
        "completedArtifacts": [],
    }

    if resume and state_path.exists():
        saved = json.loads(state_path.read_text(encoding="utf-8"))
        migrated = _validate_resume_state(saved, fresh_state)
        fresh_state = saved
        if migrated:
            write_json_atomic(state_path, fresh_state)
    elif resume:
        raise SystemExit(f"Cannot resume: no state file at {state_path}")

    # Validate disk budget before an overwrite is allowed to remove a previous build.
    disk_check_path = output_dir if output_exists else root_dir.resolve()
    _check_disk_space(disk_check_path, total_points, has_rgb, allow_low_disk)

    if overwrite and output_exists:
        assert_inside(output_dir, tilesets_root, "output dir")
        shutil.rmtree(output_dir)

    _create_output_skeleton(output_dir)

    if not resume:
        write_json_atomic(state_path, fresh_state)
        write_json_atomic(
            report_path,
            _build_report_skeleton(
                dataset, logical, name, cli_profile, pilot, z0_ids, total_points,
            ),
        )

    print(f"=== Adaptive Point Hierarchy (foundation): {dataset} ===")
    print(f"  logical:      {logical}")
    print(f"  output:       {output_dir}")
    print(f"  grid origin:  {grid_origin}")
    print(f"  chunks:       {len(files)}  points≈{total_points}")
    print(f"  rgb:          {has_rgb}")
    print(f"  pilot:        {pilot}")
    if z0_ids:
        print(f"  z0 ids:       {z0_ids}")

    return {
        "outputPath": str(output_dir),
        "statePath": str(state_path),
        "reportPath": str(report_path),
        "gridOrigin": grid_origin,
        "hasRgb": has_rgb,
        "totalSourcePoints": total_points,
        "cliProfile": cli_profile,
        "pilotSelectionRequest": pilot,
        "requestedZ0Ids": z0_ids,
        "files": files,
        "frame": frame,
    }


def run_adaptive_point_hierarchy(
    root_dir: Path,
    dataset: str,
    public_root: str = "",
    internal_target_points: int = DEFAULT_INTERNAL_TARGET_POINTS,
    acceptable_min_points: int = DEFAULT_ACCEPTABLE_MIN_POINTS,
    leaf_max_points: int = DEFAULT_LEAF_MAX_POINTS,
    hard_max_points: int = DEFAULT_HARD_MAX_POINTS,
    max_depth: int = DEFAULT_MAX_DEPTH,
    error_scale: float = DEFAULT_ERROR_SCALE,
    microcell_grid: int = DEFAULT_MICROCELL_GRID,
    vrv_mode: str = "both",
    pilot: str = "auto",
    z0_ids: list[str] | None = None,
    resume: bool = False,
    overwrite: bool = False,
    allow_low_disk: bool = False,
    extend_pilot: bool = False,
) -> dict[str, Any]:
    """Plan 2 entry point: foundation skeleton (Plan 1), then census/pilot
    resolution, COPC streaming (p001/adaptive-root routing), the per-z0
    residual adaptive quadtree, an ownership audit, and a report. Never emits
    tileset JSON (that is Plan 3)."""
    if extend_pilot and (not resume or overwrite or pilot != "auto" or z0_ids):
        raise SystemExit("--extend-pilot requires --resume, --pilot auto, no --z0-id, and no --overwrite")

    foundation = build_adaptive_point_hierarchy_foundation(
        root_dir=root_dir,
        dataset=dataset,
        public_root=public_root,
        internal_target_points=internal_target_points,
        acceptable_min_points=acceptable_min_points,
        leaf_max_points=leaf_max_points,
        hard_max_points=hard_max_points,
        max_depth=max_depth,
        error_scale=error_scale,
        microcell_grid=microcell_grid,
        vrv_mode=vrv_mode,
        pilot=pilot,
        z0_ids=z0_ids,
        resume=resume,
        overwrite=overwrite,
        allow_low_disk=allow_low_disk,
    )
    output_dir = Path(foundation["outputPath"])
    state_path = Path(foundation["statePath"])
    report_path = Path(foundation["reportPath"])
    files = foundation["files"]
    frame = foundation["frame"]
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if extend_pilot:
        begin_pilot_extension(state, state_path)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        update_extension_report(report_path, state)

    cli_profile = state["cliProfile"]
    has_rgb = state["hasRgb"]
    grid_origin = (float(state["gridOrigin"][0]), float(state["gridOrigin"][1]))
    salt = fingerprint_salt(combined_source_fingerprint(state["sourceFiles"]))
    fragments_root = output_dir / ".aph-fragments"

    # Phase: resolve which z0 tiles to build. Explicit --z0-id always bypasses
    # the census; otherwise run the full-dataset census once and resolve pilot.
    if state.get("phase") in ("initialized", "census"):
        requested_z0_ids = state.get("requestedZ0Ids") or []
        if requested_z0_ids:
            census = None
            census_accounting = None
            selected_z0_ids = validate_z0_ids(list(requested_z0_ids))
        else:
            if state.get("phase") == "census":
                print(
                    "Previous census did not complete; restarting census from chunk 1 "
                    "(partial census is telemetry only, not a checkpoint).",
                    flush=True,
                )
            state["phase"] = "census"
            state["censusProgress"] = {
                "completedChunks": 0,
                "totalChunks": len(files),
                "sourcePointsVisited": 0,
                "totalSourcePoints": int(state["totalSourcePoints"]),
                "percent": 0.0,
                "restartableOnly": True,
            }
            write_json_atomic(state_path, state)

            def checkpoint_census_progress(progress: dict[str, Any]) -> None:
                state["censusProgress"] = progress
                write_json_atomic(state_path, state)

            census_result = run_census(
                files,
                frame,
                grid_origin,
                total_source_points=int(state["totalSourcePoints"]),
                progress_callback=checkpoint_census_progress,
            )
            census = census_result["counts"]
            census_accounting = {
                "sourcePointsVisited": int(census_result["sourcePointsVisited"]),
                "invalidPoints": int(census_result["invalidPoints"]),
            }
            selected_z0_ids = resolve_pilot_selection(
                census, state["pilotSelectionRequest"], [],
            )
            state["censusProgress"] = {
                "completedChunks": len(files),
                "totalChunks": len(files),
                "sourcePointsVisited": int(census_result["sourcePointsVisited"]),
                "totalSourcePoints": int(state["totalSourcePoints"]),
                "percent": 100.0,
                "restartableOnly": False,
            }
            selected_points = sum(int(census.get(z0_id, 0)) for z0_id in selected_z0_ids)
            source_total = int(state["totalSourcePoints"])
            selected_percent = 100.0 * selected_points / source_total if source_total > 0 else 0.0
            print(
                f"Pilot selection complete: z0={selected_z0_ids}, "
                f"selected points={_format_point_count(selected_points)}/"
                f"{_format_point_count(source_total)} ({selected_percent:.2f}%)",
                flush=True,
            )
        state["z0Census"] = census
        state["censusAccounting"] = census_accounting
        state["selectedZ0Ids"] = selected_z0_ids
        state["completedZ0Ids"] = []
        state["completedChunks"] = []
        state["chunkOrdinals"] = {}
        state["streamOrdinal"] = 0
        state["accounting"] = empty_accounting()
        state["ownershipAuditByZ0"] = {}
        state["phase"] = "streaming"
        write_json_atomic(state_path, state)

    selected_z0_ids = state["selectedZ0Ids"]

    # Phase: COPC streaming. Resumable at source-chunk granularity (state is
    # checkpointed by stream_copc_for_build after every completed chunk).
    if state["phase"] == "streaming":
        extension = state.get("pilotExtension")
        if extension is not None:
            stream_copc_for_build(
                files, frame, grid_origin, set(extension["addedZ0Ids"]), has_rgb, fragments_root, state, state_path,
                allow_bbox_pruning=True, checkpoint_key="extensionStream",
            )
            state["accounting"] = merge_pilot_extension_accounting(state)
        else:
            accounting = stream_copc_for_build(
                files, frame, grid_origin, set(selected_z0_ids), has_rgb, fragments_root, state, state_path,
                allow_bbox_pruning=state.get("censusAccounting") is not None,
            )
            census_accounting = state.get("censusAccounting")
            if census_accounting is not None:
                census_counts = state.get("z0Census") or {}
                selected_valid = sum(int(census_counts.get(z0_id, 0)) for z0_id in selected_z0_ids)
                visited = int(census_accounting["sourcePointsVisited"])
                invalid = int(census_accounting["invalidPoints"])
                accounting["sourcePointsVisited"] = visited
                accounting["invalidPoints"] = invalid
                accounting["outsideSelectedZ0"] = visited - invalid - selected_valid
            state["accounting"] = accounting
        state["phase"] = "finalizing"
        write_json_atomic(state_path, state)

    # Phase: per-z0 residual adaptive quadtree. A z0's build is all-or-nothing —
    # its root/p001 fragments are immutable inputs, so a crash mid-build just
    # means redoing that one z0 on the next resume; already-completed z0s are
    # skipped entirely.
    if state["phase"] == "finalizing":
        completed = set(state.get("completedZ0Ids", []))
        print(
            f"=== Phase 3/3: finalize adaptive trees "
            f"({len(completed)}/{len(selected_z0_ids)} z0 resumed) ===",
            flush=True,
        )
        for z0_index, z0_id in enumerate(selected_z0_ids, start=1):
            if z0_id in completed:
                print(
                    f"[finalize {z0_index}/{len(selected_z0_ids)}] {z0_id} already checkpointed",
                    flush=True,
                )
                delete_z0_input_shards(fragments_root, z0_id)
                continue
            bucket = state["accounting"]["perZ0"].get(z0_id, {"p001Points": 0, "adaptivePoints": 0})
            z0_started_at = time.monotonic()
            print(
                f"[finalize {z0_index}/{len(selected_z0_ids)}] start {z0_id} "
                f"p001={_format_point_count(bucket['p001Points'])} "
                f"adaptive={_format_point_count(bucket['adaptivePoints'])}",
                flush=True,
            )
            z0_result = finalize_one_z0(
                output_dir=output_dir,
                fragments_root=fragments_root,
                z0_id=z0_id,
                grid_origin=grid_origin,
                has_rgb=has_rgb,
                cli_profile=cli_profile,
                salt=salt,
                total_source_points=int(state["totalSourcePoints"]),
                expected_p001=bucket["p001Points"],
                expected_adaptive=bucket["adaptivePoints"],
            )
            state.setdefault("ownershipAuditByZ0", {})[z0_id] = {
                "duplicates": z0_result["duplicates"],
                "omittedEligiblePoints": z0_result["omittedEligiblePoints"],
                "extraPoints": z0_result["extraPoints"],
                "wrongOwnerPoints": z0_result["wrongOwnerPoints"],
            }
            state.setdefault("completedZ0Ids", []).append(z0_id)
            state["finalizeProgress"] = {
                "completedZ0": len(state["completedZ0Ids"]),
                "totalZ0": len(selected_z0_ids),
                "currentZ0": z0_id,
            }
            write_json_atomic(state_path, state)
            delete_z0_input_shards(fragments_root, z0_id)
            print(
                f"[finalize {z0_index}/{len(selected_z0_ids)}] checkpoint=durable {z0_id} "
                f"elapsed={_format_duration(time.monotonic() - z0_started_at)}",
                flush=True,
            )

    totals = accounting_totals(state["accounting"])
    audits = state.get("ownershipAuditByZ0") or {}
    totals["duplicates"] = sum(int(a.get("duplicates", 0)) for a in audits.values())
    totals["omittedEligiblePoints"] = sum(
        int(a.get("omittedEligiblePoints", 0)) for a in audits.values()
    )
    totals["extraPoints"] = sum(int(a.get("extraPoints", 0)) for a in audits.values())
    totals["wrongOwnerPoints"] = sum(int(a.get("wrongOwnerPoints", 0)) for a in audits.values())
    total_source_points = int(state["totalSourcePoints"])
    identity_total = totals["invalidPoints"] + totals["outsideSelectedZ0"] + totals["eligibleSelectedZ0"]
    if totals["sourcePointsVisited"] != total_source_points:
        raise SystemExit(
            f"Accounting invariant failed: sourcePointsVisited={totals['sourcePointsVisited']} "
            f"!= totalSourcePoints={total_source_points}"
        )
    if identity_total != totals["sourcePointsVisited"]:
        raise SystemExit(
            "Accounting invariant failed: sourcePointsVisited != invalidPoints + "
            "outsideSelectedZ0 + eligibleSelectedZ0"
        )
    if any(totals[key] for key in ("duplicates", "omittedEligiblePoints", "extraPoints", "wrongOwnerPoints")):
        raise SystemExit(f"Accounting ownership invariant failed: {totals}")

    leaf_counts: list[int] = []
    all_manifest_nodes: list[dict[str, Any]] = []
    for z0_id in selected_z0_ids:
        manifest_path = output_dir / ".node-manifests" / f"{z0_id}.json"
        if manifest_path.exists():
            nodes = json.loads(manifest_path.read_text())["nodes"]
            all_manifest_nodes.extend(nodes)
            leaf_counts.extend(n["pointCount"] for n in nodes if n["kind"] != NODE_KIND_INTERNAL)
    leaf_stats = compute_leaf_stats(leaf_counts, cli_profile["acceptableMinPoints"], cli_profile["leafMaxPoints"])
    leaf_diagnostics = compute_leaf_diagnostics(all_manifest_nodes)

    structural_gate = {
        "p95LeafMaxOk": leaf_stats["p95"] <= cli_profile["leafMaxPoints"],
        "maxHardMaxOk": leaf_stats["max"] <= cli_profile["hardMaxPoints"],
    }
    gate_passed = all(structural_gate.values())
    final_status = "residual-complete" if gate_passed else "residual-invalid"

    report = {
        "schemaVersion": SCHEMA_VERSION,
        "generator": GENERATOR,
        "status": final_status,
        "dataset": dataset,
        "logical": output_dir.parent.name,
        "outputName": output_dir.name,
        "cliProfile": cli_profile,
        "pilotSelectionRequest": state["pilotSelectionRequest"],
        "selectedZ0Ids": selected_z0_ids,
        **selection_metadata(state),
        "accounting": totals,
        "leafStats": leaf_stats,
        "leafDiagnostics": leaf_diagnostics,
        "structuralGate": structural_gate,
    }
    write_json_atomic(report_path, report)
    state["phase"] = final_status
    write_json_atomic(state_path, state)
    if not gate_passed:
        raise SystemExit(f"Adaptive hierarchy structural gate failed: {structural_gate}")

    print(f"=== Adaptive Point Hierarchy (residual quadtree): {dataset} ===")
    print(f"  selected z0s: {selected_z0_ids}")
    print(f"  accounting:   {totals}")
    print(f"  leaf stats:   p50={leaf_stats['p50']:.0f} p95={leaf_stats['p95']:.0f} max={leaf_stats['max']:.0f}")

    return {
        "outputPath": str(output_dir),
        "statePath": str(state_path),
        "reportPath": str(report_path),
        "selectedZ0Ids": selected_z0_ids,
        "accounting": totals,
        "leafStats": leaf_stats,
    }


# ─── CLI ────────────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the Adaptive Point Hierarchy (APH) pipeline foundation."
    )
    parser.add_argument("dataset", help="Source dataset, e.g. 2404PeruB2.")
    parser.add_argument("--root", required=True, help="Project root containing local-storage/.")
    parser.add_argument("--public-root", default="", help="Logical/public root.")
    parser.add_argument("--internal-target-points", type=int, default=DEFAULT_INTERNAL_TARGET_POINTS)
    parser.add_argument("--acceptable-min-points", type=int, default=DEFAULT_ACCEPTABLE_MIN_POINTS)
    parser.add_argument("--leaf-max-points", type=int, default=DEFAULT_LEAF_MAX_POINTS)
    parser.add_argument("--hard-max-points", type=int, default=DEFAULT_HARD_MAX_POINTS)
    parser.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH)
    parser.add_argument("--error-scale", type=float, default=DEFAULT_ERROR_SCALE)
    parser.add_argument("--microcell-grid", type=int, default=DEFAULT_MICROCELL_GRID)
    parser.add_argument("--vrv-mode", choices=VRV_MODES, default="both")
    parser.add_argument("--pilot", choices=PILOT_MODES, default="auto")
    parser.add_argument(
        "--z0-id",
        dest="z0_ids",
        action="append",
        default=[],
        metavar="ID",
        help="Restrict the build to this z0 tile id (repeatable).",
    )
    parser.add_argument("--resume", action="store_true", help="Resume from checkpoints.")
    parser.add_argument(
        "--extend-pilot",
        action="store_true",
        help="Extend a completed --pilot auto output to all census z0 tiles without rebuilding pilot z0s (requires --resume).",
    )
    parser.add_argument("--overwrite", action="store_true", help="Replace existing output.")
    parser.add_argument(
        "--allow-low-disk",
        action="store_true",
        help="Override the disk-space preflight check.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    result = run_adaptive_point_hierarchy(
        root_dir=Path(args.root).resolve(),
        dataset=args.dataset,
        public_root=args.public_root,
        internal_target_points=args.internal_target_points,
        acceptable_min_points=args.acceptable_min_points,
        leaf_max_points=args.leaf_max_points,
        hard_max_points=args.hard_max_points,
        max_depth=args.max_depth,
        error_scale=args.error_scale,
        microcell_grid=args.microcell_grid,
        vrv_mode=args.vrv_mode,
        pilot=args.pilot,
        z0_ids=args.z0_ids,
        resume=args.resume,
        overwrite=args.overwrite,
        allow_low_disk=args.allow_low_disk,
        extend_pilot=args.extend_pilot,
    )
    print(f"Built Adaptive Point Hierarchy residual quadtree: {result['outputPath']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
