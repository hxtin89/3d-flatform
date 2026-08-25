// Measurement rig for the Windows mouse-jitter report. Read-only: it never
// changes what the app renders, it only records what happened.
//
// Why this exists rather than "someone drags the mouse and describes it": the
// symptom is micro-stutter, which is a distribution problem. A mean frame time
// hides it completely — 60 fps with one 90 ms frame per second looks identical
// to a flat 60 fps in every average, and only the second one stutters. So the
// probe keeps a rolling window and reports percentiles, the worst frame, and
// what the frame was doing when it happened.
import * as THREE from 'three'

export interface PerfSample {
  /** Visible points and tiles this frame, from the streaming stats. */
  points: number
  pointTiles: number
  mapTiles: number
  downloads: number
  cacheBytes: number
  gpuBytes: number
  sse: number
  rebases: number
}

export interface PerfProbe {
  frame(now: number, sample: PerfSample): void
  /** Called whenever the navigation floor clamps the camera and resets the
   * controls. Every such frame cancels an in-progress mouse drag, so a high
   * rate here is not a detail — it is the navigation being interrupted. */
  noteNavigationClamp(): void
  dispose(): void
}

interface PerfContext {
  backend: string
  adapter: string
  devicePixelRatio: number
  pixelRatio: number
  viewport: string
  userAgent: string
  platform: string
  preset: string
  options: Record<string, boolean>
}

const WINDOW_MS = 10_000
const MAX_FRAMES = 1_200

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return sorted[index]
}

