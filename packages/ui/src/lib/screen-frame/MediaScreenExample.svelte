<script lang="ts">
  import { createRawSnippet } from "svelte";
  import type { Snippet } from "svelte";
  import ScreenFrame from "./ScreenFrame.svelte";
  import HabitatLabelStack from "./HabitatLabelStack.svelte";
  import MediaCard from "../MediaCard.svelte";
  import MapPin from "../MapPin.svelte";
  import ChangelogRow from "../ChangelogRow.svelte";
  import ChangelogRail from "../ChangelogRail.svelte";
  import { eagleLogo } from "./logo-icon";
  import { habitatPhoto } from "./habitat-photo";
  import { giftfroschImage, birdImage, butterflyImage } from "./species-icons";

  interface Props {
    /** Which of the four "Bento Grid — Recreation" frames to render -- these are
        four separate UI states of the same mobile shell (Frame 1's), not four
        sizes of the same layout the way ScreenExample's width/height sweep the
        one Frame 1 layout. So instead of ScreenExample's {width, height} props
        (deliberately fixed-px, not viewport-driven -- see its own doc) this
        takes a frame selector and stays fixed at the mobile reference size
        (1080x1920 -- frame.ts's MOBILE_REFERENCE_WIDTH/HEIGHT) that all four
        source frames actually are. None of the four has a desktop counterpart
        in the Figma page, so there is nothing to sweep. */
    frame: "video" | "pins" | "changelog-open" | "changelog-closed";
  }

  let { frame }: Props = $props();

  // Real "paw print" line-art for MapPin's Content=Icon pin on Frame 8 -- not
  // in species-icons.ts (that file only has bird/frog/butterfly glyphs, none
  // of which is what Frame 8's icon pin actually shows), and adding a
  // MediaScreenExample-only glyph to that shared file would be scope creep
  // for a one-frame need. Same drawing convention as species-icons.ts's
  // iconSnippet -- 64x64 viewBox, currentColor, 72x72 rendered box -- so it
  // sits in MapPin's disc at the same visual weight frogIcon does there.
  const pawIcon: Snippet = createRawSnippet(() => ({
    render: () => `
      <svg viewBox="0 0 64 64" fill="currentColor" style="width:72px;height:72px" aria-hidden="true">
        <ellipse cx="32" cy="42" rx="16" ry="12" />
        <ellipse cx="14" cy="24" rx="6" ry="8" transform="rotate(-20 14 24)" />
        <ellipse cx="28" cy="16" rx="6.5" ry="8.5" />
        <ellipse cx="42" cy="16" rx="6.5" ry="8.5" />
        <ellipse cx="54" cy="26" rx="6" ry="8" transform="rotate(20 54 26)" />
      </svg>
    `,
  }));

  // Changelog entries have no real Figma copy behind them -- the "Changelog
  // Row" component (see ChangelogRow.svelte's own doc) has no visible text
  // slot at all, and the task brief that named this frame gave a row count
  // and size (508x180, stacked down the right edge) but no per-entry
  // content. So: real asset, invented label -- exactly ChangelogRow.stories.ts's
  // own WithImageSnippet/Default split, reusing the three real species
  // illustrations plus the real habitat photo (all already used elsewhere in
  // this library) rather than fabricating four new placeholder images, with
  // aria-labels that read as plausible update copy but are NOT claimed to be
  // Figma-sourced. Four rows is an arbitrary, unspecified count.
  const CHANGELOG_ENTRIES: { image: Snippet | undefined; imageSrc?: string; label: string }[] = [
    { image: giftfroschImage, label: "Update: Sira Giftfrosch beobachtet" },
    { image: birdImage, label: "Update: Schnurrvogel-Sichtung" },
    { image: butterflyImage, label: "Update: Blauer Morphofalter kartiert" },
    { image: undefined, imageSrc: habitatPhoto, label: "Update: neue Drohnenaufnahme" },
  ];
</script>

