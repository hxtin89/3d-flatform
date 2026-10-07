// Science data — the format the viewer reads, whatever the source.
//
// One GeoJSON file per entity of the architecture board ("260609 | Architecture Diagram &
// Data Entities"), its properties named as on the board in snake_case, geometry in WGS84
// lon/lat. The preparation step (scripts/science-data/prepare.ts) writes the files and an
// index.json beside them; the viewer reads the index, then the files it needs. Nothing here
// knows where the data came from: Directus today, the project's PostGIS database later.
// Only the preparation step's reader changes when the source does.
//
// Files are immutable: the name carries the content hash, so a CDN and the browser may cache
// them forever, and a new version is a new file. index.json is the one file that changes,
// and it is written last, so a reader sees the old set or the new set, never half of each.
//
// Free of imports on purpose: the preparation step loads this file under Node's type
// stripping, and the node tests (science-data-format.test.ts) cover it.

export const SCIENCE_FORMAT = 1

export const DATASET_IDS = ['protected-areas', 'trails'] as const
export type DatasetId = (typeof DATASET_IDS)[number]

export type CountryCode = 'PE' | 'CA'

/** lon, lat in degrees (WGS84). */
export type Position = [number, number]

export interface MultiPolygonGeometry {
  type: 'MultiPolygon'
  coordinates: Position[][][]
}

export interface MultiLineStringGeometry {
  type: 'MultiLineString'
  coordinates: Position[][]
}

export interface ProtectedAreaProperties {
  area_id: string
  country_code: CountryCode
  area_name: string
  /** Directus folder, e.g. "Secret Forest 250902". Interim: the board has no Sites yet (F1). */
  folder_name: string | null
}

export interface TrailProperties {
  trail_id: string
  country_code: CountryCode
  trail_name: string
  /** Directus folder, e.g. "Kirkby_SFO_Trails": the survey a trail comes from. Interim (F5). */
  folder_name: string | null
}

export interface ScienceFeature<G, P> {
  type: 'Feature'
  geometry: G
  properties: P
}

export interface ScienceCollection<G, P> {
  type: 'FeatureCollection'
  features: Array<ScienceFeature<G, P>>
}

export type ProtectedAreaCollection = ScienceCollection<MultiPolygonGeometry, ProtectedAreaProperties>
export type TrailCollection = ScienceCollection<MultiLineStringGeometry, TrailProperties>

/** What each dataset's file holds. */
export interface DatasetShapes {
  'protected-areas': ProtectedAreaCollection
  trails: TrailCollection
}

export interface DatasetVersion {
  /** File name, relative to index.json. */
  file: string
  /** First 16 hex digits of the file's SHA-256. */
  version: string
  /** When this version first appeared (ISO 8601). An unchanged rerun keeps it. */
  updatedAt: string
}

export interface DatasetEntry extends DatasetVersion {
  featureCount: number
  bytes: number
  /** [west, south, east, north] in degrees. */
  bbox: [number, number, number, number]
  /** Earlier versions, newest first. Their files stay, so a rollback is an index edit. */
  history: DatasetVersion[]
}

export interface ScienceIndex {
  format: typeof SCIENCE_FORMAT
  /** When the index last changed (ISO 8601). */
  generatedAt: string
  source: { kind: string; url: string }
  datasets: Partial<Record<DatasetId, DatasetEntry>>
}

/** How many earlier versions an index entry remembers. */
export const HISTORY_LENGTH = 3

/** About 1 cm at the equator. The sources carry 14 decimals, which is noise. */
export const COORDINATE_DECIMALS = 7

/** A rerun that loses more than this share of a dataset's features is refused. */
export const MAX_SHRINK_SHARE = 0.2

// Generous bounds per country; only used to tell the two apart and to catch swapped or
// projected coordinates. A dataset in a third country needs a new entry here.
const COUNTRY_BOUNDS: Record<CountryCode, [number, number, number, number]> = {
  PE: [-81.5, -18.5, -68.5, 0.5],
  CA: [-141.1, 41.6, -52.6, 83.2],
}

