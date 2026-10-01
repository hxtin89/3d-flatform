// Clouds on the sky dome: volumetric in their light, infinitely far in their geometry.
//
// One cloud field in the survey's ENU frame — a 2D weather map (coverage, cumulus cells, a
// slow type field, a fine field; sky-cloud-noise.ts) times a height profile per cloud type,
// eroded by a tileable 3D Perlin–Worley volume (Schneider's Nubis recipe) — that every pass
// reads the same way, so the clouds you see and the shadows they cast are one thing.
//
// The dome. The field is ray-marched once from a fixed eye at the survey's centre into a
// panorama (latitude–longitude, rows packed toward the horizon by a square root) and the sky
// shows that panorama: per frame the clouds cost one texture read per sky pixel. Clouds do not
// need to move in real time, so the bake can afford what a per-frame march cannot — 48 steps,
// six cone samples toward the sun plus one far one, Wrenninge's multiple-scattering octaves,
// the droplets' own Mie phase (Jendersie & d'Eon, as the fog), the atmosphere's sun
// transmittance at each sample (cloud bases redden at sunset while the tops stay lit), sky and
// ground ambient, rain shafts under the dense cells, a thin high layer — and spreads it over
// `bakeFrames` frames in strips (scissored fragment passes, so the WebGL2 fallback bakes it
// too), into the back of three panoramas: the newest finished one cross-fades over the one
// before while the third bakes (Ghost of Tsushima's scheme). It re-bakes when the sun has moved
// half a degree, the preset changed or a setting moved.
//
// Seen from elsewhere than the eye. The panorama is looked up through a shell at the clouds'
// mid height: the view ray is cut with it and the direction from the eye to that point is what
// is read, so the dome's clouds stay over the ground their shadows fall on while the camera
// moves (Lagarde's proxy-geometry trick). Above the cloud base the dome fades: a sky dome
// cannot show clouds below the camera.
//
// What the panorama stores: the clouds' light, premultiplied and already dimmed by the haze in
// front of them (aerial perspective at their transmittance-weighted distance), and their
// opacity seen through that haze. The sky composites `sky · (1 − a) + C`; the sun disc is
// hidden by the opacity before the haze, recovered by dividing the haze back out.
//
// Shadows. A second, small bake: for every point of the cloud base the optical depth up to the
// sun through the layer, mipmapped. A receiver — a point, the basemap, a fog sample —
// projects itself along the sun onto the base and reads it: one fetch, no march.
import * as THREE from 'three'
import { NodeMaterial, QuadMesh, RenderTarget } from 'three/webgpu'
import * as TSL from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'
import { miePhaseParameters, multipleScatteringOctaves } from './fog-optics'
import { createCloudNoiseBaker } from './sky-cloud-noise'
import type { SkyAtmosphere, SkyCloudSource } from './sky-atmosphere'

const {
  Fn, If, Loop, Break, abs, atan, clamp, cos, dot, exp, float, int, length, max, min, mix, normalize,
  pow, renderGroup, select, sin, smoothstep, sqrt, texture, texture3D, uniform, uv, vec2, vec3, vec4,
} = TSL as any

const CONFIG = EXPERIENCE_CONFIG.skyClouds
const PI = Math.PI

/** One weather situation: what the presets set and the panel tunes. Lengths in km. */
export interface CloudLook {
  /** Share of the sky the low layer may cover, 0–1. */
  coverage: number
  /** How strongly the cumulus cells clump that cover, 0–1. */
  cells: number
  /** 0 flat stratus, 0.5 cumulus, 1 towering cumulonimbus; varied across the sky by `typeVariation`. */
  type: number
  typeVariation: number
  baseKm: number
  thicknessKm: number
  /** Extinction at full density, per km (fair cumulus 20–60). */
  densityPerKm: number
  /** Erosion of the edges by the fine 3D noise, 0–1: higher is wispier. */
  erosion: number
  /** Size of the 3D billows and of the weather map's tile. */
  shapeScaleKm: number
  weatherScaleKm: number
  /** Share of the light the droplets absorb: 0 white clouds, ~0.3 dark rain clouds. */
  absorption: number
  /** Rain shafts under the dense cells, 0–1. */
  precipitation: number
  /** Cumulonimbus anvils: how far the tops spread, 0–1. */
  anvil: number
  /** The thin high layer (altocumulus, cirrus): coverage, altitude, optical depth. */
  highCoverage: number
  highAltitudeKm: number
  highDepth: number
  /** Where in the field the survey sits, km: a different patch of the same weather. */
  offsetKm: [number, number]
  /** The haze that comes with the weather (aerosol optical depth at 550 nm). */
  aerosolDepth: number
}

export interface SkyCloudParams {
  enabled: boolean
  preset: string
  look: CloudLook
  /** Panorama size, steps along each ray, frames a bake is spread over. */
  bakeWidth: number
  bakeHeight: number
  bakeSteps: number
  bakeFrames: number
  /** Cross-fade between two finished bakes, seconds. */
  fadeSeconds: number
  /** Multipliers on the clouds' sun and sky light, and the silver lining's sharpness. */
  sunLight: number
  ambient: number
  /** Wrenninge octaves past the first. */
  multipleScattering: number
  /** Edge darkening facing the sun ("powder"), 0–1. */
  powder: number
  /** The deep multiple scattering: the share of the sun a thick cloud's lit side sends back
   *  diffusely, and how fast it fades with optical depth toward the sun. */
  diffuse: number
  diffusePenetration: number
  /** How strongly the cloud above a point hides the sky light from it. */
  ambientOcclusion: number
  /** Share of the air's physical optical depth the clouds are hazed with: 1 is the
   *  atmosphere's own, lower keeps distant towers standing out over the haze. */
  haze: number
  /** Cloud shadows: optical-depth multiplier and mip bias (softness). */
  shadowStrength: number
  shadowSoftness: number
}

