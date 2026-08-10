// Donation shape — renderer-agnostic geometry for the protected-area outline.
//
// The published parcel boundary is the outline of merged 1 m² survey cells: in
// the test file every one of the 52 segments is exactly 1.000 m long and axis
// aligned, so the ring is the rim of 124 unit cells. Two things follow, and they
// drive this whole module:
//
//   exact    the staircase IS the legal boundary, and the 1 m² lattice can be
//            reconstructed from the ring alone — no cell list is transmitted.
//   organic  rounding 1 m corners can never look organic: a per-corner fillet is
//            capped at half the shortest adjacent edge, i.e. 0.5 m, and the
//            staircase survives it. Instead the ring is rasterised into a signed
//            distance field, opened and closed with a disc of radius r, and the
//            contour re-extracted with marching squares. That removes the
//            digital character outright and has exactly one parameter.
//
// `organic` is therefore a stylised representation. `exact` is the authoritative
// boundary — never quote areas or borders off the organic ring.
//
// Nothing here imports three or cesium: the lon/lat -> local metre conversion is
// injected by the caller so both viewers land on identical ENU numbers. Keep
// this file byte-identical between src/threejs-test/ and src/cesium-app/.

export type DonationShapeStyle = 'column' | 'xray' | 'canopy' | 'wall'
export type DonationShapeForm = 'exact' | 'organic'

/** lon/lat in degrees -> local metric plane (ENU x/y). Height is never used. */
export type LonLatToLocal = (lon: number, lat: number, out: [number, number]) => [number, number]

export interface DonationShapePolygon {
  outer: Array<readonly [number, number]>
  holes: Array<Array<readonly [number, number]>>
}

export interface DonationShapeSource {
  group: string | null
  properties: Record<string, unknown>
  polygons: DonationShapePolygon[]
}

/** Triangulated fill, xy pairs relative to the shape centroid. */
export interface ShapeFill {
  positions: Float32Array
  indices: Uint32Array
}

/**
 * A flat ribbon standing in for a thick line — WebGPU pins line width to one
 * pixel, so every outline in this feature is real geometry.
 *
 * The two sides are NOT baked into the positions: both vertices of a rib sit on
 * the centre line and carry a unit `offset` across it, which the vertex stage
 * scales by a width uniform. That is what lets the width be locked to screen
 * pixels — a fixed world width of 3.5 cm for the 1 m² grid is a fifth of a pixel
 * at any distance the navigation floor allows, i.e. invisible.
 *   offset  unit normal across the ribbon, times ±1 for the two sides
 *   arcU    0..1 along the ribbon, for sweeps and light runs
 *   edgeD   -1..1 across it, for a soft glow falloff
 */
export interface ShapeRibbon {
  positions: Float32Array
  offsets: Float32Array
  indices: Uint32Array
  arcU: Float32Array
  edgeD: Float32Array
}

export interface DonationShapeGeometry {
  /** Closed rings, flat xy, first vertex not repeated, centroid-relative. */
  outlineExact: Float32Array[]
  outlineOrganic: Float32Array[]
  /** Interior 1 m² cell edges only (the parcel rim is the outline). x0,y0,x1,y1. */
  gridSegments: Float32Array
  fillExact: ShapeFill
  fillOrganic: ShapeFill
  /** Square metres in the local metric plane. */
  areaM2: number
  perimeterM: number
  /** Area-weighted centroid, absolute local metres (ENU x/y). */
  centroid: [number, number]
  /** Centroid-relative extent: minX, minY, maxX, maxY. */
  bbox: [number, number, number, number]
  cellCount: number
  /** Area of one survey cell in the local plane. Nominally 1 m². */
  cellAreaM2: number
  gridSegmentCount: number
  rimSegmentCount: number
  /** False when the source is not a clean cell lattice — the grid is then a
   *  point-in-polygon rasterisation rather than an exact reconstruction. */
  gridExact: boolean
}

export interface BuildDonationShapeOptions {
  /** Survey cell pitch in metres. */
  cellSizeM?: number
  /** 0 = untouched staircase … 1 = maximum rounding (disc radius 1.25 m). */
  smoothness?: number
  /** SDF raster pitch. 5 cm keeps a 14 m parcel under 100k cells. */
  sdfPixelM?: number
}

// ---------------------------------------------------------------- asset urls

/**
 * The production build is served from /livingdashboard/, where a root-absolute
 * path 404s and scripts/prepare-livingdashboard.mjs fails the build outright.
 * Absolute URLs (a future booking API) are passed through untouched.
 */
