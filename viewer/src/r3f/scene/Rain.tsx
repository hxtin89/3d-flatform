// Rain sprites follow the camera in render space (direct scene child) and
// run on the automatic dry/rain cycle from config.rain.
import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { createRainLayer } from '../../threejs-test/rain-layer'
import { PHASE } from '../frame-phases'
import { frame } from '../state/frame'
import { sceneState, useSceneStore } from '../state/scene-store'
import { useUiStore } from '../state/ui-store'
import { isBootLoading } from '../state/boot-store'

const DRY = EXPERIENCE_CONFIG.rain.dryDurationMs
const ACTIVE = EXPERIENCE_CONFIG.rain.activeDurationMs
const CYCLE = DRY + ACTIVE

export function setRainCycleEnabled(enabled: boolean): void {
  frame.rainCycleEnabled = enabled
  frame.rainCycleStartedAt = performance.now()
  frame.rainRequested = false
  sceneState().rain?.setEnabled(false)
  if (!enabled) frame.rainVisualActive = false
  useUiStore.setState({ rainCycleEnabled: enabled, rainRequested: false, rainVisualActive: frame.rainVisualActive })
}

export function Rain() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene) as THREE.Scene
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera

  useEffect(() => {
    const layer = createRainLayer(scene)
    layer.setEnabled(frame.rainRequested)
    useSceneStore.setState({ rain: layer })
    void layer.precompile(gl as any, camera).catch(error => console.warn('[rain] precompile failed', error))
    return () => {
      layer.dispose()
      useSceneStore.setState({ rain: null })
    }
  }, [scene, gl, camera])

  useFrame(() => {
    const layer = sceneState().rain
    if (!layer) return
    const phase = (frame.now - frame.rainCycleStartedAt) % CYCLE
    const nextRequested = !isBootLoading() && frame.rainCycleEnabled && phase >= DRY
    if (nextRequested !== frame.rainRequested) {
      frame.rainRequested = nextRequested
      layer.setEnabled(nextRequested)
      useUiStore.setState({ rainRequested: nextRequested })
    }
    const active = layer.update(frame.now, camera, frame.cameraGroundRange)
    if (active !== frame.rainVisualActive) {
      frame.rainVisualActive = active
      useUiStore.setState({ rainVisualActive: active })
    }
  }, PHASE.RAIN)

  return null
}
