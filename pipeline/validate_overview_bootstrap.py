#!/usr/bin/env python3
"""Validate the coarse PNTS frontier of an Overview tileset for progressive SSE.

Traverses the tileset tree from the root and, for every branch, finds the first
tile that carries PNTS content. The set of those "first-content" tiles is the
coarse frontier used for the bootstrap SSE 512 phase. The validator writes
bootstrap-validation.json with:

- coarseBootstrapReady: True when every branch has at least one valid PNTS tile.
- coarseContentTileCount: number of tiles in the coarse frontier.
- coarseContentBytes: total bytes of the coarse frontier PNTS files.
- coarseContentMaxDepth: maximum depth of a coarse frontier tile.
- missingBranches: list of branches that lack content or have invalid/missing PNTS.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path
from typing import Any


PNTS_MAGIC = b"pnts"
PNTS_VERSION = 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate coarse PNTS frontier for progressive SSE bootstrap."
    )
    parser.add_argument(
        "--tileset-dir",
        required=True,
        help="Directory containing tileset.json and the points/ subtree.",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Path to write bootstrap-validation.json.",
    )
    return parser.parse_args()


def load_tileset(tileset_path: Path) -> dict[str, Any]:
    return json.loads(tileset_path.read_text(encoding="utf-8"))


def is_valid_pnts(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            header = handle.read(28)
        if len(header) < 28:
            return False
        magic, version = struct.unpack("<4sI", header[:8])
        return magic == PNTS_MAGIC and version == PNTS_VERSION
    except (OSError, struct.error):
        return False


def validate_branch(
    tile: dict[str, Any],
    depth: int,
    base_dir: Path,
    branch_path: str,
    result: dict[str, Any],
    visited_external: set[Path] | None = None,
) -> None:
    visited_external = visited_external or set()
    content = tile.get("content")
    content_uri = content.get("uri") if isinstance(content, dict) else None

    if content_uri:
        if content_uri.endswith(".json"):
            external_path = (base_dir / content_uri).resolve()
            if external_path in visited_external:
                result["missingBranches"].append(
                    f"{branch_path}: cyclic external tileset ({content_uri})"
                )
                return
            if not external_path.exists():
                result["missingBranches"].append(
                    f"{branch_path}: missing external tileset ({content_uri})"
                )
                return
            try:
                external_tileset = load_tileset(external_path)
            except (OSError, json.JSONDecodeError):
                result["missingBranches"].append(
                    f"{branch_path}: invalid external tileset ({content_uri})"
                )
                return
            external_root = (
                external_tileset.get("root")
                if isinstance(external_tileset, dict)
                else None
            )
            if external_root is None:
                result["missingBranches"].append(
                    f"{branch_path}: external tileset has no root ({content_uri})"
                )
                return
            visited_external.add(external_path)
            validate_branch(
                external_root,
                depth,
                external_path.parent,
                f"{branch_path}@{content_uri}",
                result,
                visited_external,
            )
            return

        pnts_path = base_dir / content_uri
        if not pnts_path.exists():
            result["missingBranches"].append(
                f"{branch_path}: missing {content_uri}"
            )
            return
        if not is_valid_pnts(pnts_path):
            result["missingBranches"].append(
                f"{branch_path}: invalid PNTS {content_uri}"
            )
            return

        size = pnts_path.stat().st_size
        result["coarseContentTileCount"] += 1
        result["coarseContentBytes"] += size
        result["coarseContentMaxDepth"] = max(
            result["coarseContentMaxDepth"], depth
        )
        return

    children = tile.get("children", [])
    if not children:
        result["missingBranches"].append(
            f"{branch_path}: no content and no children"
        )
        return

    for index, child in enumerate(children):
        validate_branch(
            child,
            depth + 1,
            base_dir,
            f"{branch_path}/{index}",
            result,
            visited_external,
        )


def validate(tileset_dir: Path) -> dict[str, Any]:
    tileset_path = tileset_dir / "tileset.json"
    if not tileset_path.exists():
        return {
            "coarseBootstrapReady": False,
            "coarseContentTileCount": 0,
            "coarseContentBytes": 0,
            "coarseContentMaxDepth": 0,
            "missingBranches": ["tileset.json not found"],
        }

    tileset = load_tileset(tileset_path)
    root = tileset.get("root") if isinstance(tileset, dict) else None
    if root is None:
        return {
            "coarseBootstrapReady": False,
            "coarseContentTileCount": 0,
            "coarseContentBytes": 0,
            "coarseContentMaxDepth": 0,
            "missingBranches": ["tileset root missing"],
        }

    result: dict[str, Any] = {
        "coarseBootstrapReady": False,
        "coarseContentTileCount": 0,
        "coarseContentBytes": 0,
        "coarseContentMaxDepth": 0,
        "missingBranches": [],
    }
    validate_branch(root, 0, tileset_path.parent, "root", result)
    result["coarseBootstrapReady"] = (
        result["coarseContentTileCount"] > 0
        and len(result["missingBranches"]) == 0
    )
    return result


def main() -> None:
    args = parse_args()
    tileset_dir = Path(args.tileset_dir).resolve()
    output_path = Path(args.output).resolve()

    result = validate(tileset_dir)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    status = "ready" if result["coarseBootstrapReady"] else "not ready"
    print(f"✓ bootstrap validation: {status}")
    print(f"  coarse tiles: {result['coarseContentTileCount']}")
    print(f"  coarse bytes: {result['coarseContentBytes']}")
    print(f"  coarse max depth: {result['coarseContentMaxDepth']}")
    if result["missingBranches"]:
        print(f"  missing/invalid branches: {len(result['missingBranches'])}")
        for branch in result["missingBranches"][:5]:
            print(f"    - {branch}")
        if len(result["missingBranches"]) > 5:
            print(f"    ... and {len(result['missingBranches']) - 5} more")


if __name__ == "__main__":
    main()
