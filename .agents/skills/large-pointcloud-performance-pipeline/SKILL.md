---
name: large-pointcloud-performance-pipeline
description: "Use when implementing, running, debugging, or explaining the large LAS point-cloud workflow for SBB datasets: raw LAS to prepared LAZ, chunking, per-chunk COPC, chunked COPC 3D Tiles, and the performance modes Overview, Explore, and Detail in the Cesium viewer. Covers when to build each mode, pointStep approximate sampling, area manifests, mode status, and avoiding full-dataset rendering."
---

# Large Point Cloud Performance Pipeline

Use this skill for large LAS datasets where whole-file COPC or whole-scene rendering is too heavy. Dataset names such as `2404PeruB2` are examples only; the workflow should work for any large dataset that follows the local pipeline conventions.

The target flow is:

```text
raw LAS
  -> prepared LAZ
  -> chunked LAZ
  -> per-chunk COPC
  -> full chunked COPC 3D Tiles
  -> logical modes:
       Overview = all areas, approximate p02
       Explore  = selected area, approximate p10
       Detail   = selected area, full reference
       Context  = optional p001 overview around Explore/Detail focus
```

## Core Rules

- Do not render a very large full dataset as one default user-facing tileset.
- Keep `<dataset>-chunked-copc` as the internal full source and benchmark.
- Use area abstraction in the UI; do not expose chunks as the main user concept.
- Treat `pointStep` density as approximate. `pointStep=50` targets roughly 2%, but exact density depends on node sizes.
- Detail must never reference the root `<dataset>-chunked-copc/tileset.json`. It must reference only the selected area's child tileset.
- Context must not duplicate the selected focus area. Use the p001 overview-excluding wrapper for the selected area, and keep the Context layer OFF by default for production performance.
- Explore and Detail must preserve the current camera when entered. Do not fly-to/frame the whole selected area; loading the whole area into view can force Cesium to refine too much of the focus layer.
- Restart `npm run pipeline:serve` after regenerating existing tileset folders if Cesium sees stale or truncated JSON.
- Overview and Explore should use `COPC_TILE_PACK_MODE=level-group` by default. Do not diagnose tiny area outputs only from folder size; inspect `tilePacking`, `tileCount`, `averageTileBytes`, `largestTileBytes`, and loaded tile metrics in the report.

## Initial Full Data Pipeline

For a raw LAS such as `2404PeruB2.las`, use the extensionless dataset name after download/prepare:

```bash
npm run pipeline:download -- 2404PeruB2.las
npm run pipeline:inspect -- 2404PeruB2
npm run pipeline:prepare -- 2404PeruB2
```

Whole-file COPC may fail with `Killed: 9` on very large datasets. Use chunking:

```bash
POINTCLOUD_CHUNK_LENGTH=500 npm run pipeline:chunk -- 2404PeruB2
COPC_THREADS=1 npm run pipeline:copc:chunks -- 2404PeruB2
npm run pipeline:tiles:copc:chunks -- 2404PeruB2
```

Outputs:

```text
local-storage/intermediate/<dataset>/chunks-laz/
local-storage/intermediate/<dataset>/chunks-copc/
local-storage/tilesets/<dataset>-chunked-copc/
```

Validate:

```bash
node -e "JSON.parse(require('fs').readFileSync('local-storage/tilesets/2404PeruB2-chunked-copc/tileset.json','utf8')); console.log('ok')"
```

## Logical Dataset And Manifest

Create or refresh the logical dataset manifest:

```bash
npm run pipeline:area:manifest -- 2404PeruB2
```

Manifest path:

```text
local-storage/tilesets/<dataset>/area-manifest.json
```

Manifest contract:

```json
{
  "dataset": "2404PeruB2",
  "defaultMode": "overview",
  "defaultAreaId": "area-001",
  "datasets": {
    "overview": {
      "dataset": "2404PeruB2-overview-p02",
      "status": "ready"
    }
  },
  "areas": [
    {
      "areaId": "area-001",
      "label": "Area 001",
      "sourceChunkId": "chunk--1_-1",
      "bbox": [0, 0, 0, 0, 0, 0],
      "pointCount": 0,
      "datasets": {
        "explore": {
          "dataset": "2404PeruB2-explore-p10/areas/area-001",
          "status": "not_built"
        },
        "detail": {
          "dataset": "2404PeruB2-detail-p100/areas/area-001",
          "status": "not_built"
        },
        "context": {
          "dataset": "2404PeruB2-overview-p001-excluding/areas/area-001",
          "status": "not_built"
        }
      }
    }
  ]
}
```

