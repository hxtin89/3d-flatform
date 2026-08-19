import * as THREE from 'three'

import { EXPERIENCE_CONFIG } from './config'

/**
 * Foveated level of detail: spend the point budget where the eye is looking.
 *
 * The renderer already scales detail with *distance* — a tile far from the camera
 * has a small projected error and refuses to refine. What it does not know is
 * *where on the screen* a tile lands, so the corners of the image are refined as
 * hard as the middle even though nobody is reading detail out of them. Measured on
 * the Peru dataset, 33% of the drawn points sit more than 40 degrees off the view
 * axis.
 *
 * The hook is one multiplication. A tile refines while its projected error exceeds
 * `tiles.errorTarget`, so dividing the error by a factor is the same as multiplying
 * that tile's screen-space error target by it — the periphery behaves as if the
 * whole renderer had been set coarser, and the core as if it had been set finer,
 * without touching the target the adaptive-quality controller owns.
 *
 * The fovea is placed in normalised device coordinates, i.e. directly on the
 * projected image, rather than on a ground point under the screen centre. That is
 * deliberate: the centre ray hits the ground kilometres further away for every
 * degree the camera pitches toward the horizon, so a world-space anchor jitters
 * wildly under tilt, while an image-space one cannot.
 */
export interface FoveationSettings {
  enabled: boolean
  /** Screen-space error multiplier inside the core. Below 1 is finer than the band. */
  centreFactor: number
  /** Screen-space error multiplier at the far corner of the image. Above 1 is coarser. */
  edgeFactor: number
  /**
   * Half extents of the core, in half screen heights. Equal values give a round
   * core; wide and low gives a band, which is what a tilted camera wants — the
   * interesting ground runs across the frame, not in a disc around one point.
   */
  width: number
  height: number
  /**
   * How wide the blend from the core factor to the corner factor is, in the same
   * unit. Small is an abrupt ring, large spreads the loss out over the whole frame.
   */
  falloff: number
  /**
   * Where the fovea sits on the projected image: -1 is the bottom edge, 0 the
   * centre, +1 the top. Under tilt the near ground fills the lower screen and the
   * horizon the upper, so the best place for the core is an open question — hence a
   * slider rather than a constant.
   */
  offsetY: number
}

export interface FoveationStats {
  /** Tiles left at the core factor, from the fullest traversal of the last second. */
  core: number
  /** Tiles pushed toward the edge factor, same traversal. */
  periphery: number
  /** Screen-space error the core and the corner resolve to, given the live target. */
  coreSse: number
  edgeSse: number
}

/**
 * One visible tile as it lands on the image, for the debug overlay. All bounds are
 * in half screen heights measured from the image centre — x to the right, y up —
 * the same units the core radius is given in, so the two are directly comparable.
 */
export interface TileRegion {
  minX: number
  maxX: number
  minY: number
  maxY: number
  /** 0 inside the core, 1 at the corner budget. */
  ramp: number
  depth: number
  /** A leaf carries error 0 and can never be coarsened, whatever the ramp says. */
  leaf: boolean
  /**
   * Projected error in pixels *before* foveation scaled it, so it can be read
   * against the two screen-space error targets the readout names.
   */
  error: number
  /** The tile straddles the view plane, so its screen bounds are not meaningful. */
  straddles: boolean
}

export interface Foveation {
  readonly settings: FoveationSettings
  /** Reset the per-frame counters. Call immediately before the tiles update. */
  beginFrame(): void
  stats(): FoveationStats
  /** Every currently drawn tile, measured the same way the LOD decision measures it. */
  regions(): TileRegion[]
  /**
   * Wireframe boxes around every drawn tile, in the scene rather than on the glass.
   * The screen overlay can only draw each tile's axis-aligned screen bounds, which
   * for an oblique box is larger than its silhouette and makes neighbours look as
   * though they overlap; these are the real volumes.
   */
  setBoxesVisible(visible: boolean): void
  /** Rebuild the boxes from the current tile set. No-op while they are hidden. */
  updateBoxes(): void
  dispose(): void
}

const scratchBox = new THREE.Box3()
const scratchObbMatrix = new THREE.Matrix4()
const scratchCorner = new THREE.Vector3()

const smoothstep01 = (x: number) => {
  const t = Math.min(Math.max(x, 0), 1)
  return t * t * (3 - 2 * t)
}

