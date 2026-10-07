import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bakeFogNoise, bakeFogNoise3D, bakeLayer, fbm2, finishLayer, NOISE_KINDS, perlin2, ridged2, sampleLayer, value2,
  worley2, type NoiseLayerSettings,
} from './fog-noise.ts'

const layer = (over: Partial<NoiseLayerSettings> = {}): NoiseLayerSettings => ({
  kind: 'perlin', period: 4, octaves: 3, gain: 0.5, seed: 1, warp: 0, contrast: 1, invert: false, ...over,
})

// A tile edge must continue into the opposite edge, or RepeatWrapping shows a seam.
test('every noise kind tiles in u and v', () => {
  for (const noise of [perlin2, value2, worley2, ridged2]) {
    for (const t of [0, 0.13, 0.5, 0.87]) {
      assert.ok(Math.abs(fbm2(noise, 0, t, 5, 4, 3) - fbm2(noise, 1, t, 5, 4, 3)) < 1e-9)
      assert.ok(Math.abs(fbm2(noise, t, 0, 5, 4, 3) - fbm2(noise, t, 1, 5, 4, 3)) < 1e-9)
    }
  }
})

test('every kind still tiles when warped', () => {
  for (const kind of NOISE_KINDS) {
    const l = layer({ kind, warp: 1.5, period: 5 })
    for (const t of [0, 0.21, 0.5, 0.77]) {
      assert.ok(Math.abs(sampleLayer(l, 0, t) - sampleLayer(l, 1, t)) < 1e-9, `${kind} u seam`)
      assert.ok(Math.abs(sampleLayer(l, t, 0) - sampleLayer(l, t, 1)) < 1e-9, `${kind} v seam`)
    }
    assert.equal(bakeLayer(8, l).length, 64)
  }
})

test('finishLayer normalises, applies contrast and invert', () => {
  const raw = new Float32Array([2, 4, 6])
  assert.deepEqual([...finishLayer(raw, layer())], [0, 0.5, 1])
  assert.deepEqual([...finishLayer(raw, layer({ contrast: 2 }))], [0, 0.25, 1])
  assert.deepEqual([...finishLayer(raw, layer({ invert: true }))], [1, 0.5, 0])
})

test('the four channels are independent and span the range', () => {
  const size = 48
  const layers = [
    layer({ kind: 'perlin', period: 4, octaves: 5, seed: 1 }),
    layer({ kind: 'worley', period: 6, octaves: 3, seed: 7, gain: 0.45 }),
    layer({ kind: 'perlin', period: 16, octaves: 4, seed: 13 }),
    layer({ kind: 'worley', period: 12, octaves: 2, seed: 29 }),
  ] as [NoiseLayerSettings, NoiseLayerSettings, NoiseLayerSettings, NoiseLayerSettings]
  const data = bakeFogNoise({ size, layers })
  assert.equal(data.length, size * size * 4)
  const channel = (c: number) => Float32Array.from({ length: size * size }, (_, i) => data[i * 4 + c])
  const chans = [0, 1, 2, 3].map(channel)
  for (const ch of chans) { assert.equal(Math.min(...ch), 0); assert.equal(Math.max(...ch), 255) }
  const corr = (a: Float32Array, b: Float32Array) => {
    const n = a.length; let ma = 0; let mb = 0
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i] }
    ma /= n; mb /= n
    let sab = 0; let saa = 0; let sbb = 0
    for (let i = 0; i < n; i++) { const da = a[i] - ma; const db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db }
    return sab / Math.sqrt(saa * sbb)
  }
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) assert.ok(Math.abs(corr(chans[i], chans[j])) < 0.5)
})

test('the 3D baseline tiles along x, y and z', () => {
  const size = 32
  const data = bakeFogNoise3D(size)
  assert.equal(data.length, size ** 3)
  assert.equal(Math.min(...data), 0)
  assert.equal(Math.max(...data), 255)
  // The step across the wrap (last texel to the first) must look like a step between two
  // neighbours inside; a lattice that does not wrap would make it a jump to unrelated noise.
  const at = (x: number, y: number, z: number) => data[x + y * size + z * size * size]
  const meanStep = (axis: 0 | 1 | 2, from: number, to: number) => {
    let sum = 0
    for (let a = 0; a < size; a++) for (let b = 0; b < size; b++) {
      const p = [a, b] as const
      const coords = (c: number) => axis === 0 ? [c, p[0], p[1]] : axis === 1 ? [p[0], c, p[1]] : [p[0], p[1], c]
      const [x0, y0, z0] = coords(from); const [x1, y1, z1] = coords(to)
      sum += Math.abs(at(x0, y0, z0) - at(x1, y1, z1))
    }
    return sum / (size * size)
  }
  for (const axis of [0, 1, 2] as const) {
    let inside = 0
    for (let c = 0; c < size - 1; c++) inside += meanStep(axis, c, c + 1)
    inside /= size - 1
    assert.ok(meanStep(axis, size - 1, 0) < inside * 2, `axis ${axis}: wrap step ${meanStep(axis, size - 1, 0)} vs ${inside}`)
  }
})
