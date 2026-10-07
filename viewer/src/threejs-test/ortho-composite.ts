// The drone orthophoto, painted into the satellite's own tiles.
//
// A satellite tile loads as plain satellite, through the library's own path, whether the ortho
// covers it or not: the descent to the sharpest zoom is what it is with the ortho off. Once the
// entrance flight is over and a covered tile has settled on screen, the ortho tiles over the
// same ground are fetched, a worker colour-corrects the ortho into the raw
// satellite's colour and blends it in (ortho-compose.worker.ts), and the result replaces the
// tile's image in its own texture (ortho-upgrade.ts). So the ortho adds no mesh, no draw call,
// no texture, no shader code and no GPU memory: the imagery graph, the colour match, fog,
// vignette and ground patch all see an ordinary 512 px satellite tile. What it adds is ortho
// downloads, worker time and one in-place texture upload per upgraded tile, and those are what
// its gates limit: the zoom, the density, the link, settled tiles only, at most
// `maxOrthoRequests` ortho requests in flight (`busyOrthoRequests` while the basemap or the
// point stream loads) and `maxConcurrentComposes` upgrades.
//
// A failed or undecodable ortho child leaves its part of the tile to the satellite; a tile
// whose children all fail, or whose worker fails or times out, stays satellite while it is
// loaded. Nothing here can fail a tile: the satellite request is the library's, as before, and
// tile-retry.ts retries it. Plans come from the builder's per-zoom tile-kind grid
// (ortho-plan.ts), so no out-of-bounds request is made, and at 'full' no child the grid one zoom
// down marks empty; at the source's top zoom, where there is no grid below, an empty child can
// still cost one ~72 B answer.
import * as THREE from 'three'
import { createPlanner, createTurnGate, type OrthoDensity, type OrthoMeta, type TilePlan } from './ortho-plan'
import {
  createOrthoUpgrader, type Bitmap, type ComposeOutcome, type SatelliteBytes, type UpgradeEngine,
  type UpgradeTexture, type UpgraderStats,
} from './ortho-upgrade'
import { orthoTrace } from './ortho-trace'

export interface OrthoCompositeConfig {
  /** Lowest basemap zoom the ortho is composited into. */
  minZoom: number
  /** Per ortho request, from its turn, body included. */
  fetchTimeoutMs: number
  composeTimeoutMs: number
  /** Upgrades in flight at once. */
  maxConcurrentComposes: number
  /** Ortho requests in flight at once. */
  maxOrthoRequests: number
  /** Ortho requests in flight while the basemap or the point stream loads. */
  busyOrthoRequests: number
  /** How long a covered tile stays settled on screen in a moving view before its ortho is
   *  fetched, and how long the view stays still before a composite goes in. */
  settleMs: number
  /** A finished composite goes in after this long even if the view has not stood still. */
  maxSwapHoldMs: number
  /** 401/403 responses after which a source is switched off for the session. */
  forbiddenLimit: number
}

export interface OrthoStats extends UpgraderStats {
  ready: boolean
  /** The worker died after it came up: tiles from now on stay satellite. */
  workerFailed: boolean
  /** Ortho children that failed (network, timeout, 5xx, undecodable); their part of the tile
   *  shows the satellite. */
  childFailures: number
  forbidden: number
  /** Every source answered 401/403 often enough to be switched off for the session. */
  refused: boolean
  outOfBounds: number
  requests: number
  requestsWaiting: number
  /** performance.now() of the first ortho request, 0 before it. */
  firstRequestAt: number
  orthoBytes: number
  workerMsP50: number
  workerMsP95: number
}

export interface OrthoComposite {
  /** Resolves once the worker has its fields, false if the ortho cannot run here. */
  ready: Promise<boolean>
  setEnabled(on: boolean): void
  setDensity(density: OrthoDensity | 'off'): void
  stats(): OrthoStats
  dispose(): void
}

