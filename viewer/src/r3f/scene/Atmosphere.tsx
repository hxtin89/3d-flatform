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

const SMOOTH_TAU_MS = 270
let lastNow = 0
let appliedNear = -1
let appliedFar = -1

function applyPlanes(camera: THREE.PerspectiveCamera, near: number, far: number, force = false): void {
  const nearMoved = Math.abs(near - appliedNear) > appliedNear * 0.01
  const farMoved = Math.abs(far - appliedFar) > appliedFar * 0.01
  if (!force && !nearMoved && !farMoved) return
  appliedNear = near
  appliedFar = far
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

export function updateDistanceCutoff(dt: number, snap = false): void {
  const lod = EXPERIENCE_CONFIG.lod
  const alpha = snap ? 1 : smoothingAlpha(dt, SMOOTH_TAU_MS)
  const target = THREE.MathUtils.clamp(
    frame.cameraAltitude * lod.distanceCutoffHeightFactor,
    lod.distanceCutoffMinM,
    lod.distanceCutoffMaxM,
  )
  frame.distanceCutoff = THREE.MathUtils.lerp(frame.distanceCutoff, target, alpha)
  const fogTarget = Math.max(frame.cameraAltitude * lod.distanceCutoffHeightFactor, lod.distanceCutoffMinM)
  frame.fogRange = THREE.MathUtils.lerp(frame.fogRange, fogTarget, alpha)
  frame.uniforms.cutoffDistance.value = frame.distanceCutoff
  frame.uniforms.fadeDistance.value = frame.distanceCutoff * lod.distanceFadeStart
  const detailRange = Math.max(frame.cameraAltitude * lod.distanceDetailHeightFactor, lod.distanceDetailMinM)
  sceneState().stream?.setDistanceCutoff(frame.distanceCutoff, detailRange)
}

export function Atmosphere() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const fogOn = useUiStore((s) => s.effective.fogAtmosphere)

  // Toggling the option snaps instead of lerping down from the far plane.
  useEffect(() => { updateAtmosphere(camera, 0, true) }, [fogOn, camera])

  useFrame(() => {
    const dt = lastNow ? Math.min(100, frame.now - lastNow) : 16
    lastNow = frame.now
    updateDistanceCutoff(dt)
    if (!geo.ready) return
    updateAtmosphere(camera, dt)
  }, PHASE.PLANES)

  return fogOn ? <primitive object={frame.fog} attach="fog" /> : null
}
