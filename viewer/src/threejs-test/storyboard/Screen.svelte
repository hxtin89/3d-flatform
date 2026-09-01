<script lang="ts">
  import { LabelLine, Subtitle } from "@wi/ui";
  import type { ScreenItem } from "./screens";

  interface Props {
    items: ScreenItem[];
  }
  let { items }: Props = $props();

  // Sora ships these as named styles; the tokens carry the numeric weights.
  const WEIGHT: Record<string, number> = {
    Light: 300,
    Regular: 400,
    SemiBold: 600,
    Bold: 700,
  };
</script>

<!--
  One absolutely positioned item per Figma node, at literal frame coordinates.
  This sits inside ScreenFrame's stage, which supplies the scale, so nothing here
  multiplies by a content scale -- doing so would scale twice.
-->
{#each items as item, i (i)}
  <div class="screen__item" style:left="{item.x}px" style:top="{item.y}px">
    {#if item.kind === "label"}
      <LabelLine
        text={item.text}
        fontSize={item.size}
        fontWeight={WEIGHT[item.style] ?? 400}
        corners={item.corners}
        radius={item.radius}
        shadow={false}
      />
    {:else if item.kind === "subtitle"}
      <Subtitle text={item.text} fontSize={item.size} maxWidth={item.maxWidth} />
    {:else if item.kind === "loading"}
      <!-- No LoadingBar component exists in @wi/ui yet; Figma's is a Label Line
           pill with a progress fill behind its text. Rendered here from the same
           parts so the screen is not missing its subject, and replaced the moment
           the real component lands. -->
      <div class="screen__loading" style:width="{item.width}px">
        <div class="screen__loading-fill" style:width="{item.progress * 100}%"></div>
        <span class="screen__loading-text">{item.text}</span>
      </div>
    {/if}
  </div>
{/each}

<style>
  .screen__item {
    position: absolute;
  }

  .screen__loading {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 90px;
    border-radius: 60px;
    background: var(--bg-muted, #e0e0e0);
    overflow: hidden;
  }

  .screen__loading-fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 60px;
    background: var(--accent-fill, #e6ce00);
  }

  .screen__loading-text {
    position: relative;
    font: 700 60px/1.2 var(--family-sans, sans-serif);
    color: var(--text-primary, #333);
  }
</style>
