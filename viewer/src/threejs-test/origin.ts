// Floating origin. Two frames, differing by a pure translation:
//
//   ECEF (logical)  WGS84 geocentric metres, magnitudes ~6.4e6. What the area
//                   manifest, the ellipsoid and the tilesets mean. CPU float64 only.
//   render          `p_render = p_ecef - origin`. Everything in the scene graph,
//                   the camera, and every value that reaches a shader.
//
// Why: three's node materials build the model-view matrix in the shader from two
// float32 matrices (`mediumpModelViewMatrix = cameraViewMatrix · modelWorldMatrix`).
// At 6.4e6 m a float32 step is ~0.5 m, so geometry snaps to a half-metre grid that
// shifts as the camera moves — visible swim, and ~3-4 px of vertical jump on a thin
// overlay. `positionWorld` and `cameraPosition` in TSL are float32 for the same
// reason and are NOT fixed by the per-material high-precision context, because they
// are derived from `modelWorldMatrix` independently. Keeping the origin near the
// camera makes every one of those values small, which fixes all of it at once.
//
// Scene-graph rule: children of `ecefRoot` carry ECEF in their local matrices;
// direct children of the scene are already in render space (the rain layer, which
// copies the camera position, is the only one).
import * as THREE from 'three'

const origin = new THREE.Vector3()
const ecefRoot = new THREE.Group()
ecefRoot.name = 'ecef-root'
ecefRoot.matrixAutoUpdate = false

let enabled = true
let version = 0
let rebases = 0

const listeners = new Set<(delta: THREE.Vector3) => void>()
const scratchDelta = new THREE.Vector3()
const scratchTranslation = new THREE.Matrix4()

/** The group every ECEF-anchored object hangs under. */
export function getEcefRoot(): THREE.Group {
  return ecefRoot
}

export function attachOrigin(scene: THREE.Scene): void {
  scene.add(ecefRoot)
}

/** `?noorigin` keeps the origin at (0,0,0) — same code path, one value different,
 * so the A/B compares the real implementation instead of a second one. */
export function setOriginEnabled(value: boolean): void {
  enabled = value
}

export function isOriginEnabled(): boolean {
  return enabled
}

/** Increments on every rebase. Watchers that cache derived matrices poll this. */
export function originVersion(): number {
  return version
}

export function originStats(): { rebases: number; distanceM: number } {
  return { rebases, distanceM: origin.length() }
}

export function getOrigin(target = new THREE.Vector3()): THREE.Vector3 {
  return target.copy(origin)
}

export function ecefToRender(value: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
  return target.copy(value).sub(origin)
}

export function renderToEcef(value: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
  return target.copy(value).add(origin)
}

/** An ECEF-anchored transform expressed in render space: `T(-origin) · m`. */
export function ecefToRenderMatrix(m: THREE.Matrix4, target = new THREE.Matrix4()): THREE.Matrix4 {
  target.copy(m)
  target.elements[12] -= origin.x
  target.elements[13] -= origin.y
  target.elements[14] -= origin.z
  return target
}

/** The inverse direction: a render-space point into an ECEF-anchored frame,
 * `inverse · T(+origin)` — e.g. the ENU matrix the shaders use. */
export function renderToEcefMatrix(inverse: THREE.Matrix4, target = new THREE.Matrix4()): THREE.Matrix4 {
  scratchTranslation.makeTranslation(origin.x, origin.y, origin.z)
  return target.copy(inverse).multiply(scratchTranslation)
}

/** Watchers that hold render-space state outside the scene graph (the camera,
 * the controls' pivot points, the ground plane, derived matrices). */
export function onRebase(listener: (delta: THREE.Vector3) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Move the origin to `nextEcef`. Every render-space point gains the returned
 * delta, which listeners apply to whatever they own.
 */
export function rebaseTo(nextEcef: THREE.Vector3): void {
  if (!enabled) return
  // A non-finite target would bake itself into the origin permanently — every listener
  // applies the delta to what it owns, and nothing ever writes the origin back to a
  // finite value. Refusing here keeps a transient bad camera frame transient.
  if (!Number.isFinite(nextEcef.x + nextEcef.y + nextEcef.z)) return
  scratchDelta.copy(origin).sub(nextEcef)
  if (scratchDelta.lengthSq() === 0) return
  origin.copy(nextEcef)
  ecefRoot.position.copy(origin).negate()
  ecefRoot.updateMatrix()
  // force = true: TilesGroup caches its world inverse and only refreshes when it
  // sees the parent transform change, and both tile traversals read that inverse
  // in the same frame.
  ecefRoot.updateMatrixWorld(true)
  version++
  rebases++
  for (const listener of listeners) listener(scratchDelta)
}

/** In render space the origin is (0,0,0), so this is just the length. */
export function distanceFromOrigin(renderPoint: THREE.Vector3): number {
  return renderPoint.length()
}
