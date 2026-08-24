<script lang="ts">
  import LabelLine from "../LabelLine.svelte";

  interface Props {
    /** Which side to align the stack's pills to -- matches whichever edge ScreenFrame docked this label to (left in portrait, right in landscape). Figma's own desktop label stack is right-aligned (every line shares the same right edge), not left-aligned like mobile -- verified directly against both frames' real instance x-offsets. */
    align?: "left" | "right";
  }

  let { align = "left" }: Props = $props();
</script>

<!--
  Real "Test: Label Stack (Dein Habitat)" content from Figma: 3 separate
  Label Line instances stacked with zero gap (their y-offsets are exactly
  flush in both Frame 1 and Frame 1 Desktop) -- "Dein Habitat" stays a
  fully-rounded standalone pill (default corners), while "AUWALD"'s
  top-left is "none" so it merges seamlessly with "PERUANISCHER" directly
  above it (real corner override read off the Auwald instance).

  The dark forest-green fill on "PERUANISCHER"/"AUWALD" is NOT a
  per-frame constant -- get_variable_defs on this exact node (25556:657,
  nested inside Frame 1 MOBILE) resolves only the default text/primary +
  label/fill bindings, the same pair the plain "Dein Habitat" pill uses;
  the real mobile composite (get_screenshot on Frame 1 Mobile) shows a
  plain light pill for all three lines. The dark-green fill only appears
  on the equivalent DESKTOP instance (25556:1235, inside Frame 1
  Desktop) -- and even there get_variable_defs reports no bound variable
  for it either, meaning Figma itself applies it as a one-off literal
  override on that single instance, not a token. So "forest-green" is
  reproduced only for the landscape/desktop dock (align: "right",
  ScreenFrame's own portrait/landscape test) -- applying it to the
  portrait/mobile dock too (align: "left") was checked against the wrong
  frame and put a green pill where Figma's real mobile layout has none.
-->
<div class="habitat-label-stack" style:align-items={align === "left" ? "flex-start" : "flex-end"}>
  <!-- fontWeight=300: Sora Light, verified via get_design_context on the real
       "Dein Habitat" instance (25556:1236) -- see LabelLine's own comment on
       why this is a raw literal weight rather than a token. The headline
       lines below keep LabelLine's default (--weight-heading/Bold), their
       own real Figma binding. -->
  <LabelLine text="Dein Habitat" fontSize={34} fontWeight={300} />
  <LabelLine text="PERUANISCHER" fontSize={60} accent={align === "right" ? "forest-green" : "default"} />
  <LabelLine text="AUWALD" fontSize={60} accent={align === "right" ? "forest-green" : "default"} corners={["none", "convex", "convex", "convex"]} />
</div>

<style>
  .habitat-label-stack {
    display: flex;
    flex-direction: column;
  }
</style>
