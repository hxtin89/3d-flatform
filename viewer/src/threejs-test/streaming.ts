// Single-tree point-cloud streaming. The One LOD Tree links p02 -> p10 -> p100
// through external 3D Tiles documents, so one TilesRenderer owns traversal,
// requests, CPU cache and GPU residency for every density.
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer'
import { LoadRegionPlugin, SphereRegion, UnloadTilesPlugin } from '3d-tiles-renderer/plugins'
import { recordArrival } from './arrival-cost'
import {
  applyMatrixPrecision, createCloudMaterial, setHighPrecisionMatrices, rebuildEffectMaterial,
  effectMaterialStale, dropPulledCloudGraphs,
  POINT_COLOR_ATTRIBUTE, POINT_DATA_PROPERTY, POINT_POSITION_ATTRIBUTE, type CloudUniforms,
} from './point-cloud'
import {
  denserBand, densityBandForUri, densityLevel, densityLevelColor, type DensityBand,
} from './density-band'
import { ViewerRequestVolumePlugin } from './viewer-request-volume'
import {
  applyDotShape, applyDotShapeToGeometry, buildPulledGeometry, dotAreaFactor, dotState,
  drawnPoints, initDotState, isDotMesh, loadedPoints, packPointData, prepareSharedQuadIndex,
  sameDotMode, setDrawnPoints, type DotMode,
} from './dot-geometry'
import {
  adoptPointData, packPointsForPulling, pointDataForCarrier, PREFIX_SAMPLE_ROUNDS,
  reorderAccepts, reorderForPrefixSampling, restoreCarrierArrays,
} from './point-order'
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
  /**
   * The dome's two gates this frame — see sphere-fade.ts. `loadGateCut` is how many tile
   * boxes the region mask rejected during the traversal (the vignette's sphere counts
   * here too, when that is the mask in force). `renderGateHidden` is how many of the
   * `renderGateTiles` selected tiles were kept off the render list by the inner sphere.
   */
  loadGateCut: number
  renderGateHidden: number
  renderGateTiles: number
  /** Radius the point-of-view load was actually allowed this frame, after the point cap
   *  shrank it — Infinity when the cap did not bite or the load is off. */
  povRadius: number
  /** Points the point-of-view selection is estimated to hold, from the published counts. */
  povPoints: number
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
  /**
   * Hold freshly built tiles back and release a few per frame, instead of letting every
   * tile that arrived in one frame upload and compile in that same frame.
   *
   * `perFrame` of 0 switches it off *and drains whatever is waiting*, so off is the
   * picture you get with the feature absent rather than a queue frozen mid-flight.
   */
  setArrivalBudget(perFrame: number): void
  /**
   * How many tile parses may be in flight, which is what really decides how many tiles can
   * land in one frame — measured, the arrivals-per-frame histogram never exceeds this.
   *
   * Lowering it is the cheapest upload-bandwidth limiter there is: fewer, smaller bursts of
   * `createAttribute` in one frame, at the cost of the cloud filling in more slowly.
   */
  setParseBudget(maxJobs: number): void
  /** Restrict loading/refinement/rendering to a world-space sphere (null = off). */
  setMaskSphere(centerWorld: THREE.Vector3 | null, radius: number): void
  /**
   * Draw only the selected tiles whose box reaches into this world-space sphere (null =
   * draw every selected tile). A tile outside it is left exactly as selected — loaded,
   * resident, counted — and only its quads are taken off the render list, which is what
   * stops three uploading or compiling anything for it. Takes effect inside `update()`.
   */
  setRenderSphere(centerWorld: THREE.Vector3 | null, radius: number): void
  /**
   * Initial point-of-view load. While an eye is set, the mask sphere stops asking the
   * camera frustum: every tile whose box reaches into the sphere is selected, and its
   * refinement is judged by the distance from *this* eye rather than from the live
   * camera — the landing pose of the entrance flight, so the whole dome around it
   * refines as if the camera stood there looking in every direction, while the camera
   * itself is still parked behind the loader or in the air. Null returns the mask to
   * its frustum-and-camera behaviour. Needs an active mask sphere to have any effect.
   */
  setPovLoad(eyeWorld: THREE.Vector3 | null, maxPoints?: number): void
  /**
   * Draw every point in `mode` — shape and feed, see dot-geometry.ts. Applied at once to
   * every loaded tile, cached ones included, rebuilt from each tile's own point arrays;
   * tiles that arrive later are built in it. Nothing is re-fetched, so the resident set
   * and the pose stay exactly as they were, which is what makes the switch a fair A/B.
   * Returns how many dot meshes changed.
   */
  setDotMode(mode: DotMode): number
  dotMode(): DotMode
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
  /**
   * Draw fewer of each tile's points, by lowering `instanceCount` so a shorter prefix of
   * the (shuffled) buffer is drawn.
   *
   * This removes primitives, which is the only thing that has been measured to move the
   * frame cost — shrinking points instead saves fragments, and fragments turned out to be
   * free. Pass null to restore every tile to its full buffer.
   *
   * Returns what was drawn against what is loaded, so the panel can report the fraction
   * rather than leaving it to be inferred.
   */
  applyThinning(settings: ThinningSettings | null): { drawn: number; loaded: number }
  /**
   * Drop every resident tile so the next traversal fetches and parses them again.
   *
   * Exists for the thinning A/B. Whether a tile's points get reordered is decided once, as
   * it arrives, so flipping the thinning toggle changes nothing about the tiles already in
   * memory — and because `cacheMinTiles` holds hundreds of them and the cache only evicts
   * above its floor, nothing would age out on its own either. Without this, switching
   * thinning on leaves a scene where the tiles that happened to arrive earlier are drawn
   * whole and the rest are thinned, which is neither state and measures neither.
   *
   * Cheaper than reloading the page: the camera, the basemap, the mask and the loaded
   * scene all stay, and only the point tiles come back. They re-download, so the cost is
   * a few hundred milliseconds of streaming rather than the entrance flight.
   *
   * Returns how many tiles were dropped.
   */
  reloadTiles(): number
  /**
   * Point the drawn size at the density that is actually on screen at each spot, rather
   * than at each tile's own.
   *
   * Only the spacing-derived size reads this, so it is inert while `Point size` is
   * `Fixed` — see applyEffectiveSpacing for what it does and why the ancestors need it.
   * `rampMs` is the thinning dissolve's, and 0 disables the easing.
   */
  applyEffectiveSpacing(rampMs: number): { shrunk: number; tiles: number }
  shadedPixelArea(
    diameterPx: (spacingM: number, viewDepthM: number, thinScale: number) => number,
  ): { areaPx: number; points: number }
  dispose(): void
}

