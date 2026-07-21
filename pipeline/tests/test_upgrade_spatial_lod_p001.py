#!/usr/bin/env python3
"""Tests for Spatial LOD p001 upgrade metadata rewrites."""
from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent.parent
SPATIAL_PATH = ROOT / "build_spatial_lod_tree.py"
UPGRADE_PATH = ROOT / "upgrade_spatial_lod_p001.py"

SPATIAL_SPEC = importlib.util.spec_from_file_location("build_spatial_lod_tree", SPATIAL_PATH)
assert SPATIAL_SPEC and SPATIAL_SPEC.loader
SPATIAL = importlib.util.module_from_spec(SPATIAL_SPEC)
sys.modules["build_spatial_lod_tree"] = SPATIAL
SPATIAL_SPEC.loader.exec_module(SPATIAL)

UPGRADE_SPEC = importlib.util.spec_from_file_location("upgrade_spatial_lod_p001", UPGRADE_PATH)
assert UPGRADE_SPEC and UPGRADE_SPEC.loader
UPGRADE = importlib.util.module_from_spec(UPGRADE_SPEC)
UPGRADE_SPEC.loader.exec_module(UPGRADE)


class UpgradeSpatialLodMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="spatial-lod-upgrade-test-"))
        self.z0_dir = self.temp / "z0" / "z0_x000000_y000000"
        self.z0_dir.mkdir(parents=True)
        (self.temp / "points" / "z4").mkdir(parents=True)
        (self.temp / "points" / "z4" / "z4_x000000_y000000.pnts").write_bytes(b"stub")
        self.z0_path = self.z0_dir / "tileset.json"

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def z0_doc(self, viewer_request_volume: list[float] | None = None) -> dict:
        z4: dict = {
            "boundingVolume": {
                "box": SPATIAL.box_for_cell("z4", 0, 0, 0.0, 0.0, SPATIAL.Z4_CELL, 0.0, 20.0)
            },
            "geometricError": SPATIAL.LEVEL_BY_NAME["z4"].error,
            "refine": "REPLACE",
            "content": {"uri": "../../points/z4/z4_x000000_y000000.pnts"},
        }
        if viewer_request_volume is not None:
            z4["viewerRequestVolume"] = {"box": viewer_request_volume}
        return {
            "asset": {"version": "1.0"},
            "geometricError": SPATIAL.LEVEL_BY_NAME["z0"].error,
            "root": {
                "boundingVolume": {
                    "box": SPATIAL.box_for_cell("z0", 0, 0, 0.0, 0.0, SPATIAL.Z0_CELL, 0.0, 20.0)
                },
                "geometricError": SPATIAL.LEVEL_BY_NAME["z0"].error,
                "refine": "REPLACE",
                "children": [
                    {
                        "boundingVolume": {
                            "box": SPATIAL.box_for_cell("z1", 0, 0, 0.0, 0.0, SPATIAL.Z1_CELL, 0.0, 20.0)
                        },
                        "geometricError": SPATIAL.LEVEL_BY_NAME["z1"].error,
                        "refine": "REPLACE",
                        "children": [
                            {
                                "boundingVolume": {
                                    "box": SPATIAL.box_for_cell("z2", 0, 0, 0.0, 0.0, SPATIAL.Z2_CELL, 0.0, 20.0)
                                },
                                "geometricError": SPATIAL.LEVEL_BY_NAME["z2"].error,
                                "refine": "REPLACE",
                                "children": [
                                    {
                                        "boundingVolume": {
                                            "box": SPATIAL.box_for_cell("z3", 0, 0, 0.0, 0.0, SPATIAL.Z3_CELL, 0.0, 20.0)
                                        },
                                        "geometricError": SPATIAL.LEVEL_BY_NAME["z3"].error,
                                        "refine": "REPLACE",
                                        "children": [z4],
                                    }
                                ],
                            }
                        ],
                    }
                ],
            },
        }

    def test_refresh_z4_request_volume_uses_new_z3_parent(self) -> None:
        doc = self.z0_doc(viewer_request_volume=[0.0] * 12)
        UPGRADE.refresh_z4_request_volumes(doc["root"], "z0", (0.0, 0.0))
        z4 = doc["root"]["children"][0]["children"][0]["children"][0]["children"][0]
        expected = SPATIAL.detail_request_volume("z3", 0, 0, 0.0, 0.0, 0.0, 20.0)
        self.assertEqual(z4["viewerRequestVolume"]["box"], expected)

    def test_validate_rejects_missing_z4_request_volume(self) -> None:
        with self.assertRaises(SystemExit):
            UPGRADE.validate_z0_doc_fast(self.z0_path, self.z0_doc(), grid_origin=(0.0, 0.0))

    def test_validate_rejects_wrong_z4_request_volume(self) -> None:
        with self.assertRaises(SystemExit):
            UPGRADE.validate_z0_doc_fast(self.z0_path, self.z0_doc([0.0] * 12), grid_origin=(0.0, 0.0))

    def test_validate_accepts_refreshed_z4_request_volume(self) -> None:
        doc = self.z0_doc([0.0] * 12)
        UPGRADE.refresh_z4_request_volumes(doc["root"], "z0", (0.0, 0.0))
        UPGRADE.validate_z0_doc_fast(self.z0_path, doc, grid_origin=(0.0, 0.0))

    def test_refresh_output_rewrites_existing_z0_documents(self) -> None:
        self.z0_path.write_text(json.dumps(self.z0_doc([0.0] * 12)), encoding="utf-8")
        report_path = self.temp / SPATIAL.REPORT_NAME
        report_path.write_text(
            json.dumps({"requestVolumePolicy": {"xyScale": 1.5}}),
            encoding="utf-8",
        )
        entry = {
            "asset": {"version": "1.0", "extras": {"gridOrigin": [0.0, 0.0]}},
            "root": {
                "transform": [1.0, 0.0, 0.0, 0.0] * 4,
                "refine": "REPLACE",
                "geometricError": SPATIAL.LEVEL_BY_NAME["z0"].error,
                "children": [
                    {
                        "geometricError": SPATIAL.LEVEL_BY_NAME["z0"].error,
                        "content": {"uri": "z0/z0_x000000_y000000/tileset.json"},
                    }
                ],
            },
        }
        UPGRADE.refresh_output_z4_request_volumes(self.temp, entry)
        rewritten = json.loads(self.z0_path.read_text(encoding="utf-8"))
        z4 = rewritten["root"]["children"][0]["children"][0]["children"][0]["children"][0]
        expected = SPATIAL.detail_request_volume("z3", 0, 0, 0.0, 0.0, 0.0, 20.0)
        self.assertEqual(z4["viewerRequestVolume"]["box"], expected)
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertEqual(report["requestVolumePolicy"], SPATIAL.request_volume_policy())


if __name__ == "__main__":
    unittest.main()
