// The camera rig: one state machine, react-spring SpringValues on the
// parcel-relative offsets, and an analytic orbit base that turns from the
// first frame. Modes:
//   story     – descent into the endless orbit (offset springs → 0)
//   resuming  – blend back from the user's view, velocity-continuous
//   flyTo     – dolly toward an ENU point along the sight line
//   user      – GlobeControls / keyboard own the camera; springs stopped
//   idle      – before the entrance
// See config.ts `story` for the numbers and the plan for the reasoning.
import * as THREE from 'three'
import { SpringValue } from '@react-spring/three'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import type { RigMode } from '../state/ui-store'
import type { CameraRig, RigState } from './rig-types'
import { angleDelta, captureRig, elevationFloorDeg, smoothstep01, solveRig } from './rig-math'

export interface CameraRigDeps {
  camera: THREE.PerspectiveCamera
  enuUp: THREE.Vector3
  worldToEnu(value: THREE.Vector3, target?: THREE.Vector3): THREE.Vector3
  enuToWorld(value: THREE.Vector3, target?: THREE.Vector3): THREE.Vector3
  /** Parcel ground centroid (or survey centre) in ENU. */
  anchor(target: THREE.Vector3): THREE.Vector3
  /** Metres at which the parcel fills the frame. */
  frameDistanceM(): number
  /** Orbit range after the floor rule. */
  orbitRangeM(): number
  parcelHeightM(): number
  floorZ(): number
  /** Ellipsoid-normal up at a world position (controls), else enuUp. */
  upAt(positionWorld: THREE.Vector3, target: THREE.Vector3): THREE.Vector3
  /** Controls state: true while a gesture or its inertia is running. */
  controlsBusy(): boolean
  onCameraJump(): void
  onModeChange(mode: RigMode): void
  /** Descent progress 0 (start) … 1 (orbit reached), arrival ms or null. */
  onStoryProgress(progress: number, arrivalMs: number | null): void
}

type SpringConfig = { mass: number; tension: number; friction: number; velocity?: number }

const _anchor = new THREE.Vector3()
const _position = new THREE.Vector3()
const _look = new THREE.Vector3()
const _world = new THREE.Vector3()
const _lookWorld = new THREE.Vector3()
const _up = new THREE.Vector3()
const _cameraEnu = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _dir = new THREE.Vector3()

