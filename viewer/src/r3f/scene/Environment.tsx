// Daylight cycle, sky/fog colours, clouds (environment-layer.ts).
import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { createEnvironmentLayer } from '../../threejs-test/environment-layer'
import { getEcefRoot } from '../../threejs-test/origin'
import { APP_PARAMS } from '../params'
import { PHASE } from '../frame-phases'
import { frame } from '../state/frame'
import { isBootLoading, useBootStore } from '../state/boot-store'
import { sceneState, useSceneStore } from '../state/scene-store'
import { uiState, useUiStore } from '../state/ui-store'
import { geo } from '../state/survey-frames'

export function Environment() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const framesReady = useBootStore((s) => s.framesReady)
  const grading = useUiStore((s) => s.effective.daylightGrading)

  useEffect(() => {
    const boot = useBootStore.getState()
    if (!framesReady || !boot.manifest || !boot.cloudNoiseTexture) return
    const layer = createEnvironmentLayer({
      scene: getEcefRoot(),
      renderer: gl as any,
      fog: frame.fog,
      uniforms: frame.uniforms,
      enuFrame: geo.enuFrame,
      zOffset: geo.zOffset,
      surveyCentreEnu: geo.cloudCenterEnu,
      surveyRadiusM: geo.navigationBoundsRadius,
      originLonLat: boot.manifest.enuOriginLonLat,
      cloudNoiseTexture: boot.cloudNoiseTexture,
      isWebGPU: boot.isWebGPU ?? true,
      allowStoredPreferences: APP_PARAMS.panelEnabled,
      reducedMotion: APP_PARAMS.reducedMotion,
      onCloudStateChange: (state) => useUiStore.setState({ cloudState: { ...state } }),
    })
    useUiStore.setState({ cloudState: { ...layer.getCloudState() } })
    layer.setGradingEnabled(uiState().effective.daylightGrading)
    useSceneStore.setState({ environment: layer })
    publishDaylight(layer.getDaylightState())
    return () => {
      layer.dispose()
      useSceneStore.setState({ environment: null })
    }
  }, [framesReady, gl])

  useEffect(() => { sceneState().environment?.setGradingEnabled(grading) }, [grading])

  useFrame(() => {
    const layer = sceneState().environment
    if (!layer) return
    const state = layer.update(
      frame.now,
      camera,
      frame.cameraGroundRange,
      frame.fps.fps,
      !isBootLoading() && !frame.cameraBusy && !uiState().videoOpen,
    )
    frame.daylight = state
    publishDaylight(state)
  }, PHASE.ENVIRONMENT)

  return null
}

let lastLabel = ''
let lastLive: boolean | null = null
let lastPhase = ''
function publishDaylight(state: { timeLabel: string; live: boolean; phase: any; peruMinutes: number }): void {
  if (state.timeLabel === lastLabel && state.live === lastLive && state.phase === lastPhase) return
  lastLabel = state.timeLabel
  lastLive = state.live
  lastPhase = state.phase
  useUiStore.setState({ daylight: { timeLabel: state.timeLabel, live: state.live, phase: state.phase, peruMinutes: state.peruMinutes } })
}
