<script lang="ts">
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import { Tween } from "svelte/motion";
  import { backOut } from "svelte/easing";
  import BentoWidget from "./BentoWidget.svelte";
  import SpeciesWidget from "./SpeciesWidget.svelte";
  import { solveDocking, type GridWidget } from "./geometry/docking";
  import { silhouette } from "./geometry/silhouette";
  import { createLiquidField, createAccentResolver } from "./geometry/liquid-field";

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
    /** Whether this grid's own local (min-x, min-y) widget is genuinely the real app screen's top-left (gets a sharp corner there) -- see solveDocking's doc comment. Defaults to true (matches the generic/isolated docking-test layouts); real sub-compositions that sit elsewhere on the screen (the weather cluster, the species row) must pass `false`. */
    topLeftIsScreenCorner?: boolean;
    /**
     * Draw the cluster as one continuous liquid field (geometry/liquid-field.ts)
     * instead of one hand-cornered SVG silhouette per widget. Defaults on;
     * falls back to the per-widget silhouettes automatically when WebGL2 is
     * unavailable, and can be forced off here for a pure-vector render.
     */
    liquid?: boolean;
    /**
     * How far apart two widgets can be and still fuse, px -- the `k` of the
     * field's circular smooth-min, so the neck/fillet it creates is a true
     * circular arc of exactly this radius.
     *
     * 0 is a PLAIN union: outer corners rounded at `radius`, inner corners
     * left sharp. That is exactly what Figma's species row renders, and it is
     * already fully continuous under animation -- the corner *snapping* came
     * from docking.ts's discrete classifier, not from the union itself, so
     * blend 0 fixes the snapping without changing a single shape.
     *
     * Raise it toward `radius` for the metaball look: separated widgets neck
     * together before they touch, like mercury.
     *
     * Defaults to 0, because that is what reproduces Figma. Above 0 the smin
     * fillets EVERY reflex junction uniformly, which the reference does not do
     * -- Figma's outward bulges are per-corner authored Fill-Left/Fill-Top
     * atoms (drawn by the field's sdWedge, driven by cornerOverrides), not a
     * global blend. So blend is a deliberate stylistic departure, not the way
     * to reach the reference shape.
     */
    blend?: number;
  }

  let { items, radius = 60, topLeftIsScreenCorner = true, liquid = true, blend = 0 }: Props = $props();

  // cubicOut landed the expand exactly on target with no character -- a card
  // being singled out and grown is the one moment in this grid that should
  // feel like a deliberate, slightly eager response to the click, not a
  // mechanical resize. backOut's single small overshoot (~10%, no wobble)
  // reads as "playful but precise" -- neither reference site (colabs.com.au,
  // alethia.earth) uses literal spring easing (colabs is plain `ease`;
  // alethia is canvas-driven, no inspectable CSS transitions at all), so this
  // stays a restrained overshoot rather than an elastic bounce. Bumped from
  // 400ms so the overshoot has room to actually read before settling.
  const EXPAND_DURATION_MS = 480;

  // `items` is treated as a fixed initial dataset here -- selection state and
  // the tweens below are deliberately seeded ONCE and then owned by BentoGrid
  // itself, not re-derived if the caller ever passes a new `items` array.
  // `untrack` marks that as intentional (not "forgot to make this reactive").
  const initialSelectedId = untrack(() => items.find((item) => item.selectable && item.selected)?.id ?? null);
  let selectedId: string | null = $state(initialSelectedId);

  // One Tween per selectable item, created once (not reactively -- creating a
  // new tween on every derive would restart any in-flight animation).
  // Non-selectable items never need one; their height is static.
  const heightTweens = new Map<string, Tween<number>>();
  for (const item of untrack(() => items)) {
    if (item.selectable) heightTweens.set(item.id, new Tween(item.selected ? (item.expandedHeight ?? item.height) : item.height, { duration: EXPAND_DURATION_MS, easing: backOut }));
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
  //
  // cornerOverrides are a snapshot of ONE verified Figma arrangement (whichever
  // item was authored `selected: true`) -- they only describe that specific
  // geometry. The instant a different item becomes selected, every widget's
  // relative height changes and those pinned Fill/None treatments are no
  // longer known to be correct (see recreation-content.ts's doc comment), so
  // they're dropped back to solveDocking's solved default rather than kept
  // around for an arrangement they were never verified against.
  const effectiveItems = $derived(
    items.map((item) => {
      const base = selectedId === initialSelectedId ? item : { ...item, cornerOverrides: undefined };
      const tween = heightTweens.get(item.id);
      if (!tween) return base;
      const height = tween.current;
      return { ...base, y: item.y + item.height - height, height };
    }),
  );

  const solved = $derived(solveDocking(effectiveItems, topLeftIsScreenCorner));
  const bounds = $derived({
    width: Math.max(...items.map((item) => item.x + item.width)),
    height: Math.max(...items.map((item) => item.y + item.height)),
  });

  // --- liquid field -------------------------------------------------------
  //
  // One implicit surface for the whole cluster, replacing the per-widget SVG
  // silhouettes. See geometry/liquid-field.ts for why this removes the
  // corner-snapping entirely (short version: the discrete corner classifier
  // IS the discontinuity, and a filleted union field has no classifier).
  //
  // The SVG path is still computed above and still handed to each widget --
  // it stays the fallback whenever WebGL2 is unavailable, so this is additive
  // rather than a hard cutover.
  let fieldCanvas: HTMLCanvasElement | undefined = $state();
  let gridEl: HTMLDivElement | undefined = $state();
  let fieldActive = $state(false);

  // Fillets and necks reach past the widget rects, so the canvas has to be
  // bigger than the grid's own box or they'd be clipped at the edge.
  const pad = $derived(radius * 2);

  $effect(() => {
    if (!liquid || !fieldCanvas || !gridEl) return;
    const field = createLiquidField(fieldCanvas);
    if (!field) return; // no WebGL2 -> per-widget SVG fallback stays visible
    const accents = createAccentResolver(gridEl);
    fieldActive = true;

    // A render-effect (not a plain $effect) so it re-runs on every Tween tick
    // during expand/collapse, keeping the field in lockstep with the DOM
    // content layered on top of it.
    const stop = $effect.root(() => {
      $effect(() => {
        field.render(
          effectiveItems.map((item, i) => ({
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
            color: accents.resolve(item.accent ?? "default"),
            // Only the outward fill-*/concave treatments are read from here --
            // see LiquidWidget.corners for why convex/none deliberately are not.
            corners: solved[i].corners,
          })),
          { radius, blend, width: bounds.width + pad * 2, height: bounds.height + pad * 2, pad },
        );
      });
    });

    return () => {
      stop();
      accents.dispose();
      field.dispose();
      fieldActive = false;
    };
  });
</script>

<div class="bento-grid" bind:this={gridEl} style:width="{bounds.width}px" style:height="{bounds.height}px">
  {#if liquid}
    <canvas class="bento-grid__field" bind:this={fieldCanvas} style:left="{-pad}px" style:top="{-pad}px" aria-hidden="true"></canvas>
  {/if}
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
          silhouette={!fieldActive}
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
          silhouette={!fieldActive}
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

  /* Sits behind every cell's content layer. Inline left/top pull it out by
     `pad` so the fillets/necks that reach past the widget rects aren't
     clipped; width/height are set from JS in device px (see liquid-field's
     render()). */
  .bento-grid__field {
    position: absolute;
    z-index: 0;
    pointer-events: none;
  }

  .bento-grid__cell {
    position: absolute;
    /* Above the field canvas, so widget text/icons stay on top of the shape. */
    z-index: 1;
    /* Staggered rise-and-fade on first mount (index-driven delay set inline
       above) -- the static grid otherwise just appears fully-formed, which
       reads flat next to reference sites that reveal their cards on scroll.
       `both` holds the from-state through the delay so cards don't flash
       visible before their turn, and holds the to-state after so a later
       reactive re-render (e.g. the height Tween driving expand/collapse)
       never replays this -- keyed #each keeps the same DOM node throughout.
       24px/0.97 read as a barely-there settle, not a confident entrance --
       widened the travel and the starting scale dip (still landing on the
       same expo-out curve) so the reveal itself carries some of the weight
       reference sites put on bold motion instead of leaning on color alone. */
    animation: bento-cell-enter 640ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: var(--cell-enter-delay, 0ms);
  }

  @keyframes bento-cell-enter {
    from {
      opacity: 0;
      transform: translateY(40px) scale(0.92);
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
