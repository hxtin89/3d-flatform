// Independent APH streamers sharing one ECEF scene. Only the active site
// refines normally; distant sites stay mounted at the coarsest density.
import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { flightSseFloor } from '../../threejs-test/flight-quality'
import { AUTO, ZOOM_BAND_ROWS, type ResolvedSource, type ZoomBand } from '../../threejs-test/point-source'
import { createStreamingBudget } from '../../threejs-test/streaming-budget'
import { PHASE } from '../frame-phases'
import { frame } from '../state/frame'
import { isBootLoading, useBootStore } from '../state/boot-store'
import { sceneState, updateDatasetRuntime, useSceneStore } from '../state/scene-store'
import { uiState, useUiStore } from '../state/ui-store'
import { worldToEnu } from '../state/survey-frames'
import { applyPointSize, effectiveOptions, setPointCloudRevealed } from '../state/actions'
import { perfSseFactor } from '../state/perf-governor'
import type { WorldDatasetId } from '../world-datasets'
import { DatasetPointTiles } from './DatasetPointTiles'
import { navigateToDataset } from './world-navigation'
import { syncDatasetUniforms } from '../state/world-stream-uniforms'

const SWAP_DWELL_MS = 900
const SWAP_COOLDOWN_MS = 2_500
const SWAP_LANDING_MS = 600
let previousFrameAt = 0
let streamingBudget: ReturnType<typeof createStreamingBudget> | null = null
const cameraEnu = { x: 0, y: 0 }
const scratch = new THREE.Vector3()
function onStreamRootError(id: WorldDatasetId, source: ResolvedSource, url: string, error: unknown): void {
  console.warn(`[point-source:${id}] tileset root unavailable`, url, error)
  const runtime = sceneState().datasets[id]
  if (!runtime?.pointSource || source.key !== runtime.activeSource?.key) return
  runtime.pointSource.markFailed(source.packId, source.areaId)
  for (const row of ZOOM_BAND_ROWS) {
    if (runtime.pointSource.assignment(row.band) === source.packId) runtime.pointSource.setAssignment(row.band, AUTO)
  }
  useUiStore.setState((state) => ({ packsVersion: state.packsVersion + 1 }))
  frame.lastSwapAt = -Infinity
  frame.userSwapRequested = true
}

function maybeSwapPointSource(now: number, band: ZoomBand, camera: THREE.Camera): void {
  const scene = sceneState()
  const runtime = scene.datasets[scene.activeDatasetId]
  if (!runtime?.pointSource || !runtime.activeSource) return
  if (isBootLoading() || frame.cameraBusy || now - frame.flightEndedAt < SWAP_LANDING_MS) {
    frame.pendingSourceKey = null
    return
  }
  const enu = worldToEnu(camera.position, scratch)
  cameraEnu.x = enu.x
  cameraEnu.y = enu.y
  const next = runtime.pointSource.resolve(band, runtime.pointSource.areaFor(cameraEnu.x, cameraEnu.y))
  if (next.key === runtime.activeSource.key) { frame.pendingSourceKey = null; return }
  if (next.key !== frame.pendingSourceKey) { frame.pendingSourceKey = next.key; frame.pendingSince = now; return }
  if (!frame.userSwapRequested && now - frame.pendingSince < SWAP_DWELL_MS) return
  if (now - frame.lastSwapAt < SWAP_COOLDOWN_MS) return
  frame.pendingSourceKey = null
  frame.userSwapRequested = false
  updateDatasetRuntime(scene.activeDatasetId, { activeSource: next })
  useSceneStore.setState({ activeSource: next, swapReason: `zoom level ${band}` })
}

export function isGestureActive(): boolean {
  return frame.now < frame.gestureUntil
}

