# Plan: dot geometry A/B — quad or triangle, instanced or vertex-pulled

Branch `sbb/dot-geometry-ab`, off `SphereFade` at f84d92c. Written 2026-09-23. Steps 1 and 2
built and verified on 2026-09-23; results under "Step 2 results" below. Open: the arrival
cost, and the protocol's visible-window and phone runs.

## Why

Measured 2026-09-23 by swapping geometries at runtime in the live viewer (same pose,
43 tiles, 1.56 M drawn points, GPU timestamps, cloud share):

| Arm | Cloud GPU ms | At zero point size |
|---|---|---|
| instanced quad (today) | 1.28 | 1.16 |
| instanced triangle | 1.17 | 1.13 |
| non-instanced quad | 0.90 | 0.72 |
| non-instanced triangle | 0.72 | 0.56 |

Under instancing the cost is per instance, so the triangle barely helps; without
instancing both the de-instancing and the triangle pay. But the non-instanced arms were
built by copying every point's data to each corner (3-4x memory), which cannot ship. This
branch builds the shippable version — **vertex pulling from a per-tile texture** — behind
switches, and measures whether it keeps the gain.

## Does it make sense? Yes, as a 2 x 2 experiment

Shape (quad | triangle) x feed (instanced | pulled) are independent axes, and the four
arms answer one open question: does a texture fetch in the vertex stage cost back what
de-instancing saves? The instanced triangle stays in the harness as a cheap control (it
separates "vertex count under instancing" from "instancing itself"), but it is not a
candidate to ship on its own: 8 %, with side effects.

Conditions for a fair answer (from the adversarial review):
- **Runtime switch, never reload.** Two cold loads hold different resident tiles and can
  even land on a different loader-benchmark tier. Every switch rebuilds each tile's dot
  resources from the carrier `Points`' CPU arrays, which stay resident; nothing is
  re-fetched and the LRU is untouched.
- **Hold streaming while sampling**, and fingerprint the resident set per arm.
- **The loader benchmark does not follow the switch** during the test; pin `?preset=`.

## Design

### State and switches

- `lod.dotGeometry = { shape: 'quad', feed: 'instanced', triInradius: 0.505, textureWidth: 1024 }`
  in config.ts.
- Boot: `?dot=quad|tri` and `?feed=inst|pull` (for cold-load arrival cost only).
- Runtime: a new panel section **"Dot geometry (test)"** after "Point spacing & size",
  with two toggles, and `__wild.dots.set({ shape, feed })` returning a promise that
  resolves after the rebuild, `renderer.compileAsync`, and 60 settle frames.
  `__wild.dots.state()` reports the effective mode, tiles per mode, fallbacks and bytes
  per point.
- **Effective shape = `roundDots ? shape : 'quad'`.** The triangle only works as a round
  dot; Square always draws quads, in both feeds.

### One module owns the dot: `viewer/src/threejs-test/dot-geometry.ts`

Corner definitions (quad `[-0.5, 0.5]²`; triangle equilateral, inradius 0.505,
counter-clockwise — the material is FrontSide, the mirrored order culls everything; uv =
corner + 0.5), area factors (1 and 1.325), and a per-mesh state on `mesh.userData.dot`
(never on the geometry, which a switch replaces): `{ mode, points, perPoint, orderIsFair,
keepNow }`. API:

- `loadedPoints(mesh)`, `drawnPoints(mesh)`, `setDrawnPoints(mesh, n)` — instanced writes
  `instanceCount`; pulled writes `setDrawRange(0, n × perPoint)` (3 for the triangle, 6
  indices for the quad). **Never `mesh.count`**: three appends the object uuid to the cache
  key when it is above 1, which forks the pipeline per tile.
- `dotAreaFactor(mesh)`, `buildDotGeometry(mode, carrier)`, `applyDotMode(mesh, mode, tile)`.

Every current `instanceCount` site goes through this: `applyThinning` (both branches),
`shadedPixelArea`, the per-band trace in main.ts (~4874). The thinning keep maths is
unchanged — a drawRange prefix of k·n vertices draws points 0..n-1 exactly like
`instanceCount`, so the dissolve and the prefix fairness carry over.

