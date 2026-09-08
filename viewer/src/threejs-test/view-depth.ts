import * as THREE from 'three'

import { EXPERIENCE_CONFIG } from './config'

/**
 * Measure a tile's range for the screen-space error along the view axis instead of
 * straight through space.
 *
 * The library computes `error = geometricError / (distance * sseDenominator)` with
 * `distance = boundingVolume.distanceToPoint(cameraPosition)` — a *radial* distance.
 * But what decides how large a point spacing lands on screen is the perspective
 * divide, and that divides by **depth**: the component along the view axis. For
 * anything off-axis the radius is the longer of the two, by exactly 1/cos of the
 * angle off-axis, so those tiles are handed a smaller error than they earn and stop
 * refining too early. The effect is nil at the centre of the frame and grows towards
 * the corners — at 60° vertical fov on a 16:9 canvas the corner sits about 50° off
 * the axis, where the radius overstates the depth by ~1.55x.
 *
 * The correction is therefore a pure multiplier on the error:
 *
 *     error *= radius / depth  =  1 / cos(angle off the view axis)
 *
 * and it only ever *raises* the error, so it only ever buys detail — at the edges of
 * the frame, which is where it was being dropped.
 *
 * Unlike a frame-time feedback this cannot oscillate: it reads camera and tile
 * geometry only, so a still camera gives a still result every frame.
 *
 * Note this also settles a disagreement inside our own pipeline. The drawn point size
 * is built in `createCloudMaterial` from `positionView.z` — true depth — while
 * refinement was using the radius. The two now agree on what "how far away" means.
 *
 * ON by default: it corrects an error rather than trading quality for speed. The cost
 * is real but bounded and one-sided — tiles near the frame edge refine one step
 * further than before, so expect a modest rise in tile and point count and none at
 * the centre of the view.
 *
 * Both distances are measured to the **same point**: the point of the tile's box
 * closest to the camera, which is the one the library's own radius runs to. Measuring
 * the angle to the tile's centre instead looks equivalent and is not — `refine: ADD`
 * keeps the huge ancestor nodes on screen at every altitude, and from 80 m a 2 km d0
 * box has its centre near 90° off the axis while only a corner of it is in view. Doing
 * it that way put most visible tiles on the `minCosine` clamp (measured: median 2.0
 * against a frustum corner worth 1.37) and inflated their error for no reason.
 *
 * A camera inside the box is the degenerate case, and it is common here: canopy boxes
 * are ~200 m tall, so at 80 m the camera really is inside the coarse ones. The closest
 * point is then the camera itself, both distances collapse to zero, and this returns 1 —
 * which changes nothing, because the library already reports `error = Infinity` for a
 * zero radius and the tile refines maximally either way.
 *
 * Foveation pulls the other way by construction: its `edgeFactor` coarsens the
 * periphery, which is exactly where this adds detail. Enabling both leaves the net edge
 * quality somewhere between the two, so judge them together.
 *
 * DO NOT add a distance taper here. It is a standing temptation — a horizon view really
 * does pull every mid-depth tile of the survey — and `jan-threejs-test` has one:
 * `distance-lod.ts` in 76a6d04 scales the error by `(R/d)²` beyond `R = max(h*3, 200)`,
 * alongside a hard cutoff beyond `clamp(h*6, 1.5km, 12km)`. The cutoff is a fair idea.
 * The taper is the distance double-count `config.lod.sse` records deleting when the
 * three-band ladder went: the error quotient already divides by distance, so taking it
 * out a second time only makes far views coarser than the pixel budget asked for. It
 * also fights this file directly — both wrap the same function, one raising the error
 * off-axis and one lowering it with range, leaving the result an accident.
 *
 * Deliberately not merged, 2026-09-08. The full comparison, including his frame-time
 * measurements (which are real) and why the shared-material and quantised-position work
 * attacks the same hitch at its source instead, is in plans/decision-distance-lod.md.
 */
