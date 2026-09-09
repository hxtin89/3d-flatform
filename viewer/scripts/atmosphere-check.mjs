// Regression check for scene-owned fog and same-frame raster/point culling.
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { mkdir, writeFile } from 'node:fs/promises'
import { localBuildOnDomain } from './local-build-on-domain.mjs'
const url = process.argv[2] ?? 'http://localhost:5177/r3f.html?diag=1'
const out = process.argv[3] ?? '/private/tmp/wild-atmosphere-check'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
await mkdir(out, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 2 },
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
if (process.env.ATMOSPHERE_BUILD_DIR) await localBuildOnDomain(page, url, process.env.ATMOSPHERE_BUILD_DIR)
const errors = [], report = {}
const redact = value => String(value).replace(/([?&]key=)[^\s"'&]+/g, '$1[redacted]')
page.on('pageerror', error => errors.push(redact(error.message)))
page.on('console', message => {
  if (message.type() === 'error' && /shader|wgsl|glsl|validation/i.test(message.text())) errors.push(redact(message.text()))
})
const state = () => page.evaluate(() => {
  const t = window.__three, w = window.__wild, fog = t.scene.fog
  const misplaced = []
  t.scene.traverse(o => { if (o !== t.scene && o.fog) misplaced.push(o.name) })
  return {
    sceneFog: Boolean(fog), correctFog: fog === w.frame.fog, misplaced,
    fogNear: fog?.near, fogFar: fog?.far, cutoff: w.frame.distanceCutoff,
    targetFar: w.frame.atmosphereFar, near: t.camera.near, far: t.camera.far,
    points: w.stream.stats().points, basemap: t.globe.stats(),
  }
})
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__wild?.stream && !document.getElementById('loaderActions')?.hidden, { timeout: 90000 })
  await page.evaluate(() => {
    window.__wild.frame.rainCycleEnabled = false
    window.__three.rainLayer?.setEnabled(false)
    document.getElementById('loaderStart').click()
  })
  await sleep(14000)
  await page.evaluate(() => {
    window.__wild.setPoseEcef({
      p: [2177989.005224876, -5825385.152606091, -1410573.5569388599],
      q: [.893096081268729, .012122352038717702, .44966605576964286, .005733802583079483],
    })
    window.__wild.setMaskMode(0)
  })
  await sleep(14000)
  report.initial = await state()
  assert(report.initial.correctFog, 'Fog is not attached to the rendered Scene')
  assert.deepEqual(report.initial.misplaced, [])
  assert(report.initial.fogNear > 0 && report.initial.fogNear < report.initial.fogFar)
  assert(report.initial.fogFar <= report.initial.cutoff * 1.01, 'Fog exposes the point cutoff at close range')
  assert(report.initial.fogFar < report.initial.far, 'Far plane cuts through the fog')
  assert(report.initial.basemap.visible > 0)
  await page.screenshot({ path: `${out}/fog-on.png` })
  report.culling = await page.evaluate(() => {
    const t = window.__three, w = window.__wild
    function visible(tiles, distance, corner = false) {
      const info = tiles.cameraInfo[0]
      const inverse = tiles.group.matrixWorld.clone().invert()
      const direction = t.camera.getWorldDirection(t.camera.position.clone())
        .transformDirection(inverse)
      const center = info.position.clone().addScaledVector(direction, distance)
      if (corner) {
        const halfHeight = Math.tan(t.camera.fov * Math.PI / 360) / t.camera.zoom
        const right = center.clone().setFromMatrixColumn(t.camera.matrixWorld, 0).transformDirection(inverse)
        const up = center.clone().setFromMatrixColumn(t.camera.matrixWorld, 1).transformDirection(inverse)
        center.addScaledVector(right, distance * halfHeight * t.camera.aspect * .9)
        center.addScaledVector(up, distance * halfHeight * .9)
      }
      const sphere = { center, radius: 1 }
      const result = {}
      tiles.calculateTileViewError({ geometricError: 100, engineData: { boundingVolume: {
        distanceToPoint: p => Math.max(0, center.distanceTo(p) - 1),
        intersectsFrustum: frustum => frustum.intersectsSphere(sphere),
      } } }, result)
      return result.inView
    }
    return {
      rasterNear: visible(t.globe.tiles, 100),
      rasterBeyondFar: visible(t.globe.tiles, t.camera.far * 2),
      rasterBehindCamera: visible(t.globe.tiles, -100),
      rasterBehindFog: visible(t.globe.tiles, w.frame.fog.far * 3),
      rasterVisibleCorner: visible(t.globe.tiles, w.frame.fog.far * .8, true),
      pointsNear: visible(w.stream.tiles, 100),
      pointsBeyondCutoff: visible(w.stream.tiles, w.frame.distanceCutoff * 2),
    }
  })
  assert.deepEqual(report.culling, { rasterNear: true, rasterBeyondFar: false, rasterBehindCamera: false,
    rasterBehindFog: false, rasterVisibleCorner: true, pointsNear: true, pointsBeyondCutoff: false })
  // Simulate R3F reapplying its camera defaults during a DPR/resize update.
  // Observe the first subsequent raster traversal, not an eventually correct frame.
  report.afterReset = await page.evaluate(() => new Promise(resolve => {
    const t = window.__three, w = window.__wild, original = t.globe.updateTiles
    t.globe.updateTiles = function () {
      t.globe.updateTiles = original
      const value = { near: t.camera.near, far: t.camera.far, expectedFar: w.frame.atmosphereFar }
      original.call(this)
      resolve(value)
    }
    t.camera.near = 10; t.camera.far = 650000; t.camera.updateProjectionMatrix()
  }))
  assert(Math.abs(report.afterReset.far - report.afterReset.expectedFar) <= report.afterReset.expectedFar * .011,
    'Raster traversal used a stale camera far plane')
  await page.evaluate(() => window.__three.renderOptions.setOption('fogAtmosphere', false))
  await sleep(1000)
  report.off = await state()
  assert.equal(report.off.sceneFog, false)
  assert.equal(report.off.far, 650000)
  await page.screenshot({ path: `${out}/fog-off.png` })
  await page.evaluate(() => window.__three.renderOptions.setOption('fogAtmosphere', true))
  await sleep(2000)
  report.restored = await state()
  assert(report.restored.correctFog)
  assert(report.restored.far < 650000)
  // High-altitude view must retain the original uncapped fog range.
  await page.evaluate(() => {
    const w = window.__wild, camera = window.__three.camera
    const target = w.geo.cloudCenterRender.clone()
    camera.position.copy(target).addScaledVector(w.geo.enuUp, 100000)
    camera.lookAt(target)
    w.setPoseEcef({ p: w.toEcef(camera.position.clone()).toArray(), q: camera.quaternion.toArray() })
  })
  await sleep(6000)
  report.overview = await state()
  assert(report.overview.fogFar > 12000, 'Overview fog incorrectly capped at point-tile cutoff')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(report))
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify({ url, report, errors }, null, 2))
  await browser.close()
}