export function assetUrl(path: string): string {
  if (/^(https?:)?\/\//i.test(path)) return path
  const raw = import.meta.env.BASE_URL
  const base = raw.endsWith('/') ? raw : `${raw}/`
  return `${base}${path.replace(/^\/+/, '')}`
}

// ---------------------------------------------------------------- parsing

/** Accepts FeatureCollection / Feature / bare geometry / GeometryCollection. */
export function parseDonationShape(geojson: unknown): DonationShapeSource {
  const polygons: DonationShapePolygon[] = []
  let properties: Record<string, unknown> = {}
  let group: string | null = null

  const readRing = (ring: unknown): Array<readonly [number, number]> | null => {
    if (!Array.isArray(ring) || ring.length < 4) return null
    const out: Array<readonly [number, number]> = []
    for (const vertex of ring) {
      if (!Array.isArray(vertex) || vertex.length < 2) return null
      const lon = Number(vertex[0])
      const lat = Number(vertex[1])
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
      out.push([lon, lat])
    }
    // GeoJSON repeats the first vertex to close the ring; we carry it open.
    const first = out[0]
    const last = out[out.length - 1]
    if (first[0] === last[0] && first[1] === last[1]) out.pop()
    return out.length >= 3 ? out : null
  }

  const readPolygon = (rings: unknown): void => {
    if (!Array.isArray(rings) || rings.length === 0) return
    const outer = readRing(rings[0])
    if (!outer) return
    const holes: Array<Array<readonly [number, number]>> = []
    for (let index = 1; index < rings.length; index += 1) {
      const hole = readRing(rings[index])
      if (hole) holes.push(hole)
    }
    polygons.push({ outer, holes })
  }

  const readGeometry = (geometry: any): void => {
    if (!geometry || typeof geometry !== 'object') return
    switch (geometry.type) {
      case 'Polygon':
        readPolygon(geometry.coordinates)
        break
      case 'MultiPolygon':
        if (Array.isArray(geometry.coordinates)) geometry.coordinates.forEach(readPolygon)
        break
      case 'GeometryCollection':
        if (Array.isArray(geometry.geometries)) geometry.geometries.forEach(readGeometry)
        break
      default:
        break
    }
  }

  const readFeature = (feature: any): void => {
    if (!feature || typeof feature !== 'object') return
    const before = polygons.length
    readGeometry(feature.geometry ?? feature)
    if (polygons.length === before) return
    if (!group && feature.properties && typeof feature.properties === 'object') {
      properties = feature.properties as Record<string, unknown>
      const candidate = properties.group ?? properties.name ?? properties.id
      group = typeof candidate === 'string' ? candidate : null
    }
  }

  const root = geojson as any
  if (root && root.type === 'FeatureCollection' && Array.isArray(root.features)) {
    root.features.forEach(readFeature)
  } else if (root && root.type === 'Feature') {
    readFeature(root)
  } else {
    readGeometry(root)
  }

  if (polygons.length === 0) throw new Error('donation shape: no usable polygon in source')
  return { group, properties, polygons }
}

export async function fetchDonationShape(url: string): Promise<DonationShapeSource> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`donation shape HTTP ${response.status} · ${url}`)
  return parseDonationShape(await response.json())
}

// ---------------------------------------------------------------- ring maths

type Ring = Float64Array // flat x,y pairs, open

function signedArea(ring: Ring): number {
  let sum = 0
  const count = ring.length / 2
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    sum += ring[index * 2] * ring[next * 2 + 1] - ring[next * 2] * ring[index * 2 + 1]
  }
  return sum / 2
}

function ringPerimeter(ring: Ring): number {
  let sum = 0
  const count = ring.length / 2
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    sum += Math.hypot(ring[next * 2] - ring[index * 2], ring[next * 2 + 1] - ring[index * 2 + 1])
  }
  return sum
}

function ringCentroid(ring: Ring, area: number): [number, number] {
  if (Math.abs(area) < 1e-12) {
    let x = 0
    let y = 0
    const count = ring.length / 2
    for (let index = 0; index < count; index += 1) {
      x += ring[index * 2]
      y += ring[index * 2 + 1]
    }
    return [x / count, y / count]
  }
  let cx = 0
  let cy = 0
  const count = ring.length / 2
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    const x1 = ring[index * 2]
    const y1 = ring[index * 2 + 1]
    const x2 = ring[next * 2]
    const y2 = ring[next * 2 + 1]
    const cross = x1 * y2 - x2 * y1
    cx += (x1 + x2) * cross
    cy += (y1 + y2) * cross
  }
  return [cx / (6 * area), cy / (6 * area)]
}

/** Ear clipping expects counter-clockwise; the published file winds clockwise. */
function ensureCounterClockwise(ring: Ring): Ring {
  if (signedArea(ring) >= 0) return ring
  const out = new Float64Array(ring.length)
  const count = ring.length / 2
  for (let index = 0; index < count; index += 1) {
    const source = count - 1 - index
    out[index * 2] = ring[source * 2]
    out[index * 2 + 1] = ring[source * 2 + 1]
  }
  return out
}

