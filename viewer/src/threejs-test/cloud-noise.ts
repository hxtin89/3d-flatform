// Shared procedural cloud-density volume. One texture instance feeds both the
// volumetric cloud raymarch and the point-cloud canopy shadows so drifting
// shadows always match the clouds overhead. Bakes once at startup on the CPU:
// wrap-aware value-noise FBM eroded by an inverted Worley octave.
import * as THREE from 'three'

function hash3(x: number, y: number, z: number): number {
  let h = (x * 374_761_393 + y * 668_265_263 + z * 1_440_662_683) | 0
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177)
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_295
}

function smoothLerp(a: number, b: number, t: number): number {
  const s = t * t * (3 - 2 * t)
  return a + (b - a) * s
}

// The bake runs on the main thread during boot, so nothing is worked out twice. Each
// lattice corner and each Worley feature point depends on its wrapped cell alone, so
// they are hashed once into a table; and neighbouring voxels mostly fall in the same
// cell, so a voxel reuses the corners or feature points its predecessor fetched. Every
// value is the very double hash3 and the old sums produced, in the same order, so the
// texture's bytes are unchanged (cloud-noise.test.ts holds the bake to the direct
// version).

/** One octave's lattice: every cell's hash, x fastest, and the 8 corners of the cell
 *  the last voxel fell in. */
interface Lattice {
  period: number
  hashes: Float64Array
  cellX: number
  cellY: number
  cellZ: number
  corners: Float64Array
}

function lattice(period: number): Lattice {
  const hashes = new Float64Array(period * period * period)
  let index = 0
  for (let z = 0; z < period; z++) {
    for (let y = 0; y < period; y++) {
      for (let x = 0; x < period; x++) hashes[index++] = hash3(x, y, z)
    }
  }
  return { period, hashes, cellX: NaN, cellY: NaN, cellZ: NaN, corners: new Float64Array(8) }
}

/** Trilinear value noise on an integer lattice of `period` cells, tiling seamlessly. */
function valueNoise(x: number, y: number, z: number, lattice: Lattice): number {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z)
  const xf = x - xi; const yf = y - yi; const zf = z - zi
  const c = lattice.corners
  if (xi !== lattice.cellX || yi !== lattice.cellY || zi !== lattice.cellZ) {
    const { period, hashes } = lattice
    const x0 = ((xi % period) + period) % period
    const y0 = ((yi % period) + period) % period
    const z0 = ((zi % period) + period) % period
    const x1 = (x0 + 1) % period
    const y1 = (y0 + 1) % period
    const z1 = (z0 + 1) % period
    const row00 = (z0 * period + y0) * period; const row10 = (z0 * period + y1) * period
    const row01 = (z1 * period + y0) * period; const row11 = (z1 * period + y1) * period
    c[0] = hashes[row00 + x0]; c[1] = hashes[row00 + x1]; c[2] = hashes[row10 + x0]; c[3] = hashes[row10 + x1]
    c[4] = hashes[row01 + x0]; c[5] = hashes[row01 + x1]; c[6] = hashes[row11 + x0]; c[7] = hashes[row11 + x1]
    lattice.cellX = xi; lattice.cellY = yi; lattice.cellZ = zi
  }
  return smoothLerp(
    smoothLerp(smoothLerp(c[0], c[1], xf), smoothLerp(c[2], c[3], xf), yf),
    smoothLerp(smoothLerp(c[4], c[5], xf), smoothLerp(c[6], c[7], xf), yf),
    zf,
  )
}

/** `octaves[i]` is the lattice of period basePeriod * 2^i. */
function fbm(x: number, y: number, z: number, octaves: Lattice[]): number {
  let amplitude = 0.5
  let frequency = 1
  let sum = 0
  let norm = 0
  for (let octave = 0; octave < octaves.length; octave++) {
    sum += valueNoise(x * frequency, y * frequency, z * frequency, octaves[octave]) * amplitude
    norm += amplitude
    amplitude *= 0.5
    frequency *= 2
  }
  return sum / norm
}

/** The Worley lattice: each cell's feature-point offset as xyz triples, and the feature
 *  points of the 27 cells around the cell the last voxel fell in. */
