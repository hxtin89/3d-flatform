import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createPlanner, createSettlePicker, createTurnGate, decodeKinds, isSettledTile, parseSatelliteZxy, serverTileRange,
  TILE_LOADED, type OrthoMeta, type OrthoSourceMeta,
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

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const settled = (promise: Promise<unknown>) => {
  const state = { done: false, failed: false, error: null as unknown }
  promise.then(() => { state.done = true }, (error) => { state.failed = true; state.error = error })
  return state
}

const settleTile = (over: { state?: number; visible?: boolean; frame?: number; error?: number; children?: number; noTraversal?: boolean } = {}) => ({
  internal: { loadingState: over.state ?? TILE_LOADED },
  traversal: over.noTraversal ? undefined : { visible: over.visible ?? true, lastFrameVisited: over.frame ?? 7, error: over.error ?? 0.5 },
  children: { length: over.children ?? 4 },
})

test('isSettledTile: the view\'s own detail on screen, nothing else', () => {
  assert.equal(isSettledTile(settleTile(), 7, 1), true, 'error at or under the target')
  assert.equal(isSettledTile(settleTile({ error: 5, children: 0 }), 7, 1), true, 'the deepest zoom, whatever its error')
  assert.equal(isSettledTile(settleTile({ error: 3 }), 7, 1), false, 'a parent standing in while its children load')
  assert.equal(isSettledTile(settleTile({ frame: 6 }), 7, 1), false, 'not reached by the last traversal')
  assert.equal(isSettledTile(settleTile({ visible: false }), 7, 1), false, 'hidden')
  assert.equal(isSettledTile(settleTile({ state: 2 }), 7, 1), false, 'still loading')
  assert.equal(isSettledTile(settleTile({ noTraversal: true }), 7, 1), false, 'never traversed')
})

test('settle picker: dwell, priority, start-over', () => {
  const picker = createSettlePicker<string>(1000)
  const a = { key: 'a', priority: 1 }
  const b = { key: 'b', priority: 5 }
  assert.deepEqual(picker.pick(0, [a], 2), [], 'not before the dwell')
  assert.deepEqual(picker.pick(500, [a, b], 0), [], 'no slots, but the dwell goes on')
  assert.deepEqual(picker.pick(1000, [a, b], 2).map((c) => c.key), ['a'], 'b has dwelled 500 ms only')
  assert.deepEqual(picker.pick(1600, [a, b], 2).map((c) => c.key), ['b'], 'a, picked at 1000, dwells again; b is due')
  picker.pick(1700, [a], 1)
  assert.deepEqual(picker.pick(2700, [a, b], 2).map((c) => c.key), ['a'], 'b was missing from a pick and starts over')
  picker.clear()
  assert.equal(picker.dwelling, 0)
  assert.deepEqual(picker.pick(5000, [a], 1), [], 'after clear() everything dwells again')
})

test('settle picker: among equal priority the longest waiting goes first', () => {
  const picker = createSettlePicker<string>(100)
  picker.pick(0, [{ key: 'old', priority: 1 }], 0)
  picker.pick(50, [{ key: 'old', priority: 1 }, { key: 'new', priority: 1 }], 0)
  assert.deepEqual(picker.pick(200, [{ key: 'new', priority: 1 }, { key: 'old', priority: 1 }], 1).map((c) => c.key), ['old'])
})

test('turn gate: nothing goes out without a pump, then first come first served up to max', async () => {
  const gate = createTurnGate(2)
  const turns = [0, 1, 2].map(() => settled(gate.turn(new AbortController().signal)))
  await tick()
  assert.equal(turns.some((t) => t.done), false, 'turn() only queues')
  assert.equal(gate.waiting, 3)
  assert.equal(gate.pump(), 2)
  await tick()
  assert.deepEqual(turns.map((t) => t.done), [true, true, false])
  gate.release()
  await tick()
  assert.equal(turns[2].done, false, 'release() frees a slot but grants nothing by itself')
  assert.equal(gate.pump(), 1)
  await tick()
  assert.equal(turns[2].done, true)
  assert.equal(gate.inFlight, 2)
})

test('turn gate: a pump with a lower limit hands out only up to it, never past the gate\'s own', async () => {
  const gate = createTurnGate(4)
  for (let i = 0; i < 6; i++) gate.turn(new AbortController().signal).catch(() => {})
  assert.equal(gate.pump(2), 2, 'a busy stream lets two out')
  assert.equal(gate.pump(2), 0, 'two are in flight already')
  assert.equal(gate.pump(), 2, 'idle: up to the gate\'s own four')
  assert.equal(gate.pump(9), 0, 'a limit above the gate\'s own does not raise it')
  assert.equal(gate.inFlight, 4)
  gate.rejectAll()
})

test('turn gate: an aborted waiter leaves without using a turn; rejectAll empties the line', async () => {
  const gate = createTurnGate(1)
  const gone = new AbortController()
  const aborted = settled(gate.turn(gone.signal))
  const next = settled(gate.turn(new AbortController().signal))
  gone.abort()
  await tick()
  assert.equal(aborted.failed, true)
  assert.equal(gate.waiting, 1)
  gate.pump()
  await tick()
  assert.equal(next.done, true, 'the turn went to the live waiter')
  const before = new AbortController()
  before.abort()
  const refused = settled(gate.turn(before.signal))
  const left = settled(gate.turn(new AbortController().signal))
  gate.rejectAll()
  await tick()
  assert.equal(refused.failed, true)
  assert.equal(left.failed, true)
  assert.equal((left.error as Error).name, 'AbortError')
  assert.equal(gate.waiting, 0)
})
