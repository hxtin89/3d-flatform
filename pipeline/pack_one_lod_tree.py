#!/usr/bin/env python3
"""Pack a one-lod-tree sidecar chain into one upload folder.

The normal builder keeps generated sidecars next to their source Overview,
Explore, and Detail chunks. This packer copies only generated
``tileset-one-lod-tree.json`` sidecars into
``<logical>/<logical>-one-lod-tree/sidecars`` and rewrites their source content
URIs back to the already-published Overview, Explore, and Detail datasets.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

try:
    from .build_one_lod_tree import (
        REMOTE_PREFIXES,
        SIDECAR_NAME,
        _inside,
        _is_json_uri,
        _walk_tiles,
        build_one_lod_tree,
        read_json,
        write_json_atomic,
    )
except ImportError:  # Direct execution: python3 pipeline/pack_one_lod_tree.py
    from build_one_lod_tree import (  # type: ignore
        REMOTE_PREFIXES,
        SIDECAR_NAME,
        _inside,
        _is_json_uri,
        _walk_tiles,
        build_one_lod_tree,
        read_json,
        write_json_atomic,
    )


PACK_SIDECARS_DIR = "sidecars"
PACK_MANIFEST_NAME = "one-lod-tree-package-manifest.json"


def _split_uri(uri: str) -> tuple[str, str]:
    if "?" not in uri:
        return uri, ""
    path, query = uri.split("?", 1)
    return path, f"?{query}"


def _relative_uri(from_dir: Path, target: Path) -> str:
    return os.path.relpath(target.resolve(), from_dir.resolve()).replace(os.sep, "/")


def _resolve_content_target(owner_path: Path, uri: str, tilesets_dir: Path) -> Path:
    if uri.startswith(REMOTE_PREFIXES) or "://" in uri:
        raise SystemExit(f"Remote content is not supported in one-lod packages: {uri}")
    uri_path, _ = _split_uri(uri)
    if uri_path.startswith("/") or Path(uri_path).is_absolute():
        raise SystemExit(f"Absolute content URI is not allowed: {uri}")
    target = (owner_path.parent / uri_path).resolve()
    if not _inside(target, tilesets_dir):
        raise SystemExit(f"Content URI escapes tilesets root: {owner_path}: {uri}")
    if not target.exists():
        raise SystemExit(f"Content target does not exist: {target}")
    return target


def _publish_directory(staged_dir: Path, target_dir: Path) -> None:
    backup_dir: Path | None = None
    if target_dir.exists():
        if not target_dir.is_dir():
            raise SystemExit(f"Cannot replace non-directory package sidecar path: {target_dir}")
        backup_dir = target_dir.with_name(f".{target_dir.name}.old.{os.getpid()}")
        if backup_dir.exists():
            shutil.rmtree(backup_dir)
        target_dir.rename(backup_dir)
    try:
        staged_dir.rename(target_dir)
    except OSError as exc:
        if backup_dir is not None and not target_dir.exists():
            backup_dir.rename(target_dir)
        raise SystemExit(f"Cannot publish package sidecars to {target_dir}: {exc}") from exc
    if backup_dir is not None:
        shutil.rmtree(backup_dir)


def validate_sidecar_package(entry_path: Path, package_dir: Path, tilesets_dir: Path) -> set[Path]:
    """Validate that generated sidecar JSON stays packaged and content stays local."""
    package_root = package_dir.resolve()
    tilesets_root = tilesets_dir.resolve()
    visited: set[Path] = set()
    visiting: set[Path] = set()

    def visit(path: Path) -> None:
        path = path.resolve()
        if path in visiting:
            raise SystemExit(f"Cycle detected in packed JSON chain at {path}")
        if path in visited:
            return
        if not _inside(path, package_root):
            raise SystemExit(f"Packed JSON is outside package folder: {path}")
        visiting.add(path)
        document = read_json(path)
        root = document.get("root")
        if not isinstance(root, dict):
            raise SystemExit(f"Packed JSON has no root object: {path}")
        for tile in _walk_tiles(root):
            content = tile.get("content")
            if not isinstance(content, dict) or not isinstance(content.get("uri"), str):
                continue
            uri = content["uri"]
            if uri.startswith(REMOTE_PREFIXES) or "://" in uri:
                raise SystemExit(f"Packed URI must be local: {path}: {uri}")
            uri_path, _ = _split_uri(uri)
            if uri_path.startswith("/") or Path(uri_path).is_absolute():
                raise SystemExit(f"Packed URI must be relative: {path}: {uri}")
            target = (path.parent / uri_path).resolve()
            if not _inside(target, tilesets_root):
                raise SystemExit(f"Packed URI escapes tilesets root: {path}: {uri}")
            if not target.exists():
                raise SystemExit(f"Packed URI target is missing: {path}: {uri}")
            if _is_json_uri(uri) and target.name == SIDECAR_NAME:
                if not _inside(target, package_root):
                    raise SystemExit(f"Generated sidecar URI escapes package folder: {path}: {uri}")
                visit(target)
        visiting.remove(path)
        visited.add(path)

    visit(entry_path)
    return visited


def pack_one_lod_tree(
    root_dir: Path,
    dataset: str,
    public_root: str = "",
    sidecars_dir_name: str = PACK_SIDECARS_DIR,
) -> dict[str, Any]:
    """Copy and rewrite generated one-lod-tree sidecars into its uploadable folder."""
    if not sidecars_dir_name or "/" in sidecars_dir_name or sidecars_dir_name in (".", ".."):
        raise SystemExit(f"Invalid sidecars directory name: {sidecars_dir_name}")

    tilesets_dir = (root_dir / "local-storage" / "tilesets").resolve()
    logical = public_root.strip("/") if public_root else dataset
    logical_dir = (tilesets_dir / logical).resolve()
    if not _inside(logical_dir, tilesets_dir):
        raise SystemExit(f"Logical dataset escapes tilesets root: {logical}")

    rebuilt = build_one_lod_tree(
        root_dir=root_dir,
        dataset=dataset,
        public_root=public_root,
    )

    package_dir = logical_dir / f"{logical}-one-lod-tree"
    source_entry = package_dir / SIDECAR_NAME
    if not source_entry.exists():
        raise SystemExit(f"One LOD Tree entry not found: {source_entry}")

    package_dir.mkdir(parents=True, exist_ok=True)
    managed_sidecars_dir = package_dir / sidecars_dir_name
    staging_dir = Path(tempfile.mkdtemp(prefix=".one-lod-tree-pack.", dir=str(package_dir)))
    staging_sidecars_dir = staging_dir / sidecars_dir_name
    final_entry = package_dir / SIDECAR_NAME
    staging_entry = staging_dir / SIDECAR_NAME
    staging_manifest = staging_dir / PACK_MANIFEST_NAME

    json_sources: dict[Path, Path] = {}
    destination_sources: dict[Path, Path] = {}
    external_references: set[Path] = set()
    visiting: set[Path] = set()

    def package_relative_source_path(source_path: Path) -> Path:
        source_path = source_path.resolve()
        if _inside(source_path, managed_sidecars_dir):
            return source_path.relative_to(managed_sidecars_dir.resolve())
        try:
            return source_path.relative_to(logical_dir)
        except ValueError:
            return Path("__tilesets") / source_path.relative_to(tilesets_dir)

    def final_destination_for(source_path: Path) -> Path:
        source_path = source_path.resolve()
        if source_path == source_entry.resolve():
            return final_entry
        relative = package_relative_source_path(source_path)
        destination = (managed_sidecars_dir / relative).resolve()
        if not _inside(destination, managed_sidecars_dir):
            raise SystemExit(f"Refusing package destination outside sidecars: {destination}")
        previous = destination_sources.get(destination)
        if previous is not None and previous != source_path:
            raise SystemExit(f"Two source files map to one package path: {previous} and {source_path}")
        destination_sources[destination] = source_path
        return destination

    def staging_destination_for(final_destination: Path) -> Path:
        final_destination = final_destination.resolve()
        if final_destination == final_entry.resolve():
            return staging_entry
        relative = final_destination.relative_to(managed_sidecars_dir.resolve())
        return (staging_sidecars_dir / relative).resolve()

    def pack_document(source_path: Path) -> Path:
        source_path = source_path.resolve()
        if source_path in json_sources:
            return json_sources[source_path]
        if source_path in visiting:
            raise SystemExit(f"Cycle detected while packing JSON: {source_path}")
        visiting.add(source_path)
        final_destination = final_destination_for(source_path)
        staging_destination = staging_destination_for(final_destination)
        json_sources[source_path] = final_destination
        document = copy.deepcopy(read_json(source_path))
        root = document.get("root")
        if not isinstance(root, dict):
            raise SystemExit(f"Tileset has no root object: {source_path}")

        for tile in _walk_tiles(root):
            content = tile.get("content")
            if not isinstance(content, dict) or not isinstance(content.get("uri"), str):
                continue
            uri = content["uri"]
            uri_path, suffix = _split_uri(uri)
            target = _resolve_content_target(source_path, uri, tilesets_dir)
            if _is_json_uri(uri_path) and target.name == SIDECAR_NAME:
                target_destination = pack_document(target)
            else:
                target_destination = target
                external_references.add(target)
            content["uri"] = _relative_uri(final_destination.parent, target_destination) + suffix

        write_json_atomic(staging_destination, document)
        visiting.remove(source_path)
        return final_destination

    try:
        pack_document(source_entry)
        manifest = {
            "version": 1,
            "entry": SIDECAR_NAME,
            "sidecarsDir": sidecars_dir_name,
            "logicalDataset": logical,
            "sourceDataset": dataset,
            "sourceEntry": str(source_entry.relative_to(tilesets_dir)),
            "rebuiltSourceSidecarCount": len(rebuilt["sidecarPaths"]),
            "jsonFileCount": len(json_sources),
            "externalReferenceCount": len(external_references),
        }
        write_json_atomic(staging_manifest, manifest)
        _publish_directory(staging_sidecars_dir, managed_sidecars_dir)
        os.replace(staging_entry, package_dir / SIDECAR_NAME)
        os.replace(staging_manifest, package_dir / PACK_MANIFEST_NAME)
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)

    visited_json = validate_sidecar_package(package_dir / SIDECAR_NAME, package_dir, tilesets_dir)
    return {
        "outputPath": str(package_dir / SIDECAR_NAME),
        "packageDir": str(package_dir),
        "sidecarsDir": str(managed_sidecars_dir),
        "rebuiltSourceSidecarCount": len(rebuilt["sidecarPaths"]),
        "jsonFileCount": len(visited_json),
        "externalReferenceCount": len(external_references),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pack a generated one-lod-tree chain into one uploadable folder."
    )
    parser.add_argument("--root", required=True, help="Project root containing local-storage/.")
    parser.add_argument("--dataset", required=True, help="Source dataset, e.g. 2404PeruB2.")
    parser.add_argument("--public-root", default="", help="Logical/public root, e.g. peru-b2-globe.")
    parser.add_argument(
        "--sidecars-dir",
        default=PACK_SIDECARS_DIR,
        help="Managed subfolder inside <logical>-one-lod-tree for generated sidecars.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    result = pack_one_lod_tree(
        root_dir=Path(args.root).resolve(),
        dataset=args.dataset,
        public_root=args.public_root,
        sidecars_dir_name=args.sidecars_dir,
    )
    print(f"Packed one-lod-tree package for {args.dataset}")
    print(f"  package: {result['packageDir']}")
    print(f"  entry: {result['outputPath']}")
    print(f"  rebuilt source sidecars: {result['rebuiltSourceSidecarCount']}")
    print(f"  json files: {result['jsonFileCount']}")
    print(f"  external references: {result['externalReferenceCount']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
