# Handover: quick wins, loader benchmark, second optimisation round

Covers the work of 2026-09-24 to 2026-10-05 on the ranked optimisation list (the appendix of
`plans/handover-dot-geometry-ab.md`). The living write-up with every figure is the artifact
**Canopy Quick Wins**: https://claude.ai/artifact/95759FcUacJzgYpYUjM48z — update it via its url
(read first, then republish), changelog entry on top; never publish a second page.

## 0. Start here (2026-10-06)

**State:** everything in this file is merged and pushed. `sbb-main` = `origin/sbb-main` = `9fa87e2`,
and `sbb/quick-wins` is the same plus this handover commit. Nothing is half-built and nothing is
uncommitted.

**Talk to the user in plain names, not item numbers.** The numbers are the IDs of the ranked list in
the appendix of `plans/handover-dot-geometry-ab.md`: 1.x quick wins, 2.x bigger projects, 3.x
measure first.

| ID | Plain name | State |
|---|---|---|
| — | Pulled triangles (points drawn from a per-tile texture, one triangle each) | Built, the default |
| — | Exact rotation pivot | Built |
| — | Loader benchmark freeze on the Start screen | Built; device calibration open |
| 1.1 | Tile bounds worked out on arrival | Built |
| 1.2 | Effects compiled out while switched off | Built |
| 1.3 | Faster ground probe | Built |
| 1.4 | No point-cloud shader builds after Start | Built |
| 1.5 | One shared near-cloud shader | Built |
| 1.6 | Lighter parrot animation | Built |
| 1.6b | One mesh per parrot | Open, small |
| 1.8 | Basemap images freed after upload | Built |
| 1.9 | Faster cloud-noise bake at boot | Built |
| 1.10 | Smaller ground-patch mask | Built |
| 1.11 | Closed HUD and panel cost nothing per frame | Built |
| 2.1 | Point tiles parsed without a copy | Built |
| 2.2 | Still frames skip the point-cloud tile update | Built |
| 2.3 | One copy of each point tile in memory | Parked (section 9) |
| 2.4 | Loader benchmark recalibrated for triangles | Open, needs devices |
| 3.1–3.8 | Culling inside tiles, tile prep in a worker, edge softening, output pass, colour in vertex stage, smaller point data, fewer map tiles under the patch, Android labels | Open, each needs a measurement or a phone first |
| — | Strong-tier map ceiling (whole map at the landing view) | Built 2026-10-05 |
| B8 | Evicted point texture leak | Fixed 2026-10-05 |

**Waiting on the user:**
1. In the main folder: `git merge --ff-only origin/sbb-main` (its local `sbb-main` was still at
   `ec64335` on 2026-10-06).
2. Rebuild `sbb-prod`; the live page has none of rounds 3 and 4 yet.
3. A device session with Jan (desktop, weak laptop, Android, iPhone). It covers the benchmark
   calibration (2.4), the phone memory reading that gates 2.3, and the phone-only 3.x items.

**Next for a session, in the recommended order; ask the user which:**
1. **1.6b One mesh per parrot.** Draws 36 → 12, about 0.5 ms of render CPU in the pane. A shader
   change: the texture is chosen per vertex. Small. Branch off `sbb-main`.
2. **Memory readout for the device session** (step 1 of section 9): the drawn share of resident point
   tiles, uploaded point-texture bytes from three's `Info.memoryMap`, next to `__wild.dots.state`.
   About half a day; it lets the device session also decide 2.3.
3. **Checks in a visible Chrome window** (Claude in Chrome on localhost:5177, or the user): whether tile
   arrivals still lead the worst frames on the pulled default (decides 3.2), the first rotation press
   (`__wild.pivotDebug.pickMs`), and the Start-screen power saving.

**Do not:** build the 2.3 spec (section 9); raise the medium or constrained map ceilings before phone
memory is known; propose merging into `main` (the user keeps `sbb-main` apart). Before building any
other item from the old list, re-check it against the current code first (it worked for 2.3).

## 1. Where things stand

