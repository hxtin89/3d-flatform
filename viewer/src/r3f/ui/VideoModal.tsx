// On-demand field film. While open the render loop is stopped (frameloop
// 'never', set by openFieldVideo) and the rest of the app is inert.
import { useEffect, useRef, useState } from 'react'
import { APP_PARAMS } from '../params'
import { useUiStore } from '../state/ui-store'
import { closeFieldVideo } from './video-modal-actions'

export function VideoModal() {
  const open = useUiStore((s) => s.videoOpen)
  const videoRef = useRef<HTMLVideoElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [status, setStatus] = useState('Video wird geladen …')
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setReady(false)
      setPlaying(false)
      setStatus('Video wird geladen …')
      video.src = APP_PARAMS.fieldVideoUrl
      video.load()
      void video.play().catch(() => setStatus('Zum Starten bitte Play antippen.'))
      closeRef.current?.focus()
      return
    }
    video.pause()
    video.removeAttribute('src')
    video.load()
    returnFocus.current?.focus()
    returnFocus.current = null
  }, [open])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && useUiStore.getState().videoOpen) closeFieldVideo() }
    const onVisibility = () => { if (document.hidden) videoRef.current?.pause() }
    document.addEventListener('keydown', onKey)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <div
      id="videoModal"
      ref={modalRef}
      className={`video-modal ${ready ? 'is-ready' : ''} ${playing ? 'is-playing' : ''}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="videoTitle"
      hidden={!open}
      onClick={(event) => { if (event.target === modalRef.current) closeFieldVideo() }}
    >
      <section className="video-card">
        <header className="video-card-header">
          <div>
            <p className="video-eyebrow">Wilderness International · Field Film</p>
            <h2 id="videoTitle">Der Wald ist unser stärkster Verbündeter.</h2>
          </div>
          <button id="videoClose" ref={closeRef} className="video-close" type="button" aria-label="Video schließen" onClick={closeFieldVideo}>×</button>
        </header>
        <div className="video-frame">
          <video
            id="fieldVideo"
            ref={videoRef}
            controls
            playsInline
            preload="none"
            aria-label="Wilderness International Imagefilm"
            onCanPlay={() => { setReady(true); if (videoRef.current?.paused) setStatus('Zum Starten bitte Play antippen.') }}
            onPlaying={() => { setReady(true); setPlaying(true) }}
            onWaiting={() => { setPlaying(false); setStatus('Video wird geladen …') }}
            onPause={() => { if (!videoRef.current?.ended) { setPlaying(false); setStatus('Zum Fortsetzen bitte Play antippen.') } }}
            onError={() => { setReady(false); setPlaying(false); setStatus('Video konnte nicht geladen werden.') }}
          />
          <p id="videoStatus">{status}</p>
        </div>
      </section>
    </div>
  )
}
