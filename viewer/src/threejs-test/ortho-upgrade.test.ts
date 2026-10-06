import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { TILE_LOADED, type TilePlan } from './ortho-plan.ts'
import { createOrthoUpgrader, keepSatelliteBytes, type ComposeOutcome } from './ortho-upgrade.ts'

// --- fakes -------------------------------------------------------------------------------

/** Every bitmap and texture the tests make, so the last test can check that nothing leaked:
 *  an open bitmap must be some texture's current image. */
const allBitmaps: FakeBitmap[] = []
const allTextures: FakeTexture[] = []
let doubleClosed = 0
class FakeBitmap {
  label: string
  width: number
  height: number
  closed = false
  constructor(label: string, size = 512) {
    this.label = label
    this.width = size
    this.height = size
    allBitmaps.push(this)
  }
  close() {
    if (this.closed) { doubleClosed++; return }
    this.closed = true
    this.width = 0
    this.height = 0
  }
}

class FakeTexture {
  version = 0
  image: FakeBitmap
  constructor(image: FakeBitmap) {
    this.image = image
    allTextures.push(this)
  }
  set needsUpdate(on: boolean) { if (on) this.version++ }
  get needsUpdate() { return false }
}

let tileSerial = 0
function fakeTile(opts: { z?: number; error?: number; children?: number } = {}) {
  const x = 1000 + tileSerial++
  const texture = new FakeTexture(new FakeBitmap(`sat-${x}`))
  const scene = { material: { map: texture } }
  return {
    x,
    texture,
    tile: {
      internal: { loadingState: TILE_LOADED },
      traversal: { visible: true, lastFrameVisited: 1, error: opts.error ?? 0.5 },
      children: { length: opts.children ?? 4 } as any,
      parent: null as any,
      content: { uri: `/maptiler/maps/satellite-v4/${opts.z ?? 18}/${x}/2000.jpg?key=k` },
      engineData: { scene, textures: [texture] } as any,
    },
  }
}

/** What the library does when it unloads a tile: dispose-model, then close the texture's image. */
function unload(s: ReturnType<typeof setup>, made: ReturnType<typeof fakeTile>) {
  s.tiles.fire('dispose-model', { tile: made.tile })
  made.tile.internal.loadingState = 0
  s.tiles.visibleTiles.delete(made.tile)
  made.texture.image.close()
}

function fakeTiles() {
  const listeners = new Map<string, Set<(event: any) => void>>()
  const tiles = {
    stats: { queued: 0, downloading: 0, parsing: 0 },
    processNodeQueue: { running: false },
    frameCount: 1,
    errorTarget: 1,
    visibleTiles: new Set<any>(),
    addEventListener(type: string, fn: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: (event: any) => void) { listeners.get(type)?.delete(fn) },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    fire(type: string, event: any = {}) { listeners.get(type)?.forEach((fn) => fn(event)) },
  }
  return tiles
}

const planFor = (x: number, children = 1): TilePlan => ({
  z: 18, x, y: 2000, needsSatellite: true,
  children: Array.from({ length: children }, (_, i) => ({ source: 0, z: 19, x: i, y: 0, dx: (i & 1) as 0 | 1, dy: (i >> 1) as 0 | 1, size: 256 as const })),
})

/** An engine whose composes the test settles by hand. Each call carries its tile's x. */
function fakeEngine() {
  const calls: Array<{ signal: AbortSignal; onGrant: () => void; resolve(out: ComposeOutcome): void; plan: TilePlan }> = []
  const engine = {
    ready: true,
    covered: true,
    children: 1,
    pumps: 0,
    requestsWaiting: 0,
    plan(z: number, x: number) { return this.covered && z >= 15 ? planFor(x, this.children) : null },
    compose(p: TilePlan, _bytes: ArrayBuffer, signal: AbortSignal, onGrant: () => void) {
      return new Promise<ComposeOutcome>((resolve) => { calls.push({ signal, onGrant, resolve, plan: p }) })
    },
    pump() { this.pumps++ },
  }
  return { engine, calls }
}