export function createPerfProbe(opts: {
  camera: THREE.PerspectiveCamera
  canvas: HTMLCanvasElement
  context(): PerfContext
}): PerfProbe {
  const { camera, canvas } = opts

  // Ring buffers. Frame times drive the percentiles; the pointer counters answer
  // whether Windows' 500-1000 Hz mouse polling is arriving as a burst of events
  // per frame (3d-tiles-renderer handles every pointermove individually — it
  // never calls getCoalescedEvents).
  const frameTimes: number[] = []
  const frameStamps: number[] = []
  const rotationDeltas: number[] = []
  const positionDeltas: number[] = []
  let pointerEvents = 0
  let coalescedEvents = 0
  let pointerEventsThisFrame = 0
  let maxPointerEventsPerFrame = 0
  // Tasks the browser itself flags as blocking. The frame-time window only sees
  // work inside rAF; a long task can also sit between frames (a parse, a GPU
  // upload, a style recalculation) and still be felt as a hitch.
  const longTasks: number[] = []
  let longTaskObserver: PerformanceObserver | null = null
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Number(entry.duration.toFixed(1)))
      if (longTasks.length > 200) longTasks.splice(0, longTasks.length - 200)
    })
    longTaskObserver.observe({ entryTypes: ['longtask'] })
  } catch { /* Safari has no longtask observer; the frame window still works */ }

  let navigationClamps = 0
  let dragging = false
  let dragFrames = 0
  let lastNow = -1

  const previousQuaternion = new THREE.Quaternion().copy(camera.quaternion)
  const previousPosition = new THREE.Vector3().copy(camera.position)
  let peakSample: (PerfSample & { frameMs: number; pointerEvents: number }) | null = null

  const onPointerDown = () => { dragging = true; dragFrames = 0 }
  const onPointerUp = () => { dragging = false }
  const onPointerMove = (event: PointerEvent) => {
    pointerEvents++
    pointerEventsThisFrame++
    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents().length : 1
    coalescedEvents += coalesced
  }
  // Passive and capture-phase: observing only, never interfering with controls.
  canvas.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  document.addEventListener('pointerup', onPointerUp, { capture: true, passive: true })
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })

  const overlay = document.createElement('div')
  overlay.id = 'perfProbe'
  overlay.style.cssText = [
    'position:fixed', 'left:10px', 'bottom:calc(10px + env(safe-area-inset-bottom, 0px))',
    'z-index:40', 'padding:9px 11px', 'border-radius:10px',
    'background:rgba(14,17,22,.92)', 'border:1px solid #262b32', 'color:#e8eaed',
    'font:10px/1.45 ui-monospace, SFMono-Regular, monospace', 'white-space:pre',
    'pointer-events:auto', 'backdrop-filter:blur(10px)',
  ].join(';')
  const readout = document.createElement('div')
  const copyButton = document.createElement('button')
  copyButton.type = 'button'
  copyButton.textContent = 'Copy JSON'
  copyButton.style.cssText = [
    'margin-top:7px', 'width:100%', 'padding:5px', 'cursor:pointer',
    'background:#21262d', 'color:#e8eaed', 'border:1px solid #2d333b', 'border-radius:7px',
    'font:inherit',
  ].join(';')
  overlay.append(readout, copyButton)
  document.body.appendChild(overlay)

  function report(): Record<string, unknown> {
    const sorted = [...frameTimes].sort((a, b) => a - b)
    const seconds = frameTimes.length > 1
      ? (frameStamps[frameStamps.length - 1] - frameStamps[0]) / 1000
      : 0
    const rotationSorted = [...rotationDeltas].sort((a, b) => a - b)
    const panSorted = [...positionDeltas].sort((a, b) => a - b)
    return {
      capturedAt: new Date().toISOString(),
      context: opts.context(),
      window: { frames: frameTimes.length, seconds: Number(seconds.toFixed(2)) },
      frameMs: {
        p50: Number(percentile(sorted, 0.5).toFixed(2)),
        p95: Number(percentile(sorted, 0.95).toFixed(2)),
        p99: Number(percentile(sorted, 0.99).toFixed(2)),
        max: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
        // Frames past this bound lose motion outright: EnvironmentControls
        // clamps its deltaTime at 64 ms, so anything slower is under-integrated
        // and reads as a hitch even when the average looks fine.
        over64ms: sorted.filter((value) => value > 64).length,
        over32ms: sorted.filter((value) => value > 32).length,
      },
      longTasks: {
        count: longTasks.length,
        max: longTasks.length ? Math.max(...longTasks) : 0,
        over100ms: longTasks.filter((value) => value > 100).length,
        supported: longTaskObserver !== null,
      },
      navigation: {
        clamps: navigationClamps,
        clampsPerSecond: seconds > 0 ? Number((navigationClamps / seconds).toFixed(1)) : 0,
        // One per frame means the zoom stop and the controls are fighting each
        // other continuously, and no mouse gesture can survive it.
        clampedEveryFrame: frameTimes.length > 30 && navigationClamps >= frameTimes.length - 2,
      },
      pointer: {
        events: pointerEvents,
        eventsPerSecond: seconds > 0 ? Number((pointerEvents / seconds).toFixed(1)) : 0,
        coalescedPerEvent: pointerEvents > 0 ? Number((coalescedEvents / pointerEvents).toFixed(2)) : 0,
        maxEventsPerFrame: maxPointerEventsPerFrame,
      },
      rotationDegPerFrame: {
        p50: Number(percentile(rotationSorted, 0.5).toFixed(4)),
        p95: Number(percentile(rotationSorted, 0.95).toFixed(4)),
        max: Number((rotationSorted[rotationSorted.length - 1] ?? 0).toFixed(4)),
        // Even motion produces a tight spread; visible stutter is a wide one.
        samples: rotationDeltas.length,
      },
      panMetresPerFrame: {
        p50: Number(percentile(panSorted, 0.5).toFixed(4)),
        p95: Number(percentile(panSorted, 0.95).toFixed(4)),
        max: Number((panSorted[panSorted.length - 1] ?? 0).toFixed(4)),
      },
      worstFrame: peakSample,
    }
  }

  copyButton.addEventListener('click', () => {
    const text = JSON.stringify(report(), null, 2)
    navigator.clipboard?.writeText(text).then(
      () => { copyButton.textContent = 'Copied ✓'; setTimeout(() => { copyButton.textContent = 'Copy JSON' }, 1500) },
      () => { console.info('[perf] clipboard blocked — report follows'); console.info(text) },
    )
  })

  let lastOverlayUpdate = 0

  /** Clears the window. Called at the start of every scripted run, because the
   * 600 ms boot frame would otherwise remain the worst frame of every report. */
  function reset(): void {
    frameTimes.length = 0
    frameStamps.length = 0
    rotationDeltas.length = 0
    positionDeltas.length = 0
    pointerEvents = 0
    coalescedEvents = 0
    maxPointerEventsPerFrame = 0
    navigationClamps = 0
    longTasks.length = 0
    dragFrames = 0
    peakSample = null
  }

  ;(window as any).__perf = {
    report,
    reset,
    raw: () => ({ frameTimes: [...frameTimes], rotationDeltas: [...rotationDeltas], positionDeltas: [...positionDeltas] }),
  }

  return {
    noteNavigationClamp() {
      navigationClamps++
    },
    frame(now, sample) {
      if (lastNow >= 0) {
        const frameMs = now - lastNow
        frameTimes.push(frameMs)
        frameStamps.push(now)
        while (frameTimes.length > MAX_FRAMES || (frameStamps.length > 1 && now - frameStamps[0] > WINDOW_MS)) {
          frameTimes.shift()
          frameStamps.shift()
        }
        if (!peakSample || frameMs > peakSample.frameMs) {
          peakSample = { ...sample, frameMs: Number(frameMs.toFixed(2)), pointerEvents: pointerEventsThisFrame }
        }
        if (dragging) {
          // Angle between successive orientations: the quantity the eye reads as
          // smooth or stuttering, independent of how the input arrived.
          rotationDeltas.push(THREE.MathUtils.radToDeg(previousQuaternion.angleTo(camera.quaternion)))
          // Dragging with the left button pans instead of rotating, so the
          // orientation barely changes — without this the pan path would look
          // perfectly smooth simply because nothing was being measured.
          positionDeltas.push(previousPosition.distanceTo(camera.position))
          if (rotationDeltas.length > MAX_FRAMES) rotationDeltas.shift()
          if (positionDeltas.length > MAX_FRAMES) positionDeltas.shift()
          dragFrames++
        }
      }
      previousQuaternion.copy(camera.quaternion)
      previousPosition.copy(camera.position)
      maxPointerEventsPerFrame = Math.max(maxPointerEventsPerFrame, pointerEventsThisFrame)
      pointerEventsThisFrame = 0
      lastNow = now

      if (now - lastOverlayUpdate < 250) return
      lastOverlayUpdate = now
      const data = report() as any
      readout.textContent = [
        `frame ms  p50 ${data.frameMs.p50}  p95 ${data.frameMs.p95}  p99 ${data.frameMs.p99}`,
        `          max ${data.frameMs.max}  >32ms ${data.frameMs.over32ms}  >64ms ${data.frameMs.over64ms}`,
        `pointer   ${data.pointer.eventsPerSecond}/s  max/frame ${data.pointer.maxEventsPerFrame}  coalesced ${data.pointer.coalescedPerEvent}`,
        `rotation  p50 ${data.rotationDegPerFrame.p50}°  p95 ${data.rotationDegPerFrame.p95}°  max ${data.rotationDegPerFrame.max}°`,
        `pan       p50 ${data.panMetresPerFrame.p50}m  p95 ${data.panMetresPerFrame.p95}m  max ${data.panMetresPerFrame.max}m`,
        `long task ${data.longTasks.count}  max ${data.longTasks.max}ms  >100ms ${data.longTasks.over100ms}`,
        `nav clamp ${data.navigation.clampsPerSecond}/s${data.navigation.clampedEveryFrame ? '  ← every frame, drags are cancelled' : ''}`,
        `points ${sample.points.toLocaleString('en-US')}  tiles ${sample.pointTiles}/${sample.mapTiles}  drag frames ${dragFrames}`,
      ].join('\n')
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown, { capture: true } as any)
      document.removeEventListener('pointerup', onPointerUp, { capture: true } as any)
      document.removeEventListener('pointermove', onPointerMove, { capture: true } as any)
      longTaskObserver?.disconnect()
      overlay.remove()
      delete (window as any).__perf
    },
  }
}
