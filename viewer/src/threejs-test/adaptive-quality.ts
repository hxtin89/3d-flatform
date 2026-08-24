import { EXPERIENCE_CONFIG } from './config'

/** One-LOD-Tree bands, plus `APH d<n>` for Adaptive Point Hierarchy node depth. */
export type DensityBand = 'Overview p02' | 'Explore p10' | 'Detail p100' | `APH d${number}`

export interface AdaptiveQualitySample {
  now: number
  fps: number
  visiblePoints: number
  cameraGroundRange: number
}

export interface AdaptiveQualityState {
  sse: number
  baseSse: number
  pressure: number
  /** 0 = detail, 1 = explore, 2 = overview — chosen purely by camera height. */
  band: number
}

// Load is judged by frame time. Point counts are only a residency guard: a
// desktop GPU draws 13M points at 120fps, so a low point ceiling here throttles
// machines that are not under load at all.
const HARD_POINTS = 24_000_000
const TARGET_FPS = 58
const MAX_SSE = 512

const BAND_SSE = [
  EXPERIENCE_CONFIG.lod.detailSse,
  EXPERIENCE_CONFIG.lod.exploreSse,
  EXPERIENCE_CONFIG.lod.overviewSse,
]
/** Same ladder under its public name — a swapped-in single-density pack carries
 * the p02/p10/p100 nodes and needs these targets, not the APH ones. */
export const ONE_LOD_BAND_SSE: readonly number[] = BAND_SSE
/** Same bands against the Adaptive Point Hierarchy, whose nodes are far denser. */
export const APH_BAND_SSE = [
  EXPERIENCE_CONFIG.lod.aphDetailSse,
  EXPERIENCE_CONFIG.lod.aphExploreSse,
  EXPERIENCE_CONFIG.lod.aphOverviewSse,
]
const BAND_EDGES = [
  EXPERIENCE_CONFIG.lod.detailMaxHeightM,
  EXPERIENCE_CONFIG.lod.exploreMaxHeightM,
]
const BAND_HYSTERESIS = EXPERIENCE_CONFIG.lod.bandHysteresis

/**
 * Density is a pure function of camera distance. The controller additionally
 * tracks a `pressure` value from frame time, which callers spend on the cheap
 * knobs — vignette mask, parrot count, cloud quality, view distance — never on
 * point density.
 *
 * NOTE (2026-08-24): nothing currently reads `pressure`. The only two reads of the
 * returned state anywhere are `.sse` and `.band`, `pressureFloor` feeds only
 * `pressure`, and `this.sse` below has no pressure term — so the three
 * `setPressureFloor` calls in main.ts are no-ops and the value is computed and
 * dropped. Left in place rather than removed: it is the intended hook for the cheap
 * knobs above and it costs a few arithmetic ops per 750 ms.
 *
 * Wiring it to the *SSE* instead was tried and reverted. On a vsync-capped display
 * "frames are at target" carries no information about remaining headroom, so the loop
 * walks the target down until it hurts, pulls back, and the resolution visibly pulses
 * even with a still camera. That route needs an uncapped timing signal, not fps.
 */
export class AdaptiveQualityController {
  private pressure = 1
  private pressureFloor = 1
  private lastUpdate = 0
  private sse = 256
  private band: number
  private ladder: readonly number[]

  constructor(ladder: readonly number[] = BAND_SSE) {
    this.ladder = ladder
    this.band = ladder.length - 1
    this.sse = ladder[this.band]
  }

  /** The ladder belongs to the streamed tree, not to the session: a live pack
   * swap moves between the APH targets (4/8/16) and the One-LOD ones (64/124/256).
   * Band edges and hysteresis are untouched — the band stays a pure function of
   * camera distance. */
  setLadder(ladder: readonly number[]): void {
    if (ladder.length === 0) return
    this.ladder = ladder
    this.band = Math.min(this.band, ladder.length - 1)
  }

  /** Sticky: a band is only left once the range is a clear margin past its
   * edge, otherwise sitting on an edge oscillates the whole density level. */
  private bandSse(range: number): number {
    const BAND_SSE = this.ladder
    if (!Number.isFinite(range)) {
      this.band = BAND_SSE.length - 1
      return BAND_SSE[this.band]
    }
    while (this.band < BAND_EDGES.length && range > BAND_EDGES[this.band] * (1 + BAND_HYSTERESIS)) {
      this.band++
    }
    while (this.band > 0 && range < BAND_EDGES[this.band - 1] * (1 - BAND_HYSTERESIS)) {
      this.band--
    }
    return BAND_SSE[this.band]
  }

  /** Bias from the loader benchmark, so weak hardware starts with the cheap
   * knobs already turned down instead of discovering its limits through jank. */
  setPressureFloor(floor: number): void {
    this.pressureFloor = Math.min(4, Math.max(1, floor))
    this.pressure = Math.max(this.pressure, this.pressureFloor)
  }

  update(sample: AdaptiveQualitySample): AdaptiveQualityState {
    const baseSse = this.bandSse(sample.cameraGroundRange)

    if (sample.now - this.lastUpdate >= 750) {
      this.lastUpdate = sample.now
      const hasFps = sample.fps > 0
      if ((hasFps && sample.fps < 45) || sample.visiblePoints > HARD_POINTS) {
        this.pressure = Math.min(4, this.pressure * 1.6)
      } else if (hasFps && sample.fps < TARGET_FPS - 3) {
        this.pressure = Math.min(4, this.pressure * 1.25)
      } else if (!hasFps || sample.fps >= TARGET_FPS) {
        this.pressure = Math.max(this.pressureFloor, this.pressure * 0.85)
      }
    }

    this.sse = Math.min(MAX_SSE, baseSse)
    return { sse: this.sse, baseSse, pressure: this.pressure, band: this.band }
  }
}

export function densityBandForUri(uri: string): DensityBand {
  // Adaptive Point Hierarchy: one continuous quadtree, so the p02/p10/p100 band
  // names do not apply. Report the node depth instead of silently mislabelling
  // an overview tile as "Detail p100".
  const adaptiveDepth = /\/d(\d+)_q/.exec(uri)
  if (adaptiveDepth) return `APH d${Number(adaptiveDepth[1])}`
  if (/\/z0\/z0_x\d+_y\d+\.pnts/.test(uri)) return 'APH d0'
  if (uri.includes('chunked-copc') || uri.includes('detail-p100')) return 'Detail p100'
  if (uri.includes('explore-p10')) return 'Explore p10'
  return 'Overview p02'
}

export function denserBand(a: DensityBand, b: DensityBand): DensityBand {
  return bandRank(b) > bandRank(a) ? b : a
}

function bandRank(band: DensityBand): number {
  // APH depth outranks every One-LOD band; the two never appear together.
  const depth = /^APH d(\d+)$/.exec(band)
  if (depth) return 10 + Number(depth[1])
  if (band === 'Detail p100') return 2
  if (band === 'Explore p10') return 1
  return 0
}
