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
  /**
   * Multiplier the frame clock puts on the band. Above 1 coarsens under load, below 1
   * spends headroom the ladder leaves unused. Applied only while the feedback is
   * switched on; tracked either way, so the HUD can show what it would do.
   */
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
const MIN_SSE = 0.5
const FEEDBACK = EXPERIENCE_CONFIG.lod.qualityFeedback

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
 * Density is the camera-distance band, multiplied by a gain the frame clock sets.
 *
 * The band alone is open loop, and it mispredicts cost badly: the same 11.2M points
 * hold 60 fps looking straight down from 699 m and collapse to 12 fps from 80 m
 * tilted 31 degrees, because a tilted view draws near points as large quads. Distance
 * cannot see that. So the gain closes the loop — coarser when frames are slow, finer
 * when they are not — and `setFeedbackEnabled` turns it off for a fixed, reproducible
 * ladder when a measurement needs one.
 *
 * The tightening steps are fast and the relief step is slow on purpose. Streaming
 * takes seconds to answer a finer target, and asking for too much is visible while
 * asking for too little is not.
 */
export class AdaptiveQualityController {
  private pressure = 1
  private pressureFloor = 1
  private comfortableSamples = 0
  private tightenedAt = 0
  private feedback = false
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

  setFeedbackEnabled(enabled: boolean): void {
    if (enabled === this.feedback) return
    this.feedback = enabled
    // Switching off has to release the gain too, or the ladder would stay bent at
    // whatever the loop had last decided.
    if (!enabled) { this.pressure = Math.max(1, this.pressureFloor); this.comfortableSamples = 0 }
  }

  /**
   * Floor for the gain. A device the loader benchmark already found weak keeps its
   * bias and never asks for more than the ladder offers; anything else may.
   */
  private gainFloor(): number {
    return this.pressureFloor > 1 ? this.pressureFloor : FEEDBACK.minGain
  }

  update(sample: AdaptiveQualitySample): AdaptiveQualityState {
    const baseSse = this.bandSse(sample.cameraGroundRange)

    if (sample.now - this.lastUpdate >= 750) {
      this.lastUpdate = sample.now
      const hasFps = sample.fps > 0
      const floor = this.gainFloor()
      if ((hasFps && sample.fps < 45) || sample.visiblePoints > HARD_POINTS) {
        this.pressure = Math.min(FEEDBACK.maxGain, Math.max(this.pressure, 1) * 1.6)
        this.comfortableSamples = 0
        this.tightenedAt = sample.now
      } else if (hasFps && sample.fps < TARGET_FPS - 3) {
        this.pressure = Math.min(FEEDBACK.maxGain, Math.max(this.pressure, 1) * 1.25)
        this.comfortableSamples = 0
        this.tightenedAt = sample.now
      } else if (!hasFps || sample.fps >= TARGET_FPS) {
        if (this.pressure > 1) {
          // Give back what load took before asking for anything extra.
          this.pressure = Math.max(1, this.pressure * 0.85)
          this.comfortableSamples = 0
        } else {
          this.comfortableSamples++
          const settled = sample.now - this.tightenedAt >= FEEDBACK.reliefCooldownMs
          if (settled && this.comfortableSamples >= FEEDBACK.reliefSamples) {
            this.comfortableSamples = 0
            this.pressure = Math.max(floor, this.pressure * FEEDBACK.reliefStep)
          }
        }
      }
    }

    const gain = this.feedback ? this.pressure : 1
    this.sse = Math.min(MAX_SSE, Math.max(MIN_SSE, baseSse * gain))
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
