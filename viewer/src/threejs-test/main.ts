// Three.js globe + point cloud with one adaptive streaming path on every device.
// The One LOD Tree moves from Overview p02 to Explore p10 and Detail p100 while
// one renderer owns traversal, downloads, CPU cache and GPU residency.
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import {
  createUniforms, setCloudShadowTexture, setGroundPatchMask,
  setCloudEffectEnabled, type CloudEffect,
} from './point-cloud'
import { createCloudNoiseTexture } from './cloud-noise'
import { createGlobe, type Globe } from './globe'
import { createFoveation, type Foveation, type FoveationSettings } from './foveation'
import { createStreamingCloud, type StreamingCloud, type StreamingStats } from './streaming'
import { fetchGlobeManifest } from './manifest'
import { AdaptiveQualityController, APH_BAND_SSE } from './adaptive-quality'
import { createMarkerLayer, type MarkerActionTarget, type MarkerLayer } from './marker-layer'
import { createRainLayer, type RainLayer } from './rain-layer'
import { Fps } from './stats'
import { EXPERIENCE_CONFIG } from './config'
import {
  assetUrl as shapeAssetUrl, fetchDonationShape,
  type DonationShapeForm, type DonationShapeSource, type DonationShapeStyle,
} from './donation-shape-data'
import { createDonationShapeLayer, type DonationShapeLayer } from './donation-shape-layer'
import { createKeyboardNavigation, type KeyboardNavigation } from './keyboard-navigation'
import {
  classifyTier,
  createEnvironmentLayer,
  type CloudState,
  type DaylightState,
  type EnvironmentLayer,
  type PerformanceTier,
} from './environment-layer'
import { createFieldModelLayer, type FieldModelLayer } from './field-model-layer'
import { createAudioLayer, type AudioLayer } from './audio-layer'
import { createEagleBench, type BenchPreset, type EagleBench } from './eagle-bench'
import { EAGLE_MIN_ASSEMBLY_SECONDS } from './eagle-bench-motion'
import { createModelTransformEditor, type ModelTransformEditor } from './model-transform-editor'
import { createCameraFlight, type EnuOffset } from './camera-flight'
import { flightSseFloor } from './flight-quality'
import { createDepthOfFieldLayer, type DepthOfFieldLayer } from './depth-of-field'
import { createGroundPatchMask } from './ground-patch-mask'
import { createGaussianSplatLayer, type GaussianSplatLayer } from './gaussian-splat-layer'
import {
  createRenderOptions,
  RENDER_OPTION_ROWS,
  type RenderOptionKey,
  type RenderOptions,
} from './render-options'
import type { MemoryBudgetSnapshot } from './streaming'

// ---------------------------------------------------------------- config
const params = new URLSearchParams(location.search)
const domain = (import.meta.env.VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN ?? '')
  .replace(/^https?:\/\//, '').replace(/\/+$/, '')
const folder = (import.meta.env.VITE_POINTCLOUD_TILES_FOLDER ?? 'pointcloud-tiles').replace(/^\/+|\/+$/g, '')
const baseUrl = domain ? `https://${domain}/${folder}` : ''
const MAPTILER_KEY = (import.meta.env.VITE_MAPTILER_API_KEY ?? '').trim()
const dataset = params.get('dataset') ?? 'peru-b2-globe'
/** 3DGS-Machbarkeitstest: Spark rendert dieses INRIA-Splat-Modell in einem
 * eigenen WebGL-Overlay (siehe gaussian-splat-layer.ts). Kleinster ladbarer
 * Downsample der ply-result-Ablage (61 MB). */
const GAUSSIAN_SPLAT_URL = baseUrl
  ? `${baseUrl}/ply-result/point_cloud/iteration_100/point_cloud_5.ply`
  : ''
/** Which published point tree to stream. `aph` is the Adaptive Point Hierarchy
 * the Cesium reference viewer uses and the only one carrying real close-range
 * density — the published One LOD chain stops at the p02 overview band.
 * `?tree=one-lod` restores the old chain for an A/B comparison. */
const pointTree: 'aph' | 'one-lod' = params.get('tree') === 'one-lod' ? 'one-lod' : 'aph'
const forceWebGL = params.has('webgl')
const groundSnap = !params.has('nosnap')
const modelEditorEnabled = params.get('modelEditor') === '1'
/** Diagnostics: lifts the orbit ceiling, navigation floor and zoom stop so the
 * camera can reach a side-on view and the cloud/map seam can be inspected. */
const freeOrbit = params.has('freeorbit')
/** Cesium comparison: start without the loader benchmark and without the
 * boot-time pixel-ratio cap, then enable compare mode (all optimisations off,
 * only the zoom-dependent density ladder remains). Everything else is also
 * switchable live via the panel — this param covers the construction-time
 * pieces a running session cannot change. */
const compareParam = params.get('compare') === '1'
/** Shows the measured heights in the HUD. Implied by freeorbit, but available
 * on its own so the configured zoom stop can be checked while it still bites. */
const showDiagnostics = freeOrbit || params.has('diag') || import.meta.env.DEV
/** `?preset=strong|medium|constrained` overrides whatever the loader benchmark
 * measures. The benchmark samples frame times while tiles are still streaming,
 * so a hitch can collapse the median past its 60 fps threshold and pin a
 * capable machine to `constrained` — which renders at pixelRatio 1 and, since
 * basemap refinement derives from the renderer resolution, visibly softens the
 * satellite imagery. This is the escape hatch for that. */
const presetOverride: BenchPreset | null = (() => {
  const raw = params.get('preset')
  return raw === 'strong' || raw === 'medium' || raw === 'constrained' ? raw : null
})()
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
/** Protected-parcel outline. Started here, before renderer.init(), so the flight
 * can be aimed at the parcel centroid without the boot sequence ever waiting on
 * it. `?shape=` accepts an absolute URL for a future booking API. */
const donationShapeUrl = params.get('shape') ?? shapeAssetUrl(EXPERIENCE_CONFIG.donationShape.sourcePath)
const donationShapePromise: Promise<DonationShapeSource | null> = fetchDonationShape(donationShapeUrl)
  .catch((error) => {
    console.warn('[donation-shape] source unavailable', donationShapeUrl, error)
    return null
  })
const FIELD_VIDEO_URL = 'https://d2ijqnyf2ixq2j.cloudfront.net/media/smaller-image-bettter/WI-Imagefilm-WebsiteHeaderHD.mp4'

// ---------------------------------------------------------------- dom helpers
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T
const fmtInt = (value: number) => Math.round(value).toLocaleString('en-US')
const fmtMiB = (value: number) => `${Math.round(value / (1024 * 1024))} MB`
const setStatus = (text: string) => { $('#status').textContent = text }

// ---------------------------------------------------------------- preloader
const loaderEl = $<HTMLDivElement>('#loader')
const loaderPercentEl = $('#loaderPercent')
const loaderStatusEl = $('#loaderStatus')
const loaderRetryEl = $<HTMLButtonElement>('#loaderRetry')
const loaderActionsEl = $<HTMLDivElement>('#loaderActions')
const loaderStartEl = $<HTMLButtonElement>('#loaderStart')
const loaderSoundOptEl = $<HTMLButtonElement>('#loaderSoundOpt')
const loaderSoundOptLabelEl = $('#loaderSoundOptLabel')
const loaderEagleCanvasEl = $<HTMLCanvasElement>('#loaderEagleCanvas')
const loaderEagleFillEl = $<HTMLDivElement>('#loaderEagleFill')
const debugProgressRaw = import.meta.env.DEV ? params.get('eagleProgress') : null
const debugProgressParsed = debugProgressRaw === null ? Number.NaN : Number(debugProgressRaw)
const loaderDebugProgress = Number.isFinite(debugProgressParsed)
  ? THREE.MathUtils.clamp(debugProgressParsed, 0, 1)
  : null
let eagleBench: EagleBench | null = null
let bootLoading = true
let loaderReadyShown = false
let loaderDataReady = false
let startWithSound = true
let loaderTarget = 0
let loaderDisplayed = 0
let loaderLastTick = performance.now()
let loaderLastAdvance = loaderLastTick
let loaderProgressRaf = 0
let lastBenchDebugProgress: number | null = null
let loaderFinishAt = 0
let loaderFlightStarted = false
let loaderStalled = false
let loaderFailed = false
/** When the point cloud finished and the loader began waiting on the basemap. */
let basemapWaitStartedAt = 0
/** True once the loader gave up on the basemap and started without it. */
let basemapMissing = false

function paintLoaderProgress(progress: number): void {
  const percentage = Math.min(100, Math.floor(progress * 100))
  loaderEl.style.setProperty('--loader-progress', `${(progress * 100).toFixed(2)}%`)
  loaderEl.setAttribute('aria-valuenow', String(percentage))
  loaderPercentEl.textContent = String(percentage).padStart(2, '0')
  eagleBench?.setProgress(progress)
  exposeBenchDebugState()
}

function exposeBenchDebugState(): void {
  if (!import.meta.env.DEV || loaderDebugProgress === null || !eagleBench
    || lastBenchDebugProgress === loaderDisplayed) return
  loaderEagleCanvasEl.dataset.benchState = JSON.stringify(eagleBench.debugState())
  lastBenchDebugProgress = loaderDisplayed
}

// The eagle is a real point cloud whose density follows the load progress —
// the loading animation quietly benchmarks the device's point pipeline.
// Compare mode skips the probe entirely: the preset is forced to 'strong' and
// every preset-derived cap is disabled anyway.
if (compareParam) {
  loaderEagleFillEl.hidden = false
} else void createEagleBench(loaderEagleCanvasEl, { forceWebGL }).then((bench) => {
  if (!bootLoading) { bench.dispose(); return }
  eagleBench = bench
  loaderEagleCanvasEl.hidden = false
  bench.setProgress(loaderDisplayed)
  if (import.meta.env.DEV) (window as any).__eagleBenchDebug = () => bench.debugState()
  exposeBenchDebugState()
}).catch((error) => {
  loaderEagleFillEl.hidden = false
  const fallbackGhost = document.querySelector<HTMLElement>('.loader-eagle-ghost')
  if (fallbackGhost) fallbackGhost.style.opacity = '0.12'
  console.warn('[eagle-bench] unavailable — falling back to CSS eagle + heuristic tier', error)
})

function setLoadProgress(progress: number, status?: string): void {
  const next = THREE.MathUtils.clamp(progress, 0, 1)
  if (next > loaderTarget + 0.001) {
    loaderTarget = next
    loaderLastAdvance = performance.now()
    if (loaderStalled) {
      loaderStalled = false
      loaderRetryEl.hidden = true
    }
  }
  if (status) loaderStatusEl.textContent = status
}

function showLoaderReadyIfComplete(): void {
  if (!loaderDataReady || loaderDisplayed < 0.999 || loaderFinishAt > 0 || loaderReadyShown) return
  loaderDisplayed = 1
  paintLoaderProgress(loaderDisplayed)
  loaderReadyShown = true
  loaderEl.classList.add('is-ready')
  loaderEl.setAttribute('aria-busy', 'false')
  loaderActionsEl.hidden = false
  loaderStartEl.focus({ preventScroll: true })
}

function tickLoaderProgress(now: number): void {
  if (!bootLoading) return
  const elapsed = Math.min(64, Math.max(0, now - loaderLastTick))
  loaderLastTick = now
  if (loaderDebugProgress !== null) {
    loaderDisplayed = loaderDebugProgress
  } else if (loaderDisplayed < loaderTarget) {
    const maximumStep = elapsed / (EAGLE_MIN_ASSEMBLY_SECONDS * 1000)
    loaderDisplayed = Math.min(loaderTarget, loaderDisplayed + maximumStep)
  }
  paintLoaderProgress(loaderDisplayed)
  showLoaderReadyIfComplete()
  loaderProgressRaf = requestAnimationFrame(tickLoaderProgress)
}

loaderProgressRaf = requestAnimationFrame(tickLoaderProgress)

function showLoadError(message: string): void {
  loaderFailed = true
  loaderStatusEl.textContent = message
  loaderRetryEl.hidden = false
  loaderEl.setAttribute('aria-busy', 'false')
}

function updateLoaderVisual(now: number, stats: StreamingStats | null, visibleMapTiles: number): void {
  if (!bootLoading) return

  // After the ready hand-off the status line must not flip back to "loading":
  // streaming keeps refining in the background and its progress oscillates.
  // The stall notice is excluded for the same reason — it is written once by the
  // stall timer and would otherwise be overwritten on the very next frame.
  if (stats) {
    setLoadProgress(
      0.35 + 0.6 * stats.progress,
      loaderDataReady || loaderStalled ? undefined : 'Loading first canopy point clouds …',
    )
  }

  // The point cloud is the payload; the basemap is context. Waiting on both used
  // to mean an unreachable tile provider (dead key, quota, offline) pinned the
  // loader at 95% forever — 0.35 + 0.6 is that ceiling — while the cloud sat
  // fully loaded behind it. So the basemap gets a grace period and then the
  // scene starts without it.
  const pointsReady = Boolean(stats && stats.visible > 0 && stats.points > 0 && stats.progress >= 0.999)
  if (pointsReady && basemapWaitStartedAt === 0) basemapWaitStartedAt = now
  // Switching the basemap off is a decision, not a failure: there is nothing to
  // wait for, so the grace period is skipped rather than served out in silence.
  const basemapReady = visibleMapTiles > 0 || !renderOptions.effective().basemapImagery
  const basemapGaveUp = basemapWaitStartedAt > 0
    && now - basemapWaitStartedAt >= EXPERIENCE_CONFIG.loader.basemapGraceMs
  if (pointsReady && (basemapReady || basemapGaveUp) && !loaderDataReady) {
    loaderDataReady = true
    basemapMissing = !basemapReady
    if (basemapMissing) {
      console.warn('[loader] Basemap unreachable — starting without it. Check VITE_MAPTILER_API_KEY.')
    }
    setLoadProgress(1, basemapMissing ? 'Field system ready · no basemap.' : 'Field system ready.')
  }

  if (loaderFinishAt > 0 && now >= loaderFinishAt) {
    loaderEl.hidden = true
    bootLoading = false
    cancelAnimationFrame(loaderProgressRaf)
    loaderProgressRaf = 0
    window.clearInterval(loaderStallTimer)
    // Carried into the HUD, not just the loader that is about to disappear —
    // otherwise a missing basemap silently reads as "the map is just very dark".
    setStatus(basemapMissing
      ? 'Adaptive streaming · ready · no basemap'
      : 'Adaptive streaming · ready')
  }
}

const onLoaderRetry = () => location.reload()
loaderRetryEl.addEventListener('click', onLoaderRetry)
const onLoaderSoundOpt = () => {
  startWithSound = !startWithSound
  loaderSoundOptEl.setAttribute('aria-pressed', String(startWithSound))
  loaderSoundOptLabelEl.textContent = startWithSound ? 'With ambient sound' : 'Without ambient sound'
}
loaderSoundOptEl.addEventListener('click', onLoaderSoundOpt)
/** Turn the loader benchmark into start settings: strong devices skip the
 * vignette trick and render full quality; weak ones start conservative so the
 * experience never dips below the target frame rate. Runtime guards remain. */
/** The loader benchmark picks how much scenery the device can afford. Point
 * density is not part of that bargain — it is fixed by camera distance — so the
 * budget is spent on the vignette mask, pixel ratio, view distance, cloud and
 * parrot detail instead. */
function applyBenchPreset(): void {
  const measured = eagleBench?.result() ?? null
  const heuristicTier = environmentLayer?.getCloudState().tier ?? 'balanced'
  const preset: BenchPreset = presetOverride
    ?? measured?.preset
    ?? (heuristicTier === 'strong' ? 'strong' : heuristicTier === 'constrained' ? 'constrained' : 'medium')
  // Also decides how late the point cloud joins the entrance flight.
  benchPreset = preset
  console.info(
    `[eagle-bench] ${measured && measured.preset
      ? `${Math.round(measured.pointsAtTarget / 1000)}k of ${Math.round(measured.maxPoints / 1000)}k pts @${EXPERIENCE_CONFIG.eagleBench.targetFps}fps (${measured.samples} samples)`
      : 'no measurement (heuristic fallback)'} → preset ${preset}${
      presetOverride ? ' (forced by ?preset)' : ''}`,
  )
  // Every preset write below routes through the render-options flags so a
  // toggled-off optimisation (or active compare mode) is never re-applied.
  //
  // The vignette used to be part of the bargain too — masked on the weaker
  // presets to cut drawn points. It is a look decision now, so every preset
  // takes the configured default and the weaker tiers pay with pixel ratio and
  // view distance alone. Set design.maskMode to 2 to hand the lever back.
  const options = renderOptions.effective()
  if (preset === 'strong') {
    if (!renderOptions.isCompareMode()) setMaskMode(EXPERIENCE_CONFIG.design.maskMode)
    presetPixelRatioCap = 1.25
    adaptiveQuality.setPressureFloor(1)
    environmentLayer?.applyMeasuredTier('strong')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.strong
    // A settled Detail p100 view measures ~220 MB. Budgets below that evict
    // tiles the very next frame needs, producing continuous refetching.
    if (options.presetBudgets) {
      stream?.setMemoryBudget(384 * 1024 * 1024, 256 * 1024 * 1024)
      globe?.setMemoryBudget(128 * 1024 * 1024, 96 * 1024 * 1024)
    }
  } else if (preset === 'medium') {
    if (!renderOptions.isCompareMode()) setMaskMode(EXPERIENCE_CONFIG.design.maskMode)
    presetPixelRatioCap = 1.1
    adaptiveQuality.setPressureFloor(1.4)
    environmentLayer?.applyMeasuredTier('balanced')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.medium
    if (options.presetBudgets) {
      stream?.setMemoryBudget(256 * 1024 * 1024, 176 * 1024 * 1024)
      // Imagery working set at errorTarget 1 exceeds 64 MiB on deep zooms —
      // thrash there shows up as a permanently blurry basemap.
      globe?.setMemoryBudget(96 * 1024 * 1024, 64 * 1024 * 1024)
    }
  } else {
    if (!renderOptions.isCompareMode()) setMaskMode(EXPERIENCE_CONFIG.design.maskMode)
    presetPixelRatioCap = 1
    adaptiveQuality.setPressureFloor(2)
    environmentLayer?.applyMeasuredTier('constrained')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.constrained
    // Previously left at the library default of 96 MB, which thrashes for the
    // same reason, with less headroom to recover.
    if (options.presetBudgets) {
      stream?.setMemoryBudget(160 * 1024 * 1024, 112 * 1024 * 1024)
      globe?.setMemoryBudget(64 * 1024 * 1024, 48 * 1024 * 1024)
    }
    if (!renderOptions.isCompareMode()) {
      // Larger points keep the canopy readable at a lower pixel ratio.
      pointSizeScale = 1.3
      sizeEl.value = String(pointSizeScale)
      applyPointSize()
    }
  }
  applyPixelRatio()
}

const onLoaderStart = () => {
  if (!loaderReadyShown || loaderFinishAt > 0 || loaderFlightStarted) return
  applyBenchPreset()
  eagleBench?.dispose()
  eagleBench = null
  if (import.meta.env.DEV) delete (window as any).__eagleBenchDebug
  delete loaderEagleCanvasEl.dataset.benchState
  // User gesture: resuming the AudioContext is permitted right here.
  if (startWithSound) void audioLayer?.setEnabled(true)
  const now = performance.now()
  loaderFinishAt = now + (reducedMotion ? 20 : 1200)
  loaderEl.classList.add('finishing')
  rainCycleStartedAt = now
  loaderFlightStarted = true
  // Park the cloud until the flight has closed most of the distance. The loader
  // staged the camera at the flight's destination, so the tiles the reveal needs
  // are already resident — pausing the streamer keeps them, because unloading
  // also only happens inside tiles.update(). With the SSE brakes toggled off
  // the reveal gating is off too — the cloud joins from the first metre.
  entranceFlightPending = renderOptions.effective().sseBrakes
    && EXPERIENCE_CONFIG.flight.cloudRevealProgress[benchPreset] > 0
  if (entranceFlightPending) setPointCloudRevealed(false)
  flyToCloud(
    reducedMotion
      ? EXPERIENCE_CONFIG.flight.reducedMotionDurationMs
      : EXPERIENCE_CONFIG.flight.autoDurationMs,
    true,
  )
}
loaderStartEl.addEventListener('click', onLoaderStart)
const loaderStallTimer = window.setInterval(() => {
  if (!bootLoading || loaderFailed || loaderDataReady || loaderReadyShown || loaderFinishAt > 0
    || performance.now() - loaderLastAdvance < 20_000) return
  loaderStalled = true
  loaderStatusEl.textContent = 'The data connection is responding unusually slowly.'
  loaderRetryEl.hidden = false
}, 1000)

// ---------------------------------------------------------------- overlays
const compactViewport = matchMedia('(max-width: 700px)').matches
document.body.classList.toggle('hud-open', !compactViewport)
document.body.classList.toggle('panel-open', !compactViewport)
$('#hudChip').addEventListener('click', () => document.body.classList.toggle('hud-open'))
$('#panelChip').addEventListener('click', () => document.body.classList.toggle('panel-open'))
$('#designChip').addEventListener('click', () => document.body.classList.toggle('design-open'))
document.querySelectorAll<HTMLButtonElement>('.close').forEach((button) => {
  button.addEventListener('click', () => document.body.classList.remove(`${button.dataset.close}-open`))
})

// ---------------------------------------------------------------- renderer / scene
const canvas = $<HTMLCanvasElement>('#view')
const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL } as any)
// A device-independent cap avoids allocating a native 3x iPhone backbuffer while
// preserving supersampling on ordinary displays. It is never resized per frame.
renderer.setPixelRatio(compareParam ? window.devicePixelRatio : Math.min(window.devicePixelRatio, 1.25))
renderer.setSize(window.innerWidth, window.innerHeight)
// Daylight sky above the globe horizon. The matching distance fog hides the
// finite map edge without another mesh, texture sample or post-process pass.
const DAYLIGHT_SKY = 0x8bc9ec
renderer.setClearColor(DAYLIGHT_SKY, 1)

