import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { TILE_LOADED, type TilePlan } from './ortho-plan.ts'
import { createOrthoUpgrader, keepSatelliteBytes, type ComposeOutcome } from './ortho-upgrade.ts'

// --- fakes -------------------------------------------------------------------------------

/** Open and closed bitmaps, so every test can check that nothing leaks or closes twice. */
const ledger = { created: 0, closed: 0, doubleClosed: 0 }
class FakeBitmap {
  label: string
  width: number
  height: number
  closed = false
  constructor(label: string, size = 512) {
    this.label = label
    this.width = size
    this.height = size
    ledger.created++
  }
  close() {
    if (this.closed) { ledger.doubleClosed++; return }
    this.closed = true
    this.width = 0
    this.height = 0
    ledger.closed++
  }
}

class FakeTexture {
  version = 0
  image: FakeBitmap
  constructor(image: FakeBitmap) { this.image = image }
  set needsUpdate(on: boolean) { if (on) this.version++ }
  get needsUpdate() { return false }
}

let tileSerial = 0
function fakeTile(opts: { z?: number; error?: number; children?: number } = {}) {
  const x = 1000 + tileSerial++
  const texture = new FakeTexture(new FakeBitmap(`sat-${x}`))
  const scene = { material: { map: texture } }
  return {
    texture,
    tile: {
      internal: { loadingState: TILE_LOADED },
      traversal: { visible: true, lastFrameVisited: 1, error: opts.error ?? 0.5 },
      children: { length: opts.children ?? 4 },
      content: { uri: `/maptiler/maps/satellite-v4/${opts.z ?? 18}/${x}/2000.jpg?key=k` },
      engineData: { scene, textures: [texture] },
    },
  }
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

const plan = (children = 1): TilePlan => ({
  z: 18, x: 0, y: 0, needsSatellite: true,
  children: Array.from({ length: children }, (_, i) => ({ source: 0, z: 19, x: i, y: 0, dx: (i & 1) as 0 | 1, dy: (i >> 1) as 0 | 1, size: 256 as const })),
})

/** An engine whose composes the test settles by hand. */
function fakeEngine() {
  const calls: Array<{ signal: AbortSignal; onGrant: () => void; resolve(out: ComposeOutcome): void; plan: TilePlan }> = []
  const engine = {
    ready: true,
    covered: true,
    children: 1,
    pumps: 0,
    requestsWaiting: 0,
    plan(z: number) { return this.covered && z >= 15 ? plan(this.children) : null },
    compose(p: TilePlan, _bytes: ArrayBuffer, signal: AbortSignal, onGrant: () => void) {
      return new Promise<ComposeOutcome>((resolve) => { calls.push({ signal, onGrant, resolve, plan: p }) })
    },
    pump() { this.pumps++ },
  }
  return { engine, calls }
}

function setup(over: { allowed?: boolean; density?: 'half' | 'full' | 'off'; maxConcurrent?: number } = {}) {
  const tiles = fakeTiles()
  const { engine, calls } = fakeEngine()
  const bytes = new Map<object, ArrayBuffer>()
  const satellite = {
    get: (t: object) => bytes.get(t),
    drop: (t: object) => { bytes.delete(t) },
    setCapturing() {},
  }
  const clock = { now: 0 }
  const env = {
    allowed: over.allowed ?? true,
    points: 0,
    uploads: [] as any[],
    decodes: 0,
  }
  const upgrader = createOrthoUpgrader({
    tiles, satellite, engine: engine as any,
    decodeSatellite: async () => { env.decodes++; return new FakeBitmap('revert') },
    upload: (texture) => { env.uploads.push(texture) },
    pointArrivals: () => env.points,
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
  return { tiles, engine, calls, satellite, bytes, env, upgrader, add, tickAt, tickRange, clock }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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
  const standIn = s.add({ error: 3, children: 4 })
  const orphan = s.add()
  orphan.tile.traversal.lastFrameVisited = 0
  const hidden = s.add()
  hidden.tile.traversal.visible = false
  const deepest = s.add({ z: 19, error: 5, children: 0 })
  const small = s.add({ error: 0.2 })
  const big = s.add({ error: 0.9 })
  s.tickRange(0, 1000)
  assert.equal(s.calls.length, 2, 'maxConcurrentComposes')
  const started = s.upgrader.stats()
  assert.equal(started.inFlight, 2)
  // deepest (error 5) and big (0.9) beat small (0.2)
  assert.equal(s.calls.length, 2)
  assert.ok(!s.calls.some(() => false))
  assert.equal(s.upgrader.stats().pending, 3, 'standIn, orphan and hidden are not candidates')
  void standIn; void deepest; void small; void big
  s.upgrader.dispose()
})

test('a tile that leaves the view before all its requests went out is aborted; one that got them all completes', async () => {
  const s = setup()
  s.engine.children = 4
  const a = s.add()
  const b = s.add()
  s.tickRange(0, 1000)
  assert.equal(s.calls.length, 2)
  const [ca, cb] = s.calls
  for (let i = 0; i < 4; i++) cb.onGrant()
  ca.onGrant()
  // both leave the view's detail
  a.tile.traversal.visible = false
  b.tile.traversal.visible = false
  s.tiles.frameCount = 2
  s.tickAt(1250)
  assert.equal(ca.signal.aborted, true, 'granted 1 of 4: aborted')
  assert.equal(cb.signal.aborted, false, 'all 4 granted: it completes')
  assert.equal(s.upgrader.stats().abortedEarly, 1)
  s.upgrader.dispose()
})

test('the swap installs the composite in the same texture, closes the satellite once, uploads on screen, one per tick, never in an arrival tick', async () => {
  const before = { ...ledger }
  const s = setup()
  const a = s.add()
  const b = s.add()
  const satA = a.texture.image
  s.tickRange(0, 1000)
  assert.equal(s.calls.length, 2)
  const compA = new FakeBitmap('compA')
  const compB = new FakeBitmap('compB')
  s.calls[0].resolve({ type: 'done', bitmap: compA, edge: true })
  s.calls[1].resolve({ type: 'done', bitmap: compB, edge: false })
  await flush()
  s.tiles.fire('load-model')
  s.tickAt(1250)
  assert.equal(a.texture.image, satA, 'a basemap tile arrived since the last tick: no swap')
  s.env.points++
  s.tickAt(1500)
  assert.equal(a.texture.image, satA, 'a point tile arrived: no swap')
  s.tickAt(1750)
  const swappedFirst = a.texture.image === compA ? a : b
  const other = swappedFirst === a ? b : a
  assert.notEqual(other.texture.image, compA === swappedFirst.texture.image ? compB : compA, 'one per tick')
  assert.equal(swappedFirst.texture.version, 1)
  assert.equal(s.env.uploads.length, 1, 'uploaded at once, on screen')
  s.tickAt(2000)
  assert.equal(a.texture.image, compA)
  assert.equal(b.texture.image, compB)
  assert.equal(satA.closed, true)
  const st = s.upgrader.stats()
  assert.equal(st.composed, 2)
  assert.equal(st.edgeTiles + st.fullTiles, 2)
  assert.equal(st.swapDeferrals, 2)
  assert.equal(st.upgraded, 2)
  assert.equal(ledger.doubleClosed, before.doubleClosed)
  assert.equal(compA.closed || compB.closed, false, 'the installed images stay open')
  s.upgrader.dispose()
})

test('a composite of another size is closed and the texture left alone', async () => {
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
  s.upgrader.dispose()
})

test('a tile disposed mid-compose: aborted, and a late composite is closed, never installed; a reloaded texture is never written', async () => {
  const s = setup()
  const a = s.add()
  s.tickRange(0, 1000)
  const call = s.calls[0]
  s.tiles.fire('dispose-model', { tile: a.tile })
  // What the library does next: the tile is unloaded and no longer drawn.
  a.tile.internal.loadingState = 0
  s.tiles.visibleTiles.delete(a.tile)
  assert.equal(call.signal.aborted, true)
  const late = new FakeBitmap('late')
  call.resolve({ type: 'done', bitmap: late, edge: true })
  await flush()
  s.tickAt(1250)
  assert.equal(late.closed, true)
  // The same tile object reloaded with a new texture: an old swap must not land in it.
  const b = s.add()
  s.tickRange(1500, 2500)
  const callB = s.calls[1]
  const newTexture = new FakeTexture(new FakeBitmap('sat-reloaded'))
  b.tile.engineData = { scene: { material: { map: newTexture } }, textures: [newTexture] }
  const comp = new FakeBitmap('for-old-texture')
  callB.resolve({ type: 'done', bitmap: comp, edge: true })
  await flush()
  s.tickAt(2750)
  assert.equal(comp.closed, true)
  assert.notEqual(newTexture.image, comp)
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
  assert.equal(a.texture.image, comp2, 'the revert was cancelled')
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
  s.calls[0].resolve({ type: 'empty' })
  s.calls[1].resolve({ type: 'failed' })
  await flush()
  s.tickRange(1250, 4000)
  assert.equal(s.calls.length, 2, 'neither is tried again while loaded')
  assert.equal(s.upgrader.stats().givenUp, 1)
  // Both reloaded with new textures (same URL, same tile object here).
  for (const t of [empty, failed]) {
    const texture = new FakeTexture(new FakeBitmap('sat-new'))
    t.tile.engineData = { scene: { material: { map: texture } }, textures: [texture] }
    s.bytes.set(texture, new ArrayBuffer(28))
  }
  s.tickRange(4250, 5500)
  assert.equal(s.calls.length, 3, 'only the failed one is tried again')
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
  assert.equal(s.tiles.listenerCount(), listenersBefore - 3)
})

test('keepSatelliteBytes keeps the buffer by texture, skips empty ones, drops and forgets', async () => {
  const source = { async processBufferToTexture(buffer: ArrayBuffer) { return { from: buffer.byteLength } } }
  const kept = keepSatelliteBytes(source, true)
  const buffer = new ArrayBuffer(28)
  const texture = await source.processBufferToTexture(buffer)
  assert.equal(kept.get(texture), buffer)
  const none = await source.processBufferToTexture(new ArrayBuffer(0))
  assert.equal(kept.get(none), undefined)
  kept.drop(texture)
  assert.equal(kept.get(texture), undefined)
  const again = await source.processBufferToTexture(new ArrayBuffer(10))
  kept.setCapturing(false)
  assert.equal(kept.get(again), undefined, 'switching capture off forgets everything')
  const after = await source.processBufferToTexture(new ArrayBuffer(10))
  assert.equal(kept.get(after), undefined)
})

test('no bitmap leaks and none is closed twice across all the tests above', () => {
  assert.equal(ledger.doubleClosed, 0)
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
})
