// Field records from the wi-map Directus (bigtrees, Tree_Plot_Rect, Herp, mammals), mapped
// onto the board's Big Trees, Tree Plots, Herps and Mammals. Like directus-source.ts, this
// is source-specific and goes when the PostGIS reader arrives.
//
// What the source allows, measured on 7 Oct 2026:
// - bigtrees: one row per tree, 33 of 45 with a point.
// - Tree_Plot_Rect: one row per measured stem, each carrying its plot's code and outline
//   (Polygon or Point). Folded into one feature per plot; 8 of 142 plots have no location.
// - Herp: one row per observation. A location is the survey's track or point, shared by
//   every record of that survey, and 43 % of the records have none but name their site.
//   Two tracks lie in Bavaria (test data). Folded into one summary per site, plus the
//   site's tracks as lines.
// - mammals: one row per observation with a WKT point per site (25 of them); 26 % have no
//   location and most of those no site either. Folded per site. The board says the
//   coordinates are to be calculated from transect and distance; until then, sites.
// Rows that cannot be placed are counted and reported, not published.

import {
  bboxOf,
  countryCodeOf,
  toMultiLineString,
  toMultiPolygon,
  toPoint,
  type BigTreeCollection,
  type CountryCode,
  type DatasetId,
  type HerpTransectCollection,
  type MultiLineStringGeometry,
  type MultiPolygonGeometry,
  type NameCount,
  type PointGeometry,
  type Position,
  type ScienceGeometry,
  type SurveySiteCollection,
  type TreePlotCollection,
} from '../../src/threejs-test/science-data-format.ts'

export interface DirectusRow {
  id: string | number
  [field: string]: unknown
}

export interface Dropped {
  dataset: DatasetId
  id: string
  name: string
  reason: string
  /** Set when the entry stands for several records. */
  count?: number
}

/** How many names a summary keeps. */
export const TOP_NAMES = 5

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function nullableText(value: unknown): string | null {
  const t = text(value)
  return t === '' ? null : t
}

/** A finite number, also from a numeric string ("25.0"); else null. */
export function numberOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

/** Like numberOrNull, but 0 counts as "not measured", which is how the source writes it. */
export function measuredOrNull(value: unknown): number | null {
  const n = numberOrNull(value)
  return n === null || n === 0 ? null : n
}

/** "2023-12-16T00:00:00" → "2023-12-16". */
export function dateOnly(value: unknown): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text(value))
  return match ? match[1] : null
}

export function slug(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

class Tally {
  private counts = new Map<string, number>()
  add(name: string | null, by = 1): void {
    if (name) this.counts.set(name, (this.counts.get(name) ?? 0) + by)
  }
  get size(): number {
    return this.counts.size
  }
  top(n = TOP_NAMES): NameCount[] {
    return [...this.counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))
      .slice(0, n)
      .map(([name, count]) => ({ name, count }))
  }
  /** The most frequent name, or null. */
  first(): string | null {
    return this.top(1)[0]?.name ?? null
  }
}

function centreOf(geometry: ScienceGeometry): Position {
  const [w, s, e, n] = bboxOf(geometry)
  return [(w + e) / 2, (s + n) / 2]
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

function compareIds(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true })
}

/**
 * A map's values sorted by key, so the output does not depend on the order the source
 * returns its rows in: a reordered but unchanged source must hash the same.
 */
function inKeyOrder<T>(map: Map<string, T>): T[] {
  return [...map].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(entry => entry[1])
}

// ------------------------------------------------------------------------------ big trees

