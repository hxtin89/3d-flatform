// Three.js globe + point cloud with one adaptive streaming path on every device.
// The One LOD Tree moves from Overview p02 to Explore p10 and Detail p100 while
// one renderer owns traversal, downloads, CPU cache and GPU residency.
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { createUniforms, setCloudShadowTexture } from './point-cloud'
import { createCloudNoiseTexture } from './cloud-noise'
import { createGlobe, type Globe } from './globe'
import { createStreamingCloud, type StreamingCloud, type StreamingStats } from './streaming'
import { fetchGlobeManifest } from './manifest'
import { AdaptiveQualityController, APH_BAND_SSE } from './adaptive-quality'
import { createMarkerLayer, type MarkerActionTarget, type MarkerLayer } from './marker-layer'
import { createStoryboard, type StoryboardHandle } from './storyboard'
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
import { createGaussianSplatLayer, type GaussianSplatLayer } from './gaussian-splat-layer'
import {
  createRenderOptions,
  RENDER_OPTION_ROWS,
  type RenderOptionKey,
  type RenderOptions,
} from './render-options'
import type { MemoryBudgetSnapshot } from './streaming'
import {
  AUTO, ZOOM_BAND_ROWS, createPointSource,
  type PointSourceController, type ResolvedSource, type ZoomBand,
} from './point-source'
import {
  attachOrigin, ecefToRenderMatrix, getEcefRoot, onRebase, originStats,
  rebaseTo, renderToEcef, renderToEcefMatrix, setOriginEnabled,
} from './origin'

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
/** `?clean=1` — deterministic screenshot/review state, reached in ONE navigation.
 *
 * Puts the page straight into the state a visual comparison needs: loading
 * screen skipped, every piece of dev chrome hidden (see body.chrome-hidden),
 * and the frame already at its resting margin so the widgets sit where they
 * finally sit. Without it that state takes three separate script injections
 * after load, each racing the layout — and getting the order wrong silently
 * yields a half-revealed frame that looks like a real layout bug.
 *
 * The point cloud still streams in behind as usual; this only touches the UI
 * layer, so it is a review aid, not a second rendering path. */
const cleanMode = params.get('clean') === '1'
/** Cesium comparison: start without the loader benchmark and without the
 * boot-time pixel-ratio cap, then enable compare mode (all optimisations off,
 * only the zoom-dependent density ladder remains). Everything else is also
 * switchable live via the panel — this param covers the construction-time
 * pieces a running session cannot change. */
const compareParam = params.get('compare') === '1'
/** Shows the measured heights in the HUD. Implied by freeorbit, but available
 * on its own so the configured zoom stop can be checked while it still bites. */
const showDiagnostics = freeOrbit || params.has('diag') || import.meta.env.DEV
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
if (cleanMode) {
  loaderEl.style.display = 'none'
  document.body.classList.add('chrome-hidden')
}
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
  if (stats) {
    setLoadProgress(0.35 + 0.6 * stats.progress, loaderDataReady ? undefined : 'Lade erste Kronendach-Punktwolken …')
  }
  const ready = Boolean(stats && stats.visible > 0 && stats.points > 0 && stats.progress >= 0.999 && visibleMapTiles > 0)
  if (ready && !loaderDataReady) {
    loaderDataReady = true
    setLoadProgress(1, 'Feldsystem bereit.')
  }

  if (loaderFinishAt > 0 && now >= loaderFinishAt) {
    loaderEl.hidden = true
    bootLoading = false
    cancelAnimationFrame(loaderProgressRaf)
    loaderProgressRaf = 0
    window.clearInterval(loaderStallTimer)
    setStatus('Adaptive streaming · ready')
  }
}

