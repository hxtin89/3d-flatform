import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import {
  isPackedPositionView, makePointDataTexture, packPointData, pointDataLength, pointDataRows,
  POINT_DATA_WIDTH, textureFromPackedView, unpackPointData,
} from './dot-geometry.ts'
import {
  adoptPointData, fastPointLayout, packPointsForPulling, pointDataForCarrier,
  PREFIX_SAMPLE_ROUNDS, reorderAccepts, reorderForPrefixSampling, restoreCarrierArrays,
} from './point-order.ts'

// Deterministic pseudo-random tile data: positions spread over a few hundred metres, colours
// over the full byte range, both as views into one shared buffer at non-zero offsets, the
// way the PNTS loader hands them over.
function tile(count: number, colour: 'rgb' | 'rgba' | 'none') {
  let seed = count * 2654435761 >>> 0
  const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  const colourBytes = colour === 'rgb' ? 3 : colour === 'rgba' ? 4 : 0
  const buffer = new ArrayBuffer(16 + count * 12 + count * colourBytes + 8)
  const positions = new Float32Array(buffer, 16, count * 3)
  for (let i = 0; i < positions.length; i++) positions[i] = (next() - 0.5) * 400
  const position = new THREE.BufferAttribute(positions, 3)
  let color: THREE.BufferAttribute | undefined
  if (colourBytes) {
    const bytes = new Uint8Array(buffer, 16 + count * 12, count * colourBytes)
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256)
    color = new THREE.BufferAttribute(bytes, colourBytes, true)
  }
  return { position, color }
}

function reorderedReference(position: THREE.BufferAttribute, color: THREE.BufferAttribute | undefined) {
  const arrays = reorderForPrefixSampling(position, color)
  if (!arrays) return packPointData(position, color)
  return packPointData(
    new THREE.BufferAttribute(arrays.position, 3),
    arrays.color ? new THREE.BufferAttribute(arrays.color, 4, true) : undefined,
  )
}

function sameBits(a: Float32Array, b: Float32Array, message: string) {
  assert.equal(a.length, b.length, `${message}: length`)
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length)
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length)
  for (let i = 0; i < ua.length; i++) {
    if (ua[i] !== ub[i]) assert.fail(`${message}: float ${i} differs (${a[i]} vs ${b[i]})`)
  }
}

const SIZES = [0, 1, 2, 3, 61, 62, 122, 123, 1023, 1024, 1025, 75_000]
const LAYOUTS = ['rgb', 'rgba', 'none'] as const

test('the fused pass equals reorder-then-pack, bit for bit', () => {
  for (const layout of LAYOUTS) {
    for (const n of SIZES) {
      const { position, color } = tile(n, layout)
      const order = reorderAccepts(position, color)
      const fused = packPointsForPulling(position, color, order ? PREFIX_SAMPLE_ROUNDS : 1)
      assert.ok(fused, `${layout} ${n}: fused pass declined`)
      sameBits(fused!.image.data as Float32Array, reorderedReference(position, color).image.data as Float32Array, `${layout} ${n}`)
    }
  }
})

test('one round keeps the arrival order, the same texels as packing the raw arrays', () => {
  for (const layout of LAYOUTS) {
    for (const n of [0, 5, 1025, 20_000]) {
      const { position, color } = tile(n, layout)
      const fused = packPointsForPulling(position, color, 1)!
      sameBits(fused.image.data as Float32Array, packPointData(position, color).image.data as Float32Array, `${layout} ${n}`)
    }
  }
})

test('the moved reorder is the plain round-robin permutation', () => {
  const n = 1000
  const { position, color } = tile(n, 'rgb')
  const arrays = reorderForPrefixSampling(position, color)!
  const rounds = Math.min(PREFIX_SAMPLE_ROUNDS, n)
  const source = position.array as Float32Array
  const bytes = color!.array as Uint8Array
  let w = 0
  for (let r = 0; r < rounds; r++) {
    for (let i = r; i < n; i += rounds, w++) {
      for (let k = 0; k < 3; k++) {
        assert.equal(arrays.position[w * 3 + k], source[i * 3 + k])
        assert.equal(arrays.color![w * 4 + k], bytes[i * 3 + k])
      }
      assert.equal(arrays.color![w * 4 + 3], 255)
    }
  }
  assert.equal(w, n)
})

