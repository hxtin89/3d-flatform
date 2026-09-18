// Point-cloud material for the streamed tiles. The geometry itself stays
// tile-owned so Three can release CPU and GPU resources as the camera moves.
// Points are drawn as instanced quads — see createCloudMaterial for why.
import * as THREE from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import {
  Fn, If, Discard, uniform, attribute, positionWorld, positionView, texture, texture3D, uv,
  vec2, vec3, vec4, float, int, mix, smoothstep, step, length, max, min, abs, exp, floor, hash,
  cameraPosition, context, highpModelViewMatrix, screenCoordinate, sin, cos, renderGroup,
} from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'

export interface CloudUniforms {
  maskCenter: any
  maskRadius: any
  /** 0 = off, 2 = viewport vignette. */
  maskMode: any
  vignetteStrength: any
  /** Width of the stochastic dissolve band at the mask edge, as a fraction of
   * maskRadius. 0 = hard circular cut. */
  maskFringe: any
  /** Exponent on the fringe keep-probability across that band. */
  maskFringeCurve: any
  /** Colour the surround fades toward, and how strongly geometry takes it. */
  maskSurroundColor: any
  maskSurroundAmount: any
  /** Fixed drawn diameter in CSS pixels — the comparison path, see sizeSpacingMix. */
  pointSize: any
  /**
   * Drawn size from each tile's own point spacing. `sizeSpacingMix` blends between
   * the fixed diameter above (0) and the spacing-derived one (1); both are always
   * compiled, so switching modes is a uniform write rather than a rebuild of every
   * live tile material. See createCloudMaterial for the expression.
   */
  sizeSpacingMix: any
  /**
   * The on-screen point spacing being asked for, in CSS pixels — the denominator of the
   * shortfall, and the one place any feature that varies detail across the image has to
   * register itself. See `requestedPx` in createCloudMaterial.
   *
   * `sizeRequestedPx` is the flat part (`sse / geometricErrorScale`); `foveaCore` and
   * `foveaFactors` bend it by screen position. Half screen heights from the image centre,
   * x right and y up, the same frame foveation.ts measures tiles in:
   *   foveaCore    = (core centre y, core half width, core half height, falloff)
   *   foveaFactors = (factor inside the core, factor at the far corner)
   * Both factors at 1 makes the whole term inert, which is what an unfoveated frame sets.
   */
  sizeRequestedPx: any
  foveaCore: any
  foveaFactors: any
  /** Half the viewport height in CSS pixels — converts a pixel offset from the image
   *  centre into the half-screen-height unit the fovea is defined in. */
  sizeHalfHeightPx: any
  sizeMinPx: any
  sizeMaxPx: any
  /**
   * CSS pixels per metre at one metre of view depth: `0.5 * height_css * P[1][1]`.
   * The reciprocal of the renderer's own `sseDenominator`, so a spacing pushed
   * through it lands in the same units as the screen-space error target.
   */
  sizePxPerMetre: any
  /** Basemap-only grading (the point cloud has its own). */
  mapSaturation: any
  mapBrightness: any
  /**
   * Flat ground patch that replaces the satellite imagery inside the survey
   * footprint, so the map is only visible where there is no point-cloud data.
   * Replacing rather than hiding: the imagery is the only thing drawn on the
   * globe there, so cutting it out would show the sky through the ground.
   * 0 = off, 1 = fully replaced.
   */
  groundPatchAmount: any
  groundPatchColor: any
  /** ENU position of the lattice's lower-left corner. */
  groundPatchOrigin: any
  /** Ground size of one cell, in metres — constant, independent of survey size. */
  groundPatchCellSizeM: any
  /** Index map edge length in cells — the divisor for addressing it. */
  groundPatchIndexSize: any
  /** 0 = the raw basemap at groundPatchBrightness, 1 = a flat colour. */
  groundPatchColorMix: any
  /** Brightness applied to the raw imagery inside the patch, independent of the
   * global basemap grading. */
  groundPatchBrightness: any
  /** Radius in metres the coverage is averaged over before thresholding. */
  groundPatchBlurM: any
  /** Cut level on the blurred coverage. Above 0.5 erodes, below it dilates. */
  groundPatchThreshold: any
  /** Analytic ground fog, shared by points and imagery. */
  groundFogColor: any
  groundFogStrength: any
  groundFogBaseZ: any
  groundFogHeight: any
  /** Metres below the base over which the fog fades out downward, turning the
   * one-sided slab into a band. 0 restores the original slab. */
  groundFogFadeBelow: any
  groundFogDistance: any
  groundFogCurve: any
  /** world/ECEF to local ENU. */
  enuInverse: any
  /** Shared daylight grade for point and map imagery. */
  daylightColor: any
  daylightIntensity: any
  /** Normalized sun direction in the survey's ENU frame. */
  sunDirectionEnu: any
  /** Drifting canopy shadows sampled from the shared cloud-density volume. */
  cloudShadowOffset: any
  cloudShadowStrength: any
  cloudShadowScale: any
  /** Tightens the noise-to-shadow ramp around its midpoint: 0 is the original
   * wide, washed window, 1 a near-binary edge. */
  cloudShadowContrast: any
  cloudDeckHeight: any
  /** Golden-hour warm rim graded by canopy height (points have no normals). */
  goldenFactor: any
  warmRimColor: any
  canopyBaseZ: any
  canopyTopZ: any
  /**
   * False-colour inspector over the finished image. 0 = off, and at 0 the frame is
   * exactly what it was before the inspector existed; 1 = colour by level; 2 = error
   * headroom in flat bands. See createCloudMaterial for both palettes.
   *
   * A continuous sweep of the same headroom was mode 3 for one afternoon and was dropped:
   * it only ever answered whether a band edge was real, which is a question you ask once,
   * and a second error view that close to the first is a way to lose track of which one
   * you are looking at.
   *
   * A uniform rather than an effect flag, so switching costs one write instead of a
   * TSL rebuild across every live tile material — the same trade `sizeSpacingMix`
   * makes, and worth it here for a handful of ALU ops in a shader that already
   * samples a 3D texture.
   */
  debugMode: any
  /** How far the false colour covers the real one, 0..1. Below 1 the canopy structure
   *  stays readable underneath, which is usually how a level boundary is judged. */
  debugStrength: any
  /**
   * 0 = paint every drawn tile, 1 = only the tiles where refinement stopped, 2 = only
   * `debugIsolateLevel`. Inert while `debugMode` is 0.
   *
   * Needed because `refine: ADD` draws every ancestor along with its children, so
   * false-colouring a whole frame stacks ten levels into one pile of pixels. 1 is the
   * set the eye actually sees the edges of — the same terminal set the Level mix
   * read-out counts.
   */
  debugIsolate: any
  debugIsolateLevel: any
}

let cloudShadowTextureNode: any = null
let groundPatchMaskNode: any = null
let groundPatchIndexNode: any = null

