# Locked Stack: Local Self-Hosted Point Cloud Pipeline

## Summary
Phase 1 sẽ build pipeline self-hosted chạy local hoàn chỉnh: local `LAZ/COPC` input → PDAL/PROJ processing → `3D Tiles` generation → local static serving → CesiumJS render UI. S3/CloudFront được thay bằng local filesystem + local HTTP server.

## Implementation Status

Phase 1 has been implemented and verified locally in `/Volumes/WD_BLACK/projects/SBB`.

Completed:

- Miniforge installed on external storage: `/Volumes/WD_BLACK/conda/miniforge`.
- Conda env created: `pointcloud-pipeline`.
- Native/geospatial toolchain installed: `PDAL 2.10.1`, `PROJ`, Python 3.11.
- `py3dtiles 12.1.1` installed with required LAZ support: `py3dtiles[las]` + `laspy[lazrs]`.
- Full local pipeline passes from `autzen.laz` to `3D Tiles`.
- Local tile server serves `http://localhost:8081/autzen/tileset.json` with CORS.
- CesiumJS viewer builds successfully and runs on `http://localhost:5173`.

Generated local outputs:

- Raw LAZ: `local-storage/raw/autzen.laz` (~54 MB).
- Intermediate files: `local-storage/intermediate/autzen/` (~134 MB).
- 3D Tiles: `local-storage/tilesets/autzen/` (~156 MB, 1455 tile files + `tileset.json`).

## Stack Theo Từng Step
- **Raw Data**
  - Format: `LAZ` là input chính, `COPC` là optional normalized/intermediate output.
  - Dataset Phase 1: PDAL `autzen.laz`.
  - Local path: `local-storage/raw/{dataset}.laz`.

- **Inspect / Validate**
  - Tool: `PDAL`.
  - Output: metadata JSON gồm bounds, point count, dimensions, SRS nếu có.
  - Local path: `local-storage/intermediate/{dataset}/info.json`.

- **Prepare / Reproject**
  - Tools: `PDAL` + `PROJ`.
  - Behavior: validate input, normalize CRS when needed, optionally crop/filter later.
  - Default Phase 1: keep source CRS unless render placement fails; only reproject when dataset requires it.

- **COPC Generation**
  - Tool: `PDAL writers.copc`.
  - Output: `local-storage/intermediate/{dataset}/{dataset}.copc.laz`.
  - Purpose: prove COPC readiness, not final viewer format.

- **3D Tiles Builder**
  - Tool: `py3dtiles`.
  - Installed via pip because it is not available as a conda-forge package in this setup.
  - Required extras for LAZ input: `py3dtiles[las]` and `laspy[lazrs]`.
  - Input default: prepared `.laz`.
  - Output: `tileset.json` + `.pnts` tile content.
  - Local path: `local-storage/tilesets/{dataset}/tileset.json`.
  - Actual Phase 1 CLI syntax: `py3dtiles convert <input.laz> --out <output-dir> --overwrite --color_scale 256`.

- **Indexing**
  - Phase 1: no Entwine in runtime path.
  - Phase 2 candidate: `Entwine EPT` for larger datasets and octree indexing.
  - Reason: EPT is useful indexing storage, but CesiumJS target remains `3D Tiles`.

- **Local Storage**
  - Tooling: filesystem folders, no object storage.
  - Layout:
    - `local-storage/raw/`
    - `local-storage/intermediate/`
    - `local-storage/tilesets/`
  - Generated files stay out of git.

- **Local Tile Delivery**
  - Tool: Node static server.
  - Recommended package: `sirv-cli` or a tiny Express static server.
  - Default URL shape: `http://localhost:8081/{dataset}/tileset.json`.

- **Frontend**
  - Stack: `Vite` + `TypeScript` + `CesiumJS`.
  - Behavior: load local `tileset.json`, fly camera to tileset, show load/error state.
  - No Cesium ion token, no remote terrain/imagery requirement in Phase 1.
  - Because the Phase 1 tileset is rendered in local/projected coordinates with globe disabled, the viewer uses custom orbit/zoom/pan controls around the tileset bounding sphere instead of relying on default Cesium globe navigation.

- **Point Cloud Runtime Tuning**
  - Tool/API: CesiumJS `Cesium3DTileset` + `PointCloudShading`.
  - UI presets:
    - `Low`: lower memory/quality, higher screen-space error.
    - `Medium`: default.
    - `High`: higher visual quality, lower screen-space error.
  - Keep this simple; no benchmark dashboard in Phase 1.
  - Point attenuation is disabled for the current local prototype presets to prevent the point cloud from visually disappearing when zooming close.