export function countryCodeOf(bbox: [number, number, number, number]): CountryCode | null {
  for (const code of Object.keys(COUNTRY_BOUNDS) as CountryCode[]) {
    const [w, s, e, n] = COUNTRY_BOUNDS[code]
    if (bbox[0] >= w && bbox[1] >= s && bbox[2] <= e && bbox[3] <= n) return code
  }
  return null
}

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

function isPosition(p: unknown): p is number[] {
  return Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number'
}

/** Rounded positions without consecutive repeats; heights are dropped. */
function cleanPath(path: unknown): Position[] {
  if (!Array.isArray(path)) return []
  const out: Position[] = []
  for (const p of path) {
    if (!isPosition(p)) return []
    const q: Position = [roundTo(p[0], COORDINATE_DECIMALS), roundTo(p[1], COORDINATE_DECIMALS)]
    const last = out[out.length - 1]
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q)
  }
  return out
}

function cleanRing(ring: unknown): Position[] | null {
  const out = cleanPath(ring)
  if (out.length === 0) return null
  const first = out[0]
  const last = out[out.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]])
  return out.length >= 4 ? out : null
}

function cleanPolygon(rings: unknown): Position[][] | null {
  if (!Array.isArray(rings) || rings.length === 0) return null
  const outer = cleanRing(rings[0])
  if (!outer) return null
  const holes = rings.slice(1).map(cleanRing).filter((r): r is Position[] => r !== null)
  return [outer, ...holes]
}

/** Polygon or MultiPolygon → MultiPolygon, or null when nothing drawable is left. */
export function toMultiPolygon(geometry: unknown): MultiPolygonGeometry | null {
  const g = geometry as { type?: string; coordinates?: unknown } | null
  if (!g || !Array.isArray(g.coordinates)) return null
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null
  if (!polygons) return null
  const coordinates = polygons.map(cleanPolygon).filter((p): p is Position[][] => p !== null)
  return coordinates.length > 0 ? { type: 'MultiPolygon', coordinates } : null
}

/** LineString or MultiLineString → MultiLineString, or null (points included). */
export function toMultiLineString(geometry: unknown): MultiLineStringGeometry | null {
  const g = geometry as { type?: string; coordinates?: unknown } | null
  if (!g || !Array.isArray(g.coordinates)) return null
  const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : null
  if (!lines) return null
  const coordinates = lines.map(cleanPath).filter(line => line.length >= 2)
  return coordinates.length > 0 ? { type: 'MultiLineString', coordinates } : null
}

export function bboxOf(geometry: MultiPolygonGeometry | MultiLineStringGeometry): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  const visit = (p: Position) => {
    if (p[0] < box[0]) box[0] = p[0]
    if (p[1] < box[1]) box[1] = p[1]
    if (p[0] > box[2]) box[2] = p[0]
    if (p[1] > box[3]) box[3] = p[1]
  }
  if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(visit)))
  else geometry.coordinates.forEach(line => line.forEach(visit))
  return box
}

export function unionBbox(boxes: Array<[number, number, number, number]>): [number, number, number, number] {
  const out: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const b of boxes) {
    out[0] = Math.min(out[0], b[0])
    out[1] = Math.min(out[1], b[1])
    out[2] = Math.max(out[2], b[2])
    out[3] = Math.max(out[3], b[3])
  }
  return out
}

const ID_KEY: Record<DatasetId, 'area_id' | 'trail_id'> = { 'protected-areas': 'area_id', trails: 'trail_id' }
const NAME_KEY: Record<DatasetId, 'area_name' | 'trail_name'> = { 'protected-areas': 'area_name', trails: 'trail_name' }
const GEOMETRY_TYPE: Record<DatasetId, string> = { 'protected-areas': 'MultiPolygon', trails: 'MultiLineString' }

/**
 * Everything wrong with a collection, as readable lines; empty when it may be published.
 * Checks unique IDs, names, the geometry type, WGS84 ranges, closed rings and that the
 * country code matches where the feature lies.
 */
