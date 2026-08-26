<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** Figma component set "Map Pin", Content property: Icon (line-art glyph) | Photo (real image). */
    variant?: "icon" | "photo";
    /** Sets data-accent — the disc's fill resolves via --accent-fill (widget-accent.css), same token set every other accented widget uses. */
    accent?: string;
    icon?: Snippet;
    image?: Snippet;
    /** Accessible name for the pin -- there's no visible text slot in the Figma
        component (Content is only Icon|Photo), so this is the pin's aria-label
        rather than a rendered caption. */
    label?: string;
    onClick?: () => void;
  }

  let { variant = "icon", accent = "gold", icon, image, label = "Map pin", onClick }: Props = $props();

  // Enter/Space activation mirrors SpeciesWidget's div-as-button handling --
  // a role="button" div gets no native :active/click-on-Enter behaviour, so
  // without this a keyboard user can focus the pin but never trigger onClick.
  // e.repeat is guarded because a held key would otherwise fire onClick once
  // per repeated keydown instead of once per press.
  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (e.repeat) return;
    onClick?.();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- role/tabindex are only set together, when onClick is present; the linter can't see that correlation. -->
<div
  class="map-pin"
  data-accent={accent}
  data-variant={variant}
  aria-label={label}
  role={onClick ? "button" : undefined}
  tabindex={onClick ? 0 : undefined}
  style:cursor={onClick ? "pointer" : undefined}
  onclick={onClick}
  onkeydown={onClick ? handleKeydown : undefined}
>
  <div class="map-pin__disc">
    {#if variant === "photo" && image}
      {@render image()}
    {:else if icon}
      {@render icon()}
    {/if}
  </div>
  <!-- Stem is a SIBLING of the disc, not a child -- nesting it inside would
       make the disc's own border-radius/overflow clip the stem's top corners
       into the circle, and the disc is meant to stay a clean, uninterrupted
       circle with the stem simply butting up against its underside. -->
  <div class="map-pin__stem"></div>
</div>

<style>
  .map-pin {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 103px;
    height: 220px;
  }

  .map-pin__disc {
    flex: none;
    width: 103px;
    height: 103px;
    box-sizing: border-box;
    border-radius: var(--pill);
    border: 3px solid var(--border-focus);
    /* color-mix over --accent-fill (not a raw rgba literal) so the 50%/20%
       alpha split works for every accent, including grey-light/forest-green
       whose --accent-fill is itself a var() reference, not a literal this
       component could otherwise blend against. */
    background: color-mix(in srgb, var(--accent-fill) 50%, transparent);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* A photo tinted at the icon variant's 50% alpha reads flat -- the photo
     needs to show through, not compete with a half-opaque colour wash over
     it, so the photo variant drops to 20%. */
  .map-pin[data-variant="photo"] .map-pin__disc {
    background: color-mix(in srgb, var(--accent-fill) 20%, transparent);
  }

  .map-pin__stem {
    flex: none;
    width: 3px;
    height: 117px;
    background: var(--border-focus);
  }

  /* Every interactive surface in this library shows keyboard focus explicitly --
     a bare div[tabindex] otherwise falls back to whatever the UA draws, which on
     a translucent disc over a photo is frequently nothing at all. Matches
     PlayButton's outline treatment rather than inventing a second idiom. */
  .map-pin:focus-visible {
    outline: 3px solid var(--border-focus);
    outline-offset: 3px;
  }
</style>
