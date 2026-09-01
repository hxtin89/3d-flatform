import { chromium } from 'playwright'
const [, , mode = 'demo'] = process.argv
const url = mode === 'demo'
  ? 'http://localhost:5178/threejs-test.html?demo=1'
  : 'http://localhost:5178/threejs-test.html?clean=1'
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const p = await (await b.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1 })).newPage()
const t0 = Date.now()
await p.goto(url, { waitUntil: 'domcontentloaded' })

// "Watchable" = the status line reports resident points. Poll it rather than
// guessing at a fixed wait.
let firstPoints = null, marks = []
for (let i = 0; i < 60; i++) {
  await p.waitForTimeout(1000)
  const s = await p.evaluate(() => {
    const st = document.querySelector('#status')
    const vis = document.querySelector('#visible')
    const frame = document.querySelector('.screen-frame')
    const ctrl = document.querySelector('.storyboard__controls span')
    return { status: st ? st.textContent.slice(0, 60) : null, visible: vis ? vis.textContent : null, frame: !!frame, step: ctrl ? ctrl.textContent : null }
  })
  const n = s.visible ? Number(String(s.visible).replace(/[^\d]/g, '')) || 0 : 0
  if (!firstPoints && n > 50_000) { firstPoints = Date.now() - t0; marks.push(`first 50k pts @ ${(firstPoints/1000).toFixed(1)}s`) }
  if (i === 4 || i === 9 || i === 19 || i === 39) marks.push(`t=${i+1}s pts=${n} frame=${s.frame} step=${s.step}`)
  if (firstPoints && i > 21) break
}
console.log(mode.toUpperCase())
console.log(marks.join('\n'))
console.log(firstPoints ? `=> watchable after ${(firstPoints/1000).toFixed(1)}s` : '=> never reported 50k points in 60s')
await b.close()