const scene = new THREE.Scene()
// The sky is also a real scene background, not just the renderer's clear colour.
// The clear colour only reaches the canvas: once the frame is routed through the
// depth-of-field pass it renders into an offscreen target that clears to
// transparent black, and the sky came out black. The environment layer keeps both
// this and the clear colour on the daylight ramp.
scene.background = new THREE.Color(DAYLIGHT_SKY)
const distanceFog = new THREE.Fog(
  DAYLIGHT_SKY,
  EXPERIENCE_CONFIG.atmosphere.maximumFarM * EXPERIENCE_CONFIG.atmosphere.fogNearFactor,
  EXPERIENCE_CONFIG.atmosphere.maximumFarM * EXPERIENCE_CONFIG.atmosphere.fogFarFactor,
)
// The toggle's own sync() would take this off the scene a moment later anyway, but
// materials get built in between and would carry the fog node for nothing.
scene.fog = EXPERIENCE_CONFIG.atmosphere.distanceFogEnabled ? distanceFog : null
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  10,
  EXPERIENCE_CONFIG.atmosphere.maximumFarM,
)
const uniforms = createUniforms()
const adaptiveQuality = new AdaptiveQualityController(pointTree === 'aph' ? APH_BAND_SSE : undefined)
const fps = new Fps()
// Owns the frame's draw call: it either routes the scene through the DoF pass or
// falls back to renderer.render, so there is one render path either way.
const depthOfField: DepthOfFieldLayer = createDepthOfFieldLayer({ renderer, scene, camera })

/** Point size follows camera height continuously — tied to the three SSE bands
 * it visibly stepped mid-zoom. The slider stays a live multiplier on top of the
 * curve so it survives every camera move. */
let pointSizeScale = 1
let cameraAltitude = 0
let lastAppliedPointSize = -1

/** Interpolate the measured anchors linearly in log(height), held flat outside
 * the calibrated range. */
function basePointSizeForHeight(heightM: number): number {
  const anchors = EXPERIENCE_CONFIG.lod.pointSizeByHeightM
  const height = Math.max(1, heightM)
  if (height <= anchors[0][0]) return anchors[0][1]
  const last = anchors[anchors.length - 1]
  if (height >= last[0]) return last[1]
  for (let i = 1; i < anchors.length; i++) {
    const [hiH, hiPx] = anchors[i]
    if (height > hiH) continue
    const [loH, loPx] = anchors[i - 1]
    const t = (Math.log(height) - Math.log(loH)) / (Math.log(hiH) - Math.log(loH))
    return loPx + (hiPx - loPx) * t
  }
  return last[1]
}

function applyPointSize(): void {
  // Curve off (compare mode): one fixed base like Cesium's pointSize, so the
  // comparison shows raw density instead of size-masked holes.
  const base = renderOptions.effective().dynamicPointSize
    ? basePointSizeForHeight(cameraAltitude)
    : EXPERIENCE_CONFIG.lod.fixedPointSizePx
  const pixels = base * EXPERIENCE_CONFIG.lod.pointSizeMultiplier * pointSizeScale
  // The uniform is read by every tile material each frame; skip sub-pixel churn.
  if (Math.abs(pixels - lastAppliedPointSize) < 0.02) return
  lastAppliedPointSize = pixels
  uniforms.pointSize.value = pixels
  $('#sizev').textContent = `${pointSizeScale.toFixed(1)}× · ${pixels.toFixed(1)}px`
}

let globe: Globe | null = null
let stream: StreamingCloud | null = null
const foveationSettings: FoveationSettings = { ...EXPERIENCE_CONFIG.lod.foveation }
let foveation: Foveation | null = null
let markerLayer: MarkerLayer | null = null
let donationShapeLayer: DonationShapeLayer | null = null
let rainLayer: RainLayer | null = null
let keyboardNavigation: KeyboardNavigation | null = null
let environmentLayer: EnvironmentLayer | null = null
let fieldModelLayer: FieldModelLayer | null = null
let audioLayer: AudioLayer | null = null
let modelTransformEditor: ModelTransformEditor | null = null
let cloudNoiseTexture: THREE.Data3DTexture | null = null
let lastStreamStats: StreamingStats | null = null
let sseAuto = 256
let cameraGroundRange = Infinity
/** Refinement distance. Kept apart from cameraGroundRange, which measures the
 * screen-centre look-at point and runs to kilometres near the horizon. */
let cameraCloudRange = Infinity
/** Before the manifest lands the ENU frame is identity and areaMinZ is 0, so a
 * height read from it comes out as 0 — the finest refinement of the whole
 * survey, requested while the loader is still running. */
let enuFrameReady = false
let rangeDebug: Record<string, number> | null = null
let graphicsFailed = false
let cinematicFlightProgress = 1
/** Overwritten by the loader benchmark before the entrance flight starts. */
let benchPreset: BenchPreset = 'medium'
/** The entrance flight hides and pauses the point cloud until its reveal point;
 * every later flight leaves the cloud alone. */
let entranceFlightPending = false
let pointCloudRevealed = true
let atmosphereFar = camera.far
let atmosphereFarScale: number = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.strong
let lastAtmosphereUpdate = -Infinity
// Distance-fog ends as fractions of the far plane — see updateAtmosphere.
/** Design switch, and the device tier's own veto — the scene keeps fog only if both agree. */
let distanceFogEnabled: boolean = EXPERIENCE_CONFIG.atmosphere.distanceFogEnabled
let distanceFogAllowedByTier = true
let distanceFogNearFactor: number = EXPERIENCE_CONFIG.atmosphere.fogNearFactor
let distanceFogFarFactor: number = EXPERIENCE_CONFIG.atmosphere.fogFarFactor
// Coverage mask for the flat ground under the point cloud. Created and registered
// before any basemap material exists — the materials bind the texture object, so it
// must not be replaced — then filled from the point tiles as they load.
const groundPatchMask = createGroundPatchMask({
  cellPx: EXPERIENCE_CONFIG.design.groundPatch.maskCellPx,
  metresPerPixel: EXPERIENCE_CONFIG.design.groundPatch.maskMetresPerPixel,
  maxCells: EXPERIENCE_CONFIG.design.groundPatch.maskMaxCells,
  indexSize: EXPERIENCE_CONFIG.design.groundPatch.maskIndexSize,
  splatRadiusPx: EXPERIENCE_CONFIG.design.groundPatch.maskSplatRadiusPx,
  pointsPerFrame: EXPERIENCE_CONFIG.design.groundPatch.maskPointsPerFrame,
  uploadIntervalMs: EXPERIENCE_CONFIG.design.groundPatch.maskUploadIntervalMs,
})
setGroundPatchMask(groundPatchMask.texture, groundPatchMask.index)

/** Copy the mask's lattice layout into the uniforms the material addresses it with. */
function applyGroundPatchExtent(): void {
  const { cellSizeM, originX, originY, indexSize } = groundPatchMask.grid
  uniforms.groundPatchOrigin.value.set(originX, originY)
  uniforms.groundPatchCellSizeM.value = cellSizeM
  uniforms.groundPatchIndexSize.value = indexSize
}
/** Guards the one-shot extent fix — the survey rectangle never changes. */
let groundPatchMaskBuilt = false
let lastFieldTier: PerformanceTier | null = null
let disposed = false

const rainToggleEl = $<HTMLButtonElement>('#rainToggle')
const rainNoteEl = $('#rainNote')
const cloudToggleEl = $<HTMLButtonElement>('#cloudToggle')
const cloudNoteEl = $('#cloudNote')
const timeDockEl = $('#peruTimeDock')
const timeDockToggleEl = $<HTMLButtonElement>('#peruTimeDockToggle')
const timeSliderEl = $<HTMLInputElement>('#peruTimeSlider')
const timeValueEl = $('#peruTimeValue')
const timeModeEl = $('#peruTimeMode')
const timeNowEl = $<HTMLButtonElement>('#peruTimeNow')
const soundToggleEl = $<HTMLButtonElement>('#soundToggle')
const audioStatusEl = $('#audioStatus')
const RAIN_DRY_DURATION = EXPERIENCE_CONFIG.rain.dryDurationMs
const RAIN_ACTIVE_DURATION = EXPERIENCE_CONFIG.rain.activeDurationMs
const RAIN_CYCLE_DURATION = RAIN_DRY_DURATION + RAIN_ACTIVE_DURATION
let rainCycleEnabled = true
let rainCycleStartedAt = performance.now()
let rainRequested = false
let rainVisualActive = false

function updateRainToggle(): void {
  rainToggleEl.classList.toggle('on', rainCycleEnabled)
  rainToggleEl.setAttribute('aria-pressed', String(rainCycleEnabled))
  rainToggleEl.textContent = !rainCycleEnabled
    ? '☂ Rain cycle · Off'
    : !rainRequested
      ? '☂ Rain cycle · Dry'
      : rainVisualActive
        ? '☂ Rain · Active'
        : '☂ Rain · Near view'
}

const onRainToggle = () => {
  rainCycleEnabled = !rainCycleEnabled
  rainCycleStartedAt = performance.now()
  rainRequested = false
  rainLayer?.setEnabled(false)
  if (!rainCycleEnabled) rainVisualActive = false
  updateRainToggle()
}
rainToggleEl.addEventListener('click', onRainToggle)
rainNoteEl.textContent = `Auto · ${RAIN_DRY_DURATION / 1000} sec dry / ${RAIN_ACTIVE_DURATION / 1000} sec rain · below ${EXPERIENCE_CONFIG.rain.maximumRangeM / 1000} km`
updateRainToggle()

function updateCloudControls(state: CloudState): void {
  const active = state.mode !== 'off'
  cloudToggleEl.disabled = false
  cloudToggleEl.classList.toggle('on', active)
  cloudToggleEl.classList.toggle('is-protected', !active && /protect/i.test(state.reason))
  cloudToggleEl.setAttribute('aria-pressed', String(active))
  const modeLabel = state.mode === 'volume' ? 'Volumetric' : state.mode === 'soft' ? 'Soft volumes' : 'Off'
  cloudToggleEl.textContent = `☁ Clouds · ${modeLabel}`
  cloudNoteEl.textContent = `${state.tier} · ${state.reason}`
}

function updateTimeControls(state: DaylightState): void {
  if (timeValueEl.textContent !== state.timeLabel) {
    timeValueEl.textContent = state.timeLabel
    timeSliderEl.value = String(state.peruMinutes)
  }
  timeModeEl.textContent = state.live ? 'LIVE · PET' : 'MANUAL · PET'
  timeModeEl.classList.toggle('is-live', state.live)
  timeNowEl.hidden = state.live
  timeDockEl.dataset.phase = state.phase
  const hour = Math.floor(state.peruMinutes / 60)
  const minute = state.peruMinutes % 60
  const phaseLabel = state.phase === 'night'
    ? 'Nacht'
    : state.phase === 'sunrise'
      ? 'Sonnenaufgang'
      : state.phase === 'sunset'
        ? 'Sonnenuntergang'
        : 'Tageslicht'
  const accessibleTime = `${hour}:${String(minute).padStart(2, '0')} Uhr, Peru, ${phaseLabel}`
  timeSliderEl.setAttribute('aria-valuetext', accessibleTime)
  timeDockToggleEl.setAttribute('aria-label', `${state.live ? 'Livezeit' : 'Manuelle Zeit'}: ${accessibleTime}`)
}

const onCloudToggle = () => {
  if (!environmentLayer) return
  const state = environmentLayer.getCloudState()
  environmentLayer.setCloudIntent(state.mode === 'off')
}
const onTimeDockToggle = () => {
  const open = !timeDockEl.classList.contains('is-open')
  timeDockEl.classList.toggle('is-open', open)
  timeDockToggleEl.setAttribute('aria-expanded', String(open))
}
const onTimeInput = () => {
  environmentLayer?.setPeruMinutes(Number(timeSliderEl.value))
  if (environmentLayer) updateTimeControls(environmentLayer.getDaylightState())
}
const onTimeNow = () => {
  environmentLayer?.setPeruMinutes(null)
  if (environmentLayer) updateTimeControls(environmentLayer.getDaylightState())
}
// Diagnostics for the tile jitter: high precision is the fix, the lift toggle
// exists to rule the ground-snap offset out by hand.
const precisionToggleEl = $<HTMLButtonElement>('#precisionToggle')
const liftToggleEl = $<HTMLButtonElement>('#liftToggle')
let highPrecisionMatrices = true
let heightOffsetEnabled = true

