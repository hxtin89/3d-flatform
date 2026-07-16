import { copyFile, rename, rm, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve('dist')
const viewerEntry = resolve(output, 'threejs-test.html')
const indexEntry = resolve(output, 'index.html')
const cesiumPluginOutput = resolve(output, 'livingdashboard', 'cesium')
const cesiumOutput = resolve(output, 'cesium')

await copyFile(viewerEntry, indexEntry)

// vite-plugin-cesium includes Vite's public base in its filesystem path.
// Apache already mounts dist/ at that base, so keep the deploy artifact flat.
await rm(cesiumOutput, { recursive: true, force: true })
await rename(cesiumPluginOutput, cesiumOutput)
await rm(resolve(output, 'livingdashboard'), { recursive: true, force: true })

const html = await readFile(indexEntry, 'utf8')
const invalidRootPath = /(?:src|href)=["']\/(?!livingdashboard\/)/.exec(html)
  ?? /url\(["']?\/(?!livingdashboard\/|\/)/.exec(html)
if (invalidRootPath) {
  throw new Error(`production entry still contains a root-relative asset: ${invalidRootPath[0]}`)
}

const htaccess = `Options -Indexes
DirectoryIndex index.html
AddType text/javascript .js .mjs
AddType application/wasm .wasm
AddType model/gltf+json .gltf
AddType application/octet-stream .bin

<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteCond %{HTTPS} !=on
  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</IfModule>

<IfModule mod_headers.c>
  <FilesMatch "\\.html$">
    Header set Cache-Control "no-cache, no-store, must-revalidate"
  </FilesMatch>
  <FilesMatch "-[A-Za-z0-9_-]{8,}\\.(?:js|css)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "\\.(?:gltf|bin|wasm|woff2|webp|png|svg)$">
    Header set Cache-Control "public, max-age=86400"
  </FilesMatch>
</IfModule>
`

await writeFile(resolve(output, '.htaccess'), htaccess, 'utf8')
console.log('Living Dashboard ready at /livingdashboard/')
