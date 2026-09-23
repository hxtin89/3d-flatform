# Plan: cull off-screen and zero-size points in a compute pass

Written 2026-09-23 on branch `SphereFade`, after measuring the live viewer. Not started.

## Why

The viewer draws every point of every selected tile as an instanced quad: four vertices
and two triangles per point, through the vertex stage, whether or not the point lands on
screen. Culling is per tile only — a tile whose bounding box touches the frustum submits
all of its points. Frame cost was measured to track point count, not painted area
(`render-cost-tracks-point-count`), so every submitted point that produces no pixel is
pure waste.

Measured 2026-09-23 on `peru-b2-globe`, SSE 4, dome on (inner 450 m), 1500-point sample
per tile, projected through the live camera:

| View | Selected tiles | Points submitted | On screen | Zero size (dome) | Useful |
|---|---|---|---|---|---|
| Landed, near nadir, 80 m | 18 | 1.22 M | 14 % | 22 % | **14 %** |
| Same spot, tilted 40° up | 42 | 2.98 M | 30 % | 24 % | **30 %** |

Most selected tiles contribute *nothing*: their box is tall (canopy height plus the
subtree union) and clips the frustum while none of their ground points do. The `refine:
ADD` ancestors are the other half — a 2 km z0 node with 260 k points had 25 % on screen
and 82 % past the dome rim in the first view. So **70–86 % of the vertex work is
discarded by the rasteriser today.**

## What a compute pass buys

Per point, today: 4 vertex invocations + 2 triangles through setup, then nothing.
With a culling kernel: 1 compute thread per point, then 4 vertices + 2 triangles only
for survivors. At 14–30 % survivors the vertex-stage work drops to roughly
`1 + 4 × 0.14 … 1 + 4 × 0.30 = 1.6 … 2.2` per point against 4 — **1.8× to 2.5× less**,
and the triangle count drops by the same 70–86 %. Whether that is the frame time or not
depends on where the wall really is (vertex ALU, primitive setup, or something else);
that is what the spike below measures before anything is built for real.

Three more things fall out of the same kernel for free:

- **The dome's zero-size points** stop being submitted at all (today they are collapsed
  to zero-area quads, which still cost the vertex stage and primitive setup).
- **Distance thinning** becomes a per-point keep test in the kernel (every k-th point,
  or a hash threshold) instead of a prefix draw. That removes the arrival-time reorder
  (`reorderForPrefixSampling`, ~1.4 ms per tile) and its coupling to the ground-patch
  probe stride — see `tile-arrival-is-the-cost`.
- **Tiny points** — a point whose projected size falls under a threshold — can be dropped
  too, which is the per-point version of the size-derived thinning.

## What three r185 offers (verified in `node_modules/three/src`)

- `BufferGeometry.setIndirect(attr, offset)` and `IndirectStorageBufferAttribute`
  (Uint32, usage `STORAGE | INDIRECT`), consumed by `WebGPUBackend.draw` as
  `drawIndexedIndirect` — the instance count comes from the GPU buffer.
- Compute via TSL: `Fn(...).compute(count, workgroupSize)`, `renderer.compute(node)`,
  `instanceIndex`, `storage(attr, type, count)`, `atomicAdd`. Storage nodes in the
  vertex stage are `read`; `toReadOnly()` exists.
- `StorageBufferAttribute` / `StorageInstancedBufferAttribute` get `STORAGE` usage.
  **Trap:** an itemSize-3 storage attribute is padded to vec4 (+33 % memory, a CPU copy
  per upload — `WebGPUAttributeUtils.createAttribute`). Store positions as a flat float
  array (itemSize 1) and read three floats by hand.
- No `unpack4x8unorm` helper in TSL; `bitcast` exists and `wgslFn` can wrap the WGSL
  builtin. Colours stay 4 bytes as one `u32` per point.
- No WebGL path: the compute pass is WebGPU only. The current instanced path stays as
  the fallback and as the A side of the A/B.

## The design constraint that decides the architecture

Every tile shares **one node graph** — that is what removed the 5–16 ms per-tile TSL
build in September (`cloudGraphFor`, per-tile values through `onObjectUpdate`). A
per-tile storage buffer referenced from the material graph would fork the graph per
tile and bring that cost back. Attribute nodes are bound by *name* per geometry and are
safe; storage nodes are bound by *buffer identity* and are not.

Two designs respect that:

**A. Scatter into per-tile vertex buffers.** The kernel copies surviving points'
position and colour into a second, compacted per-tile vertex buffer; the draw stays an
ordinary instanced draw over `cloudPointPosition`/`cloudPointColor` attributes, so the
material graph is untouched. Cost: a second 16 B/pt buffer per tile (double GPU memory
for the cloud), 16 B/pt of write bandwidth per frame, and — the real problem — a
per-tile compute *kernel*, because the kernel's storage nodes reference that tile's
buffers. One kernel graph build per tile at arrival (a few ms, once) and one dispatch per
tile per frame.

