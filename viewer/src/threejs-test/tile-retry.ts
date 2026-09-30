// Retry tiles whose download failed for a passing reason.
//
// A tile that fails to load is marked FAILED by 3d-tiles-renderer and never requested again
// while it stays in the cache: the renderer keeps the failed tile in its LRU cache as if
// loaded, and requestTileContents gives up on any tile the cache already holds. Only
// eviction clears it, and a tile under the camera is never evicted. One dropped connection
// therefore leaves a permanent hole — for the basemap, a whole subtree of imagery, so the
// sky shows through the ground in a square kilometres wide (a z14 tile is ~2.4 km here) and
// the point cloud's gaps glare white against it. The dev server's MapTiler proxy drops such
// connections now and then (ECONNRESET, 500, or a minute's wait).
//
// The library's own resetFailedTiles() does not help here: it resets the state but leaves the
// tile in the cache, so the retry is refused just the same (checked in 0.4.28:
// TilesRendererBase.requestTileContents → LRUCache.add returns false for a held tile).
//
// So every failure that is not the server saying no (4xx: the tile does not exist, or the
// key or Referer is refused) schedules that tile for a retry: when it is due, the tile is
// taken out of the cache with the cache's own remove(), whose callback returns it to
// UNLOADED, and a 'needs-update' event makes the next traversal ask for it again, even with
// the camera standing still. Each tile waits 2 s after its first failure and twice as long
// after every further one, up to a minute; a tile that loads starts over. Refused tiles are
// left to eviction, as before.
const FIRST_DELAY_MS = 2_000
const MAX_DELAY_MS = 60_000
/** 3d-tiles-renderer's loading states (constants.js): UNLOADED 0, FAILED -1. */
const UNLOADED = 0
const FAILED = -1

interface RetryableTiles {
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
  dispatchEvent(event: { type: string }): void
  lruCache: { has(item: unknown): boolean; remove(item: unknown): boolean }
  stats: { failed: number }
}

/** The server refused the tile (it is missing, or not ours): retrying cannot help. */
function refused(error: unknown): boolean {
  return /error code 4\d\d\b/.test(String((error as Error)?.message ?? error))
}

/** Retry `tiles`' transiently failed downloads, each with its own backoff. Returns the teardown. */
export function retryFailedTiles(tiles: RetryableTiles, label: string): () => void {
  const failures = new WeakMap<object, number>()
  const due = new Map<any, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (due.size === 0) return
    let next = Infinity
    for (const at of due.values()) next = Math.min(next, at)
    timer = setTimeout(retry, Math.max(0, next - performance.now()))
  }
  const retry = () => {
    timer = null
    const now = performance.now()
    let count = 0
    for (const [tile, at] of due) {
      if (at > now + 5) continue
      due.delete(tile)
      if (tile.internal?.loadingState !== FAILED) continue
      if (!tiles.lruCache.remove(tile)) tile.internal.loadingState = UNLOADED
      count++
    }
    if (count > 0) {
      tiles.stats.failed = Math.max(0, tiles.stats.failed - count)
      // The globe runs UpdateOnChangePlugin, which skips the traversal while the camera stands
      // still: without this nudge the reset tiles wait for the next camera move.
      tiles.dispatchEvent({ type: 'needs-update' })
      console.info(`[${label}] retrying ${count} failed tile${count > 1 ? 's' : ''}`)
    }
    schedule()
  }
  const onError = (event: any) => {
    // A null tile is the root tileset: the caller decides what to do about that.
    if (event.tile == null || refused(event.error)) return
    const count = failures.get(event.tile) ?? 0
    failures.set(event.tile, count + 1)
    due.set(event.tile, performance.now() + Math.min(FIRST_DELAY_MS * 2 ** count, MAX_DELAY_MS))
    schedule()
  }
  const onLoad = (event: any) => { if (event.tile) failures.delete(event.tile) }
  tiles.addEventListener('load-error', onError)
  tiles.addEventListener('load-model', onLoad)
  return () => {
    tiles.removeEventListener('load-error', onError)
    tiles.removeEventListener('load-model', onLoad)
    if (timer !== null) clearTimeout(timer)
    timer = null
    due.clear()
  }
}
