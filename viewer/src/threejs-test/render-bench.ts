/**
 * Repeatable camera poses, so two builds can be compared at the same view.
 *
 * Every render measurement in this app is a function of where the camera is standing —
 * point count, covered area and GPU time all move by more between two viewpoints than
 * any optimisation is expected to move them at one. Comparing a change therefore means
 * returning to the *same* pose, and eyeballing "roughly the same place" is not close
 * enough to read a ten-percent difference off.
 *
 * Poses are stored in ECEF, not in render space, for two reasons: the floating origin
 * shifts render space whenever the camera travels far enough, and localStorage has to
 * survive the reload that a code change requires. ECEF is the only frame that is stable
 * across both.
 *
 * Console use:
 *   __poses.save('tilt45')      // stand where you want, then name it
 *   __poses.list()
 *   __poses.go('tilt45')
 *   await __poses.bench('tilt45')
 *   await __poses.sweep()       // every pose, one table
 */
import * as THREE from 'three'
import { ecefToRender, renderToEcef } from './origin'

const STORAGE_KEY = 'sbb.render-bench.poses'

export interface BenchPose {
  name: string
  /** Camera position in ECEF metres — the frame the floating origin does not move. */
  ecef: [number, number, number]
  quaternion: [number, number, number, number]
  savedAt: string
}

/** The numbers a measurement records beside the timing. Supplied by the caller so the
 *  bench does not keep a second copy of the readout arithmetic. */
export interface BenchSample {
  points: number
  tiles: number
  drawCalls: number
  overdraw: number
  areaPerPoint: number
}

export interface BenchResult extends BenchSample {
  pose: string
  frames: number
  /** Median GPU milliseconds. Zero when ?gputime is off or the browser withholds
   *  timestamps — see `gpuTiming` in main.ts. */
  gpuMsMedian: number
  gpuMsMin: number
  gpuMsMax: number
  msPerFrame: number
  /** What stopped the scene being quiet, or null when it was. A measurement taken while
   *  this is set describes the loader, the entrance flight or the boot brake rather than
   *  the renderer, and the two are not comparable. */
  unsettled: string | null
  /**
   * How far the camera ended up from the stored pose, in metres.
   *
   * Never quite zero: the ground-clearance constraint and the controls both run every
   * frame and push a jumped-to camera back inside what they allow — measured at about a
   * metre, which leaves the visible point count identical. Reported rather than hidden,
   * because a pose that lands somewhere else entirely is the one way this harness can
   * quietly compare two different views and call it a regression.
   */
  poseDriftM: number
}

export interface RenderBenchOptions {
  camera: THREE.PerspectiveCamera
  sample: () => BenchSample
  /** Null when the scene is quiet, otherwise the reason it is not — reported rather
   *  than reduced to a boolean so an unusable measurement says what to do about it. */
  unsettled: () => string | null
  /**
   * GPU milliseconds for the last frame; 0 when timestamps are unavailable.
   *
   * Deliberately a plain read of a value someone else resolves once per frame, not a
   * resolve of its own. Resolving inside the sampling loop lets whole frames pile up in
   * the query pool between calls, and the pool reports their *sum* — which read as a
   * clean doubling of the true figure against the same number on the HUD.
   */
  gpuMs: () => number
  /** Hand the camera back to the controls after a jump — they hold damping state that
   *  would otherwise drag it back toward where it was. */
  afterJump?: () => void
}

export interface RenderBench {
  save(name: string): BenchPose
  list(): Array<{ name: string; savedAt: string }>
  remove(name: string): boolean
  go(name: string): boolean
  bench(name?: string, frames?: number): Promise<BenchResult>
  sweep(frames?: number): Promise<BenchResult[]>
}

function load(): BenchPose[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // A private window, cleared site data, or storage the browser refuses outright.
    // An empty list is the right answer to all three; poses are a convenience.
    return []
  }
}

function store(poses: BenchPose[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(poses))
  } catch {
    console.warn('[bench] poses could not be stored — they will not survive a reload')
  }
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

