// Temporal accumulation for the volumetric ground fog: the march's grain, averaged over frames.
//
// Why it is needed. The march takes a few dozen samples per ray and jitters where they fall,
// so every pixel carries a sampling error. Fixed per pixel, that error sits still on screen:
// with the camera still it reads as texture, but as soon as the camera moves the fog slides
// under the fixed pattern and every pixel's error changes each frame — the fog boils. A
// finer march resolution only makes the grains smaller.
//
// What this does. The march now jitters differently every frame (ground-fog.ts), and this pass
// blends each new march frame into the previous result, carried along with the camera:
//   · reprojection: every march texel's ray (through the texel's centre, as the march casts
//     it) is followed to where its fog's light mostly comes from — `distanceOf`, one mean
//     free path into the dense layer, never past the surface the ray ended on — and that
//     point is projected through last frame's camera to find where it was a frame ago. Last
//     frame's camera follows the floating origin's rebases, so a rebase costs nothing;
//   · depth-aware fetch: last frame's fog depth is kept, and the history is read from the
//     four texels around where the fog was, but only from those whose surface a frame ago lay
//     within `occlusion` × this ray's surface depth of it; where none do, the history is
//     dropped. Small values keep a crown's history from mixing into the gap's beside it, so
//     the fog's outlines stay sharp in motion. The default, 1, accepts anything from the
//     camera to twice the surface depth: beside a crown the test all but never fires, the
//     steadier, smearier trade chosen on 2026-09-30 (config.ts has the numbers);
//   · variance clipping: what is left of the history is clamped to the current 3×3
//     neighbourhood's mean ± `clip` standard deviations (Salvi 2016);
//   · blend: `blend` of the current frame, the rest from the clipped history. The default,
//     0.02, averages about fifty frames; the clip keeps that from trailing moving fog. Off
//     screen or hidden a frame ago, the first frame, or after a resize, the current frame alone.
// The pass runs at the march's resolution, before the depth-aware upsample: 18 texture reads a
// march texel (nine for the neighbourhood, the fog depth, four of last frame's depth and four
// of the history) and two copies a frame. History and output are HalfFloat RGBA at that size,
// the kept fog depth one HalfFloat channel, as the fog depth pass is.
//
// Measured 2026-09-30 (sideways move and yaw, pose B, 96 steps): fillCanopyHoles takes the
// fog's own frame-to-frame change down by about a fifth and does most of the work at high
// step counts; this filter takes a further 5–7 %, and more with fewer steps, where there is
// more grain to average. In the finished image most of the shimmer under a moving camera is
// the point cloud's own dots (fog off shimmers more than fog on), which no fog setting touches.
import * as THREE from 'three'
import { NodeMaterial, NodeUpdateType, QuadMesh, RenderTarget, RendererUtils, TempNode } from 'three/webgpu'
import {
  Fn, abs, clamp, float, floor, getViewPosition, ivec2, length, max, mix, normalize, passTexture, select, sqrt, texture,
  textureSize, uniform, uv, vec2, vec4,
} from 'three/tsl'
import { onRebase } from './origin'

export interface FogTemporalOptions {
  /** The march's output: RGB in-scattered light, A transmittance, at `resolutionScale()`. */
  march: any
  /** The fog depth pass (ground-fog.ts): each march texel's surface as linear view depth in
   *  `depthUnitM`, `skyDepth` where nothing was drawn. Same size as the march. */
  fogDepth: any
  depthUnitM: number
  skyDepth: number
  /** Where along a ray (render space: origin, unit direction) the fog's light mostly comes
   *  from, given the distance to the surface it ends on. A TSL function. */
  distanceOf: (origin: any, direction: any, surfaceDistance: any) => any
  /** The scene camera (not the post quad's). */
  camera: THREE.PerspectiveCamera
  /** The march's resolution scale, so history and output match its texels exactly. */
  resolutionScale: () => number
  /** Weight of the current frame, 0–1 (uniform). */
  blend: any
  /** Variance clip width in standard deviations (uniform). */
  clip: any
  /** How far last frame's depth may differ from where the point should be, relative, before
   *  the history there counts as another surface (uniform; large = never). */
  occlusion: any
}

const sizeOf = (node: any): any => (textureSize as any)(node, 0)
const drawingBufferSize = new THREE.Vector2()
const translation = new THREE.Matrix4()
let rendererState: any

