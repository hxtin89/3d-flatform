import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { EXPERIENCE_CONFIG } from './config.ts'
import { applyDotShapeToGeometry, buildPulledGeometry, initDotState, isDotMesh } from './dot-geometry.ts'
import { sampleGroundHeights, type GroundSampleSettings } from './ground-sample.ts'
import {
  adoptPointData, computeCarrierBounds, packPointsForPulling, pointDataForCarrier,
  PREFIX_SAMPLE_ROUNDS, reorderForPrefixSampling, restoreCarrierArrays,
} from './point-order.ts'

// point-cloud.ts's POINT_POSITION_ATTRIBUTE; that module needs three/webgpu, which node lacks.
const POINT_POSITION_ATTRIBUTE = 'cloudPointPosition'
const SETTINGS: GroundSampleSettings = EXPERIENCE_CONFIG.donationShape

/**
 * The probe as it was before it walked carriers only (streaming.ts sampleGroundZ at
 * 5b3080d), copied verbatim bar the settings argument: the carrier *and* its dot mesh,
 * the dot mesh without any bound. The new probe must return exactly this.
 */
function previousProbe(
  scenes: THREE.Object3D[], centreEnu: THREE.Vector2, radiusM: number, enuInverse: THREE.Matrix4,
  settings: GroundSampleSettings,
) {
  const heights: number[] = []
  const support = new Uint8Array(25)
  const local = new THREE.Matrix4()
  const point = new THREE.Vector3()
  for (const tileScene of scenes) {
    tileScene.traverse((object: any) => {
      const attribute = object.geometry?.getAttribute?.(POINT_POSITION_ATTRIBUTE)
        ?? (isDotMesh(object) ? (object.parent as any)?.geometry?.getAttribute?.('position') : null)
        ?? (object.isPoints ? object.geometry?.getAttribute?.('position') : null)
      if (!attribute || attribute.count === 0) return
      object.updateWorldMatrix(true, false)
      local.multiplyMatrices(enuInverse, object.matrixWorld)
      const geometry = object.geometry
      if (object.isPoints) {
        if (!geometry.boundingSphere) geometry.computeBoundingSphere()
        const bounds = geometry.boundingSphere
        if (bounds && bounds.radius > 1) {
          point.copy(bounds.center).applyMatrix4(local)
          const dx = point.x - centreEnu.x
          const dy = point.y - centreEnu.y
          if (Math.hypot(dx, dy) > radiusM + bounds.radius) return
        }
      }
      const stride = Math.max(1, Math.floor(attribute.count / settings.probeMaxSamplesPerTile))
      for (let index = 0; index < attribute.count; index += stride) {
        point.set(attribute.getX(index), attribute.getY(index), attribute.getZ(index))
        point.applyMatrix4(local)
        const dx = point.x - centreEnu.x
        const dy = point.y - centreEnu.y
        if (Math.abs(dx) > radiusM || Math.abs(dy) > radiusM) continue
        heights.push(point.z)
        const column = Math.min(4, Math.max(0, Math.floor(((dx / radiusM) + 1) * 2.5)))
        const row = Math.min(4, Math.max(0, Math.floor(((dy / radiusM) + 1) * 2.5)))
        support[row * 5 + column] = 1
      }
    })
  }
  if (heights.length < settings.probeMinSamples) return null
  heights.sort((a, b) => a - b)
  const at = (fraction: number): number =>
    heights[Math.min(heights.length - 1, Math.max(0, Math.floor(heights.length * fraction)))]
  let occupied = 0
  for (const cell of support) occupied += cell
  return {
    groundZ: at(settings.probeGroundPercentile),
    canopyZ: at(settings.probeCanopyPercentile),
    samples: heights.length,
    support: occupied,
  }
}

let seed = 1
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)

// A rigid tile frame with a real rotation, as the tileset root gives every tile.
const enuFrame = new THREE.Matrix4()
  .makeRotationFromEuler(new THREE.Euler(0.3, -1.2, 0.7)).setPosition(1200, -300, 50)
