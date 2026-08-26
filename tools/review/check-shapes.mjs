// Review-time guard for the liquid field's silhouette.
//
// The field renders on the GPU, so vitest cannot see it: the two defects this
// catches were both valid GLSL that compiled and linked fine, and only showed
// up as missing pixels. Specifically, smoothstep(e0, e1, x) with e0 == e1 is
// UNDEFINED in GLSL, and this driver returns 0 -- which multiplied alpha to
// zero across every region where the feather width happened to be exactly
// constant, biting a 45-degree chevron out of the first and last widget.
// Nothing errored; the shape was just wrong.
//
// So the check is empirical: render the species row and assert each end
// widget's outer edge is actually straight. Run it after any change to the
// shader. Requires Storybook on 6006.
//
//   node tools/review/check-shapes.mjs
import { chromium } from 'playwright'

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 })
await page.goto('http://localhost:6006/iframe.html?id=bentogrid--species-row&viewMode=story', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.bento-grid', { timeout: 30000 })
await page.waitForTimeout(1800)

// Screenshot, then measure the PNG. The field is a WebGL canvas without
// preserveDrawingBuffer, so drawImage() on it after compositing yields an
// empty bitmap -- an earlier version of this check did exactly that and
// "passed" while finding no pixels at all, which is worse than no check.
const shot = (await page.screenshot()).toString('base64')
const result = await page.evaluate(async (b64) => {
  const img = new Image()
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64 })
  const c = document.createElement('canvas')
  c.width = img.naturalWidth; c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const D = ctx.getImageData(0, 0, c.width, c.height).data
  // The story renders on white; the cards are mid grey. Anything clearly
  // darker than white is card.
  const isCard = (x, y) => { const i = (y * c.width + x) * 4; return D[i] < 235 && D[i + 3] > 128 }
  const rows = []
  for (let y = 340; y <= 500; y += 10) {
    let x = 0
    while (x < c.width && !isCard(x, y)) x++
    if (x < c.width) rows.push({ y, x })
  }
  const min = rows.length ? Math.min(...rows.map((r) => r.x)) : null
  const worst = rows.length ? Math.max(...rows.map((r) => r.x - min)) : null
  return { rows, min, worst, sampled: rows.length }
}, shot)
await browser.close()

// The end card spans y270-570 with a 60px corner radius, so its straight run is
// y330-510; sampling y340-500 stays clear of both corner arcs and should vary by
// no more than a pixel or two of antialiasing. Widen the range and this check
// starts failing on the corners themselves, which is the shape working, not
// breaking -- an earlier range of y300-560 did exactly that.
const TOLERANCE = 6
const MIN_ROWS = 12
console.log(`sampled ${result.sampled} rows, left-edge min x=${result.min}, worst inward excursion=${result.worst}px (tolerance ${TOLERANCE})`)
if (result.sampled < MIN_ROWS) {
  console.error(`FAIL: only ${result.sampled} rows found any card -- the check is not seeing the render, so it cannot vouch for it.`)
  process.exit(1)
}
if (result.worst > TOLERANCE) {
  console.error('FAIL: the end widget\'s outer edge is not straight -- something is eating the silhouette.')
  console.error(result.rows.map((r) => `y${r.y}:${r.x}`).join(' '))
  process.exit(1)
}
console.log('ok: end-widget outer edges are straight')
