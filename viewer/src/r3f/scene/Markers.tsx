// Interactive hotspots (marker-layer.ts) + aim mode target picking.
import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { createMarkerLayer, type MarkerActionTarget } from '../../threejs-test/marker-layer'
import { getEcefRoot } from '../../threejs-test/origin'
import { APP_PARAMS } from '../params'
import { PHASE } from '../frame-phases'
import { domTargets } from '../dom-targets'
import { frame } from '../state/frame'
import { useBootStore } from '../state/boot-store'
import { sceneState, useSceneStore } from '../state/scene-store'
import { uiState, useUiStore } from '../state/ui-store'
import { geo } from '../state/survey-frames'
import { announceInteraction, setAimMode } from '../state/actions'
import { openFieldVideo } from '../ui/video-modal-actions'

let aimTarget: MarkerActionTarget | null = null

export function activateAimTarget(): boolean {
  if (!uiState().aimMode || uiState().videoOpen) return false
  if (!aimTarget) {
    announceInteraction('Kein interaktives Ziel im Fadenkreuz.')
    return true
  }
  const target = aimTarget
  setAimMode(false, false)
  target.activate()
  return true
}

function updateAimTarget(camera: THREE.PerspectiveCamera): void {
  const markers = sceneState().markers
  const nextTarget = uiState().aimMode
    ? markers?.pickCenteredAction(camera, EXPERIENCE_CONFIG.accessibility.aimTolerancePx) ?? null
    : null
  if (nextTarget?.id === aimTarget?.id) return
  aimTarget = nextTarget
  markers?.setFocusedAction(nextTarget?.id ?? null)
  useUiStore.setState({
    aimHasTarget: Boolean(nextTarget),
    aimLabel: nextTarget ? `${nextTarget.label} · Enter` : 'Ziel suchen',
  })
  if (nextTarget) announceInteraction(`${nextTarget.label} im Fokus. Mit Enter öffnen.`)
}

export function Markers() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const manifest = useBootStore((s) => s.manifest)
  const framesReady = useBootStore((s) => s.framesReady)
  const visible = useUiStore((s) => s.effective.markers)

  useEffect(() => {
    if (!framesReady || !manifest?.areaBbox || !domTargets.markerOverlay) return
    const markers = createMarkerLayer({
      scene: getEcefRoot(),
      overlay: domTargets.markerOverlay,
      enuFrame: geo.enuFrame,
      zOffset: geo.zOffset,
      areaBbox: manifest.areaBbox as [number, number, number, number, number, number],
      centre: [
        geo.cloudCenterEnu.x + EXPERIENCE_CONFIG.markers.centreOffsetM[0],
        geo.cloudCenterEnu.y + EXPERIENCE_CONFIG.markers.centreOffsetM[1],
      ],
      dataset: APP_PARAMS.dataset,
      reducedMotion: APP_PARAMS.reducedMotion,
      onOpenVideo: openFieldVideo,
      onFlyToMarker: (targetEnu) => {
        setAimMode(false, false)
        sceneState().rig?.flyToPoint(targetEnu, EXPERIENCE_CONFIG.flight.markerApproachDistanceM)
      },
    })
    markers.setVisible(uiState().effective.markers)
    useSceneStore.setState({ markers })
    return () => {
      markers.dispose()
      useSceneStore.setState({ markers: null })
      aimTarget = null
    }
  }, [framesReady, manifest])

  useEffect(() => {
    sceneState().markers?.setVisible(visible)
    if (!visible) setAimMode(false, false)
  }, [visible])

  useFrame(() => {
    const markers = sceneState().markers
    if (!markers || !uiState().effective.markers) return
    const { uniforms } = frame
    markers.update(
      frame.now,
      camera,
      frame.cameraGroundRange,
      uniforms.maskCenter.value,
      uniforms.maskRadius.value,
      uniforms.maskMode.value === 2 && uniforms.vignetteStrength.value > 0.01,
    )
    updateAimTarget(camera)
  }, PHASE.LAYERS)

  return null
}
