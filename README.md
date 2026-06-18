# SBB — Local Self-Hosted Point Cloud Pipeline

Phase 1: Local pipeline from LAZ → PDAL → COPC → 3D Tiles → CesiumJS viewer.

## Prerequisites

- **Node.js** ≥ 18
- **PDAL** + **py3dtiles** — install via conda:
  ```bash
  /Volumes/WD_BLACK/conda/miniforge/bin/mamba create \
    -n pointcloud-pipeline \
    -c conda-forge \
    python=3.11 pdal proj pip

  /Volumes/WD_BLACK/conda/miniforge/bin/conda run \
    -n pointcloud-pipeline \
    python -m pip install 'py3dtiles[las]' 'laspy[lazrs]'
  ```
- **curl** (for dataset download)

## Quick Start

```bash
# 1. Install JS dependencies
npm install
npm run viewer:install

# 2. Run the full pipeline (download → inspect → prepare → copc → tiles)
#    Either activate the env or let scripts use the external conda fallback.
source /Volumes/WD_BLACK/conda/miniforge/bin/activate pointcloud-pipeline
npm run pipeline:all

# 3. Start the tile server (port 8081)
npm run pipeline:serve

# 4. Open the viewer (port 5173, in a new terminal)
npm run viewer:dev
```

Then open **http://localhost:5173**

The viewer loads local tiles by default. To load the uploaded CloudFront tileset,
open:

```text
http://localhost:5173/?source=cloudfront
```

CloudFront mode uses `viewer/.env`:

```env
VITE_AWS_CMS_S3_BUCKET_NAME=wilderness-international-cms-dev
VITE_AWS_CMS_CLOUDFRONT_DISTRIBUTION_DOMAIN=d189h36wq57fqa.cloudfront.net
VITE_POINTCLOUD_TILES_FOLDER=pointcloud-tiles
```

## Individual Pipeline Steps

| Command | Description |
|---|---|
| `npm run pipeline:download` | Download `autzen.laz` sample dataset |
| `npm run pipeline:inspect` | Run PDAL info → `local-storage/intermediate/autzen/info.json` |
| `npm run pipeline:prepare` | Validate and prepare LAZ (Phase 1: pass-through) |
| `npm run pipeline:copc` | Generate COPC LAZ via `pdal writers.copc` |
| `npm run pipeline:tiles` | Convert to 3D Tiles with `py3dtiles` |
| `npm run pipeline:serve` | Serve tilesets on `http://localhost:8081` |
| `npm run pipeline:all` | Run all steps sequentially |
| `npm run viewer:dev` | Start CesiumJS viewer on `http://localhost:5173` |

## Directory Layout

```
local-storage/           # gitignored runtime data
  raw/autzen.laz         # downloaded raw LAZ
  intermediate/autzen/   # info.json + autzen.copc.laz + autzen.prepared.laz
  tilesets/autzen/       # tileset.json + .pnts tiles

pipeline/                # shell scripts for each step
viewer/                  # Vite + TypeScript + CesiumJS frontend
  src/
    main.ts              # entry point
    viewer.ts            # CesiumJS Cesium3DTileset loader
    presets.ts           # Low / Medium / High quality presets
    ui.ts                # status overlay + controls
    style.css            # premium dark UI
```

The pipeline scripts also work without activating conda if the external install exists at:

```bash
/Volumes/WD_BLACK/conda/miniforge/bin/conda
```

They automatically run missing geospatial tools through the `pointcloud-pipeline` env.

## CesiumJS Viewer Features

- Loads `tileset.json` from local tile server by default, or CloudFront with `?source=cloudfront` (no Cesium ion)
- Flies camera to point cloud bounding sphere on load
- **Quality presets**: Low / Medium / High (screen-space error + memory + point cloud shading)
- **Error state**: friendly message if tile server is down or tileset missing
- Dark glassmorphism UI with live rendering stats

## Architecture

```
LAZ (raw)
  → pdal info            → info.json
  → pdal pipeline        → prepared.laz
  → pdal writers.copc    → autzen.copc.laz
  → py3dtiles convert    → tilesets/autzen/tileset.json + *.pnts
  → sirv-cli (8081)      → HTTP static tile server
  → CesiumJS (5173)      → Viewer
```

## Phase 2 Candidates

- Entwine EPT for larger datasets
- S3 + CloudFront for hosted delivery
- CRS reprojection to EPSG:4978 if needed for global placement
- Containerised pipeline (Docker)
