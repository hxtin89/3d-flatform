import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { PointHeightProbe, heightPercentile } from '../../threejs-test/point-height-probe'

describe('indexed canopy sampling', () => {
  it('matches raw transformed samples, including cell and footprint edges', () => {
    const raw: number[] = []
    for (let y = -64; y <= 64; y += 4) for (let x = -64; x <= 64; x += 4) raw.push(x, y, 30 + Math.sin(x) * 10)
    const attribute = new THREE.Float32BufferAttribute(raw, 3)
    const matrix = new THREE.Matrix4().makeRotationZ(.4).setPosition(123, -456, 12)
    const probe = new PointHeightProbe(attribute, matrix, 6000)
    const support = new Uint8Array(25)
    const heights: number[] = []
    probe.collect(123, -456, 60, heights, support)
    const expected: number[] = []
    const point = new THREE.Vector3()
    for (let i = 0; i < attribute.count; i++) {
      point.fromBufferAttribute(attribute, i).applyMatrix4(matrix)
      if (Math.abs(point.x - 123) <= 60 && Math.abs(point.y + 456) <= 60) expected.push(point.z)
    }
    expect(heights.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b))
    expect([...support].every(Boolean)).toBe(true)
    expect(probe.matches(matrix.clone().setPosition(123, -456, 13))).toBe(false)
    expect(probe.matches(matrix.clone().setPosition(123 + 1e-9, -456, 12))).toBe(true)
    const outside: number[] = []
    probe.collect(1000, 1000, 20, outside, support)
    expect(outside).toEqual([])
  })

  it('selects exact percentiles with repeated heights and already sorted inputs', () => {
    for (const values of [Array.from({ length: 30001 }, (_, i) => Math.sin(i) * 17),
      Array.from({ length: 6000 }, (_, i) => i), Array(6000).fill(42)]) {
      const sorted = values.slice().sort((a, b) => a - b)
      for (const p of [0, .02, .5, .95, 1]) {
        expect(heightPercentile(values, p)).toBe(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))])
      }
    }
  })
})
