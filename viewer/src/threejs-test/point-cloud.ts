// Point-cloud material for the streamed tiles. The geometry itself stays
// tile-owned so Three can release CPU and GPU resources as the camera moves.
// Points are drawn as instanced round sprites — see createCloudMaterial for why.
import * as THREE from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import {
  Fn, If, Discard, uniform, attribute, positionWorld, texture3D, uv,
  vec2, vec3, vec4, float, mix, smoothstep, length, max,
  context, highpModelViewMatrix, positionView, varying,
} from 'three/tsl'
import { EXPERIENCE_CONFIG } from './config'

export interface CloudUniforms {
  maskCenter: any
  maskRadius: any
  /** 0 = off, 2 = viewport vignette. */
  maskMode: any
  vignetteStrength: any
  pointSize: any
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
  cloudDeckHeight: any
  /** Golden-hour warm rim graded by canopy height (points have no normals). */
  goldenFactor: any
  warmRimColor: any
  canopyBaseZ: any
  /** View-space depth beyond which points are discarded (metres); matches the
   * tile cutoff so ancestors do not leak points past the fog. */
  cutoffDistance: any
  /** Point size starts shrinking here and reaches zero at cutoffDistance. */
  fadeDistance: any
  canopyTopZ: any
}

let cloudShadowTextureNode: any = null

/** Register the shared cloud-density volume BEFORE the first tile material is
 * created; the same texture drives the volumetric clouds overhead. */
export function setCloudShadowTexture(texture: THREE.Data3DTexture): void {
  cloudShadowTextureNode = texture3D(texture, null, 0)
}

export function createUniforms(maskMode = 2): CloudUniforms {
  return {
    maskCenter: uniform(new THREE.Vector2(0, 0)),
    maskRadius: uniform(120),
    maskMode: uniform(maskMode),
    vignetteStrength: uniform(0),
    pointSize: uniform(2),
    enuInverse: uniform(new THREE.Matrix4()),
    daylightColor: uniform(new THREE.Color(0xffffff)),
    daylightIntensity: uniform(1),
    sunDirectionEnu: uniform(new THREE.Vector3(0, 0, 1)),
    cloudShadowOffset: uniform(new THREE.Vector2(0, 0)),
    cloudShadowStrength: uniform(0),
    cloudShadowScale: uniform(1 / EXPERIENCE_CONFIG.pointLighting.cloudShadowScaleM),
    cloudDeckHeight: uniform(EXPERIENCE_CONFIG.pointLighting.cloudDeckHeightM),
    goldenFactor: uniform(0),
    warmRimColor: uniform(new THREE.Color(EXPERIENCE_CONFIG.pointLighting.warmRim)),
    canopyBaseZ: uniform(0),
    canopyTopZ: uniform(140),
    cutoffDistance: uniform(1e9),
    fadeDistance: uniform(1e9),
  }
}

/** Brightness outside the vignette core, evaluated in the survey's ENU frame. */
export function maskDimNode(u: CloudUniforms, floor = 0): any {
  const enu = u.enuInverse.mul(vec4(positionWorld, 1)).xyz
  const distance = length(enu.xy.sub(u.maskCenter))
  const fade = smoothstep(u.maskRadius, (u.maskRadius as any).mul(0.5), distance)
  const floored = fade.mul(1 - floor).add(float(floor))
  const blended = mix(float(1), floored, u.vignetteStrength)
  return (u.maskMode.greaterThan(1.5) as any).select(blended, float(1))
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
 * The tile is drawn as instanced camera-facing sprites, not as THREE.Points:
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
  // Distance fade: sprites shrink to nothing towards the cutoff instead of
  // blending to a fog colour that would not match what lies behind them.
  material.sizeNode = u.pointSize.mul(smoothstep(u.cutoffDistance, u.fadeDistance, positionView.z.negate()))
  // Drives positionLocal, so positionWorld below stays the point centre rather
  // than a quad corner — the mask, cloud shadow and height grading keep working.
  material.positionNode = attribute(POINT_POSITION_ATTRIBUTE, 'vec3')

  const pointColor = colorItemSize === 4
    ? (attribute(POINT_COLOR_ATTRIBUTE, 'vec4') as any).xyz
    : (attribute(POINT_COLOR_ATTRIBUTE, 'vec3') as any)

  // Every pixel of a point has the same colour, height and shadow. Evaluate
  // these at its vertices instead of repeating the world transform, sRGB pow
  // and shadow-volume lookup for every overlapping fragment of every dot.
  const pointShading: any = varying(Fn(() => {
    const shaded = pointColor.pow(2.2).mul(u.daylightColor).mul(u.daylightIntensity).toVar()
    const maskDistance = float(0).toVar()
    // Neutral grading without a vignette needs no ECEF-to-ENU transform.
    // This branch is uniform across the draw, so every point takes the same path.
    const masked = u.maskMode.greaterThan(1.5).and(u.vignetteStrength.greaterThan(0))
    If(masked.or(u.goldenFactor.greaterThan(0)).or(u.cloudShadowStrength.greaterThan(0)), () => {
      const enu = u.enuInverse.mul(vec4(positionWorld, 1)).xyz.toVar()

      // Project each point up the sun ray onto the shared cloud deck.
      if (cloudShadowTextureNode) {
        If(u.cloudShadowStrength.greaterThan(0), () => {
          const sunZ = max(u.sunDirectionEnu.z, float(0.15))
          const toDeck = u.cloudDeckHeight.sub(enu.z).div(sunZ)
          const deckXY = enu.xy.add(u.sunDirectionEnu.xy.mul(toDeck))
          const uvw = vec3(deckXY.mul(u.cloudShadowScale).add(u.cloudShadowOffset), float(0.5))
          const shadowDensity = smoothstep(0.32, 0.62, cloudShadowTextureNode.sample(uvw).r)
          shaded.mulAssign(float(1).sub(shadowDensity.mul(u.cloudShadowStrength)))
        })
      }

      // Golden-hour warmth climbs the canopy: higher points catch the low sun.
      If(u.goldenFactor.greaterThan(0), () => {
        const height01 = smoothstep(u.canopyBaseZ, u.canopyTopZ, enu.z)
        shaded.mulAssign(mix(vec3(1), vec3(u.warmRimColor), height01.mul(u.goldenFactor) as any))
      })
      If(masked, () => {
        maskDistance.assign(length(enu.xy.sub(u.maskCenter)))
        const fade = smoothstep(u.maskRadius, u.maskRadius.mul(0.5), maskDistance)
        shaded.mulAssign(mix(float(1), fade.mul(0.7).add(0.3), u.vignetteStrength))
      })
    })
    return vec4(shaded, maskDistance)
  })())

  material.colorNode = Fn(() => {
    If(uv().sub(vec2(0.5)).dot(uv().sub(vec2(0.5))).greaterThan(0.25), () => Discard())
    If(positionView.z.negate().greaterThan(u.cutoffDistance), () => Discard())
    If(u.maskMode.greaterThan(1.5).and(u.vignetteStrength.greaterThan(0.95))
      .and(pointShading.w.greaterThan(u.maskRadius)), () => Discard())
    return pointShading.xyz
  })()

  return material
}
