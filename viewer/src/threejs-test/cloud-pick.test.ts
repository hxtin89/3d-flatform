import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { pickFirstPoint, warmUpPick, type PickDome, type PickScreen, type PickTile } from './cloud-pick.ts'
import { drawnDotDiameterPx, largestDotDiameterPx, type DotSizeRule } from './dot-size.ts'
import { adoptPointData, computeCarrierBounds, packPointsForPulling } from './point-order.ts'

let seed = 11
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)

/** A carrier the way the viewer holds one: Points with arrival bounds, a rigid tile frame. */
function carrier(positions: Float32Array, frame: THREE.Matrix4, packed = false): THREE.Points {
  const geometry = new THREE.BufferGeometry()
  const attribute = new THREE.BufferAttribute(positions, 3)
  geometry.setAttribute('position', attribute)
  if (packed) adoptPointData(geometry, packPointsForPulling(attribute, undefined, 1)!, positions.length / 3)
  computeCarrierBounds(geometry)
  const points = new THREE.Points(geometry)
  points.matrix.copy(frame)
  points.matrix.decompose(points.position, points.quaternion, points.scale)
  points.updateMatrixWorld(true)
  return points
}

/** A canopy-ish slab: ground at 0, trees up to 30 m, over a square of `size`. */
function slab(count: number, size: number): Float32Array {
  const p = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    p[i * 3] = (random() - 0.5) * size
    p[i * 3 + 1] = (random() - 0.5) * size
    p[i * 3 + 2] = random() < 0.5 ? 0 : random() * 30
  }
  return p
}

const frameA = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.2, -0.4, 1.1)).setPosition(40, -25, 3)
const frameB = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.2, -0.4, 1.1)).setPosition(-30, 60, 3)

function scene(packed = false): PickTile[] {
  seed = 11
  return [
    { carrier: carrier(slab(20_000, 120), frameA, packed), drawn: 20_000, spacingM: 0.4, thinScale: 1 },
    { carrier: carrier(slab(20_000, 120), frameB, packed), drawn: 14_000, spacingM: 0.5, thinScale: 1.4 },
    { carrier: carrier(slab(3_000, 400), frameA, packed), drawn: 3_000, spacingM: 0, thinScale: 1 },
  ]
}

// A camera over the slabs, tilted, and the size rule the shader would run with.
const WIDTH = 1280, HEIGHT = 960
const camera = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 5000)
camera.position.set(10, -60, 110)
camera.lookAt(10, 20, 0)
camera.updateMatrixWorld()
const RULE: DotSizeRule = {
  pointSizePx: 2.5, spacingMix: 1, requestedPx: 2,
  pxPerMetre: 0.5 * HEIGHT * camera.projectionMatrix.elements[5], minPx: 1.4, maxPx: 6,
}
const PX_ANGLE = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / HEIGHT
const screenAt = (x: number, y: number): PickScreen => ({
  worldToView: camera.matrixWorldInverse, projection: camera.projectionMatrix,
  cursorX: x, cursorY: y, halfWidthPx: WIDTH / 2, halfHeightPx: HEIGHT / 2, pxAngle: PX_ANGLE,
})
const rayAt = (x: number, y: number) =>
  new THREE.Vector3(x, y, 0.5).unproject(camera).sub(camera.position).normalize()

/**
 * The same question answered the slow way: every drawn point, melted as the shader melts
 * it, projected, and kept when its dot covers the cursor pixel. Optionally by angle alone,
 * to show where that goes wrong.
 */
