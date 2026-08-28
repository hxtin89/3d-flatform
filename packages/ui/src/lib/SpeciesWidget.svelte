<script lang="ts">
  import type { Snippet } from "svelte";
  import { silhouette, cornerOverflow, type Corners } from "./geometry/silhouette";
  import DetailInfo from "./DetailInfo.svelte";

  interface Props {
    width: number;
    height: number;
    corners: Corners;
    /** Corner radius -- feeds both the silhouette path and its overflow (Concave/Fill-* corners reach past the w x h box) from the single value below, so the two can no longer disagree. Defaults to the card/outer token (60). */
    radius?: number;
    /** Common name, e.g. "SCHNURRVOGEL". */
    title?: string;
    /** Latin name, e.g. "pipra fasciicauda". */
    description?: string;
    /** Selected: additionally shows the measurement/status/caption facts above the visual -- reproduces Figma's real "SIRA GIFTFROSCH" (selected) vs. "SCHNURRVOGEL"/"BLAUER MORPHOFALTER" (not) distinction (Frame 1 Desktop). Does NOT gate `image` vs `icon` -- see their own doc comments below. */
    selected?: boolean;
    /** e.g. "15-17mm" — selected only. */
    measurement?: string;
    /** e.g. "Schutzstatus: am Wenigsten bedroht" — selected only. */
    status?: string;
    /** e.g. "Nur die männlichen Frösche kümmern sich um den Nachwuchs" — selected only. */
    caption?: string;
    /** Generic line-art fallback icon — shown only when `image` is absent (regardless of `selected`). */
    icon?: Snippet;
    /** Real species photo/illustration — shown whenever present (regardless of `selected`), takes priority over `icon`. */
    image?: Snippet;
    /** Sets data-accent — background color resolves via the accent-fill CSS custom property, same token set BentoWidget uses. */
    accent?: string;
    /** Makes the whole card a click target that calls `onSelect` (toggling this species' selected state) — the caller (BentoGrid) owns exclusivity and the expand/collapse animation. */
    selectable?: boolean;
    onSelect?: () => void;
    /** Set false when the parent BentoGrid draws the whole cluster as one liquid field (geometry/liquid-field.ts) -- this widget then contributes only its content layer, and the shape comes from the shared field instead. */
    silhouette?: boolean;
  }

  let { width, height, corners, radius = 60, title, description, selected = false, measurement, status, caption, icon, image, accent = "default", selectable = false, onSelect, silhouette: showSilhouette = true }: Props = $props();

  // Same highlight/shadow sheen as BentoWidget (see its own comment) -- the
  // two non-selected species cards (Vogel/Morphofalter) share the identical
  // grey-light Figma accent, so without it they render as twin flat blocks
  // with no material depth at all.
  const sheenId = `species-sheen-${Math.random().toString(36).slice(2, 9)}`;
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

  // Single source of truth for "does the facts block actually render", so the
  // {#if} below cannot disagree with anything else that asks the same question.
  const hasFacts = $derived(selected && !!(measurement || status || caption));

  // Drives the same "pressed" look for mouse and keyboard. Plain :active
  // covers a mouse click, but a div with role="button" doesn't get :active
  // from Enter/Space the way a real <button> does -- without this, keyboard
  // activation would skip the press feedback the task asked to confirm is
  // shared between the two input paths.
  let pressed = $state(false);
  function press() {
    pressed = true;
  }
  function release() {
    pressed = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    // Holding the key down repeats keydown without a keyup in between --
    // without this guard, selection would toggle on/off on every repeat.
    if (e.repeat) return;
    pressed = true;
    onSelect?.();
  }

  function handleKeyup(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") pressed = false;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- role/tabindex are only ever set together, when selectable is true; the linter can't see that correlation across the ternaries. -->
<div
  class="species-widget"
  data-accent={accent}
  data-selected={selected}
  data-selectable={selectable}
  data-pressed={pressed}
  style:width="{width}px"
  style:height="{height}px"
  role={selectable ? "button" : undefined}
  tabindex={selectable ? 0 : undefined}
  onclick={selectable ? onSelect : undefined}
  onkeydown={selectable ? handleKeydown : undefined}
  onkeyup={selectable ? handleKeyup : undefined}
  onpointerdown={selectable ? press : undefined}
  onpointerup={selectable ? release : undefined}
  onpointerleave={selectable ? release : undefined}
  onpointercancel={selectable ? release : undefined}
>
  {#if showSilhouette}
  <svg
    class="species-widget__silhouette"
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
    <path d={path} class="species-widget__fill" />
    <path d={path} fill="url(#{sheenId})" class="species-widget__sheen" />
  </svg>
  {/if}

  <div class="species-widget__content">
    {#if title || description}
      <header class="species-widget__header">
        {#if title}<h3 class="species-widget__title">{title}</h3>{/if}
        {#if description}<p class="species-widget__description">{description}</p>{/if}
      </header>
    {/if}

    {#if hasFacts}
      <DetailInfo {measurement} {status} {caption} />
    {/if}

    <div class="species-widget__visual">
      {#if image}
        <!-- Shown whenever a real asset exists, regardless of `selected` --
             gating this on `selected` was the actual bug behind the species
             row's material mismatch: Vogel/Morphofalter now carry a real
             `image` (see species-icons.ts) same as Giftfrosch, and it must
             render in their normal (unselected) state too, not just when
             expanded. -->
        {@render image()}
      {:else if icon}
        <!-- Fallback for a species with no real asset at all (currently
             just Giftfrosch's own collapsed state -- Figma's static file
             never shows it collapsed, see recreation-content.ts). A tinted
             circular plate behind the line-art icon, not the bare stroke
             floating on the card fill, reads far less like generic
             dropped-in clip-art than an outline with nothing around it. -->
        <span class="species-widget__icon-plate">{@render icon()}</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .species-widget {
    position: relative;
    isolation: isolate;
  }

  .species-widget__silhouette {
    position: absolute;
    z-index: 0;
    /* left/top set inline per-instance -- Concave/Fill-* corners reach past the box. */
    pointer-events: none;
  }

  .species-widget__fill {
    fill: var(--accent-fill);
    /* Hover/press feedback is a COLOR shift only -- no transform lift, no
       drop-shadow. See BentoWidget's identical rule for why: Figma's cards
       butt flush against each other, so a lift or shadow visibly breaks the
       docked seam it's supposed to be continuous across. Press goes a step
       further than hover in the same direction, so the two read as one
       gesture deepening rather than two unrelated effects. */
    transition: fill 180ms ease;
  }

  .species-widget:hover .species-widget__fill,
  .species-widget:focus-visible .species-widget__fill {
    fill: color-mix(in srgb, var(--accent-fill) 86%, white);
  }

  /* After the hover rule so it wins at equal specificity when both apply, and
     deliberately quicker -- a press should register as close to instant. */
  .species-widget[data-pressed="true"] .species-widget__fill {
    fill: color-mix(in srgb, var(--accent-fill) 74%, white);
    transition: fill 90ms ease;
  }

  @media (prefers-reduced-motion: reduce) {
    .species-widget__fill {
      transition: none;
    }
  }

  .species-widget__sheen {
    pointer-events: none;
  }

  /* --text-secondary (gray-700) happens to equal grey-dark's own accent-fill
     value -- description/fact text would otherwise be invisible (same color
     as its own background). Figma's real widgets bind dark-fill text to a
     dedicated "text/onEmphasis" role for exactly this reason. grey-light was
     missing from this selector entirely (BLAUER MORPHOFALTER/SCHNURRVOGEL's
     "morpho deidamia"/"pipra fasciicauda" fell through to the unoverridden
     default, gray-700-on-gray-500, ~2:1 contrast) -- get_variable_defs on
     the real Figma text nodes (25556:970 "Nordwest Wind", grey-light) shows
     it binds text/inverse, same full-white role as grey-dark's facts text,
     not a dimmed secondary. So there IS a "secondary on emphasis" answer --
     it's just --text-on-emphasis itself, not a separate gray-300 literal. */
  .species-widget[data-accent="grey-dark"],
  .species-widget[data-accent="grey-light"] {
    --text-primary: var(--text-on-emphasis);
    --text-secondary: var(--text-on-emphasis);
  }

  .species-widget__content {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    /* Figma's real padding here (measured off the SIRA GIFTFROSCH/SCHNURRVOGEL
       text-node offsets from their own widget bounds) is ~24-33px, notably
       more than BentoWidget's --inset-md (12px) -- --inset-xl is the closest
       existing semantic token to that measured range. */
    gap: var(--stack-xs);
    padding: var(--inset-xl);
    height: 100%;
    box-sizing: border-box;
    color: var(--text-primary);
  }

  .species-widget__header {
    display: flex;
    flex-direction: column;
    gap: var(--stack-xs);
  }

  .species-widget__title {
    font: var(--text-heading-md);
    margin: 0;
  }

  /* Figma leaves description-level text unbound to any named style, which is
     why this used to just reuse --text-body (typography-styles.css's own
     header comment admits as much: "not a guessed Figma binding"). Measuring
     the actual reference render says that guess was wrong: a pixel-width
     comparison (tools/review/measure.mjs) against .gauntlet/ref/mobile-selected.png
     put this line's rendered width at ~66% of the same string in the reference (147px
     vs 223px for "ranitomeya sirensis") while the title directly above it
     matched the reference within 1% -- so the gap is specific to this rule,
     not a capture-scale mismatch. 16/24 is 66.7%, i.e. the reference is
     rendering this at --size-heading-md's 24px, just at body weight instead
     of the title's bold -- confirmed against the DetailInfo fact rows sitting
     right next to it in the same reference card ("Schutzstatus:"), which are
     visibly smaller still, so "the info-block body text" Figma matches this
     to is that 24px scale, not --text-body's 16px. No composed token for
     size-24-at-body-weight exists yet in @wi/tokens, so this builds one from
     the same primitives typography-styles.css itself composes --text-heading-md
     from, rather than hardcoding 24px past the token layer. */
  .species-widget__description {
    color: var(--text-secondary);
    font: var(--weight-body) var(--size-heading-md) / var(--line-height-body) var(--family-sans);
    /* `font` can't carry letter-spacing -- see --text-body-tracking's own comment. */
    letter-spacing: var(--text-body-tracking);
    margin: 0;
  }

  .species-widget[data-selectable="true"] {
    cursor: pointer;
  }

  .species-widget__visual {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    /* A few px of bottom bleed independent of the overlay/stacked split below
       -- Figma's own bird/butterfly art nodes ("band-tailed_manakin 3" et al,
       Frame 1 Desktop) sit close enough to their card's bottom edge to get
       clipped by a few px, not centered inside the full --inset-xl margin on
       every side. Only the bottom edge shaves down to --inset-lg; left/right/
       top keep the full inset-xl, which is the margin this component's own
       padding comment says it needs to clear the blob silhouette's concave
       corners -- bottom is the one edge safe to give back. */
    margin-bottom: calc(var(--inset-lg) - var(--inset-xl));
  }

  /* Figma sizes the collapsed bird/butterfly illustration to the full padded
     card, independent of how many lines the title wraps to: get_variable_defs
     on "band-tailed_manakin 3" (one-line "SCHNURRVOGEL") and "Blauer
     Morphofalter" (two-line "BLAUER MORPHOFALTER") shows both art nodes
     starting within a few px of their card's own top edge -- the art sits
     BEHIND the title rather than being pushed down by it. A flex sibling that
     only gets whatever the header leaves over reproduces that well enough for
     a one-line title (measured ~79% of the reference render) but starves a
     two-line one, which eats a whole extra title row nothing gives back
     (measured ~44%). Positioning the visual layer to fill the content box
     -- still inset by the very padding above, so it never reaches past the
     safe zone that padding exists to protect -- and painting it behind the
     header via a negative z-index (the stacking spec always paints ordinary
     static content above a negative-z-index positioned sibling in the same
     stacking context, e.g. .species-widget__content's own z-index:1) makes
     its size independent of the header's line count instead.
     Keyed on `image` specifically, and only when there's no facts block:
     Giftfrosch's own selected card, per the same node data, keeps its info
     panel and photo genuinely stacked (the photo's top offset there tracks
     the panel's real height, not zero) -- overlaying that case risks a long
     caption line visually colliding with the photo it would now sit in front
     of, so facts-bearing cards keep the ordinary flex-sibling layout above.
     The top edge still reserves roughly one title line's worth of space
     (padding + --size-heading-md + the header's own internal gap) rather
     than going all the way to inset:0 -- get_variable_defs backs this up
     too: "band-tailed_manakin 3"'s own top offset is 69px into a 300px card
     (title-sized, not zero), it's only the SECOND line a two-line title
     wraps to that Figma lets the art run behind. Reserving a fixed one-line
     budget keeps that same real gap above a single-line title (SCHNURRVOGEL)
     while still not shrinking any further for a two-line one (BLAUER
     MORPHOFALTER) -- which is the actual bug this rule exists to fix. */
  /* NO overlay. An earlier pass positioned the illustration absolutely and painted
     it BEHIND the header via a negative z-index, on the theory that Figma lets the
     art run behind a title's second line. Cropping the real Morphofalter card out
     of the reference export settles it: the butterfly sits entirely BELOW both the
     two-line title and the subtitle, touching neither. Overlaying it put a wing
     straight through "morpho deidamia".

     So the art stays an ordinary flex sibling that cannot collide with the header.
     Its size is still short of the reference for a two-line title -- the box it
     inherits is height-limited, and a roughly square source asset then contains to
     that height rather than to the card's width. That is a real remaining gap, and
     a smaller one than illegible type. */


  .species-widget__icon-plate {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: var(--inset-lg);
    border-radius: var(--pill);
    /* Flat tinted disc, no drop-shadow or embossing inset -- shadows are out
       across this component set (see the fill rule above). */
    background: rgb(0 0 0 / 0.12);
  }
</style>