| Line | Head | State |
|---|---|---|
| `sbb-main` | `9fa87e2` | Pushed 2026-10-05. Holds rounds 1-4 below, `e996937` (panels start minimized) and `e1eb4a1` (measured model heights). `sbb-prod` builds from it; the user rebuilds the server herself. The main folder's local `sbb-main` may lag: `git merge --ff-only origin/sbb-main` there. |
| `sbb/quick-wins` | `9fa87e2` + this handover | Equal to `sbb-main` apart from the handover commit on top (local). |

- Worktree: `C:\projects\WIDE_3d-flatform\.claude\worktrees\point-reorder-thinning-flicker-f48d6c`,
  on `sbb/quick-wins`. It has `viewer/.env` and `node_modules`. After a session restart it can be
  back on `claude/point-reorder-thinning-flicker-f48d6c` (`30ed49e`, old main code): run
  `git checkout sbb/quick-wins` first. `sbb-main` cannot be checked out here (the main folder holds
  it); start new branches from it instead.
- Dev server: `preview_start viewer-dev` (`.claude/launch.json`, port 5177). `preview_start` reads
  `launch.json` from the folder the session was launched in, so if the session started elsewhere,
  run `BROWSER=none npx vite --port 5177 --strictPort` in `viewer/` in the background and
  `preview_start {url}`. Check it serves this worktree: `/src/threejs-test/still-frame.ts` must answer
  200. Other ports get no basemap (the local MapTiler key only answers listed ports).
- The main folder `C:\projects\WIDE_3d-flatform` has `sbb-main` checked out and is shared with other
  sessions: check `git status` there before any merge, and never switch its branch.
- Checks: `npx tsc --noEmit`, `npm run bench:verify` (85 tests) and `npm run build` pass on `9fa87e2`.
- Merge procedure used for rounds 3 and 4 (ask before pushing). A worktree-isolated session may not
  run git in the main folder, so:
  1. `git fetch`; `sbb-main` = `origin/sbb-main`.
  2. Dry run: `git merge-tree --write-tree --name-only sbb-main <branch>` (a bare tree hash = no
     conflicts). If `sbb-main` moved, test that tree: `git archive` it into the scratchpad (from
     `viewer/`; `tar --force-local`), junction `node_modules`, run tsc, tests and the build.
  3. Here: `git checkout --detach sbb-main`, `git merge --no-ff <branch>` (message without trailer),
     check `HEAD^{tree}` equals the tested tree.
  4. `git push origin HEAD:sbb-main`, then `git checkout <branch>`, `git merge --ff-only <merge>`,
     push the branch.
  5. The user fast-forwards the main folder and rebuilds `sbb-prod` (`/srv/projekte/wide/wi-dev`).
- Peer sessions (Living dashboard analysis, Tone mapping, Tone-mapping review) share the main folder
  and the browser pane: ask before borrowing the pane. `sbb/tone-mapping` and
  `sbb/volumetric-ground-fog` fork at `5b3080d`, before all of this, and will conflict on merge.

## 2. Implemented, and what it gained

Figures are from the desktop app's hidden browser pane (JavaScript runs 2-3x slower there than in a
normal Chrome window, so ratios hold better than absolute ms) or from node. Nothing has been
measured on a phone or in a visible window yet.

### Round 1 — merged in `a2d371d`

| Change | Commit | Gain | Visible change |
|---|---|---|---|
| Pulled triangles as the default dot geometry | `1000e3e` | Cloud GPU 20.4 → 2.6 ms at the landing view (2.41 M points), about 8x; WebGL2 frames 32-45 % faster | Rim pixels only (0.01-0.04 %). Square dots now cost 14-49 % more; Overdraw reads about 1/3 higher |
| 1.3 Ground probe reads each point once, no full sort | `37679cb`, `a74cfdb` | 10-18x faster (259 → 14 ms at the widest radius) | None (102 real probes identical) |
| 1.4 High precision from boot, one graph for both precisions | `919e9c2`, `ca92961` | Cloud shader builds after Start 2 → 0 (one was 1.2 s into the flight) | None |
| Exact rotation pivot (first drawn dot under the cursor) | `de20359` | Within 3 cm at 40/40 cursors (old lift: 29 m median, 86 m worst); press 10-16 ms vs 35-60 ms | The pivot is where you click |
| Loader benchmark freeze on the Start screen | `7a37a69` | Hidden-scene GPU −89 % (113 → 13 ms per second); bench draws 70 → 0/s; about 29 MB freed | None; same tier |
| 1.1 Tile bounds computed during arrival | `f198730` | 0.7 / 1.5 / 2.7 ms out of the first drawn frame (75k / 150k / 270k points), +0.25 ms at load (node) | None |
| 1.2 Vignette, fovea bend, inspector palette compiled out while off | `fcc4cb8`, `217c6c7`, `b591266` | 0 pixels changed; GPU saving not measured (list estimate 0.05-0.25 ms); cached map tiles now follow effect switches | None |
| Bench stress primitive option + per-stage log | `c1aa244` | Tooling for calibration (`?benchstress=pulled|instanced`, `window.__benchReport`) | None |

