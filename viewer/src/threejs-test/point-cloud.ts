// Point-cloud geometry + WebGPU (TSL) material for the render test.
//
// Perf strategy (the levers for 60 FPS on mobile):
//  - ONE flat CPU buffer (from pnts-loader) → GPU buffers built here, no streaming.
//  - Block-grid partition: the cloud is split into a coarse XY grid so Three can
//    frustum-cull whole blocks, and we cheaply cull blocks outside the mask cylinder
//    on the CPU (block.visible=false) so their vertices are never shaded.
//  - Two memory modes:
//      F16  — half-float positions, NO color buffer (6 B/pt). Colour comes from Z
//             (height gradient) in the shader. Positions are stored BLOCK-LOCAL
//             (relative to each block's corner) so 16-bit floats keep sub-cm
//             precision despite the ~1 km scene extent.
//      F32  — float positions + uint8 RGB (15 B/pt). Real colours, full fidelity.
//  - Opaque points (no blending / no depth sort), constant screen-space size.
//
// Float16BufferAttribute does NOT convert floats → half; it just casts to Uint16Array.
// So we encode positions with DataUtils.toHalfFloat ourselves.

import * as THREE from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import {
  Fn, If, Discard, uniform, attribute, positionWorld, positionLocal,
  vec3, vec4, float, mix, smoothstep, clamp, length,
} from 'three/tsl'
import type { LoadedCloud } from './pnts-loader'

export type ColorMode = 'height' | 'rgb'

/** Persistent uniform nodes — kept across geometry rebuilds so mask/size survive. */
export interface CloudUniforms {
  maskCenter: any // vec2, ENU metres
  maskRadius: any // float (metres)
  /** 0 = off · 1 = world circle (ENU) · 2 = viewport vignette */
  maskMode: any   // float
  /** vignette blend 0..1 — fades the spotlight in as the camera approaches (a full
   *  spotlight at globe distances would render the whole screen black) */
  vignetteStrength: any // float
  pointSize: any  // float (px)
  zMin: any       // float (ENU Z)
  zMax: any       // float
  /** world(ECEF)→ENU matrix; mask + height gradient are evaluated in the ENU frame */
  enuInverse: any // mat4
}

export function createUniforms(): CloudUniforms {
  return {
    maskCenter: uniform(new THREE.Vector2(0, 0)),
    maskRadius: uniform(120),
    maskMode: uniform(0),
    vignetteStrength: uniform(0),
    pointSize: uniform(2),
    zMin: uniform(0),
    zMax: uniform(1),
    enuInverse: uniform(new THREE.Matrix4()),
  }
}

/**
 * Vignette dim factor (TSL) for a world position: 1 inside the clear core, fading
 * to 0 (black) toward the mask radius — in the ENU frame, so the falloff is anchored
 * to the world, not the screen. Applied to the point cloud AND the globe imagery so
 * the visible cutout blends seamlessly into black instead of sitting as a hard
 * circle on a bright basemap. Blended by vignetteStrength (camera proximity): at
 * globe distances the spotlight would black out the whole screen, so it only fades
 * in as the camera closes in. Returns 1 when the vignette mode is off.
 */
/**
 * @param floor brightness the fade bottoms out at: 0 for the point cloud (points
 * vanish → discard), ~0.25 for the globe imagery so the map stays faintly visible
 * outside the spotlight — the cloud→map transition goes unnoticed but context remains.
 */
export function maskDimNode(u: CloudUniforms, floor = 0): any {
  const enu = u.enuInverse.mul(vec4(positionWorld, 1)).xyz
  const d = length(enu.xy.sub(u.maskCenter))
  const fade = smoothstep(u.maskRadius, (u.maskRadius as any).mul(0.5), d)
  const floored = fade.mul(1 - floor).add(float(floor))
  const blended = mix(float(1), floored, u.vignetteStrength)
  return (u.maskMode.greaterThan(1.5) as any).select(blended, float(1))
}

export interface CloudBlock {
  mesh: THREE.Points
  /** world-space AABB (centred frame); xy used for the mask-cylinder cull */
  box: THREE.Box3
}

export interface BuiltCloud {
  group: THREE.Group
  blocks: CloudBlock[]
  displayedCount: number
  dispose(): void
}

interface BuildOptions {
  mode: ColorMode
  budget: number
  /** centring offset applied to every point: worldPos = localENU - center */
  center: THREE.Vector3
  uniforms: CloudUniforms
  blockSize?: number
  maxBlocksPerAxis?: number
  /** WebGPU backend active → native Float16Array attributes are usable */
  nativeF16?: boolean
}

/** Shared node material factory — also used by the streaming mode so colours,
 *  point size (uniform) and the ENU mask behave identically in every mode. */
export function createCloudMaterial(mode: ColorMode, u: CloudUniforms): PointsNodeMaterial {
  return makeMaterial(mode, u)
}

