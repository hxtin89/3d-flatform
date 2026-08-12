// Coverage mask for the ground under the point cloud.
//
// The mask answers one question per pixel: does the point cloud have data here?
// The basemap material samples it and treats those pixels differently, so the map
// is only shown as-is where the cloud is not.
//
// Coverage comes from the points themselves. That matters because of how the
// survey was flown: lidar gets almost no returns off water, so the river is a
// real, river-shaped hole in the point data — and showing the basemap through it
// is exactly what we want. Only the points express it. Two coarser sources were
// tried first and both cover the river over:
//   survey bbox    one rectangle over 12.8 x 8.5 km, mostly empty
//   node boxes     the tileset hierarchy. Nodes exist only where there is data, so
//                  the outline is right and the wide gaps survive, but the leaf
//                  boxes have a median width of ~31 m, so a 30 m river is at best
//                  a dashed line and mostly solid cover.
//
// The cost is arranged so there is none to speak of:
//   - no extra downloads. Tiles are splatted as the renderer loads them anyway.
//   - no per-frame cost once quiet. Work happens only while a queue is non-empty.
//   - no hitches while busy. Each frame spends a fixed point budget and stops,
//     so a 3 M point overview spreads over a few dozen frames instead of locking
//     up one. An earlier attempt splatted on the GPU every time tiles changed and
//     cost 26 s per frame; this is the same idea done incrementally on the CPU.
//   - coverage only ever grows, so unloading a tile never takes it away and the
//     mask cannot flicker.
//
// Because it accumulates, the mask also sharpens by itself: the overview LOD
// covers the whole footprint at ~4 m sampling within a second or two, and every
// finer tile the camera pulls in refines the edges for free.
import * as THREE from 'three'

export interface GroundPatchMask {
  /** Coverage field, 0 where the cloud has no data and 1 where it does. */
  texture: THREE.DataTexture
  /** ENU rectangle the texture spans; the material maps ENU xy into UV with it. */
  center: THREE.Vector2
  halfExtent: THREE.Vector2
  /**
   * Fix the ENU rectangle from the tileset's node boxes, and keep the ENU frame
   * for splatting. Resolves to the number of boxes the extent was derived from, or
   * 0 when the tileset carries nothing usable — callers should treat 0 as "leave
   * the patch off" rather than as an error.
   *
   * Only the extent, not the coverage: the boxes are far too coarse for that (see
   * the note above), but they bound the survey exactly and cost 27 small JSON
   * fetches. The rectangle has to be settled before any point can be placed in it,
   * so tiles that arrive first are queued and drained once this resolves.
   */
  setExtent(opts: {
    tilesetUrl: string
    rootTileSet: any
    enuInverse: THREE.Matrix4
    maxDepth: number
  }): Promise<number>
  /**
   * Register a loaded point tile for splatting. Cheap: it only queues, so it is
   * safe to call from a load handler.
   *
   * The object is read on a later frame rather than now, because at load time its
   * world matrix has not been composed yet.
   */
  addTile(object: THREE.Object3D): void
  /** Spend this frame's budget on the queue and upload if anything changed. */
  update(): void
  dispose(): void
}

/** One node footprint, axis-aligned in the survey's ENU frame. */
interface Box { cx: number; cy: number; hx: number; hy: number }

function readBox(node: any, localToEnu: THREE.Matrix4, out: THREE.Vector3): Box | null {
  const box: number[] | undefined = node?.boundingVolume?.box
  if (!box || box.length < 12) return null
  out.set(box[0], box[1], box[2]).applyMatrix4(localToEnu)
  // Half-extent per world axis: the largest contribution any half-axis makes to
  // it. The tileset's transforms are rigid ENU placements, so for these boxes
  // that is simply the matching component.
  const hx = Math.max(Math.abs(box[3]), Math.abs(box[6]), Math.abs(box[9]))
  const hy = Math.max(Math.abs(box[4]), Math.abs(box[7]), Math.abs(box[10]))
  if (hx <= 0 || hy <= 0) return null
  return { cx: out.x, cy: out.y, hx, hy }
}

/** Collect the deepest nodes at or above `maxDepth` — the tightest bound available. */
function collectDeepest(node: any, localToEnu: THREE.Matrix4, maxDepth: number, into: Box[]): void {
  const scratch = new THREE.Vector3()
  const walk = (n: any, depth: number) => {
    const children: any[] = n?.children ?? []
    if (!children.length || depth >= maxDepth) {
      const box = readBox(n, localToEnu, scratch)
      if (box) into.push(box)
      return
    }
    for (const child of children) walk(child, depth + 1)
  }
  walk(node, 0)
}

