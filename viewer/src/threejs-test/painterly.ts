// Painterly point-cloud shader — a classic (non-anisotropic) Kuwahara filter,
// as a post effect confined to the point cloud.
//
// Same lineage as the technique in Maxime Heckel's "On Crafting Painterly
// Shaders" (blog.maximeheckel.com/posts/on-crafting-painterly-shaders/):
// partition a window around each pixel into quadrants, keep the quadrant with
// the lowest colour variance, and paint the pixel with that quadrant's mean.
// Flat regions stay flat (every quadrant has low variance, any one will do);
// edges snap to whichever side is more uniform — the "brushed", detail-erasing
// look that gives the technique its name.
//
// This ships the BASIC 4-quadrant form the article starts from, not its
// anisotropic/structure-tensor upgrade. That upgrade adds a Sobel pass to
// build a per-pixel structure tensor, then an elliptical, rotated 8-sector
// kernel steered by it — a second full-resolution pass plus real per-pixel
// ALU for the eigen-decomposition. The basic form gets recognizably the same
// painterly character (edge-preserving, texture-erasing) for a fraction of
// the cost, which is the deliberate trade given this runs over live-streamed
// tiles every frame, not a one-shot static image. If the full anisotropic
// look is ever wanted, this is the file to extend: add the Sobel structure
// pass and swap the 4 axis-aligned quadrants for rotated elliptical sectors.
//
// Confined to the point cloud only: masked by the same `coverage` channel
// Poisson fill reads (>0 only where a point actually rasterized; 0 or -1
// everywhere else — sky, basemap, field models, markers), so this can never
// paint anything the point cloud didn't draw, independent of kernel radius.
//
// Kernel radius is baked into the shader at construction (fully unrolled
// loops, not a dynamic-count Loop()): a non-uniform loop trip count is exactly
// the divergent control flow GPUs punish, and radius is a rare "tune the
// look" interaction, not a per-frame value, so a rebuild on change is free in
// practice — see main.ts's `renderPipeline.needsUpdate = true` on the slider.
//
// Cost: one capture pass (materializes the upstream — e.g. Poisson fill's
// already gap-filled result — into a real texture, since Kuwahara needs actual
// neighbour reads, which only work against a rendered buffer) plus 4·(r+1)²
// texture samples per pixel in the main composite. At the default radius 2
// that's 36 samples; every level up roughly doubles it.
import {
  HalfFloatType, RenderTarget, Vector2, TempNode, QuadMesh, NodeMaterial,
  RendererUtils, NodeUpdateType,
} from 'three/webgpu'
import { nodeObject, Fn, float, vec2, vec3, vec4, uv, texture, uniform, mix, min, max, cos, sin } from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'

const _quadMesh = new QuadMesh()
const _size = new Vector2()
let _rendererState: any

/** Cost is 4·(r+1)² samples/pixel — r=4 is already 100 samples, a ceiling on
 * the panel slider rather than a realistic everyday setting. */
const MAX_KERNEL_RADIUS = 4

/** (signX, signY) for the four quadrants: top-left, top-right, bottom-left,
 * bottom-right, each spanning the centre pixel outward. */
const QUADRANT_SIGNS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [1, -1], [-1, 1], [1, 1],
]

export class PainterlyNode extends TempNode {
  static get type(): string { return 'PainterlyNode' }

  colorNode: any
  coverageNode: any
  /** Poisson fill's per-fragment blend weight, or null when the fill is not in
   * the chain — see the `fillStrength` note for why this is needed. */
  fillAmountNode: any
  /** Blend over pixels the point cloud actually rasterized. */
  pointStrength: any
  /**
   * Blend over pixels Poisson fill painted in.
   *
   * These are two separate knobs because the two regions carry different kinds
   * of information: point pixels are measured data, filled pixels are
   * interpolation. Weighting them independently lets the real points stay crisp
   * while the invented areas take the brush (or the reverse).
   *
   * Driven by the fill's own blend weight rather than by `coverage`, which
   * cannot distinguish a filled gap from empty background — both read 0 there.
   * Using the real weight also means this is inert whenever the fill is off or
   * hasn't reached a pixel, so it can never leak the brush onto sky or basemap.
   *
   * Allowed past 1, where it stops being a blend and starts extrapolating:
   * `original + (painted − original) · s` overshoots the painted result and
   * exaggerates the brush. Useful, but weaker than it sounds — it scales an
   * existing deviation, and filled areas are smooth, so see `fillBrushScale`
   * for the knob that creates deviation instead of amplifying it.
   */
  fillStrength: any
  /** Tap spacing multiplier — grows the brush with no extra samples. */
  brushSpacing: any
  /** Exponent on the quadrant weighting: high = hard "flattest wins" selection,
   * 0 = equal-weight average across all four. */
  selectionSharpness: any
  /** Rotation of the quadrant frame, in radians. */
  brushAngle: any
  /** Saturation applied to the painted result only. */
  paintSaturation: any
  /** Edge darkening driven by the quadrant variance spread. */
  contourStrength: any
  /**
   * Extra tap spacing applied *only* in filled areas, ramped in by the fill
   * weight. This is the knob that actually pushes filled regions further than a
   * blend ever can: widening the kernel pulls colour from further away, so the
   * quadrant means diverge more from the source and the strokes genuinely grow.
   * Raising `fillStrength` past 1 only amplifies whatever deviation already
   * exists — and filled regions are smooth by construction, so Kuwahara barely
   * moves them and there is often little deviation to amplify. Costs nothing
   * extra: it scales the sampling basis, it does not add samples.
   */
  fillBrushScale: any
  /** Compile-time: reassigning this needs `renderPipeline.needsUpdate = true`
   * (see main.ts) to actually take effect — it fully unrolls into the shader.
   * Every other knob above is a plain uniform and updates live. */
  kernelRadius: number

