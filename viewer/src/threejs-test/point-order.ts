import * as THREE from 'three'

import {
  isPackedPositionView, makePointDataTexture, packPointData, pointDataLength,
  textureFromPackedView, unpackPointData,
} from './dot-geometry.ts'

/**
 * The order a tile's points are kept in, and the one pass that puts them there.
 *
 * Thinning draws a prefix of every tile, so the arrival handler rewrites each tile once so
 * that any prefix is a fair spatial sample (reorderForPrefixSampling). The pulled feed of
 * plans/plan-dot-geometry-ab.md draws from a per-tile texture instead of the arrays, and
 * packs that texture in the *same* pass (packPointsForPulling): the reorder already reads
 * every point and writes 16 bytes per point, which is exactly the texture's size, so the
 * texture costs nothing on top of it. The carrier then keeps a view into the texture's
 * array rather than arrays of its own (adoptPointData), so a pulled tile holds its points
 * once, as an instanced one does.
 *
 * Measured before this module existed: packing as a second pass after the reorder cost
 * +0.6 ms per 75 k-point tile on arrival and 47 bytes per point of CPU memory, against
 * 31 for the instanced feed.
 */

/**
 * How many interleaved rounds `reorderForPrefixSampling` emits.
 *
 * A prefix of `keep` covers `keep * ROUNDS` complete rounds, so it must be at least one
 * or the prefix stops partway across the tile and is a crop again. That fixes a floor:
 * **ROUNDS >= 1 / THINNING_MIN_KEEP**, which is 1/0.02 = 50. 64 clears it with headroom.
 *
 * Measured, not guessed — per-cell coefficient of variation at the 2% floor on a 270k
 * tile: ROUNDS 32 gives 0.92 with 101 of 256 cells empty (it covers only 32 * 0.02 =
 * 64% of the buffer, exactly the predicted crop), 48 gives 0.46, 64 gives 0.54, 96
 * gives 0.44. Above 5% keep they are all within 0.02 of each other. Do not lower this
 * below 50 without lowering THINNING_MIN_KEEP with it.
 *
 * Larger is not better: a prefix includes runs of `keep * ROUNDS` *consecutive* source
 * indices, and the source order is spatially smooth, so long runs re-cluster the sample.
 * ROUNDS 1024 measured 0.71 at 10% against 0.42 for 64.
 *
 * **Why 61 and not a round number.** `ground-patch-mask.ts` decides whether a tile adds
 * any coverage by probing it at `count / 64` intervals — 64 samples spread across the
 * buffer (`isRedundant`). If ROUNDS shares factors with that 64, the probe lands at the
 * same offset inside every round and collapses onto a handful of source indices. Measured
 * on a 270k tile, distinct lattice cells hit by those 64 probes: **58 unshuffled, 59 at
 * ROUNDS 61, but only 8 at ROUNDS 64 and 16 at 96.** A probe that samples 8 spots instead
 * of 58 will call tiles redundant that are not, and the mask drops them — coverage holes,
 * not just a slower walk. 61 is prime, so it cannot alias with any probe count.
 */
export const PREFIX_SAMPLE_ROUNDS = 61

type PointAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute

/**
 * A carrier's box and sphere exactly as three's computeBoundingBox and
 * computeBoundingSphere would leave them, bit for bit (the tests hold them to that).
 *
 * The arrival passes read every point anyway, so they collect the box on the way and the
 * sphere takes one more pass over the output. Without this the carrier's sphere was left
 * null and built lazily by three — two full passes — in the tile's first visible frame,
 * by whichever of applyThinning, shadedPixelArea or sampleGroundZ asked first. Measured in
 * node: three's lazy pair costs 0.9-1.3 ms at 75k points and 2.8-4.3 ms at 270k; the fused
 * version adds 0.2-0.3 ms at 75k to the arrival pass, most of it the radius pass.
 */
export type PointBounds = { box: THREE.Box3; sphere: THREE.Sphere }

export function newPointBounds(): PointBounds {
  return { box: new THREE.Box3(), sphere: new THREE.Sphere() }
}

/**
 * The second half of three's computeBoundingSphere: the box centre, then the largest
 * distance to it. Math.min / Math.max in the passes, not comparisons, because that is what
 * Vector3.min / max do — a comparison keeps whichever zero it saw first, where Math.min
 * gives -0. And the squares summed in three's order, x + y + z: the centre is a double,
 * so the order is observable in the last bit.
 *
 * `array` holds xyz at `stride` floats per point, and only `count` points are read — the
 * texture's padding texels are zeros and would pull the tile origin into the sphere.
 */
