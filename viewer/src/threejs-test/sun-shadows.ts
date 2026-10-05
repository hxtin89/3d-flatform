// Soft sun shadows of the canopy: an optical-depth map of the point cloud, splatted additively
// from the sun's side, fitted to the sphere-fade dome, blurred in metres and read by the
// points, the basemap and the volumetric fog's march.
//
// Why not a depth map. The canopy is porous: a crown lets light through its gaps and gets
// darker inward, and the points are a sparse, streamed, thinned sample of it with sub-pixel
// holes between splats. A depth map stores only the nearest occluder, so it shadows by binary
// coverage — every hole a sharp sunfleck, every LOD change a flicker — and filtering it needs
// many taps per lookup, which the fog's march (tens of millions of samples a frame) cannot
// afford. Additive, order-independent optical depth is what works for points and splats alike
// (Hillaire's Beer shadow map, moment-based splat shadows): one geometry pass, no sorting, no
// depth test, and every stored value a plain sum, so a Gaussian blur and mipmaps filter it
// exactly. Researched 2026-10-01 against PCF/PCSS, VSM, EVSM, ESM, MSM, opacity maps and
// Beer shadow maps; the write-up lists the numbers.
//
// What is stored. Per texel, over every splat landing on it: Σw, Σw·h, Σw·h² — the optical
// depth and the first two moments of the occluders' height above the area floor (in units of
// the canopy's height). A receiver at height h_r takes the share of that optical depth above
// it from a uniform slab with the same mean and spread, and sees exp(−τ). A point at the top
// of a crown is lit, the ground under the trees gets all of it, a point inside the crown is in
// between — the light falls off inward without any normal.
//
// Projection. Not a light camera: each point is projected along the sun onto the floor plane,
// q = xy − sun.xy / sun.z · (z − floor). Along a sun ray the height is all that changes, which
// is why height moments work: they never need the depth along the ray, whose range at a low
// sun spans the whole dome and would swamp half-float precision. The shear preserves area, so
// a horizontal layer of points keeps its density on the map and the optical depth along the
// slanted ray is the layer's vertical depth over the sine of the sun's elevation.
//
// Fit. The map covers the sphere-fade dome — only there are points drawn — plus the stretch a
// canopy's height throws its shadow at this sun, around the dome's centre projected to the
// floor. The extent is quantised to quarter octaves with hysteresis and the centre snapped to
// whole texels, so the shadows do not swim as the dome eases. The dome scales with the camera's
// distance, so the map's texels do too: close up 0.5 m, from far away a few metres, every zoom
// level the same number of texels across the view — the job cascades usually do. An optional
// inner cascade over the dome's middle sharpens close-ups further.
//
// Casters. Every loaded tile whose points are on the GPU — shown, or hidden since it was last
// shown and not yet released — each as a proxy in a private scene that shares the tile's
// geometry and point data and draws a fixed share of its loaded points: the arrival reorder
// makes any prefix a fair sample, and each splat's weight rises by the share left out. None of
// it follows the camera. It used to: the casters were the tiles drawn this frame, at the count
// the thinning drew, weighed by the stack spacing the streaming eases — so a turn dropped the
// tiles leaving the frustum and their shadows with them, and for seconds after every move the
// dissolve's drifting counts redrew the map with a different sample every other frame (the
// shimmer that looked like loading). The levels of the hierarchy overlap where a tile is
// refined (ADD); a fourth channel counts them and the receivers divide by it, so refinement
// changes the shadows' detail, never their depth. No dome melt in the shadow pass either.
import * as THREE from 'three'
import { NodeMaterial, QuadMesh, RenderTarget } from 'three/webgpu'
import * as TSL from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'
import { cloudCasterGraphFor, type CloudUniforms, type ShadowCasterUniforms } from './point-cloud'
import { dotModeOf, drawnPoints, loadedPoints, setDrawnPoints } from './dot-geometry'

const { Fn, If, Loop, abs, clamp, exp, float, int, max, min, mix, renderGroup, select, smoothstep, sqrt, texture, uniform, uv, vec2, vec4 } = TSL as any