/** Register the ground-patch coverage mask BEFORE the first basemap material is
 * created. Both textures are refilled in place once the point tileset loads, so the
 * same objects stay bound — see ground-patch-mask.ts.
 *
 * Two textures because the mask is a lattice of fixed-resolution cells rather than
 * one stretched image: `index` says which array layer holds a given cell, `cells`
 * holds the coverage. That is what keeps detail independent of how large the
 * surveyed area grows. */
export function setGroundPatchMask(cells: THREE.DataArrayTexture, indexMap: THREE.Texture): void {
  groundPatchMaskNode = texture(cells)
  groundPatchIndexNode = texture(indexMap)
}

/** Register the shared cloud-density volume BEFORE the first tile material is
 * created; the same texture drives the volumetric clouds overhead. */
export function setCloudShadowTexture(texture: THREE.Data3DTexture): void {
  cloudShadowTextureNode = texture3D(texture, null, 0)
}

/**
 * One uniform buffer for the whole cloud, instead of a private copy inside every tile.
 *
 * `uniform()` defaults to `objectGroup`, and NodeBuilderState.createBindings clones a
 * non-shared group per render object. Every value below is genuinely global — the mask,
 * the fog, the daylight, the size settings — yet each of the ~150 live tile materials
 * carried its own copy, so a single slider move dirtied ~150 small buffers instead of
 * one, and every frame walked ~150 x 53 values looking for changes.
 *
 * `renderGroup` is the right scope: these change at most once per render, never per
 * object. The per-tile uniforms — thinScale, spacingMetres, debugTile, debugTint — stay
 * on objectGroup, because those really do differ per tile.
 */
function shareAcrossTiles<T extends Record<string, any>>(uniforms: T): T {
  for (const key of Object.keys(uniforms)) {
    const node = uniforms[key]
    if (node && typeof node.setGroup === 'function') node.setGroup(renderGroup)
  }
  return uniforms
}

export function createUniforms(): CloudUniforms {
  return shareAcrossTiles({
    maskCenter: uniform(new THREE.Vector2(0, 0)),
    maskRadius: uniform(120),
    maskMode: uniform(EXPERIENCE_CONFIG.design.maskMode),
    vignetteStrength: uniform(0),
    maskFringe: uniform(EXPERIENCE_CONFIG.design.maskFringe),
    maskFringeCurve: uniform(EXPERIENCE_CONFIG.design.maskFringeCurve),
    maskSurroundColor: uniform(new THREE.Color(EXPERIENCE_CONFIG.design.surroundColor)),
    maskSurroundAmount: uniform(EXPERIENCE_CONFIG.design.surroundTint),
    pointSize: uniform(2),
    sizeSpacingMix: uniform(1),
    sizeRequestedPx: uniform(2),
    foveaCore: uniform(new THREE.Vector4(0, 0.35, 0.35, 1.25)),
    foveaFactors: uniform(new THREE.Vector2(1, 1)),
    sizeHalfHeightPx: uniform(360),
    // Placeholders: applyPointSize resolves both from lod.pointSize.floorFactor /
    // ceilFactor against the live error target on the first frame and every frame after.
    sizeMinPx: uniform(1),
    sizeMaxPx: uniform(16),
    sizePxPerMetre: uniform(1),
    groundPatchAmount: uniform(EXPERIENCE_CONFIG.design.groundPatch.enabled
      ? EXPERIENCE_CONFIG.design.groundPatch.amount : 0),
    groundPatchColor: uniform(new THREE.Color(EXPERIENCE_CONFIG.design.groundPatch.color)),
    groundPatchOrigin: uniform(new THREE.Vector2(0, 0)),
    groundPatchCellSizeM: uniform(1),
    groundPatchIndexSize: uniform(1),
    groundPatchColorMix: uniform(EXPERIENCE_CONFIG.design.groundPatch.colorMix),
    groundPatchBrightness: uniform(EXPERIENCE_CONFIG.design.groundPatch.brightness),
    groundPatchBlurM: uniform(EXPERIENCE_CONFIG.design.groundPatch.blurM),
    groundPatchThreshold: uniform(EXPERIENCE_CONFIG.design.groundPatch.threshold),
    mapSaturation: uniform(EXPERIENCE_CONFIG.design.mapSaturation),
    mapBrightness: uniform(EXPERIENCE_CONFIG.design.mapBrightness),
    groundFogColor: uniform(new THREE.Color(EXPERIENCE_CONFIG.environment.dayFog)),
    groundFogStrength: uniform(EXPERIENCE_CONFIG.design.groundFog.strength),
    groundFogBaseZ: uniform(0),
    groundFogHeight: uniform(EXPERIENCE_CONFIG.design.groundFog.heightM),
    groundFogFadeBelow: uniform(EXPERIENCE_CONFIG.design.groundFog.fadeBelowM),
    groundFogDistance: uniform(EXPERIENCE_CONFIG.design.groundFog.efoldDistanceM),
    groundFogCurve: uniform(EXPERIENCE_CONFIG.design.groundFog.curve),
    enuInverse: uniform(new THREE.Matrix4()),
    daylightColor: uniform(new THREE.Color(0xffffff)),
    daylightIntensity: uniform(1),
    sunDirectionEnu: uniform(new THREE.Vector3(0, 0, 1)),
    cloudShadowOffset: uniform(new THREE.Vector2(0, 0)),
    cloudShadowStrength: uniform(0),
    cloudShadowScale: uniform(1 / EXPERIENCE_CONFIG.pointLighting.cloudShadowScaleM),
    cloudShadowContrast: uniform(EXPERIENCE_CONFIG.pointLighting.cloudShadowContrast),
    cloudDeckHeight: uniform(EXPERIENCE_CONFIG.pointLighting.cloudDeckHeightM),
    goldenFactor: uniform(0),
    warmRimColor: uniform(new THREE.Color(EXPERIENCE_CONFIG.pointLighting.warmRim)),
    canopyBaseZ: uniform(0),
    canopyTopZ: uniform(140),
    // Off, so nothing about the default render changes. Isolate still defaults to
    // "terminal only": it does nothing at mode 0, and it is the setting that makes the
    // very first click on a mode show a readable picture rather than a stack of levels.
    debugMode: uniform(0),
    debugStrength: uniform(0.85),
    debugIsolate: uniform(1),
    debugIsolateLevel: uniform(0),
  })
}

/** Vignette coverage in the survey's ENU frame: 1 in the core, 0 outside the
 * radius, and a flat 1 in every non-vignette mask mode. */
function maskFadeNode(u: CloudUniforms): any {
  const enu = u.enuInverse.mul(vec4(positionWorld, 1)).xyz
  const distance = length(enu.xy.sub(u.maskCenter))
  const fade = smoothstep(u.maskRadius, (u.maskRadius as any).mul(0.5), distance)
  const blended = mix(float(1), fade, u.vignetteStrength)
  return (u.maskMode.greaterThan(1.5) as any).select(blended, float(1))
}