export interface OrthoCompositeOptions {
  /** The basemap's TilesRenderer. */
  tiles: any
  /** Each tile's satellite JPEG, kept since the parse (globe.ts). */
  satellite: SatelliteBytes
  /** Uploads a texture now: renderer.initTexture. */
  upload: (texture: UpgradeTexture) => void
  /** False until the Start click and while a camera flight runs. */
  upgradesAllowed: () => boolean
  /** Point tiles arrived so far (arrival-cost.ts). */
  pointArrivals: () => number
  /** The point stream has tiles queued, downloading or parsing. */
  pointsBusy: () => boolean
  /** performance.now() of the camera's last move (globe.ts). */
  viewMovedAt: () => number
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
  /** Every ortho request skips the browser cache, as on a first visit (?orthocold). */
  bypassCache?: boolean
}

type WorkerReply =
  | { type: 'ready' }
  | { type: 'init-failed'; reason: string }
  | { type: 'done'; id: number; bitmap: ImageBitmap; ms: number; undecodable: number }
  | { type: 'need-satellite'; id: number }
  | { type: 'failed'; id: number; reason: string }

const abortError = () => new DOMException('aborted', 'AbortError')

/** The satellite, decoded from its bytes exactly as TiledImageSource.processBufferToTexture does. */
const decodeSatellite = (bytes: ArrayBuffer): Promise<Bitmap> => createImageBitmap(new Blob([bytes]), {
  premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'flipY',
})

