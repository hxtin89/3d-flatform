<script lang="ts">
  import type { Snippet } from "svelte";
  import { silhouette, cornerOverflow, type Corners } from "./geometry/silhouette";

  interface Props {
    width: number;
    height: number;
    corners: Corners;
    /** Corner radius -- feeds both the silhouette path and its overflow (Concave/Fill-* corners reach past the w x h box) from the single value below, so the two can no longer disagree. Defaults to the card/outer token (60). */
    radius?: number;
    /** Omit (with no icon either) to hide the header row entirely -- the real Bento Widget master supports this too (used for small cells where a bare Value/Description reads fine on its own, e.g. a temperature cell). */
    title?: string;
    /** Omit to hide the value row entirely (e.g. species cards with no number). */
    value?: string;
    description?: string;
    icon?: Snippet;
    expandedContent?: Snippet;
    expanded?: boolean;
    hasImage?: boolean;
    imageSrc?: string;
    state?: "default" | "selected";
    /** Sets data-accent — corner/background colors resolve via the accent-fill/label-fill CSS custom properties. */
    accent?: string;
    /** Set false when the parent BentoGrid draws the whole cluster as one liquid field (geometry/liquid-field.ts) -- this widget then contributes only its content layer, and the shape comes from the shared field instead. */
    silhouette?: boolean;
  }

  let {
    width,
    height,
    corners,
    radius = 60,
    title,
    value,
    description,
    icon,
    expandedContent,
    expanded = false,
    hasImage = false,
    imageSrc,
    state = "default",
    accent = "default",
    silhouette: showSilhouette = true,
  }: Props = $props();

  const clipId = `bento-clip-${Math.random().toString(36).slice(2, 9)}`;
  // Light-from-top-left/shadow-at-bottom-right sheen, layered over the flat
  // accent fill on every card regardless of accent -- the polish gap vs.
  // colabs.com.au/alethia.earth wasn't a wrong color (grey-light/grey-dark/
  // gold/forest-green are all real Figma bindings, see widget-accent.css),
  // it's that a single solid fill reads as a scoreboard color block with no
  // material quality. This is pure alpha-over-color compositing (white highlight,
  // black shadow, both translucent) so it sits correctly on top of ANY accent
  // without needing a per-accent gradient recipe.
  const sheenId = `bento-sheen-${Math.random().toString(36).slice(2, 9)}`;
  // Derived from the same (width, height, corners, radius) the caller passes
  // in, rather than taking a `path` prop computed externally -- a separate
  // `path` prop and a separate `radius` prop that "must match" it (see the
  // old radius doc comment) is an invariant nothing enforced; computing path
  // here from the props that actually determine it makes disagreement
  // impossible instead of documented-against.
  const path = $derived(silhouette(width, height, corners, radius));
  const overflow = $derived(cornerOverflow(corners, radius));
  const svgWidth = $derived(width + overflow.left + overflow.right);
  const svgHeight = $derived(height + overflow.top + overflow.bottom);
</script>

<div
  class="bento-widget"
  data-accent={accent}
  data-state={state}
  data-corners={corners.join(",")}
  style:width="{width}px"
  style:height="{height}px"
