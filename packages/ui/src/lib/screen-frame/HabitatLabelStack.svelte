<script lang="ts">
  import LabelLine from "../LabelLine.svelte";
  import { stackCorners } from "../geometry/label-stack";

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

  /* Each line's SVG antialiases its own bottom edge against whatever is behind
     the stack, so with the lines exactly abutting, that half-covered row is the
     last thing painted there and the photo shows through it -- measured as a
     rgb(166) row between pills sitting at rgb(214) and rgb(235). The lines are
     meant to read as ONE continuous surface, so the next line down overlaps by a
     pixel and paints over it. Later siblings paint on top, so the overlap covers
     rather than being covered. */
  .habitat-label-stack :global(.label-line:not(:last-child)) {
    margin-bottom: -1px;
  }

</style>