export function createGroundPatchMask(opts: {
  size: number
  /**
   * Pixels each point is grown by. The overview LOD samples about one point per
   * pixel, and Poisson gaps in that leave roughly a tenth of the interior speckled
   * without any growth, so 1 buys a solid surface. It also costs the river a pixel
   * on each bank, which at this resolution it can afford — and 0 is available for
   * anyone who would rather have the speckle.
   */
  splatRadiusPx: number
  /**
   * Points splatted per frame. The ceiling on the hitch this can cause: at 80k the
   * work is well under a millisecond, and the 3 M point overview still lands within
   * a couple of seconds.
   */
  pointsPerFrame: number
}): GroundPatchMask {
  const { size, splatRadiusPx, pointsPerFrame } = opts
  const data = new Uint8Array(size * size)
  // Allocated and registered up front, then filled in place. The basemap materials
  // bind this texture object before the tileset is even fetched, so replacing the
  // object later would leave them on an empty mask.
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true

  const center = new THREE.Vector2(0, 0)
  const halfExtent = new THREE.Vector2(1, 1)

  let enuInverse: THREE.Matrix4 | null = null
  let minX = 0, minY = 0, metresPerPixelX = 1, metresPerPixelY = 1
  let dirty = false

  /** Tiles waiting for the extent, or for their turn at the frame budget. */
  const queue: THREE.Object3D[] = []
  /** How far into the head of the queue the last frame got. */
  let cursor = 0

  const localToEnu = new THREE.Matrix4()

  /**
   * Splat up to `budget` points and report how many were consumed. Reads the matrix
   * elements directly: this is the one genuinely hot loop here, and a Vector3 round
   * trip per point would dominate it.
   */
  function splat(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
                 from: number, budget: number): number {
    const array = position.array as ArrayLike<number>
    const stride = (position as any).itemSize ?? 3
    const e = localToEnu.elements
    const end = Math.min(position.count, from + budget)
    const r = splatRadiusPx
    for (let i = from; i < end; i++) {
      const o = i * stride
      const lx = array[o], ly = array[o + 1], lz = array[o + 2]
      // Only x and y are needed — the mask is a plan view — so the z row of the
      // multiply is skipped entirely.
      const ex = e[0] * lx + e[4] * ly + e[8] * lz + e[12]
      const ey = e[1] * lx + e[5] * ly + e[9] * lz + e[13]
      const px = ((ex - minX) / metresPerPixelX) | 0
      const py = ((ey - minY) / metresPerPixelY) | 0
      const x0 = px - r < 0 ? 0 : px - r
      const x1 = px + r > size - 1 ? size - 1 : px + r
      const y0 = py - r < 0 ? 0 : py - r
      const y1 = py + r > size - 1 ? size - 1 : py + r
      if (x1 < x0 || y1 < y0) continue
      for (let y = y0; y <= y1; y++) {
        const row = y * size
        for (let x = x0; x <= x1; x++) {
          if (data[row + x] !== 255) { data[row + x] = 255; dirty = true }
        }
      }
    }
    return end - from
  }

  return {
    texture,
    center,
    halfExtent,

    async setExtent({ tilesetUrl, rootTileSet, enuInverse: inverse, maxDepth }) {
      const root = rootTileSet?.root
      const children: any[] = root?.children ?? []
      if (!children.length) return 0

      const localToEcef = new THREE.Matrix4()
      if (Array.isArray(root.transform) && root.transform.length === 16) {
        localToEcef.fromArray(root.transform)
      }
      const rootToEnu = new THREE.Matrix4().multiplyMatrices(inverse, localToEcef)
      const base = tilesetUrl.slice(0, tilesetUrl.lastIndexOf('/') + 1)

      const boxes: Box[] = []
      const scratch = new THREE.Vector3()
      // Each cell links to its own subtree. Fetched in parallel: they are small and
      // independent, and this runs off the critical path anyway.
      const cells = await Promise.all(children.map(async (child) => {
        const uri: string | undefined = child?.content?.uri
        if (!uri) return null
        try {
          const response = await fetch(base + uri)
          if (!response.ok) return null
          return await response.json()
        } catch {
          return null
        }
      }))

      for (const subtree of cells) {
        const subRoot = subtree?.root
        if (!subRoot) continue
        // The child's transform (if any) composes with the root's.
        const cellToEnu = rootToEnu.clone()
        if (Array.isArray(subRoot.transform) && subRoot.transform.length === 16) {
          cellToEnu.multiply(new THREE.Matrix4().fromArray(subRoot.transform))
        }
        collectDeepest(subRoot, cellToEnu, maxDepth, boxes)
      }
      // Any cell whose subtree could not be read still bounds real data, so fall
      // back to its top-level box rather than cropping the rectangle short of it.
      for (let i = 0; i < children.length; i++) {
        if (cells[i]) continue
        const box = readBox(children[i], rootToEnu, scratch)
        if (box) boxes.push(box)
      }
      if (!boxes.length) return 0

      let maxX = -Infinity, maxY = -Infinity
      minX = Infinity; minY = Infinity
      for (const b of boxes) {
        minX = Math.min(minX, b.cx - b.hx); maxX = Math.max(maxX, b.cx + b.hx)
        minY = Math.min(minY, b.cy - b.hy); maxY = Math.max(maxY, b.cy + b.hy)
      }
      // Margin so the edge of the coverage is never the edge of the texture, where
      // clamped sampling would turn it into a hard straight line.
      const marginX = (maxX - minX) * 0.05
      const marginY = (maxY - minY) * 0.05
      minX -= marginX; maxX += marginX; minY -= marginY; maxY += marginY
      center.set((minX + maxX) / 2, (minY + maxY) / 2)
      halfExtent.set((maxX - minX) / 2, (maxY - minY) / 2)
      metresPerPixelX = (maxX - minX) / size
      metresPerPixelY = (maxY - minY) / size

      enuInverse = inverse
      return boxes.length
    },

    addTile(object) {
      queue.push(object)
    },

    update() {
      if (!enuInverse || !queue.length) return
      let budget = pointsPerFrame
      while (budget > 0 && queue.length) {
        const object = queue[0]
        const position = (object as any).geometry?.getAttribute?.('position')
        if (!position) { queue.shift(); cursor = 0; continue }
        // Composed now rather than at load time: the tile's place in the world is
        // only settled once the renderer has parented it and updated the graph.
        object.updateWorldMatrix(true, false)
        localToEnu.multiplyMatrices(enuInverse, object.matrixWorld)
        const done = splat(position, cursor, budget)
        budget -= done
        cursor += done
        if (cursor >= position.count) { queue.shift(); cursor = 0 }
      }
      if (dirty) { texture.needsUpdate = true; dirty = false }
    },

    dispose() {
      queue.length = 0
      texture.dispose()
    },
  }
}
