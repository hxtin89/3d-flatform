# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope

This directory (`viewer/`) is the Vite + TypeScript frontend of a larger point-cloud project. The repo root (`../`) holds the LAZ → PDAL → COPC → 3D Tiles pipeline (bash scripts in `../pipeline/`, driven by `../package.json` `pipeline:*` scripts) that produces the tilesets this viewer consumes. Root `README.md` documents that pipeline; `../.agents/skills/*/SKILL.md` document individual pipeline stages (notably `one-lod-tree`, the core streaming concept below).

Two apps share this Vite project, each with its own HTML entry:
- `index.html` → CesiumJS point-cloud viewer (the original app; source referenced by root README as `src/main.ts` etc.).
- `threejs-test.html` → **Three.js / WebGPU immersive map app** in `src/threejs-test/` (imperative, `main.ts` orchestrator). `vite.config.ts` auto-opens this entry.
- `r3f.html` → **React Three Fiber port** in `src/r3f/` (React 19, R3F 9, zustand, react-spring). Same features minus field models/model editor; imports the pure logic modules of `src/threejs-test/` (config, streaming, globe layers, TSL materials) unchanged. See "React app" below.

## Commands

```bash
npm run dev            # Vite dev server on :5177, all interfaces, opens threejs-test.html
npm run dev:https      # same but HTTPS (self-signed) — WebGPU on a phone needs a secure context
npm run build          # tsc (typecheck, noEmit) + vite build --base=/livingdashboard/ + prepare-livingdashboard.mjs
npm run preview        # preview the livingdashboard build
npm run audio:prepare  # regenerate browser audio loops from source-assets/ (writes to public/sounds/)
node scripts/r3f-smoke.mjs <url> [--enter] [--takeover] [--panel] [--series=N] [--hideLoader] [--drag] [--out=dir]
                       # headless Chrome (WebGPU) smoke run of r3f.html: boots, screenshots, dumps window.__log
```

There is **no test runner and no linter** in this package. `tsc` (via `npm run build`) is the only static check; `tsconfig.json` is `strict` but `noUnusedLocals`/`noUnusedParameters` are off. There is no way to run "a single test" here.

Tiles are served separately by the root pipeline (`cd ..; npm run pipeline:serve` → static tiles on :8081); the dev server proxies `/tiles` there. In practice the Three.js app loads tiles from CloudFront by default (see env below), not the local proxy.

### Runtime configuration

`.env` (gitignored; see `.env.example`) supplies Vite `VITE_*` vars read in `src/threejs-test/main.ts`:
- `VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN` + `VITE_POINTCLOUD_TILES_FOLDER` → tileset base URL.
- `VITE_MAPTILER_API_KEY` → optional MapTiler satellite basemap.

URL query params (parsed at top of `main.ts`): `?dataset=` (default `peru-b2-globe`), `?webgl` (force WebGL instead of WebGPU), `?nosnap` (disable ground-snapping), `?modelEditor=1` (enable the in-page model transform editor).

## Architecture — Three.js/WebGPU app (`src/threejs-test/`)

`main.ts` (~1.5k lines) is the orchestrator: it owns the `WebGPURenderer` (falls back to WebGL), the render loop, the HTML preloader, and wires every layer together. The rest are focused modules it composes.

**One adaptive streaming path (the "One LOD Tree").** The central design: a single `TilesRenderer` (`3d-tiles-renderer`) traverses one external 3D-Tiles chain that links density bands **Overview p02 → Explore p10 → Detail p100** through nested `tileset-one-lod-tree.json` sidecars. One renderer owns traversal, downloads, CPU cache, and GPU residency for every zoom level — there is no separate loader per LOD. See `../.agents/skills/one-lod-tree/SKILL.md` for how the pipeline builds that chain and its invariants.
- `streaming.ts` — wraps `TilesRenderer`, sets cache/GPU/download budgets, installs plugins. Notable: a custom `ViewerRequestVolumePlugin` (because the current 3DTilesRendererJS release ignores `viewerRequestVolume`, without which p10 and p100 refine together and defeat the single-tree design), a `FrustumMaskRegion` (`LoadRegionPlugin`) that culls out-of-mask tiles from *fetch/refine/render*, and per-tile (not shared) materials because `UnloadTilesPlugin` disposes a hidden tile's material.
- `adaptive-quality.ts` — device-agnostic feedback controller. Same UI/data on every device; it raises "pressure" (coarser SSE) when FPS drops or visible points exceed budgets, and lowers it on recovery. `baseSseForRange()` sets the target refinement per camera ground range.
- `manifest.ts` — reads `area-manifest.json`: the ENU→ECEF `rootTransform` that places local-ENU point coords on the WGS84 globe, survey bbox, and the derived One-LOD-Tree dataset path.

