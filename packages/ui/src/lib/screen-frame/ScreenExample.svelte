<script lang="ts">
  import ScreenFrame from "./ScreenFrame.svelte";
  import BentoGrid from "../BentoGrid.svelte";
  import HabitatLabelStack from "./HabitatLabelStack.svelte";
  import { WEATHER_CLUSTER, SPECIES_ROW } from "./recreation-content";
  import { eagleLogo } from "./logo-icon";

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
      <!-- Stand-in for the real drone/canopy photo this frame is cut around
           (no licensed photo asset in this repo). Two turbulence scales
           (fine moss grain + coarse bark/foliage patching), both tinted
           green instead of desaturated to grey, plus soft dappled-light
           blobs give it the texture real canopy photography/photogrammetry
           has -- a flat radial-gradient block read as an unfinished demo
           even with grain on top.
           This used to also overlay four fabricated HUD readouts (fake node
           IDs, soil/canopy/wind sensor numbers, a sparkline) that exist
           nowhere in the real Figma frame -- get_screenshot on the actual
           frame shows only the weather/species widgets and the label stack
           over this photo, no telemetry chrome at all. Removed rather than
           replaced: inventing plausible-looking sensor data is the same
           fabrication this screen is being held to account for, just with
           better formatting. -->
      <div class="habitat-backdrop">
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
      <BentoGrid items={WEATHER_CLUSTER} radius={60} />
    {/snippet}
    {#snippet species()}
      <BentoGrid items={SPECIES_ROW} radius={60} />
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
    /* Layered radial gradients standing in for canopy/rock depth cues from a
       real photo -- a broad dusk-light falloff, two darker off-center blobs,
       and two soft warm blobs standing in for dappled sunlight breaking
       through canopy (the cue that reads as "real photo" rather than "flat
       vignette" in daylight forest shots). */
    background:
      radial-gradient(18% 14% at 28% 22%, rgb(214 198 120 / 0.16) 0%, transparent 70%),
      radial-gradient(14% 10% at 68% 38%, rgb(214 198 120 / 0.1) 0%, transparent 70%),
      radial-gradient(60% 45% at 20% 85%, rgb(10 20 15 / 0.55) 0%, transparent 70%),
      radial-gradient(50% 40% at 85% 75%, rgb(6 14 10 / 0.5) 0%, transparent 70%),
      radial-gradient(120% 90% at 50% 10%, #2f4a3d 0%, #16241d 60%, #0b120e 100%);
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
