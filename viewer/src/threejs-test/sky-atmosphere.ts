// Physically based sky: Hillaire's (2020) lookup tables in TSL, the sun disc at full
// resolution, aerial perspective for every surface, and the light the sky casts on the scene.
//
// The model is atmosphere-model.ts. Here it is rendered into four small tables, all fragment
// passes into half-float render targets so the WebGL2 fallback runs the same code:
//   · transmittance, 256 × 64: how much sunlight gets through from any height along any
//     zenith angle. Redrawn only when the air's parameters change.
//   · multiple scattering, 32 × 32: Hillaire's closed-form sum of every scattering order past
//     the first, per height and sun angle. Same schedule.
//   · sky view at the camera's altitude, 192 × 108, twice: the molecules' light with their
//     phase applied and the multiple scattering added (A), and the aerosols' single
//     scattering without its phase (B). Redrawn every frame — about 21 k texels × 30 steps.
//     Splitting the aerosol phase out is Bruneton's trick: the sharp forward glow around the
//     sun is evaluated per pixel, so the low-resolution table does not blur it.
//   · sky view at the ground, 64 × 36, the same two parts: what the capture below integrates.
// Rows are packed toward the horizon and columns toward the sun by square roots, so the
// table is sharpest where the sky changes fastest. The sky is a set of gradients, which is
// why so few texels suffice; the sun disc is the exception and is drawn analytically.
//
// Light. A tiny capture pass integrates the ground's sky view (and the clouds in front of it,
// see sky-clouds.ts) into the sky's irradiance on a horizontal surface and its mean radiance,
// and reads the sun's opacity through the clouds; four texels read back asynchronously
// whenever the sun or the clouds change. The sun's own illuminance at the ground comes from
// the CPU copy of the transmittance model, so the light uniforms are written the same frame
// the clock moves.
//
// Exposure. Radiances are relative to a top-of-atmosphere sun of 1. A white Lambertian surface
// under the reference illuminance (atmosphere-model.ts) displays as 1, so a radiance L shows
// as L·π·K, K = exposure / E_ref, times an adaptation that lifts dim scenes partway toward the
// reference (a camera's auto exposure, compressed so dusk still reads as dusk).
import * as THREE from 'three'
import { NodeMaterial, QuadMesh, RenderTarget } from 'three/webgpu'
import * as TSL from 'three/tsl'
import {
  SUN_ANGULAR_RADIUS, atmosphereParameters, ellipsoidHeight, luminance, referenceIlluminance, sunIlluminance,
  type AtmosphereParameters, type AtmosphereSettings, type Rgb,
} from './atmosphere-model'

// TSL's typings reject most of the mixed scalar / vector arithmetic WGSL and GLSL accept, so
// the graph is built loosely typed, as elsewhere in this codebase.
const {
  Fn, If, Loop, abs, asin, clamp, cos, dot, exp, float, length, max, min, normalize, pow,
  renderGroup, select, sin, smoothstep, sqrt, texture, uniform, uv, vec2, vec3, vec4,
} = TSL as any

const TRANSMITTANCE_SIZE = [256, 64] as const
const WGS84_A = 6_378_137
const WGS84_B = 6_356_752.314245
const scratchUp = new THREE.Vector3()
const MULTI_SCATTERING_SIZE = 32
const SKY_VIEW_SIZE = [192, 108] as const
const GROUND_VIEW_SIZE = [64, 36] as const
const PI = Math.PI

/** What the clouds give the sky: everything in relative radiance, from the camera. */
export interface SkyCloudSource {
  /** `radiance`: the clouds' premultiplied light, aerial perspective applied (vec3).
   *  `skyOcclusion`: how much of the sky behind they hide, as seen through the haze in front.
   *  `sunOcclusion`: their true opacity, which hides the sun disc. */
  sample(dirEnu: any): { radiance: any; skyOcclusion: any; sunOcclusion: any }
  /** The sun's mean transmittance through the clouds over the surroundings (a node): how much
   *  of the air around is in sunlight at all. */
  meanSunTransmittance(): any
  /** The same two as the capture sees them: from the survey's ground, the newest finished
   *  clouds, no display fades. */
  captureSample(dirEnu: any): { radiance: any; skyOcclusion: any; sunOcclusion: any }
  captureMeanSunTransmittance(): any
  /** Bumped whenever `sample` would build different nodes. */
  readonly version: number
}

/** Live-tunable look, read every frame. */
export interface SkyParams {
  /** Overall exposure on top of the physical anchor. */
  exposure: number
  /** 0 keeps the physical brightness; 1 brings every scene to the reference. */
  adaptation: number
  /** The most the adaptation may brighten, as a factor. */
  adaptationMax: number
  /** How much of the clouds' darkening the adaptation follows: 0 adapts to the time of day
   *  alone (the clear sky's light), so weather reads as darker, as on film; 1 adapts to the
   *  light actually reaching the ground, so a cloud over the sun swings the exposure. */
  weatherAdaptation: number
  sunIntensity: number
  /** Disc size relative to the real sun (0.53°). The disc keeps its total light. */
  sunSize: number
  /** Width of the disc's edge, in pixels. */
  sunSharpnessPx: number
  /** Limb darkening, 0 (flat disc) to 1 (the real sun is ~0.85). */
  sunLimbDarkening: number
  /** Artistic glow around the sun, on top of the aerosols' physical halo. */
  sunGlow: number
  /** How wide that glow spreads: 0 tight, 1 wide. */
  sunGlowSize: number
  /** Tint on the disc and the glow, linear. */
  sunTint: THREE.Color
  /** Ceiling on the disc's displayed radiance: keeps the half-float frame finite and the
   *  depth-of-field bokeh of the sun bearable. */
  sunMaxRadiance: number
  /** Night: a floor on the sky so it reads as a dark blue rather than black. */
  nightSky: THREE.Color
  /** Aerial perspective: clear distance, and a multiplier on its optical depth. */
  aerialStartM: number
  aerialDensity: number
  /** White balance: 1 sets white to the noon sun's colour, as a camera on daylight would —
   *  the sun at noon reads white, the sky blue, a low sun orange; 0 leaves the sun at the top
   *  of the atmosphere white, which makes every daylight scene yellow. */
  whiteBalance: number
  /** An artistic multiplier on the sky's own radiance — the background and the haze, not the
   *  light it casts. */
  skyBrightness: number
  /** Under a full overcast, the share of the clear sky's glow the haze keeps: the light the
   *  clouds let through diffusely. */
  overcastGlow: number
}

