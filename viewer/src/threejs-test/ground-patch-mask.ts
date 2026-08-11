// Coverage mask for the flat ground under the point cloud.
//
// The survey bbox is a poor stand-in for where point data actually is: this
// dataset spans 12.8 x 8.5 km but fills it with 27 irregular cells, so a
// rectangle paints solid colour over large areas that hold nothing. The mask
// rasterises those cells instead, and the basemap material samples it.
//
// Deliberately a small CPU-built texture rather than a shader loop over cells:
// 27 rectangle tests per imagery fragment would be wasteful and would need
// rebuilding whenever the cell count changes, while one texture lookup costs the
// same no matter how the dataset is shaped.
import * as THREE from 'three'

export interface GroundPatchMask {
  /** R8 coverage, 0 outside the data, 255 well inside, blurred across the edge
   * so the material can threshold it into shrink + softness. */
  texture: THREE.DataTexture
  /** ENU rectangle the texture spans; the material maps ENU xy into UV with it. */
  center: THREE.Vector2
  halfExtent: THREE.Vector2
  /**
   * Fill from the point tileset's top-level cells. Returns the cell count, or 0
   * when the tileset is not loaded yet or carries no usable boxes — callers should
   * treat 0 as "leave the patch disabled" rather than as an error, since the
   * basemap materials are built before the point tileset root arrives.
   */
  buildFrom(rootTileSet: any, enuInverse: THREE.Matrix4): number
  dispose(): void
}

/** One cell footprint, axis-aligned in the survey's ENU frame. */
interface Cell { cx: number; cy: number; hx: number; hy: number }

/**
 * Read the top-level cells as ENU rectangles.
 *
 * 3D Tiles `box` is a centre plus three half-axis vectors. The tileset's root
 * transform is the rigid ENU-to-ECEF placement, so mapping a centre through it
 * and back into ENU is exact, and the boxes stay axis-aligned on the way — which
 * is why the half-extents can be taken per axis without re-deriving them.
 */
function readCells(rootTileSet: any, enuInverse: THREE.Matrix4): Cell[] {
  const root = rootTileSet?.root
  const children: any[] = root?.children ?? []
  if (!children.length) return []

  const localToEcef = new THREE.Matrix4()
  if (Array.isArray(root.transform) && root.transform.length === 16) {
    localToEcef.fromArray(root.transform)
  }
  const localToEnu = new THREE.Matrix4().multiplyMatrices(enuInverse, localToEcef)

  const centre = new THREE.Vector3()
  const cells: Cell[] = []
  for (const child of children) {
    const box: number[] | undefined = child?.boundingVolume?.box
    if (!box || box.length < 12) continue
    centre.set(box[0], box[1], box[2]).applyMatrix4(localToEnu)
    // Half-extent per world axis: the largest contribution any half-axis makes to
    // it. For axis-aligned boxes this is just the matching component; for a
    // rotated one it is the enclosing axis-aligned extent, which errs outward and
    // is then pulled back in by the shrink control.
    const hx = Math.max(Math.abs(box[3]), Math.abs(box[6]), Math.abs(box[9]))
    const hy = Math.max(Math.abs(box[4]), Math.abs(box[7]), Math.abs(box[10]))
    if (hx <= 0 || hy <= 0) continue
    cells.push({ cx: centre.x, cy: centre.y, hx, hy })
  }
  return cells
}

/** Separable box blur, run twice for a smoother falloff than a single pass. */
function blur(data: Uint8Array, size: number, radius: number): void {
  if (radius < 1) return
  const tmp = new Uint8Array(data.length)
  const window = radius * 2 + 1
  for (let pass = 0; pass < 2; pass++) {
    // horizontal
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0
        for (let k = -radius; k <= radius; k++) {
          const sx = Math.min(size - 1, Math.max(0, x + k))
          sum += data[y * size + sx]
        }
        tmp[y * size + x] = sum / window
      }
    }
    // vertical
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0
        for (let k = -radius; k <= radius; k++) {
          const sy = Math.min(size - 1, Math.max(0, y + k))
          sum += tmp[sy * size + x]
        }
        data[y * size + x] = sum / window
      }
    }
  }
}

export function createGroundPatchMask(size = 256, blurRadiusPx = 5): GroundPatchMask {
  const data = new Uint8Array(size * size)
  // Allocated and registered up front, then refilled in place. The basemap
  // materials bind this texture object once, before the point tileset has
  // loaded, so replacing the object later would leave them on a stale mask.
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true

  const center = new THREE.Vector2(0, 0)
  const halfExtent = new THREE.Vector2(1, 1)

  return {
    texture,
    center,
    halfExtent,
    buildFrom(rootTileSet, enuInverse) {
      const cells = readCells(rootTileSet, enuInverse)
      if (!cells.length) return 0

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const c of cells) {
        minX = Math.min(minX, c.cx - c.hx); maxX = Math.max(maxX, c.cx + c.hx)
        minY = Math.min(minY, c.cy - c.hy); maxY = Math.max(maxY, c.cy + c.hy)
      }
      // Margin so the blur has room to fall to zero instead of being clamped at
      // the texture border, which would leave a hard edge around the whole mask.
      const marginX = (maxX - minX) * 0.06
      const marginY = (maxY - minY) * 0.06
      minX -= marginX; maxX += marginX; minY -= marginY; maxY += marginY
      center.set((minX + maxX) / 2, (minY + maxY) / 2)
      halfExtent.set((maxX - minX) / 2, (maxY - minY) / 2)

      data.fill(0)
      const metresPerPixelX = (maxX - minX) / size
      const metresPerPixelY = (maxY - minY) / size
      for (const c of cells) {
        const x0 = Math.max(0, Math.floor((c.cx - c.hx - minX) / metresPerPixelX))
        const x1 = Math.min(size - 1, Math.ceil((c.cx + c.hx - minX) / metresPerPixelX))
        const y0 = Math.max(0, Math.floor((c.cy - c.hy - minY) / metresPerPixelY))
        const y1 = Math.min(size - 1, Math.ceil((c.cy + c.hy - minY) / metresPerPixelY))
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) data[y * size + x] = 255
        }
      }
      blur(data, size, blurRadiusPx)
      texture.needsUpdate = true
      return cells.length
    },
    dispose() { texture.dispose() },
  }
}
