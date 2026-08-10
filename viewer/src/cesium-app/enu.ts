// ENU ↔ ECEF frame of the survey, built from the manifest rootTransform
// (column-major 16, the same matrix the three.js app feeds THREE.Matrix4).
// All product tuning (config.ts) is expressed in local ENU metres; this module
// is the single place that converts between that frame and Cesium world space.
import * as Cesium from 'cesium'

export interface EnuFrame {
  /** ENU → ECEF */
  matrix: Cesium.Matrix4
  /** ECEF → ENU */
  inverse: Cesium.Matrix4
  /** Unit up axis of the ENU frame, in ECEF. */
  up: Cesium.Cartesian3
  enuToWorld(enu: Cesium.Cartesian3, result?: Cesium.Cartesian3): Cesium.Cartesian3
  worldToEnu(world: Cesium.Cartesian3, result?: Cesium.Cartesian3): Cesium.Cartesian3
  /** Direction transforms (no translation). */
  enuDirectionToWorld(direction: Cesium.Cartesian3, result?: Cesium.Cartesian3): Cesium.Cartesian3
}

export function createEnuFrame(rootTransform: number[]): EnuFrame {
  // Cesium.Matrix4.fromArray also reads column-major — same convention as three.
  const matrix = Cesium.Matrix4.fromColumnMajorArray(rootTransform)
  const inverse = Cesium.Matrix4.inverse(matrix, new Cesium.Matrix4())
  const up = Cesium.Matrix4.getColumn(matrix, 2, new Cesium.Cartesian4())
  const upCartesian = Cesium.Cartesian3.normalize(
    new Cesium.Cartesian3(up.x, up.y, up.z),
    new Cesium.Cartesian3(),
  )
  return {
    matrix,
    inverse,
    up: upCartesian,
    enuToWorld(enu, result = new Cesium.Cartesian3()) {
      return Cesium.Matrix4.multiplyByPoint(matrix, enu, result)
    },
    worldToEnu(world, result = new Cesium.Cartesian3()) {
      return Cesium.Matrix4.multiplyByPoint(inverse, world, result)
    },
    enuDirectionToWorld(direction, result = new Cesium.Cartesian3()) {
      return Cesium.Matrix4.multiplyByPointAsVector(matrix, direction, result)
    },
  }
}
