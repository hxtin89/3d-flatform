<script lang="ts">
  import ScreenFrame from "./ScreenFrame.svelte";
  import BentoGrid from "../BentoGrid.svelte";
  import HabitatLabelStack from "./HabitatLabelStack.svelte";
  import { WEATHER_CLUSTER, SPECIES_ROW } from "./recreation-content";
  import { eagleLogo } from "./logo-icon";
  import { habitatPhoto } from "./habitat-photo";

  interface Props {
    /** Fixed pixel size -- deliberately NOT viewport/addon-driven, so the mobile/desktop
        examples render deterministically regardless of the host page's own size (a real
        .svelte wrapper is also the only way to give ScreenFrame's snippet props real
        component content without Storybook's plain-args CSF3 format, which has no story
        template syntax to write `{#snippet}` blocks in). */
    width: number;
    height: number;
  }

  let { width, height }: Props = $props();
</script>

<div style:width="{width}px" style:height="{height}px">
  <ScreenFrame>
    {#snippet background()}
      <!-- The real drone/photogrammetry photo this frame is cut around --
           the actual "S1: Photo" image fill from the Figma source file
           (Frame 1 Desktop, node 25556:1099: a river-bend scan with a
           topographic contour overlay), not a licensed stock photo and not
           fabricated. Re-encoded smaller (see habitat-photo.ts) since the
           original upload is 6MB+; the dark scrim gradient and grain below
           are still layered on top for text legibility and to tie the photo
           into the UI's own palette, not as a placeholder for it anymore.
           This used to also overlay four fabricated HUD readouts (fake node
           IDs, soil/canopy/wind sensor numbers, a sparkline) that exist
           nowhere in the real Figma frame -- get_screenshot on the actual
           frame shows only the weather/species widgets and the label stack
           over this photo, no telemetry chrome at all. Removed rather than
           replaced: inventing plausible-looking sensor data is the same
           fabrication this screen is being held to account for, just with
           better formatting. -->
      <div class="habitat-backdrop">
        <img class="habitat-backdrop__photo" src={habitatPhoto} alt="" aria-hidden="true" />
        <div class="habitat-backdrop__scrim"></div>
        <svg class="habitat-backdrop__texture" aria-hidden="true">
          <!-- Each filter desaturates the turbulence to a per-pixel luminance
               (keeping alpha untouched, so the texture stays visible) then
               scales that luminance differently per channel to tint it
               green -- an earlier version zeroed the RGB inputs and fixed
               alpha to a constant, which collapsed the noise into one flat
               tinted rectangle with no texture at all. -->
          <filter id="habitat-grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise" />
            <feColorMatrix in="noise" type="saturate" values="0" result="gray" />
            <feColorMatrix in="gray" type="matrix" values="0.35 0 0 0 0  0.55 0 0 0 0  0.35 0 0 0 0  0 0 0 1 0" />
          </filter>
          <filter id="habitat-patch">
            <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="3" stitchTiles="stitch" result="noise" />
            <feColorMatrix in="noise" type="saturate" values="0" result="gray" />
            <feColorMatrix in="gray" type="matrix" values="0.2 0 0 0 0  0.5 0 0 0 0  0.25 0 0 0 0  0 0 0 1 0" />
          </filter>
          <rect class="habitat-backdrop__grain" width="100%" height="100%" filter="url(#habitat-grain)" />
          <rect class="habitat-backdrop__patch" width="100%" height="100%" filter="url(#habitat-patch)" />
        </svg>
      </div>
    {/snippet}
    {#snippet logo()}
      {@render eagleLogo()}
    {/snippet}
    {#snippet weather()}
      <!-- topLeftIsScreenCorner=false: neither cluster sits at the real screen's
           actual top-left, see BentoGrid's own doc comment. -->
      <BentoGrid items={WEATHER_CLUSTER} radius={60} topLeftIsScreenCorner={false} />
    {/snippet}
    {#snippet species()}
      <BentoGrid items={SPECIES_ROW} radius={60} topLeftIsScreenCorner={false} />
    {/snippet}
    {#snippet label(align)}
      <HabitatLabelStack {align} />
    {/snippet}
  </ScreenFrame>
</div>

<style>
  .habitat-backdrop {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  .habitat-backdrop__photo {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    /* Slow parallax-style drift instead of a static plant -- the reference
       sites' depth comes from motion as much as from the photo itself. Scale
       stays >1 for the whole animation so the pan never exposes an edge. */
    animation: habitat-photo-drift 40s ease-in-out infinite alternate;
  }

  @keyframes habitat-photo-drift {
    from {
      transform: scale(1.08) translate(0, 0);
    }
    to {
      transform: scale(1.14) translate(-1.5%, -1.5%);
    }
  }

  .habitat-backdrop__scrim {
    position: absolute;
    inset: 0;
    /* Same darkening/warming role the flat gradient used to play alone --
       now a scrim over the real photo instead of standing in for it: a
       broad dusk-light falloff, two darker off-center blobs for depth, and
       two soft warm blobs for dappled light, plus an overall darken so
       widget text stays legible over bright parts of the photo. */
    background:
      radial-gradient(18% 14% at 28% 22%, rgb(214 198 120 / 0.14) 0%, transparent 70%),
      radial-gradient(14% 10% at 68% 38%, rgb(214 198 120 / 0.09) 0%, transparent 70%),
      radial-gradient(60% 45% at 20% 85%, rgb(10 20 15 / 0.55) 0%, transparent 70%),
      radial-gradient(50% 40% at 85% 75%, rgb(6 14 10 / 0.5) 0%, transparent 70%),
      radial-gradient(120% 90% at 50% 10%, rgb(20 30 24 / 0.35) 0%, rgb(10 16 12 / 0.55) 60%, rgb(5 8 6 / 0.75) 100%);
  }

  @media (prefers-reduced-motion: reduce) {
    .habitat-backdrop__photo {
      animation: none;
    }
  }

  .habitat-backdrop__texture {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .habitat-backdrop__grain {
    opacity: 0.09;
    mix-blend-mode: overlay;
  }

  .habitat-backdrop__patch {
    /* Coarse, low-frequency turbulence standing in for bark/leaf-cluster
       patching at photo scale -- the fine grain alone still read as a
       flat-gradient-plus-noise placeholder rather than real texture. */
    opacity: 0.35;
    mix-blend-mode: soft-light;
  }

</style>
