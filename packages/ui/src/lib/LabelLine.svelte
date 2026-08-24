<script lang="ts">
  import { silhouette, cornerOverflow, type Corners } from "./geometry/silhouette";

  interface Props {
    text: string;
    fontSize?: number;
    /** Sora font weight. Defaults to --weight-heading (700/Bold) -- Figma's real "PERUANISCHER"/"AUWALD"
        headline lines (get_design_context on 25556:1237/1238) both bind Sora Bold. The eyebrow line
        above them ("Dein Habitat", 25556:1236) is the one exception: Sora Light (300) -- a raw literal,
        not a token, since the weight scale's real Figma variables (weight/extralight=200 through
        weight/bold=700, tokens-raw.json) have no 300 stop to alias. Every LabelLine call site used to
        hardcode --weight-heading unconditionally, so the eyebrow rendered at the same bold weight as the
        headline beneath it -- the one-weight-throughout gap: two lines of genuinely different Figma
        weights collapsed to one because this prop didn't exist yet. */
    fontWeight?: number | string;
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
    fontWeight = "var(--weight-heading)",
    corners = ["convex", "convex", "convex", "convex"],
    accent = "default",
    radius = 30,
    onResize,
  }: Props = $props();

  const PADDING_X = 24;

  // Same highlight/shadow sheen as BentoWidget/SpeciesWidget (see BentoWidget's
  // own comment for the full rationale) -- before this, the label stack was
  // the one surface in the whole composition that stayed a flat, un-lit fill
  // while every widget around it got this material pass, which is exactly
  // backwards for the piece that's supposed to read as the screen's hero
  // headline rather than just another flat card.
  const sheenId = `label-sheen-${Math.random().toString(36).slice(2, 9)}`;
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
    <defs>
      <linearGradient id={sheenId} x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stop-color="rgb(255 255 255 / 0.16)" />
        <stop offset="40%" stop-color="rgb(255 255 255 / 0)" />
        <stop offset="100%" stop-color="rgb(0 0 0 / 0.12)" />
      </linearGradient>
    </defs>
    <path d={path} class="label-line__fill" />
    <path d={path} fill="url(#{sheenId})" class="label-line__sheen" />
  </svg>
  <span class="label-line__text" style:font-size="{fontSize}px" style:font-weight={fontWeight} bind:clientWidth={textWidth}>{text}</span>
</div>

<style>
  .label-line {
    position: relative;
    display: inline-block;
    /* A slow, independent float -- distinct from BentoWidget's click/hover
       lift and the icon-plate's fast breathe -- so the headline stack reads
       as its own depth plane drifting above the backdrop, not a flat sticker
       sitting at the same static depth as the small weather/species readouts
       around it. Alternate (not a full loop back to 0) so it settles at
       rest on both ends instead of snapping. */
    animation: label-line-float 9s ease-in-out infinite alternate;
  }

  @keyframes label-line-float {
    from {
      transform: translateY(0);
    }
    to {
      transform: translateY(-5px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .label-line {
      animation: none;
    }
  }

  .label-line__silhouette {
    position: absolute;
    z-index: 0;
    /* left/top set inline per-instance -- Concave/Fill-* corners reach past the box. */
    pointer-events: none;
    /* Same drop-shadow-hugs-the-silhouette approach as BentoWidget/SpeciesWidget,
       always on (not hover-gated) since this pill isn't interactive -- it's
       what actually separates the headline from the photo behind it instead
       of just being a flat color shape with text on it. */
    filter: drop-shadow(0 10px 18px var(--shadow-key)) drop-shadow(0 2px 4px var(--shadow-ambient));
  }

  .label-line__fill {
    fill: var(--label-fill);
  }

  .label-line__sheen {
    pointer-events: none;
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
    color: var(--text-primary);
    box-sizing: border-box;
  }
</style>