/**
 * Apply the vignette surround to a finished colour: dim toward `floor` as before,
 * then carry the result toward maskSurroundColor so the ring around the mask can
 * be *graded* rather than only darkened.
 *
 * Pulling the floor remap outside the vignetteStrength blend is algebraically the
 * same as the previous fade-then-floor order (an affine remap commutes with mix),
 * so surroundAmount 0 reproduces the original look exactly.
 */
export function applyMaskSurround(u: CloudUniforms, color: any, floor = 0): any {
  const fade: any = maskFadeNode(u)
  const dimmed = color.mul(fade.mul(1 - floor).add(float(floor)))
  const outside = fade.oneMinus().mul(u.maskSurroundAmount)
  return mix(dimmed, u.maskSurroundColor, outside)
}

/**
 * Ground fog for both the points and the basemap, mixed into a finished colour.
 *
 * Analytic rather than raymarched: density is an exponential slab hugging the
 * survey floor, and the optical depth along a view ray through
 * `exp(-z / height)` has a closed form — two exp() calls and a divide. No volume
 * texture, no march loop, no post pass, and nothing to advance per frame because
 * the fog does not animate. Cost is a handful of ALU ops in shaders that already
 * sample a texture.
 *
 * Integrating along the ray (rather than sampling density at the fragment) is
 * what makes the fog behave like a real layer: looking across it from inside is
 * thick, looking down through it from 1 km up is thin, and neither needs its own
 * special case. The mix() guards the `1/dz` term on near-level rays, where the
 * integral degenerates to `length * density`.
 *
 * `groundFogFadeBelow` turns the one-sided slab into a band — a layer hanging in
 * the canopy with clear air beneath it. Deliberately applied as an envelope on
 * the integrated result rather than inside the integral: a two-sided profile has
 * no closed form, and re-deriving one would cost the cheapness that is this
 * function's whole point. The consequence is that the lower edge is shaped by the
 * shaded fragment's own height, not by how much of the band the view ray actually
 * crossed — so the band reads correctly looking at it, and softens rather than
 * layering properly when the camera sits inside its lower edge.
 */
export function groundFogNode(u: CloudUniforms): { amount: any; color: any } | null {
  if (!effects.groundFog) return null
  const enu = u.enuInverse.mul(vec4(positionWorld, 1)).xyz
  const cameraEnu = u.enuInverse.mul(vec4(cameraPosition, 1)).xyz
  const surfaceZ = enu.z.sub(u.groundFogBaseZ)
  const cameraZ = cameraEnu.z.sub(u.groundFogBaseZ)
  const rayLength = length(enu.sub(cameraEnu))
  const deltaZ = cameraZ.sub(surfaceZ)
  // Density is clamped at the fog base so nothing below it integrates to more
  // than the slab's own peak — the point cloud dips under the bbox floor.
  const densityAtSurface = exp(max(surfaceZ, float(0)).div(u.groundFogHeight).negate())
  const densityAtCamera = exp(max(cameraZ, float(0)).div(u.groundFogHeight).negate())
  const levelDepth = rayLength.mul(densityAtSurface)
  const slopedDepth = rayLength.mul(u.groundFogHeight)
    .mul(densityAtSurface.sub(densityAtCamera)).div(deltaZ)
  const opticalDepth = mix(levelDepth, slopedDepth, smoothstep(0.5, 5, abs(deltaZ)))
  // Lower edge of the band: 1 at the base, ramping to 0 fadeBelow metres under
  // it. The floor on the width keeps the two smoothstep edges from collapsing
  // onto each other at fadeBelow 0, where this has to stay a flat 1.
  const fadeBelow = max(u.groundFogFadeBelow, float(0.001))
  const belowFade = smoothstep(fadeBelow.negate(), float(0), surfaceZ)
  // groundFogDistance is the e-folding distance for a ray travelling along the
  // fog base. The curve exponent reshapes the Beer-Lambert ramp *after* the
  // integral, so it restyles the falloff without breaking the ray layering;
  // strength stays a plain final multiplier so 0 is reliably off.
  // groundFogDistance is a divisor and the panel lets it reach 0, so it is floored
  // here rather than trusting the binding — a NaN would poison every fragment.
  // The final clamp lets strength go past 100% for a denser, earlier-saturating
  // ramp without the mix() overshooting past the fog colour into wild values.
  return {
    amount: float(1).sub(exp(opticalDepth.div(max(u.groundFogDistance, float(0.01))).negate()))
      .pow(u.groundFogCurve)
      .mul(u.groundFogStrength)
      .mul(belowFade)
      .clamp(0, 1),
    color: u.groundFogColor,
  }
}

/**
 * Treat the basemap differently where the point cloud has data, so the map only
 * shows as-is where the cloud is not.
 *
 * Imagery material only — the point cloud keeps drawing on top. And it replaces
 * rather than discards: the draped imagery is the only surface the globe has
 * there, so cutting it would leave a hole with the sky behind it.
 *
 * Deliberately the LAST step in the imagery chain, after fog and the vignette.
 * Those are atmosphere for the map, and under the cloud there is no map to give
 * atmosphere to — the point is to see exactly the colour that was chosen, or the
 * basemap at exactly the brightness that was chosen. Anything layered on before
 * this, a high-resolution overlay included, is covered by it for free.
 *
 * `colorMix` runs the target from one end to the other: 0 is the raw imagery at
 * its own brightness, 1 is a flat colour, in between blends the two.
 *
 * `shrink` thresholds the blurred mask and so erodes the shape inward. That is the
 * safe direction: pulled slightly inside the data it leaves a little basemap at the
 * edge, while spilling past it reads as flat colour lying on the map.
 */
/**
 * Disc of offsets, in units of the feather radius, used to soften the patch edge.
 * Two rings of six plus the centre: enough taps that a wide feather reads as a ramp
 * instead of banding, and the second ring is rotated so the two do not line up.
 */
const GROUND_PATCH_TAPS: Array<[number, number]> = (() => {
  const taps: Array<[number, number]> = [[0, 0]]
  for (const [radius, phase] of [[0.55, 0], [1, Math.PI / 6]] as const) {
    for (let i = 0; i < 6; i++) {
      const angle = phase + (i * Math.PI) / 3
      taps.push([Math.cos(angle) * radius, Math.sin(angle) * radius])
    }
  }
  return taps
})()

/**
 * Coverage at one lattice position, as 0 or 1.
 *
 * The cell and the UV inside it both come from the same position, so offsetting the
 * position is all it takes to sample across a cell boundary — no special case at the
 * seams, which is what makes the feather below work at all.
 */
