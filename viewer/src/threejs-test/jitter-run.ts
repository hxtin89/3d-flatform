// A scripted navigation gesture, so two machines can be compared at all.
//
// Hand-dragging is not a measurement: speed, path and duration differ every
// time and between people, and the jitter report needs the input held constant
// while the machine varies. This replays a fixed sequence — same angular speed,
// same event rate, same duration — and can drive either the mouse path or the
// keyboard path, which is the comparison the ticket asks for.
export interface JitterRunOptions {
  /** Which input path to exercise. Mouse goes through EnvironmentControls'
   * pointer handlers, keyboard through keyboard-navigation.ts. */
  input?: 'mouse' | 'keyboard'
  /** EnvironmentControls binds rotation to the right button (or shift+left) and
   * panning to the left one, so the two feel different and have to be measured
   * separately. The ticket is about rotation, hence the default. */
  gesture?: 'rotate' | 'pan'
  seconds?: number
  /** Pointer moves emitted per frame. 1 is a well-behaved 60 Hz mouse; 8 mimics
   * a 500 Hz gaming mouse, which is the Windows case under suspicion. */
  eventsPerFrame?: number
  /** Horizontal travel per emitted event, in CSS pixels. */
  pixelsPerEvent?: number
}

export interface JitterRunResult {
  input: string
  gesture: string
  seconds: number
  frames: number
  eventsSent: number
  /** Guard rails: if the camera did not actually move, the numbers describe an
   * idle scene and mean nothing — better to say so than to report smoothness. */
  cameraMovedM: number
  cameraRotatedDeg: number
  report: unknown
}

export function installJitterRun(canvas: HTMLCanvasElement): () => void {
  async function run(options: JitterRunOptions = {}): Promise<JitterRunResult> {
    const input = options.input ?? 'mouse'
    const gesture = options.gesture ?? 'rotate'
    const seconds = options.seconds ?? 6
    const eventsPerFrame = options.eventsPerFrame ?? 4
    const pixelsPerEvent = options.pixelsPerEvent ?? 1.5

    const rect = canvas.getBoundingClientRect()
    let x = rect.left + rect.width * 0.5
    const y = rect.top + rect.height * 0.55
    let eventsSent = 0
    let frames = 0
    const started = performance.now()

    const pointerId = 4242
    const rotating = gesture === 'rotate'
    const button = rotating ? 2 : 0
    const buttons = rotating ? 2 : 1
    const base = {
      pointerId, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
      clientY: y, shiftKey: false,
    }

    const camera = (window as any).__three?.camera
    const startPosition = camera ? camera.position.clone() : null
    const startQuaternion = camera ? camera.quaternion.clone() : null
    ;(window as any).__perf?.reset?.()

    if (input === 'mouse') {
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, button, buttons }))
    } else {
      // 'KeyD' pans right — the keyboard equivalent of dragging sideways.
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true }))
    }

    try {
      // The path is a function of elapsed time, not an accumulator with edge
      // flips: flipping the sign per event makes the pointer oscillate in place
      // once it reaches the margin, which reads as "no movement at all" and
      // silently measures an idle scene.
      const amplitude = Math.max(80, rect.width * 0.5 - 60)
      const centre = rect.left + rect.width * 0.5
      const pixelsPerSecond = pixelsPerEvent * eventsPerFrame * 60
      const halfPeriod = Math.max(0.75, amplitude / Math.max(1, pixelsPerSecond))
      const at = (elapsedSeconds: number) => {
        // Triangle wave: constant speed, direction reverses only at the ends.
        // Phase-shifted by half a leg so the first move continues from the
        // press position instead of jumping to the far edge — that jump is a
        // single 600 px drag step, which throws the camera into the navigation
        // clamp and cancels the gesture before it starts.
        const phase = (elapsedSeconds / halfPeriod + 0.5) % 2
        return centre + amplitude * (phase < 1 ? phase * 2 - 1 : 3 - phase * 2)
      }

      while (performance.now() - started < seconds * 1000) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        frames++
        if (input !== 'mouse') continue
        const frameStart = (performance.now() - started) / 1000
        for (let index = 0; index < eventsPerFrame; index++) {
          x = at(frameStart + (index / eventsPerFrame) / 60)
          document.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, buttons }))
          eventsSent++
        }
      }
    } finally {
      if (input === 'mouse') {
        document.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x, button, buttons: 0 }))
      } else {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd', bubbles: true }))
        document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd', bubbles: true }))
      }
    }

    const elapsed = (performance.now() - started) / 1000
    const movedM = startPosition && camera ? startPosition.distanceTo(camera.position) : 0
    const rotatedDeg = startQuaternion && camera
      ? (startQuaternion.angleTo(camera.quaternion) * 180) / Math.PI
      : 0
    const result: JitterRunResult = {
      input,
      gesture,
      seconds: Number(elapsed.toFixed(2)),
      frames,
      eventsSent,
      cameraMovedM: Number(movedM.toFixed(2)),
      cameraRotatedDeg: Number(rotatedDeg.toFixed(3)),
      report: (window as any).__perf?.report?.() ?? null,
    }
    const navigation = (result.report as any)?.navigation
    if (movedM < 0.01 && rotatedDeg < 0.01) {
      console.warn('[jitter] the camera never moved — the run measured an idle scene, not navigation')
      if (navigation?.clampedEveryFrame) {
        console.warn('[jitter] …because the navigation floor clamped and reset the controls on every'
          + ' frame. At the zoom stop a mouse drag is cancelled as fast as it starts; zoom out a'
          + ' little and run again to measure actual navigation.')
      }
    }
    console.info('[jitter] run complete', result)
    return result
  }

  ;(window as any).__jitter = { run }
  return () => { delete (window as any).__jitter }
}