export function createFoveation(
  tiles: any,
  camera: THREE.PerspectiveCamera,
  settings: FoveationSettings = { ...EXPERIENCE_CONFIG.lod.foveation },
): Foveation {
  let core = 0
  let periphery = 0
  // Most frames re-walk the whole selected set, but plenty evaluate a handful of
  // tiles or none, and a readout of the latest frame would sit at "1 core / 0
  // outside". Publish the fullest traversal of the last second instead.
  let lastCore = 0
  let lastPeriphery = 0
  let bestCore = 0
  let bestPeriphery = 0
  let windowStartMs = 0

  // Tile bounding volumes live in the tiles' own root frame, not in world space —
  // the renderer pushes the camera down into that frame rather than lifting the
  // volumes out of it (see TilesRenderer.calculateTileViewError). Going to view
  // space with the camera matrix alone puts nearly every tile behind the camera,
  // which silently collapses this whole function into its bail-out branch.
  const localToView = new THREE.Matrix4()

  const refreshFrame = () => {
    camera.updateMatrixWorld()
    tiles.group.updateWorldMatrix(true, false)
    localToView.multiplyMatrices(camera.matrixWorldInverse, tiles.group.matrixWorld)
  }
  refreshFrame()

  /**
   * Where a tile lands on the image, measured from its eight projected corners.
   *
   * The LOD decision uses the distance from the fovea centre to the tile's screen
   * bounds — zero when the tile covers the fovea. Three cheaper measures were tried
   * and all three fail on this dataset:
   *
   * - The bounding sphere: the OBB sphere of a single leaf spans a whole screen
   *   height, because its diagonal includes the canopy. Subtracting it pulled every
   *   tile into the core and the radius stopped doing anything.
   * - The tile centre: more than half the tiles have their centre outside the frame
   *   while still covering the middle of it, because a large tile straddling the view
   *   sits off to one side.
   * - The nearest of the eight corners: for a tile that *contains* the fovea the
   *   corners are all out at the image edge, so the tiles the core must refine
   *   through were classed as periphery and coarsened — which starved the core of
   *   the very detail foveation is supposed to protect.
   */
  const footprint = {
    minX: 0, maxX: 0, minY: 0, maxY: 0, nearest: Infinity, straddles: false, valid: false,
  }

  const measure = (tile: any): typeof footprint => {
    footprint.valid = false
    footprint.straddles = false
    footprint.nearest = Infinity
    const volume = tile?.engineData?.boundingVolume
    if (!volume) return footprint
    volume.getOBB(scratchBox, scratchObbMatrix)
    scratchObbMatrix.premultiply(localToView)

    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
    const { min, max } = scratchBox
    footprint.minX = Infinity
    footprint.maxX = -Infinity
    footprint.minY = Infinity
    footprint.maxY = -Infinity
    for (let i = 0; i < 8; i++) {
      scratchCorner
        .set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
        .applyMatrix4(scratchObbMatrix)
      const forward = -scratchCorner.z
      // A corner at or behind the camera means the tile straddles the view plane, so
      // it reaches the core whatever its other corners say — and its screen bounds
      // are not a rectangle any more.
      if (!(forward > 1e-3)) {
        footprint.straddles = true
        footprint.nearest = 0
        footprint.valid = true
        return footprint
      }
      // Half screen heights, so the core stays a circle on screen rather than an
      // ellipse stretched by the aspect ratio.
      const x = scratchCorner.x / (forward * tanHalf)
      const y = scratchCorner.y / (forward * tanHalf)
      footprint.minX = Math.min(footprint.minX, x)
      footprint.maxX = Math.max(footprint.maxX, x)
      footprint.minY = Math.min(footprint.minY, y)
      footprint.maxY = Math.max(footprint.maxY, y)
    }
    // Gap between two rectangles: the tile's screen bounds and the core. Zero while
    // they overlap, however far out the tile's own corners reach. The tile box is the
    // bounds of the projected corners rather than their hull, which errs toward
    // keeping the core budget — the safe direction.
    const coreMinY = settings.offsetY - settings.height
    const coreMaxY = settings.offsetY + settings.height
    const dx = Math.max(footprint.minX - settings.width, -settings.width - footprint.maxX, 0)
    const dy = Math.max(coreMinY - footprint.maxY, footprint.minY - coreMaxY, 0)
    footprint.nearest = Math.hypot(dx, dy)
    footprint.valid = true
    return footprint
  }

  /**
   * How far along the ramp a gap sits. The gap is already measured from the edge of
   * the core, so the ramp starts at zero — which makes every iso-line of this
   * function a rectangle rounded by the gap, and that is exactly what the guides
   * draw.
   */
  const rampAt = (gap: number): number =>
    smoothstep01(gap / Math.max(settings.falloff, 1e-3))

  /** The screen-space error multiplier this tile earns from where it lands. */
  const factorFor = (tile: any): number => {
    const shape = measure(tile)
    if (!shape.valid) return 1
    const ramp = rampAt(shape.nearest)
    if (ramp <= 0) core++
    else periphery++
    return settings.centreFactor + (settings.edgeFactor - settings.centreFactor) * ramp
  }

  // Parented next to the tiles group rather than inside it: streaming applies the
  // matrix-precision context to every material under that group, and these lines are
  // not node materials built for it.
  const boxGroup = new THREE.Group()
  boxGroup.name = 'foveation-tile-boxes'
  boxGroup.matrixAutoUpdate = false
  boxGroup.visible = false
  boxGroup.renderOrder = 10
  tiles.group.parent?.add(boxGroup)
  const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))
  const boxPool: THREE.LineSegments[] = []
  const boxSize = new THREE.Vector3()
  const boxCentre = new THREE.Vector3()
  const boxLocal = new THREE.Matrix4()

  // What the renderer keeps on the tile is the error *after* the division below, so
  // at a 512x corner factor a peripheral tile reads a fraction of a pixel — which in
  // the debug grid looks like an extremely fine tile rather than a heavily discounted
  // one. Keep the unscaled value for the overlay to show.
  const rawError = new WeakMap<object, number>()
  const original = tiles.calculateTileViewError.bind(tiles)
  tiles.calculateTileViewError = (tile: any, target: any) => {
    original(tile, target)
    if (!settings.enabled || !target.inView) return
    rawError.set(tile, target.error)
    const factor = factorFor(tile)
    if (factor > 0) target.error /= factor
  }

  return {
    settings,
    beginFrame() {
      refreshFrame()
      if (core + periphery > bestCore + bestPeriphery) {
        bestCore = core
        bestPeriphery = periphery
      }
      const now = performance.now()
      if (now - windowStartMs > 1000) {
        windowStartMs = now
        lastCore = bestCore
        lastPeriphery = bestPeriphery
        bestCore = 0
        bestPeriphery = 0
      }
      core = 0
      periphery = 0
    },
    setBoxesVisible(visible: boolean) {
      boxGroup.visible = visible
      if (!visible) for (const box of boxPool) box.visible = false
    },
    updateBoxes() {
      if (!boxGroup.visible) return
      // The OBBs are given in the tiles' own frame, so the group carries the tiles'
      // transform and every box below it is plain local geometry.
      tiles.group.updateMatrix()
      boxGroup.matrix.copy(tiles.group.matrix)
      boxGroup.matrixWorldNeedsUpdate = true
      let used = 0
      for (const tile of tiles.visibleTiles as Set<any>) {
        const volume = tile?.engineData?.boundingVolume
        if (!volume) continue
        const shape = measure(tile)
        if (!shape.valid) continue
        volume.getOBB(scratchBox, scratchObbMatrix)
        scratchBox.getSize(boxSize)
        scratchBox.getCenter(boxCentre)
        let box = boxPool[used]
        if (!box) {
          box = new THREE.LineSegments(boxEdges, new THREE.LineBasicMaterial({ transparent: true }))
          box.matrixAutoUpdate = false
          box.frustumCulled = false
          boxPool.push(box)
          boxGroup.add(box)
        }
        const ramp = rampAt(shape.nearest)
        const material = box.material as THREE.LineBasicMaterial
        // Same reading as the screen overlay: cyan at the core budget, orange at the
        // corner budget.
        material.color.setHSL((190 - ramp * 160) / 360, 0.9, 0.6)
        material.opacity = 0.55 + ramp * 0.4
        boxLocal.makeTranslation(boxCentre.x, boxCentre.y, boxCentre.z)
        boxLocal.scale(boxSize)
        box.matrix.multiplyMatrices(scratchObbMatrix, boxLocal)
        box.matrixWorldNeedsUpdate = true
        box.visible = true
        used++
      }
      for (let i = used; i < boxPool.length; i++) boxPool[i].visible = false
    },
    regions() {
      refreshFrame()
      const out: TileRegion[] = []
      for (const tile of tiles.visibleTiles as Set<any>) {
        const shape = measure(tile)
        if (!shape.valid) continue
        out.push({
          minX: shape.minX,
          maxX: shape.maxX,
          minY: shape.minY,
          maxY: shape.maxY,
          ramp: rampAt(shape.nearest),
          depth: tile.internal?.depth ?? 0,
          leaf: (tile.children?.length ?? 0) === 0,
          error: rawError.get(tile) ?? tile.traversal?.error ?? 0,
          straddles: shape.straddles,
        })
      }
      return out
    },
    stats() {
      const target = tiles.errorTarget || 0
      return {
        core: lastCore,
        periphery: lastPeriphery,
        coreSse: target * settings.centreFactor,
        edgeSse: target * settings.edgeFactor,
      }
    },
    dispose() {
      delete tiles.calculateTileViewError
      boxGroup.removeFromParent()
      for (const box of boxPool) (box.material as THREE.Material).dispose()
      boxEdges.dispose()
    },
  }
}
