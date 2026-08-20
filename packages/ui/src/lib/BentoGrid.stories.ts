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

// Exact recreation of the "Bento Grid — Recreation" Figma page, Frame 1 (S1) --
// real position/size (px, matching Figma 1:1), real per-corner Type read directly
// off each instance's Corner children (not re-solved -- Figma's hand-tuned values
// win over the auto-solver here, per "wire it exactly"), and real Color/Widget
// Accent mode per widget. Two clusters, each with its own local origin.
//
// Not reproduced: the bird/frog/butterfly line-art icons (no icon system wired
// into @wi/ui content yet) and the frog widget's extra measurement/status block
// (its own bespoke sub-layout, outside BentoWidget's title/value/description
// shape) -- both are separate scope from wiring the grid/corner/color pipeline.
export const WeatherCluster: Story = {
  args: {
    radius: 60,
    items: [
      // Figma: "S1: WeatherBar (Widget)" @ (660,71) 255x180
      { id: "weatherBar", x: 0, y: 0, width: 255, height: 180, title: "Leicht bewölkt", description: "Nordwest Wind", accent: "grey-light", cornerOverrides: { topLeft: "fill-left", topRight: "convex", bottomRight: "convex", bottomLeft: "none" } },
      // Figma: "S1: Weather29 (Widget)" @ (660,251) 180x180
      { id: "weather29", x: 0, y: 180, width: 180, height: 180, value: "29°", description: "Celsius", accent: "gold", cornerOverrides: { topLeft: "fill-top", topRight: "none", bottomRight: "convex", bottomLeft: "convex" } },
      // Figma: "S1: Weather83 (Widget)" @ (840,251) 180x180
      { id: "weather83", x: 180, y: 180, width: 180, height: 180, value: "83%", description: "Luftfeuchtigkeit", accent: "forest-green", cornerOverrides: { topLeft: "fill-left", topRight: "convex", bottomRight: "none", bottomLeft: "none" } },
    ],
  },
};

export const SpeciesRow: Story = {
  args: {
    radius: 60,
    items: [
      // Figma: "S1: Vogel (Widget)" @ (60,1560) 300x300 -- normalized against the row's own origin (60,1290)
      { id: "vogel", x: 0, y: 270, width: 300, height: 300, title: "SCHNURRVOGEL", description: "pipra fasciicauda", accent: "grey-light", cornerOverrides: { topLeft: "fill-top", topRight: "none", bottomRight: "convex", bottomLeft: "convex" } },
      // Figma: "S1: Giftfrosch (Widget)" @ (360,1290) 360x570
      { id: "giftfrosch", x: 300, y: 0, width: 360, height: 570, title: "SIRA GIFTFROSCH", description: "ranitomeya sirensis", accent: "grey-dark", cornerOverrides: { topLeft: "convex", topRight: "convex", bottomRight: "fill-left", bottomLeft: "none" } },
      // Figma: "S1: Morphofalter (Widget)" @ (720,1560) 300x300
      { id: "morphofalter", x: 660, y: 270, width: 300, height: 300, title: "BLAUER MORPHOFALTER", description: "morpho deidamia", accent: "grey-light", cornerOverrides: { topLeft: "none", topRight: "convex", bottomRight: "none", bottomLeft: "none" } },
    ],
  },
};
