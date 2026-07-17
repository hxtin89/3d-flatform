// The loading-screen eagle as assembly animation AND live benchmark.
//
// Look: a genuine sparse 3D point cloud — round dots, one coherent bottom-to-
// top colour gradient, visible point structure. The bird's outline is exact:
// points are sampled on the actual SVG vector geometry (SVGLoader shapes +
// MeshSurfaceSampler), not on a raster, so feather tips match the logo.
// Every dot flies in from scattered dust with a cubic ease-out the moment the
// (time-paced) progress reaches its slot: at 50% exactly 50% of the final
// mass has arrived. The assembly always takes a minimum time to run its
// course, even when the payload comes straight from cache.
//
// Measurement: the pretty eagle alone would be too small to stress a GPU, so
// the same renderer additionally pushes a growing mass of clipped-away
// stress points (full vertex cost, zero pixels). Frame times per density
// level yield the device's point budget before the experience starts.
import * as THREE from 'three'
import { WebGPURenderer, PointsNodeMaterial } from 'three/webgpu'
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js'
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js'
import {
  Discard, Fn, If, clamp, cos, float, hash, instanceIndex, instancedBufferAttribute,
  mix, sin, smoothstep, sqrt, uniform, uv, vec2, vec3,
} from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'

export type BenchPreset = 'strong' | 'medium' | 'constrained'

export interface EagleBenchResult {
  /** Highest sampled point count whose median frame rate held the target. */
  pointsAtTarget: number
  maxPoints: number
  samples: number
  preset: BenchPreset | null
}

export interface EagleBench {
  setProgress(progress: number): void
  result(): EagleBenchResult
  dispose(): void
}

const EAGLE_SVG_URL = '/assets/svg/wilderness-eagle.svg'
const DENSITY_BUCKETS = 12
const MAX_THICKNESS = 0.2
/** A point finishes its fly-in after this much additional progress. */
const ARRIVAL_SPAN = 0.07
/** The assembly never plays faster than this, cache hit or not. */
const MIN_ASSEMBLY_SECONDS = 3.2
const EAGLE_SCALE = 0.78
/** Visible dots forming the bird. Deliberately low: the finished bird must
 * still read as individual 2px dots, never as a filled surface — only then
 * does "X% loaded = X% of the dots have landed" stay visually true. */
const VISUAL_POINTS = 60_000
const VISUAL_POINTS_MOBILE = 36_000

interface EagleShape {
  /** Flat vector geometry of the logo, normalised to x∈[-a,a], y∈[-1,1]. */
  geometry: THREE.BufferGeometry
  aspect: number
  /** Blurred silhouette raster for thickness lookup (body plump, tips thin). */
  interior: Uint8ClampedArray
  interiorWidth: number
  interiorHeight: number
}

async function loadEagleShape(): Promise<EagleShape> {
  const svgText = await (await fetch(EAGLE_SVG_URL)).text()

  // Exact vector outline: parse the SVG paths into shapes and triangulate.
  const svg = new SVGLoader().parse(svgText)
  const shapes = svg.paths.flatMap((path) => SVGLoader.createShapes(path))
  if (shapes.length === 0) throw new Error('eagle svg has no shapes')
  const geometry = new THREE.ShapeGeometry(shapes, 48)
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  const size = new THREE.Vector2(box.max.x - box.min.x, box.max.y - box.min.y)
  const aspect = size.x / size.y
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  for (let index = 0; index < position.count; index++) {
    // Normalise and flip Y (SVG runs top-down).
    const x = ((position.getX(index) - box.min.x) / size.x - 0.5) * 2 * aspect
    const y = (0.5 - (position.getY(index) - box.min.y) / size.y) * 2
    position.setXYZ(index, x, y, 0)
  }
  position.needsUpdate = true

  // Blurred raster only for the volume inflation, never for the outline.
  const width = 256
  const height = Math.round(width / aspect)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('2d context unavailable')
  const image = new Image()
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }))
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('eagle svg failed to decode'))
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
  context.filter = 'blur(5px)'
  context.drawImage(image, 0, 0, width, height)
  context.filter = 'none'
  const interior = context.getImageData(0, 0, width, height).data
  return { geometry, aspect, interior, interiorWidth: width, interiorHeight: height }
}

function isCoarseDevice(): boolean {
  const memory = Number((navigator as any).deviceMemory)
  return matchMedia('(pointer: coarse)').matches
    || (Number.isFinite(memory) && memory < 4)
}