### Round 2 — merged in `01ef721`

| Change | Commit | Gain | Visible change |
|---|---|---|---|
| 1.9 Cloud-noise bake: hash tables, per-cell cache, empty voxels skipped; manifest fetched during GPU setup | `8c82f6e` | Bake 346 → 70 ms (64³), 1141 → 185 ms (96³), bytes identical (test pins them); manifest round trip hidden behind the bake; `boot:*` performance marks | None |
| 1.5 One near-cloud material with per-object opacity; cloud sets kept alive across mode switches | `53680ca` | Cloud shader builds 6 → 2 (63.8 → 15.5 ms); a quality-guard or cloud-button round trip 7 builds (about 50 ms) → 0; shaders byte-identical | None (with Grading off, re-shown clouds keep their lit colours) |
| 1.6 Parrots: one skeleton a bird, 108/141 held tracks baked into the bones, flock parked while unseen | `c8f00ed` | Mixers 0.118 → 0.040 ms a bird (about 1.4 → 0.47 ms a frame at 12 birds); skeleton updates 36 → 12 a frame; nothing while off screen | None (poses within 3e-5 model units) |

### Round 3 — merged in `ec64335`

| Change | Commit | Gain | Visible change |
|---|---|---|---|
| 1.11 HUD and panel rows written only while their card is open; stats keep each tile's band rank, one collator | `e08a41b` (+ `bdc8c68`) | Frame 6.9-8.5 → 4.1-5.9 ms with the cards closed (the default since `e996937`) | None |
| 2.2 Point-cloud traversal skipped on still frames (`still-frame.ts`) | `cd9c808`, `bdc8c68` | Still-frame stream update 2.3-2.6 → 0.2-0.3 ms; 97 % of still frames skip | None |
| 1.8 Basemap ImageBitmaps closed after upload; globe UnloadTilesPlugin removed; swapped material handed to the library | `e09540b` (+ `bdc8c68`) | 117-164 MiB of decoded images freed at the landing view; evicted materials disposed 519/519 (old: 297/528) | None. On constrained, hidden map ancestors may stay on the GPU (≤ ~30 MiB) |
| 1.10 Ground-patch mask 64 → 32 cells, one-layer first upload, warning when cells run out | `8d10c11` | −8 MiB GPU; first upload 0.4 ms instead of the whole array | None |
| 2.1 PNTS tiles parsed in place instead of copied (`pnts-parse.ts`, probes the library at install) | `bdcdb67` | 1-4 MiB less garbage per arriving tile (~100 MB per 90-tile drag); time neutral | None (packed point data identical) |

### Round 4 — merged in `9fa87e2` (2026-10-05)

| Change | Commit | Gain | Visible change |
|---|---|---|---|
| Strong-tier map ceiling 256 → 352 MiB; `setMemoryBudget` / `setMemoryBudgetExact` ask the globe for a traversal | `c74862f` | Landing view 251 → 337 map tiles, 68 → 136 drawn, +88 MiB GPU; a raised ceiling now loads under a still camera (223 → 337 tiles in 1 s; before: nothing in 11 s) | Finer map between the dome edge and the horizon (3 % of the frame). The user chose it after a before/after |
| B8: an evicted tile's point texture shrunk to 1×1 before disposal (`retirePointDataTexture`) | `09052c3` | −1.2 MB GPU and CPU per shared pulled shader once its first tile is evicted | None (cloud and feed switch checked) |
| 2.3 rechecked and parked; old spec marked superseded | `c884f06` | — | — |

