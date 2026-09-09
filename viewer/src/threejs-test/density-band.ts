/**
 * Naming the density level a loaded tile came from — for the HUD, and for the
 * false-colour debug views that paint the same level onto the points themselves.
 *
 * This is a read-out, not a decision: refinement is governed entirely by
 * `tiles.errorTarget` against each tile's projected point spacing (see
 * config.lod.sse). The band ladder that used to live here — three screen-space
 * error targets chosen by camera range, plus a frame-time "pressure" value that
 * nothing ever read — is gone. It counted distance a second time on top of the
 * error quotient, which already divides by distance.
 */

/** One-LOD-Tree bands, plus `APH d<n>` for Adaptive Point Hierarchy node depth. */
export type DensityBand = 'Overview p02' | 'Explore p10' | 'Detail p100' | `APH d${number}`

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

/**
 * The level index the debug views and the isolate switch work in: APH node depth, or
 * 0/1/2 for the One-LOD tiers. Unlike `bandRank` this is not a comparison key — it is
 * the number shown in the panel and typed into the isolate slider, so it stays the
 * depth the tile URI actually carries. The two ladders never appear together.
 */
export function densityLevel(band: DensityBand): number {
  const depth = /^APH d(\d+)$/.exec(band)
  if (depth) return Number(depth[1])
  if (band === 'Detail p100') return 2
  if (band === 'Explore p10') return 1
  return 0
}

/**
 * False colour for the level view, coarse to fine.
 *
 * A monotonic cool-to-warm ramp rather than an arbitrary categorical set: depth then
 * reads as a direction, so an evenly refined frame is one colour and a level boundary
 * is a step *along* the ramp instead of two unrelated hues meeting. Adjacent entries
 * are still clearly different, which a smooth thirteen-stop gradient would not be.
 *
 * Plain hex, and here rather than in TSL, because the panel legend draws from the same
 * array — a swatch built from a second definition is a legend that can lie.
 */
export const DENSITY_LEVEL_COLORS: readonly number[] = [
  0x6d28d9, 0x2563eb, 0x0ea5e9, 0x06b6d4, 0x10b981, 0x84cc16, 0xfacc15,
  0xf59e0b, 0xf97316, 0xef4444, 0xec4899, 0xf9a8d4, 0xf8fafc,
]

/** Only three One-LOD tiers exist, so they are spread across the ramp instead of
 *  taking its first three near-identical blues. */
const ONE_LOD_RAMP_INDEX = [0, 5, 9]

export function densityLevelColor(band: DensityBand): number {
  const index = band.startsWith('APH ') ? densityLevel(band) : ONE_LOD_RAMP_INDEX[densityLevel(band)]
  return DENSITY_LEVEL_COLORS[Math.min(index, DENSITY_LEVEL_COLORS.length - 1)]
}

/** `APH d5` -> `d5`. The panel has no room for the prefix, and the ladder it belongs
 *  to is already named by the section. */
export function shortBandLabel(band: DensityBand): string {
  return band.replace('APH ', '')
}

function bandRank(band: DensityBand): number {
  // APH depth outranks every One-LOD band; the two never appear together.
  const depth = /^APH d(\d+)$/.exec(band)
  if (depth) return 10 + Number(depth[1])
  if (band === 'Detail p100') return 2
  if (band === 'Explore p10') return 1
  return 0
}
