import { isDevHost } from './dev-hosts'

/**
 * Which MapTiler key this page is allowed to use.
 *
 * The keys are scoped per origin by their owner, and there are two, because a key
 * only answers requests whose `Origin`/`Referer` it has been allow-listed for.
 * Measured against the live keys — every other combination is 403:
 *
 *     key …sma8   wi-dev.mediascenography.com   -> 200
 *     key …0nNM   localhost:<listed ports>      -> 200
 *     both keys   dev.dev-eagles.com            -> 200   (the dev stand-in, below)
 *
 * The localhost key is not "localhost on any port", as was noted here on 2026-09-08.
 * Re-measured on 2026-09-29, it answers localhost on 3000, 4177, 5173, 5174, 5177
 * and 8000 (http or https alike) and refuses 4173, 5178, 8080, a bare `localhost`
 * and `127.0.0.1`. Through the dev proxy this never shows, because the proxy claims
 * the stand-in. It shows wherever the browser calls MapTiler itself: a build served
 * by `npm run preview` on its default port 4173 renders sky instead of the map.
 * Serve it on a listed port instead: npm run preview -- --port 5177
 *
 * So the choice is not a preference, it is dictated by the host the page is served
 * from — which is why it is read off `location.hostname` rather than configured.
 * Get it wrong in either direction and every tile comes back 403 with a placeholder
 * PNG body, which renders as sky through the map rather than as an error.
 *
 * In dev the request travels through the `/maptiler` proxy, which claims an origin
 * this key accepts. It decides that from the same `isDevHost` predicate, so the key
 * and the headers cannot drift apart. See vite.config.ts.
 *
 * One limit worth knowing: this only holds for tiles that go through that proxy.
 * The Cesium entries talk to api.maptiler.com straight from the browser, and a
 * browser cannot claim an origin it is not on — `Origin` and `Referer` are
 * forbidden headers. Those views therefore work on `localhost`, whose own origin is
 * allow-listed, but not from a LAN address.
 */
export function maptilerKeyForHost(hostname: string = location.hostname): string {
  const dev = (import.meta.env.VITE_MAPTILER_API_KEY_LOCAL ?? '').trim()
  const deployed = (import.meta.env.VITE_MAPTILER_API_KEY ?? '').trim()
  return isDevHost(hostname) ? dev || deployed : deployed
}