### Measured and deliberately left out

- Per-tile maths hoisted to the CPU (1.2, 2nd half): at most 0.1 ms, costs pixel identity.
- Probe weighting (1.3, 2nd half): the user kept the old weights; no speed in it.
- Cloud bake in a worker (1.9): not needed after the speed-up.
- Parrot mixers at 30 Hz (1.6): visible wing judder on near passes, for 0.05 ms.
- Idle LRU pass guard (1.11 D): APH's 0-byte tileset-seam tiles keep it from ever skipping.
- Controls height-probe replacement (2.2 D): the exact variant saves nothing at the landing pose (80 m
  clearance); the analytic one is not bit-exact. About 0.12 ms a frame in the pane, left alone.
- Per-tile pass gate (2.2 E): about 60 µs.

## 3. Still open, and what each needs

| Item | What it would bring | What is needed first |
|---|---|---|
| Loader benchmark calibration (step 3) | Correct tiers for pulled triangles | Devices: desktop, weak laptop, Android, iPhone. Per device: boot with `?preset=constrained|medium|strong`, note which holds ~55 fps; then 10 boots each with `?benchstress=pulled` and `?benchstress=instanced`, note both log lines. Protocol: `plans/plan-dot-geometry-ab.md` ~line 354, "Recalibrating the loader benchmark for pulled triangles". The user or Jan. Afterwards set `eagleBench` `strongFraction` / `mediumFraction` / `strongMinPoints` in `config.ts` and flip `stress` to `'pulled-triangle'`. This is also the open half of 2.4 (the quad-index half came with the flip: the index is built only for Square). |
| Freeze power check | Confirms the Start-screen saving | A normal Chrome window, GPU column in Windows Task Manager after ~15 s on the Start screen vs a quick Start |
| First pivot press (~100 ms in the pane) | Confirms or refutes a first-press hitch | Visible Chrome window: rotate, read `__wild.pivotDebug.pickMs` |
| Phone and visible-window runs of all of the above | Real numbers instead of pane ratios | A device; the pane cannot run the entrance flight (loader stays in "finishing") |
| Main folder fast-forward + `sbb-prod` rebuild | Ships rounds 3 and 4 | The user |
| Memory readout for the device session | Lets the device session decide 2.3 | Section 9, step 1; about half a day |
| Map ceiling, medium and constrained | Same sharpening on those tiers | Not measured. The user chose strong only (2026-10-05): 256 → 352 MiB at the landing view gave 251 → 337 map tiles and 68 → 136 drawn, +88 MiB GPU; only the band beyond the dome changed (3 % of the frame, the horizon rows most). `setMemoryBudget` now also asks for a traversal (`c74862f`), so a raised ceiling loads under a still camera |
| 2.3 One copy of each point tile | Parked: no evidence that memory is short | Rechecked 2026-10-05, see section 9. Do not build the spec. First: a small memory instrument, read during the pending phone calibration |
| 3.2 Tile preparation in a worker | −0.6 to −2.5 ms main thread per arriving tile | Measure first in a visible window (`__cost.report()` over a pan): do arrival frames now lead p95/p99 on the pulled default? Mainly for phones |
| 3.1 Culling inside tiles | −0.15 to −0.35 ms GPU | Projection instrument: only if ≥ 40 % of points are cut at nadir; pulled feed only. See `plans/plan-gpu-point-culling.md` |
| 3.3 Ground-patch edge softening | up to 0.6 ms on phones | A phone A/B with the ground patch on/off |
| 3.4 Drop the half-float output pass | −0.05 to −0.15 ms GPU, 26-39 MB VRAM | A/B ≥ 0.1 ms first; blending changes visibly |
| 3.5 Colour work in the vertex stage | < 0.1 ms | Builds on the dropped hoist; measure |
| 3.6 Quantised point layout | VRAM only | Only if phones still need VRAM after 2.3 |
| 3.7 Fewer basemap tiles under the ground patch | 10-20 MB, fewer MapTiler requests | Count requests per landing first |
| 3.8 Android label layout thrash | unknown | A phone trace |
| 1.6b One mesh per parrot | 36 → 12 draws; the flock costs ~0.5 ms render CPU in the pane | A shader change (texture chosen per vertex); small |
| Report B8 to three.js? | Upstream fix, then drop `retirePointDataTexture` | Check three's tracker first; listed on the Tile Leak Register (https://claude.ai/artifact/7JXwC4Xdnbj4SyKKGao7fZ, B1–B8) |

