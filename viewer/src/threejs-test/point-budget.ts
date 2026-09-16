import * as THREE from 'three'

import { EXPERIENCE_CONFIG } from './config.ts'

/**
 * A ceiling on how many points a frame may select, held by coarsening the tiles that
 * buy the least.
 *
 * The lever is the same multiplication foveation uses: a tile refines while its
 * projected error exceeds `tiles.errorTarget`, so dividing that tile's error by a
 * factor is the same as raising the target for that tile alone. Nothing here touches
 * the target itself, so the one-error-target design survives intact and this composes
 * with foveation, the view-angle and the view-depth corrections by plain multiplication.
 *
 * **Why this is also the "fill outward from the camera" the budget was asked for.** The
 * error the traversal tests is a tile's point spacing divided by its distance, so
 * ordering the candidate refinements by error *is* ordering them from the camera
 * outward. Taking candidates in that order until the budget runs out therefore selects
 * exactly the set one error target would have selected — the two are the same frontier,
 * and the target is the cheaper way to say it. No second traversal, no priority queue.
 *
 * **Why it stops the download too.** A tile that fails the error test is never marked
 * used, so it is never queued, fetched, parsed or uploaded, and it drains out of the
 * LRU cache on the next pass. The budget is a limit on the pipeline, not a curtain
 * drawn over work that happened anyway.
 *
 * The cost of a refinement is known before anything is fetched: the pipeline writes
 * `extras.aph.emittedPointCount` on every node of the published tileset — verified
 * against the deployed peru-b2-globe pack, where all 184 tiles of a z0 document carry
 * it. So the solver below works on real point counts rather than on an estimate that
 * would have to be corrected after the bytes had already crossed the network.
 */

/**
 * What the slider means.
 *
 * `ceiling` may only ever coarsen: a view that comes in under the budget is left at the
 * spacing the SSE slider asked for, and the headroom goes unspent. `fill` treats the
 * budget as a level to reach, refining *past* the SSE slider until the count is met,
 * which spends every point but draws the near field finer than the size curve was tuned
 * against. A/B, because that is a look decision.
 */
export type PointBudgetMode = 'ceiling' | 'fill'

export interface PointBudgetSettings {
  enabled: boolean
  /** The cap itself, in points selected per frame. */
  maxPoints: number
  mode: PointBudgetMode
  /**
   * Take the shortfall out of the far field first. Off spreads it evenly across the
   * frame, which is what a plain error target does.
   *
   * Worth being honest about: `sbb/one-sse` deleted a camera-range SSE ladder because it
   * counted distance twice over an error quotient that already divides by it. This is
   * not that ladder. It does not decide the quality of a view — it decides where a
   * *shortfall* is taken from once the budget binds, and it is inert whenever the frame
   * fits. The distance thinning's near/far ramp is the same idea on the draw side, and
   * that one survived measurement.
   */
  farFirst: boolean
  /** Nearer than this, a tile takes only `nearShare` of the coarsening. */
  nearM: number
  /** Beyond this, a tile takes all of it. */
  farM: number
  /**
   * The near field's share of the coarsening while far-first is on.
   *
   * Not zero: with a hard zero the near field can never be coarsened at all, so a view
   * that is still over budget with the whole far field already flattened has nowhere
   * left to go and the cap simply fails. A quarter share keeps the near field moving
   * four times slower than the horizon rather than not at all.
   */
  nearShare: number
}

/**
 * One refinement decision the traversal offered, as the solver sees it.
 *
 * `error` is the error of the tile whose test decides this — the parent, for points
 * drawn because their parent refined — taken *before* this module scaled it. `weight`
 * is that tile's share of the coarsening, 0 for a tile the ramp protects entirely.
 * `points` is what enters the frame if the decision goes the refining way.
 */
export interface BudgetSample {
  error: number
  weight: number
  points: number
  /** Which half of the cost this is: points the traversal has already selected, or points it
   *  would select one step further down. Diagnostics only — the solver treats both alike. */
  kind?: BudgetSampleKind
}

/** `selected` is in the frame now; `candidate` is the next step down, which only `fill` reaches for. */
export type BudgetSampleKind = 'selected' | 'candidate'

