import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createStillFrameGate, STILL_FRAME_TOLERANCES, type StillFrameInputs } from './still-frame.ts'

function inputs(overrides: Partial<StillFrameInputs> = {}): StillFrameInputs {
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12.5, -40, -300, 1]
  const projection = [1.2, 0, 0, 0, 0, 1.7, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]
  return { view, projection, errorTarget: 8, spheres: [10, 20, 30, 450], mode: 'mask', ...overrides }
}

/** A copy of the inputs with one view element nudged. */
function nudgedView(index: number, by: number): StillFrameInputs {
  const next = inputs()
  const view = Array.from(next.view)
  view[index] += by
  return { ...next, view }
}

test('the first frame runs, and an unchanged one after it does not', () => {
  const gate = createStillFrameGate()
  assert.equal(gate.decide(inputs(), 0, false, false), true)
  assert.equal(gate.decide(inputs(), 16, false, false), false)
  assert.equal(gate.decide(inputs(), 33, false, false), false)
  assert.deepEqual(gate.stats().byReason.first, 1)
  assert.equal(gate.stats().skipped, 2)
})

test('the camera moving past the tolerance runs it; float noise below it does not', () => {
  const gate = createStillFrameGate()
  gate.decide(inputs(), 0, false, false)
  // Rotation terms: the post-zoom re-decompose moves them by about 1e-9.
  assert.equal(gate.decide(nudgedView(0, 1e-9), 16, false, false), false)
  assert.equal(gate.decide(nudgedView(0, 2e-6), 33, false, false), true)
  // Translation: metres.
  gate.decide(inputs(), 50, false, false)
  assert.equal(gate.decide(nudgedView(13, 0.5e-3), 66, false, false), false)
  assert.equal(gate.decide(nudgedView(13, 2e-3), 83, false, false), true)
})

test('drift is measured against the last run, so it adds up', () => {
  const gate = createStillFrameGate()
  gate.decide(inputs(), 0, false, false)
  // Each step is well under the tolerance, but their sum is not.
  let ran = false
  for (let step = 1; step <= 10 && !ran; step++) ran = gate.decide(nudgedView(12, step * 0.3e-3), step * 16, false, false)
  assert.equal(ran, true)
})

test('the error target, a sphere and a mode switch each run it', () => {
  const gate = createStillFrameGate()
  gate.decide(inputs(), 0, false, false)
  assert.equal(gate.decide(inputs({ errorTarget: 8.5 }), 16, false, false), true)
  assert.equal(gate.decide(inputs({ errorTarget: 8.5, spheres: [10, 20, 30, 450.0005] }), 33, false, false), false)
  assert.equal(gate.decide(inputs({ errorTarget: 8.5, spheres: [10, 20, 30, 451] }), 50, false, false), true)
  assert.equal(gate.decide(inputs({ errorTarget: 8.5, spheres: [10, 20, 30, 451], mode: '' }), 66, false, false), true)
  // A sphere appearing or going is a change even if the numbers match.
  assert.equal(gate.decide(inputs({ errorTarget: 8.5, spheres: [], mode: '' }), 83, false, false), true)
})

test('invalidate runs it exactly once; busy and bypass run it every frame', () => {
  const gate = createStillFrameGate()
  gate.decide(inputs(), 0, false, false)
  gate.invalidate()
  assert.equal(gate.decide(inputs(), 16, false, false), true)
  assert.equal(gate.decide(inputs(), 33, false, false), false)
  assert.equal(gate.decide(inputs(), 50, true, false), true)
  assert.equal(gate.decide(inputs(), 66, true, false), true)
  assert.equal(gate.decide(inputs(), 83, false, true), true)
  assert.equal(gate.decide(inputs(), 100, false, true), true)
  // Coming out of a bypass runs it once more, then it skips again.
  assert.equal(gate.decide(inputs(), 116, false, false), true)
  assert.equal(gate.decide(inputs(), 133, false, false), false)
})

test('the heartbeat reruns it after heartbeatMs of skipping, by time rather than frames', () => {
  const gate = createStillFrameGate()
  const beat = STILL_FRAME_TOLERANCES.heartbeatMs
  gate.decide(inputs(), 0, false, false)
  assert.equal(gate.decide(inputs(), beat - 1, false, false), false)
  assert.equal(gate.decide(inputs(), beat, false, false), true)
  assert.equal(gate.decide(inputs(), beat + 16, false, false), false)
  assert.equal(gate.stats().byReason.heartbeat, 1)
})
