<script lang="ts">
  import type { Snippet } from "svelte";
  import { cornerOverflow, type Corners } from "./geometry/silhouette";

  interface Props {
    /** SVG path `d` for this widget's silhouette, computed externally (silhouette.ts) — this component never computes geometry itself. */
    path: string;
    width: number;
    height: number;
    corners: Corners;
    /** Radius used when `path` was built — must match the value passed to silhouette() so Concave/Fill-* overflow is sized correctly. Defaults to the card/outer token (60). */
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
  }

  let {
    path,
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
  }: Props = $props();

  const clipId = `bento-clip-${Math.random().toString(36).slice(2, 9)}`;
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
    </defs>
    {#if hasImage && imageSrc}
      <image href={imageSrc} width={width} height={height} preserveAspectRatio="xMidYMid slice" clip-path="url(#{clipId})" />
      <path d={path} class="bento-widget__scrim" />
    {:else}
      <path d={path} class="bento-widget__fill" />
    {/if}
  </svg>

  <div class="bento-widget__content">
    {#if title || icon}
      <header class="bento-widget__header">
        {#if icon}<span class="bento-widget__icon">{@render icon()}</span>{/if}
        {#if title}<h3 class="bento-widget__title">{title}</h3>{/if}
      </header>
    {/if}
    {#if value}<p class="bento-widget__value">{value}</p>{/if}
    {#if description}<p class="bento-widget__description">{description}</p>{/if}
    {#if expanded && expandedContent}
      <div class="bento-widget__expanded">{@render expandedContent()}</div>
    {/if}
  </div>
</div>

<style>
  .bento-widget {
    position: relative;
    isolation: isolate;
    /* Hover/focus lift -- transform lives here (not on the silhouette) so the
       content layer moves with the card instead of just its fill. */
    transition: transform 220ms ease;
  }

  .bento-widget:hover,
  .bento-widget:focus-within {
    transform: translateY(-6px);
  }

  .bento-widget__silhouette {
    position: absolute;
    z-index: 0;
    /* left/top set inline per-instance -- Concave/Fill-* corners reach past the box. */
    pointer-events: none;
    /* drop-shadow (not box-shadow) so the shadow hugs the card's actual
       silhouette -- these corners are concave/notched, not a plain rect. */
    transition: filter 220ms ease;
  }

  .bento-widget:hover .bento-widget__silhouette,
  .bento-widget:focus-within .bento-widget__silhouette {
    filter: drop-shadow(0 14px 24px var(--shadow-key)) drop-shadow(0 2px 4px var(--shadow-ambient));
  }

  @media (prefers-reduced-motion: reduce) {
    .bento-widget,
    .bento-widget__silhouette {
      transition: none;
    }
    .bento-widget:hover,
    .bento-widget:focus-within {
      transform: none;
    }
  }

  .bento-widget__fill {
    fill: var(--accent-fill);
  }

  .bento-widget__scrim {
    fill: rgb(0 0 0 / 0.35);
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

  .bento-widget__header {
    display: flex;
    align-items: center;
    gap: var(--inline-xs);
  }

  .bento-widget__title {
    /* Figma's real bound style ("Heading/MD", verified via get_variable_defs on the
       live text nodes): Sora SemiBold 24, not the Bold-heading-sm this used to read. */
    font: var(--text-heading-md);
    margin: 0;
  }

  .bento-widget__value {
    /* Figma: "Display/2XL", Sora Bold 60/40 -- already matched size-heading-2xl before,
       now expressed via the bundled style like the other roles. */
    font: var(--text-display-2xl);
    margin: 0;
  }

  .bento-widget__description {
    color: var(--text-secondary);
    font: var(--text-body);
    /* `font` can't carry letter-spacing -- see --text-body-tracking's own comment. */
    letter-spacing: var(--text-body-tracking);
    margin: 0;
  }
</style>
