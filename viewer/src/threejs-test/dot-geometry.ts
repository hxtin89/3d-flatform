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

/**
 * How the GPU is handed the points — step 2 of plans/plan-dot-geometry-ab.md.
 *
 * - **instanced**: one hardware instance per point, the corners in a tiny per-vertex
 *   buffer and the point in per-instance attributes. Today's path. Measured: the cost is
 *   per instance, because a 3- or 4-vertex instance fills a whole vertex batch.
 * - **pulled**: no instancing and no per-vertex attributes at all. Each tile draws
 *   `k × points` vertices (k = 3 for the triangle, 6 indices over 4 corners for the quad);
 *   the shader derives the point from the vertex index and reads it from a per-tile data
 *   texture, so vertices of many points share a batch. Same 16 bytes per point on the GPU.
 */
export type DotFeed = 'instanced' | 'pulled'

export interface DotMode {
  shape: DotShape
  feed: DotFeed
}

export function sameDotMode(a: DotMode, b: DotMode): boolean {
  return a.shape === b.shape && a.feed === b.feed
}

export interface DotState {
  /** Current feed. The shape below is always the one drawn in it. */
  feed: DotFeed
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
  // Instanced only: a pulled tile's shape lives in its geometry and its shader, so a shape
  // change there is a rebuild — see applyDotMode in streaming.ts.
  if (!state || state.feed !== 'instanced' || state.shape === shape) return false
  applyDotShapeToGeometry(mesh.geometry, shape)
  state.shape = shape
  return true
}

/** The corners a shape draws, in order, in drawn diameters — for the pulled shader's
 *  lookup table, which indexes them by `vertexIndex % k`. */
export function dotCorners(shape: DotShape): [number, number][] {
  const corners = SHAPES[shape].corners
  const count = shape === 'triangle' ? 3 : 4
  const out: [number, number][] = []
  for (let i = 0; i < count; i++) out.push([corners[i * 3], corners[i * 3 + 1]])
  return out
}

/** Vertices (triangle) or indices (quad) a pulled tile draws per point. */
export function pulledVerticesPerPoint(shape: DotShape): number {
  return shape === 'triangle' ? 3 : 6
}

// ---------------------------------------------------------------- pulled feed

/** Width of every point-data texture, a power of two so the shader splits the point index
 *  into a column and a row with a mask and a shift. 1024 keeps a 270 k-point tile at 264
 *  rows, and caps a tile at ~2 M points under WebGL2's guaranteed 2048-row minimum. */
export const POINT_DATA_WIDTH = EXPERIENCE_CONFIG.lod.dotGeometry.textureWidth
export const POINT_DATA_WIDTH_BITS = Math.round(Math.log2(POINT_DATA_WIDTH))

/**
 * Pack a tile's points into one RGBA32F texel each: xyz = the tile-local position, w =
 * the colour as the exact integer `r·65536 + g·256 + b`.
 *
 * 16 bytes per point, the same as the instanced path's two attributes. The colour goes in
 * as an integer-valued float rather than bit-cast bytes: every integer below 2²⁴ is exact
 * in float32, and decoding needs only power-of-two divides, identical in WGSL and GLSL.
 * Bit-casting RGBA8 would not survive — with alpha 255 about half of all colours land on
 * NaN or Inf patterns. Alpha is dropped; the cloud never reads it.
 *
 * Every tile's texture has the same format, type and filters. Those are not in three's
 * render cache key, but the generated shader and its bind layout depend on them, so one
 * odd texture would reuse an incompatible pipeline.
 */