export function PointTiles() {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera
  const datasets = useSceneStore((state) => state.datasets)
  const activeDatasetId = useSceneStore((state) => state.activeDatasetId)
  const ids = Object.keys(datasets) as WorldDatasetId[]

  useEffect(() => {
    navigateToDataset(activeDatasetId, camera)
  }, [activeDatasetId, camera])

  useEffect(() => {
    const streams = Object.values(datasets).flatMap((runtime) => runtime?.stream ? [runtime.stream] : [])
    if (!streams.length) return
    streamingBudget?.dispose()
    streamingBudget = createStreamingBudget(streams.flatMap((stream) => [
      stream.tiles.processNodeQueue, stream.tiles.parseQueue,
    ]) as any)
    previousFrameAt = 0
    return () => {
      streamingBudget?.dispose()
      streamingBudget = null
    }
  }, [datasets])

  useFrame(() => {
    const scene = sceneState()
    const active = scene.datasets[scene.activeDatasetId]
    if (!active?.stream || !active.activeSource) return
    const now = frame.now
    const frameMs = previousFrameAt ? now - previousFrameAt : 16
    previousFrameAt = now
    if (frame.wasFlying && !frame.cameraBusy) frame.flightEndedAt = now
    frame.wasFlying = frame.cameraBusy
    const options = effectiveOptions()
    const wantPrecision = uiState().highPrecision && !isBootLoading()
      && !(options.flightPrecisionDrop && frame.cameraBusy)
    if (frame.entranceFlightPending) {
      const revealAt = EXPERIENCE_CONFIG.flight.cloudRevealProgress[useBootStore.getState().benchPreset]
      if (frame.cinematicFlightProgress >= revealAt || !frame.cameraBusy) {
        frame.entranceFlightPending = false
        setPointCloudRevealed(true)
      }
    }
    if (!frame.pointCloudRevealed) return

    const gesturing = isGestureActive()
    if (frame.wasGesturing && !gesturing) frame.gestureEndedAt = now
    frame.wasGesturing = gesturing
    streamingBudget?.pump(now, gesturing && !isBootLoading(), frameMs)
    const quality = scene.adaptiveQuality.update({
      now,
      fps: frame.fps.fps,
      visiblePoints: frame.lastStreamStats?.points ?? 0,
      cameraGroundRange: frame.cameraCloudRange,
    })
    frame.band = quality.band as ZoomBand
    maybeSwapPointSource(now, frame.band, camera)
    const targetSse = options.sseBrakes
      ? Math.max(quality.sse, isBootLoading()
        ? EXPERIENCE_CONFIG.lod.bootSse
        : flightSseFloor({ flying: frame.cameraBusy, msSinceLanding: now - frame.flightEndedAt, targetSse: quality.sse }))
      : quality.sse
    if (targetSse !== frame.sseAuto && (Math.abs(targetSse - frame.sseAuto) > 0.25 || targetSse === quality.sse)) {
      frame.sseAuto = targetSse
      active.stream.setErrorTarget(targetSse)
    }
    const protectNear = active.activeSource.packId === 'tree:aph' && !isBootLoading()
      && (!options.sseBrakes || targetSse <= quality.sse)
    active.stream.setNearDetail(protectNear ? {
      rangeM: EXPERIENCE_CONFIG.lod.protectedNearRangeM,
      sse: EXPERIENCE_CONFIG.lod.aphDetailSse,
      farFactor: perfSseFactor(),
    } : null)
    applyPointSize()

    for (const [id, runtime] of Object.entries(scene.datasets) as [WorldDatasetId, NonNullable<typeof active>][]) {
      if (!runtime.stream || !runtime.uniforms) continue
      syncDatasetUniforms(runtime.uniforms, id)
      if (runtime.appliedHighPrecision !== wantPrecision) {
        runtime.appliedHighPrecision = wantPrecision
        runtime.stream.setHighPrecision(wantPrecision)
      }
      runtime.stream.group.visible = frame.pointCloudRevealed
      runtime.stream.setDensityCeiling(id === scene.activeDatasetId && !isBootLoading() ? 2 - quality.band : 0)
      runtime.stream.setMaskSphere(
        id === scene.activeDatasetId && frame.maskWorldActive ? frame.maskSphereWorld : null,
        frame.maskWorldRadius,
      )
      runtime.stream.update()
      runtime.stats = runtime.stream.stats()
    }
    frame.lastStreamStats = active.stats
  }, PHASE.STREAM)

  return <>{ids.map((id) => <DatasetPointTiles key={id} id={id} onRootError={onStreamRootError} />)}</>
}
