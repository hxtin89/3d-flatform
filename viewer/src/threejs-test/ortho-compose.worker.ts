/// <reference lib="webworker" />
// Composites drone-ortho tiles into one satellite tile, off the main thread — see
// ortho-composite.ts for why the ortho goes into the satellite's own texture.
//
// Per tile: decode the satellite and the ortho children, colour-correct each ortho pixel into
// the raw satellite's space (base gain × the builder's local gain field × the tile zoom's
// trim), weigh it by its own alpha × the feather field, blend in linear light, and write the
// result pre-flipped, exactly as the library's own createImageBitmap(…, { imageOrientation:
// 'flipY' }) would have, so everything downstream treats it as a satellite tile.

interface FieldInit {
  origin: [number, number]
  size: [number, number]
  texels: [number, number]
  stops: number
  zero: number
  scale: number
  meanCode: [number, number, number]
  featherMean: number
  gainUrl: string
  featherUrl: string
}

interface SourceInit {
  baseGain: [number, number, number]
  zoomTrim: Record<string, [number, number, number]>
  pyramidLevel: Record<string, [number, number, number]>
  field: FieldInit
}

interface InitMessage { type: 'init'; enuFromEcef: number[]; sources: SourceInit[]; debugKinds: boolean }
interface ChildInput { source: number; z: number; dx: 0 | 1; dy: 0 | 1; size: 256 | 512; blob: Blob | null }
interface ComposeMessage { type: 'compose'; id: number; z: number; x: number; y: number; sat: Blob | null; children: ChildInput[] }
interface CancelMessage { type: 'cancel'; id: number }

interface Source {
  baseGain: [number, number, number]
  zoomTrim: Record<string, [number, number, number]>
  pyramidLevel: Record<string, [number, number, number]>
  ox: number
  oy: number
  sx: number
  sy: number
  w: number
  h: number
  /** Decoded log2 gain per texel, 3 channels, north-first rows. */
  gain: Float32Array
  /** Feather 0..1 per texel, north-first rows. */
  feather: Float32Array
}

const SIZE = 512
const STEP = 8
const LATTICE = SIZE / STEP + 1

let enuFromEcef: Float64Array | null = null
let sources: Source[] = []
let debugKinds = false
const cancelled = new Set<number>()

// sRGB → linear for 8-bit codes, and linear → sRGB through a 4096-entry table.
const DEC = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  DEC[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const ENC_N = 4096
const ENC = new Uint8Array(ENC_N + 1)
for (let i = 0; i <= ENC_N; i++) {
  const v = i / ENC_N
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  ENC[i] = Math.max(0, Math.min(255, Math.round(s * 255)))
}
const encode = (v: number) => ENC[v <= 0 ? 0 : v >= 1 ? ENC_N : (v * ENC_N + 0.5) | 0]

async function pixelsOf(blob: Blob, width?: number, height?: number): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  const w = width ?? bitmap.width
  const h = height ?? bitmap.height
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return { data: ctx.getImageData(0, 0, w, h).data, w, h }
}

async function loadSource(init: SourceInit): Promise<Source> {
  const f = init.field
  const [gainBlob, featherBlob] = await Promise.all([f.gainUrl, f.featherUrl].map(async (url) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`ortho field ${response.status}`)
    return response.blob()
  }))
  const g = await pixelsOf(gainBlob)
  const fe = await pixelsOf(featherBlob)
  const [w, h] = f.texels
  if (g.w !== w || g.h !== h || fe.w !== w || fe.h !== h) throw new Error('ortho field size does not match its metadata')
  const n = w * h
  const gain = new Float32Array(n * 3)
  const feather = new Float32Array(n)
  const sums = [0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const code = g.data[i * 4 + c]
      sums[c] += code
      gain[i * 3 + c] = (code - f.zero) / f.scale * f.stops
    }
    const v = fe.data[i * 4]
    sums[3] += v
    feather[i] = v / 255
  }
  // The same readback check as the cloud's field: a browser that alters canvas reads.
  if (sums.slice(0, 3).some((s, c) => Math.abs(s / n - f.meanCode[c]) > 2) || Math.abs(sums[3] / n - f.featherMean) > 2) {
    throw new Error('ortho field reads back differently from the file')
  }
  return {
    baseGain: init.baseGain, zoomTrim: init.zoomTrim, pyramidLevel: init.pyramidLevel ?? {},
    ox: f.origin[0], oy: f.origin[1], sx: f.size[0], sy: f.size[1], w, h, gain, feather,
  }
}