function makeMaterial(mode: ColorMode, u: CloudUniforms): PointsNodeMaterial {
  const mat = new PointsNodeMaterial()
  mat.transparent = false
  mat.depthWrite = true
  mat.sizeAttenuation = false // constant screen-space size (predictable for benchmarking)
  mat.sizeNode = u.pointSize // pixels

  // F16 positions are stored as float16x4 (WebGPU has no float16x3). The default
  // position path reads vec3 — WebGPU drops the extra w component of the vertex
  // format, so NO custom positionNode is needed (an explicit vec4 attribute node
  // conflicts with the internal vec3 position handling and shears the blocks).

  // The world frame is ECEF (globe), so mask distance + height gradient are computed
  // in the local ENU frame: enu = enuInverse * worldPos. Precision: fp32 at ECEF
  // magnitude gives ~0.5 m jitter — fine for a colour ramp and a 10–600 m mask.
  mat.colorNode = Fn(() => {
    const enu = u.enuInverse.mul(vec4(positionWorld, 1)).xyz

    // Circle (mode 1): hard ENU-cylinder cut at the radius, crisp edge on the map.
    // Vignette (mode 2): points fade toward the SAME residual brightness the globe
    // imagery keeps (floor 0.25) and are cut at the radius once the spotlight is
    // fully formed — at the cut both render equally dim, so the handover from
    // point cloud to plain map goes unnoticed. Zoomed out (strength < 1) nothing
    // is cut and the map stays lit.
    const d = length(enu.xy.sub(u.maskCenter))
    If(u.maskMode.greaterThan(0.5).and(u.maskMode.lessThan(1.5)).and(d.greaterThan(u.maskRadius)), () => {
      Discard()
    })
    If(u.maskMode.greaterThan(1.5).and(u.vignetteStrength.greaterThan(0.95)).and(d.greaterThan(u.maskRadius)), () => {
      Discard()
    })
    const dim = maskDimNode(u, 0.25)

    // The pnts RGB values are sRGB-encoded; the render pipeline outputs sRGB again,
    // so decode to linear here or the cloud renders washed-out/pale (unlike Cesium).
    if (mode === 'rgb') return (attribute('color', 'vec3') as any).pow(2.2).mul(dim)

    // Height-above-local-ground gradient: block geometry z is already relative to
    // the block's base, so positionLocal.z ≈ vegetation height — robust on sloped
    // terrain (absolute elevation would saturate whole hillsides to one colour).
    const t = clamp(positionLocal.z.div(u.zMax.sub(u.zMin).max(float(0.001))), 0, 1)
    const low = vec3(0.02, 0.18, 0.35)
    const mid = vec3(0.08, 0.55, 0.25)
    const high = vec3(0.95, 0.87, 0.45)
    const a = mix(low, mid, smoothstep(0.0, 0.45, t))
    return mix(a, high, smoothstep(0.45, 1.0, t)).mul(dim)
  })()

  return mat
}

/**
 * Build a block-partitioned point cloud (up to `budget` points) as a Three.Group.
 * Rebuild (dispose old + call again) when mode or budget changes; uniforms persist.
 */
