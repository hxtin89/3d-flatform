// 3DGS feasibility test (gaussian-splat-layer.ts): its own WebGL canvas
// appended to body. Solo mode hides the R3F canvas and stops its loop
// (frameloop 'never'); this component runs the splat layer's own rAF.
import { useEffect, useRef } from 'react'
import type { GaussianSplatLayer } from '../../threejs-test/gaussian-splat-layer'
import { APP_PARAMS } from '../params'
import { useUiStore } from '../state/ui-store'

export function SplatOverlay() {
  const solo = useUiStore((s) => s.splatSolo)
  const layerRef = useRef<GaussianSplatLayer | null>(null)

  useEffect(() => {
    if (!solo) { layerRef.current?.setEnabled(false); return }
    if (!APP_PARAMS.gaussianSplatUrl) return
    let raf = 0
    let cancelled = false
    // Spark is a 5 MB bundle: loaded on first use only, like the old app.
    void import('../../threejs-test/gaussian-splat-layer').then(({ createGaussianSplatLayer }) => {
      if (cancelled) return
      layerRef.current ??= createGaussianSplatLayer({
        url: APP_PARAMS.gaussianSplatUrl,
        onStateChange: (state) => useUiStore.setState({ splatMessage: state.message }),
      })
      const layer = layerRef.current
      layer.setEnabled(true)
      const tick = () => { layer.update(); raf = requestAnimationFrame(tick) }
      raf = requestAnimationFrame(tick)
    })
    const onResize = () => layerRef.current?.resize()
    const highlight = (event: KeyboardEvent, on: boolean) => {
      document.querySelector(`#splatHint .keycap[data-key="${event.code}"]`)?.classList.toggle('is-active', on)
    }
    const onKeyDown = (event: KeyboardEvent) => highlight(event, true)
    const onKeyUp = (event: KeyboardEvent) => highlight(event, false)
    window.addEventListener('resize', onResize)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      document.querySelectorAll('#splatHint .keycap.is-active').forEach((el) => el.classList.remove('is-active'))
    }
  }, [solo])

  useEffect(() => () => layerRef.current?.dispose(), [])
  return null
}
