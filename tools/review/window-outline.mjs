// Traces the WINDOW silhouette (the hole the grey frame leaves for the photo)
// out of a full-screen capture, so our frame can be diffed against a Figma
// export without the photo or the widgets confusing the comparison.
//
// The frame margin is one flat grey. Anything that is not that grey, on a
// given row, is inside the window -- so the first and last non-grey pixel per
// row IS the window's left and right edge, and the first/last row containing
// any non-grey pixel is its top and bottom.
//
// Usage: node window-outline.mjs <a.png> [b.png]   (two args = diff)
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'

const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

async function trace(path) {
  const b64 = (await readFile(path)).toString('base64')
  return page.evaluate(async (b64) => {
    const img = new Image()
    await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + b64 })
    const c = document.getElementById('c')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    // The margin colour, read from a pixel that is unambiguously margin.
    const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2]] }
    const [gr, gg, gb] = at(2, 2)
    const isGrey = (x, y) => {
      const [r, g, b] = at(x, y)
      return Math.abs(r - gr) < 10 && Math.abs(g - gg) < 10 && Math.abs(b - gb) < 10
    }
    const rows = []
    for (let y = 0; y < c.height; y++) {
      let l = -1, r = -1
      for (let x = 0; x < c.width; x++) if (!isGrey(x, y)) { l = x; break }
      for (let x = c.width - 1; x >= 0; x--) if (!isGrey(x, y)) { r = x; break }
      rows.push([l, r])
    }
    return { w: c.width, h: c.height, grey: [gr, gg, gb], rows }
  }, b64)
}

const a = await trace(process.argv[2])
const b = process.argv[3] ? await trace(process.argv[3]) : null
await browser.close()

const span = (t) => {
  const ys = t.rows.map(([l], y) => (l >= 0 ? y : -1)).filter((y) => y >= 0)
  const ls = t.rows.filter(([l]) => l >= 0).map(([l]) => l)
  const rs = t.rows.filter(([l]) => l >= 0).map(([, r]) => r)
  return { top: ys[0], bottom: ys[ys.length - 1], left: Math.min(...ls), right: Math.max(...rs) }
}
const fmt = (t, name) => {
  const s = span(t)
  console.log(`${name}: ${t.w}x${t.h} margin=rgb(${t.grey}) window top=${s.top} bottom=${s.bottom} left=${s.left} right=${s.right}`)
  console.log(`  margins: top=${s.top} left=${s.left} right=${t.w - 1 - s.right} bottom=${t.h - 1 - s.bottom}`)
}
fmt(a, 'A')
if (b) {
  fmt(b, 'B')
  const n = Math.min(a.h, b.h)
  const bad = []
  for (let y = 0; y < n; y++) {
    const dl = a.rows[y][0] - b.rows[y][0], dr = a.rows[y][1] - b.rows[y][1]
    if (Math.abs(dl) > 3 || Math.abs(dr) > 3) bad.push(`y=${y} left ${b.rows[y][0]}->${a.rows[y][0]} (${dl >= 0 ? '+' : ''}${dl})  right ${b.rows[y][1]}->${a.rows[y][1]} (${dr >= 0 ? '+' : ''}${dr})`)
  }
  console.log(`\nrows differing by >3px: ${bad.length}/${n}`)
  const step = Math.max(1, Math.ceil(bad.length / 40))
  bad.filter((_, i) => i % step === 0).forEach((l) => console.log('  ' + l))
}