export interface ThinningSettings {
  /** How far apart the drawn points are wanted on screen, in CSS pixels. */
  targetPx: number
  /** CSS pixels per metre at one metre of view depth — the projection scale the shader
   *  uses, so both sides agree on what a spacing looks like on screen. */
  pxPerMetre: number
  /** Extra thinning for a tile whose children are also being drawn: its ground is already
   *  covered by finer data, so its own points are duplicates. 1 leaves it alone. */
  ancestorKeep: number
  /** Never draw less than this fraction of a tile, so nothing vanishes outright. */
  minKeep: number
  /**
   * How long a tile takes to ease most of the way to a new keep fraction, in ms.
   *
   * 0 turns the damping off entirely and restores the bare per-frame decision the feature
   * had before — kept switchable because the step it removes is a look judgement, and a
   * look judgement needs an A/B.
   */
  rampMs: number
  /**
   * Ceiling on how far a survivor may be widened to stand in for the points that went.
   *
   * Not the same limit as `design` point size: in fixed-size mode `sizeMinPx`/`sizeMaxPx`
   * are not consulted at all, so this is the only thing bounding the drawn diameter.
   */
  maxWiden: number
  /**
   * The distance ramp. Nearer than `nearM` a tile is left entirely alone; beyond `farM`
   * the settings above apply at full strength; between the two the strength eases in.
   *
   * This exists because the rest of the rule is not actually a distance gradient. It keys
   * on *projected* spacing, and the error target already picks coarser tiles further out,
   * so distance largely cancels: measured keep by depth band ran 84% / 57% / 55% / 69% /
   * 46%, which is not a slope at all. Without this ramp the aggressive settings cut the
   * near field to a third along with everything else, which is precisely the ground the
   * viewer is looking at.
   */
  nearM: number
  farM: number
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
 * Two independent estimates, and the smaller wins. Both are upper bounds on the true
 * `sqrt(content area / points)`, so the minimum is always the closer of the two and can
 * never fall below the truth:
 *
 *  - **The published error.** `geometricError = errorScale * sqrt(content area / points)`,
 *    so dividing the scale back out is exact — *when the pipeline published what it
 *    measured*. It does not always: `corrected_error` in
 *    build_adaptive_point_hierarchy_tileset.py forces every node's error above its
 *    largest child's (`max(raw, largest * 1.05, ...)`) to keep the tileset's errors
 *    strictly decreasing, and where that clamp bites, the number describes the subtree's
 *    monotonicity rather than this node's density. Leaves are written `geometricError: 0`
 *    so they can never refine, which is why this route cannot stand alone either.
 *  - **The bounding volume.** `sqrt(OBB footprint / points)`, measured here. Exact
 *    whenever the node's content fills its cell, and an over-estimate when it does not,
 *    because the published box is the union of the node with its whole subtree.
 *
 * Measured against the deployed peru-b2-globe pack, 40 visible tiles at the arrival
 * view: the two agree to three decimals on 39 of them, and disagree on exactly one — the
 * `p001` overview root, published at 7.668 m against a measured 3.849 m. That is the
 * clamp, and it is visible arithmetic: p001 holds 270k points where d0 below it holds
 * 75k, so its real spacing is *finer* than its child's and the monotonicity rule
 * overrides it by construction, every time, on the single largest tile in the frame.
 * Before this, that tile drew every one of its points at twice the diameter it had
 * earned.
 */
export function tileSpacingMetres(tile: any, points: number): number {
  let spacing = Infinity
  const error = typeof tile?.geometricError === 'number' ? tile.geometricError : 0
  if (error > 0) spacing = error / EXPERIENCE_CONFIG.lod.pointSize.geometricErrorScale

  const volume = tile?.engineData?.boundingVolume
  if (volume && points > 0) {
    volume.getOBB(spacingBox, spacingObb)
    spacingBox.getSize(spacingSize)
    // x and y are the horizontal extents: the pipeline builds the box from ENU
    // content bounds with z up, and no stage rescales the axes.
    const area = spacingSize.x * spacingSize.y
    // Costs one getOBB per tile at load and never touches the position buffer, so it is
    // affordable on every tile rather than only on the leaves it used to be reserved for.
    if (area > 1e-6) spacing = Math.min(spacing, Math.sqrt(area / points))
  }
  return Number.isFinite(spacing) ? spacing : EXPERIENCE_CONFIG.lod.pointSize.fallbackSpacingM
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
  /** Called for each of those objects when its tile is evicted, so whatever queued it can
   *  let go of it. */
  onPointTileDisposed?: (object: THREE.Object3D) => void
  /** The root tileset itself was unreachable (404/403) — this cloud will stay empty. */
  onRootError?: (url: string, error: unknown) => void
  /** How the first tiles are drawn. `setDotMode` changes it later. */
  dotMode?: DotMode
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
  /** Tile boxes the mask sphere rejected in this frame's traversal, for the readout. */
  let loadGateCut = 0
  /**
   * The initial point-of-view load — see setPovLoad. `povEye` is the landing pose in
   * the tiles' own frame; while `povActive` the region also answers for tiles the
   * camera cannot see, so the traversal refines the whole sphere from that eye.
   */
  const povEye = new THREE.Vector3()
  let povActive = false
  /** Point cap on the point-of-view load, and what the solver made of it — see solvePovRadius. */
  let povBudget = Infinity
  let povRadius = Infinity
  let povPoints = 0
  /** The radius the caller asked for; the point-of-view solver may run the mask tighter. */
  let maskRadiusRequested = 0
  class FrustumMaskRegion extends SphereRegion {
    intersectsTile(boundingVolume: any, _tile?: any, tilesRenderer?: any): boolean {
      if (!boundingVolume.intersectsSphere(this.sphere)) { loadGateCut++; return false }
      // The point-of-view load wants the sphere whole, not the wedge the camera sees.
      if (povActive) return true
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
  /**
   * Off the point-of-view load the region adds no error of its own — the camera's
   * quotient decides. On it, the same quotient the renderer uses (`geometricError /
   * (distance * sseDenominator)`, TilesRenderer.calculateTileViewError) is taken from
   * the landing eye instead, and the plugin merges it by max with the camera's, so a
   * tile the live camera cannot see still refines exactly as far as it would once the
   * camera has landed there. A zero distance is the eye inside the box: unbounded, as
   * the renderer reports it too.
   */
  maskRegion.calculateError = (tile: any, tilesRenderer: any) => {
    if (!povActive) return 0
    const info = tilesRenderer?.cameraInfo?.[0]
    if (!info || info.isOrthographic || !(info.sseDenominator > 0)) return 0
    const distance = tile?.engineData?.boundingVolume?.distanceToPoint(povEye) ?? Infinity
    return distance === 0 ? Infinity : (tile.geometricError ?? 0) / (distance * info.sseDenominator)
  }
  // Download priority: nearest to the eye first, so the ground under the landing view
  // fills in before the far rim of the sphere.
  maskRegion.calculateDistance = (boundingVolume: any) =>
    povActive ? boundingVolume.distanceToPoint(povEye) : Infinity
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
  /** Timestamp of the previous thinning pass, for the ramp's elapsed time. */
  let lastThinningAt = 0
  /** The same, for the effective-spacing pass, which runs whether thinning is on or not. */
  let lastSpacingAt = 0
  /**
   * One visible tile as applyEffectiveSpacing sees it. Pooled and reused between frames:
   * the pass runs every frame over every visible tile and must not allocate.
   *
   * `own` is the tile's measured spacing and never changes. `densityAbove` is the density
   * the drawn ancestors add over this tile — they always cover it in full, so it always
   * counts. `below` holds, per drawn level underneath, the finest spacing found there;
   * that only counts over the `covered` fraction.
   */
  interface SpacingEntry {
    tile: any
    quads: THREE.Mesh[]
    own: number
    covered: number
    densityAbove: number
    below: Float64Array
  }
  /** The tree is 11 deep plus p001 and the structural roots; 16 is slack over that. */
  const SPACING_LEVELS = 16
  const spacingPool: SpacingEntry[] = []
  const spacingEntries: SpacingEntry[] = []
  const spacingByTile = new Map<object, SpacingEntry>()
  function takeSpacingEntry(index: number): SpacingEntry {
    let entry = spacingPool[index]
    if (!entry) {
      entry = spacingPool[index] = {
        tile: null, quads: [], own: 0, covered: 0,
        densityAbove: 0, below: new Float64Array(SPACING_LEVELS),
      }
    }
    entry.densityAbove = 0
    entry.below.fill(0)
    return entry
  }
  /**
   * Tiles built but not yet shown, oldest first, and how many may be released per frame.
   *
   * A mesh that is not visible never reaches the render list, so three never uploads its
   * attributes and never builds its pipeline — `_projectObject` returns before any of
   * that. That makes `visible` the one honest budget point in three r185: there is no
   * hook that says "upload this attribute later".
   *
   * Holding the mesh rather than delaying `source.add(mesh)` is deliberate. The tile's
   * scene graph is what UnloadTilesPlugin traverses to dispose it, so a mesh queued
   * outside that graph would leak its geometry if the tile were evicted while waiting.
   */
  const pendingReveal: THREE.Mesh[] = []
  let arrivalBudget = 0
  /**
   * The dome's inner sphere in the tiles' own frame, and whether it is in force. A tile
   * whose box misses it stays selected, loaded and resident — only its quads leave the
   * render list. See applyRenderGate.
   */
  const renderSphere = new THREE.Sphere()
  let renderGateActive = false
  let renderGateHidden = 0
  let renderGateTiles = 0
  /** The wanted parse concurrency, kept separately so leaf loading can borrow the queue and
   *  hand it back without clobbering the setting. */
  let parseBudget = limits.maxParses

  /**
   * True once the tileset says its points are already in a progressive order.
   *
   * Read from the root tileset's `asset.extras.pointOrder` rather than assumed, because
   * the ordering is a property of the published pack: anything built before the pipeline
   * started baking it still needs the runtime shuffle. Cached after the first successful
   * read — the root document does not change under a running viewer.
   */
  let pointOrderChecked = false
  let pointsPreOrdered = false
  function tilesArePreOrdered(): boolean {
    if (pointOrderChecked) return pointsPreOrdered
    // `rootTileset` only — the `rootTileSet` spelling is deprecated and logs a warning
    // on every read, which this would do once per tile until the root resolves.
    const root = (tiles as any).rootTileset
    if (!root) return false
    pointOrderChecked = true
    pointsPreOrdered = root?.asset?.extras?.pointOrder === 'progressive'
    return pointsPreOrdered
  }

  /**
   * Whether anything currently needs a fair point order. Mirrors the thinning toggle,
   * refreshed from `applyThinning` each frame, and true initially because tiles loaded
   * during the entrance flight run before the first `applyThinning` call.
   *
   * This exists so the toggle is an honest A/B: with thinning off nothing draws a prefix,
   * so the reorder buys nothing, and a shipped build with thinning off would not pay it.
   * Leaving it on would charge the "off" side for work it would never do in production —
   * about 1.4 ms per tile — and would also hand the ground-patch mask a different order
   * than it sees today. Gated, "off" is byte-identical to the feature not existing.
   *
   * It is a measurement aid with a short life: once thinning is decided and the toggle is
   * deleted, one of the two branches goes with it. If thinning ships on, delete this flag
   * and reorder unconditionally; if it ships off, delete the reorder along with thinning.
   */
  let fairOrderWanted = true

  // One camera-facing primitive per point, instanced. Its corner offsets live in the
  // `position` attribute because that is what PointsNodeMaterial's sprite path scales by
  // the point size, and `uv` gives the round-dot cutout. Quad or triangle — see
  // dot-geometry.ts, which owns both, and setDotMode below — which can also drop the
  // instancing and draw the tile from a data texture instead.
  let dotMode: DotMode = { ...(opts.dotMode ?? { shape: 'quad', feed: 'instanced' }) }
  if (dotMode.feed === 'pulled' && dotMode.shape === 'quad') prepareSharedQuadIndex()

  /**
   * Widen a 3-byte colour to 4 bytes here, so three does not do it inside the render pass.
   *
   * WebGPU requires a vertex `arrayStride` that is a multiple of 4, and PNTS colours
   * arrive as uint8 RGB — three bytes. three handles that in WebGPUAttributeUtils by
   * padding to vec4 the first time the attribute is drawn, with a loop that allocates a
   * fresh `subarray` view for every single point. Measured against this tree's tile
   * sizes that loop runs 3.3 ms at 40k points and 5.8 ms at 150k, it runs on the main
   * thread *between beginRender and finishRender*, and it is thrown away and redone
   * whenever the buffer is recreated.
   *
   * The same work written as a flat indexed copy is 0.2-0.3 ms — some eighteen times
   * cheaper — and doing it here moves it out of the render pass into the parse handler,
   * where it is at least visible to the arrival timer.
   *
   * The cost is 4 bytes per point of extra CPU memory: the original colours are a view
   * into the tile's own PNTS ArrayBuffer, which also holds the positions, so they cannot
   * be released. Writing RGBA straight out of the pipeline would avoid both the copy and
   * the extra bytes — this is the version that needs no rebuild of the published tiles.
   */
  function padColourForGpu(
    color: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  ): THREE.InstancedBufferAttribute {
    const array = color.array as ArrayLike<number> & { BYTES_PER_ELEMENT: number }
    const itemSize = color.itemSize
    const stride = itemSize * array.BYTES_PER_ELEMENT
    // Already aligned — float32 vec3 is 12 bytes, uint8 RGBA is 4 — so three's padding
    // branch never fires and there is nothing to do. An interleaved attribute is left
    // alone too: its stride is the buffer's, not this attribute's, so the reasoning here
    // does not apply. The PNTS loader never hands one over, but the type allows it.
    if (itemSize <= 1 || stride % 4 === 0 || (color as any).isInterleavedBufferAttribute) {
      return new THREE.InstancedBufferAttribute(color.array as any, itemSize, color.normalized)
    }
    // Only the uint8 RGB case, written out longhand. A general loop over `itemSize` with
    // a `source.constructor` allocation measured 15x slower than this in the browser —
    // the dynamic constructor and the variable inner trip count stop V8 specialising it,
    // and the whole value of doing the padding here rather than letting three do it is
    // that this version is tight. Anything else falls through to three's own path, which
    // is slow but correct.
    if (itemSize !== 3 || array.BYTES_PER_ELEMENT !== 1) {
      return new THREE.InstancedBufferAttribute(color.array as any, itemSize, color.normalized)
    }
    const source = color.array as Uint8Array
    const count = color.count
    const out = new Uint8Array(count * 4)
    for (let i = 0, from = 0, to = 0; i < count; i++, from += 3, to += 4) {
      out[to] = source[from]
      out[to + 1] = source[from + 1]
      out[to + 2] = source[from + 2]
    }
    return new THREE.InstancedBufferAttribute(out, 4, color.normalized)
  }

  /** Rebuild one loaded THREE.Points tile as dot meshes in the current mode. Returns null
   * when the tile carries no usable position buffer. */
  function buildPointQuads(source: THREE.Points, tile: any, density: DensityBand): THREE.Mesh | null {
    const position = source.geometry?.getAttribute('position')
    if (!position) return null
    const color = source.geometry.getAttribute('color')
    const points = position.count
    const hasColour = color !== undefined
    // From the colour as it arrived, before either feed rewrites it: what the instanced
    // graph needs if the tile is ever drawn that way. A pulled carrier gives its colour up
    // to the texture, and gets back RGBA8 on a switch — which is 4, as a Uint8 RGB or RGBA
    // arrival is.
    const colorItemSize = instancedColourItemSize(color)
    // Skipped entirely while thinning is off — nothing draws a prefix then, so the order
    // is unneeded rather than unfair, and the tile keeps the order it arrived in. A
    // pre-ordered pack already satisfies the prefix rule.
    const wantOrder = fairOrderWanted && !tilesArePreOrdered()
    let reordered = false
    let geometry: THREE.BufferGeometry
    let pointData: THREE.DataTexture | null = null

    if (dotMode.feed === 'pulled') {
      // One pass: reorder (or keep the order, with one round) and pack the texture. The
      // carrier then holds a view of the texture's array and nothing else, so the tile is
      // held once — see point-order.ts. A layout the fast pass declines is packed by the
      // general path and keeps its arrays, drawn whole as in the instanced feed.
      const order = wantOrder && reorderAccepts(position, color)
      pointData = packPointsForPulling(position, color, order ? PREFIX_SAMPLE_ROUNDS : 1)
      if (pointData) {
        reordered = order
        adoptPointData(source.geometry, pointData, points)
        source.geometry.boundingSphere = null
      } else {
        pointData = packPointData(position, color)
      }
      geometry = forgetOnDispose(buildPulledGeometry(dotMode.shape, points))
    } else {
      const arrays = wantOrder ? reorderForPrefixSampling(position, color) : null
      if (arrays) {
        reordered = true
        // Written back onto the carrier as well, so `sampleGroundZ` and the ground-patch
        // mask walk the same order the drawn tile does — and so the tile's original PNTS
        // ArrayBuffer, which these arrays replace, stops being referenced by anything the
        // viewer holds. That buffer carries both position and colour, so releasing it pays
        // for the copies: 15 bytes per point go, 16 arrive.
        source.geometry.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3))
        if (arrays.color) {
          source.geometry.setAttribute(
            'color', new THREE.BufferAttribute(arrays.color, 4, color?.normalized ?? true),
          )
        }
        // Derived from the same points, and a permutation cannot change it — but it may
        // already have been built against the attribute just replaced.
        source.geometry.boundingSphere = null
      }
      // Built from the carrier's arrays as they now stand — reordered or as they arrived —
      // so a later feed switch can rebuild from the same source without re-fetching.
      geometry = buildInstancedGeometry(source.geometry, dotMode.shape)
    }

    const spacing = tileSpacingMetres(tile, points)
    const material = createCloudMaterial(uniforms, colorItemSize, spacing, {
      level: densityLevel(density),
      tint: densityLevelColor(density),
      // The pipeline's way of saying "this cannot refine further" — written both for
      // genuine bottom nodes and for any node too sparse to subdivide, which is why the
      // error view gives it a colour of its own rather than a place on the ramp.
      isLeaf: tile?.geometricError === 0,
    }, dotMode)
    // Before the first render: the pulled graph's texel reference resolves against it.
    if (pointData) (material as any)[POINT_DATA_PROPERTY] = pointData
    // Read back by the tile trace in main.ts — the one place the derived size can
    // be checked against the depth the tile came from.
    material.userData.pointSpacingM = spacing
    const mesh = new THREE.Mesh(geometry, material)
    // A Mesh, not a Sprite: WebGPUUtils.getPrimitiveTopology only names a
    // topology for isMesh, and Mesh avoids Sprite's own culling and raycasting.
    mesh.frustumCulled = false // tile-level culling is handled by TilesRenderer
    // On the mesh rather than the geometry, because applyThinning has the mesh and a
    // switch replaces the geometry's corner data or the geometry itself. `orderIsFair` is
    // false only for the layouts the reorder declines, which are then drawn whole rather
    // than as a biased wedge — by the same rule in both feeds.
    initDotState(mesh, {
      feed: dotMode.feed,
      shape: dotMode.shape,
      points,
      orderIsFair: reordered || tilesArePreOrdered(),
      hasColour,
    })
    // GlobeControls raycasts the whole scene. What a dot mesh would offer it is one
    // corner primitive at the tile's local origin — never the canopy — so it is taken out
    // of the test rather than left as a phantom target that changes size with the shape.
    mesh.raycast = () => {}
    return mesh
  }

  /**
   * Make `geometry.dispose()` free the GPU buffers every time, not only the first.
   *
   * three r185 registers its free-on-dispose listener when a geometry is first drawn and
   * removes it on the first dispose — but keeps its record that the geometry was set up, so
   * when UnloadTilesPlugin hides a tile and it is shown again the buffers are re-uploaded
   * with no listener attached. The next dispose (the next hide, an eviction, or a dot-mode
   * switch replacing the geometry) then frees nothing, and three's info map keeps the
   * buffers alive for good. Dropping three's record here makes the next draw set the
   * geometry up afresh and register a new listener. Added at build time, so it runs before
   * three's own listener; that one needs nothing the record held.
   *
   * On the WebGL2 fallback it also deletes the vertex-array objects built for the
   * geometry's attributes. three r185 caches one VAO per attribute set, keyed by the
   * attributes' upload ids, and never deletes any: `destroyAttribute` only deletes the
   * buffers. A buffer still attached to a VAO that is not bound keeps its storage (GLES 3.0
   * §5.1.3), so every instanced rebuild after a feed switch, and every hide and re-show by
   * the unload plugin, left one more copy of the tile's point buffers in the driver —
   * while `renderer.info` subtracted their bytes and read stable. Runs before three's
   * listener, while the upload ids are still readable. The pulled feed has no vertex
   * attributes, so all its tiles share one VAO under the empty key, which this leaves be.
   */
  function forgetOnDispose<T extends THREE.BufferGeometry>(geometry: T): T {
    geometry.addEventListener('dispose', () => {
      releaseVertexArrays(geometry)
      ;(renderer as any)?._geometries?.delete?.(geometry)
    })
    return geometry
  }

  function releaseVertexArrays(geometry: THREE.BufferGeometry): void {
    const backend = (renderer as any)?.backend
    if (!backend?.isWebGLBackend || !backend.vaoCache || typeof backend.has !== 'function') return
    const ids = new Set<string>()
    for (const attribute of Object.values(geometry.attributes)) {
      if (!backend.has(attribute)) continue
      const id = backend.get(attribute)?.id
      if (id !== undefined) ids.add(String(id))
    }
    if (!ids.size) return
    const gl = backend.gl as WebGL2RenderingContext
    for (const key of Object.keys(backend.vaoCache)) {
      if (!key.split(':').some((token) => ids.has(token))) continue
      const vao = backend.vaoCache[key]
      if (backend.state?.currentVAO === vao) backend.state.resetVertexState()
      gl.deleteVertexArray(vao)
      delete backend.vaoCache[key]
    }
  }

  /**
   * The colour component count the instanced graph is built for: what padColourForGpu
   * will hand the GPU for this carrier colour. Recorded on the material for both feeds, so
   * a tile switched back to instanced gets the graph that matches its attribute.
   */
  function instancedColourItemSize(color: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined): number {
    if (!color) return 3
    const bytes = (color.array as any).BYTES_PER_ELEMENT
    if (color.itemSize === 3 && bytes === 1 && !(color as any).isInterleavedBufferAttribute) return 4
    return color.itemSize
  }

  /**
   * Build an instanced dot geometry from a carrier's point arrays: they are wrapped as
   * instanced attributes as they are — no copy — with the colour widened to RGBA where
   * WebGPU needs a 4-byte stride.
   *
   * The carrier must hold tight arrays. A pulled carrier holds a four-float view of its
   * texture instead, which applyDotMode unpacks (restoreCarrierArrays) before it gets here.
   */
  function buildInstancedGeometry(carrier: THREE.BufferGeometry, shape: DotMode['shape']): THREE.InstancedBufferGeometry {
    const position = carrier.getAttribute('position')
    const color = carrier.getAttribute('color')
    const geometry = forgetOnDispose(new THREE.InstancedBufferGeometry())
    applyDotShapeToGeometry(geometry, shape)
    // The tile's own buffers are reused as-is — no copy, no format conversion.
    // PNTS colours arrive as normalised Uint8, which TSL resolves to a float
    // vector via NodeBuilder.getTypeFromAttribute.
    geometry.setAttribute(POINT_POSITION_ATTRIBUTE, new THREE.InstancedBufferAttribute(
      position.array as any, position.itemSize, position.normalized,
    ))
    // A reordered carrier already holds RGBA, which padColourForGpu passes through as it
    // is; only pre-ordered packs and the layouts the reorder declines get widened here.
    const colorAttribute = color ? padColourForGpu(color) : null
    if (colorAttribute) geometry.setAttribute(POINT_COLOR_ATTRIBUTE, colorAttribute)
    geometry.instanceCount = position.count
    return geometry
  }

  /**
   * Draw one dot mesh in `mode`, if it is not already. Returns whether it changed.
   *
   * A shape change inside the instanced feed rewrites the corner buffer in place
   * (applyDotShape). Anything that crosses feeds, or changes the shape of a pulled tile, is
   * a rebuild from the carrier: a new geometry, the texture attached or released, the
   * graph for the new mode, and the old geometry disposed. The Mesh and its material stay
   * the same objects — the render gate, the arrival queue, the inspector and the disposal
   * lists all hold them. The drawn count is carried across, so the thinning state
   * survives.
   *
   * The carrier's arrays change form with the feed (point-order.ts): into the pulled feed
   * they become the texture — the identity pack, since the carrier is already in its final
   * order — and the carrier keeps a view of it; out of it they are unpacked back into
   * tight arrays *before* the instanced geometry wraps them. A pulled shape change keeps
   * the texture it has and packs nothing.
   *
   * The graph swap goes through the material's own rebuild closure, which bumps the
   * material version. That is the only thing that makes three re-key a render object, and
   * without it the old pipeline — whose vertex layout steps the point attributes per
   * instance — would survive and draw every vertex at point 0.
   */
  function applyDotMode(mesh: THREE.Mesh, mode: DotMode, tile: any): boolean {
    const state = dotState(mesh)
    if (!state || sameDotMode(state, mode)) return false
    if (state.feed === 'instanced' && mode.feed === 'instanced') return applyDotShape(mesh, mode.shape)

    const carrier = mesh.parent as THREE.Points | null
    const carrierGeometry = (carrier as any)?.geometry as THREE.BufferGeometry | undefined
    if (!carrierGeometry?.getAttribute('position')) return false
    const drawn = drawnPoints(mesh)
    const material = mesh.material as any
    const engineData = tile?.engineData

    const previousTexture: THREE.DataTexture | undefined = material[POINT_DATA_PROPERTY]
    let texture: THREE.DataTexture | null = null
    let geometry: THREE.BufferGeometry
    if (mode.feed === 'pulled') {
      texture = previousTexture ?? pointDataForCarrier(carrierGeometry)
      geometry = forgetOnDispose(buildPulledGeometry(mode.shape, state.points))
    } else {
      // A no-op for a carrier that never gave its arrays up (a declined layout).
      restoreCarrierArrays(carrierGeometry, state.hasColour)
      geometry = buildInstancedGeometry(carrierGeometry, mode.shape)
    }
    if (texture) {
      material[POINT_DATA_PROPERTY] = texture
      if (Array.isArray(engineData?.textures) && !engineData.textures.includes(texture)) {
        engineData.textures.push(texture)
      }
    } else if (previousTexture) {
      // Deleted rather than set to null, so the material's cache key matches a tile that
      // was instanced from the start.
      delete material[POINT_DATA_PROPERTY]
      previousTexture.dispose()
      if (Array.isArray(engineData?.textures)) {
        const at = engineData.textures.indexOf(previousTexture)
        if (at >= 0) engineData.textures.splice(at, 1)
      }
    }

    // Drops every render object of the material now, as the unload plugin does on each
    // hide. Without it, a tile the dome's render gate keeps off the render list holds its
    // old render object — and through it the old geometry and the arrays it wrapped — until
    // it is drawn again. The next draw rebuilds anyway: the graph swap below bumps the
    // material version.
    material.dispose()
    const previousGeometry = mesh.geometry
    mesh.geometry = geometry
    if (Array.isArray(engineData?.geometry)) {
      const at = engineData.geometry.indexOf(previousGeometry)
      if (at >= 0) engineData.geometry[at] = geometry
      else engineData.geometry.push(geometry)
    }
    previousGeometry.dispose()

    state.feed = mode.feed
    state.shape = mode.shape
    material.userData.dotMode = { ...mode }
    rebuildEffectMaterial(material)
    setDrawnPoints(mesh, drawn)
    return true
  }

  // Materials must be tile-owned. A shared material is unsafe with
  // UnloadTilesPlugin because hiding one tile disposes its material and would
  // invalidate every other tile that shared the same instance.
  tiles.addEventListener('load-model', ({ scene: model, tile, url }: any) => {
    // Timed because this handler is the one piece of tile cost that lands in a rAF turn
    // with no budget above it: the shuffle, the quad build and the per-tile material all
    // run here, synchronously, in whatever frame the parse promise happens to resolve.
    const arrivalStartedAt = performance.now()
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
    // The PNTS loader keeps the tile's whole decoded ArrayBuffer alive here, and that is
    // the buffer `reorderForPrefixSampling` copies out of — position and colour are both
    // views into it. Dropping the reference is what makes the reorder memory-neutral:
    // 15 bytes per point are released against the 16 the new arrays take. Nothing in the
    // viewer reads `featureTable`, and in 3d-tiles-renderer only the B3DM path does, so
    // this is dead weight for a PNTS tile either way.
    ;(model as any).featureTable = null
    ;(model as any).batchTable = null
    // The loader's result object holds the same two tables: TilesRenderer keeps it as
    // `engineData.metadata` for the life of the tile, so dropping only the model's copies
    // above released nothing — the PNTS body, about 15 bytes per point, stayed reachable
    // through it in both feeds. In this renderer only the Google auth plugin reads that
    // object, and only its `asset.copyright`. Null for tiles that parse to a bare Object3D.
    const metadata = tile?.engineData?.metadata
    if (metadata) {
      metadata.featureTable = null
      metadata.batchTable = null
    }
    for (const source of sources) {
      points += source.geometry?.getAttribute('position')?.count ?? 0
      // Before setDrawRange(0, 0) below parks the carrier — the positions stay
      // readable either way, but taking the tile here keeps the handoff obvious.
      opts.onPointTile?.(source, String(url ?? ''))

      const mesh = buildPointQuads(source, tile, density)
      if (!mesh) continue
      quads.push(mesh)
      if (arrivalBudget > 0) {
        mesh.visible = false
        // Read by the render gate, which otherwise could not tell a held arrival from a
        // tile it hid itself.
        mesh.userData.pendingReveal = true
        pendingReveal.push(mesh)
      }
      const debugTile = (mesh.material as any)?.userData?.debugTile
      if (debugTile) debugTiles.push(debugTile)

      // TilesRenderer collected the tile's geometries and materials during
      // parseTile, which runs before this event fires, so anything created here
      // has to be registered for disposal by hand or it leaks on unload.
      const engineData = tile?.engineData
      if (Array.isArray(engineData?.geometry)) engineData.geometry.push(mesh.geometry)
      if (Array.isArray(engineData?.materials)) engineData.materials.push(mesh.material)
      // A pulled tile's point data too. material.dispose() does not free textures, and the
      // unload plugin's pass over the material only frees the GPU copy for a later
      // re-upload; this is what releases it when the tile is evicted.
      const pointData = (mesh.material as any)?.[POINT_DATA_PROPERTY]
      if (pointData && Array.isArray(engineData?.textures)) engineData.textures.push(pointData)

      // The quads hang under the original Points rather than replacing it: the
      // PNTS loader hands back that Points object *as* the tile root, so at this
      // point it still has no parent to swap it out of. Parenting also inherits
      // the tile transform for free. The carrier itself draws nothing.
      source.add(mesh)
      source.geometry.setDrawRange(0, 0)
      // An empty draw range stops the carrier *drawing*; it does not stop it being
      // rendered. Renderer._renderObjectDirect uploads a render object's attributes
      // (`_geometries.updateForRender`) before it ever asks `getDrawParameters` whether
      // there is anything to draw — so a parked carrier still minted a second GPU buffer
      // for the very same position and colour arrays the quad mesh below wraps. Double
      // the VRAM per tile, and twice three's vec3→vec4 colour repack, which is a
      // per-point JS loop and the single most expensive thing in bringing a tile online.
      //
      // The layers test is the right lever rather than `visible = false`: _projectObject
      // returns early on invisible objects and would take the quad child with it, while
      // a failed layers test skips only this object — the children loop sits outside that
      // branch. Nothing else in the viewer uses layers.
      //
      // The geometry stays readable, which it has to: sampleGroundZ, shadedPixelArea and
      // applyThinning all reach through `mesh.parent` for the tile's real point bounds.
      source.layers.disableAll()
      if (Array.isArray(source.material)) source.material.forEach((material: any) => material?.dispose?.())
      else (source.material as any)?.dispose?.()
    }
    tileStats.set(tile, { points, density, debugTiles, quads })
    recordArrival(performance.now() - arrivalStartedAt, points)
  })
  // Fired before 3d-tiles-renderer disposes the tile, while its scene is still whole. Both
  // queues that hold a tile's objects between its arrival and its first frame on screen
  // have to be told here: an evicted tile keeps its parentage (only its scene is detached
  // from the group, and a tile that is merely hidden is detached the same way), so nothing
  // downstream can tell a dead tile from a hidden one by looking at it.
  tiles.addEventListener('dispose-model', ({ scene, tile }: any) => {
    const stats = tileStats.get(tile)
    if (stats && pendingReveal.length > 0) {
      for (const mesh of stats.quads) {
        const at = pendingReveal.indexOf(mesh)
        if (at >= 0) pendingReveal.splice(at, 1)
        mesh.userData.pendingReveal = false
      }
    }
    if (opts.onPointTileDisposed) {
      scene?.traverse?.((object: any) => { if (object.isPoints) opts.onPointTileDisposed!(object) })
    }
    tileStats.delete(tile)
  })
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

  /** One candidate of the point-of-view selection: how far its box is from the eye, and
   *  how many points it carries. Pooled, the solver runs every frame of the load. */
  const povCandidates: { distance: number; points: number }[] = []
  let povCandidateCount = 0

  /**
   * How large the point-of-view sphere may be before the selection inside it exceeds the
   * point cap.
   *
   * The traversal cannot be told "stop at N points" — it decides tile by tile — but the
   * pipeline publishes `extras.aph.emittedPointCount` on every node, so what the landing
   * eye would select can be priced before a byte is fetched. This walks the tree the way
   * the traversal will (refine while the eye's error exceeds the target, external tileset
   * documents always), keeps every node whose box reaches the requested sphere, sorts them
   * by distance from the eye and adds their counts up from the centre outward. The first
   * node that would carry the total past the cap sets the radius: everything nearer is
   * inside, everything from there out is left for the camera-driven traversal after
   * landing.
   *
   * Only nodes already known are priced. The tree arrives as a chain of external
   * documents, so early frames see a partial tree and price it low; as documents land the
   * estimate grows and the radius tightens over a few frames. That is the right direction
   * — a too-large radius fetches a few tiles it then stops refining, never the reverse —
   * and the download order is nearest first, so the tiles it overshoots on are the far ones.
   *
   * Nodes the eye stands inside report distance 0 and are always in: they are the huge
   * `refine: ADD` ancestors that every frame at the landing draws anyway.
   */
  function solvePovRadius(): number {
    povCandidateCount = 0
    povPoints = 0
    const root = (tiles as any).root
    const info = (tiles as any).cameraInfo?.[0]
    if (!root || !info || !(info.sseDenominator > 0)) return Infinity
    const target = tiles.errorTarget
    const sphere = maskRegion.sphere
    const visit = (tile: any): void => {
      const volume = tile?.engineData?.boundingVolume
      if (!volume || !volume.intersectsSphere(sphere)) return
      const distance = volume.distanceToPoint(povEye)
      const points = tile?.extras?.aph?.emittedPointCount
      if (typeof points === 'number' && points > 0) {
        let entry = povCandidates[povCandidateCount]
        if (!entry) entry = povCandidates[povCandidateCount] = { distance: 0, points: 0 }
        entry.distance = distance
        entry.points = points
        povCandidateCount++
      }
      const error = distance === 0 ? Infinity : (tile.geometricError ?? 0) / (distance * info.sseDenominator)
      if (!(error > target) && !tile?.internal?.hasUnrenderableContent) return
      const children = tile.children
      if (!Array.isArray(children)) return
      for (let i = 0; i < children.length; i++) visit(children[i])
    }
    visit(root)
    const list = povCandidates.slice(0, povCandidateCount).sort((a, b) => a.distance - b.distance)
    // Console aid: the priced list and the eye it was priced from, for checking the cap.
    ;(tiles as any).__pov = { eye: povEye, list }
    let total = 0
    for (const entry of list) {
      if (total + entry.points > povBudget && entry.distance > 0) {
        povPoints = total
        // Just inside the first node that would break the cap, so that node's box misses
        // the sphere and everything nearer still reaches it.
        return Math.max(1, entry.distance * 0.999)
      }
      total += entry.points
    }
    povPoints = total
    return Infinity
  }

  /**
   * Take the selected tiles outside the inner sphere off the render list, and put the
   * ones inside back on it.
   *
   * Runs every frame in both states, not only while the gate is in force: a tile hidden
   * here can leave the frustum before the gate is switched off, and it comes back with
   * its quads still hidden — the flag lives on the mesh, not on the traversal. Walking
   * the selected set each frame heals that for the price of a hundred visibility reads.
   *
   * Invisible quads are the whole mechanism. `_projectObject` returns before an invisible
   * mesh reaches the render list, so three neither uploads its attributes nor builds its
   * pipeline; and the tile itself is untouched — still in `visibleTiles`, so the unload
   * plugin never fires and the cache keeps it, which is what "hidden but loaded" means.
   */
  function applyRenderGate(): void {
    renderGateHidden = 0
    renderGateTiles = 0
    for (const tile of tiles.visibleTiles) {
      const stats = tileStats.get(tile)
      if (!stats) continue
      renderGateTiles++
      const inside = !renderGateActive
        || Boolean((tile as any)?.engineData?.boundingVolume?.intersectsSphere(renderSphere))
      if (!inside) renderGateHidden++
      for (const mesh of stats.quads) {
        // An arrival still waiting its turn stays hidden whatever the gate says.
        const show = inside && mesh.userData.pendingReveal !== true
        if (mesh.visible !== show) mesh.visible = show
        // Safety net under refreshEffects: whatever path let a tile keep a graph built
        // under other effect flags, it is caught the frame it is drawn again.
        if (show && effectMaterialStale(mesh.material)) rebuildEffectMaterial(mesh.material)
        // The same for the dot mode, under setDotMode.
        const dot = dotState(mesh)
        if (show && dot && !sameDotMode(dot, dotMode)) applyDotMode(mesh, dotMode, tile)
      }
    }
  }

  return {
    tiles,
    group: tiles.group,
    debugVolume: requestVolumePlugin?.debugCounts
      ?? { blockedByCeiling: [], inside: [], outside: [], noVolume: [] },
    update() {
      loadGateCut = 0
      // The point-of-view load runs the mask at the largest radius the point cap allows;
      // everything else runs it at the radius asked for.
      if (maskActive) {
        maskRegion.sphere.radius = maskRadiusRequested
        if (povActive && Number.isFinite(povBudget)) {
          povRadius = solvePovRadius()
          maskRegion.sphere.radius = Math.min(maskRadiusRequested, povRadius)
        } else {
          povRadius = Infinity
        }
      }
      tiles.update()
      // Released after the traversal, so a tile that became invisible again while it was
      // waiting is simply dropped from the queue rather than shown for one frame.
      if (arrivalBudget > 0 && pendingReveal.length > 0) {
        let released = 0
        while (released < arrivalBudget && pendingReveal.length > 0) {
          const mesh = pendingReveal.shift()!
          mesh.userData.pendingReveal = false
          // Evicted tiles have already been taken out of the queue (see 'dispose-model'),
          // so everything here is still loaded.
          mesh.visible = true
          released++
        }
      }
      // After the release, so a tile released this frame is gated in this frame too.
      applyRenderGate()
    },
    setArrivalBudget(perFrame: number) {
      arrivalBudget = Math.max(0, Math.floor(perFrame))
      if (arrivalBudget === 0) {
        // Off has to mean *absent*, not "queue frozen": anything already waiting is shown
        // at once, so switching it off cannot leave holes on screen. The render gate
        // re-judges these in the next update(), before anything is drawn.
        for (const mesh of pendingReveal) {
          mesh.userData.pendingReveal = false
          mesh.visible = true
        }
        pendingReveal.length = 0
      }
    },
    setParseBudget(maxJobs: number) {
      parseBudget = Math.max(1, Math.floor(maxJobs))
      // Leaf loading deliberately runs the queue wide open; it restores this value on exit.
      if (!leafLoading) tiles.parseQueue.maxJobs = parseBudget
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
        // The live setting rather than the snapshot: the slider may have moved meanwhile.
        tiles.parseQueue.maxJobs = parseBudget
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
      // Every loaded tile, not only the ones in the scene group. A tile that is out of
      // view keeps its scene in the cache, detached from the group, and comes back with
      // whatever material it left with — so walking the group alone left the cached
      // tiles on the old setting until they happened to reload.
      tiles.forEachLoadedModel((model: THREE.Object3D) => {
        model.traverse((object: any) => applyMatrixPrecision(object.material))
      })
    },
    refreshEffects() {
      // Same registry as setHighPrecision, for the same reason: switching the dome off
      // and on used to leave every cached tile with the falloff compiled out, and those
      // tiles then drew their points at full size outside the sphere when they returned.
      // UnloadTilesPlugin still owns disposal; a rebuilt material just recompiles when
      // it is next drawn.
      tiles.forEachLoadedModel((model: THREE.Object3D) => {
        model.traverse((object: any) => rebuildEffectMaterial(object.material))
      })
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
      maskRadiusRequested = radius
    },
    setDotMode(mode) {
      dotMode = { ...mode }
      if (dotMode.feed === 'pulled' && dotMode.shape === 'quad') prepareSharedQuadIndex()
      let changed = 0
      // Every loaded tile, not just the visible ones — the lesson of the effect switch:
      // a tile parked in the cache keeps whatever it had and comes back with it.
      tiles.forEachLoadedModel((model: THREE.Object3D, tile: any) => {
        model.traverse((object: THREE.Object3D) => {
          if (isDotMesh(object) && applyDotMode(object, dotMode, tile)) changed++
        })
      })
      // Tiles still waiting for their reveal hang under a live tile, so the walk above has
      // them already.
      // Every loaded tile now draws with an instanced graph, and tiles still in flight build
      // in the new mode, so the cached pulled graphs only hold the last texture they drew.
      if (dotMode.feed === 'instanced') dropPulledCloudGraphs()
      return changed
    },
    dotMode: () => ({ ...dotMode }),
    setPovLoad(eyeWorld, maxPoints = Infinity) {
      if (!eyeWorld) { povActive = false; povRadius = Infinity; povPoints = 0; return }
      povActive = true
      povBudget = maxPoints > 0 ? maxPoints : Infinity
      // Same frame as the mask sphere; the bounding volumes live in the group's space.
      tiles.group.updateWorldMatrix(true, false)
      povEye.copy(eyeWorld)
      tiles.group.worldToLocal(povEye)
    },
    setRenderSphere(centerWorld, radius) {
      if (!centerWorld || !(radius > 0)) { renderGateActive = false; return }
      renderGateActive = true
      // Same frame as the mask sphere: the bounding volumes live in the tiles' own root
      // frame, which is the group's local space — lift included.
      tiles.group.updateWorldMatrix(true, false)
      renderSphere.center.copy(centerWorld)
      tiles.group.worldToLocal(renderSphere.center)
      renderSphere.radius = radius
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
          // A dot mesh is sampled through its instanced point attribute, which wraps the
          // carrier's own position array. A pulled dot mesh has no attributes, so it reads
          // that same array off its carrier directly — the carrier and the dot mesh share
          // one world matrix — which keeps the sample set identical in both feeds.
          const attribute = object.geometry?.getAttribute?.(POINT_POSITION_ATTRIBUTE)
            ?? (isDotMesh(object) ? (object.parent as any)?.geometry?.getAttribute?.('position') : null)
            ?? (object.isPoints ? object.geometry?.getAttribute?.('position') : null)
          if (!attribute || attribute.count === 0) return
          object.updateWorldMatrix(true, false)
          local.multiplyMatrices(enuInverse, object.matrixWorld)

          // Cheap reject: the tile's bounds in ENU versus the footprint disc. Only the
          // carrier's sphere describes the tile; a dot mesh's describes its corner
          // offsets. This used to tell them apart by radius alone (a real bound is over a
          // metre, the quad's corners 0.707) — which a triangle's 1.16 would have passed,
          // silently rejecting tiles against their local origin. So it now asks what the
          // object is first, and keeps the radius test too: a sub-metre carrier, a
          // one-point leaf say, was never disc-rejected and still is not. The dot mesh is
          // sampled unbounded, as it always was, so the sample set is exactly as before.
          const geometry = object.geometry
          if (object.isPoints) {
            if (!geometry.boundingSphere) geometry.computeBoundingSphere()
            const bounds = geometry.boundingSphere
            if (bounds && bounds.radius > 1) {
              point.copy(bounds.center).applyMatrix4(local)
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
        loadGateCut,
        renderGateHidden,
        renderGateTiles,
        povRadius,
        povPoints,
      }
    },
    applyEffectiveSpacing(rampMs) {
      /**
       * Size every point from the density of the whole stack at its spot.
       *
       * Refinement is ADD and the levels are a strict *partition*, not a pyramid of
       * copies: an internal node emits a representative sample and routes the remainder
       * to its children, and build_adaptive_point_hierarchy.py fails the build unless
       * `count == emitted + residualRouted`. p001 is carved out the same way, by
       * `ordinal % 1000 == 0`, with the adaptive tree taking everything else. So no point
       * is ever drawn twice, and every level genuinely adds detail.
       *
       * That fixes the arithmetic. Each node holds about the same point count and each
       * level quarters the footprint, so over ground refined k levels deep the stack
       * holds `1 + 4 + 16 + … + 4^k` node-loads against `4^k` for the finest level alone
       * — a ratio converging on **4/3**. In spacing terms the whole stack sits
       * `sqrt(3)/2 = 0.866` of the finest level's spacing apart. Densities add;
       * spacings do not.
       *
       * Hence the sum below rather than a minimum. An earlier version took the finest
       * spacing over the footprint, which ignored the other 25% of the points and drew
       * every dot 15% too wide.
       *
       * The two directions are not symmetric, and that is the whole shape of this pass:
       *
       *  - **Above.** The drawn ancestors cover this tile completely — they are its own
       *    root-to-leaf chain — so their density always counts. This is the term that
       *    reaches the leaves, which have nothing below them and carry 75% of the points.
       *  - **Below.** Descendants cover only the part of the tile that is actually
       *    refined, so their density counts in proportion to `covered`. Crediting it in
       *    full would shrink an ancestor's dots over ground nothing finer is drawing, and
       *    that opens holes rather than closing them.
       *
       * One slot per drawn level underneath, not one per descendant: four drawn children
       * do not make the ground under any one of them four times denser. The slot index is
       * the number of *drawn* levels crossed on the way up, so structural nodes in the
       * tileset cannot shift it.
       */
      const nowMs = performance.now()
      const dtMs = lastSpacingAt === 0 ? 0 : Math.min(100, nowMs - lastSpacingAt)
      lastSpacingAt = nowMs

      spacingEntries.length = 0
      spacingByTile.clear()
      for (const tile of tiles.visibleTiles) {
        const stats = tileStats.get(tile)
        if (!stats?.quads.length) continue
        const own = (stats.quads[0].material as any)?.userData?.pointSpacingM
        if (!(own > 0)) continue
        // Only the children the camera can actually see are counted, on both sides of the
        // fraction. A d1 node spans a kilometre and the frame at canopy height spans a
        // hundred metres, so three of its four children are routinely outside the frustum
        // — ground that is not drawn at all and needs no size. Counting those as
        // "uncovered" is what held the first version of this back: measured at the
        // arrival view it put d1 at one quarter covered when the single child in view was
        // drawn, i.e. fully covered, and the level stayed pinned at the ceiling.
        const children = (tile as any)?.children as any[] | undefined
        let inView = 0
        let drawn = 0
        if (Array.isArray(children)) {
          for (const child of children) {
            if (!child?.traversal?.inFrustum) continue
            inView++
            if (tiles.visibleTiles.has(child)) drawn++
          }
        }
        const entry = takeSpacingEntry(spacingEntries.length)
        entry.tile = tile
        entry.quads = stats.quads
        entry.own = own
        entry.covered = inView ? drawn / inView : 0
        spacingEntries.push(entry)
        spacingByTile.set(tile, entry)
      }
      // One walk up the parent chain feeds both directions at once: the ancestor's
      // density lands on this tile, and this tile's spacing lands in the ancestor's slot
      // for its level. Linear in visible tiles times tree depth, and a tile whose parent
      // is off screen costs nothing.
      for (const entry of spacingEntries) {
        let node = (entry.tile as any)?.parent
        let level = 1
        while (node) {
          const ancestor = spacingByTile.get(node)
          if (ancestor) {
            entry.densityAbove += 1 / (ancestor.own * ancestor.own)
            if (level < SPACING_LEVELS) {
              const held = ancestor.below[level]
              if (held === 0 || entry.own < held) ancestor.below[level] = entry.own
            }
            level++
          }
          node = node.parent
        }
      }

      let shrunk = 0
      for (const entry of spacingEntries) {
        // Bare: this tile plus everything above it, which is true everywhere on it.
        // Full: the same plus every drawn level below, which is true only where refined.
        const bare = 1 / (entry.own * entry.own) + entry.densityAbove
        let below = 0
        for (let i = 1; i < SPACING_LEVELS; i++) {
          const spacing = entry.below[i]
          if (spacing > 0) below += 1 / (spacing * spacing)
        }
        const spacingBare = 1 / Math.sqrt(bare)
        const target = below > 0
          ? spacingBare + (1 / Math.sqrt(bare + below) - spacingBare) * entry.covered
          : spacingBare
        for (const mesh of entry.quads) {
          const uniformNode = (mesh.material as any)?.userData?.spacingMetres
          if (!uniformNode) continue
          // Eased for the same reason the thinning keep fraction is, and through the same
          // constant: `covered` is recomputed every frame and flips the instant a child
          // finishes downloading or leaves the frustum. Undamped, that steps the dot
          // width of a whole level between frames, continuously, while the camera moves —
          // which is the stutter the dissolve was built to remove, arriving by a second
          // route. A tile seen for the first time starts *at* its target.
          //
          // Asymmetric, and the asymmetry is the whole point: the ease applies only while
          // the dots are getting *smaller*. Growing takes effect on the frame it is asked
          // for.
          //
          // Both directions were eased at first, and a drive test caught what that costs.
          // Coverage falls the moment a child leaves the frustum, so the tile becomes the
          // finest layer over that ground again and must go back to its own size at once;
          // easing held it small for the length of the ramp instead. Measured over 16k
          // frames of hard orbiting, 153 of them drew a tile smaller than its coverage
          // earns — worst case a d1 node 50% covered but still drawn 94% of the way to
          // the finest spacing, dots roughly fourteen times too small over ground nothing
          // else was covering. Thin patches during a fast turn, which is the one artifact
          // this whole stage exists to remove.
          //
          // The direction that needed damping is the other one. A tile becoming covered is
          // the density pulse the dissolve was built for, and it is safe to defer: a dot
          // that is briefly too wide costs a little fill, a dot that is briefly too narrow
          // costs a hole.
          const previous = (mesh.material as any).userData.effectiveSpacingM
          const shrinking = previous !== undefined && target < previous
          const eased = shrinking && dtMs > 0 && rampMs > 0
            ? previous + (target - previous) * (1 - Math.exp(-dtMs / rampMs))
            : target
          ;(mesh.material as any).userData.effectiveSpacingM = eased
          uniformNode.value = eased
        }
        if (target < entry.own * 0.999) shrunk++
      }
      return { shrunk, tiles: spacingEntries.length }
    },
    reloadTiles() {
      const cache = (tiles as any).lruCache
      const itemList: any[] = cache?.itemList
      if (!Array.isArray(itemList)) return 0
      // A copy, because `remove` splices the very list this iterates. `remove` is the
      // unconditional path: `unloadUnusedContent` respects `minSize`, and with a floor of
      // 900 tiles against a few dozen resident it would decline to unload anything at all.
      const doomed = itemList.slice()
      let dropped = 0
      for (const item of doomed) if (cache.remove(item)) dropped++
      // `tileStats` and `pendingReveal` need no clearing: `dispose-model` deletes each
      // tile's entry and takes its meshes out of the queue as the removals fire. Cleared
      // anyway, as a guard for any tile disposed without the event.
      pendingReveal.length = 0
      return dropped
    },
    applyThinning(settings) {
      // Read every frame so a tile parsed after the toggle moves gets the right treatment.
      // A tile that arrived while thinning was off keeps its original order and is drawn
      // whole rather than as a biased wedge — see the `orderIsFair` guard below. It heals
      // on reload, which is what the toggle is for.
      fairOrderWanted = settings !== null
      let drawn = 0
      let loaded = 0
      if (!settings) {
        // Off: every tile back to its full buffer and its own spacing.
        for (const tile of tiles.visibleTiles) {
          const stats = tileStats.get(tile)
          if (!stats) continue
          loaded += stats.points
          for (const mesh of stats.quads) {
            const full = loadedPoints(mesh)
            setDrawnPoints(mesh, full)
            const scale = (mesh.material as any)?.userData?.thinScale
            if (scale) scale.value = 1
            // Forget the ramp state too, or switching thinning back on would fade down
            // from wherever it happened to be rather than from the full tile.
            const dot = dotState(mesh)
            if (dot) dot.keepNow = undefined
            // Loaded but off the render list by the dome's gate: not drawn, not counted.
            if (mesh.visible) drawn += full
          }
        }
        return { drawn, loaded }
      }

      // Real elapsed time, so the ramp below is frame-rate independent. Clamped because a
      // backgrounded tab returns a gap that would otherwise snap every tile straight to
      // its target and undo the point of damping it.
      const nowMs = performance.now()
      const dtMs = lastThinningAt === 0 ? 0 : Math.min(100, nowMs - lastThinningAt)
      lastThinningAt = nowMs

      camera.getWorldDirection(coverForward)
      for (const tile of tiles.visibleTiles) {
        const stats = tileStats.get(tile)
        if (!stats) continue
        loaded += stats.points
        // A tile with any of its children also on screen is an ancestor under a finer
        // layer, and the cheapest place to take points away from — but not because they
        // are duplicates. The levels are a strict partition (see applyEffectiveSpacing):
        // an ancestor's points land *between* its children's, never on top of them, so
        // this is discarding real measurements. It is cheap because over fully refined
        // ground the whole stack is only 4/3 the density of its deepest level, so the
        // ancestors are a quarter of the points and dropping them all coarsens the local
        // spacing by about 15%. A quality trade with a good exchange rate, not free.
        const children = (tile as any)?.children as any[] | undefined
        const covered = Array.isArray(children)
          && children.some((child) => tiles.visibleTiles.has(child))

        for (const mesh of stats.quads) {
          const dot = dotState(mesh)
          const full = loadedPoints(mesh)
          const spacingM = (mesh.material as any)?.userData?.pointSpacingM
          const scale = (mesh.material as any)?.userData?.thinScale
          // Off the render list by the dome's gate. Its keep fraction is left where it
          // was — nothing is drawn, so nothing needs deciding — and it is not counted.
          if (!mesh.visible) continue
          if (!dot || !full || !(spacingM > 0) || !scale) { drawn += drawnPoints(mesh); continue }
          // A tile loaded while thinning was off skipped its shuffle, so its points are still
          // in the tile's own spatially clustered order and a prefix of them is one lobe of
          // the tile rather than a sample of it. Draw it whole instead: the alternative is a
          // wedge of canopy with the rest of the tile missing.
          //
          // Left to heal itself rather than shuffled here — that would cost 4-12 ms in the
          // frame the toggle was hit, across every resident tile (hundreds), and it would
          // desynchronise the colours, which were copied at parse in the pre-shuffle order.
          // Tiles churn, and each one that reloads comes back thinnable.
          if (dot.orderIsFair !== true) {
            setDrawnPoints(mesh, full)
            scale.value = 1
            drawn += full
            continue
          }

          const carrier = mesh.parent as THREE.Object3D | null
          const carrierGeometry = carrier ? (carrier as any).geometry : null
          if (carrierGeometry && !carrierGeometry.boundingSphere) carrierGeometry.computeBoundingSphere()
          const bounds = carrierGeometry?.boundingSphere
          let keep = 1
          if (bounds) {
            coverCentre.copy(bounds.center).applyMatrix4(carrier!.matrixWorld)
            const depth = Math.max(coverCentre.sub(camera.position).dot(coverForward), camera.near)
            // How far apart this tile's points land on screen, against how far apart they
            // are wanted. Below the target the tile is finer than anything can be seen,
            // and the surplus is the square of the ratio because the spacing is in two
            // directions.
            const projPx = spacingM * settings.pxPerMetre / depth
            keep = Math.min(1, (projPx / settings.targetPx) ** 2)
            if (covered) keep *= settings.ancestorKeep
            // The ramp multiplies the *whole* decision rather than any one term, so at
            // ramp 0 the result is exactly 1 — the near field is untouched by
            // construction, not merely thinned a little. smoothstep rather than a linear
            // fade so neither end has a corner where the density visibly starts moving.
            const span = Math.max(1, settings.farM - settings.nearM)
            const x = Math.min(1, Math.max(0, (depth - settings.nearM) / span))
            keep = 1 + (keep - 1) * (x * x * (3 - 2 * x))
          }
          // A floor, because a tile that draws nothing at all pops back in as a block the
          // moment the camera moves, and one point in a hundred still reads as texture.
          keep = Math.max(settings.minKeep, Math.min(1, keep))
          // Ease toward the target instead of jumping to it.
          //
          // `covered` is a boolean recomputed every frame — a tile counts as covered the
          // instant the *first* of its children finishes downloading, and stops counting
          // the instant that child leaves the frustum. Undamped that is a step change in
          // both the drawn count and the dot width, firing continuously while the camera
          // moves and while tiles stream, which is what reads as the cloud "stuttering"
          // even at a perfectly steady frame rate.
          //
          // Exponential and driven by real elapsed time rather than a per-frame factor,
          // so the fade takes the same wall-clock time at 60 and at 165 Hz. A tile seen
          // for the first time starts *at* its target: fading in from full would draw
          // more points than asked for in exactly the frames a new tile already costs
          // the most.
          //
          // The prefix draw is what makes this a clean dissolve rather than a shimmer —
          // a ramp only ever adds or removes points at the tail, and never changes which
          // of the surviving points are on screen.
          const previousKeep = dot.keepNow
          if (previousKeep !== undefined && dtMs > 0 && settings.rampMs > 0) {
            keep = previousKeep + (keep - previousKeep) * (1 - Math.exp(-dtMs / settings.rampMs))
          }
          dot.keepNow = keep
          const count = Math.max(1, Math.round(full * keep))
          setDrawnPoints(mesh, count)
          // Survivors stand in for the ones that went, so they are drawn as wide as the
          // gap they now have to cover. Without this the ground thins into holes instead
          // of staying covered.
          //
          // Area, not width: dropping to a quarter of the points leaves each survivor
          // four times the ground to cover, which is twice the diameter.
          //
          // Capped, because the compensation overshoots long before the thinning does.
          // Where the keep fraction bottoms out the exact figure asks for about 7x, and a
          // 2.5 px dot drawn at 17 px stops reading as canopy and starts reading as a
          // quilt of blobs along the horizon — visibly worse than the gaps it was there
          // to fill. Past the cap the far field is allowed to go slightly open instead,
          // which at that distance reads as texture.
          scale.value = Math.min(Math.sqrt(full / count), settings.maxWiden)
          drawn += count
        }
      }
      return { drawn, loaded }
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
          // Off the render list by the dome's gate: shades nothing, so it is not billed.
          if (!mesh.visible) continue
          const instances = drawnPoints(mesh)
          if (!instances) continue
          // The effective spacing, not the tile's own: that is what the uniform holds and
          // therefore what the shader draws. Billing `pointSpacingM` here would put this
          // readout back where it was before the widening fix — reporting a diameter the
          // frame is not using.
          const spacingM = (mesh.material as any)?.userData?.effectiveSpacingM
            ?? (mesh.material as any)?.userData?.pointSpacingM
          if (!(spacingM > 0)) continue
          // The carrier this mesh hangs under still holds the tile's real point bounds;
          // the dot geometry's own sphere describes the corner offsets and says nothing
          // about where the tile is (see sampleGroundZ for the same trap).
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
          // The widening is part of the drawn size, so it is part of the painted area.
          const thinScale = (mesh.material as any)?.userData?.thinScale?.value ?? 1
          const diameter = diameterPx(spacingM, Math.max(depth, camera.near), thinScale)
          // The primitive's own area: d² for the quad, 1.325 d² for the triangle, which is
          // rasterised in full before the round-dot cut throws its corners away.
          areaPx += instances * diameter * diameter * dotAreaFactor(mesh)
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
