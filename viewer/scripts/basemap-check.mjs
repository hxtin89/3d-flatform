// Actual MapTiler requests, visible imagery, transient recovery, and lateral
// streaming of the already published point cloud. No dataset writes.
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { mkdir, writeFile } from 'node:fs/promises'
import { localBuildOnDomain } from './local-build-on-domain.mjs'

const url = process.argv[2] ?? 'http://localhost:5177/r3f.html?diag=1'
const out = process.argv[3] ?? '/private/tmp/wild-basemap-check'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const redact = value => String(value).replace(/([?&]key=)[^\s"'&]+/g, '$1[redacted]')
await mkdir(out, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 2 },
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
const errors = [], imagery = [], snapshots = [], diagnostics = []
let failedUrl = null, recovered = false
await localBuildOnDomain(page, url, process.env.BASEMAP_BUILD_DIR, async request => {
  if (process.env.BASEMAP_TEST_RETRY === '1' && !failedUrl && /\/maps\/satellite-v4\/.*\.jpg\?/.test(request.url())) {
    failedUrl = request.url()
    await request.respond({ status: 503, headers: { 'access-control-allow-origin': '*' }, contentType: 'text/plain', body: 'Simulated temporary outage' })
    return true
  }
  return false
})
page.on('pageerror', error => errors.push(redact(error.message)))
page.on('console', message => { if (message.type() === 'error') diagnostics.push(redact(message.text())) })
page.on('requestfailed', request => diagnostics.push(`${redact(request.url())}: ${request.failure()?.errorText}`))
page.on('response', response => {
  if (/\/maps\/satellite-v4\/.*\.jpg\?/.test(response.url())) {
    imagery.push({ path: new URL(response.url()).pathname, status: response.status(), type: response.headers()['content-type'] })
    if (response.url() === failedUrl && response.status() === 200) recovered = true
  }
})
async function snapshot(name) {
  const state = await page.evaluate(() => {
    const w = window.__wild, t = window.__three, g = t.globe
    const tiles = [...g.tiles.visibleTiles]
    const textures = [], levels = []
    for (const tile of tiles) {
      for (const symbol of Object.getOwnPropertySymbols(tile)) {
        if (symbol.description === 'TILE_LEVEL') levels.push(tile[symbol])
      }
      tile.engineData?.scene?.traverse(o => {
        const map = o.material?.map
        if (map) textures.push({ width: map.image?.width, height: map.image?.height, anisotropy: map.anisotropy })
      })
    }
    const fallback = t.scene.getObjectByName('ground-fallback')
    const resolution = g.tiles.cameraMap.get(t.camera)
    const pointIds = [...w.stream.tiles.visibleTiles].map(tile => tile.content?.uri ?? tile.content?.url).filter(Boolean).sort()
    return {
      basemap: g.stats(), levels, textures,
      maxLevel: g.tiles.plugins.find(p => p.name === 'XYZ_TILES_PLUGIN').imageSource.tiling.maxLevel,
      tileState: { visible: g.tiles.group.visible, root: g.tiles.rootLoadingState, stats: g.tiles.stats },
      resolution: { x: resolution.x, y: resolution.y },
      canvas: { width: t.renderer.domElement.width, height: t.renderer.domElement.height },
      fallback: { depthWrite: fallback.material.depthWrite, depthTest: fallback.material.depthTest, renderOrder: fallback.renderOrder },
      pointStats: w.stream.stats(), pointIds, mask: t.uniforms.maskMode.value,
      cameraEnu: t.camera.position.clone().applyMatrix4(w.geo.enuInverseRender).toArray(),
      source: w.source.datasetPath,
    }
  })
  snapshots.push({ name, ...state })
  await page.screenshot({ path: `${out}/${name}.png` })
  console.log(JSON.stringify({ name, basemap: state.basemap, tileState: state.tileState, zoom: [...new Set(state.levels)], points: state.pointStats.points, cameraEnu: state.cameraEnu }))
  assert(state.basemap.visible > 0, 'No visible satellite tiles')
  assert(state.textures.length > 0, 'No decoded satellite textures')
  assert(state.textures.every(t => t.width === 512 && t.height === 512), 'Unexpected imagery dimensions')
  assert.equal(state.fallback.depthWrite, false)
  assert.equal(state.fallback.depthTest, false)
  assert.equal(state.resolution.x, state.canvas.width)
  assert.equal(state.resolution.y, state.canvas.height)
  assert.equal(state.mask, 0)
  assert.equal(state.maxLevel, 22)
  assert(Math.max(...state.levels) >= (name === 'oblique' ? 18 : 19), 'Imagery refinement stalled below close-range detail')
  return state
}
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
  await sleep(18000)
  await snapshot('oblique')
  await page.evaluate(() => {
    const w = window.__wild, camera = window.__three.camera
    const target = camera.position.clone().addScaledVector(camera.getWorldDirection(camera.position.clone()), w.range.groundRange)
    camera.position.copy(target).addScaledVector(w.geo.enuUp, 186)
    const up = camera.up.clone()
    camera.up.setFromMatrixColumn(w.geo.enuFrame, 1); camera.lookAt(target); camera.up.copy(up)
    const pose = { p: w.toEcef(camera.position.clone()).toArray(), q: camera.quaternion.toArray() }
    window.__basemapBasePose = pose
    w.setPoseEcef(pose)
  })
  await sleep(15000)
  const centre = await snapshot('nadir')
  for (const offset of [-1000, 1000]) {
    await page.evaluate(offset => {
      const w = window.__wild, camera = window.__three.camera
      const base = window.__basemapBasePose
      const p = camera.position.clone().fromArray(base.p)
      p.addScaledVector(camera.position.clone().setFromMatrixColumn(w.geo.enuFrame, 0), offset)
      w.setPoseEcef({ p: p.toArray(), q: base.q })
    }, offset)
    await sleep(18000)
    const side = await snapshot(offset < 0 ? 'west-1000m' : 'east-1000m')
    assert(side.pointStats.points > 100000, 'Point cloud missing after lateral navigation')
    assert(side.pointIds.some(id => !centre.pointIds.includes(id)), 'No new point tiles after lateral navigation')
    assert.equal(side.source, centre.source, 'Lateral navigation switched datasets')
  }
  assert.equal(errors.length, 0, JSON.stringify(errors))
  assert(imagery.some(r => r.status === 200 && r.type?.includes('image/jpeg')))
  assert(!imagery.some(r => [401, 403, 404].includes(r.status)), 'Imagery access failed')
  if (process.env.BASEMAP_TEST_RETRY === '1') assert(recovered, 'Transient failure did not recover')
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify({ url, localBuild: Boolean(process.env.BASEMAP_BUILD_DIR), recovered, injectedFailure: Boolean(failedUrl), imagery, snapshots, errors, diagnostics }, null, 2))
  await browser.close()
}
