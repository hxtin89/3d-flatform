// WASD / arrow / zoom keys (keyboard-navigation.ts) as the CAMERA-phase
// writer while the user owns the camera.
import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { createKeyboardNavigation } from '../../threejs-test/keyboard-navigation'
import { PHASE } from '../frame-phases'
import { domTargets } from '../dom-targets'
import { frame } from '../state/frame'
import { isBootLoading } from '../state/boot-store'
import { sceneState, useSceneStore } from '../state/scene-store'
import { uiState } from '../state/ui-store'
import { geo, isZoomInBlocked } from '../state/survey-frames'
import { useOnRebase } from '../hooks/useOnRebase'
import { dismissAimMode, toggleAimMode } from '../state/actions'
import { activateAimTarget } from './Markers'

export function KeyboardNav() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const globe = useSceneStore((s) => s.globe)

  useEffect(() => {
    if (!globe) return
    const { keyboardGuide, keyboardGuideToggle, keyboardGuideClose, aimModeButton } = domTargets
    if (!keyboardGuide || !keyboardGuideToggle || !keyboardGuideClose || !aimModeButton) {
      console.warn('[keyboard] guide markup missing — keyboard navigation disabled')
      return
    }
    const keyboard = createKeyboardNavigation({
      camera,
      controls: globe.controls,
      guide: keyboardGuide,
      guideToggle: keyboardGuideToggle,
      guideClose: keyboardGuideClose,
      aimToggle: aimModeButton,
      onToggleAim: toggleAimMode,
      onActivateAim: activateAimTarget,
      onDismissAim: dismissAimMode,
    })
    useSceneStore.setState({ keyboard })
    return () => {
      keyboard.dispose()
      useSceneStore.setState({ keyboard: null })
    }
  }, [globe, camera])

  useOnRebase((delta) => sceneState().keyboard?.shiftPivot(delta))

  useFrame(() => {
    const keyboard = sceneState().keyboard
    if (!keyboard) return
    keyboard.update(
      frame.now,
      frame.cameraGroundRange,
      !isBootLoading() && !frame.cameraBusy && !uiState().videoOpen,
      isZoomInBlocked(camera),
      geo.navigationClearance,
    )
  }, PHASE.CAMERA)

  return null
}
