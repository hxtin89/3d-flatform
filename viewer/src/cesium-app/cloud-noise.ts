// Shared procedural density source for Cesium's volume clouds and the canopy
// shadow sampler. The math mirrors src/threejs-test/cloud-noise.ts, but bakes
// WebGL2-friendly 2D assets instead of a sampler3D.

export interface CloudNoiseAtlas {
  atlas: Uint8Array
  atlasWidth: number
  atlasHeight: number
  sliceSize: number
  slices: number
  columns: number
  rows: number
  slice(wIndex: number): Uint8Array
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function hash3(x: number, y: number, z: number): number {
  let h = (x * 374_761_393 + y * 668_265_263 + z * 1_440_662_683) | 0
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177)
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_295
}

function smoothLerp(a: number, b: number, t: number): number {
  const s = t * t * (3 - 2 * t)
  return a + (b - a) * s
}

/** Trilinear value noise on an integer lattice, wrapped to `period` cells. */
function valueNoise(x: number, y: number, z: number, period: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const xf = x - xi
  const yf = y - yi
  const zf = z - zi
  const x0 = ((xi % period) + period) % period
  const y0 = ((yi % period) + period) % period
  const z0 = ((zi % period) + period) % period
  const x1 = (x0 + 1) % period
  const y1 = (y0 + 1) % period
  const z1 = (z0 + 1) % period
  const c000 = hash3(x0, y0, z0)
  const c100 = hash3(x1, y0, z0)
  const c010 = hash3(x0, y1, z0)
  const c110 = hash3(x1, y1, z0)
  const c001 = hash3(x0, y0, z1)
  const c101 = hash3(x1, y0, z1)
  const c011 = hash3(x0, y1, z1)
  const c111 = hash3(x1, y1, z1)
  return smoothLerp(
    smoothLerp(smoothLerp(c000, c100, xf), smoothLerp(c010, c110, xf), yf),
    smoothLerp(smoothLerp(c001, c101, xf), smoothLerp(c011, c111, xf), yf),
    zf,
  )
}

function fbm(x: number, y: number, z: number, basePeriod: number, octaves: number): number {
  let amplitude = 0.5
  let frequency = 1
  let sum = 0
  let norm = 0
  for (let octave = 0; octave < octaves; octave++) {
    sum += valueNoise(
      x * frequency,
      y * frequency,
      z * frequency,
      basePeriod * frequency,
    ) * amplitude
    norm += amplitude
    amplitude *= 0.5
    frequency *= 2
  }
  return sum / norm
}

/** Inverted tiled Worley noise: one at cell centres, zero at cell borders. */
function worley(x: number, y: number, z: number, period: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  let minimum = 8
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx
        const cy = yi + dy
        const cz = zi + dz
        const wx = ((cx % period) + period) % period
        const wy = ((cy % period) + period) % period
        const wz = ((cz % period) + period) % period
        const px = cx + hash3(wx, wy, wz)
        const py = cy + hash3(wx + 91, wy + 17, wz + 43)
        const pz = cz + hash3(wx + 233, wy + 71, wz + 151)
        const distance = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2
        minimum = Math.min(minimum, distance)
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(minimum))
}

function densityAt(
  u: number,
  v: number,
  w: number,
  nx: number,
  ny: number,
  nz: number,
): number {
  const envelope = clamp01(1 - (nx * nx * 0.62 + ny * ny * 1.45 + nz * nz * 0.62))
  const fbmPeriod = 5
  const worleyPeriod = 7
  const base = fbm(u * fbmPeriod, v * fbmPeriod, w * fbmPeriod, fbmPeriod, 4)
  const erosion = worley(
    u * worleyPeriod,
    v * worleyPeriod,
    w * worleyPeriod,
    worleyPeriod,
  )
  const density = clamp01((base - erosion * 0.28) * 1.5 - 0.12)
  return Math.round(density * envelope * 255)
}

function checkedDimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 2) {
    throw new RangeError(`${label} must be an integer of at least 2`)
  }
  return value
}

export function createCloudNoiseAtlas(size: number, sliceCount: number): CloudNoiseAtlas {
  const sliceSize = checkedDimension(size, 'cloud noise size')
  const slices = checkedDimension(sliceCount, 'cloud noise slice count')
  const columns = Math.ceil(Math.sqrt(slices))
  const rows = Math.ceil(slices / columns)
  const atlasWidth = columns * sliceSize
  const atlasHeight = rows * sliceSize
  const atlas = new Uint8Array(atlasWidth * atlasHeight)
  const centreXy = (sliceSize - 1) * 0.5
  const centreZ = (slices - 1) * 0.5

  for (let z = 0; z < slices; z++) {
    const tileX = (z % columns) * sliceSize
    const tileY = Math.floor(z / columns) * sliceSize
    const nz = (z - centreZ) / centreZ
    const w = z / slices
    for (let y = 0; y < sliceSize; y++) {
      const ny = (y - centreXy) / centreXy
      const v = y / sliceSize
      const row = (tileY + y) * atlasWidth + tileX
      for (let x = 0; x < sliceSize; x++) {
        const nx = (x - centreXy) / centreXy
        atlas[row + x] = densityAt(x / sliceSize, v, w, nx, ny, nz)
      }
    }
  }

  return {
    atlas,
    atlasWidth,
    atlasHeight,
    sliceSize,
    slices,
    columns,
    rows,
    slice(wIndex) {
      const index = ((Math.floor(wIndex) % slices) + slices) % slices
      const tileX = (index % columns) * sliceSize
      const tileY = Math.floor(index / columns) * sliceSize
      const result = new Uint8Array(sliceSize * sliceSize)
      for (let y = 0; y < sliceSize; y++) {
        const sourceStart = (tileY + y) * atlasWidth + tileX
        result.set(atlas.subarray(sourceStart, sourceStart + sliceSize), y * sliceSize)
      }
      return result
    },
  }
}

/** Fixed w=0.5 density slice used by the point-cloud canopy shadow shader. */
export function createShadowSlice(size: number): Uint8Array {
  const textureSize = checkedDimension(size, 'cloud shadow size')
  const data = new Uint8Array(textureSize * textureSize)
  const centre = (textureSize - 1) * 0.5
  // Match repeat+linear 3D texture semantics at w=0.5: the coordinate lies
  // between voxel centres for even sizes, so interpolate the neighbouring
  // generated z slices before the point shader performs its 2D x/y filtering.
  const gridZ = 0.5 * textureSize - 0.5
  const z0 = Math.floor(gridZ)
  const z1 = (z0 + 1) % textureSize
  const zAmount = gridZ - z0
  for (let y = 0; y < textureSize; y++) {
    const ny = (y - centre) / centre
    const v = y / textureSize
    for (let x = 0; x < textureSize; x++) {
      const nx = (x - centre) / centre
      const density0 = densityAt(
        x / textureSize,
        v,
        z0 / textureSize,
        nx,
        ny,
        (z0 - centre) / centre,
      )
      const density1 = densityAt(
        x / textureSize,
        v,
        z1 / textureSize,
        nx,
        ny,
        (z1 - centre) / centre,
      )
      data[y * textureSize + x] = Math.round(
        density0 + (density1 - density0) * zAmount,
      )
    }
  }
  return data
}
