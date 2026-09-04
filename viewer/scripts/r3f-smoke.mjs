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
const waitMs = Number(flag('wait', 25000))
mkdirSync(out, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal',
    '--ignore-gpu-blocklist', '--window-size=1400,900', '--autoplay-policy=no-user-gesture-required',
  ],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
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
  if (ready) { console.log('ready'); break }
  await new Promise((r) => setTimeout(r, 500))
}
if (has('hideLoader')) await page.evaluate(() => { const l = document.getElementById('loader'); if (l) l.style.display = 'none' })
await page.screenshot({ path: resolve(out, '01-loader.png') })
console.log('HUD:', await hudText())

if (has('enter')) {
  await page.click('#loaderStart')
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
  await page.click('#loaderStart')
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
  await page.click('#loaderStart')
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
if (has('drag')) {
  await page.mouse.move(700, 450)
  await page.mouse.down({ button: 'right' })
  for (let i = 0; i < 20; i++) { await page.mouse.move(700 + i * 8, 450 + i * 2); await new Promise((r) => setTimeout(r, 30)) }
  await page.mouse.up({ button: 'right' })
  await new Promise((r) => setTimeout(r, 1500))
  await page.screenshot({ path: resolve(out, '03-after-drag.png') })
  console.log('HUD after drag:', await hudText())
}
const log = await page.evaluate(() => window.__log ?? [])
writeFileSync(resolve(out, 'log.txt'), [...log, '--- console ---', ...consoleLines].join('\n'))
console.log('log lines:', log.length, 'console lines:', consoleLines.length)
console.log(log.filter((l) => /error|uncaught|unhandled/i.test(l)).slice(0, 20).join('\n'))
await browser.close()
