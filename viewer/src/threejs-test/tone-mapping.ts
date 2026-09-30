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
//
// `film` is the look the experience ships with: the brief is cinematic, not documentary.
// It grades before the same shoulder — a log-space S-curve around 18 % grey, saturation,
// cool shadows against warm highlights, print-film black lift and a vignette. Film Warm was
// chosen against six alternatives on identical frames (the Canopy Look Board artifact) and
// then retuned by eye: the shipped values in config.ts drop the S-curve, raise saturation
// and run the split at full strength.
import * as THREE from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import {
  Fn, clamp, dot, exp2, float, length, log2, max, min, mix, pow, screenUV, select, smoothstep,
  uniform, vec2, vec3,
} from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'

/** Declared here rather than read off the config, so a panel dump pasted over the config
 * line (a bare string, no cast) narrows the value without narrowing this type. */
export type ToneMappingMode = 'none' | 'film' | 'shoulder' | 'neutral' | 'agx' | 'aces'

/** three looks a curve up by number, and 0–7 are its own; any other number is a free slot. */
const FILM_TONE_MAPPING = 100 as THREE.ToneMapping

/** `shoulder` rides on three's custom slot and `film` on a free one; the rest are three's. */
export const TONE_MAPPINGS: Record<ToneMappingMode, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  film: FILM_TONE_MAPPING,
  shoulder: THREE.CustomToneMapping,
  neutral: THREE.NeutralToneMapping,
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
}

/** Peak (max channel, linear) below which `shoulder` is the identity: Neutral's knee
 * without its offset. sRGB 231, above every canopy colour; the basemap crosses it from
 * raw sRGB 199 at mapBrightness 1.4× (raw white from 0.8×) with the colour match off; with
 * it on the map's gain is 3.5–4.7× and the knee is reached from about raw sRGB 115. */
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
function shoulderNode(exposed: any, whitePoint: any, desaturation = SHOULDER_DESATURATION): any {
  const peak = max(exposed.r, max(exposed.g, exposed.b))
  const knee = float(SHOULDER_KNEE)
  const white = max(whitePoint, knee.add(1e-3))
  const t = min(peak.sub(knee).div(white.sub(knee)), 1)
  const n = white.sub(knee).div(float(1).sub(knee))
  const compressed = knee.add(float(1).sub(knee).mul(float(1).sub(pow(max(float(1).sub(t), 0), n)))).toVar()
  const below = peak.lessThan(knee)
  const scale = select(below, float(1), compressed.div(peak)).uniformFlow()
  if (desaturation === 0) return exposed.mul(scale)
  const whiten = select(below, float(0),
    float(1).sub(float(1).div(float(desaturation).mul(peak.sub(compressed)).add(1)))).uniformFlow()
  return mix(exposed.mul(scale), vec3(compressed), whiten)
}

const shoulderToneMapping = Fn(([color, exposure]: any[]) => shoulderNode(color.mul(exposure), toneWhitePoint))

const FILM = EXPERIENCE_CONFIG.toneMapping.film
/** The film grade's controls, read live so the panel needs no rebuild. */
export const filmContrast = uniform(FILM.contrast)
export const filmSaturation = uniform(FILM.saturation)
/** 0 = no split toning, 1 = the configured tints, 2 = twice as strong. */
export const filmSplit = uniform(FILM.split)
export const filmLift = uniform(FILM.lift)
export const filmVignette = uniform(FILM.vignette)
/** The photographic mid-tone the S-curve pivots on, as in the point grade. */
const FILM_PIVOT = 0.18

/**
 * The film look. Contrast is a power on luma in log space around 18 % grey — shadows
 * deepen, highlights lift, mid-grey stays put — with the colour rescaled to the new luma so
 * hue survives. Then saturation against that luma, split toning from the shadow tint to the
 * highlight tint across the luma range, the shoulder (with a higher white point than the
 * faithful curve, so bright sand and cloud tops roll off instead of flattening), a lifted
 * black like a print stock, and a vignette over the frame. It runs in the output pass on the
 * finished frame, sky and overlays included, so screenUV is the canvas.
 *
 * Every part — tone (contrast + saturation), split, lift, vignette — is compiled in or out,
 * never zeroed, so switching one off measures what it costs; a part at its neutral value
 * (contrast and saturation 1, split 0, lift 0, vignette 0) is compiled out too, as the
 * point grade is. Each combination is its own function on its own library slot, so the
 * TSL function is kept per slot, but the output pass is rebuilt and recompiled on every
 * switch in either direction — on the DoF/EDL path that is the whole post quad.
 *
 * The shoulder here has no pull toward white: that is the curve the look was picked with
 * on the Look Board. The faithful `shoulder` mode keeps Neutral's 0.15.
 */
