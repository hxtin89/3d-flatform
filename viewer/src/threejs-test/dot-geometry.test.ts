import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import {
  applyDotShape, applyDotShapeToGeometry, dotAreaFactor, drawnPoints, initDotState,
  loadedPoints, setDrawnPoints, shapeAreaFactor,
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
  initDotState(mesh, { shape: 'quad', points: 10, orderIsFair: true })
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
  initDotState(mesh, { shape: 'quad', points: 100, orderIsFair: true })
  assert.equal(loadedPoints(mesh), 100)
  setDrawnPoints(mesh, 37.4)
  assert.equal(drawnPoints(mesh), 37)
  setDrawnPoints(mesh, 500)
  assert.equal(drawnPoints(mesh), 100)
  setDrawnPoints(mesh, -3)
  assert.equal(drawnPoints(mesh), 0)
})
