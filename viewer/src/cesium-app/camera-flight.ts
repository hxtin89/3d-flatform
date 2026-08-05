// Cinematic camera moves in the survey's local ENU frame. The caller owns the
// ENU/ECEF conversion and applies each sampled pose to its renderer.
import { EXPERIENCE_CONFIG } from './config'

export type FlightMode = 'arc' | 'dolly'
export type EnuOffset = readonly [number, number, number]

export interface EnuVector3 {
  x: number
  y: number
  z: number
}

interface Flight {
  mode: FlightMode
  start: EnuVector3
  control1: EnuVector3
  control2: EnuVector3
  end: EnuVector3
  lookTarget: EnuVector3
  direction: EnuVector3
  t0: number
  duration: number
  lastUpdate: number
}

export interface CameraFlightDeps {
  /** Current camera position expressed in the survey ENU frame. */
  positionEnu(): EnuVector3
  /** Current unit view direction expressed in the survey ENU frame. */
  directionEnu(): EnuVector3
  /** Survey centre in ENU; configured flight offsets are relative to it. */
  cloudCentre(): EnuVector3
  /** Where the intro arc lands and looks — the donation parcel once it is
   * known. Falls back to cloudCentre(), which has seven other consumers
   * (vignette mask, ground plane, navigation bounds, markers, field models,
   * environment layer, boot staging) and must not be repurposed. */
  flightTarget?(): EnuVector3
  /** Offset from flightTarget() the arc ends at. Computed from the parcel size
   * and the camera frustum so the shape is actually framed, instead of the
   * fixed survey-scale offset that leaves a 14 m parcel two pixels wide. */
  flightDestinationOffset?(): EnuOffset
  /** Lowest ENU altitude a dolly may end at. */
  navigationFloorZ(): number
  /** Apply one sampled position/look-target pair to the real camera. */
  applyPose(positionEnu: EnuVector3, targetEnu: EnuVector3): void
  /** Toggled so native controls cannot fight an in-progress flight. */
  setInputsEnabled(enabled: boolean): void
  /** 0 while starting, 1 once settled; used by later cinematic UI work. */
  onProgress?(progress: number): void
  /** Injectable for deterministic checks; defaults to performance.now(). */
  now?(): number
}

export interface CameraFlightController {
  readonly active: boolean
  readonly progress: number
  update(now: number): void
  toCloud(durationMs?: number, fromOverview?: boolean): void
  /** Re-aim an arc that is already in the air. The Start button can fire before
   * the parcel GeoJSON lands; this bends only the tail of the curve, so there
   * is no camera jump. */
  retargetCloud(target: EnuVector3): void
  toPoint(targetEnu: EnuVector3, endDistanceM: number, durationMs: number): void
  cancel(): void
}

