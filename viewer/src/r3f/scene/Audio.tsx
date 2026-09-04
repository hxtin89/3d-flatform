// Day/night/rain ambient loops (audio-layer.ts). The layer paints the sound
// toggle itself, so it only needs the two DOM elements.
import { useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { createAudioLayer } from '../../threejs-test/audio-layer'
import { PHASE } from '../frame-phases'
import { domTargets } from '../dom-targets'
import { frame } from '../state/frame'
import { sceneState, useSceneStore } from '../state/scene-store'

export function Audio() {
  useEffect(() => {
    const { soundToggle, audioStatus } = domTargets
    if (!soundToggle || !audioStatus) return
    const layer = createAudioLayer({ toggle: soundToggle, status: audioStatus })
    soundToggle.disabled = false
    useSceneStore.setState({ audio: layer })
    return () => {
      layer.dispose()
      useSceneStore.setState({ audio: null })
    }
  }, [])

  useFrame(() => {
    const layer = sceneState().audio
    if (!layer || !frame.daylight) return
    layer.update(frame.daylight, frame.rainVisualActive)
  }, PHASE.AUDIO)

  return null
}
