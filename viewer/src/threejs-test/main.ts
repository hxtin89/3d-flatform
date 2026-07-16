// Three.js + WebGPU map app — the Cesium viewer's ?basemap=maptiler concept
// (real WGS84 globe with MapTiler satellite imagery + the Peru point cloud placed
// on it) rendered with vanilla three.js instead of Cesium.
//
// Point-cloud modes (switchable):
//   Streaming   — DEFAULT. Density tiers like the original viewer: overview p02
//                 always, explore p10 / detail p100 stream in as the camera gets
//                 close; an adaptive SSE controller caps total visible points.
//   F32 · RGB   — ONE flat buffer, float32 positions + real uint8 colours
//   F16 · Höhe  — ONE flat buffer, half-float positions, height-gradient colour
//   (flat buffers are lazy-loaded on first switch — saves ~50–100 MB on mobile)
//
// Masks (all modes): world-anchored ENU circle, or a viewport-fitting vignette
// (clear core, soft dithered fade to the edges). Placement: the dataset's
// area-manifest rootTransform (ENU→ECEF) — identical to what Cesium uses.
// Falls back to WebGL2 via ?webgl (or when no secure context, e.g. LAN http).
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { loadPointCloud } from './pnts-loader'
import { buildCloud, createUniforms, type BuiltCloud, type ColorMode } from './point-cloud'
import { createGlobe, type Globe } from './globe'
import { createStreamingCloud, type StreamingCloud } from './streaming'
import { fetchGlobeManifest } from './manifest'
import { Fps } from './stats'

// ---------------------------------------------------------------- config
const params = new URLSearchParams(location.search)
const domain = (import.meta.env.VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN ?? '')
  .replace(/^https?:\/\//, '').replace(/\/+$/, '')
const folder = (import.meta.env.VITE_POINTCLOUD_TILES_FOLDER ?? 'pointcloud-tiles').replace(/^\/+|\/+$/g, '')
const baseUrl = domain ? `https://${domain}/${folder}` : ''
const MAPTILER_KEY = (import.meta.env.VITE_MAPTILER_API_KEY ?? '').trim()
const dataset = params.get('dataset') ?? 'peru-b2-globe'
const maxPoints = Math.max(100_000, parseInt(params.get('maxPoints') ?? '3000000', 10) || 3_000_000)
const forceWebGL = params.has('webgl')
const blockSize = parseInt(params.get('block') ?? '64', 10) || 64
const maxAxis = parseInt(params.get('maxax') ?? '24', 10) || 24
// Terrain sits ~230–300 m above the WGS84 ellipsoid but the imagery is draped AT
// the ellipsoid — snap the cloud base down onto it (rigid shift). ?nosnap disables.
const groundSnap = !params.has('nosnap')

// ---------------------------------------------------------------- dom helpers
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US')
const fmtBig = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n))
const setStatus = (t: string) => { $('#status').textContent = t }

// ---------------------------------------------------------------- preloader bar
const loaderEl = $('#loader')
const loaderBar = $('#loader .bar') as HTMLDivElement
let loaderDone = false
let bootLoading = true // boot phase: bar tracks manifest + first streaming tier
function setLoadProgress(p: number): void {
  if (loaderDone && p < 1) { loaderDone = false; loaderEl.classList.remove('done') }
  loaderBar.style.transform = `scaleX(${Math.min(1, Math.max(0, p)).toFixed(3)})`
  if (p >= 1 && !loaderDone) { loaderDone = true; loaderEl.classList.add('done') }
}

// ---------------------------------------------------------------- overlay chips
// Mobile: overlays start collapsed (only the two chips are visible); desktop: open.
const isMobile = matchMedia('(max-width: 700px)').matches
document.body.classList.toggle('hud-open', !isMobile)
document.body.classList.toggle('panel-open', !isMobile)
$('#hudChip').addEventListener('click', () => document.body.classList.toggle('hud-open'))
$('#panelChip').addEventListener('click', () => document.body.classList.toggle('panel-open'))
document.querySelectorAll<HTMLButtonElement>('.close').forEach((btn) => {
  btn.addEventListener('click', () => document.body.classList.remove(`${btn.dataset.close}-open`))
})

