// Mounts the storyboard shell over the point-cloud canvas.
//
// Same shape as the createDesignSystemDemo() it replaces, so main.ts's wiring is
// unchanged apart from the constructor name -- but the frame and docking now come
// from ScreenFrame.svelte instead of a second, hand-copied implementation of its
// layout(). That duplication was already a maintenance hazard with one caller;
// with a screen per storyboard beat it would have been untenable.
import { mount, unmount } from 'svelte'
import Storyboard from './Storyboard.svelte'
import type { Step } from './steps'
import '@wi/tokens/css'

export interface StoryboardOptions {
  /** Fired when the beat changes, including on mount. Fly the camera here. */
  onStep?(step: Step): void
  /** Return false to refuse an advance -- used to block while a flight is airborne. */
  canAdvance?(): boolean
}

export interface StoryboardHandle {
  /** Animates the frame in to its resting margin. */
  reveal(durationMs?: number): Promise<void>
  /** Animates the frame back to full bleed. */
  retract(durationMs?: number): Promise<void>
  next(): void
  previous(): void
  goTo(id: string): void
  current(): Step
  dispose(): void
}

export function createStoryboard(options: StoryboardOptions = {}): StoryboardHandle {
  const container = document.createElement('div')
  // Full-viewport and ON TOP of the point-cloud canvas, so it must not be a hit
  // target: without this the div swallows every pointer event and the camera
  // cannot be panned anywhere, even over open cloud. The bento cells and the
  // step controls re-enable hit-testing for themselves, so the clickable area
  // stays their real footprint rather than this container's bounding box.
  Object.assign(container.style, { position: 'fixed', inset: '0', pointerEvents: 'none' })
  document.body.append(container)

  const app = mount(Storyboard, {
    target: container,
    props: { revealed: false, onStep: options.onStep, canAdvance: options.canAdvance },
  }) as unknown as {
    next(): void
    previous(): void
    goTo(id: string): void
    current(): Step
    setRevealed(value: boolean): void
  }

  // ScreenFrame takes `revealed` as a plain boolean and animates on change, so
  // the promise here resolves when the frame's own tween would have finished.
  // Kept promise-shaped because main.ts awaits it around the loader hand-off.
  const settle = (durationMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, durationMs)))

  return {
    async reveal(durationMs = 620) {
      app.setRevealed(true)
      await settle(durationMs)
    },
    async retract(durationMs = 620) {
      app.setRevealed(false)
      await settle(durationMs)
    },
    next: () => app.next(),
    previous: () => app.previous(),
    goTo: (id: string) => app.goTo(id),
    current: () => app.current(),
    dispose() {
      void unmount(app as never)
      container.remove()
    },
  }
}