function pointInRing(ring: Ring, x: number, y: number): boolean {
  let inside = false
  const count = ring.length / 2
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    const xi = ring[index * 2]
    const yi = ring[index * 2 + 1]
    const xj = ring[previous * 2]
    const yj = ring[previous * 2 + 1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// ---------------------------------------------------------------- triangulation

/**
 * Ear clipping. The project has no earcut dependency and one is not worth
 * adding for rings of at most ~250 vertices — this is microseconds here.
 * Holes are not supported; callers warn and drop them.
 */
function triangulate(ring: Ring): Uint32Array {
  const ccw = ensureCounterClockwise(ring)
  const count = ccw.length / 2
  if (count < 3) return new Uint32Array(0)

  const remaining: number[] = []
  for (let index = 0; index < count; index += 1) remaining.push(index)
  const indices: number[] = []

  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

  let guard = count * count + 16
  while (remaining.length > 3 && guard > 0) {
    guard -= 1
    let clipped = false
    for (let slot = 0; slot < remaining.length; slot += 1) {
      const previous = remaining[(slot + remaining.length - 1) % remaining.length]
      const current = remaining[slot]
      const next = remaining[(slot + 1) % remaining.length]
      const ax = ccw[previous * 2]
      const ay = ccw[previous * 2 + 1]
      const bx = ccw[current * 2]
      const by = ccw[current * 2 + 1]
      const cx = ccw[next * 2]
      const cy = ccw[next * 2 + 1]
      if (cross(ax, ay, bx, by, cx, cy) <= 0) continue // reflex or collinear

      let contains = false
      for (const candidate of remaining) {
        if (candidate === previous || candidate === current || candidate === next) continue
        const px = ccw[candidate * 2]
        const py = ccw[candidate * 2 + 1]
        if (
          cross(ax, ay, bx, by, px, py) >= 0
          && cross(bx, by, cx, cy, px, py) >= 0
          && cross(cx, cy, ax, ay, px, py) >= 0
        ) { contains = true; break }
      }
      if (contains) continue

      indices.push(previous, current, next)
      remaining.splice(slot, 1)
      clipped = true
      break
    }
    if (!clipped) break // degenerate ring — emit what we have
  }
  if (remaining.length === 3) indices.push(remaining[0], remaining[1], remaining[2])

  // Re-index into the caller's original vertex order.
  if (ccw !== ring) {
    for (let index = 0; index < indices.length; index += 1) indices[index] = count - 1 - indices[index]
  }
  return Uint32Array.from(indices)
}

// ---------------------------------------------------------------- 1 m² lattice

interface LatticeResult {
  segments: Float32Array
  cellCount: number
  rimSegmentCount: number
  cellAreaM2: number
  exact: boolean
}

/**
 * Reconstruct the survey cells behind the boundary and return only the
 * *interior* shared edges — the parcel rim is drawn from the outline itself.
 *
 * Euler check for the published file: 123 cells with a 52-edge rim give
 * 4·123 = 2·interior + 52 → 220 interior edges.
 *
 * The nominal cell is 1 m² in the survey's own projection, but this module works
 * in a local metric plane where a degree of latitude and a degree of longitude
 * do not stretch equally — here the cell measures about 1.000 m east by 1.007 m
 * north. So the pitch is measured off the data per axis instead of assumed;
 * assuming 1.0 both ways misses a whole row of cells.
 */
function buildLattice(ring: Ring, cellSizeM: number): LatticeResult {
  const count = ring.length / 2
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let index = 0; index < count; index += 1) {
    minX = Math.min(minX, ring[index * 2])
    maxX = Math.max(maxX, ring[index * 2])
    minY = Math.min(minY, ring[index * 2 + 1])
    maxY = Math.max(maxY, ring[index * 2 + 1])
  }

  // Shortest axis-aligned run per axis: on a cell mosaic that is the pitch.
  let pitchX = Infinity
  let pitchY = Infinity
  const straight = cellSizeM * 0.02
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    const dx = Math.abs(ring[next * 2] - ring[index * 2])
    const dy = Math.abs(ring[next * 2 + 1] - ring[index * 2 + 1])
    if (dy < straight && dx > 1e-6) pitchX = Math.min(pitchX, dx)
    if (dx < straight && dy > 1e-6) pitchY = Math.min(pitchY, dy)
  }
  let exact = Number.isFinite(pitchX) && Number.isFinite(pitchY)
  if (!exact) { pitchX = cellSizeM; pitchY = cellSizeM }

  // Every published vertex sits on that lattice; anchor on the bbox corner so
  // the indices come out integral. The tolerance is 5 % of the pitch rather
  // than something tight because the survey grid is defined in UTM and carries
  // a little meridian convergence against this local plane — the published file
  // drifts up to ~2.7 cm over its 14 m, a fraction of the rendered line width.
  // A vertex outside that band means the source is not a cell mosaic at all;
  // the rasterisation below still runs, it just stops being an exact
  // reconstruction and the caller can say so.
  for (let index = 0; index < count && exact; index += 1) {
    const ix = (ring[index * 2] - minX) / pitchX
    const iy = (ring[index * 2 + 1] - minY) / pitchY
    if (Math.abs(ix - Math.round(ix)) > 0.05) exact = false
    if (Math.abs(iy - Math.round(iy)) > 0.05) exact = false
  }

  const columns = Math.max(1, Math.round((maxX - minX) / pitchX))
  const rows = Math.max(1, Math.round((maxY - minY) / pitchY))
  if (columns * rows > 4_000_000) {
    return {
      segments: new Float32Array(0), cellCount: 0, rimSegmentCount: count,
      cellAreaM2: pitchX * pitchY, exact: false,
    }
  }

  // Cell centres, even-odd. Cheap at this size and identical on both paths, so
  // a non-lattice polygon degrades to a rasterised grid instead of throwing.
  const occupied = new Uint8Array(columns * rows)
  let cellCount = 0
  for (let row = 0; row < rows; row += 1) {
    const y = minY + (row + 0.5) * pitchY
    for (let column = 0; column < columns; column += 1) {
      const x = minX + (column + 0.5) * pitchX
      if (!pointInRing(ring, x, y)) continue
      occupied[row * columns + column] = 1
      cellCount += 1
    }
  }

  // Count each unit edge; an edge shared by two occupied cells is interior.
  // Horizontal edges are keyed by (column, row) of the cell below them.
  const horizontal = new Uint8Array((rows + 1) * columns)
  const vertical = new Uint8Array(rows * (columns + 1))
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!occupied[row * columns + column]) continue
      horizontal[row * columns + column] += 1
      horizontal[(row + 1) * columns + column] += 1
      vertical[row * (columns + 1) + column] += 1
      vertical[row * (columns + 1) + column + 1] += 1
    }
  }

  const segments: number[] = []
  let rimSegmentCount = 0
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const hits = horizontal[row * columns + column]
      if (hits === 1) { rimSegmentCount += 1; continue }
      if (hits !== 2) continue
      const y = minY + row * pitchY
      segments.push(minX + column * pitchX, y, minX + (column + 1) * pitchX, y)
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const hits = vertical[row * (columns + 1) + column]
      if (hits === 1) { rimSegmentCount += 1; continue }
      if (hits !== 2) continue
      const x = minX + column * pitchX
      segments.push(x, minY + row * pitchY, x, minY + (row + 1) * pitchY)
    }
  }

  return {
    segments: Float32Array.from(segments), cellCount, rimSegmentCount,
    cellAreaM2: pitchX * pitchY, exact,
  }
}

