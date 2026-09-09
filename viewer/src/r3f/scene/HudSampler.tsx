// HUD phase: loader readiness gate and the throttled stats snapshot.
import { useFrame, useThree } from '@react-three/fiber'
import { originStats } from '../../threejs-test/origin'
import { ZOOM_BAND_ROWS } from '../../threejs-test/point-source'
import { PHASE } from '../frame-phases'
import { APP_PARAMS } from '../params'
import { frame } from '../state/frame'
import { setLoadProgress, useBootStore } from '../state/boot-store'
import { sceneState } from '../state/scene-store'
import { uiState, useUiStore, type HudSnapshot } from '../state/ui-store'
import { geo } from '../state/survey-frames'
import { perfDebug } from '../state/perf-governor'

const HUD_INTERVAL_MS = 125
/** The basemap is not required to start: an imagery service failure must not
 * leave the loader spinning forever. Point data ready + this long without a
 * single map tile is enough. */
const MAP_TILE_GRACE_MS = 6_000
let pointsReadyAt = 0
const ZOOM_INTERVAL_MS = 250
let lastHud = -Infinity
let lastZoom = -Infinity

function updateLoaderVisual(): void {
  const boot = useBootStore.getState()
  if (boot.phase === 'entered' || boot.phase === 'failed') return
  const stats = frame.lastStreamStats
  if (stats) {
    setLoadProgress(0.35 + 0.6 * stats.progress, boot.dataReady ? undefined : 'Lade erste Kronendach-Punktwolken …')
  }
  const visibleMapTiles = sceneState().globe?.stats().visible ?? 0
  const pointsReady = Boolean(stats && stats.visible > 0 && stats.points > 0 && stats.progress >= 0.999)
  if (pointsReady && !pointsReadyAt) pointsReadyAt = frame.now
  const mapGraceOver = pointsReadyAt > 0 && frame.now - pointsReadyAt > MAP_TILE_GRACE_MS
  const ready = pointsReady && (visibleMapTiles > 0 || mapGraceOver)
  if (ready && !boot.dataReady) {
    useBootStore.setState({ dataReady: true })
    setLoadProgress(1, visibleMapTiles > 0 ? 'Feldsystem bereit.' : 'Feldsystem bereit · Kartenbilder nicht verfügbar.')
    if (visibleMapTiles === 0) console.warn('[basemap] no imagery tiles — starting while satellite imagery is unavailable; inspect failed requests')
  }
  if (boot.phase === 'entering' && frame.now >= boot.finishAt) {
    useBootStore.setState({ phase: 'entered' })
    useUiStore.setState({ statusLine: 'Adaptive streaming · ready' })
  }
}

export function HudSampler() {
  const camera = useThree((s) => s.camera)

  useFrame(() => {
    updateLoaderVisual()
    const now = frame.now
    if (now - lastHud >= HUD_INTERVAL_MS) {
      lastHud = now
      const stats = frame.lastStreamStats
      const globeStats = sceneState().globe?.stats() ?? { visible: 0, cacheBytes: 0, gpuBytes: 0 }
      const hud: HudSnapshot = {
        density: stats?.density ?? '—',
        sse: frame.sseAuto,
        points: stats?.points ?? 0,
        pointTiles: stats?.visible ?? 0,
        mapTiles: globeStats.visible,
        cacheBytes: (stats?.cacheBytes ?? 0) + globeStats.cacheBytes,
        gpuBytes: (stats?.gpuBytes ?? 0) + globeStats.gpuBytes,
        fps: frame.fps.fps,
        frameMs: frame.fps.frameMs,
        altitude: frame.rangeDebug?.altitude ?? null,
        range: frame.rangeDebug?.range ?? null,
        clearance: geo.navigationClearance,
        missingTiles: stats?.missingTiles ?? 0,
        originDistance: camera.position.length(),
        rebases: originStats().rebases,
        distanceCutoff: frame.distanceCutoff,
        perfScale: perfDebug().scale,
        perfSse: perfDebug().sse,
      }
      useUiStore.setState({ hud, pointSizePx: frame.pointSizePx })
    }
    if (APP_PARAMS.panelEnabled && uiState().panelOpen && now - lastZoom >= ZOOM_INTERVAL_MS) {
      lastZoom = now
      const source = sceneState().activeSource
      const rowDef = ZOOM_BAND_ROWS.find((entry) => entry.band === frame.band)
      useUiStore.setState({
        zoom: {
          band: frame.band,
          bandLabel: rowDef ? rowDef.label.split(' · ')[0] : String(frame.band),
          range: frame.cameraCloudRange,
          sse: frame.sseAuto,
          sourceLabel: source ? `${source.label}${source.areaId ? ` · ${source.areaId}` : ''}` : '—',
          sourcePath: source?.datasetPath ?? '',
        },
      })
    }
  }, PHASE.HUD)

  return null
}
