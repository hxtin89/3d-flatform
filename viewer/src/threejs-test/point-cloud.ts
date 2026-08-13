// Point-cloud material for the streamed tiles. The geometry itself stays
// tile-owned so Three can release CPU and GPU resources as the camera moves.
// Points are drawn as instanced quads — see createCloudMaterial for why.
import * as THREE from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import {
  Fn, If, Discard, uniform, attribute, positionWorld, texture, texture3D, uv,
  vec2, vec3, vec4, float, int, mix, smoothstep, length, max, min, abs, exp, floor, hash,
  acos, sqrt, clamp,
  cameraPosition, context, highpModelViewMatrix, screenCoordinate, sin, cos,
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
  pointSize: any
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
  /**
   * Metres the patch edge is pulled inward from the mask outline. Directly a
   * distance, not a threshold — see applyGroundPatch for how the sampling radius and
   * the threshold are derived from it so that this number means what it says.
   */
  groundPatchShrinkM: any
  /**
   * Width of the fade in metres, independent of the shrink distance. Independent on
   * purpose: as a fraction it grew with the shrink, and past ~80 m the band was wider
   * than the river and tinted the whole channel — see applyGroundPatch.
   */
  groundPatchFadeM: any
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

export function createUniforms(): CloudUniforms {
  return {
    maskCenter: uniform(new THREE.Vector2(0, 0)),
    maskRadius: uniform(120),
    maskMode: uniform(EXPERIENCE_CONFIG.design.maskMode),
    vignetteStrength: uniform(0),
    maskFringe: uniform(EXPERIENCE_CONFIG.design.maskFringe),
    maskFringeCurve: uniform(EXPERIENCE_CONFIG.design.maskFringeCurve),
    maskSurroundColor: uniform(new THREE.Color(EXPERIENCE_CONFIG.design.surroundColor)),
    maskSurroundAmount: uniform(EXPERIENCE_CONFIG.design.surroundTint),
    pointSize: uniform(2),
    groundPatchAmount: uniform(EXPERIENCE_CONFIG.design.groundPatch.enabled
      ? EXPERIENCE_CONFIG.design.groundPatch.amount : 0),
    groundPatchColor: uniform(new THREE.Color(EXPERIENCE_CONFIG.design.groundPatch.color)),
    groundPatchOrigin: uniform(new THREE.Vector2(0, 0)),
    groundPatchCellSizeM: uniform(1),
    groundPatchIndexSize: uniform(1),
    groundPatchColorMix: uniform(EXPERIENCE_CONFIG.design.groundPatch.colorMix),
    groundPatchBrightness: uniform(EXPERIENCE_CONFIG.design.groundPatch.brightness),
    groundPatchShrinkM: uniform(EXPERIENCE_CONFIG.design.groundPatch.shrinkM),
    groundPatchFadeM: uniform(EXPERIENCE_CONFIG.design.groundPatch.fadeM),
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
  }
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
  return groundPatchMaskNode.sample(withinCell).depth(layer).r.mul(present)
}

/**
 * Radius to sample at, as a multiple of the wanted shrink distance. The fade raises it
 * further when it needs more room — see applyGroundPatch, where the threshold and the
 * metres-to-fraction slope are then derived from the ratio the two settle on.
 */
const GROUND_PATCH_RADIUS_FACTOR = 1.5

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
  // Sampling radius, from the shrink alone.
  //
  // Letting the fade raise it too was tried and reverted: it does widen the band, but
  // the disc then reaches across the river, and a disc wider than a gap cannot see the
  // gap. Measured on a scanline over the channel, a 120 m fade lifted the river from
  // near-black to 185-255 — the patch closed over the water the shrink had cleared.
  // Fade width and gap preservation pull against each other here, and the gap wins.
  const radiusM: any = max(u.groundPatchShrinkM.mul(GROUND_PATCH_RADIUS_FACTOR), float(1))
  // Where the wanted edge falls inside the disc, and the disc's own response there.
  // For a disc across a straight edge the covered fraction is
  // `1 - (acos(u) - u*sqrt(1-u^2)) / PI` with slope `2*sqrt(1-u^2)/PI`, so both the
  // threshold and the metres-to-fraction conversion follow from the ratio. With the
  // radius fixed at 1.5x the shrink the ratio is always 2/3, so these evaluate to the
  // 0.8904 and 0.4744 they used to be hard-coded as — kept derived because it states
  // where those numbers come from, and holds if the factor is ever retuned.
  const ratio: any = clamp(u.groundPatchShrinkM.div(radiusM), 0, 0.999)
  const root: any = sqrt(float(1).sub(ratio.mul(ratio)))
  const threshold: any = float(1).sub(acos(ratio).sub(ratio.mul(root)).div(Math.PI))
  const slope: any = root.mul(2 / Math.PI)

  // 13 taps only quantise coverage into thirteenths, which would show as bands
  // stepping inward from the edge. Rotating and rescaling the disc per fragment
  // scatters those steps into fine noise instead, which reads as a smooth ramp — far
  // cheaper than the tap count it would otherwise take, since it adds arithmetic
  // rather than texture reads.
  const radiusCells: any = radiusM.div(u.groundPatchCellSizeM)
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
  const feathered: any = sum.div(float(GROUND_PATCH_TAPS.length))

  // Fade width in metres converted into threshold units, so it stays the width it says
  // rather than scaling with the shrink. Capped at 1 - threshold: a wider ramp could not
  // reach full coverage and would leave the interior half transparent. In metres that
  // ceiling is 0.69x the shrink distance, so a wide fade needs a large shrink to sit in
  // — which is the honest limit of averaging a disc, not a tuning choice.
  const halfWidth: any = min(
    u.groundPatchFadeM.mul(slope).div(radiusM.mul(2)),
    float(1).sub(threshold),
  )
  const coverage: any = smoothstep(threshold.sub(halfWidth), min(threshold.add(halfWidth), float(1)), feathered)
    .mul(u.groundPatchAmount)
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
const effects = { groundFog: true, groundPatch: true, cloudShadows: true }
export type CloudEffect = keyof typeof effects

/**
 * Flip an effect. Returns true when the value actually changed, so callers know
 * whether they need to pay for a material rebuild.
 */
export function setCloudEffectEnabled(effect: CloudEffect, enabled: boolean): boolean {
  if (effects[effect] === enabled) return false
  effects[effect] = enabled
  return true
}

export function isCloudEffectEnabled(effect: CloudEffect): boolean {
  return effects[effect]
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

/** Apply the current precision mode to one already-built material. */
export function applyMatrixPrecision(material: any): void {
  if (!material) return
  const next = highPrecisionMatrices ? HIGH_PRECISION_CONTEXT : null
  if (material.contextNode === next) return
  material.contextNode = next
  material.needsUpdate = true
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
export function createCloudMaterial(u: CloudUniforms, colorItemSize = 3): PointsNodeMaterial {
  const material = new PointsNodeMaterial()
  if (highPrecisionMatrices) material.contextNode = HIGH_PRECISION_CONTEXT
  material.transparent = false
  material.depthWrite = true
  material.sizeAttenuation = false
  material.sizeNode = u.pointSize
  // Drives positionLocal, so positionWorld below stays the point centre rather
  // than a quad corner — the mask, cloud shadow and height grading keep working.
  material.positionNode = attribute(POINT_POSITION_ATTRIBUTE, 'vec3')

  const pointColor = colorItemSize === 4
    ? (attribute(POINT_COLOR_ATTRIBUTE, 'vec4') as any).xyz
    : (attribute(POINT_COLOR_ATTRIBUTE, 'vec3') as any)

  const buildColorNode = () => Fn(() => {
    // Round dots instead of squares. The mask discard below already costs this
    // material its early-z, so the extra rejection is effectively free.
    If(uv().sub(vec2(0.5)).length().greaterThan(0.5), () => Discard())

    const enu = u.enuInverse.mul(vec4(positionWorld, 1)).xyz
    const distance = length(enu.xy.sub(u.maskCenter))

    // Fringe rather than a clean circular cut: across the band each point holds a
    // stable pseudo-random keep-threshold, so points thin out gradually and the
    // edge reads as scattered stragglers instead of a scissor line. The seed comes
    // from the ENU position so a point dissolves identically every frame and
    // across tile reloads; metre-scale coordinates are scaled up because hash()
    // truncates its seed to uint. A floor on the width keeps the smoothstep edges
    // from collapsing onto each other at fringe 0.
    const fringeInner = u.maskRadius.mul(float(1).sub(max(u.maskFringe, float(0.001))))
    const keepChance = smoothstep(u.maskRadius, fringeInner, distance).pow(u.maskFringeCurve)
    // Wrapped into a small range on purpose: hash() truncates its seed to uint,
    // and raw ENU metres reach ~1e8 after scaling, where float32 quantises to
    // steps far larger than a point spacing — neighbours would collide and whole
    // blocks would pop instead of individual points.
    const dissolveSeed = hash(abs(enu.x.mul(131).add(enu.y.mul(1367))).mod(1_048_576))
    If(u.maskMode.greaterThan(1.5).and(u.vignetteStrength.greaterThan(0.95))
      .and(dissolveSeed.greaterThan(keepChance)), () => Discard())

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
    return applyMaskSurround(u, atmospheric, 0.30)
  })()
  material.colorNode = buildColorNode()
  // Recorded so an effect toggle can rebuild this graph later without the caller
  // having to remember the tile's colour item size.
  material.userData.rebuildColorNode = () => { material.colorNode = buildColorNode() }

  return material
}