function groundPatchCoverageAt(u: CloudUniforms, gridPos: any): any {
  const cellXY: any = floor(gridPos)
  const withinCell: any = gridPos.sub(cellXY)
  // Which layer holds this cell. The index map stores layer + 1 so that 0 can mean
  // "no data here" — a cell that was never allocated because no point fell in it.
  // Sampled at cell centres, and nearest-filtered, so no interpolation between
  // neighbouring entries can invent a layer that does not exist.
  const indexUv: any = cellXY.add(vec2(0.5)).div(u.groundPatchIndexSize)
  const slot: any = groundPatchIndexNode.sample(indexUv).r.mul(255).add(0.5)
  // An unallocated cell reads 0, which would address layer -1. Clamped to a valid
  // layer and multiplied away instead, because a branch here would be per-fragment.
  const present: any = smoothstep(float(0.5), float(1.5), slot)
  const layer: any = int(max(slot, float(1)).sub(1))
  // Reject anything outside the lattice. Without this the index texture clamps to its
  // edge — pinning one layer — while `withinCell` is a fraction that repeats every
  // cell, so that one cell's contents tile away from the survey for ever, banded along
  // whichever axis is still in range.
  //
  // Latent from the start, but invisible until the floating origin: with positionWorld
  // at ECEF magnitudes the float32 subtraction lost so much precision that gridPos out
  // there was noise, and the clamped lookup landed on empty cells. Once the origin sits
  // near the camera the arithmetic is accurate, the fraction sweeps cleanly, and the
  // tiling snaps into focus.
  const inside: any = step(vec2(0), indexUv).mul(step(indexUv, vec2(1)))
  return groundPatchMaskNode.sample(withinCell).depth(layer).r
    .mul(present).mul(inside.x).mul(inside.y)
}

/**
 * Half-width of the threshold ramp. Not a design control — just enough to antialias the
 * cut, which would otherwise stair-step along mask pixels. The shape's smoothness comes
 * from the blur; this only keeps its edge from being jagged.
 */
const GROUND_PATCH_THRESHOLD_AA = 0.02

export function applyGroundPatch(u: CloudUniforms, finished: any, rawImagery: any): any {
  // Switched off, or no mask built yet, means nothing to change.
  if (!effects.groundPatch || !groundPatchMaskNode || !groundPatchIndexNode) return finished
  // Annotated `any` like the rest of this file's node plumbing: the uniforms are
  // untyped, so TSL's overloads would otherwise collapse this vec2 work to float.
  const enu: any = u.enuInverse.mul(vec4(positionWorld, 1)).xyz
  // Position within the lattice, in cells. The integer part picks the cell, the
  // fraction is the UV inside it.
  const gridPos: any = enu.xy.sub(u.groundPatchOrigin).div(u.groundPatchCellSizeM)

  // Averaging the disc turns the mask's hard 0/1 coverage into a ramp across the
  // feather width, which is what `shrink` then thresholds. Without it there is
  // nothing between "point data" and "no point data" to slide along, and shrink has
  // no effect at all — the splatted mask has no blur of its own.
  //
  // Done here rather than on the CPU because the mask is stored per cell: blurring it
  // in place would need each cell to read its neighbours, and would have to be redone
  // on every change. Here it costs taps on basemap fragments only, and lets the
  // feather width be a live control.
  // Blur, then threshold. Two primitives instead of the shrink/fade pair they used to
  // be dressed up as: that version derived the radius from one control and the cut
  // level from the other, which coupled them, capped the fade, and cost two rounds of
  // bugs. Here the disc radius *is* the blur and the cut *is* the threshold.
  //
  // Eroding and dilating both come out of the threshold: above 0.5 the edge pulls
  // inward, below it pushes out, and how far either goes is set by the blur radius.
  const radiusCells: any = u.groundPatchBlurM.div(u.groundPatchCellSizeM)
  // 13 taps only quantise coverage into thirteenths, which would show as bands
  // stepping inward from the edge. Rotating and rescaling the disc per fragment
  // scatters those steps into fine noise instead, which reads as a smooth ramp — far
  // cheaper than the tap count it would otherwise take, since it adds arithmetic
  // rather than texture reads.
  const noise: any = hash(screenCoordinate.x.mul(97.13).add(screenCoordinate.y.mul(31.7)))
  const angle: any = noise.mul(6.2831853)
  const sa: any = sin(angle)
  const ca: any = cos(angle)
  const jitteredRadius: any = radiusCells.mul(noise.mul(0.3).add(0.85))
  let sum: any = groundPatchCoverageAt(u, gridPos)
  for (let i = 1; i < GROUND_PATCH_TAPS.length; i++) {
    const [ox, oy] = GROUND_PATCH_TAPS[i]
    const rotated: any = vec2(
      ca.mul(ox).sub(sa.mul(oy)),
      sa.mul(ox).add(ca.mul(oy)),
    )
    sum = sum.add(groundPatchCoverageAt(u, gridPos.add(rotated.mul(jitteredRadius))))
  }
  const blurred: any = sum.div(float(GROUND_PATCH_TAPS.length))

  const threshold: any = u.groundPatchThreshold
  const coverage: any = smoothstep(
    threshold.sub(GROUND_PATCH_THRESHOLD_AA), threshold.add(GROUND_PATCH_THRESHOLD_AA), blurred,
  ).mul(u.groundPatchAmount)
  // From the raw texture, not the graded result, so neither the global basemap
  // grading nor the daylight ramp leaks into the chosen appearance.
  //
  // The ground fog and the vignette are excluded by running after them. Three's own
  // scene fog is not, because it is applied after the colour node — measured, a patch
  // picked as (0,255,136) renders as (42,251,149) at 1.8 km with distance fog on.
  // Left as is on purpose: that haze is aerial perspective, and exempting the ground
  // from it would make it float away from everything around it.
  const ownBrightness: any = rawImagery.mul(u.groundPatchBrightness)
  const target: any = mix(ownBrightness, vec3(u.groundPatchColor), u.groundPatchColorMix)
  return mix(finished, target, coverage)
}

/** Desaturate + darken the basemap only, so the imagery can sit back without
 * dulling the point cloud that reads on top of it. */
export function gradeImageryNode(u: CloudUniforms, rgb: any): any {
  const luma = rgb.r.mul(0.2126).add(rgb.g.mul(0.7152)).add(rgb.b.mul(0.0722))
  return mix(vec3(luma), rgb, u.mapSaturation).mul(u.mapBrightness)
}

/** Names of the per-instance attributes each tile geometry must carry. Kept out
 * of three's own `instancePosition`/`instanceColor` namespace so no InstancedMesh
 * machinery can claim them. */
export const POINT_POSITION_ATTRIBUTE = 'cloudPointPosition'
export const POINT_COLOR_ATTRIBUTE = 'cloudPointColor'

