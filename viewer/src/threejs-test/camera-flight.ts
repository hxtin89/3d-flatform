// Cinematic camera moves. Two shapes share one Bézier evaluator:
//   arc   — sweeps in and steers the gaze toward the survey (intro, "fly to").
//   dolly — travels straight down the sight line, angle untouched (double
//           click, marker approach).
// Everything is computed in the local ENU frame; the caller converts.
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from './config'

export type FlightMode = 'arc' | 'dolly'
export type EnuOffset = readonly [number, number, number]

interface Flight {
  mode: FlightMode
  start: THREE.Vector3
  control1: THREE.Vector3
  control2: THREE.Vector3
  end: THREE.Vector3
  lookTarget: THREE.Vector3
  t0: number
  duration: number
  lastUpdate: number
}

export interface CameraFlightDeps {
  camera: THREE.PerspectiveCamera
  enuUp: THREE.Vector3
  worldToEnu(value: THREE.Vector3, target?: THREE.Vector3): THREE.Vector3
  enuToWorld(value: THREE.Vector3, target?: THREE.Vector3): THREE.Vector3
  /** Survey centre in ENU; flight offsets are relative to it. */
  cloudCentre(): THREE.Vector3
  /** Lowest altitude a dolly may end at. */
  navigationFloorZ(): number
  /** Toggled so orbit controls cannot fight an in-progress flight. */
  setControlsEnabled(enabled: boolean): void
  /** 0 while flying, 1 once settled — drives the cinematic UI fade. */
  onProgress(progress: number): void
}

export interface CameraFlightController {
  readonly active: boolean
  toCloud(durationMs?: number, startFromOverview?: boolean): void
  toPoint(targetEnu: THREE.Vector3, endDistanceM: number, durationMs: number): void
  update(now: number): void
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function sample(flight: Flight, progress: number, target: THREE.Vector3): THREE.Vector3 {
  // Easing the parameter rather than splitting the curve keeps velocity
  // continuous; the earlier two-stage path had a visible seam at the join.
  const t = smootherstep(THREE.MathUtils.clamp(progress, 0, 1))
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return target.set(
    a * flight.start.x + b * flight.control1.x + c * flight.control2.x + d * flight.end.x,
    a * flight.start.y + b * flight.control1.y + c * flight.control2.y + d * flight.end.y,
    a * flight.start.z + b * flight.control1.z + c * flight.control2.z + d * flight.end.z,
  )
}

function smooth01(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

export function createCameraFlight(deps: CameraFlightDeps): CameraFlightController {
  const { camera, enuUp, worldToEnu, enuToWorld } = deps
  const positionEnu = new THREE.Vector3()
  const lookEnu = new THREE.Vector3()
  const positionWorld = new THREE.Vector3()
  const lookWorld = new THREE.Vector3()
  // A camera, not a bare Object3D: lookAt() has to resolve against the -Z
  // forward axis or the interpolated orientation turns away from the terrain.
  const orientation = new THREE.PerspectiveCamera()
  let flight: Flight | null = null

  const offsetPoint = (offset: EnuOffset): THREE.Vector3 => {
    const centre = deps.cloudCentre()
    return new THREE.Vector3(centre.x + offset[0], centre.y + offset[1], centre.z + offset[2])
  }

  const begin = (next: Flight): void => {
    flight = next
    deps.onProgress(0)
    deps.setControlsEnabled(false)
  }

  return {
    get active() {
      return flight !== null
    },

    toCloud(durationMs = EXPERIENCE_CONFIG.flight.manualDurationMs, startFromOverview = false) {
      const end = offsetPoint(EXPERIENCE_CONFIG.flight.destinationOffsetM)
      let start: THREE.Vector3
      let control1: THREE.Vector3
      let control2: THREE.Vector3

      if (startFromOverview) {
        start = offsetPoint(EXPERIENCE_CONFIG.flight.overviewOffsetM)
        control1 = offsetPoint(EXPERIENCE_CONFIG.flight.overviewControl1OffsetM)
        control2 = offsetPoint(EXPERIENCE_CONFIG.flight.overviewControl2OffsetM)
      } else {
        // Bow the curve sideways and lift it, so a flight starting close to the
        // canopy arrives from above instead of skimming through it.
        start = worldToEnu(camera.position)
        const range = start.distanceTo(end)
        control1 = start.clone().lerp(end, 0.28)
        control1.x -= Math.min(10_000, range * 0.07)
        control1.z = Math.max(control1.z, end.z + Math.min(16_000, range * 0.16))
        control2 = start.clone().lerp(end, 0.72)
        control2.x += Math.min(8_000, range * 0.055)
        control2.z = Math.max(control2.z, end.z + Math.min(8_000, range * 0.075))
      }

      const started = performance.now()
      begin({
        mode: 'arc',
        start, control1, control2, end,
        lookTarget: deps.cloudCentre().clone(),
        t0: started, duration: durationMs, lastUpdate: started,
      })

      camera.position.copy(enuToWorld(start, positionWorld))
      sample(flight!, 0.025, lookEnu)
      camera.up.copy(enuUp)
      camera.lookAt(enuToWorld(lookEnu, lookWorld))
    },

    toPoint(targetEnu, endDistanceM, durationMs) {
      const start = worldToEnu(camera.position)
      const direction = targetEnu.clone().sub(start)
      const distance = direction.length()
      if (distance <= endDistanceM + 1) return
      direction.divideScalar(distance)

      // Solve the floor limit along the ray instead of clamping z afterwards,
      // which would kink an otherwise straight path.
      let travel = distance - endDistanceM
      if (direction.z < -1e-6) {
        travel = Math.min(travel, (deps.navigationFloorZ() - start.z) / direction.z)
      }
      if (travel <= 1) return

      const end = start.clone().addScaledVector(direction, travel)
      const started = performance.now()
      begin({
        mode: 'dolly',
        start,
        control1: start.clone().lerp(end, 0.3),
        control2: start.clone().lerp(end, 0.75),
        end,
        lookTarget: targetEnu.clone(),
        t0: started, duration: durationMs, lastUpdate: started,
      })
    },

    update(now) {
      if (!flight) return
      const active = flight
      const t = Math.min(1, (now - active.t0) / active.duration)
      const elapsed = Math.min(48, Math.max(0, now - active.lastUpdate))
      active.lastUpdate = now
      deps.onProgress(t)

      sample(active, t, positionEnu)
      camera.position.copy(enuToWorld(positionEnu, positionWorld))

      // Dolly flights leave the orientation alone — that is their whole point.
      if (active.mode === 'arc') {
        sample(active, Math.min(1, t + 0.022), lookEnu)
        lookEnu.lerp(active.lookTarget, smooth01(0.56, 1, t))
        camera.up.copy(enuUp)
        enuToWorld(lookEnu, lookWorld)
        orientation.position.copy(camera.position)
        orientation.up.copy(enuUp)
        orientation.lookAt(lookWorld)
        camera.quaternion.slerp(orientation.quaternion, 1 - Math.exp(-elapsed / 85))
        if (t >= 1) camera.quaternion.copy(orientation.quaternion)
      }

      if (t >= 1) {
        flight = null
        deps.setControlsEnabled(true)
      }
    },
  }
}
