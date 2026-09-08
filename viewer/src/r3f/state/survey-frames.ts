// The survey's ENU frame, the floating-origin bookkeeping derived from it, and
// the navigation floor rules. Port of main.ts (enuFrame … refreshOriginDerived,
// originThreshold/updateOrigin, isZoomInBlocked, enforceNavigationBounds,
// liftOrbitPivotToFloor, and the manifest part of main()).
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import type { GlobeManifest } from '../../threejs-test/manifest'
import {
  ecefToRenderMatrix, onRebase, rebaseTo, renderToEcef, renderToEcefMatrix,
} from '../../threejs-test/origin'
import { APP_PARAMS } from '../params'
import { frame } from './frame'
import { stopNavigationInertia } from '../controls/navigation-gestures'

export const geo = {
  /** ENU -> ECEF, absolute, straight from the manifest. */
  enuFrame: new THREE.Matrix4(),
  enuInverse: new THREE.Matrix4(),
  /** Same frames shifted by the floating origin — what the scene graph, the
   * camera and the shaders speak. Refreshed on every rebase. */
  enuFrameRender: new THREE.Matrix4(),
  enuInverseRender: new THREE.Matrix4(),
  enuUp: new THREE.Vector3(0, 0, 1),
  cloudCenterEnu: new THREE.Vector3(),
  cloudCenterRender: new THREE.Vector3(),
  groundPlane: new THREE.Plane(),
  groundPlanePointEnu: new THREE.Vector3(),
  groundPlanePointWorld: new THREE.Vector3(),
  zOffset: 0,
  areaMinZ: 0,
  navigationClearance: EXPERIENCE_CONFIG.navigation.zoomStopHeightM as number,
  navigationFloorZ: EXPERIENCE_CONFIG.navigation.zoomStopHeightM as number,
  navigationBoundsRadius: 2500,
  canopyHeightM: EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM as number,
  /** False until the manifest landed — a height read before that is 0, the
   * finest refinement of the whole survey. */
  ready: false,
}

const originAnchorEcef = new THREE.Vector3()

export function enuToWorld(value: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(value.x, value.y, value.z + geo.zOffset).applyMatrix4(geo.enuFrameRender)
}

export function worldToEnu(value: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
  target.copy(value).applyMatrix4(geo.enuInverseRender)
  target.z -= geo.zOffset
  return target
}

export function refreshOriginDerived(): void {
  ecefToRenderMatrix(geo.enuFrame, geo.enuFrameRender)
  renderToEcefMatrix(geo.enuInverse, geo.enuInverseRender)
  frame.uniforms.enuInverse.value.copy(geo.enuInverseRender)
  if (!geo.ready) return
  enuToWorld(geo.cloudCenterEnu, geo.cloudCenterRender)
  geo.groundPlane.setFromNormalAndCoplanarPoint(geo.enuUp, enuToWorld(geo.groundPlanePointEnu, geo.groundPlanePointWorld))
}

let rebaseSubscribed = false

/** Manifest -> frames, floor, bounds, shader heights; seeds the origin at the
 * survey centre. Idempotent enough to survive a React double mount. */
export function initSurveyFrames(manifest: GlobeManifest): void {
  const { uniforms } = frame
  geo.enuFrame.fromArray(manifest.rootTransform)
  geo.enuInverse.copy(geo.enuFrame).invert()
  uniforms.enuInverse.value.copy(geo.enuInverse)
  geo.enuUp.setFromMatrixColumn(geo.enuFrame, 2).normalize()

  if (manifest.areaBbox) {
    const [, , minZ] = manifest.areaBbox
    // Imagery is draped on the bare ellipsoid, so ground level is ellipsoidal
    // height 0; the ENU origin itself sits enuOriginLonLat[2] above that.
    const originHeight = manifest.enuOriginLonLat?.[2] ?? 0
    geo.zOffset = APP_PARAMS.groundSnap
      ? -(minZ + originHeight) + EXPERIENCE_CONFIG.navigation.pointCloudLiftM
      : 0
    geo.areaMinZ = minZ
    const configuredStop = EXPERIENCE_CONFIG.navigation.zoomStopHeightM
    const canopyHeight = manifest.areaVerticalSpan ?? EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM
    geo.canopyHeightM = canopyHeight
    geo.navigationClearance = Math.max(configuredStop, canopyHeight)
    if (geo.navigationClearance > configuredStop) {
      console.info(`[navigation] zoom stop raised from ${Math.round(configuredStop)} m to ${Math.round(geo.navigationClearance)} m — the canopy is that tall here.`)
    }
    geo.navigationFloorZ = minZ + geo.navigationClearance
    uniforms.canopyBaseZ.value = minZ + geo.zOffset + 8
    uniforms.canopyTopZ.value = minZ + geo.zOffset + canopyHeight
    uniforms.cloudDeckHeight.value = minZ + geo.zOffset + EXPERIENCE_CONFIG.pointLighting.cloudDeckHeightM
  }

  const surveyBbox = manifest.surveyBbox ?? manifest.areaBbox
  if (surveyBbox) {
    const [minX, minY, , maxX, maxY] = surveyBbox
    geo.cloudCenterEnu.set((minX + maxX) / 2, (minY + maxY) / 2, geo.areaMinZ + 40)
    geo.navigationBoundsRadius = Math.max(
      EXPERIENCE_CONFIG.navigation.minimumBoundsRadiusM,
      Math.hypot(maxX - minX, maxY - minY) * EXPERIENCE_CONFIG.navigation.surveyBoundsScale,
    )
  }
  geo.groundPlanePointEnu.set(geo.cloudCenterEnu.x, geo.cloudCenterEnu.y, geo.cloudCenterEnu.z - 40)
  geo.ready = true
  if (!rebaseSubscribed) {
    rebaseSubscribed = true
    onRebase(refreshOriginDerived)
  }
  originAnchorEcef
    .set(geo.cloudCenterEnu.x, geo.cloudCenterEnu.y, geo.cloudCenterEnu.z + geo.zOffset)
    .applyMatrix4(geo.enuFrame)
  rebaseTo(originAnchorEcef)
  refreshOriginDerived()
  uniforms.maskCenter.value.set(geo.cloudCenterEnu.x, geo.cloudCenterEnu.y)
}

