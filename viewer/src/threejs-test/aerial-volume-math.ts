// The camera-volume aerial perspective's arithmetic, CPU side (sky-atmosphere.ts builds the same
// formulas in TSL). Pure, so node --test checks it.
//
// The volume: 32 × 32 froxels across the screen, 32 distance slices. Texel k of a froxel holds
// the aerial perspective from the camera to the slice's far edge e(k + 1), e(k) = span·(k/32)²;
// edge 0 (the camera) is implicit, nothing there. Froxel centres sit on the screen's edges
// (u = i / 31), so a lookup never clamps and no bilinear tap leaves its tile.
import type { AtmosphereParameters, Rgb } from './atmosphere-model.ts'

export const AP_N = 32

/** Distance of slice edge `k` from the camera, km. */
export function edgeKm(k: number, spanKm: number): number {
  return spanKm * (k / AP_N) ** 2
}

/** Which two stored edges bracket a lookup at `xM` metres (the distance past the haze's start)
 *  and the weight between them, exactly linear in distance. `i0` is the texel of the far edge;
 *  the near one is texel i0 − 1, or the camera itself (nothing) for i0 = 0. */
export function sliceWeight(xM: number, spanKm: number): { i0: number; w: number } {
  const s2 = AP_N * AP_N * Math.min(Math.max(xM / (spanKm * 1000), 0), 1)
  const i0 = Math.min(Math.floor(Math.sqrt(s2)), AP_N - 1)
  const w = Math.min(Math.max((s2 - i0 * i0) / (2 * i0 + 1), 0), 1)
  return { i0, w }
}

/** Screen coordinate (0..1) → the texture coordinate of the texel centred on it, in an axis of
 *  `n` texels whose centres sit at 0 and 1. */
export function unitToTexel(u: number, n: number): number {
  return (u * (n - 1) + 0.5) / n
}

/** The inverse: a texel centre → its screen coordinate (sky-atmosphere.ts fromSubUvToUnit). */
export function texelToUnit(t: number, n: number): number {
  return (t - 0.5 / n) * (n / (n - 1))
}

/** How far the volume reaches: to the far plane, or a little past the horizon (no scene
 *  surface lies beyond it, the ground being the bare ellipsoid), but never under `minRangeKm`. */
export function apSpanKm(cameraRadiusKm: number, groundRadiusKm: number, farKm: number, horizonFactor: number, minRangeKm: number): number {
  const horizonKm = Math.sqrt(Math.max(cameraRadiusKm ** 2 - groundRadiusKm ** 2, 0))
  return Math.min(farKm, Math.max(horizonFactor * horizonKm, minRangeKm))
}

const W709: Rgb = [0.2126, 0.7152, 0.0722]

/** The air's extinction per km at height `hKm` (ozone left out: none below 10 km). */
function extinctionAt(model: AtmosphereParameters, hKm: number): Rgb {
  const r = Math.exp(-Math.max(hKm, 0) / model.rayleighScaleHeightKm)
  const m = Math.exp(-Math.max(hKm, 0) / model.mieScaleHeightKm)
  return [0, 1, 2].map((c) => model.rayleighScattering[c] * r + model.mieExtinction[c] * m) as Rgb
}

/**
 * The per-channel exponents that turn the volume's luminance-weighted transmittance back into
 * colour: T_c = T_L^k_c with k_c = β_c / (β · W709). Exact wherever the air's mix is the same
 * along the ray; β is the Simpson mean over the heights from the ground to the camera's
 * (capped at 2 km, the band the haze is seen through).
 */
export function spectralK(model: AtmosphereParameters, cameraHeightKm: number): Rgb {
  const hc = Math.min(Math.max(cameraHeightKm, 0), 2)
  const a = extinctionAt(model, 0)
  const b = extinctionAt(model, hc / 2)
  const c = extinctionAt(model, hc)
  const beta = [0, 1, 2].map((i) => (a[i] + 4 * b[i] + c[i]) / 6) as Rgb
  const lum = beta[0] * W709[0] + beta[1] * W709[1] + beta[2] * W709[2]
  return beta.map((x) => x / Math.max(lum, 1e-12)) as Rgb
}