/** The light the sky and sun cast this frame, CPU side, already in display units. */
export interface SkyLight {
  /** Direct sun on a surface facing it at the ground, display units (× K). */
  sun: THREE.Color
  /** Sky irradiance on a horizontal surface, display units. */
  sky: THREE.Color
  /** Mean radiance of the upper sky, display units (× π K, so a white surface under a sky of
   *  this radiance on every side would show as this). */
  skyMean: THREE.Color
  /** Transmittance of the sun through the clouds, from the dome (1 without clouds). */
  sunThroughClouds: number
  /** The sun's mean transmittance through the clouds over the surroundings (1 without). */
  cloudSunMean: number
  /** The clear sky's mean radiance from the ground, relative units (before the exposure). */
  clearSkyMean: Rgb
  /** K: the factor from relative illuminance to display. */
  illuminanceScale: number
  /** Sun elevation, radians. */
  sunElevation: number
}

export interface SkyAtmosphere {
  readonly params: SkyParams
  readonly light: SkyLight
  /** Shader-side helpers, all built from shared uniforms. */
  readonly nodes: SkyNodes
  setAtmosphere(settings: AtmosphereSettings): void
  getAtmosphere(): AtmosphereSettings
  setClouds(source: SkyCloudSource | null): void
  /** Bumped when a node built from `nodes` would come out different (clouds switched). */
  readonly version: number
  /** Per frame, before the scene renders. */
  update(input: SkyUpdate): void
  /** Ask for the capture to run again on the next update (the clouds changed). */
  invalidateCapture(): void
  /** The tables, for the debug view. */
  readonly textures: { transmittance: THREE.Texture; multiScattering: THREE.Texture; skyViewA: THREE.Texture; skyViewB: THREE.Texture }
  /** Debugging: read a table's texels back (relative units). */
  debugRead(table: 'transmittance' | 'multi' | 'skyA' | 'skyB' | 'groundA' | 'capture'): Promise<{ width: number; height: number; data: Float32Array | Uint16Array }>
  dispose(): void
}

export interface SkyUpdate {
  cameraEcef: THREE.Vector3
  /** Render space → ENU rotation (the floating origin only translates). */
  worldToEnu: THREE.Matrix3
  sunDirectionEnu: THREE.Vector3
  /** Altitude of the drawn ground above the ellipsoid, metres (0: the imagery lies on it). */
  groundAltitudeM: number
  /** Vertical field of view (degrees) and the drawing buffer height, for the disc's edge. */
  fovDeg: number
  bufferHeightPx: number
  deltaS: number
}

export interface SkyNodes {
  /** Render-space direction → ENU. */
  toEnu(dirWorld: any): any
  /** The sky's radiance along an ENU direction from the camera, relative units, without the
   *  sun disc. */
  skyRadiance(dirEnu: any): any
  /** Transmittance from radius `r` (km from the planet's centre) to the top of the air along
   *  zenith cosine `mu`. */
  transmittance(r: any, mu: any): any
  /** Aerial perspective over `distanceM` along `dirEnu` from the camera: transmittance and
   *  in-scattered light (display units). */
  aerial(distanceM: any, dirEnu: any): { transmittance: any; inscatter: any }
  /** What the background shows along `dirEnu`: sky, ground below the horizon, clouds and,
   *  with `withSun`, the disc and glow. Display units. */
  background(dirEnu: any, withSun: boolean): any
  /** The sun's direction in ENU, a renderGroup uniform. */
  sunDirection: any
  /** π·K: relative radiance → display. */
  radianceScale: any
  /** Camera radius, km from the planet's centre. */
  cameraRadius: any
  /** The atmosphere's uniforms (km, per km), for passes that march the air themselves. */
  air: Record<string, any>
  /** Aerosol phase function at `cosTheta`. */
  miePhase(cosTheta: any): any
  /** Multiple-scattering luminance at radius r for sun zenith cosine mu. */
  multiScattering(r: any, mu: any): any
  /** Transmittance of the air over `distanceKm` from radius `r0` along zenith cosine `mu0`
   *  (Simpson's rule over the exponential layers), for passes that see from elsewhere than the
   *  camera — the cloud bake's eye. */
  airTransmittance(r0: any, mu0: any, distanceKm: any): any
}

// ---------------------------------------------------------------- shared helpers

const fromUnitToSubUv = (u: any, resolution: number) => u.add(0.5 / resolution).mul(resolution / (resolution + 1))
const fromSubUvToUnit = (u: any, resolution: number) => u.sub(0.5 / resolution).mul(resolution / (resolution - 1))

/** Nearest positive distance along `rd` from `ro` (planet-centred, km) to a sphere, or −1. */
const raySphere = (ro: any, rd: any, radius: any) => {
  const b = dot(ro, rd)
  const c = dot(ro, ro).sub(radius.mul(radius))
  const disc = b.mul(b).sub(c)
  const s = sqrt(max(disc, 0))
  const t0 = b.negate().sub(s)
  const t1 = b.negate().add(s)
  return select(disc.lessThan(0), float(-1), select(t0.greaterThan(0), t0, select(t1.greaterThan(0), t1, float(-1))))
}

const rayleighPhase = (c: any) => c.mul(c).add(1).mul(3 / (16 * PI))
/** Cornette–Shanks, the aerosol phase Hillaire uses: HG with a (1 + cos²) factor. */
const cornetteShanks = (c: any, g: any) => {
  const g2 = g.mul(g)
  const k = float(3 / (8 * PI)).mul(g2.oneMinus()).div(g2.add(2))
  const d = g2.add(1).sub(g.mul(c).mul(2))
  return k.mul(c.mul(c).add(1)).div(pow(max(d, 1e-6), 1.5))
}
const henyeyGreenstein = (c: any, g: any) => {
  const g2 = g.mul(g)
  const d = g2.add(1).sub(g.mul(c).mul(2))
  return g2.oneMinus().div(pow(max(d, 1e-6), 1.5).mul(4 * PI))
}