function finishPointBounds(
  bounds: PointBounds,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
  array: Float32Array, stride: number, count: number,
): void {
  bounds.box.min.set(minX, minY, minZ)
  bounds.box.max.set(maxX, maxY, maxZ)
  // Box3.getCenter: (min + max) * 0.5, or the origin for an empty box — as three does.
  const centre = bounds.box.getCenter(bounds.sphere.center)
  const cx = centre.x, cy = centre.y, cz = centre.z
  let maxRadiusSq = 0
  for (let i = 0, o = 0; i < count; i++, o += stride) {
    const dx = cx - array[o], dy = cy - array[o + 1], dz = cz - array[o + 2]
    maxRadiusSq = Math.max(maxRadiusSq, dx * dx + dy * dy + dz * dz)
  }
  bounds.sphere.radius = Math.sqrt(maxRadiusSq)
}

/**
 * Give a carrier its bounds now, for the arrivals no pass above covers: pre-ordered packs,
 * thinning off and tiles too small to reorder in the instanced feed, and the layouts the
 * passes decline. Tight Float32 xyz and the four-float texture view get the same two tight
 * passes; anything else goes through three itself, which is exact by definition.
 */
export function computeCarrierBounds(carrier: THREE.BufferGeometry): void {
  const position = carrier.getAttribute('position') as PointAttribute | undefined
  if (!position) return
  const tight = (position.itemSize === 3 || position.itemSize === 4)
    && position.array instanceof Float32Array
    && !(position as any).isInterleavedBufferAttribute
    && !carrier.morphAttributes.position
  if (!tight) {
    carrier.computeBoundingBox()
    carrier.computeBoundingSphere()
    return
  }
  const array = position.array as Float32Array
  const stride = position.itemSize
  const count = position.count
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0, o = 0; i < count; i++, o += stride) {
    const x = array[o], y = array[o + 1], z = array[o + 2]
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z)
  }
  const bounds = newPointBounds()
  finishPointBounds(bounds, minX, minY, minZ, maxX, maxY, maxZ, array, stride, count)
  setCarrierBounds(carrier, bounds)
}

/** Hand bounds an arrival pass filled to the carrier they describe. */
export function setCarrierBounds(carrier: THREE.BufferGeometry, bounds: PointBounds): void {
  carrier.boundingBox = bounds.box
  carrier.boundingSphere = bounds.sphere
}

/**
 * The layouts the fast passes handle: tight Float32 xyz, and colour as tight Uint8 RGB,
 * Uint8 RGBA or none — the ones PNTS actually ships. Null for anything else, which then
 * falls back rather than growing a general path that would be both slower and barely
 * exercised.
 */
export function fastPointLayout(
  position: PointAttribute | null | undefined,
  color: PointAttribute | null | undefined,
): 'rgb' | 'rgba' | 'none' | null {
  if (!position || position.itemSize !== 3 || (position as any).isInterleavedBufferAttribute) return null
  if (!(position.array instanceof Float32Array)) return null
  if (!color) return 'none'
  if ((color as any).isInterleavedBufferAttribute || !(color.array instanceof Uint8Array)) return null
  if (color.itemSize === 3) return 'rgb'
  if (color.itemSize === 4) return 'rgba'
  return null
}

/** Whether `reorderForPrefixSampling` takes this tile. Fewer than three points has no
 *  prefix worth ordering. */
export function reorderAccepts(
  position: PointAttribute | null | undefined,
  color: PointAttribute | null | undefined,
): boolean {
  return (position?.count ?? 0) > 2 && fastPointLayout(position, color) !== null
}

/**
 * Rewrite a tile so that *any prefix of it is an evenly spread sample of the whole tile*.
 *
 * Thinning draws a prefix (the draw range, or `instanceCount`), which is a fair sample only if the order
 * carries no large-scale spatial structure. The packs come from a COPC octree, so a
 * prefix is a crop — but measuring four real tiles showed consecutive points sit 10-22x
 * closer together than random pairs, which means the order is *smoothly* spatial: a
 * prefix is a crop, yet every k-th point is a near-perfect sample. Per-cell coefficient
 * of variation at 10% kept, lower is better: raw prefix 3.04, this reorder 0.42, the
 * random shuffle it replaces 0.41. So it *matches* the shuffle rather than beating it —
 * an idealised fractional stride reaches 0.40, and the small gap is the mid-round
 * truncation described on PREFIX_SAMPLE_ROUNDS. What matters is that the figure stays
 * flat as the sample shrinks (0.40 at 56% kept, 0.43 at 5%) where the raw prefix runs
 * from 1.00 to 4.28.
 *
 * So: round-robin over a fixed stride. Every ROUNDS-th point, then the same offset by
 * one, and so on. A prefix of the result is a union of stride samples, evenly spread at
 * every length the viewer asks for.
 *
 * This replaces a seeded Fisher-Yates shuffle that cost 4-12 ms of main-thread time per
 * tile and was the single most expensive thing in bringing a tile online. A shuffle is
 * random access in both directions and defeats the prefetcher; this is constant-stride
 * reads and sequential writes. Measured on the real tiles: 12.6 -> 2.2 ms at 75k points,
 * 62.4 -> 6.3 ms at 270k.
 *
 * It widens the colour to RGBA in the same pass, because WebGPU needs the 4-byte stride
 * and the alternative is a second full copy of it — see `padColourForGpu` in streaming.ts.
 *
 * The instanced feed's arrival pass. The pulled feed runs `packPointsForPulling`, the same
 * permutation written straight into the texture layout.
 *
 * Returns null when the tile is not in the one layout this handles, in which case the
 * caller keeps the arrays as they arrived and the tile is drawn whole rather than thinned.
 * `bounds`, when given, is filled exactly when the result is not null.
 */
