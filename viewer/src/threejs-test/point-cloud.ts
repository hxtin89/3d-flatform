// Point-cloud material shared by every streamed tile. The geometry itself stays
// tile-owned so Three can release CPU and GPU resources as the camera moves.
import * as THREE from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import {
  Fn, If, Discard, uniform, attribute, positionWorld, texture3D,
  vec3, vec4, float, mix, smoothstep, length, max,
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
  canopyTopZ: any
}

let cloudShadowTextureNode: any = null

/** Register the shared cloud-density volume BEFORE the first tile material is
 * created; the same texture drives the volumetric clouds overhead. */
export function setCloudShadowTexture(texture: THREE.Data3DTexture): void {
  cloudShadowTextureNode = texture3D(texture, null, 0)
}

export function createUniforms(): CloudUniforms {
  return {
    maskCenter: uniform(new THREE.Vector2(0, 0)),
    maskRadius: uniform(120),
    maskMode: uniform(2),
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

/** Create a material for exactly one streamed tile. Never share it across tiles:
 * UnloadTilesPlugin disposes hidden tile materials independently. */
export function createCloudMaterial(u: CloudUniforms): PointsNodeMaterial {
  const material = new PointsNodeMaterial()
  material.transparent = false
  material.depthWrite = true
  material.sizeAttenuation = false
  material.sizeNode = u.pointSize

  material.colorNode = Fn(() => {
    const enu = u.enuInverse.mul(vec4(positionWorld, 1)).xyz
    const distance = length(enu.xy.sub(u.maskCenter))

    If(u.maskMode.greaterThan(1.5).and(u.vignetteStrength.greaterThan(0.95))
      .and(distance.greaterThan(u.maskRadius)), () => Discard())

    // Directional cues without normals: project each point up the sun ray onto
    // a virtual cloud deck and shade it by the drifting cloud density there.
    const cloudShadow = float(1).toVar()
    if (cloudShadowTextureNode) {
      const sunZ = max(u.sunDirectionEnu.z, float(0.15))
      const toDeck = u.cloudDeckHeight.sub(enu.z).div(sunZ)
      const deckXY = enu.xy.add(u.sunDirectionEnu.xy.mul(toDeck))
      const uvw = vec3(deckXY.mul(u.cloudShadowScale).add(u.cloudShadowOffset), float(0.5))
      const shadowDensity = smoothstep(0.32, 0.62, cloudShadowTextureNode.sample(uvw).r)
      cloudShadow.assign(float(1).sub(shadowDensity.mul(u.cloudShadowStrength)))
    }

    // Golden-hour warmth climbs the canopy: higher points catch the low sun.
    const height01 = smoothstep(u.canopyBaseZ, u.canopyTopZ, enu.z)
    const rim = mix(vec3(1), vec3(u.warmRimColor), height01.mul(u.goldenFactor) as any)

    // PNTS RGB is sRGB encoded. TSL expects a linear working colour.
    return (attribute('color', 'vec3') as any)
      .pow(2.2)
      .mul(u.daylightColor)
      .mul(u.daylightIntensity)
      .mul(cloudShadow)
      .mul(rim)
      .mul(maskDimNode(u, 0.30))
  })()

  return material
}
