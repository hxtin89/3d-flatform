/**
 * Is this hostname a development address rather than a deployed one?
 *
 * Two decisions depend on the answer and they must never disagree: which MapTiler
 * key the page sends (src/maptiler-key.ts) and which origin the `/maptiler` dev
 * proxy claims (vite.config.ts). A mismatched pair means 403 on every tile, which
 * renders as sky through the map rather than as an error — so the predicate lives
 * here, in one place with no dependencies, and both sides import it.
 *
 * Deliberately a deny-list of dev addresses rather than an allow-list of deployed
 * ones: a domain nobody has taught this file about is treated as deployed, so a new
 * production host gets the production key by default instead of silently shipping
 * the dev one.
 */
export function isDevHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return true
  // Private IPv4 ranges — a phone reaching the dev server across the LAN lands here.
  if (/^10\./.test(hostname)) return true
  if (/^192\.168\./.test(hostname)) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true
  return false
}