Watch: 1.10's 32 cells cover one site. When several sites load at once, look for the
`[ground-patch] all N cells are in use` warning and raise `maskMaxCells` in `config.ts` if it shows.
No TODO/TEMP markers were added in this work; the MapTiler Referer shim in `vite.config.ts` is still
temporary (separate issue).

## 4. New findings

- **The map cache is too small for the landing view.** On the strong tier the map traversal needs
  330-338 tiles there; 251 fit under the 256 MiB ceiling, and 79-87 fall back to coarser parents, so
  parts of the map stay blurrier than intended. `loadSiblings`/`loadAncestors = false` empties the map
  (the optimized traversal loads siblings whenever either is true, and `loadAncestors` defaults to
  true). Only the ceiling can fix it. Found while testing 1.8, not caused by it. Strong raised to
  352 MiB in `c74862f`; medium and constrained unchanged.
- **A closed HUD cost 2.5-3 ms a frame** in the pane: the old code wrote ~30 hidden elements, then
  read `canvas.clientWidth`, forcing a style recalculation every frame. Node had predicted tens of µs.
- **Parrots:** 36 of the scene's 80 draws, about 0.5 ms of render CPU in the pane, no measurable GPU.
- **The globe's UnloadTilesPlugin was the only disposer of the swapped basemap node material**; the
  old build disposed 297 of 528 evicted tiles' materials.
- **Removing the PNTS copy saves no time in the browser:** the pack then reads the fetched body cold
  and gives the parse saving back. Memory only.
- **The loader tier can be off in either direction** until the calibration: the stress still draws
  instanced quads (verdict leans low), but the hidden landing scene it also times now draws cheaply.
- **The camera is not bit-still after a wheel zoom:** the controls re-decompose the camera matrix
  every frame until the pointer moves. Exact camera comparisons fail there; use a tolerance.
- **The globe cache can stall at its ceiling while the camera is still:** with UpdateOnChangePlugin
  a full cache retries its refused requests only when the camera moves. Confirmed 2026-10-05 (a
  raised ceiling loaded nothing for 11 s) and fixed for budget changes in `c74862f`. Space that an
  eviction frees under a still camera is still used only at the next move (the stream reopens its
  still-frame gate on `dispose-model`; the globe has no such hook).
- three r185 traps: `updateWorldMatrix(true, false)` recomputes only flagged or forced matrices;
  node materials with the same graph share one NodeBuilderState, so a stale texture binding can
  briefly re-create an evicted map (harmless, the 1.8 tripwire now ignores it);
  `KeyframeTrack.getValueSize()` is values/times, so length checks cannot spot cubic splines.
  3d-tiles-renderer: `isLoading` exists at runtime but not in the typings.

## 5. How things were measured (reuse this)

- **Hidden browser pane:** navigate to a fresh same-origin 404 (`/__probe_x`), `history.replaceState`
  to `/threejs-test.html`, fetch the HTML, insert a `<script>` right after `<head>` that swaps
  `requestAnimationFrame` for `setTimeout(…, 16)` and fakes `document.hidden = false`, then
  `document.write` it. `resize_window` 1280x960 first (a 0x0 canvas loads no tiles). One tool call
  times out at 45 s: start work in the page and poll a `window` global.
- **A/B:** CPU timings from two dev servers are not comparable (the same library code ran 3x slower on
  one). Compare arms inside one page, interleaved (e.g. swap a prototype method per round). For code
  that cannot be swapped, run the old build from a detached `git worktree` with `.env` and a robocopy
  of `node_modules` without `.vite`, `npx vite --port 5300 --strictPort --host 127.0.0.1`.
