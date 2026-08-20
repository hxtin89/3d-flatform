<script lang="ts">
  import { silhouette, type Corners } from "./geometry/silhouette";

  interface Props {
    text: string;
    fontSize?: number;
    corners?: Corners;
    accent?: string;
    /** Corner radius in px — defaults to the label/pill token (30). */
    radius?: number;
    /** Called whenever this line's resolved (width, height) changes, so a parent stack can position the next line flush beneath it. */
    onResize?: (size: { width: number; height: number }) => void;
  }

  let {
    text,
    fontSize = 34,
    corners = ["convex", "convex", "convex", "convex"],
    accent = "default",
    radius = 30,
    onResize,
  }: Props = $props();

  const PADDING_X = 24;

  let textWidth = $state(0);
  const height = $derived(Math.ceil(fontSize * 1.2) + 12);
  const width = $derived(textWidth + PADDING_X * 2);
  const path = $derived(silhouette(width, height, corners, radius));

  $effect(() => {
    onResize?.({ width, height });
  });
</script>

<div class="label-line" data-accent={accent} style:width="{width}px" style:height="{height}px">
  <svg class="label-line__silhouette" viewBox="0 0 {width} {height}" width={width} height={height} aria-hidden="true">
    <path d={path} class="label-line__fill" />
  </svg>
  <span class="label-line__text" style:font-size="{fontSize}px" bind:clientWidth={textWidth}>{text}</span>
</div>

<style>
  .label-line {
    position: relative;
    display: inline-block;
  }

  .label-line__silhouette {
    position: absolute;
    inset: 0;
    z-index: 0;
  }

  .label-line__fill {
    fill: var(--label-fill);
  }

  .label-line__text {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    height: 100%;
    padding: 0 24px;
    white-space: nowrap;
    font-family: var(--family-sans);
    font-weight: var(--weight-heading);
    color: var(--text-primary);
    box-sizing: border-box;
  }
</style>