// ---------------------------------------------------------------- organic form

interface Field {
  values: Float64Array // signed distance in metres, positive inside
  width: number
  height: number
  pixel: number
  originX: number
  originY: number
}

/** Exact squared Euclidean distance transform, Felzenszwalb & Huttenlocher. */
function distanceTransform1d(source: Float64Array, length: number, stride: number, offset: number,
  output: Float64Array, hull: Int32Array, boundary: Float64Array): void {
  let count = 0
  hull[0] = 0
  boundary[0] = -Infinity
  boundary[1] = Infinity
  for (let q = 1; q < length; q += 1) {
    let split = 0
    for (;;) {
      const p = hull[count]
      split = ((source[offset + q * stride] + q * q) - (source[offset + p * stride] + p * p)) / (2 * q - 2 * p)
      if (split > boundary[count]) break
      count -= 1
      if (count < 0) { count = 0; break }
    }
    count += 1
    hull[count] = q
    boundary[count] = split
    boundary[count + 1] = Infinity
  }
  let index = 0
  for (let q = 0; q < length; q += 1) {
    while (boundary[index + 1] < q) index += 1
    const p = hull[index]
    output[offset + q * stride] = (q - p) * (q - p) + source[offset + p * stride]
  }
}

function euclideanDistance(mask: Uint8Array, width: number, height: number, inside: boolean): Float64Array {
  const INF = 1e12
  const buffer = new Float64Array(width * height)
  for (let index = 0; index < buffer.length; index += 1) {
    const solid = inside ? mask[index] !== 0 : mask[index] === 0
    buffer[index] = solid ? 0 : INF
  }
  const scratch = new Float64Array(width * height)
  const span = Math.max(width, height)
  const hull = new Int32Array(span)
  const boundary = new Float64Array(span + 1)
  for (let row = 0; row < height; row += 1) {
    distanceTransform1d(buffer, width, 1, row * width, scratch, hull, boundary)
  }
  for (let column = 0; column < width; column += 1) {
    distanceTransform1d(scratch, height, width, column, buffer, hull, boundary)
  }
  for (let index = 0; index < buffer.length; index += 1) buffer[index] = Math.sqrt(buffer[index])
  return buffer
}

/** Positive inside, negative outside, in metres. */
function signedDistanceField(mask: Uint8Array, width: number, height: number, pixel: number): Float64Array {
  const toOutside = euclideanDistance(mask, width, height, false)
  const toInside = euclideanDistance(mask, width, height, true)
  const field = new Float64Array(width * height)
  for (let index = 0; index < field.length; index += 1) {
    field[index] = mask[index] !== 0 ? toOutside[index] * pixel : -toInside[index] * pixel
  }
  return field
}

function thresholdField(field: Float64Array, level: number): Uint8Array {
  const mask = new Uint8Array(field.length)
  for (let index = 0; index < field.length; index += 1) mask[index] = field[index] >= level ? 1 : 0
  return mask
}

function rasterizeRing(ring: Ring, pixel: number, padding: number): Field {
  const count = ring.length / 2
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let index = 0; index < count; index += 1) {
    minX = Math.min(minX, ring[index * 2])
    maxX = Math.max(maxX, ring[index * 2])
    minY = Math.min(minY, ring[index * 2 + 1])
    maxY = Math.max(maxY, ring[index * 2 + 1])
  }
  const originX = minX - padding
  const originY = minY - padding
  const width = Math.ceil((maxX + padding - originX) / pixel) + 2
  const height = Math.ceil((maxY + padding - originY) / pixel) + 2

  const mask = new Uint8Array(width * height)
  for (let row = 0; row < height; row += 1) {
    const y = originY + (row + 0.5) * pixel
    // Even-odd scanline: collect crossings once per row instead of running a
    // full point-in-polygon test per pixel.
    const crossings: number[] = []
    for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
      const yi = ring[index * 2 + 1]
      const yj = ring[previous * 2 + 1]
      if ((yi > y) === (yj > y)) continue
      const xi = ring[index * 2]
      const xj = ring[previous * 2]
      crossings.push(xi + ((xj - xi) * (y - yi)) / (yj - yi))
    }
    if (crossings.length < 2) continue
    crossings.sort((a, b) => a - b)
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = Math.max(0, Math.ceil((crossings[pair] - originX) / pixel - 0.5))
      const to = Math.min(width - 1, Math.floor((crossings[pair + 1] - originX) / pixel - 0.5))
      for (let column = from; column <= to; column += 1) mask[row * width + column] = 1
    }
  }

  return { values: signedDistanceField(mask, width, height, pixel), width, height, pixel, originX, originY }
}

