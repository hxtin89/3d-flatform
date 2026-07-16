// Three.js globe + point cloud with one adaptive streaming path on every device.
// The One LOD Tree moves from Overview p02 to Explore p10 and Detail p100 while
// one renderer owns traversal, downloads, CPU cache and GPU residency.
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { createUniforms } from './point-cloud'
import { createGlobe, type Globe } from './globe'
import { createStreamingCloud, type StreamingCloud, type StreamingStats } from './streaming'
import { fetchGlobeManifest } from './manifest'
import { AdaptiveQualityController } from './adaptive-quality'
import { createMarkerLayer, type MarkerLayer } from './marker-layer'
import { createRainLayer, type RainLayer } from './rain-layer'
import { Fps } from './stats'

// ---------------------------------------------------------------- config
const params = new URLSearchParams(location.search)
const domain = (import.meta.env.VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN ?? '')
  .replace(/^https?:\/\//, '').replace(/\/+$/, '')
const folder = (import.meta.env.VITE_POINTCLOUD_TILES_FOLDER ?? 'pointcloud-tiles').replace(/^\/+|\/+$/g, '')
const baseUrl = domain ? `https://${domain}/${folder}` : ''
const MAPTILER_KEY = (import.meta.env.VITE_MAPTILER_API_KEY ?? '').trim()
const dataset = params.get('dataset') ?? 'peru-b2-globe'
const forceWebGL = params.has('webgl')
const groundSnap = !params.has('nosnap')
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
let bootLoading = true
let loaderTarget = 0
let loaderDisplayed = 0
let loaderLastTick = performance.now()
let loaderLastAdvance = loaderLastTick
let loaderFinishAt = 0
let loaderStalled = false
let loaderFailed = false

function paintLoaderProgress(progress: number): void {
  const percentage = Math.min(100, Math.floor(progress * 100))
  loaderEl.style.setProperty('--loader-progress', `${(progress * 100).toFixed(2)}%`)
  loaderEl.setAttribute('aria-valuenow', String(percentage))
  loaderPercentEl.textContent = String(percentage).padStart(2, '0')
}

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
  // Before the render loop starts, paint the manifest and scene milestones
  // immediately. Streaming progress remains smoothly interpolated per frame.
  if (!stream && next > loaderDisplayed) {
    loaderDisplayed = next
    paintLoaderProgress(loaderDisplayed)
  }
  if (status) loaderStatusEl.textContent = status
}

function showLoadError(message: string): void {
  loaderFailed = true
  loaderStatusEl.textContent = message
  loaderRetryEl.hidden = false
  loaderEl.setAttribute('aria-busy', 'false')
}

function updateLoaderVisual(now: number, stats: StreamingStats | null, visibleMapTiles: number): void {
  if (!bootLoading) return

  if (stats) setLoadProgress(0.35 + 0.6 * stats.progress, 'Lade erste Kronendach-Punktwolken …')
  const ready = Boolean(stats && stats.visible > 0 && stats.points > 0 && stats.progress >= 0.999 && visibleMapTiles > 0)
  if (ready) setLoadProgress(1, 'Feldsystem bereit. Flug wird freigegeben.')

  const elapsed = Math.min(64, Math.max(0, now - loaderLastTick))
  loaderLastTick = now
  const smoothing = 1 - Math.exp(-elapsed / 180)
  loaderDisplayed += (loaderTarget - loaderDisplayed) * smoothing
  if (loaderTarget - loaderDisplayed < 0.0015) loaderDisplayed = loaderTarget

  paintLoaderProgress(loaderDisplayed)

  if (ready && loaderDisplayed >= 0.999 && loaderFinishAt === 0) {
    loaderFinishAt = now + (reducedMotion ? 20 : 650)
    loaderEl.classList.add('finishing')
    loaderEl.setAttribute('aria-busy', 'false')
  }

  if (loaderFinishAt > 0 && now >= loaderFinishAt) {
    loaderEl.hidden = true
    bootLoading = false
    window.clearInterval(loaderStallTimer)
    setStatus('Adaptive streaming · ready')
    flyToCloud(reducedMotion ? 900 : 6200, true)
  }
}

