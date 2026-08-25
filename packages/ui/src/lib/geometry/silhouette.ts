// Ported from the Figma Corner component set (design-system/docs/components/Corner.doc.json).
// Each corner is either a plain arc (Convex/None) staying within the widget's own
// w x h box, or a "loop" that departs the sharp vertex, swings out through 1-2
// reach points beyond the box, and returns to the vertex before the path resumes
// its edge -- this matches Figma's boolean-built Corner atoms, which are a
// separate overlay reaching past the widget's own boundary, not a plain radius.
//
// Convex: standard rounded corner, arc center = the inset point (r,r) from the vertex.
// Concave: the SAME two arc endpoints as Convex, but the arc's other valid center
//   (there are always exactly two circles of radius r through 2 points 90 deg apart)
//   is the vertex itself, and the loop swings through the diagonal reach points --
//   this fillets a REFLEX vertex (3+ widgets meeting around a missing quadrant),
//   bulging this widget's material out to meet the gap.
// Fill-Left / Fill-Top: reach past ONE edge only (horizontal or vertical), staying
//   flush on the other -- used to bridge one widget's corner toward an adjacent
//   narrower/offset widget. Fill-Left always reaches away from the shape
//   horizontally (left at TL/BL, right at TR/BR); Fill-Top always reaches away
//   vertically (up at TL/TR, down at BL/BR) -- the direction is a function of
//   which corner it's applied to, not the type name alone.

export type CornerType = "convex" | "none" | "concave" | "fill-left" | "fill-top";

/** Corner order matches the Figma convention used throughout this design system: [topLeft, topRight, bottomRight, bottomLeft]. */
export type Corners = [CornerType, CornerType, CornerType, CornerType];

interface CornerResult {
  /** How far the preceding edge command should travel before this corner (0 = all the way to the sharp vertex). */
  arrivalInset: number;
  /** How far the following edge command starts from the sharp vertex (0 = starts exactly at the vertex). */
  departureInset: number;
  /** Extra path commands inserted between the arrival point and the departure point (empty for Convex/None). */
  extra: string;
}

function tl(type: CornerType, r: number): CornerResult {
  switch (type) {
    case "convex":
      return { arrivalInset: r, departureInset: r, extra: `A${r},${r} 0 0 1 ${r},0` };
    case "none":
      return { arrivalInset: 0, departureInset: 0, extra: "" };
    case "concave":
      // Loop out past the vertex into the missing quadrant (up, then left) and back.
      return { arrivalInset: 0, departureInset: 0, extra: `L0,${-r} A${r},${r} 0 0 0 ${-r},0 L0,0` };
    case "fill-left":
      // Vertical (left) edge is flush, stops early; loop reaches left; horizontal (top) edge is sharp.
      return { arrivalInset: r, departureInset: 0, extra: `A${r},${r} 0 0 0 ${-r},0 L0,0` };
    case "fill-top":
      // Horizontal (top) edge is flush, stops early; loop reaches up; vertical (left) edge is sharp.
      return { arrivalInset: 0, departureInset: r, extra: `L0,${-r} A${r},${r} 0 0 0 ${r},0` };
  }
}

function tr(type: CornerType, r: number, w: number): CornerResult {
  switch (type) {
    case "convex":
      return { arrivalInset: r, departureInset: r, extra: `A${r},${r} 0 0 1 ${w},${r}` };
    case "none":
      return { arrivalInset: 0, departureInset: 0, extra: "" };
    case "concave":
      return { arrivalInset: 0, departureInset: 0, extra: `L${w},${-r} A${r},${r} 0 0 1 ${w + r},0 L${w},0` };
    case "fill-left":
      // Horizontal (top) edge is sharp; vertical (right) edge is flush, starts late; loop reaches right.
      return { arrivalInset: 0, departureInset: r, extra: `L${w + r},0 A${r},${r} 0 0 0 ${w},${r}` };
    case "fill-top":
      // Horizontal (top) edge is flush, stops early; loop reaches up; vertical (right) edge is sharp.
      // sweep 0 puts the arc centre on (w-r,-r) -- the reach square's corner DIAGONALLY OPPOSITE the
      // vertex -- so the loop is a concave fillet (square minus disc). sweep 1 would centre it on the
      // vertex itself and add a convex quarter-disc blob instead. See tl/bl's note below.
      return { arrivalInset: r, departureInset: 0, extra: `A${r},${r} 0 0 0 ${w},${-r} L${w},0` };
  }
}

