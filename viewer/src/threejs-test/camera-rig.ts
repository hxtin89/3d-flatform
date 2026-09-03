// Camera rig: the parcel-relative parameter set the intro keyframes.
//
// Nothing about the story may be authored in world coordinates — the parcel
// is different for every donor, the ground height comes out of the tiles and
// the floating origin moves the world under the camera. So the sequence
// describes the camera as {azimuth, elevation, range} around an anchor (the
// parcel centre) and this module solves that to a world position each frame.
// `range` is dimensionless: 1 = the distance that frames the parcel in the
// current viewport (the same number donationFlightOffset() derives), so a
// 14 m² and a 1 000 m² parcel get the same choreography at different scales.
import * as THREE from 'three'

export interface RigParams {
  /** Degrees around local up; 0 = camera south of the anchor looking north,
   * positive turns counter-clockwise seen from above. */
  azimuthDeg: number
  /** Degrees above the horizontal; 90 = straight down. */
  elevationDeg: number
  /** Multiples of frameDistanceM(). */
  range: number
}

export interface CameraRigDeps {
  camera: THREE.PerspectiveCamera
  enuUp: THREE.Vector3
  worldToEnu(value: THREE.Vector3, target?: THREE.Vector3): THREE.Vector3
  enuToWorld(value: THREE.Vector3, target?: THREE.Vector3): THREE.Vector3
  /** Look-at point in ENU — the parcel centre part way up its volume. */
  anchor(target: THREE.Vector3): THREE.Vector3
  /** Metres at which the parcel fills the frame. */
  frameDistanceM(): number
  /** Lowest camera height (ENU z) — the navigation floor. */
  floorZ(): number
  /** Hard cap, metres: keeps a huge relative range from leaving the planet. */
  rangeMaxM: number
}

export interface CameraRig {
  /** Solve and write the camera. Returns the ENU position it landed on. */
  apply(params: RigParams, target?: THREE.Vector3): THREE.Vector3
  /** Read the current camera back into rig parameters — the hand-over point
   * when the user takes the controls, and the start of a blend back. */
  capture(target?: RigParams): RigParams
}

const _anchor = new THREE.Vector3()
const _position = new THREE.Vector3()
const _world = new THREE.Vector3()
const _lookWorld = new THREE.Vector3()
const _delta = new THREE.Vector3()

export function createCameraRig(deps: CameraRigDeps): CameraRig {
  const { camera, enuUp, worldToEnu, enuToWorld } = deps

  return {
    apply(params, target = new THREE.Vector3()) {
      deps.anchor(_anchor)
      const distance = Math.min(deps.rangeMaxM, Math.max(1, params.range * deps.frameDistanceM()))
      // The floor wins over the requested elevation: steepen instead of
      // clamping z afterwards, so the anchor stays centred in frame.
      const floorRise = deps.floorZ() - _anchor.z
      let elevation = THREE.MathUtils.degToRad(params.elevationDeg)
      if (floorRise > 0) {
        elevation = Math.max(elevation, Math.asin(THREE.MathUtils.clamp(floorRise / distance, 0, 0.98)))
      }
      elevation = THREE.MathUtils.clamp(elevation, THREE.MathUtils.degToRad(1), THREE.MathUtils.degToRad(89.5))
      const azimuth = THREE.MathUtils.degToRad(params.azimuthDeg)
      const horizontal = Math.cos(elevation) * distance
      target.set(
        _anchor.x + Math.sin(azimuth) * horizontal,
        _anchor.y - Math.cos(azimuth) * horizontal,
        _anchor.z + Math.sin(elevation) * distance,
      )
      camera.position.copy(enuToWorld(target, _world))
      camera.up.copy(enuUp)
      camera.lookAt(enuToWorld(_anchor, _lookWorld))
      return target
    },

    capture(target = { azimuthDeg: 0, elevationDeg: 45, range: 1 }) {
      deps.anchor(_anchor)
      worldToEnu(camera.position, _position)
      _delta.subVectors(_position, _anchor)
      const distance = Math.max(1, _delta.length())
      const horizontal = Math.hypot(_delta.x, _delta.y)
      target.range = distance / Math.max(1, deps.frameDistanceM())
      target.elevationDeg = THREE.MathUtils.radToDeg(Math.atan2(_delta.z, horizontal))
      target.azimuthDeg = horizontal < 1e-3
        ? 0
        : THREE.MathUtils.radToDeg(Math.atan2(_delta.x, -_delta.y))
      return target
    },
  }
}

/** Shortest-way azimuth blend so a hand-over never spins the long way round. */
export function lerpRig(from: RigParams, to: RigParams, x: number, target: RigParams): RigParams {
  let deltaAz = ((to.azimuthDeg - from.azimuthDeg) % 360 + 540) % 360 - 180
  target.azimuthDeg = from.azimuthDeg + deltaAz * x
  target.elevationDeg = from.elevationDeg + (to.elevationDeg - from.elevationDeg) * x
  // Ranges span orders of magnitude; blend in log space.
  target.range = Math.exp(Math.log(Math.max(1e-3, from.range)) + (Math.log(Math.max(1e-3, to.range)) - Math.log(Math.max(1e-3, from.range))) * x)
  return target
}
