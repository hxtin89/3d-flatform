# SBB — Adaptive Point Hierarchy (APH) Point-Cloud Pipeline

This repository builds and serves large point clouds for the CesiumJS viewer.
Its primary production mode is **Adaptive Point Hierarchy (APH)**:

```text
2 km z0 p001 overview
  + adaptive internal representatives
  + adaptive residual leaves
```

APH preserves the existing 2 km z0 grid for dataset compatibility.  Within
each z0 it creates a content-driven residual quadtree.  The hierarchy uses
3D Tiles `ADD` refinement, so ancestor content remains visible while deeper
content is added.

## Prerequisites

- Node.js 18 or newer
- PDAL, PROJ, `laspy[lazrs]`, and the local `pointcloud-pipeline` conda env
- Source LAS or LAZ data available under `local-storage/`

Create the environment when needed:

```bash
/Volumes/WD_BLACK/conda/miniforge/bin/mamba create \
  -n pointcloud-pipeline -c conda-forge python=3.11 pdal proj pip

/Volumes/WD_BLACK/conda/miniforge/bin/conda run \
  -n pointcloud-pipeline \
  python -m pip install 'laspy[lazrs]'
```

Install the JavaScript dependencies:

```bash
npm install
npm run viewer:install
```

## End-to-end pipeline: LAS → prepared → chunks → COPC → APH

The production path for a large dataset is below.  In the examples,
`2404PeruB2` is the extensionless dataset name; replace it with your own name.
APH reads the per-chunk COPC files, so do not skip chunking and COPC conversion
(Steps 3–4).

```text
raw LAS/LAZ files
  → inspect metadata
  → prepared LAZ (validated, consolidated source)
  → spatial LAZ chunks
  → per-chunk COPC LAZ
  → optional chunked-COPC 3D Tiles checkpoint
  → APH durable PNTS content
  → APH tileset publisher
  → local viewer or S3 / CloudFront
```

### 0. Add the source LAS/LAZ files

Place a source file or a folder containing one or more `.las`/`.laz` files in
the local runtime store.  This example uses a directory so multiple source
files are handled as one dataset:

```text
local-storage/raw/2404PeruB2/
  flight-001.las
  flight-002.las
```

`local-storage/` is runtime data and should not be committed.  `pipeline:download`
does not download arbitrary datasets: for a non-sample dataset it verifies that
the corresponding file or folder already exists.

```bash
npm run pipeline:download -- 2404PeruB2
```

### 1. Inspect the raw source

Read PDAL metadata, point counts, bounds, and CRS before any conversion:

```bash
npm run pipeline:inspect -- 2404PeruB2
```

Output:

```text
local-storage/intermediate/2404PeruB2/info.json
```

Check that the point count, bounds, and CRS match the expected acquisition.
APH globe placement requires a usable CRS across all source chunks.

### 2. Create the prepared LAZ

The prepare step validates that PDAL can read every source file and writes a
single compressed LAZ.  It currently preserves the source CRS; it does not
silently reproject it.

```bash
npm run pipeline:prepare -- 2404PeruB2
```

Output:

```text
local-storage/intermediate/2404PeruB2/
  2404PeruB2.prepared.laz
  prepare.pipeline.json
```

If the viewer cannot place the dataset correctly because of CRS issues,
reproject deliberately before continuing; do not assume the preparation step
converted coordinates to EPSG:4978.

### 3. Split the prepared LAZ into spatial chunks

Large whole-file COPC builds can exceed local memory.  Split the prepared LAZ
into fixed-size XY tiles first.  The default shown below is a 500-unit tile;
adjust it to the source CRS and available disk/memory.  Keep the default zero
buffer unless your workflow explicitly needs overlap.

```bash
POINTCLOUD_CHUNK_LENGTH=500 \
  npm run pipeline:chunk -- 2404PeruB2
```

Optional controls:

```bash
# Use PDAL filters.splitter rather than pdal tile.
POINTCLOUD_CHUNK_MODE=splitter POINTCLOUD_CHUNK_LENGTH=500 \
  npm run pipeline:chunk -- 2404PeruB2

# Recreate existing chunk files intentionally.
POINTCLOUD_CHUNK_OVERWRITE=1 POINTCLOUD_CHUNK_LENGTH=500 \
  npm run pipeline:chunk -- 2404PeruB2
```

Output:

```text
local-storage/intermediate/2404PeruB2/
  chunks-laz/chunk-*.laz
  chunk.pipeline.json
```

### 4. Convert every chunk to COPC

Each chunk becomes an independently readable COPC-LAZ source.  Start with one
thread for predictable memory usage; increase `COPC_THREADS` only after
measuring the machine's memory headroom.

```bash
COPC_THREADS=1 npm run pipeline:copc:chunks -- 2404PeruB2
```

The command skips already completed chunks.  For a controlled rebuild, use
`COPC_CHUNK_OVERWRITE=1`; to make a small test run, set
`COPC_CHUNK_LIMIT=<count>`.

Output:

```text
local-storage/intermediate/2404PeruB2/
  chunks-copc/chunk-*.copc.laz
  chunk-copc-pipelines/*.pipeline.json
```

### 5. Optional: make a full chunked-COPC tileset checkpoint

This conversion is useful to validate the per-chunk COPC source and to retain
an internal full-data benchmark.  It is not the normal viewer default for a
very large dataset, and it is not required for APH; APH reads `chunks-copc/`
directly.

```bash
npm run pipeline:tiles:copc:chunks -- 2404PeruB2
```

Output:

```text
local-storage/tilesets/2404PeruB2-chunked-copc/
  tileset.json
  chunks/<chunk-id>/tileset.json
  dataset-report.json
```

Validate its root document before moving on:

```bash
node -e "JSON.parse(require('fs').readFileSync('local-storage/tilesets/2404PeruB2-chunked-copc/tileset.json', 'utf8')); console.log('ok')"
```

### 6. Build APH durable content (Task 2)

APH is deliberately split into two stages.  Do not run two content builders
against the same output directory.

Task 2 streams the source COPC, partitions points into z0 cells, writes PNTS
content, and maintains resume state plus node manifests.  It can run for many
hours and can be resumed.

For a new output, build the automatic pilot set of real z0 cells:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
  npm run pipeline:adaptive-point-hierarchy -- \
  2404PeruB2 --pilot auto
```

Resume that same build after an interruption:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
  npm run pipeline:adaptive-point-hierarchy -- \
  2404PeruB2 --pilot auto --resume
```

After a completed pilot has passed validation, extend it to all census z0
cells without rebuilding pilot content:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
  npm run pipeline:adaptive-point-hierarchy -- \
  2404PeruB2 --pilot auto --resume --extend-pilot
```

For a targeted build, use a repeatable `--z0-id` flag instead:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
  npm run pipeline:adaptive-point-hierarchy -- \
  2404PeruB2 --z0-id z0_x000002_y000004 --resume
```

`--pilot auto` is a bounded set of real cells for validation; it never creates
synthetic data.  `--extend-pilot` requires `--resume` and an already completed
pilot output.  Avoid `--overwrite` on a production logical root unless
replacing that output is intentional.

### 7. Publish APH 3D Tiles metadata (Task 3)

Task 3 reads completed Task 2 manifests and writes tileset JSON and compact
diagnostics.  It does not rebuild PNTS content.

While Task 2 is still running, preview a z0 listed in `completedZ0Ids`:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
  npm run pipeline:adaptive-point-hierarchy:tileset -- \
  2404PeruB2 --preview-z0 z0_x000002_y000004
```

After all selected z0 cells are durable, publish the canonical full tileset:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
  npm run pipeline:adaptive-point-hierarchy:tileset -- 2404PeruB2
```

Add `--full-validate` when the build is no longer competing for disk I/O and a
full PNTS-header validation is desired.

## Output layout

For logical dataset `<logical>`, APH writes:

