---
name: overview-progressive-sse
description: Diagnose, tune, implement, or explain progressive Overview behavior in the SBB Cesium viewer. Use for SSE bootstrap/travel/ready behavior, dark or sparse regions after camera interaction, Globe Overview zoom/orbit limits and cameraRangeRatio, long-distance travel thresholds, packed/external tileset loading, bootstrap-validation.json generation, Overview request telemetry, or changes to viewer/src/overview-sse-controller.ts and its wiring.
---

# Overview Progressive SSE

Preserve a stable Overview image while limiting expensive refinement. Treat rendering quality, loading phase, camera interaction, and telemetry as separate concerns.

## Start Here

1. Read `viewer/src/presets.ts` for current constants. Do not rely on values remembered from an earlier run.
2. Read `viewer/src/overview-sse-controller.ts` for the state machine and telemetry classification.
3. Read the controller and camera wiring in `viewer/src/viewer.ts`, especially scene loading, `configureCameraLimits`, Globe controls, `allTilesLoaded`, `postRender`, `flyHome`, activation, and cleanup.
4. For bootstrap questions, read `pipeline/validate_overview_bootstrap.py` and `pipeline/area-overview.sh`.
5. Follow repository `AGENTS.md`: run GitNexus impact before editing an indexed symbol and `detect_changes` after editing.

The controller file may be untracked or absent from a stale GitNexus index. If impact returns `UNKNOWN`, report that limitation and inspect every direct caller in `viewer.ts` before editing.

## Required Behavior

Use this conceptual flow:

```text
load Overview
  -> bootstrap at coarse SSE when coarseBootstrapReady=true
  -> refining at ready SSE after first visible tile or bootstrap timeout
  -> ready only after loading is stable

long-distance travel above threshold
  -> travel SSE
  -> refining at ready SSE after settle delay
  -> ready after loading is stable

ordinary zoom, orbit, pan, or short drag
  -> keep the same ready SSE
  -> never switch to travel SSE merely because pointer movement began
```

Maintain these invariants:

- Use travel SSE only for a measured camera displacement above `OVERVIEW_TRAVEL_DISTANCE_THRESHOLD_M`.
- Keep SSE sticky during ordinary interaction. `INTERACTION_DRAG_START_THRESHOLD_PX` classifies dragging; it must not act as a distance-travel threshold.
- Apply the same travel logic when restoring a saved camera and when invoking Home.
- Cancel stale timers and guard asynchronous transitions with the active load generation.
- Deactivate the controller outside Overview mode and during unload/destroy.
- Expect effective SSE reported by the viewer to differ from the base constant because distance-band tuning may adjust it.

## Globe Overview Camera Limits

Treat Cesium surface height and point-cloud orbit range as different quantities.

- Compute `focusRadius` from `Math.max(primaryTileset.boundingSphere.radius, 1)`.
- Interpret `LIMIT_RADIUS_FOR_MINIMUM_ZOOM` as the minimum Globe Overview orbit ratio. For example, `0.07` means `minimum orbit range = focusRadius * 0.07`.
- Do not pass that orbit range directly to Cesium's `screenSpaceCameraController.minimumZoomDistance` in Globe Overview. Cesium interprets it as height above the ellipsoid, which can fight a custom point-cloud orbit and make rotation appear locked at minimum zoom.
- Keep Cesium's minimum surface height at the small base camera distance. Clamp custom wheel and pinch zoom using the distance from `camera.positionWC` to `orbitTarget`.
- Move the camera along the normalized `camera.positionWC - orbitTarget` vector and keep the camera looking at `orbitTarget`.
- Apply custom orbit-ratio zoom only when both conditions are true: the tileset uses Globe controls and the active preset is Overview (`low`). Preserve Local, Explore, and Detail behavior.
- Keep mouse orbit updates batched to one `requestAnimationFrame`; this avoids processing every raw pointer event while large Overview tiles are rendering.

For Peru Overview, a `focusRadius` near `7,996.7 m` makes ratio `0.07` stop at about `559.8 m`. Verify the runtime `cameraRangeRatio` settles near the configured value and horizontal orbit still works after zoom reaches the limit.

## Bootstrap Validation

Do not assume that a large SSE guarantees visible coarse content. Bootstrap is safe only when every coarse branch reaches a valid PNTS content tile.

`bootstrap-validation.json` contains:

```json
{
  "coarseBootstrapReady": true,
  "coarseContentTileCount": 72,
  "coarseContentBytes": 30034064,
  "coarseContentMaxDepth": 1,
  "missingBranches": []
}
```

Interpret it as follows:

- `coarseBootstrapReady=true`: enter the bootstrap phase.
- Missing, invalid, cyclic, or contentless branches: skip bootstrap and start refinement at ready SSE.
- The validator must follow external `.json` tilesets as well as direct `.pnts` content.

