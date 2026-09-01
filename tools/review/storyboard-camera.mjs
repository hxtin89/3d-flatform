import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const p = await (await b.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1, hasTouch: true })).newPage()
const errors = []
p.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await p.goto('http://localhost:5178/threejs-test.html?clean=1', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(10000)

const state = () => p.evaluate(() => {
  const c = document.querySelector('.storyboard__controls span')
  const cam = document.querySelector('canvas#view')
  return { step: c ? c.textContent : null, frames: document.querySelectorAll('.screen-frame').length }
})
const click = () => p.$eval('.storyboard__controls button:last-child', (b) => b.click())

console.log('start      ', JSON.stringify(await state()))
// advance, then immediately try again -- the guard should refuse mid-flight
await click(); await p.waitForTimeout(120)
const during = await state()
await click(); await p.waitForTimeout(120)
console.log('mid-flight ', JSON.stringify(during), '-> after 2nd click', JSON.stringify(await state()))
// once it lands, advancing works again
await p.waitForTimeout(4200)
await click(); await p.waitForTimeout(300)
console.log('after land ', JSON.stringify(await state()))

// swipe left = forward
await p.waitForTimeout(4200)
const box = { x: 215, y: 500 }
await p.touchscreen.tap(box.x, box.y).catch(() => {})
await p.evaluate(({ x, y }) => {
  const mk = (type, cx) => new TouchEvent(type, {
    bubbles: true,
    touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: document.body, clientX: cx, clientY: y })],
    changedTouches: [new Touch({ identifier: 1, target: document.body, clientX: cx, clientY: y })],
  })
  window.dispatchEvent(mk('touchstart', x))
  setTimeout(() => window.dispatchEvent(mk('touchend', x - 140)), 120)
}, box)
await p.waitForTimeout(600)
console.log('after swipe', JSON.stringify(await state()))
console.log(errors.length ? 'ERRORS: ' + errors.slice(0, 4).join(' | ') : 'no page errors')
await b.close()
