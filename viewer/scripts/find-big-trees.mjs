// Find candidate big trees around the canopy tower in the point cloud and write them to
// scripts/big-trees-candidates/<dataset>.json.
//
//   node --experimental-strip-types scripts/find-big-trees.mjs [dataset] [radiusM]
//
// The app does not read this output. It draws public/big-trees/<dataset>.json, a curated
// list: each candidate there was checked at full point density, and its height and
// crown were read off that check. A floor model for a whole area cannot do that — under
// the closed canopy the ground returns are sparse and uneven, so the heights here can be
// several metres off and an odd bank plateau still gets through. Use this script to find
// trees worth checking, then add the confirmed ones to the curated list by hand.
//
// It reads the same CloudFront tiles the viewer streams (base URL from viewer/.env via
// Vite's loadEnv, never printed), walks the adaptive point hierarchy down to DEPTH over
// a square around the tower's platform, and builds two grids from the points:
//
//  - the canopy top, the highest return in every 2 m cell;
//  - the forest floor: per 8 m cell the FLOOR_RANK-th lowest return, not the lowest —
//    over the river a few stray returns sit 10–15 m under the water (mirror noise) and a
//    plain minimum reads them as the floor. Cells far below their neighbourhood are
//    dropped, and the rest smoothed to the 20th percentile over 40 m, because under the
//    closed canopy many cells only reach the undergrowth.
//
// A big tree is a crown that is tall (MIN_HEIGHT_M above the floor), has a real top
// surface rather than a few stray points (MIN_TOP_AREA_M2 within 3 m of its peak), and
// stands out of the FOREST around it (MIN_PROMINENCE_M above the median height of the
// forest 16–36 m away; beach, water and gaps are not forest). Two peaks on one crown —
// a flat top dips less than SADDLE_M between them — count once.
//
// The rules came out of a full-density check of the first 36 candidates on 2026-10-05,
// which found clumps over the river, bank plateaus and crowns level with their
// neighbours among them. With them the script finds 19 of the 26 trees that check
// confirmed and lets 2 of its rejects through.
//
// Heights are raw ENU metres in the survey frame, before the viewer's lift — the frame
// every other placement in config.ts uses.
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { EXPERIENCE_CONFIG } from '../src/threejs-test/config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const viewerDir = resolve(here, '..')
const dataset = process.argv[2] ?? 'peru-b2-globe'
const RADIUS_M = Number(process.argv[3] ?? 600)
const DEPTH = 8
const TOP_CELL_M = 2
const FLOOR_CELL_M = 8
const FLOOR_RANK = 8
// Only for values far below their neighbourhood. Under the closed canopy most cells
// reach only the undergrowth, so the median sits there and the true floor 10–15 m below
// it must not count as an outlier.
const FLOOR_OUTLIER_M = 25
const FOREST_MIN_M = 12
const MIN_HEIGHT_M = 40
const MIN_PROMINENCE_M = 8
const MIN_TOP_AREA_M2 = 20
const PEAK_RADIUS_M = 7
const MERGE_RADIUS_M = 30
const SADDLE_M = 3
const CROWN_DROP_M = 8
const MAX_TREES = 40