const onLoaderRetry = () => location.reload()
loaderRetryEl.addEventListener('click', onLoaderRetry)
const onLoaderSoundOpt = () => {
  startWithSound = !startWithSound
  loaderSoundOptEl.setAttribute('aria-pressed', String(startWithSound))
  loaderSoundOptLabelEl.textContent = startWithSound ? 'Mit Naturklängen' : 'Ohne Naturklänge'
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
  const preset: BenchPreset = measured?.preset
    ?? (heuristicTier === 'strong' ? 'strong' : heuristicTier === 'constrained' ? 'constrained' : 'medium')
  // Also decides how late the point cloud joins the entrance flight.
  benchPreset = preset
  console.info(
    `[eagle-bench] ${measured && measured.preset
      ? `${Math.round(measured.pointsAtTarget / 1000)}k of ${Math.round(measured.maxPoints / 1000)}k pts @${EXPERIENCE_CONFIG.eagleBench.targetFps}fps (${measured.samples} samples)`
      : 'no measurement (heuristic fallback)'} → preset ${preset}`,
  )
  // Every preset write below routes through the render-options flags so a
  // toggled-off optimisation (or active compare mode) is never re-applied.
  const options = renderOptions.effective()
  if (preset === 'strong') {
    if (!renderOptions.isCompareMode()) setMaskMode(0)
    presetPixelRatioCap = 1.25
    adaptiveQuality.setPressureFloor(1)
    environmentLayer?.applyMeasuredTier('strong')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.strong
    if (options.presetBudgets) {
      applyStreamMemoryBudget()
      globe?.setMemoryBudget(128 * 1024 * 1024, 96 * 1024 * 1024)
    }
  } else if (preset === 'medium') {
    if (!renderOptions.isCompareMode()) setMaskMode(2)
    presetPixelRatioCap = 1.1
    adaptiveQuality.setPressureFloor(1.4)
    environmentLayer?.applyMeasuredTier('balanced')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.medium
    if (options.presetBudgets) {
      applyStreamMemoryBudget()
      // Imagery working set at errorTarget 1 exceeds 64 MiB on deep zooms —
      // thrash there shows up as a permanently blurry basemap.
      globe?.setMemoryBudget(96 * 1024 * 1024, 64 * 1024 * 1024)
    }
  } else {
    if (!renderOptions.isCompareMode()) setMaskMode(2)
    presetPixelRatioCap = 1
    adaptiveQuality.setPressureFloor(2)
    environmentLayer?.applyMeasuredTier('constrained')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.constrained
    // Previously left at the library default of 96 MB, which thrashes for the
    // same reason, with less headroom to recover.
    if (options.presetBudgets) {
      applyStreamMemoryBudget()
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
  designSystemDemo?.reveal()
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
  loaderStatusEl.textContent = 'Die Datenverbindung antwortet ungewöhnlich langsam.'
  loaderRetryEl.hidden = false
}, 1000)

// ---------------------------------------------------------------- overlays
const compactViewport = matchMedia('(max-width: 700px)').matches
document.body.classList.toggle('hud-open', !compactViewport)
document.body.classList.toggle('panel-open', !compactViewport)
$('#hudChip').addEventListener('click', () => document.body.classList.toggle('hud-open'))
// The cogwheel is a "clean mode" switch: one tap hides every piece of app/dev
// chrome (fps chip, map billboards, attribution, field-keys, time dock, the
// Frame ein/aus button, HUD and this settings panel) so only the @wi/ui widget
// layer is left over the point cloud. See body.chrome-hidden in
// threejs-test.html for the full list.
//
// It used to open #panel directly. That panel is dev tooling rather than
// something the composition needs, so it now rides along with the rest of the
// chrome -- but it would otherwise become unreachable, hence the shortcut
// below. Shift+S rather than a plain key so it can't fire while the user is
// typing into one of the panel's own inputs.
const panelChip = $('#panelChip')
panelChip.setAttribute('aria-label', 'Toggle interface')
panelChip.setAttribute('aria-pressed', String(cleanMode))
panelChip.addEventListener('click', () => {
  const hidden = document.body.classList.toggle('chrome-hidden')
  panelChip.setAttribute('aria-pressed', String(hidden))
})
addEventListener('keydown', (event) => {
  if (event.shiftKey && (event.code === 'KeyS' || event.key === 'S')) {
    document.body.classList.toggle('panel-open')
  }
})
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
setOriginEnabled(!params.has('noorigin'))
attachOrigin(scene)
const distanceFog = new THREE.Fog(
  DAYLIGHT_SKY,
  EXPERIENCE_CONFIG.atmosphere.maximumFarM * EXPERIENCE_CONFIG.atmosphere.fogNearFactor,
  EXPERIENCE_CONFIG.atmosphere.maximumFarM * EXPERIENCE_CONFIG.atmosphere.fogFarFactor,
)
scene.fog = distanceFog
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  10,
  EXPERIENCE_CONFIG.atmosphere.maximumFarM,
)
const uniforms = createUniforms()
const adaptiveQuality = new AdaptiveQualityController(pointTree === 'aph' ? APH_BAND_SSE : undefined)
const fps = new Fps()

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
let markerLayer: MarkerLayer | null = null
let designSystemDemo: StoryboardHandle | null = null
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
/** Which density pack is streaming, and the panel state that decides it. */
let pointSource: PointSourceController | null = null
let activeSource: ResolvedSource | null = null
let lastBand: ZoomBand = 2
let pendingSourceKey: string | null = null
let pendingSince = 0
let lastSwapAt = -Infinity
/** A panel pick skips the dwell — the user is waiting for the comparison. */
let userSwapRequested = false
/** How long a new zoom level has to hold before its pack is fetched. */
const SWAP_DWELL_MS = 900
/** Floor between two rebuilds, whatever the camera does. */
const SWAP_COOLDOWN_MS = 2_500
/** Settle time after a camera flight before a swap may start. */
const SWAP_LANDING_MS = 600
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
/** Cache and GPU residency per measured device tier. A settled Detail p100 view
 * measures ~220 MB; budgets below that evict tiles the very next frame needs. */