// 3DGS-Machbarkeitstest — eigenes WebGL-Overlay, lazy erzeugt beim ersten Klick.
const gaussianToggleEl = $<HTMLButtonElement>('#gaussianToggle')
const gaussianNoteEl = $('#gaussianNote')
let gaussianSplatLayer: GaussianSplatLayer | null = null

const onGaussianToggle = () => {
  if (!GAUSSIAN_SPLAT_URL) { gaussianNoteEl.textContent = 'CloudFront domain missing — 3DGS test unavailable'; return }
  if (!gaussianSplatLayer) {
    gaussianSplatLayer = createGaussianSplatLayer({
      url: GAUSSIAN_SPLAT_URL,
      onStateChange: (splatState) => { gaussianNoteEl.textContent = splatState.message },
    })
  }
  const next = !gaussianSplatLayer.isEnabled()
  gaussianSplatLayer.setEnabled(next)
  gaussianToggleEl.classList.toggle('on', next)
  gaussianToggleEl.setAttribute('aria-pressed', String(next))
  gaussianToggleEl.textContent = `✦ 3DGS · ${next ? 'On' : 'Off'}`
  setSplatSolo(next)
}

// Solo-Modus: die 3DGS-Ansicht ist eine eigenständige App. Ist sie an, wird die
// gesamte Hauptszene stummgeschaltet — der Loop zweigt früh ab (kein WebGPU-Draw
// der Punktwolke, keine Wolken/Regen/Streaming) und die Haupt-Canvas wird
// verborgen. Die übrigen Panel-Regler werden ausgegraut, damit klar ist, dass
// sie im Solo-Modus nichts tun.
const highlightSplatKey = (event: KeyboardEvent, on: boolean) => {
  $(`#splatHint .keycap[data-key="${event.code}"]`)?.classList.toggle('is-active', on)
}
const onSplatKeyDown = (event: KeyboardEvent) => highlightSplatKey(event, true)
const onSplatKeyUp = (event: KeyboardEvent) => highlightSplatKey(event, false)

function setSplatSolo(on: boolean): void {
  canvas.style.display = on ? 'none' : ''
  $('#panel').classList.toggle('splat-solo', on)
  // Blendet die Karten-Overlays (Marker-Chips, HUD, Uhr, Tastatur-Guide …) aus,
  // damit die 3DGS-Ansicht für sich steht.
  document.body.classList.toggle('splat-solo', on)
  // WASD-Tasten im Hinweis live mitleuchten lassen.
  if (on) {
    document.addEventListener('keydown', onSplatKeyDown)
    document.addEventListener('keyup', onSplatKeyUp)
  } else {
    document.removeEventListener('keydown', onSplatKeyDown)
    document.removeEventListener('keyup', onSplatKeyUp)
    document.querySelectorAll('#splatHint .keycap.is-active').forEach((el) => el.classList.remove('is-active'))
  }
}

const onPrecisionToggle = () => {
  highPrecisionMatrices = !highPrecisionMatrices
  // The loop owns the actual switch — it also has to suppress it during the
  // loader and the flight.
  updateMatrixPrecision(performance.now())
  syncPrecisionToggle()
}
const liftValueEl = $<HTMLInputElement>('#liftValue')
const liftValueValEl = $<HTMLSpanElement>('#liftValueVal')
/** Show the lift, and what it actually buys over the map surface. */
function syncLiftReadout(): void {
  liftValueValEl.textContent = `${Math.round(pointCloudLiftM)} m`
  liftValueEl.value = String(Math.round(pointCloudLiftM))
}
const onLiftValue = () => {
  pointCloudLiftM = Number(liftValueEl.value)
  applyPointCloudLift()
  syncLiftReadout()
}
liftValueEl.addEventListener('input', onLiftValue)

const onLiftToggle = () => {
  heightOffsetEnabled = !heightOffsetEnabled
  applyHeightOffset()
  liftToggleEl.classList.toggle('on', heightOffsetEnabled)
  liftToggleEl.setAttribute('aria-pressed', String(heightOffsetEnabled))
  liftToggleEl.textContent = `⇅ Offset · ${heightOffsetEnabled ? 'On' : 'Off'}`
}

function syncPrecisionToggle(): void {
  precisionToggleEl.classList.toggle('on', highPrecisionMatrices)
  precisionToggleEl.setAttribute('aria-pressed', String(highPrecisionMatrices))
  precisionToggleEl.textContent = `◈ Precision · ${highPrecisionMatrices ? 'High' : 'Medium'}`
}

// ------------------------------------------------- render options / compare
// Jede Optimierung einzeln abschaltbar (render-options.ts); der Vergleichs-
// modus für den Cesium-Vergleich überschreibt alles auf einmal, ohne die
// Einzelwahl des Nutzers zu verlieren. Übrig bleibt nur die Punktwolke mit
// der zoomabhängigen Dichte (SSE-Bandleiter) plus Navigation und Basemap.
const MIB = 1024 * 1024
/** Fixed high budgets while presetBudgets is off — matching the Cesium
 * reference residency (APH values from the stream limits below), deliberately
 * bounded rather than unlimited. */
const COMPARE_STREAM_BUDGET = { cacheBytes: 768 * MIB, gpuBytes: 384 * MIB }
const COMPARE_GLOBE_BUDGET = { cacheBytes: 128 * MIB, gpuBytes: 96 * MIB }
/** Cap the bench preset chose; applyPixelRatio re-applies it flag-aware. */
let presetPixelRatioCap = 1.25
let compareBudgetSnapshot: {
  stream: MemoryBudgetSnapshot | null
  globe: MemoryBudgetSnapshot | null
} | null = null

function applyPixelRatio(): void {
  renderer.setPixelRatio(renderOptions.effective().pixelRatioCap
    ? Math.min(window.devicePixelRatio, presetPixelRatioCap)
    : window.devicePixelRatio)
  // Resolution feeds the SSE pixel measure — all three must follow every cap
  // change or refinement targets are computed against a stale backbuffer size.
  renderer.setSize(window.innerWidth, window.innerHeight)
  globe?.setResolution()
  stream?.tiles.setResolutionFromRenderer(camera, renderer as any)
}

function applyRenderOptions(effective: Readonly<RenderOptions>, changed: RenderOptionKey[]): void {
  for (const key of changed) {
    switch (key) {
      case 'leafLoading':
        // Leaf loading changes only traversal/residency. The existing point-size
        // slider and camera-height curve remain exactly as the user configured.
        stream?.setLeafLoading(effective.leafLoading)
        // Invalidate the SSE hysteresis so diagnostic refinement begins on the
        // next frame, rather than waiting for a camera move.
        sseAuto = -1
        break
      case 'sseBrakes':
        if (!effective.sseBrakes) {
          // The entrance reveal is a boot-time event: release it now, but never
          // re-park the cloud when the brakes come back on mid-session.
          entranceFlightPending = false
          setPointCloudRevealed(true)
        }
        // Invalidate the 0.25 hysteresis so the next streaming update pushes
        // the new target immediately.
        sseAuto = -1
        break
      case 'fogAtmosphere':
        distanceFogAllowedByTier = effective.fogAtmosphere
        scene.fog = distanceFogAllowedByTier && distanceFogEnabled ? distanceFog : null
        if (effective.fogAtmosphere) {
          // Snap instead of lerping down from the comparison far plane.
          updateAtmosphere(performance.now(), true)
        } else {
          atmosphereFar = EXPERIENCE_CONFIG.atmosphere.maximumFarM
          camera.far = atmosphereFar
          camera.updateProjectionMatrix()
        }
        break
      case 'daylightGrading':
        environmentLayer?.setGradingEnabled(effective.daylightGrading)
        break
      case 'fieldModels':
        fieldModelLayer?.setVisible(effective.fieldModels)
        break
      case 'markers':
        markerLayer?.setVisible(effective.markers)
        if (!effective.markers) setAimMode(false, false)
        break
      case 'donationShape':
        donationShapeLayer?.setVisible(effective.donationShape)
        break
      case 'dynamicPointSize':
        lastAppliedPointSize = -1
        applyPointSize()
        break
      case 'presetBudgets':
        if (!effective.presetBudgets) {
          compareBudgetSnapshot = {
            stream: stream?.getMemoryBudget() ?? null,
            globe: globe?.getMemoryBudget() ?? null,
          }
          stream?.setMemoryBudget(COMPARE_STREAM_BUDGET.cacheBytes, COMPARE_STREAM_BUDGET.gpuBytes)
          globe?.setMemoryBudget(COMPARE_GLOBE_BUDGET.cacheBytes, COMPARE_GLOBE_BUDGET.gpuBytes)
        } else {
          // setMemoryBudget only grows tile counts — restore needs exact values.
          if (compareBudgetSnapshot?.stream) stream?.setMemoryBudgetExact(compareBudgetSnapshot.stream)
          if (compareBudgetSnapshot?.globe) globe?.setMemoryBudgetExact(compareBudgetSnapshot.globe)
          compareBudgetSnapshot = null
        }
        break
      case 'pixelRatioCap':
        applyPixelRatio()
        break
      case 'flightPrecisionDrop':
        appliedHighPrecision = null
        updateMatrixPrecision(performance.now())
        break
      case 'basemapImagery':
        // Not just group.visible: that hid the imagery while the renderer kept
        // traversing and downloading, so the provider's request quota was spent
        // on tiles nobody saw. setImageryEnabled owns the visibility too.
        globe?.setImageryEnabled(effective.basemapImagery)
        break
    }
  }
  syncOptionButtons()
}

const renderOptions = createRenderOptions(applyRenderOptions)

const compareToggleEl = $<HTMLButtonElement>('#compareToggle')
const compareReloadEl = $<HTMLButtonElement>('#compareReload')
const compareRowsEl = $<HTMLDivElement>('#compareRows')
const optionButtons = new Map<RenderOptionKey, HTMLButtonElement>()
const onOptionClick = (key: RenderOptionKey) => {
  renderOptions.setOption(key, !renderOptions.requested()[key])
  syncOptionButtons()
}
for (const rowDef of RENDER_OPTION_ROWS) {
  const row = document.createElement('div')
  row.className = 'row opt-row'
  const label = document.createElement('label')
  label.className = 'h'
  label.htmlFor = `opt-${rowDef.key}`
  label.textContent = rowDef.label
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'act on'
  button.id = `opt-${rowDef.key}`
  button.setAttribute('aria-pressed', 'true')
  button.textContent = rowDef.onText
  button.addEventListener('click', () => onOptionClick(rowDef.key))
  const note = document.createElement('span')
  note.className = 'weather-note'
  note.textContent = rowDef.note
  row.append(label, button, note)
  compareRowsEl.appendChild(row)
  optionButtons.set(rowDef.key, button)
}
// Buttons are created before any option transition occurs, so initialise their
// visual state from the defaults instead of the generic "On" construction.
syncOptionButtons()

function syncOptionButtons(): void {
  const requested = renderOptions.requested()
  for (const rowDef of RENDER_OPTION_ROWS) {
    const button = optionButtons.get(rowDef.key)
    if (!button) continue
    const on = requested[rowDef.key]
    button.classList.toggle('on', on)
    button.setAttribute('aria-pressed', String(on))
    button.textContent = on ? rowDef.onText : rowDef.offText
  }
}

/** Pre-compare state of the toggles that live outside render-options (they
 * already had their own controls). Restored verbatim on exit; the cloud intent
 * bypasses localStorage so the stored user preference survives compare mode. */
let compareLegacySnapshot: {
  maskMode: number
  cloudIntent: boolean
  rainCycle: boolean
  audioOn: boolean
  highPrecision: boolean
} | null = null

function setCompareMode(on: boolean): void {
  if (on === renderOptions.isCompareMode()) return
  if (on) {
    compareLegacySnapshot = {
      maskMode: uniforms.maskMode.value,
      cloudIntent: environmentLayer?.getCloudState().intent ?? false,
      rainCycle: rainCycleEnabled,
      audioOn: soundToggleEl.classList.contains('is-on'),
      highPrecision: highPrecisionMatrices,
    }
    setMaskMode(0)
    environmentLayer?.setCloudIntent(false, false)
    rainCycleEnabled = false
    rainRequested = false
    rainVisualActive = false
    rainLayer?.setEnabled(false)
    updateRainToggle()
    void audioLayer?.setEnabled(false)
    // The comparison wants jitter-free geometry throughout.
    highPrecisionMatrices = true
    syncPrecisionToggle()
  }
  renderOptions.setCompareMode(on)
  if (!on && compareLegacySnapshot) {
    const snapshot = compareLegacySnapshot
    compareLegacySnapshot = null
    setMaskMode(snapshot.maskMode)
    environmentLayer?.setCloudIntent(snapshot.cloudIntent, false)
    rainCycleEnabled = snapshot.rainCycle
    rainCycleStartedAt = performance.now()
    updateRainToggle()
    if (snapshot.audioOn) void audioLayer?.setEnabled(true)
    highPrecisionMatrices = snapshot.highPrecision
    syncPrecisionToggle()
    appliedHighPrecision = null
    updateMatrixPrecision(performance.now())
  }
  document.body.classList.toggle('compare-mode', on)
  $('#panel').classList.toggle('compare-mode', on)
  compareToggleEl.classList.toggle('on', on)
  compareToggleEl.setAttribute('aria-pressed', String(on))
  compareToggleEl.textContent = `⚖ Compare mode · ${on ? 'On' : 'Off'}`
}

const onCompareToggle = () => setCompareMode(!renderOptions.isCompareMode())
/** Reload with/without ?compare=1 so nobody has to remember the parameter —
 * this also covers the construction-time pieces (pixel-ratio start value,
 * skipped loader benchmark) a live toggle cannot reach. */
const onCompareReload = () => {
  const url = new URL(location.href)
  if (compareParam) url.searchParams.delete('compare')
  else url.searchParams.set('compare', '1')
  location.href = url.toString()
}
compareReloadEl.textContent = compareParam ? '⟳ Restart · Normal' : '⟳ Restart in compare mode'
compareToggleEl.addEventListener('click', onCompareToggle)
compareReloadEl.addEventListener('click', onCompareReload)

cloudToggleEl.disabled = true
soundToggleEl.disabled = true
precisionToggleEl.addEventListener('click', onPrecisionToggle)
liftToggleEl.addEventListener('click', onLiftToggle)
gaussianToggleEl.addEventListener('click', onGaussianToggle)
cloudToggleEl.addEventListener('click', onCloudToggle)
timeDockToggleEl.addEventListener('click', onTimeDockToggle)
timeSliderEl.addEventListener('input', onTimeInput)
timeNowEl.addEventListener('click', onTimeNow)

function updateRainCycle(now: number): void {
  const phase = (now - rainCycleStartedAt) % RAIN_CYCLE_DURATION
  const nextRequested = rainCycleEnabled && phase >= RAIN_DRY_DURATION
  if (nextRequested === rainRequested) return
  rainRequested = nextRequested
  rainLayer?.setEnabled(rainRequested)
  updateRainToggle()
}

// ENU -> ECEF frame of the survey.
const enuFrame = new THREE.Matrix4()
const enuInverse = new THREE.Matrix4()
const cloudCenterEnu = new THREE.Vector3()
const cloudCenterEcef = new THREE.Vector3()
const enuUp = new THREE.Vector3(0, 0, 1)
let zOffset = 0

/** Lift the streamed cloud off the draped imagery. Diagnostic only when off:
 * the canopy and cloud-deck uniforms keep the offset they were bound with, so
 * the height grading no longer lines up. */
/**
 * Recompute the cloud's vertical placement and everything measured from it.
 *
 * All of it has to move together: the shader's ENU frame carries zOffset, so the
 * canopy grading, the virtual cloud deck and the fog floor are expressed in lifted
 * coordinates. Changing the lift without these is exactly the desync the Offset
 * toggle warns about, so the slider goes through here rather than nudging the group.
 */
function applyPointCloudLift(): void {
  if (!areaHeightsKnown) return
  zOffset = groundSnap ? -(areaMinZ + areaOriginHeight) + pointCloudLiftM : 0
  uniforms.canopyBaseZ.value = areaMinZ + zOffset + 8
  uniforms.canopyTopZ.value = areaMinZ + zOffset + areaSpan
  uniforms.cloudDeckHeight.value = areaMinZ + zOffset + EXPERIENCE_CONFIG.pointLighting.cloudDeckHeightM
  groundFogFloorZ = areaMinZ + zOffset
  applyGroundFogBase()
  applyHeightOffset()
}

function applyHeightOffset(): void {
  stream?.group.position.copy(enuUp).multiplyScalar(heightOffsetEnabled ? zOffset : 0)
}

function enuToWorld(value: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(value.x, value.y, value.z + zOffset).applyMatrix4(enuFrame)
}

