// Point-cloud material for the streamed tiles. The geometry itself stays
// tile-owned so Three can release CPU and GPU resources as the camera moves.
// Points are drawn as instanced quads — see createCloudMaterial for why.
import * as THREE from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import {
  Fn, If, Discard, uniform, attribute, positionWorld, texture, texture3D, uv,
  vec2, vec3, vec4, float, mix, smoothstep, length, max, abs, exp, hash,
  cameraPosition, context, highpModelViewMatrix,
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
  /** ENU rectangle the coverage mask spans — used to map position into mask UV. */
  groundPatchCenter: any
  groundPatchHalfExtent: any
  /** Threshold on the blurred mask. Raising it erodes the patch inward, which is
   * how the flat colour is kept from spilling past the point data. */
  groundPatchShrink: any
  /** Width of the threshold ramp — the soft edge. */
  groundPatchSoftness: any
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

/** Register the ground-patch coverage mask BEFORE the first basemap material is
 * created. The texture is refilled in place once the point tileset loads, so the
 * same object stays bound — see ground-patch-mask.ts. */
export function setGroundPatchMask(mask: THREE.Texture): void {
  groundPatchMaskNode = texture(mask)
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
    groundPatchCenter: uniform(new THREE.Vector2(0, 0)),
    groundPatchHalfExtent: uniform(new THREE.Vector2(1, 1)),
    groundPatchShrink: uniform(EXPERIENCE_CONFIG.design.groundPatch.shrink),
    groundPatchSoftness: uniform(EXPERIENCE_CONFIG.design.groundPatch.softness),
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
export function groundFogNode(u: CloudUniforms): { amount: any; color: any } {
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
 * Replace the basemap with a flat colour where the point cloud has data, so the
 * satellite imagery only shows where it does not.
 *
 * Applied to the imagery material only — the point cloud must keep drawing on
 * top. And it replaces rather than discards: the draped imagery is the only
 * surface the globe has there, so cutting it would leave a hole with the sky
 * behind it.
 *
 * The shape comes from a coverage mask rather than a rectangle. The survey bbox
 * looked like a reasonable stand-in and is not: this dataset spans 12.8 x 8.5 km
 * but fills it with 27 irregular cells, so a rectangle paints solid colour across
 * large empty areas. See ground-patch-mask.ts for how the mask is rasterised.
 *
 * `shrink` thresholds the blurred mask, which erodes the shape inward. That is
 * the safe direction: a patch pulled slightly inside the data leaves a little
 * basemap visible at the edge, while one that spills past it reads as a wedge of
 * flat colour sitting on the map.
 */
export function applyGroundPatch(u: CloudUniforms, color: any): any {
  // No mask registered (or no point tileset yet) means nothing to replace.
  if (!groundPatchMaskNode) return color
  // Annotated `any` like the rest of this file's node plumbing: the uniforms are
  // untyped, so TSL's overloads would otherwise collapse this vec2 work to float.
  const enu: any = u.enuInverse.mul(vec4(positionWorld, 1)).xyz
  const maskUv: any = enu.xy.sub(u.groundPatchCenter)
    .div((u.groundPatchHalfExtent as any).mul(2)).add(vec2(0.5))
  const sample: any = groundPatchMaskNode.sample(maskUv).r
  const shrink: any = u.groundPatchShrink
  const coverage: any = smoothstep(shrink, shrink.add(max(u.groundPatchSoftness, float(0.001))), sample)
    .mul(u.groundPatchAmount)
  return mix(color, vec3(u.groundPatchColor), coverage)
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

  material.colorNode = Fn(() => {
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
    if (cloudShadowTextureNode) {
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
    return applyMaskSurround(u, mix(graded, fog.color, fog.amount), 0.30)
  })()

  return material
}