export function mapBigTrees(rows: DirectusRow[]): { collection: BigTreeCollection; dropped: Dropped[] } {
  const collection: BigTreeCollection = { type: 'FeatureCollection', features: [] }
  const dropped: Dropped[] = []
  for (const row of rows) {
    const tree_id = `bigtrees/${row.id}`
    const name = text(row.Local_Name) || text(row.Species) || text(row.Tree_Code)
    const geometry = toPoint(row.Location)
    if (!geometry) {
      dropped.push({ dataset: 'big-trees', id: tree_id, name, reason: 'no location' })
      continue
    }
    const country_code = countryCodeOf(bboxOf(geometry))
    if (!country_code) {
      dropped.push({ dataset: 'big-trees', id: tree_id, name, reason: 'lies partly or wholly outside Peru and Canada (broken coordinates?)' })
      continue
    }
    collection.features.push({
      type: 'Feature',
      geometry,
      properties: {
        tree_id,
        country_code,
        tree_code: nullableText(row.Tree_Code),
        site_name: nullableText(row.Site_Name),
        site_code: nullableText(row.Site_Code),
        trail_code: nullableText(row.Trail_Code),
        trail_distance_m: numberOrNull(row.Trail_Distance),
        family: nullableText(row.Family),
        species: nullableText(row.Species),
        local_name: nullableText(row.Local_Name),
        height_m: measuredOrNull(row.Height),
        dbh_m: measuredOrNull(row.Diameter_at_Breast_Height),
        aboveground_biomass: measuredOrNull(row.Aboveground_Biomass),
        co2: measuredOrNull(row.CO2),
        measured_on: dateOnly(row.Date),
        project: nullableText(row.Project),
      },
    })
  }
  collection.features.sort((a, b) => compareIds(a.properties.tree_id, b.properties.tree_id))
  return { collection, dropped }
}

// ------------------------------------------------------------------------------ tree plots

export function mapTreePlots(rows: DirectusRow[]): { collection: TreePlotCollection; dropped: Dropped[] } {
  const plots = new Map<string, DirectusRow[]>()
  for (const row of rows) {
    const code = text(row.plot_code)
    if (!code) continue
    const list = plots.get(code)
    if (list) list.push(row)
    else plots.set(code, [row])
  }
  const collection: TreePlotCollection = { type: 'FeatureCollection', features: [] }
  const dropped: Dropped[] = []
  const unnamed = rows.length - [...plots.values()].reduce((sum, list) => sum + list.length, 0)
  if (unnamed > 0) dropped.push({ dataset: 'tree-plots', id: '', name: 'stems', reason: 'no plot code', count: unnamed })

  for (const [plot_id, stems] of plots) {
    // Every stem repeats its plot's outline; a few plots carry several.
    const polygons = new Map<string, MultiPolygonGeometry>()
    let point: PointGeometry | null = null
    for (const stem of stems) {
      const location = stem.location as { type?: string } | null
      if (location?.type === 'Polygon' || location?.type === 'MultiPolygon') {
        const key = JSON.stringify(location)
        if (!polygons.has(key)) {
          const polygon = toMultiPolygon(location)
          if (polygon) polygons.set(key, polygon)
        }
      } else if (!point) {
        point = toPoint(location)
      }
    }
    const geometry: MultiPolygonGeometry | PointGeometry | null = polygons.size > 0
      ? { type: 'MultiPolygon', coordinates: inKeyOrder(polygons).flatMap(p => p.coordinates) }
      : point
    if (!geometry) {
      dropped.push({ dataset: 'tree-plots', id: plot_id, name: plot_id, reason: `no location (${stems.length} stems)` })
      continue
    }
    const country_code = countryCodeOf(bboxOf(geometry))
    if (!country_code) {
      dropped.push({ dataset: 'tree-plots', id: plot_id, name: plot_id, reason: 'lies partly or wholly outside Peru and Canada (broken coordinates?)' })
      continue
    }
    const species = new Tally()
    const sites = new Tally()
    const siteCodes = new Tally()
    const trails = new Tally()
    const sizes = new Tally()
    const trailDistances = new Tally()
    const areas = new Tally()
    let basalArea = 0
    let established: string | null = null
    for (const stem of stems) {
      species.add(nullableText(stem.species))
      sites.add(nullableText(stem.site_name))
      siteCodes.add(nullableText(stem.site_code))
      trails.add(nullableText(stem.trail_code))
      sizes.add(nullableText(stem.plot_size))
      trailDistances.add(numberOrNull(stem.trail_distance)?.toString() ?? null)
      areas.add(numberOrNull(stem.plot_area)?.toString() ?? null)
      basalArea += numberOrNull(stem.basal_area_m2) ?? 0
      const date = dateOnly(stem.date_establishment)
      if (date && (!established || date < established)) established = date
    }
    const trailDistance = trailDistances.first()
    const area = areas.first()
    collection.features.push({
      type: 'Feature',
      geometry,
      properties: {
        plot_id,
        country_code,
        site_name: sites.first(),
        site_code: siteCodes.first(),
        trail_code: trails.first(),
        trail_distance_m: trailDistance === null ? null : Number(trailDistance),
        plot_size: sizes.first(),
        plot_area_ha: area === null ? null : Number(area),
        established_on: established,
        tree_count: stems.length,
        species_count: species.size,
        basal_area_m2: round(basalArea, 4),
        top_species: species.top(),
      },
    })
  }
  collection.features.sort((a, b) => compareIds(a.properties.plot_id, b.properties.plot_id))
  return { collection, dropped }
}