const STREAM_BUDGET_BY_PRESET: Record<BenchPreset, { cacheBytes: number; gpuBytes: number }> = {
  strong: { cacheBytes: 384 * MIB, gpuBytes: 256 * MIB },
  medium: { cacheBytes: 256 * MIB, gpuBytes: 176 * MIB },
  constrained: { cacheBytes: 160 * MIB, gpuBytes: 112 * MIB },
}
/** Single place the stream budget comes from, so a rebuilt streamer (density-pack
 * swap) never silently falls back to its construction defaults. */
function applyStreamMemoryBudget(): void {
  if (!stream) return
  if (!renderOptions.effective().presetBudgets) {
    stream.setMemoryBudget(COMPARE_STREAM_BUDGET.cacheBytes, COMPARE_STREAM_BUDGET.gpuBytes)
    return
  }
  const budget = STREAM_BUDGET_BY_PRESET[benchPreset]
  stream.setMemoryBudget(budget.cacheBytes, budget.gpuBytes)
}
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
        scene.fog = effective.fogAtmosphere ? distanceFog : null
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
          applyStreamMemoryBudget()
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
        if (globe) globe.tiles.group.visible = effective.basemapImagery
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

// ---------------------------------------------------------------- zoom levels
// Which density pack streams at which zoom level. The options come from the area
// manifest, so packs the pipeline publishes later appear without a code change.
const zoomBandValueEl = $('#zoomBandValue')
const zoomRangeValueEl = $('#zoomRangeValue')
const zoomSseValueEl = $('#zoomSseValue')
const zoomDatasetValueEl = $('#zoomDatasetValue')
const zoomPackRowsEl = $<HTMLDivElement>('#zoomPackRows')
const packSelects = new Map<ZoomBand, HTMLSelectElement>()

function buildZoomPackRows(controller: PointSourceController): void {
  zoomPackRowsEl.replaceChildren()
  packSelects.clear()
  for (const rowDef of ZOOM_BAND_ROWS) {
    const row = document.createElement('div')
    row.className = 'row zoom-row'
    const label = document.createElement('label')
    label.className = 'h'
    label.htmlFor = `zoomPack-${rowDef.band}`
    label.textContent = rowDef.label
    const select = document.createElement('select')
    select.id = `zoomPack-${rowDef.band}`
    select.append(new Option('Auto · session tree', AUTO))
    for (const pack of controller.packs()) {
      // Packs that are not built yet stay visible but unselectable — the panel
      // is also the place to see what the pipeline has published so far.
      const option = new Option(pack.available ? pack.label : `${pack.label} — ${pack.status}`, pack.id)
      option.disabled = !pack.available
      select.append(option)
    }
    select.value = controller.assignment(rowDef.band)
    select.addEventListener('change', () => {
      controller.setAssignment(rowDef.band, select.value)
      userSwapRequested = true
    })
    const note = document.createElement('span')
    note.className = 'weather-note'
    note.textContent = rowDef.note
    row.append(label, select, note)
    zoomPackRowsEl.appendChild(row)
    packSelects.set(rowDef.band, select)
  }
}

/** Re-read the controller after it changed state on its own (failed pack). */
function syncPackSelects(): void {
  if (!pointSource) return
  const packs = pointSource.packs()
  for (const [band, select] of packSelects) {
    select.value = pointSource.assignment(band)
    for (const option of Array.from(select.options)) {
      const pack = packs.find((entry) => entry.id === option.value)
      if (pack) option.disabled = !pack.available
    }
  }
}