// ---------------------------------------------------------------- renderer / scene
const canvas = $<HTMLCanvasElement>('#view')
const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL } as any)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setClearColor(0x02040a, 1) // space behind the globe

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 10, 1e8)

const uniforms = createUniforms()

// ---------------------------------------------------------------- state
type Mode = ColorMode | 'stream'
let mode: Mode = 'stream'
let built: BuiltCloud | null = null
let cloudRef: Awaited<ReturnType<typeof loadPointCloud>> | null = null
let flatLoading = false
let cloudCount = 0
let budget = 1_500_000
let globe: Globe | null = null
let isWebGPU = false

// Mobile Safari kills the whole tab (jetsam) well below desktop memory levels —
// an iPhone 14 Pro dies around ~1–1.5 GB including GPU buffers. Detect phones/tablets
// and run with much tighter point + cache budgets there.
const isMobileDevice = /iPhone|iPad|Android/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent)) // iPadOS masquerades as Mac

// Streaming density tiers + adaptive SSE point budget (zoomed out → density drops).
type TierName = 'overview' | 'explore' | 'detail'
const tiers: Record<TierName, StreamingCloud | null> = { overview: null, explore: null, detail: null }
const defaultBudget = isMobileDevice ? 2_500_000 : 8_000_000
const streamBudget = Math.max(500_000, parseInt(params.get('streamBudget') ?? String(defaultBudget), 10) || defaultBudget)
// per-tier LRU/memory caps (bytes are per TilesRenderer — up to 3 run at once!)
const tierLimits = isMobileDevice
  ? { cacheMinTiles: 60, cacheMaxTiles: 150, cacheMinBytes: 40e6, cacheMaxBytes: 70e6, maxDownloads: 8 }
  : { cacheMinTiles: 600, cacheMaxTiles: 1200, cacheMinBytes: 150e6, cacheMaxBytes: 250e6, maxDownloads: 25 }
let sseBase = 16 // slider value = quality floor; auto-SSE only degrades above it
let sseAuto = 16
let lastBudgetCheck = 0
let lastStreamPoints = 0 // previous frame's visible points (gates the detail tier)
let detailBlockedUntil = 0 // cooldown after a forced detail shutdown (anti-flapping)
const EXPLORE_DIST = 3200, DETAIL_DIST = 900 // m, camera→cloud centre (× 1.25 hysteresis out)

// ENU→ECEF frame of the survey (from the manifest) + derived helpers
const enuFrame = new THREE.Matrix4()
const enuInverse = new THREE.Matrix4()
const ecefGroup = new THREE.Group() // parent of the flat-buffer cloud
ecefGroup.matrixAutoUpdate = false
scene.add(ecefGroup)

const cloudCenterEnu = new THREE.Vector3() // centre of the cloud, ENU
const cloudCenterEcef = new THREE.Vector3()
const enuUp = new THREE.Vector3(0, 0, 1)
let zOffset = 0 // ground-snap shift applied along ENU up (0 when ?nosnap)

const ZERO = new THREE.Vector3(0, 0, 0)

/** ENU (survey frame) → world/ECEF including the ground-snap shift. */
function enuToWorld(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x, v.y, v.z + zOffset).applyMatrix4(enuFrame)
}

function rebuild(): void {
  if (!cloudRef || mode === 'stream') return
  if (built) { ecefGroup.remove(built.group); built.dispose() }
  built = buildCloud(cloudRef, {
    mode, budget: Math.min(budget, cloudCount), center: ZERO, uniforms, blockSize, maxBlocksPerAxis: maxAxis,
    nativeF16: isWebGPU,
  })
  ecefGroup.add(built.group)
  $('#displayed').textContent = fmtInt(built.displayedCount)
  $('#blocks').textContent = String(built.blocks.length)
}

