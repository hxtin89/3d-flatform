import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import {
  applyDotShape, applyDotShapeToGeometry, buildPulledGeometry, dotAreaFactor, dotCorners,
  drawnPoints, initDotState, loadedPoints, packPointData, POINT_DATA_WIDTH, setDrawnPoints,
  shapeAreaFactor,
} from './dot-geometry.ts'
import { EXPERIENCE_CONFIG } from './config.ts'

// The corners a shape actually draws: the ones its slice of the index references.
const drawnIndex = (g: THREE.BufferGeometry) =>
  Array.from(g.index!.array as ArrayLike<number>).slice(g.drawRange.start, g.drawRange.start + g.drawRange.count)
const corners = (g: THREE.BufferGeometry) => {
  const p = g.getAttribute('position')
  const used = [...new Set(drawnIndex(g))].sort()
  return used.map((i) => [p.getX(i), p.getY(i)] as [number, number])
}
const signedArea = (pts: [number, number][], index: number[]) => {
  let a = 0
  for (let t = 0; t < index.length; t += 3) {
    const [p, q, r] = [pts[index[t]], pts[index[t + 1]], pts[index[t + 2]]]
    a += ((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2
  }
  return a
}
const indexOf = drawnIndex

test('the quad is exactly the corners the viewer has always drawn', () => {
  const g = new THREE.InstancedBufferGeometry()
  applyDotShapeToGeometry(g, 'quad')
  assert.deepEqual(corners(g), [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]])
  assert.deepEqual(Array.from(g.getAttribute('uv').array), [0, 0, 1, 0, 1, 1, 0, 1])
  assert.deepEqual(indexOf(g), [0, 1, 2, 0, 2, 3])
  assert.equal(g.drawRange.count, 6)
  assert.equal(shapeAreaFactor('quad'), 1)
})

test('both shapes are wound counter-clockwise, so FrontSide keeps them', () => {
  for (const shape of ['quad', 'triangle'] as const) {
    const g = new THREE.InstancedBufferGeometry()
    applyDotShapeToGeometry(g, shape)
    assert.ok(signedArea(corners(g), indexOf(g)) > 0, shape)
  }
})

test('the triangle is equilateral around the dot, with a 1 % margin', () => {
  const g = new THREE.InstancedBufferGeometry()
  applyDotShapeToGeometry(g, 'triangle')
  const pts = corners(g)
  assert.equal(pts.length, 3)
  assert.deepEqual(indexOf(g), [0, 1, 2])
  const r = EXPERIENCE_CONFIG.lod.dotGeometry.triInradius
  // Distance from the dot's centre to each edge is the inradius, so the circle of
  // diameter 1 (radius 0.5) the colour node keeps lies strictly inside.
  for (let i = 0; i < 3; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % 3]]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const dist = Math.abs(a[0] * b[1] - b[0] * a[1]) / len
    assert.ok(Math.abs(dist - r) < 1e-6, `edge ${i}: ${dist}`)
    assert.ok(dist > 0.5)
    assert.ok(Math.abs(len - 2 * Math.sqrt(3) * r) < 1e-6, 'equilateral')
  }
  // The area factor is the polygon's real area, which is what the shaded-area readout bills.
  assert.ok(Math.abs(signedArea(pts, [0, 1, 2]) - shapeAreaFactor('triangle')) < 1e-6)
})

test('uv is corner + 0.5, so the round-dot cut is the same circle as on the quad', () => {
  const g = new THREE.InstancedBufferGeometry()
  applyDotShapeToGeometry(g, 'triangle')
  const p = g.getAttribute('position')
  const uv = g.getAttribute('uv')
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(uv.getX(i) - (p.getX(i) + 0.5)) < 1e-6)
    assert.ok(Math.abs(uv.getY(i) - (p.getY(i) + 0.5)) < 1e-6)
  }
})

