// Poisson-style hole fill for the streamed point cloud, as a post effect.
//
// Same job as OPENRNDR's orx-fx `PoissonFill` (guide.openrndr.org/ORX/poissonFills.html):
// diffuse colour from opaque pixels into the transparent gaps between them, so a
// sparse splat cloud reads as a surface instead of dots. Both are the convolution-
// pyramid family from Farbman et al., "Convolution Pyramids" (SIGGRAPH Asia 2011) —
// a pull-push pyramid approximates the Laplacian membrane in linear time instead of
// actually solving the Poisson system.
//
// This is the *normalized* pull-push formulation rather than the paper's fitted
// h1/h2/g1 kernels: colour is carried premultiplied by a coverage weight, weight is
// filtered by the identical kernel, and the division at the end yields the weighted
// average. That keeps every constant here justifiable (a binomial 4-tap tent, via
// hardware bilinear) instead of depending on fitted coefficients I could not verify
// against the orx source. Visually equivalent for gap-filling at this scale; if the
// exact membrane solution is ever needed, only the two kernels below change.
//
// Cost: 2·levels quad passes over a halving pyramid, so ~2.7× the level-0 area in
// total. Nothing here depends on time — it is recomputed per frame only because the
// camera moves.
import {
  HalfFloatType, RenderTarget, Vector2, Color, TempNode, QuadMesh, NodeMaterial,
  RendererUtils, NodeUpdateType,
} from 'three/webgpu'
import { nodeObject, Fn, float, vec2, vec4, uv, texture, uniform, max, mix, smoothstep } from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'

const _quadMesh = new QuadMesh()
const _size = new Vector2()
let _rendererState: any

/** 6 halvings ≈ a 64 px reach at level 0 — verified to keep the sky clean even
 * at the lowest floor. Raising this needs re-verifying that invariant: bilinear
 * upsampling reach grows ~2× per level, and at 8 it was wide enough to bridge
 * from a canopy filling most of the frame straight up into open sky, floor or no
 * floor. seedBoost (below) is the intended knob for "more reach" instead — it
 * buys distance from confidence, not from a wider physical kernel, so it can't
 * blow through the frame the way another level or two of this constant would. */
const MAX_LEVELS = 6

export class PoissonFillNode extends TempNode {
  static get type(): string { return 'PoissonFillNode' }

  colorNode: any
  coverageNode: any
  /** Blend of the filled result over the original image. */
  strength: any
  /** Rejects the faint pyramid tail so colour cannot creep into the sky. */
  coverageFloor: any
  /** Width of the coverageFloor transition. Smaller = a crisper cutoff between
   * "kept as-is" and "filled"; larger = a longer, softer feather. */
  edgeSoftness: any
  /**
   * Multiplies the seed weight before the pyramid runs. Each pull level dilutes
   * an isolated point's weight by ~4× (a 2×2 average against three empty
   * neighbours), so a lone or sparse point crosses under coverageFloor within a
   * couple of levels and the fill stops "seeing" it — which reads as small or
   * thin structures not getting filled around, even though bigger clumps of
   * points do. Boosting the seed raises how many dilution steps a point's
   * confidence survives before the floor rejects it: since dilution is
   * geometric, a boost of 4× buys roughly one extra level of reach for the
   * *same* coverageFloor and *same* `levels` budget — more support at no extra
   * pyramid passes, at the cost of leaning on a coarser (blurrier) colour
   * estimate further from the source. Real, dense clusters are far above the
   * floor already and barely move.
   */
  seedBoost: any
  /** Exponent on the coverageFloor transition itself — pushes the support ramp
   * toward a hold-then-drop (>1) or an early-and-gradual fade (<1), independent
   * of where the floor sits. */
  supportCurve: any
  /** Colour grade applied to the filled pixels only, so the fill can be pushed
   * warmer/cooler/darker than the real points without touching them. */
  tintColor: any
  tintAmount: any
  /** Pyramid depth = how far colour diffuses. A plain number, read only by
   * updateBefore's loop, so changing it never recompiles a shader. */
  levels: number

  private _down: RenderTarget[] = []
  private _up: RenderTarget[] = []
  private _seedMaterial: NodeMaterial | null = null
  private _downMaterials: NodeMaterial[] = []
  private _upMaterials: NodeMaterial[] = []
  private _downSource: any[] = []
  private _upFiner: any[] = []
  private _upCoarser: any[] = []
  private _texelSize: any[] = []
  private _filledTexture: any = null
  private _fillAmount: any = null

