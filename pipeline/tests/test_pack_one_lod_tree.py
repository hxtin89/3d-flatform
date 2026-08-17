#!/usr/bin/env python3
"""Tests for the one-lod-tree upload packer."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from pipeline.pack_one_lod_tree import PACK_SIDECARS_DIR, pack_one_lod_tree
from pipeline.tests.test_build_one_lod_tree import (
    build_fake_dataset,
    build_one_lod_tree,
    walk_tiles,
)


def assert_sidecar_package(test: unittest.TestCase, entry_path: Path, package_dir: Path) -> list[str]:
    package_root = package_dir.resolve()
    tilesets_root = package_root.parent.resolve()
    visited: set[Path] = set()
    uris: list[str] = []

    def visit(path: Path) -> None:
        path = path.resolve()
        if path in visited:
            return
        visited.add(path)
        test.assertTrue(path.is_relative_to(package_root), path)
        document = json.loads(path.read_text())
        for tile in walk_tiles(document["root"]):
            uri = tile.get("content", {}).get("uri")
            if not uri:
                continue
            uris.append(uri)
            test.assertFalse(Path(uri.split("?", 1)[0]).is_absolute(), uri)
            test.assertNotIn(str(package_root.parent), uri)
            target = (path.parent / uri.split("?", 1)[0]).resolve()
            test.assertTrue(target.exists(), target)
            test.assertTrue(target.is_relative_to(tilesets_root), target)
            if uri.split("?", 1)[0].endswith("tileset-one-lod-tree.json"):
                test.assertTrue(target.is_relative_to(package_root), target)
                visit(target)
            else:
                test.assertFalse(target.is_relative_to(package_root), target)

    visit(entry_path)
    return uris


class OneLodTreePackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="one-lod-pack-test-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_packs_chain_into_one_lod_tree_folder(self) -> None:
        build_fake_dataset(self.temp)
        build_one_lod_tree(self.temp, "TestDataset", "area-001")

        result = pack_one_lod_tree(self.temp, "TestDataset")

        package_dir = Path(result["packageDir"])
        entry_path = Path(result["outputPath"])
        self.assertEqual(package_dir.name, "TestDataset-one-lod-tree")
        self.assertEqual(entry_path.parent, package_dir)
        self.assertTrue((package_dir / PACK_SIDECARS_DIR).is_dir())

        entry = json.loads(entry_path.read_text())
        first_uri = entry["root"]["children"][0]["content"]["uri"]
        self.assertTrue(first_uri.startswith(f"{PACK_SIDECARS_DIR}/"), first_uri)
        uris = assert_sidecar_package(self, entry_path, package_dir)
        self.assertTrue(any(uri.endswith(".pnts") for uri in uris))
        self.assertGreaterEqual(result["jsonFileCount"], 4)
        self.assertGreaterEqual(result["externalReferenceCount"], 6)
        self.assertFalse(any((package_dir / PACK_SIDECARS_DIR).rglob("*.pnts")))

    def test_repacking_does_not_nest_sidecars(self) -> None:
        build_fake_dataset(self.temp)
        build_one_lod_tree(self.temp, "TestDataset", "area-001")

        first = pack_one_lod_tree(self.temp, "TestDataset")
        first_entry = json.loads(Path(first["outputPath"]).read_text())
        first_uri = first_entry["root"]["children"][0]["content"]["uri"]

        second = pack_one_lod_tree(self.temp, "TestDataset")
        second_entry = json.loads(Path(second["outputPath"]).read_text())
        second_uri = second_entry["root"]["children"][0]["content"]["uri"]

        self.assertEqual(first_uri, second_uri)
        self.assertNotIn(
            f"{PACK_SIDECARS_DIR}/{Path(first['packageDir']).name}/{PACK_SIDECARS_DIR}",
            second_uri,
        )
        assert_sidecar_package(self, Path(second["outputPath"]), Path(second["packageDir"]))

    def test_recovers_from_deleted_legacy_assets_package(self) -> None:
        build_fake_dataset(self.temp)
        result = build_one_lod_tree(self.temp, "TestDataset", "area-001")
        entry_path = Path(result["outputPath"])
        entry = json.loads(entry_path.read_text())
        entry["root"]["children"][0]["content"]["uri"] = (
            "assets/TestDataset-overview-p02/chunks/chunk--1_-1/tileset-one-lod-tree.json"
        )
        entry_path.write_text(json.dumps(entry), encoding="utf-8")

        packed = pack_one_lod_tree(self.temp, "TestDataset")

        packed_entry = json.loads(Path(packed["outputPath"]).read_text())
        first_uri = packed_entry["root"]["children"][0]["content"]["uri"]
        self.assertTrue(first_uri.startswith(f"{PACK_SIDECARS_DIR}/"), first_uri)
        assert_sidecar_package(self, Path(packed["outputPath"]), Path(packed["packageDir"]))

    def test_rejects_remote_uri(self) -> None:
        paths = build_fake_dataset(self.temp)
        overview_chunk = json.loads(paths["overviewChunk"].read_text())
        overview_chunk["root"]["content"]["uri"] = "https://example.com/root.pnts"
        paths["overviewChunk"].write_text(json.dumps(overview_chunk), encoding="utf-8")

        with self.assertRaises(SystemExit):
            pack_one_lod_tree(self.temp, "TestDataset")


if __name__ == "__main__":
    unittest.main(verbosity=2)
