// See BentoWidget.stories.ts -- Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import Scrubber from "./Scrubber.svelte";

const meta: Meta = {
  title: "Scrubber",
  component: Scrubber as any,
  argTypes: {
    accent: {
      control: "select",
      options: ["default", "blue", "green", "coral", "purple", "grey-light", "grey-dark", "gold", "forest-green"],
    },
  },
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

// No fixed width on the component itself -- it fills whatever container it's
// dropped into (see its own Props doc), which Storybook's canvas already is,
// so no wrapper div is needed to see the fill behaviour.

// Figma's own reference split -- 152/516 of a real measured track, kept as
// that exact fraction (see Scrubber.svelte's Props doc) rather than rounded.
export const Default: Story = {
  args: { progress: 152 / 516, accent: "default" },
};

export const Start: Story = {
  args: { progress: 0, accent: "default" },
};

export const Halfway: Story = {
  args: { progress: 0.5, accent: "default" },
};

export const NearlyDone: Story = {
  args: { progress: 0.92, accent: "default" },
};

// Out-of-range input, clamped by the component's own `clamped` derived --
// this checks that clamp rather than trusting every caller to pre-clamp.
export const OverAndUnderRange: Story = {
  args: { progress: 1.4, accent: "default" },
};

export const GoldAccent: Story = {
  args: { progress: 0.5, accent: "gold" },
};