const onLoaderRetry = () => location.reload()
loaderRetryEl.addEventListener('click', onLoaderRetry)
const loaderStallTimer = window.setInterval(() => {
  if (!bootLoading || loaderFailed || loaderFinishAt > 0 || performance.now() - loaderLastAdvance < 20_000) return
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
const distanceFog = new THREE.Fog(DAYLIGHT_SKY, 360_000, 600_000)
scene.fog = distanceFog
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 10, 650_000)
const uniforms = createUniforms()
const adaptiveQuality = new AdaptiveQualityController()
const fps = new Fps()

let globe: Globe | null = null
let stream: StreamingCloud | null = null
let markerLayer: MarkerLayer | null = null
let rainLayer: RainLayer | null = null
let lastStreamStats: StreamingStats | null = null
let sseAuto = 256
let cameraGroundRange = Infinity
let graphicsFailed = false
let cinematicFlightProgress = 1
let atmosphereFar = camera.far
let lastAtmosphereUpdate = -Infinity

const rainToggleEl = $<HTMLButtonElement>('#rainToggle')
let rainRequested = false
let rainVisualActive = false

function updateRainToggle(): void {
  rainToggleEl.classList.toggle('on', rainRequested)
  rainToggleEl.setAttribute('aria-pressed', String(rainRequested))
  rainToggleEl.textContent = !rainRequested
    ? '☂ Rain · Off'
    : rainVisualActive
      ? '☂ Rain · Active'
      : '☂ Rain · Near view'
}

const onRainToggle = () => {
  rainRequested = !rainRequested
  rainLayer?.setEnabled(rainRequested)
  if (!rainRequested) rainVisualActive = false
  updateRainToggle()
}
rainToggleEl.addEventListener('click', onRainToggle)
updateRainToggle()

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
let videoReturnFocus: HTMLElement | null = null

function openFieldVideo(): void {
  if (!videoModalEl.hidden) return
  videoReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  videoModalEl.hidden = false
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
  if (globe) globe.controls.enabled = !flight
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
const vignetteEl = $<HTMLDivElement>('#vignette')

function setMaskMode(mode: number): void {
  uniforms.maskMode.value = mode
  if (mode !== 2) {
    uniforms.vignetteStrength.value = 0
    vignetteEl.style.opacity = '0'
  }
  document.body.classList.toggle('mask-vignette', mode === 2)
  document.querySelectorAll<HTMLButtonElement>('#maskSeg button').forEach((button) =>
    button.classList.toggle('on', Number(button.dataset.mask) === mode))
  $('#hint').textContent = mode > 0
    ? 'Mask follows the view centre · Drag = rotate globe'
    : 'Drag = rotate globe · Wheel/pinch = zoom'
}

function smooth01(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function updateMaskFollow(): void {
  const mode = uniforms.maskMode.value
  ndc.set(0, 0)
  ray.setFromCamera(ndc, camera)

  if (ray.ray.intersectPlane(groundPlane, hitEcef)) {
    cameraGroundRange = camera.position.distanceTo(hitEcef)
    hitEnu.copy(hitEcef).applyMatrix4(enuInverse)
    hit2d.set(hitEnu.x, hitEnu.y)
    if (!followInit) { followEnu.copy(hit2d); followInit = true }
    else followEnu.lerp(hit2d, 0.2)
    uniforms.maskCenter.value.copy(followEnu)
  } else {
    cameraGroundRange = camera.position.distanceTo(cloudCenterEcef)
    if (!followInit) { maskWorldActive = false; return }
  }

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
  if (now - lastAtmosphereUpdate < 125) return
  lastAtmosphereUpdate = now

  const range = Number.isFinite(cameraGroundRange) ? cameraGroundRange : 120_000
  const targetFar = THREE.MathUtils.clamp(range * 5.5, 24_000, 650_000)
  atmosphereFar = THREE.MathUtils.lerp(atmosphereFar, targetFar, 0.22)

  camera.far = atmosphereFar
  camera.updateProjectionMatrix()
  distanceFog.near = atmosphereFar * 0.52
  distanceFog.far = atmosphereFar * 0.90
}

// ---------------------------------------------------------------- fly-to
interface CameraFlight {
  start: THREE.Vector3
  control1: THREE.Vector3
  control2: THREE.Vector3
  end: THREE.Vector3
  t0: number
  duration: number
  lastUpdate: number
}

let flight: CameraFlight | null = null
const flightPositionEnu = new THREE.Vector3()
const flightLookEnu = new THREE.Vector3()
const flightPositionWorld = new THREE.Vector3()
const flightLookWorld = new THREE.Vector3()
// Camera.lookAt() uses the camera's -Z forward axis. A plain Object3D would use
// +Z here and make the interpolated orientation turn away from the terrain.
const flightOrientation = new THREE.PerspectiveCamera()

function sampleFlightPath(activeFlight: CameraFlight, progress: number, target: THREE.Vector3): THREE.Vector3 {
  const rawT = THREE.MathUtils.clamp(progress, 0, 1)
  // One continuous curve: global smootherstep only eases the endpoints, never
  // introduces the zero-velocity seam that the former two-stage path had.
  const t = rawT * rawT * rawT * (rawT * (rawT * 6 - 15) + 10)
  const inverse = 1 - t
  return target.set(
    inverse * inverse * inverse * activeFlight.start.x
      + 3 * inverse * inverse * t * activeFlight.control1.x
      + 3 * inverse * t * t * activeFlight.control2.x
      + t * t * t * activeFlight.end.x,
    inverse * inverse * inverse * activeFlight.start.y
      + 3 * inverse * inverse * t * activeFlight.control1.y
      + 3 * inverse * t * t * activeFlight.control2.y
      + t * t * t * activeFlight.end.y,
    inverse * inverse * inverse * activeFlight.start.z
      + 3 * inverse * inverse * t * activeFlight.control1.z
      + 3 * inverse * t * t * activeFlight.control2.z
      + t * t * t * activeFlight.end.z,
  )
}

function flyToCloud(duration = 5200, startFromOverview = false): void {
  const end = new THREE.Vector3(cloudCenterEnu.x, cloudCenterEnu.y - 2200, cloudCenterEnu.z + 1500)
  let start: THREE.Vector3
  let control1: THREE.Vector3
  let control2: THREE.Vector3

  if (startFromOverview) {
    start = new THREE.Vector3(cloudCenterEnu.x, cloudCenterEnu.y - 132_000, cloudCenterEnu.z + 92_000)
    control1 = new THREE.Vector3(cloudCenterEnu.x - 8_000, cloudCenterEnu.y - 116_000, cloudCenterEnu.z + 19_000)
    control2 = new THREE.Vector3(cloudCenterEnu.x + 14_000, cloudCenterEnu.y - 34_000, cloudCenterEnu.z + 8_500)
  } else {
    start = worldToEnu(camera.position)
    const range = start.distanceTo(end)
    control1 = start.clone().lerp(end, 0.28)
    control1.x -= Math.min(10_000, range * 0.07)
    control1.z = Math.max(control1.z, end.z + Math.min(16_000, range * 0.16))
    control2 = start.clone().lerp(end, 0.72)
    control2.x += Math.min(8_000, range * 0.055)
    control2.z = Math.max(control2.z, end.z + Math.min(8_000, range * 0.075))
  }

  const started = performance.now()
  flight = { start, control1, control2, end, t0: started, duration, lastUpdate: started }
  cinematicFlightProgress = 0
  camera.position.copy(enuToWorld(start, flightPositionWorld))
  sampleFlightPath(flight, 0.025, flightLookEnu)
  camera.up.copy(enuUp)
  camera.lookAt(enuToWorld(flightLookEnu, flightLookWorld))
  if (globe) globe.controls.enabled = false
}

function updateFlight(now: number): void {
  if (!flight) return
  const activeFlight = flight
  const t = Math.min(1, (now - activeFlight.t0) / activeFlight.duration)
  const elapsed = Math.min(48, Math.max(0, now - activeFlight.lastUpdate))
  activeFlight.lastUpdate = now
  cinematicFlightProgress = t
  sampleFlightPath(activeFlight, t, flightPositionEnu)
  sampleFlightPath(activeFlight, Math.min(1, t + 0.022), flightLookEnu)
  flightLookEnu.lerp(cloudCenterEnu, smooth01(0.56, 1, t))

  camera.position.copy(enuToWorld(flightPositionEnu, flightPositionWorld))
  camera.up.copy(enuUp)
  enuToWorld(flightLookEnu, flightLookWorld)
  flightOrientation.position.copy(camera.position)
  flightOrientation.up.copy(enuUp)
  flightOrientation.lookAt(flightLookWorld)
  camera.quaternion.slerp(flightOrientation.quaternion, 1 - Math.exp(-elapsed / 85))
  if (t >= 1) {
    camera.quaternion.copy(flightOrientation.quaternion)
    flight = null
    if (globe) globe.controls.enabled = true
  }
}

// ---------------------------------------------------------------- UI wiring
const sizeEl = $<HTMLInputElement>('#size')

document.querySelectorAll<HTMLButtonElement>('#maskSeg button').forEach((button) => {
  button.addEventListener('click', () => setMaskMode(Number(button.dataset.mask)))
})
sizeEl.addEventListener('input', () => {
  uniforms.pointSize.value = Number(sizeEl.value)
  $('#sizev').textContent = sizeEl.value
})
$('#flyTo').addEventListener('click', () => flyToCloud(reducedMotion ? 700 : 5200))

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
    cameraGroundRange,
  })
  // Hold a coarse refinement floor while the cinematic camera is moving. The
  // near tiles were already warmed behind the loader, so this prevents flight-
  // time decode/upload spikes without changing the final visual quality.
  const flightSse = flight ? Math.max(quality.sse, 256) : quality.sse
  if (Math.abs(flightSse - sseAuto) > 0.25) {
    sseAuto = flightSse
    stream.setErrorTarget(sseAuto)
  }
  stream.setQualityPressure(flight ? Math.max(quality.pressure, 1.6) : quality.pressure)

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
}

