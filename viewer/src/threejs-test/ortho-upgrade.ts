// The drone ortho as an upgrade of settled satellite tiles.
//
// Every basemap tile loads as plain satellite through the library's own fetch, parse and child
// expansion, exactly as with the ortho off, so the descent to the sharpest zoom never waits for
// the ortho. Once a covered tile is on screen as the view's own detail, and has stayed so for
// `settleMs` or the view has stopped, its ortho is fetched (only a few requests at a time while
// the basemap or the point stream still loads) and composited (ortho-composite.ts, the worker),
// and the result is put into the tile's existing texture: `texture.image = composite`, one in-place
// upload, the same GPU texture, bind group, material and shader, no draw call. Off and density
// 'off' put the satellite back from its kept JPEG bytes, without a request.
//
// No three or DOM import at runtime, so node runs it (ortho-upgrade.test.ts): the bitmaps,
// textures, the tile renderer and the engine are passed in and duck-typed.
import {
  createSettlePicker, isSettledTile, parseSatelliteZxy, TILE_LOADED, type OrthoDensity, type TilePlan,
} from './ortho-plan.ts'
import type { OrthoGate, OrthoTrace } from './ortho-trace.ts'

/** An ImageBitmap, or a stand-in in the tests. A closed ImageBitmap reads 0 x 0. */
export interface Bitmap { readonly width: number; readonly height: number; close(): void }
/** A THREE.Texture, as far as the swap is concerned. globe.ts closes a tile's image once it is
 *  on the GPU and leaves the size behind in `userData.imageSize`, which the swap checks against. */
export interface UpgradeTexture { image: any; needsUpdate: boolean; userData?: { imageSize?: { width: number; height: number } } }

const isOpen = (bitmap: any): bitmap is Bitmap =>
  !!bitmap && typeof bitmap.close === 'function' && bitmap.width > 0 && bitmap.height > 0

export interface SatelliteBytes {
  get(texture: object): ArrayBuffer | undefined
  drop(texture: object): void
  setCapturing(on: boolean): void
  readonly capturing: boolean
}

/**
 * Keep each tile's satellite JPEG with its texture, from the parse on: an upgrade composes from
 * it and a revert decodes it again, so neither asks MapTiler for the satellite a second time.
 * The library only reads the buffer into a Blob (TiledImageSource.processBufferToTexture), so
 * keeping it is safe. Installed when the globe is made, before any tile loads.
 */
export function keepSatelliteBytes(
  source: { processBufferToTexture(buffer: ArrayBuffer): Promise<object> },
  capturing: boolean,
): SatelliteBytes {
  let bytes = new WeakMap<object, ArrayBuffer>()
  let on = capturing
  const original = source.processBufferToTexture.bind(source)
  source.processBufferToTexture = async (buffer: ArrayBuffer) => {
    const texture = await original(buffer)
    if (on && texture && buffer instanceof ArrayBuffer && buffer.byteLength > 0) bytes.set(texture, buffer)
    return texture
  }
  return {
    get(texture) {
      const kept = bytes.get(texture)
      return kept && kept.byteLength > 0 ? kept : undefined
    },
    drop(texture) { bytes.delete(texture) },
    setCapturing(next) {
      if (!next) bytes = new WeakMap()
      on = next
    },
    get capturing() { return on },
  }
}

export type ComposeOutcome =
  /** The composite, 512 px, pre-flipped like the library's own tile bitmaps. */
  | { type: 'done'; bitmap: Bitmap; edge: boolean }
  /** Every child came back blank or out of bounds: nothing to paint at this density, for good. */
  | { type: 'empty' }
  /** Network, 5xx, timeout or worker failure: not again while the tile stays loaded. */
  | { type: 'failed' }
  | { type: 'aborted' }

/** What ortho-composite.ts provides: the plan, the requests and the worker. */
export interface UpgradeEngine {
  readonly ready: boolean
  plan(z: number, x: number, y: number): TilePlan | null
  /** `onGrant` runs as each child request gets its turn and goes out. */
  compose(plan: TilePlan, satellite: ArrayBuffer, signal: AbortSignal, onGrant: () => void): Promise<ComposeOutcome>
  /** Lets waiting child requests go out, up to `limit` in flight or the engine's own limit. */
  pump(limit?: number): void
  readonly requestsWaiting: number
}

