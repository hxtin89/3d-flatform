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

export interface SurveyFrame {
  enuFrame: THREE.Matrix4
  enuInverse: THREE.Matrix4
  enuUp: THREE.Vector3
  cloudCenterEnu: THREE.Vector3
  zOffset: number
  areaMinZ: number
  navigationClearance: number
  navigationFloorZ: number
  navigationBoundsRadius: number
  canopyHeightM: number
}

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

/** Build immutable local placement/navigation data for one survey. */
export function createSurveyFrame(manifest: GlobeManifest): SurveyFrame {
  const enuFrame = new THREE.Matrix4().fromArray(manifest.rootTransform)
  const enuInverse = enuFrame.clone().invert()
  const enuUp = new THREE.Vector3().setFromMatrixColumn(enuFrame, 2).normalize()
  let zOffset = 0
  let areaMinZ = 0
  let navigationClearance = EXPERIENCE_CONFIG.navigation.zoomStopHeightM as number
  let navigationFloorZ = navigationClearance
  let canopyHeightM = EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM as number

  if (manifest.areaBbox) {
    const [, , minZ] = manifest.areaBbox
    // Imagery is draped on the bare ellipsoid, so ground level is ellipsoidal
    // height 0; the ENU origin itself sits enuOriginLonLat[2] above that.
    const originHeight = manifest.enuOriginLonLat?.[2] ?? 0
    zOffset = APP_PARAMS.groundSnap
      ? -(minZ + originHeight) + EXPERIENCE_CONFIG.navigation.pointCloudLiftM
      : 0
    areaMinZ = minZ
    const configuredStop = EXPERIENCE_CONFIG.navigation.zoomStopHeightM
    const canopyHeight = manifest.areaVerticalSpan ?? EXPERIENCE_CONFIG.navigation.fallbackCloudHeightM
    canopyHeightM = canopyHeight
    navigationClearance = Math.max(configuredStop, canopyHeight)
    navigationFloorZ = minZ + navigationClearance
  }

  const surveyBbox = manifest.surveyBbox ?? manifest.areaBbox
  const cloudCenterEnu = new THREE.Vector3()
  let navigationBoundsRadius = 2500
  if (surveyBbox) {
    const [minX, minY, , maxX, maxY] = surveyBbox
    cloudCenterEnu.set((minX + maxX) / 2, (minY + maxY) / 2, areaMinZ + 40)
    navigationBoundsRadius = Math.max(
      EXPERIENCE_CONFIG.navigation.minimumBoundsRadiusM,
      Math.hypot(maxX - minX, maxY - minY) * EXPERIENCE_CONFIG.navigation.surveyBoundsScale,
    )
  }
  return {
    enuFrame, enuInverse, enuUp, cloudCenterEnu, zOffset, areaMinZ,
    navigationClearance, navigationFloorZ, navigationBoundsRadius, canopyHeightM,
  }
}

/** Activate one survey's frame and move the floating origin to its centre. */
export function activateSurveyFrame(site: SurveyFrame): void {
  const { uniforms } = frame
  geo.enuFrame.copy(site.enuFrame)
  geo.enuInverse.copy(site.enuInverse)
  geo.enuUp.copy(site.enuUp)
  geo.cloudCenterEnu.copy(site.cloudCenterEnu)
  geo.zOffset = site.zOffset
  geo.areaMinZ = site.areaMinZ
  geo.navigationClearance = site.navigationClearance
  geo.navigationFloorZ = site.navigationFloorZ
  geo.navigationBoundsRadius = site.navigationBoundsRadius
  geo.canopyHeightM = site.canopyHeightM
  uniforms.enuInverse.value.copy(geo.enuInverse)
  uniforms.canopyBaseZ.value = geo.areaMinZ + geo.zOffset + 8
  uniforms.canopyTopZ.value = geo.areaMinZ + geo.zOffset + geo.canopyHeightM
  uniforms.cloudDeckHeight.value = geo.areaMinZ + geo.zOffset + EXPERIENCE_CONFIG.pointLighting.cloudDeckHeightM
  if (geo.navigationClearance > EXPERIENCE_CONFIG.navigation.zoomStopHeightM) {
    console.info(`[navigation] zoom stop raised to ${Math.round(geo.navigationClearance)} m for the active site.`)
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

/** Backwards-compatible single-site helper. */
export function initSurveyFrames(manifest: GlobeManifest): SurveyFrame {
  const frame = createSurveyFrame(manifest)
  activateSurveyFrame(frame)
  return frame
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
