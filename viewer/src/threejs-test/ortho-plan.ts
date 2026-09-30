// Which drone-ortho tiles a basemap tile needs — pure data, no DOM, so it runs under
// `node --test` (ortho-plan.test.ts). The data comes from pipeline/build_colour_field.py
// `--ortho`, inside the colour field's JSON; ortho-composite.ts does the fetching.

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
}

/** Plan the ortho children for a basemap tile, or null when no source touches it. */
export function createPlanner(sources: readonly OrthoSourceMeta[], options: PlannerOptions) {
  const kinds = sources.map((source) => decodeKinds(source.kinds))
  return (z: number, x: number, y: number): TilePlan | null => {
    const children: ChildRequest[] = []
    let needsSatellite = true
    sources.forEach((source, index) => {
      if (options.disabled.has(index)) return
      if (z < Math.max(options.minZoom, source.minzoom) || z > source.maxzoom) return
      const kind = kinds[index](z, x, y)
      if (kind === 0) return
      if (kind >= 2) needsSatellite = false
      // Under the ground patch the ortho is covered anyway: one tile, not four.
      const split = options.density === 'full' && kind !== 3 && source.maxzoom >= z + 1
      if (!split) {
        children.push({ source: index, z, x, y, dx: 0, dy: 0, size: 512 })
        return
      }
      const range = serverTileRange(source.bounds, z + 1)
      for (const dy of [0, 1] as const) {
        for (const dx of [0, 1] as const) {
          const cx = 2 * x + dx
          const cy = 2 * y + dy
          if (cx < range.x0 || cx > range.x1 || cy < range.y0 || cy > range.y1) continue
          children.push({ source: index, z: z + 1, x: cx, y: cy, dx, dy, size: 256 })
        }
      }
    })
    return children.length ? { z, x, y, needsSatellite, children } : null
  }
}
