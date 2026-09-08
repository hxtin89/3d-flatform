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
import { installDistanceLod, type NearDetailPolicy } from './distance-lod'
import { EXPERIENCE_CONFIG } from './config'
import { PointHeightProbe, heightPercentile } from './point-height-probe'

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

export interface MemoryBudgetSnapshot {
  maxBytesSize: number
  minBytesSize: number
  maxSize: number
  gpuBytesTarget: number
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
  /** Tiles farther than this (metres) are neither fetched nor drawn; Infinity = off. */
  setDistanceCutoff(cutoffM: number, detailRangeM: number): void
  setNearDetail(policy: NearDetailPolicy | null): void
  /** Scale CPU cache and GPU residency to the measured device tier. Small
   * budgets on strong hardware cause unload thrashing: every camera move
   * evicts tiles that immediately have to be re-fetched. */
  setMemoryBudget(cacheMaxBytes: number, gpuBytesTarget: number): void
  /** Exact cache/GPU values for snapshot & restore (compare mode) — the
   * regular setter above is intentionally monotonic and cannot restore. */
  getMemoryBudget(): MemoryBudgetSnapshot
  setMemoryBudgetExact(budget: MemoryBudgetSnapshot): void
  /** Diagnostic A/B: CPU-computed (float64) vs in-shader (float32) model-view
   * matrices. Off makes the ECEF rounding jitter visible again. */
  setHighPrecision(enabled: boolean): void
  /** Restrict loading/refinement/rendering to a world-space sphere (null = off). */
  setMaskSphere(centerWorld: THREE.Vector3 | null, radius: number): void
  /** Ground and canopy height under a footprint, from the resident tiles.
   * Null until enough points are loaded there. See sampleGroundZ() below for
   * why this is a statistic and not a raycast. */
  sampleGroundZ(centreEnu: THREE.Vector2, radiusM: number, enuInverse: THREE.Matrix4): GroundSample | null
  stats(): StreamingStats
  dispose(): void
}

export interface GroundSample {
  /** Low percentile of point height — the forest floor, in raw ENU metres. */
  groundZ: number
  /** High percentile — the canopy top. */
  canopyZ: number
  samples: number
  /** Occupied cells of the 5×5 support grid; low values mean a thin sample. */
  support: number
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
  // Parsing and node processing are deliberately serialised: with two parses in
  // flight, four tiles regularly landed in the same frame and their uploads
  // stacked into one 60 ms hitch. One at a time costs a little latency and
  // removes the pile-up.
  maxParses: 1,
  maxProcesses: 1,
  maxTilesProcessed: 1,
}