export function packPointData(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  color: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined,
): THREE.DataTexture {
  const count = position.count
  const width = POINT_DATA_WIDTH
  const height = Math.max(1, Math.ceil(count / width))
  // Whole rows: the upload copies full rows, so the last one is padded.
  const data = new Float32Array(width * height * 4)
  const src = position.array
  const flat = src instanceof Float32Array && position.itemSize === 3
    && !(position as any).isInterleavedBufferAttribute
  const colours = color?.array
  const colourItems = color?.itemSize ?? 0
  const byteColours = colours instanceof Uint8Array && (colourItems === 3 || colourItems === 4)
    && !(color as any).isInterleavedBufferAttribute
  for (let i = 0, d = 0; i < count; i++, d += 4) {
    if (flat) {
      const s = i * 3
      data[d] = src[s]; data[d + 1] = src[s + 1]; data[d + 2] = src[s + 2]
    } else {
      data[d] = position.getX(i); data[d + 1] = position.getY(i); data[d + 2] = position.getZ(i)
    }
    // No colour attribute: black, because that is what the instanced graph draws — three's
    // attribute node falls back to vec3(0) when a geometry lacks `cloudPointColor`.
    let r = 0, g = 0, b = 0
    if (byteColours) {
      const s = i * colourItems
      r = colours[s]; g = colours[s + 1]; b = colours[s + 2]
    } else if (color) {
      r = Math.round(color.getX(i) * 255); g = Math.round(color.getY(i) * 255); b = Math.round(color.getZ(i) * 255)
    }
    data[d + 3] = r * 65536 + g * 256 + b
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.flipY = false
  // No per-draw uv matrix work on the WebGL fallback.
  texture.matrixAutoUpdate = false
  texture.name = 'cloudPointData'
  texture.userData.cloudPointData = true
  texture.needsUpdate = true
  return texture
}

let sharedQuadIndex: THREE.BufferAttribute | null = null
let sharedQuadIndexPoints = 0

/**
 * The index every pulled quad draws from: `4i + {0,1,2,0,2,3}`, so `vertexIndex` carries
 * the point (÷ 4) and the corner (mod 4) and the quad keeps the vertex reuse it has today.
 *
 * One buffer for every tile, grown to the largest tile seen. It starts at 2¹⁹ points
 * (12.6 MB) because the deployed overview tile holds 270 k points, just over 2¹⁸ — starting
 * lower grew it on the first real load. A superseded index stays with the geometries that
 * hold it, which is still valid for their counts, and three frees it as they are disposed:
 * only the *current* shared index is protected from a tile's dispose (buildPulledGeometry).
 */
function quadIndexFor(points: number): THREE.BufferAttribute {
  if (!sharedQuadIndex || points > sharedQuadIndexPoints) {
    const capacity = Math.max(1 << 19, 2 ** Math.ceil(Math.log2(Math.max(1, points))))
    const index = new Uint32Array(capacity * 6)
    for (let i = 0, j = 0; i < capacity; i++, j += 6) {
      const v = i * 4
      index[j] = v; index[j + 1] = v + 1; index[j + 2] = v + 2
      index[j + 3] = v; index[j + 4] = v + 2; index[j + 5] = v + 3
    }
    sharedQuadIndex = new THREE.BufferAttribute(index, 1)
    sharedQuadIndexPoints = capacity
  }
  return sharedQuadIndex
}

/**
 * The geometry of a pulled tile: no attributes at all, and for the quad the shared index.
 *
 * The draw range is mandatory — with no position attribute three would compute an infinite
 * vertex count and skip the draw. The bounding sphere is pinned like the instanced one's,
 * for three's sort order.
 *
 * The shared index must survive any one tile's disposal: three frees the index of a
 * geometry on its `dispose` event without counting who else holds it, and UnloadTilesPlugin
 * disposes geometries every time a tile leaves the screen. So the current shared index is
 * detached for the length of the dispose call and put back afterwards, when the tile may be
 * shown again. A superseded one is left attached, so three frees it like any other; a tile
 * that still draws with it re-uploads it from its CPU array, as three does for any index.
 *
 * Expected console noise: three logs `AttributeNode: Vertex attribute "position" not found
 * on geometry.` once per pulled pipeline build. NodeMaterial.setupPosition assigns
 * positionLocal, which is declared as a varying of the `position` attribute; the varying
 * starts at vec3(0) and is then assigned positionNode, so nothing drawn changes. A dummy
 * `position` attribute to silence it would clamp the non-indexed draw to its count.
 */
export function buildPulledGeometry(shape: DotShape, points: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  if (shape === 'quad') {
    geometry.setIndex(quadIndexFor(points))
    const baseDispose = geometry.dispose.bind(geometry)
    geometry.dispose = () => {
      const index = geometry.index
      const shared = index !== null && index === sharedQuadIndex
      if (shared) geometry.index = null
      baseDispose()
      if (shared) geometry.index = index
    }
  }
  geometry.setDrawRange(0, points * pulledVerticesPerPoint(shape))
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CORNER_SPHERE_RADIUS)
  geometry.userData.pulledDots = true
  return geometry
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
  const state = dotState(mesh)
  if (state?.feed === 'pulled') {
    return Math.round(mesh.geometry.drawRange.count / pulledVerticesPerPoint(state.shape))
  }
  return (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount ?? 0
}

/**
 * Draw the first `count` points. A prefix, which the arrival reorder makes a fair sample —
 * in both feeds: a draw range of `k·n` vertices or indices draws points 0..n-1 exactly as
 * an instance count of n does, so thinning and its dissolve carry over unchanged.
 */
export function setDrawnPoints(mesh: THREE.Mesh, count: number): void {
  const state = dotState(mesh)
  const n = Math.max(0, Math.min(loadedPoints(mesh), Math.round(count)))
  if (state?.feed === 'pulled') {
    mesh.geometry.setDrawRange(0, n * pulledVerticesPerPoint(state.shape))
  } else {
    ;(mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = n
  }
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

export function dotModeOf(mesh: THREE.Mesh): DotMode | null {
  const state = dotState(mesh)
  return state ? { shape: state.shape, feed: state.feed } : null
}

export function parseDotFeed(value: string | null | undefined): DotFeed | null {
  if (value === 'pull' || value === 'pulled') return 'pulled'
  if (value === 'inst' || value === 'instanced') return 'instanced'
  return null
}

export function parseDotShape(value: string | null | undefined): DotShape | null {
  if (value === 'tri' || value === 'triangle') return 'triangle'
  if (value === 'quad') return 'quad'
  return null
}
