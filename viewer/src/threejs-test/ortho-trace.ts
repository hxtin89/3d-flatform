// A timeline of the drone ortho's loading, to find where the time goes: how long each gate
// held it back after the Start click, and per tile how long each step took, from the tile
// settling on screen to its composite being swapped in. Read it in the console with
// `__three.orthoTrace.report()`; `reset()` then `mark('start')` times a later view, e.g. a
// hotspot flight, the same way. `?orthocold` makes every ortho request skip the browser cache,
// as on a first visit. No DOM or three import, so ortho-upgrade.ts stays runnable under node.

/** Gates the upgrader's tick reports, several at once where they overlap. */
export type OrthoGate =
  /** Before the Start click, or while a camera flight runs. */
  | 'notAllowed'
  /** The basemap has tiles queued, downloading or parsing. */
  | 'basemapBusy'
  /** The worker is still loading its fields. */
  | 'workerStarting'
  /** Settled tiles are dwelling, nothing is in flight. */
  | 'dwelling'
  /** Ortho requests are queued beyond the few a loading basemap or point stream lets out. */
  | 'requestsCapped'
  /** Upgrades are fetching or composing. */
  | 'working'
  /** A finished composite waits because a tile arrived or was shown this frame. */
  | 'swapHeldByArrival'
  /** A finished composite waits for the view to hold still for settleMs, or for a flight to end. */
  | 'swapHeldByMotion'

export type TilePhase = 'seen' | 'picked' | 'granted' | 'fetched' | 'composed' | 'swapped' | 'abandoned'

export interface ChildFetch { ms: number; bytes: number; status: number }

export interface OrthoTrace {
  mark(name: string, at?: number): void
  gates(active: readonly OrthoGate[], at: number): void
  tile(key: string, phase: TilePhase, at?: number): void
  child(fetch: ChildFetch): void
  report(): object
  reset(): void
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])
}

export function createOrthoTrace(now: () => number = () => performance.now()): OrthoTrace {
  let marks = new Map<string, number>()
  let gateMs = new Map<OrthoGate, number>()
  let lastGateAt = -1
  let tiles = new Map<string, Partial<Record<TilePhase, number>>>()
  let children: ChildFetch[] = []
  const since = (t: number | undefined) => {
    const start = marks.get('start')
    return t === undefined || start === undefined ? null : Math.round(t - start) / 1000
  }
  return {
    mark(name, at = now()) {
      if (!marks.has(name)) marks.set(name, at)
    },
    gates(active, at) {
      // Time is booked to the gates of the tick it ends, and only after the Start click.
      if (marks.has('start') && lastGateAt >= 0) {
        const dt = Math.min(at - lastGateAt, 250)
        for (const gate of active) gateMs.set(gate, (gateMs.get(gate) ?? 0) + dt)
      }
      lastGateAt = at
    },
    tile(key, phase, at = now()) {
      let entry = tiles.get(key)
      if (!entry) {
        if (tiles.size >= 2000) return
        entry = {}
        tiles.set(key, entry)
      }
      if (entry[phase] === undefined) entry[phase] = at
    },
    child(fetch) {
      if (children.length < 4000) children.push(fetch)
    },
    report() {
      const step = (from: TilePhase, to: TilePhase) => {
        const values: number[] = []
        for (const entry of tiles.values()) {
          if (entry[from] !== undefined && entry[to] !== undefined) values.push(entry[to]! - entry[from]!)
        }
        return { n: values.length, p50: quantile(values, 0.5), p90: quantile(values, 0.9), max: quantile(values, 1) }
      }
      const milestones: Record<string, number | null> = {}
      for (const [name, at] of marks) milestones[name] = since(at)
      const gates: Record<string, number> = {}
      for (const [gate, ms] of gateMs) gates[gate] = Math.round(ms) / 1000
      const ok = children.filter((c) => c.status === 200)
      return {
        milestonesSecondsAfterStart: milestones,
        gateSecondsAfterStart: gates,
        tiles: {
          seen: tiles.size,
          swapped: [...tiles.values()].filter((e) => e.swapped !== undefined).length,
          abandoned: [...tiles.values()].filter((e) => e.abandoned !== undefined && e.swapped === undefined).length,
        },
        stepMs: {
          dwell: step('seen', 'picked'),
          queue: step('picked', 'granted'),
          network: step('granted', 'fetched'),
          worker: step('fetched', 'composed'),
          swapWait: step('composed', 'swapped'),
          settledToSwapped: step('seen', 'swapped'),
        },
        requests: {
          n: children.length,
          ok: ok.length,
          statuses: [...new Set(children.map((c) => c.status))],
          msP50: quantile(ok.map((c) => c.ms), 0.5),
          msP90: quantile(ok.map((c) => c.ms), 0.9),
          kbTotal: Math.round(ok.reduce((sum, c) => sum + c.bytes, 0) / 1024),
          fromCacheLikely: ok.filter((c) => c.ms < 8).length,
        },
      }
    },
    reset() {
      marks = new Map()
      gateMs = new Map()
      lastGateAt = -1
      tiles = new Map()
      children = []
    },
  }
}

/** The page's one trace: the upgrader, the requests and main.ts's Start click write to it. */
export const orthoTrace = createOrthoTrace()