  private _captureTarget: RenderTarget
  private _captureMaterial: NodeMaterial | null = null
  private _captureTexture: any = null
  private _texelSize: any

  constructor(colorNode: any, coverageNode: any, fillAmountNode: any = null) {
    super('vec4')
    this.colorNode = colorNode
    this.coverageNode = coverageNode
    this.fillAmountNode = fillAmountNode
    const config = EXPERIENCE_CONFIG.design.painterly
    this.pointStrength = uniform(config.pointStrength)
    this.fillStrength = uniform(config.fillStrength)
    this.brushSpacing = uniform(config.brushSpacing)
    this.selectionSharpness = uniform(config.selectionSharpness)
    this.brushAngle = uniform(config.brushAngleDeg * Math.PI / 180)
    this.paintSaturation = uniform(config.paintSaturation)
    this.contourStrength = uniform(config.contourStrength)
    this.fillBrushScale = uniform(config.fillBrushScale)
    this.kernelRadius = config.kernelRadius
    this.updateBeforeType = NodeUpdateType.FRAME

    this._captureTarget = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType })
    this._captureTarget.texture.name = 'Painterly.capture'
    this._texelSize = uniform(new Vector2())
  }

  setSize(width: number, height: number): void {
    this._captureTarget.setSize(width, height)
    this._texelSize.value.set(1 / width, 1 / height)
  }

  updateBefore(frame: any): boolean | undefined {
    const { renderer } = frame
    // Off means off: skip the capture pass entirely — the composite still
    // reads a (possibly stale) capture texture, but multiplies by the region
    // strengths, so a stale frame in there is unobservable. Both have to be
    // down for the pass to be skippable.
    if (this.pointStrength.value <= 0 && this.fillStrength.value <= 0) return undefined
    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState)

    const size = renderer.getDrawingBufferSize(_size)
    this.setSize(size.width, size.height)

    // Materialize the upstream colour into a real texture. This is the only
    // render-target pass the effect needs — the Kuwahara maths itself samples
    // this texture directly in the final composite, no second pass required.
    renderer.setRenderTarget(this._captureTarget)
    _quadMesh.material = this._captureMaterial!
    _quadMesh.render(renderer)

    RendererUtils.restoreRendererState(renderer, _rendererState)
    return undefined
  }

  setup(builder: any): any {
    const context = builder.getSharedContext()

    this._captureMaterial = this._captureMaterial ?? new NodeMaterial()
    this._captureMaterial.fragmentNode = vec4(this.colorNode.rgb, 1).context(context)
    this._captureMaterial.name = 'Painterly_capture'
    this._captureMaterial.needsUpdate = true

    this._captureTexture = this._captureTexture ?? texture(this._captureTarget.texture)
    this._captureTexture.value = this._captureTarget.texture

    const r = Math.max(1, Math.min(MAX_KERNEL_RADIUS, Math.round(this.kernelRadius)))
    const source = this._captureTexture
    const texel = this._texelSize
    const sampleCount = (r + 1) * (r + 1)

    return Fn(() => {
      const centre = uv()
      const epsilon = float(1e-5)

      // Rotated, scaled sampling basis, built once per fragment. Rotating the two
      // basis vectors here rather than each offset inside the loops keeps the
      // per-sample cost at two multiply-adds instead of a full 2×2 rotate — the
      // difference matters at up to 100 samples/pixel.
      // Fill weight is needed up here, not just at the blend: it widens the
      // kernel inside filled regions so the brush physically grows there. The
      // ramp is smooth because the fill weight is, so the brush size eases
      // across a fill boundary instead of stepping.
      const fillWeight: any = this.fillAmountNode === null
        ? float(0)
        : this.fillAmountNode.clamp(0, 1)
      const spacingScale: any = mix(float(1), this.fillBrushScale, fillWeight)

      const angleCos = cos(this.brushAngle)
      const angleSin = sin(this.brushAngle)
      const step: any = texel.mul(this.brushSpacing).mul(spacingScale)
      const basisX: any = vec2(angleCos, angleSin).mul(step)
      const basisY: any = vec2(angleSin.negate(), angleCos).mul(step)

      const means: any[] = []
      const variances: any[] = []
      const minVariance = float(1e9).toVar()
      const maxVariance = float(0).toVar()

      for (const [signX, signY] of QUADRANT_SIGNS) {
        const sum = vec3(0, 0, 0).toVar()
        const sumSq = vec3(0, 0, 0).toVar()
        // Fully unrolled at build time — see the class doc for why a dynamic
        // Loop() bound by a uniform is deliberately avoided here.
        for (let j = 0; j <= r; j++) {
          for (let i = 0; i <= r; i++) {
            const offset: any = basisX.mul(i * signX).add(basisY.mul(j * signY))
            const sample: any = source.sample(centre.add(offset)).rgb
            sum.addAssign(sample)
            sumSq.addAssign(sample.mul(sample))
          }
        }
        const mean: any = sum.div(sampleCount).toVar()
        // Var(X) = E[X²] − E[X]², summed across channels into one scalar to
        // rank the quadrant — cheaper than tracking luminance separately and
        // just as effective at picking the "flattest" quadrant.
        const variance: any = sumSq.div(sampleCount).sub(mean.mul(mean))
        const totalVariance: any = variance.r.add(variance.g).add(variance.b).max(0).toVar()
        means.push(mean)
        variances.push(totalVariance)
        minVariance.assign(min(minVariance, totalVariance))
        maxVariance.assign(max(maxVariance, totalVariance))
      }

      // Generalized (soft) Kuwahara: weight each quadrant by how close its
      // variance is to the flattest one, then blend. The weight is the *ratio*
      // minVariance/variance raised to selectionSharpness, which makes it
      // scale-invariant — important because this samples pre-tonemap HDR values,
      // where an absolute variance threshold would drift with exposure. Ratios
      // land in (0,1], so the pow is always numerically well behaved.
      //
      // Sharpness also buys temporal stability over the old hard min-selection:
      // a strict argmin flips quadrant as the camera moves and pops visibly,
      // whereas a weighted blend crosses over smoothly.
      const weightTotal = float(0).toVar()
      const accum = vec3(0, 0, 0).toVar()
      for (let k = 0; k < QUADRANT_SIGNS.length; k++) {
        const weight: any = minVariance.add(epsilon)
          .div(variances[k].add(epsilon))
          .pow(this.selectionSharpness)
        weightTotal.addAssign(weight)
        accum.addAssign(means[k].mul(weight))
      }
      const painted: any = accum.div(max(weightTotal, epsilon))

      // Same luma weights as gradeImageryNode, so the two grades agree.
      const luma: any = painted.r.mul(0.2126).add(painted.g.mul(0.7152)).add(painted.b.mul(0.0722))
      const saturated: any = mix(vec3(luma), painted, this.paintSaturation)

      // Edge term from the variance *spread*: flat areas have all four quadrants
      // alike (ratio → 1, edge → 0); across an edge the straddling quadrants
      // spike while the flat one stays low (ratio → 0, edge → 1). Being a ratio,
      // it needs no scene-dependent threshold.
      const edge: any = float(1).sub(minVariance.add(epsilon).div(maxVariance.add(epsilon)))
      const contoured: any = saturated.mul(float(1).sub(edge.mul(this.contourStrength)))

      // Two disjoint regions, weighted independently and summed.
      //
      // `pointness` is the same confinement channel Poisson fill seeds from:
      // only where a point actually rasterized (the -1 block sentinel and the 0
      // background floor both clamp out, so field models, markers, sky and
      // basemap all stay at 0).
      //
      // They cannot double-count: the fill only writes where coverage is 0, so
      // its weight carries a coverage.oneMinus() factor that is 0 wherever
      // pointness is 1. Partial coverage (a transparent object blended over the
      // cloud) splits smoothly between the two rather than jumping. The clamp is
      // a belt-and-braces guard for that overlap region, where both terms can be
      // fractional and their strengths could otherwise sum past 1.
      const pointness: any = this.coverageNode.r.clamp(0, 1)
      const pointTerm: any = pointness.mul(this.pointStrength)
      // Deliberately NOT clamped to 1: past that, mix() extrapolates rather than
      // blends, which is what lets the fill overdrive past a plain replacement.
      // The two terms still cannot double-count — the fill weight carries a
      // coverage.oneMinus() factor that is 0 wherever pointness is 1 — so this
      // only exceeds 1 when a strength was deliberately set above it.
      const drive: any = pointTerm.add(fillWeight.mul(this.fillStrength))
      // Extrapolation can undershoot past black; clamp before the value reaches
      // tone mapping, where a negative channel would come out as a hard artifact.
      const blended: any = mix(this.colorNode.rgb, contoured, drive).max(0)
      return vec4(blended, this.colorNode.a)
    })()
  }

  dispose(): void {
    this._captureTarget.dispose()
    this._captureMaterial?.dispose()
  }
}

export const painterly = (colorNode: any, coverageNode: any, fillAmountNode: any = null): any =>
  nodeObject(new PainterlyNode(
    nodeObject(colorNode),
    nodeObject(coverageNode),
    fillAmountNode === null ? null : nodeObject(fillAmountNode),
  ))