// Every tile sits on the WGS84 globe, so its world matrix carries an ECEF
// translation of ~5.8e6 m — 0.5 m per float32 step at that magnitude. Three's
// node materials build the model-view matrix in the shader by default
// (`mediumpModelViewMatrix = cameraViewMatrix.mul(modelWorldMatrix)`), so each
// tile rounds on its own grid and the camera matrix rounds along with it: tiles
// shift by metres relative to one another and tear visible seams into the
// canopy as the camera moves. `highpModelViewMatrix` multiplies the same two
// matrices in JS at float64 and uploads the camera-relative result, which is
// small enough to stay exact — the classic WebGLRenderer has always done this.
//
// Applied per material rather than through `renderer.highPrecision`, which is
// documented as incompatible with InstancedMesh and SkinnedMesh; this scene has
// both (cloud puffs in environment-layer, the rigged parrots in
// field-model-layer). Our tiles are plain Meshes with an InstancedBufferGeometry,
// whose per-instance attributes feed positionLocal before the matrix is applied.
const HIGH_PRECISION_CONTEXT = context({ modelViewMatrix: highpModelViewMatrix })
let highPrecisionMatrices = true

/** Diagnostic switch behind the panel toggle. Only affects materials created
 * afterwards — callers refresh live tiles themselves. */
export function setHighPrecisionMatrices(enabled: boolean): void {
  highPrecisionMatrices = enabled
}

/**
 * Effects that can be compiled out entirely rather than turned down to zero.
 *
 * A uniform at 0 still costs whatever the shader does to reach it — the ground fog
 * still integrates its optical depth, the patch still takes its 13 taps — and the
 * point of these switches is to measure and reclaim exactly that. Turning one off
 * therefore rebuilds the affected materials without the code, which is why they live
 * here as build-time flags and not as uniforms.
 */
/** Basemap imagery hangs off the same ECEF transforms but gains nothing from the
 * float32 A/B: every tile is a plane whose vertices sit relative to its own
 * bounding-sphere centre, so mediump rounds each tile onto its own grid and the
 * neighbours drift apart by up to a metre. The hairline cracks let the clear
 * colour through — the blue lines between map tiles. Imagery therefore stays on
 * the high-precision path unconditionally, including during loader and flight. */
export function applyHighPrecisionAlways(material: any): void {
  if (!material || material.contextNode === HIGH_PRECISION_CONTEXT) return
  material.contextNode = HIGH_PRECISION_CONTEXT
  material.needsUpdate = true
}

/**
 * Build-time switches. Each one decides whether a piece of the graph is *emitted*, not
 * whether it is taken at runtime, so flipping any of them costs a shader rebuild across
 * every live tile material — `refreshEffects()` in streaming.ts.
 *
 * `roundDots` and `debugIsolate` are here rather than behind a uniform for one reason:
 * they can discard. A shader whose source contains a discard anywhere cannot be given
 * the GPU's early depth path, because the hardware must assume the fragment might not
 * survive to write depth. `if (uniform > 0.5) discard;` counts — the driver has no way to
 * know at compile time that the uniform will be zero. So a discard gated by a uniform
 * costs the fast path for the whole session in exchange for a feature nobody switched on.
 */
const effects = {
  groundFog: true,
  groundPatch: true,
  cloudShadows: true,
  /** Cut each square quad into a circle. Off is the A side of the early-Z comparison. */
  roundDots: true,
  /** The level inspector's "show only this layer" cut. Only emitted while it is in use. */
  debugIsolate: false,
}
export type CloudEffect = keyof typeof effects

/**
 * 1 where the vignette keeps a point, 0 where it dissolves it.
 *
 * Evaluated in the vertex stage and multiplied into the drawn size, so a dissolved point
 * collapses to a zero-area quad and produces no fragments at all. It used to be a discard
 * in the colour node — a per-point decision expressed per fragment, which shaded the point
 * first and threw it away second, and cost every material its early depth rejection for a
 * feature that is off by default (`design.maskMode` is 0).
 *
 * Fringe rather than a clean circular cut: across the band each point holds a stable
 * pseudo-random keep-threshold, so points thin out gradually and the edge reads as
 * scattered stragglers instead of a scissor line. The seed comes from the ENU position so
 * a point dissolves identically every frame and across tile reloads. Metre coordinates
 * are wrapped into a small range on purpose: hash() truncates its seed to uint, and raw
 * ENU metres reach ~1e8 after scaling, where float32 quantises to steps far larger than a
 * point spacing — neighbours would collide and whole blocks would pop instead of
 * individual points. A floor on the width keeps the smoothstep edges from collapsing onto
 * each other at fringe 0.
 */
function maskDissolveKeep(u: CloudUniforms): any {
  const enu = u.enuInverse.mul(vec4(positionWorld, 1)).xyz
  const distance = length(enu.xy.sub(u.maskCenter))
  const fringeInner = u.maskRadius.mul(float(1).sub(max(u.maskFringe, float(0.001))))
  const keepChance = smoothstep(u.maskRadius, fringeInner, distance).pow(u.maskFringeCurve)
  const seed = hash(abs(enu.x.mul(131).add(enu.y.mul(1367))).mod(1_048_576))
  const dissolving = u.maskMode.greaterThan(1.5)
    .and(u.vignetteStrength.greaterThan(0.95))
    .and(seed.greaterThan(keepChance))
  return dissolving.select(float(0), float(1))
}

/**
 * Flip an effect. Returns true when the value actually changed, so callers know
 * whether they need to pay for a material rebuild.
 */
/**
 * The four values that differ per tile, as FOUR SHARED NODES rather than four per tile.
 *
 * This is what lets every tile reuse one compiled shader *and* one built node graph.
 *
 * three keys its node-builder cache on `renderObject.initialCacheKey`, which walks the
 * material's node graph and folds in each node's `getCacheKey()`. That bottoms out at
 * `Node.customCacheKey()`, whose default implementation returns `this.id` — a per-instance
 * counter. So two materials built from *structurally identical but separately constructed*
 * graphs get different keys, always miss, and each run a full TSL build. Measured on this
 * tree: 5.4 ms median and 16.2 ms worst per tile, synchronously inside the render pass, to
 * produce WGSL that was byte-identical 50 times out of 50.
 *
 * `onObjectUpdate` is three's own answer, used by `modelNormalMatrix` and the material
 * property nodes: one node instance, whose value is refreshed per render object from a
 * callback. The node identity is shared, so the cache key collapses; the value is not.
 *
 * Each reads through a `{ value }` holder on `material.userData` so that everything in
 * streaming.ts that writes `…userData.thinScale.value = x` keeps working untouched — the
 * holder is a plain object now instead of a uniform node, and nothing outside this file
 * needs to know.
 */
const SHARED_FALLBACK_SPACING_M = EXPERIENCE_CONFIG.lod.pointSize.fallbackSpacingM

