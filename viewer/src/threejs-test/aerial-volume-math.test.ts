import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ATMOSPHERE, PLANET_RADIUS_KM, atmosphereParameters } from './atmosphere-model.ts'
import { AP_N, apSpanKm, edgeKm, sliceWeight, spectralK, texelToUnit, unitToTexel } from './aerial-volume-math.ts'

test('the slice weight is 0 and 1 on the stored edges and linear in distance between them', () => {
  const span = 24
  for (const k of [1, 2, 5, 17, 30]) {
    const a = edgeKm(k, span) * 1000
    const b = edgeKm(k + 1, span) * 1000
    // On edge k the far texel is k (the edge k+1's) with weight 0, i.e. texel k − 1 = edge k.
    const atA = sliceWeight(a + 1e-6, span)
    assert.equal(atA.i0, k)
    assert.ok(atA.w < 1e-6)
    const mid = sliceWeight((a + b) / 2, span)
    assert.equal(mid.i0, k)
    assert.ok(Math.abs(mid.w - 0.5) < 1e-9)
    const q = sliceWeight(a + 0.25 * (b - a), span)
    assert.ok(Math.abs(q.w - 0.25) < 1e-9)
  }
  // The camera end: nothing stored, the near texel is the camera itself.
  assert.deepEqual(sliceWeight(0, span), { i0: 0, w: 0 })
  const half = sliceWeight(edgeKm(1, span) * 500, span)
  assert.equal(half.i0, 0)
  assert.ok(Math.abs(half.w - 0.5) < 1e-9)
  // At and past the range: the last texel, fully.
  assert.deepEqual(sliceWeight(span * 1000, span), { i0: AP_N - 1, w: 1 })
  assert.deepEqual(sliceWeight(span * 5000, span), { i0: AP_N - 1, w: 1 })
})

test('froxel texels are centred on the screen edges and the mapping round-trips', () => {
  assert.ok(Math.abs(unitToTexel(0, AP_N) - 0.5 / AP_N) < 1e-12)
  assert.ok(Math.abs(unitToTexel(1, AP_N) - 31.5 / AP_N) < 1e-12)
  for (const u of [0, 0.1, 0.5, 0.77, 1]) assert.ok(Math.abs(texelToUnit(unitToTexel(u, AP_N), AP_N) - u) < 1e-12)
  // Texel i's centre is screen point i / 31.
  for (const i of [0, 7, 31]) assert.ok(Math.abs(texelToUnit((i + 0.5) / AP_N, AP_N) - i / 31) < 1e-12)
})

test('the range reaches past the horizon, never under the minimum, never past the far plane', () => {
  const g = PLANET_RADIUS_KM
  // Survey: 300 m up, horizon ≈ 62 km; the far plane at 24 km is the limit.
  assert.equal(apSpanKm(g + 0.3, g, 24, 1.1, 32), 24)
  // The same with a far plane beyond: 1.1 × horizon.
  const horizon = Math.sqrt((g + 0.3) ** 2 - g ** 2)
  assert.ok(Math.abs(apSpanKm(g + 0.3, g, 500, 1.1, 32) - 1.1 * horizon) < 1e-9)
  // Close to the ground the minimum holds.
  assert.equal(apSpanKm(g + 0.01, g, 500, 1.1, 32), 32)
  // 18 km up: horizon ≈ 479 km, far 650 km.
  assert.ok(Math.abs(apSpanKm(g + 18, g, 650, 1.1, 32) - Math.min(650, 1.1 * Math.sqrt((g + 18) ** 2 - g ** 2))) < 1e-9)
})

test('the spectral exponents give back the colour transmittance exactly for a constant air mix', () => {
  const model = atmosphereParameters(DEFAULT_ATMOSPHERE)
  const k = spectralK(model, 0)
  // A horizontal ray at the ground: β constant along it.
  const beta = [0, 1, 2].map((c) => model.rayleighScattering[c] + model.mieExtinction[c])
  const lum = 0.2126 * beta[0] + 0.7152 * beta[1] + 0.0722 * beta[2]
  for (const lengthKm of [0.3, 3, 10, 20]) {
    const tL = Math.exp(-lum * lengthKm)
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(tL ** k[c] - Math.exp(-beta[c] * lengthKm)) < 1e-9)
  }
  // Blue goes out faster than red.
  assert.ok(k[2] > k[1] && k[1] > k[0])
  // The luminance weighting is preserved: Σ W·k = 1.
  assert.ok(Math.abs(0.2126 * k[0] + 0.7152 * k[1] + 0.0722 * k[2] - 1) < 1e-12)
})
