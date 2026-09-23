import * as THREE from 'three'

import { EXPERIENCE_CONFIG } from './config.ts'

/**
 * The shape every point is drawn as, and the one place that knows how a dot mesh draws.
 *
 * Every point is one instance of a small camera-facing primitive whose corners sit in
 * the geometry's `position` attribute, in units of the drawn diameter — PointsNodeMaterial's
 * sprite path scales them by the point size. The colour node then cuts a circle of
 * diameter 1 out of it with the `uv` attribute, so any primitive that contains that circle
 * draws the same round dot:
 *
 * - **quad**: 4 corners, 2 triangles, area 1 d². The shape the viewer has always drawn.
 * - **triangle**: 3 corners, 1 triangle, an equilateral triangle whose inscribed circle is
 *   the dot (plus a 1 % margin, `triInradius`), area 1.325 d².
 *
 * Measured 2026-09-23: under hardware instancing the triangle saves only ~8 % of the
 * cloud's GPU time, because the cost is per instance rather than per vertex — it is the
 * control arm of plans/plan-dot-geometry-ab.md, and the triangle only pays in full once the
 * points are no longer instanced (step 2 of that plan).
 *
 * The triangle is only a round dot. With the round-dot cut off (the `Square` A/B) it would
 * draw a bare triangle, so the caller resolves the effective shape as
 * `roundDots ? requested : 'quad'` before handing it in.
 *
 * Per-mesh bookkeeping lives on `mesh.userData.dot`, never on the geometry: the shape
 * switch replaces the geometry's corner data, and a later feed switch will replace the
 * geometry object itself. Everything that used to read `instanceCount` or
 * `geometry.userData.fullCount` goes through `loadedPoints` / `drawnPoints` /
 * `setDrawnPoints` instead, so thinning and the readouts do not care how a dot is drawn.
 */
export type DotShape = 'quad' | 'triangle'

export interface DotState {
  shape: DotShape
  /** Points the tile holds — what thinning draws a prefix of. */
  points: number
  /** False only for the layouts the arrival reorder declines; those are drawn whole,
   *  because a prefix of an unreordered tile is a crop rather than a sample. */
  orderIsFair: boolean
  /** The thinning ramp's current keep fraction, or undefined before its first frame. */
  keepNow?: number
}

interface ShapeDefinition {
  corners: Float32Array
  uvs: Float32Array
  /** How many of the shared index's six entries this shape draws: the quad's two
   *  triangles, or only the first one. See applyDotShapeToGeometry. */
  indexCount: number
  /** Rasterised area in d², for the shaded-area readout. */
  areaFactor: number
}

function triangle(inradius: number): ShapeDefinition {
  // An equilateral triangle's circumradius is twice its inradius. Corners at 90°, 210° and
  // 330° run counter-clockwise, which is the front face: the material is FrontSide, and the
  // mirrored order would cull every point in the cloud.
  const circumradius = 2 * inradius
  const corners = new Float32Array(9)
  const uvs = new Float32Array(6)
  ;[90, 210, 330].forEach((degrees, i) => {
    const angle = THREE.MathUtils.degToRad(degrees)
    const x = Math.cos(angle) * circumradius
    const y = Math.sin(angle) * circumradius
    corners[i * 3] = x
    corners[i * 3 + 1] = y
    // uv = corner + 0.5, so the colour node's `length(uv - 0.5) > 0.5` cut is the same
    // circle it cuts from the quad. The values run outside 0..1, which is harmless:
    // nothing samples a texture with them.
    uvs[i * 2] = x + 0.5
    uvs[i * 2 + 1] = y + 0.5
  })
  return { corners, uvs, indexCount: 3, areaFactor: 3 * Math.sqrt(3) * inradius * inradius }
}

const SHAPES: Record<DotShape, ShapeDefinition> = {
  quad: {
    corners: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indexCount: 6,
    areaFactor: 1,
  },
  // 1 % outside the dot, so no rim pixel is lost to the rasteriser's tie-break at the
  // three points where a circle of exactly 0.5 would touch the edges.
  triangle: triangle(EXPERIENCE_CONFIG.lod.dotGeometry.triInradius),
}

/**
 * The corner sphere of every dot geometry, set by hand. three would compute it from the
 * corners — radius 0.707 for the quad but 1.16 for the triangle, centred off the origin —
 * and three's opaque sort key reads it. Pinning it to the quad's value keeps the draw
 * order identical between the two shapes. (sampleGroundZ used to read it too, to tell a
 * dot mesh from a tile bound by its radius; it now asks what the object is instead.)
 */
