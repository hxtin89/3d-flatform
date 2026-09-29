import * as THREE from 'three'

import { drawnDotDiameterPx, largestDotDiameterPx, type DotSizeRule } from './dot-size.ts'

/**
 * The first drawn dot under the cursor — the pivot a rotation should turn about.
 *
 * The rotation pivot used to be the cursor ray's crossing with a *statistic*: the
 * 95th-percentile canopy height of a 40 m square (widening to 120 and 360 m where the data
 * was thin), found by walking up the ray from the map. That plane is not what the cursor is
 * on. Over a clearing it floats above the ground that was clicked, on a lone tall tree it
 * sits inside the crown, and below 14.5 degrees of ray descent it was skipped altogether.
 * Measured on the landing view against what the frame actually shows under 40 cursor
 * positions: the lift was off by 29 m at the median and 86 m at worst, and within half a
 * metre nowhere; this pick is within 3 cm at all 40.
 *
 * "Drawn" in the shader's sense, so the pivot lands on what is on screen:
 * - only the points a tile actually draws — the prefix thinning leaves (`drawn`), in the
 *   carrier's own order, which is the drawn order in both feeds;
 * - at the dome's rim, where the vertex stage carries each point down toward the dome
 *   centre's height and shrinks it by the same fade (point-cloud.ts sphereFadeFactor);
 * - as a disc on screen: a dot is under the cursor when the cursor lies within its drawn
 *   radius in pixels, sized by the same rule as the shader at the dot's own depth.
 *
 * Paid once per press, never per frame, and less than the lift it replaces: 10-16 ms for
 * 850k points on the landing view, where the lift took 35-60 ms (hidden Browser pane, whose
 * JS runs slow; the ratio is what carries over). Tiles whose bounds the ray misses are
 * skipped whole, and a point is tested exactly only after a cheap test in the tile's own
 * frame says it could be close enough.
 */

export interface PickTile {
  /** The tile's carrier Points: its position attribute holds the points in drawn order. */
  carrier: THREE.Object3D
  /** How many of them the tile draws (thinning draws a prefix). */
  drawn: number
  /** The tile's effective point spacing, which the size rule reads; 0 draws it at the
   *  fixed size. */
  spacingM: number
  /** The thinning widening on this tile. */
  thinScale: number
}

/** The screen the dots are rasterised on. */
export interface PickScreen {
  /** World to view space: the camera's matrixWorldInverse. */
  worldToView: THREE.Matrix4
  /** The camera's projection matrix. */
  projection: THREE.Matrix4
  /** The cursor in NDC. */
  cursorX: number
  cursorY: number
  /** Half the canvas in CSS pixels — what the dot sizes are measured in. */
  halfWidthPx: number
  halfHeightPx: number
  /** The angle one CSS pixel subtends in the middle of the view, the largest any pixel
   *  subtends — so an angular pre-filter built on it never turns away a dot that covers
   *  the cursor. (Nearer the edges a pixel subtends less; an exact test by angle alone let
   *  in dots there that did not cover the cursor.) */
  pxAngle: number
}

/** The dome in the shader's raw ENU frame, as main.ts hands it to the uniforms. */
export interface PickDome {
  centreEnu: THREE.Vector3
  radius: number
  rampInset: number
  fadeIn: number
  fadeOut: number
  /** ENU up in world space. */
  upWorld: THREE.Vector3
  /** World (render space) to raw ENU. */
  enuInverse: THREE.Matrix4
}

export interface PickHit {
  /** Distance along the ray to the dot that was met. */
  distance: number
  /** That point on the ray, in world space — under the cursor by construction. */
  point: THREE.Vector3
  tilesWalked: number
  pointsWalked: number
  /** The tile the dot belongs to. */
  tile: PickTile
}

const worldToLocal = new THREE.Matrix4()
const localToEnu = new THREE.Matrix4()
const localToView = new THREE.Matrix4()
const origin = new THREE.Vector3()
const direction = new THREE.Vector3()
const localUp = new THREE.Vector3()
const scratch = new THREE.Vector3()
const scratchBox = new THREE.Box3()
const tileCentreEnu = new THREE.Vector3()

