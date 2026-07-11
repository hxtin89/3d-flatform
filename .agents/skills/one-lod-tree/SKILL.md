---
name: one-lod-tree
description: Build, run, tune, debug, validate, or explain the SBB One LOD Tree pipeline and viewer mode. Use for the external Overview-to-Explore-to-Detail sidecar chain, `tileset-one-lod-tree.json`, `?lod=one-lod-tree`, viewer request volumes, one-tree SSE/cache behavior, source-preserving rebuilds, or changes to `pipeline/build_one_lod_tree.py`, `pipeline/area-one-lod-tree.sh`, `viewer/src/one-lod-tree.ts`, and their viewer wiring.
---

# One LOD Tree

Build one standards-compliant external 3D Tiles chain and load it once in Cesium. Preserve every source `tileset.json` and PNTS file; generate only `tileset-one-lod-tree.json` sidecars.

## Start Here

1. Read `AGENTS.md` and follow its GitNexus requirements before changing code.
2. Read `pipeline/build_one_lod_tree.py` and `pipeline/area-one-lod-tree.sh` for generation behavior.
3. Read `viewer/src/one-lod-tree.ts`, then its wiring in `viewer/src/main.ts` and `viewer/src/viewer.ts`.
4. Read `pipeline/tests/test_build_one_lod_tree.py` or `viewer/src/one-lod-tree.test.ts` before changing the corresponding contract.
5. Treat current source and tests as authoritative; do not rely on remembered SSE values or output paths.

If a new One LOD Tree symbol is absent from a stale GitNexus index, report the `UNKNOWN` limitation and inspect every direct caller before editing.

## Generated Chain

Use this structure:

```text
<logical>/<logical>-one-lod-tree/tileset-one-lod-tree.json
  -> <overview>/chunks/<chunk>/tileset-one-lod-tree.json
       -> <explore>/areas/<area>/chunks/<chunk>/tileset-one-lod-tree.json
            -> <detail>/areas/<area>/chunks/<chunk>/tileset-one-lod-tree.json
```

Maintain these invariants:

- Build every manifest area by default. Accept an optional area ID only for a targeted debug build.
- Base the entry on the Overview root and replace selected chunk references with generated Overview sidecars.
- Preserve real Overview, Explore, and Detail content. Never invent PNTS nodes or copy/regenerate point data.
- Make every tile whose `content.uri` references JSON a leaf in its containing file. Put descendants inside the referenced external tileset.
- Keep the shared ENU-to-ECEF transform only on the entry root; remove it from nested sidecars.
- Rebase content URIs to relative paths inside `local-storage/tilesets`; reject remote, absolute, escaping, missing, cyclic, or unreachable references.
- Preserve geometric-error monotonicity across the external chain.
- Validate Overview-to-Explore and Explore-to-Detail bounding boxes before writing anything. A failed batch must leave no partial sidecars.
- Write stage sidecars atomically and publish the entry last so it never references incomplete output.
- Keep rebuilds idempotent and source files byte-for-byte unchanged.

## Request Volumes

Attach stage-specific `viewerRequestVolume` boxes to the external leaves:

- Overview to Explore: default ratio `2.5`.
- Explore to Detail: default ratio `0.75`.
- Preserve the source chunk XY footprint.
- Extend the vertical half-axis to at least `chunk half-diagonal × ratio`.
- Require positive finite ratios and a valid 12-value box.

Override ratios only for an explicit experiment:

```bash
ONE_LOD_EXPLORE_REQUEST_RATIO=2.5 \
ONE_LOD_DETAIL_REQUEST_RATIO=0.75 \
npm run pipeline:area:one-lod-tree -- 2404PeruB2
```

## Build and Run

Build all areas from `area-manifest.json`:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
npm run pipeline:area:one-lod-tree -- 2404PeruB2
```

Build one area for debugging:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
npm run pipeline:area:one-lod-tree -- 2404PeruB2 area-001
```

Serve generated tiles and start the viewer:

```bash
npm run pipeline:serve
npm run viewer:dev
```

Open:

```text
http://localhost:5173/?dataset=peru-b2-globe&lod=one-lod-tree
```

Restart the tile server after generation when a previously missing sidecar still returns 404.

## Viewer Contract

Keep One LOD Tree isolated from the normal multi-dataset loading path:

