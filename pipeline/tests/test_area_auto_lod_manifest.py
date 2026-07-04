#!/usr/bin/env python3
"""Self-contained tests for area_auto_lod_manifest.py.

Run with: python3 pipeline/tests/test_area_auto_lod_manifest.py
"""
from __future__ import annotations

import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

import area_auto_lod_manifest as gen  # noqa: E402


def write_tileset(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "tileset.json").write_text(
        json.dumps({"asset": {"version": "1.0"}, "geometricError": 1.0, "root": {}}),
        encoding="utf-8",
    )


def make_source_manifest(
    logical_dir: Path,
    logical_dataset: str,
    overview_status_ok: bool,
    areas: list[dict],
    coordinate_mode: str = "globe",
) -> None:
    tilesets_dir = logical_dir.parent
    overview_dataset = f"{logical_dataset}/overview-p02"
    explore_dataset_template = f"{logical_dataset}/explore-p10/areas/{areas[0]['areaId']}"
    source = {
        "dataset": logical_dataset,
        "defaultMode": "overview",
        "defaultAreaId": areas[0]["areaId"] if areas else None,
        "datasets": {
            "overview": {
                "dataset": overview_dataset,
                "status": "ready" if overview_status_ok else "not_built",
            }
        },
        "coordinateMode": coordinate_mode,
        "bboxFrame": "enu" if coordinate_mode == "globe" else "source",
        "rootTransform": list(range(16)) if coordinate_mode == "globe" else None,
        "areas": areas,
    }
    logical_dir.mkdir(parents=True, exist_ok=True)
    (logical_dir / "area-manifest.json").write_text(
        json.dumps(source), encoding="utf-8"
    )
    # Build filesystem tilesets so status_for sees ready.
    if overview_status_ok:
        write_tileset(tilesets_dir / overview_dataset)
    for area in areas:
        explore = area["datasets"]["explore"]["dataset"]
        detail = area["datasets"]["detail"]["dataset"]
        if area["datasets"]["explore"]["status"] == "ready":
            write_tileset(tilesets_dir / explore)
        if area["datasets"]["detail"]["status"] == "ready":
            write_tileset(tilesets_dir / detail)


def base_area(area_id: str, chunk_id: str, ready_explore: bool = True, ready_detail: bool = True) -> dict:
    return {
        "areaId": area_id,
        "label": area_id,
        "sourceChunkId": chunk_id,
        "bbox": [0.0, 0.0, 0.0, 10.0, 10.0, 10.0],
        "sourceBbox": [0.0, 0.0, 0.0, 10.0, 10.0, 10.0],
        "pointCount": 1000,
        "datasets": {
            "explore": {"dataset": f"ds/explore/{area_id}", "status": "ready" if ready_explore else "not_built"},
            "detail": {"dataset": f"ds/detail/{area_id}", "status": "ready" if ready_detail else "not_built"},
            "context": {"dataset": f"ds/ctx/{area_id}", "status": "not_built"},
        },
    }


def build(root: Path, logical: str, source: Path | None = None) -> dict:
    return gen.build_auto_lod_manifest(root, logical, None, source)


def test_builds_full_manifest() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "peru-b2-globe"
        logical_dir = tilesets_dir / logical
        areas = [base_area("area-001", "chunk-1"), base_area("area-002", "chunk-2")]
        make_source_manifest(logical_dir, logical, True, areas)
        manifest = build(root, logical)

        assert manifest["version"] == 1
        assert manifest["mode"] == "auto-lod"
        assert manifest["dataset"] == logical
        assert manifest["defaultLevel"] == "p02"
        assert manifest["coordinateMode"] == "globe"
        assert len(manifest["areas"]) == 2
        assert manifest["levels"]["p02"]["status"] == "ready"
        assert manifest["areas"][0]["levels"]["p10"]["status"] == "ready"
        assert manifest["areas"][0]["levels"]["p100"]["status"] == "ready"
        keys = set(manifest["thresholds"].keys())
        assert {
            "p10EnterRatio", "p10ExitRatio",
            "p100EnterRatio", "p100ExitRatio",
            "settleMs", "visibleTimeoutMs", "retryMs",
        }.issubset(keys)
        print("✓ test_builds_full_manifest")


def test_duplicate_area_id_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "ds"
        logical_dir = tilesets_dir / logical
        areas = [base_area("area-001", "chunk-1"), base_area("area-001", "chunk-2")]
        make_source_manifest(logical_dir, logical, True, areas)
        try:
            build(root, logical)
        except gen.ManifestError as err:
            assert "Duplicate areaId" in str(err), err
            print("✓ test_duplicate_area_id_rejected")
            return
        raise AssertionError("Expected ManifestError for duplicate areaId")


