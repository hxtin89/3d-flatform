// render-options.ts controller wired to the scene handles, plus compare mode
// (which also flips the legacy toggles that live outside render options).
// Port of applyRenderOptions / setCompareMode in main.ts.
import { createRenderOptions, type RenderOptionKey, type RenderOptions } from '../../threejs-test/render-options'
import type { MemoryBudgetSnapshot } from '../../threejs-test/streaming'
import { domTargets } from '../dom-targets'
import { frame } from './frame'
import { sceneState, useSceneStore } from './scene-store'
import { uiState, useUiStore } from './ui-store'
import {
  applyGlobeMemoryBudget, applyPixelRatio, applyPointSize, applyStreamMemoryBudget, setMaskMode, setPointCloudRevealed,
} from './actions'
import { setRainCycleEnabled } from '../scene/Rain'

let compareBudgetSnapshot: { stream: MemoryBudgetSnapshot | null; globe: MemoryBudgetSnapshot | null } | null = null

function applyRenderOptions(effective: Readonly<RenderOptions>, changed: RenderOptionKey[], compareMode: boolean): void {
  const scene = sceneState()
  for (const key of changed) {
    switch (key) {
      case 'sseBrakes':
        if (!effective.sseBrakes) {
          frame.entranceFlightPending = false
          setPointCloudRevealed(true)
        }
        frame.sseAuto = -1
        break
      case 'dynamicPointSize':
        frame.lastAppliedPointSize = -1
        applyPointSize()
        break
      case 'presetBudgets':
        if (!effective.presetBudgets) {
          compareBudgetSnapshot = {
            stream: scene.stream?.getMemoryBudget() ?? null,
            globe: scene.globe?.getMemoryBudget() ?? null,
          }
          applyStreamMemoryBudget()
          applyGlobeMemoryBudget()
        } else {
          if (compareBudgetSnapshot?.stream) scene.stream?.setMemoryBudgetExact(compareBudgetSnapshot.stream)
          if (compareBudgetSnapshot?.globe) scene.globe?.setMemoryBudgetExact(compareBudgetSnapshot.globe)
          compareBudgetSnapshot = null
        }
        break
      case 'pixelRatioCap':
        applyPixelRatio()
        break
      case 'flightPrecisionDrop':
        frame.appliedHighPrecision = null
        break
      // fogAtmosphere, daylightGrading, markers, donationShape, basemapImagery:
      // the owning components subscribe to ui.effective and apply themselves.
      default:
        break
    }
  }
  useUiStore.setState({
    requested: { ...renderOptions.requested() },
    effective: { ...effective },
    compareMode,
  })
}

export const renderOptions = createRenderOptions(applyRenderOptions)
useSceneStore.setState({ renderOptions })

let compareLegacySnapshot: {
  maskMode: number
  cloudIntent: boolean
  rainCycle: boolean
  audioOn: boolean
  highPrecision: boolean
} | null = null

export function setOption(key: RenderOptionKey, on: boolean): void {
  renderOptions.setOption(key, on)
}

export function setCompareMode(on: boolean): void {
  if (on === renderOptions.isCompareMode()) return
  const scene = sceneState()
  if (on) {
    compareLegacySnapshot = {
      maskMode: frame.uniforms.maskMode.value,
      cloudIntent: scene.environment?.getCloudState().intent ?? false,
      rainCycle: frame.rainCycleEnabled,
      audioOn: domTargets.soundToggle?.classList.contains('is-on') ?? false,
      highPrecision: uiState().highPrecision,
    }
    setMaskMode(0)
    scene.environment?.setCloudIntent(false, false)
    setRainCycleEnabled(false)
    void scene.audio?.setEnabled(false)
    useUiStore.setState({ highPrecision: true })
  }
  renderOptions.setCompareMode(on)
  if (!on && compareLegacySnapshot) {
    const snapshot = compareLegacySnapshot
    compareLegacySnapshot = null
    setMaskMode(snapshot.maskMode)
    scene.environment?.setCloudIntent(snapshot.cloudIntent, false)
    setRainCycleEnabled(snapshot.rainCycle)
    if (snapshot.audioOn) void scene.audio?.setEnabled(true)
    useUiStore.setState({ highPrecision: snapshot.highPrecision })
    frame.appliedHighPrecision = null
  }
}