/**
 * The pressure at which this decision flips from refine to stop.
 *
 * A sample is in the frame while `error / (1 + pressure * weight) > errorTarget`, which
 * rearranges to `pressure < (error / errorTarget - 1) / weight`. Every sample therefore
 * has one number at which it leaves, and the whole budget becomes a walk along a sorted
 * list rather than a search.
 *
 * A zero weight means the ramp protects this tile completely, so it never leaves and
 * never arrives: +Infinity when it is already in, -Infinity when it is already out.
 */
export function dropoutPressure(sample: BudgetSample, errorTarget: number): number {
  if (!(errorTarget > 0) || !Number.isFinite(sample.error)) return Number.POSITIVE_INFINITY
  if (!(sample.weight > 0)) {
    return sample.error > errorTarget ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  }
  return (sample.error / errorTarget - 1) / sample.weight
}

/** Points the traversal would select at this pressure. Monotonically decreasing in it. */
export function selectedPoints(
  samples: readonly BudgetSample[],
  errorTarget: number,
  pressure: number,
  fixedPoints = 0,
): number {
  let total = fixedPoints
  for (const sample of samples) {
    if (dropoutPressure(sample, errorTarget) > pressure) total += sample.points
  }
  return total
}

export interface PressureSolution {
  /** The least pressure — i.e. the most detail — that fits the budget. */
  pressure: number
  /** What that pressure selects. */
  points: number
  /**
   * False when even `maxPressure` cannot get under the budget, which means the frame is
   * held up by content no multiplier can remove: the overview roots, and anything whose
   * parent refines unconditionally. Reported rather than hidden, because the honest
   * answer to "why is it over the cap" is sometimes "this view cannot go lower".
   */
  reachable: boolean
}

/**
 * Solve for the least pressure whose selection fits the budget.
 *
 * Exact, and one sort: every sample leaves at a known pressure, so sorting those
 * pressures and walking them removes the samples in the order a rising pressure would
 * have removed them anyway. O(n log n) over the tiles one traversal touched — hundreds,
 * not millions.
 */
export function solvePressure(
  samples: readonly BudgetSample[],
  opts: {
    errorTarget: number
    budget: number
    fixedPoints?: number
    minPressure?: number
    maxPressure?: number
  },
): PressureSolution {
  const { errorTarget, budget } = opts
  const fixedPoints = opts.fixedPoints ?? 0
  const minPressure = opts.minPressure ?? 0
  const maxPressure = opts.maxPressure ?? 64

  // Everything still standing at the finest pressure allowed, with the exit price of
  // each. Samples already gone at that pressure never enter the walk.
  const exits: { at: number; points: number }[] = []
  let points = fixedPoints
  for (const sample of samples) {
    const at = dropoutPressure(sample, errorTarget)
    if (!(at > minPressure)) continue
    points += sample.points
    if (at <= maxPressure) exits.push({ at, points: sample.points })
  }
  if (points <= budget) return { pressure: minPressure, points, reachable: true }

  exits.sort((a, b) => a.at - b.at)
  for (const exit of exits) {
    points -= exit.points
    if (points <= budget) return { pressure: exit.at, points, reachable: true }
  }
  return { pressure: maxPressure, points, reachable: false }
}

/**
 * Ease the applied pressure toward the solved one, in real time rather than per frame.
 *
 * Asymmetric on purpose. Tightening is what keeps the promise the slider makes, so it is
 * quick; loosening only gives detail back, so it is slow — and a slow release is what
 * stops the pressure oscillating around a view sitting right on the cap, where every
 * relaxation immediately pulls the count back over it.
 */
export function easePressure(
  current: number,
  wanted: number,
  dtMs: number,
  riseMs: number,
  fallMs: number,
): number {
  if (!(dtMs > 0)) return current
  const tau = wanted > current ? riseMs : fallMs
  if (!(tau > 0)) return wanted
  const next = current + (wanted - current) * (1 - Math.exp(-dtMs / tau))
  // Snap over the last half percent, because an exponential never arrives and the
  // solved pressure is the exact point at which one tile leaves the frame. Stopping a
  // hair below it keeps that tile, so the cap settles permanently over the number on the
  // slider — measured at 1,557,741 points against a 1.5M cap, one boundary tile's worth.
  return Math.abs(wanted - next) <= Math.max(Math.abs(wanted), 1) * 0.005 ? wanted : next
}

