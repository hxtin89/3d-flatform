<script lang="ts">
  import { silhouette, cornerOverflow, type Corners } from "./geometry/silhouette";

  interface Props {
    text: string;
    fontSize?: number;
    corners?: Corners;
    accent?: string;
    /** Corner radius in px — defaults to the label/pill token (30). */
    radius?: number;
    /** Called whenever this line's resolved (width, height) changes, so a parent stack can position the next line flush beneath it. */
    onResize?: (size: { width: number; height: number }) => void;
  }

  let {
    text,
    fontSize = 34,
    corners = ["convex", "convex", "convex", "convex"],
    accent = "default",
    radius = 30,
    onResize,
  }: Props = $props();

  const PADDING_X = 24;

  let textWidth = $state(0);
  const height = $derived(Math.ceil(fontSize * 1.2) + 12);
  const width = $derived(textWidth + PADDING_X * 2);
  const path = $derived(silhouette(width, height, corners, radius));
  const overflow = $derived(cornerOverflow(corners, radius));
  const svgWidth = $derived(width + overflow.left + overflow.right);
  const svgHeight = $derived(height + overflow.top + overflow.bottom);

  $effect(() => {
    onResize?.({ width, height });
  });
</script>

<div class="label-line" data-accent={accent} style:width="{width}px" style:height="{height}px">
  <svg
    class="label-line__silhouette"
    viewBox="{-overflow.left} {-overflow.top} {svgWidth} {svgHeight}"
    width={svgWidth}
    height={svgHeight}
    style:left="{-overflow.left}px"
    style:top="{-overflow.top}px"
    aria-hidden="true"
  >
    <path d={path} class="label-line__fill" />
  </svg>
  <span class="label-line__text" style:font-size="{fontSize}px" bind:clientWidth={textWidth}>{text}</span>
</div>

<style>
  .label-line {
    position: relative;
    display: inline-block;
  }

  .label-line__silhouette {
    position: absolute;
    z-index: 0;
    /* left/top set inline per-instance -- Concave/Fill-* corners reach past the box. */
    pointer-events: none;
  }

  .label-line__fill {
    fill: var(--label-fill);
  }

  /* Figma's real "PERUANISCHER"/"AUWALD" label pills (Frame 1 Desktop's
     composited render, not the isolated component thumbnail) sit on a dark
     forest-green fill and use white text -- --text-primary alone renders
     near-illegible dark-grey-on-dark-green. Same class of fix as
     SpeciesWidget's grey-dark override, using the semantic role built for
     exactly this (text-on-emphasis) rather than a raw gray literal. */
  .label-line[data-accent="forest-green"] .label-line__text {
    color: var(--text-on-emphasis);
  }

  .label-line__text {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    height: 100%;
    /* Must equal PADDING_X above (space-24) -- kept as a token here since it's a
       static CSS value; PADDING_X stays a plain number since it feeds JS width math. */
    padding: 0 var(--space-24);
    white-space: nowrap;
    font-family: var(--family-sans);
    font-weight: var(--weight-heading);
    color: var(--text-primary);
    box-sizing: border-box;
  }
</style>
