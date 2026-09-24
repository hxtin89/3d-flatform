# Handover — the adaptive dome, thinning defaults, and the branch cleanup

Session of 23–24 Sep 2026. Everything below is in `sbb-main` (merge `5b3080d`), pushed, and
live on `wi-dev` (`sbb-prod`, `/srv/projekte/wide/wi-dev`, built for `/livingdashboard/`).
The measured write-up with all tables is the **Canopy Viewer Instrument Panel**, sections
*The dome* and *Drawing fewer points*:
https://claude.ai/artifact/5aA2NKasBxQnaMubMjf4rc

## Branches — read this first

- **`sbb-main` is the one working line.** Branch new work off it, in its own worktree.
  It holds render-cost, tile-arrival-cost, stride-order, point-size-from-spacing,
  SphereFade, dot-geometry-ab, geometry-dispose-fix, vao-release and this session's dome work.
- **`main` is not the target.** It belongs to the devs and Jan on a different base (frozen at
  `30ed49e`, 2026-07-28). Do not merge `sbb-main` into it and do not propose it.
- Local branches were cleaned to `main` and `sbb-main`. Old test branches live on GitHub only
  and are **not** to be merged: `sbb/per-tile-point-size`, `sbb/tileset-compare`,
  `sbb/baked-ground-mask`, `sbb/floating-origin`, `sbb/point-budget` (the last carries a WIP
  commit `1f9fd9a` from 17 Sep).

## What the dome is

Two spheres on the map under the focus of the view (`viewer/src/threejs-test/sphere-fade.ts`,
gates in `streaming.ts`, falloff in `point-cloud.ts`). Tiles outside the outer sphere are never
fetched; tiles outside the inner one stay loaded but are not drawn; inside, points shrink and
sink onto the map towards the rim. Panel section **Sphere fade (test)**; on by default.

## What was found out

1. **The cost is near the canopy, not at height.** 12 views (4 heights × 3 tilts): at 250 m the
   forest costs 3–6 ms GPU; from 1 km up it is under 1.4 ms even with no dome, because the survey
   fills only part of the frame. At height the dome is a question of look; performance work
   belongs near the canopy.
2. **The old fixed dome erased the forest from 1 km up** (as few as 1 of 3 tiles drawn).
3. **A fixed pull-in in metres cannot work at height** — the dome vanished under the camera.
4. **Cutting points inside tiles does not work with this tree.** APH draws every level at once;
   the coarse ancestors are up to 1.5 km across and always straddle the rim (at 250 m/45°:
   26 straddling tiles held 53 % of the points). Judging per tile at its nearest point saves
   ~1.5 %; judging at the box middle saves 16–18 % but **coarsens the full-size area too**
   (4 / 21 / 23 % of its points at 442 m, tilts 88° / 70° / 55°) — visible as coarse
   rectangles. Withdrawn.
5. **Thinning at target 1.0× read too coarse on a full screen.** It thinned every tile to exactly
   the error-target spacing; the tree delivers finer, and that surplus is the detail.
6. **The Browser pane's GPU timer was unusable** in these runs (up to 8 ms spread at identical
   work). All conclusions rest on drawn point counts (`geometry.instanceCount` of visible
   meshes). A hidden pane stops rAF — nothing loads, GPU reads 0.

## What was implemented (all in `sbb-main`)

- **Adaptive dome** (`d181c5a`): centre under a screen spot that drops up to 40 % down in tilted
  views, but only as far as keeps the ground under the screen middle in the full-size part;
  inner radius = 0.6 × camera-to-centre distance, clamped 450–3000 m; outer radius and ramp
  scale with it; 0.3 s easing, snaps on jumps. The pinned landing dome is sized from the landing
  eye. Replaced the pull-in slider (`d5fafc6`).
- **Fade band** (`229cd66`, then `47f72da`): coarser detail and per-tile thinning in the band,
  now **off by default** and judged at a tile's nearest point — inside the inner sphere the
  resolution is exactly the dome-off resolution.
- **Thinning defaults** (`47f72da`, `87fc2bc`): Thin to 0.5× (slider now goes down to 0.2×),
  Covered tiles 50 %, Full detail within 100 m, **Full strength beyond 2000 m** (user's choice).
  Keeps 87–98 % of the points — close to unthinned, and saves little near the canopy (~2 % at
  250 m). 800 m is the middle ground (78–90 %) if cost matters again.
- New panel sliders: *Growth with distance*, *Maximum radius*, *Focus in side view*,
  *Detail at the rim*, *Thinning in the band*.

## Open

- **Judge the dome by eye on a full screen** — size at height (*Growth with distance*), the melt
  at the rim (*Ramp width*, fade exponents), tilting and zooming. Nothing else is pending.
- No GPU time for any of this yet; measure outside the Browser pane if needed.
- Whether panning is smoother is unmeasured (tile arrivals varied 21–71 by stretch of ground).
- The four `DONE_` sessions' worktree folders (nifty-euler, silly-colden, sphere-falloff-tiles,
  points-count-slider) are empty but locked until those sessions are archived.

## How to work on it

- Dev server: `npm run dev` in `viewer/` (port 5177); open `threejs-test.html?gputime`.
  A fresh worktree needs `viewer/.env` copied and `npm ci`.
- Console: `__wild.sphereFade.stats()` (placement, radius, focus drop), `__wild.sphereFade.settings`,
  `__poses.save/go/bench` for repeatable views (stored per origin in localStorage). Build test
  views from `__wild.origin.enuFrameRender` + `lookAt`; shift-drag tilt does not work through
  the pane.
- Traps: the shader uses raw ENU, `worldToEnu` in main.ts the lifted frame — the dome centre goes
  to the shader through `enuInverseRender`. Python edits on this machine write CRLF — check
  `git show --stat` for whole-file churn. Server steps on `sbb-prod` are run by the user
  (Claude's key is refused there).
