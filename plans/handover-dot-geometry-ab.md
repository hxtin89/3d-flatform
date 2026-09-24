# Handover: dot geometry A/B, arrival fix, review fixes, optimisation list

Written 2026-09-24 for the next session. The detailed record is `plans/plan-dot-geometry-ab.md`;
this page is the short version plus what is left to do.

## Where things stand

- All of this work is on **`sbb-main`**, the user's one working line (merge `5b3080d`), which the
  main folder `C:\projects\WIDE_3d-flatform` has checked out. It is **not** going into `main`:
  `main` belongs to the devs and Jan on another base. Start new work from `sbb-main` in a
  `git worktree`, because sessions share the main folder's working tree.
- The branch the work was done on, `sbb/dot-geometry-ab` (tip `750d0bb`), still exists on GitHub;
  its local label was deleted. Everything in it is in `sbb-main`.
- Defaults are unchanged: `config.ts` `lod.dotGeometry = { shape: 'quad', feed: 'instanced' }`.
  The new way of drawing is behind a switch; nothing ships differently yet.

## What we found out

- **Hardware instancing of a tiny quad is the per-point cost** of the point cloud. The vertex
  count barely matters under instancing (the triangle saves 2–6 %).
- **Vertex pulling fixes it.** Each point is one RGBA32F texel of a per-tile texture (xyz, plus
  colour as the integer `r·65536+g·256+b` in w); the vertex shader derives the point from the
  vertex index. Pixel-identical to instanced on WebGPU and WebGL2.
- **Every tile kept its whole PNTS body alive** through `tile.engineData.metadata` (~15 B per point,
  both feeds). Fixed.
