// Jittered variant of three's addons/tsl/utils/Raymarching.js. The ray start is
// offset by a per-pixel fraction of one step so slice banding dissolves into
// fine noise instead of visible shells; the callback also receives the step
// delta for extinction integration.
import {
  varying, vec4, modelWorldMatrixInverse, cameraPosition, positionGeometry,
  float, Fn, Loop, max, min, vec2, vec3,
} from 'three/tsl'

const hitBox = /*@__PURE__*/ Fn(({ orig, dir }: any) => {
  const boxMin = vec3(-0.5)
  const boxMax = vec3(0.5)
  const invDir = dir.reciprocal()
  const tminTmp = boxMin.sub(orig).mul(invDir)
  const tmaxTmp = boxMax.sub(orig).mul(invDir)
  const tmin = min(tminTmp, tmaxTmp)
  const tmax = max(tminTmp, tmaxTmp)
  const t0 = max(tmin.x, max(tmin.y, tmin.z))
  const t1 = min(tmax.x, min(tmax.y, tmax.z))
  return vec2(t0, t1)
})

export function JitteredRaymarchingBox(
  steps: number,
  jitter: any,
  callback: (args: { positionRay: any; delta: any }) => void,
): void {
  const vOrigin = varying(vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0))))
  const vDirection = varying(positionGeometry.sub(vOrigin))

  const rayDir = vDirection.normalize()
  const bounds = vec2((hitBox as any)({ orig: vOrigin, dir: rayDir })).toVar()

  bounds.x.greaterThan(bounds.y).discard()
  bounds.assign(vec2(max(bounds.x, 0.0), bounds.y))

  const inc = vec3(rayDir.abs().reciprocal()).toVar()
  const delta = float(min(inc.x, min(inc.y, inc.z))).toVar()
  delta.divAssign(float(steps))

  const positionRay = vec3(vOrigin.add(bounds.x.mul(rayDir))).toVar()
  positionRay.addAssign(rayDir.mul(delta.mul(jitter)))

  Loop({ type: 'float', start: bounds.x, end: bounds.y, update: delta }, () => {
    callback({ positionRay, delta })
    positionRay.addAssign(rayDir.mul(delta))
  })
}