const enuInverse = enuFrame.clone().invert()

type Feed = 'instanced' | 'pulled'
type Build = { feed: Feed; reorder: boolean; bounds: 'arrival' | 'lazy'; switched: boolean }

/** A canopy-like cloud: ground on a gentle slope, 60 % of points up in the trees. */
function cloudPoints(count: number, size: number, ex: number): Float32Array {
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const x = (random() - 0.5) * size, y = (random() - 0.5) * size
    const ground = 0.02 * (x + ex) + Math.round(random() * 20) / 10
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = random() < 0.6 ? ground + random() * 40 : ground
  }
  return positions
}

/**
 * One tile scene the way the viewer builds it: the carrier Points is the scene root, with
 * the tile transform baked into its matrix (TilesRenderer), and its one dot mesh under it
 * reading the carrier's points in the given feed.
 */
function tileScene(positions: Float32Array, ex: number, ey: number, build: Build): THREE.Points {
  const count = positions.length / 3
  const geometry = new THREE.BufferGeometry()
  const position = new THREE.BufferAttribute(positions, 3)
  geometry.setAttribute('position', position)
  const carrier = new THREE.Points(geometry)
  carrier.matrix.makeTranslation(ex, ey, 0).premultiply(enuFrame)
  carrier.matrix.decompose(carrier.position, carrier.quaternion, carrier.scale)

  let feed = build.feed
  if (build.switched) feed = feed === 'pulled' ? 'instanced' : 'pulled'
  let dotGeometry: THREE.BufferGeometry
  if (feed === 'pulled') {
    const rounds = build.reorder && count > 2 ? PREFIX_SAMPLE_ROUNDS : 1
    adoptPointData(geometry, packPointsForPulling(position, undefined, rounds)!, count)
    dotGeometry = buildPulledGeometry('triangle', count)
  } else {
    const arrays = build.reorder ? reorderForPrefixSampling(position, undefined) : null
    if (arrays) geometry.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3))
    dotGeometry = instancedDots(geometry, count)
  }
  // A runtime feed switch after arrival: the carrier's arrays change form, the points not.
  if (build.switched) {
    if (build.feed === 'pulled') {
      pointDataForCarrier(geometry)
      dotGeometry = buildPulledGeometry('quad', count)
    } else {
      restoreCarrierArrays(geometry, false)
      dotGeometry = instancedDots(geometry, count)
    }
  }
  if (build.bounds === 'arrival') computeCarrierBounds(geometry)
  else geometry.boundingSphere = null

  const mesh = new THREE.Mesh(dotGeometry)
  initDotState(mesh, { feed: build.feed, shape: 'quad', points: count, orderIsFair: true, hasColour: false })
  carrier.add(mesh)
  geometry.setDrawRange(0, 0)
  return carrier
}

function instancedDots(carrier: THREE.BufferGeometry, count: number): THREE.BufferGeometry {
  const position = carrier.getAttribute('position') as THREE.BufferAttribute
  const dots = new THREE.InstancedBufferGeometry()
  applyDotShapeToGeometry(dots, 'quad')
  dots.setAttribute(POINT_POSITION_ATTRIBUTE, new THREE.InstancedBufferAttribute(
    position.array, position.itemSize, position.normalized,
  ))
  dots.instanceCount = count
  return dots
}

/**
 * A small nested tree over a 5×5 grid of sparse leaves — sparse so the minimum-samples
 * gate is hit both ways — plus one- and two-point tiles, and a pair of carriers placed
 * right at the corner reach: one just inside r√2 + R of a probe, one just outside.
 */
