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

/** Trilinear value noise on an integer lattice of `period` cells, tiling seamlessly. */
function valueNoise(x: number, y: number, z: number, period: number): number {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z)
  const xf = x - xi; const yf = y - yi; const zf = z - zi
  const x0 = ((xi % period) + period) % period
  const y0 = ((yi % period) + period) % period
  const z0 = ((zi % period) + period) % period
  const x1 = (x0 + 1) % period
  const y1 = (y0 + 1) % period
  const z1 = (z0 + 1) % period
  const c000 = hash3(x0, y0, z0); const c100 = hash3(x1, y0, z0)
  const c010 = hash3(x0, y1, z0); const c110 = hash3(x1, y1, z0)
  const c001 = hash3(x0, y0, z1); const c101 = hash3(x1, y0, z1)
  const c011 = hash3(x0, y1, z1); const c111 = hash3(x1, y1, z1)
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
    sum += valueNoise(x * frequency, y * frequency, z * frequency, basePeriod * frequency) * amplitude
    norm += amplitude
    amplitude *= 0.5
    frequency *= 2
  }
  return sum / norm
}

/** Inverted Worley (cellular) noise: 1 at cell centres, 0 at cell borders. Tiles. */
function worley(x: number, y: number, z: number, period: number): number {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z)
  let minimum = 8
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx; const cy = yi + dy; const cz = zi + dz
        const wx = ((cx % period) + period) % period
        const wy = ((cy % period) + period) % period
        const wz = ((cz % period) + period) % period
        const px = cx + hash3(wx, wy, wz)
        const py = cy + hash3(wx + 91, wy + 17, wz + 43)
        const pz = cz + hash3(wx + 233, wy + 71, wz + 151)
        const distance = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2
        if (distance < minimum) minimum = distance
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(minimum))
}

export function createCloudNoiseTexture(size: number): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size)
  const centre = (size - 1) * 0.5
  const fbmPeriod = 5
  const worleyPeriod = 7
  let index = 0
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x - centre) / centre
        const ny = (y - centre) / centre
        const nz = (z - centre) / centre
        // Ellipsoid envelope keeps density inside the field box (flat in z).
        const envelope = THREE.MathUtils.clamp(1 - (nx * nx * 0.62 + ny * ny * 1.45 + nz * nz * 0.62), 0, 1)
        const u = x / size
        const v = y / size
        const w = z / size
        const base = fbm(u * fbmPeriod, v * fbmPeriod, w * fbmPeriod, fbmPeriod, 4)
        const erosion = worley(u * worleyPeriod, v * worleyPeriod, w * worleyPeriod, worleyPeriod)
        // Billowy cauliflower look: FBM body carved by cellular pockets.
        const density = THREE.MathUtils.clamp((base - erosion * 0.28) * 1.5 - 0.12, 0, 1)
        data[index++] = Math.round(density * envelope * 255)
      }
    }
  }
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
