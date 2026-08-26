// GlobeControls with a per-frame easing filter on mouse orbit rotation.
//
// Why: EnvironmentControls applies mouse rotation once per render frame as
// "pointer now − pointer at the previous frame". A 125 Hz mouse against a
// 120/144 Hz display yields frames with 0, 1 or 2 pointer events, so the camera
// steps by 0 / N / 2N — visible judder while the fps counter stays green. A
// trackpad streams dense fractional deltas and hides it; keyboard motion is
// velocity-integrated and never had the problem.
//
// The filter keeps a target angle (sum of raw deltas) and an applied angle. A
// fixed share of every raw delta is applied immediately, the remainder is drawn
// in with a short time constant. Empty frames therefore still move the camera,
// and the applied angle converges to exactly what the mouse asked for.
//
// Bound to 3d-tiles-renderer 0.4.28: `_applyRotation`, `pointerTracker`,
// `rotationInertia` and `state` are runtime members without type declarations.
import * as THREE from 'three'
import { GlobeControls } from '3d-tiles-renderer'

const ROTATE = 2 // EnvironmentControls state enum
const NONE = 0

/** Below this residual (in the controls' normalised rotation units, 2π per
 * viewport height ≈ 1 px at 1080 rows) the tail snaps closed. */
const SNAP_EPSILON = 0.05 * (2 * Math.PI / 1080)

export interface SmoothedControlsOptions {
  /** Time constant of the catch-up filter, ms. 0 disables the filter. */
  easeMs: number
  /** Share of each raw delta applied in the same frame (0–1). */
  immediateShare?: number
}

export class SmoothedGlobeControls extends GlobeControls {
  private easeMs: number
  private immediateShare: number
  private readonly target = new THREE.Vector2()
  private readonly applied = new THREE.Vector2()
  private filtering = false
  private lastState = NONE
  private lastTick = performance.now()

  constructor(
    scene: THREE.Object3D,
    camera: THREE.Camera,
    domElement: HTMLElement,
    tilesRenderer: any,
    options: SmoothedControlsOptions,
  ) {
    super(scene, camera, domElement, tilesRenderer)
    this.easeMs = Math.max(0, options.easeMs)
    this.immediateShare = THREE.MathUtils.clamp(options.immediateShare ?? 0.35, 0, 1)
  }

  setEaseMs(ms: number): void {
    this.easeMs = Math.max(0, ms)
  }

  /** Commanded orbit for keyboard input: rotate the camera about `pivot` by
   * `deltaAzimuth` around local up and `deltaAltitude` around the camera's
   * right axis (radians). Reuses the library's own clamping and up handling. */
  orbitBy(deltaAzimuth: number, deltaAltitude: number, pivot: THREE.Vector3): void {
    const speed = (this as any).rotationSpeed || 1
    this.baseApplyRotation(-deltaAzimuth / speed, deltaAltitude / speed, pivot)
  }

  private baseApplyRotation(x: number, y: number, pivot: THREE.Vector3): void {
    ;(GlobeControls.prototype as any)._applyRotation.call(this, x, y, pivot)
  }

  private get mouseOrbitActive(): boolean {
    const self = this as any
    return this.easeMs > 0
      && self.state === ROTATE
      && self.pointerTracker?.getPointerType?.() === 'mouse'
  }

  // Called by _updateRotation (during drag) and _updateInertia (after release).
  // Only the live mouse drag is filtered; touch, inertia and keyboard pass through.
  _applyRotation(x: number, y: number, pivot: THREE.Vector3): void {
    if (!this.target || !this.mouseOrbitActive) {
      this.baseApplyRotation(x, y, pivot)
      return
    }
    if (!this.filtering) {
      this.filtering = true
      this.target.set(0, 0)
      this.applied.set(0, 0)
    }
    this.target.x += x
    this.target.y += y
    const ix = x * this.immediateShare
    const iy = y * this.immediateShare
    this.applied.x += ix
    this.applied.y += iy
    this.baseApplyRotation(ix, iy, pivot)
  }

  update(deltaTime?: number): void {
    const now = performance.now()
    const dt = Math.min(64, Math.max(0, now - this.lastTick))
    this.lastTick = now

    const self = this as any
    // Leaving ROTATE: the library seeded rotationInertia from the raw delta —
    // the filter tail replaces that fling for mouse orbits, so drop it.
    if (this.filtering && this.lastState === ROTATE && self.state !== ROTATE) {
      self.rotationInertia?.set(0, 0)
    }
    this.lastState = self.state

    if (this.filtering) self.needsUpdate = true
    super.update(deltaTime)

    if (!this.filtering) return
    const rx = this.target.x - this.applied.x
    const ry = this.target.y - this.applied.y
    const residual = Math.hypot(rx, ry)
    const pivot: THREE.Vector3 = self.pivotPoint
    if (residual <= SNAP_EPSILON || !pivot) {
      if (residual > 0 && pivot) this.baseApplyRotation(rx, ry, pivot)
      this.applied.copy(this.target)
      if (self.state !== ROTATE) this.filtering = false
      return
    }
    const alpha = 1 - Math.exp(-dt / this.easeMs)
    const cx = rx * alpha
    const cy = ry * alpha
    this.applied.x += cx
    this.applied.y += cy
    this.baseApplyRotation(cx, cy, pivot)
    self.needsUpdate = true
    this.camera.updateMatrixWorld()
  }

  resetState(): void {
    super.resetState()
    // Also reached from the parent constructor, before this class's fields exist.
    if (!this.target) return
    this.filtering = false
    this.target.set(0, 0)
    this.applied.set(0, 0)
  }
}
