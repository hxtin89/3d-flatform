// GlobeControls with two small deviations from the library:
//
//   • a public orbit entry point for keyboard input. The library exposes no
//     "rotate by angle" API; `_applyRotation` is the primitive behind mouse
//     orbit and already handles ellipsoid-local up, the pivot rotation and the
//     altitude clamp.
//   • a screen-centre orbit pivot for the mouse. Stock behaviour pivots a
//     right-drag around the raycast hit under the cursor. The point cloud is
//     deliberately not raycastable (streaming.ts), so that hit lands on the
//     basemap ~70 m under the canopy the user is looking at, and the pivot
//     marker is removed — so the orbit reads as "not around what I see".
//     Keyboard orbit (keyboard-navigation.ts) already pivots on the screen
//     centre via getPivotPoint(); this makes the mouse follow the same rule.
//     Touch keeps the library pivot: two-finger rotate around the finger
//     centroid is right there.
//
// Bound to 3d-tiles-renderer 0.4.28: `_applyRotation`, `_raycast`, `state`,
// `pivotPoint`, `pivotMesh`, `raycaster` and `pointerTracker` are runtime
// members without type declarations.
//
// Mouse smoothing lives in pointer-easing.ts, not here.
import * as THREE from 'three'
import { GlobeControls } from '3d-tiles-renderer'

const ROTATE = 2 // EnvironmentControls state enum

export type MouseOrbitPivot = 'center' | 'cursor' | 'canopy'

export interface SmoothedControlsOptions {
  /** Where a mouse right-drag pivots. `center` = screen centre (default). */
  mouseOrbitPivot?: MouseOrbitPivot
  /** Optional post-processing of a centre pivot (world coordinates, in place)
   * — main.ts lifts it to the navigation floor inside the survey so the orbit
   * turns at canopy height instead of on the draped imagery. */
  adjustOrbitPivot?: (pivot: THREE.Vector3) => void
}

const _ndcCenter = { x: 0, y: 0 }

export class SmoothedGlobeControls extends GlobeControls {
  mouseOrbitPivot: MouseOrbitPivot
  adjustOrbitPivot: ((pivot: THREE.Vector3) => void) | null

  constructor(
    scene: THREE.Object3D,
    camera: THREE.Camera,
    domElement: HTMLElement,
    tilesRenderer: any,
    options: SmoothedControlsOptions = {},
  ) {
    super(scene, camera, domElement, tilesRenderer)
    this.mouseOrbitPivot = options.mouseOrbitPivot ?? 'center'
    this.adjustOrbitPivot = options.adjustOrbitPivot ?? null
  }

  /** Rotate the camera about `pivot` by `deltaAzimuth` around local up and
   * `deltaAltitude` around the camera's right axis (radians). */
  orbitBy(deltaAzimuth: number, deltaAltitude: number, pivot: THREE.Vector3): void {
    const speed = (this as any).rotationSpeed || 1
    ;(this as any)._applyRotation(-deltaAzimuth / speed, deltaAltitude / speed, pivot)
  }

  // The library sets pivotPoint from the cursor hit and then enters ROTATE; the
  // state change is the one moment where the pivot can be swapped before the
  // first _updateRotation runs.
  setState(state?: number, fireEvent?: boolean): void {
    super.setState(state, fireEvent)
    // Also reached from the parent constructor, before this class's fields exist.
    if (state !== ROTATE || this.mouseOrbitPivot !== 'center') return
    const self = this as any
    if (self.pointerTracker?.getPointerType?.() !== 'mouse') return
    const raycaster: THREE.Raycaster = self.raycaster
    raycaster.setFromCamera(_ndcCenter as THREE.Vector2, this.camera as THREE.Camera)
    const hit = self._raycast(raycaster)
    if (!hit) return
    const pivot: THREE.Vector3 = self.pivotPoint
    pivot.copy(hit.point)
    this.adjustOrbitPivot?.(pivot)
    self.pivotMesh?.position.copy(pivot)
    self.pivotMesh?.updateMatrixWorld()
  }
}