/** The shader's dome falloff at distance `d` from the centre; 1 on the plateau. */
function fadeAt(d: number, start: number, span: number, fadeIn: number, fadeOut: number): number {
  if (d <= start) return 1
  const t = Math.min(1, (d - start) / span)
  const rise = Math.pow(t, fadeIn)
  const fall = Math.pow(1 - t, fadeOut)
  return 1 - rise / Math.max(rise + fall, 1e-6)
}

/**
 * Whether the dot at local point q, shrunk by `fade`, covers the cursor: q through the
 * tile's local-to-view matrix `m` and the projection `p`, its pixel distance from the
 * cursor against the drawn radius at its depth.
 */
function coversCursor(
  m: ArrayLike<number>, p: ArrayLike<number>, screen: PickScreen, rule: DotSizeRule,
  spacingM: number, thinScale: number, qx: number, qy: number, qz: number, fade: number,
): boolean {
  const vx = m[0] * qx + m[4] * qy + m[8] * qz + m[12]
  const vy = m[1] * qx + m[5] * qy + m[9] * qz + m[13]
  const vz = m[2] * qx + m[6] * qy + m[10] * qz + m[14]
  const depth = -vz
  if (!(depth > 0)) return false
  const nx = (p[0] * vx + p[8] * vz) / depth
  const ny = (p[5] * vy + p[9] * vz) / depth
  const ex = (nx - screen.cursorX) * screen.halfWidthPx
  const ey = (ny - screen.cursorY) * screen.halfHeightPx
  const r = (spacingM > 0
    ? drawnDotDiameterPx(rule, spacingM, depth, thinScale)
    : rule.pointSizePx * thinScale) * 0.5 * fade
  return ex * ex + ey * ey <= r * r
}

/**
 * The nearest drawn dot along the ray from `rayOrigin` in the unit direction `rayDir`,
 * both in world space, that covers the cursor on `screen`. Null when none does before
 * `maxDistance`.
 */
