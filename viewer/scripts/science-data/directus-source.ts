// The interim source: the Directus instance behind the old wi-map prototype
// (https://github.com/schnellebuntebilder/wi-map), on top of a MariaDB. Public read, no token.
//
// This file is the only place that knows Directus. It maps the collections onto the board's
// entities (science-data-format.ts); when the project's PostGIS database arrives, a sibling
// reader with the same result shape replaces it and nothing downstream changes.
//
// What the mapping settles that the source leaves open:
// - Trails come from `Trails` (Kirkby SFO, EI, SFO GIS, Malinowski) and `Other_Trails`. The
//   prototype also loaded SFO_Trails, El_Trails and Malinowski_Trails, which `Trails` already
//   holds. Row numbers restart per collection, so trail_id carries the collection.
// - The 10 points among the trail rows and the area without geometry are dropped and
//   reported, not published (feedback F4 on the Canopy Science Data page).
// - Directus has no country column; it is worked out from where a feature lies.

import {
  bboxOf,
  countryCodeOf,
  toMultiLineString,
  toMultiPolygon,
  type CountryCode,
  type DatasetId,
  type DatasetShapes,
  type ProtectedAreaCollection,
  type TrailCollection,
} from '../../src/threejs-test/science-data-format.ts'

export const DIRECTUS_URL = 'https://wi.mediascenography.com'

export interface DirectusRow {
  id: string | number
  geom?: unknown
  [field: string]: unknown
}

export interface Dropped {
  dataset: DatasetId
  id: string
  name: string
  reason: string
}

export interface SourceResult {
  source: { kind: string; url: string }
  collections: DatasetShapes
  dropped: Dropped[]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nullableText(value: unknown): string | null {
  const t = text(value)
  return t === '' ? null : t
}

/** Stable output order, so an unchanged source hashes the same however Directus sorts. */
function compareIds(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true })
}

function geometryKind(geom: unknown): string {
  const type = (geom as { type?: unknown } | null)?.type
  return typeof type === 'string' ? type : 'no geometry'
}

export function mapProtectedAreas(rows: DirectusRow[]): { collection: ProtectedAreaCollection; dropped: Dropped[] } {
  const collection: ProtectedAreaCollection = { type: 'FeatureCollection', features: [] }
  const dropped: Dropped[] = []
  for (const row of rows) {
    const area_id = String(row.id)
    const area_name = text(row.area_name)
    const geometry = toMultiPolygon(row.geom)
    if (!geometry) {
      dropped.push({ dataset: 'protected-areas', id: area_id, name: area_name, reason: `${geometryKind(row.geom)}, no drawable polygon` })
      continue
    }
    collection.features.push({
      type: 'Feature',
      geometry,
      properties: {
        area_id,
        // null when it lies in neither country; validateCollection then refuses the run.
        country_code: countryCodeOf(bboxOf(geometry)) as CountryCode,
        area_name,
        folder_name: nullableText(row.folder_name),
      },
    })
  }
  collection.features.sort((a, b) => compareIds(a.properties.area_id, b.properties.area_id))
  return { collection, dropped }
}

/** Which field holds the name, and the prefix that keeps trail IDs unique across collections. */
export const TRAIL_COLLECTIONS = {
  Trails: { nameField: 'trail_name', idPrefix: 'trails' },
  Other_Trails: { nameField: 'area_name', idPrefix: 'other-trails' },
} as const

export type TrailCollectionName = keyof typeof TRAIL_COLLECTIONS

export function mapTrails(sources: Array<{ collection: TrailCollectionName; rows: DirectusRow[] }>): { collection: TrailCollection; dropped: Dropped[] } {
  const collection: TrailCollection = { type: 'FeatureCollection', features: [] }
  const dropped: Dropped[] = []
  for (const { collection: name, rows } of sources) {
    const { nameField, idPrefix } = TRAIL_COLLECTIONS[name]
    for (const row of rows) {
      const trail_id = `${idPrefix}/${row.id}`
      const trail_name = text(row[nameField])
      const geometry = toMultiLineString(row.geom)
      if (!geometry) {
        dropped.push({ dataset: 'trails', id: trail_id, name: trail_name, reason: `${geometryKind(row.geom)}, not a line` })
        continue
      }
      collection.features.push({
        type: 'Feature',
        geometry,
        properties: {
          trail_id,
          country_code: countryCodeOf(bboxOf(geometry)) as CountryCode,
          trail_name,
          folder_name: nullableText(row.folder_name),
        },
      })
    }
  }
  collection.features.sort((a, b) => compareIds(a.properties.trail_id, b.properties.trail_id))
  return { collection, dropped }
}

async function fetchCollection(baseUrl: string, name: string, fields: string[], fetchImpl: typeof fetch): Promise<DirectusRow[]> {
  const url = `${baseUrl}/items/${name}?limit=-1&fields=${fields.join(',')}`
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Directus ${name}: HTTP ${response.status} ${await response.text()}`)
  const body = await response.json() as { data?: unknown }
  if (!Array.isArray(body.data)) throw new Error(`Directus ${name}: no data array in the response`)
  return body.data as DirectusRow[]
}

export async function readDirectus(baseUrl: string = DIRECTUS_URL, fetchImpl: typeof fetch = fetch): Promise<SourceResult> {
  const base = baseUrl.replace(/\/+$/, '')
  const [areaRows, trailRows, otherTrailRows] = await Promise.all([
    fetchCollection(base, 'Protected_Areas', ['id', 'area_name', 'folder_name', 'geom'], fetchImpl),
    fetchCollection(base, 'Trails', ['id', 'trail_name', 'folder_name', 'geom'], fetchImpl),
    fetchCollection(base, 'Other_Trails', ['id', 'area_name', 'folder_name', 'geom'], fetchImpl),
  ])
  const areas = mapProtectedAreas(areaRows)
  const trails = mapTrails([
    { collection: 'Trails', rows: trailRows },
    { collection: 'Other_Trails', rows: otherTrailRows },
  ])
  return {
    source: { kind: 'directus', url: base },
    collections: { 'protected-areas': areas.collection, trails: trails.collection },
    dropped: [...areas.dropped, ...trails.dropped],
  }
}