- **Counters over timings:** shader builds (wrap `renderer._nodes.getForRender`, count
  `nodeBuilderCache` growth), shader identity (`renderer.debug.getShaderAsync` + SHA-256), texture
  uploads (wrap `GPUQueue.prototype.writeTexture` / `texSubImage3D` pre-boot), GPU read-back.
- **Frame cost:** stop the loop and call `__three.loop(now)` 150-300 times by hand.
- Import three from the exact URL the app loaded (`performance.getEntriesByType('resource')`,
  `/node_modules/.vite/deps/three.js?v=…`) to patch its prototypes.
- The pane never finishes the loader's "finishing" state, so post-Start states (flight, landing,
  POV release) cannot be tested there.

## 6. Switches and console handles added in this work

`?benchstress=pulled|instanced`, `window.__benchReport`; `?stillgate=off`, `__wild.stillGate`
(frames, runs, reasons); `__cost.pnts()` (in-place vs fallback parses);
`__three.globe.stats().reuploadsAfterClose` (tripwire, must stay 0); `boot:*` performance marks;
console lines `[pnts] parse in place: on|off` and `[ground-patch] all N cells are in use`
(`8d10c11`). `?dot=quad` and `?feed=inst` existed before; since `1000e3e` they are the way back to
the old dot geometry.

## 7. Working rules that applied (from the user's notes)

Answer in English. Commit messages: a subject plus at most one sentence, no Co-Authored-By
trailer. Ask before every push. Never mention the one-lod path. Sessions share one working tree: big jobs in a git
worktree, never `git commit -a`, check peers before touching the main folder. Python on this machine
writes CRLF: open with `newline=''`. Bash heredocs with apostrophes fail: write scripts to the
scratchpad. Turn the rain cycle off before visual A/Bs. Update artifacts via their url, changelog on
top.

## 8. Where the rest lives

- Ranked list with every item's spec: `plans/handover-dot-geometry-ab.md`, appendix from ~line 109.
- Artifact source: fetch it with `Artifact read` on the url above (this session's scratchpad copy
  goes when the session closes). The reasoning behind each change is in its commit's source comments.
- `HANDOVER-pivot-heights.md` is superseded by `de20359` (exact pivot).
- Memory: `C:\Users\krenz\.claude\projects\C--projects-WIDE-3d-flatform\memory`, notes
  `quick-wins-branch.md`, `canopy-quick-wins-artifact.md`, `browser-pane-throttles-raf.md`,
  `old-vs-new-ab-technique.md`, `session-worktree-resets-branch.md`, `maptiler-local-key-ports.md`.
  `basemap-cache-floor-deferred.md` predates the ceiling finding above.

## 9. 2.3 rechecked against `ec64335` (2026-10-05)

The user asked whether 2.3 still makes sense before building it. A read-only workflow checked it
against the code at `ec64335`, the other branches (`sky`, `sbb/colour-matching`, `sbb/ortho-upgrade`,
`sbb/volumetric-ground-fog`, `sbb/tone-mapping`, `sbb/grade-editor`) and the three r185 and
3d-tiles-renderer 0.4.28 sources: four readers, three independent designs, two adversarial reviewers.

**Verdict: do not build 2.3 as specified, and do not build any variant yet.**

The spec no longer holds:
- **The 6000-point prefix breaks the exact pivot (`de20359`).** `pickFirstPoint` reads every drawn
  point of every walked tile on each press (`cloud-pick.ts` ~178-235), about 850k points at the
  landing view. Run on a prefix in node with the real function, 86 % of hits became misses.
- **Emptying `image.data` throws on WebGPU** through a re-upload path the spec did not list. All
  pulled tiles share one node graph; a new render object's cloned binding still holds the texture of
  the tile that first built the graph, and `Bindings._createBindings` uploads it (Bindings.js:209)
  before `_update` swaps in the tile's own (:148). Once that first tile is evicted, its texture is
  rebuilt from `image.data`, and `writeTexture` with null data throws.
- **The pulled→instanced feed switch** unpacks the whole carrier (`restoreCarrierArrays`); a prefix
  overruns it.
