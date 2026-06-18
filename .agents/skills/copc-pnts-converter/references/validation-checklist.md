# COPC PNTS Validation Checklist

Use this guide after generating a local-only COPC to 3D Tiles PNTS output. It is written for agents validating the converter output before changing tiling, transforms, PNTS writing, or Cesium viewer behavior.

## Required Commands

Generate the COPC PNTS tileset:

```sh
npm run pipeline:tiles:copc -- wi-1
```

Serve local 3D Tiles output:

```sh
npm run pipeline:serve
```

Start the CesiumJS viewer:

```sh
npm run viewer:dev
```

Open the debug viewer:

```text
http://localhost:5173/?dataset=wi-1-copc&debugTiles=1
```

## Static Tileset Checks

Validate the generated files before opening Cesium:

- `local-storage/tilesets/wi-1-copc/tileset.json` parses as JSON.
- Every nested `content.uri` exists relative to the tileset directory.
- The root tile has a 16-number `transform`.
- `geometricError` never increases from parent to child.
- Tiles use `refine: "ADD"`.
- `conversion-report.json` exists.
- `conversion-report.json.source_point_count` matches `conversion-report.json.emitted_point_count`.
- Warnings are reviewed, but warnings do not fail conversion by themselves.

Expected non-fatal warning for the current `wi-1-copc` output:

```text
missing_crs_metadata
```

## PNTS Checks

Sample several `.pnts` files from different depths and verify:

- Header magic is `pnts`.
- Version is `1`.
- `byteLength` matches the actual file size.
- Feature table JSON contains `POINTS_LENGTH`.
- Feature table JSON contains `POSITION`.
- Feature table JSON contains `RTC_CENTER`.
- `RGB` exists when `conversion-report.json.has_rgb` is `true`.
- `RGB` is absent when `conversion-report.json.has_rgb` is `false`.
- PNTS feature table JSON and binary alignment are valid for 3D Tiles 1.0.
- Reconstructed local positions, `POSITION + RTC_CENTER`, fall inside the tile bounding box.

Alignment note:

- The feature table binary starts at `28 + featureTableJsonByteLength`.
- That start offset must be 8-byte aligned.
- The feature table binary byte length should also be 8-byte padded.
- `featureTableJsonByteLength` itself does not need to be divisible by 8.

## HTTP Serving Checks

Confirm the tile server is serving the dataset:

```sh
curl -I http://localhost:8081/wi-1-copc/tileset.json
```

Expected:

- Status is `200`.
- `Access-Control-Allow-Origin: *` is present.
- `Content-Type` is JSON or otherwise browser-readable.

Confirm the viewer dev server is serving the page:

```sh
curl -I 'http://localhost:5173/?dataset=wi-1-copc&debugTiles=1'
```

Expected:

- Status is `200`.
- Response is HTML.

## Cesium Visual Checks

Open:

```text
http://localhost:5173/?dataset=wi-1-copc&debugTiles=1
```

Verify:

- The tileset loads with no red error overlay.
- Child tiles are requested after load.
- The point cloud appears.
- Camera flyTo frames the cloud.
- Bounding volume debug overlays align with rendered points.
- Geometric error debug labels appear when debug mode is enabled.
- Rendering statistics appear when debug mode is enabled.
- Close camera movement has no visible precision jitter.
- Tiles do not flicker during orbit, pan, or zoom.
- Tiles do not disappear unexpectedly near the cloud.

When `debugTiles=1`, the viewer should enable:

```ts
tileset.debugShowBoundingVolume = true;
tileset.debugShowGeometricError = true;
tileset.debugShowRenderingStatistics = true;
```

## Current `wi-1-copc` Validation Status

Latest known static and HTTP validation result:

```text
source/emitted points: 66,082,297 / 66,082,297
tiles: 2073
max depth: 5
missing content: 0
bad geometricError: 0
bad PNTS headers: 0
missing RTC_CENTER: 0
sampled points outside bbox: 0
has_rgb: true
warnings: missing_crs_metadata only
tile server: 200 OK
viewer page: 200 OK
visual Cesium runtime: requires browser/manual or browser-capable agent
```

## Pass And Fail Signals

Pass when:

- Point counts match.
- All content URIs exist.
- PNTS headers and table lengths are valid.
- Sampled reconstructed points fall inside their tile bounding boxes.
- Root transform exists.
- Cesium requests child tiles.
- The cloud appears and camera controls remain stable.

Fail and investigate when:

- `tileset.json` or `conversion-report.json` is missing or invalid.
- Any `content.uri` is missing.
- Root tile has no `transform`.
- Child `geometricError` exceeds parent `geometricError`.
- `POINTS_LENGTH`, `POSITION`, or `RTC_CENTER` is missing.
- `RGB` presence does not match `has_rgb`.
- Sampled points fall outside tile bounding boxes.
- Cesium loads `tileset.json` but never requests child tiles.
- Camera flies to the wrong place or into empty space.
- Bounding volumes do not cover rendered points.
- Close camera movement shows precision jitter.
- Tiles flicker or disappear during normal navigation.

## Assumptions

- Output is local-only and not geographically placed on the Cesium globe.
- COPC remains the source of truth.
- PNTS is the current 3D Tiles point cloud content format.
- Missing CRS metadata is a warning, not a conversion failure.
- Merge/split optimization is deferred unless validation shows tile count, tile size, or runtime behavior problems.
