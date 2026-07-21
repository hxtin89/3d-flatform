import { EXPERIENCE_CONFIG } from './config'

export type DensityBand = 'Overview p02' | 'Explore p10' | 'Detail p100'

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
 */
export class AdaptiveQualityController {
  private pressure = 1
  private pressureFloor = 1
  private lastUpdate = 0
  private sse = 256
  private band = BAND_SSE.length - 1

  /** Sticky: a band is only left once the range is a clear margin past its
   * edge, otherwise sitting on an edge oscillates the whole density level. */
  private bandSse(range: number): number {
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
  if (uri.includes('chunked-copc') || uri.includes('detail-p100')) return 'Detail p100'
  if (uri.includes('explore-p10')) return 'Explore p10'
  return 'Overview p02'
}

export function denserBand(a: DensityBand, b: DensityBand): DensityBand {
  const rank: Record<DensityBand, number> = {
    'Overview p02': 0,
    'Explore p10': 1,
    'Detail p100': 2,
  }
  return rank[b] > rank[a] ? b : a
}