export function pickFirstPoint(
  tiles: Iterable<PickTile>,
  rayOrigin: THREE.Vector3,
  rayDir: THREE.Vector3,
  rule: DotSizeRule,
  screen: PickScreen,
  dome: PickDome | null,
  near: number,
  maxDistance: number,
): PickHit | null {
  let best = maxDistance
  let bestTile: PickTile | null = null
  let tilesWalked = 0
  let pointsWalked = 0
  const pm = screen.projection.elements

  // The dome's shape, resolved once, exactly as sphereFadeFactor floors it.
  const radius = dome ? Math.max(dome.radius, 0.001) : 0
  const start = dome ? Math.max(radius - dome.rampInset, 0) : 0
  const span = dome ? Math.max(radius - start, 0.001) : 0
  const fadeIn = dome ? Math.max(dome.fadeIn, 0.01) : 1
  const fadeOut = dome ? Math.max(dome.fadeOut, 0.01) : 1
  const cx = dome?.centreEnu.x ?? 0, cy = dome?.centreEnu.y ?? 0, cz = dome?.centreEnu.z ?? 0

  for (const tile of tiles) {
    const geometry = (tile.carrier as any).geometry as THREE.BufferGeometry | undefined
    const attribute = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined
    const drawn = Math.min(tile.drawn, attribute?.count ?? 0)
    if (!geometry || !attribute || drawn <= 0 || !(attribute.array instanceof Float32Array)) continue
    const array = attribute.array
    const stride = attribute.itemSize
    const spacingM = tile.spacingM, thinScale = tile.thinScale
    // The pre-filter's half-angle: the widest dot this tile can draw, in the middle of the view.
    const k = 0.5 * largestDotDiameterPx(rule, thinScale) * screen.pxAngle

    // Into the tile's own frame: the transform is rigid, so distances carry over.
    tile.carrier.updateWorldMatrix(true, false)
    worldToLocal.copy(tile.carrier.matrixWorld).invert()
    origin.copy(rayOrigin).applyMatrix4(worldToLocal)
    direction.copy(rayDir).transformDirection(worldToLocal)
    const ox = origin.x, oy = origin.y, oz = origin.z
    const dx = direction.x, dy = direction.y, dz = direction.z
    localToView.multiplyMatrices(screen.worldToView, tile.carrier.matrixWorld)
    const m = localToView.elements

    // Does the dome reach into this tile? If not, every point is drawn where it lies, at
    // full size, and the plain walk below serves.
    let melts = false
    if (dome) {
      localToEnu.multiplyMatrices(dome.enuInverse, tile.carrier.matrixWorld)
      const sphere = geometry.boundingSphere
      if (!sphere) melts = true
      else {
        tileCentreEnu.copy(sphere.center).applyMatrix4(localToEnu)
        melts = Math.hypot(tileCentreEnu.x - cx, tileCentreEnu.y - cy, tileCentreEnu.z - cz) + sphere.radius > start
      }
    }

    // Cheap reject on the tile's own box, widened by the widest a dot can be out there.
    // A melting tile's points move down toward the dome centre, so it is walked unboxed.
    const box = geometry.boundingBox
    if (box && !melts) {
      scratchBox.copy(box).expandByScalar(k * best)
      const entry = rayBoxEntry(scratchBox, ox, oy, oz, dx, dy, dz)
      if (entry === null || entry > best) continue
    }

    tilesWalked++
    pointsWalked += drawn
    if (!melts) {
      for (let i = 0, o = 0; i < drawn; i++, o += stride) {
        const vx = array[o] - ox, vy = array[o + 1] - oy, vz = array[o + 2] - oz
        const t = vx * dx + vy * dy + vz * dz
        if (t <= near || t >= best) continue
        const off2 = vx * vx + vy * vy + vz * vz - t * t
        const bound = k * t
        if (off2 > bound * bound) continue
        if (coversCursor(m, pm, screen, rule, spacingM, thinScale, array[o], array[o + 1], array[o + 2], 1)) {
          best = t
          bestTile = tile
        }
      }
      continue
    }

    // The melt, point by point, as the vertex stage does it: the fade from the point's
    // true 3D distance to the dome centre, the drop toward the centre's height along ENU
    // up (in the tile frame), and the dot shrunk by the same fade.
    //
    // Most points of a big tile are nowhere near the ray, and the melt is the expensive
    // part, so each point is first tested where it lies. The melt moves it along ENU up by
    // at most its height over the dome centre, `cz - ez`; a point that stays out of reach
    // however far that carries it is skipped before the fade is computed. Measured on the
    // landing view: 45 ms for 850k points with the melt taken for all of them, 10-16 ms so.
    localUp.copy(dome!.upWorld).transformDirection(worldToLocal)
    const ux = localUp.x, uy = localUp.y, uz = localUp.z
    const upAlongRay = ux * dx + uy * dy + uz * dz
    const e = localToEnu.elements
    const start2 = start * start
    for (let i = 0, o = 0; i < drawn; i++, o += stride) {
      const px = array[o], py = array[o + 1], pz = array[o + 2]
      const wx = px - ox, wy = py - oy, wz = pz - oz
      const tLying = wx * dx + wy * dy + wz * dz
      const ez = e[2] * px + e[6] * py + e[10] * pz + e[14]
      const reach = cz - ez
      // Where along the ray the melt could carry it: between tLying and tLying + reach·(up·ray).
      const tShift = reach * upAlongRay
      if ((tShift < 0 ? tLying + tShift : tLying) >= best) continue
      if ((tShift > 0 ? tLying + tShift : tLying) <= near) continue
      const offLying2 = wx * wx + wy * wy + wz * wz - tLying * tLying
      const slack = k * best + Math.abs(reach)
      if (offLying2 > slack * slack) continue

      const ex = e[0] * px + e[4] * py + e[8] * pz + e[12]
      const ey = e[1] * px + e[5] * py + e[9] * pz + e[13]
      const qx = ex - cx, qy = ey - cy, qz = ez - cz
      const d2 = qx * qx + qy * qy + qz * qz
      // On the plateau nothing moves or shrinks.
      const fade = d2 <= start2 ? 1 : fadeAt(Math.sqrt(d2), start, span, fadeIn, fadeOut)
      if (fade <= 0) continue
      const drop = reach * (1 - fade)
      const vx = wx + ux * drop, vy = wy + uy * drop, vz = wz + uz * drop
      const t = vx * dx + vy * dy + vz * dz
      if (t <= near || t >= best) continue
      const off2 = vx * vx + vy * vy + vz * vz - t * t
      const bound = k * fade * t
      if (off2 > bound * bound) continue
      if (coversCursor(m, pm, screen, rule, spacingM, thinScale, px + ux * drop, py + uy * drop, pz + uz * drop, fade)) {
        best = t
        bestTile = tile
      }
    }
  }

  if (best >= maxDistance || !bestTile) return null
  return {
    distance: best,
    point: scratch.copy(rayDir).multiplyScalar(best).add(rayOrigin).clone(),
    tilesWalked,
    pointsWalked,
    tile: bestTile,
  }
}

