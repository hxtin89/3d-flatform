import argparse
import unittest
from types import SimpleNamespace

import numpy as np

from pipeline.copc_to_3dtiles import (
    clip_point_mask,
    parse_clip_bounds,
    prepare_record_bounds,
)
from pipeline.micro_detail import adaptive_cells, gate_reasons, raw_axis_bounds


class Header:
    offsets = np.asarray([0.0, 0.0, 0.0])
    scales = np.asarray([1.0, 1.0, 1.0])


class Points:
    def __init__(self, x, y, z):
        self.X = np.asarray(x, dtype=np.int32)
        self.Y = np.asarray(y, dtype=np.int32)
        self.Z = np.asarray(z, dtype=np.int32)


class ClipBoundsTests(unittest.TestCase):
    def test_parse_clip_bounds(self):
        mins, maxs = parse_clip_bounds("0,1,2,3,4,5")
        np.testing.assert_array_equal(mins, [0, 1, 2])
        np.testing.assert_array_equal(maxs, [3, 4, 5])

    def test_half_open_boundaries(self):
        points = Points([0, 1, 2], [0, 1, 2], [0, 0, 0])
        bounds = (np.asarray([0, 0, -1]), np.asarray([2, 2, 1]))
        left = clip_point_mask(points, Header(), bounds, False, False)
        outer = clip_point_mask(points, Header(), bounds, True, True)
        np.testing.assert_array_equal(left, [True, True, False])
        np.testing.assert_array_equal(outer, [True, True, True])

    def test_globe_clip_transforms_all_records_without_mixing_frames(self):
        class FakeGlobeFrame:
            is_globe = True

            @staticmethod
            def bounds_to_frame(mins, maxs):
                offset = np.asarray([442_000.0, 8_580_000.0, 200.0])
                return np.asarray(mins) - offset, np.asarray(maxs) - offset

        root = SimpleNamespace(
            bounds_mins=np.asarray([442_000.0, 8_580_000.0, 200.0]),
            bounds_maxs=np.asarray([443_000.0, 8_581_000.0, 400.0]),
        )
        child = SimpleNamespace(
            bounds_mins=np.asarray([442_250.0, 8_580_250.0, 225.0]),
            bounds_maxs=np.asarray([442_500.0, 8_580_500.0, 300.0]),
        )
        source_mins = np.asarray([442_075.0, 8_580_150.0, 234.0])
        source_maxs = np.asarray([442_325.0, 8_580_400.0, 307.0])

        root_mins, root_maxs = prepare_record_bounds(
            {(0, 0, 0, 0): root, (1, 0, 0, 0): child},
            root,
            FakeGlobeFrame(),
            source_mins,
            source_maxs,
            True,
        )

        np.testing.assert_array_equal(root_mins, [75.0, 150.0, 34.0])
        np.testing.assert_array_equal(root_maxs, [325.0, 400.0, 107.0])
        np.testing.assert_array_equal(child.bounds_mins, [250.0, 250.0, 25.0])
        self.assertLess(float(root_maxs.max()), 1_000.0)


class PartitionTests(unittest.TestCase):
    def test_base_grid_is_deterministic_and_complete(self):
        counts = np.ones((16, 16), dtype=np.int64)
        bounds = raw_axis_bounds(0, 15, 16)
        cells = adaptive_cells(counts, 0, 10, bounds, bounds, 2, 4, 1_000)
        self.assertEqual(len(cells), 16)
        self.assertEqual(sum(cell.point_count for cell in cells), 256)
        self.assertEqual(cells[0].micro_area_id, "micro-d2-x0-y0")
        self.assertTrue(cells[-1].include_max_x)
        self.assertTrue(cells[-1].include_max_y)

    def test_dense_base_cell_splits(self):
        counts = np.ones((16, 16), dtype=np.int64)
        counts[0:4, 0:4] = 100
        bounds = raw_axis_bounds(0, 15, 16)
        cells = adaptive_cells(counts, 0, 10, bounds, bounds, 2, 4, 500)
        self.assertGreater(len(cells), 16)
        self.assertTrue(any(cell.depth > 2 for cell in cells))
        self.assertTrue(all(cell.point_count <= 500 for cell in cells))


class GateTests(unittest.TestCase):
    def setUp(self):
        self.args = argparse.Namespace(
            max_tiles=250,
            min_average_tile_bytes=250 * 1024,
            hard_max_tile_bytes=5 * 1024 * 1024,
        )
        self.metrics = {
            "pointCount": 5_000_000,
            "sourcePointCount": 5_000_000,
            "actualDensityRatio": 1.0,
            "tileCount": 150,
            "averageTileBytes": 512 * 1024,
            "largestTileBytes": 2 * 1024 * 1024,
            "targetTileBytes": 512 * 1024,
            "missingContentUris": [],
            "geometricErrorViolations": [],
        }

    def test_valid_candidate_passes(self):
        self.assertEqual(gate_reasons(self.metrics, 5_000_000, self.args), [])

    def test_small_tiles_and_too_many_tiles_fail(self):
        self.metrics["tileCount"] = 251
        self.metrics["averageTileBytes"] = 100 * 1024
        reasons = gate_reasons(self.metrics, 5_000_000, self.args)
        self.assertIn("tile_count_gt_max", reasons)
        self.assertIn("average_tile_bytes_lt_min", reasons)

    def test_target_bytes_outside_gate_fails(self):
        self.metrics["targetTileBytes"] = 800 * 1024
        self.assertIn(
            "target_tile_bytes_out_of_range",
            gate_reasons(self.metrics, 5_000_000, self.args),
        )


if __name__ == "__main__":
    unittest.main()
