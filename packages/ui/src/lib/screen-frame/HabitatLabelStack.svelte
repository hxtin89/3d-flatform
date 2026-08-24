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
-->
<div class="habitat-label-stack" style:align-items={align === "left" ? "flex-start" : "flex-end"}>
  <LabelLine text="Dein Habitat" fontSize={34} />
  <LabelLine text="PERUANISCHER" fontSize={60} accent="forest-green" />
  <LabelLine text="AUWALD" fontSize={60} accent="forest-green" corners={["none", "convex", "convex", "convex"]} />
</div>

<style>
  .habitat-label-stack {
    display: flex;
    flex-direction: column;
  }
</style>
