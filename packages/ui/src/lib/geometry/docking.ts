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

function widgetAt(widgets: GridWidget[], x: number, y: number, excludeId: string): boolean {
  return widgets.some(
    (w) => w.id !== excludeId && x > w.x - EPS && x < w.x + w.width + EPS && y > w.y - EPS && y < w.y + w.height + EPS,
  );
}

function solveCorner(
  widgets: GridWidget[],
  widget: GridWidget,
  hProbeX: number,
  vProbeY: number,
  hSign: 1 | -1,
  vSign: 1 | -1,
): CornerType {
  const hasH = widgetAt(widgets, hProbeX + hSign * PROBE, vProbeY - vSign * PROBE, widget.id);
  const hasV = widgetAt(widgets, hProbeX - hSign * PROBE, vProbeY + vSign * PROBE, widget.id);
  const hasDiag = widgetAt(widgets, hProbeX + hSign * PROBE, vProbeY + vSign * PROBE, widget.id);
  if (hasH && hasV && !hasDiag) return "concave";
  return "convex";
}

/**
 * Classifies each widget's 4 corners from plain rectangle adjacency. Widget
 * position/size pass through unchanged -- solving gap sizes so Fill seams meet
 * exactly is a layout-authoring decision (see "two-sided Fill seams" in
 * Corner.doc.json), not something this classifier does on its own.
 */
export function solveDocking(widgets: GridWidget[]): DockingResult[] {
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
    if (topLeft === "convex" && x === minX && y === minY) topLeft = "none";

    const corners: Corners = [
      widget.cornerOverrides?.topLeft ?? topLeft,
      widget.cornerOverrides?.topRight ?? topRight,
      widget.cornerOverrides?.bottomRight ?? bottomRight,
      widget.cornerOverrides?.bottomLeft ?? bottomLeft,
    ];

    return { id: widget.id, corners, width, height };
  });
}
