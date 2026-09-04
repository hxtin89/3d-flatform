// Everything React renders. Frame code publishes here at most a few times a
// second; per-frame values live in state/frame.ts.
import { create } from 'zustand'
import { DEFAULT_OPTIONS, type RenderOptions } from '../../threejs-test/render-options'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import type { DonationShapeForm, DonationShapeStyle } from '../../threejs-test/donation-shape-data'
import type { CloudState, DaylightPhase } from '../../threejs-test/environment-layer'
import type { ZoomBand } from '../../threejs-test/point-source'
import { APP_PARAMS } from '../params'

export interface HudSnapshot {
  density: string
  sse: number
  points: number
  pointTiles: number
  mapTiles: number
  cacheBytes: number
  gpuBytes: number
  fps: number
  frameMs: number
  altitude: number | null
  range: number | null
  clearance: number
  missingTiles: number
  originDistance: number
  rebases: number
  distanceCutoff: number
}

export interface ZoomSnapshot {
  band: ZoomBand
  bandLabel: string
  range: number
  sse: number
  sourceLabel: string
  sourcePath: string
}

export type RigMode = 'idle' | 'story' | 'user' | 'resuming' | 'flyTo'

interface UiState {
  hudOpen: boolean
  panelOpen: boolean
  timeDockOpen: boolean
  backendLabel: string
  statusLine: string
  requested: RenderOptions
  effective: RenderOptions
  compareMode: boolean
  maskMode: number
  pointSizeScale: number
  pointSizePx: number
  highPrecision: boolean
  heightOffset: boolean
  donationStyle: DonationShapeStyle
  donationForm: DonationShapeForm
  donationSmoothness: number
  cloudState: CloudState | null
  daylight: { timeLabel: string; live: boolean; phase: DaylightPhase; peruMinutes: number } | null
  rainCycleEnabled: boolean
  rainRequested: boolean
  rainVisualActive: boolean
  aimMode: boolean
  aimLabel: string
  aimHasTarget: boolean
  interactionMessage: string
  videoOpen: boolean
  splatSolo: boolean
  splatMessage: string
  frameloop: 'always' | 'never'
  dpr: number
  hud: HudSnapshot | null
  zoom: ZoomSnapshot | null
  /** Bumped when the point-source controller changed on its own. */
  packsVersion: number
  rigMode: RigMode
  vignetteOpacity: number
}

export const useUiStore = create<UiState>(() => ({
  hudOpen: !APP_PARAMS.compactViewport,
  panelOpen: APP_PARAMS.panelEnabled && !APP_PARAMS.compactViewport,
  timeDockOpen: false,
  backendLabel: '…',
  statusLine: 'Initializing…',
  requested: { ...DEFAULT_OPTIONS },
  effective: { ...DEFAULT_OPTIONS },
  compareMode: false,
  maskMode: 2,
  pointSizeScale: 1,
  pointSizePx: 0,
  highPrecision: true,
  heightOffset: true,
  donationStyle: EXPERIENCE_CONFIG.donationShape.defaultStyle,
  donationForm: EXPERIENCE_CONFIG.donationShape.defaultForm,
  donationSmoothness: EXPERIENCE_CONFIG.donationShape.smoothness,
  cloudState: null,
  daylight: null,
  rainCycleEnabled: true,
  rainRequested: false,
  rainVisualActive: false,
  aimMode: false,
  aimLabel: 'Ziel suchen',
  aimHasTarget: false,
  interactionMessage: '',
  videoOpen: false,
  splatSolo: false,
  splatMessage: '',
  frameloop: 'always',
  dpr: APP_PARAMS.compareParam ? window.devicePixelRatio : Math.min(window.devicePixelRatio, 1.25),
  hud: null,
  zoom: null,
  packsVersion: 0,
  rigMode: 'idle',
  vignetteOpacity: 0,
}))

export const uiState = useUiStore.getState