Statuses are:

```text
ready | not_built | building | failed
```

## Overview Mode

Overview is the first user-facing mode.

Meaning:

```text
all areas + approximate p02 density + low render budget
```

Build:

```bash
npm run pipeline:area:overview -- 2404PeruB2
```

Implementation:

- Converts all `chunks-copc`.
- Uses `COPC_TILE_POINT_STEP=50` by default.
- Uses `COPC_TILE_PACK_MODE=level-group` by default with `COPC_TILE_PACK_GROUP_LEVEL=3`, `COPC_TILE_PACK_TARGET_BYTES=524288`, and `COPC_TILE_PACK_HARD_MAX_BYTES=5242880`.
- Writes `densityTarget: "p02"`.
- Writes `densityApproximate: true`.
- Writes `actualDensityRatio` so reports do not imply exactly 2%.
- Writes `tilePacking` metadata when packing is enabled: `mode`, `groupLevel`, `targetTileBytes`, `hardMaxTileBytes`, `sourceNodeTileCount`, `packedTileCount`, `geometricErrorPolicy`, `rootGeometricErrorBefore`, and `rootGeometricErrorAfter`.

Output:

```text
local-storage/tilesets/<dataset>-overview-p02/
```

UI rule:

- Overview button is always enabled.
- If manifest status is `not_built`, the UI may show that status, but Overview remains the default mode.

## Detail Context Layer

Context is optional surrounding overview for Explore and Detail.

Meaning:

```text
all areas except selected focus area + approximate p001 density + low render budget
```

Build:

```bash
npm run pipeline:area:overview:p001 -- 2404PeruB2
npm run pipeline:area:overview:p001:excluding -- 2404PeruB2
```

Implementation:

- Builds `<dataset>-overview-p001` with `COPC_TILE_POINT_STEP=1000`.
- Builds JSON-only wrappers under `<dataset>-overview-p001-excluding/areas/<area-id>/`.
- Each wrapper references overview p001 children except the selected area's `sourceChunkId`.
- Do not copy `.pnts` files and do not reconvert points when generating excluding wrappers.
- Refresh `area-manifest.json` so each area has `datasets.context.dataset` and `datasets.context.status`.

UI rule:

- Context layer is OFF by default.
- When OFF, Explore/Detail load only the selected focus dataset.
- When ON and context status is `ready`, Explore/Detail load focus + context.
- When ON but context is not ready, keep Explore/Detail enabled and load focus only with a warning. Do not silently load full overview as fallback.

## Explore Mode

Explore is for inspecting one selected area at a medium data density.

Meaning:

```text
selected area only + approximate p10 density + medium render budget
```

Build one area:

```bash
npm run pipeline:area:explore -- 2404PeruB2 area-001
```

Implementation:

- Resolves `area-001` to `sourceChunkId` from `area-manifest.json`.
- Converts only that COPC chunk.
- Uses `COPC_TILE_POINT_STEP=10` by default.
- Uses `COPC_TILE_PACK_MODE=level-group` by default with `COPC_TILE_PACK_GROUP_LEVEL=3`, `COPC_TILE_PACK_TARGET_BYTES=524288`, and `COPC_TILE_PACK_HARD_MAX_BYTES=5242880`.
- Writes `densityTarget: "p10"`.
- Writes `densityApproximate: true`.
- Writes `tilePacking` metadata when packing is enabled. For small or odd chunks, a small output folder is not automatically a bug if `tileCount`, emitted points, density ratio, and loaded tiles are healthy.

Explore auto-pack:

- `npm run pipeline:area:explore:all -- <dataset>` enables per-area auto-pack by default through `COPC_EXPLORE_AUTO_PACK=1`.
- Candidate group levels default to `COPC_EXPLORE_AUTO_PACK_LEVELS=3,4`.
- The first candidate starts with the caller's overwrite setting; later candidates force overwrite so the selected area can be rebuilt at the next level.
- Evaluation accepts a candidate only when all checks pass: `tileCount` between `200` and `1000`, `averageTileBytes` between `102400` and `512000`, `largestTileBytes <= 5242880`, `actualDensityRatio` between `0.095` and `0.105`, a root geometricError policy that still forces refinement into content children, no missing content URIs, and no geometricError monotonicity violations.
- Retryable reasons include `tileCount_lt_200`, `averageTileBytes_gt_512000`, and `largestTileBytes_gt_5242880` unless blocked by `tileCount_gt_1000` or `averageTileBytes_lt_102400`.
- Auto-pack writes `local-storage/tilesets/<dataset>-explore-p10/pack-selection-report.json` with `selectedGroupLevel`, `triedGroupLevels`, status, reasons, metrics, tree checks, and per-attempt details.
- Set `COPC_EXPLORE_AUTO_PACK=0` to disable selection and use the default `COPC_TILE_PACK_GROUP_LEVEL`.

