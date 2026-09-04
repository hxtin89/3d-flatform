// Screen-centre ground hit → camera ranges, vignette mask (MASK phase).
// Port of updateMaskFollow in main.ts with frame-rate independent smoothing.
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { PHASE } from '../frame-phases'
import { frame, smooth01, smoothingAlpha } from '../state/frame'
import { enuToWorld, geo, worldToEnu } from '../state/survey-frames'
import { domTargets } from '../dom-targets'

const ray = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const hitRender = new THREE.Vector3()
const hitEnu = new THREE.Vector3()
const hit2d = new THREE.Vector2()
const cloudRangeEnu = new THREE.Vector3()
const maskSphereEnu = new THREE.Vector3()
const FOLLOW_TAU_MS = 75
let lastNow = 0
let lastVignette = -1

function writeVignette(opacity: number): void {
  if (Math.abs(opacity - lastVignette) < 0.005) return
  lastVignette = opacity
  if (domTargets.vignette) domTargets.vignette.style.opacity = String(opacity)
}

export function MaskFollow() {
  const camera = useThree((s) => s.camera)

  useFrame(() => {
    const { uniforms } = frame
    const dt = lastNow ? Math.min(100, frame.now - lastNow) : 16
    lastNow = frame.now
    const mode = uniforms.maskMode.value
    ndc.set(0, 0)
    ray.setFromCamera(ndc, camera)

    let missedGround = false
    if (geo.ready && ray.ray.intersectPlane(geo.groundPlane, hitRender)) {
      frame.cameraGroundRange = camera.position.distanceTo(hitRender)
      hitEnu.copy(hitRender).applyMatrix4(geo.enuInverseRender)
      hit2d.set(hitEnu.x, hitEnu.y)
      if (!frame.followInit) { frame.followEnu.copy(hit2d); frame.followInit = true }
      else frame.followEnu.lerp(hit2d, smoothingAlpha(dt, FOLLOW_TAU_MS))
      uniforms.maskCenter.value.copy(frame.followEnu)
    } else {
      frame.cameraGroundRange = camera.position.distanceTo(geo.cloudCenterRender)
      missedGround = true
    }

    if (geo.ready) {
      worldToEnu(camera.position, cloudRangeEnu)
      const altitude = Math.max(0, cloudRangeEnu.z - geo.areaMinZ)
      const outside = Math.max(
        0,
        Math.hypot(cloudRangeEnu.x - geo.cloudCenterEnu.x, cloudRangeEnu.y - geo.cloudCenterEnu.y)
          - geo.navigationBoundsRadius,
      )
      frame.cameraCloudRange = Math.hypot(altitude, outside)
      frame.cameraAltitude = altitude
      const debug = frame.rangeDebug ?? (frame.rangeDebug = { altitude: 0, outside: 0, range: 0, groundRange: 0 })
      debug.altitude = altitude
      debug.outside = outside
      debug.range = frame.cameraCloudRange
      debug.groundRange = frame.cameraGroundRange
    } else {
      frame.cameraCloudRange = frame.cameraGroundRange
    }

    if (missedGround && !frame.followInit) { frame.maskWorldActive = false; return }
    if (mode === 0) {
      frame.maskWorldActive = false
      writeVignette(0)
      return
    }

    const radius = THREE.MathUtils.clamp(frame.cameraGroundRange * 0.55, 30, 2000)
    const strength = 1 - smooth01(4, 20, frame.cameraGroundRange / radius)
    const flightBlend = smooth01(0.68, 1, frame.cinematicFlightProgress)
    const visibleStrength = strength * flightBlend
    uniforms.maskRadius.value = radius
    uniforms.vignetteStrength.value = visibleStrength
    writeVignette(visibleStrength)

    frame.maskWorldRadius = radius + 80
    maskSphereEnu.set(frame.followEnu.x, frame.followEnu.y, geo.areaMinZ + 50)
    enuToWorld(maskSphereEnu, frame.maskSphereWorld)
    frame.maskWorldActive = visibleStrength > 0.9
  }, PHASE.MASK)

  return null
}