export interface PointBudgetStats {
  /** Points the next traversal selects at the pressure now applied. */
  predicted: number
  /** What the solver asked for this frame, before the ease. */
  wanted: number
  applied: number
  /** Refinement decisions the traversal offered. */
  samples: number
  /** Points nothing here can remove — overview roots and unconditional refinements. */
  fixed: number
  reachable: boolean
  /** What the applied pressure resolves to, as error targets the HUD can print. */
  nearSse: number
  farSse: number
}

export interface PointBudget {
  settings: PointBudgetSettings
  /** Solve and ease for the next traversal. Call after `tiles.update()`. */
  update(dtMs: number, errorTarget: number): PointBudgetStats
  /** The decisions the last solve ran on. Diagnostics: it is the array itself, not a copy. */
  samplesSnapshot(): readonly BudgetSample[]
  stats(): PointBudgetStats
  dispose(): void
}

const EMPTY_STATS: PointBudgetStats = {
  predicted: 0, wanted: 0, applied: 0, samples: 0, fixed: 0,
  reachable: true, nearSse: 0, farSse: 0,
}

/** Reused by the point estimate, which runs once per tile and never per frame. */
const estimateBox = new THREE.Box3()
const estimateObb = new THREE.Matrix4()
const estimateSize = new THREE.Vector3()

/** Reused by the far-first ramp, which runs once per in-view tile per traversal. */
const weightBox = new THREE.Box3()
const weightObb = new THREE.Matrix4()
const weightCentre = new THREE.Vector3()

