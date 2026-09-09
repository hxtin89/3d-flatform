import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { Vector2 } from 'three'
import type { TilesRenderer } from '3d-tiles-renderer'

/** Point LOD retains its CSS-pixel calibration. Imagery uses actual rendered
 * pixels so a Retina canvas does not stop at a blurry lower zoom level. */
export function useResolutionSync(getTiles: () => TilesRenderer | null, drawingBuffer = false): void {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    const tiles = getTiles()
    if (drawingBuffer) {
      const resolution = gl.getDrawingBufferSize(new Vector2())
      tiles?.setResolution(camera, resolution.x, resolution.y)
    } else tiles?.setResolutionFromRenderer(camera, gl as any)
  }, [size.width, size.height, dpr, camera, gl, getTiles, drawingBuffer])
}