export function validateCollection<D extends DatasetId>(dataset: D, collection: DatasetShapes[D]): string[] {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    return [`${dataset}: not a FeatureCollection`]
  }
  const problems: string[] = []
  if (collection.features.length === 0) problems.push(`${dataset}: no features`)
  const seen = new Set<string>()
  for (const feature of collection.features) {
    const props = feature.properties as unknown as Record<string, unknown>
    const id = props[ID_KEY[dataset]]
    const label = `${dataset} ${String(id)}`
    if (typeof id !== 'string' || id === '') problems.push(`${label}: missing ${ID_KEY[dataset]}`)
    else if (seen.has(id)) problems.push(`${label}: duplicate ${ID_KEY[dataset]}`)
    else seen.add(id)
    const name = props[NAME_KEY[dataset]]
    if (typeof name !== 'string' || name.trim() === '') problems.push(`${label}: missing ${NAME_KEY[dataset]}`)
    const geometry = feature.geometry as MultiPolygonGeometry | MultiLineStringGeometry | null
    if (!geometry || geometry.type !== GEOMETRY_TYPE[dataset]) {
      problems.push(`${label}: geometry is ${geometry?.type ?? 'missing'}, expected ${GEOMETRY_TYPE[dataset]}`)
      continue
    }
    const paths: Position[][] = geometry.type === 'MultiPolygon' ? geometry.coordinates.flat() : geometry.coordinates
    let outOfRange = false
    for (const path of paths) {
      for (const p of path) {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) outOfRange = true
      }
      if (geometry.type === 'MultiPolygon') {
        const a = path[0]
        const b = path[path.length - 1]
        if (path.length < 4 || a[0] !== b[0] || a[1] !== b[1]) problems.push(`${label}: ring not closed or too short`)
      } else if (path.length < 2) {
        problems.push(`${label}: line with fewer than 2 points`)
      }
    }
    if (outOfRange) {
      problems.push(`${label}: coordinates outside WGS84 lon/lat (projected or swapped?)`)
      continue
    }
    const country = countryCodeOf(bboxOf(geometry))
    if (country !== props.country_code) {
      problems.push(`${label}: country_code ${String(props.country_code)}, but it lies in ${country ?? 'neither PE nor CA'}`)
    }
  }
  return problems
}

/** A refusal when a rerun loses too many features (a broken export, a half import), else null. */
export function shrinkProblem(dataset: DatasetId, previousCount: number | undefined, nextCount: number): string | null {
  if (previousCount === undefined || previousCount === 0) return null
  const lost = (previousCount - nextCount) / previousCount
  if (lost <= MAX_SHRINK_SHARE) return null
  return `${dataset}: ${nextCount} features, ${previousCount} before (${Math.round(lost * 100)} % fewer); pass --allow-shrink if that is intended`
}

/**
 * The index entry after a run. An unchanged version returns the previous entry as it was,
 * so a rerun without news leaves index.json byte for byte the same.
 */
export function nextEntry(
  previous: DatasetEntry | undefined,
  next: { file: string; version: string; featureCount: number; bytes: number; bbox: [number, number, number, number] },
  now: string,
): DatasetEntry {
  if (previous && previous.version === next.version) return previous
  const history = previous
    ? [{ file: previous.file, version: previous.version, updatedAt: previous.updatedAt }, ...previous.history]
    : []
  return { ...next, updatedAt: now, history: history.slice(0, HISTORY_LENGTH) }
}

/** Every file an index still points at: the current versions and their history. */
export function referencedFiles(index: ScienceIndex): Set<string> {
  const files = new Set<string>()
  for (const entry of Object.values(index.datasets)) {
    if (!entry) continue
    files.add(entry.file)
    for (const old of entry.history) files.add(old.file)
  }
  return files
}

/** `protected-areas.0123456789abcdef.json`: the only names the preparation step prunes. */
export const DATASET_FILE_PATTERN = /^(protected-areas|trails)\.[0-9a-f]{16}\.json$/

export function datasetFileName(dataset: DatasetId, version: string): string {
  return `${dataset}.${version}.json`
}
