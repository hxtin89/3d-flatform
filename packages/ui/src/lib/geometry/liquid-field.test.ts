import { describe, expect, it } from "vitest";
import { computeCornerRadii, type LiquidWidget } from "./liquid-field";

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

  it("rounds every corner fully once a widget is isolated", () => {
    const lone: LiquidWidget[] = [{ x: 0, y: 0, width: 300, height: 300, color: COLOR }];
    expect(cornersOf(computeCornerRadii(lone, R, R), 0)).toEqual([R, R, R, R]);
  });
});
