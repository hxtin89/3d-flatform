// Noise for the sky's clouds (sky-clouds.ts), baked on the CPU — in a worker, see
// sky-cloud-noise.worker.ts — once per session, and tileable in every axis so the cloud field
// repeats without a seam.
//
//   · shape, `size`³ RG8: R is Perlin–Worley (Schneider's billowy base shape: gradient-noise
//     fBm remapped by inverted Worley so it bunches into cauliflower cells), G a finer Worley
//     fBm the bake erodes the edges with. Only the bake samples it, so 3D costs nothing per
//     frame (the research's point: 2D noise gives coverage, not cumulus).
//   · weather, `size`² RGBA8, the 2D distribution the presets remap: R coverage fBm (where
//     clouds can be), G cumulus cells (where they clump), B a slow field that varies the cloud
//     type and height across the sky, A a fine field for wisps and rain streaks.
// The same field drives the dome and the cloud shadows on the ground, so they match.

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374_761_393 + y * 668_265_263 + z * 2_147_483_647 + seed * 1_440_662_683) | 0
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177)
  h = Math.imul(h ^ (h >>> 15), 2_246_822_519)
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_295
}

const wrap = (i: number, period: number) => ((i % period) + period) % period
const quintic = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

// The twelve edge directions of a cube: Perlin's improved-noise gradient set.
const GRADIENTS_3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
  [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
]

/** Gradient noise on a wrapping lattice of `period` cells; roughly −1…1. */
export function perlin3(x: number, y: number, z: number, period: number, seed = 0): number {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z)
  const xf = x - xi; const yf = y - yi; const zf = z - zi
  const g = (dx: number, dy: number, dz: number) => {
    const h = GRADIENTS_3[(hash3(wrap(xi + dx, period), wrap(yi + dy, period), wrap(zi + dz, period), seed) * 12) | 0]
    return h[0] * (xf - dx) + h[1] * (yf - dy) + h[2] * (zf - dz)
  }
  const u = quintic(xf); const v = quintic(yf); const w = quintic(zf)
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  return lerp(
    lerp(lerp(g(0, 0, 0), g(1, 0, 0), u), lerp(g(0, 1, 0), g(1, 1, 0), u), v),
    lerp(lerp(g(0, 0, 1), g(1, 0, 1), u), lerp(g(0, 1, 1), g(1, 1, 1), u), v),
    w,
  )
}

/** Inverted Worley (F1) on a wrapping lattice: 1 at the feature points, 0 a cell away. */
export function worley3(x: number, y: number, z: number, period: number, seed = 0): number {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z)
  let minimum = 8
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx; const cy = yi + dy; const cz = zi + dz
        const wx = wrap(cx, period); const wy = wrap(cy, period); const wz = wrap(cz, period)
        const px = cx + hash3(wx, wy, wz, seed + 17) - x
        const py = cy + hash3(wx, wy, wz, seed + 71) - y
        const pz = cz + hash3(wx, wy, wz, seed + 131) - z
        const d = px * px + py * py + pz * pz
        if (d < minimum) minimum = d
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(minimum))
}

function fbm3(noise: (x: number, y: number, z: number, p: number, s: number) => number,
  x: number, y: number, z: number, period: number, octaves: number, seed: number, gain = 0.5): number {
  let amplitude = 1; let frequency = 1; let sum = 0; let norm = 0
  for (let o = 0; o < octaves; o++) {
    const p = period * frequency
    sum += noise(x * p, y * p, z * p, p, seed + o * 101) * amplitude
    norm += amplitude; amplitude *= gain; frequency *= 2
  }
  return sum / norm
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1)
const remap = (v: number, lo0: number, hi0: number, lo1: number, hi1: number) => lo1 + ((v - lo0) * (hi1 - lo1)) / (hi0 - lo0)

/** Stretch each channel of interleaved floats to bytes between its 1st and 99th percentile:
 *  the raw sums bunch into the middle of their range, which would waste most of the 8 bits. */
function normalise(raw: Float32Array, channels: number): Uint8Array {
  const out = new Uint8Array(raw.length)
  for (let c = 0; c < channels; c++) {
    const values: number[] = []
    for (let i = c; i < raw.length; i += channels * 7) values.push(raw[i])
    values.sort((a, b) => a - b)
    const lo = values[Math.floor(values.length * 0.01)]
    const hi = values[Math.min(values.length - 1, Math.floor(values.length * 0.99))]
    const scale = hi > lo ? 255 / (hi - lo) : 0
    for (let i = c; i < raw.length; i += channels) out[i] = Math.round(Math.min(Math.max((raw[i] - lo) * scale, 0), 255))
  }
  return out
}

