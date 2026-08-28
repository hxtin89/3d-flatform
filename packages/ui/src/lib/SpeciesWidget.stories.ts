// See BentoWidget.stories.ts -- Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import SpeciesWidget from "./SpeciesWidget.svelte";

const meta: Meta = {
  title: "SpeciesWidget",
  component: SpeciesWidget as any,
  argTypes: {
    accent: { control: "select", options: ["default", "grey-light", "grey-dark"] },
  },
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

const width = 300;
const height = 300;
const corners = ["convex", "convex", "convex", "convex"] as const;

// Real "S1: Vogel (Widget)" content from Frame 1 Desktop -- unselected: icon
// slot only (left empty here, no icon system wired into @wi/ui content yet).
export const Unselected: Story = {
  args: {
    width,
    height,
    corners: [...corners],
    title: "SCHNURRVOGEL",
    description: "pipra fasciicauda",
    accent: "grey-light",
  },
};

// Real "S1: Giftfrosch (Widget)" content -- selected: measurement/status/
// caption facts (read off the real Figma text nodes) plus an image slot
// (left empty, no photo asset pipeline wired in yet) instead of the icon slot.
export const Selected: Story = {
  args: {
    width,
    height: height + 270,
    corners: [...corners],
    title: "SIRA GIFTFROSCH",
    description: "ranitomeya sirensis",
    selected: true,
    measurement: "15-17mm",
    status: "Schutzstatus: am Wenigsten bedroht",
    caption: "Nur die männlichen Frösche kümmern sich um den Nachwuchs",
    accent: "grey-dark",
  },
};
