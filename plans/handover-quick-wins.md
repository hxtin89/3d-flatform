# Handover: quick wins, loader benchmark, second optimisation round

Covers the work of 2026-09-24 to 2026-09-30 on the ranked optimisation list (the appendix of
`plans/handover-dot-geometry-ab.md`). The living write-up with every figure is the artifact
**Canopy Quick Wins**: https://claude.ai/artifact/95759FcUacJzgYpYUjM48z — update it via its url
(read first, then republish), changelog entry on top; never publish a second page.

## 1. Where things stand

| Line | Head | State |
|---|---|---|
| `sbb-main` | `01ef721` | Pushed. Holds rounds 1 and 2 below, plus `e996937` (panels start minimized). `sbb-prod` builds from it; the user rebuilds the server herself. |
| `sbb/quick-wins` | `bdc8c68` | Local only: not pushed, not merged. Round 3 below, six commits on top of `01ef721`. `origin/sbb/quick-wins` is still at `c1aa244`. |

- Worktree: `C:\projects\WIDE_3d-flatform\.claude\worktrees\point-reorder-thinning-flicker-f48d6c`,
  on `sbb/quick-wins`. It has `viewer/.env` and `node_modules`. After a session restart it can be
  back on `claude/point-reorder-thinning-flicker-f48d6c` (`30ed49e`, old main code): run
  `git checkout sbb/quick-wins` first. `sbb-main` cannot be checked out here (the main folder holds
  it); start new branches from it instead.
- Dev server: `preview_start viewer-dev` (`.claude/launch.json`, port 5177). Check it serves this
  worktree: `/src/threejs-test/still-frame.ts` must answer 200. Other ports get no basemap (the
  local MapTiler key only answers listed ports).
- The main folder `C:\projects\WIDE_3d-flatform` has `sbb-main` checked out and is shared with other
  sessions: check `git status` there before any merge, and never switch its branch.
- Checks: `npx tsc --noEmit` and `npm run bench:verify` (84 tests) pass on `bdc8c68`;
  `npm run build` succeeds.
- **Waiting on the user:** merge round 3 into `sbb-main` and push? Then `sbb-prod` needs a rebuild.
- Merge procedure used for rounds 1 and 2 (ask before pushing):
  1. `sbb-main` = `origin/sbb-main`, and `git status` in the main folder is clean.
  2. Temp worktree: `git worktree add --detach <tmp> sbb-main`.
  3. There: `git merge --no-ff sbb/quick-wins` (message without trailer).
  4. Junction `viewer/node_modules` to this worktree's, run `npx tsc --noEmit` and
     `npm run bench:verify`; remove the junction before `git worktree remove`.
  5. In the main folder: `git merge --ff-only <merge sha>`, then push after asking.
  6. `git merge --ff-only sbb-main` on `sbb/quick-wins`.
  7. The user rebuilds `sbb-prod` (`/srv/projekte/wide/wi-dev`) herself.
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

### Round 3 — on `sbb/quick-wins`, not merged