def test_duplicate_source_chunk_id_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "ds"
        logical_dir = tilesets_dir / logical
        areas = [base_area("area-001", "chunk-1"), base_area("area-002", "chunk-1")]
        make_source_manifest(logical_dir, logical, True, areas)
        try:
            build(root, logical)
        except gen.ManifestError as err:
            assert "Duplicate sourceChunkId" in str(err), err
            print("✓ test_duplicate_source_chunk_id_rejected")
            return
        raise AssertionError("Expected ManifestError for duplicate sourceChunkId")


def test_bad_bbox_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "ds"
        logical_dir = tilesets_dir / logical
        area = base_area("area-001", "chunk-1")
        area["bbox"] = [10.0, 0.0, 0.0, 5.0, 10.0, 10.0]  # maxX < minX
        make_source_manifest(logical_dir, logical, True, [area])
        try:
            build(root, logical)
        except gen.ManifestError as err:
            assert "invalid bbox" in str(err), err
            print("✓ test_bad_bbox_rejected")
            return
        raise AssertionError("Expected ManifestError for bad bbox")


def test_missing_dataset_marked_not_built() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "ds"
        logical_dir = tilesets_dir / logical
        area = base_area("area-001", "chunk-1", ready_explore=False, ready_detail=False)
        make_source_manifest(logical_dir, logical, True, [area])
        manifest = build(root, logical)
        assert manifest["areas"][0]["levels"]["p10"]["status"] == "not_built"
        assert manifest["areas"][0]["levels"]["p100"]["status"] == "not_built"
        assert manifest["areas"][0]["levels"]["p10"]["dataset"] == "ds/explore/area-001"
        print("✓ test_missing_dataset_marked_not_built")


def test_missing_dataset_path_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "ds"
        logical_dir = tilesets_dir / logical
        area = base_area("area-001", "chunk-1")
        area["datasets"]["explore"]["dataset"] = ""
        make_source_manifest(logical_dir, logical, True, [area])
        try:
            build(root, logical)
        except gen.ManifestError as err:
            assert "explore/p10 dataset path" in str(err), err
            print("✓ test_missing_dataset_path_rejected")
            return
        raise AssertionError("Expected ManifestError for missing p10 dataset path")


def test_threshold_ordering_rejected() -> None:
    bad = {
        **gen.DEFAULT_THRESHOLDS,
        "p100ExitRatio": 5.0,  # > p10EnterRatio (2.5) -> violates ordering
    }
    try:
        gen.validate_thresholds(bad)
    except gen.ManifestError as err:
        assert "ordering" in str(err).lower() or "p100exitratio" in str(err).lower(), err
        print("✓ test_threshold_ordering_rejected")
        return
    raise AssertionError("Expected ManifestError for bad threshold ordering")


def test_atomic_write() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "ds"
        logical_dir = tilesets_dir / logical
        areas = [base_area("area-001", "chunk-1")]
        make_source_manifest(logical_dir, logical, True, areas)
        manifest = build(root, logical)
        out = logical_dir / "area-manifest-auto-lod.json"
        gen.write_json_atomic(out, manifest)
        assert out.exists()
        # No leftover temp files.
        leftover = [p for p in logical_dir.iterdir() if p.name.startswith(".area-manifest-auto-lod.json.")]
        assert leftover == [], leftover
        loaded = json.loads(out.read_text(encoding="utf-8"))
        assert loaded["areas"][0]["areaId"] == "area-001"
        print("✓ test_atomic_write")


def test_missing_source_manifest_errors_cleanly() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        try:
            build(Path(tmp), "nonexistent")
        except gen.ManifestError as err:
            assert "area-manifest.json missing" in str(err), err
            print("✓ test_missing_source_manifest_errors_cleanly")
            return
        raise AssertionError("Expected ManifestError for missing source manifest")


def test_missing_overview_dataset_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "ds"
        logical_dir = tilesets_dir / logical
        areas = [base_area("area-001", "chunk-1")]
        # Build a source manifest with NO overview dataset string at all.
        source = {
            "dataset": logical,
            "defaultMode": "overview",
            "defaultAreaId": "area-001",
            "datasets": {"overview": {}},
            "coordinateMode": "local",
            "bboxFrame": "source",
            "areas": areas,
        }
        logical_dir.mkdir(parents=True, exist_ok=True)
        (logical_dir / "area-manifest.json").write_text(
            json.dumps(source), encoding="utf-8"
        )
        try:
            build(root, logical)
        except gen.ManifestError as err:
            assert "overview dataset" in str(err), err
            print("✓ test_missing_overview_dataset_rejected")
            return
        raise AssertionError("Expected ManifestError for missing overview dataset")