export function createSkyAtmosphere(opts: { renderer: any; settings: AtmosphereSettings; params: SkyParams }): SkyAtmosphere {
  const { renderer } = opts
  let settings: AtmosphereSettings = JSON.parse(JSON.stringify(opts.settings))
  let model: AtmosphereParameters = atmosphereParameters(settings)
  let referenceE = referenceIlluminance(model)
  const params = opts.params

  // ---------------------------------------------------------------- uniforms
  const group = (node: any) => node.setGroup(renderGroup)
  const air = {
    bottom: group(uniform(model.bottomRadiusKm)),
    top: group(uniform(model.topRadiusKm)),
    rayleighScattering: group(uniform(new THREE.Vector3(...model.rayleighScattering))),
    rayleighHeight: group(uniform(model.rayleighScaleHeightKm)),
    mieScattering: group(uniform(new THREE.Vector3(...model.mieScattering))),
    mieExtinction: group(uniform(new THREE.Vector3(...model.mieExtinction))),
    mieHeight: group(uniform(model.mieScaleHeightKm)),
    mieG: group(uniform(model.mieG)),
    ozoneAbsorption: group(uniform(new THREE.Vector3(...model.ozoneAbsorption))),
    ozoneCentre: group(uniform(model.ozoneCentreKm)),
    ozoneHalfWidth: group(uniform(model.ozoneHalfWidthKm)),
    groundAlbedo: group(uniform(new THREE.Vector3(...model.groundAlbedo))),
  }
  const writeAir = () => {
    air.bottom.value = model.bottomRadiusKm
    air.top.value = model.topRadiusKm
    air.rayleighScattering.value.set(...model.rayleighScattering)
    air.rayleighHeight.value = model.rayleighScaleHeightKm
    air.mieScattering.value.set(...model.mieScattering)
    air.mieExtinction.value.set(...model.mieExtinction)
    air.mieHeight.value = model.mieScaleHeightKm
    air.mieG.value = model.mieG
    air.ozoneAbsorption.value.set(...model.ozoneAbsorption)
    air.ozoneCentre.value = model.ozoneCentreKm
    air.ozoneHalfWidth.value = model.ozoneHalfWidthKm
    air.groundAlbedo.value.set(...model.groundAlbedo)
  }
  const worldToEnu = group(uniform(new THREE.Matrix3()))
  const sunDirection = group(uniform(new THREE.Vector3(0, 0, 1)))
  const cameraRadius = group(uniform(model.bottomRadiusKm + 0.3))
  /** The camera's local zenith in the survey's ENU frame: away from the survey the planet's
   *  up tilts against ENU z (1.2° at the entrance flight's start, 132 km out), and the horizon,
   *  limb glow and ground split follow the camera's up, not the survey's. */
  const cameraUp = group(uniform(new THREE.Vector3(0, 0, 1)))
  const groundRadius = group(uniform(model.bottomRadiusKm))
  const radianceScale = group(uniform(new THREE.Vector3(PI, PI, PI)))
  const skyBrightness = group(uniform(1))
  const groundIrradiance = group(uniform(new THREE.Vector3(0.5, 0.5, 0.5)))
  const pixelAngle = group(uniform(0.001))
  const sunIntensity = group(uniform(1))
  const sunRadius = group(uniform(SUN_ANGULAR_RADIUS))
  const sunSharpness = group(uniform(1.5))
  const sunLimb = group(uniform(0.85))
  const sunGlow = group(uniform(0))
  const sunGlowG = group(uniform(0.98))
  const sunTint = group(uniform(new THREE.Color(1, 1, 1)))
  const sunMax = group(uniform(60))
  const nightSky = group(uniform(new THREE.Color(0, 0, 0)))
  /** The share of the air's own glow left under the clouds: in sunlight it is the clear sky,
   *  under an overcast only the light the clouds let through diffusely lights the haze. */
  const cloudLight = group(uniform(1))
  const aerialStart = group(uniform(0))
  const aerialDensity = group(uniform(1))

  // ---------------------------------------------------------------- the medium
  const medium = (h: any) => {
    const rayleigh = exp(max(h, 0).negate().div(air.rayleighHeight))
    const mie = exp(max(h, 0).negate().div(air.mieHeight))
    const ozone = max(float(1).sub(abs(h.sub(air.ozoneCentre)).div(air.ozoneHalfWidth)), 0)
    const rayleighScattering = vec3(air.rayleighScattering).mul(rayleigh)
    const mieScattering = vec3(air.mieScattering).mul(mie)
    const extinction = rayleighScattering.add(vec3(air.mieExtinction).mul(mie)).add(vec3(air.ozoneAbsorption).mul(ozone))
    return { rayleighScattering, mieScattering, extinction }
  }

  // ---------------------------------------------------------------- transmittance table
  const transmittanceTarget = makeTarget(TRANSMITTANCE_SIZE[0], TRANSMITTANCE_SIZE[1], 'sky-transmittance')
  const transmittanceTexture = texture(transmittanceTarget.texture)
  const transmittanceNode = Fn(() => {
    const st = uv()
    const xMu = fromSubUvToUnit(st.x, TRANSMITTANCE_SIZE[0])
    // uv.y = 0 is the table's top row; Bruneton's v runs from the ground (0) up.
    const xR = fromSubUvToUnit(st.y.oneMinus(), TRANSMITTANCE_SIZE[1])
    const H = sqrt(air.top.mul(air.top).sub(air.bottom.mul(air.bottom)))
    const rho = H.mul(xR)
    const r = sqrt(rho.mul(rho).add(air.bottom.mul(air.bottom)))
    const dMin = air.top.sub(r)
    const dMax = rho.add(H)
    const d = dMin.add(xMu.mul(dMax.sub(dMin)))
    const mu = clamp(select(d.lessThan(1e-6), float(1), H.mul(H).sub(rho.mul(rho)).sub(d.mul(d)).div(r.mul(d).mul(2))), -1, 1)
    const depth = vec3(0).toVar()
    const steps = 40
    const dt = d.div(steps)
    Loop(steps, ({ i }: { i: any }) => {
      const t = float(i).add(0.5).mul(dt)
      const h = sqrt(r.mul(r).add(t.mul(t)).add(r.mul(mu).mul(t).mul(2))).sub(air.bottom)
      depth.addAssign(medium(h).extinction.mul(dt))
    })
    return vec4(exp(depth.negate()), 1)
  })()

  /** Transmittance to the top of the air from radius r along zenith cosine mu. */
  const transmittanceAt = (r: any, mu: any) => {
    const H = sqrt(air.top.mul(air.top).sub(air.bottom.mul(air.bottom)))
    const rho = sqrt(max(r.mul(r).sub(air.bottom.mul(air.bottom)), 0))
    const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(air.top.mul(air.top))
    const d = max(r.negate().mul(mu).add(sqrt(max(disc, 0))), 0)
    const dMin = air.top.sub(r)
    const dMax = rho.add(H)
    const xMu = d.sub(dMin).div(max(dMax.sub(dMin), 1e-6))
    const xR = rho.div(H)
    const u = fromUnitToSubUv(clamp(xMu, 0, 1), TRANSMITTANCE_SIZE[0])
    const v = fromUnitToSubUv(clamp(xR, 0, 1), TRANSMITTANCE_SIZE[1]).oneMinus()
    return transmittanceTexture.sample(vec2(u, v)).level(0).rgb
  }
  /** 0 where the sun at zenith cosine mu is below the planet's limb from radius r. */
  const sunAboveLimb = (r: any, mu: any) => {
    const sinHorizon = air.bottom.div(r)
    const cosHorizon = sqrt(max(sinHorizon.mul(sinHorizon).oneMinus(), 0)).negate()
    return smoothstep(cosHorizon.sub(SUN_ANGULAR_RADIUS), cosHorizon.add(SUN_ANGULAR_RADIUS), mu)
  }

  // ---------------------------------------------------------------- multiple scattering table
  const multiTarget = makeTarget(MULTI_SCATTERING_SIZE, MULTI_SCATTERING_SIZE, 'sky-multi-scattering')
  const multiTexture = texture(multiTarget.texture)
  const multiNode = Fn(() => {
    const st = uv()
    const muS = fromSubUvToUnit(st.x, MULTI_SCATTERING_SIZE).mul(2).sub(1)
    const h01 = fromSubUvToUnit(st.y.oneMinus(), MULTI_SCATTERING_SIZE)
    const r = air.bottom.add(clamp(h01, 0, 1).mul(air.top.sub(air.bottom))).add(0.001)
    const sun = vec3(sqrt(max(muS.mul(muS).oneMinus(), 0)), 0, muS)
    const origin = vec3(0, 0, r)
    const secondOrder = vec3(0).toVar()
    const transfer = vec3(0).toVar()
    const sqrtSamples = 8
    const steps = 20
    Loop(sqrtSamples, sqrtSamples, ({ i, j }: { i: any; j: any }) => {
      const theta = float(i).add(0.5).div(sqrtSamples).mul(2 * PI)
      const phi = float(j).add(0.5).div(sqrtSamples).mul(-2).add(1).acos()
      // Frozen before the inner loop: a TSL expression is inlined where it is first used.
      const dir = vec3(cos(theta).mul(sin(phi)), sin(theta).mul(sin(phi)), cos(phi)).toVar()
      const tBottom = raySphere(origin, dir, air.bottom).toVar()
      const tTop = raySphere(origin, dir, air.top)
      const hitGround = tBottom.greaterThan(0).toVar()
      const tMax = select(hitGround, tBottom, max(tTop, 0))
      const dt = tMax.div(steps).toVar()
      const throughput = vec3(1).toVar()
      const L = vec3(0).toVar()
      const f = vec3(0).toVar()
      Loop({ start: 0, end: steps, name: 'step' }, ({ step: k }: { step: any }) => {
        const t = float(k).add(0.5).mul(dt)
        const p = origin.add(dir.mul(t))
        const pr = length(p)
        const m = medium(pr.sub(air.bottom))
        const scattering = m.rayleighScattering.add(m.mieScattering)
        const stepT = exp(m.extinction.mul(dt).negate())
        const muP = dot(p, sun).div(pr)
        const sunT = transmittanceAt(pr, muP).mul(sunAboveLimb(pr, muP))
        const ext = max(m.extinction, vec3(1e-7))
        // Energy-conserving step integrals (Hillaire 2015).
        const integral = vec3(1).sub(stepT).div(ext)
        L.addAssign(throughput.mul(scattering).mul(sunT).mul(1 / (4 * PI)).mul(integral))
        f.addAssign(throughput.mul(scattering).mul(integral))
        throughput.mulAssign(stepT)
      })
      // Light bounced off the ground at the ray's end.
      If(hitGround, () => {
        const p = origin.add(dir.mul(tBottom))
        const n = normalize(p)
        const muG = dot(n, sun)
        L.addAssign(throughput.mul(transmittanceAt(air.bottom, muG)).mul(max(muG, 0)).mul(vec3(air.groundAlbedo)).mul(1 / PI))
      })
      secondOrder.addAssign(L.div(sqrtSamples * sqrtSamples))
      transfer.addAssign(f.div(sqrtSamples * sqrtSamples))
    })
    // Every further order is the second times the transfer to the power of the order: a
    // geometric series, 1 / (1 − f).
    return vec4(secondOrder.div(vec3(1).sub(min(transfer, vec3(0.99)))), 1)
  })()
  const multiScatteringAt = (r: any, mu: any) => {
    const u = fromUnitToSubUv(clamp(mu.mul(0.5).add(0.5), 0, 1), MULTI_SCATTERING_SIZE)
    const v = fromUnitToSubUv(clamp(r.sub(air.bottom).div(air.top.sub(air.bottom)), 0, 1), MULTI_SCATTERING_SIZE).oneMinus()
    return multiTexture.sample(vec2(u, v)).level(0).rgb
  }

  // ---------------------------------------------------------------- sky-view tables
  /**
   * Single scattering plus the multiple-scattering term along one view ray from radius
   * `r` (on the local z axis), for a sun at zenith cosine `muS` in the x–z plane. Returns the
   * molecules' light with phase (A, plus all multiple scattering) and the aerosols' light
   * without phase (B).
   */
  const integrateView = (r: any, dir: any, muS: any, steps: number) => {
    const origin = vec3(0, 0, r)
    const sun = vec3(sqrt(max(muS.mul(muS).oneMinus(), 0)), 0, muS)
    const tBottom = raySphere(origin, dir, air.bottom)
    const tTop = raySphere(origin, dir, air.top)
    const tMax = select(tBottom.greaterThan(0), tBottom, max(tTop, 0))
    const cosTheta = dot(dir, sun)
    const phaseR = rayleighPhase(cosTheta)
    const A = vec3(0).toVar()
    const B = vec3(0).toVar()
    const throughput = vec3(1).toVar()
    const previous = float(0).toVar()
    Loop(steps, ({ i }: { i: any }) => {
      // Samples crowded toward the camera, where the dense low air is.
      const s = float(i).add(1).div(steps)
      const tNext = tMax.mul(s.mul(s)).toVar()
      const t = previous.add(tNext).mul(0.5).toVar()
      const dt = tNext.sub(previous).toVar()
      previous.assign(tNext)
      const p = origin.add(dir.mul(t))
      const pr = length(p)
      const m = medium(pr.sub(air.bottom))
      const muP = dot(p, sun).div(pr)
      const sunT = transmittanceAt(pr, muP).mul(sunAboveLimb(pr, muP))
      const ms = multiScatteringAt(pr, muP)
      const stepT = exp(m.extinction.mul(dt).negate())
      const integral = vec3(1).sub(stepT).div(max(m.extinction, vec3(1e-7)))
      A.addAssign(throughput.mul(integral).mul(m.rayleighScattering.mul(phaseR).mul(sunT)
        .add(ms.mul(m.rayleighScattering.add(m.mieScattering)))))
      B.addAssign(throughput.mul(integral).mul(m.mieScattering).mul(sunT))
      throughput.mulAssign(stepT)
    })
    return { A, B }
  }
  /** The sky-view table's (u, v) → view ray and its light, for one of the two parts. */
  const skyViewNode = (radius: any, part: 'A' | 'B', size: readonly [number, number], steps: number, muS: any) => Fn(() => {
    const st = uv()
    const u = fromSubUvToUnit(st.x, size[0])
    const v = fromSubUvToUnit(st.y, size[1])
    const r = max(radius, air.bottom.add(0.01))
    const vHorizon = sqrt(max(r.mul(r).sub(air.bottom.mul(air.bottom)), 0))
    const beta = vHorizon.div(r).acos()
    const zenithHorizon = float(PI).sub(beta)
    const below = v.greaterThanEqual(0.5)
    const upCoord = float(1).sub(float(1).sub(v.mul(2)).pow(2))
    const downCoord = v.mul(2).sub(1).pow(2)
    const viewZenith = select(below, zenithHorizon.add(beta.mul(downCoord)), zenithHorizon.mul(upCoord))
    const cosLight = u.mul(u).mul(2).sub(1).negate()
    const sinLight = sqrt(max(cosLight.mul(cosLight).oneMinus(), 0))
    const dir = vec3(sin(viewZenith).mul(cosLight), sin(viewZenith).mul(sinLight), cos(viewZenith))
    const result = integrateView(r, dir, muS, steps)
    return vec4(part === 'A' ? result.A : result.B, 1)
  })()
  const skyViewA = makeTarget(SKY_VIEW_SIZE[0], SKY_VIEW_SIZE[1], 'sky-view-a')
  const skyViewB = makeTarget(SKY_VIEW_SIZE[0], SKY_VIEW_SIZE[1], 'sky-view-b')
  const groundViewA = makeTarget(GROUND_VIEW_SIZE[0], GROUND_VIEW_SIZE[1], 'sky-ground-view-a')
  const groundViewB = makeTarget(GROUND_VIEW_SIZE[0], GROUND_VIEW_SIZE[1], 'sky-ground-view-b')
  const skyViewATexture = texture(skyViewA.texture)
  const skyViewBTexture = texture(skyViewB.texture)
  const groundViewATexture = texture(groundViewA.texture)
  const groundViewBTexture = texture(groundViewB.texture)

  /** (u, v) in a sky-view table for an ENU direction seen from radius r. */
  const skyViewUv = (r: any, dirEnu: any, size: readonly [number, number], up: any) => {
    const vHorizon = sqrt(max(r.mul(r).sub(air.bottom.mul(air.bottom)), 0))
    const cosBeta = vHorizon.div(r)
    const beta = cosBeta.acos()
    const zenithHorizon = float(PI).sub(beta)
    const mu = clamp(dot(dirEnu, up), -1, 1)
    const viewZenith = mu.acos()
    const groundHit = mu.lessThan(cosBeta.negate())
    const vUp = float(1).sub(sqrt(max(float(1).sub(viewZenith.div(zenithHorizon)), 0))).mul(0.5)
    const vDown = sqrt(max(viewZenith.sub(zenithHorizon).div(beta), 0)).mul(0.5).add(0.5)
    const v = select(groundHit, vDown, vUp)
    // Azimuth between the view and the sun, in the horizontal plane; undefined straight up or
    // with the sun at the zenith, where the sky is symmetric anyway.
    const viewXY = dirEnu.sub(up.mul(dot(dirEnu, up)))
    const sunXY = sunDirection.sub(up.mul(dot(sunDirection, up)))
    const lv = length(viewXY)
    const ls = length(sunXY)
    const cosLight = select(lv.mul(ls).greaterThan(1e-5), dot(viewXY, sunXY).div(max(lv.mul(ls), 1e-9)), float(1))
    const u = sqrt(max(cosLight.mul(-0.5).add(0.5), 0))
    return vec2(fromUnitToSubUv(u, size[0]), fromUnitToSubUv(v, size[1]))
  }
  const miePhase = (cosTheta: any) => cornetteShanks(cosTheta, air.mieG)
  const skyRadiance = (dirEnu: any) => {
    const st = skyViewUv(cameraRadius, dirEnu, SKY_VIEW_SIZE, cameraUp)
    const A = skyViewATexture.sample(st).level(0).rgb
    const B = skyViewBTexture.sample(st).level(0).rgb
    return A.add(B.mul(miePhase(dot(dirEnu, sunDirection)))).mul(skyBrightness).mul(cloudLight)
  }
  /** The clear sky seen from the ground, as if there were no clouds at all. */
  const clearGroundSkyRadiance = (dirEnu: any) => {
    const st = skyViewUv(groundRadius.add(0.01), dirEnu, GROUND_VIEW_SIZE, vec3(0, 0, 1))
    const A = groundViewATexture.sample(st).level(0).rgb
    const B = groundViewBTexture.sample(st).level(0).rgb
    return A.add(B.mul(miePhase(dot(dirEnu, sunDirection))))
  }
  const groundSkyRadiance = (dirEnu: any) => clearGroundSkyRadiance(dirEnu).mul(cloudLight)

  /** Transmittance from the camera to where a downward ray meets the ground, and that
   *  distance; (1, −1) for a ray that does not. */
  const toGround = (dirEnu: any) => {
    const r = cameraRadius
    const mu = dot(dirEnu, cameraUp)
    const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(air.bottom.mul(air.bottom))
    const hit = mu.lessThan(0).and(disc.greaterThanEqual(0))
    const d = r.negate().mul(mu).sub(sqrt(max(disc, 0)))
    const muGround = clamp(r.mul(mu).add(d).div(air.bottom), -1, 1)
    // Both upward: from the ground back to the camera's height, over the camera upward.
    const tGround = transmittanceAt(air.bottom, muGround.negate())
    const tCamera = transmittanceAt(r, mu.negate())
    const T = clamp(tGround.div(max(tCamera, vec3(1e-6))), 0, 1)
    return { hit, distance: d, transmittance: T }
  }

  // ---------------------------------------------------------------- aerial perspective
  /**
   * Over a segment of `distanceM` metres from the camera: the optical depth of the exponential
   * air, by Simpson's rule over the heights at the ends and the middle (the curved Earth
   * included), and the light scattered into it, taken from the sky-view table for the same
   * direction scaled by how much of the full ray's in-scatter this part of it holds.
   */
  const airTransmittance = (r0: any, mu0: any, dKm: any) => {
    const radiusAt = (t: any) => sqrt(r0.mul(r0).add(t.mul(t)).add(r0.mul(mu0).mul(t).mul(2)))
    const h0 = r0.sub(air.bottom)
    const hm = radiusAt(dKm.mul(0.5)).sub(air.bottom)
    const h1 = radiusAt(dKm).sub(air.bottom)
    const density = (h: any, height: any) => exp(max(h, 0).negate().div(height))
    const rayleigh = density(h0, air.rayleighHeight).add(density(hm, air.rayleighHeight).mul(4)).add(density(h1, air.rayleighHeight)).div(6)
    const mie = density(h0, air.mieHeight).add(density(hm, air.mieHeight).mul(4)).add(density(h1, air.mieHeight)).div(6)
    return exp(vec3(air.rayleighScattering).mul(rayleigh).add(vec3(air.mieExtinction).mul(mie)).mul(dKm).negate())
  }
  const aerial = (distanceM: any, dirEnu: any) => {
    const r0 = cameraRadius
    const mu0 = dot(dirEnu, cameraUp)
    const dKm = max(distanceM.sub(aerialStart), 0).div(1000)
    const radiusAt = (t: any) => sqrt(r0.mul(r0).add(t.mul(t)).add(r0.mul(mu0).mul(t).mul(2)))
    const startKm = min(aerialStart.div(1000), distanceM.div(1000))
    const h0 = radiusAt(startKm).sub(air.bottom)
    const hm = radiusAt(startKm.add(dKm.mul(0.5))).sub(air.bottom)
    const h1 = radiusAt(startKm.add(dKm)).sub(air.bottom)
    const density = (h: any, height: any) => exp(max(h, 0).negate().div(height))
    const rayleigh = density(h0, air.rayleighHeight).add(density(hm, air.rayleighHeight).mul(4)).add(density(h1, air.rayleighHeight)).div(6)
    const mie = density(h0, air.mieHeight).add(density(hm, air.mieHeight).mul(4)).add(density(h1, air.mieHeight)).div(6)
    const depth = vec3(air.rayleighScattering).mul(rayleigh).add(vec3(air.mieExtinction).mul(mie)).mul(dKm).mul(aerialDensity)
    const T = exp(depth.negate())
    // The whole ray's transmittance: to the top of the air, or to the ground.
    const ground = toGround(dirEnu)
    const T_far = select(ground.hit, ground.transmittance, transmittanceAt(r0, mu0))
    const share = min(vec3(1).sub(T).div(max(vec3(1).sub(T_far), vec3(1e-3))), vec3(1))
    return { transmittance: T, inscatter: skyRadiance(dirEnu).mul(share).mul(radianceScale) }
  }

  // ---------------------------------------------------------------- background
  let clouds: SkyCloudSource | null = null
  let version = 0
  // Built inside an Fn: the ground term below is a conditional statement, which needs a
  // function body to live in.
  const background = (dirEnu: any, withSun: boolean) => Fn(() => {
    const sky = skyRadiance(dirEnu).toVar()
    // Below the horizon: the hazed ground, lit by the sun and the sky (the far plane clips the
    // globe, and a hole in the imagery must not show sky colour through the map).
    const ground = toGround(dirEnu)
    If(ground.hit, () => {
      sky.addAssign(ground.transmittance.mul(vec3(air.groundAlbedo)).mul(vec3(groundIrradiance)).mul(1 / PI))
    })
    let colour: any = sky
    let sunVisible: any = float(1)
    if (clouds) {
      const c = clouds.sample(dirEnu)
      colour = sky.mul(float(1).sub(c.skyOcclusion)).add(c.radiance)
      sunVisible = float(1).sub(c.sunOcclusion)
    }
    if (withSun) {
      const cosTheta = dot(dirEnu, sunDirection)
      // The angle from the sun's centre, precise for the small angles the disc spans.
      const theta = asin(min(length(dirEnu.sub(sunDirection)).mul(0.5), 1)).mul(2)
      const viewT = select(ground.hit, vec3(0), transmittanceAt(cameraRadius, dot(dirEnu, cameraUp)))
      const edge = max(sunSharpness.mul(pixelAngle), 1e-6)
      const mask = float(1).sub(smoothstep(sunRadius.sub(edge.mul(0.5)), sunRadius.add(edge.mul(0.5)), theta))
      // Limb darkening (Hestroffer & Magnan 1998): I(μ) = 1 − u(1 − μ^0.8), normalised so the
      // disc still integrates to the sun's illuminance.
      const x = clamp(theta.div(sunRadius), 0, 1)
      const muLimb = sqrt(max(x.mul(x).oneMinus(), 0))
      const limb = float(1).sub(sunLimb.mul(float(1).sub(pow(muLimb, 0.8))))
      const limbMean = float(1).sub(sunLimb.mul(0.8 / 2.8))
      const solidAngle = sunRadius.mul(sunRadius).mul(PI)
      const disc = viewT.mul(mask).mul(limb.div(limbMean)).div(solidAngle).mul(sunIntensity)
      const glow = viewT.mul(henyeyGreenstein(cosTheta, sunGlowG)).mul(sunGlow).mul(sunIntensity)
      const sunLight = min(disc.mul(radianceScale), vec3(sunMax)).mul(sunVisible)
        .add(glow.mul(radianceScale).mul(sunVisible.mul(0.5).add(0.5)))
      return colour.mul(radianceScale).add(sunLight.mul(vec3(sunTint))).add(vec3(nightSky))
    }
    return colour.mul(radianceScale).add(vec3(nightSky))
  })()

  // ---------------------------------------------------------------- capture
  // Eight texels: 0 the sky's irradiance on a horizontal surface at the ground, 1 the mean
  // radiance of the upper sky, 2 the sun's transmittance through the clouds seen from the
  // survey, 3 its mean over the surroundings, 4 the clear sky's mean radiance (no clouds: what
  // lights the clouds' own tops). One fragment each, a 16 × 32 grid of directions over the
  // upper hemisphere.
  const captureTarget = new RenderTarget(8, 1, { type: THREE.FloatType, depthBuffer: false })
  captureTarget.texture.minFilter = captureTarget.texture.magFilter = THREE.NearestFilter
  const buildCaptureNode = () => Fn(() => {
    const index = uv().x.mul(8).floor()
    const irradiance = vec3(0).toVar()
    const mean = vec3(0).toVar()
    const clearMean = vec3(0).toVar()
    const rows = 16
    const columns = 32
    Loop(rows, columns, ({ i, j }: { i: any; j: any }) => {
      // Elevation by equal solid angle bands: sin(el) uniform in (0, 1].
      const sinEl = float(i).add(0.5).div(rows)
      const cosEl = sqrt(sinEl.mul(sinEl).oneMinus())
      const az = float(j).add(0.5).div(columns).mul(2 * PI)
      const dir = vec3(cosEl.mul(cos(az)), cosEl.mul(sin(az)), sinEl)
      clearMean.addAssign(clearGroundSkyRadiance(dir))
      let L: any = groundSkyRadiance(dir)
      if (clouds) {
        const c = clouds.captureSample(dir)
        L = L.mul(float(1).sub(c.skyOcclusion)).add(c.radiance)
      }
      // Each sample stands for 2π / (rows · columns) sr.
      irradiance.addAssign(L.mul(sinEl))
      mean.addAssign(L)
    })
    const dOmega = (2 * PI) / (rows * columns)
    let sunThrough: any = float(1)
    let sunMean: any = float(1)
    if (clouds) {
      sunThrough = float(1).sub(clouds.captureSample(sunDirection).sunOcclusion)
      sunMean = clouds.captureMeanSunTransmittance()
    }
    return select(index.lessThan(0.5), vec4(irradiance.mul(dOmega), 1),
      select(index.lessThan(1.5), vec4(mean.div(rows * columns), 1),
        select(index.lessThan(2.5), vec4(sunThrough, sunThrough, sunThrough, 1),
          select(index.lessThan(3.5), vec4(sunMean, sunMean, sunMean, 1), vec4(clearMean.div(rows * columns), 1)))))
  })()

  // ---------------------------------------------------------------- passes
  const passes = {
    transmittance: makePass(transmittanceNode),
    multi: makePass(multiNode),
    skyA: makePass(skyViewNode(cameraRadius, 'A', SKY_VIEW_SIZE, 30, dot(sunDirection, cameraUp))),
    skyB: makePass(skyViewNode(cameraRadius, 'B', SKY_VIEW_SIZE, 30, dot(sunDirection, cameraUp))),
    groundA: makePass(skyViewNode(groundRadius, 'A', GROUND_VIEW_SIZE, 24, sunDirection.z)),
    groundB: makePass(skyViewNode(groundRadius, 'B', GROUND_VIEW_SIZE, 24, sunDirection.z)),
    capture: makePass(buildCaptureNode()),
  }
  const draw = (pass: { quad: QuadMesh }, target: RenderTarget) => {
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    pass.quad.render(renderer)
    renderer.setRenderTarget(previous)
  }

  // ---------------------------------------------------------------- per frame
  let tablesDirty = true
  let captureDirty = true
  let captureInFlight = false
  let lastCaptureMs = -Infinity
  const lastCaptureSun = new THREE.Vector3()
  const light: SkyLight = {
    sun: new THREE.Color(1, 1, 1),
    sky: new THREE.Color(0.2, 0.22, 0.25),
    skyMean: new THREE.Color(0.2, 0.22, 0.25),
    sunThroughClouds: 1,
    cloudSunMean: 1,
    clearSkyMean: [0.05, 0.055, 0.065],
    illuminanceScale: 1,
    sunElevation: Math.PI / 3,
  }
  // Relative units, before the exposure: what the capture last measured.
  const capturedSky: Rgb = [0.15, 0.17, 0.2]
  const capturedMean: Rgb = [0.05, 0.055, 0.065]
  let adaptation = 1
  const readCapture = async () => {
    captureInFlight = true
    try {
      const pixels = await renderer.readRenderTargetPixelsAsync(captureTarget, 0, 0, 8, 1) as Float32Array
      if (pixels && pixels.length >= 20 && Number.isFinite(pixels[0])) {
        capturedSky[0] = pixels[0]; capturedSky[1] = pixels[1]; capturedSky[2] = pixels[2]
        capturedMean[0] = pixels[4]; capturedMean[1] = pixels[5]; capturedMean[2] = pixels[6]
        light.sunThroughClouds = THREE.MathUtils.clamp(pixels[8], 0, 1)
        light.cloudSunMean = THREE.MathUtils.clamp(pixels[12], 0, 1)
        light.clearSkyMean = [pixels[16], pixels[17], pixels[18]]
      }
    } catch {
      // A lost device or a disposed target: keep the last values.
    } finally {
      captureInFlight = false
    }
  }

  const applyParams = () => {
    sunIntensity.value = params.sunIntensity
    sunRadius.value = SUN_ANGULAR_RADIUS * Math.max(params.sunSize, 0.05)
    sunSharpness.value = Math.max(params.sunSharpnessPx, 0.25)
    sunLimb.value = THREE.MathUtils.clamp(params.sunLimbDarkening, 0, 1)
    sunGlow.value = Math.max(params.sunGlow, 0)
    // 0 → g 0.995 (tight), 1 → g 0.8 (wide).
    sunGlowG.value = 0.995 - 0.195 * THREE.MathUtils.clamp(params.sunGlowSize, 0, 1)
    sunTint.value.copy(params.sunTint)
    sunMax.value = Math.max(params.sunMaxRadiance, 1)
    aerialStart.value = Math.max(params.aerialStartM, 0)
    aerialDensity.value = Math.max(params.aerialDensity, 0)
    skyBrightness.value = Math.max(params.skyBrightness, 0)
  }
  // The colour the white balance divides out: the noon (60°) sun's at the ground.
  const balance = new THREE.Vector3(1, 1, 1)
  const applyBalance = () => {
    const sun = sunIlluminance(model, 0, PI / 3)
    const lum = luminance(sun)
    const k = THREE.MathUtils.clamp(params.whiteBalance, 0, 1)
    balance.set(...sun.map((c) => Math.pow(lum / Math.max(c, 1e-4), k)) as Rgb)
  }

  const scratchSun = new THREE.Vector3()
  const layer: SkyAtmosphere = {
    params,
    light,
    get version() { return version },
    nodes: {
      toEnu: (dirWorld: any) => normalize(worldToEnu.mul(dirWorld)),
      skyRadiance,
      transmittance: transmittanceAt,
      aerial,
      background,
      sunDirection,
      radianceScale,
      cameraRadius,
      air,
      miePhase,
      multiScattering: multiScatteringAt,
      airTransmittance,
    },
    textures: {
      transmittance: transmittanceTarget.texture,
      multiScattering: multiTarget.texture,
      skyViewA: skyViewA.texture,
      skyViewB: skyViewB.texture,
    },
    setAtmosphere(next) {
      settings = JSON.parse(JSON.stringify(next))
      model = atmosphereParameters(settings)
      referenceE = referenceIlluminance(model)
      writeAir()
      tablesDirty = true
      captureDirty = true
    },
    getAtmosphere: () => JSON.parse(JSON.stringify(settings)),
    setClouds(source) {
      if (source === clouds) return
      clouds = source
      version++
      // The capture integrates the clouds too.
      const material = passes.capture.quad.material as NodeMaterial
      material.fragmentNode = buildCaptureNode()
      material.needsUpdate = true
      captureDirty = true
      if (!source) { light.sunThroughClouds = 1; light.cloudSunMean = 1 }
    },
    invalidateCapture() { captureDirty = true },
    async debugRead(table) {
      const target = { transmittance: transmittanceTarget, multi: multiTarget, skyA: skyViewA, skyB: skyViewB, groundA: groundViewA, capture: captureTarget }[table]
      const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height)
      return { width: target.width, height: target.height, data }
    },
    update(input) {
      applyParams()
      worldToEnu.value.copy(input.worldToEnu)
      // The geodetic normal at the camera, rotated into the survey's ENU frame.
      const c = input.cameraEcef
      scratchUp.set(c.x / (WGS84_A * WGS84_A), c.y / (WGS84_A * WGS84_A), c.z / (WGS84_B * WGS84_B)).normalize()
        .applyMatrix3(input.worldToEnu).normalize()
      if (Number.isFinite(scratchUp.x)) cameraUp.value.copy(scratchUp)
      scratchSun.copy(input.sunDirectionEnu).normalize()
      sunDirection.value.copy(scratchSun)
      const heightM = ellipsoidHeight(input.cameraEcef.x, input.cameraEcef.y, input.cameraEcef.z)
      const groundKm = Math.max(input.groundAltitudeM, 0) / 1000
      groundRadius.value = model.bottomRadiusKm + groundKm
      // The rendered ground is the ellipsoid itself, so the camera can never be under it.
      cameraRadius.value = model.bottomRadiusKm + Math.max(heightM / 1000, groundKm + 0.002)
      pixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(input.fovDeg) / 2)) / Math.max(input.bufferHeightPx, 1)

      if (tablesDirty) {
        tablesDirty = false
        draw(passes.transmittance, transmittanceTarget)
        draw(passes.multi, multiTarget)
      }
      draw(passes.skyA, skyViewA)
      draw(passes.skyB, skyViewB)

      // Ground sky and capture: when the sun has moved, the air changed or the clouds were
      // re-baked; at most four times a second, never two readbacks at once.
      const now = performance.now()
      if (lastCaptureSun.angleTo(scratchSun) > 0.002) captureDirty = true
      if (captureDirty && !captureInFlight && now - lastCaptureMs > 250) {
        captureDirty = false
        lastCaptureMs = now
        lastCaptureSun.copy(scratchSun)
        draw(passes.groundA, groundViewA)
        draw(passes.groundB, groundViewB)
        draw(passes.capture, captureTarget)
        void readCapture()
      }

      // Light, CPU side.
      const elevation = Math.asin(THREE.MathUtils.clamp(scratchSun.z, -1, 1))
      light.sunElevation = elevation
      const sun = sunIlluminance(model, groundKm, elevation)
      const sunOnGround = Math.max(scratchSun.z, 0)
      const through = clouds ? light.sunThroughClouds : 1
      const eActual = luminance(sun) * sunOnGround * through + luminance(capturedSky)
      // Under clouds the exposure adapts to a blend, geometric so it is an EV share, of the
      // clear sky's illuminance (the sky's mean radiance × π) and the actual one.
      const eClear = clouds ? luminance(sun) * sunOnGround + PI * luminance(light.clearSkyMean) : eActual
      const weather = THREE.MathUtils.clamp(params.weatherAdaptation, 0, 1)
      const eNow = Math.pow(Math.max(eClear, 1e-6), 1 - weather) * Math.pow(Math.max(eActual, 1e-6), weather)
      // Adapt toward the reference, compressed; eased over about a second.
      const targetAdaptation = THREE.MathUtils.clamp(
        Math.pow(referenceE / Math.max(eNow, 1e-6), THREE.MathUtils.clamp(params.adaptation, 0, 1)),
        1, Math.max(params.adaptationMax, 1))
      const ease = 1 - Math.exp(-Math.max(input.deltaS, 0) / 0.8)
      adaptation = Number.isFinite(adaptation) ? adaptation + (targetAdaptation - adaptation) * ease : targetAdaptation
      const K = (params.exposure / referenceE) * adaptation
      light.illuminanceScale = K
      applyBalance()
      const [bR, bG, bB] = [balance.x * K, balance.y * K, balance.z * K]
      radianceScale.value.set(PI * bR, PI * bG, PI * bB)
      light.sun.setRGB(sun[0] * bR, sun[1] * bG, sun[2] * bB)
      light.sky.setRGB(capturedSky[0] * bR, capturedSky[1] * bG, capturedSky[2] * bB)
      light.skyMean.setRGB(capturedMean[0] * PI * bR, capturedMean[1] * PI * bG, capturedMean[2] * PI * bB)
      groundIrradiance.value.set(
        sun[0] * sunOnGround * through + capturedSky[0],
        sun[1] * sunOnGround * through + capturedSky[1],
        sun[2] * sunOnGround * through + capturedSky[2],
      )
      // Night: the sky fades to the configured floor as the sun sinks below −2° … −12°.
      const night = 1 - THREE.MathUtils.smoothstep(elevation, THREE.MathUtils.degToRad(-12), THREE.MathUtils.degToRad(-2))
      nightSky.value.copy(params.nightSky).multiplyScalar(night)
      // Under the clouds only their diffuse share lights the haze; eased, it follows a re-bake.
      const wanted = clouds ? light.cloudSunMean + (1 - light.cloudSunMean) * THREE.MathUtils.clamp(params.overcastGlow, 0, 1) : 1
      cloudLight.value += (wanted - cloudLight.value) * (1 - Math.exp(-Math.max(input.deltaS, 0) / 0.5))
    },
    dispose() {
      for (const pass of Object.values(passes)) (pass.quad.material as NodeMaterial).dispose()
      for (const target of [transmittanceTarget, multiTarget, skyViewA, skyViewB, groundViewA, groundViewB, captureTarget]) target.dispose()
    },
  }
  writeAir()
  applyParams()
  return layer
}

