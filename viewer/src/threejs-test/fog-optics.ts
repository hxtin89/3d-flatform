// Optics of the volumetric ground fog, as plain functions: the CPU derives the shader's
// uniforms from them, and the tests check they are normalised.
//
// Fog droplets are a few to a few tens of micrometres across, far larger than visible
// wavelengths, so they scatter by Mie theory: grey (no colour dependence) and strongly
// forward. The phase function is Jendersie & d'Eon's fit to Mie for water droplets (2023,
// "An Approximate Mie Scattering Function for Fog and Cloud Rendering"): a blend of a
// Henyey–Greenstein lobe and a Draine lobe whose four parameters follow from the droplet
// diameter alone. The air between the droplets scatters by Rayleigh — blue-weighted and
// symmetric — which over a fog band's few hundred metres is a small, bluish addition.
//
// Conventions: cosTheta is the cosine between the direction light travels and the direction
// it scatters into; looking toward the sun through fog is cosTheta ≈ 1 (the forward peak).
// Phase functions integrate to 1 over the sphere (units 1/sr).

export const FOUR_PI = 4 * Math.PI

export function henyeyGreenstein(cosTheta: number, g: number): number {
  const denom = 1 + g * g - 2 * g * cosTheta
  return (1 - g * g) / (FOUR_PI * denom * Math.sqrt(denom))
}

/** Draine's phase function (2003): HG with an extra (1 + α cos²θ) term, renormalised. */
export function draine(cosTheta: number, g: number, alpha: number): number {
  const denom = 1 + g * g - 2 * g * cosTheta
  return ((1 - g * g) * (1 + alpha * cosTheta * cosTheta))
    / (FOUR_PI * denom * Math.sqrt(denom) * (1 + (alpha * (1 + 2 * g * g)) / 3))
}

export interface MiePhaseParameters { gHG: number; gD: number; alpha: number; wD: number }

/**
 * Jendersie & d'Eon's fitted parameters for a droplet of diameter `d` micrometres. Their
 * fit has three ranges; fog droplets sit in the 5–50 µm one. This viewer's slider runs
 * 2–40 µm, so its low end uses the 1.5–5 µm range, kept for haze-like settings.
 */
export function miePhaseParameters(d: number): MiePhaseParameters {
  if (d >= 5) {
    const dd = Math.min(d, 50)
    return {
      gHG: Math.exp(-0.0990567 / (dd - 1.67154)),
      gD: Math.exp(-2.20679 / (dd + 3.91029) - 0.428934),
      alpha: Math.exp(3.62489 - 8.29288 / (dd + 5.52825)),
      wD: Math.exp(-0.599085 / (dd - 0.641583) - 0.665888),
    }
  }
  if (d >= 1.5) {
    const l = Math.log(d)
    const ll = Math.log(l)
    return {
      gHG: 0.0604931 * ll + 0.940256,
      gD: 0.500411 - 0.081287 / (-2 * l + Math.tan(l) + 1.27551),
      alpha: 7.30354 * l + 6.31675,
      wD: 0.026914 * (l - Math.cos(5.68947 * (ll - 0.0292149))) + 0.376475,
    }
  }
  const dd = Math.max(d, 0.1)
  return {
    gHG: 0.862 - 0.143 * Math.log(dd) ** 2,
    gD: 0.379685 * Math.cos(1.19692 * Math.cos(((Math.log(dd) - 0.238604) * (Math.log(dd) + 1.00667)) / (0.507522 - 0.15677 * Math.log(dd))) + 1.37932 * Math.log(dd) + 0.0625835) + 0.344213,
    alpha: 250,
    wD: 0.146209 * Math.cos(3.38707 * Math.log(dd) + 2.11193) + 0.316072 + 0.0778917 * Math.log(dd),
  }
}

/** The fitted Mie phase function for droplet diameter `d` µm. */
export function miePhase(cosTheta: number, d: number): number {
  const p = miePhaseParameters(d)
  return (1 - p.wD) * henyeyGreenstein(cosTheta, p.gHG) + p.wD * draine(cosTheta, p.gD, p.alpha)
}

export function rayleighPhase(cosTheta: number): number {
  return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta)
}

/** Rayleigh scattering of sea-level air per metre at 680, 550 and 440 nm, the wavelengths the
 *  atmosphere-rendering literature (Bruneton, Hillaire) samples its RGB channels at. They are
 *  not the Rec.709 primaries' dominant wavelengths (≈ 611, 549, 464 nm): the blue:red ratio,
 *  5.7, is stronger than λ⁻⁴ at those would give (3.0). */
export const RAYLEIGH_SEA_LEVEL_PER_M: [number, number, number] = [5.802e-6, 13.558e-6, 33.1e-6]

/** Koschmieder: the extinction coefficient (1/m) of a medium in which a black object
 *  vanishes against the horizon at `visibilityM` (2 % contrast threshold). */
export function extinctionForVisibility(visibilityM: number): number {
  return 3.912 / Math.max(visibilityM, 1)
}

/**
 * Wrenninge's (2013) multiple-scattering approximation: `octaves` extra bounces, each with
 * extinction scaled by a^i (light gets through deeper), scattering by b^i (less energy) and
 * the phase anisotropy by c^i (bounced light forgets its direction). Returns the weights the
 * shader sums; octave 0 is single scattering.
 */
export function multipleScatteringOctaves(octaves: number, a = 0.5, b = 0.5, c = 0.5): { extinction: number; scattering: number; anisotropy: number }[] {
  return Array.from({ length: octaves + 1 }, (_, i) => ({ extinction: a ** i, scattering: b ** i, anisotropy: c ** i }))
}
