import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import cesium from 'vite-plugin-cesium';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is opt-in (npm run dev:https): WebGPU needs a secure context, so testing
// WebGPU on a phone over LAN requires https://<ip>:5177 (self-signed cert — accept
// the one-time warning on the device). Plain http stays the default for the Mac.
const useHttps = process.env.VITE_HTTPS === '1';

/**
 * Serve the Three.js app at `/` in dev, the way the built site already does.
 *
 * `prepare-livingdashboard.mjs` copies threejs-test.html over index.html and moves
 * the CesiumJS viewer to cesium.html, so in production the root IS this app. Only
 * the dev server disagreed: there `/` served the legacy Cesium viewer, which needs
 * the local tile server on :8081 and shows "tileset.json not found" without it.
 *
 * That mismatch is a recurring trap rather than a cosmetic one. Anything that
 * opens the origin without a path — an embedded preview pane, a bookmark, a
 * pasted "localhost:5177" — lands on an app that cannot work locally, and it
 * reads as the dev server being broken.
 *
 * A redirect rather than a rewrite so the address bar shows where you actually
 * are, and the query string is carried over because `?preset=` and friends are
 * how this app is driven. The Cesium viewer stays reachable at /index.html.
 */
function serveThreeJsAtRoot() {
  return {
    name: 'sbb:serve-threejs-at-root',
    configureServer(server: { middlewares: { use(fn: (req: any, res: any, next: () => void) => void): void } }) {
      server.middlewares.use((req, res, next) => {
        const url: string = req.url ?? '/';
        if (url === '/' || url.startsWith('/?')) {
          res.writeHead(302, { Location: `/threejs-test.html${url.slice(1)}` });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [cesium(), serveThreeJsAtRoot(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    port: 5177,
    // Fail instead of silently moving to 5178 when the port is taken (usually a
    // dev server left running from an earlier session). The MapTiler key is
    // restricted to whitelisted origins, and 5177 is the only one this project
    // uses — on any other port the basemap just 403s, which reads as a broken
    // key rather than a wrong port. A hard "port is already in use" is far
    // easier to act on. To run a second instance deliberately, pass a port that
    // is also whitelisted: npm run dev -- --port 4177
    strictPort: true,
    host: true, // listen on all interfaces + print LAN IPs for phone testing
    allowedHosts: ["wi-dev.mediascenography.com"], // hinter dem NGINX-Reverse-Proxy erlaubte Hosts
    open: '/threejs-test.html', // auto-open the Three.js/WebGPU map app
    proxy: {
      // Proxy tile requests to the local tile server
      '/tiles': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tiles/, ''),
      },
      // The MapTiler key is domain-restricted, so every raster tile a dev server
      // on localhost requests comes back 403 (with a placeholder PNG body) and the
      // basemap stays empty. Strip the Referer here — the key answers 200 without
      // one. Dev only; the production build talks to api.maptiler.com directly.
      '/maptiler': {
        target: 'https://api.maptiler.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/maptiler/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('referer')
            proxyReq.removeHeader('origin')
          })
        },
      },
    },
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      input: {
        // Legacy Cesium viewer + Three.js/WebGPU map app + full Cesium variant
        main: resolve(__dirname, 'index.html'),
        'threejs-test': resolve(__dirname, 'threejs-test.html'),
        'cesium-test': resolve(__dirname, 'cesium-test.html'),
      },
    },
  },
});
