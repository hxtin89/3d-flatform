import { useCallback, useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getEcefRoot } from '../../threejs-test/origin'
import type { ResolvedSource } from '../../threejs-test/point-source'
import { createStreamingCloud } from '../../threejs-test/streaming'
import { APP_PARAMS } from '../params'
import { frame } from '../state/frame'
import { isBootLoading } from '../state/boot-store'
import { sceneState, updateDatasetRuntime, useSceneStore } from '../state/scene-store'
import { useUiStore } from '../state/ui-store'
import { applyStreamMemoryBudget } from '../state/actions'
import { useResolutionSync } from '../hooks/useResolutionSync'
import type { WorldDatasetId } from '../world-datasets'
import { applyDatasetHeightOffset, syncDatasetUniforms } from '../state/world-stream-uniforms'

export interface DatasetPointTilesProps {
  id: WorldDatasetId
  onRootError(id: WorldDatasetId, source: ResolvedSource, url: string, error: unknown): void
}

/** Owns exactly one TilesRenderer's mount/dispose lifecycle. */
export function DatasetPointTiles({ id, onRootError }: DatasetPointTilesProps) {
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera
  const source = useSceneStore((state) => state.datasets[id]?.activeSource)
  const heightOffset = useUiStore((state) => state.heightOffset)

  useEffect(() => {
    const runtime = sceneState().datasets[id]
    if (!source || runtime?.status !== 'ready' || !runtime.frame || !runtime.uniforms) return
    syncDatasetUniforms(runtime.uniforms, id)
    const stream = createStreamingCloud({
      tilesetUrl: source.url,
      requestVolumes: source.requestVolumes,
      limits: source.limits,
      camera,
      renderer: gl as any,
      scene: getEcefRoot(),
      uniforms: runtime.uniforms,
      errorTarget: source.ladder[id === sceneState().activeDatasetId ? frame.band : 2] ?? frame.sseAuto,
      debugVolume: APP_PARAMS.showDiagnostics,
      onRootError: (url, error) => onRootError(id, source, url, error),
    })
    updateDatasetRuntime(id, { stream, appliedHighPrecision: null })
    applyDatasetHeightOffset(id)
    stream.group.visible = frame.pointCloudRevealed
    stream.setDensityCeiling(id === sceneState().activeDatasetId && !isBootLoading() ? 2 - frame.band : 0)
    applyStreamMemoryBudget()
    return () => {
      stream.dispose()
      if (sceneState().datasets[id]?.stream === stream) updateDatasetRuntime(id, { stream: null, stats: null })
    }
  }, [source?.key, gl, camera, id, onRootError])

  useEffect(() => { applyDatasetHeightOffset(id) }, [heightOffset, source?.key, id])
  useResolutionSync(useCallback(() => sceneState().datasets[id]?.stream?.tiles ?? null, [id]))
  return null
}
