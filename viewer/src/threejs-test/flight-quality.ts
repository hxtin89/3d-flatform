// Density brake for the entrance flight. Split out of main.ts so the ramp maths
// can be tested without a browser: the flight is the one moment a user cannot
// re-trigger without reloading, so getting it wrong is expensive to notice.
// Extension-qualified because this module is loaded directly by node --test
// (npm run bench:verify), which does not resolve extensionless specifiers.
import { EXPERIENCE_CONFIG } from './config.ts'

/** Local copy of main.ts' smoothstep — three lines, and importing main.ts here
 * would drag the whole application into the test process. */
function smooth01(value: number): number {
  const t = Math.min(1, Math.max(0, value))
  return t * t * (3 - 2 * t)
}

export interface FlightSseFloorParams {
  /** Whether the cinematic camera flight is currently running. */
  flying: boolean
  /** Milliseconds since the flight ended; ignored while `flying`. */
  msSinceLanding: number
  /** Distance-driven target the ramp eases down to. */
  targetSse: number
}

/**
 * Coarsest screen-space error the streamer may refine to right now.
 *
 * While the flight runs the cloud is kilometres away, where the finest levels
 * are invisible but still cost a phone its frame rate, so refinement is pinned
 * at `lod.flightSse`. After landing the floor eases down to the distance-driven
 * target over `lod.flightSseRampMs` and then releases entirely (0 = no floor),
 * which spreads the refill across a second instead of one frame.
 *
 * Interpolated in log(SSE) because the value is a ratio: a linear ramp from 64
 * to 4 would spend most of its time in the top half and then drop off a cliff.
 */
export function flightSseFloor(params: FlightSseFloorParams): number {
  const { flightSse, flightSseRampMs } = EXPERIENCE_CONFIG.lod
  if (params.flying) return flightSse
  if (!(params.msSinceLanding < flightSseRampMs)) return 0

  const eased = smooth01(params.msSinceLanding / flightSseRampMs)
  const from = Math.log(flightSse)
  const to = Math.log(Math.max(params.targetSse, 1))
  return Math.exp(from + (to - from) * eased)
}
