import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFogNoiseBaker } from './fog-noise-baker.ts'
import { bakeFogNoise, bakeFogNoise3D, type FogNoiseSettings, type NoiseLayerSettings } from './fog-noise.ts'
import type { FogNoiseRequest } from './fog-noise.worker.ts'

/**
 * Stands in for fog-noise.worker.ts: records what it is sent and answers only when the test says
 * so, which is what lets a test hold a bake "running" while newer requests arrive.
 */
class FakeWorker {
  readonly posted: FogNoiseRequest[] = []
  terminated = false
  private readonly listeners = new Map<string, ((event: any) => void)[]>()
  addEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  postMessage(request: FogNoiseRequest): void {
    // Cloned, as postMessage does: the baker must not rely on the worker seeing later changes.
    this.posted.push(structuredClone(request))
  }
  terminate(): void {
    this.terminated = true
  }
  /** The worker finishing `request`, with texels that name it. */
  reply(request: FogNoiseRequest, data = new Uint8Array([request.id])): void {
    this.emit('message', { data: { id: request.id, data } })
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const bakerWith = (fake: FakeWorker) => createFogNoiseBaker(() => fake as unknown as Worker)

const layer = (seed: number): NoiseLayerSettings => ({
  kind: 'value', period: 2, octaves: 1, gain: 0.5, seed, warp: 0, contrast: 1, invert: false,
})
/** Small enough to bake inline in no time; `seed` tells the requests apart. */
const settings = (seed: number): FogNoiseSettings => ({ size: 4, layers: [layer(seed), layer(seed + 1), layer(seed + 2), layer(seed + 3)] })
/** What a request asked for: the 2D settings, or the 3D size. */
const askedFor = (request: FogNoiseRequest) => request.dimension === '2d' ? request.settings : request.size

/** Whether `promise` has settled once everything queued so far has run. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  await new Promise((resolve) => setImmediate(resolve))
  return settled
}

test('one bake runs per dimension; a newer request replaces the one waiting behind it', async () => {
  const fake = new FakeWorker()
  const baker = bakerWith(fake)
  const first = baker.bake2d(settings(1))
  const second = baker.bake2d(settings(2))
  const third = baker.bake2d(settings(3))
  // Only the first went to the worker; the second was replaced by the third before it started.
  assert.equal(fake.posted.length, 1)
  assert.equal(await second, null)
  assert.equal(await isSettled(first), false)
  assert.equal(await isSettled(third), false)

  // The first finishes while a newer request waits: its texels are already stale.
  fake.reply(fake.posted[0])
  assert.equal(await first, null)
  // and the waiting request starts only now, with its own settings.
  assert.equal(fake.posted.length, 2)
  assert.deepEqual(askedFor(fake.posted[1]), settings(3))

  fake.reply(fake.posted[1], new Uint8Array([7, 7]))
  assert.deepEqual(await third, new Uint8Array([7, 7]))
})

test('a bake with nothing newer behind it resolves with the worker\'s texels', async () => {
  const fake = new FakeWorker()
  const baker = bakerWith(fake)
  const bake = baker.bake3d(64)
  assert.deepEqual(fake.posted.map(askedFor), [64])
  fake.reply(fake.posted[0], new Uint8Array([1, 2, 3]))
  assert.deepEqual(await bake, new Uint8Array([1, 2, 3]))
  // The queue is empty again: the next request goes straight to the worker.
  void baker.bake3d(64)
  assert.equal(fake.posted.length, 2)
})

test('2D and 3D bakes do not wait for each other', async () => {
  const fake = new FakeWorker()
  const baker = bakerWith(fake)
  const flat = baker.bake2d(settings(1))
  const volume = baker.bake3d(64)
  assert.deepEqual(fake.posted.map((request) => request.dimension), ['2d', '3d'])
  // Answered out of order: each reply finds its own job by id.
  fake.reply(fake.posted[1], new Uint8Array([3]))
  assert.deepEqual(await volume, new Uint8Array([3]))
  assert.equal(await isSettled(flat), false)
  fake.reply(fake.posted[0], new Uint8Array([2]))
  assert.deepEqual(await flat, new Uint8Array([2]))
})

test('a reply for no running job is ignored', async () => {
  const fake = new FakeWorker()
  const baker = bakerWith(fake)
  const bake = baker.bake2d(settings(1))
  fake.emit('message', { data: { id: fake.posted[0].id + 100, data: new Uint8Array([9]) } })
  assert.equal(await isSettled(bake), false)
  fake.reply(fake.posted[0], new Uint8Array([1]))
  assert.deepEqual(await bake, new Uint8Array([1]))
})

test('the request holds a copy of the settings, so the caller may go on changing its own', () => {
  const fake = new FakeWorker()
  const baker = bakerWith(fake)
  const mine = settings(1)
  void baker.bake2d(mine)
  void baker.bake2d(mine) // waits, built from the same object
  mine.size = 512
  mine.layers[0].seed = 99
  fake.reply(fake.posted[0])
  assert.equal(fake.posted.length, 2)
  assert.deepEqual(fake.posted.map(askedFor), [settings(1), settings(1)])
})

for (const failure of ['error', 'messageerror'] as const) {
  test(`a worker ${failure} bakes what was pending inline, and every later request too`, async () => {
    const fake = new FakeWorker()
    const baker = bakerWith(fake)
    const running = baker.bake2d(settings(1))
    const waiting = baker.bake2d(settings(2))
    const volume = baker.bake3d(4)
    fake.emit(failure, {})
    assert.equal(fake.terminated, true)
    // The running 2D bake had a newer one behind it, which is baked in its place.
    assert.equal(await running, null)
    assert.deepEqual(await waiting, bakeFogNoise(settings(2)))
    assert.deepEqual(await volume, bakeFogNoise3D(4))
    // The worker is gone: nothing more is posted, every bake runs inline.
    assert.deepEqual(await baker.bake2d(settings(3)), bakeFogNoise(settings(3)))
    assert.equal(fake.posted.length, 2)
  })
}

test('without a worker every bake runs inline', async () => {
  const baker = createFogNoiseBaker(() => { throw new Error('Worker is not defined') })
  assert.deepEqual(await baker.bake2d(settings(1)), bakeFogNoise(settings(1)))
  assert.deepEqual(await baker.bake3d(4), bakeFogNoise3D(4))
})

test('dispose stops the worker and resolves every pending bake with null', async () => {
  const fake = new FakeWorker()
  const baker = bakerWith(fake)
  const running = baker.bake2d(settings(1))
  const waiting = baker.bake2d(settings(2))
  const volume = baker.bake3d(64)
  baker.dispose()
  assert.equal(fake.terminated, true)
  assert.deepEqual(await Promise.all([running, waiting, volume]), [null, null, null])
})