// ------------------------------------------------------------------------------ survey sites

interface SiteRecords {
  name: Tally
  code: string | null
  records: DirectusRow[]
  /** Distinct record locations, by their JSON. */
  locations: Map<string, PointGeometry | MultiLineStringGeometry>
}

function summarise(records: DirectusRow[], fields: { species: (r: DirectusRow) => string | null; klass: (r: DirectusRow) => string | null; method: (r: DirectusRow) => string | null; date: (r: DirectusRow) => string | null }) {
  const species = new Tally()
  const classes = new Tally()
  const methods = new Tally()
  let first: string | null = null
  let last: string | null = null
  for (const record of records) {
    species.add(fields.species(record))
    classes.add(fields.klass(record))
    methods.add(fields.method(record))
    const date = fields.date(record)
    if (date && (!first || date < first)) first = date
    if (date && (!last || date > last)) last = date
  }
  return {
    species_count: species.size,
    top_species: species.top(),
    classes: classes.top(),
    methods: methods.top(),
    first_date: first,
    last_date: last,
  }
}

/** The middle of a site's distinct record locations, each counted once. */
function siteCentre(locations: Iterable<PointGeometry | MultiLineStringGeometry>): PointGeometry {
  let lon = 0
  let lat = 0
  let n = 0
  for (const geometry of locations) {
    const [x, y] = centreOf(geometry)
    lon += x
    lat += y
    n++
  }
  return toPoint({ type: 'Point', coordinates: [lon / n, lat / n] })!
}

export function mapHerps(rows: DirectusRow[]): { sites: SurveySiteCollection; transects: HerpTransectCollection; dropped: Dropped[] } {
  const dropped: Dropped[] = []
  const bySite = new Map<string, SiteRecords>()
  let outside = 0
  let siteless = 0
  for (const row of rows) {
    const code = text(row.site_code)
    const name = text(row.site)
    const key = code || name
    if (!key) { siteless++; continue }
    let location: PointGeometry | MultiLineStringGeometry | null = null
    if (row.location) {
      location = (row.location as { type?: string }).type === 'Point' ? toPoint(row.location) : toMultiLineString(row.location)
      if (location && !countryCodeOf(bboxOf(location))) { outside++; continue }
    }
    const site: SiteRecords = bySite.get(key) ?? { name: new Tally(), code: code || null, records: [], locations: new Map() }
    site.name.add(name || null)
    site.records.push(row)
    if (location) site.locations.set(JSON.stringify(location), location)
    bySite.set(key, site)
  }
  if (outside > 0) dropped.push({ dataset: 'herps', id: '', name: 'records', reason: 'location outside Peru and Canada', count: outside })
  if (siteless > 0) dropped.push({ dataset: 'herps', id: '', name: 'records', reason: 'no site', count: siteless })

  const sites: SurveySiteCollection = { type: 'FeatureCollection', features: [] }
  const transects: HerpTransectCollection = { type: 'FeatureCollection', features: [] }
  for (const [site_id, site] of bySite) {
    const site_name = site.name.first() ?? site_id
    if (site.locations.size === 0) {
      dropped.push({ dataset: 'herps', id: site_id, name: site_name, reason: 'site without any located record', count: site.records.length })
      continue
    }
    const located = inKeyOrder(site.locations)
    const geometry = siteCentre(located)
    const country_code = countryCodeOf(bboxOf(geometry)) as CountryCode
    sites.features.push({
      type: 'Feature',
      geometry,
      properties: {
        site_id,
        country_code,
        site_name,
        site_code: site.code,
        record_count: site.records.length,
        ...summarise(site.records, {
          species: r => nullableText(r.species),
          klass: r => nullableText(r.class),
          method: r => nullableText(r.survey_method),
          date: r => dateOnly(r.date),
        }),
      },
    })
    const lines = located.filter((g): g is MultiLineStringGeometry => g.type === 'MultiLineString')
    if (lines.length > 0) {
      transects.features.push({
        type: 'Feature',
        geometry: { type: 'MultiLineString', coordinates: lines.flatMap(l => l.coordinates) },
        properties: { site_id, country_code, site_name, track_count: lines.length },
      })
    }
  }
  sites.features.sort((a, b) => compareIds(a.properties.site_id, b.properties.site_id))
  transects.features.sort((a, b) => compareIds(a.properties.site_id, b.properties.site_id))
  return { sites, transects, dropped }
}