export interface UpgraderOptions {
  /** The basemap's TilesRenderer: stats, processNodeQueue, frameCount, errorTarget, visibleTiles, events. */
  tiles: any
  satellite: SatelliteBytes
  engine: UpgradeEngine
  /** The satellite, decoded from its bytes exactly as the library does. */
  decodeSatellite(bytes: ArrayBuffer): Promise<Bitmap>
  /** Uploads a texture now (renderer.initTexture) if three holds a GPU copy of it, so the swap's
   *  cost lands in the paced tick where it is timed; a freed copy is rebuilt at the next draw. */
  upload(texture: UpgradeTexture): void
  /** Point tiles arrived so far: a swap waits out a frame that uploads an arriving point tile. */
  pointArrivals(): number
  /** The point stream has tiles queued, downloading or parsing: ortho requests go out at
   *  `busyRequests` meanwhile. */
  pointsBusy?(): boolean
  /** False until the Start click and while a camera flight runs. */
  upgradesAllowed(): boolean
  /** performance.now() of the camera's last move. Without it, the basemap's last traversal
   *  stands in, which a loading tile or a retry also causes. */
  viewMovedAt?(): number
  /** How long a tile must stay settled in a moving view, and the view stay still before a swap. */
  settleMs: number
  maxConcurrentComposes: number
  /** Ortho requests in flight while the basemap or the point stream loads; the engine's own
   *  limit applies once both are idle. Unset: the engine's limit throughout. */
  busyRequests?: number
  /** A finished composite held this long for a still view goes in at the next frame without an
   *  arrival. Unset: it waits for a still view however long that takes. */
  maxSwapHoldMs?: number
  density: OrthoDensity | 'off'
  now?: () => number
  /** Where the time goes (ortho-trace.ts): the gates of every tick and each tile's steps. */
  trace?: OrthoTrace
}

export interface UpgraderStats {
  density: OrthoDensity | 'off'
  enabled: boolean
  /** Settled covered tiles not yet upgraded at this density, from the last idle tick. */
  pending: number
  /** Upgrades and reverts in flight. */
  inFlight: number
  /** Tiles still to do: dwelling candidates and finished swaps waiting for their frame. */
  waiting: number
  /** Tiles whose texture currently shows a composite. */
  upgraded: number
  composed: number
  fullTiles: number
  edgeTiles: number
  fallbacks: number
  reverted: number
  revertFailures: number
  dropped: number
  sizeMismatch: number
  swapDeferrals: number
  /** Swaps that went in after maxSwapHoldMs without a still view. */
  swapsAfterHoldLimit: number
  abortedEarly: number
  givenUp: number
  swaps: number
  lastSwapAt: number
  uploadMsP50: number
  uploadMsMax: number
}

export interface OrthoUpgrader {
  setEnabled(on: boolean): void
  setDensity(density: OrthoDensity | 'off'): void
  stats(): UpgraderStats
  dispose(): void
}

interface Entry {
  texture: UpgradeTexture
  /** The density last tried on this texture; a tile is not tried again at it while loaded. */
  density: OrthoDensity
  /** texture.image is a composite of ours, so Off has to put the satellite back. */
  composite: boolean
  /** Failed revert decodes; after REVERT_TRIES the tile keeps its composite. */
  revertTries?: number
}

interface Job {
  kind: 'ortho' | 'satellite'
  controller: AbortController
  granted: number
  children: number
}

interface Swap {
  kind: 'ortho' | 'satellite'
  tile: any
  scene: any
  texture: UpgradeTexture
  bitmap: Bitmap
  density: OrthoDensity | null
  edge: boolean
  /** When it was ready, for maxSwapHoldMs. */
  readyAt: number
}

