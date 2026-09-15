/**
 * What a tile costs when it arrives — the one thing none of the existing instruments
 * could see.
 *
 * `Fps` averages over 250 ms and `render-bench` reports a mean over its window, so a
 * change that lowers the average while adding periodic hitches passes both and still
 * feels worse to drive. The complaint this module exists to settle is exactly that
 * shape: "more fps on paper, choppier in the hand."
 *
 * Three things are recorded, because the cost of a tile is split across three moments:
 *
 *  1. `recordArrival` — the synchronous work in the `load-model` handler: the shuffle,
 *     the quad build, the per-tile material. Main-thread, inside a rAF turn.
 *  2. `recordFrame` — the frame-time *distribution*, not its centre. The upload and the
 *     shader compile do not happen in `load-model` at all; they happen on the first
 *     frame the tile is drawn, inside the render pass. They are invisible to (1) and
 *     show up here as the tail.
 *  3. `programCounts` — how many distinct shader programs and pipelines are alive. If
 *     this climbs with the number of loaded tiles, every tile is minting its own.
 *
 * Deliberately not on the HUD: it is a before/after instrument for a specific piece of
 * work, read from the console via `window.__cost`. Keeping it out of `updateHud` also
 * keeps it out of the per-frame DOM writes it is meant to be measuring.
 */

/** Big enough to cover a long drag at 120 Hz, small enough to stay a cheap sort. */
const FRAME_WINDOW = 1200
/** Tile arrivals are rare next to frames, so a shorter ring still spans a full flight. */
const ARRIVAL_WINDOW = 256

const frameMs = new Float64Array(FRAME_WINDOW)
let frameCount = 0
let frameCursor = 0

const arrivalMs = new Float64Array(ARRIVAL_WINDOW)
const arrivalPoints = new Float64Array(ARRIVAL_WINDOW)
let arrivalCount = 0
let arrivalCursor = 0

let lastFrameAt = 0

/**
 * One rendered frame. Takes the rAF timestamp rather than measuring a span, so what is
 * recorded is the interval the viewer actually experienced — a frame that missed its
 * vsync counts as late even if the JS inside it was quick.
 */
export function recordFrame(now: number): void {
  if (lastFrameAt !== 0) {
    const dt = now - lastFrameAt
    // A tab that was backgrounded returns a multi-second gap that is not a hitch. The
    // ceiling is well above any real stall and well below a resume.
    if (dt > 0 && dt < 1000) {
      frameMs[frameCursor] = dt
      frameCursor = (frameCursor + 1) % FRAME_WINDOW
      frameCount++
    }
  }
  lastFrameAt = now
}

/** One tile's synchronous arrival work, with the point count it carried. */
export function recordArrival(ms: number, points: number): void {
  arrivalMs[arrivalCursor] = ms
  arrivalPoints[arrivalCursor] = points
  arrivalCursor = (arrivalCursor + 1) % ARRIVAL_WINDOW
  arrivalCount++
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return sorted[index]
}

function live(ring: Float64Array, count: number): number[] {
  const n = Math.min(count, ring.length)
  const out: number[] = new Array(n)
  for (let i = 0; i < n; i++) out[i] = ring[i]
  return out
}

/**
 * Shader programs and pipelines currently alive.
 *
 * Read off the renderer's private caches rather than `renderer.info.memory.programs`,
 * because the public counter tracks *programs* only — the pipeline cache and the TSL
 * node-builder cache are the two that reveal a per-tile fork, and neither is public.
 * Guarded throughout: these are internals and may move between three revisions, in
 * which case the row simply reads null rather than throwing inside a measurement.
 */
export function programCounts(renderer: any): {
  programs: number | null
  pipelines: number | null
  nodeBuilds: number | null
} {
  try {
    const pipelines = renderer?._pipelines
    const nodes = renderer?._nodes
    return {
      programs: (pipelines?.programs?.vertex?.size ?? 0) + (pipelines?.programs?.fragment?.size ?? 0),
      pipelines: pipelines?.caches?.size ?? null,
      nodeBuilds: nodes?.nodeBuilderCache?.size ?? null,
    }
  } catch {
    return { programs: null, pipelines: null, nodeBuilds: null }
  }
}

export interface CostReport {
  frames: {
    n: number
    p50: number
    p95: number
    p99: number
    max: number
    /** Frames past 16.7 ms — the hitches, as a count and a share. Absolute, not relative
     *  to this run's own median, so two runs at different frame rates stay comparable. */
    lateCount: number
    latePct: number
  }
  arrivals: {
    n: number
    p50: number
    p95: number
    max: number
    totalMs: number
    medianPoints: number
    /** Nanoseconds of arrival work per point — comparable across tile sizes. */
    nsPerPoint: number
  }
  shaders: ReturnType<typeof programCounts>
}

export function costReport(renderer?: any): CostReport {
  const frames = live(frameMs, frameCount).sort((a, b) => a - b)
  const arrivals = live(arrivalMs, arrivalCount).sort((a, b) => a - b)
  const points = live(arrivalPoints, arrivalCount).sort((a, b) => a - b)

  const p50 = percentile(frames, 0.5)
  // An ABSOLUTE threshold, deliberately. A median-relative one was tried first and is
  // useless for before/after work: a change that takes the viewer from half rate to full
  // rate halves the median, halves the threshold with it, and reports *more* late frames
  // for a strictly better frame. 16.7 ms is the 60 fps line — a frame past it is one a
  // viewer on any common display notices, whatever the panel is running at.
  const lateThreshold = 16.7
  let lateCount = 0
  for (const ms of frames) if (ms > lateThreshold) lateCount++

  let arrivalTotal = 0
  for (const ms of arrivals) arrivalTotal += ms
  let pointTotal = 0
  for (const n of points) pointTotal += n

  const round = (value: number, digits = 2) => Number(value.toFixed(digits))

  return {
    frames: {
      n: frames.length,
      p50: round(p50),
      p95: round(percentile(frames, 0.95)),
      p99: round(percentile(frames, 0.99)),
      max: round(frames.length ? frames[frames.length - 1] : 0),
      lateCount,
      latePct: round(frames.length ? (100 * lateCount) / frames.length : 0, 1),
    },
    arrivals: {
      n: arrivals.length,
      p50: round(percentile(arrivals, 0.5)),
      p95: round(percentile(arrivals, 0.95)),
      max: round(arrivals.length ? arrivals[arrivals.length - 1] : 0),
      totalMs: round(arrivalTotal),
      medianPoints: Math.round(percentile(points, 0.5)),
      nsPerPoint: round(pointTotal ? (arrivalTotal * 1e6) / pointTotal : 0, 1),
    },
    shaders: programCounts(renderer),
  }
}

export function resetCost(): void {
  frameCount = 0
  frameCursor = 0
  arrivalCount = 0
  arrivalCursor = 0
  lastFrameAt = 0
  frameMs.fill(0)
  arrivalMs.fill(0)
  arrivalPoints.fill(0)
}
