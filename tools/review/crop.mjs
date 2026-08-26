// Crop + magnify a region from a capture, so a critic can inspect a corner or
// a seam at a size where a few pixels of radius error are actually visible.
// Nearest-neighbour on purpose: smoothing would hide the very stair-stepping
// and radius drift this is meant to expose.
//
// Usage: node crop.mjs <in.png> <out.png> <x> <y> <w> <h> [zoom=4]
import { chromium } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'

const [, , inPath, outPath, x, y, w, h, zoomArg] = process.argv
const zoom = Number(zoomArg ?? 4)
const b64 = (await readFile(inPath)).toString('base64')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: Number(w) * zoom, height: Number(h) * zoom } })
await page.setContent(`<style>
  html,body{margin:0;background:#fff}
  canvas{display:block;image-rendering:pixelated}
</style><canvas id="c" width="${Number(w) * zoom}" height="${Number(h) * zoom}"></canvas>`)
await page.evaluate(async ({ b64, x, y, w, h, zoom }) => {
  const img = new Image()
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64 })
  const ctx = document.getElementById('c').getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, x, y, w, h, 0, 0, w * zoom, h * zoom)
}, { b64, x: Number(x), y: Number(y), w: Number(w), h: Number(h), zoom })
await writeFile(outPath, await page.locator('#c').screenshot())
await browser.close()
console.log(`${outPath}  <- ${inPath} [${x},${y} ${w}x${h}] @${zoom}x`)
