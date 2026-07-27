// Single-tree point-cloud streaming. The One LOD Tree links p02 -> p10 -> p100
// through external 3D Tiles documents, so one TilesRenderer owns traversal,
// requests, CPU cache and GPU residency for every density.
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer'
import { LoadRegionPlugin, SphereRegion, UnloadTilesPlugin } from '3d-tiles-renderer/plugins'
import {
  applyMatrixPrecision, createCloudMaterial, setHighPrecisionMatrices,
  POINT_COLOR_ATTRIBUTE, POINT_POSITION_ATTRIBUTE, type CloudUniforms,
} from './point-cloud'
import { denserBand, densityBandForUri, type DensityBand } from './adaptive-quality'
import { ViewerRequestVolumePlugin } from './viewer-request-volume'
import { EXPERIENCE_CONFIG } from './config'

export interface StreamingStats {
  visible: number
  points: number
  progress: number
  density: DensityBand
  cacheBytes: number
  gpuBytes: number
  /** Distinct tiles the server never returned — gaps in the published data. */
  missingTiles: number
}

export interface StreamingCloud {
  tiles: TilesRenderer
  group: THREE.Object3D
  /** Diagnostics only. */
  debugVolume: { blockedByCeiling: number[]; inside: number[]; outside: number[]; noVolume: number[] }
  update(): void
  setErrorTarget(v: number): void
  /** 0 = p02, 1 = p10, 2 = p100. */
  setDensityCeiling(level: number): void
  /** Scale CPU cache and GPU residency to the measured device tier. Small
   * budgets on strong hardware cause unload thrashing: every camera move
   * evicts tiles that immediately have to be re-fetched. */
  setMemoryBudget(cacheMaxBytes: number, gpuBytesTarget: number): void
  /** Diagnostic A/B: CPU-computed (float64) vs in-shader (float32) model-view
   * matrices. Off makes the ECEF rounding jitter visible again. */
  setHighPrecision(enabled: boolean): void
  /** Restrict loading/refinement/rendering to a world-space sphere (null = off). */
  setMaskSphere(centerWorld: THREE.Vector3 | null, radius: number): void
  stats(): StreamingStats
  dispose(): void
}

export interface StreamingLimits {
  cacheMinTiles: number
  cacheMaxTiles: number
  cacheMinBytes: number
  cacheMaxBytes: number
  gpuBytesTarget: number
  maxDownloads: number
  maxParses: number
  maxProcesses: number
  maxTilesProcessed: number
}

const MIB = 1024 * 1024

const DEFAULT_LIMITS: StreamingLimits = {
  cacheMinTiles: 48,
  cacheMaxTiles: 160,
  cacheMinBytes: 48 * MIB,
  cacheMaxBytes: 96 * MIB,
  gpuBytesTarget: 64 * MIB,
  maxDownloads: 6,
  maxParses: 2,
  maxProcesses: 4,
  maxTilesProcessed: 120,
}

