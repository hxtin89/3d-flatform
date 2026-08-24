<script lang="ts">
  import type { Snippet } from "svelte";
  import BentoWidget from "./BentoWidget.svelte";
  import SpeciesWidget from "./SpeciesWidget.svelte";
  import { solveDocking, type GridWidget } from "./geometry/docking";
  import { silhouette } from "./geometry/silhouette";

  /** A grid rect plus the content BentoWidget (or SpeciesWidget, when kind: "species") needs to render it. */
  export interface BentoGridItem extends GridWidget {
    title?: string;
    value?: string;
    description?: string;
    accent?: string;
    icon?: Snippet;
    hasImage?: boolean;
    imageSrc?: string;
    /** Renders as SpeciesWidget instead of BentoWidget -- see that component for its distinct selected/unselected design. Defaults to "bento". */
    kind?: "bento" | "species";
    /** kind: "species" only -- see SpeciesWidget's props for what each does. */
    selected?: boolean;
    measurement?: string;
    status?: string;
    caption?: string;
    image?: Snippet;
  }

  interface Props {
    /** Plain rects (position/size/optional per-corner overrides) -- corner treatments are solved from adjacency, not specified here. */
    items: BentoGridItem[];
    /** Corner radius for every widget in the grid -- matches the Corner atom's own Large/Small sizing (60 default). */
    radius?: number;
  }

  let { items, radius = 60 }: Props = $props();

  const solved = $derived(solveDocking(items));
  const bounds = $derived({
    width: Math.max(...items.map((item) => item.x + item.width)),
    height: Math.max(...items.map((item) => item.y + item.height)),
  });
</script>

<div class="bento-grid" style:width="{bounds.width}px" style:height="{bounds.height}px">
  {#each items as item, i (item.id)}
    {@const result = solved[i]}
    <div class="bento-grid__cell" style:left="{item.x}px" style:top="{item.y}px">
      {#if item.kind === "species"}
        <SpeciesWidget
          path={silhouette(item.width, item.height, result.corners, radius)}
          width={item.width}
          height={item.height}
          corners={result.corners}
          {radius}
          title={item.title}
          description={item.description}
          selected={item.selected}
          measurement={item.measurement}
          status={item.status}
          caption={item.caption}
          icon={item.icon}
          image={item.image}
          accent={item.accent}
        />
      {:else}
        <BentoWidget
          path={silhouette(item.width, item.height, result.corners, radius)}
          width={item.width}
          height={item.height}
          corners={result.corners}
          {radius}
          title={item.title}
          value={item.value}
          description={item.description}
          icon={item.icon}
          hasImage={item.hasImage}
          imageSrc={item.imageSrc}
          accent={item.accent}
        />
      {/if}
    </div>
  {/each}
</div>

<style>
  .bento-grid {
    position: relative;
  }

  .bento-grid__cell {
    position: absolute;
  }
</style>
