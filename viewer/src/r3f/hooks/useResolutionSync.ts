import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { TilesRenderer } from '3d-tiles-renderer'

/** SSE is measured in backbuffer pixels: re-read the renderer size whenever
 * R3F resized the canvas or changed the pixel ratio. Port of the resize
 * handler in main.ts. */
export function useResolutionSync(getTiles: () => TilesRenderer | null): void {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    getTiles()?.setResolutionFromRenderer(camera, gl as any)
  }, [size.width, size.height, dpr, camera, gl, getTiles])
}