test('layouts outside the fast path are declined, and small tiles are not reordered', () => {
  const n = 100
  const ints = new THREE.BufferAttribute(new Int16Array(n * 3), 3)
  const wide = new THREE.BufferAttribute(new Float32Array(n * 4), 4)
  const { position, color } = tile(n, 'rgb')
  const floatColour = new THREE.BufferAttribute(new Float32Array(n * 3), 3)
  const interleaved = new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Float32Array(n * 4), 4), 3, 0)
  const interleavedColour = new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Uint8Array(n * 4), 4), 3, 0)
  for (const [p, c, label] of [
    [ints, color, 'int16 positions'], [wide, color, 'four-float positions'], [position, floatColour, 'float colour'],
    [interleaved, color, 'interleaved positions'], [position, interleavedColour, 'interleaved colour'],
  ] as const) {
    assert.equal(fastPointLayout(p as any, c as any), null, label)
    assert.equal(packPointsForPulling(p as any, c as any, PREFIX_SAMPLE_ROUNDS), null, label)
    assert.equal(reorderForPrefixSampling(p as any, c as any), null, label)
  }
  assert.equal(fastPointLayout(position, color), 'rgb')
  for (const small of [0, 1, 2]) assert.equal(reorderAccepts(tile(small, 'rgb').position, undefined), false)
  assert.equal(reorderAccepts(tile(3, 'rgb').position, undefined), true)
})

test('whole padded rows, with the padding left at zero', () => {
  for (const n of [0, 1, 1023, 1024, 1025]) {
    const { position, color } = tile(n, 'rgba')
    const texture = packPointsForPulling(position, color, PREFIX_SAMPLE_ROUNDS)!
    const data = texture.image.data as Float32Array
    assert.equal(data.length, POINT_DATA_WIDTH * pointDataRows(n) * 4)
    assert.equal(data.length, pointDataLength(n))
    assert.equal(texture.image.width, POINT_DATA_WIDTH)
    assert.equal(texture.image.height, pointDataRows(n))
    for (let i = n * 4; i < data.length; i++) assert.equal(data[i], 0, `padding float ${i}`)
  }
})

test('the adopted carrier is a four-float view of exactly its points', () => {
  const n = 5000
  const { position, color } = tile(n, 'rgb')
  const reference = new THREE.BufferGeometry()
  reference.setAttribute('position', position.clone())
  reference.computeBoundingSphere()

  const carrier = new THREE.BufferGeometry()
  carrier.setAttribute('position', position)
  carrier.setAttribute('color', color!)
  carrier.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  const texture = packPointsForPulling(position, color, 1)!
  adoptPointData(carrier, texture, n)

  const view = carrier.getAttribute('position') as THREE.BufferAttribute
  assert.equal(view.itemSize, 4)
  assert.equal(view.count, n, 'no padding texels in the view')
  assert.ok(isPackedPositionView(view))
  assert.equal(view.array.buffer, (texture.image.data as Float32Array).buffer, 'shares the texture array')
  assert.deepEqual(Object.keys(carrier.attributes), ['position'], 'every other attribute released')
  for (const i of [0, 1, 777, n - 1]) {
    assert.equal(view.getX(i), position.getX(i))
    assert.equal(view.getY(i), position.getY(i))
    assert.equal(view.getZ(i), position.getZ(i))
  }
  carrier.computeBoundingSphere()
  assert.ok(carrier.boundingSphere!.equals(reference.boundingSphere!), 'same bounds as the tight array')
})

test('restoring gives back the instanced arrival arrays', () => {
  const n = 3000
  for (const layout of ['rgb', 'rgba', 'none'] as const) {
    const { position, color } = tile(n, layout)
    const arrays = reorderForPrefixSampling(position, color)!
    const carrier = new THREE.BufferGeometry()
    carrier.setAttribute('position', position)
    if (color) carrier.setAttribute('color', color)
    adoptPointData(carrier, packPointsForPulling(position, color, PREFIX_SAMPLE_ROUNDS)!, n)

    assert.equal(restoreCarrierArrays(carrier, color !== undefined), true)
    const restored = carrier.getAttribute('position')
    assert.equal(restored.itemSize, 3)
    assert.deepEqual(restored.array, arrays.position, `${layout}: positions`)
    const restoredColour = carrier.getAttribute('color')
    if (!color) {
      assert.equal(restoredColour, undefined, 'no colour is invented')
      continue
    }
    assert.equal(restoredColour.itemSize, 4)
    assert.equal(restoredColour.normalized, true)
    const got = restoredColour.array as Uint8Array
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) assert.equal(got[i * 4 + k], arrays.color![i * 4 + k], `${layout}: colour ${i}.${k}`)
      // The texture carries no alpha; the instanced graph never reads it.
      assert.equal(got[i * 4 + 3], 255)
      if (layout === 'rgb') assert.equal(got[i * 4 + 3], arrays.color![i * 4 + 3])
    }
    assert.equal(restoreCarrierArrays(carrier, true), false, 'nothing left to undo')
  }
})