**Placement / camera.** `globe.ts` builds the WGS84 globe + basemap; the manifest `rootTransform` positions the local point-cloud ENU frame onto it. `keyboard-navigation.ts` provides frame-rate-independent pan/zoom that scales with camera range. All flight/camera/marker tuning lives in `config.ts`.

**Environment & atmosphere.** `environment-layer.ts` (largest layer) drives a Peru-timezone daylight cycle (sky/fog/light colors, sun direction), a performance-`tier` classifier (`constrained`/`balanced`/`strong`), and volumetric cloud state. Clouds are TSL (Three Shading Language, `three/tsl`) raymarched volumes — see `tsl-raymarch.ts`, `cloud-noise.ts`, and the `MeshBasicNodeMaterial`/node-material usage. `rain-layer.ts`, `audio-layer.ts` (day/night/rain ambient loops with fades), and the point-cloud daylight grading in `point-cloud.ts` all react to the same daylight/tier state.

**Field assets.** `field-model-layer.ts` loads GLTF props (tower, boat, parrots — offsets in `config.ts`), optionally driven by `model-transform-editor.ts` when `?modelEditor=1`. `marker-layer.ts` renders interactive hotspots that trigger Bézier camera flights.

**Loader = benchmark.** `eagle-bench.ts` renders a real point-cloud eagle during load whose density follows load progress; it measures frame time to pick a starting performance tier so weak hardware never discovers its limits through jank mid-session. `stats.ts` is the FPS meter.

**`config.ts`** is the single source of product-facing tuning (flight paths, navigation clearances, keyboard speeds, cloud/atmosphere/audio/rain parameters, field-asset transforms) — all values in metres and milliseconds. Prefer changing constants here over hardcoding in layers.

## Architecture — React app (`src/r3f/`)

Entry `r3f.html` → `main.tsx` → `App.tsx`. `canvas/CanvasRoot.tsx` uses R3F's `createRoot` on its own canvas with an explicit window size (`<Canvas>` measures with a ResizeObserver, which never fires in a hidden tab). `<Canvas flat>`-equivalent: tone mapping off, WebGPURenderer via the async `gl` factory.

- **Frame order** is fixed by `frame-phases.ts` (negative `useFrame` priorities): ORIGIN → CAMERA → CONTROLS → MASK → CUTOFF → PLANES → STREAM → ENVIRONMENT → LAYERS → RAIN → AUDIO → HUD, then R3F renders. Never add a positive priority (it disables R3F's automatic render).
- **State**: `state/frame.ts` is the mutable per-frame object (never React state); `state/boot-store.ts` (boot phases), `state/scene-store.ts` (imperative layer handles), `state/ui-store.ts` (what React renders, throttled snapshots) are zustand stores read with `getState()` inside frame code. `state/survey-frames.ts` owns the ENU/render frames, floating-origin rebase and navigation floor.
- **Layers** are the old `createXxxLayer` factories mounted in `useEffect` (`scene/*.tsx`), each updating in its phase. Node materials are always built imperatively; drei is only used for renderer-agnostic parts.
- **Camera**: `camera/camera-rig.ts` is the single camera writer in story/resume/fly-to modes — react-spring `SpringValue`s on azimuth/elevation/log-range offsets over an orbit base that already turns, so the descent is the orbit (config `story`). Controls stay enabled; a controls `start` event or a navigation key takes over (`rig.takeover()`), `rig.resume()` blends back velocity-continuously. `controls/wild-globe-controls.ts` replaces the library's per-frame scene raycasts with the analytic ellipsoid and leaves near/far to `scene/Atmosphere.tsx`.

### Conventions

- Layer modules export a `createXxxLayer(...)` factory returning an interface with `update(...)` / `dispose()`; `main.ts` calls `update` each frame and `dispose` on teardown. Follow that shape for new layers.
- WebGPU is primary (`three/webgpu`, `three/tsl`); code must degrade to WebGL (`?webgl` and automatic fallback). Don't assume WebGPU-only features without a fallback.
- German UI strings are intentional (status/loader text is user-facing German).

## Deployment

`npm run build` targets an Apache mount at base `/livingdashboard/`. `scripts/prepare-livingdashboard.mjs` post-processes `dist/`: it copies the Three.js entry over `index.html` (so the immersive app is the default page) and flattens the Cesium plugin output. Keep that base/flatten behavior intact if you touch the build.
