<script lang="ts">
  import type { Snippet } from "svelte";
  import { createFrame, type Frame } from "./frame";
  import { dockElement, fitsPortraitArrangement, type Docked } from "./dock";

  interface Props {
    /** Frame at its resting margin (true, default) or fully retracted/full-bleed (false). No animation -- for an animated reveal, tween this from the caller and re-set it. */
    revealed?: boolean;
    /** Docked top-right, reaching into the window's own top-right corner (the concave-elbow notch). */
    weather?: Snippet;
    /** Docked into the window's bottom-LEFT corner at every size, either stretched to span the window's full width (tall frames) or at Figma's own content scale (wide frames) -- see layout() for the crossover rule. Sits fully inside the window either way -- no notch. */
    species?: Snippet;
    /** Docked left-center (tall-frame arrangement) or bottom-right (wide-frame arrangement) -- matches Figma exactly (verified against Frame 1/Frame 1 Desktop). See species' doc above for how the two are chosen. Receives which side it's pinned to, so a multi-line label stack can align itself to match (left-align vs right-align). */
    label?: Snippet<["left" | "right"]>;
    /** Renders behind the frame mask, filling the window area (e.g. the real scene/photo this frame is cut around). */
    background?: Snippet;
    /** Fixed at the frame's own top-left corner, above the mask (Figma's real eagle mark sits at a fixed (51,30) px offset from that corner in BOTH Frame 1 and Frame 1 Desktop -- not proportional to frame width -- so it scales like every other fixed-px value, against getContentScale(). Figma's node metadata puts this at x=165, but its RENDERED raster puts the mark at x=51 -- exactly one logo-width (114px) to the left, consistently in both Frame 1 Mobile and Frame 1 Desktop. Measured off both exports: the visible bird spans x51-163, y30-98, i.e. the same 114x68 the metadata gives, just at a different origin. Following the metadata put our mark where the reference's mark ENDS. The raster is what the design looks like, so the raster wins.). */
    logo?: Snippet;
  }

  let { revealed = true, weather, species, label, background, logo }: Props = $props();

  let container: HTMLDivElement;
  let weatherHost: HTMLDivElement;
  let speciesHost: HTMLDivElement;
  let labelHost: HTMLDivElement;

  let frame: Frame | undefined;
  let weatherDock: Docked | undefined;
  let speciesDock: Docked | undefined;
  let labelDock: Docked | undefined;
  let labelAlign: "left" | "right" = $state("left");
  // Whether the label drops to the wide-frame corner (bottom-right) instead
  // of left-center, and whether the species row is stretched to span the
  // window's full width. Both are read by the closures passed to
  // dockElement below, and both are (re)decided by layout() from real
  // measured rects -- never from an aspect-ratio guess.
  let useWideArrangement = false;
  let speciesFillsWidth = true;

  /**
   * The species row's own scale factor, deliberately NOT the shared
   * --screen-frame-content-scale every other docked cluster uses.
   *
   * Figma authors the row exactly as wide as the mobile frame's window
   * (960px inside 1080 - 2x60 margin = 960), i.e. as a band that spans the
   * window, not as a fixed-size cluster that happens to be centred. Scaling
   * it by the shared content scale reproduces that only while the frame's
   * WIDTH is the binding dimension; as soon as the height binds instead
   * (any aspect between ~1.2:1 and ~1.78:1, plus every near-square size)
   * the window keeps getting wider while the row does not, and the row ends
   * up floating bottom-centre with a symmetric gap on each side -- measured
   * at 47px/side at 600x900, 97px at 700x900, 197px at 900x900.
   *
   * So: stretch the row to the window's live width instead (`natural` is
   * the row's untransformed layout width, so this stays correct for any
   * species content, and the live margin keeps it flush while the frame
   * reveals/retracts).
   */
  function speciesScale(): number {
    if (!frame) return 1;
    const natural = speciesHost.offsetWidth;
    if (!speciesFillsWidth || natural <= 0) return frame.getContentScale();
    return (container.clientWidth - 2 * frame.getMargin()) / natural;
  }

  function updateDocks() {
    weatherDock?.update();
    speciesDock?.update();
    labelDock?.update();
  }

  /**
   * Picks between the three arrangements, in a fixed order so the result is
   * a pure function of the container's size (no dependence on the previous
   * pass, which could otherwise oscillate now that the row's own height
   * depends on which arrangement won):
   *
   *   FILL  species spans the window's full width, label left-centre.
   *   TALL  species at Figma's content scale in the window's bottom-left
   *         corner, label still left-centre.
   *   WIDE  species at content scale bottom-left, label bottom-right --
   *         Figma's own Frame 1 Desktop arrangement.
   *
   * Where the FILL -> TALL crossover lands is measured, not guessed: the
   * row's height grows with its width (fixed 960x570 Figma aspect), so a
   * full-width row on a wide-ish frame reaches so far up the window that
   * the left-centre label no longer clears it. Asking
   * fitsPortraitArrangement that exact question -- with the row already
   * rendered at its stretched size -- is the crossover. It works out at
   * ~1.32:1 (h:w) for the current content, i.e. the row stretches to at
   * most ~1.39x the shared content scale before giving up and snapping back
   * to Figma's own scale; anything wider than that would read as an
   * oversized species row shouting over a normal-sized weather cluster.
   * Deriving it this way (rather than a hardcoded aspect threshold) keeps
   * it honest if the row's content, or the label's, ever changes size.
   *
   * The row is docked bottom-LEFT in all three: when it fills, bottom-left
   * and bottom-center are the same position, so there's no need for the row
   * to ever be centred -- which is exactly the requirement here (fill the
   * width, or hug the window's bottom-left corner, never float in between).
   */
  function layout() {
    if (!frame) return;
    container.style.setProperty("--screen-frame-content-scale", String(frame.getContentScale()));
    frame.setMargin(revealed ? frame.getTargetMargin() : 0);

    speciesFillsWidth = true;
    useWideArrangement = false;
    updateDocks();
    if (!fitsPortraitArrangement(speciesHost, labelHost, container)) {
      speciesFillsWidth = false;
      updateDocks();
      useWideArrangement = !fitsPortraitArrangement(speciesHost, labelHost, container);
    }
    labelAlign = useWideArrangement ? "right" : "left";
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
    // Always the window's bottom-left corner -- Figma's Frame 1 Desktop
    // position, and (once the row is stretched to fill) identical to Frame
    // 1 mobile's, where the row is exactly as wide as the window. See
    // layout() and speciesScale() above.
    speciesDock = dockElement(
      speciesHost,
      container,
      { edge: "bottom-left", mode: "frame", scale: speciesScale, onRect: (rect) => frame!.setNotch("species", rect) },
      frame,
    );
    // Tall-frame arrangement: left-center. Wide-frame: bottom-right, sitting
    // low next to the species cluster -- NOT right-center. Verified against
    // Frame 1 / Frame 1 Desktop's real instance x/y.
    labelDock = dockElement(
      labelHost,
      container,
      { edge: () => (useWideArrangement ? "bottom-right" : "left-center"), mode: "frame", onRect: () => {} },
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
  {#if logo}
    <div class="screen-frame__logo">{@render logo()}</div>
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
    /* No min-height fallback: every real caller already gives this a real
       height to fill -- ScreenExample's fixed-px wrapper (Storybook) and the
       viewer's position:fixed/inset:0 container (see design-system-demo.ts)
       both do. A `min-height: 100dvh` here used to stomp on both of those
       whenever the actual browser viewport was taller than the intended
       size (e.g. every fixed-size Storybook story shorter than the
       window) -- it forced the frame's own math (margin, notch reach,
       portrait/landscape pick) to run against the wrong height, which is
       what caused the top-right weather cluster to blow through the frame
       margin instead of docking inside it. */
    overflow: hidden;
  }

  .screen-frame__background {
    position: absolute;
    inset: 0;
    z-index: 0;
  }

  .screen-frame__logo {
    position: absolute;
    /* Fixed Figma px, scaled by the same --screen-frame-content-scale every
       other fixed-size value (fonts, dock host transforms) scales against --
       see the `logo` prop doc above for why this is a literal offset instead
       of a dockElement() edge anchor. */
    top: calc(30px * var(--screen-frame-content-scale, 1));
    left: calc(51px * var(--screen-frame-content-scale, 1));
    transform-origin: top left;
    transform: scale(var(--screen-frame-content-scale, 1));
    z-index: 45;
    pointer-events: none;
  }
</style>
