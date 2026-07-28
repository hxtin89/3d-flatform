#!/usr/bin/env python3
"""Inspect a Spatial LOD metadata chain for one active PNTS URI.

Usage:
  python pipeline/inspect_spatial_lod_active_tile.py \
    local-storage/tilesets/peru-b2-globe/peru-b2-globe-spatial-lod \
    ../../points/z1/z1_x000001_y000002.pnts
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


EXPECTED_ERROR_LEVELS = {
    4000.0: "z0",
    1000.0: "z1",
    500.0: "z2",
    250.0: "z3",
    0.0: "z4",
}


def tile_uri(tile: dict[str, Any]) -> str | None:
    uri = tile.get("content", {}).get("uri")
    return uri if isinstance(uri, str) else None


def level_from_tile(tile: dict[str, Any]) -> str | None:
    uri = tile_uri(tile)
    if uri:
        parts = Path(uri).parts
        for part in parts:
            if part in {"z0", "z1", "z2", "z3", "z4"}:
                return part
        stem = Path(uri).stem
        if stem.startswith("z") and "_" in stem:
            return stem.split("_", 1)[0]
    err = tile.get("geometricError")
    if isinstance(err, (int, float)):
        return EXPECTED_ERROR_LEVELS.get(float(err))
    return None


def summarize(tile: dict[str, Any]) -> dict[str, Any]:
    children = [child for child in tile.get("children", []) if isinstance(child, dict)]
    return {
        "uri": tile_uri(tile),
        "level": level_from_tile(tile),
        "geometricError": tile.get("geometricError"),
        "refine": tile.get("refine"),
        "childrenCount": len(children),
        "childLevels": sorted({level_from_tile(child) or "unknown" for child in children}),
        "hasViewerRequestVolume": "viewerRequestVolume" in tile,
    }


def walk(tile: dict[str, Any], path: list[dict[str, Any]], target_name: str) -> list[dict[str, Any]] | None:
    current = path + [tile]
    uri = tile_uri(tile)
    if uri and Path(uri).name == target_name:
        return current
    for child in tile.get("children", []):
        if not isinstance(child, dict):
            continue
        found = walk(child, current, target_name)
        if found is not None:
            return found
    return None


def inspect(root: Path, active_uri: str) -> dict[str, Any]:
    target_name = Path(active_uri.split("?", 1)[0].split("#", 1)[0]).name
    for z0_path in sorted((root / "z0").glob("*/tileset.json")):
        doc = json.loads(z0_path.read_text(encoding="utf-8"))
        found = walk(doc["root"], [], target_name)
        if found is None:
            continue
        return {
            "activeUri": active_uri,
            "targetName": target_name,
            "z0Document": str(z0_path),
            "chain": [summarize(tile) for tile in found],
            "descendants": descendant_summary(found[-1]),
        }
    raise SystemExit(f"Active tile URI not found under {root}: {active_uri}")


def descendant_summary(tile: dict[str, Any]) -> dict[str, Any]:
    counts: dict[str, int] = {}

    def visit(node: dict[str, Any]) -> None:
        for child in node.get("children", []):
            if not isinstance(child, dict):
                continue
            level = level_from_tile(child) or "unknown"
            counts[level] = counts.get(level, 0) + 1
            visit(child)

    visit(tile)
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect Spatial LOD active tile metadata chain.")
    parser.add_argument("spatial_lod_root", type=Path)
    parser.add_argument("active_uri")
    args = parser.parse_args()
    print(json.dumps(inspect(args.spatial_lod_root, args.active_uri), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
