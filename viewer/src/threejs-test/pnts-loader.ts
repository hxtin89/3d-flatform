// Minimal 3D-Tiles .pnts loader for the Three.js/WebGPU render test.
//
// Why hand-rolled instead of 3d-tiles-renderer: the whole point of this variant
// is ONE flat buffer (no streaming machinery). We walk the tileset once, fetch
// every .pnts up to a point budget, and decode straight into a single Float32
// position array + Uint8 RGB array kept in CPU memory. The geometry builder then
// derives the F16/F32 GPU buffers from these.
//
// The Peru overview/explore .pnts are plain (checked the feature-table header):
//   POSITION  = Float32 xyz, RGB = uint8 xyz, RTC_CENTER = local-ENU offset (Z-up).
// No Draco, no quantization, no batch table. POSITION+RTC_CENTER are already in
// area-local ENU metres, so we ignore every tile/root transform (the area root's
// transform is ECEF and would blow the coordinates up to planet scale).

export interface LoadedCloud {
  /** interleaved xyz, local-ENU metres (Z-up), length = count*3 */
  positions: Float32Array
  /** interleaved rgb 0..255, length = count*3 */
  colors: Uint8Array
  count: number
  /** axis-aligned bounds in the same local-ENU frame: [minX,minY,minZ,maxX,maxY,maxZ] */
  bounds: [number, number, number, number, number, number]
}

export interface LoadProgress {
  loadedPoints: number
  loadedTiles: number
  totalTiles: number
  bytes: number
}

interface TileNode { content?: { uri?: string }; children?: TileNode[] }
interface Tileset { root: TileNode }

/** Resolve a tile content uri against the directory of the json that referenced it. */
function resolveUri(baseDir: string, uri: string): string {
  return new URL(uri, baseDir).toString()
}

/** Walk a tileset tree; fetch nested tileset .json refs; return every .pnts URL. */
async function collectPntsUrls(tilesetUrl: string, out: string[], seen: Set<string>): Promise<void> {
  if (seen.has(tilesetUrl)) return
  seen.add(tilesetUrl)
  const res = await fetch(tilesetUrl, { cache: 'force-cache' })
  if (!res.ok) throw new Error(`tileset HTTP ${res.status} ${tilesetUrl}`)
  const json = (await res.json()) as Tileset
  const baseDir = tilesetUrl.replace(/[^/]*$/, '') // strip filename → directory
  const nested: string[] = []

  const walk = (n: TileNode) => {
    const uri = n.content?.uri
    if (uri) {
      const abs = resolveUri(baseDir, uri)
      if (uri.endsWith('.pnts')) out.push(abs)
      else if (uri.endsWith('.json')) nested.push(abs)
    }
    n.children?.forEach(walk)
  }
  walk(json.root)

  // Recurse external tilesets in parallel (bounded fan-out is fine — few dozen).
  await Promise.all(nested.map((u) => collectPntsUrls(u, out, seen)))
}

const HEADER_BYTES = 28

/** Decode one .pnts → {pos:Float32(count*3, +RTC), rgb:Uint8(count*3), count}. */
function decodePnts(buf: ArrayBuffer): { pos: Float32Array; rgb: Uint8Array; count: number } | null {
  const view = new DataView(buf)
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  if (magic !== 'pnts') return null
  const ftJSONLen = view.getUint32(12, true)
  const ftText = new TextDecoder().decode(new Uint8Array(buf, HEADER_BYTES, ftJSONLen))
  const ft = JSON.parse(ftText) as {
    POINTS_LENGTH: number
    RTC_CENTER?: [number, number, number]
    POSITION?: { byteOffset: number }
    RGB?: { byteOffset: number }
    RGBA?: { byteOffset: number }
  }
  const count = ft.POINTS_LENGTH | 0
  if (!count || !ft.POSITION) return null
  const ftBin = HEADER_BYTES + ftJSONLen
  const rtc = ft.RTC_CENTER ?? [0, 0, 0]

  const pos = new Float32Array(count * 3)
  const src = new Float32Array(buf, ftBin + ft.POSITION.byteOffset, count * 3)
  for (let i = 0; i < count; i++) {
    pos[i * 3] = src[i * 3] + rtc[0]
    pos[i * 3 + 1] = src[i * 3 + 1] + rtc[1]
    pos[i * 3 + 2] = src[i * 3 + 2] + rtc[2]
  }

  const rgb = new Uint8Array(count * 3)
  if (ft.RGB) {
    rgb.set(new Uint8Array(buf, ftBin + ft.RGB.byteOffset, count * 3))
  } else if (ft.RGBA) {
    const rgba = new Uint8Array(buf, ftBin + ft.RGBA.byteOffset, count * 4)
    for (let i = 0; i < count; i++) {
      rgb[i * 3] = rgba[i * 4]
      rgb[i * 3 + 1] = rgba[i * 4 + 1]
      rgb[i * 3 + 2] = rgba[i * 4 + 2]
    }
  } else {
    rgb.fill(200) // no color in tile → neutral grey; height mode ignores this anyway
  }
  return { pos, rgb, count }
}