export async function createEagleBench(
  canvas: HTMLCanvasElement,
  options: { forceWebGL: boolean },
): Promise<EagleBench> {
  const cfg = EXPERIENCE_CONFIG.eagleBench
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  const coarse = isCoarseDevice()
  const visualPoints = coarse ? VISUAL_POINTS_MOBILE : VISUAL_POINTS
  const maxPoints = coarse ? cfg.maxPointsMobile : cfg.maxPoints
  const shape = await loadEagleShape()

  // Uniform area sampling over the real vector surface: thin feathers get
  // exactly their share of dots and keep the logo's precise contour.
  const samplerMesh = new THREE.Mesh(shape.geometry)
  const sampler = new MeshSurfaceSampler(samplerMesh).build()
  const sampled = new THREE.Vector3()
  const positions = new Float32Array(visualPoints * 3)
  for (let index = 0; index < visualPoints; index++) {
    sampler.sample(sampled)
    const u = THREE.MathUtils.clamp((sampled.x / shape.aspect) * 0.5 + 0.5, 0, 1)
    const v = THREE.MathUtils.clamp(0.5 - sampled.y * 0.5, 0, 1)
    const pixel = (((v * (shape.interiorHeight - 1)) | 0) * shape.interiorWidth
      + ((u * (shape.interiorWidth - 1)) | 0)) * 4 + 3
    const thickness = (shape.interior[pixel] / 255) ** 0.75 * MAX_THICKNESS
    const depth = Math.sign(Math.random() - 0.5) * (1 - Math.random() ** 2)
    positions[index * 3] = sampled.x
    positions[index * 3 + 1] = sampled.y
    positions[index * 3 + 2] = depth * thickness
  }
  shape.geometry.dispose()

  // WebGPU renders THREE.Points strictly at 1 pixel, so the visible bird uses
  // instanced sprites instead: one tiny camera-facing quad per dot — sizable,
  // round (UV discard) and driven by the same node graph.
  const targetAttribute = new THREE.InstancedBufferAttribute(positions, 3)
  const targetPosition = instancedBufferAttribute(targetAttribute) as any
  // Arrival slot straight from the instance id — dots assemble evenly across
  // the load because targets were sampled in random spatial order. Slots span
  // [0, 1-ARRIVAL_SPAN] so the last dot has settled exactly at 100%.
  const seed = float(instanceIndex).add(0.5).div(visualPoints).mul(1 - ARRIVAL_SPAN) as any

  const material = new PointsNodeMaterial()
  material.transparent = true
  material.depthWrite = false
  material.sizeAttenuation = false
  material.sizeNode = float(cfg.pointSizePx)

  const progressUniform = uniform(0)
  // How far (in eagle-local units) the spawn dust scatters — set after the
  // camera mapping is known so the dust covers the whole viewport.
  const spawnSpread = uniform(2.9)

  // Fly-in: each dot spawns at its OWN random screen position and travels a
  // single straight line to its target with one cubic ease-out. The spawn
  // hash must be fully decorrelated between neighbouring indices — dots that
  // start at the same moment (adjacent slots) would otherwise share a spawn
  // area and briefly form little eagle copies mid-flight.
  const flight = clamp(progressUniform.sub(seed).div(ARRIVAL_SPAN), 0, 1)
  const easedFlight = float(1).sub(float(1).sub(flight).pow(3))
  const indexFloat = float(instanceIndex)
  const scatter = (salt: number) => hash(indexFloat.mul(salt).add(salt * 0.618))
  const spawnAngle = scatter(12.9898).mul(Math.PI * 2)
  const spawnRadius = sqrt(scatter(78.233)).mul(spawnSpread)
  const spawnPosition = vec3(
    cos(spawnAngle).mul(spawnRadius),
    sin(spawnAngle).mul(spawnRadius).mul(0.72),
    scatter(37.719).sub(0.5).mul(1.8),
  )
  material.positionNode = mix(spawnPosition, targetPosition, easedFlight)

  // One coherent bottom-to-top gradient across the bird (deep forest → leaf
  // green → soft lime), the point-cloud classic. Round dots via UV discard.
  const deep = new THREE.Color(0x0b4a38).convertSRGBToLinear()
  const leaf = new THREE.Color(0x2e9066).convertSRGBToLinear()
  const lime = new THREE.Color(0xa9d977).convertSRGBToLinear()
  const heightMix = targetPosition.y.mul(0.5).add(0.5)
  const gradient = mix(
    mix(vec3(deep.r, deep.g, deep.b), vec3(leaf.r, leaf.g, leaf.b), smoothstep(float(0), float(0.62), heightMix)),
    vec3(lime.r, lime.g, lime.b),
    smoothstep(float(0.62), float(1), heightMix),
  )
  const twinkle = hash(float(instanceIndex).mul(517.77)).mul(0.24).add(0.88)
  const edgeDistance = (uv() as any).sub(vec2(0.5)).length()
  material.colorNode = Fn(() => {
    If(edgeDistance.greaterThan(0.5), () => Discard())
    // Arriving dust is pale and translucent until it settles.
    return gradient.mul(twinkle).mul(easedFlight.mul(0.55).add(0.45))
  })()
  // Soft round edge: hard-discarded circles shimmer on subpixel motion; a
  // small alpha falloff keeps every dot rock-steady while the pivot sways.
  material.opacityNode = easedFlight.mul(0.5).add(0.5)
    .mul(smoothstep(float(0.5), float(0.34), edgeDistance))

  const sprite = new THREE.Sprite(material as any)
  sprite.count = 0
  sprite.frustumCulled = false
  const pivot = new THREE.Group()
  pivot.add(sprite)
  const scene = new THREE.Scene()
  scene.add(pivot)
  // Perspective + slow sway give the parallax that makes the depth visible.
  const camera = new THREE.PerspectiveCamera(32, shape.aspect, 0.1, 12)
  camera.position.z = 3.6

  // Hidden stress mass: the visible bird is too small to characterise a GPU,
  // so a growing block of points is processed alongside it but placed outside
  // the clip volume — full vertex cost, zero pixels.
  const stressPositions = new Float32Array(maxPoints * 3)
  for (let index = 0; index < maxPoints; index++) {
    stressPositions[index * 3] = 50 + (index % 97) * 0.01
    stressPositions[index * 3 + 1] = (index % 89) * 0.01
    stressPositions[index * 3 + 2] = -5 - (index % 83) * 0.01
  }
  const stressGeometry = new THREE.BufferGeometry()
  stressGeometry.setAttribute('position', new THREE.BufferAttribute(stressPositions, 3))
  stressGeometry.setDrawRange(0, 0)
  const stressMaterial = new PointsNodeMaterial()
  stressMaterial.sizeAttenuation = false
  stressMaterial.sizeNode = float(cfg.pointSizePx)
  const stressPoints = new THREE.Points(stressGeometry, stressMaterial)
  stressPoints.frustumCulled = false
  scene.add(stressPoints)

  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: options.forceWebGL, alpha: true } as any)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  // The canvas spans the whole loader; the assembled bird is anchored onto the
  // DOM logo frame so headline and buttons never sit underneath it — only the
  // arriving dust may cross them.
  const host = canvas.parentElement
  const cssWidth = Math.max(320, host?.clientWidth ?? window.innerWidth)
  const cssHeight = Math.max(240, host?.clientHeight ?? window.innerHeight)
  renderer.setSize(cssWidth, cssHeight)
  camera.aspect = cssWidth / cssHeight
  camera.updateProjectionMatrix()
  renderer.setClearColor(0x000000, 0)
  await renderer.init()

  // The bird must land exactly on the logo frame in the DOM. Fonts and late
  // layout shift that frame during loading, so the anchor is re-measured every
  // frame instead of once at startup (also covers window resizes).
  const frameElement = document.querySelector<HTMLElement>('.loader-eagle-frame')
  // The original logo stays invisible while loading — the eagle only exists
  // once its points have assembled; afterwards it fades in as a soft shadow.
  const ghostElement = document.querySelector<HTMLElement>('.loader-eagle-ghost')
  if (ghostElement) ghostElement.style.opacity = '0'
  let layoutWidth = 0
  let layoutHeight = 0
  function syncLayout(): void {
    const hostWidth = Math.max(320, host?.clientWidth ?? window.innerWidth)
    const hostHeight = Math.max(240, host?.clientHeight ?? window.innerHeight)
    if (hostWidth !== layoutWidth || hostHeight !== layoutHeight) {
      layoutWidth = hostWidth
      layoutHeight = hostHeight
      renderer.setSize(hostWidth, hostHeight)
      camera.aspect = hostWidth / hostHeight
      camera.updateProjectionMatrix()
    }
    const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(16)) * camera.position.z) / hostHeight
    const frameRect = frameElement?.getBoundingClientRect()
    const hostRect = host?.getBoundingClientRect()
    let eagleScale = EAGLE_SCALE
    if (frameRect && hostRect && frameRect.height > 8) {
      // A touch smaller so the silhouette never brushes the headline below.
      eagleScale = (frameRect.height * worldPerPx) / 2 * 0.92
      pivot.position.set(
        (frameRect.left + frameRect.width / 2 - hostRect.left - hostRect.width / 2) * worldPerPx,
        -(frameRect.top + frameRect.height / 2 - hostRect.top - hostRect.height / 2) * worldPerPx,
        0,
      )
    }
    pivot.scale.setScalar(eagleScale)
    spawnSpread.value = (hostWidth * worldPerPx) / (2 * eagleScale)
  }
  syncLayout()

  // Frame-time buckets per density decile: median per bucket is robust
  // against tile-download hitches happening on the main thread.
  const buckets: number[][] = Array.from({ length: DENSITY_BUCKETS + 1 }, () => [])
  let targetProgress = 0
  let pacedProgress = 0
  let stressCount = 0
  let lastFrameAt = 0
  let rafId = 0
  let disposed = false
  let totalSamples = 0
  const startedAt = performance.now()

  const tick = (now: number) => {
    if (disposed) return
    rafId = requestAnimationFrame(tick)
    const seconds = (now - startedAt) * 0.001
    const delta = lastFrameAt > 0 ? Math.min(0.25, (now - lastFrameAt) * 0.001) : 0

    // Time pacing: even a cache-fast load assembles over MIN_ASSEMBLY_SECONDS
    // so the animation can be enjoyed — and every density level gets sampled.
    pacedProgress = Math.min(targetProgress, pacedProgress + delta / MIN_ASSEMBLY_SECONDS)
    progressUniform.value = pacedProgress
    // A dot must become visible the moment its straight flight STARTS (slot
    // reached), never mid-flight or already landed — that reads as popping.
    sprite.count = Math.round(Math.min(1, pacedProgress / (1 - ARRIVAL_SPAN)) * visualPoints)
    stressCount = Math.round(pacedProgress * maxPoints)

    syncLayout()
    // The sway only starts once the bird is fully assembled: rotating the
    // pivot while dust is still far out swings those dots around like atoms.
    const settled = THREE.MathUtils.smoothstep(pacedProgress, 0.985, 1)
    if (ghostElement) ghostElement.style.opacity = (0.12 * settled).toFixed(3)
    if (reducedMotion) {
      pivot.rotation.set(-0.08, 0.22, 0)
    } else {
      // One calm, barely-there drift — anything faster makes the fine dots
      // shimmer against the pixel grid.
      pivot.rotation.y = Math.sin(seconds * 0.16) * 0.07 * settled
      pivot.rotation.x = (-0.04 + Math.sin(seconds * 0.11) * 0.02) * settled
    }
    stressGeometry.setDrawRange(0, stressCount)
    void renderer.renderAsync(scene, camera)
    if (document.visibilityState === 'visible' && lastFrameAt > 0 && stressCount > 0) {
      const frameMs = now - lastFrameAt
      if (frameMs > 1 && frameMs < 250) {
        const bucket = Math.min(DENSITY_BUCKETS, Math.floor((stressCount / maxPoints) * DENSITY_BUCKETS))
        buckets[bucket].push(frameMs)
        if (buckets[bucket].length > 240) buckets[bucket].shift()
        totalSamples++
      }
    }
    lastFrameAt = now
  }
  rafId = requestAnimationFrame(tick)

  function medianOf(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[sorted.length >> 1]
  }

  return {
    setProgress(progress) {
      // 50% loaded = 50% of the final point mass, arriving dots included.
      targetProgress = THREE.MathUtils.clamp(progress, 0, 1)
    },
    result() {
      const targetDelta = 1000 / cfg.targetFps * 1.06 // small tolerance around 60 fps
      let pointsAtTarget = 0
      for (let bucket = 0; bucket <= DENSITY_BUCKETS; bucket++) {
        const samples = buckets[bucket]
        if (samples.length < 8) continue
        const bucketPoints = (bucket / DENSITY_BUCKETS) * maxPoints
        if (medianOf(samples) <= targetDelta) pointsAtTarget = Math.max(pointsAtTarget, bucketPoints)
      }
      let preset: BenchPreset | null = null
      if (totalSamples >= cfg.minSamples) {
        const fraction = pointsAtTarget / maxPoints
        preset = fraction >= cfg.strongFraction
          ? 'strong'
          : fraction >= cfg.mediumFraction ? 'medium' : 'constrained'
      }
      return { pointsAtTarget, maxPoints, samples: totalSamples, preset }
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(rafId)
      material.dispose()
      stressGeometry.dispose()
      stressMaterial.dispose()
      renderer.dispose()
    },
  }
}
