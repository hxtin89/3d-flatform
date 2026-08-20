// STUB — owned by the app, not this package. Real implementation solves grid
// placement (which widgets touch, where the reflex/variable-width points are)
// into per-corner types + solved sizes, per the rules documented on the Figma
// Bento Widget / Corner component set (two-sided Fill seams, variable-width
// top bar, composition top-left rule, etc.). Not stubbed further here since a
// fake docking solver would be actively misleading — leave this to throw
// until the real port lands, rather than pretend a placeholder result is safe
// to render into a real layout.

import type { Corners } from "./silhouette";

export interface GridWidget {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DockingResult {
  id: string;
  corners: Corners;
  width: number;
  height: number;
}

export function solveDocking(_widgets: GridWidget[]): DockingResult[] {
  throw new Error(
    "solveDocking is a stub — port the real algorithm from design-system/docs/components/Corner.doc.json before using this in a live layout."
  );
}
