import { test } from 'node:test'
import assert from 'node:assert/strict'

import { identityLattice, parseCube, serializeCube } from './cube-format.ts'
import { createGradeBakeHost, type HostReply, type HostRequest } from './grade-bake-host.ts'
import {
  bakeGradeFloat, bakeGradeTexels, createBakeScheduler, createBufferPool, identityTexels,
  type BakedMessage, type BakeMessage, type BakeResult,
} from './grade-bake.ts'
import { DEFAULT_GRADE_TUNING, NEUTRAL_GRADE, parseGradeState, type GradeState } from './grade-model.ts'

/** A state from a partial one, which must parse without a warning. */
function grade(partial: unknown): GradeState {
  const { state, warnings } = parseGradeState(partial)
  assert.deepEqual(warnings, [], 'the test grade is valid')
  return state
}

const BUSY = grade({
  temperature: 18, tint: -7, lift: { y: 0.015, u: 0.12, v: -0.06 }, gamma: { y: 0.18, u: -0.1, v: 0.08 },
  gain: { y: 1.08, u: 0.06, v: 0.1 }, contrast: 1.25, saturation: 1.15, vibrance: 0.35,
  curves: { master: [[0, 0], [0.25, 0.21], [0.75, 0.8], [1, 1]] }, hueSat: [[110, 1.25]],
  tones: { shadows: { u: 0.25, v: -0.15 }, highlights: { u: -0.2, v: 0.25 } }, rollOff: 0.5,
})

/** A warm, slightly crushed look as a .cube text of n³ nodes. */
function warmCubeText(n: number): string {
  const lattice = identityLattice(n)
  for (let p = 0; p < lattice.length; p += 3) {
    lattice[p] = Math.min(1.02, lattice[p] ** 0.9 * 1.03)
    lattice[p + 1] = lattice[p + 1] ** 1.05
    lattice[p + 2] = lattice[p + 2] * 0.92
  }
  return serializeCube(lattice, n, { title: 'Warm test look' })
}

/** What crosses the worker boundary: a structured clone that moves the transfer list. */
function across<T>(message: T, transfer: ArrayBuffer[]): T {
  return structuredClone(message, { transfer })
}

/** One request through the host as the worker does it: the message in with its buffer moved,
 *  the reply out with its buffer moved back. */
function roundTrip(host: ReturnType<typeof createGradeBakeHost>, message: HostRequest): HostReply | null {
  const transfer = message.kind === 'bake' ? [message.out] : []
  const result = host.handle(across(message, transfer))
  return result ? across(result.reply, result.transfer) : null
}

const bakeMessage = (seq: number, state: GradeState, n: number, stride = 1, look: BakeMessage['look'] = null): BakeMessage =>
  ({ kind: 'bake', seq, state, look, n, stride, out: new ArrayBuffer(8 * n ** 3) })