/** Fetch worker pool: keeps `concurrency` requests in flight; stops when budget hit. */
async function fetchDecodeAll(
  urls: string[],
  maxPoints: number,
  concurrency: number,
  onProgress: (p: LoadProgress) => void,
): Promise<{ posChunks: Float32Array[]; rgbChunks: Uint8Array[]; total: number }> {
  const posChunks: Float32Array[] = []
  const rgbChunks: Uint8Array[] = []
  let total = 0
  let bytes = 0
  let tilesDone = 0
  let next = 0
  let stopped = false

  async function worker() {
    while (!stopped) {
      const i = next++
      if (i >= urls.length) return
      let buf: ArrayBuffer
      try {
        const res = await fetch(urls[i], { cache: 'force-cache' })
        if (!res.ok) { tilesDone++; continue }
        buf = await res.arrayBuffer()
      } catch { tilesDone++; continue }
      bytes += buf.byteLength
      const dec = decodePnts(buf)
      tilesDone++
      if (dec) {
        let take = dec.count
        if (total + take > maxPoints) take = maxPoints - total // clamp last tile to budget
        if (take > 0) {
          posChunks.push(take === dec.count ? dec.pos : dec.pos.subarray(0, take * 3))
          rgbChunks.push(take === dec.count ? dec.rgb : dec.rgb.subarray(0, take * 3))
          total += take
        }
        if (total >= maxPoints) stopped = true
      }
      onProgress({ loadedPoints: total, loadedTiles: tilesDone, totalTiles: urls.length, bytes })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  return { posChunks, rgbChunks, total }
}

export interface LoadOptions {
  baseUrl: string
  dataset: string
  maxPoints?: number
  concurrency?: number
  onProgress?: (p: LoadProgress) => void
}

/**
 * Load a dataset's .pnts into one flat cloud (up to maxPoints), local-ENU Z-up.
 * Default dataset = explore-p10/area-001 (6.94M pts, the densest single-buffer fit).
 */
export async function loadPointCloud(opts: LoadOptions): Promise<LoadedCloud> {
  const {
    baseUrl,
    dataset,
    maxPoints = 3_000_000,
    concurrency = 12,
    onProgress = () => {},
  } = opts

  const tilesetUrl = `${baseUrl.replace(/\/+$/, '')}/${dataset}/tileset.json`
  const urls: string[] = []
  await collectPntsUrls(tilesetUrl, urls, new Set())
  onProgress({ loadedPoints: 0, loadedTiles: 0, totalTiles: urls.length, bytes: 0 })

  const { posChunks, rgbChunks, total } = await fetchDecodeAll(urls, maxPoints, concurrency, onProgress)

  // Concatenate the per-tile chunks into the single flat buffers + compute bounds.
  const positions = new Float32Array(total * 3)
  const colors = new Uint8Array(total * 3)
  let off = 0
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let c = 0; c < posChunks.length; c++) {
    const p = posChunks[c]
    positions.set(p, off * 3)
    colors.set(rgbChunks[c], off * 3)
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2]
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
    }
    off += p.length / 3
  }

  return {
    positions,
    colors,
    count: total,
    bounds: [minX, minY, minZ, maxX, maxY, maxZ],
  }
}
