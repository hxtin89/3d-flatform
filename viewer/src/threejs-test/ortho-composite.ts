// The drone orthophoto, composited into the satellite's own tiles.
//
// Each satellite tile that a drone ortho covers is fetched together with the ortho tiles over
// the same ground; a worker colour-corrects the ortho into the raw satellite's colour and
// blends it in (ortho-compose.worker.ts), and the tile is handed to the library as if it had
// been one satellite image. So the ortho adds no mesh, no draw call, no texture, no shader
// code and no GPU memory: the imagery graph, the colour match, fog, vignette and ground
// patch all see an ordinary 512 px satellite tile. What it does add is download and worker
// time per covered tile, and that is where its gates are (zoom, density, concurrency).
//
// The ortho happens inside `fetchData`, so a covered tile holds one of the basemap's download
// slots for its whole compose, never one of its parse slots. From the moment it asks for a
// compose turn until it is done, it lends that slot back to the queue (createComposeGate), so
// tiles outside the ortho never queue behind it and with nothing composing the queue is what
// it is without the ortho. A failed or undecodable ortho child leaves its part of the tile to
// the satellite; a tile whose children all fail, or whose worker fails or times out, is the
// plain satellite tile; only a satellite failure (a timed-out one included) fails a tile, as
// before, and tile-retry.ts asks for it again. Plans come from the builder's per-zoom
// tile-kind grid (ortho-plan.ts), so no out-of-bounds request is made, and at 'full' no
// child the grid one zoom down marks empty; at the source's top zoom, where there is no
// grid below, an empty child can still cost one ~72 B answer.
import * as THREE from 'three'
import {
  createComposeGate, createPlanner, parseSatelliteZxy, type OrthoDensity, type OrthoMeta, type TilePlan,
} from './ortho-plan'

export interface OrthoCompositeConfig {
  /** Lowest basemap zoom the ortho is composited into. */
  minZoom: number
  fetchTimeoutMs: number
  composeTimeoutMs: number
  /** Ortho composites allowed in flight at once; further covered tiles wait for a turn. */
  maxConcurrentComposes: number
  /** 401/403 responses after which a source is switched off for the session. */
  forbiddenLimit: number
}

export interface OrthoStats {
  ready: boolean
  enabled: boolean
  density: OrthoDensity | 'off'
  composed: number
  fullTiles: number
  edgeTiles: number
  fallbacks: number
  /** Ortho children that failed (network, timeout, 5xx, undecodable); their part of the tile
   *  shows the satellite. */
  childFailures: number
  forbidden: number
  /** Every source answered 401/403 often enough to be switched off for the session. */
  refused: boolean
  outOfBounds: number
  inFlight: number
  waiting: number
  requests: number
  orthoBytes: number
  workerMsP50: number
  workerMsP95: number
}

export interface OrthoComposite {
  /** Register on the basemap's TilesRenderer, after its XYZTilesPlugin. */
  plugin: object
  /** Resolves once the worker has its fields, false if the ortho cannot run here. */
  ready: Promise<boolean>
  setEnabled(on: boolean): void
  setDensity(density: OrthoDensity | 'off'): void
  stats(): OrthoStats
  dispose(): void
}

export interface OrthoCompositeOptions {
  xyz: any
  meta: OrthoMeta
  /** The survey's ENU→ECEF matrix (column-major), the frame the fields are placed in. */
  rootTransform: ArrayLike<number>
  /** Absolute URL of the folder the field PNGs sit in. */
  fieldBaseUrl: string
  /** URL of one ortho tile. */
  orthoTileUrl: (id: string, format: string, z: number, x: number, y: number) => string
  config: OrthoCompositeConfig
  density: OrthoDensity | 'off'
  /** See PlannerOptions.thinUnderPatch. */
  thinUnderPatch: boolean
  debugKinds: boolean
}

type WorkerReply =
  | { type: 'ready' }
  | { type: 'init-failed'; reason: string }
  | { type: 'done'; id: number; bitmap: ImageBitmap; ms: number; undecodable: number }
  | { type: 'need-satellite'; id: number }
  | { type: 'failed'; id: number; reason: string }

const abortError = () => new DOMException('aborted', 'AbortError')