/** RG8, `size`³: Perlin–Worley base shape and the Worley detail. Coordinates in [0, 1)³. */
export function bakeCloudShapeNoise(size = 96, seed = 7): Uint8Array {
  const raw = new Float32Array(size * size * size * 2)
  let index = 0
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size; const v = y / size; const w = z / size
        const perlin = clamp01(fbm3(perlin3, u, v, w, 4, 3, seed) * 0.7 + 0.5)
        const worley = fbm3(worley3, u, v, w, 4, 2, seed + 5, 0.5)
        raw[index++] = remap(perlin, worley - 1, 1, 0, 1)
        raw[index++] = fbm3(worley3, u, v, w, 8, 2, seed + 9, 0.5)
      }
    }
  }
  return normalise(raw, 2)
}

function hash2(x: number, y: number, seed: number): number {
  return hash3(x, y, 0, seed)
}

function perlin2(x: number, y: number, period: number, seed: number): number {
  return perlin3(x, y, 0.5, period, seed) * 1.2
}
function worley2(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x); const yi = Math.floor(y)
  let minimum = 8
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx; const cy = yi + dy
      const wx = wrap(cx, period); const wy = wrap(cy, period)
      const px = cx + hash2(wx, wy, seed + 17) - x
      const py = cy + hash2(wx, wy, seed + 71) - y
      const d = px * px + py * py
      if (d < minimum) minimum = d
    }
  }
  return 1 - Math.min(1, Math.sqrt(minimum))
}
function fbm2(noise: (x: number, y: number, p: number, s: number) => number, u: number, v: number,
  period: number, octaves: number, seed: number, gain = 0.5): number {
  let amplitude = 1; let frequency = 1; let sum = 0; let norm = 0
  for (let o = 0; o < octaves; o++) {
    const p = period * frequency
    sum += noise(u * p, v * p, p, seed + o * 101) * amplitude
    norm += amplitude; amplitude *= gain; frequency *= 2
  }
  return sum / norm
}

/** RGBA8, `size`²: coverage, cells, type field, fine field. Coordinates in [0, 1)². */
export function bakeCloudWeatherNoise(size = 256, seed = 11): Uint8Array {
  const raw = new Float32Array(size * size * 4)
  let index = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size; const v = y / size
      // Coverage: a domain-warped fBm, so cloud fields have ragged, flowing edges.
      const wu = fbm2(perlin2, u, v, 3, 2, seed + 900) * 0.08
      const wv = fbm2(perlin2, u, v, 3, 2, seed + 977) * 0.08
      raw[index++] = fbm2(perlin2, u + wu, v + wv, 4, 4, seed)
      raw[index++] = fbm2(worley2, u + wu * 0.5, v + wv * 0.5, 10, 2, seed + 3, 0.5)
      raw[index++] = fbm2(perlin2, u, v, 2, 2, seed + 7)
      raw[index++] = fbm2(perlin2, u, v, 24, 2, seed + 13)
    }
  }
  return normalise(raw, 4)
}

export type CloudNoiseRequest =
  | { id: number; kind: 'shape'; size: number; seed: number }
  | { id: number; kind: 'weather'; size: number; seed: number }

export function bakeCloudNoise(request: CloudNoiseRequest): Uint8Array {
  return request.kind === 'shape' ? bakeCloudShapeNoise(request.size, request.seed) : bakeCloudWeatherNoise(request.size, request.seed)
}

/** Main-thread side: one worker, a promise per request; inline without Worker support. */
export function createCloudNoiseBaker(): { bake(request: Omit<CloudNoiseRequest, 'id'>): Promise<Uint8Array>; dispose(): void } {
  let worker: Worker | null = null
  try {
    worker = new Worker(new URL('./sky-cloud-noise.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    worker = null
  }
  let nextId = 1
  const pending = new Map<number, { request: CloudNoiseRequest; resolve: (data: Uint8Array) => void }>()
  const fail = () => {
    worker?.terminate()
    worker = null
    for (const job of pending.values()) job.resolve(bakeCloudNoise(job.request))
    pending.clear()
  }
  worker?.addEventListener('message', (event: MessageEvent<{ id: number; data: Uint8Array }>) => {
    const job = pending.get(event.data.id)
    if (!job) return
    pending.delete(event.data.id)
    job.resolve(event.data.data)
  })
  worker?.addEventListener('error', fail)
  worker?.addEventListener('messageerror', fail)
  return {
    bake(partial) {
      const request = { ...partial, id: nextId++ } as CloudNoiseRequest
      if (!worker) return Promise.resolve(bakeCloudNoise(request))
      return new Promise((resolve) => {
        pending.set(request.id, { request, resolve })
        worker!.postMessage(request)
      })
    },
    dispose() {
      worker?.terminate()
      worker = null
      pending.clear()
    },
  }
}
