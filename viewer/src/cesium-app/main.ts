// CesiumJS full-feature variant of the immersive map app. Mirrors the section
// order of src/threejs-test/main.ts so the two orchestrators stay diffable.
// Zero imports from src/threejs-test/ or the legacy flat src/ viewer — this
// folder is independently deletable. Engineering contract: PORT_NOTES.md.
import * as Cesium from 'cesium'
import { createCesiumViewer, type CesiumViewerSetup } from './viewer-setup'
import { createEnuFrame, type EnuFrame } from './enu'
import { fetchGlobeManifest, type GlobeManifest } from './manifest'
import { AdaptiveQualityController, APH_BAND_SSE } from './adaptive-quality'
import {
  createCameraFlight,
  type CameraFlightController,
  type EnuVector3,
} from './camera-flight'
import { EXPERIENCE_CONFIG } from './config'
import { flightSseFloor } from './flight-quality'
import {
  createKeyboardNavigation,
  type KeyboardNavigation,
} from './keyboard-navigation'
import { createPointTileset, type PointTileset } from './point-tileset'
import { createEagleBench, type BenchPreset, type EagleBench } from './eagle-bench'
import { EAGLE_MIN_ASSEMBLY_SECONDS } from './eagle-bench-motion'
import { Fps } from './stats'
import {
  createEnvironmentLayer,
  type CloudState,
  type DaylightState,
  type EnvironmentLayer,
} from './environment-layer'
import { createRainLayer, type RainLayer } from './rain-layer'
import { createAudioLayer, type AudioLayer } from './audio-layer'
import {
  createFieldModelLayer,
  type FieldModelLayer,
} from './field-model-layer'
import {
  createMarkerLayer,
  type MarkerActionTarget,
  type MarkerLayer,
} from './marker-layer'
import {
  createRenderOptions,
  RENDER_OPTION_ROWS,
  type RenderOptionKey,
  type RenderOptions,
} from './render-options'
import { createGaussianSplatLayer, type GaussianSplatLayer } from './gaussian-splat-layer'

