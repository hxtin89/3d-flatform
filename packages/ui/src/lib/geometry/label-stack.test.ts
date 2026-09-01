import { describe, expect, it } from "vitest";
import { stackCorners, wrapToWidth } from "./label-stack";

// Stand-in for the DOM ruler: 10px a character plus 48 of padding, so expected
// break points are arithmetic rather than font-dependent.
const measure = (line: string) => line.length * 10 + 48;

describe("wrapToWidth", () => {
  it("fills each line as far as it fits", () => {
    // "aaa bbb" = 7 chars = 118; adding " ccc" would be 158 > 150.
    expect(wrapToWidth("aaa bbb ccc ddd", measure, 150)).toEqual(["aaa bbb", "ccc ddd"]);
  });

  it("keeps authored newlines as hard breaks", () => {
    expect(wrapToWidth("aaa\nbbb", measure, 9999)).toEqual(["aaa", "bbb"]);
  });

  it("collapses runs of whitespace", () => {
    expect(wrapToWidth("aaa   bbb", measure, 9999)).toEqual(["aaa bbb"]);
  });

  // Pills hug their text, so an over-long word renders wide rather than clipped.
  // Breaking mid-word is a typographic call this must not make on its own.
  it("leaves a word longer than the cap on its own line rather than splitting it", () => {
    expect(wrapToWidth("aa supercalifragilistic bb", measure, 100)).toEqual(["aa", "supercalifragilistic", "bb"]);
  });

  it("returns nothing for empty copy", () => {
    expect(wrapToWidth("   ", measure, 100)).toEqual([]);
  });
});

describe("stackCorners", () => {
  const at = (rows: ReturnType<typeof stackCorners>, i: number) => rows[i];

  it("gives a lone line convex free corners and left-anchored caps", () => {
    expect(at(stackCorners([200], "left"), 0)).toEqual(["fill-top", "convex", "convex", "fill-top"]);
  });

  // The narrower line's free edge sweeps out to land on the wider one, so the step
  // between them reads as one S-curve instead of a stair.
  it("hands the fillet to whichever line is narrower", () => {
    const rows = stackCorners([200, 400], "left");
    expect(at(rows, 0)[2]).toBe("fill-left"); // narrow line, bottom-right
    expect(at(rows, 1)[1]).toBe("convex"); // wide line, top-right
  });

  it("mirrors the fillet when the lower line is the narrow one", () => {
    const rows = stackCorners([400, 200], "left");
    expect(at(rows, 0)[2]).toBe("convex");
    expect(at(rows, 1)[1]).toBe("fill-left");
  });

  // A fillet cannot draw in less than its own radius of width difference; below
  // that it collapses into a sliver that reads as a nick in the edge. Wrapped copy
  // produces near-equal lines constantly.
  it("treats lines closer than the radius as flush", () => {
    const rows = stackCorners([400, 401], "left", 30);
    expect(at(rows, 0)[2]).toBe("none");
    expect(at(rows, 1)[1]).toBe("none");
  });

  it("still fillets once the difference clears the radius", () => {
    const rows = stackCorners([400, 431], "left", 30);
    expect(at(rows, 0)[2]).toBe("fill-left");
  });

  // Not symmetric, and deliberately so -- the desktop frame authors no caps.
  it("only caps the anchor side when left-aligned", () => {
    const left = stackCorners([200, 300], "left");
    const right = stackCorners([200, 300], "right");
    expect(left[0][0]).toBe("fill-top"); // top-left cap
    expect(right[0][1]).toBe("none"); // top-right cap, deliberately absent
    // Right-anchored order is [freeTop, capTop, capBottom, freeBottom], so the free
    // corners move to the LEFT of the tuple. Line 0 has no neighbour above it, so
    // its freeTop is a plain exterior corner; the fillet shows up on its freeBottom.
    expect(right[0][0]).toBe("convex");
    expect(right[0][3]).toBe("fill-left");
  });
});
