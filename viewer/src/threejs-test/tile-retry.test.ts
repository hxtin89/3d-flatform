import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { retryFailedTiles } from './tile-retry.ts'

const FAILED = -1
const UNLOADED = 0

// A stand-in for TilesRenderer: events, the LRU cache's has/remove (remove runs the
// renderer's own callback, which returns the tile to UNLOADED) and the failed count.
function fakeTiles() {
  const listeners = new Map<string, Set<(event: any) => void>>()
  const cached = new Set<any>()
  const dispatched: string[] = []
  const tiles = {
    stats: { failed: 0 },
    addEventListener(type: string, fn: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: (event: any) => void) { listeners.get(type)?.delete(fn) },
    dispatchEvent(event: { type: string }) { dispatched.push(event.type) },
    lruCache: {
      has: (tile: any) => cached.has(tile),
      remove(tile: any) {
        if (!cached.has(tile)) return false
        cached.delete(tile)
        tile.internal.loadingState = UNLOADED
        return true
      },
    },
  }
  const fire = (type: string, event: any) => listeners.get(type)?.forEach((fn) => fn(event))
  // What the renderer does on a failed download: FAILED, counted, left in the cache.
  const fail = (tile: any, error: unknown) => {
    tile.internal.loadingState = FAILED
    tiles.stats.failed++
    cached.add(tile)
    fire('load-error', { tile, error, url: 'x' })
  }
  return { tiles, fail, fire, dispatched, cached }
}

// The module reads performance.now(); the mock timers move setTimeout. Keep them in step.
function clock() {
  let now = 0
  const spy = mock.method(performance, 'now', () => now)
  mock.timers.enable({ apis: ['setTimeout'] })
  return {
    advance(ms: number) { now += ms; mock.timers.tick(ms) },
    restore() { mock.timers.reset(); spy.mock.restore() },
  }
}

test('a dropped connection is retried after 2 s: out of the cache, UNLOADED, traversal nudged', () => {
  const c = clock()
  try {
    const { tiles, fail, dispatched, cached } = fakeTiles()
    const stop = retryFailedTiles(tiles, 'test')
    const tile = { internal: { loadingState: 0 } }
    fail(tile, new TypeError('Failed to fetch'))
    c.advance(1_900)
    assert.equal(tile.internal.loadingState, FAILED)
    c.advance(200)
    assert.equal(tile.internal.loadingState, UNLOADED)
    assert.equal(cached.has(tile), false)
    assert.equal(tiles.stats.failed, 0)
    assert.deepEqual(dispatched, ['needs-update'])
    stop()
  } finally { c.restore() }
})

test('a refused tile (4xx) is left alone', () => {
  const c = clock()
  try {
    const { tiles, fail, dispatched } = fakeTiles()
    const stop = retryFailedTiles(tiles, 'test')
    const tile = { internal: { loadingState: 0 } }
    fail(tile, new Error('Failed to load model with error code 404'))
    c.advance(120_000)
    assert.equal(tile.internal.loadingState, FAILED)
    assert.equal(tiles.stats.failed, 1)
    assert.deepEqual(dispatched, [])
    stop()
  } finally { c.restore() }
})

test('the same tile waits twice as long after every further failure, and starts over once it loads', () => {
  const c = clock()
  try {
    const { tiles, fail, fire } = fakeTiles()
    const stop = retryFailedTiles(tiles, 'test')
    const tile = { internal: { loadingState: 0 } }
    const cycle = (expectedMs: number) => {
      fail(tile, new Error('Failed to load model with error code 500'))
      c.advance(expectedMs - 50)
      assert.equal(tile.internal.loadingState, FAILED, `still waiting before ${expectedMs} ms`)
      c.advance(100)
      assert.equal(tile.internal.loadingState, UNLOADED, `retried at ${expectedMs} ms`)
    }
    cycle(2_000)
    cycle(4_000)
    cycle(8_000)
    fire('load-model', { tile, scene: {} })
    cycle(2_000)
    stop()
  } finally { c.restore() }
})

test('a new tile failing does not inherit another tile\'s backoff', () => {
  const c = clock()
  try {
    const { tiles, fail } = fakeTiles()
    const stop = retryFailedTiles(tiles, 'test')
    const a = { internal: { loadingState: 0 } }
    const b = { internal: { loadingState: 0 } }
    fail(a, new TypeError('Failed to fetch'))
    c.advance(2_100)
    fail(a, new TypeError('Failed to fetch'))
    fail(b, new TypeError('Failed to fetch'))
    c.advance(2_100)
    assert.equal(b.internal.loadingState, UNLOADED, 'b retried after its own 2 s')
    assert.equal(a.internal.loadingState, FAILED, 'a still in its 4 s wait')
    c.advance(2_000)
    assert.equal(a.internal.loadingState, UNLOADED)
    stop()
  } finally { c.restore() }
})

test('teardown cancels a pending retry', () => {
  const c = clock()
  try {
    const { tiles, fail } = fakeTiles()
    const stop = retryFailedTiles(tiles, 'test')
    const tile = { internal: { loadingState: 0 } }
    fail(tile, new TypeError('Failed to fetch'))
    stop()
    c.advance(10_000)
    assert.equal(tile.internal.loadingState, FAILED)
  } finally { c.restore() }
})