test('both shapes carry the same pinned corner sphere, so the draw order cannot change', () => {
  for (const shape of ['quad', 'triangle'] as const) {
    const g = new THREE.InstancedBufferGeometry()
    applyDotShapeToGeometry(g, shape)
    assert.deepEqual(g.boundingSphere!.center.toArray(), [0, 0, 0])
    assert.equal(g.boundingSphere!.radius, Math.SQRT1_2)
  }
})

test('a runtime switch swaps corners in place and leaves the point data alone', () => {
  const g = new THREE.InstancedBufferGeometry()
  applyDotShapeToGeometry(g, 'quad')
  const perPoint = new THREE.InstancedBufferAttribute(new Float32Array(30), 3)
  g.setAttribute('cloudPointPosition', perPoint)
  g.instanceCount = 10
  const material = new THREE.MeshBasicMaterial()
  const mesh = new THREE.Mesh(g, material)
  initDotState(mesh, { feed: 'instanced', shape: 'quad', points: 10, orderIsFair: true })
  const versionBefore = material.version
  const position = g.getAttribute('position')
  const uv = g.getAttribute('uv')
  const index = g.index
  const positionVersion = position.version

  assert.equal(applyDotShape(mesh, 'quad'), false, 'no-op when already that shape')
  assert.equal(applyDotShape(mesh, 'triangle'), true)
  assert.equal(mesh.geometry, g, 'same geometry object')
  // No new attribute objects: three never frees one replaced on a live geometry.
  assert.equal(g.getAttribute('position'), position, 'corner buffer rewritten in place')
  assert.equal(g.getAttribute('uv'), uv, 'uv buffer rewritten in place')
  assert.equal(g.index, index, 'same index')
  assert.ok(position.version > positionVersion, 'corner buffer marked for upload')
  assert.equal(g.getAttribute('cloudPointPosition'), perPoint, 'per-point data untouched')
  assert.equal(g.instanceCount, 10, 'drawn count untouched')
  assert.equal(g.drawRange.count, 3, 'one triangle drawn')
  assert.equal(material.version, versionBefore, 'nothing structural, no re-key needed')
  assert.ok(Math.abs(dotAreaFactor(mesh) - shapeAreaFactor('triangle')) < 1e-9)
  applyDotShape(mesh, 'quad')
  assert.equal(g.drawRange.count, 6)
  assert.deepEqual(corners(g), [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]], 'quad restored exactly')
})

test('drawn points are a clamped prefix of the loaded points', () => {
  const g = new THREE.InstancedBufferGeometry()
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial())
  initDotState(mesh, { feed: 'instanced', shape: 'quad', points: 100, orderIsFair: true })
  assert.equal(loadedPoints(mesh), 100)
  setDrawnPoints(mesh, 37.4)
  assert.equal(drawnPoints(mesh), 37)
  setDrawnPoints(mesh, 500)
  assert.equal(drawnPoints(mesh), 100)
  setDrawnPoints(mesh, -3)
  assert.equal(drawnPoints(mesh), 0)
})