function makeTarget(width: number, height: number, name: string): RenderTarget {
  const target = new RenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false })
  target.texture.minFilter = THREE.LinearFilter
  target.texture.magFilter = THREE.LinearFilter
  target.texture.wrapS = THREE.ClampToEdgeWrapping
  target.texture.wrapT = THREE.ClampToEdgeWrapping
  target.texture.generateMipmaps = false
  target.texture.name = name
  return target
}

function makePass(node: any): { quad: QuadMesh } {
  const material = new NodeMaterial()
  material.fragmentNode = node
  material.name = 'sky-pass'
  return { quad: new QuadMesh(material) }
}

/** The settings and params the config ships, as mutable copies. */
export function defaultSkyParams(config: {
  exposure: number; adaptation: number; adaptationMax: number; weatherAdaptation: number; sunIntensity: number; sunSize: number
  sunSharpnessPx: number; sunLimbDarkening: number; sunGlow: number; sunGlowSize: number; sunTint: number
  sunMaxRadiance: number; nightSky: number; aerialStartM: number; aerialDensity: number
  whiteBalance: number; skyBrightness: number; overcastGlow: number
}): SkyParams {
  return {
    exposure: config.exposure,
    adaptation: config.adaptation,
    adaptationMax: config.adaptationMax,
    weatherAdaptation: config.weatherAdaptation,
    sunIntensity: config.sunIntensity,
    sunSize: config.sunSize,
    sunSharpnessPx: config.sunSharpnessPx,
    sunLimbDarkening: config.sunLimbDarkening,
    sunGlow: config.sunGlow,
    sunGlowSize: config.sunGlowSize,
    sunTint: new THREE.Color(config.sunTint),
    sunMaxRadiance: config.sunMaxRadiance,
    nightSky: new THREE.Color(config.nightSky),
    aerialStartM: config.aerialStartM,
    aerialDensity: config.aerialDensity,
    whiteBalance: config.whiteBalance,
    skyBrightness: config.skyBrightness,
    overcastGlow: config.overcastGlow,
  }
}