function setup(over: { allowed?: boolean; density?: 'half' | 'full' | 'off'; maxConcurrent?: number; failDecode?: boolean } = {}) {
  const tiles = fakeTiles()
  const { engine, calls } = fakeEngine()
  const bytes = new Map<object, ArrayBuffer>()
  const satellite = {
    get: (t: object) => bytes.get(t),
    drop: (t: object) => { bytes.delete(t) },
    setCapturing() {},
    capturing: true,
  }
  const clock = { now: 0 }
  const env = {
    allowed: over.allowed ?? true,
    points: 0,
    pointsBusy: false,
    uploads: [] as any[],
    decodes: 0,
  }
  const upgrader = createOrthoUpgrader({
    tiles, satellite, engine: engine as any,
    decodeSatellite: async () => {
      env.decodes++
      if (over.failDecode) throw new Error('decode failed')
      return new FakeBitmap('revert')
    },
    upload: (texture) => { env.uploads.push(texture) },
    pointArrivals: () => env.points,
    pointsBusy: () => env.pointsBusy,
    upgradesAllowed: () => env.allowed,
    settleMs: 1000,
    maxConcurrentComposes: over.maxConcurrent ?? 2,
    density: over.density ?? 'half',
    now: () => clock.now,
  })
  const add = (opts?: Parameters<typeof fakeTile>[0]) => {
    const made = fakeTile(opts)
    tiles.visibleTiles.add(made.tile)
    bytes.set(made.texture, new ArrayBuffer(28))
    return made
  }
  const tickAt = (ms: number) => { clock.now = ms; tiles.fire('update-after') }
  /** Ticks every 250 ms from `from` to `to`, both included. */
  const tickRange = (from: number, to: number) => { for (let t = from; t <= to; t += 250) tickAt(t) }
  /** The basemap traversed this tick: the view moved, or a tile loaded. */
  const move = () => { tiles.frameCount++; for (const tile of tiles.visibleTiles) tile.traversal.lastFrameVisited = tiles.frameCount }
  return { tiles, engine, calls, satellite, bytes, env, upgrader, add, tickAt, tickRange, clock, move }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const xs = (calls: Array<{ plan: TilePlan }>) => new Set(calls.map((c) => c.plan.x))

// --- tests -------------------------------------------------------------------------------

test('nothing starts while the basemap is busy, bodies included; it starts settleMs after it went idle', () => {
  const s = setup()
  s.add()
  s.tiles.stats.downloading = 1
  s.tickRange(0, 3000)
  assert.equal(s.calls.length, 0, 'a body still streaming counts as busy')
  s.tiles.stats.downloading = 0
  s.tickRange(3250, 4000)
  assert.equal(s.calls.length, 0, 'not before the dwell')
  s.tiles.stats.parsing = 1
  s.tickAt(4100)
  s.tiles.stats.parsing = 0
  s.tickRange(4250, 5000)
  assert.equal(s.calls.length, 0, 'one busy tick starts the dwell over')
  s.tickAt(5250)
  assert.equal(s.calls.length, 1)
  s.tiles.processNodeQueue.running = true
  s.add()
  s.tickRange(5500, 9000)
  assert.equal(s.calls.length, 1, 'a running node queue blocks too')
  s.upgrader.dispose()
})

test('before the Start click or during a flight nothing starts and no request is let out', () => {
  const s = setup({ allowed: false })
  s.add()
  s.tickRange(0, 5000)
  assert.equal(s.calls.length, 0)
  assert.equal(s.engine.pumps, 0)
  s.env.allowed = true
  s.tickRange(5250, 6250)
  assert.equal(s.calls.length, 1)
  assert.ok(s.engine.pumps > 0, 'requests go out only from an idle, allowed tick')
  s.upgrader.dispose()
})

test('stand-ins, orphans and hidden tiles never start; the deepest zoom does; larger error first, capped', () => {
  const s = setup({ maxConcurrent: 2 })
  s.add({ error: 3, children: 4 })
  const orphan = s.add()
  orphan.tile.traversal.lastFrameVisited = 0
  const hidden = s.add()
  hidden.tile.traversal.visible = false
  const deepest = s.add({ z: 19, error: 5, children: 0 })
  s.add({ error: 0.2 })
  const big = s.add({ error: 0.9 })
  s.tickRange(0, 1000)
  assert.deepEqual(xs(s.calls), new Set([deepest.x, big.x]), 'deepest (error 5) and big (0.9) beat small (0.2); capped at 2')
  assert.equal(s.upgrader.stats().pending, 3, 'stand-in, orphan and hidden are not candidates')
  s.upgrader.dispose()
})

test('a tile next to an upgraded one starts without the dwell once the view is still', async () => {
  const s = setup()
  const child = s.add({ z: 19, children: 0 })
  s.tickRange(0, 1000)
  s.calls[0].resolve({ type: 'done', bitmap: new FakeBitmap('child'), edge: false })
  await flush()
  s.tickAt(1250)
  assert.equal(s.upgrader.stats().upgraded, 1)
  // Zoom out one step: the parent shows now, the child is cached but hidden.
  const parent = s.add()
  parent.tile.children = [child.tile]
  child.tile.parent = parent.tile
  child.tile.traversal.visible = false
  s.tiles.visibleTiles.delete(child.tile)
  s.move()
  s.tickAt(1300)
  assert.equal(s.calls.length, 1, 'not while the view is moving')
  s.tickAt(1700)
  assert.deepEqual([...xs(s.calls.slice(1))], [parent.x], 'still for 300 ms: no 1 s dwell next to an upgraded child')
  s.upgrader.dispose()
})

test('a tile that leaves the view before all its requests went out is aborted; one that got them all completes', () => {
  const s = setup()
  s.engine.children = 4
  const a = s.add()
  const b = s.add()
  s.tickRange(0, 1000)
  assert.equal(s.calls.length, 2)
  const ca = s.calls.find((c) => c.plan.x === a.x)!
  const cb = s.calls.find((c) => c.plan.x === b.x)!
  for (let i = 0; i < 4; i++) cb.onGrant()
  ca.onGrant()
  a.tile.traversal.visible = false
  b.tile.traversal.visible = false
  s.tiles.frameCount = 2
  s.tickAt(1250)
  assert.equal(ca.signal.aborted, true, 'granted 1 of 4: aborted')
  assert.equal(cb.signal.aborted, false, 'all 4 granted: it completes')
  assert.equal(s.upgrader.stats().abortedEarly, 1)
  s.upgrader.dispose()
})

test('ortho requests wait while point tiles load, and go out anyway after 8 s', () => {
  const s = setup()
  s.add()
  s.env.pointsBusy = true
  s.tickRange(0, 1000)
  assert.equal(s.calls.length, 1, 'the compose starts and joins the line')
  const pumpsWhileBusy = s.engine.pumps
  s.tickRange(1250, 7750)
  assert.equal(s.engine.pumps, pumpsWhileBusy, 'no request goes out while the point stream is busy')
  s.tickRange(8000, 8250)
  assert.ok(s.engine.pumps > pumpsWhileBusy, 'a stream that never drains does not starve the ortho')
  s.env.pointsBusy = false
  const before = s.engine.pumps
  s.tickAt(8500)
  assert.equal(s.engine.pumps, before + 1)
  s.upgrader.dispose()
})

test('the swap installs the composite in the same texture, closes the satellite once, one per tick, never in an arrival tick', async () => {
  const s = setup()
  const a = s.add()
  const b = s.add()
  const satA = a.texture.image
  s.tickRange(0, 1000)
  assert.equal(s.calls.length, 2)
  const compA = new FakeBitmap('compA')
  const compB = new FakeBitmap('compB')
  s.calls.find((c) => c.plan.x === a.x)!.resolve({ type: 'done', bitmap: compA, edge: true })
  s.calls.find((c) => c.plan.x === b.x)!.resolve({ type: 'done', bitmap: compB, edge: false })
  await flush()
  s.tiles.fire('load-model')
  s.tickAt(1250)
  assert.equal(a.texture.image, satA, 'a basemap tile arrived since the last tick: no swap')
  s.env.points++
  s.tickAt(1500)
  assert.equal(a.texture.image, satA, 'a point tile arrived: no swap')
  s.tiles.fire('tile-visibility-change', { visible: true })
  s.tickAt(1600)
  assert.equal(a.texture.image, satA, 'a basemap tile turned visible: three uploads it this frame')
  s.tickAt(1750)
  const installed = [a, b].filter((t) => t.texture.image === compA || t.texture.image === compB)
  assert.equal(installed.length, 1, 'one per tick')
  assert.equal(installed[0].texture.version, 1)
  assert.equal(s.env.uploads.length, 1, 'uploaded in the swap tick')
  s.tickAt(2000)
  assert.equal(a.texture.image, compA)
  assert.equal(b.texture.image, compB)
  assert.equal(satA.closed, true)
  const st = s.upgrader.stats()
  assert.equal(st.composed, 2)
  assert.equal(st.edgeTiles + st.fullTiles, 2)
  assert.equal(st.swapDeferrals, 3)
  assert.equal(st.upgraded, 2)
  assert.equal(compA.closed || compB.closed, false, 'the installed images stay open')
  s.upgrader.dispose()
})

test('a swap waits for a still view, and for the end of a flight; a revert only for arrivals', async () => {
  const s = setup()
  const a = s.add()
  const sat = a.texture.image
  s.tickRange(0, 1000)
  s.calls[0].resolve({ type: 'done', bitmap: new FakeBitmap('comp'), edge: true })
  await flush()
  s.move()
  s.tickAt(1250)
  s.tickRange(1500, 2000)
  assert.equal(a.texture.image, sat, 'the view moved at 1250: held for settleMs')
  s.env.allowed = false
  s.tickRange(2250, 4000)
  assert.equal(a.texture.image, sat, 'held during a flight')
  s.env.allowed = true
  s.tickAt(4250)
  assert.equal(a.texture.image.label, 'comp')
  // Off while the view keeps moving: the revert lands anyway.
  s.upgrader.setEnabled(false)
  s.move()
  s.tickAt(4300)
  await flush()
  s.move()
  s.tickAt(4350)
  assert.equal(a.texture.image.label, 'revert')
  s.upgrader.dispose()
})

test('a hidden tile is uploaded in its swap tick too, not at some later draw', async () => {
  const s = setup()
  const a = s.add()
  s.tickRange(0, 1000)
  s.calls[0].resolve({ type: 'done', bitmap: new FakeBitmap('comp'), edge: true })
  await flush()
  a.tile.traversal.visible = false
  s.tiles.visibleTiles.delete(a.tile)
  s.tickAt(1250)
  assert.equal(a.texture.image.label, 'comp')
  assert.equal(s.env.uploads.length, 1)
  s.upgrader.dispose()
})

test('finished composites waiting for their frame hold their upgrade slot', async () => {
  const s = setup({ maxConcurrent: 2 })
  for (let i = 0; i < 6; i++) s.add()
  s.tickRange(0, 1000)
  assert.equal(s.calls.length, 2)
  for (const call of s.calls) call.resolve({ type: 'done', bitmap: new FakeBitmap('comp'), edge: true })
  await flush()
  // A point tile arrives on every tick: the swaps stay queued, so nothing new starts.
  for (let t = 1250; t <= 4000; t += 250) { s.env.points++; s.tickAt(t) }
  assert.equal(s.calls.length, 2)
  s.upgrader.dispose()
})

test('a composite of another size is closed, the texture left alone, and not composed again', async () => {
  const s = setup()
  const a = s.add()
  const sat = a.texture.image
  s.tickRange(0, 1000)
  const wrong = new FakeBitmap('wrong', 256)
  s.calls[0].resolve({ type: 'done', bitmap: wrong, edge: true })
  await flush()
  s.tickAt(1250)
  assert.equal(a.texture.image, sat)
  assert.equal(wrong.closed, true)
  assert.equal(s.upgrader.stats().sizeMismatch, 1)
  s.tickRange(1500, 4000)
  assert.equal(s.calls.length, 1)
  s.upgrader.dispose()
})

test('a tile unloaded mid-compose and reloaded as the same object: the old result is closed, the new job kept', async () => {
  const s = setup()
  const a = s.add()
  s.tickRange(0, 1000)
  const first = s.calls[0]
  unload(s, a)
  assert.equal(first.signal.aborted, true)
  // The library brings the same tile object back, with a new texture.
  const texture = new FakeTexture(new FakeBitmap('sat-reloaded'))
  a.tile.internal.loadingState = TILE_LOADED
  a.tile.engineData = { scene: { material: { map: texture } }, textures: [texture] }
  s.bytes.set(texture, new ArrayBuffer(28))
  s.tiles.visibleTiles.add(a.tile)
  s.tickRange(1250, 2250)
  assert.equal(s.calls.length, 2)
  const late = new FakeBitmap('late')
  first.resolve({ type: 'done', bitmap: late, edge: true })
  await flush()
  assert.equal(late.closed, true)
  assert.equal(s.upgrader.stats().inFlight, 1, "the old job's finally did not take the new job with it")
  s.tickRange(2500, 4000)
  assert.equal(s.calls.length, 2)
  const comp = new FakeBitmap('comp')
  s.calls[1].resolve({ type: 'done', bitmap: comp, edge: true })
  await flush()
  s.tickAt(4250)
  assert.equal(texture.image, comp)
  s.upgrader.dispose()
})

test('a queued swap is closed when its tile is unloaded', async () => {
  const s = setup()
  const a = s.add()
  s.tickRange(0, 1000)
  const comp = new FakeBitmap('queued')
  s.calls[0].resolve({ type: 'done', bitmap: comp, edge: true })
  await flush()
  s.tiles.fire('load-model')
  s.tickAt(1250)
  const dropped = s.upgrader.stats().dropped
  unload(s, a)
  assert.equal(comp.closed, true)
  assert.equal(s.upgrader.stats().dropped, dropped + 1)
  s.upgrader.dispose()
})

test('Off puts the satellite back from the kept bytes, even with the worker dead; Off-then-On keeps the composite', async () => {
  const s = setup()
  const a = s.add()
  s.tickRange(0, 1000)
  const comp = new FakeBitmap('comp')
  s.calls[0].resolve({ type: 'done', bitmap: comp, edge: true })
  await flush()
  s.tickAt(1250)
  assert.equal(a.texture.image, comp)
  s.engine.ready = false
  s.tiles.stats.downloading = 3   // busy does not matter for a revert
  s.upgrader.setEnabled(false)
  s.tickAt(1500)
  assert.equal(s.env.decodes, 1)
  await flush()
  s.tickAt(1750)
  assert.equal(a.texture.image.label, 'revert')
  assert.equal(comp.closed, true)
  assert.equal(s.upgrader.stats().reverted, 1)
  assert.equal(s.upgrader.stats().upgraded, 0)
  // Upgrade again, then Off and On again before the revert swap lands.
  s.engine.ready = true
  s.tiles.stats.downloading = 0
  s.upgrader.setEnabled(true)
  s.tickRange(2000, 3000)
  const comp2 = new FakeBitmap('comp2')
  s.calls[1].resolve({ type: 'done', bitmap: comp2, edge: true })
  await flush()
  s.tickAt(3250)
  assert.equal(a.texture.image, comp2)
  s.upgrader.setEnabled(false)
  s.tickAt(3500)
  s.upgrader.setEnabled(true)
  await flush()
  s.tickAt(3750)
  assert.equal(a.texture.image, comp2, 'the revert was cancelled and its bitmap closed')
  s.upgrader.dispose()
})

test('a revert that keeps failing is given up after 3 tries, not retried every frame', async () => {
  const s = setup({ failDecode: true })
  const a = s.add()
  s.tickRange(0, 1000)
  s.calls[0].resolve({ type: 'done', bitmap: new FakeBitmap('comp'), edge: true })
  await flush()
  s.tickAt(1250)
  s.upgrader.setEnabled(false)
  for (let t = 1500; t <= 6000; t += 250) { s.tickAt(t); await flush() }
  assert.equal(s.env.decodes, 3)
  assert.equal(s.upgrader.stats().revertFailures, 3)
  assert.equal(a.texture.image.label, 'comp', 'the tile keeps its composite')
  s.upgrader.dispose()
})

test('a density change composes again in place and the swap closes the old composite', async () => {
  const s = setup({ density: 'half' })
  const a = s.add()
  s.tickRange(0, 1000)
  const half = new FakeBitmap('half')
  s.calls[0].resolve({ type: 'done', bitmap: half, edge: true })
  await flush()
  s.tickAt(1250)
  s.upgrader.setDensity('full')
  s.tickRange(1500, 2500)
  assert.equal(s.calls.length, 2, 'the tile is a candidate again at the new density')
  const full = new FakeBitmap('full')
  s.calls[1].resolve({ type: 'done', bitmap: full, edge: true })
  await flush()
  s.tickAt(2750)
  assert.equal(a.texture.image, full)
  assert.equal(half.closed, true)
  s.upgrader.dispose()
})

test('an empty tile is given up for good at that density; a failed one waits for a reload', async () => {
  const s = setup()
  const empty = s.add()
  const failed = s.add()
  s.tickRange(0, 1000)
  s.calls.find((c) => c.plan.x === empty.x)!.resolve({ type: 'empty' })
  s.calls.find((c) => c.plan.x === failed.x)!.resolve({ type: 'failed' })
  await flush()
  s.tickRange(1250, 4000)
  assert.equal(s.calls.length, 2, 'neither is tried again while loaded')
  assert.equal(s.upgrader.stats().givenUp, 1)
  for (const t of [empty, failed]) {
    unload(s, t)
    const texture = new FakeTexture(new FakeBitmap('sat-new'))
    t.tile.internal.loadingState = TILE_LOADED
    t.tile.engineData = { scene: { material: { map: texture } }, textures: [texture] }
    s.bytes.set(texture, new ArrayBuffer(28))
    s.tiles.visibleTiles.add(t.tile)
  }
  s.tickRange(4250, 5500)
  assert.deepEqual([...xs(s.calls.slice(2))], [failed.x], 'only the failed one is tried again')
  s.calls[2].resolve({ type: 'failed' })
  await flush()
  s.upgrader.dispose()
})

test('dispose closes every queued bitmap and removes its listeners; twice is fine', async () => {
  const s = setup()
  s.add()
  s.tickRange(0, 1000)
  const comp = new FakeBitmap('queued')
  s.calls[0].resolve({ type: 'done', bitmap: comp, edge: true })
  await flush()
  s.tiles.fire('load-model')    // an arrival: the swap waits
  s.tickAt(1250)
  const listenersBefore = s.tiles.listenerCount()
  s.upgrader.dispose()
  s.upgrader.dispose()
  assert.equal(comp.closed, true)
  assert.equal(s.tiles.listenerCount(), listenersBefore - 4)
})

test('keepSatelliteBytes keeps the buffer by texture, skips empty ones, drops and forgets', async () => {
  const source = { async processBufferToTexture(buffer: ArrayBuffer) { return { from: buffer.byteLength } } }
  const kept = keepSatelliteBytes(source, true)
  assert.equal(kept.capturing, true)
  const buffer = new ArrayBuffer(28)
  const texture = await source.processBufferToTexture(buffer)
  assert.equal(kept.get(texture), buffer)
  const none = await source.processBufferToTexture(new ArrayBuffer(0))
  assert.equal(kept.get(none), undefined)
  kept.drop(texture)
  assert.equal(kept.get(texture), undefined)
  const again = await source.processBufferToTexture(new ArrayBuffer(10))
  kept.setCapturing(false)
  assert.equal(kept.capturing, false)
  assert.equal(kept.get(again), undefined, 'switching capture off forgets everything')
  const after = await source.processBufferToTexture(new ArrayBuffer(10))
  assert.equal(kept.get(after), undefined)
})

test('across all the tests above: no bitmap closed twice, and every open bitmap is some texture\'s image', () => {
  assert.equal(doubleClosed, 0)
  const installed = new Set(allTextures.map((t) => t.image))
  const leaked = allBitmaps.filter((b) => !b.closed && !installed.has(b)).map((b) => b.label)
  assert.deepEqual(leaked, [])
})

test('the library facts this relies on still hold (3d-tiles-renderer 0.4.28)', () => {
  const lib = new URL('../../node_modules/3d-tiles-renderer/src/', import.meta.url)
  const read = (path: string) => readFileSync(new URL(path, lib), 'utf8')
  assert.match(read('core/renderer/constants.js'), /LOADED\s*=\s*4/)
  const source = read('three/plugins/images/sources/TiledImageSource.js')
  for (const option of [/premultiplyAlpha:\s*'none'/, /colorSpaceConversion:\s*'none'/, /imageOrientation:\s*'flipY'/]) {
    assert.match(source, option)
  }
  const base = read('core/renderer/tiles/TilesRendererBase.js')
  assert.equal(base.match(/type: 'update-after'/g)?.length, 2, 'update-after on both the skip path and after a traversal')
  assert.match(base, /arrayBuffer\(\)[\s\S]{0,400}stats\.downloading --/, 'downloading counts until the body is read')
  assert.match(base, /type: 'tile-visibility-change'/)
})
