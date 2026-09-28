// Which optional terms the point and map shaders emit. Split out of main.ts and
// point-cloud.ts so the rule can be tested without a browser; extension-qualified
// because node --test (npm run bench:verify) loads it directly.
import { EXPERIENCE_CONFIG } from './config.ts'

/**
 * Shader terms that are left out of the shader altogether while their feature is off,
 * rather than compiled in and zeroed by a uniform: the vignette (its dissolve in the point
 * size and its dim in both the point and map colour), the foveation bend of the requested
 * point spacing, and the level inspector's false-colour palette. Each ran per point or per
 * fragment in every session to produce exactly the value it was given.
 *
 * The cost moves to the switch: turning one on or off rebuilds every loaded tile shader
 * once — the vignette both layers, the other two the point cloud only. Sliders stay
 * uniform writes, because the code stays compiled while its feature is on.
 */
export type CompiledTerm = 'vignette' | 'foveaBend' | 'debugPalette'
export const COMPILED_TERMS: readonly CompiledTerm[] = ['vignette', 'foveaBend', 'debugPalette']

export interface ShaderFeatureState {
  /** design.maskMode: 2 is the vignette. */
  maskMode: number
  foveation: boolean
  /** The inspector: 0 off, 1 level, 2 error headroom. */
  debugMode: number
  /** The inspector's isolate setting: 0 all tiles, 1 terminal, 2 one level. */
  debugIsolate: number
}

export type CompiledTermFlags = Record<CompiledTerm | 'debugIsolate', boolean>

/**
 * The terms the shaders need for this state. `forced` keeps a term in while its feature
 * is off — the old, inert shader, which is the other side of a pixel or GPU-time A/B.
 * The inspector's isolate cut rides along: it was already compiled out this way.
 */
export function compiledTermsWanted(
  state: ShaderFeatureState,
  forced: ReadonlySet<CompiledTerm> = new Set(),
): CompiledTermFlags {
  const inspecting = state.debugMode > 0
  return {
    // The shader's own test for the vignette mode.
    vignette: state.maskMode > 1.5 || forced.has('vignette'),
    foveaBend: state.foveation || forced.has('foveaBend'),
    debugPalette: inspecting || forced.has('debugPalette'),
    debugIsolate: inspecting && state.debugIsolate > 0,
  }
}

/**
 * The feature state a session starts in: the configured mask mode and foveation, and the
 * inspector as the panel's markup starts it (Off, isolate Terminal) — the buttons marked
 * `on` that main.ts's bindSeg reads at load.
 */
export const BOOT_FEATURE_STATE: ShaderFeatureState = {
  maskMode: EXPERIENCE_CONFIG.design.maskMode,
  foveation: EXPERIENCE_CONFIG.lod.foveation.enabled,
  debugMode: 0,
  debugIsolate: 1,
}

/** The terms the first tile is built with, so booting in that state rebuilds nothing. */
export function compiledTermsAtBoot(): CompiledTermFlags {
  return compiledTermsWanted(BOOT_FEATURE_STATE)
}