export function createStreamingCloud(opts: {
  tilesetUrl: string
  camera: THREE.PerspectiveCamera
  renderer: any
  scene: THREE.Scene
  uniforms: CloudUniforms
  errorTarget?: number
  limits?: Partial<StreamingLimits>
  debugVolume?: boolean
  /** The Adaptive Point Hierarchy is one continuous quadtree without request
   * volumes or density bands, so the One-LOD-Tree machinery must stay out of it. */
  requestVolumes?: boolean
}): StreamingCloud {
  const { tilesetUrl, camera, renderer, scene, uniforms, errorTarget = 256 } = opts
  const useRequestVolumes = opts.requestVolumes !== false
  const limits = { ...DEFAULT_LIMITS, ...opts.limits }

  const tiles = new TilesRenderer(tilesetUrl)
  tiles.errorTarget = errorTarget
  tiles.lruCache.minSize = limits.cacheMinTiles
  tiles.lruCache.maxSize = limits.cacheMaxTiles
  tiles.lruCache.minBytesSize = limits.cacheMinBytes
  tiles.lruCache.maxBytesSize = limits.cacheMaxBytes
  tiles.downloadQueue.maxJobs = limits.maxDownloads
  tiles.parseQueue.maxJobs = limits.maxParses
  tiles.processNodeQueue.maxJobs = limits.maxProcesses
  tiles.maxTilesProcessed = limits.maxTilesProcessed
  tiles.setCamera(camera)
  tiles.setResolutionFromRenderer(camera, renderer)

  // The current 3DTilesRendererJS release ignores viewerRequestVolume. Without
  // this plugin p10 and p100 may refine together, defeating the One LOD Tree.
  // The APH tilesets ship as `tileset-no-vrv.json` and carry none, so the plugin
  // would only add traversal cost there.
  const requestVolumePlugin = useRequestVolumes
    ? new ViewerRequestVolumePlugin({
      xyScale: EXPERIENCE_CONFIG.lod.requestVolumeXyScale,
      debug: opts.debugVolume,
    })
    : null
  if (requestVolumePlugin) tiles.registerPlugin(requestVolumePlugin as any)

  // Real mask culling: outside tiles are not fetched, refined or rendered.
  class FrustumMaskRegion extends SphereRegion {
    intersectsTile(boundingVolume: any, _tile?: any, tilesRenderer?: any): boolean {
      if (!boundingVolume.intersectsSphere(this.sphere)) return false
      const info = tilesRenderer?.cameraInfo
      if (!info || info.length === 0) return true
      for (let i = 0; i < info.length; i++) {
        if (boundingVolume.intersectsFrustum(info[i].frustum)) return true
      }
      return false
    }
  }

  const regionPlugin = new LoadRegionPlugin()
  const maskRegion = new FrustumMaskRegion({ mask: true, errorTarget })
  maskRegion.calculateError = () => 0
  let maskActive = false
  tiles.registerPlugin(regionPlugin as any)

  const unloadPlugin = new UnloadTilesPlugin({
    delay: 350,
    bytesTarget: limits.gpuBytesTarget,
  })
  tiles.registerPlugin(unloadPlugin as any)

  const tileStats = new WeakMap<object, { points: number; density: DensityBand }>()
  const failedTiles = new Set<string>()

  // One camera-facing quad per point, instanced. The corner offsets live in the
  // `position` attribute because that is what PointsNodeMaterial's sprite path
  // scales by the point size; `uv` gives the round-dot cutout.
  const QUAD_CORNERS = new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ])
  const QUAD_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
  const QUAD_INDICES = [0, 1, 2, 0, 2, 3]

  /** Rebuild one loaded THREE.Points tile as instanced quads. Returns null when
   * the tile carries no usable position buffer. */
  function buildPointQuads(source: THREE.Points): THREE.Mesh | null {
    const position = source.geometry?.getAttribute('position')
    if (!position) return null
    const color = source.geometry.getAttribute('color')

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(QUAD_CORNERS, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(QUAD_UVS, 2))
    geometry.setIndex(QUAD_INDICES)
    // The tile's own buffers are reused as-is — no copy, no format conversion.
    // PNTS colours arrive as normalised Uint8, which TSL resolves to a float
    // vector via NodeBuilder.getTypeFromAttribute.
    geometry.setAttribute(POINT_POSITION_ATTRIBUTE, new THREE.InstancedBufferAttribute(
      position.array, position.itemSize, position.normalized,
    ))
    if (color) {
      geometry.setAttribute(POINT_COLOR_ATTRIBUTE, new THREE.InstancedBufferAttribute(
        color.array, color.itemSize, color.normalized,
      ))
    }
    geometry.instanceCount = position.count

    const mesh = new THREE.Mesh(geometry, createCloudMaterial(uniforms, color?.itemSize ?? 3))
    // A Mesh, not a Sprite: WebGPUUtils.getPrimitiveTopology only names a
    // topology for isMesh, and Mesh avoids Sprite's own culling and raycasting.
    mesh.frustumCulled = false // tile-level culling is handled by TilesRenderer
    return mesh
  }

  // Materials must be tile-owned. A shared material is unsafe with
  // UnloadTilesPlugin because hiding one tile disposes its material and would
  // invalidate every other tile that shared the same instance.
  tiles.addEventListener('load-model', ({ scene: model, tile, url }: any) => {
    let points = 0
    const sources: THREE.Points[] = []
    model.traverse((object: any) => {
      if (object.isPoints) sources.push(object)
    })
    for (const source of sources) {
      points += source.geometry?.getAttribute('position')?.count ?? 0
      const mesh = buildPointQuads(source)
      if (!mesh) continue

      // TilesRenderer collected the tile's geometries and materials during
      // parseTile, which runs before this event fires, so anything created here
      // has to be registered for disposal by hand or it leaks on unload.
      const engineData = tile?.engineData
      if (Array.isArray(engineData?.geometry)) engineData.geometry.push(mesh.geometry)
      if (Array.isArray(engineData?.materials)) engineData.materials.push(mesh.material)

      // The quads hang under the original Points rather than replacing it: the
      // PNTS loader hands back that Points object *as* the tile root, so at this
      // point it still has no parent to swap it out of. Parenting also inherits
      // the tile transform for free. The carrier itself draws nothing.
      source.add(mesh)
      source.geometry.setDrawRange(0, 0)
      if (Array.isArray(source.material)) source.material.forEach((material: any) => material?.dispose?.())
      else (source.material as any)?.dispose?.()
    }
    const source = `${url ?? ''} ${tile?.content?.uri ?? ''} ${tile?.internal?.basePath ?? ''}`
    tileStats.set(tile, { points, density: densityBandForUri(source) })
  })
  tiles.addEventListener('dispose-model', ({ tile }: any) => tileStats.delete(tile))
  // A missing tile is a gap in the published data, not a crash, and the
  // renderer retries whenever it comes back into view. Report each URL once so
  // one absent tile cannot bury the console, but leave the retries alone: the
  // file may well appear after the next upload.
  tiles.addEventListener('load-error', ({ url, error }: any) => {
    const key = String(url ?? '')
    if (failedTiles.has(key)) return
    failedTiles.add(key)
    console.warn(`[streaming] tile unavailable (${failedTiles.size} so far)`, key, error?.message)
  })

  scene.add(tiles.group)

  return {
    tiles,
    group: tiles.group,
    debugVolume: requestVolumePlugin?.debugCounts
      ?? { blockedByCeiling: [], inside: [], outside: [], noVolume: [] },
    update() {
      tiles.update()
    },
    setErrorTarget(value: number) {
      tiles.errorTarget = value
    },
    setDensityCeiling(level: number) {
      requestVolumePlugin?.setDensityCeiling(level)
    },
    setMemoryBudget(cacheMaxBytes: number, gpuBytesTarget: number) {
      tiles.lruCache.maxBytesSize = cacheMaxBytes
      tiles.lruCache.minBytesSize = Math.min(tiles.lruCache.minBytesSize, cacheMaxBytes)
      tiles.lruCache.maxSize = Math.max(tiles.lruCache.maxSize, Math.round(cacheMaxBytes / (600 * 1024)))
      ;(unloadPlugin as any).bytesTarget = gpuBytesTarget
    },
    setHighPrecision(enabled: boolean) {
      setHighPrecisionMatrices(enabled)
      // The scene graph is the registry — every live tile material hangs under
      // the tiles group, and UnloadTilesPlugin keeps disposing them itself.
      tiles.group.traverse((object: any) => applyMatrixPrecision(object.material))
    },
    setMaskSphere(centerWorld: THREE.Vector3 | null, radius: number) {
      if (!centerWorld || !(radius > 0)) {
        if (maskActive) { regionPlugin.removeRegion(maskRegion); maskActive = false }
        return
      }
      if (!maskActive) { regionPlugin.addRegion(maskRegion); maskActive = true }
      tiles.group.updateWorldMatrix(true, false)
      maskRegion.sphere.center.copy(centerWorld)
      tiles.group.worldToLocal(maskRegion.sphere.center)
      maskRegion.sphere.radius = radius
    },
    stats() {
      let points = 0
      let density: DensityBand = 'Overview p02'
      for (const tile of tiles.visibleTiles) {
        const stats = tileStats.get(tile)
        if (!stats) continue
        points += stats.points
        density = denserBand(density, stats.density)
      }
      return {
        visible: tiles.visibleTiles.size,
        points,
        missingTiles: failedTiles.size,
        progress: tiles.loadProgress,
        density,
        cacheBytes: (tiles.lruCache as any).cachedBytes ?? 0,
        gpuBytes: (unloadPlugin as any).estimatedGpuBytes ?? 0,
      }
    },
    dispose() {
      scene.remove(tiles.group)
      tiles.dispose()
    },
  }
}