export function buildCloud(cloud: LoadedCloud, opts: BuildOptions): BuiltCloud {
  const { mode, budget, center, uniforms, blockSize = 64, maxBlocksPerAxis = 24, nativeF16 = false } = opts
  const { positions, colors, count, bounds } = cloud

  const cx = center.x, cy = center.y, cz = center.z
  const wMinX = bounds[0] - cx, wMinY = bounds[1] - cy
  const wMaxX = bounds[3] - cx, wMaxY = bounds[4] - cy
  const rangeX = Math.max(wMaxX - wMinX, 1e-3)
  const rangeY = Math.max(wMaxY - wMinY, 1e-3)

  const nx = Math.min(maxBlocksPerAxis, Math.max(1, Math.ceil(rangeX / blockSize)))
  const ny = Math.min(maxBlocksPerAxis, Math.max(1, Math.ceil(rangeY / blockSize)))
  const cellX = rangeX / nx
  const cellY = rangeY / ny
  const nBlocks = nx * ny

  const keepEvery = Math.max(1, Math.ceil(count / budget))
  const blockOf = (wx: number, wy: number) => {
    let bx = Math.floor((wx - wMinX) / cellX); if (bx < 0) bx = 0; if (bx >= nx) bx = nx - 1
    let by = Math.floor((wy - wMinY) / cellY); if (by < 0) by = 0; if (by >= ny) by = ny - 1
    return by * nx + bx
  }

  // Pass A: per-block point count + per-block min/max Z (centred world).
  const blockCount = new Int32Array(nBlocks)
  const blockMinZ = new Float32Array(nBlocks).fill(Infinity)
  const blockMaxZ = new Float32Array(nBlocks).fill(-Infinity)
  for (let i = 0; i < count; i += keepEvery) {
    const wx = positions[i * 3] - cx
    const wy = positions[i * 3 + 1] - cy
    const wz = positions[i * 3 + 2] - cz
    const b = blockOf(wx, wy)
    blockCount[b]++
    if (wz < blockMinZ[b]) blockMinZ[b] = wz
    if (wz > blockMaxZ[b]) blockMaxZ[b] = wz
  }

  // Allocate per-block position (+colour) buffers.
  //
  // F16 mode: three's WebGPU backend has a "patch for UINT16" that value-casts any
  // non-normalized Uint16Array attribute to Uint32Array — which destroys the bit
  // patterns of a Float16BufferAttribute (terraced/flattened geometry). A NATIVE
  // Float16Array (ES2024) dodges that patch and maps to the float16 vertex formats,
  // so half positions require nativeF16 (WebGPU); WebGL falls back to float32.
  const F16: any = (globalThis as any).Float16Array
  const useHalf = mode === 'height' && nativeF16 && typeof F16 !== 'undefined'
  const posComps = useHalf ? 4 : 3 // no float16x3 on WebGPU → pad to x4
  const posArrays: (Float32Array | InstanceType<any>)[] = new Array(nBlocks)
  const colArrays: (Uint8Array | null)[] = new Array(nBlocks)
  const writePtr = new Int32Array(nBlocks)
  const useColor = mode === 'rgb'
  for (let b = 0; b < nBlocks; b++) {
    const n = blockCount[b]
    if (n === 0) { posArrays[b] = useHalf ? new F16(0) : new Float32Array(0); colArrays[b] = null; continue }
    posArrays[b] = useHalf ? new F16(n * 4) : new Float32Array(n * 3)
    colArrays[b] = useColor ? new Uint8Array(n * 3) : null
  }

  const originX = (b: number) => wMinX + (b % nx) * cellX
  const originY = (b: number) => wMinY + Math.floor(b / nx) * cellY

  // Pass B: write block-local positions (+colours). Local origin = cell corner (xy)
  // and block min-Z, keeping local coords small → F16 stays sub-cm accurate.
  for (let i = 0; i < count; i += keepEvery) {
    const wx = positions[i * 3] - cx
    const wy = positions[i * 3 + 1] - cy
    const wz = positions[i * 3 + 2] - cz
    const b = blockOf(wx, wy)
    const p = writePtr[b]++
    const lx = wx - originX(b)
    const ly = wy - originY(b)
    const lz = wz - blockMinZ[b]
    const pa = posArrays[b]
    // Float16Array encodes on write; w=1 so a raw vec4 read keeps translations intact.
    pa[p * posComps] = lx; pa[p * posComps + 1] = ly; pa[p * posComps + 2] = lz
    if (useHalf) pa[p * 4 + 3] = 1
    const c = colArrays[b]
    if (c) { c[p * 3] = colors[i * 3]; c[p * 3 + 1] = colors[i * 3 + 1]; c[p * 3 + 2] = colors[i * 3 + 2] }
  }

  // Build one Three.Points per non-empty block (all share one material).
  const material = makeMaterial(mode, uniforms)
  const group = new THREE.Group()
  const blocks: CloudBlock[] = []
  let displayed = 0
  for (let b = 0; b < nBlocks; b++) {
    const n = blockCount[b]
    if (n === 0) continue
    const geom = new THREE.BufferGeometry()
    const posAttr = useHalf
      ? new THREE.BufferAttribute(posArrays[b], 4) // native Float16Array → float16x4
      : new THREE.BufferAttribute(posArrays[b] as Float32Array, 3)
    geom.setAttribute('position', posAttr)
    if (colArrays[b]) {
      geom.setAttribute('color', new THREE.Uint8BufferAttribute(colArrays[b] as Uint8Array, 3, true))
    }

    const oz = blockMinZ[b]
    const box = new THREE.Box3(
      new THREE.Vector3(originX(b), originY(b), oz),
      new THREE.Vector3(originX(b) + cellX, originY(b) + cellY, blockMaxZ[b]),
    )
    // Local coords are in [0..cell], so the bounding volume is a cheap known box.
    geom.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(cellX, cellY, blockMaxZ[b] - oz))
    geom.boundingSphere = new THREE.Sphere().setFromPoints([geom.boundingBox.min, geom.boundingBox.max])

    const pts = new THREE.Points(geom, material)
    pts.position.set(originX(b), originY(b), oz) // block-local → world (centred)
    pts.frustumCulled = true
    group.add(pts)
    blocks.push({ mesh: pts, box })
    displayed += n
  }

  return {
    group,
    blocks,
    displayedCount: displayed,
    dispose() {
      for (const { mesh } of blocks) mesh.geometry.dispose()
      material.dispose()
      group.clear()
    },
  }
}
