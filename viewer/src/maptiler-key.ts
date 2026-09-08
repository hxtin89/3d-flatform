/**
 * Which MapTiler key this page is allowed to use.
 *
 * The keys are scoped per origin by their owner, and there are two, because a key
 * only answers requests whose `Origin`/`Referer` it has been allow-listed for.
 * Measured against the live keys — every other combination is 403:
 *
 *     key …sma8   Referer/Origin wi-dev.mediascenography.com   -> 200
 *     key …0nNM   Referer/Origin localhost:<any port>          -> 200
 *
 * So the choice is not a preference, it is dictated by the host the page is served
 * from — which is why it is read off `location.hostname` rather than configured.
 * Get it wrong in either direction and every tile comes back 403 with a placeholder
 * PNG body, which renders as sky through the map rather than as an error.
 *
 * Two gaps in the localhost key, both measured, neither reachable through
 * `npm run dev`, but worth knowing before someone tries:
 *   - `127.0.0.1` is NOT covered — only the name `localhost`.
 *   - a bare `localhost` with no port is NOT covered; any port is.
 * `host: true` in the dev server also prints a LAN address for phone testing, and
 * that origin is on neither key — a phone gets the scene without a basemap.
 *
 * In dev the request additionally travels through the `/maptiler` proxy, which
 * attaches the matching header pair. It derives them from the incoming request's
 * own host, i.e. from the same truth this function reads, so the key and the
 * headers cannot drift apart. See vite.config.ts.
 */
export function maptilerKeyForHost(hostname: string = location.hostname): string {
  const local = (import.meta.env.VITE_MAPTILER_API_KEY_LOCAL ?? '').trim()
  const remote = (import.meta.env.VITE_MAPTILER_API_KEY ?? '').trim()
  // Only the exact name the key is scoped to. Substring matching would quietly
  // pick the local key for something like `localhost.example.com`.
  if (hostname === 'localhost') return local || remote
  return remote
}
