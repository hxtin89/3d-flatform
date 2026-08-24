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
    /** Unselected (default): shows the `icon` slot. Selected: shows the measurement/status/caption facts plus the `image` slot instead -- reproduces Figma's real "SIRA GIFTFROSCH" vs. "SCHNURRVOGEL"/"BLAUER MORPHOFALTER" distinction (Frame 1 Desktop). */
    selected?: boolean;
    /** e.g. "15-17mm" — selected only. */
    measurement?: string;
    /** e.g. "Schutzstatus: am Wenigsten bedroht" — selected only. */
    status?: string;
    /** e.g. "Nur die männlichen Frösche kümmern sich um den Nachwuchs" — selected only. */
    caption?: string;
    /** Line-art species icon — shown when NOT selected. */
    icon?: Snippet;
    /** Real species photo — shown when selected. */
    image?: Snippet;
    /** Sets data-accent — background color resolves via the accent-fill CSS custom property, same token set BentoWidget uses. */
    accent?: string;
    /** Makes the whole card a click target that calls `onSelect` (toggling this species' selected state) — the caller (BentoGrid) owns exclusivity and the expand/collapse animation. */
    selectable?: boolean;
    onSelect?: () => void;
  }

  let { path, width, height, corners, radius = 60, title, description, selected = false, measurement, status, caption, icon, image, accent = "default", selectable = false, onSelect }: Props = $props();

  const overflow = $derived(cornerOverflow(corners, radius));
  const svgWidth = $derived(width + overflow.left + overflow.right);
  const svgHeight = $derived(height + overflow.top + overflow.bottom);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect?.();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- role/tabindex are only ever set together, when selectable is true; the linter can't see that correlation across the ternaries. -->
<div
  class="species-widget"
  data-accent={accent}
  data-selected={selected}
  data-selectable={selectable}
  style:width="{width}px"
  style:height="{height}px"
  role={selectable ? "button" : undefined}
  tabindex={selectable ? 0 : undefined}
  onclick={selectable ? onSelect : undefined}
  onkeydown={selectable ? handleKeydown : undefined}
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
    <path d={path} class="species-widget__fill" />
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
      {#if selected}
        {#if image}{@render image()}{/if}
      {:else if icon}
        {@render icon()}
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
  }

  /* --text-secondary (gray-700) happens to equal grey-dark's own accent-fill
     value -- description/fact text would otherwise be invisible (same color
     as its own background). Figma's real widgets bind dark-fill text to a
     dedicated "text/onEmphasis" role for exactly this reason; this codebase
     doesn't have that role yet, so this is scoped to the one accent that
     actually collides rather than reworking text-color tokens more broadly. */
  .species-widget[data-accent="grey-dark"] {
    --text-primary: var(--gray-50);
    --text-secondary: var(--gray-300);
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
    width: 24px;
    height: 24px;
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
  }

  .species-widget__visual {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
</style>
