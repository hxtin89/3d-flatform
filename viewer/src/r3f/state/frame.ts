// Mutable per-frame state. Never React state: useFrame callbacks read and
// write this object directly, stores only receive throttled snapshots.
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { createUniforms, type CloudUniforms } from '../../threejs-test/point-cloud'
import { Fps } from '../../threejs-test/stats'
import type { StreamingStats } from '../../threejs-test/streaming'
import type { ZoomBand } from '../../threejs-test/point-source'
import type { DaylightState } from '../../threejs-test/environment-layer'

export const DAYLIGHT_SKY = 0x8bc9ec

export interface FrameState {
  /** performance.now() sampled once per frame in the ORIGIN phase. */
  now: number
  fps: Fps
  uniforms: CloudUniforms
  fog: THREE.Fog
  // camera ranges (updateMaskFollow)
  cameraGroundRange: number
  cameraCloudRange: number
  cameraAltitude: number
  rangeDebug: Record<string, number> | null
  followEnu: THREE.Vector2
  followInit: boolean
  maskSphereWorld: THREE.Vector3
  maskWorldActive: boolean
  maskWorldRadius: number
  // camera ownership
  /** 0 while the story descent is at its start, 1 when settled — drives the
   * vignette blend and the cloud reveal (old cinematicFlightProgress). */
  cinematicFlightProgress: number
  /** True while springs own the camera (story, resume, fly-to). */
  cameraBusy: boolean
  flightEndedAt: number
  gestureEndedAt: number
  wasFlying: boolean
  wasGesturing: boolean
  /** Gesture hold-off (250 ms after the last controls 'end' event). */
  gestureUntil: number
  pointCloudRevealed: boolean
  entranceFlightPending: boolean
  appliedHighPrecision: boolean | null
  // atmosphere
  atmosphereFar: number
  distanceCutoff: number
  fogRange: number
  atmosphereFarScale: number
  lastAtmosphereUpdate: number
  // streaming
  sseAuto: number
  band: ZoomBand
  lastStreamStats: StreamingStats | null
  pendingSourceKey: string | null
  pendingSince: number
  lastSwapAt: number
  userSwapRequested: boolean
  pointSizeScale: number
  lastAppliedPointSize: number
  pointSizePx: number
  // environment
  daylight: DaylightState | null
  rainCycleEnabled: boolean
  rainCycleStartedAt: number
  rainRequested: boolean
  rainVisualActive: boolean
  // loader
  loaderTarget: number
  loaderLastAdvance: number
}

export const frame: FrameState = {
  now: performance.now(),
  fps: new Fps(),
  uniforms: createUniforms(),
  fog: new THREE.Fog(
    DAYLIGHT_SKY,
    EXPERIENCE_CONFIG.atmosphere.maximumFarM * EXPERIENCE_CONFIG.atmosphere.fogNearFactor,
    EXPERIENCE_CONFIG.atmosphere.maximumFarM * EXPERIENCE_CONFIG.atmosphere.fogFarFactor,
  ),
  cameraGroundRange: Infinity,
  cameraCloudRange: Infinity,
  cameraAltitude: 0,
  rangeDebug: null,
  followEnu: new THREE.Vector2(),
  followInit: false,
  maskSphereWorld: new THREE.Vector3(),
  maskWorldActive: false,
  maskWorldRadius: 0,
  cinematicFlightProgress: 1,
  cameraBusy: false,
  flightEndedAt: -Infinity,
  gestureEndedAt: -Infinity,
  wasFlying: false,
  wasGesturing: false,
  gestureUntil: -Infinity,
  pointCloudRevealed: true,
  entranceFlightPending: false,
  appliedHighPrecision: null,
  atmosphereFar: EXPERIENCE_CONFIG.atmosphere.maximumFarM,
  distanceCutoff: EXPERIENCE_CONFIG.lod.distanceCutoffMaxM,
  fogRange: EXPERIENCE_CONFIG.lod.distanceCutoffMaxM,
  atmosphereFarScale: EXPERIENCE_CONFIG.atmosphere.farScaleByPreset.strong,
  lastAtmosphereUpdate: -Infinity,
  sseAuto: 256,
  band: 2,
  lastStreamStats: null,
  pendingSourceKey: null,
  pendingSince: 0,
  lastSwapAt: -Infinity,
  userSwapRequested: false,
  pointSizeScale: 1,
  lastAppliedPointSize: -1,
  pointSizePx: 0,
  daylight: null,
  rainCycleEnabled: true,
  rainCycleStartedAt: performance.now(),
  rainRequested: false,
  rainVisualActive: false,
  loaderTarget: 0,
  loaderLastAdvance: performance.now(),
}

/** Frame-rate independent smoothing factor for a time constant in ms. */
export function smoothingAlpha(dtMs: number, tauMs: number): number {
  return 1 - Math.exp(-Math.max(0, dtMs) / tauMs)
}

export function smooth01(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