export interface SkyClouds extends SkyCloudSource {
  readonly params: SkyCloudParams
  readonly ready: boolean
  /** Per frame: the camera, for the parallax-corrected lookup and the altitude fade. */
  update(input: { cameraEnuKm: THREE.Vector3; groundAltitudeKm: number; sunDirectionEnu: THREE.Vector3; deltaS: number }): void
  /** Apply a preset by name (its look and haze); returns the look. */
  applyPreset(name: string): CloudLook | null
  presets(): string[]
  /** Re-bake on the next frame (a setting changed). */
  invalidate(): void
  /** The cloud-shadow optical-depth map, for the debug view. */
  shadowTexture(): THREE.Texture
  bakeProgress(): number
  dispose(): void
}

// ---------------------------------------------------------------- shared shadow nodes
// Module level, like the canopy shadows: tile graphs read them whether or not the layer exists.
/** A 1-texel stand-in with the sampler state of the texture that replaces it: three keeps a
 *  texture node's sampler until the texture's version changes, so a node created on a
 *  default (nearest, clamped) DataTexture would go on sampling its replacement that way. */
function standIn(mips: boolean, repeat: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType)
  t.magFilter = THREE.LinearFilter
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  t.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
  return t
}
const placeholder = standIn(true, false)
const group = (node: any) => node.setGroup(renderGroup)
export const cloudShadow = {
  map: texture(placeholder),
  /** The map's centre and half extent on the cloud base, ENU metres. */
  centre: group(uniform(new THREE.Vector2())),
  half: group(uniform(1e9)),
  /** Altitude of the cloud base in the shader's ENU frame (metres), and the sun there. */
  baseZ: group(uniform(1000)),
  sun: group(uniform(new THREE.Vector3(0, 0, 1))),
  strength: group(uniform(1)),
  lodBias: group(uniform(1)),
  /** 0 while there are no clouds (or the map is not ready): fully lit. */
  fade: group(uniform(0)),
  /** Beyond the map: the sun's mean transmittance over it, not full sun. */
  mean: group(uniform(1)),
}

/** Transmittance of the direct sun through the sky's clouds to an ENU position (metres, the
 *  shader's raw frame). `extraLod` softens further (the fog reads blurrier levels). */
export function cloudTransmittance(enu: any, extraLod: any = null): any {
  const s = cloudShadow.sun
  const sz = max(s.z, 0.05)
  const q = enu.xy.add(s.xy.div(sz).mul(cloudShadow.baseZ.sub(enu.z)))
  const st = q.sub(cloudShadow.centre).div(cloudShadow.half.mul(2)).add(0.5)
  const level = extraLod === null ? cloudShadow.lodBias : cloudShadow.lodBias.add(extraLod)
  const tau = cloudShadow.map.sample(vec2(st.x, st.y.oneMinus())).level(level).r
  const inside = float(1).sub(smoothstep(0.45, 0.5, max(abs(st.x.sub(0.5)), abs(st.y.sub(0.5)))))
  const local = exp(tau.mul(cloudShadow.strength).negate())
  return mix(float(1), mix(cloudShadow.mean, local, inside), cloudShadow.fade)
}

/** The presets from the config, as mutable looks. */
function presetLook(name: string): CloudLook | null {
  const preset = (CONFIG.presets as Record<string, any>)[name]
  return preset ? JSON.parse(JSON.stringify(preset)) as CloudLook : null
}

