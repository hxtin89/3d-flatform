---
name: spatial-lod-grid-tree
description: Build, upgrade, validate, tune, debug, or explain the SBB Spatial LOD Grid/Tree pipeline and viewer mode. Use for `?lod=spatial-lod`, fixed ENU grid LOD, z/x/y tile IDs, p001/p02/p10/p50/p100 density mapping, `pipeline/build_spatial_lod_tree.py`, `pipeline/spatial-lod.sh`, `pipeline/upgrade_spatial_lod_p001.py`, `pipeline/spatial-lod-upgrade-p001.sh`, `viewer/src/spatial-lod.ts`, and UI issues such as excessive initial visible points, uneven refinement, duplicate split tiles, promote/backup recovery, or Spatial LOD tileset validation.
---

# Spatial LOD Grid/Tree

Use a single 3D Tiles tree whose LOD units are fixed spatial grid cells, not areas. Area metadata may still drive selection/camera UX, but it must not define LOD density or tileset boundaries.

## Start Here

1. Read `AGENTS.md` and follow GitNexus requirements before editing indexed symbols.
2. Read `pipeline/build_spatial_lod_tree.py` for the canonical full builder.
3. Read `pipeline/spatial-lod.sh` for the normal CLI wrapper.
4. Read `pipeline/upgrade_spatial_lod_p001.py` and `pipeline/spatial-lod-upgrade-p001.sh` before fixing p001 upgrade, resume, promote, or backup issues.
5. Read `viewer/src/spatial-lod.ts`, then its wiring in `viewer/src/main.ts` and `viewer/src/viewer.ts` before changing viewer behavior.
6. Read `pipeline/tests/test_build_spatial_lod_tree.py` and `viewer/src/spatial-lod.test.ts` before changing contracts.

Treat generated reports and current source as authoritative. Do not rely on remembered output paths or stale density values.

## Target Contract

The target Spatial LOD profile is:

```text
z0 p001 2000m  step=1000  geometricError=4000
z1 p02  1000m  step=50    geometricError=1000
z2 p10  500m   step=10    geometricError=500
z3 p50  250m   step=2     geometricError=250
z4 p100 50m    step=1     geometricError=0
```

Tree shape:

```text
Root entry tileset.json
└── z0 external subtree docs
    └── z0 p001 content
        └── z1 p02 grid tiles
            └── z2 p10 grid tiles
                └── z3 p50 grid tiles
                    └── z4 p100 grid tiles
```

Folder shape:

```text
local-storage/tilesets/<logical>/<logical>-spatial-lod/
  tileset.json
  spatial-lod-report.json
  z0/<z0-id>/tileset.json
  points/z0/*.pnts
  points/z1/*.pnts
  points/z2/*.pnts
  points/z3/*.pnts
  points/z4/*.pnts
```

Maintain these invariants:

- Tile IDs are `z/x/y`, e.g. `z2_x000012_y000008`.
- Area is metadata only; never use Area as the LOD unit.
- Parent bounding boxes must contain child bounding boxes.
- Parent `geometricError` must be greater than or equal to child `geometricError`.
- Use `refine: "REPLACE"`.
- Only the entry root carries the ENU-to-ECEF transform.
- Sparse data is valid: do not generate full empty grids.
- `p100` exists only where real data exists.
- Attach lightweight `viewerRequestVolume` to z4 leaves so p100 does not request too early.
- Write generated files atomically and publish the entry `tileset.json` last.

## Normal Full Build

Build from COPC chunks:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
npm run pipeline:spatial-lod -- 2404PeruB2
```

Use these only when intentional:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
npm run pipeline:spatial-lod -- 2404PeruB2 --resume

POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
npm run pipeline:spatial-lod -- 2404PeruB2 --overwrite
```

Do not casually recommend `--overwrite` for very large datasets. The Peru B2 full build took about 36 hours; prefer the upgrade path below when an old four-level output already exists.

## P001 Upgrade Path

Use this when an old four-level Spatial LOD output already exists:

```text
old z0 p02  2000m -> new z1 p02 1000m by splitting old PNTS
old z1 p10  500m  -> new z2 p10 500m by hardlink/copy
old z2 p50  250m  -> new z3 p50 250m by hardlink/copy
old z3 p100 50m   -> new z4 p100 50m by hardlink/copy
new z0 p001 2000m -> build from COPC with canonical global ordinal sampling
```

This path intentionally does not rebuild p02/p10/p50/p100 from COPC.