- **The numbers were off.** GPU at rest rises +0 / +17 / +9 MiB (strong / medium / constrained), not
  +8..+29. There is no peak cost at the cache ceilings: the cache drains to its byte floor after every
  update. The CPU gain applies only to the drawn share of a cache that has reached its floor. That
  share, d, is unmeasured; one pose drew 47 of 61 traversed tiles.

And it is not needed now:
- No memory figure exists for any phone, and there are no crash or reload reports. The trigger for
  2.3 ("pulled must not cost extra CPU heap", written at 47 B/pt) was met when pulled reached 16 B/pt,
  the same as instanced.
- Phones only ever get medium or constrained: the mobile stress caps at 900k points, below
  `strongMinPoints` 2.4 M. The strong-tier gain (−139..−165 MiB) is desktop RAM.
- The current work (sky, fog, tone, colour matching, ortho, grade editor) reads no CPU point data.
  Jan's flight anchor, database wildlife on the measured ground and terrain floors need the ground
  probe, which already caps at about 6000 strided samples per tile; only the pivot and the feed
  switch rule out a prefix.
- On a phone (one memory pool), every variant removes the same thing: the GPU-resident duplicate.
  Lowering the stream's `gpuBytesTarget` on medium and constrained ("L1", two numbers in `main.ts`
  ~477/490) removes it from the GPU side in half a day and matches or beats the 8-day variants at
  d = 0.9. It costs re-uploads when hidden tiles return (test with rotations), and does nothing if
  iOS kills by the WebContent heap alone.

Order if memory ever becomes the question:
1. **Instrument (S).** Next to `__wild.dots.state` (CPU bytes per point already exist there): d,
   uploaded point-texture bytes counted from three's `Info.memoryMap` for `cloudPointData` textures
   (not the plugin's `estimatedGpuBytes`, which undercounts), and the tab footprint. Read it in the
   pending phone calibration session. Safari's Memory timeline probably omits GPU-process (WebGPU)
   memory, so the footprint needs a GPU-inclusive reading.
2. **Gate.** Proposed (not agreed): a reload or crash in a 5-minute roam, or an iPhone footprint of
   1.0 GB or more (two thirds of WebKit's ~1.5 GB WebContent soft limit, bug 277848), with point data
   at least 30 % of it.
3. **L1 first**, measured on rotations.
4. **Only if L1 fails** (iOS counts only the heap, or re-uploads stutter): build the quantised twin.
   Each drawn pulled tile keeps uint16 xyz against its own box for boxes up to ~256 m (p99 2 mm,
   0.37 % of picks change dot) and Float32 xyz above (uint16 on 1-2 km tiles changes 2-5 % of picks),
   drops colour, and marks its texture `source.dataReady = false` after the first upload (three skips
   the data write at Textures.js:355 on both backends, so a stray re-create gives a zero texture
   instead of an exception). Also: a permanent placeholder as the shared graph's template texture,
   every CPU reader on one point view, the cloud's UnloadTilesPlugin never registered (boot flag
   only), a cross-feed switch that calls `reloadTiles`, the mask finished before a tile is trimmed,
   and the tripwire count-only (never evict from inside render). About 8 days.

Separate from 2.3, the template binding above did leak, confirmed and fixed on 2026-10-05 in `09052c3`.
The test: evict only the tile whose texture the shared pulled graph was built with, while 33 render
objects still used that graph, plus 6 neighbours so replacements arrive. The next arrival re-created
the evicted texture on the GPU (arrival-cost `reCount` +1, 1.21 MB). It then stayed, belonging to no
tile, with its 1.2 MB array alive. Evicting every tile (`reloadTiles`) does not show it, because three
frees a NodeBuilderState once no render object uses it. The fix is `retirePointDataTexture` in
`dot-geometry.ts`: on `dispose-model`, and on a pulled→instanced switch, the texture gets a 1×1 image
before it is disposed. The re-creation is now 16 bytes, and the upload probe skips it. Same test after
the fix: 1×1 re-created, `reCount` 0, the cloud draws normally, and the feed round trip works.

The full workflow output (readers, designs, reviews, node benches) was in this session's scratchpad
(`wf23-result.json`) and goes when the session closes; this section is the record.