interface FeatureLattice {
  period: number
  offsets: Float64Array
  cellX: number
  cellY: number
  cellZ: number
  points: Float64Array
}

function featureLattice(period: number): FeatureLattice {
  const offsets = new Float64Array(period * period * period * 3)
  let index = 0
  for (let wz = 0; wz < period; wz++) {
    for (let wy = 0; wy < period; wy++) {
      for (let wx = 0; wx < period; wx++) {
        offsets[index++] = hash3(wx, wy, wz)
        offsets[index++] = hash3(wx + 91, wy + 17, wz + 43)
        offsets[index++] = hash3(wx + 233, wy + 71, wz + 151)
      }
    }
  }
  return { period, offsets, cellX: NaN, cellY: NaN, cellZ: NaN, points: new Float64Array(27 * 3) }
}

/** Inverted Worley (cellular) noise: 1 at cell centres, 0 at cell borders. Tiles. */
function worley(x: number, y: number, z: number, lattice: FeatureLattice): number {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z)
  const points = lattice.points
  if (xi !== lattice.cellX || yi !== lattice.cellY || zi !== lattice.cellZ) {
    const { period, offsets } = lattice
    let index = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = xi + dx; const cy = yi + dy; const cz = zi + dz
          const wx = ((cx % period) + period) % period
          const wy = ((cy % period) + period) % period
          const wz = ((cz % period) + period) % period
          const cell = ((wz * period + wy) * period + wx) * 3
          points[index++] = cx + offsets[cell]
          points[index++] = cy + offsets[cell + 1]
          points[index++] = cz + offsets[cell + 2]
        }
      }
    }
    lattice.cellX = xi; lattice.cellY = yi; lattice.cellZ = zi
  }
  let minimum = 8
  for (let index = 0; index < points.length; index += 3) {
    const distance = (points[index] - x) ** 2 + (points[index + 1] - y) ** 2 + (points[index + 2] - z) ** 2
    if (distance < minimum) minimum = distance
  }
  return 1 - Math.min(1, Math.sqrt(minimum))
}

/** The density volume's bytes, `size`³, x fastest. */
export function bakeCloudDensity(size: number): Uint8Array {
  const data = new Uint8Array(size * size * size)
  const centre = (size - 1) * 0.5
  const fbmPeriod = 5
  const fbmOctaves = 4
  const worleyPeriod = 7
  const fbmLattices: Lattice[] = []
  for (let octave = 0; octave < fbmOctaves; octave++) fbmLattices.push(lattice(fbmPeriod * 2 ** octave))
  const worleyLattice = featureLattice(worleyPeriod)
  let index = 0
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x - centre) / centre
        const ny = (y - centre) / centre
        const nz = (z - centre) / centre
        // Ellipsoid envelope keeps density inside the field box (flat in z).
        const envelope = THREE.MathUtils.clamp(1 - (nx * nx * 0.62 + ny * ny * 1.45 + nz * nz * 0.62), 0, 1)
        // Outside it (about 40 % of the volume) the byte is 0 whatever the noise says.
        if (envelope === 0) { data[index++] = 0; continue }
        const u = x / size
        const v = y / size
        const w = z / size
        const base = fbm(u * fbmPeriod, v * fbmPeriod, w * fbmPeriod, fbmLattices)
        const erosion = worley(u * worleyPeriod, v * worleyPeriod, w * worleyPeriod, worleyLattice)
        // Billowy cauliflower look: FBM body carved by cellular pockets.
        const density = THREE.MathUtils.clamp((base - erosion * 0.28) * 1.5 - 0.12, 0, 1)
        data[index++] = Math.round(density * envelope * 255)
      }
    }
  }
  return data
}

export function createCloudNoiseTexture(size: number): THREE.Data3DTexture {
  const data = bakeCloudDensity(size)
  const texture = new THREE.Data3DTexture(data, size, size, size)
  texture.format = THREE.RedFormat
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.wrapR = THREE.RepeatWrapping
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  texture.name = 'wilderness-cloud-density'
  return texture
}