/**
 * Marching squares with an asymptotic decider on the two saddle cases.
 *
 * Contour vertices are identified by the *grid edge* they cross, not by their
 * float position: every edge is shared by at most two cells and is crossed at
 * most once, so each node has degree ≤ 2 and the rings link up exactly. Hashing
 * rounded coordinates instead loses that guarantee and shreds the contour.
 */
function marchingSquares(field: Field, level: number): Float64Array[] {
  const { values, width, height, pixel, originX, originY } = field
  const horizontalTotal = height * (width - 1) // node between (col,row)-(col+1,row)
  const nodeTotal = horizontalTotal + (height - 1) * width // + (col,row)-(col,row+1)
  const nodeX = new Float64Array(nodeTotal)
  const nodeY = new Float64Array(nodeTotal)
  const adjacency = new Int32Array(nodeTotal * 2).fill(-1)
  const present = new Uint8Array(nodeTotal)

  const sampleX = (column: number): number => originX + (column + 0.5) * pixel
  const sampleY = (row: number): number => originY + (row + 0.5) * pixel
  const fraction = (v0: number, v1: number): number => {
    const delta = v1 - v0
    return Math.abs(delta) < 1e-12 ? 0.5 : (level - v0) / delta
  }

  const horizontalNode = (column: number, row: number): number => {
    const id = row * (width - 1) + column
    if (!present[id]) {
      const v0 = values[row * width + column]
      const v1 = values[row * width + column + 1]
      nodeX[id] = sampleX(column) + fraction(v0, v1) * pixel
      nodeY[id] = sampleY(row)
      present[id] = 1
    }
    return id
  }
  const verticalNode = (column: number, row: number): number => {
    const id = horizontalTotal + row * width + column
    if (!present[id]) {
      const v0 = values[row * width + column]
      const v1 = values[(row + 1) * width + column]
      nodeX[id] = sampleX(column)
      nodeY[id] = sampleY(row) + fraction(v0, v1) * pixel
      present[id] = 1
    }
    return id
  }
  const link = (a: number, b: number): void => {
    if (a === b) return
    if (adjacency[a * 2] < 0) adjacency[a * 2] = b
    else if (adjacency[a * 2 + 1] < 0) adjacency[a * 2 + 1] = b
    if (adjacency[b * 2] < 0) adjacency[b * 2] = a
    else if (adjacency[b * 2 + 1] < 0) adjacency[b * 2 + 1] = a
  }

  for (let row = 0; row + 1 < height; row += 1) {
    for (let column = 0; column + 1 < width; column += 1) {
      const bl = values[row * width + column]
      const br = values[row * width + column + 1]
      const tr = values[(row + 1) * width + column + 1]
      const tl = values[(row + 1) * width + column]
      let code = 0
      if (bl >= level) code |= 1
      if (br >= level) code |= 2
      if (tr >= level) code |= 4
      if (tl >= level) code |= 8
      if (code === 0 || code === 15) continue

      const bottom = (): number => horizontalNode(column, row)
      const top = (): number => horizontalNode(column, row + 1)
      const left = (): number => verticalNode(column, row)
      const right = (): number => verticalNode(column + 1, row)

      // Saddles: the bilinear centre value decides which corner pair joins.
      if (code === 5 || code === 10) {
        const joined = (bl + br + tr + tl) / 4 >= level
        if ((code === 5) === joined) {
          link(left(), top())
          link(bottom(), right())
        } else {
          link(left(), bottom())
          link(top(), right())
        }
        continue
      }

      switch (code) {
        case 1: case 14: link(left(), bottom()); break
        case 2: case 13: link(bottom(), right()); break
        case 3: case 12: link(left(), right()); break
        case 4: case 11: link(right(), top()); break
        case 6: case 9: link(bottom(), top()); break
        case 7: case 8: link(left(), top()); break
        default: break
      }
    }
  }

  const visited = new Uint8Array(nodeTotal)
  const rings: Float64Array[] = []
  for (let seed = 0; seed < nodeTotal; seed += 1) {
    if (!present[seed] || visited[seed] || adjacency[seed * 2] < 0) continue
    const ring: number[] = []
    let current = seed
    let previous = -1
    let guard = nodeTotal + 1
    while (current >= 0 && !visited[current] && guard > 0) {
      guard -= 1
      visited[current] = 1
      ring.push(nodeX[current], nodeY[current])
      const a = adjacency[current * 2]
      const b = adjacency[current * 2 + 1]
      const next = a !== previous && a >= 0 ? a : b
      previous = current
      current = next
    }
    if (ring.length >= 8) rings.push(Float64Array.from(ring))
  }
  return rings
}

