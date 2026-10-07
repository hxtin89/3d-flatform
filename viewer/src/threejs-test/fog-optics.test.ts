import assert from 'node:assert/strict'
import test from 'node:test'
import { draine, extinctionForVisibility, henyeyGreenstein, miePhase, miePhaseParameters, rayleighPhase } from './fog-optics.ts'

/** ∫ p dω over the sphere (azimuth integrates to 2π). The midpoint rule runs in u with
 *  cosθ = 1 − 2u⁴, which packs samples into the forward peak: fog droplets' Mie lobe is
 *  narrower there than a uniform grid in cosθ can resolve. */
const sphereIntegral = (p: (cosTheta: number) => number, n = 400_000) => {
  let sum = 0
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n
    sum += p(1 - 2 * u ** 4) * 8 * u ** 3
  }
  return (sum / n) * 2 * Math.PI
}

test('every phase function integrates to 1', () => {
  for (const g of [0, 0.3, 0.8]) assert.ok(Math.abs(sphereIntegral((c) => henyeyGreenstein(c, g)) - 1) < 1e-3, `HG ${g}`)
  for (const [g, a] of [[0.2, 1], [0.5, 20], [0.6, 250]]) assert.ok(Math.abs(sphereIntegral((c) => draine(c, g, a)) - 1) < 1e-3, `Draine ${g} ${a}`)
  assert.ok(Math.abs(sphereIntegral(rayleighPhase) - 1) < 1e-6)
  for (const d of [2, 5, 10, 20, 40]) assert.ok(Math.abs(sphereIntegral((c) => miePhase(c, d)) - 1) < 2e-3, `Mie ${d} µm`)
})

test('fog droplets scatter strongly forward', () => {
  for (const d of [5, 10, 20]) {
    const p = miePhaseParameters(d)
    assert.ok(p.gHG > 0.9 && p.gHG < 1, `gHG ${p.gHG} at ${d} µm`)
    assert.ok(p.wD > 0 && p.wD < 1)
    // Forward peak far above the back direction, as Mie predicts for droplets this size.
    assert.ok(miePhase(1, d) / miePhase(-1, d) > 100)
  }
})

test('Koschmieder visibility', () => {
  assert.ok(Math.abs(extinctionForVisibility(1000) - 0.003912) < 1e-9)
})
