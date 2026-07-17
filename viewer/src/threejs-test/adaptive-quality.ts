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
}

// CPU/GPU caches are hard-bounded elsewhere. These are emergency residency
// thresholds for currently visible points, not a desktop-vs-mobile budget.
const TARGET_POINTS = 4_000_000
const EMERGENCY_POINTS = 5_500_000
const RECOVERY_POINTS = 3_500_000
const TARGET_FPS = 58
const MAX_SSE = 512

/** Same camera bands as the One LOD Tree UX, expressed as ground range. */
export function baseSseForRange(range: number): number {
  if (!Number.isFinite(range) || range > 12_000) return 256
  if (range > 2_500) return 124
  return 64
}

/**
 * Device-agnostic feedback controller. Every device gets the same UI and data
 * tree; slower hardware automatically trades refinement for stable frame time.
 */
export class AdaptiveQualityController {
  private pressure = 1
  private pressureFloor = 1
  private lastUpdate = 0
  private sse = 256

  /** Measured-device bias (loader benchmark): weak hardware starts and stays
   * at a coarser refinement level instead of discovering it through jank. */
  setPressureFloor(floor: number): void {
    this.pressureFloor = Math.min(4, Math.max(1, floor))
    this.pressure = Math.max(this.pressure, this.pressureFloor)
  }

  update(sample: AdaptiveQualitySample): AdaptiveQualityState {
    const baseSse = baseSseForRange(sample.cameraGroundRange)

    if (sample.now - this.lastUpdate >= 750) {
      this.lastUpdate = sample.now
      if (sample.visiblePoints > EMERGENCY_POINTS || (sample.fps > 0 && sample.fps < 45)) {
        this.pressure = Math.min(4, this.pressure * 1.6)
      } else if (sample.visiblePoints > TARGET_POINTS || (sample.fps > 0 && sample.fps < TARGET_FPS - 3)) {
        this.pressure = Math.min(4, this.pressure * 1.25)
      } else if (sample.visiblePoints < RECOVERY_POINTS && sample.fps >= TARGET_FPS) {
        this.pressure = Math.max(this.pressureFloor, this.pressure * 0.85)
      }
    }

    this.sse = Math.min(MAX_SSE, Math.max(baseSse, baseSse * this.pressure))
    return { sse: this.sse, baseSse, pressure: this.pressure }
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