>
  {#if showSilhouette}
  <svg
    class="bento-widget__silhouette"
    viewBox="{-overflow.left} {-overflow.top} {svgWidth} {svgHeight}"
    width={svgWidth}
    height={svgHeight}
    style:left="{-overflow.left}px"
    style:top="{-overflow.top}px"
    aria-hidden="true"
  >
    <defs>
      <clipPath id={clipId}>
        <path d={path} />
      </clipPath>
      <linearGradient id={sheenId} x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stop-color="rgb(255 255 255 / 0.16)" />
        <stop offset="40%" stop-color="rgb(255 255 255 / 0)" />
        <stop offset="100%" stop-color="rgb(0 0 0 / 0.12)" />
      </linearGradient>
    </defs>
    {#if hasImage && imageSrc}
      <image href={imageSrc} width={width} height={height} preserveAspectRatio="xMidYMid slice" clip-path="url(#{clipId})" />
      <path d={path} class="bento-widget__scrim" />
    {:else}
      <path d={path} class="bento-widget__fill" />
    {/if}
    <path d={path} fill="url(#{sheenId})" class="bento-widget__sheen" />
  </svg>
  {/if}

  <div class="bento-widget__content">
    {#if title}<h3 class="bento-widget__title">{title}</h3>{/if}
    {#if value}<p class="bento-widget__value">{value}</p>{/if}
    {#if description}<p class="bento-widget__description">{description}</p>{/if}
    <!-- Figma's real WeatherBar cell (25556:1159/1160, Frame 1 Desktop) puts
         its icon PAIR below both text lines, not beside the title -- the
         icon slot used to render inline in a header row next to the title,
         which is the only reason this cell read as cramped (tiny icons
         squeezed left of the text) next to the reference sites' generous
         spacing. This is the one BentoWidget instance that uses `icon` at
         all (SpeciesWidget's icon plate is a separate component/layout), so
         moving it here doesn't disturb any other card. -->
    {#if icon}<span class="bento-widget__icon-row">{@render icon()}</span>{/if}
    {#if expanded && expandedContent}
      <div class="bento-widget__expanded">{@render expandedContent()}</div>
    {/if}
  </div>
</div>

<style>
  .bento-widget {
    position: relative;
    isolation: isolate;
  }

  .bento-widget__silhouette {
    position: absolute;
    z-index: 0;
    /* left/top set inline per-instance -- Concave/Fill-* corners reach past the box. */
    pointer-events: none;
  }

  .bento-widget__fill {
    fill: var(--accent-fill);
    /* Hover/focus feedback is a COLOR shift only -- no transform lift, no
       drop-shadow. Figma's own frames have neither: the cards are flat fills
       that butt directly against each other, and any lift/shadow breaks the
       illusion that adjacent cards are one continuous docked surface (a
       shadow falls across the neighbour it's supposed to be flush with).
       color-mix off the card's OWN --accent-fill keeps this one rule correct
       for every accent (grey/gold/forest-green) instead of a per-accent
       literal. */
    transition: fill 180ms ease;
  }

  .bento-widget:hover .bento-widget__fill,
  .bento-widget:focus-within .bento-widget__fill {
    fill: color-mix(in srgb, var(--accent-fill) 86%, white);
  }

  @media (prefers-reduced-motion: reduce) {
    .bento-widget__fill {
      transition: none;
    }
  }

  .bento-widget__scrim {
    fill: rgb(0 0 0 / 0.35);
  }

  .bento-widget__sheen {
    pointer-events: none;
    /* Plain alpha-over-color (the old approach) scales in *absolute* RGB
       units, so the same 16%-white/12%-black stops that read as an obvious
       lit-surface gradient on grey/dark-green (low luminance -- lots of
       headroom to lighten/darken) go almost invisible on gold (#e6ce00,
       already near-max luminance -- adding ~40/255 of white barely moves a
       channel already at 230/255). `overlay` blends relative to the base
       pixel's OWN luminance instead of adding a fixed absolute amount, so it
       reads as a consistent sheen strength across every accent -- including
       the one accent this card system didn't have when that scheme was
       written. */
    mix-blend-mode: overlay;
  }

  .bento-widget__content {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: var(--stack-xs);
    padding: var(--inset-md);
    height: 100%;
    box-sizing: border-box;
    color: var(--text-primary);
  }

  .bento-widget[data-state="selected"] .bento-widget__fill {
    fill: var(--border-focus);
  }

  /* Same illegibility bug already fixed for LabelLine's forest-green pill and
     SpeciesWidget's grey-dark card: --text-primary (gray-900) stays a near-black
     default that's too dark over these accent-fills. Figma's real "83%" weather
     cell (forest-green), "Leicht bewölkt" WeatherBar cell (grey-light, #ababab --
     lighter than grey-dark's #737373 but still not light enough for gray-900
     text), "29°"/"Celsius" (gold, #e6ce00 -- missing from this selector
     entirely until now, so it silently fell through to the dark default) and
     any grey-dark BentoWidget instance all render white text -- reach for
     --text-on-emphasis, not a raw literal.

     --text-secondary here used to read var(--gray-300) -- a guess, not a
     verified value (gray-300 on grey-light's #ababab fill is a ~1.25:1
     contrast ratio, nearly invisible, which is exactly the "Nordwest Wind"/
     "pipra fasciicauda" bug this was supposed to have already fixed).
     get_variable_defs on the real Figma text nodes settles it: "Nordwest
     Wind" (25556:970, grey-light) binds text/inverse, "Celsius" (25556:969)
     binds text/inverse, "Luftfeuchtigkeit" (25556:974, forest-green) binds
     text/onEmphasis -- Figma uses full white for secondary/description text
     on every one of these accent fills too, not a dimmed gray. Same token as
     --text-primary above, not a new one. */
  .bento-widget[data-accent="forest-green"],
  .bento-widget[data-accent="grey-light"],
  .bento-widget[data-accent="grey-dark"],
  .bento-widget[data-accent="gold"] {
    --text-primary: var(--text-on-emphasis);
    --text-secondary: var(--text-on-emphasis);
  }

  /* Sits below title+description (see the markup comment above) -- the flex
     column's own --stack-xs gap already gives it the right breathing room
     above, matching Figma's ~10px text-to-icon gap. */
  .bento-widget__icon-row {
    display: block;
  }

  .bento-widget__title {
    /* Figma's real bound style ("Heading/MD", verified via get_variable_defs on the
       live text nodes): Sora SemiBold 24, not the Bold-heading-sm this used to read. */
    font: var(--text-heading-md);
    margin: 0;
  }

  .bento-widget__value {
    /* Figma: "Display/2XL", Sora Bold 60/40 -- already matched size-heading-2xl before,
       now expressed via the bundled style like the other roles. tabular-nums is a
       rendering feature of the same bound font/size, not a new type style, so it
       doesn't need Figma verification -- it just stops "29°"/"83%" from having the
       slightly-off digit widths a proportional numeral set gives a scoreboard-style
       standalone number.
       font-family is the one piece of Display/2XL this deliberately does NOT keep --
       `value` on BentoWidget is only ever these two weather readouts (recreation-content.ts),
       never a heading, so swapping just the family to --family-mono (weight/size/line-height
       still come from the bundled Sora style above) gives them the tight "instrument
       reading" character alethia.earth's "-8.3 tCO2E" has instead of the same bold Sora
       every heading on the screen already uses. */
    font: var(--text-display-2xl);
    font-family: var(--family-mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
    margin: 0;
  }

  .bento-widget__description {
    color: var(--text-secondary);
    font: var(--text-body);
    /* `font` can't carry letter-spacing -- see --text-body-tracking's own comment. */
    letter-spacing: var(--text-body-tracking);
    margin: 0;
  }

  /* Weather cluster's description doubles as the whole cell's only other line
     of text (no separate label role in Figma) -- restyled as a small tracked
     caption sitting under the value, closer to how alethia.earth's macro-photo
     overlays caption a reading, instead of reading as a second full-size body
     line competing with the number above it. Scoped to cells that actually
     pair a bare `value` with a `description` (the weather cluster's own
     pattern) so title+description widgets elsewhere keep the plain body line. */
  .bento-widget__value + .bento-widget__description {
    font: var(--weight-emphasis) var(--size-caption) / var(--line-height-caption) var(--family-sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.85;
  }
</style>
