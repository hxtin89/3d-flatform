// R3F root on our own <canvas>. <Canvas> measures its container with a
// ResizeObserver, which never fires while the tab is hidden, so an occluded
// window would sit at "Initialisiere GPU" forever. The app is always the
// full window: window.innerWidth/Height is the size, a resize listener keeps
// it current, and configure() runs the moment React commits.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import * as THREE from 'three'
import { createRoot, extend, type ReconcilerRoot } from '@react-three/fiber'
import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { bindTarget } from '../dom-targets'
import { uiState, useUiStore } from '../state/ui-store'
import { createRenderer } from './createRenderer'

extend(THREE as any)

function windowSize() {
  return { width: window.innerWidth, height: window.innerHeight, top: 0, left: 0 }
}

export function CanvasRoot({ children }: { children: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<ReconcilerRoot<HTMLCanvasElement> | null>(null)
  /** Set once the first configure() resolved; a second configure() before
   * that would await a second WebGPURenderer. */
  const configuredRef = useRef(false)
  const dpr = useUiStore((s) => s.dpr)
  const frameloop = useUiStore((s) => s.frameloop)
  const splatSolo = useUiStore((s) => s.splatSolo)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const root = createRoot(canvas)
    rootRef.current = root
    let cancelled = false
    const configure = () => root.configure({
      gl: createRenderer,
      flat: true,
      dpr: uiState().dpr,
      frameloop: uiState().frameloop,
      camera: { fov: 60, near: 10, far: EXPERIENCE_CONFIG.atmosphere.maximumFarM },
      size: windowSize(),
    })
    configure().then(() => { configuredRef.current = true; if (!cancelled) root.render(children) })
      .catch((error) => console.error('[r3f] renderer setup failed', error))
    const onResize = () => { if (configuredRef.current) void configure() }
    window.addEventListener('resize', onResize)
    return () => {
      cancelled = true
      configuredRef.current = false
      window.removeEventListener('resize', onResize)
      rootRef.current = null
      root.unmount()
    }
    // The scene element is static; the root re-renders on its own store changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root || !configuredRef.current) return
    void root.configure({
      gl: createRenderer,
      flat: true,
      dpr,
      frameloop,
      camera: { fov: 60, near: 10, far: EXPERIENCE_CONFIG.atmosphere.maximumFarM },
      size: windowSize(),
    })
  }, [dpr, frameloop])

  return (
    <div id="viewHost" ref={bindTarget('canvasHost')} style={{ display: splatSolo ? 'none' : undefined }}>
      <canvas ref={canvasRef} id="view" />
    </div>
  )
}
