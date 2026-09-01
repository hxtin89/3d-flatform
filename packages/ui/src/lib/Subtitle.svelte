<script lang="ts">
  import LabelLine from "./LabelLine.svelte";
  import { stackCorners, wrapToWidth } from "./geometry/label-stack";

  interface Props {
    /** Running copy as ONE string. Newlines are honoured as hard breaks; everything else wraps. */
    text: string;
    /** Width cap for a single pill. Lines break to stay under it; a longer single word still overruns. */
    maxWidth?: number;
    /** Figma's size/heading/xl. 48 rather than the 34 this started at: measured on a
        390pt viewport the 34 landed at 12.3 CSS px, which is not reading size for
        running copy -- 48 puts it at 17.3, level with the label stacks. */
    fontSize?: number;
    /** Sora weight. Body copy is Regular (400) -- LabelLine defaults to Bold, which is the headline face. */
    fontWeight?: number | string;
    /** The flush edge every line shares; also decides the two end caps (see stackCorners). */
    align?: "left" | "right";
    radius?: number;
  }

  let {
    text,
    maxWidth = 1010,
    fontSize = 48,
    fontWeight = 400,
    align = "left",
    radius = 30,
  }: Props = $props();

  // Measured off a hidden copy of LabelLine's own text box rather than a canvas
  // measureText: the pill's width is whatever the real span lays out to, and a
  // canvas measurement of the same string lands a few px off (font synthesis,
  // letter-spacing, subpixel rounding) -- enough to break a line one word early.
  // The ruler carries the SAME padding token as LabelLine's span, so what it
  // reports IS the pill width, no arithmetic in between.
  let ruler = $state<HTMLSpanElement>();
  let lines = $state<string[]>([]);
  let widths = $state<number[]>([]);

  $effect(() => {
    // Read every input up front so the effect re-runs when any of them changes.
    const source = text;
    const cap = maxWidth;
    const size = fontSize;
    const weight = fontWeight;
    const el = ruler;
    if (!el) return;

    let cancelled = false;
    const remeasure = () => {
      if (cancelled) return;
      // The ruler has to be boosted exactly like the real pills, or lines break at
      // the authored size and then render wider than the cap.
      el.style.fontSize = `calc(${size}px * var(--screen-frame-type-boost, 1))`;
      el.style.fontWeight = String(weight);
      lines = wrapToWidth(source, (line) => {
        el.textContent = line;
        return el.offsetWidth;
      }, cap);
      el.textContent = "";
    };

    remeasure();
    // Sora is a webfont: the first measurement can run against the fallback face,
    // whose metrics break the paragraph in the wrong places. Re-run once it lands.
    document.fonts?.ready.then(remeasure);
    return () => {
      cancelled = true;
    };
  });

  // Keep the width buffer the same length as the lines it describes -- guarded, so
  // it settles instead of looping.
  $effect(() => {
    if (widths.length !== lines.length) widths = new Array(lines.length).fill(0);
  });

  const corners = $derived(stackCorners(widths, align, radius));
</script>

<div class="subtitle" style:align-items={align === "left" ? "flex-start" : "flex-end"}>
  <span class="subtitle__ruler" bind:this={ruler} aria-hidden="true"></span>
  {#each lines as line, i (i)}
    <LabelLine
      text={line}
      {fontSize}
      {fontWeight}
      {radius}
      corners={corners[i] ?? ["none", "none", "none", "none"]}
      shadow={false}
      onResize={({ width }) => (widths[i] = width)}
    />
  {/each}
</div>

<style>
  .subtitle {
    display: flex;
    flex-direction: column;
  }

  /* Same seam fix as HabitatLabelStack: each line's SVG antialiases its own bottom
     edge against whatever is behind the stack, so with lines exactly abutting that
     half-covered row is the last thing painted there and the background shows
     through it. Later siblings paint on top, so a 1px overlap covers it. */
  .subtitle :global(.label-line:not(:last-child)) {
    margin-bottom: -1px;
  }

  /* Must match LabelLine's .label-line__text metrics, or the measured width is not
     the pill width and breaks land in the wrong place. The horizontal inset is the
     same TOKEN rather than a copied number, so the two cannot drift. */
  .subtitle__ruler {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
    white-space: nowrap;
    padding: 0 var(--space-24);
    font-family: var(--family-sans);
    box-sizing: border-box;
  }
</style>