- **three r185 bugs**, worked around on `sbb-main`: a geometry frees its buffers only on its first
  dispose (`geometry-dispose.ts`, reported as three.js #34646); the WebGL backend never deletes
  vertex-array objects (`vertex-arrays.ts`, fixed upstream for r187 — delete the helper then).

| Measured (hidden Browser pane, timer-driven frames) | Result |
|---|---|
| Cloud GPU time, pulled vs instanced | −74 % nadir, −67 % at a 40° tilt (quad); −77 % / −78 % (triangle) |
| Pulled triangle vs pulled quad | −12 % nadir, −33 % tilt |
| WebGL2 frame time, pulled | −32 % (quad), −45 % (triangle) |
| Tile arrival, pulled | 1.7 → 1.1 ms per 75k-point tile, level with instanced |
| CPU memory per point | pulled 47 → 16 B, instanced 31 → 16 B |

Ratios repeat across passes; absolute milliseconds need a visible window.

## What was built

- **Runtime switch** for shape (quad | triangle) and feed (instanced | pulled): panel section
  "Dot geometry (test)", URL `?dot=tri|quad` and `?feed=pull|inst`, console
  `__wild.dots.set('tri' | 'quad' | 'pulled' | 'instanced', ...)` and `__wild.dots.state`
  (tiles per mode, CPU bytes per point). Square dots always draw quads (decided, keep it).
- **Files:** `dot-geometry.ts` (shapes, pulled geometry, shared quad index, texture helpers),
  `point-order.ts` (prefix-sampling reorder; the fused reorder-and-pack for the pulled feed;
  carrier adopt/restore), `point-cloud.ts` (`CloudPointsMaterial`, `PointDataReference`, the
  pulled branch of `cloudGraphFor`), `streaming.ts` (`buildPointQuads`, `applyDotMode`,
  `setDotMode`), tests in `dot-geometry.test.ts` and `point-order.test.ts`
  (`npm run bench:verify` in `viewer/`).
- **Arrival fix:** the pulled feed packs its texture in the same pass as the reorder, and the
  tile's carrier `Points` keeps a four-float view of the texture array instead of its own copy.
  A switch back to instanced unpacks it first.
- **Review fixes:** no leftover texture or geometry after a feed switch; evicted tiles leave the
  ground-patch mask queue and the reveal queue; the shared quad index is built outside the first
  tile's arrival and booked separately by the upload probe (`__cost.report().uploads.shared*`);
  readouts report what is actually drawn.

## How to measure (hard-won)

- The Browser pane is usually hidden, which pauses rAF, so the app never boots. Boot through a
  same-origin 404 page and `document.write` the HTML with a `setTimeout` rAF stand-in and
  `document.hidden = false` injected before any module runs (memory: browser-pane-throttles-raf).
  The tool call times out at 45 s; long runs keep going in the page, so poll a window global.
- Pin the tier with `?preset=strong` and compare cold boots only within one session.
- Renderer: `__three.renderer` (and `__three.scene`, `__three.camera`).
- **Pixel identity:** stop the loop (`renderer._animation.stop()`), render once per arm with
  `renderer.render(scene, camera)`, `drawImage` the canvas in the same task, diff, restart.
- **GPU time:** `?gputime`. The `#gpuMs` HUD lags a switch by 14+ frames, so wrap
  `renderer.backend.timestampQueryPool.render._resolveQueries` to collect per-frame durations
  tagged by frame number, and discard frames before the switch settled. Per-frame times are
  bimodal in the pane (another GPU client); use means over 300+ frames, arms interleaved
  ABCD DCBA, cloud share = arm minus the frame with the cloud hidden.
- Turn the rain cycle off before any visual or frame A/B (it shimmers the whole cloud).
- The unload plugin frees hidden tiles only above its GPU `bytesTarget`; force pressure to test
  re-uploads.
- To split one file's edits across commits, build the staged content yourself
  (`git hash-object -w` + `git update-index --cacheinfo`); `git apply --unidiff-zero` misplaces
  insertions silently. Check each commit in a throwaway worktree.

## Still open, in order

1. **Confirm on real devices.** Re-run the protocol in `plan-dot-geometry-ab.md` in a visible,
   focused Chrome window with unquantised timestamps, plus the horizon pose, zero point size and
   thinning off; then one Android and one Apple phone over https.
2. **The user's look at the triangle dot edges**, then decide quad or triangle and whether the
   pulled feed becomes the default. If it does, see "pulled-feed launch bundle" in the list
   below (quad index sizing, eagle loader benchmark recalibration).
3. **Quick wins from the optimisation list** (appendix, section 1). Top five: compute tile bounds
   in the arrival pass; compile out the mask dissolve, fovea bend and debug palette by default;
   sample ground heights once per tile (with `probeMinSamples` halved); build tiles in high
   precision from boot (`!bootLoading` in the precision condition, main.ts); stop redrawing the
   hidden scene behind the loader. None of them is done on `sbb-main` yet.
4. **Thinning off or pre-ordered packs:** the pulled feed still costs ~0.4 ms more per tile there
   (one-round pack against the instanced zero-copy). Only a worker or a layout shipped by the
   pipeline goes below that.
5. **Upstream:** on the three r187 upgrade delete `vertex-arrays.ts` and its call sites; drop
   `geometry-dispose.ts` once three.js #34646 is fixed in a release.
6. `plans/plan-gpu-point-culling.md`: redo its gain estimate against the pulled feed before
   building it.

Memory files with the details: instancing-is-the-per-point-cost, browser-pane-throttles-raf,
partial-staging-trap, unload-plugin-needs-budget-pressure, webgl-vao-leak, geometry-dispose-leak,
square-dots-force-quads, rain-cycle-fakes-flicker, sbb-main-branch, merge-plan-pending.

---

## Appendix: ranked optimisation list (sweep of 2026-09-23)

Five subsystem reviewers, a skeptic per subsystem, then a ranking. File and line references are
against `750d0bb`; `sbb-main` has moved some code since (for example `forgetOnDispose` became
`releaseVertexArraysOnDispose`), so re-find the lines before editing.


Items are ranked by corrected gain divided by effort. The reference scenes are nadir 80 m (~1.9 M drawn points), 40° tilt (~3.5 M) and flights with many tile arrivals. Every gain below is the skeptic's corrected figure.

Claims the ranking pass checked in the code:
- streaming.ts:719 and :741 null the carrier sphere, and :1817 computes it lazily.
- streaming.ts:1462-1506: sampleGroundZ reads dot meshes with no bound, then sorts with a JS comparator.
- main.ts:3807 has `!bootLoading` in the precision condition.
- point-cloud.ts:924 puts the precision flag in the graph key.
- point-cloud.ts:994, :1081 and :1201: localUp is computed per vertex, and the mask keep and debug mix are always compiled. maskMode defaults to 0 (config.ts:821).
- main.ts:4461 and :4937 draw every boot frame.
- ground-patch-mask.ts:236-244 allocates 16 MiB and uploads all of it.
- The bench thresholds (948a496, 2026-07-21) are older than the POV preload (8850246, 2026-09-18).

### 1. Quick wins (effort S)

#### 1.1 Compute carrier bounds in the arrival pass (merges 3 proposals)
- **Change:**
  - Track min/max xyz inside `reorderForPrefixSampling` and `packPointsForPulling` (point-order.ts:117-216), then run one tight radius pass over the output.
  - In `buildPointQuads`, set `boundingBox` and `boundingSphere` where streaming.ts:719 and :741 write null today.
  - Pre-ordered or declined instanced layouts (the padColourForGpu path, streaming.ts:655-686) need a standalone tight pass.
  - Keep the lazy guards (1479, 1817, 1918) as fallback.
- **Gain:**
  - Main thread per tile: −0.45 to −0.95 ms at 75k, −1.0 to −2.0 ms at 150k, about −1.7 to −2.3 ms for the 270k overview tile.
  - About −1 to −1.9 ms in a frame with 2 arrivals (maxParses 2).
  - In total ~13-24 ms (nadir set) and ~24-42 ms (tilt set) come off the tiles' first visible frames.
  - Both feeds; no GPU change.
- **Cost:** +0.1-0.2 ms inside the arrival timer, which __cost then shows. Render-gated tiles that are never revealed pay +0.2 ms that they skip today.
- **Risk:** nothing visible. The centre is identical, so thinning keep values do not change. An exact radius keeps sampleGroundZ and shadedPixelArea identical. The half-diagonal saves ~0.05 ms more but loosens those conservative tests.
- **Measure:**
  - computeBoundingSphere calls on carriers during a drag should drop to 0.
  - Frame p95/p99 and worst frames over a drag at nadir and tilt40.
  - Arrival p50 should rise by 0.1-0.2 ms.
  - A node test that the fused box and sphere equal three's for all 3 colour layouts.
  - Frozen-frame pixel diff 0.
- **Deps:** none. It is required by 2.3 and supplies the tile box for 3.1 and 3.6.

#### 1.2 Compile out per-point terms that do nothing by default; hoist per-tile constants
- **Change:**
  - Add three effect flags, flipped from their setters the way syncDebugIsolateEffect does it (main.ts:3240-3256):
    - `maskDissolve`, on only while maskMode is 2. When off, keep = sphereFade and applyMaskSurround is dropped, in the globe graph too.
    - `foveaBend`, on only while foveation is enabled. When off, requestedPx = sizeRequestedPx.
    - `debugPalette`, on only while debugMode > 0.
  - Separately, add two per-tile onObjectUpdate values: `tileLocalUp` (replaces the transformDirection at point-cloud.ts:994) and a float64 `tileToEnu` mat4 (replaces enuInverse × modelWorldMatrix at 987-988).
- **Gain:**
  - Pulled triangle: −0.05 to −0.13 ms at nadir, −0.10 to −0.26 ms at tilt40.
  - The instanced default probably gains more (unmeasured). This is the only GPU item that helps the shipping default.
  - The tileDebugInfo and tileDebugTint per-object uniforms also leave the default graph.
- **Risk:**
  - The compile-outs are pixel-identical, allowing 1 ulp on the mix.
  - A flag must turn on before its feature is used.
  - The two hoisted constants flip scattered pixels through float32 rounding, like the precision toggle. Put them in a separate commit with their own gate.
  - Each flag flip rebuilds the materials once, and flips only come from the UI.
- **Measure:** runtime A/B through setCloudEffectEnabled + refreshEffects; ?gputime cloud share at nadir and tilt40 on both feeds; pixel diff 0 for the compile-outs; WGSL instruction counts.
- **Deps:** none. Required by 3.5.

#### 1.3 sampleGroundZ: carriers only, corner-safe reject, quickselect (merges 2)
- **Change (streaming.ts:1454-1506):**
  - Add `if (isDotMesh(object)) return` in the traverse.
  - Widen the carrier reject at 1485 to `radiusM * Math.SQRT2 + bounds.radius`.
  - Replace the `number[]` and comparator sort (1447, 1506) with a reused Float64Array and a quickselect for the two percentiles.
  - Lower probeMinSamples from 400 to 200 (config.ts:599).
  - Leave out the tile-volume reject from the frame-cpu version; it adds about 0.
- **Gain:** these are hitches, not a per-frame cost.
  - Per call at tilt: ~6 → ~1 ms at r20, 27 → 2.3 ms at r180.
  - Rotate-press hitch: 9-18 ms → 1.5-2.6 ms.
  - Donation probe: ~12 → ~1.2 ms every 500 ms until it locks. That is mostly behind the loader, where the eagle is timing frames.
  - Debug ruler: ~20 → ~2 ms, twice a second.
- **Risk:**
  - Both percentiles stay the same (floor(floor(2nf)/2) = floor(nf)), provided all edits land together.
  - Tiles whose centre is between r+R and r√2+R from the probe change weight slightly: their corner points count once today while everything else counts twice.
  - So compare against the old code with the widened reject, or with a 0.1 m tolerance.
- **Measure:** performance.now() per canopyPivot and runProbe call at sf-tilt and the landing; old vs new groundZ and canopyZ on a grid of centres and radii.
- **Deps:** none. Pairs with 1.1: the first probe after gated arrivals stops paying ~0.8 ms per carrier sphere.

#### 1.4 Build tiles in high precision from boot (merges 2)
- **Change:** drop `!bootLoading` from main.ts:3807 and fix the stale comment at 3772-3778. Optionally drop the precision flag from the graph key at point-cloud.ts:924; the graph body never reads it.
- **Gain:**
  - Removes a one-off hitch of 10-35 ms about 1.2 s into the entrance flight, the showcase moment.
  - That hitch is probably two TSL builds (5.4 ms median, 16.2 ms worst each), one pipeline and ~25-60 render-object recreations.
  - It is larger on WebGL2 and phones.
  - The cost is microseconds per frame behind the loader.
- **Risk:** nothing visible. The basemap already runs HIGH_PRECISION_CONTEXT all the time.
- **Measure:** programCounts nodeBuilds and pipelines, and __cost frames max, across the loader fade. Expect +1-2 builds before and 0 after.
- **Deps:** do it with 1.7, so the warm-up compiles the variant that is actually used.

#### 1.5 Build the near volumetric-cloud material once; keep mode resources alive
- **Change (environment-layer.ts:347-502):**
  - One near material, with each cloud's opacity supplied per object through onObjectUpdate. The uniform must stay in objectGroup.
  - setMode toggles group.visible of the soft and volume sets instead of disposing and rebuilding.
  - Optional: compileAsync behind the loader.
- **Gain:** strong tier only. 4 fewer TSL builds (est. 20-60 ms), probably in the entrance flight's first frames. 0 builds instead of up to 6 on each guard promotion (at most 2 per session). No GPU change at the reference scenes.
- **Measure:** NodeBuilder.build count and frame time when the near clouds first enter the view. Force a promotion with applyMeasuredTier('balanced') and then 'strong'.

#### 1.6 Parrot flock: shared skeleton, 30 Hz mixers, freeze off-screen
- **Change (field-model-layer.ts:235-413):** bind each bird's 3 SkinnedMeshes to one skeleton (inverse-bind matrices verified identical); run mixer.update at 30 Hz with accumulated dt; skip the mixers while the flock is outside the frustum.
- **Gain:** ~0.15-0.2 ms average main thread per frame during passes (~80 % of daylight time) on strong with 12 birds, about a third of that on constrained. Bone uploads drop from 36 to 12 per frame.
- **Risk:** stepped wing beats are unlikely at 650-2800 m. Every other frame still pays the full 0.3 ms mixer cost.
- **Measure:** performance.now() around fieldModelLayer.update over 600 frames during a pass.

#### 1.7 Stop drawing the hidden scene behind the opaque loader, and idle the eagle bench (merges 4)
- **Change:**
  - In loop() (main.ts:4461), while `bootLoading && loaderFinishAt === 0`, keep every update but render only on frames after a point or globe load-model, plus a heartbeat (every ~8th frame or ~500 ms).
  - With DoF off, the warm-up can be `renderer.compileAsync(scene, camera)`.
  - In eagle-bench tick(): once progress ≥ 1, bucket 12 holds ≥ 120 samples and totalSamples ≥ minSamples, set instanceCount to 0, render once and stop requesting frames.
- **Gain:** loader phase only; nothing changes after Start.
  - Removes ~60-85 % of hidden draws while loading, and all but the heartbeat on the ready screen.
  - Each skipped draw is ~2-5 ms GPU on instanced (1-1.5 ms pulled) plus ~1-2 ms of submit.
  - The bench's 2.5 M-quad stress stops on the ready screen (est. 2-4 ms GPU).
  - Main value: power and heat, and a tier bench that stops timing a 1.5-3 M-point hidden dome it was never calibrated for.
  - Bucket 12 is the only route to 'strong', and today it fills exactly while the hidden dome is heaviest.
- **Risk:**
  - Tiers shift upward on some devices. Run a 10-boot A/B per device class and re-check the thresholds before shipping; the landing view is arguably relevant load.
  - Keep the arrival-triggered warm-up renders, or uploads and pipeline compiles move to the reveal.
- **Measure:** eagle result (pointsAtTarget, preset) over 10 cold boots per arm, desktop and phone; __cost uploads worstFrameMs and frames max in the first second after the fade; time to loaderReadyShown.
- **Deps:** do it before 2.4, and together with 1.4.

#### 1.8 Close basemap ImageBitmaps after their first upload; drop the globe's UnloadTilesPlugin
- **Change:** in the globe's load-model handler, set `map.onUpdate = t => { t.image?.close?.(); t.onUpdate = null }`. Remove the UnloadTilesPlugin (globe.ts:190), and point setMemoryBudget, getMemoryBudget and stats().gpuBytes at the tile cache.
- **Gain:**
  - About −95 to −100 MiB of renderer memory at a settled view (1 MiB per 512² tile in use), more during pans.
  - GPU memory at rest is unchanged. Transient GPU peaks rise by +32/+64/+96 MiB (constrained/medium/strong) above today's targets.
  - The basemap stops hitting the r185 dispose-once leak.
- **Risk:** a stray re-upload fails silently as a black tile, because three swallows the copy error. Test on WebGL2 and Safari.
- **Measure:** tab memory at the same pose; the count of live bitmaps (map.image.width > 0) should drop to 0; pan for several minutes with no black tiles.

#### 1.9 Take the cloud-noise bake off the boot critical path
- **Change (cloud-noise.ts:75-111, main.ts:4500-4509):** write 0 and skip fbm/worley where the envelope is 0 (byte-identical output, verified); start fetchGlobeManifest before the bake; optionally bake in a module worker.
- **Gain:** 0.1-0.17 s on desktop and 0.3-0.5 s on phones at 64³; 0.3-0.4 s at 96³ (strong tier). The worker variant also removes a 0.1-0.6 s freeze of the loader eagle.
- **Measure:** performance.mark for bake → manifest → first load-model; loaderReadyShown over 5 cold loads.

#### 1.10 Ground-patch mask: upload one layer and size it by config
- **Change:** call `texture.addLayerUpdate(0)` before the first upload (ground-patch-mask.ts:244). Lower `maskMaxCells` (config.ts:907) to the cells-used figure from the `[ground-patch]` console report, plus a margin. Skip the manifest-driven sizing code: it carries construction-order risk and gives the same result.
- **Gain:** a one-time ~16 MiB upload (5-40 ms) behind the loader. For the session on Peru, −8.5 MiB GPU and −8.5 MiB heap (at most 30 of 64 layers). Matters for phone memory only.
- **Risk:** a larger survey hits the existing "budget runs out" warning.

#### 1.11 Per-frame bookkeeping cleanup
- **Change:**
  - Sort stats() levels with a module-level `new Intl.Collator(undefined, { numeric: true }).compare` (streaming.ts:1557).
  - Guard `lruCache.unloadUnusedContent` so it runs only when cachedBytes > minBytesSize + ~2 MiB, when isFull(), or when the item count is above minSize.
  - While the HUD is closed, skip updateHud's shadedPixelArea and string building. Keep stats(), because it feeds the loader.
- **Gain:** ~0.03-0.1 ms of JS per frame on desktop (Collator ~45 µs, LRU ~8-10 µs settled, up to ~0.1 ms while orbiting); probably 3-4× on phones (unmeasured). No stutter effect. Worth doing only because each part is a few lines.

### 2. Bigger projects worth planning

#### 2.1 Parse PNTS without copying the feature table
- **Change:** patch `PNTSLoaderBase.prototype.parse` so FeatureTable and BatchTable are built on the fetched buffer with offsets, instead of `buffer.slice` (PNTSLoaderBase.js:59-72). Import it from '3d-tiles-renderer'; it is the same class as core (build/index.js). Fall back to the original parse in a try/catch.
- **Gain:** in the arrival frame, −0.23 ms per 75k tile, −0.25 ms per 150k, about −0.6 ms for 270k. −1.1 to −4 MB of transient garbage per tile, about −100 MB per 90-arrival drag.
- **Effort:** M. The code is small, but it is a library patch to re-check on every upgrade.
- **Risk:** nothing visible; view alignment is unchanged (the header is 28 bytes).
- **Measure:** parseTile time per tile size; an allocation timeline over one drag.
- **Deps:** independent; complements 1.1. If 3.2 is built, the worker transfers this buffer instead.

#### 2.2 Skip traversal, per-tile passes and control raycasts on still frames
- **Change:**
  - A small plugin through `doTilesNeedUpdate` (TilesRendererBase.js:876-900), plus explicit dirty flags for:
    - camera matrices, errorTarget, the mask and render spheres, the POV eye and the origin;
    - load, dispose and visibility events, and idle queues;
    - converged thinning and spacing ramps;
    - an empty pendingReveal and ground-patch queue.
  - Keep the pendingReveal/applyRenderGate tail running every frame.
  - Set `controls.adjustHeight = false` while the camera and basemap are static (globe.ts:532).
  - Cache solvePovRadius.
  - Force an update every ~30 frames as a safety net.
- **Gain:** still frames only: ~0.25-0.4 ms CPU on desktop, ~1 ms on phones. No GPU or stutter effect; the value is power and headroom.
- **Effort:** M.
- **Risk:** a wrong dirty set stalls loading or freezes a ramp, so unit-test the gate.
- **Measure:** spans around updateStreaming and globe.update at still nadir and tilt poses and during a pan; stats() must match an ungated run.

#### 2.3 Single-copy point tiles (pulled feed)
- **Change:**
  - Wait for two events: the texture's first upload (`texture.onUpdate`, Textures.js:365) and a new ground-patch `onTileDone`.
  - Then replace the carrier view with a prefix copy of at most 6000 points, and empty `texture.image.data`.
  - Unregister the cloud's UnloadTilesPlugin, so the tile LRU bounds GPU memory.
  - Gate it off during the runtime feed A/B, or call reloadTiles on a cross-feed switch.
- **Gain:**
  - −16 B per point of CPU memory for tiles that have been drawn: −30 MB at nadir, −56 MB at tilt.
  - At the resting cache floor: ~−200 to −250 MiB on strong, ~−150 to −185 on medium, ~−95 to −115 on constrained.
  - Less than that for tiles that are loaded but never drawn (POV preload behind the camera, dome shell).
  - GPU at rest rises by +8 to +29 MiB, and transient peaks follow the cache ceiling. No ms gain.
- **Effort:** L.
- **Risk and prerequisites:**
  - The texture must never be re-uploaded, and the runtime A/B has to be gated.
  - arrival-cost.ts:165 reads image.data.byteLength after onUpdate; fix it before measuring.
  - HUD gpuBytes and setMemoryBudget need rewiring.
- **Deps:** the pulled feed shipping, and 1.1.

#### 2.4 Pulled-feed launch bundle (do it together with the switch)
- **Quad index:**
  - If the triangle ships, delete prepareSharedQuadIndex and the index: −12.6 MB CPU and −12.6 MB GPU.
  - If the quad ships, use a fixed floor of 327 680 points: 7.86 MB, −4.7 MB on each side, and the one-off fill drops from 2-4 ms to 1.2-2.5 ms.
  - Dispose it explicitly through three when the quad is left. Dropping the module reference frees nothing, because the dispose override at dot-geometry.ts:429-436 keeps it alive.
  - Effort S.
- **Eagle bench primitive:**
  - Either stress the shipped feed and shape, or keep the instanced stress and rescale the thresholds by the measured instanced/pulled ratio.
  - Rescaling is cheaper: a true pulled stress needs a 16 B/pt texture, ~120-240 MB on desktop at matched cost.
  - No frame gain; it keeps mid-range devices from being rated 'medium' once pulled is the default.
  - Effort M; do it after 1.7.

### 3. Worth measuring first

#### 3.1 Culling below tile level on the pulled feed (merges the Morton-chunk and big-tile-chunk proposals)
- **Gate (step 0, no renderer change):**
  - Extend the 1500-sample projection instrument to bin samples into each tile's 4×4 Morton cells.
  - Report the share of submitted points in chunks with no useful sample: exact, after merging to 1 run, and after merging to at most 4 runs.
  - Also report the share in tiles whose tight content box misses the frustum. That is a cheap per-tile variant that works on both feeds, using 1.1's box.
  - Go ahead only if the cut is at least 40 % at nadir.
- **Variant (a): 16 Morton chunks per tile**, a per-frame AABB test against the frustum and the inner sphere, and a vertex-index remap fed by at least 3 vec4 onObjectUpdate uniforms.
  - Pulled triangle: −0.15 to −0.28 ms at nadir, −0.25 to −0.35 ms at tilt40.
  - ~30 extra ALU ops per vertex (a u32 divide).
  - Arrival per 75k tile: +0.14 ms with contiguous source ranges (compactness unmeasured) or +0.63 ms with the Morton sort. This is not offset by the bounds saving, which 1.1 already delivers.
- **Variant (b): one Mesh per chunk for tiles of 250 m or more.** −0.05 to −0.15 ms, +6-33 draws, +0.5 ms per big-tile arrival.
- **Effort:** L. Pulled feed only, because r185 always uses firstInstance 0.
- **Risk:**
  - The chunk test must fold into the gate/thinning order: applyRenderGate rewrites visible every frame, and applyThinning skips invisible meshes.
  - Padding copies must stay out of the carrier views.
  - The ground-patch mask's prefix walk and count/64 probe must change in the same step.
  - (b) needs 1.3 first, or each big carrier is sampled 16 times. It also needs a fair-order fix for switching back to instanced.
  - A pixel diff of 0 is the gate.
- **Deps:** the pulled feed shipping. Complements plan-gpu-point-culling.md: it works on WebGL2 and phones and needs no global arena.

#### 3.2 Move the PNTS reorder/pack into a worker (processTileModel)
- **Gate:** with pulled on, in a visible window, run __cost.report() over a pan and check whether arrival frames now lead p95/p99. On the instanced default the 2026-09-17 ruling (GPU-bound tail) still stands.
- **Gain if they do:**
  - Main thread per tile: ~0.6 ms at 75k (~0.8 ms with bounds), ~2.5 ms at 270k.
  - At most 1.2-1.6 ms per streaming frame on desktop.
  - Phones are unmeasured, and they are the actual reason to reopen this.
- **Effort:** M.
- **Risk:** transferring detaches the views, so a declined tile loses its fallback; replies for evicted or aborted tiles must be dropped; the worker must bundle under /livingdashboard/.
- **Deps:** after 1.1 and 2.1. It replaces the deferred-preparation idea (dropped below).

#### 3.3 Ground-patch feather taps
- **Gate:** toggle the groundPatch effect, which compiles the taps out, at h80-nadir, h80-p50, h250-p45 and h1000-p45 with 900-frame means, on desktop and a phone.
- **Upper bound:** 0.05-0.2 ms on desktop (the whole non-cloud frame is 0.30 ms); at most 0.2-0.6 ms on phones at the capped pixel ratio.
- **Cheap option (S):**
  - Compute the dome factor first and wrap the taps in If(fade > 0), with `.level(0)` samples.
  - Read the cell index once when the disc stays inside one cell (~93 % of fragments).
  - Pixel-identical. It gains nothing at the 80 m scenes, ~0.05-0.1 ms at 250 m and ~0.2-0.4 ms at 1 km.
- **Bigger option (M):**
  - A pre-blurred mask per cell: 1 index read plus 1 bilinear read per fragment.
  - Only if the phone A/B shows ≥ 0.5 ms.
  - The blur must run off the main thread (3-6 ms of JS per cell, plus the neighbours' aprons). Not bit-identical.

#### 3.4 Drop three's HalfFloat output target and colour pass
- **Gate:** a one-line A/B of `renderer.outputColorSpace = THREE.LinearSRGBColorSpace` at h80-nadir and h250-p45. The colours are wrong, but the cost difference is real.
- **Gain:** ~0.05-0.15 ms GPU on desktop (~0.2-0.3 ms at 4K) and 26-39 MB of VRAM; negligible on phones.
- **Effort:** L. Every material needs an in-shader sRGB encode, and transparent layers blend differently, which is a visible change. Build only if the A/B shows ≥ 0.1 ms.

#### 3.5 Move the colour graph into a flat varying (pulled graph only)
- **Change:** build graded → fog → surround in the vertex stage as a flat varying, with the ENU position from tileToEnu (after 1.2). Never on the instanced graph, where it is a net +0.1-0.25 ms regression.
- **Gain:** −0.02 to −0.05 ms at nadir, −0.04 to −0.09 ms at tilt40 (3-7 % of the pulled cloud); more with ground fog or cloud shadows on.
- **Effort:** S. Measure it, because the ~40 extra vertex ops can eat the saving. Pixel diff ≤ 1 LSB.

#### 3.6 Quantised pulled point layout (8 B RG32UI, or 12 B RG32UI + R32UI)
- **Gain:** VRAM only.
  - −4 B per point (12 B layout) or −8 B per point (8 B layout): −7.6 to −15 MB at nadir, −14 to −28 MB at tilt.
  - GPU time ~0 on desktop, possibly worse.
  - No cache-capacity gain, because tile bytes are frozen at parse.
  - Arrival +0.05-0.25 ms against 1.1.
- **Effort:** M-L.
- **Risk:** not pixel-identical; every CPU reader must dequantise; it conflicts with 2.3 and with the pixel-identical A/B.
- **When:** only if phones still show VRAM pressure after 2.3.

#### 3.7 Stop refining basemap imagery under a fully opaque ground patch
- **Gain:**
  - About 10-20 fewer z19 loads per 80 m landing: ~12 of 16 at nadir, 16-20 of 32 at p40-p50.
  - ~10-20 MB of basemap memory and ~9-16 % fewer MapTiler requests, which matters for the quota.
  - z18 loads are unchanged. Less than 0.1 ms CPU, and about 0 at a tilt while panning.
- **Effort:** M.
- **Measure first:** today's MapTiler requests per landing, and how many z19 tiles lie wholly inside the 270 m plateau and the mask coverage.

#### 3.8 Label layout thrash on Android
- **Problem:** marker-layer.ts:373-387 and donation-shape-layer.ts:662-680 read window.innerWidth between hidden and transform writes. On Android that can force several style recalcs per frame.
- **Next step:** trace a phone first. The fix is to read the viewport once per frame and write only on change.

### Dropped
- **Deferring preparation of render-gated arrivals:** about 0 % of arrivals are gated at nadir and ~23 % at tilt. It mostly moves the work into reveal frames, and it adds a new 10-15 ms worst case on a dome snap or gate-off.
- **The tile-volume reject in sampleGroundZ** (step 2 of the frame-cpu version): adds about 0.
- **Manifest-driven mask sizing code:** the config change in 1.10 saves as much or more.
- **Most of the HUD DOM-churn items:** Blink skips same-value writes, and the HUD is display:none on phones. Only the parts in 1.11 survive.
- **"8-byte quantisation doubles cache capacity":** false, because 3d-tiles-renderer caches a tile's bytes at parse.