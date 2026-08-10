# PLY to native Cesium Gaussian-splat tiles

`ply-to-splat-tileset.mjs` converts an INRIA 3D-Gaussian-Splatting PLY into a
single-content 3D Tiles 1.1 tileset:

```text
<outDir>/
  tileset.json
  splats.glb
```

The GLB embeds an SPZ v3 payload produced programmatically by
`@playcanvas/splat-transform` 3.1.7. Version 3 is intentional: CesiumJS 1.142's
installed `@spz-loader/core` path consumes the legacy gzip-backed SPZ stream,
whereas splat-transform's default SPZ v4 is the newer `NGSP` container.

## Usage

From the repository root:

```bash
node src/cesium-app/tools/ply-to-splat-tileset.mjs input.ply
node src/cesium-app/tools/ply-to-splat-tileset.mjs input.ply ./some/output
node src/cesium-app/tools/ply-to-splat-tileset.mjs \
  input.ply ./some/output \
  --max-sh 0 \
  --translate 1,2,3 \
  --transform 1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
```

The input may also be an `http:` or `https:` URL. If `outDir` is omitted, the
default is `public/splats/<input-basename>/`.

- `--max-sh` accepts degrees 0 through 3 and defaults to 0. It is passed to
  splat-transform's band filter before SPZ packing.
- `--translate x,y,z` is passed through as splat-transform's source translation
  action and is baked into the SPZ data before bounds are computed.
- `--transform` accepts exactly 16 comma-separated, finite, column-major matrix
  values. It replaces the identity `root.transform`; the intended production
  value is the app-provided local ENU-to-ECEF matrix.

## Cesium's extension-routing requirement

A GLB that merely declares `KHR_gaussian_splatting` is not enough for CesiumJS
1.142. `Cesium3DTileContentFactory` selects the native
`GaussianSplat3DTileContent` path only when
`GaussianSplat3DTileContent.tilesetRequiresGaussianSplattingExt` sees both glTF
extensions as required by the *tileset*.

The generated `tileset.json` therefore contains:

```json
{
  "extensionsUsed": ["3DTILES_content_gltf"],
  "extensionsRequired": ["3DTILES_content_gltf"],
  "extensions": {
    "3DTILES_content_gltf": {
      "extensionsUsed": [
        "KHR_gaussian_splatting",
        "KHR_gaussian_splatting_compression_spz_2"
      ],
      "extensionsRequired": [
        "KHR_gaussian_splatting",
        "KHR_gaussian_splatting_compression_spz_2"
      ]
    }
  }
}
```

The GLB also lists both extensions in its own `extensionsUsed` and
`extensionsRequired`. Its point-mode mesh primitive has metadata-only accessors
for `POSITION`, `COLOR_0`, `KHR_gaussian_splatting:ROTATION`,
`KHR_gaussian_splatting:SCALE`, and (when retained) higher SH coefficients. The
primitive extension is nested as:

```json
{
  "KHR_gaussian_splatting": {
    "kernel": "ellipse",
    "colorSpace": "srgb_rec709_display",
    "sortingMethod": "cameraDistance",
    "projection": "perspective",
    "extensions": {
      "KHR_gaussian_splatting_compression_spz_2": {
        "bufferView": 0
      }
    }
  }
}
```

Cesium's installed `GltfSpzLoader` currently reads bufferView 0 directly, so the
SPZ payload is deliberately the first and only buffer view. The accessors do
not reference buffer views; Cesium fills them from the decoded SPZ arrays.

## Coordinates and bounds

INRIA PLY is treated as Z-up. The SPZ payload remains in source coordinates.
The glTF node applies Rx(-90 degrees), mapping source Z-up to glTF Y-up. Cesium
then performs its standard glTF Y-up to tileset Z-up correction, so the two
rotations cancel and the root tile remains in the original source coordinate
frame. Do not also rotate the PLY with splat-transform.

`root.transform` is identity unless `--transform` is supplied. The root
`boundingVolume.box` is computed in source/tile coordinates from every splat's
center plus its rotated 3-sigma ellipsoid extent. The tileset-level
`geometricError` is `1000000`; the leaf root tile has `geometricError: 0` and
`refine: "ADD"`.

## Self-test

```bash
node src/cesium-app/tools/ply-to-splat-tileset.mjs --selftest
node --check src/cesium-app/tools/ply-to-splat-tileset.mjs
```

The self-test generates a temporary 1000-Gaussian RGB axis triad PLY, runs the
normal PLY-to-SPZ-to-GLB path, validates the GLB chunks and extension structure,
and decodes the embedded payload with the installed official `@adobe/spz`
backend. Cesium's browser-oriented `@spz-loader/core` bundle does not initialize
under plain Node 22, so exercising that exact decoder remains part of the live
browser check. The retained result is written to `public/splats/selftest/`.

## Follow-up browser validation

After supplying the CloudFront domain, run the converter against:

```text
https://<cf-domain>/pointcloud-tiles/ply-result/point_cloud/iteration_100/point_cloud_5.ply
```

That real file is about 61 MB and is intentionally not downloaded by this
session. The remaining validation is to load the generated `tileset.json` in
the app with its real ENU-to-ECEF transform and confirm native rendering,
orientation, color, alpha, and camera-distance sorting in a WebGL browser.