function worldToEnu(value: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
  target.copy(value).applyMatrix4(enuInverse)
  target.z -= zOffset
  return target
}

// ---------------------------------------------------------------- on-demand field film
const videoModalEl = $<HTMLDivElement>('#videoModal')
const fieldVideoEl = $<HTMLVideoElement>('#fieldVideo')
const videoStatusEl = $('#videoStatus')
const videoCloseEl = $<HTMLButtonElement>('#videoClose')
const aimReticleEl = $('#aimReticle')
const aimReticleLabelEl = $('#aimReticleLabel')
const interactionStatusEl = $('#interactionStatus')
const modalBackgroundElements = Array.from(document.body.children)
  .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== videoModalEl && element.tagName !== 'SCRIPT')
let videoReturnFocus: HTMLElement | null = null
let aimMode = false
let aimTarget: MarkerActionTarget | null = null

function announceInteraction(message: string): void {
  interactionStatusEl.textContent = ''
  window.setTimeout(() => { interactionStatusEl.textContent = message }, 20)
}

function setAimMode(active: boolean, announce = true): void {
  if (aimMode === active) return
  aimMode = active
  document.body.classList.toggle('aim-mode', active)
  keyboardNavigation?.setAimActive(active)
  if (!active) {
    interactionStatusEl.textContent = ''
    aimTarget = null
    markerLayer?.setFocusedAction(null)
    aimReticleEl.classList.remove('has-target')
    aimReticleLabelEl.textContent = 'Find target'
  }
  if (announce) {
    announceInteraction(active
      ? 'Focus mode on. Move the camera until a target locks on. Enter opens it, C or Escape leaves.'
      : 'Focus mode off.')
  }
}

function toggleAimMode(): void {
  if (bootLoading || cameraFlight.active || !videoModalEl.hidden) return
  setAimMode(!aimMode)
}

function activateAimTarget(): boolean {
  if (!aimMode || !videoModalEl.hidden) return false
  if (!aimTarget) {
    announceInteraction('No interactive target in the crosshair.')
    return true
  }
  const target = aimTarget
  setAimMode(false, false)
  target.activate()
  return true
}

function dismissAimMode(): boolean {
  if (!aimMode) return false
  setAimMode(false)
  return true
}

function updateAimTarget(): void {
  const nextTarget = aimMode
    ? markerLayer?.pickCenteredAction(camera, EXPERIENCE_CONFIG.accessibility.aimTolerancePx) ?? null
    : null
  if (nextTarget?.id === aimTarget?.id) return
  aimTarget = nextTarget
  markerLayer?.setFocusedAction(nextTarget?.id ?? null)
  aimReticleEl.classList.toggle('has-target', Boolean(nextTarget))
  aimReticleLabelEl.textContent = nextTarget ? `${nextTarget.label} · Enter` : 'Ziel suchen'
  if (nextTarget) announceInteraction(`${nextTarget.label} in focus. Press Enter to open.`)
}

function openFieldVideo(): void {
  if (!videoModalEl.hidden) return
  setAimMode(false, false)
  videoReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  videoModalEl.hidden = false
  for (const element of modalBackgroundElements) element.inert = true
  videoModalEl.classList.remove('is-ready', 'is-playing')
  videoStatusEl.textContent = 'Loading video …'
  if (globe) globe.controls.enabled = false

  // Stop the map render loop while the native video decoder is active. The
  // already-loaded tiles stay resident, but no point-cloud work competes for GPU.
  renderer.setAnimationLoop(null)
  fieldVideoEl.src = FIELD_VIDEO_URL
  fieldVideoEl.load()
  void fieldVideoEl.play().catch(() => {
    videoStatusEl.textContent = 'Tap play to start.'
  })
  videoCloseEl.focus()
}

function closeFieldVideo(resumeRenderer = true): void {
  const wasOpen = !videoModalEl.hidden
  fieldVideoEl.pause()
  fieldVideoEl.removeAttribute('src')
  fieldVideoEl.load()
  videoModalEl.classList.remove('is-ready', 'is-playing')
  videoModalEl.hidden = true
  for (const element of modalBackgroundElements) element.inert = false
  if (globe) globe.controls.enabled = !cameraFlight.active
  if (resumeRenderer && wasOpen && !graphicsFailed) renderer.setAnimationLoop(loop)
  if (wasOpen) videoReturnFocus?.focus()
  videoReturnFocus = null
}

const onVideoCanPlay = () => {
  videoModalEl.classList.add('is-ready')
  if (fieldVideoEl.paused) videoStatusEl.textContent = 'Tap play to start.'
}
const onVideoPlaying = () => videoModalEl.classList.add('is-ready', 'is-playing')
const onVideoWaiting = () => {
  videoModalEl.classList.remove('is-playing')
  videoStatusEl.textContent = 'Loading video …'
}
const onVideoPause = () => {
  if (videoModalEl.hidden || fieldVideoEl.ended) return
  videoModalEl.classList.remove('is-playing')
  videoStatusEl.textContent = 'Tap play to resume.'
}
const onVideoClose = () => closeFieldVideo()
const onVideoError = () => {
  videoModalEl.classList.remove('is-ready', 'is-playing')
  videoStatusEl.textContent = 'The video could not be loaded.'
}
const onVideoBackdrop = (event: MouseEvent) => {
  if (event.target === videoModalEl) closeFieldVideo()
}
const onDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && !videoModalEl.hidden) closeFieldVideo()
  else if (event.key === 'Escape' && timeDockEl.classList.contains('is-open')) {
    timeDockEl.classList.remove('is-open')
    timeDockToggleEl.setAttribute('aria-expanded', 'false')
    timeDockToggleEl.focus()
  }
}
const onVisibilityChange = () => {
  if (document.hidden && !videoModalEl.hidden) fieldVideoEl.pause()
}

videoCloseEl.addEventListener('click', onVideoClose)
videoModalEl.addEventListener('click', onVideoBackdrop)
fieldVideoEl.addEventListener('canplay', onVideoCanPlay)
fieldVideoEl.addEventListener('playing', onVideoPlaying)
fieldVideoEl.addEventListener('waiting', onVideoWaiting)
fieldVideoEl.addEventListener('pause', onVideoPause)
fieldVideoEl.addEventListener('error', onVideoError)
document.addEventListener('keydown', onDocumentKeydown)
document.addEventListener('visibilitychange', onVisibilityChange)

// ---------------------------------------------------------------- graphics-loss handling
function stopForGraphicsFailure(message: string): void {
  if (graphicsFailed) return
  graphicsFailed = true
  renderer.setAnimationLoop(null)
  document.body.classList.add('hud-open')
  setStatus(message)
  if (bootLoading) showLoadError(message)
}

function installGraphicsRecovery(backend: any): void {
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    stopForGraphicsFailure('Graphics memory exhausted · reload the page')
  })
  canvas.addEventListener('webglcontextrestored', () => location.reload())

  const lost = backend?.device?.lost
  if (lost && typeof lost.then === 'function') {
    void lost.then((info: any) => {
      const reason = info?.reason && info.reason !== 'unknown' ? ` (${info.reason})` : ''
      stopForGraphicsFailure(`GPU device lost${reason} · reload the page`)
    })
  }
}

// ---------------------------------------------------------------- mask and camera range
const groundPlane = new THREE.Plane()
const ray = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const hitEcef = new THREE.Vector3()
const hitEnu = new THREE.Vector3()
const hit2d = new THREE.Vector2()
const followEnu = new THREE.Vector2()
let followInit = false
const sideAnchor2d = new THREE.Vector2()
const pitchForwardWorld = new THREE.Vector3()
const pitchAheadWorld = new THREE.Vector3()
const pitchCameraEnu = new THREE.Vector3()
const pitchAheadEnu = new THREE.Vector3()
const VIGNETTE_POS = EXPERIENCE_CONFIG.design.vignettePosition
let vignetteSideAngleDeg: number = VIGNETTE_POS.sideAngleDeg
let vignetteTopAngleDeg: number = VIGNETTE_POS.topAngleDeg
let vignetteSideForwardOffsetM: number = VIGNETTE_POS.sideForwardOffsetM
let vignetteSideMinRadiusM: number = VIGNETTE_POS.sideMinRadiusM
let vignetteSideMaxStrength: number = VIGNETTE_POS.sideMaxVignetteStrength
const maskSphereEnu = new THREE.Vector3()
const maskSphereWorld = new THREE.Vector3()
let maskWorldActive = false
let maskWorldRadius = 0
let areaMinZ = 0
/**
 * Metres the cloud is lifted above the basemap, live from the panel.
 *
 * Ground snapping puts the *bbox floor* on the map surface, which is only right if the
 * bbox actually bounds the data. Measured here it does not: at the river bend the
 * points reach ENU z -90 while the map sits at -55, so the lowest ~35 m of terrain —
 * the river bed, the gravel bars, the low inner bends — ends up behind the imagery and
 * invisible. Hence a knob rather than a constant.
 */
let pointCloudLiftM: number = EXPERIENCE_CONFIG.navigation.pointCloudLiftM
/** Manifest-derived inputs the lift recomputes from; unset until the manifest lands. */
let areaOriginHeight = 0
let areaSpan = 0
let areaHeightsKnown = false
/** Survey floor in the shader's ENU frame (zOffset included) — the ground-fog
 * base slider is an offset from here. */
let groundFogFloorZ = 0
let navigationClearance: number = EXPERIENCE_CONFIG.navigation.zoomStopHeightM
let navigationFloorZ = navigationClearance
let navigationBoundsRadius = 2500
const vignetteEl = $<HTMLDivElement>('#vignette')
const navigationCameraEnu = new THREE.Vector3()
const navigationCameraWorld = new THREE.Vector3()

const cloudRangeEnu = new THREE.Vector3()
const zoomProbeEnu = new THREE.Vector3()
const zoomProbeDirection = new THREE.Vector3()

/** True when the camera sits on the navigation floor inside the survey bounds
 * and is not looking clearly upward — keyboard zoom-in would only glide
 * forward there instead of getting closer, so it is stopped. */
function isZoomInBlocked(): boolean {
  if (freeOrbit) return false
  worldToEnu(camera.position, zoomProbeEnu)
  if (zoomProbeEnu.z > navigationFloorZ + 2) return false
  const dx = zoomProbeEnu.x - cloudCenterEnu.x
  const dy = zoomProbeEnu.y - cloudCenterEnu.y
  if (dx * dx + dy * dy > navigationBoundsRadius * navigationBoundsRadius) return false
  camera.getWorldDirection(zoomProbeDirection)
  return zoomProbeDirection.dot(enuUp) < 0.2
}

/** Final local guard against touch inertia crossing the point-cloud floor. */
function enforceNavigationBounds(): void {
  if (!globe || freeOrbit) return

  worldToEnu(camera.position, navigationCameraEnu)
  const dx = navigationCameraEnu.x - cloudCenterEnu.x
  const dy = navigationCameraEnu.y - cloudCenterEnu.y
  if (dx * dx + dy * dy > navigationBoundsRadius * navigationBoundsRadius) return
  if (navigationCameraEnu.z >= navigationFloorZ) return

  navigationCameraEnu.z = navigationFloorZ
  camera.position.copy(enuToWorld(navigationCameraEnu, navigationCameraWorld))
  camera.updateMatrixWorld()
  // Cancel residual pinch/orbit inertia at the boundary so it cannot fight the
  // clamp on subsequent frames and produce visible vibration.
  globe.controls.resetState()
}

function setMaskMode(mode: number): void {
  uniforms.maskMode.value = mode
  if (mode !== 2) {
    uniforms.vignetteStrength.value = 0
    vignetteEl.style.opacity = '0'
  }
  document.body.classList.toggle('mask-vignette', mode === 2)
  document.querySelectorAll<HTMLButtonElement>('#maskSeg button').forEach((button) =>
    button.classList.toggle('on', Number(button.dataset.mask) === mode))
}

// ---------------------------------------------------------------- donation shape
let donationStyle: DonationShapeStyle = EXPERIENCE_CONFIG.donationShape.defaultStyle
let donationForm: DonationShapeForm = EXPERIENCE_CONFIG.donationShape.defaultForm
let donationSmoothness: number = EXPERIENCE_CONFIG.donationShape.smoothness
let donationSmoothTimer = 0

function setDonationStyle(style: DonationShapeStyle, refit = false): void {
  donationStyle = style
  donationShapeLayer?.setStyle(style)
  document.querySelectorAll<HTMLButtonElement>('#shapeStyleSeg button').forEach((button) =>
    button.classList.toggle('on', button.dataset.shapeStyle === style))
  // Re-frame for the new style. A flat footprint framed at the column's
  // distance is a smudge, and the entrance flight is long over by now, so
  // updateCloudReveal() cannot be disturbed by a second flight.
  if (!refit || !donationShapeLayer || bootLoading) return
  flyToCloud(reducedMotion ? 400 : EXPERIENCE_CONFIG.donationShape.styleRefitDurationMs)
}

function setDonationForm(form: DonationShapeForm): void {
  donationForm = form
  donationShapeLayer?.setForm(form)
  document.querySelectorAll<HTMLButtonElement>('#shapeFormSeg button').forEach((button) =>
    button.classList.toggle('on', button.dataset.shapeForm === form))
  // The rounding slider only means anything for the organic form.
  $('#shapeSmoothRow').hidden = form !== 'organic'
}

function setDonationSmoothness(value: number, immediate = false): void {
  donationSmoothness = value
  $('#shapeSmoothv').textContent = value.toFixed(2)
  // Rebuilding runs a signed-distance field and a marching-squares contour —
  // tens of milliseconds, so a dragged slider is debounced rather than throttled.
  window.clearTimeout(donationSmoothTimer)
  const apply = () => donationShapeLayer?.setSmoothness(value)
  if (immediate) apply()
  else donationSmoothTimer = window.setTimeout(apply, 140)
}

