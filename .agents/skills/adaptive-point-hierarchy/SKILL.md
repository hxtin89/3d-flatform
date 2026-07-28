---
name: adaptive-point-hierarchy
description: Build, publish, validate, tune, benchmark, debug, or explain the SBB Adaptive Point Hierarchy pipeline and viewer mode. Use for residual adaptive quadtrees inside z0 cells, representative sampling, node manifests, APH geometric error/bounds/VRV variants, `?lod=adaptive-point-hierarchy`, z0 previews, APH telemetry, or changes to `pipeline/build_adaptive_point_hierarchy.py`, `pipeline/build_adaptive_point_hierarchy_tileset.py`, and `viewer/src/adaptive-point-hierarchy.ts`.
---

# Adaptive Point Hierarchy

Keep the existing 2 km z0 grid for dataset/area compatibility. Inside each z0, build a content-driven residual quadtree whose nodes own disjoint points and whose leaves target roughly 50k–100k points.

## Mental model

APH is not a replacement-refinement tree. It is an **ADD** composition:

```text
z0 p001 overview
  + d0 internal representatives
  + d1 internal representatives
  + …
  + deepest residual leaves
```

- `points/z0/<z0Id>.pnts` is the p001 overview for one z0.
- Each internal adaptive node emits sampled representatives and routes its residual points to children.
- Each leaf emits all residual points it owns. Nodes are ownership-disjoint: no point should be omitted or duplicated across p001, internal, and leaf content.
- Cesium uses `refine: "ADD"` at p001 and adaptive nodes. When refining, ancestors remain visible while selected child content is added. Therefore visible-point totals must be analysed as `p001 + internal + leaf`, not as leaves alone.
- `geometricError` controls when Cesium requests/refines content. It does not create density; point density is limited by source observations and the emitted node content.

## Build and publish stages

### Task 2 — durable content builder

Task 2 streams source COPC chunks, partitions points into z0 cells, writes PNTS content, and writes durable state/manifests. It is resumable and may take many hours.

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
  npm run pipeline:adaptive-point-hierarchy -- 2404PeruB2 --pilot auto --resume --extend-pilot
```

Output root for logical dataset `<logical>`:

```text
local-storage/tilesets/<logical>/<logical>-adaptive-point-hierarchy/
  points/z0/<z0Id>.pnts                 # p001 overview content
  points/adaptive/<z0Id>/d*_q*.pnts     # internal + leaf adaptive content
  .adaptive-point-hierarchy-state.json  # Task 2 resume state; never publish
  .node-manifests/                       # Task 2 manifests; never publish
  .aph-fragments/                        # temporary/resume fragments; never publish
```

Do not run two Task 2 builders against the same output root. Do not use `--overwrite` on a production logical root unless replacement is explicitly intended.

### Task 3 — tileset publisher

Task 3 reads completed Task 2 manifests and writes the 3D Tiles documents plus compact diagnostics metadata. It does not rebuild PNTS content.

Preview one already-durable z0 while Task 2 continues:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
  npm run pipeline:adaptive-point-hierarchy:tileset -- 2404PeruB2 \
  --preview-z0 z0_x000002_y000004
```

After every selected z0 is durable, publish the full canonical entry:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
  npm run pipeline:adaptive-point-hierarchy:tileset -- 2404PeruB2