/** Rebase distance scales with viewing range (pan/zoom speed do too). */
export function originThreshold(): number {
  const range = Number.isFinite(frame.cameraGroundRange)
    ? frame.cameraGroundRange
    : EXPERIENCE_CONFIG.atmosphere.fallbackRangeM
  return THREE.MathUtils.clamp(
    range * EXPERIENCE_CONFIG.navigation.originRebaseRangeFactor,
    EXPERIENCE_CONFIG.navigation.originRebaseMinM,
    EXPERIENCE_CONFIG.navigation.originRebaseMaxM,
  )
}

/** Move the origin onto the camera once it drifted past the threshold.
 * `force` covers teleports (story start, fly-to, boot staging). */
export function updateOrigin(camera: THREE.Camera, force = false): void {
  if (!geo.ready) return
  const threshold = originThreshold()
  if (!force && camera.position.lengthSq() < threshold * threshold) return
  rebaseTo(renderToEcef(camera.position, originAnchorEcef))
}

const zoomProbeEnu = new THREE.Vector3()
const zoomProbeDirection = new THREE.Vector3()

/** Camera on the floor inside the survey, not looking clearly up: keyboard
 * zoom-in would only glide forward, so it is stopped. */
export function isZoomInBlocked(camera: THREE.Camera): boolean {
  if (APP_PARAMS.freeOrbit) return false
  worldToEnu(camera.position, zoomProbeEnu)
  if (zoomProbeEnu.z > geo.navigationFloorZ + 2) return false
  const dx = zoomProbeEnu.x - geo.cloudCenterEnu.x
  const dy = zoomProbeEnu.y - geo.cloudCenterEnu.y
  if (dx * dx + dy * dy > geo.navigationBoundsRadius * geo.navigationBoundsRadius) return false
  camera.getWorldDirection(zoomProbeDirection)
  return zoomProbeDirection.dot(geo.enuUp) < 0.2
}

/** Deadband around the navigation floor: clamping on every breach fought the
 * controls' own per-frame nudges (159 resets in 10 s, each cancelling the
 * live gesture). */
const NAVIGATION_FLOOR_DEADBAND_M = 0.5
let navigationClampedFrames = 0
const navigationCameraEnu = new THREE.Vector3()
const navigationCameraWorld = new THREE.Vector3()

export function enforceNavigationBounds(camera: THREE.Camera, controls: { resetState(): void } | null): void {
  if (APP_PARAMS.freeOrbit || !geo.ready) return
  worldToEnu(camera.position, navigationCameraEnu)
  const dx = navigationCameraEnu.x - geo.cloudCenterEnu.x
  const dy = navigationCameraEnu.y - geo.cloudCenterEnu.y
  if (dx * dx + dy * dy > geo.navigationBoundsRadius * geo.navigationBoundsRadius) {
    navigationClampedFrames = 0
    return
  }
  if (navigationCameraEnu.z >= geo.navigationFloorZ - NAVIGATION_FLOOR_DEADBAND_M) {
    navigationClampedFrames = 0
    return
  }
  navigationCameraEnu.z = geo.navigationFloorZ
  camera.position.copy(enuToWorld(navigationCameraEnu, navigationCameraWorld))
  camera.updateMatrixWorld()
  // A floor graze must not discard the pointer tracker and its held pivot.
  if (++navigationClampedFrames >= 10) stopNavigationInertia(controls)
}

const orbitPivotEnu = new THREE.Vector3()

/** Screen-centre orbit pivot lifted to the navigation floor inside the
 * survey, so a mouse orbit turns at the height the camera is kept on. */
export function liftOrbitPivotToFloor(pivot: THREE.Vector3): void {
  if (APP_PARAMS.freeOrbit) return
  worldToEnu(pivot, orbitPivotEnu)
  const dx = orbitPivotEnu.x - geo.cloudCenterEnu.x
  const dy = orbitPivotEnu.y - geo.cloudCenterEnu.y
  if (dx * dx + dy * dy > geo.navigationBoundsRadius * geo.navigationBoundsRadius) return
  if (orbitPivotEnu.z >= geo.navigationFloorZ) return
  orbitPivotEnu.z = geo.navigationFloorZ
  enuToWorld(orbitPivotEnu, pivot)
}
