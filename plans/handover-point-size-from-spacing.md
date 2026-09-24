# Handover: point size from spacing — diagnosis, rebuild, foveation

Written 2026-09-24 for the next session. The living write-up with all the figures is the
**Canopy Viewer Instrument Panel** artifact, section *Point size from spacing*
(`https://claude.ai/artifact/5aA2NKasBxQnaMubMjf4rc`) — update it by URL, never republish it
as a new artifact.

## Where things stand

- All of this is on **`sbb-main`** (the user's one working line), merged in through `2533b1b`.
  It is **not** going into `main`: `main` belongs to the devs and Jan on another base.
- The branch `sbb/point-size-from-spacing` still exists on GitHub; its local label is gone, and
  nothing is stranded on it — `git rev-list --count <merge-base>..origin/sbb/point-size-from-spacing`
  against `sbb-main` is 0. The point-size commits are `59065b4`, `1e61e69`, `76d11b0`, `fe875e8`,
  `8b0d264`, `3f585f4`, `b0ecc3f`, `c45bc4a`, `e46f5c0`, `6ab3a5d` (the branch also carries reorder
  and thinning commits that belong to other work).
- **The feature still ships off**: `render-options.ts:59`, `dynamicPointSize: false`. Nothing the
  user sees has changed. Turning it on is a look decision that has not been made.
- Start new work from `sbb-main` in a `git worktree` — sessions share the main folder's tree, and a
  fresh worktree needs `viewer/.env` copied and `npm ci`.

## What was wrong

The switch sized each point from **its own tile's** spacing. Under `refine: ADD` the coarse tiles
keep drawing underneath the fine ones, so the coarse levels — the ones with the largest spacing —
got the fattest dots. At the landing view **67% of the points took 87% of the paint**, and 35.5% of
points sat pinned at the pixel ceiling. That is what the user saw as "the point size differs within
one tile": it is not one tile, it is the density layers stacked on top of each other.

Two further facts came out of the pipeline, both load-bearing:

- **The APH levels are a strict partition, not copies.** An internal node emits a representative
  sample and routes the remainder to its children; the build asserts
  `count == emitted + residual_routed_point_count` (`pipeline/build_adaptive_point_hierarchy.py:1377`).
  So an ancestor's points fall *between* its children's and carry real detail. Over ground refined
  k levels deep the stack holds **4/3** the density of its deepest level and sits **sqrt(3)/2 = 0.866**
  of its spacing apart. Densities add; spacings do not. An earlier draft of the plan proposed
  dropping the coarse ancestors near the camera as useless — that was wrong, and the user caught it.
- **`corrected_error()` fabricates p001's geometric error.** It forces every node's error above its
  largest child's, so p001 publishes 7.668 m where its own footprint measures 3.849 m. The other 39
  visible tiles agree to three decimals.

## What was built

Four steps, each measured at the same pose (40 tiles, 2,757,682 points, 1600x900, SSE 4).

| Step | What it does |
|---|---|
| **A** `tileSpacingMetres` | takes the **smaller** of the published error and the tile's own measured footprint — both are upper bounds, so the minimum is the closer one. Making spacing a uniform (separate commit) cut tile arrival 26.1 → 18.0 ms and collapsed 40 shader programs to one. |
| **B** `applyEffectiveSpacing(rampMs)` | each tile's size comes from summing `1/spacing²` **along its whole ancestor chain**, weighted by the fraction of its children actually drawn. Ceiling share 35.5 → 14.5%, overdraw 34.7× → 19.8×. |
| **C** clamp | `floorFactor: 0.7` / `ceilFactor: 3` (`config.ts:191,219`) of the spacing the **fidelity setting** asks for; the *Point size* slider moves both. Replaced the fixed `minPx`/`maxPx`. |
| **D** shortfall | `size = base × max(1, delivered ÷ requested)` in `point-cloud.ts`'s `sizeNode`, with the fovea factor bending `requested` **per point**. Exactly 1 for **61.5%** of points, median 1.00. `sizeCoverage` deleted along with the absolute form that needed it. |

Result: every level now reports the same effective spacing (0.11–0.20 m, against 0.13–7.30 m own),
ceiling share **13%**, overdraw **21×** against 18.7× for one fixed size.

Files touched: `streaming.ts` (spacing, `applyEffectiveSpacing`), `point-cloud.ts` (`sizeNode`, new
uniforms `sizeRequestedPx` / `foveaCore` / `foveaFactors` / `sizeHalfHeightPx`), `main.ts`
(`applyPointSize`, `drawnDiameterCssPx`, `__spacing()`), `config.ts`, `threejs-test.html`.

## Two premises the plan got wrong, both caught by measuring

- **The ceiling cannot be lifted.** The plan said the 6 px ceiling only existed to contain the coarse
  tiles. Set to 8× the target, overdraw went 19.8× → 69.1×. Sweeping 1/2/3/4/8/12× over the same
  2.76 M points: overdraw 6.1 / 12.0 / 17.8 / 24.9 / 67.7 / 134.1×, clamped share only
  38.8 / 16.5 / 12.8 / 11.7 / 10.3 / 9.8% — **it stops falling**. Size goes as 1/depth and a tenth of
  the cloud sits close enough that no finite ceiling frees it. The ceiling bounds a divergent term;
  it is not a leftover. Left at 3×.
- **The clamp must follow the setting, not the live value.** Step C tied the size window to the error
  target — right for a setting, wrong when a brake moves the same variable. The boot and flight
  brakes raise it to 256 and 64, which took the floor from 1.4 px to 22.4 px: total drawn area jumped
  **114× between two frames** at the moment a flight started, in the one situation meant to make the
  frame cheaper. The clamp now reads `sseTarget`; the shortfall's denominator still reads the live
  `sseAuto`, so a braked frame goes blurrier rather than heavier. Verified over six flights,
  18,499 frames: clamp held at 1.4/6.0 px, brake moves dot size under 7%.

## Foveation, and the contract for the next feature like it

Foveation tells the corner of the image to stop refining sooner. Against one flat denominator the
size rule read that deliberate coarsening as a *shortfall* and tried to compensate, hitting the
ceiling instead — fewer points and no extra width, i.e. a holey edge. The denominator is now bent by
the same screen-space ramp, evaluated **per point** (per tile drew itself as visible boxes).

On one foveated frame, the same 1.73 M peripheral points: p90 shortfall 24.28 → 3.04, ceiling
32.6% → 15.3%, overdraw 24.0 → 13.6. 15.3% is what an unfoveated frame has, so foveation now buys
29% of the points and 42% of the paint without starving the edge. `edgeFactor: 8` is safe now;
before this it was not.

**The user is building something foveation-like next.** The rule it has to obey:

- anything that changes how much detail is **asked for** in a region multiplies into `requested`
  (`u.sizeRequestedPx`, `point-cloud.ts`);
- anything that changes how much is **actually drawn** multiplies into `delivered`, the way
  `thinScale` does.

Miss the first and the region goes holey — that is the 32.6% above. Miss the second and you get
holes with nothing filling them — that is the thinning bug this page's predecessor fixed.

## Traps that cost time here

- **Count only in-frustum children** when working out a tile's coverage fraction
  (`tile.traversal.inFrustum`). Counting `children.length` treats off-screen children as uncovered
  and pins the coarse bands at the ceiling.
- **Ease the shrink, not the growth.** A symmetric ramp drew 153 tile-frames smaller than their
  coverage earned (worst: 50% covered, 94% shrunk). Damped shrinking with instant growth: 0 over
  21,200 frames.
- **A hidden Browser pane pauses rAF**, so nothing streams and the boot stalls at 0%. Pumping the
  loop by hand does not help — without DOM layout the traversal selects nothing. Ask the user to
  open the pane.
- **Turn the rain cycle off before any visual or frame A/B**; it self-toggles Active/Dry and
  shimmers the whole cloud.
- Drive tests work: the user flies, the session records counters and reads them afterwards. Both
  real bugs above (the ease and the 114× jump) were found that way, not by reasoning.

## Debug hooks

- `__spacing()` — per band: `ownM`, `effectiveM`, `drawnPx`, `atCeiling`, `points`.
- Panel: *Point spacing & size* → *Point size · Per tile*; the per-tile rows stay hidden while the
  switch is off.

## Open

1. **Judge the look on a full screen.** The only thing standing between this and being the default.
   It is correct now and costs about what the fixed size costs; what it looks like is the user's call
   by eye, not a counter.
2. **`cacheMinBytes`.** Unrelated to point size, found on the way: the point-tile cache drains to
   256 MB while its own ceiling is 384 MB. This is the "the front takes forever to fill in" the user
   reported. Not touched.
