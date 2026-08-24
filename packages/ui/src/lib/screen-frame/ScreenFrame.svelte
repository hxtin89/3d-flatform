<script lang="ts">
  import type { Snippet } from "svelte";
  import { createFrame, type Frame } from "./frame";
  import { dockElement, type Docked } from "./dock";

  interface Props {
    /** Frame at its resting margin (true, default) or fully retracted/full-bleed (false). No animation -- for an animated reveal, tween this from the caller and re-set it. */
    revealed?: boolean;
    /** Docked top-right, reaching into the window's own top-right corner (the concave-elbow notch). */
    weather?: Snippet;
    /** Docked bottom-center in portrait (flush against the window's bottom edge), bottom-left in landscape -- matches Figma's Frame 1/Frame 1 Desktop exactly (verified against both). Sits fully inside the window either way -- no notch. */
    species?: Snippet;
    /** Docked left-center in portrait, bottom-right in landscape -- matches Figma exactly (verified against Frame 1/Frame 1 Desktop). Receives which side it's pinned to, so a multi-line label stack can align itself to match (left-align vs right-align). */
    label?: Snippet<["left" | "right"]>;
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
  let labelAlign: "left" | "right" = $state("left");

  function updateDocks() {
    weatherDock?.update();
    speciesDock?.update();
    labelDock?.update();
  }

  function layout() {
    if (!frame) return;
    container.style.setProperty("--screen-frame-content-scale", String(frame.getContentScale()));
    frame.setMargin(revealed ? frame.getTargetMargin() : 0);
    labelAlign = container.clientHeight >= container.clientWidth ? "left" : "right";
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
    // Portrait (Frame 1): bottom-center. Landscape (Frame 1 Desktop): bottom-left --
    // NOT the same bottom-center dock scaled up. Confirmed by reading the real
    // Giftfrosch/Vogel/Morphofalter instance x/y in both frames directly from Figma.
    speciesDock = dockElement(
      speciesHost,
      container,
      { edge: () => (container.clientHeight >= container.clientWidth ? "bottom-center" : "bottom-left"), mode: "frame", onRect: (rect) => frame!.setNotch("species", rect) },
      frame,
    );
    // Portrait: left-center. Landscape: bottom-right, sitting low next to the
    // species cluster -- NOT right-center. Same source as the species note above.
    labelDock = dockElement(
      labelHost,
      container,
      { edge: () => (container.clientHeight >= container.clientWidth ? "left-center" : "bottom-right"), mode: "frame", onRect: () => {} },
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
    {#if label}{@render label(labelAlign)}{/if}
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
