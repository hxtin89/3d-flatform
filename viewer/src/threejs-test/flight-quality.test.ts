import assert from 'node:assert/strict'
import test from 'node:test'
import { EXPERIENCE_CONFIG } from './config.ts'
import { flightSseFloor } from './flight-quality.ts'

const { flightSse, flightSseRampMs, aphDetailSse } = EXPERIENCE_CONFIG.lod
const floor = (msSinceLanding: number, targetSse = aphDetailSse, flying = false) =>
  flightSseFloor({ flying, msSinceLanding, targetSse })

test('the flight is pinned to the coarse floor regardless of elapsed time', () => {
  assert.equal(floor(0, aphDetailSse, true), flightSse)
  assert.equal(floor(99_999, aphDetailSse, true), flightSse)
})

test('the ramp starts at the flight floor and releases after its duration', () => {
  assert.ok(Math.abs(floor(0) - flightSse) < 1e-9)
  assert.equal(floor(flightSseRampMs), 0)
  assert.equal(floor(flightSseRampMs * 10), 0)
})

test('the ramp falls monotonically and passes the midpoint in log space', () => {
  const steps = Array.from({ length: 21 }, (_, i) => floor((flightSseRampMs * i) / 20))
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] <= steps[i - 1], `step ${i} rose`)

  // Halfway through, smoothstep is exactly 0.5, so log-interpolation lands on
  // the geometric mean — the point of ramping in log space rather than linearly.
  const half = floor(flightSseRampMs / 2)
  assert.ok(Math.abs(half - Math.sqrt(flightSse * aphDetailSse)) < 1e-9)
})

test('the ramp always stays between its two endpoints', () => {
  // With a coarse target (camera still far out on landing) the ramp rises from
  // flightSse toward it instead of falling. That is harmless — the caller takes
  // Math.max(quality.sse, floor) — but it must never overshoot either end, or
  // the floor would dictate a density neither the flight nor the camera asked
  // for.
  for (const target of [4, 8, 16, 64, 256]) {
    const lo = Math.min(flightSse, target)
    const hi = Math.max(flightSse, target)
    for (let i = 0; i <= 10; i++) {
      const value = floor((flightSseRampMs * i) / 10, target)
      if (value === 0) continue // released: no floor at all
      assert.ok(value >= lo - 1e-9 && value <= hi + 1e-9, `floor ${value} left [${lo}, ${hi}]`)
    }
  }
})