**B. One arena, one kernel (recommended).** All resident point data lives in shared
GPU buffers — positions (12 B/pt), colours (4 B/pt), a compacted index list
(4 B/pt) and a per-point tile id (2 B/pt) — with a simple range allocator; a tile is a
range. One compute dispatch per frame over the whole arena: each thread reads its tile's
row from a small tile table (model matrix, first index, count, thinning keep, indirect
slot), tests the point, and on survival `atomicAdd`s into that tile's indirect
`instanceCount` and writes the point index into the tile's compacted range. Each tile
keeps its own tiny `IndirectStorageBufferAttribute` and quad geometry; the vertex shader
reads `arenaIndex[firstInstance + instanceIndex]` and fetches position and colour from
the arena. The material graph references three *global* buffers, so it stays **one
graph for every tile**, exactly as today.

B is the larger change because the arena takes over GPU residency from
`UnloadTilesPlugin` for the point cloud: a tile's range is freed on unload instead of
its buffer being disposed. It is also the design that makes upload cost predictable
(one `updateRanges` write into a live buffer, no buffer creation per tile) and the only
one where a frame costs one dispatch rather than sixty.

## Phases

**Phase 0 — spike, one tile, throwaway.** Before any architecture: take one loaded
tile, build a per-tile kernel (design A style, no arena) that writes a compacted index
list and the indirect instance count, draw it through `setIndirect`, and confirm the
picture is pixel-identical to the instanced draw. Then measure with `?gputime` across
the whole frame with every tile switched to the spike path vs the current path, at the
nadir and the tilted view above. This answers the only question that matters: **does
removing 70–86 % of the vertex work move GPU time by that much, or is the wall
elsewhere?** Stop here if the gain is under ~20 %.