### Step 1 — shape switch, instanced (built 2026-09-23)

- Quad and triangle share **one graph and one pipeline**. As built, each dot geometry owns
  a four-corner `position`/`uv` buffer and the quad index `[0,1,2,0,2,3]` once; a switch
  rewrites the corner values in place and sets the draw range to 6 indices (quad) or the
  first 3 (triangle). No new attribute objects and no material version bump: the review
  found that three r185 never frees an attribute replaced on a live geometry, so the first
  version (fresh attributes per switch) leaked three GPU buffers per tile per switch, plus a
  VAO per tile on WebGL2.
- **Verified in the browser pane, 2026-09-23** (WebGPU, landed pose at 80 m, 21 tiles,
  1.56 M points, dome and thinning as shipped): the panel button switched all 97 loaded
  tiles, and the 22 tiles that arrived afterwards came in as triangles; programs,
  pipelines and node builds unchanged (34 / 21 / 26), `renderer.info.memory` byte-identical
  before and after; Square forces quads and releases them again; no console errors. Pixel
  check: differences above 24 levels between a quad and a triangle frame sit ~150 pixels
  (0.01 %) above the noise between two quad frames. GPU time over five interleaved rounds:
  cloud share 1.323 ms quad, 1.248 ms triangle, **−5.7 %**, lower in every round — the
  control result the plan expected (the earlier runtime swap measured −8 %).
- `setDotMode` walks `tiles.forEachLoadedModel` (cached tiles too — the lesson of f84d92c),
  and new tiles are built in the current mode at `load-model`.
- Fix `sampleGroundZ` first: it trusts any dot-geometry bounding sphere above radius 1 as a
  tile bound, which only works because the quad's is 0.707 (the triangle's is ~1.16). As
  built, the disc reject now runs only for the carrier `Points` and still only above 1 m, so
  the sample set is byte-identical to before; the dot geometry's sphere is also pinned to
  0.707 for both shapes, which keeps three's opaque sort order unchanged. Removing the
  double sampling (carrier plus dot mesh) is left for step 2, where the pulled dot mesh
  carries no point attribute and drops out on its own.
- `mesh.raycast = () => {}` on dot meshes (GlobeControls raycasts the whole scene).
- `shadedPixelArea` × `dotAreaFactor`; the overdraw comment's "4/π" becomes 1.69 for the
  triangle. The render bench records effective shape and feed.

### Step 2 — feed switch, vertex-pulled (built 2026-09-23)

As built, the design below held, with these changes from review:
- Every dot geometry, in both feeds, drops three's geometry record on dispose
  (`forgetOnDispose` in streaming.ts), so the second-dispose leak described at the end of
  this plan cannot strand a switched-out geometry.
- A tile with no colour attribute packs black, matching what the instanced graph draws.
- A pulled tile that changes shape keeps its texture; only a feed change packs or frees it.
- The shared quad index starts at 2¹⁹ points (the 270 k overview tile is above 2¹⁸). A
  pulled geometry detaches it on dispose only while it is still the current shared index,
  so an outgrown index is freed with its last user.
- The graph cache is cleared when an effect is toggled, so old graphs are not retained.
- `renderer.initTexture()` at arrival was not added: the texture uploads on first draw,
  like the instanced attributes, and the upload probe counts it there.

Per tile:
- **One RGBA32F `DataTexture`, 16 B per point** — xyz = tile-local position, w = colour as
  the exact integer `r·65536 + g·256 + b` (exact below 2²⁴; decode with power-of-two divide
  and mod, identical in WGSL and GLSL). Do not bit-cast RGBA8 into the float: alpha 255
  makes about half the colours NaN/Inf patterns. Width 1024 (a 270 k tile is 264 rows;
  the WebGL2 floor of 2048 rows caps a tile at ~2 M points), Nearest filters, no mipmaps,
  last row padded, `needsUpdate = true`, `renderer.initTexture()` at arrival so the upload
  lands in the arrival timer. Every tile texture must have the same format and type — they
  are not in the cache key, but the codegen depends on them.
