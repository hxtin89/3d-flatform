---
name: laz-3dtiles-pipeline
description: Use when implementing, running, debugging, or validating the local LAZ/COPC-LAZ to 3D Tiles pipeline that uses PDAL, py3dtiles, sirv, and the CesiumJS viewer. Covers dynamic source folders like wi-1, standard LAZ normalization for COPC input, tileset output naming, tile server restart issues, and viewer dataset query parameters.
---

# LAZ 3D Tiles Pipeline

Use this skill for the existing fallback pipeline:

```text
LAZ or COPC LAZ -> optional PDAL normalization -> py3dtiles -> tileset.json + .pnts -> sirv -> CesiumJS viewer
```

This is not the direct COPC-node-to-PNTS converter.

## Core Contract

- Output goes under `local-storage/tilesets/<dataset>`.
- Source folder convention:
  - `npm run pipeline:tiles -- wi-1`
  - input: `local-storage/wi-1`
  - output: `local-storage/tilesets/wi-1`
- If source is a file path, derive dataset from its parent folder.
- If a source folder has multiple `.laz` files, fail and ask for a specific file path.
- Do not run `pipeline:all` for custom datasets unless all scripts are dataset-aware; it is sample/autzen-oriented.

## COPC Input Rule

If input ends with `.copc.laz`, do not feed it directly to `py3dtiles`.

Normalize first:

```text
local-storage/<dataset>/*.copc.laz
  -> local-storage/intermediate/<dataset>/<dataset>.standard.laz
  -> py3dtiles convert
```

Reason: direct `py3dtiles convert *.copc.laz` produced malformed/poor output in this project: giant `.pnts`, bad bbox/geometricError, collapsed sampled positions, and black screen/tiny dot in Cesium. Standard LAZ normalization fixed the visible output.

## Commands

Convert:

```bash
cd /Volumes/WD_BLACK/projects/SBB
npm run pipeline:tiles -- wi-1
```

Serve:

```bash
cd /Volumes/WD_BLACK/projects/SBB
npm run pipeline:serve
```

Viewer:

```bash
cd /Volumes/WD_BLACK/projects/SBB
npm run viewer:dev
```

Open:

```text
http://localhost:5173/?dataset=wi-1
```

## Viewer Rules

- Viewer loads `http://localhost:8081/<dataset>/tileset.json`.
- Dataset comes from `?dataset=<name>`.
- Restrict dataset names to `[a-zA-Z0-9_-]+`.
- Top bar should show selected dataset, not hardcoded `autzen.laz`.
- Mark ready after tileset is added and camera is framed; do not wait forever for all streaming tiles.

## Tile Server Caveat

Restart `npm run pipeline:serve` after regenerating an existing tileset. `sirv` can serve stale or truncated responses if a folder is overwritten while server is running.

Symptoms:

- Cesium JSON parse error
- old `Content-Length` from `curl`
- empty/truncated JSON body

Verify after restart:

```bash
curl -s http://localhost:8081/<dataset>/tileset.json | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{JSON.parse(s); console.log('ok', s.length)})"
```

## Validation Checklist

- `local-storage/tilesets/<dataset>/tileset.json` exists and parses.
- All referenced `.pnts` files exist.
- Tile count and total size are plausible.
- Output did not become one giant tile with almost all points.
- Root bounding volume roughly matches source bounds.
- Camera frames the cloud.
- Cloud is visible, not black or a tiny dot.
- No browser console/network 404 or JSON parse errors.

Useful checks:

```bash
find local-storage/tilesets/<dataset> -type f | wc -l
du -sh local-storage/tilesets/<dataset>
node -e "const fs=require('fs'); JSON.parse(fs.readFileSync('local-storage/tilesets/<dataset>/tileset.json','utf8')); console.log('tileset ok')"
```

## Failure Patterns

- `ENOENT: uv_cwd`: terminal is in a deleted folder; `cd /Volumes/WD_BLACK/projects/SBB`.
- Black screen but ready: inspect root bbox/camera distance and tile streaming.
- JSON parse error after regenerate: restart tile server.
- COPC direct conversion creates giant `.pnts`: normalize to standard LAZ before `py3dtiles`.
- Viewer says autzen: dataset label is hardcoded or query param ignored.

## Boundaries

- This skill covers the py3dtiles fallback pipeline.
- For direct COPC hierarchy to PNTS work, use `copc-pnts-converter`.
- Do not add COPC merge/split logic here.
