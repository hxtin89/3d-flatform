<script lang="ts">
  import type { Snippet } from "svelte";
  import PlayButton from "./PlayButton.svelte";
  import Scrubber from "./Scrubber.svelte";

  interface Props {
    /** Static poster/frame image. Ignored when `image` is passed. */
    imageSrc?: string;
    /** Real video surface (a <video> element, a player embed, …) — takes priority over `imageSrc`
        the same way SpeciesWidget's `image` snippet takes priority over its plain prop. */
    image?: Snippet;
    author?: string;
    duration?: string;
    /** 0..1. Undefined/0 renders an empty track -- there's no "no scrubber at all" state in the
        Figma component, so this never conditionally hides the scrubber like image/icon do above. */
    progress?: number;
    /** Sets data-accent — background resolves via --accent-fill, same token set every other
        widget in this file uses. Figma's Media Card instance is gold, so that's the default here
        too rather than "default" -- callers that want the neutral fill still can. */
    accent?: string;
    onPlay?: () => void;
  }

  let { imageSrc, image, author, duration, progress = 0, accent = "gold", onPlay }: Props = $props();

  // Figma passes progress in occasionally out-of-range (a raw currentTime/duration division can
  // land at 1.0000001 or briefly negative before a seek settles) -- clamping here once means the
  // width style below never has to think about it.
  const clampedProgress = $derived(Math.max(0, Math.min(1, progress)));
</script>

<div class="media-card" data-accent={accent}>
  <div class="media-card__thumbnail">
    {#if image}
      {@render image()}
    {:else if imageSrc}
      <img src={imageSrc} alt="" class="media-card__image" />
    {/if}

    <div class="media-card__play">
      <PlayButton size={103} {accent} onClick={onPlay} />
    </div>

    <!-- Pinned to the thumbnail's own lower edge rather than stacked beneath it: below
         the image this is accent-fill on accent-fill and completely invisible. -->
    <div class="media-card__scrubber">
      <Scrubber progress={clampedProgress} {accent} />
    </div>
  </div>

  <div class="media-card__meta">
    {#if author}<span class="media-card__author">{author}</span>{/if}
    {#if duration}<span class="media-card__duration">{duration}</span>{/if}
  </div>
</div>

<style>
  .media-card {
    display: flex;
    align-items: stretch;
    background: var(--accent-fill);
    border-radius: var(--card-outer);
    /* Asymmetric on purpose (Figma: 8/8/8/24, top-right-bottom-left) -- the
       thumbnail sits nearly flush left while the meta column gets real air
       on the right. inset-sm and inset-xl are exact 8px/24px matches, so
       both sides come from tokens even though the split itself is unusual. */
    padding: var(--inset-sm) var(--inset-xl) var(--inset-sm) var(--inset-sm);
    box-sizing: border-box;
    gap: var(--inset-sm);
    /* Figma's card is 720x360. Without a ratio the card has no intrinsic height at
       all and simply grows to whatever the thumbnail image happens to measure -- a
       632x424 asset pushed it to 440px tall and shoved the duration and the
       scrubber out of view entirely. A ratio keeps it fluid (width still comes from
       the container) while giving height something to derive from. Callers that
       need a different shape override aspect-ratio or set an explicit height. */
    aspect-ratio: 720 / 360;
  }

  /* Same contrast fix as BentoWidget/SpeciesWidget (see BentoWidget's own comment for the
     full rationale, verified there via get_variable_defs): gray-900 text over these four
     accent-fills is unreadable, and Figma binds text/onEmphasis on all of them, not a
     dimmed secondary. gold is this component's own default, so it can't be skipped here
     the way it nearly was on BentoWidget. */
  .media-card[data-accent="forest-green"],
  .media-card[data-accent="grey-light"],
  .media-card[data-accent="grey-dark"],
  .media-card[data-accent="gold"] {
    --text-primary: var(--text-on-emphasis);
    --text-secondary: var(--text-on-emphasis);
  }

  .media-card__thumbnail {
    position: relative;
    /* Flexes to fill whatever width the meta column doesn't hug -- this is the one
       fluid axis the task calls out explicitly. */
    flex: 1 1 auto;
    min-width: 0;
    /* 55px isn't any existing --radius-* token (closest is card-outer's 60) -- Figma's
       own value for this shape, kept literal rather than borrowing a token that would
       silently drift the thumbnail out of sync with the outer card corner. */
    border-radius: 55px;
    overflow: hidden;
  }

  /* Anything the `image` snippet renders is cropped to the thumbnail rather than
     allowed to set its own size. The rule below only reaches .media-card__image,
     which is the `imageSrc` path -- a snippet passes its own <img>, which stayed
     unconstrained and dictated the whole card's height. :global is required
     because the node is authored by the caller, not by this component. */
  .media-card__thumbnail :global(img),
  .media-card__thumbnail :global(svg),
  .media-card__thumbnail :global(video) {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .media-card__image {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Positioning only -- PlayButton and Scrubber own their own appearance. An
     earlier pass inlined copies of both here because neither component existed
     yet when this file was written; they do now, and a second copy of a control
     is a second place for its focus state to go missing. */
  .media-card__play {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  /* On the thumbnail's lower edge, not below it: below the image this is
     accent-fill on accent-fill and completely invisible. */
  .media-card__scrubber {
    position: absolute;
    left: var(--inset-xl);
    right: var(--inset-xl);
    bottom: var(--inset-xl);
  }

  .media-card__meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: space-between;
    /* Hugs its own text width -- flex-basis auto plus no grow keeps it exactly as wide
       as "author"/"duration" need, never stretching to share space with the thumbnail. */
    flex: 0 0 auto;
    white-space: nowrap;
    color: var(--text-primary);
  }

  .media-card__author {
    font: var(--text-body);
    letter-spacing: var(--text-body-tracking);
  }

  .media-card__duration {
    /* Same reasoning as SpeciesWidget's measurement reading (see its own comment): a
       duration is a clock readout, not prose, so it gets the mono face instead of the
       body font the author line above it uses. */
    font-family: var(--family-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--size-caption);
    opacity: 0.85;
  }
</style>
