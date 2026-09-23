/**
 * Workaround for a one-shot dispose listener in three r185's `Geometries` module.
 *
 * `initGeometry` marks the geometry `initialized` and adds a `dispose` listener that
 * destroys its GPU buffers and then removes itself. Nothing ever clears `initialized`,
 * so `updateForRender` never calls `initGeometry` for that geometry again and the
 * listener is never put back. From the second `dispose()` of the same geometry on,
 * nothing frees its buffers — and `Info.memoryMap`, a strong Map, keeps the attributes
 * (typed arrays and GPU buffers both) alive until the renderer itself is disposed.
 *
 * That is the UnloadTilesPlugin pattern exactly: every hide disposes the tile geometry
 * and keeps it for the next show. The first unload of a tile freed its VRAM; every
 * later one freed nothing, while the plugin counted the bytes as gone.
 *
 * Forgetting the geometry once three's own listener has run puts it back to "never
 * seen": the next render re-runs `initGeometry`, which re-arms the listener and the
 * `info.memory.geometries` count along with it. `initialized` is the only thing three
 * keeps in that entry, so nothing else is lost.
 *
 * Still unfixed on three's dev branch as of 2026-09-21. Remove once three clears the
 * entry itself on dispose.
 */
export function installGeometryDisposeFix(renderer: any): boolean {
  const geometries = renderer?._geometries
  if (!geometries || typeof geometries.initGeometry !== 'function') return false
  const initGeometry = geometries.initGeometry.bind(geometries)
  geometries.initGeometry = (target: any) => {
    initGeometry(target)
    // r185 passes the render object; three's dev branch already passes the geometry.
    const geometry = target?.isBufferGeometry ? target : target?.geometry
    if (!geometry) return
    // Added after three's listener, so it runs after the buffers are destroyed.
    const forget = () => {
      geometry.removeEventListener('dispose', forget)
      geometries.delete(geometry)
    }
    geometry.addEventListener('dispose', forget)
  }
  return true
}
