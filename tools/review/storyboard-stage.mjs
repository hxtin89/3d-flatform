import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
for (const [w, h, label] of [[430, 932, 'mobile'], [1920, 1080, 'desktop']]) {
  const p = await (await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })).newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)))
  await p.goto('http://localhost:5178/threejs-test.html?demo=1', { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(9000)
  // walk to the video beat
  for (let i = 0; i < 4; i++) {
    const s = await p.evaluate(() => document.querySelector('.storyboard__controls span')?.textContent || '')
    if (s.includes('field-video')) break
    await p.$eval('.storyboard__controls button:last-child', (b) => b.click())
    await p.waitForTimeout(4200)
  }
  const info = await p.evaluate(() => {
    const host = document.querySelector('.screen-frame__stage')
    const inner = document.querySelector('.screen-frame__stage-inner')
    const card = document.querySelector('.media-card')
    if (!host || !inner) return { stage: false }
    const hb = host.getBoundingClientRect(), ib = inner.getBoundingClientRect()
    const cs = getComputedStyle(inner)
    return {
      stage: true,
      step: document.querySelector('.storyboard__controls span')?.textContent,
      window: [Math.round(hb.width), Math.round(hb.height)],
      innerRendered: [Math.round(ib.width), Math.round(ib.height)],
      contentScaleVar: cs.getPropertyValue('--screen-frame-content-scale').trim(),
      typeBoostVar: Number(cs.getPropertyValue('--screen-frame-type-boost')).toFixed(2),
      cardInsideWindow: card ? (card.getBoundingClientRect().right <= hb.right + 1 && card.getBoundingClientRect().bottom <= hb.bottom + 1) : null,
      frames: document.querySelectorAll('.screen-frame').length,
    }
  })
  console.log(label.padEnd(8), JSON.stringify(info), errs.length ? '| ERR ' + errs[0] : '')
  await p.close()
}
await b.close()
