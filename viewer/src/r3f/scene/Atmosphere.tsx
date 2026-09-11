// Distance cutoff (CUTOFF) and the one owner of camera.near/far + fog (PLANES).
// Ports updateDistanceCutoff / updateAtmosphere from main.ts; the controls no
// longer touch the planes (WildGlobeControls), so the projection matrix is
// rebuilt only when either plane moved by more than 1 %.
import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { PHASE } from '../frame-phases'
import { frame, smoothingAlpha } from '../state/frame'
import { sceneState } from '../state/scene-store'
import { useUiStore } from '../state/ui-store'
import { geo } from '../state/survey-frames'
import { updatePerfGovernor } from '../state/perf-governor'

const SMOOTH_TAU_MS = 270
let lastNow = 0
const _forward = new THREE.Vector3()

function applyPlanes(camera: THREE.PerspectiveCamera, near: number, far: number, force = false): void {
  // R3F can reset camera options during a resize/DPR change. Compare the
  // actual camera, so an unchanged target still repairs an external reset.
  const nearMoved = Math.abs(near - camera.near) > camera.near * 0.01
  const farMoved = Math.abs(far - camera.far) > camera.far * 0.01
  if (!force && !nearMoved && !farMoved) return
  camera.near = near
  camera.far = far
  camera.updateProjectionMatrix()
}

export function updateAtmosphere(camera: THREE.PerspectiveCamera, dt: number, snap = false): void {
  const atmosphere = EXPERIENCE_CONFIG.atmosphere
  const lod = EXPERIENCE_CONFIG.lod
  const fogOn = useUiStore.getState().effective.fogAtmosphere
  const range = Number.isFinite(frame.cameraGroundRange) ? frame.cameraGroundRange : atmosphere.fallbackRangeM
  const alpha = snap ? 1 : smoothingAlpha(dt, SMOOTH_TAU_MS)

  if (fogOn) {
    const targetFar = THREE.MathUtils.clamp(
      range * atmosphere.farRangeMultiplier * frame.atmosphereFarScale,
      atmosphere.minimumFarM,
      atmosphere.maximumFarM * frame.atmosphereFarScale,
    )
    frame.atmosphereFar = THREE.MathUtils.lerp(frame.atmosphereFar, targetFar, alpha)
    const fogFar = Math.min(frame.atmosphereFar * atmosphere.fogFarFactor, frame.fogRange)
    frame.fog.far = fogFar
    frame.fog.near = Math.min(frame.atmosphereFar * atmosphere.fogNearFactor, fogFar * lod.distanceFogNearFraction)
  } else {
    frame.atmosphereFar = atmosphere.maximumFarM
  }
  // Near follows the height over the floor: 2 m at the canopy, 200 m from orbit.
  const near = THREE.MathUtils.clamp(frame.cameraAltitude * 0.05, 2, 200)
  applyPlanes(camera, near, frame.atmosphereFar, snap)
}

/** 0 = camera looks at the horizon, 1 = straight down. */
function downFactor(camera: THREE.Camera): number {
  camera.getWorldDirection(_forward)
  return THREE.MathUtils.clamp(-_forward.dot(camera.up), 0, 1)
}

export function updateDistanceCutoff(camera: THREE.PerspectiveCamera, dt: number, snap = false): void {
  const lod = EXPERIENCE_CONFIG.lod
  const fov = EXPERIENCE_CONFIG.foveation
  const alpha = snap ? 1 : smoothingAlpha(dt, SMOOTH_TAU_MS)
  // A flat view sees a wedge several kilometres long where a nadir view sees a
  // disc, so both the cutoff and the taper distance follow the camera pitch.
  const down = downFactor(camera)
  const cutoffPitch = THREE.MathUtils.lerp(fov.cutoffFlat, fov.cutoffDown, down)
  const detailPitch = THREE.MathUtils.lerp(fov.detailFlat, fov.detailDown, down)
  const governor = updatePerfGovernor(dt)
  const target = Math.max(
    EXPERIENCE_CONFIG.perf.minCutoffM,
    THREE.MathUtils.clamp(
      frame.cameraAltitude * lod.distanceCutoffHeightFactor,
      lod.distanceCutoffMinM,
      lod.distanceCutoffMaxM,
    ) * cutoffPitch * governor,
  )
  frame.distanceCutoff = THREE.MathUtils.lerp(frame.distanceCutoff, target, alpha)
  // Follow the point fade at close range, but preserve the original Three.js
  // uncapped height rule in the entrance flight: a 12km fog ceiling hides the
  // whole basemap when the camera is still far above it.
  const fogTarget = Math.max(
    Math.max(frame.cameraAltitude * lod.distanceCutoffHeightFactor, lod.distanceCutoffMinM)
      * cutoffPitch * governor,
    EXPERIENCE_CONFIG.perf.minCutoffM,
  )
  frame.fogRange = THREE.MathUtils.lerp(frame.fogRange, fogTarget, alpha)
  frame.uniforms.cutoffDistance.value = frame.distanceCutoff
  frame.uniforms.fadeDistance.value = frame.distanceCutoff * lod.distanceFadeStart
  const detailRange = Math.max(
    frame.cameraAltitude * lod.distanceDetailHeightFactor * detailPitch,
    lod.distanceDetailMinM * detailPitch,
  )
  for (const runtime of Object.values(sceneState().datasets)) {
    runtime?.stream?.setDistanceCutoff(frame.distanceCutoff, detailRange)
  }
}

export function Atmosphere() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const fogOn = useUiStore((s) => s.effective.fogAtmosphere)

  // Toggling the option snaps instead of lerping down from the far plane.
  useEffect(() => { updateAtmosphere(camera, 0, true) }, [fogOn, camera])

  useFrame(() => {
    const dt = lastNow ? frame.now - lastNow : 16
    lastNow = frame.now
    updateDistanceCutoff(camera, dt)
    if (!geo.ready) return
    updateAtmosphere(camera, Math.min(100, dt))
  }, PHASE.PLANES)

  return fogOn ? <primitive object={frame.fog} attach="fog" /> : null
}
