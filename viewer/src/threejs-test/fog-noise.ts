// Tileable noise for the volumetric ground fog, baked on the CPU (in a worker, see
// fog-noise.worker.ts) and uploaded as textures.
//
// The fog is marched per pixel, so its density function runs dozens of times per pixel and
// must be cheap. A texture fetch is: one filtered read replaces a whole fBm evaluation. The
// fog therefore samples a 2D texture that holds four independent noise layers, one per
// channel: coverage, billows and erosion are read on the ground plane. The height detail
// comes from a 64³ 3D texture of the same kind of noise by default (bakeFogNoise3D), or,
// with the '2d' noise source, from stacked, offset slices of the wisp layer blended by
// height (see ground-fog.ts).
//
// Every layer tiles: each lattice wraps with the texture, and domain warping only adds a
// periodic offset, so RepeatWrapping shows no seam. Pure functions only — no DOM, no GPU —
// so the worker, the noise editor and the tests share them.

export type NoiseKind = 'perlin' | 'value' | 'worley' | 'ridged'
export const NOISE_KINDS: readonly NoiseKind[] = ['perlin', 'value', 'worley', 'ridged']

export interface NoiseLayerSettings {
  /** perlin: smooth gradient noise. value: blockier lattice noise. worley: inverted cellular
   *  (1 at feature points) — billows. ridged: 1 − |perlin| — thin filaments. */
  kind: NoiseKind
  /** Lattice cells across one tile at the first octave. Whole numbers only: that is what
   *  makes the layer tile. */
  period: number
  octaves: number
  /** Amplitude kept per octave (persistence). */
  gain: number
  seed: number
  /** Domain warp in lattice cells: pushes the lookup by a second, periodic noise, which
   *  curls straight edges into wisps. 0 = off. */
  warp: number
  /** Power applied after normalising to 0…1: above 1 thins the layer out, below 1 fills it. */
  contrast: number
  invert: boolean
}

export interface FogNoiseSettings {
  /** Texels per tile edge. */
  size: number
  /** R, G, B, A — see ground-fog.ts for what each one drives. */
  layers: [NoiseLayerSettings, NoiseLayerSettings, NoiseLayerSettings, NoiseLayerSettings]
}

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374_761_393 + y * 668_265_263 + seed * 1_440_662_683) | 0
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177)
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_295
}

function wrap(i: number, period: number): number {
  return ((i % period) + period) % period
}

const quintic = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
// Sixteen unit gradients: no trigonometry per corner, and no directional bias.
const GRADIENTS = Array.from({ length: 16 }, (_, i) => [Math.cos((i / 16) * Math.PI * 2), Math.sin((i / 16) * Math.PI * 2)])

/** Gradient (Perlin) noise on a lattice of `period` cells that wraps; roughly −0.7…0.7. */
export function perlin2(x: number, y: number, period: number, seed = 0): number {
  const xi = Math.floor(x); const yi = Math.floor(y)
  const xf = x - xi; const yf = y - yi
  const corner = (cx: number, cy: number, dx: number, dy: number) => {
    const g = GRADIENTS[(hash2(wrap(cx, period), wrap(cy, period), seed) * 16) | 0]
    return g[0] * dx + g[1] * dy
  }
  const u = quintic(xf); const v = quintic(yf)
  const n00 = corner(xi, yi, xf, yf)
  const n10 = corner(xi + 1, yi, xf - 1, yf)
  const n01 = corner(xi, yi + 1, xf, yf - 1)
  const n11 = corner(xi + 1, yi + 1, xf - 1, yf - 1)
  const nx0 = n00 + (n10 - n00) * u
  const nx1 = n01 + (n11 - n01) * u
  return nx0 + (nx1 - nx0) * v
}

/** Value noise on a wrapping lattice, 0…1. */
export function value2(x: number, y: number, period: number, seed = 0): number {
  const xi = Math.floor(x); const yi = Math.floor(y)
  const u = quintic(x - xi); const v = quintic(y - yi)
  const c = (dx: number, dy: number) => hash2(wrap(xi + dx, period), wrap(yi + dy, period), seed)
  const a = c(0, 0) + (c(1, 0) - c(0, 0)) * u
  const b = c(0, 1) + (c(1, 1) - c(0, 1)) * u
  return a + (b - a) * v
}

/** Inverted Worley (F1) noise on a wrapping lattice: 1 at feature points, 0 far from them. */
export function worley2(x: number, y: number, period: number, seed = 0): number {
  const xi = Math.floor(x); const yi = Math.floor(y)
  let minimum = 8
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx; const cy = yi + dy
      const wx = wrap(cx, period); const wy = wrap(cy, period)
      const px = cx + hash2(wx, wy, seed + 17)
      const py = cy + hash2(wx, wy, seed + 71)
      const distance = (px - x) ** 2 + (py - y) ** 2
      if (distance < minimum) minimum = distance
    }
  }
  return 1 - Math.min(1, Math.sqrt(minimum))
}

