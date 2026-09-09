# Remove the Cesium route

**Decided 2026-09-09.** Three.js/WebGPU is the product. The Cesium route will never be
continued, so it gets deleted rather than kept as a reference.

## Why this is safe

`src/threejs-test/` reaches outside its own folder for exactly one import — `../maptiler-key`.
Nothing else crosses the boundary in either direction. The two routes share `public/`
(models, sounds, the eagle SVG) and nothing more.

Scope: roughly **21,500 lines over ~45 files**.

## 1 — Delete outright

| Path | Notes |
|---|---|
| `viewer/src/cesium-app/` | 28 files, ~10,000 lines, incl. `tools/ply-to-splat-tileset.mjs` |
| `viewer/index.html` | Cesium point-cloud viewer entry |
| `viewer/cesium-test.html` | Cesium immersive-globe entry |
| `viewer/src/main.ts` | |
| `viewer/src/viewer.ts` | |
| `viewer/src/ui.ts` | |
| `viewer/src/report.ts` | |
| `viewer/src/presets.ts` | |
| `viewer/src/manifest.ts` | Cesium-side; the Three.js app has its own `src/threejs-test/manifest.ts` |
| `viewer/src/style.css` | `threejs-test.html` carries its own inline `<style>` |
| `viewer/src/adaptive-point-hierarchy.ts` + `.test.ts` | Cesium-side implementation |
| `viewer/src/one-lod-tree.ts` + `.test.ts` | Cesium-side implementation |
| `viewer/src/spatial-lod.ts` + `.test.ts` | Cesium-side implementation |
| `viewer/src/overview-sse-controller.ts` | |

Kept at `viewer/src/` root: `dev-hosts.ts`, `maptiler-key.ts`, `vite-env.d.ts`, `types/`.

Nothing in `viewer/public/` goes — every model, sound and SVG is shared.

## 2 — Build config

`viewer/vite.config.ts`
- drop the `cesium()` plugin and its import
- drop the `main` and `cesium-test` rollup inputs, leaving `threejs-test`
- the `serveThreeJsAtRoot()` redirect stays; its doc comment needs rewording, since
  "the Cesium viewer stays reachable at /index.html" stops being true

`viewer/package.json`
- remove deps `cesium`, `vite-plugin-cesium`
- remove devDep `@playcanvas/splat-transform` — its only consumer was the splat tool
- keep `@sparkjsdev/spark`: the Three.js splat layer imports it
- remove the dead `"test": "vitest run"` — vitest is not installed and its only targets
  were the three `.test.ts` files above. `bench:verify` stays.
- rename `sbb-cesium-viewer` / "CesiumJS point cloud viewer — local self-hosted pipeline"

## 3 — Build post-process

`viewer/scripts/prepare-livingdashboard.mjs`
- drop the `cesium.html` preservation copy
- drop the `dist/livingdashboard/cesium` → `dist/cesium` flatten
- the `rm(dist/livingdashboard)` is probably also obsolete — that directory exists
  *because* `vite-plugin-cesium` bakes Vite's `base` into its output path. Confirm with a
  real build rather than assuming.
- shrink the root-relative-asset check loop to the entries that still exist

The source file stays `threejs-test.html`, so deployed URLs do not move. Renaming it to
`index.html` would be tidier but 404s any bookmark to `/livingdashboard/threejs-test.html`.

## 4 — Docs

- `viewer/CLAUDE.md` — real rewrite. Its whole "Two apps share this Vite project" framing
  goes, along with the Cesium half of the Deployment section.
- root `README.md` — 2 mentions.
- root `package.json` description ends "→ CesiumJS".
- `src/threejs-test/manifest.ts:4` points at "the Cesium viewer's `src/manifest.ts`" for
  the full manifest schema. That reference dangles; inline what it says.

Left alone on purpose: `plans/` and `.agents/skills/`. They are a historical record, and
the pipeline skills describe tile formats we still consume.

## 5 — Verify

- `npm run build` in `viewer/` (tsc + vite build + the post-process) — the only static
  check this package has.
- `npm run dev` and load the app: panel, basemap and point cloud all come up.
- confirm `dist/` has no `cesium/` directory and no stray `livingdashboard/`.