/** Douglas-Peucker on a closed ring. */
function simplifyRing(ring: Ring, tolerance: number): Ring {
  const count = ring.length / 2
  if (count < 4) return ring
  const keep = new Uint8Array(count)
  keep[0] = 1
  keep[count - 1] = 1

  const stack: Array<[number, number]> = [[0, count - 1]]
  while (stack.length) {
    const [from, to] = stack.pop()!
    if (to <= from + 1) continue
    const ax = ring[from * 2]
    const ay = ring[from * 2 + 1]
    const bx = ring[to * 2]
    const by = ring[to * 2 + 1]
    const dx = bx - ax
    const dy = by - ay
    const lengthSq = dx * dx + dy * dy
    let worst = -1
    let worstIndex = -1
    for (let index = from + 1; index < to; index += 1) {
      const px = ring[index * 2]
      const py = ring[index * 2 + 1]
      let distance: number
      if (lengthSq < 1e-18) {
        distance = Math.hypot(px - ax, py - ay)
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
        distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
      }
      if (distance > worst) { worst = distance; worstIndex = index }
    }
    if (worst > tolerance && worstIndex > 0) {
      keep[worstIndex] = 1
      stack.push([from, worstIndex], [worstIndex, to])
    }
  }

  const out: number[] = []
  for (let index = 0; index < count; index += 1) {
    if (keep[index]) out.push(ring[index * 2], ring[index * 2 + 1])
  }
  return Float64Array.from(out)
}

/** Even arc-length resampling, so sweeps and light runs move at constant speed. */
function resampleRing(ring: Ring, spacing: number, maxVertices: number): Ring {
  const perimeter = ringPerimeter(ring)
  if (perimeter < 1e-6) return ring
  const count = ring.length / 2
  const target = Math.max(8, Math.min(maxVertices, Math.round(perimeter / spacing)))
  const step = perimeter / target

  const cumulative = new Float64Array(count + 1)
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    cumulative[index + 1] = cumulative[index]
      + Math.hypot(ring[next * 2] - ring[index * 2], ring[next * 2 + 1] - ring[index * 2 + 1])
  }

  const out = new Float64Array(target * 2)
  let segment = 0
  for (let index = 0; index < target; index += 1) {
    const distance = index * step
    while (segment + 1 < count && cumulative[segment + 1] < distance) segment += 1
    const next = (segment + 1) % count
    const span = cumulative[segment + 1] - cumulative[segment]
    const t = span < 1e-9 ? 0 : (distance - cumulative[segment]) / span
    out[index * 2] = ring[segment * 2] + (ring[next * 2] - ring[segment * 2]) * t
    out[index * 2 + 1] = ring[segment * 2 + 1] + (ring[next * 2 + 1] - ring[segment * 2 + 1]) * t
  }
  return out
}

/** Three-tap blur around the ring; removes residual raster stair noise. */
function smoothRing(ring: Ring, passes: number): Ring {
  let current = ring
  const count = ring.length / 2
  if (count < 5) return ring
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Float64Array(current.length)
    for (let index = 0; index < count; index += 1) {
      const previous = (index + count - 1) % count
      const following = (index + 1) % count
      next[index * 2] = 0.25 * current[previous * 2] + 0.5 * current[index * 2] + 0.25 * current[following * 2]
      next[index * 2 + 1] = 0.25 * current[previous * 2 + 1] + 0.5 * current[index * 2 + 1]
        + 0.25 * current[following * 2 + 1]
    }
    current = next
  }
  return current
}

/**
 * Morphological opening then closing with a disc of radius r, re-contoured at an
 * iso value chosen so the result keeps the parcel's area. Correcting the area
 * through the iso value is a small uniform normal offset — unlike an
 * outward-only offset it does not systematically claim land that was not bought,
 * and unlike scaling about the centroid it does not distort the shape.
 */
function buildOrganicRing(exact: Ring, smoothness: number, pixel: number, targetArea: number): Ring {
  const radius = 1.25 * Math.max(0, Math.min(1, smoothness))
  if (radius < pixel * 2) return exact

  let field = rasterizeRing(exact, pixel, radius * 2 + 0.5)
  const reField = (mask: Uint8Array): void => {
    field = {
      ...field,
      values: signedDistanceField(mask, field.width, field.height, field.pixel),
    }
  }
  reField(thresholdField(field.values, radius))   // erode
  reField(thresholdField(field.values, -radius))  // dilate  -> opening
  reField(thresholdField(field.values, -radius))  // dilate
  reField(thresholdField(field.values, radius))   // erode   -> closing

  const contourAt = (level: number): Ring | null => {
    const rings = marchingSquares(field, level)
    if (rings.length === 0) return null
    let best = rings[0]
    let bestArea = Math.abs(signedArea(best))
    for (const candidate of rings) {
      const area = Math.abs(signedArea(candidate))
      if (area > bestArea) { best = candidate; bestArea = area }
    }
    const simplified = simplifyRing(best, 0.02)
    const resampled = resampleRing(simplified, 0.15, 256)
    return smoothRing(resampled, 2)
  }

  // Area falls monotonically as the iso level rises; two Newton steps against
  // the finished ring (dA/dLevel ≈ -perimeter) land well inside a square
  // centimetre.
  let level = 0
  let ring = contourAt(level)
  if (!ring) return exact
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const area = Math.abs(signedArea(ring))
    const error = area - targetArea
    if (Math.abs(error) < 1e-3) break
    const perimeter = Math.max(1e-3, ringPerimeter(ring))
    level = Math.max(-0.5, Math.min(0.5, level + error / perimeter))
    const next = contourAt(level)
    if (!next) break
    ring = next
  }
  return ring
}

// ---------------------------------------------------------------- ribbons

