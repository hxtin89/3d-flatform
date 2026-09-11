// Imperative actions shared by UI and scene code: mask mode, pixel ratio,
// memory budgets, point size, bench preset, the entrance. Ports of the
// corresponding functions in main.ts, reading handles from the stores.
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import type { BenchPreset } from '../../threejs-test/eagle-bench'
import { APP_PARAMS } from '../params'
import { frame } from './frame'
import { sceneState, useSceneStore } from './scene-store'
import { useUiStore, uiState } from './ui-store'
import { isBootLoading, useBootStore } from './boot-store'
import { allocateWorldMemoryBudget } from './world-memory-budget'

const MIB = 1024 * 1024
/** Fixed high budgets while presetBudgets is off (compare mode). */
export const COMPARE_STREAM_BUDGET = { cacheBytes: 768 * MIB, gpuBytes: 384 * MIB }
export const COMPARE_GLOBE_BUDGET = { cacheBytes: 320 * MIB, gpuBytes: 96 * MIB }
/** Cache and GPU residency per measured device tier. */
const STREAM_BUDGET_BY_PRESET: Record<BenchPreset, { cacheBytes: number; gpuBytes: number }> = {
  strong: { cacheBytes: 384 * MIB, gpuBytes: 256 * MIB },
  medium: { cacheBytes: 256 * MIB, gpuBytes: 176 * MIB },
  constrained: { cacheBytes: 160 * MIB, gpuBytes: 112 * MIB },
}
const GLOBE_BUDGET_BY_PRESET: Record<BenchPreset, [number, number]> = {
  // 512px imagery keeps ancestors and siblings to cover transitions. The old
  // 96MiB cap filled at 94 tiles and stranded the near view at zoom 15.
  // Retain decoded imagery on CPU; GPU residency still has its own budget.
  strong: [320 * MIB, 96 * MIB],
  medium: [256 * MIB, 64 * MIB],
  constrained: [192 * MIB, 48 * MIB],
}

/** Cap the bench preset chose; applyPixelRatio re-applies it flag-aware. */
let presetPixelRatioCap = 1.25

export function effectiveOptions() {
  return sceneState().renderOptions?.effective() ?? uiState().effective
}

export function setMaskMode(mode: number): void {
  frame.uniforms.maskMode.value = mode
  if (mode !== 2) {
    frame.uniforms.vignetteStrength.value = 0
    useUiStore.setState({ vignetteOpacity: 0 })
  }
  useUiStore.setState({ maskMode: mode })
}

/** DPR goes through R3F (its resize handler re-applies it); the tile
 * renderers re-read the backbuffer size in useResolutionSync. */
export function applyPixelRatio(): void {
  const dpr = effectiveOptions().pixelRatioCap
    ? Math.min(window.devicePixelRatio, presetPixelRatioCap)
    : window.devicePixelRatio
  if (uiState().dpr !== dpr) useUiStore.setState({ dpr })
}

/** Single place the stream budget comes from, so a rebuilt streamer never
 * falls back to its construction defaults. */
export function applyStreamMemoryBudget(): void {
  const scene = sceneState()
  const runtimes = Object.values(scene.datasets).filter((runtime) => runtime?.stream)
  if (!runtimes.length) return
  const total = effectiveOptions().presetBudgets
    ? STREAM_BUDGET_BY_PRESET[useBootStore.getState().benchPreset]
    : COMPARE_STREAM_BUDGET
  const ids = runtimes.map((runtime) => runtime!.definition.id)
  const activeId = ids.includes(scene.activeDatasetId) ? scene.activeDatasetId : ids[0]
  const allocations = allocateWorldMemoryBudget(total, ids, activeId)
  for (const runtime of runtimes) {
    const allocation = allocations[runtime!.definition.id]
    runtime!.stream!.setMemoryBudget(allocation.cacheBytes, allocation.gpuBytes)
  }
}

export function applyGlobeMemoryBudget(): void {
  const globe = sceneState().globe
  if (!globe) return
  if (!effectiveOptions().presetBudgets) {
    globe.setMemoryBudget(COMPARE_GLOBE_BUDGET.cacheBytes, COMPARE_GLOBE_BUDGET.gpuBytes)
    return
  }
  const [cache, gpu] = GLOBE_BUDGET_BY_PRESET[useBootStore.getState().benchPreset]
  globe.setMemoryBudget(cache, gpu)
}

/** Point size follows camera height continuously (log-height interpolation
 * of the measured anchors); the slider stays a live multiplier. */
function basePointSizeForHeight(heightM: number): number {
  const anchors = EXPERIENCE_CONFIG.lod.pointSizeByHeightM
  const height = Math.max(1, heightM)
  if (height <= anchors[0][0]) return anchors[0][1]
  const last = anchors[anchors.length - 1]
  if (height >= last[0]) return last[1]
  for (let i = 1; i < anchors.length; i++) {
    const [hiH, hiPx] = anchors[i]
    if (height > hiH) continue
    const [loH, loPx] = anchors[i - 1]
    const t = (Math.log(height) - Math.log(loH)) / (Math.log(hiH) - Math.log(loH))
    return loPx + (hiPx - loPx) * t
  }
  return last[1]
}