```text
local-storage/tilesets/<logical>/<logical>-adaptive-point-hierarchy/
  tileset.json                              # canonical full entry (VRV none)
  tileset-none.json
  tileset-frontier-tight.json
  z0/<z0Id>/tileset*.json                   # per-z0 entries
  points/z0/<z0Id>.pnts                     # p001 overview content
  points/adaptive/<z0Id>/d*_q*.pnts         # internal and residual content
  aph-node-diagnostics-index.json
  adaptive-point-hierarchy-report.json
  .adaptive-point-hierarchy-state.json      # resumable-build state; do not publish
  .node-manifests/                          # Task 2 manifests; do not publish
  .aph-fragments/                           # temporary/resume files; do not publish
```

The state, manifests, and fragments are build artifacts.  Keep them until
validation and an atomic canonical publish have succeeded.

## Serve and view locally

Run the tiles server and the Vite viewer in separate terminals:

```bash
npm run pipeline:serve       # http://localhost:8081
npm run viewer:dev           # http://localhost:5173
```

Open the standard APH quality baseline:

```text
http://localhost:5173/?lod=adaptive-point-hierarchy&aphController=simple&aphVrv=none&aphRender=raw
```

To inspect one published z0 or the request-volume experiment:

```text
?lod=adaptive-point-hierarchy&aphPreviewZ0=z0_x000002_y000004&aphVrv=none
?lod=adaptive-point-hierarchy&aphPreviewZ0=z0_x000002_y000004&aphVrv=frontier-tight
```

- `aphController=simple` uses direct Cesium traversal and is the A/B quality
  baseline. `advanced` enables adaptive SSE/pressure behavior.
- `aphVrv=none` has no request-volume gate. `frontier-tight` is an
  optimization experiment and should not be mixed with unrelated quality
  tuning.
- `aphRender=raw` disables attenuation and EDL (and is the default). Use
  `aphRender=balanced` to enable them.
- Far, Mid, Near Point Size are base pixel sizes; Point Size is a global
  0.5–5× multiplier.

## APH invariants

- Each valid selected point is owned exactly once: either the z0 p001 overview
  or one adaptive node. No point is omitted or duplicated.
- Internal nodes emit sampled representatives; leaves emit all residual points
  they own. Visible totals are `p001 + internal + leaf`, not leaf content alone.
- p001 and adaptive nodes use `refine: "ADD"`.
- Only the synthetic entry root carries the ENU-to-ECEF transform.
- PNTS uses content bounds/RTC centers; tiles use subtree bounds that contain
  the node content and all descendants.
- Leaves have zero geometric error. Internal errors are corrected bottom-up to
  remain strictly above their children.
- The `none` and `frontier-tight` variants share the same PNTS files.

## Validate changes

```bash
/Volumes/WD_BLACK/conda/envs/pointcloud-pipeline/bin/python \
  -m unittest pipeline.tests.test_build_adaptive_point_hierarchy_tileset

cd viewer && npm test -- src/adaptive-point-hierarchy.test.ts src/spatial-lod.test.ts
cd viewer && npm run build
git diff --check
```

Confirm that all JSON and PNTS headers are valid, relative content URIs cannot
escape the output directory, bounds contain descendants, errors decrease
strictly, accounting matches the Task 2 manifests, both variants reference the
same PNTS content, and the browser has no console errors.

## Release to S3 / CloudFront

Upload serving assets from:

```text
local-storage/tilesets/<logical>/<logical>-adaptive-point-hierarchy/
```

Include `tileset*.json`, `z0/**/tileset*.json`, diagnostics JSON, and all PNTS
under `points/z0/` and `points/adaptive/`.  Upload preview tilesets only when
they will be served.  Exclude `.aph-fragments/`, `.node-manifests/`,
`.adaptive-point-hierarchy-state.json`, `*.ord.u64`, `*.raw`, and `.DS_Store`.

Do not use destructive remote deletion until the new canonical `tileset.json`,
every referenced JSON document, and every referenced PNTS object have uploaded
successfully.  Invalidate `tileset*.json` and metadata JSON after replacement;
PNTS files can remain cached when their bytes are unchanged.
