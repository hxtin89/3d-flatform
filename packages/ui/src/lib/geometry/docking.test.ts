import { describe, expect, it } from "vitest";
import { solveDocking } from "./docking";

describe("solveDocking", () => {
  it("rounds all corners convex for a single isolated widget, sharp at the composition top-left", () => {
    const [result] = solveDocking([{ id: "a", x: 0, y: 0, width: 100, height: 100 }]);
    // topLeft sits at the composition's own (minX, minY) -> composition top-left rule.
    expect(result.corners).toEqual(["none", "convex", "convex", "convex"]);
  });

  it("leaves the shared center of a flush 2x2 grid sharp -- no gap, all 4 quadrants full", () => {
    const widgets = [
      { id: "tl", x: 0, y: 0, width: 100, height: 100 },
      { id: "tr", x: 100, y: 0, width: 100, height: 100 },
      { id: "bl", x: 0, y: 100, width: 100, height: 100 },
      { id: "br", x: 100, y: 100, width: 100, height: 100 },
    ];
    const results = solveDocking(widgets);
    // The shared center point (100,100) has a neighbor in every direction including
    // diagonal for each widget -- rounding any of them there would open a visible
    // gap at a point where all 4 widgets should meet flush.
    expect(results.find((r) => r.id === "tl")!.corners[2]).toBe("none"); // bottomRight
    expect(results.find((r) => r.id === "br")!.corners[0]).toBe("none"); // topLeft (not composition TL)
  });

  it("finds the concave reflex point where 3 widgets meet around one missing quadrant", () => {
    // L-shape: three 100x100 widgets around a missing quadrant at (100,100)-(200,200).
    const widgets = [
      { id: "top", x: 100, y: 0, width: 100, height: 100 },
      { id: "left", x: 0, y: 100, width: 100, height: 100 },
      { id: "corner", x: 0, y: 0, width: 100, height: 100 },
    ];
    const results = solveDocking(widgets);
    // "corner"'s own bottomRight corner sits at (100,100), the reflex point --
    // "top" is above it and "left" is beside it, but the diagonal quadrant is empty.
    expect(results.find((r) => r.id === "corner")!.corners[2]).toBe("concave"); // bottomRight
    // The other two widgets share that same point, but only ONE of the three may
    // draw a treatment there -- "corner" owns the reflex fillet above. These two are
    // each flush against it, so their own edges are collinear and they must stay
    // sharp. They asserted "convex" until the flush-seam fix in solveCorner, and
    // rendering the story showed exactly what that cost: both rounded their facing
    // corner and opened white notches either side of the reflex point.
    expect(results.find((r) => r.id === "top")!.corners[3]).toBe("none"); // bottomLeft
    expect(results.find((r) => r.id === "left")!.corners[1]).toBe("none"); // topRight
  });

  it("flushes a corner against a taller neighbor that overhangs past this widget's own edge (Vogel/Giftfrosch)", () => {
    // Mirrors SPECIES_ROW's real effective geometry with Giftfrosch selected:
    // Vogel and Giftfrosch share a top edge on Vogel's side, but Giftfrosch is
    // taller and its own rectangle rises further up than Vogel's top -- a
    // single-neighbor T-junction, but not an ambiguous one, since the neighbor
    // itself proves there's no gap to round into.
    const widgets = [
      { id: "vogel", x: 0, y: 270, width: 300, height: 300 },
      { id: "giftfrosch", x: 300, y: 0, width: 360, height: 570 },
    ];
    const results = solveDocking(widgets, false);
    expect(results.find((r) => r.id === "vogel")!.corners[1]).toBe("none"); // topRight
  });

  it("flushes a corner against a neighbor level with this widget's own edge", () => {
    // Same shape as above but Giftfrosch's top is LEVEL with Vogel's top rather than
    // rising past it. This asserted "convex" on the theory that a plain T-junction is
    // an undecidable designer's call -- but the two top edges are collinear here, so
    // the union has no vertex at this point at all and there is nothing to round. It
    // is as decidable as the overhang case above, just level instead of past.
    //
    // Rounding it is visible and wrong: a flush 2x2 grid rendered a white notch at
    // every outer seam midpoint while staying correctly sharp at the shared centre,
    // which is the keyhole recreation-content.ts had been hand-pinning around.
    const widgets = [
      { id: "vogel", x: 0, y: 0, width: 300, height: 300 },
      { id: "giftfrosch", x: 300, y: 0, width: 360, height: 300 },
    ];
    const results = solveDocking(widgets, false);
    expect(results.find((r) => r.id === "vogel")!.corners[1]).toBe("none"); // topRight
  });

  it("still rounds a corner whose neighbor does not reach its line at all", () => {
    // The guard rail for the fix above: a neighbor that stops short of this corner's
    // own line leaves a real exterior corner, which must still round. Without this,
    // "reaches my line" could quietly widen into "exists anywhere nearby".
    const widgets = [
      { id: "a", x: 0, y: 0, width: 300, height: 300 },
      { id: "b", x: 300, y: 60, width: 300, height: 240 },
    ];
    const results = solveDocking(widgets, false);
    expect(results.find((r) => r.id === "a")!.corners[1]).toBe("convex"); // topRight
  });

  it("lets an explicit override win over the solved default", () => {
    const [result] = solveDocking([
      { id: "a", x: 0, y: 50, width: 100, height: 100, cornerOverrides: { topLeft: "fill-top" } },
    ]);
    expect(result.corners[0]).toBe("fill-top");
  });
});