export function createSkyClouds(opts: { renderer: any; sky: SkyAtmosphere }): SkyClouds {
  const { renderer, sky } = opts
  const nodes = sky.nodes
  const air = nodes.air
  const initial = presetLook(CONFIG.preset) ?? presetLook('fair')!
  const params: SkyCloudParams = {
    enabled: CONFIG.enabled,
    preset: CONFIG.preset,
    look: initial,
    bakeWidth: CONFIG.bakeWidth,
    bakeHeight: CONFIG.bakeHeight,
    bakeSteps: CONFIG.bakeSteps,
    bakeFrames: CONFIG.bakeFrames,
    fadeSeconds: CONFIG.fadeSeconds,
    sunLight: CONFIG.sunLight,
    ambient: CONFIG.ambient,
    multipleScattering: CONFIG.multipleScattering,
    powder: CONFIG.powder,
    diffuse: CONFIG.diffuse,
    diffusePenetration: CONFIG.diffusePenetration,
    ambientOcclusion: CONFIG.ambientOcclusion,
    haze: CONFIG.haze,
    shadowStrength: CONFIG.shadowStrength,
    shadowSoftness: CONFIG.shadowSoftness,
  }

  // ---------------------------------------------------------------- noise
  let ready = false
  // Stand-ins with the final textures' sampler state (see standIn).
  const weatherTexture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
  weatherTexture.wrapS = weatherTexture.wrapT = THREE.RepeatWrapping
  weatherTexture.magFilter = THREE.LinearFilter
  weatherTexture.minFilter = THREE.LinearMipmapLinearFilter
  weatherTexture.needsUpdate = true
  const shapeTexture = new THREE.Data3DTexture(new Uint8Array(2), 1, 1, 1)
  shapeTexture.format = THREE.RGFormat
  shapeTexture.minFilter = shapeTexture.magFilter = THREE.LinearFilter
  shapeTexture.wrapS = shapeTexture.wrapT = shapeTexture.wrapR = THREE.RepeatWrapping
  shapeTexture.unpackAlignment = 1
  shapeTexture.needsUpdate = true
  const weatherNode = texture(weatherTexture)
  const shapeNode = texture3D(shapeTexture, vec3(0), 0)
  const baker = createCloudNoiseBaker()
  void Promise.all([
    baker.bake({ kind: 'weather', size: CONFIG.weatherSize, seed: 11 }),
    baker.bake({ kind: 'shape', size: CONFIG.shapeSize, seed: 7 }),
  ]).then(([weather, shape]) => {
    const w = new THREE.DataTexture(weather, CONFIG.weatherSize, CONFIG.weatherSize, THREE.RGBAFormat, THREE.UnsignedByteType)
    w.wrapS = w.wrapT = THREE.RepeatWrapping
    w.magFilter = THREE.LinearFilter
    w.minFilter = THREE.LinearMipmapLinearFilter
    w.generateMipmaps = true
    w.colorSpace = THREE.NoColorSpace
    w.needsUpdate = true
    weatherNode.value = w
    const s = new THREE.Data3DTexture(shape, CONFIG.shapeSize, CONFIG.shapeSize, CONFIG.shapeSize)
    s.format = THREE.RGFormat
    s.minFilter = s.magFilter = THREE.LinearFilter
    s.wrapS = s.wrapT = s.wrapR = THREE.RepeatWrapping
    s.unpackAlignment = 1
    s.needsUpdate = true
    shapeNode.value = s
    ready = true
    dirty = true
  })

  // ---------------------------------------------------------------- uniforms (bake)
  const u = {
    eyeRadius: uniform(6360.3),
    eyeXY: uniform(new THREE.Vector2()),
    sun: uniform(new THREE.Vector3(0, 0, 1)),
    coverage: uniform(0.3), cells: uniform(0.5), type: uniform(0.5), typeVariation: uniform(0.3),
    base: uniform(1), thickness: uniform(2), density: uniform(30), erosion: uniform(0.5),
    shapeScaleInv: uniform(1 / 4), weatherScaleInv: uniform(1 / 40), albedo: uniform(1),
    precipitation: uniform(0), anvil: uniform(0),
    highCoverage: uniform(0), highAltitude: uniform(6), highDepth: uniform(0.3),
    offset: uniform(new THREE.Vector2()),
    sunLight: uniform(1), ambient: uniform(1), powder: uniform(0.5),
    diffuse: uniform(0.6), diffusePenetration: uniform(0.12), ambientOcclusion: uniform(0.05), haze: uniform(0.65),
    ambientTop: uniform(new THREE.Vector3(0.05, 0.06, 0.08)),
    groundRadiance: uniform(new THREE.Vector3(0.02, 0.025, 0.02)),
    steps: uniform(48, 'int'),
    gHG: uniform(0.98), gD: uniform(0.5), alpha: uniform(20), wD: uniform(0.48),
    rowsFrom: uniform(0),
  }
  const phaseOf = () => {
    const p = miePhaseParameters(15)
    u.gHG.value = p.gHG; u.gD.value = p.gD; u.alpha.value = p.alpha; u.wD.value = p.wD
  }
  phaseOf()

  // ---------------------------------------------------------------- the field
  const hg = (c: any, g: any) => {
    const g2 = g.mul(g)
    const d = g2.add(1).sub(g.mul(c).mul(2))
    return g2.oneMinus().div(pow(max(d, 1e-6), 1.5).mul(4 * PI))
  }
  const draine = (c: any, g: any, a: any) => {
    const g2 = g.mul(g)
    const d = g2.add(1).sub(g.mul(c).mul(2))
    return g2.oneMinus().mul(a.mul(c).mul(c).add(1))
      .div(pow(max(d, 1e-6), 1.5).mul(4 * PI).mul(a.mul(g2.mul(2).add(1)).div(3).add(1)))
  }
  const cloudPhase = (c: any, scale: number) => mix(hg(c, u.gHG.mul(scale)), draine(c, u.gD.mul(scale), u.alpha), u.wD)

  /** Weather at a planet-centred point (km, the eye on the z axis): coverage field, type,
   *  and the fine field. */
  const weatherAt = (p: any) => {
    const st = p.xy.add(u.eyeXY).add(u.offset).mul(u.weatherScaleInv)
    const w = weatherNode.sample(st).level(0)
    const type = clamp(u.type.add(w.z.sub(0.5).mul(u.typeVariation).mul(2)), 0, 1)
    // The coverage fBm and the cumulus cells blended, then cut at the level that leaves about
    // `coverage` of the sky inside: both are bell-shaped around 0.5 after the bake's stretch,
    // so the cut sits at 1 − coverage with a soft band either side.
    const value = mix(w.x, w.y, u.cells.mul(0.6))
    const cut = u.coverage.oneMinus()
    const field = smoothstep(cut.sub(0.16), cut.add(0.12), value)
    return { field, type, fine: w.w, raw: w }
  }
  /** Extinction (per km) at a planet-centred point; `detail` adds the fine erosion. */
  const densityAt = (p: any, detail: boolean) => {
    const h = length(p).sub(air.bottom)
    const w = weatherAt(p)
    const top = u.thickness.mul(mix(float(0.35), float(1), w.type))
    const hf = h.sub(u.base).div(max(top, 0.05))
    const bottom = smoothstep(0, mix(float(0.18), float(0.05), w.type), hf)
    const roof = float(1).sub(smoothstep(mix(float(0.45), float(0.85), w.type), 1, hf))
    // Anvils: the tallest cells spread near their top.
    const anvil = smoothstep(0.7, 0.92, hf).mul(u.anvil).mul(smoothstep(0.6, 1, w.type)).mul(0.6)
    const envelope = clamp(w.field.add(anvil), 0, 1).mul(bottom).mul(roof).toVar()
    const n = shapeNode.sample(p.mul(u.shapeScaleInv)).r
    // Schneider's erosion: the envelope sets how much of the billow noise survives. Stratus
    // fills its envelope instead: a deck, not a field of puffs.
    let shaped: any = clamp(n.sub(envelope.oneMinus()).div(max(envelope, 0.05)), 0, 1).mul(envelope)
    shaped = mix(shaped, envelope.mul(n.mul(0.4).add(0.6)), smoothstep(0.35, 0, w.type).mul(0.85))
    if (detail) {
      const d = shapeNode.sample(p.mul(u.shapeScaleInv.mul(4.3))).g
      // Wispy at the base, billowy higher up.
      const modifier = mix(d.oneMinus(), d, clamp(hf.mul(4), 0, 1))
      shaped = clamp(shaped.sub(modifier.mul(u.erosion).mul(0.35)).div(max(float(1).sub(modifier.mul(u.erosion).mul(0.35)), 0.05)), 0, 1)
    }
    return { sigma: shaped.mul(u.density), hf, type: w.type, field: w.field, fine: w.fine }
  }

  /** The high layer's cover at a planet-centred point on its shell. */
  const highCoverAt = (p: any) => {
    const w = weatherNode.sample(p.xy.add(u.eyeXY).add(u.offset).mul(u.weatherScaleInv.mul(2.7)).add(0.37)).level(0)
    return clamp(w.w.mul(0.6).add(w.x.mul(0.4)).sub(u.highCoverage.oneMinus()).div(max(u.highCoverage, 0.04)), 0, 1)
  }
  /** Optical depth of the high layer between a point below it and the sun: where the sun ray
   *  crosses the sheet, its cover times its depth along the slant. An anvil or an overcast
   *  sheet shades everything under it — the low clouds and the ground. */
  const highDepthToSun = (p: any) => {
    const h = length(p).sub(air.bottom)
    const sz = max(u.sun.z, 0.05)
    const crossing = p.add(u.sun.mul(max(u.highAltitude.sub(h), 0).div(sz)))
    return highCoverAt(crossing).mul(u.highDepth).div(sz).mul(select(u.highCoverage.greaterThan(0.001), float(1), float(0)))
  }

  // ---------------------------------------------------------------- the dome bake
  const octaves = multipleScatteringOctaves(Math.max(0, Math.round(CONFIG.multipleScattering)))
  const bakeNode = Fn(() => {
    const st = uv()
    const azimuth = st.x.sub(0.5).mul(2 * PI)
    const elevation = st.y.mul(st.y).mul(PI / 2)
    const dir = vec3(sin(azimuth).mul(cos(elevation)), cos(azimuth).mul(cos(elevation)), sin(elevation)).toVar()
    const eye = vec3(0, 0, u.eyeRadius)
    const b = dot(eye, dir)
    const exitOf = (radius: any) => b.negate().add(sqrt(max(b.mul(b).sub(dot(eye, eye)).add(radius.mul(radius)), 0)))
    const rBase = air.bottom.add(u.base)
    const rTop = air.bottom.add(u.base).add(u.thickness)
    const tStart = exitOf(rBase).toVar()
    const tEnd = min(exitOf(rTop), tStart.add(CONFIG.maxSlabKm)).toVar()
    const cosTheta = dot(dir, u.sun)
    const phases = octaves.map((o) => cloudPhase(cosTheta, o.anisotropy).mul(o.scattering))
    const extinctionScales = octaves.map((o) => o.extinction)
    const light = vec3(0).toVar()
    const transmittance = float(1).toVar()
    const weighted = float(0).toVar()
    // Rays toward the horizon cross tens of kilometres of the layer: up to twice the steps there.
    const rowSteps = int(float(u.steps).mul(mix(float(2), float(1), smoothstep(0, 0.5, st.y)))).toVar()
    const dt = tEnd.sub(tStart).div(float(rowSteps)).toVar()
    // A fixed per-texel offset. White noise, not interleaved gradient noise: IGN is built to be
    // averaged over frames, and baked once its regular lattice shows as a honeycomb.
    const jitter = TSL.fract(sin(dot(TSL.screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453))
    Loop({ start: int(0), end: rowSteps, type: 'int', condition: '<' }, ({ i }: { i: any }) => {
      const t = tStart.add(float(i).add(jitter).mul(dt)).toVar()
      const p = eye.add(dir.mul(t)).toVar()
      const sample = densityAt(p, true)
      const sigma = sample.sigma.toVar()
      If(sigma.greaterThan(0.001), () => {
        // Toward the sun: six cone samples growing outward, plus one far away for the shadow
        // of distant towers. Optical depth only (the cheap density, no detail erosion).
        const tau = float(0).toVar()
        const lightStep = u.thickness.mul(0.08)
        let distance = 0
        for (let k = 0; k < 6; k++) {
          const span = 1 + k * 0.6
          const at = distance + span * 0.5
          distance += span
          tau.addAssign(densityAt(p.add(u.sun.mul(lightStep.mul(at))), false).sigma.mul(lightStep.mul(span)))
        }
        tau.addAssign(densityAt(p.add(u.sun.mul(u.thickness.mul(1.6))), false).sigma.mul(u.thickness.mul(0.5)))
        const pr = length(p)
        const muSun = dot(p, u.sun).div(pr)
        const sunT = nodes.transmittance(pr, muSun).mul(exp(highDepthToSun(p).negate()))
        let sunScatter: any = float(0)
        phases.forEach((phase, k) => {
          sunScatter = sunScatter.add(exp(tau.mul(-extinctionScales[k])).mul(phase))
        })
        // The light that has bounced so often inside the cloud it forgets the sun's direction:
        // Wrenninge's few octaves cannot carry it (a cumulus scatters hundreds of times), so it
        // enters as two-stream diffusion (Stephens): what still reaches a point through an
        // optical depth τ toward the sun falls off as 2 / (2 + (1 − g)τ), not e^(−τ) — slowly,
        // which is why an overcast's underside is grey rather than black and only a storm's
        // hundreds of optical depths make its base dark. Isotropic, scaled by the lit side's
        // diffuse reflectance.
        sunScatter = sunScatter.add(float(2).div(tau.mul(u.diffusePenetration).add(2)).mul(u.diffuse).mul(1 / PI))
        // Powder: edges facing the sun darken (Schneider), fading as the view turns away.
        const powder = mix(float(1), float(1).sub(exp(sigma.mul(-2.5))).mul(2), u.powder.mul(cosTheta.mul(-0.5).add(0.5)))
        // Sky light from above, ground light from below; occluded by the cloud above the
        // sample, a rough 1 / (1 + k σ depth) so thick towers have dark cores and bases.
        const depthAbove = max(u.thickness.mul(mix(float(0.35), float(1), sample.type)).add(u.base).sub(length(p).sub(air.bottom)), 0)
        const occlusion = float(1).div(sigma.mul(depthAbove).mul(u.ambientOcclusion).add(1))
        const ambient = mix(vec3(u.groundRadiance), vec3(u.ambientTop).mul(occlusion), sqrt(clamp(sample.hf, 0, 1)))
        const inScatter = sunT.mul(sunScatter.mul(powder).mul(u.sunLight)).add(ambient.mul(u.ambient)).mul(u.albedo)
        const stepT = exp(sigma.mul(dt).negate())
        // Energy-conserving step (Hillaire 2015): σs·L·(1 − e^(−σ dt)) / σ, σs = σ·albedo.
        light.addAssign(inScatter.mul(stepT.oneMinus()).mul(transmittance))
        weighted.addAssign(transmittance.mul(stepT.oneMinus()).mul(t))
        transmittance.mulAssign(stepT)
      })
      If(transmittance.lessThan(0.01), () => { Break() })
    })
    // Rain shafts: below the base under dense cells, a thin grey medium in vertical streaks,
    // lit by what the clouds above let through and by the sky.
    If(u.precipitation.greaterThan(0.001), () => {
      const rainSteps = 10
      const rainDt = tStart.div(rainSteps)
      Loop({ start: int(0), end: int(rainSteps), type: 'int', condition: '<', name: 'r' }, ({ r }: { r: any }) => {
        const t = float(r).add(0.5).mul(rainDt)
        const p = eye.add(dir.mul(t))
        const w = weatherAt(p)
        const h = length(p).sub(air.bottom)
        const streak = smoothstep(0.45, 0.8, w.fine)
        const sigma = w.field.mul(w.field).mul(streak).mul(u.precipitation).mul(CONFIG.rainDensityPerKm)
          .mul(float(1).sub(smoothstep(u.base.mul(0.7), u.base, h)))
        const stepT = exp(sigma.mul(rainDt).negate())
        const lit = vec3(u.ambientTop).mul(u.ambient).mul(0.8)
        light.addAssign(lit.mul(stepT.oneMinus()).mul(transmittance))
        weighted.addAssign(transmittance.mul(stepT.oneMinus()).mul(t))
        transmittance.mulAssign(stepT)
      })
    })
    // The high layer: one thin sheet, lit analytically.
    If(u.highCoverage.greaterThan(0.001).and(transmittance.greaterThan(0.01)), () => {
      const tHigh = exitOf(air.bottom.add(u.highAltitude))
      const p = eye.add(dir.mul(tHigh))
      const cover = highCoverAt(p)
      const slant = min(float(1).div(max(dir.z, 0.03)), 12)
      const tau = cover.mul(u.highDepth).mul(slant)
      const pr = length(p)
      const sunT = nodes.transmittance(pr, dot(p, u.sun).div(pr))
      const scatter = sunT.mul(cloudPhase(cosTheta, 0.6).mul(u.sunLight)).add(vec3(u.ambientTop).mul(u.ambient))
      const stepT = exp(tau.negate())
      light.addAssign(scatter.mul(stepT.oneMinus()).mul(transmittance))
      weighted.addAssign(transmittance.mul(stepT.oneMinus()).mul(tHigh))
      transmittance.mulAssign(stepT)
    })
    const alpha = transmittance.oneMinus()
    // Aerial perspective at the clouds' transmittance-weighted distance from the eye.
    const meanDistance = weighted.div(max(alpha, 1e-4))
    const haze = pow(nodes.airTransmittance(u.eyeRadius, dir.z, meanDistance), vec3(u.haze))
    const hazeGrey = haze.x.add(haze.y).add(haze.z).div(3)
    return vec4(light.mul(haze), alpha.mul(hazeGrey))
  })()

  // ---------------------------------------------------------------- the shadow bake
  // Square map on the cloud base, ENU metres around `shadowCentre`; R = optical depth from the
  // base up to the sun through the layer.
  const shadowSize = CONFIG.shadowSize
  const shadowCentre = uniform(new THREE.Vector2())
  const shadowHalf = uniform(16_000)
  const shadowNode = Fn(() => {
    const st = uv()
    const q = shadowCentre.add(vec2(st.x.sub(0.5), st.y.oneMinus().sub(0.5)).mul(shadowHalf.mul(2)))
    // The base point in the planet-centred frame the field lives in (km, eye on the z axis).
    const start = vec3(q.sub(u.eyeXY.mul(1000)).div(1000), air.bottom.add(u.base))
    const sz = max(u.sun.z, 0.05)
    const span = min(u.thickness.div(sz), CONFIG.maxSlabKm)
    const steps = 24
    const dt = span.div(steps)
    const tau = float(0).toVar()
    Loop(steps, ({ i }: { i: any }) => {
      const p = start.add(u.sun.mul(float(i).add(0.5).mul(dt)))
      tau.addAssign(densityAt(p, false).sigma.mul(dt))
    })
    return vec4(tau.add(highDepthToSun(start)), 0, 0, 1)
  })()

  // ---------------------------------------------------------------- targets
  // Three panoramas with fixed roles: the bake writes `back`, a finished bake is copied into
  // `current` after `current` is copied into `previous`, and the sky fades from one to the
  // other. Fixed because swapping a texture node between render targets does not reach its
  // GPU binding in r185 (measured: the sky went on showing the old panorama); a size change
  // resizes the same targets instead of replacing them.
  const panoramaSize = group(uniform(new THREE.Vector2(2048, 768)))
  const makePanorama = (name: string): RenderTarget => {
    const target = new RenderTarget(Math.max(64, Math.round(params.bakeWidth)), Math.max(32, Math.round(params.bakeHeight)),
      { type: THREE.HalfFloatType, depthBuffer: false })
    const t = target.texture
    t.name = name
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.ClampToEdgeWrapping
    t.minFilter = t.magFilter = THREE.LinearFilter
    t.generateMipmaps = false
    return target
  }
  const previousTarget = makePanorama('sky-clouds-previous')
  const currentTarget = makePanorama('sky-clouds-current')
  const backTarget = makePanorama('sky-clouds-back')
  const panoramas = [previousTarget, currentTarget, backTarget]
  let panoramasCleared = false
  const ensurePanoramas = () => {
    const width = Math.max(64, Math.round(params.bakeWidth))
    const height = Math.max(32, Math.round(params.bakeHeight))
    if (!panoramasCleared || previousTarget.width !== width || previousTarget.height !== height) {
      for (const target of panoramas) target.setSize(width, height)
      panoramaSize.value.set(width, height)
      // Uninitialised texels are whatever the allocation held: clear all three once.
      const previous = renderer.getRenderTarget()
      const clearColour = renderer.getClearColor(new THREE.Color())
      const clearAlpha = renderer.getClearAlpha()
      renderer.setClearColor(0x000000, 0)
      for (const target of panoramas) { renderer.setRenderTarget(target); renderer.clear() }
      renderer.setRenderTarget(previous)
      renderer.setClearColor(clearColour, clearAlpha)
      panoramasCleared = true
      finished = 0
      visible.value = 0
      dirty = true
    }
  }
  const shadowTarget = new RenderTarget(shadowSize, shadowSize, { type: THREE.HalfFloatType, depthBuffer: false })
  shadowTarget.texture.name = 'sky-cloud-shadow'
  shadowTarget.texture.minFilter = THREE.LinearMipmapLinearFilter
  shadowTarget.texture.magFilter = THREE.LinearFilter
  shadowTarget.texture.generateMipmaps = true
  shadowTarget.texture.wrapS = shadowTarget.texture.wrapT = THREE.ClampToEdgeWrapping

  // The tent over the finished bake: wraps in azimuth (the texture repeats), clamps at the
  // horizon and zenith rows.
  const backNode = texture(backTarget.texture)
  const denoiseNode = Fn(() => {
    const st = uv()
    const texel = vec2(1).div(panoramaSize)
    const sum = vec4(0).toVar()
    for (const [dx, dy, w] of [[0, 0, 4], [1, 0, 2], [-1, 0, 2], [0, 1, 2], [0, -1, 2], [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1]]) {
      sum.addAssign(backNode.sample(st.add(texel.mul(vec2(dx, dy)))).level(0).mul(w / 16))
    }
    return sum
  })()
  const denoiseMaterial = new NodeMaterial()
  denoiseMaterial.fragmentNode = denoiseNode
  denoiseMaterial.name = 'sky-clouds-denoise'
  const denoiseQuad = new QuadMesh(denoiseMaterial)
  const bakeMaterial = new NodeMaterial()
  bakeMaterial.fragmentNode = bakeNode
  bakeMaterial.name = 'sky-clouds-bake'
  const bakeQuad = new QuadMesh(bakeMaterial)
  const shadowMaterial = new NodeMaterial()
  shadowMaterial.fragmentNode = shadowNode
  shadowMaterial.name = 'sky-clouds-shadow'
  const shadowQuad = new QuadMesh(shadowMaterial)

  // ---------------------------------------------------------------- display
  const previousNode = texture(previousTarget.texture)
  const currentNode = texture(currentTarget.texture)
  const blend = group(uniform(1))
  const cameraKm = group(uniform(new THREE.Vector3(0, 0, 0.3)))
  const midRadius = group(uniform(6361.5))
  const eyeRadiusShared = group(uniform(6360.3))
  const eyeXYShared = group(uniform(new THREE.Vector2()))
  const altitudeFade = group(uniform(1))
  const visible = group(uniform(0))
  const sunOcclusionHaze = group(uniform(1))
  /** Bakes finished since the panoramas were made: 0 shows nothing, 1 fades the first in. */
  let finished = 0

  /** The panorama's (u, v) for a view ray from the camera, through the mid-height shell. */
  const lookupUv = (dirEnu: any) => {
    // Planet-centred camera, in the frame whose z axis runs through the bake's eye.
    const camera = vec3(cameraKm.xy.sub(eyeXYShared), air.bottom.add(cameraKm.z))
    const b = dot(camera, dirEnu)
    const c = dot(camera, camera).sub(midRadius.mul(midRadius))
    const disc = b.mul(b).sub(c)
    const t = b.negate().add(sqrt(max(disc, 0)))
    const hit = disc.greaterThan(0).and(t.greaterThan(0)).and(c.lessThan(0))
    const point = camera.add(dirEnu.mul(t))
    const fromEye = normalize(point.sub(vec3(0, 0, eyeRadiusShared)))
    const d = select(hit, fromEye, dirEnu)
    const azimuth = atan(d.x, d.y).div(2 * PI).add(0.5)
    const elevation = TSL.asin(clamp(d.z, 0, 1))
    return { st: vec2(azimuth, sqrt(elevation.div(PI / 2))), below: d.z }
  }
  /** Cubic B-spline filtering from four bilinear taps (Sigg & Hadwiger): smooth across the
   *  panorama's texels where bilinear shows their grid in the cloud edges. */
  const bicubic = (node: any, st: any) => {
    const position = st.mul(panoramaSize).sub(0.5)
    const base = TSL.floor(position)
    const f = position.sub(base)
    const f2 = f.mul(f)
    const f3 = f2.mul(f)
    const w0 = float(1).sub(f).pow(3).div(6)
    const w1 = f3.mul(3).sub(f2.mul(6)).add(4).div(6)
    const w2 = f3.mul(-3).add(f2.mul(3)).add(f.mul(3)).add(1).div(6)
    const w3 = f3.div(6)
    const g0 = w0.add(w1)
    const g1 = w2.add(w3)
    const h0 = w1.div(max(g0, 1e-6)).sub(1).add(base).add(0.5)
    const h1 = w3.div(max(g1, 1e-6)).add(1).add(base).add(0.5)
    const inv = vec2(1).div(panoramaSize)
    const a = node.sample(vec2(h0.x, h0.y).mul(inv)).level(0)
    const b = node.sample(vec2(h1.x, h0.y).mul(inv)).level(0)
    const c = node.sample(vec2(h0.x, h1.y).mul(inv)).level(0)
    const d = node.sample(vec2(h1.x, h1.y).mul(inv)).level(0)
    return mix(mix(a, b, g1.x), mix(c, d, g1.x), g1.y)
  }
  const sample = (dirEnu: any) => {
    const { st, below } = lookupUv(dirEnu)
    const now = bicubic(currentNode, st)
    const before = bicubic(previousNode, st)
    const c = mix(before, now, blend)
    const fade = altitudeFade.mul(visible).mul(smoothstep(-0.03, 0.0, below))
    // The opacity behind the haze in front of the clouds, for the sun: the stored opacity is
    // seen through that haze, so divide it back out.
    const sunOcclusion = clamp(c.w.div(sunOcclusionHaze), 0, 1).mul(fade)
    return { radiance: c.xyz.mul(fade), skyOcclusion: c.w.mul(fade), sunOcclusion }
  }

  // ---------------------------------------------------------------- schedule
  let dirty = true
  let bakeRow = 0
  let bakeActive = false
  const lastSun = new THREE.Vector3()
  let blendValue = 1
  let lookKey = ''
  const applyLook = () => {
    const look = params.look
    u.coverage.value = THREE.MathUtils.clamp(look.coverage, 0, 1)
    u.cells.value = THREE.MathUtils.clamp(look.cells, 0, 1)
    u.type.value = THREE.MathUtils.clamp(look.type, 0, 1)
    u.typeVariation.value = THREE.MathUtils.clamp(look.typeVariation, 0, 1)
    u.base.value = Math.max(look.baseKm, 0.05)
    u.thickness.value = Math.max(look.thicknessKm, 0.05)
    u.density.value = Math.max(look.densityPerKm, 0)
    u.erosion.value = THREE.MathUtils.clamp(look.erosion, 0, 1)
    u.shapeScaleInv.value = 1 / Math.max(look.shapeScaleKm, 0.1)
    u.weatherScaleInv.value = 1 / Math.max(look.weatherScaleKm, 1)
    u.albedo.value = 1 - THREE.MathUtils.clamp(look.absorption, 0, 0.95)
    u.precipitation.value = THREE.MathUtils.clamp(look.precipitation, 0, 1)
    u.anvil.value = THREE.MathUtils.clamp(look.anvil, 0, 1)
    u.highCoverage.value = THREE.MathUtils.clamp(look.highCoverage, 0, 1)
    u.highAltitude.value = Math.max(look.highAltitudeKm, look.baseKm + look.thicknessKm + 0.2)
    u.highDepth.value = Math.max(look.highDepth, 0)
    u.offset.value.set(look.offsetKm[0], look.offsetKm[1])
    u.sunLight.value = params.sunLight
    u.ambient.value = params.ambient
    u.powder.value = THREE.MathUtils.clamp(params.powder, 0, 1)
    u.diffuse.value = Math.max(params.diffuse, 0)
    u.diffusePenetration.value = Math.max(params.diffusePenetration, 0.001)
    u.ambientOcclusion.value = Math.max(params.ambientOcclusion, 0)
    u.haze.value = THREE.MathUtils.clamp(params.haze, 0, 1)
    u.steps.value = Math.max(8, Math.round(params.bakeSteps))
    midRadius.value = air.bottom.value + look.baseKm + look.thicknessKm * 0.5
    cloudShadow.strength.value = params.shadowStrength
    cloudShadow.lodBias.value = params.shadowSoftness
  }
  const rotate = () => {
    // The finished bake becomes current — through a 3 × 3 tent that takes the grain of the
    // per-texel jitter out (a bake is never averaged over frames) — and the old current the one
    // it fades from.
    renderer.copyTextureToTexture(currentTarget.texture, previousTarget.texture)
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(currentTarget)
    denoiseQuad.render(renderer)
    renderer.setRenderTarget(previous)
    finished++
    blendValue = 0
    blend.value = 0
    visible.value = 1
  }
  const scratchColor = new THREE.Color()

  // The mean of the sun's transmittance over the shadow map: a 4 × 4 grid on its coarse mips.
  const meanSunTransmittance = () => {
    let sum: any = float(0)
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const tau = cloudShadow.map.sample(vec2((i + 0.5) / 4, (j + 0.5) / 4)).level(5).r
      sum = sum.add(exp(tau.mul(cloudShadow.strength).negate()))
    }
    return mix(float(1), sum.div(16), cloudShadow.fade.mul(visible))
  }

  const layer: SkyClouds = {
    params,
    get ready() { return ready },
    get version() { return 0 },
    sample,
    meanSunTransmittance,
    presets: () => Object.keys(CONFIG.presets),
    applyPreset(name) {
      const look = presetLook(name)
      if (!look) return null
      params.preset = name
      params.look = look
      dirty = true
      return look
    },
    invalidate() { dirty = true },
    shadowTexture: () => shadowTarget.texture,
    bakeProgress: () => (bakeActive ? bakeRow / Math.max(params.bakeHeight, 1) : 1),
    update(input) {
      if (!params.enabled) { visible.value = 0; cloudShadow.fade.value = 0; return }
      if (!ready) return
      cloudShadow.mean.value = sky.light.cloudSunMean
      ensurePanoramas()
      const sun = input.sunDirectionEnu
      // The camera relative to the survey, for the lookup; the eye sits on the ground.
      cameraKm.value.copy(input.cameraEnuKm)
      const look = params.look
      altitudeFade.value = 1 - THREE.MathUtils.smoothstep(input.cameraEnuKm.z, look.baseKm, look.baseKm + look.thicknessKm * 0.5)
      // A bake is due when the sun has moved half a degree, or anything else changed.
      const key = JSON.stringify(look) + `|${params.sunLight}|${params.ambient}|${params.powder}|${params.diffuse}|${params.diffusePenetration}|${params.ambientOcclusion}|${params.haze}|${params.bakeSteps}|${params.shadowStrength}`
      if (key !== lookKey) { lookKey = key; dirty = true }
      if (lastSun.angleTo(sun) > 0.0087) dirty = true
      if (dirty && !bakeActive) {
        dirty = false
        bakeActive = true
        bakeRow = 0
        lastSun.copy(sun)
        applyLook()
        u.sun.value.copy(sun).normalize()
        u.eyeRadius.value = air.bottom.value + Math.max(input.groundAltitudeKm, 0) + 0.002
        eyeRadiusShared.value = u.eyeRadius.value
        u.eyeXY.value.set(0, 0)
        eyeXYShared.value.set(0, 0)
        // Ambient for the bake: the clear sky's mean radiance above, the ground's below.
        const light = sky.light
        const K = Math.max(light.illuminanceScale, 1e-6)
        // The clouds' tops see the clear sky above them, not the clouds' own glow: the capture's
        // cloud-free mean, so the bake cannot feed on its own previous result.
        u.ambientTop.value.set(...light.clearSkyMean).multiplyScalar(1.2)
        scratchColor.copy(light.sun).multiplyScalar(Math.max(sun.z, 0)).add(light.sky).multiplyScalar(1 / K)
        u.groundRadiance.value.set(scratchColor.r, scratchColor.g, scratchColor.b).multiply(new THREE.Vector3(...EXPERIENCE_CONFIG.sky.atmosphere.groundAlbedo)).multiplyScalar(1 / PI)
        // The shadow map: once per bake, centred where the survey's sun rays cross the base.
        const sz = Math.max(sun.z, 0.05)
        const baseM = look.baseKm * 1000
        shadowCentre.value.set(sun.x / sz * baseM, sun.y / sz * baseM)
        shadowHalf.value = CONFIG.shadowHalfExtentM
        const previous = renderer.getRenderTarget()
        renderer.setRenderTarget(shadowTarget)
        shadowQuad.render(renderer)
        renderer.setRenderTarget(previous)
        cloudShadow.centre.value.copy(shadowCentre.value)
        cloudShadow.half.value = shadowHalf.value
        cloudShadow.baseZ.value = baseM + cloudBaseOffsetZ
        cloudShadow.sun.value.copy(u.sun.value)
        cloudShadow.fade.value = 1
        // Haze in front of the sun's clouds, for recovering their opacity in the display.
        const meanKm = (look.baseKm + look.thicknessKm * 0.5) / Math.max(sun.z, 0.05)
        sunOcclusionHaze.value = Math.max(Math.exp(-0.06 * params.haze * Math.min(meanKm, 200)), 0.05)
      }
      if (bakeActive) {
        // A strip of rows this frame, scissored, into the panorama being baked.
        const target = backTarget
        const rows = Math.max(1, Math.ceil(target.height / Math.max(params.bakeFrames, 1)))
        const previous = renderer.getRenderTarget()
        const autoClear = renderer.autoClear
        const clearColour = renderer.getClearColor(new THREE.Color())
        const clearAlpha = renderer.getClearAlpha()
        renderer.autoClear = bakeRow === 0
        if (bakeRow === 0) renderer.setClearColor(0x000000, 0)
        target.scissor.set(0, bakeRow, target.width, Math.min(rows, target.height - bakeRow))
        renderer.setScissorTest(true)
        renderer.setRenderTarget(target)
        bakeQuad.render(renderer)
        renderer.setScissorTest(false)
        target.scissor.set(0, 0, target.width, target.height)
        renderer.setRenderTarget(previous)
        renderer.autoClear = autoClear
        renderer.setClearColor(clearColour, clearAlpha)
        bakeRow += rows
        if (bakeRow >= target.height) {
          bakeActive = false
          rotate()
          sky.invalidateCapture()
        }
      }
      if (blendValue < 1) {
        blendValue = Math.min(1, blendValue + Math.max(input.deltaS, 0) / Math.max(params.fadeSeconds, 0.01))
        // The very first bake fades in from nothing rather than from an empty panorama.
        blend.value = finished <= 1 ? 1 : blendValue
        visible.value = finished <= 1 ? blendValue : 1
      }
    },
    dispose() {
      for (const target of panoramas) target.dispose()
      shadowTarget.dispose()
      bakeMaterial.dispose()
      denoiseMaterial.dispose()
      shadowMaterial.dispose()
      baker.dispose()
      cloudShadow.map.value = placeholder
      cloudShadow.fade.value = 0
    },
  }
  cloudShadow.map.value = shadowTarget.texture
  // Debugging: the schedule's state and the current panorama's texels.
  ;(layer as any).debug = () => ({ finished, pending: dirty || bakeActive, blend: blend.value, visible: visible.value, altitudeFade: altitudeFade.value,
    bakeActive, bakeRow, shadowFade: cloudShadow.fade.value })
  ;(layer as any).debugRead = async (which: 'current' | 'shadow' = 'current') => {
    const target = which === 'shadow' ? shadowTarget : currentTarget
    return { width: target.width, height: target.height, data: await renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, target.height) }
  }
  /** Shader ENU z of the drawn ground (the clouds' altitudes are above it); set by main. */
  let cloudBaseOffsetZ = 0
  ;(layer as any).setGroundZ = (z: number) => { cloudBaseOffsetZ = z }
  return layer
}
