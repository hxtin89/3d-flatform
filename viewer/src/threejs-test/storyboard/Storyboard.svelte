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
  import { STEPS } from "./steps";

  interface Props {
    /** Frame at its resting margin, or retracted to full bleed. */
    revealed?: boolean;
  }
  let { revealed = false }: Props = $props();

  let index = $state(0);
  const step = $derived(STEPS[index]);

  // Exported so the imperative caller in main.ts can drive this without a store.
  // Svelte 5 surfaces these on the object mount() returns.
  export function next() {
    index = (index + 1) % STEPS.length;
  }
  export function previous() {
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
</script>

<svelte:window on:keydown={onKey} />

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
