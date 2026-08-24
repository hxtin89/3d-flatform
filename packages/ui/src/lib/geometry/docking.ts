// Ported from the rules documented on the Figma Bento Widget / Corner component set
// (design-system/docs/components/BentoWidget.doc.json, Corner.doc.json).
//
// What's solved automatically (deterministic from rectangle adjacency alone):
//   - Convex: a corner with no neighbor in either perpendicular direction -- a true
//     exterior corner.
//   - Concave: a corner with a neighbor in BOTH perpendicular directions but NOT in
//     the diagonal cell -- the classic "3 widgets meet around a missing quadrant"
//     reflex point.
//   - None: the Convex corner that sits at the whole composition's own top-left
//     (composition top-left rule) gets a sharp corner instead of rounded.
//
// What's NOT solved automatically: Fill-Left/Fill-Top. A corner with exactly one
// perpendicular neighbor is a plain T-junction, and the docs are explicit that this
// is a designer's call, not a derivable fact -- "a single one-sided bulge against a
// plain neighbor is also valid" and "mixed exterior-corner styles are valid" (see
// BentoWidget.doc.json referenceLayouts). Guessing Fill vs Convex here would be
// actively misleading, so those T-junction corners resolve to Convex by default;
// pin `cornerOverrides` on a widget where you want a Fill treatment instead.

import type { CornerType, Corners } from "./silhouette";

export interface GridWidget {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pin a corner to an explicit treatment (typically Fill-Left/Fill-Top at a T-junction) rather than the solved default. */
  cornerOverrides?: Partial<{
    topLeft: CornerType;
    topRight: CornerType;
    bottomRight: CornerType;
    bottomLeft: CornerType;
  }>;
}

export interface DockingResult {
  id: string;
  corners: Corners;
  width: number;
  height: number;
}

/** Tolerance, in px, for "does a probe point land inside this widget" -- absorbs sub-pixel rounding from upstream layout math. */
const EPS = 0.5;
/** How far inside a candidate neighbor's area to probe, relative to the corner point. */
const PROBE = 1;

function widgetAt(widgets: GridWidget[], x: number, y: number, excludeId: string): GridWidget | undefined {
  return widgets.find(
    (w) => w.id !== excludeId && x > w.x - EPS && x < w.x + w.width + EPS && y > w.y - EPS && y < w.y + w.height + EPS,
  );
}

function contains(w: GridWidget, x: number, y: number): boolean {
  return x > w.x - EPS && x < w.x + w.width + EPS && y > w.y - EPS && y < w.y + w.height + EPS;
}

function solveCorner(
  widgets: GridWidget[],
  widget: GridWidget,
  hProbeX: number,
  vProbeY: number,
  hSign: 1 | -1,
  vSign: 1 | -1,
): CornerType {
  const hNeighbor = widgetAt(widgets, hProbeX + hSign * PROBE, vProbeY - vSign * PROBE, widget.id);
  const vNeighbor = widgetAt(widgets, hProbeX - hSign * PROBE, vProbeY + vSign * PROBE, widget.id);
  const hasDiag = !!widgetAt(widgets, hProbeX + hSign * PROBE, vProbeY + vSign * PROBE, widget.id);
  // Neighbors on both perpendicular sides: 4 widgets meet here in total (this one +
  // the 3 probed cells). If the diagonal cell is ALSO occupied, all 4 quadrants are
  // full -- a flush junction, sharp/no gap. If it's empty, this is the reflex point
  // around a missing quadrant -- round it to smoothly flow around the gap.
  if (hNeighbor && vNeighbor) return hasDiag ? "none" : "concave";
  // A single perpendicular neighbor whose OWN rectangle reaches past my far
  // (perpendicular) edge -- e.g. a taller widget beside a shorter one, both
  // flush at the near end -- leaves no real corner to round: rounding it would
  // carve a notch out of an otherwise straight, flush seam against that
  // neighbor's overhang. This is decidable, unlike the genuine Fill-vs-Convex
  // T-junction ambiguity below (see file header), so it isn't left to
  // cornerOverrides. Checked against the SAME widget the H/V probe found, not
  // "is anything in the diagonal cell" -- a widget that merely touches the
  // diagonal quadrant without bordering this corner (docking.test.ts's L-shape
  // case) must stay Convex.
  if (hNeighbor && !vNeighbor && contains(hNeighbor, hProbeX + hSign * PROBE, vProbeY + vSign * PROBE)) return "none";
  if (vNeighbor && !hNeighbor && contains(vNeighbor, hProbeX + hSign * PROBE, vProbeY + vSign * PROBE)) return "none";
  return "convex";
}

/**
 * Classifies each widget's 4 corners from plain rectangle adjacency. Widget
 * position/size pass through unchanged -- solving gap sizes so Fill seams meet
 * exactly is a layout-authoring decision (see "two-sided Fill seams" in
 * Corner.doc.json), not something this classifier does on its own.
 *
 * `compositionTopLeft` (default true) gates the "composition top-left" rule
 * below -- Corner.doc.json is explicit that this is SCOPED to a widget at the
 * true app screen's top-left, not just whichever widget happens to sit at a
 * passed-in array's own min (x,y): "Do NOT apply this just because a widget
 * sits at the local top-left corner of an isolated test frame -- 'Test: Bento
 * Docking (Species Row S1)' initially had it applied incorrectly for exactly
 * that reason: the real species row sits lower on the actual screen (below
 * other content), so its own top-left corner is a normal rounded corner
 * (Convex/60), not sharp." solveDocking has no way to know where its caller's
 * array sits on the real screen, so callers representing a real sub-composition
 * (the weather cluster, the species row) must pass `false` explicitly; the
 * generic/isolated docking test layouts (which per that same doc note DO
 * represent a screen's own top-left region) keep the default.
 */
export function solveDocking(widgets: GridWidget[], compositionTopLeft = true): DockingResult[] {
  const minX = Math.min(...widgets.map((w) => w.x));
  const minY = Math.min(...widgets.map((w) => w.y));

  return widgets.map((widget) => {
    const { x, y, width, height } = widget;

    let topLeft = solveCorner(widgets, widget, x, y, -1, -1);
    const topRight = solveCorner(widgets, widget, x + width, y, 1, -1);
    const bottomRight = solveCorner(widgets, widget, x + width, y + height, 1, 1);
    const bottomLeft = solveCorner(widgets, widget, x, y + height, -1, 1);

    // Composition top-left rule: the widget whose own TL corner sits at the whole
    // group's minimum (x,y) gets a sharp corner there instead of rounded.
    if (compositionTopLeft && topLeft === "convex" && x === minX && y === minY) topLeft = "none";

    const corners: Corners = [
      widget.cornerOverrides?.topLeft ?? topLeft,
      widget.cornerOverrides?.topRight ?? topRight,
      widget.cornerOverrides?.bottomRight ?? bottomRight,
      widget.cornerOverrides?.bottomLeft ?? bottomLeft,
    ];

    return { id: widget.id, corners, width, height };
  });
}
