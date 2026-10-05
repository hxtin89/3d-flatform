// Which drone-ortho tiles a basemap tile needs, when a loaded tile is ready for its ortho, and
// how many ortho requests go out at once — pure logic, no DOM, so it runs under `node --test`
// (ortho-plan.test.ts). The data comes from pipeline/build_colour_field.py `--ortho`, inside the
// colour field's JSON; ortho-upgrade.ts and ortho-composite.ts do the work.

/** 0 none, 1 edge (feathered or partly covered), 2 full, 3 full and under the ground patch. */
export type OrthoKind = 0 | 1 | 2 | 3

export interface OrthoKindLevel {
  /** Top-left tile of the server's tile range at this zoom, and its size in tiles. */
  x0: number
  y0: number
  w: number
  h: number
  /** 2 bits per tile, row-major from the north, 4 tiles per byte from the low bits up. */
  bits: string
  counts?: [number, number, number, number]
}

export interface OrthoFieldPlacement {
  /** ENU metres of the lower-left corner, in the tileset's frame, and the size covered. */
  origin: [number, number]
  size: [number, number]
  texels: [number, number]
  rowOrder: 'north-first'
  encoding: { kind: 'log2-gain-rgb8'; stops: number; zero: number; scale: number; meanCode: [number, number, number] }
  gainPng: string
  gainHash: string
  featherPng: string
  featherHash: string
  featherMean: number
}

export interface OrthoSourceMeta {
  /** MapTiler tileset id. */
  id: string
  name: string
  /** [west, south, east, north] in degrees, the TileJSON bounds. */
  bounds: [number, number, number, number]
  minzoom: number
  maxzoom: number
  format: string
  /** Linear per-channel gain from the ortho's own level to the raw satellite's. */
  baseGain: [number, number, number]
  /** Per XYZ zoom, the raw satellite's colour relative to the builder's reference zoom. */
  zoomTrim: Record<string, [number, number, number]>
  /** Per XYZ zoom, this ortho's own colour relative to the zoom its field was fitted at:
   *  MapTiler Engine's coarser levels are darker in linear light than its fine ones. */
  pyramidLevel?: Record<string, [number, number, number]>
  field: OrthoFieldPlacement
  kinds: Record<string, OrthoKindLevel>
}

export interface OrthoMeta {
  version: 2
  target: 'raw-basemap'
  kindZooms: [number, number]
  sources: OrthoSourceMeta[]
}

export interface ChildRequest {
  source: number
  z: number
  x: number
  y: number
  /** Quadrant of the 512 px composite this child fills; `size` 512 means the whole tile. */
  dx: 0 | 1
  dy: 0 | 1
  size: 256 | 512
}

export interface TilePlan {
  z: number
  x: number
  y: number
  /** False when a source covers the whole tile, so the satellite would not show at all. */
  needsSatellite: boolean
  children: ChildRequest[]
}

export type OrthoDensity = 'half' | 'full'

const SATELLITE_ZXY = /\/maps\/satellite-v4\/(\d+)\/(\d+)\/(\d+)\.jpg(?:\?|$)/

/** z/x/y of a satellite-v4 tile URL, dev proxy or production, or null. */
export function parseSatelliteZxy(url: string): { z: number; x: number; y: number } | null {
  const m = SATELLITE_ZXY.exec(url)
  return m ? { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) } : null
}

/**
 * The tiles the server answers for a TileJSON bbox at zoom z — anything outside comes back
 * as HTTP 400 "Out of bounds". Same floor-of-extent rule the builder uses.
 */
export function serverTileRange(bounds: readonly [number, number, number, number], z: number) {
  const n = 2 ** z
  const tx = (lon: number) => Math.floor((lon + 180) / 360 * n)
  const ty = (lat: number) => {
    const r = lat * Math.PI / 180
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)
  }
  return { x0: tx(bounds[0]), x1: tx(bounds[2]), y0: ty(bounds[3]), y1: ty(bounds[1]) }
}

function base64Bytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Look-up of a source's kind grid; tiles outside the grid are 0. */
export function decodeKinds(levels: Record<string, OrthoKindLevel>): (z: number, x: number, y: number) => OrthoKind {
  const decoded = new Map<number, { level: OrthoKindLevel; bytes: Uint8Array }>()
  for (const [z, level] of Object.entries(levels)) decoded.set(Number(z), { level, bytes: base64Bytes(level.bits) })
  return (z, x, y) => {
    const entry = decoded.get(z)
    if (!entry) return 0
    const { level, bytes } = entry
    const i = x - level.x0
    const j = y - level.y0
    if (i < 0 || j < 0 || i >= level.w || j >= level.h) return 0
    const k = j * level.w + i
    return ((bytes[k >> 2] >> ((k & 3) * 2)) & 3) as OrthoKind
  }
}

export interface PlannerOptions {
  /** Lowest basemap zoom the ortho is composited into. */
  minZoom: number
  /** 'full' fetches the four children one zoom down, so the ortho has the satellite tile's
   *  full 512 px; 'half' fetches the one tile at the same z, drawn up to 512. */
  density: OrthoDensity
  /** Source indices switched off, e.g. after repeated 403s. */
  disabled: ReadonlySet<number>
  /** Kind 3 tiles take one same-z tile, not four children. Only true where the ground patch
   *  lies over the whole survey: with the dome on it covers the view centre only, and a
   *  cached tile is seen from everywhere else too. */
  thinUnderPatch?: boolean
}

