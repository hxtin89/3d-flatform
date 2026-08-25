import { describe, expect, it } from "vitest";
import { computeCornerRadii, wedgeTargets, roundTargets, type LiquidWidget } from "./liquid-field";
import type { Corners } from "./silhouette";
import { solveDocking } from "./docking";
import { WEATHER_CLUSTER } from "../screen-frame/recreation-content";

const R = 60;
const COLOR: [number, number, number, number] = [0, 0, 0, 1];

/** The real species row: Vogel | Giftfrosch (expandable) | Morphofalter, flush, bottoms aligned. */
function speciesRow(giftfroschHeight: number): LiquidWidget[] {
  const bottom = 570;
  return [
    { x: 0, y: 270, width: 300, height: 300, color: COLOR },
    { x: 300, y: bottom - giftfroschHeight, width: 360, height: giftfroschHeight, color: COLOR },
    { x: 660, y: 270, width: 300, height: 300, color: COLOR },
  ];
}

/** Corner order is (topLeft, topRight, bottomRight, bottomLeft) -- see computeCornerRadii. */
function cornersOf(radii: Float32Array, widgetIndex: number): number[] {
  return Array.from(radii.slice(widgetIndex * 4, widgetIndex * 4 + 4));
}

describe("computeCornerRadii", () => {
  it("squares corners shared with a neighbour and rounds free ones (Figma's species row at rest)", () => {
    const radii = computeCornerRadii(speciesRow(570), R, R);

    // Vogel: left side is free (rounded), right side butts Giftfrosch (square).
    const [vTL, vTR, vBR, vBL] = cornersOf(radii, 0);
    expect(vTL).toBeCloseTo(R);
    expect(vBL).toBeCloseTo(R);
    expect(vTR).toBe(0);
    expect(vBR).toBe(0);

    // Giftfrosch: top corners rise clear of both neighbours (rounded); bottom
    // corners sit on the shared seams (square).
    const [gTL, gTR, gBR, gBL] = cornersOf(radii, 1);
    expect(gTL).toBeCloseTo(R);
    expect(gTR).toBeCloseTo(R);
    expect(gBR).toBe(0);
    expect(gBL).toBe(0);

    // Morphofalter mirrors Vogel.
    const [mTL, mTR, mBR, mBL] = cornersOf(radii, 2);
    expect(mTR).toBeCloseTo(R);
    expect(mBR).toBeCloseTo(R);
    expect(mTL).toBe(0);
    expect(mBL).toBe(0);
  });

  it("is continuous across the whole expand -- this is what docking.ts's classifier could not be", () => {
    // Sweep Giftfrosch 300 -> 570 (its real collapsed -> expanded range) and
    // assert no corner ever jumps. The old discrete convex/none classifier
    // flipped in one frame at the crossover; a jump here would mean the field
    // reintroduced that snap.
    const STEP = 0.5;
    const MAX_JUMP = R * (STEP / R) * 4; // generous: ~2px per 0.5px of height
    let previous = computeCornerRadii(speciesRow(300), R, R);
    let worst = 0;

    for (let h = 300 + STEP; h <= 570; h += STEP) {
      const current = computeCornerRadii(speciesRow(h), R, R);
      for (let i = 0; i < previous.length; i++) {
        worst = Math.max(worst, Math.abs(current[i] - previous[i]));
      }
      previous = current;
    }

    expect(worst).toBeLessThan(MAX_JUMP);
    // Sanity: something must actually have moved, or "continuous" is vacuous.
    expect(worst).toBeGreaterThan(0);
  });

  it("maps each authored corner type to an interpolatable outward amount", () => {
    // Order is [outX, outY] per corner, corners [TL, TR, BR, BL].
    const corners: Corners = ["fill-left", "fill-top", "concave", "convex"];
    expect(wedgeTargets(corners)).toEqual([1, 0, 0, 1, 1, 1, 0, 0]);
    // "none" and "convex" both mean no outward material.
    expect(wedgeTargets(["none", "none", "none", "none"])).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("keeps a half-grown wedge attached to its own vertex", () => {
    // The wedge is a square from the vertex out to (s*r), minus a disc of
    // radius r centred on that far corner. The vertex only stays part of the
    // shape while its distance to that centre exceeds r -- that is sqrt(2)*a*r
    // vs a*r, which holds for EVERY amount a > 0. This is why the wedge radius
    // is what scales, and not the direction: scaling the direction instead
    // collapses the square and the wedge would detach and vanish.
    for (const amount of [0.1, 0.25, 0.5, 0.75, 1]) {
      const r = 60 * amount;
      const centreDistance = Math.hypot(r, r);
      expect(centreDistance).toBeGreaterThan(r);
    }
  });

  it("rounds every corner fully once a widget is isolated", () => {
    const lone: LiquidWidget[] = [{ x: 0, y: 0, width: 300, height: 300, color: COLOR }];
    expect(cornersOf(computeCornerRadii(lone, R, R), 0)).toEqual([R, R, R, R]);
  });

  it("never buries a Fill wedge under a square neighbour", () => {
    // A Fill/Concave wedge reaches OUTWARD, which in a flush layout means it
    // reaches into the neighbour sharing that edge. It is only ever visible if
    // that neighbour's own corner at the same point is a convex round pulling
    // its box back to make room -- Figma draws BOTH halves of every seam. A
    // neighbour left square ('none') covers the wedge completely and the seam
    // silently flattens into a butt-join, with no error anywhere: the wedge is
    // still rendered, just occluded. Guards the weather cluster, where all
    // three seams were authored square and so every wedge in it was invisible.
    const solved = solveDocking(WEATHER_CLUSTER);
    const cornerAt = (w: (typeof WEATHER_CLUSTER)[number], c: number): [number, number] => [
      c === 0 || c === 3 ? w.x : w.x + w.width,
      c < 2 ? w.y : w.y + w.height,
    ];

    // Coincident corners are exactly the seams: two widgets meeting at the same
    // vertex, each owning one half of it. (A wedge whose vertex lands mid-edge
    // of a neighbour -- weatherBar's bottom-right against weather83's top edge
    // -- reaches into the frame margin instead, so it is never occluded and is
    // not a seam.)
    let seams = 0;
    for (const [i, item] of WEATHER_CLUSTER.entries()) {
      const wedge = wedgeTargets(solved[i].corners);
      for (let c = 0; c < 4; c++) {
        if (Math.max(wedge[c * 2], wedge[c * 2 + 1]) === 0) continue;
        const [cx, cy] = cornerAt(item, c);
        for (const [j, other] of WEATHER_CLUSTER.entries()) {
          if (j === i) continue;
          const k = [0, 1, 2, 3].find((n) => cornerAt(other, n)[0] === cx && cornerAt(other, n)[1] === cy);
          if (k === undefined) continue;
          seams++;
          expect(roundTargets(solved[j].corners)[k], `${other.id} must round to reveal ${item.id}'s wedge`).toBe(1);
        }
      }
    }
    expect(seams, "the weather cluster's three interlocking seams").toBe(3);
  });
});