export class FogTemporalNode extends TempNode {
  private readonly options: FogTemporalOptions
  private readonly historyTarget = new RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType })
  private readonly resolveTarget = new RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType })
  // One channel, as the fog depth it is copied from (ground-fog.ts): the copy needs the formats
  // to match.
  private readonly previousDepthTarget = new RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType, format: THREE.RedFormat })
  private readonly historyNode = texture(this.historyTarget.texture)
  private readonly previousDepthNode = texture(this.previousDepthTarget.texture)
  private readonly material = new NodeMaterial()
  private readonly quad = new QuadMesh()
  private readonly previousView = uniform(new THREE.Matrix4())
  private readonly previousProjection = uniform(new THREE.Matrix4())
  private readonly historyValid = uniform(0)
  private readonly output: any
  private readonly unsubscribeRebase: () => void
  private hasHistory = false

  constructor(options: FogTemporalOptions) {
    super('vec4')
    this.options = options
    this.updateBeforeType = NodeUpdateType.FRAME
    this.historyTarget.texture.name = 'GroundFog.temporal.history'
    this.resolveTarget.texture.name = 'GroundFog.temporal.resolve'
    this.previousDepthTarget.texture.name = 'GroundFog.temporal.previousDepth'
    this.material.name = 'GroundFog.temporal'
    this.quad.material = this.material
    this.output = passTexture(this as any, this.resolveTarget.texture)
    // A rebase moves every render-space point by `delta`: p_new = p_old + delta. Last frame's
    // view matrix maps old-space points, so it takes new-space ones after T(−delta).
    this.unsubscribeRebase = onRebase((delta) => {
      this.previousView.value.multiply(translation.makeTranslation(-delta.x, -delta.y, -delta.z))
    })
  }

  /** The filtered fog, to sample in place of the march. */
  getTextureNode() {
    return this.output
  }

  /** Forget the history: the next frame starts from the current march alone. */
  reset() {
    this.hasHistory = false
  }

  /** Set while the fog is gated off (ground-fog.ts): no resolve, no copies. */
  paused = false

  updateBefore(frame: any): boolean | undefined {
    if (this.paused) return undefined
    const { renderer } = frame
    const size = renderer.getDrawingBufferSize(drawingBufferSize)
    const scale = this.options.resolutionScale()
    const width = Math.max(1, Math.floor(size.width * scale))
    const height = Math.max(1, Math.floor(size.height * scale))
    if (this.resolveTarget.width !== width || this.resolveTarget.height !== height) {
      // The copies write into the history and the kept depth without ever binding them as
      // render targets, so they have to be (re)allocated at the new size by hand, the way
      // three's own TRAANode does; setSize alone leaves their GPU textures at the old size.
      for (const target of [this.historyTarget, this.resolveTarget, this.previousDepthTarget]) {
        target.setSize(width, height)
        renderer.initRenderTarget(target)
      }
      this.hasHistory = false
    }
    this.historyValid.value = this.hasHistory ? 1 : 0
    rendererState = RendererUtils.resetRendererState(renderer, rendererState)
    renderer.setRenderTarget(this.resolveTarget)
    this.quad.render(renderer)
    renderer.setRenderTarget(null)
    renderer.copyTextureToTexture(this.resolveTarget.texture, this.historyTarget.texture)
    // The fog depth pass has rendered by now (the resolve read it), at this same size.
    const depthTexture = this.options.fogDepth.value
    if (depthTexture?.image?.width === width && depthTexture?.image?.height === height) {
      renderer.copyTextureToTexture(depthTexture, this.previousDepthTarget.texture)
    }
    RendererUtils.restoreRendererState(renderer, rendererState)
    this.hasHistory = true
    // This frame's camera is the next frame's "a frame ago". The scene pass has rendered by
    // now, so its matrices are this frame's.
    const { camera } = this.options
    this.previousView.value.copy(camera.matrixWorldInverse)
    this.previousProjection.value.copy(camera.projectionMatrix)
    return undefined
  }

  setup() {
    this.material.fragmentNode = this.resolveNode()
    this.material.needsUpdate = true
    return this.output
  }

  dispose() {
    this.unsubscribeRebase()
    for (const target of [this.historyTarget, this.resolveTarget, this.previousDepthTarget]) {
      target.texture.dispose()
      target.dispose()
    }
    this.material.dispose()
    super.dispose()
  }

  private resolveNode() {
    const { march, fogDepth, depthUnitM, skyDepth, distanceOf, camera, blend, clip, occlusion } = this.options
    const projectionInverse = uniform(camera.projectionMatrixInverse)
    const cameraWorld = uniform(camera.matrixWorld)
    const previousView = this.previousView
    const previousProjection = this.previousProjection
    const historyValid = this.historyValid
    const history = this.historyNode
    const previousDepth = this.previousDepthNode
    return Fn(() => {
      const lowSize = vec2(sizeOf(march))
      const texel: any = floor(uv().mul(lowSize))
      const at = (dx: number, dy: number) => march.load(ivec2(clamp(texel.add(vec2(dx, dy)), vec2(0), lowSize.sub(1))))
      const current = at(0, 0).toVar()
      // The current neighbourhood's mean and spread, per channel.
      const sum = vec4(0).toVar()
      const sumSquares = vec4(0).toVar()
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const tap = dx === 0 && dy === 0 ? current : at(dx, dy)
          sum.addAssign(tap)
          sumSquares.addAssign(tap.mul(tap))
        }
      }
      const mean = sum.div(9)
      const deviation = sqrt(max(sumSquares.div(9).sub(mean.mul(mean)), vec4(0)))
      const low = mean.sub(deviation.mul(clip))
      const high = mean.add(deviation.mul(clip))
      // The texel's ray, as the march casts it: through the texel's centre, to its surface.
      const centre = texel.add(0.5).div(lowSize)
      const viewDirection = normalize(getViewPosition(centre, float(0.5), projectionInverse))
      const stored = fogDepth.load(ivec2(texel)).x
      const surfaceView = viewDirection.mul(stored.mul(depthUnitM).div(max(viewDirection.z.negate(), 1e-4)))
      const origin = cameraWorld.mul(vec4(0, 0, 0, 1)).xyz
      const direction = normalize(cameraWorld.mul(vec4(viewDirection, 0)).xyz)
      const surfaceDistance = length(surfaceView)
      const fogWorld = origin.add(direction.mul(distanceOf(origin, direction, surfaceDistance)))
      const surfaceWorld = origin.add(direction.mul(surfaceDistance))
      // Through last frame's camera.
      const project = (world: any) => {
        const view = previousView.mul(vec4(world, 1))
        const clipPosition = previousProjection.mul(view).toVar()
        const ndc = clipPosition.xy.div(max(clipPosition.w, 1e-6))
        const screen = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(0.5).add(0.5).oneMinus()).toVar()
        const onScreen = clipPosition.w.greaterThan(1e-5)
          .and(screen.x.greaterThanEqual(0)).and(screen.x.lessThanEqual(1))
          .and(screen.y.greaterThanEqual(0)).and(screen.y.lessThanEqual(1))
        return { screen, onScreen, depth: view.z.negate().div(depthUnitM) }
      }
      const fog = project(fogWorld)
      const surface: any = project(surfaceWorld)
      // The history is fetched from the four texels around where the fog was, bilinearly — but
      // only from those whose surface a frame ago lay within `occlusion` × this ray's surface
      // depth (sky against sky always matches). At a crown's silhouette a plain bilinear fetch
      // mixes the crown's history with the gap's beside it, and the neighbourhood clamp cannot
      // tell them apart either, since its 3×3 box straddles the same edge: the outlines smear
      // while the camera moves. A small `occlusion` keeps them apart; the default 1 accepts any
      // surface from the camera to twice this one's depth, so there the test rarely rejects.
      // Where none of the four match, the spot was hidden a frame ago: no history.
      const sky = stored.greaterThanEqual(skyDepth * 0.99)
      const position = fog.screen.mul(lowSize).sub(0.5)
      const base = floor(position)
      const f = position.sub(base)
      const gathered = vec4(0).toVar()
      const matched = float(0).toVar()
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const tap = ivec2(clamp(base.add(vec2(ox, oy)), vec2(0), lowSize.sub(1)))
        const before = previousDepth.load(tap).x
        const same = select(sky, before.greaterThanEqual(skyDepth * 0.99),
          abs(before.sub(surface.depth)).lessThanEqual(surface.depth.mul(occlusion)))
        const w = (ox === 1 ? f.x : f.x.oneMinus()).mul(oy === 1 ? f.y : f.y.oneMinus()).mul(select(same, float(1), float(0)))
        gathered.addAssign(history.load(tap).mul(w))
        matched.addAssign(w)
      }
      const previous = clamp(gathered.div(max(matched, 1e-4)), low, high)
      const keep = fog.onScreen.and(surface.onScreen).and(matched.greaterThan(0.05)).and(historyValid.greaterThan(0.5))
      return mix(previous, current, select(keep, blend, float(1)))
    })()
  }
}
