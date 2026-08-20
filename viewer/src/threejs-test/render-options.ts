/**
 * Runtime toggles for every performance optimisation layered on top of the core
 * zoom-dependent density (the SSE band ladder in adaptive-quality.ts — that one
 * is the comparison subject against the Cesium viewer and never switches off).
 *
 * Two-level state: `requested` holds the user's individual toggle choices;
 * `effective()` is what the app actually applies. Compare mode overrides
 * `requested` with COMPARE_PROFILE without overwriting it, so leaving compare
 * mode restores the exact prior configuration.
 */

export interface RenderOptions {
  /** Diagnostic APH mode: refine every leaf in the active camera frustum. */
  leafLoading: boolean
  /** Scale the per-tile error by the cosine of the viewing angle onto the ground. */
  viewAngleError: boolean
  /** Boot-SSE brake (256 while loading) + flight SSE floor/ramp. */
  sseBrakes: boolean
  /** Distance fog + per-preset far-plane scaling (shortens the view). */
  fogAtmosphere: boolean
  /** Daylight colour grading on points/imagery, golden rim, cloud shadows. */
  daylightGrading: boolean
  /** GLTF props: tower, boat, parrots. */
  fieldModels: boolean
  /** Interactive hotspot markers (DOM chips + 3D geometry). */
  markers: boolean
  /** Donation shape: protected-parcel outline, 1 m² grid and area chip. */
  donationShape: boolean
  /** Camera-height point-size curve; off = fixed base size × slider. */
  dynamicPointSize: boolean
  /** Bench-preset memory budgets; off = fixed high budgets. */
  presetBudgets: boolean
  /** Pixel-ratio cap from the bench preset; off = full devicePixelRatio. */
  pixelRatioCap: boolean
  /** Matrix-precision drop during camera flights. */
  flightPrecisionDrop: boolean
  /** Satellite basemap imagery (globe structure/navigation always stays). */
  basemapImagery: boolean
}

export type RenderOptionKey = keyof RenderOptions

export const DEFAULT_OPTIONS: RenderOptions = {
  leafLoading: false,
  // Off: the cosine correction assumes the points sample a surface, and a canopy is a
  // volume — see view-angle.ts. It costs real detail even looking straight down,
  // because only the tile directly beneath the camera is seen face-on.
  viewAngleError: false,
  sseBrakes: true,
  fogAtmosphere: true,
  daylightGrading: true,
  fieldModels: true,
  markers: true,
  donationShape: true,
  dynamicPointSize: true,
  presetBudgets: true,
  pixelRatioCap: true,
  // Off by default: motion is exactly when jitter is noticed, and each switch
  // sets needsUpdate on every live tile material — a pipeline rebuild for
  // hundreds of materials at the start and end of every flight.
  flightPrecisionDrop: false,
  basemapImagery: true,
}

/** Compare mode: every optimisation off; only the point cloud with the SSE
 * band ladder, navigation and (per user decision) the basemap remain. */
export const COMPARE_PROFILE: RenderOptions = {
  leafLoading: false,
  viewAngleError: false,
  sseBrakes: false,
  fogAtmosphere: false,
  daylightGrading: false,
  fieldModels: false,
  markers: false,
  donationShape: false,
  dynamicPointSize: false,
  presetBudgets: false,
  pixelRatioCap: false,
  flightPrecisionDrop: false,
  basemapImagery: true,
}

export interface RenderOptionRow {
  key: RenderOptionKey
  label: string
  onText: string
  offText: string
  note: string
}