function filmToneMapping(parts: Readonly<Record<FilmPart, boolean>>): any {
  return Fn(([color, exposure]: any[]) => {
    const luma = (c: any) => dot(c, vec3(0.2126, 0.7152, 0.0722))
    let c: any = color.mul(exposure)
    if (parts.tone) {
      const l = max(luma(c), 1e-6)
      const contrasted = float(FILM_PIVOT).mul(exp2(log2(l.div(FILM_PIVOT)).mul(filmContrast)))
      c = c.mul(contrasted.div(l))
      c = mix(vec3(luma(c)), c, filmSaturation)
    }
    if (parts.split) {
      const tint = mix(vec3(...FILM.shadowTint), vec3(...FILM.highlightTint), smoothstep(0.03, 0.7, luma(c)))
      c = c.mul(mix(vec3(1), tint, filmSplit))
    }
    c = shoulderNode(max(c, vec3(0)), float(FILM.whitePoint), 0)
    if (parts.lift) c = c.mul(float(1).sub(filmLift)).add(filmLift)
    if (parts.vignette) {
      // Elliptical, so the 16:9 frame darkens toward its corners rather than its long edges.
      const radius = length(screenUV.sub(vec2(0.5)).mul(vec2(1, 0.8))).mul(1.6)
      c = c.mul(float(1).sub(smoothstep(0.45, 1.1, radius).mul(filmVignette)))
    }
    return clamp(c, 0, 1)
  })
}

/** Which parts of the film grade the switches allow. */
const filmParts = {
  tone: FILM.toneEnabled as boolean,
  split: FILM.splitEnabled as boolean,
  lift: FILM.liftEnabled as boolean,
  vignette: FILM.vignetteEnabled as boolean,
}
export type FilmPart = keyof typeof filmParts
const FILM_PART_ORDER: FilmPart[] = ['tone', 'split', 'lift', 'vignette']
let toneLibrary: { addToneMapping(fn: unknown, toneMapping: THREE.ToneMapping): void; getToneMappingFunction(toneMapping: THREE.ToneMapping): unknown } | null = null

/** Whether a part changes anything at its current value. */
function filmPartActive(part: FilmPart): boolean {
  if (!filmParts[part]) return false
  switch (part) {
    case 'tone': return filmContrast.value !== 1 || filmSaturation.value !== 1
    case 'split': return filmSplit.value !== 0
    case 'lift': return filmLift.value !== 0
    case 'vignette': return filmVignette.value !== 0
  }
}

/** The slot for the active film parts — 100 with all of them — registered on first use. */
function filmSlot(): THREE.ToneMapping {
  const active = Object.fromEntries(FILM_PART_ORDER.map((p) => [p, filmPartActive(p)])) as Record<FilmPart, boolean>
  const offMask = FILM_PART_ORDER.reduce((mask, p, bit) => mask | (active[p] ? 0 : 1 << bit), 0)
  const slot = (FILM_TONE_MAPPING + offMask) as THREE.ToneMapping
  if (toneLibrary && !toneLibrary.getToneMappingFunction(slot)) {
    toneLibrary.addToneMapping(filmToneMapping(active), slot)
  }
  return slot
}

export function setFilmPart(part: FilmPart, enabled: boolean): void { filmParts[part] = enabled }
export function isFilmPart(part: FilmPart): boolean { return filmParts[part] }

/** The number to put on the renderer for a picked curve: film resolves to its variant. */
export function resolveToneMapping(picked: THREE.ToneMapping): THREE.ToneMapping {
  return picked === FILM_TONE_MAPPING ? filmSlot() : picked
}

/**
 * Register the custom curve and set the starting one. Must run before the first frame:
 * the output pass only rebuilds when `toneMapping` changes, so a frame rendered with
 * CustomToneMapping before the function exists stays untone-mapped.
 */
export function installToneMapping(renderer: WebGPURenderer, mode: ToneMappingMode): void {
  // @types/three declares NodeLibrary empty; the r185 runtime has addToneMapping and only
  // refuses redefining a slot, which the built-ins never do for CustomToneMapping.
  toneLibrary = renderer.library as unknown as NonNullable<typeof toneLibrary>
  toneLibrary.addToneMapping(shoulderToneMapping, THREE.CustomToneMapping)
  renderer.toneMapping = resolveToneMapping(TONE_MAPPINGS[mode])
  renderer.toneMappingExposure = EXPERIENCE_CONFIG.toneMapping.exposure
}

/** `?tonemap=` value, or null when it is missing or not one of ours. */
export function parseToneMappingMode(value: string | null): ToneMappingMode | null {
  return value !== null && Object.hasOwn(TONE_MAPPINGS, value) ? value as ToneMappingMode : null
}

/** Reverse lookup for the panel's config dump; any film variant reads as `film`. */
export function toneMappingModeOf(toneMapping: THREE.ToneMapping): ToneMappingMode {
  if (toneMapping >= FILM_TONE_MAPPING && toneMapping < FILM_TONE_MAPPING + (1 << FILM_PART_ORDER.length)) return 'film'
  const entry = Object.entries(TONE_MAPPINGS).find(([, value]) => value === toneMapping)
  return (entry?.[0] ?? 'none') as ToneMappingMode
}