// ---------------------------------------------------------------- flat lazy-load
// The explore flat buffer (~50–100 MB) is only fetched when F32/F16 is first used.
async function ensureFlatLoaded(): Promise<boolean> {
  if (cloudRef) return true
  if (flatLoading) return false
  flatLoading = true
  setLoadProgress(0.02)
  document.querySelectorAll<HTMLButtonElement>('#mode button').forEach((b) => (b.disabled = true))
  try {
    const cloud = await loadPointCloud({
      baseUrl, dataset: exploreDS, maxPoints,
      onProgress: (p) => {
        $('#loaded').textContent = fmtInt(p.loadedPoints)
        if (p.totalTiles > 0) setLoadProgress(p.loadedTiles / p.totalTiles)
        setStatus(`Loading point cloud… ${fmtBig(p.loadedPoints)} · ${p.loadedTiles}/${p.totalTiles} · ${(p.bytes / 1e6).toFixed(0)} MB`)
      },
    })
    cloudRef = cloud
    cloudCount = cloud.count
    if (!cloudCount) { setStatus('No points loaded'); return false }

    // robust vegetation-height range for the F16 gradient (2%/98% of sampled z)
    const zs: number[] = []
    const stride = Math.max(1, Math.floor(cloud.count / 20000)) * 3
    for (let i = 2; i < cloud.positions.length; i += stride) zs.push(cloud.positions[i])
    zs.sort((a, b) => a - b)
    const p02 = zs[Math.floor(zs.length * 0.02)] ?? cloud.bounds[2]
    const p98 = zs[Math.floor(zs.length * 0.98)] ?? cloud.bounds[5]
    uniforms.zMin.value = 0
    uniforms.zMax.value = Math.max(5, p98 - p02)

    budgetEl.max = String(cloudCount)
    budget = Math.min(budget, cloudCount)
    budgetEl.value = String(budget)
    $('#budgetv').textContent = fmtBig(budget)
    setStatus(`Ready · ${fmtInt(cloudCount)} pts loaded`)
    return true
  } catch (err: any) {
    setStatus('Load failed: ' + (err?.message ?? err))
    return false
  } finally {
    setLoadProgress(1)
    flatLoading = false
    document.querySelectorAll<HTMLButtonElement>('#mode button').forEach((b) => (b.disabled = false))
  }
}

// ---------------------------------------------------------------- mode switching
function applyMode(next: Mode): void {
  mode = next
  const flat = next !== 'stream'
  ecefGroup.visible = flat
  document.body.classList.toggle('stream-mode', !flat)

  if (!flat) {
    ensureTier('overview')
  } else {
    for (const t of Object.values(tiers)) if (t) t.group.visible = false
    if (cloudRef) rebuild()
    else void ensureFlatLoaded().then((ok) => { if (ok && mode !== 'stream') rebuild() })
  }
}

function ensureTier(name: TierName): StreamingCloud | null {
  if (!tiers[name]) {
    const ds = name === 'overview' ? overviewDataset : name === 'explore' ? exploreDS : detailDS
    if (!ds) return null
    const t = createStreamingCloud({
      tilesetUrl: `${baseUrl}/${ds}/tileset.json`,
      camera, renderer, scene, uniforms,
      errorTarget: sseAuto,
      limits: tierLimits,
    })
    // apply the same ground-snap shift (tileset root transform is ECEF already)
    t.group.position.copy(enuUp).multiplyScalar(zOffset)
    tiers[name] = t
  }
  tiers[name]!.group.visible = true
  return tiers[name]
}

