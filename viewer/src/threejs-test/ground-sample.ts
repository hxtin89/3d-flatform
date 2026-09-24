import * as THREE from 'three'

/**
 * The ground probe behind `sampleGroundZ` (streaming.ts): heights of the loaded points
 * inside a square footprint, and two percentiles of them — forest floor and canopy top.
 *
 * Kept out of streaming.ts so node can test it against the real tile scenes it walks: it
 * needs nothing but three and each tile's carrier Points.
 */

export interface GroundSample {
  /** Low percentile of point height — the forest floor, in raw ENU metres. */
  groundZ: number
  /** High percentile — the canopy top. */
  canopyZ: number
  samples: number
  /** Occupied cells of the 5×5 support grid; low values mean a thin sample. */
  support: number
}

/** The probe settings; EXPERIENCE_CONFIG.donationShape satisfies it. */
export interface GroundSampleSettings {
  probeMaxSamplesPerTile: number
  probeMinSamples: number
  probeGroundPercentile: number
  probeCanopyPercentile: number
}

// Reused so a per-frame sample allocates nothing but its height list.
const local = new THREE.Matrix4()
const point = new THREE.Vector3()

/**
 * Sample the points of `tileScenes` inside the square of half-side `radiusM` around
 * `centreEnu`, in the ENU frame `enuInverse` maps world space into.
 *
 * Only the carriers are walked. Each tile scene is a carrier Points with one dot mesh
 * under it, and the dot mesh reads the carrier's own points — the instanced feed wraps
 * the carrier's position array, the pulled one reads it off the carrier — so the probe
 * used to walk every point twice, once per object. The dot mesh was also walked with no
 * bound at all, whatever its distance, which made a small probe as dear as a big one.
 * Measured in node on three ancestors plus 36 leaves of 75k points: 7.6 → 2.0 ms at
 * r 20 and 16 → 10 ms at r 60. At r 180 the sort of the heights is most of the cost.
 *
 * The result is bit-identical to the old walk, which the node test checks against a
 * verbatim copy of it. So each in-footprint point is still pushed with the weight the two
 * objects gave it: twice for a carrier the old disc reject let through (its own walk plus
 * its dot mesh's), once for one it turned away (the dot mesh's alone), and the 400-sample
 * minimum keeps its meaning. The walk itself reaches r√2 + R rather than r + R, because
 * the footprint is a square whose corners lie r√2 out: the old reject turned away tiles
 * that still had points in those corners, and it was only the unbounded dot-mesh walk
 * that counted them — once.
 */
export function sampleGroundHeights(
  tileScenes: Iterable<THREE.Object3D | null | undefined>,
  centreEnu: THREE.Vector2,
  radiusM: number,
  enuInverse: THREE.Matrix4,
  settings: GroundSampleSettings,
): GroundSample | null {
  const heights: number[] = []
  // 5×5 support grid: a candidate height backed by one corner of the
  // footprint is noise, not ground.
  const support = new Uint8Array(25)
  // A millimetre over the corner reach, so rounding in the sphere and the transform can
  // never turn away a point on the rim. The walk is conservative, so the slack changes
  // nothing it returns.
  const reach = radiusM * Math.SQRT2 + 1e-3

  const visit = (object: any) => {
    if (!object.isPoints) return
    const attribute = object.geometry?.getAttribute?.('position')
    if (!attribute || attribute.count === 0) return
    object.updateWorldMatrix(true, false)
    local.multiplyMatrices(enuInverse, object.matrixWorld)

    // The carrier's sphere describes the tile — buildPointQuads sets it on arrival.
    const geometry = object.geometry
    if (!geometry.boundingSphere) geometry.computeBoundingSphere()
    const bounds = geometry.boundingSphere
    let copies = 2
    if (bounds) {
      point.copy(bounds.center).applyMatrix4(local)
      const distance = Math.hypot(point.x - centreEnu.x, point.y - centreEnu.y)
      if (distance > reach + bounds.radius) return
      // The old reject, kept to the letter — it decides the weight now, not the walk. A
      // sub-metre carrier, a one-point leaf say, was never disc-tested and still is not.
      if (bounds.radius > 1 && distance > radiusM + bounds.radius) copies = 1
    }

    const stride = Math.max(1, Math.floor(attribute.count / settings.probeMaxSamplesPerTile))
    for (let index = 0; index < attribute.count; index += stride) {
      point.set(attribute.getX(index), attribute.getY(index), attribute.getZ(index))
      point.applyMatrix4(local)
      const dx = point.x - centreEnu.x
      const dy = point.y - centreEnu.y
      if (Math.abs(dx) > radiusM || Math.abs(dy) > radiusM) continue
      heights.push(point.z)
      if (copies === 2) heights.push(point.z)
      const column = Math.min(4, Math.max(0, Math.floor(((dx / radiusM) + 1) * 2.5)))
      const row = Math.min(4, Math.max(0, Math.floor(((dy / radiusM) + 1) * 2.5)))
      support[row * 5 + column] = 1
    }
  }
  for (const scene of tileScenes) scene?.traverse(visit)

  if (heights.length < settings.probeMinSamples) return null
  heights.sort((a, b) => a - b)
  const at = (fraction: number): number =>
    heights[Math.min(heights.length - 1, Math.max(0, Math.floor(heights.length * fraction)))]
  let occupied = 0
  for (const cell of support) occupied += cell
  return {
    groundZ: at(settings.probeGroundPercentile),
    canopyZ: at(settings.probeCanopyPercentile),
    samples: heights.length,
    support: occupied,
  }
}