export const ridged2 = (x: number, y: number, period: number, seed = 0) => 1 - Math.abs(perlin2(x, y, period, seed)) * 1.4

const NOISE: Record<NoiseKind, (x: number, y: number, period: number, seed: number) => number> = {
  perlin: perlin2, value: value2, worley: worley2, ridged: ridged2,
}

/** fBm of `octaves` layers, each doubling the lattice so the sum still tiles over `period`. */
export function fbm2(
  noise: (x: number, y: number, period: number, seed: number) => number,
  u: number, v: number, period: number, octaves: number, seed = 0, gain = 0.5,
): number {
  let amplitude = 1; let frequency = 1; let sum = 0; let norm = 0
  for (let octave = 0; octave < octaves; octave++) {
    sum += noise(u * period * frequency, v * period * frequency, period * frequency, seed + octave * 101) * amplitude
    norm += amplitude
    amplitude *= gain
    frequency *= 2
  }
  return sum / norm
}

/** One layer's raw value at tile coordinates (u, v), before normalisation. */
export function sampleLayer(layer: NoiseLayerSettings, u: number, v: number): number {
  const period = Math.max(1, Math.round(layer.period))
  const octaves = Math.max(1, Math.round(layer.octaves))
  if (layer.warp !== 0) {
    // The warp field has the layer's own period, so u + warp(u) still wraps at 1.
    const warp = layer.warp / period
    const wu = fbm2(perlin2, u, v, period, 2, layer.seed + 9001)
    const wv = fbm2(perlin2, u, v, period, 2, layer.seed + 9973)
    u += wu * warp; v += wv * warp
  }
  return fbm2(NOISE[layer.kind], u, v, period, octaves, layer.seed, layer.gain)
}

/** One layer as floats per texel (row-major, `size`²), before normalisation. */
export function bakeLayer(size: number, layer: NoiseLayerSettings): Float32Array {
  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) out[y * size + x] = sampleLayer(layer, x / size, y / size)
  }
  return out
}

/** Normalise a layer to 0…1, then apply the layer's contrast and invert. */
export function finishLayer(values: Float32Array, layer: NoiseLayerSettings): Float32Array {
  let lo = Infinity; let hi = -Infinity
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v }
  const scale = hi > lo ? 1 / (hi - lo) : 0
  const exponent = Math.max(layer.contrast, 0.05)
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) {
    let t = Math.pow((values[i] - lo) * scale, exponent)
    if (layer.invert) t = 1 - t
    out[i] = t
  }
  return out
}

/** The whole texture: four finished layers interleaved as RGBA8. */
export function bakeFogNoise(settings: FogNoiseSettings): Uint8Array {
  const { size } = settings
  const data = new Uint8Array(size * size * 4)
  settings.layers.forEach((layer, channel) => {
    const finished = finishLayer(bakeLayer(size, layer), layer)
    for (let i = 0; i < finished.length; i++) data[i * 4 + channel] = Math.round(finished[i] * 255)
  })
  return data
}

/** The 3D height-detail texture the default noise source reads: value-noise fBm that tiles
 *  in all three axes, one channel, `size`³ bytes. Its settings are fixed; the noise editor
 *  only previews it. */
export function bakeFogNoise3D(size: number, period = 4, octaves = 4, seed = 3): Uint8Array {
  const smooth = (t: number) => t * t * (3 - 2 * t)
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const value = (x: number, y: number, z: number, p: number, s: number) => {
    const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z)
    const xf = smooth(x - xi); const yf = smooth(y - yi); const zf = smooth(z - zi)
    const c = (dx: number, dy: number, dz: number) => hash2(wrap(xi + dx, p) + wrap(zi + dz, p) * 7919, wrap(yi + dy, p), s)
    return lerp(
      lerp(lerp(c(0, 0, 0), c(1, 0, 0), xf), lerp(c(0, 1, 0), c(1, 1, 0), xf), yf),
      lerp(lerp(c(0, 0, 1), c(1, 0, 1), xf), lerp(c(0, 1, 1), c(1, 1, 1), xf), yf),
      zf,
    )
  }
  const raw = new Float32Array(size * size * size)
  let index = 0
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let amplitude = 1; let frequency = 1; let sum = 0; let norm = 0
        for (let octave = 0; octave < octaves; octave++) {
          const p = period * frequency
          sum += value((x / size) * p, (y / size) * p, (z / size) * p, p, seed + octave * 101) * amplitude
          norm += amplitude; amplitude *= 0.5; frequency *= 2
        }
        raw[index++] = sum / norm
      }
    }
  }
  let lo = Infinity; let hi = -Infinity
  for (const v of raw) { if (v < lo) lo = v; if (v > hi) hi = v }
  const data = new Uint8Array(raw.length)
  const scale = hi > lo ? 255 / (hi - lo) : 0
  for (let i = 0; i < raw.length; i++) data[i] = Math.round((raw[i] - lo) * scale)
  return data
}