function br(type: CornerType, r: number, w: number, h: number): CornerResult {
  switch (type) {
    case "convex":
      return { arrivalInset: r, departureInset: r, extra: `A${r},${r} 0 0 1 ${w - r},${h}` };
    case "none":
      return { arrivalInset: 0, departureInset: 0, extra: "" };
    case "concave":
      return { arrivalInset: 0, departureInset: 0, extra: `L${w + r},${h} A${r},${r} 0 0 1 ${w},${h + r} L${w},${h}` };
    case "fill-left":
      // Vertical (right) edge is flush, stops early; loop reaches right; horizontal (bottom) edge is sharp.
      return { arrivalInset: r, departureInset: 0, extra: `A${r},${r} 0 0 0 ${w + r},${h} L${w},${h}` };
    case "fill-top":
      // Horizontal (bottom) edge is flush, starts late; loop reaches down; vertical (right) edge is sharp.
      return { arrivalInset: 0, departureInset: r, extra: `L${w},${h + r} A${r},${r} 0 0 0 ${w - r},${h}` };
  }
}

function bl(type: CornerType, r: number, h: number): CornerResult {
  switch (type) {
    case "convex":
      return { arrivalInset: r, departureInset: r, extra: `A${r},${r} 0 0 1 0,${h - r}` };
    case "none":
      return { arrivalInset: 0, departureInset: 0, extra: "" };
    case "concave":
      return { arrivalInset: 0, departureInset: 0, extra: `L0,${h + r} A${r},${r} 0 0 1 ${-r},${h} L0,${h}` };
    case "fill-left":
      // Horizontal (bottom) edge is sharp; vertical (left) edge is flush, starts late; loop reaches left.
      return { arrivalInset: 0, departureInset: r, extra: `L${-r},${h} A${r},${r} 0 0 0 0,${h - r}` };
    case "fill-top":
      // Horizontal (bottom) edge is flush, stops early; loop reaches down; vertical (left) edge is sharp.
      // sweep 0 -> centre (r,h+r), the reach square's corner diagonally opposite the vertex, giving the
      // concave fillet every other Fill-* case already produced. This was `1`, which centres the arc on
      // the vertex (0,h) and renders a convex quarter-disc bulge -- the exact opposite curvature.
      // Measured against Figma's own "AUWALD" line (25556:682): its bottom-left fillet traces a circle
      // centred at (90,1175) in Frame 1 Mobile page space, i.e. (r, h+r), not the vertex (60,1145).
      return { arrivalInset: r, departureInset: 0, extra: `A${r},${r} 0 0 0 0,${h + r} L0,${h}` };
  }
}

/**
 * Builds an SVG path `d` for a rounded rect with independent per-corner treatments.
 * (w, h, corners[4], r) -> path d. Concave/Fill-* corners reach past the nominal
 * w x h box -- pair with cornerOverflow() to size the consuming SVG so nothing clips.
 */
export function silhouette(w: number, h: number, corners: Corners, r: number): string {
  const [tlType, trType, brType, blType] = corners;
  const c1 = tl(tlType, r);
  const c2 = tr(trType, r, w);
  const c3 = br(brType, r, w, h);
  const c4 = bl(blType, r, h);

  return [
    `M${c1.departureInset},0`,
    `H${w - c2.arrivalInset}`,
    c2.extra,
    `V${h - c3.arrivalInset}`,
    c3.extra,
    `H${c4.arrivalInset}`,
    c4.extra,
    `V${c1.arrivalInset}`,
    c1.extra,
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}

/** How far a silhouette's Concave/Fill-* corners reach past the nominal w x h box, per side. */
export function cornerOverflow(corners: Corners, r: number): { left: number; top: number; right: number; bottom: number } {
  const [tlType, trType, brType, blType] = corners;
  let left = 0, top = 0, right = 0, bottom = 0;

  if (tlType === "concave" || tlType === "fill-left") left = Math.max(left, r);
  if (tlType === "concave" || tlType === "fill-top") top = Math.max(top, r);
  if (trType === "concave" || trType === "fill-left") right = Math.max(right, r);
  if (trType === "concave" || trType === "fill-top") top = Math.max(top, r);
  if (brType === "concave" || brType === "fill-left") right = Math.max(right, r);
  if (brType === "concave" || brType === "fill-top") bottom = Math.max(bottom, r);
  if (blType === "concave" || blType === "fill-left") left = Math.max(left, r);
  if (blType === "concave" || blType === "fill-top") bottom = Math.max(bottom, r);

  return { left, top, right, bottom };
}