## Implementation Fixes Applied

- Added `pipeline/env.sh` so scripts can automatically run missing geospatial tools through `/Volumes/WD_BLACK/conda/miniforge/bin/conda run -n pointcloud-pipeline` without requiring manual activation.
- Changed PDAL pipelines from stdin-based execution to JSON pipeline files because `conda run pdal pipeline --stdin` did not receive stdin reliably.
- Changed `py3dtiles` output flag from `--outfolder` to `--out` to match `py3dtiles 12.1.1`.
- Added `--color_scale 256` to `py3dtiles convert` because the Autzen LAZ color values are in 0-256 range; without this, output can appear black.
- Added custom Cesium local model controls:
  - left-drag orbit,
  - scroll zoom,
  - right-drag pan,
  - camera guard rails around the point cloud bounding sphere.
- Documented the difference between Phase 1 local-coordinate viewer mode and future production geospatial/globe mode.

## Command Interface
- `pipeline:download`: download sample LAZ into `local-storage/raw/`.
- `pipeline:inspect`: run PDAL info and save metadata JSON.
- `pipeline:prepare`: run PDAL/PROJ preparation pipeline.
- `pipeline:copc`: create COPC LAZ with PDAL.
- `pipeline:tiles`: convert prepared LAZ to 3D Tiles with `py3dtiles`.
- `pipeline:serve`: serve `local-storage/tilesets/` on port `8081`.
- `viewer:dev`: run CesiumJS viewer.
- `pipeline:all`: run download → inspect → prepare → COPC → tiles.

## Test Plan
- Confirm raw LAZ downloads locally. Done: `local-storage/raw/autzen.laz` created.
- Confirm PDAL reads metadata and bounds. Done: `local-storage/intermediate/autzen/info.json` created.
- Confirm prepared LAZ is generated. Done: `autzen.prepared.laz` created.
- Confirm COPC output is readable by PDAL. Done: `autzen.copc.laz` validates with `10653336` points.
- Confirm `py3dtiles` creates `tileset.json` and `.pnts` content. Done: `1455` tile files generated.
- Confirm local static server serves `tileset.json`. Done: `http://localhost:8081/autzen/tileset.json` returns HTTP 200 with CORS.
- Confirm viewer server starts. Done: `http://localhost:5173` returns HTTP 200.
- Confirm viewer production build. Done: `npm run build` passes in `viewer/`.
- Confirm quality preset changes do not crash the viewer. Implemented; should be verified manually in browser.
- Confirm custom orbit/zoom/pan works for local-coordinate mode. Implemented and manually improved after user testing.
- Confirm missing or invalid tileset shows a visible error state. Implemented in viewer error overlay; should be rechecked manually when needed.

## Assumptions And References
- `py3dtiles` is locked as the Phase 1 converter because it supports point cloud conversion to `tileset.json` + `pnts` files: [py3dtiles docs](https://py3dtiles.org/main/).
- `PDAL writers.copc` is locked for COPC output because PDAL supports writing COPC LAZ: [PDAL writers.copc](https://pdal.io/en/stable/stages/writers.copc.html).
- `3D Tiles` is locked as the viewer format because it is the open standard CesiumJS expects for massive geospatial content: [Cesium 3D Tiles](https://cesium.com/3d-tiles/).
- CesiumJS point cloud styling/tuning uses 3D Tiles point cloud APIs: [Cesium point cloud styling](https://cesium.com/learn/cesiumjs-learn/cesiumjs-3d-tiles-styling/) and [PointCloudShading](https://cesium.com/learn/cesiumjs/ref-doc/PointCloudShading.html).
- Entwine remains Phase 2 because EPT is an indexing format, not the Phase 1 Cesium viewer target: [Entwine EPT](https://entwine.io/entwine-point-tile.html).

## Remaining Notes

- Phase 1 remains local-only: no S3, CloudFront, Entwine, CMS, auth, or production backend.
- The current Autzen sample has no usable SRS in the extracted PDAL summary, so Phase 1 preserves source coordinates and treats the tileset as a local 3D object.
- Future geospatial prototype should explicitly test CRS normalization/reprojection and `tileset.json` transform so Cesium globe navigation can be used naturally.
- Browser automation could not be used in this environment because the Browser plugin Node runtime failed to start, so final visual checks were done manually by the user plus HTTP/build verification.
