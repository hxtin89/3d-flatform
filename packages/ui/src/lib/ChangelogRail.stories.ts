// See BentoWidget.stories.ts -- Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import ChangelogRail from "./ChangelogRail.svelte";

const meta: Meta = {
  title: "ChangelogRail",
  component: ChangelogRail as any,
  argTypes: {
    side: { control: "select", options: ["left", "right"] },
    accent: {
      control: "select",
      options: ["default", "blue", "green", "coral", "purple", "grey-light", "grey-dark", "gold", "forest-green"],
    },
  },
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

// Fixed 60px-wide, height:100% -- this repo has no @storybook/addon-svelte-csf
// for a real story-template wrapper (same limitation Screen.stories.ts notes
// for ScreenExample), so there's no sized container to decorate with here;
// `layout: "fullscreen"` on the meta gets it as close as CSF3 alone can.

// Docked right (the component's own default): flush right edge stays
// square, the inward-facing left corners round -- see ChangelogRail.svelte's
// `side` doc for why the two edges aren't symmetric.
export const Right: Story = {
  args: { height: "420px", text: "CHANGELOG", side: "right", accent: "gold" },
};

// Docked left: mirror image -- flush left edge square, right corners round.
export const Left: Story = {
  args: { height: "420px", text: "CHANGELOG", side: "left", accent: "gold" },
};

export const BlueAccent: Story = {
  args: { height: "420px", text: "CHANGELOG", side: "right", accent: "blue" },
};

export const Clickable: Story = {
  args: { height: "420px", text: "CHANGELOG", side: "right", accent: "gold", onClick: () => alert("Rail clicked") },
};
