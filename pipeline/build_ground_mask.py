#!/usr/bin/env python3
"""Bake the ground coverage mask as a per-cell distance field.

DESIGN SKETCH — unverified. There is no local-storage/ in this checkout, so this has
never been run against real data. Treat the structure as the proposal and the numbers in
the comments as measurements taken from the runtime implementation on branch
sbb/ground-patch-mask, not from this script.

See .agents/skills/ground-coverage-mask/SKILL.md for why this moves out of the browser.

What it produces, next to the tileset:

    <dataset>/mask/manifest.json
    <dataset>/mask/c0006_r0004.png      512x512, 8-bit grey

Each pixel holds the distance to the nearest pixel WITHOUT point data, in units of
`distanceUnitM` metres, clamped to 255. Zero means no data here. The viewer thresholds
that distance directly, which is what buys erosion at any distance and a fade of any
width while keeping narrow gaps — the river — exactly intact.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Iterator

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

# Ground resolution and cell size. Must match design.groundPatch.maskMetresPerPixel and
# maskCellPx in viewer/src/threejs-test/config.ts — the manifest carries them so the
# viewer can assert rather than assume.
METRES_PER_PIXEL = 5
CELL_PX = 512
CELL_SIZE_M = METRES_PER_PIXEL * CELL_PX  # 2560 m

# One byte of distance. 2 m per unit reaches 510 m, far past any useful erosion.
DISTANCE_UNIT_M = 2

# Points are read in blocks so a survey larger than memory still works.
READ_BLOCK = 4_000_000


def cell_of(enu_x: np.ndarray, enu_y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Lattice cell for each point.

    Anchored at the ENU origin with floor(), NOT at the dataset's bounding box. That is
    what lets a grown survey add cells around the existing ones instead of renumbering
    them, so re-baking leaves untouched cell files byte-identical and CDN-cached — and
    what will let separate areas share one addressing scheme later.
    """
    return np.floor(enu_x / CELL_SIZE_M).astype(np.int64), np.floor(enu_y / CELL_SIZE_M).astype(np.int64)


def read_enu_blocks(copc_path: Path, enu_inverse: np.ndarray) -> Iterator[np.ndarray]:
    """Stream (N, 3) ENU point blocks out of the COPC via PDAL.

    Decimation is deliberately absent: the bake has no frame budget, so it should use
    the densest data there is. For scale, the runtime version measured a median of 12
    returns per 25 m^2 pixel from the overview level alone, so coverage is never in
    doubt — the cost here is only wall-clock in a pipeline step.
    """
    import pdal  # imported late so --help works without PDAL installed

    pipeline = pdal.Pipeline(json.dumps({"pipeline": [str(copc_path)]}))
    pipeline.execute()  # SKETCH: switch to streaming mode for surveys past memory
    for array in pipeline.arrays:
        xyz = np.stack([array["X"], array["Y"], array["Z"], np.ones(len(array))], axis=1)
        yield (xyz @ enu_inverse.T)[:, :3]


def mark_coverage(blocks: Iterator[np.ndarray]) -> dict[tuple[int, int], np.ndarray]:
    """Mark the pixel each point falls in. One pixel per point, nothing more.

    Explicitly NOT dilated. The runtime version grew every point into 3x3, which let one
    return claim 225 m^2 — and over water, where the survey picks up scattered returns
    off the surface, wet sand and driftwood, a handful of those made the river read as
    solid ground. The distance transform below provides all the smoothing that growth was
    standing in for.
    """
    cells: dict[tuple[int, int], np.ndarray] = {}
    for block in blocks:
        col, row = cell_of(block[:, 0], block[:, 1])
        px = np.floor((block[:, 0] - col * CELL_SIZE_M) / METRES_PER_PIXEL).astype(np.int64)
        py = np.floor((block[:, 1] - row * CELL_SIZE_M) / METRES_PER_PIXEL).astype(np.int64)
        np.clip(px, 0, CELL_PX - 1, out=px)
        np.clip(py, 0, CELL_PX - 1, out=py)
        for key in map(tuple, np.unique(np.stack([col, row], axis=1), axis=0)):
            grid = cells.get(key)
            if grid is None:
                grid = cells[key] = np.zeros((CELL_PX, CELL_PX), dtype=bool)
            here = (col == key[0]) & (row == key[1])
            grid[py[here], px[here]] = True
    return cells


