interface Queue {
  autoUpdate: boolean
  maxJobs: number
  currJobs: number
  items: unknown[]
  tryRunJobs(): void
}

/** Admit work once per frame rather than allowing promise completions to drain
 * queues during a drag. This bounds admissions, not an individual tile's parse. */
export function createStreamingBudget(queues: Queue[], clock = () => performance.now()) {
  const original = queues.map(queue => ({ autoUpdate: queue.autoUpdate, maxJobs: queue.maxJobs }))
  for (const queue of queues) { queue.autoUpdate = false; queue.maxJobs = 0 }
  let nextQueue = 0
  let lastAdmission = -Infinity
  return {
    pump(now: number, moving: boolean, frameMs: number) {
      const interval = moving ? 100 : 16
      if (now - lastAdmission < interval) return
      // A long frame postpones work, but never starves detail indefinitely.
      if (frameMs > 20 && now - lastAdmission < 250) return
      const started = clock()
      for (let i = 0; i < queues.length; i++) {
        const queue = queues[nextQueue]
        nextQueue = (nextQueue + 1) % queues.length
        if (queue.currJobs || !queue.items.length) continue
        queue.maxJobs = 1
        try { queue.tryRunJobs() } finally { queue.maxJobs = 0 }
        lastAdmission = now
        if (moving || clock() - started >= 2) break
      }
    },
    dispose() { queues.forEach((queue, i) => Object.assign(queue, original[i])) },
  }
}
