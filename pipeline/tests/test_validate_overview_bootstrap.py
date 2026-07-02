#!/usr/bin/env python3
"""Self-contained tests for validate_overview_bootstrap.py.

Run with: python3 pipeline/tests/test_validate_overview_bootstrap.py
"""

import json
import shutil
import struct
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

import validate_overview_bootstrap as validator


def write_minimal_pnts(path: Path) -> None:
    """Write a minimal valid PNTS file with one point."""
    xyz = struct.pack("<fff", 0.0, 0.0, 0.0)
    feature_json = json.dumps({
        "POINTS_LENGTH": 1,
        "POSITION": {"byteOffset": 0},
    }, separators=(",", ":")).encode("utf-8")
    padding = (8 - ((28 + len(feature_json)) % 8)) % 8
    feature_json += b" " * padding
    byte_length = 28 + len(feature_json) + len(xyz)
    header = struct.pack("<4sIIIIII", b"pnts", 1, byte_length, len(feature_json), len(xyz), 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + feature_json + xyz)


def write_tileset(directory: Path, root_tile: dict) -> None:
    tileset = {
        "asset": {"version": "1.0"},
        "geometricError": 1000.0,
        "root": root_tile,
    }
    (directory / "tileset.json").write_text(json.dumps(tileset), encoding="utf-8")


def run_case(name: str, directory: Path, expected_ready: bool) -> None:
    output = directory / "bootstrap-validation.json"
    result = validator.validate(directory)
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    assert result["coarseBootstrapReady"] is expected_ready, (
        f"{name}: expected ready={expected_ready}, got {result['coarseBootstrapReady']}"
    )
    print(f"✓ {name}: ready={result['coarseBootstrapReady']}, "
          f"tiles={result['coarseContentTileCount']}, "
          f"bytes={result['coarseContentBytes']}, "
          f"maxDepth={result['coarseContentMaxDepth']}, "
          f"missing={len(result['missingBranches'])}")


def test_root_has_pnts() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        write_minimal_pnts(directory / "points" / "root.pnts")
        write_tileset(directory, {
            "boundingVolume": {"box": [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]},
            "geometricError": 100.0,
            "content": {"uri": "points/root.pnts"},
        })
        run_case("root has PNTS", directory, True)


def test_content_at_coarse_descendants() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        write_minimal_pnts(directory / "points" / "child.pnts")
        write_tileset(directory, {
            "boundingVolume": {"box": [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]},
            "geometricError": 100.0,
            "children": [{
                "boundingVolume": {"box": [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5]},
                "geometricError": 50.0,
                "content": {"uri": "points/child.pnts"},
            }],
        })
        run_case("content at coarse descendants", directory, True)


def test_missing_pnts() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        write_tileset(directory, {
            "boundingVolume": {"box": [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]},
            "geometricError": 100.0,
            "content": {"uri": "points/missing.pnts"},
        })
        run_case("missing PNTS", directory, False)


def test_external_tileset_with_pnts() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        write_minimal_pnts(directory / "points" / "child.pnts")
        write_tileset(directory, {
            "boundingVolume": {"box": [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]},
            "geometricError": 100.0,
            "content": {"uri": "external.json"},
        })
        external_root = {
            "boundingVolume": {"box": [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5]},
            "geometricError": 50.0,
            "content": {"uri": "points/child.pnts"},
        }
        (directory / "external.json").write_text(
            json.dumps({"asset": {"version": "1.0"}, "geometricError": 1000.0, "root": external_root}),
            encoding="utf-8",
        )
        run_case("external tileset with PNTS", directory, True)


def test_missing_external_tileset() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        write_tileset(directory, {
            "boundingVolume": {"box": [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]},
            "geometricError": 100.0,
            "content": {"uri": "missing-external.json"},
        })
        run_case("missing external tileset", directory, False)


def test_branch_without_content() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        write_minimal_pnts(directory / "points" / "child.pnts")
        write_tileset(directory, {
            "boundingVolume": {"box": [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]},
            "geometricError": 100.0,
            "children": [
                {
                    "boundingVolume": {"box": [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5]},
                    "geometricError": 50.0,
                    "content": {"uri": "points/child.pnts"},
                },
                {
                    "boundingVolume": {"box": [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5]},
                    "geometricError": 50.0,
                },
            ],
        })
        run_case("branch without content", directory, False)


def test_invalid_pnts() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        (directory / "points").mkdir(parents=True, exist_ok=True)
        (directory / "points" / "bad.pnts").write_bytes(b"not a pnts file")
        write_tileset(directory, {
            "boundingVolume": {"box": [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]},
            "geometricError": 100.0,
            "content": {"uri": "points/bad.pnts"},
        })
        run_case("invalid PNTS", directory, False)


if __name__ == "__main__":
    test_root_has_pnts()
    test_content_at_coarse_descendants()
    test_missing_pnts()
    test_external_tileset_with_pnts()
    test_missing_external_tileset()
    test_branch_without_content()
    test_invalid_pnts()
    print("\n✓ All validator tests passed")