export function createPointBudget(tiles: any, settings: PointBudgetSettings): PointBudget {
  const tuning = EXPERIENCE_CONFIG.lod.budget
  /** Raw error, before this module divided it — the number the solver reasons about. */
  const rawError = new WeakMap<object, number>()
  const tileWeight = new WeakMap<object, number>()
  const pointCount = new WeakMap<object, number>()
  /** Tiles the traversal looked at this frame, and the same set for membership tests. */
  let visited: any[] = []
  let visitedSet = new WeakSet<object>()
  let pressure = 0
  let lastStats: PointBudgetStats = EMPTY_STATS
  let lastSamples: BudgetSample[] = []

  /**
   * How far away this tile's content is, for the far-first ramp only.
   *
   * Deliberately *not* `distanceFromCamera`, which the renderer measures to the nearest
   * point of the bounding volume. APH boxes are the union of a node with its whole
   * subtree, so a 2 km z0 cell reads as a few metres away whenever the camera stands
   * anywhere over it. Measured at the arrival view: every one of the 14 selected tiles
   * reported between 7 and 26 m, so every tile took the near share and far-first
   * collapsed into "uniform, four times slower". By the centre the same tiles run 64 m
   * to 500 m, and the 2 km overview cell sits at 235 m where it belongs.
   *
   * The centre is not perfect either — half of a large cell lies beyond it — but it is
   * the cheapest measure that distinguishes a tile over there from a tile under you,
   * which is the whole job of the ramp.
   */
  function contentDistance(tile: any, fallback: number): number {
    const volume = tile?.engineData?.boundingVolume
    const cameras = tiles.cameraInfo
    if (!volume || !cameras || cameras.length === 0) return fallback
    volume.getOBB(weightBox, weightObb)
    weightBox.getCenter(weightCentre).applyMatrix4(weightObb)
    let nearest = Infinity
    for (let i = 0; i < cameras.length; i++) {
      nearest = Math.min(nearest, weightCentre.distanceTo(cameras[i].position))
    }
    return Number.isFinite(nearest) ? nearest : fallback
  }

  /**
   * How much of the coarsening this tile takes: 0 leaves it exactly where the error
   * target put it, 1 gives it the full share.
   */
  function weightFor(tile: any, boxDistance: number): number {
    if (!settings.farFirst) return 1
    const distance = contentDistance(tile, boxDistance)
    if (!Number.isFinite(distance)) return 1
    const far = Math.max(settings.farM, settings.nearM + 1)
    const ramp = THREE.MathUtils.smoothstep(distance, settings.nearM, far)
    return settings.nearShare + (1 - settings.nearShare) * ramp
  }

  /**
   * This tile's own point count, from the tileset rather than from the tile.
   *
   * The pipeline publishes `extras.aph.emittedPointCount` on every node, so the common
   * path is a lookup and the budget can be spent before a single byte is fetched. The
   * estimate below only catches tilesets carrying no such metadata (the `?tree=one-lod`
   * comparison route): `geometricError` is a fixed multiple of the mean point spacing,
   * so the footprint over that spacing squared is the count.
   *
   * A tile whose content is another tileset document holds no points at all and must not
   * be given the estimate — it would invent a tile's worth of points at every z0 seam.
   */
  function pointsFor(tile: any): number {
    const cached = pointCount.get(tile)
    if (cached !== undefined) return cached
    let points = 0
    const emitted = tile?.extras?.aph?.emittedPointCount
    const uri: string = tile?.content?.uri ?? tile?.content?.url ?? ''
    if (typeof emitted === 'number' && emitted > 0) {
      points = emitted
    } else if (!tile?.content || /\.json(?:[?#]|$)/i.test(uri)) {
      points = 0
    } else {
      const error = typeof tile?.geometricError === 'number' ? tile.geometricError : 0
      const spacing = error > 0 ? error / EXPERIENCE_CONFIG.lod.pointSize.geometricErrorScale : 0
      const volume = tile?.engineData?.boundingVolume
      if (spacing > 0 && volume) {
        volume.getOBB(estimateBox, estimateObb)
        estimateBox.getSize(estimateSize)
        const area = estimateSize.x * estimateSize.y
        points = area > 1e-6 ? Math.round(area / (spacing * spacing)) : tuning.fallbackTilePoints
      } else {
        points = tuning.fallbackTilePoints
      }
    }
    pointCount.set(tile, points)
    return points
  }

  // Wrap whatever is installed rather than the prototype: foveation and the two error
  // corrections may already be here, and all four are plain multipliers on the error, so
  // they compose in any order. Installed last in main.ts, so the errors collected here
  // are the ones refinement actually judges the tiles by.
  const previous = tiles.calculateTileViewError.bind(tiles)
  const wrapper = (tile: any, target: any): void => {
    previous(tile, target)
    if (!settings.enabled || !target.inView) return
    const weight = weightFor(tile, target.distanceFromCamera)
    rawError.set(tile, target.error)
    tileWeight.set(tile, weight)
    visited.push(tile)
    visitedSet.add(tile)
    const scale = 1 + pressure * weight
    if (scale > 0 && scale !== 1) target.error /= scale
  }
  tiles.calculateTileViewError = wrapper

  return {
    settings,
    stats: () => lastStats,
    samplesSnapshot: () => lastSamples,
    update(dtMs: number, errorTarget: number): PointBudgetStats {
      const seen = visited
      visited = []
      visitedSet = new WeakSet<object>()
      if (!settings.enabled) {
        pressure = 0
        lastStats = { ...EMPTY_STATS, nearSse: errorTarget, farSse: errorTarget }
        return lastStats
      }

      const samples: BudgetSample[] = []
      let fixed = 0
      for (const tile of seen) {
        const points = pointsFor(tile)
        const parent = tile.parent
        const parentError = parent ? rawError.get(parent) : undefined
        if (points > 0) {
          // A tile whose parent links to another tileset document is drawn whatever the
          // error says — the traversal refines through a document boundary
          // unconditionally — as is a root. Those points are the floor the budget is
          // measured against, not something it can bargain with.
          const gated = parentError !== undefined && !parent?.internal?.hasUnrenderableContent
          if (gated) {
            samples.push({ error: parentError, weight: tileWeight.get(parent) ?? 1, points, kind: 'selected' })
          } else {
            fixed += points
          }
        }
        // Where refinement stopped *because the error said so*, the next step down is a
        // candidate: what reaching one level deeper there would cost.
        //
        // That qualifier is the whole rule, and both halves of it were measured at the
        // arrival view on 2026-09-16.
        //
        // Without it, the cost at the *current* pressure is inflated by children that
        // will never be selected: 16 tiles stopped for reasons the error does not express
        // — the load-region mask, a child not yet processed — and offered 3,910,733
        // points on top of a frame of 2,086,990. Those children never arrive however long
        // the view is held, and budgeting against them made a 2M cap settle a frame of
        // 795k, 60% under the slider.
        //
        // But dropping the candidates altogether breaks the other side of the curve. The
        // sample list only describes the frame the traversal walked, so once a pressure
        // has removed a subtree, nothing left in the list says what putting it back would
        // cost — the solver reads a release as free, the frame grows again, and the two
        // chase each other around a two-frame cycle a few percent above the cap
        // (measured: a 1M cap alternating 795,053 / 1,095,053, pressure swinging 2.12).
        //
        // A tile that stopped on its error is exactly the shadow of what a higher
        // pressure removed: same error, same points, so `cost` below the live pressure
        // comes out right, while a tile blocked by anything else contributes nothing.
        const children: any[] | undefined = tile.children
        if (!Array.isArray(children) || children.length === 0) continue
        const ownError = rawError.get(tile)
        if (ownError === undefined) continue
        const ownWeight = tileWeight.get(tile) ?? 1
        if (ownError / (1 + pressure * ownWeight) > errorTarget) continue
        let refined = false
        for (const child of children) {
          if (visitedSet.has(child)) { refined = true; break }
        }
        if (refined) continue
        let childPoints = 0
        for (const child of children) childPoints += pointsFor(child)
        if (childPoints > 0) {
          samples.push({
            error: ownError,
            weight: ownWeight,
            points: childPoints,
            kind: 'candidate',
          })
        }
      }

      lastSamples = samples
      // What the frame costs at the pressure now in force — the same arithmetic the HUD
      // reports, and the test for whether the cap is currently being kept.
      const costNow = selectedPoints(samples, errorTarget, pressure, fixed)
      const overBudget = costNow > settings.maxPoints
      const solution = solvePressure(samples, {
        errorTarget,
        budget: settings.maxPoints,
        fixedPoints: fixed,
        /**
         * While the frame is over the cap, the pressure may only rise.
         *
         * The sample set only describes the frame the traversal actually walked: the
         * tiles a higher pressure removed are not in it, because traversal stopped above
         * them. Solving from zero therefore reads a release as cheaper than it is, the
         * frame grows back, and the two settle against each other a few percent over the
         * slider — measured at 1,557,741 points against a 1.5M cap, steady, with the
         * pressure wobbling 0.28 either side of 13.8. Releasing only from a frame that
         * already fits removes that floor: the cost of loosening is then something the
         * next traversal measures rather than something this one guesses.
         */
        minPressure: overBudget ? pressure : (settings.mode === 'fill' ? tuning.minPressure : 0),
        maxPressure: tuning.maxPressure,
      })
      // A deadband on the release only. Tightening always happens, because that is the
      // promise the slider makes; loosening waits until the solver has asked for a
      // meaningfully lower pressure, so a view sitting exactly on the cap does not
      // breathe in and out.
      const wanted = solution.pressure > pressure || solution.pressure < pressure * tuning.releaseDeadband
        ? solution.pressure
        : pressure
      pressure = easePressure(pressure, wanted, dtMs, tuning.riseMs, tuning.fallMs)
      if (Math.abs(pressure) < 1e-4) pressure = 0

      lastStats = {
        predicted: selectedPoints(samples, errorTarget, pressure, fixed),
        wanted: solution.pressure,
        applied: pressure,
        samples: samples.length,
        fixed,
        reachable: solution.reachable,
        nearSse: errorTarget * (1 + pressure * (settings.farFirst ? settings.nearShare : 1)),
        farSse: errorTarget * (1 + pressure),
      }
      return lastStats
    },
    dispose() {
      // Only unwind if nothing else wrapped us in the meantime.
      if (tiles.calculateTileViewError === wrapper) tiles.calculateTileViewError = previous
    },
  }
}
