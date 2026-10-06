# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope

This directory (`viewer/`) is the Vite + TypeScript frontend of a larger point-cloud project. The repo root (`../`) holds the LAZ → PDAL → COPC → 3D Tiles pipeline (bash scripts in `../pipeline/`, driven by `../package.json` `pipeline:*` scripts) that produces the tilesets this viewer consumes. Root `README.md` documents that pipeline; `../.agents/skills/*/SKILL.md` document individual pipeline stages (notably `one-lod-tree`, the core streaming concept below).

One app, one HTML entry: `threejs-test.html` → the **Three.js / WebGPU immersive map app** in `src/threejs-test/`, which is where essentially all the code below lives. `vite.config.ts` auto-opens it and redirects `/` to it.

A CesiumJS viewer used to share this project at `index.html`, with its own copy of the LOD code at `src/` root. That route was abandoned and deleted on 2026-09-09 (see `../plans/plan-remove-cesium.md`); older commits, plans and skill docs still describe it. Outside `src/threejs-test/`, only `dev-hosts.ts`, `maptiler-key.ts`, `types/` and `vite-env.d.ts` remain.

## Commands

```bash
npm run dev            # Vite dev server on :5177, all interfaces, opens threejs-test.html
npm run dev:https      # same but HTTPS (self-signed) — WebGPU on a phone needs a secure context
npm run build          # tsc (typecheck, noEmit) + vite build --base=/livingdashboard/ + prepare-livingdashboard.mjs
npm run preview        # preview the livingdashboard build
npm run audio:prepare  # regenerate browser audio loops from source-assets/ (writes to public/sounds/)
```

There is **no linter** in this package, and no general test runner: `npm run bench:verify` runs the handful of `src/threejs-test/*.test.ts` files under `node --test`, and `tsc` (via `npm run build`) is the only static check. `tsconfig.json` is `strict` but `noUnusedLocals`/`noUnusedParameters` are off.

Tiles are served separately by the root pipeline (`cd ..; npm run pipeline:serve` → static tiles on :8081); the dev server proxies `/tiles` there. In practice the Three.js app loads tiles from CloudFront by default (see env below), not the local proxy.

### Runtime configuration

`.env` (gitignored; see `.env.example`) supplies Vite `VITE_*` vars read in `src/threejs-test/main.ts`:
- `VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN` + `VITE_POINTCLOUD_TILES_FOLDER` → tileset base URL.
- `VITE_MAPTILER_API_KEY` → optional MapTiler satellite basemap.

URL query params (parsed in `main.ts`): `?dataset=` (default `peru-b2-globe`), `?webgl` (force WebGL instead of WebGPU), `?nosnap` (disable ground-snapping), `?modelEditor=1` (enable the in-page model transform editor), `?thinning=off` (ship without distance thinning — a load-time switch, not a button, because the per-tile cost is paid on arrival and the cache never evicts), `?tonemap=film|shoulder|none|neutral|agx|aces` (overrides `toneMapping.mode`, default `film`, for an A/B; unknown values fall back to the config — see `tone-mapping.ts`), `?tonemap=off` (boots with the whole tone stage off: the pre-tone-mapping shader, for fps comparisons), `?vfog=0|1` (boots the volumetric ground fog off or on — `ground-fog.ts`), `?bgclock` (test hook: frames, paced to 60 Hz, and timers from a MessageChannel, so the app runs in a hidden or background tab for automated captures; frame times are meaningless under it, GPU timestamps are not — `hidden-pane-clock.ts`), `?edl=0|1` and `?dof=0|1` (boot with eye-dome lighting or depth of field off or on whatever the config says — both ship on; with both off and `?vfog=0` no post pass runs, the baseline for fps comparisons; `eye-dome-lighting.ts`, `depth-of-field.ts`), `?sky=0|1` (the physically based sky, sun light and aerial perspective; off is the graded sky and haze curve of before — `sky-atmosphere.ts`), `?shadows=0|1` (the canopy's soft sun shadows — `sun-shadows.ts`), `?clouds=0|1|<preset>` (the sky's dome clouds and their shadows, optionally with a weather preset: clear, fair, scattered, golden, mist, overcast, storm — `sky-clouds.ts`), `?apvol=0|1|ref|dircheck` (the physical sky's aerial perspective from the camera volume, the default, or per pixel with 0; `ref` is a per-pixel reference march and `dircheck` shows the froxel directions' error, both for development — `sky-atmosphere.ts`).

