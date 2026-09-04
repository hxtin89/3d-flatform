// Streamed point cloud (streaming.ts) as a component: rebuilt whenever the
// active density pack changes, updated in the STREAM phase with the adaptive
// quality controller, SSE policy, density ceiling and mask sphere. Port of
// rebuildStream / updateStreaming / maybeSwapPointSource in main.ts.
//
// Streaming policy change vs. the old app: a drag no longer pins the error
// target to lod.flightSse (that deselected fine tiles instantly and refilled
// them a second later — the visible "coarsen on every drag"). The SSE floor
// applies while springs move the camera; during gestures only the parse and
// node queues are throttled, so tile uploads stay bounded without changing
// what is drawn: the tiles already resident keep rendering at full density,
// only parse + GPU upload of new ones wait for the gesture to end.
import { useEffect, useCallback } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { flightSseFloor } from '../../threejs-test/flight-quality'
import { getEcefRoot } from '../../threejs-test/origin'
import { AUTO, ZOOM_BAND_ROWS, type ResolvedSource, type ZoomBand } from '../../threejs-test/point-source'
import { createStreamingCloud } from '../../threejs-test/streaming'
import { APP_PARAMS } from '../params'
import { PHASE } from '../frame-phases'
import { frame } from '../state/frame'
import { isBootLoading } from '../state/boot-store'
import { sceneState, useSceneStore } from '../state/scene-store'
import { uiState, useUiStore } from '../state/ui-store'
import { geo, worldToEnu } from '../state/survey-frames'
import { applyPointSize, applyStreamMemoryBudget, effectiveOptions, setPointCloudRevealed } from '../state/actions'
import { useBootStore } from '../state/boot-store'
import { useResolutionSync } from '../hooks/useResolutionSync'

/** How long a new zoom level has to hold before its pack is fetched. */
const SWAP_DWELL_MS = 900
/** Floor between two rebuilds, whatever the camera does. */
const SWAP_COOLDOWN_MS = 2_500
/** Settle time after a camera move before a swap may start. */
const SWAP_LANDING_MS = 600
/** Parse/process concurrency the streamer was built with (streaming.ts limits). */
let idleParseJobs = 1
let idleProcessJobs = 1
let queuesPaused = false

const cameraEnu = { x: 0, y: 0 }
const scratch = new THREE.Vector3()

function applyHeightOffset(): void {
  const stream = sceneState().stream
  if (!stream) return
  stream.group.position.copy(geo.enuUp).multiplyScalar(uiState().heightOffset ? geo.zOffset : 0)
}

function onStreamRootError(source: ResolvedSource, url: string, error: unknown): void {
  console.warn('[point-source] tileset root unavailable', url, error)
  const { pointSource, activeSource } = sceneState()
  if (!pointSource || source.key !== activeSource?.key) return
  pointSource.markFailed(source.packId, source.areaId)
  for (const rowDef of ZOOM_BAND_ROWS) {
    if (pointSource.assignment(rowDef.band) === source.packId) pointSource.setAssignment(rowDef.band, AUTO)
  }
  useUiStore.setState((s) => ({ packsVersion: s.packsVersion + 1 }))
  frame.lastSwapAt = -Infinity
  frame.userSwapRequested = true
}

function maybeSwapPointSource(now: number, band: ZoomBand, camera: THREE.Camera): void {
  const { pointSource, activeSource } = sceneState()
  if (!pointSource || !activeSource) return
  if (isBootLoading() || frame.cameraBusy || now - frame.flightEndedAt < SWAP_LANDING_MS) {
    frame.pendingSourceKey = null
    return
  }
  const enu = worldToEnu(camera.position, scratch)
  cameraEnu.x = enu.x
  cameraEnu.y = enu.y
  const areaId = geo.ready ? pointSource.areaFor(cameraEnu.x, cameraEnu.y) : null
  const next = pointSource.resolve(band, areaId)
  if (next.key === activeSource.key) { frame.pendingSourceKey = null; return }
  if (next.key !== frame.pendingSourceKey) { frame.pendingSourceKey = next.key; frame.pendingSince = now; return }
  if (!frame.userSwapRequested && now - frame.pendingSince < SWAP_DWELL_MS) return
  if (now - frame.lastSwapAt < SWAP_COOLDOWN_MS) return
  frame.pendingSourceKey = null
  frame.userSwapRequested = false
  useSceneStore.setState({ activeSource: next, swapReason: `zoom level ${band}` })
}


export function isGestureActive(): boolean {
  return frame.now < frame.gestureUntil
}

