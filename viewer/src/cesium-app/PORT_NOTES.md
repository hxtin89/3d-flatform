# Cesium Port — Engineering Notes (spec for all work packages)

Port of `src/threejs-test/` (three.js/WebGPU) to CesiumJS 1.142. **Zero imports from
`src/threejs-test/` or the legacy flat `src/*.ts` viewer** — this folder must be
independently deletable. Renderer-agnostic modules are verbatim copies.

Data: same as the three.js app — APH point tileset
`${baseUrl}/${manifest.adaptiveHierarchyDataset}/${manifest.adaptiveHierarchyTilesetFile}`,
MapTiler satellite-v4 raster, ENU→ECEF `rootTransform` from `area-manifest.json`.

## Fair-comparison viewer contract (WP1, pin explicitly)

```ts
new Cesium.Viewer(container, {
  requestRenderMode: false,
  useBrowserRecommendedResolution: false,   // default true would force pixelRatio 1!
  contextOptions: { webgl: { antialias: false, powerPreference: 'high-performance' } },
  msaaSamples: 1,
  shadows: false,
  scene3DOnly: true,
  // all widgets off (animation, timeline, baseLayerPicker, geocoder, homeButton,
  // sceneModePicker, navigationHelpButton, fullscreenButton, infoBox, selectionIndicator)
})
viewer.targetFrameRate = undefined
viewer.scene.postProcessStages.fxaa.enabled = false
viewer.scene.highDynamicRange = false
viewer.scene.logarithmicDepthBuffer = true   // keep ON (globe precision + depth reconstruction); documented delta vs three
viewer.scene.globe.baseColor = dark
Cesium.Ion.defaultAccessToken = ''           // no Ion
// DPR cap parity: three caps setPixelRatio(min(dpr, cap)) ⇒
viewer.resolutionScale = Math.min(devicePixelRatio, cap) / devicePixelRatio
```

Tileset parity pins (WP2):

```ts
tileset.dynamicScreenSpaceError = false
tileset.foveatedScreenSpaceError = false
tileset.cullRequestsWhileMoving = false
tileset.preloadFlightDestinations = false
tileset.progressiveResolutionHeightFraction = 0
tileset.skipLevelOfDetail = false
tileset.pointCloudShading.attenuation = false
tileset.pointCloudShading.eyeDomeLighting = false
tileset.cacheBytes / maximumCacheOverflowBytes = budgets
// Log tileset.memoryAdjustedScreenSpaceError — Cesium silently coarsens when over budget.
```

## Point rendering (WP2) — CustomShader, single source of truth

- `CustomShaderMode.REPLACE_MATERIAL` + `LightingModel.UNLIT`. Never mix with
  `Cesium3DTileStyle` (documented as undefined together).
- Vertex: `vsOutput.pointSize = u_pointSizeCss * czm_pixelRatio;` (gl_PointSize is
  drawing-buffer px). If a vertex shader exists it OWNS size — always assign.
  Large sizes clamp at ALIASED_POINT_SIZE_RANGE.
- **RTC trap**: `${POSITION}` / `fsInput.attributes.positionMC` is tile-local
  (RTC_CENTER). Never derive ENU from it. Instead compose per frame on CPU:
  `u_eyeToEnu = inverse(rootEnuToEcef) * camera.inverseViewMatrix`
  and transform `positionEC` in the shader. Avoids float32 ECEF subtraction too.
- Fragment ports point-cloud.ts semantics: color from `fsInput.attributes.color_0`
  (check sRGB→linear manually for parity), daylight multiply (u_daylightColor,
  u_daylightIntensity), golden rim as the height-based proxy (no normals in PNTS),
  cloud-shadow dim sampling `u_cloudShadow` (a **sampler2D** slice — CustomShader has
  no sampler3D; three already samples the 3D noise at fixed w=0.5), wind offset
  uniform, vignette mask: ENU radial `discard` + brightness falloff.
- `gl_PointCoord` available for a circular sprite mask if needed.
- Do NOT rebuild three's high-precision model-view path — Cesium's RTE pipeline
  already handles precision.

