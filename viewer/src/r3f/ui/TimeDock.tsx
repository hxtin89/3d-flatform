// Peru daylight dock with the sound toggle (painted by audio-layer.ts).
import { useEffect } from 'react'
import { bindTarget } from '../dom-targets'
import { sceneState } from '../state/scene-store'
import { useUiStore } from '../state/ui-store'

const PHASE_LABEL: Record<string, string> = {
  night: 'Nacht', sunrise: 'Sonnenaufgang', sunset: 'Sonnenuntergang', day: 'Tageslicht',
}

export function TimeDock() {
  const open = useUiStore((s) => s.timeDockOpen)
  const daylight = useUiStore((s) => s.daylight)
  const videoOpen = useUiStore((s) => s.videoOpen)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && useUiStore.getState().timeDockOpen && !useUiStore.getState().videoOpen) {
        useUiStore.setState({ timeDockOpen: false })
        document.getElementById('peruTimeDockToggle')?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [videoOpen])

  const minutes = daylight?.peruMinutes ?? 720
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  const accessibleTime = `${hour}:${String(minute).padStart(2, '0')} Uhr, Peru, ${PHASE_LABEL[daylight?.phase ?? 'day']}`
  const live = daylight?.live ?? true

  return (
    <section id="peruTimeDock" className={open ? 'is-open' : ''} data-phase={daylight?.phase ?? 'day'} aria-label="Peru daylight controls">
      <div className="peru-time-shell">
        <div className="field-bottom-primary">
          <button
            id="peruTimeDockToggle"
            type="button"
            aria-expanded={open}
            aria-controls="peruTimePanel"
            aria-label={`${live ? 'Livezeit' : 'Manuelle Zeit'}: ${accessibleTime}`}
            onClick={() => useUiStore.setState({ timeDockOpen: !open })}
          >
            <span className="peru-time-celestial" aria-hidden="true"><span className="celestial-disc"></span><span className="celestial-horizon"></span></span>
            <span className="peru-time-copy">
              <span id="peruTimeMode" className={live ? 'is-live' : ''}>{live ? 'LIVE · PET' : 'MANUAL · PET'}</span>
              <strong id="peruTimeValue">{daylight?.timeLabel ?? '12:00'}</strong>
            </span>
            <span className="peru-time-chevron" aria-hidden="true">⌃</span>
          </button>
          <button id="soundToggle" ref={bindTarget('soundToggle')} type="button" aria-pressed={false} aria-label="Naturklänge einschalten" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 10v4h3l4 3V7l-4 3H4Z" />
              <path className="sound-wave" d="M14.5 9.2a4 4 0 0 1 0 5.6M17 6.8a7.2 7.2 0 0 1 0 10.4" />
              <path className="sound-slash" d="m5 5 14 14" />
            </svg>
          </button>
        </div>
        <div id="peruTimePanel" className="peru-time-panel">
          <div className="peru-time-panel-inner">
            <div className="peru-time-control">
              <label className="peru-time-label" htmlFor="peruTimeSlider">Field light · Peru time</label>
              <button id="peruTimeNow" type="button" hidden={live} onClick={() => sceneState().environment?.setPeruMinutes(null)}>Jetzt</button>
              <input
                id="peruTimeSlider"
                type="range"
                min={0}
                max={1439}
                step={5}
                value={minutes}
                aria-label="Tageszeit in Peru"
                aria-valuetext={accessibleTime}
                onChange={(event) => sceneState().environment?.setPeruMinutes(Number(event.target.value))}
              />
              <div className="peru-time-ticks" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
            </div>
          </div>
        </div>
      </div>
      <span id="audioStatus" ref={bindTarget('audioStatus')} className="sr-only" role="status" aria-live="polite"></span>
    </section>
  )
}