function buildScenes(build: Build): THREE.Points[] {
  seed = 777
  const scenes: THREE.Points[] = []
  for (let depth = 0, size = 960; depth < 3; depth++, size /= 2) {
    scenes.push(tileScene(cloudPoints(8000, size, 0), 0, 0, build))
  }
  for (let gx = -2; gx <= 2; gx++) {
    for (let gy = -2; gy <= 2; gy++) {
      const ex = gx * 60 + 7, ey = gy * 60 - 3
      scenes.push(tileScene(cloudPoints(100 + Math.floor(random() * 900), 60, ex), ex, ey, build))
    }
  }
  scenes.push(tileScene(cloudPoints(1, 0.5, 3), 3, 4, build))
  scenes.push(tileScene(cloudPoints(2, 0.5, -5), -5, 2, build))
  // Arcs of radius R facing the origin, centred on the diagonal at r√2 + R ∓ 0.5 for the
  // 20 m probe at the origin: their points reach into the footprint's corner.
  for (const offset of [-0.5, 0.5]) {
    const R = 12, r = 20
    const d = (r * Math.SQRT2 + R + offset) / Math.SQRT2
    const arc = new Float32Array(3 * 80)
    for (let i = 0; i < 80; i++) {
      const a = Math.PI * 1.25 + (i / 79 - 0.5) * 0.6
      arc[i * 3] = Math.cos(a) * R
      arc[i * 3 + 1] = Math.sin(a) * R
      arc[i * 3 + 2] = 5 + i * 0.1
    }
    scenes.push(tileScene(arc, d, d, build))
  }
  return scenes
}

const BUILDS: Build[] = []
for (const feed of ['instanced', 'pulled'] as const) {
  for (const reorder of [true, false]) {
    for (const bounds of ['arrival', 'lazy'] as const) BUILDS.push({ feed, reorder, bounds, switched: false })
    BUILDS.push({ feed, reorder, bounds: 'arrival', switched: true })
  }
}

for (const build of BUILDS) {
  const label = `${build.feed}${build.switched ? ' (switched)' : ''}, ${build.reorder ? 'reordered' : 'arrival order'}, ${build.bounds} bounds`
  test(`the carriers-only probe returns what the old walk did: ${label}`, () => {
    const scenes = buildScenes(build)
    let answered = 0, nulls = 0
    for (let cx = -160; cx <= 160; cx += 80) {
      for (let cy = -160; cy <= 160; cy += 80) {
        const centre = new THREE.Vector2(cx, cy)
        for (const radius of [20, 60, 120, 180]) {
          const want = previousProbe(scenes, centre, radius, enuInverse, SETTINGS)
          const got = sampleGroundHeights(scenes, centre, radius, enuInverse, SETTINGS)
          assert.deepStrictEqual(got, want, `${label} at (${cx}, ${cy}) r ${radius}`)
          if (want) answered++
          else nulls++
        }
      }
    }
    // Both outcomes must actually occur, or the gate went untested.
    assert.ok(answered > 0 && nulls > 0, `${answered} answered, ${nulls} null`)
  })
}

test('a corner carrier just inside the reach is sampled, and gets the old single weight', () => {
  const build: Build = { feed: 'instanced', reorder: false, bounds: 'arrival', switched: false }
  const scenes = buildScenes(build).slice(-2)
  const centre = new THREE.Vector2(0, 0)
  const open = { ...SETTINGS, probeMinSamples: 1 }
  const got = sampleGroundHeights(scenes, centre, 20, enuInverse, open)
  assert.deepStrictEqual(got, previousProbe(scenes, centre, 20, enuInverse, open))
  // Only the inner arc reaches the corner; the old reject turned both away, so each
  // sampled point came from the dot mesh alone — one copy.
  const inner = sampleGroundHeights(scenes.slice(0, 1), centre, 20, enuInverse, open)
  const outer = sampleGroundHeights(scenes.slice(1), centre, 20, enuInverse, open)
  assert.ok(inner && inner.samples > 0, 'the inner arc has points in the corner')
  assert.equal(outer, null, 'the outer arc has none')
  assert.equal(got!.samples, inner!.samples)
})