Output:

```text
local-storage/tilesets/<dataset>-explore-p10/areas/area-001/
```

UI rule:

- Enable Explore only when `selectedArea.datasets.explore.status === "ready"`.
- If status is `not_built`, disable and show `Not built yet`.
- If status is `building` or `failed`, disable and show `Building` or `Failed`.

## Detail Mode

Detail is for full-quality inspection of one selected area.

Meaning:

```text
selected area only + full density + high-safe render budget
```

Build one area:

```bash
npm run pipeline:area:detail -- 2404PeruB2 area-001
```

Implementation:

- Do not copy PNTS data.
- Do not convert the full dataset again when the full child tileset already exists.
- Create a small wrapper dataset that references only the selected area's child tileset:

```text
local-storage/tilesets/<dataset>-detail-p100/areas/area-001/tileset.json
  -> ../../../<dataset>-chunked-copc/chunks/<sourceChunkId>/tileset.json
```

- Set wrapper `geometricError` and `root.geometricError` from the child tileset, not `0`. If the wrapper root has `geometricError: 0`, Cesium may consider the tile already refined and never request the external child tileset.
- Use the child root bbox for the wrapper bounding volume so culling matches the referenced external tileset.

Output:

```text
local-storage/tilesets/<dataset>-detail-p100/areas/area-001/
```

UI rule:

- Enable Detail only when `selectedArea.datasets.detail.status === "ready"`.
- If status is `not_built`, disable and show `Build required`.
- If status is `building` or `failed`, disable and show `Building` or `Failed`.

## Viewer Rules

Open the logical dataset, not the internal full root:

```text
http://localhost:5173/?dataset=2404PeruB2
```

Area selection currently comes from `area-manifest.json`, not from geocoding or a map service:

```text
area-manifest.json
  -> areas[]
     -> areaId
     -> label
     -> sourceChunkId
     -> bbox [minX, minY, minZ, maxX, maxY, maxZ]
     -> datasets.explore/detail status
```

Current UI flow:

```text
1. Viewer loads ?dataset=<dataset>.
2. Viewer fetches /<dataset>/area-manifest.json.
3. Viewer fills the Area dropdown from areas[].label and areas[].areaId.
4. User selects an area explicitly.
5. Viewer resolves mode + selected area to a concrete tileset:
   Overview -> <dataset>-overview-p02
   Explore  -> <dataset>-explore-p10/areas/<area-id>
   Detail   -> <dataset>-detail-p100/areas/<area-id>
   Context  -> <dataset>-overview-p001-excluding/areas/<area-id> when enabled
```

This means the UI knows the current area because the user selected it in the dropdown. It does not yet infer the area from camera position or mouse click.

Recommended future viewport-pick flow:

```text
1. User clicks a point or clicks "Use current view".
2. Viewer computes a world/local XYZ position.
3. Viewer finds the manifest area whose bbox contains that XYZ.
4. Viewer sets selectedAreaId to that area's areaId.
5. Viewer updates Explore/Detail button status from selectedArea.datasets.
```

Use bbox containment for area lookup:

```text
minX <= x <= maxX
minY <= y <= maxY
minZ <= z <= maxZ
```

If multiple bboxes contain the point, choose the smallest bbox volume. If none contains it, keep the current selected area and show "No area at picked position".

For "Use current view" without a point pick, use the current orbit target or camera look-at target, then run the same bbox lookup. This is approximate; point picking is more reliable.

Render budget controls Cesium quality and memory behavior. It does not replace physical data density:

- `dataDensity` chooses which generated dataset to load: `p02`, `p10`, or `full`.
- `renderQuality` chooses Cesium runtime settings for that dataset.
- `maximumScreenSpaceError` controls tile refinement. Higher values load fewer/lower-detail tiles; lower values request more detail.
- `cacheBytes` limits the Cesium tile cache. Higher values reduce eviction but use more memory.
- Physical sampling is still required for real performance. Low render budget on a full dataset is safer, but it is not the same as loading a real p02 Overview dataset.

Mode mapping:

