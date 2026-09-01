<script lang="ts">
  import {
    ScreenFrame,
    HabitatLabelStack,
    BentoGrid,
    Subtitle,
    WEATHER_CLUSTER,
    SPECIES_ROW,
    EAGLE_LOGO_SVG,
  } from "@wi/ui";
  import { STEPS, type Step } from "./steps";

  interface Props {
    /** Frame at its resting margin, or retracted to full bleed. */
    revealed?: boolean;
    /** Fired whenever the beat changes, including on mount. The caller flies the camera. */
    onStep?: (step: Step) => void;
    /** Consulted before advancing. False while a flight is in the air -- see next(). */
    canAdvance?: () => boolean;
  }
  let { revealed = false, onStep, canAdvance }: Props = $props();

  let index = $state(0);
  const step = $derived(STEPS[index]);

  // Fires on mount too, so the opening beat gets its pose without a special case.
  $effect(() => {
    onStep?.(STEPS[index]);
  });

  // Exported so the imperative caller in main.ts can drive this without a store.
  // Svelte 5 surfaces these on the object mount() returns.
  export function next() {
    // A flight has no queue: starting a second one abandons the first, whose
    // progress then never reaches 1. Anything waiting on that landing would wait
    // forever, so a beat cannot be skipped while the camera is still moving.
    if (canAdvance && !canAdvance()) return;
    index = (index + 1) % STEPS.length;
  }
  export function previous() {
    if (canAdvance && !canAdvance()) return;
    index = (index - 1 + STEPS.length) % STEPS.length;
  }
  export function goTo(id: string) {
    const i = STEPS.findIndex((s) => s.id === id);
    if (i >= 0) index = i;
  }
  export function current() {
    return step;
  }
  export function setRevealed(value: boolean) {
    revealed = value;
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "ArrowRight") next();
    else if (event.key === "ArrowLeft") previous();
  }

  // Swipe, on the window rather than on our own container: the container is
  // pointer-events:none so the camera stays draggable, which means touches never
  // reach us. Listening passively lets the gesture through to the canvas as well.
  //
  // The thresholds exist to tell a story swipe from a camera orbit, which is the
  // same gesture on the same surface. A deliberate flick is horizontal-dominant,
  // travels a real distance and is over quickly; an orbit drag wanders and
  // lingers. Anything that fails one of the three is left to the camera alone.
  const SWIPE_MIN_PX = 60;
  const SWIPE_MAX_MS = 600;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartAt = 0;

  function onTouchStart(event: TouchEvent) {
    if (event.touches.length !== 1) return;
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
    touchStartAt = event.timeStamp;
  }

  function onTouchEnd(event: TouchEvent) {
    if (!touchStartAt || event.changedTouches.length !== 1) return;
    const dx = event.changedTouches[0].clientX - touchStartX;
    const dy = event.changedTouches[0].clientY - touchStartY;
    const elapsed = event.timeStamp - touchStartAt;
    touchStartAt = 0;
    if (elapsed > SWIPE_MAX_MS) return;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 2) return;
    if (dx < 0) next();
    else previous();
  }
</script>

<svelte:window
  on:keydown={onKey}
  on:touchstart={onTouchStart}
  on:touchend={onTouchEnd}
/>

<!--
  ONE ScreenFrame for the whole session, never remounted. Two reasons, both
  load-bearing: its margin animation runs from 0 on mount, so remounting per step
  would flash the grey border on every advance; and its docks report their rects
  through onRect as they mount, so a fresh instance mid-sequence measures
  half-built, zero-width boxes -- the exact failure that used to drop the label
  stack on top of the species row.

  Only the snippets change. A step that passes no weather/species/label renders
  the frame alone, which is what the nine camera-only beats need.
-->
<ScreenFrame
  {revealed}
  weather={step.content === "habitat" ? weather : undefined}
  species={step.content === "habitat" ? species : undefined}
  label={step.content === "habitat" ? label : undefined}
  logo={eagle}
/>

{#if step.content === "text" && step.caption}
  <div class="storyboard__caption">
    <Subtitle text={step.caption} maxWidth={1010} />
  </div>
{/if}

<div class="storyboard__controls">
  <button type="button" onclick={previous} aria-label="Vorheriger Schritt">‹</button>
  <span>{index + 1}/{STEPS.length} · {step.id}</span>
  <button type="button" onclick={next} aria-label="Nächster Schritt">›</button>
</div>

{#snippet weather()}
  <BentoGrid items={WEATHER_CLUSTER} />
{/snippet}

{#snippet species()}
  <BentoGrid items={SPECIES_ROW} />
{/snippet}

{#snippet label(align: "left" | "right")}
  <HabitatLabelStack {align} />
{/snippet}

{#snippet eagle()}
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- our own constant, not user input -->
  {@html EAGLE_LOGO_SVG}
{/snippet}

<style>
  /* The caption layer sits over the frame, docked to the window's lower half the
     way Figma's Frame 11 places it. Not a ScreenFrame dock: that frame authors it
     as a fixed composition with no collision relationships, and a dock edge would
     be solving a problem this screen does not have. */
  .storyboard__caption {
    position: absolute;
    left: calc(60px * var(--screen-frame-content-scale, 1));
    bottom: calc(320px * var(--screen-frame-content-scale, 1));
    pointer-events: none;
  }

  /* Placeholder chrome. A visible control rather than tap-anywhere, because
     tap-anywhere fights the camera: a drag ends in a click, so orbiting the scene
     would advance the story. */
  .storyboard__controls {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 60;
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    font: 500 12px/1 var(--family-sans, sans-serif);
    pointer-events: auto;
  }

  .storyboard__controls button {
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 50%;
    background: rgb(255 255 255 / 0.15);
    color: inherit;
    font-size: 15px;
    cursor: pointer;
  }

  .storyboard__controls button:hover {
    background: rgb(255 255 255 / 0.3);
  }
</style>