// ---------------------------------------------------------------- config
const params = new URLSearchParams(location.search)
const domain = (import.meta.env.VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN ?? '')
  .replace(/^https?:\/\//, '').replace(/\/+$/, '')
const folder = (import.meta.env.VITE_POINTCLOUD_TILES_FOLDER ?? 'pointcloud-tiles').replace(/^\/+|\/+$/g, '')
const baseUrl = domain ? `https://${domain}/${folder}` : ''
const MAPTILER_KEY = (import.meta.env.VITE_MAPTILER_API_KEY ?? '').trim()
const dataset = params.get('dataset') ?? 'peru-b2-globe'
const compareParam = params.get('compare') === '1'
const showDiagnostics = params.has('diag') || import.meta.env.DEV
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
  ? Cesium.Math.clamp(debugProgressParsed, 0, 1)
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
// Compare mode skips the probe entirely and starts uncapped at the strong tier.
if (compareParam) {
  loaderEagleFillEl.hidden = false
} else void createEagleBench(loaderEagleCanvasEl, { forceWebGL: false }).then((bench) => {
  if (!bootLoading || loaderFlightStarted) { bench.dispose(); return }
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
  const next = Cesium.Math.clamp(progress, 0, 1)
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
  setStatus(`Error: ${message}`)
}

function updateLoaderVisual(now: number): void {
  if (!bootLoading) return
  showLoaderReadyIfComplete()
  if (loaderFinishAt <= 0 || now < loaderFinishAt) return
  loaderEl.hidden = true
  bootLoading = false
  cancelAnimationFrame(loaderProgressRaf)
  loaderProgressRaf = 0
  window.clearInterval(loaderStallTimer)
  setStatus('Adaptive streaming · ready')
}

const onLoaderRetry = () => location.reload()
loaderRetryEl.addEventListener('click', onLoaderRetry)
const onLoaderSoundOpt = () => {
  startWithSound = !startWithSound
  loaderSoundOptEl.setAttribute('aria-pressed', String(startWithSound))
  loaderSoundOptLabelEl.textContent = startWithSound ? 'Mit Naturklängen' : 'Ohne Naturklänge'
}
loaderSoundOptEl.addEventListener('click', onLoaderSoundOpt)

/** Turn the loader benchmark into Cesium start settings. Point density remains
 * camera-driven; the preset spends its budget on DPR, memory and WP5's view
 * distance while adaptive pressure starts at an appropriate floor. */
function applyBenchPreset(): void {
  const measured = compareParam ? null : eagleBench?.result() ?? null
  const heuristicTier = environmentLayer?.getCloudState().tier ?? 'balanced'
  const preset: BenchPreset = compareParam
    ? 'strong'
    : measured?.preset
      ?? (heuristicTier === 'strong'
        ? 'strong'
        : heuristicTier === 'constrained' ? 'constrained' : 'medium')
  benchPreset = preset
  console.info(
    `[eagle-bench] ${measured && measured.preset
      ? `${Math.round(measured.pointsAtTarget / 1000)}k of ${Math.round(measured.maxPoints / 1000)}k pts @${EXPERIENCE_CONFIG.eagleBench.targetFps}fps (${measured.samples} samples)`
      : 'no measurement (heuristic fallback)'} → preset ${preset}`,
  )

  // Every preset write routes through the render-options flags so a toggled-off
  // optimisation (or active compare mode) is never re-applied.
  const options = renderOptions.effective()
  if (preset === 'strong') {
    if (!renderOptions.isCompareMode()) setMaskMode(0)
    presetPixelRatioCap = 1.25
    adaptiveQuality.setPressureFloor(1)
    environmentLayer?.applyMeasuredTier('strong')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.strong
    if (options.presetBudgets) pointTileset?.setMemoryBudget(384 * 1024 * 1024, 256 * 1024 * 1024)
  } else if (preset === 'medium') {
    if (!renderOptions.isCompareMode()) setMaskMode(2)
    presetPixelRatioCap = 1.1
    adaptiveQuality.setPressureFloor(1.4)
    environmentLayer?.applyMeasuredTier('balanced')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.medium
    if (options.presetBudgets) pointTileset?.setMemoryBudget(256 * 1024 * 1024, 176 * 1024 * 1024)
  } else {
    if (!renderOptions.isCompareMode()) setMaskMode(2)
    presetPixelRatioCap = 1
    adaptiveQuality.setPressureFloor(2)
    environmentLayer?.applyMeasuredTier('constrained')
    atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.constrained
    if (options.presetBudgets) pointTileset?.setMemoryBudget(160 * 1024 * 1024, 112 * 1024 * 1024)
    if (!renderOptions.isCompareMode()) {
      pointSizeScale = 1.3
      sizeEl.value = String(pointSizeScale)
      applyPointSize()
    }
  }
  applyPixelRatioOption()
}

const onLoaderStart = () => {
  if (!loaderReadyShown || loaderFinishAt > 0 || loaderFlightStarted
    || !cameraFlight || !pointTileset) return
  applyBenchPreset()
  eagleBench?.dispose()
  eagleBench = null
  if (import.meta.env.DEV) delete (window as any).__eagleBenchDebug
  delete loaderEagleCanvasEl.dataset.benchState
  if (startWithSound) void audioLayer?.setEnabled(true)
  const now = performance.now()
  loaderFinishAt = now + (reducedMotion ? 20 : 1200)
  loaderEl.classList.add('finishing')
  loaderFlightStarted = true
  entranceFlightPending = EXPERIENCE_CONFIG.flight.cloudRevealProgress[benchPreset] > 0
  if (entranceFlightPending) setPointCloudRevealed(false)
  cameraFlight.toCloud(
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

function wirePointTilesetLoader(pointCloud: PointTileset): void {
  let loadedCount = 0
  let pendingCount = 1
  let bestRatio = 0
  let initialComplete = false

  const updateProgress = () => {
    if (initialComplete || !bootLoading) return
    const ratio = loadedCount / Math.max(1, loadedCount + pendingCount)
    bestRatio = Math.max(bestRatio, Math.min(0.999, ratio))
    setLoadProgress(0.35 + bestRatio * 0.60, 'Lade erste Kronendach-Punktwolken …')
  }

  pointTilesetEventRemovers.push(
    pointCloud.tileset.tileLoad.addEventListener(() => {
      loadedCount++
      updateProgress()
    }),
    pointCloud.tileset.loadProgress.addEventListener((
      numberOfPendingRequests: number,
      numberOfTilesProcessing: number,
    ) => {
      pendingCount = Math.max(0, numberOfPendingRequests + numberOfTilesProcessing)
      updateProgress()
    }),
    pointCloud.tileset.initialTilesLoaded.addEventListener(() => {
      if (initialComplete) return
      initialComplete = true
      loaderDataReady = true
      setLoadProgress(1, 'Feldsystem bereit.')
      setStatus('Cesium scene ready · initial point tiles loaded')
    }),
  )
}

// ---------------------------------------------------------------- overlays
const compactViewport = matchMedia('(max-width: 700px)').matches
document.body.classList.toggle('hud-open', !compactViewport)
document.body.classList.toggle('panel-open', !compactViewport)
$('#hudChip').addEventListener('click', () => document.body.classList.toggle('hud-open'))
$('#panelChip').addEventListener('click', () => document.body.classList.toggle('panel-open'))
document.querySelectorAll<HTMLButtonElement>('.close').forEach((button) => {
  button.addEventListener('click', () => document.body.classList.remove(`${button.dataset.close}-open`))
})

// ---------------------------------------------------------------- runtime state
const adaptiveQuality = new AdaptiveQualityController(APH_BAND_SSE)
const fps = new Fps()
let cesium: CesiumViewerSetup | null = null
let enuFrame: EnuFrame | null = null
let manifest: GlobeManifest | null = null
let pointTileset: PointTileset | null = null
let cameraFlight: CameraFlightController | null = null
let keyboardNavigation: KeyboardNavigation | null = null
let environmentLayer: EnvironmentLayer | null = null
let rainLayer: RainLayer | null = null
let audioLayer: AudioLayer | null = null
let fieldModelLayer: FieldModelLayer | null = null
let markerLayer: MarkerLayer | null = null
let lastFieldTier: CloudState['tier'] | null = null
let disposed = false
const pointTilesetEventRemovers: Array<() => void> = []
let sseAuto: number = EXPERIENCE_CONFIG.lod.bootSse
let qualityBand = 2
let cameraCloudRange = Infinity
let cameraGroundRange = Infinity
let cameraAltitude = 0
let areaMinZ = 0
let navigationClearance: number = EXPERIENCE_CONFIG.navigation.zoomStopHeightM
let navigationFloorZ = areaMinZ + navigationClearance
let navigationBoundsRadius: number = EXPERIENCE_CONFIG.navigation.minimumBoundsRadiusM
const cloudCenterEnu = new Cesium.Cartesian3()
const markerMaskCenter = new Cesium.Cartesian2()
let markerMaskRadius = 0
let markerMaskActive = false
let lastPointStats: ReturnType<PointTileset['stats']> | null = null
let flightEndedAt = -Infinity
let wasFlying = false
let cinematicFlightProgress = 1
/** Overwritten by the loader benchmark before the entrance flight starts. */
let benchPreset: BenchPreset = compareParam ? 'strong' : 'medium'
/** The entrance flight hides the point cloud until its preset reveal point;
 * every later flight leaves it alone. */
let entranceFlightPending = false
let pointCloudRevealed = true
/** Consumed by WP5's atmosphere distance calculation. */
let atmosphereFarScale: number = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.strong
let atmosphereFar: number = EXPERIENCE_CONFIG.atmosphere.maximumFarM
let lastAtmosphereUpdate = -Infinity

function setPointCloudRevealed(revealed: boolean): void {
  pointCloudRevealed = revealed
  if (pointTileset) pointTileset.tileset.show = revealed
}

function updateCloudReveal(): void {
  if (!entranceFlightPending) return
  const revealAt = EXPERIENCE_CONFIG.flight.cloudRevealProgress[benchPreset]
  if (cinematicFlightProgress >= revealAt || !cameraFlight?.active) {
    entranceFlightPending = false
    setPointCloudRevealed(true)
  }
}

// ---------------------------------------------------------------- environment controls
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
let lastViewerClockKey = ''

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
  const modeLabel = state.mode === 'volume'
    ? 'Volumetric'
    : state.mode === 'soft' ? 'Soft volumes' : 'Off'
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
  timeDockToggleEl.setAttribute(
    'aria-label',
    `${state.live ? 'Livezeit' : 'Manuelle Zeit'}: ${accessibleTime}`,
  )
}

/** viewer.clock is a projection of the Peru-minute state, never an input back
 * into the daylight calculation. This keeps Cesium consumers on the same one
 * time source as the dock, explicit light, imagery and point grading. */
function syncViewerClock(state: DaylightState): void {
  if (!cesium) return
  const offsetMs = EXPERIENCE_CONFIG.environment.utcOffsetHours * 60 * 60 * 1000
  const peruCalendar = new Date(Date.now() + offsetMs)
  const hours = Math.floor(state.peruMinutes / 60)
  const minutes = state.peruMinutes % 60
  const clockKey = `${peruCalendar.getUTCFullYear()}-${peruCalendar.getUTCMonth()}`
    + `-${peruCalendar.getUTCDate()}-${state.peruMinutes}`
  if (clockKey === lastViewerClockKey) return
  lastViewerClockKey = clockKey
  const utcDate = new Date(Date.UTC(
    peruCalendar.getUTCFullYear(),
    peruCalendar.getUTCMonth(),
    peruCalendar.getUTCDate(),
    hours - EXPERIENCE_CONFIG.environment.utcOffsetHours,
    minutes,
  ))
  cesium.viewer.clock.shouldAnimate = false
  cesium.viewer.clock.currentTime = Cesium.JulianDate.fromDate(utcDate)
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
  if (environmentLayer) {
    const state = environmentLayer.getDaylightState()
    updateTimeControls(state)
    syncViewerClock(state)
  }
}
const onTimeNow = () => {
  environmentLayer?.setPeruMinutes(null)
  if (environmentLayer) {
    const state = environmentLayer.getDaylightState()
    updateTimeControls(state)
    syncViewerClock(state)
  }
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

// ---------------------------------------------------------------- on-demand field film + aim mode
const videoModalEl = $<HTMLDivElement>('#videoModal')
const fieldVideoEl = $<HTMLVideoElement>('#fieldVideo')
const videoStatusEl = $('#videoStatus')
const videoCloseEl = $<HTMLButtonElement>('#videoClose')
const aimReticleEl = $('#aimReticle')
const aimReticleLabelEl = $('#aimReticleLabel')
const interactionStatusEl = $('#interactionStatus')
const modalBackgroundElements = Array.from(document.body.children)
  .filter((element): element is HTMLElement => (
    element instanceof HTMLElement
      && element !== videoModalEl
      && element.tagName !== 'SCRIPT'
  ))
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
  if (bootLoading || compareParam || !markerLayer
    || cameraFlight?.active || !videoModalEl.hidden) return
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
  const nextTarget = aimMode && cesium
    ? markerLayer?.pickCenteredAction(
      cesium.camera,
      EXPERIENCE_CONFIG.accessibility.aimTolerancePx,
    ) ?? null
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
  videoReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  videoModalEl.hidden = false
  for (const element of modalBackgroundElements) element.inert = true
  videoModalEl.classList.remove('is-ready', 'is-playing')
  videoStatusEl.textContent = 'Video wird geladen …'
  if (cesium) {
    cesium.scene.screenSpaceCameraController.enableInputs = false
    // CesiumWidget's documented loop switch is the direct equivalent of
    // Three's setAnimationLoop(null): resident tiles stay alive, rendering stops.
    cesium.viewer.useDefaultRenderLoop = false
  }
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
  if (cesium) {
    cesium.scene.screenSpaceCameraController.enableInputs = !(cameraFlight?.active ?? false)
    if (resumeRenderer && wasOpen && !disposed) cesium.viewer.useDefaultRenderLoop = true
  }
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

// ---------------------------------------------------------------- point size
const sizeEl = $<HTMLInputElement>('#size')
const sizeValueEl = $('#sizev')
let pointSizeScale = Number(sizeEl.value) || 1
let lastAppliedPointSize = -1

/** Log-interpolate the measured point-size anchors and hold both ends flat. */
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
  const base = renderOptions.effective().dynamicPointSize
    ? basePointSizeForHeight(cameraAltitude)
    : EXPERIENCE_CONFIG.lod.fixedPointSizePx
  const pixels = base * EXPERIENCE_CONFIG.lod.pointSizeMultiplier * pointSizeScale
  sizeValueEl.textContent = `${pointSizeScale.toFixed(1)}× · ${pixels.toFixed(1)}px`
  if (!pointTileset || Math.abs(pixels - lastAppliedPointSize) < 0.02) return
  lastAppliedPointSize = pixels
  pointTileset.setPointSizeCss(pixels)
}

const onPointSizeInput = () => {
  pointSizeScale = Number(sizeEl.value) || 1
  applyPointSize()
}
sizeEl.addEventListener('input', onPointSizeInput)
// No eager applyPointSize() here: it reads the render-options state declared
// further down (module TDZ). The per-frame loop applies it from frame one.

// ---------------------------------------------------------------- HUD
const fpsEl = $('#fpsv')
const msEl = $('#msv')
const visibleEl = $('#visible')
const pointTilesEl = $('#blocks')
const densityEl = $('#loaded')
const lodEl = $('#displayed')
const cacheEl = $('#cache')
const chipFpsEl = $('#chipFps')
const diagAltitudeEl = $('#diagAltitude')
const diagRangeEl = $('#diagRange')

function updateHud(): void {
  const stats = lastPointStats
  const densityName = ['detail', 'explore', 'overview'][qualityBand] ?? 'overview'
  densityEl.textContent = `APH d-${densityName}`
  visibleEl.textContent = stats ? fmtInt(stats.points) : '0'
  pointTilesEl.textContent = String(stats?.visibleTiles ?? 0)
  cacheEl.textContent = fmtMiB(stats?.cacheBytes ?? 0)

  const value = fps.fps
  fpsEl.textContent = value ? value.toFixed(0) : '—'
  msEl.textContent = fps.frameMs ? fps.frameMs.toFixed(1) : '—'
  const className = value >= 58 ? 'good' : value >= 40 ? 'warn' : 'bad'
  fpsEl.className = `v ${className}`
  chipFpsEl.textContent = value ? `${value.toFixed(0)} fps` : '—'
  chipFpsEl.className = className
  lodEl.textContent = stats
    ? `SSE ${sseAuto.toFixed(0)} · mem ${stats.memoryAdjustedSse.toFixed(0)}`
    : `SSE ${sseAuto.toFixed(0)}`

  if (showDiagnostics) {
    diagAltitudeEl.textContent = Number.isFinite(cameraAltitude)
      ? `${Math.round(cameraAltitude)} m`
      : '—'
    diagRangeEl.textContent = Number.isFinite(cameraCloudRange)
      ? `${Math.round(cameraCloudRange)} m`
      : '—'
  }
}

// ---------------------------------------------------------------- camera navigation
const cameraPositionEnu = new Cesium.Cartesian3()
const cameraDirectionEnu = new Cesium.Cartesian3()
const cameraDestinationWorld = new Cesium.Cartesian3()
const cameraTargetWorld = new Cesium.Cartesian3()
const cameraDirectionWorld = new Cesium.Cartesian3()
const cameraUpWorld = new Cesium.Cartesian3()
const pickPosition = new Cesium.Cartesian2()
const pickedWorld = new Cesium.Cartesian3()

function worldDirectionToEnu(
  directionWorld: Cesium.Cartesian3,
  result = new Cesium.Cartesian3(),
): Cesium.Cartesian3 {
  if (!enuFrame) return Cesium.Cartesian3.clone(directionWorld, result)
  Cesium.Matrix4.multiplyByPointAsVector(enuFrame.inverse, directionWorld, result)
  return Cesium.Cartesian3.normalize(result, result)
}

function applyCameraPose(positionEnu: EnuVector3, targetEnu: EnuVector3): void {
  if (!cesium || !enuFrame) return
  Cesium.Cartesian3.fromElements(
    positionEnu.x,
    positionEnu.y,
    positionEnu.z,
    cameraPositionEnu,
  )
  Cesium.Cartesian3.fromElements(
    targetEnu.x,
    targetEnu.y,
    targetEnu.z,
    cameraDirectionEnu,
  )
  enuFrame.enuToWorld(cameraPositionEnu, cameraDestinationWorld)
  enuFrame.enuToWorld(cameraDirectionEnu, cameraTargetWorld)
  Cesium.Cartesian3.subtract(cameraTargetWorld, cameraDestinationWorld, cameraDirectionWorld)
  if (Cesium.Cartesian3.magnitudeSquared(cameraDirectionWorld) < Cesium.Math.EPSILON12) return
  Cesium.Cartesian3.normalize(cameraDirectionWorld, cameraDirectionWorld)
  Cesium.Cartesian3.clone(enuFrame.up, cameraUpWorld)
  cesium.camera.setView({
    destination: cameraDestinationWorld,
    orientation: { direction: cameraDirectionWorld, up: cameraUpWorld },
  })
}

/** True when keyboard zoom-in would only glide forward along the navigation
 * floor instead of bringing the camera closer to the survey. */
function isZoomInBlocked(): boolean {
  if (!cesium || !enuFrame) return false
  enuFrame.worldToEnu(cesium.camera.positionWC, cameraPositionEnu)
  if (cameraPositionEnu.z > navigationFloorZ + 2) return false
  const dx = cameraPositionEnu.x - cloudCenterEnu.x
  const dy = cameraPositionEnu.y - cloudCenterEnu.y
  if (dx * dx + dy * dy > navigationBoundsRadius * navigationBoundsRadius) return false
  worldDirectionToEnu(cesium.camera.directionWC, cameraDirectionEnu)
  return cameraDirectionEnu.z < 0.2
}

/** Final ENU guard against touch/wheel input crossing the point-cloud floor.
 * Cesium's minimumZoomDistance is ellipsoid height, so it cannot enforce this
 * survey-relative orbit radius by itself. */
function enforceNavigationBounds(): void {
  if (!cesium || !enuFrame) return
  enuFrame.worldToEnu(cesium.camera.positionWC, cameraPositionEnu)
  const dx = cameraPositionEnu.x - cloudCenterEnu.x
  const dy = cameraPositionEnu.y - cloudCenterEnu.y
  if (dx * dx + dy * dy > navigationBoundsRadius * navigationBoundsRadius) return
  if (cameraPositionEnu.z >= navigationFloorZ) return

  cameraPositionEnu.z = navigationFloorZ
  enuFrame.enuToWorld(cameraPositionEnu, cameraDestinationWorld)
  Cesium.Cartesian3.clone(cesium.camera.directionWC, cameraDirectionWorld)
  Cesium.Cartesian3.clone(cesium.camera.upWC, cameraUpWorld)
  cesium.camera.setView({
    destination: cameraDestinationWorld,
    orientation: { direction: cameraDirectionWorld, up: cameraUpWorld },
  })
}

const flyToEl = $<HTMLButtonElement>('#flyTo')
const onFlyToClick = () => {
  setAimMode(false, false)
  cameraFlight?.toCloud(
    reducedMotion
      ? EXPERIENCE_CONFIG.flight.reducedMotionManualDurationMs
      : EXPERIENCE_CONFIG.flight.manualDurationMs,
  )
}
flyToEl.addEventListener('click', onFlyToClick)

const onCanvasDblClick = (event: MouseEvent) => {
  if (bootLoading || cameraFlight?.active || aimMode || !videoModalEl.hidden
    || !cesium || !enuFrame) return
  event.preventDefault()
  pickPosition.x = event.offsetX
  pickPosition.y = event.offsetY

  let hit: Cesium.Cartesian3 | undefined
  if (cesium.scene.pickPositionSupported) {
    try {
      hit = cesium.scene.pickPosition(pickPosition, pickedWorld)
    } catch {
      // Depth picking can be unavailable for a frame while globe tiles swap.
    }
  }
  if (!hit) {
    const ray = cesium.camera.getPickRay(pickPosition)
    if (ray) hit = cesium.scene.globe.pick(ray, cesium.scene, pickedWorld)
  }
  if (!hit) return

  const targetEnu = enuFrame.worldToEnu(hit, new Cesium.Cartesian3())
  const range = Number.isFinite(cameraGroundRange)
    ? cameraGroundRange
    : Number.isFinite(cameraCloudRange)
      ? cameraCloudRange
      : EXPERIENCE_CONFIG.atmosphere.fallbackRangeM
  const endDistance = Cesium.Math.clamp(
    range * 0.38,
    EXPERIENCE_CONFIG.flight.dblClickMinRangeM,
    Math.max(range, EXPERIENCE_CONFIG.flight.dblClickMinRangeM),
  )
  cameraFlight?.toPoint(
    targetEnu,
    endDistance,
    reducedMotion ? 500 : EXPERIENCE_CONFIG.flight.dblClickDurationMs,
  )
}

// ------------------------------------------------- vignette mask
const vignetteEl = $<HTMLDivElement>('#vignette')
let maskMode = 0
let followInit = false
const followEnu = { x: 0, y: 0 }
let maskVisibleStrength = 0

function smooth01(edge0: number, edge1: number, value: number): number {
  const t = Cesium.Math.clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function setMaskMode(mode: number): void {
  maskMode = mode
  if (mode !== 2) {
    maskVisibleStrength = 0
    vignetteEl.style.opacity = '0'
    markerMaskActive = false
    pointTileset?.setMask(null, 1, 0.3)
  }
  document.body.classList.toggle('mask-vignette', mode === 2)
  document.querySelectorAll<HTMLButtonElement>('#maskSeg button').forEach((button) =>
    button.classList.toggle('on', Number(button.dataset.mask) === mode))
}

/** Screen-centre ground follow for the vignette — same maths as the three.js
 * updateMaskFollow, expressed on the ENU ground plane. */
function updateMaskFollow(): void {
  if (maskMode !== 2 || !cesium || !enuFrame || !pointTileset) return
  const cameraEnu = enuFrame.worldToEnu(cesium.camera.positionWC, cameraPositionEnu)
  worldDirectionToEnu(cesium.camera.directionWC, cameraDirectionEnu)
  const groundT = cameraDirectionEnu.z < -1e-6
    ? (areaMinZ - cameraEnu.z) / cameraDirectionEnu.z
    : -1
  if (groundT >= 0) {
    const hitX = cameraEnu.x + cameraDirectionEnu.x * groundT
    const hitY = cameraEnu.y + cameraDirectionEnu.y * groundT
    if (!followInit) { followEnu.x = hitX; followEnu.y = hitY; followInit = true }
    else {
      followEnu.x += (hitX - followEnu.x) * 0.2
      followEnu.y += (hitY - followEnu.y) * 0.2
    }
  } else if (!followInit) {
    markerMaskActive = false
    return
  }

  const radius = Cesium.Math.clamp(cameraGroundRange * 0.55, 30, 2000)
  const strength = 1 - smooth01(4, 20, cameraGroundRange / radius)
  const flightBlend = smooth01(0.68, 1, cinematicFlightProgress)
  maskVisibleStrength = strength * flightBlend
  vignetteEl.style.opacity = String(maskVisibleStrength)

  pointTileset.setMask([followEnu.x, followEnu.y], radius, 0.3)
  Cesium.Cartesian2.fromElements(followEnu.x, followEnu.y, markerMaskCenter)
  markerMaskRadius = radius + 80
  markerMaskActive = maskVisibleStrength > 0.9
}

// ------------------------------------------------- render options / compare
// Same architecture as the three.js side: requested/effective split, compare
// mode overrides without overwriting the individual choices. Cesium-specific
// mappings only where the engines differ (resolutionScale, fog density,
// native RTC precision).
let presetPixelRatioCap: number | null = 1.25
let compareBudgetSnapshot: { cacheBytes: number; overflowBytes: number } | null = null

function applyPixelRatioOption(): void {
  cesium?.setPixelRatioCap(renderOptions.effective().pixelRatioCap ? presetPixelRatioCap : null)
}

function applyRenderOptions(effective: Readonly<RenderOptions>, changed: RenderOptionKey[]): void {
  for (const key of changed) {
    switch (key) {
      case 'sseBrakes':
        if (!effective.sseBrakes) {
          entranceFlightPending = false
          setPointCloudRevealed(true)
        }
        sseAuto = -1
        break
      case 'fogAtmosphere':
        if (cesium) cesium.scene.fog.enabled = effective.fogAtmosphere
        if (effective.fogAtmosphere) updateAtmosphere(performance.now(), true)
        else if (cesium) {
          atmosphereFar = EXPERIENCE_CONFIG.atmosphere.maximumFarM
          const frustum = cesium.camera.frustum
          if (frustum instanceof Cesium.PerspectiveFrustum) frustum.far = atmosphereFar
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
      case 'dynamicPointSize':
        lastAppliedPointSize = -1
        applyPointSize()
        break
      case 'presetBudgets':
        if (!effective.presetBudgets) {
          const tileset = pointTileset?.tileset
          compareBudgetSnapshot = tileset
            ? { cacheBytes: tileset.cacheBytes, overflowBytes: tileset.maximumCacheOverflowBytes }
            : null
          pointTileset?.setMemoryBudget(768 * 1024 * 1024, 256 * 1024 * 1024)
        } else if (compareBudgetSnapshot) {
          pointTileset?.setMemoryBudget(compareBudgetSnapshot.cacheBytes, compareBudgetSnapshot.overflowBytes)
          compareBudgetSnapshot = null
        }
        break
      case 'pixelRatioCap':
        applyPixelRatioOption()
        break
      case 'flightPrecisionDrop':
        // No-op on Cesium: the relative-to-eye pipeline owns precision natively.
        break
      case 'basemapImagery':
        if (cesium?.imageryLayer) cesium.imageryLayer.show = effective.basemapImagery
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
  note.textContent = rowDef.key === 'flightPrecisionDrop'
    ? 'Not applicable on Cesium — relative-to-eye precision is native; toggle kept for panel parity'
    : rowDef.note
  row.append(label, button, note)
  compareRowsEl.appendChild(row)
  optionButtons.set(rowDef.key, button)
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

/** Pre-compare state of the toggles outside render-options. Cloud intent is
 * restored without touching the stored localStorage preference. */
let compareLegacySnapshot: {
  maskMode: number
  cloudIntent: boolean
  rainCycle: boolean
  audioOn: boolean
} | null = null

function setCompareMode(on: boolean): void {
  if (on === renderOptions.isCompareMode()) return
  if (on) {
    compareLegacySnapshot = {
      maskMode,
      cloudIntent: environmentLayer?.getCloudState().intent ?? false,
      rainCycle: rainCycleEnabled,
      audioOn: soundToggleEl.classList.contains('is-on'),
    }
    setMaskMode(0)
    environmentLayer?.setCloudIntent(false, false)
    rainCycleEnabled = false
    rainRequested = false
    rainVisualActive = false
    rainLayer?.setEnabled(false)
    updateRainToggle()
    void audioLayer?.setEnabled(false)
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
  }
  document.body.classList.toggle('compare-mode', on)
  $('#panel').classList.toggle('compare-mode', on)
  compareToggleEl.classList.toggle('on', on)
  compareToggleEl.setAttribute('aria-pressed', String(on))
  compareToggleEl.textContent = `⚖ Compare mode · ${on ? 'On' : 'Off'}`
}

// 3DGS: native Cesium splat tileset (tools/ply-to-splat-tileset.mjs output),
// rendered in the SAME scene as the point cloud — no separate renderer like
// the three.js Spark overlay. Dev asset served from public/splats/ (gitignored).
const gaussianToggleEl = $<HTMLButtonElement>('#gaussianToggle')
const gaussianNoteEl = $('#gaussianNote')
let gaussianSplatLayer: GaussianSplatLayer | null = null

const onGaussianToggle = () => {
  if (!cesium || !enuFrame) return
  if (!gaussianSplatLayer) {
    gaussianSplatLayer = createGaussianSplatLayer({
      url: `${import.meta.env.BASE_URL}splats/point_cloud_5/tileset.json`,
      camerasUrl: baseUrl ? `${baseUrl}/ply-result/cameras.json` : undefined,
      scene: cesium.scene,
      camera: cesium.camera,
      enuFrame,
      originEnu: { x: cloudCenterEnu.x, y: cloudCenterEnu.y, z: areaMinZ + 300 },
      onStateChange: (splatState) => { gaussianNoteEl.textContent = splatState.message },
    })
  }
  const next = !gaussianSplatLayer.isEnabled()
  gaussianSplatLayer.setEnabled(next)
  gaussianToggleEl.classList.toggle('on', next)
  gaussianToggleEl.setAttribute('aria-pressed', String(next))
  gaussianToggleEl.textContent = `✦ 3DGS · ${next ? 'On' : 'Off'}`
}
gaussianToggleEl.addEventListener('click', onGaussianToggle)

const onCompareToggle = () => setCompareMode(!renderOptions.isCompareMode())
const onCompareReload = () => {
  const url = new URL(location.href)
  if (compareParam) url.searchParams.delete('compare')
  else url.searchParams.set('compare', '1')
  location.href = url.toString()
}
compareReloadEl.textContent = compareParam ? '⟳ Restart · Normal' : '⟳ Restart in compare mode'
compareToggleEl.addEventListener('click', onCompareToggle)
compareReloadEl.addEventListener('click', onCompareReload)
document.querySelectorAll<HTMLButtonElement>('#maskSeg button').forEach((button) => {
  button.addEventListener('click', () => setMaskMode(Number(button.dataset.mask)))
})

// ---------------------------------------------------------------- per-frame update
function updateCameraRange(): void {
  if (!cesium || !enuFrame) return
  const cameraEnu = enuFrame.worldToEnu(cesium.camera.positionWC, cameraPositionEnu)
  worldDirectionToEnu(cesium.camera.directionWC, cameraDirectionEnu)
  const groundT = cameraDirectionEnu.z < -1e-6
    ? (areaMinZ - cameraEnu.z) / cameraDirectionEnu.z
    : -1
  cameraGroundRange = groundT >= 0
    ? groundT
    : Cesium.Cartesian3.distance(cameraEnu, cloudCenterEnu)

  const altitude = Math.max(0, cameraEnu.z - areaMinZ)
  const dx = cameraEnu.x - cloudCenterEnu.x
  const dy = cameraEnu.y - cloudCenterEnu.y
  // Refinement distance mirrors the three.js app: height over the cloud floor
  // plus only the part of the horizontal distance OUTSIDE the survey footprint —
  // inside the bounds a corner view must still reach the detail band.
  const outside = Math.max(0, Math.hypot(dx, dy) - navigationBoundsRadius)
  cameraAltitude = altitude
  cameraCloudRange = Math.hypot(altitude, outside)
}

/**
 * Blend the finite globe into the sky and keep the perspective frustum
 * proportional to the current viewing range.
 *
 * Cesium has no Fog near/far pair. With height scaling pinned out, its base
 * exponential-squared density is approximately inverse distance, so
 * density = 1 / (fogFarFactor × atmosphereFar) puts the useful visibility
 * distance at the same far-fog control point as the Three.js viewer. Cesium
 * still tapers fog for downward views; that engine behavior is intentional.
 */
function updateAtmosphere(now: number, snap = false): void {
  if (!cesium) return
  // Toggled off: fog is disabled and the far plane pinned by the options
  // applicator — nothing to follow here.
  if (!renderOptions.effective().fogAtmosphere) return
  if (!snap
    && now - lastAtmosphereUpdate < EXPERIENCE_CONFIG.atmosphere.updateIntervalMs) return
  lastAtmosphereUpdate = now

  const range = Number.isFinite(cameraGroundRange)
    ? cameraGroundRange
    : EXPERIENCE_CONFIG.atmosphere.fallbackRangeM
  const targetFar = Cesium.Math.clamp(
    range * EXPERIENCE_CONFIG.atmosphere.farRangeMultiplier * atmosphereFarScale,
    EXPERIENCE_CONFIG.atmosphere.minimumFarM,
    EXPERIENCE_CONFIG.atmosphere.maximumFarM * atmosphereFarScale,
  )
  atmosphereFar = snap
    ? targetFar
    : Cesium.Math.lerp(
        atmosphereFar,
        targetFar,
        EXPERIENCE_CONFIG.atmosphere.distanceSmoothing,
      )

  // The full-feature viewer remains in 3D perspective mode. Keep the concrete
  // Cesium PerspectiveFrustum assignment visible: unlike Three, Cesium updates
  // its projection lazily when this property changes.
  const frustum = cesium.camera.frustum
  if (frustum instanceof Cesium.PerspectiveFrustum) {
    frustum.far = atmosphereFar
  }

  const fogVisibilityM = Math.max(
    1,
    atmosphereFar * EXPERIENCE_CONFIG.atmosphere.fogFarFactor,
  )
  const fog = cesium.scene.fog
  fog.enabled = true
  fog.renderable = true
  fog.density = 1 / fogVisibilityM
  // Remove Cesium's default ellipsoid-height multiplier so the inverse-distance
  // mapping above remains stable through the overview flight and close survey.
  fog.heightScalar = 1
  fog.heightFalloff = 0
  fog.maxHeight = EXPERIENCE_CONFIG.atmosphere.maximumFarM
  fog.visualDensityScalar = 0.15
  fog.screenSpaceErrorFactor = 2
  fog.minimumBrightness = 0.03
}

function onPreUpdate(): void {
  const now = performance.now()
  fps.tick(now)
  cameraFlight?.update(now)
  updateCloudReveal()
  updateLoaderVisual(now)
  keyboardNavigation?.update(
    now,
    cameraGroundRange,
    !bootLoading && !cameraFlight?.active && videoModalEl.hidden,
    isZoomInBlocked(),
    navigationClearance,
  )
  enforceNavigationBounds()
  updateCameraRange()
  updateAtmosphere(now)
  const daylightState = environmentLayer?.update(
    now,
    cameraCloudRange,
    fps.fps,
    !bootLoading && !cameraFlight?.active,
  )
  if (daylightState) {
    updateTimeControls(daylightState)
    syncViewerClock(daylightState)
    fieldModelLayer?.setDaylightPhase(daylightState.phase)
  }
  const nextFieldTier = environmentLayer?.getCloudState().tier ?? null
  if (nextFieldTier && nextFieldTier !== lastFieldTier) {
    lastFieldTier = nextFieldTier
    fieldModelLayer?.setPerformanceTier(nextFieldTier)
  }
  const options = renderOptions.effective()
  updateMaskFollow()
  if (options.fieldModels) fieldModelLayer?.update(now)
  if (options.markers && markerLayer && cesium) {
    markerLayer.update(
      now,
      cesium.camera,
      cameraGroundRange,
      markerMaskCenter,
      markerMaskRadius,
      markerMaskActive,
    )
    updateAimTarget()
  }
  updateRainCycle(now)
  const nextRainActive = rainLayer?.update(now, cameraGroundRange) ?? false
  if (nextRainActive !== rainVisualActive) {
    rainVisualActive = nextRainActive
    updateRainToggle()
  }
  if (daylightState) audioLayer?.update(daylightState, nextRainActive)
  const flying = cameraFlight?.active ?? false
  if (wasFlying && !flying) flightEndedAt = now
  wasFlying = flying
  lastPointStats = pointTileset?.stats() ?? null
  const quality = adaptiveQuality.update({
    now,
    fps: fps.fps,
    visiblePoints: lastPointStats?.points ?? 0,
    cameraGroundRange: cameraCloudRange,
  })
  qualityBand = quality.band
  // With the brakes toggled off the density ladder speaks alone — the
  // comparison subject against the three.js viewer.
  const target = !options.sseBrakes
    ? quality.sse
    : bootLoading
      ? Math.max(quality.sse, EXPERIENCE_CONFIG.lod.bootSse)
      : Math.max(
        quality.sse,
        flightSseFloor({
          flying,
          msSinceLanding: now - flightEndedAt,
          targetSse: quality.sse,
        }),
      )
  if (Math.abs(target - sseAuto) > 0.25) {
    sseAuto = target
    pointTileset?.setErrorTarget(sseAuto)
  }
  if (pointTileset && cesium) pointTileset.updateFrame(cesium.camera)
  applyPointSize()
  updateHud()
}

// ---------------------------------------------------------------- boot
async function main(): Promise<void> {
  if (!baseUrl) { showLoadError('CloudFront-Domain fehlt in der Umgebung.'); return }
  if (!MAPTILER_KEY) { showLoadError('MapTiler-Schlüssel fehlt in der Umgebung.'); return }

  setLoadProgress(0.06, 'Initialisiere Cesium und Kartensystem …')
  cesium = createCesiumViewer({ container: $('#view'), maptilerKey: MAPTILER_KEY })
  if (compareParam) cesium.setPixelRatioCap(null)
  cesium.viewer.canvas.addEventListener('dblclick', onCanvasDblClick)
  const badge = $('#backend')
  badge.textContent = 'Cesium WebGL2'
  badge.classList.add('webgl')

  setLoadProgress(0.22, 'Lade Fluggebiet und Koordinaten …')
  manifest = await fetchGlobeManifest(baseUrl, dataset)
  enuFrame = createEnuFrame(manifest.rootTransform)
  setLoadProgress(0.35, 'Fluggebiet lokalisiert. Baue Szene …')

  if (manifest.areaBbox) areaMinZ = manifest.areaBbox[2]
  const configuredStop = EXPERIENCE_CONFIG.navigation.zoomStopHeightM
  const canopyHeight = manifest.areaVerticalSpan
    ?? EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM
  navigationClearance = Math.max(configuredStop, canopyHeight)
  if (navigationClearance > configuredStop) {
    console.info(
      `[navigation] zoom stop raised from ${Math.round(configuredStop)} m to `
      + `${Math.round(navigationClearance)} m — the canopy is that tall here.`,
    )
  }
  navigationFloorZ = areaMinZ + navigationClearance

  const cameraControls = cesium.scene.screenSpaceCameraController
  // Cesium interprets this as height above the ellipsoid. The ENU clamp below
  // separately enforces the same clearance above the surveyed canopy floor.
  cameraControls.minimumZoomDistance = navigationClearance
  cameraControls.maximumTiltAngle = Cesium.Math.toRadians(
    EXPERIENCE_CONFIG.navigation.maximumOrbitDegrees,
  )
  // Explicitly pin Cesium's intended damping so version defaults cannot alter
  // the camera comparison.
  cameraControls.inertiaSpin = 0.9
  cameraControls.inertiaTranslate = 0.9
  cameraControls.inertiaZoom = 0.8

  const surveyBbox = manifest.surveyBbox ?? manifest.areaBbox
  if (surveyBbox) {
    const [minX, minY, , maxX, maxY] = surveyBbox
    Cesium.Cartesian3.fromElements((minX + maxX) / 2, (minY + maxY) / 2, areaMinZ + 40, cloudCenterEnu)
    navigationBoundsRadius = Math.max(
      EXPERIENCE_CONFIG.navigation.minimumBoundsRadiusM,
      Math.hypot(maxX - minX, maxY - minY) * EXPERIENCE_CONFIG.navigation.surveyBoundsScale,
    )
  }
  Cesium.Cartesian2.fromElements(cloudCenterEnu.x, cloudCenterEnu.y, markerMaskCenter)
  markerMaskRadius = navigationBoundsRadius
  // WP9 accepts the mask state without inventing WP10's follow controller.
  markerMaskActive = false

  // Stage the camera at the flight destination (same offsets as three).
  const destination = enuFrame.enuToWorld(new Cesium.Cartesian3(
    cloudCenterEnu.x + EXPERIENCE_CONFIG.flight.destinationOffsetM[0],
    cloudCenterEnu.y + EXPERIENCE_CONFIG.flight.destinationOffsetM[1],
    cloudCenterEnu.z + EXPERIENCE_CONFIG.flight.destinationOffsetM[2],
  ))
  const target = enuFrame.enuToWorld(cloudCenterEnu)
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, destination, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  cesium.camera.setView({ destination, orientation: { direction, up: enuFrame.up } })

  cameraFlight = createCameraFlight({
    positionEnu: () => enuFrame!.worldToEnu(cesium!.camera.positionWC, cameraPositionEnu),
    directionEnu: () => worldDirectionToEnu(cesium!.camera.directionWC, cameraDirectionEnu),
    cloudCentre: () => cloudCenterEnu,
    navigationFloorZ: () => navigationFloorZ,
    applyPose: applyCameraPose,
    setInputsEnabled: (enabled) => {
      if (cesium) cesium.scene.screenSpaceCameraController.enableInputs = enabled
    },
    onProgress: (progress) => {
      cinematicFlightProgress = progress
      updateCloudReveal()
    },
  })
  keyboardNavigation = createKeyboardNavigation({
    camera: cesium.camera,
    controls: cameraControls,
    enuFrame,
    guide: $('#keyboardGuide'),
    guideToggle: $<HTMLButtonElement>('#keyboardGuideToggle'),
    guideClose: $<HTMLButtonElement>('#keyboardGuideClose'),
    aimToggle: $<HTMLButtonElement>('#aimModeButton'),
    onToggleAim: toggleAimMode,
    onActivateAim: activateAimTarget,
    onDismissAim: dismissAimMode,
  })

  if (manifest.areaBbox) {
    markerLayer = createMarkerLayer({
      scene: cesium.scene,
      overlay: $('#markerOverlay'),
      enuFrame,
      areaBbox: manifest.areaBbox as [number, number, number, number, number, number],
      centre: [
        cloudCenterEnu.x + EXPERIENCE_CONFIG.markers.centreOffsetM[0],
        cloudCenterEnu.y + EXPERIENCE_CONFIG.markers.centreOffsetM[1],
      ],
      dataset,
      reducedMotion,
      onOpenVideo: openFieldVideo,
      onFlyToMarker: (targetEnu) => {
        setAimMode(false, false)
        cameraFlight?.toPoint(
          targetEnu,
          EXPERIENCE_CONFIG.flight.markerApproachDistanceM,
          reducedMotion ? 500 : EXPERIENCE_CONFIG.flight.markerFlightDurationMs,
        )
      },
    })
    markerLayer.setVisible(!compareParam)
  }

  setStatus('Cesium scene ready · streaming adaptive point tiles')
  pointTileset = await createPointTileset({
    url: `${baseUrl}/${manifest.adaptiveHierarchyDataset}/${manifest.adaptiveHierarchyTilesetFile}`,
    enuFrame,
    scene: cesium.scene,
  })
  cesium.scene.primitives.add(pointTileset.tileset)
  pointTileset.setMemoryBudget(768 * 1024 * 1024, 256 * 1024 * 1024)
  pointTileset.setErrorTarget(sseAuto)
  pointTileset.updateFrame(cesium.camera)
  lastAppliedPointSize = -1
  applyPointSize()
  wirePointTilesetLoader(pointTileset)

  environmentLayer = createEnvironmentLayer({
    scene: cesium.scene,
    imageryLayer: cesium.imageryLayer,
    pointTileset,
    enuFrame,
    surveyCentreEnu: cloudCenterEnu,
    surveyRadiusM: navigationBoundsRadius,
    areaMinZ,
    originLonLat: manifest.enuOriginLonLat,
    reducedMotion,
    isStrongContext: Boolean((cesium.scene as any).context?.webgl2),
    onCloudStateChange: updateCloudControls,
  })
  if (compareParam) {
    environmentLayer.setCloudIntent(false, false)
    environmentLayer.setGradingEnabled(false)
  }
  updateCloudControls(environmentLayer.getCloudState())
  const initialDaylightState = environmentLayer.getDaylightState()
  updateTimeControls(initialDaylightState)
  syncViewerClock(initialDaylightState)

  const fieldOrigin = new Cesium.Cartesian3(
    cloudCenterEnu.x + EXPERIENCE_CONFIG.markers.centreOffsetM[0],
    cloudCenterEnu.y + EXPERIENCE_CONFIG.markers.centreOffsetM[1],
    areaMinZ,
  )
  lastFieldTier = environmentLayer.getCloudState().tier
  void createFieldModelLayer({
    scene: cesium.scene,
    enuFrame,
    originEnu: fieldOrigin,
    performanceTier: lastFieldTier,
    reducedMotion,
    onStatus: (message) => console.info(`[field-models] ${message}`),
  }).then((layer) => {
    if (disposed) {
      layer.dispose()
      return
    }
    fieldModelLayer = layer
    layer.setVisible(!compareParam)
    if (lastFieldTier) layer.setPerformanceTier(lastFieldTier)
    layer.setDaylightPhase(environmentLayer?.getDaylightState().phase ?? 'day')
  }).catch((error) => {
    console.warn('[field-models] optional layer failed', error)
  })

  rainLayer = createRainLayer({ scene: cesium.scene, enuFrame })
  rainLayer.setEnabled(rainRequested)
  audioLayer = createAudioLayer({
    toggle: soundToggleEl,
    status: audioStatusEl,
  })
  soundToggleEl.disabled = false
  audioLayer.update(initialDaylightState, rainVisualActive)
  updateCameraRange()
  updateAtmosphere(performance.now(), true)

  cesium.scene.preUpdate.addEventListener(onPreUpdate)

  // Entrance default matches three: vignette on until the bench preset (or the
  // compare boot below) decides otherwise.
  setMaskMode(compareParam ? 0 : 2)
  // ?compare=1: all layers exist — switch the optimisations off in one atomic
  // pass, same code path as the panel master toggle.
  if (compareParam) setCompareMode(true)

  ;(window as any).__cesium = {
    viewer: cesium.viewer,
    scene: cesium.scene,
    camera: cesium.camera,
    enuFrame,
    manifest,
    adaptiveQuality,
    pointTileset,
    cameraFlight,
    keyboardNavigation,
    environmentLayer,
    markerLayer,
    get fieldModelLayer() { return fieldModelLayer },
    rainLayer,
    audioLayer,
    renderOptions,
    setCompareMode,
    get benchPreset() { return benchPreset },
    get eagleBench() { return eagleBench },
    get sse() { return sseAuto },
    get range() { return cameraCloudRange },
  }
  if (showDiagnostics) $('#diagStats').hidden = false
}

function dispose(): void {
  disposed = true
  bootLoading = false
  setAimMode(false, false)
  closeFieldVideo(false)
  loaderStartEl.removeEventListener('click', onLoaderStart)
  loaderRetryEl.removeEventListener('click', onLoaderRetry)
  loaderSoundOptEl.removeEventListener('click', onLoaderSoundOpt)
  window.clearInterval(loaderStallTimer)
  if (loaderProgressRaf) cancelAnimationFrame(loaderProgressRaf)
  loaderProgressRaf = 0
  eagleBench?.dispose()
  eagleBench = null
  if (import.meta.env.DEV) delete (window as any).__eagleBenchDebug
  sizeEl.removeEventListener('input', onPointSizeInput)
  flyToEl.removeEventListener('click', onFlyToClick)
  cloudToggleEl.removeEventListener('click', onCloudToggle)
  timeDockToggleEl.removeEventListener('click', onTimeDockToggle)
  timeSliderEl.removeEventListener('input', onTimeInput)
  timeNowEl.removeEventListener('click', onTimeNow)
  rainToggleEl.removeEventListener('click', onRainToggle)
  compareToggleEl.removeEventListener('click', onCompareToggle)
  compareReloadEl.removeEventListener('click', onCompareReload)
  gaussianToggleEl.removeEventListener('click', onGaussianToggle)
  gaussianSplatLayer?.dispose()
  cesium?.viewer.canvas.removeEventListener('dblclick', onCanvasDblClick)
  cesium?.scene.preUpdate.removeEventListener(onPreUpdate)
  cameraFlight?.cancel()
  cameraFlight = null
  keyboardNavigation?.dispose()
  keyboardNavigation = null
  markerLayer?.dispose()
  markerLayer = null
  rainLayer?.dispose()
  rainLayer = null
  audioLayer?.dispose()
  audioLayer = null
  fieldModelLayer?.dispose()
  fieldModelLayer = null
  for (const removeEventListener of pointTilesetEventRemovers.splice(0)) {
    removeEventListener()
  }
  environmentLayer?.dispose()
  environmentLayer = null
  pointTileset?.dispose()
  pointTileset = null
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
  cesium?.dispose()
}

const onPageHide = (event: PageTransitionEvent) => {
  closeFieldVideo(false)
  if (!event.persisted) dispose()
}
const onPageShow = (event: PageTransitionEvent) => {
  if (event.persisted && !disposed && cesium) cesium.viewer.useDefaultRenderLoop = true
}

window.addEventListener('pagehide', onPageHide)
window.addEventListener('pageshow', onPageShow)

main().catch((error: any) => {
  console.error('[cesium-app] fatal', error)
  showLoadError(`Laden fehlgeschlagen: ${error?.message ?? error}`)
})
