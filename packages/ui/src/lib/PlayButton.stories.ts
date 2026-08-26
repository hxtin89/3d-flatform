// See BentoWidget.stories.ts -- Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import PlayButton from "./PlayButton.svelte";

const meta: Meta = {
  title: "PlayButton",
  component: PlayButton as any,
  argTypes: {
    accent: {
      control: "select",
      options: ["default", "blue", "green", "coral", "purple", "grey-light", "grey-dark", "gold", "forest-green"],
    },
  },
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

// Figma's real "Play Button" component -- 103x103, sitting on gold, which is
// this component's own default accent (see PlayButton.svelte's Props doc).
export const Default: Story = {
  args: {
    size: 103,
    accent: "gold",
    label: "Play",
  },
};

// Half the disc, same glyph geometry -- proves the SVG-viewBox approach
// re-scales the triangle's optical-centering offset for free instead of
// needing its own x=19 recompute per size.
export const Small: Story = {
  args: { ...Default.args, size: 56 },
};

export const GreyDarkAccent: Story = {
  args: { ...Default.args, accent: "grey-dark" },
};

export const BlueAccent: Story = {
  args: { ...Default.args, accent: "blue" },
};