export function applyPointSize(): void {
  const base = effectiveOptions().dynamicPointSize
    ? basePointSizeForHeight(frame.cameraAltitude)
    : EXPERIENCE_CONFIG.lod.fixedPointSizePx
  const pixels = base * EXPERIENCE_CONFIG.lod.pointSizeMultiplier * frame.pointSizeScale
  if (Math.abs(pixels - frame.lastAppliedPointSize) < 0.02) return
  frame.lastAppliedPointSize = pixels
  frame.uniforms.pointSize.value = pixels
  frame.pointSizePx = pixels
}

export function setPointSizeScale(scale: number): void {
  frame.pointSizeScale = scale
  frame.lastAppliedPointSize = -1
  applyPointSize()
  useUiStore.setState({ pointSizeScale: scale, pointSizePx: frame.pointSizePx })
}

export function setPointCloudRevealed(revealed: boolean): void {
  frame.pointCloudRevealed = revealed
  for (const runtime of Object.values(sceneState().datasets)) runtime?.stream && (runtime.stream.group.visible = revealed)
}

/** Turn the loader benchmark into start settings. Port of applyBenchPreset. */
export function applyBenchPreset(): void {
  const scene = sceneState()
  const measured = scene.bench?.result() ?? null
  const heuristicTier = scene.environment?.getCloudState().tier ?? 'balanced'
  const preset: BenchPreset = measured?.preset
    ?? (heuristicTier === 'strong' ? 'strong' : heuristicTier === 'constrained' ? 'constrained' : 'medium')
  useBootStore.setState({ benchPreset: preset })
  console.info(
    `[eagle-bench] ${measured && measured.preset
      ? `${Math.round(measured.pointsAtTarget / 1000)}k of ${Math.round(measured.maxPoints / 1000)}k pts @${EXPERIENCE_CONFIG.eagleBench.targetFps}fps (${measured.samples} samples)`
      : 'no measurement (heuristic fallback)'} → preset ${preset}`,
  )
  const compare = scene.renderOptions?.isCompareMode() ?? false
  const options = effectiveOptions()
  const table = {
    strong: { mask: 0, dpr: 1.25, floor: 1, tier: 'strong' as const },
    medium: { mask: 0, dpr: 1.1, floor: 1.4, tier: 'balanced' as const },
    constrained: { mask: 0, dpr: 1, floor: 2, tier: 'constrained' as const },
  }[preset]
  if (!compare) setMaskMode(table.mask)
  presetPixelRatioCap = table.dpr
  scene.adaptiveQuality.setPressureFloor(table.floor)
  scene.environment?.applyMeasuredTier(table.tier)
  frame.atmosphereFarScale = EXPERIENCE_CONFIG.atmosphere.farScaleByPreset[preset]
  if (options.presetBudgets) {
    applyStreamMemoryBudget()
    applyGlobeMemoryBudget()
  }
  if (preset === 'constrained' && !compare) setPointSizeScale(1.3)
  applyPixelRatio()
}

/** "Expedition starten". Must run inside the click handler (audio unlock). */
export function enterExperience(): void {
  const boot = useBootStore.getState()
  if (boot.phase !== 'ready') return
  applyBenchPreset()
  const scene = sceneState()
  scene.bench?.dispose()
  useSceneStore.setState({ bench: null })
  if (boot.startWithSound) void scene.audio?.setEnabled(true)
  const now = performance.now()
  frame.rainCycleStartedAt = now
  // Park the cloud until the descent has closed most of the distance; the
  // loader staged the camera at the destination, so the tiles the reveal
  // needs are already resident.
  frame.entranceFlightPending = effectiveOptions().sseBrakes
    && EXPERIENCE_CONFIG.flight.cloudRevealProgress[useBootStore.getState().benchPreset] > 0
  if (frame.entranceFlightPending) setPointCloudRevealed(false)
  useBootStore.setState({ phase: 'entering', finishAt: now + (APP_PARAMS.reducedMotion ? 20 : 1200) })
  setAimMode(false, false)
  if (APP_PARAMS.storyEnabled && !APP_PARAMS.reducedMotion) scene.rig?.startStory()
  else scene.rig?.flyToOrbit()
}

// ---------------------------------------------------------------- aim mode
let interactionTimer = 0
export function announceInteraction(message: string): void {
  useUiStore.setState({ interactionMessage: '' })
  window.clearTimeout(interactionTimer)
  interactionTimer = window.setTimeout(() => useUiStore.setState({ interactionMessage: message }), 20)
}

export function setAimMode(active: boolean, announce = true): void {
  if (uiState().aimMode === active) return
  useUiStore.setState({ aimMode: active })
  sceneState().keyboard?.setAimActive(active)
  if (!active) {
    useUiStore.setState({ interactionMessage: '', aimHasTarget: false, aimLabel: 'Ziel suchen' })
    sceneState().markers?.setFocusedAction(null)
  }
  if (announce) {
    announceInteraction(active
      ? 'Fokusmodus aktiviert. Bewege die Kamera, bis ein Ziel einrastet. Mit Enter öffnen, mit C oder Escape beenden.'
      : 'Fokusmodus beendet.')
  }
}

export function toggleAimMode(): void {
  if (isBootLoading() || frame.cameraBusy || uiState().videoOpen) return
  setAimMode(!uiState().aimMode)
}

export function dismissAimMode(): boolean {
  if (!uiState().aimMode) return false
  setAimMode(false)
  return true
}

export const scratchVector = new THREE.Vector3()
