#!/usr/bin/env python3
"""Tests for the external sidecar one-lod-tree builder."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any


MODULE_PATH = Path(__file__).parent.parent / "build_one_lod_tree.py"
SPEC = importlib.util.spec_from_file_location("build_one_lod_tree", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SIDECAR_NAME = MODULE.SIDECAR_NAME
build_one_lod_tree = MODULE.build_one_lod_tree
bbox_overlaps_or_contains = MODULE.bbox_overlaps_or_contains


def box(cx: float, cy: float, cz: float, hx: float, hy: float, hz: float) -> list[float]:
    return [cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz]


def transform() -> list[float]:
    return [
        0.9367, 0.35, 0, 0,
        0.0778, -0.2083, 0.9749, 0,
        0.3413, -0.9132, -0.2224, 0,
        2177336, -5825861, -1409425, 1,
    ]


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def write_pnts(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"pnts-test")


def asset(dataset: str) -> dict[str, Any]:
    return {
        "version": "1.0",
        "extras": {
            "dataset": dataset,
            "coordinateMode": "globe",
            "local_only": False,
        },
    }


def pnts_tile(uri: str, bbox: list[float], ge: float = 0) -> dict[str, Any]:
    return {
        "boundingVolume": {"box": bbox},
        "geometricError": ge,
        "refine": "ADD",
        "content": {"uri": uri},
    }


def build_fake_dataset(base: Path, dataset: str = "TestDataset", public_root: str = "") -> dict[str, Path]:
    logical = public_root or dataset
    logical_dir = base / "local-storage" / "tilesets" / logical
    chunk_id = "chunk--1_-1"
    chunk_box = box(100, 200, 50, 500, 500, 200)
    area_box = box(100, 200, 50, 499, 498, 199)
    other_box = box(-1000, 200, 50, 400, 400, 180)

    overview_dir = logical_dir / f"{dataset}-overview-p02"
    overview_chunk = overview_dir / "chunks" / chunk_id
    write_pnts(overview_chunk / "points/root_packed.pnts")
    write_pnts(overview_chunk / "points/r3_0_0_0.pnts")
    write_json(overview_chunk / "tileset.json", {
        "asset": asset("overview-chunk"),
        "geometricError": 500,
        "root": {
            "boundingVolume": {"box": chunk_box},
            "geometricError": 200,
            "refine": "ADD",
            "content": {"uri": "points/root_packed.pnts"},
            "children": [pnts_tile("points/r3_0_0_0.pnts", chunk_box)],
        },
    })
    other_chunk = overview_dir / "chunks/chunk--1_-2"
    write_pnts(other_chunk / "points/root_packed.pnts")
    write_json(other_chunk / "tileset.json", {
        "asset": asset("overview-other"),
        "geometricError": 400,
        "root": {
            "boundingVolume": {"box": other_box},
            "geometricError": 100,
            "refine": "ADD",
            "content": {"uri": "points/root_packed.pnts"},
        },
    })
    write_json(overview_dir / "tileset.json", {
        "asset": asset(f"{logical}/{dataset}-overview-p02"),
        "geometricError": 16000,
        "root": {
            "transform": transform(),
            "boundingVolume": {"box": box(0, 0, 0, 6000, 5000, 800)},
            "geometricError": 16000,
            "refine": "ADD",
            "children": [
                pnts_tile(f"chunks/{chunk_id}/tileset.json", chunk_box, 500),
                pnts_tile("chunks/chunk--1_-2/tileset.json", other_box, 400),
            ],
        },
    })

    explore_area = logical_dir / f"{dataset}-explore-p10/areas/area-001"
    explore_chunk = explore_area / "chunks" / chunk_id
    write_pnts(explore_chunk / "points/r0_0_0_0.pnts")
    write_pnts(explore_chunk / "points/r4_0_0_0.pnts")
    write_json(explore_chunk / "tileset.json", {
        "asset": asset("explore-chunk"),
        "geometricError": 500,
        "root": {
            "boundingVolume": {"box": area_box},
            "geometricError": 100,
            "refine": "ADD",
            "children": [
                pnts_tile("points/r0_0_0_0.pnts", area_box),
                pnts_tile("points/r4_0_0_0.pnts", area_box),
            ],
        },
    })
    write_json(explore_area / "tileset.json", {
        "asset": asset("explore-area"),
        "geometricError": 500,
        "root": {
            "transform": transform(),
            "boundingVolume": {"box": area_box},
            "geometricError": 500,
            "refine": "ADD",
            "children": [pnts_tile(f"chunks/{chunk_id}/tileset.json", area_box, 500)],
        },
    })

    full_chunk = logical_dir / f"{dataset}-chunked-copc/chunks/{chunk_id}"
    write_pnts(full_chunk / "points/r0_0_0_0.pnts")
    write_pnts(full_chunk / "points/r1_0_0_0.pnts")
    write_json(full_chunk / "tileset.json", {
        "asset": asset("detail-source"),
        "geometricError": 500,
        "root": {
            "boundingVolume": {"box": area_box},
            "geometricError": 500,
            "refine": "ADD",
            "content": {"uri": "points/r0_0_0_0.pnts"},
            "children": [pnts_tile("points/r1_0_0_0.pnts", area_box, 250)],
        },
    })

    detail_area = logical_dir / f"{dataset}-detail-p100/areas/area-001"
    write_json(detail_area / "tileset.json", {
        "asset": asset("detail-wrapper"),
        "geometricError": 500,
        "root": {
            "transform": transform(),
            "boundingVolume": {"box": area_box},
            "geometricError": 500,
            "refine": "ADD",
            "content": {"uri": f"../../../{dataset}-chunked-copc/chunks/{chunk_id}/tileset.json"},
        },
    })

    write_json(logical_dir / "area-manifest.json", {
        "dataset": dataset,
        "defaultMode": "overview",
        "defaultAreaId": "area-001",
        "datasets": {
            "overview": {
                "dataset": f"{logical}/{dataset}-overview-p02",
                "status": "ready",
            },
        },
        "areas": [{
            "areaId": "area-001",
            "label": "Area 001",
            "sourceChunkId": chunk_id,
            "bbox": [0, 0, 0, 1, 1, 1],
            "pointCount": 10,
            "datasets": {
                "explore": {
                    "dataset": f"{logical}/{dataset}-explore-p10/areas/area-001",
                    "status": "ready",
                },
                "detail": {
                    "dataset": f"{logical}/{dataset}-detail-p100/areas/area-001",
                    "status": "ready",
                },
            },
        }],
    })
    return {
        "logical": logical_dir,
        "overviewRoot": overview_dir / "tileset.json",
        "overviewChunk": overview_chunk / "tileset.json",
        "exploreRoot": explore_area / "tileset.json",
        "exploreChunk": explore_chunk / "tileset.json",
        "detailWrapper": detail_area / "tileset.json",
        "detailSource": full_chunk / "tileset.json",
    }


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def add_second_area(paths: dict[str, Path], dataset: str = "TestDataset") -> None:
    logical_dir = paths["logical"]
    chunk_id = "chunk--1_-2"
    chunk_box = box(-1000, 200, 50, 400, 400, 180)

    explore_area = logical_dir / f"{dataset}-explore-p10/areas/area-002"
    explore_chunk = explore_area / "chunks" / chunk_id
    write_pnts(explore_chunk / "points/r0_0_0_0.pnts")
    write_json(explore_chunk / "tileset.json", {
        "asset": asset("explore-chunk-2"),
        "geometricError": 400,
        "root": {
            "boundingVolume": {"box": chunk_box},
            "geometricError": 100,
            "refine": "ADD",
            "children": [pnts_tile("points/r0_0_0_0.pnts", chunk_box)],
        },
    })
    write_json(explore_area / "tileset.json", {
        "asset": asset("explore-area-2"),
        "geometricError": 400,
        "root": {
            "transform": transform(),
            "boundingVolume": {"box": chunk_box},
            "geometricError": 400,
            "refine": "ADD",
            "children": [pnts_tile(f"chunks/{chunk_id}/tileset.json", chunk_box, 400)],
        },
    })

    full_chunk = logical_dir / f"{dataset}-chunked-copc/chunks/{chunk_id}"
    write_pnts(full_chunk / "points/r0_0_0_0.pnts")
    write_json(full_chunk / "tileset.json", {
        "asset": asset("detail-source-2"),
        "geometricError": 400,
        "root": {
            "boundingVolume": {"box": chunk_box},
            "geometricError": 400,
            "refine": "ADD",
            "content": {"uri": "points/r0_0_0_0.pnts"},
        },
    })
    detail_area = logical_dir / f"{dataset}-detail-p100/areas/area-002"
    write_json(detail_area / "tileset.json", {
        "asset": asset("detail-wrapper-2"),
        "geometricError": 400,
        "root": {
            "transform": transform(),
            "boundingVolume": {"box": chunk_box},
            "geometricError": 400,
            "refine": "ADD",
            "content": {"uri": f"../../../{dataset}-chunked-copc/chunks/{chunk_id}/tileset.json"},
        },
    })

    manifest_path = logical_dir / "area-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["areas"].append({
        "areaId": "area-002",
        "label": "Area 002",
        "sourceChunkId": chunk_id,
        "bbox": [0, 0, 0, 1, 1, 1],
        "pointCount": 10,
        "datasets": {
            "explore": {
                "dataset": f"{logical_dir.name}/{dataset}-explore-p10/areas/area-002",
                "status": "ready",
            },
            "detail": {
                "dataset": f"{logical_dir.name}/{dataset}-detail-p100/areas/area-002",
                "status": "ready",
            },
        },
    })
    write_json(manifest_path, manifest)


def walk_tiles(tile: dict[str, Any]):
    yield tile
    for child in tile.get("children", []):
        yield from walk_tiles(child)


class OneLodTreeBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="one-lod-test-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def build(self, public_root: str = "") -> tuple[dict[str, Path], dict[str, Any]]:
        paths = build_fake_dataset(self.temp, public_root=public_root)
        result = build_one_lod_tree(
            self.temp,
            "TestDataset",
            "area-001",
            public_root=public_root,
        )
        return paths, result

    def test_bbox_tolerance(self) -> None:
        self.assertTrue(bbox_overlaps_or_contains(box(0, 0, 0, 10, 10, 10), box(1, 1, 1, 10, 10, 10), 1))
        self.assertFalse(bbox_overlaps_or_contains(box(0, 0, 0, 10, 10, 10), box(50, 0, 0, 1, 1, 1), 1))

    def test_builds_four_sidecars_and_preserves_sources(self) -> None:
        paths = build_fake_dataset(self.temp)
        source_hashes = {name: digest(path) for name, path in paths.items() if name != "logical"}
        result = build_one_lod_tree(self.temp, "TestDataset", "area-001")
        sidecars = [Path(path) for path in result["sidecarPaths"]]
        self.assertEqual(len(sidecars), 4)
        self.assertTrue(all(path.name == SIDECAR_NAME and path.exists() for path in sidecars))
        self.assertEqual(
            source_hashes,
            {name: digest(path) for name, path in paths.items() if name != "logical"},
        )

    def test_external_chain_nodes_are_leaves_and_all_uris_resolve(self) -> None:
        _, result = self.build()
        entry = Path(result["outputPath"])
        generated = {Path(path).resolve() for path in result["sidecarPaths"]}
        visited: set[Path] = set()

        def visit(path: Path, is_entry: bool = False) -> None:
            path = path.resolve()
            if path in visited:
                return
            visited.add(path)
            document = json.loads(path.read_text())
            root = document["root"]
            self.assertEqual("transform" in root, is_entry)
            for tile in walk_tiles(root):
                if tile is not root:
                    self.assertNotIn("transform", tile)
                for child in tile.get("children", []):
                    self.assertLessEqual(child["geometricError"], tile["geometricError"])
                uri = tile.get("content", {}).get("uri")
                if not uri:
                    continue
                self.assertFalse(Path(uri).is_absolute())
                self.assertNotIn(str(self.temp), uri)
                target = (path.parent / uri).resolve()
                self.assertTrue(target.exists())
                if uri.endswith(".json"):
                    self.assertNotIn("children", tile)
                    if target in generated:
                        visit(target)

        visit(entry, True)
        self.assertEqual(visited, generated)

    def test_external_stage_leaves_have_nested_request_volumes(self) -> None:
        _, result = self.build()
        stages = {}
        for path_value in result["sidecarPaths"]:
            document = json.loads(Path(path_value).read_text())
            stages[document["asset"]["extras"]["oneLodTreeStage"]] = document

        overview_leaf = next(
            tile for tile in walk_tiles(stages["overview"]["root"])
            if tile.get("content", {}).get("uri", "").endswith(".json")
        )
        explore_leaf = next(
            tile for tile in walk_tiles(stages["explore"]["root"])
            if tile.get("content", {}).get("uri", "").endswith(".json")
        )
        entry_leaf = next(
            tile for tile in stages["entry"]["root"]["children"]
            if tile.get("content", {}).get("uri", "").endswith(SIDECAR_NAME)
        )
        self.assertNotIn("viewerRequestVolume", entry_leaf)
        self.assertEqual(len(overview_leaf["viewerRequestVolume"]["box"]), 12)
        self.assertEqual(len(explore_leaf["viewerRequestVolume"]["box"]), 12)

        overview_vertical = math.dist([0, 0, 0], overview_leaf["viewerRequestVolume"]["box"][9:12])
        explore_vertical = math.dist([0, 0, 0], explore_leaf["viewerRequestVolume"]["box"][9:12])
        self.assertGreater(overview_vertical, explore_vertical)

    def test_omitting_area_builds_every_manifest_area(self) -> None:
        paths = build_fake_dataset(self.temp)
        add_second_area(paths)
        result = build_one_lod_tree(self.temp, "TestDataset")
        self.assertEqual(result["areaCount"], 2)
        self.assertEqual(result["areaIds"], ["area-001", "area-002"])
        self.assertEqual(len(result["sidecarPaths"]), 7)
        self.assertTrue(all(Path(path).exists() for path in result["sidecarPaths"]))

        entry = json.loads(Path(result["outputPath"]).read_text())
        self.assertEqual(entry["asset"]["extras"]["areaCount"], 2)
        self.assertTrue(all(
            child["content"]["uri"].endswith(SIDECAR_NAME)
            for child in entry["root"]["children"]
        ))

    def test_entry_rewrites_only_target_chunk(self) -> None:
        _, result = self.build()
        entry = json.loads(Path(result["outputPath"]).read_text())
        children = entry["root"]["children"]
        target = next(child for child in children if "chunk--1_-1" in child["content"]["uri"])
        other = next(child for child in children if "chunk--1_-2" in child["content"]["uri"])
        self.assertTrue(target["content"]["uri"].endswith(SIDECAR_NAME))
        self.assertEqual(target["refine"], "REPLACE")
        self.assertNotIn("children", target)
        self.assertTrue(other["content"]["uri"].endswith("tileset.json"))
        self.assertFalse(other["content"]["uri"].endswith(SIDECAR_NAME))

    def test_stage_content_is_preserved_without_inventing_explore_root_packed(self) -> None:
        _, result = self.build()
        by_stage = {}
        for path_value in result["sidecarPaths"]:
            path = Path(path_value)
            document = json.loads(path.read_text())
            by_stage[document["asset"]["extras"]["oneLodTreeStage"]] = (path, document)
        overview = by_stage["overview"][1]
        explore = by_stage["explore"][1]
        detail_path, detail = by_stage["detail"]
        self.assertEqual(overview["root"]["content"]["uri"], "points/root_packed.pnts")
        explore_uris = [tile.get("content", {}).get("uri", "") for tile in walk_tiles(explore["root"])]
        self.assertFalse(any("root_packed.pnts" in uri for uri in explore_uris))
        detail_uris = [tile.get("content", {}).get("uri", "") for tile in walk_tiles(detail["root"])]
        self.assertTrue(any("chunked-copc" in uri and uri.endswith("r0_0_0_0.pnts") for uri in detail_uris))
        self.assertTrue(all((detail_path.parent / uri).resolve().exists() for uri in detail_uris if uri))

    def test_rebuild_is_idempotent(self) -> None:
        _, first = self.build()
        before = {Path(path): Path(path).read_bytes() for path in first["sidecarPaths"]}
        second = build_one_lod_tree(self.temp, "TestDataset", "area-001")
        self.assertEqual(before, {Path(path): Path(path).read_bytes() for path in second["sidecarPaths"]})

    def test_bbox_failure_writes_no_sidecars(self) -> None:
        paths = build_fake_dataset(self.temp)
        explore = json.loads(paths["exploreChunk"].read_text())
        explore["root"]["boundingVolume"]["box"] = box(9999, 9999, 9999, 1, 1, 1)
        write_json(paths["exploreChunk"], explore)
        with self.assertRaises(SystemExit):
            build_one_lod_tree(self.temp, "TestDataset", "area-001", p02_tolerance=1)
        self.assertEqual(list(paths["logical"].rglob(SIDECAR_NAME)), [])

    def test_missing_source_writes_no_sidecars(self) -> None:
        paths = build_fake_dataset(self.temp)
        paths["detailSource"].unlink()
        with self.assertRaises(SystemExit):
            build_one_lod_tree(self.temp, "TestDataset", "area-001")
        self.assertEqual(list(paths["logical"].rglob(SIDECAR_NAME)), [])

    def test_public_root_layout(self) -> None:
        _, result = self.build(public_root="my-public-root")
        output = Path(result["outputPath"])
        self.assertEqual(output.name, SIDECAR_NAME)
        self.assertEqual(output.parent.name, "my-public-root-one-lod-tree")
        self.assertEqual(output.parent.parent.name, "my-public-root")


if __name__ == "__main__":
    unittest.main(verbosity=2)
