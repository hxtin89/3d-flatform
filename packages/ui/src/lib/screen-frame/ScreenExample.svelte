<script lang="ts">
  import ScreenFrame from "./ScreenFrame.svelte";
  import BentoGrid from "../BentoGrid.svelte";
  import HabitatLabelStack from "./HabitatLabelStack.svelte";
  import { WEATHER_CLUSTER, SPECIES_ROW } from "./recreation-content";

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
           even with grain on top, so the fix is texture *and* more real-
           looking data doing work in the empty space, not just a bigger
           gradient. HUD readouts (incl. the sparkline) are fictional demo
           telemetry, not real sensor data, matching the "real content doing
           real work" bar this screen is being held to rather than actual
           data claims. -->
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
        <div class="habitat-backdrop__hud habitat-backdrop__hud--tl">
          <span class="habitat-backdrop__dot"></span>AUDIO NODE 03 · REC
        </div>
        <div class="habitat-backdrop__hud habitat-backdrop__hud--mid">
          24.3°C · CANOPY DICHTE 84%
          <svg class="habitat-backdrop__spark" viewBox="0 0 60 16" aria-hidden="true">
            <polyline points="0,12 8,10 16,11 24,6 32,8 40,3 48,5 60,2" />
          </svg>
        </div>
        <div class="habitat-backdrop__hud habitat-backdrop__hud--soil">BODENFEUCHTE 0.62 kPa</div>
        <div class="habitat-backdrop__hud habitat-backdrop__hud--wind">WIND 3.4 M/S · NW</div>
      </div>
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

  .habitat-backdrop__hud {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    /* No mono token in @wi/tokens yet -- scoped literal for this HUD-readout
       look only, same pattern SpeciesWidget uses where a token doesn't exist. */
    font: 11px/1.4 "SFMono-Regular", ui-monospace, Menlo, monospace;
    letter-spacing: 0.04em;
    color: rgb(255 255 255 / 0.75);
    background: rgb(0 0 0 / 0.25);
    border: 1px solid rgb(255 255 255 / 0.15);
    border-radius: 4px;
    pointer-events: none;
  }

  .habitat-backdrop__hud--tl {
    top: 6%;
    left: 6%;
  }

  .habitat-backdrop__hud--mid {
    /* 33%, not the old 46% -- 46% sat inside the portrait label dock's own
       vertical band (left-center, ~45-55% height) and the two tags visibly
       overlapped; 33% clears the weather cluster in both orientations
       (bottom edge ~18% portrait / ~32% desktop) while staying above the
       label band in portrait and the species row in desktop. */
    top: 33%;
    right: 6%;
  }

  /* Both sit in the open band between the weather cluster and the species
     row -- the emptiest part of the frame -- rather than stacking on top of
     the existing two tags. */
  .habitat-backdrop__hud--soil {
    top: 24%;
    left: 6%;
  }

  .habitat-backdrop__hud--wind {
    top: 38%;
    left: 40%;
  }

  .habitat-backdrop__spark {
    width: 44px;
    height: 14px;
    overflow: visible;
  }

  .habitat-backdrop__spark polyline {
    fill: none;
    stroke: #8fd6a8;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .habitat-backdrop__dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #e85d3d;
    animation: habitat-backdrop-blink 1.6s ease-in-out infinite;
  }

  @keyframes habitat-backdrop-blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.25;
    }
  }
</style>
