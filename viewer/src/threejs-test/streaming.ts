// Single-tree point-cloud streaming. The One LOD Tree links p02 -> p10 -> p100
// through external 3D Tiles documents, so one TilesRenderer owns traversal,
// requests, CPU cache and GPU residency for every density.
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer'
import { LoadRegionPlugin, SphereRegion, UnloadTilesPlugin } from '3d-tiles-renderer/plugins'
import {
  applyMatrixPrecision, createCloudMaterial, setHighPrecisionMatrices, rebuildEffectMaterial,
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
  /**
   * Size each tile's points from that tile's own spacing, so a coarse tile and a
   * refined one blend instead of meeting along a visible rectangle.
   *
   * The size is in metres and sizeAttenuation does the projection, so `scale` is just
   * the user's fatness preference. Called every frame because the stack changes as
   * tiles refine, not because the camera moves.
   */
  applyPerTileSize(opts: { scale: number; fill: number }): void
  /** Rebuild loaded tile shaders after an effect switch — see setCloudEffectEnabled. */
  refreshEffects(): void
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

// Reused by the ground probe so a per-frame sample allocates nothing.
const scratchMatrix = new THREE.Matrix4()
const scratchVector = new THREE.Vector3()

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
  /**
   * Called once per loaded point tile, with the object that carries its positions.
   * The ground-patch mask uses it to accumulate coverage from the same tiles the
   * renderer was going to download anyway — see ground-patch-mask.
   */
  onPointTile?: (object: THREE.Object3D) => void
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

  // Reused every frame by applyPerTileSize so the per-frame pass allocates nothing.
  interface SizeEntry { object: any; size: any; spacing: number; effective: number }
  const sizeEntries: SizeEntry[] = []
  const sizeByTile = new Map<object, SizeEntry>()

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
  function buildPointQuads(source: THREE.Points, tile: any): THREE.Mesh | null {
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

    // Mean horizontal point spacing, the same quantity the pipeline puts in
    // geometricError: sqrt(footprint area / points). Taken from the tile's own
    // geometry because the tileset's leaves carry geometricError 0 by construction,
    // so the published value cannot size the finest tiles.
    source.geometry.computeBoundingBox()
    const box = source.geometry.boundingBox
    let spacingM = 0
    const centre = new THREE.Vector3()
    if (box) {
      box.getCenter(centre)
      const area = Math.max((box.max.x - box.min.x) * (box.max.y - box.min.y), 1e-6)
      spacingM = Math.sqrt(area / Math.max(1, position.count))
    }

    const mesh = new THREE.Mesh(geometry, createCloudMaterial(uniforms, color?.itemSize ?? 3))
    mesh.userData.spacingM = spacingM
    // Needed to find the tile's place in the tree — the size depends on the whole
    // stack at a location, not on this tile alone. See applyPerTileSize.
    mesh.userData.tile = tile
    // The instanced geometry's own bounds describe the unit quad, not the points, so
    // the centre has to be carried over from the source geometry.
    mesh.userData.localCentre = centre
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
      // Before setDrawRange(0, 0) below parks the carrier — the positions stay
      // readable either way, but taking the tile here keeps the handoff obvious.
      opts.onPointTile?.(source)
      const mesh = buildPointQuads(source, tile)
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
    refreshEffects() {
      // Same registry as setHighPrecision: the scene graph holds every live tile
      // material, and UnloadTilesPlugin keeps disposing them itself.
      tiles.group.traverse((object: any) => rebuildEffectMaterial(object.material))
    },
    applyPerTileSize({ scale, fill }) {
      // Refinement is ADD, so tiles do not replace their parents — they stack. Measured
      // in one view, fourteen tiles covered the same ground, with own spacings from
      // 0.13 m to 7.3 m. The density you see there is the sum of all of them, so the
      // spacing that matters is the *finest* one present, not each tile's own.
      //
      // Sizing by a tile's own spacing was wrong for that reason: the coarse members got
      // fat dots over ground the fine ones had already filled, so they blotted over the
      // detail, and the mismatch was worst where refinement depth changes — along tile
      // boundaries, the artifact this is meant to remove.
      //
      // Descendants sit strictly inside their ancestors in a quadtree, so propagating
      // each spacing up the parent chain gives every tile the finest spacing over its
      // own footprint.
      sizeEntries.length = 0
      sizeByTile.clear()
      tiles.group.traverse((object: any) => {
        const size = object.material?.userData?.pointSizeUniform
        if (!size) return
        const spacing = object.userData?.spacingM
        const entry = { object, size, spacing: spacing || 0, effective: spacing || 0 }
        sizeEntries.push(entry)
        if (object.userData?.tile) sizeByTile.set(object.userData.tile, entry)
      })
      for (const entry of sizeEntries) {
        if (!entry.spacing) continue
        let node = entry.object.userData?.tile?.parent
        while (node) {
          const ancestor = sizeByTile.get(node)
          if (ancestor && entry.spacing < ancestor.effective) ancestor.effective = entry.spacing
          node = node.parent
        }
      }
      // Metres, not pixels: sizeAttenuation projects per point, so there is no distance
      // to take here and a tile keeps one honest size across its whole extent.
      for (const entry of sizeEntries) {
        const wanted = (entry.effective || EXPERIENCE_CONFIG.lod.perTilePointSizeMinM) * fill * scale
        entry.size.value = THREE.MathUtils.clamp(
          wanted,
          EXPERIENCE_CONFIG.lod.perTilePointSizeMinM,
          EXPERIENCE_CONFIG.lod.perTilePointSizeMaxM,
        )
      }
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
      // Deliberately not a raycast. The load-model handler above parks every
      // carrier Points at drawRange 0 and hangs instanced quads underneath, so
      // THREE.Points.raycast clamps its loop to zero vertices and the instanced
      // child only carries four corner offsets in `position` — a raycast here
      // finds nothing, silently, whatever threshold it is given. The raw tile
      // positions do survive, as the instanced attribute the quads read, so we
      // sample those directly.
      const heights: number[] = []
      // 5×5 support grid: a candidate height backed by one corner of the
      // footprint is noise, not ground.
      const support = new Uint8Array(25)
      const local = scratchMatrix
      const point = scratchVector

      for (const tile of tiles.visibleTiles) {
        const tileScene = (tile as any)?.engineData?.scene
        if (!tileScene) continue
        tileScene.traverse((object: any) => {
          const attribute = object.geometry?.getAttribute?.(POINT_POSITION_ATTRIBUTE)
            ?? (object.isPoints ? object.geometry?.getAttribute?.('position') : null)
          if (!attribute || attribute.count === 0) return
          object.updateWorldMatrix(true, false)
          local.multiplyMatrices(enuInverse, object.matrixWorld)

          // Cheap reject: the tile's bounds in ENU versus the footprint disc.
          const geometry = object.geometry
          if (!geometry.boundingSphere) geometry.computeBoundingSphere()
          const bounds = geometry.boundingSphere
          if (bounds) {
            point.copy(bounds.center).applyMatrix4(local)
            // The instanced quads keep their bounds around the 4 corner offsets,
            // so only a real point bound (radius over a metre) can be trusted.
            if (bounds.radius > 1) {
              const dx = point.x - centreEnu.x
              const dy = point.y - centreEnu.y
              if (Math.hypot(dx, dy) > radiusM + bounds.radius) return
            }
          }

          const limit = EXPERIENCE_CONFIG.donationShape.probeMaxSamplesPerTile
          const stride = Math.max(1, Math.floor(attribute.count / limit))
          for (let index = 0; index < attribute.count; index += stride) {
            point.set(attribute.getX(index), attribute.getY(index), attribute.getZ(index))
            point.applyMatrix4(local)
            const dx = point.x - centreEnu.x
            const dy = point.y - centreEnu.y
            if (Math.abs(dx) > radiusM || Math.abs(dy) > radiusM) continue
            heights.push(point.z)
            const column = Math.min(4, Math.max(0, Math.floor(((dx / radiusM) + 1) * 2.5)))
            const row = Math.min(4, Math.max(0, Math.floor(((dy / radiusM) + 1) * 2.5)))
            support[row * 5 + column] = 1
          }
        })
      }

      if (heights.length < EXPERIENCE_CONFIG.donationShape.probeMinSamples) return null
      heights.sort((a, b) => a - b)
      const at = (fraction: number): number =>
        heights[Math.min(heights.length - 1, Math.max(0, Math.floor(heights.length * fraction)))]
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