export function PointTiles() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const source = useSceneStore((s) => s.activeSource)
  const heightOffset = useUiStore((s) => s.heightOffset)

  useEffect(() => {
    if (!source || !geo.ready) return
    const scene = sceneState()
    const reason = scene.swapReason
    // Ladder first: the seed error target must already belong to the new tree.
    scene.adaptiveQuality.setLadder(source.ladder)
    frame.sseAuto = source.ladder[frame.band] ?? frame.sseAuto
    frame.lastStreamStats = null
    const stream = createStreamingCloud({
      tilesetUrl: source.url,
      requestVolumes: source.requestVolumes,
      limits: source.limits,
      camera,
      renderer: gl as any,
      scene: getEcefRoot(),
      uniforms: frame.uniforms,
      errorTarget: frame.sseAuto,
      debugVolume: APP_PARAMS.showDiagnostics,
      onRootError: (url, error) => onStreamRootError(source, url, error),
    })
    idleParseJobs = stream.tiles.parseQueue.maxJobs
    idleProcessJobs = stream.tiles.processNodeQueue.maxJobs
    queuesPaused = false
    useSceneStore.setState({ stream })
    applyHeightOffset()
    stream.group.visible = frame.pointCloudRevealed
    stream.setDensityCeiling(isBootLoading() ? 0 : 2 - frame.band)
    applyStreamMemoryBudget()
    // A new material set means the precision context has to be applied again.
    frame.appliedHighPrecision = null
    stream.setMaskSphere(frame.maskWorldActive ? frame.maskSphereWorld : null, frame.maskWorldRadius)
    frame.lastSwapAt = performance.now()
    if (reason !== 'boot') scene.donation?.resetGroundLock()
    console.info(`[point-source] ${reason} → ${source.label} (${source.datasetPath})`)
    return () => {
      stream.dispose()
      useSceneStore.setState({ stream: null })
    }
  }, [source?.key, gl, camera])

  useEffect(() => { applyHeightOffset() }, [heightOffset, source?.key])

  useResolutionSync(useCallback(() => sceneState().stream?.tiles ?? null, []))

  useFrame(() => {
    const stream = sceneState().stream
    if (!stream) return
    const now = frame.now
    // Precision: high once the loader is gone; optionally dropped during
    // spring flights (rebuilds every tile material, off by default).
    if (frame.wasFlying && !frame.cameraBusy) frame.flightEndedAt = now
    frame.wasFlying = frame.cameraBusy
    const options = effectiveOptions()
    const wantPrecision = uiState().highPrecision && !isBootLoading()
      && !(options.flightPrecisionDrop && frame.cameraBusy)
    if (wantPrecision !== frame.appliedHighPrecision) {
      frame.appliedHighPrecision = wantPrecision
      stream.setHighPrecision(wantPrecision)
    }

    // Entrance reveal: the cloud joins once the descent passed the preset's
    // reveal point; !cameraBusy is the backstop for a skipped descent.
    if (frame.entranceFlightPending) {
      const revealAt = EXPERIENCE_CONFIG.flight.cloudRevealProgress[useBootStore.getState().benchPreset]
      if (frame.cinematicFlightProgress >= revealAt || !frame.cameraBusy) {
        frame.entranceFlightPending = false
        setPointCloudRevealed(true)
      }
    }
    // Parked during the entrance: no traversal, no fetches, no unloading, so
    // the tiles the loader staged for the destination survive until the reveal.
    if (!frame.pointCloudRevealed) return

    const gesturing = isGestureActive()
    if (frame.wasGesturing && !gesturing) frame.gestureEndedAt = now
    frame.wasGesturing = gesturing
    if (gesturing !== queuesPaused) {
      queuesPaused = gesturing
      const parseQueue: any = stream.tiles.parseQueue
      const processQueue: any = stream.tiles.processNodeQueue
      parseQueue.maxJobs = gesturing ? 0 : idleParseJobs
      processQueue.maxJobs = gesturing ? 0 : idleProcessJobs
      if (!gesturing) {
        // Raising maxJobs does not wake the queue on its own.
        parseQueue.tryRunJobs?.()
        processQueue.tryRunJobs?.()
      }
    }

    const scene = sceneState()
    const quality = scene.adaptiveQuality.update({
      now,
      fps: frame.fps.fps,
      visiblePoints: frame.lastStreamStats?.points ?? 0,
      cameraGroundRange: frame.cameraCloudRange,
    })
    frame.band = quality.band as ZoomBand
    maybeSwapPointSource(now, frame.band, camera)

    const targetSse = options.sseBrakes
      ? Math.max(
        quality.sse,
        isBootLoading()
          ? EXPERIENCE_CONFIG.lod.bootSse
          : flightSseFloor({
            flying: frame.cameraBusy,
            msSinceLanding: now - frame.flightEndedAt,
            targetSse: quality.sse,
          }),
      )
      : quality.sse
    if (Math.abs(targetSse - frame.sseAuto) > 0.25) {
      frame.sseAuto = targetSse
      stream.setErrorTarget(targetSse)
    }
    stream.setDensityCeiling(isBootLoading() ? 0 : 2 - quality.band)
    applyPointSize()
    stream.setMaskSphere(frame.maskWorldActive ? frame.maskSphereWorld : null, frame.maskWorldRadius)
    stream.update()
    frame.lastStreamStats = stream.stats()
  }, PHASE.STREAM)

  return null
}
