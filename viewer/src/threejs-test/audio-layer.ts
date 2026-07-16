import * as THREE from 'three'
import { EXPERIENCE_CONFIG } from './config'
import type { DaylightState } from './environment-layer'

export interface AudioLayer {
  update(daylight: DaylightState, rainActive: boolean): void
  dispose(): void
}

interface AudioLayerOptions {
  toggle: HTMLButtonElement
  status: HTMLElement
}

interface Track {
  element: HTMLAudioElement
  gain: GainNode | null
  lastTarget: number
}

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
  return `${base}${path.replace(/^\/+/, '')}`
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function createTrack(path: string): Track {
  const element = new Audio()
  element.preload = 'none'
  element.loop = true
  const supportsAac = element.canPlayType('audio/mp4; codecs="mp4a.40.2"') !== ''
  const compatiblePath = supportsAac ? path : path.replace(/\.m4a$/i, '.webm')
  element.src = assetUrl(compatiblePath)
  return { element, gain: null, lastTarget: -1 }
}

export function createAudioLayer(options: AudioLayerOptions): AudioLayer {
  const { toggle, status } = options
  const AudioContextClass = window.AudioContext ?? (window as any).webkitAudioContext as typeof AudioContext | undefined
  const day = createTrack(EXPERIENCE_CONFIG.audio.dayFile)
  const night = createTrack(EXPERIENCE_CONFIG.audio.nightFile)
  const rain = createTrack(EXPERIENCE_CONFIG.audio.rainFile)
  const tracks = [day, night, rain]
  let context: AudioContext | null = null
  let master: GainNode | null = null
  let enabled = false
  let disposed = false
  let pauseTimer = 0
  let currentDaylight: DaylightState | null = null
  let currentRainActive = false

  function paintButton(message?: string): void {
    toggle.classList.toggle('is-on', enabled)
    toggle.setAttribute('aria-pressed', String(enabled))
    toggle.setAttribute('aria-label', enabled ? 'Naturklänge ausschalten' : 'Naturklänge einschalten')
    status.textContent = message ?? (enabled ? 'Naturklänge aktiviert' : 'Naturklänge stumm')
  }

  function initialize(): void {
    if (context || !AudioContextClass) return
    context = new AudioContextClass()
    master = context.createGain()
    master.gain.value = 0
    master.connect(context.destination)
    for (const track of tracks) {
      track.gain = context.createGain()
      track.gain.gain.value = 0
      context.createMediaElementSource(track.element).connect(track.gain).connect(master)
      track.element.load()
    }
  }

  function ramp(track: Track, target: number, seconds: number): void {
    if (!context || !track.gain || Math.abs(track.lastTarget - target) < 0.008) return
    const parameter = track.gain.gain
    const now = context.currentTime
    parameter.cancelScheduledValues(now)
    parameter.setValueAtTime(parameter.value, now)
    parameter.linearRampToValueAtTime(target, now + seconds)
    track.lastTarget = target
  }

  function applyMix(): void {
    if (!context || !currentDaylight) return
    const start = THREE.MathUtils.degToRad(EXPERIENCE_CONFIG.audio.nightBlendEndDeg)
    const end = THREE.MathUtils.degToRad(EXPERIENCE_CONFIG.audio.nightBlendStartDeg)
    const dayMix = smoothstep(start, end, currentDaylight.sunElevationRad)
    ramp(day, EXPERIENCE_CONFIG.audio.ambientVolume * dayMix, EXPERIENCE_CONFIG.audio.daylightFadeSeconds)
    ramp(night, EXPERIENCE_CONFIG.audio.ambientVolume * (1 - dayMix), EXPERIENCE_CONFIG.audio.daylightFadeSeconds)
    ramp(rain, currentRainActive ? EXPERIENCE_CONFIG.audio.rainVolume : 0, EXPERIENCE_CONFIG.audio.weatherFadeSeconds)
  }

  async function setEnabled(nextEnabled: boolean): Promise<void> {
    if (disposed || nextEnabled === enabled) return
    if (!AudioContextClass) {
      status.textContent = 'Web Audio wird von diesem Browser nicht unterstützt.'
      toggle.disabled = true
      return
    }
    window.clearTimeout(pauseTimer)
    initialize()
    if (!context || !master) return

    if (nextEnabled) {
      enabled = true
      paintButton('Naturklänge werden gestartet …')
      try {
        const resume = context.resume()
        const plays = tracks.map((track) => track.element.play())
        await Promise.all([resume, ...plays])
        const now = context.currentTime
        master.gain.cancelScheduledValues(now)
        master.gain.setValueAtTime(master.gain.value, now)
        master.gain.linearRampToValueAtTime(
          EXPERIENCE_CONFIG.audio.masterVolume,
          now + EXPERIENCE_CONFIG.audio.toggleFadeSeconds,
        )
        applyMix()
        paintButton()
      } catch (error) {
        console.warn('[ambient-audio] playback unlock failed', error)
        enabled = false
        for (const track of tracks) track.element.pause()
        paintButton('Tippe erneut, um Naturklänge zu starten.')
      }
      return
    }

    enabled = false
    paintButton()
    const now = context.currentTime
    master.gain.cancelScheduledValues(now)
    master.gain.setValueAtTime(master.gain.value, now)
    master.gain.linearRampToValueAtTime(0, now + EXPERIENCE_CONFIG.audio.toggleFadeSeconds)
    pauseTimer = window.setTimeout(() => {
      for (const track of tracks) track.element.pause()
      void context?.suspend()
    }, EXPERIENCE_CONFIG.audio.toggleFadeSeconds * 1_000 + 80)
  }

  const onToggle = () => { void setEnabled(!enabled) }
  toggle.addEventListener('click', onToggle)
  paintButton()

  return {
    update(daylight, rainActive) {
      currentDaylight = daylight
      currentRainActive = rainActive
      if (enabled) applyMix()
    },
    dispose() {
      disposed = true
      window.clearTimeout(pauseTimer)
      toggle.removeEventListener('click', onToggle)
      for (const track of tracks) {
        track.element.pause()
        track.element.removeAttribute('src')
        track.element.load()
        track.gain?.disconnect()
      }
      master?.disconnect()
      void context?.close()
      context = null
      master = null
    },
  }
}
