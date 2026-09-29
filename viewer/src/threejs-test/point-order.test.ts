import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import {
  isPackedPositionView, makePointDataTexture, packPointData, pointDataLength, pointDataRows,
  POINT_DATA_WIDTH, textureFromPackedView, unpackPointData,
} from './dot-geometry.ts'
import {
  adoptPointData, computeCarrierBounds, fastPointLayout, newPointBounds, packPointsForPulling,
  pointDataForCarrier, PREFIX_SAMPLE_ROUNDS, reorderAccepts, reorderForPrefixSampling,
  restoreCarrierArrays, type PointBounds,
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

// ---- Carrier bounds from the arrival passes: three's own box and sphere, bit for bit.

/** three's own box and sphere for an attribute, on a throwaway geometry. */
function threeBounds(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): PointBounds {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', position)
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return { box: g.boundingBox!, sphere: g.boundingSphere! }
}

function carrierBounds(carrier: THREE.BufferGeometry): PointBounds {
  return { box: carrier.boundingBox!, sphere: carrier.boundingSphere! }
}

/** Object.is on every double: tells -0 from +0 and matches NaN with NaN. */
function sameBounds(got: PointBounds, want: PointBounds, message: string) {
  const pairs: [string, number, number][] = [
    ['min.x', got.box.min.x, want.box.min.x], ['min.y', got.box.min.y, want.box.min.y],
    ['min.z', got.box.min.z, want.box.min.z], ['max.x', got.box.max.x, want.box.max.x],
    ['max.y', got.box.max.y, want.box.max.y], ['max.z', got.box.max.z, want.box.max.z],
    ['centre.x', got.sphere.center.x, want.sphere.center.x],
    ['centre.y', got.sphere.center.y, want.sphere.center.y],
    ['centre.z', got.sphere.center.z, want.sphere.center.z],
    ['radius', got.sphere.radius, want.sphere.radius],
  ]
  for (const [name, a, b] of pairs) {
    if (!Object.is(a, b)) assert.fail(`${message}: ${name} ${a} vs three ${b}`)
  }
}

test('the instanced reorder leaves three\'s own bounds, bit for bit', () => {
  for (const layout of LAYOUTS) {
    for (const n of SIZES) {
      const { position, color } = tile(n, layout)
      const bounds = newPointBounds()
      const arrays = reorderForPrefixSampling(position, color, bounds)
      if (!arrays) { assert.ok(!reorderAccepts(position, color), `${layout} ${n}`); continue }
      sameBounds(bounds, threeBounds(new THREE.BufferAttribute(arrays.position, 3)), `${layout} ${n}`)
      // A permutation cannot move them: the same bits as the tile as it arrived.
      sameBounds(bounds, threeBounds(position), `${layout} ${n} vs arrival order`)
    }
  }
})

test('the pulled pack leaves three\'s own bounds on the four-float view, bit for bit', () => {
  for (const layout of LAYOUTS) {
    for (const n of SIZES) {
      for (const rounds of [1, PREFIX_SAMPLE_ROUNDS]) {
        const { position, color } = tile(n, layout)
        const bounds = newPointBounds()
        const texture = packPointsForPulling(position, color, rounds, bounds)!
        const carrier = new THREE.BufferGeometry()
        carrier.setAttribute('position', position)
        if (color) carrier.setAttribute('color', color)
        adoptPointData(carrier, texture, n)
        const view = carrier.getAttribute('position') as THREE.BufferAttribute
        assert.equal(view.itemSize, 4)
        sameBounds(bounds, threeBounds(view), `${layout} ${n} rounds ${rounds}`)
        sameBounds(bounds, threeBounds(position), `${layout} ${n} rounds ${rounds} vs tight`)
      }
    }
  }
})

test('the standalone pass matches three for tight, packed and declined layouts', () => {
  const n = 5000
  const { position, color } = tile(n, 'rgb')
  const cases: [string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute][] = [
    ['tight xyz', position],
    ['two points', tile(2, 'none').position],
    ['empty', tile(0, 'none').position],
    ['int16', new THREE.BufferAttribute(Int16Array.from({ length: n * 3 }, (_, i) => (i * 7919) % 65536 - 32768), 3)],
    ['normalised uint16', new THREE.BufferAttribute(Uint16Array.from({ length: n * 3 }, (_, i) => (i * 104729) % 65536), 3, true)],
    ['interleaved', new THREE.InterleavedBufferAttribute(
      new THREE.InterleavedBuffer(Float32Array.from({ length: n * 5 }, (_, i) => Math.sin(i) * 300), 5), 3, 1)],
  ]
  const carrierForView = new THREE.BufferGeometry()
  adoptPointData(carrierForView, packPointsForPulling(position, color, 1)!, n)
  cases.push(['four-float view', carrierForView.getAttribute('position') as THREE.BufferAttribute])
  for (const [label, attribute] of cases) {
    const carrier = new THREE.BufferGeometry()
    carrier.setAttribute('position', attribute)
    computeCarrierBounds(carrier)
    sameBounds(carrierBounds(carrier), threeBounds(attribute), label)
  }
})

test('edge values: signed zeros, one repeated point, NaN', () => {
  const quiet = console.error
  console.error = () => {} // three reports NaN bounds; the passes here stay silent
  try {
    for (const [label, values] of [
      ['mixed zeros', [-0, 0, -0, 0, -0, 0, -0, -0, -0, 0, 0, 0]],
      ['all -0', [-0, -0, -0, -0, -0, -0]],
      ['one point repeated', [5, -3, 2, 5, -3, 2, 5, -3, 2]],
      ['NaN', [1, 2, 3, NaN, 0, 0, 4, 5, 6, 7, 8, 9]],
    ] as const) {
      const attribute = new THREE.BufferAttribute(new Float32Array(values), 3)
      const want = threeBounds(attribute)
      const carrier = new THREE.BufferGeometry()
      carrier.setAttribute('position', attribute)
      computeCarrierBounds(carrier)
      sameBounds(carrierBounds(carrier), want, `${label} standalone`)
      // Every colour layout: each has its own copy of the min / max tracking.
      for (const items of [3, 4, 0]) {
        const colour = items
          ? new THREE.BufferAttribute(new Uint8Array(attribute.count * items), items, true)
          : undefined
        if (attribute.count > 2) {
          const reordered = newPointBounds()
          assert.ok(reorderForPrefixSampling(attribute, colour, reordered), `${label} colour ${items} reorder`)
          sameBounds(reordered, want, `${label} colour ${items} reorder`)
        }
        const packed = newPointBounds()
        assert.ok(packPointsForPulling(attribute, colour, PREFIX_SAMPLE_ROUNDS, packed), `${label} colour ${items} pack`)
        sameBounds(packed, want, `${label} colour ${items} pack`)
      }
    }
  } finally {
    console.error = quiet
  }
})

test('the radius sums its squares in three\'s order', () => {
  // The centre is a double, so x² + (y² + z²) rounds differently from three's (x² + y²) + z²
  // for some tiles. This one catches the swap, which random tiles of this size mostly miss.
  const values = new Float32Array([
    -28.92697525024414, 146.45704650878906, 25.471969604492188, 149.40966796875,
    -46.40584182739258, 138.67205810546875, 138.80718994140625, 265.39971923828125,
    262.6545715332031, 132.5719757080078, -12.627032279968262, 207.95069885253906,
    147.39988708496094, 213.2898406982422, 104.0223159790039,
  ])
  const attribute = new THREE.BufferAttribute(values, 3)
  const want = threeBounds(attribute)
  const carrier = new THREE.BufferGeometry()
  carrier.setAttribute('position', attribute)
  computeCarrierBounds(carrier)
  sameBounds(carrierBounds(carrier), want, 'standalone')
  const reordered = newPointBounds()
  reorderForPrefixSampling(attribute, undefined, reordered)
  sameBounds(reordered, want, 'reorder')
  const packed = newPointBounds()
  packPointsForPulling(attribute, undefined, PREFIX_SAMPLE_ROUNDS, packed)
  sameBounds(packed, want, 'pack')
})

test('the arrival bounds still hold after a feed round trip', () => {
  const n = 4000
  const { position, color } = tile(n, 'rgba')
  const bounds = newPointBounds()
  const carrier = new THREE.BufferGeometry()
  carrier.setAttribute('position', position)
  carrier.setAttribute('color', color!)
  adoptPointData(carrier, packPointsForPulling(position, color, PREFIX_SAMPLE_ROUNDS, bounds)!, n)
  restoreCarrierArrays(carrier, true)
  sameBounds(bounds, threeBounds(carrier.getAttribute('position')), 'after restore')
})

test('asking for bounds changes no output bit', () => {
  for (const layout of LAYOUTS) {
    const { position, color } = tile(3001, layout)
    const a = packPointsForPulling(position, color, PREFIX_SAMPLE_ROUNDS)!.image.data as Float32Array
    const b = packPointsForPulling(position, color, PREFIX_SAMPLE_ROUNDS, newPointBounds())!.image.data as Float32Array
    sameBits(a, b, `${layout} pack`)
    const r1 = reorderForPrefixSampling(position, color)!
    const r2 = reorderForPrefixSampling(position, color, newPointBounds())!
    sameBits(r1.position, r2.position, `${layout} reorder positions`)
    assert.deepEqual(r1.color, r2.color, `${layout} reorder colours`)
  }
})
