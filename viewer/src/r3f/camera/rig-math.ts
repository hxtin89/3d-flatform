// Parcel-relative rig maths. Pure functions, ENU in, ENU out.
import * as THREE from 'three'
import type { RigState } from './rig-types'

const DEG = Math.PI / 180

/** Camera position and look point for a rig state around `anchor` (ENU). */
export function solveRig(
  state: RigState,
  anchor: THREE.Vector3,
  outPosition: THREE.Vector3,
  outLook: THREE.Vector3,
): void {
  const range = Math.exp(state.logRange)
  const el = THREE.MathUtils.clamp(state.elevationDeg, 1, 89.5) * DEG
  const az = state.azimuthDeg * DEG
  const horizontal = Math.cos(el) * range
  outPosition.set(
    anchor.x + Math.sin(az) * horizontal,
    anchor.y - Math.cos(az) * horizontal,
    anchor.z + Math.sin(el) * range,
  )
  outLook.set(anchor.x, anchor.y, anchor.z + state.lookHeightM)
}

/** Read a camera position (ENU) back into rig parameters; lookHeightM is
 * left untouched. */
export function captureRig(positionEnu: THREE.Vector3, anchor: THREE.Vector3, out: RigState): RigState {
  const dx = positionEnu.x - anchor.x
  const dy = positionEnu.y - anchor.y
  const dz = positionEnu.z - anchor.z
  const horizontal = Math.hypot(dx, dy)
  const distance = Math.max(1, Math.hypot(horizontal, dz))
  out.logRange = Math.log(distance)
  out.elevationDeg = Math.atan2(dz, horizontal) / DEG
  out.azimuthDeg = horizontal < 1e-3 ? out.azimuthDeg : Math.atan2(dx, -dy) / DEG
  return out
}

/** Smallest pitch that keeps a camera at `rangeM` above `floorRise` metres
 * over the anchor. Inert by construction once orbitRangeM() chose the range. */
export function elevationFloorDeg(rangeM: number, floorRise: number): number {
  if (floorRise <= 0) return 0
  return Math.asin(THREE.MathUtils.clamp(floorRise / rangeM, 0, 0.98)) / DEG
}

/** Shortest signed angular difference b − a in degrees. */
export function angleDelta(a: number, b: number): number {
  return ((b - a) % 360 + 540) % 360 - 180
}

export function smoothstep01(x: number): number {
  const t = THREE.MathUtils.clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}
