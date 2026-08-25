<script lang="ts">
  import LabelLine from "../LabelLine.svelte";
  import type { Corners, CornerType } from "../geometry/silhouette";

  interface Props {
    /** Which side to align the stack's pills to -- matches whichever edge ScreenFrame docked this label to (left in portrait, right in landscape). Figma's own desktop label stack is right-aligned (every line shares the same right edge), not left-aligned like mobile -- verified directly against both frames' real instance x-offsets. */
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
   * Verified directly against get_design_context's Tailwind output for all 3 real instances on
   * BOTH Frame 1 Mobile (25556:658/667/682, left-aligned) and Frame 1 Desktop (25556:1236/1237/1238,
   * right-aligned, exact mirror image) -- their native per-corner radius classes reduce to exactly
   * this rule: the ANCHOR side (whichever edge every line shares -- left on mobile, right on
   * desktop) is flat/sharp top-to-bottom with NO rounding anywhere, not even at the very top or
   * bottom of the stack. All rounding lives on the FREE side, and only where a line's free edge
   * isn't already covered by a wider neighbor immediately above/below it: convex where no neighbor
   * reaches this far out (a true exterior corner, including the very top and very bottom lines),
   * none where a wider neighbor's own edge continues flush past this point (the notch's inner
   * corner -- rounding it would carve a notch out of what's actually a flat pass-through, per the
   * Label Line component's own "CORNER DIRECTION RULES" doc on node 25556:301).
   *
   * NOT solved via geometry/docking.ts's solveDocking: that generic prober is tuned for widgets
   * that can differ in extent on BOTH axes. Here every line shares the exact same anchor-side
   * x-coordinate (zero difference, not just "adjacent"), which is a degenerate case its 1px
   * corner probes mishandle -- traced by hand against this exact shape, it wrongly returns
   * "convex" for the anchor-side corners between lines instead of the "none" Figma actually uses.
   */
  function stackCorners(lineWidths: number[], anchor: "left" | "right"): Corners[] {
    return lineWidths.map((w, i) => {
      const prev = i > 0 ? lineWidths[i - 1] : undefined;
      const next = i < lineWidths.length - 1 ? lineWidths[i + 1] : undefined;
      const freeTop: CornerType = prev === undefined || prev < w ? "convex" : "none";
      const freeBottom: CornerType = next === undefined || next < w ? "convex" : "none";
      // Corners order is [topLeft, topRight, bottomRight, bottomLeft] (geometry/silhouette.ts).
      return anchor === "left" ? ["none", freeTop, freeBottom, "none"] : [freeTop, "none", "none", freeBottom];
    });
  }

  const corners = $derived(stackCorners(widths, align));
</script>

<!--
  Real "Test: Label Stack (Dein Habitat)" content from Figma: 3 separate Label Line instances
  stacked with zero gap (their y-offsets are exactly flush in both Frame 1 and Frame 1 Desktop),
  each corner-solved by stackCorners() above so the flush, matching-fill edges read as one
  continuous blob. No per-line shadow (shadow={false}) -- one shared drop-shadow on the wrapper
  instead, so the shadow hugs the merged outline rather than throwing a seam across each line's
  neighbor (see LabelLine's `shadow` prop doc).

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
    /* Single shared shadow for the whole merged silhouette, replacing each LabelLine's own
       (now-disabled, see shadow={false} above) per-line shadow -- same values LabelLine used, so
       the stack keeps the same visual weight it had when each line drew its own copy. */
    filter: drop-shadow(0 10px 18px var(--shadow-key)) drop-shadow(0 2px 4px var(--shadow-ambient));
  }
</style>
