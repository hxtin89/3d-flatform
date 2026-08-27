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
    /** Corner radius in px — defaults to the label/pill token (30). */
    radius?: number;
    /** Called whenever this line's resolved (width, height) changes, so a parent stack can position the next line flush beneath it. */
    onResize?: (size: { width: number; height: number }) => void;
    /** Set false when a parent (HabitatLabelStack) renders several LabelLines flush together as one
        merged silhouette -- a per-line drop-shadow there would throw a seam-shadow across the
        neighboring line and read as separate floating chips instead of one continuous blob (see
        HabitatLabelStack's own comment). Defaults true so a standalone LabelLine (Storybook) still
        gets its own shadow. */
    shadow?: boolean;
  }

  let {
    text,
    fontSize = 34,
    fontWeight = "var(--weight-heading)",
    corners = ["convex", "convex", "convex", "convex"],
    radius = 30,
    onResize,
    shadow = true,
  }: Props = $props();

  // Same highlight/shadow sheen as BentoWidget/SpeciesWidget (see BentoWidget's
  // own comment for the full rationale) -- before this, the label stack was
  // the one surface in the whole composition that stayed a flat, un-lit fill
  // while every widget around it got this material pass, which is exactly
  // backwards for the piece that's supposed to read as the screen's hero
  // headline rather than just another flat card.
  const sheenId = `label-sheen-${Math.random().toString(36).slice(2, 9)}`;
  // bind:clientWidth reads the SPAN's own box, and that span already carries
  // `padding: 0 var(--space-24)` (see the CSS comment below) -- clientWidth is
  // content + padding by definition, box-sizing notwithstanding, so textWidth
  // arrives pre-padded on both sides. Adding PADDING_X * 2 again here used to
  // double it: every pill rendered 48px (2 * space-24) wider than Figma's,
  // a constant offset regardless of text length -- confirmed against the
  // Figma mobile export by measuring the flat, corner-overflow-free plateau
  // of "PERUANISCHER"'s and "AUWALD"'s right edges (both have a plain convex
  // corner there, so no Fill-corner bulge could be inflating the read): ours
  // 654/435 vs Figma's 606/389, a 48/46px gap on two words of very different
  // length -- a per-character font-metrics mismatch would scale with length,
  // a flat padding double-count would not, and it didn't.
  let textWidth = $state(0);
  const height = $derived(Math.ceil(fontSize * 1.2) + 12);
  const width = $derived(textWidth);
  const path = $derived(silhouette(width, height, corners, radius));
  const overflow = $derived(cornerOverflow(corners, radius));
  const svgWidth = $derived(width + overflow.left + overflow.right);
  const svgHeight = $derived(height + overflow.top + overflow.bottom);

  $effect(() => {
    onResize?.({ width, height });
  });
</script>

<div class="label-line" style:width="{width}px" style:height="{height}px">
  <svg
    class="label-line__silhouette"
    data-shadow={shadow}
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

  .label-line__sheen {
    pointer-events: none;
  }

  .label-line__text {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    height: 100%;
    /* The only place the horizontal inset is authored now -- `width` above reads it
       straight back via bind:clientWidth instead of re-adding it in JS (see that
       comment for why a second copy of this number used to double-pad every pill). */
    padding: 0 var(--space-24);
    white-space: nowrap;
    font-family: var(--family-sans);
    color: var(--text-primary);
    box-sizing: border-box;
  }
</style>
