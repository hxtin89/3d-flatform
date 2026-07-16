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

// ---------------------------------------------------------------- dom helpers
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T
const fmtInt = (value: number) => Math.round(value).toLocaleString('en-US')
const fmtMiB = (value: number) => `${Math.round(value / (1024 * 1024))} MB`
const setStatus = (text: string) => { $('#status').textContent = text }

// ---------------------------------------------------------------- preloader
const loaderEl = $('#loader')
const loaderBar = $<HTMLDivElement>('#loader .bar')
let loaderDone = false
let bootLoading = true
function setLoadProgress(progress: number): void {
  if (loaderDone && progress < 1) { loaderDone = false; loaderEl.classList.remove('done') }
  loaderBar.style.transform = `scaleX(${THREE.MathUtils.clamp(progress, 0, 1).toFixed(3)})`
  if (progress >= 1 && !loaderDone) { loaderDone = true; loaderEl.classList.add('done') }
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

// ---------------------------------------------------------------- renderer / scene
const canvas = $<HTMLCanvasElement>('#view')
const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL } as any)
// A device-independent cap avoids allocating a native 3x iPhone backbuffer while
// preserving supersampling on ordinary displays. It is never resized per frame.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setClearColor(0x02040a, 1)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 10, 1e8)
const uniforms = createUniforms()
const adaptiveQuality = new AdaptiveQualityController()
const fps = new Fps()

let globe: Globe | null = null
let stream: StreamingCloud | null = null
let lastStreamStats: StreamingStats | null = null
let sseAuto = 256
let cameraGroundRange = Infinity
let graphicsFailed = false

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

// ---------------------------------------------------------------- graphics-loss handling
function stopForGraphicsFailure(message: string): void {
  if (graphicsFailed) return
  graphicsFailed = true
  renderer.setAnimationLoop(null)
  document.body.classList.add('hud-open')
  setStatus(message)
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
  document.body.classList.toggle('mask-circle', mode === 1)
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

  let cullActive = true
  if (mode === 1) {
    uniforms.maskRadius.value = Number(radiusEl.value)
  } else {
    const radius = THREE.MathUtils.clamp(cameraGroundRange * 0.55, 30, 2000)
    const strength = 1 - smooth01(4, 20, cameraGroundRange / radius)
    uniforms.maskRadius.value = radius
    uniforms.vignetteStrength.value = strength
    vignetteEl.style.opacity = String(strength)
    cullActive = strength > 0.9
  }

  maskWorldRadius = uniforms.maskRadius.value + 80
  maskSphereEnu.set(followEnu.x, followEnu.y, areaMinZ + 50)
  enuToWorld(maskSphereEnu, maskSphereWorld)
  maskWorldActive = cullActive
}

// ---------------------------------------------------------------- fly-to
let flight: { from: THREE.Vector3; to: THREE.Vector3; look: THREE.Vector3; t0: number; duration: number } | null = null

function flyToCloud(duration = 2500): void {
  const to = enuToWorld(new THREE.Vector3(cloudCenterEnu.x, cloudCenterEnu.y - 2200, cloudCenterEnu.z + 1500))
  flight = { from: camera.position.clone(), to, look: cloudCenterEcef.clone(), t0: performance.now(), duration }
  if (globe) globe.controls.enabled = false
}

function updateFlight(now: number): void {
  if (!flight) return
  const t = Math.min(1, (now - flight.t0) / flight.duration)
  const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  camera.position.lerpVectors(flight.from, flight.to, eased)
  camera.up.copy(enuUp)
  camera.lookAt(flight.look)
  if (t >= 1) {
    flight = null
    if (globe) globe.controls.enabled = true
  }
}

// ---------------------------------------------------------------- UI wiring
const sizeEl = $<HTMLInputElement>('#size')
const radiusEl = $<HTMLInputElement>('#radius')

document.querySelectorAll<HTMLButtonElement>('#maskSeg button').forEach((button) => {
  button.addEventListener('click', () => setMaskMode(Number(button.dataset.mask)))
})
sizeEl.addEventListener('input', () => {
  uniforms.pointSize.value = Number(sizeEl.value)
  $('#sizev').textContent = sizeEl.value
})
radiusEl.addEventListener('input', () => {
  uniforms.maskRadius.value = Number(radiusEl.value)
  $('#radiusv').textContent = radiusEl.value
})
$('#flyTo').addEventListener('click', () => flyToCloud())

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
  if (Math.abs(quality.sse - sseAuto) > 0.25) {
    sseAuto = quality.sse
    stream.setErrorTarget(sseAuto)
  }
  stream.setQualityPressure(quality.pressure)

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
  const stats = updateStreaming(now)

  if (bootLoading && stats) {
    setLoadProgress(0.25 + 0.75 * stats.progress)
    if (stats.visible > 0 && stats.progress >= 0.999) {
      bootLoading = false
      setLoadProgress(1)
      setStatus('Adaptive streaming · ready')
    }
  }

  updateHud(stats)
  renderer.render(scene, camera)
}

// ---------------------------------------------------------------- boot
async function main(): Promise<void> {
  if (!baseUrl) { setStatus('Error: CloudFront domain missing in .env'); return }
  if (!MAPTILER_KEY) { setStatus('Error: VITE_MAPTILER_API_KEY missing in .env'); return }

  setLoadProgress(0.05)
  await renderer.init()
  setLoadProgress(0.12)
  const backend: any = (renderer as any).backend
  const isWebGPU = Boolean(backend?.isWebGPUBackend ?? (backend && /WebGPU/i.test(backend.constructor?.name)))
  const badge = $('#backend')
  badge.textContent = isWebGPU ? 'WebGPU' : 'WebGL2'
  badge.classList.toggle('webgl', !isWebGPU)
  installGraphicsRecovery(backend)

  setStatus('Loading adaptive point-cloud tree…')
  const manifest = await fetchGlobeManifest(baseUrl, dataset)
  setLoadProgress(0.2)
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

  camera.position.copy(enuToWorld(new THREE.Vector3(
    cloudCenterEnu.x,
    cloudCenterEnu.y - 130_000,
    cloudCenterEnu.z + 90_000,
  )))
  camera.up.copy(enuUp)
  camera.lookAt(cloudCenterEcef)

  setMaskMode(2)
  setStatus('Adaptive streaming · loading tiles…')
  renderer.setAnimationLoop(loop)
  flyToCloud(3000)

  ;(window as any).__three = { renderer, scene, camera, uniforms, globe, stream, loop }
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
  stream?.dispose()
  globe?.dispose()
  renderer.dispose()
}

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) dispose()
})

main().catch((error: any) => {
  console.error('[threejs-test] fatal', error)
  setStatus(`Error: ${error?.message ?? error}`)
})
