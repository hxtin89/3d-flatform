// Depth of field as a post pass. Everything else in this scene grades colour
// inside the existing node materials (see point-cloud.ts) precisely so no extra
// pass is needed — DoF is the exception: a circle of confusion needs to read
// neighbouring pixels, which a per-fragment colour node cannot do.
//
// Eye-dome lighting (eye-dome-lighting.ts) is the other exception for the same reason
// — it reads neighbouring depth — and rides in the same pipeline so the scene is drawn
// into a pass once whichever of the two is on. EDL runs first, so DoF blurs shaded
// edges rather than EDL outlining blurred ones. With both off the frame goes straight to
// the canvas and neither graph exists.
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
import { NodeUpdateType, PostProcessing } from 'three/webgpu'
import { pass, rtt, uniform } from 'three/tsl'
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js'
import { EXPERIENCE_CONFIG } from './config'
import { eyeDomeLighting } from './eye-dome-lighting'

export interface DepthOfFieldLayer {
  /** Draw the frame. Falls back to a plain renderer.render while DoF and eye-dome
   * lighting are both off, so that costs exactly what it did before this module existed. */
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
  /** Eye-dome lighting. Off drops it from the graph; with DoF also off, from the frame. */
  setEyeDome(enabled: boolean): void
  isEyeDome(): boolean
  setEyeDomeStrength(strength: number): void
  setEyeDomeRadius(pixels: number): void
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

  const EDL = EXPERIENCE_CONFIG.eyeDomeLighting
  let eyeDome: boolean = EDL.enabled
  const eyeDomeStrength = uniform(EDL.strength)
  const eyeDomeRadius = uniform(Math.max(Math.round(EDL.radiusPx), 1))

  const postProcessing = new PostProcessing(renderer)
  // What the current graph owns and nothing else frees. A DoF node carries six render
  // targets (40–60 MB at full resolution) and its CoC blur two more; the EDL texture that
  // feeds DoF is one more full-resolution target. The graph is rebuilt on every switch,
  // so each rebuild must release the previous one, or toggling for an fps A/B leaks VRAM.
  let dofNode: any = null
  let eyeDomeTexture: any = null
  const release = () => {
    if (dofNode) {
      // DoF's own dispose() skips the gaussianBlur it builds for the CoC.
      dofNode._CoCBlurredMaterial?.colorNode?.dispose?.()
      dofNode.dispose()
      dofNode = null
    }
    if (eyeDomeTexture) {
      // RTTNode has no dispose(): free its target and the quad material it draws with.
      eyeDomeTexture.renderTarget.dispose()
      eyeDomeTexture._quadMesh?.material?.dispose()
      eyeDomeTexture = null
    }
  }
  const drawingBufferSize = new THREE.Vector2()
  // Rebuilt only when an effect is switched, never per frame. Each switch changes the
  // graph's shape, so the pipeline recompiles its output material once. The old graph is
  // released first: the next render swaps the new one in before drawing anything.
  const rebuild = () => {
    release()
    let node: any = scenePass.getTextureNode()
    if (eyeDome) {
      node = eyeDomeLighting(node, scenePass.getTextureNode('depth'), camera, eyeDomeStrength, eyeDomeRadius)
      if (enabled) {
        // DoF samples its input from three separate draws. Left to dof()'s own
        // convertToTexture, the EDL quad re-rendered for each of them; an explicit target
        // updated once per frame renders it once. Sized now, because DoF sizes its own
        // targets from this one on its first frame.
        eyeDomeTexture = rtt(node, null, null, { type: THREE.HalfFloatType, depthBuffer: false })
        eyeDomeTexture.updateBeforeType = NodeUpdateType.FRAME
        renderer.getDrawingBufferSize(drawingBufferSize)
        eyeDomeTexture.setSize(drawingBufferSize.x, drawingBufferSize.y)
        node = eyeDomeTexture
      }
    }
    if (enabled) {
      dofNode = dof(node, scenePass.getViewZNode(), focusDistanceUniform, focalLengthUniform, bokehScaleUniform)
      node = dofNode
    }
    postProcessing.outputNode = node
    postProcessing.needsUpdate = true
  }
  rebuild()

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
      if (enabled || eyeDome) postProcessing.render()
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
    setEnabled(next) {
      if (next === enabled) return
      enabled = next
      rebuild()
    },
    isEnabled() { return enabled },
    setAutoFocus(next) { autoFocus = next; applyFocus() },
    isAutoFocus() { return autoFocus },
    setFocusDistance(metres) { focusDistanceM = metres; applyFocus() },
    setFocalLength(metres) { focalLengthUniform.value = Math.max(metres, 1) },
    setBokehScale(scale) { bokehScaleUniform.value = scale },
    setFocusSmoothing(factor) { focusSmoothing = THREE.MathUtils.clamp(factor, 0.005, 1) },
    setEyeDome(next) {
      if (next === eyeDome) return
      eyeDome = next
      rebuild()
    },
    isEyeDome() { return eyeDome },
    setEyeDomeStrength(strength) { eyeDomeStrength.value = Math.max(strength, 0) },
    setEyeDomeRadius(pixels) { eyeDomeRadius.value = Math.max(Math.round(pixels), 1) },
    dispose() {
      release()
      postProcessing.dispose?.()
    },
  }
}
