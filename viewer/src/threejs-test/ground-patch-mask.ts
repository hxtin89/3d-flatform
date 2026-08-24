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
// TILED, and that is the load-bearing decision. One texture stretched over the
// whole survey ties resolution to total area: every square kilometre added makes
// every pixel coarser, and the first thing lost is the river, which is only a few
// pixels wide to begin with. Surveys in Canada are coming, and no texture size
// fixes that — a single ENU plane with one bounding rectangle would have to span
// the gap between continents.
//
// So the mask is a lattice of fixed-resolution cells instead:
//   - metres per pixel is a constant. Area changes the number of cells, never the
//     detail, so the river survives any amount of growth.
//   - cells sit on a global lattice anchored at the ENU origin, not on the current
//     bounding box. New data therefore never shifts an existing cell, which is what
//     makes growth cheap and, later, makes per-area masks line up.
//   - layers are handed out only to cells that actually contain points. The survey
//     footprint is a diagonal strip, so most of its bounding box costs nothing.
//   - only the cells that changed are uploaded (DataArrayTexture.layerUpdates).
//     This is the big one: re-uploading one whole 4.2 MB mask measured 10.7 ms,
//     which was ten times the cost of the splatting that filled it. A cell is
//     256 kB.
//
// The cost is otherwise arranged so there is none to speak of:
//   - no extra downloads. Tiles are splatted as the renderer loads them anyway.
//   - no per-frame cost once quiet. Work happens only while the queue is non-empty.
//   - no hitches while busy. Each frame spends a fixed point budget and stops, so
//     the ~3 M point overview spreads over a couple of seconds instead of locking up
//     one frame. Measured at ~50 ns per point, so the budget sets the cost: 20k
//     works out around 1 ms. An earlier attempt splatted on the GPU every time
//     tiles changed and cost 26 s per frame; this is the same idea on the CPU.
//   - no growth over the session. Refinement tiles keep arriving as the camera
//     moves, but nearly all land on ground their ancestors already covered, and
//     those are dropped after a 64 point probe — see isRedundant.
//   - coverage only ever grows, so unloading a tile never takes it away and the
//     mask cannot flicker.
//
// Because it accumulates, the mask also sharpens by itself: the overview LOD covers
// the whole footprint at ~4 m sampling within a second or two, and every finer tile
// the camera pulls in refines the edges for free.
import * as THREE from 'three'

