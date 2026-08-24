<script lang="ts">
  import ScreenFrame from "./ScreenFrame.svelte";
  import BentoGrid from "../BentoGrid.svelte";
  import LabelLine from "../LabelLine.svelte";
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
      <div
        style="position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 10%, #2f4a3d 0%, #16241d 60%, #0b120e 100%);"
      ></div>
    {/snippet}
    {#snippet weather()}
      <BentoGrid items={WEATHER_CLUSTER} radius={60} />
    {/snippet}
    {#snippet species()}
      <BentoGrid items={SPECIES_ROW} radius={60} />
    {/snippet}
    {#snippet label()}
      <LabelLine text="Dein Habitat" fontSize={34} accent="forest-green" />
    {/snippet}
  </ScreenFrame>
</div>
