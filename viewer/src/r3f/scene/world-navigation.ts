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

function activateDatasetOwnership(id: WorldDatasetId, reason: string): boolean {
  const runtime = sceneState().datasets[id]
  if (runtime?.status !== 'ready' || !runtime.frame || !runtime.pointSource || !runtime.activeSource) return false
  const scene = sceneState()
  activateSurveyFrame(runtime.frame)
  useSceneStore.setState({
    activeDatasetId: id,
    stream: runtime.stream,
    pointSource: runtime.pointSource,
    activeSource: runtime.activeSource,
    swapReason: reason,
  })
  scene.adaptiveQuality.setLadder(runtime.activeSource.ladder)
  frame.lastStreamStats = null
  frame.pendingSourceKey = null
  scene.donation?.setVisible(runtime.definition.hasDonationShape && uiState().effective.donationShape)
  applyStreamMemoryBudget()
  resetPerfGovernor()
  useUiStore.setState({ statusLine: `Adaptive streaming · ${runtime.definition.label}` })
  return true
}

/** Queue a user-intended teleport. PointTiles owns the camera dependency. */
export function requestDatasetNavigation(id: WorldDatasetId): void {
  useSceneStore.setState({ navigationRequestId: id })
}

/** User intent: switch the active frame and stage/fly the camera at that site. */
export function navigateToDataset(id: WorldDatasetId, camera: THREE.PerspectiveCamera): boolean {
  const runtime = sceneState().datasets[id]
  if (runtime?.status !== 'ready') return false
  const scene = sceneState()
  scene.rig?.takeover()
  // Captions are DOM overlays, not children of the donation layer; hide the
  // Peru-specific final caption before teleporting away.
  if (!runtime.definition.hasDonationShape) scene.captions?.hide()
  const controls = scene.globe?.controls as any
  stopNavigationInertia(controls)
  if (!activateDatasetOwnership(id, 'site switch')) return false
  stageCamera(camera)
  controls?.resetState?.()
  controls?.pivotPoint?.copy(geo.cloudCenterRender)
  controls?.zoomPoint?.copy(geo.cloudCenterRender)
  controls?.rotationInertiaPivot?.copy(geo.cloudCenterRender)
  return true
}

/** Streaming ownership handoff. Rebase preserves ECEF camera/pivot state. */
export function activateDatasetInPlace(id: WorldDatasetId): boolean {
  const runtime = sceneState().datasets[id]
  if (runtime?.status !== 'ready') return false
  if (!runtime.definition.hasDonationShape) sceneState().captions?.hide()
  return activateDatasetOwnership(id, 'site handoff')
}
