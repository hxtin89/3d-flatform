import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dateOnly, mapBigTrees, mapHerps, mapMammals, mapTreePlots, measuredOrNull, slug } from './directus-records.ts'
import { validateCollection } from '../../src/threejs-test/science-data-format.ts'

const sfoPoint = { type: 'Point', coordinates: [-69.4927, -12.8611] }
const plotRect = { type: 'Polygon', coordinates: [[[-69.4935, -12.8614], [-69.4930, -12.8614], [-69.4930, -12.8610], [-69.4935, -12.8610], [-69.4935, -12.8614]]] }
const track = { type: 'LineString', coordinates: [[-69.490, -12.860], [-69.489, -12.861]] }
const bavaria = { type: 'LineString', coordinates: [[12.4246, 48.1873], [12.4247, 48.1874]] }

test('small helpers read the source the way it writes', () => {
  assert.equal(dateOnly('2023-12-16T00:00:00'), '2023-12-16')
  assert.equal(dateOnly(null), null)
  assert.equal(measuredOrNull(0), null)
  assert.equal(measuredOrNull('25.0'), 25)
  assert.equal(slug('Tambopata Research Center'), 'tambopata-research-center')
  assert.equal(slug('Cañaveral'), 'canaveral')
})

test('big trees keep their measurements; 0 means not measured; no location is dropped', () => {
  const { collection, dropped } = mapBigTrees([
    { id: 2, Location: sfoPoint, Local_Name: 'Shihuahuaco', Species: 'Dipteryx sp.', Height: 34.45, Diameter_at_Breast_Height: 1.4, CO2: 0, Date: '2023-12-16T00:00:00', Site_Code: 'SFO' },
    { id: 1, Location: null, Local_Name: 'Castaña' },
  ])
  assert.equal(collection.features.length, 1)
  const tree = collection.features[0].properties
  assert.equal(tree.tree_id, 'bigtrees/2')
  assert.equal(tree.country_code, 'PE')
  assert.equal(tree.height_m, 34.45)
  assert.equal(tree.co2, null)
  assert.equal(tree.measured_on, '2023-12-16')
  assert.deepEqual(dropped.map(d => [d.id, d.reason]), [['bigtrees/1', 'no location']])
  assert.deepEqual(validateCollection('big-trees', collection), [])
})

test('stems fold into their plot: outline once, counts, top species, earliest date', () => {
  const stem = (species: string, date: string) => ({ id: Math.random(), plot_code: 'SFO-BKT-250', location: plotRect, species, basal_area_m2: 0.1, date_establishment: date, site_code: 'SFO', plot_area: 0.05, trail_distance: 250 })
  const { collection, dropped } = mapTreePlots([
    stem('Virola calophylla', '2019-04-23T12:00:00'),
    stem('Virola calophylla', '2019-04-22T12:00:00'),
    stem('Ecclinusa guianensis', '2019-04-23T12:00:00'),
    { id: 9, plot_code: 'SFO Farmacia Secreta 1', location: null, species: 'X' },
    { id: 10, plot_code: 'TNS-1', location: { type: 'Point', coordinates: [-69.50, -12.84] }, species: 'Y', basal_area_m2: 0.2 },
  ])
  assert.deepEqual(collection.features.map(f => [f.properties.plot_id, f.geometry.type]), [['SFO-BKT-250', 'MultiPolygon'], ['TNS-1', 'Point']])
  const plot = collection.features[0]
  assert.equal(plot.geometry.type === 'MultiPolygon' && plot.geometry.coordinates.length, 1)
  assert.equal(plot.properties.tree_count, 3)
  assert.equal(plot.properties.species_count, 2)
  assert.deepEqual(plot.properties.top_species[0], { name: 'Virola calophylla', count: 2 })
  assert.equal(plot.properties.basal_area_m2, 0.3)
  assert.equal(plot.properties.established_on, '2019-04-22')
  assert.equal(plot.properties.trail_distance_m, 250)
  assert.equal(dropped[0].id, 'SFO Farmacia Secreta 1')
  assert.deepEqual(validateCollection('tree-plots', collection), [])
})

test('herps fold per site: centre of its tracks, every record counted, tracks kept as lines', () => {
  const { sites, transects, dropped } = mapHerps([
    { id: 1, site: 'Secret Forest', site_code: 'SFO', location: track, class: 'Amphibia', species: 'Pristimantis reichlei', survey_method: 'Plot Transect', date: '2020-02-19T12:00:00' },
    { id: 2, site: 'Secret Forest', site_code: 'SFO', location: track, class: 'Reptilia', species: 'Helicops angulatus', survey_method: 'Pitfall', date: '2021-06-02T12:00:00' },
    { id: 3, site: 'Secret Forest', site_code: 'SFO', location: null, class: 'Amphibia', species: 'Pristimantis reichlei', date: '2019-01-01T12:00:00' },
    { id: 4, site: 'Secret Forest', site_code: 'SFO', location: bavaria, species: 'Test' },
    { id: 5, site: 'El Gato', site_code: 'BAL', location: null, species: 'Z' },
  ])
  assert.equal(sites.features.length, 1)
  const sfo = sites.features[0]
  assert.deepEqual(sfo.geometry.coordinates, [-69.4895, -12.8605])
  assert.equal(sfo.properties.record_count, 3)
  assert.equal(sfo.properties.species_count, 2)
  assert.deepEqual(sfo.properties.classes, [{ name: 'Amphibia', count: 2 }, { name: 'Reptilia', count: 1 }])
  assert.equal(sfo.properties.first_date, '2019-01-01')
  assert.equal(sfo.properties.last_date, '2021-06-02')
  assert.deepEqual(transects.features.map(f => [f.properties.site_id, f.properties.track_count]), [['SFO', 1]])
  assert.deepEqual(dropped.map(d => [d.reason, d.count]), [['location outside Peru and Canada', 1], ['site without any located record', 1]])
  assert.deepEqual(validateCollection('herps', sites), [])
  assert.deepEqual(validateCollection('herp-transects', transects), [])
})

test('mammals fold per site point; records without a location take their site’s', () => {
  const wkt = 'POINT(-69.48952795043863 -12.861245737406499)'
  const { sites, dropped } = mapMammals([
    { id: 1, Site: 'Secret Forest Research Station', Location: wkt, Species_scientific_name: 'Saguinus fuscicollis', Institution: 'FF', Date: '1997-04-30T00:00:00' },
    { id: 2, Site: 'Secret Forest Research Station', Location: null, Species: 'DVAR', Institution: 'FF' },
    { id: 3, Site: null, Location: null, Species: 'SMAC' },
    { id: 4, Site: 'Los Amigos Research Station', Location: null, Species: 'SMAC' },
  ])
  assert.equal(sites.features.length, 1)
  const site = sites.features[0].properties
  assert.equal(site.site_id, 'secret-forest-research-station')
  assert.equal(site.record_count, 2)
  assert.deepEqual(site.top_species.map(s => s.name).sort(), ['DVAR', 'Saguinus fuscicollis'])
  assert.deepEqual(site.methods, [{ name: 'FF', count: 2 }])
  assert.deepEqual(dropped.map(d => d.count), [2])
  assert.deepEqual(validateCollection('mammals', sites), [])
})