Dry-run:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
bash pipeline/spatial-lod-upgrade-p001.sh 2404PeruB2 --dry-run
```

Build target folder:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
bash pipeline/spatial-lod-upgrade-p001.sh 2404PeruB2
```

Resume after interruption:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
bash pipeline/spatial-lod-upgrade-p001.sh 2404PeruB2 --resume
```

Promote an already-built target into the canonical folder:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
bash pipeline/spatial-lod-upgrade-p001.sh 2404PeruB2 --promote-existing
```

Build and replace in one run only when intended:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
bash pipeline/spatial-lod-upgrade-p001.sh 2404PeruB2 --replace
```

Promotion renames the old canonical output to:

```text
<logical>-spatial-lod.backup-before-p001-YYYYMMDD-HHMMSS
```

Never use `--overwrite-target` if a useful `.spatial-lod-p001-upgrade-state.json` remains and the desired action is resume.

## Known Good Peru B2 Metrics

For `POINTCLOUD_PUBLIC_ROOT=peru-b2-globe` and dataset `2404PeruB2`, the promoted p001 upgrade produced:

```text
z0 p001: 27 tiles, 3,419,135 points
z1 p02:  73 tiles, 68,382,683 points
z2 p10:  242 tiles, 341,913,414 points
z3 p50:  857 tiles, 1,709,567,067 points
z4 p100: 19149 tiles, 3,419,134,134 points
entry children: 27
occupiedTileCount: 20348
```

The old four-level profile was:

```text
old z0 p02: 27 tiles, 68,382,683 points
old z1 p10: 242 tiles, 341,913,414 points
old z2 p50: 857 tiles, 1,709,567,067 points
old z3 p100: 19149 tiles, 3,419,134,134 points
```

Use these numbers as sanity checks, not universal requirements.

## Viewer Contract

Load one logical Spatial LOD tileset:

```text
http://localhost:5173/?dataset=peru-b2-globe&lod=spatial-lod
```

Spatial LOD uses one adaptive runtime over one dataset identity. The
Overview/Explore/Detail preset buttons do not switch Spatial LOD behavior;
`main.ts` intentionally ignores preset changes while `lod=spatial-lod` is
active. The UI may keep `low` selected for report compatibility, but that is
not a fixed Overview traversal mode.

Area selection is metadata and camera navigation only. It must never reload a
different density dataset or replace the active Spatial LOD tileset.

The initial camera range seeds SSE once:

```text
range <= 250m:  SSE 64
range <= 500m:  SSE 128
range <= 1000m: SSE 256
range <= 2000m: SSE 512
farther/global: SSE 1024
```

After bootstrap, `SpatialLodBudgetController` owns runtime refinement:

- SSE ladder: `64, 96, 128, 196, 256, 384, 512, 768, 1024, 1536, 2048`.
- Point target: viewport-derived, clamped to 5M-12M selected points.
- Hard selected-point limit: 15M.
- Cache budget: 1024 MiB plus 512 MiB maximum overflow.
- Soft pressure: frame-time EMA above 50 ms or memory above 1024 MiB.
- Hard pressure: selected points above 15M, frame-time EMA above 60 ms, or memory above 1536 MiB.
- Use streaming traversal while moving/loading. Switch to standard traversal
  only after 2.5 s of continuous eligibility. Eligibility requires settled
  queues and z4 availability, plus either stable budgets or pressure that has
  already coarsened SSE to the end of the ladder.
- Under stable headroom, refine one SSE step at a time; under pressure, coarsen
  one step at a time. Cache trimming is rate-limited.

Expected spatial refinement:

```text
camera center: z3/z4, potentially p100 where request volume permits
nearby:        z2/z3
farther:       z1/z2
far/global:    z0/z1
```

After regenerating or promoting a folder, restart the static tile server and hard-reload the browser. Stale JSON can look like a pipeline bug.

```bash
npm run pipeline:serve
npm run viewer:dev
```

## Validation

Fast JSON/report check:

```bash
/Volumes/WD_BLACK/conda/envs/pointcloud-pipeline/bin/python -c '
import json, pathlib
root = pathlib.Path("local-storage/tilesets/peru-b2-globe/peru-b2-globe-spatial-lod")
t = json.loads((root / "tileset.json").read_text())
r = json.loads((root / "spatial-lod-report.json").read_text())
print(len(t["root"].get("children", [])))
print([(p["level"], p["density"], p["cell"], p["step"]) for p in r["profile"]])
print(r["perLevel"])
'
```

Run pipeline tests:

```bash
/Volumes/WD_BLACK/conda/envs/pointcloud-pipeline/bin/python \
  -m unittest pipeline.tests.test_build_spatial_lod_tree -v

