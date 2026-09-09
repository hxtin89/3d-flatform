// Browser-only test harness: serve local build files to an isolated browser
// under its real deployment origin. External imagery requests stay untouched;
// no upload, DNS change, or request-header spoofing is involved.
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

export async function localBuildOnDomain(page, url, directory, intercept) {
  const origin = new URL(url).origin
  const root = directory && resolve(directory)
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' }
  await page.setRequestInterception(true)
  page.on('request', async request => {
    if (intercept && await intercept(request)) return
    const target = new URL(request.url())
    if (root && target.origin === origin && target.pathname.startsWith('/livingdashboard/')) {
      const path = resolve(root, decodeURIComponent(target.pathname.slice('/livingdashboard/'.length)))
      if (path.startsWith(root + sep)) {
        try {
          const body = await readFile(path)
          await request.respond({ status: 200, contentType: types[extname(path)] ?? 'application/octet-stream', body })
          return
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error }
      }
    }
    await request.continue()
  })
}