let lastZoomPanelUpdate = -Infinity
function updateZoomPanel(now: number): void {
  if (now - lastZoomPanelUpdate < 250 || !document.body.classList.contains('panel-open')) return
  lastZoomPanelUpdate = now
  const rowDef = ZOOM_BAND_ROWS.find((entry) => entry.band === lastBand)
  zoomBandValueEl.textContent = rowDef ? rowDef.label.split(' · ')[0] : String(lastBand)
  zoomRangeValueEl.textContent = Number.isFinite(cameraCloudRange) ? `${fmtInt(cameraCloudRange)} m` : '—'
  zoomSseValueEl.textContent = sseAuto.toFixed(0)
  if (activeSource) {
    const text = `${activeSource.label}${activeSource.areaId ? ` · ${activeSource.areaId}` : ''}`
    zoomDatasetValueEl.textContent = text
    zoomDatasetValueEl.title = activeSource.datasetPath
  }
  for (const [band, select] of packSelects) {
    select.parentElement?.classList.toggle('is-active', band === lastBand)
  }
}

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

// ENU -> ECEF frame of the survey. Absolute, straight from the manifest: this
// pair stays in the logical ECEF frame and is only ever used to derive the two
// render-space matrices below, plus the one genuinely absolute conversion
// (lon/lat -> ENU for the parcel outline).
const enuFrame = new THREE.Matrix4()
const enuInverse = new THREE.Matrix4()
/** Same frames shifted by the floating origin — what the scene graph, the
 * camera and the shaders speak. Refreshed on every rebase. */
const enuFrameRender = new THREE.Matrix4()
const enuInverseRender = new THREE.Matrix4()
const cloudCenterEnu = new THREE.Vector3()
/** Survey centre in render space — follows the origin. */
const cloudCenterRender = new THREE.Vector3()
const enuUp = new THREE.Vector3(0, 0, 1)
let zOffset = 0

/** Lift the streamed cloud off the draped imagery. Diagnostic only when off:
 * the canopy and cloud-deck uniforms keep the offset they were bound with, so
 * the height grading no longer lines up. */
function applyHeightOffset(): void {
  stream?.group.position.copy(enuUp).multiplyScalar(heightOffsetEnabled ? zOffset : 0)
}

/** ENU -> render space. Every caller (camera flights, navigation bounds, mask
 * sphere, boot staging, double-click) works in render space, so this is the one
 * place the origin enters. */
function enuToWorld(value: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(value.x, value.y, value.z + zOffset).applyMatrix4(enuFrameRender)
}

function worldToEnu(value: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
  target.copy(value).applyMatrix4(enuInverseRender)
  target.z -= zOffset
  return target
}

/** Everything derived from the origin, in one place: the two render-space ENU
 * matrices, the shader's ENU uniform, and the two world values that are cached
 * across frames instead of living in the scene graph. */
function refreshOriginDerived(): void {
  ecefToRenderMatrix(enuFrame, enuFrameRender)
  renderToEcefMatrix(enuInverse, enuInverseRender)
  uniforms.enuInverse.value.copy(enuInverseRender)
  if (!enuFrameReady) return
  enuToWorld(cloudCenterEnu, cloudCenterRender)
  groundPlane.setFromNormalAndCoplanarPoint(enuUp, enuToWorld(groundPlanePointEnu, groundPlanePointWorld))
}

/**
 * Move the origin to the camera once it has drifted far enough. The threshold
 * scales with viewing range because pan and zoom speed do the same
 * (`keyboard.panRangeFactor`): a fixed one would fire once every few seconds
 * down at the canopy and dozens of times per second on the entrance flight.
 * At the floor of 500 m the float32 step is 6e-5 m against 4 cm per screen
 * pixel at the closest camera range — four orders of magnitude of headroom.
 */
function originThreshold(): number {
  const range = Number.isFinite(cameraGroundRange)
    ? cameraGroundRange
    : EXPERIENCE_CONFIG.atmosphere.fallbackRangeM
  return THREE.MathUtils.clamp(
    range * EXPERIENCE_CONFIG.navigation.originRebaseRangeFactor,
    EXPERIENCE_CONFIG.navigation.originRebaseMinM,
    EXPERIENCE_CONFIG.navigation.originRebaseMaxM,
  )
}

/** Rebasing to the camera exactly makes the post-rebase distance zero, so no
 * hysteresis is needed — it cannot flap. `force` covers teleports (flight
 * starts, boot staging), which are not bounded by any per-frame speed. */
function updateOrigin(force = false): void {
  if (!enuFrameReady) return
  const threshold = originThreshold()
  if (!force && camera.position.lengthSq() < threshold * threshold) return
  rebaseTo(renderToEcef(camera.position, originAnchorEcef))
}

