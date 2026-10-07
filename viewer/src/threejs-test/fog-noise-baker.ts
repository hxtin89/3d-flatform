// Main-thread side of the noise bake: one worker, latest request wins. Per dimension at most
// one bake is in flight and at most one waits; a newer request replaces the waiting one, so
// dragging a slider in the noise editor never queues up stale bakes (the worker cannot
// abandon a bake it has started). Without Worker support it bakes inline, and so it does from
// the first error on: a worker that fails to load or throws would otherwise leave every bake
// pending.
// Extension-qualified imports, because fog-noise-baker.test.ts loads this module under
// node --test, which does not resolve extensionless specifiers.
import { bakeFogNoise, bakeFogNoise3D, type FogNoiseSettings } from './fog-noise.ts'
import type { FogNoiseRequest } from './fog-noise.worker.ts'

export interface FogNoiseBaker {
  /** Resolves with the RGBA8 texels, or null when a newer 2D request replaced this one. */
  bake2d(settings: FogNoiseSettings): Promise<Uint8Array | null>
  /** Resolves with `size`³ R8 texels, or null when superseded. */
  bake3d(size: number): Promise<Uint8Array | null>
  dispose(): void
}

type Dimension = FogNoiseRequest['dimension']
interface Job { request: FogNoiseRequest; inline: () => Uint8Array; resolve: (data: Uint8Array | null) => void }

/** The bake worker. Written out as `new Worker(new URL(…, import.meta.url))` so Vite bundles it. */
const startBakeWorker = () => new Worker(new URL('./fog-noise.worker.ts', import.meta.url), { type: 'module' })

/** `createWorker` is for the tests, which hand in a fake; a throw means no worker, as without
 *  Worker support. */
export function createFogNoiseBaker(createWorker: () => Worker = startBakeWorker): FogNoiseBaker {
  let worker: Worker | null = null
  try {
    worker = createWorker()
  } catch {
    worker = null
  }
  let nextId = 1
  const running: Record<Dimension, Job | null> = { '2d': null, '3d': null }
  const waiting: Record<Dimension, Job | null> = { '2d': null, '3d': null }
  const start = (job: Job) => {
    running[job.request.dimension] = job
    worker!.postMessage(job.request)
  }
  worker?.addEventListener('message', (event: MessageEvent<{ id: number; data: Uint8Array }>) => {
    for (const dimension of ['2d', '3d'] as const) {
      const job = running[dimension]
      if (job?.request.id !== event.data.id) continue
      running[dimension] = null
      const next = waiting[dimension]
      waiting[dimension] = null
      // A waiting request is newer, so this result is already stale.
      job.resolve(next ? null : event.data.data)
      if (next) start(next)
    }
  })
  const fail = () => {
    worker?.terminate()
    worker = null
    for (const dimension of ['2d', '3d'] as const) {
      const job = running[dimension]
      const next = waiting[dimension]
      running[dimension] = null
      waiting[dimension] = null
      if (job && next) job.resolve(null)
      const latest = next ?? job
      if (latest) latest.resolve(latest.inline())
    }
  }
  worker?.addEventListener('error', fail)
  worker?.addEventListener('messageerror', fail)
  const run = (request: FogNoiseRequest, inline: () => Uint8Array): Promise<Uint8Array | null> => {
    if (!worker) return Promise.resolve(inline())
    return new Promise((resolve) => {
      const job = { request, inline, resolve }
      const dimension = request.dimension
      if (!running[dimension]) { start(job); return }
      waiting[dimension]?.resolve(null)
      waiting[dimension] = job
    })
  }
  return {
    bake2d(settings) {
      // A copy keeps the caller free to mutate its settings object meanwhile.
      const copy = JSON.parse(JSON.stringify(settings)) as FogNoiseSettings
      return run({ id: nextId++, dimension: '2d', settings: copy }, () => bakeFogNoise(copy))
    },
    bake3d(size) {
      return run({ id: nextId++, dimension: '3d', size }, () => bakeFogNoise3D(size))
    },
    dispose() {
      worker?.terminate()
      worker = null
      for (const dimension of ['2d', '3d'] as const) {
        running[dimension]?.resolve(null); waiting[dimension]?.resolve(null)
        running[dimension] = null; waiting[dimension] = null
      }
    },
  }
}
