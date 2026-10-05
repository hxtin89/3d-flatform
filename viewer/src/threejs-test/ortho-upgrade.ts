// The drone ortho as an upgrade of settled satellite tiles.
//
// Every basemap tile loads as plain satellite through the library's own fetch, parse and child
// expansion, exactly as with the ortho off, so the descent to the sharpest zoom never waits for
// the ortho. Once the basemap is idle and a covered tile has stayed on screen as the view's own
// detail for `settleMs`, its ortho is fetched and composited (ortho-composite.ts, the worker) and
// the result is put into the tile's existing texture: `texture.image = composite`, one in-place
// upload, the same GPU texture, bind group, material and shader, no draw call. Off and density
// 'off' put the satellite back from its kept JPEG bytes, without a request.
//
// No three or DOM import at runtime, so node runs it (ortho-upgrade.test.ts): the bitmaps,
// textures, the tile renderer and the engine are passed in and duck-typed.
import {
  createSettlePicker, isSettledTile, parseSatelliteZxy, TILE_LOADED, type OrthoDensity, type TilePlan,
} from './ortho-plan.ts'

/** An ImageBitmap, or a stand-in in the tests. A closed ImageBitmap reads 0 x 0. */
export interface Bitmap { readonly width: number; readonly height: number; close(): void }
/** A THREE.Texture, as far as the swap is concerned. */
export interface UpgradeTexture { image: any; needsUpdate: boolean }

const isOpen = (bitmap: any): bitmap is Bitmap =>
  !!bitmap && typeof bitmap.close === 'function' && bitmap.width > 0 && bitmap.height > 0

export interface SatelliteBytes {
  get(texture: object): ArrayBuffer | undefined
  drop(texture: object): void
  setCapturing(on: boolean): void
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
  /** Lets waiting child requests go out, up to the engine's limit. */
  pump(): void
  readonly requestsWaiting: number
}

export interface UpgraderOptions {
  /** The basemap's TilesRenderer: stats, processNodeQueue, frameCount, errorTarget, visibleTiles, events. */
  tiles: any
  satellite: SatelliteBytes
  engine: UpgradeEngine
  /** The satellite, decoded from its bytes exactly as the library does. */
  decodeSatellite(bytes: ArrayBuffer): Promise<Bitmap>
  /** Uploads a texture now (renderer.initTexture), so the swap's cost lands where it is timed. */
  upload(texture: UpgradeTexture): void
  /** Point tiles arrived so far: a swap never shares a frame with a point tile's first upload. */
  pointArrivals(): number
  /** False until the Start click and while a camera flight runs. */
  upgradesAllowed(): boolean
  settleMs: number
  maxConcurrentComposes: number
  density: OrthoDensity | 'off'
  now?: () => number
}

export interface UpgraderStats {
  density: OrthoDensity | 'off'
  enabled: boolean
  /** Settled covered tiles not yet upgraded at this density, from the last idle tick. */
  pending: number
  /** Upgrades and reverts in flight. */
  inFlight: number
  /** Tiles still to do: dwelling candidates, waiting requests and finished swaps. */
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
}

interface Candidate {
  key: any
  tile: any
  priority: number
  texture: UpgradeTexture
  bytes: ArrayBuffer
  plan: TilePlan
  zxy: { z: number; x: number; y: number }
}

const GIVEN_UP_LIMIT = 4096
const UPLOAD_RING = 200

/** The texture a tile draws, and one the library will close and dispose with it. */
function textureOf(tile: any): UpgradeTexture | null {
  const data = tile?.engineData
  const texture = data?.scene?.material?.map
  return texture && Array.isArray(data.textures) && data.textures.includes(texture) ? texture : null
}

