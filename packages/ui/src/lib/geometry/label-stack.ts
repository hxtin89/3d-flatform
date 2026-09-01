// Shared brain of the stacked-pill label: how a paragraph becomes lines, and how
// each line's corners follow from its width relative to its neighbours.
//
// Both halves live here rather than inside a component because they are pure and
// worth testing without a browser, and because two components need them --
// HabitatLabelStack (authored lines) and Subtitle (wrapped lines). Keeping one
// copy is what stops the two from drifting into different corner rules.
import type { CornerType, Corners } from "./silhouette";

/**
 * Greedy line-break at whitespace, using a caller-supplied width measurement.
 *
 * `measure` takes a candidate line and returns the width the PILL would have for
 * it, padding included -- not the bare text width. The caller owns that because
 * only it knows the real rendered metrics; passing a canvas/`measureText` guess
 * instead of the live element is what makes breaks land a word early or late.
 *
 * Authored newlines survive as hard breaks, so copy can still force a line where
 * the design needs one (the Figma reference sets every line by hand).
 *
 * A single word longer than `maxWidth` is left on its own over-long line rather
 * than broken mid-word: pills hug their text, so an over-long line renders wide
 * rather than clipped, and mid-word hyphenation is a typographic decision this
 * has no business making silently.
 */
export function wrapToWidth(text: string, measure: (line: string) => number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && measure(candidate) > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * Solves each line's corner treatment from its measured width vs. its immediate
 * vertical neighbours, so stacked pills read as ONE continuous notched blob
 * rather than separate chips with a gap between them.
 *
 * Derived by measuring Figma's actual rasterised frames pixel-by-pixel (full-frame
 * PNG export of 25547:2424 / 25556:1097, boundary traced per scanline and
 * circle-fitted), because reading the instances' radius metadata alone misses the
 * Corner ATOMS layered on top of them: these seams are not plain rounded/sharp
 * corners, they are Fill-Left and Fill-Top fillets that reach PAST each line's own
 * box. Two things follow:
 *
 * 1. FREE SIDE, where a line meets a WIDER neighbour, is "fill-left", not "none":
 *    the narrower line's free edge sweeps OUT past itself by r and lands tangent on
 *    the wider line's edge, so the step reads as one smooth S rather than a stair.
 *    Confirmed on all four such seams -- mobile "Dein Habitat" bottom-right (arc
 *    centred (354,947) in page space) and "AUWALD" top-right (centre (420,1091)),
 *    and their desktop mirrors (centres (1560,657) and (1494,801)). All four fit
 *    r=30 to within antialiasing.
 *
 * 2. ANCHOR SIDE CAPS, the two corners closing the stack at its very top and
 *    bottom on the shared edge, are NOT symmetric between the frames. Mobile's
 *    stack sits flush against the frame's left margin and fillets INTO it with
 *    Fill-Top at both caps -- the fill visibly bulges past the top edge (arc centre
 *    (90,894)) and the bottom (centre (90,1175)). Desktop's is flush against the
 *    right margin and authored WITHOUT them: scanning just above y=634 and just
 *    below y=855 finds no fill left of x=1854 at all. Hence the align-dependent cap
 *    rather than one shared rule.
 *
 * The anchor side BETWEEN lines stays "none" in both frames: tracing the shared
 * edge top-to-bottom finds no bite taken out of it anywhere.
 *
 * NOT solved via docking.ts's solveDocking: that generic prober is tuned for
 * widgets that can differ on BOTH axes. Here every line shares the exact same
 * anchor-side x (zero difference, not just "adjacent"), a degenerate case its 1px
 * corner probes mishandle -- traced by hand, it wrongly returns "convex" for the
 * anchor-side corners between lines instead of the "none" Figma actually uses.
 *
 * `radius` is also the tolerance for calling two lines flush. A fillet cannot draw
 * in less than its own radius of width difference; below that it collapses into a
 * sliver that reads as a nick in the edge rather than a curve. Wrapped copy hits
 * this constantly -- two lines filled to the same cap land a pixel or two apart --
 * so near-equal is treated as equal and the free edge runs straight through.
 */
export function stackCorners(widths: number[], anchor: "left" | "right", radius = 30): Corners[] {
  const last = widths.length - 1;
  // A free-side corner only rounds where this line's own edge is the outermost
  // one: convex at a true exterior corner, fill-left where the neighbour
  // overhangs it, none where the two end flush.
  const free = (neighbor: number | undefined, w: number): CornerType => {
    if (neighbor === undefined) return "convex";
    if (Math.abs(neighbor - w) < radius) return "none";
    return neighbor < w ? "convex" : "fill-left";
  };

  return widths.map((w, i) => {
    const freeTop = free(i > 0 ? widths[i - 1] : undefined, w);
    const freeBottom = free(i < last ? widths[i + 1] : undefined, w);
    const capTop: CornerType = anchor === "left" && i === 0 ? "fill-top" : "none";
    const capBottom: CornerType = anchor === "left" && i === last ? "fill-top" : "none";
    // Corners order is [topLeft, topRight, bottomRight, bottomLeft] (silhouette.ts).
    return anchor === "left"
      ? [capTop, freeTop, freeBottom, capBottom]
      : [freeTop, capTop, capBottom, freeBottom];
  });
}
