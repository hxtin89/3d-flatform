// Pixel measurement for the review loop -- the half of a visual critique that
// is arithmetic, not judgement.
//
// A vision model asked to "measure the left edge of this card" burns tens of
// thousands of tokens cropping and eyeballing, and still returns estimates. The
// same numbers fall out of reading the pixels, exactly and for free, and stay
// comparable between rounds. So: this produces the measurements, and the model
// is handed them to judge. It never counts pixels itself.
//
// Decoding goes through a headless canvas rather than a PNG library so this
// needs no dependency beyond the playwright already used to capture.
//
//   node measure.mjs diff <a.png> <b.png> [heatmap.png]   compare two same-size images
//   node measure.mjs box  <img.png> <x> <y> <w> <h>       bbox + edge profiles in a region
import { chromium } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'

const [, , cmd, ...rest] = process.argv
const load = async (p) => (await readFile(p)).toString('base64')

const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas><canvas id="d"></canvas>')

const toPixels = async (b64, slot) =>
  page.evaluate(async ({ b64, slot }) => {
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64 })
    const c = document.getElementById(slot)
    c.width = img.naturalWidth; c.height = img.naturalHeight
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    window['__' + slot] = { w: c.width, h: c.height }
    return { w: c.width, h: c.height }
  }, { b64, slot })

