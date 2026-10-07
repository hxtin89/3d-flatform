import assert from 'node:assert/strict'
import test from 'node:test'
import { bakeCloudShapeNoise, bakeCloudWeatherNoise, perlin3, worley3 } from './sky-cloud-noise.ts'

test('the 3D noises wrap at their period', () => {
  for (const [x, y, z] of [[0.3, 1.7, 2.2], [3.9, 0.1, 0.5]]) {
    assert.ok(Math.abs(perlin3(x, y, z, 4, 3) - perlin3(x + 4, y - 4, z + 8, 4, 3)) < 1e-9)
    assert.ok(Math.abs(worley3(x, y, z, 4, 3) - worley3(x + 4, y + 4, z - 4, 4, 3)) < 1e-9)
  }
})

/** Mean absolute step between neighbours along x inside the tile and across its seam. */
const seam = (data: Uint8Array, size: number, channels: number, depth = 1) => {
  let inner = 0; let across = 0; let n = 0
  for (let z = 0; z < depth; z++) for (let y = 0; y < size; y++) {
    const row = (z * size + y) * size
    inner += Math.abs(data[(row + size / 2) * channels] - data[(row + size / 2 + 1) * channels])
    across += Math.abs(data[(row + size - 1) * channels] - data[row * channels])
    n++
  }
  return { inner: inner / n, across: across / n }
}

test('the baked textures have no seam at the wrap', () => {
  const size = 24
  const shape = bakeCloudShapeNoise(size, 7)
  const s = seam(shape, size, 2, size)
  assert.ok(s.across < s.inner * 2.5 + 2, `shape ${JSON.stringify(s)}`)
  const weather = bakeCloudWeatherNoise(64, 11)
  const w = seam(weather, 64, 4)
  assert.ok(w.across < w.inner * 2.5 + 2, `weather ${JSON.stringify(w)}`)
})

test('the noises span their range', () => {
  const shape = bakeCloudShapeNoise(24, 7)
  let lo = 255; let hi = 0
  for (let i = 0; i < shape.length; i += 2) { lo = Math.min(lo, shape[i]); hi = Math.max(hi, shape[i]) }
  assert.ok(hi - lo > 120, `${lo}…${hi}`)
})
