import { EXPERIENCE_CONFIG } from './config'

/** One-LOD-Tree bands, plus `APH d<n>` for Adaptive Point Hierarchy node depth. */
export type DensityBand = 'Overview p02' | 'Explore p10' | 'Detail p100' | `APH d${number}`

export interface AdaptiveQualitySample {
  /** Slant range to the ground ahead, plus any distance outside the survey. */
  cameraGroundRange: number
}

export interface AdaptiveQualityState {
  sse: number
  /** 0 = detail, 1 = explore, 2 = overview — chosen purely by camera distance. */
  band: number
}

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
 * Density is a pure function of camera distance.
 *
 * There used to be a frame-time `pressure` term here as well, said to be spent on the
 * cheap knobs — vignette mask, parrot count, cloud quality, view distance. Nothing ever
 * read it: it was computed every 750 ms, clamped, returned, and dropped. Connecting it
 * was tried and reverted, because on a vsync-capped display "frames are at target" says
 * nothing about remaining headroom, so the loop walks down until it hurts and the
 * resolution visibly pulses with a still camera. If it comes back it needs an uncapped
 * timing signal, not fps.
 */
export class AdaptiveQualityController {
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

  update(sample: AdaptiveQualitySample): AdaptiveQualityState {
    this.sse = this.bandSse(sample.cameraGroundRange)
    return { sse: this.sse, band: this.band }
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