**Phase 1 — arena and kernel (design B).** `viewer/src/threejs-test/point-arena.ts`:
range allocator over fixed-capacity `StorageBufferAttribute`s sized from
`gpuBytesTarget` (20 B/pt → ~19 M points at the 384 MB aph budget), tile table, one
compute node. `streaming.ts`: on `load-model` copy the tile into the arena instead of
building `InstancedBufferAttribute`s; on unload free the range (hook `dispose-model` and
the unload plugin's callback). `point-cloud.ts`: `positionNode` and the colour read
come from the arena through the compacted index; everything downstream (`sizeNode`,
falloff, fog, grading) is unchanged. Per-tile `IndirectStorageBufferAttribute`, reset
each frame by the kernel's first pass or a tiny clear kernel.

**Phase 2 — fold in the dome and thinning.** Kernel tests: frustum (with a margin of
the point's projected radius so edge points are not clipped early), dome radius
(`f > 0`), thinning keep (`hash(index) < keep` or stride), optional minimum projected
size. Delete the prefix reorder once thinning runs in the kernel; keep `applyThinning`'s
keep-fraction maths and the widening uniform, they are still right.

**Phase 3 — stats and switches.** A `GPU culling` toggle in the test panel (A/B against
the instanced path), `?gpucull=off` for boot-time comparison. "Points drawn" needs the
GPU count: a periodic async readback of the indirect buffers (once a second is plenty),
or the CPU estimate labelled as such. `renderer.info` draw stats will report the CPU
instance count and are wrong under indirect draws — note that on the HUD legend.

**Phase 4 — measure and decide.** `?gputime` GPU ms and frame p95/p99 (discrete
counters, not pane frame stats — `browser-pane-throttles-raf`) at nadir and tilted;
kernel time on its own; arrival cost per tile with and without the reorder; memory
before/after. Update the canopy instrument artifact with the stage result.

## Risks and open questions

- **Where the wall is.** If primitive setup or fill dominates rather than vertex ALU,
  the gain is still real (fewer triangles) but smaller than the vertex arithmetic says.
  Phase 0 exists for this.
- **Camera-static frames.** The kernel runs every frame the camera or the dome moves;
  when nothing moved it can be skipped and the last compaction reused. Cheap, do it.
- **The near-plane and behind-camera cases.** Points behind the camera project to
  nonsense; the kernel must test in clip space (`|x| ≤ w, |y| ≤ w, 0 ≤ z ≤ w`) with the
  size margin, not in NDC.
- **The ground-patch mask and `sampleGroundZ`** read the CPU position arrays off the
  carrier `Points`. They keep working; the arena only changes what the GPU holds.
- **Depth of field / render targets.** `depthOfField.render()` owns the draw; the
  compute must run before it, inside `stream.update()`, which is already before the
  render in `loop`.
- **Residency.** Under design B, `UnloadTilesPlugin`'s GPU disposal no longer applies
  to point tiles; the arena frees ranges instead. The cache floors and ceilings
  (`tile-cache-floor-finding`) are untouched — they govern CPU residency.
- **Mobile.** One dispatch over ~5–19 M points per frame is a few hundred microseconds
  on a desktop GPU; measure on the phone before shipping it on.

---

## Addendum 2026-09-23: the per-point cost is hardware instancing, and the triangle pays off only without it

Asked: would drawing each point as one triangle instead of a two-triangle quad halve the
cost? Measured by swapping every drawn tile's geometry at runtime in the live viewer
(same material, same per-point buffers, same pose; WebGPU, NVIDIA desktop, `?gputime`,
means over 250-400 frames, interleaved runs; cloud share = frame minus the same frame
with the cloud hidden, 0.30 ms; 43 tiles, 1.56 M points drawn):

| Variant | Cloud GPU ms | At zero point size | Pixels vs today |
|---|---|---|---|
| Instanced quad (today) | 1.28 | 1.16 | — |
| Instanced triangle | 1.17 (-8 %) | 1.13 | ~0.1 % rim pixels flip |
| De-instanced quad | 0.90 (-30 %) | 0.72 | identical |
| De-instanced triangle | 0.72 (-43 %) | 0.56 | identical |

What it shows:

- **Fill is ~10 % of the cloud.** Pinning every point to zero size removes all
  rasterisation and fragment shading and saves only ~0.1 ms.
- **Under instancing, the cost is per instance.** 4 vertices to 3 changed almost
  nothing. A 3- or 4-vertex instance evidently occupies a whole vertex warp, so the
  vertex stage runs at a fraction of its width whatever the vertex count.
- **Without instancing the vertex count matters again,** and the triangle then saves the
  expected quarter of the vertex work on top.
- The triangle is equilateral with inradius 0.505 (a 1 % margin over the dot), uv =
  corner + 0.5, so the round dot is unchanged. It only works with round dots on; the
  `Square` A/B keeps the quad.

**Production design: vertex pulling, not duplication.** The test duplicated each point's
attributes per corner (36 B -> 108 B per point), which is not shippable. Instead each tile
draws `3 x count` vertices, non-instanced, with no per-vertex attributes at all; the
shader derives `point = vertexIndex / 3` and `corner = vertexIndex % 3`, and fetches the
point from a per-tile data texture (RGBA32F position, RGBA8 colour: 16 B per point, the
same as today) bound through `materialReference`, the pattern that already keeps every
basemap tile on one shared graph. Verified in three r185: `textureLoad` on unfilterable
float textures, `vertexIndex` in WGSL (`vertex_index`) and GLSL (`gl_VertexID`), so the
WebGL2 fallback gets it too. Thinning becomes `drawRange = 3 x keep`.

**It composes with the compute culling above.** The culling kernel writes a compacted
point list; the draw pulls `list[vertexIndex / 3]`. Order of work:

1. Spike the vertex-pulled triangle on one tile behind a switch, verify pixels and GPU
   time at the nadir and a tilted pose. Expected ~-40 % of the cloud's GPU time here.
2. Ship it for all tiles (WebGPU and WebGL2), delete the quad path except for `Square`.
3. Then the compute culling on top, now culling a cheaper per-point cost.

**Trap found on the way:** three only re-keys a render object when `material.version`
changes. Swapping `mesh.geometry` alone keeps the old pipeline, and a geometry whose
attributes step per vertex then draws every vertex at point 0. Bump `material.needsUpdate`
and make sure the geometry cache key differs.

### What else has to change for the triangle (code survey, 2026-09-23)

An independent desktop cost analysis predicted -6 % to -8 % of the cloud for the instanced
triangle before the measurement landed; the measurement says -8 %. It put the
de-instanced triangle at -30 % to -45 %, which the measurement also matches.

Sites that depend on the quad shape, in order of risk:

- **`sampleGroundZ` (streaming.ts ~1330) breaks silently.** Its cheap reject trusts any
  `geometry.boundingSphere` with radius > 1 as a real tile bound, which relies on the
  quad's corner sphere being 0.707. A triangle's is 1.146, centred at (0, 0.25), so the
  guard accepts it and rejects tiles against their local origin; pivot-on-canopy and the
  height ruler then return null more often. Set the dot geometry's bounding sphere
  explicitly, or skip instanced / pulled geometries in the test. With vertex pulling the
  dot mesh carries no `cloudPointPosition` attribute at all, so it drops out of the walk
  and only the carrier is sampled — which also removes today's double sampling.
- **The `Square` dot-shape A/B** would draw bare triangles. Keep the quad (or a pulled
  quad) for that mode only.
- **The loader benchmark** (eagle-bench.ts ~251-278) keeps its own copy of the quad and
  prices the device tier with it. Switch it to the same primitive, from one shared
  definition, and re-check `strongMinPoints` / `strongFraction`, or the tier calibration
  no longer describes the scene.
- **Shaded-area and overdraw readouts** bill `instances × d²`, the quad's area. The
  triangle is 1.299 d²; put the factor next to the corner definition. The render bench
  should record which primitive produced a sample, since overdraw and area-per-point
  change units between them.
- Keep the counter-clockwise corner order: the material is FrontSide, and the mirrored
  order culls every point.
- Comment-only: point-cloud.ts round-dot note, config.ts pivot note and the historical
  overdraw sweep (quad units).

Mobile (tile-based GPUs, analysis only, not measured): central estimate about -20 % for
the instanced triangle, because per-primitive binning work halves and phones draw small
framebuffers. Risks: some tilers pay the 1.3× larger area in depth/stencil tests, and the
triangle makes the round-dot discard mandatory, which keeps hidden-surface removal off for
good. Measure on a phone before shipping the triangle there; vertex pulling is expected to
help phones at least as much as desktop.
