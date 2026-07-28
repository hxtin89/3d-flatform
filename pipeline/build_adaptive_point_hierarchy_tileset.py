#!/usr/bin/env python3
"""Publish Task 3 APH 3D Tiles metadata from durable Task 2 artifacts."""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import struct
import tempfile
from pathlib import Path
from typing import Any

STATE_NAME = ".adaptive-point-hierarchy-state.json"
PREVIEW_REPORT = "adaptive-point-hierarchy-preview-report.json"
FULL_REPORT = "adaptive-point-hierarchy-report.json"
Z0_RE = re.compile(r"^z0_x-?\d+_y-?\d+$")
VARIANTS = ("none", "frontier-tight")
VALIDATED_PNTS: set[Path] = set()
FULL_VALIDATE = False
FAST_VALIDATE_PNTS_LIMIT = 32


def normalized_content_uri(uri: str) -> str:
    """Static counterpart of the viewer's slash/query-free URI contract."""
    return uri.replace("\\", "/").split("?", 1)[0].split("#", 1)[0].lstrip("/")


def compact_aph_node_diagnostics(node: dict[str, Any]) -> dict[str, Any]:
    emitted = int(node.get("emittedPointCount", node["pointCount"]))
    result: dict[str, Any] = {
        "nodeId": node["nodeId"],
        "depth": int(node["depth"]),
        "kind": node["kind"],
        "emittedPointCount": emitted,
        "inputPointCount": int(node.get("inputPointCount", emitted)),
    }
    if node["kind"] == "internal":
        result["residualRoutedPointCount"] = int(node.get("residualRoutedPointCount", 0))
        result["representativePointCount"] = int(node.get("representativePointCount", emitted))
    else:
        diagnostics = node.get("leafDiagnostics") or {}
        extent = diagnostics.get("extentMeters") or {}
        result.update({
            "extentMeters": {
                "width": extent.get("width"), "height": extent.get("height"), "zSpan": extent.get("zSpan"),
            },
            "bboxDensityPointsPerSquareMeter": diagnostics.get("bboxDensityPointsPerSquareMeter"),
            "bboxAreaClamped": diagnostics.get("bboxAreaClamped"),
            "underfilledReason": node.get("underfilledReason"),
        })
    return result


def compact_aph_p001_diagnostics(manifest: dict[str, Any]) -> dict[str, Any] | None:
    p001 = manifest.get("p001")
    if not isinstance(p001, dict):
        return None
    emitted = int(p001["pointCount"])
    return {
        "nodeId": f"{manifest['z0Id']}/p001",
        "depth": "p001",
        "kind": "p001",
        "emittedPointCount": emitted,
        "inputPointCount": emitted,
    }


def build_z0_metadata_map(manifest: dict[str, Any]) -> dict[str, Any]:
    """Map relative content paths to compact node diagnostics for one z0."""
    entries: dict[str, dict[str, Any]] = {}
    p001 = manifest.get("p001")
    p001_diagnostics = compact_aph_p001_diagnostics(manifest)
    if isinstance(p001, dict) and p001_diagnostics is not None:
        entries[normalized_content_uri(str(p001["pntsUri"]))] = p001_diagnostics
    for node in manifest["nodes"]:
        entries[normalized_content_uri(str(node["pntsUri"]))] = compact_aph_node_diagnostics(node)
    return {"schemaVersion": 1, "z0Id": manifest["z0Id"], "entries": entries}


def write_metadata_maps(output: Path, manifests: list[dict[str, Any]]) -> dict[str, Any]:
    subtrees: dict[str, str] = {}
    bytes_written = 0
    for manifest in manifests:
        z0_id = str(manifest["z0Id"])
        relative_path = f"z0/{z0_id}/aph-node-diagnostics.json"
        path = output / relative_path
        write_json_atomic(path, build_z0_metadata_map(manifest))
        bytes_written += path.stat().st_size
        subtrees[z0_id] = relative_path
    index_path = output / "aph-node-diagnostics-index.json"
    write_json_atomic(index_path, {"schemaVersion": 1, "subtrees": subtrees})
    bytes_written += index_path.stat().st_size
    return {"index": index_path.name, "subtrees": subtrees, "bytes": bytes_written}


