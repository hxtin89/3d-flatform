import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const p = await (await b.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1 })).newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
await p.goto('http://localhost:5178/threejs-test.html?demo=1', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(9000)

for (let i = 0; i < 7; i++) {
  const info = await p.evaluate(() => {
    const stage = document.querySelector('.screen-frame__stage-inner')
    const pills = [...document.querySelectorAll('.screen-frame__stage-inner .label-line')]
    return {
      step: document.querySelector('.storyboard__controls span')?.textContent,
      pills: pills.length,
      texts: pills.map((el) => el.textContent.trim().slice(0, 26)).filter(Boolean),
      subtitle: !!document.querySelector('.screen-frame__stage-inner .subtitle'),
      loading: !!document.querySelector('.screen__loading'),
      docked: !!document.querySelector('.screen-frame__weather .bento-grid'),
      frames: document.querySelectorAll('.screen-frame').length,
    }
  })
  console.log(JSON.stringify(info))
  await p.$eval('.storyboard__controls button:last-child', (b) => b.click())
  await p.waitForTimeout(4200)
}
console.log(errs.length ? 'ERRORS: ' + errs.slice(0, 3).join(' | ') : 'no page errors')
await b.close()
