import * as THREE from 'three'

import { EXPERIENCE_CONFIG } from './config'

/**
 * Correct the screen-space error for the angle the ground is seen at.
 *
 * The renderer computes `error = spacing / distance`, which is the angle a point
 * spacing subtends *if the surface faces the camera*. Under tilt it does not: the
 * ground is foreshortened by the cosine of the incidence angle and the points squeeze
 * together on screen. So the plain quotient over-states the error for grazing ground,
 * and tilting the camera pulls in a density level it does not need — measured on the
 * canopy, six tiles in the 100–150 m band refined for nothing while their corrected
 * error sat between 1.6 and 3.8 against a target of 4.2.
 *
 * The cosine is free:
 *
 *     cos(incidence) = camera height above the tile / distance to the tile
 *
 * so the corrected error falls off as 1/r² for grazing ground and stays exactly as it
 * was at nadir, where the cosine is 1.
 *
 * Unlike a frame-time feedback this cannot oscillate. It reads only camera and tile
 * geometry, so a still camera gives a still result, every frame.
 *
 * DEFAULT OFF, because the premise above is wrong for this data. Foreshortening applies
 * to a *surface*; a canopy is a ~70 m volume of leaves and trunks, and an isotropic
 * point cloud does not foreshorten — it looks equally dense from every direction. The
 * node's geometricError is a 3D spacing, so spacing/distance was already
 * view-independent and the cosine subtracts detail that was never redundant. Measured
 * from 212 m straight down it dropped 3.31M points to 2.11M and visibly opened holes in
 * the canopy. Kept behind the switch only as the basis for a distance-gated version,
 * where grazing *far* ground is hidden by haze and depth of field anyway.
 */
export interface ViewAngleSettings {
  enabled: boolean
  /**
   * Floor for the cosine. Without it a tile at the horizon would be handed an error
   * of nearly zero and could never load at all, however long you looked at it.
   */
  minCosine: number
}

export interface ViewAngleCorrection {
  readonly settings: ViewAngleSettings
  dispose(): void
}

const scratchCentre = new THREE.Vector3()
const scratchToCamera = new THREE.Vector3()

export function createViewAngleCorrection(
  tiles: any,
  camera: THREE.PerspectiveCamera,
  /** Local up in world space; read per call because the ENU frame lands after boot. */
  up: THREE.Vector3,
  settings: ViewAngleSettings = { ...EXPERIENCE_CONFIG.lod.viewAngleError },
): ViewAngleCorrection {
  const box = new THREE.Box3()
  const obbMatrix = new THREE.Matrix4()

  const cosineFor = (tile: any): number => {
    const volume = tile?.engineData?.boundingVolume
    if (!volume) return 1
    volume.getOBB(box, obbMatrix)
    box.getCenter(scratchCentre).applyMatrix4(obbMatrix).applyMatrix4(tiles.group.matrixWorld)
    scratchToCamera.copy(camera.position).sub(scratchCentre)
    const range = scratchToCamera.length()
    if (!(range > 1e-6)) return 1
    // Height of the camera over the tile, along the local vertical. Negative means the
    // tile is above the camera, which the floor below turns into "as grazing as it gets".
    const rise = scratchToCamera.dot(up)
    return THREE.MathUtils.clamp(rise / range, settings.minCosine, 1)
  }

  // Wrap whatever is installed rather than the prototype method: foveation may already
  // have its own wrapper here, and both of these are plain multipliers on the error, so
  // they compose in either order.
  const previous = tiles.calculateTileViewError.bind(tiles)
  const wrapper = (tile: any, target: any) => {
    previous(tile, target)
    if (!settings.enabled || !target.inView) return
    target.error *= cosineFor(tile)
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