const CONFIG = EXPERIENCE_CONFIG.sunShadows

export interface SunShadowParams {
  /** Texels per side of each cascade. */
  resolution: number
  /** 1: the dome-fitted map alone; 2: plus an inner map over the dome's middle. */
  cascades: number
  /** Inner cascade's half extent against the outer one's. */
  cascadeSplit: number
  /** Optical depth of one fully covered layer of points, straight up. */
  density: number
  /** Multiplier on the optical depth at every receiver. */
  strength: number
  /** Gaussian blur, metres (one standard deviation): the softness of the blobs. */
  softnessM: number
  /** Share of each tile's points drawn into the map. */
  pointFraction: number
  /** Splat radius against the points' spacing. */
  splatScale: number
  /** Smallest splat radius, texels: below it a splat could miss every texel centre. */
  minSplatTexels: number
  /** How far a point is lifted toward the sun before it looks itself up, metres: a point does
   *  not shadow itself. */
  selfOffsetM: number
  /** Floor on the occluders' height spread, metres. */
  minSpreadM: number
  /** Redraw the map at most every this many frames (it is also skipped when nothing moved). */
  updateEvery: number
  /** Sun elevations (degrees) over which the shadows fade in: below the first none. */
  fadeStartDeg: number
  fadeEndDeg: number
  /** In the fog's march: multiplier on the optical depth, and the extra mip levels it reads
   *  over its footprint (blurrier is steadier). */
  fogStrength: number
  fogLodBias: number
}

// ---------------------------------------------------------------- shared nodes
// Module-level, so the tile graphs that read them can be built before the layer exists; the
// layer swaps the textures in and writes the uniforms. A 1-texel zero map until then: τ = 0,
// fully lit.
// With the maps' own sampler state: three keeps a texture node's sampler until the texture's
// version changes, so a node built on a nearest, unmipmapped stand-in would sample the maps so.
const placeholder = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType)
placeholder.magFilter = THREE.LinearFilter
placeholder.minFilter = THREE.LinearMipmapLinearFilter
placeholder.wrapS = placeholder.wrapT = THREE.ClampToEdgeWrapping
placeholder.needsUpdate = true
const group = (node: any) => node.setGroup(renderGroup)
export const canopyShadow = {
  maps: [texture(placeholder), texture(placeholder)] as any[],
  /** Per cascade: the floor-plane centre (raw ENU xy) and half extent, metres. */
  centre0: group(uniform(new THREE.Vector2())),
  half0: group(uniform(1e6)),
  centre1: group(uniform(new THREE.Vector2())),
  half1: group(uniform(1e6)),
  cascades: group(uniform(1)),
  sun: group(uniform(new THREE.Vector3(0, 0, 1))),
  floorZ: group(uniform(0)),
  bandHeightInv: group(uniform(1 / 80)),
  strength: group(uniform(1)),
  offset: group(uniform(CONFIG.selfOffsetM)),
  minSpread: group(uniform(CONFIG.minSpreadM / 80)),
  /** 0 → 1 as the sun climbs through the fade band; 0 also while the layer is off. */
  fade: group(uniform(0)),
  texel1: group(uniform(1)),
}

/** The map's (u, v) for an ENU position, on the floor plane along the sun, for a cascade. */
const floorUv = (enu: any, centre: any, half: any) => {
  const s = canopyShadow.sun
  const sz = max(s.z, 0.08)
  const q = enu.xy.sub(s.xy.div(sz).mul(enu.z.sub(canopyShadow.floorZ)))
  const ndc = q.sub(centre).div(half)
  // uv.y = 0 is the target's top row, which a clip-space y of +1 lands on (both backends).
  return vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5))
}