- Stored as an **own property** `material.pointData` (not userData), so the tile LRU counts
  its bytes and the unload plugin's texture loop frees it; also registered in the tile's
  disposal lists.
- Geometry: plain `BufferGeometry` with **no attributes**. Triangle: non-indexed,
  `drawRange` mandatory (without it three computes an infinite count and skips the draw).
  Quad: one shared Uint32 index `4i + {0,1,2,0,2,3}` sized from the largest
  `emittedPointCount`, so `vertexIndex` carries the point and corner.

Shader (one graph per feed/shape, keyed in `cloudGraphFor`, never per tile):
- `point = vertexIndex / k`, `corner = LUT[vertexIndex % k]` (k = 3, or 4 via the index
  values). Keep `vertexIndex` as the left operand so the division stays integer.
- Texel read: `materialReference` cannot `.load()` in r185 — **subclass
  `MaterialReferenceNode`** so its inner texture node has `setSampler(false)` and pass the
  `ivec2` through `.context({ getUV })` (three's own pattern). Do **not** use
  `texture().onObjectUpdate()`: on WebGPU the texture node resets its update type and the
  callback silently never runs.
- `positionNode` (and the dome's `pointLocal`) = texel.xyz — one texel node instance, so
  one fetch per vertex.
- Colour decoded in the vertex stage and passed as a varying; the round-dot test uses a
  varying `corner + 0.5` instead of `uv()` (without it every dot is discarded).
- **Subclass `PointsNodeMaterial`** (`CloudPointsMaterial`) with a `cornerNode`; its
  `setupVertexSprite` uses `cornerNode` instead of the hard-coded `positionGeometry.xy`,
  falling back to the parent when null, and calls `NodeMaterial.prototype.setupVertex`
  (calling `super` recurses). Do not use `material.vertexNode`: it drops the sprite size
  handling and changes what `positionView` means in the fragment stage.

Traps to design out:
- **The shared quad index is destroyed** when any tile geometry is disposed (three does not
  reference-count). Detach it inside each pulled geometry's `dispose` before the base call.
- **Re-keying**: three re-keys a render object only on a material-version change. Every
  switch sets `material.needsUpdate`; add a stale-mode check to `applyRenderGate` next to
  `effectMaterialStale`.
- Dispose the old arm's GPU resources before building the new ones, or memory peaks at
  double during a switch.
- The arrival-cost upload probe only wraps attribute uploads; wrap texture uploads too, or
  the pulled side looks free.

Memory: GPU stays at 16 B per point. CPU gains 16 B per point on this branch (three keeps
the texture's source array for re-upload after an unload). Acceptable for the test,
reported per arm; the shippable fix is to make the texture array the only CPU store and
point the ground-patch mask and `sampleGroundZ` at it with stride 4.

## Spike gate before step 2 is built out

Two tiles on the pulled triangle: each tile draws its own data, one node build and one
pipeline serve both, no WebGPU validation errors, and `?webgl` draws the same picture
(attribute-less draws and vertex-stage `texelFetch` are legal in WebGL2 but only a run
proves three's fallback does it). Stop and re-plan if any of these fails.

## Step 2 results (2026-09-23)

**Conditions.** The Browser pane was hidden, which pauses rAF. The app was booted into a
fresh document with a stand-in installed before any module ran: `requestAnimationFrame`
as a 16 ms `setTimeout`, and `document.hidden` reporting false. Timers run at full rate in
the hidden pane, so tiles streamed and GPU timestamps resolved. Same machine and session
for every arm, switched at runtime, resident set unchanged within each pose. GPU timestamps
are quantised to about 65 µs, and per-frame times were bimodal, flipping between two
clusters from one frame to the next, most likely another GPU client time-slicing. Means
over 300 frames per arm, four passes per pose in ABCD DCBA order, cloud share = arm minus
the cloud-hidden frame. Treat the ratios as solid and the absolute values as indicative;
the protocol's visible Chrome window has not been run.

**Correctness gate: passed on both backends.**
- All loaded tiles switch (91 on WebGPU, 86 on WebGL2) in about 110 ms. A cold
  `?feed=pull` boot builds every arriving tile pulled (91 of 91) and lands on the same view.
- Each pulled mode adds one node build, one pipeline and one vertex/fragment program pair.
  A mode nobody draws releases its program. No per-tile builds.
- The pulled vertex shader has a single `textureLoad` and decodes the colour once.
- Frozen-frame pixel check (render loop stopped, the same frame rendered through each
  feed): pulled and instanced are **pixel-identical**, max channel difference 0, for both
  shapes, on WebGPU and on WebGL2. Hiding the cloud changes 58–60 % of pixels, so the
  capture is live. Pulled triangle against pulled quad differs on 0.04 % of pixels.
- Square forces the pulled triangle to quads and releases it back.
- No WebGPU validation errors, no GL errors, no console errors. The only new message is
  three's warning that the attribute-free geometry has no `position`; it fires once per
  switch into a pulled mode (once per node build), not per tile.
- `renderer.info.memory` is identical after every return to the same mode over twelve
  switches.

**GPU time, WebGPU.** Cloud share in ms:

| Arm | nadir (1.89 M points, 27 drawn tiles) | tilt40 (3.54 M points, 50 drawn tiles) |
|---|---|---|
| instanced quad | 2.80 | 5.83 |
| instanced triangle | 2.75 (−2 %) | 5.62 (−4 %) |
| pulled quad | 0.74 (**−74 %**) | 1.95 (**−67 %**) |
| pulled triangle | 0.65 (**−77 %**) | 1.31 (**−78 %**) |
| cloud hidden (frame) | 0.31 | 0.31 |

Every pass shows the same order for the feeds; the pulled quad saved 73–76 % per pass at
nadir. The low cluster alone (p10) gives the same picture: −70 % and −74 % at nadir, −69 %
and −75 % at tilt40. Pulled triangle against pulled quad: −12 % at nadir (lower in three of
four passes) and −33 % at tilt40 (all four). The instanced quad's low cluster at nadir
(about 1.6 ms of cloud) matches step 1's visible-pane figure scaled to the point count, so
the stand-in does not distort the instanced cost.

The copy-based proxy measured −30 % and −43 %; pulling from a texture beats it. Under
instancing the cost is paid per instance, whatever the vertex count, and the texture fetch
costs far less than that.

**Frame time, WebGL2** (nadir, render loop stopped, 30 renders then a one-pixel read to
sync, four interleaved rounds; includes CPU): cloud share 1.95 ms instanced quad, 1.87 ms
instanced triangle, 1.33 ms pulled quad (−32 %), 1.07 ms pulled triangle (−45 %).

**GPU memory** (27 drawn tiles): instanced 31.2 MB of point attributes; pulled 30.4 MB of
textures plus 1.0 MB of attributes. 16 bytes per point either way. The shared quad index
(2¹⁹ points, 12.6 MB) stays allocated after leaving the pulled quad, cached for the next
switch; free it if the pulled feed ships without the quad.

**Arrival cost: fails the criterion as measured.** Cold boots, same landing: instanced
median 1.7 ms per 75 k-point tile (29 ns per point), pulled median 2.6 ms (45 ns per point).
The difference is `packPointData`: 0.7 ms per 75 k points in isolation, and hoisting its
branches does not change that. The hidden renderer runs JavaScript slowly (a strided
position copy alone took 0.5 ms), so a visible window should show less. The fix is the one
the CPU-heap note already asks for: have `reorderForPrefixSampling`, which copies both
arrays anyway, write the texture layout directly, so the texture array is the only CPU
store and packing costs nothing extra.

**Against the decision criteria.** Saves at least 25 % at nadir and tilt40: yes, by a
wide margin. Not slower on WebGL2: yes, faster on this machine; phones not run. GPU memory
at 16 bytes per point: yes. Arrival within ~0.3 ms: no, fix above. CPU heap fix planned:
yes, the same fix. Pulled triangle over pulled quad: at least 10 % at both poses, yes; the
rims by eye are still to judge.

**Not yet run:** the visible Chrome window with unquantised timestamps, the `horizon`
pose, zero point size, thinning off, and the Android and Apple phones.

## Measurement protocol

- A visible, focused Chrome window (the Browser pane throttles rAF; use it for
  correctness only), `?gputime&preset=strong`, `chrome://flags/#enable-webgpu-developer-features`
  for unquantised timestamps, fixed window size, dome and thinning as shipped. Confirm the
  dev server serves this worktree's code.
- Three poses via `__poses.save`: `nadir` (80 m landing), `tilt40` (~3 M points), `horizon`
  (many far, thinned tiles). Per pose: settle, hold streaming, record the resident-set
  fingerprint.
- Arms: instanced quad, instanced triangle, pulled quad, pulled triangle, plus a
  cloud-hidden baseline; order ABCD DCBA, at least 3 rounds; 300 frames per arm unquantised
  (900 otherwise); mean, median, p10/p90; cloud share = arm − baseline. Repeat at zero point
  size and once with thinning off.
- Pixel gate per arm: coverage and depth identical between feeds of the same shape, colour
  within ±1 on 8-bit channels (shader decode vs hardware unorm); triangle vs quad at most
  ~0.2 % of pixels, all at dot rims.
- Arrival cost per tile (`__cost.report()`) on cold boots per arm; CPU heap and bytes per
  point per arm.
- WebGL2: correctness gate plus GPU-bound frame time (timer queries are unreliable there).
  At least one Android phone and one Apple device, GPU-bound, over https.

## Decision criteria

Correctness first, no exceptions: pixel gate passes, no validation or GL errors on either
backend, Square draws quads in both feeds, identical drawn counts, no per-tile node builds,
one pipeline per mode.

Ship the pulled feed (instanced kept only as a temporary fallback) if:
- the better pulled arm saves **at least 25 %** of the cloud's GPU time against the
  instanced quad at both `nadir` and `tilt40`, with round-to-round spread excluding zero
  (the copy-based proxy measured −30 % and −43 %; far less means the texture fetch eats
  the gain);
- it is not more than 5 % slower on WebGL2 or either phone;
- GPU memory stays at 16 B per point;
- arrival cost rises by no more than ~0.3 ms per 75 k-point tile;
- the extra CPU heap has its fix planned before it ships on phones.

Pulled triangle over pulled quad only if it wins by at least 10 % at both poses and the
rims pass by eye; otherwise the pulled quad, which is today's picture exactly and serves
Square without a second primitive.

## Open question found on the way

Confirmed by reading three r185 (`renderers/common/Geometries.js`): `initGeometry` marks a
geometry `initialized` and registers its dispose listener; the listener removes itself on
the first dispose but never clears `initialized`, so `updateForRender` never calls
`initGeometry` again. From the second unload of the same tile on, `geometry.dispose()`
frees nothing, and three's `info.memoryMap` keeps the re-uploaded attributes alive. With
`UnloadTilesPlugin` hiding and re-showing tiles as the camera moves, that could leak a
tile's full point buffers per cycle — in today's viewer, not only on this branch.
Unmeasured; filed as a separate task. On this branch the dot geometries are covered by
`forgetOnDispose`; the carriers and the rest of the viewer are left to that task.

## Relation to the culling plan

The feed is an enum so the compute culling of `plan-gpu-point-culling.md` becomes a third
feed (`pulled + culled`, drawing `list[vertexIndex / k]`). Its gain estimate must be redone
against whichever feed wins here, since pulling makes each point cheaper.

## Files

- New: `dot-geometry.ts`, the `CloudPointsMaterial` and texel-reference subclasses (in
  `point-cloud.ts` or beside it).
- `streaming.ts`: `buildPointQuads`, `load-model` registration, `setDotMode`,
  `applyRenderGate`, `applyThinning`, `shadedPixelArea`, `sampleGroundZ`.
- `point-cloud.ts`: `cloudGraphFor` key and pulled graph, `createCloudMaterial`,
  `rebuildEffectGraph`.
- `main.ts`: toggles, boot params, `__wild.dots`, per-band trace, bench sample fields.
- `render-bench.ts`, `arrival-cost.ts`, `config.ts`, `threejs-test.html`.
- Not touched during the test: `eagle-bench.ts` (recalibrated only after the decision).
