#!/usr/bin/env python3
"""Tests for the Spatial LOD Grid/Tree builder."""
from __future__ import annotations

import importlib.util
import json
import math
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np


MODULE_PATH = Path(__file__).parent.parent / "build_spatial_lod_tree.py"
SPEC = importlib.util.spec_from_file_location("build_spatial_lod_tree", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules["build_spatial_lod_tree"] = MODULE
SPEC.loader.exec_module(MODULE)

snap_grid_origin = MODULE.snap_grid_origin
cell_index = MODULE.cell_index
tile_id = MODULE.tile_id
parent_indices = MODULE.parent_indices
levels_for_ordinal = MODULE.levels_for_ordinal
box_contains = MODULE.box_contains
detail_request_volume = MODULE.detail_request_volume
z2_request_volume = MODULE.z2_request_volume
box_for_cell = MODULE.box_for_cell
build_from_points = MODULE.build_from_points
partition_points = MODULE.partition_points
finalize_output = MODULE.finalize_output
validate_output = MODULE.validate_output
read_pnts_header = MODULE.read_pnts_header
fingerprint_file = MODULE.fingerprint_file
fingerprint_matches = MODULE.fingerprint_matches
profile_hash = MODULE.profile_hash
write_json_atomic = MODULE.write_json_atomic
LEVELS = MODULE.LEVELS
LEAF_LEVEL_NAME = MODULE.LEAF_LEVEL_NAME
REQUEST_VOLUME_PARENT_LEVEL_NAME = MODULE.REQUEST_VOLUME_PARENT_LEVEL_NAME
Z0_CELL = MODULE.Z0_CELL
Z2_CELL = MODULE.Z2_CELL
Z3_CELL = MODULE.Z3_CELL
Z4_CELL = MODULE.Z4_CELL
RGB_DTYPE = MODULE.RGB_DTYPE


def fake_transform() -> list[float]:
    return [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        100.0, 200.0, 300.0, 1.0,
    ]


def make_points(n: int = 100) -> tuple[np.ndarray, np.ndarray]:
    xs = 10.0 + (np.arange(n) % 10) * 60.0
    ys = 10.0 + (np.arange(n) // 10) * 60.0
    zs = 5.0 + np.arange(n) * 0.1
    xyz = np.column_stack((xs, ys, zs)).astype(np.float64)
    rgb = np.tile(np.arange(n, dtype=np.uint8)[:, None], (1, 3))
    return xyz, rgb


class GridHelpersTests(unittest.TestCase):
    def test_snap_negative_min_down_to_z0_boundary(self) -> None:
        ox, oy = snap_grid_origin(-3858.82, 2949.64)
        self.assertEqual(ox, -4000.0)
        self.assertEqual(oy, 2000.0)

    def test_boundary_belongs_to_higher_index(self) -> None:
        self.assertEqual(cell_index(0.0, 0.0, 2000.0), 0)
        self.assertEqual(cell_index(2000.0, 0.0, 2000.0), 1)
        self.assertEqual(cell_index(-2000.0, 0.0, 2000.0), -1)
        self.assertEqual(cell_index(1999.99, 0.0, 2000.0), 0)
        self.assertEqual(cell_index(50.0, 0.0, 50.0), 1)
        self.assertEqual(cell_index(-50.0, 0.0, 50.0), -1)

    def test_tile_id_format(self) -> None:
        self.assertEqual(tile_id("z2", 12, 8), "z2_x000012_y000008")
        self.assertEqual(tile_id("z0", -3, -1), "z0_x-00003_y-00001")

    def test_parent_ratios(self) -> None:
        self.assertEqual(parent_indices("z1", 7, 9), ("z0", 3, 4))
        self.assertEqual(parent_indices("z2", 5, 3), ("z1", 2, 1))
        self.assertEqual(parent_indices("z3", 12, 7), ("z2", 6, 3))
        self.assertEqual(parent_indices("z4", 12, 7), ("z3", 2, 1))
        self.assertIsNone(parent_indices("z0", 0, 0))

    def test_nested_sampling_supersets(self) -> None:
        self.assertEqual(levels_for_ordinal(0), ["z0", "z1", "z2", "z3", "z4"])
        self.assertEqual(levels_for_ordinal(1000), ["z0", "z1", "z2", "z3", "z4"])
        self.assertEqual(levels_for_ordinal(50), ["z1", "z2", "z3", "z4"])
        self.assertEqual(levels_for_ordinal(60), ["z2", "z3", "z4"])
        self.assertEqual(levels_for_ordinal(10), ["z2", "z3", "z4"])
        self.assertEqual(levels_for_ordinal(2), ["z3", "z4"])
        self.assertEqual(levels_for_ordinal(12), ["z3", "z4"])
        self.assertEqual(levels_for_ordinal(1), ["z4"])
        self.assertEqual(levels_for_ordinal(3), ["z4"])


class BoxHelpersTests(unittest.TestCase):
    def test_box_contains(self) -> None:
        outer = box_for_cell("z0", 0, 0, 0.0, 0.0, Z0_CELL, 0.0, 100.0)
        inner = box_for_cell("z1", 0, 0, 0.0, 0.0, 500.0, 10.0, 90.0)
        self.assertTrue(box_contains(outer, inner))
        far = box_for_cell("z1", 5, 5, 0.0, 0.0, 500.0, 0.0, 100.0)
        self.assertFalse(box_contains(outer, far))

    def test_detail_request_volume_xy_scale_and_vertical_floor(self) -> None:
        rv = detail_request_volume("z3", 0, 0, 0.0, 0.0, 0.0, 10.0)
        self.assertEqual(rv[3], (Z3_CELL / 2.0) * 3.0)
        self.assertEqual(rv[7], (Z3_CELL / 2.0) * 3.0)
        self.assertGreaterEqual(rv[11], 500.0)
        rv2 = detail_request_volume("z3", 0, 0, 0.0, 0.0, 0.0, 2000.0)
        self.assertEqual(rv2[11], 1000.0)
        old = z2_request_volume(0, 0, 0.0, 0.0, 0.0, 10.0)
        self.assertEqual(old[3], (Z2_CELL / 2.0) * 3.0)


class BuildFromPointsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="spatial-lod-test-"))
        self.output = self.temp / "out"

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def build(self, points: np.ndarray, rgb: np.ndarray, bounds=None) -> dict:
        return build_from_points(
            output_dir=self.output,
            points_enu=points,
            rgb=rgb,
            grid_origin=(0.0, 0.0),
            root_transform=fake_transform(),
            enu_origin_lonlat=(-69.0, -12.0, 50.0),
            enu_origin_source=[0.0, 0.0, 0.0],
            enu_origin_ecef=[100.0, 200.0, 300.0],
            has_rgb=True,
            bounds_filter=bounds,
        )

    def test_full_round_trip_structure(self) -> None:
        pts, rgb = make_points(100)
        result = self.build(pts, rgb)
        entry = json.loads((self.output / "tileset.json").read_text())
        root = entry["root"]
        self.assertEqual(len(root["transform"]), 16)
        self.assertEqual(root["refine"], "REPLACE")
        self.assertGreater(root["geometricError"], 0)
        self.assertTrue(root["children"])
        # Every entry child points to a z0 tileset that exists.
        for child in root["children"]:
            uri = child["content"]["uri"]
            self.assertTrue(uri.startswith("z0/") and uri.endswith("tileset.json"))
            self.assertTrue((self.output / uri).exists())
        self.assertGreaterEqual(result["z0Count"], 1)
        # All five levels present.
        for lv in LEVELS:
            self.assertGreater(result["perLevel"][lv.name]["tiles"], 0)

    def test_entry_only_transform(self) -> None:
        pts, rgb = make_points(100)
        self.build(pts, rgb)
        entry = json.loads((self.output / "tileset.json").read_text())
        self.assertIn("transform", entry["root"])
        for child in entry["root"]["children"]:
            z0_path = self.output / child["content"]["uri"]
            z0_doc = json.loads(z0_path.read_text())
            self.assertNotIn("transform", z0_doc["root"])

    def test_monotonic_geometric_error_and_containment(self) -> None:
        pts, rgb = make_points(100)
        self.build(pts, rgb)
        entry = json.loads((self.output / "tileset.json").read_text())
        for child in entry["root"]["children"]:
            z0_doc = json.loads((self.output / child["content"]["uri"]).read_text())
            root = z0_doc["root"]

            def walk(tile, parent_box, parent_err):
                err = tile["geometricError"]
                self.assertLessEqual(err, parent_err + 1e-6)
                box = tile["boundingVolume"]["box"]
                if parent_box is not None:
                    self.assertTrue(box_contains(parent_box, box), f"child not contained: {box} in {parent_box}")
                self.assertEqual(tile.get("refine"), "REPLACE")
                for c in tile.get("children", []):
                    walk(c, box, err)

            walk(root, None, float("inf"))

    def test_leaf_siblings_share_request_volume(self) -> None:
        pts, rgb = make_points(100)
        self.build(pts, rgb)
        entry = json.loads((self.output / "tileset.json").read_text())
        for child in entry["root"]["children"]:
            z0_doc = json.loads((self.output / child["content"]["uri"]).read_text())

            def walk(tile, depth):
                children = tile.get("children", [])
                if depth == int(REQUEST_VOLUME_PARENT_LEVEL_NAME[1]) and children:
                    vols = []
                    for c in children:
                        if c["geometricError"] == 0.0:
                            vols.append(c["viewerRequestVolume"]["box"])
                    if len(vols) > 1:
                        first = vols[0]
                        for v in vols[1:]:
                            self.assertEqual(v, first)
                for c in children:
                    walk(c, depth + 1)

            walk(z0_doc["root"], 0)

    def test_pnts_header_rgb_rtc_center(self) -> None:
        pts, rgb = make_points(100)
        self.build(pts, rgb)
        # Find a leaf p100 PNTS.
        leaf_files = list((self.output / "points" / LEAF_LEVEL_NAME).glob("*.pnts"))
        self.assertTrue(leaf_files)
        header = read_pnts_header(leaf_files[0])
        self.assertEqual(header["version"], 1)
        self.assertIn("POINTS_LENGTH", header["featureTable"])
        self.assertIn("RTC_CENTER", header["featureTable"])
        self.assertIn("RGB", header["featureTable"])
        self.assertEqual(header["byteLength"], leaf_files[0].stat().st_size)

    def test_sparse_omission(self) -> None:
        # Points only in one leaf cell.
        pts = np.array([[10.0, 10.0, 5.0]] * 60)
        rgb = np.zeros((60, 3), dtype=np.uint8)
        result = self.build(pts, rgb)
        self.assertEqual(result["z0Count"], 1)
        z0_files = list((self.output / "z0").glob("*/tileset.json"))
        self.assertEqual(len(z0_files), 1)

    def test_deterministic_rebuild(self) -> None:
        pts, rgb = make_points(100)
        self.build(pts, rgb)
        first = (self.output / "tileset.json").read_bytes()
        shutil.rmtree(self.output)
        self.build(pts, rgb)
        second = (self.output / "tileset.json").read_bytes()
        self.assertEqual(first, second)

    def test_pilot_bounds_p100_equals_in_bounds_count(self) -> None:
        pts, rgb = make_points(100)
        bounds = (0.0, 0.0, 300.0, 300.0)
        in_bounds = int(((pts[:, 0] >= 0) & (pts[:, 0] <= 300) & (pts[:, 1] >= 0) & (pts[:, 1] <= 300)).sum())
        result = self.build(pts, rgb, bounds=bounds)
        self.assertEqual(result["perLevel"][LEAF_LEVEL_NAME]["points"], in_bounds)

    def test_pilot_and_full_select_same_ordinals(self) -> None:
        pts, rgb = make_points(100)
        full = self.build(pts, rgb)
        shutil.rmtree(self.output)
        pilot = self.build(pts, rgb, bounds=(0.0, 0.0, 300.0, 300.0))
        # z0 p001 points in pilot are a subset of full z0 (same ordinals, filtered by bounds).
        full_z0 = full["perLevel"]["z0"]["points"]
        pilot_z0 = pilot["perLevel"]["z0"]["points"]
        self.assertLessEqual(pilot_z0, full_z0)


class ResumeAndFingerprintTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="spatial-lod-resume-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_two_chunk_partition_equals_single_batch(self) -> None:
        pts, rgb = make_points(100)
        out_a = self.temp / "a"
        out_b = self.temp / "b"
        out_single = self.temp / "single"
        for o in (out_a, out_b, out_single):
            (o / MODULE.FRAGMENTS_DIR).mkdir(parents=True, exist_ok=True)

        counts: dict = {}
        leaf_ranges: dict = {}
        _, counts, leaf_ranges = partition_points(
            pts[:50], rgb[:50], 0, None, (0.0, 0.0), True,
            out_a / MODULE.FRAGMENTS_DIR, "chunk-a", counts, leaf_ranges,
        )
        _, counts, leaf_ranges = partition_points(
            pts[50:], rgb[50:], 50, None, (0.0, 0.0), True,
            out_b / MODULE.FRAGMENTS_DIR, "chunk-b", counts, leaf_ranges,
        )

        # Merge fragments into one dir layout for finalize.
        merged = self.temp / "merged" / MODULE.FRAGMENTS_DIR
        for src in (out_a / MODULE.FRAGMENTS_DIR, out_b / MODULE.FRAGMENTS_DIR):
            for chunk_dir in src.iterdir():
                dest = merged / chunk_dir.name
                shutil.copytree(chunk_dir, dest)

        single_counts: dict = {}
        single_leaf_ranges: dict = {}
        _, single_counts, single_leaf_ranges = partition_points(
            pts, rgb, 0, None, (0.0, 0.0), True,
            out_single / MODULE.FRAGMENTS_DIR, "chunk-a", single_counts, single_leaf_ranges,
        )

        self.assertEqual(counts, single_counts)
        self.assertEqual(leaf_ranges, single_leaf_ranges)

        result = finalize_output(
            output_dir=self.temp / "final",
            fragments_dir=merged,
            grid_origin=(0.0, 0.0),
            root_transform=fake_transform(),
            enu_origin_lonlat=(-69.0, -12.0, 50.0),
            enu_origin_source=[0.0, 0.0, 0.0],
            enu_origin_ecef=[100.0, 200.0, 300.0],
            has_rgb=True,
            counts=counts,
            leaf_zrange=leaf_ranges,
            source_files=[],
            bounds_filter=None,
            output_name="final",
            logical="test",
            area_manifest_uri="test/area-manifest.json",
            total_source_points=100,
        )
        self.assertGreater(result["z0Count"], 0)

    def test_fingerprint_match_and_mismatch(self) -> None:
        p = self.temp / "f.bin"
        p.write_bytes(b"x" * 100)
        rec = fingerprint_file(p)
        self.assertTrue(fingerprint_matches(rec, p))
        p.write_bytes(b"y" * 100)
        self.assertFalse(fingerprint_matches(rec, p))

    def test_profile_hash_stable(self) -> None:
        self.assertEqual(profile_hash(), profile_hash())

    def test_counts_leaf_serialize_roundtrip(self) -> None:
        counts = {("z4", 12, 8): 100, ("z0", -3, -1): 2}
        leaf = {(12, 8): (1.0, 2.0), (-3, -1): (0.0, 5.0)}
        self.assertEqual(MODULE.deserialize_counts(MODULE.serialize_counts(counts)), counts)
        self.assertEqual(MODULE.deserialize_leaf_zrange(MODULE.serialize_leaf_zrange(leaf)), leaf)


class ValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="spatial-lod-val-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_validate_rejects_missing_content(self) -> None:
        pts, rgb = make_points(100)
        out = self.temp / "out"
        build_from_points(
            output_dir=out, points_enu=pts, rgb=rgb, grid_origin=(0.0, 0.0),
            root_transform=fake_transform(), enu_origin_lonlat=(-69.0, -12.0, 50.0),
            enu_origin_source=[0.0, 0.0, 0.0], enu_origin_ecef=[100.0, 200.0, 300.0],
            has_rgb=True,
        )
        entry = json.loads((out / "tileset.json").read_text())
        # Delete a referenced z0 doc.
        first_z0 = out / entry["root"]["children"][0]["content"]["uri"]
        first_z0.unlink()
        with self.assertRaises(SystemExit):
            validate_output(entry, out)

    def test_validate_rejects_nested_transform(self) -> None:
        pts, rgb = make_points(100)
        out = self.temp / "out"
        build_from_points(
            output_dir=out, points_enu=pts, rgb=rgb, grid_origin=(0.0, 0.0),
            root_transform=fake_transform(), enu_origin_lonlat=(-69.0, -12.0, 50.0),
            enu_origin_source=[0.0, 0.0, 0.0], enu_origin_ecef=[100.0, 200.0, 300.0],
            has_rgb=True,
        )
        entry = json.loads((out / "tileset.json").read_text())
        z0_uri = entry["root"]["children"][0]["content"]["uri"]
        z0_doc = json.loads((out / z0_uri).read_text())
        z0_doc["root"]["transform"] = [1.0] * 16
        write_json_atomic(out / z0_uri, z0_doc)
        with self.assertRaises(SystemExit):
            validate_output(entry, out)


class NameValidationAndPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="spatial-lod-name-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_reject_traversal_dataset(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_name("../escape", "dataset")

    def test_reject_empty_output_name(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_name("", "output-name")

    def test_reject_resume_and_overwrite_together(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.build_spatial_lod_tree(
                root_dir=self.temp, dataset="d", resume=True, overwrite=True,
            )

    def test_cli_positional_dataset_parses(self) -> None:
        ns = MODULE.parse_args(["mydataset", "--root", str(self.temp)])
        self.assertEqual(ns.dataset, "mydataset")
        # parse_args must not accept --dataset
        with self.assertRaises(SystemExit):
            MODULE.parse_args(["--root", str(self.temp), "--dataset", "x"])

    def test_overwrite_preserves_existing_output_when_preflight_fails(self) -> None:
        input_dir = self.temp / "local-storage/intermediate/d/chunks-copc"
        input_dir.mkdir(parents=True)
        output_dir = self.temp / "local-storage/tilesets/d/d-spatial-lod"
        output_dir.mkdir(parents=True)
        sentinel = output_dir / "known-good.txt"
        sentinel.write_text("keep", encoding="utf-8")

        with mock.patch.object(MODULE, "preflight", side_effect=SystemExit("bad source")):
            with self.assertRaises(SystemExit):
                MODULE.build_spatial_lod_tree(self.temp, "d", overwrite=True)

        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_overwrite_preserves_existing_output_when_disk_check_fails(self) -> None:
        input_dir = self.temp / "local-storage/intermediate/d/chunks-copc"
        input_dir.mkdir(parents=True)
        output_dir = self.temp / "local-storage/tilesets/d/d-spatial-lod"
        output_dir.mkdir(parents=True)
        sentinel = output_dir / "known-good.txt"
        sentinel.write_text("keep", encoding="utf-8")
        preflight_result = {
            "files": [],
            "records": [],
            "crs_wkt": "fake-crs",
            "has_rgb": True,
            "source_mins": np.array([0.0, 0.0, 0.0]),
            "source_maxs": np.array([1.0, 1.0, 1.0]),
            "total_points": 1,
        }
        frame = {
            "root_transform": fake_transform(),
            "enu_origin_lonlat": (-69.0, -12.0, 50.0),
            "enu_origin_ecef": np.array([100.0, 200.0, 300.0]),
        }

        with (
            mock.patch.object(MODULE, "preflight", return_value=preflight_result),
            mock.patch.object(MODULE, "_crs_from_wkt", return_value=object()),
            mock.patch.object(MODULE, "build_enu_frame", return_value=frame),
            mock.patch.object(
                MODULE,
                "transform_bounds_to_enu",
                return_value=(np.array([0.0, 0.0, 0.0]), np.array([1.0, 1.0, 1.0])),
            ),
            mock.patch.object(MODULE, "_check_disk_space", side_effect=SystemExit("low disk")),
        ):
            with self.assertRaises(SystemExit):
                MODULE.build_spatial_lod_tree(self.temp, "d", overwrite=True)

        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")


class ColorScaleTests(unittest.TestCase):
    def test_rgb16_to_u8(self) -> None:
        values = np.array([0, 256, 32768, 65535], dtype=np.uint16)
        out = MODULE.color_to_u8(values, 256.0)
        self.assertEqual(out.tolist(), [0, 1, 128, 255])

    def test_clamp_overflow(self) -> None:
        out = MODULE.color_to_u8(np.array([70000], dtype=np.int32), 256.0)
        self.assertEqual(int(out[0]), 255)


class ResumeMismatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="spatial-lod-resumemismatch-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_reject_added_source(self) -> None:
        saved = {"sourceFiles": [{"name": "a"}], "hasRgb": True, "colorScale": 256.0,
                 "profileHash": "p", "gridOrigin": [0, 0], "enuOriginSource": [0, 0, 0],
                 "rootTransform": [1.0] * 16, "boundsFilter": None, "outputName": "x"}
        fresh = {"sourceFiles": [{"name": "a"}, {"name": "b"}], "hasRgb": True, "colorScale": 256.0,
                 "profileHash": "p", "gridOrigin": [0, 0], "enuOriginSource": [0, 0, 0],
                 "rootTransform": [1.0] * 16, "boundsFilter": None, "outputName": "x"}
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, fresh)

    def test_reject_reordered_source(self) -> None:
        saved = {"sourceFiles": [{"name": "a"}, {"name": "b"}], "hasRgb": True, "colorScale": 256.0,
                 "profileHash": "p", "gridOrigin": [0, 0], "enuOriginSource": [0, 0, 0],
                 "rootTransform": [1.0] * 16, "boundsFilter": None, "outputName": "x"}
        fresh = {"sourceFiles": [{"name": "b"}, {"name": "a"}], "hasRgb": True, "colorScale": 256.0,
                 "profileHash": "p", "gridOrigin": [0, 0], "enuOriginSource": [0, 0, 0],
                 "rootTransform": [1.0] * 16, "boundsFilter": None, "outputName": "x"}
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, fresh)

    def test_reject_changed_rgb(self) -> None:
        saved = {"sourceFiles": [{"name": "a"}], "hasRgb": True, "colorScale": 256.0,
                 "profileHash": "p", "gridOrigin": [0, 0], "enuOriginSource": [0, 0, 0],
                 "rootTransform": [1.0] * 16, "boundsFilter": None, "outputName": "x"}
        fresh = {"sourceFiles": [{"name": "a"}], "hasRgb": False, "colorScale": 256.0,
                 "profileHash": "p", "gridOrigin": [0, 0], "enuOriginSource": [0, 0, 0],
                 "rootTransform": [1.0] * 16, "boundsFilter": None, "outputName": "x"}
        with self.assertRaises(SystemExit):
            MODULE._validate_resume_state(saved, fresh)


class AreaManifestUriTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="spatial-lod-uri-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_area_manifest_uri_is_relative_to_output(self) -> None:
        pts, rgb = make_points(100)
        out = self.temp / "out"
        build_from_points(
            output_dir=out, points_enu=pts, rgb=rgb, grid_origin=(0.0, 0.0),
            root_transform=fake_transform(), enu_origin_lonlat=(-69.0, -12.0, 50.0),
            enu_origin_source=[0.0, 0.0, 0.0], enu_origin_ecef=[100.0, 200.0, 300.0],
            has_rgb=True, area_manifest_uri="../area-manifest.json",
        )
        report = json.loads((out / "spatial-lod-report.json").read_text())
        self.assertEqual(report["areaManifestUri"], "../area-manifest.json")


class DiskPreflightTests(unittest.TestCase):
    def test_estimate_grows_with_points(self) -> None:
        small = MODULE._estimate_output_bytes(1000, True, False)
        big = MODULE._estimate_output_bytes(100_000_000, True, False)
        self.assertGreater(big, small)


class AtomicPntsResumeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="spatial-lod-atomic-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def test_pnts_is_valid_roundtrip(self) -> None:
        pts, rgb = make_points(50)
        out = self.temp / "out"
        build_from_points(
            output_dir=out, points_enu=pts, rgb=rgb, grid_origin=(0.0, 0.0),
            root_transform=fake_transform(), enu_origin_lonlat=(-69.0, -12.0, 50.0),
            enu_origin_source=[0.0, 0.0, 0.0], enu_origin_ecef=[100.0, 200.0, 300.0],
            has_rgb=True,
        )
        import glob
        p = sorted(glob.glob(str(out / f"points/{LEAF_LEVEL_NAME}/*.pnts")))[0]
        h = read_pnts_header(Path(p))
        self.assertTrue(MODULE.pnts_is_valid(Path(p), h["featureTable"]["POINTS_LENGTH"], True))

    def test_pnts_is_valid_rejects_truncated(self) -> None:
        pts, rgb = make_points(50)
        out = self.temp / "out"
        build_from_points(
            output_dir=out, points_enu=pts, rgb=rgb, grid_origin=(0.0, 0.0),
            root_transform=fake_transform(), enu_origin_lonlat=(-69.0, -12.0, 50.0),
            enu_origin_source=[0.0, 0.0, 0.0], enu_origin_ecef=[100.0, 200.0, 300.0],
            has_rgb=True,
        )
        import glob
        p = Path(sorted(glob.glob(str(out / f"points/{LEAF_LEVEL_NAME}/*.pnts")))[0])
        data = p.read_bytes()
        p.write_bytes(data[: len(data) // 2])  # truncate
        self.assertFalse(MODULE.pnts_is_valid(p, 50, True))

    def test_resume_finalize_skips_valid_pnts(self) -> None:
        pts, rgb = make_points(100)
        out = self.temp / "out"
        frag = out / MODULE.FRAGMENTS_DIR
        frag.mkdir(parents=True, exist_ok=True)
        _, counts, leaf_ranges = partition_points(
            pts, rgb, 0, None, (0.0, 0.0), True, frag, "chunk-test", {}, {},
        )

        kwargs = dict(
            output_dir=out, fragments_dir=frag, grid_origin=(0.0, 0.0),
            root_transform=fake_transform(), enu_origin_lonlat=(-69.0, -12.0, 50.0),
            enu_origin_source=[0.0, 0.0, 0.0], enu_origin_ecef=[100.0, 200.0, 300.0],
            has_rgb=True, counts=counts, leaf_zrange=leaf_ranges,
            source_files=[], bounds_filter=None, output_name="out",
            logical="test", area_manifest_uri="../area-manifest.json",
            total_source_points=100,
        )

        finalize_output(**kwargs, resume_finalize=False)
        pnts_mtimes = {path: path.stat().st_mtime_ns for path in out.glob("points/*/*.pnts")}

        # A crash after atomic PNTS publication leaves no fragments for those
        # tiles. Resume must trust every valid PNTS before trying to merge.
        shutil.rmtree(frag, ignore_errors=True)
        frag.mkdir(parents=True)
        result = finalize_output(**kwargs, resume_finalize=True)

        self.assertGreater(result["occupiedCount"], 0)
        self.assertEqual(
            {path: path.stat().st_mtime_ns for path in out.glob("points/*/*.pnts")},
            pnts_mtimes,
        )


class EnuBboxIntersectsTests(unittest.TestCase):
    def test_intersects(self) -> None:
        self.assertTrue(MODULE.enu_bbox_intersects(
            np.array([100.0, 100.0]), np.array([200.0, 200.0]), (150.0, 150.0, 300.0, 300.0)
        ))

    def test_no_intersect(self) -> None:
        self.assertFalse(MODULE.enu_bbox_intersects(
            np.array([1000.0, 1000.0]), np.array([2000.0, 2000.0]), (0.0, 0.0, 500.0, 500.0)
        ))


if __name__ == "__main__":
    unittest.main(verbosity=2)