export function reorderForPrefixSampling(
  position: PointAttribute,
  color: PointAttribute | null | undefined,
  bounds?: PointBounds,
): { position: Float32Array; color: Uint8Array | null } | null {
  if (!reorderAccepts(position, color)) return null
  const count = position.count
  const src = position.array as Float32Array
  const colourArray = color?.array
  const colourItems = color?.itemSize ?? 0
  const rounds = Math.min(PREFIX_SAMPLE_ROUNDS, count)
  const out = new Float32Array(count * 3)
  const outColour = color ? new Uint8Array(count * 4) : null
  // Tracked whether or not `bounds` was asked for: a branch inside the loops is the kind
  // of thing that stops V8 specialising them (below).
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  // Written out once per colour layout rather than as one loop with a branch inside: a
  // dynamic item size and a variable inner trip count stop V8 specialising the body,
  // which measured 15x slower when `padColourForGpu` was first written that way.
  if (outColour && colourItems === 3) {
    const rgb = colourArray as Uint8Array
    for (let r = 0, w = 0; r < rounds; r++) {
      for (let i = r; i < count; i += rounds, w++) {
        const s = i * 3, d = w * 3, dc = w * 4
        const x = src[s], y = src[s + 1], z = src[s + 2]
        out[d] = x; out[d + 1] = y; out[d + 2] = z
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z)
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z)
        outColour[dc] = rgb[s]; outColour[dc + 1] = rgb[s + 1]
        outColour[dc + 2] = rgb[s + 2]; outColour[dc + 3] = 255
      }
    }
  } else if (outColour) {
    const rgba = colourArray as Uint8Array
    for (let r = 0, w = 0; r < rounds; r++) {
      for (let i = r; i < count; i += rounds, w++) {
        const s = i * 3, d = w * 3, sc = i * 4, dc = w * 4
        const x = src[s], y = src[s + 1], z = src[s + 2]
        out[d] = x; out[d + 1] = y; out[d + 2] = z
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z)
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z)
        outColour[dc] = rgba[sc]; outColour[dc + 1] = rgba[sc + 1]
        outColour[dc + 2] = rgba[sc + 2]; outColour[dc + 3] = rgba[sc + 3]
      }
    }
  } else {
    for (let r = 0, w = 0; r < rounds; r++) {
      for (let i = r; i < count; i += rounds, w++) {
        const s = i * 3, d = w * 3
        const x = src[s], y = src[s + 1], z = src[s + 2]
        out[d] = x; out[d + 1] = y; out[d + 2] = z
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z)
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z)
      }
    }
  }
  if (bounds) finishPointBounds(bounds, minX, minY, minZ, maxX, maxY, maxZ, out, 3, count)
  return { position: out, color: outColour }
}

/**
 * The pulled feed's arrival pass: reorder over `rounds` and pack into the point-data
 * texture layout, in one pass. `rounds = 1` keeps the order the points arrived in — for
 * thinning off, pre-ordered packs and tiles too small to reorder.
 *
 * Same permutation and same texels as `packPointData(reorderForPrefixSampling(...))`, bit
 * for bit; the tests hold it to that. Same loop shape as the reorder, one loop per colour
 * layout for the same reason, with `d += 4` and the colour folded into w. A tile without
 * colour leaves w at 0, which decodes to black — what the instanced graph draws for it.
 *
 * Returns null for the layouts `fastPointLayout` declines; the caller then packs with the
 * general `packPointData` and keeps the arrays as they arrived. `bounds`, when given, is
 * filled exactly when the result is not null.
 */