def test_no_hardcoded_peru_fallback() -> None:
    """Generator must NOT fall back to 2404PeruB2-overview-p02."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "other-dataset"
        logical_dir = tilesets_dir / logical
        write_tileset(tilesets_dir / logical / f"{logical}/overview-p02")
        # Build a source manifest with an empty overview dataset string.
        source = {
            "dataset": logical,
            "defaultMode": "overview",
            "defaultAreaId": "area-001",
            "datasets": {"overview": {"dataset": "", "status": "not_built"}},
            "coordinateMode": "local",
            "bboxFrame": "source",
            "areas": [base_area("area-001", "chunk-1")],
        }
        logical_dir.mkdir(parents=True, exist_ok=True)
        (logical_dir / "area-manifest.json").write_text(
            json.dumps(source), encoding="utf-8"
        )
        try:
            build(root, logical)
        except gen.ManifestError as err:
            assert "2404PeruB2" not in str(err), "Must not mention hardcoded Peru"
            assert "overview dataset" in str(err), err
            print("✓ test_no_hardcoded_peru_fallback")
            return
        raise AssertionError("Expected ManifestError for empty overview dataset")


def test_globe_requires_valid_root_transform() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "ds-globe"
        logical_dir = tilesets_dir / logical
        areas = [base_area("area-001", "chunk-1")]
        make_source_manifest(logical_dir, logical, True, areas, coordinate_mode="globe")
        # Corrupt rootTransform.
        src = json.loads((logical_dir / "area-manifest.json").read_text(encoding="utf-8"))
        src["rootTransform"] = [1.0, 2.0, 3.0]  # only 3 numbers
        (logical_dir / "area-manifest.json").write_text(json.dumps(src), encoding="utf-8")
        try:
            build(root, logical)
        except gen.ManifestError as err:
            assert "rootTransform" in str(err), err
            print("✓ test_globe_requires_valid_root_transform")
            return
        raise AssertionError("Expected ManifestError for invalid globe rootTransform")


def test_output_file_permission_0644() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "ds"
        logical_dir = tilesets_dir / logical
        areas = [base_area("area-001", "chunk-1")]
        make_source_manifest(logical_dir, logical, True, areas)
        manifest = build(root, logical)
        out = logical_dir / "area-manifest-auto-lod.json"
        gen.write_json_atomic(out, manifest)
        mode = out.stat().st_mode & 0o777
        assert mode == 0o644, f"Expected 0o644, got {oct(mode)}"
        print("✓ test_output_file_permission_0644")


def test_explore_dataset_path_preserved() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        tilesets_dir = root / "local-storage" / "tilesets"
        logical = "my-public-root"
        logical_dir = tilesets_dir / logical
        area = base_area("area-001", "chunk-1")
        # Custom explore dataset paths populated by make_source_manifest.
        make_source_manifest(logical_dir, logical, True, [area])
        manifest = build(root, logical)
        # base_area() used in areas provides "ds/explore/area-001" — generator
        # must forward these verbatim rather than substituting or hardcoding.
        explore_ds = manifest["areas"][0]["levels"]["p10"]["dataset"]
        detail_ds = manifest["areas"][0]["levels"]["p100"]["dataset"]
        assert explore_ds == "ds/explore/area-001", explore_ds
        assert detail_ds == "ds/detail/area-001", detail_ds
        # Overview path is taken from the source manifest, not hardcoded.
        assert manifest["levels"]["p02"]["dataset"] == "my-public-root/overview-p02"
        print("✓ test_explore_dataset_path_preserved")

    # Suppress unused-import for shutil kept for parity with existing tests.
    _ = shutil


if __name__ == "__main__":
    test_builds_full_manifest()
    test_duplicate_area_id_rejected()
    test_duplicate_source_chunk_id_rejected()
    test_bad_bbox_rejected()
    test_missing_dataset_marked_not_built()
    test_missing_dataset_path_rejected()
    test_threshold_ordering_rejected()
    test_atomic_write()
    test_missing_source_manifest_errors_cleanly()
    test_missing_overview_dataset_rejected()
    test_no_hardcoded_peru_fallback()
    test_globe_requires_valid_root_transform()
    test_output_file_permission_0644()
    test_explore_dataset_path_preserved()
    print("\nAll area_auto_lod_manifest tests passed.")
