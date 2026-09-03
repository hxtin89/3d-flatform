// Keyframe tracks and a scrubbable clock for the cinematic intro.
//
// Pure arithmetic, no three.js: a track is a list of {t, v} keyframes in ms,
// each carrying the ease used to arrive at it from the previous one. Values
// hold before the first and after the last keyframe, so a track only has to
// describe the part of the story where its parameter moves. Seeking is
// stateless — evaluate(t) gives the same answer no matter how it was reached,
// which is what makes the ?scrub=1 slider trustworthy.
export type EaseName = 'linear' | 'smootherstep' | 'easeInOutCubic' | 'easeOutExpo' | 'easeInOutSine' | 'easeOutCubic'

export interface Keyframe {
  /** Timeline position, ms. */
  t: number
  v: number
  /** Ease from the previous keyframe into this one. Default smootherstep. */
  ease?: EaseName
}

export type Track = readonly Keyframe[]

const EASES: Record<EaseName, (x: number) => number> = {
  linear: (x) => x,
  smootherstep: (x) => x * x * x * (x * (x * 6 - 15) + 10),
  easeInOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  easeOutCubic: (x) => 1 - Math.pow(1 - x, 3),
  easeOutExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  easeInOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
}

export function ease(name: EaseName | undefined, x: number): number {
  const clamped = x <= 0 ? 0 : x >= 1 ? 1 : x
  return EASES[name ?? 'smootherstep'](clamped)
}

export function evaluateTrack(track: Track, timeMs: number): number {
  if (track.length === 0) return 0
  if (timeMs <= track[0].t) return track[0].v
  const last = track[track.length - 1]
  if (timeMs >= last.t) return last.v
  let index = 1
  while (track[index].t < timeMs) index += 1
  const from = track[index - 1]
  const to = track[index]
  const span = to.t - from.t
  const x = span <= 0 ? 1 : (timeMs - from.t) / span
  return from.v + (to.v - from.v) * ease(to.ease, x)
}

export function trackEnd(track: Track): number {
  return track.length ? track[track.length - 1].t : 0
}

export interface TimelineOptions {
  durationMs: number
  /** Once past `to`, time wraps back by (to − from) — a seamless orbit loop
   * when the tracks inside the window end where they start. */
  loop?: { from: number; to: number } | null
  /** Playback rate; reduced motion runs the story several times faster. */
  rate?: number
}

export interface Timeline {
  readonly timeMs: number
  readonly playing: boolean
  readonly durationMs: number
  play(): void
  pause(): void
  seek(timeMs: number): void
  /** Advance by the wall-clock delta since the last tick. */
  tick(now: number): number
}

export function createTimeline(options: TimelineOptions): Timeline {
  const { durationMs } = options
  const loop = options.loop ?? null
  const rate = options.rate ?? 1
  let timeMs = 0
  let playing = false
  let lastTick = -Infinity

  return {
    get timeMs() { return timeMs },
    get playing() { return playing },
    durationMs,
    play() { playing = true; lastTick = -Infinity },
    pause() { playing = false },
    seek(next) { timeMs = Math.max(0, Math.min(durationMs, next)) },
    tick(now) {
      if (!playing) return timeMs
      const elapsed = lastTick === -Infinity ? 0 : Math.min(100, Math.max(0, now - lastTick))
      lastTick = now
      timeMs += elapsed * rate
      if (loop && timeMs > loop.to) timeMs -= loop.to - loop.from
      if (timeMs >= durationMs) { timeMs = durationMs; playing = false }
      return timeMs
    },
  }
}