/** Distance-based tier activation + adaptive SSE point budget. */
function updateStreaming(now: number): { points: number; tiles: number; label: string } {
  const d = camera.position.distanceTo(cloudCenterEcef)
  const wantExplore = d < (tiers.explore?.group.visible ? EXPLORE_DIST * 1.25 : EXPLORE_DIST)
  // Detail (p100) only when the point count is under control — its full density
  // inside the view can multiply memory use and jetsam mobile Safari.
  const detailHeadroom = tiers.detail?.group.visible
    || (lastStreamPoints < streamBudget * 0.9 && now > detailBlockedUntil)
  const wantDetail = d < (tiers.detail?.group.visible ? DETAIL_DIST * 1.25 : DETAIL_DIST) && !!detailDS && detailHeadroom

  ensureTier('overview')
  if (wantExplore) ensureTier('explore')
  else if (tiers.explore) tiers.explore.group.visible = false
  if (wantDetail) ensureTier('detail')
  else if (tiers.detail) tiers.detail.group.visible = false

  let points = 0, tileCount = 0
  for (const t of Object.values(tiers)) {
    if (!t || !t.group.visible) continue
    t.setMaskSphere(maskWorldActive ? maskSphereWorld : null, maskWorldRadius)
    t.update()
    const s = t.stats()
    points += s.points
    tileCount += s.visible
  }

  lastStreamPoints = points

  // budget controller: degrade SSE when over budget, recover toward the slider floor.
  // React fast when far over budget — on mobile the tab is dead before a slow ramp.
  if (now - lastBudgetCheck > 500) {
    lastBudgetCheck = now
    if (points > streamBudget * 1.5) sseAuto = Math.min(sseAuto * 1.6, 256)
    else if (points > streamBudget) sseAuto = Math.min(sseAuto * 1.25, 256)
    else if (points < streamBudget * 0.5 && sseAuto > sseBase) sseAuto = Math.max(sseBase, sseAuto * 0.85)
    for (const t of Object.values(tiers)) t?.setErrorTarget(sseAuto)
  }

  // hide the detail tier again if the budget is blown while it is active
  if (tiers.detail?.group.visible && points > streamBudget * 2) {
    tiers.detail.group.visible = false
    detailBlockedUntil = now + 8000
  }

  const label = wantDetail ? 'Detail p100' : wantExplore ? 'Explore p10' : 'Overview p02'
  return { points, tiles: tileCount, label }
}

// ---------------------------------------------------------------- mask
// The mask always follows the view centre: a ray from the middle of the screen is
// intersected with the ground plane each frame — no manual placement. The resulting
// world sphere is fed to the streaming tiers so tiles outside it are neither loaded
// nor rendered (LoadRegionPlugin) and their GPU memory is freed (UnloadTilesPlugin).
const groundPlane = new THREE.Plane()
const ray = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const hitEcef = new THREE.Vector3()
const hitEnu = new THREE.Vector3()
const followEnu = new THREE.Vector2() // smoothed mask centre, ENU xy
let followInit = false
const maskSphereEnu = new THREE.Vector3()
const maskSphereWorld = new THREE.Vector3()
let maskWorldActive = false // whether maskSphereWorld/maskWorldRadius are valid
let maskWorldRadius = 0 // cull radius in metres (circle: slider; vignette: derived)
let areaMinZ = 0 // ENU z of the survey's ground (from the manifest bbox)

function setMaskMode(m: number): void {
  uniforms.maskMode.value = m
  if (m !== 2) uniforms.vignetteStrength.value = 0
  document.body.classList.toggle('mask-circle', m === 1) // radius slider (circle only)
  document.body.classList.toggle('mask-vignette', m === 2) // shows the CSS overlay
  document.querySelectorAll<HTMLButtonElement>('#maskSeg button').forEach((b) =>
    b.classList.toggle('on', +b.dataset.mask! === m))
  const hint = $('#hint')
  if (hint) hint.textContent = m > 0
    ? 'Mask follows the view centre · Drag = rotate globe'
    : 'Drag = rotate globe · Wheel/pinch = zoom'
}

