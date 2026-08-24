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
           (no licensed photo asset in this repo) -- layered gradients plus an
           SVG feTurbulence grain give it depth instead of one flat radial-
           gradient, and the HUD readouts are fictional demo telemetry, not
           real sensor data, matching the "real content doing real work" bar
           this screen is being held to rather than actual data claims. -->
      <div class="habitat-backdrop">
        <svg class="habitat-backdrop__grain" aria-hidden="true">
          <filter id="habitat-grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise" />
            <feColorMatrix in="noise" type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#habitat-grain)" />
        </svg>
        <div class="habitat-backdrop__hud habitat-backdrop__hud--tl">
          <span class="habitat-backdrop__dot"></span>AUDIO NODE 03 · REC
        </div>
        <div class="habitat-backdrop__hud habitat-backdrop__hud--mid">24.3°C · CANOPY DICHTE 84%</div>
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
       real photo -- one broad dusk-light falloff plus two darker, off-center
       blobs so it doesn't read as a single flat vignette. */
    background:
      radial-gradient(60% 45% at 20% 85%, rgb(10 20 15 / 0.55) 0%, transparent 70%),
      radial-gradient(50% 40% at 85% 75%, rgb(6 14 10 / 0.5) 0%, transparent 70%),
      radial-gradient(120% 90% at 50% 10%, #2f4a3d 0%, #16241d 60%, #0b120e 100%);
  }

  .habitat-backdrop__grain {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0.05;
    mix-blend-mode: overlay;
    pointer-events: none;
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
    top: 46%;
    right: 6%;
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