def distance_field(cells: dict[tuple[int, int], np.ndarray], key: tuple[int, int]) -> np.ndarray:
    """Distance to the nearest empty pixel, in metres, for one cell.

    Computed over the cell PLUS a one-cell apron assembled from its eight neighbours, so
    a pixel near a seam measures against real neighbouring ground instead of against the
    cell border. Without the apron every cell edge would read as "no data" and the patch
    would show a 2.5 km grid.

    This apron is the reason the job belongs offline. The runtime version cannot afford
    neighbour reads per fragment, which is exactly why it approximates with a jittered
    disc — and why a blur wider than the river closes over the river.
    """
    col, row = key
    padded = np.zeros((CELL_PX * 3, CELL_PX * 3), dtype=bool)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            neighbour = cells.get((col + dx, row + dy))
            if neighbour is None:
                continue
            y0, x0 = (dy + 1) * CELL_PX, (dx + 1) * CELL_PX
            padded[y0:y0 + CELL_PX, x0:x0 + CELL_PX] = neighbour
    metres = distance_transform_edt(padded, sampling=(METRES_PER_PIXEL, METRES_PER_PIXEL))
    return metres[CELL_PX:CELL_PX * 2, CELL_PX:CELL_PX * 2]


def quantise(metres: np.ndarray) -> np.ndarray:
    """Metres to one byte. 0 stays 0, so "no data" survives the round trip exactly."""
    return np.clip(np.rint(metres / DISTANCE_UNIT_M), 0, 255).astype(np.uint8)


def build(dataset_dir: Path, copc_path: Path, manifest: dict) -> dict:
    enu_inverse = np.linalg.inv(np.array(manifest["rootTransform"], dtype=np.float64).reshape(4, 4).T)
    cells = mark_coverage(read_enu_blocks(copc_path, enu_inverse))

    out_dir = dataset_dir / "mask"
    out_dir.mkdir(parents=True, exist_ok=True)
    listed = []
    for key in sorted(cells):
        col, row = key
        name = f"c{col:04d}_r{row:04d}.png"
        # Flipped on write: image rows run top-down, the ENU lattice runs bottom-up, and
        # the viewer samples in lattice space.
        Image.fromarray(np.flipud(quantise(distance_field(cells, key))), mode="L").save(out_dir / name)
        listed.append({"col": col, "row": row, "file": name})

    out = {
        "version": 1,
        "metresPerPixel": METRES_PER_PIXEL,
        "cellPx": CELL_PX,
        "cellSizeM": CELL_SIZE_M,
        "distanceUnitM": DISTANCE_UNIT_M,
        "enuOriginLonLat": manifest.get("enuOriginLonLat"),
        "cells": listed,
    }
    (out_dir / "manifest.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, help="repo root")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--public-root", default="")
    parser.add_argument("--copc", required=True, help="source COPC to read coverage from")
    args = parser.parse_args()

    dataset_dir = Path(args.root) / "local-storage" / "tilesets" / (args.public_root or args.dataset)
    manifest = json.loads((dataset_dir / "area-manifest.json").read_text(encoding="utf-8"))
    out = build(dataset_dir, Path(args.copc), manifest)
    covered_km2 = len(out["cells"]) * (CELL_SIZE_M / 1000) ** 2
    print(f"[ground-mask] {len(out['cells'])} cells at {METRES_PER_PIXEL} m/px "
          f"({CELL_SIZE_M / 1000:.1f} km each, up to {covered_km2:.0f} km2 of lattice)")


if __name__ == "__main__":
    main()