export interface GroundPatchMask {
  /** Coverage per cell, one array layer each. 0 outside the data, 1 inside. */
  texture: THREE.DataArrayTexture
  /**
   * Which layer holds each lattice cell, as layer + 1, with 0 meaning "no data
   * here". Nearest-filtered and read as integers — this is a lookup table, not an
   * image, so any interpolation between neighbours would be meaningless.
   */
  index: THREE.DataTexture
  /**
   * Lattice shape the material needs to turn a position into a cell. `indexSize` is
   * the index map's fixed edge length, which is what the shader divides by — not
   * cols/rows, because the map is allocated once at full size and only partly used.
   */
  grid: {
    cols: number; rows: number; cellSizeM: number
    originX: number; originY: number; indexSize: number
  }
  /**
   * Size the lattice from the tileset's node boxes and keep the ENU frame for
   * splatting. Resolves to the number of boxes it was derived from, or 0 when the
   * tileset carries nothing usable — callers should treat 0 as "leave the patch
   * off" rather than as an error.
   *
   * Only the extent, not the coverage: the boxes are far too coarse for that (see
   * above), but they bound the survey exactly and cost 27 small JSON fetches. The
   * lattice has to be settled before any point can be placed in it, so tiles that
   * arrive first are queued and drained once this resolves.
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
  /** Spend this frame's budget on the queue and upload whatever changed. */
  update(): void
  /**
   * Throw away all accumulated coverage and start over from the given tiles.
   *
   * The coverage texture is write-once per pixel: a pixel is set to 255 and never
   * revisited, which is what makes splatting cheap. The cost is that a single frame of
   * wrong input is baked in permanently — and the floating origin can produce exactly
   * that, because a rebase moves every world matrix between one frame and the next.
   * Left alone that shows up as a staircase of stale patches, one step per rebase.
   *
   * So on rebase the caller discards and re-splats. It is not cheap — every resident
   * tile is walked again — but a rebase is rare and the alternative is a mask that can
   * never recover from one bad frame.
   */
  reset(tiles: Iterable<THREE.Object3D>): void
  /** Cells in use, of those available — for diagnostics and the console report. */
  stats(): { cellsUsed: number; cellsAvailable: number; metresPerPixel: number }
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
  /** Pixels per cell edge. A cell is cellPx^2 bytes — 512 is 256 kB. */
  cellPx: number
  /**
   * Ground resolution, held constant no matter how large the surveyed area grows.
   * The river is the binding constraint: it runs 30 m wide in places, and needs to
   * stay several pixels across to read as a channel rather than a dotted line.
   */
  metresPerPixel: number
  /**
   * How many cells may hold data at once. Cells are handed out on demand, so this
   * is a ceiling on memory (cellPx^2 x maxCells) rather than an allocation of it —
   * but the array texture itself is sized from it, so it is not free either.
   */
  maxCells: number
  /**
   * Edge length of the index map, in cells, and so the largest lattice this can
   * address. Fixed up front and never resized: the basemap materials bind the
   * texture object, and three keys the GPU texture to that object, so growing it
   * later would not reach the GPU. It costs indexSize^2 bytes — 64 is 4 kB and spans
   * 164 km at the default cell size, which is a whole area with room to spare.
   */
  indexSize: number
  /**
   * Pixels each point is grown by. The overview LOD samples about one point per
   * pixel, and Poisson gaps in that leave roughly a tenth of the interior speckled
   * without any growth, so 1 buys a solid surface. It also costs the river a pixel
   * on each bank, which at this resolution it can afford — and 0 is available for
   * anyone who would rather have the speckle.
   */
  splatRadiusPx: number
  /**
   * Points splatted per frame — the ceiling on what this can ever cost in one frame.
   * Measured at roughly 50 ns per point, so 20k is about 1 ms.
   */
  pointsPerFrame: number
  /**
   * Shortest gap between uploads while coverage is still arriving. Far less critical
   * than it was before tiling — a changed cell is 256 kB, not the whole mask — but
   * still worth batching, since a burst of tiles usually touches the same few cells.
   * The last upload is never delayed: an empty queue publishes immediately.
   */
  uploadIntervalMs: number
}): GroundPatchMask {
  const {
    cellPx, metresPerPixel, maxCells, indexSize, splatRadiusPx, pointsPerFrame, uploadIntervalMs,
  } = opts
  const cellSizeM = cellPx * metresPerPixel

  // One flat buffer, addressed as maxCells layers of cellPx^2. Allocated and
  // registered up front, then filled in place: the basemap materials bind these
  // texture objects before the tileset is even fetched, so replacing them later
  // would leave the materials on an empty mask.
  const cells = new Uint8Array(cellPx * cellPx * maxCells)
  const texture = new THREE.DataArrayTexture(cells, cellPx, cellPx, maxCells)
  texture.format = THREE.RedFormat
  texture.type = THREE.UnsignedByteType
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true

  // Full size from the start, and only partly used: see indexSize. Zero everywhere
  // means "no data", so this is already a valid mask before the tileset arrives.
  const indexData = new Uint8Array(indexSize * indexSize)
  const index = new THREE.DataTexture(indexData, indexSize, indexSize, THREE.RedFormat, THREE.UnsignedByteType)
  index.minFilter = THREE.NearestFilter
  index.magFilter = THREE.NearestFilter
  index.wrapS = THREE.ClampToEdgeWrapping
  index.wrapT = THREE.ClampToEdgeWrapping
  index.needsUpdate = true

  const grid = { cols: 0, rows: 0, cellSizeM, originX: 0, originY: 0, indexSize }

  let enuInverse: THREE.Matrix4 | null = null
  let cellsUsed = 0
  let indexDirty = false
  let lastUploadMs = -Infinity
  /** Layers touched since the last upload — exactly what gets sent. */
  const dirtyCells = new Set<number>()

  /** Tiles waiting for the extent, or for their turn at the frame budget. */
  const queue: THREE.Object3D[] = []
  /** How far into the head of the queue the last frame got. */
  let cursor = 0

  const localToEnu = new THREE.Matrix4()

  /** ENU x of a local point, from the matrix elements directly. */
  function enuX(a: ArrayLike<number>, o: number, e: number[]): number {
    return e[0] * a[o] + e[4] * a[o + 1] + e[8] * a[o + 2] + e[12]
  }
  /** ENU y of a local point. */
  function enuY(a: ArrayLike<number>, o: number, e: number[]): number {
    return e[1] * a[o] + e[5] * a[o + 1] + e[9] * a[o + 2] + e[13]
  }

  /**
   * Layer holding this lattice cell, allocating one if the cell is new, or -1 when
   * the budget is spent. Returning -1 rather than growing keeps the failure to a
   * missing patch in one corner instead of a reallocation mid-frame; the console
   * report says when it happens.
   */
  function layerFor(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return -1
    const slot = row * indexSize + col
    const existing = indexData[slot]
    if (existing !== 0) return existing - 1
    if (cellsUsed >= maxCells || cellsUsed >= 255) return -1
    const layer = cellsUsed++
    indexData[slot] = layer + 1
    indexDirty = true
    return layer
  }

  /**
   * Splat up to `budget` points and report how many were consumed. Reads the matrix
   * elements directly: this is the one genuinely hot loop here, and a Vector3 round
   * trip per point would dominate it.
   */
  function splat(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
                 from: number, budget: number): number {
    const array = position.array as ArrayLike<number>
    const stride = (position as any).itemSize ?? 3
    const e = localToEnu.elements as unknown as number[]
    const end = Math.min(position.count, from + budget)
    const r = splatRadiusPx
    const layerStride = cellPx * cellPx
    for (let i = from; i < end; i++) {
      const o = i * stride
      // Only x and y are needed — the mask is a plan view — so the z row of the
      // multiply is skipped entirely.
      const gx = (enuX(array, o, e) - grid.originX) / metresPerPixel
      const gy = (enuY(array, o, e) - grid.originY) / metresPerPixel
      // Lattice-wide pixel coordinates, then split into cell and pixel-within-cell.
      // The grow radius can push a point over a cell edge, so each written pixel is
      // resolved on its own rather than assuming one cell per point.
      const px0 = (gx | 0) - r, px1 = (gx | 0) + r
      const py0 = (gy | 0) - r, py1 = (gy | 0) + r
      for (let py = py0; py <= py1; py++) {
        const row = (py / cellPx) | 0
        const inRow = py - row * cellPx
        if (py < 0 || row >= grid.rows) continue
        for (let px = px0; px <= px1; px++) {
          const col = (px / cellPx) | 0
          if (px < 0 || col >= grid.cols) continue
          const layer = layerFor(col, row)
          if (layer < 0) continue
          const at = layer * layerStride + inRow * cellPx + (px - col * cellPx)
          if (cells[at] !== 255) { cells[at] = 255; dirtyCells.add(layer) }
        }
      }
    }
    return end - from
  }

  /**
   * True when a spread sample of the tile lands entirely on covered pixels.
   *
   * This is what keeps the cost from growing with the session. Refinement tiles
   * arrive constantly as the camera moves, and almost all sit inside ground their
   * ancestors already covered, so splatting them changes nothing. Skipping them is
   * safe in both directions: coverage only ever grows, so a skipped tile can only
   * cost extra growth, never take any away — and the river stays open because it is
   * defined by the *absence* of points, which no tile can undo.
   */
  function isRedundant(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): boolean {
    const array = position.array as ArrayLike<number>
    const stride = (position as any).itemSize ?? 3
    const e = localToEnu.elements as unknown as number[]
    const probes = 64
    if (position.count < probes * 4) return false // too small to judge from a sample
    const step = Math.floor(position.count / probes)
    const layerStride = cellPx * cellPx
    for (let p = 0; p < probes; p++) {
      const o = p * step * stride
      const px = ((enuX(array, o, e) - grid.originX) / metresPerPixel) | 0
      const py = ((enuY(array, o, e) - grid.originY) / metresPerPixel) | 0
      if (px < 0 || py < 0) return false
      const col = (px / cellPx) | 0, row = (py / cellPx) | 0
      if (col >= grid.cols || row >= grid.rows) return false
      // Reads the index directly rather than through layerFor: probing must not
      // allocate, or a tile that turns out redundant would still claim a cell.
      const slot = indexData[row * indexSize + col]
      if (slot === 0) return false
      const at = (slot - 1) * layerStride + (py - row * cellPx) * cellPx + (px - col * cellPx)
      if (cells[at] !== 255) return false
    }
    return true
  }

  return {
    texture,
    index,
    grid,

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
      const subtrees = await Promise.all(children.map(async (child) => {
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

      for (const subtree of subtrees) {
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
      // back to its top-level box rather than cropping the lattice short of it.
      for (let i = 0; i < children.length; i++) {
        if (subtrees[i]) continue
        const box = readBox(children[i], rootToEnu, scratch)
        if (box) boxes.push(box)
      }
      if (!boxes.length) return 0

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const b of boxes) {
        minX = Math.min(minX, b.cx - b.hx); maxX = Math.max(maxX, b.cx + b.hx)
        minY = Math.min(minY, b.cy - b.hy); maxY = Math.max(maxY, b.cy + b.hy)
      }
      // A margin of one cell, so coverage never reaches the lattice edge, where
      // clamped sampling would turn it into a hard straight line.
      //
      // Snapped outward to the lattice: cell boundaries are multiples of cellSizeM
      // from the ENU origin, never relative to this bounding box. That is what makes
      // the layout stable — a later, larger survey adds cells around these instead
      // of renumbering them, and two areas sharing an origin agree on the lattice.
      grid.originX = Math.floor(minX / cellSizeM - 1) * cellSizeM
      grid.originY = Math.floor(minY / cellSizeM - 1) * cellSizeM
      grid.cols = Math.min(indexSize, Math.ceil((maxX + cellSizeM - grid.originX) / cellSizeM))
      grid.rows = Math.min(indexSize, Math.ceil((maxY + cellSizeM - grid.originY) / cellSizeM))

      indexData.fill(0)
      index.needsUpdate = true
      cellsUsed = 0

      const footprintCells = Math.ceil((maxX - minX) / cellSizeM) * Math.ceil((maxY - minY) / cellSizeM)
      const report = `${grid.cols}x${grid.rows} cells of ${cellPx}px at ${metresPerPixel} m/px`
        + ` (${(cellSizeM / 1000).toFixed(1)} km each) over `
        + `${((maxX - minX) / 1000).toFixed(1)}x${((maxY - minY) / 1000).toFixed(1)} km`
      if (grid.cols >= indexSize || grid.rows >= indexSize) {
        console.warn(`[ground-patch] ${report} — the lattice hit the ${indexSize}x${indexSize} index `
          + `limit and is cropped. Raise design.groundPatch.maskIndexSize.`)
      } else if (footprintCells > maxCells) {
        // Not fatal: cells are handed out until the budget runs out, so the patch
        // simply stops somewhere. Worth being loud about, because the symptom —
        // basemap showing under points in one corner — looks like a shader bug.
        console.warn(`[ground-patch] ${report} — the footprint could need up to ${footprintCells} cells `
          + `but only ${maxCells} are available. Raise design.groundPatch.maskMaxCells.`)
      } else {
        console.info(`[ground-patch] ${report}`)
      }

      enuInverse = inverse
      return boxes.length
    },

    addTile(object) {
      queue.push(object)
    },

    update() {
      if (!enuInverse || (!queue.length && !dirtyCells.size && !indexDirty)) return
      let budget = pointsPerFrame
      while (budget > 0 && queue.length) {
        const object = queue[0]
        const position = (object as any).geometry?.getAttribute?.('position')
        if (!position) { queue.shift(); cursor = 0; continue }
        // Composed now rather than at load time: the tile's place in the world is
        // only settled once the renderer has parented it and updated the graph.
        object.updateWorldMatrix(true, false)
        localToEnu.multiplyMatrices(enuInverse, object.matrixWorld)
        if (cursor === 0 && isRedundant(position)) { queue.shift(); continue }
        const done = splat(position, cursor, budget)
        budget -= done
        cursor += done
        if (cursor >= position.count) { queue.shift(); cursor = 0 }
      }

      if (!dirtyCells.size && !indexDirty) return
      // Batched while coverage is still arriving, then published at once when the
      // queue drains. A burst of tiles usually touches the same few cells, so
      // waiting collapses many uploads into one. The mask landing a fraction of a
      // second late is invisible — the cloud covers that ground anyway.
      const now = performance.now()
      if (queue.length && now - lastUploadMs < uploadIntervalMs) return
      if (dirtyCells.size) {
        // Only the cells that changed. This is what tiling buys: the whole array is
        // maxCells x 256 kB, and sending all of it was the single most expensive
        // thing this module did.
        for (const layer of dirtyCells) texture.addLayerUpdate(layer)
        texture.needsUpdate = true
        dirtyCells.clear()
      }
      if (indexDirty) { index.needsUpdate = true; indexDirty = false }
      lastUploadMs = now
    },

    reset(tiles) {
      cells.fill(0)
      indexData.fill(0)
      cellsUsed = 0
      indexDirty = true
      queue.length = 0
      cursor = 0
      // Every layer has to go back to the GPU, not just the ones that were dirty:
      // the old contents are still resident up there.
      for (let layer = 0; layer < maxCells; layer++) dirtyCells.add(layer)
      lastUploadMs = -Infinity
      for (const object of tiles) queue.push(object)
    },
    stats() {
      return { cellsUsed, cellsAvailable: maxCells, metresPerPixel }
    },

    dispose() {
      queue.length = 0
      texture.dispose()
      index.dispose()
    },
  }
}