```

The canonical full entry is `tileset.json` and has VRV `none`. The publisher also writes the VRV variant documents and per-z0 documents under `z0/`.

## Pipeline

1. Build or resume Task 2 without touching its durable state from another process:

   ```bash
   POINTCLOUD_PUBLIC_ROOT=peru-b2-globe npm run pipeline:adaptive-point-hierarchy -- 2404PeruB2 --pilot auto --resume --extend-pilot
   ```

2. While Task 2 continues, publish only a z0 listed in `completedZ0Ids`:

   ```bash
   POINTCLOUD_PUBLIC_ROOT=peru-b2-globe npm run pipeline:adaptive-point-hierarchy:tileset -- 2404PeruB2 --preview-z0 z0_x000002_y000004
   ```

3. After every selected z0 is durable, omit `--preview-z0` to publish both variants and canonical `tileset.json`. The pre-benchmark canonical variant must be `none`.

Never treat `pilot` as synthetic data. It is a bounded set of real z0 cells used for validation and extension.

## S3 / CloudFront release checklist

Upload **published serving assets only** to the equivalent prefix:

```text
s3://<bucket>/<public-prefix>/<logical>/<logical>-adaptive-point-hierarchy/
```

For `POINTCLOUD_PUBLIC_ROOT=peru-b2-globe`, the local source directory is:

```text
local-storage/tilesets/peru-b2-globe/peru-b2-globe-adaptive-point-hierarchy/
```

Required production assets:

```text
tileset.json
tileset-none.json
tileset-frontier-tight.json
z0/**/tileset.json
z0/**/tileset-none.json
z0/**/tileset-frontier-tight.json
z0/**/aph-node-diagnostics.json
aph-node-diagnostics-index.json
points/z0/**/*.pnts
points/adaptive/**/*.pnts
```

Also upload the relevant `tileset-preview-*.json` only when serving a preview URL. Reports are optional for rendering but useful for audit/diagnostics:

```text
adaptive-point-hierarchy-report.json
adaptive-point-hierarchy-preview-report.json
```

Never upload these build-only directories/files:

```text
.aph-fragments/
.node-manifests/
.adaptive-point-hierarchy-state.json
*.ord.u64
*.raw
.DS_Store
```

Safe operational rule: sync the published directory with explicit exclusions for the build-only list above; do not use a destructive remote delete until the new canonical `tileset.json`, all referenced JSON, and every referenced PNTS object have uploaded successfully. Set JSON and PNTS objects to a cache policy appropriate to CloudFront; invalidate `tileset*.json` and metadata JSON after a replacement release, not immutable PNTS unless their bytes changed.

## Metadata invariants

- Only the synthetic entry root carries ENU→ECEF `transform`.
- Use `refine: "ADD"` for p001 and all adaptive nodes.
- Use content bounds for PNTS/RTC, subtree bounds for tile bounding volumes.
- Require parent bounds to contain content and all descendants.
- Compute raw error as `sqrt(areaXY / contentPointCount) * 2`.
- Set leaf error to zero; correct internal errors to be strictly above children.
- Keep PNTS shared between `none` and `frontier-tight`.
- Put `frontier-tight` VRV only at adaptive depth 5; never repeat it below.
- Do not delete manifests, state, or audit sidecars until validation and atomic canonical publish succeed.

## Viewer

Use:

```text
?dataset=peru-b2-globe&lod=adaptive-point-hierarchy&aphPreviewZ0=z0_x000002_y000004&aphVrv=none
?dataset=peru-b2-globe&lod=adaptive-point-hierarchy&aphPreviewZ0=z0_x000002_y000004&aphVrv=frontier-tight
```

Keep APH parser/controller separate from Spatial LOD. Use SSE ladder `4,8,12,16,24,32,48,64`, settled baseline 16, and detail eligibility only from camera range <=250 m or intersection with a loaded frontier-tight VRV. Active depth is telemetry, never an eligibility input.

### Runtime URL modes

Use the baseline when inspecting quality or tuning point size:

```text
?lod=adaptive-point-hierarchy&aphController=simple&aphVrv=none&aphRender=raw
```

- `aphController=simple`: fixed direct Cesium traversal. Use this for A/B tests. `advanced` enables adaptive SSE/pressure logic and is not a quality baseline.
- `aphVrv=none`: no request-volume gate. `frontier-tight` is an optimisation experiment; do not compare it with `none` while simultaneously tuning quality.
- `aphRender=raw`: attenuation and EDL are off, and is the default when the parameter is omitted or invalid. `aphRender=balanced` explicitly enables Cesium attenuation/EDL. `styled` is not a recognised parser value.

APH point-size UI is independent of render profile. `Far`, `Mid`, and `Near Point Size` are base px values over camera distance. `Point Size` is a 0.5–5× global multiplier applied to the whole curve. Use raw when judging source density or hole masking.

## Validation

Run:

```bash
/Volumes/WD_BLACK/conda/envs/pointcloud-pipeline/bin/python -m unittest pipeline.tests.test_build_adaptive_point_hierarchy_tileset
cd viewer && npm test -- src/adaptive-point-hierarchy.test.ts src/spatial-lod.test.ts
cd viewer && npm run build
git diff --check
```

Confirm relative URIs cannot escape output, JSON/PNTS headers are valid, errors strictly decrease, bounds contain descendants, accounting matches Task 2, both VRV variants share PNTS, and the browser has no console errors.

## Safe changes

Run GitNexus upstream impact before editing indexed symbols. Warn on HIGH or CRITICAL risk. Preserve Task 2 processes and unrelated dirty-worktree changes. Run `detect_changes` before committing.
