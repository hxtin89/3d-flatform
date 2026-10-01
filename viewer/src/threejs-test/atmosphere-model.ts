// The air above the survey as plain numbers: the physical model the sky package renders
// (sky-atmosphere.ts) and lights the scene with, kept free of three.js so the tests can
// check it and the CPU can light the scene without a GPU readback.
//
// Model. Hillaire's (2020, "A Scalable and Production Ready Sky and Atmosphere Rendering
// Technique") and Bruneton's: a spherical shell of air between the planet's surface and
// 100 km up, three kinds of matter in it —
//   · air molecules, Rayleigh: scatter blue more than red, density e^(−h / 8 km);
//   · aerosols (haze, smoke, the humid tropics' water-coated particles), Mie: scatter almost
//     grey and strongly forward, density e^(−h / H) with H a kilometre or two, some absorbed;
//   · ozone: absorbs orange, a tent-shaped layer around 25 km — it is what keeps the zenith
//     blue at sunset instead of grey.
// Distances in kilometres, coefficients per kilometre, as in the papers.
//
// Aerosol defaults. The papers' Mie values describe very clean air (an aerosol optical depth
// of ~0.005). Over the Amazon lowlands it is 0.08–0.13 in the wet season and 0.2–0.5 in the
// dry season, peaking near 1 in the September fire season (AAQR 2019; Huancayo). The default
// sits at a humid-haze 0.22 over a 1.6 km layer: a hazy, milky horizon, ~30 km visibility.
// Ångström exponent 1 makes the haze slightly bluer than grey (1.3 measured there reads as
// smoke at a low sun).
//
// Units of light. The sun's illuminance at the top of the atmosphere is 1 (white), so every
// radiance here is relative to it. The renderer turns that into display values with one
// exposure (see sky-atmosphere.ts): a white Lambertian surface lit by `referenceIlluminance`
// shows as 1.

export type Rgb = [number, number, number]

/** The physical parameters, per kilometre, as the shaders take them. */
export interface AtmosphereParameters {
  bottomRadiusKm: number
  topRadiusKm: number
  rayleighScattering: Rgb
  rayleighScaleHeightKm: number
  mieScattering: Rgb
  mieExtinction: Rgb
  mieScaleHeightKm: number
  mieG: number
  ozoneAbsorption: Rgb
  ozoneCentreKm: number
  ozoneHalfWidthKm: number
  groundAlbedo: Rgb
}

/** What the panel exposes: physical quantities a person can reason about. */
export interface AtmosphereSettings {
  /** Aerosol optical depth at 550 nm, straight up. 0.005 is pristine, 0.25 hazy, 1 smoke. */
  aerosolDepth: number
  /** Scale height of the aerosol layer, km. */
  aerosolHeightKm: number
  /** Single-scattering albedo of the aerosols: 1 scatters everything, smoke ~0.88. */
  aerosolAlbedo: number
  /** Mean scattering cosine of the aerosols: how forward their glow around the sun is. */
  aerosolG: number
  /** Ångström exponent: how much more the haze scatters blue than red. 0 is grey. */
  angstrom: number
  /** Multiplier on the molecular (Rayleigh) air. */
  rayleighScale: number
  /** Multiplier on the ozone layer. The tropics have ~0.85–0.9 of the standard amount. */
  ozoneScale: number
  /** Ground albedo, linear RGB: the forest canopy, ~0.12 and greenish. */
  groundAlbedo: Rgb
}

export const PLANET_RADIUS_KM = 6360
export const ATMOSPHERE_TOP_KM = 6460
/** Rayleigh scattering of sea-level air per km at 680, 550 and 440 nm (Bruneton, Hillaire). */
export const RAYLEIGH_PER_KM: Rgb = [5.802e-3, 13.558e-3, 33.1e-3]
/** Ozone absorption per km at the layer's peak (Hillaire's default). */
export const OZONE_PER_KM: Rgb = [0.65e-3, 1.881e-3, 0.085e-3]
/** The wavelengths the RGB channels stand for, nm. */
const WAVELENGTHS_NM: Rgb = [680, 550, 440]
/** Angular radius of the sun's disc, radians (0.533° across). */
export const SUN_ANGULAR_RADIUS = 0.004675

export const DEFAULT_ATMOSPHERE: AtmosphereSettings = {
  aerosolDepth: 0.22,
  aerosolHeightKm: 1.6,
  aerosolAlbedo: 0.95,
  aerosolG: 0.72,
  angstrom: 1,
  rayleighScale: 1,
  ozoneScale: 0.88,
  groundAlbedo: [0.09, 0.13, 0.07],
}