/** Optical depth above height `hRel` (canopy units) from one texel's moments. */
const opticalDepthAbove = (m: any, hRel: any) => {
  // Divided by the number of overlapping hierarchy levels (one where a tile is not refined).
  const total = max(m.x, 0).div(max(m.w, 1))
  const mean = m.y.div(max(m.x, 1e-5))
  const variance = max(m.z.div(max(m.x, 1e-5)).sub(mean.mul(mean)), canopyShadow.minSpread.mul(canopyShadow.minSpread))
  const spread = sqrt(variance).mul(1.7320508)
  const above = clamp(mean.add(spread).sub(hRel).div(spread.mul(2)), 0, 1)
  return total.mul(above)
}

/**
 * Transmittance of the sun to an ENU position through the canopy, 1 outside the map. `lift`
 * raises the receiver toward the sun first (metres; points pass the self-offset, ground 0).
 * `level`, when given, picks the mip (the fog reads blurrier levels).
 */
export function canopyTransmittance(enu: any, lift: any, level: any = null, strength: any = null): any {
  // Its own function body, so the inner cascade's read is a real branch: with one cascade
  // (the default) no receiver pays for the second map.
  return Fn(() => {
    const hRel = enu.z.sub(canopyShadow.floorZ).add(lift).mul(canopyShadow.bandHeightInv)
    const read = (map: any, st: any) => (level === null ? map.sample(st).level(0) : map.sample(st).level(level))
    const edge = (st: any) => {
      const d = max(abs(st.x.sub(0.5)), abs(st.y.sub(0.5)))
      return float(1).sub(smoothstep(0.44, 0.5, d))
    }
    const st1 = floorUv(enu, canopyShadow.centre1, canopyShadow.half1)
    const tau = opticalDepthAbove(read(canopyShadow.maps[1], st1), hRel).mul(edge(st1)).toVar()
    If(canopyShadow.cascades.greaterThan(1.5), () => {
      // The inner cascade where it covers the receiver, blending into the outer one at its rim.
      const st0 = floorUv(enu, canopyShadow.centre0, canopyShadow.half0)
      tau.assign(mix(tau, opticalDepthAbove(read(canopyShadow.maps[0], st0), hRel), edge(st0)))
    })
    return exp(tau.mul(strength ?? canopyShadow.strength).mul(canopyShadow.fade).negate())
  })()
}

// ---------------------------------------------------------------- the layer

export interface SunShadowInput {
  /** Render space → the shader's raw ENU frame. */
  enuInverse: THREE.Matrix4
  sunDirectionEnu: THREE.Vector3
  /** Dome centre (render space) and the inner radius points are drawn within; null while
   *  the dome is not placed — then the map follows the camera's ground point. */
  domeCentre: THREE.Vector3 | null
  domeRadius: number
  /** Fallback centre (render space) and radius when there is no dome. */
  fallbackCentre: THREE.Vector3
  fallbackRadius: number
  /** Floor of the point cloud and its height span above it, raw ENU metres. */
  floorZ: number
  bandHeightM: number
  /** Visits every loaded dot mesh (streaming.ts forEachLoadedQuad): `attached` false for a
   *  tile the renderer has hidden, with the world matrix it would draw with. */
  forEachCaster(visit: (mesh: THREE.Mesh, attached: boolean, matrixWorld: THREE.Matrix4) => void): void
}

export interface SunShadowStats {
  enabled: boolean
  casters: number
  /** Of those, hidden tiles (out of the frustum or not needed at this distance). */
  hiddenCasters: number
  pointsDrawn: number
  updates: number
  lastUpdateFrame: number
  halfExtentM: number
  texelM: number
}

export interface SunShadowLayer {
  readonly params: SunShadowParams
  isEnabled(): boolean
  setEnabled(enabled: boolean): void
  /** Per frame, after the tiles for this frame are known and before the scene renders. */
  update(input: SunShadowInput): void
  /** Redraw on the next update whatever has moved (a setting changed). */
  invalidate(): void
  /** The outer map, for the debug view. */
  debugTexture(): THREE.Texture
  /** Debugging: the outer map's texels (Σw, Σw·h, Σw·h², layers), as stored. */
  debugRead(): Promise<{ width: number; height: number; data: Float32Array | Uint16Array } | null>
  stats(): SunShadowStats
  dispose(): void
}