const smooth01 = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const vignetteEl = $<HTMLDivElement>('#vignette')

function updateMaskFollow(): void {
  const m = uniforms.maskMode.value
  if (m === 0) { maskWorldActive = false; return }

  // view-centre ray → ground plane → smoothed ENU mask centre
  ndc.set(0, 0)
  ray.setFromCamera(ndc, camera)
  if (ray.ray.intersectPlane(groundPlane, hitEcef)) {
    hitEnu.copy(hitEcef).applyMatrix4(enuInverse)
    if (!followInit) { followEnu.set(hitEnu.x, hitEnu.y); followInit = true }
    else followEnu.lerp(new THREE.Vector2(hitEnu.x, hitEnu.y), 0.2)
    uniforms.maskCenter.value.copy(followEnu)
  } else if (!followInit) { maskWorldActive = false; return }

  let cullActive = true
  if (m === 1) {
    // circle: hard cut at the slider radius, always culled
    uniforms.maskRadius.value = +radiusEl.value
  } else {
    // Vignette: the lit core scales with the VIEWPORT — its radius is a fixed
    // fraction of the visible ground footprint (distance camera → view-centre hit),
    // so zooming in shrinks the radius and with it the number of rendered points.
    // Everything beyond fades to black in world space (points + imagery), so any
    // radius looks seamless. At globe distances the clamp saturates and the
    // strength blends the spotlight out entirely — the page boots as a normal map.
    const centerDist = camera.position.distanceTo(hitEcef)
    const r = THREE.MathUtils.clamp(centerDist * 0.55, 30, 2000)
    const strength = 1 - smooth01(4, 20, centerDist / r)
    uniforms.maskRadius.value = r
    uniforms.vignetteStrength.value = strength
    vignetteEl.style.opacity = String(strength)
    cullActive = strength > 0.9 // only cull data once the spotlight is fully formed
  }
  // tile-cull sphere: shader radius + margin for canopy height / tile bounds
  maskWorldRadius = uniforms.maskRadius.value + 80
  maskSphereEnu.set(followEnu.x, followEnu.y, areaMinZ + 50)
  enuToWorld(maskSphereEnu, maskSphereWorld)
  maskWorldActive = cullActive
}

// ---------------------------------------------------------------- per-frame block cull
function cullBlocks(): number {
  if (!built || mode === 'stream') return 0
  // CPU cull for both masks (the radius uniform holds the effective cut radius)
  const on = uniforms.maskMode.value > 0 && maskWorldActive
  const mcx = uniforms.maskCenter.value.x, mcy = uniforms.maskCenter.value.y
  const rr = uniforms.maskRadius.value
  const r2 = rr * rr
  let visible = 0
  for (const b of built.blocks) {
    let show = true
    if (on) {
      const qx = Math.max(b.box.min.x, Math.min(mcx, b.box.max.x))
      const qy = Math.max(b.box.min.y, Math.min(mcy, b.box.max.y))
      const dx = qx - mcx, dy = qy - mcy
      show = dx * dx + dy * dy <= r2
    }
    b.mesh.visible = show
    if (show) visible += (b.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).count
  }
  return visible
}

// ---------------------------------------------------------------- fly-to
let flight: { from: THREE.Vector3; to: THREE.Vector3; look: THREE.Vector3; t0: number; dur: number } | null = null

function flyToCloud(durationMs = 2500): void {
  const to = enuToWorld(new THREE.Vector3(cloudCenterEnu.x, cloudCenterEnu.y - 2200, cloudCenterEnu.z + 1500))
  flight = { from: camera.position.clone(), to, look: cloudCenterEcef.clone(), t0: performance.now(), dur: durationMs }
  if (globe) globe.controls.enabled = false
}

function updateFlight(now: number): void {
  if (!flight) return
  const t = Math.min(1, (now - flight.t0) / flight.dur)
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2 // easeInOutQuad
  camera.position.lerpVectors(flight.from, flight.to, e)
  camera.up.copy(enuUp)
  camera.lookAt(flight.look)
  if (t >= 1) { flight = null; if (globe) globe.controls.enabled = true }
}