## Architecture — Three.js/WebGPU app (`src/threejs-test/`)

`main.ts` (~1.5k lines) is the orchestrator: it owns the `WebGPURenderer` (falls back to WebGL), the render loop, the HTML preloader, and wires every layer together. The rest are focused modules it composes.

**One adaptive streaming path (the "One LOD Tree").** The central design: a single `TilesRenderer` (`3d-tiles-renderer`) traverses one external 3D-Tiles chain that links density bands **Overview p02 → Explore p10 → Detail p100** through nested `tileset-one-lod-tree.json` sidecars. One renderer owns traversal, downloads, CPU cache, and GPU residency for every zoom level — there is no separate loader per LOD. See `../.agents/skills/one-lod-tree/SKILL.md` for how the pipeline builds that chain and its invariants.
- `streaming.ts` — wraps `TilesRenderer`, sets cache/GPU/download budgets, installs plugins. Notable: a custom `ViewerRequestVolumePlugin` (because the current 3DTilesRendererJS release ignores `viewerRequestVolume`, without which p10 and p100 refine together and defeat the single-tree design), a `FrustumMaskRegion` (`LoadRegionPlugin`) that culls out-of-mask tiles from *fetch/refine/render*, and per-tile (not shared) materials because `UnloadTilesPlugin` disposes a hidden tile's material.
- `adaptive-quality.ts` — device-agnostic feedback controller. Same UI/data on every device; it raises "pressure" (coarser SSE) when FPS drops or visible points exceed budgets, and lowers it on recovery. `baseSseForRange()` sets the target refinement per camera ground range. **As of 2026-08-24 nothing reads that pressure value** — the SSE comes from the band ladder alone (APH 4/8/16, One-LOD 64/124/256, hysteresis on the edges), and `main.ts` feeds it the slant range to the ground ahead so the target follows the view angle as well as the height.
- `manifest.ts` — reads `area-manifest.json`: the ENU→ECEF `rootTransform` that places local-ENU point coords on the WGS84 globe, survey bbox, and the derived One-LOD-Tree dataset path.

**Placement / camera.** `globe.ts` builds the WGS84 globe + basemap; the manifest `rootTransform` positions the local point-cloud ENU frame onto it. `keyboard-navigation.ts` provides frame-rate-independent pan/zoom that scales with camera range. All flight/camera/marker tuning lives in `config.ts`.

**Environment & atmosphere.** `environment-layer.ts` (largest layer) drives a Peru-timezone daylight cycle (sky/fog/light colors, sun direction), a performance-`tier` classifier (`constrained`/`balanced`/`strong`), and volumetric cloud state. Clouds are TSL (Three Shading Language, `three/tsl`) raymarched volumes — see `tsl-raymarch.ts`, `cloud-noise.ts`, and the `MeshBasicNodeMaterial`/node-material usage. `rain-layer.ts`, `audio-layer.ts` (day/night/rain ambient loops with fades), and the point-cloud daylight grading in `point-cloud.ts` all react to the same daylight/tier state. `atmosphere-haze.ts` adds distance haze (`scene.fogNode`, which takes precedence over the `scene.fog` distance fog) and a horizon-to-zenith sky (`scene.backgroundNode`, over `scene.background`), each with its own switch that sets the node to null. `ground-fog.ts` ray-marches the volumetric ground fog, a post pass in the depth-of-field pipeline that reads the scene depth: density from one tileable 2D noise texture for coverage, billows and erosion plus a fixed 64³ 3D texture for the height detail (`noiseSource: '3d'`, the default; `fog-noise.ts`, baked in `fog-noise.worker.ts`, inspected and edited in `fog-noise-editor.ts`), light from the scene's sun with a Mie / Rayleigh phase and multiple-scattering octaves (`fog-optics.ts`); steps and resolution per quality preset in `config.ts`. The output look lives in `tone-mapping.ts` (`film` by default; every film part compiles out when switched off).

