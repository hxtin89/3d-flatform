<script lang="ts">
  import type { Snippet } from "svelte";
  import { createFrame, type Frame } from "./frame";
  import { dockElement, type Docked } from "./dock";

  interface Props {
    /** Frame at its resting margin (true, default) or fully retracted/full-bleed (false). No animation -- for an animated reveal, tween this from the caller and re-set it. */
    revealed?: boolean;
    /** Docked top-right, reaching into the window's own top-right corner (the concave-elbow notch). */
    weather?: Snippet;
    /** Docked bottom-center, flush against the window's bottom edge (sits fully inside the window -- no notch). */
    species?: Snippet;
    /** Docked to a side border -- left in portrait, right in landscape. */
    label?: Snippet;
    /** Renders behind the frame mask, filling the window area (e.g. the real scene/photo this frame is cut around). */
    background?: Snippet;
  }

  let { revealed = true, weather, species, label, background }: Props = $props();

  let container: HTMLDivElement;
  let weatherHost: HTMLDivElement;
  let speciesHost: HTMLDivElement;
  let labelHost: HTMLDivElement;

  let frame: Frame | undefined;
  let weatherDock: Docked | undefined;
  let speciesDock: Docked | undefined;
  let labelDock: Docked | undefined;

  function updateDocks() {
    weatherDock?.update();
    speciesDock?.update();
    labelDock?.update();
  }

  function layout() {
    if (!frame) return;
    container.style.setProperty("--screen-frame-content-scale", String(frame.getContentScale()));
    frame.setMargin(revealed ? frame.getTargetMargin() : 0);
    updateDocks();
  }

  // One-time setup -- deliberately does NOT read `revealed` synchronously, so
  // toggling it later re-runs only the effect below (a cheap re-layout), not
  // this one (which would tear down and rebuild the whole frame + docks).
  $effect(() => {
    frame = createFrame(container);
    weatherDock = dockElement(
      weatherHost,
      container,
      { edge: "top-right", mode: "frame", onRect: (rect) => frame!.setTopRightReach(rect.width, rect.height) },
      frame,
    );
    speciesDock = dockElement(
      speciesHost,
      container,
      { edge: "bottom-center", mode: "frame", onRect: (rect) => frame!.setNotch("species", rect) },
      frame,
    );
    labelDock = dockElement(
      labelHost,
      container,
      { edge: () => (container.clientHeight >= container.clientWidth ? "left-center" : "right-center"), mode: "frame", onRect: () => {} },
      frame,
    );

    const resizeObserver = new ResizeObserver(layout);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      frame?.dispose();
      frame = undefined;
    };
  });

  $effect(() => {
    revealed;
    layout();
  });
</script>

<div class="screen-frame" bind:this={container}>
  {#if background}
    <div class="screen-frame__background">{@render background()}</div>
  {/if}
  <div class="screen-frame__weather" bind:this={weatherHost}>
    {#if weather}{@render weather()}{/if}
  </div>
  <div class="screen-frame__species" bind:this={speciesHost}>
    {#if species}{@render species()}{/if}
  </div>
  <div class="screen-frame__label" bind:this={labelHost}>
    {#if label}{@render label()}{/if}
  </div>
</div>

<style>
  .screen-frame {
    position: relative;
    width: 100%;
    height: 100%;
    /* Falls back to the real viewport height when an ancestor's height
       collapses to 0 -- e.g. Storybook's viewport-addon iframe body has no
       explicit height even though the iframe itself is sized correctly.
       A real sized ancestor (the viewer's fixed/inset:0 container, or a
       future fixed-size wrapper) still wins whenever it's >= 100dvh. */
    min-height: 100dvh;
    overflow: hidden;
  }

  .screen-frame__background {
    position: absolute;
    inset: 0;
    z-index: 0;
  }
</style>