const CORNER_SPHERE_RADIUS = Math.SQRT1_2

const QUAD_INDEX = [0, 1, 2, 0, 2, 3]

/**
 * Put `shape`'s corners on a dot geometry. Used at arrival and for a runtime switch: the
 * per-point instanced attributes, the material and the shared node graph are untouched, so
 * the shared pipeline stays valid — only the corner values change.
 *
 * Each geometry gets its own four-corner `position` and `uv` buffers and its own quad index
 * once, and a switch rewrites those buffers in place. Two alternatives were worse:
 *
 * - **New attribute objects per switch.** three r185 never frees an attribute that is
 *   replaced on a live geometry — `renderer.info` keeps a strong reference to every
 *   uploaded attribute, and only a geometry dispose deletes the ones it holds at that
 *   moment — so every switch leaked three small GPU buffers per tile, and a vertex-array
 *   object per tile on WebGL2.
 * - **Shared module-level attributes.** three frees an attribute's GPU buffer when *any*
 *   geometry holding it is disposed, so an unloading tile would pull the corners out from
 *   under every other tile.
 *
 * The shape is chosen by the draw range over the index: all six entries draw the quad's
 * two triangles, the first three draw one triangle from corners 0-2, and corner 3 is then
 * simply never referenced. Same attribute objects, same index, same cache key — the switch
 * is a buffer write, with nothing for three to rebind.
 */
export function applyDotShapeToGeometry(geometry: THREE.BufferGeometry, shape: DotShape): void {
  const definition = SHAPES[shape]
  let position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  let uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!position || !uv || position.count !== 4 || uv.count !== 4 || geometry.index?.count !== 6) {
    position = new THREE.BufferAttribute(new Float32Array(12), 3)
    uv = new THREE.BufferAttribute(new Float32Array(8), 2)
    geometry.setAttribute('position', position)
    geometry.setAttribute('uv', uv)
    geometry.setIndex(QUAD_INDEX)
  }
  const corners = position.array as Float32Array
  const uvs = uv.array as Float32Array
  corners.fill(0)
  uvs.fill(0)
  corners.set(definition.corners)
  uvs.set(definition.uvs)
  position.needsUpdate = true
  uv.needsUpdate = true
  geometry.setDrawRange(0, definition.indexCount)
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CORNER_SPHERE_RADIUS)
}

/**
 * Switch one dot mesh to `shape`, if it is not already drawn that way. Returns whether it
 * changed.
 *
 * No material version bump: the switch writes new values into the same attributes and
 * narrows or widens the draw range, and three uploads a changed attribute on its next draw
 * by version. Nothing structural changes — no attribute, index or pipeline — so there is
 * no render object for three to re-key and no stale one to guard against.
 */
export function applyDotShape(mesh: THREE.Mesh, shape: DotShape): boolean {
  const state = dotState(mesh)
  if (!state || state.shape === shape) return false
  applyDotShapeToGeometry(mesh.geometry, shape)
  state.shape = shape
  return true
}

export function initDotState(mesh: THREE.Mesh, state: DotState): void {
  mesh.userData.dot = state
}

export function dotState(mesh: THREE.Object3D): DotState | undefined {
  return mesh.userData?.dot
}

export function isDotMesh(object: THREE.Object3D): object is THREE.Mesh {
  return dotState(object) !== undefined
}

export function loadedPoints(mesh: THREE.Mesh): number {
  return dotState(mesh)?.points ?? 0
}

export function drawnPoints(mesh: THREE.Mesh): number {
  return (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount ?? 0
}

/** Draw the first `count` points. A prefix, which the arrival reorder makes a fair sample. */
export function setDrawnPoints(mesh: THREE.Mesh, count: number): void {
  const full = loadedPoints(mesh)
  ;(mesh.geometry as THREE.InstancedBufferGeometry).instanceCount =
    Math.max(0, Math.min(full, Math.round(count)))
}

export function dotShapeOf(mesh: THREE.Mesh): DotShape {
  return dotState(mesh)?.shape ?? 'quad'
}

/** Rasterised area per point in d²: what one dot costs in fragments, before the cut. */
export function dotAreaFactor(mesh: THREE.Mesh): number {
  return SHAPES[dotShapeOf(mesh)].areaFactor
}

/** The same for a shape rather than a mesh, for the readout notes. */
export function shapeAreaFactor(shape: DotShape): number {
  return SHAPES[shape].areaFactor
}

export function parseDotShape(value: string | null | undefined): DotShape | null {
  if (value === 'tri' || value === 'triangle') return 'triangle'
  if (value === 'quad') return 'quad'
  return null
}
