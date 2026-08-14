---
name: ground-coverage-mask
description: Bake the point cloud's ground coverage mask in the pipeline instead of deriving it in the browser. Use for the ground patch under the point cloud, `pipeline/build_ground_mask.py`, `pipeline/ground-mask.sh`, the per-area `mask/` sidecar, distance-field masks, or changes to `viewer/src/threejs-test/ground-patch-mask.ts`.
---

# Ground coverage mask, baked

Status: **design sketch, not built.** Nothing here has been run — there is no
`local-storage/` in this checkout, so the builder below is unverified against real
data. The viewer side on branch `sbb/ground-patch-mask` is the working reference.

## Why move it out of the browser

The runtime version answers one question per 5 m of ground — *does the cloud have data
here* — by splatting the points of every tile the renderer loads. It works, and it is
measured: ~50 ns per point, a 20k point per frame budget so it never costs more than
about 1 ms, 62 ms of CPU over a cold load, uploads batched per changed cell.

But every device pays it, every session, to recompute the same answer. And it carries
three consequences that no amount of tuning removes:

| | runtime | baked |
|---|---|---|
| CPU per session | 62 ms, spread over ~125 frames | none |
| memory | 16.8 MB CPU **and** 16.8 MB GPU | GPU only |
| complete at first frame | no — fills over ~2 s, then keeps growing | yes |
| exact | no — 13 jittered taps approximate a disc | yes — offline EDT |
| coverage where the camera never looked | absent | present |

The memory line is the one that matters most on a phone. The CPU copy exists only
because the browser is the thing doing the writing; a baked mask is uploaded once and
the typed array can be released.

The completeness line is the one that matters most for looks. Today a region you have
not visited has no coverage, so the patch is missing there. It is self-consistent —
there is no cloud there either — but it means the mask is never finished, and it is why
the same view can look different depending on how you arrived at it.

## What to bake

**A distance field, not a coverage bitmap.** Store, per pixel, the distance to the
nearest pixel *without* data, in metres, clamped and quantised into one byte.

That single decision replaces the whole blur-and-threshold apparatus in the shader:

```
coverage = smoothstep(threshold - fade/2, threshold + fade/2, distanceAtPixel)
```

with `threshold` and `fade` in metres, one texture read, and no disc. It removes the
limits the runtime version cannot escape:

- erosion at any distance, not capped by a sampling radius
- a fade of any width, independent of the erosion
- gaps preserved exactly at any setting — a blur wider than the river closes over it,
  a distance field never can
- 1 texture tap per fragment instead of 13, on the basemap where 13 were measured

Quantisation: 2 m per unit gives 0–510 m of range in a byte, which is far past any
useful erosion. 0 means "no data here".

## Format

One PNG per lattice cell, plus a manifest, as a sidecar next to the tileset:

```text
<dataset>/mask/
  manifest.json
  c0006_r0004.png        512 x 512, 8-bit grey, distance in 2 m units
  c0006_r0005.png
  …
```

`manifest.json` carries exactly what the viewer's lattice already needs, so the shader
does not change shape:

```json
{
  "version": 1,
  "metresPerPixel": 5,
  "cellPx": 512,
  "cellSizeM": 2560,
  "distanceUnitM": 2,
  "originEnu": [-10240, -7680],
  "enuOriginLonLat": [-69.507452, -12.851687, 54.295],
  "cells": [{ "col": 6, "row": 4, "file": "c0006_r0004.png" }]
}
```

Two properties to keep:

**Cells sit on a global lattice anchored at the ENU origin**, not on the dataset's
bounding box — `col = floor(enuX / cellSizeM)`. New survey area adds cells around the
existing ones instead of renumbering them, so a re-bake of a grown dataset leaves old
cell files byte-identical and CDN-cached.

**Only occupied cells are listed.** The footprint is a diagonal strip; most of its
bounding box has no data and costs nothing.

Size, measured by exporting six real cells from the running runtime mask, computing the
EDT offline and PNG-ing the result:

| | 6 cells | extrapolated to Peru's 17 |
|---|---|---|
| raw | 1.6 MB | 4.5 MB |
| coverage, 1-bit PNG | 29 kB | 82 kB |
| distance field, 8-bit PNG | 147 kB | **~420 kB** |

Per cell the distance field runs 0.4–52 kB depending on how much of it has data. The
distance field costs about 5x the bitmap and is worth every byte — it is what removes
the shader's 13 taps and the fade ceiling. ~420 kB is small enough that streaming is
pointless: fetch all listed cells at load.

## Which LOD to bake from

The **source COPC**, not the tileset. The bake has no frame budget, so it should use the
densest data available rather than whatever the renderer happens to load. Read at a
fixed decimation that guarantees several returns per 5 m pixel — the runtime version
measured a median of 12 points per 25 m² cell at the overview level alone, so even
heavy decimation is ample.

One thing the runtime version got wrong and the bake must not repeat: **do not grow each
point into a 3x3 block.** One lidar return then claims 225 m², and scattered returns off
water — wet sand, driftwood, the surface itself — make the river read as solid ground.
Mark the pixel the point falls in, nothing more. The EDT provides all the smoothing.

## Builder

`pipeline/build_ground_mask.py`, wrapped by `pipeline/ground-mask.sh`, following
`area_manifest.py` / `area-manifest.sh`. Stages:

1. read the area manifest for `rootTransform` and `enuOriginLonLat`
2. stream points through PDAL, transform to ENU, mark cells on the global lattice
3. exact Euclidean distance transform per cell **with a one-cell apron**, so distances
   are correct across cell seams rather than restarting at every border
4. quantise, write PNGs, write the manifest

Step 3 is the one to get right. The apron is why this belongs offline: the runtime
version cannot afford neighbour reads, which is exactly why it approximates with a disc.

## Viewer changes

Contained, because the lattice and both textures already exist:

- `ground-patch-mask.ts` loses the splat path, `addTile`, the per-frame budget, the
  redundancy probe and the upload throttle. It gains a fetch of `mask/manifest.json`
  and the listed PNGs into the same `DataArrayTexture` and index map.
- `streaming.ts` loses the `onPointTile` hook.
- `applyGroundPatch` in `point-cloud.ts` drops the 13 taps and the jitter, and reads
  distance directly. `groundPatchBlurM` and `groundPatchThreshold` become
  `groundPatchThresholdM` and `groundPatchFadeM`, both in metres.
- the CPU typed arrays can be dropped after upload.

Keep a fallback: if `mask/manifest.json` is absent, the patch stays off. Datasets baked
before this exists then behave as they do today rather than breaking.

## Open questions

- **Where in `all.sh`.** The bake needs the area manifest and the COPC, so it slots
  after `area-manifest` and can run in parallel with the tileset builds.
- **Sub-pixel gaps.** At 5 m per pixel a 3 m footpath is not representable. If those
  matter, the lattice resolution is the knob, and PNG keeps the cost sublinear.
- **Water vs no-flight-line.** Both read as "no data" and the mask cannot distinguish
  them. The missing survey strip is currently *wanted* as basemap, so this is fine
  today, but a re-flight would want the strip filled and the river still open — which
  needs a second input, not a better mask.
