import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  countryCodeOf,
  nextEntry,
  referencedFiles,
  shrinkProblem,
  toMultiLineString,
  toMultiPolygon,
  validateCollection,
  type DatasetEntry,
  type ProtectedAreaCollection,
  type ScienceIndex,
  type TrailCollection,
} from './science-data-format.ts'

// A small square near the SFO station in Madre de Dios, Peru.
const peruRing = [[-69.49, -12.86], [-69.48, -12.86], [-69.48, -12.85], [-69.49, -12.85], [-69.49, -12.86]]

function area(id: string, ring = peruRing, country: 'PE' | 'CA' = 'PE'): ProtectedAreaCollection['features'][number] {
  return {
    type: 'Feature',
    geometry: toMultiPolygon({ type: 'Polygon', coordinates: [ring] })!,
    properties: { area_id: id, country_code: country, area_name: `Area ${id}`, folder_name: null },
  }
}

test('Polygon and MultiPolygon both become a MultiPolygon, rounded to 7 decimals', () => {
  const single = toMultiPolygon({ type: 'Polygon', coordinates: [[[-69.123456789, -12.1], [-69.2, -12.1], [-69.2, -12.2], [-69.123456789, -12.1]]] })
  assert.equal(single?.type, 'MultiPolygon')
  assert.deepEqual(single?.coordinates[0][0][0], [-69.1234568, -12.1])
  const multi = toMultiPolygon({ type: 'MultiPolygon', coordinates: [[peruRing], [peruRing]] })
  assert.equal(multi?.coordinates.length, 2)
})

test('an open ring is closed, a degenerate one dropped, heights ignored', () => {
  const open = toMultiPolygon({ type: 'Polygon', coordinates: [[[-69.49, -12.86, 210], [-69.48, -12.86, 211], [-69.48, -12.85, 212]]] })
  const ring = open!.coordinates[0][0]
  assert.deepEqual(ring[0], ring[ring.length - 1])
  assert.equal(ring[0].length, 2)
  assert.equal(toMultiPolygon({ type: 'Polygon', coordinates: [[[-69.49, -12.86], [-69.48, -12.86]]] }), null)
  assert.equal(toMultiPolygon(null), null)
})

test('lines keep their order, lose repeated points, and points are not lines', () => {
  const line = toMultiLineString({ type: 'LineString', coordinates: [[-69.49, -12.86], [-69.49, -12.86], [-69.48, -12.85]] })
  assert.deepEqual(line?.coordinates, [[[-69.49, -12.86], [-69.48, -12.85]]])
  assert.equal(toMultiLineString({ type: 'Point', coordinates: [-69.49, -12.86] }), null)
  assert.equal(toMultiLineString({ type: 'LineString', coordinates: [[-69.49, -12.86], [-69.49, -12.86]] }), null)
})

test('the country comes from where a feature lies', () => {
  assert.equal(countryCodeOf([-69.5, -12.9, -69.4, -12.8]), 'PE')
  assert.equal(countryCodeOf([-125.1, 50.2, -125.0, 50.3]), 'CA')
  assert.equal(countryCodeOf([13.4, 52.5, 13.5, 52.6]), null)
  // UTM metres read as degrees fall outside both.
  assert.equal(countryCodeOf([350000, 5560000, 351000, 5561000]), null)
})

test('a clean collection passes', () => {
  const collection: ProtectedAreaCollection = { type: 'FeatureCollection', features: [area('a'), area('b')] }
  assert.deepEqual(validateCollection('protected-areas', collection), [])
})

test('duplicate IDs, missing names, wrong countries and wrong types are refused', () => {
  const duplicate = area('a')
  const nameless = area('c')
  nameless.properties.area_name = ' '
  const wrongCountry = area('d', peruRing, 'CA')
  const collection: ProtectedAreaCollection = { type: 'FeatureCollection', features: [area('a'), duplicate, nameless, wrongCountry] }
  const problems = validateCollection('protected-areas', collection)
  assert.ok(problems.some(p => p.includes('duplicate area_id')))
  assert.ok(problems.some(p => p.includes('missing area_name')))
  assert.ok(problems.some(p => p.includes('country_code CA, but it lies in PE')))

  const trails = { type: 'FeatureCollection', features: [area('x')] } as unknown as TrailCollection
  assert.ok(validateCollection('trails', trails).some(p => p.includes('geometry is MultiPolygon, expected MultiLineString')))
  assert.deepEqual(validateCollection('trails', { type: 'FeatureCollection', features: [] }), ['trails: no features'])
})

test('projected coordinates are refused, not mistaken for a country', () => {
  const utm = area('u')
  utm.geometry.coordinates[0][0] = [[350000, 5560000], [351000, 5560000], [351000, 5561000], [350000, 5560000]]
  const problems = validateCollection('protected-areas', { type: 'FeatureCollection', features: [utm] })
  assert.ok(problems[0].includes('outside WGS84'))
})

test('a run that loses more than a fifth of a dataset is refused', () => {
  assert.equal(shrinkProblem('trails', undefined, 3), null)
  assert.equal(shrinkProblem('trails', 111, 100), null)
  assert.match(shrinkProblem('protected-areas', 51, 3) ?? '', /3 features, 51 before \(94 % fewer\)/)
})

test('an unchanged version keeps its entry, a new one pushes the old into history', () => {
  const next = { file: 'trails.1111111111111111.json', version: '1111111111111111', featureCount: 2, bytes: 10, bbox: [0, 0, 1, 1] as [number, number, number, number] }
  const first = nextEntry(undefined, next, '2026-10-07T00:00:00.000Z')
  assert.deepEqual(first.history, [])
  assert.equal(nextEntry(first, next, '2026-10-08T00:00:00.000Z'), first)

  let entry: DatasetEntry = first
  for (let i = 2; i <= 6; i++) {
    const version = String(i).repeat(16)
    entry = nextEntry(entry, { ...next, version, file: `trails.${version}.json` }, `2026-10-0${i + 6}T00:00:00.000Z`)
  }
  assert.equal(entry.version, '6666666666666666')
  assert.deepEqual(entry.history.map(h => h.version), ['5555555555555555', '4444444444444444', '3333333333333333'])

  const index: ScienceIndex = { format: 1, generatedAt: '', source: { kind: 'test', url: '' }, datasets: { trails: entry } }
  assert.deepEqual([...referencedFiles(index)].sort(), [
    'trails.3333333333333333.json', 'trails.4444444444444444.json', 'trails.5555555555555555.json', 'trails.6666666666666666.json',
  ])
})