## Clouds (WP6)

- **Volume tier: PostProcessStage** (not box primitives — no clean scene-depth access
  from a primitive's fragment shader). `textureScale: 0.5`. Depth reconstruction:
  `vec4 positionEC = czm_windowToEyeCoordinates(gl_FragCoord.xy, texture(depthTexture, v_textureCoordinates).r);`
  (two-arg overload decodes log depth — do NOT pre-decode with czm_readDepth).
  positionEC → ENU via u_eyeToEnu, ray-box the cloud AABB, march tEnter…min(tExit, depth),
  depth 1.0 = sky. Noise: 2D slice atlas + manual trilinear.
  Post stages run after tonemapping when HDR is on — HDR is off here, fine.
- **Soft tier: Cesium CloudCollection/CumulusCloud** (procedural billboards,
  `noiseDetail: 16`). No depth write; do not combine with the volume tier (mutually
  exclusive modes, like the three app).
- fps guard + bounded promotion: copy the state machine from three
  environment-layer (volumeFallbackFps 50 / disableFps 45 / 3 s; promoteFps 57 /
  12 s / maxPromotions 2).

## Camera (WP3)

- Keep `screenSpaceCameraController`; configure: `minimumZoomDistance` (NB: height
  above ellipsoid, NOT orbit distance — enforce the survey orbit radius separately
  in a `scene.preUpdate` clamp against `camera.positionWC`), tilt limit, inertia
  values pinned; collision detection decided at parity test.
- WASD in `scene.preUpdate` with real delta seconds (copy keyboard-navigation
  speeds/keymap), ENU basis, clamp height.
- Flights: evaluate the copied Bezier in ENU per frame → `camera.setView({destination,
  orientation})` in preUpdate. `camera.flyTo` cannot follow the curve nor report
  progress (needed for flightSseFloor + cloud reveal).
  `screenSpaceCameraController.enableInputs = false` during flight; restore + reset
  state on landing.
- Transform points `Matrix4.multiplyByPoint(rootTransform, …)`, directions
  `multiplyByPointAsVector`.

## 3DGS (WP11)

- Converter: `@playcanvas/splat-transform` (reads INRIA ply — exp scales, sigmoid
  opacity, quat order, SH0 0.2820948·f_dc+0.5 — writes KHR_gaussian_splatting GLB;
  depends on @adobe/spz).
- **Cesium 1.142 routing gotcha**: the content factory picks the splat renderer only
  when `3DTILES_content_gltf` declares BOTH `KHR_gaussian_splatting` AND
  `KHR_gaussian_splatting_compression_spz_2` — plain uncompressed KHR-only GLB may
  route through the normal model path. Prefer SPZ_2-compressed output.
- Wrapper: 3D Tiles 1.1 tileset.json — root `boundingVolume.box` (include gaussian
  scale extents, not just centers), `geometricError: 0`, single content.uri, root
  `transform` = ENU→ECEF placement, `3DTILES_content_gltf` extension declarations.
- Axes: INRIA is Z-up; Z-up→glTF Y-up = Rx(−90°) `(x,y,z)→(x,z,−y)`; splat-transform
  applies its own PLY convention — do not flip twice. Prefer a rigid glTF node
  transform for the residual correction. Validate handedness/quat/SH with a small
  landmark asset before the 61 MB file. Single tile OK for 258k splats; 1.9 GB source
  must NOT be a single tile.

## Misc parity pins

- `orderIndependentTranslucency`, globe imagery SSE, atmosphere, bloom, AO — pin and
  document. Steady-state FPS measured after `tileset.tilesLoaded` + network settle.
- Loader progress: blend point-tileset loaded ratio + `globe.tilesLoaded`; keep the
  stall watchdog from three main.ts.
- One time source: `viewer.clock.currentTime` derived from Peru minutes, never read back.
- `import.meta.env.BASE_URL` for all public/ assets (audio, models, eagle SVG).
- German product strings stay German; the test/panel UI is English.
