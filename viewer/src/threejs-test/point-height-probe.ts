import * as THREE from 'three'

/** A small, spatially indexed sample of a resident tile. Built during streaming,
 * so pressing the mouse does not traverse millions of raw points or sort them. */
export class PointHeightProbe {
  private cells = new Map<string, number[]>()
  private minX = Infinity
  private minY = Infinity
  private maxX = -Infinity
  private maxY = -Infinity
  readonly matrix: THREE.Matrix4
  private readonly cellSize = 32

  constructor(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, matrix: THREE.Matrix4, limit: number) {
    this.matrix = matrix.clone()
    const stride = Math.max(1, Math.floor(attribute.count / limit))
    const point = new THREE.Vector3()
    for (let i = 0; i < attribute.count; i += stride) {
      point.fromBufferAttribute(attribute, i).applyMatrix4(matrix)
      const x = Math.floor(point.x / this.cellSize)
      const y = Math.floor(point.y / this.cellSize)
      const key = `${x},${y}`
      let cell = this.cells.get(key)
      if (!cell) { cell = []; this.cells.set(key, cell) }
      cell.push(point.x, point.y, point.z)
      this.minX = Math.min(this.minX, x); this.maxX = Math.max(this.maxX, x)
      this.minY = Math.min(this.minY, y); this.maxY = Math.max(this.maxY, y)
    }
  }

  matches(matrix: THREE.Matrix4): boolean {
    // ENU coordinates do not change on a floating-origin rebase. Ignore the
    // sub-micrometre roundoff from multiplying the two rebased matrices.
    return this.matrix.elements.every((v, i) => Math.abs(v - matrix.elements[i]) < 1e-6)
  }

  collect(cx: number, cy: number, radius: number, heights: number[], support: Uint8Array): void {
    const x0 = Math.max(this.minX, Math.floor((cx - radius) / this.cellSize))
    const x1 = Math.min(this.maxX, Math.floor((cx + radius) / this.cellSize))
    const y0 = Math.max(this.minY, Math.floor((cy - radius) / this.cellSize))
    const y1 = Math.min(this.maxY, Math.floor((cy + radius) / this.cellSize))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const cell = this.cells.get(`${x},${y}`)
      if (!cell) continue
      for (let i = 0; i < cell.length; i += 3) {
        const dx = cell[i] - cx; const dy = cell[i + 1] - cy
        if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue
        heights.push(cell[i + 2])
        const col = Math.min(4, Math.max(0, Math.floor((dx / radius + 1) * 2.5)))
        const row = Math.min(4, Math.max(0, Math.floor((dy / radius + 1) * 2.5)))
        support[row * 5 + col] = 1
      }
    }
  }
}

/** Select the same order statistic as sorting, without sorting the full probe. */
export function heightPercentile(values: number[], fraction: number): number {
  const k = Math.min(values.length - 1, Math.max(0, Math.floor(values.length * fraction)))
  let lo = 0; let hi = values.length - 1
  while (lo < hi) {
    const pivot = values[(lo + hi) >>> 1]
    let i = lo; let j = hi
    while (i <= j) {
      while (values[i] < pivot) i++
      while (values[j] > pivot) j--
      if (i <= j) { [values[i], values[j]] = [values[j], values[i]]; i++; j-- }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else break
  }
  return values[k]
}
