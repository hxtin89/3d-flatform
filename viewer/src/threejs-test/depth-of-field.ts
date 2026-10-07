// Depth of field as a post pass. Everything else in this scene grades colour
// inside the existing node materials (see point-cloud.ts) precisely so no extra
// pass is needed — DoF is the exception: a circle of confusion needs to read
// neighbouring pixels, which a per-fragment colour node cannot do.
//
// Eye-dome lighting (eye-dome-lighting.ts) is the other exception for the same reason
// — it reads neighbouring depth — and rides in the same pipeline so the scene is drawn
// into a pass once whichever of the two is on. EDL runs first, so DoF blurs shaded
// edges rather than EDL outlining blurred ones. The volumetric ground fog (ground-fog.ts)
// is a third stage between them: it composites over the shaded scene, and DoF then blurs
// the fog with the ground behind it. With all three off and no output stage the frame goes
// straight to the canvas and no graph exists.
//
// An output stage (setOutputStage; the colour grade's LUT tap in grade-output.ts) works on
// the displayed frame: after the tone curve and the sRGB encode, in the same final quad, so
// it adds no pass. While one is set the pipeline's own output transform is off and the graph
// does it with renderOutput, which reads the tone mapping and colour space the pipeline puts
// into its context; the no-post path then renders through the pipeline as well, scene pass
// then quad. With no stage set the graph is the one from before stages existed, object for
// object, and the no-post path is a plain renderer.render again.
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
// RenderPipeline is what PostProcessing was renamed to in r183; PostProcessing is now a
// subclass that only adds a deprecation warning (renderers/common/PostProcessing.js).
import { NodeUpdateType, RenderPipeline } from 'three/webgpu'
import { pass, renderOutput, rtt, uniform } from 'three/tsl'
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js'
import { EXPERIENCE_CONFIG } from './config'
import { eyeDomeLighting } from './eye-dome-lighting'

/**
 * A node function for the end of the final quad. It gets the frame as displayed — a vec4
 * after the tone curve and the sRGB encode, what a screenshot shows, alpha 1 — and returns
 * what the canvas gets.
 */
export type OutputStage = (display: any) => any

export interface DepthOfFieldLayer {
  /** Draw the frame. Falls back to a plain renderer.render while DoF, eye-dome lighting
   * and the ground fog are all off and no output stage is set, so that costs exactly what
   * it did before this module existed. */
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
  /** Eye-dome lighting. Off drops it from the graph; with DoF and the ground fog also off,
   *  the post pass leaves the frame altogether. */
  setEyeDome(enabled: boolean): void
  isEyeDome(): boolean
  setEyeDomeStrength(strength: number): void
  setEyeDomeRadius(pixels: number): void
  /** Darkest shade EDL may apply, 0–1 of the original brightness. */
  setEyeDomeFloor(fraction: number): void
  /** A stage after the output transform (tone curve + sRGB encode) in the final quad; null
   * restores the graph from before stages existed. While one is set, the no-post path also
   * renders through the pipeline. Compared by reference: setting the same function again does
   * nothing; any other one, null included, rebuilds the final quad on the next render, never
   * from three's cache. With DoF on that rebuild also rebuilds DoF's passes, its CoC blur and
   * the EDL quad (see applyOutput). DoF's and EDL's render targets are kept. */
  setOutputStage(stage: OutputStage | null): void
  hasOutputStage(): boolean
  /** The volumetric ground fog stage, or null to drop it from the graph. Also call after
   *  the fog's own build options change: the graph is rebuilt either way. */
  setGroundFog(fog: GroundFogStage | null): void
  dispose(): void
}

/** What the pipeline needs from the fog: a node that composites a colour through it. */
export interface GroundFogStage {
  build(color: any, depth: any): any
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
  const eyeDomeFloor = uniform(EDL.floor)
  let groundFog: GroundFogStage | null = null