test('point data packs xyz and the colour as an exact integer, one texel per point', () => {
  const n = 1500
  const pos = new Float32Array(n * 3)
  const col = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    pos[i * 3] = i * 0.25; pos[i * 3 + 1] = -i; pos[i * 3 + 2] = 1000 + i * 0.001
    col[i * 4] = i % 256; col[i * 4 + 1] = (i * 7) % 256; col[i * 4 + 2] = 255 - (i % 256); col[i * 4 + 3] = 255
  }
  const tex = packPointData(new THREE.BufferAttribute(pos, 3), new THREE.BufferAttribute(col, 4, true))
  assert.equal(tex.image.width, POINT_DATA_WIDTH)
  assert.equal(tex.image.height, Math.ceil(n / POINT_DATA_WIDTH))
  assert.equal(tex.type, THREE.FloatType)
  assert.equal(tex.minFilter, THREE.NearestFilter)
  assert.equal(tex.magFilter, THREE.NearestFilter)
  const data = tex.image.data as Float32Array
  assert.equal(data.length, POINT_DATA_WIDTH * tex.image.height * 4, 'whole rows')
  for (const i of [0, 1, 777, n - 1]) {
    assert.equal(data[i * 4], Math.fround(pos[i * 3]))
    assert.equal(data[i * 4 + 1], Math.fround(pos[i * 3 + 1]))
    assert.equal(data[i * 4 + 2], Math.fround(pos[i * 3 + 2]))
    // Decoded the way the shader does it: u32, then shifts and masks.
    const packed = data[i * 4 + 3] >>> 0
    assert.equal(packed >>> 16 & 255, col[i * 4])
    assert.equal(packed >>> 8 & 255, col[i * 4 + 1])
    assert.equal(packed & 255, col[i * 4 + 2])
    assert.ok(Number.isInteger(data[i * 4 + 3]), 'exact integer in float32')
  }
  // RGB colours, and no colour at all (black, like the instanced feed's missing attribute).
  const rgb = new Uint8Array([10, 20, 30])
  const one = packPointData(new THREE.BufferAttribute(new Float32Array([1, 2, 3]), 3), new THREE.BufferAttribute(rgb, 3, true))
  assert.equal((one.image.data as Float32Array)[3], 10 * 65536 + 20 * 256 + 30)
  const bare = packPointData(new THREE.BufferAttribute(new Float32Array([1, 2, 3]), 3), null)
  assert.equal((bare.image.data as Float32Array)[3], 0, 'black, like the instanced feed')
})

test('a pulled geometry has no attributes and draws k vertices per point', () => {
  const tri = buildPulledGeometry('triangle', 500)
  assert.equal(Object.keys(tri.attributes).length, 0)
  assert.equal(tri.index, null)
  assert.equal(tri.drawRange.count, 1500)
  const quad = buildPulledGeometry('quad', 500)
  assert.equal(Object.keys(quad.attributes).length, 0)
  assert.equal(quad.drawRange.count, 3000)
  const index = Array.from((quad.index!.array as Uint32Array).slice(0, 12))
  assert.deepEqual(index, [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7], '4i + {0,1,2,0,2,3}')
  assert.equal(buildPulledGeometry('quad', 10).index, quad.index, 'one shared index')
})

test('disposing one pulled quad leaves the shared index with every other tile', () => {
  const a = buildPulledGeometry('quad', 100)
  const b = buildPulledGeometry('quad', 100)
  const seen: (THREE.BufferAttribute | null)[] = []
  // What three reads on the dispose event: the geometry's index at that moment.
  a.addEventListener('dispose', () => seen.push(a.index))
  a.dispose()
  assert.deepEqual(seen, [null], 'index hidden from the dispose listeners')
  assert.equal(a.index, b.index, 'and put back afterwards')
  assert.ok(b.index)
})

test('drawn points follow the draw range in the pulled feed', () => {
  for (const [shape, k] of [['triangle', 3], ['quad', 6]] as const) {
    const mesh = new THREE.Mesh(buildPulledGeometry(shape, 200), new THREE.MeshBasicMaterial())
    initDotState(mesh, { feed: 'pulled', shape, points: 200, orderIsFair: true })
    assert.equal(drawnPoints(mesh), 200)
    setDrawnPoints(mesh, 73)
    assert.equal(mesh.geometry.drawRange.count, 73 * k)
    assert.equal(drawnPoints(mesh), 73)
    assert.equal(applyDotShape(mesh, shape === 'quad' ? 'triangle' : 'quad'), false, 'pulled shape is a rebuild, not an in-place swap')
  }
})

test('the pulled corner tables are the shapes the instanced path draws', () => {
  assert.deepEqual(dotCorners('quad'), [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]])
  const g = new THREE.InstancedBufferGeometry()
  applyDotShapeToGeometry(g, 'triangle')
  const p = g.getAttribute('position')
  assert.deepEqual(dotCorners('triangle'), [0, 1, 2].map((i) => [p.getX(i), p.getY(i)]))
})