/** Where a ray enters a box (0 if it starts inside), or null if it misses. */
function rayBoxEntry(
  box: THREE.Box3, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
): number | null {
  let tmin = 0, tmax = Infinity
  const axes: [number, number, number, number][] = [
    [ox, dx, box.min.x, box.max.x], [oy, dy, box.min.y, box.max.y], [oz, dz, box.min.z, box.max.z],
  ]
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null
      continue
    }
    let t1 = (lo - o) / d, t2 = (hi - o) / d
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s }
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  return tmin
}

/**
 * Run the pick on made-up tiles until the engine has compiled it, so the first real press
 * does not pay for that. Measured on the landing view: the first three picks took
 * 76-126 ms each, every one after that 9-16 ms. The made-up tiles are shaped like real ones
 * — several, of mixed extent, with the box skip in play, both loops, the spacing rule — so
 * the code the engine compiles is the code a real press runs.
 *
 * Six picks, each in a task of its own a frame apart, so no single frame carries all of it.
 */
export function warmUpPick(
  rule: DotSizeRule,
  schedule: (step: () => void) => void = (step) => { setTimeout(step, 32) },
): void {
  const tiles: PickTile[] = [[20_000, 300], [20_000, 100], [20_000, 30], [10_000, 10]].map(([count, size], k) => {
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      positions[i * 3] = Math.sin((i + k) * 12.9898) * size
      positions[i * 3 + 1] = Math.cos((i + k) * 78.233) * size
      positions[i * 3 + 2] = i % 41
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    const carrier = new THREE.Points(geometry)
    carrier.updateMatrixWorld(true)
    return { carrier, drawn: count, spacingM: k === 3 ? 0 : size / 400, thinScale: 1 }
  })
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 5000)
  camera.position.set(3, 4, 150)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const screen: PickScreen = {
    worldToView: camera.matrixWorldInverse, projection: camera.projectionMatrix,
    cursorX: 0.01, cursorY: -0.02, halfWidthPx: 640, halfHeightPx: 480,
    pxAngle: 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / 960,
  }
  const rayDir = new THREE.Vector3(0.01, -0.02, 0.5).unproject(camera).sub(camera.position).normalize()
  const dome: PickDome = {
    centreEnu: new THREE.Vector3(0, 0, 0), radius: 120, rampInset: 80, fadeIn: 1, fadeOut: 1,
    upWorld: new THREE.Vector3(0, 0, 1), enuInverse: new THREE.Matrix4(),
  }
  let pass = 0
  const step = () => {
    pickFirstPoint(tiles, camera.position, rayDir, rule, screen, pass % 2 ? dome : null, 0.1, 5000)
    if (++pass < 6) schedule(step)
    else for (const tile of tiles) (tile.carrier as THREE.Points).geometry.dispose()
  }
  schedule(step)
}
