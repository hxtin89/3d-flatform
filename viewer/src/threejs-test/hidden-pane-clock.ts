// Test hook, off unless the URL carries `?bgclock`: drive requestAnimationFrame and the timers
// from a MessageChannel instead of the display clock.
//
// A hidden or background tab — an editor's browser pane that is collapsed, an automated
// capture — gets no animation frames and heavily throttled timers, so the app never boots,
// streams or renders there. Patching the clock from the console after load is not enough:
// whatever already waits on a native frame (the render loop, the tile queues) waits for ever.
// This module is main.ts's first import, so it swaps the clock before any of that exists.
//
// Frames are paced to 60 Hz but not tied to a display: frame times and fps readouts mean
// nothing under it, GPU timestamps still do. A hidden page also never presents, so nothing
// holds the CPU back the way a full swap chain does: the app queued frames faster than the
// GPU finished them, and every readback (the noise editor's density slices) waited seconds
// behind the backlog. So on WebGPU a frame also waits until the GPU has finished the work
// submitted before the previous one — two frames in flight, as with a real swap chain.
if (new URLSearchParams(location.search).has('bgclock')) {
  const FRAME_MS = 1000 / 60
  let submitted = 0
  let finished = 0
  /** Submissions made before the latest frame began. */
  let frameMark = 0
  // No WebGPU types in this project; the queue is patched untyped.
  const queue = (globalThis as any).GPUQueue
  if (queue) {
    const submit = queue.prototype.submit
    queue.prototype.submit = function (this: any, commandBuffers: unknown) {
      submit.call(this, commandBuffers)
      const id = ++submitted
      const done = () => { finished = Math.max(finished, id) }
      this.onSubmittedWorkDone().then(done, done)
    }
  }
  const frames = new MessageChannel()
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  let framePosted = false
  let lastFrameAt = -Infinity
  frames.port1.onmessage = () => {
    const now = performance.now()
    // Everything before the previous frame must be done: that frame and this one in flight.
    if (now - lastFrameAt < FRAME_MS || finished < frameMark) { frames.port2.postMessage(0); return }
    lastFrameAt = now
    frameMark = submitted
    framePosted = false
    const due = [...callbacks.values()]
    callbacks.clear()
    for (const callback of due) {
      try { callback(now) } catch (error) { console.error(error) }
    }
  }
  window.requestAnimationFrame = (callback) => {
    const id = ++nextFrame
    callbacks.set(id, callback)
    if (!framePosted) { framePosted = true; frames.port2.postMessage(0) }
    return id
  }
  window.cancelAnimationFrame = (id) => { callbacks.delete(id) }

  const ticks = new MessageChannel()
  const timers = new Map<number, { run: () => void; at: number; every: number }>()
  let nextTimer = 1e6
  let tickPosted = false
  const post = () => { if (!tickPosted && timers.size) { tickPosted = true; ticks.port2.postMessage(0) } }
  ticks.port1.onmessage = () => {
    tickPosted = false
    const now = performance.now()
    for (const [id, timer] of [...timers]) {
      // Cleared by a callback earlier in this tick: a cleared timer never runs.
      if (timers.get(id) !== timer || now < timer.at) continue
      if (timer.every > 0) timer.at = now + timer.every
      else timers.delete(id)
      try { timer.run() } catch (error) { console.error(error) }
    }
    post()
  }
  const nativeClearTimeout = window.clearTimeout.bind(window)
  const nativeClearInterval = window.clearInterval.bind(window)
  const schedule = (handler: TimerHandler, ms: number, every: boolean, args: unknown[]) => {
    const run = typeof handler === 'function' ? () => (handler as (...a: unknown[]) => void)(...args) : () => { (0, eval)(String(handler)) }
    const id = nextTimer++
    timers.set(id, { run, at: performance.now() + (ms || 0), every: every ? Math.max(ms || 0, 4) : 0 })
    post()
    return id
  }
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => schedule(handler, ms ?? 0, false, args)) as typeof window.setTimeout
  window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => schedule(handler, ms ?? 0, true, args)) as typeof window.setInterval
  window.clearTimeout = (id?: number) => { if (id !== undefined && !timers.delete(id)) nativeClearTimeout(id) }
  window.clearInterval = (id?: number) => { if (id !== undefined && !timers.delete(id)) nativeClearInterval(id) }
  window.requestIdleCallback = ((callback: IdleRequestCallback) =>
    schedule(() => callback({ didTimeout: false, timeRemaining: () => 8 }), 1, false, [])) as typeof window.requestIdleCallback
  console.info('[bgclock] frames and timers run from a MessageChannel — frame times are not display times')
}

export {}
