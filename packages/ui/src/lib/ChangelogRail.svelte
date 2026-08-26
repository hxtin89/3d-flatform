<script lang="ts">
  interface Props {
    text?: string;
    /** Which viewport edge the rail docks against. Its two corners flush
        against that physical edge stay square -- rounding a corner that sits
        right at the screen boundary is invisible/pointless, there's no
        surrounding surface for the curve to read against. The two corners on
        the inward side (facing the page content) get rounded instead, so the
        rail reads as a tab attached to the content rather than a bare slab. */
    side?: "left" | "right";
    /** Sets data-accent — the strip's fill resolves via --accent-fill (widget-accent.css), same token set every other accented widget uses. */
    accent?: string;
    /** Any CSS length. Defaults to filling the parent, which is what a docked rail
        wants -- but "100%" collapses to nothing in a container that has no height of
        its own, which is how this renders as an unreadable stub in Storybook and in
        any un-sized wrapper. Callers in that position pass a concrete height instead
        of the component silently disappearing. */
    height?: string;
    onClick?: () => void;
  }

  let { text = "CHANGELOG", side = "right", accent = "gold", height = "100%", onClick }: Props = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (e.repeat) return;
    onClick?.();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- role/tabindex are only set together, when onClick is present; the linter can't see that correlation. -->
<div
  class="changelog-rail"
  data-accent={accent}
  data-side={side}
  role={onClick ? "button" : undefined}
  tabindex={onClick ? 0 : undefined}
  style:cursor={onClick ? "pointer" : undefined}
  style:height={height}
  onclick={onClick}
  onkeydown={onClick ? handleKeydown : undefined}
>
  <span class="changelog-rail__label">{text}</span>
</div>

<style>
  .changelog-rail {
    width: 60px;
    /* height comes from the `height` prop (inline style) so it can be overridden;
       the floor stops a collapsed parent from reducing the rail to a stub in which
       the rotated label is clipped to illegibility. */
    min-height: 220px;
    box-sizing: border-box;
    background: var(--accent-fill);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  /* Docked right: flush edge is the right side, so the right corners stay
     square and the left (inward-facing) corners round. */
  .changelog-rail[data-side="right"] {
    border-radius: var(--card-outer) 0 0 var(--card-outer);
  }

  /* Docked left: flush edge is the left side -- mirror image of the above. */
  .changelog-rail[data-side="left"] {
    border-radius: 0 var(--card-outer) var(--card-outer) 0;
  }

  .changelog-rail__label {
    display: inline-block;
    white-space: nowrap;
    /* rotate(-90deg) puts what was the left end of the horizontal string at
       the bottom after rotation, so the text reads bottom-to-top -- the
       spine-label convention, not top-to-bottom CJK vertical writing. */
    transform: rotate(-90deg);
    font: var(--text-body);
    letter-spacing: var(--text-body-tracking);
    font-family: var(--family-sans);
    color: var(--text-primary);
  }

  /* Every interactive surface in this library shows keyboard focus explicitly --
     a bare div[tabindex] otherwise falls back to whatever the UA draws, which on
     a translucent disc over a photo is frequently nothing at all. Matches
     PlayButton's outline treatment rather than inventing a second idiom. */
  .changelog-rail:focus-visible {
    outline: 3px solid var(--border-focus);
    outline-offset: 3px;
  }

  /* Same fix BentoWidget already carries for these exact four accents: the label
     paints --text-primary, which is gray-900 by default, straight onto a solid
     accent fill. Figma binds text/onEmphasis (full white) on every one of them --
     verified there against the real text nodes, not guessed. Without this the
     label is near-black on gold and effectively unreadable on forest-green. */
  .changelog-rail[data-accent="forest-green"],
  .changelog-rail[data-accent="grey-light"],
  .changelog-rail[data-accent="grey-dark"],
  .changelog-rail[data-accent="gold"] {
    --text-primary: var(--text-on-emphasis);
  }
</style>