export interface ViewDepthSettings {
  enabled: boolean
  /**
   * Floor for the cosine, i.e. a ceiling of `1 / minCosine` on the correction.
   *
   * Needed even though only in-frustum tiles are touched: "in frustum" means the tile's
   * *box* intersects the frustum, so a large tile clipping the edge can have its centre
   * well outside it, at an angle the frustum corner never reaches. Without the floor
   * that tile's error would run away as the angle approached 90°.
   */
  minCosine: number
}

export interface ViewDepthCorrection {
  readonly settings: ViewDepthSettings
  dispose(): void
}

const scratchBox = new THREE.Box3()
const scratchObb = new THREE.Matrix4()
const scratchToLocal = new THREE.Matrix4()
const scratchCameraLocal = new THREE.Vector3()
const scratchNearest = new THREE.Vector3()
const scratchToTile = new THREE.Vector3()
const scratchForward = new THREE.Vector3()

export function createViewDepthCorrection(
  tiles: any,
  camera: THREE.PerspectiveCamera,
  settings: ViewDepthSettings = { ...EXPERIENCE_CONFIG.lod.viewDepthError },
): ViewDepthCorrection {
  /**
   * radius / depth for this tile — 1 / cos(the angle off the view axis), measured at
   * the point of its box closest to the camera. 1 means no correction.
   */
  const inverseCosineFor = (tile: any): number => {
    const volume = tile?.engineData?.boundingVolume
    if (!volume) return 1
    // getOBB hands back the box in its own local frame plus the transform out of it;
    // the group matrix then takes that to world, where the camera lives.
    volume.getOBB(scratchBox, scratchObb)
    scratchObb.premultiply(tiles.group.matrixWorld)
    scratchToLocal.copy(scratchObb).invert()

    // The closest point of the box to the camera, found in the box's own frame where it
    // is axis-aligned and a clamp is all it takes, then carried back out to world.
    scratchCameraLocal.copy(camera.position).applyMatrix4(scratchToLocal)
    scratchBox.clampPoint(scratchCameraLocal, scratchNearest)
    scratchNearest.applyMatrix4(scratchObb)

    scratchToTile.copy(scratchNearest).sub(camera.position)
    const radius = scratchToTile.length()
    // Camera inside the box: the clamp returned the camera itself. See the note above —
    // the library is already at error Infinity here, so leave it alone.
    if (!(radius > 1e-6)) return 1

    // Read the view axis off matrixWorld rather than calling getWorldDirection(), which
    // would re-walk the camera's parents once per tile. The render loop has already
    // updated this matrix by the time traversal runs.
    const elements = camera.matrixWorld.elements
    scratchForward.set(-elements[8], -elements[9], -elements[10]).normalize()

    const depth = scratchToTile.dot(scratchForward)
    // Only in-frustum tiles reach here, so the depth is positive in practice; the floor
    // still catches a point beside or behind the camera, which reads as "as far off-axis
    // as the clamp allows" rather than flipping the error's sign.
    return 1 / THREE.MathUtils.clamp(depth / radius, settings.minCosine, 1)
  }

  // Wrap whatever is installed rather than the prototype method: foveation and the
  // view-angle correction may already have wrappers here, and all three are plain
  // multipliers on the error, so they compose in any order.
  const previous = tiles.calculateTileViewError.bind(tiles)
  const wrapper = (tile: any, target: any) => {
    previous(tile, target)
    // Out-of-view tiles keep the untouched error: there it is only a load-priority
    // number, and off-axis has no meaning for something that is not on screen.
    if (!settings.enabled || !target.inView) return
    target.error *= inverseCosineFor(tile)
  }
  tiles.calculateTileViewError = wrapper

  return {
    settings,
    dispose() {
      // Only unwind if nothing else wrapped us in the meantime.
      if (tiles.calculateTileViewError === wrapper) tiles.calculateTileViewError = previous
    },
  }
}
