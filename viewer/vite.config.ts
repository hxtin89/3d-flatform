import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import cesium from 'vite-plugin-cesium';
import basicSsl from '@vitejs/plugin-basic-ssl';
// Shared with src/maptiler-key.ts on purpose — see maptilerOriginFor below.
import { isDevHost } from './src/dev-hosts';

// HTTPS is opt-in (npm run dev:https): WebGPU needs a secure context, so testing
// WebGPU on a phone over LAN requires https://<ip>:5177 (self-signed cert — accept
// the one-time warning on the device). Plain http stays the default for the Mac.
const useHttps = process.env.VITE_HTTPS === '1';

/**
 * The origin identity the `/maptiler` proxy below claims.
 *
 * The MapTiler keys require **both** `Origin` and `Referer` on every request — a
 * config change the keys' owners made on 2026-09-07, which is why dev broke that
 * day with no commit of ours in between. A browser attaches the pair by itself, so
 * a real build never notices. This proxy is a *back-end* caller: nothing attaches
 * anything, so it has to do it programmatically.
 *
 * A deployed host sends its own identity, which is simply correct — behind nginx
 * this dev server really is wi-dev.mediascenography.com.
 *
 * A dev host cannot, and that is the TEMPORARY half. MapTiler supports wildcards
 * for domains but not for IP ranges, so a phone reaching this server across the LAN
 * has an unpredictable origin (`192.168.x.y:5177`) that can never be allow-listed.
 * The key's owner therefore whitelisted MAPTILER_DEV_STANDIN on both keys and asked
 * us to send it for those requests. It is a borrowed identity, and it is only
 * defensible because the party doing the checking is the party that proposed it —
 * remove it once IP origins can be expressed directly.
 *
 * The dev/deployed split comes from `src/dev-hosts.ts`, the same predicate
 * `src/maptiler-key.ts` uses to choose the key, so the key and the headers cannot
 * disagree. That mismatch is precisely what 403s every tile, and a 403 here renders
 * as sky through the map rather than as an error.
 *
 * Either header alone still passes today, but the stated requirement is both, so
 * both go out — a later tightening then costs us nothing.
 */
const MAPTILER_DEV_STANDIN = 'https://dev.dev-eagles.com';

function maptilerOriginFor(req: { headers: Record<string, any>; socket?: any }): string {
  const host = String(req.headers.host ?? 'localhost:5177');
  const hostname = host.replace(/:\d+$/, '');
  if (isDevHost(hostname)) return MAPTILER_DEV_STANDIN;
  // nginx terminates TLS in front of wi-dev, so the inner request is plain http;
  // its x-forwarded-proto is the only honest source for the scheme there.
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const scheme = forwarded || (req.socket?.encrypted ? 'https' : 'http');
  return `${scheme}://${host}`;
}

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
    // any port works: the localhost key covers localhost on *any* port (measured),
    // and the /maptiler proxy sends whichever origin the request actually came in on.
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
      // A MapTiler key answers a request that carries no origin identity with 403
      // and a placeholder PNG body, so the basemap stays empty — and because the
      // draped imagery is the only surface the globe has, the gap renders as sky
      // rather than as an error. See maptilerOriginFor above.
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
          proxy.on('proxyReq', (proxyReq, req) => {
            // Both, and set rather than removed: the keys require the pair, and an
            // identity-less request is refused. Referer is derived from Origin so
            // the two cannot drift apart — Origin carries no path, Referer does.
            const origin = maptilerOriginFor(req as any)
            proxyReq.setHeader('origin', origin)
            proxyReq.setHeader('referer', `${origin}/`)
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
