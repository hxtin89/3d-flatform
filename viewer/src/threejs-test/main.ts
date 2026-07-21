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
import { createRainLayer, type RainLayer } from './rain-layer'
import { Fps } from './stats'
import { EXPERIENCE_CONFIG } from './config'
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

// ---------------------------------------------------------------- config
const params = new URLSearchParams(location.search)
const domain = (import.meta.env.VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN ?? '')
  .replace(/^https?:\/\//, '').replace(/\/+$/, '')
const folder = (import.meta.env.VITE_POINTCLOUD_TILES_FOLDER ?? 'pointcloud-tiles').replace(/^\/+|\/+$/g, '')
const baseUrl = domain ? `https://${domain}/${folder}` : ''
const MAPTILER_KEY = (import.meta.env.VITE_MAPTILER_API_KEY ?? '').trim()
const dataset = params.get('dataset') ?? 'peru-b2-globe'
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
/** Shows the measured heights in the HUD. Implied by freeorbit, but available
 * on its own so the configured zoom stop can be checked while it still bites. */
const showDiagnostics = freeOrbit || params.has('diag') || import.meta.env.DEV
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
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
void createEagleBench(loaderEagleCanvasEl, { forceWebGL }).then((bench) => {
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
  console.info(
    `[eagle-bench] ${measured && measured.preset
      ? `${Math.round(measured.pointsAtTarget / 1000)}k of ${Math.round(measured.maxPoints / 1000)}k pts @${EXPERIENCE_CONFIG.eagleBench.targetFps}fps (${measured.samples} samples)`
      : 'no measurement (heuristic fallback)'} → preset ${preset}`,
  )
  if (preset === 'strong') {
    setMaskMode(0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25))
    adaptiveQuality.setPressureFloor(1)
    environmentLayer?.applyMeasuredTier('strong')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.strong
    // A settled Detail p100 view measures ~220 MB. Budgets below that evict
    // tiles the very next frame needs, producing continuous refetching.
    stream?.setMemoryBudget(384 * 1024 * 1024, 256 * 1024 * 1024)
    globe?.setMemoryBudget(128 * 1024 * 1024, 96 * 1024 * 1024)
  } else if (preset === 'medium') {
    setMaskMode(2)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.1))
    adaptiveQuality.setPressureFloor(1.4)
    environmentLayer?.applyMeasuredTier('balanced')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.medium
    stream?.setMemoryBudget(256 * 1024 * 1024, 176 * 1024 * 1024)
    globe?.setMemoryBudget(64 * 1024 * 1024, 48 * 1024 * 1024)
  } else {
    setMaskMode(2)
    renderer.setPixelRatio(1)
    adaptiveQuality.setPressureFloor(2)
    environmentLayer?.applyMeasuredTier('constrained')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.constrained
    // Previously left at the library default of 96 MB, which thrashes for the
    // same reason, with less headroom to recover.
    stream?.setMemoryBudget(160 * 1024 * 1024, 112 * 1024 * 1024)
    globe?.setMemoryBudget(48 * 1024 * 1024, 32 * 1024 * 1024)
    // Larger points keep the canopy readable at a lower pixel ratio.
    pointSizeScale = 1.3
    sizeEl.value = String(pointSizeScale)
    applyPointSize()
  }
  renderer.setSize(window.innerWidth, window.innerHeight)
  globe?.setResolution()
  stream?.tiles.setResolutionFromRenderer(camera, renderer as any)
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
$('#panelChip').addEventListener('click', () => document.body.classList.toggle('panel-open'))
document.querySelectorAll<HTMLButtonElement>('.close').forEach((button) => {
  button.addEventListener('click', () => document.body.classList.remove(`${button.dataset.close}-open`))
})

// ---------------------------------------------------------------- renderer / scene
const canvas = $<HTMLCanvasElement>('#view')
const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL } as any)
// A device-independent cap avoids allocating a native 3x iPhone backbuffer while
// preserving supersampling on ordinary displays. It is never resized per frame.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25))
renderer.setSize(window.innerWidth, window.innerHeight)
// Daylight sky above the globe horizon. The matching distance fog hides the
// finite map edge without another mesh, texture sample or post-process pass.
const DAYLIGHT_SKY = 0x8bc9ec
renderer.setClearColor(DAYLIGHT_SKY, 1)

const scene = new THREE.Scene()
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
  const base = basePointSizeForHeight(cameraAltitude)
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
cloudToggleEl.disabled = true
soundToggleEl.disabled = true
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
const ray = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const hitEcef = new THREE.Vector3()
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