export function packPointsForPulling(
  position: PointAttribute,
  color: PointAttribute | null | undefined,
  rounds: number,
  bounds?: PointBounds,
): THREE.DataTexture | null {
  const layout = fastPointLayout(position, color)
  if (layout === null) return null
  const count = position.count
  const src = position.array as Float32Array
  const R = Math.max(1, Math.min(Math.floor(rounds), count))
  const data = new Float32Array(pointDataLength(count))
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  if (layout === 'rgb') {
    const rgb = color!.array as Uint8Array
    for (let r = 0, w = 0; r < R; r++) {
      for (let i = r; i < count; i += R, w++) {
        const s = i * 3, d = w * 4
        const x = src[s], y = src[s + 1], z = src[s + 2]
        data[d] = x; data[d + 1] = y; data[d + 2] = z
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z)
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z)
        data[d + 3] = rgb[s] * 65536 + rgb[s + 1] * 256 + rgb[s + 2]
      }
    }
  } else if (layout === 'rgba') {
    const rgba = color!.array as Uint8Array
    for (let r = 0, w = 0; r < R; r++) {
      for (let i = r; i < count; i += R, w++) {
        const s = i * 3, sc = i * 4, d = w * 4
        const x = src[s], y = src[s + 1], z = src[s + 2]
        data[d] = x; data[d + 1] = y; data[d + 2] = z
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z)
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z)
        data[d + 3] = rgba[sc] * 65536 + rgba[sc + 1] * 256 + rgba[sc + 2]
      }
    }
  } else {
    for (let r = 0, w = 0; r < R; r++) {
      for (let i = r; i < count; i += R, w++) {
        const s = i * 3, d = w * 4
        const x = src[s], y = src[s + 1], z = src[s + 2]
        data[d] = x; data[d + 1] = y; data[d + 2] = z
        minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z)
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z)
      }
    }
  }
  // Over the texels just written, at four floats per point and only `count` of them.
  if (bounds) finishPointBounds(bounds, minX, minY, minZ, maxX, maxY, maxZ, data, 4, count)
  return makePointDataTexture(data, count)
}

/**
 * Hand a carrier's points over to its texture: `position` becomes a four-float view of
 * the texture's own array — exactly `points` texels, never the row padding, which would
 * otherwise read as points at the tile origin — and every other attribute goes. The
 * arrays it held, and the tile's PNTS buffer behind them, are then free once nothing
 * else holds them.
 *
 * Every reader of the carrier copes with the four-float stride: three's bounds and
 * `getX/Y/Z` read through the item size, and the ground-patch mask strides by it.
 * The bounds are left alone — the points and their order are unchanged, so the ones the
 * arrival pass set (buildPointQuads) survive this and restoreCarrierArrays alike.
 */
export function adoptPointData(carrier: THREE.BufferGeometry, texture: THREE.DataTexture, points: number): void {
  const data = texture.image.data as Float32Array
  carrier.setAttribute('position', new THREE.BufferAttribute(data.subarray(0, points * 4), 4))
  for (const name of Object.keys(carrier.attributes)) {
    if (name !== 'position') carrier.deleteAttribute(name)
  }
}

/**
 * Give a packed carrier tight arrays again, for the instanced feed: Float32 xyz and, when
 * the tile had colour, normalised RGBA8. Returns whether there was anything to undo.
 *
 * Unpacked from the carrier's own view, so it needs neither the texture nor a count —
 * the view holds exactly the tile's points.
 */
export function restoreCarrierArrays(carrier: THREE.BufferGeometry, hasColour: boolean): boolean {
  const view = carrier.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!isPackedPositionView(view)) return false
  const { position, color } = unpackPointData(view, hasColour)
  carrier.setAttribute('position', new THREE.BufferAttribute(position, 3))
  if (color) carrier.setAttribute('color', new THREE.BufferAttribute(color, 4, true))
  return true
}

/**
 * The point-data texture for a carrier switching to the pulled feed after it arrived.
 *
 * The carrier is already in its final order, so this is the identity pack, adopted like
 * an arrival. A carrier that is somehow already packed is wrapped again without a copy,
 * and a layout the fast pass declines gets the general pack, keeping its arrays.
 */
export function pointDataForCarrier(carrier: THREE.BufferGeometry): THREE.DataTexture {
  const position = carrier.getAttribute('position') as PointAttribute
  if (isPackedPositionView(position)) {
    const texture = textureFromPackedView(position)
    if ((texture.image.data as Float32Array).buffer !== position.array.buffer) {
      adoptPointData(carrier, texture, position.count)
    }
    return texture
  }
  const color = carrier.getAttribute('color') as PointAttribute | undefined
  const packed = packPointsForPulling(position, color, 1)
  if (!packed) return packPointData(position, color)
  adoptPointData(carrier, packed, position.count)
  return packed
}
