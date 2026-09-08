import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import cesium from 'vite-plugin-cesium';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is opt-in (npm run dev:https): WebGPU needs a secure context, so testing
// WebGPU on a phone over LAN requires https://<ip>:5177 (self-signed cert — accept
// the one-time warning on the device). Plain http stays the default for the Mac.
const useHttps = process.env.VITE_HTTPS === '1';

/**
 * The origin the `/maptiler` proxy below identifies itself as.
 *
 * The MapTiler key requires **both** `Origin` and `Referer` on every request — a
 * config change the key's owners made on 2026-09-07, which is why dev broke that
 * day with no commit of ours in between. A browser attaches the pair by itself, so
 * a real build never notices. This proxy is a *back-end* caller: nothing attaches
 * anything, and the headers have to be set programmatically.
 *
 * That much is simply correct, and on wi-dev.mediascenography.com it is also
 * honest — the dev server really is served from that domain, so it sends its own
 * identity. **On localhost it is borrowed**, and that part is the temporary half:
 * the key's allow-list already carries `*localhost:5177`, but the entry has never
 * matched. Measured against the live key, scheme irrelevant —
 *
 *     appbisweb.com            -> 200   (listed as *.appbisweb.com — wildcard at a dot)
 *     wi-dev...                -> 200
 *     localhost:5177           -> 403   <- IS on the list
 *     127.0.0.1:5173           -> 403   <- IS on the list
 *     total-erfunden.example   -> 403   (control: the list *is* enforced)
 *
 * Either header alone still passes today, but the requirement is both, so both go
 * out — a later tightening then costs us nothing.
 *
 * Requested from the devs who manage the key: one loopback entry in a form that
 * matches, e.g. `http://localhost:5177` without the leading asterisk. Once that
 * lands, this constant and the whole `/maptiler` proxy can go, and globe.ts can
 * talk to api.maptiler.com directly in dev exactly as it already does in a build.
 */
const MAPTILER_DEV_ORIGIN = 'https://wi-dev.mediascenography.com';

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
 *     over, so the hook's `setHeader` calls then run after the headers are already
 *     on the wire and throw ERR_HTTP_HEADERS_SENT — uncaught, taking the process
 *     down. (The hook stripped a header when this was written; it now sets two, and
 *     the hazard is identical — any header mutation after the flush throws.)
 *     The tile renderer aborts requests constantly as the camera moves, which is what
 *     returns sockets to the pool, so the next reuse kills the server. Pooling would
 *     mean setting the headers in a middleware on the way in instead.
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
    // any port works: the /maptiler proxy below sends an allowed origin regardless.
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
      // The MapTiler key answers a request that carries no origin identity with 403
      // and a placeholder PNG body, so the basemap stays empty — and because the
      // draped imagery is the only surface the globe has, the gap renders as sky
      // rather than as an error. See MAPTILER_DEV_ORIGIN above.
      //
      // Note this covers more than localhost: wi-dev.mediascenography.com serves
      // *this dev server* behind nginx rather than a build, so it takes the same
      // path. Only a real build (wilderness-prototype.de/livingdashboard/) talks to
      // api.maptiler.com directly and needs none of this.
      '/maptiler': {
        target: 'https://api.maptiler.com',
        // Rewrites Host, not Origin — it does nothing for the check below.
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/maptiler/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Both, and set rather than removed: the key requires the pair, and an
            // identity-less request is refused. Referer is derived from Origin so
            // the two cannot drift apart — Origin carries no path, Referer does.
            proxyReq.setHeader('origin', MAPTILER_DEV_ORIGIN)
            proxyReq.setHeader('referer', `${MAPTILER_DEV_ORIGIN}/`)
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