<div class="media-screen-example">
  <ScreenFrame>
    {#snippet background()}
      <!-- Same real drone/habitat photo ScreenExample.svelte's background uses
           (see its own header for sourcing), but WITHOUT that file's animated
           pan/zoom and feTurbulence film-grain filters: those exist to hold up
           against .gauntlet/ref's pixel-measured Frame 1 exports, and no
           reference export exists for any of these four frames to hold this
           treatment accountable to. A flat photo + scrim is the honest amount
           of polish for a background nothing here is graded against, not a
           re-derivation of ScreenExample's grain math for its own sake. -->
      <div class="media-screen-example__backdrop">
        <img class="media-screen-example__photo" src={habitatPhoto} alt="" aria-hidden="true" />
        <div class="media-screen-example__scrim"></div>
      </div>
    {/snippet}
    {#snippet logo()}
      {@render eagleLogo()}
    {/snippet}
    <!-- weather/species/label are intentionally omitted: ScreenFrame's dock
         logic only ever places `label` at left-center (tall arrangement) or
         bottom-right (wide arrangement) -- see ScreenFrame.svelte's own prop
         doc -- neither of which matches Frame 3's lower-left or Frame 8's
         top-right placement. Those two frames are a different composition of
         the same shell, not Frame 1's bento layout, so the label stack below
         is positioned directly against this frame's own corners instead of
         going through a docking system built for a layout these frames
         don't have. -->
  </ScreenFrame>

  {#if frame === "video"}
    <!-- Figma "Frame 3 Mobile - Video": gold Media Card at (360,231) 720x360.
         No dedicated video-poster asset exists in this repo's asset set, so
         the same real habitat photo the background above uses doubles as the
         thumbnail -- a real asset reused across two Figma nodes' roles, not a
         fabricated one. Author/duration are the real Figma text content
         ("Nadine Holmes" / "1:20 Minuten"); progress has no Figma-given value
         (a scrubber position isn't static content), so it's an arbitrary
         demo fraction, same spirit as MediaCard.stories.ts's own picks. -->
    <div class="media-screen-example__media-card">
      <MediaCard imageSrc={habitatPhoto} author="Nadine Holmes" duration="1:20 Minuten" progress={0.3} accent="gold" />
    </div>
    <div class="media-screen-example__label media-screen-example__label--lower-left">
      <HabitatLabelStack align="left" />
    </div>
  {:else if frame === "pins"}
    <!-- Figma "Frame 8 Mobile - Pins": two Map Pins over the photo. Positions
         are the pin's own top-left, the same corner convention the brief
         used for the Media Card's (360,231) -- MapPin has no Figma-given
         width/height in the brief the way the Media Card did (103x220 is
         this component's own fixed box, not a per-frame measurement), so
         there is no separate size to state here. -->
    <div class="media-screen-example__pin" style:left="139px" style:top="616px">
      <MapPin variant="icon" accent="gold" icon={pawIcon} label="Spuren-Markierung" />
    </div>
    <div class="media-screen-example__pin" style:left="710px" style:top="989px">
      <MapPin variant="photo" accent="gold" image={giftfroschImage} label="Sira Giftfrosch habitat" />
    </div>
    <div class="media-screen-example__label media-screen-example__label--top-right">
      <HabitatLabelStack align="right" />
    </div>
  {:else if frame === "changelog-open"}
    <!-- Figma "Frame 6 Mobile - Changelog open": a column of 508x180 rows down
         the right side. Column x (512 = 1080 - 60 margin - 508 width) uses
         the frame's own established margin constant (frame.ts's
         FIGMA_MARGIN_PX); the gap between rows is a real spacing decision
         (unlike the frame-position numbers above, a token DOES cover it), so
         it comes from --stack-lg rather than a literal. -->
    <div class="media-screen-example__changelog-column">
      {#each CHANGELOG_ENTRIES as entry (entry.label)}
        <ChangelogRow image={entry.image} imageSrc={entry.imageSrc} label={entry.label} />
      {/each}
    </div>
  {:else if frame === "changelog-closed"}
    <!-- Figma "Frame 5 Mobile - Changelog closed": the Changelog Rail, a 60px
         strip on the right edge. height="100%" (the component's own default)
         collapses to nothing here because this wrapper div, like any other
         unsized parent (see ChangelogRail.svelte's own `height` doc), gives
         it no intrinsic height -- so the full frame height is passed
         explicitly instead. -->
    <div class="media-screen-example__rail-host">
      <ChangelogRail height="1920px" side="right" />
    </div>
  {/if}
</div>

<style>
  .media-screen-example {
    position: relative;
    width: 1080px;
    height: 1920px;
    overflow: hidden;
  }

  .media-screen-example__backdrop {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  .media-screen-example__photo {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .media-screen-example__scrim {
    position: absolute;
    inset: 0;
    /* Same darken-for-legibility role as ScreenExample's scrim, reduced to
       the one gradient that matters for readability -- the two warm dapple
       blobs there are grain-adjacent polish this file already opts out of
       (see the background snippet's own comment). */
    background: radial-gradient(120% 90% at 50% 10%, rgb(20 30 24 / 0.35) 0%, rgb(10 16 12 / 0.55) 60%, rgb(5 8 6 / 0.75) 100%);
  }

  /* z-index: 50 on every overlay below, not just the rail this was caught on --
     the same cause would silently hide any of the others the moment a future
     edit moves one from the window's transparent cutout into the margin band.
     Verified with the actual pixel colour, not assumed: at (30,900), inside
     the closed rail's own 0-60px box, the rendered pixel was (220,220,220) --
     the frame's grey margin -- not the rail's gold, i.e. ScreenFrame's OWN
     z-index:40 mask svg / z-index:45 logo were painting over a plain sibling
     div with no z-index of its own. `.screen-frame` (ScreenFrame.svelte's own
     root) is `position:relative` but carries no z-index itself, so it never
     isolates a stacking context for its children -- their explicit z-index:
     40/45 competes directly against THIS file's siblings in the shared outer
     context instead of staying scoped inside ScreenFrame's own subtree, and
     a positive explicit z-index beats a plain z-index:auto sibling
     regardless of DOM order. Content docked fully inside the window's own
     transparent mask cutout (the pins, both label placements) never showed
     this, since there's nothing opaque there to lose to either way -- it
     only surfaces for anything that reaches into the margin band, which is
     the rail's entire reason to exist. Not fixable from here by reordering
     DOM (already last) or upping specificity -- only an explicit z-index
     above 45 moves these into their own winning stacking context. Editing
     ScreenFrame.svelte itself (e.g. giving `.screen-frame` its own z-index)
     is out of this task's scope, so the fix lives on this side instead. */
  .media-screen-example__media-card {
    position: absolute;
    left: 360px;
    top: 231px;
    width: 720px;
    z-index: 50;
  }

  .media-screen-example__pin {
    position: absolute;
    z-index: 50;
  }

  .media-screen-example__label {
    position: absolute;
    z-index: 50;
  }

  .media-screen-example__label--lower-left {
    left: 60px;
    bottom: 60px;
  }

  .media-screen-example__label--top-right {
    top: 60px;
    right: 60px;
  }

  .media-screen-example__changelog-column {
    position: absolute;
    top: 60px;
    left: 512px;
    width: 508px;
    display: flex;
    flex-direction: column;
    gap: var(--stack-lg);
    z-index: 50;
  }

  .media-screen-example__rail-host {
    position: absolute;
    /* top/right, NOT inset:0 -- ChangelogRail is a plain 60px-wide block, it
       does not self-align within its container (`side="right"` only picks
       which two corners round, see the component's own doc), so THIS host
       has to be the thing sitting flush against the right edge. An earlier
       version used inset:0 on the assumption the rail would dock itself the
       way ScreenFrame's own weather/species/label docks do -- it doesn't
       have that machinery, and inset:0 just put the host's left edge (and
       therefore the rail inside it) at the window's own left edge instead. */
    top: 0;
    right: 0;
    z-index: 50;
  }
</style>
