import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  approxDistanceM,
  areaLabelAnchors,
  clusterByDistance,
  displayName,
  pathMidpoint,
  trailLabelAnchors,
} from './science-geometry.ts'
import type { Position, ProtectedAreaCollection, TrailCollection } from './science-data-format.ts'

test('source names read as words', () => {
  assert.equal(displayName('Bootkiller_Trail'), 'Bootkiller Trail')
  assert.equal(displayName(' Paca_Trail_(PT) '), 'Paca Trail (PT)')
  assert.equal(displayName('009-897-747 + 006-632-173 hummingbird-land'), '009-897-747 + 006-632-173 hummingbird-land')
})

test('distances are in metres', () => {
  // 0.01° of latitude is about 1112 m everywhere.
  assert.ok(Math.abs(approxDistanceM([-69.49, -12.86], [-69.49, -12.85]) - 1112) < 2)
  // 0.01° of longitude shrinks with the cosine of the latitude.
  assert.ok(Math.abs(approxDistanceM([-125.08, 50.26], [-125.07, 50.26]) - 711) < 2)
})

test('the midpoint is halfway by length, not by vertex count', () => {
  const path: Position[] = [[0, 0], [0, 0.001], [0, 0.002], [0, 0.01]]
  const [lon, lat] = pathMidpoint(path)
  assert.equal(lon, 0)
  assert.ok(Math.abs(lat - 0.005) < 1e-9)
})

test('one trail label per name, on its longest piece', () => {
  const trails: TrailCollection = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[-69.5, -12.86], [-69.5, -12.861]]] }, properties: { trail_id: 'trails/1', country_code: 'PE', trail_name: 'SFO_trails1', folder_name: null } },
      { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[-69.4, -12.86], [-69.4, -12.88]]] }, properties: { trail_id: 'trails/2', country_code: 'PE', trail_name: 'SFO_trails1', folder_name: null } },
      { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[-69.6, -12.9], [-69.61, -12.9]]] }, properties: { trail_id: 'trails/3', country_code: 'PE', trail_name: 'Jaguar_Trail', folder_name: null } },
    ],
  }
  const anchors = trailLabelAnchors(trails)
  assert.deepEqual(anchors.map(a => a.text), ['SFO trails1', 'Jaguar Trail'])
  assert.equal(anchors[0].lon, -69.4)
  assert.ok(Math.abs(anchors[0].lat - -12.87) < 1e-9)
})

test('an area label sits at the centroid of its largest ring', () => {
  const small: Position[] = [[-69.50, -12.86], [-69.499, -12.86], [-69.499, -12.859], [-69.50, -12.86]]
  const big: Position[] = [[-69.48, -12.88], [-69.46, -12.88], [-69.46, -12.86], [-69.48, -12.86], [-69.48, -12.88]]
  const areas: ProtectedAreaCollection = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[small], [big]] }, properties: { area_id: 'a', country_code: 'PE', area_name: 'Secret_Forest', folder_name: null } }],
  }
  const [anchor] = areaLabelAnchors(areas)
  assert.equal(anchor.text, 'Secret Forest')
  assert.ok(Math.abs(anchor.lon - -69.47) < 1e-6)
  assert.ok(Math.abs(anchor.lat - -12.87) < 1e-6)
})

test('far-apart features never share a draw call', () => {
  const sfo: Position = [-69.49, -12.86]
  const nearSfo: Position = [-69.30, -12.86] // ~21 km east
  const pantiacolla: Position = [-71.23, -12.6] // ~190 km west
  const readIsland: Position = [-125.08, 50.26]
  const clusters = clusterByDistance([sfo, nearSfo, pantiacolla, readIsland], p => p, 100_000)
  assert.deepEqual(clusters, [[sfo, nearSfo], [pantiacolla], [readIsland]])
})
