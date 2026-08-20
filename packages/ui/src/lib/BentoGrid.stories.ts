// See BentoWidget.stories.ts -- Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import BentoGrid from "./BentoGrid.svelte";

const meta: Meta = {
  title: "BentoGrid",
  component: BentoGrid as any,
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

const SIZE = 160;

// "Test: Bento Docking" from Corner.doc.json -- a single-size 3-widget L-shape.
// The corner widget's own bottom-right corner is the reflex point where the
// missing quadrant sits; solveDocking() finds it with zero manual hints.
export const LShapeReflexPoint: Story = {
  args: {
    radius: 40,
    items: [
      { id: "canopy", x: 0, y: 0, width: SIZE, height: SIZE, title: "PERUANISCHER AUWALD", description: "Kronendach", accent: "forest-green" },
      { id: "temp", x: SIZE, y: 0, width: SIZE, height: SIZE, title: "Temperatur", value: "29°", accent: "coral" },
      { id: "species", x: 0, y: SIZE, width: SIZE, height: SIZE, title: "MANAKIN", description: "pipra fasciicauda", accent: "gold" },
    ],
  },
};

// "Test: Bento Docking (2x2 Grid, No Gap)" -- flush grid, every reflex point
// has a neighbor in all 3 surrounding cells, so nothing is concave.
export const FlushTwoByTwoGrid: Story = {
  args: {
    radius: 40,
    items: [
      { id: "tl", x: 0, y: 0, width: SIZE, height: SIZE, title: "Widget A", accent: "blue" },
      { id: "tr", x: SIZE, y: 0, width: SIZE, height: SIZE, title: "Widget B", accent: "green" },
      { id: "bl", x: 0, y: SIZE, width: SIZE, height: SIZE, title: "Widget C", accent: "purple" },
      { id: "br", x: SIZE, y: SIZE, width: SIZE, height: SIZE, title: "Widget D", accent: "gold" },
    ],
  },
};
