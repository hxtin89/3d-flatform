---
name: copc-pnts-converter
description: Use when implementing, debugging, validating, or extending the local COPC node to 3D Tiles PNTS converter for CesiumJS. Covers COPC hierarchy reading, range-read LAZ chunk decode with laspy/lazrs, PNTS writing with RTC_CENTER, local-only tileset.json generation, geometricError tuning, and Cesium debug validation.
---

# COPC PNTS Converter

Use this skill for the custom local-only converter:

```text
COPC node -> range read -> lazrs decode XYZ/RGB -> PNTS with RTC_CENTER -> tileset.json refine ADD -> CesiumJS validation
```

This is not the py3dtiles fallback path, Cesium ion, ECEF/globe placement, or browser-side direct COPC rendering.

## Core Contract

- Keep `py3dtiles` as fallback.
- Command shape: `npm run pipeline:tiles:copc -- wi-1`.
- Output: `local-storage/tilesets/<dataset>-copc`.
- V1 mirrors COPC hierarchy directly: one non-empty COPC node becomes one `.pnts` tile.
- No merge/split, no CRS reprojection, no ECEF/globe placement in V1.
- XYZ is mandatory.
- RGB is optional:
  - if RGB dimensions exist, emit PNTS `RGB` as uint8;
  - if absent, emit `POSITION` only;
  - missing RGB must not fail conversion;
  - record `has_rgb` in `conversion-report.json`.
- Omit intensity, classification, return number, and extra dimensions from PNTS output.

## Implementation Rules

- Use Python `laspy.CopcReader` with native `lazrs`; do not hand-roll LAZ decompression.
- Read COPC info VLR, hierarchy entries, node bounds, point counts, offsets, byte sizes, spacing, CRS metadata, and RGB availability.
- For each non-empty node:
  - range-read/decode exactly that node chunk;
  - compute tile center from node bounds;
  - write PNTS `POSITION` as float32 `point_world - tile_center_world`;
  - write PNTS `RTC_CENTER` as `tile_center_world - root_center_world`;
  - write optional `RGB`.
- PNTS must use valid 8-byte padding for feature table JSON and binary.

## Tileset Rules

- Root tile must have `transform` translating local coordinates back to source root center:

```json
[1,0,0,0, 0,1,0,0, 0,0,1,0, rootX,rootY,rootZ,1]
```

- Tile bounding boxes are local to root transform:
  - box center = `node_center_world - root_center_world`
  - half axes = node bounds half-size
- Use `refine: "ADD"`.
- `geometricError` must monotonically decrease by COPC depth.
- For direct node mapping V1, root error must be large enough to force refinement:
  - use root bbox diagonal for root error;
  - child error = parent error / 2;
  - leaf error = `0` or near-zero.
- Do not use COPC spacing directly as root error; it is usually too small and may prevent child tile requests.

## Report And Warnings

Emit `conversion-report.json` with:

- `source_point_count`
- `emitted_point_count`
- `tile_count`
- `skipped_empty_nodes`
- `max_tile_points`
- `max_tile_bytes`
- `root_transform`
- `root_center`
- `root_bbox`
- `source_bbox`
- `crs.has_crs`
- `has_rgb`
- `warnings`

Warnings should not fail conversion. Warn for:

- `tile_points > 150000`
- `tile_bytes > 5MB`
- `total_tiles > 5000`
- missing CRS metadata
- unusually large root bbox
- root bbox does not contain all tile bboxes

## Validation Checklist

- Parse `tileset.json` and all nested JSON.
- Verify all `content.uri` files exist.
- Verify root tile has `transform`.
- Verify root `geometricError` is large enough to trigger refinement.
- Verify child `geometricError` never exceeds parent.
- Verify root bbox contains child tile bboxes.
- Inspect sampled `.pnts` headers: magic, byteLength, `POINTS_LENGTH`, `POSITION`, `RTC_CENTER`, optional `RGB`.
- Sample PNTS points and reconstruct local positions with `RTC_CENTER`; points should fall inside tile bbox.

## Cesium Debug

Open:

```text
http://localhost:5173/?dataset=<dataset>-copc&debugTiles=1
```

Debug mode should enable:

```ts
tileset.debugShowBoundingVolume = true;
tileset.debugShowGeometricError = true;
tileset.debugShowRenderingStatistics = true;
```

Confirm child tile requests, visible cloud, correct camera framing, aligned bounding boxes, no close-camera precision jitter, no flicker, and no disappearing tiles.

If invisible, check root `transform`. If children are not requested, check root `geometricError`.
