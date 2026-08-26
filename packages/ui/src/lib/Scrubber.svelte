<script lang="ts">
  interface Props {
    /** 0..1. Figma's reference split is 152 of a 516 total track, i.e.
        152/516 -- kept as that fraction rather than a rounded 0.3 so a
        pixel-measured Figma frame and this default agree exactly. */
    progress?: number;
    /** Sets data-accent -- resolves --accent-fill the same way every other
        widget in this library does (widget-accent.css). */
    accent?: string;
  }

  let { progress = 152 / 516, accent = "default" }: Props = $props();

  // Figma's 152/516 is a fixed-pixel measurement of one specific track
  // width; this component has no fixed width at all (it's told to fill
  // whatever container it's dropped into), so the split has to be expressed
  // as a percentage of elapsed and a flex-grow remainder rather than two
  // pixel widths -- flex-grow on Remaining means it always exactly fills
  // whatever's left, with no rounding gap at the far end.
  const clamped = $derived(Math.min(1, Math.max(0, progress)));
</script>

<div class="scrubber" data-accent={accent} role="progressbar" aria-valuenow={Math.round(clamped * 100)} aria-valuemin={0} aria-valuemax={100}>
  <div class="scrubber__elapsed" style:width="{clamped * 100}%"></div>
  <div class="scrubber__remaining"></div>
</div>

<style>
  .scrubber {
    display: flex;
    width: 100%;
    height: 10px;
    /* Figma's reference has no radius on this bar -- square ends, unlike
       the pill-shaped controls elsewhere in this library. */
    border-radius: 0;
    overflow: hidden;
  }

  .scrubber__elapsed {
    background: var(--accent-fill);
    height: 100%;
  }

  .scrubber__remaining {
    flex: 1 0 0;
    height: 100%;
    background: color-mix(in srgb, var(--accent-fill) 50%, transparent);
  }
</style>