interface Proxy {
  mesh: THREE.Mesh
  source: THREE.Mesh
  material: NodeMaterial
  sourceMaterial: THREE.Material
  graphKey: string
  lastUsed: number
  count: number
  /** Takes the dispose listener off the tile's material. */
  release: () => void
}

export function createSunShadowLayer(opts: { renderer: any; uniforms: CloudUniforms }): SunShadowLayer {
  const { renderer, uniforms } = opts
  const params: SunShadowParams = {
    resolution: CONFIG.resolution,
    cascades: CONFIG.cascades,
    cascadeSplit: CONFIG.cascadeSplit,
    density: CONFIG.density,
    strength: CONFIG.strength,
    softnessM: CONFIG.softnessM,
    pointFraction: CONFIG.pointFraction,
    splatScale: CONFIG.splatScale,
    minSplatTexels: CONFIG.minSplatTexels,
    selfOffsetM: CONFIG.selfOffsetM,
    minSpreadM: CONFIG.minSpreadM,
    updateEvery: CONFIG.updateEvery,
    fadeStartDeg: CONFIG.fadeStartDeg,
    fadeEndDeg: CONFIG.fadeEndDeg,
    fogStrength: CONFIG.fogStrength,
    fogLodBias: CONFIG.fogLodBias,
  }
  let enabled: boolean = CONFIG.enabled

  // The caster pass's own uniforms, written per cascade before each draw (renderGroup values
  // are read at the start of every render call).
  const caster: ShadowCasterUniforms = {
    sun: group(uniform(new THREE.Vector3(0, 0, 1))),
    floorZ: group(uniform(0)),
    centre: group(uniform(new THREE.Vector2())),
    halfExtent: group(uniform(1000)),
    texelM: group(uniform(1)),
    bandHeightInv: group(uniform(1 / 80)),
    splatScale: group(uniform(params.splatScale)),
    fraction: group(uniform(params.pointFraction)),
    density: group(uniform(params.density)),
    minTexels: group(uniform(params.minSplatTexels)),
    unitScale: group(uniform(1)),
  }

  // ---------------------------------------------------------------- targets
  // Made once and resized, never replaced: a texture node switched to another render target
  // keeps sampling the old one in r185, so every node here reads one fixed target.
  let resolution = 0
  const accum: RenderTarget[] = []
  const finals: RenderTarget[] = []
  let blurTemp: RenderTarget | null = null
  let blurPasses: { horizontal: QuadMesh[]; vertical: QuadMesh } | null = null
  const makeTarget = (size: number, mips: boolean, name: string) => {
    const target = new RenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false })
    const t = target.texture
    t.name = name
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
    t.magFilter = THREE.LinearFilter
    t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
    t.generateMipmaps = mips
    return target
  }
  /** The inner cascade's map size: a texel while one cascade is on (it is bound, never drawn). */
  let innerSize = 0
  const releaseTargets = () => {
    for (const target of [...accum, ...finals, blurTemp]) target?.dispose()
    resolution = 0
    innerSize = 0
  }
  const ensureTargets = () => {
    const size = THREE.MathUtils.clamp(2 ** Math.round(Math.log2(Math.max(params.resolution, 256))), 256, 4096)
    const inner = params.cascades >= 2 ? size : 1
    if (size === resolution && inner === innerSize) return
    resolution = size
    innerSize = inner
    if (!blurTemp) {
      // One accumulation and one blur target, shared by the cascades (drawn one after the
      // other); a final, mipmapped map per cascade.
      accum.push(makeTarget(size, false, 'canopy-shadow-accum'))
      for (let c = 0; c < 2; c++) finals.push(makeTarget(c === 0 ? inner : size, true, `canopy-shadow-${c}`))
      blurTemp = makeTarget(size, false, 'canopy-shadow-blur')
      canopyShadow.maps[0].value = finals[0].texture
      canopyShadow.maps[1].value = finals[1].texture
      blurPasses = {
        horizontal: [blurPass(accum[0].texture, true)],
        vertical: blurPass(blurTemp.texture, false),
      }
    } else {
      for (const target of [...accum, finals[1], blurTemp]) target.setSize(size, size)
      finals[0].setSize(inner, inner)
    }
    forceUpdate = true
  }

  // ---------------------------------------------------------------- blur
  // Separable Gaussian over ±3σ: one tap per texel while σ is under 8/3 texels (as many taps
  // as that needs, 3 to 17), spaced wider beyond (bilinear taps fill between them). One pass
  // per input target: a texture node's target never changes (see the targets above).
  const blurTexel = uniform(1)
  const blurSigma = uniform(1)
  /** Taps on each side of the centre, 1–8. */
  const blurTaps = uniform(8)
  const blurPass = (input: THREE.Texture, horizontal: boolean): QuadMesh => {
    const source = texture(input)
    const node = Fn(() => {
      const st = uv()
      const sum = vec4(0).toVar()
      const weight = float(0).toVar()
      const spacing = max(blurSigma.mul(3).div(8), 1)
      const step = horizontal ? vec2(blurTexel, 0) : vec2(0, blurTexel)
      Loop({ start: int(blurTaps).negate(), end: int(blurTaps), type: 'int', condition: '<=' }, ({ i }: { i: any }) => {
        const offset = float(i).mul(spacing)
        const w = exp(offset.mul(offset).div(max(blurSigma.mul(blurSigma).mul(2), 1e-4)).negate())
        sum.addAssign(source.sample(st.add(step.mul(offset))).level(0).mul(w))
        weight.addAssign(w)
      })
      return sum.div(max(weight, 1e-6))
    })()
    const material = new NodeMaterial()
    material.fragmentNode = node
    material.name = horizontal ? 'canopy-shadow-blur-h' : 'canopy-shadow-blur-v'
    return new QuadMesh(material)
  }
  const runBlur = (pass: QuadMesh, target: RenderTarget, sigmaTexels: number) => {
    blurTexel.value = 1 / resolution
    blurSigma.value = Math.max(sigmaTexels, 0.01)
    const spacing = Math.max(blurSigma.value * 3 / 8, 1)
    blurTaps.value = THREE.MathUtils.clamp(Math.ceil(blurSigma.value * 3 / spacing), 1, 8)
    renderer.setRenderTarget(target)
    pass.render(renderer)
  }

  // ---------------------------------------------------------------- casters
  const shadowScene = new THREE.Scene()
  shadowScene.name = 'canopy-shadow-casters'
  shadowScene.matrixWorldAutoUpdate = false
  const shadowCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const proxies = new Map<THREE.Mesh, Proxy>()
  let frame = 0
  const casterMaterialFor = (source: THREE.Mesh): { material: NodeMaterial; key: string } | null => {
    const mode = dotModeOf(source)
    const sourceMaterial = source.material as any
    if (!mode || !sourceMaterial) return null
    const colorSize = (source.geometry.getAttribute('cloudPointColor') as any)?.itemSize ?? 3
    const graph = cloudCasterGraphFor(uniforms, colorSize, mode, caster)
    const material = new NodeMaterial()
    material.name = 'canopy-shadow-caster'
    material.vertexNode = graph.vertexNode
    material.fragmentNode = graph.fragmentNode
    material.transparent = true
    material.depthTest = false
    material.depthWrite = false
    material.side = THREE.DoubleSide
    material.blending = THREE.CustomBlending
    material.blendEquation = THREE.AddEquation
    material.blendSrc = THREE.OneFactor
    material.blendDst = THREE.OneFactor
    material.blendEquationAlpha = THREE.AddEquation
    material.blendSrcAlpha = THREE.OneFactor
    material.blendDstAlpha = THREE.OneFactor
    material.fog = false
    material.lights = false
    // The tile's own point data and per-tile holders (spacing, thinning), by reference: the
    // shared graph reads them off whichever material is being drawn.
    if (sourceMaterial.pointData) (material as any).pointData = sourceMaterial.pointData
    material.userData = sourceMaterial.userData
    return { material, key: graph.key }
  }
  const dropProxy = (proxy: Proxy) => {
    proxy.release()
    shadowScene.remove(proxy.mesh)
    proxy.material.dispose()
    proxies.delete(proxy.source)
  }
  const proxyFor = (source: THREE.Mesh): Proxy | null => {
    let proxy = proxies.get(source)
    const sourceMaterial = source.material as THREE.Material
    const wantedKey = proxy ? cloudCasterKey(source) : ''
    if (proxy && (proxy.sourceMaterial !== sourceMaterial || proxy.graphKey !== wantedKey
      || (proxy.material as any).pointData !== (sourceMaterial as any).pointData)) {
      dropProxy(proxy)
      proxy = undefined
    }
    if (!proxy) {
      const built = casterMaterialFor(source)
      if (!built) return null
      const mesh = new THREE.Mesh(source.geometry, built.material)
      mesh.frustumCulled = false
      mesh.matrixAutoUpdate = false
      mesh.name = 'canopy-shadow-proxy'
      // Gone with the tile's material (an UnloadTilesPlugin hide, an eviction): the proxy must not
      // keep the tile's scene, arrays and point data alive. Cheap to make again on the next show.
      // Marked too: a hidden tile whose GPU copy was released must not be drawn back up by
      // the shadow pass. Shown again, it uploads itself and casts again.
      const onSourceDisposed = () => {
        ;(sourceMaterial as any).userData.shadowReleased = true
        if (proxies.get(source) === created) dropProxy(created)
      }
      sourceMaterial.addEventListener('dispose', onSourceDisposed)
      const created: Proxy = {
        mesh, source, material: built.material, sourceMaterial, graphKey: built.key, lastUsed: frame, count: 0,
        release: () => sourceMaterial.removeEventListener('dispose', onSourceDisposed),
      }
      // The geometry is the tile's own: draw a prefix of it for the shadow pass and put the
      // tile's count back right after, so the main pass never sees the change.
      let saved = 0
      mesh.onBeforeRender = () => { saved = drawnPoints(source); setDrawnPoints(source, created.count) }
      mesh.onAfterRender = () => { setDrawnPoints(source, saved) }
      proxies.set(source, created)
      proxy = created
    }
    proxy.mesh.geometry = source.geometry
    return proxy
  }
  const cloudCasterKey = (source: THREE.Mesh) => {
    const mode = dotModeOf(source)
    const colorSize = (source.geometry.getAttribute('cloudPointColor') as any)?.itemSize ?? 3
    return mode ? cloudCasterGraphFor(uniforms, colorSize, mode, caster).key : ''
  }

  // ---------------------------------------------------------------- fit and schedule
  let forceUpdate = true
  let updates = 0
  let lastUpdateFrame = -1
  let quantisedHalf = 0
  let lastPointsDrawn = 0
  let lastCasters = 0
  let lastHiddenCasters = 0
  const lastSun = new THREE.Vector3()
  const lastCentre = new THREE.Vector2(Infinity, Infinity)
  let lastSignature = ''
  const centreEnu = new THREE.Vector3()
  const scratch = new THREE.Vector3()
  const fitCentre = new THREE.Vector2()
  const scratchAzimuth = new THREE.Vector2()
  const scratchCentre = new THREE.Vector2()
  const scratchClear = new THREE.Color()

  const layer: SunShadowLayer = {
    params,
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = next
      if (!enabled) {
        canopyShadow.fade.value = 0
        for (const proxy of [...proxies.values()]) dropProxy(proxy)
        // Frees the GPU memory; the targets themselves stay, re-allocated on the next draw.
        releaseTargets()
      }
      forceUpdate = true
    },
    invalidate() { forceUpdate = true },
    debugTexture: () => finals[1]?.texture ?? placeholder,
    async debugRead() {
      const target = finals[1]
      if (!target || !resolution) return null
      const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height)
      return { width: target.width, height: target.height, data }
    },
    stats: () => ({
      enabled, casters: lastCasters, hiddenCasters: lastHiddenCasters, pointsDrawn: lastPointsDrawn, updates, lastUpdateFrame,
      halfExtentM: quantisedHalf, texelM: quantisedHalf * 2 / Math.max(resolution, 1),
    }),
    update(input) {
      frame++
      if (!enabled) { canopyShadow.fade.value = 0; return }
      ensureTargets()
      const sun = scratch.copy(input.sunDirectionEnu).normalize()
      const elevationDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sun.z, -1, 1)))
      const fade = THREE.MathUtils.smoothstep(elevationDeg, params.fadeStartDeg, Math.max(params.fadeEndDeg, params.fadeStartDeg + 0.1))
      canopyShadow.fade.value = fade
      canopyShadow.strength.value = params.strength
      canopyShadow.offset.value = params.selfOffsetM
      canopyShadow.cascades.value = params.cascades >= 2 ? 2 : 1
      const bandH = Math.max(input.bandHeightM, 10)
      canopyShadow.bandHeightInv.value = 1 / bandH
      canopyShadow.minSpread.value = Math.max(params.minSpreadM, 0.1) / bandH
      if (fade <= 0) {
        // No shadow pass tonight, but the proxies go on ageing, so tiles evicted meanwhile are
        // not held by them.
        for (const proxy of [...proxies.values()]) {
          proxy.mesh.visible = false
          if (frame - proxy.lastUsed > 600) dropProxy(proxy)
        }
        return
      }

      // The region: every receiver in the dome, projected onto the floor along the sun. The
      // basemap under the lifted floor projects toward the sun, the canopy up to its top away
      // from it, each by slope × height (the same sun.z clamp as the projection itself); the
      // map spans both, square, a little beyond so the rim stays out of the edge fade.
      const sz = Math.max(sun.z, 0.08)
      centreEnu.copy(input.domeCentre ?? input.fallbackCentre).applyMatrix4(input.enuInverse)
      const radius = input.domeCentre ? input.domeRadius : input.fallbackRadius
      const slope = Math.hypot(sun.x, sun.y) / sz
      const azimuth = Math.hypot(sun.x, sun.y) > 1e-4 ? scratchAzimuth.set(sun.x, sun.y).normalize() : scratchAzimuth.set(0, 0)
      const belowFloor = Math.max(input.floorZ - centreEnu.z, 0)
      const towardSun = radius + slope * belowFloor
      const awayFromSun = radius + slope * bandH
      const shift = (towardSun - awayFromSun) * 0.5
      fitCentre.set(centreEnu.x + azimuth.x * shift, centreEnu.y + azimuth.y * shift)
      const wantedHalf = Math.max((towardSun + awayFromSun) * 0.5, 50) * 1.05 / 0.88
      // Quarter-octave steps; grow at once, shrink only once well below the step.
      const step = 2 ** (Math.ceil(Math.log2(wantedHalf) * 4) / 4)
      if (step > quantisedHalf || step < quantisedHalf / 1.35 || !quantisedHalf) quantisedHalf = step
      const texelM = quantisedHalf * 2 / resolution
      fitCentre.set(Math.round(fitCentre.x / texelM) * texelM, Math.round(fitCentre.y / texelM) * texelM)

      // What gets drawn: a fixed share of every caster's loaded points, weighed for the rest.
      const fraction = THREE.MathUtils.clamp(params.pointFraction, 0.02, 1)
      let casters = 0
      let hiddenCasters = 0
      let points = 0
      let signature = 0
      input.forEachCaster((mesh, attached, matrixWorld) => {
        const data = (mesh.material as any)?.userData
        if (!data) return
        if (attached) {
          data.shadowSeen = true
          data.shadowReleased = false
        } else if (!data.shadowSeen || data.shadowReleased) {
          // Never shown (its points were never uploaded), or its GPU copy is gone.
          return
        }
        const proxy = proxyFor(mesh)
        if (!proxy) return
        proxy.lastUsed = frame
        proxy.mesh.matrixWorld.copy(matrixWorld)
        if (proxy.mesh.parent !== shadowScene) shadowScene.add(proxy.mesh)
        proxy.mesh.visible = true
        proxy.count = Math.max(1, Math.ceil(loadedPoints(mesh) * fraction))
        casters++
        if (!attached) hiddenCasters++
        points += proxy.count
        signature = (signature * 31 + proxy.count + mesh.id * 7) % 2_147_483_647
      })
      for (const proxy of [...proxies.values()]) {
        if (proxy.lastUsed !== frame) {
          proxy.mesh.visible = false
          // Kept a while for a tile that comes back; released after ten seconds unused.
          if (frame - proxy.lastUsed > 600) dropProxy(proxy)
        }
      }
      lastCasters = casters
      lastHiddenCasters = hiddenCasters
      lastPointsDrawn = points

      const sunMoved = lastSun.angleTo(sun) > 0.0009
      const moved = !lastCentre.equals(fitCentre)
      const signatureText = `${signature}|${casters}|${quantisedHalf}|${resolution}|${input.floorZ.toFixed(2)}|${bandH.toFixed(1)}`
      const changed = forceUpdate || sunMoved || moved || signatureText !== lastSignature
      const due = frame - lastUpdateFrame >= Math.max(1, Math.round(params.updateEvery))
      if (!changed || !due) return
      forceUpdate = false
      lastSun.copy(sun)
      lastCentre.copy(fitCentre)
      lastSignature = signatureText
      lastUpdateFrame = frame
      updates++

      caster.sun.value.copy(sun)
      caster.floorZ.value = input.floorZ
      caster.bandHeightInv.value = 1 / bandH
      caster.splatScale.value = params.splatScale
      caster.fraction.value = fraction
      caster.density.value = params.density
      caster.minTexels.value = params.minSplatTexels
      caster.unitScale.value = sz / Math.max(params.density, 1e-6)
      canopyShadow.sun.value.copy(sun)
      canopyShadow.floorZ.value = input.floorZ

      const previousTarget = renderer.getRenderTarget()
      const previousAutoClear = renderer.autoClear
      const previousClear = scratchClear
      renderer.getClearColor(previousClear)
      const previousAlpha = renderer.getClearAlpha()
      renderer.autoClear = true
      renderer.setClearColor(0x000000, 0)
      const cascadeCount = params.cascades >= 2 ? 2 : 1
      for (let c = 0; c < cascadeCount; c++) {
        // Cascade 1 is the dome-fitted map; cascade 0 the inner one, same centre.
        const index = cascadeCount === 2 && c === 0 ? 0 : 1
        const half = index === 0 ? quantisedHalf * THREE.MathUtils.clamp(params.cascadeSplit, 0.1, 0.9) : quantisedHalf
        const texel = half * 2 / resolution
        const centre = scratchCentre.set(Math.round(fitCentre.x / texel) * texel, Math.round(fitCentre.y / texel) * texel)
        caster.centre.value.copy(centre)
        caster.halfExtent.value = half
        caster.texelM.value = texel
        renderer.setRenderTarget(accum[0])
        renderer.render(shadowScene, shadowCamera)
        const sigma = params.softnessM / texel
        runBlur(blurPasses!.horizontal[0], blurTemp!, sigma)
        runBlur(blurPasses!.vertical, finals[index], sigma)
        const centreUniform = index === 0 ? canopyShadow.centre0 : canopyShadow.centre1
        centreUniform.value.copy(centre)
        ;(index === 0 ? canopyShadow.half0 : canopyShadow.half1).value = half
        if (index === 1) canopyShadow.texel1.value = texel
      }
      renderer.setRenderTarget(previousTarget)
      renderer.autoClear = previousAutoClear
      renderer.setClearColor(previousClear, previousAlpha)
    },
    dispose() {
      for (const proxy of [...proxies.values()]) dropProxy(proxy)
      releaseTargets()
      if (blurPasses) for (const pass of [...blurPasses.horizontal, blurPasses.vertical]) (pass.material as NodeMaterial).dispose()
      canopyShadow.maps[0].value = placeholder
      canopyShadow.maps[1].value = placeholder
      canopyShadow.fade.value = 0
    },
  }
  return layer
}
