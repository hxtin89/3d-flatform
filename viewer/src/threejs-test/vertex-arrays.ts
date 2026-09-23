import type * as THREE from 'three'

/**
 * Delete the WebGL2 vertex-array objects three built for `geometry` every time it is
 * disposed. Does nothing on WebGPU.
 *
 * three r185's WebGL backend caches one VAO per attribute set in `backend.vaoCache`, keyed
 * by the attributes' upload ids, and never deletes any: `destroyAttribute` only deletes the
 * buffers. A buffer still attached to a VAO that is not bound keeps its storage (GLES 3.0
 * §5.1.3), and so does the index buffer the VAO recorded. So every geometry that is
 * disposed and drawn again left one more copy of its buffers in the driver, while
 * `renderer.info` subtracted their bytes and read stable: every hide and re-show by an
 * unload plugin, every dot rebuild after a feed switch. Measured on ?webgl with the
 * basemap's GPU target at 0, one look at the sky and back left over a hundred more
 * basemap VAOs each time.
 *
 * The upload ids are readable only until three's own dispose listener deletes the
 * attributes' records, so this has to be registered first: when the geometry is built,
 * before it is drawn. three re-adds its listener on each upload, so it keeps landing after.
 *
 * Every VAO whose key names one of the geometry's attributes goes. An attribute must
 * therefore not be shared with a geometry that is still drawn: that one's render objects
 * keep their VAO and would bind a deleted one. Both callers build their attributes per
 * tile. A geometry with no vertex attributes has nothing to release, and every such
 * geometry shares the VAO under the empty key, which this leaves be.
 */
export function releaseVertexArraysOnDispose<T extends THREE.BufferGeometry>(renderer: object, geometry: T): T {
  geometry.addEventListener('dispose', () => releaseVertexArrays(renderer, geometry))
  return geometry
}

function releaseVertexArrays(renderer: object, geometry: THREE.BufferGeometry): void {
  // Read at dispose time, not at registration: the WebGL fallback replaces the renderer's
  // WebGPU backend during init.
  const backend = (renderer as any)?.backend
  if (!backend?.isWebGLBackend || !backend.vaoCache || typeof backend.has !== 'function') return
  const ids = new Set<string>()
  for (const attribute of Object.values(geometry.attributes)) {
    if (!backend.has(attribute)) continue
    const id = backend.get(attribute)?.id
    if (id !== undefined) ids.add(String(id))
  }
  if (!ids.size) return
  const gl = backend.gl as WebGL2RenderingContext
  for (const key of Object.keys(backend.vaoCache)) {
    if (!key.split(':').some((token) => ids.has(token))) continue
    const vao = backend.vaoCache[key]
    if (backend.state?.currentVAO === vao) backend.state.resetVertexState()
    gl.deleteVertexArray(vao)
    delete backend.vaoCache[key]
  }
}
