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

// --- liquid field blend sweep -------------------------------------------
//
// The `blend` knob on the liquid field (see BentoGrid's prop doc and
// geometry/liquid-field.ts). All four render the SAME rects; only how the
// field fuses them differs. Every one of them is fully continuous under the
// expand/collapse animation -- corner snapping came from docking.ts's
// discrete classifier, which the field replaces entirely, so even blend 0 is
// snap-free.
//
// Figma is not internally consistent here, which is why this is a knob and
// not a constant: its species row keeps inner corners SHARP (= blend 0),
// while its weather cluster fillets them (= blend 60, its Fill-Left/Fill-Top
// atoms being exactly that fillet). Click a card in any of these to watch the
// expand morph.
export const LiquidBlendNone: Story = {
  args: { radius: 60, items: SPECIES_ROW, topLeftIsScreenCorner: false, blend: 0 },
};

export const LiquidBlendSubtle: Story = {
  args: { radius: 60, items: SPECIES_ROW, topLeftIsScreenCorner: false, blend: 24 },
};

export const LiquidBlendFull: Story = {
  args: { radius: 60, items: SPECIES_ROW, topLeftIsScreenCorner: false, blend: 60 },
};

// Deliberately separated rects, to show the metaball behaviour the blend
// enables: at blend 0 these are three islands; at blend 60 they neck
// together before touching.
export const LiquidBlendGapped: Story = {
  args: {
    radius: 60,
    topLeftIsScreenCorner: false,
    blend: 60,
    items: SPECIES_ROW.map((item, i) => ({ ...item, x: item.x + i * 40 })),
  },
};
