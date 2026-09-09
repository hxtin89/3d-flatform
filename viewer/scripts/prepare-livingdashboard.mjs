import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve('dist')
const viewerEntry = resolve(output, 'threejs-test.html')
const indexEntry = resolve(output, 'index.html')

// threejs-test.html is the only entry Vite builds, so index.html is this file's to
// create. It keeps its own URL as well, because that is the address the app has been
// deployed and bookmarked under.
await copyFile(viewerEntry, indexEntry)

for (const entry of ['index.html', 'threejs-test.html']) {
  const html = await readFile(resolve(output, entry), 'utf8')
  const invalidRootPath = /(?:src|href)=["']\/(?!livingdashboard\/)/.exec(html)
    ?? /url\(["']?\/(?!livingdashboard\/|\/)/.exec(html)
  if (invalidRootPath) {
    throw new Error(`${entry} still contains a root-relative asset: ${invalidRootPath[0]}`)
  }
}

const htaccess = `Options -Indexes
DirectoryIndex index.html
AddType text/javascript .js .mjs
AddType application/wasm .wasm
AddType audio/mp4 .m4a
AddType audio/webm .webm
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
  <FilesMatch "\\.(?:gltf|bin|wasm|m4a|webm|woff2|webp|png|svg)$">
    Header set Cache-Control "public, max-age=86400"
  </FilesMatch>
</IfModule>
`

await writeFile(resolve(output, '.htaccess'), htaccess, 'utf8')
console.log('Living Dashboard ready at /livingdashboard/')
