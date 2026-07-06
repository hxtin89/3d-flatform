#!/usr/bin/env python3
"""Build a sidecar-based external tileset chain for one-lod-tree mode.

The source ``tileset.json`` files and all PNTS data remain untouched. The
builder writes only ``tileset-one-lod-tree.json`` sidecars:

  entry -> overview chunk -> explore chunk -> detail chunk

Every tile whose content URI points to JSON is a leaf in its containing file;
the next level of children lives inside the referenced external tileset.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable


SIDECAR_NAME = "tileset-one-lod-tree.json"
REMOTE_PREFIXES = ("http://", "https://")
DEFAULT_EXPLORE_REQUEST_RATIO = 2.5
DEFAULT_DETAIL_REQUEST_RATIO = 0.75


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Cannot read {path}: {exc}") from exc


def write_json_atomic(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            json.dump(obj, fp, indent=2)
            fp.write("\n")
        os.replace(tmp, path)
        os.chmod(path, 0o644)
    except OSError as exc:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise SystemExit(f"Cannot write {path}: {exc}") from exc


def bbox_overlaps_or_contains(
    outer: list[float],
    inner: list[float],
    tolerance: float = 50.0,
) -> bool:
    """Return whether an axis-aligned inner OBB fits inside outer + tolerance."""
    if len(outer) < 12 or len(inner) < 12:
        return False
    for axis in range(3):
        outer_half = abs(float(outer[3 + axis * 4]))
        inner_half = abs(float(inner[3 + axis * 4]))
        center_diff = abs(float(inner[axis]) - float(outer[axis]))
        if center_diff + inner_half > outer_half + tolerance:
            return False
    return True


def _is_json_uri(uri: str) -> bool:
    return uri.split("?", 1)[0].lower().endswith(".json")


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _relative_uri(from_dir: Path, target: Path, tilesets_dir: Path) -> str:
    target = target.resolve()
    if not _inside(target, tilesets_dir):
        raise SystemExit(f"Refusing URI outside tilesets root: {target}")
    uri = os.path.relpath(target, from_dir.resolve()).replace(os.sep, "/")
    if Path(uri).is_absolute() or uri.startswith("/"):
        raise SystemExit(f"Expected relative URI, got: {uri}")
    return uri


def _walk_tiles(tile: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield tile
    for child in tile.get("children", []):
        if isinstance(child, dict):
            yield from _walk_tiles(child)


def _rebase_content_uris(
    tile: dict[str, Any],
    source_dir: Path,
    output_dir: Path,
    tilesets_dir: Path,
) -> None:
    for current in _walk_tiles(tile):
        content = current.get("content")
        if not isinstance(content, dict) or not isinstance(content.get("uri"), str):
            continue
        uri = content["uri"]
        if uri.startswith(REMOTE_PREFIXES):
            raise SystemExit(f"Remote content is not supported in one-lod sidecars: {uri}")
        if uri.startswith("/"):
            raise SystemExit(f"Absolute content URI is not allowed: {uri}")
        target = (source_dir / uri).resolve()
        if not target.exists():
            raise SystemExit(f"Content target does not exist: {target}")
        content["uri"] = _relative_uri(output_dir, target, tilesets_dir)


def _generated_asset(
    source: dict[str, Any],
    stage: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    extras = copy.deepcopy(source.get("asset", {}).get("extras", {}))
    extras.update({
        "generator": "SBB One LOD Tree External Chain V2",
        "oneLodTreeStage": stage,
        **metadata,
    })
    return {"version": "1.1", "extras": extras}


def _document_error(document: dict[str, Any]) -> float:
    return max(
        float(document.get("geometricError", 0)),
        float(document.get("root", {}).get("geometricError", 0)),
    )


def _axis_length(axis: list[float]) -> float:
    return math.sqrt(sum(float(value) ** 2 for value in axis))


def _viewer_request_box(box: list[float], range_ratio: float) -> list[float]:
    """Keep the chunk footprint and extend its vertical request range by ratio."""
    if len(box) != 12:
        raise SystemExit(f"viewerRequestVolume requires a 12-value box: {box}")
    if not math.isfinite(range_ratio) or range_ratio <= 0:
        raise SystemExit(f"viewerRequestVolume ratio must be positive: {range_ratio}")

    center = [float(value) for value in box[:3]]
    axes = [
        [float(value) for value in box[3:6]],
        [float(value) for value in box[6:9]],
        [float(value) for value in box[9:12]],
    ]
    lengths = [_axis_length(axis) for axis in axes]
    if any(length <= 0 or not math.isfinite(length) for length in lengths):
        raise SystemExit(f"viewerRequestVolume box has an invalid half-axis: {box}")

    focus_radius = math.sqrt(sum(length * length for length in lengths))
    vertical_length = max(lengths[2], focus_radius * range_ratio)
    vertical_scale = vertical_length / lengths[2]
    vertical_axis = [value * vertical_scale for value in axes[2]]
    return [*center, *axes[0], *axes[1], *vertical_axis]


def _clone_document(
    source_path: Path,
    output_path: Path,
    tilesets_dir: Path,
    stage: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    source = read_json(source_path)
    root = copy.deepcopy(source.get("root"))
    if not isinstance(root, dict):
        raise SystemExit(f"Tileset has no root object: {source_path}")
    root.pop("transform", None)
    for child in root.get("children", []):
        if isinstance(child, dict):
            child.pop("transform", None)
    _rebase_content_uris(root, source_path.parent, output_path.parent, tilesets_dir)
    return {
        "asset": _generated_asset(source, stage, metadata),
        "geometricError": max(
            float(source.get("geometricError", 0)),
            float(root.get("geometricError", 0)),
        ),
        "root": root,
    }


def _external_leaf(
    external_document: dict[str, Any],
    owner_path: Path,
    target_path: Path,
    tilesets_dir: Path,
    request_ratio: float | None = None,
) -> dict[str, Any]:
    external_root = external_document["root"]
    leaf: dict[str, Any] = {
        "boundingVolume": copy.deepcopy(external_root["boundingVolume"]),
        "geometricError": _document_error(external_document),
        "refine": "REPLACE",
        "content": {
            "uri": _relative_uri(owner_path.parent, target_path, tilesets_dir),
        },
    }
    if request_ratio is not None:
        leaf["viewerRequestVolume"] = {
            "box": _viewer_request_box(
                external_root["boundingVolume"]["box"],
                request_ratio,
            )
        }
    return leaf


def _append_external_leaf(
    owner_document: dict[str, Any],
    external_document: dict[str, Any],
    owner_path: Path,
    target_path: Path,
    tilesets_dir: Path,
    request_ratio: float,
) -> None:
    leaf = _external_leaf(
        external_document,
        owner_path,
        target_path,
        tilesets_dir,
        request_ratio=request_ratio,
    )
    root = owner_document["root"]
    root.setdefault("children", []).append(leaf)
    required_error = float(leaf["geometricError"])
    root["geometricError"] = max(float(root.get("geometricError", 0)), required_error)
    owner_document["geometricError"] = max(
        float(owner_document.get("geometricError", 0)),
        float(root["geometricError"]),
    )


def _find_external_child(root: dict[str, Any], chunk_id: str) -> dict[str, Any]:
    matches = []
    for child in root.get("children", []):
        uri = child.get("content", {}).get("uri", "")
        if isinstance(uri, str) and chunk_id in uri and _is_json_uri(uri):
            matches.append(child)
    if len(matches) != 1:
        raise SystemExit(
            f"Expected one external child for chunk '{chunk_id}', found {len(matches)}"
        )
    return matches[0]


def _resolve_external_path(owner_path: Path, tile: dict[str, Any]) -> Path:
    uri = tile.get("content", {}).get("uri")
    if not isinstance(uri, str) or not _is_json_uri(uri):
        raise SystemExit(f"Expected external tileset URI in {owner_path}")
    if uri.startswith(REMOTE_PREFIXES) or uri.startswith("/"):
        raise SystemExit(f"Expected local relative external URI, got: {uri}")
    target = (owner_path.parent / uri).resolve()
    if not target.exists():
        raise SystemExit(f"External tileset not found: {target}")
    return target


def _validate_viewer_request_volume(path: Path, tile: dict[str, Any]) -> None:
    volume = tile.get("viewerRequestVolume")
    if volume is None:
        return
    box = volume.get("box") if isinstance(volume, dict) else None
    if not isinstance(box, list) or len(box) != 12:
        raise SystemExit(f"Invalid viewerRequestVolume box in {path}: {volume}")
    values = [float(value) for value in box]
    if not all(math.isfinite(value) for value in values):
        raise SystemExit(f"Non-finite viewerRequestVolume in {path}: {volume}")
    if any(_axis_length(values[index:index + 3]) <= 0 for index in (3, 6, 9)):
        raise SystemExit(f"Degenerate viewerRequestVolume in {path}: {volume}")
    uri = tile.get("content", {}).get("uri")
    if not isinstance(uri, str) or not _is_json_uri(uri):
        raise SystemExit(
            f"viewerRequestVolume is only supported on external JSON leaves: {path}"
        )


def _validate_document(
    path: Path,
    document: dict[str, Any],
    generated: dict[Path, dict[str, Any]],
    tilesets_dir: Path,
    allow_root_transform: bool,
) -> None:
    root = document.get("root")
    if not isinstance(root, dict):
        raise SystemExit(f"Generated document has no root: {path}")
    if document.get("asset", {}).get("version") != "1.1":
        raise SystemExit(f"Generated document must use 3D Tiles 1.1: {path}")
    if allow_root_transform:
        transform = root.get("transform")
        if not isinstance(transform, list) or len(transform) != 16:
            raise SystemExit(f"Entry root must contain one 16-value transform: {path}")
    elif "transform" in root:
        raise SystemExit(f"Only the entry root may contain transform: {path}")

    for tile in _walk_tiles(root):
        if tile is not root and "transform" in tile:
            raise SystemExit(f"Nested transform is not allowed in generated chain: {path}")
        tile_error = float(tile.get("geometricError", 0))
        for child in tile.get("children", []):
            child_error = float(child.get("geometricError", 0))
            if child_error > tile_error + 1e-6:
                raise SystemExit(
                    f"geometricError increases in {path}: {tile_error} -> {child_error}"
                )

        _validate_viewer_request_volume(path, tile)

        uri = tile.get("content", {}).get("uri")
        if not isinstance(uri, str):
            continue
        if uri.startswith(REMOTE_PREFIXES) or uri.startswith("/") or Path(uri).is_absolute():
            raise SystemExit(f"Generated URI must be local and relative: {path}: {uri}")
        target = (path.parent / uri).resolve()
        if not _inside(target, tilesets_dir):
            raise SystemExit(f"Generated URI escapes tilesets root: {path}: {uri}")
        target_document = generated.get(target)
        if not target.exists() and target_document is None:
            raise SystemExit(f"Generated URI target is missing: {path}: {uri}")
        if _is_json_uri(uri):
            if "children" in tile:
                raise SystemExit(
                    f"External tileset node must not contain children: {path}: {uri}"
                )
            if target_document is not None:
                external_error = _document_error(target_document)
                if external_error > tile_error + 1e-6:
                    raise SystemExit(
                        f"External geometricError increases: {path}: {tile_error} -> {external_error}"
                    )


def _validate_chain(
    entry_path: Path,
    documents: dict[Path, dict[str, Any]],
    tilesets_dir: Path,
) -> None:
    normalized = {path.resolve(): document for path, document in documents.items()}
    for path, document in normalized.items():
        _validate_document(
            path,
            document,
            normalized,
            tilesets_dir,
            allow_root_transform=path == entry_path.resolve(),
        )

    visiting: set[Path] = set()
    visited: set[Path] = set()

    def visit(path: Path) -> None:
        if path in visiting:
            raise SystemExit(f"Cycle detected in generated external chain at {path}")
        if path in visited:
            return
        visiting.add(path)
        for tile in _walk_tiles(normalized[path]["root"]):
            uri = tile.get("content", {}).get("uri")
            if not isinstance(uri, str) or not _is_json_uri(uri):
                continue
            target = (path.parent / uri).resolve()
            if target in normalized:
                visit(target)
        visiting.remove(path)
        visited.add(path)

    visit(entry_path.resolve())
    if visited != set(normalized):
        unreachable = sorted(str(path) for path in set(normalized) - visited)
        raise SystemExit(f"Generated sidecars are unreachable from entry: {unreachable}")


def build_one_lod_tree(
    root_dir: Path,
    dataset: str,
    area_id: str | None = None,
    public_root: str = "",
    p02_tolerance: float = 50.0,
    p100_tolerance: float = 50.0,
    explore_request_ratio: float = DEFAULT_EXPLORE_REQUEST_RATIO,
    detail_request_ratio: float = DEFAULT_DETAIL_REQUEST_RATIO,
) -> dict[str, Any]:
    """Build and validate one or all area chains before writing sidecars."""
    tilesets_dir = (root_dir / "local-storage" / "tilesets").resolve()
    logical = public_root.strip("/") if public_root else dataset
    logical_dir = tilesets_dir / logical
    manifest_path = logical_dir / "area-manifest.json"
    manifest = read_json(manifest_path)
    manifest_areas = manifest.get("areas", [])
    areas = {area["areaId"]: area for area in manifest_areas}
    if area_id is not None and area_id not in areas:
        raise SystemExit(f"Area '{area_id}' not found in {manifest_path}")
    selected_areas = [areas[area_id]] if area_id is not None else list(manifest_areas)
    if not selected_areas:
        raise SystemExit(f"No areas found in {manifest_path}")
    chunk_ids = [area["sourceChunkId"] for area in selected_areas]
    if len(chunk_ids) != len(set(chunk_ids)):
        raise SystemExit("One LOD Tree requires unique sourceChunkId values per area")

    def dataset_dir(value: str) -> Path:
        parts = value.strip("/").split("/")
        if parts and parts[0] == logical:
            parts = parts[1:]
        path = (logical_dir / Path(*parts)).resolve()
        if not _inside(path, logical_dir):
            raise SystemExit(f"Dataset path escapes logical root: {value}")
        return path

    overview_dir = dataset_dir(manifest["datasets"]["overview"]["dataset"])
    overview_root_path = overview_dir / "tileset.json"
    if not overview_root_path.exists():
        raise SystemExit(f"overview tileset not found: {overview_root_path}")
    overview_root_source = read_json(overview_root_path)
    output_name = f"{logical}-one-lod-tree"
    entry_path = logical_dir / output_name / SIDECAR_NAME
    entry_root = copy.deepcopy(overview_root_source["root"])
    _rebase_content_uris(entry_root, overview_root_path.parent, entry_path.parent, tilesets_dir)
    stage_documents: dict[Path, dict[str, Any]] = {}
    stage_paths: list[Path] = []
    replacements: list[dict[str, Any]] = []

    for area in selected_areas:
        current_area_id = area["areaId"]
        chunk_id = area["sourceChunkId"]
        explore_area_dir = dataset_dir(area["datasets"]["explore"]["dataset"])
        detail_area_dir = dataset_dir(area["datasets"]["detail"]["dataset"])
        explore_root_path = explore_area_dir / "tileset.json"
        detail_wrapper_path = detail_area_dir / "tileset.json"
        for label, path in (
            ("explore", explore_root_path),
            ("detail", detail_wrapper_path),
        ):
            if not path.exists():
                raise SystemExit(f"{label} tileset not found for {current_area_id}: {path}")

        overview_target = _find_external_child(overview_root_source["root"], chunk_id)
        overview_chunk_source = _resolve_external_path(overview_root_path, overview_target)
        explore_root_source = read_json(explore_root_path)
        explore_target = _find_external_child(explore_root_source["root"], chunk_id)
        explore_chunk_source = _resolve_external_path(explore_root_path, explore_target)
        detail_wrapper = read_json(detail_wrapper_path)
        detail_chunk_source = _resolve_external_path(detail_wrapper_path, detail_wrapper["root"])

        overview_sidecar = overview_chunk_source.parent / SIDECAR_NAME
        explore_sidecar = explore_chunk_source.parent / SIDECAR_NAME
        detail_sidecar = detail_area_dir / "chunks" / chunk_id / SIDECAR_NAME
        metadata = {
            "logicalDataset": logical,
            "sourceDataset": dataset,
            "areaId": current_area_id,
            "sourceChunkId": chunk_id,
            "requestRatios": {
                "explore": explore_request_ratio,
                "detail": detail_request_ratio,
            },
        }

        detail_document = _clone_document(
            detail_chunk_source, detail_sidecar, tilesets_dir, "detail", metadata
        )
        explore_document = _clone_document(
            explore_chunk_source, explore_sidecar, tilesets_dir, "explore", metadata
        )
        _append_external_leaf(
            explore_document,
            detail_document,
            explore_sidecar,
            detail_sidecar,
            tilesets_dir,
            request_ratio=detail_request_ratio,
        )
        overview_document = _clone_document(
            overview_chunk_source, overview_sidecar, tilesets_dir, "overview", metadata
        )
        _append_external_leaf(
            overview_document,
            explore_document,
            overview_sidecar,
            explore_sidecar,
            tilesets_dir,
            request_ratio=explore_request_ratio,
        )

        target = _find_external_child(entry_root, chunk_id)
        replacement = _external_leaf(
            overview_document, entry_path, overview_sidecar, tilesets_dir
        )
        children = entry_root.get("children", [])
        children[children.index(target)] = replacement
        replacements.append(replacement)

        p02_box = replacement["boundingVolume"]["box"]
        p10_box = explore_document["root"]["boundingVolume"]["box"]
        p100_box = detail_document["root"]["boundingVolume"]["box"]
        if not bbox_overlaps_or_contains(p02_box, p10_box, p02_tolerance):
            raise SystemExit(
                f"BBox mismatch overview -> explore for {current_area_id} "
                f"(tolerance={p02_tolerance}): overview={p02_box}, explore={p10_box}"
            )
        if not bbox_overlaps_or_contains(p10_box, p100_box, p100_tolerance):
            raise SystemExit(
                f"BBox mismatch explore -> detail for {current_area_id} "
                f"(tolerance={p100_tolerance}): explore={p10_box}, detail={p100_box}"
            )

        for path, document in (
            (overview_sidecar, overview_document),
            (explore_sidecar, explore_document),
            (detail_sidecar, detail_document),
        ):
            if path in stage_documents:
                raise SystemExit(f"Duplicate generated sidecar path: {path}")
            stage_documents[path] = document
            stage_paths.append(path)

    entry_root["children"] = entry_root.get("children", [])
    entry_error = max(
        float(overview_root_source.get("geometricError", 0)),
        float(entry_root.get("geometricError", 0)),
        *(float(replacement["geometricError"]) for replacement in replacements),
    )
    entry_root["geometricError"] = entry_error
    entry_metadata: dict[str, Any] = {
        "logicalDataset": logical,
        "sourceDataset": dataset,
        "areaCount": len(selected_areas),
        "areaIds": [area["areaId"] for area in selected_areas],
        "requestRatios": {
            "explore": explore_request_ratio,
            "detail": detail_request_ratio,
        },
    }
    if len(selected_areas) == 1:
        entry_metadata.update({
            "areaId": selected_areas[0]["areaId"],
            "sourceChunkId": selected_areas[0]["sourceChunkId"],
        })
    entry_document = {
        "asset": _generated_asset(overview_root_source, "entry", entry_metadata),
        "geometricError": entry_error,
        "root": entry_root,
    }

    documents = {entry_path: entry_document, **stage_documents}
    _validate_chain(entry_path, documents, tilesets_dir)
    for path in stage_paths:
        write_json_atomic(path, stage_documents[path])
    # Publish the entry last so it never references a sidecar that was not written.
    write_json_atomic(entry_path, entry_document)

    return {
        "outputPath": str(entry_path),
        "outputName": output_name,
        "topGeometricError": entry_error,
        "areaCount": len(selected_areas),
        "areaIds": [area["areaId"] for area in selected_areas],
        "sidecarPaths": [str(entry_path), *(str(path) for path in stage_paths)],
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build an external sidecar chain for one-lod-tree mode."
    )
    parser.add_argument("--root", required=True, help="Project root containing local-storage/.")
    parser.add_argument("--dataset", required=True, help="Source dataset, e.g. 2404PeruB2.")
    parser.add_argument(
        "--area",
        default=None,
        help="Optional area ID. Omit to build every area in area-manifest.json.",
    )
    parser.add_argument("--public-root", default="", help="Logical/public root, e.g. peru-b2-globe.")
    parser.add_argument("--p02-tolerance", type=float, default=50.0)
    parser.add_argument("--p100-tolerance", type=float, default=50.0)
    parser.add_argument(
        "--explore-request-ratio",
        type=float,
        default=DEFAULT_EXPLORE_REQUEST_RATIO,
        help="Vertical viewer request range as a multiple of the chunk half-diagonal.",
    )
    parser.add_argument(
        "--detail-request-ratio",
        type=float,
        default=DEFAULT_DETAIL_REQUEST_RATIO,
        help="Detail viewer request range as a multiple of the chunk half-diagonal.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    result = build_one_lod_tree(
        root_dir=Path(args.root).resolve(),
        dataset=args.dataset,
        area_id=args.area,
        public_root=args.public_root,
        p02_tolerance=args.p02_tolerance,
        p100_tolerance=args.p100_tolerance,
        explore_request_ratio=args.explore_request_ratio,
        detail_request_ratio=args.detail_request_ratio,
    )
    scope = args.area or f"all {result['areaCount']} areas"
    print(f"Built external one-lod chain for {args.dataset}/{scope}")
    print(f"  entry: {result['outputPath']}")
    print(f"  sidecars: {len(result['sidecarPaths'])}")
    print(
        "  viewer request ratios: "
        f"explore={args.explore_request_ratio}, detail={args.detail_request_ratio}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
