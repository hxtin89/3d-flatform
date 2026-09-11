import type * as THREE from 'three'
import { stageCamera } from '../camera/staging'
import { stopNavigationInertia } from '../controls/navigation-gestures'
import { applyStreamMemoryBudget } from '../state/actions'
import { frame } from '../state/frame'
import { sceneState, useSceneStore } from '../state/scene-store'
import { activateSurveyFrame, geo } from '../state/survey-frames'
import { uiState, useUiStore } from '../state/ui-store'
import type { WorldDatasetId } from '../world-datasets'
import { resetPerfGovernor } from '../state/perf-governor'

/** Switch the active frame and camera without creating a second navigation system. */
export function navigateToDataset(id: WorldDatasetId, camera: THREE.PerspectiveCamera): void {
  const runtime = sceneState().datasets[id]
  if (runtime?.status !== 'ready' || !runtime.frame || !runtime.pointSource || !runtime.activeSource) return
  const scene = sceneState()
  scene.rig?.takeover()
  // Captions are DOM overlays, not children of the donation layer; hide the
  // Peru-specific final caption before teleporting away.
  if (!runtime.definition.hasDonationShape) scene.captions?.hide()
  const controls = scene.globe?.controls as any
  stopNavigationInertia(controls)
  activateSurveyFrame(runtime.frame)
  useSceneStore.setState({
    activeDatasetId: id,
    stream: runtime.stream,
    pointSource: runtime.pointSource,
    activeSource: runtime.activeSource,
    swapReason: 'site switch',
  })
  scene.adaptiveQuality.setLadder(runtime.activeSource.ladder)
  frame.lastStreamStats = null
  frame.pendingSourceKey = null
  stageCamera(camera)
  controls?.resetState?.()
  controls?.pivotPoint?.copy(geo.cloudCenterRender)
  controls?.zoomPoint?.copy(geo.cloudCenterRender)
  controls?.rotationInertiaPivot?.copy(geo.cloudCenterRender)
  scene.donation?.setVisible(runtime.definition.hasDonationShape && uiState().effective.donationShape)
  applyStreamMemoryBudget()
  resetPerfGovernor()
  useUiStore.setState({ statusLine: `Adaptive streaming · ${runtime.definition.label}` })
}