/** Thick line as geometry — WebGPU pins line width to one pixel. */
export function buildOutlineRibbon(ring: Float32Array): ShapeRibbon {
  const count = ring.length / 2
  const positions = new Float32Array(count * 4)
  const offsets = new Float32Array(count * 4)
  const arcU = new Float32Array(count * 2)
  const edgeD = new Float32Array(count * 2)
  const indices = new Uint32Array(count * 6)

  let travelled = 0
  const lengths = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    lengths[index] = Math.hypot(ring[next * 2] - ring[index * 2], ring[next * 2 + 1] - ring[index * 2 + 1])
  }
  let perimeter = 0
  for (let index = 0; index < count; index += 1) perimeter += lengths[index]
  if (perimeter < 1e-6) perimeter = 1

  for (let index = 0; index < count; index += 1) {
    const previous = (index + count - 1) % count
    const next = (index + 1) % count
    // Miter normal from the two adjacent edges keeps corners closed.
    let nx = 0
    let ny = 0
    for (const [from, to] of [[previous, index], [index, next]] as const) {
      const dx = ring[to * 2] - ring[from * 2]
      const dy = ring[to * 2 + 1] - ring[from * 2 + 1]
      const length = Math.hypot(dx, dy) || 1
      nx += -dy / length
      ny += dx / length
    }
    const normal = Math.hypot(nx, ny) || 1
    // Clamp the miter so a right-angle staircase corner cannot spike outward.
    const scale = Math.min(2.5, 2 / normal)
    nx = (nx / normal) * scale
    ny = (ny / normal) * scale

    positions[index * 4] = ring[index * 2]
    positions[index * 4 + 1] = ring[index * 2 + 1]
    positions[index * 4 + 2] = ring[index * 2]
    positions[index * 4 + 3] = ring[index * 2 + 1]
    offsets[index * 4] = nx
    offsets[index * 4 + 1] = ny
    offsets[index * 4 + 2] = -nx
    offsets[index * 4 + 3] = -ny
    arcU[index * 2] = travelled / perimeter
    arcU[index * 2 + 1] = travelled / perimeter
    edgeD[index * 2] = 1
    edgeD[index * 2 + 1] = -1
    travelled += lengths[index]

    const a = index * 2
    const b = index * 2 + 1
    const c = (next * 2) % (count * 2)
    const d = c + 1
    indices[index * 6] = a
    indices[index * 6 + 1] = b
    indices[index * 6 + 2] = d
    indices[index * 6 + 3] = a
    indices[index * 6 + 4] = d
    indices[index * 6 + 5] = c
  }

  return { positions, offsets, indices, arcU, edgeD }
}

/** Independent segments (the 1 m² lattice) as one indexed ribbon geometry. */
export function buildSegmentRibbon(segments: Float32Array): ShapeRibbon {
  const count = segments.length / 4
  const positions = new Float32Array(count * 8)
  const offsets = new Float32Array(count * 8)
  const arcU = new Float32Array(count * 4)
  const edgeD = new Float32Array(count * 4)
  const indices = new Uint32Array(count * 6)

  for (let index = 0; index < count; index += 1) {
    const x0 = segments[index * 4]
    const y0 = segments[index * 4 + 1]
    const x1 = segments[index * 4 + 2]
    const y1 = segments[index * 4 + 3]
    const dx = x1 - x0
    const dy = y1 - y0
    const length = Math.hypot(dx, dy) || 1
    const nx = -dy / length
    const ny = dx / length

    const base = index * 8
    positions[base] = x0; positions[base + 1] = y0
    positions[base + 2] = x0; positions[base + 3] = y0
    positions[base + 4] = x1; positions[base + 5] = y1
    positions[base + 6] = x1; positions[base + 7] = y1
    offsets[base] = nx; offsets[base + 1] = ny
    offsets[base + 2] = -nx; offsets[base + 3] = -ny
    offsets[base + 4] = nx; offsets[base + 5] = ny
    offsets[base + 6] = -nx; offsets[base + 7] = -ny

    const vertex = index * 4
    arcU[vertex] = 0; arcU[vertex + 1] = 0; arcU[vertex + 2] = 1; arcU[vertex + 3] = 1
    edgeD[vertex] = 1; edgeD[vertex + 1] = -1; edgeD[vertex + 2] = 1; edgeD[vertex + 3] = -1

    indices[index * 6] = vertex
    indices[index * 6 + 1] = vertex + 1
    indices[index * 6 + 2] = vertex + 3
    indices[index * 6 + 3] = vertex
    indices[index * 6 + 4] = vertex + 3
    indices[index * 6 + 5] = vertex + 2
  }

  return { positions, offsets, indices, arcU, edgeD }
}

/**
 * Vertical wall strip standing on a ring, built at unit height so the layer can
 * scale it between the 4 m wall and the full canopy column without a rebuild.
 * `wallT` runs 0 at the foot to 1 at the top, `arcU` 0..1 around the perimeter.
 */
export interface ShapeWall {
  positions: Float32Array
  indices: Uint32Array
  wallT: Float32Array
  arcU: Float32Array
}