Regenerate only the validation artifact, without rebuilding tiles:

```bash
python3 pipeline/validate_overview_bootstrap.py \
  --tileset-dir local-storage/tilesets/2404PeruB2-overview-p02 \
  --output local-storage/tilesets/2404PeruB2-overview-p02/bootstrap-validation.json
```

Replace the dataset name when working on another Overview dataset.

## Telemetry Semantics

Classify `.pnts` requests using `PerformanceResourceTiming.startTime` and phase history. The sum of phase request counts must equal the observed `.pnts` request count for the active measurement window.

Treat `ready` as idle, not as a bucket for background refinement:

```text
ready + new .pnts resource
  -> attribute request to refining
  -> reopen refining phase
  -> return to ready only after a stable quiet interval
```

Do not trust a single `tileset.tilesLoaded=true` frame. Packed datasets with external tilesets may briefly report loaded before discovering more branches. Require continuous stability and reopen refinement when a later `.pnts` entry appears.

A validated report from the Peru Overview had:

```text
CloudFront PNTS requests: 1984
bootstrap requests:         49
refining requests:        1935
ready requests:              0
sum:                       1984
final phase: ready
```

`readyRequests=0` is expected when ready means genuinely idle. Unsupported byte counts are usually a browser/resource-timing visibility issue, not a phase-counting failure.

## Tuning Guidance

Judge constants from cold-cache reports and visual behavior, not from names alone.

- Bootstrap SSE: prioritize immediate coarse coverage. Use it only with valid coarse content.
- Travel SSE: prioritize responsiveness during genuinely large moves or cache misses.
- Ready SSE: balance steady-state detail, request count, memory, and FPS.
- Lower SSE means more refinement and potentially thousands more requests.
- Higher SSE reduces traffic but can expose sparse or dark regions when coarse content is inadequate.

A useful candidate to test is `bootstrap=64`, `travel=256`, `ready=128`, but never overwrite current constants automatically. First compare it with `viewer/src/presets.ts`, then collect a report because the dataset and adaptive distance band can change the effective SSE.

## Diagnostic Checklist

For dark regions or quality dropping during interaction:

1. Record current phase, base SSE, effective SSE, travel distance, selected tiles, active tiles, and visible points.
2. Determine whether SSE actually changed. If it did not, investigate tile selection, cache eviction, external branch discovery, or point styling instead of blaming the controller.
3. Verify ordinary pan/orbit/zoom did not call `beginTravel` with an artificial distance.
4. Verify long-distance Home/restore did call `beginTravel` with a real Cartesian distance.
5. Check `bootstrap-validation.json` and confirm all coarse branches have content.
6. Compare telemetry phase totals with CloudFront PNTS totals.
7. Test from a clean reload or disabled cache when comparing request counts.

For Globe Overview zoom stopping correctly but orbit becoming stuck:

1. Confirm `cameraRangeRatio` is measured against `orbitTarget`, not ellipsoid height.
2. Check whether `minimumZoomDistance` was assigned `focusRadius * ratio`; if so, separate the two limits.
3. Confirm native Cesium zoom is disabled only for Globe Overview and custom wheel/pinch zoom clamps the orbit range.
4. Drag horizontally after reaching the minimum ratio and verify the camera keeps the same range around the selected target.
5. Recheck Local, Explore, and Detail because their controls must remain unchanged.

For telemetry apparently stuck in `ready` while requests continue:

1. Inspect `handleResourceEntry` and `phaseAt`.
2. Confirm later `.pnts` entries reopen refinement.
3. Confirm ready requires a stable interval, not one `allTilesLoaded` event or one frame.
4. Do not fix this by merely increasing the frame skip count.

## Safe Change Workflow

Before editing:

1. Run GitNexus query/context for unfamiliar flows.
2. Run upstream impact for every symbol to be changed.
3. Warn before proceeding if impact is HIGH or CRITICAL.
4. Preserve unrelated changes in the dirty worktree.

After editing:

```bash
cd viewer
npm run build
cd ..
git diff --check
```

Then run GitNexus `detect_changes` and inspect the browser report. A repository-wide CRITICAL result may include unrelated pre-existing worktree changes; distinguish that aggregate risk from the local controller change.

## Completion Criteria

Consider the work complete only when:

- Ordinary interaction leaves the ready SSE unchanged.
- Travel SSE activates only above the configured real-world distance threshold.
- The view returns to ready SSE after travel settles.
- Dark areas do not reappear solely because of a small interaction.
- Globe Overview stops at its configured orbit ratio and can still orbit horizontally at that limit.
- Local, Explore, and Detail camera behavior remains unchanged by Globe Overview camera tuning.
- Bootstrap validation accurately reflects coarse content coverage.
- Telemetry phase counts reconcile with PNTS request totals.
- Final phase becomes `ready` after resource activity stops.
- TypeScript/Vite build and diff checks pass.