export function createOrthoComposite(options: OrthoCompositeOptions): OrthoComposite {
  const { xyz, meta, config } = options
  let enabled = true
  let density = options.density
  let ready = false
  let disposed = false
  const disabled = new Set<number>()
  const forbiddenBySource = new Map<number, number>()
  const allRefused = () => meta.sources.every((_, index) => disabled.has(index))
  const makePlanner = () => density === 'off' || allRefused() ? null : createPlanner(meta.sources, {
    minZoom: config.minZoom, density, disabled, thinUnderPatch: options.thinUnderPatch,
  })
  let planner = makePlanner()
  /** Zero-length buffers standing in for a composited tile between fetchData and the parse. */
  const composites = new WeakMap<ArrayBuffer, ImageBitmap>()
  const pendingReplies = new Map<number, (reply: WorkerReply) => void>()
  let nextId = 1
  const workerMs: number[] = []
  const counts = {
    composed: 0, fullTiles: 0, edgeTiles: 0, fallbacks: 0, childFailures: 0, forbidden: 0, outOfBounds: 0,
    requests: 0, orthoBytes: 0,
  }
  /** The basemap's download queue, once the plugin is registered. */
  let queue: { maxJobs: number; scheduleJobRun?: () => void } | null = null
  const gate = createComposeGate(config.maxConcurrentComposes, (delta) => {
    if (!queue) return
    queue.maxJobs += delta
    if (delta > 0) queue.scheduleJobRun?.()
  })

  // --- worker
  let worker: Worker | null = null
  const ready$ = new Promise<boolean>((resolve) => {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      console.info('[drone ortho] needs module workers and OffscreenCanvas; the basemap stays satellite only.')
      resolve(false)
      return
    }
    try {
      worker = new Worker(new URL('./ortho-compose.worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      console.warn('[drone ortho] worker failed to start; the basemap stays satellite only.', error)
      resolve(false)
      return
    }
    // Final: a worker that comes up later would start the ortho on a link that has just proved
    // too slow for it, without the reload that attaching does.
    const timer = setTimeout(() => {
      console.warn('[drone ortho] worker did not come up in time; satellite only.')
      worker?.terminate()
      worker = null
      resolve(false)
    }, 15000)
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data
      if (reply.type === 'ready') { clearTimeout(timer); ready = true; resolve(true); return }
      if (reply.type === 'init-failed') {
        clearTimeout(timer)
        console.warn(`[drone ortho] ${reply.reason}; the basemap stays satellite only.`)
        resolve(false)
        return
      }
      const settle = pendingReplies.get(reply.id)
      if (settle) { pendingReplies.delete(reply.id); settle(reply) } else if (reply.type === 'done') reply.bitmap.close()
    }
    worker.onerror = (event) => {
      clearTimeout(timer)
      console.warn('[drone ortho] worker error; new tiles stay satellite only.', event.message)
      ready = false
      resolve(false)
      for (const settle of pendingReplies.values()) settle({ type: 'failed', id: -1, reason: 'worker error' })
      pendingReplies.clear()
    }
    const inverse = new THREE.Matrix4().fromArray(Array.from(options.rootTransform)).invert()
    worker.postMessage({
      type: 'init',
      enuFromEcef: inverse.elements,
      debugKinds: options.debugKinds,
      sources: meta.sources.map((source) => ({
        baseGain: source.baseGain,
        zoomTrim: source.zoomTrim,
        pyramidLevel: source.pyramidLevel ?? {},
        field: {
          ...source.field,
          stops: source.field.encoding.stops, zero: source.field.encoding.zero, scale: source.field.encoding.scale,
          meanCode: source.field.encoding.meanCode, featherMean: source.field.featherMean,
          gainUrl: `${options.fieldBaseUrl}${source.field.gainPng}?v=${source.field.gainHash}`,
          featherUrl: `${options.fieldBaseUrl}${source.field.featherPng}?v=${source.field.featherHash}`,
        },
      })),
    })
  })

  function askWorker(message: any, transfer: Transferable[], signal: AbortSignal): Promise<WorkerReply> {
    const id = nextId++
    message.id = id
    return new Promise<WorkerReply>((resolve) => {
      const timer = setTimeout(() => {
        pendingReplies.delete(id)
        worker?.postMessage({ type: 'cancel', id })
        resolve({ type: 'failed', id, reason: 'timeout' })
      }, config.composeTimeoutMs)
      const onAbort = () => {
        clearTimeout(timer)
        pendingReplies.delete(id)
        worker?.postMessage({ type: 'cancel', id })
        resolve({ type: 'failed', id, reason: 'aborted' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      pendingReplies.set(id, (reply) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(reply)
      })
      worker!.postMessage(message, transfer)
    })
  }

  async function fetchChild(source: number, z: number, x: number, y: number, signal: AbortSignal): Promise<Blob | null> {
    const s = meta.sources[source]
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs)
    counts.requests++
    try {
      // Low priority: on a shared connection the satellite tiles, which every view needs, go first.
      const response = await fetch(options.orthoTileUrl(s.id, s.format, z, x, y),
        { signal: controller.signal, priority: 'low' } as RequestInit)
      if (response.status === 401 || response.status === 403) {
        counts.forbidden++
        const n = (forbiddenBySource.get(source) ?? 0) + 1
        forbiddenBySource.set(source, n)
        if (n === config.forbiddenLimit) {
          disabled.add(source)
          rebuildPlanner()
          console.warn(`[drone ortho] "${s.name}" answers ${response.status} (key not allowed?); switched off for this session.`)
        }
        return null
      }
      if (response.status === 400 || response.status === 404) { counts.outOfBounds++; return null }
      if (!response.ok) { counts.childFailures++; return null }
      const blob = await response.blob()
      counts.orthoBytes += blob.size
      // Inside the bbox but outside the footprint the server sends a 72-80 byte empty image.
      return blob.size < 100 ? null : blob
    } catch {
      if (signal.aborted) throw abortError()
      counts.childFailures++
      return null
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** The satellite tile, as a Blob, or the failed Response. Bounded like the children: inside a
   *  compose turn a stalled satellite would hold the turn, and every covered tile behind it. A
   *  timeout answers 504, which fails the tile, and tile-retry.ts asks for it again. */
  async function satelliteBlob(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Blob | Response> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    init.signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, config.fetchTimeoutMs)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      return response.ok ? await response.blob() : response
    } catch (error) {
      if (timedOut && !init.signal.aborted) return new Response(null, { status: 504, statusText: 'satellite timed out' })
      throw error
    } finally {
      clearTimeout(timer)
      init.signal.removeEventListener('abort', onAbort)
    }
  }

  async function compose(url: string, init: RequestInit & { signal: AbortSignal }, plan: TilePlan): Promise<Response | ArrayBuffer> {
    const { signal } = init
    await gate.turn(signal)
    try {
      if (disposed) return fetch(url, init)
      let sat: Blob | Response | null = null
      const satPromise = plan.needsSatellite ? satelliteBlob(url, init) : null
      // A child abort skips the await below; that rejection is not an unhandled one.
      satPromise?.catch(() => {})
      const children = await Promise.all(plan.children.map(async (child) => ({
        ...child, blob: await fetchChild(child.source, child.z, child.x, child.y, signal),
      })))
      if (satPromise) sat = await satPromise
      if (sat instanceof Response) return sat // the satellite itself failed: fail as before
      if (!children.some((child) => child.blob)) {
        counts.fallbacks++
        return sat ? new Response(sat) : fetch(url, init)
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await askWorker(
          { type: 'compose', z: plan.z, x: plan.x, y: plan.y, sat, children }, [], signal)
        if (signal.aborted) {
          if (reply.type === 'done') reply.bitmap.close()
          throw abortError()
        }
        if (reply.type === 'done') {
          counts.childFailures += reply.undecodable
          workerMs.push(reply.ms)
          if (workerMs.length > 400) workerMs.splice(0, workerMs.length - 400)
          counts.composed++
          if (sat) counts.edgeTiles++
          else counts.fullTiles++
          const token = new ArrayBuffer(0)
          composites.set(token, reply.bitmap)
          // Aborted between here and the parse: the library never asks for the texture.
          signal.addEventListener('abort', () => {
            const bitmap = composites.get(token)
            if (bitmap) { composites.delete(token); bitmap.close() }
          }, { once: true })
          return token
        }
        if (reply.type === 'need-satellite' && !sat) {
          const fetched = await satelliteBlob(url, init)
          if (fetched instanceof Response) return fetched
          sat = fetched
          continue
        }
        break
      }
      counts.fallbacks++
      return sat ? new Response(sat) : fetch(url, init)
    } catch (error) {
      if (signal.aborted) throw error
      counts.fallbacks++
      return fetch(url, init)
    } finally {
      gate.release()
    }
  }

  function rebuildPlanner(): void {
    planner = makePlanner()
  }

  const plugin = {
    name: 'SBB_ORTHO_COMPOSITE',
    init(tiles: any) {
      const source = xyz.imageSource
      const original = source.processBufferToTexture.bind(source)
      source.processBufferToTexture = async (buffer: ArrayBuffer) => {
        const bitmap = buffer instanceof ArrayBuffer ? composites.get(buffer) : undefined
        if (!bitmap) return original(buffer)
        composites.delete(buffer)
        // Exactly what TiledImageSource.processBufferToTexture builds, from our bitmap.
        const texture = new THREE.Texture(bitmap)
        texture.generateMipmaps = false
        texture.colorSpace = THREE.SRGBColorSpace
        texture.needsUpdate = true
        return texture
      }
      queue = tiles.downloadQueue ?? null
    },
    fetchData(url: string, init: RequestInit & { signal: AbortSignal }) {
      if (!enabled || !ready || !planner || disposed) return undefined
      const zxy = parseSatelliteZxy(url)
      if (!zxy) return undefined
      const plan = planner(zxy.z, zxy.x, zxy.y)
      return plan ? compose(url, init, plan) : undefined
    },
  }

  return {
    plugin,
    ready: ready$,
    setEnabled(on) {
      enabled = on
    },
    setDensity(next) {
      if (next === density) return
      density = next
      rebuildPlanner()
    },
    stats() {
      const sorted = [...workerMs].sort((a, b) => a - b)
      const pick = (q: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : 0
      return {
        ready, enabled, density, ...counts, refused: allRefused(), inFlight: gate.inFlight, waiting: gate.waiting,
        workerMsP50: pick(0.5), workerMsP95: pick(0.95),
      }
    },
    dispose() {
      disposed = true
      worker?.terminate()
      worker = null
      for (const settle of pendingReplies.values()) settle({ type: 'failed', id: -1, reason: 'disposed' })
      pendingReplies.clear()
      // Granted after `disposed`, so their tiles load as plain satellite.
      gate.releaseAll()
    },
  }
}
