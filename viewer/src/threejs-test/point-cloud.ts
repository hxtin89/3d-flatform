// Point-cloud material shared by every streamed tile. The geometry itself stays
// tile-owned so Three can release CPU and GPU resources as the camera moves.
import * as THREE from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import {
  Fn, If, Discard, uniform, attribute, positionWorld,
  vec4, float, mix, smoothstep, length,
} from 'three/tsl'

export interface CloudUniforms {
  maskCenter: any
  maskRadius: any
  /** 0 = off, 1 = world circle, 2 = viewport vignette. */
  maskMode: any
  vignetteStrength: any
  pointSize: any
  /** world/ECEF to local ENU. */
  enuInverse: any
}

export function createUniforms(): CloudUniforms {
  return {
    maskCenter: uniform(new THREE.Vector2(0, 0)),
    maskRadius: uniform(120),
    maskMode: uniform(2),
    vignetteStrength: uniform(0),
    pointSize: uniform(2),
    enuInverse: uniform(new THREE.Matrix4()),
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

    If(u.maskMode.greaterThan(0.5).and(u.maskMode.lessThan(1.5))
      .and(distance.greaterThan(u.maskRadius)), () => Discard())
    If(u.maskMode.greaterThan(1.5).and(u.vignetteStrength.greaterThan(0.95))
      .and(distance.greaterThan(u.maskRadius)), () => Discard())

    // PNTS RGB is sRGB encoded. TSL expects a linear working colour.
    return (attribute('color', 'vec3') as any).pow(2.2).mul(maskDimNode(u, 0.25))
  })()

  return material
}
