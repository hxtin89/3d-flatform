// STUB — owned by the app, not this package. Replace with the real
// Convex/None/Concave/Fill-Left/Fill-Top crescent math ported from the Figma
// Corner component (see design-system/docs/components/Corner.doc.json).
// This placeholder only does plain per-corner rounded-rect radii so components
// render something sane before that port lands.

export type CornerType = "convex" | "none" | "concave" | "fill-left" | "fill-top";

/** Corner order matches the Figma convention used throughout this design system: [topLeft, topRight, bottomRight, bottomLeft]. */
export type Corners = [CornerType, CornerType, CornerType, CornerType];

function cornerRadius(type: CornerType, r: number): number {
  // ponytail: stub — only 'convex' rounds; everything else currently renders sharp.
  // Concave/Fill-* need the real crescent geometry, not a plain radius.
  return type === "convex" ? r : 0;
}

/**
 * Builds an SVG path `d` for a rounded rect with independent per-corner radii.
 * (w, h, corners[4], r) -> path d
 */
export function silhouette(w: number, h: number, corners: Corners, r: number): string {
  const [tl, tr, br, bl] = corners.map((c) => cornerRadius(c, r));
  return [
    `M${tl},0`,
    `H${w - tr}`,
    tr ? `A${tr},${tr} 0 0 1 ${w},${tr}` : "",
    `V${h - br}`,
    br ? `A${br},${br} 0 0 1 ${w - br},${h}` : "",
    `H${bl}`,
    bl ? `A${bl},${bl} 0 0 1 0,${h - bl}` : "",
    `V${tl}`,
    tl ? `A${tl},${tl} 0 0 1 ${tl},0` : "",
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}
