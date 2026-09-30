import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createComposeGate, createPlanner, decodeKinds, parseSatelliteZxy, serverTileRange, type OrthoMeta,
  type OrthoSourceMeta,
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

/** Kind grids over Secret Forest's server range, with the given kinds at tile offsets from
 *  each zoom's top-left tile; every other tile is 0. */
function gridSource(cells: Record<number, Array<[number, number, number]>>, maxzoom = 20): OrthoSourceMeta {
  const kinds: OrthoSourceMeta['kinds'] = {}
  for (const [zText, list] of Object.entries(cells)) {
    const z = Number(zText)
    const range = serverTileRange(SECRET_FOREST, z)
    const w = range.x1 - range.x0 + 1
    const h = range.y1 - range.y0 + 1
    const bytes = new Uint8Array(Math.ceil((w * h) / 4))
    for (const [i, j, kind] of list) {
      const k = j * w + i
      bytes[k >> 2] |= kind << ((k & 3) * 2)
    }
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    kinds[z] = { x0: range.x0, y0: range.y0, w, h, bits: btoa(binary) }
  }
  return {
    id: 'sf', name: 'sf', bounds: SECRET_FOREST, minzoom: 10, maxzoom, format: 'webp',
    baseGain: [1, 1, 1], zoomTrim: {}, field: null as never, kinds,
  }
}
/** One kind at the top-left tile of the z18 range. */
const syntheticSource = (kindAt: number, maxzoom = 20) => gridSource({ 18: [[0, 0, kindAt]] }, maxzoom)
const plannerFor = (sources: OrthoSourceMeta[], extra: Partial<Parameters<typeof createPlanner>[1]> = {}) =>
  createPlanner(sources, { minZoom: 15, density: 'full', disabled: new Set(), ...extra })

