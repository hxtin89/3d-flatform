// Bakes the sky clouds' noise off the main thread: the 96³ shape volume takes about a second.
import { bakeCloudNoise, type CloudNoiseRequest } from './sky-cloud-noise'

self.onmessage = (event: MessageEvent<CloudNoiseRequest>) => {
  const data = bakeCloudNoise(event.data)
  ;(self as unknown as Worker).postMessage({ id: event.data.id, data }, [data.buffer])
}