export function createRenderBench(opts: RenderBenchOptions): RenderBench {
  const { camera, sample, unsettled, gpuMs, afterJump } = opts
  const scratch = new THREE.Vector3()

  /** Wait for streaming to go quiet, so the timing measures drawing and not loading.
   *  Gives up rather than hanging: a view over missing data never settles, and neither
   *  does one where the entrance has not been started. Returns the last reason. */
  async function waitForQuiet(timeoutMs = 20_000): Promise<string | null> {
    const deadline = performance.now() + timeoutMs
    let quiet = 0
    let reason: string | null = null
    while (performance.now() < deadline) {
      await nextFrame()
      // Several consecutive quiet frames, because loadProgress touches 1 between one
      // tile finishing and the next being requested.
      reason = unsettled()
      quiet = reason === null ? quiet + 1 : 0
      if (quiet >= 30) return null
    }
    return reason ?? 'did not go quiet within the timeout'
  }

  /** Metres between where the camera stands now and where a pose says it should. */
  function driftFrom(pose: BenchPose | undefined): number {
    if (!pose) return 0
    const here = renderToEcef(camera.position, scratch)
    return Math.hypot(here.x - pose.ecef[0], here.y - pose.ecef[1], here.z - pose.ecef[2])
  }

  async function measure(pose: string, frames: number, target?: BenchPose): Promise<BenchResult> {
    const blocked = await waitForQuiet()

    // One pass with nothing awaited but the frame itself. Anything else in this loop
    // costs a vsync and the wall clock stops describing the frame rate: an earlier
    // version awaited the timestamp resolve here and reported 26 ms a frame while the
    // HUD held 115 fps.
    const samples: number[] = []
    const first = await nextFrame()
    let last = first
    for (let index = 1; index < frames; index++) {
      last = await nextFrame()
      const value = gpuMs()
      if (value > 0) samples.push(value)
    }
    const msPerFrame = frames > 1 ? (last - first) / (frames - 1) : 0

    return {
      pose,
      frames,
      gpuMsMedian: Number(median(samples).toFixed(3)),
      gpuMsMin: Number((samples.length ? Math.min(...samples) : 0).toFixed(3)),
      gpuMsMax: Number((samples.length ? Math.max(...samples) : 0).toFixed(3)),
      msPerFrame: Number(msPerFrame.toFixed(2)),
      unsettled: blocked,
      poseDriftM: Number(driftFrom(target).toFixed(2)),
      ...sample(),
    }
  }

  return {
    save(name) {
      const poses = load().filter((pose) => pose.name !== name)
      const ecef = renderToEcef(camera.position, scratch)
      const pose: BenchPose = {
        name,
        ecef: [ecef.x, ecef.y, ecef.z],
        quaternion: camera.quaternion.toArray() as [number, number, number, number],
        savedAt: new Date().toISOString(),
      }
      poses.push(pose)
      store(poses)
      return pose
    },
    list() {
      return load().map(({ name, savedAt }) => ({ name, savedAt }))
    },
    remove(name) {
      const poses = load()
      const kept = poses.filter((pose) => pose.name !== name)
      if (kept.length === poses.length) return false
      store(kept)
      return true
    },
    go(name) {
      const pose = load().find((entry) => entry.name === name)
      if (!pose) {
        console.warn(`[bench] no pose named "${name}" — try __poses.list()`)
        return false
      }
      scratch.set(pose.ecef[0], pose.ecef[1], pose.ecef[2])
      camera.position.copy(ecefToRender(scratch, scratch))
      camera.quaternion.fromArray(pose.quaternion)
      camera.updateMatrixWorld(true)
      afterJump?.()
      return true
    },
    async bench(name, frames = 120) {
      if (name && !this.go(name)) throw new Error(`no pose named "${name}"`)
      return measure(name ?? 'current', frames, load().find((pose) => pose.name === name))
    },
    async sweep(frames = 120) {
      const results: BenchResult[] = []
      for (const pose of load()) {
        this.go(pose.name)
        results.push(await measure(pose.name, frames, pose))
      }
      console.table(results)
      return results
    },
  }
}