export function createOrthoUpgrader(o: UpgraderOptions): OrthoUpgrader {
  const { tiles, satellite, engine } = o
  const clock = o.now ?? (() => performance.now())
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
  let pending = 0
  let waiting = 0
  const counts = {
    composed: 0, fullTiles: 0, edgeTiles: 0, fallbacks: 0, reverted: 0, revertFailures: 0, dropped: 0,
    sizeMismatch: 0, swapDeferrals: 0, abortedEarly: 0, swaps: 0, lastSwapAt: 0,
  }

  const reverting = () => !enabled || density === 'off'
  const settled = (tile: any) => isSettledTile(tile, tiles.frameCount, tiles.errorTarget)
  const onScreen = (tile: any) => tiles.visibleTiles?.has(tile) === true
    && tile.traversal?.lastFrameVisited === tiles.frameCount
  /** The tile still draws this texture, from this scene, and its image can be replaced. */
  const live = (tile: any, scene: any, texture: UpgradeTexture) => !disposed
    && tile?.internal?.loadingState === TILE_LOADED && tile.engineData?.scene === scene
    && textureOf(tile) === texture && isOpen(texture.image)
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

  function candidates(): Candidate[] {
    const out: Candidate[] = []
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
      if (hasWork(tile)) continue
      out.push({ key: tile, tile, priority: tile.traversal.error, texture, bytes, plan, zxy })
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
    engine.compose(c.plan, c.bytes, job.controller.signal, () => { job.granted++ }).then((out) => {
      const aborted = job.controller.signal.aborted
      if (out.type === 'done') {
        if (aborted) out.bitmap.close()
        else swaps.push({ kind: 'ortho', tile, scene, texture, bitmap: out.bitmap, density: at, edge: out.edge })
        return
      }
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
      if (!entry.composite || hasWork(tile)) continue
      const bytes = satellite.get(entry.texture)
      if (!bytes || textureOf(tile) !== entry.texture) { entries.delete(tile); continue }
      const scene = tile.engineData.scene
      const job: Job = { kind: 'satellite', controller: new AbortController(), granted: 0, children: 0 }
      jobs.set(tile, job)
      o.decodeSatellite(bytes).then((bitmap) => {
        if (job.controller.signal.aborted) { bitmap.close(); return }
        swaps.push({ kind: 'satellite', tile, scene, texture: entry.texture, bitmap, density: null, edge: false })
      }, () => { counts.revertFailures++ }).finally(() => { if (jobs.get(tile) === job) jobs.delete(tile) })
    }
  }

  /**
   * Put one finished bitmap into its tile's texture. Ownership: the texture owns its image (the
   * library closes it when the tile goes), a Swap owns its bitmap until it is installed or
   * closed, and the swap closes the image it replaces. Nobody closes the current image of a live
   * tile: UnloadTilesPlugin re-uploads from it after freeing the GPU copy of a hidden tile.
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
    if (bitmap.width !== current.width || bitmap.height !== current.height) {
      bitmap.close()
      counts.sizeMismatch++
      return
    }
    texture.image = bitmap
    texture.needsUpdate = true
    current.close()
    // On screen: upload now, timed. A hidden tile uploads at its next draw.
    if (onScreen(tile)) {
      const startedAt = clock()
      try { o.upload(texture) } catch { /* the next draw uploads it instead */ }
      uploadMs.push(clock() - startedAt)
      if (uploadMs.length > UPLOAD_RING) uploadMs.shift()
    }
    counts.swaps++
    counts.lastSwapAt = clock()
    if (swap.kind === 'ortho') {
      entries.set(tile, { texture, density: swap.density!, composite: true })
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
    const stats = tiles.stats
    const busy = stats.queued + stats.downloading + stats.parsing > 0 || tiles.processNodeQueue?.running === true
    const points = o.pointArrivals()
    const arrived = basemapArrivals !== seenBasemap || points !== seenPoints
    seenBasemap = basemapArrivals
    seenPoints = points
    // A tile that left the view's detail before all its requests went out: stop it there.
    if (tiles.frameCount !== seenFrame) {
      seenFrame = tiles.frameCount
      for (const [tile, job] of jobs) {
        if (job.kind === 'ortho' && job.granted < job.children && !settled(tile)) {
          job.controller.abort()
          jobs.delete(tile)
          counts.abortedEarly++
        }
      }
    }
    // At most one swap per frame, and never in a frame that uploads an arriving tile.
    if (swaps.length) {
      if (arrived) counts.swapDeferrals++
      else applySwap(takeSwap())
    }
    if (reverting()) {
      picker.clear()
      startReverts()
      waiting = swaps.length
      return
    }
    if (busy || !o.upgradesAllowed() || !engine.ready) {
      picker.clear()
      waiting = engine.requestsWaiting + swaps.length
      return
    }
    const found = candidates()
    const started = picker.pick(now, found, o.maxConcurrentComposes - jobs.size)
    for (const c of started) startUpgrade(c)
    // The only place ortho requests are let out.
    engine.pump()
    waiting = found.length - started.length + engine.requestsWaiting + swaps.length
  }

  function onLoadModel(): void { basemapArrivals++ }

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
      cancelAll()
    },
  }
}
