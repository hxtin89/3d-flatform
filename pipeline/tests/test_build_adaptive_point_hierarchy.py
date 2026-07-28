#!/usr/bin/env python3
"""Tests for the Adaptive Point Hierarchy (APH) pipeline foundation (Plan 1)."""
from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np


MODULE_PATH = Path(__file__).parent.parent / "build_adaptive_point_hierarchy.py"
SPEC = importlib.util.spec_from_file_location("build_adaptive_point_hierarchy", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules["build_adaptive_point_hierarchy"] = MODULE
SPEC.loader.exec_module(MODULE)


def fake_transform() -> list[float]:
    return [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        100.0, 200.0, 300.0, 1.0,
    ]


def fake_preflight_result(record_name: str = "chunk-0.copc.laz", total_points: int = 1000) -> dict:
    return {
        "files": [],
        "records": [{"name": record_name, "size": 10, "mtime_ns": 1, "fingerprint": "abc"}],
        "crs_wkt": "fake-crs",
        "has_rgb": True,
        "source_mins": np.array([0.0, 0.0, 0.0]),
        "source_maxs": np.array([1.0, 1.0, 1.0]),
        "total_points": total_points,
    }


def fake_frame() -> dict:
    return {
        "root_transform": fake_transform(),
        "enu_origin_lonlat": (-69.0, -12.0, 50.0),
        "enu_origin_ecef": np.array([100.0, 200.0, 300.0]),
    }


class Z0AddressingTests(unittest.TestCase):
    def test_boundary_belongs_to_higher_index(self) -> None:
        self.assertEqual(MODULE.z0_cell_index(0.0, 0.0, 2000.0), 0)
        self.assertEqual(MODULE.z0_cell_index(2000.0, 0.0, 2000.0), 1)
        self.assertEqual(MODULE.z0_cell_index(-2000.0, 0.0, 2000.0), -1)
        self.assertEqual(MODULE.z0_cell_index(1999.99, 0.0, 2000.0), 0)

    def test_tile_id_format_matches_spatial_lod_convention(self) -> None:
        self.assertEqual(MODULE.z0_tile_id(12, 8), "z0_x000012_y000008")
        self.assertEqual(MODULE.z0_tile_id(-3, -1), "z0_x-00003_y-00001")

    def test_z0_bounds(self) -> None:
        self.assertEqual(MODULE.z0_bounds(1, -1, 0.0, 0.0, 2000.0), (2000.0, -2000.0, 4000.0, 0.0))


class QuadrantRoutingTests(unittest.TestCase):
    def test_center_line_goes_east_north(self) -> None:
        self.assertEqual(MODULE.quadrant_for_point(0.0, 0.0, 0.0, 0.0), MODULE.QUAD_EAST_NORTH)
        self.assertEqual(MODULE.quadrant_for_point(0.0, -1.0, 0.0, 0.0), MODULE.QUAD_EAST_SOUTH)
        self.assertEqual(MODULE.quadrant_for_point(-1.0, 0.0, 0.0, 0.0), MODULE.QUAD_WEST_NORTH)

    def test_four_quadrants(self) -> None:
        self.assertEqual(MODULE.quadrant_for_point(-1.0, -1.0, 0.0, 0.0), MODULE.QUAD_WEST_SOUTH)
        self.assertEqual(MODULE.quadrant_for_point(1.0, -1.0, 0.0, 0.0), MODULE.QUAD_EAST_SOUTH)
        self.assertEqual(MODULE.quadrant_for_point(-1.0, 1.0, 0.0, 0.0), MODULE.QUAD_WEST_NORTH)
        self.assertEqual(MODULE.quadrant_for_point(1.0, 1.0, 0.0, 0.0), MODULE.QUAD_EAST_NORTH)


class NominalBoundsTests(unittest.TestCase):
    def test_empty_path_is_full_z0_cell(self) -> None:
        self.assertEqual(MODULE.nominal_bounds_for_path(0.0, 0.0, 2000.0, 2000.0, ()), (0.0, 0.0, 2000.0, 2000.0))

    def test_single_digit_bisection(self) -> None:
        self.assertEqual(
            MODULE.nominal_bounds_for_path(0.0, 0.0, 2000.0, 2000.0, (MODULE.QUAD_EAST_NORTH,)),
            (1000.0, 1000.0, 2000.0, 2000.0),
        )
        self.assertEqual(
            MODULE.nominal_bounds_for_path(0.0, 0.0, 2000.0, 2000.0, (MODULE.QUAD_WEST_SOUTH,)),
            (0.0, 0.0, 1000.0, 1000.0),
        )

    def test_deterministic_regardless_of_data(self) -> None:
        path = (MODULE.QUAD_EAST_SOUTH, MODULE.QUAD_WEST_NORTH, MODULE.QUAD_EAST_NORTH)
        a = MODULE.nominal_bounds_for_path(-500.0, 300.0, 1500.0, 2300.0, path)
        b = MODULE.nominal_bounds_for_path(-500.0, 300.0, 1500.0, 2300.0, path)
        self.assertEqual(a, b)

    def test_center_matches_nominal_center_helper(self) -> None:
        bounds = MODULE.nominal_bounds_for_path(0.0, 0.0, 2000.0, 2000.0, (MODULE.QUAD_WEST_SOUTH,))
        self.assertEqual(MODULE.nominal_center(bounds), (500.0, 500.0))


class NodePolicyTests(unittest.TestCase):
    def test_leaf_when_under_leaf_max(self) -> None:
        self.assertEqual(MODULE.decide_node_kind(100_000, 0, 11, 110_000, 150_000), MODULE.NODE_KIND_LEAF)

    def test_internal_when_over_leaf_max_and_depth_remains(self) -> None:
        self.assertEqual(MODULE.decide_node_kind(200_000, 3, 11, 110_000, 150_000), MODULE.NODE_KIND_INTERNAL)

    def test_leaf_max_depth_when_at_max_depth_within_hard_max(self) -> None:
        self.assertEqual(
            MODULE.decide_node_kind(140_000, 11, 11, 110_000, 150_000), MODULE.NODE_KIND_LEAF_MAX_DEPTH
        )

    def test_fail_when_at_max_depth_over_hard_max(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.decide_node_kind(160_000, 11, 11, 110_000, 150_000)

    def test_leaf_takes_precedence_at_max_depth(self) -> None:
        self.assertEqual(MODULE.decide_node_kind(50_000, 11, 11, 110_000, 150_000), MODULE.NODE_KIND_LEAF)


class MicrocellIndexTests(unittest.TestCase):
    def test_basic_grid_placement(self) -> None:
        bounds = (0.0, 0.0, 160.0, 160.0)
        self.assertEqual(MODULE.microcell_index(0.0, 0.0, bounds, 16), 0)
        self.assertEqual(MODULE.microcell_index(159.9, 159.9, bounds, 16), 16 * 16 - 1)
        self.assertEqual(MODULE.microcell_index(80.0, 0.0, bounds, 16), 8)

    def test_clamped_at_upper_edge(self) -> None:
        bounds = (0.0, 0.0, 160.0, 160.0)
        self.assertEqual(MODULE.microcell_index(160.0, 160.0, bounds, 16), 16 * 16 - 1)

    def test_batch_matches_scalar(self) -> None:
        bounds = (0.0, 0.0, 160.0, 160.0)
        xs = np.array([0.0, 80.0, 159.9])
        ys = np.array([0.0, 0.0, 159.9])
        batch = MODULE.microcell_index_batch(xs, ys, bounds, 16)
        scalar = [MODULE.microcell_index(float(x), float(y), bounds, 16) for x, y in zip(xs, ys)]
        self.assertEqual(batch.tolist(), scalar)


class QuotaAllocationTests(unittest.TestCase):
    def test_sum_matches_quota_total_when_capacity_allows(self) -> None:
        counts = {0: 1000, 1: 2000, 2: 500, 3: 50}
        alloc = MODULE.allocate_representative_quota(counts, 300)
        self.assertEqual(sum(alloc.values()), 300)

    def test_every_occupied_cell_gets_at_least_one(self) -> None:
        counts = {0: 1000, 5: 1, 9: 3000}
        alloc = MODULE.allocate_representative_quota(counts, 100)
        for c in counts:
            self.assertGreaterEqual(alloc[c], 1)

    def test_capacity_capped(self) -> None:
        counts = {0: 2, 1: 100000}
        alloc = MODULE.allocate_representative_quota(counts, 50000)
        self.assertLessEqual(alloc[0], counts[0])
        self.assertLessEqual(alloc[1], counts[1])
        self.assertEqual(sum(alloc.values()), 50000)

    def test_quota_exceeding_total_count_returns_full_counts(self) -> None:
        counts = {0: 10, 1: 20}
        alloc = MODULE.allocate_representative_quota(counts, 1000)
        self.assertEqual(alloc, counts)

    def test_quota_below_cell_count_ties_break_by_index(self) -> None:
        counts = {5: 10, 2: 10, 8: 10}
        alloc = MODULE.allocate_representative_quota(counts, 2)
        chosen = {c for c, v in alloc.items() if v == 1}
        self.assertEqual(chosen, {2, 5})

    def test_deterministic_repeat(self) -> None:
        counts = {0: 137, 1: 4001, 2: 88, 3: 900, 4: 12345}
        a = MODULE.allocate_representative_quota(counts, 5000)
        b = MODULE.allocate_representative_quota(dict(counts), 5000)
        self.assertEqual(a, b)


class StableHashTests(unittest.TestCase):
    def test_deterministic_for_same_salt_and_ordinal(self) -> None:
        a = MODULE.stable_hash_one(42, 12345)
        b = MODULE.stable_hash_one(42, 12345)
        self.assertEqual(a, b)

    def test_differs_across_ordinals(self) -> None:
        a = MODULE.stable_hash_one(1, 12345)
        b = MODULE.stable_hash_one(2, 12345)
        self.assertNotEqual(a, b)

    def test_differs_across_salts(self) -> None:
        a = MODULE.stable_hash_one(1, 111)
        b = MODULE.stable_hash_one(1, 222)
        self.assertNotEqual(a, b)

    def test_batch_matches_scalar(self) -> None:
        ordinals = np.array([0, 1, 2, 1000, 999999], dtype=np.uint64)
        batch = MODULE.stable_hash_batch(ordinals, 777)
        scalar = [MODULE.stable_hash_one(int(o), 777) for o in ordinals]
        self.assertEqual(batch.tolist(), scalar)

    def test_fingerprint_salt_deterministic(self) -> None:
        records = [{"fingerprint": "b"}, {"fingerprint": "a"}]
        fp1 = MODULE.combined_source_fingerprint(records)
        fp2 = MODULE.combined_source_fingerprint(list(records))
        self.assertEqual(fp1, fp2)
        self.assertEqual(MODULE.fingerprint_salt(fp1), MODULE.fingerprint_salt(fp2))


class FragmentIoTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-fragment-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_append_and_read_roundtrip_with_rgb(self) -> None:
        path = self.temp / "frag.raw"
        xyz1 = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
        rgb1 = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.uint8)
        ord1 = np.array([10, 11], dtype=np.uint64)
        MODULE.append_fragment(path, xyz1, rgb1, ord1, has_rgb=True)

        xyz2 = np.array([[7.0, 8.0, 9.0]])
        rgb2 = np.array([[7, 8, 9]], dtype=np.uint8)
        ord2 = np.array([12], dtype=np.uint64)
        MODULE.append_fragment(path, xyz2, rgb2, ord2, has_rgb=True)

        self.assertEqual(MODULE.fragment_record_count(path, True), 3)
        batches = list(MODULE.iter_fragment_batches(path, True, batch_points=2))
        all_records = np.concatenate(batches)
        self.assertEqual(all_records["ordinal"].tolist(), [10, 11, 12])
        self.assertEqual(all_records["x"].tolist(), [1.0, 4.0, 7.0])
        self.assertEqual(all_records["r"].tolist(), [1, 4, 7])

    def test_roundtrip_without_rgb(self) -> None:
        path = self.temp / "frag-norgb.raw"
        xyz = np.array([[1.0, 2.0, 3.0]])
        ordv = np.array([5], dtype=np.uint64)
        MODULE.append_fragment(path, xyz, None, ordv, has_rgb=False)
        self.assertEqual(MODULE.fragment_record_count(path, False), 1)
        recs = next(iter(MODULE.iter_fragment_batches(path, False)))
        self.assertEqual(recs["ordinal"].tolist(), [5])

    def test_missing_fragment_is_empty(self) -> None:
        path = self.temp / "missing.raw"
        self.assertEqual(MODULE.fragment_record_count(path, True), 0)
        self.assertEqual(list(MODULE.iter_fragment_batches(path, True)), [])

    def test_appending_zero_points_is_noop(self) -> None:
        path = self.temp / "empty-append.raw"
        MODULE.append_fragment(path, np.empty((0, 3)), None, np.empty((0,), dtype=np.uint64), has_rgb=False)
        self.assertFalse(path.exists())

    def test_delete_fragment_is_idempotent(self) -> None:
        path = self.temp / "to-delete.raw"
        MODULE.append_fragment(path, np.array([[1.0, 1.0, 1.0]]), None, np.array([1], dtype=np.uint64), has_rgb=False)
        MODULE.delete_fragment(path)
        self.assertFalse(path.exists())
        MODULE.delete_fragment(path)  # no raise


class PntsWriterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-pnts-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_write_and_read_header_with_rgb(self) -> None:
        path = self.temp / "node.pnts"
        xyz = np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]])
        rgb = np.array([[10, 20, 30], [40, 50, 60]], dtype=np.uint8)
        MODULE.write_pnts_atomic(path, xyz, rgb, np.array([0.0, 0.0, 0.0]))
        header = MODULE.read_pnts_header(path)
        self.assertEqual(header["featureTable"]["POINTS_LENGTH"], 2)
        self.assertIn("RGB", header["featureTable"])
        self.assertEqual(header["byteLength"], path.stat().st_size)

    def test_write_from_records_matches_manual(self) -> None:
        path = self.temp / "from-records.pnts"
        dtype = MODULE.fragment_dtype(True)
        records = np.zeros(2, dtype=dtype)
        records["x"] = [10.0, 20.0]
        records["y"] = [10.0, 20.0]
        records["z"] = [10.0, 20.0]
        records["r"] = [1, 2]
        records["g"] = [3, 4]
        records["b"] = [5, 6]
        records["ordinal"] = [1, 2]
        MODULE.write_pnts_from_records(path, records, True, np.array([10.0, 10.0, 10.0]))
        header = MODULE.read_pnts_header(path)
        self.assertEqual(header["featureTable"]["POINTS_LENGTH"], 2)
        self.assertEqual(header["featureTable"]["RTC_CENTER"], [10.0, 10.0, 10.0])

    def test_without_rgb_has_no_rgb_field(self) -> None:
        path = self.temp / "no-rgb.pnts"
        xyz = np.array([[0.0, 0.0, 0.0]])
        MODULE.write_pnts_atomic(path, xyz, None, np.array([0.0, 0.0, 0.0]))
        header = MODULE.read_pnts_header(path)
        self.assertNotIn("RGB", header["featureTable"])


class OrdinalSidecarTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-ordsidecar-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_roundtrip(self) -> None:
        path = self.temp / "node.pnts.ord.u64"
        ords = np.array([5, 1, 3000000000], dtype=np.uint64)
        MODULE.write_ordinal_sidecar_atomic(path, ords)
        read_back = MODULE.read_ordinal_sidecar(path)
        self.assertEqual(read_back.tolist(), ords.tolist())

    def test_missing_sidecar_reads_empty(self) -> None:
        path = self.temp / "missing.ord.u64"
        self.assertEqual(MODULE.read_ordinal_sidecar(path).tolist(), [])

    def test_sidecar_path_naming(self) -> None:
        pnts_path = Path("/tmp/x/d3_q012.pnts")
        self.assertEqual(MODULE.ordinal_sidecar_path(pnts_path).name, "d3_q012.pnts.ord.u64")


def synth_points(
    n: int, minx: float = 0.0, miny: float = 0.0, maxx: float = 2000.0, maxy: float = 2000.0,
    minz: float = 0.0, maxz: float = 50.0, ordinal_start: int = 0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Deterministic pseudo-scatter (no RNG) covering the full bounds."""
    xs = minx + (np.arange(n) * 97 % 1000) / 1000.0 * (maxx - minx)
    ys = miny + (np.arange(n) * 53 % 1000) / 1000.0 * (maxy - miny)
    zs = minz + (np.arange(n) % 100) / 100.0 * (maxz - minz)
    xyz = np.column_stack((xs, ys, zs)).astype(np.float64)
    rgb = np.tile((np.arange(n) % 256).astype(np.uint8)[:, None], (1, 3))
    ordinals = (np.arange(n, dtype=np.uint64) + ordinal_start)
    return xyz, rgb, ordinals


TINY_PROFILE = {
    "internalTargetPoints": 40,
    "acceptableMinPoints": 10,
    "leafMaxPoints": 100,
    "hardMaxPoints": 150,
    "maxDepth": 4,
    "errorScale": 2.0,
    "microcellGrid": 4,
    "vrvMode": "both",
}


class AdaptiveQuadtreeBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-tree-"))
        self.fragments_dir = self.temp / "fragments"
        self.output_dir = self.temp / "points" / "adaptive" / "z0_x000000_y000000"

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def _seed_root(self, xyz: np.ndarray, rgb: np.ndarray, ordinals: np.ndarray) -> None:
        MODULE.append_fragment(self.fragments_dir / "root.raw", xyz, rgb, ordinals, has_rgb=True)

    def _build(self, profile: dict) -> list[dict]:
        return MODULE.build_z0_adaptive_tree(
            fragments_dir=self.fragments_dir,
            adaptive_output_dir=self.output_dir,
            z0_id="z0_x000000_y000000",
            z0_bounds_enu=(0.0, 0.0, 2000.0, 2000.0),
            has_rgb=True,
            cli_profile=profile,
            salt=12345,
        )

    def test_simple_leaf(self) -> None:
        xyz, rgb, ordinals = synth_points(50)
        self._seed_root(xyz, rgb, ordinals)
        manifest = self._build(TINY_PROFILE)
        self.assertEqual(len(manifest), 1)
        entry = manifest[0]
        self.assertEqual(entry["kind"], MODULE.NODE_KIND_LEAF)
        self.assertEqual(entry["pointCount"], 50)
        self.assertEqual(entry["inputPointCount"], 50)
        self.assertEqual(entry["emittedPointCount"], 50)
        self.assertNotIn("residualRoutedPointCount", entry)
        self.assertIn("leafDiagnostics", entry)
        self.assertEqual(entry["children"], [])
        self.assertIsNone(entry["parent"])
        pnts_path = self.output_dir / "d0_q.pnts"
        self.assertTrue(pnts_path.exists())
        header = MODULE.read_pnts_header(pnts_path)
        self.assertEqual(header["featureTable"]["POINTS_LENGTH"], 50)
        sidecar = MODULE.read_ordinal_sidecar(MODULE.ordinal_sidecar_path(pnts_path))
        self.assertEqual(sorted(sidecar.tolist()), list(range(50)))

    def test_sparse_leaf_flagged_underfilled(self) -> None:
        xyz, rgb, ordinals = synth_points(5)
        self._seed_root(xyz, rgb, ordinals)
        manifest = self._build(TINY_PROFILE)
        self.assertEqual(manifest[0]["underfilledReason"], "sparseSpatialBranch")

    def test_well_filled_leaf_has_no_underfilled_reason(self) -> None:
        xyz, rgb, ordinals = synth_points(50)
        self._seed_root(xyz, rgb, ordinals)
        manifest = self._build(TINY_PROFILE)
        self.assertIsNone(manifest[0]["underfilledReason"])

    def test_internal_node_splits_and_children_present(self) -> None:
        xyz, rgb, ordinals = synth_points(500)
        self._seed_root(xyz, rgb, ordinals)
        manifest = self._build(TINY_PROFILE)
        by_id = {m["nodeId"]: m for m in manifest}
        root = by_id["z0_x000000_y000000/d0_q"]
        self.assertEqual(root["kind"], MODULE.NODE_KIND_INTERNAL)
        self.assertGreater(len(root["children"]), 0)
        # pointCount for an internal node is what IT owns (its own representative
        # content), not the incoming subtree total — matches contentBounds/PNTS,
        # which are also derived from the node's own emitted records.
        self.assertEqual(root["pointCount"], root["samplingStats"]["representativePointCount"])
        self.assertEqual(root["inputPointCount"], root["emittedPointCount"] + root["residualRoutedPointCount"])
        self.assertLessEqual(root["pointCount"], TINY_PROFILE["internalTargetPoints"])
        for child_id in root["children"]:
            self.assertIn(child_id, by_id)
            self.assertEqual(by_id[child_id]["parent"], root["nodeId"])

    def test_no_data_loss_or_duplication_across_tree(self) -> None:
        n = 2000
        xyz, rgb, ordinals = synth_points(n)
        self._seed_root(xyz, rgb, ordinals)
        manifest = self._build(TINY_PROFILE)

        self.assertEqual(sum(m["pointCount"] for m in manifest), n)
        ownership = MODULE.validate_adaptive_manifest_ownership(manifest, n)
        self.assertEqual(ownership["emittedPointCount"], n)

        all_ordinals: list[int] = []
        for entry in manifest:
            pnts_path = self.output_dir / (entry["pntsUri"].split("/")[-1])
            sidecar = MODULE.read_ordinal_sidecar(MODULE.ordinal_sidecar_path(pnts_path))
            self.assertEqual(len(sidecar), entry["pointCount"])
            all_ordinals.extend(int(o) for o in sidecar.tolist())

        self.assertEqual(len(all_ordinals), n)
        self.assertEqual(len(set(all_ordinals)), n)  # no duplicates
        self.assertEqual(sorted(all_ordinals), list(range(n)))  # no omissions

        # No leftover fragment files: every node's fragment is consumed+deleted.
        leftover = list(self.fragments_dir.glob("*.raw")) if self.fragments_dir.exists() else []
        self.assertEqual(leftover, [])

    def test_p95_and_max_structural_gate(self) -> None:
        n = 2000
        xyz, rgb, ordinals = synth_points(n)
        self._seed_root(xyz, rgb, ordinals)
        manifest = self._build(TINY_PROFILE)
        counts = sorted(m["pointCount"] for m in manifest if m["kind"] != MODULE.NODE_KIND_INTERNAL)
        p95 = counts[int(0.95 * (len(counts) - 1))]
        self.assertLessEqual(p95, TINY_PROFILE["leafMaxPoints"])
        self.assertLessEqual(max(counts), TINY_PROFILE["hardMaxPoints"])

    def test_deterministic_repeat_build(self) -> None:
        n = 800
        xyz, rgb, ordinals = synth_points(n)

        fragments_a = self.temp / "fragments-a"
        output_a = self.temp / "out-a"
        MODULE.append_fragment(fragments_a / "root.raw", xyz, rgb, ordinals, has_rgb=True)
        manifest_a = MODULE.build_z0_adaptive_tree(
            fragments_dir=fragments_a, adaptive_output_dir=output_a, z0_id="z0_x000000_y000000",
            z0_bounds_enu=(0.0, 0.0, 2000.0, 2000.0), has_rgb=True, cli_profile=TINY_PROFILE, salt=999,
        )

        fragments_b = self.temp / "fragments-b"
        output_b = self.temp / "out-b"
        MODULE.append_fragment(fragments_b / "root.raw", xyz, rgb, ordinals, has_rgb=True)
        manifest_b = MODULE.build_z0_adaptive_tree(
            fragments_dir=fragments_b, adaptive_output_dir=output_b, z0_id="z0_x000000_y000000",
            z0_bounds_enu=(0.0, 0.0, 2000.0, 2000.0), has_rgb=True, cli_profile=TINY_PROFILE, salt=999,
        )

        def normalize(manifest: list[dict]) -> list[tuple]:
            return sorted(
                (m["nodeId"], m["kind"], m["pointCount"], tuple(sorted(m["children"])))
                for m in manifest
            )

        self.assertEqual(normalize(manifest_a), normalize(manifest_b))
        for m in manifest_a:
            pnts_a = (output_a / (m["pntsUri"].split("/")[-1])).read_bytes()
            pnts_b = (output_b / (m["pntsUri"].split("/")[-1])).read_bytes()
            self.assertEqual(pnts_a, pnts_b)

    def test_max_depth_leaf_kind(self) -> None:
        profile = dict(TINY_PROFILE)
        profile["maxDepth"] = 1
        profile["leafMaxPoints"] = 10
        profile["hardMaxPoints"] = 400
        profile["internalTargetPoints"] = 5
        # All points land in a single quadrant so that child inherits the full
        # remainder and is forced to depth == maxDepth.
        xyz, rgb, ordinals = synth_points(80, minx=1000.0, miny=1000.0, maxx=1999.0, maxy=1999.0)
        self._seed_root(xyz, rgb, ordinals)
        manifest = self._build(profile)
        kinds = {m["kind"] for m in manifest}
        self.assertIn(MODULE.NODE_KIND_LEAF_MAX_DEPTH, kinds)

    def test_hard_max_exceeded_raises(self) -> None:
        profile = dict(TINY_PROFILE)
        profile["maxDepth"] = 0
        profile["leafMaxPoints"] = 10
        profile["hardMaxPoints"] = 50
        profile["internalTargetPoints"] = 5
        xyz, rgb, ordinals = synth_points(200)
        self._seed_root(xyz, rgb, ordinals)
        with self.assertRaises(SystemExit):
            self._build(profile)

    def test_empty_quadrant_omitted(self) -> None:
        profile = dict(TINY_PROFILE)
        profile["leafMaxPoints"] = 5
        profile["internalTargetPoints"] = 2
        profile["maxDepth"] = 2
        # All points confined to the east/north quadrant only.
        xyz, rgb, ordinals = synth_points(60, minx=1000.0, miny=1000.0, maxx=1999.0, maxy=1999.0)
        self._seed_root(xyz, rgb, ordinals)
        manifest = self._build(profile)
        by_id = {m["nodeId"]: m for m in manifest}
        root = by_id["z0_x000000_y000000/d0_q"]
        # Only quadrant 3 (east/north) should have been populated at depth 1.
        depth1_paths = {m["path"] for m in manifest if m["depth"] == 1}
        self.assertEqual(depth1_paths, {"3"})
        self.assertEqual(set(root["children"]), {c for c in root["children"] if by_id[c]["path"] == "3"})

    def test_leaf_diagnostics_use_bbox_area_and_report_clamp(self) -> None:
        diagnostics = MODULE.leaf_content_diagnostics((1.0, 2.0, 3.0, 5.0, 5.0, 9.0), 24)
        self.assertEqual(diagnostics["extentMeters"], {"width": 4.0, "height": 3.0, "zSpan": 6.0})
        self.assertEqual(diagnostics["bboxAreaSquareMeters"], 12.0)
        self.assertFalse(diagnostics["bboxAreaClamped"])
        self.assertEqual(diagnostics["bboxDensityPointsPerSquareMeter"], 2.0)
        clamped = MODULE.leaf_content_diagnostics((1.0, 2.0, 3.0, 1.0, 5.0, 9.0), 24)
        self.assertTrue(clamped["bboxAreaClamped"])

    def test_leaf_diagnostics_percentiles_are_linear_and_empty_is_unavailable(self) -> None:
        nodes = [
            {"kind": MODULE.NODE_KIND_LEAF, "depth": 2, "pointCount": 1, "emittedPointCount": 1,
             "underfilledReason": None, "leafDiagnostics": {"extentMeters": {"width": 1, "height": 1, "zSpan": 1}, "bboxDensityPointsPerSquareMeter": 1, "bboxAreaClamped": False}},
            {"kind": MODULE.NODE_KIND_LEAF, "depth": 2, "pointCount": 3, "emittedPointCount": 3,
             "underfilledReason": "sparseSpatialBranch", "leafDiagnostics": {"extentMeters": {"width": 2, "height": 2, "zSpan": 2}, "bboxDensityPointsPerSquareMeter": 2, "bboxAreaClamped": True}},
        ]
        report = MODULE.compute_leaf_diagnostics(nodes)
        self.assertEqual(report["percentileMethod"], "numpy-linear-per-leaf-unweighted")
        self.assertEqual(report["global"]["emittedPoints"]["p50"], 2.0)
        self.assertAlmostEqual(report["global"]["emittedPoints"]["p95"], 2.9)
        self.assertEqual(report["global"]["underfilledCount"], 1)
        self.assertFalse(MODULE._distribution_summary([])["available"])


class CensusAccumulationTests(unittest.TestCase):
    def test_bins_points_into_correct_z0_tiles(self) -> None:
        xyz = np.array([[100.0, 100.0, 0.0], [2100.0, 100.0, 0.0], [-100.0, 100.0, 0.0]])
        valid = np.array([True, True, True])
        counts = MODULE.accumulate_census_counts({}, xyz, valid, (0.0, 0.0))
        self.assertEqual(counts, {"z0_x000000_y000000": 1, "z0_x000001_y000000": 1, "z0_x-00001_y000000": 1})

    def test_invalid_points_excluded(self) -> None:
        xyz = np.array([[100.0, 100.0, 0.0], [np.nan, 100.0, 0.0]])
        valid = np.array([True, False])
        counts = MODULE.accumulate_census_counts({}, xyz, valid, (0.0, 0.0))
        self.assertEqual(counts, {"z0_x000000_y000000": 1})

    def test_accumulates_across_batches(self) -> None:
        counts: dict = {}
        xyz1 = np.array([[100.0, 100.0, 0.0]])
        counts = MODULE.accumulate_census_counts(counts, xyz1, np.array([True]), (0.0, 0.0))
        xyz2 = np.array([[150.0, 150.0, 0.0]])
        counts = MODULE.accumulate_census_counts(counts, xyz2, np.array([True]), (0.0, 0.0))
        self.assertEqual(counts["z0_x000000_y000000"], 2)

    def test_all_invalid_batch_is_noop(self) -> None:
        xyz = np.array([[np.nan, np.nan, np.nan]])
        counts = MODULE.accumulate_census_counts({}, xyz, np.array([False]), (0.0, 0.0))
        self.assertEqual(counts, {})


class PilotSelectionTests(unittest.TestCase):
    def test_explicit_z0_ids_bypass_census(self) -> None:
        counts = {"z0_x000000_y000000": 100, "z0_x000001_y000000": 5}
        selected = MODULE.resolve_pilot_selection(counts, "auto", ["z0_x000009_y000009"])
        self.assertEqual(selected, ["z0_x000009_y000009"])

    def test_dense_picks_max_count_tie_break_by_tile_id(self) -> None:
        counts = {"z0_x000002_y000000": 100, "z0_x000001_y000000": 100, "z0_x000000_y000000": 5}
        self.assertEqual(MODULE.resolve_dense_z0(counts), "z0_x000001_y000000")

    def test_sparse_picks_tile_nearest_p25(self) -> None:
        counts = {
            "z0_x000000_y000000": 10,
            "z0_x000001_y000000": 20,
            "z0_x000002_y000000": 30,
            "z0_x000003_y000000": 40,
            "z0_x000004_y000000": 1000,
        }
        sparse = MODULE.resolve_sparse_z0(counts)
        self.assertIn(sparse, {"z0_x000001_y000000", "z0_x000002_y000000"})

    def test_auto_pilot_returns_dense_and_sparse_deduplicated(self) -> None:
        counts = {"z0_x000000_y000000": 1000}  # only one non-empty tile: dense==sparse
        selected = MODULE.resolve_pilot_selection(counts, "auto", [])
        self.assertEqual(selected, ["z0_x000000_y000000"])

    def test_pilot_none_selects_all_non_empty_tiles(self) -> None:
        counts = {"z0_x000000_y000000": 10, "z0_x000001_y000000": 0, "z0_x000002_y000000": 5}
        selected = MODULE.resolve_pilot_selection(counts, "none", [])
        self.assertEqual(selected, ["z0_x000000_y000000", "z0_x000002_y000000"])

    def test_empty_census_raises(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.resolve_pilot_selection({}, "auto", [])


class RouteBatchForBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-route-"))
        self.fragments_root = self.temp / "fragments"

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_p001_and_adaptive_split_by_ordinal_modulo(self) -> None:
        n = 10
        xyz = np.column_stack((np.full(n, 100.0), np.full(n, 100.0), np.zeros(n)))
        rgb = np.zeros((n, 3), dtype=np.uint8)
        valid = np.ones(n, dtype=bool)
        delta = MODULE.route_batch_for_build(
            0, xyz, rgb, valid, {"z0_x000000_y000000"}, (0.0, 0.0), self.fragments_root, has_rgb=True
        )
        # only ordinal 0 is a multiple of 1000 among 0..9 -> exactly 1 p001 point
        self.assertEqual(delta["perZ0"]["z0_x000000_y000000"]["p001Points"], 1)
        self.assertEqual(delta["perZ0"]["z0_x000000_y000000"]["adaptivePoints"], 9)
        self.assertEqual(MODULE.fragment_record_count(self.fragments_root / "z0_x000000_y000000" / "p001.raw", True), 1)
        self.assertEqual(MODULE.fragment_record_count(self.fragments_root / "z0_x000000_y000000" / "root.raw", True), 9)

    def test_ordinal_exactly_1000_goes_to_p001(self) -> None:
        xyz = np.array([[10.0, 10.0, 0.0]])
        rgb = np.array([[1, 2, 3]], dtype=np.uint8)
        valid = np.array([True])
        delta = MODULE.route_batch_for_build(
            1000, xyz, rgb, valid, {"z0_x000000_y000000"}, (0.0, 0.0), self.fragments_root, has_rgb=True
        )
        self.assertEqual(delta["perZ0"]["z0_x000000_y000000"]["p001Points"], 1)
        self.assertEqual(delta["perZ0"]["z0_x000000_y000000"]["adaptivePoints"], 0)

    def test_outside_selected_z0_counted_but_not_written(self) -> None:
        xyz = np.array([[100.0, 100.0, 0.0], [5000.0, 5000.0, 0.0]])
        rgb = np.zeros((2, 3), dtype=np.uint8)
        valid = np.array([True, True])
        delta = MODULE.route_batch_for_build(
            0, xyz, rgb, valid, {"z0_x000000_y000000"}, (0.0, 0.0), self.fragments_root, has_rgb=True
        )
        self.assertEqual(delta["outsideSelectedZ0"], 1)
        self.assertNotIn("z0_x000002_y000002", delta["perZ0"])

    def test_invalid_points_advance_ordinal_but_produce_no_content(self) -> None:
        xyz = np.array([[100.0, 100.0, 0.0], [np.nan, np.nan, np.nan]])
        rgb = np.zeros((2, 3), dtype=np.uint8)
        valid = np.array([True, False])
        delta = MODULE.route_batch_for_build(
            0, xyz, rgb, valid, {"z0_x000000_y000000"}, (0.0, 0.0), self.fragments_root, has_rgb=True
        )
        self.assertEqual(delta["invalidPoints"], 1)
        self.assertEqual(delta["sourcePointsVisited"], 2)
        self.assertEqual(delta["perZ0"]["z0_x000000_y000000"]["p001Points"], 1)

    def test_no_selected_z0_writes_nothing(self) -> None:
        xyz = np.array([[100.0, 100.0, 0.0]])
        valid = np.array([True])
        delta = MODULE.route_batch_for_build(
            0, xyz, None, valid, set(), (0.0, 0.0), self.fragments_root, has_rgb=False
        )
        self.assertEqual(delta["outsideSelectedZ0"], 1)
        self.assertFalse(self.fragments_root.exists())

    def test_empty_batch_is_noop(self) -> None:
        delta = MODULE.route_batch_for_build(
            0, np.empty((0, 3)), None, np.empty((0,), dtype=bool), {"z0_x000000_y000000"},
            (0.0, 0.0), self.fragments_root, has_rgb=False,
        )
        self.assertEqual(delta["sourcePointsVisited"], 0)
        self.assertEqual(delta["perZ0"], {})


class AccountingTests(unittest.TestCase):
    def test_merge_and_totals(self) -> None:
        acc = MODULE.empty_accounting()
        acc = MODULE.merge_accounting(acc, {
            "sourcePointsVisited": 10, "invalidPoints": 1, "outsideSelectedZ0": 2,
            "perZ0": {"z0_x000000_y000000": {"p001Points": 1, "adaptivePoints": 6}},
        })
        acc = MODULE.merge_accounting(acc, {
            "sourcePointsVisited": 5, "invalidPoints": 0, "outsideSelectedZ0": 0,
            "perZ0": {"z0_x000000_y000000": {"p001Points": 0, "adaptivePoints": 5}},
        })
        totals = MODULE.accounting_totals(acc)
        self.assertEqual(totals["sourcePointsVisited"], 15)
        self.assertEqual(totals["invalidPoints"], 1)
        self.assertEqual(totals["outsideSelectedZ0"], 2)
        self.assertEqual(totals["p001Points"], 1)
        self.assertEqual(totals["adaptivePoints"], 11)
        self.assertEqual(totals["eligibleSelectedZ0"], totals["p001Points"] + totals["adaptivePoints"])


class ParseZ0TileIdTests(unittest.TestCase):
    def test_roundtrip(self) -> None:
        self.assertEqual(MODULE.parse_z0_tile_id("z0_x000012_y000008"), (12, 8))
        self.assertEqual(MODULE.parse_z0_tile_id("z0_x-00003_y-00001"), (-3, -1))

    def test_malformed_raises(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.parse_z0_tile_id("not-a-tile-id")


class LeafStatsTests(unittest.TestCase):
    def test_empty(self) -> None:
        stats = MODULE.compute_leaf_stats([], 40_000, 110_000)
        self.assertEqual(stats["leafCount"], 0)
        self.assertEqual(stats["bandFraction"], 0.0)

    def test_band_fraction_all_in_band(self) -> None:
        stats = MODULE.compute_leaf_stats([50_000, 60_000, 70_000], 40_000, 110_000)
        self.assertEqual(stats["bandFraction"], 1.0)
        self.assertEqual(stats["max"], 70_000)

    def test_band_fraction_partial(self) -> None:
        stats = MODULE.compute_leaf_stats([5_000, 50_000], 40_000, 110_000)
        self.assertAlmostEqual(stats["bandFraction"], 0.5)


class FinalizeOneZ0Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-finalize-"))
        self.output_dir = self.temp / "out"
        self.fragments_root = self.temp / "fragments"

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def _seed(self, z0_id: str, adaptive_n: int, p001_n: int) -> None:
        xyz_a, rgb_a, ord_a = synth_points(adaptive_n, ordinal_start=1)  # ordinals never multiples of 1000 by construction below
        # Ensure none of the adaptive ordinals are accidental multiples of 1000.
        ord_a = np.array([o if o % 1000 != 0 else o + 1 for o in ord_a.tolist()], dtype=np.uint64)
        MODULE.append_fragment(self.fragments_root / z0_id / "root.raw", xyz_a, rgb_a, ord_a, has_rgb=True)
        if p001_n:
            xyz_p, rgb_p, _ = synth_points(p001_n, ordinal_start=0)
            ord_p = np.arange(p001_n, dtype=np.uint64) * 1000
            MODULE.append_fragment(self.fragments_root / z0_id / "p001.raw", xyz_p, rgb_p, ord_p, has_rgb=True)

    def test_finalize_writes_p001_and_manifest(self) -> None:
        z0_id = "z0_x000000_y000000"
        self._seed(z0_id, adaptive_n=50, p001_n=5)
        result = MODULE.finalize_one_z0(
            output_dir=self.output_dir, fragments_root=self.fragments_root, z0_id=z0_id,
            grid_origin=(0.0, 0.0), has_rgb=True, cli_profile=TINY_PROFILE, salt=42,
            total_source_points=10_000,
            expected_p001=5, expected_adaptive=50,
        )
        self.assertEqual(result["duplicates"], 0)
        self.assertEqual(result["omittedEligiblePoints"], 0)
        self.assertTrue((self.output_dir / "points" / "z0" / f"{z0_id}.pnts").exists())
        manifest_path = self.output_dir / ".node-manifests" / f"{z0_id}.json"
        self.assertTrue(manifest_path.exists())
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest["z0Id"], z0_id)
        self.assertGreater(len(manifest["nodes"]), 0)
        # Finalization is retry-safe: inputs survive until the caller checkpoints
        # completedZ0Ids and explicitly removes them.
        self.assertTrue((self.fragments_root / z0_id / "root.raw").exists())
        self.assertTrue((self.fragments_root / z0_id / "p001.raw").exists())
        MODULE.delete_z0_input_shards(self.fragments_root, z0_id)
        self.assertFalse((self.fragments_root / z0_id).exists())

    def test_finalize_with_no_p001_points(self) -> None:
        z0_id = "z0_x000001_y000000"
        self._seed(z0_id, adaptive_n=30, p001_n=0)
        result = MODULE.finalize_one_z0(
            output_dir=self.output_dir, fragments_root=self.fragments_root, z0_id=z0_id,
            grid_origin=(0.0, 0.0), has_rgb=True, cli_profile=TINY_PROFILE, salt=42,
            total_source_points=10_000,
            expected_p001=0, expected_adaptive=30,
        )
        self.assertEqual(result["p001Count"], 0)
        self.assertFalse((self.output_dir / "points" / "z0" / f"{z0_id}.pnts").exists())

    def test_audit_failure_raises_when_counts_mismatch(self) -> None:
        z0_id = "z0_x000002_y000000"
        self._seed(z0_id, adaptive_n=20, p001_n=2)
        with self.assertRaises(SystemExit):
            MODULE.finalize_one_z0(
                output_dir=self.output_dir, fragments_root=self.fragments_root, z0_id=z0_id,
                grid_origin=(0.0, 0.0), has_rgb=True, cli_profile=TINY_PROFILE, salt=42,
                total_source_points=10_000,
                expected_p001=2, expected_adaptive=999,  # wrong on purpose
            )

    def test_finalize_failure_preserves_inputs_and_is_retryable(self) -> None:
        z0_id = "z0_x000003_y000000"
        self._seed(z0_id, adaptive_n=20, p001_n=2)
        kwargs = {
            "output_dir": self.output_dir,
            "fragments_root": self.fragments_root,
            "z0_id": z0_id,
            "grid_origin": (0.0, 0.0),
            "has_rgb": True,
            "cli_profile": TINY_PROFILE,
            "salt": 42,
            "total_source_points": 10_000,
            "expected_p001": 2,
            "expected_adaptive": 20,
        }
        with mock.patch.object(MODULE, "build_z0_adaptive_tree", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                MODULE.finalize_one_z0(**kwargs)

        self.assertTrue((self.fragments_root / z0_id / "root.raw").exists())
        self.assertTrue((self.fragments_root / z0_id / "p001.raw").exists())
        self.assertFalse((self.output_dir / ".node-manifests" / f"{z0_id}.json").exists())

        result = MODULE.finalize_one_z0(**kwargs)
        self.assertEqual(result["duplicates"], 0)
        self.assertTrue((self.output_dir / ".node-manifests" / f"{z0_id}.json").exists())


class OwnershipAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-ownership-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_rejects_same_count_with_substituted_ordinal(self) -> None:
        z0_id = "z0_x000000_y000000"
        expected = self.temp / "expected.raw"
        xyz, rgb, _ = synth_points(1, ordinal_start=1)
        MODULE.append_fragment(
            expected, xyz, rgb, np.array([1], dtype=np.uint64), has_rgb=True,
        )

        emitted = self.temp / "points" / "adaptive" / z0_id / "d0_q.pnts"
        MODULE.write_ordinal_sidecar_atomic(
            MODULE.ordinal_sidecar_path(emitted), np.array([2], dtype=np.uint64),
        )
        manifest = [{"pntsUri": f"points/adaptive/{z0_id}/d0_q.pnts"}]

        with self.assertRaises(SystemExit):
            MODULE.audit_z0_ownership(
                output_dir=self.temp,
                z0_id=z0_id,
                manifest=manifest,
                expected_p001_fragments=[],
                expected_adaptive_fragments=[expected],
                has_rgb=True,
                total_source_points=10,
                expected_p001=0,
                expected_adaptive=1,
            )


class ChunkCheckpointResumeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-chunk-resume-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_uncheckpointed_promoted_shard_is_replayed_without_duplicates(self) -> None:
        source = self.temp / "chunk-0.copc.laz"
        fragments = self.temp / "fragments"
        state_path = self.temp / "state.json"

        header = mock.Mock(
            point_count=3,
            mins=np.array([0.0, 0.0, 0.0]),
            maxs=np.array([2.0, 2.0, 2.0]),
        )
        node = mock.Mock(
            point_count=3,
            key=mock.Mock(level=0, x=0, y=0, z=0),
            bounds=mock.Mock(
                mins=np.array([0.0, 0.0, 0.0]),
                maxs=np.array([2.0, 2.0, 2.0]),
            ),
        )
        points = mock.Mock(
            x=np.array([1.0, 2.0, 3.0]),
            y=np.array([1.0, 2.0, 3.0]),
            z=np.array([1.0, 2.0, 3.0]),
            red=np.array([0, 0, 0]),
            green=np.array([0, 0, 0]),
            blue=np.array([0, 0, 0]),
        )
        reader = mock.MagicMock()
        reader.__enter__.return_value = reader
        reader.__exit__.return_value = False
        reader.header = header
        reader.source = object()
        reader.copc_info = object()
        reader.root_page = object()
        reader._fetch_and_decompress_points_of_nodes.return_value = points

        pristine_state = {
            "completedChunks": [],
            "chunkOrdinals": {},
            "streamOrdinal": 0,
            "accounting": MODULE.empty_accounting(),
        }
        patches = (
            mock.patch("laspy.copc.CopcReader.open", return_value=reader),
            mock.patch("laspy.copc.load_octree_for_query", return_value=[node]),
            mock.patch.object(
                MODULE, "transform_bounds_to_enu",
                side_effect=lambda mins, maxs, frame: (np.asarray(mins), np.asarray(maxs)),
            ),
            mock.patch.object(MODULE, "source_points_to_enu", side_effect=lambda xyz, frame: xyz),
        )

        # First attempt promotes the completed chunk shard, then crashes before
        # the state checkpoint becomes durable.
        with patches[0], patches[1], patches[2], patches[3], mock.patch.object(
            MODULE, "write_json_atomic", side_effect=RuntimeError("checkpoint crash"),
        ):
            with self.assertRaises(RuntimeError):
                MODULE.stream_copc_for_build(
                    [source], {}, (0.0, 0.0), {"z0_x000000_y000000"}, True,
                    fragments, pristine_state, state_path,
                )

        promoted = fragments / MODULE.CHUNK_SHARDS_DIR / source.stem
        self.assertTrue(promoted.is_dir())

        # Resume from the last durable (pre-chunk) state. The uncheckpointed
        # promoted shard must be discarded before replay, not appended to.
        resumed_state = {
            "completedChunks": [],
            "chunkOrdinals": {},
            "streamOrdinal": 0,
            "accounting": MODULE.empty_accounting(),
        }
        patches = (
            mock.patch("laspy.copc.CopcReader.open", return_value=reader),
            mock.patch("laspy.copc.load_octree_for_query", return_value=[node]),
            mock.patch.object(
                MODULE, "transform_bounds_to_enu",
                side_effect=lambda mins, maxs, frame: (np.asarray(mins), np.asarray(maxs)),
            ),
            mock.patch.object(MODULE, "source_points_to_enu", side_effect=lambda xyz, frame: xyz),
        )
        with patches[0], patches[1], patches[2], patches[3]:
            accounting = MODULE.stream_copc_for_build(
                [source], {}, (0.0, 0.0), {"z0_x000000_y000000"}, True,
                fragments, resumed_state, state_path,
            )

        z0_id = "z0_x000000_y000000"
        total_records = sum(
            MODULE.fragment_record_count(path, True)
            for name in ("p001.raw", "root.raw")
            for path in MODULE.z0_input_fragment_paths(fragments, z0_id, name)
        )
        self.assertEqual(total_records, 3)
        self.assertEqual(accounting["sourcePointsVisited"], 3)
        self.assertEqual(resumed_state["completedChunks"], [source.stem])


class BboxPruningTests(unittest.TestCase):
    def test_intersects_overlapping_box(self) -> None:
        self.assertTrue(MODULE.enu_bbox_intersects(np.array([0.0, 0.0]), np.array([10.0, 10.0]), (5.0, 5.0, 15.0, 15.0)))

    def test_does_not_intersect_disjoint_box(self) -> None:
        self.assertFalse(MODULE.enu_bbox_intersects(np.array([0.0, 0.0]), np.array([10.0, 10.0]), (100.0, 100.0, 110.0, 110.0)))

    def test_intersects_any_of_multiple_targets(self) -> None:
        targets = [(100.0, 100.0, 110.0, 110.0), (0.0, 0.0, 10.0, 10.0)]
        self.assertTrue(MODULE.enu_bbox_intersects_any(np.array([5.0, 5.0]), np.array([6.0, 6.0]), targets))
        self.assertFalse(MODULE.enu_bbox_intersects_any(np.array([50.0, 50.0]), np.array([60.0, 60.0]), targets))

    def test_selected_z0_bounds_list(self) -> None:
        bounds = MODULE.selected_z0_bounds_list({"z0_x000001_y-00001"}, (0.0, 0.0))
        self.assertEqual(bounds, [(2000.0, -2000.0, 4000.0, 0.0)])


class ThresholdValidationTests(unittest.TestCase):
    def test_default_thresholds_are_valid(self) -> None:
        MODULE.validate_thresholds(40_000, 75_000, 110_000, 150_000)

    def test_reject_out_of_order_thresholds(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_thresholds(80_000, 75_000, 110_000, 150_000)

    def test_reject_leaf_max_equal_hard_max(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_thresholds(40_000, 75_000, 150_000, 150_000)

    def test_reject_non_positive_acceptable_min(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_thresholds(0, 75_000, 110_000, 150_000)


class Z0IdValidationTests(unittest.TestCase):
    def test_accepts_valid_ids(self) -> None:
        ids = MODULE.validate_z0_ids(["z0_x000012_y000008", "z0_x-00003_y-00001"])
        self.assertEqual(ids, ["z0_x000012_y000008", "z0_x-00003_y-00001"])

    def test_rejects_malformed_id(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_z0_ids(["not-a-tile-id"])

    def test_rejects_duplicate_ids(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_z0_ids(["z0_x000012_y000008", "z0_x000012_y000008"])


class ProfileHashTests(unittest.TestCase):
    def test_deterministic(self) -> None:
        profile = {"maxDepth": 11, "errorScale": 2.0}
        self.assertEqual(MODULE.profile_hash(profile), MODULE.profile_hash(dict(profile)))

    def test_changes_when_profile_changes(self) -> None:
        a = MODULE.profile_hash({"maxDepth": 11})
        b = MODULE.profile_hash({"maxDepth": 12})
        self.assertNotEqual(a, b)


class NameAndPathSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-name-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_reject_traversal_dataset(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_name("../escape", "dataset")

    def test_reject_empty_name(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_name("", "public-root")

    def test_assert_inside_rejects_escape(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.assert_inside(self.temp.parent / "elsewhere", self.temp, "test")

    def test_assert_inside_accepts_nested_path(self) -> None:
        MODULE.assert_inside(self.temp / "nested" / "dir", self.temp, "test")

    def test_reject_resume_and_overwrite_together(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.build_adaptive_point_hierarchy_foundation(
                root_dir=self.temp, dataset="d", resume=True, overwrite=True,
            )


class CliParsingTests(unittest.TestCase):
    def test_positional_dataset_and_defaults(self) -> None:
        ns = MODULE.parse_args(["2404PeruB2", "--root", "/tmp/x"])
        self.assertEqual(ns.dataset, "2404PeruB2")
        self.assertEqual(ns.internal_target_points, MODULE.DEFAULT_INTERNAL_TARGET_POINTS)
        self.assertEqual(ns.acceptable_min_points, MODULE.DEFAULT_ACCEPTABLE_MIN_POINTS)
        self.assertEqual(ns.leaf_max_points, MODULE.DEFAULT_LEAF_MAX_POINTS)
        self.assertEqual(ns.hard_max_points, MODULE.DEFAULT_HARD_MAX_POINTS)
        self.assertEqual(ns.max_depth, MODULE.DEFAULT_MAX_DEPTH)
        self.assertEqual(ns.error_scale, MODULE.DEFAULT_ERROR_SCALE)
        self.assertEqual(ns.microcell_grid, MODULE.DEFAULT_MICROCELL_GRID)
        self.assertEqual(ns.vrv_mode, "both")
        self.assertEqual(ns.pilot, "auto")
        self.assertEqual(ns.z0_ids, [])
        self.assertFalse(ns.resume)
        self.assertFalse(ns.overwrite)

    def test_dataset_must_be_positional(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.parse_args(["--root", "/tmp/x", "--dataset", "x"])

    def test_repeatable_z0_id(self) -> None:
        ns = MODULE.parse_args(
            ["d", "--root", "/tmp/x", "--z0-id", "z0_x000001_y000001", "--z0-id", "z0_x000002_y000002"]
        )
        self.assertEqual(ns.z0_ids, ["z0_x000001_y000001", "z0_x000002_y000002"])

    def test_invalid_vrv_mode_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.parse_args(["d", "--root", "/tmp/x", "--vrv-mode", "bogus"])

    def test_invalid_pilot_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.parse_args(["d", "--root", "/tmp/x", "--pilot", "bogus"])


class AtomicWriteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-atomic-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_write_json_atomic_leaves_no_tmp_files(self) -> None:
        path = self.temp / "state.json"
        MODULE.write_json_atomic(path, {"a": 1})
        self.assertTrue(path.exists())
        self.assertEqual(json.loads(path.read_text()), {"a": 1})
        leftovers = list(self.temp.glob(".*tmp*"))
        self.assertEqual(leftovers, [])

    def test_write_json_atomic_overwrites_existing(self) -> None:
        path = self.temp / "state.json"
        MODULE.write_json_atomic(path, {"a": 1})
        MODULE.write_json_atomic(path, {"a": 2})
        self.assertEqual(json.loads(path.read_text()), {"a": 2})


class ProgressFormattingTests(unittest.TestCase):
    def test_point_count_units(self) -> None:
        self.assertEqual(MODULE._format_point_count(999), "999")
        self.assertEqual(MODULE._format_point_count(1_500_000), "1.5M")
        self.assertEqual(MODULE._format_point_count(3_419_134_134), "3.419B")

    def test_duration_formats_minutes_and_hours(self) -> None:
        self.assertEqual(MODULE._format_duration(65), "01:05")
        self.assertEqual(MODULE._format_duration(3_661), "01:01:01")


class DiskPreflightTests(unittest.TestCase):
    def test_estimate_grows_with_points(self) -> None:
        small = MODULE._estimate_output_bytes(1_000, True)
        big = MODULE._estimate_output_bytes(1_000_000, True)
        self.assertGreater(big, small)

    def test_estimate_is_smaller_without_rgb(self) -> None:
        with_rgb = MODULE._estimate_output_bytes(1_000_000, True)
        without_rgb = MODULE._estimate_output_bytes(1_000_000, False)
        self.assertLess(without_rgb, with_rgb)

    def test_estimate_includes_fragment_and_ownership_working_space(self) -> None:
        points = 1_000
        fragment_only = points * MODULE.FRAGMENT_BYTES_RGB
        self.assertGreater(MODULE._estimate_output_bytes(points, True), fragment_only * 3)

    def test_check_disk_space_raises_when_insufficient(self) -> None:
        temp = Path(tempfile.mkdtemp(prefix="aph-disk-"))
        try:
            huge_points = 10**18
            with mock.patch.object(MODULE, "_estimate_output_bytes", return_value=10**18):
                with self.assertRaises(SystemExit):
                    MODULE._check_disk_space(temp, huge_points, True, allow_low_disk=False)
        finally:
            shutil.rmtree(temp, ignore_errors=True)

    def test_check_disk_space_allows_override(self) -> None:
        temp = Path(tempfile.mkdtemp(prefix="aph-disk-override-"))
        try:
            with mock.patch.object(MODULE, "_estimate_output_bytes", return_value=10**18):
                MODULE._check_disk_space(temp, 10**18, True, allow_low_disk=True)
        finally:
            shutil.rmtree(temp, ignore_errors=True)


class ResumeMismatchTests(unittest.TestCase):
    def _base(self) -> dict:
        return {
            "schemaVersion": MODULE.SCHEMA_VERSION,
            "phase": "initialized",
            "profileHash": "p",
            "pilotSelectionRequest": "auto",
            "requestedZ0Ids": [],
            "outputName": "d-adaptive-point-hierarchy",
            "hasRgb": True,
            "colorScale": 256,
            "totalSourcePoints": 1,
            "gridOrigin": [0, 0],
            "enuOriginLonLatHeight": [0.0, 0.0, 0.0],
            "enuOriginEcef": [0.0, 0.0, 0.0],
            "rootTransform": [1.0] * 16,
            "sourceFiles": [{"name": "a", "size": 1, "mtime_ns": 1, "fingerprint": "f"}],
        }

    def test_matching_state_does_not_raise(self) -> None:
        saved = self._base()
        fresh = self._base()
        MODULE._validate_resume_state(saved, fresh)

    def test_reject_profile_hash_change(self) -> None:
        saved = self._base()
        fresh = self._base()
        fresh["profileHash"] = "q"
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, fresh)

    def test_reject_grid_origin_change(self) -> None:
        saved = self._base()
        fresh = self._base()
        fresh["gridOrigin"] = [2000, 0]
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, fresh)

    def test_reject_transform_change(self) -> None:
        saved = self._base()
        fresh = self._base()
        fresh["rootTransform"] = [2.0] * 16
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, fresh)

    def test_reject_source_count_change(self) -> None:
        saved = self._base()
        fresh = self._base()
        fresh["sourceFiles"] = saved["sourceFiles"] + [{"name": "b", "size": 1, "mtime_ns": 1, "fingerprint": "g"}]
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, fresh)

    def test_reject_source_fingerprint_change(self) -> None:
        saved = self._base()
        fresh = self._base()
        fresh["sourceFiles"] = [{"name": "a", "size": 1, "mtime_ns": 1, "fingerprint": "changed"}]
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, fresh)

    def test_reject_pilot_selection_change(self) -> None:
        saved = self._base()
        fresh = self._base()
        fresh["pilotSelectionRequest"] = "dense"
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, fresh)

    def test_reject_requested_z0_change(self) -> None:
        saved = self._base()
        fresh = self._base()
        fresh["requestedZ0Ids"] = ["z0_x000000_y000000"]
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, fresh)

    def test_reject_schema_change_after_work_started(self) -> None:
        saved = self._base()
        saved["schemaVersion"] = 1
        saved["phase"] = "streaming"
        saved["completedChunks"] = ["chunk-0"]
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, self._base())

    def test_migrates_pristine_task1_state_to_schema_v2(self) -> None:
        saved = self._base()
        saved["schemaVersion"] = 1
        saved.pop("totalSourcePoints")
        fresh = self._base()

        self.assertTrue(MODULE._validate_resume_state(saved, fresh))
        self.assertEqual(saved["schemaVersion"], MODULE.SCHEMA_VERSION)
        self.assertEqual(saved["totalSourcePoints"], fresh["totalSourcePoints"])


class PilotExtensionTests(unittest.TestCase):
    def test_extension_keeps_completed_pilot_and_selects_remaining_census_z0s(self) -> None:
        temp = Path(tempfile.mkdtemp(prefix="aph-extend-"))
        try:
            state_path = temp / "state.json"
            state = {
                "phase": "residual-complete",
                "pilotSelectionRequest": "auto",
                "requestedZ0Ids": [],
                "selectedZ0Ids": ["z0_x000000_y000000", "z0_x000001_y000000"],
                "completedZ0Ids": ["z0_x000000_y000000", "z0_x000001_y000000"],
                "z0Census": {
                    "z0_x000000_y000000": 10,
                    "z0_x000001_y000000": 20,
                    "z0_x000002_y000000": 30,
                },
                "accounting": MODULE.empty_accounting(),
            }
            extension = MODULE.begin_pilot_extension(state, state_path)
            self.assertEqual(extension["addedZ0Ids"], ["z0_x000002_y000000"])
            self.assertEqual(state["phase"], "streaming")
            self.assertEqual(state["selectedZ0Ids"], sorted(state["z0Census"]))
            self.assertEqual(state["extensionStream"]["completedChunks"], [])
            self.assertEqual(json.loads(state_path.read_text())["pilotExtension"]["addedZ0Ids"], extension["addedZ0Ids"])
        finally:
            shutil.rmtree(temp, ignore_errors=True)

    def test_extension_accounting_preserves_single_source_pass_total(self) -> None:
        state = {
            "totalSourcePoints": 100,
            "selectedZ0Ids": ["z0_x000000_y000000", "z0_x000001_y000000"],
            "z0Census": {"z0_x000000_y000000": 40, "z0_x000001_y000000": 50},
            "censusAccounting": {"sourcePointsVisited": 100, "invalidPoints": 10},
            "pilotExtension": {"baseAccounting": {"sourcePointsVisited": 100, "invalidPoints": 10, "outsideSelectedZ0": 50, "perZ0": {"z0_x000000_y000000": {"p001Points": 1, "adaptivePoints": 39}}}},
            "extensionStream": {"accounting": {"sourcePointsVisited": 100, "invalidPoints": 0, "outsideSelectedZ0": 40, "perZ0": {"z0_x000001_y000000": {"p001Points": 1, "adaptivePoints": 49}}}},
        }
        combined = MODULE.merge_pilot_extension_accounting(state)
        self.assertEqual(combined["sourcePointsVisited"], 100)
        self.assertEqual(combined["invalidPoints"], 10)
        self.assertEqual(combined["outsideSelectedZ0"], 0)
        self.assertEqual(combined["perZ0"]["z0_x000000_y000000"]["adaptivePoints"], 39)
        self.assertEqual(combined["perZ0"]["z0_x000001_y000000"]["adaptivePoints"], 49)

    def test_extension_report_marks_full_scope_and_lists_pilot_and_added_z0s(self) -> None:
        temp = Path(tempfile.mkdtemp(prefix="aph-extend-report-"))
        try:
            report_path = temp / "report.json"
            report_path.write_text(json.dumps({"status": "residual-complete"}), encoding="utf-8")
            state = {
                "selectedZ0Ids": ["z0_x000000_y000000", "z0_x000001_y000000"],
                "pilotExtension": {
                    "baseSelectedZ0Ids": ["z0_x000000_y000000"],
                    "addedZ0Ids": ["z0_x000001_y000000"],
                },
            }
            MODULE.update_extension_report(report_path, state)
            report = json.loads(report_path.read_text())
            self.assertEqual(report["status"], "extending-full")
            self.assertEqual(report["selectionMode"], "extended-full")
            self.assertEqual(report["pilotZ0Ids"], ["z0_x000000_y000000"])
            self.assertEqual(report["extendedZ0Ids"], ["z0_x000001_y000000"])
        finally:
            shutil.rmtree(temp, ignore_errors=True)


class FullFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-flow-"))
        self.input_dir = self.temp / "local-storage" / "intermediate" / "d" / "chunks-copc"
        self.input_dir.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def _patched(self, preflight_result=None):
        return (
            mock.patch.object(MODULE, "preflight", return_value=preflight_result or fake_preflight_result()),
            mock.patch.object(MODULE, "_crs_from_wkt", return_value=object()),
            mock.patch.object(MODULE, "build_enu_frame", return_value=fake_frame()),
            mock.patch.object(
                MODULE,
                "transform_bounds_to_enu",
                return_value=(np.array([0.0, 0.0, 0.0]), np.array([1.0, 1.0, 1.0])),
            ),
        )

    def test_missing_copc_chunks_raises(self) -> None:
        empty_input = self.temp / "local-storage" / "intermediate" / "missing" / "chunks-copc"
        with self.assertRaises(SystemExit):
            MODULE.build_adaptive_point_hierarchy_foundation(root_dir=self.temp, dataset="missing")
        self.assertFalse(empty_input.exists())

    def test_fresh_build_creates_skeleton_state_and_report_without_tileset(self) -> None:
        p1, p2, p3, p4 = self._patched()
        with p1, p2, p3, p4:
            result = MODULE.build_adaptive_point_hierarchy_foundation(
                root_dir=self.temp, dataset="d", pilot="auto", z0_ids=["z0_x000001_y000001"],
            )

        output_dir = Path(result["outputPath"])
        self.assertEqual(output_dir.name, "d-adaptive-point-hierarchy")
        self.assertTrue((output_dir / "z0").is_dir())
        self.assertTrue((output_dir / "points" / "z0").is_dir())
        self.assertTrue((output_dir / "points" / "adaptive").is_dir())
        self.assertFalse((output_dir / "tileset.json").exists())

        state = json.loads((output_dir / MODULE.STATE_NAME).read_text())
        self.assertEqual(state["schemaVersion"], MODULE.SCHEMA_VERSION)
        self.assertEqual(state["phase"], "initialized")
        self.assertEqual(state["pilotSelectionRequest"], "auto")
        self.assertEqual(state["requestedZ0Ids"], ["z0_x000001_y000001"])

        report = json.loads((output_dir / MODULE.REPORT_NAME).read_text())
        self.assertEqual(report["status"], "initialized")
        self.assertEqual(report["generator"], MODULE.GENERATOR)
        self.assertEqual(report["dataset"], "d")

    def test_output_exists_without_resume_or_overwrite_raises(self) -> None:
        p1, p2, p3, p4 = self._patched()
        with p1, p2, p3, p4:
            MODULE.build_adaptive_point_hierarchy_foundation(root_dir=self.temp, dataset="d")
        with self._patched()[0], self._patched()[1], self._patched()[2], self._patched()[3]:
            with self.assertRaises(SystemExit):
                MODULE.build_adaptive_point_hierarchy_foundation(root_dir=self.temp, dataset="d")

    def test_resume_with_same_profile_succeeds(self) -> None:
        p1, p2, p3, p4 = self._patched()
        with p1, p2, p3, p4:
            MODULE.build_adaptive_point_hierarchy_foundation(root_dir=self.temp, dataset="d")

        p1, p2, p3, p4 = self._patched()
        with p1, p2, p3, p4:
            result = MODULE.build_adaptive_point_hierarchy_foundation(
                root_dir=self.temp, dataset="d", resume=True,
            )
        self.assertTrue(Path(result["outputPath"]).exists())

    def test_resume_fails_when_thresholds_changed(self) -> None:
        p1, p2, p3, p4 = self._patched()
        with p1, p2, p3, p4:
            MODULE.build_adaptive_point_hierarchy_foundation(root_dir=self.temp, dataset="d")

        p1, p2, p3, p4 = self._patched()
        with p1, p2, p3, p4:
            with self.assertRaises(SystemExit):
                MODULE.build_adaptive_point_hierarchy_foundation(
                    root_dir=self.temp, dataset="d", resume=True, max_depth=9,
                )

    def test_resume_fails_when_source_fingerprint_changed(self) -> None:
        p1, p2, p3, p4 = self._patched()
        with p1, p2, p3, p4:
            MODULE.build_adaptive_point_hierarchy_foundation(root_dir=self.temp, dataset="d")

        changed = fake_preflight_result()
        changed["records"][0]["fingerprint"] = "different"
        p1, p2, p3, p4 = self._patched(preflight_result=changed)
        with p1, p2, p3, p4:
            with self.assertRaises(SystemExit):
                MODULE.build_adaptive_point_hierarchy_foundation(
                    root_dir=self.temp, dataset="d", resume=True,
                )

    def test_resume_without_existing_output_raises(self) -> None:
        p1, p2, p3, p4 = self._patched()
        with p1, p2, p3, p4:
            with self.assertRaises(SystemExit):
                MODULE.build_adaptive_point_hierarchy_foundation(
                    root_dir=self.temp, dataset="d", resume=True,
                )

    def test_overwrite_preserves_existing_output_when_preflight_fails(self) -> None:
        output_dir = self.temp / "local-storage" / "tilesets" / "d" / "d-adaptive-point-hierarchy"
        output_dir.mkdir(parents=True)
        sentinel = output_dir / "known-good.txt"
        sentinel.write_text("keep", encoding="utf-8")

        with mock.patch.object(MODULE, "preflight", side_effect=SystemExit("bad source")):
            with self.assertRaises(SystemExit):
                MODULE.build_adaptive_point_hierarchy_foundation(
                    root_dir=self.temp, dataset="d", overwrite=True,
                )

        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_overwrite_preserves_existing_output_when_disk_check_fails(self) -> None:
        output_dir = self.temp / "local-storage" / "tilesets" / "d" / "d-adaptive-point-hierarchy"
        output_dir.mkdir(parents=True)
        sentinel = output_dir / "known-good.txt"
        sentinel.write_text("keep", encoding="utf-8")

        p1, p2, p3, p4 = self._patched()
        with p1, p2, p3, p4, mock.patch.object(MODULE, "_check_disk_space", side_effect=SystemExit("low disk")):
            with self.assertRaises(SystemExit):
                MODULE.build_adaptive_point_hierarchy_foundation(
                    root_dir=self.temp, dataset="d", overwrite=True,
                )

        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_output_containment_rejected_for_traversal_public_root(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.build_adaptive_point_hierarchy_foundation(
                root_dir=self.temp, dataset="d", public_root="../escape",
            )


def _synthetic_multi_z0_points() -> tuple[np.ndarray, np.ndarray]:
    """300 points in z0 (0,0) [dense] + 30 points in z0 (1,0) [sparse]."""
    xyz_dense, rgb_dense, _ = synth_points(300, minx=0.0, miny=0.0, maxx=2000.0, maxy=2000.0)
    xyz_sparse, rgb_sparse, _ = synth_points(30, minx=2000.0, miny=0.0, maxx=4000.0, maxy=2000.0)
    xyz = np.concatenate([xyz_dense, xyz_sparse])
    rgb = np.concatenate([rgb_dense, rgb_sparse])
    return xyz, rgb


def _fake_run_census(
    files, frame, grid_origin, total_source_points=0, progress_callback=None,
) -> dict:
    xyz, _rgb = _synthetic_multi_z0_points()
    valid = np.ones(xyz.shape[0], dtype=bool)
    return {
        "counts": MODULE.accumulate_census_counts({}, xyz, valid, grid_origin),
        "sourcePointsVisited": int(xyz.shape[0]),
        "invalidPoints": 0,
    }


def _fake_stream_copc_for_build(
    files, frame, grid_origin, selected_z0_ids, has_rgb, fragments_root, state, state_path,
    allow_bbox_pruning=False,
):
    xyz, rgb = _synthetic_multi_z0_points()
    valid = np.ones(xyz.shape[0], dtype=bool)
    shard_root = fragments_root / MODULE.CHUNK_SHARDS_DIR / "fake-chunk"
    delta = MODULE.route_batch_for_build(
        0, xyz, rgb, valid, selected_z0_ids, grid_origin, shard_root, has_rgb,
    )
    accounting = MODULE.merge_accounting(state.get("accounting") or MODULE.empty_accounting(), delta)
    state["completedChunks"] = ["fake-chunk"]
    state["streamOrdinal"] = int(xyz.shape[0])
    state["accounting"] = accounting
    MODULE.write_json_atomic(state_path, state)
    return accounting


class RunAdaptiveHierarchyIntegrationTests(unittest.TestCase):
    """End-to-end orchestration tests: COPC I/O (preflight/frame/census/stream)
    is faked with deterministic synthetic data; everything downstream (routing,
    fragments, quadtree build, audit, report, resume/phase bookkeeping) runs for
    real."""

    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="aph-run-"))
        self.input_dir = self.temp / "local-storage" / "intermediate" / "d" / "chunks-copc"
        self.input_dir.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def _patches(self):
        return (
            mock.patch.object(MODULE, "preflight", return_value=fake_preflight_result(total_points=330)),
            mock.patch.object(MODULE, "_crs_from_wkt", return_value=object()),
            mock.patch.object(MODULE, "build_enu_frame", return_value=fake_frame()),
            mock.patch.object(
                MODULE, "transform_bounds_to_enu",
                return_value=(np.array([0.0, 0.0, 0.0]), np.array([1.0, 1.0, 1.0])),
            ),
            mock.patch.object(MODULE, "run_census", side_effect=_fake_run_census),
            mock.patch.object(MODULE, "stream_copc_for_build", side_effect=_fake_stream_copc_for_build),
        )

    def _run(self, **kwargs):
        patches = self._patches()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            return MODULE.run_adaptive_point_hierarchy(root_dir=self.temp, dataset="d", **kwargs)

    def test_full_run_selects_dense_and_sparse_and_builds_both(self) -> None:
        result = self._run()
        self.assertEqual(sorted(result["selectedZ0Ids"]), ["z0_x000000_y000000", "z0_x000001_y000000"])

        output_dir = Path(result["outputPath"])
        report = json.loads((output_dir / MODULE.REPORT_NAME).read_text())
        self.assertEqual(report["status"], "residual-complete")
        self.assertEqual(sorted(report["selectedZ0Ids"]), ["z0_x000000_y000000", "z0_x000001_y000000"])

        acc = report["accounting"]
        self.assertEqual(acc["sourcePointsVisited"], 330)
        self.assertEqual(acc["eligibleSelectedZ0"], acc["p001Points"] + acc["adaptivePoints"])
        self.assertEqual(acc["eligibleSelectedZ0"], 330)  # every point lands in one of the two selected z0s
        self.assertEqual(acc["duplicates"], 0)
        self.assertEqual(acc["omittedEligiblePoints"], 0)
        self.assertEqual(acc["extraPoints"], 0)
        self.assertEqual(acc["wrongOwnerPoints"], 0)

        for z0_id in result["selectedZ0Ids"]:
            self.assertTrue((output_dir / ".node-manifests" / f"{z0_id}.json").exists())

        dense_pnts = output_dir / "points" / "z0" / "z0_x000000_y000000.pnts"
        self.assertTrue(dense_pnts.exists())  # ordinal 0 (first point) is a multiple of 1000

        state = json.loads((output_dir / MODULE.STATE_NAME).read_text())
        self.assertEqual(state["phase"], "residual-complete")
        self.assertEqual(sorted(state["completedZ0Ids"]), ["z0_x000000_y000000", "z0_x000001_y000000"])

    def test_explicit_z0_id_bypasses_census(self) -> None:
        patches = self._patches()
        with patches[0], patches[1], patches[2], patches[3], patches[4] as census_mock, patches[5]:
            result = MODULE.run_adaptive_point_hierarchy(
                root_dir=self.temp, dataset="d", z0_ids=["z0_x000000_y000000"],
            )
            census_mock.assert_not_called()
        self.assertEqual(result["selectedZ0Ids"], ["z0_x000000_y000000"])

    def test_resume_skips_already_completed_z0s(self) -> None:
        self._run()
        with mock.patch.object(MODULE, "finalize_one_z0") as finalize_mock:
            patches = self._patches()
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
                result = MODULE.run_adaptive_point_hierarchy(root_dir=self.temp, dataset="d", resume=True)
            finalize_mock.assert_not_called()
        self.assertEqual(sorted(result["selectedZ0Ids"]), ["z0_x000000_y000000", "z0_x000001_y000000"])

    def test_report_has_no_tileset_json(self) -> None:
        result = self._run()
        self.assertFalse((Path(result["outputPath"]) / "tileset.json").exists())


if __name__ == "__main__":
    unittest.main()
