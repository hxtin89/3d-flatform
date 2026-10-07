import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapProtectedAreas, mapTrails, readDirectus } from './directus-source.ts'
import { validateCollection } from '../../src/threejs-test/science-data-format.ts'

const peruSquare = { type: 'Polygon', coordinates: [[[-69.49, -12.86], [-69.48, -12.86], [-69.48, -12.85], [-69.49, -12.86]]] }
const canadaSquare = { type: 'MultiPolygon', coordinates: [[[[-125.08, 50.26], [-125.07, 50.26], [-125.07, 50.25], [-125.08, 50.26]]]] }
const peruLine = { type: 'LineString', coordinates: [[-69.488, -12.859], [-69.489, -12.858]] }

test('areas get board names, a country from their location, and are sorted by ID', () => {
  const { collection, dropped } = mapProtectedAreas([
    { id: 'b-uuid', area_name: ' Secret Forest 3 ', folder_name: 'Secret Forest 250902', geom: peruSquare },
    { id: 'a-uuid', area_name: 'Read Island', folder_name: '', geom: canadaSquare },
    { id: 'c-uuid', area_name: 'C1903 Read Island ESPG32609', folder_name: 'Misty Forest', geom: null },
  ])
  assert.deepEqual(collection.features.map(f => f.properties), [
    { area_id: 'a-uuid', country_code: 'CA', area_name: 'Read Island', folder_name: null },
    { area_id: 'b-uuid', country_code: 'PE', area_name: 'Secret Forest 3', folder_name: 'Secret Forest 250902' },
  ])
  assert.deepEqual(dropped, [{ dataset: 'protected-areas', id: 'c-uuid', name: 'C1903 Read Island ESPG32609', reason: 'no geometry, no drawable polygon' }])
  assert.deepEqual(validateCollection('protected-areas', collection), [])
})

test('trail IDs carry their collection, so equal row numbers do not collide', () => {
  const { collection, dropped } = mapTrails([
    { collection: 'Trails', rows: [{ id: 1, trail_name: 'Bootkiller_Trail', folder_name: 'SFO GIS ƒ', geom: peruLine }] },
    { collection: 'Other_Trails', rows: [
      { id: 1, area_name: 'Collpa_Trail', folder_name: 'More_map_stuff', geom: peruLine },
      { id: 2, area_name: 'MAL_IBAA_CTL_points', folder_name: 'More_map_stuff', geom: { type: 'Point', coordinates: [-69.5, -12.9] } },
    ] },
  ])
  assert.deepEqual(collection.features.map(f => [f.properties.trail_id, f.properties.trail_name]), [
    ['other-trails/1', 'Collpa_Trail'],
    ['trails/1', 'Bootkiller_Trail'],
  ])
  assert.equal(collection.features[0].geometry.type, 'MultiLineString')
  assert.deepEqual(dropped.map(d => [d.id, d.reason]), [['other-trails/2', 'Point, not a line']])
  assert.deepEqual(validateCollection('trails', collection), [])
})

test('the reader asks Directus for exactly the three collections and fails loudly', async () => {
  const asked: string[] = []
  const fakeFetch = (async (url: string) => {
    asked.push(url)
    const rows = url.includes('Protected_Areas') ? [{ id: 'a', area_name: 'A', geom: peruSquare }] : [{ id: 1, trail_name: 'T', area_name: 'T', geom: peruLine }]
    return new Response(JSON.stringify({ data: rows }), { status: 200 })
  }) as typeof fetch
  const result = await readDirectus('https://example.test/', fakeFetch)
  assert.deepEqual(asked.map(u => new URL(u).pathname), ['/items/Protected_Areas', '/items/Trails', '/items/Other_Trails'])
  assert.equal(result.source.url, 'https://example.test')
  assert.equal(result.collections.trails.features.length, 2)

  const refusing = (async () => new Response('{"errors":[]}', { status: 403 })) as unknown as typeof fetch
  await assert.rejects(readDirectus('https://example.test', refusing), /HTTP 403/)
})
