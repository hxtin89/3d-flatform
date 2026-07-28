from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).parent.parent / "build_adaptive_point_hierarchy_tileset.py"
SPEC = importlib.util.spec_from_file_location("build_adaptive_point_hierarchy_tileset", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class BoundsAndErrorTests(unittest.TestCase):
    def test_union_and_containment(self) -> None:
        union = MODULE.union_bounds([[0, 1, 2, 3, 4, 5], [-1, 2, 0, 4, 3, 6]])
        self.assertEqual(union, [-1, 1, 0, 4, 4, 6])
        self.assertTrue(MODULE.contains(union, [0, 2, 1, 3, 3, 5]))

    def test_internal_error_is_strictly_above_child(self) -> None:
        self.assertGreater(MODULE.corrected_error(0.1, [2.0]), 2.0)
        self.assertEqual(MODULE.corrected_error(100.0, []), 0.0)

    def test_frontier_minimum_dimensions(self) -> None:
        box = MODULE.frontier_volume([0, 0, 0, 10, 20, 30])
        self.assertGreaterEqual(box[3] * 2, 100)
        self.assertGreaterEqual(box[7] * 2, 100)
        self.assertGreaterEqual(box[11] * 2, 200)


class Z0DocumentTests(unittest.TestCase):
    def manifest(self) -> dict:
        return {
            "z0Id": "z0_x000000_y000000",
            "p001": {"pointCount": 10, "contentBounds": [0, 0, 0, 20, 20, 10],
                     "pntsUri": "points/z0/z0_x000000_y000000.pnts"},
            "nodes": [
                {"nodeId": "z0_x000000_y000000/d0_q", "parent": None,
                 "children": ["z0_x000000_y000000/d1_q0"], "depth": 0, "pointCount": 10,
                 "kind": "internal", "inputPointCount": 15, "emittedPointCount": 10,
                 "representativePointCount": 10, "residualRoutedPointCount": 5,
                 "contentBounds": [0, 0, 0, 10, 10, 10], "pntsUri": "points/adaptive/z0/d0_q.pnts"},
                {"nodeId": "z0_x000000_y000000/d1_q0", "parent": "z0_x000000_y000000/d0_q",
                 "children": [], "depth": 1, "pointCount": 5,
                 "kind": "leaf", "inputPointCount": 5, "emittedPointCount": 5,
                 "underfilledReason": "sparseSpatialBranch",
                 "leafDiagnostics": {"extentMeters": {"width": 5, "height": 5, "zSpan": 5},
                                     "bboxDensityPointsPerSquareMeter": 0.2, "bboxAreaClamped": False},
                 "contentBounds": [0, 0, 0, 5, 5, 5], "pntsUri": "points/adaptive/z0/d1_q0.pnts"},
            ],
        }

    def test_add_tree_and_leaf_zero_error(self) -> None:
        doc, bounds, error, count = MODULE.build_z0_document(self.manifest(), 2.0, "none")
        self.assertEqual(doc["root"]["refine"], "ADD")
        adaptive = doc["root"]["children"][0]
        self.assertGreater(adaptive["geometricError"], 0)
        self.assertEqual(adaptive["children"][0]["geometricError"], 0)
        self.assertEqual(bounds, [0, 0, 0, 20, 20, 10])
        self.assertEqual(count, 3)

    def test_vrv_only_at_depth_five(self) -> None:
        manifest = self.manifest()
        manifest["nodes"][1]["depth"] = 5
        doc, *_ = MODULE.build_z0_document(manifest, 2.0, "frontier-tight")
        self.assertIn("viewerRequestVolume", doc["root"]["children"][0]["children"][0])

    def test_compact_extras_and_uri_metadata_map(self) -> None:
        manifest = self.manifest()
        doc, *_ = MODULE.build_z0_document(manifest, 2.0, "none")
        adaptive = doc["root"]["children"][0]
        self.assertEqual(adaptive["extras"]["aph"]["kind"], "internal")
        leaf = adaptive["children"][0]["extras"]["aph"]
        self.assertEqual(leaf["underfilledReason"], "sparseSpatialBranch")
        self.assertNotIn("extentMeters", adaptive["extras"]["aph"])
        metadata_map = MODULE.build_z0_metadata_map(manifest)
        self.assertIn("points/adaptive/z0/d1_q0.pnts", metadata_map["entries"])
        self.assertEqual(metadata_map["entries"]["points/adaptive/z0/d1_q0.pnts"]["nodeId"], leaf["nodeId"])
        self.assertGreater(MODULE.aph_metadata_byte_delta(doc), 0)


if __name__ == "__main__":
    unittest.main()