def json_bytes(value: dict[str, Any]) -> int:
    return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def aph_metadata_byte_delta(document: dict[str, Any]) -> int:
    """Measure the additive payload from tile-level `extras.aph` metadata."""
    baseline = json.loads(json.dumps(document))

    def strip(tile: dict[str, Any]) -> None:
        extras = tile.get("extras")
        if isinstance(extras, dict):
            extras.pop("aph", None)
        for child in tile.get("children", []):
            if isinstance(child, dict):
                strip(child)

    root = baseline.get("root")
    if isinstance(root, dict):
        strip(root)
    return json_bytes(document) - json_bytes(baseline)


def variant_file_tag(variant: str) -> str:
    return "no-vrv" if variant == "none" else variant


def entry_asset_extras(state: dict[str, Any], variant: str, **extra: Any) -> dict[str, Any]:
    return {
        "generator": "SBB APH Task 3",
        "adaptivePointHierarchy": True,
        "coordinateMode": "globe",
        "local_only": False,
        "vrv": variant,
        "gridOrigin": state.get("gridOrigin"),
        "enuOriginSource": state.get("enuOriginSource"),
        "enuOriginEcef": state.get("enuOriginEcef"),
        "enuOriginLonLat": state.get("enuOriginLonLat"),
        **extra,
    }


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as fp:
        json.dump(value, fp, indent=2)
        fp.write("\n")
        temporary = Path(fp.name)
    os.replace(temporary, path)


def union_bounds(items: list[list[float]]) -> list[float]:
    if not items or any(len(item) != 6 for item in items):
        raise SystemExit("Cannot union empty or malformed bounds")
    return [min(item[i] for item in items) for i in range(3)] + [max(item[i] for item in items) for i in range(3, 6)]