const tileThinScale = uniform(1).onObjectUpdate(
  ({ material }: any) => material?.userData?.thinScale?.value ?? 1,
)
const tileSpacingMetres = uniform(SHARED_FALLBACK_SPACING_M).onObjectUpdate(
  ({ material }: any) => material?.userData?.spacingMetres?.value ?? SHARED_FALLBACK_SPACING_M,
)
// Vector and colour uniforms mutate `self.value` rather than returning a new object, which
// is the pattern three uses for modelNormalMatrix — returning a fresh instance every frame
// would allocate once per tile per frame.
const tileDebugInfo = uniform(new THREE.Vector4(0, 0, 1, 1)).onObjectUpdate(
  ({ material }: any, self: any) => {
    const held = material?.userData?.debugTile?.value
    if (held) self.value.copy(held)
    return self.value
  },
)
const tileDebugTint: any = uniform(new THREE.Color(0xffffff)).onObjectUpdate(
  ({ material }: any, self: any) => {
    const held = material?.userData?.debugTint
    if (held) self.value.copy(held)
    return self.value
  },
)

/**
 * The built graph, keyed by the only two things that can still change its shape: the colour
 * attribute's component count, and which effects are compiled in.
 *
 * `effectsVersion` rather than an explicit invalidation call, so a flag flip cannot leave a
 * stale graph behind: `setCloudEffectEnabled` bumps it, the next lookup misses, and every
 * material that asks to rebuild gets the new graph — the first one pays the build, the rest
 * hit the cache.
 */
let effectsVersion = 0
const cloudGraphCache = new Map<string, { sizeNode: any; positionNode: any; colorNode: any }>()

/** The basemap builds its own graph from the same effect flags and needs the same cache
 *  invalidation — see globe.ts. */
export function cloudEffectsVersion(): number {
  return effectsVersion
}

export function setCloudEffectEnabled(effect: CloudEffect, enabled: boolean): boolean {
  if (effects[effect] === enabled) return false
  effects[effect] = enabled
  effectsVersion++
  return true
}

/**
 * Rebuild one material's colour graph under the current flags. Materials record how
 * to rebuild themselves at creation, because the graph is built from things only the
 * creator has — the tile's own texture, its colour item size.
 */
export function rebuildEffectMaterial(material: any): void {
  const rebuild = material?.userData?.rebuildColorNode
  if (typeof rebuild !== 'function') return
  rebuild()
  material.needsUpdate = true
}

/**
 * Apply the current precision mode to one already-built material.
 *
 * Toggling this changes a few scattered pixels, which looks alarming and is not.
 * Nothing about the colour changes: every colour term in this file derives from
 * `positionWorld`, which three defines as `modelWorldMatrix * positionLocal` and which
 * therefore never sees the matrix this swaps. What changes is only the clip position and
 * the depth — measured with the floating origin active, 0.0016 px laterally and 0.1 mm
 * in depth.
 *
 * That is enough to flip individual pixels, for two reasons that both need only a
 * sub-millimetre change:
 *   - the depth test picks a different winner. Overdraw runs about 20x, so ~20 quads
 *     cover each pixel; wherever the two frontmost sit within 0.1 mm of each other, the
 *     rounding decides which one is drawn, and each point carries its own colour.
 *   - a quad's hard edge flips. Points are ~4 px quads cut to a circle by Discard() with
 *     antialias off, so a pixel centre sitting on that edge switches between drawn and
 *     discarded, revealing whatever is behind it.
 *
 * Both scatter isolated pixels rather than shifting anything, which is exactly what it
 * looks like. With hard-edged points at more than one per pixel the image is a step
 * function of position: it cannot be bit-identical under any change, however small. What
 * matters is that nothing moves — see navigation.originRebase* for why the error is this
 * small in the first place.
 */
export function applyMatrixPrecision(material: any): void {
  if (!material) return
  const next = highPrecisionMatrices ? HIGH_PRECISION_CONTEXT : null
  if (material.contextNode === next) return
  material.contextNode = next
  material.needsUpdate = true
}

/** What the false-colour inspector needs to know about one tile that never changes
 *  while it is loaded. The two per-frame values come from the traversal instead — see
 *  `debugTile` in createCloudMaterial and updateDebugTiles in streaming.ts. */
export interface TileDebugInfo {
  /** APH node depth, or 0/1/2 for the One-LOD tiers — see densityLevel. */
  level: number
  /** That level's palette entry, hex. */
  tint: number
  /** The pipeline wrote `geometricError: 0`, so this tile can never refine. */
  isLeaf: boolean
}

const NO_TILE_DEBUG: TileDebugInfo = { level: 0, tint: 0xffffff, isLeaf: false }

/**
 * The node graph, built once per (colour component count, effect flag set) and shared by
 * every tile material that matches.
 *
 * Building it per tile was the point: the nodes were structurally identical but freshly
 * constructed, and three keys its node-builder cache on node *identity*, so every tile
 * missed and re-ran a full TSL build inside the render pass. Handing out the same node
 * objects collapses the key, and the build happens once.
 *
 * Safe to share because nothing in here is per tile any more: the four values that are
 * (thinning scale, spacing, and the two inspector inputs) travel through the shared
 * `onObjectUpdate` nodes above, which read them off the material being drawn.
 */
