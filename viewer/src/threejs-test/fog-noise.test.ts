import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bakeFogNoise, bakeFogNoise3D, bakeLayer, DRIFT_PERIOD, fbm2, finishLayer, NOISE_KINDS, perlin2, ridged2, RISE_PERIOD,
  sampleLayer, value2, WISP_2D_SHEAR_X, WISP_2D_SHEAR_Y, WISP_3D_FINE_Z_SCALE, WISP_3D_Z_SCALE, WISP_FINE_SCALE,
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

// The wind and the rise reach the march as offsets wrapped on the CPU (ground-fog.ts). When one
// jumps back by its period, every read built on it must move by whole tiles, or the fog would
// visibly jump once per wrap — minutes apart, so easy to miss by eye.
test('the wind and rise wrap periods move every noise read by whole tiles', () => {
  const whole = (x: number) => Math.abs(x - Math.round(x)) < 1e-9
  // Scale 1: the coverage, billow and erosion reads and the coarse wisp octave; for the rise,
  // the '2d' source's slice hash, which repeats every RISE_PERIOD slices.
  assert.ok(Number.isInteger(DRIFT_PERIOD), `DRIFT_PERIOD ${DRIFT_PERIOD}`)
  assert.ok(Number.isInteger(RISE_PERIOD), `RISE_PERIOD ${RISE_PERIOD}`)
  const reads: [string, number, number][] = [
    ['finer wisp octave, drift', DRIFT_PERIOD, WISP_FINE_SCALE],
    ['3D texture z, coarse octave', RISE_PERIOD, WISP_3D_Z_SCALE],
    ['3D texture z, finer octave', RISE_PERIOD, WISP_3D_FINE_Z_SCALE],
    ['2D finer octave shear, x', RISE_PERIOD, WISP_2D_SHEAR_X],
    ['2D finer octave shear, y', RISE_PERIOD, WISP_2D_SHEAR_Y],
  ]
  for (const [read, period, scale] of reads) assert.ok(whole(period * scale), `${read}: ${period} × ${scale} = ${period * scale}`)
  // The scales the periods were chosen for (10 × 2.3 = 23; 16 × 0.25, 0.5625, 0.625, 0.5 = 4, 9,
  // 10, 8): a changed scale has to be checked against its period again.
  assert.deepEqual(
    [WISP_FINE_SCALE, WISP_3D_Z_SCALE, WISP_3D_FINE_Z_SCALE, WISP_2D_SHEAR_X, Math.abs(WISP_2D_SHEAR_Y)],
    [2.3, 0.25, 0.5625, 0.625, 0.5],
  )
  // And the check bites: a rise period of 12 would leave the finer 3D read 6.75 tiles along.
  assert.equal(whole(12 * WISP_3D_FINE_Z_SCALE), false)
})
