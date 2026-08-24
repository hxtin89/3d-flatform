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
  }

  let { path, width, height, corners, radius = 60, title, description, selected = false, measurement, status, caption, icon, image, accent = "default", selectable = false, onSelect }: Props = $props();

  // Same highlight/shadow sheen as BentoWidget (see its own comment) -- the
  // two non-selected species cards (Vogel/Morphofalter) share the identical
  // grey-light Figma accent, so without it they render as twin flat blocks
  // with no material depth at all.
  const sheenId = `species-sheen-${Math.random().toString(36).slice(2, 9)}`;
  const overflow = $derived(cornerOverflow(corners, radius));
  const svgWidth = $derived(width + overflow.left + overflow.right);
  const svgHeight = $derived(height + overflow.top + overflow.bottom);

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

  <div class="species-widget__content">
    {#if title || description}
      <header class="species-widget__header">
        {#if title}<h3 class="species-widget__title">{title}</h3>{/if}
        {#if description}<p class="species-widget__description">{description}</p>{/if}
      </header>
    {/if}

    {#if selected && (measurement || status || caption)}
      <div class="species-widget__facts">
        {#if measurement || status}
          <div class="species-widget__facts-row">
            {#if measurement}
              <div class="species-widget__fact species-widget__fact--stacked">
                <!-- Tape measure, sized/proportioned to match the real Figma icon group
                     (63.33x44.33, read directly off "Group 2" in Frame 1 Desktop). -->
                <svg class="species-widget__fact-icon species-widget__fact-icon--tape" viewBox="0 0 64 44" fill="none" aria-hidden="true">
                  <rect x="2" y="2" width="60" height="26" rx="13" stroke="currentColor" stroke-width="2" />
                  <path d="M14 2v10M24 2v6M34 2v10M44 2v6M54 2v10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                  <path d="M20 28c0 8 6 14 14 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                  <rect x="30" y="34" width="14" height="8" rx="2" stroke="currentColor" stroke-width="2" />
                </svg>
                <span class="species-widget__fact-text">{measurement}</span>
              </div>
            {/if}
            {#if status}
              <div class="species-widget__fact species-widget__fact--stacked">
                <!-- Range indicator: a plain hairline with rounded end-caps and one tick
                     mark, matching the real "Line 11" + "Arrow 2" pair (179px wide, tick
                     ~88% along) rather than a two-dot slider. -->
                <svg class="species-widget__fact-icon species-widget__fact-icon--range" viewBox="0 0 180 20" preserveAspectRatio="none" aria-hidden="true">
                  <line x1="2" y1="10" x2="178" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                  <line x1="157" y1="1" x2="157" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
                <span class="species-widget__fact-text">{status}</span>
              </div>
            {/if}
          </div>
        {/if}
        {#if caption}
          <div class="species-widget__fact species-widget__fact--inline">
            <svg class="species-widget__fact-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" />
              <line x1="12" y1="11" x2="12" y2="16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              <circle cx="12" cy="8" r="1" fill="currentColor" />
            </svg>
            <span class="species-widget__fact-text">{caption}</span>
          </div>
        {/if}
      </div>
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
    /* Hover/focus lift -- see BentoWidget's identical pair for why the
       transform sits on the root and the shadow lives on the silhouette.
       filter is here too so releasing a press eases the brightness dip back
       out at this same relaxed pace, even though pressing it down uses the
       snappier transition declared on [data-pressed="true"] itself. */
    transition:
      transform 220ms ease,
      filter 220ms ease;
  }

  .species-widget:hover,
  .species-widget:focus-visible {
    transform: translateY(-8px) scale(1.015);
  }

  /* Press feedback (mouse pointerdown or keyboard Enter/Space, see `pressed`
     state above) -- a quick dip toward the surface plus a brightness pinch,
     the tactile "this is about to do something" cue the hover lift alone
     doesn't give before the 480ms expand even starts. Comes after the hover
     rule so it wins at equal specificity when both apply (hovering, then
     pressing) -- and it's deliberately much quicker than the hover
     transition, a press should register as close to instant. */
  .species-widget[data-pressed="true"] {
    transform: translateY(-2px) scale(0.975);
    filter: brightness(0.96);
    transition:
      transform 90ms cubic-bezier(0.4, 0, 1, 1),
      filter 90ms ease;
  }

  .species-widget__silhouette {
    position: absolute;
    z-index: 0;
    /* left/top set inline per-instance -- Concave/Fill-* corners reach past the box. */
    pointer-events: none;
    transition: filter 220ms ease;
  }

  /* Same accent-tinted glow as BentoWidget's identical pair (see its own
     comment) -- reused here rather than re-derived so both widget kinds
     stay the one shared hover language, not two that quietly drift apart. */
  .species-widget:hover .species-widget__silhouette,
  .species-widget:focus-visible .species-widget__silhouette {
    filter: drop-shadow(0 20px 32px color-mix(in srgb, var(--accent-fill) 45%, transparent))
      drop-shadow(0 14px 24px var(--shadow-key)) drop-shadow(0 2px 4px var(--shadow-ambient));
  }

  /* Shadow tightens toward the surface on press, same physical-push logic as
     the lift growing the shadow on hover, inverted. */
  .species-widget[data-pressed="true"] .species-widget__silhouette {
    filter: drop-shadow(0 8px 14px color-mix(in srgb, var(--accent-fill) 35%, transparent))
      drop-shadow(0 6px 10px var(--shadow-key)) drop-shadow(0 1px 2px var(--shadow-ambient));
    transition: filter 90ms ease;
  }

  @media (prefers-reduced-motion: reduce) {
    .species-widget,
    .species-widget__silhouette {
      transition: none;
    }
    .species-widget:hover,
    .species-widget:focus-visible,
    .species-widget[data-pressed="true"] {
      transform: none;
    }
    .species-widget[data-pressed="true"] {
      filter: none;
    }
  }

  .species-widget__fill {
    fill: var(--accent-fill);
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

  .species-widget__description {
    color: var(--text-secondary);
    font: var(--text-body);
    /* `font` can't carry letter-spacing -- see --text-body-tracking's own comment. */
    letter-spacing: var(--text-body-tracking);
    margin: 0;
  }

  .species-widget__facts {
    display: flex;
    flex-direction: column;
    gap: var(--stack-sm);
  }

  .species-widget[data-selectable="true"] {
    cursor: pointer;
  }

  .species-widget__facts-row {
    display: flex;
    gap: var(--inset-lg);
  }

  .species-widget__fact--stacked {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--stack-xs);
  }

  .species-widget__fact--inline {
    display: flex;
    align-items: flex-start;
    gap: var(--inline-sm);
  }

  .species-widget__fact-icon {
    width: var(--size-icon-lg);
    height: var(--size-icon-lg);
    flex-shrink: 0;
  }

  .species-widget__fact-icon--tape {
    /* Matches the real icon group's own 63.33x44.33 aspect ratio. */
    width: 44px;
    height: 30px;
  }

  .species-widget__fact-icon--range {
    /* Matches the real Line 11's 179px width -- scales with everything else via
       the shared --screen-frame-content-scale transform, same as font sizes. */
    width: 179px;
    height: 20px;
  }

  .species-widget__fact-text {
    font: var(--text-body);
    /* `font` can't carry letter-spacing -- see --text-body-tracking's own comment. */
    letter-spacing: var(--text-body-tracking);
  }

  .species-widget__visual {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .species-widget__icon-plate {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: var(--inset-lg);
    border-radius: var(--pill);
    /* Was a flat rgb(0 0 0 / 0.12) disc -- the plate itself was as flat as the
       line-art it sits behind. A radial highlight/shadow (same
       light-from-top-left language as the card sheens above) plus a real
       drop-shadow reads as a lit, embossed badge instead of a tinted circle,
       and the slow breathe keyframe below gives the row *some* idle motion --
       previously every card was fully static outside the click-driven
       expand/collapse. */
    background: radial-gradient(circle at 32% 28%, rgb(255 255 255 / 0.22) 0%, rgb(255 255 255 / 0.05) 42%, rgb(0 0 0 / 0.2) 100%);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.18),
      inset 0 -6px 10px rgb(0 0 0 / 0.2),
      0 8px 16px rgb(0 0 0 / 0.22);
    animation: species-icon-breathe 6s ease-in-out infinite;
  }

  @keyframes species-icon-breathe {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.035);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .species-widget__icon-plate {
      animation: none;
    }
  }
</style>
