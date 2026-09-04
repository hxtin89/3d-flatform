// Imperative handles of the scene layers. Written on mount/unmount only;
// frame code reads them through getState(), React only reads availability.
import { create } from 'zustand'
import type { StreamingCloud } from '../../threejs-test/streaming'
import type { KeyboardNavigation } from '../../threejs-test/keyboard-navigation'
import type { EnvironmentLayer } from '../../threejs-test/environment-layer'
import type { MarkerLayer } from '../../threejs-test/marker-layer'
import type { DonationShapeLayer } from '../../threejs-test/donation-shape-layer'
import type { RainLayer } from '../../threejs-test/rain-layer'
import type { AudioLayer } from '../../threejs-test/audio-layer'
import type { EagleBench } from '../../threejs-test/eagle-bench'
import type { PointSourceController, ResolvedSource } from '../../threejs-test/point-source'
import type { RenderOptionsController } from '../../threejs-test/render-options'
import { AdaptiveQualityController, APH_BAND_SSE } from '../../threejs-test/adaptive-quality'
import type { CaptionLayer } from '../../threejs-test/caption-layer'
import type { Globe } from '../scene/globe'
import type { CameraRig } from '../camera/rig-types'
import { APP_PARAMS } from '../params'

interface SceneState {
  stream: StreamingCloud | null
  globe: Globe | null
  keyboard: KeyboardNavigation | null
  environment: EnvironmentLayer | null
  markers: MarkerLayer | null
  donation: DonationShapeLayer | null
  rain: RainLayer | null
  audio: AudioLayer | null
  bench: EagleBench | null
  captions: CaptionLayer | null
  rig: CameraRig | null
  adaptiveQuality: AdaptiveQualityController
  renderOptions: RenderOptionsController | null
  pointSource: PointSourceController | null
  /** Drives <PointTiles>: a new key rebuilds the streamer. */
  activeSource: ResolvedSource | null
  swapReason: string
}

export const useSceneStore = create<SceneState>(() => ({
  stream: null,
  globe: null,
  keyboard: null,
  environment: null,
  markers: null,
  donation: null,
  rain: null,
  audio: null,
  bench: null,
  captions: null,
  rig: null,
  adaptiveQuality: new AdaptiveQualityController(APP_PARAMS.pointTree === 'aph' ? APH_BAND_SSE : undefined),
  renderOptions: null,
  pointSource: null,
  activeSource: null,
  swapReason: 'boot',
}))

export const sceneState = useSceneStore.getState