export function buildWall(ring: Float32Array): ShapeWall {
  const count = ring.length / 2
  const positions = new Float32Array(count * 2 * 3)
  const wallT = new Float32Array(count * 2)
  const arcU = new Float32Array(count * 2)
  const indices = new Uint32Array(count * 6)

  const lengths = new Float32Array(count)
  let perimeter = 0
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    lengths[index] = Math.hypot(ring[next * 2] - ring[index * 2], ring[next * 2 + 1] - ring[index * 2 + 1])
    perimeter += lengths[index]
  }
  if (perimeter < 1e-6) perimeter = 1

  let travelled = 0
  for (let index = 0; index < count; index += 1) {
    const base = index * 6
    positions[base] = ring[index * 2]
    positions[base + 1] = ring[index * 2 + 1]
    positions[base + 2] = 0
    positions[base + 3] = ring[index * 2]
    positions[base + 4] = ring[index * 2 + 1]
    positions[base + 5] = 1
    wallT[index * 2] = 0
    wallT[index * 2 + 1] = 1
    arcU[index * 2] = travelled / perimeter
    arcU[index * 2 + 1] = travelled / perimeter
    travelled += lengths[index]

    const next = (index + 1) % count
    const a = index * 2
    const b = index * 2 + 1
    const c = next * 2
    const d = next * 2 + 1
    indices[index * 6] = a
    indices[index * 6 + 1] = c
    indices[index * 6 + 2] = d
    indices[index * 6 + 3] = a
    indices[index * 6 + 4] = d
    indices[index * 6 + 5] = b
  }

  return { positions, indices, wallT, arcU }
}

// ---------------------------------------------------------------- entry point

export function buildDonationShapeGeometry(
  source: DonationShapeSource,
  toLocal: LonLatToLocal,
  options: BuildDonationShapeOptions = {},
): DonationShapeGeometry {
  const cellSizeM = options.cellSizeM ?? 1
  const smoothness = options.smoothness ?? 0.65
  const sdfPixelM = options.sdfPixelM ?? 0.05

  const scratch: [number, number] = [0, 0]
  const absolute: Ring[] = []
  let holeCount = 0
  for (const polygon of source.polygons) {
    holeCount += polygon.holes.length
    const ring = new Float64Array(polygon.outer.length * 2)
    for (let index = 0; index < polygon.outer.length; index += 1) {
      const [lon, lat] = polygon.outer[index]
      toLocal(lon, lat, scratch)
      ring[index * 2] = scratch[0]
      ring[index * 2 + 1] = scratch[1]
    }
    absolute.push(ring)
  }
  if (holeCount > 0) {
    console.warn(`[donation-shape] ${holeCount} interior ring(s) ignored — v1 renders outer rings only`)
  }

  let areaM2 = 0
  let perimeterM = 0
  let cx = 0
  let cy = 0
  for (const ring of absolute) {
    const area = Math.abs(signedArea(ring))
    const centre = ringCentroid(ring, signedArea(ring))
    areaM2 += area
    perimeterM += ringPerimeter(ring)
    cx += centre[0] * area
    cy += centre[1] * area
  }
  const centroid: [number, number] = areaM2 > 1e-9
    ? [cx / areaM2, cy / areaM2]
    : ringCentroid(absolute[0], signedArea(absolute[0]))

  // Everything downstream is centroid-relative so float32 attributes stay exact
  // — absolute ENU coordinates here are kilometre-scale.
  const local: Ring[] = absolute.map((ring) => {
    const out = new Float64Array(ring.length)
    for (let index = 0; index < ring.length; index += 2) {
      out[index] = ring[index] - centroid[0]
      out[index + 1] = ring[index + 1] - centroid[1]
    }
    return out
  })

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ring of local) {
    for (let index = 0; index < ring.length; index += 2) {
      minX = Math.min(minX, ring[index])
      maxX = Math.max(maxX, ring[index])
      minY = Math.min(minY, ring[index + 1])
      maxY = Math.max(maxY, ring[index + 1])
    }
  }

  const gridSegments: number[] = []
  let cellCount = 0
  let rimSegmentCount = 0
  let cellAreaM2 = cellSizeM * cellSizeM
  let gridExact = true
  for (const ring of local) {
    const lattice = buildLattice(ring, cellSizeM)
    for (const value of lattice.segments) gridSegments.push(value)
    cellCount += lattice.cellCount
    rimSegmentCount += lattice.rimSegmentCount
    cellAreaM2 = lattice.cellAreaM2
    if (!lattice.exact) gridExact = false
  }

  const organic = local.map((ring) => buildOrganicRing(ring, smoothness, sdfPixelM, Math.abs(signedArea(ring))))

  const toFloat32 = (ring: Ring): Float32Array => Float32Array.from(ring)
  const buildFill = (rings: Ring[]): ShapeFill => {
    const positions: number[] = []
    const indices: number[] = []
    for (const ring of rings) {
      const offset = positions.length / 2
      for (let index = 0; index < ring.length; index += 2) positions.push(ring[index], ring[index + 1])
      for (const value of triangulate(ring)) indices.push(offset + value)
    }
    return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
  }

  return {
    outlineExact: local.map(toFloat32),
    outlineOrganic: organic.map(toFloat32),
    gridSegments: Float32Array.from(gridSegments),
    fillExact: buildFill(local),
    fillOrganic: buildFill(organic),
    areaM2,
    perimeterM,
    centroid,
    bbox: [minX, minY, maxX, maxY],
    cellCount,
    cellAreaM2,
    gridSegmentCount: gridSegments.length / 4,
    rimSegmentCount,
    gridExact,
  }
}
