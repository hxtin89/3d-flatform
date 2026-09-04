// Headless smoke run of the React app: launches the installed Chrome with
// WebGPU enabled, loads the page, waits for the loader phase, screenshots,
// and dumps window.__log. Usage:
//   node scripts/r3f-smoke.mjs [url] [--enter] [--wait=ms] [--after=ms] [--out=dir] [--drag]
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const url = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:5177/r3f.html?panel=1&diag=1'
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const has = (name) => args.includes(`--${name}`)
const out = resolve(flag('out', 'smoke-out'))
const frameStats = (page) => page.evaluate(() => { const ft = (window.__ft ?? []).slice(5).sort((a, b) => a - b); const q = (p) => ft.length ? Number(ft[Math.floor(ft.length * p)].toFixed(2)) : 0; return { n: ft.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), over8: ft.filter((x) => x > 8.4).length, over16: ft.filter((x) => x > 16.8).length } })
const hasFlag = (n) => args.includes('--' + n)
const waitMs = Number(flag('wait', 25000))
mkdirSync(out, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal',
    '--ignore-gpu-blocklist', '--window-size=1400,900', '--autoplay-policy=no-user-gesture-required',
    // Uncapped frame rate: the 120 Hz target needs real frame times, not vsync steps.
    ...(hasFlag('unvsync') ? ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--disable-features=CalculateNativeWinOcclusion'] : []),
  ],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: Number(flag('dsf', 2)) },
})
const page = await browser.newPage()
const consoleLines = []
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`))
page.on('response', (r) => { if (r.status() >= 400) consoleLines.push(`[http ${r.status()}] ${r.url()}`) })
await page.goto(url, { waitUntil: 'domcontentloaded' })

const hudText = () => page.evaluate(() => (document.getElementById('hud')?.innerText ?? '').replace(/\n+/g, ' | '))
const phase = async () => page.evaluate(() => document.getElementById('loaderStatus')?.textContent ?? '(no loader)')
const started = Date.now()
let last = ''
while (Date.now() - started < waitMs) {
  const p = await phase()
  if (p !== last) { console.log(`${((Date.now() - started) / 1000).toFixed(1)}s  ${p}`); last = p }
  const ready = await page.evaluate(() => { const a = document.getElementById('loaderActions'); return a ? !a.hidden : true })
  if (ready) { console.log(`ready after ${((Date.now() - started) / 1000).toFixed(1)}s`); break }
  await new Promise((r) => setTimeout(r, 500))
}
if (has('hideLoader')) await page.evaluate(() => { const l = document.getElementById('loader'); if (l) l.style.display = 'none' })
if (!(await page.evaluate(() => { const a = document.getElementById('loaderActions'); return a ? !a.hidden : true }))) console.log('NOT READY —', await page.evaluate(() => ({ mapTiles: document.getElementById('mapTiles')?.textContent, pointTiles: document.getElementById('blocks')?.textContent, points: document.getElementById('visible')?.textContent, status: document.getElementById('loaderStatus')?.textContent })))
await page.screenshot({ path: resolve(out, '01-loader.png') })
console.log('HUD:', await hudText())

if (has('enter')) {
  await page.evaluate(() => document.getElementById('loaderStart')?.click())
  const series = Number(flag('series', 0))
  for (let i = 1; i <= series; i++) {
    await new Promise((r) => setTimeout(r, Number(flag('step', 1000))))
    await page.screenshot({ path: resolve(out, `s${String(i).padStart(2, '0')}.png`) })
    console.log(`s${i}: `, await page.evaluate(() => { const c = window.__wild?.camera; const g = window.__wild?.geo; return c ? `alt ${Math.round(window.__wild.range?.altitude ?? -1)} m, ground range ${Math.round(window.__wild.range?.groundRange ?? -1)} m, rig ${window.__wild.rig?.mode()}, progress ${(window.__three?.uniforms?.vignetteStrength?.value ?? 0).toFixed(2)}` : 'no camera' }))
  }
  await new Promise((r) => setTimeout(r, Number(flag('after', 4000))))
  await page.screenshot({ path: resolve(out, '02-entered.png') })
  console.log('HUD:', await hudText())
}

const rigInfo = () => page.evaluate(() => ({ mode: window.__wild?.rig?.mode(), alt: Math.round(window.__wild?.range?.altitude ?? -1), busy: window.__wild?.flight, sse: window.__wild?.sse }))
if (has('takeover')) {
  // Drag mid-descent: the rig must hand over without a jump, then resume C1.
  await page.evaluate(() => document.getElementById('loaderStart')?.click())
  await new Promise((r) => setTimeout(r, 3000))
  console.log('before drag', await rigInfo())
  await page.mouse.move(700, 450)
  await page.mouse.down({ button: 'right' })
  for (let i = 0; i < 15; i++) { await page.mouse.move(700 + i * 10, 450); await new Promise((r) => setTimeout(r, 30)) }
  await page.mouse.up({ button: 'right' })
  await new Promise((r) => setTimeout(r, 1500))
  console.log('after drag', await rigInfo())
  await page.screenshot({ path: resolve(out, 'takeover-1-user.png') })
  const resume = await page.$('#tourControls .tour-button')
  console.log('resume button', Boolean(resume))
  if (resume) {
    await resume.click()
    for (let i = 1; i <= 6; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      console.log(`resume +${i}s`, await rigInfo())
    }
    await page.screenshot({ path: resolve(out, 'takeover-2-resumed.png') })
  }
  // Keyboard takeover
  await page.keyboard.down('KeyW'); await new Promise((r) => setTimeout(r, 600)); await page.keyboard.up('KeyW')
  await new Promise((r) => setTimeout(r, 300))
  console.log('after key', await rigInfo())
}
if (has('panel')) {
  await page.evaluate(() => document.getElementById('loaderStart')?.click())
  await new Promise((r) => setTimeout(r, 12000))
  const hudBefore = await hudText()
  await page.click('#compareToggle')
  await new Promise((r) => setTimeout(r, 2500))
  console.log('compare on:', await page.evaluate(() => document.body.className), '|', (await hudText()).slice(0, 220))
  await page.screenshot({ path: resolve(out, 'panel-compare-on.png') })
  await page.click('#compareToggle')
  await new Promise((r) => setTimeout(r, 2500))
  console.log('compare off:', await page.evaluate(() => document.body.className))
  await page.click('[data-shape-style="column"]')
  await new Promise((r) => setTimeout(r, 4000))
  console.log('after style column', await rigInfo())
  await page.screenshot({ path: resolve(out, 'panel-column.png') })
  await page.click('#peruTimeDockToggle')
  await page.evaluate(() => { const s = document.getElementById('peruTimeSlider'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(s, '300'); s.dispatchEvent(new Event('input', { bubbles: true })) })
  await new Promise((r) => setTimeout(r, 1500))
  console.log('time dock:', await page.evaluate(() => document.getElementById('peruTimeValue')?.textContent + ' ' + document.getElementById('peruTimeDock')?.dataset.phase))
  await page.screenshot({ path: resolve(out, 'panel-night.png') })
  console.log('hud before/after:', hudBefore.slice(60, 200), '||', (await hudText()).slice(60, 200))
}

if (has('extras')) {
  await page.click('#loaderStart')
  await new Promise((r) => setTimeout(r, 12000))
  // double-click dolly
  const before = await rigInfo()
  await page.mouse.click(900, 500, { clickCount: 2 })
  await new Promise((r) => setTimeout(r, 2500))
  console.log('dblclick:', before, '→', await rigInfo())
  // aim mode + reticle
  await page.keyboard.press('KeyC')
  await new Promise((r) => setTimeout(r, 500))
  console.log('aim:', await page.evaluate(() => document.body.classList.contains('aim-mode') + ' ' + document.getElementById('aimReticleLabel')?.textContent))
  await page.keyboard.press('Escape')
  // field film via marker chip
  const chipRect = await page.evaluate(() => { const el = Array.from(document.querySelectorAll('#markerOverlay *')).find((e) => /FIELD FILM/i.test(e.textContent ?? '') && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 260); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  console.log('video chip found', chipRect)
  if (!chipRect) await page.evaluate(() => window.__wild?.openVideo?.())
  {
    if (chipRect) await page.mouse.click(chipRect.x, chipRect.y)
    await new Promise((r) => setTimeout(r, 1500))
    console.log('video open:', await page.evaluate(() => !document.getElementById('videoModal')?.hidden + ' inert=' + document.getElementById('appRoot')?.hasAttribute('inert') + ' fps=' + document.getElementById('fpsv')?.textContent))
    await page.screenshot({ path: resolve(out, 'video-open.png') })
    await page.keyboard.press('Escape')
    await new Promise((r) => setTimeout(r, 1500))
    console.log('video closed:', await page.evaluate(() => document.getElementById('videoModal')?.hidden + ' inert=' + document.getElementById('appRoot')?.hasAttribute('inert')))
  }
}


if (has('basemap')) {
  await new Promise((r) => setTimeout(r, 4000))
  const report = await page.evaluate(() => {
    const globe = window.__three?.globe
    if (!globe) return 'no globe'
    const out = []
    globe.tiles.group.traverse((o) => {
      if (!o.isMesh) return
      const m = o.material
      out.push({ name: o.name || o.type, mat: m?.type, hasMap: !!m?.map, mapImage: !!m?.map?.image, color: m?.color?.getHexString?.(), fog: m?.fog, visible: o.visible, geo: o.geometry?.type })
    })
    return { count: out.length, sample: out.slice(0, 6), visibleTiles: globe.tiles.visibleTiles.size }
  })
  console.log('basemap:', JSON.stringify(report))
  await page.evaluate(() => { const l = document.getElementById('loader'); if (l) l.style.display = 'none' })
  await page.screenshot({ path: resolve(out, 'basemap.png') })
}
if (has('horizon')) {
  console.log('pre-enter:', await page.evaluate(() => ({ actionsHidden: document.getElementById('loaderActions')?.hidden, btn: !!document.getElementById('loaderStart'), loaderHidden: document.getElementById('loader')?.hidden })))
  await page.evaluate(() => document.getElementById('loaderStart')?.click())
  await new Promise((r) => setTimeout(r, 2500))
  console.log('post-enter:', await page.evaluate(() => ({ loader: !!document.getElementById('loader'), sse: document.getElementById('displayed')?.textContent, status: document.getElementById('status')?.textContent })))
  await new Promise((r) => setTimeout(r, Number(flag('settle', 14000))))
  // Flatten the view toward the horizon, the way a user orbit ends up.
  await page.evaluate(() => {
    const w = window.__wild
    w.rig?.takeover?.()
    const cam = w.camera ?? window.__three.camera
    const up = cam.up.clone().normalize()
    const fwd = new (cam.position.constructor)()
    cam.getWorldDirection(fwd)
    // project forward onto the horizontal plane, then pitch down a few degrees
    const flat = fwd.clone().addScaledVector(up, -fwd.dot(up)).normalize()
    const dir = flat.clone().addScaledVector(up, -0.09).normalize()
    const target = cam.position.clone().addScaledVector(dir, 3000)
    cam.up.copy(up)
    cam.lookAt(target)
    cam.updateMatrixWorld()
  })
  if (has('noclouds')) await page.evaluate(() => window.__three.environmentLayer?.setCloudIntent(false, false))
  if (has('norain')) await page.evaluate(() => { const l = window.__three; l.rainLayer?.setEnabled?.(false) })
  if (has('freeze')) await page.evaluate(() => { const t = window.__three.stream.tiles; t.downloadQueue.maxJobs = 0; t.parseQueue.maxJobs = 0; t.processNodeQueue.maxJobs = 0 })
  // Frame times as the renderer sees them (rAF can fire faster than we draw).
  await page.evaluate(() => { window.__ft = []; const s = window.__three.renderer; const orig = s.render.bind(s); let last = performance.now(); s.render = (...a) => { const t0 = performance.now(); window.__ft.push(t0 - last); last = t0; const r = orig(...a); window.__cpu = (window.__cpu ?? []); window.__cpu.push(performance.now() - t0); return r } })
  await new Promise((r) => setTimeout(r, Number(flag('hold', 8000))))
  console.log('cpu render ms:', JSON.stringify(await page.evaluate(() => { const a = (window.__cpu ?? []).slice(10).sort((x, y) => x - y); const q = (p) => a.length ? Number(a[Math.floor(a.length * p)].toFixed(2)) : 0; return { n: a.length, p50: q(0.5), p95: q(0.95), max: a.length ? Number(Math.max(...a).toFixed(1)) : 0 } })))
  console.log('ground:', JSON.stringify(await page.evaluate(() => { let found = null; window.__three.scene.traverse((o) => { if (o.name === 'ground-fallback') found = { visible: o.visible, scale: o.scale.x, pos: o.position.toArray().map((v) => Math.round(v)), matType: o.material?.type, parent: o.parent?.name || o.parent?.type } }); return found })))
  console.log('horizon frames:', JSON.stringify(await frameStats(page)), 'perf:', JSON.stringify(await page.evaluate(() => window.__wild?.perf ?? null)))
  const stats = await page.evaluate(() => {
    const hud = (id) => document.getElementById(id)?.textContent
    return { points: hud('visible'), tiles: hud('blocks'), sse: hud('displayed'), fps: hud('fpsv'), ms: hud('msv'), alt: hud('diagAltitude'), origin: hud('diagOrigin') }
  })
  console.log('horizon:', JSON.stringify(stats))
  await page.screenshot({ path: resolve(out, 'horizon.png') })
}
if (has('perf')) {
  await page.evaluate(() => document.getElementById('loaderStart')?.click())
  await new Promise((r) => setTimeout(r, Number(flag('settle', 14000))))
  if (has('dumpPose')) console.log('pose:', await page.evaluate(() => { const c = window.__wild.camera; const e = window.__wild.toEcef(c.position.clone()); return JSON.stringify({ p: [e.x, e.y, e.z], q: c.quaternion.toArray() }) }))
  const pose = flag('pose', '')
  if (pose) { await page.evaluate((json) => window.__wild.setPoseEcef(JSON.parse(json)), pose); await new Promise((r) => setTimeout(r, 6000)) }
  await page.evaluate(() => {
    // Per-call CPU timing of the controls and the two tile traversals.
    const g = window.__three?.globe
    const stream = window.__three?.stream
    window.__prof = { controls: [], basemap: [], points: [] }
    const wrap = (obj, key, store) => { if (!obj || typeof obj[key] !== 'function') return; const orig = obj[key].bind(obj); obj[key] = (...a) => { const t = performance.now(); const r = orig(...a); window.__prof[store].push(performance.now() - t); return r } }
    wrap(g?.controls, 'update', 'controls'); wrap(g?.tiles, 'update', 'basemap'); wrap(stream?.tiles, 'update', 'points')
  })
  await page.evaluate(() => { window.__ft = []; let last = performance.now(); const loop = (t) => { window.__ft.push(t - last); last = t; if (window.__ft.length < 2000) requestAnimationFrame(loop) }; requestAnimationFrame(loop) })
  const dragMs = Number(flag('dragMs', 8000))
  await page.mouse.move(700, 450)
  if (dragMs > 0) await page.mouse.down({ button: 'right' })
  const t0 = Date.now()
  let i = 0
  if (dragMs === 0) await new Promise((r) => setTimeout(r, 8000))
  while (Date.now() - t0 < dragMs) { const a = i * 0.05; await page.mouse.move(700 + Math.cos(a) * 200, 450 + Math.sin(a) * 60); i++; await new Promise((r) => setTimeout(r, 16)) }
  if (dragMs > 0) await page.mouse.up({ button: 'right' })
  await new Promise((r) => setTimeout(r, 500))
  const stats = await page.evaluate(() => { const ft = window.__ft.slice(5).sort((a, b) => a - b); const q = (p) => ft[Math.floor(ft.length * p)]; return { frames: ft.length, p50: q(0.5).toFixed(1), p95: q(0.95).toFixed(1), p99: q(0.99).toFixed(1), over32: ft.filter((x) => x > 32).length, max: Math.max(...ft).toFixed(1) } })
  console.log('perf drag:', JSON.stringify(stats), '| HUD:', (await hudText()).slice(60, 260))
  console.log('cpu ms/call:', JSON.stringify(await page.evaluate(() => Object.fromEntries(Object.entries(window.__prof).map(([k, v]) => { const a = v.slice().sort((x, y) => x - y); const q = (p) => a.length ? a[Math.floor(a.length * p)].toFixed(2) : '-'; return [k, { n: a.length, avg: a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : '-', p95: q(0.95), max: a.length ? Math.max(...a).toFixed(1) : '-' }] })))))
}
if (has('drag')) {
  await page.mouse.move(700, 450)
  await page.mouse.down({ button: 'right' })
  for (let i = 0; i < 20; i++) { await page.mouse.move(700 + i * 8, 450 + i * 2); await new Promise((r) => setTimeout(r, 30)) }
  await page.mouse.up({ button: 'right' })
  await new Promise((r) => setTimeout(r, 1500))
  await page.screenshot({ path: resolve(out, '03-after-drag.png') })
  console.log('HUD after drag:', await hudText())
}
const httpCounts = consoleLines.filter((l) => l.startsWith('[http ')).reduce((acc, l) => { const m = /\[http (\d+)\] (\S+)/.exec(l); if (m) { const key = m[1] + ' ' + (m[2].includes('maptiler') ? 'maptiler' : m[2].includes('cloudfront') ? 'tiles' : 'other'); acc[key] = (acc[key] ?? 0) + 1 } return acc }, {})
if (Object.keys(httpCounts).length) console.log('http errors:', JSON.stringify(httpCounts))
const log = await page.evaluate(() => window.__log ?? [])
writeFileSync(resolve(out, 'log.txt'), [...log, '--- console ---', ...consoleLines].join('\n'))
console.log('log lines:', log.length, 'console lines:', consoleLines.length)
console.log(log.filter((l) => /error|uncaught|unhandled/i.test(l)).slice(0, 20).join('\n'))
await browser.close()