test('a round trip through the instanced feed packs the same texture again', () => {
  const n = 4000
  const { position, color } = tile(n, 'rgb')
  const carrier = new THREE.BufferGeometry()
  carrier.setAttribute('position', position)
  carrier.setAttribute('color', color!)
  const arrival = packPointsForPulling(position, color, PREFIX_SAMPLE_ROUNDS)!
  const arrivalData = (arrival.image.data as Float32Array).slice()
  adoptPointData(carrier, arrival, n)
  restoreCarrierArrays(carrier, true)
  const again = pointDataForCarrier(carrier)
  sameBits(again.image.data as Float32Array, arrivalData, 'identity pack after a restore')
  assert.equal(carrier.getAttribute('position').array.buffer, (again.image.data as Float32Array).buffer, 'adopted again')
})

test('a packed carrier is wrapped again without a copy', () => {
  const n = 1500
  const { position, color } = tile(n, 'rgb')
  const carrier = new THREE.BufferGeometry()
  carrier.setAttribute('position', position)
  carrier.setAttribute('color', color!)
  const texture = packPointsForPulling(position, color, 1)!
  adoptPointData(carrier, texture, n)
  const view = carrier.getAttribute('position') as THREE.BufferAttribute
  const again = pointDataForCarrier(carrier)
  assert.equal((again.image.data as Float32Array).buffer, view.array.buffer)
  assert.equal((again.image.data as Float32Array).length, pointDataLength(n))
  assert.equal(carrier.getAttribute('position'), view, 'the carrier keeps its view')

  // A view that does not start its buffer is copied into a fresh padded array.
  const offset = new Float32Array(8 + n * 4)
  offset.set((texture.image.data as Float32Array).subarray(0, n * 4), 8)
  const shifted = new THREE.BufferAttribute(offset.subarray(8), 4)
  const copied = textureFromPackedView(shifted)
  assert.notEqual((copied.image.data as Float32Array).buffer, offset.buffer)
  sameBits((copied.image.data as Float32Array), texture.image.data as Float32Array, 'copied texels')
})

test('the packed colour decodes back to the source bytes', () => {
  const n = 2048
  const { position, color } = tile(n, 'rgb')
  const texture = packPointsForPulling(position, color, 1)!
  const view = new THREE.BufferAttribute((texture.image.data as Float32Array).subarray(0, n * 4), 4)
  const { color: decoded } = unpackPointData(view, true)
  const source = color!.array as Uint8Array
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) assert.equal(decoded![i * 4 + k], source[i * 3 + k])
  }
})

test('every point-data texture is made the same way', () => {
  const { position, color } = tile(300, 'rgb')
  const textures = [
    packPointsForPulling(position, color, PREFIX_SAMPLE_ROUNDS)!,
    packPointData(position, color),
    makePointDataTexture(new Float32Array(pointDataLength(300)), 300),
  ]
  for (const t of textures) {
    assert.equal(t.format, THREE.RGBAFormat)
    assert.equal(t.type, THREE.FloatType)
    assert.equal(t.minFilter, THREE.NearestFilter)
    assert.equal(t.magFilter, THREE.NearestFilter)
    assert.equal(t.generateMipmaps, false)
    assert.equal(t.flipY, false)
    assert.equal(t.matrixAutoUpdate, false)
    assert.equal(t.name, 'cloudPointData')
    assert.equal(t.userData.cloudPointData, true)
    assert.equal(t.wrapS, textures[0].wrapS)
    assert.equal(t.wrapT, textures[0].wrapT)
  }
})