function bruteForce(tiles: PickTile[], x: number, y: number, dome: PickDome | null, byAngle = false) {
  const o = camera.position, d = rayAt(x, y)
  let best: number | null = null
  const p = new THREE.Vector3(), up = new THREE.Vector3(), enu = new THREE.Vector3(), view = new THREE.Vector3()
  for (const tile of tiles) {
    const attribute = (tile.carrier as any).geometry.getAttribute('position')
    const toLocal = tile.carrier.matrixWorld.clone().invert()
    for (let i = 0; i < Math.min(tile.drawn, attribute.count); i++) {
      p.set(attribute.getX(i), attribute.getY(i), attribute.getZ(i))
      let fade = 1
      if (dome) {
        enu.copy(p).applyMatrix4(tile.carrier.matrixWorld).applyMatrix4(dome.enuInverse)
        const radius = Math.max(dome.radius, 0.001)
        const start = Math.max(radius - dome.rampInset, 0)
        const span = Math.max(radius - start, 0.001)
        const t = Math.min(1, Math.max(0, (enu.distanceTo(dome.centreEnu) - start) / span))
        const rise = t ** Math.max(dome.fadeIn, 0.01), fall = (1 - t) ** Math.max(dome.fadeOut, 0.01)
        fade = 1 - rise / Math.max(rise + fall, 1e-6)
        if (fade <= 0) continue
        up.copy(dome.upWorld).transformDirection(toLocal)
        p.addScaledVector(up, (dome.centreEnu.z - enu.z) * (1 - fade))
      }
      p.applyMatrix4(tile.carrier.matrixWorld)
      view.copy(p).applyMatrix4(camera.matrixWorldInverse)
      const depth = -view.z
      if (!(depth > 0)) continue
      const diameter = tile.spacingM > 0
        ? drawnDotDiameterPx(RULE, tile.spacingM, depth, tile.thinScale)
        : RULE.pointSizePx * tile.thinScale
      const t = p.clone().sub(o).dot(d)
      if (t <= 0.1) continue
      if (byAngle) {
        const off = Math.sqrt(Math.max(0, p.clone().sub(o).lengthSq() - t * t))
        if (off > diameter * 0.5 * fade * PX_ANGLE * t) continue
      } else {
        const ndc = p.clone().project(camera)
        const ex = (ndc.x - x) * WIDTH / 2, ey = (ndc.y - y) * HEIGHT / 2
        if (ex * ex + ey * ey > (diameter * 0.5 * fade) ** 2) continue
      }
      if (best === null || t < best) best = t
    }
  }
  return best
}

/** Same answer: both null, or the same distance to within a micrometre — the pick works in
 *  each tile's own frame and the reference in world space, so the last bit may differ. */
function sameDistance(got: number | null, want: number | null, message: string) {
  if (got === null || want === null) { assert.equal(got, want, message); return }
  assert.ok(Math.abs(got - want) < 1e-6, `${message}: ${got} vs ${want}`)
}

const pick = (tiles: PickTile[], x: number, y: number, dome: PickDome | null = null, max = 5000) =>
  pickFirstPoint(tiles, camera.position, rayAt(x, y), RULE, screenAt(x, y), dome, 0.1, max)

function cursors(count: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < count; i++) out.push([(random() * 2 - 1) * 0.95, (random() * 2 - 1) * 0.95])
  return out
}

test('the pick finds exactly what projecting every drawn dot finds, corners included', () => {
  for (const packed of [false, true]) {
    const tiles = scene(packed)
    let hits = 0, angularWouldDiffer = 0
    for (const [x, y] of cursors(150)) {
      const got = pick(tiles, x, y)
      sameDistance(got?.distance ?? null, bruteForce(tiles, x, y, null), `${packed ? 'pulled' : 'instanced'} cursor ${x}, ${y}`)
      if (got) {
        hits++
        // On the ray, at that distance: under the cursor by construction.
        const onRay = camera.position.clone().addScaledVector(rayAt(x, y), got.distance)
        assert.ok(got.point.distanceTo(onRay) < 1e-9)
      }
      if (bruteForce(tiles, x, y, null, true) !== bruteForce(tiles, x, y, null)) angularWouldDiffer++
    }
    assert.ok(hits > 30, `only ${hits} of 150 cursors hit — the scene does not exercise the pick`)
    assert.ok(angularWouldDiffer > 0, 'the scene must show where judging by angle alone goes wrong')
  }
})

test('with the dome melting the rim, the pick meets the dots where the shader draws them', () => {
  const tiles = scene()
  const dome: PickDome = {
    // Raw ENU = world here, and the rim runs through the scene, so every tile melts somewhere.
    centreEnu: new THREE.Vector3(10, 20, 0), radius: 70, rampInset: 40, fadeIn: 1.5, fadeOut: 0.8,
    upWorld: new THREE.Vector3(0, 0, 1), enuInverse: new THREE.Matrix4(),
  }
  let differsFromUnmelted = 0
  for (const [x, y] of cursors(150)) {
    const got = pick(tiles, x, y, dome)
    sameDistance(got?.distance ?? null, bruteForce(tiles, x, y, dome), `cursor ${x}, ${y}`)
    if ((got?.distance ?? null) !== (pick(tiles, x, y)?.distance ?? null)) differsFromUnmelted++
  }
  assert.ok(differsFromUnmelted > 10, 'the melt must actually move some answers')
})

