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
import {
  denserBand, densityBandForUri, densityLevel, densityLevelColor, type DensityBand,
} from './density-band'
import { ViewerRequestVolumePlugin } from './viewer-request-volume'
import { EXPERIENCE_CONFIG } from './config'

export interface StreamingStats {
  visible: number
  points: number
  progress: number
  density: DensityBand
  cacheBytes: number
  gpuBytes: number
  /** Tiles held in the CPU cache — not just the visible ones. */
  cacheTiles: number
  /** The two floors eviction drains to. Whichever the cache is sitting *on* is the
   * limit currently paying for a re-download every time the camera turns; the other
   * one is slack. Reported so that is readable off the HUD instead of the console. */
  cacheTilesFloor: number
  cacheBytesFloor: number
  /**
   * The ceilings, which are the limits with a *visible* failure mode: once the cache is
   * full the renderer stops queueing downloads, and the ground keeps its holes. The
   * floors above only decide how much of the off-screen working set survives a turn.
   */
  cacheTilesCeiling: number
  cacheBytesCeiling: number
  /** Distinct tiles the server never returned — gaps in the published data. */
  missingTiles: number
  /**
   * Where refinement *stopped*, counted per density level, coarsest first — and how
   * many of those stops are leaves the pipeline wrote with `geometricError: 0`, which
   * can never refine however close the camera gets.
   *
   * Only terminal tiles are counted, and that restriction is the whole point. `refine:
   * ADD` draws every ancestor along with its children, so a frame refined uniformly to
   * d6 still *contains* d0…d5 — counting all visible tiles per level reports a
   * seven-level jumble in a perfectly uniform view. What produces a visible hard edge
   * is two neighbouring places that stopped at different depths, and only the terminal
   * set shows that.
   *
   * Reading it: one level means the frame is uniform. Two or more means the refine
   * threshold falls inside the frame, so there is a contour across it. A single level
   * alongside terminal leaves means the step is in the data rather than the metric — a
   * clearing has too few returns to subdivide, so its node stops early and stays
   * coarser than the canopy beside it at every altitude.
   */
  terminalLevels: { band: DensityBand; tiles: number; points: number }[]
  /** Terminal tiles that are leaves, i.e. stops the error target can never move. */
  leafTiles: number
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
  /** Diagnostic mode: no mask gate and large resident/worker limits so every
   * APH leaf selected by the camera frustum can finish loading. */
  setLeafLoading(enabled: boolean): void
  /** 0 = p02, 1 = p10, 2 = p100. */
  setDensityCeiling(level: number): void
  /** Push this frame's traversal error and stopped-here flag into the visible tiles'
   *  materials, for the false-colour inspector. A no-op while it is switched off. */
  updateDebugTiles(active: boolean): void
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
  /** Rebuild loaded tile shaders after an effect switch — see setCloudEffectEnabled. */
  refreshEffects(): void
  /** Restrict loading/refinement/rendering to a world-space sphere (null = off). */
  setMaskSphere(centerWorld: THREE.Vector3 | null, radius: number): void
  /** Ground and canopy height under a footprint, from the resident tiles.
   * Null until enough points are loaded there. See sampleGroundZ() below for
   * why this is a statistic and not a raycast. */
  sampleGroundZ(centreEnu: THREE.Vector2, radiusM: number, enuInverse: THREE.Matrix4): GroundSample | null
  stats(): StreamingStats
  /**
   * Pixels the drawn quads cover this frame, summed over every visible tile, with the
   * point count those pixels belong to.
   *
   * `diameterPx` is handed one tile's own point spacing and the view depth to its
   * centre, and returns the diameter that tile draws at. The caller owns that formula
   * because it is the CPU mirror of the `sizeNode` expression in point-cloud.ts — the two
   * have to move together or the readout quietly measures a size the shader is not using,
   * which is exactly the state this replaced.
   *
   * The area counted is the **quad**, not the round dot inside it. Every fragment of
   * the quad is rasterised and shaded; the circle is a Discard in the colour node, which
   * runs afterwards. So this is fragments shaded — what it costs — rather than pixels
   * lit, which is what shows.
   *
   * `points` is returned rather than taken from `stats()` because the two sets differ:
   * tiles wholly behind the camera are excluded here, and dividing a partial area by a
   * total point count would report dots that had shrunk.
   */
  shadedPixelArea(
    diameterPx: (spacingM: number, viewDepthM: number) => number,
  ): { areaPx: number; points: number }
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
// Reused by tileSpacingMetres, which runs once per loaded tile.
const spacingBox = new THREE.Box3()
const spacingObb = new THREE.Matrix4()
const spacingSize = new THREE.Vector3()

// Reused by shadedPixelArea, which runs once per visible tile per frame.
const coverCentre = new THREE.Vector3()
const coverForward = new THREE.Vector3()

/**
 * This tile's own mean point spacing in metres — what the drawn point size is
 * derived from (see createCloudMaterial).
 *
 * Internal APH nodes carry it, but scaled: the pipeline writes `geometricError =
 * errorScale * sqrt(footprint area / point count)`, and errorScale is 2 in every
 * published pack, so the factor has to come back out here. Leaves are written with
 * `geometricError: 0` so they can never refine further, so for those the footprint
 * is measured instead — and a leaf's bounding volume *is* its content bounds, since
 * it has no children to union in.
 *
 * Both routes therefore return the same quantity. They used to disagree by exactly
 * `errorScale`: the branch below measures the true spacing while the branch above
 * returned twice it, so a leaf drew dots half the size of its own parent's for the
 * same real point spacing.
 */
export function tileSpacingMetres(tile: any, points: number): number {
  const error = typeof tile?.geometricError === 'number' ? tile.geometricError : 0
  if (error > 0) return error / EXPERIENCE_CONFIG.lod.pointSize.geometricErrorScale

  const volume = tile?.engineData?.boundingVolume
  if (volume && points > 0) {
    volume.getOBB(spacingBox, spacingObb)
    spacingBox.getSize(spacingSize)
    // x and y are the horizontal extents: the pipeline builds the box from ENU
    // content bounds with z up, and no stage rescales the axes.
    const area = spacingSize.x * spacingSize.y
    if (area > 1e-6) return Math.sqrt(area / points)
  }
  return EXPERIENCE_CONFIG.lod.pointSize.fallbackSpacingM
}

// The two cache floors — `cacheMinTiles` and `cacheMinBytes` — are the same rule
// in different units: eviction drains to whichever is *lower*, so the tighter one
// decides how much of the off-screen working set survives. They must therefore be
// kept in step. They were introduced as a matched pair (48 tiles next to 48 MiB, at
// the ~600 KB per tile of the time); the byte budgets have since grown eightfold
// while the tile floor stayed, which pinned every tree at ~48 tiles and made a
// camera turn a re-download. 140 sits just under `cacheMaxTiles` so the bytes bind.
const DEFAULT_LIMITS: StreamingLimits = {
  cacheMinTiles: 140,
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
  /** ECEF-anchored parent — the floating-origin root, not the raw scene. */
  scene: THREE.Object3D
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
  onPointTile?: (object: THREE.Object3D, url: string) => void
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
  let leafLoading = false
  let leafLoadingSnapshot: {
    minSize: number
    maxSize: number
    minBytesSize: number
    maxBytesSize: number
    maxDownloads: number
    maxParses: number
    maxProcesses: number
    maxTilesProcessed: number
    gpuBytesTarget: number
  } | null = null
  tiles.registerPlugin(regionPlugin as any)

  const unloadPlugin = new UnloadTilesPlugin({
    delay: 350,
    bytesTarget: limits.gpuBytesTarget,
  })
  tiles.registerPlugin(unloadPlugin as any)

  /** `debugTiles` are this tile's own materials, kept so the false-colour inspector can
   *  write their per-frame uniforms without traversing the scene graph every frame. */
  const tileStats = new WeakMap<object, {
    points: number
    density: DensityBand
    debugTiles: any[]
    /** The quad meshes this tile draws, for measuring the area they cover. Kept as a
     *  list because one tile can carry several point sources. */
    quads: THREE.Mesh[]
  }>()
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
  function buildPointQuads(source: THREE.Points, tile: any, density: DensityBand): THREE.Mesh | null {
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

    const spacing = tileSpacingMetres(tile, position.count)
    const material = createCloudMaterial(uniforms, color?.itemSize ?? 3, spacing, {
      level: densityLevel(density),
      tint: densityLevelColor(density),
      // The pipeline's way of saying "this cannot refine further" — written both for
      // genuine bottom nodes and for any node too sparse to subdivide, which is why the
      // error view gives it a colour of its own rather than a place on the ramp.
      isLeaf: tile?.geometricError === 0,
    })
    // Read back by the tile trace in main.ts — the one place the derived size can
    // be checked against the depth the tile came from.
    material.userData.pointSpacingM = spacing
    const mesh = new THREE.Mesh(geometry, material)
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
    // Resolved before the loop rather than after it: the material each source gets is
    // told its own level, so the false-colour views need no second lookup at draw time.
    const density = densityBandForUri(
      `${url ?? ''} ${tile?.content?.uri ?? ''} ${tile?.internal?.basePath ?? ''}`,
    )
    const debugTiles: any[] = []
    const quads: THREE.Mesh[] = []
    for (const source of sources) {
      points += source.geometry?.getAttribute('position')?.count ?? 0
      // Before setDrawRange(0, 0) below parks the carrier — the positions stay
      // readable either way, but taking the tile here keeps the handoff obvious.
      opts.onPointTile?.(source, String(url ?? ''))

      const mesh = buildPointQuads(source, tile, density)
      if (!mesh) continue
      quads.push(mesh)
      const debugTile = (mesh.material as any)?.userData?.debugTile
      if (debugTile) debugTiles.push(debugTile)

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
    tileStats.set(tile, { points, density, debugTiles, quads })
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
    },
    setErrorTarget(value: number) {
      tiles.errorTarget = value
    },
    setLeafLoading(enabled: boolean) {
      if (enabled === leafLoading) return
      leafLoading = enabled
      if (enabled) {
        leafLoadingSnapshot = {
          minSize: tiles.lruCache.minSize,
          maxSize: tiles.lruCache.maxSize,
          minBytesSize: tiles.lruCache.minBytesSize,
          maxBytesSize: tiles.lruCache.maxBytesSize,
          maxDownloads: tiles.downloadQueue.maxJobs,
          maxParses: tiles.parseQueue.maxJobs,
          maxProcesses: tiles.processNodeQueue.maxJobs,
          maxTilesProcessed: tiles.maxTilesProcessed,
          gpuBytesTarget: (unloadPlugin as any).bytesTarget,
        }
        if (maskActive) { regionPlugin.removeRegion(maskRegion); maskActive = false }
        // This is intentionally a diagnostic, not a general performance preset:
        // preserve every tile selected while inspecting a close-range canopy.
        tiles.lruCache.minSize = 20_000
        tiles.lruCache.maxSize = 20_000
        tiles.lruCache.minBytesSize = 16 * 1024 * MIB
        tiles.lruCache.maxBytesSize = 16 * 1024 * MIB
        tiles.downloadQueue.maxJobs = 24
        tiles.parseQueue.maxJobs = 8
        tiles.processNodeQueue.maxJobs = 16
        tiles.maxTilesProcessed = 10_000
        ;(unloadPlugin as any).bytesTarget = 16 * 1024 * MIB
      } else if (leafLoadingSnapshot) {
        const snapshot = leafLoadingSnapshot
        tiles.lruCache.minSize = snapshot.minSize
        tiles.lruCache.maxSize = snapshot.maxSize
        tiles.lruCache.minBytesSize = snapshot.minBytesSize
        tiles.lruCache.maxBytesSize = snapshot.maxBytesSize
        tiles.downloadQueue.maxJobs = snapshot.maxDownloads
        tiles.parseQueue.maxJobs = snapshot.maxParses
        tiles.processNodeQueue.maxJobs = snapshot.maxProcesses
        tiles.maxTilesProcessed = snapshot.maxTilesProcessed
        ;(unloadPlugin as any).bytesTarget = snapshot.gpuBytesTarget
        leafLoadingSnapshot = null
      }
    },
    setDensityCeiling(level: number) {
      requestVolumePlugin?.setDensityCeiling(level)
    },
    /**
     * Refresh the two per-tile values the false-colour inspector needs from the
     * traversal: the tile's error over the live target, and whether refinement stopped
     * there. Call after `update()`, so both come from the traversal that just ran.
     *
     * Off is a single early return — no walk, no writes — because this is the only part
     * of the inspector that costs anything per frame. On, it is one Vector4 write per
     * visible tile, which is the same order as the read-outs already do.
     *
     * The error is the *corrected* one: foveation, the view-angle and view-depth
     * wrappers all multiply `calculateTileViewError`, so what lands here is the number
     * refinement actually judged the tile by rather than the plain distance quotient.
     * That is the whole point of reading it back instead of recomputing it.
     */
    updateDebugTiles(active: boolean) {
      if (!active) return
      const target = tiles.errorTarget || 1
      for (const tile of tiles.visibleTiles) {
        const stats = tileStats.get(tile)
        if (!stats || stats.debugTiles.length === 0) continue
        // Terminal = no child of this tile is also on screen. Same test as `stats()`,
        // and for the same reason: a drawn tile with drawn children is an ancestor
        // under a finer layer, not a stopping point.
        const children = (tile as any)?.children as any[] | undefined
        const refined = Array.isArray(children)
          && children.some((child) => tiles.visibleTiles.has(child))
        const error = (tile as any)?.traversal?.error
        // Infinity is the camera standing inside the tile's box, where the library
        // reports an unbounded error. Parked at the top of the ramp rather than passed
        // on, so it reads as "as far past the target as the ramp goes" instead of NaN.
        const ratio = Number.isFinite(error) ? (error as number) / target : 1e6
        for (const debugTile of stats.debugTiles) {
          debugTile.value.z = ratio
          debugTile.value.w = refined ? 0 : 1
        }
      }
    },
    setMemoryBudget(cacheMaxBytes: number, gpuBytesTarget: number) {
      tiles.lruCache.maxBytesSize = cacheMaxBytes
      // The floor is where the cache comes to rest, so it has to stay clear of the
      // ceiling: clamped to `cacheMaxBytes` itself, the medium and constrained tiers
      // rest with no free space at all, and every tile a camera move asks for waits
      // on an eviction pass before it can even be queued. A quarter of the budget is
      // enough room to absorb a pan. Raising the tier ceilings instead would keep
      // more resident, at the peak-memory cost those tiers exist to bound.
      tiles.lruCache.minBytesSize = Math.min(tiles.lruCache.minBytesSize, Math.round(cacheMaxBytes * 0.75))
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
    setMaskSphere(centerWorld: THREE.Vector3 | null, radius: number) {
      if (leafLoading) {
        if (maskActive) { regionPlugin.removeRegion(maskRegion); maskActive = false }
        return
      }
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
      let leafTiles = 0
      const mix = new Map<DensityBand, { tiles: number; points: number }>()
      for (const tile of tiles.visibleTiles) {
        const stats = tileStats.get(tile)
        if (!stats) continue
        points += stats.points
        density = denserBand(density, stats.density)
        // Terminal = refinement stopped here, i.e. no child of this tile is also on
        // screen. Checked against the visible set rather than a traversal flag because
        // that is what the eye sees: a drawn tile with drawn children is an ancestor
        // under a finer layer, not a stopping point. Children that are external tileset
        // documents (the z0 seams) hold their content one level down, so a stop right at
        // a seam can read as terminal — rare, and it does not change the shape.
        const children = (tile as any)?.children as any[] | undefined
        const refined = Array.isArray(children)
          && children.some((child) => tiles.visibleTiles.has(child))
        if (refined) continue
        // A leaf carries geometricError 0 — the pipeline's way of saying "this cannot
        // refine further", which it writes both for genuine bottom nodes and for any
        // node too sparse to subdivide. Counted because the second kind is a step the
        // error target can never move.
        if (tile?.geometricError === 0) leafTiles++
        const entry = mix.get(stats.density)
        if (entry) { entry.tiles++; entry.points += stats.points }
        else mix.set(stats.density, { tiles: 1, points: stats.points })
      }
      return {
        visible: tiles.visibleTiles.size,
        points,
        missingTiles: failedTiles.size,
        progress: tiles.loadProgress,
        density,
        leafTiles,
        // Coarsest first, so the readout reads like the ladder it is.
        terminalLevels: [...mix.entries()]
          .map(([band, entry]) => ({ band, tiles: entry.tiles, points: entry.points }))
          .sort((a, b) => a.band.localeCompare(b.band, undefined, { numeric: true })),
        cacheBytes: (tiles.lruCache as any).cachedBytes ?? 0,
        gpuBytes: (unloadPlugin as any).estimatedGpuBytes ?? 0,
        cacheTiles: (tiles.lruCache as any).itemSet?.size ?? 0,
        cacheTilesFloor: tiles.lruCache.minSize,
        cacheBytesFloor: tiles.lruCache.minBytesSize,
        cacheTilesCeiling: tiles.lruCache.maxSize,
        cacheBytesCeiling: tiles.lruCache.maxBytesSize,
      }
    },
    shadedPixelArea(diameterPx) {
      // The shader divides by view depth — the distance along the camera axis, not the
      // radial distance — so the forward axis is taken once and the tile centres are
      // projected onto it. Radial distance would over-report depth toward the corners
      // of a wide frame and quietly shrink the dots the readout thinks are drawn there.
      camera.getWorldDirection(coverForward)
      let areaPx = 0
      let points = 0
      for (const tile of tiles.visibleTiles) {
        const stats = tileStats.get(tile)
        if (!stats) continue
        for (const mesh of stats.quads) {
          const instances = (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount
          if (!instances) continue
          const spacingM = (mesh.material as any)?.userData?.pointSpacingM
          if (!(spacingM > 0)) continue
          // The carrier this mesh hangs under still holds the tile's real point bounds;
          // the quad geometry's own sphere describes the four corner offsets and says
          // nothing about where the tile is (see sampleGroundZ for the same trap).
          const carrier = mesh.parent as THREE.Object3D | null
          const geometry = carrier ? (carrier as any).geometry : null
          if (!geometry) continue
          // Computed here rather than skipped when absent. three only builds the sphere
          // when something asks for it, and the carrier is parked with an empty draw
          // range, so nothing ever does — skipping meant these tiles were left out of the
          // area for the whole session while their points stayed in the point count.
          if (!geometry.boundingSphere) geometry.computeBoundingSphere()
          const bounds = geometry.boundingSphere
          if (!bounds) continue
          coverCentre.copy(bounds.center).applyMatrix4(carrier!.matrixWorld)
          const depth = coverCentre.sub(camera.position).dot(coverForward)
          // Wholly behind the eye: every one of its points is clipped and shades nothing,
          // so it is left out of both the area and the point count it would be averaged
          // over. Counting it was worse than skipping it — flooring the depth made the
          // derived size explode into the max-pixel clamp and billed the entire tile at
          // the fattest dot the cloud can draw.
          if (depth + bounds.radius <= camera.near) continue
          // Straddling the near plane: part of it really is drawn, and drawn large. Billed
          // at the near plane rather than at a centre that sits behind the camera, which
          // is an over-estimate bounded by the size clamp instead of an unbounded one.
          const diameter = diameterPx(spacingM, Math.max(depth, camera.near))
          areaPx += instances * diameter * diameter
          points += instances
        }
      }
      return { areaPx, points }
    },
    dispose() {
      scene.remove(tiles.group)
      tiles.dispose()
      lifecycle.abort()
    },
  }
}