// ---------------------------------------------------------------- UI wiring
const budgetEl = $<HTMLInputElement>('#budget')
const sizeEl = $<HTMLInputElement>('#size')
const radiusEl = $<HTMLInputElement>('#radius')
const sseEl = $<HTMLInputElement>('#sse')

document.querySelectorAll<HTMLButtonElement>('#mode button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const m = btn.dataset.mode as Mode
    if (m === mode) return
    document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b === btn))
    applyMode(m)
  })
})
document.querySelectorAll<HTMLButtonElement>('#maskSeg button').forEach((btn) => {
  btn.addEventListener('click', () => setMaskMode(+btn.dataset.mask!))
})
budgetEl.addEventListener('input', () => { $('#budgetv').textContent = fmtBig(+budgetEl.value) })
budgetEl.addEventListener('change', () => { budget = +budgetEl.value; rebuild() })
sizeEl.addEventListener('input', () => {
  uniforms.pointSize.value = +sizeEl.value // shared uniform drives ALL modes incl. streaming
  $('#sizev').textContent = sizeEl.value
})
radiusEl.addEventListener('input', () => { uniforms.maskRadius.value = +radiusEl.value; $('#radiusv').textContent = radiusEl.value })
sseEl.addEventListener('input', () => {
  sseBase = +sseEl.value
  sseAuto = Math.max(sseAuto, sseBase)
  for (const t of Object.values(tiers)) t?.setErrorTarget(sseAuto)
  $('#ssev').textContent = sseEl.value
})

$('#flyTo').addEventListener('click', () => flyToCloud())

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  globe?.setResolution()
  for (const t of Object.values(tiers)) t?.tiles.setResolutionFromRenderer(camera, renderer as any)
})

// ---------------------------------------------------------------- HUD / loop
const fps = new Fps()
const fpsEl = $('#fpsv'), msEl = $('#msv'), visEl = $('#visible'), blocksEl = $('#blocks'), dispEl = $('#displayed')
const chipFpsEl = $('#chipFps')
interface StreamHud { points: number; tiles: number; label: string }
function updateHud(stream: StreamHud | null): void {
  if (stream) {
    visEl.textContent = fmtInt(stream.points)
    blocksEl.textContent = String(stream.tiles)
    dispEl.textContent = `${stream.label} · SSE ${sseAuto.toFixed(0)}`
  } else {
    visEl.textContent = fmtInt(cullBlocks())
  }
  const f = fps.fps
  fpsEl.textContent = f ? f.toFixed(0) : '—'
  msEl.textContent = fps.frameMs ? fps.frameMs.toFixed(1) : '—'
  const cls = f >= 58 ? 'good' : f >= 40 ? 'warn' : 'bad'
  fpsEl.className = 'v ' + cls
  chipFpsEl.textContent = f ? `${f.toFixed(0)} fps` : '—'
  chipFpsEl.className = cls
}

function loop(now: number): void {
  updateFlight(now)
  globe?.update() // controls + camera matrices + imagery tiles
  updateMaskFollow() // mask centre/radius track the view centre (needs fresh camera)
  let stream: StreamHud | null = null
  if (mode === 'stream') stream = updateStreaming(now)
  if (bootLoading) {
    // boot bar: 0.25 after init/manifest, then first streaming tier fills 0.25→1
    const p = tiers.overview ? 0.25 + 0.75 * tiers.overview.stats().progress : 0.25
    setLoadProgress(p)
    if (p >= 1) bootLoading = false
  }
  else if (built) cullBlocks()
  fps.tick(now)
  updateHud(stream)
  renderer.render(scene, camera)
}

// ---------------------------------------------------------------- boot
let overviewDataset = ''
let exploreDS = ''
let detailDS: string | null = null

