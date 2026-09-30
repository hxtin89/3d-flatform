import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createPlanner, decodeKinds, parseSatelliteZxy, serverTileRange, type OrthoMeta, type OrthoSourceMeta,
} from './ortho-plan.ts'

// Secret Forest's TileJSON bounds, and the tiles probed against the live server: the first
// came back 400 "Out of bounds", its east neighbour 200.
const SECRET_FOREST: [number, number, number, number] = [-69.51776, -12.89762, -69.43215, -12.82408]

test('serverTileRange matches what the server answers', () => {
  const r18 = serverTileRange(SECRET_FOREST, 18)
  assert.ok(80449 < r18.x0, 'z18 x 80449 is out of bounds')
  assert.ok(80450 >= r18.x0 && 80450 <= r18.x1, 'z18 x 80450 is served')
  assert.ok(140515 >= r18.y0 && 140515 <= r18.y1)
  assert.ok(r18.y0 <= r18.y1 && r18.x0 <= r18.x1)
})

test('parseSatelliteZxy reads dev and production URLs and nothing else', () => {
  assert.deepEqual(parseSatelliteZxy('/maptiler/maps/satellite-v4/19/160935/281067.jpg?key=abc'), { z: 19, x: 160935, y: 281067 })
  assert.deepEqual(parseSatelliteZxy('https://api.maptiler.com/maps/satellite-v4/5/9/17.jpg?key=abc'), { z: 5, x: 9, y: 17 })
  assert.equal(parseSatelliteZxy('https://api.maptiler.com/tiles/29a110a3/18/80450/140515.webp?key=abc'), null)
  assert.equal(parseSatelliteZxy('/maptiler/maps/satellite-v4/tiles.json'), null)
})

test('decodeKinds unpacks 2 bits per tile, row-major, low bits first', () => {
  // kinds 0,1,2,3 | 3,2,1,0 on a 4x2 grid
  const bytes = Uint8Array.from([0b11100100, 0b00011011])
  const bits = btoa(String.fromCharCode(...bytes))
  const kind = decodeKinds({ 10: { x0: 100, y0: 200, w: 4, h: 2, bits } })
  assert.deepEqual([0, 1, 2, 3].map((i) => kind(10, 100 + i, 200)), [0, 1, 2, 3])
  assert.deepEqual([0, 1, 2, 3].map((i) => kind(10, 100 + i, 201)), [3, 2, 1, 0])
  assert.equal(kind(10, 99, 200), 0, 'outside the grid')
  assert.equal(kind(11, 100, 200), 0, 'zoom without a grid')
})

const meta = JSON.parse(readFileSync(new URL('../../public/colour-field/peru-b2-globe.json', import.meta.url), 'utf8'))
const ortho: OrthoMeta | undefined = meta.ortho

test('the committed kind grids agree with their own counts and the server range', { skip: !ortho }, () => {
  for (const source of ortho!.sources) {
    const kind = decodeKinds(source.kinds)
    for (const [z, level] of Object.entries(source.kinds)) {
      const counts = [0, 0, 0, 0]
      for (let j = 0; j < level.h; j++) for (let i = 0; i < level.w; i++) counts[kind(Number(z), level.x0 + i, level.y0 + j)]++
      assert.deepEqual(counts, level.counts, `z${z} counts`)
      const range = serverTileRange(source.bounds, Number(z))
      assert.equal(level.x0, range.x0, `z${z} x0`)
      assert.equal(level.y0, range.y0, `z${z} y0`)
      assert.equal(level.w, range.x1 - range.x0 + 1)
      assert.equal(level.h, range.y1 - range.y0 + 1)
    }
  }
})

function syntheticSource(kindAt: number, maxzoom = 20): OrthoSourceMeta {
  const z = 18
  const range = serverTileRange(SECRET_FOREST, z)
  const w = range.x1 - range.x0 + 1
  const h = range.y1 - range.y0 + 1
  const bytes = new Uint8Array(Math.ceil((w * h) / 4))
  const k = 0 // the top-left tile of the range
  bytes[k >> 2] |= kindAt << ((k & 3) * 2)
  return {
    id: 'sf', name: 'sf', bounds: SECRET_FOREST, minzoom: 10, maxzoom, format: 'webp',
    baseGain: [1, 1, 1], zoomTrim: {}, field: null as never,
    kinds: { [z]: { x0: range.x0, y0: range.y0, w, h, bits: btoa(String.fromCharCode(...bytes)) } },
  }
}

test('planner: full density splits into the in-range children one zoom down', () => {
  const source = syntheticSource(1)
  const { x0, y0 } = serverTileRange(SECRET_FOREST, 18)
  const plan = createPlanner([source], { minZoom: 15, density: 'full', disabled: new Set() })(18, x0, y0)
  assert.ok(plan)
  assert.equal(plan.needsSatellite, true, 'an edge tile keeps the satellite')
  const range19 = serverTileRange(SECRET_FOREST, 19)
  for (const child of plan.children) {
    assert.equal(child.z, 19)
    assert.equal(child.size, 256)
    assert.ok(child.x >= range19.x0 && child.y >= range19.y0, 'no out-of-bounds child is requested')
  }
  assert.ok(plan.children.length >= 1 && plan.children.length <= 4)
})

test('planner: half density, under-patch tiles and full tiles', () => {
  const { x0, y0 } = serverTileRange(SECRET_FOREST, 18)
  const half = createPlanner([syntheticSource(2)], { minZoom: 15, density: 'half', disabled: new Set() })(18, x0, y0)
  assert.deepEqual(half?.children, [{ source: 0, z: 18, x: x0, y: y0, dx: 0, dy: 0, size: 512 }])
  assert.equal(half?.needsSatellite, false, 'a full tile skips the satellite')
  const under = createPlanner([syntheticSource(3)], { minZoom: 15, density: 'full', disabled: new Set() })(18, x0, y0)
  assert.equal(under?.children.length, 1, 'under the ground patch one tile is enough')
  const none = createPlanner([syntheticSource(0)], { minZoom: 15, density: 'full', disabled: new Set() })(18, x0, y0)
  assert.equal(none, null)
  const below = createPlanner([syntheticSource(1)], { minZoom: 19, density: 'full', disabled: new Set() })(18, x0, y0)
  assert.equal(below, null, 'under minZoom')
  const off = createPlanner([syntheticSource(1)], { minZoom: 15, density: 'full', disabled: new Set([0]) })(18, x0, y0)
  assert.equal(off, null, 'disabled source')
  const noChildren = createPlanner([syntheticSource(1, 18)], { minZoom: 15, density: 'full', disabled: new Set() })(18, x0, y0)
  assert.equal(noChildren?.children[0].size, 512, 'no z+1 at the source max zoom: one tile')
})
