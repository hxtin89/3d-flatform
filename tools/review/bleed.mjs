// Counts background bleed in a capture rendered on magenta. Any magenta
// contribution shows as blue >> green, and no widget colour does that:
// gold(230,206,0) has B=0, forest(0,68,50) has B<G, grey/white have B==G.
// Decoded through a headless canvas because the repo has no PNG decoder dep.
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'

const b64 = (await readFile(process.argv[2])).toString('base64')
const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')
const res = await page.evaluate(async (b64) => {
  const img = new Image()
  await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + b64 })
  const c = document.getElementById('c')
  c.width = img.width; c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  // Mark every pixel carrying any magenta, then flood-fill the mask from the
  // canvas border. What the fill reaches is the real background around the
  // cluster; what it cannot reach is background ENCLOSED by the surface, i.e.
  // a seam, and that is the only thing worth counting.
  const W = c.width, H = c.height
  const bg = new Uint8Array(W * H)
  for (let k = 0; k < W * H; k++) {
    const i = k * 4
    if (d[i + 2] - d[i + 1] > 20 && d[i] > 60) bg[k] = 1
  }
  const seen = new Uint8Array(W * H)
  const stack = []
  for (let x = 0; x < W; x++) { stack.push(x, x + (H - 1) * W) }
  for (let y = 0; y < H; y++) { stack.push(y * W, W - 1 + y * W) }
  while (stack.length) {
    const k = stack.pop()
    if (seen[k] || !bg[k]) continue
    seen[k] = 1
    const x = k % W, y = (k / W) | 0
    if (x > 0) stack.push(k - 1)
    if (x < W - 1) stack.push(k + 1)
    if (y > 0) stack.push(k - W)
    if (y < H - 1) stack.push(k + W)
  }
  let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1
  for (let k = 0; k < W * H; k++) {
    if (!bg[k] || seen[k]) continue
    n++
    const x = k % W, y = (k / W) | 0
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y
  }
  return { n, x0, y0, x1, y1, w: W, h: H }
}, b64)
await browser.close()
console.log(res.n ? `BLEED ${res.n}px  bbox ${res.x0},${res.y0}..${res.x1},${res.y1}` : `clean: 0 bleed pixels in ${res.w}x${res.h}`)