async function main(): Promise<void> {
  if (!baseUrl) { setStatus('Error: CloudFront domain missing in .env'); return }
  if (!MAPTILER_KEY) { setStatus('Error: VITE_MAPTILER_API_KEY missing in .env'); return }

  setLoadProgress(0.05)
  await renderer.init()
  setLoadProgress(0.12)
  const backend: any = (renderer as any).backend
  isWebGPU = !!(backend?.isWebGPUBackend ?? (backend && /WebGPU/i.test(backend.constructor?.name)))
  const badge = $('#backend')
  badge.textContent = isWebGPU ? 'WebGPU' : 'WebGL2'
  badge.classList.toggle('webgl', !isWebGPU)

  // --- manifest: ENU→ECEF placement + dataset names (same source Cesium uses) ---
  setStatus('Loading manifest…')
  const manifest = await fetchGlobeManifest(baseUrl, dataset)
  setLoadProgress(0.2)
  overviewDataset = manifest.overviewDataset
  exploreDS = manifest.exploreDataset
  detailDS = manifest.detailDataset
  enuFrame.fromArray(manifest.rootTransform)
  enuInverse.copy(enuFrame).invert()
  uniforms.enuInverse.value.copy(enuInverse)
  enuUp.setFromMatrixColumn(enuFrame, 2).normalize()

  // Ground snap + cloud centre from the manifest bbox (needed BEFORE streaming
  // starts; the flat-buffer load later must NOT change it — tiers/mask consistency).
  if (manifest.areaBbox) {
    const [ax, ay, az, bx, by] = manifest.areaBbox
    zOffset = groundSnap ? -az : 0
    areaMinZ = az
    cloudCenterEnu.set((ax + bx) / 2, (ay + by) / 2, az + 40) // ~canopy height focus
  }
  ecefGroup.matrix.copy(enuFrame).multiply(new THREE.Matrix4().makeTranslation(0, 0, zOffset))
  ecefGroup.matrixWorldNeedsUpdate = true
  enuToWorld(cloudCenterEnu, cloudCenterEcef)
  uniforms.maskCenter.value.set(cloudCenterEnu.x, cloudCenterEnu.y)
  const planePoint = enuToWorld(new THREE.Vector3(cloudCenterEnu.x, cloudCenterEnu.y, cloudCenterEnu.z - 40))
  groundPlane.setFromNormalAndCoplanarPoint(enuUp, planePoint)

  // --- globe: MapTiler satellite on the WGS84 ellipsoid --------------------------
  globe = createGlobe({ renderer: renderer as any, camera, scene, maptilerKey: MAPTILER_KEY, uniforms })

  camera.position.copy(enuToWorld(new THREE.Vector3(cloudCenterEnu.x, cloudCenterEnu.y - 130_000, cloudCenterEnu.z + 90_000)))
  camera.up.copy(enuUp)
  camera.lookAt(cloudCenterEcef)

  // --- default mode: STREAMING (flat buffers load lazily on first switch) --------
  applyMode('stream')
  setMaskMode(2) // vignette is the default mask
  setStatus('Streaming · loading tiles…')
  renderer.setAnimationLoop(loop)
  flyToCloud(3000)

  // Debug: rAF is throttled in hidden tabs — __bench times renderAsync directly.
  ;(window as any).__three = { renderer, scene, camera, uniforms, globe, tiers, loop, get built() { return built } }
  ;(window as any).__bench = async (frames = 60) => {
    const t0 = performance.now()
    for (let i = 0; i < frames; i++) await (renderer as any).renderAsync(scene, camera)
    const ms = (performance.now() - t0) / frames
    return { frames, msPerFrame: +ms.toFixed(2), fps: +(1000 / ms).toFixed(1), mode, displayed: built?.displayedCount }
  }
}

main().catch((err) => {
  console.error('[threejs-test] fatal', err)
  setStatus('Error: ' + (err?.message ?? err))
})