  const pipeline = new RenderPipeline(renderer)
  // The end of the effect chain (scene pass, EDL, DoF) as rebuild() last left it, and the
  // stage after the output transform, if any. applyOutput() puts the two into the pipeline.
  let effectNode: any = null
  let outputStage: OutputStage | null = null
  // What the current graph owns and nothing else frees. A DoF node carries six render
  // targets (40–60 MB at full resolution) and its CoC blur two more; the texture that
  // feeds DoF the shaded, fogged scene is one more full-resolution target (the fog frees its
  // own march target when it rebuilds). The graph is rebuilt on every switch,
  // so each rebuild must release the previous one, or toggling for an fps A/B leaks VRAM.
  let dofNode: any = null
  let eyeDomeTexture: any = null
  // The CoC blur the last pipeline render drew. DoF's setup() makes a new one, with two new
  // render targets the size and type of the full-resolution CoC map, every time the quad that
  // holds DoF is built again (DepthOfFieldNode.js:381, GaussianBlurNode.js:80-89, :183-188):
  // on an output stage change and a renderer.toneMapping change too, not only after rebuild().
  // Nothing in three frees the blur it replaces, so render() does.
  let cocBlur: any = null
  const freeReplacedBlur = () => {
    const blur = dofNode?._CoCBlurredMaterial?.colorNode ?? null
    if (cocBlur && cocBlur !== blur) cocBlur.dispose()
    cocBlur = blur
  }
  const release = () => {
    if (dofNode) {
      // DoF's own dispose() skips the gaussianBlur it builds for the CoC.
      const blur = dofNode._CoCBlurredMaterial?.colorNode
      blur?.dispose?.()
      if (cocBlur && cocBlur !== blur) cocBlur.dispose()
      dofNode.dispose()
      dofNode = null
    }
    cocBlur = null
    if (eyeDomeTexture) {
      // RTTNode has no dispose(): free its target and the quad material it draws with.
      eyeDomeTexture.renderTarget.dispose()
      eyeDomeTexture._quadMesh?.material?.dispose()
      eyeDomeTexture = null
    }
  }
  // Changes what the final quad holds; the effect chain and the targets release() frees stay.
  // The next render builds the quad again, never from three's cache: the pipeline wraps its
  // output in a new context node on every update (RenderPipeline.js:200-226) and a node's cache
  // key is its id (Node.js:470-474), so even a change back to an earlier stage is a new build.
  // With DoF in the chain the rebuild is not the quad alone. The new builder runs DoF's setup()
  // again, which gives its five pass materials new nodes and a new CoC blur
  // (DepthOfFieldNode.js:375-470), and with EDL on the EDL quad follows (RTTNode.js:150-154):
  // nine node builds over two frames with both on, seven with DoF alone, one without DoF.
  const applyOutput = () => {
    if (outputStage) {
      // renderOutput without arguments takes the tone mapping and the output colour space
      // from the context, which the pipeline fills in when its own transform is off
      // (RenderPipeline.js:214-219, RenderOutputNode.js:119-121). The pipeline still
      // rebuilds on a renderer.toneMapping change (RenderPipeline.js:181-186), so switching
      // the film curve or its parts keeps working with a stage set.
      pipeline.outputColorTransform = false
      pipeline.outputNode = outputStage(renderOutput(effectNode))
    } else {
      // The graph from before stages existed: three's own output transform around the chain.
      pipeline.outputColorTransform = true
      pipeline.outputNode = effectNode
    }
    pipeline.needsUpdate = true
  }
  const drawingBufferSize = new THREE.Vector2()
  // Rebuilt only when an effect is switched, never per frame. Each switch changes the
  // graph's shape, so the pipeline recompiles its output material once. The old graph is
  // released first: the next render swaps the new one in before drawing anything.
  const rebuild = () => {
    release()
    const sceneColor = scenePass.getTextureNode()
    let node: any = sceneColor
    if (eyeDome) {
      node = eyeDomeLighting(node, scenePass.getTextureNode('depth'), camera, eyeDomeStrength, eyeDomeRadius, eyeDomeFloor)
    }
    if (groundFog) node = groundFog.build(node, scenePass.getTextureNode('depth'))
    if (enabled && node !== sceneColor) {
      // DoF samples its input from three separate draws. Left to dof()'s own
      // convertToTexture, the EDL and fog composite re-rendered for each of them; an
      // explicit target updated once per frame renders them once. Sized now, because DoF
      // sizes its own targets from this one on its first frame.
      eyeDomeTexture = rtt(node, null, null, { type: THREE.HalfFloatType, depthBuffer: false })
      eyeDomeTexture.updateBeforeType = NodeUpdateType.FRAME
      renderer.getDrawingBufferSize(drawingBufferSize)
      eyeDomeTexture.setSize(drawingBufferSize.x, drawingBufferSize.y)
      node = eyeDomeTexture
    }
    if (enabled) {
      dofNode = dof(node, scenePass.getViewZNode(), focusDistanceUniform, focalLengthUniform, bokehScaleUniform)
      node = dofNode
    }
    // With both effects off this is the scene pass's texture, which release() never frees:
    // the chain a stage gets on the no-post path.
    effectNode = node
    applyOutput()
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
      if (!enabled && !eyeDome && !groundFog && !outputStage) {
        renderer.render(scene, camera)
        return
      }
      pipeline.render()
      // A rebuilt quad has run DoF's setup() before DoF drew (Renderer.js:3692-3712: the build
      // comes before updateBefore), so the blur it replaced was not drawn in this render.
      freeReplacedBlur()
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
    setEyeDomeFloor(fraction) { eyeDomeFloor.value = THREE.MathUtils.clamp(fraction, 0, 1) },
    setOutputStage(stage) {
      if (stage === outputStage) return
      outputStage = stage
      // No release() and no rebuild(): the chain stays. With DoF on, the quad's rebuild still
      // re-runs DoF's setup() (applyOutput), and render() frees the CoC blur it replaces.
      applyOutput()
    },
    hasOutputStage() { return outputStage !== null },
    setGroundFog(fog) {
      groundFog = fog
      rebuild()
    },
    dispose() {
      release()
      pipeline.dispose()
    },
  }
}
