// Volumetric ground fog: morning mist lying in the gaps between the crowns and in flat puffs
// on them, with a few plumes rising out of the canopy, ray-marched and accumulated per pixel.
//
// Where it runs. A post pass between eye-dome lighting and depth of field (depth-of-field.ts
// owns the pipeline). It reads the scene's depth, so every ray stops at the first crown it
// meets: mist shows only where the view reaches down between the trees, which is exactly
// how it sits in an aerial photo of the rainforest. With the switch off the pass is not in
// the graph at all.
//
// What it marches. Only the band's bounding box: a flat slab from `bottomM` above the area
// floor up to the plume tops or the veil, whichever is higher, over the survey's bounding
// box plus `marginM`. Each ray is clipped to the box, to the scene depth and to
// `maxDistanceM` before a single sample is taken, so rays that miss the band cost one box
// test. A ray that lands on the bare map ends at the ground inside the sphere-fade dome (a
// real gap) and at the virtual canopy outside it. Inside the box the ray is split where it
// crosses the top of the dense layer: a quarter of the `steps` go to the sparse plumes above,
// three quarters to the mist and puffs below, crowded toward the camera by a power law.
// Per-pixel white-noise jitter turns what banding is left into fine grain.
//
// Density. Layered reads of one tileable 2D RGBA texture (fog-noise.ts, baked in a worker,
// editable in the noise editor): coverage (R) decides where mist pools; billows (G) carved
// by erosion (A) raise and lower the band's local top and seed the flat puffs on the crowns.
// Height detail comes from the wisp layer (B) as value noise along z built from 2D slices —
// two offset reads blended by height, plus one sheared finer octave — and carves the
// envelope the way cloud renderers erode a noise volume. Plumes are hashed columns on a grid.
// A thin veil lying on the virtual canopy carries the far field, where the points thin out.
// Six filtered reads per sample, mipmapped by the pixel's footprint so far fog does not
// shimmer. `noiseSource` swaps the height detail for a 3D texture, or every layer for noise
// evaluated in the shader, for the cost comparison: measured 2026-09-30, the 3D texture
// (64³) costs the same as the 2D slices and the shader noise five times the whole fog.
//
// Light. Physically based within a thin-band approximation:
//   · extinction from visibility (Koschmieder), single-scattering albedo ~0.995 (water);
//   · Mie phase for water droplets — Jendersie & d'Eon's HG + Draine fit (fog-optics.ts) —
//     so looking toward a low sun lights the mist up in a tight forward glow;
//   · Wrenninge's multiple-scattering octaves: each extra order sees the sun through less
//     optical depth, with less energy and a flatter phase — what makes thick fog white
//     rather than grey;
//   · sun transmittance through the band analytically (optical depth to the local top along
//     the sun direction) instead of a second march;
//   · sky light, dimmed low in the band where the crowns hide the sky;
//   · Rayleigh scattering by the air in the band (small and bluish over these distances);
//   · Frostbite's energy-conserving step integration (Hillaire 2015).
// The sun is the scene's own (the Peru clock), so the time dock moves it for the fog too.
//
// Resolution. The march renders into a HalfFloat target at `resolutionScale` of the
// drawing buffer (RTTNode's own resolution scale). The composite brings it back with a
// joint bilateral upsample: each full-resolution pixel weighs the four nearest march texels
// by how close their depth is to its own, so mist does not bleed over crown silhouettes.
// The result is premultiplied — colour × transmittance + in-scattered light — and the
// in-scatter is hazed at the fog's transmittance-weighted depth like the volumetric clouds.
import * as THREE from 'three'
import { NodeMaterial, QuadMesh, RenderTarget } from 'three/webgpu'
import {
  Break, Fn, If, Loop, abs, clamp, dot, exp, float, floor, fract, sin, step, getViewPosition, int,
  length, log2, max, min, mix, mx_fractal_noise_float, mx_noise_float, normalize, perspectiveDepthToViewZ, pow,
  rtt, screenCoordinate, smoothstep, sqrt, texture, texture3D, textureSize, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'
import type { CloudHaze } from './atmosphere-haze'
import type { DaylightState } from './environment-layer'
import type { FogNoiseSettings } from './fog-noise'
import type { FogNoiseBaker } from './fog-noise-baker'
import { extinctionForVisibility, miePhaseParameters, multipleScatteringOctaves, RAYLEIGH_SEA_LEVEL_PER_M } from './fog-optics'
import type { DensitySliceRequest } from './fog-noise-editor'

const CONFIG = EXPERIENCE_CONFIG.volumetricFog
export type FogNoiseSource = '2d' | '3d' | 'procedural'
/** Wind offsets wrap at this many tiles: whole for the plain reads (period 1) and for the
 *  finer wisp octave read at 2.3× (23 tiles). */
const DRIFT_PERIOD = 10
/** The rise wraps at this many wisp heights: the slice hash repeats over it, and so do the
 *  sheared finer octave (10, −8 tiles) and the 3D texture's z reads (4 and 9 tiles). The
 *  'procedural' comparison path is not periodic and jumps on a wrap. */
const RISE_PERIOD = 16
type Preset = keyof typeof CONFIG.qualityByPreset

/** Build-time options: changing one rebuilds the shaders. Everything else is a uniform. */
export interface GroundFogBuildOptions {
  noiseSource: FogNoiseSource
  multipleScattering: number
  wisps: boolean
  depthAwareUpsample: boolean
  /** off: the composite. light: the fog's in-scattered light alone. transmittance: how
   *  much of the scene gets through, white = all. For tuning. */
  debugView: 'off' | 'light' | 'transmittance'
}

export interface GroundFogLayer {
  /** Composite `color` through the fog. Called by the post pipeline on every rebuild. */
  build(color: any, depth: any): any
  /** Per frame, before the render: camera, sun and sky, wind. */
  update(camera: THREE.PerspectiveCamera, daylight: DaylightState | null, deltaS: number): void
  isEnabled(): boolean
  /** Returns true when the switch changed, so the pipeline rebuilds. */
  setEnabled(enabled: boolean): boolean
  getBuildOptions(): GroundFogBuildOptions
  /** Returns true when a build option changed, so the pipeline rebuilds. */
  setBuildOption<K extends keyof GroundFogBuildOptions>(key: K, value: GroundFogBuildOptions[K]): boolean
  setResolutionScale(scale: number): void
  getResolutionScale(): number
  /** The loader benchmark's preset: resolution and step count together. */
  applyPreset(preset: Preset): void
  /** The area floor in the shader's (lifted) ENU frame, and the survey centre. */
  setFrame(floorZ: number, boundsMin: THREE.Vector2, boundsMax: THREE.Vector2): void
  /** Returns true when it changed: the haze is built into the march, so the pipeline rebuilds. */
  setHaze(haze: CloudHaze | null): boolean
  /** Live-tunable values; the panel writes these directly. */
  readonly params: GroundFogParams
  noiseSettings(): FogNoiseSettings
  /** Rebake the noise and upload it; resolves with the texels (null when superseded). */
  setNoise(settings: FogNoiseSettings): Promise<Uint8Array | null>
  bake3dPreview(size: number): Promise<Uint8Array | null>
  /** Density preview for the noise editor, rendered with the march's own density node. */
  renderDensitySlice(request: DensitySliceRequest): Promise<Uint8Array | null>
  /** Band height (bottom of the box to its top), metres. */
  bandHeightM(): number
  dispose(): void
}

export interface GroundFogParams {
  steps: number
  stepDistribution: number
  maxDistanceM: number
  bottomM: number
  topM: number
  plumeHeightM: number
  bottomSoftM: number
  topSoftM: number
  marginM: number
  virtualCanopyM: number
  mapBelowM: number
  groundLevelM: number
  pointsReachM: number
  veilVisibilityM: number
  veilHeightM: number
  plumeSpacingM: number
  plumeRadiusM: number
  plumeChance: number
  puffCentreM: number
  puffHeightM: number
  puffCut: number
  puffAmount: number
  skyTint: number
  visibilityM: number
  coverage: number
  coverageSoftness: number
  coverageScaleM: number
  billowScaleM: number
  erosionScaleM: number
  wispScaleM: number
  wispHeightM: number
  billowAmount: number
  erosionAmount: number
  wispAmount: number
  plumeAmount: number
  windMps: [number, number]
  riseMps: number
  dropletDiameterUm: number
  albedo: number
  sunStrength: number
  ambientStrength: number
  canopyOcclusion: number
  rayleighScale: number
  tint: THREE.Color
}

const PI4 = 4 * Math.PI
/** A texture node's size at level 0, as a node. */
const sizeOf = (node: any): any => (textureSize as any)(node, 0)

export function createGroundFogLayer(opts: {
  renderer: any
  camera: THREE.PerspectiveCamera
  /** The shared cloud uniforms: `enuInverse` (render space → ENU), `sunDirectionEnu`, and
   *  the sphere-fade dome, inside which the point cloud is drawn. */
  shared: { enuInverse: any; sunDirectionEnu: any; sphereFadeCentre: any; sphereFadeRadius: any; sphereFadeRampInset: any }
  baker: FogNoiseBaker
}): GroundFogLayer {
  const { renderer, camera, shared, baker } = opts
  let enabled: boolean = CONFIG.enabled
  const build: GroundFogBuildOptions = {
    noiseSource: CONFIG.noiseSource,
    multipleScattering: CONFIG.multipleScattering,
    wisps: CONFIG.wisps,
    depthAwareUpsample: CONFIG.depthAwareUpsample,
    debugView: 'off',
  }
  let resolutionScale: number = CONFIG.resolutionScale

  const params: GroundFogParams = {
    steps: CONFIG.steps,
    stepDistribution: CONFIG.stepDistribution,
    maxDistanceM: CONFIG.maxDistanceM,
    bottomM: CONFIG.bottomM,
    topM: CONFIG.topM,
    plumeHeightM: CONFIG.plumeHeightM,
    bottomSoftM: CONFIG.bottomSoftM,
    topSoftM: CONFIG.topSoftM,
    marginM: CONFIG.marginM,
    virtualCanopyM: CONFIG.virtualCanopyM,
    mapBelowM: CONFIG.mapBelowM,
    groundLevelM: CONFIG.groundLevelM,
    pointsReachM: CONFIG.pointsReachM,
    veilVisibilityM: CONFIG.veilVisibilityM,
    veilHeightM: CONFIG.veilHeightM,
    plumeSpacingM: CONFIG.plumeSpacingM,
    plumeRadiusM: CONFIG.plumeRadiusM,
    plumeChance: CONFIG.plumeChance,
    puffCentreM: CONFIG.puffCentreM,
    puffHeightM: CONFIG.puffHeightM,
    puffCut: CONFIG.puffCut,
    puffAmount: CONFIG.puffAmount,
    skyTint: CONFIG.skyTint,
    visibilityM: CONFIG.visibilityM,
    coverage: CONFIG.coverage,
    coverageSoftness: CONFIG.coverageSoftness,
    coverageScaleM: CONFIG.coverageScaleM,
    billowScaleM: CONFIG.billowScaleM,
    erosionScaleM: CONFIG.erosionScaleM,
    wispScaleM: CONFIG.wispScaleM,
    wispHeightM: CONFIG.wispHeightM,
    billowAmount: CONFIG.billowAmount,
    erosionAmount: CONFIG.erosionAmount,
    wispAmount: CONFIG.wispAmount,
    plumeAmount: CONFIG.plumeAmount,
    windMps: [...CONFIG.windMps] as [number, number],
    riseMps: CONFIG.riseMps,
    dropletDiameterUm: CONFIG.dropletDiameterUm,
    albedo: CONFIG.albedo,
    sunStrength: CONFIG.sunStrength,
    ambientStrength: CONFIG.ambientStrength,
    canopyOcclusion: CONFIG.canopyOcclusion,
    rayleighScale: CONFIG.rayleighScale,
    tint: new THREE.Color(CONFIG.tint),
  }

  // ---------------------------------------------------------------- uniforms
  // The scene camera's matrices by reference: inside a post quad the built-in camera nodes
  // describe the quad's own camera, not the one the scene was drawn with.
  const projectionInverse = uniform(camera.projectionMatrixInverse)
  const cameraWorld = uniform(camera.matrixWorld)
  const near = uniform(camera.near)
  const far = uniform(camera.far)
  const floorZ: any = uniform(0)
  // The survey's ENU bounding box: over the point cloud the crowns hide the band, over the
  // bare map beyond it nothing would, so the mist is kept to the survey.
  const boundsMin: any = uniform(new THREE.Vector2(-5000, -5000))
  const boundsMax: any = uniform(new THREE.Vector2(5000, 5000))
  // Loosely typed like the rest of this codebase's TSL: three's node types reject most
  // mixed vec3 / colour arithmetic that WGSL and GLSL accept.
  const u: Record<string, any> = {
    steps: uniform(params.steps, 'int'),
    stepDistribution: uniform(params.stepDistribution),
    maxDistance: uniform(params.maxDistanceM),
    bottom: uniform(params.bottomM), top: uniform(params.topM), plumeHeight: uniform(params.plumeHeightM),
    bottomSoft: uniform(params.bottomSoftM), topSoft: uniform(params.topSoftM), margin: uniform(params.marginM),
    virtualCanopy: uniform(params.virtualCanopyM), mapBelow: uniform(params.mapBelowM),
    groundLevel: uniform(params.groundLevelM), pointsReach: uniform(params.pointsReachM),
    veilSigma: uniform(extinctionForVisibility(params.veilVisibilityM)), veilHeight: uniform(params.veilHeightM),
    plumeSpacing: uniform(params.plumeSpacingM), plumeRadius: uniform(params.plumeRadiusM), plumeChance: uniform(params.plumeChance),
    plumeLean: uniform(new THREE.Vector2()),
    puffCentre: uniform(params.puffCentreM), puffHeight: uniform(params.puffHeightM), puffCut: uniform(params.puffCut), puffAmount: uniform(params.puffAmount),
    sigmaMax: uniform(extinctionForVisibility(params.visibilityM)),
    coverage: uniform(params.coverage), coverageSoftness: uniform(params.coverageSoftness),
    coverageScaleInv: uniform(1 / params.coverageScaleM), billowScaleInv: uniform(1 / params.billowScaleM),
    erosionScaleInv: uniform(1 / params.erosionScaleM), wispScaleInv: uniform(1 / params.wispScaleM),
    wispHeightInv: uniform(1 / params.wispHeightM),
    billowAmount: uniform(params.billowAmount), erosionAmount: uniform(params.erosionAmount),
    wispAmount: uniform(params.wispAmount), plumeAmount: uniform(params.plumeAmount),
    // Wind and rise as wrapped offsets, accumulated on the CPU: a raw time uniform would lose
    // precision after a few hours of session. Each wraps at a period every read built on it
    // repeats over, so a wrap is invisible — DRIFT_PERIOD and RISE_PERIOD below.
    offCoverage: uniform(new THREE.Vector2()), offBillow: uniform(new THREE.Vector2()),
    offErosion: uniform(new THREE.Vector2()), offWisp: uniform(new THREE.Vector2()), rise: uniform(0),
    gHG: uniform(0.98), gD: uniform(0.5), alpha: uniform(20), wD: uniform(0.48),
    albedo: uniform(params.albedo),
    sunRadiance: uniform(new THREE.Color(1, 1, 1)),
    ambientRadiance: uniform(new THREE.Color(0.6, 0.65, 0.7)),
    canopyOcclusion: uniform(params.canopyOcclusion),
    rayleigh: uniform(new THREE.Vector3(...RAYLEIGH_SEA_LEVEL_PER_M)),
    pixelAngle: uniform(0.001),
  }
  let hazeParts: CloudHaze | null = null

  const applyPhase = () => {
    const p = miePhaseParameters(params.dropletDiameterUm)
    u.gHG.value = p.gHG; u.gD.value = p.gD; u.alpha.value = p.alpha; u.wD.value = p.wD
  }
  applyPhase()

  // ---------------------------------------------------------------- noise
  const noiseSettings: FogNoiseSettings = JSON.parse(JSON.stringify(CONFIG.noise))
  const makeNoiseTexture = (size: number, data?: Uint8Array) => {
    const texture2d = new THREE.DataTexture(data ?? new Uint8Array(size * size * 4).fill(128), size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
    texture2d.wrapS = THREE.RepeatWrapping
    texture2d.wrapT = THREE.RepeatWrapping
    texture2d.magFilter = THREE.LinearFilter
    // Mipmapped: the march picks a level from the pixel's footprint.
    texture2d.minFilter = THREE.LinearMipmapLinearFilter
    texture2d.generateMipmaps = true
    texture2d.colorSpace = THREE.NoColorSpace
    texture2d.name = 'ground-fog-noise-2d'
    texture2d.needsUpdate = true
    return texture2d
  }
  let noiseTexture = makeNoiseTexture(noiseSettings.size)
  const noiseNode = texture(noiseTexture, vec2(0), 0)
  const noiseSize = uniform(noiseSettings.size)
  let lastBaked: { key: string; data: Uint8Array } | null = null
  const upload = (settings: FogNoiseSettings, data: Uint8Array) => {
    if (settings.size !== noiseTexture.image.width) {
      const old = noiseTexture
      noiseTexture = makeNoiseTexture(settings.size, data)
      noiseNode.value = noiseTexture
      noiseSize.value = settings.size
      old.dispose()
    } else {
      ;(noiseTexture.image.data as Uint8Array).set(data)
      noiseTexture.needsUpdate = true
    }
  }
  // Every request takes a number; a bake that lands after a newer request was made is dropped,
  // including when the newer one was answered from the cache without a bake of its own.
  let noiseRequest = 0
  const setNoise = async (settings: FogNoiseSettings) => {
    const request = ++noiseRequest
    const key = JSON.stringify(settings)
    if (lastBaked?.key === key) return lastBaked.data
    // Baked and uploaded from this snapshot: the editor goes on changing its own object.
    const snapshot = JSON.parse(key) as FogNoiseSettings
    const data = await baker.bake2d(snapshot)
    if (!data || request !== noiseRequest) return null
    upload(snapshot, data)
    Object.assign(noiseSettings, snapshot)
    lastBaked = { key, data }
    return data
  }
  void setNoise(noiseSettings)

  // The 3D comparison texture exists only once someone asks for it.
  let noise3dTexture: THREE.Data3DTexture | null = null
  // A real, uploaded 1³ volume until the bake lands. Left un-uploaded, WebGPU binds its
  // default texture, which is 2D, to the 3D slot, and the march's pass fails validation.
  const placeholder3d = new THREE.Data3DTexture(new Uint8Array([128]), 1, 1, 1)
  placeholder3d.format = THREE.RedFormat
  placeholder3d.unpackAlignment = 1
  placeholder3d.needsUpdate = true
  const noise3dNode = texture3D(placeholder3d, vec3(0), 0)
  const ensure3d = async (size = 64) => {
    const data = await baker.bake3d(size)
    if (!data) return null
    noise3dTexture?.dispose()
    noise3dTexture = new THREE.Data3DTexture(data, size, size, size)
    noise3dTexture.format = THREE.RedFormat
    noise3dTexture.minFilter = THREE.LinearFilter
    noise3dTexture.magFilter = THREE.LinearFilter
    noise3dTexture.wrapS = noise3dTexture.wrapT = noise3dTexture.wrapR = THREE.RepeatWrapping
    noise3dTexture.unpackAlignment = 1
    noise3dTexture.needsUpdate = true
    noise3dNode.value = noise3dTexture
    return data
  }
  // setBuildOption bakes it when the panel switches to '3d'; a config that starts there needs
  // it too.
  if (build.noiseSource === '3d') void ensure3d()

  // ---------------------------------------------------------------- density
  /**
   * Extinction (1/m) at ENU position `p`, with `footprint` the ground size of one pixel
   * there (metres), for the mip level. Returns the density and the band's local top, which
   * the lighting needs for the optical depth toward the sun.
   */
  const density = (p: any, footprint: any, options: GroundFogBuildOptions) => {
    const hRel = p.z.sub(floorZ)
    const xy = p.xy
    const lod = (scaleInv: any) => log2(max(footprint.mul(scaleInv).mul(noiseSize), 1))
    const read = (scaleInv: any, offset: any) => noiseNode.sample(xy.mul(scaleInv).add(offset)).level(lod(scaleInv))
    let coverageRaw: any
    let billow: any
    let erosion: any
    if (options.noiseSource === 'procedural') {
      coverageRaw = mx_fractal_noise_float(vec3(xy.mul(u.coverageScaleInv).add(u.offCoverage).mul(4), 0.5), int(5), float(2), float(0.5)).mul(0.5).add(0.5)
      billow = mx_noise_float(vec3(xy.mul(u.billowScaleInv).add(u.offBillow).mul(6), 1.5)).mul(0.5).add(0.5)
      erosion = mx_noise_float(vec3(xy.mul(u.erosionScaleInv).add(u.offErosion).mul(12), 2.5)).mul(0.5).add(0.5)
    } else {
      coverageRaw = read(u.coverageScaleInv, u.offCoverage).r
      billow = read(u.billowScaleInv, u.offBillow).g
      erosion = read(u.erosionScaleInv, u.offErosion).a
    }
    // Where the mist pools, and how high each clump stands.
    const coverage = smoothstep(u.coverage.oneMinus().sub(u.coverageSoftness), u.coverage.oneMinus().add(u.coverageSoftness), coverageRaw)
    const clump = clamp(billow.sub(erosion.mul(u.erosionAmount)).div(u.erosionAmount.mul(-0.5).add(1)), 0, 1)
    const lift = coverage.mul(mix(float(1), clump, u.billowAmount))
    const localTop = u.bottom.add(u.top.sub(u.bottom).mul(lift.mul(0.75).add(0.25)))
    const body = smoothstep(u.bottom, u.bottom.add(u.bottomSoft), hRel)
      .mul(float(1).sub(smoothstep(localTop.sub(u.topSoft), localTop, hRel)))
    let shaped: any = body.mul(mix(float(1), clump, u.billowAmount.mul(0.6)))
    let plumes: any = float(0)
    // Puffs: the rounded clumps that sit on the canopy itself, where the understory mist
    // above only shows through the gaps. Each stands on a strong clump of the billow layer,
    // centred near crown height and taller the stronger its clump, with a flatter underside
    // than top — mist lying on leaves.
    const puffMask = smoothstep(u.puffCut, u.puffCut.add(0.25), clump)
    const puffCentre = u.puffCentre.add(clump.sub(u.puffCut).mul(u.puffHeight).mul(0.6))
    const puffHalf = u.puffHeight.mul(puffMask.mul(0.65).add(0.35))
    const dz = hRel.sub(puffCentre).div(max(puffHalf, 0.5))
    const puff = puffMask.mul(exp(dz.mul(dz).mul(dz.greaterThan(0).select(2.2, 0.9)).negate()))
    shaped = shaped.add(puff.mul(u.puffAmount))
    const puffTop = puffCentre.add(puffHalf).mul(puffMask.greaterThan(0.05).select(1, 0))
    const lightTop = max(localTop, puffTop)
    if (options.wisps) {
      // Detail with height, from 2D reads: value noise along z built from 2D slices. Every
      // whole step of `vz` reads the wisp layer through its own random offset, and a height
      // between two steps blends the two, so features are `wispScaleM`-wide and about
      // `wispHeightM` tall wherever they are — 3D noise at two reads. The finer octave is one
      // sheared read. (Tried and dropped: reading vertical x–z and y–z planes extrudes each
      // plane's pattern into sheets along the missing axis, a grid of curtains; rotating the
      // slices with height turns about the ENU origin, kilometres away, and smears the
      // pattern into speckle that averages out along the ray — the extruded 2D layers then
      // show as streaks.) Scrolled upward with the rising air.
      const vz = hRel.mul(u.wispHeightInv).sub(u.rise)
      const k = floor(vz)
      const f = vz.sub(k)
      const blend = f.mul(f).mul(f.mul(-2).add(3))
      // The slice hash repeats every RISE_PERIOD slices (a floored modulo, so it holds below
      // zero too), which is what lets the rise wrap without the pattern jumping.
      const sliceOffset = (n: any) => {
        const m = n.sub(floor(n.div(RISE_PERIOD)).mul(RISE_PERIOD))
        return vec2(fract(m.mul(0.7548777)), fract(m.mul(0.5698403))).mul(9.7)
      }
      const q = xy.mul(u.wispScaleInv).add(u.offWisp)
      let wispA: any
      let wispB: any
      if (options.noiseSource === 'procedural') {
        wispA = mx_noise_float(vec3(xy.mul(u.wispScaleInv).mul(8), vz.mul(8))).mul(0.5).add(0.5)
        wispB = mx_noise_float(vec3(xy.mul(u.wispScaleInv).mul(19), vz.mul(19).add(3.1))).mul(0.5).add(0.5)
      } else if (options.noiseSource === '3d') {
        // The comparison baseline: the same two octaves from a tileable 3D texture, one
        // trilinear read each, where the 2D path spends three filtered reads.
        wispA = noise3dNode.sample(vec3(q, vz.mul(0.25))).r
        wispB = noise3dNode.sample(vec3(q.mul(2.3), vz.mul(0.5625).add(0.37))).r
      } else {
        const wispLod = lod(u.wispScaleInv)
        const lower = noiseNode.sample(q.add(sliceOffset(k))).level(wispLod).b
        const upper = noiseNode.sample(q.add(sliceOffset(k.add(1)))).level(wispLod).b
        wispA = mix(lower, upper, blend)
        wispB = noiseNode.sample(q.mul(2.3).add(vec2(vz.mul(0.625), vz.mul(-0.5)))).level(wispLod.add(1.2)).b
      }
      // The 2D layers only say where and how high mist can stand; left at that, every clump
      // is a prism extruded through the band's height, and seen obliquely the prisms read as
      // vertical streaks. So the envelope carves the 3D detail instead, the way cloud
      // renderers erode a noise volume with coverage: where the envelope is weak only the
      // noise's peaks survive, as small rounded puffs; where it is strong the mist fills in.
      const detail = wispA.mul(0.62).add(wispB.mul(0.38))
      const envelope = min(shaped, 1)
      const carved = clamp(detail.sub(envelope.oneMinus()).div(max(envelope, 0.05)), 0, 1)
        .mul(max(shaped, 1)).mul(1.5)
      shaped = mix(shaped, carved, u.wispAmount)
      // Plumes: warm, moist air rising out of the canopy in thin columns, narrow at the foot
      // and flaring as they rise, frayed by the height detail and fading out toward the top.
      // They rise from the puff layer's height, not from the local mist top, which dips and
      // swells with the coverage and would swallow a column's foot.
      const above = max(hRel.sub(u.puffCentre), 0)
      const rise01 = clamp(above.div(max(u.plumeHeight, 1)), 0, 1)
      // One candidate column per grid cell of `plumeSpacingM`, at a hashed spot in the cell's
      // inner part and present by `plumeChance`: a clean round column, which a threshold on a
      // noise layer never is (it cuts combs of slivers). Leans downwind as it rises.
      const cellCoord: any = floor(xy.div(u.plumeSpacing))
      const hashOf = (salt: number) => fract(sin(dot(cellCoord.add(salt), vec2(127.1, 311.7))).mul(43758.5453))
      const spot = cellCoord.add(vec2(hashOf(0), hashOf(17)).mul(0.6).add(0.2)).mul(u.plumeSpacing)
        .add(u.plumeLean.mul(above))
      const present = step(hashOf(41), u.plumeChance)
      const radius = u.plumeRadius.mul(rise01.mul(1.2).add(1))
      // Written as 1 − smoothstep with rising edges: WGSL leaves smoothstep undefined when
      // its low edge is above its high one, which a falloff written the other way round is.
      const column = present.mul(float(1).sub(smoothstep(radius.mul(0.3), radius, length(xy.sub(spot)))))
      const plume = column.mul(rise01.oneMinus().pow(1.5)).mul(smoothstep(0, 0.12, rise01))
        .mul(mix(float(1), detail.mul(1.6), 0.5))
      plumes = plume.mul(u.plumeAmount).mul(coverage.mul(0.6).add(0.4))
    }
    // The veil: a thin sheet lying on the crown tops, what distant mist reads as — banks a
    // few hundred metres across (coverage and billows together) over a faint floor.
    const banks = smoothstep(0.35, 0.8, coverageRaw.mul(0.5).add(billow.mul(0.5)))
    const veil = smoothstep(u.virtualCanopy.sub(6), u.virtualCanopy, hRel)
      .mul(float(1).sub(smoothstep(u.virtualCanopy.add(u.veilHeight.mul(0.4)), u.virtualCanopy.add(u.veilHeight), hRel)))
      .mul(mix(float(0.2), float(1), banks)).mul(u.veilSigma)
    // Fade toward the box's side walls instead of ending in a cliff.
    const outside = length(max(max(boundsMin.sub(xy), xy.sub(boundsMax)), vec2(0)))
    const edge = float(1).sub(smoothstep(0, max(u.margin, 1), outside))
    // Returned in parts: the march fades the mist and plumes out beyond the points' reach,
    // where they would stand over the bare map, and keeps the veil.
    const mist = u.sigmaMax.mul(coverage.mul(shaped).add(plumes)).mul(edge)
    return { mist, veil: veil.mul(edge), sigma: mist.add(veil.mul(edge)), localTop: lightTop, hRel }
  }

  // ---------------------------------------------------------------- phase functions
  const hg = (c: any, g: any) => {
    const g2 = g.mul(g)
    const d = g2.add(1).sub(g.mul(c).mul(2))
    return g2.oneMinus().div(d.mul(sqrt(d)).mul(PI4))
  }
  const draine = (c: any, g: any, a: any) => {
    const g2 = g.mul(g)
    const d = g2.add(1).sub(g.mul(c).mul(2))
    return g2.oneMinus().mul(a.mul(c).mul(c).add(1))
      .div(d.mul(sqrt(d)).mul(PI4).mul(a.mul(g2.mul(2).add(1)).div(3).add(1)))
  }
  const mie = (c: any, scale: number) => mix(hg(c, u.gHG.mul(scale)), draine(c, u.gD.mul(scale), u.alpha), u.wD)

  // ---------------------------------------------------------------- the march
  // 1 inside the sphere-fade dome, 0 outside, over its melt ramp. The ramp is floored: the
  // panel lets it reach 0, and smoothstep with equal edges is undefined.
  const domeFade = (distance: any) => float(1).sub(smoothstep(
    shared.sphereFadeRadius.sub(max(shared.sphereFadeRampInset, 0.5)), shared.sphereFadeRadius, distance))
  const marchNode = (depth: any, options: GroundFogBuildOptions) => Fn(() => {
    const st = uv()
    const fullSize = vec2(sizeOf(depth))
    // The full-resolution pixel this march texel stands for, read at its exact centre.
    const fullUv = floor(st.mul(fullSize)).add(0.5).div(fullSize)
    const sceneDepth = depth.sample(fullUv).x
    const viewPosition = getViewPosition(fullUv, sceneDepth, projectionInverse)
    const origin = cameraWorld.mul(vec4(0, 0, 0, 1)).xyz
    const surface = cameraWorld.mul(vec4(viewPosition, 1)).xyz
    const rayWorld = normalize(surface.sub(origin))
    const surfaceDistance = mix(length(surface.sub(origin)), float(1e9), sceneDepth.greaterThanEqual(0.9999999).select(1, 0))
    const o: any = shared.enuInverse.mul(vec4(origin, 1)).xyz
    const d: any = normalize(shared.enuInverse.mul(vec4(rayWorld, 0)).xyz)
    // Ray against the band's box.
    const boxMin = vec3(boundsMin.sub(u.margin), floorZ.add(u.bottom))
    // Plumes rise from the puff layer, so their tops stand `plumeHeightM` above whichever of
    // the band top and the puff centre is higher.
    const boxMax = vec3(boundsMax.add(u.margin), floorZ.add(max(max(u.top, u.puffCentre).add(u.plumeHeight), u.virtualCanopy.add(u.veilHeight))))
    // A hair of bias keeps an axis-parallel ray off a division by zero.
    const inv = vec3(1).div(d.add(vec3(1e-7)))
    const t0 = boxMin.sub(o).mul(inv)
    const t1 = boxMax.sub(o).mul(inv)
    const tNear = min(t0, t1)
    const tFar = max(t0, t1)
    const tEnter = max(max(max(tNear.x, tNear.y), tNear.z), 0)
    // A ray that lands on the bare map, below real ground, went through the point cloud
    // without meeting a crown. Inside the sphere-fade dome, where the points are drawn, that
    // is a real gap: the mist there reaches down to the ground, so the march ends at ground
    // height. Outside the dome, or beyond the points' reach, the map stands in for the crown
    // tops, and the march ends where the ray sinks through the virtual canopy.
    // Sky seen below the horizon counts as map: it is a basemap tile that has not loaded (or
    // failed), and marched to the box's far side it would fill with a full band of fog. Its
    // far-plane point lies far under the floor, so the height test catches it.
    const surfaceEnu = shared.enuInverse.mul(vec4(surface, 1)).xyz
    const surfaceHeight = surfaceEnu.z.sub(floorZ)
    const onMap = surfaceHeight.lessThan(u.mapBelow).and(d.z.lessThan(-1e-4))
    const domeDistance = length(surfaceEnu.sub(shared.sphereFadeCentre))
    const inDome = domeFade(domeDistance)
    const drawn = inDome.mul(float(1).sub(smoothstep(u.pointsReach, u.pointsReach.mul(1.3), length(surface.sub(origin)))))
    const clipHeight = mix(u.virtualCanopy, u.groundLevel, drawn)
    const tCanopy = floorZ.add(clipHeight).sub(o.z).div(min(d.z, -1e-4))
    const tSurface = onMap.select(min(surfaceDistance, max(tCanopy, 0)), surfaceDistance)
    const tExit = min(min(min(min(tFar.x, tFar.y), tFar.z), tSurface), u.maxDistance)
    const scattered = vec3(0).toVar()
    const transmittance = float(1).toVar()
    const weightedDistance = float(0).toVar()
    If(tExit.greaterThan(tEnter), () => {
      // White-noise jitter rather than interleaved gradient noise: IGN is made for a temporal
      // filter to average out, and without one its diagonal structure reads as hatching.
      const jitter = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453))
      const stepsF = float(u.steps)
      // Two segments, split where the ray crosses the top of the dense layer (mist and
      // puffs): above it only sparse plumes stand, so a descending ray gets a quarter of its
      // steps up there and three quarters below — the thin puff layer is resolved instead of
      // hatched. The dense segment keeps the power-law crowding toward the camera.
      const zSplit = floorZ.add(max(u.top, u.puffCentre.add(u.puffHeight.mul(2)))).add(u.topSoft)
      const descending = d.z.lessThan(0)
      const tCross = zSplit.sub(o.z).div(descending.select(min(d.z, -1e-5), max(d.z, 1e-5)))
      const tMid = clamp(tCross, tEnter, tExit)
      const lengthFirst = tMid.sub(tEnter)
      const lengthSecond = tExit.sub(tMid)
      const firstShare = floor(stepsF.mul(descending.select(0.25, 0.75)))
      const stepsFirst: any = lengthFirst.lessThan(0.01).select(float(0), lengthSecond.lessThan(0.01).select(stepsF, firstShare))
      const cosTheta = dot(d, shared.sunDirectionEnu)
      const sunUp = max(shared.sunDirectionEnu.z, 0.06)
      const daylight = smoothstep(-0.02, 0.06, shared.sunDirectionEnu.z)
      const octaves = multipleScatteringOctaves(options.multipleScattering)
      const phases = octaves.map((octave) => mie(cosTheta, octave.anisotropy).mul(PI4))
      const rayleighPhase = cosTheta.mul(cosTheta).add(1).mul(3 / (16 * Math.PI)).mul(PI4)
      const previous = tEnter.toVar()
      Loop({ start: int(0), end: u.steps, type: 'int', condition: '<' }, ({ i }: { i: any }) => {
        // Sample j of its segment sits at ((j + jitter) / count)^k of the segment, k the
        // power law in the dense segment and 1 in the sparse one.
        // Frozen into variables before `previous` moves on: a TSL expression is inlined where
        // it is first used, so a plain `next - previous` read inside the If below would see
        // the updated `previous` and come out as zero.
        const index = float(i)
        const inFirst = index.lessThan(stepsFirst)
        const segmentStart = inFirst.select(tEnter, tMid)
        const segmentLength = inFirst.select(lengthFirst, lengthSecond)
        const j = inFirst.select(index, index.sub(stepsFirst))
        const count = max(inFirst.select(stepsFirst, stepsF.sub(stepsFirst)), 1)
        const dense = inFirst.select(descending.not(), descending)
        const k = dense.select(u.stepDistribution, float(1))
        const next = segmentStart.add(segmentLength.mul(pow(j.add(1).div(count), k))).toVar()
        const t = segmentStart.add(segmentLength.mul(pow(j.add(jitter).div(count), k))).toVar()
        const dt = next.sub(previous).toVar()
        previous.assign(next)
        const p = o.add(d.mul(t))
        const sample = density(p, t.mul(u.pixelAngle), options)
        // Mist, puffs and plumes only where points are drawn: within their reach and inside
        // the sphere-fade dome, melting out over the dome's own ramp. Over the bare map
        // beyond, they would lie on a flat photo like cotton balls on a carpet; the veil
        // carries the far field there.
        const sampleDome = domeFade(length(p.sub(shared.sphereFadeCentre)))
        const nearPoints = float(1).sub(smoothstep(u.pointsReach.mul(0.7), u.pointsReach, t)).mul(sampleDome)
        // The veil takes over where the mist leaves off, and stays light (a third) over the
        // drawn points, where the mist itself is there to be seen.
        const sigma = sample.mist.mul(nearPoints).add(sample.veil.mul(nearPoints.mul(-0.65).add(1))).toVar()
        const localTop = sample.localTop.toVar()
        const hRel = sample.hRel.toVar()
        If(sigma.greaterThan(1e-5), () => {
          const above = max(localTop.sub(hRel), 0)
          // Optical depth toward the sun through the rest of the band, and straight up: the
          // local extinction over the height left to the local top, halved as if the density
          // fell off linearly toward that top. An approximation both ways — it runs low deep in
          // a flat body and high in the empty gap under a puff — traded for a second march.
          const tauSun = sigma.mul(above).mul(0.5).div(sunUp)
          const tauUp = sigma.mul(above).mul(0.5)
          const canopy = mix(u.canopyOcclusion.oneMinus(), float(1), smoothstep(u.bottom, u.top, hRel))
          let sunLight: any = float(0)
          octaves.forEach((octave, index) => {
            sunLight = sunLight.add(exp(tauSun.mul(-octave.extinction)).mul(phases[index]).mul(octave.scattering))
          })
          const inScatter = vec3(u.sunRadiance).mul(sunLight.mul(canopy).mul(daylight))
            .add(vec3(u.ambientRadiance).mul(canopy).mul(exp(tauUp.negate()).mul(0.35).add(0.65)))
            .mul(u.albedo)
          const stepTransmittance = exp(sigma.mul(dt).negate())
          // Frostbite's energy-conserving step: ∫ T σs L over the step, not σs L dt.
          scattered.addAssign(inScatter.mul(stepTransmittance.oneMinus()).mul(transmittance))
          weightedDistance.addAssign(transmittance.mul(stepTransmittance.oneMinus()).mul(t))
          transmittance.mulAssign(stepTransmittance)
        })
        // The air between the droplets, in and out of the mist alike, with the same
        // energy-conserving step: it scatters 1 − e^(−σR·dt) of the light per channel and dims
        // what lies behind by its mean over the channels (the transmittance is one number, so
        // the air's blue-heavy extinction is carried as grey — at sea-level density that is
        // under 1 % across the band and about 7 % on a kilometres-long grazing ray).
        const airStep = exp(vec3(u.rayleigh).mul(dt).negate())
        const airMean = airStep.x.add(airStep.y).add(airStep.z).div(3)
        scattered.addAssign(vec3(u.sunRadiance).mul(rayleighPhase).mul(daylight).add(u.ambientRadiance)
          .mul(airStep.oneMinus()).mul(transmittance))
        weightedDistance.addAssign(transmittance.mul(airMean.oneMinus()).mul(t))
        transmittance.mulAssign(airMean)
        If(transmittance.lessThan(0.01), () => { Break() })
      })
    })
    let light: any = scattered
    if (hazeParts) {
      const fogDistance = weightedDistance.div(max(transmittance.oneMinus(), 1e-4))
      light = mix(scattered, vec3(hazeParts.color).mul(transmittance.oneMinus()),
        max(hazeParts.amount(fogDistance), hazeParts.wall(fogDistance)))
    }
    return vec4(light, transmittance)
  })()

  // ---------------------------------------------------------------- composite
  let marchTexture: any = null
  const release = () => {
    if (!marchTexture) return
    marchTexture.renderTarget.dispose()
    marchTexture._quadMesh?.material?.dispose()
    marchTexture = null
  }
  const buildComposite = (color: any, depth: any) => {
    release()
    const options = { ...build }
    marchTexture = rtt(marchNode(depth, options), null, null, { type: THREE.HalfFloatType, depthBuffer: false })
    marchTexture.setResolutionScale(resolutionScale)
    marchTexture.updateBeforeType = 'frame'
    const march = marchTexture
    return Fn(() => {
      const st = uv()
      const scene = color
      let fog: any
      // Not skipped at full resolution: the scale is a runtime setting, and there the taps'
      // weights collapse onto the pixel's own texel anyway.
      if (!options.depthAwareUpsample) {
        fog = march.sample(st)
      } else {
        const fullSize = vec2(sizeOf(depth))
        const lowSize = vec2(sizeOf(march))
        const linear = (z: any) => perspectiveDepthToViewZ(z, near, far).negate()
        const here = linear(depth.sample(st).x)
        const position = st.mul(lowSize).sub(0.5)
        const base = floor(position)
        const f = position.sub(base)
        const sum = vec4(0).toVar()
        const weight = float(0).toVar()
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const texel = clamp(base.add(vec2(ox, oy)), vec2(0), lowSize.sub(1))
          const lowUv = texel.add(0.5).div(lowSize)
          // The depth the march used for that texel: its full-resolution pixel's centre.
          const tapDepth = linear(depth.sample(floor(lowUv.mul(fullSize)).add(0.5).div(fullSize)).x)
          const bilinear = (ox === 1 ? f.x : f.x.oneMinus()).mul(oy === 1 ? f.y : f.y.oneMinus())
          const w = bilinear.mul(float(1).div(abs(here.sub(tapDepth)).div(here).mul(40).add(0.02)))
          sum.addAssign(march.sample(lowUv).mul(w))
          weight.addAssign(w)
        }
        fog = sum.div(max(weight, 1e-6))
      }
      if (options.debugView === 'light') return vec4(fog.rgb, 1)
      if (options.debugView === 'transmittance') return vec4(vec3(fog.a), 1)
      return vec4(scene.rgb.mul(fog.a).add(fog.rgb), scene.a)
    })()
  }

  // ---------------------------------------------------------------- density preview
  // One target per size and one quad per slice kind, kept: the editor asks for 256² and
  // 256 × 96 in turn on every refresh.
  const previewTargets = new Map<string, RenderTarget>()
  const previewQuads = new Map<DensitySliceRequest['kind'], QuadMesh>()
  const previewCentre = uniform(new THREE.Vector2())
  const previewSpan = uniform(800)
  const previewOffset = uniform(0)
  const previewBand = uniform(new THREE.Vector2())
  const previewNodes = new Map<string, any>()
  const previewNode = (kind: DensitySliceRequest['kind']) => {
    const key = `${kind}:${JSON.stringify(build)}`
    const cached = previewNodes.get(key)
    if (cached) return cached
    const options = { ...build }
    const node = Fn(() => {
      const st = uv()
      // North up: the canvas's top row is the window's northern edge.
      const x = previewCentre.x.add(st.x.sub(0.5).mul(previewSpan))
      const y = previewCentre.y.add(st.y.oneMinus().sub(0.5).mul(previewSpan))
      const footprint = previewSpan.div(256)
      const background = vec3(0.04, 0.07, 0.06)
      if (kind === 'column') {
        const tau = float(0).toVar()
        const dz = previewBand.y.sub(previewBand.x).div(32)
        Loop(32, ({ i }: { i: any }) => {
          const z = floorZ.add(previewBand.x).add(dz.mul(float(i).add(0.5)))
          tau.addAssign(density(vec3(x, y, z), footprint, options).sigma.mul(dz))
        })
        return vec4(mix(background, vec3(0.93, 0.95, 0.94), exp(tau.negate()).oneMinus()), 1)
      }
      // Top: `offsetM` above the band's floor, as the editor's height slider counts it.
      const z = kind === 'top'
        ? floorZ.add(previewBand.x).add(previewOffset)
        : floorZ.add(previewBand.x).add(st.y.oneMinus().mul(previewBand.y.sub(previewBand.x)))
      const px = kind === 'top' ? vec3(x, y, z) : vec3(x, previewCentre.y.add(previewOffset), z)
      const sigma = density(px, footprint, options).sigma
      // 1 − e^(−σ · 20 m): a 20 m look through that point.
      return vec4(mix(background, vec3(0.93, 0.95, 0.94), exp(sigma.mul(-20)).oneMinus()), 1)
    })()
    previewNodes.set(key, node)
    return node
  }
  /** The band's top above the floor, as the march's box has it (the veil aside). */
  const bandTopM = () => Math.max(params.topM, params.puffCentreM) + params.plumeHeightM
  let lastCameraEnu = new THREE.Vector2()
  const renderDensitySlice = async (request: DensitySliceRequest) => {
    if (!enabled) return null
    const sizeKey = `${request.width}x${request.height}`
    let target = previewTargets.get(sizeKey)
    if (!target) { target = new RenderTarget(request.width, request.height); previewTargets.set(sizeKey, target) }
    let quad = previewQuads.get(request.kind)
    if (!quad) { quad = new QuadMesh(new NodeMaterial()); previewQuads.set(request.kind, quad) }
    // A slider can ask for a preview between two frames, before update() has run.
    syncUniforms()
    previewCentre.value.copy(lastCameraEnu)
    previewSpan.value = request.spanM
    previewOffset.value = request.offsetM
    previewBand.value.set(params.bottomM, bandTopM())
    const node = previewNode(request.kind)
    const material = quad.material as NodeMaterial
    if (material.fragmentNode !== node) { material.fragmentNode = node; material.needsUpdate = true }
    const previousTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    quad.render(renderer)
    renderer.setRenderTarget(previousTarget)
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, request.width, request.height) as Uint8Array
    if (renderer.backend?.isWebGLBackend) {
      // WebGL reads bottom row first.
      const row = request.width * 4
      const flipped = new Uint8Array(pixels.length)
      for (let y = 0; y < request.height; y++) flipped.set(pixels.subarray(y * row, (y + 1) * row), (request.height - 1 - y) * row)
      return flipped
    }
    return new Uint8Array(pixels)
  }

  // ---------------------------------------------------------------- per frame
  const cameraEnu = new THREE.Vector3()
  const matrix = new THREE.Matrix4()
  const wrap = (v: number, period: number) => v - Math.floor(v / period) * period
  const advance = (offset: THREE.Vector2, scaleInv: number, deltaS: number) => {
    offset.set(
      wrap(offset.x + params.windMps[0] * deltaS * scaleInv, DRIFT_PERIOD),
      wrap(offset.y + params.windMps[1] * deltaS * scaleInv, DRIFT_PERIOD),
    )
  }
  const sun = new THREE.Color()
  const sky = new THREE.Color()
  /** Copy the live-tunable params into the uniforms. Per frame, and before a density preview,
   *  which a slider can ask for between two frames. */
  const syncUniforms = () => {
    u.steps.value = Math.max(1, Math.round(params.steps))
    u.stepDistribution.value = params.stepDistribution
    u.maxDistance.value = params.maxDistanceM
    u.bottom.value = params.bottomM; u.top.value = Math.max(params.topM, params.bottomM + 1)
    u.plumeHeight.value = params.plumeHeightM
    u.bottomSoft.value = Math.max(params.bottomSoftM, 0.5); u.topSoft.value = Math.max(params.topSoftM, 0.5)
    u.margin.value = params.marginM
    u.virtualCanopy.value = params.virtualCanopyM
    u.mapBelow.value = params.mapBelowM
    u.groundLevel.value = params.groundLevelM
    u.pointsReach.value = params.pointsReachM
    u.veilSigma.value = params.veilVisibilityM > 0 ? extinctionForVisibility(params.veilVisibilityM) : 0
    u.veilHeight.value = Math.max(params.veilHeightM, 1)
    u.plumeSpacing.value = Math.max(params.plumeSpacingM, 10)
    u.plumeRadius.value = Math.max(params.plumeRadiusM, 0.5)
    u.plumeChance.value = params.plumeChance
    // Downwind lean per metre of rise: the breeze against the rise speed.
    const riseSpeed = Math.max(params.riseMps, 0.05)
    u.plumeLean.value.set(params.windMps[0] / riseSpeed, params.windMps[1] / riseSpeed).multiplyScalar(0.15)
    u.puffCentre.value = params.puffCentreM
    u.puffHeight.value = Math.max(params.puffHeightM, 1)
    u.puffCut.value = params.puffCut
    u.puffAmount.value = params.puffAmount
    u.sigmaMax.value = extinctionForVisibility(params.visibilityM)
    u.coverage.value = params.coverage; u.coverageSoftness.value = Math.max(params.coverageSoftness, 0.005)
    u.coverageScaleInv.value = 1 / params.coverageScaleM
    u.billowScaleInv.value = 1 / params.billowScaleM
    u.erosionScaleInv.value = 1 / params.erosionScaleM
    u.wispScaleInv.value = 1 / params.wispScaleM
    u.wispHeightInv.value = 1 / params.wispHeightM
    u.billowAmount.value = params.billowAmount; u.erosionAmount.value = Math.min(params.erosionAmount, 0.95)
    u.wispAmount.value = params.wispAmount; u.plumeAmount.value = params.plumeAmount
    u.albedo.value = params.albedo
    u.canopyOcclusion.value = params.canopyOcclusion
    u.rayleigh.value.set(...RAYLEIGH_SEA_LEVEL_PER_M).multiplyScalar(params.rayleighScale)
    applyPhase()
  }

  const layer: GroundFogLayer = {
    build: buildComposite,
    update(cam, daylight, deltaS) {
      near.value = cam.near
      far.value = cam.far
      // The angle one drawing-buffer pixel spans, for the noise mip level.
      const size = renderer.getDrawingBufferSize(new THREE.Vector2())
      u.pixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(size.y * resolutionScale, 1)
      matrix.copy(shared.enuInverse.value)
      cameraEnu.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(matrix)
      lastCameraEnu.set(cameraEnu.x, cameraEnu.y)
      const dt = Math.min(Math.max(deltaS, 0), 0.25)
      advance(u.offCoverage.value, u.coverageScaleInv.value, dt)
      advance(u.offBillow.value, u.billowScaleInv.value, dt)
      advance(u.offErosion.value, u.erosionScaleInv.value, dt)
      advance(u.offWisp.value, u.wispScaleInv.value, dt)
      u.rise.value = wrap(u.rise.value + params.riseMps * dt * u.wispHeightInv.value, RISE_PERIOD)
      if (daylight) {
        sun.copy(daylight.lightColor).multiplyScalar(daylight.intensity * params.sunStrength)
        // Skylight: the daylight tinted by the sky colour by `skyTint` — the humid air over a
        // forest scatters the sky into a paler, whiter light than the zenith's blue.
        sky.copy(daylight.daylightColor).lerp(daylight.skyColor, params.skyTint)
          .multiplyScalar(Math.max(daylight.ambientIntensity, 0.02) * params.ambientStrength)
        u.sunRadiance.value.copy(sun).multiply(params.tint)
        u.ambientRadiance.value.copy(sky).multiply(params.tint)
      }
      syncUniforms()
    },
    isEnabled: () => enabled,
    setEnabled(next) {
      if (next === enabled) return false
      enabled = next
      if (!enabled) release()
      return true
    },
    getBuildOptions: () => ({ ...build }),
    setBuildOption(key, value) {
      if (build[key] === value) return false
      build[key] = value
      if (key === 'noiseSource' && value === '3d' && !noise3dTexture) void ensure3d()
      return true
    },
    setResolutionScale(scale) {
      resolutionScale = THREE.MathUtils.clamp(scale, 0.125, 1)
      marchTexture?.setResolutionScale(resolutionScale)
    },
    getResolutionScale: () => resolutionScale,
    applyPreset(preset) {
      const quality = CONFIG.qualityByPreset[preset]
      params.steps = quality.steps
      layer.setResolutionScale(quality.resolutionScale)
    },
    setFrame(z, min, max) {
      floorZ.value = z
      boundsMin.value.copy(min)
      boundsMax.value.copy(max)
    },
    setHaze(haze) {
      if (haze === hazeParts) return false
      hazeParts = haze
      return true
    },
    params,
    noiseSettings: () => JSON.parse(JSON.stringify(noiseSettings)),
    setNoise,
    bake3dPreview: (size) => ensure3d(size),
    renderDensitySlice,
    bandHeightM: () => bandTopM() - params.bottomM,
    dispose() {
      release()
      previewTargets.forEach((target) => target.dispose())
      previewQuads.forEach((quad) => (quad.material as NodeMaterial).dispose())
      noiseTexture.dispose()
      noise3dTexture?.dispose()
      baker.dispose()
    },
  }
  return layer
}
