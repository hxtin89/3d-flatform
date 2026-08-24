<script lang="ts">
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import { Tween } from "svelte/motion";
  import { cubicOut } from "svelte/easing";
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
    /** kind: "species" only, below. Seeds which one starts selected -- after mount, selection is owned by BentoGrid itself (exclusive, animated), not this prop. */
    selected?: boolean;
    /** Opts this item into click-to-expand. Only one selectable item in the grid is ever expanded at a time -- selecting one animates any other back to collapsed. */
    selectable?: boolean;
    /** Height to animate to when selected. `height` itself is the collapsed height; the grow/shrink keeps the item's bottom edge (y + height) fixed and moves the top edge up, per the documented BentoWidget growth choreography (fixed card height, explicit grow-by-a-grid-multiple step) adapted to grow up instead of down since these sit at a row's bottom edge. Defaults to `height` (no-op) if unset. */
    expandedHeight?: number;
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

  const EXPAND_DURATION_MS = 400;

  // `items` is treated as a fixed initial dataset here -- selection state and
  // the tweens below are deliberately seeded ONCE and then owned by BentoGrid
  // itself, not re-derived if the caller ever passes a new `items` array.
  // `untrack` marks that as intentional (not "forgot to make this reactive").
  let selectedId: string | null = $state(untrack(() => items.find((item) => item.selectable && item.selected)?.id ?? null));

  // One Tween per selectable item, created once (not reactively -- creating a
  // new tween on every derive would restart any in-flight animation).
  // Non-selectable items never need one; their height is static.
  const heightTweens = new Map<string, Tween<number>>();
  for (const item of untrack(() => items)) {
    if (item.selectable) heightTweens.set(item.id, new Tween(item.selected ? (item.expandedHeight ?? item.height) : item.height, { duration: EXPAND_DURATION_MS, easing: cubicOut }));
  }

  $effect(() => {
    for (const item of items) {
      heightTweens.get(item.id)?.set(selectedId === item.id ? (item.expandedHeight ?? item.height) : item.height);
    }
  });

  function select(item: BentoGridItem) {
    selectedId = selectedId === item.id ? null : item.id;
  }

  // Effective (possibly mid-animation) rects -- solveDocking and silhouette()
  // both react to these every tween tick, so corners and the card shape stay
  // consistent with each other throughout the expand/collapse motion.
  const effectiveItems = $derived(
    items.map((item) => {
      const tween = heightTweens.get(item.id);
      if (!tween) return item;
      const height = tween.current;
      return { ...item, y: item.y + item.height - height, height };
    }),
  );

  const solved = $derived(solveDocking(effectiveItems));
  const bounds = $derived({
    width: Math.max(...items.map((item) => item.x + item.width)),
    height: Math.max(...items.map((item) => item.y + item.height)),
  });
</script>

<div class="bento-grid" style:width="{bounds.width}px" style:height="{bounds.height}px">
  {#each effectiveItems as item, i (item.id)}
    {@const result = solved[i]}
    <div class="bento-grid__cell" style:left="{item.x}px" style:top="{item.y}px" style:--cell-enter-delay="{i * 70}ms">
      {#if item.kind === "species"}
        <SpeciesWidget
          path={silhouette(item.width, item.height, result.corners, radius)}
          width={item.width}
          height={item.height}
          corners={result.corners}
          {radius}
          title={item.title}
          description={item.description}
          selected={selectedId === item.id}
          selectable={item.selectable}
          onSelect={() => select(item)}
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
    /* Staggered rise-and-fade on first mount (index-driven delay set inline
       above) -- the static grid otherwise just appears fully-formed, which
       reads flat next to reference sites that reveal their cards on scroll.
       `both` holds the from-state through the delay so cards don't flash
       visible before their turn, and holds the to-state after so a later
       reactive re-render (e.g. the height Tween driving expand/collapse)
       never replays this -- keyed #each keeps the same DOM node throughout. */
    animation: bento-cell-enter 560ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: var(--cell-enter-delay, 0ms);
  }

  @keyframes bento-cell-enter {
    from {
      opacity: 0;
      transform: translateY(24px) scale(0.97);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .bento-grid__cell {
      animation: none;
    }
  }
</style>
