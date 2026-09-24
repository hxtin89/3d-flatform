// The output curve between the linear working colour and the sRGB canvas.
//
// r185 draws the frame into a HalfFloat target and applies tone mapping plus the sRGB
// encode in one output pass that was running anyway (the output colour space differs
// from the working space), so any curve here costs one per-pixel function, not a pass.
// That same pass is why `material.toneMapped = false` is ignored on this renderer: the
// curve sees the finished frame, not individual materials.
//
// Stock Neutral is the wrong default for this scene. Khronos PBR Neutral subtracts 0.04
// from every channel (a quadratic toe below 0.08) to cancel the 4 % Fresnel reflection a
// lit PBR material adds. Captured point RGB and satellite imagery are unlit and carry no
// such term, so stock Neutral only darkens them: grey 128 lands on 116, a dark canopy
// (40, 60, 30) on (24, 51, 3); measured on a full frame, every pixel moved, 16 levels on
// average. The `shoulder` curve keeps Neutral's knee, hue-preserving peak scaling and
// highlight desaturation, drops the offset, and swaps Neutral's rational compression (which
// only approaches 1) for a power curve that reaches white exactly at a chosen white point.
// Everything below the knee is passed through exactly: 0 of 921 217 such pixels changed.
import * as THREE from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { Fn, float, max, min, mix, pow, select, uniform, vec3 } from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'

/** Declared here rather than read off the config, so a panel dump pasted over the config
 * line (a bare string, no cast) narrows the value without narrowing this type. */
export type ToneMappingMode = 'none' | 'shoulder' | 'neutral' | 'agx' | 'aces'

/** `shoulder` rides on three's free custom slot; the rest are three's own curves. */
export const TONE_MAPPINGS: Record<ToneMappingMode, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  shoulder: THREE.CustomToneMapping,
  neutral: THREE.NeutralToneMapping,
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
}

/** Peak (max channel, linear) below which `shoulder` is the identity: Neutral's knee
 * without its offset. sRGB 231, above every canopy colour; the basemap crosses it from
 * raw sRGB 199 at mapBrightness 1.4× (raw white from 0.8×). */
const SHOULDER_KNEE = 0.8
/** Neutral's pull toward white for overbright colour, so a blown highlight goes white
 * instead of staying a saturated 100 % primary. Zero below the knee. */
const SHOULDER_DESATURATION = 0.15

/** Linear peak that reaches full output (full white for a grey). Read live, so the panel
 * needs no rebuild. */
export const toneWhitePoint = uniform(EXPERIENCE_CONFIG.toneMapping.whitePoint)

/**
 * Identity below the knee, then `k + (1 - k)·(1 - (1 - t)^n)` on the peak up to the
 * white point, with n chosen so the slope stays 1 at the knee (C1) and reaches 0 at white.
 * The whole colour is scaled by the peak's ratio, so hue and channel ratios survive. A
 * white point of 1 removes the roll-off; it still differs from `none` above 1, where it
 * scales the colour down to the peak instead of clipping each channel.
 *
 * Below the knee the scale is exactly 1 and the white mix exactly 0, so the result is
 * bit-identical to the input rather than a round trip through a division. `compressed` is
 * a var so the two selects share one pow, and uniformFlow makes them real selects: a plain
 * TSL select compiles to an if/else whose branches each rebuild their operands.
 */
const shoulderToneMapping = Fn(([color, exposure]: any[]) => {
  const exposed = color.mul(exposure)
  const peak = max(exposed.r, max(exposed.g, exposed.b))
  const knee = float(SHOULDER_KNEE)
  const white = max(toneWhitePoint, knee.add(1e-3))
  const t = min(peak.sub(knee).div(white.sub(knee)), 1)
  const n = white.sub(knee).div(float(1).sub(knee))
  const compressed = knee.add(float(1).sub(knee).mul(float(1).sub(pow(max(float(1).sub(t), 0), n)))).toVar()
  const below = peak.lessThan(knee)
  const scale = select(below, float(1), compressed.div(peak)).uniformFlow()
  const whiten = select(below, float(0),
    float(1).sub(float(1).div(float(SHOULDER_DESATURATION).mul(peak.sub(compressed)).add(1)))).uniformFlow()
  return mix(exposed.mul(scale), vec3(compressed), whiten)
})

/**
 * Register the custom curve and set the starting one. Must run before the first frame:
 * the output pass only rebuilds when `toneMapping` changes, so a frame rendered with
 * CustomToneMapping before the function exists stays untone-mapped.
 */
export function installToneMapping(renderer: WebGPURenderer, mode: ToneMappingMode): void {
  // @types/three declares NodeLibrary empty; the r185 runtime has addToneMapping and only
  // refuses redefining a slot, which the built-ins never do for CustomToneMapping.
  const library = renderer.library as unknown as {
    addToneMapping(fn: unknown, toneMapping: THREE.ToneMapping): void
  }
  library.addToneMapping(shoulderToneMapping, THREE.CustomToneMapping)
  renderer.toneMapping = TONE_MAPPINGS[mode]
  renderer.toneMappingExposure = EXPERIENCE_CONFIG.toneMapping.exposure
}

/** `?tonemap=` value, or null when it is missing or not one of ours. */
export function parseToneMappingMode(value: string | null): ToneMappingMode | null {
  return value !== null && Object.hasOwn(TONE_MAPPINGS, value) ? value as ToneMappingMode : null
}

/** Reverse lookup for the panel's config dump. */
export function toneMappingModeOf(toneMapping: THREE.ToneMapping): ToneMappingMode {
  const entry = Object.entries(TONE_MAPPINGS).find(([, value]) => value === toneMapping)
  return (entry?.[0] ?? 'none') as ToneMappingMode
}
