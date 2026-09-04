// GlobeControls for the React app. Builds on SmoothedGlobeControls (public
// orbitBy + screen-centre mouse pivot) and removes the per-frame raycasts:
//
//   • EnvironmentControls.update() and GlobeControls.adjustCamera() each
//     raycast the whole scene every frame to find the point below the camera.
//     The scene passed to the controls is the ECEF root — basemap tiles at
//     ~900 triangles each plus every other layer — and `firstHitOnly` is inert
//     without three-mesh-bvh. The basemap is imagery draped on the bare
//     ellipsoid, so the analytic ellipsoid elevation is the same answer.
//   • adjustCamera() also rewrote camera.near/far and rebuilt the projection
//     matrix every frame, fighting the app's own far-plane rule. The React app
//     owns the planes in one place (scene/Atmosphere.tsx).
//   • _raycast() (pointer-down pivot, wheel zoom point, getPivotPoint) goes
//     straight to the ellipsoid and reuses one hit object; consumers copy
//     hit.point immediately.
//
// Bound to 3d-tiles-renderer 0.4.28 internals: ellipsoid, ellipsoidFrame,
// ellipsoidFrameInverse, getUpDirection, adjustHeight, cameraRadius.
import * as THREE from 'three'
import { EnvironmentControls } from '3d-tiles-renderer'
import { SmoothedGlobeControls, type SmoothedControlsOptions } from '../../threejs-test/smoothed-globe-controls'

const _local = new THREE.Vector3()
const _up = new THREE.Vector3()
const _ray = new THREE.Ray()
const _belowHit = { point: new THREE.Vector3(), distance: 0 }
const _rayHit = { point: new THREE.Vector3(), distance: 0 }

export class WildGlobeControls extends SmoothedGlobeControls {
  constructor(
    scene: THREE.Object3D,
    camera: THREE.Camera,
    domElement: HTMLElement,
    tilesRenderer: any,
    options: SmoothedControlsOptions = {},
  ) {
    super(scene, camera, domElement, tilesRenderer, options)
  }

  /** Ellipsoid elevation under `point` — the draped basemap is the ellipsoid. */
  _getPointBelowCamera(point?: THREE.Vector3): { point: THREE.Vector3; distance: number } | null {
    const self = this as any
    const ellipsoid = self.ellipsoid
    if (!ellipsoid) return null
    const position: THREE.Vector3 = point ?? self.camera.position
    _local.copy(position).applyMatrix4(self.ellipsoidFrameInverse)
    const elevation: number = ellipsoid.getPositionElevation(_local)
    this.getUpDirection(position, _up)
    _belowHit.point.copy(position).addScaledVector(_up, -elevation)
    _belowHit.distance = elevation
    return _belowHit
  }

  /** Height clamp only; near/far are owned by the app. */
  adjustCamera(camera: THREE.Camera): void {
    EnvironmentControls.prototype.adjustCamera.call(this, camera)
  }

  _raycast(raycaster: THREE.Raycaster): { point: THREE.Vector3; distance: number } | null {
    const self = this as any
    const ellipsoid = self.ellipsoid
    if (!ellipsoid) return null
    _ray.copy(raycaster.ray).applyMatrix4(self.ellipsoidFrameInverse)
    const point = ellipsoid.intersectRay(_ray, _rayHit.point)
    if (point === null) return null
    point.applyMatrix4(self.ellipsoidFrame)
    _rayHit.distance = point.distanceTo(raycaster.ray.origin)
    return _rayHit
  }
}