test('planner: full density splits into the in-range children one zoom down', () => {
  const source = syntheticSource(1)
  const { x0, y0 } = serverTileRange(SECRET_FOREST, 18)
  const plan = plannerFor([source])(18, x0, y0)
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

test('planner: a full tile inside the range takes all four children and no satellite', () => {
  const { x0, y0 } = serverTileRange(SECRET_FOREST, 18)
  const plan = plannerFor([gridSource({ 18: [[2, 2, 2]] })])(18, x0 + 2, y0 + 2)
  assert.equal(plan?.needsSatellite, false)
  assert.deepEqual(plan?.children.map((c) => [c.z, c.x - 2 * (x0 + 2), c.y - 2 * (y0 + 2), c.dx, c.dy]),
    [[19, 0, 0, 0, 0], [19, 1, 0, 1, 0], [19, 0, 1, 0, 1], [19, 1, 1, 1, 1]])
})

test('planner: children the z+1 grid marks empty are not requested', () => {
  const { x0, y0 } = serverTileRange(SECRET_FOREST, 18)
  const r19 = serverTileRange(SECRET_FOREST, 19)
  const cx = 2 * (x0 + 2) - r19.x0
  const cy = 2 * (y0 + 2) - r19.y0
  // Only the south-east child has ortho in it.
  const source = gridSource({ 18: [[2, 2, 1]], 19: [[cx + 1, cy + 1, 1]] })
  const plan = plannerFor([source])(18, x0 + 2, y0 + 2)
  assert.deepEqual(plan?.children.map((c) => [c.dx, c.dy]), [[1, 1]])
})

test('planner: kind 3 is thinned only when the ground patch covers the whole survey', () => {
  const { x0, y0 } = serverTileRange(SECRET_FOREST, 18)
  const source = gridSource({ 18: [[2, 2, 3]] })
  assert.equal(plannerFor([source])(18, x0 + 2, y0 + 2)?.children.length, 4, 'dome on: planned like a full tile')
  const thin = plannerFor([source], { thinUnderPatch: true })(18, x0 + 2, y0 + 2)
  assert.deepEqual(thin?.children, [{ source: 0, z: 18, x: x0 + 2, y: y0 + 2, dx: 0, dy: 0, size: 512 }])
  assert.equal(thin?.needsSatellite, false)
})

test('planner: two sources both contribute, and the satellite is skipped if either covers all', () => {
  const { x0, y0 } = serverTileRange(SECRET_FOREST, 18)
  const plan = plannerFor([gridSource({ 18: [[2, 2, 1]] }), gridSource({ 18: [[2, 2, 2]] })], { density: 'half' })(18, x0 + 2, y0 + 2)
  assert.deepEqual(plan?.children.map((c) => c.source), [0, 1])
  assert.equal(plan?.needsSatellite, false)
})

test('planner: half density, under-patch tiles and full tiles', () => {
  const { x0, y0 } = serverTileRange(SECRET_FOREST, 18)
  const half = plannerFor([syntheticSource(2)], { density: 'half' })(18, x0, y0)
  assert.deepEqual(half?.children, [{ source: 0, z: 18, x: x0, y: y0, dx: 0, dy: 0, size: 512 }])
  assert.equal(half?.needsSatellite, false, 'a full tile skips the satellite')
  const none = plannerFor([syntheticSource(0)])(18, x0, y0)
  assert.equal(none, null)
  const below = plannerFor([syntheticSource(1)], { minZoom: 19 })(18, x0, y0)
  assert.equal(below, null, 'under minZoom')
  const off = plannerFor([syntheticSource(1)], { disabled: new Set([0]) })(18, x0, y0)
  assert.equal(off, null, 'disabled source')
  const noChildren = plannerFor([syntheticSource(1, 18)])(18, x0, y0)
  assert.equal(noChildren?.children[0].size, 512, 'no z+1 at the source max zoom: one tile')
})

/** A gate with a lending ledger, and a tick to let promise callbacks run. */
function gateWithLedger(max: number) {
  const ledger = { lent: 0 }
  const gate = createComposeGate(max, (delta) => { ledger.lent += delta })
  return { gate, ledger }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const settled = (promise: Promise<unknown>) => {
  const state = { done: false, failed: false }
  promise.then(() => { state.done = true }, () => { state.failed = true })
  return state
}

test('gate: turns up to max at once, the rest wait with their slot lent back', async () => {
  const { gate, ledger } = gateWithLedger(2)
  const a = settled(gate.turn(new AbortController().signal))
  const b = settled(gate.turn(new AbortController().signal))
  const c = settled(gate.turn(new AbortController().signal))
  await tick()
  assert.deepEqual([a.done, b.done, c.done], [true, true, false])
  assert.equal(gate.waiting, 1)
  assert.equal(ledger.lent, 1, 'the waiting tile lends its download slot')
  gate.release()
  await tick()
  assert.equal(c.done, true)
  assert.equal(ledger.lent, 0, 'and takes it back with the turn')
  assert.equal(gate.inFlight, 2)
})

test('gate: an aborted waiter leaves at once and never swallows a turn', async () => {
  const { gate, ledger } = gateWithLedger(1)
  const first = settled(gate.turn(new AbortController().signal))
  const gone = new AbortController()
  const aborted = settled(gate.turn(gone.signal))
  const next = settled(gate.turn(new AbortController().signal))
  await tick()
  assert.equal(ledger.lent, 2)
  gone.abort()
  await tick()
  assert.equal(aborted.failed, true, 'the waiter rejects with the abort, not at the next release')
  assert.equal(ledger.lent, 1, 'its slot goes back to its tile right away')
  assert.equal(gate.waiting, 1)
  gate.release()
  await tick()
  assert.equal(first.done && next.done, true, 'the release goes to the live waiter')
  assert.equal(gate.inFlight, 1)
  assert.equal(ledger.lent, 0)
})

test('gate: an already aborted tile is refused without lending, and releaseAll empties the line', async () => {
  const { gate, ledger } = gateWithLedger(1)
  const done = new AbortController()
  done.abort()
  const refused = settled(gate.turn(done.signal))
  await tick()
  assert.equal(refused.failed, true)
  assert.equal(ledger.lent, 0)
  settled(gate.turn(new AbortController().signal))
  const waiting = [0, 1, 2].map(() => settled(gate.turn(new AbortController().signal)))
  await tick()
  assert.equal(gate.waiting, 3)
  gate.releaseAll()
  await tick()
  assert.ok(waiting.every((w) => w.done))
  assert.equal(ledger.lent, 0)
})