export function atmosphereParameters(settings: AtmosphereSettings): AtmosphereParameters {
  const height = Math.max(settings.aerosolHeightKm, 0.05)
  // Sea-level extinction is the optical depth over the layer's scale height.
  const extinction550 = Math.max(settings.aerosolDepth, 0) / height
  const mieExtinction = WAVELENGTHS_NM.map((lambda) => extinction550 * (lambda / 550) ** -settings.angstrom) as Rgb
  const albedo = Math.min(Math.max(settings.aerosolAlbedo, 0), 1)
  return {
    bottomRadiusKm: PLANET_RADIUS_KM,
    topRadiusKm: ATMOSPHERE_TOP_KM,
    rayleighScattering: RAYLEIGH_PER_KM.map((v) => v * Math.max(settings.rayleighScale, 0)) as Rgb,
    rayleighScaleHeightKm: 8,
    mieScattering: mieExtinction.map((v) => v * albedo) as Rgb,
    mieExtinction,
    mieScaleHeightKm: height,
    mieG: Math.min(Math.max(settings.aerosolG, -0.95), 0.95),
    ozoneAbsorption: OZONE_PER_KM.map((v) => v * Math.max(settings.ozoneScale, 0)) as Rgb,
    ozoneCentreKm: 25,
    ozoneHalfWidthKm: 15,
    groundAlbedo: [...settings.groundAlbedo] as Rgb,
  }
}

/** Extinction per km at altitude `hKm` above the surface, per channel. */
export function extinctionAt(p: AtmosphereParameters, hKm: number, out: Rgb = [0, 0, 0]): Rgb {
  const rayleigh = Math.exp(-Math.max(hKm, 0) / p.rayleighScaleHeightKm)
  const mie = Math.exp(-Math.max(hKm, 0) / p.mieScaleHeightKm)
  const ozone = Math.max(0, 1 - Math.abs(hKm - p.ozoneCentreKm) / p.ozoneHalfWidthKm)
  for (let c = 0; c < 3; c++) {
    out[c] = p.rayleighScattering[c] * rayleigh + p.mieExtinction[c] * mie + p.ozoneAbsorption[c] * ozone
  }
  return out
}

/** Distance from radius `r` along a ray with zenith cosine `mu` to the top of the air. */
export function distanceToTop(p: AtmosphereParameters, r: number, mu: number): number {
  const discriminant = r * r * (mu * mu - 1) + p.topRadiusKm * p.topRadiusKm
  return Math.max(-r * mu + Math.sqrt(Math.max(discriminant, 0)), 0)
}

/** Whether a ray from radius `r` with zenith cosine `mu` meets the ground. */
export function hitsGround(p: AtmosphereParameters, r: number, mu: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + p.bottomRadiusKm * p.bottomRadiusKm >= 0
}

/** Transmittance from radius `r` (km from the planet's centre) toward the top of the air
 *  along zenith cosine `mu`, per channel; 0 where the ray meets the ground. */
export function transmittance(p: AtmosphereParameters, r: number, mu: number, steps = 40): Rgb {
  if (hitsGround(p, r, mu)) return [0, 0, 0]
  const length = distanceToTop(p, r, mu)
  const dt = length / steps
  const depth: Rgb = [0, 0, 0]
  const sigma: Rgb = [0, 0, 0]
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt
    const h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - p.bottomRadiusKm
    extinctionAt(p, h, sigma)
    for (let c = 0; c < 3; c++) depth[c] += sigma[c] * dt
  }
  return depth.map((d) => Math.exp(-d)) as Rgb
}

/**
 * The sun's illuminance on a surface facing it, at altitude `altitudeKm`, for a sun at
 * elevation `elevationRad` above the true horizontal: transmittance times the share of the
 * disc above the planet's limb. Relative to 1 at the top of the atmosphere.
 */
export function sunIlluminance(p: AtmosphereParameters, altitudeKm: number, elevationRad: number): Rgb {
  const r = p.bottomRadiusKm + Math.max(altitudeKm, 0.001)
  // The limb's elevation seen from this altitude: below zero, the dip of the horizon.
  const horizon = -Math.acos(Math.min(p.bottomRadiusKm / r, 1))
  const visible = smoothstep(-SUN_ANGULAR_RADIUS, SUN_ANGULAR_RADIUS, elevationRad - horizon)
  if (visible <= 0) return [0, 0, 0]
  // Just above the limb, march a hair higher so the ray does not graze the surface.
  const mu = Math.sin(Math.max(elevationRad, horizon + SUN_ANGULAR_RADIUS))
  return transmittance(p, r, mu).map((t) => t * visible) as Rgb
}

/**
 * The illuminance the exposure is anchored to: a horizontal surface at the ground under a
 * clear sky with the sun 60° up. A white Lambertian surface lit by it displays as 1. The sky's
 * share is taken as a fixed fraction of the sun's (a clear tropical sky gives ~15–25 %), so
 * the anchor does not move when the clouds change.
 */