const vector = (x = 0, y = 0, z = 0): EnuVector3 => ({ x, y, z })
const copy = (value: EnuVector3): EnuVector3 => vector(value.x, value.y, value.z)
const set = (target: EnuVector3, value: EnuVector3): EnuVector3 => {
  target.x = value.x
  target.y = value.y
  target.z = value.z
  return target
}
const distance = (a: EnuVector3, b: EnuVector3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

function normalize(value: EnuVector3, target: EnuVector3): EnuVector3 {
  const length = Math.hypot(value.x, value.y, value.z)
  if (length <= 1e-12) return set(target, vector(0, 1, 0))
  target.x = value.x / length
  target.y = value.y / length
  target.z = value.z / length
  return target
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function sample(flight: Flight, progress: number, target: EnuVector3): EnuVector3 {
  // Easing the parameter rather than splitting the curve keeps velocity
  // continuous; the former two-stage path had a visible seam at the join.
  const t = smootherstep(Math.min(1, Math.max(0, progress)))
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  target.x = a * flight.start.x + b * flight.control1.x + c * flight.control2.x + d * flight.end.x
  target.y = a * flight.start.y + b * flight.control1.y + c * flight.control2.y + d * flight.end.y
  target.z = a * flight.start.z + b * flight.control1.z + c * flight.control2.z + d * flight.end.z
  return target
}

function smooth01(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function lerp(a: EnuVector3, b: EnuVector3, t: number, target: EnuVector3): EnuVector3 {
  target.x = a.x + (b.x - a.x) * t
  target.y = a.y + (b.y - a.y) * t
  target.z = a.z + (b.z - a.z) * t
  return target
}

/** Spherical interpolation of view directions, mirroring the directional part
 * of the Three camera quaternion slerp while the caller fixes ENU camera-up. */
function slerpDirection(
  from: EnuVector3,
  to: EnuVector3,
  amount: number,
  target: EnuVector3,
): EnuVector3 {
  const dot = Math.min(1, Math.max(-1, from.x * to.x + from.y * to.y + from.z * to.z))
  if (dot > 0.9995) {
    target.x = from.x + (to.x - from.x) * amount
    target.y = from.y + (to.y - from.y) * amount
    target.z = from.z + (to.z - from.z) * amount
    return normalize(target, target)
  }

  let relativeX = to.x - from.x * dot
  let relativeY = to.y - from.y * dot
  let relativeZ = to.z - from.z * dot
  let relativeLength = Math.hypot(relativeX, relativeY, relativeZ)
  if (relativeLength < 1e-8) {
    // The antiparallel case is not expected on the flight path, but choosing a
    // stable perpendicular avoids a NaN if a debug caller starts facing away.
    if (Math.abs(from.z) < 0.9) {
      relativeX = -from.y
      relativeY = from.x
      relativeZ = 0
    } else {
      relativeX = 0
      relativeY = -from.z
      relativeZ = from.y
    }
    relativeLength = Math.hypot(relativeX, relativeY, relativeZ)
  }
  relativeX /= relativeLength
  relativeY /= relativeLength
  relativeZ /= relativeLength
  const theta = Math.acos(dot) * amount
  const cosine = Math.cos(theta)
  const sine = Math.sin(theta)
  target.x = from.x * cosine + relativeX * sine
  target.y = from.y * cosine + relativeY * sine
  target.z = from.z * cosine + relativeZ * sine
  return normalize(target, target)
}

export function createCameraFlight(deps: CameraFlightDeps): CameraFlightController {
  const positionEnu = vector()
  const lookEnu = vector()
  const desiredDirection = vector()
  const nextDirection = vector()
  const applyTarget = vector()
  let flight: Flight | null = null
  let reportedProgress = 1

  const offsetPoint = (offset: EnuOffset, base: EnuVector3 = deps.cloudCentre()): EnuVector3 =>
    vector(base.x + offset[0], base.y + offset[1], base.z + offset[2])

  const flightTarget = (): EnuVector3 => deps.flightTarget?.() ?? deps.cloudCentre()
  const destinationOffset = (): EnuOffset =>
    deps.flightDestinationOffset?.() ?? EXPERIENCE_CONFIG.flight.destinationOffsetM

  const reportProgress = (progress: number): void => {
    reportedProgress = progress
    deps.onProgress?.(progress)
  }

  const begin = (next: Flight): void => {
    flight = next
    reportProgress(0)
    deps.setInputsEnabled(false)
  }

  const finish = (): void => {
    flight = null
    // A normal final update already reported 1. Cancel still settles the
    // progress contract without firing a duplicate landing callback.
    if (reportedProgress !== 1) reportProgress(1)
    deps.setInputsEnabled(true)
  }

  return {
    get active() {
      return flight !== null
    },

    get progress() {
      return reportedProgress
    },

    toCloud(
      durationMs = EXPERIENCE_CONFIG.flight.manualDurationMs,
      fromOverview = false,
    ) {
      const target = flightTarget()
      const end = offsetPoint(destinationOffset(), target)
      let start: EnuVector3
      let control1: EnuVector3
      let control2: EnuVector3

      if (fromOverview) {
        start = offsetPoint(EXPERIENCE_CONFIG.flight.overviewOffsetM)
        control1 = offsetPoint(EXPERIENCE_CONFIG.flight.overviewControl1OffsetM)
        control2 = offsetPoint(EXPERIENCE_CONFIG.flight.overviewControl2OffsetM)
      } else {
        // Bow the curve sideways and lift it, so a flight starting close to the
        // canopy arrives from above instead of skimming through it.
        start = copy(deps.positionEnu())
        const range = distance(start, end)
        control1 = lerp(start, end, 0.28, vector())
        control1.x -= Math.min(10_000, range * 0.07)
        control1.z = Math.max(control1.z, end.z + Math.min(16_000, range * 0.16))
        control2 = lerp(start, end, 0.72, vector())
        control2.x += Math.min(8_000, range * 0.055)
        control2.z = Math.max(control2.z, end.z + Math.min(8_000, range * 0.075))
      }

      const started = deps.now?.() ?? performance.now()
      const next: Flight = {
        mode: 'arc',
        start,
        control1,
        control2,
        end,
        lookTarget: copy(target),
        direction: vector(),
        t0: started,
        duration: Math.max(1, durationMs),
        lastUpdate: started,
      }
      begin(next)

      // The loader has staged destination tiles. On Start, jump to the overview
      // pose before the first visible frame and let the copied curve bring the
      // camera back to that prepared destination.
      sample(next, 0.025, lookEnu)
      desiredDirection.x = lookEnu.x - start.x
      desiredDirection.y = lookEnu.y - start.y
      desiredDirection.z = lookEnu.z - start.z
      normalize(desiredDirection, next.direction)
      applyTarget.x = start.x + next.direction.x
      applyTarget.y = start.y + next.direction.y
      applyTarget.z = start.z + next.direction.z
      deps.applyPose(start, applyTarget)
    },

    retargetCloud(target) {
      if (!flight || flight.mode !== 'arc') return
      const end = offsetPoint(destinationOffset(), target)
      // Move the end and drag the trailing control point with it; start and
      // control1 stay put, so the curve bends instead of snapping.
      const deltaX = end.x - flight.end.x
      const deltaY = end.y - flight.end.y
      const deltaZ = end.z - flight.end.z
      set(flight.end, end)
      flight.control2.x += deltaX
      flight.control2.y += deltaY
      flight.control2.z += deltaZ
      set(flight.lookTarget, target)
    },

    toPoint(targetEnu, endDistanceM, durationMs) {
      const start = copy(deps.positionEnu())
      const direction = vector(
        targetEnu.x - start.x,
        targetEnu.y - start.y,
        targetEnu.z - start.z,
      )
      const targetDistance = Math.hypot(direction.x, direction.y, direction.z)
      if (targetDistance <= endDistanceM + 1) return
      normalize(direction, direction)

      // Solve the floor limit along the ray instead of clamping z afterwards,
      // which would kink an otherwise straight path.
      let travel = targetDistance - endDistanceM
      if (direction.z < -1e-6) {
        travel = Math.min(travel, (deps.navigationFloorZ() - start.z) / direction.z)
      }
      if (travel <= 1) return

      const end = vector(
        start.x + direction.x * travel,
        start.y + direction.y * travel,
        start.z + direction.z * travel,
      )
      const started = deps.now?.() ?? performance.now()
      begin({
        mode: 'dolly',
        start,
        control1: lerp(start, end, 0.3, vector()),
        control2: lerp(start, end, 0.75, vector()),
        end,
        lookTarget: copy(targetEnu),
        direction: normalize(deps.directionEnu(), vector()),
        t0: started,
        duration: Math.max(1, durationMs),
        lastUpdate: started,
      })
    },

    update(now) {
      if (!flight) return
      const active = flight
      const t = Math.min(1, Math.max(0, (now - active.t0) / active.duration))
      const elapsed = Math.min(48, Math.max(0, now - active.lastUpdate))
      active.lastUpdate = now
      reportProgress(t)

      sample(active, t, positionEnu)
      if (active.mode === 'arc') {
        sample(active, Math.min(1, t + 0.022), lookEnu)
        lerp(lookEnu, active.lookTarget, smooth01(0.56, 1, t), lookEnu)
        desiredDirection.x = lookEnu.x - positionEnu.x
        desiredDirection.y = lookEnu.y - positionEnu.y
        desiredDirection.z = lookEnu.z - positionEnu.z
        normalize(desiredDirection, desiredDirection)
        if (t >= 1) set(active.direction, desiredDirection)
        else {
          slerpDirection(
            active.direction,
            desiredDirection,
            1 - Math.exp(-elapsed / 85),
            nextDirection,
          )
          set(active.direction, nextDirection)
        }
      }

      // A dolly carries its initial direction along unchanged. For an arc this
      // is the smoothed direction toward the next Bézier sample/survey centre.
      applyTarget.x = positionEnu.x + active.direction.x
      applyTarget.y = positionEnu.y + active.direction.y
      applyTarget.z = positionEnu.z + active.direction.z
      deps.applyPose(positionEnu, applyTarget)

      if (t >= 1) finish()
    },

    cancel() {
      if (!flight) return
      finish()
    },
  }
}
