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
  type DatasetShapes,
  type ProtectedAreaCollection,
  type TrailCollection,
} from '../../src/threejs-test/science-data-format.ts'
import {
  mapBigTrees,
  mapHerps,
  mapMammals,
  mapTreePlots,
  nullableText,
  text,
  type DirectusRow,
  type Dropped,
} from './directus-records.ts'

export type { DirectusRow, Dropped }

export const DIRECTUS_URL = 'https://wi.mediascenography.com'

export interface SourceResult {
  source: { kind: string; url: string }
  collections: DatasetShapes
  dropped: Dropped[]
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
  // Only the fields the mapping reads: the full mammals collection is 18.7 MB.
  const [areaRows, trailRows, otherTrailRows, bigTreeRows, plotRows, herpRows, mammalRows] = await Promise.all([
    fetchCollection(base, 'Protected_Areas', ['id', 'area_name', 'folder_name', 'geom'], fetchImpl),
    fetchCollection(base, 'Trails', ['id', 'trail_name', 'folder_name', 'geom'], fetchImpl),
    fetchCollection(base, 'Other_Trails', ['id', 'area_name', 'folder_name', 'geom'], fetchImpl),
    fetchCollection(base, 'bigtrees', [
      'id', 'Location', 'Tree_Code', 'Site_Name', 'Site_Code', 'Trail_Code', 'Trail_Distance', 'Family', 'Species',
      'Local_Name', 'Height', 'Diameter_at_Breast_Height', 'Aboveground_Biomass', 'CO2', 'Date', 'Project',
    ], fetchImpl),
    fetchCollection(base, 'Tree_Plot_Rect', [
      'id', 'plot_code', 'location', 'site_name', 'site_code', 'trail_code', 'trail_distance', 'plot_size',
      'plot_area', 'date_establishment', 'species', 'basal_area_m2',
    ], fetchImpl),
    fetchCollection(base, 'Herp', ['id', 'site', 'site_code', 'location', 'date', 'survey_method', 'class', 'species'], fetchImpl),
    fetchCollection(base, 'mammals', ['id', 'Site', 'Location', 'Date', 'Species', 'Species_scientific_name', 'Institution'], fetchImpl),
  ])
  const areas = mapProtectedAreas(areaRows)
  const trails = mapTrails([
    { collection: 'Trails', rows: trailRows },
    { collection: 'Other_Trails', rows: otherTrailRows },
  ])
  const bigTrees = mapBigTrees(bigTreeRows)
  const plots = mapTreePlots(plotRows)
  const herps = mapHerps(herpRows)
  const mammals = mapMammals(mammalRows)
  return {
    source: { kind: 'directus', url: base },
    collections: {
      'protected-areas': areas.collection,
      trails: trails.collection,
      'big-trees': bigTrees.collection,
      'tree-plots': plots.collection,
      herps: herps.sites,
      'herp-transects': herps.transects,
      mammals: mammals.sites,
    },
    dropped: [...areas.dropped, ...trails.dropped, ...bigTrees.dropped, ...plots.dropped, ...herps.dropped, ...mammals.dropped],
  }
}