**Sky package.** `sky-atmosphere.ts` renders Hillaire's atmosphere (the model, tested, in `atmosphere-model.ts`) into small fragment-pass lookup tables, draws the sky with a full-resolution sun disc as `scene.backgroundNode` and aerial perspective as `scene.fogNode` (both through `atmosphere-haze.ts`'s physical mode; the aerial perspective comes from a camera-frustum volume — 32 × 32 froxels × 32 distance slices in one atlas, drawn in one fragment pass when the view moves, read with two fetches per pixel, arithmetic in `aerial-volume-math.ts` — or per pixel with `?apvol=0`), and captures the sky's irradiance for the light uniforms. The points and basemap are relit by it (`effects.sunLight` in `point-cloud.ts`: no normals, so a side-light blend), the fog takes its sun and sky light from it. `sun-shadows.ts` splats a fixed share of every loaded tile's points from the sun into an additive optical-depth height-moment map fitted to the sphere-fade dome (per-tile proxies in a private scene, a caster graph from `point-cloud.ts`; nothing but the dome's falloff follows the camera, so the shadows hold still as it moves), blurred in metres; points, basemap and every fog step read it. `sky-clouds.ts` bakes one procedural cloud field (`sky-cloud-noise.ts`, a worker) into a progressive, cross-faded dome panorama and a cloud-shadow map the same receivers read; weather presets live in `config.ts` (`skyClouds.presets`). `sky-panel.ts` builds the Sky & sun, Sun shadows and Sky clouds panel sections; `main.ts` `applySkyPackage()` keeps their switches consistent. Every part compiles out when switched off.

**Field assets.** `field-model-layer.ts` loads GLTF props (tower, boat, parrots — offsets in `config.ts`), optionally driven by `model-transform-editor.ts` when `?modelEditor=1`. `marker-layer.ts` renders interactive hotspots that trigger Bézier camera flights.

**Loader = benchmark.** `eagle-bench.ts` renders a real point-cloud eagle during load whose density follows load progress; it measures frame time to pick a starting performance tier so weak hardware never discovers its limits through jank mid-session. `stats.ts` is the FPS meter.

**`config.ts`** is the single source of product-facing tuning (flight paths, navigation clearances, keyboard speeds, cloud/atmosphere/audio/rain parameters, field-asset transforms) — all values in metres and milliseconds. Prefer changing constants here over hardcoding in layers.

### Conventions

- Layer modules export a `createXxxLayer(...)` factory returning an interface with `update(...)` / `dispose()`; `main.ts` calls `update` each frame and `dispose` on teardown. Follow that shape for new layers.
- WebGPU is primary (`three/webgpu`, `three/tsl`); code must degrade to WebGL (`?webgl` and automatic fallback). Don't assume WebGPU-only features without a fallback.
- UI strings are English throughout — loader, HUD, panel labels and their
  descriptions, status and ARIA text. They used to be German; if you find a German
  string in user-facing text it is a leftover, not a decision. Source comments are
  a separate matter and some are still German.

## Deployment

`npm run build` targets an Apache mount at base `/livingdashboard/`. Vite builds the single `threejs-test.html` entry; `scripts/prepare-livingdashboard.mjs` then copies it over `index.html` so the app is the default page, checks both files for root-relative asset paths that would escape the base, and writes the `.htaccess`. Keep that base behaviour intact if you touch the build.
