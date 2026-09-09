// useFrame priorities. All negative: R3F runs subscribers in ascending order
// and renders itself afterwards as long as no subscriber uses a priority > 0.
// Each phase is unique, because equal priorities run in mount order.
export const PHASE = {
  /** frame.now, fps.tick, updateOrigin() — one origin for the whole frame. */
  ORIGIN: -100,
  /** The single camera writer: story/resume/fly-to springs or keyboard. */
  CAMERA: -90,
  /** controls.update → navigation floor. */
  CONTROLS: -70,
  /** Screen-centre ground hit → camera ranges, vignette mask. */
  MASK: -40,
  /** Point distance cutoff. */
  CUTOFF: -35,
  /** Sole owner of camera.near/far and the fog range. */
  PLANES: -30,
  /** Raster traversal with the final camera projection and atmosphere. */
  BASEMAP: -25,
  /** Adaptive quality, SSE, density ceiling, point tiles.update, stats. */
  STREAM: -20,
  /** Daylight + clouds. */
  ENVIRONMENT: -15,
  /** Donation shape, markers, aim target. */
  LAYERS: -10,
  RAIN: -8,
  AUDIO: -6,
  /** Loader readiness gate and the throttled HUD snapshot. */
  HUD: -4,
} as const