function smooth01(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function updateMaskFollow(): void {
  const mode = uniforms.maskMode.value
  ndc.set(0, 0)
  ray.setFromCamera(ndc, camera)

  let missedGround = false
  if (ray.ray.intersectPlane(groundPlane, hitEcef)) {
    cameraGroundRange = camera.position.distanceTo(hitEcef)
    hitEnu.copy(hitEcef).applyMatrix4(enuInverse)
    hit2d.set(hitEnu.x, hitEnu.y)
    if (!followInit) { followEnu.copy(hit2d); followInit = true }
    else followEnu.lerp(hit2d, 0.2)
    uniforms.maskCenter.value.copy(followEnu)
  } else {
    cameraGroundRange = camera.position.distanceTo(cloudCenterEcef)
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
function updateAtmosphere(now: number): void {
  if (now - lastAtmosphereUpdate < EXPERIENCE_CONFIG.atmosphere.updateIntervalMs) return
  lastAtmosphereUpdate = now

  const range = Number.isFinite(cameraGroundRange)
    ? cameraGroundRange
    : EXPERIENCE_CONFIG.atmosphere.fallbackRangeM
  const targetFar = THREE.MathUtils.clamp(
    range * EXPERIENCE_CONFIG.atmosphere.farRangeMultiplier * atmosphereFarScale,
    EXPERIENCE_CONFIG.atmosphere.minimumFarM,
    EXPERIENCE_CONFIG.atmosphere.maximumFarM * atmosphereFarScale,
  )
  atmosphereFar = THREE.MathUtils.lerp(
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
  navigationFloorZ: () => navigationFloorZ,
  setControlsEnabled: (enabled) => { if (globe) globe.controls.enabled = enabled },
  onProgress: (progress) => { cinematicFlightProgress = progress },
})

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
})

// ---------------------------------------------------------------- streaming / HUD / loop
function updateStreaming(now: number): StreamingStats | null {
  if (!stream) return null

  const quality = adaptiveQuality.update({
    now,
    fps: fps.fps,
    visiblePoints: lastStreamStats?.points ?? 0,
    cameraGroundRange: cameraCloudRange,
  })
  const targetSse = bootLoading
    ? Math.max(quality.sse, EXPERIENCE_CONFIG.lod.bootSse)
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

  // Fly to the height that looks right, read it off here, put it into
  // navigation.zoomStopHeightM.
  if (!showDiagnostics) return
  diagAltitudeEl.textContent = rangeDebug ? `${Math.round(rangeDebug.altitude)} m` : '—'
  diagRangeEl.textContent = rangeDebug ? `${Math.round(rangeDebug.range)} m` : '—'
  diagStopEl.textContent = `${Math.round(navigationClearance)} m`
  diagMissingEl.textContent = String(stats?.missingTiles ?? 0)
}

function loop(now: number): void {
  if (graphicsFailed) return
  fps.tick(now)
  cameraFlight.update(now)
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
  fieldModelLayer?.update(now)
  markerLayer?.update(
    now,
    camera,
    cameraGroundRange,
    uniforms.maskCenter.value,
    uniforms.maskRadius.value,
    uniforms.maskMode.value === 2 && uniforms.vignetteStrength.value > 0.01,
  )
  updateAimTarget()
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
  stream = createStreamingCloud({
    tilesetUrl: pointTree === 'aph'
      ? `${baseUrl}/${manifest.adaptiveHierarchyDataset}/${manifest.adaptiveHierarchyTilesetFile}`
      : `${baseUrl}/${manifest.oneLodTreeDataset}/${manifest.oneLodTreeTilesetFile}`,
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
  })
  stream.group.position.copy(enuUp).multiplyScalar(zOffset)
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
  rainLayer = createRainLayer(scene)
  rainLayer.setEnabled(rainRequested)
  setLoadProgress(0.35, 'Lade erste Kronendach-Punktwolken …')

  // Bootstrap close enough to request real point tiles. The fullscreen loader
  // conceals this staging position; once both data layers are visible we jump
  // to the overview and begin the user-facing flight.
  camera.position.copy(enuToWorld(cloudOffsetEnu(EXPERIENCE_CONFIG.flight.destinationOffsetM)))
  camera.up.copy(enuUp)
  camera.lookAt(cloudCenterEcef)

  setMaskMode(2)
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

  ;(window as any).__three = {
    renderer, scene, camera, uniforms, globe, stream, markerLayer,
    rainLayer, environmentLayer, fieldModelLayer, loop,
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