  constructor(colorNode: any, coverageNode: any) {
    super('vec4')
    this.colorNode = colorNode
    this.coverageNode = coverageNode
    const config = EXPERIENCE_CONFIG.design.poissonFill
    this.strength = uniform(config.strength)
    this.coverageFloor = uniform(config.coverageFloor)
    this.edgeSoftness = uniform(config.edgeSoftness)
    this.seedBoost = uniform(config.seedBoost)
    this.supportCurve = uniform(config.supportCurve)
    this.tintColor = uniform(new Color(config.tintColor))
    this.tintAmount = uniform(config.tintAmount)
    this.levels = config.levels
    this.updateBeforeType = NodeUpdateType.FRAME

    for (let level = 0; level <= MAX_LEVELS; level++) {
      // HalfFloat: the premultiplied colour/weight pair needs headroom and a
      // linear response; an 8-bit target quantises the weight into banding.
      const down = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType })
      down.texture.name = `PoissonFill.down${level}`
      this._down.push(down)
      if (level < MAX_LEVELS) {
        const up = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType })
        up.texture.name = `PoissonFill.up${level}`
        this._up.push(up)
      }
    }
  }

  setSize(width: number, height: number): void {
    for (let level = 0; level <= MAX_LEVELS; level++) {
      const w = Math.max(1, width >> level)
      const h = Math.max(1, height >> level)
      this._down[level].setSize(w, h)
      if (level < MAX_LEVELS) {
        this._up[level].setSize(w, h)
        // Each pull pass offsets by one texel of its *source* level, which is this
        // one — so the tap spacing has to follow the resize with the targets.
        this._texelSize[level]?.value.set(1 / w, 1 / h)
      }
    }
  }

  updateBefore(frame: any): boolean | undefined {
    const { renderer } = frame
    // Off means off: skip the whole pyramid. The composite still samples _up[0],
    // but it multiplies by strength, so a stale frame in there is unobservable.
    if (this.strength.value <= 0) return
    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState)

    const size = renderer.getDrawingBufferSize(_size)
    this.setSize(size.width, size.height)
    const levels = Math.max(1, Math.min(MAX_LEVELS, Math.round(this.levels)))

    // 1. Seed: premultiply the scene colour by point coverage. Everything the
    //    point cloud did not draw — sky, imagery, models — seeds as zero, which is
    //    what keeps the fill from inventing colour outside the cloud.
    renderer.setRenderTarget(this._down[0])
    _quadMesh.material = this._seedMaterial!
    _quadMesh.render(renderer)

    // 2. Pull: halve repeatedly, filtering colour and weight with one kernel.
    for (let level = 1; level <= levels; level++) {
      renderer.setRenderTarget(this._down[level])
      _quadMesh.material = this._downMaterials[level - 1]
      _quadMesh.render(renderer)
    }

    // 3. Push: walk back up, filling each level's holes from the coarser one.
    //    Written into a separate target set because a pass cannot sample the
    //    attachment it renders into.
    for (let level = levels - 1; level >= 0; level--) {
      this._upCoarser[level].value = level === levels - 1
        ? this._down[levels].texture
        : this._up[level + 1].texture
      renderer.setRenderTarget(this._up[level])
      _quadMesh.material = this._upMaterials[level]
      _quadMesh.render(renderer)
    }

    RendererUtils.restoreRendererState(renderer, _rendererState)
    return undefined
  }

  setup(builder: any): any {
    const context = builder.getSharedContext()

    // Seed material — premultiplied (rgb·w, w). Colour and weight are scaled by
    // the identical boosted factor, so the final rgb/weight divide cancels
    // seedBoost exactly and still recovers the true colour — boost only changes
    // how far a point's confidence reaches the coverageFloor test, never what
    // colour arrives there.
    const seed = Fn(() => {
      const weight = this.coverageNode.r.clamp(0, 1).mul(this.seedBoost)
      return vec4(this.colorNode.rgb.mul(weight), weight)
    })
    this._seedMaterial = this._seedMaterial ?? new NodeMaterial()
    this._seedMaterial.fragmentNode = seed().context(context)
    this._seedMaterial.name = 'PoissonFill_seed'
    this._seedMaterial.needsUpdate = true

    for (let level = 0; level < MAX_LEVELS; level++) {
      // --- pull: 4 bilinear taps at ±1 source texel = a 4×4 binomial tent for
      // the price of four samples. Colour and weight take the identical filter,
      // which is what makes the final divide a true weighted average.
      const source = this._downSource[level] ?? texture(this._down[level].texture)
      source.value = this._down[level].texture
      this._downSource[level] = source
      const texel = this._texelSize[level] ?? uniform(new Vector2())
      this._texelSize[level] = texel

      const down = Fn(() => {
        const c = uv()
        return source.sample(c.add(vec2(-1, -1).mul(texel)))
          .add(source.sample(c.add(vec2(1, -1).mul(texel))))
          .add(source.sample(c.add(vec2(-1, 1).mul(texel))))
          .add(source.sample(c.add(vec2(1, 1).mul(texel))))
          .mul(0.25)
      })
      const downMaterial = this._downMaterials[level] ?? new NodeMaterial()
      downMaterial.fragmentNode = down().context(context)
      downMaterial.name = `PoissonFill_down${level}`
      downMaterial.needsUpdate = true
      this._downMaterials[level] = downMaterial

      // --- push: premultiplied "over". Where the finer level already has weight
      // it wins untouched; where it has none the coarser interpolation fills in.
      // The blend factor clamps near.a to [0,1] before the oneMinus: seedBoost can
      // push weight past 1, and an unclamped (1 - near.a) would go negative there
      // and subtract far's colour instead of ignoring it. The *propagated* alpha
      // (near.a + far.a·blend) is left unclamped on purpose — its magnitude above
      // 1 is exactly what lets seedBoost buy extra reach against coverageFloor.
      const finer = this._upFiner[level] ?? texture(this._down[level].texture)
      finer.value = this._down[level].texture
      this._upFiner[level] = finer
      const coarser = this._upCoarser[level] ?? texture(this._down[level + 1].texture)
      this._upCoarser[level] = coarser

      const up = Fn(() => {
        const near = finer.sample(uv())
        const far = coarser.sample(uv())
        const blend = near.a.clamp(0, 1).oneMinus()
        return vec4(near.rgb.add(far.rgb.mul(blend)), near.a.add(far.a.mul(blend)))
      })
      const upMaterial = this._upMaterials[level] ?? new NodeMaterial()
      upMaterial.fragmentNode = up().context(context)
      upMaterial.name = `PoissonFill_up${level}`
      upMaterial.needsUpdate = true
      this._upMaterials[level] = upMaterial
    }

    // Composite. Only pixels the point cloud missed are replaced, so real points
    // stay crisp and the effect reads as filled gaps rather than a blur.
    return Fn(() => {
      const filled: any = this.filledSample()
      const weight: any = filled.a
      const colour: any = filled.rgb.div(max(weight, float(1e-4)))
      const tinted: any = mix(colour, this.tintColor, this.tintAmount)
      return vec4(mix(this.colorNode.rgb, tinted, this.fillAmountNode()), this.colorNode.a)
    })()
  }

  /** The pyramid's filled colour + accumulated weight at this fragment. */
  private filledSample(): any {
    this._filledTexture = this._filledTexture ?? texture(this._up[0].texture)
    this._filledTexture.value = this._up[0].texture
    return this._filledTexture.sample(uv())
  }

  /**
   * The blend weight this node applies at each fragment: 0 where the original
   * image survives untouched, up to 1 where the pixel is entirely pyramid-filled.
   *
   * Exposed so downstream effects can treat filled pixels differently from real
   * point pixels — `coverage` alone cannot express that distinction, since a
   * filled gap and empty background both read 0 there. Cached so the node is
   * shared rather than duplicated: this and the composite above land in the same
   * fragment shader, so one cached node lets the compiler fold them into a single
   * evaluation instead of sampling the pyramid twice.
   */
  fillAmountNode(): any {
    if (this._fillAmount) return this._fillAmount
    const filled: any = this.filledSample()
    const weight: any = filled.a
    const rawCoverage: any = this.coverageNode.r
    // blockFillMrt() writes -1 for field models, markers and other opaque
    // objects that stand near the cloud — never eligible, no matter how
    // confident the nearby pyramid weight is. clamp(0,1) alone can't express
    // this: it would floor -1 to 0, indistinguishable from genuine empty
    // background (sky, basemap) that the fill is supposed to paint over.
    const blocked: any = rawCoverage.lessThan(-0.5)
    const coverage: any = max(rawCoverage, float(0)).clamp(0, 1)
    // smoothstep off the floor rather than a hard step: a binary cut on the
    // pyramid tail crawls with the camera and shimmers along the silhouette.
    // edgeSoftness sets the transition's width, supportCurve reshapes it after
    // (>1 holds near 0 longer then rises fast; <1 rises early and levels off).
    const support: any = smoothstep(this.coverageFloor, this.coverageFloor.add(this.edgeSoftness), weight)
      .pow(this.supportCurve)
    this._fillAmount = support.mul(coverage.oneMinus()).mul(this.strength)
      .mul(blocked.select(float(0), float(1)))
    return this._fillAmount
  }

  dispose(): void {
    for (const target of this._down) target.dispose()
    for (const target of this._up) target.dispose()
    this._seedMaterial?.dispose()
    for (const material of this._downMaterials) material.dispose()
    for (const material of this._upMaterials) material.dispose()
  }
}

export const poissonFill = (colorNode: any, coverageNode: any): any =>
  nodeObject(new PoissonFillNode(nodeObject(colorNode), nodeObject(coverageNode)))
