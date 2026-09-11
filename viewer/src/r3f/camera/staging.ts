// Where the camera parks under the loader (so the tiles the entrance needs
// are resident) and the framing maths the story rig shares with it. Port of
// donationFrameDistance / donationFlightOffset / the staging block in main.ts.
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { sceneState } from '../state/scene-store'
import { enuToWorld, geo, updateOrigin } from '../state/survey-frames'

const _target = new THREE.Vector3()
const _position = new THREE.Vector3()
const _world = new THREE.Vector3()
const _lookWorld = new THREE.Vector3()

/** Distance at which the active parcel style fills `frameFillFraction` of
 * the view; the survey-scale fallback when there is no parcel. */
export function frameDistanceM(camera: THREE.PerspectiveCamera): number {
  const donation = sceneState().donation
  const config = EXPERIENCE_CONFIG.donationShape
  if (!donation) return Math.hypot(...EXPERIENCE_CONFIG.flight.destinationOffsetM)
  const extent = donation.frameExtent()
  const halfVertical = THREE.MathUtils.degToRad(camera.fov) * 0.5
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * camera.aspect)
  const fill = Math.max(0.1, Math.min(1, config.frameFillFraction))
  return Math.max(
    config.minApproachDistanceM,
    (extent.heightM * 0.5) / Math.tan(halfVertical * fill),
    extent.radiusM / Math.tan(halfHorizontal * fill),
  )
}

/** Parcel ground centroid in ENU, or the survey centre. */
export function anchorEnu(target = new THREE.Vector3()): THREE.Vector3 {
  const scene = sceneState()
  const donation = scene.datasets[scene.activeDatasetId]?.definition.hasDonationShape ? scene.donation : null
  if (donation) return donation.groundCentreEnu(target)
  return target.copy(geo.cloudCenterEnu)
}

/** Height of the parcel volume in the active style (0 without a parcel). */
export function parcelHeightM(): number {
  const scene = sceneState()
  return scene.datasets[scene.activeDatasetId]?.definition.hasDonationShape
    ? scene.donation?.frameExtent().heightM ?? 0
    : 0
}

/** Orbit range that keeps the camera above the navigation floor at the
 * orbit pitch — instead of steepening the pitch. */
export function orbitRangeM(camera: THREE.PerspectiveCamera): number {
  const story = EXPERIENCE_CONFIG.story
  const base = story.orbit.range * frameDistanceM(camera)
  anchorEnu(_target)
  const floorRise = geo.navigationFloorZ - _target.z + story.orbit.floorMarginM
  const sinEl = Math.sin(THREE.MathUtils.degToRad(story.orbit.elevationDeg))
  return Math.max(base, floorRise > 0 ? floorRise / sinEl : 0)
}

/** Park the camera at the orbit pose. Called under the loader so the
 * destination's tiles stream while nothing is visible, and again when the
 * parcel arrives and the pose moves. */
export function stageCamera(camera: THREE.PerspectiveCamera): void {
  if (!geo.ready) return
  const story = EXPERIENCE_CONFIG.story
  anchorEnu(_target)
  const range = orbitRangeM(camera)
  const el = THREE.MathUtils.degToRad(story.orbit.elevationDeg)
  const az = 0
  const horizontal = Math.cos(el) * range
  _position.set(
    _target.x + Math.sin(az) * horizontal,
    _target.y - Math.cos(az) * horizontal,
    _target.z + Math.sin(el) * range,
  )
  camera.position.copy(enuToWorld(_position, _world))
  camera.up.copy(geo.enuUp)
  _target.z += story.orbit.lookHeightFraction * parcelHeightM()
  camera.lookAt(enuToWorld(_target, _lookWorld))
  camera.updateMatrixWorld()
  updateOrigin(camera, true)
}
