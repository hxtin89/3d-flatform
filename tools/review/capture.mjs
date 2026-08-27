// Deterministic render capture for the gauntlet loop.
//
// Exists because the browser-extension screenshot path returns images whose
// scale and crop do not match the page's own CSS pixels -- a critic comparing
// those against a Figma export judges the wrong geometry with full confidence.
// Playwright pins the viewport exactly, so a capture is reproducible across
// rounds and several can run at once (each gets its own browser context).
//
// deviceScaleFactor is 1 on purpose: the two screen captures at 1080x1920 and
// 1920x1080 then come out the same pixel size as the Figma exports of Frame 1
// Mobile and Frame 1 Desktop, so a critic can diff them directly instead of
// eyeballing across a scale factor.
//
// Usage: node capture.mjs <outDir> [name ...]
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const SB = 'http://localhost:6006/iframe.html'
const VIEWER = 'http://localhost:5178/threejs-test.html?clean=1'
// ScreenExample takes its size as args, so one story renders every breakpoint.
const screen = (w, h) =>
  `${SB}?id=screens-bento-grid-recreation--mobile&viewMode=story&args=width:${w};height:${h}`

const SHOTS = [
  // 1:1 with the Figma exports in ../ref -- the fidelity comparison.
  { name: 'screen-1080x1920', url: screen(1080, 1920), w: 1080, h: 1920 },
  { name: 'screen-1920x1080', url: screen(1920, 1080), w: 1920, h: 1080 },
  // The four sizes the brief requires, plus the crossover pair that straddles
  // where fitsPortraitArrangement flips the species row.
  { name: 'screen-390x844',   url: screen(390, 844),   w: 390,  h: 844 },
  { name: 'screen-820x1180',  url: screen(820, 1180),  w: 820,  h: 1180 },
  { name: 'screen-1440x900',  url: screen(1440, 900),  w: 1440, h: 900 },
  { name: 'screen-600x900',   url: screen(600, 900),   w: 600,  h: 900 },
  { name: 'screen-900x900',   url: screen(900, 900),   w: 900,  h: 900 },
  // Widgets 1:1 in Figma units, nothing layered over them.
  { name: 'widget-weather', url: `${SB}?id=bentogrid--weather-cluster&viewMode=story`, w: 700, h: 700 },
  { name: 'widget-species', url: `${SB}?id=bentogrid--species-row&viewMode=story`,     w: 1100, h: 760 },
  { name: 'widget-label',   url: `${SB}?id=labelline--dein-habitat&viewMode=story`,    w: 700, h: 300, ready: '.label-line' },
  // The real composition, which the stories cannot catch integration bugs in.
  { name: 'viewer-1440x900', url: VIEWER, w: 1440, h: 900, viewer: true },
  { name: 'viewer-390x844',  url: VIEWER, w: 390,  h: 844, viewer: true },
]

const outDir = process.argv[2] ?? '.'
// A flag is not an output directory. Without this, `capture.mjs --help` cheerfully
// mkdir's a folder literally named "--help" and fills it with screenshots, which is
// exactly what happened once already.
if (outDir.startsWith('-')) {
  console.log('usage: capture.mjs <outDir> [shot-name ...]\n\nshots: ' + SHOTS.map((s) => s.name).join(', '))
  process.exit(0)
}
await mkdir(outDir, { recursive: true })

// WebGL2 must really work -- the widget silhouettes come from the liquid
// field, and a silent software-fallback failure would capture empty canvases.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})

const only = process.argv.slice(3)
const wanted = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS

for (const shot of wanted) {
  const ctx = await browser.newContext({
    viewport: { width: shot.w, height: shot.h },
    deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(shot.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    // Wait for the real widgets, not a fixed sleep, so a slow or broken boot
    // fails loudly instead of quietly capturing a blank page.
    await page.waitForSelector(shot.ready ?? '.bento-grid', { timeout: shot.viewer ? 90000 : 30000 })
    await page.waitForTimeout(1800) // let the corner morph settle on its target
    await page.screenshot({ path: `${outDir}/${shot.name}.png`, animations: 'disabled', timeout: 90000 })
    console.log(`ok   ${shot.name}${errors.length ? `  [${errors.length} page errors: ${errors[0].slice(0, 90)}]` : ''}`)
  } catch (err) {
    console.log(`FAIL ${shot.name}: ${String(err).split('\n')[0]}`)
    if (errors.length) console.log(`     page error: ${errors[0].slice(0, 200)}`)
  }
  await ctx.close()
}
await browser.close()