function smooth01(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Degrees below horizontal the camera looks: ~90 straight down, ~0 level,
 * negative looking up. Same convention as the design-panel slider labels. */
function cameraPitchDeg(): number {
  camera.getWorldDirection(pitchForwardWorld)
  const sinPitch = THREE.MathUtils.clamp(-pitchForwardWorld.dot(enuUp), -1, 1)
  return THREE.MathUtils.radToDeg(Math.asin(sinPitch))
}

/** Side-view mask anchor: the camera's own ENU position, nudged forward
 * along its horizontal look direction by sideForwardOffsetM. Pinned to the
 * camera rather than a raycast so the mask stays wrapped around the viewer
 * once the view flattens, instead of chasing a screen-centre ground hit that
 * swings kilometres per degree of pitch. */
function sideAnchorEnu2d(target: THREE.Vector2): THREE.Vector2 {
  worldToEnu(camera.position, pitchCameraEnu)
  pitchAheadWorld.copy(pitchForwardWorld).add(camera.position)
  worldToEnu(pitchAheadWorld, pitchAheadEnu)
  pitchAheadEnu.sub(pitchCameraEnu)
  pitchAheadEnu.z = 0
  if (pitchAheadEnu.lengthSq() > 1e-6) pitchAheadEnu.normalize()
  return target.set(
    pitchCameraEnu.x + pitchAheadEnu.x * vignetteSideForwardOffsetM,
    pitchCameraEnu.y + pitchAheadEnu.y * vignetteSideForwardOffsetM,
  )
}

function updateMaskFollow(): void {
  const mode = uniforms.maskMode.value
  ndc.set(0, 0)
  ray.setFromCamera(ndc, camera)

  // cameraPitchDeg() also fills pitchForwardWorld, which sideAnchorEnu2d needs.
  const sideFactor = enuFrameReady
    ? 1 - smooth01(vignetteSideAngleDeg, vignetteTopAngleDeg, cameraPitchDeg())
    : 0
  if (enuFrameReady) sideAnchorEnu2d(sideAnchor2d)

  let missedGround = false
  if (ray.ray.intersectPlane(groundPlane, hitEcef)) {
    cameraGroundRange = camera.position.distanceTo(hitEcef)
    hitEnu.copy(hitEcef).applyMatrix4(enuInverse)
    hit2d.set(hitEnu.x, hitEnu.y)
  } else {
    cameraGroundRange = camera.position.distanceTo(cloudCenterEcef)
    missedGround = true
    hit2d.copy(sideAnchor2d)
  }
  // Blend the screen-centre ground hit (correct once the camera looks down)
  // toward the camera-pinned anchor (correct once it looks across the
  // canopy) — see sideAnchorEnu2d for why the raycast alone isn't enough.
  if (enuFrameReady) hit2d.lerp(sideAnchor2d, sideFactor)

  if (!followInit) { followEnu.copy(hit2d); followInit = true }
  else followEnu.lerp(hit2d, 0.2)
  uniforms.maskCenter.value.copy(followEnu)

  // Refinement distance: height over the cloud floor plus how far outside the
  // survey footprint the camera sits. The screen-centre hit above is useless
  // here — pointed at the horizon it swings by kilometres per degree of pitch.
  if (enuFrameReady) {
    worldToEnu(camera.position, cloudRangeEnu)
    const altitude = Math.max(0, cloudRangeEnu.z - areaMinZ)
    const outside = Math.max(
      0,
      Math.hypot(cloudRangeEnu.x - cloudCenterEnu.x, cloudRangeEnu.y - cloudCenterEnu.y)
      - navigationBoundsRadius,
    )
    cameraCloudRange = Math.hypot(altitude, outside)
    cameraAltitude = altitude
    rangeDebug = { altitude, outside, range: cameraCloudRange, groundRange: cameraGroundRange }
  } else {
    cameraCloudRange = cameraGroundRange
  }

  if (missedGround && !followInit) { maskWorldActive = false; return }

  if (mode === 0) {
    maskWorldActive = false
    vignetteEl.style.opacity = '0'
    return
  }

  // Side view: floor the radius so being extremely close to the canopy never
  // shrinks the "portal" below arm's reach, and cap the strength below the
  // shader's 0.95 discard threshold — points are dimmed/tinted toward the
  // surround at most, never discarded. Distant points still disappear, but
  // through groundFog rather than a hard mask edge.
  const radius = Math.max(
    THREE.MathUtils.clamp(cameraGroundRange * 0.55, 30, 2000),
    vignetteSideMinRadiusM * sideFactor,
  )
  const strength = 1 - smooth01(4, 20, cameraGroundRange / radius)
  const flightBlend = smooth01(0.68, 1, cinematicFlightProgress)
  const strengthCap = THREE.MathUtils.lerp(1, vignetteSideMaxStrength, sideFactor)
  const visibleStrength = Math.min(strength * flightBlend, strengthCap)
  uniforms.maskRadius.value = radius
  uniforms.vignetteStrength.value = visibleStrength
  vignetteEl.style.opacity = String(visibleStrength)

  maskWorldRadius = uniforms.maskRadius.value + 80
  maskSphereEnu.set(followEnu.x, followEnu.y, areaMinZ + 50)
  enuToWorld(maskSphereEnu, maskSphereWorld)
  maskWorldActive = visibleStrength > 0.9
}

/**
 * Blend the finite globe into the sky and keep the camera frustum proportional
 * to the current viewing height. Updating at 8 Hz avoids projection-matrix
 * churn while still following zoom and the cinematic flight smoothly.
 */
function updateAtmosphere(now: number, snap = false): void {
  // Toggled off: fog is detached and the far plane pinned to the maximum by
  // the options applicator — nothing to follow here.
  if (!renderOptions.effective().fogAtmosphere) return
  if (!snap && now - lastAtmosphereUpdate < EXPERIENCE_CONFIG.atmosphere.updateIntervalMs) return
  lastAtmosphereUpdate = now

  const range = Number.isFinite(cameraGroundRange)
    ? cameraGroundRange
    : EXPERIENCE_CONFIG.atmosphere.fallbackRangeM
  const targetFar = THREE.MathUtils.clamp(
    range * EXPERIENCE_CONFIG.atmosphere.farRangeMultiplier * atmosphereFarScale,
    EXPERIENCE_CONFIG.atmosphere.minimumFarM,
    EXPERIENCE_CONFIG.atmosphere.maximumFarM * atmosphereFarScale,
  )
  // On re-enable the far plane snaps to its target instead of lerping down
  // from the comparison distance over several seconds.
  atmosphereFar = snap ? targetFar : THREE.MathUtils.lerp(
    atmosphereFar,
    targetFar,
    EXPERIENCE_CONFIG.atmosphere.distanceSmoothing,
  )

  camera.far = atmosphereFar
  camera.updateProjectionMatrix()
  // Both ends are fractions of the current far plane rather than absolute metres,
  // so the haze keeps the same proportions whether the camera sits 100 m over the
  // canopy or 90 km out. The design panel retunes the fractions, not the metres —
  // which is also why they cannot be written to distanceFog once and left alone.
  distanceFog.near = atmosphereFar * distanceFogNearFactor
  distanceFog.far = atmosphereFar * Math.max(distanceFogFarFactor, distanceFogNearFactor + 0.01)
}

// ---------------------------------------------------------------- fly-to
const cameraFlight = createCameraFlight({
  camera,
  enuUp,
  worldToEnu,
  enuToWorld,
  cloudCentre: () => cloudCenterEnu,
  // Evaluated at toCloud() time, so the arc lands on the donation parcel once
  // its GeoJSON is in and falls back to the survey centre until then.
  flightTarget: () => donationShapeLayer?.flightTargetEnu() ?? cloudCenterEnu,
  flightDestinationOffset: () => donationFlightOffset() ?? EXPERIENCE_CONFIG.flight.destinationOffsetM,
  navigationFloorZ: () => navigationFloorZ,
  setControlsEnabled: (enabled) => { if (globe) globe.controls.enabled = enabled },
  onProgress: (progress) => { cinematicFlightProgress = progress },
})

/**
 * Where the intro arc should end so the donation shape is actually framed.
 *
 * Distance comes from the active style's bounding box and the camera frustum:
 * far enough that both the width and the height fit inside `frameFillFraction`
 * of the view. Note the hard limit this cannot beat — filling half the screen
 * *width* with a 14 m parcel needs about 18 m of camera distance, which is
 * inside the canopy and under the navigation floor that enforceNavigationBounds
 * pins the camera to. That is why the column style is 200 m tall: the vertical
 * volume is what fills the frame from a legal viewing height.
 */
function donationFlightOffset(): EnuOffset | null {
  if (!donationShapeLayer) return null
  const config = EXPERIENCE_CONFIG.donationShape
  const extent = donationShapeLayer.frameExtent()
  const halfVertical = THREE.MathUtils.degToRad(camera.fov) * 0.5
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * camera.aspect)
  const fill = Math.max(0.1, Math.min(1, config.frameFillFraction))
  let distance = Math.max(
    config.minApproachDistanceM,
    (extent.heightM * 0.5) / Math.tan(halfVertical * fill),
    extent.radiusM / Math.tan(halfHorizontal * fill),
  )
  // Approach from the south, the same heading the survey flight already uses,
  // at a shallow pitch so the column stands up in frame instead of foreshortening.
  // The pitch has to put the camera at or above the navigation floor. Ending
  // below it does not fail loudly: enforceNavigationBounds lifts the camera
  // afterwards without re-aiming, so the shot silently looks over the parcel
  // into the distance. Steepening instead keeps the target centred, and a
  // flat footprint wants the top-down look anyway.
  const target = donationShapeLayer.flightTargetEnu()!
  const floorRise = navigationFloorZ - target.z
  if (floorRise > 0) distance = Math.max(distance, floorRise / 0.98)
  const pitch = Math.max(
    THREE.MathUtils.degToRad(config.approachPitchDeg),
    Math.asin(THREE.MathUtils.clamp(floorRise / distance, 0, 0.98)),
  )
  return [0, -distance * Math.cos(pitch), distance * Math.sin(pitch)]
}

function cloudOffsetEnu(offset: EnuOffset): THREE.Vector3 {
  return new THREE.Vector3(
    cloudCenterEnu.x + offset[0],
    cloudCenterEnu.y + offset[1],
    cloudCenterEnu.z + offset[2],
  )
}

function flyToCloud(duration: number = EXPERIENCE_CONFIG.flight.manualDurationMs, startFromOverview = false): void {
  setAimMode(false, false)
  cameraFlight.toCloud(duration, startFromOverview)
}

function flyToPoint(targetEnu: THREE.Vector3, endDistanceM: number, durationMs: number): void {
  setAimMode(false, false)
  cameraFlight.toPoint(targetEnu, endDistanceM, durationMs)
}

// ---------------------------------------------------------------- UI wiring
const sizeEl = $<HTMLInputElement>('#size')

document.querySelectorAll<HTMLButtonElement>('#maskSeg button').forEach((button) => {
  button.addEventListener('click', () => setMaskMode(Number(button.dataset.mask)))
})
document.querySelectorAll<HTMLButtonElement>('#shapeStyleSeg button').forEach((button) => {
  button.addEventListener('click', () => setDonationStyle(button.dataset.shapeStyle as DonationShapeStyle, true))
})
document.querySelectorAll<HTMLButtonElement>('#shapeFormSeg button').forEach((button) => {
  button.addEventListener('click', () => setDonationForm(button.dataset.shapeForm as DonationShapeForm))
})
$<HTMLInputElement>('#shapeSmooth').addEventListener('input', (event) => {
  setDonationSmoothness(Number((event.target as HTMLInputElement).value))
})
sizeEl.addEventListener('input', () => {
  pointSizeScale = Number(sizeEl.value)
  applyPointSize()
})

// ---- design panel: every control writes a uniform, so tiles need no rebuild
/** Fog base is authored as an offset from the survey floor, which only becomes
 * known when the manifest lands — keep the offset and re-apply it from both sides. */
let groundFogBaseOffset: number = EXPERIENCE_CONFIG.design.groundFog.baseOffsetM
function applyGroundFogBase(): void {
  uniforms.groundFogBaseZ.value = groundFogFloorZ + groundFogBaseOffset
}

const asPercent = (value: number) => `${Math.round(value * 100)}%`
const asMetres = (value: number) => `${Math.round(value)} m`
const asPixels = (value: number) => `${value} px`

/** The slider's starting position comes from config, not from the HTML `value`
 * attribute — otherwise the markup and EXPERIENCE_CONFIG.design drift apart. */
function bindDesignSlider(
  id: string,
  initial: number,
  format: (value: number) => string,
  apply: (value: number) => void,
): void {
  const input = $<HTMLInputElement>(`#${id}`)
  const readout = $(`#${id}Val`)
  input.value = String(initial)
  const sync = () => {
    const value = Number(input.value)
    readout.textContent = format(value)
    apply(value)
  }
  input.addEventListener('input', sync)
  sync()
}

// Browsers retune a hovered range input on wheel. In a scrollable panel of
// sliders that means every control you scroll past silently changes value, so
// the wheel is claimed for scrolling and forwarded to the container by hand.
const designScrollEl = $<HTMLDivElement>('#designPanel .design-scroll')
designScrollEl.addEventListener('wheel', (event) => {
  const target = event.target as HTMLElement
  if (!(target instanceof HTMLInputElement) || target.type !== 'range') return
  event.preventDefault()
  designScrollEl.scrollTop += event.deltaY
}, { passive: false })

const asFactor = (value: number) => `${value.toFixed(2)}×`
const toHex = (value: number) => `#${value.toString(16).padStart(6, '0')}`

// Foveated detail. Deliberately a set of raw sliders rather than a derived curve:
// whether the core belongs above or below the screen centre under tilt is an open
// question — the near ground at the bottom edge is already fully refined by
// distance, while the expensive band under tilt runs across the middle — so the
// position is measured first and only then turned into a function of pitch.
const foveationToggleEl = $<HTMLButtonElement>('#foveationToggle')
const syncFoveationToggle = () => {
  const on = foveationSettings.enabled
  foveationToggleEl.classList.toggle('on', on)
  foveationToggleEl.setAttribute('aria-pressed', String(on))
  foveationToggleEl.textContent = on ? '◎ Fovea · On' : '◎ Fovea · Off'
}
foveationToggleEl.addEventListener('click', () => {
  foveationSettings.enabled = !foveationSettings.enabled
  syncFoveationToggle()
  updateFoveationGuides()
})
syncFoveationToggle()

const foveationGuidesEl = document.querySelector<SVGSVGElement>('#foveationGuides')!
const foveationGuideCoreEl = document.querySelector<SVGCircleElement>('#foveationGuideCore')!
const foveationGuideRampEl = document.querySelector<SVGCircleElement>('#foveationGuideRamp')!
const foveationGuideAxisEl = document.querySelector<SVGLineElement>('#foveationGuideAxis')!
const foveationGuidesToggleEl = $<HTMLButtonElement>('#foveationGuidesToggle')
const foveationTilesToggleEl = $<HTMLButtonElement>('#foveationTilesToggle')
const foveationTilesEl = document.querySelector<SVGGElement>('#foveationTiles')!
let foveationGuidesOn = false
let foveationTilesOn = false
foveationGuidesToggleEl.addEventListener('click', () => {
  foveationGuidesOn = !foveationGuidesOn
  foveationGuidesToggleEl.classList.toggle('on', foveationGuidesOn)
  foveationGuidesToggleEl.setAttribute('aria-pressed', String(foveationGuidesOn))
  foveationGuidesToggleEl.textContent = foveationGuidesOn ? '⊕ Guides · On' : '⊕ Guides · Off'
  updateFoveationGuides()
})
foveationTilesToggleEl.addEventListener('click', () => {
  foveationTilesOn = !foveationTilesOn
  foveationTilesToggleEl.classList.toggle('on', foveationTilesOn)
  foveationTilesToggleEl.setAttribute('aria-pressed', String(foveationTilesOn))
  foveationTilesToggleEl.textContent = foveationTilesOn ? '▦ Tiles · On' : '▦ Tiles · Off'
  updateFoveationGuides()
})
const foveationBoxesToggleEl = $<HTMLButtonElement>('#foveationBoxesToggle')
let foveationBoxesOn = false
foveationBoxesToggleEl.addEventListener('click', () => {
  foveationBoxesOn = !foveationBoxesOn
  foveationBoxesToggleEl.classList.toggle('on', foveationBoxesOn)
  foveationBoxesToggleEl.setAttribute('aria-pressed', String(foveationBoxesOn))
  foveationBoxesToggleEl.textContent = foveationBoxesOn ? '◳ Boxes · On' : '◳ Boxes · Off'
  foveation?.setBoxesVisible(foveationBoxesOn)
  foveation?.updateBoxes()
})

/** Both foveation screen measures, drawn where they act. The radius is in half
 * screen heights and the falloff runs from it out to the image corner, so the
 * dashed circle marks the middle of that ramp — the ring you would see first. */
function updateFoveationGuides(): void {
  // Both overlays stand on their own: where the tiles sit is a question about the
  // tree, and the circles are how you place the core before switching the mode on.
  // Neither waits for the other, and neither waits for foveation to be enabled.
  //
  // The `hidden` attribute is not honoured on SVG child elements, so visibility goes
  // through display — on the root as well, to keep it out of hit testing entirely.
  const showCircles = foveationGuidesOn
  foveationGuidesEl.style.display = showCircles || foveationTilesOn ? '' : 'none'
  const circleDisplay = showCircles ? '' : 'none'
  foveationGuideCoreEl.style.display = circleDisplay
  foveationGuideRampEl.style.display = circleDisplay
  foveationGuideAxisEl.style.display = circleDisplay
  updateFoveationTiles()
  if (!showCircles) return
  const width = window.innerWidth
  const height = window.innerHeight
  const unit = height / 2
  const centreY = unit - foveationSettings.offsetY * unit
  const core = foveationSettings.radius * unit
  foveationGuideCoreEl.setAttribute('cx', String(width / 2))
  foveationGuideCoreEl.setAttribute('cy', String(centreY))
  foveationGuideCoreEl.setAttribute('r', String(core))
  foveationGuideRampEl.setAttribute('cx', String(width / 2))
  foveationGuideRampEl.setAttribute('cy', String(centreY))
  // End of the blend, not its middle: that is the value the falloff slider sets, so
  // it is the one worth drawing.
  foveationGuideRampEl.setAttribute('r', String(core + foveationSettings.falloff * unit))
  // SVG line coordinates are lengths, not percentages, so the span is written out.
  foveationGuideAxisEl.setAttribute('x1', '0')
  foveationGuideAxisEl.setAttribute('x2', String(width))
  foveationGuideAxisEl.setAttribute('y1', String(centreY))
  foveationGuideAxisEl.setAttribute('y2', String(centreY))
}
window.addEventListener('resize', updateFoveationGuides)

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * One outline per drawn tile, in the same half-screen-height frame the core radius
 * uses. Rebuilt rather than diffed: there are a few dozen tiles and this is a debug
 * view, so clarity beats churn.
 */
