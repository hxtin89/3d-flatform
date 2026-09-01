<script lang="ts">
  import type { Snippet } from "svelte";
  import { createFrame, type Frame } from "./frame";
  import { dockElement, fitsPortraitArrangement, type Docked, type Rect } from "./dock";

  interface Props {
    /** Frame at its resting margin (true, default) or fully retracted/full-bleed (false). No animation -- for an animated reveal, tween this from the caller and re-set it. */
    revealed?: boolean;
    /** Docked top-right, reaching into the window's own top-right corner (the concave-elbow notch). */
    weather?: Snippet;
    /** Docked into the window's bottom-LEFT corner at every size, either stretched to span the window's full width (tall frames) or at Figma's own content scale (wide frames) -- see layout() for the crossover rule. Sits fully inside the window either way -- no notch. */
    species?: Snippet;
    /** Docked at the window's LEFT edge at every size, at Figma's mobile vertical placement (see LABEL_FIGMA_DROP_PX) -- clamped vertically when the species row or weather cluster would otherwise be in the way, never relocated to another corner. Still receives the side it's pinned to, which is now always "left": the parameter stays because callers write `{#snippet label(align)}<HabitatLabelStack {align} />{/snippet}` and HabitatLabelStack genuinely renders differently per side (its corner fillets are not symmetric -- see stackCorners there), so the plumbing is worth keeping even while only one value flows through it. */
    label?: Snippet<["left" | "right"]>;
    /** Renders behind the frame mask, filling the window area (e.g. the real scene/photo this frame is cut around). */
    background?: Snippet;
    /**
     * A whole Figma frame's worth of fixed-position composition, laid out at
     * literal Figma px and scaled to fit the window.
     *
     * This is the alternative to the three docks above, not an addition to them.
     * Docks exist for content whose position is a RELATIONSHIP -- the label
     * clamping clear of the species row, the weather cluster owning the notch.
     * Most of the storyboard frames have no such relationships: they are
     * compositions where everything sits at an authored coordinate. Giving those
     * a dock edge would be solving a problem they do not have, and would need a
     * new edge and a new avoid rule per screen.
     */
    stage?: Snippet;
    /** The Figma frame the `stage` snippet is authored against. Defaults to the 19.5:9 mobile frame. */
    stageSize?: { width: number; height: number };
    /** Fixed at the frame's own top-left corner, above the mask (Figma's real eagle mark sits at a fixed (51,30) px offset from that corner in BOTH Frame 1 and Frame 1 Desktop -- not proportional to frame width -- so it scales like every other fixed-px value, against getContentScale(). Figma's node metadata puts this at x=165, but its RENDERED raster puts the mark at x=51 -- exactly one logo-width (114px) to the left, consistently in both Frame 1 Mobile and Frame 1 Desktop. Measured off both exports: the visible bird spans x51-163, y30-98, i.e. the same 114x68 the metadata gives, just at a different origin. Following the metadata put our mark where the reference's mark ENDS. The raster is what the design looks like, so the raster wins.). */
    logo?: Snippet;
  }

  let {
    revealed = true,
    weather,
    species,
    label,
    background,
    logo,
    stage,
    stageSize = { width: 1080, height: 2340 },
  }: Props = $props();

  let container: HTMLDivElement;
  let weatherHost: HTMLDivElement;
  // $state, unlike the dock hosts above: those are unconditional and bound once,
  // these appear and disappear with the `stage` snippet as steps swap. Without
  // reactivity a swap would leave layoutStage() holding the previous node.
  let stageHost = $state<HTMLDivElement | undefined>(undefined);
  let stageInner = $state<HTMLDivElement | undefined>(undefined);
  let speciesHost: HTMLDivElement;
  let labelHost: HTMLDivElement;

  let frame: Frame | undefined;
  let weatherDock: Docked | undefined;
  let speciesDock: Docked | undefined;
  let labelDock: Docked | undefined;
  // Whether the species row is stretched to span the window's full width.
  // Read by the closures passed to dockElement below, and (re)decided by
  // layout() from real measured rects -- never from an aspect-ratio guess.
  let speciesFillsWidth = true;

  /**
   * How far BELOW the window's vertical centre the label stack's own centre
   * sits, in Figma px against the 1080-wide mobile frame -- scaled by the
   * frame's content scale like every other fixed Figma px here.
   *
   * Measured off Frame 1 Mobile: the window spans y 71..1860 inside the 1920
   * frame (centre 965.5) and the three pills span y 924..1145 (centre
   * 1034.5). 1034.5 - 965.5 = 69. The stack is NOT centred, and centring it
   * -- which is what "dock left-center" alone does -- floats it a full
   * pill-height above where the reference puts it.
   */
  const LABEL_FIGMA_DROP_PX = 69;

  // The two clusters the label must never overlap, in container-relative
  // coordinates, captured from the docks' own onRect as they update. Live
  // measured rects rather than derived sizes: the species row grows TALL
  // when a card expands and the weather cluster's height follows its
  // content, so anything computed from a nominal size would be wrong for
  // exactly the states where the collision actually happens.
  // Plain `let`, not $state: these are read only from the imperative
  // closures handed to dockElement below (never from the template or a
  // $derived), so making them reactive would buy re-renders nothing reads.
  let weatherRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  let speciesRect: Rect = { x: 0, y: 0, width: 0, height: 0 };

  /** Where the stack's centre wants to be before any collision clamping -- window centre plus the Figma drop. Shared by the dock's verticalDrop and by layout()'s stretch crossover so the two can't disagree about what "the label's position" means. */
  function labelDrop(): number {
    return LABEL_FIGMA_DROP_PX * (frame?.getContentScale() ?? 1);
  }

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
   * Picks between the two species-row treatments, in a fixed order so the
   * result is a pure function of the container's size (no dependence on the
   * previous pass, which could otherwise oscillate now that the row's own
   * height depends on which treatment won):
   *
   *   FILL  species spans the window's full width (Figma's Frame 1 Mobile,
   *         where the row is authored exactly as wide as the window).
   *   TALL  species at Figma's content scale in the window's bottom-left
   *         corner (Figma's Frame 1 Desktop).
   *
   * There used to be a third, WIDE, which additionally moved the label stack
   * to the window's bottom-right and flipped it to right-alignment. That is
   * gone: the label stack now uses the MOBILE placement in every
   * arrangement -- left edge of the window, Figma's mobile vertical drop --
   * and dockElement's `avoid` clamps it vertically rather than relocating
   * it. Two placements meant the stack jumped corners mid-resize and that
   * every downstream consumer had to handle both; one placement plus a
   * clamp is the same guarantee (never overlapping) with one position to
   * reason about. Product-owner decision, and the reason `labelAlign` and
   * `useWideArrangement` no longer exist here.
   *
   * Where the FILL -> TALL crossover lands is still measured, not guessed:
   * the row's height grows with its width (fixed 960x570 Figma aspect), so a
   * full-width row on a wide-ish frame reaches so far up the window that the
   * label no longer clears it. Asking fitsPortraitArrangement that exact
   * question -- with the row already rendered at its stretched size, and
   * with the label's real (dropped, not centred) position -- is the
   * crossover. Deriving it this way rather than from a hardcoded aspect
   * threshold keeps it honest if the row's content, or the label's, ever
   * changes size.
   *
   * Note this crossover is now an OPTIMISATION, not the overlap guarantee:
   * un-stretching the row buys the label back the room it needs on most
   * sizes, so the clamp stays a last resort for the genuinely cramped ones
   * and the stack sits exactly where Figma puts it everywhere else. The
   * guarantee itself lives in dockElement's `avoid`, which holds even if
   * this crossover picks wrong.
   *
   * The row is docked bottom-LEFT in both: when it fills, bottom-left and
   * bottom-center are the same position, so there's no need for the row to
   * ever be centred -- which is exactly the requirement here (fill the
   * width, or hug the window's bottom-left corner, never float in between).
   */
  function layout() {
    if (!frame) return;
    container.style.setProperty("--screen-frame-content-scale", String(frame.getContentScale()));
    // Ratio, not a scale: text sits inside hosts that are already scale()d by the
    // content scale, so multiplying its font-size by this lands it at the floored
    // size. 1 whenever the layout scale is already above the floor.
    container.style.setProperty(
      "--screen-frame-type-boost",
      String(frame.getTypeScale() / frame.getContentScale()),
    );
    frame.setMargin(revealed ? frame.getTargetMargin() : 0);
    layoutStage();

    speciesFillsWidth = true;
    updateDocks();
    if (!fitsPortraitArrangement(speciesHost, labelHost, container, container.clientHeight / 2 + labelDrop())) {
      speciesFillsWidth = false;
      updateDocks();
    }
    // A final pass so the label clamps against the rects the species row
    // ACTUALLY settled at, not the ones it had before the crossover ran.
    updateDocks();
  }

  /**
   * Fits the authored frame into the live window and centres it -- the
   * `object-fit: contain` rule, done by hand because the content is a scaled DOM
   * subtree rather than a replaced element.
   *
   * Two variables are re-declared ON the stage rather than inherited. The content
   * scale becomes 1: the stage's own transform already applies it, and anything
   * inside multiplying by it again would scale twice. The type boost is
   * recomputed against the STAGE's scale rather than the frame's, because the
   * window is inset by the margin and the two therefore differ -- using the
   * frame's would floor the text against the wrong number.
   */
  function layoutStage() {
    if (!frame || !stageHost || !stageInner) return;
    const margin = frame.getMargin();
    const windowWidth = Math.max(0, container.clientWidth - margin * 2);
    const windowHeight = Math.max(0, container.clientHeight - margin * 2);
    stageHost.style.left = `${margin}px`;
    stageHost.style.top = `${margin}px`;
    stageHost.style.width = `${windowWidth}px`;
    stageHost.style.height = `${windowHeight}px`;

    const scale = Math.min(windowWidth / stageSize.width, windowHeight / stageSize.height) || 0;
    const offsetX = (windowWidth - stageSize.width * scale) / 2;
    const offsetY = (windowHeight - stageSize.height * scale) / 2;
    stageInner.style.width = `${stageSize.width}px`;
    stageInner.style.height = `${stageSize.height}px`;
    stageInner.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    stageInner.style.setProperty("--screen-frame-content-scale", "1");
    stageInner.style.setProperty(
      "--screen-frame-type-boost",
      String(scale > 0 ? Math.max(1, frame.getTypeScale() / scale) : 1),
    );
  }

  // One-time setup -- deliberately does NOT read `revealed` synchronously, so
  // toggling it later re-runs only the effect below (a cheap re-layout), not
  // this one (which would tear down and rebuild the whole frame + docks).
  $effect(() => {
    frame = createFrame(container);
    weatherDock = dockElement(
      weatherHost,
      container,
      {
        edge: "top-right",
        mode: "frame",
        onRect: (rect) => {
          frame!.setTopRightReach(rect.width, rect.height);
          weatherRect = rect;
        },
      },
      frame,
    );
    // Always the window's bottom-left corner -- Figma's Frame 1 Desktop
    // position, and (once the row is stretched to fill) identical to Frame
    // 1 mobile's, where the row is exactly as wide as the window. See
    // layout() and speciesScale() above.
    speciesDock = dockElement(
      speciesHost,
      container,
      {
        edge: "bottom-left",
        mode: "frame",
        scale: speciesScale,
        onRect: (rect) => {
          frame!.setNotch("species", rect);
          speciesRect = rect;
        },
      },
      frame,
    );
    // One placement at every size: the window's left edge, at Figma's mobile
    // vertical drop, clamped clear of the other two clusters. Docked LAST of
    // the three on purpose -- `avoid` reads the rects weather and species
    // just reported through their own onRect, so it needs them to have
    // updated first (see updateDocks()).
    labelDock = dockElement(
      labelHost,
      container,
      {
        edge: "left-center",
        mode: "frame",
        verticalDrop: labelDrop,
        avoid: () => [weatherRect, speciesRect],
        onRect: () => {},
      },
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
  {#if stage}
    <div class="screen-frame__stage" bind:this={stageHost}>
      <div class="screen-frame__stage-inner" bind:this={stageInner}>{@render stage()}</div>
    </div>
  {/if}
  <div class="screen-frame__label" bind:this={labelHost}>
    <!-- Always "left": the stack uses the mobile placement in every
         arrangement now, so there is no right-docked case left to align to.
         See the `label` prop doc for why the parameter itself stays. -->
    {#if label}{@render label("left")}{/if}
  </div>
</div>

<style>
  .screen-frame {
    position: relative;
    width: 100%;
    height: 100%;
    /* Isolates a stacking context for everything this component paints.
       Without it, `position: relative` with no z-index of its own leaves the
       root at z-index:auto, so the internal layers' explicit z-indexes (40
       for frame.ts's mask svg, 45 for the logo below, 50 for the docked
       hosts) do NOT stay scoped to this subtree -- they compete directly
       against the caller's own siblings in the shared outer context, and a
       positive explicit z-index beats a plain auto sibling regardless of DOM
       order. That is a real, observed bug, not a theoretical one:
       MediaScreenExample's media card sits partly in the frame's margin
       band, and the pixel at (30,900) inside it rendered as the margin's
       (220,220,220) grey -- our own mask svg painting over the caller's
       content -- until that file defensively gave every one of its overlays
       z-index:50 to climb back above 45. `isolation: isolate` is the fix at
       the source: it costs nothing, needs no z-index on the root (which
       would drag the frame into the caller's own paint order in a different
       way), and leaves the internal 40/45/50 ordering untouched relative to
       each other, since they now simply resolve inside this context instead
       of the page's root one. */
    isolation: isolate;
    /* No min-height fallback: every real caller already gives this a real
       height to fill -- ScreenExample's fixed-px wrapper (Storybook) and the
       viewer's position:fixed/inset:0 container (see storyboard/index.ts)
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

  /* Clipped to the window: an authored frame is drawn edge to edge, and without
     this a composition that bleeds past its own bounds would paint over the grey
     margin the mask just cut. */
  .screen-frame__stage {
    position: absolute;
    overflow: hidden;
    pointer-events: none;
    z-index: 44;
  }

  .screen-frame__stage-inner {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: top left;
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