export function createStreamingCloud(opts: {
  tilesetUrl: string
  camera: THREE.PerspectiveCamera
  renderer: any
  /** ECEF-anchored parent — the floating-origin root, not the raw scene. */
  scene: THREE.Object3D
  uniforms: CloudUniforms
  errorTarget?: number
  limits?: Partial<StreamingLimits>
  debugVolume?: boolean
  /** The Adaptive Point Hierarchy is one continuous quadtree without request
   * volumes or density bands, so the One-LOD-Tree machinery must stay out of it. */
  requestVolumes?: boolean
  /** The root tileset itself was unreachable (404/403) — this cloud will stay empty. */
  onRootError?: (url: string, error: unknown) => void
}): StreamingCloud {
  const { tilesetUrl, camera, renderer, scene, uniforms, errorTarget = 256 } = opts
  const useRequestVolumes = opts.requestVolumes !== false
  const limits = { ...DEFAULT_LIMITS, ...opts.limits }

  const tiles = new TilesRenderer(tilesetUrl)
  // dispose() aborts every *tile* fetch through the renderer's own per-tile
  // controllers, but the root tileset request uses fetchOptions verbatim. Without
  // this signal a swapped-away renderer still resolves its root and fires events.
  const lifecycle = new AbortController()
  tiles.fetchOptions = { ...tiles.fetchOptions, signal: lifecycle.signal }
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

  const distanceLod = installDistanceLod(tiles)

  const unloadPlugin = new UnloadTilesPlugin({
    delay: 350,
    bytesTarget: limits.gpuBytesTarget,
  })
  tiles.registerPlugin(unloadPlugin as any)

  const tileStats = new WeakMap<object, { points: number; density: DensityBand }>()
  const failedTiles = new Set<string>()
  const pendingMaterials: Array<{ mesh: THREE.Mesh; tile: any; model: THREE.Object3D }> = []
  let compilingMaterial = false
  let disposed = false

  function warmNextMaterial(): void {
    if (compilingMaterial || disposed) return
    for (let i = pendingMaterials.length - 1; i >= 0; i--) {
      const pending = pendingMaterials[i]
      if (pending.tile.engineData?.scene !== pending.model) pendingMaterials.splice(i, 1)
    }
    const index = pendingMaterials.findIndex(pending => tiles.visibleTiles.has(pending.tile))
    if (index < 0) return
    const [next] = pendingMaterials.splice(index, 1)
    const { mesh, tile, model } = next
    if (tile.engineData?.scene !== model) return
    let targetScene: THREE.Object3D = scene
    while (targetScene.parent) targetScene = targetScene.parent
    compilingMaterial = true
    // compileAsync accepts an individual object and builds its nodes in yielding
    // stages. Keep the ADD ancestors visible while this new residual is prepared.
    // The brief visible=true is synchronous; no draw can interleave with it.
    mesh.visible = true
    const ready = renderer.compileAsync(mesh, camera, targetScene)
    mesh.visible = false
    void ready.catch((error: unknown) => console.warn('[streaming] shader warmup failed', error))
      .finally(() => {
        compilingMaterial = false
        if (disposed || tile.engineData?.scene !== model) {
          mesh.geometry.dispose()
          ;(mesh.material as THREE.Material).dispose()
        } else if (!tiles.visibleTiles.has(tile)) {
          // A move may hide the tile while compilation yields. Release those
          // uploads too, and prepare it again if it comes back into view.
          mesh.geometry.dispose()
          ;(mesh.material as THREE.Material).dispose()
          pendingMaterials.push(next)
        } else mesh.visible = true
      })
  }

  const probes = new WeakMap<THREE.Points, PointHeightProbe>()
  const probeMatrix = new THREE.Matrix4()
  function prepareProbe(object: THREE.Points, enuInverse: THREE.Matrix4, onlyMissing = false) {
    object.updateWorldMatrix(true, false)
    probeMatrix.multiplyMatrices(enuInverse, object.matrixWorld)
    const current = probes.get(object)
    if (current?.matches(probeMatrix)) return onlyMissing ? null : current
    const attribute = object.geometry.getAttribute('position')
    if (!attribute?.count) return null
    const probe = new PointHeightProbe(attribute, probeMatrix, EXPERIENCE_CONFIG.donationShape.probeMaxSamplesPerTile)
    probes.set(object, probe)
    return probe
  }

  // Camera-facing quads give the round fragment cutout its smallest footprint.
  const POINT_CORNERS = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0])
  const POINT_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])

  /** Rebuild one loaded THREE.Points tile as instanced sprites. Returns null when
   * the tile carries no usable position buffer. */
  function buildPointSprites(source: THREE.Points): THREE.Mesh | null {
    const position = source.geometry?.getAttribute('position')
    if (!position) return null
    const color = source.geometry.getAttribute('color')

    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(POINT_CORNERS, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(POINT_UVS, 2))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
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
      const mesh = buildPointSprites(source)
      if (!mesh) continue

      // TilesRenderer collected the tile's geometries and materials during
      // parseTile, which runs before this event fires, so anything created here
      // has to be registered for disposal by hand or it leaks on unload.
      const engineData = tile?.engineData
      if (Array.isArray(engineData?.geometry)) engineData.geometry.push(mesh.geometry)
      if (Array.isArray(engineData?.materials)) engineData.materials.push(mesh.material)

      // The sprites hang under the original Points rather than replacing it: the
      // PNTS loader hands back that Points object *as* the tile root, so at this
      // point it still has no parent to swap it out of. Parenting also inherits
      // the tile transform for free. The carrier itself draws nothing.
      source.add(mesh)
      if (typeof renderer.compileAsync === 'function') {
        mesh.visible = false
        pendingMaterials.push({ mesh, tile, model })
      }
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
  tiles.addEventListener('load-error', ({ tile, url, error }: any) => {
    // A null tile means the *root* tileset failed — the whole pack is unreachable,
    // not one gap, so the caller gets to pick a different source.
    if (tile == null) { opts.onRootError?.(String(url ?? ''), error); return }
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
      warmNextMaterial()
      // Prepare at most one visible tile per frame, after its full transform is
      // attached. Normal pointer presses then use the small spatial index.
      let prepared = false
      for (const tile of tiles.visibleTiles) {
        const model = (tile as any).engineData?.scene
        model?.traverse((object: THREE.Points) => {
          if (!prepared && object.isPoints) prepared = !!prepareProbe(object, uniforms.enuInverse.value, true)
        })
        if (prepared) break
      }
    },
    setErrorTarget(value: number) {
      tiles.errorTarget = value
    },
    setDensityCeiling(level: number) {
      requestVolumePlugin?.setDensityCeiling(level)
    },
    setDistanceCutoff(cutoffM: number, detailRangeM: number) {
      distanceLod.setCutoff(cutoffM, detailRangeM)
    },
    setNearDetail(policy) { distanceLod.setNearDetail(policy) },
    setMemoryBudget(cacheMaxBytes: number, gpuBytesTarget: number) {
      tiles.lruCache.maxBytesSize = cacheMaxBytes
      tiles.lruCache.minBytesSize = Math.min(tiles.lruCache.minBytesSize, cacheMaxBytes)
      tiles.lruCache.maxSize = Math.max(tiles.lruCache.maxSize, Math.round(cacheMaxBytes / (600 * 1024)))
      ;(unloadPlugin as any).bytesTarget = gpuBytesTarget
    },
    getMemoryBudget() {
      return {
        maxBytesSize: tiles.lruCache.maxBytesSize,
        minBytesSize: tiles.lruCache.minBytesSize,
        maxSize: tiles.lruCache.maxSize,
        gpuBytesTarget: (unloadPlugin as any).bytesTarget as number,
      }
    },
    setMemoryBudgetExact(budget: MemoryBudgetSnapshot) {
      // setMemoryBudget() only ever grows maxSize / shrinks minBytesSize, so a
      // snapshot restore (compare mode off) needs plain assignment.
      tiles.lruCache.maxBytesSize = budget.maxBytesSize
      tiles.lruCache.minBytesSize = budget.minBytesSize
      tiles.lruCache.maxSize = budget.maxSize
      ;(unloadPlugin as any).bytesTarget = budget.gpuBytesTarget
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
    sampleGroundZ(centreEnu: THREE.Vector2, radiusM: number, enuInverse: THREE.Matrix4) {
      // The carrier Points draws zero vertices, so a regular raycast sees
      // nothing. Query its indexed sample once; its sprite child shares the same
      // buffer and must not be counted again.
      if (!(radiusM > 0)) return null
      const heights: number[] = []
      const support = new Uint8Array(25)
      for (const tile of tiles.visibleTiles) {
        const tileScene = (tile as any)?.engineData?.scene
        tileScene?.traverse((object: THREE.Points) => {
          if (!object.isPoints) return
          prepareProbe(object, enuInverse)?.collect(centreEnu.x, centreEnu.y, radiusM, heights, support)
        })
      }
      if (heights.length < EXPERIENCE_CONFIG.donationShape.probeMinSamples) return null
      const at = (fraction: number) => heightPercentile(heights, fraction)
      let occupied = 0
      for (const cell of support) occupied += cell
      return {
        groundZ: at(EXPERIENCE_CONFIG.donationShape.probeGroundPercentile),
        canopyZ: at(EXPERIENCE_CONFIG.donationShape.probeCanopyPercentile),
        samples: heights.length,
        support: occupied,
      }
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
        progress: Math.min(tiles.loadProgress,
          compilingMaterial || pendingMaterials.some(pending => tiles.visibleTiles.has(pending.tile)) ? 0.99 : 1),
        density,
        cacheBytes: (tiles.lruCache as any).cachedBytes ?? 0,
        gpuBytes: (unloadPlugin as any).estimatedGpuBytes ?? 0,
      }
    },
    dispose() {
      disposed = true
      pendingMaterials.length = 0
      scene.remove(tiles.group)
      tiles.dispose()
      lifecycle.abort()
    },
  }
}