/Volumes/WD_BLACK/conda/envs/pointcloud-pipeline/bin/python \
  -m unittest pipeline.tests.test_upgrade_spatial_lod_p001 -v
```

Run the viewer build and whitespace validation:

```bash
cd viewer
npm run build
cd ..
git diff --check
```

`viewer/src/spatial-lod.test.ts` contains the adaptive-budget contract tests,
but the current viewer package does not declare or install Vitest. Run them
only when the binary is available, and do not report them as passed when it is
missing:

```bash
cd viewer
if [ -x ./node_modules/.bin/vitest ]; then
  ./node_modules/.bin/vitest run src/spatial-lod.test.ts
else
  echo "Vitest unavailable; viewer build is the executable validation"
fi
```

Adding Vitest changes project dependencies; do that only when dependency
changes are within the requested scope.

Use `--full-validate` on the upgrade script only when explicitly needing every PNTS header checked. Default fast validation is preferred for large outputs.

## Diagnostics

- Initial visible points jump to about 20M or the UI flickers 20M -> 0: confirm the canonical report starts with `z0 p001`, not old `z0 p02`; restart `pipeline:serve`; hard reload.
- Initial whole-scene load is still heavy: inspect `z0.points`, z0 byte size, `spatialLodTargetPoints`, effective SSE, selected points, frame-time EMA, memory, traversal policy, and whether the browser is loading stale backup paths.
- Overview/Explore/Detail buttons do not change Spatial LOD: this is expected. Spatial LOD uses one adaptive runtime; diagnose the budget controller and runtime metrics instead of preset switching.
- One side of the screen is dense and another sparse: verify LOD is fixed grid z/x/y, not Area dataset switching; inspect `viewer/src/spatial-lod.ts` dataset resolution.
- `Unexpected duplicate z1 p02 tile while splitting old z0`: duplicate split fragments are valid at old z0 boundaries; merge fragments per z1 tile instead of failing.
- `rewriting tileset tree...` appears slow: it should only rewrite metadata and validate. Add progress logs, use fast validation by default, and avoid reading every PNTS header unless `--full-validate` was requested.
- Root `tileset.json` missing after an interrupted upgrade: if state/fragments exist, run the upgrade with `--resume`; do not promote until root `tileset.json` and `spatial-lod-report.json` exist.
- `--promote-existing` fails: ensure the target folder has a completed `tileset.json`; validate target before replacing canonical.
- Missing or stale p001 upgrade state: if `.spatial-lod-p001-upgrade-state.json` is absent, `--resume` cannot skip COPC streaming.
- Missing z4 `viewerRequestVolume`: inspect tree rewrite logic; z4 leaves should preserve or synthesize lightweight request volumes.
- Parent bbox containment failure: inspect tile index math, old-to-new level mapping, z-range union, and relative URI rebasing before relaxing validation.
- No detail appears when zooming close: check z4 request volumes, effective SSE, controller state, selected-point/frame/memory pressure, queue settlement, Cesium network 404s, and geometric-error monotonicity.

## Safe Change Workflow

Before editing an indexed function, class, or method:

1. Use GitNexus query/context for unfamiliar flows.
2. Run upstream impact analysis on each symbol to be changed.
3. Warn before editing when risk is HIGH or CRITICAL.
4. Preserve unrelated dirty-worktree changes.

After editing:

1. Run the smallest relevant Python and viewer tests.
2. Run `git diff --check`.
3. Run GitNexus `detect_changes` before committing.
4. Report generated-output changes separately from source-code changes.

## Completion Criteria

Consider Spatial LOD work complete only when:

- The canonical output report shows the intended p001/p02/p10/p50/p100 profile.
- The entry root has the ENU transform and 27-ish z0 external children for Peru B2.
- All content URIs are relative, non-escaping, and reachable.
- Geometric errors decrease monotonically.
- Parent boxes contain child boxes.
- Initial viewer load uses z0 p001 and does not request p100 too early.
- Zooming anywhere refines spatially around the camera, not by area.
- Preset clicks do not replace the Spatial LOD dataset or bypass the adaptive budget controller.
- Runtime metrics stay within the intended point/memory/frame budgets or visibly coarsen SSE under pressure.
- Relevant tests/builds pass or skipped checks are explicitly justified.
