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
  frameOrdinal++
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

/**
 * What the GPU upload costs, split into first uploads and re-uploads.
 *
 * This is the one cost none of the other instruments can see. `recordArrival` times the
 * `load-model` handler, but the upload does not happen there — three creates the GPU
 * buffer lazily, on the first frame the tile is actually drawn, *inside the render pass*
 * (Renderer._renderObjectDirect calls _geometries.updateForRender before it ever asks
 * whether there is anything to draw). So it lands in the frame distribution as an
 * unexplained spike and nowhere else.
 *
 * The split matters more than the total. A *first* upload is capped: `maxParses` lets at
 * most two tiles arrive per frame. A *re-upload* is not capped by anything — UnloadTilesPlugin
 * disposes the GPU buffers of a tile that has been out of view for its delay, while the CPU
 * arrays survive, so when the camera swings back there is no re-download, no re-parse, and
 * therefore no queue: every returning tile re-creates its buffers in the same frame. If
 * `reuploads` is large next to `first`, that is the path to fix, and lowering maxParses
 * would do nothing for it.
 *
 * Attributes.update is the single chokepoint every upload passes through, and it already
 * distinguishes the two cases: `data.version === undefined` means the buffer does not exist
 * yet. A WeakSet then separates "never uploaded" from "uploaded before and disposed since".
 */
let uploadProbeInstalled = false
let firstMs = 0
let firstBytes = 0
let firstCount = 0
let reMs = 0
let reBytes = 0
let reCount = 0
let worstUploadFrameMs = 0
let uploadFrameMs = 0
let uploadFrameAt = -1
let frameOrdinal = 0

/**
 * Wrap the renderer's attribute upload. Safe to call more than once, and a no-op if the
 * backend does not expose `_attributes` — these are r185 internals, not public API, and a
 * measurement must never be the thing that breaks the app.
 */
export function installUploadProbe(renderer: any): boolean {
  if (uploadProbeInstalled) return true
  const attributes = renderer?._attributes
  if (!attributes || typeof attributes.update !== 'function') return false
  const original = attributes.update.bind(attributes)
  const seen = new WeakSet<object>()
  attributes.update = (attribute: any, type: number) => {
    let fresh = false
    try { fresh = attributes.get(attribute)?.version === undefined } catch { fresh = false }
    if (!fresh) return original(attribute, type)
    const startedAt = performance.now()
    original(attribute, type)
    const ms = performance.now() - startedAt
    const bytes = attribute?.array?.byteLength ?? 0
    // Same rAF turn as the previous upload? Then they share a frame, and it is the sum
    // that the viewer feels, not the individual call.
    if (uploadFrameAt !== frameOrdinal) { uploadFrameAt = frameOrdinal; uploadFrameMs = 0 }
    uploadFrameMs += ms
    if (uploadFrameMs > worstUploadFrameMs) worstUploadFrameMs = uploadFrameMs
    if (seen.has(attribute)) {
      reMs += ms; reBytes += bytes; reCount++
    } else {
      seen.add(attribute)
      firstMs += ms; firstBytes += bytes; firstCount++
    }
  }
  // The pulled dot feed uploads each tile as a texture rather than as attributes, so it
  // would read as free above. Its point-data textures are counted the same way: timed, by
  // bytes, and split into first uploads and re-uploads (after the unload plugin freed the
  // GPU copy of a hidden tile). Other textures — imagery, noise — are left out, so the
  // numbers stay the point cloud's.
  const textures = renderer?._textures
  if (textures && typeof textures.updateTexture === 'function') {
    const originalTexture = textures.updateTexture.bind(textures)
    const seenTextures = new WeakSet<object>()
    textures.updateTexture = (texture: any, options: any) => {
      if (!texture?.userData?.cloudPointData) return originalTexture(texture, options)
      let pending = true
      try {
        const data = textures.get(texture)
        pending = !(data?.initialized === true && data?.version === texture.version)
      } catch { pending = true }
      if (!pending) return originalTexture(texture, options)
      const startedAt = performance.now()
      const result = originalTexture(texture, options)
      const ms = performance.now() - startedAt
      const bytes = texture?.image?.data?.byteLength ?? 0
      if (uploadFrameAt !== frameOrdinal) { uploadFrameAt = frameOrdinal; uploadFrameMs = 0 }
      uploadFrameMs += ms
      if (uploadFrameMs > worstUploadFrameMs) worstUploadFrameMs = uploadFrameMs
      if (seenTextures.has(texture)) {
        reMs += ms; reBytes += bytes; reCount++
      } else {
        seenTextures.add(texture)
        firstMs += ms; firstBytes += bytes; firstCount++
      }
      return result
    }
  }
  uploadProbeInstalled = true
  return true
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
  /** GPU uploads, split by whether the attribute had ever been uploaded before. */
  uploads: {
    installed: boolean
    /** Buffers created for an attribute never seen before — capped by maxParses. */
    firstCount: number
    firstMs: number
    firstMB: number
    /** Buffers re-created after UnloadTilesPlugin disposed them — capped by nothing. */
    reCount: number
    reMs: number
    reMB: number
    /** The worst single frame's total upload time, summed across attributes. */
    worstFrameMs: number
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
    uploads: {
      installed: uploadProbeInstalled,
      firstCount,
      firstMs: round(firstMs),
      firstMB: round(firstBytes / 1e6),
      reCount,
      reMs: round(reMs),
      reMB: round(reBytes / 1e6),
      worstFrameMs: round(worstUploadFrameMs),
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
  // The probe stays installed — only its counters reset. Re-wrapping would stack wrappers.
  firstMs = 0; firstBytes = 0; firstCount = 0
  reMs = 0; reBytes = 0; reCount = 0
  worstUploadFrameMs = 0; uploadFrameMs = 0; uploadFrameAt = -1
}
