// See BentoWidget.stories.ts — Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import LabelLine from "./LabelLine.svelte";

const meta: Meta = {
  title: "LabelLine",
  component: LabelLine as any,
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

export const DeinHabitat: Story = {
  args: { text: "Dein Habitat", fontSize: 34 },
};

export const Peruanischer: Story = {
  args: { text: "PERUANISCHER", fontSize: 60 },
};

export const Auwald: Story = {
  args: {
    text: "AUWALD",
    fontSize: 60,
    corners: ["none", "convex", "convex", "convex"],
  },
};
