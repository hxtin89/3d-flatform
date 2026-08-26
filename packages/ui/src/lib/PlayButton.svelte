<script lang="ts">
  interface Props {
    /** Disc diameter in px. Figma's real "Play Button" component is 103x103 --
        the glyph geometry below is authored against that box and expressed as
        an SVG viewBox, so it re-scales for free at any other size instead of
        needing its own offset math per size. */
    size?: number;
    /** Sets data-accent -- resolves --accent-fill the same way every other
        widget in this library does (widget-accent.css). Figma's real button
        sits on gold. */
    accent?: string;
    onClick?: () => void;
    /** aria-label -- this is a bare icon button, so the accessible name has
        to come from here rather than visible text. */
    label?: string;
  }

  let { size = 103, accent = "gold", onClick, label = "Play" }: Props = $props();

  // Glyph is a triangle in a 73x73 box, sitting inside the 103x103 disc at
  // (19, 15) -- NOT the (15, 15) a naive "center a 73 box in a 103 box" gives.
  // That 4px rightward push is the real Figma component's own placement, not
  // a bug: a triangle's visual weight sits left of its bounding-box center
  // (the apex is a point, the base is a flat edge), so a truly bbox-centered
  // triangle *reads* as shifted left. Figma's designer already corrected for
  // that once -- reproducing their x=19 keeps the optical centering, "fixing"
  // it back to x=15 would just re-introduce the lean.
  const GLYPH_LEFT = 19;
  const GLYPH_TOP = 15;
  const GLYPH_SIZE = 73;
  const glyphPath = `M${GLYPH_LEFT},${GLYPH_TOP} L${GLYPH_LEFT},${GLYPH_TOP + GLYPH_SIZE} L${GLYPH_LEFT + GLYPH_SIZE},${GLYPH_TOP + GLYPH_SIZE / 2} Z`;
</script>

<button
  type="button"
  class="play-button"
  data-accent={accent}
  style:width="{size}px"
  style:height="{size}px"
  aria-label={label}
  onclick={onClick}
>
  <svg viewBox="0 0 103 103" width={size} height={size} aria-hidden="true">
    <path d={glyphPath} class="play-button__glyph" />
  </svg>
</button>

<style>
  .play-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: var(--pill);
    cursor: pointer;
    /* 50% alpha over --accent-fill, whatever accent resolves it to (a raw
       rgb() literal for blue/green/coral/purple, a var() alias for the
       Figma-verified accents) -- color-mix reads the fill's *computed*
       color at paint time, so one rule works for every accent instead of a
       per-accent translucent literal. This is the same disc-over-image
       button Figma's reference shows: the artwork behind the control has to
       read through it, a solid fill would black it out. */
    background: color-mix(in srgb, var(--accent-fill) 50%, transparent);
    transition: background 180ms ease;
  }

  .play-button:hover {
    background: color-mix(in srgb, var(--accent-fill) 65%, transparent);
  }

  .play-button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .play-button {
      transition: none;
    }
  }

  .play-button__glyph {
    fill: var(--text-primary);
  }
</style>
