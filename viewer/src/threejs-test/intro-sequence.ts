// The donor intro: one choreography, authored once relative to the parcel.
//
// Reads EXPERIENCE_CONFIG.intro (keyframe tracks in ms) and drives the camera
// rig, the parcel outline draw, the cloud opacity and the captions from a
// single scrubbable clock. The camera is the only thing the user can take
// away from it: any gesture on the canvas releases the rig to the globe
// controls; after a configurable idle the rig blends back into the orbit —
// in rig space, so there is never a jump.
//
// Storyboard coverage (numbers refer to the product storyboard):
//   3/4/5/8/9  flight  — rig tracks from the overview range down to the frame
//   10         draw    — outline draws itself (donation-shape drawProgress)
//   11/12      captions + slow orbit with a breathing range
//   13         peruMinutes track (night → sunrise) when enabled
//   6/7 boundaries and live weather/audio are later milestones.
import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from './config'
import { createTimeline, evaluateTrack, type Timeline, type Track } from './sequence'
import { lerpRig, type CameraRig, type RigParams } from './camera-rig'
import { fillTemplate, type CaptionContent, type CaptionLayer } from './caption-layer'

interface CaptionTemplate {
  kicker?: string
  title: string
  body?: string
  data?: ReadonlyArray<{ label: string; value: string }>
}

export interface ParcelFacts {
  areaM2: number
  coordinates: string | null
}

export interface IntroSequenceDeps {
  rig: CameraRig
  captions: CaptionLayer
  canvas: HTMLElement
  reducedMotion: boolean
  setControlsEnabled(enabled: boolean): void
  /** Cancel any gesture state the controls were holding when the rig lets go. */
  resetControls(): void
  /** 0 while flying in, 1 once landed — feeds the vignette and cloud reveal. */
  onFlightProgress(progress: number): void
  setCloudOpacity(value: number | null): void
  setOutlineDraw(value: number | null): void
  setPeruMinutes(minutes: number | null): void
  parcelFacts(): ParcelFacts
  /** The start snaps the camera far out: rebase the floating origin at once. */
  onCameraJump(): void
  /** Dev slider (?scrub=1). */
  scrubber: boolean
}

export interface IntroSequence {
  /** Any track still running (captions, clock, orbit). */
  readonly active: boolean
  /** The rig owns the camera this frame; controls stay disabled. */
  readonly cameraActive: boolean
  start(now: number): void
  /** Hand the camera to the user; the rest of the story keeps going. */
  interrupt(now?: number): void
  update(now: number): void
  dispose(): void
}

const NAV_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
])