export function createCameraRig(deps: CameraRigDeps): CameraRig & { update(nowMs: number): void; dispose(): void } {
  const story = EXPERIENCE_CONFIG.story
  const { camera } = deps
  let mode: RigMode = 'idle'
  let lastNow = 0
  let t = 0
  let arrivedAt = -1
  let orbitAz = 0
  let lnOrbit = 0
  let lnStart = 0
  let resumePendingConfig: SpringConfig | null = null

  const az = new SpringValue(0)
  const el = new SpringValue(0)
  const lr = new SpringValue(0)
  const look = new SpringValue(0)
  const lookBlend = new SpringValue(1)
  const dolly = new SpringValue(0)
  const springs = [az, el, lr, look, lookBlend, dolly]

  const state: RigState = { azimuthDeg: 0, elevationDeg: 30, logRange: 0, lookHeightM: 0 }
  // Capture ring for the resume velocity (user mode), two slots.
  const ringA: RigState = { ...state }
  const ringB: RigState = { ...state }
  let ringDt = 16
  let ringValid = 0
  const lookPoint0 = new THREE.Vector3()
  const dollyStart = new THREE.Vector3()
  const dollyEnd = new THREE.Vector3()
  const dollyQuat = new THREE.Quaternion()

  const setMode = (next: RigMode) => {
    if (mode === next) return
    mode = next
    deps.onModeChange(next)
  }

  const stopSprings = () => { for (const s of springs) s.stop() }

  const applyState = (lookBlendValue: number) => {
    deps.anchor(_anchor)
    solveRig(state, _anchor, _position, _look)
    deps.enuToWorld(_position, _world)
    deps.enuToWorld(_look, _lookWorld)
    if (lookBlendValue < 1) {
      deps.enuToWorld(lookPoint0, _forward)
      _lookWorld.lerpVectors(_forward, _lookWorld, smoothstep01(lookBlendValue))
    }
    camera.position.copy(_world)
    camera.up.copy(deps.upAt(_world, _up))
    camera.lookAt(_lookWorld)
    camera.updateMatrixWorld()
  }

  const currentLookPoint = (target: THREE.Vector3) => {
    // The point the user is looking at: along the forward ray, at the rig's
    // range — a plain lookAt(anchor) at resume would snap the orientation.
    deps.worldToEnu(camera.position, _cameraEnu)
    camera.getWorldDirection(_dir)
    deps.enuToWorld(_cameraEnu, _world)
    _world.addScaledVector(_dir, Math.exp(state.logRange))
    return deps.worldToEnu(_world, target)
  }

  const beginStory = () => {
    deps.anchor(_anchor)
    const orbitRange = deps.orbitRangeM()
    const startRange = story.start.range * deps.frameDistanceM()
    lnOrbit = Math.log(orbitRange)
    lnStart = Math.log(Math.max(orbitRange, startRange))
    orbitAz = 0
    t = 0
    arrivedAt = -1
    stopSprings()
    az.set(story.start.azimuthDeg)
    el.set(story.start.elevationDeg - story.orbit.elevationDeg)
    lr.set(lnStart - lnOrbit)
    look.set((story.start.lookHeightFraction - story.orbit.lookHeightFraction) * deps.parcelHeightM())
    lookBlend.set(1)
    const cfg = story.springs.story
    void az.start({ to: 0, config: cfg.azOffset })
    void el.start({ to: 0, config: cfg.elOffset })
    void lr.start({ to: 0, config: cfg.logRangeOffset })
    void look.start({ to: 0, config: cfg.lookOffset })
    setMode('story')
    lastNow = 0
    evaluate(0)
    applyState(1)
    deps.onCameraJump()
  }

  /** Blend from wherever the camera is into the orbit. Used by resume and
   * by the no-story entrance; velocity seeded from the capture ring. */
  const blendToOrbit = (config: SpringConfig, seedVelocity: boolean) => {
    deps.anchor(_anchor)
    const orbitRange = deps.orbitRangeM()
    lnOrbit = Math.log(orbitRange)
    deps.worldToEnu(camera.position, _cameraEnu)
    captureRig(_cameraEnu, _anchor, state)
    currentLookPoint(lookPoint0)
    // Re-phase the orbit onto the user's heading: nothing to unwind.
    orbitAz = state.azimuthDeg
    arrivedAt = t
    if (lnStart <= lnOrbit) lnStart = lnOrbit + 1
    const vAz = seedVelocity && ringValid >= 2 ? angleDelta(ringA.azimuthDeg, ringB.azimuthDeg) / ringDt : 0
    const vEl = seedVelocity && ringValid >= 2 ? (ringB.elevationDeg - ringA.elevationDeg) / ringDt : 0
    const vLr = seedVelocity && ringValid >= 2 ? (ringB.logRange - ringA.logRange) / ringDt : 0
    const omegaPerMs = story.orbit.degPerSec / 1000
    stopSprings()
    az.set(0)
    el.set(state.elevationDeg - story.orbit.elevationDeg)
    lr.set(state.logRange - lnOrbit)
    look.set(0)
    lookBlend.set(0)
    void az.start({ to: 0, config: { ...config, velocity: vAz - omegaPerMs } })
    void el.start({ to: 0, config: { ...config, velocity: vEl } })
    void lr.start({ to: 0, config: { ...config, velocity: vLr } })
    void look.start({ to: 0, config })
    void lookBlend.start({ to: 1, config: story.springs.lookBlend })
    setMode('resuming')
  }

  const evaluate = (dtS: number) => {
    t += dtS
    if (mode === 'story' || mode === 'resuming') orbitAz += story.orbit.degPerSec * dtS
    const breathing = story.orbit.breathing
    const w = arrivedAt < 0 ? 0 : smoothstep01((t - arrivedAt) / breathing.fadeInS)
    const breath = arrivedAt < 0 ? 0 : breathing.rangeAmp * Math.sin(2 * Math.PI * (t - arrivedAt) / breathing.periodS) * w
    deps.anchor(_anchor)
    state.azimuthDeg = orbitAz + az.get()
    state.elevationDeg = story.orbit.elevationDeg + el.get()
    state.logRange = lnOrbit + breath + lr.get()
    state.lookHeightM = story.orbit.lookHeightFraction * deps.parcelHeightM() + look.get()
    const floorRise = deps.floorZ() - _anchor.z
    state.elevationDeg = Math.max(state.elevationDeg, elevationFloorDeg(Math.exp(state.logRange), floorRise))
    if (arrivedAt < 0 && Math.abs(lr.get()) < 0.05 && Math.abs(el.get()) < 1) arrivedAt = t
  }

  const captureForRing = (dtMs: number) => {
    deps.anchor(_anchor)
    deps.worldToEnu(camera.position, _cameraEnu)
    ringA.azimuthDeg = ringB.azimuthDeg
    ringA.elevationDeg = ringB.elevationDeg
    ringA.logRange = ringB.logRange
    captureRig(_cameraEnu, _anchor, ringB)
    ringDt = Math.max(1, dtMs)
    ringValid = Math.min(2, ringValid + 1)
  }

  const takeover = () => {
    if (mode !== 'story' && mode !== 'resuming' && mode !== 'flyTo') return
    stopSprings()
    resumePendingConfig = null
    ringValid = 0
    setMode('user')
  }

  return {
    mode: () => mode,
    startStory: beginStory,
    flyToOrbit() {
      blendToOrbit(story.springs.flyTo, false)
    },
    flyToPoint(targetEnu, endDistanceM) {
      deps.worldToEnu(camera.position, dollyStart)
      _dir.subVectors(targetEnu, dollyStart)
      const distance = _dir.length()
      if (distance <= endDistanceM + 1) return
      _dir.divideScalar(distance)
      let travel = distance - endDistanceM
      // Solve the floor along the ray instead of clamping afterwards.
      if (_dir.z < -1e-6) travel = Math.min(travel, (deps.floorZ() - dollyStart.z) / _dir.z)
      if (travel <= 1) return
      dollyEnd.copy(dollyStart).addScaledVector(_dir, travel)
      dollyQuat.copy(camera.quaternion)
      stopSprings()
      dolly.set(0)
      void dolly.start({ to: 1, config: story.springs.flyTo })
      setMode('flyTo')
      deps.onCameraJump()
    },
    refit() {
      if (mode === 'story' || mode === 'resuming') {
        // Keep the current range: shift the offset by the base change so the
        // spring carries the camera to the new framing without a jump.
        const previous = lnOrbit
        lnOrbit = Math.log(deps.orbitRangeM())
        lr.set(lr.get() + (previous - lnOrbit))
        void lr.start({ to: 0, config: story.springs.flyTo })
      } else if (mode === 'user') {
        blendToOrbit(story.springs.flyTo, false)
      }
    },
    takeover,
    resume() {
      if (mode !== 'user' && mode !== 'idle') return
      resumePendingConfig = story.springs.resume
    },
    replay: beginStory,

    update(nowMs) {
      const dtMs = lastNow ? Math.min(100, nowMs - lastNow) : 16
      lastNow = nowMs
      if (mode === 'user') {
        captureForRing(dtMs)
        // Wait for the controls' inertia to die, then hand over C1.
        if (resumePendingConfig && !deps.controlsBusy()) {
          const config = resumePendingConfig
          resumePendingConfig = null
          blendToOrbit(config, true)
        }
        return
      }
      if (mode === 'flyTo') {
        const x = smoothstep01(dolly.get())
        _position.lerpVectors(dollyStart, dollyEnd, x)
        camera.position.copy(deps.enuToWorld(_position, _world))
        camera.quaternion.copy(dollyQuat)
        camera.updateMatrixWorld()
        if (dolly.idle) setMode('user')
        return
      }
      if (mode !== 'story' && mode !== 'resuming') return
      evaluate(dtMs / 1000)
      applyState(mode === 'resuming' ? lookBlend.get() : 1)
      if (mode === 'resuming' && lookBlend.idle) setMode('story')
      const progress = lnStart > lnOrbit
        ? THREE.MathUtils.clamp((state.logRange - lnOrbit) / (lnStart - lnOrbit), 0, 1)
        : 0
      deps.onStoryProgress(1 - progress, arrivedAt < 0 ? null : (t - arrivedAt) * 1000)
    },
    dispose() {
      stopSprings()
      setMode('idle')
    },
  }
}