if (cmd === 'diff') {
  const [aPath, bPath, heatPath] = rest
  const a = await toPixels(await load(aPath), 'c')
  const b = await toPixels(await load(bPath), 'd')
  if (a.w !== b.w || a.h !== b.h) {
    console.log(JSON.stringify({ error: 'size mismatch', a, b }, null, 1)); await browser.close(); process.exit(1)
  }
  const out = await page.evaluate(() => {
    const g = (id) => document.getElementById(id).getContext('2d', { willReadFrequently: true })
    const { width: w, height: h } = document.getElementById('c')
    const A = g('c').getImageData(0, 0, w, h).data
    const B = g('d').getImageData(0, 0, w, h).data
    // Coarse grid so the summary stays small enough to hand to a model.
    const GX = 16, GY = 16
    const cell = Array.from({ length: GY }, () => new Array(GX).fill(0))
    let changed = 0, total = w * h
    const heat = g('d').createImageData(w, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])
        const hit = d > 40
        if (hit) { changed++; cell[Math.floor(y / h * GY)][Math.floor(x / w * GX)]++ }
        // Grey the unchanged parts, flag the changed ones -- reads at a glance.
        const v = (A[i] + A[i + 1] + A[i + 2]) / 3
        heat.data[i] = hit ? 255 : v * 0.25 + 190
        heat.data[i + 1] = hit ? 40 : v * 0.25 + 190
        heat.data[i + 2] = hit ? 40 : v * 0.25 + 190
        heat.data[i + 3] = 255
      }
    }
    g('d').putImageData(heat, 0, 0)
    const cellPct = cell.map((row, gy) => row.map((n) => +(n / ((w / GX) * (h / GY)) * 100).toFixed(0)))
    return { w, h, changedPct: +(changed / total * 100).toFixed(2), grid: cellPct, cellW: Math.round(w / GX), cellH: Math.round(h / GY) }
  })
  if (heatPath) await writeFile(heatPath, await page.locator('#d').screenshot())
  console.log(JSON.stringify(out, null, 1))
} else if (cmd === 'box') {
  const [imgPath, x, y, w, h] = rest.map((v, i) => (i === 0 ? v : Number(v)))
  await toPixels(await load(imgPath), 'c')
  const out = await page.evaluate(({ x, y, w, h }) => {
    const c = document.getElementById('c')
    const D = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data
    const at = (px, py) => { const i = (py * c.width + px) * 4; return [D[i], D[i + 1], D[i + 2], D[i + 3]] }
    // Background = the modal colour of the region's outermost ring.
    const counts = new Map()
    for (let px = x; px < x + w; px++) for (const py of [y, y + h - 1]) {
      const k = at(px, py).slice(0, 3).join(','); counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number)
    const isBg = (px, py) => { const p = at(px, py); return Math.abs(p[0]-bg[0]) + Math.abs(p[1]-bg[1]) + Math.abs(p[2]-bg[2]) < 30 }
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
      if (!isBg(px, py)) { if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py }
    }
    // First non-background x per row (left profile) and last (right profile) --
    // this is what reveals a bitten corner or a wrong radius as a number.
    const step = Math.max(1, Math.round(h / 24))
    const profile = []
    for (let py = y; py < y + h; py += step) {
      let l = null, r = null
      for (let px = x; px < x + w; px++) if (!isBg(px, py)) { l = px; break }
      for (let px = x + w - 1; px >= x; px--) if (!isBg(px, py)) { r = px; break }
      profile.push({ y: py, left: l, right: r })
    }
    return { bg, bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, profile }
  }, { x, y, w, h })
  console.log(JSON.stringify(out, null, 1))
} else if (cmd === 'regions') {
  // Several named regions of the same image in ONE browser launch -- measuring
  // four regions of two images as eight separate invocations spends most of its
  // time starting chromium.
  //   measure.mjs regions <img.png> name=x,y,w,h[,lumMin] [...]
  //
  // The optional 5th number switches the foreground test from "differs from the
  // region's background colour" to "brighter than lumMin". The background test
  // only works over a flat ground like the frame margin; over the photo
  // everything differs from everything, and the profile just traces the photo.
  // A brightness cut is what isolates a light widget sitting ON the photo.
  const [imgPath, ...specs] = rest
  await toPixels(await load(imgPath), 'c')
  const parsed = specs.map((sp) => {
    const [name, nums] = sp.split('=')
    const [x, y, w, h, lumMin] = nums.split(',').map(Number)
    return { name, x, y, w, h, lumMin: Number.isFinite(lumMin) ? lumMin : null }
  })
  const out = await page.evaluate((regions) => {
    const c = document.getElementById('c')
    const D = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data
    const at = (px, py) => { const i = (py * c.width + px) * 4; return [D[i], D[i + 1], D[i + 2]] }
    const measure = ({ name, x, y, w, h, lumMin }) => {
      const counts = new Map()
      for (let px = x; px < x + w; px++) for (const py of [y, y + h - 1]) {
        const k = at(px, py).join(','); counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number)
      const isBg = lumMin === null
        ? (px, py) => { const p = at(px, py); return Math.abs(p[0]-bg[0]) + Math.abs(p[1]-bg[1]) + Math.abs(p[2]-bg[2]) < 30 }
        : (px, py) => { const p = at(px, py); return (p[0] + p[1] + p[2]) / 3 < lumMin }
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, lum = 0, n = 0
      for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
        const p = at(px, py); lum += (p[0] + p[1] + p[2]) / 3; n++
        if (!isBg(px, py)) { if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py }
      }
      const step = Math.max(1, Math.round(h / 16))
      const profile = []
      for (let py = y; py < y + h; py += step) {
        let l = null, r = null
        for (let px = x; px < x + w; px++) if (!isBg(px, py)) { l = px; break }
        for (let px = x + w - 1; px >= x; px--) if (!isBg(px, py)) { r = px; break }
        if (l !== null) profile.push(`y${py}:${l}-${r}`)
      }
      return { name, bg: bg.join(','), meanLum: +(lum / n).toFixed(1), bbox: maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1], profile }
    }
    return regions.map(measure)
  }, parsed)
  console.log(JSON.stringify(out, null, 1))
} else {
  console.log('usage: measure.mjs diff <a> <b> [heat.png] | measure.mjs box <img> <x> <y> <w> <h> | measure.mjs regions <img> name=x,y,w,h ...')
}
await browser.close()