/** Plan the ortho children for a basemap tile, or null when no source touches it. */
export function createPlanner(sources: readonly OrthoSourceMeta[], options: PlannerOptions) {
  const kinds = sources.map((source) => decodeKinds(source.kinds))
  const kindZooms = sources.map((source) => new Set(Object.keys(source.kinds).map(Number)))
  return (z: number, x: number, y: number): TilePlan | null => {
    const children: ChildRequest[] = []
    let needsSatellite = true
    sources.forEach((source, index) => {
      if (options.disabled.has(index)) return
      if (z < Math.max(options.minZoom, source.minzoom) || z > source.maxzoom) return
      const kind = kinds[index](z, x, y)
      if (kind === 0) return
      if (kind >= 2) needsSatellite = false
      const thin = kind === 3 && options.thinUnderPatch === true
      const split = options.density === 'full' && !thin && source.maxzoom >= z + 1
      if (!split) {
        children.push({ source: index, z, x, y, dx: 0, dy: 0, size: 512 })
        return
      }
      const range = serverTileRange(source.bounds, z + 1)
      // A child the builder's own grid one zoom down marks empty would come back as a 72 B
      // blank; without a grid at z+1 (the source's top zoom) every in-range child is asked for.
      const childKnown = kindZooms[index].has(z + 1)
      for (const dy of [0, 1] as const) {
        for (const dx of [0, 1] as const) {
          const cx = 2 * x + dx
          const cy = 2 * y + dy
          if (cx < range.x0 || cx > range.x1 || cy < range.y0 || cy > range.y1) continue
          if (childKnown && kinds[index](z + 1, cx, cy) === 0) continue
          children.push({ source: index, z: z + 1, x: cx, y: cy, dx, dy, size: 256 })
        }
      }
    })
    return children.length ? { z, x, y, needsSatellite, children } : null
  }
}

/** 3d-tiles-renderer's LOADED loading state (core/renderer/constants.js). */
export const TILE_LOADED = 4

const abortError = () => new DOMException('aborted', 'AbortError')

/** The parts of a library tile the settle test reads. */
export interface SettleTile {
  internal: { loadingState: number }
  traversal?: { visible: boolean; lastFrameVisited: number; error: number }
  children: { length: number }
}

/**
 * On screen in the current traversal and the view's own detail, so worth its ortho. Left out:
 * a parent standing in while its children load (error above the target), a tile the last
 * traversal did not reach (stale lastFrameVisited), and hidden or off-frustum tiles. A tile at
 * the deepest level has no children and counts whatever its error.
 */
export function isSettledTile(tile: SettleTile, frameCount: number, errorTarget: number): boolean {
  const t = tile.traversal
  return !!t && tile.internal.loadingState === TILE_LOADED && t.visible === true
    && t.lastFrameVisited === frameCount && (t.error <= errorTarget || tile.children.length === 0)
}

/**
 * Picks candidates that have stayed candidates for `dwellMs`: a key missing from one call starts
 * over. Higher priority first, then the longest waiting. A picked key starts over too, so a
 * candidate offered again later dwells again.
 */
export function createSettlePicker<K>(dwellMs: number) {
  const since = new Map<K, number>()
  return {
    get dwelling() { return since.size },
    pick<C extends { key: K; priority: number }>(now: number, candidates: readonly C[], slots: number): C[] {
      const present = new Set<K>()
      for (const c of candidates) {
        present.add(c.key)
        if (!since.has(c.key)) since.set(c.key, now)
      }
      for (const key of since.keys()) if (!present.has(key)) since.delete(key)
      if (slots <= 0) return []
      const due = candidates.filter((c) => now - since.get(c.key)! >= dwellMs)
      due.sort((a, b) => b.priority - a.priority || since.get(a.key)! - since.get(b.key)!)
      const picked = due.slice(0, slots)
      for (const c of picked) since.delete(c.key)
      return picked
    },
    clear() { since.clear() },
  }
}

/**
 * A pull-model limit on requests in flight. `turn` only joins the line; turns are handed out by
 * `pump`, which the caller runs only when it wants requests to go out (an idle basemap), so a
 * request never starts on its own in the middle of a satellite burst. `release` frees a slot and
 * hands out nothing by itself. An abort leaves the line at once.
 */
export function createTurnGate(max: number) {
  let inFlight = 0
  const waiters: Array<{ grant(): void; fail(error: unknown): void }> = []
  return {
    get inFlight() { return inFlight },
    get waiting() { return waiters.length },
    turn(signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.reject(abortError())
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          grant() {
            signal.removeEventListener('abort', onAbort)
            inFlight++
            resolve()
          },
          fail(error: unknown) {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        }
        const onAbort = () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(abortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
      })
    },
    /** Ends a granted turn. */
    release(): void {
      inFlight = Math.max(0, inFlight - 1)
    },
    /** Hands out free turns, first come first served. Returns how many went out. */
    pump(): number {
      let granted = 0
      while (inFlight < max && waiters.length) {
        waiters.shift()!.grant()
        granted++
      }
      return granted
    },
    /** Empties the line, e.g. on dispose: every waiter rejects with an AbortError. */
    rejectAll(): void {
      for (const waiter of waiters.splice(0)) waiter.fail(abortError())
    },
  }
}