def box_for_bounds(bounds: list[float]) -> list[float]:
    minx, miny, minz, maxx, maxy, maxz = bounds
    return [(minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2,
            (maxx - minx) / 2, 0.0, 0.0, 0.0, (maxy - miny) / 2, 0.0,
            0.0, 0.0, (maxz - minz) / 2]


def box_bounds(box: list[float]) -> list[float]:
    return [box[0] - abs(box[3]), box[1] - abs(box[7]), box[2] - abs(box[11]),
            box[0] + abs(box[3]), box[1] + abs(box[7]), box[2] + abs(box[11])]


def contains(outer: list[float], inner: list[float], eps: float = 1e-5) -> bool:
    return all(outer[i] <= inner[i] + eps for i in range(3)) and all(outer[i] + eps >= inner[i] for i in range(3, 6))


def representation_error(bounds: list[float], points: int, scale: float) -> float:
    area = max((bounds[3] - bounds[0]) * (bounds[4] - bounds[1]), 1e-6)
    return math.sqrt(area / max(1, points)) * scale


def corrected_error(raw: float, child_errors: list[float]) -> float:
    if not child_errors:
        return 0.0
    largest = max(child_errors)
    return max(raw, largest * 1.05, largest + 0.01)


def frontier_volume(bounds: list[float]) -> list[float]:
    cx, cy, cz = (bounds[0] + bounds[3]) / 2, (bounds[1] + bounds[4]) / 2, (bounds[2] + bounds[5]) / 2
    hx = max(100.0, 1.5 * (bounds[3] - bounds[0])) / 2
    hy = max(100.0, 1.5 * (bounds[4] - bounds[1])) / 2
    hz = max(200.0, 2.0 * (bounds[5] - bounds[2])) / 2
    return [cx, cy, cz, hx, 0.0, 0.0, 0.0, hy, 0.0, 0.0, 0.0, hz]


def build_adaptive_tile(node: dict[str, Any], nodes: dict[str, dict[str, Any]], scale: float,
                        variant: str) -> tuple[dict[str, Any], list[float], float]:
    children = [build_adaptive_tile(nodes[child], nodes, scale, variant) for child in node.get("children", [])]
    content_bounds = list(map(float, node["contentBounds"]))
    subtree_bounds = union_bounds([content_bounds, *[child[1] for child in children]])
    error = corrected_error(representation_error(content_bounds, int(node["pointCount"]), scale), [child[2] for child in children])
    tile: dict[str, Any] = {
        "boundingVolume": {"box": box_for_bounds(subtree_bounds)},
        "geometricError": error,
        "refine": "ADD",
        "content": {"uri": "../../" + str(node["pntsUri"])},
        "extras": {
            "aphNodeId": node["nodeId"], "aphDepth": int(node["depth"]),
            "aph": compact_aph_node_diagnostics(node),
        },
    }
    if children:
        tile["children"] = [child[0] for child in children]
    if variant == "frontier-tight" and int(node["depth"]) == 5:
        tile["viewerRequestVolume"] = {"box": frontier_volume(subtree_bounds)}
    return tile, subtree_bounds, error


def build_z0_document(manifest: dict[str, Any], scale: float, variant: str) -> tuple[dict[str, Any], list[float], float, int]:
    nodes = {node["nodeId"]: node for node in manifest["nodes"]}
    roots = [node for node in nodes.values() if node.get("parent") is None]
    if len(roots) != 1:
        raise SystemExit(f"{manifest.get('z0Id')}: expected exactly one adaptive root")
    adaptive, adaptive_bounds, adaptive_error = build_adaptive_tile(roots[0], nodes, scale, variant)
    p001 = manifest["p001"]
    p001_bounds = list(map(float, p001["contentBounds"]))
    subtree = union_bounds([p001_bounds, adaptive_bounds])
    root_error = corrected_error(representation_error(p001_bounds, int(p001["pointCount"]), scale), [adaptive_error])
    root = {
        "boundingVolume": {"box": box_for_bounds(subtree)}, "geometricError": root_error, "refine": "ADD",
        "content": {"uri": "../../" + str(p001["pntsUri"])}, "children": [adaptive],
        "extras": {
            "aphZ0Id": manifest["z0Id"], "aphContent": "p001",
            "aph": compact_aph_p001_diagnostics(manifest),
        },
    }
    return ({"asset": {"version": "1.0", "extras": {"generator": "SBB APH Task 3", "adaptivePointHierarchy": True,
                                                                "z0Id": manifest["z0Id"], "vrv": variant,
                                                                "aphMetadataMapUri": "aph-node-diagnostics.json"}},
             "geometricError": root_error, "root": root}, subtree, root_error, len(nodes) + 1)


def validate_tile(tile: dict[str, Any], document_dir: Path, output_root: Path, parent_error: float = math.inf,
                  parent_bounds: list[float] | None = None, entry: bool = False) -> int:
    if tile.get("refine") != "ADD":
        raise SystemExit("APH tile must use ADD")
    bounds = box_bounds(tile.get("boundingVolume", {}).get("box", []))
    if parent_bounds is not None and not contains(parent_bounds, bounds):
        raise SystemExit("APH parent bounding volume does not contain child")
    error = float(tile.get("geometricError", -1))
    if error < 0 or error >= parent_error:
        raise SystemExit(f"APH geometricError is not strictly decreasing: {error} >= {parent_error}")
    if not entry and "transform" in tile:
        raise SystemExit("Only APH entry root may carry transform")
    uri = tile.get("content", {}).get("uri")
    if uri:
        target = (document_dir / uri).resolve()
        if output_root not in target.parents and target != output_root:
            raise SystemExit(f"APH URI escapes output: {uri}")
        if not target.exists():
            raise SystemExit(f"Missing APH content: {target}")
        if target.suffix == ".pnts":
            validate_pnts_header(target)
    count = 1
    for child in tile.get("children", []):
        count += validate_tile(child, document_dir, output_root, error, bounds)
    return count


def validate_pnts_header(path: Path) -> None:
    if path in VALIDATED_PNTS:
        return
    if not FULL_VALIDATE and len(VALIDATED_PNTS) >= FAST_VALIDATE_PNTS_LIMIT:
        return
    with path.open("rb") as fp:
        header = fp.read(28)
    if len(header) != 28 or header[:4] != b"pnts":
        raise SystemExit(f"Invalid PNTS header: {path}")
    version, byte_length = struct.unpack_from("<II", header, 4)
    if version != 1 or byte_length != path.stat().st_size:
        raise SystemExit(f"Invalid PNTS version/byteLength: {path}")
    VALIDATED_PNTS.add(path)
    if len(VALIDATED_PNTS) % 500 == 0:
        print(f"  validation: {len(VALIDATED_PNTS)} unique PNTS headers", flush=True)


def publish_preview(output: Path, z0_id: str) -> dict[str, Any]:
    state = json.loads((output / STATE_NAME).read_text(encoding="utf-8"))
    if z0_id not in state.get("completedZ0Ids", []):
        raise SystemExit(f"z0 is not durable in Task 2 state: {z0_id}")
    manifest_path = output / ".node-manifests" / f"{z0_id}.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    scale = float(state["cliProfile"]["errorScale"])
    metadata = write_metadata_maps(output, [manifest])
    variants: dict[str, Any] = {}
    for variant in VARIANTS:
        file_tag = variant_file_tag(variant)
        z0_doc, bounds, z0_error, tile_count = build_z0_document(manifest, scale, variant)
        z0_path = output / "z0" / z0_id / f"tileset-{file_tag}.json"
        write_json_atomic(z0_path, z0_doc)
        validate_tile(z0_doc["root"], z0_path.parent, output)
        bootstrap_error = max(math.dist(bounds[:3], bounds[3:]), z0_error * 1.05, z0_error + 0.01)
        entry_root = {
            "boundingVolume": {"box": box_for_bounds(bounds)}, "geometricError": bootstrap_error,
            "refine": "ADD", "transform": state["rootTransform"],
            "children": [{"boundingVolume": {"box": box_for_bounds(bounds)}, "geometricError": z0_error,
                          "refine": "ADD", "content": {"uri": f"z0/{z0_id}/tileset-{file_tag}.json"}}],
        }
        entry = {"asset": {"version": "1.0", "extras": entry_asset_extras(
                  state, variant, previewZ0Id=z0_id, aphMetadataIndexUri=metadata["index"])},
                 "geometricError": bootstrap_error, "root": entry_root}
        entry_path = output / f"tileset-preview-{z0_id}-{file_tag}.json"
        write_json_atomic(entry_path, entry)
        validate_tile(entry_root, output, output, entry=True)
        variants[variant] = {"entry": entry_path.name, "z0Document": str(z0_path.relative_to(output)),
                             "tileCount": tile_count + 1, "rootGeometricError": bootstrap_error,
                             "z0GeometricError": z0_error,
                             "tilesetMetadataByteDelta": aph_metadata_byte_delta(z0_doc)}
    report = {"schemaVersion": 1, "status": "preview-ready", "previewZ0Id": z0_id,
              "sourceManifest": str(manifest_path), "variants": variants,
              "metadata": {"index": metadata["index"], "bytes": metadata["bytes"]},
              "validation": {"mode": "full" if FULL_VALIDATE else "fast", "pntsHeaders": len(VALIDATED_PNTS)},
              "task2StatePhaseAtPublish": state.get("phase"), "canonicalPublished": False}
    write_json_atomic(output / PREVIEW_REPORT, report)
    return report


def publish_full(output: Path) -> dict[str, Any]:
    state = json.loads((output / STATE_NAME).read_text(encoding="utf-8"))
    selected = list(state.get("selectedZ0Ids", []))
    completed = set(state.get("completedZ0Ids", []))
    missing = [z0_id for z0_id in selected if z0_id not in completed]
    if not selected:
        raise SystemExit("Task 2 state has no selected z0 cells")
    if missing:
        raise SystemExit(
            f"Task 2 is not complete: {len(completed)}/{len(selected)} z0 durable; "
            f"still missing {', '.join(missing[:5])}{' ...' if len(missing) > 5 else ''}"
        )

    scale = float(state["cliProfile"]["errorScale"])
    manifests = [json.loads((output / ".node-manifests" / f"{z0_id}.json").read_text(encoding="utf-8"))
                 for z0_id in selected]
    metadata = write_metadata_maps(output, manifests)
    manifests_by_z0 = {str(manifest["z0Id"]): manifest for manifest in manifests}
    variants: dict[str, Any] = {}
    manifest_summaries: list[dict[str, Any]] = []
    for variant in VARIANTS:
        file_tag = variant_file_tag(variant)
        print(f"  variant: {variant} ({len(selected)} z0)", flush=True)
        z0_entries: list[tuple[str, list[float], float, int]] = []
        for index, z0_id in enumerate(selected, start=1):
            print(f"    z0 {index}/{len(selected)}: {z0_id}", flush=True)
            manifest_path = output / ".node-manifests" / f"{z0_id}.json"
            manifest = manifests_by_z0[z0_id]
            z0_doc, bounds, z0_error, tile_count = build_z0_document(manifest, scale, variant)
            z0_path = output / "z0" / z0_id / f"tileset-{file_tag}.json"
            write_json_atomic(z0_path, z0_doc)
            validate_tile(z0_doc["root"], z0_path.parent, output)
            if variant == "none":
                write_json_atomic(output / "z0" / z0_id / "tileset.json", z0_doc)
                manifest_summaries.append(manifest)
            z0_entries.append((z0_id, bounds, z0_error, tile_count))

        full_bounds = union_bounds([item[1] for item in z0_entries])
        largest_child_error = max(item[2] for item in z0_entries)
        root_error = max(
            math.dist(full_bounds[:3], full_bounds[3:]),
            largest_child_error * 1.05,
            largest_child_error + 0.01,
        )
        root = {
            "boundingVolume": {"box": box_for_bounds(full_bounds)},
            "geometricError": root_error,
            "refine": "ADD",
            "transform": state["rootTransform"],
            "children": [
                {
                    "boundingVolume": {"box": box_for_bounds(bounds)},
                    "geometricError": error,
                    "refine": "ADD",
                    "content": {"uri": f"z0/{z0_id}/tileset-{file_tag}.json"},
                    "extras": {"aphZ0Id": z0_id},
                }
                for z0_id, bounds, error, _tile_count in z0_entries
            ],
        }
        entry = {
            "asset": {
                "version": "1.0",
                "extras": entry_asset_extras(state, variant, aphMetadataIndexUri=metadata["index"]),
            },
            "geometricError": root_error,
            "root": root,
        }
        entry_path = output / f"tileset-{file_tag}.json"
        write_json_atomic(entry_path, entry)
        validate_tile(root, output, output, entry=True)
        if variant == "none":
            write_json_atomic(output / "tileset.json", entry)
        variants[variant] = {
            "entry": entry_path.name,
            "z0Count": len(z0_entries),
            "tileCount": 1 + sum(item[3] + 1 for item in z0_entries),
            "rootGeometricError": root_error,
            "tilesetMetadataByteDelta": sum(
                aph_metadata_byte_delta(build_z0_document(manifests_by_z0[z0_id], scale, variant)[0])
                for z0_id in selected
            ),
        }

    report = {
        "schemaVersion": 1,
        "status": "ready",
        "canonicalVrv": "none",
        "selectionStatus": "pendingBenchmark",
        "canonicalEntry": "tileset.json",
        "z0Ids": selected,
        "variants": variants,
        "accounting": state.get("accounting"),
        "profile": state.get("cliProfile"),
        "sourceFiles": state.get("sourceFiles"),
        "validation": {"mode": "full" if FULL_VALIDATE else "fast", "pntsHeaders": len(VALIDATED_PNTS)},
        "metadata": {"index": metadata["index"], "bytes": metadata["bytes"]},
        "perDepth": summarize_depths(manifest_summaries, output),
        "task2StatePhaseAtPublish": state.get("phase"),
        "canonicalPublished": True,
    }
    write_json_atomic(output / FULL_REPORT, report)
    return report


def summarize_depths(manifests: list[dict[str, Any]], output: Path) -> dict[str, dict[str, int]]:
    result: dict[str, dict[str, int]] = {}
    for manifest in manifests:
        rows = [("p001", manifest["p001"])] + [
            (f"d{int(node['depth'])}", node) for node in manifest["nodes"]
        ]
        for depth, row in rows:
            bucket = result.setdefault(depth, {"tiles": 0, "points": 0, "bytes": 0})
            bucket["tiles"] += 1
            bucket["points"] += int(row["pointCount"])
            bucket["bytes"] += (output / row["pntsUri"]).stat().st_size
    return dict(sorted(result.items(), key=lambda item: (-1 if item[0] == "p001" else int(item[0][1:]))))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish APH Task 3 metadata from durable Task 2 z0 manifests")
    parser.add_argument("dataset")
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--public-root", default="")
    parser.add_argument(
        "--preview-z0",
        help="Publish one durable z0 without waiting for all Task 2 cells; omit to publish full canonical output",
    )
    parser.add_argument(
        "--full-validate",
        action="store_true",
        help="Read every PNTS header; defer this while Task 2 is using the same disk",
    )
    return parser.parse_args()


def main() -> int:
    global FULL_VALIDATE
    args = parse_args()
    FULL_VALIDATE = args.full_validate
    if args.preview_z0 and not Z0_RE.fullmatch(args.preview_z0):
        raise SystemExit("Invalid --preview-z0")
    logical = args.public_root or args.dataset
    if not re.fullmatch(r"[A-Za-z0-9_-]+", logical):
        raise SystemExit("Invalid logical/public root")
    output = (args.root / "local-storage" / "tilesets" / logical / f"{logical}-adaptive-point-hierarchy").resolve()
    report = publish_preview(output, args.preview_z0) if args.preview_z0 else publish_full(output)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
