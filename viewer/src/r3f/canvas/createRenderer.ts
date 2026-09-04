// Async `gl` factory for <Canvas>: WebGPU first, the library falls back to its
// WebGL2 backend on its own. R3F mounts the scene only after the promise
// resolves, so every child sees an initialised renderer.
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { APP_PARAMS } from '../params'

export type AppRenderer = WebGPURenderer

export async function createRenderer(props: { canvas: unknown }): Promise<THREE.WebGLRenderer> {
  const renderer = new WebGPURenderer({
    canvas: props.canvas,
    antialias: false,
    forceWebGL: APP_PARAMS.forceWebGL,
  } as any)
  await renderer.init()
  return renderer as unknown as THREE.WebGLRenderer
}

export function isWebGPUBackend(renderer: unknown): boolean {
  const backend: any = (renderer as any)?.backend
  return Boolean(backend?.isWebGPUBackend ?? (backend && /WebGPU/i.test(backend.constructor?.name)))
}
