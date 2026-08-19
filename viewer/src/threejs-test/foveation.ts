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
  /** Core radius, measured in half screen heights out from the fovea centre. */
  radius: number
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
  /** Projected error in pixels, before foveation. */
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
   * The nearest corner is what the LOD decision uses, deliberately not the tile's
   * centre nor its bounding sphere. Both shortcuts were tried and both fail on this
   * dataset: the OBB bounding sphere of a single leaf spans a whole screen height
   * because its diagonal includes the canopy, so subtracting it pulled every tile
   * into the core; and judging by the centre alone puts more than half the tiles
   * outside the frame even while they cover the middle of it, because a large tile
   * straddling the view has its centre off to one side.
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
      footprint.nearest = Math.min(footprint.nearest, Math.hypot(x, y - settings.offsetY))
    }
    footprint.valid = true
    return footprint
  }

  /** How far along the core-to-corner ramp a footprint distance sits. */
  const rampAt = (nearest: number): number => {
    const corner = Math.hypot(camera.aspect || 1, 1)
    return smoothstep01((nearest - settings.radius) / Math.max(corner - settings.radius, 1e-3))
  }

  /** The screen-space error multiplier this tile earns from where it lands. */
  const factorFor = (tile: any): number => {
    const shape = measure(tile)
    if (!shape.valid) return 1
    const ramp = rampAt(shape.nearest)
    if (ramp <= 0) core++
    else periphery++
    return settings.centreFactor + (settings.edgeFactor - settings.centreFactor) * ramp
  }

  const original = tiles.calculateTileViewError.bind(tiles)
  tiles.calculateTileViewError = (tile: any, target: any) => {
    original(tile, target)
    if (!settings.enabled || !target.inView) return
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
          error: tile.traversal?.error ?? 0,
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
    },
  }
}