```json
{
  "overview": {
    "dataDensity": "p02",
    "renderQuality": "low",
    "maximumScreenSpaceError": 64,
    "cacheBytes": 268435456
  },
  "explore": {
    "dataDensity": "p10",
    "renderQuality": "medium",
    "maximumScreenSpaceError": 32,
    "cacheBytes": 536870912
  },
  "detail": {
    "dataDensity": "full",
    "renderQuality": "high-safe",
    "maximumScreenSpaceError": 256,
    "cacheBytes": 805306368
  }
}
```

Render budget meanings:

```text
Overview / low
  dataDensity: p02
  maximumScreenSpaceError: 64
  cacheBytes: 256 MB
  Purpose: first load, whole-area context, fastest navigation.

Explore / medium
  dataDensity: p10
  maximumScreenSpaceError: 32
  cacheBytes: 512 MB
  Purpose: selected-area inspection with better shape/color detail.

Detail / high-safe
  dataDensity: full
  maximumScreenSpaceError: 256
  cacheBytes: 768 MB
  Purpose: selected-area full-quality inspection without loading the full global dataset. SSE 256 is the production default because lower values can load too much of a full-density area; keep debug choices around 32/128/256 only, not 512.
```

When switching mode or area:

- Remove the old tileset from the Cesium scene.
- Destroy the old tileset if supported.
- Reset browser metrics.
- Load the resolved dataset for the selected mode and area.
- Preserve the current camera for Explore and Detail. Restore the pre-area-mode camera when returning to Overview.
- Overview and Fly Home may frame/fly-to; Explore and Detail should not frame the entire focus area on mode entry.

Report JSON and Copy Report should include:

```text
logicalDataset
resolvedDataset
selectedAreaId
modeStatus
sourceChunkId
pointStep
densityTarget
densityApproximate
actualDensityRatio
sourcePointCount
emittedPointCount
focusDataset
focusDensity
focusAreaId
focusSourceChunkId
contextDataset
contextDensity
contextExcludedAreaId
contextExcludedSourceChunkId
focusEffectiveSSE
contextEffectiveSSE
framingMode
focusLoadedTiles
contextLoadedTiles
tilePacking.mode
tilePacking.groupLevel
tilePacking.sourceNodeTileCount
tilePacking.packedTileCount
tilePacking.rootGeometricErrorBefore
tilePacking.rootGeometricErrorAfter
```

## Validation Checklist

For manifests:

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('local-storage/tilesets/2404PeruB2/area-manifest.json','utf8')); console.log(m.areas.length, m.datasets.overview.status, m.areas[0].datasets)"
```

For Detail wrappers:

```bash
node -e "const t=JSON.parse(require('fs').readFileSync('local-storage/tilesets/2404PeruB2-detail-p100/areas/area-001/tileset.json','utf8')); console.log(t.root.content.uri)"
```

The URI must point to:

```text
../../../<dataset>-chunked-copc/chunks/<sourceChunkId>/tileset.json
```

It must not point to:

```text
../<dataset>-chunked-copc/tileset.json
```

For reports:

- `densityApproximate` is true for Overview and Explore.
- `actualDensityRatio` is present for sampled outputs.
- Overview and Explore packed outputs should include `tilePacking.mode: "level-group"` unless packing was intentionally disabled.
- `tilePacking.groupLevel` documents the selected ancestor level. Higher levels split into smaller groups; lower levels pack more source nodes together.
- `tilePacking.sourceNodeTileCount` is the number of sampled COPC nodes considered before packing, and `tilePacking.packedTileCount` is the final PNTS tile count.
- Packed roots with no content must keep a high root geometricError so Cesium refines into PNTS children even from a preserved far camera. Do not lower root geometricError merely because `groupLevel` is high; otherwise the screen may stay blank until zoom.
- Detail has `densityApproximate: false`, `densityTarget: "full"`, and `pointStep: 1`.
- Copy Report must distinguish focus and context fields. Use `focusLoadedTiles` and `contextLoadedTiles` to identify whether performance is limited by the selected area or surrounding context.
- In Detail, `framingMode` should be `preserve`, `focusEffectiveSSE` should default to 256, and `contextEffectiveSSE` should be `—` unless Context layer is enabled.

For browser performance:

- Overview should load first and show the whole area context.
- Explore should load only a selected area by default; optional context can be enabled manually.
- Detail should load only a selected area at full density by default; optional context can be enabled manually.
- Copy Report should show the resolved dataset and selected area, not just the logical dataset.
