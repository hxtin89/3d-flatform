<script lang="ts">
  import LabelLine from "../LabelLine.svelte";
  import type { Corners, CornerType } from "../geometry/silhouette";

  interface Props {
    /**
     * Which side to align the stack's pills to. This is NOT symmetric decoration: the anchor side
     * is the flush edge every line shares, and it also decides the two end caps' corner treatment
     * (see stackCorners below -- mobile's left-anchored stack fillets INTO the frame margin at top
     * and bottom, desktop's right-anchored one does not). Verified directly against both frames'
     * real instance x-offsets.
     *
     * ScreenFrame now always passes "left": the stack uses Figma's mobile placement in every
     * arrangement, docked at the window's left edge, so the right-anchored variant no longer has a
     * caller inside the frame. It stays because Figma's Frame 1 Desktop genuinely authors it that
     * way and MediaScreenExample still renders both variants side by side to document the
     * difference -- deleting it would delete the only record of what the desktop reference looks
     * like, and it is 4 lines of a function that has to exist for "left" anyway.
     */
    align?: "left" | "right";
  }

  let { align = "left" }: Props = $props();

  // fontWeight=300: Sora Light, verified via get_design_context on the real "Dein Habitat"
  // instance (25556:1236) -- see LabelLine's own comment on why this is a raw literal weight
  // rather than a token. The headline lines below keep LabelLine's default (--weight-heading/Bold).
  const LINES: { text: string; fontSize: number; fontWeight?: number }[] = [
    { text: "Dein Habitat", fontSize: 34, fontWeight: 300 },
    { text: "PERUANISCHER", fontSize: 60 },
    { text: "AUWALD", fontSize: 60 },
  ];

  // Measured width of each line, filled in as each LabelLine mounts/resizes (see onResize below) --
  // starts at 0 so the very first paint solves corners as if all 3 lines were equal-width (all
  // "none"), then snaps to the real notched shape a frame later once text has actually laid out.
  let widths = $state<number[]>(LINES.map(() => 0));

  /**
   * Solves each line's corner treatment from its measured width vs. its immediate vertical
   * neighbors, so the 3 stacked pills read as ONE continuous notched blob (Figma's real "Test:
   * Label Stack" node 25556:657/1235) instead of 3 separate chips with a gap between them.
   *
   * Re-derived by measuring Figma's actual rasterised frames pixel-by-pixel (full-frame PNG export
   * of 25547:2424 / 25556:1097, boundary traced per scanline and circle-fitted), because the earlier
   * reading of the instances' radius metadata missed the Corner ATOMS layered on top of them: this
   * stack's seams are not plain rounded/sharp corners at all, they are Fill-Left and Fill-Top
   * fillets that reach PAST each line's own box. Two distinct things were wrong:
   *
   * 1. FREE SIDE, where a line meets a WIDER neighbor. This used to emit "none" (a hard 90deg inner
   *    corner). Figma emits "fill-left": the narrower line's free edge sweeps OUT past itself by r
   *    and lands tangent on the wider line's edge, so the step between the two reads as one smooth
   *    S rather than a stair. Confirmed on all four such seams -- mobile "Dein Habitat" bottom-right
   *    (arc centred (354,947) in page space) and "AUWALD" top-right (centre (420,1091)), and their
   *    desktop mirrors "Dein Habitat" bottom-left (centre (1560,657)) and "AUWALD" top-left
   *    (centre (1494,801)). All four fit r=30 to within antialiasing.
   *
   * 2. ANCHOR SIDE CAPS, i.e. the two corners that close the stack at its very top and very bottom
   *    on the shared edge. Mobile's stack sits flush against the screen frame's left margin and
   *    fillets INTO it with Fill-Top at both caps -- the light fill visibly bulges up past the top
   *    edge (arc centre (90,894)) and down past the bottom edge (centre (90,1175)). Desktop's stack
   *    is flush against the right margin but is authored WITHOUT those fillets: scanning the rows
   *    just above y=634 and just below y=855 finds no fill left of x=1854 at all, so both caps are
   *    plain "none" there. Not symmetric, but that is what the reference renders, hence the
   *    align-dependent cap below rather than one shared rule.
   *
   * The anchor side BETWEEN lines stays "none" in both frames: tracing the shared edge top-to-bottom
   * finds no bite taken out of it anywhere, so nothing is rounded at those interior seams.
   *
   * NOT solved via geometry/docking.ts's solveDocking: that generic prober is tuned for widgets
   * that can differ in extent on BOTH axes. Here every line shares the exact same anchor-side
   * x-coordinate (zero difference, not just "adjacent"), which is a degenerate case its 1px
   * corner probes mishandle -- traced by hand against this exact shape, it wrongly returns
   * "convex" for the anchor-side corners between lines instead of the "none" Figma actually uses.
   */
  function stackCorners(lineWidths: number[], anchor: "left" | "right"): Corners[] {
    const last = lineWidths.length - 1;
    // A free-side corner only rounds where this line's own edge is the outermost one: convex at a
    // true exterior corner, fill-left where the neighbor overhangs it, none where they end flush.
    const free = (neighbor: number | undefined, w: number): CornerType =>
      neighbor === undefined || neighbor < w ? "convex" : neighbor > w ? "fill-left" : "none";

    return lineWidths.map((w, i) => {
      const freeTop = free(i > 0 ? lineWidths[i - 1] : undefined, w);
      const freeBottom = free(i < last ? lineWidths[i + 1] : undefined, w);
      const capTop: CornerType = anchor === "left" && i === 0 ? "fill-top" : "none";
      const capBottom: CornerType = anchor === "left" && i === last ? "fill-top" : "none";
      // Corners order is [topLeft, topRight, bottomRight, bottomLeft] (geometry/silhouette.ts).
      return anchor === "left"
        ? [capTop, freeTop, freeBottom, capBottom]
        : [freeTop, capTop, capBottom, freeBottom];
    });
  }

  const corners = $derived(stackCorners(widths, align));
</script>

<!--
  Real "Test: Label Stack (Dein Habitat)" content from Figma: 3 separate Label Line instances
  stacked with zero gap (their y-offsets are exactly flush in both Frame 1 and Frame 1 Desktop),
  each corner-solved by stackCorners() above so the flush, matching-fill edges read as one
  continuous blob. No shadow anywhere (shadow={false}, and none on the wrapper either) -- Figma's
  own frames have none, and a shadow across flush-stacked lines reads as separate floating chips
  rather than the single continuous blob the real design is.

  Both real instances (mobile 25556:657 and desktop 25556:1235) bind the same plain
  text/primary + label/fill pair -- a light pill with dark text, same as every other card in the
  grid. There is no dark forest-green fill anywhere in either frame; get_screenshot on both
  confirms a light pill + dark text for all three lines on both mobile and desktop.
-->
<div class="habitat-label-stack" style:align-items={align === "left" ? "flex-start" : "flex-end"}>
  {#each LINES as line, i}
    <LabelLine
      text={line.text}
      fontSize={line.fontSize}
      fontWeight={line.fontWeight ?? "var(--weight-heading)"}
      corners={corners[i]}
      shadow={false}
      onResize={({ width }) => (widths[i] = width)}
    />
  {/each}
</div>

<style>
  .habitat-label-stack {
    display: flex;
    flex-direction: column;
  }
</style>
