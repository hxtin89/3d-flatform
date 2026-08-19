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
  /** Tiles whose error was left at or below the core factor this frame. */
  core: number
  /** Tiles pushed toward the edge factor this frame. */
  periphery: number
  /** Screen-space error the core and the corner resolve to, given the live target. */
  coreSse: number
  edgeSse: number
}

export interface Foveation {
  readonly settings: FoveationSettings
  /** Reset the per-frame counters. Call immediately before the tiles update. */
  beginFrame(): void
  stats(): FoveationStats
  dispose(): void
}

const scratchSphere = new THREE.Sphere()
const scratchCentre = new THREE.Vector3()

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
  // Traversal is skipped entirely while the camera holds still (UpdateOnChangePlugin),
  // so the live counters read zero exactly when the view is worth reading. Keep the
  // last frame that actually evaluated tiles instead of reporting an empty split.
  let lastCore = 0
  let lastPeriphery = 0

  /** The screen-space error multiplier this tile earns from where it lands. */
  const factorFor = (tile: any): number => {
    const volume = tile?.engineData?.boundingVolume
    if (!volume) return 1
    volume.getSphere(scratchSphere)

    // View space, so a tile behind the camera is recognisable as such — projecting
    // it would mirror it back into frame and hand the periphery a core budget.
    scratchCentre.copy(scratchSphere.center).applyMatrix4(camera.matrixWorldInverse)
    const forward = -scratchCentre.z
    if (!(forward > 1e-3)) return settings.edgeFactor

    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
    const aspect = camera.aspect || 1
    // Everything below is in half-screen-heights, so the core stays a circle on
    // screen instead of an ellipse stretched by the aspect ratio.
    const y = scratchCentre.y / (forward * tanHalf)
    const x = scratchCentre.x / (forward * tanHalf)
    const extent = scratchSphere.radius / (forward * tanHalf)

    // Subtract the tile's own projected size: a near foreground tile spans much of
    // the image, and judging it by its centre alone would coarsen ground the viewer
    // is standing on.
    const distance = Math.max(Math.hypot(x, y - settings.offsetY) - extent, 0)
    const corner = Math.hypot(aspect, 1)
    const ramp = smoothstep01((distance - settings.radius) / Math.max(corner - settings.radius, 1e-3))
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
      if (core + periphery > 0) {
        lastCore = core
        lastPeriphery = periphery
      }
      core = 0
      periphery = 0
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