function updateFoveationTiles(): void {
  if (!foveationTilesOn || !foveation) {
    if (foveationTilesEl.childElementCount) foveationTilesEl.replaceChildren()
    return
  }
  const width = window.innerWidth
  const height = window.innerHeight
  const unit = height / 2
  const toX = (x: number) => width / 2 + x * unit
  const toY = (y: number) => unit - y * unit
  const nodes: SVGElement[] = []
  const straddling: string[] = []
  // Coarse tiles first, so the small deep ones stay readable on top of them.
  for (const region of foveation.regions().sort((a, b) => a.depth - b.depth)) {
    // Cyan at the core budget through orange at the corner budget — the same reading
    // as the circles, per tile.
    const hue = 190 - region.ramp * 160
    const colour = `hsl(${hue} 90% 60%)`
    const caption = `d${region.depth}${region.leaf ? ' •' : ''} ${region.error.toFixed(0)}px`
    // A tile containing the view plane has no screen rectangle at all: its corners
    // land on both sides of the camera. Those are the coarse ancestors the camera
    // sits inside, and they always reach the core, so they get a list instead.
    if (region.straddles) { straddling.push(caption); continue }
    const x0 = Math.max(toX(region.minX), -2)
    const x1 = Math.min(toX(region.maxX), width + 2)
    const y0 = Math.max(toY(region.maxY), -2)
    const y1 = Math.min(toY(region.minY), height + 2)
    const rect = document.createElementNS(SVG_NS, 'rect')
    rect.setAttribute('x', String(x0))
    rect.setAttribute('y', String(y0))
    rect.setAttribute('width', String(Math.max(x1 - x0, 1)))
    rect.setAttribute('height', String(Math.max(y1 - y0, 1)))
    rect.setAttribute('stroke', colour)
    // A leaf cannot be coarsened however far out it sits, so it is drawn dashed to
    // separate "outside the core" from "actually saveable".
    if (region.leaf) rect.setAttribute('stroke-dasharray', '5 4')
    rect.setAttribute('opacity', String(0.5 + region.ramp * 0.45))
    nodes.push(rect)

    const label = document.createElementNS(SVG_NS, 'text')
    label.setAttribute('x', String(Math.min(x0 + 4, width - 64)))
    label.setAttribute('y', String(Math.min(Math.max(y0 + 12, 12), height - 4)))
    label.setAttribute('fill', colour)
    label.textContent = caption
    nodes.push(label)
  }
  straddling.forEach((caption, i) => {
    const label = document.createElementNS(SVG_NS, 'text')
    label.setAttribute('x', String(width / 2 - 40))
    label.setAttribute('y', String(16 + i * 13))
    label.setAttribute('fill', 'hsl(190 90% 60%)')
    label.textContent = i === 0 ? `across view plane: ${caption}` : caption
    nodes.push(label)
  })
  foveationTilesEl.replaceChildren(...nodes)
}

const FOVEATION = EXPERIENCE_CONFIG.lod.foveation
const asScreenHeights = (value: number) => `${value.toFixed(2)} h`
const asOffset = (value: number) =>
  value === 0 ? 'centre' : `${value > 0 ? 'up' : 'down'} ${Math.abs(value).toFixed(2)}`
bindDesignSlider('foveationRadius', FOVEATION.radius, asScreenHeights, (v) => {
  foveationSettings.radius = v
  updateFoveationGuides()
})
bindDesignSlider('foveationOffsetY', FOVEATION.offsetY, asOffset, (v) => {
  foveationSettings.offsetY = v
  updateFoveationGuides()
})
bindDesignSlider('foveationFalloff', FOVEATION.falloff, asScreenHeights, (v) => {
  foveationSettings.falloff = v
  updateFoveationGuides()
})
bindDesignSlider('foveationCentre', FOVEATION.centreFactor, asFactor, (v) => {
  foveationSettings.centreFactor = v
})
bindDesignSlider('foveationEdge', FOVEATION.edgeFactor, asFactor, (v) => {
  foveationSettings.edgeFactor = v
})


/** Bind a colour input, seeded from config like the sliders are. */
function bindDesignColor(id: string, initial: number, apply: (hex: string) => void): void {
  const input = $<HTMLInputElement>(`#${id}`)
  input.value = toHex(initial)
  const sync = () => apply(input.value)
  input.addEventListener('input', sync)
  sync()
}

const DESIGN = EXPERIENCE_CONFIG.design
bindDesignSlider('mapSaturation', DESIGN.mapSaturation, asPercent, (v) => { uniforms.mapSaturation.value = v })
bindDesignSlider('mapBrightness', DESIGN.mapBrightness, asPercent, (v) => { uniforms.mapBrightness.value = v })
// Goes through the globe because changing it has to force a re-traversal; see
// Globe.setErrorTarget. Higher = fewer tiles per view = softer imagery.
bindDesignSlider('basemapErrorTarget', DESIGN.basemapErrorTarget, asPixels, (v) => {
  globe?.setErrorTarget(v)
})
bindDesignSlider('fogStrength', DESIGN.groundFog.strength, asPercent, (v) => { uniforms.groundFogStrength.value = v })
// Distance fog: fractions of the far plane, applied in updateAtmosphere. Forcing
// an immediate pass so the slider does not wait out the smoothing.
bindDesignSlider('distanceFogNear', EXPERIENCE_CONFIG.atmosphere.fogNearFactor, asPercent, (v) => {
  distanceFogNearFactor = v
  lastAtmosphereUpdate = -Infinity
})
bindDesignSlider('distanceFogFar', EXPERIENCE_CONFIG.atmosphere.fogFarFactor, asPercent, (v) => {
  distanceFogFarFactor = v
  lastAtmosphereUpdate = -Infinity
})
bindDesignSlider('fogHeight', DESIGN.groundFog.heightM, asMetres, (v) => { uniforms.groundFogHeight.value = v })
bindDesignSlider('fogFadeBelow', DESIGN.groundFog.fadeBelowM, asMetres, (v) => { uniforms.groundFogFadeBelow.value = v })
bindDesignSlider('fogCurve', DESIGN.groundFog.curve, asFactor, (v) => { uniforms.groundFogCurve.value = v })
// The uniform is a divisor, so 0 would be a division by zero. The slider still
// reads 0 m; the shader clamps too, this just keeps the uniform itself finite.
bindDesignSlider('fogDistance', DESIGN.groundFog.efoldDistanceM, asMetres, (v) => {
  uniforms.groundFogDistance.value = Math.max(v, 0.01)
})
bindDesignSlider('fogBase', DESIGN.groundFog.baseOffsetM, asMetres, (v) => { groundFogBaseOffset = v; applyGroundFogBase() })
bindDesignSlider('maskFringe', DESIGN.maskFringe, asPercent, (v) => { uniforms.maskFringe.value = v })
bindDesignSlider('maskFringeCurve', DESIGN.maskFringeCurve, asFactor, (v) => { uniforms.maskFringeCurve.value = v })
bindDesignSlider('surroundTint', DESIGN.surroundTint, asPercent, (v) => { uniforms.maskSurroundAmount.value = v })

/**
 * Effect switches that compile the effect out instead of turning it down.
 *
 * A uniform at zero still pays for everything the shader does to reach it, so these
 * are the only way to read off what an effect actually costs in fps — which is what
 * they are for. The price of that is a shader rebuild on every flip, so they are
 * diagnostics, not something to animate.
 */
function bindEffectToggle(
  id: string, label: string, initial: boolean, apply: (enabled: boolean) => void,
): void {
  const button = $<HTMLButtonElement>(`#${id}`)
  let enabled = initial
  const sync = () => {
    button.classList.toggle('on', enabled)
    button.setAttribute('aria-pressed', String(enabled))
    button.textContent = `${label} · ${enabled ? 'On' : 'Off'}`
    apply(enabled)
  }
  button.addEventListener('click', () => { enabled = !enabled; sync() })
  sync()
}

/** Rebuild every loaded tile shader. Both layers may still be null during boot. */
function refreshEffectShaders(): void {
  stream?.refreshEffects()
  globe?.refreshEffects()
}

/** One switch for an effect that lives in the tile shaders. */
function bindShaderEffectToggle(
  id: string, label: string, effect: CloudEffect, initial = true,
): void {
  bindEffectToggle(id, label, initial, (enabled) => {
    if (setCloudEffectEnabled(effect, enabled)) refreshEffectShaders()
  })
}

bindShaderEffectToggle('groundFogToggle', '≡ Ground fog', 'groundFog', DESIGN.groundFog.enabled)
bindShaderEffectToggle('cloudShadowToggle', '☁ Cloud shadows', 'cloudShadows')
// Distance fog is three's own scene fog, so switching it off is a matter of taking
// it off the scene — with no fog there, the node materials build without it. The
// device tier can also disable it (see the fogAtmosphere case), and that still wins.
bindEffectToggle('distanceFogToggle', '≋ Distance fog', EXPERIENCE_CONFIG.atmosphere.distanceFogEnabled, (enabled) => {
  distanceFogEnabled = enabled
  scene.fog = enabled && distanceFogAllowedByTier ? distanceFog : null
  refreshEffectShaders()
})

// Ground patch under the point cloud. Off both zeroes the amount and compiles the
// patch out of the tile shaders, so it costs nothing; switching it back on restores
// whatever the slider was left at.
const GROUND_PATCH = DESIGN.groundPatch
let groundPatchEnabled: boolean = GROUND_PATCH.enabled
let groundPatchAmount: number = GROUND_PATCH.amount
const groundPatchToggleEl = $<HTMLButtonElement>('#groundPatchToggle')
const applyGroundPatchAmount = () => {
  uniforms.groundPatchAmount.value = groundPatchEnabled ? groundPatchAmount : 0
}
const syncGroundPatchToggle = () => {
  groundPatchToggleEl.classList.toggle('on', groundPatchEnabled)
  groundPatchToggleEl.setAttribute('aria-pressed', String(groundPatchEnabled))
  groundPatchToggleEl.textContent = `▦ Ground patch · ${groundPatchEnabled ? 'On' : 'Off'}`
  applyGroundPatchAmount()
}
const onGroundPatchToggle = () => {
  groundPatchEnabled = !groundPatchEnabled
  syncGroundPatchToggle()
  if (setCloudEffectEnabled('groundPatch', groundPatchEnabled)) refreshEffectShaders()
}
groundPatchToggleEl.addEventListener('click', onGroundPatchToggle)
syncGroundPatchToggle()
bindDesignColor('groundPatchColor', GROUND_PATCH.color, (hex) => {
  uniforms.groundPatchColor.value.set(hex)
})
bindDesignSlider('groundPatchAmount', GROUND_PATCH.amount, asPercent, (v) => {
  groundPatchAmount = v; applyGroundPatchAmount()
})
bindDesignSlider('groundPatchColorMix', GROUND_PATCH.colorMix, asPercent, (v) => {
  uniforms.groundPatchColorMix.value = v
})
bindDesignSlider('groundPatchBrightness', GROUND_PATCH.brightness, asPercent, (v) => {
  uniforms.groundPatchBrightness.value = v
})
bindDesignSlider('groundPatchBlurM', GROUND_PATCH.blurM, asMetres, (v) => {
  uniforms.groundPatchBlurM.value = v
})
bindDesignSlider('groundPatchThreshold', GROUND_PATCH.threshold, asPercent, (v) => {
  uniforms.groundPatchThreshold.value = v
})

const asDegrees = (value: number) => `${Math.round(value)}°`
const VIGNETTE_POSITION_DESIGN = DESIGN.vignettePosition
bindDesignSlider(
  'vignetteSideAngle', VIGNETTE_POSITION_DESIGN.sideAngleDeg, asDegrees,
  (v) => { vignetteSideAngleDeg = v },
)
bindDesignSlider(
  'vignetteTopAngle', VIGNETTE_POSITION_DESIGN.topAngleDeg, asDegrees,
  (v) => { vignetteTopAngleDeg = v },
)
bindDesignSlider(
  'vignetteForwardOffset', VIGNETTE_POSITION_DESIGN.sideForwardOffsetM, asMetres,
  (v) => { vignetteSideForwardOffsetM = v },
)
bindDesignSlider(
  'vignetteSideMinRadius', VIGNETTE_POSITION_DESIGN.sideMinRadiusM, asMetres,
  (v) => { vignetteSideMinRadiusM = v },
)
bindDesignSlider(
  'vignetteSideMaxStrength', VIGNETTE_POSITION_DESIGN.sideMaxVignetteStrength, asPercent,
  (v) => { vignetteSideMaxStrength = v },
)

// Depth of field. The two toggles read their state back off the layer rather than
// tracking it here, so the layer stays the single source of truth.
const DOF = EXPERIENCE_CONFIG.depthOfField
const dofToggleEl = $<HTMLButtonElement>('#dofToggle')
const dofAutoFocusEl = $<HTMLButtonElement>('#dofAutoFocus')
const dofFocusRowEl = $<HTMLDivElement>('#dofFocusRow')
const syncDofToggles = () => {
  const on = depthOfField.isEnabled()
  dofToggleEl.classList.toggle('on', on)
  dofToggleEl.setAttribute('aria-pressed', String(on))
  dofToggleEl.textContent = `◉ Depth of field · ${on ? 'On' : 'Off'}`
  const auto = depthOfField.isAutoFocus()
  dofAutoFocusEl.classList.toggle('on', auto)
  dofAutoFocusEl.setAttribute('aria-pressed', String(auto))
  dofAutoFocusEl.textContent = `⊙ Autofocus · ${auto ? 'On' : 'Off'}`
  // The focus slider means "offset from the aimed point" with autofocus on and
  // "absolute distance" with it off. Relabel rather than offer two sliders.
  dofFocusRowEl.dataset.mode = auto ? 'offset' : 'absolute'
}
const onDofToggle = () => { depthOfField.setEnabled(!depthOfField.isEnabled()); syncDofToggles() }
const onDofAutoFocus = () => { depthOfField.setAutoFocus(!depthOfField.isAutoFocus()); syncDofToggles() }
dofToggleEl.addEventListener('click', onDofToggle)
dofAutoFocusEl.addEventListener('click', onDofAutoFocus)
syncDofToggles()
bindDesignSlider('dofFocusDistance', DOF.focusDistanceM, asMetres, (v) => depthOfField.setFocusDistance(v))
bindDesignSlider('dofFocalLength', DOF.focalLengthM, asMetres, (v) => depthOfField.setFocalLength(v))
bindDesignSlider('dofBokehScale', DOF.bokehScale, asFactor, (v) => depthOfField.setBokehScale(v))
bindDesignSlider('dofFocusSmoothing', DOF.focusSmoothing, asPercent, (v) => depthOfField.setFocusSmoothing(v))

// Canopy cloud shadows. Scale and contrast are plain uniforms; strength has to go
// through the environment layer, which rewrites that uniform from the daylight
// ramp on every pass and would otherwise overwrite the slider immediately.
const POINT_LIGHTING = EXPERIENCE_CONFIG.pointLighting
bindDesignSlider('cloudShadowStrength', POINT_LIGHTING.cloudShadowStrength, asPercent, (v) => {
  environmentLayer?.setCloudShadowStrength(v)
})
// The uniform is 1/metres — the slider is in metres so the label reads as a grain
// size, with smaller values meaning finer dappling.
bindDesignSlider('cloudShadowScale', POINT_LIGHTING.cloudShadowScaleM, asMetres, (v) => {
  uniforms.cloudShadowScale.value = 1 / Math.max(v, 1)
})
bindDesignSlider('cloudShadowContrast', POINT_LIGHTING.cloudShadowContrast, asPercent, (v) => {
  uniforms.cloudShadowContrast.value = v
})

// Fog colour and tint share one setter: the environment layer folds them into the
// daylight ramp, so neither can be written straight to the uniform.
let fogTintHex: string = toHex(DESIGN.groundFog.color)
let fogTintAmount: number = DESIGN.groundFog.tint
const applyFogTint = () => environmentLayer?.setGroundFogTint(fogTintHex, fogTintAmount)
bindDesignColor('fogColor', DESIGN.groundFog.color, (hex) => { fogTintHex = hex; applyFogTint() })
bindDesignSlider('fogTint', DESIGN.groundFog.tint, asPercent, (v) => { fogTintAmount = v; applyFogTint() })

// One surround colour drives both the screen-space overlay ring and the in-shader
// tint, so the CSS gradient and the geometry can never disagree.
bindDesignColor('surroundColor', DESIGN.surroundColor, (hex) => {
  uniforms.maskSurroundColor.value.set(hex)
  // CSS needs the authored sRGB bytes. Reading r/g/b back off the Color would
  // hand us three's linear-space conversion instead, and the ring would render
  // noticeably darker than the swatch the user picked.
  document.documentElement.style.setProperty(
    '--surround-rgb',
    `${parseInt(hex.slice(1, 3), 16)} ${parseInt(hex.slice(3, 5), 16)} ${parseInt(hex.slice(5, 7), 16)}`,
  )
})
bindDesignSlider('surroundOpacity', DESIGN.surroundOpacity, asPercent, (v) => {
  document.documentElement.style.setProperty('--surround-opacity', String(v))
})