/** Panel rows, in display order. Test UI is English (user decision). */
export const RENDER_OPTION_ROWS: RenderOptionRow[] = [
  {
    key: 'leafLoading',
    label: 'Leaf loading',
    onText: '🌲 Leaves · All visible',
    offText: '🌲 Leaves · Normal',
    note: 'APH diagnostic: refine every leaf in the camera view; disables the mask gate and keeps up to 16 GiB resident',
  },
  {
    key: 'viewAngleError',
    label: 'View-angle error',
    onText: '◺ Angle · On',
    offText: '◺ Angle · Off',
    note: 'Scales each tile error by how squarely the ground faces the camera. Tilting foreshortens the ground, so the points squeeze together on screen and a level the plain distance quotient asks for is not needed. Off restores that quotient',
  },
  {
    key: 'sseBrakes',
    label: 'SSE brakes',
    onText: '⏳ Brakes · On',
    offText: '⏳ Brakes · Off',
    note: 'Coarse density while loading (SSE 256) and during camera flights (SSE 64)',
  },
  {
    key: 'fogAtmosphere',
    label: 'Fog & view distance',
    onText: '🌫 Fog · On',
    offText: '🌫 Fog · Off',
    note: 'Distance fog + device-dependent view-distance cut (culls far tiles)',
  },
  {
    key: 'daylightGrading',
    label: 'Daylight grading',
    onText: '🌗 Grading · On',
    offText: '🌗 Grading · Off',
    note: 'Peru time of day tints points, map and sky; off = neutral light',
  },
  {
    key: 'fieldModels',
    label: '3D models',
    onText: '🗼 Models · On',
    offText: '🗼 Models · Off',
    note: 'Tower, boat, parrots (GLTF)',
  },
  {
    key: 'markers',
    label: 'Markers',
    onText: '📍 Markers · On',
    offText: '📍 Markers · Off',
    note: 'Interactive hotspots (chips + 3D pins)',
  },
  {
    key: 'donationShape',
    label: 'Donation shape',
    onText: '🌳 Shape · On',
    offText: '🌳 Shape · Off',
    note: 'Protected-parcel outline from GeoJSON — footprint, 1 m² cell grid and area chip',
  },
  {
    key: 'dynamicPointSize',
    label: 'Dynamic point size',
    onText: '⚫ Size curve · On',
    offText: '⚫ Size curve · Off',
    note: 'Point size follows camera height (masks density holes); off = fixed size × slider',
  },
  {
    key: 'presetBudgets',
    label: 'Memory budgets',
    onText: '🧮 Budgets · Device',
    offText: '🧮 Budgets · Max',
    note: 'Cache/GPU limits from the device benchmark; off = fixed high budgets',
  },
  {
    key: 'pixelRatioCap',
    label: 'Pixel-ratio cap',
    onText: '🖥 Resolution · Capped',
    offText: '🖥 Resolution · Full',
    note: 'Render resolution capped at ≤1.25×; off = full display resolution',
  },
  {
    key: 'flightPrecisionDrop',
    label: 'Flight precision',
    onText: '◈ Flight drop · On',
    offText: '◈ Flight drop · Off',
    note: 'Matrix precision drops to float32 during camera flights (jitter visible)',
  },
  {
    key: 'basemapImagery',
    label: 'Basemap',
    onText: '🗺 Basemap · On',
    offText: '🗺 Basemap · Off',
    note: 'Satellite imagery; globe/navigation always stay active',
  },
]

export interface RenderOptionsController {
  effective(): Readonly<RenderOptions>
  requested(): Readonly<RenderOptions>
  isCompareMode(): boolean
  setOption(key: RenderOptionKey, on: boolean): void
  setCompareMode(on: boolean): void
}

/**
 * @param onApply receives the new effective snapshot plus the keys whose
 * effective value changed. Called once per transition — the render loop reads
 * `effective()` directly instead of subscribing.
 */
export function createRenderOptions(
  onApply: (effective: Readonly<RenderOptions>, changed: RenderOptionKey[], compareMode: boolean) => void,
): RenderOptionsController {
  const requested: RenderOptions = { ...DEFAULT_OPTIONS }
  let compareMode = false
  let current: RenderOptions = { ...requested }

  function recompute(): void {
    const next: RenderOptions = compareMode ? { ...COMPARE_PROFILE } : { ...requested }
    const changed = (Object.keys(next) as RenderOptionKey[]).filter((key) => next[key] !== current[key])
    current = next
    if (changed.length) onApply(current, changed, compareMode)
  }

  return {
    effective: () => current,
    requested: () => requested,
    isCompareMode: () => compareMode,
    setOption(key, on) {
      if (requested[key] === on) return
      requested[key] = on
      if (!compareMode) recompute()
    },
    setCompareMode(on) {
      if (compareMode === on) return
      compareMode = on
      recompute()
    },
  }
}