export function referenceIlluminance(p: AtmosphereParameters): number {
  const sun = sunIlluminance(p, 0, Math.PI / 3)
  return luminance(sun) * Math.sin(Math.PI / 3) * 1.2
}

export function luminance(c: Rgb): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------- LUT parametrisations
// The same mappings the shaders use, here so the tests can round-trip them.

/** Bruneton's transmittance-LUT mapping: (r, mu) → (u, v) in [0, 1]. */
export function transmittanceUv(p: AtmosphereParameters, r: number, mu: number): [number, number] {
  const H = Math.sqrt(p.topRadiusKm ** 2 - p.bottomRadiusKm ** 2)
  const rho = Math.sqrt(Math.max(r * r - p.bottomRadiusKm ** 2, 0))
  const d = distanceToTop(p, r, mu)
  const dMin = p.topRadiusKm - r
  const dMax = rho + H
  return [(d - dMin) / Math.max(dMax - dMin, 1e-9), rho / H]
}

/** The inverse of transmittanceUv. */
export function transmittanceRMu(p: AtmosphereParameters, u: number, v: number): [number, number] {
  const H = Math.sqrt(p.topRadiusKm ** 2 - p.bottomRadiusKm ** 2)
  const rho = H * v
  const r = Math.sqrt(rho * rho + p.bottomRadiusKm ** 2)
  const dMin = p.topRadiusKm - r
  const dMax = rho + H
  const d = dMin + u * (dMax - dMin)
  const mu = d === 0 ? 1 : (H * H - rho * rho - d * d) / (2 * r * d)
  return [r, Math.min(Math.max(mu, -1), 1)]
}

/**
 * Hillaire's sky-view mapping: (does the ray hit the ground, cos view zenith, cos of the
 * azimuth between view and sun, radius) → (u, v). v = 0.5 is the horizon at every altitude,
 * with rows packed toward it by a square root; u runs from toward the sun (0) to away (1),
 * also square-root packed, so the half toward the sun gets the most texels.
 */
export function skyViewUv(p: AtmosphereParameters, groundHit: boolean, cosViewZenith: number, cosLightView: number, r: number): [number, number] {
  const vHorizon = Math.sqrt(Math.max(r * r - p.bottomRadiusKm ** 2, 0))
  const beta = Math.acos(Math.min(vHorizon / r, 1))
  const zenithHorizonAngle = Math.PI - beta
  const viewZenith = Math.acos(Math.min(Math.max(cosViewZenith, -1), 1))
  let v: number
  if (!groundHit) {
    const coord = 1 - Math.sqrt(Math.max(1 - viewZenith / zenithHorizonAngle, 0))
    v = coord * 0.5
  } else {
    const coord = Math.sqrt(Math.max((viewZenith - zenithHorizonAngle) / beta, 0))
    v = coord * 0.5 + 0.5
  }
  const u = Math.sqrt(Math.max(-cosLightView * 0.5 + 0.5, 0))
  return [u, v]
}

/** The inverse of skyViewUv: (u, v, r) → (cos view zenith, cos light-view azimuth). */
export function skyViewParams(p: AtmosphereParameters, u: number, v: number, r: number): [number, number] {
  const vHorizon = Math.sqrt(Math.max(r * r - p.bottomRadiusKm ** 2, 0))
  const beta = Math.acos(Math.min(vHorizon / r, 1))
  const zenithHorizonAngle = Math.PI - beta
  let viewZenith: number
  if (v < 0.5) {
    let coord = 2 * v
    coord = 1 - coord
    coord *= coord
    coord = 1 - coord
    viewZenith = zenithHorizonAngle * coord
  } else {
    let coord = v * 2 - 1
    coord *= coord
    viewZenith = zenithHorizonAngle + beta * coord
  }
  const cosLightView = -(u * u * 2 - 1)
  return [Math.cos(viewZenith), cosLightView]
}

// ---------------------------------------------------------------- geodesy

const WGS84_A = 6_378_137
const WGS84_F = 1 / 298.257223563
const WGS84_B = WGS84_A * (1 - WGS84_F)
const WGS84_E2 = WGS84_F * (2 - WGS84_F)
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B)

/** Height above the WGS84 ellipsoid of an ECEF point, metres (Bowring's method, sub-mm on
 *  Earth's surface and well within a metre at 20 km). */
export function ellipsoidHeight(x: number, y: number, z: number): number {
  const p = Math.hypot(x, y)
  if (p < 1e-6) return Math.abs(z) - WGS84_B
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B)
  const lat = Math.atan2(
    z + WGS84_EP2 * WGS84_B * Math.sin(theta) ** 3,
    p - WGS84_E2 * WGS84_A * Math.cos(theta) ** 3,
  )
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2)
  return p / Math.cos(lat) - n
}
