// Distance cutoff and distance-weighted refinement for the point-cloud tiles.
//
// 3DTilesRendererJS only knows screen-space error: a tile refines whenever
// geometricError / distance is large enough, no matter how far away it sits.
// Pointed at the horizon that pulls every mid-depth tile of the whole survey,
// tripling the drawn points for a sliver of haze. This wrapper runs after the
// renderer's own view-error computation and
//   • drops tiles beyond `cutoff` from traversal entirely (not fetched, not
//     refined, not drawn), and
//   • scales the error of tiles beyond `detailRange` by (detailRange / d)²,
//     so refinement depth falls off with distance like a foveated view — the
//     nadir footprint stays at full density while the horizon refines shallow.
// Ancestors whose bounding volume contains the camera report distance 0 and are
// unaffected; the point material discards their far points at the same range.
//
// Plugins with `calculateTileViewError` replace the base computation, hence the
// instance-method wrap instead of a plugin.
export interface DistanceLod {
  /** `detailRangeM`: full refinement up to here, quadratic taper beyond. */
  setCutoff(cutoffM: number, detailRangeM: number): void
  cutoff(): number
  setNearDetail(policy: NearDetailPolicy | null): void
  dispose(): void
}

export interface NearDetailPolicy {
  rangeM: number
  sse: number
  farFactor: number
}

type ViewErrorTarget = { inView: boolean; error: number; distanceFromCamera: number }

export function installDistanceLod(tiles: any): DistanceLod {
  let cutoff = Infinity
  let detailRange = Infinity
  let near: NearDetailPolicy | null = null
  const base = tiles.calculateTileViewError as (tile: any, target: ViewErrorTarget) => void
  const wrapped = (tile: any, target: ViewErrorTarget) => {
    base.call(tiles, tile, target)
    if (!target.inView) return
    const d = target.distanceFromCamera
    if (d >= cutoff) {
      target.inView = false
      target.error = 0
      return
    }
    if (near && Number.isFinite(d) && tiles.errorTarget > 0) {
      const t = Math.min(1, Math.max(0, (d - near.rangeM) / near.rangeM))
      const blend = t * t * (3 - 2 * t)
      const nearSse = Math.min(tiles.errorTarget, near.sse)
      const farSse = tiles.errorTarget * near.farFactor
      const effectiveSse = nearSse * Math.pow(farSse / nearSse, blend)
      target.error *= tiles.errorTarget / effectiveSse
    }
    const taperStart = Math.max(detailRange, near?.rangeM ?? 0)
    if (d > taperStart) {
      const ratio = taperStart / d
      target.error *= ratio * ratio
    }
  }
  tiles.calculateTileViewError = wrapped
  return {
    setCutoff(cutoffM, detailRangeM) {
      cutoff = Number.isFinite(cutoffM) && cutoffM > 0 ? cutoffM : Infinity
      detailRange = Number.isFinite(detailRangeM) && detailRangeM > 0 ? detailRangeM : Infinity
    },
    cutoff: () => cutoff,
    setNearDetail(policy) {
      near = policy && policy.rangeM > 0 && policy.sse > 0 && policy.farFactor >= 1
        ? { ...policy } : null
    },
    dispose() {
      if (tiles.calculateTileViewError === wrapped) tiles.calculateTileViewError = base
    },
  }
}
