// What a science marker says: the chip next to its dot and the card it opens. Pure, so the
// wording is node-tested (science-markers.test.ts). The DOM side is science-marker-layer.ts.
//
// Big trees leave out above-ground biomass and CO2: the source does not state their unit,
// and a card with a wrong unit would be worse than none.

import { largestRingCentre } from './science-geometry.ts'
import type { BigTreeCollection, NameCount, SurveySiteCollection, TreePlotCollection } from './science-data-format.ts'

export interface ScienceCardContent {
  title: string
  subtitle: string | null
  rows: Array<[string, string]>
  list: { heading: string; items: string[] } | null
}

export interface ScienceMarker {
  id: string
  lon: number
  lat: number
  /** The chip next to the dot. */
  label: string
  card: ScienceCardContent
}

const formatters = new Map<number, Intl.NumberFormat>()

export function formatNumber(value: number, digits = 0): string {
  let formatter = formatters.get(digits)
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits })
    formatters.set(digits, formatter)
  }
  return formatter.format(value)
}

/** "1997–2019", "2019", or null. */
export function yearSpan(first: string | null, last: string | null): string | null {
  const a = first?.slice(0, 4) ?? null
  const b = last?.slice(0, 4) ?? null
  if (!a || !b) return a ?? b
  return a === b ? a : `${a}–${b}`
}

function trail(code: string | null, distanceM: number | null): string | null {
  if (!code) return null
  return distanceM === null ? code : `${code} at ${formatNumber(distanceM)} m`
}

function rows(entries: Array<[string, string | null]>): Array<[string, string]> {
  return entries.filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '')
}

function counted(items: NameCount[]): string[] {
  return items.map(item => `${item.name} · ${formatNumber(item.count)}`)
}

export function bigTreeMarkers(collection: BigTreeCollection): ScienceMarker[] {
  return collection.features.map((feature) => {
    const p = feature.properties
    const name = p.local_name ?? p.species ?? p.tree_code ?? 'Big tree'
    const height = p.height_m === null ? null : `${formatNumber(p.height_m, 1)} m`
    const subtitle = [p.species !== name ? p.species : null, p.family].filter(Boolean).join(' · ')
    return {
      id: p.tree_id,
      lon: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1],
      label: height ? `${name} · ${height}` : name,
      card: {
        title: name,
        subtitle: subtitle || null,
        rows: rows([
          ['Height', height],
          ['Diameter at breast height', p.dbh_m === null ? null : `${formatNumber(p.dbh_m * 100)} cm`],
          ['Site', p.site_name],
          ['Trail', trail(p.trail_code, p.trail_distance_m)],
          ['Tree code', p.tree_code],
          ['Measured', p.measured_on],
          ['Project', p.project],
        ]),
        list: null,
      },
    }
  })
}

export function treePlotMarkers(collection: TreePlotCollection): ScienceMarker[] {
  return collection.features.map((feature) => {
    const p = feature.properties
    const [lon, lat] = feature.geometry.type === 'Point'
      ? feature.geometry.coordinates
      : largestRingCentre(feature.geometry.coordinates)
    return {
      id: p.plot_id,
      lon,
      lat,
      label: p.plot_id,
      card: {
        title: `Plot ${p.plot_id}`,
        subtitle: p.site_name,
        rows: rows([
          ['Size', p.plot_size],
          ['Area', p.plot_area_ha === null ? null : `${formatNumber(p.plot_area_ha, 2)} ha`],
          ['Stems measured', formatNumber(p.tree_count)],
          ['Species', formatNumber(p.species_count)],
          ['Basal area', `${formatNumber(p.basal_area_m2, 2)} m²`],
          ['Trail', trail(p.trail_code, p.trail_distance_m)],
          ['Established', p.established_on],
        ]),
        list: p.top_species.length > 0 ? { heading: 'Most frequent species', items: counted(p.top_species) } : null,
      },
    }
  })
}

export function surveySiteMarkers(collection: SurveySiteCollection, kind: 'herps' | 'mammals'): ScienceMarker[] {
  return collection.features.map((feature) => {
    const p = feature.properties
    return {
      id: p.site_id,
      lon: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1],
      label: `${p.site_name} · ${formatNumber(p.record_count)}`,
      card: {
        title: p.site_name,
        subtitle: kind === 'herps' ? 'Amphibian and reptile surveys' : 'Mammal surveys',
        rows: rows([
          ['Records', formatNumber(p.record_count)],
          ['Species', formatNumber(p.species_count)],
          ...p.classes.map((c): [string, string] => [c.name, formatNumber(c.count)]),
          ['Surveyed', yearSpan(p.first_date, p.last_date)],
          [kind === 'herps' ? 'Methods' : 'Recorded by', p.methods.slice(0, 3).map(m => m.name).join(', ') || null],
        ]),
        list: p.top_species.length > 0 ? { heading: 'Most recorded species', items: counted(p.top_species) } : null,
      },
    }
  })
}
