// Depth of field as a post pass. Everything else in this scene grades colour
// inside the existing node materials (see point-cloud.ts) precisely so no extra
// pass is needed — DoF is the exception: a circle of confusion needs to read
// neighbouring pixels, which a per-fragment colour node cannot do.
//
// A per-point version was tried and dropped: growing each sprite by its own
// circle of confusion is cheaper, but the point cloud is rendered opaque with
// depthWrite on, so grown discs cannot blend and the effect degenerates into a
// flat wash instead of reading as defocus.
//
// Built on three's TSL `dof` node, so it runs on the WebGPU backend and on the
// WebGL2 fallback (`?webgl`) without a second code path. The renderer is created
// with `antialias: false`, so routing through a pass costs no MSAA.
import * as THREE from 'three'
import { PostProcessing } from 'three/webgpu'
import { pass, uniform } from 'three/tsl'
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js'
import { EXPERIENCE_CONFIG } from './config'

export interface DepthOfFieldLayer {
  /** Draw the frame. Falls back to a plain renderer.render when disabled, so
   * turning DoF off costs exactly what it did before this module existed. */
  render(): void
  /** Advance the auto-focus toward `groundRangeM`. Call once per frame before
   * render(); ignored while autoFocus is off. */
  update(groundRangeM: number): void
  setEnabled(enabled: boolean): void
  isEnabled(): boolean
  setAutoFocus(enabled: boolean): void
  isAutoFocus(): boolean
  /** Focus distance in metres. With autoFocus on this is an offset added to the
   * measured ground range; with it off, the absolute distance. */
  setFocusDistance(metres: number): void
  setFocalLength(metres: number): void
  setBokehScale(scale: number): void
  setFocusSmoothing(factor: number): void
  dispose(): void
}

export function createDepthOfFieldLayer(opts: {
  renderer: THREE.WebGLRenderer | any
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
}): DepthOfFieldLayer {
  const { renderer, scene, camera } = opts
  const CONFIG = EXPERIENCE_CONFIG.depthOfField

  // Annotated rather than inferred: EXPERIENCE_CONFIG is `as const`, so these
  // would otherwise take the literal type of their default and reject any edit.
  let enabled: boolean = CONFIG.enabled
  let autoFocus: boolean = CONFIG.autoFocus
  let focusDistanceM: number = CONFIG.focusDistanceM
  let focusSmoothing: number = CONFIG.focusSmoothing
  // Seeded with the configured focal length, not 0: a first frame focused at the
  // near plane blurs the entire scene into a smear before update() first lands.
  let smoothedGroundRangeM: number = CONFIG.focalLengthM

  // The pass is built once. `focusDistance`, `focalLength` and `bokehScale` are
  // uniforms rather than plain numbers so the panel can retune them live without
  // recompiling the node graph.
  const scenePass = pass(scene, camera)
  const focusDistanceUniform = uniform(focusDistanceM)
  const focalLengthUniform = uniform(CONFIG.focalLengthM)
  const bokehScaleUniform = uniform(CONFIG.bokehScale)

  const postProcessing = new PostProcessing(renderer)
  postProcessing.outputNode = dof(
    scenePass.getTextureNode(),
    scenePass.getViewZNode(),
    focusDistanceUniform,
    focalLengthUniform,
    bokehScaleUniform,
  )

  const applyFocus = () => {
    // Metres in front of the camera the focal plane sits. Clamped off zero: a
    // focus distance at the camera puts the entire scene behind the far edge of
    // the in-focus band, which reads as a uniform blur rather than as DoF.
    const distance = autoFocus ? smoothedGroundRangeM + focusDistanceM : focusDistanceM
    focusDistanceUniform.value = Math.max(distance, 1)
  }
  applyFocus()

  return {
    render() {
      if (enabled) postProcessing.render()
      else renderer.render(scene, camera)
    },
    update(groundRangeM) {
      if (!enabled || !autoFocus) return
      // Ground range is Infinity whenever the centre ray misses the ground
      // plane (camera pointed at the sky). Holding the last good value keeps
      // the focal plane still instead of snapping to the far distance.
      if (!Number.isFinite(groundRangeM) || groundRangeM <= 0) return
      smoothedGroundRangeM = THREE.MathUtils.lerp(
        smoothedGroundRangeM, groundRangeM, focusSmoothing,
      )
      applyFocus()
    },
    setEnabled(next) { enabled = next },
    isEnabled() { return enabled },
    setAutoFocus(next) { autoFocus = next; applyFocus() },
    isAutoFocus() { return autoFocus },
    setFocusDistance(metres) { focusDistanceM = metres; applyFocus() },
    setFocalLength(metres) { focalLengthUniform.value = Math.max(metres, 1) },
    setBokehScale(scale) { bokehScaleUniform.value = scale },
    setFocusSmoothing(factor) { focusSmoothing = THREE.MathUtils.clamp(factor, 0.005, 1) },
    dispose() {
      postProcessing.dispose?.()
    },
  }
}
