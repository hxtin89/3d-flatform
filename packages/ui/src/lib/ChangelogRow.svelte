<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** Custom markup for the card's content (e.g. a real <img> with srcset) --
        takes priority over imageSrc when given, same precedence SpeciesWidget
        gives its `image` snippet over a plain source. */
    image?: Snippet;
    /** Plain image URL, applied as a CSS background-image -- the common case
        where the caller has nothing more than a URL and doesn't need a snippet. */
    imageSrc?: string;
    height?: number;
    onClick?: () => void;
    /** Accessible name -- Figma's "Changelog Row" has no visible text slot, so
        this is the card's aria-label rather than a rendered caption. */
    label?: string;
  }

  let { image, imageSrc, height = 180, onClick, label = "Changelog entry" }: Props = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (e.repeat) return;
    onClick?.();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- role/tabindex are only set together, when onClick is present; the linter can't see that correlation. -->
<div
  class="changelog-row"
  aria-label={label}
  role={onClick ? "button" : undefined}
  tabindex={onClick ? 0 : undefined}
  style:height="{height}px"
  style:cursor={onClick ? "pointer" : undefined}
  style:background-image={!image && imageSrc ? `url(${imageSrc})` : undefined}
  onclick={onClick}
  onkeydown={onClick ? handleKeydown : undefined}
>
  {#if image}
    {@render image()}
  {/if}
</div>

<style>
  .changelog-row {
    width: 100%;
    box-sizing: border-box;
    border-radius: var(--card-outer);
    /* A keyline, not a structural edge -- 5px is Figma's literal stroke weight
       on the real "Changelog Row" component, not a spacing/border token, so it
       stays a literal rather than reaching for a token that doesn't exist for it. */
    border: 5px solid var(--bg-muted);
    background-color: var(--bg-muted);
    background-size: cover;
    background-position: center;
    overflow: hidden;
  }

  /* Every interactive surface in this library shows keyboard focus explicitly --
     a bare div[tabindex] otherwise falls back to whatever the UA draws, which on
     a translucent disc over a photo is frequently nothing at all. Matches
     PlayButton's outline treatment rather than inventing a second idiom. */
  .changelog-row:focus-visible {
    outline: 3px solid var(--border-focus);
    outline-offset: 3px;
  }
</style>
