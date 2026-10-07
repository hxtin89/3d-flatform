// Bakes the ground-fog noise off the main thread: a 256² bake takes ~0.2 s, which would
// stall the loader benchmark at boot and every slider move in the noise editor.
import { bakeFogNoise, bakeFogNoise3D, type FogNoiseSettings } from './fog-noise'

export type FogNoiseRequest =
  | { id: number; dimension: '2d'; settings: FogNoiseSettings }
  | { id: number; dimension: '3d'; size: number }

self.onmessage = (event: MessageEvent<FogNoiseRequest>) => {
  const request = event.data
  const data = request.dimension === '2d' ? bakeFogNoise(request.settings) : bakeFogNoise3D(request.size)
  ;(self as unknown as Worker).postMessage({ id: request.id, data }, [data.buffer])
}