export function createOrthoComposite(options: OrthoCompositeOptions): OrthoComposite {
  const { meta, config } = options
  let enabled = true
  let density = options.density
  let ready = false
  let workerFailed = false
  let disposed = false
  const disabled = new Set<number>()
  const forbiddenBySource = new Map<number, number>()
  const allRefused = () => meta.sources.every((_, index) => disabled.has(index))
  const makePlanner = () => density === 'off' || allRefused() ? null : createPlanner(meta.sources, {
    minZoom: config.minZoom, density, disabled, thinUnderPatch: options.thinUnderPatch,
  })
  let planner = makePlanner()
  const pendingReplies = new Map<number, (reply: WorkerReply) => void>()
  let nextId = 1
  const workerMs: number[] = []
  const counts = { childFailures: 0, forbidden: 0, outOfBounds: 0, requests: 0, orthoBytes: 0, firstRequestAt: 0 }
  const gate = createTurnGate(config.maxOrthoRequests)

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
    // too slow for it.
    const timer = setTimeout(() => {
      console.warn('[drone ortho] worker did not come up in time; satellite only.')
      worker?.terminate()
      worker = null
      resolve(false)
    }, 15000)
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data
      if (reply.type === 'ready') { clearTimeout(timer); ready = true; orthoTrace.mark('workerReady'); resolve(true); return }
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
      if (ready) workerFailed = true
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

  /**
   * One ortho tile: a Blob, 'empty' (out of bounds, or the 72-80 B blank the server sends inside
   * the bbox but outside the footprint) or null (refused or failed). It waits for a turn from the
   * gate, which the upgrader opens wider once the basemap and the point stream are idle.
   */
  async function fetchChild(source: number, z: number, x: number, y: number, signal: AbortSignal, onGrant: () => void): Promise<Blob | 'empty' | null> {
    await gate.turn(signal)
    onGrant()
    const s = meta.sources[source]
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs)
    counts.requests++
    const startedAt = performance.now()
    if (!counts.firstRequestAt) counts.firstRequestAt = startedAt
    orthoTrace.mark('firstRequest', startedAt)
    let status = 0
    let bytes = 0
    try {
      // Low priority: on a shared connection the satellite tiles, which every view needs, go first.
      const response = await fetch(options.orthoTileUrl(s.id, s.format, z, x, y), {
        signal: controller.signal, priority: 'low', ...(options.bypassCache ? { cache: 'no-store' } : {}),
      } as RequestInit)
      status = response.status
      if (response.status === 401 || response.status === 403) {
        counts.forbidden++
        const n = (forbiddenBySource.get(source) ?? 0) + 1
        forbiddenBySource.set(source, n)
        if (n === config.forbiddenLimit) {
          disabled.add(source)
          planner = makePlanner()
          console.warn(`[drone ortho] "${s.name}" answers ${response.status} (key not allowed?); switched off for this session.`)
        }
        return null
      }
      if (response.status === 400 || response.status === 404) { counts.outOfBounds++; return 'empty' }
      if (!response.ok) { counts.childFailures++; return null }
      const blob = await response.blob()
      counts.orthoBytes += blob.size
      bytes = blob.size
      return blob.size < 100 ? 'empty' : blob
    } catch {
      if (signal.aborted) throw abortError()
      counts.childFailures++
      return null
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      gate.release()
      if (!signal.aborted) orthoTrace.child({ ms: performance.now() - startedAt, bytes, status })
    }
  }

  /** The composite for one tile, over the satellite bytes the tile was made from. */
  async function composeTile(plan: TilePlan, satellite: ArrayBuffer, signal: AbortSignal, onGrant: () => void): Promise<ComposeOutcome> {
    let got: Array<{ child: TilePlan['children'][number]; result: Blob | 'empty' | null }>
    try {
      got = await Promise.all(plan.children.map(async (child) =>
        ({ child, result: await fetchChild(child.source, child.z, child.x, child.y, signal, onGrant) })))
    } catch (error) {
      if (signal.aborted) return { type: 'aborted' }
      throw error
    }
    if (signal.aborted) return { type: 'aborted' }
    orthoTrace.tile(`${plan.z}/${plan.x}/${plan.y}`, 'fetched')
    const children = got.map(({ child, result }) => ({ ...child, blob: result instanceof Blob ? result : null }))
    if (!children.some((child) => child.blob)) {
      return got.every((g) => g.result === 'empty') ? { type: 'empty' } : { type: 'failed' }
    }
    // The same bytes the library decoded, so the same pixels as the tile shows.
    const satBlob = () => new Blob([satellite], { type: 'image/jpeg' })
    let sat: Blob | null = plan.needsSatellite ? satBlob() : null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!ready || !worker) return { type: 'failed' }
      const reply = await askWorker({ type: 'compose', z: plan.z, x: plan.x, y: plan.y, sat, children }, [], signal)
      if (signal.aborted) {
        if (reply.type === 'done') reply.bitmap.close()
        return { type: 'aborted' }
      }
      if (reply.type === 'done') {
        counts.childFailures += reply.undecodable
        workerMs.push(reply.ms)
        if (workerMs.length > 400) workerMs.splice(0, workerMs.length - 400)
        return { type: 'done', bitmap: reply.bitmap, edge: sat !== null }
      }
      // Planned as covered but it has gaps: the satellite is at hand, no request needed.
      if (reply.type === 'need-satellite' && !sat) { sat = satBlob(); continue }
      break
    }
    return { type: 'failed' }
  }

  const engine: UpgradeEngine = {
    get ready() { return ready && worker !== null && !disposed },
    plan: (z, x, y) => planner?.(z, x, y) ?? null,
    compose: composeTile,
    pump: (limit) => { gate.pump(limit) },
    get requestsWaiting() { return gate.waiting },
  }

  const upgrader = createOrthoUpgrader({
    tiles: options.tiles,
    satellite: options.satellite,
    engine,
    decodeSatellite,
    upload: options.upload,
    pointArrivals: options.pointArrivals,
    pointsBusy: options.pointsBusy,
    upgradesAllowed: options.upgradesAllowed,
    viewMovedAt: options.viewMovedAt,
    settleMs: config.settleMs,
    maxConcurrentComposes: config.maxConcurrentComposes,
    busyRequests: config.busyOrthoRequests,
    maxSwapHoldMs: config.maxSwapHoldMs,
    density,
    trace: orthoTrace,
  })

  return {
    ready: ready$,
    setEnabled(on) {
      enabled = on
      upgrader.setEnabled(on)
    },
    setDensity(next) {
      if (next === density) return
      density = next
      planner = makePlanner()
      upgrader.setDensity(next)
    },
    stats() {
      const sorted = [...workerMs].sort((a, b) => a - b)
      const pick = (q: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : 0
      return {
        ...upgrader.stats(), ready, workerFailed, ...counts, enabled, density, refused: allRefused(),
        requestsWaiting: gate.waiting, workerMsP50: pick(0.5), workerMsP95: pick(0.95),
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      upgrader.dispose()
      gate.rejectAll()
      worker?.terminate()
      worker = null
      for (const settle of pendingReplies.values()) settle({ type: 'failed', id: -1, reason: 'disposed' })
      pendingReplies.clear()
    },
  }
}
