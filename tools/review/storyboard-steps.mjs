import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const p = await (await b.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1 })).newPage()
const errors = []
p.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)) })
await p.goto('http://localhost:5178/threejs-test.html?clean=1', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(9000)

const shot = async (label) => {
  const info = await p.evaluate(() => {
    const frame = document.querySelector('.screen-frame')
    const ctrl = document.querySelector('.storyboard__controls span')
    return {
      frames: document.querySelectorAll('.screen-frame').length,
      step: ctrl ? ctrl.textContent : null,
      weather: !!document.querySelector('.screen-frame__weather .bento-grid'),
      species: !!document.querySelector('.screen-frame__species .bento-grid'),
      label: !!document.querySelector('.habitat-label-stack'),
      caption: !!document.querySelector('.storyboard__caption'),
      margin: frame ? getComputedStyle(frame).getPropertyValue('--screen-frame-content-scale').trim() : null,
    }
  })
  console.log(label, JSON.stringify(info))
}
await shot('1')
await p.$eval('.storyboard__controls button:last-child', (b) => b.click()); await p.waitForTimeout(700); await shot('2')
await p.$eval('.storyboard__controls button:last-child', (b) => b.click()); await p.waitForTimeout(700); await shot('3')
await p.$eval('.storyboard__controls button:last-child', (b) => b.click()); await p.waitForTimeout(700); await shot('wrap')
console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 6).join('\n') : 'no page errors')
await b.close()
