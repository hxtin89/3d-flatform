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

/**
 * Settled: do NOT give the /maptiler proxy a keep-alive agent.
 *
 * Vite bundles http-proxy, which does `outgoing.agent = options.agent || false`,
 * so every proxied tile opens its own socket: one DNS lookup, TCP handshake and
 * TLS handshake each, ~40-50 ms of setup per tile. Pooling that with
 * `new https.Agent({ keepAlive: true, maxSockets: 6 })` looks like free money and
 * measures well — 6 connections instead of 24, and 4.6x faster on a slow resolver.
 *
 * It was tried on 2026-09-03 and reverted the same day, because it breaks the
 * basemap in two ways that only appear later:
 *
 *  1. Stale pooled sockets. api.maptiler.com is behind Cloudflare, which closes
 *     idle connections. A bare `https.Agent` has no free-socket timeout, so it
 *     keeps handing out sockets the far end already closed; the request is written
 *     into a dead socket and hangs until it resets. Measured: 20 s to ECONNRESET on
 *     a single tile after the pool had gone idle, with the loader stuck at 95% and
 *     the tile renderer issuing no further requests at all. Note that Node's own
 *     global agent sets `timeout: 5000` for exactly this reason.
 *  2. It crashes the dev server outright via the `proxyReq` hook below. Node flushes
 *     the request headers synchronously when a *reused* keep-alive socket is handed
 *     over, so `removeHeader('referer')` then runs after the headers are already on
 *     the wire and throws ERR_HTTP_HEADERS_SENT — uncaught, taking the process down.
 *     The tile renderer aborts requests constantly as the camera moves, which is what
 *     returns sockets to the pool, so the next reuse kills the server. Pooling would
 *     mean stripping the header in a middleware on the way in instead.
 *
 * Both are fixable, but the payoff does not justify it: on a healthy network the
 * wall-clock difference is inside the noise, and the slow-resolver case it was meant
 * to fix was a broken home router, not something the repo should carry a workaround
 * for. One connection per tile is slower and completely reliable.
 */

export default defineConfig({
  plugins: [cesium(), serveThreeJsAtRoot(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    // PORT set in the environment means something upstream already picked a free port
    // for this process — an agent session running a second instance alongside the one
    // you are using. Honour it, and let it move on if that port is taken too.
    //
    // Without PORT the hard default stands: fail instead of silently moving to 5178
    // when the port is taken (usually a dev server left running from an earlier
    // session). The MapTiler key is restricted to whitelisted origins, and 5177 is the
    // only one this project uses — on a *deployed* origin that is not whitelisted the
    // basemap just 403s, which reads as a broken key rather than a wrong port. In dev
    // any port works: the /maptiler proxy below strips the Referer the key rejects.
    // To run a second instance by hand: npm run dev -- --port 4177
    port: Number(process.env.PORT) || 5177,
    strictPort: !process.env.PORT,
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
