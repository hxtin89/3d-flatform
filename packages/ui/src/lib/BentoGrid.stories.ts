// See BentoWidget.stories.ts -- Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import BentoGrid from "./BentoGrid.svelte";
import { WEATHER_CLUSTER, SPECIES_ROW } from "./screen-frame/recreation-content";

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

// Exact recreation of the "Bento Grid — Recreation" Figma page, Frame 1 (S1) --
// real position/size (px, matching Figma 1:1), real per-corner Type read directly
// off each instance's Corner children (not re-solved -- Figma's hand-tuned values
// win over the auto-solver here, per "wire it exactly"), and real Color/Widget
// Accent mode per widget. Two clusters, each with its own local origin.
//
// Species icons are line-art illustration, not the real Figma vectors (see
// species-icons.ts). Not reproduced: the frog widget's extra measurement/
// status block (its own bespoke sub-layout, outside BentoWidget's title/
// value/description shape) -- separate scope from wiring the grid/corner/
// color pipeline.
// topLeftIsScreenCorner: false on both -- neither cluster sits at the real
// screen's actual top-left (see BentoGrid's own doc comment / Figma's Corner
// component description), so the auto sharp-corner rule must stay off here.
export const WeatherCluster: Story = {
  args: { radius: 60, items: WEATHER_CLUSTER, topLeftIsScreenCorner: false },
};

export const SpeciesRow: Story = {
  args: { radius: 60, items: SPECIES_ROW, topLeftIsScreenCorner: false },
};