export function mapMammals(rows: DirectusRow[]): { sites: SurveySiteCollection; dropped: Dropped[] } {
  const dropped: Dropped[] = []
  // A site name points at the location most of its records carry.
  const locationsBySite = new Map<string, Tally>()
  for (const row of rows) {
    const site = text(row.Site)
    if (site && toPoint(row.Location)) {
      const tally = locationsBySite.get(site) ?? new Tally()
      tally.add(text(row.Location))
      locationsBySite.set(site, tally)
    }
  }
  const byLocation = new Map<string, { point: PointGeometry; records: DirectusRow[]; names: Tally }>()
  let unplaced = 0
  let outside = 0
  for (const row of rows) {
    const site = text(row.Site)
    let wkt = toPoint(row.Location) ? text(row.Location) : null
    // Records without a location of their own take their site's.
    if (!wkt && site) wkt = locationsBySite.get(site)?.first() ?? null
    if (!wkt) { unplaced++; continue }
    let group = byLocation.get(wkt)
    if (!group) {
      const point = toPoint(wkt)!
      if (!countryCodeOf(bboxOf(point))) { outside++; continue }
      group = { point, records: [], names: new Tally() }
      byLocation.set(wkt, group)
    }
    group.records.push(row)
    group.names.add(site || null)
  }
  if (unplaced > 0) dropped.push({ dataset: 'mammals', id: '', name: 'records', reason: 'no location and no located site', count: unplaced })
  if (outside > 0) dropped.push({ dataset: 'mammals', id: '', name: 'records', reason: 'location outside Peru and Canada', count: outside })

  const sites: SurveySiteCollection = { type: 'FeatureCollection', features: [] }
  const used = new Set<string>()
  for (const group of inKeyOrder(byLocation)) {
    const site_name = group.names.first() ?? 'Unnamed site'
    let site_id = slug(site_name) || 'site'
    for (let k = 2; used.has(site_id); k++) site_id = `${slug(site_name)}-${k}`
    used.add(site_id)
    sites.features.push({
      type: 'Feature',
      geometry: group.point,
      properties: {
        site_id,
        country_code: countryCodeOf(bboxOf(group.point)) as CountryCode,
        site_name,
        site_code: null,
        record_count: group.records.length,
        ...summarise(group.records, {
          species: r => nullableText(r.Species_scientific_name) ?? nullableText(r.Species),
          klass: () => null,
          method: r => nullableText(r.Institution),
          date: r => dateOnly(r.Date),
        }),
      },
    })
  }
  sites.features.sort((a, b) => compareIds(a.properties.site_id, b.properties.site_id))
  return { sites, dropped }
}