/** ENU x/y of the lattice points of tile z/x/y (every STEP pixels, edges included). */
function lattice(z: number, x: number, y: number): Float64Array {
  const m = enuFromEcef!
  const out = new Float64Array(LATTICE * LATTICE * 2)
  const n = 2 ** z
  const a = 6378137
  const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)
  for (let j = 0; j < LATTICE; j++) {
    const fy = y + (j * STEP) / SIZE
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / n)))
    const sinLat = Math.sin(lat)
    const cosLat = Math.cos(lat)
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat)
    for (let i = 0; i < LATTICE; i++) {
      const fx = x + (i * STEP) / SIZE
      const lon = (fx / n) * 2 * Math.PI - Math.PI
      const X = N * cosLat * Math.cos(lon)
      const Y = N * cosLat * Math.sin(lon)
      const Z = N * (1 - e2) * sinLat
      const k = (j * LATTICE + i) * 2
      out[k] = m[0] * X + m[4] * Y + m[8] * Z + m[12]
      out[k + 1] = m[1] * X + m[5] * Y + m[9] * Z + m[13]
    }
  }
  return out
}

/** Linear gains (3) and feather at one ENU point, bilinear with clamp-to-edge. */
function sample(s: Source, ex: number, ey: number, trim: readonly number[], out: Float32Array, o: number): void {
  const col = Math.min(Math.max(((ex - s.ox) / s.sx) * s.w - 0.5, 0), s.w - 1)
  const rowSouth = ((ey - s.oy) / s.sy) * s.h - 0.5
  const row = Math.min(Math.max(s.h - 1 - rowSouth, 0), s.h - 1)
  const c0 = Math.floor(col)
  const r0 = Math.floor(row)
  const c1 = Math.min(c0 + 1, s.w - 1)
  const r1 = Math.min(r0 + 1, s.h - 1)
  const fc = col - c0
  const fr = row - r0
  const w00 = (1 - fc) * (1 - fr)
  const w10 = fc * (1 - fr)
  const w01 = (1 - fc) * fr
  const w11 = fc * fr
  const i00 = r0 * s.w + c0
  const i10 = r0 * s.w + c1
  const i01 = r1 * s.w + c0
  const i11 = r1 * s.w + c1
  for (let c = 0; c < 3; c++) {
    const stops = s.gain[i00 * 3 + c] * w00 + s.gain[i10 * 3 + c] * w10 + s.gain[i01 * 3 + c] * w01 + s.gain[i11 * 3 + c] * w11
    out[o + c] = s.baseGain[c] * trim[c] * 2 ** stops
  }
  out[o + 3] = s.feather[i00] * w00 + s.feather[i10] * w10 + s.feather[i01] * w01 + s.feather[i11] * w11
}

