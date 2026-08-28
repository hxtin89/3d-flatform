// Renders a story on a magenta ground so any seam between abutting widgets
// leaks as an unmistakable colour, unlike white (reads as a highlight) or the
// photo (reads as content). Pair with bleed.mjs, which counts only the magenta
// the surface ENCLOSES.
//
// Usage: node zoomseam.mjs <story-id> <out.png> [w] [h]
import { chromium } from 'playwright'

const [, , id, out, w = 700, h = 700] = process.argv
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await b.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 })
const p = await ctx.newPage()
await p.goto(`http://localhost:6006/iframe.html?id=${id}&viewMode=story`, { waitUntil: 'domcontentloaded' })
await p.waitForSelector('canvas')
await p.waitForTimeout(1600)
await p.evaluate(() => {
  document.documentElement.style.background = '#f0f'
  document.body.style.background = '#f0f'
})
await p.waitForTimeout(400)
await p.screenshot({ path: out })
console.log(`captured ${id} on magenta`)
await b.close()
