import puppeteer from 'puppeteer-core'

const url = process.argv[2] ?? 'http://127.0.0.1:5177/r3f.html?panel=1&diag=1'
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1400, height: 900 },
})

try {
  const page = await browser.newPage()
  const errors = []
  const requests = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (/Maximum update depth|getSnapshot should be cached/i.test(message.text())) errors.push(message.text())
  })
  page.on('request', (request) => requests.push(request.url()))
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('#worldLocation option').length === 3, { timeout: 45_000 })
  await page.waitForFunction(
    () => [...document.querySelectorAll('#worldLocation option')].every((option) => !option.disabled),
    { timeout: 60_000 },
  )
  for (const id of ['usk', 'pantiacolla', 'peru-b2']) {
    await page.select('#worldLocation', id)
    await page.waitForFunction(() => !document.querySelector('#flyToLocation')?.disabled, { timeout: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await page.evaluate(() => document.querySelector('#flyToLocation')?.click())
    try {
      await page.waitForFunction(
        (expected) => document.querySelector('#locationStatus')?.textContent?.includes(expected),
        { timeout: 8_000 },
        id === 'peru-b2' ? 'Peru B2' : id === 'usk' ? 'Usk' : 'Pantiacolla',
      )
    } catch (error) {
      console.error(await page.evaluate(() => ({
        status: document.querySelector('#locationStatus')?.textContent,
        selected: document.querySelector('#worldLocation')?.value,
        flyDisabled: document.querySelector('#flyToLocation')?.disabled,
        body: document.body.className,
      })))
      throw error
    }
  }
  const datasets = ['peru-b2-globe', '202508-usk-globe', 'prio-z2-globe']
  for (const dataset of datasets) {
    if (!requests.some((request) => request.includes(`/${dataset}/area-manifest.json`))) throw new Error(`missing manifest: ${dataset}`)
    if (!requests.some((request) => request.includes(`/${dataset}/${dataset}-adaptive-point-hierarchy/tileset.json`))) throw new Error(`missing APH root: ${dataset}`)
  }
  if (errors.length) throw new Error(errors.join(' | '))
  const defaultPage = await browser.newPage()
  const defaultUrl = new URL(url)
  defaultUrl.search = ''
  await defaultPage.goto(defaultUrl.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await defaultPage.waitForSelector('#panelChip', { visible: true, timeout: 30_000 })
  const defaultPanel = await defaultPage.evaluate(() => ({
    gearVisible: getComputedStyle(document.querySelector('#panelChip')).display !== 'none',
    panelOpen: document.body.classList.contains('panel-open'),
  }))
  if (!defaultPanel.gearVisible || defaultPanel.panelOpen) throw new Error(`invalid default panel state: ${JSON.stringify(defaultPanel)}`)
  console.log(JSON.stringify({ ok: true, datasets, requests: requests.length, defaultPanel }))
} finally {
  await browser.close()
}
