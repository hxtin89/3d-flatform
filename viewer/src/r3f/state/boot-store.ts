// Boot phase machine and the static data the boot sequence produces.
import { create } from 'zustand'
import type * as THREE from 'three'
import type { GlobeManifest } from '../../threejs-test/manifest'
import type { DonationShapeSource } from '../../threejs-test/donation-shape-data'
import type { BenchPreset } from '../../threejs-test/eagle-bench'
import { frame } from './frame'

export type BootPhase =
  | 'init'      // Canvas is creating the renderer
  | 'graphics'  // renderer initialised, cloud texture registered
  | 'manifest'  // manifest fetch in flight
  | 'staging'   // frames seeded, scene mounted, camera parked at the parcel
  | 'ready'     // data ready + progress eased to 100 % → "Expedition starten"
  | 'entering'  // start clicked, loader fading
  | 'entered'   // loader gone (old bootLoading === false)
  | 'failed'

interface BootState {
  phase: BootPhase
  status: string
  error: string | null
  stalled: boolean
  dataReady: boolean
  startWithSound: boolean
  isWebGPU: boolean | null
  manifest: GlobeManifest | null
  framesReady: boolean
  donationSource: DonationShapeSource | null
  /** "12.34567° S, 69.12345° W" for the story captions. */
  donationCoordinates: string | null
  benchPreset: BenchPreset
  cloudNoiseTexture: THREE.Data3DTexture | null
  /** performance.now() at which the loader hides after "Expedition starten". */
  finishAt: number
  setPhase(phase: BootPhase): void
  setStatus(status: string): void
  fail(message: string): void
  toggleSound(): void
}

export const useBootStore = create<BootState>((set) => ({
  phase: 'init',
  status: 'Initialisiere Feldsystem …',
  error: null,
  stalled: false,
  dataReady: false,
  startWithSound: false,
  isWebGPU: null,
  manifest: null,
  framesReady: false,
  donationSource: null,
  donationCoordinates: null,
  benchPreset: 'medium',
  cloudNoiseTexture: null,
  finishAt: 0,
  setPhase: (phase) => set({ phase }),
  setStatus: (status) => set({ status }),
  fail: (message) => set({ phase: 'failed', error: message, status: message }),
  toggleSound: () => set((s) => ({ startWithSound: !s.startWithSound })),
}))

/** True until the loader is gone (old `bootLoading`). */
export function isBootLoading(): boolean {
  const phase = useBootStore.getState().phase
  return phase !== 'entered'
}

/** Raise the loader's target progress (never lowers it) and optionally the
 * status line. Port of main.ts setLoadProgress. */
export function setLoadProgress(progress: number, status?: string): void {
  const next = Math.min(1, Math.max(0, progress))
  if (next > frame.loaderTarget + 0.001) {
    frame.loaderTarget = next
    frame.loaderLastAdvance = performance.now()
    if (useBootStore.getState().stalled) useBootStore.setState({ stalled: false })
  }
  if (status) useBootStore.setState({ status })
}