- Resolve the dataset as `<logical>/<logical>-one-lod-tree` and load `tileset-one-lod-tree.json` once.
- Keep the composed tree loaded as one Cesium tileset. If re-enabling a visible quality/preset control, switch Overview, Explore, and Detail by changing only the active tileset render budget; never swap datasets.
- The helper SSE map remains `256` for Overview, `124` for Explore, and `96` for Detail. The current `?lod=one-lod-tree` UI does not expose a visible quality/SSE control; instead, the One LOD Tree runtime camera band drives the render budget automatically: `far -> low/256`, `medium -> medium/124`, `near -> high/96`. This runtime band intentionally differs from the Overview point-size band: keep `far/medium` at `2.5`, but delay `near/Detail` until `cameraRangeRatio <= 0.35` so high-altitude views around `0.47` stay in Explore SSE `124`. Initial load starts on Overview SSE `256` and may immediately retune after the first camera-range band is measured.
- Reuse cache sizes from `PRESETS`. Trim finer cached tiles only after returning from Explore/Detail to Overview and after the new Overview selection has rendered.
- Hide the Mode, Area, and manual Rendering rows in this mode. The visible Settings section currently exposes only Point Size.
- Disable area selection, current-view detection, Context, Detail SSE override, and progressive Overview SSE in this mode.
- Keep One LOD Tree point-size tuning separate from progressive Overview SSE: the Point Size slider is enabled and updates Cesium style plus runtime point-size report metrics, without activating `OverviewSseController`.
- Keep manual mode behavior unchanged.
- Use runtime report metrics because the composed sidecar dataset has no standalone dataset report. In runtime report mode, hide pipeline-only fields such as Source Points, Tileset Size, and Tile Count. Show Runtime SSE next to Point Band so the automatic `far/medium/near` SSE retune is visible.
- Permit close zoom for the One LOD Tree without restoring any Auto LOD runtime or API.
- Validate dataset paths and entry filenames before constructing a URL.

## Validation

Run the builder suite:

```bash
/Volumes/WD_BLACK/conda/envs/pointcloud-pipeline/bin/python \
  -m unittest pipeline.tests.test_build_one_lod_tree
```

Run viewer helper tests and the production build:

```bash
cd viewer
./node_modules/.bin/vitest run src/one-lod-tree.test.ts
npm run build
cd ..
git diff --check
```

In the browser, verify:

1. The first JSON request is the generated entry sidecar, not the legacy `<logical>-one-lod-tree/tileset.json`.
2. External requests progress Overview -> Explore -> Detail as the camera approaches the area.
3. The One LOD Tree panel hides Mode, Area, manual Rendering rows, and pipeline-only report fields; Settings shows Point Size only; Runtime Report shows Point Band next to Runtime SSE.
4. The Point Size slider is enabled, visibly changes point size, and updates point-size report fields without enabling progressive Overview SSE.
5. If a visible quality/preset control is reintroduced, preset changes must update SSE/cache behavior without changing the active dataset URL, and returning to Overview must trim finer cached tiles without blanking the scene.
6. Manual mode still loads and switches datasets normally.

## Diagnostics

- `area-manifest.json` missing: build or point to the correct logical/public root first.
- Area not found or duplicate `sourceChunkId`: fix manifest identity; do not guess a chunk mapping.
- Missing source tileset/content: rebuild the required Overview, Explore, or Detail source product before generating sidecars.
- BBox mismatch: inspect source chunk alignment and tolerances. Do not silence the check with a large tolerance unless the data relationship is verified.
- External JSON has children: move those children into the referenced document and keep the referencing tile a leaf.
- Refinement never advances: inspect generated `viewerRequestVolume`, relative URI resolution, geometric errors, and browser network 404s.
- Sparse or over-detailed view: One LOD Tree auto-retunes SSE from its one-tree camera band, not the generic Overview point-size band. Inspect `cameraRangeRatio`, `pointSizeBand`, Runtime SSE, `oneLodTreeBandForRatio`, `oneLodTreeSse`, `setOneLodTreePreset`, generated request volumes, and source tiles before tuning ratios.
- Source files changed after a build: treat this as a generator bug; the pipeline is sidecar-only.
- A stale legacy `tileset.json` loads: check `ONE_LOD_TREE_TILESET_FILE`, dataset resolution, and the browser URL.

## Safe Change Workflow

Before editing an indexed function, class, or method:

1. Use GitNexus query/context to understand unfamiliar flows.
2. Run upstream impact on every symbol to be changed.
3. Warn before editing when risk is HIGH or CRITICAL.
4. Preserve unrelated dirty-worktree changes.

After editing, run the relevant builder/viewer tests, `npm run build` in `viewer`, and `git diff --check`. Run GitNexus `detect_changes` before committing and distinguish intentional One LOD Tree impact from unrelated aggregate worktree risk.

## Completion Criteria

Consider work complete only when:

- All requested areas produce a reachable four-stage sidecar chain.
- Generated JSON leaves, transforms, URIs, request volumes, and geometric errors satisfy the invariants.
- Failure paths write no partial output and source hashes remain unchanged.
- The viewer loads one entry. Internal or future visible preset changes must not swap datasets.
- Current UI hides One LOD Tree preset/SSE controls, keeps Settings to Point Size, shows Runtime SSE in the runtime report, and keeps report fields truthful.
- SSE/cache/trim behavior matches the viewer contract when internal or future visible preset changes are exercised.
- Pipeline tests, viewer tests, production build, and diff checks pass.