// Hand the dialled-in look back as a config.ts snippet — cheaper than persisting
// panel state, and the values end up where they actually belong.
const designCopyEl = $<HTMLButtonElement>('#designCopy')
designCopyEl.addEventListener('click', async () => {
  const snippet = `design: ${JSON.stringify({
    maskMode: uniforms.maskMode.value,
    mapSaturation: uniforms.mapSaturation.value,
    mapBrightness: uniforms.mapBrightness.value,
    basemapErrorTarget: Number($<HTMLInputElement>('#basemapErrorTarget').value),
    groundPatch: {
      enabled: groundPatchEnabled,
      color: $<HTMLInputElement>('#groundPatchColor').value.replace('#', '0x'),
      amount: groundPatchAmount,
      colorMix: uniforms.groundPatchColorMix.value,
      brightness: uniforms.groundPatchBrightness.value,
      blurM: uniforms.groundPatchBlurM.value,
      threshold: uniforms.groundPatchThreshold.value,
    },
    maskFringe: uniforms.maskFringe.value,
    maskFringeCurve: uniforms.maskFringeCurve.value,
    surroundColor: $<HTMLInputElement>('#surroundColor').value.replace('#', '0x'),
    surroundOpacity: Number($<HTMLInputElement>('#surroundOpacity').value),
    surroundTint: uniforms.maskSurroundAmount.value,
    vignettePosition: {
      sideAngleDeg: vignetteSideAngleDeg,
      topAngleDeg: vignetteTopAngleDeg,
      sideForwardOffsetM: vignetteSideForwardOffsetM,
      sideMinRadiusM: vignetteSideMinRadiusM,
      sideMaxVignetteStrength: vignetteSideMaxStrength,
    },
    groundFog: {
      strength: uniforms.groundFogStrength.value,
      baseOffsetM: groundFogBaseOffset,
      heightM: uniforms.groundFogHeight.value,
      fadeBelowM: uniforms.groundFogFadeBelow.value,
      efoldDistanceM: uniforms.groundFogDistance.value,
      curve: uniforms.groundFogCurve.value,
      color: fogTintHex.replace('#', '0x'),
      tint: fogTintAmount,
    },
  }, null, 2)}
pointLighting: ${JSON.stringify({
    cloudShadowStrength: Number($<HTMLInputElement>('#cloudShadowStrength').value),
    cloudShadowScaleM: Number($<HTMLInputElement>('#cloudShadowScale').value),
    cloudShadowContrast: uniforms.cloudShadowContrast.value,
  }, null, 2)}
atmosphere: ${JSON.stringify({
    fogNearFactor: distanceFogNearFactor,
    fogFarFactor: distanceFogFarFactor,
  }, null, 2)}
depthOfField: ${JSON.stringify({
    enabled: depthOfField.isEnabled(),
    autoFocus: depthOfField.isAutoFocus(),
    focusDistanceM: Number($<HTMLInputElement>('#dofFocusDistance').value),
    focalLengthM: Number($<HTMLInputElement>('#dofFocalLength').value),
    bokehScale: Number($<HTMLInputElement>('#dofBokehScale').value),
    focusSmoothing: Number($<HTMLInputElement>('#dofFocusSmoothing').value),
  }, null, 2)}`
  try {
    await navigator.clipboard.writeText(snippet)
    designCopyEl.textContent = '✓ Copied'
  } catch {
    console.info(`[design]\n${snippet}`)
    designCopyEl.textContent = '⧉ To console'
  }
  setTimeout(() => { designCopyEl.textContent = '⧉ Copy values' }, 1600)
})
$('#flyTo').addEventListener('click', () => flyToCloud(
  reducedMotion
    ? EXPERIENCE_CONFIG.flight.reducedMotionManualDurationMs
    : EXPERIENCE_CONFIG.flight.manualDurationMs,
))

// Double-click anywhere on the terrain pans/zooms there. Attached to the canvas
// only — every UI overlay sits above it, so label clicks can never misfire.
const dblClickNdc = new THREE.Vector2()
const onCanvasDblClick = (event: MouseEvent) => {
  if (bootLoading || cameraFlight.active || aimMode || !videoModalEl.hidden || !globe) return
  dblClickNdc.set(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1,
  )
  ray.setFromCamera(dblClickNdc, camera)
  if (!ray.ray.intersectPlane(groundPlane, hitEcef)) return
  const targetEnu = worldToEnu(hitEcef)
  const endDistance = THREE.MathUtils.clamp(
    cameraGroundRange * 0.38,
    EXPERIENCE_CONFIG.flight.dblClickMinRangeM,
    Math.max(cameraGroundRange, EXPERIENCE_CONFIG.flight.dblClickMinRangeM),
  )
  flyToPoint(
    targetEnu,
    endDistance,
    reducedMotion ? 500 : EXPERIENCE_CONFIG.flight.dblClickDurationMs,
  )
}
canvas.addEventListener('dblclick', onCanvasDblClick)

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  globe?.setResolution()
  stream?.tiles.setResolutionFromRenderer(camera, renderer as any)
  gaussianSplatLayer?.resize()
})

// ---------------------------------------------------------------- streaming / HUD / loop
let flightEndedAt = -Infinity
let wasFlying = false
let appliedHighPrecision: boolean | null = null

/**
 * High-precision matrices are only worth their per-tile CPU matrix multiply
 * once the camera is close enough for the ECEF rounding to reach a pixel.
 * Held off through the loader as well as the flight, so the material rebuild
 * the switch triggers happens exactly once — on arrival, while flightSseFloor
 * still keeps the tile count down — instead of once at each end of the flight.
 */
function setPointCloudRevealed(revealed: boolean): void {
  pointCloudRevealed = revealed
  if (stream) stream.group.visible = revealed
}

/**
 * Let the point cloud join the entrance flight only near its end. Kilometres
 * out it is a speck a weak phone still pays full traversal, download, parse and
 * upload cost for — the iPhone dropped to single-digit frame rates there. The
 * reveal point comes from the loader benchmark, so strong hardware sees the
 * cloud through most of the approach and weak hardware only after landing.
 */
function updateCloudReveal(): void {
  if (!entranceFlightPending) return
  const revealAt = EXPERIENCE_CONFIG.flight.cloudRevealProgress[benchPreset]
  // `!cameraFlight.active` is the backstop: a skipped, interrupted or
  // reduced-motion flight must never leave the cloud parked forever.
  if (cinematicFlightProgress >= revealAt || !cameraFlight.active) {
    entranceFlightPending = false
    setPointCloudRevealed(true)
  }
}

function updateMatrixPrecision(now: number): void {
  if (wasFlying && !cameraFlight.active) flightEndedAt = now
  wasFlying = cameraFlight.active

  const flightSuppressed = renderOptions.effective().flightPrecisionDrop && cameraFlight.active
  const want = highPrecisionMatrices && !bootLoading && !flightSuppressed
  if (want === appliedHighPrecision) return
  appliedHighPrecision = want
  stream?.setHighPrecision(want)
}

function updateStreaming(now: number): StreamingStats | null {
  if (!stream) return null
  // Parked during the entrance flight: no traversal, no fetches, no parsing —
  // and no unloading either, so the tiles the loader already put in place for
  // the destination survive until the reveal.
  if (!pointCloudRevealed) return lastStreamStats

  const quality = adaptiveQuality.update({
    now,
    fps: fps.fps,
    visiblePoints: lastStreamStats?.points ?? 0,
    cameraGroundRange: cameraCloudRange,
  })
  // With the brakes toggled off the density ladder speaks alone — the
  // comparison subject against the Cesium viewer.
  const targetSse = renderOptions.effective().leafLoading
    // Low SSE forces the selected APH branches through to their leaves. It is
    // deliberately scoped to the current camera frustum by TilesRenderer.
    ? 0.25
    : renderOptions.effective().sseBrakes
      ? Math.max(
        quality.sse,
        bootLoading
          ? EXPERIENCE_CONFIG.lod.bootSse
          : flightSseFloor({
            flying: cameraFlight.active,
            msSinceLanding: now - flightEndedAt,
            targetSse: quality.sse,
          }),
      )
      : quality.sse
  if (Math.abs(targetSse - sseAuto) > 0.25) {
    sseAuto = targetSse
    stream.setErrorTarget(sseAuto)
  }
  // The band is the density contract: overview far out, detail up close. The
  // error target alone does not enforce it — a distant camera still fetches
  // p100 tiles and buries a phone — so the ceiling is set from the same band.
  // While the loader is up, stay on the cheapest tier.
  stream.setDensityCeiling(bootLoading ? 0 : 2 - quality.band)
  applyPointSize()

  stream.setMaskSphere(maskWorldActive ? maskSphereWorld : null, maskWorldRadius)
  foveation?.beginFrame()
  stream.update()
  lastStreamStats = stream.stats()
  return lastStreamStats
}

const fpsEl = $('#fpsv')
const msEl = $('#msv')
const visibleEl = $('#visible')
const pointTilesEl = $('#blocks')
const mapTilesEl = $('#mapTiles')
const densityEl = $('#loaded')
const lodEl = $('#displayed')
const cacheEl = $('#cache')
const chipFpsEl = $('#chipFps')
const diagStatsEl = $<HTMLDivElement>('#diagStats')
const diagAltitudeEl = $('#diagAltitude')
const diagRangeEl = $('#diagRange')
const diagStopEl = $('#diagStop')
const diagMissingEl = $('#diagMissing')
if (showDiagnostics) diagStatsEl.hidden = false

function updateHud(stats: StreamingStats | null): void {
  const globeStats = globe?.stats() ?? { visible: 0, cacheBytes: 0, gpuBytes: 0 }
  densityEl.textContent = stats?.density ?? '—'
  lodEl.textContent = `SSE ${sseAuto.toFixed(0)}`
  visibleEl.textContent = stats ? fmtInt(stats.points) : '0'
  pointTilesEl.textContent = String(stats?.visible ?? 0)
  mapTilesEl.textContent = String(globeStats.visible)
  cacheEl.textContent = `${fmtMiB((stats?.cacheBytes ?? 0) + globeStats.cacheBytes)} · ${fmtMiB((stats?.gpuBytes ?? 0) + globeStats.gpuBytes)}`

  const value = fps.fps
  fpsEl.textContent = value ? value.toFixed(0) : '—'
  msEl.textContent = fps.frameMs ? fps.frameMs.toFixed(1) : '—'
  const className = value >= 58 ? 'good' : value >= 40 ? 'warn' : 'bad'
  fpsEl.className = `v ${className}`
  chipFpsEl.textContent = value ? `${value.toFixed(0)} fps` : '—'
  chipFpsEl.className = className

  updateFoveationReadout()
  // The outlines follow the camera, so they need refreshing beyond slider changes.
  // A few times a second is enough to read them and keeps the DOM churn off the
  // frame budget.
  if ((foveationTilesOn || foveationBoxesOn) && performance.now() - lastFoveationTilesMs > 160) {
    lastFoveationTilesMs = performance.now()
    updateFoveationTiles()
    foveation?.updateBoxes()
  }

  // Fly to the height that looks right, read it off here, put it into
  // navigation.zoomStopHeightM.
  if (!showDiagnostics) return
  diagAltitudeEl.textContent = rangeDebug ? `${Math.round(rangeDebug.altitude)} m` : '—'
  diagRangeEl.textContent = rangeDebug ? `${Math.round(rangeDebug.range)} m` : '—'
  diagStopEl.textContent = `${Math.round(navigationClearance)} m`
  diagMissingEl.textContent = String(stats?.missingTiles ?? 0)
}

const foveationReadoutEl = $('#foveationReadout')
let lastFoveationTilesMs = 0

/** Pitch next to the resulting error targets, so a liked slider position can be
 * written down against the camera angle that produced it. */
function updateFoveationReadout(): void {
  if (!foveation) { foveationReadoutEl.textContent = 'not streaming yet'; return }
  if (!foveationSettings.enabled) {
    // The sliders write their values whether or not the mode is on, so the readout
    // has to say which of the two is the reason nothing is moving.
    foveationReadoutEl.textContent = 'mode off — sliders have no effect'
    return
  }
  const { core, periphery, coreSse, edgeSse } = foveation.stats()
  foveationReadoutEl.textContent =
    `${cameraPitchDeg().toFixed(0)}° down · SSE ${coreSse.toFixed(1)} → ${edgeSse.toFixed(1)} · ${core} core / ${periphery} outside`
}

function loop(now: number): void {
  if (graphicsFailed) return
  fps.tick(now)
  // Solo-Modus: nur die 3DGS-Ansicht rendern, alles andere ruht (spart die
  // WebGPU-Punktwolke, Wolken-Raymarch, Streaming). Eigener WebGL-Renderer.
  if (gaussianSplatLayer?.isEnabled()) { gaussianSplatLayer.update(); return }
  cameraFlight.update(now)
  updateCloudReveal()
  updateMatrixPrecision(now)
  keyboardNavigation?.update(
    now,
    cameraGroundRange,
    !bootLoading && !cameraFlight.active && videoModalEl.hidden,
    isZoomInBlocked(),
    navigationClearance,
  )
  globe?.update(enforceNavigationBounds)
  updateMaskFollow()
  updateAtmosphere(now)
  const stats = updateStreaming(now)
  const daylightState = environmentLayer?.update(
    now,
    camera,
    cameraGroundRange,
    fps.fps,
    !bootLoading && !cameraFlight.active && videoModalEl.hidden,
  )
  if (daylightState) {
    updateTimeControls(daylightState)
    fieldModelLayer?.setDaylightPhase(daylightState.phase)
  }
  const nextFieldTier = environmentLayer?.getCloudState().tier ?? null
  if (nextFieldTier && nextFieldTier !== lastFieldTier) {
    lastFieldTier = nextFieldTier
    fieldModelLayer?.setPerformanceTier(nextFieldTier)
  }
  const options = renderOptions.effective()
  if (options.fieldModels) fieldModelLayer?.update(now)
  if (options.donationShape) donationShapeLayer?.update(now, camera)
  if (options.markers) {
    markerLayer?.update(
      now,
      camera,
      cameraGroundRange,
      uniforms.maskCenter.value,
      uniforms.maskRadius.value,
      uniforms.maskMode.value === 2 && uniforms.vignetteStrength.value > 0.01,
    )
    updateAimTarget()
  }
  updateRainCycle(now)
  const nextRainActive = rainLayer?.update(now, camera, cameraGroundRange) ?? false
  if (nextRainActive !== rainVisualActive) {
    rainVisualActive = nextRainActive
    updateRainToggle()
  }
  if (daylightState) audioLayer?.update(daylightState, nextRainActive)
  updateLoaderVisual(now, stats, globe?.stats().visible ?? 0)

  updateHud(stats)
  // Spends a fixed point budget on whatever tiles have arrived and returns
  // immediately once the queue is empty, which it is for all but the first
  // seconds after a tile loads.
  groundPatchMask.update()
  depthOfField.update(cameraGroundRange)
  depthOfField.render()
}