function cloudGraphFor(u: CloudUniforms, colorItemSize: number) {
  const key = `${colorItemSize}|${effectsVersion}|${highPrecisionMatrices ? 1 : 0}`
  const cached = cloudGraphCache.get(key)
  if (cached) return cached

  const thinScale = tileThinScale
  const spacingMetres = tileSpacingMetres
  /**
   * How far apart this point's neighbours actually land on screen, in CSS pixels.
   *
   * `spacingMetres` is the effective spacing — the whole drawn stack at this spot, not
   * the tile's own; see applyEffectiveSpacing. `thinScale` belongs inside it because
   * thinning genuinely widens the real spacing by dropping points, so it is part of what
   * was delivered rather than a separate correction on top.
   */
  // The point centre, not a quad corner: setupPositionView derives positionView from
  // positionNode, which is the instanced position below. Floored so a point sitting on
  // the eye cannot divide by zero.
  const viewDepth = positionView.z.negate().max(float(0.001))
  const deliveredPx = spacingMetres
    .mul(thinScale)
    .mul(u.sizePxPerMetre)
    .div(viewDepth)
  /**
   * What is being asked for *here*, rather than one number for the frame.
   *
   * Foveation does not lower the detail everywhere — it tells the corner of the image to
   * stop refining sooner, by dividing that tile's error by a factor. Against a flat
   * denominator the size rule would read a deliberately coarsened periphery as a
   * shortfall, try to widen those dots by the same factor, and hit the ceiling instead:
   * fewer points and no extra width, which is a holey edge. Bending the denominator by
   * the same ramp puts the periphery back at a shortfall of 1 — it was asked for coarser
   * data and got it, so nothing is short — and anything that still falls short there
   * widens by exactly the amount it fell short.
   *
   * Per point, not per tile. The CPU side applies one factor per tile, which is all a
   * refine-or-not decision needs, but a per-tile dot size would step at tile rectangles
   * and draw the ramp as visible boxes.
   *
   * Same geometry as foveation.ts `measure`, evaluated at a point instead of a rectangle:
   * distance from the core rectangle, eased over `falloff`. Equal factors collapse it to
   * a constant, which is what an unfoveated frame writes.
   */
  // Annotated `any` like the rest of this file's node plumbing — the untyped uniforms
  // otherwise collapse TSL's overloads.
  const halfHeights: any = u.sizePxPerMetre.div(viewDepth).div(u.sizeHalfHeightPx)
  const view: any = positionView
  const foveaX: any = view.x.mul(halfHeights).abs().sub(u.foveaCore.y).max(float(0))
  const foveaY: any = view.y.mul(halfHeights).sub(u.foveaCore.x).abs().sub(u.foveaCore.z).max(float(0))
  const foveaGap: any = foveaX.mul(foveaX).add(foveaY.mul(foveaY)).sqrt()
  const foveaRamp: any = smoothstep(float(0), float(1), foveaGap.div(u.foveaCore.w.max(float(0.001))))
  const foveaFactor: any = mix(u.foveaFactors.x, u.foveaFactors.y, foveaRamp)
  const requestedPx: any = u.sizeRequestedPx.mul(foveaFactor).max(float(0.001))
  /**
   * The shortfall: how far short of the requested spacing the tree actually came.
   *
   * `requestedPx` is the spacing being asked for here, so this is **exactly 1
   * wherever refinement delivered what was asked** — which is nearly everywhere, because
   * that is what the target means. The size is then just the base size, identical to the
   * fixed mode, and even by construction rather than by tuning.
   *
   * It rises above 1 only where the tree could not deliver, and those are the three
   * places worth drawing bigger: a leaf bottomed out at `geometricError: 0` seen closer
   * than its spacing supports, a tile held coarse by a brake or by foveation, and a tile
   * thinned away from under itself. Below 1 is clamped off — a tile finer than asked is
   * drawn at the base size and its dots overlap slightly, which costs a little fill and
   * never leaves a gap.
   *
   * This is what replaces sizing from an absolute projected spacing. The absolute form
   * had to be tuned against two pixel sliders and still produced a different size per
   * level; a ratio against the target needs no tuning at all, because both sides are
   * measured in the same units the renderer already refines by, so whatever the spacing
   * convention gets wrong cancels wherever the ratio is 1.
   */
  const shortfall = deliveredPx.div(requestedPx).max(float(1))
  // Both paths always compiled, so the mode switch is a uniform write rather than a
  // shader rebuild across every live tile material. They now share `pointSize` as their
  // base, so at shortfall 1 the two modes draw the identical frame and the A/B shows only
  // what the shortfall added.
  //
  // The fixed branch stays unclamped and keeps `thinScale` as a plain multiplier: nothing
  // there knows about spacing, so the widening has nowhere else to go, and applying the
  // ceiling would reintroduce the limit that made hard thinning lose coverage.
  //
  // The vignette's keep test rides on the same size: a dissolved point is drawn at zero
  // width, which the rasteriser drops before it can cost a single fragment.
  const sizeNode = mix(
    u.pointSize.mul(thinScale),
    u.pointSize.mul(shortfall).clamp(u.sizeMinPx, u.sizeMaxPx),
    u.sizeSpacingMix,
  ).mul(maskDissolveKeep(u))
  // Drives positionLocal, so positionWorld below stays the point centre rather
  // than a quad corner — the mask, cloud shadow and height grading keep working.
  const positionNode = attribute(POINT_POSITION_ATTRIBUTE, 'vec3')

  const pointColor = colorItemSize === 4
    ? (attribute(POINT_COLOR_ATTRIBUTE, 'vec4') as any).xyz
    : (attribute(POINT_COLOR_ATTRIBUTE, 'vec3') as any)

  /**
   * The inspector's per-tile inputs: x = level, y = 1 for a leaf, z = the tile's own
   * error over the live target, w = 1 where refinement stopped. x and y are set once,
   * here; z and w are refreshed from the traversal each frame while a mode is on.
   *
   * Uniforms rather than baked constants, unlike `spacingM` above. A literal is inlined
   * into the generated shader, so a per-tile value forks the program — and per-tile
   * codegen is exactly the cost the shared-material work is aimed at (see
   * plans/decision-distance-lod.md). A diagnostic must not add to it.
   */
  // z and w start neutral — on target, and drawing — so a tile that has not been
  // walked yet (the first frame after a mode is switched on) looks ordinary instead of
  // vanishing under the isolate test or reading as wildly over-refined.
  const debugTile = tileDebugInfo
  const debugTint: any = tileDebugTint

  const buildColorNode = () => Fn(() => {
    // Round dots instead of squares — and the reason this is a build flag rather than a
    // uniform is that it discards. See the `effects` block: a discard anywhere in the
    // source costs the whole material its early depth rejection, so with ~19 quads over
    // every pixel this one statement decides whether the other eighteen are shaded in
    // full before being thrown away.
    if (effects.roundDots) {
      If(uv().sub(vec2(0.5)).length().greaterThan(0.5), () => Discard())
    }

    const enu = u.enuInverse.mul(vec4(positionWorld, 1)).xyz

    // Isolate one layer. Only emitted while the inspector is actually in use, for the
    // same reason as above — it used to sit here permanently, gated on a uniform that is
    // zero in every normal session.
    if (effects.debugIsolate) {
      const notTerminal = u.debugIsolate.greaterThan(0.5).and(u.debugIsolate.lessThan(1.5))
        .and(debugTile.w.lessThan(0.5))
      const otherLevel = u.debugIsolate.greaterThan(1.5)
        .and(abs(debugTile.x.sub(u.debugIsolateLevel)).greaterThan(0.5))
      If(u.debugMode.greaterThan(0.5).and(notTerminal.or(otherLevel)), () => Discard())
    }

    // Directional cues without normals: project each point up the sun ray onto
    // a virtual cloud deck and shade it by the drifting cloud density there.
    const cloudShadow = float(1).toVar()
    if (effects.cloudShadows && cloudShadowTextureNode) {
      const sunZ = max(u.sunDirectionEnu.z, float(0.15))
      const toDeck = u.cloudDeckHeight.sub(enu.z).div(sunZ)
      const deckXY = enu.xy.add(u.sunDirectionEnu.xy.mul(toDeck))
      const uvw = vec3(deckXY.mul(u.cloudShadowScale).add(u.cloudShadowOffset), float(0.5))
      // Contrast tightens the noise-to-shadow window around its midpoint instead
      // of scaling the result: widening the ramp would only wash the shadows out
      // again, while narrowing it turns soft blotches into defined cloud gaps.
      // Contrast 0 reproduces the original fixed 0.32–0.62 window exactly.
      const shadowMid = float(0.47)
      const shadowHalfWindow = mix(float(0.15), float(0.005), u.cloudShadowContrast)
      const shadowDensity = smoothstep(
        shadowMid.sub(shadowHalfWindow), shadowMid.add(shadowHalfWindow),
        cloudShadowTextureNode.sample(uvw).r,
      )
      cloudShadow.assign(float(1).sub(shadowDensity.mul(u.cloudShadowStrength)))
    }

    // Golden-hour warmth climbs the canopy: higher points catch the low sun.
    const height01 = smoothstep(u.canopyBaseZ, u.canopyTopZ, enu.z)
    const rim = mix(vec3(1), vec3(u.warmRimColor), height01.mul(u.goldenFactor) as any)

    // PNTS RGB is sRGB encoded. TSL expects a linear working colour.
    const graded = pointColor
      .pow(2.2)
      .mul(u.daylightColor)
      .mul(u.daylightIntensity)
      .mul(cloudShadow)
      .mul(rim)

    // Fog before the vignette dim, so the mask still darkens the fogged result
    // rather than the fog re-lighting the vignette edge.
    const fog = groundFogNode(u)
    const atmospheric = fog ? mix(graded, fog.color, fog.amount) : graded
    const finished = applyMaskSurround(u, atmospheric, 0.30)

    /**
     * Error headroom: where this tile's own error sat against the live target.
     *
     * Five hard bands, not a gradient. This was a continuous log ramp blending blue to
     * green to red, and it could not answer the one question the view is for — which
     * tiles are sitting *on* the target. Two reasons it failed. A settled frame has no
     * tile above the target at all, so the whole red half went unused and every tile
     * crowded into the blue-to-green half; and inside that half a linear blend passes
     * through teal, so 0.5 and 0.9 differed by a shade no one can name. `step()` gives
     * each band one flat colour, so the on-target set reads as a region with an edge.
     *
     * Bands ascend, so the mixes cascade: each `step` overwrites the one below it.
     * Neighbouring bands differ in hue, and the two blues differ in lightness as well,
     * because a hue step alone is not enough at the bottom where most tiles land.
     *
     * A leaf is called out in white instead. It carries `geometricError: 0` and so
     * reports error 0, which on any ramp would read as "far finer than needed" when
     * what it means is "nothing left to give" — a step the target can never move.
     */
    const ratio = debugTile.z
    const band = mix(mix(mix(mix(
      vec3(0.118, 0.227, 0.541),                       // < 0.4  far finer than asked
      vec3(0.231, 0.510, 0.965), step(0.4, ratio)),    // 0.4–0.7  a level in hand
      vec3(0.133, 0.773, 0.369), step(0.7, ratio)),    // 0.7–1    sitting on the target
      vec3(0.961, 0.620, 0.043), step(1.0, ratio)),    // 1–2      over it, still asking
      vec3(0.863, 0.149, 0.149), step(2.0, ratio))     // >= 2     two levels behind

    // A leaf is white here; the level view keeps its own palette.
    const errorColor = mix(band, vec3(1), debugTile.y)
    const debugColor = mix(vec3(debugTint), errorColor, step(1.5, u.debugMode))

    // Over the finished image rather than in place of the albedo: fog and the daylight
    // grade would otherwise wash the diagnostic out at exactly the distances it is being
    // read at. The discards above still apply, so the frame keeps the shape the real
    // render has.
    return mix(finished, debugColor, u.debugStrength.mul(step(0.5, u.debugMode)))
  })()

  const graph = { sizeNode, positionNode, colorNode: buildColorNode() }
  cloudGraphCache.set(key, graph)
  return graph
}

