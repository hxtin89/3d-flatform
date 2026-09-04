// Satellite basemap + globe controls (scene/globe.ts) as a component.
// CONTROLS phase: controls.update → navigation floor → basemap tiles.update.
import { useEffect, useCallback } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getEcefRoot } from '../../threejs-test/origin'
import { APP_PARAMS } from '../params'
import { PHASE } from '../frame-phases'
import { frame } from '../state/frame'
import { useBootStore } from '../state/boot-store'
import { sceneState, useSceneStore } from '../state/scene-store'
import { uiState, useUiStore } from '../state/ui-store'
import { enforceNavigationBounds, geo, liftOrbitPivotToFloor } from '../state/survey-frames'
import { useOnRebase } from '../hooks/useOnRebase'
import { useResolutionSync } from '../hooks/useResolutionSync'
import { applyGlobeMemoryBudget } from '../state/actions'
import { createGlobe } from './globe'

/** How long after the last gesture signal streaming stays in gesture mode. */
const GESTURE_HOLD_MS = 250

export function Basemap() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const framesReady = useBootStore((s) => s.framesReady)
  const basemapImagery = useUiStore((s) => s.effective.basemapImagery)

  useEffect(() => {
    if (!framesReady) return
    const globe = createGlobe({
      renderer: gl as any,
      camera,
      scene: getEcefRoot(),
      maptilerKey: APP_PARAMS.maptilerKey,
      cameraClearance: APP_PARAMS.freeOrbit ? 1 : geo.navigationClearance,
      uniforms: frame.uniforms,
      mouseOrbitEaseMs: APP_PARAMS.mouseOrbitEaseMs,
      mouseRotationSpeed: APP_PARAMS.mouseRotationSpeed,
      mouseInertia: APP_PARAMS.mouseInertia,
      mouseOrbitPivot: APP_PARAMS.mouseOrbitPivot,
      adjustOrbitPivot: liftOrbitPivotToFloor,
    })
    if (APP_PARAMS.freeOrbit) {
      globe.controls.maxAltitude = THREE.MathUtils.degToRad(89.9)
      globe.controls.minDistance = 1
    }
    // Gesture bookkeeping for the streaming policy. A wheel zoom fires start
    // and end in the same tick, so the window is a hold-off rather than a
    // flag; the frame loop keeps extending it while the controls report a
    // live gesture, which is also why a missing 'end' cannot get stuck.
    const onStart = () => { frame.gestureUntil = performance.now() + GESTURE_HOLD_MS }
    const onEnd = () => { frame.gestureUntil = performance.now() + GESTURE_HOLD_MS }
    globe.controls.addEventListener('start', onStart)
    globe.controls.addEventListener('end', onEnd)
    useSceneStore.setState({ globe })
    applyGlobeMemoryBudget()
    return () => {
      globe.controls.removeEventListener('start', onStart)
      globe.controls.removeEventListener('end', onEnd)
      globe.dispose()
      useSceneStore.setState({ globe: null })
    }
  }, [framesReady, gl, camera])

  useEffect(() => {
    const globe = sceneState().globe
    if (globe) globe.tiles.group.visible = basemapImagery
  }, [basemapImagery, framesReady])

  // GlobeControls keeps three world points across frames.
  useOnRebase((delta) => {
    const controls = sceneState().globe?.controls as any
    controls?.pivotPoint?.add(delta)
    controls?.zoomPoint?.add(delta)
    controls?.rotationInertiaPivot?.add(delta)
  })

  useResolutionSync(useCallback(() => sceneState().globe?.tiles ?? null, []))

  useFrame(() => {
    const globe = sceneState().globe
    if (!globe) return
    globe.controls.enabled = !uiState().videoOpen
    // EnvironmentControls.state: 0 = NONE. Inertia keeps running after the
    // pointer is up, and that motion is just as expensive to stream into.
    const controls = globe.controls as any
    if (controls.state !== 0 || controls._inertiaNeedsUpdate?.()) frame.gestureUntil = frame.now + GESTURE_HOLD_MS
    globe.updateControls(() => enforceNavigationBounds(camera, globe.controls))
    globe.updateTiles()
  }, PHASE.CONTROLS)

  return null
}