const env = loadEnv('development', viewerDir, 'VITE_')
const domain = (env.VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
const folder = (env.VITE_POINTCLOUD_TILES_FOLDER ?? 'pointcloud-tiles').replace(/^\/+|\/+$/g, '')
if (!domain) throw new Error('VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN missing from viewer/.env')
const base = `https://${domain}/${folder}/${dataset}`

// Every request goes through here: a network failure's own message and cause name the
// CloudFront host, so only its code is kept, with the path below the dataset.
async function get(url) {
  try {
    return await fetch(url)
  } catch (error) {
    throw new Error(`${error?.cause?.code ?? error?.name ?? 'network error'} for ${url.slice(url.indexOf(dataset))}`)
  }
}

async function getJson(url) {
  const res = await get(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(url.indexOf(dataset))}`)
  return res.json()
}

// The tower's platform centre, from the manifest the viewer reads and the config it
// places the tower with — so the search follows the tower if its config moves.
const manifest = await getJson(`${base}/area-manifest.json`)
const boxes = (manifest.areas ?? []).map((area) => area.bbox).filter((b) => Array.isArray(b) && b.length === 6)
const centreX = (Math.min(...boxes.map((b) => b[0])) + Math.max(...boxes.map((b) => b[3]))) / 2
  + EXPERIENCE_CONFIG.markers.centreOffsetM[0]
const centreY = (Math.min(...boxes.map((b) => b[1])) + Math.max(...boxes.map((b) => b[4]))) / 2
  + EXPERIENCE_CONFIG.markers.centreOffsetM[1]
const tower = EXPERIENCE_CONFIG.tower
const yaw = tower.rotationRad[2]
const [offsetX, offsetY] = tower.sensorOffsetUnits
const cx = centreX + tower.positionM[0] + (offsetX * Math.cos(yaw) - offsetY * Math.sin(yaw)) * tower.scale
const cy = centreY + tower.positionM[1] + (offsetX * Math.sin(yaw) + offsetY * Math.cos(yaw)) * tower.scale

// ------------------------------------------------------------------ point intake
// The grids reach a crown past the search radius, so a tree on the edge is measured
// against the canopy around it, not against the empty outside of the square.
const GRID_RADIUS_M = RADIUS_M + 50
const x0 = cx - GRID_RADIUS_M
const y0 = cy - GRID_RADIUS_M
const topSize = Math.ceil((2 * GRID_RADIUS_M) / TOP_CELL_M)
const floorSize = Math.ceil((2 * GRID_RADIUS_M) / FLOOR_CELL_M)
const top = new Float32Array(topSize * topSize).fill(-Infinity)
// The FLOOR_RANK lowest returns per floor cell, kept sorted ascending.
const lowest = new Float32Array(floorSize * floorSize * FLOOR_RANK).fill(Infinity)
let pointsUsed = 0

function boxNear(box) {
  const hx = Math.abs(box[3]) + Math.abs(box[6]) + Math.abs(box[9])
  const hy = Math.abs(box[4]) + Math.abs(box[7]) + Math.abs(box[10])
  return Math.abs(box[0] - cx) <= hx + GRID_RADIUS_M && Math.abs(box[1] - cy) <= hy + GRID_RADIUS_M
}

const contentUrls = []
async function walk(node, url, depth) {
  const box = node.boundingVolume?.box
  if (box && !boxNear(box)) return
  const uri = node.content?.uri ?? node.content?.url
  if (uri) {
    const next = new URL(uri, url).href
    if (next.endsWith('.json')) {
      const child = await getJson(next)
      await walk(child.root, next, depth)
      return
    }
    contentUrls.push(next)
  }
  if (depth >= DEPTH) return
  await Promise.all((node.children ?? []).map((child) => walk(child, url, depth + 1)))
}

function addPoint(x, y, z) {
  if (Math.abs(x - cx) >= GRID_RADIUS_M || Math.abs(y - cy) >= GRID_RADIUS_M) return
  const t = Math.floor((y - y0) / TOP_CELL_M) * topSize + Math.floor((x - x0) / TOP_CELL_M)
  if (z > top[t]) top[t] = z
  const f = (Math.floor((y - y0) / FLOOR_CELL_M) * floorSize + Math.floor((x - x0) / FLOOR_CELL_M)) * FLOOR_RANK
  if (z < lowest[f + FLOOR_RANK - 1]) {
    let k = FLOOR_RANK - 1
    while (k > 0 && lowest[f + k - 1] > z) { lowest[f + k] = lowest[f + k - 1]; k-- }
    lowest[f + k] = z
  }
  pointsUsed++
}

function readPnts(buffer) {
  const view = new DataView(buffer)
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== 'pnts') return
  const ftJsonLength = view.getUint32(12, true)
  const ft = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 28, ftJsonLength)))
  const binStart = 28 + ftJsonLength
  const count = ft.POINTS_LENGTH
  const rtc = ft.RTC_CENTER ?? [0, 0, 0]
  if (ft.POSITION) {
    const at = binStart + ft.POSITION.byteOffset
    const positions = new Float32Array(buffer.slice(at, at + count * 12))
    for (let i = 0; i < count; i++) addPoint(positions[3 * i] + rtc[0], positions[3 * i + 1] + rtc[1], positions[3 * i + 2] + rtc[2])
  } else if (ft.POSITION_QUANTIZED) {
    const at = binStart + ft.POSITION_QUANTIZED.byteOffset
    const q = new Uint16Array(buffer.slice(at, at + count * 6))
    const [ox, oy, oz] = ft.QUANTIZED_VOLUME_OFFSET
    const [sx, sy, sz] = ft.QUANTIZED_VOLUME_SCALE
    for (let i = 0; i < count; i++) {
      addPoint(ox + (q[3 * i] / 65535) * sx + rtc[0], oy + (q[3 * i + 1] / 65535) * sy + rtc[1], oz + (q[3 * i + 2] / 65535) * sz + rtc[2])
    }
  }
}

const tilesetUrl = `${base}/${dataset}-adaptive-point-hierarchy/tileset.json`
await walk((await getJson(tilesetUrl)).root, tilesetUrl, 0)
let next = 0
let failedTiles = 0
await Promise.all(Array.from({ length: 16 }, async () => {
  while (next < contentUrls.length) {
    const url = contentUrls[next++]
    const res = await get(url).catch(() => null)
    if (res?.ok) readPnts(await res.arrayBuffer())
    else failedTiles++
  }
}))

// ------------------------------------------------------------------ floor
function percentile(values, p) {
  if (!values.length) return NaN
  values.sort((a, b) => a - b)
  return values[Math.min(values.length - 1, Math.floor(p * values.length))]
}

// Per cell: the FLOOR_RANK-th lowest return, or the highest of fewer.
const floorCell = new Float32Array(floorSize * floorSize).fill(NaN)
for (let c = 0; c < floorSize * floorSize; c++) {
  for (let k = FLOOR_RANK - 1; k >= 0; k--) {
    const v = lowest[c * FLOOR_RANK + k]
    if (Number.isFinite(v)) { floorCell[c] = v; break }
  }
}
const floorWindow = Math.round(20 / FLOOR_CELL_M)
function windowValues(i, j) {
  const values = []
  for (let b = -floorWindow; b <= floorWindow; b++) {
    for (let a = -floorWindow; a <= floorWindow; a++) {
      const ii = i + a
      const jj = j + b
      if (ii < 0 || jj < 0 || ii >= floorSize || jj >= floorSize) continue
      const v = floorCell[jj * floorSize + ii]
      if (Number.isFinite(v)) values.push(v)
    }
  }
  return values
}
const floor = new Float32Array(floorSize * floorSize).fill(NaN)
for (let j = 0; j < floorSize; j++) {
  for (let i = 0; i < floorSize; i++) {
    const values = windowValues(i, j)
    const median = percentile([...values], 0.5)
    floor[j * floorSize + i] = percentile(values.filter((v) => v >= median - FLOOR_OUTLIER_M), 0.2)
  }
}
const floorAt = (x, y) => floor[Math.floor((y - y0) / FLOOR_CELL_M) * floorSize + Math.floor((x - x0) / FLOOR_CELL_M)]
const topAt = (x, y) => {
  const i = Math.floor((x - x0) / TOP_CELL_M)
  const j = Math.floor((y - y0) / TOP_CELL_M)
  return i < 0 || j < 0 || i >= topSize || j >= topSize ? -Infinity : top[j * topSize + i]
}
const cellCentre = (i, j) => [x0 + (i + 0.5) * TOP_CELL_M, y0 + (j + 0.5) * TOP_CELL_M]
const heightAt = (i, j) => {
  const v = top[j * topSize + i]
  if (!Number.isFinite(v)) return NaN
  const [x, y] = cellCentre(i, j)
  return v - floorAt(x, y)
}

// ------------------------------------------------------------------ crown tests
/** Median height of the forest 16–36 m away — water, beach and gaps left out. */
function forestRingMedian(i, j) {
  const inner = 16 / TOP_CELL_M
  const outer = 36 / TOP_CELL_M
  const heights = []
  for (let b = -outer; b <= outer; b += 2) {
    for (let a = -outer; a <= outer; a += 2) {
      const r = Math.hypot(a, b)
      if (r < inner || r > outer) continue
      const ii = i + a
      const jj = j + b
      if (ii < 0 || jj < 0 || ii >= topSize || jj >= topSize) continue
      const h = heightAt(ii, jj)
      if (h >= FOREST_MIN_M) heights.push(h)
    }
  }
  return heights.length >= 8 ? percentile(heights, 0.5) : NaN
}

/** Area of crown top within 3 m of the peak, inside 6 m — a stray clump has none. */
function topArea(i, j, peakTop) {
  const reach = Math.round(6 / TOP_CELL_M)
  let cells = 0
  for (let b = -reach; b <= reach; b++) {
    for (let a = -reach; a <= reach; a++) {
      if (Math.hypot(a, b) > reach) continue
      const ii = i + a
      const jj = j + b
      if (ii < 0 || jj < 0 || ii >= topSize || jj >= topSize) continue
      if (top[jj * topSize + ii] >= peakTop - 3) cells++
    }
  }
  return cells * TOP_CELL_M * TOP_CELL_M
}

/** Whether the canopy top stays within SADDLE_M of the lower peak all the way between. */
function sameCrown(a, b) {
  const lower = Math.min(a.topZ, b.topZ)
  const steps = Math.ceil(Math.hypot(a.x - b.x, a.y - b.y))
  for (let s = 1; s < steps; s++) {
    const t = s / steps
    if (topAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < lower - SADDLE_M) return false
  }
  return true
}

// ------------------------------------------------------------------ crowns
const peakCells = Math.round(PEAK_RADIUS_M / TOP_CELL_M)
const candidates = []
const canopyHeights = []
const rejected = { spike: 0, prominence: 0 }
for (let j = 0; j < topSize; j++) {
  for (let i = 0; i < topSize; i++) {
    const v = top[j * topSize + i]
    if (!Number.isFinite(v)) continue
    const [x, y] = cellCentre(i, j)
    if (Math.hypot(x - cx, y - cy) > RADIUS_M) continue
    const g = floorAt(x, y)
    if (!Number.isFinite(g)) continue
    const height = v - g
    if ((i + j) % 7 === 0 && height >= FOREST_MIN_M) canopyHeights.push(height)
    if (height < MIN_HEIGHT_M) continue
    let isPeak = true
    for (let b = -peakCells; b <= peakCells && isPeak; b++) {
      for (let a = -peakCells; a <= peakCells; a++) {
        if (!a && !b) continue
        const ii = i + a
        const jj = j + b
        if (ii < 0 || jj < 0 || ii >= topSize || jj >= topSize) continue
        if (top[jj * topSize + ii] > v) { isPeak = false; break }
      }
    }
    if (!isPeak) continue
    if (topArea(i, j, v) < MIN_TOP_AREA_M2) { rejected.spike++; continue }
    const prominence = height - forestRingMedian(i, j)
    if (!(prominence >= MIN_PROMINENCE_M)) { rejected.prominence++; continue }
    candidates.push({ i, j, x, y, groundZ: g, topZ: v, height, prominence })
  }
}
candidates.sort((a, b) => b.height - a.height)
const trees = []
let merged = 0
for (const c of candidates) {
  if (trees.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < MERGE_RADIUS_M && sameCrown(t, c))) { merged++; continue }
  if (trees.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < 2 * PEAK_RADIUS_M)) { merged++; continue }
  // Crown radius: in 16 directions, how far the canopy top stays within CROWN_DROP_M
  // of the peak; the median of those reaches.
  const reaches = []
  for (let k = 0; k < 16; k++) {
    const angle = (k / 16) * Math.PI * 2
    let reach = 0
    for (let r = 1; r <= 30; r++) {
      const v = topAt(c.x + Math.cos(angle) * r, c.y + Math.sin(angle) * r)
      if (!Number.isFinite(v) || v < c.topZ - CROWN_DROP_M) break
      reach = r
    }
    reaches.push(reach)
  }
  trees.push({ ...c, crownRadius: Math.min(25, Math.max(4, percentile(reaches, 0.5))) })
  if (trees.length >= MAX_TREES) break
}

const round = (v, d = 1) => Number(v.toFixed(d))
const out = {
  dataset,
  generated: new Date().toISOString().slice(0, 10),
  note: 'Candidates only; the app reads the curated public/big-trees list. Raw ENU metres in the survey frame, before the viewer lift.',
  centreEnu: [round(cx), round(cy)],
  radiusM: RADIUS_M,
  depth: DEPTH,
  thresholds: { minHeightM: MIN_HEIGHT_M, minProminenceM: MIN_PROMINENCE_M, minTopAreaM2: MIN_TOP_AREA_M2 },
  canopyHeightM: { p50: round(percentile(canopyHeights, 0.5)), p95: round(percentile(canopyHeights, 0.95)) },
  trees: trees.map((t, index) => ({
    id: `tree-${String(index + 1).padStart(2, '0')}`,
    x: round(t.x), y: round(t.y),
    groundZ: round(t.groundZ), topZ: round(t.topZ),
    heightM: round(t.height), prominenceM: round(t.prominence), crownRadiusM: round(t.crownRadius),
    distanceToTowerM: Math.round(Math.hypot(t.x - cx, t.y - cy)),
  })),
}
const target = resolve(here, 'big-trees-candidates', `${dataset}.json`)
await mkdir(dirname(target), { recursive: true })
await writeFile(target, `${JSON.stringify(out, null, 2)}\n`)
console.log(`${contentUrls.length - failedTiles} of ${contentUrls.length} tiles read, ${pointsUsed} points; forest height p50 ${out.canopyHeightM.p50} m, p95 ${out.canopyHeightM.p95} m`)
console.log(`peaks rejected: ${rejected.spike} without a crown top, ${rejected.prominence} not above the forest; ${merged} merged into a taller crown`)
console.log(`${trees.length} candidates written to scripts/big-trees-candidates/${dataset}.json`)
for (const t of out.trees) {
  console.log(`  ${t.id} (${t.x}, ${t.y}) ${t.heightM} m tall, ${t.prominenceM} m above the forest, crown r ${t.crownRadiusM} m, ${t.distanceToTowerM} m from the tower`)
}
