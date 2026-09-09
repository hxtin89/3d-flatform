/** Production always uses the deployment key, including local build previews.
 * The localhost key is only available to the development server. */
export function getMapTilerKey(hostname = location.hostname): string {
  const primary = (import.meta.env.VITE_MAPTILER_API_KEY ?? '').trim()
  if (import.meta.env.PROD) return primary
  const local = hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  return local ? (import.meta.env.VITE_MAPTILER_API_KEY_LOCAL?.trim() || primary) : primary
}