// ---------------------------------------------------------------- boot
async function main(): Promise<void> {
  if (!baseUrl) { showLoadError('CloudFront domain missing from the environment.'); return }
  // A missing basemap key is no longer fatal, for the same reason the loader no
  // longer waits on the basemap: the point cloud is the payload. The globe still
  // gets built and simply fails its tile requests, which the loader's grace
  // period absorbs.
  if (!MAPTILER_KEY) {
    console.warn('[boot] VITE_MAPTILER_API_KEY missing — continuing without a basemap.')
  }

  setLoadProgress(0.06, 'Initialising GPU and map system …')
  await renderer.init()
  setLoadProgress(0.16, 'Graphics ready. Connecting to the field station …')
  const backend: any = (renderer as any).backend
  const isWebGPU = Boolean(backend?.isWebGPUBackend ?? (backend && /WebGPU/i.test(backend.constructor?.name)))
  const badge = $('#backend')
  badge.textContent = isWebGPU ? 'WebGPU' : 'WebGL2'
  badge.classList.toggle('webgl', !isWebGPU)
  // Which GPU did the browser actually hand us? On Windows dual-GPU machines
  // Chrome can silently pick the integrated GPU — then every benchmark verdict
  // is about the wrong card. One log line makes tester reports diagnosable.
  try {
    const adapterInfo = backend?.adapter?.info ?? backend?.device?.adapterInfo
    console.info(`[graphics] backend=${isWebGPU ? 'WebGPU' : 'WebGL2'}`
      + (adapterInfo ? ` adapter=${adapterInfo.vendor ?? '?'} ${adapterInfo.architecture ?? ''} ${adapterInfo.description ?? ''}`.trimEnd() : ''))
  } catch { /* adapter info is best-effort diagnostics */ }
  installGraphicsRecovery(backend)

  // One shared density volume drives both the volumetric clouds and the drifting
  // canopy shadows in the point-cloud material. It must be registered before the
  // first streamed tile compiles its material.
  cloudNoiseTexture = createCloudNoiseTexture(
    classifyTier(isWebGPU) === 'strong'
      ? EXPERIENCE_CONFIG.clouds.textureSizeStrong
      : EXPERIENCE_CONFIG.clouds.textureSize,
  )
  setCloudShadowTexture(cloudNoiseTexture)

  setStatus('Loading adaptive point-cloud tree…')
  setLoadProgress(0.22, 'Loading survey area and coordinates …')
  const manifest = await fetchGlobeManifest(baseUrl, dataset)
  setLoadProgress(0.28, 'Survey area located. Building the scene …')
  enuFrame.fromArray(manifest.rootTransform)
  enuInverse.copy(enuFrame).invert()
  uniforms.enuInverse.value.copy(enuInverse)
  enuUp.setFromMatrixColumn(enuFrame, 2).normalize()

  if (manifest.areaBbox) {
    const [, , minZ] = manifest.areaBbox
    // Imagery is draped on the bare ellipsoid, so ground level is ellipsoidal
    // height 0. Dropping by the bbox floor alone lands the cloud on the ENU
    // origin, which itself sits enuOriginLonLat[2] above that — hence both.
    const originHeight = manifest.enuOriginLonLat?.[2] ?? 0
    areaMinZ = minZ
    areaOriginHeight = originHeight
    // The ENU AABB is tilted and therefore overstates vertical height, so the
    // canopy height comes from the source Z span (about 74 m for Peru).
    const configuredStop = EXPERIENCE_CONFIG.navigation.zoomStopHeightM
    const canopyHeight = manifest.areaVerticalSpan ?? EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM
    navigationClearance = Math.max(configuredStop, canopyHeight)
    if (navigationClearance > configuredStop) {
      console.info(
        `[navigation] zoom stop raised from ${Math.round(configuredStop)} m to `
        + `${Math.round(navigationClearance)} m — the canopy is that tall here.`,
      )
    }
    navigationFloorZ = minZ + navigationClearance
    // The shader's ENU frame still carries zOffset, so ground-relative heights
    // for the golden rim and the virtual cloud deck must add it back.
    areaSpan = manifest.areaVerticalSpan ?? EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM
    areaHeightsKnown = true
    applyPointCloudLift()
    syncLiftReadout()
  }

  const surveyBbox = manifest.surveyBbox ?? manifest.areaBbox
  if (surveyBbox) {
    const [minX, minY, , maxX, maxY] = surveyBbox
    cloudCenterEnu.set((minX + maxX) / 2, (minY + maxY) / 2, areaMinZ + 40)
    navigationBoundsRadius = Math.max(
      EXPERIENCE_CONFIG.navigation.minimumBoundsRadiusM,
      Math.hypot(maxX - minX, maxY - minY) * EXPERIENCE_CONFIG.navigation.surveyBoundsScale,
    )
  }
  enuToWorld(cloudCenterEnu, cloudCenterEcef)
  uniforms.maskCenter.value.set(cloudCenterEnu.x, cloudCenterEnu.y)
  const planePoint = enuToWorld(new THREE.Vector3(cloudCenterEnu.x, cloudCenterEnu.y, cloudCenterEnu.z - 40))
  groundPlane.setFromNormalAndCoplanarPoint(enuUp, planePoint)
  enuFrameReady = true

  globe = createGlobe({
    renderer: renderer as any,
    camera,
    scene,
    maptilerKey: MAPTILER_KEY,
    cameraClearance: freeOrbit ? 1 : navigationClearance,
    uniforms,
  })
  if (freeOrbit) {
    globe.controls.maxAltitude = THREE.MathUtils.degToRad(89.9)
    globe.controls.minDistance = 1
  }
  keyboardNavigation = createKeyboardNavigation({
    camera,
    controls: globe.controls,
    guide: $('#keyboardGuide'),
    guideToggle: $<HTMLButtonElement>('#keyboardGuideToggle'),
    guideClose: $<HTMLButtonElement>('#keyboardGuideClose'),
    aimToggle: $<HTMLButtonElement>('#aimModeButton'),
    onToggleAim: toggleAimMode,
    onActivateAim: activateAimTarget,
    onDismissAim: dismissAimMode,
  })
  // Lifted out of the call because the ground-patch mask resolves the per-cell
  // subtree links relative to it.
  const pointTilesetUrl = pointTree === 'aph'
    ? `${baseUrl}/${manifest.adaptiveHierarchyDataset}/${manifest.adaptiveHierarchyTilesetFile}`
    : `${baseUrl}/${manifest.oneLodTreeDataset}/${manifest.oneLodTreeTilesetFile}`
  stream = createStreamingCloud({
    tilesetUrl: pointTilesetUrl,
    requestVolumes: pointTree !== 'aph',
    // The APH quadtree only pays off with residency to match: the Cesium
    // reference runs a 1 GiB cache, the One-LOD defaults sit at 96 MiB and would
    // evict close-range nodes as fast as they arrive.
    limits: pointTree === 'aph'
      ? { cacheMinBytes: 256 * 1024 * 1024, cacheMaxBytes: 768 * 1024 * 1024, cacheMaxTiles: 1200, gpuBytesTarget: 384 * 1024 * 1024 }
      : undefined,
    camera,
    renderer,
    scene,
    uniforms,
    errorTarget: sseAuto,
    debugVolume: showDiagnostics,
    onPointTile: (object) => groundPatchMask.addTile(object),
  })
  // Options can be selected before the async boot sequence creates the stream.
  stream.setLeafLoading(renderOptions.effective().leafLoading)
  // Same reason the settings object lives outside: the panel is bound long before
  // this point, so foveation adopts the values already on the sliders.
  foveation = createFoveation(stream.tiles, camera, foveationSettings)
  applyHeightOffset()
  // The rectangle is settled exactly once, off the critical path: the survey never
  // moves. Coverage then accumulates from the point tiles the renderer loads anyway
  // — see ground-patch-mask for why the points, and not the node boxes, are the only
  // source fine enough to leave the river showing.
  stream.tiles.addEventListener('load-root-tileset' as any, () => {
    if (groundPatchMaskBuilt) return
    groundPatchMaskBuilt = true
    const patch = EXPERIENCE_CONFIG.design.groundPatch
    void groundPatchMask.setExtent({
      tilesetUrl: pointTilesetUrl,
      rootTileSet: (stream as any).tiles.rootTileSet,
      enuInverse,
      maxDepth: patch.maskMaxDepth,
    }).then((boxes) => {
      if (!boxes) {
        console.warn('[ground-patch] tileset carried no usable node boxes — patch stays off')
        uniforms.groundPatchAmount.value = 0
        return
      }
      applyGroundPatchExtent()
      console.info(`[ground-patch] lattice sized from ${boxes} node boxes`)
      }).catch((error) => {
      console.warn('[ground-patch] extent failed — patch stays off', error)
      uniforms.groundPatchAmount.value = 0
    })
  })
  // Debug handle for streaming diagnosis in the console.
  ;(window as any).__wild = {
    stream,
    camera,
    get flight() { return cameraFlight.active },
    get sse() { return sseAuto },
    get range() { return rangeDebug },
  }

  environmentLayer = createEnvironmentLayer({
    scene,
    renderer,
    fog: distanceFog,
    uniforms,
    enuFrame,
    zOffset,
    surveyCentreEnu: cloudCenterEnu,
    surveyRadiusM: navigationBoundsRadius,
    originLonLat: manifest.enuOriginLonLat,
    cloudNoiseTexture: cloudNoiseTexture!,
    isWebGPU,
    reducedMotion,
    onCloudStateChange: updateCloudControls,
  })
  updateCloudControls(environmentLayer.getCloudState())
  updateTimeControls(environmentLayer.getDaylightState())
  // Hand over anything dialled in while the layer did not exist yet — both of
  // these live on the layer because it owns the daylight ramp they ride on.
  applyFogTint()
  environmentLayer.setCloudShadowStrength(Number($<HTMLInputElement>('#cloudShadowStrength').value))
  audioLayer = createAudioLayer({ toggle: soundToggleEl, status: audioStatusEl })
  soundToggleEl.disabled = false
  audioLayer.update(environmentLayer.getDaylightState(), rainVisualActive)

  if (manifest.areaBbox) {
    markerLayer = createMarkerLayer({
      scene,
      overlay: $('#markerOverlay'),
      enuFrame,
      zOffset,
      areaBbox: manifest.areaBbox as [number, number, number, number, number, number],
      centre: [
        cloudCenterEnu.x + EXPERIENCE_CONFIG.markers.centreOffsetM[0],
        cloudCenterEnu.y + EXPERIENCE_CONFIG.markers.centreOffsetM[1],
      ],
      dataset,
      reducedMotion,
      onOpenVideo: openFieldVideo,
      onFlyToMarker: (targetEnu) => flyToPoint(
        targetEnu,
        EXPERIENCE_CONFIG.flight.markerApproachDistanceM,
        reducedMotion ? 500 : EXPERIENCE_CONFIG.flight.markerFlightDurationMs,
      ),
    })
  }
  const donationSource = await donationShapePromise
  if (donationSource && globe) {
    const ellipsoid = (globe as any).ellipsoid
    const shapeEcef = new THREE.Vector3()
    const shapeEnu = new THREE.Vector3()
    donationShapeLayer = createDonationShapeLayer({
      scene,
      overlay: $('#markerOverlay'),
      enuFrame,
      zOffset,
      source: donationSource,
      // lon/lat -> raw ENU. The ellipsoid wants (lat, lon) in radians, the
      // opposite order and unit of the GeoJSON, and the returned height is
      // discarded — the parcel's z comes from the point-cloud probe alone.
      toLocal: (lon, lat, out) => {
        ellipsoid.getCartographicToPosition(
          THREE.MathUtils.degToRad(lat), THREE.MathUtils.degToRad(lon), 0, shapeEcef,
        )
        shapeEnu.copy(shapeEcef).applyMatrix4(enuInverse)
        out[0] = shapeEnu.x
        out[1] = shapeEnu.y
        return out
      },
      fallbackGroundZ: areaMinZ,
      canopyHeightM: manifest.areaVerticalSpan ?? EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM,
      probe: (centreEnu, radiusM) => {
        const sample = stream?.sampleGroundZ(centreEnu, radiusM, enuInverse)
        if (!sample) return null
        // sampleGroundZ reports the tiles' own ENU height, straight out of
        // enuFrame⁻¹. Everything else here — areaMinZ, the ground plane, the
        // layer root, enuToWorld/worldToEnu — works in the ground-snapped frame
        // that carries zOffset, so the lift is removed exactly once, here.
        // Measured on the Peru site: raw −25.2 m − (−219.95 m) = 194.8 m, which
        // is where a hand scan of the tile buffers under the parcel puts the
        // forest floor.
        return {
          ...sample,
          groundZ: sample.groundZ - zOffset,
          canopyZ: sample.canopyZ - zOffset,
        }
      },
      reducedMotion,
    })
    const info = donationShapeLayer.info()
    console.info(
      `[donation-shape] ${info.areaM2.toFixed(2)} m² · ${info.cellCount} cells of `
      + `${info.cellAreaM2.toFixed(3)} m² · ${info.gridSegmentCount} grid + ${info.rimSegmentCount} rim segments`
      + ` · lattice ${info.gridExact ? 'exact' : 'rasterised'} · group ${info.group ?? 'n/a'}`,
    )
    // Apply the current panel state now: a click during loading must not be lost,
    // same reason field-model-layer re-applies its flag on arrival.
    setDonationStyle(donationStyle)
    setDonationForm(donationForm)
    setDonationSmoothness(donationSmoothness, true)
    donationShapeLayer.setVisible(renderOptions.effective().donationShape)
    // The arc may already be in the air if the JSON was slow; bend its tail.
    if (cameraFlight.active) cameraFlight.retargetCloud(donationShapeLayer.flightTargetEnu()!)
  }

  rainLayer = createRainLayer(scene)
  rainLayer.setEnabled(rainRequested)
  setLoadProgress(0.35, 'Loading first canopy point clouds …')

  // Bootstrap close enough to request real point tiles. The fullscreen loader
  // conceals this staging position; once both data layers are visible we jump
  // to the overview and begin the user-facing flight.
  const stagingTarget = donationShapeLayer?.flightTargetEnu() ?? cloudCenterEnu
  const stagingOffset = donationFlightOffset() ?? EXPERIENCE_CONFIG.flight.destinationOffsetM
  camera.position.copy(enuToWorld(new THREE.Vector3(
    stagingTarget.x + stagingOffset[0],
    stagingTarget.y + stagingOffset[1],
    stagingTarget.z + stagingOffset[2],
  )))
  camera.up.copy(enuUp)
  camera.lookAt(enuToWorld(stagingTarget.clone()))

  setMaskMode(EXPERIENCE_CONFIG.design.maskMode)
  setStatus('Adaptive streaming · loading tiles…')
  renderer.setAnimationLoop(loop)

  const fieldOrigin = new THREE.Vector3(
    cloudCenterEnu.x + EXPERIENCE_CONFIG.markers.centreOffsetM[0],
    cloudCenterEnu.y + EXPERIENCE_CONFIG.markers.centreOffsetM[1],
    areaMinZ,
  )
  void createFieldModelLayer({
    scene,
    camera,
    enuFrame,
    zOffset,
    originEnu: fieldOrigin,
    performanceTier: environmentLayer.getCloudState().tier,
    reducedMotion,
    onStatus: (message) => console.info(`[field-models] ${message}`),
  }).then((layer) => {
    if (disposed) layer.dispose()
    else {
      fieldModelLayer = layer
      // The GLTFs load lazily — apply the flag that is effective right now,
      // not the one from when loading started.
      layer.setVisible(renderOptions.effective().fieldModels)
      if (lastFieldTier) layer.setPerformanceTier(lastFieldTier)
      layer.setDaylightPhase(environmentLayer?.getDaylightState().phase ?? 'day')
      if (modelEditorEnabled) {
        modelTransformEditor = createModelTransformEditor({
          scene,
          camera,
          domElement: renderer.domElement,
          globeControls: globe!.controls,
          targets: layer.getEditTargets(),
          onTowerTransform: (positionM, sensorHeightM) => {
            markerLayer?.setTowerSensorTransform(positionM, sensorHeightM)
          },
        })
      }
    }
  }).catch((error) => console.warn('[field-models] optional layer failed', error))

  // ?compare=1: everything above is created normally, then compare mode
  // switches the optimisations off in one atomic pass — same code path as the
  // panel master toggle, so live and boot behaviour cannot drift apart.
  if (compareParam) setCompareMode(true)

  ;(window as any).__three = {
    renderer, scene, camera, uniforms, globe, stream, markerLayer,
    rainLayer, environmentLayer, fieldModelLayer, donationShapeLayer, loop, renderOptions,
    groundPatchMask,
  }
  ;(window as any).__bench = async (frames = 60) => {
    const started = performance.now()
    for (let index = 0; index < frames; index++) await (renderer as any).renderAsync(scene, camera)
    const ms = (performance.now() - started) / frames
    return {
      frames,
      msPerFrame: Number(ms.toFixed(2)),
      fps: Number((1000 / ms).toFixed(1)),
      density: lastStreamStats?.density,
      visiblePoints: lastStreamStats?.points,
      sse: sseAuto,
    }
  }
}

function dispose(): void {
  disposed = true
  renderer.setAnimationLoop(null)
  setAimMode(false, false)
  cancelAnimationFrame(loaderProgressRaf)
  loaderProgressRaf = 0
  window.clearInterval(loaderStallTimer)
  closeFieldVideo(false)
  rainLayer?.dispose()
  audioLayer?.dispose()
  keyboardNavigation?.dispose()
  markerLayer?.dispose()
  donationShapeLayer?.dispose()
  modelTransformEditor?.dispose()
  fieldModelLayer?.dispose()
  environmentLayer?.dispose()
  stream?.dispose()
  globe?.dispose()
  depthOfField.dispose()
  cloudNoiseTexture?.dispose()
  cloudNoiseTexture = null
  eagleBench?.dispose()
  eagleBench = null
  if (import.meta.env.DEV) delete (window as any).__eagleBenchDebug
  delete loaderEagleCanvasEl.dataset.benchState
  rainToggleEl.removeEventListener('click', onRainToggle)
  compareToggleEl.removeEventListener('click', onCompareToggle)
  compareReloadEl.removeEventListener('click', onCompareReload)
  precisionToggleEl.removeEventListener('click', onPrecisionToggle)
  liftToggleEl.removeEventListener('click', onLiftToggle)
  dofToggleEl.removeEventListener('click', onDofToggle)
  dofAutoFocusEl.removeEventListener('click', onDofAutoFocus)
  groundPatchToggleEl.removeEventListener('click', onGroundPatchToggle)
  gaussianToggleEl.removeEventListener('click', onGaussianToggle)
  document.removeEventListener('keydown', onSplatKeyDown)
  document.removeEventListener('keyup', onSplatKeyUp)
  gaussianSplatLayer?.dispose()
  cloudToggleEl.removeEventListener('click', onCloudToggle)
  timeDockToggleEl.removeEventListener('click', onTimeDockToggle)
  timeSliderEl.removeEventListener('input', onTimeInput)
  timeNowEl.removeEventListener('click', onTimeNow)
  loaderRetryEl.removeEventListener('click', onLoaderRetry)
  loaderSoundOptEl.removeEventListener('click', onLoaderSoundOpt)
  loaderStartEl.removeEventListener('click', onLoaderStart)
  canvas.removeEventListener('dblclick', onCanvasDblClick)
  videoCloseEl.removeEventListener('click', onVideoClose)
  videoModalEl.removeEventListener('click', onVideoBackdrop)
  fieldVideoEl.removeEventListener('canplay', onVideoCanPlay)
  fieldVideoEl.removeEventListener('playing', onVideoPlaying)
  fieldVideoEl.removeEventListener('waiting', onVideoWaiting)
  fieldVideoEl.removeEventListener('pause', onVideoPause)
  fieldVideoEl.removeEventListener('error', onVideoError)
  document.removeEventListener('keydown', onDocumentKeydown)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('pagehide', onPageHide)
  window.removeEventListener('pageshow', onPageShow)
  renderer.dispose()
}

const onPageHide = (event: PageTransitionEvent) => {
  closeFieldVideo(false)
  if (!event.persisted) dispose()
}
const onPageShow = (event: PageTransitionEvent) => {
  if (event.persisted && !graphicsFailed) renderer.setAnimationLoop(loop)
}

window.addEventListener('pagehide', onPageHide)
window.addEventListener('pageshow', onPageShow)

main().catch((error: any) => {
  console.error('[threejs-test] fatal', error)
  setStatus(`Error: ${error?.message ?? error}`)
  showLoadError(`Loading failed: ${error?.message ?? error}`)
})
