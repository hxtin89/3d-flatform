// Mounts the spring camera rig (camera/camera-rig.ts) as the CAMERA-phase
// writer and wires takeover (controls 'start' event, first navigation key).
import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { PHASE } from '../frame-phases'
import { frame } from '../state/frame'
import { useBootStore } from '../state/boot-store'
import { sceneState, useSceneStore } from '../state/scene-store'
import { uiState, useUiStore } from '../state/ui-store'
import { enuToWorld, geo, updateOrigin, worldToEnu } from '../state/survey-frames'
import { createCameraRig } from '../camera/camera-rig'
import { anchorEnu, frameDistanceM, orbitRangeM, parcelHeightM } from '../camera/staging'
import { releaseStoryFx, resetStoryFx, updateStoryFx } from '../camera/story-fx'

const NAV_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

export function CameraRig() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const globe = useSceneStore((s) => s.globe)
  const framesReady = useBootStore((s) => s.framesReady)

  useEffect(() => {
    if (!framesReady || !globe) return
    const controls = globe.controls as any
    const rig = createCameraRig({
      camera,
      enuUp: geo.enuUp,
      worldToEnu,
      enuToWorld,
      anchor: anchorEnu,
      frameDistanceM: () => frameDistanceM(camera),
      orbitRangeM: () => orbitRangeM(camera),
      parcelHeightM,
      floorZ: () => geo.navigationFloorZ,
      upAt: (position, target) => {
        if (typeof controls.getUpDirection === 'function' && controls.ellipsoid) {
          controls.getUpDirection(position, target) // fills target, returns nothing
          return target
        }
        return target.copy(geo.enuUp)
      },
      controlsBusy: () => controls.state !== 0 || Boolean(controls._inertiaNeedsUpdate?.()),
      onCameraJump: () => updateOrigin(camera, true),
      onModeChange: (mode) => {
        // The endless orbit is not a flight: once the springs settled the
        // streaming floor lifts and the keyboard is live (a key takes over).
        frame.cameraBusy = mode === 'story' || mode === 'resuming' || mode === 'flyTo'
        useUiStore.setState({ rigMode: mode })
        if (mode === 'user') releaseStoryFx()
        if (mode === 'story' || mode === 'resuming') { /* fx follow the progress callback */ }
      },
      onStoryProgress: (progress, arrivalMs) => {
        frame.cameraBusy = arrivalMs === null || sceneState().rig?.mode() === 'resuming'
        updateStoryFx(progress, arrivalMs)
      },
    })
    const rigWithLifecycle = rig
    const originalStart = rig.startStory
    rig.startStory = () => { resetStoryFx(); originalStart() }
    rig.replay = rig.startStory
    useSceneStore.setState({ rig })

    const onControlsStart = () => rig.takeover()
    controls.addEventListener('start', onControlsStart)
    const onKeyDown = (event: KeyboardEvent) => {
      if (!NAV_CODES.has(event.code) || uiState().videoOpen) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return
      rig.takeover()
    }
    window.addEventListener('keydown', onKeyDown, true)
    // Optional idle resume (config story.takeover.resume === 'idle'): only
    // after resumeIdleMs without any input and with the pointer off the canvas.
    let lastInput = performance.now()
    let pointerOverCanvas = false
    const canvas = (globe.tiles as any).renderer?.domElement ?? document.querySelector('#viewHost canvas')
    const noteInput = () => { lastInput = performance.now() }
    const onEnter = () => { pointerOverCanvas = true }
    const onLeave = () => { pointerOverCanvas = false }
    const idle = EXPERIENCE_CONFIG.story.takeover.resume === 'idle'
    let idleTimer = 0
    if (idle) {
      window.addEventListener('pointermove', noteInput, true)
      window.addEventListener('pointerdown', noteInput, true)
      window.addEventListener('wheel', noteInput, true)
      window.addEventListener('keydown', noteInput, true)
      canvas?.addEventListener('pointerenter', onEnter)
      canvas?.addEventListener('pointerleave', onLeave)
      idleTimer = window.setInterval(() => {
        if (rig.mode() !== 'user' || pointerOverCanvas || uiState().videoOpen) return
        if (performance.now() - lastInput >= EXPERIENCE_CONFIG.story.takeover.resumeIdleMs) rig.resume()
      }, 1000)
    }
    return () => {
      if (idle) {
        window.removeEventListener('pointermove', noteInput, true)
        window.removeEventListener('pointerdown', noteInput, true)
        window.removeEventListener('wheel', noteInput, true)
        window.removeEventListener('keydown', noteInput, true)
        canvas?.removeEventListener('pointerenter', onEnter)
        canvas?.removeEventListener('pointerleave', onLeave)
        window.clearInterval(idleTimer)
      }
      controls.removeEventListener('start', onControlsStart)
      window.removeEventListener('keydown', onKeyDown, true)
      rigWithLifecycle.dispose()
      useSceneStore.setState({ rig: null })
      frame.cameraBusy = false
    }
  }, [framesReady, globe, camera])

  useFrame(() => {
    const rig = sceneState().rig as ReturnType<typeof createCameraRig> | null
    rig?.update(frame.now)
  }, PHASE.CAMERA)

  return null
}