export function createIntroSequence(deps: IntroSequenceDeps): IntroSequence {
  const cfg = EXPERIENCE_CONFIG.intro
  const phases = cfg.phases
  const rate = deps.reducedMotion ? cfg.reducedMotionRate : 1
  const loop = deps.reducedMotion ? null : cfg.orbitLoop
  const timeline: Timeline = createTimeline({ durationMs: cfg.durationMs, loop, rate })

  const rigTracks = cfg.rig as { azimuthDeg: Track; elevationDeg: Track; range: Track }
  const params: RigParams = { azimuthDeg: 0, elevationDeg: 45, range: 1 }
  const blended: RigParams = { azimuthDeg: 0, elevationDeg: 45, range: 1 }
  const captured: RigParams = { azimuthDeg: 0, elevationDeg: 45, range: 1 }

  let started = false
  let cameraActive = false
  let blendStart = -Infinity
  let lastInput = -Infinity
  let lastFlightProgress = -1
  let scrub: { root: HTMLElement; range: HTMLInputElement; time: HTMLElement; toggle: HTMLButtonElement } | null = null

  const evaluateRig = (t: number, target: RigParams): RigParams => {
    target.azimuthDeg = evaluateTrack(rigTracks.azimuthDeg, t)
    target.elevationDeg = evaluateTrack(rigTracks.elevationDeg, t)
    target.range = evaluateTrack(rigTracks.range, t)
    return target
  }

  const takeCamera = (now: number, blend: boolean) => {
    if (blend) {
      deps.rig.capture(captured)
      blendStart = now
    } else {
      blendStart = -Infinity
    }
    cameraActive = true
    deps.setControlsEnabled(false)
  }

  const releaseCamera = () => {
    if (!cameraActive) return
    cameraActive = false
    blendStart = -Infinity
    deps.resetControls()
    deps.setControlsEnabled(true)
  }

  const captionFor = (t: number): { id: string; content: CaptionContent } | null => {
    for (const entry of cfg.captions) {
      if (t >= entry.at && t < entry.until) {
        const text = (cfg.captionText as Record<string, CaptionTemplate | undefined>)[entry.id]
        if (!text) return null
        const facts = deps.parcelFacts()
        const values = {
          areaM2: Math.round(facts.areaM2),
          coordinates: facts.coordinates ?? '—',
        }
        return {
          id: entry.id,
          content: {
            kicker: text.kicker ? fillTemplate(text.kicker, values) : undefined,
            title: fillTemplate(text.title, values),
            body: text.body ? fillTemplate(text.body, values) : undefined,
            data: text.data?.map((item) => ({
              label: fillTemplate(item.label, values),
              value: fillTemplate(item.value, values),
            })),
          },
        }
      }
    }
    return null
  }

  // ---------------------------------------------------------------- takeover
  const onPointerDown = (event: PointerEvent) => {
    lastInput = performance.now()
    if (!cameraActive || !started) return
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 2) return
    interrupt(lastInput)
  }
  const onWheel = () => {
    lastInput = performance.now()
    if (cameraActive && started) interrupt(lastInput)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (!NAV_KEYS.has(event.code)) return
    lastInput = performance.now()
    if (cameraActive && started) interrupt(lastInput)
  }

  function interrupt(now = performance.now()): void {
    if (!cameraActive) return
    releaseCamera()
    lastInput = now
    deps.onFlightProgress(1)
    lastFlightProgress = 1
    // Landing skipped by hand: still let the parcel draw and the captions run.
    if (timeline.timeMs < phases.settle) timeline.seek(phases.settle)
  }

  // ---------------------------------------------------------------- scrubber
  const formatTime = (ms: number) => `${(ms / 1000).toFixed(1)} s`
  const installScrubber = () => {
    const root = document.createElement('div')
    root.id = 'introScrub'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.textContent = '❚❚'
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0'
    range.max = String(cfg.durationMs)
    range.step = '10'
    range.setAttribute('list', 'introScrubMarks')
    const marks = document.createElement('datalist')
    marks.id = 'introScrubMarks'
    for (const [name, at] of Object.entries(phases)) {
      const option = document.createElement('option')
      option.value = String(at)
      option.label = name
      marks.appendChild(option)
    }
    const time = document.createElement('span')
    root.append(toggle, range, time, marks)
    document.body.appendChild(root)
    toggle.addEventListener('click', () => {
      if (timeline.playing) { timeline.pause(); toggle.textContent = '▶' }
      else { timeline.play(); toggle.textContent = '❚❚' }
    })
    range.addEventListener('input', () => {
      timeline.seek(Number(range.value))
      // Scrubbing re-takes the camera: the slider is the director's chair.
      if (!cameraActive) takeCamera(performance.now(), false)
      lastInput = Infinity // never auto-resume while the slider is in use
    })
    scrub = { root, range, time, toggle }
  }

  const syncScrubber = (t: number) => {
    if (!scrub) return
    if (document.activeElement !== scrub.range) scrub.range.value = String(Math.round(t))
    const label = `${formatTime(t)}${cameraActive ? '' : ' · frei'}`
    if (scrub.time.textContent !== label) scrub.time.textContent = label
  }

  return {
    get active() { return started && timeline.playing },
    get cameraActive() { return cameraActive },

    start(now) {
      if (started) return
      started = true
      deps.canvas.addEventListener('pointerdown', onPointerDown, { capture: true })
      deps.canvas.addEventListener('wheel', onWheel, { capture: true, passive: true })
      window.addEventListener('keydown', onKeyDown, { capture: true })
      timeline.seek(0)
      timeline.play()
      takeCamera(now, false)
      deps.rig.apply(evaluateRig(0, params))
      deps.onCameraJump()
      deps.setOutlineDraw(0)
      if (deps.scrubber) installScrubber()
      this.update(now)
    },

    interrupt,

    update(now) {
      if (!started) return
      const t = timeline.tick(now)

      // Story tracks run whether or not the user holds the camera.
      const flightProgress = THREE.MathUtils.clamp((t - phases.flight) / Math.max(1, phases.settle - phases.flight), 0, 1)
      if (flightProgress !== lastFlightProgress) {
        lastFlightProgress = flightProgress
        deps.onFlightProgress(flightProgress)
      }
      deps.setCloudOpacity(cfg.cloudOpacity.length ? evaluateTrack(cfg.cloudOpacity, t) : null)
      deps.setOutlineDraw(t < phases.draw ? 0 : evaluateTrack(cfg.outlineDraw, t))
      if (cfg.dayNight.enabled) {
        const minutes = evaluateTrack(cfg.dayNight.peruMinutes, t)
        deps.setPeruMinutes(t < cfg.dayNight.peruMinutes[0]?.t ? null : minutes)
      }
      const caption = captionFor(t)
      if (caption) deps.captions.show(caption.id, caption.content)
      else deps.captions.hide()

      // Camera: idle users get the orbit back, blended from where they left it.
      if (!cameraActive && timeline.playing && lastInput !== Infinity
        && t >= phases.orbit && now - lastInput >= cfg.takeover.resumeIdleMs) {
        takeCamera(now, true)
      }
      if (cameraActive) {
        evaluateRig(t, params)
        if (blendStart !== -Infinity) {
          const x = THREE.MathUtils.clamp((now - blendStart) / cfg.takeover.resumeBlendMs, 0, 1)
          const eased = x * x * (3 - 2 * x)
          deps.rig.apply(lerpRig(captured, params, eased, blended))
          if (x >= 1) blendStart = -Infinity
        } else {
          deps.rig.apply(params)
        }
        // The story is over (reduced motion, or no loop): give the camera back.
        if (!timeline.playing && t >= timeline.durationMs) releaseCamera()
      }
      syncScrubber(t)
    },

    dispose() {
      deps.canvas.removeEventListener('pointerdown', onPointerDown, { capture: true })
      deps.canvas.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      scrub?.root.remove()
      releaseCamera()
    },
  }
}