function loop(now: number): void {
  if (graphicsFailed) return
  fps.tick(now)
  updateFlight(now)
  globe?.update()
  updateMaskFollow()
  updateAtmosphere(now)
  const stats = updateStreaming(now)
  markerLayer?.update(now, camera, cameraGroundRange)
  const nextRainActive = rainLayer?.update(now, camera, cameraGroundRange) ?? false
  if (nextRainActive !== rainVisualActive) {
    rainVisualActive = nextRainActive
    updateRainToggle()
  }
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

  setStatus('Loading adaptive point-cloud tree…')
  setLoadProgress(0.22, 'Lade Fluggebiet und Koordinaten …')
  const manifest = await fetchGlobeManifest(baseUrl, dataset)
  setLoadProgress(0.28, 'Fluggebiet lokalisiert. Baue Szene …')
  enuFrame.fromArray(manifest.rootTransform)
  enuInverse.copy(enuFrame).invert()
  uniforms.enuInverse.value.copy(enuInverse)
  enuUp.setFromMatrixColumn(enuFrame, 2).normalize()

  if (manifest.areaBbox) {
    const [minX, minY, minZ, maxX, maxY] = manifest.areaBbox
    zOffset = groundSnap ? -minZ : 0
    areaMinZ = minZ
    cloudCenterEnu.set((minX + maxX) / 2, (minY + maxY) / 2, minZ + 40)
  }
  enuToWorld(cloudCenterEnu, cloudCenterEcef)
  uniforms.maskCenter.value.set(cloudCenterEnu.x, cloudCenterEnu.y)
  const planePoint = enuToWorld(new THREE.Vector3(cloudCenterEnu.x, cloudCenterEnu.y, cloudCenterEnu.z - 40))
  groundPlane.setFromNormalAndCoplanarPoint(enuUp, planePoint)

  globe = createGlobe({ renderer: renderer as any, camera, scene, maptilerKey: MAPTILER_KEY, uniforms })
  stream = createStreamingCloud({
    tilesetUrl: `${baseUrl}/${manifest.oneLodTreeDataset}/${manifest.oneLodTreeTilesetFile}`,
    camera,
    renderer,
    scene,
    uniforms,
    errorTarget: sseAuto,
  })
  stream.group.position.copy(enuUp).multiplyScalar(zOffset)

  if (manifest.areaBbox) {
    markerLayer = createMarkerLayer({
      scene,
      overlay: $('#markerOverlay'),
      enuFrame,
      zOffset,
      areaBbox: manifest.areaBbox as [number, number, number, number, number, number],
      dataset,
      reducedMotion,
      onOpenVideo: openFieldVideo,
    })
  }
  rainLayer = createRainLayer(scene)
  rainLayer.setEnabled(rainRequested)
  setLoadProgress(0.35, 'Lade erste Kronendach-Punktwolken …')

  // Bootstrap close enough to request real point tiles. The fullscreen loader
  // conceals this staging position; once both data layers are visible we jump
  // to the overview and begin the user-facing flight.
  camera.position.copy(enuToWorld(new THREE.Vector3(
    cloudCenterEnu.x,
    cloudCenterEnu.y - 2200,
    cloudCenterEnu.z + 1500,
  )))
  camera.up.copy(enuUp)
  camera.lookAt(cloudCenterEcef)

  setMaskMode(2)
  setStatus('Adaptive streaming · loading tiles…')
  renderer.setAnimationLoop(loop)

  ;(window as any).__three = { renderer, scene, camera, uniforms, globe, stream, markerLayer, rainLayer, loop }
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
  renderer.setAnimationLoop(null)
  window.clearInterval(loaderStallTimer)
  closeFieldVideo(false)
  rainLayer?.dispose()
  markerLayer?.dispose()
  stream?.dispose()
  globe?.dispose()
  rainToggleEl.removeEventListener('click', onRainToggle)
  loaderRetryEl.removeEventListener('click', onLoaderRetry)
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
