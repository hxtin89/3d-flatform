import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { localBuildOnDomain } from './local-build-on-domain.mjs'
const url = process.argv[2] ?? 'http://127.0.0.1:5182/r3f.html?panel=1&diag=1'
const out = process.argv[3] ?? '/private/tmp/wild-navigation-check'
await mkdir(out, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 2, hasTouch: true },
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
if (process.env.NAV_BUILD_DIR) await localBuildOnDomain(page, url, process.env.NAV_BUILD_DIR)
const errors = []
const redact = value => String(value).replace(/([?&]key=)[^\s"'&]+/g, '$1[redacted]')
page.on('pageerror', e => errors.push(redact(e.message)))
page.on('console', message => {
  if (message.type() === 'error' && /shader|wgsl|glsl|validation/i.test(message.text())) errors.push(redact(message.text()))
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
const read = () => page.evaluate(() => {
  const c = window.__three.globe.controls
  return { count: c.pointerTracker.getPointerCount(), state: c.state,
    pivot: window.__wild.toEcef(c.pivotPoint.clone()).toArray(),
    camera: window.__wild.toEcef(window.__three.camera.position.clone()).toArray(),
    navigation: window.__wild.navigation, sse: window.__wild.sse,
    points: window.__wild.stream.stats().points,
  }
})
const report = {}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__wild?.stream && !document.getElementById('loaderActions')?.hidden, { timeout: 60000 })
  await page.evaluate(() => document.getElementById('loaderStart').click())
  await sleep(16000)
  await page.evaluate(() => window.__wild.rig.takeover())
  report.backend = await page.evaluate(() => document.getElementById('backend')?.textContent)
  if (new URL(url).searchParams.has('webgl')) assert.equal(report.backend, 'WebGL2')
  await page.mouse.move(700, 450)
  await page.mouse.down({ button: 'right' })
  const first = await read()
  assert.equal(first.count, 1)
  assert.equal(first.state, 2)
  report.press = first
  let drift = 0
  for (let i = 0; i < 35; i++) {
    await page.mouse.move(700 + Math.sin(i / 8) * 240, 450 + Math.sin(i / 12) * 130)
    if (i === 15) await page.evaluate(async () => {
      window.__wild.rebase()
    })
    await sleep(16)
    const state = await read()
    assert.equal(state.count, 1, `pointer lost at ${i}`)
    drift = Math.max(drift, Math.hypot(...state.pivot.map((v, j) => v - first.pivot[j])))
    assert.ok(state.camera.every(Number.isFinite))
    assert.ok(state.sse < 16, 'gesture coarsened near detail')
  }
  report.pivotDriftM = drift
  assert.ok(drift < .01, `pivot drift ${drift}`)
  await page.mouse.move(1450, 450)
  await page.mouse.move(700, 450)
  assert.equal((await read()).count, 1, 'window edge lost capture')
  await page.mouse.up({ button: 'right' })
  report.release = await read()
  assert.equal(report.release.count, 0)
  await page.screenshot({ path: `${out}/orbit.png` })
  await page.mouse.down({ button: 'right' })
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  assert.equal((await read()).count, 0, 'blur left a stuck gesture')
  await page.mouse.up({ button: 'right' })
  await page.mouse.down({ button: 'left' })
  assert.equal((await read()).state, 1, 'left drag rotated')
  await page.mouse.up({ button: 'left' })
  const cdp = await page.createCDPSession()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 650, y: 450, id: 1 }, { x: 750, y: 450, id: 2 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 650, y: 420, id: 1 }, { x: 750, y: 480, id: 2 }] })
  await sleep(100)
  report.touch = await read()
  assert.equal(report.touch.state, 2, 'two-finger drag did not rotate')
  assert.ok(report.touch.camera.every(Number.isFinite))
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  assert.equal((await read()).count, 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ pivotDriftM: drift, sampleMs: first.navigation.sampleMs, reason: first.navigation.reason, touchState: report.touch.state, errors }))
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify({ report, errors }, null, 2))
  await browser.close()
}