onRebase((delta) => {
  camera.position.add(delta)
  camera.updateMatrixWorld()
  // GlobeControls persists three world points across frames; without this the
  // orbit centre would teleport on the first frame after a rebase.
  const controls = globe?.controls as any
  controls?.pivotPoint?.add(delta)
  controls?.zoomPoint?.add(delta)
  controls?.rotationInertiaPivot?.add(delta)
  refreshOriginDerived()
})

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
    aimReticleLabelEl.textContent = 'Ziel suchen'
  }
  if (announce) {
    announceInteraction(active
      ? 'Fokusmodus aktiviert. Bewege die Kamera, bis ein Ziel einrastet. Mit Enter öffnen, mit C oder Escape beenden.'
      : 'Fokusmodus beendet.')
  }
}

function toggleAimMode(): void {
  if (bootLoading || cameraFlight.active || !videoModalEl.hidden) return
  setAimMode(!aimMode)
}

function activateAimTarget(): boolean {
  if (!aimMode || !videoModalEl.hidden) return false
  if (!aimTarget) {
    announceInteraction('Kein interaktives Ziel im Fadenkreuz.')
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
  if (nextTarget) announceInteraction(`${nextTarget.label} im Fokus. Mit Enter öffnen.`)
}

function openFieldVideo(): void {
  if (!videoModalEl.hidden) return
  setAimMode(false, false)
  videoReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  videoModalEl.hidden = false
  for (const element of modalBackgroundElements) element.inert = true
  videoModalEl.classList.remove('is-ready', 'is-playing')
  videoStatusEl.textContent = 'Video wird geladen …'
  if (globe) globe.controls.enabled = false

  // Stop the map render loop while the native video decoder is active. The
  // already-loaded tiles stay resident, but no point-cloud work competes for GPU.
  renderer.setAnimationLoop(null)
  fieldVideoEl.src = FIELD_VIDEO_URL
  fieldVideoEl.load()
  void fieldVideoEl.play().catch(() => {
    videoStatusEl.textContent = 'Zum Starten bitte Play antippen.'
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
  if (fieldVideoEl.paused) videoStatusEl.textContent = 'Zum Starten bitte Play antippen.'
}
const onVideoPlaying = () => videoModalEl.classList.add('is-ready', 'is-playing')
const onVideoWaiting = () => {
  videoModalEl.classList.remove('is-playing')
  videoStatusEl.textContent = 'Video wird geladen …'
}
const onVideoPause = () => {
  if (videoModalEl.hidden || fieldVideoEl.ended) return
  videoModalEl.classList.remove('is-playing')
  videoStatusEl.textContent = 'Zum Fortsetzen bitte Play antippen.'
}
const onVideoClose = () => closeFieldVideo()
const onVideoError = () => {
  videoModalEl.classList.remove('is-ready', 'is-playing')
  videoStatusEl.textContent = 'Video konnte nicht geladen werden.'
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
/** The plane is not part of the scene graph, so it has to be rebuilt whenever
 * the origin moves — these keep the ENU point it is built from. */
const groundPlanePointEnu = new THREE.Vector3()
const groundPlanePointWorld = new THREE.Vector3()
/** Scratch for choosing a new origin, always in absolute ECEF. */
const originAnchorEcef = new THREE.Vector3()
/** Everything ECEF-anchored hangs under this group, whose matrix is T(-origin).
 * Only the rain layer (which follows the camera) and the editor gizmo stay
 * direct scene children. */
const ecefRoot = getEcefRoot()
const ray = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const hitRender = new THREE.Vector3()
const hitEnu = new THREE.Vector3()
const hit2d = new THREE.Vector2()
const followEnu = new THREE.Vector2()
let followInit = false
const maskSphereEnu = new THREE.Vector3()
const maskSphereWorld = new THREE.Vector3()
let maskWorldActive = false
let maskWorldRadius = 0
let areaMinZ = 0
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

function updateMaskFollow(): void {
  const mode = uniforms.maskMode.value
  ndc.set(0, 0)
  ray.setFromCamera(ndc, camera)

  let missedGround = false
  if (ray.ray.intersectPlane(groundPlane, hitRender)) {
    cameraGroundRange = camera.position.distanceTo(hitRender)
    hitEnu.copy(hitRender).applyMatrix4(enuInverseRender)
    hit2d.set(hitEnu.x, hitEnu.y)
    if (!followInit) { followEnu.copy(hit2d); followInit = true }
    else followEnu.lerp(hit2d, 0.2)
    uniforms.maskCenter.value.copy(followEnu)
  } else {
    cameraGroundRange = camera.position.distanceTo(cloudCenterRender)
    missedGround = true
  }

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

  const radius = THREE.MathUtils.clamp(cameraGroundRange * 0.55, 30, 2000)
  const strength = 1 - smooth01(4, 20, cameraGroundRange / radius)
  const flightBlend = smooth01(0.68, 1, cinematicFlightProgress)
  const visibleStrength = strength * flightBlend
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
  distanceFog.near = atmosphereFar * EXPERIENCE_CONFIG.atmosphere.fogNearFactor
  distanceFog.far = atmosphereFar * EXPERIENCE_CONFIG.atmosphere.fogFarFactor
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
  // `startFromOverview` snaps the camera 130 km out in one step, far past any
  // per-frame threshold — rebase now rather than letting the loop catch up.
  updateOrigin(true)
}

function flyToPoint(targetEnu: THREE.Vector3, endDistanceM: number, durationMs: number): void {
  setAimMode(false, false)
  cameraFlight.toPoint(targetEnu, endDistanceM, durationMs)
  updateOrigin(true)
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
  if (!ray.ray.intersectPlane(groundPlane, hitRender)) return
  const targetEnu = worldToEnu(hitRender)
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
  // Point cloud only — the basemap is pinned to high precision in globe.ts.
  stream?.setHighPrecision(want)
}

/**
 * Build (or rebuild) the streamed point cloud from one resolved density pack.
 * Used for the initial build too, so the boot path and the panel swap cannot
 * drift apart — every piece of stream-local state below has to be re-applied,
 * because `requestVolumes` and the cache limits are construction-time only and
 * a fresh TilesRenderer starts at its defaults.
 */
function rebuildStream(source: ResolvedSource, reason: string): void {
  // Ladder first: the seed error target must already belong to the new tree,
  // otherwise a p02 tileset traverses at the APH target of 4.
  adaptiveQuality.setLadder(source.ladder)
  sseAuto = source.ladder[lastBand] ?? sseAuto

  stream?.dispose()
  stream = null
  lastStreamStats = null

  stream = createStreamingCloud({
    tilesetUrl: source.url,
    requestVolumes: source.requestVolumes,
    limits: source.limits,
    camera,
    renderer,
    scene: ecefRoot,
    uniforms,
    errorTarget: sseAuto,
    debugVolume: showDiagnostics,
    onRootError: (url, error) => onStreamRootError(source, url, error),
  })
  activeSource = source

  applyHeightOffset()
  stream.group.visible = pointCloudRevealed
  stream.setDensityCeiling(bootLoading ? 0 : 2 - lastBand)
  applyStreamMemoryBudget()
  // A new material set means the precision context has to be applied again.
  appliedHighPrecision = null
  updateMatrixPrecision(performance.now())
  stream.setMaskSphere(maskWorldActive ? maskSphereWorld : null, maskWorldRadius)
  lastSwapAt = performance.now()
  // A different density pack means a different point population under the
  // parcel, so its locked ground height has to be measured again.
  if (reason !== 'boot') donationShapeLayer?.resetGroundLock()
  console.info(`[point-source] ${reason} → ${source.label} (${source.datasetPath})`)
}

/** The whole tileset was unreachable — fall the affected rows back to Auto
 * rather than leaving the view empty. */
function onStreamRootError(source: ResolvedSource, url: string, error: unknown): void {
  console.warn('[point-source] tileset root unavailable', url, error)
  if (!pointSource || source.key !== activeSource?.key) return
  pointSource.markFailed(source.packId, source.areaId)
  for (const rowDef of ZOOM_BAND_ROWS) {
    if (pointSource.assignment(rowDef.band) === source.packId) pointSource.setAssignment(rowDef.band, AUTO)
  }
  syncPackSelects()
  zoomDatasetValueEl.textContent = `${source.label} unavailable — back to Auto`
  // The fallback must not wait out the cooldown.
  lastSwapAt = -Infinity
  userSwapRequested = true
}

/**
 * Swap the streamed pack when the active zoom level asks for a different one.
 * Four independent brakes keep a camera sitting on a band edge from thrashing:
 * the band hysteresis upstream, key equality (two levels on the same pack never
 * rebuild), a dwell on the new key, and a cooldown between rebuilds.
 */
function maybeSwapPointSource(now: number, band: ZoomBand): void {
  if (!pointSource || !activeSource) return
  // Never during the loader or a flight: the loader stages tiles at the flight
  // destination and the flight runs on an SSE floor — throwing the tree away
  // there costs the entrance its whole working set.
  if (bootLoading || cameraFlight.active || now - flightEndedAt < SWAP_LANDING_MS) {
    pendingSourceKey = null
    return
  }
  const areaId = enuFrameReady ? pointSource.areaFor(cloudRangeEnu.x, cloudRangeEnu.y) : null
  const next = pointSource.resolve(band, areaId)
  if (next.key === activeSource.key) { pendingSourceKey = null; return }
  if (next.key !== pendingSourceKey) { pendingSourceKey = next.key; pendingSince = now; return }
  if (!userSwapRequested && now - pendingSince < SWAP_DWELL_MS) return
  if (now - lastSwapAt < SWAP_COOLDOWN_MS) return
  pendingSourceKey = null
  userSwapRequested = false
  rebuildStream(next, `zoom level ${band}`)
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
  lastBand = quality.band as ZoomBand
  maybeSwapPointSource(now, lastBand)
  if (!stream) return lastStreamStats
  // With the brakes toggled off the density ladder speaks alone — the
  // comparison subject against the Cesium viewer.
  const targetSse = renderOptions.effective().sseBrakes
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
const diagOriginEl = $('#diagOrigin')
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
  updateZoomPanel(performance.now())

  // Fly to the height that looks right, read it off here, put it into
  // navigation.zoomStopHeightM.
  if (!showDiagnostics) return
  diagAltitudeEl.textContent = rangeDebug ? `${Math.round(rangeDebug.altitude)} m` : '—'
  diagRangeEl.textContent = rangeDebug ? `${Math.round(rangeDebug.range)} m` : '—'
  diagStopEl.textContent = `${Math.round(navigationClearance)} m`
  diagMissingEl.textContent = String(stats?.missingTiles ?? 0)
  // How far the camera has drifted from the render origin, and how often it has
  // been pulled back. A steadily climbing rebase count while standing still
  // would mean the threshold is fighting something.
  diagOriginEl.textContent = `${Math.round(camera.position.length())} m · ${originStats().rebases}×`
}

function loop(now: number): void {
  if (graphicsFailed) return
  fps.tick(now)
  // Solo-Modus: nur die 3DGS-Ansicht rendern, alles andere ruht (spart die
  // WebGPU-Punktwolke, Wolken-Raymarch, Streaming). Eigener WebGL-Renderer.
  if (gaussianSplatLayer?.isEnabled()) { gaussianSplatLayer.update(); return }
  // First thing in the frame, so every consumer below — camera writers, both
  // tile traversals, the mask probe, the layers — sees one origin for the
  // whole frame and never a shift in the middle of it.
  updateOrigin()
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
  renderer.render(scene, camera)
}

// ---------------------------------------------------------------- boot
async function main(): Promise<void> {
  if (!baseUrl) { showLoadError('CloudFront-Domain fehlt in der Umgebung.'); return }
  if (!MAPTILER_KEY) { showLoadError('MapTiler-Schlüssel fehlt in der Umgebung.'); return }

  setLoadProgress(0.06, 'Initialisiere GPU und Kartensystem …')
  await renderer.init()
  setLoadProgress(0.16, 'Grafiksystem bereit. Verbinde Feldstation …')
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
  setLoadProgress(0.22, 'Lade Fluggebiet und Koordinaten …')
  const manifest = await fetchGlobeManifest(baseUrl, dataset)
  setLoadProgress(0.28, 'Fluggebiet lokalisiert. Baue Szene …')
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
    zOffset = groundSnap
      ? -(minZ + originHeight) + EXPERIENCE_CONFIG.navigation.pointCloudLiftM
      : 0
    areaMinZ = minZ
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
    const span = manifest.areaVerticalSpan ?? EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM
    uniforms.canopyBaseZ.value = minZ + zOffset + 8
    uniforms.canopyTopZ.value = minZ + zOffset + span
    uniforms.cloudDeckHeight.value = minZ + zOffset + EXPERIENCE_CONFIG.pointLighting.cloudDeckHeightM
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
  groundPlanePointEnu.set(cloudCenterEnu.x, cloudCenterEnu.y, cloudCenterEnu.z - 40)
  enuFrameReady = true
  // Seed the origin at the survey centre. Everything derived below — survey
  // centre, ground plane, the shader ENU matrix — is produced in render space
  // from here on; `enuFrame`/`enuInverse` stay absolute for the one conversion
  // that genuinely needs ECEF (lon/lat -> ENU for the parcel).
  originAnchorEcef
    .set(cloudCenterEnu.x, cloudCenterEnu.y, cloudCenterEnu.z + zOffset)
    .applyMatrix4(enuFrame)
  rebaseTo(originAnchorEcef)
  refreshOriginDerived()
  uniforms.maskCenter.value.set(cloudCenterEnu.x, cloudCenterEnu.y)

  globe = createGlobe({
    renderer: renderer as any,
    camera,
    scene: ecefRoot,
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
  pointSource = createPointSource({ baseUrl, manifest, basePack: pointTree, onChange: syncPackSelects })
  buildZoomPackRows(pointSource)
  // Shareable comparison links, e.g. ?zoom0=area:detail — an unknown or unbuilt
  // pack silently resolves back to Auto.
  for (const rowDef of ZOOM_BAND_ROWS) {
    const requested = params.get(`zoom${rowDef.band}`)
    if (requested) pointSource.setAssignment(rowDef.band, requested)
  }
  syncPackSelects()
  rebuildStream(pointSource.base(), 'boot')
  // Debug handle for streaming diagnosis in the console. Getters, so a handle
  // grabbed before a pack swap does not go stale.
  ;(window as any).__wild = {
    camera,
    get stream() { return stream },
    get source() { return activeSource },
    get flight() { return cameraFlight.active },
    get sse() { return sseAuto },
    get range() { return rangeDebug },
    get origin() { return originStats() },
    /** Render space -> absolute ECEF, for anything compared against geodesy. */
    toEcef(value: THREE.Vector3) { return renderToEcef(value) },
  }

  environmentLayer = createEnvironmentLayer({
    scene: ecefRoot,
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
  audioLayer = createAudioLayer({ toggle: soundToggleEl, status: audioStatusEl })
  soundToggleEl.disabled = false
  audioLayer.update(environmentLayer.getDaylightState(), rainVisualActive)
  designSystemDemo = createStoryboard()
  // ?clean=1 skips the loader, so the reveal its start button normally triggers
  // never fires. Jump the frame straight to its resting margin instead.
  if (cleanMode) void designSystemDemo.reveal(0)

  if (manifest.areaBbox) {
    markerLayer = createMarkerLayer({
      scene: ecefRoot,
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
      scene: ecefRoot,
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
        // The one place that is genuinely absolute: the ellipsoid returns true
        // ECEF, so this uses `enuInverse`, never the render-space variant.
        shapeEnu.copy(shapeEcef).applyMatrix4(enuInverse)
        out[0] = shapeEnu.x
        out[1] = shapeEnu.y
        return out
      },
      fallbackGroundZ: areaMinZ,
      canopyHeightM: manifest.areaVerticalSpan ?? EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM,
      probe: (centreEnu, radiusM) => {
        // Render-space variant: sampleGroundZ multiplies this by the tiles'
        // own matrixWorld, which lives under the floating-origin root.
        const sample = stream?.sampleGroundZ(centreEnu, radiusM, enuInverseRender)
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
  setLoadProgress(0.35, 'Lade erste Kronendach-Punktwolken …')

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
  // Staging jumps straight to the parcel; pull the origin along before the
  // first frame so the very first traversal already runs camera-relative.
  updateOrigin(true)

  setMaskMode(2)
  setStatus('Adaptive streaming · loading tiles…')
  renderer.setAnimationLoop(loop)

  const fieldOrigin = new THREE.Vector3(
    cloudCenterEnu.x + EXPERIENCE_CONFIG.markers.centreOffsetM[0],
    cloudCenterEnu.y + EXPERIENCE_CONFIG.markers.centreOffsetM[1],
    areaMinZ,
  )
  void createFieldModelLayer({
    scene: ecefRoot,
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
    renderer, scene, camera, uniforms, globe, markerLayer,
    rainLayer, environmentLayer, fieldModelLayer, donationShapeLayer, loop, renderOptions,
    // Getter: the streamer is replaced whenever a density pack is swapped.
    get stream() { return stream },
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
  designSystemDemo?.dispose()
  keyboardNavigation?.dispose()
  markerLayer?.dispose()
  donationShapeLayer?.dispose()
  modelTransformEditor?.dispose()
  fieldModelLayer?.dispose()
  environmentLayer?.dispose()
  stream?.dispose()
  globe?.dispose()
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
  showLoadError(`Laden fehlgeschlagen: ${error?.message ?? error}`)
})