| Change | Commit | Gain | Visible change |
|---|---|---|---|
| 1.11 HUD and panel rows written only while their card is open; stats keep each tile's band rank, one collator | `e08a41b` (+ `bdc8c68`) | Frame 6.9-8.5 → 4.1-5.9 ms with the cards closed (the default since `e996937`) | None |
| 2.2 Point-cloud traversal skipped on still frames (`still-frame.ts`) | `cd9c808`, `bdc8c68` | Still-frame stream update 2.3-2.6 → 0.2-0.3 ms; 97 % of still frames skip | None |
| 1.8 Basemap ImageBitmaps closed after upload; globe UnloadTilesPlugin removed; swapped material handed to the library | `e09540b` (+ `bdc8c68`) | 117-164 MiB of decoded images freed at the landing view; evicted materials disposed 519/519 (old: 297/528) | None. On constrained, hidden map ancestors may stay on the GPU (≤ ~30 MiB) |
| 1.10 Ground-patch mask 64 → 32 cells, one-layer first upload, warning when cells run out | `8d10c11` | −8 MiB GPU; first upload 0.4 ms instead of the whole array | None |
| 2.1 PNTS tiles parsed in place instead of copied (`pnts-parse.ts`, probes the library at install) | `bdcdb67` | 1-4 MiB less garbage per arriving tile (~100 MB per 90-tile drag); time neutral | None (packed point data identical) |

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
| Merge round 3 + push | Ships 1.8, 1.10, 1.11, 2.1, 2.2 | User decision; then `sbb-prod` rebuild |
| Basemap cache ceiling (new finding) | Sharper map at the landing view | User decision: raise the ceiling (costs GPU memory, 1 MiB a tile) or accept. Knobs: `globe.setMemoryBudget` in `main.ts` ~469 (strong, 256 MiB) and ~480 (medium, 192 MiB); defaults in `globe.ts` ~167-170 (256 MiB, `maxSize` 320, itself below the 330-338 needed). `gpuBytesTarget` in `globe.ts` is vestigial since 1.8 (snapshots only) |
| 2.3 One copy of each point tile | −95 to −250 MiB CPU memory at rest | Design: the stream's UnloadTilesPlugin (`streaming.ts` ~525) re-uploads hidden tiles from their data, so the texture must never be re-uploaded first (or that plugin replaced by the LRU); gate the runtime feed A/B; fix `arrival-cost.ts:165` (reads `image.data` after upload); rewire HUD gpuBytes and setMemoryBudget. Keep the geometry-dispose and VAO fixes. Hidden tiles are freed only above `bytesTarget`, so force budget pressure to test re-uploads. Spec: `plans/handover-dot-geometry-ab.md` §2.3 |
| 3.2 Tile preparation in a worker | −0.6 to −2.5 ms main thread per arriving tile | Measure first in a visible window (`__cost.report()` over a pan): do arrival frames now lead p95/p99 on the pulled default? Mainly for phones |
| 3.1 Culling inside tiles | −0.15 to −0.35 ms GPU | Projection instrument: only if ≥ 40 % of points are cut at nadir; pulled feed only. See `plans/plan-gpu-point-culling.md` |
| 3.3 Ground-patch edge softening | up to 0.6 ms on phones | A phone A/B with the ground patch on/off |
| 3.4 Drop the half-float output pass | −0.05 to −0.15 ms GPU, 26-39 MB VRAM | A/B ≥ 0.1 ms first; blending changes visibly |
| 3.5 Colour work in the vertex stage | < 0.1 ms | Builds on the dropped hoist; measure |
| 3.6 Quantised point layout | VRAM only | Only if phones still need VRAM after 2.3 |
| 3.7 Fewer basemap tiles under the ground patch | 10-20 MB, fewer MapTiler requests | Count requests per landing first |
| 3.8 Android label layout thrash | unknown | A phone trace |
| 1.6b One mesh per parrot | 36 → 12 draws; the flock costs ~0.5 ms render CPU in the pane | A shader change (texture chosen per vertex); small |
| Tile Leak Register entry | Records the 1.8 material finding below | Add it as B7 to https://claude.ai/artifact/7JXwC4Xdnbj4SyKKGao7fZ (read, then republish via url) |

Watch: 1.10's 32 cells cover one site. When several sites load at once, look for the
`[ground-patch] all N cells are in use` warning and raise `maskMaxCells` in `config.ts` if it shows.
No TODO/TEMP markers were added in this work; the MapTiler Referer shim in `vite.config.ts` is still
temporary (separate issue).

## 4. New findings

- **The map cache is too small for the landing view.** On the strong tier the map traversal needs
  330-338 tiles there; 251 fit under the 256 MiB ceiling, and 79-87 fall back to coarser parents, so
  parts of the map stay blurrier than intended. `loadSiblings`/`loadAncestors = false` empties the map
  (the optimized traversal loads siblings whenever either is true, and `loadAncestors` defaults to
  true). Only the ceiling can fix it. Found while testing 1.8, not caused by it.
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
  a full cache retries its refused requests only when the camera moves (latent; not changed).
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
