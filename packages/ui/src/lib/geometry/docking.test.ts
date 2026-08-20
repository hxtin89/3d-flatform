import { describe, expect, it } from "vitest";
import { solveDocking } from "./docking";

describe("solveDocking", () => {
  it("rounds all corners convex for a single isolated widget, sharp at the composition top-left", () => {
    const [result] = solveDocking([{ id: "a", x: 0, y: 0, width: 100, height: 100 }]);
    // topLeft sits at the composition's own (minX, minY) -> composition top-left rule.
    expect(result.corners).toEqual(["none", "convex", "convex", "convex"]);
  });

  it("rounds every corner convex on a flush 2x2 grid (no reflex point, no missing quadrant)", () => {
    const widgets = [
      { id: "tl", x: 0, y: 0, width: 100, height: 100 },
      { id: "tr", x: 100, y: 0, width: 100, height: 100 },
      { id: "bl", x: 0, y: 100, width: 100, height: 100 },
      { id: "br", x: 100, y: 100, width: 100, height: 100 },
    ];
    const results = solveDocking(widgets);
    // The shared center point (100,100) has a neighbor in every direction including
    // diagonal for each widget, so none of them see a missing quadrant there.
    expect(results.find((r) => r.id === "tl")!.corners[2]).toBe("convex"); // bottomRight
    expect(results.find((r) => r.id === "br")!.corners[0]).toBe("convex"); // topLeft (not composition TL)
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
    // The other two widgets don't have a neighbor on both perpendicular sides there.
    expect(results.find((r) => r.id === "top")!.corners[3]).toBe("convex"); // bottomLeft
    expect(results.find((r) => r.id === "left")!.corners[1]).toBe("convex"); // topRight
  });

  it("lets an explicit override win over the solved default", () => {
    const [result] = solveDocking([
      { id: "a", x: 0, y: 50, width: 100, height: 100, cornerOverrides: { topLeft: "fill-top" } },
    ]);
    expect(result.corners[0]).toBe("fill-top");
  });
});