test('only the drawn prefix counts: a thinned-away dot is not under the cursor', () => {
  // A high point, then a low one, both on the view axis.
  const axis = rayAt(0, 0)
  const high = camera.position.clone().addScaledVector(axis, 60)
  const low = camera.position.clone().addScaledVector(axis, 90)
  const build = (a: THREE.Vector3, b: THREE.Vector3, drawn: number): PickTile[] => [{
    carrier: carrier(new Float32Array([...a.toArray(), ...b.toArray()]), new THREE.Matrix4()), drawn, spacingM: 0, thinScale: 1,
  }]
  // The points are stored as float32, so the distances come back to about a micrometre.
  assert.ok(Math.abs(pick(build(high, low, 2), 0, 0)!.distance - 60) < 1e-4)
  assert.ok(Math.abs(pick(build(low, high, 1), 0, 0)!.distance - 90) < 1e-4, 'the high point is thinned away')
})

test('a cursor between dots meets nothing, and nothing beyond the cap counts', () => {
  const axis = rayAt(0, 0)
  const centre = camera.position.clone().addScaledVector(axis, 80)
  // A ring of dots 3 m around the axis: 80 m out that is far more than a dot's radius.
  const side = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 0, 1)).normalize()
  const other = new THREE.Vector3().crossVectors(axis, side).normalize()
  const ring: number[] = []
  for (let a = 0; a < 64; a++) {
    const angle = a / 64 * Math.PI * 2
    ring.push(...centre.clone().addScaledVector(side, Math.cos(angle) * 3).addScaledVector(other, Math.sin(angle) * 3).toArray())
  }
  const tiles: PickTile[] = [{ carrier: carrier(new Float32Array(ring), new THREE.Matrix4()), drawn: 64, spacingM: 0, thinScale: 1 }]
  assert.equal(pick(tiles, 0, 0), null, 'the hole in the ring')
  const onRing = new THREE.Vector3(...ring.slice(0, 3)).project(camera)
  assert.ok(pick(tiles, onRing.x, onRing.y), 'a dot of the ring itself')
  assert.equal(pick(tiles, onRing.x, onRing.y, null, 50), null, 'past the cap')
})

test('the shared size rule is the readouts\' mirror, to the bit', () => {
  // The expression main.ts's drawnDiameterCssPx used before it moved here, with three's own
  // lerp and clamp: the Overdraw readout and the spacing table must not move.
  const before = (rule: DotSizeRule, spacingM: number, depth: number, thin: number) => {
    const delivered = spacingM * thin * rule.pxPerMetre / Math.max(depth, 0.001)
    const shortfall = Math.max(1, delivered / Math.max(rule.requestedPx, 0.001))
    return THREE.MathUtils.lerp(
      rule.pointSizePx * thin,
      THREE.MathUtils.clamp(rule.pointSizePx * shortfall, rule.minPx, rule.maxPx),
      rule.spacingMix,
    )
  }
  for (let n = 0; n < 2000; n++) {
    const rule: DotSizeRule = {
      pointSizePx: 1 + random() * 4, spacingMix: [0, 1, random()][n % 3], requestedPx: 0.5 + random() * 4,
      pxPerMetre: 100 + random() * 1500, minPx: random() * 3, maxPx: 2 + random() * 10,
    }
    const spacing = random() * 3, depth = random() * 800, thin = 1 + random() * 2
    assert.ok(Object.is(drawnDotDiameterPx(rule, spacing, depth, thin), before(rule, spacing, depth, thin)))
    assert.ok(drawnDotDiameterPx(rule, spacing, depth, thin) <= largestDotDiameterPx(rule, thin), 'the pre-filter bound holds')
  }
})

test('the warm-up runs every step and leaves nothing behind', () => {
  const steps: (() => void)[] = []
  warmUpPick(RULE, (step) => { steps.push(step) })
  let ran = 0
  while (steps.length) { steps.shift()!(); ran++ }
  assert.equal(ran, 6)
})

test('a dot reaching past its tile box still counts', () => {
  // One point is its own box, of zero size: a cursor on the dot's rim, a pixel off its
  // centre, misses that box unless it is widened by the dot's reach.
  const point = camera.position.clone().addScaledVector(rayAt(0.1, -0.1), 70)
  const tiles: PickTile[] = [{ carrier: carrier(new Float32Array(point.toArray()), new THREE.Matrix4()), drawn: 1, spacingM: 0, thinScale: 1 }]
  const centre = point.clone().project(camera)
  const rim = centre.x + 1 / (WIDTH / 2)   // one CSS pixel right; the dot's radius is 1.25
  assert.ok(pick(tiles, rim, centre.y), 'on the rim')
  assert.equal(pick(tiles, centre.x + 1.5 / (WIDTH / 2), centre.y), null, 'just past it')
})