async function compose(msg: ComposeMessage): Promise<void> {
  const t0 = performance.now()
  const { id, z, x, y } = msg
  const enu = lattice(z, x, y)
  const lin = new Float32Array(SIZE * SIZE * 3)
  const cover = msg.sat ? null : new Float32Array(SIZE * SIZE)
  if (msg.sat) {
    const sat = await pixelsOf(msg.sat, SIZE, SIZE)
    for (let p = 0, q = 0; p < SIZE * SIZE; p++, q += 4) {
      lin[p * 3] = DEC[sat.data[q]]
      lin[p * 3 + 1] = DEC[sat.data[q + 1]]
      lin[p * 3 + 2] = DEC[sat.data[q + 2]]
    }
  }
  const bySource = new Map<number, ChildInput[]>()
  for (const child of msg.children) {
    if (!child.blob) continue
    if (!bySource.has(child.source)) bySource.set(child.source, [])
    bySource.get(child.source)!.push(child)
  }
  const layer = new OffscreenCanvas(SIZE, SIZE)
  const lctx = layer.getContext('2d', { willReadFrequently: true })!
  const lat = new Float32Array(LATTICE * LATTICE * 4)
  // Sources in priority order: later ones draw on top.
  for (const index of [...bySource.keys()].sort((a, b) => a - b)) {
    const s = sources[index]
    if (!s) continue
    lctx.clearRect(0, 0, SIZE, SIZE)
    for (const child of bySource.get(index)!) {
      const bitmap = await createImageBitmap(child.blob!, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      if (child.size === 512) lctx.drawImage(bitmap, 0, 0, SIZE, SIZE)
      else lctx.drawImage(bitmap, child.dx * 256, child.dy * 256, 256, 256)
      bitmap.close()
    }
    const px = lctx.getImageData(0, 0, SIZE, SIZE).data
    // Into the tile zoom's satellite colour, from the children's own zoom level of the ortho.
    const satTrim = s.zoomTrim[String(z)] ?? [1, 1, 1]
    const pyramid = s.pyramidLevel[String(bySource.get(index)![0].z)] ?? [1, 1, 1]
    const trim = [0, 1, 2].map((c) => satTrim[c] / pyramid[c])
    for (let k = 0; k < LATTICE * LATTICE; k++) sample(s, enu[k * 2], enu[k * 2 + 1], trim, lat, k * 4)
    for (let cj = 0; cj < LATTICE - 1; cj++) {
      for (let ci = 0; ci < LATTICE - 1; ci++) {
        const k00 = (cj * LATTICE + ci) * 4
        const k10 = k00 + 4
        const k01 = k00 + LATTICE * 4
        const k11 = k01 + 4
        for (let jj = 0; jj < STEP; jj++) {
          const fy = (jj + 0.5) / STEP
          const j = cj * STEP + jj
          for (let ii = 0; ii < STEP; ii++) {
            const i = ci * STEP + ii
            const p = j * SIZE + i
            const alpha = px[p * 4 + 3]
            if (alpha === 0) continue
            const fx = (ii + 0.5) / STEP
            const w00 = (1 - fx) * (1 - fy)
            const w10 = fx * (1 - fy)
            const w01 = (1 - fx) * fy
            const w11 = fx * fy
            const f = lat[k00 + 3] * w00 + lat[k10 + 3] * w10 + lat[k01 + 3] * w01 + lat[k11 + 3] * w11
            const a = (alpha / 255) * f
            if (a <= 0) continue
            for (let c = 0; c < 3; c++) {
              const g = lat[k00 + c] * w00 + lat[k10 + c] * w10 + lat[k01 + c] * w01 + lat[k11 + c] * w11
              const o = DEC[px[p * 4 + c]] * g
              lin[p * 3 + c] += (o - lin[p * 3 + c]) * a
            }
            if (cover) cover[p] = cover[p] + (1 - cover[p]) * a
          }
        }
      }
    }
  }
  if (cover) {
    // Planned as fully covered, so the satellite was not fetched. Any gap needs it after all.
    for (let p = 0; p < cover.length; p++) {
      if (cover[p] < 0.998) { postMessage({ type: 'need-satellite', id }); return }
    }
  }
  if (cancelled.delete(id)) return
  const tint = debugKinds ? (msg.sat ? [1.25, 0.85, 0.85] : [0.85, 0.85, 1.25]) : null
  const out = new ImageData(SIZE, SIZE)
  const d = out.data
  for (let j = 0; j < SIZE; j++) {
    const dst = (SIZE - 1 - j) * SIZE // pre-flipped, like the library's own tile bitmaps
    for (let i = 0; i < SIZE; i++) {
      const p = j * SIZE + i
      const q = (dst + i) * 4
      d[q] = encode(tint ? lin[p * 3] * tint[0] : lin[p * 3])
      d[q + 1] = encode(tint ? lin[p * 3 + 1] * tint[1] : lin[p * 3 + 1])
      d[q + 2] = encode(tint ? lin[p * 3 + 2] * tint[2] : lin[p * 3 + 2])
      d[q + 3] = 255
    }
  }
  const canvas = new OffscreenCanvas(SIZE, SIZE)
  canvas.getContext('2d')!.putImageData(out, 0, 0)
  const bitmap = canvas.transferToImageBitmap()
  if (cancelled.delete(id)) { bitmap.close(); return }
  postMessage({ type: 'done', id, bitmap, ms: performance.now() - t0 }, { transfer: [bitmap] })
}

self.onmessage = (event: MessageEvent<InitMessage | ComposeMessage | CancelMessage>) => {
  const msg = event.data
  if (msg.type === 'init') {
    enuFromEcef = Float64Array.from(msg.enuFromEcef)
    debugKinds = msg.debugKinds
    Promise.all(msg.sources.map(loadSource))
      .then((loaded) => { sources = loaded; postMessage({ type: 'ready' }) })
      .catch((error) => postMessage({ type: 'init-failed', reason: String(error?.message ?? error) }))
  } else if (msg.type === 'compose') {
    compose(msg).catch((error) => postMessage({ type: 'failed', id: msg.id, reason: String(error?.message ?? error) }))
  } else if (msg.type === 'cancel') {
    cancelled.add(msg.id)
  }
}