/** Create a material for exactly one streamed tile. Never share it across tiles:
 * UnloadTilesPlugin disposes hidden tile materials independently.
 *
 * The tile is drawn as instanced camera-facing quads, not as THREE.Points:
 * PointsNodeMaterial only evaluates `sizeNode` in its sprite path, and both
 * backends pin a real point primitive to one pixel (WebGPU has no point-size
 * builtin, the WebGL node fallback hardcodes `gl_PointSize = 1.0`). One pixel at
 * a >1 device pixel ratio is smaller than a CSS pixel, which is what tore holes
 * into the canopy. `colorItemSize` is 4 for RGBA tiles and 3 for RGB.
 */
export function createCloudMaterial(
  u: CloudUniforms,
  colorItemSize = 3,
  /** This tile's own mean point spacing in metres — see tileSpacingMetres in streaming.ts.
   * The initial value of a per-tile holder read by the shared `tileSpacingMetres` node, not
   * a baked constant: a literal here would fork the shader for every tile. */
  spacingM: number = EXPERIENCE_CONFIG.lod.pointSize.fallbackSpacingM,
  debug: TileDebugInfo = NO_TILE_DEBUG,
): PointsNodeMaterial {
  const material = new PointsNodeMaterial()
  if (highPrecisionMatrices) material.contextNode = HIGH_PRECISION_CONTEXT
  material.transparent = false
  material.depthWrite = true
  // Three's own attenuation cannot serve this tree: `refine: ADD` draws every level
  // in one pass, so there is no single world size to attenuate. The size is built
  // below instead, from this tile's spacing and each point's own view depth.
  material.sizeAttenuation = false
  /**
   * The four values that are genuinely per tile, as plain `{ value }` holders.
   *
   * They used to be uniform *nodes* built here, which is precisely what forced a fresh
   * node graph — and therefore a fresh TSL build — for every tile. The shared nodes at the
   * top of this file now read these through `onObjectUpdate`, so the values stay per tile
   * while the graph is one object shared by all of them.
   *
   * The `{ value }` shape is deliberate: streaming.ts writes `userData.thinScale.value`,
   * `userData.spacingMetres.value` and `userData.debugTile.value.z` directly, and none of
   * those call sites had to change.
   *
   * debugTile: x = level, y = 1 for a leaf, z = this tile's error over the live target,
   * w = 1 where refinement stopped. z and w start neutral so a tile the traversal has not
   * walked yet looks ordinary rather than vanishing under the isolate test.
   */
  material.userData.thinScale = { value: 1 }
  material.userData.spacingMetres = { value: spacingM }
  material.userData.debugTile = { value: new THREE.Vector4(debug.level, debug.isLeaf ? 1 : 0, 1, 1) }
  material.userData.debugTint = new THREE.Color(debug.tint)

  // One graph for every tile that shares these two facts; see cloudGraphFor.
  const graph = cloudGraphFor(u, colorItemSize)
  material.sizeNode = graph.sizeNode
  material.positionNode = graph.positionNode
  material.colorNode = graph.colorNode
  material.userData.rebuildColorNode = () => { material.colorNode = cloudGraphFor(u, colorItemSize).colorNode }

  return material
}
