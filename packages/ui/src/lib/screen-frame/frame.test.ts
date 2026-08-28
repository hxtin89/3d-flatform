import { describe, expect, it } from "vitest";
import { windowPath, type Rect } from "./frame";

// Every arc command in a path, as [radius, sweepFlag].
function arcs(d: string): Array<[number, number]> {
  return [...d.matchAll(/A([\d.]+),[\d.]+ 0 0 ([01]) /g)].map((m) => [Number(m[1]), Number(m[2])]);
}

const WIN: Rect = { x: 60, y: 60, width: 960, height: 1800 };
const NO_NOTCH = { width: 0, height: 0 };

describe("windowPath", () => {
  it("is a plain rounded rect when neither notch reaches in", () => {
    const a = arcs(windowPath(WIN, NO_NOTCH, NO_NOTCH, 60));
    expect(a).toHaveLength(4);
    expect(a.every(([r, sweep]) => r === 60 && sweep === 1)).toBe(true);
  });

  // The whole point of the rewrite. A notch elbow is a reflex vertex, so its
  // fillet has to sweep the OTHER way -- that concave bulge is what lets the
  // photo fill the space a docked widget's own convex corner gives up. Round it
  // like a normal corner and a wedge of frame grey shows through the join.
  it("sweeps each notch elbow opposite to the convex corners", () => {
    const a = arcs(windowPath(WIN, { width: 123, height: 58 }, { width: 360, height: 360 }, 60));
    expect(a).toHaveLength(8);
    expect(a.filter(([, sweep]) => sweep === 0)).toHaveLength(2);
  });

  // Figma clamps a vertex to half its shortest adjoining edge, so neighbouring
  // fillets meet at worst exactly and never overrun. On the 58-tall logo notch
  // that pins both its vertices to 29, which is why Figma's logo elbow reads as
  // one continuous S-curve with no straight segment between the two arcs.
  it("clamps a vertex radius to half its shortest adjoining edge", () => {
    const a = arcs(windowPath(WIN, { width: 123, height: 58 }, { width: 360, height: 360 }, 60));
    const radii = a.map(([r]) => r).sort((x, y) => x - y);
    expect(radii.slice(0, 2)).toEqual([29, 29]);
    expect(radii.slice(2)).toEqual([60, 60, 60, 60, 60, 60]);
  });

  // A notch whose reach collapses degenerates through the same code path rather
  // than needing a branch at the call site -- the repeated/collinear vertices
  // just drop out.
  it("drops a notch whose reach collapses to zero", () => {
    expect(arcs(windowPath(WIN, NO_NOTCH, { width: 360, height: 0 }, 60))).toHaveLength(4);
  });

  it("never emits a radius larger than asked for", () => {
    const a = arcs(windowPath({ x: 0, y: 0, width: 90, height: 90 }, NO_NOTCH, NO_NOTCH, 60));
    expect(a.every(([r]) => r <= 45)).toBe(true);
  });
});
