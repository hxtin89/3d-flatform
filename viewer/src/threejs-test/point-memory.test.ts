import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { setDrawnPoints } from './dot-geometry.ts'
import { pointMemoryReport } from './point-memory.ts'

const PROPERTY = 'pointData'
const MIB = 1024 * 1024

/** A pulled tile as the stream builds it: a carrier with the point texture's data behind
 *  it, and under it the dot mesh whose material carries the texture. */
function pulledTile(points: number, drawn = points) {
  const scene = new THREE.Group()
  const carrier = new THREE.Points(new THREE.BufferGeometry())
  carrier.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points * 4), 4))
  scene.add(carrier)
  const texture = new THREE.DataTexture(new Float32Array(points * 8), 1024, Math.ceil(points * 2 / 1024), THREE.RGBAFormat, THREE.FloatType)
  texture.userData.cloudPointData = true
  const material = new THREE.MeshBasicMaterial() as any
  material[PROPERTY] = texture
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
  mesh.geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array(9), 3))
  mesh.userData.dot = { feed: 'pulled', shape: 'tri', points, orderIsFair: true, hasColour: true }
  setDrawnPoints(mesh, drawn)
  carrier.add(mesh)
  const tile = { engineData: { scene, metadata: { featureTable: new Uint8Array(100) } } }
  return { tile, scene, mesh, texture, carrier }
}

/** An instanced tile: the dot mesh's geometry wraps the carrier's arrays. */
function instancedTile(points: number) {
  const scene = new THREE.Group()
  const position = new THREE.InstancedBufferAttribute(new Float32Array(points * 3), 3)
  const carrier = new THREE.Points(new THREE.BufferGeometry())
  carrier.geometry.setAttribute('position', position)
  scene.add(carrier)
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array(12), 3))
  geometry.setAttribute('position', position)
  geometry.instanceCount = points
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.userData.dot = { feed: 'instanced', shape: 'quad', points, orderIsFair: true, hasColour: true }
  carrier.add(mesh)
  const tile = { engineData: { scene } }
  return { tile, scene, mesh, position }
}

test('drawn share counts resident, selected and actually visible tiles and points apart', () => {
  const drawn = pulledTile(1000, 600)        // selected, visible, thinned to 600
  const gated = pulledTile(2000)             // selected, but the render gate hid its mesh
  gated.mesh.visible = false
  const parked = instancedTile(3000)         // loaded, not selected this frame
  const tiles = {
    forEachLoadedModel(callback: (scene: THREE.Object3D, tile: object) => void) {
      for (const entry of [drawn, gated, parked]) callback(entry.scene, entry.tile)
    },
    visibleTiles: new Set<object>([drawn.tile, gated.tile]),
  }
  const report = pointMemoryReport({ tiles, info: { memoryMap: new Map(), memory: { texturesSize: 0, total: 0 } }, pointDataProperty: PROPERTY })
  assert.deepEqual(report.tiles, { resident: 3, selected: 2, drawn: 1 })
  assert.deepEqual(report.points, { resident: 6000, selected: 3000, drawn: 600 })
  assert.deepEqual(report.drawnShare, { tiles: 0.333, points: 0.1 })
  assert.deepEqual(report.feeds, { pulled: { tiles: 2, drawnTiles: 1 }, instanced: { tiles: 1, drawnTiles: 0 } })
})

test('GPU point bytes come from the memory map, split by who owns the texture', () => {
  const drawn = pulledTile(1000)
  const hidden = pulledTile(1000)            // loaded, not selected: the GPU copy the unload plugin would free
  const instanced = instancedTile(500)
  const orphan = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType)
  orphan.userData.cloudPointData = true
  const imagery = new THREE.Texture()
  const sharedIndex = new THREE.BufferAttribute(new Uint16Array(6), 1)
  drawn.mesh.geometry.setIndex(sharedIndex)
  const memoryMap = new Map<object, number | { size: number; type: string }>([
    [drawn.texture, 3 * MIB],
    [hidden.texture, 2 * MIB],
    [orphan, 16],
    [imagery, 8 * MIB],
    [instanced.position, { size: 6000, type: 'vertex' }],
    [drawn.mesh.geometry.attributes.corner, { size: 36, type: 'vertex' }],
    [sharedIndex, { size: 12, type: 'index' }],
    [new THREE.BufferAttribute(new Float32Array(3), 3), { size: 12, type: 'vertex' }],   // not a point attribute
  ])
  const tiles = {
    forEachLoadedModel(callback: (scene: THREE.Object3D, tile: object) => void) {
      for (const entry of [drawn, hidden, instanced]) callback(entry.scene, entry.tile)
    },
    visibleTiles: new Set<object>([drawn.tile, instanced.tile]),
  }
  const report = pointMemoryReport({
    tiles, info: { memoryMap, memory: { texturesSize: 13 * MIB + 16, total: 13 * MIB + 16 + 6060 } }, pointDataProperty: PROPERTY,
  })
  assert.deepEqual(report.gpu.pointTextures, {
    count: 3, MiB: 5,
    drawn: { count: 1, MiB: 3 },
    hidden: { count: 1, MiB: 2 },
    orphan: { count: 1, MiB: 0 },
  })
  assert.deepEqual(report.gpu.pointAttributes, { count: 3, MiB: Number(((6000 + 36 + 12) / MIB).toFixed(1)) })
  assert.equal(report.gpu.pointMiB, 5)
  assert.equal(report.gpu.allTexturesMiB, 13)
})

test('CPU bytes count every distinct buffer once, and the heap reading is passed through in MiB', () => {
  const pulled = pulledTile(1000)
  const instanced = instancedTile(500)
  const tiles = {
    forEachLoadedModel(callback: (scene: THREE.Object3D, tile: object) => void) {
      for (const entry of [pulled, instanced]) callback(entry.scene, entry.tile)
    },
    visibleTiles: new Set<object>(),
  }
  const expected = pulled.texture.image.data!.byteLength      // the texture's data
    + 1000 * 4 * 4                                            // the pulled carrier's packed positions
    + 100                                                     // its feature table
    + 500 * 3 * 4                                             // the instanced positions, once for carrier and geometry
    + 12 * 4                                                  // the instanced corners (count 4, so counted)
  const report = pointMemoryReport({
    tiles, info: { memoryMap: new Map(), memory: { texturesSize: 0, total: 0 } }, pointDataProperty: PROPERTY,
    heap: { usedJSHeapSize: 150 * MIB, totalJSHeapSize: 200 * MIB, jsHeapSizeLimit: 4096 * MIB },
  })
  assert.equal(report.cpu.pointMiB, Number((expected / MIB).toFixed(1)))
  assert.deepEqual(report.heap, { usedMiB: 150, totalMiB: 200, limitMiB: 4096 })
  assert.match(report.footprintNote, /JS heap only/)
  const noHeap = pointMemoryReport({ tiles, info: { memoryMap: new Map(), memory: { texturesSize: 0, total: 0 } }, pointDataProperty: PROPERTY, heap: null })
  assert.equal(noHeap.heap, null)
  assert.match(noHeap.footprintNote, /task manager/)
})