test('parse: a 3D cube is held and described, a broken one names its line, a 1D one is refused', () => {
  const host = createGradeBakeHost()
  const warm = host.handle({ kind: 'parse', key: 'warm', text: warmCubeText(17) })
  assert.equal(warm?.reply.kind, 'parsed')
  if (warm?.reply.kind !== 'parsed') return
  assert.equal(warm.reply.key, 'warm')
  assert.deepEqual(warm.reply.meta, {
    title: 'Warm test look', kind: '3d', size: 17, domainMin: [0, 0, 0], domainMax: [1, 1, 1],
    unitDomain: true, isIdentity: false, warnings: [],
  })
  const identity = host.handle({ kind: 'parse', key: 'id', text: serializeCube(identityLattice(9), 9) })
  assert.equal(identity?.reply.kind === 'parsed' && identity.reply.meta.isIdentity, true, 'an identity cube is flagged')
  const narrow = host.handle({ kind: 'parse', key: 'narrow', text: `DOMAIN_MIN 0 0 0\nDOMAIN_MAX 0.5 1 1\n${serializeCube(identityLattice(2), 2)}` })
  assert.equal(narrow?.reply.kind === 'parsed' && narrow.reply.meta.unitDomain, false, 'a non-unit domain is flagged')

  const broken = host.handle({ kind: 'parse', key: 'broken', text: 'LUT_3D_SIZE 2\n0 0 0\n1 0\n' })
  assert.equal(broken?.reply.kind, 'error')
  if (broken?.reply.kind === 'error') {
    assert.equal(broken.reply.line, 3)
    assert.equal(broken.reply.rejected, undefined)
  }
  const shaper = host.handle({ kind: 'parse', key: 'shaper', text: 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n' })
  assert.equal(shaper?.reply.kind, 'error')
  if (shaper?.reply.kind === 'error') {
    assert.equal(shaper.reply.line, 0)
    assert.equal(shaper.reply.rejected, true)
    assert.match(shaper.reply.message, /LUT_1D_SIZE 2/)
  }
  assert.deepEqual(host.looks(), ['warm', 'id', 'narrow'], 'only what parsed as a 3D look is held')
})

test('bake: the reply is bakeGradeTexels\' result in the buffer the job brought, sent back', () => {
  const host = createGradeBakeHost()
  for (const [state, stride] of [[BUSY, 1], [BUSY, 2], [NEUTRAL_GRADE as GradeState, 1]] as const) {
    const message = bakeMessage(7, state, 33, stride)
    const result = host.handle(message)!
    assert.equal(result.reply.kind, 'baked')
    if (result.reply.kind !== 'baked') continue
    assert.equal(result.reply.out, message.out, 'the same buffer goes back')
    assert.deepEqual(result.transfer, [message.out])
    assert.equal(result.reply.seq, 7)
    assert.equal(result.reply.n, 33)
    assert.equal(result.reply.stride, stride)
    const expected = bakeGradeTexels(state, null, 33, stride)
    assert.deepEqual(new Uint16Array(result.reply.out), expected.texels)
    assert.equal(result.reply.peak, expected.peak)
  }
  const neutral = host.handle(bakeMessage(8, NEUTRAL_GRADE as GradeState, 17))!.reply
  assert.equal(neutral.kind, 'baked')
  assert.deepEqual(new Uint16Array((neutral as BakedMessage).out), identityTexels(17), 'a neutral bake is the identity lattice')
})

test('bake with a look: the parsed cube at the job\'s amount; a look not held fails and returns the buffer', () => {
  const host = createGradeBakeHost()
  const text = warmCubeText(21)
  host.handle({ kind: 'parse', key: 'warm', text })
  const cube = parseCube(text)
  const message = bakeMessage(1, BUSY, 41, 1, { key: 'warm', amount: 0.6 })
  const reply = roundTrip(host, message)
  assert.equal(reply?.kind, 'baked')
  const expected = bakeGradeTexels(BUSY, { cube, amount: 0.6 }, 41, 1)
  assert.deepEqual(new Uint16Array((reply as { out: ArrayBuffer }).out), expected.texels)

  const missing = bakeMessage(2, BUSY, 33, 1, { key: 'gone', amount: 1 })
  const failed = host.handle(missing)!
  assert.equal(failed.reply.kind, 'bake-failed')
  if (failed.reply.kind !== 'bake-failed') return
  assert.equal(failed.reply.seq, 2)
  assert.equal(failed.reply.missingLook, 'gone')
  assert.equal(failed.reply.out, missing.out, 'the buffer comes back for the pool')
  assert.deepEqual(failed.transfer, [missing.out])

  const wrongSize = host.handle({ ...bakeMessage(3, BUSY, 33), out: new ArrayBuffer(16) })!
  assert.equal(wrongSize.reply.kind, 'bake-failed', 'a buffer too small for the lattice is a failed bake, not a throw')
})

test('export: the kept final lattice when the job matches, a fresh final bake otherwise; drafts never replace it', () => {
  const host = createGradeBakeHost()
  assert.equal(host.keptSize, 0)
  host.handle(bakeMessage(1, BUSY, 33))
  assert.equal(host.keptSize, 33)
  // A draft of something else in between must not change what an export of BUSY reads.
  host.handle(bakeMessage(2, grade({ saturation: 0.2 }), 33, 2))
  const kept = host.handle({ kind: 'export', id: 5, job: { state: BUSY, look: null, n: 33 } })!
  assert.equal(kept.reply.kind, 'cube')
  if (kept.reply.kind !== 'cube') return
  assert.equal(kept.reply.id, 5)
  assert.equal(kept.reply.n, 33)
  const exact = bakeGradeFloat(BUSY, null, 33).lattice
  assert.equal(kept.reply.text, serializeCube(exact, 33), 'the export is the final bake\'s float lattice, written out')
  assert.equal(parseCube(kept.reply.text).size, 33)
  assert.match(kept.reply.text, /^# SCHNELLE BUNTE BILDER · Canopy colour grade\n/)
  assert.match(kept.reply.text, /\nTITLE "Canopy colour grade"\nLUT_3D_SIZE 33\n/)

  // Another job, another size: baked fresh.
  const other = grade({ temperature: -30 })
  const fresh = host.handle({ kind: 'export', id: 6, title: 'Other', job: { state: other, look: null, n: 17 } })!
  assert.equal(fresh.reply.kind, 'cube')
  if (fresh.reply.kind !== 'cube') return
  assert.equal(fresh.reply.n, 17)
  assert.match(fresh.reply.text, /\nTITLE "Other"\n/)
  assert.equal(fresh.reply.text, serializeCube(bakeGradeFloat(other, null, 17).lattice, 17, { title: 'Other' }))
  assert.equal(host.keptSize, 33, 'an export bakes beside the kept lattice, not into it')

  const failed = host.handle({ kind: 'export', id: 7, job: { state: BUSY, look: { key: 'gone', amount: 1 }, n: 33 } })!
  assert.deepEqual(failed.reply, { kind: 'export-error', id: 7, message: 'the look gone is not loaded' })
})

test('drop forgets a look; the backstop limit drops the look used longest ago', () => {
  const host = createGradeBakeHost({ maxLooks: 2 })
  const text = serializeCube(identityLattice(3), 3)
  host.handle({ kind: 'parse', key: 'a', text })
  host.handle({ kind: 'parse', key: 'b', text })
  // A bake uses 'a', so 'b' is the oldest use when 'c' arrives.
  host.handle(bakeMessage(1, BUSY, 33, 1, { key: 'a', amount: 1 }))
  host.handle({ kind: 'parse', key: 'c', text })
  assert.deepEqual(host.looks(), ['a', 'c'])
  assert.equal(host.handle({ kind: 'drop', key: 'a' }), null, 'drop has no reply')
  assert.deepEqual(host.looks(), ['c'])
})

test('init: the tuning reaches every later bake', () => {
  const host = createGradeBakeHost()
  const state = grade({ temperature: 60 })
  const stock = host.handle(bakeMessage(1, state, 17))!.reply as { out: ArrayBuffer }
  assert.deepEqual(new Uint16Array(stock.out), bakeGradeTexels(state, null, 17).texels)
  const tuning = { ...DEFAULT_GRADE_TUNING, tempStops: 1 }
  assert.equal(host.handle({ kind: 'init', tuning }), null)
  const tuned = host.handle(bakeMessage(2, state, 17))!.reply as { out: ArrayBuffer }
  assert.deepEqual(new Uint16Array(tuned.out), bakeGradeTexels(state, null, 17, 1, undefined, { tuning }).texels)
  assert.notDeepEqual(new Uint16Array(tuned.out), new Uint16Array(stock.out))
})

test('the editor\'s loop against the host as a worker: transfers, pool, one upload, nothing it holds detached', () => {
  const n = 33
  const host = createGradeBakeHost()
  const pool = createBufferPool(n)
  let texture: Uint16Array = identityTexels(n).slice() // what lut.image.data holds
  const inbox: BakeMessage[] = [] // the worker's queue, after the transfer
  const scheduler = createBakeScheduler({
    post: (message) => { inbox.push(across(message, [message.out])) },
    draftThresholdMs: 8,
    take: () => pool.take(),
    give: (buffer) => { pool.give(buffer) },
  })
  let pending: BakeResult | null = null
  /** The worker answers one job; the reply's buffer moves back; the editor keeps the newest. */
  const work = () => {
    const message = inbox.shift()!
    const result = host.handle(message)!
    const reply = across(result.reply, result.transfer)
    assert.equal(reply.kind, 'baked')
    if (reply.kind !== 'baked') return
    const applied = scheduler.onResult(reply)
    if (applied) {
      if (pending) pool.give(pending.texels.buffer)
      pending = applied
    }
  }
  /** update(): one upload, the replaced array to the pool. */
  const update = () => {
    if (!pending) return
    const replaced = texture
    texture = pending.texels
    pending = null
    pool.give(replaced.buffer)
  }
  const steps = [0.5, 0.8, 1.2, 1.5, 1.7]
  for (const saturation of steps) scheduler.request({ state: grade({ saturation }), look: null, n })
  while (inbox.length) work()
  update()
  scheduler.request({ state: grade({ saturation: 1.7 }), look: null, n }, { commit: true })
  while (inbox.length) work()
  update()
  assert.deepEqual(texture, bakeGradeTexels(grade({ saturation: 1.7 }), null, n).texels, 'the texture shows the newest grade')
  assert.equal(identityTexels(n).buffer.byteLength, 8 * n ** 3, 'the identity cache is never detached')
  assert.equal(texture.buffer.byteLength, 8 * n ** 3, 'the texture\'s array is never detached')
  assert.ok(pool.count >= 1, 'replaced arrays are recycled')
})
