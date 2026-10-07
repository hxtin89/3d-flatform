import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bigTreeMarkers, formatNumber, surveySiteMarkers, treePlotMarkers, yearSpan } from './science-markers.ts'
import type { BigTreeCollection, SurveySiteCollection, TreePlotCollection } from './science-data-format.ts'

test('numbers and periods read naturally', () => {
  assert.equal(formatNumber(3605), '3,605')
  assert.equal(formatNumber(34.45, 1), '34.5')
  assert.equal(yearSpan('1997-04-30', '2019-11-02'), '1997–2019')
  assert.equal(yearSpan('2019-01-01', '2019-06-01'), '2019')
  assert.equal(yearSpan(null, '2019-06-01'), '2019')
  assert.equal(yearSpan(null, null), null)
})

test('a big tree is named by its local name, sized in m and cm, without unmeasured rows', () => {
  const trees: BigTreeCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-69.4927, -12.8611] },
      properties: {
        tree_id: 'bigtrees/2', country_code: 'PE', tree_code: 'AG EVER01', site_name: 'Secret Forest', site_code: 'SFO',
        trail_code: 'EVER', trail_distance_m: 25, family: 'Fabaceae', species: 'Dipteryx sp.', local_name: 'Shihuahuaco',
        height_m: 34.45, dbh_m: 1.4, aboveground_biomass: 1.922, co2: 3.52, measured_on: '2023-12-16', project: null,
      },
    }],
  }
  const [marker] = bigTreeMarkers(trees)
  assert.equal(marker.label, 'Shihuahuaco · 34.5 m')
  assert.equal(marker.card.subtitle, 'Dipteryx sp. · Fabaceae')
  assert.deepEqual(marker.card.rows, [
    ['Height', '34.5 m'],
    ['Diameter at breast height', '140 cm'],
    ['Site', 'Secret Forest'],
    ['Trail', 'EVER at 25 m'],
    ['Tree code', 'AG EVER01'],
    ['Measured', '2023-12-16'],
  ])
  assert.ok(!marker.card.rows.some(([key]) => /biomass|CO/.test(key)))
})

test('a plot marker sits in its outline and lists its most frequent species', () => {
  const plots: TreePlotCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: [[[[-69.4935, -12.8614], [-69.4925, -12.8614], [-69.4925, -12.8604], [-69.4935, -12.8604], [-69.4935, -12.8614]]]] },
      properties: {
        plot_id: 'SFO-BKT-250', country_code: 'PE', site_name: 'Secret Forest', site_code: 'SFO', trail_code: 'BKT',
        trail_distance_m: 250, plot_size: '10m x 50m', plot_area_ha: 0.05, established_on: '2019-04-22',
        tree_count: 31, species_count: 22, basal_area_m2: 1.2345, top_species: [{ name: 'Virola calophylla', count: 4 }],
      },
    }],
  }
  const [marker] = treePlotMarkers(plots)
  assert.ok(Math.abs(marker.lon - -69.493) < 1e-6 && Math.abs(marker.lat - -12.8609) < 1e-6)
  assert.equal(marker.card.title, 'Plot SFO-BKT-250')
  assert.deepEqual(marker.card.rows.find(([key]) => key === 'Basal area'), ['Basal area', '1.23 m²'])
  assert.deepEqual(marker.card.list, { heading: 'Most frequent species', items: ['Virola calophylla · 4'] })
})

test('a survey site shows its records, classes, period and methods', () => {
  const sites: SurveySiteCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-69.4895, -12.8605] },
      properties: {
        site_id: 'SFO', country_code: 'PE', site_name: 'Secret Forest', site_code: 'SFO', record_count: 3605,
        species_count: 120, top_species: [{ name: 'Pristimantis reichlei', count: 410 }],
        classes: [{ name: 'Amphibia', count: 2900 }, { name: 'Reptilia', count: 705 }],
        methods: [{ name: 'Plot Transect', count: 2000 }, { name: 'Pitfall', count: 900 }],
        first_date: '2018-02-01', last_date: '2024-07-30',
      },
    }],
  }
  const [marker] = surveySiteMarkers(sites, 'herps')
  assert.equal(marker.label, 'Secret Forest · 3,605')
  assert.deepEqual(marker.card.rows, [
    ['Records', '3,605'], ['Species', '120'], ['Amphibia', '2,900'], ['Reptilia', '705'],
    ['Surveyed', '2018–2024'], ['Methods', 'Plot Transect, Pitfall'],
  ])
  assert.equal(surveySiteMarkers(sites, 'mammals')[0].card.subtitle, 'Mammal surveys')
})
