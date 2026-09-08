// Repeatable local R3F benchmark. Runs against a frozen baseline or a changed
// build with the same camera pose, DPR, viewport and weather sequence.
import puppeteer from 'puppeteer-core'
import { mkdir, writeFile } from 'node:fs/promises'
const url = process.argv[2] ?? 'http://127.0.0.1:5182/r3f.html?panel=1&diag=1'
const out = process.argv[3] ?? '/private/tmp/wild-performance-check'
const duration = Number(process.env.PERF_SAMPLE_MS ?? 6000)
const extended = process.env.PERF_EXTENDED === '1'
const acceptance = process.env.PERF_ACCEPTANCE === '1'
await mkdir(out, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: !process.argv.includes('--headed'),
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 2 },
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()
const errors = []
const redact = value => String(value).replace(/([?&]key=)[^\s"'&]+/g, '$1[redacted]')
page.on('pageerror', error => errors.push(redact(error.message)))
page.on('response', response => { if (response.status() >= 400 && errors.length < 30) errors.push(`${response.status()} ${redact(response.url())}`) })
page.on('console', msg => { if (msg.type() === 'error') errors.push(redact(msg.text())) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__wild?.stream && !document.getElementById('loaderActions')?.hidden, { timeout: 60000 })
  await page.evaluate(async () => {
    const frame = window.__wild.frame ?? (await import('/src/r3f/state/frame.ts')).frame
    frame.rainCycleEnabled = false
    frame.rainRequested = false
    const rain = window.__three.rainLayer ?? (await import('/src/r3f/state/scene-store.ts')).sceneState().rain
    rain?.setEnabled(false)
    document.getElementById('loaderStart')?.click()
  })
  await sleep(14000)
  await page.evaluate(async () => {
    const frame = window.__wild.frame ?? (await import('/src/r3f/state/frame.ts')).frame
    const sceneState = window.__wild.frame
      ? () => ({ rain: window.__three.rainLayer, environment: window.__three.environmentLayer })
      : (await import('/src/r3f/state/scene-store.ts')).sceneState
    const setMask = window.__wild.setMaskMode ?? (await import('/src/r3f/state/actions.ts')).setMaskMode
    setMask(0) // Every measured view must contain the continuous forest.
    window.__testFrame = frame
    window.__testScene = sceneState
    frame.rainCycleEnabled = false
    frame.rainRequested = false
    sceneState().rain.setEnabled(false)
    window.__wild.setPoseEcef({
      p: [2177989.005224876, -5825385.152606091, -1410573.5569388599],
      q: [0.893096081268729, 0.012122352038717702, 0.44966605576964286, 0.005733802583079483],
    })
    const c = window.__three.globe.controls
    c.resetState(); c.rotationInertia.set(0, 0); c.dragInertia.set(0, 0, 0); c.globeInertiaFactor = 0
    const renderer = window.__three.renderer
    renderer.backend.trackTimestamp = Boolean(renderer.backend.device?.features.has('timestamp-query'))
    window.__measurement = { active: false, frames: [], cpu: [], gpu: [], stages: {} }
    const originalRender = renderer.render.bind(renderer)
    let reading = false
    renderer.render = (...args) => {
      const started = performance.now()
      const result = originalRender(...args)
      const m = window.__measurement
      if (m.active) {
        if (m.lastRenderAt) m.frames.push(started - m.lastRenderAt)
        m.cpu.push(performance.now() - started)
        m.lastRenderAt = started
      } else m.lastRenderAt = 0
      if (!reading && renderer.backend.trackTimestamp) {
        reading = true
        renderer.resolveTimestampsAsync('render').then(value => {
          if (m.active && Number.isFinite(value)) m.gpu.push(value)
        }).finally(() => { reading = false })
      }
      return result
    }
    for (const [key, object, method] of [
      ['controls', window.__three.globe, 'updateControls'],
      ['tiles', window.__wild.stream, 'update'],
      ['environment', sceneState().environment, 'update'],
      ['rain', sceneState().rain, 'update'],
    ]) {
      if (!object?.[method]) continue
      const original = object[method].bind(object)
      object[method] = (...args) => {
        const started = performance.now(); const value = original(...args)
        if (window.__measurement.active) (window.__measurement.stages[key] ??= []).push(performance.now() - started)
        return value
      }
    }
  })
  await sleep(18000)
  const results = []
  async function sample(name, configure, settle = 2500, interaction) {
    if (settle > 0) {
      if (configure) await page.evaluate(configure)
      await sleep(settle)
    }
    await page.evaluate(() => { Object.assign(window.__measurement, { active: true, lastRenderAt: 0, frames: [], cpu: [], gpu: [], stages: {} }) })
    if (!settle && configure) await page.evaluate(configure)
    if (interaction) await interaction()
    else await sleep(duration)
    const result = await page.evaluate(() => {
      const m = window.__measurement; m.active = false
      const summarize = values => {
        const a = values.slice().sort((a, b) => a - b)
        const q = p => a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(3) : null
        return { n: a.length, p50: q(.5), p95: q(.95), p99: q(.99), max: q(1), over33: a.filter(x => x > 33.4).length }
      }
      const r = window.__three.renderer
      return { frame: summarize(m.frames), cpu: summarize(m.cpu), gpu: summarize(m.gpu),
        stages: Object.fromEntries(Object.entries(m.stages).map(([key, value]) => [key, summarize(value)])),
        stats: window.__wild.stream.stats(), perf: window.__wild.perf, sse: window.__wild.sse,
        pose: { p: window.__wild.toEcef(window.__three.camera.position.clone()).toArray(), q: window.__three.camera.quaternion.toArray() },
        pointSize: window.__three.uniforms.pointSize.value, mask: window.__three.uniforms.maskMode.value,
        range: window.__wild.range, dpr: r.getPixelRatio(), render: { ...r.info.render },
        rain: window.__testFrame.rainVisualActive, clouds: window.__testScene().environment.getCloudState(),
      }
    })
    if (result.mask !== 0) throw new Error('Measurement invalid: forest mask was enabled')
    results.push({ name, ...result })
    console.log(JSON.stringify({ name, frame: result.frame, cpu: result.cpu, gpu: result.gpu, points: result.stats.points, sse: result.sse, perf: result.perf }))
    await page.screenshot({ path: `${out}/${name}.png` })
    await writeFile(`${out}/report.json`, JSON.stringify({ url, results, errors }, null, 2))
  }
  await sample('dry')
  await sample('rain-onset', () => window.__testScene().rain.setEnabled(true), 0)
  await sample('rain')
  if (!acceptance) await sample('no-clouds', () => { window.__testScene().rain.setEnabled(false); window.__testScene().environment.setCloudIntent(false, false) })
  if (!acceptance) await sample('neutral-points', () => { window.__testScene().environment.setGradingEnabled(false) })
  if (extended) {
    await page.evaluate(async () => {
      const setMask = window.__wild.setMaskMode ?? (await import('/src/r3f/state/actions.ts')).setMaskMode
      setMask(0)
      window.__testScene().environment.setGradingEnabled(true)
      window.__testScene().environment.setCloudIntent(true, false)
    })
    if (!acceptance) await sample('full-oblique', null, 18000)
    await sample('full-nadir', () => {
      window.__testScene().rain.setEnabled(false)
      const w = window.__wild, camera = window.__three.camera
      const target = camera.position.clone().addScaledVector(camera.getWorldDirection(camera.position.clone()), w.range.groundRange)
      const up = w.geo.enuUp
      camera.position.copy(target).addScaledVector(up, 186)
      // Looking straight down: orient the image toward survey north.
      const north = camera.up.clone().setFromMatrixColumn(w.geo.enuFrame, 1)
      const savedUp = camera.up.clone()
      camera.up.copy(north); camera.lookAt(target); camera.up.copy(savedUp)
      camera.updateMatrixWorld()
      w.setPoseEcef({ p: w.toEcef(camera.position.clone()).toArray(), q: camera.quaternion.toArray() })
    }, 18000)
    await sample('nadir-rain-onset', () => window.__testScene().rain.setEnabled(true), 0)
    await sample('nadir-orbit', null, 1000, async () => {
      await page.mouse.move(700, 450); await page.mouse.down({ button: 'right' })
      const started = Date.now()
      while (Date.now() - started < duration) {
        const t = (Date.now() - started) / 1000
        await page.mouse.move(700 + Math.sin(t) * 140, 450 + Math.sin(t * .5) * 65)
        await sleep(16)
      }
      await page.mouse.up({ button: 'right' })
    })
  }
  console.log('Errors:', JSON.stringify(errors))
} finally { await browser.close() }
