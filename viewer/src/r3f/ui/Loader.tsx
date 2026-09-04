// Fullscreen preloader with the eagle benchmark. Same markup/ids as the
// original so r3f.css applies unchanged. Progress easing runs on its own rAF
// and paints through refs — no React state per tick.
import { useEffect, useRef } from 'react'
import { createEagleBench } from '../../threejs-test/eagle-bench'
import { EAGLE_MIN_ASSEMBLY_SECONDS } from '../../threejs-test/eagle-bench-motion'
import { APP_PARAMS } from '../params'
import { frame } from '../state/frame'
import { useBootStore } from '../state/boot-store'
import { useSceneStore } from '../state/scene-store'
import { enterExperience } from '../state/actions'

export function Loader() {
  const phase = useBootStore((s) => s.phase)
  const status = useBootStore((s) => s.status)
  const stalled = useBootStore((s) => s.stalled)
  const startWithSound = useBootStore((s) => s.startWithSound)
  const rootRef = useRef<HTMLDivElement>(null)
  const percentRef = useRef<HTMLSpanElement>(null)
  const startRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)

  // Eagle bench: a real point cloud whose density follows the load progress
  // — the loading animation quietly benchmarks the point pipeline.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (APP_PARAMS.compareParam) {
      if (fillRef.current) fillRef.current.hidden = false
      return
    }
    let disposed = false
    void createEagleBench(canvas, { forceWebGL: APP_PARAMS.forceWebGL }).then((bench) => {
      if (disposed || useBootStore.getState().phase === 'entered') { bench.dispose(); return }
      useSceneStore.setState({ bench })
      canvas.hidden = false
      if (import.meta.env.DEV) (window as any).__eagleBenchDebug = () => bench.debugState()
    }).catch((error) => {
      if (fillRef.current) fillRef.current.hidden = false
      if (ghostRef.current) ghostRef.current.style.opacity = '0.12'
      console.warn('[eagle-bench] unavailable — falling back to CSS eagle + heuristic tier', error)
    })
    return () => {
      disposed = true
      useSceneStore.getState().bench?.dispose()
      useSceneStore.setState({ bench: null })
      if (import.meta.env.DEV) delete (window as any).__eagleBenchDebug
    }
  }, [])

  // Progress easing (port of tickLoaderProgress): never faster than the
  // eagle's minimum assembly time.
  useEffect(() => {
    let displayed = 0
    let last = performance.now()
    let raf = 0
    const paint = (progress: number) => {
      const root = rootRef.current
      if (!root) return
      const percentage = Math.min(100, Math.floor(progress * 100))
      root.style.setProperty('--loader-progress', `${(progress * 100).toFixed(2)}%`)
      root.setAttribute('aria-valuenow', String(percentage))
      if (percentRef.current) percentRef.current.textContent = String(percentage).padStart(2, '0')
      useSceneStore.getState().bench?.setProgress(progress)
    }
    const tick = (now: number) => {
      const boot = useBootStore.getState()
      if (boot.phase === 'entered' || boot.phase === 'failed') return
      const elapsed = Math.min(64, Math.max(0, now - last))
      last = now
      if (APP_PARAMS.loaderDebugProgress !== null) displayed = APP_PARAMS.loaderDebugProgress
      else if (displayed < frame.loaderTarget) {
        displayed = Math.min(frame.loaderTarget, displayed + elapsed / (EAGLE_MIN_ASSEMBLY_SECONDS * 1000))
      }
      paint(displayed)
      if (boot.dataReady && displayed >= 0.999 && boot.phase === 'staging') {
        displayed = 1
        paint(1)
        useBootStore.setState({ phase: 'ready' })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const stallTimer = window.setInterval(() => {
      const boot = useBootStore.getState()
      if (boot.phase !== 'staging' && boot.phase !== 'manifest' && boot.phase !== 'graphics' && boot.phase !== 'init') return
      if (boot.dataReady || performance.now() - frame.loaderLastAdvance < 20_000) return
      useBootStore.setState({ stalled: true, status: 'Die Datenverbindung antwortet ungewöhnlich langsam.' })
    }, 1000)
    return () => { cancelAnimationFrame(raf); window.clearInterval(stallTimer) }
  }, [])

  useEffect(() => {
    if (phase === 'ready') startRef.current?.focus({ preventScroll: true })
  }, [phase])

  if (phase === 'entered') return null
  const ready = phase === 'ready'
  const failed = phase === 'failed'
  return (
    <div
      id="loader"
      ref={rootRef}
      role="progressbar"
      aria-label="Point Cloud wird geladen"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-busy={!ready && !failed}
      className={`${ready || phase === 'entering' ? 'is-ready' : ''} ${phase === 'entering' ? 'finishing' : ''}`.trim()}
    >
      <div className="loader-kicker"><span>Wilderness International</span><span>Canopy Field System · Peru</span></div>
      <div className="loader-content">
        <div className="loader-eagle-frame" aria-hidden="true">
          <div className="loader-eagle loader-eagle-ghost" ref={ghostRef}></div>
          <div className="loader-eagle loader-eagle-fill" id="loaderEagleFill" ref={fillRef} hidden></div>
        </div>
        <p className="loader-system">Flight preparation / point cloud</p>
        <p id="loaderStatus" aria-live="polite">{status}</p>
        <div className="loader-meter"><span id="loaderPercent" ref={percentRef}>00</span><small>%</small></div>
        <div className="loader-actions" id="loaderActions" hidden={!ready && phase !== 'entering'}>
          <button id="loaderSoundOpt" type="button" aria-pressed={startWithSound} onClick={() => useBootStore.getState().toggleSound()}>
            <span className="loader-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
            <span id="loaderSoundOptLabel">{startWithSound ? 'Mit Naturklängen' : 'Ohne Naturklänge'}</span>
          </button>
          <button id="loaderStart" type="button" ref={startRef} onClick={enterExperience}>
            <span className="loader-start-kicker">Feldsystem bereit</span>
            <strong>Expedition starten</strong>
          </button>
        </div>
        <button className="loader-retry" id="loaderRetry" type="button" hidden={!stalled && !failed} onClick={() => location.reload()}>
          Erneut versuchen
        </button>
      </div>
      <canvas id="loaderEagleCanvas" ref={canvasRef} aria-hidden="true" hidden></canvas>
    </div>
  )
}