interface Candidate {
  key: any
  tile: any
  priority: number
  /** The view has stood still for URGENT_STILL_MS: a settled tile cannot be a zoom passed on
   *  the way down, so it needs no dwell. */
  urgent: boolean
  texture: UpgradeTexture
  bytes: ArrayBuffer
  plan: TilePlan
  zxy: { z: number; x: number; y: number }
}

const GIVEN_UP_LIMIT = 4096
const UPLOAD_RING = 200
const REVERT_TRIES = 3
/** A view held this long counts as still for an urgent upgrade, which skips the dwell. */
const URGENT_STILL_MS = 300

/** The texture a tile draws, and one the library will close and dispose with it. */
function textureOf(tile: any): UpgradeTexture | null {
  const data = tile?.engineData
  const texture = data?.scene?.material?.map
  return texture && Array.isArray(data.textures) && data.textures.includes(texture) ? texture : null
}

export function createOrthoUpgrader(o: UpgraderOptions): OrthoUpgrader {
  const { tiles, satellite, engine, trace } = o
  const clock = o.now ?? (() => performance.now())
  const keyOf = (zxy: { z: number; x: number; y: number }) => `${zxy.z}/${zxy.x}/${zxy.y}`
  let enabled = true
  let density = o.density
  let disposed = false
  const entries = new Map<any, Entry>()
  const jobs = new Map<any, Job>()
  const swaps: Swap[] = []
  const givenUp = new Set<string>()
  const picker = createSettlePicker<any>(o.settleMs)
  const zxyCache = new WeakMap<object, { z: number; x: number; y: number } | null>()
  const uploadMs: number[] = []
  let basemapArrivals = 0
  let seenBasemap = 0
  let seenPoints = o.pointArrivals()
  let seenFrame = -1
  /** When the basemap last traversed, i.e. when the view last moved or a tile last loaded. */
  let lastTraversalAt = -Infinity
  const viewMovedAt = () => o.viewMovedAt?.() ?? lastTraversalAt
  /** A basemap tile turned visible this traversal: three uploads it at its first draw. */
  let shown = false
  let pending = 0
  let waiting = 0
  const counts = {
    composed: 0, fullTiles: 0, edgeTiles: 0, fallbacks: 0, reverted: 0, revertFailures: 0, dropped: 0,
    sizeMismatch: 0, swapDeferrals: 0, swapsAfterHoldLimit: 0, abortedEarly: 0, swaps: 0, lastSwapAt: 0,
  }

  const reverting = () => !enabled || density === 'off'
  const settled = (tile: any) => isSettledTile(tile, tiles.frameCount, tiles.errorTarget)
  const onScreen = (tile: any) => tiles.visibleTiles?.has(tile) === true
    && tile.traversal?.lastFrameVisited === tiles.frameCount
  /** The tile still draws this texture, from this scene, and it has an image to replace. The
   *  image is usually closed by then (globe.ts closes it once it is on the GPU); the GPU copy
   *  stays, and a closed bitmap is as good a stand-in to swap out as an open one. */
  const live = (tile: any, scene: any, texture: UpgradeTexture) => !disposed
    && tile?.internal?.loadingState === TILE_LOADED && tile.engineData?.scene === scene
    && textureOf(tile) === texture && !!texture.image
  const hasWork = (tile: any) => jobs.has(tile) || swaps.some((swap) => swap.tile === tile)

  function zxyOf(tile: any) {
    if (zxyCache.has(tile)) return zxyCache.get(tile)!
    const zxy = parseSatelliteZxy(tile?.content?.uri ?? '')
    zxyCache.set(tile, zxy)
    return zxy
  }

  function remember(key: string): void {
    if (givenUp.size >= GIVEN_UP_LIMIT) givenUp.delete(givenUp.values().next().value!)
    givenUp.add(key)
  }

  /**
   * Settled covered tiles not yet upgraded at this density. A settled tile is the view's own
   * detail and stays so until the view moves; while it moves, the dwell keeps the zooms a
   * descent passes through from being fetched, and once it has stood still for URGENT_STILL_MS
   * there is nothing left to pass through.
   */
  function candidates(now: number): Candidate[] {
    const out: Candidate[] = []
    const still = now - viewMovedAt() >= URGENT_STILL_MS
    let found = 0
    for (const tile of (tiles.visibleTiles ?? []) as Iterable<any>) {
      if (!settled(tile)) continue
      const zxy = zxyOf(tile)
      const plan = zxy ? engine.plan(zxy.z, zxy.x, zxy.y) : null
      if (!plan || !zxy) continue
      const texture = textureOf(tile)
      if (!texture) continue
      const entry = entries.get(tile)
      if (entry && entry.texture === texture && entry.density === density) continue
      if (givenUp.has(`${density}:${zxy.z}/${zxy.x}/${zxy.y}`)) continue
      const bytes = satellite.get(texture)
      if (!bytes) continue
      found++
      trace?.tile(keyOf(zxy), 'seen', now)
      trace?.mark('firstSeen', now)
      if (hasWork(tile)) continue
      out.push({ key: tile, tile, priority: tile.traversal.error, urgent: still, texture, bytes, plan, zxy })
    }
    pending = found
    return out
  }

  function startUpgrade(c: Candidate): void {
    const { tile, texture } = c
    const scene = tile.engineData.scene
    const at = density as OrthoDensity
    const job: Job = { kind: 'ortho', controller: new AbortController(), granted: 0, children: c.plan.children.length }
    jobs.set(tile, job)
    const key = keyOf(c.zxy)
    trace?.tile(key, 'picked')
    trace?.mark('firstPick')
    engine.compose(c.plan, c.bytes, job.controller.signal, () => {
      job.granted++
      trace?.tile(key, 'granted')
    }).then((out) => {
      const aborted = job.controller.signal.aborted
      if (out.type === 'done') {
        if (aborted) out.bitmap.close()
        else swaps.push({ kind: 'ortho', tile, scene, texture, bitmap: out.bitmap, density: at, edge: out.edge, readyAt: clock() })
        trace?.tile(key, aborted ? 'abandoned' : 'composed')
        return
      }
      trace?.tile(key, 'abandoned')
      if (out.type === 'aborted' || aborted) return
      counts.fallbacks++
      if (out.type === 'empty') remember(`${at}:${c.zxy.z}/${c.zxy.x}/${c.zxy.y}`)
      // Not tried again at this density while loaded; a reload with a new texture may retry.
      if (live(tile, scene, texture)) {
        const prev = entries.get(tile)
        entries.set(tile, { texture, density: at, composite: prev?.texture === texture && prev.composite })
      }
    }, (error) => {
      if (job.controller.signal.aborted) return
      counts.fallbacks++
      console.warn('[drone ortho] upgrade failed; the tile stays as it is.', error)
    }).finally(() => { if (jobs.get(tile) === job) jobs.delete(tile) })
  }

  /** Off: decode the kept satellite again. Local work only, so no worker, request or idle basemap. */
  function startReverts(): void {
    for (const [tile, entry] of entries) {
      if (jobs.size + swaps.length >= o.maxConcurrentComposes) return
      if (!entry.composite || (entry.revertTries ?? 0) >= REVERT_TRIES || hasWork(tile)) continue
      const bytes = satellite.get(entry.texture)
      if (!bytes || textureOf(tile) !== entry.texture) { entries.delete(tile); continue }
      const scene = tile.engineData.scene
      const job: Job = { kind: 'satellite', controller: new AbortController(), granted: 0, children: 0 }
      jobs.set(tile, job)
      o.decodeSatellite(bytes).then((bitmap) => {
        if (job.controller.signal.aborted) { bitmap.close(); return }
        swaps.push({ kind: 'satellite', tile, scene, texture: entry.texture, bitmap, density: null, edge: false, readyAt: clock() })
      }, () => {
        counts.revertFailures++
        entry.revertTries = (entry.revertTries ?? 0) + 1
      }).finally(() => { if (jobs.get(tile) === job) jobs.delete(tile) })
    }
  }

  /**
   * Put one finished bitmap into its tile's texture. Ownership: the texture owns its image (the
   * library closes it when the tile goes), a Swap owns its bitmap until it is installed or
   * closed, and the swap closes the image it replaces. globe.ts closes every basemap image once
   * it is on the GPU (and this one too, after its upload), so the current image is usually
   * closed already; the GPU copy is what the tile draws, and nothing re-uploads from the image.
   */
  function applySwap(swap: Swap): void {
    const { tile, texture, bitmap } = swap
    const current = texture.image
    const wanted = swap.kind === 'ortho' ? !reverting() && swap.density === density : reverting()
    if (!live(tile, swap.scene, texture) || !wanted || !isOpen(bitmap)) {
      bitmap.close()
      counts.dropped++
      return
    }
    // three never resizes a GPU texture it has made: a different size would be cut or garbled.
    // A closed image reads 0 x 0, so the size globe.ts noted before closing it is the reference.
    const size = texture.userData?.imageSize ?? current
    if (bitmap.width !== size.width || bitmap.height !== size.height) {
      bitmap.close()
      counts.sizeMismatch++
      // Not composed again at this density while this texture is loaded.
      if (swap.kind === 'ortho') {
        const prev = entries.get(tile)
        entries.set(tile, { texture, density: swap.density!, composite: prev?.texture === texture && prev.composite })
      }
      return
    }
    texture.image = bitmap
    texture.needsUpdate = true
    if (typeof current?.close === 'function') current.close()
    // Upload here, in the paced tick, hidden tiles too: otherwise a hidden tile would upload at
    // its next draw, in whatever frame that is. upload() skips a texture without a GPU copy.
    const startedAt = clock()
    try { o.upload(texture) } catch { /* the next draw uploads it instead */ }
    uploadMs.push(clock() - startedAt)
    if (uploadMs.length > UPLOAD_RING) uploadMs.shift()
    counts.swaps++
    counts.lastSwapAt = clock()
    if (swap.kind === 'ortho') {
      entries.set(tile, { texture, density: swap.density!, composite: true })
      const zxy = zxyOf(tile)
      if (zxy) trace?.tile(keyOf(zxy), 'swapped')
      trace?.mark('firstSwap')
      counts.composed++
      if (swap.edge) counts.edgeTiles++
      else counts.fullTiles++
    } else {
      entries.delete(tile)
      counts.reverted++
    }
  }

  /** On-screen swaps first. */
  function takeSwap(): Swap {
    const index = swaps.findIndex((swap) => onScreen(swap.tile))
    return swaps.splice(index >= 0 ? index : 0, 1)[0]
  }

  /** Once per tiles.update(), which globe.ts skips while the imagery is off: so is this. */
  function tick(): void {
    if (disposed) return
    const now = clock()
    const gates: OrthoGate[] = []
    try {
      step(now, gates)
    } finally {
      trace?.gates(gates, now)
    }
  }

  function step(now: number, gates: OrthoGate[]): void {
    const stats = tiles.stats
    const busy = stats.queued + stats.downloading + stats.parsing > 0 || tiles.processNodeQueue?.running === true
    const points = o.pointArrivals()
    const arrived = basemapArrivals !== seenBasemap || points !== seenPoints || shown
    seenBasemap = basemapArrivals
    seenPoints = points
    shown = false
    // A tile that left the view's detail before all its requests went out: stop it there.
    if (tiles.frameCount !== seenFrame) {
      seenFrame = tiles.frameCount
      lastTraversalAt = now
      for (const [tile, job] of jobs) {
        if (job.kind === 'ortho' && job.granted < job.children && !settled(tile)) {
          job.controller.abort()
          jobs.delete(tile)
          counts.abortedEarly++
        }
      }
    }
    // At most one swap per frame, never in a frame that uploads an arriving or newly shown
    // tile, and, for upgrades, only in a view held still for settleMs outside a flight: point
    // tiles the moving dome reveals upload without an arrival, so a moving view is no place for a
    // swap. Still means the camera's own stillness: the basemap's traversals also come from
    // tiles loading and from failed tiles being retried, and those once held finished composites
    // for 55 s in a view that did not move. And a composite held for maxSwapHoldMs goes in at
    // the next frame without an arrival anyway: the swap is one ~1 ms upload. A revert (Off)
    // only waits for arrivals.
    const allowed = o.upgradesAllowed()
    if (swaps.length) {
      const still = now - viewMovedAt() >= o.settleMs
      const overdue = !still && swaps.some((swap) => now - swap.readyAt >= (o.maxSwapHoldMs ?? Infinity))
      const hold = arrived || (!reverting() && (!allowed || (!still && !overdue)))
      if (hold) {
        counts.swapDeferrals++
        gates.push(arrived ? 'swapHeldByArrival' : 'swapHeldByMotion')
      } else {
        if (overdue && !reverting()) counts.swapsAfterHoldLimit++
        applySwap(takeSwap())
      }
    }
    if (reverting()) {
      picker.clear()
      startReverts()
      waiting = swaps.length
      return
    }
    if (!allowed) gates.push('notAllowed')
    else trace?.mark('allowed', now)
    if (busy) gates.push('basemapBusy')
    else if (allowed) trace?.mark('basemapIdleAfterLanding', now)
    if (!engine.ready) gates.push('workerStarting')
    if (jobs.size) gates.push('working')
    if (!allowed || !engine.ready) {
      picker.clear()
      waiting = swaps.length
      return
    }
    const found = candidates(now)
    // Finished composites waiting for their frame hold their slot too.
    const started = picker.pick(now, found, o.maxConcurrentComposes - jobs.size - swaps.length)
    for (const c of started) startUpgrade(c)
    // The only place ortho requests are let out. While the basemap or the point stream loads,
    // only busyRequests go out, so the ortho's downloads overlap the streams' instead of
    // queuing behind them, without taking their connections; the rest go out once both are idle.
    const streaming = busy || o.pointsBusy?.() === true
    engine.pump(streaming ? o.busyRequests : undefined)
    if (streaming && engine.requestsWaiting) gates.push('requestsCapped')
    if (!jobs.size && !swaps.length && found.length) gates.push('dwelling')
    waiting = found.length - started.length + swaps.length
    if (!found.length && !jobs.size && !swaps.length && counts.composed) trace?.mark('landingComplete', now)
  }

  function onLoadModel(): void { basemapArrivals++ }
  function onVisibility({ visible }: { visible: boolean }): void { if (visible) shown = true }

  /** Fires before the library tears the tile down. */
  function onDisposeModel({ tile }: { tile: any }): void {
    jobs.get(tile)?.controller.abort()
    jobs.delete(tile)
    entries.delete(tile)
    for (let i = swaps.length - 1; i >= 0; i--) {
      if (swaps[i].tile !== tile) continue
      swaps[i].bitmap.close()
      swaps.splice(i, 1)
      counts.dropped++
    }
  }

  function cancelAll(): void {
    for (const job of jobs.values()) job.controller.abort()
    jobs.clear()
    for (const swap of swaps.splice(0)) {
      swap.bitmap.close()
      counts.dropped++
    }
    picker.clear()
  }

  tiles.addEventListener('update-after', tick)
  tiles.addEventListener('load-model', onLoadModel)
  tiles.addEventListener('dispose-model', onDisposeModel)
  tiles.addEventListener('tile-visibility-change', onVisibility)

  return {
    setEnabled(on) {
      if (on === enabled || disposed) return
      enabled = on
      cancelAll()
    },
    setDensity(next) {
      if (next === density || disposed) return
      density = next
      cancelAll()
    },
    stats() {
      const sorted = [...uploadMs].sort((a, b) => a - b)
      let upgraded = 0
      for (const entry of entries.values()) if (entry.composite) upgraded++
      return {
        density, enabled, pending, inFlight: jobs.size, waiting, upgraded, ...counts,
        givenUp: givenUp.size,
        uploadMsP50: sorted.length ? Math.round(sorted[sorted.length >> 1] * 100) / 100 : 0,
        uploadMsMax: sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0,
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      tiles.removeEventListener('update-after', tick)
      tiles.removeEventListener('load-model', onLoadModel)
      tiles.removeEventListener('dispose-model', onDisposeModel)
      tiles.removeEventListener('tile-visibility-change', onVisibility)
      cancelAll()
    },
  }
}
